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
// Samma ordning som flikarna på startsidan.
const CATEGORY_ORDER = ['Vin', 'Öl', 'Sprit', 'Cider'];
const catIndex = (c) => { const i = CATEGORY_ORDER.indexOf(c); return i < 0 ? 99 : i; };

// Antal drycker på sajten per kategori (för "X av Y fick nytt pris").
const CATEGORY_TOTAL = {};
for (const p of PRODUCTS) CATEGORY_TOTAL[p.category] = (CATEGORY_TOTAL[p.category] || 0) + 1;

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

const UP_ICON = '<svg class="pc-ico up" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 2l5 8H1z"/></svg>';
const DOWN_ICON = '<svg class="pc-ico down" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 10L1 2h10z"/></svg>';

// Tvådelad stapel: andel som blev dyrare (korall) och billigare (mint).
// Antalen står alltid i text bredvid – färgen är aldrig enda bäraren.
function splitBar(up, down) {
  const total = up + down;
  if (!total) return '';
  return `<div class="pc-bar" role="img" aria-label="${nf.format(up)} dyrare, ${nf.format(down)} billigare">${up ? `<span class="up" style="flex:${up}"></span>` : ''}${down ? `<span class="down" style="flex:${down}"></span>` : ''}</div>`;
}

function shareText(n, total) {
  if (!total) return '';
  const pct = (n / total) * 100;
  return pct < 1 ? 'under 1 %' : `${Math.round(pct)} %`;
}

function thumb(p) {
  return p.image
    ? `<img src="${esc(p.image)}_200.png" alt="" loading="lazy" onerror="this.style.display='none'">`
    : '';
}

function changeRow(e, i) {
  const p = e.p;
  const up = e.to > e.from;
  return `<li><a class="pc-row" href="${esc(productPath(p))}">
    <span class="pc-rank num">${i + 1}</span>
    <span class="pc-thumb">${thumb(p)}</span>
    <span class="pc-text"><span class="pc-name">${esc(p.name)}</span><span class="pc-meta">${esc(p.subcategory || p.category)} · ${esc(volumeShort(p.volume))}</span></span>
    <span class="pc-nums"><span class="pc-pct num">${up ? UP_ICON : DOWN_ICON}${pctText(e.pct)}</span><span class="pc-price num">${kr(e.from)} → <strong>${kr(e.to)} kr</strong></span></span>
  </a></li>`;
}

function categoryCards(list) {
  const groups = new Map();
  for (const e of list) {
    const c = e.p.category || 'Övrigt';
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(e);
  }
  const cats = [...groups.keys()].sort((a, b) => catIndex(a) - catIndex(b) || a.localeCompare(b, 'sv'));
  return `<div class="pc-cats">${cats.map((c) => {
    const g = groups.get(c);
    const s = summarize(g);
    const total = CATEGORY_TOTAL[c] || 0;
    return `<div class="pc-cat">
      <div class="pc-cat-head">
        <div><div class="pc-cat-name">${esc(c)}</div><div class="pc-cat-sub">${nf.format(g.length)} av ${nf.format(total)} fick nytt pris${total ? ` (${shareText(g.length, total)})` : ''}</div></div>
        <div class="pc-cat-avg"><div class="pc-cat-avg-v num">${pctText(s.avg)}</div><div class="pc-cat-avg-l">snitt</div></div>
      </div>
      ${splitBar(s.up, s.down)}
      <div class="pc-legend"><span>${UP_ICON}<strong class="num">${nf.format(s.up)}</strong> dyrare</span><span>${DOWN_ICON}<strong class="num">${nf.format(s.down)}</strong> billigare</span></div>
    </div>`;
  }).join('')}</div>`;
}

function roundsList() {
  return `<div class="pc-rounds">${ROUNDS.map((r) => `<div class="pc-round">
    <div class="pc-round-name">${esc(monthText(r.month))}</div>
    <div class="pc-round-bar">${splitBar(r.up, r.down)}</div>
    <div class="pc-legend"><span>${UP_ICON}<strong class="num">${nf.format(r.up)}</strong> dyrare</span><span>${DOWN_ICON}<strong class="num">${nf.format(r.down)}</strong> billigare</span><span class="pc-round-avg">snitt <strong class="num">${pctText(r.avg)}</strong></span></div>
  </div>`).join('')}</div>`;
}

function allChangesList(list) {
  const sorted = list.slice().sort((a, b) =>
    catIndex(a.p.category) - catIndex(b.p.category) || b.pct - a.pct || String(a.p.name).localeCompare(String(b.p.name), 'sv'));
  const cats = [...new Set(sorted.map((e) => e.p.category))];
  // Kompakt tabell – kan bli tusentals rader. data-c/data-n används av filtret.
  const rows = sorted.map((e) => `<tr data-c="${esc(e.p.category)}" data-n="${esc(String(e.p.name).toLowerCase())}"><td><a href="${esc(productPath(e.p))}">${esc(e.p.name)}</a> <small>${esc(volumeShort(e.p.volume))}</small></td><td>${esc(e.p.subcategory || e.p.category)}</td><td class="num">${kr(e.from)}</td><td class="num">${kr(e.to)}</td><td class="num pc-chg">${e.to > e.from ? UP_ICON : DOWN_ICON}${pctText(e.pct)}</td></tr>`).join('');
  return `<details class="pc-all" id="pcAll"><summary><span>Visa alla ${nf.format(list.length)} prisändringar</span></summary>
    <div class="pc-filter">
      <input type="search" id="pcSearch" placeholder="Sök dryck…" aria-label="Sök bland prisändringarna">
      <div class="pc-chips" role="group" aria-label="Kategori"><button type="button" class="pc-chip active" data-c="">Alla</button>${cats.map((c) => `<button type="button" class="pc-chip" data-c="${esc(c)}">${esc(c)}</button>`).join('')}</div>
      <span class="pc-count" id="pcCount" aria-live="polite"></span>
    </div>
    <div class="pc-table-wrap"><table class="pc-table">
    <thead><tr><th scope="col">Dryck</th><th scope="col">Typ</th><th scope="col">Före, kr</th><th scope="col">Efter, kr</th><th scope="col">Ändring</th></tr></thead>
    <tbody id="pcRows">${rows}</tbody></table></div>
    <p class="pc-none" id="pcNone" hidden>Inga prisändringar matchar.</p></details>
<script>(function(){
  var rows=[].slice.call(document.querySelectorAll('#pcRows tr')),q=document.getElementById('pcSearch'),chips=[].slice.call(document.querySelectorAll('.pc-chip')),count=document.getElementById('pcCount'),none=document.getElementById('pcNone'),cat='';
  function apply(){var t=q.value.trim().toLowerCase(),n=0;rows.forEach(function(r){var ok=(!cat||r.getAttribute('data-c')===cat)&&(!t||r.getAttribute('data-n').indexOf(t)>-1);r.hidden=!ok;if(ok)n++;});count.textContent=n+' st';none.hidden=n>0;}
  q.addEventListener('input',apply);
  chips.forEach(function(c){c.addEventListener('click',function(){cat=c.getAttribute('data-c');chips.forEach(function(x){x.classList.toggle('active',x===c);});apply();});});
  apply();
})();</script>`;
}

const EXTRA_CSS = `
.pc-lead{margin-top:1.25rem}
.pc-ico{width:.6rem;height:.6rem;flex-shrink:0;margin-right:.3rem;vertical-align:baseline}
.pc-ico.up{fill:#FF8A6B}
.pc-ico.down{fill:#8FE3B0}
.pc-bar{display:flex;gap:2px;height:.6rem}
.pc-bar span{min-width:4px}
.pc-bar .up{background:#FF8A6B}
.pc-bar .down{background:#8FE3B0}
.pc-bar span:first-child{border-radius:9999px 0 0 9999px}
.pc-bar span:last-child{border-radius:0 9999px 9999px 0}
.pc-bar span:only-child{border-radius:9999px}
.pc-legend{display:flex;flex-wrap:wrap;gap:.25rem 1.25rem;font-size:.85rem;color:var(--cream);margin-top:.6rem}
.pc-legend strong{font-weight:800}
.pc-hero{background:var(--bg-dark);border:1px solid var(--line);border-radius:1.5rem;padding:1.5rem;margin:2rem 0 0}
.pc-hero-top{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:.25rem 1rem;margin-bottom:1.25rem}
.pc-hero-title{font-size:.75rem;letter-spacing:.2em;text-transform:uppercase;font-weight:700;color:var(--muted)}
.pc-hero-month{font-size:1.1rem;font-weight:800;color:var(--accent)}
.pc-duo{display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:1rem}
.pc-duo>div:last-child{text-align:right}
.pc-big{font-size:clamp(2.5rem,11vw,4.5rem);font-weight:800;line-height:.95;letter-spacing:-.04em;color:var(--cream)}
.pc-big-l{font-size:.9rem;font-weight:600;color:var(--cream);margin-top:.4rem}
.pc-hero .pc-bar{height:.85rem}
.pc-hero-note{font-size:.9rem;color:var(--muted);margin:.85rem 0 0}
.pc-facts{display:grid;grid-template-columns:1fr;gap:.75rem;margin-top:.75rem}
@media(min-width:640px){.pc-facts{grid-template-columns:repeat(3,1fr)}}
.pc-fact{background:var(--bg-light);border-radius:1rem;padding:.9rem 1.1rem}
.pc-fact.next{background:var(--accent)}
.pc-fact.next .stat-label,.pc-fact.next .pc-fact-v{color:var(--bg-dark)}
.pc-fact-v{font-size:1.25rem;font-weight:800;color:var(--cream);margin-top:.2rem;letter-spacing:-.01em}
.pc-cats{display:grid;grid-template-columns:1fr;gap:.75rem}
@media(min-width:700px){.pc-cats{grid-template-columns:repeat(auto-fit,minmax(15rem,1fr))}}
.pc-cat{background:var(--bg-light);border-radius:1.1rem;padding:1.1rem 1.2rem}
.pc-cat-head{display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;margin-bottom:.9rem}
.pc-cat-name{font-size:1.25rem;font-weight:800;color:var(--accent);letter-spacing:-.01em}
.pc-cat-sub{font-size:.8rem;color:var(--muted);margin-top:.1rem}
.pc-cat-avg{text-align:right;flex-shrink:0}
.pc-cat-avg-v{font-size:1.25rem;font-weight:800;color:var(--cream);white-space:nowrap}
.pc-cat-avg-l{font-size:.65rem;letter-spacing:.15em;text-transform:uppercase;font-weight:600;color:var(--muted)}
.pc-cols{display:grid;grid-template-columns:minmax(0,1fr);gap:0 1.5rem}
@media(min-width:900px){.pc-cols{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}}
.pc-cols h2{display:flex;align-items:center}
.pc-cols h2 .pc-ico{width:.8rem;height:.8rem;margin-right:.5rem}
.pc-list{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:.4rem}
.pc-row{display:grid;grid-template-columns:1.4rem 2.5rem minmax(0,1fr) auto;gap:.7rem;align-items:center;background:var(--bg-light);border-radius:.9rem;padding:.55rem .9rem .55rem .7rem;text-decoration:none;color:var(--cream);border:1.5px solid transparent}
.pc-row:hover{border-color:var(--accent)}
.pc-rank{font-size:.8rem;font-weight:700;color:var(--muted);text-align:right}
.pc-thumb{width:2.5rem;height:2.5rem;display:flex;align-items:center;justify-content:center}
.pc-thumb img{max-width:100%;max-height:100%;object-fit:contain}
.pc-text{min-width:0}
.pc-name,.pc-meta{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media(max-width:520px){.pc-row{grid-template-columns:1.1rem 2rem minmax(0,1fr) auto;gap:.5rem}.pc-thumb{width:2rem;height:2rem}.pc-name{white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;line-height:1.2;font-size:.92rem}}
.pc-name{font-weight:700}
.pc-meta{font-size:.78rem;color:var(--muted)}
.pc-nums{text-align:right;white-space:nowrap}
.pc-pct{display:block;font-weight:800;font-size:1rem}
.pc-price{display:block;font-size:.78rem;color:var(--muted)}
.pc-price strong{color:var(--cream)}
.pc-all{margin-top:1.5rem}
.pc-all summary{list-style:none;cursor:pointer}
.pc-all summary::-webkit-details-marker{display:none}
.pc-all summary span{display:inline-flex;align-items:center;gap:.5rem;font-weight:700;font-size:.9rem;color:var(--cream);padding:.7rem 1.2rem;border-radius:9999px;border:1.5px solid rgba(244,211,94,.25)}
.pc-all summary span::after{content:'';width:.45rem;height:.45rem;border-right:2px solid currentColor;border-bottom:2px solid currentColor;transform:rotate(45deg) translateY(-2px)}
.pc-all[open] summary span::after{transform:rotate(-135deg) translateY(-2px)}
.pc-all summary:hover span{border-color:var(--accent);color:var(--accent)}
.pc-filter{display:flex;flex-wrap:wrap;align-items:center;gap:.6rem;margin:1rem 0 .75rem}
.pc-filter input{flex:1 1 12rem;min-width:0;max-width:20rem;background:var(--bg-light);border:1.5px solid transparent;border-radius:9999px;padding:.55rem 1rem;color:var(--cream);font:inherit;font-size:.9rem}
.pc-filter input::placeholder{color:var(--muted);opacity:.8}
.pc-filter input:focus{outline:none;border-color:var(--accent)}
.pc-chips{display:flex;flex-wrap:wrap;gap:.35rem}
.pc-chip{font:inherit;font-size:.8rem;font-weight:600;color:var(--cream);background:transparent;border:1.5px solid rgba(244,211,94,.2);border-radius:9999px;padding:.4rem .8rem;cursor:pointer}
.pc-chip:hover{border-color:var(--accent)}
.pc-chip.active{background:var(--accent);border-color:var(--accent);color:var(--bg-dark)}
.pc-count{font-size:.8rem;color:var(--muted)}
.pc-none{color:var(--muted)}
.pc-table-wrap{overflow-x:auto}
.pc-table{width:100%;border-collapse:collapse;font-size:.85rem}
.pc-table th,.pc-table td{padding:.45rem .6rem;border-bottom:1px solid var(--line);text-align:right}
.pc-table th:first-child,.pc-table td:first-child,.pc-table th:nth-child(2),.pc-table td:nth-child(2){text-align:left}
.pc-table thead th{font-size:.7rem;letter-spacing:.15em;text-transform:uppercase;color:var(--muted);font-weight:600;white-space:nowrap}
.pc-table td a{color:var(--cream);text-decoration:none;font-weight:600}
.pc-table td a:hover{color:var(--accent)}
.pc-table small{color:var(--muted)}
.pc-chg{white-space:nowrap;font-weight:700}
.pc-rounds{display:flex;flex-direction:column;gap:.6rem;max-width:42rem}
.pc-round{background:var(--bg-light);border-radius:1rem;padding:.9rem 1.1rem}
.pc-round-name{font-weight:800;color:var(--accent);margin-bottom:.6rem}
.pc-round-avg{margin-left:auto;color:var(--muted)}
.pc-round-avg strong{color:var(--cream)}
.pc-about{font-size:.95rem}
`;

function render() {
  const latest = ROUNDS[0];
  const since = HISTORY.since || (HISTORY.checks || [])[0];
  const checks = (HISTORY.checks || []).length;
  const sinceText = since ? monthText(since) : '';
  const source = '<a href="https://www.systembolaget.se/kundservice/sortiment/a5376eb1-c12e-42eb-ac6c-1891428b2e1f/nar-och-hur-ofta-andras-priserna-i-systembolagets-sortiment/5f976abb-2d1b-4756-98ea-506aa6de3a89/" target="_blank" rel="noopener">enligt Systembolaget</a>';
  const next = nextWindow(LAST_CHECK);
  const facts = (avg) => `<div class="pc-facts">
  ${avg !== null ? `<div class="pc-fact"><div class="stat-label">Snittändring</div><div class="pc-fact-v num">${pctText(avg)}</div></div>` : ''}
  <div class="pc-fact"><div class="stat-label">Senast kollat</div><div class="pc-fact-v num">${LAST_CHECK ? esc(dateText(LAST_CHECK)) : '–'}</div></div>
  <div class="pc-fact next"><div class="stat-label">Nästa prisändring</div><div class="pc-fact-v">${esc(next.charAt(0).toUpperCase() + next.slice(1))}</div></div>
</div>`;

  let body = `
<nav class="crumbs" aria-label="Brödsmulor"><a href="/">Topplistan</a><span>›</span><span>Prisändringar</span></nav>
<p class="eyebrow">Prisbevakning</p>
<h1>Prisändringar på Systembolaget</h1>
<div class="prose pc-lead">
  <p>Vi kollar priset på varje dryck i Systembolagets fasta sortiment varje vecka${sinceText ? `, sedan ${esc(sinceText)}` : ''}. Leverantörerna får ändra priserna två gånger om året, i mars och september (${source}).</p>
</div>`;

  if (!latest) {
    body += `<p class="prose">Vi har inte sett någon större prisändring ännu.</p>${facts(null)}`;
  } else {
    const ups = latest.list.filter((e) => e.to > e.from).sort((a, b) => b.pct - a.pct || (b.to - b.from) - (a.to - a.from)).slice(0, TOP_N);
    const downs = latest.list.filter((e) => e.to < e.from).sort((a, b) => a.pct - b.pct || (a.to - a.from) - (b.to - b.from)).slice(0, TOP_N);
    const month = monthText(latest.month);
    body += `
<section class="pc-hero" aria-label="Senaste prisändringen">
  <div class="pc-hero-top"><span class="pc-hero-title">Senaste prisändringen</span><span class="pc-hero-month">${esc(month.charAt(0).toUpperCase() + month.slice(1))}</span></div>
  <div class="pc-duo">
    <div><div class="pc-big num">${nf.format(latest.up)}</div><div class="pc-big-l">${UP_ICON}blev dyrare</div></div>
    <div><div class="pc-big num">${nf.format(latest.down)}</div><div class="pc-big-l">${DOWN_ICON}blev billigare</div></div>
  </div>
  ${splitBar(latest.up, latest.down)}
  <p class="pc-hero-note">${nf.format(latest.list.length)} av ${nf.format(PRODUCTS.length)} drycker fick nytt pris (${shareText(latest.list.length, PRODUCTS.length)}).</p>
</section>
${facts(latest.avg)}
<h2>Per kategori</h2>
${categoryCards(latest.list)}
<div class="pc-cols">
  <div>${ups.length ? `<h2>${UP_ICON}Största höjningarna</h2><ol class="pc-list">${ups.map(changeRow).join('')}</ol>` : ''}</div>
  <div>${downs.length ? `<h2>${DOWN_ICON}Största sänkningarna</h2><ol class="pc-list">${downs.map(changeRow).join('')}</ol>` : ''}</div>
</div>
${allChangesList(latest.list)}`;
    if (ROUNDS.length > 1) {
      body += `<h2>Alla prisändringar vi sett</h2>${roundsList()}`;
    }
  }

  body += `
<h2>Om siffrorna</h2>
<div class="prose pc-about">
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
