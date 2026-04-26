# apkguiden.se

> En topplista över Systembolagets sortiment, rangordnad efter alkohol per krona (APK).

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
Systembolaget.se
    ↓ (skrapas dagligen)
GitHub: AlexGustafsson/systembolaget-api-data
    ↓ (laddas ner av vår bot varje natt)
Ditt repo: scripts/update-data.py kör → data.json uppdateras
    ↓ (Vercel ser att data.json ändrats)
apkguiden.se → laddar färsk data
```

### Justera vilka produkter som visas

Öppna `scripts/update-data.py`. Justera:

- `TOP_PER_CATEGORY = 500` – hur många produkter per huvudkategori som behålls.
- `MIN_ALCOHOL_PERCENT = 1.0` – lägsta alkoholhalt (filtrerar bort 0%-produkter).
- `KEEP_CATEGORIES = {...}` – vilka huvudkategorier som tas med.

Spara filen, committa till GitHub, och kör Action-workflowen igen för att se ändringen.

### Justera designen

Allt i `index.html`. Färgerna ligger som CSS-variabler högst upp (`--green`, `--yellow` osv).

---

## 🤖 Underhåll

- Den schemalagda Action-körningen sker varje dygn 06:00 UTC (08:00 svensk sommartid, 07:00 vintertid).
- Om datan inte uppdateras: gå till fliken **Actions** i GitHub och kontrollera om något jobb misslyckats.
- Om GitHub-källan slutar uppdateras (osannolikt) finns alternativa speglar att byta till – se `update-data.py`.

---

## ⚖️ Juridiskt

Systembolagets produktdata är skyddad av sammanställningsrätt enligt svensk upphovsrättslag. Sajten använder en publik öppen spegel av datan via tredjeparts GitHub-projekt och bör enligt det projektets villkor inte användas i strid mot Systembolagets uppdrag (att inte främja ökad alkoholkonsumtion).

Sajten är ett verktyg för prisjämförelse, inte ett incitament till ökad konsumtion. 18-årsgräns gäller för all alkohol i Sverige.
