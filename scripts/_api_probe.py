# Tillfälligt testskript (tas bort): hur gamla är dryckerna i tillfälligt sortiment?
import json, time, urllib.request, urllib.parse
from collections import Counter
from datetime import date
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
today = date.today()
ages, months, flags, cats = [], Counter(), Counter(), Counter()
seen = set(); page = 1
while page <= 120:
    d = get({"page": page, "size": 30, "assortmentText": "Tillfälligt sortiment", "sortBy": "ProductLaunchDate", "sortDirection": "Ascending"})
    prods = d.get("products") or []
    if not prods: break
    for p in prods:
        pn = p.get("productNumber")
        if pn in seen: continue
        seen.add(pn)
        cats[p.get("categoryLevel1")] += 1
        flags["oos"] += bool(p.get("isCompletelyOutOfStock")); flags["tmp"] += bool(p.get("isTemporaryOutOfStock")); flags["disc"] += bool(p.get("isDiscontinued"))
        ld = (p.get("productLaunchDate") or "")[:10]
        if ld:
            months[ld[:7]] += 1
            try:
                ages.append(((today - date.fromisoformat(ld)).days, ld, p.get("productNameBold"), p.get("isCompletelyOutOfStock")))
            except ValueError: pass
    nxt = (d.get("metadata") or {}).get("nextPage")
    if nxt is None or nxt <= page: break
    page += 1; time.sleep(0.05)
ages.sort()
n = len(ages)
print("== unique", len(seen), "with launch date", n, "flags", dict(flags), "cats", cats.most_common())
if n:
    q = lambda f: ages[min(n - 1, int(f * n))][0]
    print(f"== age days: median {q(0.5)}, p25 {q(0.25)}, p75 {q(0.75)}, p90 {q(0.9)}, max {ages[-1][0]}")
    for lim in (30, 91, 182, 365, 730):
        print(f"== launched within {lim} days: {sum(1 for a in ages if a[0] <= lim)} ({sum(1 for a in ages if a[0] <= lim)/n:.0%})")
    print("== oldest:", ages[-5:])
    in_stock = [a for a in ages if not a[3]]
    print("== in stock (not completely out):", len(in_stock), "median age", in_stock[len(in_stock)//2][0] if in_stock else None)
print("== per launch month:", sorted(months.items())[-24:])
