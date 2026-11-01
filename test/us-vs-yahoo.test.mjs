/* us-vs-yahoo.test.mjs — 用 Yahoo Finance 當獨立基準，驗證「Sina 原始 + 自家分割還原」

   Yahoo 沒有 CORS，瀏覽器端用不了，但很適合當第二意見：
   Yahoo 的 quote.close 是「已還原分割、未還原股利」，正好與我們的目標語意相同。

   這支測試要回答兩個問題：
     1. 分割偵測有沒有跟官方事件一致（漏一次 → 整段歷史差一個倍數）
     2. 還原後的序列基準對不對（中位數偏差 ~0 就代表基準正確）

   判準刻意不設「每一天都一致」：Sina 是個別交易日會出錯的來源
   （已證實：MSFT／TSM 少了 2014-07-16 而把當天收盤掛到前一天；2016-06-27 多檔同時對不上），
   硬要每一天都對齊只會得到一個永遠紅的測試。所以要求中位數近乎 0、
   偏差 >2% 的天數是個位數，並把這些已知瑕疵列出來。

   執行：node test/us-vs-yahoo.test.mjs
*/
import { parseRows, applySplits } from '../js/api-us.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
/* 美股只提供 2006 年之後的區間（更早在來源端有未標示的基準調整，見 js/api-us.js） */
const TRUSTED_FROM = '2006-01-01';

let pass = 0, fail = 0;
const ok = (c, label) => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'}  ${label}`); };

async function sina(ticker) {
  const u = `https://stock.finance.sina.com.cn/usstock/api/jsonp.php/var%20D=/US_MinKService.getDailyK?symbol=${ticker}&___qn=3`;
  const r = await fetch(u);
  const t = await r.text();
  return parseRows(JSON.parse(t.slice(t.indexOf('=(') + 2, t.lastIndexOf(')'))));
}

async function yahooCloses(ticker) {
  const u = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?period1=0&period2=${Math.floor(Date.now() / 1000)}&interval=1d`;
  const r = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  const res = j.chart?.result?.[0];
  if (!res) throw new Error('回應沒有 result');
  const ts = res.timestamp || [], cl = res.indicators.quote[0].close || [];
  const map = new Map();
  for (let i = 0; i < ts.length; i++) if (cl[i] != null) map.set(new Date(ts[i] * 1000).toISOString().slice(0, 10), cl[i]);
  return map;
}

async function yahooSplits(ticker) {
  const u = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=max&interval=1d&events=split`;
  const r = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  const j = await r.json();
  const ev = j.chart?.result?.[0]?.events?.splits || {};
  return Object.values(ev)
    .map(x => ({ date: new Date(x.date * 1000).toISOString().slice(0, 10), ratio: x.numerator / x.denominator }))
    .filter(x => x.date >= TRUSTED_FROM)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/* 常見的 DCA 標的：含多次分割的（TQQQ/NVDA/AAPL/TSLA/AMZN/GOOGL）、
   以及歷史上有極端單日暴走、絕不能被誤判成分割的（GME/MSTR/COIN/PLTR） */
const TICKERS = ['SOXL', 'TQQQ', 'SPY', 'QQQ', 'VOO', 'SMH', 'NVDA', 'AAPL', 'MSFT',
  'TSLA', 'AMZN', 'GOOGL', 'META', 'TSM', 'AMD', 'GME', 'MSTR', 'COIN', 'PLTR'];

const rec = {};
/* TQQQ 2011-02-25 那次，Sina 的資料整個交易日不見了（事件本身看不見），
   且該區段基準與 Yahoo 不同 → 這檔從 2011-03-01 起才算可信。 */
const FROM = { TQQQ: '2011-03-01' };

console.log(`\n[1] Sina（自家還原後）vs Yahoo：中位數必須幾乎精準，只有極少數單日瑕疵`);
for (const tk of TICKERS) {
  let raw, y;
  try { raw = await sina(tk); y = await yahooCloses(tk); } catch (e) { console.log(`  SKIP  ${tk}：${e.message}`); continue; }
  /* 與執行期路徑一致：先濾掉 2006 年之前，再偵測並還原分割 */
  const { rows: adj, splits } = applySplits(raw.filter(x => x.d >= TRUSTED_FROM));
  rec[tk] = { splits, adj };
  const byDate = new Map(adj.map(r => [new Date(r.t).toISOString().slice(0, 10), r.c]));
  const from1 = FROM[tk] || TRUSTED_FROM;
  const common = [...byDate.keys()].filter(d => y.has(d) && d >= from1).sort();
  if (common.length < 200) { ok(false, `${tk} 共同日期只有 ${common.length} 天，無法驗證`); continue; }
  const devs = common.map(d => ({ d, e: Math.abs(byDate.get(d) / y.get(d) - 1) })).sort((a, b) => a.e - b.e);
  const med = devs[Math.floor(devs.length / 2)].e;
  const p99 = devs[Math.floor(devs.length * 0.99)].e;
  const over2 = devs.filter(x => x.e > 0.02);
  console.log(`  ${tk.padEnd(5)} 共同 ${String(common.length).padStart(5)} 天 · 分割 ${splits.length} 次 · 中位數 ${(med * 100).toFixed(4)}% · p99 ${(p99 * 100).toFixed(3)}% · >2% 共 ${over2.length} 天${over2.length ? '（' + over2.slice(0, 3).map(x => x.d).join(' ') + '）' : ''}`);
  ok(med < 0.001 && p99 < 0.02 && over2.length <= 4, `${tk} 基準正確、只有極少數單日瑕疵`);
}

console.log('\n[2] 分割事件必須與 Yahoo 官方一致');
/* 正規化：只取真正的分割（整數比例 ≥1.4，排除 TSM 那種 1.03／1.005 的股票股利），
   比例允許 2% 誤差（Yahoo 給 1.998 與 2 是同一件事）。 */
/* 我這邊用「已判定的倍數」x.factor（不受當日市場漲跌影響）；
   Yahoo 那邊只有價格比 x.ratio，所以要求它接近整數才算真正的分割。 */
const normMine = (list) => list
  .filter(x => x.factor >= 1.4 && Math.abs(x.factor - Math.round(x.factor)) < 1e-6)
  .map(x => [x.date, Math.round(x.factor * 100) / 100])
  .sort((a, b) => a[0].localeCompare(b[0]));
const normYahoo = (list) => list
  .filter(x => x.ratio >= 1.4 && Math.abs(x.ratio - Math.round(x.ratio)) < 0.02)
  .map(x => [x.date, Math.round(x.ratio * 100) / 100])
  .sort((a, b) => a[0].localeCompare(b[0]));
for (const tk of TICKERS) {
  const r = rec[tk]; if (!r) continue;
  let y;
  try { y = await yahooSplits(tk); } catch (e) { console.log(`  SKIP  ${tk}：${e.message}`); continue; }
  const from = FROM[tk] || TRUSTED_FROM;
  const mine = normMine(r.splits.filter(x => x.date >= from));
  const theirs = normYahoo(y.filter(x => x.date >= from));
  /* 嚴格相等是理想，但兩檔有例外：NVDA 2006-04-07、GME 2007-03-19 的官方分割
     在 Sina 的資料裡已經內建（沒有跳空 → 單一價格序列上不可能偵測到），那一筆只能少。
     所以拆成兩件真正該保證的事：
       (a) 我偵測到的每個事件都在 Yahoo 官方清單裡（不可有誤判）
       (b) Yahoo 多出來的事件只可能落在 2008 年之前（已內建調整的舊區段） */
  const yMap = new Map(theirs.map(x => [x[0], x[1]]));
  const falsePos = mine.filter(m => yMap.get(m[0]) !== m[1]);
  const missed = theirs.filter(t => !mine.some(m => m[0] === t[0] && m[1] === t[1]));
  const missedOK = missed.every(t => t[0] < '2008-01-01');
  ok(falsePos.length === 0 && missedOK,
    `${tk} 分割事件${JSON.stringify(mine) === JSON.stringify(theirs) ? '完全一致' : '與官方一致（差額僅來自舊區段已內建者）'}`
    + `（我：${mine.map(m => m.join(':')).join(', ') || '無'}｜官方有但未偵測：${missed.map(m => m.join(':')).join(', ') || '無'}`
    + `${falsePos.length ? '｜誤判！' + JSON.stringify(falsePos) : ''}）`);
}

console.log('\n[3] 極端單日暴走不得被誤判成分割（並且要保留那個漲跌）');
for (const [tk, day, minMove] of [['GME', '2021-01-29', 0.5], ['GME', '2021-02-02', 0.4], ['SOXL', '2020-03-16', 0.3],
['SOXL', '2025-04-09', 0.4], ['TSLA', '2020-02-03', 0.15], ['MSTR', '2024-11-21', 0.1], ['NVDA', '2024-02-22', 0.1]]) {
  const r = rec[tk]; if (!r) continue;
  const bad = r.splits.filter(x => x.date === day);
  const byDate = new Map(r.adj.map(x => [new Date(x.t).toISOString().slice(0, 10), x.c]));
  const keys = [...byDate.keys()].sort();
  const i = keys.indexOf(day);
  const move = i > 0 ? byDate.get(day) / byDate.get(keys[i - 1]) - 1 : NaN;
  ok(bad.length === 0 && Math.abs(move) >= minMove,
    `${tk} ${day} 未被當成分割，且真實漲跌保留（${(move * 100).toFixed(1)}%）${bad.length ? ' ← 誤判！' : ''}`);
}

console.log('\n[4] 還原後不該殘留「分割級」跳空（>45% 且找不到事件解釋）');
for (const tk of ['SOXL', 'TQQQ', 'NVDA', 'AAPL', 'TSLA', 'MSFT', 'AMZN', 'SPY']) {
  const r = rec[tk]; if (!r) continue;
  const bad = [];
  for (let i = 1; i < r.adj.length; i++) {
    const mk = new Date(r.adj[i].t).toISOString().slice(0, 10);
    const x = r.adj[i].c / r.adj[i - 1].c - 1;
    if (Math.abs(x) > 0.45) bad.push(`${mk} ${(x * 100).toFixed(1)}%`);
  }
  /* 3 倍槓桿 ETF 在最極端的日子確實能到 ±50%（市場事件），所以容許少數幾筆 */
  ok(bad.length <= 3, `${tk} 殘留跳空 ${bad.length} 筆${bad.length ? '：' + bad.slice(0, 4).join(', ') : ''}`);
}

console.log(`\n═══════════════════════════════════════\n  通過 ${pass} · 失敗 ${fail}\n═══════════════════════════════════════`);
process.exit(fail ? 1 : 0);
