/* util.js — 純函式格式化與日期工具（無 DOM 依賴，Node 也可載入） */
'use strict';

export const DAY = 86400000;

/* ── 數字 ─────────────────────────────────────────────── */
export function num(v) { const n = typeof v === 'number' ? v : parseFloat(v); return isFinite(n) ? n : NaN; }

export function fmt(n, dp = 2) {
  if (!isFinite(n)) return '—';
  const a = Math.abs(n);
  const d = a >= 1000 ? Math.min(dp, 2) : a >= 1 ? dp : a >= 0.01 ? 6 : 8;
  return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

/* 價格：小數幣種（SHIB 這種 0.00000x）要有足夠位數，不然整欄都是 0.00 */
export function fmtPrice(n) {
  if (!isFinite(n)) return '—';
  const a = Math.abs(n);
  const d = a >= 1000 ? 2 : a >= 100 ? 2 : a >= 1 ? 3 : a >= 0.01 ? 5 : a >= 0.0001 ? 7 : 10;
  return n.toLocaleString('en-US', { minimumFractionDigits: Math.min(d, 2), maximumFractionDigits: d });
}

export function fmtPct(n, dp = 2, signed = true) {
  if (!isFinite(n)) return '—';
  const s = signed && n > 0 ? '+' : '';
  return s + (n * 100).toFixed(dp) + '%';
}

/* 金額縮寫：1.24 萬 / 3.5 億 / 12.3K。圖表軸與大卡用。 */
export function fmtShort(n, unit = '$') {
  if (!isFinite(n)) return '—';
  const a = Math.abs(n), s = n < 0 ? '-' : '';
  if (a >= 1e8) return s + unit + (a / 1e8).toFixed(2) + '億';
  if (a >= 1e4) return s + unit + (a / 1e4).toFixed(a >= 1e6 ? 0 : 1) + '萬';
  if (a >= 1000) return s + unit + (a / 1000).toFixed(1) + 'K';
  return s + unit + a.toFixed(a < 10 ? 2 : 0);
}

export function fmtQty(n) {
  if (!isFinite(n)) return '—';
  const a = Math.abs(n);
  const d = a >= 1000 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 6 : 8;
  return n.toLocaleString('en-US', { maximumFractionDigits: d });
}

export function signedClass(n, flip = false) {
  if (!isFinite(n) || n === 0) return 'flat';
  const up = n > 0;
  return (flip ? !up : up) ? 'up' : 'down';
}

/* ── 日期（一律 UTC，與交易所日線一致）──────────────────── */
export function isoDay(ms) { return new Date(ms).toISOString().slice(0, 10); }

export function parseDay(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str || '').trim());
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3]);
}

export function todayUTC() { const n = new Date(); return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()); }

export function addDays(ms, n) { return ms + n * DAY; }

/** 兩個日期相差幾天（整數） */
export function daysBetween(a, b) { return Math.round((b - a) / DAY); }

/** 某日屬星期幾（UTC）：0=日 … 6=六 */
export function dow(ms) { return new Date(ms).getUTCDay(); }

/** 月內第幾天（UTC） */
export function dom(ms) { return new Date(ms).getUTCDate(); }

/** UTC 當月 1 號 00:00 */
export function monthStart(ms) { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); }

/** 加 n 個月（錨定 1 號，避免月底溢位） */
export function addMonths(ms, n) {
  const d = new Date(ms);
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + n;
  return Date.UTC(y + Math.floor(m / 12), ((m % 12) + 12) % 12, 1);
}

/** 該月最後一天的日數 */
export function daysInMonth(ms) {
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

export const WEEKDAYS = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
