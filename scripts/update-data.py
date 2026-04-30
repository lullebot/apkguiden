#!/usr/bin/env python3
"""
update-data.py — Hämtar Systembolagets sortiment och bygger två JSON-filer
för apkguiden.se.

Datakällan är en publik daglig spegling av Systembolagets sortiment som
underhålls av AlexGustafsson på GitHub:
https://github.com/AlexGustafsson/systembolaget-api-data

Skriptet:
  1. Laddar ner assortment.json från GitHub.
  2. Beräknar APK = (volym_ml × alkoholhalt%) / pris_kr.
  3. Filtrerar bort utgångna, lågalkoholhaltiga och saknade produkter.
  4. Skriver två filer:
       - data.json (~500 KB): topp N per huvudkategori, för snabb topplista.
       - search-data.json (~5–7 MB, ~1.5–2 MB gzippad): hela sortimentet,
         lazy-loadas av sajten när användaren börjar söka.
"""

import json
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# Källfil – uppdateras dagligen av AlexGustafsson/systembolaget-api-data
SOURCE_URL = "https://raw.githubusercontent.com/AlexGustafsson/systembolaget-api-data/main/data/assortment.json"

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

    images = product.get("images") or []
    image_url = None
    if images and isinstance(images, list):
        image_url = images[0].get("imageUrl")

    cat = product.get("categoryLevel1") or ""
    cat = CATEGORY_MAP.get(cat, cat)

    return {
        "id": product.get("productNumber"),
        "name": name,
        "producer": product.get("producerName"),
        "category": cat,
        "subcategory": product.get("categoryLevel2"),
        "packaging": product.get("packagingLevel1"),
        "volume": product.get("volume"),
        "alcohol": product.get("alcoholPercentage"),
        "price": product.get("price"),
        "country": product.get("country"),
        "image": image_url,
        "apk": round(compute_apk(product), 4),
    }


def is_eligible(product: dict) -> bool:
    """Behåll bara produkter som är aktiva, har alkohol och realistisk volym."""
    if product.get("isDiscontinued"):
        return False
    if product.get("isCompletelyOutOfStock") and product.get("isTemporaryOutOfStock"):
        # Behåll temporärt slut – men skippa helt utgångna
        if not product.get("isTemporaryOutOfStock"):
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


def fetch_assortment() -> list[dict]:
    print(f"Hämtar sortiment från {SOURCE_URL}…", flush=True)
    req = urllib.request.Request(
        SOURCE_URL,
        headers={"User-Agent": "apkguiden-data-bot/1.0"},
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        raw = resp.read()
    print(f"Laddade ned {len(raw) / 1_000_000:.1f} MB", flush=True)
    data = json.loads(raw)
    if not isinstance(data, list):
        raise ValueError("Förväntade en JSON-array")
    return data


def main() -> int:
    try:
        assortment = fetch_assortment()
    except Exception as e:
        print(f"FEL: kunde inte hämta sortimentet: {e}", file=sys.stderr)
        return 1

    print(f"Råa produkter: {len(assortment):,}", flush=True)

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
