# Tillfälligt testskript (tas bort): vad heter cider-kategorin i Systembolagets API?
import json, time, urllib.request, urllib.parse
from collections import Counter
BASE = "https://api-extern.systembolaget.se/sb-api-ecommerce/v1/productsearch/search"
KEY = "cfc702aed3094c86b92d6d4ff7a54c84"
def get(params):
    url = BASE + "?" + urllib.parse.urlencode(params, doseq=True)
    req = urllib.request.Request(url, headers={"Ocp-Apim-Subscription-Key": KEY, "User-Agent": "Mozilla/5.0",
        "Accept": "application/json", "Origin": "https://www.systembolaget.se", "Referer": "https://www.systembolaget.se/"})
    for a in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read())
        except Exception as e:
            print("  retry", e); time.sleep(2)
    raise SystemExit("failed " + url)
def count(p):
    return (get({"page": 1, "size": 30, **p}).get("metadata") or {}).get("docCount")
for name in ["Cider & blanddryck", "Cider & Blanddryck", "Cider & blanddrycker", "Cider & Blanddrycker", "Cider"]:
    print(f"== Fast + categoryLevel1={name!r}: {count({'assortmentText': 'Fast sortiment', 'categoryLevel1': name})}")
l1, l2, ex = Counter(), Counter(), {}
page = 1
while page <= 120:
    d = get({"page": page, "size": 30, "assortmentText": "Fast sortiment", "sortBy": "Name", "sortDirection": "Ascending"})
    prods = d.get("products") or []
    if not prods: break
    for p in prods:
        c1, c2 = p.get("categoryLevel1"), p.get("categoryLevel2")
        l1[c1] += 1
        if c1 not in ("Vin", "Öl", "Sprit"):
            l2[(c1, c2)] += 1
            ex.setdefault((c1, c2), (p.get("productNameBold"), p.get("productNameThin"), p.get("alcoholPercentage"), p.get("volume"), p.get("price"), p.get("categoryLevel3")))
    nxt = (d.get("metadata") or {}).get("nextPage")
    if nxt is None or nxt <= page: break
    page += 1; time.sleep(0.05)
print("== categoryLevel1 in Fast:", l1.most_common())
for k, v in l2.most_common(): print("== level2", k, v, "ex:", ex[k])
for a in ["Tillfälligt sortiment", "Säsong", "Lokalt & Småskaligt", "Webblanseringar"]:
    print(f"== assortment {a!r}: {count({'assortmentText': a})}")
