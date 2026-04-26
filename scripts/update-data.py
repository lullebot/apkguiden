#!/usr/bin/env python3
"""
update-data.py — Hämtar Systembolagets sortiment och bygger en bantad data.json
för apkguiden.se.

Datakällan är en publik daglig spegling av Systembolagets sortiment som
underhålls av AlexGustafsson på GitHub:
https://github.com/AlexGustafsson/systembolaget-api-data

Skriptet:
  1. Laddar ner assortment.json från GitHub.
  2. Beräknar APK = (volym_ml × alkoholhalt%) / pris_kr.
  3. Filtrerar bort utgångna, lågalkoholhaltiga och saknade produkter.
  4. Sorterar efter APK och behåller topp N per huvudkategori.
  5. Skriver en kompakt data.json (~500 KB) som hemsidan läser.
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

# Antal produkter att behålla per huvudkategori
TOP_PER_CATEGORY = 500

# Minsta alkoholhalt – filtrerar bort 0%-produkter
MIN_ALCOHOL_PERCENT = 1.0

# Minsta volym (ml) – filtrera bort konstigheter
MIN_VOLUME_ML = 50

# Kategorier vi vill behålla (matchar categoryLevel1 i Systembolagets data)
KEEP_CATEGORIES = {"Vin", "Öl", "Sprit", "Mousserande", "Cider & Blanddrycker"}

# Mappning för att normalisera kategorinamnet till det vi använder i UI
CATEGORY_MAP = {
    "Cider & Blanddrycker": "Cider & Blanddryck",
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

    # Behåll topp N per huvudkategori
    by_cat: dict[str, list] = {}
    for p in transformed:
        by_cat.setdefault(p["category"], []).append(p)

    final = []
    for cat, items in by_cat.items():
        items.sort(key=lambda x: x["apk"], reverse=True)
        kept = items[:TOP_PER_CATEGORY]
        print(f"  {cat}: {len(items):,} → {len(kept)} (bäst APK: {kept[0]['apk']:.2f})", flush=True)
        final.extend(kept)

    # Slutlig sortering
    final.sort(key=lambda x: x["apk"], reverse=True)

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
    print(f"\nSkrev {len(final):,} produkter till {OUTPUT_PATH} ({size_kb:.0f} KB)", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
