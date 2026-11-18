// api/prisandringar.js — /prisandringar: vad som blivit dyrare och billigare
// på Systembolaget, räknat från vår veckovisa prishistorik.
//
// Sidan byggs från price-history.json (skrivs av scripts/update-data.py varje
// vecka) och search-data.json. Den uppdaterar sig alltså själv: när
// veckokörningen upptäcker nya priser syns de här efter nästa deploy, utan
// att någon behöver göra något. All text och alla siffror på sidan räknas
// fram här – inget är skrivet för hand för en viss månad.
//
// vercel.json skriver om /prisandringar → /api/prisandringar. Samma funktion
// svarar också med sidans underlag i andra format:
//   /api/prisandringar?format=json  alla drycker (till "Hela hyllan" och sökningen)
//   /api/prisandringar?format=csv   alla prisändringar i senaste omgången
//   /api/prisandringar?format=png   delningsbilden (og:image)

const zlib = require('zlib');
const D = require('./dryck');
const { page, esc, kr, nf, volumeShort, dateText, monthText, pctText, productPath, PRODUCTS, HISTORY, LAST_CHECK, SITE } = D;

const URL = SITE + '/prisandringar';
// En månad räknas som en "prisändringsomgång" om minst så här många drycker
// fick nytt pris. Enstaka ändringar mellan omgångarna visas inte som omgång.
const ROUND_MIN = 25;
const TOP_N = 10;
// Ändringar på minst så här många procent får den ljusare färgen i hyllan.
const BIG_PCT = 5;
// Samma ordning som flikarna på startsidan.
const CATEGORY_ORDER = ['Vin', 'Öl', 'Sprit', 'Cider'];
const catIndex = (c) => { const i = CATEGORY_ORDER.indexOf(c); return i < 0 ? 99 : i; };
const catOf = (p) => p.category || 'Övrigt';

// Färgerna för dyrare/billigare. Korall mot blått (inte rött mot grönt) för
// att paren ska gå att skilja åt även med röd-grön färgblindhet; alla par är
// kontrollerade mot varandra och mot bakgrunden (se README).
const COLORS = { up: '#FE8D6F', upLo: '#B45244', dn: '#5ACDF9', dnLo: '#2C7FB1', flat: '#384640', paper: '#FBF6E1', ink: '#10261F' };

// ---------- Prishistorik ----------
const HP = HISTORY.products || {};
const CHECKS = HISTORY.checks || [];

function points(p) {
  const h = HP[String(p.id)];
  return h && h.p && h.p.length ? h.p : null;
}
function firstSeen(p) {
  const h = points(p);
  return h ? h[0][0] : null;
}
// Priset som gällde precis före datumet iso. null om vi inte följde drycken då.
function priceBefore(p, iso) {
  const h = points(p);
  if (!h || h[0][0] >= iso) return null;
  let price = h[0][1];
  for (let i = 1; i < h.length && h[i][0] < iso; i++) price = h[i][1];
  return price;
}
function nextMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}
function median(values) {
  if (!values.length) return 0;
  const s = values.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const round2 = (n) => Math.round(n * 100) / 100;

// ---------- En prisändringsomgång ----------
// Allt räknas på de drycker vi hade ett pris på FÖRE månaden ("följda").
// Drycker som kommit in i sortimentet (eller i vår bevakning) senare har
// inget före-pris och räknas varken som ändrade eller oförändrade – de är
// "nya" och visas som tomma rutor i hyllan.
function buildRound(month) {
  const start = month + '-01';
  const end = nextMonth(month) + '-01';
  const r = { month, start, list: [], up: 0, down: 0, tracked: 0, fresh: 0, before: 0, after: 0, state: new Map(), cats: new Map() };
  for (const p of PRODUCTS) {
    const name = catOf(p);
    let c = r.cats.get(name);
    if (!c) { c = { name, total: 0, tracked: 0, fresh: 0, up: 0, down: 0, before: 0, after: 0, since: null }; r.cats.set(name, c); }
    c.total++;
    const before = priceBefore(p, start);
    if (before === null) {
      const since = firstSeen(p);
      r.fresh++; c.fresh++;
      if (since && (!c.since || since < c.since)) c.since = since;
      r.state.set(p.id, { k: 'n', since });
      continue;
    }
    // Priset vid månadens slut: fångar även en dryck som ändrats två gånger.
    const after = priceBefore(p, end);
    r.tracked++; c.tracked++;
    r.before += before; c.before += before;
    r.after += after; c.after += after;
    if (after === before) { r.state.set(p.id, { k: 'z' }); continue; }
    const e = { p, from: before, to: after, diff: round2(after - before), pct: (after / before - 1) * 100 };
    r.list.push(e);
    if (after > before) { r.up++; c.up++; } else { r.down++; c.down++; }
    r.state.set(p.id, { k: after > before ? 'u' : 'd', from: before, to: after, pct: e.pct });
  }
  r.n = r.list.length;
  r.unchanged = r.tracked - r.n;
  r.catList = [...r.cats.values()].sort((a, b) => catIndex(a.name) - catIndex(b.name) || a.name.localeCompare(b.name, 'sv'));
  // "En av varje": summan av alla följda dryckers pris. Avrundas per kategori
  // så att kvittots rader alltid summerar exakt till skillnaden.
  for (const c of r.catList) { c.unchanged = c.tracked - c.up - c.down; c.net = Math.round(c.after - c.before); }
  r.beforeR = Math.round(r.before);
  r.net = r.catList.reduce((s, c) => s + c.net, 0);
  r.afterR = r.beforeR + r.net;
  const ups = r.list.filter((e) => e.diff > 0), downs = r.list.filter((e) => e.diff < 0);
  r.med = {
    upKr: median(ups.map((e) => e.diff)), downKr: median(downs.map((e) => -e.diff)),
    upPct: median(ups.map((e) => e.pct)), downPct: median(downs.map((e) => e.pct)),
  };
  return r;
}

const MONTHS = [];
if (CHECKS.length) {
  const last = CHECKS[CHECKS.length - 1].slice(0, 7);
  for (let m = CHECKS[0].slice(0, 7); m <= last; m = nextMonth(m)) MONTHS.push(m);
}
const ROUNDS = MONTHS.map(buildRound).filter((r) => r.n >= ROUND_MIN).reverse();
const LATEST = ROUNDS[0] || null;

// Prisändringar utanför omgångarna (för "mellan omgångarna står priserna stilla").
const ROUND_MONTHS = new Set(ROUNDS.map((r) => r.month));
let OUTSIDE = 0;
for (const p of PRODUCTS) {
  const h = points(p);
  if (h) for (let i = 1; i < h.length; i++) if (!ROUND_MONTHS.has(h[i][0].slice(0, 7))) OUTSIDE++;
}

// Nästa tillfälle då leverantörerna får ändra priserna i fasta sortimentet
// (mars och september enligt Systembolaget).
function nextWindow(iso) {
  const [y, m] = String(iso || new Date().toISOString()).split('-').map(Number);
  if (m < 3) return `mars ${y}`;
  if (m < 9) return `september ${y}`;
  return `mars ${y + 1}`;
}

// ---------- APK-listan före och efter ----------
// Placering i kategorin med priserna som gällde före omgången, för samma
// drycker som finns i dag. Jämförs med dagens placering (p.rank), så att
// "plats 892 → 25" stämmer med det som står på dryckens egen sida.
function apkAt(p, price) {
  return price > 0 ? (p.volume * p.alcohol / 100) / price : 0;
}
function ranksBefore(r) {
  const groups = new Map();
  for (const p of PRODUCTS) {
    const s = r.state.get(p.id);
    const price = s.k === 'n' ? p.price : (s.from !== undefined ? s.from : priceBefore(p, r.start));
    const c = catOf(p);
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push({ p, apk: apkAt(p, price) });
  }
  const map = new Map();
  for (const list of groups.values()) {
    list.sort((a, b) => b.apk - a.apk || a.p.rank - b.p.rank);
    list.forEach((x, i) => map.set(x.p.id, i + 1));
  }
  return map;
}

function analyse(r) {
  const rb = ranksBefore(r);
  // Klättrare: prissänkta drycker som nu ligger i bästa fjärdedelen i sin
  // kategori, sorterade efter hur stor del av listan de klättrat förbi.
  const climbers = r.list
    .filter((e) => e.diff < 0)
    .map((e) => ({ ...e, before: rb.get(e.p.id), now: e.p.rank, total: e.p.categoryTotal }))
    .filter((e) => e.before && e.now && e.total && e.now / e.total <= 0.25 && e.before - e.now >= 5)
    .sort((a, b) => (b.before - b.now) / b.total - (a.before - a.now) / a.total)
    .slice(0, 6);
  // Topp 20 i varje kategori: vilka kom in och vilka åkte ut?
  const top = [];
  for (const c of r.catList) {
    if (!c.tracked) continue;
    const ps = PRODUCTS.filter((p) => catOf(p) === c.name);
    const wasTop = ps.filter((p) => rb.get(p.id) <= 20);
    top.push({
      name: c.name,
      entered: ps.filter((p) => p.rank <= 20 && rb.get(p.id) > 20).sort((a, b) => a.rank - b.rank),
      left: wasTop.filter((p) => p.rank > 20).sort((a, b) => rb.get(a.id) - rb.get(b.id)),
      changed: wasTop.filter((p) => { const k = r.state.get(p.id).k; return k === 'u' || k === 'd'; }).length,
    });
  }
  // Dryckestyper: var fick störst andel nytt pris?
  const subs = new Map();
  for (const p of PRODUCTS) {
    const s = r.state.get(p.id);
    if (s.k === 'n') continue;
    const key = p.subcategory || catOf(p);
    let g = subs.get(key);
    if (!g) { g = { name: key, tracked: 0, up: 0, down: 0 }; subs.set(key, g); }
    g.tracked++;
    if (s.k === 'u') g.up++; else if (s.k === 'd') g.down++;
  }
  const subList = [...subs.values()].filter((g) => g.tracked >= 20).map((g) => ({ ...g, share: (g.up + g.down) / g.tracked })).sort((a, b) => b.share - a.share);
  // Vanligaste ändringen i kronor.
  const steps = new Map();
  for (const e of r.list) steps.set(e.diff, (steps.get(e.diff) || 0) + 1);
  const step = [...steps.entries()].sort((a, b) => b[1] - a[1] || Math.abs(a[0]) - Math.abs(b[0]))[0] || null;
  return { rb, climbers, top, subList, step };
}
const INFO = LATEST ? analyse(LATEST) : null;

// ---------- Hyllan: en ruta per dryck ----------
// Grundordningen i varje kategori: dyrare (största höjningen först),
// oförändrade, billigare (största sänkningen sist) och till sist nya.
function shelfBlocks(r) {
  return r.catList.map((c) => {
    const ps = PRODUCTS.filter((p) => catOf(p) === c.name);
    const st = (p) => r.state.get(p.id);
    const of = (k) => ps.filter((p) => st(p).k === k);
    const byChange = (a, b) => st(b).pct - st(a).pct || a.rank - b.rank;
    const byRank = (a, b) => a.rank - b.rank;
    return { cat: c, items: [...of('u').sort(byChange), ...of('z').sort(byRank), ...of('d').sort(byChange), ...of('n').sort(byRank)] };
  });
}
function squareClass(s) {
  if (s.k === 'n') return 'n';
  if (s.k === 'z') return '';
  return (s.k === 'u' ? 'u' : 'd') + (Math.abs(s.pct) >= BIG_PCT ? '2' : '1');
}
const SHELF = LATEST ? shelfBlocks(LATEST) : [];

// Underlaget till hyllan och sökningen, i samma ordning som rutorna ritas.
// Rad: [id, namn, kategori, typ, volym, pris nu, APK, placering, pris före, pris efter, följs sedan, placering före]
function buildJson(r) {
  const subs = [];
  const subIdx = new Map();
  const rows = [];
  SHELF.forEach((blk, ci) => blk.items.forEach((p) => {
    const s = r.state.get(p.id);
    const sub = p.subcategory || catOf(p);
    if (!subIdx.has(sub)) { subIdx.set(sub, subs.length); subs.push(sub); }
    const row = [String(p.id), p.name, ci, subIdx.get(sub), p.volume, p.price, round2(p.apk), p.rank];
    if (s.k === 'u' || s.k === 'd') row.push(s.from, s.to, '', INFO.rb.get(p.id) || 0);
    else if (s.k === 'n') row.push(0, 0, s.since || '');
    rows.push(row);
  }));
  return JSON.stringify({ month: r.month, big: BIG_PCT, cats: SHELF.map((b) => [b.cat.name, b.cat.total]), subs, p: rows });
}

function sortedChanges(r) {
  return r.list.slice().sort((a, b) =>
    catIndex(catOf(a.p)) - catIndex(catOf(b.p)) || b.pct - a.pct || String(a.p.name).localeCompare(String(b.p.name), 'sv'));
}

// Semikolon och decimalkomma: öppnas rätt i svensk Excel.
function buildCsv(r) {
  const q = (s) => `"${String(s == null ? '' : s).replace(/"/g, '""')}"`;
  const num = (n) => String(n).replace('.', ',');
  const lines = ['artikelnummer;namn;kategori;typ;volym_ml;pris_fore_kr;pris_efter_kr;andring_kr;andring_procent;url'];
  for (const e of sortedChanges(r)) {
    lines.push([e.p.id, q(e.p.name), q(catOf(e.p)), q(e.p.subcategory || ''), e.p.volume, num(e.from), num(e.to), num(e.diff), num(Math.round(e.pct * 10) / 10), SITE + productPath(e.p)].join(';'));
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}

// ---------- Små hjälpare för texten ----------
const UP_ICON = '<svg class="pc-ico up" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 2l5 8H1z"/></svg>';
const DOWN_ICON = '<svg class="pc-ico down" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 10L1 2h10z"/></svg>';
const WORDS = ['noll', 'ett', 'två', 'tre', 'fyra', 'fem', 'sex', 'sju', 'åtta', 'nio', 'tio', 'elva', 'tolv'];
const numWord = (n) => (n >= 0 && n < WORDS.length ? WORDS[n] : nf.format(n));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const signedKr = (n) => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${kr(Math.abs(n))} kr`;
const kronor = (n) => (Math.abs(n) === 1 ? 'krona' : 'kronor');
const link = (p) => `<a href="${esc(productPath(p))}">${esc(p.name)}</a>`;
function joinAnd(parts) {
  if (parts.length <= 1) return parts.join('');
  return parts.slice(0, -1).join(', ') + ' och ' + parts[parts.length - 1];
}
function shareText(n, total) {
  if (!total) return '';
  const pct = (n / total) * 100;
  return pct > 0 && pct < 1 ? 'under 1 %' : `${Math.round(pct)} %`;
}
const SOURCE_URL = 'https://www.systembolaget.se/kundservice/sortiment/a5376eb1-c12e-42eb-ac6c-1891428b2e1f/nar-och-hur-ofta-andras-priserna-i-systembolagets-sortiment/5f976abb-2d1b-4756-98ea-506aa6de3a89/';

// ---------- Ingressen ----------
// Två meningar som skrivs om av sig själva för varje omgång.
function ledeHtml(r) {
  const a = `${nf.format(Math.abs(r.net))} ${kronor(r.net)}`;
  const s1 = `I ${esc(monthText(r.month))} blev <strong>${nf.format(r.up)} ${r.up === 1 ? 'dryck' : 'drycker'} dyrare</strong> och <strong>${nf.format(r.down)} billigare</strong>.`;
  let s2;
  if (r.net === 0) s2 = 'Köper du en av varje kostar det ändå precis lika mycket som förut.';
  else if (r.net < 0 && r.up > r.down) s2 = `Köper du en av varje blir det ändå <strong>${a} billigare</strong> än förut${r.med.downKr > r.med.upKr ? ', för sänkningarna var färre men större' : ''}.`;
  else if (r.net > 0 && r.down > r.up) s2 = `Köper du en av varje blir det ändå <strong>${a} dyrare</strong> än förut${r.med.upKr > r.med.downKr ? ', för höjningarna var färre men större' : ''}.`;
  else s2 = `Köper du en av varje blir det <strong>${a} ${r.net > 0 ? 'dyrare' : 'billigare'}</strong> än förut.`;
  return `${s1} ${s2}`;
}
function ledeText(r) {
  return ledeHtml(r).replace(/<[^>]+>/g, '');
}

// ---------- Kvittot: "en av varje" ----------
// Sågtandad nederkant, som ett avrivet kvitto.
function tornEdge(teeth, depth) {
  const pts = ['0 0', '100% 0', `100% calc(100% - ${depth}px)`];
  for (let i = teeth * 2 - 1; i >= 1; i--) {
    pts.push(`${((i / (teeth * 2)) * 100).toFixed(2)}% ${i % 2 ? '100%' : `calc(100% - ${depth}px)`}`);
  }
  pts.push(`0 calc(100% - ${depth}px)`);
  return `polygon(${pts.join(',')})`;
}
function receiptHtml(r) {
  const rows = r.catList.filter((c) => c.tracked).map((c) => `
      <div class="rc-row rc-cat"><span>${esc(c.name)}</span><span class="rc-cnt">${UP_ICON}${nf.format(c.up)} ${DOWN_ICON}${nf.format(c.down)}</span><span class="rc-amt">${signedKr(c.net)}</span></div>`).join('');
  const label = `Kvitto för en av varje dryck: ${nf.format(r.beforeR)} kronor före prisändringen, ${nf.format(r.afterR)} kronor efter.`;
  return `<aside class="rc-wrap" aria-label="${esc(label)}">
  <div class="rc-slot" aria-hidden="true"></div>
  <div class="rc-feed"><div class="rc-anim"><div class="rc-tilt"><div class="rc" style="clip-path:${tornEdge(21, 7)}">
    <p class="rc-shop">apkguiden.se</p>
    <p class="rc-title">En av varje</p>
    <p class="rc-note">${nf.format(r.tracked)} drycker i fasta sortimentet</p>
    <div class="rc-rule"></div>
    <div class="rc-row"><span>Före prisändringen</span><span class="rc-amt">${nf.format(r.beforeR)} kr</span></div>
    <div class="rc-cats">
      <div class="rc-row rc-head"><span></span><span class="rc-cnt">${UP_ICON}dyrare ${DOWN_ICON}billigare</span><span></span></div>${rows}
    </div>
    <div class="rc-rule"></div>
    <div class="rc-row"><span>Efter prisändringen</span><span class="rc-amt">${nf.format(r.afterR)} kr</span></div>
    <div class="rc-rule"></div>
    <div class="rc-row rc-total"><span>Skillnad</span><span class="rc-amt">${signedKr(r.net)}</span></div>
    <div class="rc-rule"></div>
    <p class="rc-foot">${LAST_CHECK ? `Priserna kollade ${esc(dateText(LAST_CHECK))}.<br>` : ''}${r.fresh ? `${nf.format(r.fresh)} nyare drycker är inte med.<br>` : ''}Nästa prisändring: ${esc(nextWindow(LAST_CHECK))}.<br>Välkommen åter!</p>
  </div></div></div></div>
</aside>`;
}

// ---------- Hela hyllan ----------
function shelfHtml(r) {
  const cats = SHELF.map((blk) => {
    const c = blk.cat;
    const squares = blk.items.map((p) => { const k = squareClass(r.state.get(p.id)); return k ? `<i class="${k}"></i>` : '<i></i>'; }).join('');
    const rest = [];
    if (c.unchanged) rest.push(`${nf.format(c.unchanged)} oförändrade`);
    if (c.fresh) rest.push(`${nf.format(c.fresh)} nya`);
    const nums = c.tracked
      ? `<span>${UP_ICON}${nf.format(c.up)} dyrare</span><span>${DOWN_ICON}${nf.format(c.down)} billigare</span>${rest.length ? `<span class="sh-mute">${rest.join(', ')}</span>` : ''}`
      : `<span class="sh-mute">Följs sedan ${esc(dateText(c.since || LAST_CHECK))}, så den här prisändringen syns inte här.</span>`;
    const aria = c.tracked
      ? `${c.name}: ${nf.format(c.up)} dyrare, ${nf.format(c.down)} billigare, ${nf.format(c.unchanged)} oförändrade${c.fresh ? ` och ${nf.format(c.fresh)} nya` : ''}.`
      : `${c.name}: ${nf.format(c.total)} drycker som vi började följa efter prisändringen.`;
    return `<div class="sh-cat">
      <div class="sh-cat-head"><h3>${esc(c.name)}</h3><p>${nums}</p></div>
      <div class="sh-grid" role="img" aria-label="${esc(aria)}">${squares}</div>
    </div>`;
  }).join('');
  return `<section class="sh" id="hyllan" data-src="/api/prisandringar?format=json">
  <h2>Hela hyllan</h2>
  <p class="sh-intro">Varje ruta är en dryck i fasta sortimentet, ${nf.format(PRODUCTS.length)} stycken. Peka eller tryck på en ruta för att se vilken.</p>
  <div class="sh-tools" id="shTools" hidden>
    <input type="search" id="shQ" class="sh-q" placeholder="Sök din dryck" autocomplete="off" spellcheck="false" aria-label="Sök en dryck i hyllan">
    <div class="sh-sort" role="group" aria-label="Ordna rutorna efter">
      <span class="sh-sort-l">Ordna efter</span>
      <button type="button" data-sort="chg" class="active" aria-pressed="true">Prisändring</button><button type="button" data-sort="price" aria-pressed="false">Lägst pris</button><button type="button" data-sort="apk" aria-pressed="false">Bäst APK</button>
    </div>
  </div>
  <ul class="sh-hits" id="shHits" hidden></ul>
  <p class="sh-msg" id="shMsg" role="status" hidden></p>
  <ul class="sh-legend">
    <li><i class="u1"></i><i class="u2"></i>Dyrare</li>
    <li><i class="d1"></i><i class="d2"></i>Billigare</li>
    <li><i></i>Oförändrat</li>
    <li><i class="n"></i>Ny sedan dess</li>
    <li class="sh-mute">Ljusare ruta: minst ${BIG_PCT} %</li>
  </ul>
  <div class="sh-body" id="shBody">${cats}
    <div class="sh-tip" id="shTip" hidden></div>
  </div>
</section>`;
}

// ---------- Det här sticker ut ----------
// Varje fynd räknas fram ur omgången och visas bara om det håller.
function insightsHtml(r) {
  const out = [];
  const ups = r.list.filter((e) => e.diff > 0);
  // 1. Vanligaste ändringen i kronor.
  if (INFO.step && INFO.step[1] >= 10 && INFO.step[1] >= r.n * 0.05) {
    const [diff, count] = INFO.step;
    let extra = '';
    if (ups.length >= 10) {
      const limit = [1, 2, 5, 10, 20, 50].find((t) => ups.filter((e) => e.diff <= t).length >= ups.length / 2);
      if (limit) extra = ` ${nf.format(ups.filter((e) => e.diff <= limit).length)} av ${nf.format(ups.length)} höjningar var på högst ${limit} kr.`;
    }
    out.push({ title: `Vanligaste ändringen: ${signedKr(diff)}`, text: `${nf.format(count)} drycker fick exakt den ändringen.${extra}` });
  }
  // 2. Höjningar mot sänkningar.
  if (r.up >= 5 && r.down >= 5) {
    const m = r.med;
    let title = 'Så stora var ändringarna';
    if (m.downKr >= m.upKr * 1.5 && r.down < r.up) title = 'Sänkningarna var färre men större';
    else if (m.upKr >= m.downKr * 1.5 && r.up < r.down) title = 'Höjningarna var färre men större';
    out.push({ title, text: `En typisk sänkning var på ${kr(round2(m.downKr))} kr (${pctText(m.downPct)}), en typisk höjning på ${kr(round2(m.upKr))} kr (${pctText(m.upPct)}).` });
  }
  // 3. Dryckestypen där störst andel fick nytt pris.
  const top = INFO.subList[0];
  const overall = r.tracked ? r.n / r.tracked : 0;
  if (top && top.share >= overall * 1.5 && top.up + top.down >= 8) {
    out.push({
      title: `Mest berört: ${top.name.toLowerCase()}`,
      text: `${nf.format(top.up + top.down)} av ${nf.format(top.tracked)} fick nytt pris (${shareText(top.up + top.down, top.tracked)}): ${nf.format(top.up)} dyrare och ${nf.format(top.down)} billigare. I hela sortimentet var andelen ${shareText(r.n, r.tracked)}.`,
    });
  }
  // 4. Topp 20 på APK-listorna.
  if (INFO.top.length) {
    const swaps = INFO.top.reduce((s, t) => s + t.entered.length, 0);
    const parts = INFO.top.map((t) => {
      if (!t.entered.length && !t.left.length) return `${esc(t.name)}: samma topp 20 som förut${t.changed ? `, fast ${numWord(t.changed)} av dem fick nytt pris` : ''}.`;
      const bits = [];
      if (t.entered.length) bits.push(`${joinAnd(t.entered.map(link))} tog sig in`);
      if (t.left.length) bits.push(`${joinAnd(t.left.map(link))} åkte ut`);
      return `${esc(t.name)}: ${bits.join(', ')}.`;
    });
    const title = swaps === 0 ? 'Topp 20 på APK-listorna står kvar' : swaps === 1 ? 'Ett byte i topp 20 på APK-listorna' : `${cap(numWord(swaps))} byten i topp 20 på APK-listorna`;
    out.push({ title, text: parts.join(' ') });
  }
  if (!out.length) return '';
  return `<h2>Det här sticker ut</h2>
<div class="pc-finds">${out.map((f) => `<article class="pc-find"><h3>${esc(f.title)}</h3><p>${f.text}</p></article>`).join('')}</div>`;
}

// ---------- Listor ----------
function thumb(p) {
  return p.image ? `<img src="${esc(p.image)}_200.png" alt="" loading="lazy" onerror="this.style.display='none'">` : '';
}
function changeRow(e, i) {
  const p = e.p;
  return `<li><a class="pc-row" href="${esc(productPath(p))}">
    <span class="pc-rank num">${i + 1}</span>
    <span class="pc-thumb">${thumb(p)}</span>
    <span class="pc-text"><span class="pc-name">${esc(p.name)}</span><span class="pc-meta">${esc(p.subcategory || catOf(p))} · ${esc(volumeShort(p.volume))}</span></span>
    <span class="pc-nums"><span class="pc-pct num">${e.diff > 0 ? UP_ICON : DOWN_ICON}${pctText(e.pct)}</span><span class="pc-price num">${kr(e.from)} → <strong>${kr(e.to)} kr</strong></span></span>
  </a></li>`;
}
function climberRow(e) {
  const p = e.p;
  return `<li><a class="pc-row pc-row-climb" href="${esc(productPath(p))}">
    <span class="pc-thumb">${thumb(p)}</span>
    <span class="pc-text"><span class="pc-name">${esc(p.name)}</span><span class="pc-meta">${kr(e.from)} → ${kr(e.to)} kr · ${esc(volumeShort(p.volume))}</span></span>
    <span class="pc-nums"><span class="pc-pct num">${nf.format(e.before)} → ${nf.format(e.now)}</span><span class="pc-price num">av ${nf.format(e.total)} i ${esc(catOf(p).toLowerCase())}</span></span>
  </a></li>`;
}
function climbersHtml() {
  if (INFO.climbers.length < 3) return '';
  return `<h2>Klättrade mest på APK-listan</h2>
<p class="pc-under">Prissänkta drycker som nu ligger i den bästa fjärdedelen i sin kategori. Siffrorna är placeringen före och nu.</p>
<ul class="pc-list pc-list-2">${INFO.climbers.map(climberRow).join('')}</ul>`;
}
function topListsHtml(r) {
  const ups = r.list.filter((e) => e.diff > 0).sort((a, b) => b.pct - a.pct || b.diff - a.diff).slice(0, TOP_N);
  const downs = r.list.filter((e) => e.diff < 0).sort((a, b) => a.pct - b.pct || a.diff - b.diff).slice(0, TOP_N);
  return `<div class="pc-cols">
  <div>${ups.length ? `<h2>${UP_ICON}Största höjningarna</h2><ol class="pc-list">${ups.map(changeRow).join('')}</ol>` : ''}</div>
  <div>${downs.length ? `<h2>${DOWN_ICON}Största sänkningarna</h2><ol class="pc-list">${downs.map(changeRow).join('')}</ol>` : ''}</div>
</div>`;
}

function allChangesHtml(r) {
  const sorted = sortedChanges(r);
  const cats = [...new Set(sorted.map((e) => catOf(e.p)))];
  // Kompakt tabell – kan bli tusentals rader. data-c/data-n används av filtret.
  const rows = sorted.map((e) => `<tr data-c="${esc(catOf(e.p))}" data-n="${esc(String(e.p.name).toLowerCase())}"><td><a href="${esc(productPath(e.p))}">${esc(e.p.name)}</a> <small>${esc(volumeShort(e.p.volume))}</small></td><td>${esc(e.p.subcategory || catOf(e.p))}</td><td class="num">${kr(e.from)}</td><td class="num">${kr(e.to)}</td><td class="num pc-chg">${e.diff > 0 ? UP_ICON : DOWN_ICON}${pctText(e.pct)}</td></tr>`).join('');
  return `<div class="pc-all-bar">
  <details class="pc-all" id="pcAll"><summary><span>Visa alla ${nf.format(r.n)} prisändringar</span></summary>
    <div class="pc-filter">
      <input type="search" id="pcSearch" placeholder="Sök dryck…" aria-label="Sök bland prisändringarna">
      <div class="pc-chips" role="group" aria-label="Kategori"><button type="button" class="pc-chip active" data-c="">Alla</button>${cats.map((c) => `<button type="button" class="pc-chip" data-c="${esc(c)}">${esc(c)}</button>`).join('')}</div>
      <span class="pc-count" id="pcCount" aria-live="polite"></span>
    </div>
    <div class="pc-table-wrap"><table class="pc-table">
    <thead><tr><th scope="col">Dryck</th><th scope="col">Typ</th><th scope="col">Före, kr</th><th scope="col">Efter, kr</th><th scope="col">Ändring</th></tr></thead>
    <tbody id="pcRows">${rows}</tbody></table></div>
    <p class="pc-none" id="pcNone" hidden>Inga prisändringar matchar.</p>
  </details>
  <a class="pc-dl" href="/api/prisandringar?format=csv" download="prisandringar-systembolaget-${esc(r.month)}.csv">Ladda ner som CSV</a>
</div>`;
}

function splitBar(up, down) {
  if (!(up + down)) return '';
  return `<div class="pc-bar" role="img" aria-label="${nf.format(up)} dyrare, ${nf.format(down)} billigare">${up ? `<span class="up" style="flex:${up}"></span>` : ''}${down ? `<span class="down" style="flex:${down}"></span>` : ''}</div>`;
}
function roundsHtml() {
  if (ROUNDS.length < 2) return '';
  return `<h2>Alla prisändringar vi sett</h2>
<div class="pc-rounds">${ROUNDS.map((r) => `<div class="pc-round">
    <div class="pc-round-name">${esc(cap(monthText(r.month)))}</div>
    ${splitBar(r.up, r.down)}
    <div class="pc-legend"><span>${UP_ICON}<strong class="num">${nf.format(r.up)}</strong> dyrare</span><span>${DOWN_ICON}<strong class="num">${nf.format(r.down)}</strong> billigare</span><span class="pc-round-net">en av varje: <strong class="num">${signedKr(r.net)}</strong></span></div>
  </div>`).join('')}</div>`;
}

function aboutHtml(r) {
  const since = HISTORY.since || CHECKS[0];
  return `<h2>Om siffrorna</h2>
<div class="prose pc-about">
  <p>Vi hämtar priset på varje dryck i Systembolagets fasta sortiment varje vecka${since ? `, sedan ${esc(monthText(since))}` : ''}. Ett pris räknas som ändrat när det skiljer sig från förra gången vi såg drycken. Leverantörerna får ändra priserna i mars och september (<a href="${SOURCE_URL}" target="_blank" rel="noopener">enligt Systembolaget</a>)${CHECKS.length ? `, och däremellan står de nästan stilla: på ${nf.format(CHECKS.length)} kontroller har vi sett ${nf.format(OUTSIDE)} ${OUTSIDE === 1 ? 'prisändring' : 'prisändringar'} utanför de månaderna` : ''}.</p>
  <p>Bara drycker som finns i sortimentet i dag räknas. ”En av varje” är summan av priset på de ${nf.format(r.tracked)} av dem som vi hade ett pris på redan före prisändringen.${r.fresh ? ` De ${nf.format(r.fresh)} drycker som kommit in i sortimentet eller i vår bevakning senare är inte med.` : ''} ”Typisk” betyder medianen: hälften av ändringarna var mindre, hälften större.</p>
  <p>Du får gärna använda siffrorna, till exempel i en artikel. Länka då till <a href="/prisandringar">apkguiden.se/prisandringar</a> som källa. Alla prisändringar finns som <a href="/api/prisandringar?format=csv">CSV</a>, och hela underlaget som <a href="/api/prisandringar?format=json">JSON</a>.</p>
</div>`;
}

// ---------- Skript i webbläsaren ----------
// Funktionerna nedan körs inte här på servern: deras källkod skickas med i
// sidan (se render). De får därför bara använda det som finns i webbläsaren.

// Hyllan: etikett när man pekar eller trycker, sökning och omsortering.
function shelfClient() {
  var root = document.getElementById('hyllan');
  if (!root || !window.fetch) return;
  var body = document.getElementById('shBody'), tip = document.getElementById('shTip');
  var tools = document.getElementById('shTools'), input = document.getElementById('shQ');
  var hitsEl = document.getElementById('shHits'), msgEl = document.getElementById('shMsg');
  var grids = [].slice.call(body.querySelectorAll('.sh-grid'));
  var sortBtns = [].slice.call(root.querySelectorAll('[data-sort]'));
  var P = null, cats = [], byCat = [], where = [], big = 5;
  var mode = 'chg', active = null, pinned = false, hits = null, loading = null, failedAt = 0, lastType = 'mouse', timer = 0;
  var nf0 = new Intl.NumberFormat('sv-SE');
  var nf1 = new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 1 });
  var nf2 = new Intl.NumberFormat('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  var MON = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
  tools.hidden = false;

  function kr(n) { return n % 1 === 0 ? nf0.format(n) : nf2.format(n); }
  function vol(ml) { return ml >= 1000 ? (ml / 1000).toFixed(ml % 1000 === 0 ? 0 : 2).replace('.', ',') + ' L' : ml + ' ml'; }
  function dateText(iso) { var a = iso.split('-'); return +a[2] + ' ' + MON[+a[1] - 1] + ' ' + a[0]; }
  function norm(s) { return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }
  // Samma regel som productPath() på servern.
  function href(o) {
    var s = String(o.n).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '');
    return '/dryck/' + o.id + (s ? '-' + s : '');
  }
  function change(o) { return o.f ? (o.t / o.f - 1) * 100 : 0; }
  function pctText(p) { var r = Math.round(p * 10) / 10; return (r > 0 ? '+' : r < 0 ? '−' : '') + nf1.format(Math.abs(r)) + ' %'; }
  function cls(o) {
    if (o.since) return 'n';
    if (!o.f) return '';
    var c = change(o);
    return (c > 0 ? 'u' : 'd') + (Math.abs(c) >= big ? '2' : '1');
  }
  function status(o) {
    if (o.since) return 'Följs sedan ' + dateText(o.since) + ': ' + kr(o.p) + ' kr';
    if (o.f) return kr(o.f) + ' → ' + kr(o.t) + ' kr (' + pctText(change(o)) + ')';
    return 'Oförändrat: ' + kr(o.p) + ' kr';
  }
  function message(text) { msgEl.textContent = text || ''; msgEl.hidden = !text; }

  function load() {
    if (loading) return loading;
    // Gick det nyss fel? Vänta några sekunder innan nästa försök.
    if (Date.now() - failedAt < 4000) return Promise.reject(new Error('wait'));
    loading = fetch(root.getAttribute('data-src'), { credentials: 'omit' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        big = d.big; cats = d.cats;
        P = d.p.map(function (a, i) {
          return { i: i, id: a[0], n: a[1], k: norm(a[1]), c: a[2], s: d.subs[a[3]], v: a[4], p: a[5], a: a[6], r: a[7], f: a[8] || 0, t: a[9] || 0, since: a[10] || '', b: a[11] || 0 };
        });
        byCat = cats.map(function () { return []; });
        P.forEach(function (o) { if (byCat[o.c]) byCat[o.c].push(o.i); });
        apply();
      });
    loading.catch(function () { loading = null; failedAt = Date.now(); });
    return loading;
  }
  // Kör fn när underlaget finns. Felmeddelandet visas bara när besökaren
  // själv försökt göra något – inte när sidan hämtar i förväg.
  function ready(fn) { load().then(fn, function () { message('Dryckerna gick inte att ladda just nu. Ladda om sidan och försök igen.'); }); }
  function preload() { load().then(function () {}, function () {}); }

  // Lägg rätt dryck på varje ruta för den valda ordningen. Rutorna står
  // kvar på sin plats och byter bara färg, så ingenting hoppar.
  function apply() {
    where = [];
    byCat.forEach(function (list, c) {
      var g = grids[c];
      if (!g) return;
      var order = list;
      if (mode === 'price') order = list.slice().sort(function (x, y) { return P[x].p - P[y].p || P[x].r - P[y].r; });
      else if (mode === 'apk') order = list.slice().sort(function (x, y) { return P[x].r - P[y].r; });
      var kids = g.children, j;
      for (j = kids.length; j < order.length; j++) g.appendChild(document.createElement('i'));
      while (kids.length > order.length) g.removeChild(g.lastChild);
      for (j = 0; j < order.length; j++) {
        var o = P[order[j]], el = kids[j], want = cls(o) + (hits && hits[o.i] ? ' hit' : '');
        el._i = o.i;
        where[o.i] = el;
        if (el.className !== want) el.className = want;
      }
    });
  }

  // ---- Etiketten ----
  function add(tag, text, className) {
    var el = document.createElement(tag);
    el.textContent = text;
    if (className) el.className = className;
    tip.appendChild(el);
    return el;
  }
  function fill(o) {
    while (tip.firstChild) tip.removeChild(tip.firstChild);
    add('b', o.n);
    add('span', o.s + ', ' + vol(o.v), 'sh-tip-meta');
    add('span', status(o), 'sh-tip-price');
    var rank = o.b && o.b !== o.r ? nf0.format(o.b) + ' \u2192 ' + nf0.format(o.r) : nf0.format(o.r);
    add('span', 'APK ' + nf2.format(o.a) + ' (plats ' + rank + ' av ' + nf0.format(cats[o.c][1]) + ')', 'sh-tip-meta');
    add('a', 'Öppna drycken').href = href(o);
    add('span', 'Klicka för att öppna drycken', 'sh-tip-hint');
  }
  function place(el) {
    var b = body.getBoundingClientRect(), r = el.getBoundingClientRect();
    var tw = tip.offsetWidth, th = tip.offsetHeight;
    var x = Math.max(0, Math.min(r.left + r.width / 2 - b.left - tw / 2, b.width - tw));
    var gap = pinned ? 14 : 10;
    var y = r.top - th - gap < 8 ? r.bottom + gap : r.top - th - gap;
    tip.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(y - b.top) + 'px)';
  }
  function show(el, pin) {
    if (!el) return;
    if (!P) { ready(function () { show(el, pin); }); return; }
    if (el._i === undefined || !P[el._i]) return;
    if (active !== el) {
      if (active) active.classList.remove('on');
      active = el;
      el.classList.add('on');
      fill(P[el._i]);
    }
    pinned = !!pin;
    tip.classList.toggle('pin', pinned);
    tip.hidden = false;
    place(el);
  }
  function hide() {
    if (active) active.classList.remove('on');
    active = null;
    pinned = false;
    tip.hidden = true;
  }
  function square(t) { return t && t.tagName === 'I' && t.parentNode && t.parentNode.classList.contains('sh-grid') ? t : null; }
  function grid(t) { return t && t.closest ? t.closest('.sh-grid') : null; }
  // Rutan under en punkt. Hamnar punkten i springan mellan två rutor räknas
  // den till rutan intill, så att ett tryck aldrig går förlorat.
  function pick(x, y) {
    var t = document.elementFromPoint(x, y), s = square(t);
    if (s || !t || !t.classList || !t.classList.contains('sh-grid') || t.children.length < 2) return s;
    var r = t.getBoundingClientRect(), a = t.children[0].getBoundingClientRect();
    var pitch = t.children[1].getBoundingClientRect().left - a.left;
    if (pitch <= 0) return null;
    var cols = Math.max(1, Math.round((r.width + pitch - a.width) / pitch));
    var col = Math.min(cols - 1, Math.max(0, Math.floor((x - r.left) / pitch)));
    var row = Math.max(0, Math.floor((y - r.top) / pitch));
    return t.children[row * cols + col] || null;
  }

  body.addEventListener('pointerdown', function (e) {
    lastType = e.pointerType || 'mouse';
    if (lastType === 'mouse') return;
    var el = pick(e.clientX, e.clientY);
    if (el) show(el, true);
  });
  body.addEventListener('pointermove', function (e) {
    if (e.pointerType === 'mouse') {
      if (pinned) return;
      var el = pick(e.clientX, e.clientY);
      if (el) show(el, false); else if (!grid(e.target)) hide();
    } else if (e.buttons || e.pressure > 0) {
      var el2 = pick(e.clientX, e.clientY);
      if (el2) show(el2, true);
    }
  });
  body.addEventListener('pointerleave', function (e) { if (e.pointerType === 'mouse' && !pinned) hide(); });
  // Mus: klick öppnar drycken. Pekskärm: första trycket visar etiketten,
  // länken i etiketten öppnar drycken.
  body.addEventListener('click', function (e) {
    var el = lastType === 'mouse' ? pick(e.clientX, e.clientY) : null;
    if (!el || !P || !P[el._i]) return;
    var url = href(P[el._i]);
    if (e.metaKey || e.ctrlKey) window.open(url, '_blank', 'noopener'); else window.location.href = url;
  });
  document.addEventListener('pointerdown', function (e) { if (pinned && !body.contains(e.target) && !hitsEl.contains(e.target)) hide(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hide(); });
  window.addEventListener('resize', function () { if (active) place(active); });

  // ---- Ordna efter ----
  sortBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      mode = btn.getAttribute('data-sort');
      sortBtns.forEach(function (b) { var on = b === btn; b.classList.toggle('active', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
      hide();
      ready(apply);
    });
  });

  // ---- Sökning: träffarna lyser i hyllan och listas under sökfältet ----
  function clearHits() {
    hits = null;
    body.classList.remove('searching');
    hitsEl.hidden = true;
    while (hitsEl.firstChild) hitsEl.removeChild(hitsEl.firstChild);
    for (var i = 0; i < where.length; i++) if (where[i]) where[i].classList.remove('hit');
    message('');
  }
  function search() {
    var q = norm(input.value).replace(/\s+/g, ' ').trim();
    if (q.length < 2) { clearHits(); return; }
    ready(function () {
      var toks = q.split(' '), found = [], i, t;
      hits = {};
      for (i = 0; i < P.length; i++) {
        var ok = true;
        for (t = 0; t < toks.length; t++) if (P[i].k.indexOf(toks[t]) < 0) { ok = false; break; }
        if (ok) { hits[i] = 1; found.push(P[i]); }
        if (where[i]) where[i].classList.toggle('hit', ok);
      }
      body.classList.add('searching');
      hide();
      found.sort(function (a, b) {
        return (a.k.indexOf(q) === 0 ? 0 : 1) - (b.k.indexOf(q) === 0 ? 0 : 1) || a.n.localeCompare(b.n, 'sv') || a.v - b.v;
      });
      while (hitsEl.firstChild) hitsEl.removeChild(hitsEl.firstChild);
      found.slice(0, 6).forEach(function (o) {
        var li = document.createElement('li'), a = document.createElement('a'), sw = document.createElement('i');
        var name = document.createElement('span'), small = document.createElement('small'), st = document.createElement('span');
        a.href = href(o);
        sw.className = cls(o);
        name.className = 'sh-hit-name';
        name.textContent = o.n + ' ';
        small.textContent = vol(o.v);
        name.appendChild(small);
        st.className = 'sh-hit-st';
        st.textContent = status(o);
        a.appendChild(sw); a.appendChild(name); a.appendChild(st);
        a.addEventListener('mouseenter', function () { show(where[o.i], false); });
        a.addEventListener('focus', function () { show(where[o.i], false); });
        a.addEventListener('mouseleave', hide);
        a.addEventListener('blur', hide);
        li.appendChild(a);
        hitsEl.appendChild(li);
      });
      hitsEl.hidden = !found.length;
      message(!found.length ? 'Ingen dryck i fasta sortimentet heter så.' : found.length > 6 ? nf0.format(found.length) + ' träffar. De lyser i hyllan, de sex första visas här.' : '');
    });
  }
  input.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(search, 90); });
  input.addEventListener('focus', preload);

  // Hämta underlaget när sidan är klar, så att det finns när någon pekar.
  if (window.requestIdleCallback) window.requestIdleCallback(preload, { timeout: 2500 });
  else setTimeout(preload, 1200);
}

// Filtret i tabellen "Alla prisändringar".
function tableClient() {
  var rowsEl = document.getElementById('pcRows');
  if (!rowsEl) return;
  var rows = [].slice.call(rowsEl.children), q = document.getElementById('pcSearch');
  var chips = [].slice.call(document.querySelectorAll('.pc-chip')), count = document.getElementById('pcCount'), none = document.getElementById('pcNone'), cat = '';
  function apply() {
    var t = q.value.trim().toLowerCase(), n = 0;
    rows.forEach(function (r) {
      var ok = (!cat || r.getAttribute('data-c') === cat) && (!t || r.getAttribute('data-n').indexOf(t) > -1);
      r.hidden = !ok;
      if (ok) n++;
    });
    count.textContent = n + ' st';
    none.hidden = n > 0;
  }
  q.addEventListener('input', apply);
  chips.forEach(function (c) {
    c.addEventListener('click', function () {
      cat = c.getAttribute('data-c');
      chips.forEach(function (x) { x.classList.toggle('active', x === c); });
      apply();
    });
  });
  apply();
}

// ---------- Delningsbilden (og:image) ----------
// En 1200×630-bild med rubriksiffrorna och hela hyllan, ritad pixel för pixel
// här (ingen bildmotor behövs): en palett-PNG byggd med Nodes inbyggda zlib.
const FONT = {
  A: '01110100011000111111100011000110001', B: '11110100011000111110100011000111110', C: '01110100011000010000100001000101110',
  D: '11110100011000110001100011000111110', E: '11111100001000011110100001000011111', F: '11111100001000011110100001000010000',
  G: '01110100011000010111100011000101110', H: '10001100011000111111100011000110001', I: '01110001000010000100001000010001110',
  J: '00111000100001000010000101001001100', K: '10001100101010011000101001001010001', L: '10000100001000010000100001000011111',
  M: '10001110111010110101100011000110001', N: '10001110011010110011100011000110001', O: '01110100011000110001100011000101110',
  P: '11110100011000111110100001000010000', Q: '01110100011000110001101011001001101', R: '11110100011000111110101001001010001',
  S: '01111100001000001110000010000111110', T: '11111001000010000100001000010000100', U: '10001100011000110001100011000101110',
  V: '10001100011000110001100010101000100', W: '10001100011000110101101011101110001', X: '10001100010101000100010101000110001',
  Y: '10001100010101000100001000010000100', Z: '11111000010001000100010001000011111',
  0: '01110100011001110101110011000101110', 1: '00100011000010000100001000010001110', 2: '01110100010000100010001000100011111',
  3: '11110000010000101110000010000111110', 4: '00010001100101010010111110001000010', 5: '11111100001111000001000011000101110',
  6: '01110100001000011110100011000101110', 7: '11111000010001000100010000100001000', 8: '01110100011000101110100011000101110',
  9: '01110100011000101111000010000101110', '.': '00000000000000000000000000110001100', ' ': '00000000000000000000000000000000000',
};
function crc32(buf) {
  let c, crc = 0xFFFFFFFF;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xFF;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function buildPng(r) {
  const W = 1200, H = 630, M = 60;
  const palette = ['#0A2D22', '#F5EBC4', '#D9B842', COLORS.up, COLORS.upLo, COLORS.flat, COLORS.dnLo, COLORS.dn, '#5E6F66'];
  const BG = 0, CREAM = 1, GOLD = 2, UP = 3, UPLO = 4, FLAT = 5, DNLO = 6, DN = 7, EDGE = 8;
  const px = new Uint8Array(W * H);
  const rect = (x, y, w, h, c) => {
    for (let yy = Math.max(0, y); yy < Math.min(H, y + h); yy++) px.fill(c, yy * W + Math.max(0, x), yy * W + Math.min(W, x + w));
  };
  const textWidth = (s, scale) => s.length * 6 * scale - scale;
  const text = (s, x, y, scale, c) => {
    for (const ch of String(s).toUpperCase()) {
      const g = FONT[ch] || FONT[' '];
      for (let i = 0; i < 35; i++) if (g[i] === '1') rect(x + (i % 5) * scale, y + Math.floor(i / 5) * scale, scale, scale, c);
      x += 6 * scale;
    }
    return x;
  };
  text('apkguiden.se', M, 56, 4, GOLD);
  const month = monthText(r.month);
  text(month, W - M - textWidth(month, 4), 56, 4, GOLD);
  let x = text(String(r.up), M, 130, 10, UP);
  text('dyrare', x + 20, 130, 10, CREAM);
  x = text(String(r.down), M, 226, 10, DN);
  text('billigare', x + 20, 226, 10, CREAM);
  // Hyllan: alla drycker i ett svep, dyrare först och billigare sist.
  const st = (p) => r.state.get(p.id);
  const of = (k) => PRODUCTS.filter((p) => st(p).k === k);
  const all = [...of('u').sort((a, b) => st(b).pct - st(a).pct), ...of('z'), ...of('d').sort((a, b) => st(b).pct - st(a).pct), ...of('n')];
  const top = 332, avail = H - top - 46;
  let pitch = 12;
  while (pitch > 4 && Math.ceil(all.length / Math.floor((W - 2 * M + 2) / pitch)) * pitch - 2 > avail) pitch--;
  const cols = Math.floor((W - 2 * M + 2) / pitch), size = pitch - 2;
  const x0 = M + Math.floor((W - 2 * M - (cols * pitch - 2)) / 2);
  all.forEach((p, i) => {
    const s = st(p), sx = x0 + (i % cols) * pitch, sy = top + Math.floor(i / cols) * pitch;
    if (s.k === 'n') { rect(sx, sy, size, size, EDGE); rect(sx + 1, sy + 1, size - 2, size - 2, BG); return; }
    const big = Math.abs(s.pct || 0) >= BIG_PCT;
    rect(sx, sy, size, size, s.k === 'u' ? (big ? UP : UPLO) : s.k === 'd' ? (big ? DN : DNLO) : FLAT);
  });
  // Koda som palett-PNG (1 byte per pixel).
  const raw = Buffer.alloc((W + 1) * H);
  for (let y = 0; y < H; y++) Buffer.from(px.buffer, y * W, W).copy(raw, y * (W + 1) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 3;
  const plte = Buffer.from(palette.flatMap((h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', ihdr), pngChunk('PLTE', plte), pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- Utseende ----------
const EXTRA_CSS = `
:root{--up:${COLORS.up};--up-lo:${COLORS.upLo};--dn:${COLORS.dn};--dn-lo:${COLORS.dnLo};--flat:${COLORS.flat};--paper:${COLORS.paper};--ink:${COLORS.ink}}
.pc-ico{width:.6rem;height:.6rem;flex-shrink:0;margin-right:.3rem;vertical-align:baseline}
.pc-ico.up{fill:var(--up)}
.pc-ico.down{fill:var(--dn)}
.pc-hero{display:grid;grid-template-columns:minmax(0,1fr);gap:2.25rem;align-items:start}
@media(min-width:880px){.pc-hero{grid-template-columns:minmax(0,1fr) 21.5rem;gap:3.5rem;margin-top:2.25rem}}
.pc-lede{font-size:clamp(1.2rem,2.4vw,1.5rem);line-height:1.38;margin:1.4rem 0 0;max-width:34rem}
.pc-lede strong{font-weight:800}
.pc-sub{font-size:.95rem;color:var(--muted);margin:1.1rem 0 0;max-width:34rem}
.pc-sub a{color:inherit}
.rc-wrap{width:100%;max-width:21.5rem;margin:0 auto;padding-bottom:1.25rem}
.rc-slot{height:.6rem;border-radius:9999px;background:#051C15;box-shadow:inset 0 2px 3px rgba(0,0,0,.7),0 1px 0 rgba(244,211,94,.14);position:relative;z-index:1}
.rc-feed{margin:-.3rem .85rem 0;clip-path:inset(0 -3rem -4rem -3rem)}
.rc-anim{animation:rcPrint 1.15s steps(24,end) .25s both}
@keyframes rcPrint{from{transform:translateY(-101%)}to{transform:none}}
.rc-tilt{transform:rotate(-1.3deg);transform-origin:50% 0;filter:drop-shadow(0 12px 14px rgba(2,18,13,.5))}
.rc{background:var(--paper);color:var(--ink);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace;font-size:.8rem;line-height:1.55;padding:1.5rem 1.15rem 1.75rem}
.rc p{margin:0;text-align:center}
.rc-shop{font-weight:700;letter-spacing:.12em}
.rc-title{font-family:'Schibsted Grotesk',sans-serif;font-size:1.7rem;font-weight:800;letter-spacing:-.02em;line-height:1.15;margin-top:.35rem !important}
.rc-note{opacity:.75}
.rc-rule{border-top:1.5px dashed rgba(16,38,31,.5);margin:.65rem 0}
.rc-row{display:flex;justify-content:space-between;gap:.75rem}
.rc-amt{white-space:nowrap;text-align:right}
.rc-cats{margin-top:.5rem}
.rc-cats .rc-row{display:grid;grid-template-columns:3.4rem minmax(0,1fr) auto;gap:.5rem}
.rc-head{font-size:.7rem;opacity:.75}
.rc-cnt{white-space:nowrap}
.rc .pc-ico{fill:var(--ink);width:.5rem;height:.5rem;margin-right:.2rem}
.rc-cnt .pc-ico.down{margin-left:.45rem}
.rc-total{font-size:1.15rem;font-weight:700}
.rc-foot{font-size:.72rem;opacity:.8}
@media(prefers-reduced-motion:reduce){.rc-anim{animation:none}}
.sh{background:var(--bg-dark);border:1px solid var(--line);border-radius:1.5rem;padding:1.25rem .75rem 1rem;margin-top:2.5rem;--sq:6px}
@media(min-width:700px){.sh{padding:1.75rem 1.5rem 1.5rem;--sq:9px}}
.sh h2{margin:0}
.sh-intro{margin:.35rem 0 0;max-width:38rem}
.sh-tools{display:flex;flex-wrap:wrap;align-items:center;gap:.6rem 1rem;margin-top:1rem}
.sh-tools[hidden]{display:none}
.sh-q{flex:1 1 13rem;min-width:0;max-width:22rem;background:var(--bg-light);border:1.5px solid transparent;border-radius:9999px;padding:.6rem 1rem;color:var(--cream);font:inherit;font-size:.95rem}
.sh-q::placeholder{color:var(--muted);opacity:.85}
.sh-q,.pc-filter input{color-scheme:dark}
.sh-q:focus{outline:none;border-color:var(--accent)}
.sh-sort{display:flex;align-items:center;gap:.3rem}
.sh-sort-l{font-size:.8rem;color:var(--muted);margin-right:.25rem}
@media(max-width:480px){.sh-sort-l{display:none}}
.sh-sort button,.pc-chip{font:inherit;font-size:.8rem;font-weight:600;color:var(--cream);background:transparent;border:1.5px solid rgba(244,211,94,.2);border-radius:9999px;padding:.45rem .8rem;cursor:pointer}
.sh-sort button:hover,.pc-chip:hover{border-color:var(--accent)}
.sh-sort button.active,.pc-chip.active{background:var(--accent);border-color:var(--accent);color:var(--bg-dark)}
.sh-sort button:focus-visible,.pc-chip:focus-visible,.sh-hits a:focus-visible,.pc-row:focus-visible,.pc-dl:focus-visible,.pc-all summary:focus-visible span{outline:2px solid var(--cream);outline-offset:2px}
.sh-hits{list-style:none;margin:.75rem 0 0;padding:0;display:flex;flex-direction:column;gap:.3rem;max-width:38rem}
.sh-hits[hidden]{display:none}
.sh-hits a{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:.6rem;align-items:center;background:var(--bg-light);border-radius:.7rem;padding:.5rem .75rem;color:var(--cream);text-decoration:none;font-size:.9rem;border:1.5px solid transparent}
.sh-hits a:hover{border-color:var(--accent)}
.sh-hit-name{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sh-hit-name small{font-weight:400;color:var(--muted)}
.sh-hit-st{font-size:.8rem;white-space:nowrap}
.sh-msg{margin:.6rem 0 0;font-size:.85rem;color:var(--muted)}
.sh-legend{list-style:none;margin:1rem 0 0;padding:0;display:flex;flex-wrap:wrap;gap:.35rem 1.1rem;font-size:.8rem}
.sh-legend li{display:flex;align-items:center}
.sh-legend i,.sh-hits i{display:inline-block;width:.7rem;height:.7rem;border-radius:2px;background:var(--flat);margin-right:.2rem;flex-shrink:0}
.sh-hits i{box-shadow:inset 0 0 0 1px rgba(245,235,196,.22)}
.sh-legend i:last-of-type{margin-right:.45rem}
.sh-mute{color:var(--muted)}
.sh-body{position:relative}
.sh-cat{margin-top:1.15rem}
.sh-cat-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:.15rem .9rem;margin-bottom:.5rem}
.sh-cat-head h3{font-size:1.05rem;font-weight:800;color:var(--accent);margin:0}
.sh-cat-head p{margin:0;font-size:.8rem;display:flex;flex-wrap:wrap;gap:.1rem .85rem}
.sh-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(var(--sq),1fr));gap:2px;touch-action:pan-y;cursor:pointer;-webkit-tap-highlight-color:transparent}
.sh-grid i{display:block;aspect-ratio:1;min-height:var(--sq);border-radius:1.5px;background:var(--flat);transition:background-color .35s ease,opacity .2s ease}
@supports (aspect-ratio:1){.sh-grid i{min-height:0}}
.sh i.u1{background:var(--up-lo)}
.sh i.u2{background:var(--up)}
.sh i.d1{background:var(--dn-lo)}
.sh i.d2{background:var(--dn)}
.sh i.n{background:transparent;box-shadow:inset 0 0 0 1px rgba(245,235,196,.3)}
.sh-body.searching .sh-grid i{opacity:.16}
.sh-body.searching .sh-grid i.hit{position:relative;opacity:1;outline:1.5px solid var(--cream);outline-offset:1px}
.sh-grid i.on,.sh-body.searching .sh-grid i.on{position:relative;z-index:1;opacity:1;outline:2px solid var(--cream);outline-offset:1px}
.sh-tip{position:absolute;left:0;top:0;z-index:5;width:max-content;max-width:min(17rem,100%);background:var(--paper);color:var(--ink);border-radius:.6rem;padding:.6rem .8rem .65rem;font-size:.8rem;line-height:1.4;box-shadow:0 10px 24px rgba(2,18,13,.55);pointer-events:none}
.sh-tip[hidden]{display:none}
.sh-tip b{display:block;font-size:.92rem;line-height:1.25}
.sh-tip span{display:block}
.sh-tip-meta{opacity:.75}
.sh-tip-price{font-weight:700;margin:.2rem 0 .05rem}
.sh-tip a{display:none;margin-top:.5rem;font-weight:700;color:var(--ink)}
.sh-tip-hint{opacity:.75;margin-top:.3rem}
.sh-tip.pin{pointer-events:auto}
.sh-tip.pin a{display:inline-block}
.sh-tip.pin .sh-tip-hint{display:none}
@media(prefers-reduced-motion:reduce){.sh-grid i{transition:none}}
.pc-finds{display:grid;grid-template-columns:minmax(0,1fr);gap:1.75rem 2.5rem}
@media(min-width:760px){.pc-finds{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}}
.pc-find{border-top:2px solid var(--accent);padding-top:.85rem}
.pc-find h3{font-size:1.2rem;font-weight:800;letter-spacing:-.015em;line-height:1.2;color:var(--cream);margin:0 0 .4rem}
.pc-find p{margin:0;font-size:.95rem;line-height:1.5}
.pc-find a{color:var(--cream)}
.pc-under{margin:-.5rem 0 1rem;font-size:.95rem;color:var(--muted);max-width:38rem}
.pc-cols{display:grid;grid-template-columns:minmax(0,1fr);gap:0 1.5rem}
@media(min-width:900px){.pc-cols{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}}
.pc-cols h2{display:flex;align-items:center}
.pc-cols h2 .pc-ico{width:.8rem;height:.8rem;margin-right:.5rem}
.pc-list{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:.4rem}
@media(min-width:900px){.pc-list-2{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:.4rem 1.5rem}}
.pc-row{display:grid;grid-template-columns:1.4rem 2.5rem minmax(0,1fr) auto;gap:.7rem;align-items:center;background:var(--bg-light);border-radius:.9rem;padding:.55rem .9rem .55rem .7rem;text-decoration:none;color:var(--cream);border:1.5px solid transparent}
.pc-row-climb{grid-template-columns:2.5rem minmax(0,1fr) auto}
.pc-row:hover{border-color:var(--accent)}
.pc-rank{font-size:.8rem;font-weight:700;color:var(--muted);text-align:right}
.pc-thumb{width:2.5rem;height:2.5rem;display:flex;align-items:center;justify-content:center}
.pc-thumb img{max-width:100%;max-height:100%;object-fit:contain}
.pc-text{min-width:0}
.pc-name,.pc-meta{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media(max-width:520px){.pc-row{grid-template-columns:1.1rem 2rem minmax(0,1fr) auto;gap:.5rem}.pc-row-climb{grid-template-columns:2rem minmax(0,1fr) auto}.pc-thumb{width:2rem;height:2rem}.pc-name{white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;line-height:1.2;font-size:.92rem}}
.pc-name{font-weight:700}
.pc-meta{font-size:.78rem;color:var(--muted)}
.pc-nums{text-align:right;white-space:nowrap}
.pc-pct{display:block;font-weight:800;font-size:1rem}
.pc-price{display:block;font-size:.78rem;color:var(--muted)}
.pc-price strong{color:var(--cream)}
.pc-all-bar{display:flex;flex-wrap:wrap;align-items:flex-start;gap:.75rem 1.25rem;margin-top:1.5rem}
.pc-all{flex:1 1 100%;order:2;min-width:0}
.pc-all:not([open]){flex:0 1 auto;order:0}
.pc-all summary{list-style:none;cursor:pointer}
.pc-all summary::-webkit-details-marker{display:none}
.pc-all summary span{display:inline-flex;align-items:center;gap:.5rem;font-weight:700;font-size:.9rem;color:var(--cream);padding:.7rem 1.2rem;border-radius:9999px;border:1.5px solid rgba(244,211,94,.25)}
.pc-all summary span::after{content:'';width:.45rem;height:.45rem;border-right:2px solid currentColor;border-bottom:2px solid currentColor;transform:rotate(45deg) translateY(-2px)}
.pc-all[open] summary span::after{transform:rotate(-135deg) translateY(-2px)}
.pc-all summary:hover span{border-color:var(--accent);color:var(--accent)}
.pc-dl{font-size:.9rem;font-weight:600;color:var(--cream);padding:.7rem 0;order:1}
.pc-dl:hover{color:var(--accent)}
.pc-filter{display:flex;flex-wrap:wrap;align-items:center;gap:.6rem;margin:1rem 0 .75rem}
.pc-filter input{flex:1 1 12rem;min-width:0;max-width:20rem;background:var(--bg-light);border:1.5px solid transparent;border-radius:9999px;padding:.55rem 1rem;color:var(--cream);font:inherit;font-size:.9rem}
.pc-filter input::placeholder{color:var(--muted);opacity:.8}
.pc-filter input:focus{outline:none;border-color:var(--accent)}
.pc-chips{display:flex;flex-wrap:wrap;gap:.35rem}
.pc-count{font-size:.8rem;color:var(--muted)}
.pc-none{color:var(--muted)}
.pc-table-wrap{overflow-x:auto}
.pc-table{width:100%;border-collapse:collapse;font-size:.85rem}
.pc-table th,.pc-table td{padding:.45rem .6rem;border-bottom:1px solid var(--line);text-align:right}
.pc-table th:first-child,.pc-table td:first-child,.pc-table th:nth-child(2),.pc-table td:nth-child(2){text-align:left}
.pc-table thead th{font-size:.75rem;color:var(--muted);font-weight:600;white-space:nowrap}
.pc-table td a{color:var(--cream);text-decoration:none;font-weight:600}
.pc-table td a:hover{color:var(--accent)}
.pc-table small{color:var(--muted)}
.pc-chg{white-space:nowrap;font-weight:700}
@media(max-width:560px){.pc-table th:nth-child(2),.pc-table td:nth-child(2){display:none}.pc-table th,.pc-table td{padding:.45rem .35rem}}
.pc-bar{display:flex;gap:2px;height:.6rem}
.pc-bar span{min-width:4px}
.pc-bar .up{background:var(--up)}
.pc-bar .down{background:var(--dn)}
.pc-bar span:first-child{border-radius:9999px 0 0 9999px}
.pc-bar span:last-child{border-radius:0 9999px 9999px 0}
.pc-bar span:only-child{border-radius:9999px}
.pc-legend{display:flex;flex-wrap:wrap;gap:.25rem 1.25rem;font-size:.85rem;margin-top:.6rem}
.pc-rounds{display:flex;flex-direction:column;gap:.6rem;max-width:42rem}
.pc-round{background:var(--bg-light);border-radius:1rem;padding:.9rem 1.1rem}
.pc-round-name{font-weight:800;color:var(--accent);margin-bottom:.6rem}
.pc-round-net{margin-left:auto;color:var(--muted)}
.pc-round-net strong{color:var(--cream)}
.pc-about{font-size:.95rem}
`;

// ---------- Sidan ----------
function render() {
  const latest = LATEST;
  const source = `<a href="${SOURCE_URL}" target="_blank" rel="noopener">enligt Systembolaget</a>`;
  const next = nextWindow(LAST_CHECK);
  const crumbs = '<nav class="crumbs" aria-label="Brödsmulor"><a href="/">Topplistan</a><span>›</span><span>Prisändringar</span></nav>';

  if (!latest) {
    const body = `${crumbs}
<h1>Prisändringar på Systembolaget</h1>
<div class="prose" style="margin-top:1.25rem">
  <p>Vi kollar priset på varje dryck i Systembolagets fasta sortiment varje vecka. Leverantörerna får ändra priserna två gånger om året, i mars och september (${source}).</p>
  <p>Vi har inte sett någon större prisändring ännu. Nästa tillfälle är i <strong>${esc(next)}</strong>.</p>
</div>`;
    return page({
      title: 'Prisändringar på Systembolaget | apkguiden.se',
      metaDescription: 'Vad blev dyrare och billigare på Systembolaget? Vi kollar priset på hela det fasta sortimentet varje vecka.',
      canonical: URL, body, extraCss: EXTRA_CSS,
    });
  }

  const month = monthText(latest.month);
  const body = `${crumbs}
<div class="pc-hero">
  <div>
    <h1>Prisändringar på Systembolaget</h1>
    <p class="pc-lede">${ledeHtml(latest)}</p>
    <p class="pc-sub">Vi kollar priset på varje dryck i fasta sortimentet varje vecka. Leverantörerna får ändra priserna två gånger om året, i mars och september (${source}). Nästa gång: ${esc(next)}.</p>
  </div>
  ${receiptHtml(latest)}
</div>
${shelfHtml(latest)}
${insightsHtml(latest)}
${climbersHtml()}
${topListsHtml(latest)}
${allChangesHtml(latest)}
${roundsHtml()}
${aboutHtml(latest)}
<script>(${shelfClient.toString()})();(${tableClient.toString()})();</script>`;

  const title = `Prisändringar på Systembolaget ${month}: ${nf.format(latest.up)} drycker dyrare, ${nf.format(latest.down)} billigare | apkguiden.se`;
  const metaDescription = `${ledeText(latest)} Se varje dryck i fasta sortimentet, största höjningarna och sänkningarna och vad som hände med APK-listan.`;
  const since = HISTORY.since || CHECKS[0];
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
      name: 'Prisändringar i Systembolagets fasta sortiment',
      description: 'Veckovis prishistorik för varje dryck i Systembolagets fasta sortiment: datum då vi först såg drycken och varje prisändring därefter. Uppdateras varje vecka av apkguiden.se.',
      url: URL,
      inLanguage: 'sv-SE',
      isAccessibleForFree: true,
      creator: { '@type': 'Organization', name: 'apkguiden.se', url: SITE + '/' },
      keywords: ['Systembolaget', 'priser', 'prisändringar', 'alkohol', 'Sverige'],
      ...(since && LAST_CHECK ? { temporalCoverage: `${since}/${LAST_CHECK}` } : {}),
      distribution: [
        { '@type': 'DataDownload', encodingFormat: 'text/csv', contentUrl: SITE + '/api/prisandringar?format=csv' },
        { '@type': 'DataDownload', encodingFormat: 'application/json', contentUrl: SITE + '/api/prisandringar?format=json' },
        { '@type': 'DataDownload', encodingFormat: 'application/json', contentUrl: SITE + '/price-history.json' },
      ],
    },
  ];

  return page({
    title, metaDescription, canonical: URL, jsonLd, body, extraCss: EXTRA_CSS,
    ogImage: `${SITE}/api/prisandringar?format=png&v=${latest.month}`, ogLarge: true,
  });
}

// Byggs första gången de efterfrågas och sparas sedan tills nästa kallstart.
const cache = {};
const cached = (key, build) => (key in cache ? cache[key] : (cache[key] = build()));

module.exports = (req, res) => {
  const format = String((req.query && req.query.format) || '');
  // Samma cache-regler som dryckessidorna: ny deploy (= ny veckodata) tömmer CDN:et.
  res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  res.setHeader('Vercel-CDN-Cache-Control', 'max-age=86400, stale-while-revalidate=604800');
  if (format && !LATEST) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end('Ingen prisändring att visa ännu.');
  }
  if (format === 'json') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Robots-Tag', 'noindex');
    res.statusCode = 200;
    return res.end(cached('json', () => buildJson(LATEST)));
  }
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="prisandringar-systembolaget-${LATEST.month}.csv"`);
    res.setHeader('X-Robots-Tag', 'noindex');
    res.statusCode = 200;
    return res.end(cached('csv', () => buildCsv(LATEST)));
  }
  if (format === 'png') {
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.statusCode = 200;
    return res.end(cached('png', () => buildPng(LATEST)));
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.statusCode = 200;
  return res.end(cached('html', render));
};

module.exports.render = render;
module.exports.ROUNDS = ROUNDS;
module.exports.LATEST = LATEST;
module.exports.INFO = INFO;
module.exports.buildJson = buildJson;
module.exports.buildCsv = buildCsv;
module.exports.buildPng = buildPng;
