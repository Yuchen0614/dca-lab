/* probe-us.mjs — 一次性調查工具（不是自動化測試）
   用途：印出可疑日期附近的原始資料，並試著從 Yahoo 取分割事件當作獨立參考。
   執行：node test/probe-us.mjs [TICKER] [DATE]
*/
import { parseRows, detectSplits, applySplits } from '../js/api-us.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

async function sina(ticker) {
  const u = `https://stock.finance.sina.com.cn/usstock/api/jsonp.php/var%20D=/US_MinKService.getDailyK?symbol=${ticker}&___qn=3`;
  const r = await fetch(u);
  const t = await r.text();
  return parseRows(JSON.parse(t.slice(t.indexOf('=(') + 2, t.lastIndexOf(')'))));
}

async function yahoo(ticker) {
  const u = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=max&interval=1d&events=split`;
  const r = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!r.ok) throw new Error('Yahoo HTTP ' + r.status);
  const j = await r.json();
  const ev = j.chart?.result?.[0]?.events?.splits || {};
  return Object.values(ev).map(s => ({
    date: new Date(s.date * 1000).toISOString().slice(0, 10),
    num: s.numerator, den: s.denominator, ratio: s.numerator / s.denominator
  }));
}

const ticker = process.argv[2] || 'NVDA';
const around = process.argv[3] || null;

const rows = await sina(ticker);
console.log(`\n=== ${ticker}：Sina ${rows.length} 筆，${rows[0].d} → ${rows[rows.length - 1].d} ===`);
const det = detectSplits(rows);
console.log('自動偵測：');
for (const s of det) {
  const prev = rows[s.i - 1], cur = rows[s.i];
  console.log(`  ${s.date} 比例 ${s.factor}（前收 ${prev.c} / 開盤 ${cur.o} = ${s.ratio.toFixed(3)}）`);
}

if (around) {
  const i = rows.findIndex(r => r.d === around);
  console.log(`\n原始資料 ${around} 前後：`);
  rows.slice(Math.max(0, i - 4), i + 4).forEach(r => console.log(`  ${r.d}  o ${r.o}  h ${r.h}  l ${r.l}  c ${r.c}  v ${r.v}`));
}

try {
  const y = await yahoo(ticker);
  console.log('\nYahoo 官方分割事件（獨立參考）：');
  for (const s of y) console.log(`  ${s.date}  ${s.num}:${s.den}  = ${s.ratio}`);
  /* 比對 */
  const mine = new Map(det.map(s => [s.date, Math.round(s.factor * 1000) / 1000]));
  const theirs = new Map(y.map(s => [s.date, Math.round(s.ratio * 1000) / 1000]));
  console.log('\n差異：');
  console.log('  只有我偵測到：', [...mine.keys()].filter(d => !theirs.has(d)).join(', ') || '無');
  console.log('  只有 Yahoo 有：', [...theirs.keys()].filter(d => !mine.has(d)).join(', ') || '無');
  for (const d of [...mine.keys()].filter(d => theirs.has(d))) {
    if (Math.abs(mine.get(d) - theirs.get(d)) > 0.02) console.log(`  比例不同 ${d}：我 ${mine.get(d)} / Yahoo ${theirs.get(d)}`);
  }
} catch (e) {
  console.log('\nYahoo 取用失敗：' + e.message);
}

const { rows: adj } = applySplits(rows);
const jumps = [];
for (let i = 1; i < adj.length; i++) {
  const r = adj[i].c / adj[i - 1].c - 1;
  if (Math.abs(r) > 0.45) jumps.push(`${new Date(adj[i].t).toISOString().slice(0, 10)} ${(r * 100).toFixed(1)}%`);
}
console.log('\n還原後仍存在 >45% 的單日跳動：', jumps.join(' · ') || '無');
