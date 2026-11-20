// Probe 2: Haron text, NBE rate pages, Ammann's other domain, plain API reads.
import { chromium } from 'playwright';
const plain = ['https://www.globalforexet.com/api/public-exchange-rates','https://www.roohaforex.net/api/public-exchange-rates','https://api.nbe.gov.et/api/get-selected-exchange-rates','https://dbh.gudalabs.com/api/currencyrates'];
for (const u of plain) {
  try { const r = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0', accept: 'application/json' } }); const t = await r.text();
    console.log(`\n=== PLAIN ${u} ${r.status} len=${t.length}\n${t.slice(0, 400)}`); }
  catch (e) { console.log(`\n=== PLAIN ${u} ERROR ${e}`); }
}
const browser = await chromium.launch();
async function visit(u, fn) {
  const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', timezoneId: 'Africa/Addis_Ababa' });
  const page = await ctx.newPage(); const json = [];
  page.on('response', async (r) => { const ct = r.headers()['content-type'] || ''; if (ct.includes('json') && !r.url().includes('google')) { try { json.push(`${r.url()}\n${(await r.text()).slice(0, 2500)}`); } catch {} } });
  try { const resp = await page.goto(u, { waitUntil: 'networkidle', timeout: 60000 }); await page.waitForTimeout(3000);
    console.log(`\n=== PAGE ${u} -> ${page.url()} ${resp && resp.status()}`); await fn(page);
    console.log(`--- JSON\n${json.join('\n---\n').slice(0, 6000)}`);
  } catch (e) { console.log(`\n=== PAGE ${u} ERROR ${e}`); }
  await ctx.close();
}
await visit('https://haronforex.com/', async (p) => { const t = await p.evaluate(() => document.body.innerText); const i = t.search(/USD|Dollar/i); console.log(t.replace(/\n{2,}/g,'\n').slice(Math.max(0,i-800), i+2500)); });
await visit('https://nbe.gov.et/', async (p) => { const l = await p.evaluate(() => [...document.querySelectorAll('a')].map(a => a.textContent.trim().slice(0,60)+' | '+a.href).filter(s => /exchange|rate/i.test(s))); console.log([...new Set(l)].join('\n')); });
await visit('https://ammannforex.com/', async (p) => { const t = await p.evaluate(() => document.body.innerText); console.log(t.slice(0, 2500)); });
await browser.close();
