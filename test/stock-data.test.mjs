/* stock-data.test.mjs — 美股「Sina 備援路徑」的驗證
   內建快照（主流標的的主力來源）由 us-snapshot.test.mjs 驗證；
   這支測試專門盯備援路徑，因為它要自己處理來源的瑕疵：
     · 沒有還原分割 → 偵測 + 向前還原
     · 連續重複列（NVDA 2009-09-17/18）→ 清理，否則會被當成基準切換
     · 個別交易日缺漏 → 無法在單一序列上修，但至少要知道它存在
   最後用內建快照當基準交叉比對：兩條路徑對 SOXL 的結論必須一致。

   執行：node test/stock-data.test.mjs
*/
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRows, detectSplits, applySplits, snapSplit, sinaDaily, US_POPULAR, US_TRUSTED_FROM } from '../js/api-us.js';
import { runBacktest } from '../js/dca.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DAY = 86400000;

let pass = 0, fail = 0;
const eq = (a, b, label) => { const ok = String(a) === String(b); ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}  got=${a} want=${b}`); };
const ok = (c, label) => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'}  ${label}`); };

async function fetchRaw(ticker) {
  const u = `https://stock.finance.sina.com.cn/usstock/api/jsonp.php/var%20D=/US_MinKService.getDailyK?symbol=${encodeURIComponent(ticker)}&___qn=3`;
  const r = await fetch(u);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const t = await r.text();
  const i = t.indexOf('=(');
  if (i < 0) throw new Error('JSONP 格式不符');
  return JSON.parse(t.slice(i + 2, t.lastIndexOf(')')));
}

console.log('\n[1] 分割比例判定（門檻是量出來的，見 probe-split.mjs）');
{
  eq(snapSplit(2.0), 2, '2.0 → 2:1');
  eq(snapSplit(1.98), 2, '1.98 → 2:1（10% 容差內）');
  eq(snapSplit(1.89), 2, '1.89 → 2:1（TQQQ 2025-11-20 當年大跌 5.5% 也抓得到）');
  eq(snapSplit(14.87), 15, '14.87 → 15:1（SOXL 2021）');
  eq(snapSplit(3.96), 4, '3.96 → 4:1（SOXL 2015）');
  eq(snapSplit(1 / 4), 0.25, '0.25 → 1:4 反向分割');
  eq(snapSplit(0.646), 0, '+54.8% 的單日暴漲不得判定為分割');
  eq(snapSplit(1.447), 0, '−38.6% 的崩盤（SOXL 2020-03-16）不得判定為分割');
  eq(snapSplit(1.25), 0, '−20% 的單日下跌不得判定為分割（分數比例不採用）');
}

console.log('\n[2] 原始列清理（Sina 的已知瑕疵）');
{
  const raw = [
    { d: '2020-01-02', o: '10', h: '11', l: '9.5', c: '10.5', v: '100' },
    { d: '2020-01-03', o: '15.5', h: '15.99', l: '15.28', c: '15.96', v: '200' },   // 被貼三次
    { d: '2020-01-06', o: '15.5', h: '15.99', l: '15.28', c: '15.96', v: '200' },
    { d: '2020-01-07', o: '15.5', h: '15.99', l: '15.28', c: '15.96', v: '200' },
    { d: '2020-01-08', o: '0', h: '0', l: '0', c: '0', v: '0' },                    // 無效價格
    { d: '2020-01-09', o: '16.1', h: '16.5', l: '15.9', c: '16.2', v: '300' },
    { d: '2020-01-09', o: '16.2', h: '16.6', l: '16.0', c: '16.4', v: '310' }       // 同一天重複 → 取後者
  ];
  const rows = parseRows(raw);
  eq(rows.length, 3, '三筆無效資料被清掉（重複列 2 筆 + 零價 1 筆）');
  eq(rows.map(r => r.d).join(','), '2020-01-02,2020-01-03,2020-01-09', '保留的日期');
  eq(rows[2].c, 16.4, '同一天重複取最後一筆');
  eq(detectSplits(rows).length, 0, '清理後不該再冒出假的分割事件');
}

console.log('\n[3] SOXL 走 Sina 備援：分割偵測要與官方一致（4:1、15:1）');
{
  const rows = parseRows(await fetchRaw('SOXL')).filter(r => r.d >= US_TRUSTED_FROM);
  const got = detectSplits(rows).map(s => [s.date, Math.round(s.factor * 1000) / 1000]);
  eq(JSON.stringify(got), JSON.stringify([['2015-05-20', 4], ['2021-03-02', 15]]), '偵測到的分割事件');
  const { rows: adj } = applySplits(rows);
  const byDate = new Map(adj.map(r => [new Date(r.t).toISOString().slice(0, 10), r.c]));
  eq(byDate.get('2010-03-11').toFixed(4), (39.63 / 60).toFixed(4), '上市日收盤 = 原始 39.63 ÷ 60');
  eq(byDate.get('2026-10-30').toFixed(2), '77.05', '最新收盤不受還原影響');

  /* 與內建快照（Yahoo）逐日比對 */
  const snap = JSON.parse(await readFile(join(HERE, '..', 'data', 'us', 'SOXL.json'), 'utf8'));
  const mine = new Map(snap.c.map(x => [new Date(x[0] * DAY).toISOString().slice(0, 10), x[1]]));
  const common = [...byDate.keys()].filter(d => mine.has(d));
  const devs = common.map(d => Math.abs(byDate.get(d) / mine.get(d) - 1)).sort((a, b) => a - b);
  const med = devs[Math.floor(devs.length / 2)];
  const p99 = devs[Math.floor(devs.length * 0.99)];
  console.log(`      共同 ${common.length} 天 · 中位數偏差 ${(med * 100).toFixed(4)}% · 第 99 百分位 ${(p99 * 100).toFixed(3)}%`);
  ok(med < 0.001 && p99 < 0.02, '兩條路徑（Sina 還原 vs 內建快照）對 SOXL 的結論一致');

  /* 引擎跑一次，確認期數與期間都合理 */
  const r = runBacktest(adj.map(x => ({ t: x.t, c: x.c })), { symbol: 'SOXL', freq: 'monthly', monthDay: 1, amount: 300, feePct: 0 });
  ok(r.ok && r.sum.periods === 199, `Sina 路徑的期數 199（實際 ${r.sum.periods}）`);
  ok(Math.abs(r.sum.totalRet - 38.906) < 0.02, `Sina 路徑的總報酬與快照一致（${(r.sum.totalRet * 100).toFixed(1)}%）`);
}

console.log('\n[4] 大波動日不得誤判成分割');
for (const [tk, day] of [['GME', '2021-01-29'], ['SOXL', '2020-03-16'], ['SOXL', '2025-04-09'], ['MSTR', '2024-11-21']]) {
  const rows = parseRows(await fetchRaw(tk)).filter(r => r.d >= US_TRUSTED_FROM);
  const hit = detectSplits(rows).filter(s => s.date === day);
  ok(hit.length === 0, `${tk} ${day} 未被當成分割${hit.length ? `（誤判為 ${hit[0].factor}）` : ''}`);
}

console.log('\n[5] 非內建清單的代號仍可取得（走備援）');
for (const tk of ['RIOT', 'AFRM', 'SNOW']) {
  let rows;
  try { rows = parseRows(await fetchRaw(tk)).filter(r => r.d >= US_TRUSTED_FROM); } catch (e) { console.log(`  SKIP  ${tk}：${e.message}`); continue; }
  ok(rows.length > 200 && !US_POPULAR.some(x => x[0] === tk),
    `${tk} 取得 ${rows.length} 筆（不在內建清單，需靠備援）`);
}

console.log('\n[6] 錯誤代號要優雅失敗');
{
  let err = null;
  try { const rows = parseRows(await fetchRaw('ZZZZNOTREAL')).filter(r => r.d >= US_TRUSTED_FROM); if (rows.length < 20) throw new Error('資料筆數不足'); } catch (e) { err = e.message; }
  ok(err !== null, `不存在的代號會拋錯而不是靜默回傳空資料（${err}）`);
}

console.log(`\n═══════════════════════════════════════\n  通過 ${pass} · 失敗 ${fail}\n═══════════════════════════════════════`);
process.exit(fail ? 1 : 0);
