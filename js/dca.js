/* dca.js — 定期定額回測引擎（純函式，Node 可載入測試）

   規則與假設（畫面上也會標示，回測最怕默默藏假設）：
   1. 日線一律 UTC 00:00 開盤的一根 K。買入價＝該日「收盤價」（不是當日開盤、也不是均價）——
      收盤價最穩定也最沒有前視偏誤（當日結束才下的單）。
   2. 買入日：每日＝每個交易日；每週＝每週指定星期；每兩週＝指定星期且間隔 ≥13 天；
      每月＝每月 1~28 日（29~31 會自動落在該月最後一天）。指定日若不是交易日、
      或該幣當時還沒上市，就順延到「下一個有資料的日子」，不會憑空消失。
   3. 手續費在每次買入時扣除：幣數量 = 投入金額 ×（1 − 手續費率）/ 買入價。
   4. 加碼（選用）：相對「上一次買入價」或「歷史最高價」每下跌 N%，該期投入多一倍，
      上限可設定。倍數只作用於投入金額，不改變買入日。
   5. 期末市值＝期末收盤價 × 累積持幣，未扣賣出手續費與稅（本工具只做買進回測）。 */

import * as M from './metrics.js';
import { DAY, dow, dom, daysInMonth, addDays, monthStart, addMonths, daysBetween } from './util.js';

export const DEFAULTS = {
  symbol: 'BTCUSDT',
  amount: 300,           // 每期投入（USDT）
  feePct: 0.1,           // 單次手續費 %
  freq: 'monthly',       // daily | weekly | biweekly | monthly
  weekday: 1,            // 1=週一 … 7=週日（ISO）
  monthDay: 1,           // 1~28
  boost: { on: false, mode: 'last', dropPct: 10, mult: 2, cap: 4 }
};

/* ── 買入日排程 ───────────────────────────────────────── */
/* 回傳 candles 的索引陣列（遞增）。
   以「週／月」為單位先算出目標日，再往後找第一個有資料的交易日；
   若找不到（資料缺口）就順延到下一根 K，並用 lastIdx 去重。 */
export function buildSchedule(candles, cfg) {
  const n = candles.length;
  if (!n) return [];
  const out = [];
  const last = n - 1;
  const pushUniq = (i) => { if (i > last) i = last; if (out.length && i <= out[out.length - 1]) return false; out.push(i); return true; };
  /* 回傳「第一個日期 ≥ t」的索引；若 t 已經超過資料尾端則回 -1。
     回 -1 而不是夾到最後一根很重要：否則當使用者的結束日還沒到該期扣款日時，
     系統會偷偷在最後一天補買一筆，憑空多出一期投入。 */
  const findAtOrAfter = (t, from) => {
    if (candles[last].t < t) return -1;
    let lo = Math.max(0, from), hi = last, res = last;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (candles[mid].t >= t) { res = mid; hi = mid - 1; } else lo = mid + 1; }
    return res;
  };

  if (cfg.freq === 'daily') {
    for (let i = 0; i <= last; i++) out.push(i);
    return out;
  }

  if (cfg.freq === 'weekly' || cfg.freq === 'biweekly') {
    const step = cfg.freq === 'weekly' ? 1 : 2;
    /* weekday 用 ISO 編號（1=週一 … 7=週日）；距離「該週週一」的天數就是 iso−1，
       對應 JS getUTCDay()：週一 = 0 天後（dow 1）、週日 = 6 天後（dow 0）。 */
    const off = (((cfg.weekday || 1) - 1) % 7 + 7) % 7;
    /* ISO 週一為一週之始 */
    const mondayOf = (t) => { const d = new Date(t); const s = (d.getUTCDay() + 6) % 7; return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - s); };
    let week = mondayOf(candles[0].t);
    let from = 0;
    const endT = candles[last].t;
    let k = 0;
    while (week <= endT) {
      if (k % step === 0) {
        const target = addDays(week, off);
        if (target < candles[0].t) { week = addDays(week, 7); k++; continue; }  // 早於起始日 → 不扣款
        const i = findAtOrAfter(target, from);
        if (i < 0) break;                     // 目標日已超出資料尾端 → 這期不成立
        pushUniq(i);
        from = i;
      }
      week = addDays(week, 7);
      k++;
    }
    return out;
  }

  /* 每月 */
  const wantDom = Math.max(1, Math.min(31, cfg.monthDay || 1));
  let m = monthStart(candles[0].t);
  let from = 0;
  while (m <= candles[last].t) {
    const dim = daysInMonth(m);
    const target = addDays(m, Math.min(wantDom, dim) - 1);
    if (target < candles[0].t) { m = addMonths(m, 1); continue; }   // 早於起始日 → 不扣款
    const i = findAtOrAfter(target, from);
    if (i < 0) break;                         // 目標日已超出資料尾端 → 這期不成立
    pushUniq(i);
    from = i;
    m = addMonths(m, 1);
  }
  return out;
}

/* ── 主回測 ───────────────────────────────────────────── */
/* candles: [{t, c, ...}] 依時間遞增，已裁切到區間 */
export function runBacktest(candles, cfgIn) {
  const cfg = { ...DEFAULTS, ...cfgIn, boost: { ...DEFAULTS.boost, ...(cfgIn && cfgIn.boost || {}) } };
  const n = candles.length;
  if (n < 2) return { ok: false, err: '此區間沒有足夠的日線資料' };

  const fee = Math.max(0, cfg.feePct) / 100;
  const times = candles.map(c => c.t), prices = candles.map(c => c.c);
  const idxs = buildSchedule(candles, cfg);
  if (!idxs.length) return { ok: false, err: '此區間沒有符合條件的買入日' };

  /* 逐期買入。加碼倍數依「相對上次買入價 / 歷史最高價」的跌幅階梯計算。 */
  const buys = [];
  let cumInvest = 0, cumCoins = 0, lastBuyPrice = NaN, ath = -Infinity;
  for (const i of idxs) {
    const p = prices[i];
    if (p > ath) ath = p;
    let mult = 1;
    if (cfg.boost.on && buys.length) {
      const ref = cfg.boost.mode === 'ath' ? ath : lastBuyPrice;
      const drop = ref > 0 ? 1 - p / ref : 0;
      const stepPct = Math.max(0.01, cfg.boost.dropPct) / 100;
      const steps = drop > 0 ? Math.floor(drop / stepPct) : 0;
      mult = Math.min(Math.max(1, cfg.boost.cap || 1), 1 + steps * (Math.max(1, cfg.boost.mult || 1) - 1));
    }
    const amount = cfg.amount * mult;
    const coins = amount * (1 - fee) / p;
    cumInvest += amount; cumCoins += coins;
    lastBuyPrice = p;
    buys.push({
      idx: i, t: times[i], price: p, mult, base: cfg.amount, amount, coins,
      cumInvest, cumCoins, value: cumCoins * p,
      avgCost: cumInvest / cumCoins, pnl: cumCoins * p - cumInvest
    });
  }

  const buyAt = new Map(buys.map((b, k) => [b.idx, k]));

  /* 逐日序列（NAV：每 1 元投入的單位價值） */
  const invest = new Array(n).fill(0), coins = new Array(n).fill(0);
  let ci = 0, cc = 0, bi = 0;
  for (let i = 0; i < n; i++) {
    while (bi < buys.length && buys[bi].idx === i) { ci = buys[bi].cumInvest; cc = buys[bi].cumCoins; bi++; }
    invest[i] = ci; coins[i] = cc;
  }
  const value = new Array(n), nav = new Array(n), pnl = new Array(n), retPct = new Array(n);
  for (let i = 0; i < n; i++) {
    value[i] = coins[i] * prices[i];
    nav[i] = invest[i] > 0 ? value[i] / invest[i] : NaN;
    pnl[i] = invest[i] > 0 ? value[i] - invest[i] : 0;
    retPct[i] = invest[i] > 0 ? value[i] / invest[i] - 1 : NaN;
  }

  const firstIdx = buys[0].idx, first = buys[0];
  const invested = buys.reduce((s, b) => s + b.amount, 0);
  const finalValue = value[n - 1];
  const totalCoins = coins[n - 1];
  const avgCost = totalCoins > 0 ? invested / totalCoins : NaN;
  const finalPrice = prices[n - 1];
  const totalPnl = finalValue - invested;
  const totalRet = invested > 0 ? finalValue / invested - 1 : NaN;
  const days = Math.max(1, daysBetween(times[firstIdx], times[n - 1]));

  /* 現金流：每期投入為流出，期末市值為流入 */
  const flows = buys.map(b => ({ t: b.t, v: -b.amount }));
  flows.push({ t: times[n - 1], v: finalValue });
  const irr = M.xirr(flows);

  /* 風險指標只看有投入之後的 NAV */
  const navPart = nav.slice(firstIdx), timePart = times.slice(firstIdx);
  const risk = M.riskStats(navPart, timePart);
  const priceRisk = M.riskStats(prices.slice(firstIdx), timePart);

  /* 月報酬（用來算勝率與熱圖） */
  const months = monthlyNav(nav, times, firstIdx);

  /* 期間平均收盤價：用來衡量「分批買進 vs 平均價」的成本優勢 */
  let sumP = 0, cnt = 0;
  for (let i = firstIdx; i < n; i++) { if (prices[i] > 0) { sumP += prices[i]; cnt++; } }
  const periodAvgPrice = cnt ? sumP / cnt : NaN;

  /* 對照組：一次性投入（同樣總額，第一天全數買進） */
  const lump = lumpSum(prices, times, firstIdx, invested, fee);

  return {
    ok: true, cfg, symbol: cfg.symbol,
    times, prices, invest, coins, value, nav, pnl, retPct, buys,
    partial: candles.partial === true,
    sum: {
      invested, finalValue, totalCoins, avgCost, finalPrice, totalPnl, totalRet,
      xirr: irr,
      cagr: M.simpleCagr(finalValue, invested, days),
      twr: risk.annRet,
      days, periods: buys.length,
      firstBuy: first.t, lastBuy: buys[buys.length - 1].t,
      from: times[firstIdx], to: times[n - 1],
      annVol: risk.vol, downside: risk.downside, sharpe: risk.sharpe, sortino: risk.sortino, calmar: risk.calmar,
      posDays: risk.posDays,
      maxDD: risk.dd.maxDD, ddPeak: risk.dd.peakDate, ddTrough: risk.dd.troughDate, ddDays: risk.dd.ddDays,
      underDays: risk.dd.underDays, ddAtEnd: risk.dd.atEnd,
      priceMaxDD: priceRisk.dd.maxDD, priceVol: priceRisk.vol,
      periodAvgPrice,
      costEdge: isFinite(periodAvgPrice) && periodAvgPrice > 0 ? 1 - avgCost / periodAvgPrice : NaN,
      priceFrom: prices[firstIdx], priceRet: prices[n - 1] / prices[firstIdx] - 1,
      bestMonth: months.stats.best, worstMonth: months.stats.worst, monthWin: months.stats.win,
      monthsPositive: months.stats.posCount, monthsTotal: months.stats.count,
      boostBuys: buys.filter(b => b.mult > 1).length,
      boostExtra: invested - buys.length * cfg.amount
    },
    dd: { nav: risk.dd, price: priceRisk.dd },
    months, lump,
    yearly: yearly(nav, times, invest, value, coins, prices, buys, firstIdx, cfg),
    priceBins: priceBins(buys, avgCost)
  };
}

/* ── 一次性投入對照 ───────────────────────────────────── */
export function lumpSum(prices, times, firstIdx, amount, fee) {
  const n = prices.length;
  const c0 = amount * (1 - fee) / prices[firstIdx];
  const value = new Array(n).fill(0), nav = new Array(n).fill(NaN);
  for (let i = firstIdx; i < n; i++) { value[i] = c0 * prices[i]; nav[i] = value[i] / amount; }
  const times2 = times.slice(firstIdx), nav2 = nav.slice(firstIdx);
  const risk = M.riskStats(nav2, times2);
  const days = Math.max(1, daysBetween(times[firstIdx], times[n - 1]));
  return {
    invested: amount, coins: c0, finalValue: value[n - 1],
    totalRet: value[n - 1] / amount - 1, totalPnl: value[n - 1] - amount,
    xirr: days >= 1 ? Math.pow(value[n - 1] / amount, 365 / days) - 1 : NaN,
    annVol: risk.vol, sharpe: risk.sharpe, sortino: risk.sortino, calmar: risk.calmar,
    maxDD: risk.dd.maxDD, underDays: risk.dd.underDays, ddDays: risk.dd.ddDays,
    ddPeak: risk.dd.peakDate, ddTrough: risk.dd.troughDate,
    value, nav, avgCost: prices[firstIdx] / (1 - fee), days
  };
}

/* ── 月 / 年彙總 ──────────────────────────────────────── */
function monthKey(ms) { return new Date(ms).toISOString().slice(0, 7); }

export function monthlyNav(nav, times, firstIdx) {
  const rows = [];
  let cur = null;
  for (let i = firstIdx; i < nav.length; i++) {
    if (!isFinite(nav[i])) continue;
    const k = monthKey(times[i]);
    if (!cur || cur.key !== k) { cur = { key: k, startNav: nav[i], endNav: nav[i], firstIdx: i, lastIdx: i }; rows.push(cur); }
    cur.endNav = nav[i]; cur.lastIdx = i;
  }
  let prev = null;
  for (const r of rows) {
    r.ret = prev && prev.endNav > 0 ? r.endNav / prev.endNav - 1 : NaN;   // 首月以 1−fee 為基準更真實
    prev = r;
  }
  if (rows.length) {
    const base = 1;   // NAV 起點就是 1（買入前）→ 首月報酬用 NAV−1 的前一日基準 1 計算
    rows[0].ret = rows[0].endNav / base - 1;
  }
  const rets = rows.map(r => r.ret).filter(isFinite);
  const best = rows.filter(r => isFinite(r.ret)).sort((a, b) => b.ret - a.ret)[0] || null;
  const worst = rows.filter(r => isFinite(r.ret)).sort((a, b) => a.ret - b.ret)[0] || null;
  return {
    rows,
    stats: {
      count: rets.length, posCount: rets.filter(r => r > 0).length,
      win: rets.length ? rets.filter(r => r > 0).length / rets.length : NaN,
      best: best ? { key: best.key, ret: best.ret } : null,
      worst: worst ? { key: worst.key, ret: worst.ret } : null
    }
  };
}

export function yearly(nav, times, invest, value, coins, prices, buys, firstIdx, cfg) {
  const map = new Map();
  const get = (y) => { if (!map.has(y)) map.set(y, { year: y, invested: 0, periods: 0, cumInvested: 0, endValue: 0, endCoins: 0, endPrice: NaN, startNav: NaN, endNav: NaN, startValue: 0, maxDD: 0 }); return map.get(y); };
  for (const b of buys) { const r = get(new Date(b.t).getUTCFullYear()); r.invested += b.amount; r.periods++; }
  let peak = NaN;
  for (let i = firstIdx; i < nav.length; i++) {
    const r = get(new Date(times[i]).getUTCFullYear());
    r.cumInvested = invest[i]; r.endValue = value[i]; r.endCoins = coins[i]; r.endPrice = prices[i];
    if (!isFinite(r.startNav)) r.startNav = nav[i];
    r.endNav = nav[i];
    if (!isFinite(peak) || nav[i] > peak) peak = nav[i];
    const dd = peak > 0 ? nav[i] / peak - 1 : 0;
    if (dd < r.maxDD) r.maxDD = dd;
  }
  const rows = [...map.values()].sort((a, b) => a.year - b.year);
  let prevEnd = 1 - Math.max(0, cfg.feePct) / 100;
  for (const r of rows) {
    r.ret = prevEnd > 0 ? r.endNav / prevEnd - 1 : NaN;
    r.pnl = r.endValue - r.cumInvested;
    prevEnd = r.endNav;
  }
  return rows;
}

/* ── 買入價位分布 ─────────────────────────────────────── */
export function priceBins(buys, avgCost, binCount = 14) {
  if (!buys.length) return { bins: [], avgCost };
  const ps = buys.map(b => b.price);
  const lo = Math.min(...ps), hi = Math.max(...ps);
  const w = (hi - lo) / binCount || (hi || 1) * 0.01;
  const bins = [];
  for (let i = 0; i < binCount; i++) bins.push({ lo: lo + i * w, hi: lo + (i + 1) * w, mid: lo + (i + 0.5) * w, amount: 0, count: 0 });
  for (const b of buys) {
    let i = Math.floor((b.price - lo) / w);
    if (i >= binCount) i = binCount - 1;
    if (i < 0) i = 0;
    bins[i].amount += b.amount; bins[i].count++;
  }
  const total = buys.reduce((s, b) => s + b.amount, 0);
  for (const b of bins) b.pct = total > 0 ? b.amount / total : 0;
  return { bins, avgCost, lo, hi, total };
}

/* ── 滾動回測：任意起點的定期定額結果分布 ─────────────── */
/* 這是定期定額最值得看的分析：同一套規則，從不同時間點開始，結果差多少。
   mode = 'fixed'：每個起點都跑相同期數（例如每期 300、連續 24 期）
   mode = 'toEnd'：每個起點都跑到資料最後一天
   用買入日排程的前綴累積持幣量，讓每個起點都是 O(1)，因此可以直接掃過全部起點。 */
export function rolling(candles, cfgIn, opts = {}) {
  const cfg = { ...DEFAULTS, ...cfgIn };
  const n = candles.length;
  if (n < 2) return null;
  const fee = Math.max(0, cfg.feePct) / 100;
  const prices = candles.map(c => c.c), times = candles.map(c => c.t);
  const idxs = buildSchedule(candles, { ...cfg, boost: { ...cfg.boost, on: false } });
  const k = idxs.length;
  if (k < 3) return null;

  /* 前綴持幣量與前綴投入：cum[k] = 前 k 期的累計（0-based） */
  const cumCoins = new Array(k + 1).fill(0), cumCash = new Array(k + 1).fill(0);
  for (let i = 0; i < k; i++) {
    cumCoins[i + 1] = cumCoins[i] + cfg.amount * (1 - fee) / prices[idxs[i]];
    cumCash[i + 1] = cumCash[i] + cfg.amount;
  }
  /* 樣本點：為了不讓「每天」的相鄰起點互相重疊到看不出差異，預設每 5 個排程點取一個 */
  const stride = Math.max(1, Math.round(opts.stride || 1));
  const mode = opts.mode || 'fixed';
  const periods = Math.max(2, Math.min(opts.periods || 12, k - 1));
  const rets = [], starts = [];
  const endOf = (s) => mode === 'fixed' ? s + periods : k;
  for (let s = 0; s < k; s += stride) {
    const e = endOf(s);
    if (e > k) break;
    if (e - s < 2) continue;
    const cash = cumCash[e] - cumCash[s];
    const cs = cumCoins[e] - cumCoins[s];
    const exitIdx = idxs[e - 1];               // 用最後一期買入當日的收盤價結算
    const v = cs * prices[exitIdx];
    rets.push(v / cash - 1);
    starts.push({ t: times[idxs[s]], endT: times[exitIdx], invested: cash, value: v, ret: v / cash - 1, periods: e - s });
  }
  if (!rets.length) return null;
  const dist = M.distribution(rets);
  const bins = M.histogram(rets, 26);
  return {
    mode, periods, n: rets.length, rets, starts, dist, bins,
    best: starts[dist.iMax], worst: starts[dist.iMin],
    byPeriods: null
  };
}

/** 一次算好 12/24/36/60 期的分布，供「同一套規則、不同持有期數」對照 */
export function rollingMatrix(candles, cfg, list = [12, 24, 36, 60]) {
  const out = [];
  for (const p of list) {
    const r = rolling(candles, cfg, { mode: 'fixed', periods: p });
    if (r) out.push(r);
  }
  return out;
}

/* ── 區間裁切（含資料時的便利函式）───────────────────── */
export function sliceRange(candles, startMs, endMs) {
  const out = [];
  for (const c of candles) if (c.t >= startMs && c.t <= endMs) out.push(c);
  return out;
}
