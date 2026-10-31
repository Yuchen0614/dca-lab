/* xirr-crosscheck.mjs — 用「另一種演算法」重算年化報酬，確認引擎的 XIRR 沒問題
   引擎用「掃描找括號 + 二分法」；這裡用 Newton-Raphson（數值微分），
   兩種方法若收斂到同一個根，就代表解是對的，不是演算法假象。
   另外把 NPV 代回去驗算，確認 ≈ 0。

   執行：node test/xirr-crosscheck.mjs
*/
import { runBacktest, sliceRange } from '../js/dca.js';
import { xirr } from '../js/metrics.js';

const DAY = 86400000;
async function klines(symbol) {
  const out = []; let from = Date.UTC(2017, 0, 1);
  for (let i = 0; i < 12; i++) {
    const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&limit=1000&startTime=${from}`);
    const j = await r.json();
    if (!j.length) break;
    for (const k of j) out.push({ t: k[0], c: +k[4] });
    if (j.length < 1000) break;
    from = j[j.length - 1][0] + DAY;
  }
  return out;
}

/* Newton-Raphson：f(r)=Σ CF/(1+r)^(d/365)，f' 用中心差分 */
function newton(flows, guess = 0.2) {
  const t0 = flows[0].t;
  const pts = flows.map(f => [ (f.t - t0) / DAY / 365, f.v ]);
  const f = (r) => pts.reduce((s, [d, v]) => s + v / Math.pow(1 + r, d), 0);
  let r = guess;
  for (let i = 0; i < 200; i++) {
    const h = 1e-6;
    const d1 = (f(r + h) - f(r - h)) / (2 * h);
    if (!isFinite(d1) || Math.abs(d1) < 1e-14) break;
    let nr = r - f(r) / d1;
    if (!isFinite(nr) || nr <= -0.9999 || nr > 1000) nr = (r + (nr <= -0.9999 ? -0.9999 : 1000)) / 2;   // 阻尼
    const done = Math.abs(nr - r) < 1e-13;
    r = nr;
    if (done) break;
  }
  return r;
}

const btc = await klines('BTCUSDT');
console.log(`BTCUSDT ${btc.length} 根日線：${new Date(btc[0].t).toISOString().slice(0,10)} → ${new Date(btc[btc.length-1].t).toISOString().slice(0,10)}\n`);

const cases = [
  { label: '每月 1 日 300U，零手續費', cfg: { freq: 'monthly', monthDay: 1, amount: 300, feePct: 0 } },
  { label: '每月 1 日 300U，0.1% 手續費', cfg: { freq: 'monthly', monthDay: 1, amount: 300, feePct: 0.1 } },
  { label: '每週一 100U，0.1% 手續費', cfg: { freq: 'weekly', weekday: 1, amount: 100, feePct: 0.1 } },
  { label: '每日 10U，0.1% 手續費（近 3 年）', cfg: { freq: 'daily', amount: 10, feePct: 0.1, from: Date.UTC(2023, 10, 1) } }
];

let bad = 0;
for (const c of cases) {
  const candles = c.cfg.from ? sliceRange(btc, c.cfg.from, Date.now()) : btc;
  const r = runBacktest(candles, c.cfg);
  const flows = r.buys.map(b => ({ t: b.t, v: -b.amount }));
  flows.push({ t: r.times[r.times.length - 1], v: r.sum.finalValue });
  const nw = newton(flows);
  const bi = xirr(flows);
  const diff = Math.abs(nw - bi);
  /* 主要判準是「把解代回現金流的淨現值」：兩種演算法講好也可能一起錯，
     NPV 殘差才是真正的證據。 */
  const t0 = flows[0].t;
  const npvOf = (rr) => flows.reduce((s, f) => s + f.v / Math.pow(1 + rr, (f.t - t0) / DAY / 365), 0);
  const npv = npvOf(bi), relNpv = Math.abs(npv) / r.sum.invested;
  const okv = diff < 1e-7 && relNpv < 1e-9;
  if (!okv) bad++;
  console.log(`${okv ? 'PASS' : 'FAIL'}  ${c.label}`);
  console.log(`      二分法 XIRR ${(bi * 100).toFixed(6)}%    Newton XIRR ${(nw * 100).toFixed(6)}%   Δ=${diff.toExponential(2)}`);
  console.log(`      NPV 殘差 ${npv.toExponential(2)}（相對投入 ${relNpv.toExponential(1)}） · 總投入 ${r.sum.invested.toFixed(0)} · 期末 ${r.sum.finalValue.toFixed(0)} · 期數 ${r.sum.periods}`);
}
console.log(bad ? `\n${bad} 項不一致` : '\n兩種演算法結果一致 ✓');
process.exit(bad ? 1 : 0);
