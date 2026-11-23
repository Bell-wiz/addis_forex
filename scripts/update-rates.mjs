// Addis Forex Board: weekday rate reader.
//   node scripts/update-rates.mjs read  > readings.json   (reads the sources)
//   node scripts/update-rates.mjs merge readings.json      (merges into rates.json)
// Rules: a bureau is recorded when its own date is today in Addis. A source
// whose latest date is earlier (up to STALE_DAYS back, e.g. on a Saturday) is
// recorded with "STALE: dated <day>" in its source; older ones are left out.
// Taypay shows no date and is recorded as "undated". Walia uses Head Office rows.
// A bureau whose USD buy is below the NBE rate is kept but marked doubtful.
// Nothing is invented: a source that fails or is not dated today is left out,
// and quotes already in today's entry (for example Ethio Forex, added by hand)
// are kept.
import { readFileSync, writeFileSync } from 'node:fs';

const CCYS = ['USD', 'EUR', 'GBP', 'AED', 'SAR', 'CAD', 'CHF', 'CNY'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const TZ = 'Africa/Addis_Ababa';
const STALE_DAYS = 7;

function addisNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date()).map(x => [x.type, x.value]));
  const hh = p.hour === '24' ? '00' : p.hour;
  return { date: `${p.year}-${p.month}-${p.day}`, iso: `${p.year}-${p.month}-${p.day}T${hh}:${p.minute}:00+03:00` };
}
const NOW = addisNow();
const TODAY = NOW.date;
const prettyDate = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const ageDays = d => Math.round((Date.parse(TODAY + 'T00:00:00Z') - Date.parse(d + 'T00:00:00Z')) / 86400000);
const usable = d => d && ageDays(d) >= 0 && ageDays(d) <= STALE_DAYS;
const latest = ds => ds.filter(usable).sort().pop() || null;
const num = v => { const n = parseFloat(String(v).replace(/,/g, '')); return Number.isFinite(n) && n > 0 ? n : null; };
const mdyToIso = s => { const m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null; };

function rateMap(rows) {
  const out = {};
  for (const { code, buy, sell } of rows) {
    const c = String(code || '').trim().toUpperCase();
    const b = num(buy), s = num(sell);
    if (CCYS.includes(c) && b && s && !out[c]) out[c] = { buy: b, sell: s };
  }
  return Object.keys(out).length ? Object.fromEntries(Object.keys(out).sort().map(k => [k, out[k]])) : null;
}

async function getJson(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ---- sources -----------------------------------------------------------

async function readNbe() {
  const j = await getJson('https://api.nbe.gov.et/api/get-selected-exchange-rates');
  const all = j.data || [];
  const date = latest([...new Set(all.map(r => r.date))]);
  const rows = all.filter(r => r.date === date);
  const nbe = {};
  for (const r of rows) { const c = r.currency && r.currency.code; const v = num(r.weighted_average); if (CCYS.includes(c) && v) nbe[c] = v; }
  if (!Object.keys(nbe).length) throw new Error(`no recent rates (NBE dates: ${[...new Set(all.map(r => r.date))].join(', ') || 'none'})`);
  return { nbe, date };
}

// Global, Rooha and Walia share one API shape.
async function readPublicApi(url, { branch }) {
  const j = await getJson(url);
  let rows = j.data || [];
  if (branch) rows = rows.filter(r => (r.branchName || '').trim().toLowerCase() === branch.toLowerCase());
  const dates = [...new Set(rows.map(r => r.effectiveDate))];
  const date = latest(dates);
  const today = rows.filter(r => r.effectiveDate === date);
  if (!today.length) throw new Error(`nothing recent (source dates: ${dates.join(', ') || 'none'})`);
  const rates = rateMap(today.map(r => ({ code: r.currencyCode, buy: r.buy, sell: r.sell })));
  if (!rates) throw new Error('no usable rows');
  const fee = num(today[0].serviceChargeValue);
  return { rates, fee, date };
}

async function withPage(browser, url, fn) {
  const ctx = await browser.newContext({ userAgent: UA, timezoneId: TZ });
  const page = await ctx.newPage();
  const json = [];
  page.on('response', async r => { const ct = r.headers()['content-type'] || ''; if (ct.includes('json')) { try { json.push({ url: r.url(), body: await r.json() }); } catch {} } });
  try {
    const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(3000);
    const status = resp ? resp.status() : 0;
    const text = await page.evaluate(() => document.body ? document.body.innerText : '');
    return await fn({ page, status, text, json });
  } finally { await ctx.close(); }
}

async function readDbh(browser) {
  return withPage(browser, 'https://dbhforex.com/', ({ status, text, json }) => {
    if (status >= 400) throw new Error(`HTTP ${status}`);
    const m = text.match(/LAST UPDATED:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
    const siteDate = m ? mdyToIso(m[1]) : null;
    if (!usable(siteDate)) throw new Error(`site date ${siteDate || 'not found'}, too old`);
    const api = json.find(j => /currencyrates/.test(j.url));
    if (!api) throw new Error('rate feed not seen');
    const rows = (api.body.data || []).filter(r => r.branch && r.branch.name === 'DBH Main');
    const rates = rateMap(rows.map(r => ({ code: r.currency && r.currency.code, buy: r.buying_price, sell: r.selling_price })));
    if (!rates) throw new Error('no usable rows');
    return { rates, date: siteDate, source: `dbhforex.com, Main branch (site: last updated ${prettyDate(siteDate)})` };
  });
}

async function readTaypay(browser) {
  return withPage(browser, 'https://taypayforexbureau.com/live-exchange-rate/', ({ status, text }) => {
    if (status >= 400) throw new Error(`HTTP ${status}`);
    const rows = [];
    for (const line of text.split('\n')) {
      const cells = line.split('\t').map(s => s.trim());
      if (cells.length >= 4 && /^[A-Z]{3}$/.test(cells[1])) rows.push({ code: cells[1], buy: cells[2], sell: cells[3] });
    }
    const rates = rateMap(rows);
    if (!rates) throw new Error('rate table not found');
    return { rates, date: TODAY, source: `taypayforexbureau.com (undated; read ${prettyDate(TODAY)})` };
  });
}

async function readHaron(browser) {
  return withPage(browser, 'https://haronforex.com/', ({ status, text }) => {
    if (status >= 400) throw new Error(`HTTP ${status}`);
    const m = text.match(/Last updated:\s*(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/i);
    if (!m) throw new Error('date not found');
    if (!usable(m[1])) throw new Error(`last updated ${m[1]}, too old`);
    const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
    const rows = [];
    for (let i = 0; i < lines.length; i++) {
      if (!/^[A-Z]{3}$/.test(lines[i])) continue;
      const bi = lines.indexOf('Buying Rate', i), si = lines.indexOf('Selling Rate', i);
      if (bi < 0 || si < 0 || si - i > 8) continue;
      rows.push({ code: lines[i], buy: lines[i + 1], sell: lines[bi + 1] });
    }
    const rates = rateMap(rows);
    if (!rates) throw new Error('rate cards not found');
    return { rates, date: m[1], source: `haronforex.com (last updated ${prettyDate(m[1])} ${m[2].slice(0, 5)})`, updatedAt: `${m[1]}T${m[2]}+03:00` };
  });
}

async function readAmmann(browser) {
  return withPage(browser, 'https://ammannforexbureau.com/', ({ status, text }) => {
    if (status >= 400 || /security verification|verify you are human/i.test(text)) throw new Error(`blocked by the site's bot check (HTTP ${status})`);
    throw new Error('page opened but no reader is written for it yet');
  });
}

// bina.et republishes NBE's full indicative table (the NBE API gives only USD, EUR, AED).
async function readBinaNbe(browser) {
  return withPage(browser, 'https://bina.et/exchange-rate-ethiopia', ({ status, text }) => {
    if (status >= 400) throw new Error(`HTTP ${status}`);
    const m = text.match(/rates dated\s+\w+,\s+(\d{1,2})\s+(\w+)\s+(\d{4})/i);
    if (!m) throw new Error('date not found');
    const mon = ['january','february','march','april','may','june','july','august','september','october','november','december'].indexOf(m[2].toLowerCase()) + 1;
    if (!mon) throw new Error(`unreadable month ${m[2]}`);
    const date = `${m[3]}-${String(mon).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    if (!usable(date)) throw new Error(`dated ${date}, too old`);
    const nbe = {};
    for (const line of text.split('\n')) {
      const cells = line.split('\t').map(x => x.trim());
      const code = (cells[0] || '').split(/\s+/)[0];
      if (cells.length >= 4 && CCYS.includes(code) && !nbe[code]) { const v = num(cells[3]); if (v) nbe[code] = v; }
    }
    if (!Object.keys(nbe).length) throw new Error('rate table not found');
    return { nbe, date };
  });
}

async function read() {
  const out = { date: TODAY, readAt: NOW.iso, nbe: null, quotes: {}, log: [] };
  const note = (k, ok, msg) => { out.log.push(`${ok ? 'OK  ' : 'SKIP'} ${k}: ${msg}`); };
  const stale = d => d !== TODAY ? ` (STALE: dated ${prettyDate(d)})` : '';
  try { const r = await readNbe(); out.nbe = r.nbe; out.nbeDate = r.date; note('nbe', true, `${Object.keys(r.nbe).join(' ')}${stale(r.date)}`); } catch (e) { note('nbe', false, e.message); }

  const api = [
    ['global', 'https://www.globalforexet.com/api/public-exchange-rates', {}, r => `globalforexet.com (applicable ${prettyDate(r.date)}; selling excl. ${r.fee ?? '?'}% fee + VAT)`],
    ['rooha', 'https://www.roohaforex.net/api/public-exchange-rates', {}, r => `roohaforex.net (applicable ${prettyDate(r.date)}; selling excl. ${r.fee ?? '?'}% fee)`],
    ['walia', 'https://www.waliaforexet.com/api/rates', { branch: 'Head Office' }, r => `waliaforexet.com, Head Office (effective ${prettyDate(r.date)}; ${r.fee ?? '?'}% service charge not included)`],
  ];
  for (const [slug, url, opt, src] of api) {
    try { const r = await readPublicApi(url, opt); out.quotes[slug] = { rates: r.rates, source: src(r) + stale(r.date), updatedAt: NOW.iso }; note(slug, true, Object.keys(r.rates).join(' ') + stale(r.date)); }
    catch (e) { note(slug, false, e.message); }
  }

  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    try { const r = await readBinaNbe(browser); out.nbeExtra = r; note('nbe-bina', true, `${Object.keys(r.nbe).join(' ')}${stale(r.date)}`); } catch (e) { note('nbe-bina', false, e.message); }
    for (const [slug, fn] of [['dbh', readDbh], ['taypay', readTaypay], ['haron', readHaron], ['ammann', readAmmann]]) {
      try { const r = await fn(browser); out.quotes[slug] = { rates: r.rates, source: r.source + stale(r.date), updatedAt: r.updatedAt || NOW.iso }; note(slug, true, Object.keys(r.rates).join(' ') + stale(r.date)); }
      catch (e) { note(slug, false, e.message); }
    }
  } finally { await browser.close(); }
  return out;
}

// ---- merge -------------------------------------------------------------

// Adds NBE currencies the day doesn't have yet; never replaces one already there.
function fillNbe(day, values, valuesDate, dayDate, from) {
  if (valuesDate !== dayDate && Object.keys(day.nbe).length && !/STALE/.test(day.nbeSource || '')) return;
  const added = Object.keys(values).filter(c => CCYS.includes(c) && num(values[c]) && day.nbe[c] === undefined);
  if (!added.length) return;
  for (const c of added) day.nbe[c] = num(values[c]);
  day.nbe = Object.fromEntries(Object.keys(day.nbe).sort().map(k => [k, day.nbe[k]]));
  const note = `${valuesDate !== dayDate ? 'STALE: ' : ''}${added.join(', ')} for ${prettyDate(valuesDate)} from ${from}`;
  day.nbeSource = day.nbeSource ? `${day.nbeSource}; ${note}` : note;
}

function loadDay(date) {
  const data = JSON.parse(readFileSync('rates.json', 'utf8'));
  const days = data.days || [];
  const existing = days.find(d => d.date === date);
  const day = existing ? structuredClone(existing) : { date, nbe: {}, nbeSource: '', quotes: {} };
  day.nbe = day.nbe || {}; day.quotes = day.quotes || {};
  return { data, days, day };
}

function saveDay({ data, days, day }) {
  day.quotes = Object.fromEntries(Object.keys(day.quotes).sort().map(k => [k, day.quotes[k]]));
  if (!Object.keys(day.nbe).length && !Object.keys(day.quotes).length) { console.log('Nothing for this day; rates.json left as it is.'); return; }
  data.days = [day, ...days.filter(d => d.date !== day.date)].sort((a, b) => b.date.localeCompare(a.date));
  writeFileSync('rates.json', JSON.stringify(data, null, 1) + '\n');
}

// extras.json: what the job can't read (Ethio Forex's X card, Ammann), written by
// Claude. Only these bureaus are taken from it, and it never replaces anything.
const EXTRA_SLUGS = ['ammann', 'ethio'];
function mergeExtras(extras) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(extras.date || '')) throw new Error('extras.json has no valid date');
  const st = loadDay(extras.date);
  if (extras.nbe) fillNbe(st.day, extras.nbe, extras.date, extras.date, extras.nbeFrom || 'the NBE table');
  for (const [slug, q] of Object.entries(extras.quotes || {})) {
    if (!EXTRA_SLUGS.includes(slug)) { console.log(`Ignored ${slug}: not one of ${EXTRA_SLUGS.join(', ')}.`); continue; }
    const rates = rateMap(Object.entries(q.rates || {}).map(([code, r]) => ({ code, buy: r.buy, sell: r.sell })));
    if (!rates || !q.source) { console.log(`Ignored ${slug}: no usable rates or source.`); continue; }
    const quote = { rates, source: String(q.source).slice(0, 200), updatedAt: q.updatedAt || `${extras.date}T00:00:00+03:00` };
    const nbeUsd = st.day.nbe.USD, buy = rates.USD && rates.USD.buy;
    if (nbeUsd && buy && buy < nbeUsd) quote.source += ` (DOUBTFUL: USD buy ${buy} is below the NBE rate ${nbeUsd})`;
    st.day.quotes[slug] = quote;
    console.log(`Added ${slug} for ${extras.date}.`);
  }
  saveDay(st);
}

function merge(readings, skip) {
  const data = JSON.parse(readFileSync('rates.json', 'utf8'));
  const days = data.days || [];
  const existing = days.find(d => d.date === readings.date);
  const day = existing ? structuredClone(existing) : { date: readings.date, nbe: {}, nbeSource: '', quotes: {} };
  day.nbe = day.nbe || {}; day.quotes = day.quotes || {};

  const nbeDate = readings.nbeDate || readings.date;
  const nbeStale = nbeDate !== readings.date;
  const hadFreshNbe = Object.keys(day.nbe).length && !/STALE/.test(day.nbeSource || '');
  if (readings.nbe && !(nbeStale && hadFreshNbe)) {
    Object.assign(day.nbe, readings.nbe);
    day.nbe = Object.fromEntries(Object.keys(day.nbe).sort().map(k => [k, day.nbe[k]]));
    const mine = `${nbeStale ? 'STALE: ' : ''}NBE daily indicative rates for ${prettyDate(nbeDate)} (weighted average) from api.nbe.gov.et: ${Object.keys(readings.nbe).join(', ')}${nbeStale ? ' (NBE had not published a rate for this day when read)' : ''}`;
    if (!day.nbeSource) day.nbeSource = mine;
    else if (!day.nbeSource.includes('api.nbe.gov.et')) day.nbeSource = `${day.nbeSource}; ${mine}`;
  }
  if (readings.nbeExtra) fillNbe(day, readings.nbeExtra.nbe, readings.nbeExtra.date, readings.date, "bina.et's copy of the NBE table");

  for (const [slug, q] of Object.entries(readings.quotes)) {
    if (skip.includes(slug)) { console.log(`Left out ${slug} (asked to skip it).`); continue; }
    const have = day.quotes[slug];
    if (/STALE/.test(q.source) && have && !/STALE/.test(have.source)) { console.log(`Kept today's ${slug} quote over an older reading.`); continue; }
    const quote = structuredClone(q);
    const nbeUsd = day.nbe.USD, buy = quote.rates.USD && quote.rates.USD.buy;
    if (nbeUsd && buy && buy < nbeUsd) quote.source += ` (DOUBTFUL: USD buy ${buy} is below the NBE rate ${nbeUsd})`;
    day.quotes[slug] = quote;
  }
  day.quotes = Object.fromEntries(Object.keys(day.quotes).sort().map(k => [k, day.quotes[k]]));

  if (!Object.keys(day.nbe).length && !Object.keys(day.quotes).length) { console.log('Nothing read for today; rates.json left as it is.'); return; }
  const rest = days.filter(d => d.date !== readings.date);
  data.days = [day, ...rest].sort((a, b) => b.date.localeCompare(a.date));
  writeFileSync('rates.json', JSON.stringify(data, null, 1) + '\n');
}

const [cmd, file] = process.argv.slice(2);
if (cmd === 'read') {
  const r = await read();
  for (const l of r.log) console.error(l);
  process.stdout.write(JSON.stringify(r, null, 2));
} else if (cmd === 'merge') {
  const skip = (process.env.SKIP || '').split(',').map(s => s.trim()).filter(Boolean);
  merge(JSON.parse(readFileSync(file, 'utf8')), skip);
} else if (cmd === 'extras') {
  mergeExtras(JSON.parse(readFileSync(file, 'utf8')));
} else if (cmd === 'done-today') {
  // exit 0 when today's entry already has the job's own NBE read
  const d = (JSON.parse(readFileSync('rates.json', 'utf8')).days || []).find(x => x.date === TODAY);
  process.exit(d && /api\.nbe\.gov\.et/.test(d.nbeSource || '') ? 0 : 1);
} else {
  console.error('usage: update-rates.mjs read | merge <readings.json> | extras <extras.json> | done-today');
  process.exit(2);
}
