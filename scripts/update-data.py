#!/usr/bin/env python3
"""
update-data.py — Hämtar Systembolagets sortiment och bygger två JSON-filer
för apkguiden.se.

Datakällan är Systembolagets eget officiella e-commerce-API som driver
deras webbplats. API-nyckeln är publikt känd (samma som syns i alla
nätverksanrop på systembolaget.se). Detta ger oss exakt samma sortiment
som visas online – inklusive ölbestseljare som Pripps Blå och Norrlands Guld.

Skriptet:
  1. Paginerar igenom hela sortimentet via productsearch-endpointen.
  2. Beräknar APK = (volym_ml × alkoholhalt%) / pris_kr.
  3. Filtrerar bort utgångna, lågalkoholhaltiga och saknade produkter.
  4. Markerar nyinkomna produkter (jämfört med förra körningen).
  5. Skriver två filer:
       - data.json (~500 KB): topp N per huvudkategori, för snabb topplista.
       - search-data.json (~5–7 MB, ~1.5–2 MB gzippad): hela sortimentet,
         lazy-loadas av sajten när användaren börjar söka.

Hela paginerings-cykeln tar ca 3–5 minuter. Det är fine i en nattlig
GitHub Action men vill man köra lokalt: ha tålamod.
"""

import hashlib
import html
import json
import re
import sys
import time
import unicodedata
import urllib.request
import urllib.error
import urllib.parse
from datetime import date, datetime, timezone
from pathlib import Path

# Systembolagets officiella e-commerce-API. Samma endpoint som
# systembolaget.se använder själva. Nyckeln är publik (syns i alla
# nätverksanrop i deras webbläsare-frontend).
API_BASE = "https://api-extern.systembolaget.se/sb-api-ecommerce/v1/productsearch/search"
API_KEY = "cfc702aed3094c86b92d6d4ff7a54c84"
PAGE_SIZE = 30  # API:ets maxstorlek per sida
MAX_PAGES = 400  # Säkerhetsventil per sökning

# API:et lämnar aldrig ut mer än 333 sidor × 30 = 9 990 träffar per sökning,
# oavsett hur många som finns. Före nov 2026 hämtade skriptet hela sortimentet
# (~27 800) i en enda sökning och fick därför bara de första 9 990 – i en
# ordning som skiftar mellan körningarna. Följden blev att 1 000–1 600 drycker
# försvann och dök upp igen varje vecka (deras sidor gav 404 under tiden).
# Nu söker vi bara i de sortiment som ska visas (ett par tusen drycker), med
# fast sorteringsordning, och kontrollerar att vi fått med allt.
MAX_RESULTS_PER_QUERY = 9990

# Vilka av Systembolagets sortiment sajten visar. "Fast sortiment" = det
# ordinarie sortimentet som finns i butikerna (~3 200 artiklar, nov 2026).
# Vill man ha med fler: lägg till t.ex. "Tillfälligt sortiment" i listan.
ASSORTMENTS = ["Fast sortiment"]

# Sorteringsordningar att prova i tur och ordning tills alla träffar hämtats.
# Ger en ordning dubbletter/luckor (lika namn osv.) fyller nästa i resten.
# Test 17 nov 2026 (fasta sortimentet, 3 159 st): ett varv sorterat på namn gav
# 3 136 unika, på pris 2 795, utan sortering 2 999 – därför flera varv.
SORT_PASSES = [("Name", "Ascending"), ("Price", "Ascending"), ("Name", "Descending"), ("Volume", "Ascending")]

# Minsta andel av API:ets docCount vi måste få med, annars avbryts körningen
# hellre än att skriva över bra data med en halv lista.
MIN_COVERAGE = 0.95
MIN_PRODUCTS = 1000

# En dryck som saknas i en körning (tillfälligt slut i lager, API-hicka) får
# ligga kvar med senast kända uppgifter så här länge innan sidan tas bort.
GRACE_DAYS = 21

# Prishistorik per dryck, en rad per prisändring. Läses av api/dryck.js
# (dryckessidornas prishistorik) och api/prisandringar.js (/prisandringar).
PRICE_HISTORY_PATH = Path(__file__).resolve().parent.parent / "price-history.json"
# Hur länge historiken för en dryck som inte längre finns sparas.
HISTORY_KEEP_DAYS = 365

# Var data.json hamnar (relativt repo-rot)
OUTPUT_PATH = Path(__file__).resolve().parent.parent / "data.json"

# Var search-data.json hamnar (hela sortimentet, lazy-loadas av sajten)
SEARCH_OUTPUT_PATH = Path(__file__).resolve().parent.parent / "search-data.json"

# index.html/sitemap.xml – uppdateras med statisk SEO-text/ItemList-JSON-LD
# respektive dagens datum, se update_index_html() och touch_sitemap_lastmod().
INDEX_HTML_PATH = Path(__file__).resolve().parent.parent / "index.html"
SITEMAP_PATH = Path(__file__).resolve().parent.parent / "sitemap.xml"

# Sitemap med en rad per indexerbar dryck (/dryck/<id>-<namn>). Sidorna själva
# byggs av Vercel-funktionen api/dryck.js – här listar vi bara adresserna till
# de sidor Google får indexera (se mark_indexable()).
PRODUCT_SITEMAP_PATH = Path(__file__).resolve().parent.parent / "sitemap-drycker.xml"
SITE_URL = "https://apkguiden.se"

# Vilka dryckessidor Google får indexera. Google nedgraderade hela sajten
# 30 okt 2026, troligen för att ~7 300 nästan likadana dryckessidor såg
# massproducerade ut. Därför indexeras bara topp N i varje underkategori plus
# sidor som redan fått klick från Google (keep-indexed.json). Övriga sidor finns
# kvar för besökare men får noindex (api/dryck.js) och står inte i sitemapen.
INDEX_TOP_PER_SUBCATEGORY = 20
KEEP_INDEXED_PATH = Path(__file__).resolve().parent.parent / "keep-indexed.json"

# Produktbeskrivningar för dryckessidorna (/dryck/...). Bara strukturerad
# fakta (stil, ursprung, druvor, smakklockor, smaknoter, serveringstemperatur,
# passar till) – ingen av Systembolagets löptexter kopieras rakt av.
# Sidan skriver ihop en egen beskrivning av det här. Läses bara av
# api/dryck.js, aldrig av webbläsaren.
DETAILS_OUTPUT_PATH = Path(__file__).resolve().parent.parent / "product-details.json"

# Hur många av topplistans produkter som skrivs in som statisk text/JSON-LD
# i index.html, för sökmotorer som inte (fullt ut, eller i tid) kör JS.
SEO_STATIC_TOP_N = 20

# Antal produkter att behålla per huvudkategori
TOP_PER_CATEGORY = 500

# Minsta alkoholhalt – filtrerar bort 0%-produkter
MIN_ALCOHOL_PERCENT = 1.0

# Minsta volym (ml) – filtrera bort konstigheter
MIN_VOLUME_ML = 50

# Kategorier vi vill behålla (matchar categoryLevel1 i Systembolagets data).
# OBS: "Mousserande" finns INTE som egen huvudkategori – det ligger som
# underkategori "Mousserande vin" under Vin. "Cider & Blanddrycker" verkar
# inte heller dyka upp i denna datadump (är troligen klassad annorlunda).
KEEP_CATEGORIES = {"Vin", "Öl", "Sprit", "Cider & Blanddrycker"}

# Mappning för att normalisera kategorinamnet till det vi använder i UI
CATEGORY_MAP = {
    "Cider & Blanddrycker": "Cider",
}


def extract_details(product: dict) -> dict:
    """Plocka ut fakta för produktbeskrivningen. Korta nycklar håller
    filen liten (~1–2 MB för hela sortimentet)."""
    d: dict = {}
    style = (product.get("categoryLevel3") or "").strip()
    if style:
        d["s"] = style
    country = product.get("country")
    if isinstance(country, dict):
        country = country.get("name") or country.get("value") or ""
    region = (product.get("originLevel1") or "").strip()
    if region and region != country:
        d["o"] = region
    grapes = [g for g in (product.get("grapes") or []) if isinstance(g, str) and g.strip()]
    if grapes:
        d["g"] = grapes[:4]
    if product.get("vintage"):
        d["v"] = str(product["vintage"])
    if product.get("isOrganic"):
        d["e"] = 1
    # Smakklockor (0–12). Bara de som Systembolaget faktiskt angett – en
    # nolla i fältet betyder oftast "inte angiven", inte "noll".
    key_map = {"TasteClockBody": "b", "TasteClockSweetness": "s", "TasteClockFruitacid": "f",
               "TasteClockBitter": "t", "TasteClockRoughness": "r", "TasteClockSmokiness": "k"}
    clocks = {}
    for c in product.get("tasteClocks") or []:
        k = key_map.get((c or {}).get("key"))
        if k and isinstance(c.get("value"), (int, float)):
            clocks[k] = c["value"]
    if clocks:
        d["c"] = clocks
    # Smaknoter: bara listan efter "inslag av" – enskilda ord, inte texten.
    taste = product.get("taste") or ""
    m = re.search(r"inslag av ([^.]+)", taste, flags=re.I)
    if m:
        notes = [n.strip() for n in re.split(r",| och ", m.group(1)) if n.strip()]
        if notes:
            d["n"] = notes[:6]
    usage = product.get("usage") or ""
    m = re.search(r"(\d+)\s*[-–]\s*(\d+)\s*°", usage)
    if m:
        d["t"] = f"{m.group(1)}–{m.group(2)}"
    elif "rumstemp" in usage.lower():
        d["t"] = "rum"
    symbols = [x for x in (product.get("tasteSymbols") or []) if isinstance(x, str)]
    if symbols:
        d["p"] = symbols[:6]
    return d


def compute_apk(product: dict) -> float:
    """Beräkna alkohol per krona = ml ren alkohol / kr."""
    volume = product.get("volume") or 0
    alcohol = product.get("alcoholPercentage") or 0
    price = product.get("price") or 0
    if not (volume and alcohol and price):
        return 0.0
    return (volume * (alcohol / 100.0)) / price


def transform(product: dict) -> dict:
    """Mappa Systembolagets fältnamn till våra korta fältnamn."""
    bold = (product.get("productNameBold") or "").strip()
    thin = (product.get("productNameThin") or "").strip()
    name = f"{bold} {thin}".strip() if thin else bold

    # Bygg bild-URL. Systembolagets API ger bara product-numret;
    # bilden lever på en CDN som följer ett standardiserat URL-mönster.
    # Format: https://product-cdn.systembolaget.se/productimages/{nr}/{nr}_{size}.png
    # Vi sparar basen utan storlekssuffix; klienten lägger på _200/_400/_800
    # själv beroende på rendering.
    pn = product.get("productNumber")
    image_url = None
    if pn:
        # Vissa produkter har productNumber=1145112 (med extra siffror).
        # CDN-mappstrukturen använder hela produktnumret som mapp och som
        # filnamn-bas. Vi får 404 för produkter utan bild – det är OK,
        # frontend faller tillbaka till en flask-ikon vid laddningsfel.
        image_url = f"https://product-cdn.systembolaget.se/productimages/{pn}/{pn}"

    # Men om API:et råkar leverera images-fältet (gammal format-fallback)
    # så använd det istället, det är mer pålitligt.
    images = product.get("images") or []
    if images and isinstance(images, list) and images[0].get("imageUrl"):
        image_url = images[0]["imageUrl"]

    cat = product.get("categoryLevel1") or ""
    cat = CATEGORY_MAP.get(cat, cat)

    # Country kan komma som dict eller string beroende på endpoint
    country = product.get("country")
    if isinstance(country, dict):
        country = country.get("name") or country.get("value") or ""

    return {
        "id": str(pn) if pn else None,
        "name": name,
        "producer": product.get("producerName"),
        "category": cat,
        "subcategory": product.get("categoryLevel2"),
        "packaging": product.get("packagingLevel1") or product.get("bottleText"),
        "volume": product.get("volume"),
        "alcohol": product.get("alcoholPercentage"),
        "price": product.get("price"),
        "country": country,
        "image": image_url,
        "apk": round(compute_apk(product), 4),
    }


def is_eligible(product: dict) -> bool:
    """Behåll bara produkter som är aktiva, har alkohol och realistisk volym."""
    # Utgångna eller helt slut – skippa
    if product.get("isDiscontinued"):
        return False
    if product.get("isCompletelyOutOfStock"):
        return False
    if (product.get("alcoholPercentage") or 0) < MIN_ALCOHOL_PERCENT:
        return False
    if (product.get("volume") or 0) < MIN_VOLUME_ML:
        return False
    if (product.get("price") or 0) <= 0:
        return False
    cat = product.get("categoryLevel1") or ""
    if cat not in KEEP_CATEGORIES:
        return False
    # Extra skydd om API:et någon gång skulle strunta i sortimentsfiltret.
    if product.get("assortmentText") not in ASSORTMENTS:
        return False
    return True


def dedupe_lookalikes(products: list[dict]) -> tuple[list[dict], int]:
    """Ta bort produkter som ser identiska ut för besökaren men har olika
    artikelnummer hos Systembolaget (t.ex. Arboga 10,2, Sofiero Original Guld,
    Three Hearts, Pripps Blå Extra – samma öl, två artikelnummer).

    Regel: samma namn + samma producent + samma volym = dubblett. Vi behåller
    den med högst APK, och vid lika APK den med lägst pris (sista utväg:
    lägst id, så resultatet alltid blir detsamma oavsett input-ordning).
    Olika volymer räknas som olika produkter (t.ex. 750 ml flaska vs 3 L box).

    Returnerar (ny lista, antal borttagna).
    """
    def norm(s) -> str:
        return re.sub(r"\s+", " ", (s or "").strip().lower())

    def better(a: dict, b: dict) -> bool:
        """True om a ska behållas framför b."""
        if a["apk"] != b["apk"]:
            return a["apk"] > b["apk"]
        pa = a["price"] if a["price"] is not None else float("inf")
        pb = b["price"] if b["price"] is not None else float("inf")
        if pa != pb:
            return pa < pb
        return str(a.get("id") or "") < str(b.get("id") or "")

    best: dict[tuple, dict] = {}
    for p in products:
        key = (norm(p.get("name")), norm(p.get("producer")), p.get("volume"))
        cur = best.get(key)
        if cur is None or better(p, cur):
            best[key] = p

    keep_ids = {id(p) for p in best.values()}
    result = [p for p in products if id(p) in keep_ids]
    return result, len(products) - len(result)


def load_previous() -> tuple[dict, bool]:
    """Läs förra körningens search-data.json.

    Returnerar (produkter per id, samma_urval). samma_urval är True om förra
    filen byggdes med samma ASSORTMENTS som nu – bara då är jämförelser mot
    förra veckan meningsfulla (nyinkommet-märkning och att låta tillfälligt
    saknade drycker ligga kvar). Första körningen efter att urvalet ändrats
    blir därför en ny baslinje.
    """
    if not SEARCH_OUTPUT_PATH.exists():
        print("Ingen tidigare search-data.json hittad – etablerar baslinje.", flush=True)
        return {}, False
    try:
        with SEARCH_OUTPUT_PATH.open(encoding="utf-8") as f:
            prev = json.load(f)
    except Exception as e:
        # Hellre inga nya-badges än att krascha hela uppdateringen.
        print(f"VARNING: kunde inte läsa tidigare search-data.json ({e}); "
              "inget jämförs med förra körningen.", flush=True)
        return {}, False
    by_id = {str(p["id"]): p for p in prev.get("products", []) if p.get("id")}
    same = prev.get("assortments") == ASSORTMENTS
    print(f"Läste {len(by_id):,} produkter från förra körningen"
          f"{'' if same else ' (annat urval än nu – ny baslinje)'}.", flush=True)
    return by_id, same


def fetch_page(page: int, params: dict | None = None) -> dict:
    """Hämta en sida med produkter från Systembolagets API."""
    query = {"page": page, "size": PAGE_SIZE, **(params or {})}
    url = f"{API_BASE}?{urllib.parse.urlencode(query)}"
    req = urllib.request.Request(
        url,
        headers={
            "Ocp-Apim-Subscription-Key": API_KEY,
            "User-Agent": "Mozilla/5.0",
            "Accept": "application/json",
            # Detta header ber API:et returnera *alla* produkter, inte bara
            # de som råkar finnas i en specifik butik.
            "Origin": "https://www.systembolaget.se",
            "Referer": "https://www.systembolaget.se/",
        },
    )
    # Retry-logik: API:et kan slänga tillfälliga 503/429 vid för snabba anrop
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read())
        except (urllib.error.HTTPError, urllib.error.URLError) as e:
            if attempt == 2:
                raise
            print(f"  Sida {page} misslyckades ({e}), försöker igen om 2s…", flush=True)
            time.sleep(2)
    raise RuntimeError("Oväntat fall i fetch_page")


def fetch_pass(params: dict) -> tuple[list[dict], int]:
    """Bläddra igenom alla sidor för EN sökning. Returnerar (produkter, docCount)."""
    products_out: list[dict] = []
    doc_count = 0
    page = 1
    while page <= MAX_PAGES:
        result = fetch_page(page, params)
        products = result.get("products") or []
        metadata = result.get("metadata") or {}
        doc_count = metadata.get("docCount") or doc_count
        if not products:
            break
        products_out.extend(products)
        next_page = metadata.get("nextPage")
        if next_page is None or next_page <= page:
            break
        page += 1
        time.sleep(0.05)  # Snäll mot servern
    return products_out, doc_count


def fetch_complete(params: dict) -> tuple[dict, int]:
    """Hämta ALLA träffar för en sökning, med fast sortering.

    Bläddrar igenom sökningen med första sorteringsordningen i SORT_PASSES och
    räknar unika produktnummer. Saknas något (API:et kan ge samma produkt på
    två sidor när flera har samma sorteringsvärde, och då faller en annan
    bort) görs ett nytt varv med nästa ordning, tills allt är med.

    Har sökningen fler träffar än API:et lämnar ut (9 990) delas den upp per
    huvudkategori. Returnerar (produkter per produktnummer, docCount).
    """
    _, first_count = fetch_pass_meta(params)
    if first_count > MAX_RESULTS_PER_QUERY and "categoryLevel1" not in params:
        print(f"  {first_count:,} träffar är fler än API:et lämnar ut – delar upp per kategori.", flush=True)
        merged: dict = {}
        total = 0
        for cat in sorted(KEEP_CATEGORIES):
            part, count = fetch_complete({**params, "categoryLevel1": cat})
            merged.update(part)
            total += count
        return merged, total

    found: dict = {}
    doc_count = first_count
    for sort_by, direction in SORT_PASSES:
        products, doc_count = fetch_pass({**params, "sortBy": sort_by, "sortDirection": direction})
        before = len(found)
        for p in products:
            pn = p.get("productNumber")
            if pn and str(pn) not in found:
                found[str(pn)] = p
        print(f"  {params} sorterat på {sort_by} {direction}: {len(products):,} rader, "
              f"{len(found) - before:,} nya → {len(found):,}/{doc_count:,} unika", flush=True)
        if len(found) >= doc_count:
            break
    return found, doc_count


def fetch_pass_meta(params: dict) -> tuple[dict, int]:
    """Första sidan av en sökning – för att se hur många träffar den har."""
    result = fetch_page(1, params)
    return result, (result.get("metadata") or {}).get("docCount") or 0


def fetch_assortment() -> tuple[list[dict], int]:
    """Hämta alla produkter i ASSORTMENTS. Tar någon minut.

    Returnerar (produkter, summan av API:ets docCount) så att main() kan
    kontrollera att vi verkligen fått med allt."""
    print(f"Hämtar {', '.join(ASSORTMENTS)} från Systembolagets API…", flush=True)
    start_time = time.time()
    all_found: dict = {}
    expected = 0
    for assortment in ASSORTMENTS:
        found, count = fetch_complete({"assortmentText": assortment})
        all_found.update(found)
        expected += count
    elapsed = time.time() - start_time
    print(f"Klart: {len(all_found):,} unika produkter av {expected:,} enligt API:et ({elapsed:.0f}s)", flush=True)
    return list(all_found.values()), expected


def format_price(price) -> str:
    """Svensk talformatering: mellanslag som tusentalsavgränsare, inga
    decimaler för jämna kronor (priser från API:et har inga ören ändå)."""
    if price is None:
        return "?"
    try:
        value = float(price)
    except (TypeError, ValueError):
        return "?"
    if value.is_integer():
        return f"{int(value):,}".replace(",", " ")
    return f"{value:,.2f}".replace(",", " ")


def slugify(text) -> str:
    """Samma regel som slugify() i api/dryck.js och index.html."""
    s = unicodedata.normalize("NFKD", str(text or "").lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s[:60].rstrip("-")


def product_path(p: dict) -> str:
    slug = slugify(p.get("name"))
    return f"/dryck/{p['id']}" + (f"-{slug}" if slug else "")


def product_link_html(p: dict) -> str:
    name = html.escape(p.get("name") or "")
    if not p.get("id"):
        return name
    return f'<a href="{html.escape(product_path(p))}">{name}</a>'


def apk_sort_key(p: dict):
    """APK desc → pris asc → namn asc. Samma ordning som sort_key i main()."""
    return (-p["apk"], p.get("price") or float("inf"), p.get("name") or "")


def load_keep_indexed() -> set:
    """Produkt-id:n i keep-indexed.json (sidor som fått klick från Google)."""
    if not KEEP_INDEXED_PATH.exists():
        return set()
    try:
        data = json.loads(KEEP_INDEXED_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        print(f"VARNING: kunde inte läsa {KEEP_INDEXED_PATH.name}: {e}", file=sys.stderr)
        return set()
    return {str(i) for i in data.get("ids", [])}


def mark_indexable(products: list[dict]) -> int:
    """Sätt "index": True på drycker vars sida Google får indexera: topp
    INDEX_TOP_PER_SUBCATEGORY i sin underkategori (samma gruppering som
    rank-taggen på dryckessidan) eller listade i keep-indexed.json. Övriga
    lämnas utan fältet – api/dryck.js ger dem noindex och de utelämnas ur
    sitemap-drycker.xml. Returnerar antalet indexerbara."""
    keep = load_keep_indexed()
    groups: dict[str, list] = {}
    for p in products:
        p.pop("index", None)
        groups.setdefault(p.get("subcategory") or p.get("category"), []).append(p)
    count = 0
    for items in groups.values():
        for pos, p in enumerate(sorted(items, key=apk_sort_key), start=1):
            if pos <= INDEX_TOP_PER_SUBCATEGORY or str(p.get("id")) in keep:
                p["index"] = True
                count += 1
    return count


def write_product_sitemap(products: list[dict]) -> None:
    """Skriv sitemap-drycker.xml med de indexerbara dryckerna (se
    mark_indexable()). Ingen <lastmod> per rad – då ändras filen bara när
    urvalet faktiskt ändras, inte varje vecka."""
    urls = sorted({product_path(p) for p in products if p.get("id") and p.get("index")})
    lines = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for u in urls:
        lines.append(f"  <url><loc>{html.escape(SITE_URL + u)}</loc></url>")
    lines.append("</urlset>")
    PRODUCT_SITEMAP_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Skrev {len(urls):,} dryckesadresser till {PRODUCT_SITEMAP_PATH.name}.", flush=True)


def render_static_seo_html(top_overall: list[dict], category_leaders: list[tuple]) -> str:
    """Bygg den statiska, textbaserade SEO-fallbacken som sökmotorer och
    JS-lösa besökare ser (se SEO_STATIC_CONTENT_START/END i index.html).
    Körs vid varje körning så innehållet alltid matchar data.json – annars
    är hela poängen (att sökmotorn ser RIKTIG, aktuell data) borta.
    """
    parts = []
    parts.append("<h2>Bäst APK på Systembolaget just nu</h2>")
    parts.append(
        "<p>APK (alkohol per krona) visar hur mycket ren alkohol du får för "
        "pengarna. Listan nedan uppdateras varje vecka utifrån Systembolagets "
        "aktuella sortiment och priser.</p>"
    )

    if category_leaders:
        parts.append("<h3>Bäst i varje kategori</h3>")
        parts.append("<ul>")
        for cat, p in category_leaders:
            parts.append(
                f"<li>{html.escape(cat)}: {product_link_html(p)} – "
                f"{p['apk']:.2f} ml/kr, {format_price(p.get('price'))} kr</li>"
            )
        parts.append("</ul>")

    if top_overall:
        parts.append("<h3>Topplista – bästa APK totalt</h3>")
        parts.append("<ol>")
        for p in top_overall:
            producer = f" ({html.escape(p['producer'])})" if p.get("producer") else ""
            parts.append(
                f"<li>{product_link_html(p)}{producer} – "
                f"{html.escape(p.get('category') or '')}, {format_price(p.get('price'))} kr, "
                f"{p['apk']:.2f} ml ren alkohol per krona</li>"
            )
        parts.append("</ol>")

    return "\n".join(parts)


def render_itemlist_jsonld(top_overall: list[dict]) -> str:
    """Bygg ItemList-strukturerad data för topplistan (se
    SEO_ITEMLIST_JSONLD_START/END i index.html). Bara position + länk till
    dryckens egen sida – listraderna märks INTE upp som Product/Offer
    (Google räknar dem då som ofullständiga butiksprodukter). Product-
    uppmärkningen finns på varje dryckessida (api/dryck.js)."""
    items = []
    for idx, p in enumerate(top_overall, start=1):
        if p.get("id"):
            items.append({"@type": "ListItem", "position": idx, "url": SITE_URL + product_path(p)})

    data = {
        "@context": "https://schema.org",
        "@type": "ItemList",
        "name": "Bäst APK på Systembolaget",
        "itemListElement": items,
    }
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"))


def update_index_html(top_overall: list[dict], category_leaders: list[tuple]) -> None:
    """Skriv in färsk statisk SEO-text + ItemList-JSON-LD i index.html,
    mellan de fasta markörerna. Kraschar INTE skriptet om index.html eller
    markörerna saknas – då hoppas SEO-uppdateringen bara över (varning i
    loggen), datafilerna är redan skrivna vid det här laget."""
    if not INDEX_HTML_PATH.exists():
        print("VARNING: index.html hittades inte, hoppar över SEO-uppdatering.", file=sys.stderr)
        return

    doc = INDEX_HTML_PATH.read_text(encoding="utf-8")

    static_html = render_static_seo_html(top_overall, category_leaders)
    doc, n1 = re.subn(
        r"(<!-- SEO_STATIC_CONTENT_START -->).*?(<!-- SEO_STATIC_CONTENT_END -->)",
        lambda m: m.group(1) + static_html + m.group(2),
        doc,
        flags=re.S,
    )
    if n1 == 0:
        print("VARNING: hittade inte SEO_STATIC_CONTENT-markörerna i index.html.", file=sys.stderr)

    jsonld = render_itemlist_jsonld(top_overall)
    doc, n2 = re.subn(
        r'(<!-- SEO_ITEMLIST_JSONLD_START -->\s*<script type="application/ld\+json">)'
        r".*?"
        r'(</script>\s*<!-- SEO_ITEMLIST_JSONLD_END -->)',
        lambda m: m.group(1) + "\n  " + jsonld + "\n  " + m.group(2),
        doc,
        flags=re.S,
    )
    if n2 == 0:
        print("VARNING: hittade inte SEO_ITEMLIST_JSONLD-markörerna i index.html.", file=sys.stderr)

    if n1 or n2:
        INDEX_HTML_PATH.write_text(doc, encoding="utf-8")
        print(f"Uppdaterade statisk SEO-text/ItemList-JSON-LD i {INDEX_HTML_PATH.name}.", flush=True)


def touch_sitemap_lastmod() -> None:
    """Sätt dagens datum som <lastmod> för STARTSIDAN i sitemap.xml – den
    ändras faktiskt vid varje körning (nya priser/topplista/SEO-text), så
    det är en korrekt uppdatering, inte ett spel för att lura Google.
    Rör bara https://apkguiden.se/-blocket, övriga sidors (t.ex.
    samst-apk.html) lastmod lämnas orörda."""
    if not SITEMAP_PATH.exists():
        print("VARNING: sitemap.xml hittades inte, hoppar över lastmod-uppdatering.", file=sys.stderr)
        return

    xml = SITEMAP_PATH.read_text(encoding="utf-8")
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    def bump(m: re.Match) -> str:
        return re.sub(r"<lastmod>.*?</lastmod>", f"<lastmod>{today}</lastmod>", m.group(0))

    new_xml, n = re.subn(
        r"<url>\s*<loc>https://apkguiden\.se/</loc>.*?</url>",
        bump,
        xml,
        count=1,
        flags=re.S,
    )
    # /prisandringar visar "senast kollat" och nya prisändringar – ändras också varje körning.
    new_xml, n2 = re.subn(
        r"<url>\s*<loc>https://apkguiden\.se/prisandringar</loc>.*?</url>",
        bump,
        new_xml,
        count=1,
        flags=re.S,
    )
    if n or n2:
        SITEMAP_PATH.write_text(new_xml, encoding="utf-8")
        print(f"Uppdaterade sitemap.xml: <lastmod> för startsidan och /prisandringar satt till {today}.", flush=True)
    if not n:
        print("VARNING: hittade inte startsidans <url>-block i sitemap.xml.", file=sys.stderr)


def days_between(a: str, b: str) -> int:
    """Antal dagar från datum a till datum b (ÅÅÅÅ-MM-DD)."""
    return (date.fromisoformat(b) - date.fromisoformat(a)).days


def load_price_history() -> dict:
    """Läs price-history.json. Format:
        {"since": första kontrolldatum, "checks": [alla kontrolldatum],
         "assortments": [urvalet historiken gäller],
         "products": {id: {"p": [[datum, pris], ...], "s": senast sedd,
                           "k": signatur för namn + volym, se identity_key()}}}
    "p" har en rad för första gången vi såg drycken och sedan en rad per
    prisändring (datumet = den körning då nya priset upptäcktes). En tredje
    siffra 1 betyder att datumet är osäkert (drycken saknades veckorna före).
    Historiken maj–nov 2026 är återskapad ur repots git-historik."""
    if not PRICE_HISTORY_PATH.exists():
        return {"since": None, "checks": [], "products": {}}
    try:
        return json.loads(PRICE_HISTORY_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        print(f"VARNING: kunde inte läsa {PRICE_HISTORY_PATH.name} ({e}); börjar om.", file=sys.stderr)
        return {"since": None, "checks": [], "products": {}}


def identity_key(p: dict) -> str:
    """Kort signatur för namn + volym. Systembolaget återanvänder ibland ett
    artikelnummer för en helt annan dryck (t.ex. 9027801: först Chapelle de
    Potensac för 249 kr, sedan Fonseca Vintage för 949 kr). Ändras signaturen
    börjar historiken om, annars skulle det se ut som en prisändring."""
    name = re.sub(r"\s+", " ", str(p.get("name") or "").strip().lower())
    vol = p.get("volume") or 0
    vol = int(vol) if float(vol).is_integer() else vol
    return hashlib.md5(f"{name}|{vol}".encode("utf-8")).hexdigest()[:8]


def update_price_history(history: dict, observed: list[dict], keep_ids: set, today: str) -> dict:
    """Lägg till dagens priser för drycker vi faktiskt såg i API:et (inte de
    som bara ligger kvar under GRACE_DAYS) och rensa bort gammalt."""
    products = history.setdefault("products", {})
    for p in observed:
        pid, price = str(p.get("id") or ""), p.get("price")
        if not pid or not price:
            continue
        price = int(price) if float(price).is_integer() else round(float(price), 2)
        key = identity_key(p)
        entry = products.get(pid)
        if entry is None or (entry.get("k") and entry["k"] != key):
            products[pid] = {"p": [[today, price]], "s": today, "k": key}
            continue
        entry["k"] = key
        if entry["p"][-1][1] != price:
            if entry["p"][-1][0] == today:  # två körningar samma dag
                entry["p"][-1][1] = price
            elif days_between(entry.get("s") or today, today) > 8:
                # Drycken har saknats några veckor – vi vet inte när priset
                # ändrades. Flagga 1 = datum osäkert (räknas inte in i
                # prisomgångarna på /prisandringar, men visas på dryckessidan).
                entry["p"].append([today, price, 1])
            else:
                entry["p"].append([today, price])
        entry["s"] = today

    if history.get("assortments") != ASSORTMENTS:
        # Urvalet har ändrats (eller historiken byggdes innan urvalet sparades):
        # behåll bara drycker som finns på sajten nu.
        history["products"] = {k: v for k, v in products.items() if k in keep_ids}
        history["assortments"] = ASSORTMENTS
    else:
        history["products"] = {k: v for k, v in products.items()
                               if k in keep_ids or days_between(v.get("s") or today, today) <= HISTORY_KEEP_DAYS}

    checks = history.setdefault("checks", [])
    if not checks or checks[-1] != today:
        checks.append(today)
    history["since"] = history.get("since") or checks[0]
    history["products"] = dict(sorted(history["products"].items()))
    return history


def write_price_history(history: dict) -> None:
    PRICE_HISTORY_PATH.write_text(
        json.dumps(history, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    changed = sum(1 for v in history["products"].values() if len(v.get("p", [])) > 1)
    print(f"Skrev prishistorik för {len(history['products']):,} drycker "
          f"({changed:,} med minst en prisändring) till {PRICE_HISTORY_PATH.name} "
          f"({PRICE_HISTORY_PATH.stat().st_size / 1024:.0f} KB)", flush=True)


def main() -> int:
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    # Läs förra körningen INNAN vi skriver över filerna, så vi kan markera
    # nyinkomna produkter och låta tillfälligt saknade ligga kvar.
    prev_by_id, same_selection = load_previous()
    history = load_price_history()

    try:
        assortment, expected = fetch_assortment()
    except Exception as e:
        print(f"FEL: kunde inte hämta sortimentet: {e}", file=sys.stderr)
        return 1

    print(f"Råa produkter: {len(assortment):,}", flush=True)

    # Säkerhetscheck: om vi får tillbaka misstänkt få produkter har något
    # gått fel (t.ex. API är nere, format ändrat). Avsluta hellre med fel
    # än att överskriva en bra data.json med halv data.
    if len(assortment) < MIN_PRODUCTS or len(assortment) < expected * MIN_COVERAGE:
        print(
            f"FEL: Bara {len(assortment):,} produkter hämtade av {expected:,} enligt API:et "
            f"(minst {MIN_COVERAGE:.0%} och {MIN_PRODUCTS:,} krävs). "
            "Avbryter för att inte skriva över bra data.",
            file=sys.stderr,
        )
        return 1

    # Filtrera + transformera
    filtered = [p for p in assortment if is_eligible(p)]
    print(f"Efter filtrering: {len(filtered):,}", flush=True)

    transformed = [transform(p) for p in filtered]
    transformed = [p for p in transformed if p["apk"] > 0 and p["name"]]

    # ===== Ta bort dubbletter (samma produktnummer) =====
    # API:ets paginering kan i sällsynta fall returnera samma produkt på två
    # sidor. Vi behåller FÖRSTA förekomsten av varje id och loggar hur många
    # dubbletter som togs bort. Produkter utan id (saknar produktnummer)
    # lämnas orörda.
    seen_ids = set()
    deduped = []
    dup_count = 0
    for p in transformed:
        pid = p.get("id")
        if pid is None:
            deduped.append(p)
            continue
        if pid in seen_ids:
            dup_count += 1
            continue
        seen_ids.add(pid)
        deduped.append(p)
    transformed = deduped
    print(f"Dubbletter borttagna (samma produktnummer): {dup_count:,}", flush=True)

    # ===== Låt tillfälligt saknade drycker ligga kvar =====
    # En dryck som fanns förra veckan men saknas nu (t.ex. helt slut i lager)
    # ligger kvar med senast kända uppgifter i upp till GRACE_DAYS, så att dess
    # sida inte blinkar mellan 404 och 200. "seen" = senast vi såg den i API:et.
    observed_ids = {str(p["id"]) for p in transformed if p.get("id")}
    hist_products = history.get("products", {})
    carried = []
    if same_selection:
        for pid, old in prev_by_id.items():
            if pid in observed_ids:
                continue
            last_seen = (hist_products.get(pid) or {}).get("s") or old.get("seen")
            if last_seen and days_between(last_seen, today) <= GRACE_DAYS:
                keep = {k: v for k, v in old.items() if k not in ("rank", "categoryTotal", "new", "index")}
                keep["seen"] = last_seen
                carried.append(keep)
    transformed.extend(carried)
    print(f"Saknas denna vecka men ligger kvar (≤ {GRACE_DAYS} dagar): {len(carried):,}", flush=True)

    # ===== Ta bort "look-alike"-dubbletter (samma namn + producent + volym) =====
    # Olika artikelnummer men identiska för besökaren. Se dedupe_lookalikes().
    transformed, lookalike_count = dedupe_lookalikes(transformed)
    print(f"Dubbletter borttagna (samma namn+producent+volym): {lookalike_count:,}", flush=True)

    # ===== Markera nyinkomna produkter =====
    # En produkt vars id inte fanns i förra körningens search-data.json räknas
    # som nyinkommen. Vi sätter "new": True endast på de nya produkterna (övriga
    # lämnas utan fältet för att hålla filstorleken nere). Badgen försvinner
    # automatiskt vid nästa körning. Har urvalet ändrats sedan förra körningen
    # markeras inget (allt vore ju "nytt").
    new_count = 0
    if prev_by_id and same_selection:
        for p in transformed:
            if p["id"] and str(p["id"]) not in prev_by_id:
                p["new"] = True
                new_count += 1
    print(f"Nyinkomna sedan förra körningen: {new_count:,}", flush=True)

    # ===== Tiebreaker-sortering =====
    # APK desc → pris asc → namn asc. Samma APK? Då vinner billigare produkt.
    # Namn som tertiär nyckel ger 100% deterministisk ordning oavsett input.
    def sort_key(p):
        return (-p["apk"], p["price"] or float("inf"), p["name"] or "")

    # ===== Tilldela rank inom varje huvudkategori =====
    # rank = 1-baserad placering bland sin kategori, sorterat med tiebreakers.
    # categoryTotal = antalet produkter i kategorin – frontend kan räkna percentil.
    by_cat_for_rank: dict[str, list] = {}
    for p in transformed:
        by_cat_for_rank.setdefault(p["category"], []).append(p)
    for cat, items in by_cat_for_rank.items():
        items.sort(key=sort_key)
        for idx, p in enumerate(items, start=1):
            p["rank"] = idx
            p["categoryTotal"] = len(items)

    # ===== Indexering: vilka dryckessidor Google får indexera =====
    # Måste ske före search-data.json skrivs – api/dryck.js läser fältet därifrån.
    indexable = mark_indexable(transformed)
    print(f"Indexerbara dryckessidor: {indexable:,} av {len(transformed):,}", flush=True)

    # ===== 1) Skriv search-data.json: hela sortimentet, sorterat =====
    # Detta är den fullständiga "sökindex"-filen som sajten lazy-loadar
    # när användaren börjar söka. Innehåller ALLA eligible produkter.
    search_full = sorted(transformed, key=sort_key)
    search_output = {
        "updated": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "count": len(search_full),
        "source": "https://github.com/AlexGustafsson/systembolaget-api-data",
        "assortments": ASSORTMENTS,
        "products": search_full,
    }
    SEARCH_OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with SEARCH_OUTPUT_PATH.open("w", encoding="utf-8") as f:
        json.dump(search_output, f, ensure_ascii=False, separators=(",", ":"))
    search_size_mb = SEARCH_OUTPUT_PATH.stat().st_size / 1024 / 1024
    print(
        f"\nSkrev {len(search_full):,} produkter till {SEARCH_OUTPUT_PATH.name} "
        f"({search_size_mb:.1f} MB)",
        flush=True,
    )

    # ===== 2) Skriv data.json: topp N per huvudkategori =====
    # Detta är den lilla, snabba filen som laddas direkt vid sidvisning.
    by_cat: dict[str, list] = {}
    for p in transformed:
        by_cat.setdefault(p["category"], []).append(p)

    final = []
    for cat, items in by_cat.items():
        items.sort(key=sort_key)
        kept = items[:TOP_PER_CATEGORY]
        print(f"  {cat}: {len(items):,} → {len(kept)} (bäst APK: {kept[0]['apk']:.2f})", flush=True)
        final.extend(kept)

    # Slutlig sortering med samma tiebreakers
    final.sort(key=sort_key)

    output = {
        "updated": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "count": len(final),
        "source": "https://github.com/AlexGustafsson/systembolaget-api-data",
        "products": final,
    }

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT_PATH.open("w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, separators=(",", ":"))

    size_kb = OUTPUT_PATH.stat().st_size / 1024
    print(f"Skrev {len(final):,} produkter till {OUTPUT_PATH.name} ({size_kb:.0f} KB)", flush=True)

    # ===== 3) SEO: statisk text + ItemList-JSON-LD i index.html, + sitemap =====
    # by_cat[cat] är redan sorterad (se loopen ovan), så [0] = bäst APK i
    # kategorin. Samma ordning som mini-korten på själva sajten.
    category_leaders = [
        (cat, by_cat[cat][0]) for cat in ("Vin", "Öl", "Sprit") if by_cat.get(cat)
    ]
    update_index_html(final[:SEO_STATIC_TOP_N], category_leaders)
    touch_sitemap_lastmod()
    write_product_sitemap(search_full)

    # ===== 4) Fakta för dryckessidornas beskrivning =====
    keep_ids = {p["id"] for p in search_full if p.get("id")}
    details = {}
    for raw in filtered:
        pid = str(raw.get("productNumber") or "")
        if pid in keep_ids and pid not in details:
            d = extract_details(raw)
            if d:
                details[pid] = d
    # Drycker som bara ligger kvar (se GRACE_DAYS) finns inte i dagens svar från
    # API:et – behåll deras beskrivningsfakta från förra körningen.
    if DETAILS_OUTPUT_PATH.exists():
        try:
            prev_details = json.loads(DETAILS_OUTPUT_PATH.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            prev_details = {}
        for pid in keep_ids:
            if pid not in details and pid in prev_details:
                details[pid] = prev_details[pid]
    with DETAILS_OUTPUT_PATH.open("w", encoding="utf-8") as f:
        json.dump(details, f, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    print(f"Skrev beskrivningsfakta för {len(details):,} produkter till {DETAILS_OUTPUT_PATH.name} "
          f"({DETAILS_OUTPUT_PATH.stat().st_size / 1024:.0f} KB)", flush=True)

    # ===== 5) Prishistorik (dryckessidorna + /prisandringar) =====
    observed = [p for p in search_full if "seen" not in p]
    history = update_price_history(history, observed, keep_ids, today)
    write_price_history(history)

    return 0


if __name__ == "__main__":
    sys.exit(main())
