/* metrics.js — 績效指標數學。全部為純函式，無外部依賴。
   定期定額的幾個關鍵取捨都寫在註解裡，避免日後「看起來對但其實錯」。

   為什麼年化報酬用 XIRR（資金加權）而不是 CAGR：
   定期定額的錢是分批進場的，第一筆錢在場內 5 年、最後一筆只放了 1 個月。
   (期末市值 / 累計投入)^(1/年數) 會把這件事算成「所有錢都放滿全程」，
   在多頭市場嚴重高估、在空頭市場嚴重低估。XIRR 解的是實際現金流的內部報酬率，
   是唯一對「分批投入」誠實的年化數字。CAGR 仍然提供，但只當參考值並明確標示。

   為什麼回撤用 NAV（每 1 元投入的單位價值）而不是資產市值：
   定期定額的市值因為一直有新錢進來，幾乎不可能下跌，畫出來的市值曲線永遠向上，
   回撤會趨近 0，完全沒有意義。把市值除以「截至當日的累計投入」得到 NAV，
   就等價於一檔淨值基金，回撤才是真正承受的痛苦。
   NAV 的定義日：當期買進的幣以「當日收盤價」計價，因此買入不會造成跳空，
   NAV 的日變化純粹來自價格移動，NAV[0] = 1 − 手續費。 */

export const DPY = 365;   // 加密貨幣 24/7，一年 365 天

/* ── 基本統計 ─────────────────────────────────────────── */
export function mean(a) { if (!a.length) return NaN; let s = 0; for (const v of a) s += v; return s / a.length; }

export function stdev(a, sample = true) {
  const n = a.length;
  if (n < 2) return 0;
  const m = mean(a);
  let s = 0;
  for (const v of a) s += (v - m) * (v - m);
  return Math.sqrt(s / (n - (sample ? 1 : 0)));
}

export function sorted(a) { return a.slice().sort((x, y) => x - y); }

/** 線性插值分位數，p 為 0~1 */
export function percentile(a, p) {
  if (!a.length) return NaN;
  const s = sorted(a), i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
}

export function median(a) { return percentile(a, 0.5); }

/* ── XIRR ─────────────────────────────────────────────── */
/* flows: [{ t: 毫秒時間戳, v: 金額（投入為負、期末資產為正） }]
   回傳年化報酬率（0.28 = 28%/年）。無解回傳 NaN。

   解法：先粗掃描找括號（單調區間），再二分收斂。
   不用純 Newton：DCA 的現金流在極端情況（大賠）會讓切線跑到 r < -1 之類的
   無意義區間，Newton 直接发散；掃描＋二分保證一定收斂。 */
export function xirr(flows) {
  if (!flows || flows.length < 2) return NaN;
  const t0 = flows[0].t;
  const pts = flows.map(f => ({ d: (f.t - t0) / 86400000, v: f.v })).filter(f => f.v !== 0);
  if (pts.length < 2) return NaN;
  const hasPos = pts.some(f => f.v > 0), hasNeg = pts.some(f => f.v < 0);
  if (!hasPos || !hasNeg) return NaN;

  const f = (r) => {
    let s = 0;
    for (const p of pts) s += p.v / Math.pow(1 + r, p.d / DPY);
    return s;
  };

  const grid = [];
  for (let r = -0.9999; r < -0.5; r += 0.05) grid.push(r);
  for (let r = -0.5; r <= 5; r += 0.05) grid.push(r);
  for (let r = 5.5; r <= 200; r += 0.5) grid.push(r);

  let lo = NaN, hi = NaN, flo = 0;
  for (let i = 0; i < grid.length; i++) {
    const r = grid[i], v = f(r);
    if (i === 0) { flo = v; continue; }
    if (isFinite(v) && isFinite(flo) && (flo <= 0) !== (v <= 0)) { lo = grid[i - 1]; hi = r; break; }
    flo = v;
  }
  /* 沒有括號（例如期末價值幾乎為 0）：退回最接近 0 的邊界值 */
  if (!isFinite(lo)) return NaN;

  let flo2 = f(lo);
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2, fm = f(mid);
    if (!isFinite(fm)) { hi = mid; continue; }
    if ((flo2 <= 0) !== (fm <= 0)) { hi = mid; } else { lo = mid; flo2 = fm; }
    if (hi - lo < 1e-10) break;
  }
  return (lo + hi) / 2;
}

/** 簡單年化：把「期末市值 / 累計投入」當成單筆報酬再年化（僅供參考，見檔頭說明） */
export function simpleCagr(finalValue, invested, days) {
  if (!(invested > 0) || !(days > 0) || !(finalValue > 0)) return NaN;
  return Math.pow(finalValue / invested, DPY / days) - 1;
}

/** 時間加權年化（NAV 曲線的年化成長率）——排除現金流時點影響，用來算夏普 */
export function twr(navEnd, days) {
  if (!(navEnd > 0) || !(days > 0)) return NaN;
  return Math.pow(navEnd, DPY / days) - 1;
}

/* ── 回撤 ─────────────────────────────────────────────── */
/* 傳入淨值序列（NAV 或價格皆可），回傳最大回撤與水下統計。
   underDays：任一時點距「上一次創新高的天數」的最大值（沒有復原也算，才是真實痛感）。 */
export function drawdown(vals, times) {
  const n = vals.length;
  if (n < 2) return { maxDD: 0, peakIdx: 0, troughIdx: 0, peakDate: null, troughDate: null, ddDays: 0, underDays: 0, atEnd: 0, series: [] };
  const series = new Array(n);
  let peak = vals[0], peakIdx = 0;
  let maxDD = 0, ddPeak = 0, ddTrough = 0, curUnder = 0, underDays = 0, lastPeakIdx = 0;
  for (let i = 0; i < n; i++) {
    if (vals[i] > peak) { peak = vals[i]; peakIdx = i; lastPeakIdx = i; }
    const dd = peak > 0 ? vals[i] / peak - 1 : 0;
    series[i] = dd;
    if (dd < maxDD) { maxDD = dd; ddPeak = peakIdx; ddTrough = i; }
    curUnder = i - lastPeakIdx;
    if (curUnder > underDays) underDays = curUnder;
  }
  const dayOf = (i) => times ? times[i] : null;
  return {
    maxDD,
    peakIdx: ddPeak,
    troughIdx: ddTrough,
    peakDate: dayOf(ddPeak),
    troughDate: dayOf(ddTrough),
    ddDays: ddPeak === ddTrough ? 0 : (times ? Math.round((times[ddTrough] - times[ddPeak]) / 86400000) : ddTrough - ddPeak),
    underDays: times ? underDays : underDays,
    atEnd: series[n - 1],
    series
  };
}

/* ── 淨值曲線的風險指標 ───────────────────────────────── */
/* navs：NAV 序列（等距日線）  times：對應日期（毫秒）
   年化報酬採時間加權（twr），波動採日報酬標準差 × √365。
   夏普與索提諾的無風險利率預設 0（加密貨幣圈慣例，且短天期美債對長期 DCA 影響小）。 */
export function riskStats(navs, times, opts = {}) {
  const rf = opts.rf || 0;
  const n = navs.length;
  if (n < 2) return { annRet: NaN, vol: NaN, sharpe: NaN, sortino: NaN, calmar: NaN, downside: NaN, best: NaN, worst: NaN, posDays: NaN };
  const rets = [];
  for (let i = 1; i < n; i++) {
    const p = navs[i - 1];
    if (p > 0) rets.push(navs[i] / p - 1);
  }
  const days = times ? Math.max(1, Math.round((times[n - 1] - times[0]) / 86400000)) : n - 1;
  const annRet = twr(navs[n - 1], days);
  const vol = stdev(rets) * Math.sqrt(DPY);
  const neg = rets.filter(r => r < 0);
  const downside = neg.length ? Math.sqrt(neg.reduce((s, r) => s + r * r, 0) / neg.length) * Math.sqrt(DPY) : 0;
  const dd = drawdown(navs, times);
  const posDays = rets.length ? rets.filter(r => r > 0).length / rets.length : NaN;
  return {
    annRet,
    vol,
    downside,
    sharpe: vol > 0 ? (annRet - rf) / vol : NaN,
    sortino: downside > 0 ? (annRet - rf) / downside : NaN,
    calmar: dd.maxDD < 0 ? annRet / Math.abs(dd.maxDD) : NaN,
    best: rets.length ? Math.max(...rets) : NaN,
    worst: rets.length ? Math.min(...rets) : NaN,
    posDays,
    days,
    dd
  };
}

/* ── 分布 ─────────────────────────────────────────────── */
/** 等寬分箱，回傳 [{lo, hi, mid, count}] */
export function histogram(vals, binCount = 24) {
  const v = vals.filter(x => isFinite(x));
  if (!v.length) return [];
  const lo = Math.min(...v), hi = Math.max(...v);
  const w = (hi - lo) / binCount || 1;
  const bins = [];
  for (let i = 0; i < binCount; i++) bins.push({ lo: lo + i * w, hi: lo + (i + 1) * w, mid: lo + (i + 0.5) * w, count: 0 });
  for (const x of v) {
    let i = Math.floor((x - lo) / w);
    if (i >= binCount) i = binCount - 1;
    if (i < 0) i = 0;
    bins[i].count++;
  }
  return bins;
}

/** 分布摘要：中位數、平均、極值、正報酬比例、分位數 */
export function distribution(vals) {
  const v = vals.filter(x => isFinite(x));
  if (!v.length) return null;
  const pos = v.filter(x => x > 0).length;
  const iMax = v.indexOf(Math.max(...v)), iMin = v.indexOf(Math.min(...v));
  return {
    n: v.length, mean: mean(v), median: median(v),
    p5: percentile(v, 0.05), p10: percentile(v, 0.1), p25: percentile(v, 0.25),
    p75: percentile(v, 0.75), p90: percentile(v, 0.9), p95: percentile(v, 0.95),
    min: Math.min(...v), max: Math.max(...v), iMin, iMax,
    positive: pos / v.length, stdev: stdev(v)
  };
}
