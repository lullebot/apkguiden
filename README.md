# apkguiden.se

> En topplista över Systembolagets sortiment, rangordnad efter alkohol per krona (APK).

**Live:** [apkguiden.se](https://apkguiden.se)

Sajten är en helt statisk HTML-fil som hämtar produktdata från en `data.json`. En GitHub Actions-bot uppdaterar `data.json` automatiskt varje dag mot ett offentligt GitHub-projekt som speglar Systembolagets sortiment.

---

## 📦 Vad finns i mappen

```
apkguiden/
├── index.html                    ← Själva hemsidan (HTML, CSS och JavaScript i en fil)
├── data.json                     ← Produktdata (uppdateras automatiskt dagligen)
├── README.md                     ← Den här filen
├── scripts/
│   ├── update-data.py            ← Hämtar färsk data från Systembolaget-spegeln
│   └── seed-data.py              ← Genererar startdata (körs en gång)
└── .github/
    └── workflows/
        └── update-data.yml       ← Schemalägger den dagliga uppdateringen
```

---

## 🚀 Deploy till webben (engångssetup)

Du behöver två gratis konton: **GitHub** (för koden) och **Vercel** (för hostingen). Hela processen tar ca 15 minuter.

### Steg 1: Skapa GitHub-konto och repo

1. Gå till [github.com](https://github.com) och skapa ett konto om du inte har ett.
2. Klicka på **New repository** (grön knapp uppe till höger).
3. Namnge repot t.ex. `apkguiden`. Sätt det till **Public** (krävs för gratis GitHub Actions).
4. Klicka **Create repository**.

### Steg 2: Ladda upp filerna

På den nya repo-sidan klickar du **uploading an existing file** och drar in alla filer och mappar från denna mapp. Klicka **Commit changes**.

> 💡 Viktigt: Mappstrukturen måste behållas exakt – `.github/workflows/update-data.yml` och `scripts/update-data.py` måste ligga i sina respektive undermappar.

### Steg 3: Aktivera write-rättigheter för GitHub Actions

För att den schemalagda boten ska kunna committa tillbaka uppdaterad data:

1. Gå till **Settings** i ditt repo (uppe i menyn).
2. I vänstermenyn: **Actions → General**.
3. Scrolla ner till **Workflow permissions**.
4. Välj **Read and write permissions**.
5. Klicka **Save**.

### Steg 4: Kör första data-uppdateringen manuellt

Den schemalagda körningen sker varje natt, men kör den en första gång manuellt så får du riktig data direkt:

1. Gå till fliken **Actions** i ditt repo.
2. Klicka på **Uppdatera produktdata** i listan till vänster.
3. Klicka **Run workflow → Run workflow** (knapp till höger).
4. Vänta ca 1–2 minuter. När den är klar har `data.json` ersatts med riktig data från Systembolaget.

### Steg 5: Deploy till Vercel

1. Gå till [vercel.com/signup](https://vercel.com/signup) och skapa ett konto med GitHub.
2. På Vercels startsida: klicka **Add New → Project**.
3. Välj ditt `apkguiden`-repo i listan, klicka **Import**.
4. Vercel detekterar att det är en statisk sajt – behåll alla standardinställningar och klicka **Deploy**.
5. Efter ca 30 sekunder är sajten live på en URL som `apkguiden.vercel.app`.

🎉 **Klart!** Sajten visar din data och uppdateras automatiskt varje natt.

---

## 🌐 Egen domän (apkguiden.se)

När du har köpt domänen (ca 100 kr/år hos t.ex. Loopia, One.com eller Namecheap):

1. I Vercel: gå till ditt projekt → **Settings → Domains**.
2. Skriv in `apkguiden.se` och klicka **Add**.
3. Vercel visar DNS-records som ska läggas in hos din domänregistrar (en A-record och en CNAME).
4. Logga in hos din domänregistrar, lägg in DNS-recorden enligt instruktionerna.
5. Vänta upp till några timmar – sedan funkar `apkguiden.se`.

---

## 🛠️ Förstå hur det funkar

### Datapipeline

```
Systembolagets sök-API (samma som systembolaget.se använder)
    ↓ (hämtas varje måndag av GitHub Actions: scripts/update-data.py)
Ditt repo: data.json, search-data.json, price-history.json m.fl. uppdateras
    ↓ (Vercel ser att filerna ändrats och deployar)
apkguiden.se → laddar färsk data
```

**Bara fasta sortimentet, och allt av det.** Skriptet söker bara i `ASSORTMENTS` (i dag `["Fast sortiment"]`, ca 3 200 artiklar). API:et lämnar aldrig ut mer än 9 990 träffar per sökning, och sorteringen är inte stabil – därför bläddras sökningen igenom med flera sorteringsordningar (`SORT_PASSES`) tills alla unika produkter är med. Loggen visar t.ex. `3 159/3 159 unika`. Får skriptet med mindre än 95 % (`MIN_COVERAGE`) avbryts körningen hellre än att skriva över bra data.

*Bakgrund:* fram till nov 2026 hämtades hela katalogen (~27 800) i en sökning, men bara de första 9 990 kom med – i en ordning som skiftade varje vecka. Följden var att 1 000–1 600 drycker försvann och kom tillbaka varje vecka, och deras sidor gav 404 under tiden.

**Tillfälligt saknade drycker ligger kvar.** Saknas en dryck en vecka (t.ex. helt slut i lager) ligger den kvar med senast kända uppgifter i upp till 21 dagar (`GRACE_DAYS`), så att sidan inte blinkar mellan 404 och 200. Dryckessidan säger då "senast sedd …".

### Prishistorik och /prisandringar

`price-history.json` har en rad per dryck och prisändring: första gången vi såg drycken och varje nytt pris därefter (datum = den veckokörning då ändringen upptäcktes). Den uppdateras varje vecka av `update-data.py`. Historiken maj–nov 2026 återskapades ur repots git-historik (veckovisa `search-data.json`).

- Varje dryckessida (`api/dryck.js`) visar dryckens prishistorik med en liten graf.
- `/prisandringar` (`api/prisandringar.js`) visar senaste prisomgången (en månad där minst 25 drycker fick nytt pris). Allt på sidan – även rubriksiffrorna och texterna – räknas fram ur `price-history.json`, så den uppdaterar sig själv efter varje veckokörning och byter själv till nästa omgång (mars/september). Sidan består av:
  - **Kvittot "En av varje"**: vad det kostar att köpa en av varje dryck före och efter omgången.
  - **Hela hyllan**: en ruta per dryck (röd = dyrare, blå = billigare, grå = oförändrad, tom ruta = ny). Mörkare, starkare nyans = ändring på minst 5 %, ljus nyans = mindre ändring. Går att söka i och ordna om efter pris eller APK.
  - **Det här sticker ut** och **Klättrade mest på APK-listan**: fynd som skrivs automatiskt och bara visas när siffrorna håller för dem.
  - Största höjningarna/sänkningarna och hela listan (sökbar).
- En omgång jämför priset före månadens första dag med priset vid månadens slut. Bara drycker som vi hade ett pris på före månaden räknas; nyare drycker visas som "nya" och ingår inte i procent eller summor.
- Samma funktion svarar med sidans underlag i andra format: `/api/prisandringar?format=csv` (alla prisändringar, öppnas direkt i Excel), `?format=json` (alla drycker, används av hyllan) och `?format=png` (delningsbilden som syns när någon länkar sidan i t.ex. Reddit eller Messenger – den ritas om med nya siffror av sig själv).
- Färgerna för dyrare/billigare är rött och blått i stället för rött och grönt, så att de går att skilja åt även med röd-grön färgblindhet (alla nyanser är kontrollerade mot varandra och mot bakgrunden). Färgerna står överst i `api/prisandringar.js` (`COLORS`).
- Systembolaget återanvänder ibland ett artikelnummer för en helt annan dryck. Byter namn eller volym för ett nummer börjar historiken om, så det inte ser ut som en prisändring.
- Ändringar som upptäcks efter att en dryck saknats några veckor har osäkert datum. De räknas till den månad då de upptäcktes.

### Justera vilka produkter som visas

Öppna `scripts/update-data.py`. Justera:

- `ASSORTMENTS = ["Fast sortiment"]` – vilka av Systembolagets sortiment som visas. Lägg till t.ex. `"Tillfälligt sortiment"` för fler drycker.
- `TOP_PER_CATEGORY = 500` – hur många produkter per huvudkategori som behålls.
- `MIN_ALCOHOL_PERCENT = 1.0` – lägsta alkoholhalt (filtrerar bort 0%-produkter).
- `KEEP_CATEGORIES = {...}` – vilka huvudkategorier som tas med, stavade som i Systembolagets data (`"Cider & blanddrycker"` med litet b – med stort B föll alla ciders bort fram till nov 2026). `CATEGORY_MAP` ger dem kortare namn på sajten (`Cider`). En ny kategori behöver också läggas till i `CATEGORIES`/`SUBCATEGORIES` i `index.html`, `HOME_SUBCATEGORIES` i `api/dryck.js` och `CATEGORIES` i `samst-apk.html`.

Spara filen, committa till GitHub, och kör Action-workflowen igen för att se ändringen.

### Justera designen

Allt i `index.html`. Färgerna ligger som CSS-variabler högst upp (`--green`, `--yellow` osv).

### Indexering i Google

Alla drycker har en egen sida (`/dryck/<id>-<namn>`), men Google får bara indexera ett urval:

- **topp 20 i varje underkategori** (`INDEX_TOP_PER_SUBCATEGORY` i `scripts/update-data.py`), och
- **sidor som redan fått klick från Google** – produkt-id:n i `keep-indexed.json`.

Urvalet räknas fram varje vecka av `update-data.py`, som sätter `"index": true` på de dryckerna i `search-data.json` och bara listar dem i `sitemap-drycker.xml`. Övriga sidor fungerar som vanligt för besökare men får `<meta name="robots" content="noindex">` (se `api/dryck.js`).

Varför: Google nedgraderade hela sajten 30 okt 2026, troligen för att ~7 300 nästan likadana dryckessidor såg massproducerade ut. Färre men bättre sidor i Googles index är det främsta sättet att vända det.

---

## 🤖 Underhåll

- Den schemalagda Action-körningen sker varje måndag 06:00 UTC (08:00 svensk sommartid, 07:00 vintertid).
- Om datan inte uppdateras: gå till fliken **Actions** i GitHub och kontrollera om något jobb misslyckats.
- Om GitHub-källan slutar uppdateras (osannolikt) finns alternativa speglar att byta till – se `update-data.py`.

---

## ⚖️ Juridiskt

Systembolagets produktdata är skyddad av sammanställningsrätt enligt svensk upphovsrättslag. Sajten använder en publik öppen spegel av datan via tredjeparts GitHub-projekt och bör enligt det projektets villkor inte användas i strid mot Systembolagets uppdrag (att inte främja ökad alkoholkonsumtion).

Sajten är ett verktyg för prisjämförelse, inte ett incitament till ökad konsumtion. 18-årsgräns gäller för all alkohol i Sverige.
