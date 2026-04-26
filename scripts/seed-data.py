#!/usr/bin/env python3
"""Genererar en initial data.json med mockdata, så hemsidan funkar direkt
efter deploy (innan första GitHub Actions-körningen ersätter den)."""

import json
from datetime import datetime, timezone
from pathlib import Path

PRODUCTS = [
    # VIN
    {"id": "1001", "name": "Le Petit Saumur Rouge", "producer": "Domaines Saumur", "category": "Vin", "subcategory": "Rött", "packaging": "Bag-in-box", "volume": 3000, "alcohol": 12.5, "price": 269, "country": "Frankrike"},
    {"id": "1002", "name": "Coteaux du Languedoc", "producer": "Cellier des Dauphins", "category": "Vin", "subcategory": "Rött", "packaging": "Bag-in-box", "volume": 3000, "alcohol": 13, "price": 249, "country": "Frankrike"},
    {"id": "1003", "name": "Yellow Tail Cabernet", "producer": "Casella Family", "category": "Vin", "subcategory": "Rött", "packaging": "Bag-in-box", "volume": 3000, "alcohol": 13.5, "price": 299, "country": "Australien"},
    {"id": "1004", "name": "Riesling Trocken", "producer": "Mosel Cellars", "category": "Vin", "subcategory": "Vitt", "packaging": "Bag-in-box", "volume": 3000, "alcohol": 12, "price": 279, "country": "Tyskland"},
    {"id": "1005", "name": "Casillero del Diablo Reserva", "producer": "Concha y Toro", "category": "Vin", "subcategory": "Rött", "packaging": "Bag-in-box", "volume": 3000, "alcohol": 13.5, "price": 329, "country": "Chile"},
    {"id": "1006", "name": "Rosé d'Anjou", "producer": "Loire Vins", "category": "Vin", "subcategory": "Rosé", "packaging": "Bag-in-box", "volume": 3000, "alcohol": 11.5, "price": 269, "country": "Frankrike"},
    {"id": "1007", "name": "Apothic Red", "producer": "E. & J. Gallo", "category": "Vin", "subcategory": "Rött", "packaging": "Flaska", "volume": 750, "alcohol": 13.5, "price": 119, "country": "USA"},
    {"id": "1008", "name": "Domaine Bousquet Malbec", "producer": "Domaine Bousquet", "category": "Vin", "subcategory": "Rött", "packaging": "Flaska", "volume": 750, "alcohol": 14, "price": 119, "country": "Argentina"},
    {"id": "1009", "name": "Chianti DOCG", "producer": "Cantina Toscana", "category": "Vin", "subcategory": "Rött", "packaging": "Flaska", "volume": 750, "alcohol": 13, "price": 99, "country": "Italien"},
    {"id": "1010", "name": "Pinot Grigio", "producer": "Veneto Wines", "category": "Vin", "subcategory": "Vitt", "packaging": "Flaska", "volume": 750, "alcohol": 12, "price": 89, "country": "Italien"},
    {"id": "1011", "name": "Sancerre Blanc", "producer": "Loire Estates", "category": "Vin", "subcategory": "Vitt", "packaging": "Flaska", "volume": 750, "alcohol": 13, "price": 199, "country": "Frankrike"},
    {"id": "1012", "name": "Châteauneuf-du-Pape", "producer": "Rhône Valley", "category": "Vin", "subcategory": "Rött", "packaging": "Flaska", "volume": 750, "alcohol": 14.5, "price": 329, "country": "Frankrike"},
    # MOUSSERANDE
    {"id": "1013", "name": "Cava Brut", "producer": "Penedès", "category": "Mousserande", "subcategory": "Cava", "packaging": "Flaska", "volume": 750, "alcohol": 11.5, "price": 89, "country": "Spanien"},
    {"id": "1014", "name": "Prosecco DOC", "producer": "Veneto Bubbles", "category": "Mousserande", "subcategory": "Prosecco", "packaging": "Flaska", "volume": 750, "alcohol": 11, "price": 99, "country": "Italien"},
    {"id": "1015", "name": "Crémant de Loire", "producer": "Loire Bulles", "category": "Mousserande", "subcategory": "Crémant", "packaging": "Flaska", "volume": 750, "alcohol": 12, "price": 149, "country": "Frankrike"},
    {"id": "1016", "name": "Moët & Chandon Brut", "producer": "Moët & Chandon", "category": "Mousserande", "subcategory": "Champagne", "packaging": "Flaska", "volume": 750, "alcohol": 12, "price": 449, "country": "Frankrike"},
    # ÖL
    {"id": "1017", "name": "Pripps Blå Lager", "producer": "Carlsberg Sverige", "category": "Öl", "subcategory": "Lager", "packaging": "24-pack 50cl", "volume": 12000, "alcohol": 5.2, "price": 289, "country": "Sverige"},
    {"id": "1018", "name": "Norrlands Guld Stark", "producer": "Spendrups", "category": "Öl", "subcategory": "Starköl", "packaging": "4-pack 50cl", "volume": 2000, "alcohol": 7.2, "price": 89, "country": "Sverige"},
    {"id": "1019", "name": "Falcon Bayerskt", "producer": "Carlsberg Sverige", "category": "Öl", "subcategory": "Lager", "packaging": "24-pack 50cl", "volume": 12000, "alcohol": 5.6, "price": 299, "country": "Sverige"},
    {"id": "1020", "name": "Heineken", "producer": "Heineken", "category": "Öl", "subcategory": "Lager", "packaging": "24-pack 33cl", "volume": 7920, "alcohol": 5, "price": 249, "country": "Nederländerna"},
    {"id": "1021", "name": "Mariestads Export", "producer": "Spendrups", "category": "Öl", "subcategory": "Lager", "packaging": "24-pack 50cl", "volume": 12000, "alcohol": 5.3, "price": 309, "country": "Sverige"},
    {"id": "1022", "name": "BrewDog Punk IPA", "producer": "BrewDog", "category": "Öl", "subcategory": "IPA", "packaging": "4-pack 33cl", "volume": 1320, "alcohol": 5.6, "price": 89, "country": "Skottland"},
    {"id": "1023", "name": "Guinness Draught", "producer": "Guinness", "category": "Öl", "subcategory": "Stout", "packaging": "4-pack 44cl", "volume": 1760, "alcohol": 4.2, "price": 99, "country": "Irland"},
    {"id": "1024", "name": "Omnipollo Konflikt", "producer": "Omnipollo", "category": "Öl", "subcategory": "IPA", "packaging": "Burk 33cl", "volume": 330, "alcohol": 6.5, "price": 39, "country": "Sverige"},
    # SPRIT
    {"id": "1025", "name": "Explorer Vodka", "producer": "V&S Group", "category": "Sprit", "subcategory": "Vodka", "packaging": "Flaska", "volume": 1000, "alcohol": 37.5, "price": 229, "country": "Sverige"},
    {"id": "1026", "name": "Skåne Akvavit", "producer": "V&S Group", "category": "Sprit", "subcategory": "Akvavit", "packaging": "Flaska", "volume": 1000, "alcohol": 40, "price": 269, "country": "Sverige"},
    {"id": "1027", "name": "Grant's Family Reserve", "producer": "William Grant", "category": "Sprit", "subcategory": "Whisky", "packaging": "Flaska", "volume": 1000, "alcohol": 40, "price": 289, "country": "Skottland"},
    {"id": "1028", "name": "Famous Grouse", "producer": "Edrington", "category": "Sprit", "subcategory": "Whisky", "packaging": "Flaska", "volume": 1000, "alcohol": 40, "price": 299, "country": "Skottland"},
    {"id": "1029", "name": "Captain Morgan Spiced", "producer": "Diageo", "category": "Sprit", "subcategory": "Rom", "packaging": "Flaska", "volume": 1000, "alcohol": 35, "price": 269, "country": "Jamaica"},
    {"id": "1030", "name": "Bombay Sapphire", "producer": "Bacardi", "category": "Sprit", "subcategory": "Gin", "packaging": "Flaska", "volume": 700, "alcohol": 40, "price": 269, "country": "Storbritannien"},
    {"id": "1031", "name": "Hendrick's Gin", "producer": "William Grant", "category": "Sprit", "subcategory": "Gin", "packaging": "Flaska", "volume": 700, "alcohol": 41.4, "price": 379, "country": "Skottland"},
    {"id": "1032", "name": "Jägermeister", "producer": "Mast-Jägermeister", "category": "Sprit", "subcategory": "Likör", "packaging": "Flaska", "volume": 700, "alcohol": 35, "price": 219, "country": "Tyskland"},
    {"id": "1033", "name": "Carlshamns Flaggpunsch", "producer": "Altia", "category": "Sprit", "subcategory": "Punsch", "packaging": "Flaska", "volume": 700, "alcohol": 26, "price": 159, "country": "Sverige"},
    {"id": "1034", "name": "Absolut Vodka", "producer": "Pernod Ricard", "category": "Sprit", "subcategory": "Vodka", "packaging": "Flaska", "volume": 700, "alcohol": 40, "price": 249, "country": "Sverige"},
    {"id": "1035", "name": "Jameson Irish Whiskey", "producer": "Pernod Ricard", "category": "Sprit", "subcategory": "Whisky", "packaging": "Flaska", "volume": 700, "alcohol": 40, "price": 269, "country": "Irland"},
    {"id": "1036", "name": "Bacardi Carta Blanca", "producer": "Bacardi", "category": "Sprit", "subcategory": "Rom", "packaging": "Flaska", "volume": 700, "alcohol": 37.5, "price": 219, "country": "Puerto Rico"},
    # CIDER & BLANDDRYCK
    {"id": "1037", "name": "Kopparberg Päron", "producer": "Kopparberg", "category": "Cider & Blanddryck", "subcategory": "Cider", "packaging": "4-pack 50cl", "volume": 2000, "alcohol": 4.5, "price": 89, "country": "Sverige"},
    {"id": "1038", "name": "Rekorderlig Vildbär", "producer": "Åbro", "category": "Cider & Blanddryck", "subcategory": "Cider", "packaging": "4-pack 50cl", "volume": 2000, "alcohol": 4.5, "price": 95, "country": "Sverige"},
    {"id": "1039", "name": "Smirnoff Ice", "producer": "Diageo", "category": "Cider & Blanddryck", "subcategory": "Blanddryck", "packaging": "4-pack 27.5cl", "volume": 1100, "alcohol": 4, "price": 79, "country": "USA"},
    {"id": "1040", "name": "Briska Lingon", "producer": "Spendrups", "category": "Cider & Blanddryck", "subcategory": "Cider", "packaging": "4-pack 50cl", "volume": 2000, "alcohol": 4.5, "price": 85, "country": "Sverige"},
]


def main():
    for p in PRODUCTS:
        p["apk"] = round((p["volume"] * (p["alcohol"] / 100)) / p["price"], 4)
        p["image"] = None

    PRODUCTS.sort(key=lambda x: x["apk"], reverse=True)

    output = {
        "updated": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "count": len(PRODUCTS),
        "source": "mockdata (kommer ersättas av GitHub Actions)",
        "products": PRODUCTS,
    }

    out_path = Path(__file__).resolve().parent.parent / "data.json"
    with out_path.open("w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, separators=(",", ":"))
    print(f"Skrev {len(PRODUCTS)} mockprodukter till {out_path}")


if __name__ == "__main__":
    main()
