/* build-snapshot.mjs — 產生 data/snapshot.json（離線備援資料）
   目的：當使用者的網路到不了交易所（地區封鎖、公司防火牆、CoinGecko 限流）時，
   幾個主流幣種仍然可以直接跑回測，而不是整個站變白畫面。

   格式盡量小：只存收盤價，日期用「距 1970 的天數」整數，讀取端乘回毫秒。
     series: { BTCUSDT: [[20757, 77623.85], ...], ... }

   執行：node scripts/build-snapshot.mjs
*/
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'data', 'snapshot.json');
const DAY = 86400000;
const COINS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'LINKUSDT', 'AVAXUSDT', 'LTCUSDT'];
const BASES = ['https://api.binance.com', 'https://data-api.binance.vision'];

async function klines(symbol, base) {
  const out = [];
  let from = Date.UTC(2017, 0, 1);
  for (let i = 0; i < 12; i++) {
    const r = await fetch(`${base}/api/v3/klines?symbol=${symbol}&interval=1d&limit=1000&startTime=${from}`);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (!Array.isArray(j) || !j.length) break;
    for (const k of j) out.push([Math.round(k[0] / DAY), +k[4]]);
    if (j.length < 1000) break;
    from = j[j.length - 1][0] + DAY;
  }
  return out;
}

const round = (v) => (v >= 1 ? Math.round(v * 100) / 100 : Math.round(v * 1e6) / 1e6);

const series = {};
for (const sym of COINS) {
  let rows = null, err = null;
  for (const b of BASES) {
    try { rows = await klines(sym, b); if (rows.length > 100) break; } catch (e) { err = e; }
  }
  if (!rows || rows.length < 100) { console.log(`  ${sym}: 失敗（${err && err.message}）`); continue; }
  /* 相鄰重複價格壓成一個點沒有意義（會破壞日期對齊），只壓小數位。 */
  series[sym] = rows.map(([d, c]) => [d, round(c)]);
  console.log(`  ${sym}: ${rows.length} 天（${new Date(rows[0][0] * DAY).toISOString().slice(0, 10)} → ${new Date(rows[rows.length - 1][0] * DAY).toISOString().slice(0, 10)}）`);
  await new Promise(r => setTimeout(r, 250));
}

mkdirSync(dirname(OUT), { recursive: true });
const payload = { generated_at: new Date().toISOString(), note: '收盤價日線，日期為距 1970-01-01 的天數。僅作為連不上交易所時的備援。', series };
writeFileSync(OUT, JSON.stringify(payload));
const kb = (JSON.stringify(payload).length / 1024).toFixed(1);
console.log(`data/snapshot.json 已寫入：${Object.keys(series).length} 個幣種、${kb} KB`);
