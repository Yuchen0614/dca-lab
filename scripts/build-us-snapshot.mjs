/* build-us-snapshot.mjs — 產生美股／ETF 的內建快照 data/us/<TICKER>.json

   來源是 Yahoo Finance 的 chart API（建置時可用，瀏覽器端不行）。
   只存「已還原分割、未還原股利」的收盤價，與 Sina 備援路徑的語意一致，
   但在 2006 年之後的區間品質更好（交易日完整、不需要猜分割）。

   格式（盡量小；日期用「距 1970 的天數」整數）：
     { "s":"SOXL", "n":"半導體 3X 做多", "src":"Yahoo Finance", "g":"2026-11-01T...",
       "c":[[13329,0.6605], ...] }

   執行：node scripts/build-us-snapshot.mjs
        node scripts/build-us-snapshot.mjs SOXL TQQQ     # 只更新指定標的
*/
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { US_POPULAR, US_POPULAR_MAP, US_TRUSTED_FROM } from '../js/api-us.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTDIR = join(HERE, '..', 'data', 'us');
const DAY = 86400000;
const FROM = Date.parse(US_TRUSTED_FROM + 'T00:00:00Z');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

async function yahooDaily(ticker, tries = 3) {
  const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`
    + `?period1=0&period2=${Math.floor(Date.now() / 1000)}&interval=1d`;
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (r.status === 429) throw new Error('被限流（429）');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const res = j.chart && j.chart.result && j.chart.result[0];
      if (!res) throw new Error('回應沒有 result');
      const ts = res.timestamp || [], cl = res.indicators.quote[0].close || [];
      const rows = [];
      for (let k = 0; k < ts.length; k++) {
        if (cl[k] == null) continue;
        const t = Math.floor(ts[k] * 1000 / DAY) * DAY;
        if (t < FROM) continue;
        rows.push([t / DAY, Math.round(cl[k] * 10000) / 10000]);
      }
      /* 同一天只留一筆 */
      const seen = new Map();
      for (const r2 of rows) seen.set(r2[0], r2[1]);
      return [...seen.entries()].sort((a, b) => a[0] - b[0]);
    } catch (e) {
      lastErr = e;
      await new Promise(r2 => setTimeout(r2, 1500 * (i + 1)));
    }
  }
  throw lastErr;
}

const only = process.argv.slice(2).map(s => s.toUpperCase());
const list = US_POPULAR.filter(([t]) => !only.length || only.includes(t));
if (!list.length) {
  console.log('沒有符合的標的。可用清單：' + US_POPULAR.map(x => x[0]).join(' '));
  process.exit(1);
}

mkdirSync(OUTDIR, { recursive: true });
let total = 0, fails = [];

for (const [ticker, name] of list) {
  try {
    const c = await yahooDaily(ticker);
    if (c.length < 100) throw new Error(`只有 ${c.length} 筆`);
    const payload = {
      s: ticker, n: name, src: 'Yahoo Finance',
      g: new Date().toISOString(),
      from: new Date(c[0][0] * DAY).toISOString().slice(0, 10),
      to: new Date(c[c.length - 1][0] * DAY).toISOString().slice(0, 10),
      c
    };
    const text = JSON.stringify(payload);
    writeFileSync(join(OUTDIR, `${ticker}.json`), text);
    total += text.length;
    console.log(`  ${ticker.padEnd(6)} ${String(c.length).padStart(5)} 筆  ${payload.from} → ${payload.to}  ${(text.length / 1024).toFixed(0)} KB`);
  } catch (e) {
    fails.push(`${ticker}: ${e.message}`);
    console.log(`  ${ticker.padEnd(6)} 失敗：${e.message}`);
  }
  await new Promise(r => setTimeout(r, 900));      // 對 Yahoo 客氣一點
}

console.log(`\n完成 ${list.length - fails.length}/${list.length}，共 ${(total / 1024).toFixed(0)} KB`);
if (fails.length) {
  console.log('失敗清單：');
  fails.forEach(f => console.log('  ' + f));
  process.exit(1);
}
