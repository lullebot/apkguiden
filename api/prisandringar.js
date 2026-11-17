// api/prisandringar.js — /prisandringar: vad som blivit dyrare och billigare
// på Systembolaget, räknat från vår veckovisa prishistorik.
//
// Sidan byggs från price-history.json (skrivs av scripts/update-data.py varje
// vecka) och search-data.json. Den uppdaterar sig alltså själv: när
// veckokörningen upptäcker nya priser syns de här efter nästa deploy, utan
// att någon behöver göra något.
//
// vercel.json skriver om /prisandringar → /api/prisandringar.

const D = require('./dryck');
const { page, esc, kr, nf, volumeShort, dateText, monthText, pctText, priceChanges, productPath, PRODUCTS, HISTORY, LAST_CHECK, SITE } = D;

const URL = SITE + '/prisandringar';
// En månad räknas som en "prisändringsomgång" om minst så här många drycker
// fick nytt pris. Enstaka ändringar mellan omgångarna visas inte som omgång.
const ROUND_MIN = 25;
const TOP_N = 15;
const CATEGORY_ORDER = ['Öl', 'Vin', 'Sprit', 'Cider'];

// ---------- Räkna fram alla prisändringar för dryckerna på sajten ----------
// Ändringar med osäkert datum (drycken saknades veckorna före) räknas inte in
// – vi vet inte vilken omgång de hör till.
const EVENTS = [];
for (const p of PRODUCTS) {
  for (const c of priceChanges(p.id)) if (!c.uncertain) EVENTS.push({ p, ...c });
}
const BY_MONTH = new Map();
for (const e of EVENTS) {
  const m = e.date.slice(0, 7);
  if (!BY_MONTH.has(m)) BY_MONTH.set(m, []);
  BY_MONTH.get(m).push(e);
}
const ROUNDS = [...BY_MONTH.entries()]
  .filter(([, list]) => list.length >= ROUND_MIN)
  .sort((a, b) => (a[0] < b[0] ? 1 : -1))
  .map(([month, list]) => ({ month, list, ...summarize(list) }));

function summarize(list) {
  const up = list.filter((e) => e.to > e.from).length;
  const down = list.length - up;
  const avg = list.reduce((s, e) => s + e.pct, 0) / (list.length || 1);
  return { up, down, avg };
}

// Nästa tillfälle då leverantörerna får ändra priserna i fasta sortimentet
// (mars och september enligt Systembolaget).
function nextWindow(iso) {
  const [y, m] = String(iso || new Date().toISOString()).split('-').map(Number);
  if (m < 3) return `mars ${y}`;
  if (m < 9) return `september ${y}`;
  return `mars ${y + 1}`;
}

const nfPct = new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 1 });

function changeRow(e) {
  const p = e.p;
  return `<li class="pc-row">
    <a class="pc-name" href="${esc(productPath(p))}">${esc(p.name)}</a>
    <span class="pc-meta">${esc(p.subcategory || p.category)} · ${esc(volumeShort(p.volume))}</span>
    <span class="pc-price num">${kr(e.from)} → <strong>${kr(e.to)} kr</strong></span>
    <span class="pc-pct num ${e.to > e.from ? 'up' : 'down'}">${pctText(e.pct)}</span>
  </li>`;
}

function categoryTable(list) {
  const groups = new Map();
  for (const e of list) {
    const c = e.p.category || 'Övrigt';
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(e);
  }
  const cats = [...groups.keys()].sort((a, b) => {
    const ia = CATEGORY_ORDER.indexOf(a), ib = CATEGORY_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b, 'sv');
  });
  const rows = cats.map((c) => {
    const s = summarize(groups.get(c));
    return `<tr><th scope="row">${esc(c)}</th><td class="num">${nf.format(s.up)}</td><td class="num">${nf.format(s.down)}</td><td class="num">${pctText(s.avg)}</td></tr>`;
  }).join('');
  return `<div class="pc-table-wrap"><table class="pc-table">
    <thead><tr><th scope="col">Kategori</th><th scope="col">Dyrare</th><th scope="col">Billigare</th><th scope="col">Snitt</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function roundsTable() {
  const rows = ROUNDS.map((r) => `<tr><th scope="row">${esc(monthText(r.month))}</th><td class="num">${nf.format(r.up)}</td><td class="num">${nf.format(r.down)}</td><td class="num">${pctText(r.avg)}</td></tr>`).join('');
  return `<div class="pc-table-wrap"><table class="pc-table">
    <thead><tr><th scope="col">Månad</th><th scope="col">Dyrare</th><th scope="col">Billigare</th><th scope="col">Snitt</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function allChangesList(list) {
  const sorted = list.slice().sort((a, b) => {
    const ia = CATEGORY_ORDER.indexOf(a.p.category), ib = CATEGORY_ORDER.indexOf(b.p.category);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || b.pct - a.pct || String(a.p.name).localeCompare(String(b.p.name), 'sv');
  });
  // Kompakt tabell – kan bli tusentals rader.
  const rows = sorted.map((e) => `<tr><td><a href="${esc(productPath(e.p))}">${esc(e.p.name)}</a> <small>${esc(volumeShort(e.p.volume))}</small></td><td>${esc(e.p.subcategory || e.p.category)}</td><td class="num">${kr(e.from)}</td><td class="num">${kr(e.to)}</td><td class="num">${pctText(e.pct)}</td></tr>`).join('');
  return `<details class="pc-all"><summary>Visa alla ${nf.format(list.length)} prisändringar</summary>
    <div class="pc-table-wrap pc-full"><table class="pc-table">
    <thead><tr><th scope="col">Dryck</th><th scope="col">Typ</th><th scope="col">Före, kr</th><th scope="col">Efter, kr</th><th scope="col">Ändring</th></tr></thead>
    <tbody>${rows}</tbody></table></div></details>`;
}

const EXTRA_CSS = `
.pc-lead{margin-top:1.25rem}
.pc-list{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:.45rem}
.pc-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:.1rem 1rem;background:var(--bg-light);border-radius:.9rem;padding:.65rem .9rem}
.pc-name{font-weight:700;color:var(--cream);text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pc-name:hover{color:var(--accent)}
.pc-meta{grid-column:1;font-size:.8rem;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pc-price{grid-column:2;grid-row:1;text-align:right;font-size:.9rem;white-space:nowrap}
.pc-price strong{color:var(--cream)}
.pc-pct{grid-column:2;grid-row:2;text-align:right;font-size:.8rem;font-weight:700;white-space:nowrap}
.pc-pct.up{color:#FF8A6B}
.pc-pct.down{color:#8FE3B0}
.pc-table-wrap{overflow-x:auto;max-width:42rem}
.pc-table{width:100%;border-collapse:collapse;font-size:.95rem}
.pc-table th,.pc-table td{padding:.55rem .75rem;border-bottom:1px solid var(--line);text-align:right}
.pc-table th:first-child{text-align:left}
.pc-table thead th{font-size:.7rem;letter-spacing:.15em;text-transform:uppercase;color:var(--muted);font-weight:600}
.pc-table tbody th{font-weight:700;color:var(--cream)}
.pc-all{margin-top:1.25rem}
.pc-all summary{cursor:pointer;font-weight:700;color:var(--accent);margin-bottom:.75rem}
.pc-full{max-width:none}
.pc-full .pc-table{font-size:.85rem}
.pc-full .pc-table td{padding:.4rem .6rem;text-align:right}
.pc-full .pc-table td:first-child,.pc-full .pc-table td:nth-child(2){text-align:left}
.pc-full .pc-table td a{color:var(--cream);text-decoration:none;font-weight:600}
.pc-full .pc-table td a:hover{color:var(--accent)}
.pc-full .pc-table small{color:var(--muted)}
.pc-cols{display:grid;grid-template-columns:1fr;gap:0 2rem}
@media(min-width:900px){.pc-cols{grid-template-columns:1fr 1fr}}
`;

function render() {
  const latest = ROUNDS[0];
  const since = HISTORY.since || (HISTORY.checks || [])[0];
  const checks = (HISTORY.checks || []).length;
  const sinceText = since ? monthText(since) : '';
  const source = '<a href="https://www.systembolaget.se/kundservice/sortiment/a5376eb1-c12e-42eb-ac6c-1891428b2e1f/nar-och-hur-ofta-andras-priserna-i-systembolagets-sortiment/5f976abb-2d1b-4756-98ea-506aa6de3a89/" target="_blank" rel="noopener">enligt Systembolaget</a>';

  let body = `
<nav class="crumbs" aria-label="Brödsmulor"><a href="/">Topplistan</a><span>›</span><span>Prisändringar</span></nav>
<p class="eyebrow">Prisbevakning</p>
<h1>Prisändringar på Systembolaget</h1>
<div class="prose pc-lead">
  <p>Vi kollar priset på varje dryck i Systembolagets fasta sortiment varje vecka${sinceText ? ` sedan ${esc(sinceText)}` : ''}. Leverantörerna får ändra sina priser i det fasta sortimentet två gånger om året, i mars och september (${source}). Här ser du vad som blev dyrare och vad som blev billigare.</p>
</div>`;

  if (!latest) {
    body += `<p class="prose">Vi har inte sett någon större prisändring ännu. Nästa tillfälle då leverantörerna får ändra priserna är i <strong>${esc(nextWindow(LAST_CHECK))}</strong>.</p>`;
  } else {
    const ups = latest.list.filter((e) => e.to > e.from).sort((a, b) => b.pct - a.pct || (b.to - b.from) - (a.to - a.from)).slice(0, TOP_N);
    const downs = latest.list.filter((e) => e.to < e.from).sort((a, b) => a.pct - b.pct || (a.to - a.from) - (b.to - b.from)).slice(0, TOP_N);
    body += `
<h2>Senaste prisändringen: ${esc(monthText(latest.month))}</h2>
<section class="stats" style="margin-top:0">
  <div class="stat main"><div class="stat-label">Dyrare</div><div class="stat-value num">${nf.format(latest.up)}<small>drycker</small></div></div>
  <div class="stat"><div class="stat-label">Billigare</div><div class="stat-value num">${nf.format(latest.down)}<small>drycker</small></div></div>
  <div class="stat"><div class="stat-label">Snittändring</div><div class="stat-value num">${pctText(latest.avg)}</div></div>
  <div class="stat"><div class="stat-label">Senast kollat</div><div class="stat-value num" style="font-size:1.15rem">${LAST_CHECK ? esc(dateText(LAST_CHECK)) : '–'}</div></div>
</section>
<p class="prose">I ${esc(monthText(latest.month))} fick <strong>${nf.format(latest.list.length)} drycker</strong> nytt pris: ${nf.format(latest.up)} blev dyrare och ${nf.format(latest.down)} billigare. Bland dem som ändrades var snittändringen ${pctText(latest.avg)}. Nästa tillfälle då leverantörerna får ändra priserna är i <strong>${esc(nextWindow(LAST_CHECK))}</strong>.</p>
<h2>Per kategori</h2>
${categoryTable(latest.list)}
<div class="pc-cols">
  <div>${ups.length ? `<h2>Största höjningarna</h2><ul class="pc-list">${ups.map(changeRow).join('')}</ul>` : ''}</div>
  <div>${downs.length ? `<h2>Största sänkningarna</h2><ul class="pc-list">${downs.map(changeRow).join('')}</ul>` : ''}</div>
</div>
${allChangesList(latest.list)}`;
    if (ROUNDS.length > 1) {
      body += `<h2>Alla prisändringar vi sett</h2>${roundsTable()}`;
    }
  }

  body += `
<h2>Om siffrorna</h2>
<div class="prose">
  <p>Ett pris räknas som ändrat när det skiljer sig från förra gången vi såg drycken. Datumet är den vecka vi upptäckte ändringen. "Snitt" är genomsnittet bland de drycker som fick nytt pris – inte hela sortimentet. Bara drycker som finns i sortimentet i dag räknas med, och varje dryck har sin egen prishistorik på sin sida.</p>
  <p>Du får gärna använda siffrorna, till exempel i en artikel – länka till <a href="/prisandringar">apkguiden.se/prisandringar</a> som källa.${checks ? ` Underlaget är ${nf.format(checks)} veckovisa kontroller av sortimentet.` : ''}</p>
</div>`;

  const title = latest
    ? `Prisändringar på Systembolaget ${monthText(latest.month)}: ${nf.format(latest.up)} drycker dyrare | apkguiden.se`
    : 'Prisändringar på Systembolaget | apkguiden.se';
  const metaDescription = latest
    ? `Vad blev dyrare och billigare på Systembolaget? I ${monthText(latest.month)} fick ${nf.format(latest.list.length)} drycker i det fasta sortimentet nytt pris – ${nf.format(latest.up)} dyrare, ${nf.format(latest.down)} billigare. Se största höjningarna och sänkningarna.`
    : 'Vad blev dyrare och billigare på Systembolaget? Vi kollar priset på hela det fasta sortimentet varje vecka.';

  const jsonLd = [
    {
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      name: 'Prisändringar på Systembolaget',
      url: URL,
      description: metaDescription,
      inLanguage: 'sv-SE',
      isPartOf: { '@type': 'WebSite', name: 'apkguiden.se', url: SITE + '/' },
      ...(LAST_CHECK ? { dateModified: LAST_CHECK } : {}),
    },
    {
      '@context': 'https://schema.org',
      '@type': 'Dataset',
      name: 'Prishistorik för Systembolagets fasta sortiment',
      description: 'Veckovis prishistorik för varje dryck i Systembolagets fasta sortiment: datum då vi först såg drycken och varje prisändring därefter. Uppdateras varje vecka av apkguiden.se.',
      url: URL,
      inLanguage: 'sv-SE',
      isAccessibleForFree: true,
      creator: { '@type': 'Organization', name: 'apkguiden.se', url: SITE + '/' },
      keywords: ['Systembolaget', 'priser', 'prisändringar', 'alkohol', 'Sverige'],
      ...(since && LAST_CHECK ? { temporalCoverage: `${since}/${LAST_CHECK}` } : {}),
      distribution: [{ '@type': 'DataDownload', encodingFormat: 'application/json', contentUrl: SITE + '/price-history.json' }],
    },
  ];

  return page({ title, metaDescription, canonical: URL, jsonLd, body, extraCss: EXTRA_CSS });
}

module.exports = (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // Samma cache-regler som dryckessidorna: ny deploy (= ny veckodata) tömmer CDN:et.
  res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  res.setHeader('Vercel-CDN-Cache-Control', 'max-age=86400, stale-while-revalidate=604800');
  res.statusCode = 200;
  return res.end(render());
};

module.exports.render = render;
module.exports.ROUNDS = ROUNDS;
