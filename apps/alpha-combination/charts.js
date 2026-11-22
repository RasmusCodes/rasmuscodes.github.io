// Small SVG charts for the lab: line (crosshair tooltip), dot-and-interval, horizontal bars, heatmap, columns.
// Colors come from CSS custom properties on .acl (light and dark steps of one validated palette); text uses ink
// tokens, never series colors. Every chart re-renders on resize.

const NS = "http://www.w3.org/2000/svg";
export const SERIES = ["--acl-s1", "--acl-s2", "--acl-s3", "--acl-s4", "--acl-s5", "--acl-s6", "--acl-s7", "--acl-s8"];
export const seriesColor = (i) => `var(${SERIES[i % SERIES.length]})`;

function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "style") Object.assign(e.style, v); else if (k === "text") e.textContent = v; else e.setAttribute(k, v);
  }
  if (parent) parent.appendChild(e);
  return e;
}

function niceTicks(lo, hi, n = 5) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0];
  if (lo === hi) { lo -= 1; hi += 1; }
  const span = hi - lo, step0 = span / n, mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n) ?? 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-12; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

function frame(host, height) {
  host.classList.add("acl-chart");
  host.replaceChildren();
  const w = Math.max(280, host.clientWidth || 600);
  const svg = el("svg", { width: w, height, viewBox: `0 0 ${w} ${height}`, role: "img" }, host);
  const tip = document.createElement("div");
  tip.className = "acl-tip";
  tip.hidden = true;
  host.appendChild(tip);
  return { svg, tip, w };
}

function showTip(tip, host, x, y, rows, title) {
  tip.replaceChildren();
  if (title) { const h = document.createElement("div"); h.className = "acl-tip__title"; h.textContent = title; tip.appendChild(h); }
  for (const r of rows) {
    const row = document.createElement("div"); row.className = "acl-tip__row";
    if (r.color) { const k = document.createElement("span"); k.className = "acl-tip__key"; k.style.background = r.color; row.appendChild(k); }
    const v = document.createElement("b"); v.textContent = r.value; row.appendChild(v);
    const l = document.createElement("span"); l.textContent = r.label; row.appendChild(l);
    tip.appendChild(row);
  }
  tip.hidden = false;
  const hb = host.getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight;
  let left = x + 14, top = y - th / 2;
  if (left + tw > hb.width) left = x - tw - 14;
  top = Math.max(0, Math.min(top, hb.height - th));
  tip.style.left = `${Math.max(0, left)}px`;
  tip.style.top = `${top}px`;
}

function legend(host, items, kind = "line") {
  const lg = document.createElement("div");
  lg.className = "acl-legend";
  for (const it of items) {
    const s = document.createElement("span");
    const k = document.createElement("i");
    k.className = kind === "line" ? "acl-legend__line" : "acl-legend__box";
    k.style.background = it.color;
    s.appendChild(k);
    s.appendChild(document.createTextNode(it.name));
    lg.appendChild(s);
  }
  host.prepend(lg);
}

function observe(host, draw) {
  draw();
  if (host._aclRO) host._aclRO.disconnect();
  let last = host.clientWidth;
  host._aclRO = new ResizeObserver(() => { if (Math.abs(host.clientWidth - last) > 4) { last = host.clientWidth; draw(); } });
  host._aclRO.observe(host);
}

// ------------------------------------------------------------------ line chart
export function lineChart(host, opt) {
  observe(host, () => drawLine(host, opt));
}
function drawLine(host, { x, series, height = 260, yFormat = (v) => v.toFixed(2), xLabel = (v) => v, log = false,
                          zero = false, endLabels = true }) {
  // past four series, end labels collide: the legend and the crosshair tooltip carry identity instead
  endLabels = endLabels && series.filter((s) => !s.muted).length <= 4;
  const { svg, tip, w } = frame(host, height);
  const m = { l: 52, r: endLabels ? 92 : 16, t: 10, b: 26 };
  const vals = series.flatMap((s) => s.values.filter(Number.isFinite));
  let lo = Math.min(...vals, zero ? 0 : Infinity), hi = Math.max(...vals, zero ? 0 : -Infinity);
  const tr = log ? (v) => Math.log(v) : (v) => v;
  if (log) { lo = Math.max(lo, 1e-6); }
  const pad = (tr(hi) - tr(lo)) * 0.06 || 0.1;
  const y0 = tr(lo) - pad, y1 = tr(hi) + pad;
  const X = (i) => m.l + (w - m.l - m.r) * (x.length > 1 ? i / (x.length - 1) : 0.5);
  const Y = (v) => m.t + (height - m.t - m.b) * (1 - (tr(v) - y0) / (y1 - y0));
  const ticks = log ? niceTicks(lo, hi, 4).filter((v) => v > 0) : niceTicks(lo, hi, 5);
  for (const t of ticks) {
    const yy = Y(t);
    if (yy < m.t - 1 || yy > height - m.b + 1) continue;
    el("line", { x1: m.l, x2: w - m.r, y1: yy, y2: yy, class: t === 0 && !log ? "acl-axis" : "acl-grid" }, svg);
    el("text", { x: m.l - 6, y: yy + 3.5, "text-anchor": "end", class: "acl-tick", text: yFormat(t) }, svg);
  }
  const nx = Math.min(6, x.length);
  for (let j = 0; j < nx; j++) {
    const i = Math.round(j * (x.length - 1) / Math.max(nx - 1, 1));
    el("text", { x: X(i), y: height - 8, "text-anchor": "middle", class: "acl-tick", text: String(xLabel(x[i])) }, svg);
  }
  series.forEach((s) => {
    let d = "";
    s.values.forEach((v, i) => { if (Number.isFinite(v) && (!log || v > 0)) d += `${d && Number.isFinite(s.values[i - 1]) ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`; });
    el("path", { d, fill: "none", style: { stroke: s.color, strokeWidth: s.width ?? 2, strokeLinejoin: "round", strokeLinecap: "round", opacity: s.muted ? 0.45 : 1 } }, svg);
  });
  if (endLabels) {
    const ends = series.filter((s) => !s.muted).map((s) => {
      let i = s.values.length - 1; while (i > 0 && !Number.isFinite(s.values[i])) i--;
      return { s, y: Y(s.values[i]), v: s.values[i] };
    }).sort((a, b) => a.y - b.y);
    for (let k = 1; k < ends.length; k++) if (ends[k].y - ends[k - 1].y < 12) ends[k].y = ends[k - 1].y + 12;
    for (const e of ends) el("text", { x: w - m.r + 6, y: e.y + 3.5, class: "acl-endlabel", text: `${e.s.name} ${yFormat(e.v)}` }, svg);
  }
  if (series.length > 1) legend(host, series.filter((s) => !s.hideLegend).map((s) => ({ name: s.name, color: s.color })));
  const cross = el("line", { y1: m.t, y2: height - m.b, class: "acl-cross", visibility: "hidden" }, svg);
  const hit = el("rect", { x: m.l, y: m.t, width: Math.max(1, w - m.l - m.r), height: height - m.t - m.b, fill: "transparent" }, svg);
  const move = (ev) => {
    const r = svg.getBoundingClientRect(), px = ev.clientX - r.left;
    const i = Math.max(0, Math.min(x.length - 1, Math.round((px - m.l) / Math.max(1, w - m.l - m.r) * (x.length - 1))));
    cross.setAttribute("x1", X(i)); cross.setAttribute("x2", X(i)); cross.setAttribute("visibility", "visible");
    const rows = series.filter((s) => !s.hideTip).map((s) => ({ color: s.color, value: Number.isFinite(s.values[i]) ? yFormat(s.values[i]) : "n/a", label: s.name }));
    showTip(tip, host, X(i), ev.clientY - r.top, rows, String(xLabel(x[i])));
  };
  hit.addEventListener("pointermove", move);
  hit.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); tip.hidden = true; });
}

// ------------------------------------------------------------------ dot and interval (rows top to bottom)
export function dotInterval(host, opt) { observe(host, () => drawDots(host, opt)); }
function drawDots(host, { rows, ref = null, refLabel = "", format = (v) => v.toFixed(2), xTitle = "" }) {
  const rowH = 24, height = rows.length * rowH + 44;
  const { svg, tip, w } = frame(host, height);
  const m = { l: 150, r: 18, t: 8, b: 34 };
  const vals = rows.flatMap((r) => [r.lo, r.hi, r.value]).filter(Number.isFinite).concat(ref ?? []);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo) * 0.08 || 0.1; lo -= pad; hi += pad;
  const X = (v) => m.l + (w - m.l - m.r) * (v - lo) / (hi - lo);
  for (const t of niceTicks(lo, hi, Math.max(2, Math.min(5, Math.floor((w - m.l - m.r) / 70))))) {
    el("line", { x1: X(t), x2: X(t), y1: m.t, y2: height - m.b, class: "acl-grid" }, svg);
    el("text", { x: X(t), y: height - m.b + 14, "text-anchor": "middle", class: "acl-tick", text: format(t) }, svg);
  }
  if (xTitle) el("text", { x: m.l + (w - m.l - m.r) / 2, y: height - 4, "text-anchor": "middle", class: "acl-tick", text: xTitle }, svg);
  if (ref !== null) {
    el("line", { x1: X(ref), x2: X(ref), y1: m.t, y2: height - m.b, class: "acl-ref" }, svg);
    if (refLabel) el("text", { x: X(ref) + 4, y: m.t + 9, class: "acl-tick", text: refLabel }, svg);
  }
  rows.forEach((r, i) => {
    const y = m.t + i * rowH + rowH / 2;
    el("text", { x: m.l - 8, y: y + 4, "text-anchor": "end", class: r.emphasis ? "acl-label acl-label--strong" : "acl-label", text: r.label }, svg);
    if (Number.isFinite(r.lo) && Number.isFinite(r.hi)) el("line", { x1: X(r.lo), x2: X(r.hi), y1: y, y2: y, style: { stroke: r.color ?? seriesColor(0), strokeWidth: 2, opacity: 0.55, strokeLinecap: "round" } }, svg);
    if (Number.isFinite(r.value)) el("circle", { cx: X(r.value), cy: y, r: 5, class: "acl-dot", style: { fill: r.color ?? seriesColor(0) } }, svg);
    const hit = el("rect", { x: 0, y: y - rowH / 2, width: w, height: rowH, fill: "transparent" }, svg);
    hit.addEventListener("pointermove", (ev) => {
      const b = svg.getBoundingClientRect();
      const lines = [{ value: format(r.value), label: "estimate" }];
      if (Number.isFinite(r.lo)) lines.push({ value: `${format(r.lo)} to ${format(r.hi)}`, label: "95% interval" });
      if (r.note) lines.push({ value: r.note, label: "" });
      showTip(tip, host, ev.clientX - b.left, y, lines, r.label);
    });
    hit.addEventListener("pointerleave", () => { tip.hidden = true; });
  });
}

// ------------------------------------------------------------------ horizontal bars (signed: diverging colors)
export function barChart(host, opt) { observe(host, () => drawBars(host, opt)); }
function drawBars(host, { labels, values, format = (v) => v.toFixed(3), compare = null, compareLabel = "", valueLabel = "" }) {
  const rowH = compare ? 30 : 22, height = labels.length * rowH + 30;
  const { svg, tip, w } = frame(host, height);
  const m = { l: 92, r: 54, t: 6, b: 24 };
  const all = values.concat(compare ?? []).filter(Number.isFinite);
  const lo = Math.min(0, ...all), hi = Math.max(0, ...all);
  const X = (v) => m.l + (w - m.l - m.r) * (v - lo) / ((hi - lo) || 1);
  for (const t of niceTicks(lo, hi, Math.max(2, Math.min(4, Math.floor((w - m.l - m.r) / 70))))) {
    el("line", { x1: X(t), x2: X(t), y1: m.t, y2: height - m.b, class: t === 0 ? "acl-axis" : "acl-grid" }, svg);
    el("text", { x: X(t), y: height - 8, "text-anchor": "middle", class: "acl-tick", text: format(t) }, svg);
  }
  labels.forEach((lab, i) => {
    const y = m.t + i * rowH;
    el("text", { x: m.l - 8, y: y + rowH / 2 + 4, "text-anchor": "end", class: "acl-label", text: lab }, svg);
    const draw = (v, yy, hgt, colorVar) => {
      if (!Number.isFinite(v)) return;
      const x0 = X(0), x1 = X(v), xa = Math.min(x0, x1), wd = Math.max(1, Math.abs(x1 - x0));
      el("rect", { x: xa, y: yy, width: wd, height: hgt, rx: 2, style: { fill: colorVar } }, svg);
    };
    if (compare) {
      draw(compare[i], y + 4, 9, "var(--acl-neutral)");
      draw(values[i], y + 15, 9, values[i] >= 0 ? "var(--acl-pos)" : "var(--acl-neg)");
    } else draw(values[i], y + 4, rowH - 8, values[i] >= 0 ? "var(--acl-pos)" : "var(--acl-neg)");
    const vx = values[i] >= 0 ? X(Math.max(values[i], compare ? compare[i] ?? 0 : 0)) + 4 : X(Math.min(values[i], 0)) - 4;
    el("text", { x: values[i] >= 0 ? Math.min(vx, w - 4) : vx, y: y + rowH / 2 + 4, "text-anchor": values[i] >= 0 ? "start" : "end", class: "acl-value", text: Number.isFinite(values[i]) ? format(values[i]) : "" }, svg);
    const hit = el("rect", { x: 0, y, width: w, height: rowH, fill: "transparent" }, svg);
    hit.addEventListener("pointermove", (ev) => {
      const b = svg.getBoundingClientRect();
      const rows = [{ value: format(values[i]), label: valueLabel }];
      if (compare) rows.push({ value: format(compare[i]), label: compareLabel });
      showTip(tip, host, ev.clientX - b.left, y + rowH / 2, rows, lab);
    });
    hit.addEventListener("pointerleave", () => { tip.hidden = true; });
  });
  if (compare) legend(host, [{ name: compareLabel, color: "var(--acl-neutral)" }, { name: valueLabel, color: "var(--acl-pos)" }], "box");
}

// ------------------------------------------------------------------ heatmap (diverging, -1..1)
export function heatmap(host, opt) { observe(host, () => drawHeat(host, opt)); }
function divergingColor(v) {
  const t = Math.max(-1, Math.min(1, v));
  const mix = (a, b, f) => `color-mix(in srgb, var(${b}) ${Math.round(f * 100)}%, var(${a}))`;
  return t >= 0 ? mix("--acl-mid", "--acl-pos", t) : mix("--acl-mid", "--acl-neg", -t);
}
function drawHeat(host, { matrix, labels, format = (v) => v.toFixed(2), onCell = null, highlight = null }) {
  const n = labels.length, w0 = host.clientWidth || 400;
  const m = { l: 64, t: 64 };
  const cell = Math.max(18, Math.min(44, Math.floor((w0 - m.l - 8) / n)));
  const height = m.t + n * cell + 8;
  const { svg, tip } = frame(host, height);
  labels.forEach((lab, i) => {
    el("text", { x: m.l - 6, y: m.t + i * cell + cell / 2 + 4, "text-anchor": "end", class: "acl-tick", text: lab }, svg);
    const tx = m.l + i * cell + cell / 2;
    el("text", { x: tx, y: m.t - 6, transform: `rotate(-45 ${tx} ${m.t - 6})`, class: "acl-tick", text: lab }, svg);
  });
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const v = matrix[i][j];
    const r = el("rect", { x: m.l + j * cell + 1, y: m.t + i * cell + 1, width: cell - 2, height: cell - 2, rx: 2, style: { fill: divergingColor(v), cursor: onCell && i !== j ? "pointer" : "default" } }, svg);
    if (highlight && highlight(i, j)) r.setAttribute("class", "acl-cell--hl");
    if (cell >= 30) el("text", { x: m.l + j * cell + cell / 2, y: m.t + i * cell + cell / 2 + 4, "text-anchor": "middle", class: Math.abs(v) > 0.55 ? "acl-cellval acl-cellval--inv" : "acl-cellval", text: format(v) }, svg);
    r.addEventListener("pointermove", (ev) => {
      const b = svg.getBoundingClientRect();
      showTip(tip, host, ev.clientX - b.left, ev.clientY - b.top, [{ value: format(v), label: "correlation" }], `${labels[i]} / ${labels[j]}`);
    });
    r.addEventListener("pointerleave", () => { tip.hidden = true; });
    if (onCell && i !== j) r.addEventListener("click", () => onCell(i, j, v));
  }
}

// ------------------------------------------------------------------ columns (e.g. return by forecast decile)
export function columns(host, opt) { observe(host, () => drawCols(host, opt)); }
function drawCols(host, { labels, values, format = (v) => v.toFixed(2), height = 200, valueLabel = "" }) {
  const { svg, tip, w } = frame(host, height);
  const m = { l: 52, r: 10, t: 10, b: 26 };
  const lo = Math.min(0, ...values), hi = Math.max(0, ...values);
  const Y = (v) => m.t + (height - m.t - m.b) * (1 - (v - lo) / ((hi - lo) || 1));
  for (const t of niceTicks(lo, hi, 4)) {
    el("line", { x1: m.l, x2: w - m.r, y1: Y(t), y2: Y(t), class: t === 0 ? "acl-axis" : "acl-grid" }, svg);
    el("text", { x: m.l - 6, y: Y(t) + 3.5, "text-anchor": "end", class: "acl-tick", text: format(t) }, svg);
  }
  const band = (w - m.l - m.r) / values.length, bw = Math.min(24, band * 0.6);
  values.forEach((v, i) => {
    const cx = m.l + band * (i + 0.5), y0 = Y(0), y1 = Y(v);
    el("rect", { x: cx - bw / 2, y: Math.min(y0, y1), width: bw, height: Math.max(1, Math.abs(y1 - y0)), rx: 2, style: { fill: v >= 0 ? "var(--acl-pos)" : "var(--acl-neg)" } }, svg);
    el("text", { x: cx, y: height - 8, "text-anchor": "middle", class: "acl-tick", text: labels[i] }, svg);
    const hit = el("rect", { x: cx - band / 2, y: m.t, width: band, height: height - m.t - m.b, fill: "transparent" }, svg);
    hit.addEventListener("pointermove", (ev) => { const b = svg.getBoundingClientRect(); showTip(tip, host, cx, ev.clientY - b.top, [{ value: format(v), label: valueLabel }], `decile ${labels[i]}`); });
    hit.addEventListener("pointerleave", () => { tip.hidden = true; });
  });
}
