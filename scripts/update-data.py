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

import html
import json
import re
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

# Systembolagets officiella e-commerce-API. Samma endpoint som
# systembolaget.se använder själva. Nyckeln är publik (syns i alla
# nätverksanrop i deras webbläsare-frontend).
API_BASE = "https://api-extern.systembolaget.se/sb-api-ecommerce/v1/productsearch/search"
API_KEY = "cfc702aed3094c86b92d6d4ff7a54c84"
PAGE_SIZE = 30  # Vad API:et tycks vara optimerat för
MAX_PAGES = 1500  # Säkerhetsventil – sortimentet är ~25k produkter / 30 = ~830 sidor

# Var data.json hamnar (relativt repo-rot)
OUTPUT_PATH = Path(__file__).resolve().parent.parent / "data.json"

# Var search-data.json hamnar (hela sortimentet, lazy-loadas av sajten)
SEARCH_OUTPUT_PATH = Path(__file__).resolve().parent.parent / "search-data.json"

# index.html/sitemap.xml – uppdateras med statisk SEO-text/ItemList-JSON-LD
# respektive dagens datum, se update_index_html() och touch_sitemap_lastmod().
INDEX_HTML_PATH = Path(__file__).resolve().parent.parent / "index.html"
SITEMAP_PATH = Path(__file__).resolve().parent.parent / "sitemap.xml"

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


def load_previous_ids() -> set:
    """Läs förra körningens search-data.json och returnera mängden produkt-id.

    Används för att avgöra vilka produkter som är NYINKOMNA: en produkt vars id
    inte fanns i förra veckans fil räknas som ny. Första gången skriptet körs
    (ingen tidigare fil finns) returneras en tom mängd, vilket gör att inget
    markeras som nytt – då etableras bara en baslinje.
    """
    if not SEARCH_OUTPUT_PATH.exists():
        print("Ingen tidigare search-data.json hittad – etablerar baslinje "
              "(inget markeras som nyinkommet denna körning).", flush=True)
        return set()
    try:
        with SEARCH_OUTPUT_PATH.open(encoding="utf-8") as f:
            prev = json.load(f)
        prev_ids = {
            str(p["id"]) for p in prev.get("products", []) if p.get("id")
        }
        print(f"Läste {len(prev_ids):,} produkt-id från förra körningen.", flush=True)
        return prev_ids
    except Exception as e:
        # Hellre inga nya-badges än att krascha hela uppdateringen.
        print(f"VARNING: kunde inte läsa tidigare search-data.json ({e}); "
              "inget markeras som nyinkommet denna körning.", flush=True)
        return set()


def fetch_page(page: int) -> dict:
    """Hämta en sida med produkter från Systembolagets API."""
    url = f"{API_BASE}?page={page}&size={PAGE_SIZE}"
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


def fetch_assortment() -> list[dict]:
    """Paginera igenom hela sortimentet. Tar ca 3–5 minuter."""
    print(f"Hämtar sortiment från Systembolagets API…", flush=True)
    all_products: list[dict] = []
    page = 1
    start_time = time.time()

    while page <= MAX_PAGES:
        result = fetch_page(page)
        products = result.get("products") or []
        if not products:
            break
        all_products.extend(products)

        metadata = result.get("metadata") or {}
        total_pages = metadata.get("nextPage")
        doc_count = metadata.get("docCount")

        # Logga progress var 50:e sida för att inte spamma loggen
        if page == 1 or page % 50 == 0:
            elapsed = time.time() - start_time
            if doc_count:
                pct = len(all_products) / doc_count * 100
                print(f"  Sida {page}: {len(all_products):,}/{doc_count:,} produkter ({pct:.0f}%, {elapsed:.0f}s)", flush=True)
            else:
                print(f"  Sida {page}: {len(all_products):,} produkter ({elapsed:.0f}s)", flush=True)

        # Slut på sidor?
        if total_pages is None or total_pages <= page:
            break
        page += 1

        # Snäll mot servern – kort paus mellan sidor
        time.sleep(0.05)

    elapsed = time.time() - start_time
    print(f"Klart: {len(all_products):,} produkter på {page} sidor ({elapsed:.0f}s)", flush=True)
    return all_products


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
                f"<li>{html.escape(cat)}: {html.escape(p.get('name') or '')} – "
                f"{p['apk']:.2f} ml/kr, {format_price(p.get('price'))} kr</li>"
            )
        parts.append("</ul>")

    if top_overall:
        parts.append("<h3>Topplista – bästa APK totalt</h3>")
        parts.append("<ol>")
        for p in top_overall:
            producer = f" ({html.escape(p['producer'])})" if p.get("producer") else ""
            parts.append(
                f"<li>{html.escape(p.get('name') or '')}{producer} – "
                f"{html.escape(p.get('category') or '')}, {format_price(p.get('price'))} kr, "
                f"{p['apk']:.2f} ml ren alkohol per krona</li>"
            )
        parts.append("</ol>")

    return "\n".join(parts)


def render_itemlist_jsonld(top_overall: list[dict]) -> str:
    """Bygg ItemList/Product-strukturerad data för topplistan (se
    SEO_ITEMLIST_JSONLD_START/END i index.html)."""
    items = []
    for idx, p in enumerate(top_overall, start=1):
        product: dict = {"@type": "Product", "name": p.get("name") or ""}
        if p.get("producer"):
            product["brand"] = {"@type": "Brand", "name": p["producer"]}
        if p.get("price"):
            product["offers"] = {
                "@type": "Offer",
                "price": str(p["price"]),
                "priceCurrency": "SEK",
                "availability": "https://schema.org/InStock",
            }
        items.append({"@type": "ListItem", "position": idx, "item": product})

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
    if n:
        SITEMAP_PATH.write_text(new_xml, encoding="utf-8")
        print(f"Uppdaterade sitemap.xml: startsidans <lastmod> satt till {today}.", flush=True)
    else:
        print("VARNING: hittade inte startsidans <url>-block i sitemap.xml.", file=sys.stderr)


def main() -> int:
    # Läs förra körningens id INNAN vi skriver över filerna, så vi kan
    # markera nyinkomna produkter.
    prev_ids = load_previous_ids()

    try:
        assortment = fetch_assortment()
    except Exception as e:
        print(f"FEL: kunde inte hämta sortimentet: {e}", file=sys.stderr)
        return 1

    print(f"Råa produkter: {len(assortment):,}", flush=True)

    # Säkerhetscheck: om vi får tillbaka misstänkt få produkter har något
    # gått fel (t.ex. API är nere, format ändrat). Avsluta hellre med fel
    # än att överskriva en bra data.json med tom data.
    if len(assortment) < 5000:
        print(
            f"FEL: Bara {len(assortment)} produkter hämtade, väntade ≥5 000. "
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

    # ===== Ta bort "look-alike"-dubbletter (samma namn + producent + volym) =====
    # Olika artikelnummer men identiska för besökaren. Se dedupe_lookalikes().
    transformed, lookalike_count = dedupe_lookalikes(transformed)
    print(f"Dubbletter borttagna (samma namn+producent+volym): {lookalike_count:,}", flush=True)

    # ===== Markera nyinkomna produkter =====
    # En produkt vars id inte fanns i förra körningens search-data.json räknas
    # som nyinkommen. Vi sätter "new": True endast på de nya produkterna (övriga
    # lämnas utan fältet för att hålla filstorleken nere). Badgen försvinner
    # automatiskt vid nästa körning, eftersom id:t då finns i prev_ids.
    new_count = 0
    if prev_ids:
        for p in transformed:
            if p["id"] and str(p["id"]) not in prev_ids:
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

    # ===== 1) Skriv search-data.json: hela sortimentet, sorterat =====
    # Detta är den fullständiga "sökindex"-filen som sajten lazy-loadar
    # när användaren börjar söka. Innehåller ALLA eligible produkter.
    search_full = sorted(transformed, key=sort_key)
    search_output = {
        "updated": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "count": len(search_full),
        "source": "https://github.com/AlexGustafsson/systembolaget-api-data",
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

    return 0


if __name__ == "__main__":
    sys.exit(main())
