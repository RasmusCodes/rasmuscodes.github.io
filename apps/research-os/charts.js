/* qros charts: small dependency-free SVG charts with hover tooltips, keyboard focus and table views.
   Conventions (dataviz method): one y-axis, hairline solid grid, 2px lines, >=8px markers with a 2px
   surface ring, area fills as ~10% washes, bars <= 24px with 4px rounded data ends, text in text tokens. */
(function (global) {
  "use strict";
  const NS = "http://www.w3.org/2000/svg";

  function s(tag, attrs, parent) {
    const node = document.createElementNS(NS, tag);
    for (const k in attrs || {}) if (attrs[k] !== undefined && attrs[k] !== null) node.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(node);
    return node;
  }
  function h(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const k in attrs || {}) {
      const v = attrs[k];
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      node.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }
  function css(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888888";
  }

  // ------------------------------------------------------------------ formatting
  const fmt = {
    pct(v, d = 1) { return v == null || !isFinite(v) ? "–" : (v >= 0 ? "+" : "−") + Math.abs(v * 100).toFixed(d) + "%"; },
    pctPlain(v, d = 1) { return v == null || !isFinite(v) ? "–" : (v < 0 ? "−" : "") + Math.abs(v * 100).toFixed(d) + "%"; },
    num(v, d = 2) { return v == null || !isFinite(v) ? "–" : (v < 0 ? "−" : "") + Math.abs(v).toFixed(d); },
    int(v) { return v == null ? "–" : Number(v).toLocaleString("en-US"); },
    date(d) {
      const t = new Date(d + "T00:00:00Z");
      return t.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
    },
  };

  // ------------------------------------------------------------------ tooltip
  let tip = null;
  function tooltip() {
    if (!tip) { tip = h("div", { class: "tooltip", role: "status", "aria-live": "polite" }); tip.hidden = true; document.body.appendChild(tip); }
    return tip;
  }
  function showTip(x, y, title, rows) {
    const t = tooltip();
    t.replaceChildren();
    if (title) t.appendChild(h("div", { class: "tt-title", text: title }));
    for (const r of rows) {
      const left = h("span", null);
      if (r.color) left.appendChild(h("i", { class: "tt-key", style: `background:${r.color}` }));
      left.appendChild(document.createTextNode(r.label));
      t.appendChild(h("div", { class: "tt-row" }, left, h("b", { text: r.value })));
    }
    t.hidden = false;
    const w = t.offsetWidth, hh = t.offsetHeight;
    let left = x + 14, top = y + 14;
    if (left + w > window.innerWidth - 8) left = x - w - 14;
    if (top + hh > window.innerHeight - 8) top = y - hh - 14;
    t.style.left = Math.max(8, left) + "px";
    t.style.top = Math.max(8, top) + "px";
  }
  function hideTip() { if (tip) tip.hidden = true; }

  // ------------------------------------------------------------------ scales
  function linear(d0, d1, r0, r1) {
    const span = d1 - d0 || 1;
    const f = (v) => r0 + (v - d0) / span * (r1 - r0);
    f.invert = (p) => d0 + (p - r0) / (r1 - r0) * span;
    return f;
  }
  function niceTicks(lo, hi, count = 5) {
    if (!isFinite(lo) || !isFinite(hi)) return [];
    if (lo === hi) { lo -= 1; hi += 1; }
    const raw = (hi - lo) / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((st) => st >= raw) || 10 * mag;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    return out;
  }
  function toMs(d) { return Date.parse(d + "T00:00:00Z"); }
  function yearTicks(t0, t1, maxTicks) {
    const y0 = new Date(t0).getUTCFullYear() + 1, y1 = new Date(t1).getUTCFullYear();
    const span = y1 - y0 + 1;
    const step = Math.max(1, Math.ceil(span / maxTicks));
    const out = [];
    for (let y = y0; y <= y1; y += step) out.push({ t: Date.UTC(y, 0, 1), label: String(y) });
    return out;
  }
  function nearest(arr, v) {
    let lo = 0, hi = arr.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (arr[mid] < v) lo = mid; else hi = mid; }
    return Math.abs(arr[lo] - v) <= Math.abs(arr[hi] - v) ? lo : hi;
  }

  function frame(container, height) {
    container.replaceChildren();
    container.classList.add("chart");
    const width = Math.max(280, Math.floor(container.getBoundingClientRect().width || container.parentElement?.clientWidth || 640));
    const svg = s("svg", { viewBox: `0 0 ${width} ${height}`, width, height, role: "img" });
    container.appendChild(svg);
    return { svg, width, height };
  }

  function addFoot(container, opts) {
    const foot = h("div", { class: "chart-foot" });
    foot.appendChild(h("span", { class: "small", text: opts.note || "" }));
    if (opts.table) {
      const btn = h("button", { class: "btn btn--sm", type: "button", "aria-expanded": "false", text: "Show table" });
      const box = h("div", { class: "table-view" });
      box.hidden = true;
      btn.addEventListener("click", () => {
        box.hidden = !box.hidden;
        btn.textContent = box.hidden ? "Show table" : "Hide table";
        btn.setAttribute("aria-expanded", String(!box.hidden));
        if (!box.hidden && !box.firstChild) box.appendChild(opts.table());
      });
      foot.appendChild(btn);
      container.appendChild(foot);
      container.appendChild(box);
    } else if (opts.note) {
      container.appendChild(foot);
    }
  }

  function legend(container, items, kind = "line") {
    if (!items || items.length < 2) return;
    const box = h("div", { class: "chart-legend" });
    for (const it of items) box.appendChild(h("span", null, h("i", { class: kind === "box" ? "box" : "", style: `background:${it.color}` }), it.label));
    container.insertBefore(box, container.firstChild);
  }

  // ------------------------------------------------------------------ line chart
  // series: [{label, color, d: [dates], v: [values], area?}], bands: [{from, to, label, fill}]
  function line(container, opts) {
    const height = opts.height || 260;
    const series = (opts.series || []).filter((sr) => sr.d && sr.d.length);
    const { svg, width } = frame(container, height);
    const m = { top: 22, right: opts.endLabels ? 70 : 16, bottom: 26, left: 52 };
    if (!series.length) { s("text", { x: 16, y: 40, class: "tick" }, svg).textContent = "No data"; return; }
    const allT = series.flatMap((sr) => sr.d.map(toMs));
    const allV = series.flatMap((sr) => sr.v).filter((v) => v != null && isFinite(v));
    let t0 = Math.min(...allT), t1 = Math.max(...allT);
    let v0 = Math.min(...allV, opts.includeZero ? 0 : Infinity), v1 = Math.max(...allV, opts.includeZero ? 0 : -Infinity);
    if (opts.yDomain) [v0, v1] = opts.yDomain;
    const pad = (v1 - v0) * 0.06 || 0.01;
    v0 -= opts.yDomain ? 0 : pad; v1 += opts.yDomain ? 0 : pad;
    const x = linear(t0, t1, m.left, width - m.right);
    const y = linear(v0, v1, height - m.bottom, m.top);
    const g = s("g", null, svg);
    // bands
    for (const b of opts.bands || []) {
      const a = Math.max(t0, toMs(b.from)), z = Math.min(t1, toMs(b.to));
      if (z <= a) continue;
      s("rect", { x: x(a), y: m.top, width: x(z) - x(a), height: height - m.top - m.bottom, fill: b.fill }, g);
      const lbl = s("text", { x: x(a) + 6, y: m.top - 7, class: "band-label" }, g);
      lbl.textContent = b.label;
    }
    // grid + y axis
    const yt = niceTicks(v0, v1, Math.max(3, Math.round((height - m.top - m.bottom) / 55)));
    const yf = opts.yFormat || ((v) => fmt.num(v));
    for (const t of yt) {
      s("line", { x1: m.left, x2: width - m.right, y1: y(t), y2: y(t), class: t === 0 ? "baseline" : "gridline" }, g);
      const tx = s("text", { x: m.left - 8, y: y(t) + 4, "text-anchor": "end", class: "tick" }, g);
      tx.textContent = yf(t);
    }
    for (const t of yearTicks(t0, t1, Math.max(2, Math.floor((width - m.left - m.right) / 70)))) {
      const tx = s("text", { x: x(t.t), y: height - 8, "text-anchor": "middle", class: "tick" }, g);
      tx.textContent = t.label;
    }
    for (const r of opts.refLines || []) {
      s("line", { x1: m.left, x2: width - m.right, y1: y(r.y), y2: y(r.y), class: "ref" }, g);
      if (r.label) { const tx = s("text", { x: width - m.right, y: y(r.y) - 4, "text-anchor": "end", class: "ref-label" }, g); tx.textContent = r.label; }
    }
    // series; end labels that would collide are dropped (the legend and tooltip still carry them)
    const pts = series.map((sr) => sr.d.map((d, i) => [x(toMs(d)), sr.v[i]]));
    const keptEnds = [];
    series.forEach((sr, k) => {
      const p = pts[k].filter((q) => q[1] != null && isFinite(q[1])).map((q) => [q[0], y(q[1])]);
      if (!p.length) return;
      const dpath = "M" + p.map((q) => q[0].toFixed(1) + "," + q[1].toFixed(1)).join("L");
      if (sr.area) {
        const base = y(Math.max(v0, Math.min(v1, sr.areaBase ?? 0)));
        s("path", { d: dpath + `L${p[p.length - 1][0].toFixed(1)},${base}L${p[0][0].toFixed(1)},${base}Z`, fill: sr.color, "fill-opacity": 0.1, stroke: "none" }, g);
      }
      s("path", { d: dpath, fill: "none", stroke: sr.color, "stroke-width": sr.width || 2, "stroke-linejoin": "round", "stroke-linecap": "round", "stroke-dasharray": sr.dash || null, opacity: sr.opacity || null }, g);
      if (opts.endLabels && !sr.noEnd) {
        const last = p[p.length - 1];
        s("circle", { cx: last[0], cy: last[1], r: 4, fill: sr.color, stroke: "var(--chart-surface)", "stroke-width": 2 }, g);
        if (keptEnds.every((yy) => Math.abs(yy - last[1]) >= 14)) {
          keptEnds.push(last[1]);
          const tx = s("text", { x: last[0] + 8, y: last[1] + 4, class: "end-label" }, g);
          tx.textContent = sr.endLabel || yf(sr.v[sr.v.length - 1]);
        }
      }
    });
    // crosshair + tooltip (snaps to the nearest date of the first series)
    const base = series[0].d.map(toMs);
    const cross = s("line", { y1: m.top, y2: height - m.bottom, class: "crosshair", visibility: "hidden" }, g);
    const dots = series.map((sr) => s("circle", { r: 4, fill: sr.color, stroke: "var(--chart-surface)", "stroke-width": 2, visibility: "hidden" }, g));
    const hit = s("rect", { x: m.left, y: m.top, width: width - m.left - m.right, height: height - m.top - m.bottom, fill: "transparent", tabindex: 0, "aria-label": opts.ariaLabel || "Chart; use arrow keys to read values" }, g);
    let idx = base.length - 1;
    function show(i, cx, cy) {
      idx = Math.max(0, Math.min(base.length - 1, i));
      const t = base[idx];
      const px = x(t);
      cross.setAttribute("x1", px); cross.setAttribute("x2", px); cross.setAttribute("visibility", "visible");
      const rows = [];
      series.forEach((sr, k) => {
        const j = sr === series[0] ? idx : nearest(sr.d.map(toMs), t);
        const v = sr.v[j];
        if (v == null || !isFinite(v)) { dots[k].setAttribute("visibility", "hidden"); return; }
        dots[k].setAttribute("cx", x(toMs(sr.d[j]))); dots[k].setAttribute("cy", y(v)); dots[k].setAttribute("visibility", "visible");
        rows.push({ label: sr.label, value: yf(v), color: sr.color });
      });
      const rect = svg.getBoundingClientRect();
      const scale = rect.width / width;
      showTip(cx ?? rect.left + px * scale, cy ?? rect.top + m.top * scale + 20, fmt.date(series[0].d[idx]), rows);
    }
    function hide() { cross.setAttribute("visibility", "hidden"); dots.forEach((d) => d.setAttribute("visibility", "hidden")); hideTip(); }
    hit.addEventListener("pointermove", (ev) => {
      const rect = svg.getBoundingClientRect();
      const px = (ev.clientX - rect.left) * (width / rect.width);
      show(nearest(base, x.invert(px)), ev.clientX, ev.clientY);
    });
    hit.addEventListener("pointerleave", hide);
    hit.addEventListener("focus", () => show(idx));
    hit.addEventListener("blur", hide);
    hit.addEventListener("keydown", (ev) => {
      if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
        ev.preventDefault();
        const step = ev.shiftKey ? 13 : 1;
        show(idx + (ev.key === "ArrowRight" ? step : -step));
      }
    });
    legend(container, series.filter((sr) => !sr.noLegend).map((sr) => ({ label: sr.label, color: sr.color })));
    addFoot(container, opts);
  }

  // ------------------------------------------------------------------ bars / histogram
  // bins: [{x0, x1, count, label?, highlight?, items?}] ; markers: [{x, label}]
  function histogram(container, opts) {
    const height = opts.height || 220;
    const { svg, width } = frame(container, height);
    const m = { top: 24, right: 16, bottom: 30, left: 40 };
    const bins = opts.bins || [];
    if (!bins.length) return;
    const x0 = Math.min(bins[0].x0, ...(opts.markers || []).map((k) => k.x)), x1 = Math.max(bins[bins.length - 1].x1, ...(opts.markers || []).map((k) => k.x));
    const maxC = Math.max(1, ...bins.map((b) => b.count));
    const x = linear(x0, x1, m.left, width - m.right);
    const y = linear(0, maxC * 1.1, height - m.bottom, m.top);
    const g = s("g", null, svg);
    if (opts.shadeBelow != null) {
      const z = Math.min(Math.max(opts.shadeBelow, x0), x1);
      s("rect", { x: m.left, y: m.top, width: x(z) - m.left, height: height - m.top - m.bottom, fill: "var(--band-holdout)" }, g);
      if (opts.shadeLabel) { const tx = s("text", { x: m.left + 6, y: m.top - 8, class: "band-label" }, g); tx.textContent = opts.shadeLabel; }
    }
    for (const t of niceTicks(0, maxC * 1.1, 4)) {
      s("line", { x1: m.left, x2: width - m.right, y1: y(t), y2: y(t), class: t === 0 ? "baseline" : "gridline" }, g);
      const tx = s("text", { x: m.left - 8, y: y(t) + 4, "text-anchor": "end", class: "tick" }, g);
      tx.textContent = String(Math.round(t));
    }
    const xf = opts.xFormat || ((v) => fmt.num(v, 1));
    for (const t of niceTicks(x0, x1, Math.max(3, Math.floor((width - m.left - m.right) / 80)))) {
      const tx = s("text", { x: x(t), y: height - 10, "text-anchor": "middle", class: "tick" }, g);
      tx.textContent = xf(t);
    }
    const color = opts.color || "var(--series-1)";
    for (const b of bins) {
      if (!b.count) continue;
      const slot = x(b.x1) - x(b.x0);
      const bw = Math.min(24, Math.max(2, slot - 2));
      const bx = x(b.x0) + (slot - bw) / 2;
      const top = y(b.count), bottom = y(0);
      const r = Math.min(4, bw / 2, bottom - top);
      const path = `M${bx},${bottom}V${top + r}Q${bx},${top} ${bx + r},${top}H${bx + bw - r}Q${bx + bw},${top} ${bx + bw},${top + r}V${bottom}Z`;
      const bar = s("path", { d: path, fill: b.highlight ? "var(--series-2)" : color, tabindex: 0 }, g);
      const hitRect = s("rect", { x: x(b.x0), y: m.top, width: Math.max(slot, 6), height: height - m.top - m.bottom, fill: "transparent" }, g);
      const label = b.label || `${xf(b.x0)} to ${xf(b.x1)}`;
      const rows = [{ label: opts.countLabel || "count", value: String(b.count) }];
      if (b.items && b.items.length) rows.push({ label: "e.g.", value: b.items.slice(0, 3).join(", ") });
      const on = (ev) => { bar.setAttribute("opacity", "0.8"); const rr = bar.getBoundingClientRect(); showTip(ev?.clientX ?? rr.right, ev?.clientY ?? rr.top, label, rows); };
      const off = () => { bar.removeAttribute("opacity"); hideTip(); };
      hitRect.addEventListener("pointermove", on); hitRect.addEventListener("pointerleave", off);
      bar.addEventListener("focus", () => on()); bar.addEventListener("blur", off);
    }
    for (const mk of opts.markers || []) {
      s("line", { x1: x(mk.x), x2: x(mk.x), y1: m.top, y2: height - m.bottom, class: "ref" }, g);
      const right = x(mk.x) > width * 0.7;
      const tx = s("text", { x: x(mk.x) + (right ? -4 : 4), y: m.top + 10 + (mk.row || 0) * 13, "text-anchor": right ? "end" : "start", class: "ref-label" }, g);
      tx.textContent = mk.label;
    }
    if (opts.legend) legend(container, opts.legend, "box");
    addFoot(container, opts);
  }

  // ------------------------------------------------------------------ simple bar list (one series)
  function bars(container, opts) {
    const items = opts.items || [];
    const height = Math.max(80, items.length * 30 + 36);
    const { svg, width } = frame(container, height);
    const m = { top: 8, right: 56, bottom: 22, left: Math.min(220, Math.max(90, Math.max(...items.map((i) => i.label.length)) * 6.6)) };
    const vals = items.map((i) => i.value).filter((v) => v != null && isFinite(v));
    const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
    const x = linear(lo, hi === lo ? lo + 1 : hi, m.left, width - m.right);
    const g = s("g", null, svg);
    const vf = opts.format || ((v) => fmt.num(v));
    for (const t of niceTicks(lo, hi, 4)) {
      s("line", { x1: x(t), x2: x(t), y1: m.top, y2: height - m.bottom, class: t === 0 ? "baseline" : "gridline" }, g);
      const tx = s("text", { x: x(t), y: height - 6, "text-anchor": "middle", class: "tick" }, g);
      tx.textContent = vf(t);
    }
    items.forEach((it, i) => {
      const cy = m.top + i * 30 + 15;
      const lbl = s("text", { x: m.left - 10, y: cy + 4, "text-anchor": "end", class: "tick", style: "fill:var(--ink-2);font-size:12px" }, g);
      lbl.textContent = it.label;
      if (it.value == null || !isFinite(it.value)) return;
      const a = x(Math.min(0, it.value)), z = x(Math.max(0, it.value));
      const bh = 14, r = Math.min(4, (z - a) / 2);
      const pos = it.value >= 0;
      const top = cy - bh / 2, bot = cy + bh / 2;
      const d = pos
        ? `M${a},${top}H${z - r}Q${z},${top} ${z},${top + r}V${bot - r}Q${z},${bot} ${z - r},${bot}H${a}Z`
        : `M${z},${top}H${a + r}Q${a},${top} ${a},${top + r}V${bot - r}Q${a},${bot} ${a + r},${bot}H${z}Z`;
      s("path", { d, fill: it.color || "var(--series-1)" }, g);
      const tx = s("text", { x: pos ? z + 6 : a - 6, y: cy + 4, "text-anchor": pos ? "start" : "end", class: "end-label" }, g);
      tx.textContent = vf(it.value);
    });
    addFoot(container, opts);
  }

  // ------------------------------------------------------------------ heatmap (diverging around zero)
  function hex2rgb(hx) {
    const v = hx.replace("#", "");
    const n = parseInt(v.length === 3 ? v.split("").map((c) => c + c).join("") : v, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function mix(a, b, t) { return a.map((c, i) => Math.round(c + (b[i] - c) * t)); }
  function divergingColor(v, maxAbs) {
    const mid = hex2rgb(css("--div-mid")), pos = hex2rgb(css("--div-pos")), neg = hex2rgb(css("--div-neg"));
    if (v == null || !isFinite(v)) return "transparent";
    const t = Math.min(1, Math.abs(v) / (maxAbs || 1));
    const c = mix(mid, v >= 0 ? pos : neg, t);
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }
  function heatmap(container, opts) {
    const xs = opts.xs || [], ys = opts.ys || [], z = opts.z || [];
    const cell = Math.max(26, Math.min(56, Math.floor(((container.getBoundingClientRect().width || 600) - 90) / Math.max(1, xs.length))));
    const height = ys.length * cell + 60;
    const { svg, width } = frame(container, height);
    const m = { top: 10, left: 70, bottom: 46 };
    const g = s("g", null, svg);
    const vals = z.flat().filter((v) => v != null && isFinite(v));
    const maxAbs = opts.maxAbs || Math.max(0.01, ...vals.map(Math.abs));
    const vf = opts.format || ((v) => fmt.num(v));
    ys.forEach((yv, r) => {
      const ty = s("text", { x: m.left - 8, y: m.top + r * cell + cell / 2 + 4, "text-anchor": "end", class: "tick" }, g);
      ty.textContent = String(yv);
      xs.forEach((xv, c) => {
        const v = (z[r] || [])[c];
        const x0 = m.left + c * cell, y0 = m.top + r * cell;
        if (v == null) { s("rect", { x: x0 + 1, y: y0 + 1, width: cell - 2, height: cell - 2, rx: 3, fill: "none", stroke: "var(--grid)" }, g); return; }
        const rect = s("rect", { x: x0 + 1, y: y0 + 1, width: cell - 2, height: cell - 2, rx: 3, fill: divergingColor(v, maxAbs), tabindex: 0 }, g);
        const isSel = opts.highlight && opts.highlight.x === xv && opts.highlight.y === yv;
        if (isSel) s("rect", { x: x0 + 2.5, y: y0 + 2.5, width: cell - 5, height: cell - 5, rx: 3, fill: "none", stroke: "var(--ink)", "stroke-width": 2 }, g);
        const label = `${opts.xLabel} ${xv}, ${opts.yLabel} ${yv}`;
        const on = (ev) => { rect.setAttribute("opacity", "0.8"); const rr = rect.getBoundingClientRect(); showTip(ev?.clientX ?? rr.right, ev?.clientY ?? rr.top, label, [{ label: opts.valueLabel || "value", value: vf(v) }]); };
        const off = () => { rect.removeAttribute("opacity"); hideTip(); };
        rect.addEventListener("pointermove", on); rect.addEventListener("pointerleave", off);
        rect.addEventListener("focus", () => on()); rect.addEventListener("blur", off);
        if (opts.onClick) { rect.style.cursor = "pointer"; rect.addEventListener("click", () => opts.onClick(xv, yv)); rect.addEventListener("keydown", (e) => { if (e.key === "Enter") opts.onClick(xv, yv); }); }
      });
    });
    xs.forEach((xv, c) => {
      const tx = s("text", { x: m.left + c * cell + cell / 2, y: m.top + ys.length * cell + 16, "text-anchor": "middle", class: "tick" }, g);
      tx.textContent = String(xv);
    });
    const xl = s("text", { x: m.left + (xs.length * cell) / 2, y: m.top + ys.length * cell + 36, "text-anchor": "middle", class: "band-label" }, g);
    xl.textContent = opts.xLabel;
    const yl = s("text", { x: 12, y: m.top + (ys.length * cell) / 2, "text-anchor": "middle", class: "band-label", transform: `rotate(-90 12 ${m.top + (ys.length * cell) / 2})` }, g);
    yl.textContent = opts.yLabel;
    svg.setAttribute("viewBox", `0 0 ${Math.max(width, m.left + xs.length * cell + 10)} ${height}`);
    const neg = css("--div-neg"), mid = css("--div-mid"), pos = css("--div-pos");
    container.appendChild(h("div", { class: "scale-legend" }, h("span", { text: "−" + fmt.num(maxAbs) }),
      h("span", { class: "bar", style: `background:linear-gradient(90deg, ${neg}, ${mid}, ${pos})` }), h("span", { text: "+" + fmt.num(maxAbs) }),
      h("span", { text: opts.scaleNote || "" })));
    addFoot(container, opts);
  }

  // ------------------------------------------------------------------ scatter
  // points: [{x, y, id, label, highlight}]
  function scatter(container, opts) {
    const height = opts.height || 300;
    const { svg, width } = frame(container, height);
    const m = { top: 16, right: 18, bottom: 40, left: 50 };
    const pts = (opts.points || []).filter((p) => isFinite(p.x) && isFinite(p.y));
    if (!pts.length) return;
    const lo = Math.min(0, ...pts.map((p) => Math.min(p.x, p.y))), hi = Math.max(0, ...pts.map((p) => Math.max(p.x, p.y)));
    const pad = (hi - lo) * 0.08 || 0.1;
    const x = linear(lo - pad, hi + pad, m.left, width - m.right);
    const y = linear(lo - pad, hi + pad, height - m.bottom, m.top);
    const g = s("g", null, svg);
    for (const t of niceTicks(lo - pad, hi + pad, 5)) {
      s("line", { x1: m.left, x2: width - m.right, y1: y(t), y2: y(t), class: t === 0 ? "baseline" : "gridline" }, g);
      s("line", { x1: x(t), x2: x(t), y1: m.top, y2: height - m.bottom, class: t === 0 ? "baseline" : "gridline" }, g);
      const ty = s("text", { x: m.left - 8, y: y(t) + 4, "text-anchor": "end", class: "tick" }, g); ty.textContent = fmt.num(t, 1);
      const tx = s("text", { x: x(t), y: height - m.bottom + 16, "text-anchor": "middle", class: "tick" }, g); tx.textContent = fmt.num(t, 1);
    }
    if (opts.diagonal) {
      s("line", { x1: x(lo - pad), y1: y(lo - pad), x2: x(hi + pad), y2: y(hi + pad), class: "ref" }, g);
      const tl = s("text", { x: x(hi + pad) - 4, y: y(hi + pad) + 14, "text-anchor": "end", class: "ref-label" }, g);
      tl.textContent = opts.diagonalLabel || "y = x";
    }
    const xl = s("text", { x: (m.left + width - m.right) / 2, y: height - 6, "text-anchor": "middle", class: "band-label" }, g); xl.textContent = opts.xLabel;
    const yl = s("text", { x: 12, y: (m.top + height - m.bottom) / 2, "text-anchor": "middle", class: "band-label", transform: `rotate(-90 12 ${(m.top + height - m.bottom) / 2})` }, g); yl.textContent = opts.yLabel;
    const order = pts.slice().sort((a, b) => (a.highlight ? 1 : 0) - (b.highlight ? 1 : 0));
    for (const p of order) {
      const c = s("circle", { cx: x(p.x), cy: y(p.y), r: p.highlight ? 6 : 4.5, fill: p.highlight ? "var(--series-1)" : "var(--faint)", "fill-opacity": p.highlight ? 1 : 0.7, stroke: "var(--chart-surface)", "stroke-width": 2 }, g);
      const hitC = s("circle", { cx: x(p.x), cy: y(p.y), r: 12, fill: "transparent", tabindex: 0 }, g);
      const rows = [{ label: opts.xLabel, value: fmt.num(p.x) }, { label: opts.yLabel, value: fmt.num(p.y) }];
      const on = (ev) => { c.setAttribute("r", p.highlight ? 7 : 6); const rr = hitC.getBoundingClientRect(); showTip(ev?.clientX ?? rr.right, ev?.clientY ?? rr.top, p.label || p.id, rows); };
      const off = () => { c.setAttribute("r", p.highlight ? 6 : 4.5); hideTip(); };
      hitC.addEventListener("pointermove", on); hitC.addEventListener("pointerleave", off);
      hitC.addEventListener("focus", () => on()); hitC.addEventListener("blur", off);
      if (opts.onClick && p.id) { hitC.style.cursor = "pointer"; hitC.addEventListener("click", () => opts.onClick(p.id)); hitC.addEventListener("keydown", (e) => { if (e.key === "Enter") opts.onClick(p.id); }); }
      if (p.highlight && p.tag) {
        const flip = x(p.x) > width - 130;
        const tx = s("text", { x: x(p.x) + (flip ? -10 : 10), y: y(p.y) - 8, "text-anchor": flip ? "end" : "start", class: "end-label" }, g);
        tx.textContent = p.tag;
      }
    }
    addFoot(container, opts);
  }

  // ------------------------------------------------------------------ DAG (layered)
  // nodes: [{id, label, sub, kind, flag}], edges: [{from, to, label}]
  function dag(container, opts) {
    const nodes = opts.nodes || [], edges = opts.edges || [];
    const byId = Object.fromEntries(nodes.map((n) => [n.id, { ...n, layer: 0 }]));
    for (let pass = 0; pass < nodes.length; pass++) {
      let changed = false;
      for (const e of edges) {
        if (!byId[e.from] || !byId[e.to]) continue;
        const want = byId[e.from].layer + 1;
        if (byId[e.to].layer < want) { byId[e.to].layer = want; changed = true; }
      }
      if (!changed) break;
    }
    const layers = {};
    for (const n of Object.values(byId)) (layers[n.layer] = layers[n.layer] || []).push(n);
    const nLayers = Object.keys(layers).length;
    const nodeW = 236, nodeH = 46, gapX = 64, gapY = 14;
    const maxRows = Math.max(...Object.values(layers).map((l) => l.length));
    const width = nLayers * nodeW + (nLayers - 1) * gapX + 20, height = maxRows * (nodeH + gapY) + 20;
    container.replaceChildren();
    container.classList.add("dag");
    const svg = s("svg", { width, height, viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": opts.ariaLabel || "Data lineage graph" });
    container.appendChild(svg);
    const pos = {};
    Object.keys(layers).sort((a, b) => a - b).forEach((L) => {
      const col = layers[L].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.label.localeCompare(b.label));
      const offset = (height - col.length * (nodeH + gapY)) / 2;
      col.forEach((n, i) => { pos[n.id] = { x: 10 + L * (nodeW + gapX), y: offset + i * (nodeH + gapY) }; });
    });
    for (const e of edges) {
      const a = pos[e.from], b = pos[e.to];
      if (!a || !b) continue;
      const x1 = a.x + nodeW, y1 = a.y + nodeH / 2, x2 = b.x, y2 = b.y + nodeH / 2, mx = (x1 + x2) / 2;
      s("path", { d: `M${x1},${y1}C${mx},${y1} ${mx},${y2} ${x2 - 6},${y2}`, class: "edge", "marker-end": "url(#qros-arrow)" }, svg);
    }
    const defs = s("defs", null, svg);
    const mk = s("marker", { id: "qros-arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" }, defs);
    s("path", { d: "M0,0L10,5L0,10z", fill: "var(--axis)" }, mk);
    for (const n of Object.values(byId)) {
      const p = pos[n.id];
      const gN = s("g", { class: `node kind-${n.kind || "table"}${n.flag ? " flag-bad" : ""}`, transform: `translate(${p.x},${p.y})`, tabindex: 0, role: "button", "aria-label": `${n.label} ${n.sub || ""}` }, svg);
      s("rect", { width: nodeW, height: nodeH, rx: 8 }, gN);
      const t1 = s("text", { x: 10, y: 19 }, gN); t1.textContent = n.label.length > 30 ? n.label.slice(0, 29) + "…" : n.label;
      const sub = n.sub || "";
      const t2 = s("text", { x: 10, y: 35, class: "sub" }, gN); t2.textContent = sub.length > 34 ? sub.slice(0, 33) + "…" : sub;
      if (opts.onClick) { gN.style.cursor = "pointer"; gN.addEventListener("click", () => opts.onClick(n.id)); gN.addEventListener("keydown", (e) => { if (e.key === "Enter") opts.onClick(n.id); }); }
      if (n.tip) {
        gN.addEventListener("pointermove", (ev) => showTip(ev.clientX, ev.clientY, n.label, n.tip));
        gN.addEventListener("pointerleave", hideTip);
      }
    }
  }

  global.QC = { s, h, css, fmt, line, histogram, bars, heatmap, scatter, dag, showTip, hideTip, niceTicks };
})(window);
