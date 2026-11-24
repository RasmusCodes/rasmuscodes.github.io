/* Small SVG chart helpers for the demo. Marks follow fixed specs: bars <= 24px with 4px rounded data
   ends (square at the baseline), 2px lines, >= 8px markers with a 2px surface ring, hairline grids,
   text in ink tokens (never the series colour), a legend for two or more series, hover tooltips. */
(function (global) {
  "use strict";
  const NS = "http://www.w3.org/2000/svg";
  const SERIES = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)", "var(--series-5)", "var(--series-6)", "var(--series-7)", "var(--series-8)"];

  function el(tag, attrs = {}, parent) {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) node.setAttribute(k, v);
    if (parent) parent.appendChild(node);
    return node;
  }
  function svgFor(container, height) {
    container.innerHTML = "";
    const width = Math.max(260, container.clientWidth || 600);
    const svg = el("svg", { width, height, viewBox: `0 0 ${width} ${height}`, role: "img" }, container);
    return { svg, width, height };
  }
  function text(parent, x, y, str, opts = {}) {
    const t = el("text", { x, y, "text-anchor": opts.anchor || "start", "dominant-baseline": opts.baseline || "middle",
      class: opts.cls || "ax", "font-weight": opts.weight }, parent);
    t.textContent = str; return t;
  }
  function niceStep(span, count) { const raw = span / Math.max(1, count), mag = Math.pow(10, Math.floor(Math.log10(raw))), r = raw / mag;
    return (r >= 5 ? 10 : r >= 2 ? 5 : r >= 1 ? 2 : 1) * mag; }
  function ticks(min, max, count = 5) { if (min === max) { min -= 1; max += 1; } const step = niceStep(max - min, count), out = [];
    for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v); return out; }
  const fmt = {
    pct0: (v) => (v * 100).toFixed(0) + "%", pct1: (v) => (v * 100).toFixed(1) + "%", pct2: (v) => (v * 100).toFixed(2) + "%",
    spct1: (v) => (v >= 0 ? "+" : "−") + Math.abs(v * 100).toFixed(1) + "%", num2: (v) => v.toFixed(2), num1: (v) => v.toFixed(1),
    mult: (v) => (v >= 10 ? v.toFixed(0) : v.toFixed(1)) + "×",
  };
  function measure(str, size = 12) { return str.length * size * 0.56; }

  /* tooltip */
  function tip() { return document.getElementById("tooltip"); }
  function showTip(evt, html) {
    const t = tip(); if (!t) return; t.innerHTML = html; t.hidden = false;
    const pad = 12, w = t.offsetWidth, h = t.offsetHeight;
    let x = evt.clientX + pad, y = evt.clientY + pad;
    if (x + w > window.innerWidth - 4) x = evt.clientX - w - pad;
    if (y + h > window.innerHeight - 4) y = evt.clientY - h - pad;
    t.style.left = Math.max(4, x) + "px"; t.style.top = Math.max(4, y) + "px";
  }
  function hideTip() { const t = tip(); if (t) t.hidden = true; }
  const swatch = (c, line = false) => `<span class="sw${line ? " sw--line" : ""}" style="background:${c}"></span>`;

  function legend(container, series, line = false) {
    if (!container) return;
    container.innerHTML = series.length < 2 ? "" : series.map((s, i) => `<span class="lg">${swatch(s.color || SERIES[i], line)}${esc(s.name)}</span>`).join("");
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  /* rounded data-end bar: square at x0 (baseline), 4px radius at x1 */
  function hbarPath(x0, x1, y, h) {
    const r = Math.min(4, Math.abs(x1 - x0), h / 2), dir = x1 >= x0 ? 1 : -1;
    if (Math.abs(x1 - x0) < 0.5) return `M${x0},${y}h${dir * 0.5}v${h}h${-dir * 0.5}Z`;
    return `M${x0},${y}H${x1 - dir * r}A${r},${r} 0 0 ${dir > 0 ? 1 : 0} ${x1},${y + r}V${y + h - r}A${r},${r} 0 0 ${dir > 0 ? 1 : 0} ${x1 - dir * r},${y + h}H${x0}Z`;
  }

  /* horizontal grouped bars */
  function bars(container, opt) {
    const cats = opt.categories, labels = opt.labels || cats, series = opt.series, f = opt.format || fmt.pct1, ns = series.length;
    const thick = Math.min(24, ns === 1 ? 16 : Math.floor((24 - 2 * (ns - 1)) / ns) + 2), gap = 2;
    const rowH = Math.max(opt.rowHeight || 0, ns * thick + (ns - 1) * gap + 10);
    const labW = Math.min(190, Math.max(...labels.map((l) => measure(l))) + 12), valW = opt.valueLabels === false ? 8 : 56;
    const top = 6, bottom = 24, height = top + bottom + rowH * cats.length;
    const { svg, width } = svgFor(container, height);
    let lo = Math.min(0, ...series.flatMap((s) => s.values.filter(Number.isFinite))), hi = Math.max(0, ...series.flatMap((s) => s.values.filter(Number.isFinite)));
    if (opt.domain) [lo, hi] = opt.domain;
    if (hi - lo < 1e-9) hi = lo + 0.01;
    const tk = ticks(lo, hi, Math.max(3, Math.floor((width - labW - valW) / 90)));
    lo = Math.min(lo, tk[0]); hi = Math.max(hi, tk[tk.length - 1]);
    const x = (v) => labW + (v - lo) / (hi - lo) * (width - labW - valW);
    const g = el("g", {}, svg);
    tk.forEach((v) => { el("line", { x1: x(v), x2: x(v), y1: top, y2: height - bottom, class: v === 0 ? "base" : "grid" }, g);
      text(g, x(v), height - bottom + 12, f(v), { anchor: "middle", cls: "tick" }); });
    cats.forEach((c, i) => {
      const y0 = top + i * rowH, inner = ns * thick + (ns - 1) * gap, yStart = y0 + (rowH - inner) / 2;
      text(g, labW - 8, y0 + rowH / 2, labels[i], { anchor: "end", cls: "lab" });
      series.forEach((s, k) => {
        const v = s.values[i]; if (!Number.isFinite(v)) return;
        const fill = opt.colorBySign ? (v >= 0 ? "var(--pos)" : "var(--neg)") : (s.color || SERIES[k]);
        el("path", { d: hbarPath(x(0), x(v), yStart + k * (thick + gap), thick), style: `fill:${fill}` }, g);
      });
      if (opt.valueLabels !== false) { const v = series[0].values[i];
        if (Number.isFinite(v) && Math.abs(v) > 1e-9) {
          const xv = x(v), w = measure(f(v), 11.5), yl = yStart + thick / 2;
          if (v >= 0) text(g, xv + 4, yl, f(v), { anchor: "start", cls: "val" });
          else if (xv - 4 - w > labW + 2) text(g, xv - 4, yl, f(v), { anchor: "end", cls: "val" });
          else text(g, x(0) + 4, yl, f(v), { anchor: "start", cls: "val" });   /* no room left of the bar: put it past the baseline */
        } }
      const hit = el("rect", { x: 0, y: y0, width, height: rowH, class: "hit" }, g);
      hit.addEventListener("mousemove", (e) => showTip(e, `<b>${esc(labels[i])}</b>` + series.map((s, k) =>
        `<div>${swatch(opt.colorBySign ? (s.values[i] >= 0 ? "var(--pos)" : "var(--neg)") : (s.color || SERIES[k]))}${esc(s.name)}: <b>${Number.isFinite(s.values[i]) ? f(s.values[i]) : "–"}</b></div>`).join("") + (opt.extraTip ? opt.extraTip(i) : "")));
      hit.addEventListener("mouseleave", hideTip);
    });
    return svg;
  }

  /* line chart with crosshair */
  function lines(container, opt) {
    const xs = opt.x, series = opt.series.filter((s) => s.values && s.values.length), f = opt.format || fmt.pct0, H = opt.height || 280, log = !!opt.log;
    const left = 52, right = opt.endLabels === false ? 12 : 120, top = 10, bottom = 26;
    const { svg, width } = svgFor(container, H);
    const vals = series.flatMap((s) => s.values.filter(Number.isFinite));
    let lo = opt.domain ? opt.domain[0] : Math.min(...vals), hi = opt.domain ? opt.domain[1] : Math.max(...vals);
    if (opt.zero) lo = Math.min(lo, 0);
    const tr = log ? Math.log : (v) => v;
    let tk;
    if (log) { const a = Math.floor(Math.log10(lo)), b = Math.ceil(Math.log10(hi)); tk = [];
      for (let e = a; e <= b; e++) for (const m of [1, 2, 5]) { const v = m * Math.pow(10, e); if (v >= lo * 0.999 && v <= hi * 1.001) tk.push(v); }
      if (tk.length > 8) tk = tk.filter((v) => Math.abs(Math.log10(v) % 1) < 1e-9); }
    else { tk = ticks(lo, hi, 5); lo = Math.min(lo, tk[0]); hi = Math.max(hi, tk[tk.length - 1]); }
    const n = xs.length, X = (i) => left + i / Math.max(1, n - 1) * (width - left - right);
    const Y = (v) => top + (tr(hi) - tr(v)) / (tr(hi) - tr(lo) || 1) * (H - top - bottom);
    const g = el("g", {}, svg);
    tk.forEach((v) => { el("line", { x1: left, x2: width - right, y1: Y(v), y2: Y(v), class: v === 0 && !log ? "base" : "grid" }, g);
      text(g, left - 6, Y(v), log ? fmt.mult(v) : f(v), { anchor: "end", cls: "tick" }); });
    const years = [...new Set(xs.map((d) => d.slice(0, 4)))], step = Math.ceil(years.length / Math.max(2, Math.floor((width - left - right) / 60)));
    years.forEach((yr, k) => { if (k % step) return; const i = xs.findIndex((d) => d.startsWith(yr)); text(g, X(i), H - bottom + 14, yr, { anchor: "middle", cls: "tick" }); });
    series.forEach((s, k) => {
      const c = s.color || SERIES[k];
      if (opt.area) { let d = `M${X(0)},${Y(0)}`; s.values.forEach((v, i) => { d += `L${X(i)},${Y(Number.isFinite(v) ? v : 0)}`; }); d += `L${X(n - 1)},${Y(0)}Z`;
        el("path", { d, style: `fill:${c};opacity:0.12` }, g); }
      let d = ""; s.values.forEach((v, i) => { if (!Number.isFinite(v)) return; d += (d ? "L" : "M") + X(i).toFixed(1) + "," + Y(v).toFixed(1); });
      el("path", { d, class: "line", style: `stroke:${c}` }, g);
    });
    // end labels when they do not collide
    if (opt.endLabels !== false && series.length <= 4) {
      const ends = series.map((s, k) => ({ k, y: Y(s.values[s.values.length - 1]), s })).sort((a, b) => a.y - b.y);
      const collide = ends.some((e, i) => i && e.y - ends[i - 1].y < 14);
      if (!collide) ends.forEach((e) => { const v = e.s.values[e.s.values.length - 1];
        el("circle", { cx: X(n - 1), cy: e.y, r: 4, class: "dot", style: `fill:${e.s.color || SERIES[e.k]}` }, g);
        text(g, X(n - 1) + 8, e.y, `${e.s.name} ${log ? fmt.mult(v) : f(v)}`, { cls: "val" }); });
    }
    const cross = el("line", { y1: top, y2: H - bottom, class: "cross", visibility: "hidden" }, g);
    const dots = series.map((s, k) => el("circle", { r: 4, class: "dot", style: `fill:${s.color || SERIES[k]}`, visibility: "hidden" }, g));
    const hit = el("rect", { x: left, y: top, width: width - left - right, height: H - top - bottom, class: "hit" }, g);
    hit.addEventListener("mousemove", (e) => {
      const r = svg.getBoundingClientRect(), i = Math.round((e.clientX - r.left - left) / (width - left - right) * (n - 1));
      if (i < 0 || i >= n) return;
      cross.setAttribute("x1", X(i)); cross.setAttribute("x2", X(i)); cross.setAttribute("visibility", "visible");
      series.forEach((s, k) => { const v = s.values[i]; if (Number.isFinite(v)) { dots[k].setAttribute("cx", X(i)); dots[k].setAttribute("cy", Y(v)); dots[k].setAttribute("visibility", "visible"); } });
      showTip(e, `<b>${esc(xs[i])}</b>` + series.map((s, k) => `<div>${swatch(s.color || SERIES[k], true)}${esc(s.name)}: <b>${Number.isFinite(s.values[i]) ? (log ? fmt.mult(s.values[i]) : f(s.values[i])) : "–"}</b></div>`).join(""));
    });
    hit.addEventListener("mouseleave", () => { cross.setAttribute("visibility", "hidden"); dots.forEach((d) => d.setAttribute("visibility", "hidden")); hideTip(); });
    return svg;
  }

  /* scatter with optional lines (efficient frontier) */
  function scatter(container, opt) {
    const H = opt.height || 340, left = 52, right = 16, top = 24, bottom = 36, fx = opt.xFormat || fmt.pct0, fy = opt.yFormat || fmt.pct0;
    const { svg, width } = svgFor(container, H);
    const pts = (opt.points || []).concat(...(opt.lines || []).map((l) => l.points));
    let x0 = Math.min(0, ...pts.map((p) => p.x)), x1 = Math.max(...pts.map((p) => p.x)), y0 = Math.min(0, ...pts.map((p) => p.y)), y1 = Math.max(...pts.map((p) => p.y));
    const tx = ticks(x0, x1 * 1.05, 6), ty = ticks(y0, y1 * 1.05, 5);
    x0 = Math.min(x0, tx[0]); x1 = Math.max(x1, tx[tx.length - 1]); y0 = Math.min(y0, ty[0]); y1 = Math.max(y1, ty[ty.length - 1]);
    const X = (v) => left + (v - x0) / (x1 - x0) * (width - left - right), Y = (v) => top + (y1 - v) / (y1 - y0) * (H - top - bottom);
    const g = el("g", {}, svg);
    tx.forEach((v) => { el("line", { x1: X(v), x2: X(v), y1: top, y2: H - bottom, class: v === 0 ? "base" : "grid" }, g); text(g, X(v), H - bottom + 14, fx(v), { anchor: "middle", cls: "tick" }); });
    ty.forEach((v) => { el("line", { x1: left, x2: width - right, y1: Y(v), y2: Y(v), class: v === 0 ? "base" : "grid" }, g); text(g, left - 6, Y(v), fy(v), { anchor: "end", cls: "tick" }); });
    text(g, (left + width - right) / 2, H - 4, opt.xLabel || "", { anchor: "middle", cls: "axlab", baseline: "auto" });
    text(g, 4, 4, opt.yLabel || "", { cls: "axlab", baseline: "hanging" });
    (opt.lines || []).forEach((l, k) => { let d = ""; l.points.forEach((p) => { d += (d ? "L" : "M") + X(p.x).toFixed(1) + "," + Y(p.y).toFixed(1); });
      el("path", { d, class: "line" + (l.thin ? " line--thin" : ""), style: `stroke:${l.color || SERIES[k]};${l.opacity ? "opacity:" + l.opacity : ""}` }, g); });
    const placed = [];
    (opt.points || []).forEach((p) => {
      el("circle", { cx: X(p.x), cy: Y(p.y), r: p.r || 5, class: "dot", style: `fill:${p.color || "var(--muted)"}` }, g);
      if (p.label && p.showLabel) {   /* nudge a label down while it would overlap one already placed */
        const lx = X(p.x) + (p.r || 5) + 4, w = measure(p.label, 11.5);
        let ly = Y(p.y);
        while (placed.some((q) => Math.abs(q.y - ly) < 14 && lx < q.x + q.w && q.x < lx + w)) ly += 14;
        placed.push({ x: lx, y: ly, w });
        text(g, lx, ly, p.label, { cls: p.strong ? "val" : "lab" });
      }
      const hit = el("circle", { cx: X(p.x), cy: Y(p.y), r: 11, class: "hit" }, g);
      hit.addEventListener("mousemove", (e) => showTip(e, `<b>${esc(p.label || "")}</b><div>Volatility ${fx(p.x)}</div><div>Expected excess return ${fy(p.y)}</div>${p.extra || ""}`));
      hit.addEventListener("mouseleave", hideTip);
    });
    return svg;
  }

  /* correlation heatmap: diverging blue (negative) - gray - red (positive) */
  function heatmap(container, opt) {
    const labels = opt.labels, M = opt.matrix, n = labels.length, labW = Math.min(110, Math.max(...labels.map((l) => measure(l, 11))) + 8);
    const size = Math.max(14, Math.min(34, Math.floor(((container.clientWidth || 600) - labW - 10) / n)));
    const H = labW + size * n + 6, { svg } = svgFor(container, H), g = el("g", {}, svg);
    const color = (v) => { const a = Math.min(1, Math.abs(v)); return v >= 0 ? `color-mix(in srgb, var(--neg) ${Math.round(a * 100)}%, var(--mid))` : `color-mix(in srgb, var(--pos) ${Math.round(a * 100)}%, var(--mid))`; };
    for (let i = 0; i < n; i++) {
      text(g, labW - 6, labW + i * size + size / 2, labels[i], { anchor: "end", cls: "tick" });
      const t = text(g, labW + i * size + size / 2, labW - 6, labels[i], { anchor: "start", cls: "tick" }); t.setAttribute("transform", `rotate(-60 ${labW + i * size + size / 2} ${labW - 6})`);
      for (let j = 0; j < n; j++) {
        const r = el("rect", { x: labW + j * size + 1, y: labW + i * size + 1, width: size - 2, height: size - 2, rx: 2, style: `fill:${color(M[i][j])}` }, g);
        r.addEventListener("mousemove", (e) => showTip(e, `<b>${esc(labels[i])} × ${esc(labels[j])}</b><div>${opt.tipLabel || "Correlation"} ${M[i][j].toFixed(2)}</div>`));
        r.addEventListener("mouseleave", hideTip);
      }
    }
    return svg;
  }

  /* box plots (one row per category) */
  function boxes(container, opt) {
    const cats = opt.labels, st = opt.stats, f = opt.format || fmt.pct0, rowH = 24, labW = Math.min(170, Math.max(...cats.map((l) => measure(l))) + 12);
    const top = 6, bottom = 24, H = top + bottom + rowH * cats.length, { svg, width } = svgFor(container, H);
    let lo = Math.min(0, ...st.map((s) => s.min)), hi = Math.max(...st.map((s) => s.max)); const tk = ticks(lo, hi, 5); lo = Math.min(lo, tk[0]); hi = Math.max(hi, tk[tk.length - 1]);
    const X = (v) => labW + (v - lo) / (hi - lo || 1) * (width - labW - 14), g = el("g", {}, svg);
    tk.forEach((v) => { el("line", { x1: X(v), x2: X(v), y1: top, y2: H - bottom, class: v === 0 ? "base" : "grid" }, g); text(g, X(v), H - bottom + 12, f(v), { anchor: "middle", cls: "tick" }); });
    st.forEach((s, i) => { const y = top + i * rowH + rowH / 2; text(g, labW - 8, y, cats[i], { anchor: "end", cls: "lab" });
      el("line", { x1: X(s.min), x2: X(s.max), y1: y, y2: y, class: "whisker" }, g);
      el("rect", { x: X(s.q1), y: y - 6, width: Math.max(2, X(s.q3) - X(s.q1)), height: 12, rx: 3, style: "fill:var(--series-1);opacity:0.35" }, g);
      el("line", { x1: X(s.med), x2: X(s.med), y1: y - 7, y2: y + 7, class: "median" }, g);
      if (Number.isFinite(s.ref)) el("circle", { cx: X(s.ref), cy: y, r: 4, class: "dot", style: "fill:var(--series-2)" }, g);
      const hit = el("rect", { x: 0, y: y - rowH / 2, width, height: rowH, class: "hit" }, g);
      hit.addEventListener("mousemove", (e) => showTip(e, `<b>${esc(cats[i])}</b><div>5th–95th pct ${f(s.min)} – ${f(s.max)}</div><div>Middle half ${f(s.q1)} – ${f(s.q3)}</div><div>Median ${f(s.med)}</div>${Number.isFinite(s.ref) ? `<div>${swatch("var(--series-2)")}With the true inputs ${f(s.ref)}</div>` : ""}`));
      hit.addEventListener("mouseleave", hideTip); });
    return svg;
  }

  global.Charts = { bars, lines, scatter, heatmap, boxes, legend, fmt, SERIES, showTip, hideTip, esc };
})(window);
