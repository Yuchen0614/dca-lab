/* app.js — 介面、狀態與渲染
   資料只抓一次（整個幣種的完整日線），之後改期間／金額／頻率都只在本機重算，
   所以調整參數是即時的、不需要再連網。 */

import * as api from './api.js';
import * as dca from './dca.js';
import * as U from './util.js';
import { mount } from './charts.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const DAY = U.DAY;

const PAL = { cy: '#5b8dff', up: '#0ecb81', down: '#f6465d', am: '#f0b90b', mg: '#a78bfa', dim: '#63799a', tx: '#93a7c0' };
const TOP_CHIPS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'SUIUSDT', 'LINKUSDT'];

const state = {
  sym: 'BTCUSDT', amt: 300, cur: 'USD', fee: 0.1, freq: 'monthly', weekday: 1, monthDay: 1,
  range: 'all', start: null, end: null,
  boost: { on: false, mode: 'last', dropPct: 10, mult: 2, cap: 4 },
  rollMode: 'fixed', rollP: 24
};

let allCandles = [];
let fx = 32, fxReady = false;
let universe = [];
let res = null, roll = null, partial = false;
let loading = false, lastErr = null;

/* ── 顯示幣別 ───────────────────────────────────────── */
const cu = () => (state.cur === 'TWD' ? fx : 1);
const cs = () => (state.cur === 'TWD' ? 'NT$' : '$');
const money = (v, dp = 0) => (isFinite(v) ? cs() + U.fmt(v * cu(), dp) : '—');
const mShort = (v) => (isFinite(v) ? U.fmtShort(v * cu(), cs()) : '—');
const axShort = (v) => U.fmtShort(v, '');
/* 座標軸的單位必須整條軸一致：混用「20.0萬 / 10.0萬 / 0.00」看起來像三個不同的量級。
   所以先看軸的最大值決定單位，再讓所有刻度都用同一個單位。 */
function axFmt(maxV) {
  const a = Math.abs(maxV);
  const unit = a >= 1e8 ? 1e8 : a >= 1e4 ? 1e4 : a >= 1e3 ? 1e3 : 1;
  const suffix = unit === 1e8 ? '億' : unit === 1e4 ? '萬' : unit === 1e3 ? 'K' : '';
  const dp = unit === 1e8 ? (a >= 1e9 ? 1 : 2) : unit === 1 ? (a >= 10 ? 0 : a >= 1 ? 1 : 2) : (a / unit >= 100 ? 0 : 1);
  return v => (v === 0 ? '0' : (v / unit).toFixed(dp) + suffix);   // 0 不需要單位，「0.0萬」很怪
}
const price = (v) => (isFinite(v) ? cs() + U.fmtPrice(v * cu()) : '—');
/* 價格軸：四位以上的千分位小數太長會撞到繪圖區，四位以上直接去掉小數 */
const axPrice = (v) => (Math.abs(v) >= 1000 ? U.fmt(v, 0) : U.fmtPrice(v));
const pct = (v, dp = 2) => U.fmtPct(v, dp);
const cls = (v, flip) => (isFinite(v) ? (v === 0 ? 'flat' : (flip ? v < 0 : v > 0) ? 'up' : 'down') : 'flat');
const iso = U.isoDay;

/* ── 狀態列 ─────────────────────────────────────────── */
function setStatus(kind, txt) {
  const el = $('#status');
  if (!kind) { el.hidden = true; return; }
  el.hidden = false;
  el.dataset.kind = kind;
  el.querySelector('.spin').style.display = kind === 'loading' ? '' : 'none';
  $('#statusTxt').textContent = txt;
}
/* 來源名稱與筆數分開放：窄螢幕只留筆數，不然前方的「Binance」會被擠成一個字 */
function setSource(state2, name, detail) {
  const p = $('#srcPill');
  p.dataset.state = state2;
  $('#srcName').textContent = name || '';
  $('#srcTxt').textContent = detail || name || '';
}

/* 一次性提示（例如備援來源只提供較短的歷史）：顯示幾秒後自己收起來，
   不做常駐提醒——使用者在跑回測時不需要一直看到說明文字。 */
let noteTimer = null;
function infoNote(txt) {
  setStatus('info', txt);
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => { if ($('#statusTxt').textContent === txt) setStatus(null); }, 8000);
}

/* ── 幣種選單 ───────────────────────────────────────── */
function renderSymMenu(q = '') {
  const list = $('#symList');
  const query = q.trim().toUpperCase();
  let rows = universe;
  if (query) rows = universe.filter(u => u.base.includes(query) || u.symbol.includes(query));
  else rows = universe.slice(0, 80);
  if (query) rows = rows.slice(0, 80);
  const html = rows.map(u => `
    <div class="symrow${u.symbol === state.sym ? ' on' : ''}" data-sym="${u.symbol}" role="option">
      <span class="s1"><b>${u.base}</b><i>USDT</i></span>
      <span class="s2">${isFinite(u.price) ? U.fmtPrice(u.price) : '—'}</span>
      <span class="s3 ${isFinite(u.chg) ? (u.chg >= 0 ? 'up' : 'down') : ''}">${isFinite(u.chg) ? (u.chg >= 0 ? '+' : '') + u.chg.toFixed(2) + '%' : ''}</span>
    </div>`).join('');
  const direct = query && /^[A-Z0-9]{2,10}$/.test(query) && !universe.some(u => u.symbol === query + 'USDT' || u.symbol === query)
    ? `<div class="symrow" data-sym="${query.endsWith('USDT') ? query : query + 'USDT'}"><span class="s1"><b>${query.replace(/USDT$/, '')}</b><i>USDT · 直接查詢</i></span><span class="s2"></span><span class="s3"></span></div>` : '';
  list.innerHTML = (direct + html) || '<div class="empty">沒有符合的幣種</div>';
  list.querySelectorAll('.symrow').forEach(r => r.addEventListener('click', () => selectSymbol(r.dataset.sym)));
}

function openSymMenu(open) {
  const m = $('#symMenu');
  m.hidden = !open;
  $('#symBtn').setAttribute('aria-expanded', String(!!open));
  if (open) { $('#symSearch').value = ''; renderSymMenu(''); $('#symSearch').focus(); }
}
function selectSymbol(sym) {
  openSymMenu(false);
  if (sym === state.sym && allCandles.length) return;
  state.sym = sym;
  $('#symBase').textContent = sym.replace(/USDT$/, '');
  $('#symChips').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.sym === sym));
  syncUrl();
  loadSymbol(sym);
}

/* ── 載入資料 ───────────────────────────────────────── */
async function loadSymbol(sym) {
  loading = true; lastErr = null;
  setStatus('loading', `載入 ${sym.replace(/USDT$/, '')} 日線資料…`);
  setSource('wait', '', '連線中');
  try {
    const rows = await api.fetchKlines(sym, Date.UTC(2017, 0, 1));
    if (!rows || rows.length < 3) throw new Error('沒有可用的歷史資料');
    allCandles = rows;
    partial = rows[rows.length - 1].t + DAY > Date.now();
    setSource('ok', api.status.source, `${rows.length} 根日線`);
    setStatus(null);
    /* 備援來源可能只提供比使用者要求更短的期間，這種事一定要說，不能默默換掉 */
    if (api.status.note) infoNote(api.status.note);
    if (!state.start || !state.end || state.range === 'all') {
      state.start = iso(rows[0].t);
      state.end = iso(rows[rows.length - 1].t);
      syncDateInputs();
    }
    loading = false;
    compute();
  } catch (e) {
    loading = false;
    allCandles = [];
    lastErr = e.message;
    setSource('err', '', '資料失敗');
    setStatus('err', `無法取得 ${sym} 的資料：${e.message}。可換一個幣種或稍後再試。`);
    res = null; roll = null;
    renderAll();
  }
}

function syncDateInputs() {
  $('#start').value = state.start || '';
  $('#end').value = state.end || '';
}

/* ── 讀取／寫入設定 ─────────────────────────────────── */
function cfgFromUI() {
  const amtRaw = U.num($('#amt').value.replace(/[,\s$NT]/gi, ''));
  const amtUsdt = state.cur === 'TWD' ? amtRaw / fx : amtRaw;
  return {
    symbol: state.sym,
    amount: isFinite(amtUsdt) && amtUsdt > 0 ? amtUsdt : 0,
    feePct: Math.max(0, U.num($('#fee').value) || 0),
    freq: state.freq,
    weekday: +$('#dow').value,
    monthDay: +$('#md').value,
    boost: {
      on: $('#boostOn').checked,
      mode: $('#boostMode').value,
      dropPct: Math.max(0.5, U.num($('#boostDrop').value) || 10),
      mult: Math.max(1, U.num($('#boostMult').value) || 2),
      cap: Math.max(1, U.num($('#boostCap').value) || 4)
    }
  };
}

/* ── 重算 ───────────────────────────────────────────── */
function compute() {
  if (!allCandles.length) { res = null; roll = null; renderAll(); return; }
  const cfg = cfgFromUI();
  if (!(cfg.amount > 0)) { setStatus('err', '每期投入金額必須大於 0'); res = null; renderAll(); return; }
  const start = U.parseDay(state.start), end = U.parseDay(state.end);
  if (!isFinite(start) || !isFinite(end)) { setStatus('err', '請選擇有效的起訖日期'); return; }
  if (start > end) { setStatus('err', '起始日不能晚於結束日'); res = null; renderAll(); return; }

  const candles = dca.sliceRange(allCandles, start, end + DAY - 1);
  if (candles.length < 3) {
    setStatus('err', `${state.sym.replace(/USDT$/, '')} 在這個期間沒有資料（該幣種可能還沒上市）`);
    res = null; roll = null; renderAll(); return;
  }
  res = dca.runBacktest(candles, cfg);
  if (!res.ok) { setStatus('err', res.err); roll = null; renderAll(); return; }
  roll = dca.rolling(candles, cfg, { mode: state.rollMode, periods: state.rollP });
  setStatus(null);
  renderAll();
}

/* ══════════════════════════════════════════════════════════
   渲染
   ══════════════════════════════════════════════════════════ */
function renderAll() {
  renderKpis();
  renderCharts();
  renderCompare();
  renderYears();
  renderHeat();
  renderMetrics();
  renderRoll();
}

/* ── KPI ────────────────────────────────────────────── */
function kpiCard(label, value, sub, vcls, fmtFn, raw) {
  /* data-v 放原始數值、data-fmt 指定格式化方式：進場動畫才有數字可以插值，
     而不是從 0 開始猜。文字內容先用最終值，避免動畫被中斷時顯示空白。 */
  return `<div class="kpi"><label>${label}</label>
    <div class="v ${vcls || ''}" data-fmt="${fmtFn || 'text'}" data-v="${isFinite(raw) ? raw : ''}">${value}</div>
    <div class="s">${sub || ''}</div></div>`;
}
const FMT = {
  money: v => money(v),
  pct1: v => pct(v, 1),
  pct2: v => pct(v, 2),
  int: v => U.fmt(v, 0),
  /* 比率（夏普、卡瑪）固定兩位：0.29 不該被顯示成 0.289120 */
  num2: v => (isFinite(v) ? v.toFixed(2) : '—')
};
/* 進場動畫。兩個保險：
   1. 背景分頁的 requestAnimationFrame 會被瀏覽器暫停，動畫會停在起始值——
      所以動畫開始前先看 document.hidden，隱藏中就只寫終值。（實測：用背景分頁開站，
      KPI 會停在 $21 / $0.00000000 這種半路數字，看起來像算錯。）
   2. 就算跑到一半被暫停（切走分頁、系統忙碌），也一定要回到終值，
      所以另外掛一個 timeout 兜底。數字錯了比沒有動畫嚴重得多。 */
function animV(el, to, fmtKey, from = 0) {
  const fmt = FMT[fmtKey] || (v => String(v));
  if (!isFinite(to)) { el.textContent = fmt(to); return; }
  cancelAnimationFrame(el.__raf);
  clearTimeout(el.__t);
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (document.hidden || reduce) { el.textContent = fmt(to); return; }
  const t0 = performance.now(), dur = 480;
  const step = () => {
    const p = Math.min(1, (performance.now() - t0) / dur);
    const e = 1 - Math.pow(1 - p, 3);
    el.textContent = fmt(from + (to - from) * e);
    if (p < 1) el.__raf = requestAnimationFrame(step);
  };
  el.__t = setTimeout(() => { cancelAnimationFrame(el.__raf); el.textContent = fmt(to); }, dur + 120);
  step();
}
/* 記住上一次的數字，改參數時是「從舊值滑到新值」，不是每次都從 0 重跑 */
const kpiPrev = new Map();
function animateKpis() {
  $$('#kpis .kpi').forEach(card => {
    const el = card.querySelector('.v[data-fmt]'); if (!el) return;
    const key = card.querySelector('label').textContent;
    const to = U.num(el.dataset.v);
    const prev = kpiPrev.get(key);
    kpiPrev.set(key, to);
    animV(el, to, el.dataset.fmt, isFinite(prev) ? prev : 0);
  });
}

function renderKpis() {
  const box = $('#kpis');
  if (!res || !res.ok) {
    box.innerHTML = [
      ['總投入', '', ''], ['期末市值', '', ''], ['累積損益', '', ''],
      ['年化報酬', '', ''], ['最大回撤', '', ''], ['夏普值', '', '']
    ].map(([l]) => `<div class="kpi"><label>${l}</label><div class="v">—</div><div class="s"></div></div>`).join('');
    return;
  }
  const s = res.sum;
  const html = [
    kpiCard('總投入', money(s.invested), `${s.periods} 期 · 每期 ${money(s.invested / (s.periods || 1))}`, '', 'money', s.invested),
    kpiCard('期末市值', money(s.finalValue), `${U.fmtQty(s.totalCoins)} ${state.sym.replace(/USDT$/, '')}`, '', 'money', s.finalValue),
    kpiCard('累積損益', money(s.totalPnl), `總報酬 <b>${pct(s.totalRet)}</b>`, cls(s.totalPnl), 'money', s.totalPnl),
    kpiCard('年化報酬 XIRR', pct(s.xirr), `時間加權 <b>${pct(s.twr)}</b>`, cls(s.xirr), 'pct2', s.xirr),
    kpiCard('最大回撤', pct(s.maxDD), `${iso(s.ddPeak).slice(2)}→${iso(s.ddTrough).slice(2)} · ${s.ddDays} 天`, 'down', 'pct1', s.maxDD),
    kpiCard('夏普值', U.fmt(s.sharpe, 2), `年化波動 <b>${pct(s.annVol, 1, false)}</b>`, s.sharpe > 1 ? 'up' : '', 'num2', s.sharpe)
  ].join('');
  box.innerHTML = html;
  animateKpis();
}

/* ── 圖表 ───────────────────────────────────────────── */
const CH = { c1: '1', c2: '2', c3: '3', c4: '4', c5: '5', c6: '6' };
const noChart = () => setStatus('err', lastErr || '沒有可顯示的資料');

function tip(rows, title) {
  return `<span class="t">${title}</span>` + rows.map(([k, v, c]) =>
    `<div class="r"><i>${k}</i><b class="${c || ''}">${v}</b></div>`).join('');
}

/* 只有「圖形真的變了」才播入場動畫：調整金額時整排圖表重新滑動會很干擾，
   但換幣種、換期間時動畫又能清楚說明資料整批換掉。 */
const chartSig = new Map();
function chart(kid, sig, cfg) {
  const c = $('#' + kid);
  const turn = chartSig.get(kid) !== sig;
  chartSig.set(kid, sig);
  const tooltipEl = c.parentElement.querySelector('.tip');
  mount(c, Object.assign({}, cfg, { animate: turn }), tooltipEl);
}

/* 圖表高度只有一個來源（這裡）：先前 CSS 與 JS 各寫一份，
   手機版 CSS 把外框縮到 250px、JS 仍畫 320px，結果圖被裁掉也只顯示上半。
   高度寫在 JS 才能跟著寬度一起變。 */
const isNarrow = () => window.innerWidth < 720;
const H_MAIN = () => (isNarrow() ? 252 : 320);
const H_SUB = () => (isNarrow() ? 214 : 250);

function renderCharts() {
  if (!res || !res.ok) {
    ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].forEach(kid => {
      const c = $('#' + kid);
      if (c.__chart) chartSig.delete(kid);
      mount(c, { series: [], animate: false, height: H_SUB() }, c.parentElement.querySelector('.tip'));
    });
    return;
  }
  const s = res.sum, T = res.times, n = T.length;
  const mv = (arr) => arr.map((v, i) => [T[i], v * cu()]);
  const sig0 = `${state.sym}|${res.times.length}|${res.buys.length}|${state.cur}|${res.periods}`;

  /* 01 資產成長 */
  const c1 = $('#c1');
  chart('c1', sig0, {
    height: H_MAIN(), pad: { l: 64, r: 18 },
    series: [
      { type: 'area', pts: mv(res.value), color: PAL.cy, alpha: .30, width: 1.9 },
      { type: 'line', pts: mv(res.invest), color: PAL.dim, width: 1.3, dash: [4, 4] }
    ],
    y: { zero: true, format: axFmt(res.sum.finalValue * 1.02 * cu()) },
    yPad: .05,
    tooltip: (x) => {
      const i = nearest(T, x);
      if (!res.invest[i]) return `<span class="t">${iso(T[i])}</span><div class="r"><i>尚未開始扣款</i></div>`;
      const p = res.value[i] / res.invest[i] - 1;
      return tip([
        ['市值', money(res.value[i])],
        ['累計投入', money(res.invest[i])],
        ['損益', money(res.value[i] - res.invest[i]), cls(p)],
        ['報酬率', pct(p), cls(p)],
        ['持幣', U.fmtQty(res.coins[i]) + ' ' + state.sym.replace(/USDT$/, '')]
      ], iso(T[i]) + `　第 ${i + 1} / ${n} 天`);
    }
  });

  /* 02 價格與扣款點 */
  const buyPts = res.buys.map(b => [b.t, b.price * cu(), b.amount / (s.invested / s.periods || 1)]);
  const maxMult = Math.max(1, ...buyPts.map(p => p[2]));
  chart('c2', sig0, {
    height: H_SUB(), pad: { l: 60, r: 16 },
    series: [
      { type: 'line', pts: mv(res.prices), color: 'rgba(120,150,200,.55)', width: 1.2 },
      { type: 'dots', pts: buyPts, color: PAL.up, size: (p) => 1.5 + 1.6 * Math.min(1, (p[2] || 0) / maxMult), stroke: 'rgba(5,10,18,.9)' }
    ],
    lines: [{ y: s.avgCost * cu(), color: PAL.am, dash: [5, 4], label: '平均成本 ' + price(s.avgCost) }],
    /* 價格軸：上下都貼著資料，不要擴到 0，也不要讓最高/最低的扣款點被切掉 */
    y: { format: axPrice },
    yPadBelow: .02, yPadAbove: .07,
    tooltip: (x) => {
      const i = nearest(T, x);
      const b = res.buys.find(b2 => b2.t === T[i]);
      const rows = [['價格', price(res.prices[i])]];
      if (b) {
        rows.push(['當期扣款', money(b.amount) + (b.mult > 1 ? ` ×${b.mult}` : '')]);
        rows.push(['買入數量', U.fmtQty(b.coins)]);
        rows.push(['累計平均成本', price(b.avgCost)]);
      } else {
        rows.push(['平均成本', price(s.avgCost)]);
        rows.push(['相對成本', pct(res.prices[i] / s.avgCost - 1), cls(res.prices[i] / s.avgCost - 1)]);
      }
      return tip(rows, iso(T[i]));
    }
  });

  /* 03 回撤（riskStats 的序列已經從第一次扣款開始，不要再切一次） */
  const c3 = $('#c3');
  const i0 = res.buys[0].idx;
  const T2 = T.slice(i0);
  const ddNav = res.dd.nav.series.map((v, i) => [T2[i], v]);
  const ddPrice = res.dd.price.series.map((v, i) => [T2[i], v]);
  chart('c3', sig0, {
    height: H_SUB(), pad: { l: 54, r: 16 },
    series: [
      { type: 'area', pts: ddNav, color: PAL.down, alpha: .26, width: 1.5 },
      { type: 'line', pts: ddPrice, color: 'rgba(140,160,190,.45)', width: 1.1, dash: [3, 3] }
    ],
    y: { max: 0.02, format: v => (v * 100).toFixed(0) + '%' },
    tooltip: (x) => {
      const i = nearest(T2, x);
      if (i < 0 || i >= ddNav.length) return '';
      return tip([
        ['定投淨值回撤', pct(ddNav[i][1]), 'down'],
        ['標的價格回撤', pct(ddPrice[i][1])]
      ], iso(T2[i]));
    }
  });

  /* 04 年度報酬 */
  const c4 = $('#c4');
  const yrs = res.yearly;
  chart('c4', sig0 + '|y' + yrs.length, {
    height: H_SUB(), pad: { l: 54, r: 16 },
    series: [
      { type: 'bar', pts: yrs.map((y, i) => [i, y.ret > 0 ? y.ret : 0]), color: PAL.up, barWidth: .58 },
      { type: 'bar', pts: yrs.map((y, i) => [i, y.ret <= 0 ? y.ret : 0]), color: PAL.down, barWidth: .58 }
    ],
    x: { ticks: yrs.map((y, i) => ({ v: i, label: String(y.year) })) },
    y: { zero: true, format: v => (v * 100).toFixed(0) + '%' },
    tooltip: (x) => {
      const i = Math.round(x);
      const y = yrs[i]; if (!y) return '';
      return tip([
        ['年報酬', pct(y.ret), cls(y.ret)],
        ['投入', money(y.invested) + ` (${y.periods} 期)`],
        ['年末市值', money(y.endValue)],
        ['年末損益', money(y.pnl), cls(y.pnl)]
      ], y.year + ' 年');
    }
  });

  /* 05 買入價位分布 */
  const pb = res.priceBins;
  const bins = pb.bins || [];
  const avgBin = bins.findIndex(b => s.avgCost >= b.lo && s.avgCost < b.hi);
  chart('c5', sig0 + '|b' + bins.length, {
    height: H_SUB(), pad: { l: 54, r: 16 },
    series: [
      { type: 'bar', pts: bins.map((b, i) => [i, i === avgBin ? 0 : b.amount * cu()]), color: PAL.cy, alpha: .85, barWidth: .72 },
      { type: 'bar', pts: bins.map((b, i) => [i, i === avgBin ? b.amount * cu() : 0]), color: PAL.am, barWidth: .72 }
    ],
    x: { ticks: bins.map((b, i) => ({ v: i, label: i % 3 === 0 ? U.fmtShort(b.mid * cu(), '') : '' })) },
    y: { zero: true, format: axFmt(Math.max(...bins.map(b => b.amount)) * cu() * 1.05) },
    tooltip: (x) => {
      const i = Math.round(x), b = bins[i]; if (!b) return '';
      return tip([
        ['價格區間', price(b.lo) + ' – ' + price(b.hi)],
        ['投入金額', money(b.amount)],
        ['佔比', pct(b.pct, 1)],
        ['扣款次數', b.count + ' 次']
      ], `第 ${i + 1} / ${bins.length} 格`);
    }
  });

  /* 06 滾動分布 */
  if (!roll) {
    chart('c6', 'none', { series: [], height: H_SUB() });
  } else {
    const bins2 = roll.bins;
    chart('c6', `${sig0}|r|${roll.mode}|${roll.periods}|${roll.n}`, {
      height: H_SUB(), pad: { l: 48, r: 16 },
      series: [
        { type: 'bar', pts: bins2.map((b, i) => [i, b.mid > 0 ? b.count : 0]), color: PAL.up, alpha: .8, barWidth: .78 },
        { type: 'bar', pts: bins2.map((b, i) => [i, b.mid <= 0 ? b.count : 0]), color: PAL.down, alpha: .8, barWidth: .78 }
      ],
      x: { ticks: bins2.map((b, i) => ({ v: i, label: i % 4 === 0 ? (b.mid * 100).toFixed(0) + '%' : '' })) },
      y: { zero: true, format: v => U.fmt(v, 0) },
      tooltip: (x) => {
        const i = Math.round(x), b = bins2[i]; if (!b) return '';
        return tip([
          ['報酬區間', pct(b.lo, 1) + ' ~ ' + pct(b.hi, 1)],
          ['起點數', b.count + ' 個'],
          ['佔比', pct(b.count / roll.n, 1)]
        ], '滾動樣本分布');
      }
    });
  }
}

function nearest(arr, x) {
  let lo = 0, hi = arr.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (arr[mid] > x) hi = mid; else lo = mid; }
  return Math.abs(arr[lo] - x) <= Math.abs(arr[hi] - x) ? lo : hi;
}

/* ── 策略對照 ───────────────────────────────────────── */
function renderCompare() {
  const t = $('#cmpTable');
  if (!res || !res.ok) { t.innerHTML = ''; return; }
  const s = res.sum, l = res.lump;
  const row = (name, inv, fin, ret, ann, dd, vol, sharpe, hi) => `<tr class="${hi ? 'hi' : ''}">
    <td>${name}</td>
    <td>${money(inv)}</td>
    <td>${money(fin)}</td>
    <td class="${cls(ret)}">${pct(ret)}</td>
    <td class="${cls(ann)}">${pct(ann)}</td>
    <td class="down">${pct(dd)}</td>
    <td>${pct(vol, 1)}</td>
    <td>${U.fmt(sharpe, 2)}</td></tr>`;
  t.innerHTML = `
    <thead><tr>
      <th>策略</th><th>總投入</th><th>期末市值</th><th>總報酬</th><th>年化報酬</th><th>最大回撤</th><th>年化波動</th><th>夏普</th>
    </tr></thead>
    <tbody>
      ${row('定期定額（本次設定）', s.invested, s.finalValue, s.totalRet, s.xirr, s.maxDD, s.annVol, s.sharpe, true)}
      ${row(`單筆投入（${iso(s.firstBuy)} 全押）`, l.invested, l.finalValue, l.totalRet, l.xirr, l.maxDD, l.annVol, l.sharpe)}
      <tr>
        <td>標的價格漲幅（不含費用）</td><td>—</td><td>—</td>
        <td class="${cls(s.priceRet)}">${pct(s.priceRet)}</td><td>—</td>
        <td class="down">${pct(s.priceMaxDD)}</td><td>${pct(s.priceVol, 1)}</td><td>—</td>
      </tr>
    </tbody>
    <tfoot><tr><td colspan="8">年化報酬對定期定額採 XIRR（資金加權），單筆投入為其持有期年化。標的漲幅列僅為價格變動，未計入任何費用。</td></tr></tfoot>`;
}

/* ── 年度明細 ───────────────────────────────────────── */
function renderYears() {
  const t = $('#yearTable');
  if (!res || !res.ok) { t.innerHTML = ''; return; }
  const s = res.sum;
  const rows = res.yearly.map(y => `<tr>
    <td>${y.year}</td>
    <td>${y.periods}</td>
    <td>${money(y.invested)}</td>
    <td>${money(y.cumInvested)}</td>
    <td>${money(y.endValue)}</td>
    <td class="${cls(y.ret)}">${pct(y.ret)}</td>
    <td class="${cls(y.pnl)}">${money(y.pnl)}</td>
    <td class="down">${pct(y.maxDD, 1)}</td>
    <td>${price(y.endPrice)}</td>
  </tr>`).join('');
  t.innerHTML = `
    <thead><tr><th>年度</th><th>扣款</th><th>當年投入</th><th>累計投入</th><th>年末市值</th><th>年報酬</th><th>年末損益</th><th>年內最大回撤</th><th>年末價格</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><td>合計</td><td>${s.periods}</td><td>${money(s.invested)}</td><td>${money(s.invested)}</td><td>${money(s.finalValue)}</td>
      <td class="${cls(s.totalRet)}">${pct(s.totalRet)}</td><td class="${cls(s.totalPnl)}">${money(s.totalPnl)}</td>
      <td class="down">${pct(s.maxDD, 1)}</td><td>${price(s.finalPrice)}</td></tr></tfoot>`;
}

/* ── 月度熱圖 ───────────────────────────────────────── */
function renderHeat() {
  const box = $('#heat');
  if (!res || !res.ok || !res.months.rows.length) { box.innerHTML = ''; return; }
  const map = new Map();
  for (const r of res.months.rows) map.set(r.key, r.ret);
  const years = [...new Set(res.months.rows.map(r => r.key.slice(0, 4)))].sort();
  const head = '<div class="hl"></div>' + Array.from({ length: 12 }, (_, i) => `<div class="hl" style="justify-content:center">${i + 1}</div>`).join('');
  const body = years.map(y => {
    const cells = Array.from({ length: 12 }, (_, i) => {
      const k = `${y}-${String(i + 1).padStart(2, '0')}`;
      const v = map.get(k);
      if (v == null || !isFinite(v)) return '<div class="hc empty">·</div>';
      const a = Math.min(0.42, Math.abs(v) * 1.6);
      const bg = v >= 0 ? `rgba(14,203,129,${a})` : `rgba(246,70,93,${a})`;
      const cl = Math.abs(v) > 0.06 ? '#eaf1fb' : 'var(--tx-2)';
      return `<div class="hc" style="background:${bg};color:${cl}" title="${k} ${pct(v)}">${(v * 100).toFixed(1)}</div>`;
    }).join('');
    return `<div class="hy">${y}</div>${cells}`;
  }).join('');
  box.innerHTML = `<div class="heat">${head}${body}</div>
    <div class="hint" style="font-size:11px;color:var(--tx-3);margin-top:10px">
      單位：%（每月淨值報酬，綠為正、紅為負，深淺依幅度）。淨值＝市值 ÷ 截至該日累計投入。</div>`;
}

/* ── 完整指標 ───────────────────────────────────────── */
function renderMetrics() {
  const g = $('#metricGrid');
  if (!res || !res.ok) { g.innerHTML = ''; return; }
  const s = res.sum, curSym = state.sym.replace(/USDT$/, '');
  const items = [
    ['平均成本', price(s.avgCost), `買入 ${U.fmtQty(s.totalCoins)} ${curSym}`],
    ['期間平均價', price(s.periodAvgPrice), '每日收盤均價（未加權）'],
    ['成本優勢', pct(s.costEdge), '平均成本低於期間均價的幅度', cls(s.costEdge)],
    ['期末價格', price(s.finalPrice), `起點 ${price(s.priceFrom)}`],
    ['期間價格漲幅', pct(s.priceRet), `${iso(s.from)} → ${iso(s.to)}`, cls(s.priceRet)],
    ['投入期間', `${s.periods} 期`, `${s.days} 天 · ${(s.days / 365).toFixed(1)} 年`],
    ['年化報酬 XIRR', pct(s.xirr), '資金加權（正確處理分批投入）', cls(s.xirr)],
    ['時間加權年化', pct(s.twr), '單位成本淨值的年化成長'],
    ['簡單年化', pct(s.cagr), '（市值／投入）年化，參考值'],
    ['年化波動', pct(s.annVol, 1), `下行波動 ${pct(s.downside, 1)}`],
    ['夏普值', U.fmt(s.sharpe, 2), '無風險利率 0%'],
    ['索提諾', U.fmt(s.sortino, 2), '只計下行風險'],
    ['卡瑪比率', U.fmt(s.calmar, 2), '年化報酬 ÷ 最大回撤'],
    ['最大回撤', pct(s.maxDD, 1), `${iso(s.ddPeak)} → ${iso(s.ddTrough)}`, 'down'],
    ['最長水下期間', `${s.underDays} 天`, '距離上一次創新高的最長天數'],
    ['目前回撤', pct(s.ddAtEnd, 1), isFinite(s.ddAtEnd) && Math.abs(s.ddAtEnd) < 0.0005 ? '位於歷史新高' : '距上次新高', s.ddAtEnd < -0.001 ? 'down' : ''],
    ['月度勝率', pct(s.monthWin, 1), `${s.monthsPositive} / ${s.monthsTotal} 個月為正`],
    ['最好 / 最差月', s.bestMonth ? pct(s.bestMonth.ret, 1) + ' / ' + pct(s.worstMonth.ret, 1) : '—',
      s.bestMonth ? `${s.bestMonth.key} / ${s.worstMonth.key}` : ''],
    ['淨值上漲日比例', pct(s.posDays, 1), '扣款期間的日勝率'],
    ['標的價格最大回撤', pct(s.priceMaxDD, 1), '同期價格本身', 'down']
  ];
  if (s.boostBuys > 0) items.push(['加碼次數', `${s.boostBuys} 期`, `額外投入 ${money(s.boostExtra)}`, 'am']);
  g.innerHTML = items.map(([l, v, sub, c]) => `<div class="metric"><label>${l}</label><b class="${c || ''}">${v}</b><i>${sub || ''}</i></div>`).join('');
}

/* ── 滾動統計 ───────────────────────────────────────── */
function renderRoll() {
  const box = $('#rollStats');
  if (!roll) {
    box.innerHTML = '<div class="rs"><span>此設定下無法計算滾動回測</span></div>';
    return;
  }
  const d = roll.dist;
  const label = roll.mode === 'fixed' ? `每組連續 ${roll.periods} 期` : '每個起點跑到資料最後一天';
  box.innerHTML = `
    <div class="rs big"><span>樣本數</span><b>${roll.n} 組 <i style="color:var(--tx-3);font-style:normal">（${label}）</i></b></div>
    <div class="rs"><span>報酬中位數</span><b class="${cls(d.median)}">${pct(d.median)}</b></div>
    <div class="rs"><span>平均報酬</span><b class="${cls(d.mean)}">${pct(d.mean)}</b></div>
    <div class="rs"><span>正報酬比例</span><b class="${d.positive > 0.5 ? 'up' : 'down'}">${pct(d.positive, 1)}</b></div>
    <div class="rs"><span>第 10 / 90 百分位</span><b>${pct(d.p10, 1)} / ${pct(d.p90, 1)}</b></div>
    <div class="rs"><span>最好一組</span><b class="up">${pct(roll.best.ret, 1)}</b></div>
    <div class="rs"><span>最好起點</span><b>${iso(roll.best.t)}</b></div>
    <div class="rs"><span>最差一組</span><b class="down">${pct(roll.worst.ret, 1)}</b></div>
    <div class="rs"><span>最差起點</span><b>${iso(roll.worst.t)}</b></div>
    <div class="rs"><span>最差起點區間</span><b>${iso(roll.worst.t)} → ${iso(roll.worst.endT)}</b></div>`;
}

/* ══════════════════════════════════════════════════════════
   匯出
   ══════════════════════════════════════════════════════════ */
function download(name, rows) {
  const csv = '\ufeff' + rows.map(r => r.map(c => {
    const v = c == null ? '' : String(c);
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
function exportBuys() {
  if (!res || !res.ok) return;
  const rows = [['日期', `買入價(USDT)`, '倍數', `投入(USDT)`, '買入數量', '累計投入', '累計數量', `累計平均成本(USDT)`, `當期市值(USDT)`, '累計損益', '累計報酬率']];
  for (const b of res.buys) rows.push([iso(b.t), b.price, b.mult, b.amount.toFixed(4), b.coins.toFixed(10),
    b.cumInvest.toFixed(2), b.cumCoins.toFixed(10), b.avgCost.toFixed(4), b.value.toFixed(2), (b.value - b.cumInvest).toFixed(2), (b.value / b.cumInvest - 1).toFixed(6)]);
  download(`${state.sym}_DCA扣款明細_${iso(res.sum.from)}_${iso(res.sum.to)}.csv`, rows);
}
function exportNav() {
  if (!res || !res.ok) return;
  const rows = [['日期', `收盤價(USDT)`, '累計投入', '累計數量', `市值(USDT)`, '單位成本淨值', '累計損益', '累計報酬率', '自高點回撤']];
  for (let i = 0; i < res.times.length; i++) {
    if (!res.invest[i]) continue;
    rows.push([iso(res.times[i]), res.prices[i], res.invest[i].toFixed(2), res.coins[i].toFixed(10),
      res.value[i].toFixed(2), res.nav[i].toFixed(6), (res.value[i] - res.invest[i]).toFixed(2),
      (res.nav[i] - 1).toFixed(6), (res.dd.nav.series[i] || 0).toFixed(6)]);
  }
  download(`${state.sym}_DCA每日淨值_${iso(res.sum.from)}_${iso(res.sum.to)}.csv`, rows);
}

/* ══════════════════════════════════════════════════════════
   URL 狀態
   ══════════════════════════════════════════════════════════ */
function syncUrl() {
  const p = new URLSearchParams({
    s: state.sym, a: String(state.amt), c: state.cur, f: String(state.fee), q: state.freq,
    w: String(state.weekday), m: String(state.monthDay),
    f0: state.start || '', f1: state.end || '', rg: state.range || '',
    bo: state.boost.on ? '1' : '0', bm: state.boost.mode, bd: String(state.boost.dropPct),
    bx: String(state.boost.mult), bc: String(state.boost.cap),
    rm: state.rollMode, rp: String(state.rollP)
  });
  history.replaceState(null, '', '#' + p.toString());
}
function fromUrl() {
  if (!location.hash.length) return;
  const p = new URLSearchParams(location.hash.slice(1));
  const g = (k, d) => (p.has(k) ? p.get(k) : d);
  state.sym = g('s', state.sym);
  state.amt = U.num(g('a', state.amt)) || state.amt;
  state.cur = g('c', state.cur);
  state.fee = U.num(g('f', state.fee));
  state.freq = g('q', state.freq);
  state.weekday = +g('w', state.weekday);
  state.monthDay = +g('m', state.monthDay);
  state.start = g('f0', '') || null;
  state.end = g('f1', '') || null;
  state.range = state.start && state.end ? null : 'all';   // 連結帶了日期就不要被「全部」覆蓋
  if (p.has('rg')) state.range = p.get('rg') || null;
  state.boost = { on: g('bo', '0') === '1', mode: g('bm', 'last'), dropPct: U.num(g('bd', 10)), mult: U.num(g('bx', 2)), cap: U.num(g('bc', 4)) };
  state.rollMode = g('rm', 'fixed');
  state.rollP = +g('rp', 24);
}

/* ══════════════════════════════════════════════════════════
   事件
   ══════════════════════════════════════════════════════════ */
let debounce = null;
const later = (fn, ms = 220) => { clearTimeout(debounce); debounce = setTimeout(fn, ms); };

function bindUI() {
  /* 幣種 */
  $('#symBtn').addEventListener('click', (e) => { e.stopPropagation(); openSymMenu($('#symMenu').hidden); });
  $('#symSearch').addEventListener('input', (e) => renderSymMenu(e.target.value));
  $('#symSearch').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const first = $('#symList').querySelector('.symrow'); if (first) selectSymbol(first.dataset.sym); }
    if (e.key === 'Escape') openSymMenu(false);
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.sym-field')) openSymMenu(false);
    if (!e.target.closest('#advBox')) $('#advBox').open = false;
  });
  $('#symChips').innerHTML = TOP_CHIPS.map(s => `<button data-sym="${s}" class="${s === state.sym ? 'on' : ''}">${s.replace('USDT', '')}</button>`).join('');
  $('#symChips').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) selectSymbol(b.dataset.sym); });

  /* 金額 / 幣別 */
  $('#amt').addEventListener('input', () => later(() => { state.amt = U.num($('#amt').value.replace(/[,\s]/g, '')); syncUrl(); compute(); }));
  $('#curBtn').addEventListener('click', () => {
    const v = U.num($('#amt').value.replace(/[,\s]/g, ''));
    state.cur = state.cur === 'USD' ? 'TWD' : 'USD';
    const nv = isFinite(v) ? (state.cur === 'TWD' ? v * fx : v / fx) : v;
    $('#amt').value = state.cur === 'TWD' ? Math.round(nv / 100) * 100 : Math.round(nv / 10) * 10;
    state.amt = U.num($('#amt').value);
    $('#curBtn').textContent = state.cur === 'TWD' ? 'TWD' : 'USDT';
    $('#fxPill').textContent = `1 USDT = ${U.fmt(fx, 2)} TWD`;
    syncUrl(); compute();
  });

  /* 頻率 / 扣款日 */
  $('#freqSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    state.freq = b.dataset.freq;
    $$('#freqSeg button').forEach(x => x.classList.toggle('on', x === b));
    $('#dowWrap').style.display = (state.freq === 'weekly' || state.freq === 'biweekly') ? '' : 'none';
    $('#mdWrap').style.display = state.freq === 'monthly' ? '' : 'none';
    syncUrl(); compute();
  });
  $('#dow').addEventListener('change', () => { state.weekday = +$('#dow').value; syncUrl(); compute(); });
  $('#md').addEventListener('change', () => { state.monthDay = +$('#md').value; syncUrl(); compute(); });

  /* 期間 */
  const onRange = () => {
    state.start = $('#start').value || null;
    state.end = $('#end').value || null;
    state.range = null;
    $$('#rangeChips button').forEach(x => x.classList.remove('on'));
    syncUrl(); compute();
  };
  $('#start').addEventListener('change', onRange);
  $('#end').addEventListener('change', onRange);
  $('#rangeChips').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    $$('#rangeChips button').forEach(x => x.classList.toggle('on', x === b));
    state.range = b.dataset.days;
    if (!allCandles.length) return;
    const lastT = allCandles[allCandles.length - 1].t;
    state.end = iso(lastT);
    if (state.range === 'all') state.start = iso(allCandles[0].t);
    else state.start = iso(Math.max(allCandles[0].t, lastT - (+state.range) * DAY));
    syncDateInputs();
    syncUrl(); compute();
  });

  /* 手續費 / 加碼 */
  $('#fee').addEventListener('input', () => later(() => { state.fee = U.num($('#fee').value) || 0; syncUrl(); compute(); }));
  const onBoost = () => {
    state.boost = { on: $('#boostOn').checked, mode: $('#boostMode').value, dropPct: U.num($('#boostDrop').value) || 10, mult: U.num($('#boostMult').value) || 2, cap: U.num($('#boostCap').value) || 4 };
    syncUrl(); compute();
  };
  ['#boostOn', '#boostMode'].forEach(s => $(s).addEventListener('change', onBoost));
  ['#boostDrop', '#boostMult', '#boostCap'].forEach(s => $(s).addEventListener('input', () => later(onBoost)));

  /* 滾動 */
  $('#rollMode').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    state.rollMode = b.dataset.mode;
    $$('#rollMode button').forEach(x => x.classList.toggle('on', x === b));
    $('#rollPeriods').style.display = state.rollMode === 'fixed' ? '' : 'none';
    syncUrl(); compute();
  });
  $('#rollPeriods').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    state.rollP = +b.dataset.p;
    $$('#rollPeriods button').forEach(x => x.classList.toggle('on', x === b));
    syncUrl(); compute();
  });

  /* 匯出 */
  $('#csvBuys').addEventListener('click', exportBuys);
  $('#csvNav').addEventListener('click', exportNav);
  $('#copyLink').addEventListener('click', () => {
    navigator.clipboard.writeText(location.href).then(
      () => { $('#copyLink').textContent = '已複製連結 ✓'; setTimeout(() => $('#copyLink').textContent = '複製設定連結', 1800); },
      () => { $('#copyLink').textContent = '複製失敗'; setTimeout(() => $('#copyLink').textContent = '複製設定連結', 1800); }
    );
  });
  window.addEventListener('resize', () => setTimeout(() => window.__redraw && window.__redraw(), 120));
  /* 在背景分頁開站時不會有動畫（見 animV 的說明），切回來要把數字與圖補上 */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !res || !res.ok) return;
    renderKpis();
    renderCharts();
  });
}

/* ── 由 state 還原 UI ───────────────────────────────── */
function syncUIFromState() {
  $('#symBase').textContent = state.sym.replace(/USDT$/, '');
  $('#symChips').innerHTML = TOP_CHIPS.map(s => `<button data-sym="${s}" class="${s === state.sym ? 'on' : ''}">${s.replace('USDT', '')}</button>`).join('');
  $('#amt').value = state.amt;
  $('#curBtn').textContent = state.cur === 'TWD' ? 'TWD' : 'USDT';
  $('#fee').value = state.fee;
  $('#dow').value = String(state.weekday);
  $('#md').value = String(state.monthDay);
  $$('#freqSeg button').forEach(x => x.classList.toggle('on', x.dataset.freq === state.freq));
  $('#dowWrap').style.display = (state.freq === 'weekly' || state.freq === 'biweekly') ? '' : 'none';
  $('#mdWrap').style.display = state.freq === 'monthly' ? '' : 'none';
  $('#boostOn').checked = state.boost.on;
  $('#boostMode').value = state.boost.mode;
  $('#boostDrop').value = state.boost.dropPct;
  $('#boostMult').value = state.boost.mult;
  $('#boostCap').value = state.boost.cap;
  syncDateInputs();
  $$('#rollMode button').forEach(x => x.classList.toggle('on', x.dataset.mode === state.rollMode));
  $('#rollPeriods').style.display = state.rollMode === 'fixed' ? '' : 'none';
  $$('#rollPeriods button').forEach(x => x.classList.toggle('on', +x.dataset.p === state.rollP));
  $$('#rangeChips button').forEach(x => x.classList.toggle('on', x.dataset.days === String(state.range)));
}

/* ── 啟動 ───────────────────────────────────────────── */
async function boot() {
  fromUrl();
  syncUIFromState();
  bindUI();
  /* 匯率與幣種清單並行抓，不阻塞主資料 */
  api.fetchUsdTwd().then(v => {
    if (isFinite(v) && v > 5) { fx = v; fxReady = true; }
    $('#fxPill').textContent = `1 USDT = ${U.fmt(fx, 2)} TWD`;
  });
  api.fetchUniverse().then(list => {
    universe = list || [];
    renderSymMenu('');
    setSource('ok', api.status.source, `${allCandles.length} 根日線`);
  });
  await loadSymbol(state.sym);
  /* 除錯／自動化用的把手：可以在 Console 直接看引擎結果，也方便外部驗證匯出內容 */
  window.DCALAB = {
    state, get res() { return res; }, get roll() { return roll; }, get candles() { return allCandles; },
    compute, exportBuys, exportNav, selectSymbol, api
  };
  window.__redraw = () => {
    if (!res || !res.ok) return;
    ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].forEach(id => { const c = $('#' + id); if (c && c.__chart) c.__chart.progress = 1; });
    renderCharts();
  };
}
boot();
