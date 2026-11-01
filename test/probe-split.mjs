/* probe-split.mjs — 挑選分割判定門檻用的調查腳本
   對每個事件印出：價格比（前收/開盤）、成交量比（event/前 20 日中位數）、
   以及各候選比例在「價格」與「成交量」上的契合度。
   真分割日：成交量會隨股數等比放大（≈ 比例）；市場暴走日：成交量與比例無關。
*/
import { parseRows } from '../js/api-us.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

async function sina(ticker) {
  const u = `https://stock.finance.sina.com.cn/usstock/api/jsonp.php/var%20D=/US_MinKService.getDailyK?symbol=${ticker}&___qn=3`;
  const r = await fetch(u);
  const t = await r.text();
  return parseRows(JSON.parse(t.slice(t.indexOf('=(') + 2, t.lastIndexOf(')'))));
}
async function yahooSplits(ticker) {
  const u = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=max&interval=1d&events=split`;
  const r = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  const j = await r.json();
  const ev = j.chart?.result?.[0]?.events?.splits || {};
  return Object.values(ev).map(x => ({ date: new Date(x.date * 1000).toISOString().slice(0, 10), ratio: x.numerator / x.denominator }));
}

/* 已知的極端日（真實市場事件，不能被誤判成分割） */
const EXTREME = [
  ['SOXL', '2025-04-09'], ['SOXL', '2020-03-16'], ['SOXL', '2020-03-24'],
  ['GME', '2021-01-29'], ['GME', '2021-02-02'], ['TQQQ', '2020-03-16'], ['TQQQ', '2025-04-09'],
  ['TSLA', '2020-02-03'], ['NVDA', '2024-02-22'], ['COIN', '2021-04-14'], ['MSTR', '2024-11-21']
];

function stats(rows, i) {
  const prev = rows[i - 1], cur = rows[i];
  const vols = rows.slice(Math.max(0, i - 20), i).map(r => r.v).filter(v => v > 0).sort((a, b) => a - b);
  const medV = vols.length ? vols[Math.floor(vols.length / 2)] : NaN;
  return {
    d: cur.d, prevC: prev.c, o: cur.o, c: cur.c, v: cur.v,
    priceRatio: prev.c / cur.o, volRatio: cur.v / medV,
    rawDayRet: cur.c / prev.c - 1
  };
}

console.log('══ 真實分割日（Yahoo 官方事件）══');
for (const tk of ['SOXL', 'TQQQ', 'NVDA', 'AAPL', 'TSLA', 'MSFT', 'AMZN']) {
  const rows = await sina(tk);
  const idx = new Map(rows.map((r, i) => [r.d, i]));
  const ys = await yahooSplits(tk);
  for (const s of ys) {
    /* ex-date 在 Sina 資料裡的日期可能差一天（Yahoo 給的是生效日） */
    let i = idx.get(s.date);
    if (i == null) i = idx.get(new Date(Date.parse(s.date) + 86400000).toISOString().slice(0, 10));
    if (i == null || i < 21) { console.log(`  ${tk} ${s.date} 比例 ${s.ratio} → Sina 找不到對應日期，略過`); continue; }
    const st = stats(rows, i);
    console.log(`  ${tk.padEnd(5)} ${s.date} 官方比例 ${String(s.ratio).padEnd(4)} | 價格比 ${st.priceRatio.toFixed(3)}（誤差 ${((st.priceRatio / s.ratio - 1) * 100).toFixed(1)}%）| 量比 ${st.volRatio.toFixed(2)}（/比例 = ${(st.volRatio / s.ratio).toFixed(2)}）| 當日原始報酬 ${(st.rawDayRet * 100).toFixed(1)}%`);
  }
}

console.log('\n══ 極端市場日（不能被當成分割）══');
for (const [tk, d] of EXTREME) {
  const rows = await sina(tk);
  const i = rows.findIndex(r => r.d === d);
  if (i < 21) { console.log(`  ${tk} ${d} 找不到`); continue; }
  const st = stats(rows, i);
  const cands = [2, 3, 4, 5, 8, 10, 15, 20, 1.5, 1 / 2, 1 / 3, 1 / 4, 1 / 1.5];
  const best = cands.map(f => ({ f, pe: Math.abs(st.priceRatio / f - 1), ve: Math.abs(st.volRatio / f - 1) }))
    .sort((a, b) => a.pe - b.pe).slice(0, 3);
  console.log(`  ${tk.padEnd(5)} ${d} | 價格比 ${st.priceRatio.toFixed(3)} 量比 ${st.volRatio.toFixed(2)} | 原始報酬 ${(st.rawDayRet * 100).toFixed(1)}% | 最接近的候選 ${best.map(b => `${b.f}(價誤差${(b.pe * 100).toFixed(0)}% 量比偏差${(b.ve * 100).toFixed(0)}%)`).join(' ')}`);
}
