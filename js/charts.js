/* charts.js — 自繪 Canvas 圖表（零依賴）
   不引外部圖表庫的理由：這個站的資料量不大（最多幾千點），
   自己畫可以完全控制節距、字體、hover 行為與動畫，而且不會被 CDN 擋掉。

   對外只有兩個函式：
     mount(canvas, tooltipEl)    建立/更新一張圖（會自動處理 DPR、resize、hover）
     redrawAll()                 視窗大小或主題變動時全部重畫
*/

const PAL = {
  grid: 'rgba(140,170,220,.10)',
  gridHi: 'rgba(140,170,220,.20)',
  axis: 'rgba(150,180,225,.55)',
  text: 'rgba(170,196,224,.85)',
  textDim: 'rgba(140,166,196,.65)'
};

const registry = new Set();

/* ── 刻度 ─────────────────────────────────────────────── */
export function niceTicks(min, max, count = 5) {
  if (!isFinite(min) || !isFinite(max) || min === max) return [min];
  const span = max - min;
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) out.push(v);
  return out;
}

const DAY_MS = 86400000;
const TSTEPS = [DAY_MS, 2 * DAY_MS, 7 * DAY_MS, 14 * DAY_MS, 30 * DAY_MS, 90 * DAY_MS, 182 * DAY_MS, 365 * DAY_MS, 730 * DAY_MS, 1095 * DAY_MS, 1825 * DAY_MS];

export function timeTicks(t0, t1, target = 7) {
  const span = t1 - t0;
  let step = TSTEPS[TSTEPS.length - 1];
  for (const s of TSTEPS) { if (span / s <= target) { step = s; break; } }
  const out = [];
  const d = new Date(t0);
  /* 用日曆對齊（月／年邊界）比用固定毫秒數漂亮 */
  const label = (t) => {
    const dt = new Date(t);
    if (span > 900 * DAY_MS) return String(dt.getUTCFullYear());
    if (span > 70 * DAY_MS) return `${dt.getUTCFullYear().toString().slice(2)}/${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
    return `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}`;
  };
  if (step >= 30 * DAY_MS) {
    const months = Math.round(step / (30 * DAY_MS)) || 1;
    let cur = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    while (cur <= t1) {
      if (cur >= t0) out.push({ v: cur, label: label(cur) });
      const nd = new Date(cur);
      cur = Date.UTC(nd.getUTCFullYear(), nd.getUTCMonth() + months, 1);
    }
  } else {
    let cur = Math.ceil(t0 / step) * step;
    while (cur <= t1) { out.push({ v: cur, label: label(cur) }); cur += step; }
  }
  return out;
}

/* ── 主渲染 ───────────────────────────────────────────── */
export function mount(canvas, cfg, tooltipEl) {
  const state = { cfg, hover: null, progress: 1, token: 0, tooltip: tooltipEl };
  canvas.__chart = state;
  registry.add(canvas);
  if (!canvas.__bound) {
    canvas.__bound = true;
    const onMove = (e) => {
      const s = canvas.__chart; if (!s) return;
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left;
      s.hover = x;
      render(canvas, tooltipEl);
    };
    const onLeave = () => {
      const s = canvas.__chart; if (!s) return;
      s.hover = null; render(canvas, tooltipEl);
    };
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseleave', onLeave);
    canvas.addEventListener('touchstart', (e) => { const t = e.touches[0]; if (t) onMove({ clientX: t.clientX }); }, { passive: true });
    canvas.addEventListener('touchmove', (e) => { const t = e.touches[0]; if (t) onMove({ clientX: t.clientX }); }, { passive: true });
    canvas.addEventListener('touchend', onLeave);
    if (window.ResizeObserver) {
      /* 觀察 canvas 本身而不是外框：canvas 是 width:100%、高度由我們指定，
         所以只有「容器寬度變了」才會觸發，不會因為自己改高度而無限迴圈。 */
      const ro = new ResizeObserver(() => render(canvas, tooltipEl));
      ro.observe(canvas);
    } else {
      window.addEventListener('resize', () => render(canvas, tooltipEl));
    }
  }
  if (cfg.animate === false) { state.progress = 1; render(canvas, tooltipEl); return; }
  /* 由左而右揭示的入場動畫：400ms，只影響內容，不影響座標軸 */
  const tok = ++state.token;
  const t0 = performance.now();
  state.progress = 0;
  const step = () => {
    if (state.token !== tok) return;
    const p = Math.min(1, (performance.now() - t0) / 420);
    state.progress = 1 - Math.pow(1 - p, 3);
    render(canvas, tooltipEl);
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

export function redrawAll() { registry.forEach(c => { const s = c.__chart; if (s) render(c, s.tooltip); }); }

function cssVar(el, name, fb) {
  const v = getComputedStyle(el.ownerDocument.documentElement).getPropertyValue(name).trim();
  return v || fb;
}

function render(canvas, tooltipEl) {
  const s = canvas.__chart; if (!s) return;
  const cfg = s.cfg;
  const host = canvas.parentElement || canvas;
  const rect = canvas.getBoundingClientRect();
  const W = Math.max(120, Math.round(rect.width) || host.clientWidth | 0);
  const H = Math.max(80, cfg.height || Math.round(rect.height) || 240);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const series = (cfg.series || []).filter(x => x && x.pts && x.pts.length);
  if (!series.length) return;

  const pad = Object.assign({ t: 14, r: 14, b: 24, l: 52 }, cfg.pad);
  const plotW = W - pad.l - pad.r, plotH = H - pad.t - pad.b;
  if (plotW < 20 || plotH < 20) return;

  /* x 範圍 */
  let x0 = Infinity, x1 = -Infinity;
  for (const sr of series) for (const p of sr.pts) { const v = p[0]; if (v < x0) x0 = v; if (v > x1) x1 = v; }
  if (x0 === x1) { x0 -= 1; x1 += 1; }
  const xpad = (x1 - x0) * (cfg.xPad == null ? 0.005 : cfg.xPad);
  const xa = x0 - xpad, xb = x1 + xpad;

  /* y 範圍 */
  let ymin = Infinity, ymax = -Infinity;
  const bounded = cfg.y && (cfg.y.min != null || cfg.y.max != null);
  for (const sr of series) {
    if (sr.axis === 'right' && !cfg.showRight) continue;
    for (const p of sr.pts) { const v = p[1]; if (!isFinite(v)) continue; if (v < ymin) ymin = v; if (v > ymax) ymax = v; }
  }
  if (cfg.y && cfg.y.min != null) ymin = Math.min(ymin, cfg.y.min);
  if (cfg.y && cfg.y.max != null) ymax = Math.max(ymax, cfg.y.max);
  if (!isFinite(ymin) || !isFinite(ymax)) { ymin = 0; ymax = 1; }
  if (cfg.y && cfg.y.zero) { ymin = Math.min(0, ymin); ymax = Math.max(0, ymax); }
  if (ymin === ymax) { ymin -= Math.abs(ymin || 1) * 0.05; ymax += Math.abs(ymax || 1) * 0.05; }
  /* 上下留白可以分開設定：價格圖不該往下擴到 0（軸上出現 0.00 會很怪），
     但上方留白要夠，不然最高點的標記會被切掉。 */
  const span0 = ymax - ymin;
  ymin -= span0 * (cfg.yPadBelow == null ? (cfg.yPad == null ? 0.08 : cfg.yPad) : cfg.yPadBelow);
  ymax += span0 * (cfg.yPadAbove == null ? (cfg.yPad == null ? 0.08 : cfg.yPad) : cfg.yPadAbove);

  const X = (v) => pad.l + ((v - xa) / (xb - xa)) * plotW;
  const Y = (v) => pad.t + plotH - ((v - ymin) / (ymax - ymin)) * plotH;

  /* ── 格線 ── */
  const yt = (cfg.y && cfg.y.ticks) || niceTicks(ymin, ymax, cfg.yTicks || 5);
  ctx.font = '10px "JetBrains Mono", ui-monospace, monospace';
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (const v of yt) {
    if (v < ymin || v > ymax) continue;
    const y = Math.round(Y(v)) + .5;
    ctx.strokeStyle = Math.abs(v) < 1e-12 ? PAL.gridHi : PAL.grid;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + plotW, y); ctx.stroke();
    ctx.fillStyle = PAL.textDim;
    ctx.fillText(cfg.y.format ? cfg.y.format(v) : String(v), pad.l - 7, y);
  }
  const xt = (cfg.x && cfg.x.ticks) || timeTicks(xa, xb, 7);
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (const t of xt) {
    const x = Math.round(X(t.v)) + .5;
    if (x < pad.l - 1 || x > pad.l + plotW + 1) continue;
    ctx.strokeStyle = PAL.grid;
    ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + plotH); ctx.stroke();
    ctx.fillStyle = PAL.textDim;
    ctx.fillText(t.label, x, pad.t + plotH + 6);
  }

  /* ── 水平參考線 ── */
  for (const ln of cfg.lines || []) {
    const y = Math.round(Y(ln.y)) + .5;
    if (y < pad.t - 1 || y > pad.t + plotH + 1) continue;
    ctx.save();
    ctx.setLineDash(ln.dash || [4, 4]);
    ctx.strokeStyle = ln.color || PAL.axis;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + plotW, y); ctx.stroke();
    ctx.restore();
    if (ln.label) {
      ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      ctx.fillStyle = ln.color || PAL.text;
      ctx.fillText(ln.label, pad.l + 4, y - 2);
    }
  }

  /* ── 內容（含揭示動畫裁切）── */
  const prog = s.progress == null ? 1 : s.progress;
  ctx.save();
  if (prog < 1) { ctx.beginPath(); ctx.rect(pad.l, 0, plotW * prog + 1, H); ctx.clip(); }

  for (const sr of series) {
    const pts = sr.pts;
    if (sr.type === 'bar' || sr.type === 'hist') {
      const bw = Math.max(1, (plotW / Math.max(1, pts.length)) * (sr.barWidth || 0.62));
      for (const p of pts) {
        const x = X(p[0]), y0 = Y(cfg.y && cfg.y.zero ? 0 : ymin), y1 = Y(p[1]);
        const h = y1 - y0;
        ctx.fillStyle = sr.color;
        ctx.globalAlpha = sr.alpha == null ? 1 : sr.alpha;
        const yy = h >= 0 ? y0 : y1, hh = Math.max(1, Math.abs(h));
        roundRect(ctx, x - bw / 2, yy, bw, hh, Math.min(2, bw / 2));
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      continue;
    }
    if (sr.type === 'dots') {
      for (const p of pts) {
        const x = X(p[0]), y = Y(p[1]);
        const r = sr.size ? (typeof sr.size === 'function' ? sr.size(p) : sr.size) : 3;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = sr.color; ctx.globalAlpha = sr.alpha == null ? .9 : sr.alpha; ctx.fill();
        if (sr.stroke) { ctx.globalAlpha = 1; ctx.lineWidth = 1.2; ctx.strokeStyle = sr.stroke; ctx.stroke(); }
        ctx.globalAlpha = 1;
      }
      continue;
    }
    /* line / area：一次 path 走完，資料多時比其他畫法快很多 */
    ctx.beginPath();
    let started = false;
    for (const p of pts) {
      const x = X(p[0]), y = Y(p[1]);
      if (!isFinite(y)) continue;
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    if (sr.type === 'area') {
      const last = pts[pts.length - 1], first = pts[0];
      ctx.save();
      ctx.lineTo(X(last[0]), Y(cfg.y && cfg.y.zero ? 0 : ymin));
      ctx.lineTo(X(first[0]), Y(cfg.y && cfg.y.zero ? 0 : ymin));
      ctx.closePath();
      const base = cfg.y && cfg.y.zero ? Y(0) : Y(ymin);
      const g = ctx.createLinearGradient(0, pad.t, 0, pad.t + plotH);
      const top = sr.fill || sr.color;
      g.addColorStop(0, hexA(top, sr.alpha == null ? .28 : sr.alpha));
      g.addColorStop(1, hexA(top, 0));
      ctx.fillStyle = g;
      ctx.fill();
      ctx.restore();
      /* 重畫上緣線 */
      ctx.beginPath(); started = false;
      for (const p of pts) { const x = X(p[0]), y = Y(p[1]); if (!isFinite(y)) continue; if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y); }
    }
    ctx.setLineDash(sr.dash || []);
    ctx.lineWidth = sr.width || 1.6;
    ctx.strokeStyle = sr.color;
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /* ── 標記點 ── */
  for (const m of cfg.marks || []) {
    const x = X(m.x), y = Y(m.y);
    if (m.kind === 'ring') {
      ctx.beginPath(); ctx.arc(x, y, m.r || 3, 0, Math.PI * 2);
      ctx.strokeStyle = m.color; ctx.lineWidth = 1.2; ctx.stroke();
    } else {
      ctx.beginPath(); ctx.arc(x, y, m.r || 2.5, 0, Math.PI * 2);
      ctx.fillStyle = m.color; ctx.fill();
    }
  }
  ctx.restore();

  /* ── hover 十字線與 tooltip ── */
  if (s.hover != null && cfg.tooltip && plotW > 0) {
    const hx = Math.max(pad.l, Math.min(pad.l + plotW, s.hover));
    let best = null;
    for (const sr of series) {
      if (sr.noHover) continue;
      let bd = Infinity, bp = null;
      for (const p of sr.pts) { const d = Math.abs(X(p[0]) - hx); if (d < bd) { bd = d; bp = p; } }
      if (bp && bd < 40) best = { sr, p: bp };
    }
    if (best) {
      const px = X(best.p[0]), py = Y(best.p[1]);
      ctx.save();
      ctx.strokeStyle = PAL.axis; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(Math.round(px) + .5, pad.t); ctx.lineTo(Math.round(px) + .5, pad.t + plotH); ctx.stroke();
      ctx.setLineDash([]);
      for (const sr of series) {
        if (sr.noHover || sr.type === 'bar') continue;
        let bd = Infinity, bp = null;
        for (const p of sr.pts) { const d = Math.abs(p[0] - best.p[0]); if (d < bd) { bd = d; bp = p; } }
        if (bp) {
          ctx.beginPath(); ctx.arc(X(bp[0]), Y(bp[1]), 3, 0, Math.PI * 2);
          ctx.fillStyle = sr.color; ctx.fill();
          ctx.strokeStyle = '#080d16'; ctx.lineWidth = 1.4; ctx.stroke();
        }
      }
      ctx.restore();
      if (tooltipEl) {
        const html = cfg.tooltip(best.p[0], best.p[1]);
        if (html) {
          tooltipEl.innerHTML = html;
          tooltipEl.style.opacity = '1';
          const tw = tooltipEl.offsetWidth, hostW = plotW + pad.l + pad.r;
          const left = Math.max(4, Math.min(hostW - tw - 4, px + 14));
          tooltipEl.style.left = left + 'px';
          tooltipEl.style.top = Math.max(4, Math.min(H - tooltipEl.offsetHeight - 4, py - tooltipEl.offsetHeight - 12)) + 'px';
        } else tooltipEl.style.opacity = '0';
      }
    } else if (tooltipEl) tooltipEl.style.opacity = '0';
  } else if (tooltipEl) tooltipEl.style.opacity = '0';
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/* #rrggbb / rgb() / var 已解析色 → rgba() */
function hexA(c, a) {
  if (!c) return `rgba(255,255,255,${a})`;
  if (c[0] === '#') {
    const h = c.length === 4 ? c.slice(1).split('').map(x => x + x).join('') : c.slice(1);
    const n = parseInt(h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  if (c.startsWith('rgb(')) return c.replace('rgb(', 'rgba(').replace(')', `,${a})`);
  return c;
}

/* CSS 變數顏色（給 app.js 取用） */
export function colors(el) {
  return {
    up: cssVar(el, '--up', '#0ecb81'),
    down: cssVar(el, '--down', '#f6465d'),
    cy: cssVar(el, '--cy', '#5b8dff'),
    mg: cssVar(el, '--mg', '#a78bfa'),
    am: cssVar(el, '--am', '#f0b90b'),
    tx: cssVar(el, '--tx-3', '#7d93ab')
  };
}
