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
  4. Skriver två filer:
       - data.json (~500 KB): topp N per huvudkategori, för snabb topplista.
       - search-data.json (~5–7 MB, ~1.5–2 MB gzippad): hela sortimentet,
         lazy-loadas av sajten när användaren börjar söka.

Hela paginerings-cykeln tar ca 3–5 minuter. Det är fine i en nattlig
GitHub Action men vill man köra lokalt: ha tålamod.
"""

import json
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


def main() -> int:
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
    return 0


if __name__ == "__main__":
    sys.exit(main())
