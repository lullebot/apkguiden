// api/dryck.js — Egen sida för varje enskild dryck: /dryck/<id>-<namn>
//
// Varför en Vercel-funktion och inte 6 500 statiska HTML-filer?
//   - Inga tusentals filer som committas om varje vecka (repot hade svällt).
//   - Sidan byggs från samma search-data.json som resten av sajten, så den
//     är alltid i synk med topplistan – inget extra steg i GitHub Actions.
//   - Vercels CDN cachar varje sida, så besökare och Google får den lika
//     snabbt som en statisk fil. Cachen töms automatiskt vid varje ny deploy
//     (dvs. när data-boten committar ny data).
//
// vercel.json skriver om /dryck/:slug → /api/dryck?slug=:slug.

const DATA = require('../search-data.json');

// Produktfakta för beskrivningen (skrivs av scripts/update-data.py).
// Saknas filen (innan första körningen) visas en kortare beskrivning.
let DETAILS = {};
try {
  DETAILS = require('../product-details.json');
} catch (e) {
  DETAILS = {};
}

const SITE = 'https://apkguiden.se';
const SIMILAR_EACH_SIDE = 3;

// ---------- Index som byggs en gång per kallstart ----------
const PRODUCTS = DATA.products;
const BY_ID = new Map();
const BY_SUB = new Map();
for (const p of PRODUCTS) {
  BY_ID.set(String(p.id), p);
  const key = p.subcategory || p.category;
  if (!BY_SUB.has(key)) BY_SUB.set(key, []);
  BY_SUB.get(key).push(p);
}
// search-data.json är redan sorterad på APK (bäst först), men sortera ändå
// så underkategori-placeringen inte beror på filens ordning.
const SUB_RANK = new Map();
const SUB_MEDIAN = new Map();
for (const [key, list] of BY_SUB) {
  list.sort((a, b) => b.apk - a.apk || (a.price || 0) - (b.price || 0) || String(a.name).localeCompare(String(b.name)));
  list.forEach((p, i) => SUB_RANK.set(String(p.id), i + 1));
  SUB_MEDIAN.set(key, list[Math.floor(list.length / 2)].apk);
}

// Länkar till startsidans topplista för kategori/underkategori.
// Underkategorierna måste finnas som knappar på startsidan (SUBCATEGORIES i
// index.html), annars länkar vi bara till huvudkategorin.
const HOME_SUBCATEGORIES = {
  'Vin': ['Rött vin', 'Vitt vin', 'Rosévin', 'Mousserande vin', 'Starkvin', 'Smaksatt vin & fruktvin', 'Glögg och Glühwein'],
  'Öl': ['Ale', 'Ljus lager', 'Mellanmörk & Mörk lager', 'Veteöl', 'Porter & Stout', 'Syrlig öl', 'Annan öl'],
  'Sprit': ['Whisky', 'Gin & Genever', 'Rom & Lagrad sockerrörssprit', 'Likör', 'Armagnac & Brandy', 'Akvavit & Kryddat brännvin', 'Grappa & Marc', 'Smaksatt sprit'],
};
function urlSlug(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function categoryHref(cat) {
  return `/?kategori=${urlSlug(cat)}`;
}
function subcategoryHref(cat, sub) {
  if (!sub || !(HOME_SUBCATEGORIES[cat] || []).includes(sub)) return categoryHref(cat);
  return `/?kategori=${urlSlug(cat)}&typ=${urlSlug(sub)}`;
}

// ---------- Hjälpfunktioner ----------
// OBS: samma regel finns i index.html, samst-apk.html och update-data.py.
// Om de skulle skilja sig åt gör det inget – en "fel" slug 301-omdirigeras
// till rätt adress nedan.
function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}
function productPath(p) {
  const s = slugify(p.name);
  return `/dryck/${p.id}${s ? '-' + s : ''}`;
}
function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
const nf = new Intl.NumberFormat('sv-SE');
const nf1 = new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function kr(n) {
  return n % 1 === 0 ? nf.format(n) : nf2.format(n);
}
function volumeText(ml) {
  if (ml >= 1000) return `${nf.format(Math.round(ml / 10) / 100)} liter`;
  return `${nf.format(ml)} ml`;
}
function volumeShort(ml) {
  if (ml >= 1000) return `${(ml / 1000).toFixed(ml % 1000 === 0 ? 0 : 2).replace('.', ',')} L`;
  return `${ml} ml`;
}
// Ett standardglas = 12 gram ren alkohol (Systembolagets/FHM:s definition).
function standardDrinks(p) {
  const grams = (p.volume * p.alcohol / 100) * 0.789;
  return grams / 12;
}
function systembolagetUrl(p) {
  return `https://www.systembolaget.se/sok?textQuery=${encodeURIComponent(p.id)}`;
}
function lower(s) {
  return String(s || '').toLowerCase();
}

const BOTTLE_SVG = `<svg class="img-fallback" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2h8"></path><path d="M9 2v2.789a4 4 0 0 1-.672 2.219l-.656.984A4 4 0 0 0 7 10.212V20a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-9.789a4 4 0 0 0-.672-2.219l-.656-.984A4 4 0 0 1 15 4.788V2"></path></svg>`;

// ---------- Sidans delar ----------
function similarProducts(p) {
  const key = p.subcategory || p.category;
  const list = BY_SUB.get(key) || [];
  const idx = list.findIndex((x) => x.id === p.id);
  const from = Math.max(0, idx - SIMILAR_EACH_SIDE);
  const around = list.slice(from, idx + SIMILAR_EACH_SIDE + 1).filter((x) => x.id !== p.id);
  // Fyll på från andra hållet om vi ligger nära toppen/botten
  if (around.length < SIMILAR_EACH_SIDE * 2) {
    const extra = list
      .filter((x) => x.id !== p.id && !around.includes(x))
      .slice(0, SIMILAR_EACH_SIDE * 2 - around.length);
    around.push(...extra);
  }
  return around.sort((a, b) => b.apk - a.apk);
}

function topOfSub(p, n) {
  const key = p.subcategory || p.category;
  return (BY_SUB.get(key) || []).filter((x) => x.id !== p.id).slice(0, n);
}

function renderCard(x) {
  const img = x.image
    ? `<img src="${esc(x.image)}_200.png" srcset="${esc(x.image)}_200.png 1x, ${esc(x.image)}_400.png 2x" alt="" loading="lazy" onerror="this.style.display='none'">`
    : BOTTLE_SVG;
  return `<a class="card" href="${esc(productPath(x))}">
      <span class="card-img">${img}</span>
      <span class="card-body">
        <span class="card-name">${esc(x.name)}</span>
        <span class="card-meta">${esc(x.producer || '')}${x.producer ? ' · ' : ''}${esc(volumeShort(x.volume))} · ${x.alcohol}%</span>
      </span>
      <span class="card-stats">
        <span class="card-apk num">${x.apk.toFixed(2)}<small> ml/kr</small></span>
        <span class="card-price num">${kr(x.price)} kr</span>
      </span>
    </a>`;
}

// ---------- Beskrivning (egen text, byggd av Systembolagets produktfakta) ----------
function joinSv(list) {
  const xs = list.filter(Boolean);
  if (xs.length <= 1) return xs.join('');
  return xs.slice(0, -1).join(', ') + ' och ' + xs[xs.length - 1];
}
function cap(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function tasteSentence(c) {
  if (!c) return '';
  let head = '';
  if (c.b != null) head = c.b <= 4 ? 'lätt' : c.b <= 8 ? 'medelfyllig' : 'fyllig';
  const feats = [];
  if (c.s != null) {
    if (c.s <= 2) head = head ? head + ' och torr' : 'torr';
    else feats.push(c.s <= 6 ? 'viss sötma' : 'tydlig sötma');
  }
  if (c.f != null && c.f >= 4) feats.push(c.f >= 7 ? 'frisk syra' : 'balanserad syra');
  if (c.t != null && c.t >= 3) feats.push(c.t >= 7 ? 'tydlig beska' : 'lätt beska');
  if (c.r != null && c.r >= 3) feats.push(c.r >= 7 ? 'tydlig strävhet' : 'viss strävhet');
  if (c.k != null && c.k >= 1) feats.push(c.k >= 6 ? 'tydlig rökighet' : 'lätt rökighet');
  if (!head && !feats.length) return '';
  if (!head) return cap('med ' + joinSv(feats)) + '.';
  return cap(head) + (feats.length ? ', med ' + joinSv(feats) : '') + '.';
}

const AS_SERVING = { 'Sällskapsdryck': 'som sällskapsdryck', 'Aperitif': 'som aperitif', 'Avec/digestif': 'som avec' };

function productDescription(p) {
  const d = DETAILS[String(p.id)] || {};
  const sub = p.subcategory || p.category;
  const country = p.country === 'Internationellt märke' ? '' : p.country;
  const origin = d.o && country ? `${d.o}, ${country}` : (country || d.o || '');
  // Grupp-namn i plural ("Gin & Genever", "Aperitifer") kan inte stå efter
  // "är" – då skriver vi "hör till kategorin" istället.
  const isGroup = (x) => /&| och /.test(x) || /^(Aperitifer|Drycker av flera typer|Sprit av flera typer|Bitter)$/.test(x);
  let lead;
  if (p.category === 'Vin') lead = `är ${lower(sub)}${d.s ? ' i stilen ' + lower(d.s) : ''}`;
  else if (d.s && !isGroup(d.s)) lead = `är ${lower(d.s)}`;
  else if (!d.s && !isGroup(sub)) lead = `är ${lower(sub)}`;
  else lead = `hör till kategorin ${lower(d.s || sub)}`;
  let first = `<strong>${esc(p.name)}</strong> ${esc(lead)}${origin ? ' från ' + esc(origin) : ''}`;
  if (d.g && d.g.length) first += `, gjord på ${esc(joinSv(d.g))}`;
  if (d.v) first += `, årgång ${esc(d.v)}`;
  first += '.';

  const parts = [first];
  const taste = tasteSentence(d.c);
  if (taste) parts.push(taste);
  if (d.n && d.n.length) parts.push(`Toner av ${esc(joinSv(d.n.map(lower)))}.`);

  const food = (d.p || []).filter((x) => !AS_SERVING[x]).map(lower);
  const as = (d.p || []).filter((x) => AS_SERVING[x]).map((x) => AS_SERVING[x]);
  const temp = d.t === 'rum' ? 'Serveras rumstempererad' : d.t ? `Serveras vid ${d.t} °C` : '';
  let pairing = [food.length ? 'passar till ' + joinSv(food) : '', joinSv(as)].filter(Boolean).join(' eller ');
  if (!food.length && as.length) pairing = 'fungerar ' + joinSv(as);
  if (temp && pairing) parts.push(`${temp} och ${pairing}.`);
  else if (temp) parts.push(`${temp}.`);
  else if (pairing) parts.push(cap(pairing) + '.');
  if (d.e) parts.push('Ekologiskt producerad.');

  const hasFacts = Object.keys(d).length > 0;
  return `<p>${parts.join(' ')}</p>${hasFacts ? '<p class="source">Beskrivningen bygger på Systembolagets produktdata.</p>' : ''}`;
}

// ---------- Jämförelsen: hur bra är APK:n egentligen? ----------
function comparison(p, subRank, subTotal, median) {
  const key = p.subcategory || p.category;
  const sub = lower(key);
  const list = BY_SUB.get(key) || [];
  const out = [];

  const diff = median > 0 ? Math.round((p.apk / median - 1) * 100) : 0;
  if (diff > 0) out.push(`Den ger <strong>${nf.format(diff)} % mer alkohol per krona</strong> än medianen för ${esc(sub)} (${median.toFixed(2)} ml/kr).`);
  else if (diff < 0) out.push(`Den ger <strong>${nf.format(Math.abs(diff))} % mindre alkohol per krona</strong> än medianen för ${esc(sub)} (${median.toFixed(2)} ml/kr).`);
  else out.push(`Den ligger precis på medianen för ${esc(sub)} (${median.toFixed(2)} ml/kr).`);

  const pct = Math.max(1, Math.ceil((subRank / subTotal) * 100));
  let rankLine = `Plats <strong>${nf.format(subRank)} av ${nf.format(subTotal)}</strong> bland ${esc(sub)}`;
  if (subRank === 1) rankLine += ' – bäst av alla';
  else if (pct <= 25) rankLine += ` – bland de ${pct} % bästa`;
  else if (pct >= 75) rankLine += ` – bland de ${101 - pct} % sämsta`;
  out.push(rankLine + '.');

  // Samma prisklass (±20 %): det relevanta valet när man står i butiken.
  const lo = p.price * 0.8, hi = p.price * 1.2;
  const peers = list.filter((x) => x.price >= lo && x.price <= hi);
  const peerRank = peers.findIndex((x) => x.id === p.id) + 1;
  if (peers.length >= 3 && peerRank > 0) {
    out.push(`I samma prisklass (${kr(Math.round(lo))}–${kr(Math.round(hi))} kr) hamnar den på plats <strong>${nf.format(peerRank)} av ${nf.format(peers.length)}</strong> bland ${esc(sub)}.`);
  }

  const best = list[0];
  if (best && best.id !== p.id) {
    const gain = Math.round((best.apk / p.apk - 1) * 100);
    out.push(`Mest alkohol per krona bland ${esc(sub)} ger <a href="${esc(productPath(best))}">${esc(best.name)}</a> (${best.apk.toFixed(2)} ml/kr) – ${nf.format(gain)} % mer än den här.`);
  } else {
    out.push(`Inget annat i kategorin ${esc(sub)} i Systembolagets fasta sortiment ger mer alkohol per krona.`);
  }
  return out.map((x) => `<li>${x}</li>`).join('');
}

function page({ title, metaDescription, canonical, jsonLd, body, noindex, ogImage }) {
  return `<!DOCTYPE html>
<html lang="sv">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(metaDescription)}">
${noindex ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${esc(canonical)}">`}
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<meta name="theme-color" content="#0F3D2E">
<meta property="og:type" content="website">
<meta property="og:site_name" content="apkguiden.se">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(metaDescription)}">
${canonical ? `<meta property="og:url" content="${esc(canonical)}">` : ''}
<meta property="og:image" content="${esc(ogImage || SITE + '/favicon-512.png')}">
<meta property="og:locale" content="sv_SE">
<meta name="twitter:card" content="summary">
${jsonLd ? jsonLd.map((j) => `<script type="application/ld+json">${JSON.stringify(j).replace(/</g, '\\u003c')}</script>`).join('\n') : ''}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head>
<body>
<header class="top-nav"><div class="wrap nav-inner">
  <a href="/" class="logo" aria-label="apkguiden.se – till startsidan"><img class="logo-mark" src="/favicon.svg" alt="APK" width="48" height="48"></a>
  <a href="/" class="back-link">← Hela topplistan</a>
</div></header>
<main class="wrap">
${body}
</main>
<footer class="footer"><div class="wrap">
  <p>Data från Systembolagets fasta sortiment, uppdateras varje vecka. APK = volym (ml) × alkoholhalt ÷ pris. apkguiden.se är ett prisjämförelseverktyg och är inte knutet till Systembolaget. 18-årsgräns gäller.</p>
  <p><a href="/">Topplistan</a> · <a href="/samst-apk.html">Sämst APK</a> · <a href="/standardglas.html">Vad är ett standardglas?</a></p>
</div></footer>
</body>
</html>`;
}

const CSS = `
:root{--bg:#0F3D2E;--bg-dark:#0A2D22;--bg-light:#1A523F;--accent:#F4D35E;--cream:#F5EBC4;--muted:#D9B842;--brand:#F4D35E;--brand-muted:#D9B842;--line:rgba(244,211,94,.14)}
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:var(--bg);color:var(--cream);font-family:'Schibsted Grotesk',-apple-system,BlinkMacSystemFont,sans-serif;-webkit-font-smoothing:antialiased;line-height:1.5}
a{color:var(--brand)}
.num{font-variant-numeric:normal}
.wrap{max-width:60rem;margin:0 auto;padding:0 1rem}
@media(min-width:768px){.wrap{padding:0 1.5rem}}
.top-nav{background:var(--bg-dark);border-bottom:1px solid var(--line)}
.nav-inner{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding-top:1rem;padding-bottom:1rem}
.logo{display:inline-flex;align-items:center;gap:.6rem;text-decoration:none;line-height:1;font-weight:900;letter-spacing:-.035em;color:var(--brand)}
.logo-mark{width:3rem;height:3rem;flex-shrink:0;display:block;border-radius:22%;box-shadow:0 0 0 1.5px rgba(244,211,94,.3)}
.logo-word{font-size:1.6rem}
.logo-tld{font-weight:600}
@media(max-width:380px){.logo-mark{width:2.6rem;height:2.6rem}}
.logo-tld{color:var(--brand-muted)}
.back-link{font-size:.8rem;font-weight:600;color:var(--cream);text-decoration:none;padding:.5rem .875rem;border-radius:9999px;border:1.5px solid rgba(244,211,94,.25);white-space:nowrap}
.back-link:hover{border-color:var(--accent);color:var(--accent)}
.crumbs{font-size:.8rem;color:var(--muted);margin:1.5rem 0 1rem;display:flex;flex-wrap:wrap;gap:.35rem}
.crumbs a{color:var(--muted);text-decoration:none}
.crumbs a:hover{color:var(--accent)}
.hero{display:grid;grid-template-columns:1fr;gap:1.5rem;align-items:center;padding-bottom:2rem;border-bottom:1px solid var(--line)}
@media(min-width:720px){.hero{grid-template-columns:14rem 1fr;gap:2.5rem}}
.hero-img{background:var(--bg-light);border-radius:1.25rem;aspect-ratio:1;display:flex;align-items:center;justify-content:center;padding:1rem;max-width:14rem;width:100%;margin:0 auto}
.hero-img img{max-width:100%;max-height:100%;object-fit:contain}
.img-fallback{width:40%;color:var(--muted)}
.eyebrow{font-size:.75rem;letter-spacing:.25em;text-transform:uppercase;font-weight:600;color:var(--muted);margin:0 0 .75rem}
h1{font-size:clamp(2rem,6vw,3.5rem);font-weight:800;line-height:1;letter-spacing:-.03em;color:var(--accent);margin:0}
.producer{margin:.75rem 0 0;font-size:1.05rem}
.pills{display:flex;flex-wrap:wrap;gap:.4rem;margin-top:1rem}
.pill{font-size:.75rem;font-weight:600;padding:.3rem .7rem;border-radius:9999px;background:var(--bg-light);color:var(--cream)}
.pills a.pill{text-decoration:none;transition:filter .15s ease,box-shadow .15s ease}
.pills a.pill:hover{box-shadow:0 0 0 1.5px var(--accent)}
.rankpill{background:var(--brand);color:var(--bg-dark)}
.stats{display:grid;grid-template-columns:repeat(2,1fr);gap:.75rem;margin:2rem 0}
@media(min-width:720px){.stats{grid-template-columns:repeat(4,1fr)}}
.stat{background:var(--bg-light);border-radius:1rem;padding:1rem 1.1rem}
.stat-sub{font-size:.75rem;opacity:.75;margin-top:.2rem}
.stat-link{color:inherit;text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:3px}
.stat-link:hover{color:var(--cream)}
.stat-label{font-size:.7rem;letter-spacing:.15em;text-transform:uppercase;font-weight:600;color:var(--muted)}
.stat-value{font-size:1.6rem;font-weight:800;color:var(--cream);margin-top:.25rem;letter-spacing:-.02em}
.stat-value small{font-size:.8rem;font-weight:600;color:var(--muted);margin-left:.2rem}
.stat.main{background:var(--accent)}
.stat.main .stat-label,.stat.main .stat-value,.stat.main small{color:var(--bg-dark)}
.stat-label,.card-meta,.crumbs,.crumbs a,.eyebrow{opacity:.9}
.cta{display:inline-flex;align-items:center;gap:.5rem;background:var(--cream);color:var(--bg-dark);font-weight:700;text-decoration:none;padding:.8rem 1.3rem;border-radius:9999px;margin-top:.25rem}
.cta:hover{background:var(--brand)}
.prose{max-width:42rem;font-size:1.05rem}
.prose strong{color:var(--accent)}
.prose p{margin:0 0 .9rem}
.source{font-size:.8rem;opacity:.65}
.facts{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:.6rem}
.facts li{padding-left:1.1rem;position:relative}
.facts li::before{content:'';position:absolute;left:0;top:.6em;width:.4rem;height:.4rem;border-radius:50%;background:var(--accent)}
h2{font-size:1.4rem;font-weight:800;letter-spacing:-.02em;color:var(--accent);margin:2.5rem 0 1rem}
.cards{display:flex;flex-direction:column;gap:.5rem}
.card{display:grid;grid-template-columns:3rem 1fr auto;gap:.875rem;align-items:center;background:var(--bg-light);border-radius:1rem;padding:.7rem .9rem;text-decoration:none;color:var(--cream);border:1.5px solid transparent}
.card:hover{border-color:var(--accent)}
.card-img{width:3rem;height:3rem;display:flex;align-items:center;justify-content:center}
.card-img img{max-width:100%;max-height:100%;object-fit:contain}
.card-img .img-fallback{width:60%}
.card-body{min-width:0;display:flex;flex-direction:column}
.card-name{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.card-meta{font-size:.8rem;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.card-stats{display:flex;flex-direction:column;align-items:flex-end}
.card-apk{font-weight:800;color:var(--accent)}
.card-apk small{font-size:.7rem;color:var(--muted);font-weight:600}
.card-price{font-size:.8rem}
.footer{margin-top:4rem;border-top:1px solid var(--line);font-size:.8rem;color:var(--muted);padding:1.5rem 0 2.5rem}
.footer a{color:var(--muted)}
`;

function renderProductPage(p) {
  const key = p.subcategory || p.category;
  const subList = BY_SUB.get(key) || [];
  const subRank = SUB_RANK.get(String(p.id)) || 0;
  const subTotal = subList.length;
  const median = SUB_MEDIAN.get(key) || 0;
  const canonical = SITE + productPath(p);
  const glas = standardDrinks(p);
  const sub = p.subcategory || p.category;

  const title = `${p.name}${p.producer && !String(p.name).includes(p.producer) ? ' – ' + p.producer : ''}: APK ${p.apk.toFixed(2)}, ${kr(p.price)} kr | apkguiden.se`;
  const metaDescription = `${p.name} (${volumeShort(p.volume)}, ${nf1.format(p.alcohol)} %) kostar ${kr(p.price)} kr på Systembolaget och ger ${p.apk.toFixed(2)} ml alkohol per krona – plats ${subRank} av ${subTotal} bland ${lower(sub)}. Jämför APK och pris per standardglas.`;

  const img = p.image
    ? `<img src="${esc(p.image)}_400.png" srcset="${esc(p.image)}_400.png 1x, ${esc(p.image)}_800.png 2x" alt="${esc(p.name)}" onerror="this.style.display='none'">`
    : BOTTLE_SVG;

  const similar = similarProducts(p);
  const best = topOfSub(p, 5 + similar.length).filter((x) => !similar.includes(x)).slice(0, 5);

  const jsonLd = [
    {
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: p.name,
      sku: String(p.id),
      url: canonical,
      ...(p.image ? { image: `${p.image}_800.png` } : {}),
      ...(p.producer ? { brand: { '@type': 'Brand', name: p.producer } } : {}),
      category: [p.category, p.subcategory].filter(Boolean).join(' > '),
      ...(p.country ? { countryOfOrigin: p.country } : {}),
      description: `${p.name}, ${lower(sub)}${p.country ? ' från ' + p.country : ''}, ${volumeShort(p.volume)}, ${nf1.format(p.alcohol)} % alkohol. APK ${p.apk.toFixed(2)} ml/kr.`,
      offers: {
        '@type': 'Offer',
        price: String(p.price),
        priceCurrency: 'SEK',
        availability: 'https://schema.org/InStock',
        url: systembolagetUrl(p),
        seller: { '@type': 'Organization', name: 'Systembolaget' },
      },
    }
  ];

  const body = `
<nav class="crumbs" aria-label="Brödsmulor"><a href="/">Topplistan</a><span>›</span><a href="${esc(categoryHref(p.category))}">${esc(p.category)}</a>${p.subcategory ? `<span>›</span><a href="${esc(subcategoryHref(p.category, p.subcategory))}">${esc(p.subcategory)}</a>` : ''}</nav>
<section class="hero">
  <div class="hero-img">${img}</div>
  <div>
    <p class="eyebrow">${esc(sub)}${p.country ? ' · ' + esc(p.country) : ''}</p>
    <h1>${esc(p.name)}</h1>
    ${p.producer ? `<p class="producer">${esc(p.producer)}</p>` : ''}
    <div class="pills">
      <a class="pill rankpill" href="${esc(subcategoryHref(p.category, p.subcategory))}">#${nf.format(subRank)} av ${nf.format(subTotal)} i ${esc(lower(sub))}</a>
      <a class="pill" href="${esc(categoryHref(p.category))}">#${nf.format(p.rank)} av ${nf.format(p.categoryTotal)} i ${esc(lower(p.category))}</a>
      ${p.packaging ? `<span class="pill">${esc(p.packaging)}</span>` : ''}
      ${p.new ? '<span class="pill rankpill">Nyinkommen</span>' : ''}
    </div>
  </div>
</section>
<section class="stats">
  <div class="stat main"><div class="stat-label">APK</div><div class="stat-value num">${p.apk.toFixed(2)}<small>ml/kr</small></div></div>
  <div class="stat"><div class="stat-label">Pris</div><div class="stat-value num">${kr(p.price)}<small>kr</small></div></div>
  <div class="stat"><div class="stat-label">Volym · Alkohol</div><div class="stat-value num">${esc(volumeShort(p.volume))}<small>${nf1.format(p.alcohol)} %</small></div></div>
  <div class="stat"><div class="stat-label"><a class="stat-link" href="/standardglas.html">Pris per glas <span aria-hidden="true">ⓘ</span></a></div><div class="stat-value num">${kr(Math.round((p.price / glas) * 100) / 100)}<small>kr</small></div><div class="stat-sub">${nf1.format(glas)} glas i förpackningen</div></div>
</section>
<a class="cta" href="${esc(systembolagetUrl(p))}" target="_blank" rel="noopener noreferrer">Se ${esc(p.name)} hos Systembolaget ↗</a>
<h2>Om drycken</h2>
<div class="prose">${productDescription(p)}</div>
<h2>Hur bra är APK:n?</h2>
<ul class="prose facts">${comparison(p, subRank, subTotal, median)}</ul>
${similar.length ? `<h2>Liknande APK bland ${esc(lower(sub))}</h2><div class="cards">${similar.map(renderCard).join('')}</div>` : ''}
${best.length ? `<h2>Bäst APK bland ${esc(lower(sub))}</h2><div class="cards">${best.map(renderCard).join('')}</div>` : ''}
`;
  return page({ title, metaDescription, canonical, jsonLd, body, ogImage: p.image ? `${p.image}_800.png` : null });
}

function renderNotFound() {
  const body = `
<section style="padding:4rem 0">
  <p class="eyebrow">404</p>
  <h1>Drycken finns inte längre</h1>
  <p class="prose" style="margin-top:1.25rem">Den här produkten finns inte i Systembolagets fasta sortiment just nu – den kan ha utgått eller bytt artikelnummer. Sök fram den eller något liknande i topplistan.</p>
  <a class="cta" href="/">Till topplistan</a>
</section>`;
  return page({
    title: 'Drycken hittades inte | apkguiden.se',
    metaDescription: 'Produkten finns inte i Systembolagets fasta sortiment just nu.',
    body,
    noindex: true,
  });
}

module.exports = (req, res) => {
  const raw = String((req.query && req.query.slug) || '');
  const m = raw.match(/^(\d+)/);
  const p = m ? BY_ID.get(m[1]) : null;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (!p) {
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=3600');
    res.statusCode = 404;
    return res.end(renderNotFound());
  }

  const path = productPath(p);
  if (`/dryck/${raw}` !== path) {
    res.statusCode = 301;
    res.setHeader('Location', path);
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400');
    return res.end();
  }

  // Webbläsare: kort cache. Vercels CDN: ett dygn, och servera gammal sida
  // medan en ny byggs i bakgrunden. Ny deploy tömmer CDN-cachen ändå.
  res.setHeader('Cache-Control', 'public, max-age=600, s-maxage=86400, stale-while-revalidate=604800');
  res.statusCode = 200;
  return res.end(renderProductPage(p));
};

// Exporteras för sitemap/tester
module.exports.slugify = slugify;
module.exports.productPath = productPath;
