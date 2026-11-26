// SVG charts (line, horizontal bar, grouped bar) with legends, crosshair tooltips and theme-aware colours.
// Colours are read from CSS custom properties at draw time, so charts follow the site's light/dark theme.
import { h, s, clear, num } from './ui.js';

let ROOT = document.documentElement;
export const setColorRoot = (el) => { ROOT = el; };
export const color = (name) => getComputedStyle(ROOT).getPropertyValue(name).trim() || '#888';
export const modelColor = (key) => color(`--vd-m-${key}`);
export const slotColor = (i) => color(`--vd-c${(i % 8) + 1}`);

// ------------------------------------------------------------------ colour utilities
export function parseColor(c) {
  c = (c || '').trim();
  if (c.startsWith('#')) {
    let x = c.slice(1);
    if (x.length === 3) x = x.split('').map((ch) => ch + ch).join('');
    const n = parseInt(x.slice(0, 6), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (m) return m[1].split(/[ ,/]+/).slice(0, 3).map(Number);
  return [128, 128, 128];
}
const toRgb = (a) => `rgb(${a.map((v) => Math.round(Math.max(0, Math.min(255, v)))).join(',')})`;
export function mix(c1, c2, t) {
  const a = parseColor(c1), b = parseColor(c2);
  return toRgb(a.map((v, i) => v + (b[i] - v) * t));
}
export function rampRgb(stops, t) {
  const n = stops.length - 1;
  const x = Math.max(0, Math.min(1, t)) * n;
  const i = Math.min(n - 1, Math.floor(x));
  const f = x - i;
  return stops[i].map((v, j) => v + (stops[i + 1][j] - v) * f);
}
export const seqStops = () => [0, 1, 2, 3, 4, 5, 6].map((i) => parseColor(color(`--vd-seq-${i}`)));
export const divStops = () => [parseColor(color('--vd-div-neg')), parseColor(color('--vd-div-mid')), parseColor(color('--vd-div-pos'))];
/** t in [-1, 1] -> diverging colour (negative pole, neutral midpoint, positive pole). */
export function divergingColor(t, stops = divStops()) {
  return toRgb(rampRgb(stops, (Math.max(-1, Math.min(1, t)) + 1) / 2));
}
export { toRgb };

// ------------------------------------------------------------------ registry (resize + theme)
const LIVE = new Set();
function mount(container, draw) {
  container._vdDraw = draw;
  container.classList.add('vd-chart');
  if (!container._vdRO && 'ResizeObserver' in window) {
    let lastW = container.clientWidth;
    container._vdRO = new ResizeObserver(() => {
      const w = container.clientWidth;
      if (w > 0 && Math.abs(w - lastW) > 2) { lastW = w; container._vdDraw(); }
    });
    container._vdRO.observe(container);
  }
  LIVE.add(container);
  draw();
}
export function redrawAll() {
  for (const c of LIVE) {
    if (!c.isConnected) { LIVE.delete(c); continue; }
    if (c.clientWidth > 0) c._vdDraw();
  }
}

// ------------------------------------------------------------------ scales and ticks
function niceStep(span, count) {
  const raw = span / Math.max(1, count);
  const p = 10 ** Math.floor(Math.log10(raw));
  const r = raw / p;
  return (r >= 7.5 ? 10 : r >= 3.5 ? 5 : r >= 1.5 ? 2 : 1) * p;
}
export function niceTicks(lo, hi, count = 5) {
  if (!(hi > lo)) return [lo];
  const st = niceStep(hi - lo, count);
  const out = [];
  for (let v = Math.ceil(lo / st - 1e-9) * st; v <= hi + st * 1e-9; v += st) out.push(Math.abs(v) < st * 1e-9 ? 0 : v);
  return out;
}
function logTicks(lo, hi) {
  const out = [];
  for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) {
    for (const m of [1, 2, 5]) { const v = m * 10 ** e; if (v >= lo * 0.999 && v <= hi * 1.001) out.push(v); }
  }
  return out;
}
function makeScale(type, d0, d1, r0, r1) {
  const f = type === 'sqrt' ? Math.sqrt : type === 'log' ? Math.log : (v) => v;
  const inv = type === 'sqrt' ? (v) => v * v : type === 'log' ? Math.exp : (v) => v;
  const a = f(d0), b = f(d1);
  const sc = (v) => r0 + (f(v) - a) / (b - a || 1) * (r1 - r0);
  sc.invert = (p) => inv(a + (p - r0) / (r1 - r0) * (b - a));
  return sc;
}
function timeTicks(lo, hi) {
  const y0 = new Date(lo).getUTCFullYear(), y1 = new Date(hi).getUTCFullYear();
  const span = y1 - y0 + 1;
  const step = span > 24 ? 5 : span > 12 ? 4 : span > 6 ? 2 : 1;
  const out = [];
  for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) {
    const t = Date.UTC(y, 0, 1);
    if (t >= lo && t <= hi) out.push({ v: t, label: String(y) });
  }
  return out;
}

function tooltipBox(wrap) {
  let tip = wrap.querySelector('.vd-tip');
  if (!tip) { tip = h('div', { class: 'vd-tip', role: 'status', 'aria-live': 'polite' }); wrap.append(tip); }
  return tip;
}
function placeTip(tip, wrap, px, py) {
  tip.style.display = 'block';
  const tw = tip.offsetWidth, th = tip.offsetHeight, W = wrap.clientWidth;
  let left = px + 14;
  if (left + tw > W - 4) left = px - tw - 14;
  tip.style.left = Math.max(4, left) + 'px';
  tip.style.top = Math.max(0, py - th / 2) + 'px';
}

function legend(container, items, onToggle) {
  const lg = h('div', { class: 'vd-legend' });
  for (const it of items) {
    const btn = h('button', { type: 'button', class: 'vd-legend-item' + (it.hidden ? ' off' : ''), 'aria-pressed': String(!it.hidden),
      title: onToggle ? 'Show / hide' : null, disabled: onToggle ? null : true },
    h('span', { class: 'vd-swatch' + (it.shape ? ' ' + it.shape : ''), style: { background: it.shape === 'line' ? 'none' : it.color, borderColor: it.color } }),
    it.name);
    if (onToggle) btn.addEventListener('click', () => onToggle(it.key));
    lg.append(btn);
  }
  container.append(lg);
}

// ------------------------------------------------------------------ line chart
/**
 * opts: {height, x:{label, type:'linear'|'sqrt'|'log'|'time', min, max, ticks:[{v,label}], fmt, gap},
 *        y:{label, min, max, fmt, log, zero}, series:[{key, name, color, width, dash, points:[[x,y]], hidden, opacity}],
 *        markers:[{key, name, color, points:[[x,y,label]]}], bands:[{x0,x1,label}], vlines:[{x,label,dash,strong}],
 *        hlines:[{y,label,strong}], tipX:(x)=>string, aria}
 */
export function lineChart(container, opts) {
  container._vdOpts = opts;
  opts._hidden = opts._hidden || new Set(opts.series.filter((x) => x.hidden).map((x) => x.key));
  mount(container, () => drawLine(container));
}

function drawLine(container) {
  const o = container._vdOpts;
  clear(container);
  const W = Math.max(container.clientWidth || 300, 260), H = o.height || 260;
  const narrow = W < 420;
  const m = { l: o.marginLeft ?? (narrow ? 44 : 54), r: 14, t: 14, b: o.x.label ? 40 : 26 };
  const ink = color('--ink'), muted = color('--muted'), rule = color('--rule'), ruleStrong = color('--rule-strong'),
    surface = color('--surface');
  const vis = o.series.filter((sr) => !o._hidden.has(sr.key));
  const visM = (o.markers || []).filter((mk) => !o._hidden.has(mk.key));
  const xs = [], ys = [];
  for (const sr of vis) for (const p of sr.points) if (Number.isFinite(p[1]) && Number.isFinite(p[0])) { xs.push(p[0]); ys.push(p[1]); }
  for (const mk of visM) for (const p of mk.points) if (Number.isFinite(p[1])) { xs.push(p[0]); ys.push(p[1]); }
  for (const sr of o.series) for (const p of sr.points) if (Number.isFinite(p[0])) xs.push(p[0]);
  let x0 = o.x.min ?? Math.min(...xs), x1 = o.x.max ?? Math.max(...xs);
  if (!(x1 > x0)) { x0 -= 1; x1 += 1; }
  const ylog = !!o.y.log;
  const yv = ylog ? ys.filter((v) => v > 0) : ys;
  let y0 = o.y.min ?? (yv.length ? Math.min(...yv) : 0), y1 = o.y.max ?? (yv.length ? Math.max(...yv) : 1);
  if (o.y.zero && !ylog) { y0 = Math.min(y0, 0); y1 = Math.max(y1, 0); }
  for (const hl of o.hlines || []) if (Number.isFinite(hl.y) && hl.inDomain !== false) { y0 = Math.min(y0, hl.y); y1 = Math.max(y1, hl.y); }
  if (!(y1 > y0)) { const d = Math.abs(y0) * 0.1 || 1; y0 -= d; y1 += d; }
  if (ylog) { y0 /= 1.15; y1 *= 1.15; } else if (o.y.min == null || o.y.max == null) {
    const pad = (y1 - y0) * 0.07;
    if (o.y.min == null) y0 -= pad;
    if (o.y.max == null) y1 += pad;
  }
  const X = makeScale(o.x.type === 'time' ? 'linear' : o.x.type || 'linear', x0, x1, m.l, W - m.r);
  const Y = makeScale(ylog ? 'log' : 'linear', y0, y1, H - m.b, m.t);
  const fx = o.x.fmt || ((v) => num(v, 2));
  const fy = o.y.fmt || ((v) => num(v, 2));

  const svg = s('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': o.aria || '' });
  // y grid + labels
  const yt = ylog ? logTicks(y0, y1) : niceTicks(y0, y1, narrow ? 4 : 5);
  for (const v of yt) {
    const py = Y(v);
    svg.append(s('line', { x1: m.l, x2: W - m.r, y1: py, y2: py, stroke: rule, 'stroke-width': 1 }));
    svg.append(s('text', { x: m.l - 6, y: py + 3.5, 'text-anchor': 'end', fill: muted, class: 'vd-tick' }, fy(v)));
  }
  // x ticks
  let xt;
  if (o.x.ticks) xt = o.x.ticks.filter((t) => t.v >= x0 && t.v <= x1);
  else if (o.x.type === 'time') xt = timeTicks(x0, x1);
  else xt = niceTicks(x0, x1, narrow ? 4 : 7).map((v) => ({ v, label: fx(v) }));
  let lastPx = -1e9;
  for (const t of xt) {
    const px = X(t.v);
    if (px - lastPx < (narrow ? 34 : 44)) continue;
    lastPx = px;
    svg.append(s('line', { x1: px, x2: px, y1: H - m.b, y2: H - m.b + 4, stroke: ruleStrong }));
    svg.append(s('text', { x: px, y: H - m.b + 15, 'text-anchor': 'middle', fill: muted, class: 'vd-tick' }, t.label));
  }
  svg.append(s('line', { x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b, stroke: ruleStrong }));
  if (o.x.label) svg.append(s('text', { x: (m.l + W - m.r) / 2, y: H - 6, 'text-anchor': 'middle', fill: muted, class: 'vd-axlabel' }, o.x.label));
  if (o.y.label) svg.append(s('text', { x: 12, y: (m.t + H - m.b) / 2, transform: `rotate(-90 12 ${(m.t + H - m.b) / 2})`, 'text-anchor': 'middle', fill: muted, class: 'vd-axlabel' }, o.y.label));
  const clipId = 'clip' + Math.random().toString(36).slice(2, 8);
  svg.append(s('defs', null, s('clipPath', { id: clipId }, s('rect', { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b }))));
  const plot = s('g', { 'clip-path': `url(#${clipId})` });
  svg.append(plot);
  for (const b of o.bands || []) {
    const a = X(Math.max(b.x0, x0)), c = X(Math.min(b.x1, x1));
    if (c > a) {
      plot.append(s('rect', { x: a, y: m.t, width: c - a, height: H - m.t - m.b, fill: color('--accent-soft'), opacity: b.opacity ?? 0.55 }));
      if (b.label) svg.append(s('text', { x: a + 4, y: m.t + 11, fill: muted, class: 'vd-tick' }, b.label));
    }
  }
  for (const hl of o.hlines || []) {
    if (!(hl.y >= y0 && hl.y <= y1)) continue;
    plot.append(s('line', { x1: m.l, x2: W - m.r, y1: Y(hl.y), y2: Y(hl.y), stroke: hl.strong ? muted : ruleStrong, 'stroke-width': 1, 'stroke-dasharray': hl.dash || null }));
  }
  for (const vl of o.vlines || []) {
    if (!(vl.x >= x0 && vl.x <= x1)) continue;
    const px = X(vl.x);
    plot.append(s('line', { x1: px, x2: px, y1: m.t, y2: H - m.b, stroke: vl.strong ? muted : ruleStrong, 'stroke-width': 1, 'stroke-dasharray': vl.dash ?? '3 3' }));
    if (vl.label) svg.append(s('text', { x: px + 3, y: m.t + 10 + (vl.row || 0) * 11, fill: muted, class: 'vd-tick' }, vl.label));
  }
  for (const sr of vis) {
    let d = '', pen = false, lastX = null;
    for (const [px, py] of sr.points) {
      const ok = Number.isFinite(py) && Number.isFinite(px) && (!ylog || py > 0);
      if (ok && o.x.gap && lastX != null && px - lastX > o.x.gap) pen = false;
      if (!ok) { pen = false; continue; }
      d += (pen ? 'L' : 'M') + X(px).toFixed(1) + ',' + Y(py).toFixed(1);
      pen = true;
      lastX = px;
    }
    plot.append(s('path', { d, fill: 'none', stroke: sr.color, 'stroke-width': sr.width || 2, 'stroke-dasharray': sr.dash || null,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round', opacity: sr.opacity ?? 1 }));
  }
  for (const mk of visM) {
    for (const p of mk.points) {
      if (!Number.isFinite(p[1])) continue;
      plot.append(s('circle', { cx: X(p[0]), cy: Y(p[1]), r: mk.r || 4, fill: mk.hollow ? surface : mk.color, stroke: mk.hollow ? mk.color : surface, 'stroke-width': 2 }));
    }
  }
  const items = [...o.series.filter((x) => x.name && !x.noLegend).map((x) => ({ key: x.key, name: x.name, color: x.color, hidden: o._hidden.has(x.key) })),
    ...(o.markers || []).filter((x) => x.name).map((x) => ({ key: x.key, name: x.name, color: x.color, hidden: o._hidden.has(x.key), shape: 'dot' }))];
  if (items.length > 1 || o.forceLegend) legend(container, items, o.toggle === false ? null : (key) => {
    if (o._hidden.has(key)) o._hidden.delete(key); else o._hidden.add(key);
    drawLine(container);
  });
  const wrap = h('div', { class: 'vd-plot' });
  wrap.append(svg);
  container.append(wrap);
  if (o.caption) container.append(h('p', { class: 'vd-caption' }, o.caption));

  // crosshair + tooltip
  const cross = s('line', { y1: m.t, y2: H - m.b, stroke: muted, 'stroke-width': 1, visibility: 'hidden' });
  const dots = s('g');
  svg.append(cross, dots);
  const tip = tooltipBox(wrap);
  const overlay = s('rect', { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, fill: 'transparent', style: 'touch-action: pan-y' });
  svg.append(overlay);
  const tipX = o.tipX || fx;
  const move = (ev) => {
    const r = svg.getBoundingClientRect();
    const px = Math.max(m.l, Math.min(W - m.r, ev.clientX - r.left));
    const xv = X.invert(px);
    clear(dots);
    const rows = [];
    for (const sr of vis) {
      const yv2 = interpAt(sr.points, xv);
      if (!Number.isFinite(yv2)) continue;
      dots.append(s('circle', { cx: px, cy: Y(yv2), r: 4, fill: sr.color, stroke: surface, 'stroke-width': 2 }));
      rows.push(h('div', { class: 'vd-tip-row' }, h('span', { class: 'vd-swatch', style: { background: sr.color, borderColor: sr.color } }),
        h('span', null, sr.name || ''), h('b', null, fy(yv2, true))));
    }
    for (const mk of visM) {
      for (const p of mk.points) {
        if (Number.isFinite(p[1]) && Math.abs(X(p[0]) - px) < 7) rows.push(h('div', { class: 'vd-tip-row' },
          h('span', { class: 'vd-swatch dot', style: { background: mk.color, borderColor: mk.color } }), h('span', null, p[2] || mk.name), h('b', null, fy(p[1], true))));
      }
    }
    cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('visibility', 'visible');
    clear(tip).append(h('div', { class: 'vd-tip-head' }, tipX(xv)), ...rows);
    placeTip(tip, wrap, px, ev.clientY - r.top);
  };
  overlay.addEventListener('pointermove', move);
  overlay.addEventListener('pointerdown', move);
  overlay.addEventListener('pointerleave', () => { tip.style.display = 'none'; cross.setAttribute('visibility', 'hidden'); clear(dots); });
}

function interpAt(pts, x) {
  const n = pts.length;
  if (!n) return NaN;
  if (x < pts[0][0] || x > pts[n - 1][0]) return NaN;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (pts[mid][0] <= x) lo = mid; else hi = mid; }
  const [xa, ya] = pts[lo], [xb, yb] = pts[hi];
  if (!Number.isFinite(ya) || !Number.isFinite(yb)) return Math.abs(x - xa) < Math.abs(x - xb) ? ya : yb;
  return xb === xa ? ya : ya + (yb - ya) * (x - xa) / (xb - xa);
}

// ------------------------------------------------------------------ horizontal bars (signed values)
export function barChart(container, opts) {
  container._vdOpts = opts;
  mount(container, () => drawBars(container));
}
function drawBars(container) {
  const o = container._vdOpts;
  clear(container);
  const W = Math.max(container.clientWidth || 300, 260);
  const rowH = 26, labW = Math.min(120, W * 0.32), m = { l: labW, r: 64, t: 6, b: 22 };
  const H = m.t + m.b + rowH * o.items.length;
  const vals = o.items.map((it) => it.value).filter(Number.isFinite);
  const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
  const span = hi - lo || 1;
  const X = (v) => m.l + (v - lo) / span * (W - m.l - m.r);
  const muted = color('--muted'), ink = color('--ink-2'), rule = color('--rule-strong');
  const pos = color('--vd-div-pos'), neg = color('--vd-div-neg');
  const svg = s('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': o.aria || '' });
  const wrap = h('div', { class: 'vd-plot' });
  const tip = tooltipBox(wrap);
  o.items.forEach((it, i) => {
    const y = m.t + i * rowH;
    svg.append(s('text', { x: m.l - 8, y: y + rowH / 2 + 4, 'text-anchor': 'end', fill: ink, class: 'vd-barlabel' }, it.label));
    if (!Number.isFinite(it.value)) return;
    const a = X(Math.min(0, it.value)), b = X(Math.max(0, it.value));
    const bar = s('rect', { x: a, y: y + 5, width: Math.max(1, b - a), height: rowH - 10, rx: 3, fill: it.value >= 0 ? pos : neg });
    bar.addEventListener('pointermove', (ev) => {
      const r = svg.getBoundingClientRect();
      clear(tip).append(h('div', { class: 'vd-tip-head' }, it.label), h('div', { class: 'vd-tip-row' }, h('b', null, (o.fmt || num)(it.value))));
      placeTip(tip, wrap, ev.clientX - r.left, ev.clientY - r.top);
    });
    bar.addEventListener('pointerleave', () => { tip.style.display = 'none'; });
    svg.append(bar);
    const tx = it.value >= 0 ? b + 5 : a - 5;
    svg.append(s('text', { x: tx, y: y + rowH / 2 + 4, 'text-anchor': it.value >= 0 ? 'start' : 'end', fill: muted, class: 'vd-tick' }, (o.fmt || num)(it.value)));
  });
  svg.append(s('line', { x1: X(0), x2: X(0), y1: m.t, y2: H - m.b + 4, stroke: rule }));
  wrap.prepend(svg);
  container.append(wrap);
  if (o.caption) container.append(h('p', { class: 'vd-caption' }, o.caption));
}

// ------------------------------------------------------------------ grouped vertical bars
export function groupedBars(container, opts) {
  container._vdOpts = opts;
  mount(container, () => drawGrouped(container));
}
function drawGrouped(container) {
  const o = container._vdOpts;
  clear(container);
  const W = Math.max(container.clientWidth || 300, 260), H = o.height || 240;
  const m = { l: 46, r: 10, t: 12, b: 30 };
  const all = o.series.flatMap((sr) => sr.values).filter(Number.isFinite);
  const y1 = Math.max(...all, 0) * 1.08 || 1;
  const Y = (v) => H - m.b - v / y1 * (H - m.t - m.b);
  const muted = color('--muted'), rule = color('--rule'), surface = color('--surface');
  const svg = s('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': o.aria || '' });
  for (const v of niceTicks(0, y1, 4)) {
    svg.append(s('line', { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), stroke: rule }));
    svg.append(s('text', { x: m.l - 6, y: Y(v) + 3.5, 'text-anchor': 'end', fill: muted, class: 'vd-tick' }, (o.fmt || num)(v)));
  }
  if (o.yLabel) svg.append(s('text', { x: 11, y: (m.t + H - m.b) / 2, transform: `rotate(-90 11 ${(m.t + H - m.b) / 2})`, 'text-anchor': 'middle', fill: muted, class: 'vd-axlabel' }, o.yLabel));
  const gw = (W - m.l - m.r) / o.groups.length;
  const ns = o.series.length;
  const bw = Math.max(3, Math.min(22, (gw * 0.8 - (ns - 1) * 2) / ns));
  const wrap = h('div', { class: 'vd-plot' });
  const tip = tooltipBox(wrap);
  o.groups.forEach((g, gi) => {
    const cx = m.l + gw * (gi + 0.5);
    svg.append(s('text', { x: cx, y: H - m.b + 16, 'text-anchor': 'middle', fill: muted, class: 'vd-tick' }, g));
    const start = cx - (ns * bw + (ns - 1) * 2) / 2;
    o.series.forEach((sr, si) => {
      const v = sr.values[gi];
      if (!Number.isFinite(v)) return;
      const x = start + si * (bw + 2);
      const r = s('rect', { x, y: Y(v), width: bw, height: Math.max(1, Y(0) - Y(v)), rx: 2, fill: sr.color, stroke: surface, 'stroke-width': 0.5 });
      r.addEventListener('pointermove', (ev) => {
        const b = svg.getBoundingClientRect();
        clear(tip).append(h('div', { class: 'vd-tip-head' }, g), h('div', { class: 'vd-tip-row' },
          h('span', { class: 'vd-swatch', style: { background: sr.color, borderColor: sr.color } }), h('span', null, sr.name), h('b', null, (o.fmt || num)(v))));
        placeTip(tip, wrap, ev.clientX - b.left, ev.clientY - b.top);
      });
      r.addEventListener('pointerleave', () => { tip.style.display = 'none'; });
      svg.append(r);
    });
  });
  svg.append(s('line', { x1: m.l, x2: W - m.r, y1: Y(0), y2: Y(0), stroke: color('--rule-strong') }));
  legend(container, o.series.map((sr) => ({ key: sr.name, name: sr.name, color: sr.color })), null);
  wrap.prepend(svg);
  container.append(wrap);
  if (o.caption) container.append(h('p', { class: 'vd-caption' }, o.caption));
}
