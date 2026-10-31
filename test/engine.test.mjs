/* engine.test.mjs — 回測引擎驗證
   原則：每一個引擎算出來的數字，都用「另一種寫法」獨立重算一次再比對，
   而不是拿引擎自己的中間值當答案。真實資料直接抓 Binance，確認端到端可用。

   執行：node test/engine.test.mjs
*/
import { runBacktest, buildSchedule, sliceRange, lumpSum, rolling, priceBins, monthlyNav } from '../js/dca.js';
import { xirr, drawdown, riskStats, percentile } from '../js/metrics.js';
import { DAY, parseDay } from '../js/util.js';

let pass = 0, fail = 0;
const eq = (a, b, tol, label) => {
  const d = Math.abs(a - b);
  const ok = isFinite(a) && isFinite(b) ? d <= tol : a === b;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}  got=${a} want=${b} Δ=${d.toExponential(2)} tol=${tol}`);
};
const ok = (cond, label) => { cond ? pass++ : fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`); };

const BASE = 'https://api.binance.com/api/v3/klines';
async function klines(symbol, startMs, endMs) {
  const out = [];
  let from = startMs;
  for (let i = 0; i < 20; i++) {
    const u = `${BASE}?symbol=${symbol}&interval=1d&limit=1000&startTime=${from}` + (endMs ? `&endTime=${endMs}` : '');
    const r = await fetch(u);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (!j.length) break;
    for (const k of j) out.push({ t: k[0], c: +k[4], o: +k[1], h: +k[2], l: +k[3], v: +k[5] });
    if (j.length < 1000) break;
    from = j[j.length - 1][0] + DAY;
    if (endMs && from > endMs) break;
  }
  const seen = new Map();
  for (const c of out) seen.set(c.t, c);
  return [...seen.values()].sort((a, b) => a.t - b.t);
}

/* ══════════════════════════════════════════════════════════
   1. 合成資料：逐日買入，用最笨的迴圈獨立重算
   ══════════════════════════════════════════════════════════ */
console.log('\n[1] 合成序列 — 線性上漲 100→299，每日投入 100，零手續費');
{
  const n = 200, t0 = Date.UTC(2020, 0, 1);
  const candles = Array.from({ length: n }, (_, i) => ({ t: t0 + i * DAY, c: 100 + i }));
  const r = runBacktest(candles, { freq: 'daily', amount: 100, feePct: 0, symbol: 'TEST' });

  let inv = 0, cs = 0, worstDD = 0, peak = -Infinity;
  const navs = [];
  for (let i = 0; i < n; i++) {
    inv += 100; cs += 100 / candles[i].c;
    const v = cs * candles[i].c, nav = v / inv;
    navs.push(nav);
    peak = Math.max(peak, nav);
    worstDD = Math.min(worstDD, nav / peak - 1);
  }
  eq(r.sum.invested, inv, 1e-9, '總投入');
  eq(r.sum.totalCoins, cs, 1e-9, '累積持幣');
  eq(r.sum.finalValue, cs * candles[n - 1].c, 1e-9, '期末市值');
  eq(r.sum.avgCost, inv / cs, 1e-9, '平均成本');
  eq(r.sum.totalRet, (cs * candles[n - 1].c) / inv - 1, 1e-12, '總報酬率');
  eq(r.sum.maxDD, worstDD, 1e-12, '最大回撤（獨立重算 NAV 逐步追蹤）');
  eq(r.sum.periods, n, 1e-9, '買入期數 = 交易日數');
  eq(r.nav[0], 1, 1e-12, 'NAV 起始 = 1（零手續費）');
  eq(r.nav[n - 1], r.sum.finalValue / r.sum.invested, 1e-12, 'NAV 尾端 = 期末市值 / 累計投入');
  /* 線性上漲且零成本 → XIRR 必介於「標的漲幅年化」與「總報酬年化」之間，且為正 */
  ok(r.sum.xirr > 0 && r.sum.xirr < 10, `XIRR 合理 (>0)：${(r.sum.xirr * 100).toFixed(2)}%`);
  const npv = r.buys.reduce((s, b) => s + -b.amount / Math.pow(1 + r.sum.xirr, (b.t - r.buys[0].t) / DAY / 365), 0)
    + r.sum.finalValue / Math.pow(1 + r.sum.xirr, (r.times[n - 1] - r.buys[0].t) / DAY / 365);
  eq(npv, 0, 1e-6, 'XIRR 的 NPV ≈ 0（把解代回現金流驗算）');
}

/* ══════════════════════════════════════════════════════════
   2. 指標單元測試
   ══════════════════════════════════════════════════════════ */
console.log('\n[2] 指標單元測試');
{
  const t0 = Date.UTC(2020, 0, 1);
  eq(xirr([{ t: t0, v: -1000 }, { t: t0 + 365 * DAY, v: 1100 }]), 0.1, 1e-6, '單筆一年 +10% → XIRR = 10%');
  eq(xirr([{ t: t0, v: -1000 }, { t: t0 + 2 * 365 * DAY, v: 1210 }]), 0.1, 1e-6, '單筆兩年 +21% → XIRR = 10%');
  eq(xirr([{ t: t0, v: -1000 }, { t: t0 + 365 * DAY, v: 500 }]), -0.5, 1e-6, '單筆一年 −50% → XIRR = −50%');
  ok(!isFinite(xirr([{ t: t0, v: -100 }])), '單向現金流無解 → NaN');

  const dd = drawdown([1, 1.2, 0.9, 1.3], [t0, t0 + DAY, t0 + 2 * DAY, t0 + 3 * DAY]);
  eq(dd.maxDD, 0.9 / 1.2 - 1, 1e-12, '回撤 −25%（1.2 → 0.9）');
  eq(dd.peakIdx, 1, 0, '回撤起點索引');
  eq(dd.troughIdx, 2, 0, '回撤谷底索引');
  eq(dd.underDays, 1, 0, '最長水下天數（1.3 已創新高，只有 0.9 那一天在水下）');

  const rs = riskStats(Array.from({ length: 366 }, (_, i) => 1 + i * 0.0), null);
  eq(rs.vol, 0, 1e-12, '恆定淨值 → 波動 0');
  ok(!isFinite(rs.sharpe) || rs.sharpe === 0, '恆定淨值 → 夏普無意義（NaN 或 0）');
  eq(percentile([1, 2, 3, 4, 5], 0.5), 3, 1e-12, '中位數');
  eq(percentile([1, 2, 3, 4], 0.5), 2.5, 1e-12, '偶數筆中位數（線性插值）');
}

/* ══════════════════════════════════════════════════════════
   3. 恆定價格：零手續費 → XIRR ≈ 0；含手續費 → XIRR ≈ −手續費
   ══════════════════════════════════════════════════════════ */
console.log('\n[3] 恆定價格 100 → 定期定額的報酬必須只反映手續費');
{
  const n = 400, t0 = Date.UTC(2020, 0, 1);
  const candles = Array.from({ length: n }, (_, i) => ({ t: t0 + i * DAY, c: 100 }));
  const free = runBacktest(candles, { freq: 'monthly', monthDay: 1, amount: 300, feePct: 0 });
  eq(free.sum.totalRet, 0, 1e-12, '零手續費 → 總報酬 0');
  eq(free.sum.xirr, 0, 1e-9, '零手續費 → XIRR 0');
  eq(free.sum.maxDD, 0, 1e-12, '零手續費 → 回撤 0');

  const fee = runBacktest(candles, { freq: 'monthly', monthDay: 1, amount: 300, feePct: 0.1 });
  eq(fee.sum.totalRet, -0.001, 1e-12, '0.1% 手續費 → 總報酬 −0.1%');
  ok(fee.sum.xirr > -0.002 && fee.sum.xirr < 0, `XIRR 略為負：${(fee.sum.xirr * 100).toFixed(4)}%`);
  eq(fee.sum.avgCost, 100 / 0.999, 1e-9, '平均成本 = 價格 /（1 − 手續費）');
}

/* ══════════════════════════════════════════════════════════
   4. 排程規則（月份 31 日、週一、每兩週）
   ══════════════════════════════════════════════════════════ */
console.log('\n[4] 買入日排程');
{
  const t0 = Date.UTC(2021, 0, 1), n = 400;
  const candles = Array.from({ length: n }, (_, i) => ({ t: t0 + i * DAY, c: 100 + i * 0.1 }));
  const iso = (t) => new Date(t).toISOString().slice(0, 10);

  const m31 = buildSchedule(candles, { freq: 'monthly', monthDay: 31 }).map(i => candles[i].t);
  ok(m31.every(t => { const d = new Date(t); const dim = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); return d.getUTCDate() === Math.min(31, dim); }),
    `每月 31 日 → 一律落在當月最後一天（${m31.slice(0, 4).map(iso).join(', ')} …）`);
  ok(m31.length === 13, `2021-01 ~ 2022-01 共 13 個完整月 → ${m31.length} 期（2022-02 的 28 日還沒到，不憑空補買）`);

  /* 起始日不是扣款日 → 首筆順延到下一次扣款日，不會在起始日硬買 */
  const mid = buildSchedule(candles.slice(14), { freq: 'monthly', monthDay: 1 }).map(i => candles[14 + i].t);
  eq(iso(mid[0]), '2021-02-01', 0, '2021-01-15 起、每月 1 日 → 首筆 2021-02-01');

  const w = buildSchedule(candles, { freq: 'weekly', weekday: 1 }).map(i => candles[i].t);
  ok(w.every(t => new Date(t).getUTCDay() === 1), `每週一買入，全部落在週一（${w.slice(0, 3).map(iso).join(', ')} …）共 ${w.length} 期`);
  const gaps = w.slice(1).map((t, i) => (t - w[i]) / DAY);
  ok(gaps.every(g => g === 7), `每週間隔皆為 7 天（min ${Math.min(...gaps)} / max ${Math.max(...gaps)}）`);

  const b = buildSchedule(candles, { freq: 'biweekly', weekday: 1 }).map(i => candles[i].t);
  const bg = b.slice(1).map((t, i) => (t - b[i]) / DAY);
  ok(bg.every(g => g === 14), `每兩週間隔皆為 14 天（min ${Math.min(...bg)} / max ${Math.max(...bg)}）`);

  const d = buildSchedule(candles, { freq: 'daily' });
  ok(d.length === n, '每日 → 每個交易日都買');
}

/* ══════════════════════════════════════════════════════════
   5. 真實資料端到端 — BTC，2021-01-01 起每月 300 USDT
   ══════════════════════════════════════════════════════════ */
console.log('\n[5] 真實資料（Binance BTCUSDT 日線）— 每月 1 日投入 300 USDT（手續費 0.1%）');
let btc = [];
try {
  btc = await klines('BTCUSDT', Date.UTC(2021, 0, 1));
  console.log(`  取得 ${btc.length} 根日線：${isoOf(btc[0].t)} → ${isoOf(btc[btc.length - 1].t)}`);
} catch (e) {
  console.log('  資料抓取失敗：' + e.message + '（略過真實資料測試）');
}
function isoOf(t) { return new Date(t).toISOString().slice(0, 10); }

if (btc.length > 100) {
  const r = runBacktest(btc, { freq: 'monthly', monthDay: 1, amount: 300, feePct: 0.1, symbol: 'BTCUSDT' });

  /* 獨立重算：不看引擎的 buys，自己按「每月第一個交易日」走一遍 */
  let inv = 0, cs = 0, periods = 0, lastMonth = '';
  for (const c of btc) {
    const mk = new Date(c.t).toISOString().slice(0, 7);
    if (mk !== lastMonth) { lastMonth = mk; const amt = 300; inv += amt; cs += amt * 0.999 / c.c; periods++; }
  }
  eq(r.sum.invested, inv, 1e-6, '總投入（獨立重算）');
  eq(r.sum.periods, periods, 0, '期數（獨立重算 每月一次）');
  eq(r.sum.totalCoins, cs, 1e-8, '累積 BTC 數量（獨立重算）');
  eq(r.sum.finalValue, cs * btc[btc.length - 1].c, 1e-6, '期末市值');
  eq(r.sum.avgCost, inv / cs, 1e-8, '平均成本');
  eq(r.sum.totalRet, r.sum.finalValue / inv - 1, 1e-12, '總報酬率');
  eq(r.sum.priceRet, btc[btc.length - 1].c / btc[0].c - 1, 1e-12, '標的同期價格報酬');

  /* 回撤獨立重算：先用前綴和展開每日的累計投入與持幣，再逐步追蹤峰值 */
  const buyIdx = [];
  { let lm = ''; for (let i = 0; i < btc.length; i++) { const mk = new Date(btc[i].t).toISOString().slice(0, 7); if (mk !== lm) { lm = mk; buyIdx.push(i); } } }
  const buySet = new Set(buyIdx);
  let ccs = 0, iinv = 0, peak = -Infinity, worst = 0;
  for (let i = 0; i < btc.length; i++) {
    if (buySet.has(i)) { iinv += 300; ccs += 300 * 0.999 / btc[i].c; }
    if (!iinv) continue;
    const nav = ccs * btc[i].c / iinv;
    peak = Math.max(peak, nav); worst = Math.min(worst, nav / peak - 1);
  }
  eq(r.sum.maxDD, worst, 1e-12, '最大回撤（獨立重算 NAV）');

  /* 對照組：一次性投入 */
  const ls = lumpSum(btc.map(c => c.c), btc.map(c => c.t), 0, inv, 0.001);
  eq(ls.finalValue, inv * 0.999 / btc[0].c * btc[btc.length - 1].c, 1e-6, '一次性投入期末市值');
  eq(ls.totalRet, (btc[btc.length - 1].c / btc[0].c) * 0.999 - 1, 1e-9, '一次性投入總報酬（價格漲幅先扣 0.1% 手續費）');

  /* 月報酬統計：勝率必須等於「正的月數 / 總月數」 */
  const my = monthlyNav(r.nav, r.times, r.buys[0].idx);
  eq(my.stats.win, my.rows.filter(x => x.ret > 0).length / my.rows.length, 1e-12, '月勝率 = 正報酬月數 / 總月數');
  ok(my.rows.length >= periods - 1, `月報酬列數合理（${my.rows.length}）`);

  /* 滾動回測：抽樣用最笨的方式獨立重算 */
  const rl = rolling(btc, { freq: 'monthly', monthDay: 1, amount: 300, feePct: 0.1 }, { mode: 'fixed', periods: 24 });
  ok(rl && rl.n > 20, `滾動回測樣本數 ${rl ? rl.n : 0}`);
  if (rl) {
    const s = rl.starts[5];
    let a = 0, c2 = 0, k = 0;
    let lm = '', started = false;
    for (const c of btc) {
      if (c.t === s.t) started = true;
      if (!started) continue;
      const mk = new Date(c.t).toISOString().slice(0, 7);
      if (mk !== lm) { lm = mk; a += 300; c2 += 300 * 0.999 / c.c; k++; }
      if (c.t === s.endT) { const v = c2 * c.c; eq(s.ret, v / a - 1, 1e-9, `滾動樣本 #5（${isoOf(s.t)} 起 ${k} 期）獨立重算`); break; }
    }
    eq(rl.dist.median, percentile(rl.rets, 0.5), 1e-12, '滾動中位數');
    ok(rl.dist.positive >= 0 && rl.dist.positive <= 1, `滾動正報酬比例 ${(rl.dist.positive * 100).toFixed(1)}%`);
    ok(rl.best.ret >= rl.dist.median && rl.worst.ret <= rl.dist.median, '最好 / 最差起點包夾中位數');
  }

  /* 價位分布：金額必須守恆 */
  const pb = priceBins(r.buys, r.sum.avgCost);
  eq(pb.bins.reduce((s, b) => s + b.amount, 0), r.sum.invested, 1e-6, '價位分布金額加總 = 總投入');

  /* 逐年 */
  eq(r.yearly.reduce((s, y) => s + y.invested, 0), r.sum.invested, 1e-6, '年度投入加總 = 總投入');
  eq(r.yearly[r.yearly.length - 1].endValue, r.sum.finalValue, 1e-6, '末年期末市值 = 期末市值');

  /* 加碼規則 */
  const rb = runBacktest(btc, { freq: 'monthly', monthDay: 1, amount: 300, feePct: 0.1, boost: { on: true, mode: 'last', dropPct: 10, mult: 2, cap: 4 } });
  ok(rb.sum.invested > r.sum.invested && rb.sum.boostBuys > 0, `跌價加碼生效：投入 ${r.sum.invested.toFixed(0)} → ${rb.sum.invested.toFixed(0)}，加碼 ${rb.sum.boostBuys} 期`);

  console.log('\n  ── BTC 每月 300 USDT 實測結果 ──');
  console.log(`  期間        ${isoOf(r.sum.from)} → ${isoOf(r.sum.to)}（${r.sum.days} 天，${r.sum.periods} 期）`);
  console.log(`  總投入      ${r.sum.invested.toFixed(2)} USDT`);
  console.log(`  期末市值    ${r.sum.finalValue.toFixed(2)} USDT（${r.sum.totalCoins.toFixed(6)} BTC）`);
  console.log(`  總報酬      ${(r.sum.totalRet * 100).toFixed(2)}%`);
  console.log(`  年化 XIRR   ${(r.sum.xirr * 100).toFixed(2)}%   TWR ${(r.sum.twr * 100).toFixed(2)}%   簡單年化 ${(r.sum.cagr * 100).toFixed(2)}%`);
  console.log(`  最大回撤    ${(r.sum.maxDD * 100).toFixed(2)}%（${isoOf(r.sum.ddPeak)} → ${isoOf(r.sum.ddTrough)}，歷時 ${r.sum.ddDays} 天）`);
  console.log(`  波動/夏普   ${(r.sum.annVol * 100).toFixed(1)}% / ${r.sum.sharpe.toFixed(2)}`);
  console.log(`  平均成本    ${r.sum.avgCost.toFixed(0)} vs 期間均價 ${r.sum.periodAvgPrice.toFixed(0)}（成本優勢 ${(r.sum.costEdge * 100).toFixed(2)}%）`);
  console.log(`  月勝率      ${(r.sum.monthWin * 100).toFixed(1)}%（${r.sum.monthsPositive}/${r.sum.monthsTotal}）`);
  console.log(`  一次性投入  ${(ls.totalRet * 100).toFixed(2)}%（回撤 ${(ls.maxDD * 100).toFixed(2)}%）`);
}

console.log(`\n═══════════════════════════════════════\n  通過 ${pass} · 失敗 ${fail}\n═══════════════════════════════════════`);
process.exit(fail ? 1 : 0);
