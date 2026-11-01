/* api.js — 資料層。全部走交易所／行情網站的公開端點，不需要任何 API key。

   為什麼要三層備援：這個站是純靜態（GitHub Pages），瀏覽器直接打交易所，
   所以能不能用完全取決於 (1) CORS (2) 地區封鎖 (3) 速率限制。
   實測：api.binance.com 與 data-api.binance.vision 都回 Access-Control-Allow-Origin: *，
   但 Bybit / OKX 公開端點不回 ACAO，瀏覽器端根本讀不到 → 不用。
   CoinGecko 有 ACAO，當作第三層（只有日線收盤價，沒有日內）。
   最後一層是打包在站內的 data/snapshot.json（幾檔主流的完整日線），
   連不到網路時至少還能跑 BTC / ETH 展示，不會整個白畫面。 */

import { DAY, num } from './util.js';
import * as US from './api-us.js';

const EP = {
  binance: 'https://api.binance.com',
  vision: 'https://data-api.binance.vision',
  cg: 'https://api.coingecko.com/api/v3'
};

/* 資料來源狀態。不能叫 api：app.js 用 `import * as api` 匯入命名空間，
   兩者同名會讓 status.source 讀到 undefined（namespace 上沒有 source 這個鍵）。 */
export const status = { source: '—', lastError: null, cacheHits: 0, note: null, splits: [], name: null,
  trying: null, tries: [], probe: null };

async function jget(url, timeout = 12000) {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ac.signal, cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(to); }
}

/* ── 快取：記憶體 + sessionStorage ──────────────────── */
const mem = new Map();
const SS = 'dcalab.';
function ssGet(key, ttl) {
  try {
    const raw = sessionStorage.getItem(SS + key);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (Date.now() - o.t > ttl) return null;
    return o.v;
  } catch (e) { return null; }
}
function ssSet(key, v) {
  try {
    const raw = JSON.stringify({ t: Date.now(), v });
    if (raw.length > 250000) return;               // 太大就不要佔 sessionStorage 配額
    sessionStorage.setItem(SS + key, raw);
  } catch (e) { /* 配額滿就略過 */ }
}
async function cached(key, ttl, fn) {
  const hit = mem.get(key);
  if (hit && Date.now() - hit.t < ttl) { status.cacheHits++; return hit.v; }
  const s = ssGet(key, ttl);
  if (s) { status.cacheHits++; mem.set(key, { t: Date.now(), v: s }); return s; }
  const v = await fn();
  if (v !== undefined && v !== null) { mem.set(key, { t: Date.now(), v }); ssSet(key, v); }
  return v;
}

/* ── 先探路：兩個 Binance 入口同時打一個最小請求（1 根 K 線），誰先回應就用誰 ──
   為什麼要這樣：循序試（先 api.binance.com，逾時才換 vision）在對方被擋或很慢時，
   使用者要等完整個逾時才會看到進度；並行探路是小請求、幾乎同時出發，
   最慢情況下也只等一次逾時的長度。 */
async function pickBase(symbol) {
  const t0 = Date.now();
  const probe = (base) => jget(`${base}/api/v3/klines?symbol=${symbol}&interval=1d&limit=1`, 7000)
    .then(r => { if (!Array.isArray(r) || !r.length) throw new Error('空回應'); return { base, ms: Date.now() - t0 }; });
  try {
    const w = await Promise.any([probe(EP.binance), probe(EP.vision)]);
    status.probe = w;
    return w.base;
  } catch (e) {
    status.probe = null;
    return null;                       // 兩個入口都不可用 → 交給後面的備援鏈
  }
}

/* ── 日線 K 線 ──────────────────────────────────────── */
/* 回傳 [{t, c}]；t 為 UTC 00:00。pageSize=1000（Binance 上限）。 */
async function binanceKlines(base, symbol, startMs, endMs) {
  const out = [];
  let from = startMs;
  for (let i = 0; i < 12; i++) {
    const u = `${base}/api/v3/klines?symbol=${symbol}&interval=1d&limit=1000&startTime=${from}` + (endMs ? `&endTime=${endMs}` : '');
    const j = await jget(u, 10000);
    if (!Array.isArray(j) || !j.length) break;
    for (const k of j) out.push({ t: k[0], c: num(k[4]) });
    if (j.length < 1000) break;
    from = j[j.length - 1][0] + DAY;
    if (endMs && from > endMs) break;
  }
  return out;
}

/* CoinGecko：需要幣種 id，只列常見主流（備援用，抓不到就算了） */
const CG_ID = {
  BTC: 'bitcoin', ETH: 'ethereum', BNB: 'binancecoin', SOL: 'solana', XRP: 'ripple', ADA: 'cardano',
  DOGE: 'dogecoin', TRX: 'tron', DOT: 'polkadot', LTC: 'litecoin', LINK: 'chainlink', AVAX: 'avalanche-2',
  MATIC: 'matic-network', TON: 'the-open-network', SHIB: 'shiba-inu', ATOM: 'cosmos', XLM: 'stellar',
  NEAR: 'near', FIL: 'filecoin', ETC: 'ethereum-classic', UNI: 'uniswap', APT: 'aptos', ARB: 'arbitrum',
  OP: 'optimism', SUI: 'sui', BCH: 'bitcoin-cash', ICP: 'internet-computer', HBAR: 'hedera-hashgraph',
  PEPE: 'pepe', WIF: 'dogwifcoin', INJ: 'injective-protocol', TIA: 'celestia', SEI: 'sei-network',
  RNDR: 'render-token', ALGO: 'algorand', VET: 'vechain', SAND: 'the-sandbox', MANA: 'decentraland',
  AXS: 'axie-infinity', GRT: 'the-graph', EOS: 'eos', AAVE: 'aave', MKR: 'maker', CRV: 'curve-dao-token'
};
/* CoinGecko 公開 API 一次最多只能查約 365 天的區間（超過會回 401 error_code 10012
   「exceeds the allowed time range」）。所以要自己切成一年一段往前抓，
   每段之間停一下避免被限流；已經抓到資料後某一段失敗就沿用現有的並跳過，
   整段都抓不到才往上拋（讓呼叫端換下一層備援）。 */
const CG_WINDOW = 360 * DAY;
async function cgChunk(id, from, to) {
  const u = `${EP.cg}/coins/${id}/market_chart/range?vs_currency=usd&from=${Math.floor(from / 1000)}&to=${Math.floor(to / 1000)}`;
  const j = await jget(u, 25000);
  const arr = (j && j.prices) || [];
  /* 回傳是每小時／每日混合；只留「每天最後一筆」當收盤價，避免同一天多點。 */
  const byDay = new Map();
  for (const [ts, p] of arr) byDay.set(Math.floor(ts / DAY) * DAY, num(p));
  return [...byDay.entries()].map(([t, c]) => ({ t, c })).sort((a, b) => a.t - b.t);
}

async function cgKlines(symbol, startMs, endMs) {
  const base = symbol.replace(/USDT$/, '');
  const id = CG_ID[base];
  if (!id) throw new Error('CoinGecko 無此幣種對照：' + base);
  const to = endMs || Date.now();
  /* 實測：CoinGecko 免費層不只看「單次查詢長度」，也限制「能回溯多久」——
     查 2017 年開始的區間，就算切成一年一段，每一段都回 401 error_code 10012
     （historical data within the past 365 days）。所以這裡直接夾到近 355 天，
     並把「期間被縮短」記在 status.note 讓畫面顯示，不讓使用者以為跑的是原區間。 */
  const oldest = Date.now() - 355 * DAY;
  const ask = startMs || oldest;
  const from = Math.max(ask, oldest);
  if (ask < oldest) status.note = 'CoinGecko 免費層僅提供近 365 天日線，回測期間已自動調整';
  const windows = [];
  for (let a = from; a < to; a += CG_WINDOW) windows.push([a, Math.min(a + CG_WINDOW, to)]);
  const out = new Map();
  let fails = 0;
  for (let i = 0; i < windows.length; i++) {
    const [a, b] = windows[i];
    const key = `cg|${id}|${Math.floor(a / DAY)}|${Math.floor(b / DAY)}`;
    try {
      const rows = await cached(key, 6 * 3600e3, () => cgChunk(id, a, b));
      for (const r of rows) out.set(r.t, r.c);
    } catch (e) {
      fails++;
      if (out.size === 0 && fails >= 2) throw e;      // 完全抓不到就換下一層
    }
    if (i < windows.length - 1) await new Promise(r => setTimeout(r, 2200));  // 公開 API 限流
  }
  return [...out.entries()].map(([t, c]) => ({ t, c })).sort((a, b) => a.t - b.t);
}

const SNAP = 'data/snapshot.json';
const CRYPTO_FROM = Date.UTC(2017, 0, 1);     // Binance 現貨最早的日線從 2017-08 開始

/* ── 統一入口：加密貨幣 / 美股 ETF ──────────────────────
   兩種市場各自有自己的備援鏈，回傳格式統一成 [{t, c}]。
   額外的來源資訊（實際來源名稱、還原過的分割、標的全名）放在 status 上，
   讓畫面可以誠實標示「這筆資料哪來的」。 */
export async function fetchSeries(asset, symbol) {
  const key = `s1|${asset}|${symbol}`;
  const hitsBefore = status.cacheHits;
  status.note = null;            // 每次重新評估，避免上一次的提示殘留
  status.splits = [];
  status.name = null;
  status.tries = [];
  status.trying = null;
  const got = await cached(key, 10 * 60e3, async () => {
    if (asset === 'us') {
      /* 主流標的先用內建快照（建置時從 Yahoo 抓、已驗證），
         不在清單裡的代號才走 Sina 備援（會自己偵測並還原分割）。 */
      const tries = [];
      if (US.isCurated(symbol)) tries.push(['內建快照 · Yahoo', () => US.snapshotDaily(symbol)]);
      tries.push(['Sina（備援）', () => US.sinaDaily(symbol)]);
      for (const [name, fn] of tries) {
        const t0 = Date.now();
        status.trying = name;
        try {
          const out = await fn();
          if (out && out.rows && out.rows.length > 20) {
            status.source = out.src || name;
            status.splits = out.splits || [];
            status.name = out.name || US.US_POPULAR_MAP.get(String(symbol).toUpperCase()) || null;
            status.lastError = null;
            if (!out.curated) status.note = '此代號不在內建清單，改用 Sina 備援資料（交易日可能偶有缺漏）';
            status.tries.push({ name, ms: Date.now() - t0, ok: true });
            status.trying = null;
            return out.rows;
          }
          status.lastError = `${name}：沒有資料`;
          status.tries.push({ name, ms: Date.now() - t0, ok: false, err: '沒有資料' });
        } catch (e) {
          status.lastError = `${name}：${e.message}`;
          status.tries.push({ name, ms: Date.now() - t0, ok: false, err: e.message });
        }
      }
      status.trying = null;
      return null;
    }
    /* 先用最小請求探路，誰快用誰。探針失敗代表兩個 Binance 入口都不通，
       這時就不要再循序各等一次逾時（那會白白多花兩倍時間），直接往下走備援。 */
    const best = await pickBase(symbol);
    const tries = [];
    if (best) {
      const other = best === EP.binance ? EP.vision : EP.binance;
      tries.push([best === EP.binance ? 'Binance' : 'Binance Vision', () => binanceKlines(best, symbol, CRYPTO_FROM)]);
      tries.push([other === EP.binance ? 'Binance' : 'Binance Vision', () => binanceKlines(other, symbol, CRYPTO_FROM)]);
    }
    tries.push(['CoinGecko', () => cgKlines(symbol, CRYPTO_FROM)]);
    tries.push(['內建快照', async () => snapshot(symbol, CRYPTO_FROM)]);
    for (const [name, fn] of tries) {
      const t0 = Date.now();
      status.trying = name;
      try {
        const rows = await fn();
        const ms = Date.now() - t0;
        if (rows && rows.length > 2) {
          status.source = name;
          status.lastError = null;
          status.tries.push({ name, ms, ok: true });
          status.trying = null;
          if (name !== 'CoinGecko') status.note = null;   // 換到別的來源就不該再顯示它的限制
          return rows;
        }
        status.lastError = `${name}：沒有資料`;
        status.tries.push({ name, ms, ok: false, err: '沒有資料' });
      } catch (e) {
        status.lastError = `${name}：${e.message}`;
        status.tries.push({ name, ms: Date.now() - t0, ok: false, err: e.message });
      }
    }
    status.trying = null;
    return null;
  });
  /* 這次是直接從快取拿到資料、完全沒連網（同一個分頁 10 分鐘內再切回來）：
     仍然要讓使用者知道資料是哪來的，不能顯示空白。 */
  if (status.cacheHits > hitsBefore && status.source === '—') status.source = '快取';
  return got;
}

let snapCache = null;
async function snapshot(symbol, startMs, endMs) {
  if (!snapCache) snapCache = await jget(SNAP, 8000);
  const s = snapCache && snapCache.series && snapCache.series[symbol];
  if (!s) throw new Error('內建快照沒有這個幣種');
  return s.map(([d, c]) => ({ t: d * DAY, c })).filter(r => (!startMs || r.t >= startMs) && (!endMs || r.t <= endMs));
}

/* ── 市場幣種清單 ────────────────────────────────────── */
/* 用 24hr ticker 依成交額排序：使用者想找的通常是熱門幣，不該讓他捲一長串。 */
export async function fetchUniverse() {
  return cached('univ', 10 * 60e3, async () => {
    try {
      const [info, tk] = await Promise.all([
        jget(EP.binance + '/api/v3/exchangeInfo', 20000),
        /* type=MINI 的 payload 只有 FULL 的一半（約 1MB vs 1.9MB）；
           它沒有 priceChangePercent，所以漲跌幅自己用 last/open 推。 */
        jget(EP.binance + '/api/v3/ticker/24hr?type=MINI', 20000)
      ]);
      const ok = new Set();
      for (const s of info.symbols || []) {
        if (s.status === 'TRADING' && s.quoteAsset === 'USDT' && s.isSpotTradingAllowed !== false) ok.add(s.symbol);
      }
      const STABLE = /^(USDC|FDUSD|TUSD|BUSD|DAI|USDP|EURI|AEUR|USD1|XUSD|USDE|PYUSD|USDJ|SUSD|USTC|GBP|TRY|BRL|ARS|JPY|ZAR|PLN|RON|CZK|MXN|COP|UAH|NGN|IDRT|BIDR|VAI|BVND|PAXG|EUR)$/;
      const list = [];
      for (const t of tk) {
        if (!ok.has(t.symbol)) continue;
        const base = t.symbol.slice(0, -4);
        if (STABLE.test(base) || /(UP|DOWN|BULL|BEAR)$/.test(base)) continue;
        const qv = num(t.quoteVolume);
        if (!(qv > 0)) continue;
        const lp = num(t.lastPrice), op = num(t.openPrice);
        const chg = isFinite(t.priceChangePercent) ? num(t.priceChangePercent)
          : (op > 0 ? (lp / op - 1) * 100 : NaN);
        list.push({ symbol: t.symbol, base, price: lp, chg, qv });
      }
      list.sort((a, b) => b.qv - a.qv);
      return list;
    } catch (e) {
      status.lastError = '幣種清單：' + e.message;
      return FALLBACK_LIST;
    }
  });
}

export const FALLBACK_LIST = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'TONUSDT', 'DOTUSDT', 'LTCUSDT']
  .map(s => ({ symbol: s, base: s.slice(0, -4), price: NaN, chg: NaN, qv: 0 }));

/* ── 匯率：USDT → TWD（單純為了讓金額看得懂，只抓即時值）── */
export async function fetchUsdTwd() {
  return cached('fx', 60 * 60e3, async () => {
    try {
      const j = await jget(EP.cg + '/simple/price?ids=tether&vs_currencies=twd', 12000);
      const v = num(j && j.tether && j.tether.twd);
      if (v > 5 && v < 200) return v;
    } catch (e) { /* 略過，用預設 */ }
    return 32;
  });
}
