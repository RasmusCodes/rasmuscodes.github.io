// Small SVG charts themed by CSS variables (text and axes use currentColor).

const NS = 'http://www.w3.org/2000/svg';
export const el = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
};
const text = (parent, x, y, s, attrs = {}) => { const t = el('text', { x, y, ...attrs }, parent); t.textContent = s; return t; };

export const fmtPct = (x, d = 1) => (x === null || x === undefined || Number.isNaN(x) ? '–' : `${(100 * x).toFixed(d)}%`);
export const fmtNum = (x, d = 2) => (x === null || x === undefined || Number.isNaN(x) ? '–' : Number(x).toFixed(d));

function niceTicks(lo, hi, n = 5) {
  if (hi <= lo) hi = lo + 1;
  const step0 = (hi - lo) / n, mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) || mag * 10;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}
function logTicks(lo, hi) {
  const out = [];
  for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) out.push(Math.pow(10, e));
  return out.filter((v) => v >= lo / 1.0001 && v <= hi * 1.0001);
}

/** Line chart. series: [{ name, points: [[x, y]], color, dash }]. */
export function lineChart(container, series, opts = {}) {
  container.innerHTML = '';
  const W = opts.width || 560, H = opts.height || 260, m = { l: 56, r: 16, t: 14, b: 40 };
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': opts.label || 'chart' }, container);
  const pts = series.flatMap((s) => s.points).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]) && (!opts.logY || p[1] > 0) && (!opts.logX || p[0] > 0));
  if (!pts.length) { text(svg, W / 2, H / 2, 'No data yet', { 'text-anchor': 'middle', class: 'chart-muted' }); return svg; }
  let [x0, x1] = [Math.min(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[0]))];
  let [y0, y1] = [Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[1]))];
  if (opts.yMin !== undefined) y0 = opts.yMin;
  if (opts.yMax !== undefined) y1 = opts.yMax;
  if (x1 === x0) x1 = x0 + 1;
  if (y1 === y0) { y1 = y0 * 1.1 + 1e-9; y0 = opts.logY ? y0 / 1.1 : y0 * 0.9; }
  const fx = opts.logX ? (x) => Math.log10(x) : (x) => x, fy = opts.logY ? (y) => Math.log10(y) : (y) => y;
  const sx = (x) => m.l + ((fx(x) - fx(x0)) / (fx(x1) - fx(x0))) * (W - m.l - m.r);
  const sy = (y) => H - m.b - ((fy(y) - fy(y0)) / (fy(y1) - fy(y0))) * (H - m.t - m.b);
  const g = el('g', { class: 'chart-axis' }, svg);
  for (const t of opts.logY ? logTicks(y0, y1) : niceTicks(y0, y1)) {
    el('line', { x1: m.l, x2: W - m.r, y1: sy(t), y2: sy(t), class: 'chart-grid' }, g);
    text(g, m.l - 6, sy(t) + 4, (opts.yFormat || ((v) => String(v)))(t), { 'text-anchor': 'end' });
  }
  for (const t of opts.logX ? logTicks(x0, x1) : niceTicks(x0, x1, 6)) {
    text(g, sx(t), H - m.b + 16, (opts.xFormat || ((v) => String(v)))(t), { 'text-anchor': 'middle' });
  }
  if (opts.xLabel) text(g, (m.l + W - m.r) / 2, H - 6, opts.xLabel, { 'text-anchor': 'middle', class: 'chart-label' });
  if (opts.yLabel) text(g, 12, (m.t + H - m.b) / 2, opts.yLabel, { 'text-anchor': 'middle', class: 'chart-label', transform: `rotate(-90 12 ${(m.t + H - m.b) / 2})` });
  el('line', { x1: m.l, x2: m.l, y1: m.t, y2: H - m.b, class: 'chart-frame' }, g);
  el('line', { x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b, class: 'chart-frame' }, g);
  for (const s of series) {
    const ps = s.points.filter((p) => Number.isFinite(p[1]) && (!opts.logY || p[1] > 0) && (!opts.logX || p[0] > 0));
    if (!ps.length) continue;
    el('path', { d: ps.map((p, i) => `${i ? 'L' : 'M'}${sx(p[0]).toFixed(1)},${sy(Math.min(Math.max(p[1], y0), y1)).toFixed(1)}`).join(''), fill: 'none', stroke: s.color || 'var(--series-1)', 'stroke-width': 2, 'stroke-dasharray': s.dash || '' }, svg);
    if (opts.dots !== false && ps.length < 40) for (const p of ps) el('circle', { cx: sx(p[0]), cy: sy(Math.min(Math.max(p[1], y0), y1)), r: 2.6, fill: s.color || 'var(--series-1)' }, svg);
  }
  if (series.length > 1 || opts.legend) {
    const lg = el('g', { class: 'chart-legend' }, svg);
    let x = m.l + 8;
    for (const s of series) {
      el('rect', { x, y: m.t, width: 10, height: 10, rx: 2, fill: s.color || 'var(--series-1)' }, lg);
      const t = text(lg, x + 14, m.t + 9, s.name);
      x += 24 + Math.max(40, s.name.length * 6.4);
    }
  }
  return svg;
}

/** Horizontal bars. bars: [{ label, value, color, lo, hi, note }]. */
export function barChart(container, bars, opts = {}) {
  container.innerHTML = '';
  const W = opts.width || 560, row = opts.row || 30, m = { l: opts.labelWidth || 130, r: 70, t: 8, b: 8 };
  const H = m.t + m.b + bars.length * row;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': opts.label || 'bars' }, container);
  const vmin = Math.min(0, ...bars.map((b) => b.lo ?? b.value)), vmax = Math.max(opts.max ?? 0, ...bars.map((b) => b.hi ?? b.value));
  const span = vmax - vmin || 1;
  const sx = (v) => m.l + ((v - vmin) / span) * (W - m.l - m.r);
  bars.forEach((b, i) => {
    const y = m.t + i * row;
    text(svg, m.l - 8, y + row / 2 + 4, b.label, { 'text-anchor': 'end', class: 'chart-text' });
    const x0 = sx(Math.min(0, b.value)), x1 = sx(Math.max(0, b.value));
    el('rect', { x: x0, y: y + 5, width: Math.max(x1 - x0, 1), height: row - 10, rx: 3, fill: b.color || 'var(--series-1)' }, svg);
    if (b.lo !== undefined && b.hi !== undefined) el('line', { x1: sx(b.lo), x2: sx(b.hi), y1: y + row / 2, y2: y + row / 2, class: 'chart-error' }, svg);
    text(svg, Math.max(x1, sx(b.hi ?? b.value)) + 6, y + row / 2 + 4, b.note ?? (opts.format || fmtNum)(b.value), { class: 'chart-text' });
  });
  if (vmin < 0) el('line', { x1: sx(0), x2: sx(0), y1: m.t, y2: H - m.b, class: 'chart-frame' }, svg);
  return svg;
}

/** Credible intervals on [0, 1]: rows [{ label, lo, hi, mean, prior, truth }]. */
export function intervalChart(container, rows, opts = {}) {
  container.innerHTML = '';
  const W = opts.width || 600, row = 26, m = { l: 170, r: 20, t: 22, b: 10 };
  const H = m.t + m.b + rows.length * row;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': 'credible intervals' }, container);
  const sx = (v) => m.l + v * (W - m.l - m.r);
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    el('line', { x1: sx(t), x2: sx(t), y1: m.t - 4, y2: H - m.b, class: 'chart-grid' }, svg);
    text(svg, sx(t), m.t - 8, `${t * 100}%`, { 'text-anchor': 'middle', class: 'chart-axis-text' });
  }
  rows.forEach((r, i) => {
    const y = m.t + i * row + row / 2;
    text(svg, m.l - 8, y + 4, r.label, { 'text-anchor': 'end', class: 'chart-text' });
    if (r.prior !== undefined && r.prior !== null) el('line', { x1: sx(r.prior), x2: sx(r.prior), y1: y - 8, y2: y + 8, class: 'chart-prior' }, svg);
    el('line', { x1: sx(r.lo), x2: sx(r.hi), y1: y, y2: y, class: 'chart-interval' }, svg);
    el('circle', { cx: sx(r.mean), cy: y, r: 4, class: 'chart-mean' }, svg);
    if (r.truth !== undefined && r.truth !== null) el('path', { d: `M${sx(r.truth)},${y - 6}l4,6l-4,6l-4,-6z`, class: 'chart-truth' }, svg);
  });
  return svg;
}

/** A density curve with a shaded interval. */
export function densityChart(container, points, lo, hi, opts = {}) {
  container.innerHTML = '';
  const W = opts.width || 520, H = opts.height || 170, m = { l: 16, r: 16, t: 10, b: 26 };
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': 'posterior density' }, container);
  const ymax = Math.max(...points.map((p) => p[1])) || 1;
  const sx = (x) => m.l + x * (W - m.l - m.r), sy = (y) => H - m.b - (y / ymax) * (H - m.t - m.b);
  const inside = points.filter((p) => p[0] >= lo && p[0] <= hi);
  if (inside.length) el('path', { d: `M${sx(inside[0][0])},${sy(0)}` + inside.map((p) => `L${sx(p[0])},${sy(p[1])}`).join('') + `L${sx(inside[inside.length - 1][0])},${sy(0)}Z`, class: 'chart-area' }, svg);
  el('path', { d: points.map((p, i) => `${i ? 'L' : 'M'}${sx(p[0])},${sy(p[1])}`).join(''), fill: 'none', stroke: 'var(--series-1)', 'stroke-width': 2 }, svg);
  for (const t of [0, 0.25, 0.5, 0.75, 1]) text(svg, sx(t), H - 8, `${t * 100}%`, { 'text-anchor': 'middle', class: 'chart-axis-text' });
  if (opts.prior !== undefined) el('line', { x1: sx(opts.prior), x2: sx(opts.prior), y1: m.t, y2: H - m.b, class: 'chart-prior' }, svg);
  return svg;
}
