/* us-snapshot.test.mjs — 驗證內建美股快照（data/us/*.json）
   這批檔案是「建置時從 Yahoo 抓下來、之後不會再變動」的資料，
   所以必須在進版控前確認：交易日本身合理、沒有殘留分割跳空、
   關鍵日期的價格與已知事實相符、而且與第二來源（Sina）對得起來。

   執行：node test/us-snapshot.test.mjs
*/
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { US_POPULAR, US_TRUSTED_FROM, parseRows, applySplits } from '../js/api-us.js';
import { runBacktest } from '../js/dca.js';
import { DAY } from '../js/util.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, '..', 'data', 'us');

let pass = 0, fail = 0;
const ok = (c, label) => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'}  ${label}`); };
const near = (a, b, tol, label) => { const c = Math.abs(a - b) <= tol; c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'}  ${label}  got=${a} want≈${b}`); };

const iso = (d) => new Date(d * DAY).toISOString().slice(0, 10);

/* 已知事實：全部換算成「最新分割後口徑」，與官方分割公告核對。
   例如 NVDA 2024-06-07 的原始收盤是 1208.88，2024-06-10 生效 10:1 → 120.888。
   TSLA 2020-08-28 原始 2213.40，之後 5:1 再 3:1 → 147.56。
   SOXL 上市當天（2010-03-11）原始 39.63，4:1 再 15:1 → 0.6605。 */
const FACTS = [
  ['SOXL', '2010-03-11', 0.6605], ['SOXL', '2026-10-30', 77.05],
  /* 分割日之前的價格要「再除以之後所有分割」，所以 SOXL 2015 年要 ÷60、NVDA 2021 年要 ÷40 */
  ['SOXL', '2015-05-19', 145.84 / 60], ['SOXL', '2021-03-01', 638.37 / 15],
  ['AAPL', '2020-08-28', 499.23 / 4], ['AAPL', '2021-01-28', 137.09],
  ['NVDA', '2024-06-07', 1208.88 / 10], ['NVDA', '2024-06-10', 121.79],
  ['NVDA', '2021-07-19', 751.19 / 40],
  ['TSLA', '2020-08-28', 2213.40 / 15], ['TSLA', '2022-08-25', 296.07],
  ['TQQQ', '2025-11-19', 100.05 / 2], ['TQQQ', '2025-11-20', 46.45]
];
/* 允許的極端日：這些是真的市場事件，不是資料錯誤
   2020-03-16/24 COVID 崩盤與反彈、2025-04-09 關稅暫停後的暴力反彈、
   2022-11-10 CPI 降溫、2020-11-09 疫苗消息、2016-04-22 AMD 財報＋授權案單日 +52% */
const KNOWN_EXTREME = ['2020-03-16', '2020-03-24', '2025-04-09', '2022-11-10', '2020-11-09', '2016-04-22'];

console.log('\n[1] 檔案完整性');
const files = (await readdir(DIR)).filter(f => f.endsWith('.json'));
const data = {};
for (const f of files) {
  const j = JSON.parse(await readFile(join(DIR, f), 'utf8'));
  data[j.s] = j;
}
ok(files.length === US_POPULAR.length, `檔案數 ${files.length} = 內建清單 ${US_POPULAR.length}`);
const missing = US_POPULAR.map(x => x[0]).filter(t => !data[t]);
ok(missing.length === 0, `清單中的標的都有檔案${missing.length ? '（缺 ' + missing.join(',') + '）' : ''}`);

let badSeries = [];
for (const [sym, j] of Object.entries(data)) {
  const days = j.c.map(x => x[0]);
  const sorted = days.every((d, i) => i === 0 || d > days[i - 1]);
  const positive = j.c.every(x => x[1] > 0);
  const inWindow = iso(days[0]) >= US_TRUSTED_FROM;
  const recent = iso(days[days.length - 1]) >= '2026-10-01';
  if (!sorted || !positive || !inWindow || !recent || j.c.length < 100) {
    badSeries.push(`${sym}(sorted=${sorted} pos=${positive} window=${inWindow} recent=${recent} n=${j.c.length})`);
  }
}
ok(badSeries.length === 0, `每一檔：日期遞增、價格為正、${US_TRUSTED_FROM} 之後、更新到最近${badSeries.length ? '｜問題：' + badSeries.join(' ') : ''}`);

console.log('\n[2] 不該殘留分割級跳空（分割沒還原就會看到 -50%/-75%/-94% 這種一天）');
for (const sym of Object.keys(data)) {
  const rows = data[sym].c;
  const jumps = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i][1] / rows[i - 1][1] - 1;
    if (Math.abs(r) > 0.45 && !KNOWN_EXTREME.includes(iso(rows[i][0]))) jumps.push(`${iso(rows[i][0])} ${(r * 100).toFixed(1)}%`);
  }
  ok(jumps.length === 0, `${sym} 無殘留分割跳空${jumps.length ? '：' + jumps.slice(0, 3).join(', ') : ''}`);
}

console.log('\n[3] 關鍵日期價格與已知事實相符');
for (const [sym, date, want] of FACTS) {
  const j = data[sym]; if (!j) { ok(false, `${sym} 沒有資料`); continue; }
  const hit = j.c.find(x => iso(x[0]) === date);
  if (!hit) { console.log(`  SKIP  ${sym} ${date} 該日不是交易日`); continue; }
  near(hit[1], want, Math.max(0.02, want * 0.001), `${sym} ${date} 收盤`);
}

console.log('\n[4] 分割邊界必須連續（ex-date 前後不該出現跳空）');
for (const [sym, dates] of [['SOXL', ['2015-05-20', '2021-03-02']], ['TQQQ', ['2011-02-25', '2012-05-11', '2018-05-24', '2022-01-13', '2025-11-20']],
['NVDA', ['2021-07-20', '2024-06-10']], ['AAPL', ['2014-06-09', '2020-08-31']], ['AMZN', ['2022-06-06']], ['GOOGL', ['2022-07-18']], ['MSTR', ['2024-08-08']]]) {
  const j = data[sym]; if (!j) continue;
  const idx = new Map(j.c.map((x, i) => [iso(x[0]), i]));
  const bad = [];
  for (const d of dates) {
    const i = idx.get(d);
    if (i == null || i === 0) continue;
    const r = j.c[i][1] / j.c[i - 1][1] - 1;
    if (Math.abs(r) > 0.25) bad.push(`${d} ${(r * 100).toFixed(1)}%`);
  }
  ok(bad.length === 0, `${sym} 分割日連續${bad.length ? '（跳空：' + bad.join(', ') + '）' : ''}`);
}

console.log('\n[5] 與第二來源（Sina）交叉比對：中位數誤差要近乎 0');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
async function sina(ticker) {
  const u = `https://stock.finance.sina.com.cn/usstock/api/jsonp.php/var%20D=/US_MinKService.getDailyK?symbol=${ticker}&___qn=3`;
  const r = await fetch(u);
  const t = await r.text();
  return parseRows(JSON.parse(t.slice(t.indexOf('=(') + 2, t.lastIndexOf(')')))).filter(x => x.d >= US_TRUSTED_FROM);
}
for (const sym of ['SOXL', 'TQQQ', 'SPY', 'QQQ', 'NVDA', 'AAPL', 'TSLA', 'MSFT', 'AMZN', 'GOOGL', 'GME', 'MSTR', 'COIN', 'PLTR']) {
  const j = data[sym]; if (!j) continue;
  let rows;
  try { rows = await sina(sym); } catch (e) { console.log(`  SKIP  ${sym}：${e.message}`); continue; }
  const { rows: adj } = applySplits(rows);
  const mine = new Map(j.c.map(x => [iso(x[0]), x[1]]));
  const theirs = new Map(adj.map(x => [new Date(x.t).toISOString().slice(0, 10), x.c]));
  const ratios = [...mine.keys()].filter(d => theirs.has(d)).map(d => mine.get(d) / theirs.get(d)).sort((a, b) => a - b);
  if (ratios.length < 100) { ok(false, `${sym} 共同日期只有 ${ratios.length} 天`); continue; }
  const med = ratios[Math.floor(ratios.length / 2)];
  const within2 = ratios.filter(r => Math.abs(r - 1) < 0.02).length / ratios.length;
  console.log(`  ${sym.padEnd(5)} 共同 ${String(ratios.length).padStart(5)} 天 · 中位數比值 ${med.toFixed(5)} · 2% 內比例 ${(within2 * 100).toFixed(2)}%`);
  /* Sina 偶有單日錯值，所以允許極少數離群，但中位數必須幾乎精準 */
  ok(Math.abs(med - 1) < 0.002 && within2 > 0.97, `${sym} 與 Sina 交叉比對通過`);
}

console.log('\n[6] 引擎跑 SOXL（每月 300 美元、手續費 0）');
{
  const j = data.SOXL;
  const candles = j.c.map(x => ({ t: x[0] * DAY, c: x[1] }));
  const r = runBacktest(candles, { symbol: 'SOXL', freq: 'monthly', monthDay: 1, amount: 300, feePct: 0 });
  ok(r.ok, '回測成功');
  console.log(`      期間 ${new Date(r.sum.from).toISOString().slice(0, 10)} → ${new Date(r.sum.to).toISOString().slice(0, 10)}，${r.sum.periods} 期`);
  console.log(`      總投入 ${r.sum.invested.toFixed(0)} → 期末 ${r.sum.finalValue.toFixed(0)}（${(r.sum.totalRet * 100).toFixed(1)}%）`);
  console.log(`      年化 XIRR ${(r.sum.xirr * 100).toFixed(2)}% · 最大回撤 ${(r.sum.maxDD * 100).toFixed(1)}% · 期間價格漲幅 ${(r.sum.priceRet * 100).toFixed(1)}%`);
  ok(r.sum.periods === 199, `期數 199（2010-04 起每月）實際 ${r.sum.periods}`);
  ok(r.sum.totalRet > 10 && r.sum.totalRet < 200, `總報酬在合理區間（${(r.sum.totalRet * 100).toFixed(0)}%）`);
  ok(r.sum.maxDD < -0.8 && r.sum.maxDD > -0.99, `最大回撤反映 3 倍 ETF 的真實痛感（${(r.sum.maxDD * 100).toFixed(1)}%）`);
}

console.log(`\n═══════════════════════════════════════\n  通過 ${pass} · 失敗 ${fail}\n═══════════════════════════════════════`);
process.exit(fail ? 1 : 0);
