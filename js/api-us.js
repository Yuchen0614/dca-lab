/* api-us.js — 美股／ETF 日線資料層

   兩個來源、兩種角色：

   ① 內建快照（data/us/<TICKER>.json）＝ 主流標的的主力來源
      由 scripts/build-us-snapshot.mjs 在建置時向 Yahoo Finance 抓，
      只存「已還原分割、未還原股利」的收盤價（與 Sina 路徑語意一致）。
      Yahoo 沒有 CORS，瀏覽器端無法直接使用，但建置時可以，
      而且它的日線有兩個 Sina 缺的優點：交易日完整（Sina 會漏掉個別交易日，
      例如 MSFT/TSM 少了 2014-07-16，把當天收盤掛在前一天）、
      不需要自己猜分割（Yahoo 直接給官方分割事件）。

   ② Sina JSONP ＝ 任意代號的備援來源
      `US_MinKService.getDailyK` 是 JSONP（回一段 var X=([...])），
      用 <script> 載入不受 CORS 限制、免金鑰，任何美股／ETF 代號都能查。
      但它的原始資料有三種已確認的瑕疵，所以只當備援，並在畫面上標示：
        · 沒有還原股票分割（SOXL 2015-05-20 4:1、2021-03-02 15:1 都看得到假暴跌）
          → 自己做偵測與向前還原（見下方 detectSplits / applySplits）
        · 個別交易日缺漏，導致日期與收盤錯位一天
        · 少數列會重複貼上（NVDA 2009-09-17/18 三天同一組 OHLC）
        · 2006 年之前有「未標示的基準調整」，跨過邊界會整個差一個倍數

   為什麼不用其他來源：Yahoo 對瀏覽器沒有 ACAO；Stooq 有 JS 防護、也無 ACAO；
   Nasdaq／twelvedata／eodhd／Alpha Vantage 都要 API key；
   免費 CORS 代理（allorigins／corsproxy／codetabs／thingproxy／corsfix）實測全數失效或需金鑰；
   Tencent 的美股 K 線只回當日一根，深度不足。 */

import { parseDay } from './util.js';

const EP_K = 'https://stock.finance.sina.com.cn/usstock/api/jsonp.php/var%20';
const EP_SUG = 'https://suggest3.sinajs.cn/suggest/type=41&name=';

/* 內建快照涵蓋的標的（同時是美股選單裡的快速標籤）。
   要增減請改這裡，再跑 node scripts/build-us-snapshot.mjs。 */
export const US_POPULAR = [
  ['SOXL', '半導體 3X 做多'], ['TQQQ', '納斯達克 100 3X'], ['UPRO', '標普 500 3X'],
  ['SPY', '標普 500'], ['VOO', '標普 500（Vanguard）'], ['QQQ', '納斯達克 100'],
  ['QQQM', '納斯達克 100（低費用）'], ['SMH', '半導體'], ['SOXX', '半導體（iShares）'],
  ['VTI', '美股全市場'], ['IWM', '羅素 2000 小型股'], ['SCHD', '高股息'],
  ['TLT', '20 年期美債'], ['GLD', '黃金'], ['ARKK', 'ARK 新興創新'],
  ['NVDA', '輝達'], ['AAPL', '蘋果'], ['MSFT', '微軟'], ['GOOGL', 'Alphabet'],
  ['AMZN', '亞馬遜'], ['META', 'Meta'], ['TSLA', '特斯拉'], ['TSM', '台積電 ADR'],
  ['AMD', '超微'], ['AVGO', '博通'], ['COST', '好市多'], ['JPM', '摩根大通'],
  ['COIN', 'Coinbase'], ['MSTR', 'Strategy（原 MicroStrategy）'], ['PLTR', 'Palantir']
];
export const US_POPULAR_MAP = new Map(US_POPULAR.map(([t, n]) => [t, n]));
export const isCurated = (ticker) => US_POPULAR_MAP.has(String(ticker || '').toUpperCase());

/* ── 可信任的起點 ─────────────────────────────────────── */
/* 實測（test/us-vs-yahoo.test.mjs）：Sina 在 2006 年之前的區段有「未標示的基準調整」——
   例如 MSFT 2003-02-18、AAPL 2005-02-28 的官方分割在舊區塊裡已經內建、看不到跳空，
   跨過那個邊界的回測會整個差一個倍數。這種錯誤在單一價格序列上無法偵測（價格是連續的），
   只能靠外部資料得知，所以直接把更早的區間排除並在畫面說明。 */
export const US_TRUSTED_FROM = '2006-01-01';
const US_FROM_MS = Date.UTC(2006, 0, 1);

/* ── JSONP 載入器 ─────────────────────────────────────── */
let seq = 0;
export function jsonp(url, varName, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    let done = false;
    const cleanup = () => {
      clearTimeout(timer);
      s.remove();
      try { delete window[varName]; } catch (e) { window[varName] = undefined; }
    };
    const timer = setTimeout(() => { if (!done) { done = true; cleanup(); reject(new Error('JSONP 逾時')); } }, timeout);
    window[varName] = undefined;
    s.src = url;
    s.onload = () => {
      if (done) return;
      done = true;
      const v = window[varName];
      cleanup();
      if (v === undefined || v === null) reject(new Error('JSONP 回應為空'));
      else resolve(v);
    };
    s.onerror = () => { if (!done) { done = true; cleanup(); reject(new Error('JSONP 載入失敗')); } };
    document.head.appendChild(s);
  });
}

/* ── 解析與清理 ───────────────────────────────────────── */
/* Sina 每列：{d:"2010-03-11", o,h,l,c,v, a} 全部是字串。
   清理規則都對應到實測到的具體瑕疵，不是想像出來的：
   · 價格非正或日期不合法 → 丟掉
   · 同一組 OHLC 連續重複（NVDA 2009-09-17/18）→ 只留第一筆，
     否則會被分割偵測當成一次基準切換，把整段歷史還原成錯的倍數
   · 同一天重複 → 留最後一筆 */
export function parseRows(raw) {
  const out = [];
  for (const r of raw || []) {
    const t = parseDay(r.d);
    const c = +r.c, o = +r.o, h = +r.h, l = +r.l;
    if (!isFinite(t) || !(c > 0) || !(o > 0)) continue;
    out.push({ t, o, h: isFinite(h) ? h : o, l: isFinite(l) ? l : o, c, v: +r.v || 0, d: r.d });
  }
  out.sort((a, b) => a.t - b.t);
  const cleaned = [];
  for (const r of out) {
    const p = cleaned[cleaned.length - 1];
    if (p) {
      if (p.t === r.t) { cleaned[cleaned.length - 1] = r; continue; }
      if (p.o === r.o && p.h === r.h && p.l === r.l && p.c === r.c && (r.t - p.t) <= 4 * 86400000) continue;
    }
    cleaned.push(r);
  }
  return cleaned;
}

/* ── 分割偵測 ─────────────────────────────────────────── */
/* 原理：分割生效日（ex-date）的「開盤價」必定約等於「前一日收盤價 ÷ 比例」，
   因為分割本身不改變價值——開盤價只反映隔夜市場的漲跌。
   用 ratio = 前收 / 當日開盤 去比對常見分割比例。

   門檻是量出來的，不是猜的（見 test/probe-split.mjs 的實測表）：
   · 整數比例（2、3、4…）用 10% 容差 —— 真分割的實測誤差最大 8%（AMZN 1999 三倍分割），
     而 TQQQ 2025-11-20 那次因當天大跌 -12%，誤差 5.5%，太緊會漏掉。
   · 分數比例一律不採 —— 放 3.5% 容差時，META 2022-10-27（-25%）、COIN 2022-05-11（-25%）、
     MSTR 2024-08-05（-30%）、AAPL/TSM 的 -30% 日全部被誤判成「3:2 分割」，
     而 2006 年之後的主流標的沒有任何一次分數分割（NVDA 2007 那次在可信區間之前）。
   · 再加上「鄰近日不得暴走」：真分割日的前後是普通交易日，
     而 GME 2021-01-29（單日 +68%，前兩天各 +130%）這種軋空行情不會被當成分割。

   已知先天限制：任何整數倍價格跳動在單一價格序列上與分割無法區分
   （例如恰好 +100% 的收購跳空），所以偵測到的分割會顯示在畫面上供檢視。 */
const INT_FACTORS = [2, 3, 4, 5, 6, 7, 8, 10, 12, 15, 20, 25, 30];

export function splitCandidates() {
  const out = [];
  for (const f of INT_FACTORS) { out.push({ f, tol: 0.10 }); out.push({ f: 1 / f, tol: 0.10 }); }
  return out;
}

export function snapSplit(ratio) {
  if (!(ratio > 1.3) && !(ratio < 0.77)) return 0;          // 這個量級才可能是分割
  let best = 0, bestErr = Infinity;
  for (const { f, tol } of splitCandidates()) {
    const err = Math.abs(ratio / f - 1);
    if (err <= tol && err < bestErr) { bestErr = err; best = f; }
  }
  return best;
}

/* 鄰近日（不含事件當天自己）有沒有暴走 */
function wildNeighbour(rows, i, thresh = 0.45) {
  const lo = Math.max(1, i - 3), hi = Math.min(rows.length - 1, i + 2);
  for (let j = lo; j <= hi; j++) {
    if (j === i) continue;
    const r = Math.abs(rows[j].c / rows[j - 1].c - 1);
    if (r > thresh) return true;
  }
  return false;
}

export function detectSplits(rows, opts = {}) {
  const guard = opts.neighbourGuard !== false;
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1].c, o = rows[i].o;
    if (!(prev > 0) || !(o > 0)) continue;
    const ratio = prev / o;
    const f = snapSplit(ratio);
    if (!f || f === 1) continue;
    if (guard && wildNeighbour(rows, i)) continue;
    out.push({ i, date: rows[i].d, factor: f, ratio, priceErr: Math.abs(ratio / f - 1) });
  }
  return out;
}

/* ── 向前還原 ─────────────────────────────────────────── */
/* 把「分割日之前」的價格除以比例，讓整條序列都在最新分割後的口徑上。
   ex-date 當天已經是分割後價格，所以不動它；分割日之前的每一根都要調整。
   註：反向分割的比例是 1/f（例如 1:2 → 0.5），除以 0.5 等於乘 2 —— 正確。 */
export function applySplits(rows) {
  const splits = detectSplits(rows);
  const at = new Map(splits.map(s => [s.i, s.factor]));
  const mult = new Array(rows.length).fill(1);
  let cum = 1;
  for (let k = rows.length - 1; k >= 0; k--) {
    mult[k] = cum;
    if (at.has(k)) cum *= at.get(k);
  }
  const out = rows.map((r, k) => ({
    t: r.t, c: r.c / mult[k], o: r.o / mult[k], h: r.h / mult[k], l: r.l / mult[k], v: r.v, mult: mult[k]
  }));
  return { rows: out, splits };
}

/* ── 內建快照（主流標的的主力來源）───────────────────── */
export async function snapshotDaily(ticker) {
  const sym = String(ticker).toUpperCase();
  const r = await fetch(`data/us/${encodeURIComponent(sym)}.json`, { cache: 'no-cache' });
  if (!r.ok) throw new Error('內建快照沒有 ' + sym + '（HTTP ' + r.status + '）');
  const j = await r.json();
  const c = j.c;
  if (!Array.isArray(c) || c.length < 20) throw new Error('內建快照格式不符');
  const rows = c.map(([d, p]) => ({ t: d * 86400000, c: p })).filter(x => x.t >= US_FROM_MS);
  return {
    rows, splits: [], full: null,
    src: '內建快照 · Yahoo', generated: j.g, name: j.n,
    used: rows.length, raw: c.length, curated: true
  };
}

/* ── Sina 日線（任意代號的備援）───────────────────────── */
export async function sinaDaily(ticker) {
  const v = 'dcl' + (++seq);
  const url = `${EP_K}${v}=/US_MinKService.getDailyK?symbol=${encodeURIComponent(ticker)}&___qn=3`;
  const raw = await jsonp(url, v, 25000);
  const all = parseRows(raw);
  const rows = all.filter(r => r.t >= US_FROM_MS);
  if (rows.length < 20) throw new Error('資料筆數不足（' + rows.length + ' 筆）');
  const { rows: adj, splits } = applySplits(rows);
  return {
    rows: adj.map(r => ({ t: r.t, c: r.c })),
    full: adj, splits,
    src: 'Sina（備援）',
    used: rows.length, raw: all.length,
    truncated: all.length > 0 && all[0].t < US_FROM_MS
  };
}

/* ── 搜尋建議 ─────────────────────────────────────────── */
/* 回傳格式（GBK，但回應標頭有宣告 charset，瀏覽器用 <script> 載入會正確解碼）：
   var sug="SOXL,41,soxl,soxl,半導體ETF-Direxion Daily三倍做多,...,;…" */
export async function sinaSuggest(q) {
  const v = 'dcs' + (++seq);
  const s = await jsonp(`${EP_SUG}${v}&key=${encodeURIComponent(q)}`, v, 12000);
  const out = [];
  for (const item of String(s || '').split(';')) {
    if (!item) continue;
    const f = item.split(',');
    const ticker = (f[2] || '').toUpperCase();
    const name = (f[4] || f[0] || '').trim();
    if (!ticker || !/^[A-Z][A-Z0-9.\-]{0,6}$/.test(ticker)) continue;
    out.push({ ticker, name });
  }
  const seen = new Set();
  return out.filter(x => !seen.has(x.ticker) && seen.add(x.ticker));
}
