// One-off probe: what does each rate source return from a GitHub runner?
import { chromium } from 'playwright';
const pages = [
  'https://nbe.gov.et/',
  'https://ammannforexbureau.com/',
  'https://dbhforex.com/',
  'https://globalforexet.com/',
  'https://roohaforex.net/',
  'https://taypayforexbureau.com/live-exchange-rate/',
];
const plain = ['https://www.waliaforexet.com/api/rates', 'https://haronforex.com/'];
for (const u of plain) {
  try { const r = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0' } }); const t = await r.text();
    console.log(`\n=== PLAIN ${u} ${r.status} len=${t.length}\n${t.slice(0, 1500)}`); }
  catch (e) { console.log(`\n=== PLAIN ${u} ERROR ${e}`); }
}
const browser = await chromium.launch();
for (const u of pages) {
  const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', locale: 'en-US', timezoneId: 'Africa/Addis_Ababa' });
  const page = await ctx.newPage();
  const json = [];
  page.on('response', async (r) => {
    const ct = r.headers()['content-type'] || '';
    if (ct.includes('json')) { try { json.push(`${r.status()} ${r.url()}\n${(await r.text()).slice(0, 1200)}`); } catch {} }
  });
  try {
    const resp = await page.goto(u, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(4000);
    const text = await page.evaluate(() => document.body.innerText);
    console.log(`\n=== PAGE ${u} -> ${page.url()} status=${resp && resp.status()}\n--- TEXT\n${text.replace(/\n{2,}/g, '\n').slice(0, 3500)}\n--- JSON (${json.length})\n${json.join('\n---\n').slice(0, 5000)}`);
  } catch (e) { console.log(`\n=== PAGE ${u} ERROR ${e}\nJSON so far:\n${json.join('\n---\n').slice(0,3000)}`); }
  await ctx.close();
}
await browser.close();
