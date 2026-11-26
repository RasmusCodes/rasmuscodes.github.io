/* Industrial Intelligence dashboard.
   Static page: reads data/index.json and data/<TICKER>.json (exported by `python -m indintel export-dashboard`)
   and draws everything client-side. All names from the data are inserted with textContent, never innerHTML. */
(() => {
  "use strict";

  const DATA = "data/";
  const SVGNS = "http://www.w3.org/2000/svg";
  const $ = (s, r = document) => r.querySelector(s);
  const state = { index: null, data: null, ticker: null, ind: null, lead: 0, h: 0, kinds: null, scen: {}, cache: {} };
  const MODEL_NAMES = {
    RW: "Random walk (last growth)", AR: "History only (AR)", Composite: "Indicator composite",
    BayesComp: "Indicators, partially pooled (Bayes)", MappedRidge: "Indicators, ridge", GBM: "Gradient boosting",
    BacklogAR: "Backlog growth", Conversion: "Backlog conversion", PriceCost: "Price-cost model",
  };
  const VINTAGE = {
    vintage: "Point-in-time vintages", filing: "Filing date", event: "Event date", lagged: "Revised data, lagged",
  };
  const SOURCE_NAMES = {
    alfred: "ALFRED / FRED", sec_panel: "SEC filings of customers", census_c30: "US Census Bureau", eia930: "EIA-930",
    eia861m: "EIA-861M", eia860m: "EIA-860M", comtrade: "UN Comtrade", indeed: "Indeed Hiring Lab",
    queues: "MISO, CAISO, NYISO queues", tdlr: "Texas TDLR TABS", ted: "EU TED",
  };

  // ------------------------------------------------------------------ helpers
  function el(tag, attrs, parent, text) {
    const e = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") e.className = v; else e.setAttribute(k, v === true ? "" : v);
    }
    if (text !== undefined && text !== null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }
  function sv(tag, attrs, parent) {
    const e = document.createElementNS(SVGNS, tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) e.setAttribute(k, v);
    if (parent) parent.appendChild(e);
    return e;
  }
  const fin = (v) => v !== null && v !== undefined && Number.isFinite(+v);
  const T = (d) => (d ? Date.parse(d + "T00:00:00Z") : NaN);
  const yr = (t) => new Date(t).getUTCFullYear();
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const monthLabel = (t) => { const d = new Date(t); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
  const qLabel = (t) => { const d = new Date(t); return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`; };
  const dateLabel = (s) => { if (!s) return "–"; const d = new Date(T(s)); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
  // growth values are log changes; show them as ordinary percentage growth
  const pctg = (g, d = 1) => (fin(g) ? `${Math.expm1(g) >= 0 ? "+" : "−"}${Math.abs(Math.expm1(g) * 100).toFixed(d)}%` : "–");
  const pct = (v, d = 1) => (fin(v) ? `${v >= 0 ? "" : "−"}${Math.abs(v).toFixed(d)}%` : "–");
  const pp = (v, d = 1) => (fin(v) ? `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)} pp` : "–");
  const num = (v, d = 2) => (fin(v) ? (+v).toFixed(d) : "–");
  function money(v) {
    if (!fin(v)) return "–";
    const a = Math.abs(v), s = v < 0 ? "−" : "";
    if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(a >= 1e11 ? 0 : a >= 1e10 ? 1 : 2)}bn`;
    if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(a >= 1e8 ? 0 : 1)}m`;
    return `${s}$${a.toFixed(0)}`;
  }
  // axis ticks: no trailing zeros ($5bn, $2.5bn, $500m); tooltips keep money()
  function moneyTick(v) {
    if (!fin(v)) return "–";
    const a = Math.abs(v), s = v < 0 ? "−" : "";
    if (a >= 1e9) return `${s}$${+(a / 1e9).toFixed(a >= 1e10 ? 0 : 1)}bn`;
    if (a >= 1e6) return `${s}$${+(a / 1e6).toFixed(0)}m`;
    return `${s}$${a.toFixed(0)}`;
  }
  // ordinary (not log) growth for plotting, and its label
  const sg = (g) => (fin(g) ? Math.expm1(g) : null);
  const pctS = (v, d = 1) => (fin(v) ? `${v >= 0 ? "+" : "−"}${Math.abs(v * 100).toFixed(d)}%` : "–");
  const pctAxis = (v) => `${Math.round(v * 100)}%`;
  // left margin that fits the widest tick label (11.5px Inter: about 6.9px per character)
  const marginFor = (labels, min = 36) => Math.max(min, Math.ceil(Math.max(...labels.map((s) => String(s).length)) * 6.9) + 12);

  // Draw a chart once its container has a real width, and again whenever that width changes
  // (layout settling, a neighbouring card appearing, rotation, the table view being closed).
  function draw(host, fn) {
    host._draw = fn;
    host._w = 0;
    const run = () => {
      const w = host.clientWidth;
      if (w < 60 || Math.abs(w - host._w) < 2) return;
      host._w = w;
      host._draw();
    };
    if (!host._ro && "ResizeObserver" in window) {
      host._ro = new ResizeObserver(run);
      host._ro.observe(host);
    }
    run();                      // immediately when layout is already known (also in background tabs)
    requestAnimationFrame(run); // and once more after layout settles
  }

  function compact(v) {
    if (!fin(v)) return "–";
    if (v === 0) return "0";
    const a = Math.abs(v), s = v < 0 ? "−" : "";
    if (a >= 1e9) return `${s}${(a / 1e9).toFixed(a >= 1e10 ? 0 : 1)}B`;
    if (a >= 1e6) return `${s}${(a / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
    if (a >= 1e4) return `${s}${(a / 1e3).toFixed(0)}K`;
    if (a >= 100) return `${s}${a.toFixed(0)}`;
    return `${s}${a.toFixed(a >= 10 ? 1 : 2)}`;
  }

  function niceTicks(lo, hi, n = 5) {
    if (!(hi > lo)) { hi = lo + 1; lo = lo - 1; }
    const span = hi - lo, raw = span / n, mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => span / s <= n) || 10 * mag;
    const a = Math.floor(lo / step) * step, b = Math.ceil(hi / step) * step;
    const ticks = [];
    for (let v = a; v <= b + step / 2; v += step) ticks.push(+v.toFixed(10));
    return { min: a, max: b, ticks };
  }

  // ------------------------------------------------------------------ tooltip
  const tip = () => $("#ii-tip");
  function showTip(x, y, head, rows) {
    const t = tip();
    t.textContent = "";
    if (head) el("p", { class: "ii-tip__head" }, t, head);
    for (const r of rows) {
      const row = el("div", { class: "ii-tip__row" }, t);
      const key = el("span", { class: r.shape === "rect" ? "ii-key ii-key--rect" : "ii-key" }, row);
      key.style.background = r.color ? `var(${r.color})` : "transparent";
      el("span", { class: "ii-tip__val" }, row, r.value);
      el("span", { class: "ii-tip__name" }, row, r.name);
    }
    t.hidden = false;
    const w = t.offsetWidth, h = t.offsetHeight;
    let left = x + 14, top = y + 14;
    if (left + w > window.innerWidth - 8) left = x - w - 14;
    if (top + h > window.innerHeight - 8) top = y - h - 14;
    t.style.left = `${Math.max(8, left)}px`;
    t.style.top = `${Math.max(8, top)}px`;
  }
  const hideTip = () => { tip().hidden = true; };

  // ------------------------------------------------------------------ card with table view
  function card(parent, title, sub, note) {
    const f = el("figure", { class: "ii-card" }, parent);
    const head = el("div", { class: "ii-card__head" }, f);
    const hd = el("div", null, head);
    el("h3", { class: "ii-card__title" }, hd, title);
    if (sub) el("p", { class: "ii-card__sub" }, hd, sub);
    const btn = el("button", { class: "ii-tbtn", type: "button", "aria-pressed": "false" }, head, "Table");
    const legend = el("ul", { class: "ii-legend", hidden: true }, f);
    const chart = el("div", { class: "ii-chart" }, f);
    const table = el("div", { class: "ii-tablewrap", hidden: true }, f);
    if (note) el("figcaption", { class: "ii-note" }, f, note);
    btn.addEventListener("click", () => {
      const on = btn.getAttribute("aria-pressed") !== "true";
      btn.setAttribute("aria-pressed", String(on));
      chart.hidden = on; table.hidden = !on;
    });
    return { f, chart, table, legend, btn };
  }
  function fillTable(host, head, rows, strongRow) {
    host.textContent = "";
    const t = el("table", { class: "ii-table" }, host);
    const tr = el("tr", null, el("thead", null, t));
    head.forEach((h, i) => el("th", { class: i === 0 || h.startsWith("~") ? "l" : null, scope: "col" }, tr, h.replace(/^~/, "")));
    const tb = el("tbody", null, t);
    rows.forEach((r, k) => {
      const row = el("tr", { class: strongRow && strongRow(r, k) ? "is-strong" : null }, tb);
      r.forEach((c, i) => el("td", { class: i === 0 || (head[i] || "").startsWith("~") ? "l" : null }, row, c));
    });
  }
  function fillLegend(ul, items) {
    ul.textContent = "";
    if (items.length < 2) { ul.hidden = true; return; }
    ul.hidden = false;
    for (const it of items) {
      const li = el("li", null, ul);
      const k = el("span", { class: it.shape === "rect" ? "ii-key ii-key--rect" : it.shape === "dot" ? "ii-key ii-key--dot" : "ii-key" }, li);
      k.style.background = `var(${it.color})`;
      el("span", null, li, it.name);
    }
  }

  // ------------------------------------------------------------------ line chart (time x, one y axis)
  function lineChart(host, cfg) {
    host.textContent = "";
    const W = Math.max(300, Math.round(host.clientWidth || 640)), H = cfg.height || 250;
    const m = { l: 50, r: cfg.right || 16, t: 10, b: 26 };
    const series = cfg.series.filter((s) => s.points && s.points.some((p) => fin(p[1])));
    const xsAll = new Set();
    let ymin = Infinity, ymax = -Infinity;
    for (const s of series) {
      for (const [t, v] of s.points) { if (fin(v)) { xsAll.add(t); ymin = Math.min(ymin, v); ymax = Math.max(ymax, v); } }
      for (const [t, lo, hi] of s.band || []) { if (fin(lo) && fin(hi)) { xsAll.add(t); ymin = Math.min(ymin, lo); ymax = Math.max(ymax, hi); } }
    }
    if (!xsAll.size) { el("p", { class: "ii-empty" }, host, cfg.empty || "No data for this chart."); return; }
    if (cfg.zero) { ymin = Math.min(ymin, 0); ymax = Math.max(ymax, 0); }
    if (cfg.ymin !== undefined) ymin = Math.max(ymin, cfg.ymin);
    const xs = [...xsAll].sort((a, b) => a - b);
    let x0 = xs[0], x1 = xs[xs.length - 1];
    if (x1 === x0) { x0 -= 864e5 * 90; x1 += 864e5 * 90; }
    const yt = niceTicks(ymin, ymax, H < 220 ? 4 : 5);
    m.l = marginFor(yt.ticks.map((v) => (cfg.yfmt ? cfg.yfmt(v) : compact(v))));
    const sx = (t) => m.l + ((t - x0) / (x1 - x0)) * (W - m.l - m.r);
    const sy = (v) => m.t + (1 - (v - yt.min) / (yt.max - yt.min)) * (H - m.t - m.b);
    const svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": cfg.label || "", tabindex: "0" }, host);
    const g = sv("g", { class: "grid" }, svg);
    for (const v of yt.ticks) {
      sv("line", { x1: m.l, x2: W - m.r, y1: sy(v), y2: sy(v) }, g);
      const tx = sv("text", { x: m.l - 8, y: sy(v) + 4, "text-anchor": "end", class: "tick" }, svg);
      tx.textContent = cfg.yfmt ? cfg.yfmt(v) : compact(v);
      tx.setAttribute("class", "tick");
    }
    if (yt.min < 0 && yt.max > 0) sv("line", { x1: m.l, x2: W - m.r, y1: sy(0), y2: sy(0), class: "baseline" }, svg);
    else sv("line", { x1: m.l, x2: W - m.r, y1: sy(yt.min), y2: sy(yt.min), class: "baseline" }, svg);
    // x ticks: years
    const y0 = yr(x0), y1 = yr(x1), span = y1 - y0 + 1;
    const every = Math.max(1, Math.ceil(span / Math.max(2, Math.floor((W - m.l - m.r) / 70))));
    for (let y = y0; y <= y1 + 1; y++) {
      const t = Date.UTC(y, 0, 1);
      if (t < x0 || t > x1 || (y - y0) % every) continue;
      const tx = sv("text", { x: sx(t), y: H - 8, "text-anchor": "middle", class: "tick" }, svg);
      tx.textContent = String(y);
      tx.setAttribute("class", "tick");
      sv("line", { x1: sx(t), x2: sx(t), y1: sy(yt.min), y2: sy(yt.min) + 4, class: "baseline" }, svg);
    }
    // bands, then lines, then markers
    for (const s of series) {
      const b = (s.band || []).filter((r) => fin(r[1]) && fin(r[2])).sort((a, c) => a[0] - c[0]);
      if (b.length > 1) {
        const top = b.map((r) => `${sx(r[0])},${sy(r[2])}`), bot = b.slice().reverse().map((r) => `${sx(r[0])},${sy(r[1])}`);
        sv("path", { d: `M${top.join("L")}L${bot.join("L")}Z`, fill: `var(${s.color})`, "fill-opacity": "0.12", stroke: "none" }, svg);
      } else if (b.length === 1) {
        const r = b[0];
        sv("line", { x1: sx(r[0]), x2: sx(r[0]), y1: sy(r[1]), y2: sy(r[2]), stroke: `var(${s.color})`, "stroke-width": 2, "stroke-opacity": 0.45, "stroke-linecap": "round" }, svg);
      }
    }
    for (const s of series) {
      const pts = s.points.filter((p) => fin(p[1])).sort((a, c) => a[0] - c[0]);
      if (s.whiskers) for (const [t, lo, hi] of s.whiskers) {
        if (fin(lo) && fin(hi)) sv("line", { x1: sx(t), x2: sx(t), y1: sy(lo), y2: sy(hi), stroke: `var(${s.color})`, "stroke-width": 2, "stroke-opacity": 0.5, "stroke-linecap": "round" }, svg);
      }
      if (!s.markersOnly && pts.length > 1) {
        // break the line across gaps longer than ~2 quarters
        let d = "", prev = null;
        for (const p of pts) {
          d += (prev === null || p[0] - prev > 864e5 * 200 ? "M" : "L") + `${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`;
          prev = p[0];
        }
        sv("path", { d, fill: "none", stroke: `var(${s.color})`, "stroke-width": s.width || 2, "stroke-linejoin": "round", "stroke-linecap": "round", "stroke-dasharray": s.dashed ? "5 4" : null }, svg);
      }
      if (s.markers || s.markersOnly || pts.length === 1) {
        for (const p of pts) sv("circle", { cx: sx(p[0]), cy: sy(p[1]), r: 4.5, fill: `var(${s.color})`, stroke: "var(--surface)", "stroke-width": 2 }, svg);
      }
    }
    // end label for the first series when asked
    if (cfg.endLabel) {
      const s = series[0], pts = s.points.filter((p) => fin(p[1]));
      if (pts.length) {
        const p = pts[pts.length - 1];
        const tx = sv("text", { x: Math.min(sx(p[0]) + 6, W - 2), y: sy(p[1]) - 8, "text-anchor": "end", class: "dlabel" }, svg);
        tx.textContent = cfg.endLabel(p[1]);
      }
    }
    // crosshair + tooltip
    const xh = sv("line", { class: "xhair", y1: m.t, y2: H - m.b, visibility: "hidden" }, svg);
    const hit = sv("rect", { x: m.l, y: 0, width: W - m.l - m.r, height: H - m.b, fill: "transparent" }, svg);
    let idx = -1;
    const tol = (cfg.tolDays || 0) * 864e5;
    const valueAt = (s, t) => {
      let best = null, bd = Infinity;
      for (const q of s.points) {
        const dd = Math.abs(q[0] - t);
        if (dd <= tol && dd < bd && fin(q[1])) { bd = dd; best = q; }
      }
      return best ? best[1] : null;
    };
    function show(i, cx, cy) {
      idx = Math.max(0, Math.min(xs.length - 1, i));
      const t = xs[idx];
      xh.setAttribute("x1", sx(t)); xh.setAttribute("x2", sx(t)); xh.setAttribute("visibility", "visible");
      const rows = [];
      for (const s of series) {
        const v = valueAt(s, t);
        if (v !== null) rows.push({ color: s.color, value: (s.fmt || cfg.tipfmt || cfg.yfmt || compact)(v), name: s.name });
        const band = (s.band || []).find((r) => r[0] === t);
        if (band && fin(band[1])) rows.push({ color: null, value: `${(cfg.tipfmt || cfg.yfmt)(band[1])} to ${(cfg.tipfmt || cfg.yfmt)(band[2])}`, name: s.bandName || "80% interval" });
      }
      const box = svg.getBoundingClientRect();
      const px = cx !== undefined ? cx : box.left + (sx(t) / W) * box.width;
      const py = cy !== undefined ? cy : box.top + box.height / 3;
      showTip(px, py, (cfg.xfmt || monthLabel)(t), rows);
    }
    hit.addEventListener("pointermove", (ev) => {
      const box = svg.getBoundingClientRect();
      const x = ((ev.clientX - box.left) / box.width) * W;
      let best = 0, bd = Infinity;
      xs.forEach((t, i) => { const d = Math.abs(sx(t) - x); if (d < bd) { bd = d; best = i; } });
      show(best, ev.clientX, ev.clientY);
    });
    hit.addEventListener("pointerleave", () => { xh.setAttribute("visibility", "hidden"); hideTip(); });
    svg.addEventListener("keydown", (ev) => {
      if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") {
        ev.preventDefault();
        show(idx < 0 ? xs.length - 1 : idx + (ev.key === "ArrowRight" ? 1 : -1));
      } else if (ev.key === "Escape") { xh.setAttribute("visibility", "hidden"); hideTip(); }
    });
    svg.addEventListener("blur", () => { xh.setAttribute("visibility", "hidden"); hideTip(); });
  }

  // ------------------------------------------------------------------ stacked columns (quarters x segments)
  function stackedColumns(host, cfg) {
    host.textContent = "";
    const W = Math.max(300, Math.round(host.clientWidth || 640)), H = cfg.height || 260;
    const m = { l: 50, r: 12, t: 10, b: 26 };
    const n = cfg.cats.length;
    if (!n) { el("p", { class: "ii-empty" }, host, "No segment data."); return; }
    const totals = cfg.cats.map((_, i) => cfg.series.reduce((a, s) => a + (fin(s.values[i]) && s.values[i] > 0 ? s.values[i] : 0), 0));
    const yt = niceTicks(0, Math.max(...totals), 5);
    m.l = marginFor(yt.ticks.map((v) => (cfg.yfmt ? cfg.yfmt(v) : compact(v))));
    const band = (W - m.l - m.r) / n, bw = Math.max(2, Math.min(24, band * 0.72));
    const sx = (i) => m.l + band * (i + 0.5);
    const sy = (v) => m.t + (1 - v / yt.max) * (H - m.t - m.b);
    const svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": cfg.label || "" }, host);
    const g = sv("g", { class: "grid" }, svg);
    for (const v of yt.ticks) {
      sv("line", { x1: m.l, x2: W - m.r, y1: sy(v), y2: sy(v) }, g);
      const tx = sv("text", { x: m.l - 8, y: sy(v) + 4, "text-anchor": "end", class: "tick" }, svg);
      tx.textContent = cfg.yfmt ? cfg.yfmt(v) : compact(v);
    }
    sv("line", { x1: m.l, x2: W - m.r, y1: sy(0), y2: sy(0), class: "baseline" }, svg);
    const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((W - m.l - m.r) / 64))));
    let lastYear = null;
    cfg.cats.forEach((t, i) => {
      const y = yr(t);
      if (y !== lastYear && (y % every === 0 || every === 1)) {
        const tx = sv("text", { x: sx(i), y: H - 8, "text-anchor": "middle", class: "tick" }, svg);
        tx.textContent = String(y);
      }
      lastYear = y;
    });
    const GAP = 2, R = 4;
    cfg.cats.forEach((t, i) => {
      let cum = 0;
      const segs = cfg.series.map((s) => ({ s, v: s.values[i] })).filter((o) => fin(o.v) && o.v > 0);
      segs.forEach((o, k) => {
        const yTop = sy(cum + o.v), yBot = sy(cum);
        cum += o.v;
        const top = k === segs.length - 1;
        const hgt = Math.max(0, yBot - yTop - (k > 0 ? GAP : 0));
        if (hgt <= 0) return;
        const x = sx(i) - bw / 2, y = yTop;
        const yb = y + hgt;
        const r = top ? Math.min(R, hgt, bw / 2) : 0;
        const d = r > 0
          ? `M${x},${yb}V${y + r}Q${x},${y} ${x + r},${y}H${x + bw - r}Q${x + bw},${y} ${x + bw},${y + r}V${yb}Z`
          : `M${x},${yb}V${y}H${x + bw}V${yb}Z`;
        const p = sv("path", { d, fill: `var(${o.s.color})`, tabindex: "-1" }, svg);
        const hitp = sv("rect", { x: sx(i) - band / 2, y: y - 1, width: band, height: hgt + 2, fill: "transparent" }, svg);
        const on = (ev) => {
          p.classList.add("mark-hover");
          showTip(ev.clientX, ev.clientY, cfg.catfmt ? cfg.catfmt(t) : qLabel(t), [
            { color: o.s.color, shape: "rect", value: (cfg.tipfmt || cfg.yfmt || compact)(o.v), name: o.s.name },
            { color: null, value: `${((o.v / totals[i]) * 100).toFixed(0)}%`, name: "share of quarter" }]);
        };
        hitp.addEventListener("pointermove", on);
        hitp.addEventListener("pointerleave", () => { p.classList.remove("mark-hover"); hideTip(); });
      });
    });
  }

  // ------------------------------------------------------------------ grouped columns (categorical x, may be negative)
  function columns(host, cfg) {
    host.textContent = "";
    const W = Math.max(280, Math.round(host.clientWidth || 520)), H = cfg.height || 200;
    const m = { l: 44, r: 10, t: 10, b: 28 };
    const n = cfg.cats.length, k = cfg.series.length;
    let lo = 0, hi = 0;
    cfg.series.forEach((s) => s.values.forEach((v) => { if (fin(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }));
    if (cfg.domain) { lo = Math.min(lo, cfg.domain[0]); hi = Math.max(hi, cfg.domain[1]); }
    const yt = niceTicks(lo, hi, 4);
    m.l = marginFor(yt.ticks.map((v) => (cfg.yfmt ? cfg.yfmt(v) : num(v, 1))), 30);
    const band = (W - m.l - m.r) / n;
    const bw = Math.max(3, Math.min(24, (band * 0.8) / k - 2));
    const sy = (v) => m.t + (1 - (v - yt.min) / (yt.max - yt.min)) * (H - m.t - m.b);
    const svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": cfg.label || "" }, host);
    const g = sv("g", { class: "grid" }, svg);
    for (const v of yt.ticks) {
      sv("line", { x1: m.l, x2: W - m.r, y1: sy(v), y2: sy(v) }, g);
      const tx = sv("text", { x: m.l - 8, y: sy(v) + 4, "text-anchor": "end", class: "tick" }, svg);
      tx.textContent = cfg.yfmt ? cfg.yfmt(v) : num(v, 1);
    }
    sv("line", { x1: m.l, x2: W - m.r, y1: sy(0), y2: sy(0), class: "baseline" }, svg);
    cfg.cats.forEach((c, i) => {
      const cx = m.l + band * (i + 0.5);
      const tx = sv("text", { x: cx, y: H - 9, "text-anchor": "middle", class: "tick" }, svg);
      tx.textContent = c;
      cfg.series.forEach((s, j) => {
        const v = s.values[i];
        if (!fin(v)) return;
        const x = cx - (k * (bw + 2)) / 2 + j * (bw + 2) + 1;
        const y0 = sy(0), y1 = sy(v), top = Math.min(y0, y1), h = Math.max(1, Math.abs(y1 - y0));
        const r = Math.min(4, h, bw / 2);
        const d = v >= 0
          ? `M${x},${y0}V${top + r}Q${x},${top} ${x + r},${top}H${x + bw - r}Q${x + bw},${top} ${x + bw},${top + r}V${y0}Z`
          : `M${x},${y0}V${y1 - r}Q${x},${y1} ${x + r},${y1}H${x + bw - r}Q${x + bw},${y1} ${x + bw},${y1 - r}V${y0}Z`;
        const p = sv("path", { d, fill: `var(${s.color})` }, svg);
        const hit = sv("rect", { x: x - 1, y: Math.min(top, y0) - 4, width: bw + 2, height: h + 8, fill: "transparent" }, svg);
        hit.addEventListener("pointermove", (ev) => {
          p.classList.add("mark-hover");
          showTip(ev.clientX, ev.clientY, cfg.tiphead ? cfg.tiphead(c) : c, [{ color: s.color, shape: "rect", value: (cfg.yfmt || num)(v), name: s.name }]);
        });
        hit.addEventListener("pointerleave", () => { p.classList.remove("mark-hover"); hideTip(); });
      });
    });
  }

  // ------------------------------------------------------------------ horizontal bars (one series)
  function hbars(host, cfg) {
    host.textContent = "";
    const W = Math.max(280, Math.round(host.clientWidth || 520));
    const longest = Math.max(...cfg.items.map((d) => String(d.label).length));
    const rowH = 30, m = { l: Math.min(W * 0.55, Math.ceil(longest * 7.1) + 16), r: 56, t: 6, b: 22 };
    const H = m.t + m.b + rowH * cfg.items.length;
    const vals = cfg.items.map((d) => d.value).filter(fin);
    const yt = niceTicks(Math.min(0, ...vals), Math.max(cfg.ref || 0, ...vals), 4);
    const sx = (v) => m.l + ((v - yt.min) / (yt.max - yt.min)) * (W - m.l - m.r);
    const svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": cfg.label || "" }, host);
    const g = sv("g", { class: "grid" }, svg);
    for (const v of yt.ticks) {
      sv("line", { x1: sx(v), x2: sx(v), y1: m.t, y2: H - m.b }, g);
      const tx = sv("text", { x: sx(v), y: H - 6, "text-anchor": "middle", class: "tick" }, svg);
      tx.textContent = cfg.xfmt ? cfg.xfmt(v) : num(v, 1);
    }
    if (cfg.ref !== undefined) sv("line", { x1: sx(cfg.ref), x2: sx(cfg.ref), y1: m.t, y2: H - m.b, class: "baseline" }, svg);
    cfg.items.forEach((d, i) => {
      const cy = m.t + rowH * (i + 0.5);
      const lab = sv("text", { x: m.l - 8, y: cy + 4, "text-anchor": "end", class: "tick" }, svg);
      lab.textContent = d.label;
      if (!fin(d.value)) return;
      const x0 = sx(Math.max(0, yt.min)), x1 = sx(d.value), bh = 14, y = cy - bh / 2;
      const left = Math.min(x0, x1), w = Math.max(1, Math.abs(x1 - x0)), r = Math.min(4, w);
      const dpath = d.value >= 0
        ? `M${left},${y}H${left + w - r}Q${left + w},${y} ${left + w},${y + r}V${y + bh - r}Q${left + w},${y + bh} ${left + w - r},${y + bh}H${left}Z`
        : `M${left + w},${y}H${left + r}Q${left},${y} ${left},${y + r}V${y + bh - r}Q${left},${y + bh} ${left + r},${y + bh}H${left + w}Z`;
      sv("path", { d: dpath, fill: `var(${d.color || "--s1"})` }, svg);
      const vt = sv("text", { x: Math.max(x1, x0) + 6, y: cy + 4, class: "dlabel" }, svg);
      vt.textContent = cfg.xfmt ? cfg.xfmt(d.value) : num(d.value, 2);
    });
  }

  // ------------------------------------------------------------------ data loading
  async function getJSON(name) {
    if (state.cache[name]) return state.cache[name];
    const r = await fetch(DATA + name, { cache: "no-cache" });
    if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
    const js = await r.json();
    state.cache[name] = js;
    return js;
  }
  const fileOf = (tk) => `${tk.replace(".", "_")}.json`;

  async function init() {
    try {
      state.index = await getJSON("index.json");
    } catch (e) {
      $("#ii-meta").textContent = "The data bundle could not be loaded.";
      return;
    }
    const idx = state.index;
    const nMod = idx.companies.filter((c) => c.kind === "modelled").length;
    const withData = idx.indicators.filter((i) => i.has_data);
    const nInd = withData.length;
    const nSrc = new Set(withData.map((i) => i.source)).size;
    const meta = idx.meta || {};
    $("#ii-meta").textContent = `Data as of ${dateLabel(idx.generated)}. ${nMod} companies modelled from SEC filings, ${idx.companies.length - nMod} more mapped; ${nInd} operational indicators from ${nSrc} public sources. Walk-forward tests from ${meta.eval_start ? yr(T(meta.eval_start)) : 2016}, holdout from ${meta.holdout_start ? yr(T(meta.holdout_start)) : 2021}.`;
    const sectors = new Map([["dc", "Data center infrastructure"], ["grid", "Electrical equipment and grid"], ["power", "Power generation"],
      ["machinery", "Heavy machinery"], ["construction", "Construction and engineering"], ["semicap", "Semiconductor equipment"], ["automation", "Industrial automation"]]);
    const sel = $("#ii-sector");
    for (const [k, v] of sectors) el("option", { value: k }, sel, v);
    sel.addEventListener("change", () => { fillCompanies(); const first = $("#ii-company").value; if (first && first !== state.ticker) load(first); });
    $("#ii-company").addEventListener("change", (e) => load(e.target.value));
    document.querySelectorAll("#err-h button").forEach((b) => b.addEventListener("click", () => {
      state.h = +b.dataset.h;
      document.querySelectorAll("#err-h button").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
      renderErrors();
    }));
    renderResearch();
    renderSources();
    fillCompanies();
    const want = decodeURIComponent((location.hash || "").slice(1)).toUpperCase();
    const start = idx.companies.find((c) => c.ticker.toUpperCase() === want) ? want : "VRT";
    await load(idx.companies.find((c) => c.ticker.toUpperCase() === start).ticker);
    let rt;
    void rt;   // charts redraw themselves on resize (see draw())
    window.addEventListener("hashchange", () => {
      const tk = decodeURIComponent(location.hash.slice(1)).toUpperCase();
      const c = state.index.companies.find((x) => x.ticker.toUpperCase() === tk);
      if (c && c.ticker !== state.ticker) load(c.ticker);
    });
  }

  function fillCompanies() {
    const sec = $("#ii-sector").value;
    const s = $("#ii-company");
    s.textContent = "";
    const groups = [["modelled", "Modelled (quarterly SEC data)"], ["annual", "Annual SEC data only"], ["mapping", "Mapped only (not SEC registrants)"]];
    for (const [kind, label] of groups) {
      const list = state.index.companies.filter((c) => c.kind === kind && (!sec || c.sectors.includes(sec)));
      if (!list.length) continue;
      const og = el("optgroup", { label }, s);
      for (const c of list) el("option", { value: c.ticker }, og, `${c.name} (${c.ticker})`);
    }
    if (state.ticker && [...s.options].some((o) => o.value === state.ticker)) s.value = state.ticker;
  }

  async function load(tk) {
    document.querySelector(".ii").classList.add("is-loading");
    try {
      state.data = await getJSON(fileOf(tk));
    } catch (e) {
      document.querySelector(".ii").classList.remove("is-loading");
      return;
    }
    state.ticker = tk;
    state.ind = null;
    state.lead = 0;
    state.kinds = null;
    state.scen = {};
    if (decodeURIComponent(location.hash.slice(1)) !== tk) history.replaceState(null, "", `#${tk}`);
    const s = $("#ii-company");
    if ([...s.options].some((o) => o.value === tk)) s.value = tk;
    renderCompany();
    document.querySelector(".ii").classList.remove("is-loading");
  }

  function renderCompany() {
    if (!state.data) return;
    renderOverview();
    renderSegments();
    renderIndicators();
    renderForecast();
    renderErrors();
    renderTimeline();
  }

  // ------------------------------------------------------------------ overview
  function renderOverview() {
    const d = state.data;
    const p = d.profile || {};
    $("#h-overview").textContent = `${d.name} (${d.ticker})`;
    const kind = d.mapping_only ? "Not an SEC registrant: mapped to indicators, no automated financials."
      : d.annual_only ? "Files annually with the SEC (Form 20-F); no quarterly XBRL, so it is mapped but not modelled."
        : "Quarterly financials from SEC XBRL filings, first-reported and revised values kept separately.";
    $("#ov-sub").textContent = kind;
    const tiles = $("#ov-tiles");
    tiles.textContent = "";
    const fin_ = (d.financials || []).filter((r) => fin(r.rev));
    const tile = (label, value, delta) => {
      const t = el("div", { class: "ii-tile" }, tiles);
      el("p", { class: "ii-tile__label" }, t, label);
      el("p", { class: "ii-tile__value" }, t, value);
      if (delta) el("p", { class: "ii-tile__delta" }, t, delta);
    };
    if (fin_.length) {
      const last = fin_[fin_.length - 1];
      const ya = fin_.find((r) => Math.abs(T(r.q) - (T(last.q) - 365 * 864e5)) < 25 * 864e5);
      tile(`Revenue, quarter to ${monthLabel(T(last.q))}`, money(last.rev), ya ? `${pctg(Math.log(last.rev / ya.rev))} year over year` : null);
      const gm = fin_.filter((r) => fin(r.gm)).slice(-1)[0];
      if (gm) {
        const gya = fin_.find((r) => fin(r.gm) && Math.abs(T(r.q) - (T(gm.q) - 365 * 864e5)) < 25 * 864e5);
        tile("Gross margin", pct(gm.gm), gya ? `${pp(gm.gm - gya.gm)} vs a year earlier` : null);
      }
      const rpo = fin_.filter((r) => fin(r.rpo)).slice(-1)[0];
      if (rpo) tile("Remaining performance obligations", money(rpo.rpo), `at ${monthLabel(T(rpo.q))}`);
    }
    const fc = d.forecast && d.forecast.quarters && d.forecast.quarters[0];
    if (fc && fin(fc.yhat_bayes)) {
      tile(`Model forecast, quarter to ${monthLabel(T(fc.period_end))}`, pctg(fc.yhat_bayes), `revenue growth; 80% range ${pctg(fc.lo, 0)} to ${pctg(fc.hi, 0)}`);
    }
    if (d.annual_only && d.annual) {
      const rev = d.annual.filter((r) => r.item === "revenue").sort((a, b) => T(a.year_end) - T(b.year_end));
      if (rev.length) tile(`Revenue, year to ${monthLabel(T(rev[rev.length - 1].year_end))}`, money(rev[rev.length - 1].value));
    }
    const host = $("#ov-profile");
    host.textContent = "";
    if (p.description) el("p", { class: "ii-desc" }, host, p.description);
    if (d.mapping_only) {
      el("p", { class: "ii-callout" }, host, "Siemens Energy and Schneider Electric publish their accounts in Europe, not with the SEC, so the pipeline has no point-in-time financials for them. The indicators linked to them are shown below for context; nothing here is a forecast of their results.");
    }
    const grid = el("div", { class: "ii-profile" }, host);
    if (p.segments && p.segments.length) {
      const c = el("div", { class: "ii-pcard" }, grid);
      el("h3", null, c, "Segments");
      const ul = el("ul", { class: "ii-seglist" }, c);
      for (const s of p.segments) {
        const li = el("li", null, ul);
        el("strong", null, li, s.name);
        li.appendChild(document.createTextNode(`: ${s.sells}${s.end_markets ? `. Demand: ${s.end_markets}` : ""}`));
      }
    }
    const fields = [["geography", "Geographic exposure"], ["customers", "Customers"], ["backlog", "Order backlog"],
      ["pricing", "Pricing"], ["margin_drivers", "Margin drivers"]];
    for (const [k, title] of fields) {
      const b = p[k];
      if (!b) continue;
      const c = el("div", { class: "ii-pcard" }, grid);
      el("h3", null, c, title);
      el("p", null, c, b.summary || "");
      const extra = [];
      if (k === "customers" && b.concentration) extra.push(`Concentration: ${b.concentration}`);
      if (k === "backlog" && b.latest) extra.push(`Latest: ${b.latest}`);
      if (k === "backlog" && b.horizon) extra.push(`Within 12 months: ${b.horizon}`);
      for (const x of extra) el("p", { class: "ii-source" }, c, x);
      if (b.evidence && b.evidence.length) {
        const det = el("details", null, c);
        el("summary", null, det, `Filing text (${b.evidence.length} quotes)`);
        for (const e of b.evidence) el("blockquote", null, det, e.quote);
      }
    }
    if (d.profile_source) {
      const ps = d.profile_source;
      const pr = el("p", { class: "ii-source" }, host);
      pr.appendChild(document.createTextNode(`Profile text quotes the company's ${ps.form} filed ${dateLabel(ps.filed)} `));
      el("a", { href: ps.url, rel: "noopener" }, pr, "(SEC EDGAR)");
      pr.appendChild(document.createTextNode("; every quote is checked against the filing by the pipeline's tests."));
    }
  }

  // ------------------------------------------------------------------ segments
  function renderSegments() {
    const d = state.data, host = $("#seg-body");
    host.textContent = "";
    if (!d.segments) {
      const msg = d.mapping_only ? "No SEC segment data for this company."
        : d.annual_only ? "ABB's segment data are annual (Form 20-F) and not shown here."
          : "The company reports a single segment, or tags segment revenue in a way the pipeline does not read.";
      el("p", { class: "ii-empty" }, host, msg);
      return;
    }
    const rows = d.segments.rows.filter((r) => T(r.q) >= Date.UTC(2015, 0, 1));
    let names = d.segments.names;
    const recent = rows.slice(-8);
    const active = names.filter((n) => recent.some((r) => fin(r.v[n])));
    const old = names.filter((n) => !active.includes(n));
    names = active.slice(0, 7);
    const foldIn = active.slice(7);
    const colors = ["--s1", "--s2", "--s3", "--s4", "--s5", "--s6", "--s7"];
    const series = names.map((n, i) => ({ name: n, color: colors[i], values: rows.map((r) => r.v[n]) }));
    if (foldIn.length || old.length) {
      const vals = rows.map((r) => [...foldIn, ...old].reduce((a, n) => a + (fin(r.v[n]) ? r.v[n] : 0), 0));
      if (vals.some((v) => v > 0)) series.push({ name: old.length ? "Earlier or other segments" : "Other", color: "--other", values: vals });
    }
    const c = card(host, "Revenue by segment, quarterly", "Latest reported values (restated history where the company recast it).",
      old.length ? `Segments renamed or retired over time appear as "Earlier or other segments": ${old.join(", ")}.` : null);
    fillLegend(c.legend, series.map((s) => ({ name: s.name, color: s.color, shape: "rect" })));
    draw(c.chart, () => stackedColumns(c.chart, { cats: rows.map((r) => T(r.q)), series, yfmt: moneyTick, tipfmt: money, label: `Quarterly revenue by segment, ${d.name}` }));
    fillTable(c.table, ["Quarter end", ...series.map((s) => s.name)],
      rows.slice().reverse().map((r, i) => [monthLabel(T(r.q)), ...series.map((s) => money(s.values[rows.length - 1 - i]))]));
  }

  // ------------------------------------------------------------------ indicators
  function renderIndicators() {
    const d = state.data, list = $("#ind-list");
    list.textContent = "";
    const inds = d.indicators || [];
    if (!inds.length) { el("p", { class: "ii-empty" }, list, "No indicators mapped."); $("#ind-detail").textContent = ""; return; }
    if (!state.ind || !inds.some((i) => i.id === state.ind)) {
      const withData = inds.filter((i) => i.role === "demand" && i.quarterly.length);
      state.ind = (withData[0] || inds[0]).id;
    }
    for (const i of inds) {
      const b = el("button", { class: "ii-ind", type: "button", role: "option", "aria-selected": String(i.id === state.ind) }, list);
      el("span", { class: "ii-ind__name" }, b, i.name);
      const meta = el("span", { class: "ii-ind__meta" }, b);
      meta.appendChild(document.createTextNode(`${i.role === "demand" ? "Demand" : i.role === "pricing" ? "Pricing" : "Cost"} · ${i.segment === "total" ? "whole company" : i.segment} · `));
      el("span", { class: `ii-badge ii-badge--${i.vintage_kind}` }, meta, VINTAGE[i.vintage_kind] || i.vintage_kind);
      if (!i.quarterly.length) meta.appendChild(document.createTextNode(" · no data"));
      b.addEventListener("click", () => { state.ind = i.id; state.lead = 0; renderIndicators(); });
    }
    renderIndicatorDetail();
  }

  function renderIndicatorDetail() {
    const d = state.data, host = $("#ind-detail");
    host.textContent = "";
    const i = (d.indicators || []).find((x) => x.id === state.ind);
    if (!i) return;
    const src = SOURCE_NAMES[i.source] || i.source;
    const lagTxt = i.vintage_kind === "lagged" ? ` Only revised history exists; values are assumed public ${i.pub_lag_days} days after the month ends.` : "";
    const why = el("p", { class: "ii-callout" }, host);
    el("strong", null, why, "Why it is linked: ");
    why.appendChild(document.createTextNode(`${i.why} Expected timing: ${i.lead}. Source: ${src} (${VINTAGE[i.vintage_kind] || i.vintage_kind}).${lagTxt}`));
    // overlay chart: company revenue growth vs indicator growth shifted by the lead slider
    const rev = (d.financials || []).filter((r) => fin(r.rev_first)).map((r) => [T(r.q), r.rev_first]);
    const revG = [];
    for (const [t, v] of rev) {
      const ya = rev.find(([t2]) => Math.abs(t2 - (t - 365 * 864e5)) < 25 * 864e5);
      if (ya && ya[1] > 0 && v > 0) revG.push([t, v / ya[1] - 1]);
    }
    const shiftQ = state.lead;
    const qEnd = (t) => { const dd = new Date(t); return Date.UTC(dd.getUTCFullYear(), dd.getUTCMonth() + 3, 0); };
    const indG = i.quarterly.map(([q, y]) => [qEnd(T(q)) + shiftQ * 91.31 * 864e5, sg(y)]);
    const c = card(host, "Year-over-year growth, company revenue and indicator",
      shiftQ ? `Indicator shifted ${Math.abs(shiftQ)} quarter${Math.abs(shiftQ) > 1 ? "s" : ""} ${shiftQ > 0 ? "later (testing whether it leads)" : "earlier"}.` : "Both series on one growth axis, first-published values.",
      "Revenue growth uses each quarter's first-reported revenue against the year-ago quarter. Indicator growth is quarter over the same quarter a year earlier, as first published.");
    const series = [];
    if (!d.mapping_only && !d.annual_only) series.push({ name: `${d.ticker} revenue growth`, color: "--s1", points: revG, fmt: pctS });
    series.push({ name: i.name, color: "--s2", points: indG, fmt: pctS });
    fillLegend(c.legend, series.map((s) => ({ name: s.name, color: s.color })));
    const start = Date.UTC(2013, 0, 1);
    series.forEach((s) => { s.points = s.points.filter((p) => p[0] >= start); });
    draw(c.chart, () => lineChart(c.chart, { series, yfmt: pctAxis, tipfmt: pctS, zero: true, height: 250, tolDays: 40,
      xfmt: (t) => qLabel(t - 45 * 864e5), label: `Revenue growth of ${d.ticker} and growth of ${i.name}` }));
    const ix = new Map(indG.map(([t, v]) => [Math.round(t / 864e5 / 30), v]));
    fillTable(c.table, ["Quarter", "Revenue growth", "Indicator growth"], revG.slice().reverse().map(([t, v]) => {
      const iv = ix.get(Math.round(t / 864e5 / 30));
      return [qLabel(t - 45 * 864e5), pctS(v), fin(iv) ? pctS(iv) : "–"];
    }));
    // lead slider
    if (!d.mapping_only && !d.annual_only) {
      const r = el("div", { class: "ii-range" }, c.f);
      const lab = el("label", { for: "ii-lead" }, r, "Shift indicator:");
      const inp = el("input", { id: "ii-lead", type: "range", min: "-4", max: "4", step: "1", value: String(shiftQ) }, r);
      el("output", { for: "ii-lead" }, r, shiftQ === 0 ? "no shift" : `${shiftQ > 0 ? "+" : ""}${shiftQ} quarter${Math.abs(shiftQ) > 1 ? "s" : ""}`);
      inp.addEventListener("input", () => { state.lead = +inp.value; renderIndicatorDetail(); $("#ii-lead").focus(); });
      lab.title = "Positive values move the indicator later in time, so it lines up with revenue it may lead.";
    }
    const two = el("div", { class: "ii-two" }, host);
    let drawCorr = null;          // drawn after both cards exist, so it measures its final column width
    // lag correlations
    if (i.lag_corr && i.lag_corr.length) {
      const lc = i.lag_corr.slice().sort((a, b) => a.lead_q - b.lead_q);
      const cc = card(two, "Correlation with revenue growth by lead", "Lead in quarters; positive = indicator earlier.",
        "Changes: correlation of quarter-on-quarter changes in both growth rates, which removes most of the common trend. Descriptive only; the forecast test below is the out-of-sample check.");
      const ser = [{ name: "Growth rates", color: "--s1", values: lc.map((x) => x.corr) },
        { name: "Changes in growth", color: "--s2", values: lc.map((x) => x.corr_diff) }];
      fillLegend(cc.legend, ser.map((s) => ({ name: s.name, color: s.color, shape: "rect" })));
      drawCorr = () => draw(cc.chart, () => columns(cc.chart, { cats: lc.map((x) => (x.lead_q > 0 ? `+${x.lead_q}` : String(x.lead_q))), series: ser, domain: [-1, 1], yfmt: (v) => num(v, 1),
        tiphead: (c2) => `Lead ${c2} quarters`, label: "Correlation by lead" }));
      fillTable(cc.table, ["Lead (quarters)", "Corr., growth", "Corr., changes", "Quarters"], lc.map((x) => [String(x.lead_q), num(x.corr), num(x.corr_diff), String(x.n)]));
    }
    // incremental forecast value
    const inc = (i.incremental || []).slice().sort((a, b) => a.h - b.h);
    const ic = el("div", { class: "ii-card" }, two);
    el("h3", { class: "ii-card__title" }, ic, "Does it improve forecasts? (out of sample)");
    el("p", { class: "ii-card__sub" }, ic, `Adding this indicator to the history-only model for ${d.ticker}; positive R² = smaller squared errors than without it.`);
    if (inc.length) {
      const tw = el("div", { class: "ii-tablewrap" }, ic);
      const hn = ["Nowcast", "1 qtr earlier", "2 qtrs earlier"];
      fillTable(tw, ["Horizon", "Without", "With", "R²", "Qtrs"],
        inc.map((x) => [hn[x.h] || `h=${x.h}`, (x.mae_ar * 100).toFixed(1), (x.mae_ind * 100).toFixed(1), num(x.oos_r2, 2), String(x.n)]));
      el("p", { class: "ii-note" }, ic, "Without / with: mean absolute error of revenue growth, percentage points (log scale). R²: out-of-sample gain over the history-only model. Few quarters per company, so single-company results are noisy; the pooled tests are in the results section.");
    } else {
      el("p", { class: "ii-empty" }, ic, "Not enough overlapping quarters to test this indicator for this company.");
    }
    if (drawCorr) drawCorr();
    // level chart (monthly)
    const lv = card(host, `${i.name}: level`, `${i.unit}. Latest published values.`, null);
    const pts = i.monthly.map(([t, v]) => [T(t), v]);
    draw(lv.chart, () => lineChart(lv.chart, { series: [{ name: i.name, color: "--s2", points: pts }], height: 190, yfmt: compact, label: `${i.name}, level` }));
    fillTable(lv.table, ["Period", "Value"], pts.slice().reverse().map(([t, v]) => [monthLabel(t), compact(v)]));
  }

  // ------------------------------------------------------------------ forecast with assumptions
  function renderForecast() {
    const d = state.data, host = $("#fc-body");
    host.textContent = "";
    const f = d.forecast;
    if (!f || !f.quarters || !f.quarters.length) {
      el("p", { class: "ii-empty" }, host, d.mapping_only || d.annual_only
        ? "No forecast: the company has no quarterly SEC financials in the pipeline."
        : "No forecast available for this company.");
      return;
    }
    const q0 = f.quarters[0];
    const inds = (q0.indicators || []).filter((x) => fin(x.mu) && fin(x.sd));
    const meta = new Map((d.indicators || []).map((i) => [i.id, i]));
    if (!Object.keys(state.scen).length) {
      // indicators with no current reading stay out (as in the model) until the reader moves their slider
      for (const x of inds) if (fin(x.x)) state.scen[x.id] = x.x;
      if (f.margin) { state.scen.__price = f.margin.price_z; state.scen.__cost = f.margin.cost_z; }
      if (fin(q0.params.log_kappa)) state.scen.__kappa = Math.exp(q0.params.log_kappa);
    }
    const grid = el("div", { class: "ii-fcgrid" }, host);
    const ctl = el("div", { class: "ii-controls" }, grid);
    const out = el("div", null, grid);
    el("p", { class: "ii-card__sub" }, ctl, `Assumed year-over-year growth of each mapped indicator in the coming quarters. Starting values are the latest readings as of ${dateLabel(f.as_of)}${q0.indicators.some((x) => x.coverage > 0 && x.coverage < 1) ? " (the current quarter is only partly observed)" : ""}.`);
    for (const x of inds) {
      const m = meta.get(x.id);
      const box = el("div", { class: "ii-control" }, ctl);
      const id = `sc-${x.id}`;
      const lab = el("label", { for: id }, box, m ? m.name : x.id);
      const valEl = el("span", { class: "ii-control__val" }, lab);
      const lo = x.mu - 3 * x.sd, hi = x.mu + 3 * x.sd;
      const start = fin(state.scen[x.id]) ? state.scen[x.id] : x.mu;
      const inp = el("input", { id, type: "range", min: String(lo), max: String(hi), step: String((hi - lo) / 120), value: String(start) }, box);
      el("small", null, box, fin(x.x)
        ? `Latest ${pctg(x.x)}; typical ${pctg(x.mu)} ± ${(Math.expm1(x.sd) * 100).toFixed(0)}%`
        : `No current reading, so the model leaves it out; moving the slider adds it. Typical ${pctg(x.mu)} ± ${(Math.expm1(x.sd) * 100).toFixed(0)}%`);
      // show the stored assumption (the exact reading until the slider moves), not the slider's snapped position
      const upd = () => { valEl.textContent = fin(state.scen[x.id]) ? pctg(state.scen[x.id]) : "not used"; };
      upd();
      inp.addEventListener("input", () => { state.scen[x.id] = +inp.value; upd(); drawForecast(out); });
    }
    if (fin(state.scen.__kappa)) {
      const box = el("div", { class: "ii-control" }, ctl);
      const lab = el("label", { for: "sc-kappa" }, box, "Backlog conversion next quarter");
      const valEl = el("span", { class: "ii-control__val" }, lab);
      const base = Math.exp(q0.params.log_kappa);
      const inp = el("input", { id: "sc-kappa", type: "range", min: String(base * 0.5), max: String(base * 1.5), step: String(base / 100), value: String(state.scen.__kappa) }, box);
      el("small", null, box, `Revenue as a share of remaining performance obligations at the last quarter end (${money(q0.params.rpo_last)}); the company's partially pooled history gives ${(base * 100).toFixed(0)}%.`);
      const upd = () => { valEl.textContent = `${(+inp.value * 100).toFixed(0)}%`; };
      upd();
      inp.addEventListener("input", () => { state.scen.__kappa = +inp.value; upd(); drawForecast(out); });
    }
    if (f.margin) {
      for (const [key, label, help] of [["__price", "Output prices vs normal", "Pricing indicators (industry price indexes) in standard deviations from their usual growth."],
        ["__cost", "Input costs vs normal", "Cost indicators (steel, copper) in standard deviations from their usual growth."]]) {
        const box = el("div", { class: "ii-control" }, ctl);
        const lab = el("label", { for: `sc${key}` }, box, label);
        const valEl = el("span", { class: "ii-control__val" }, lab);
        const inp = el("input", { id: `sc${key}`, type: "range", min: "-3", max: "3", step: "0.05", value: String(state.scen[key] || 0) }, box);
        el("small", null, box, help);
        const upd = () => { valEl.textContent = `${(+inp.value >= 0 ? "+" : "−")}${Math.abs(+inp.value).toFixed(2)} sd`; };
        upd();
        inp.addEventListener("input", () => { state.scen[key] = +inp.value; upd(); drawForecast(out); });
      }
    }
    const br = el("div", { class: "ii-btnrow" }, ctl);
    const reset = el("button", { class: "ii-btn", type: "button" }, br, "Reset to latest readings");
    reset.addEventListener("click", () => { state.scen = {}; renderForecast(); });
    drawForecast(out);
  }

  // The reader's assumption for each indicator is applied as a change from the latest reading, so every quarter
  // keeps its own as-of reading and the defaults reproduce the model exactly. An indicator with no reading enters
  // only once its slider is moved.
  function scenarioRow(q, q0) {
    const p = q.params;
    const base = new Map((q0.indicators || []).map((x) => [x.id, x.x]));
    const zs = [];
    for (const x of q.indicators || []) {
      if (!fin(x.mu) || !fin(x.sd) || x.sd <= 0) continue;
      const v = state.scen[x.id], b = base.get(x.id);
      let val = null;
      if (fin(x.x)) val = x.x + (fin(v) && fin(b) ? v - b : 0);
      else if (fin(v)) val = v;
      if (val !== null) zs.push((val - x.mu) / x.sd);
    }
    const z = zs.length ? zs.reduce((a, b) => a + b, 0) / zs.length : null;
    const yhat = z === null || !fin(p.c) ? q.yhat_ar : p.a + p.b * q.g_last + p.c * z;
    return { z, yhat };
  }

  function drawForecast(out) {
    const d = state.data, f = d.forecast;
    out.textContent = "";
    const hist = (d.financials || []).filter((r) => fin(r.rev) && T(r.q) >= Date.UTC(2018, 0, 1)).map((r) => [T(r.q), r.rev]);
    const rows = f.quarters.map((q) => {
      const s = scenarioRow(q, f.quarters[0]);
      const ya = q.rev_year_ago;
      return { t: T(q.period_end), q, base: ya * Math.exp(q.yhat_bayes), lo: ya * Math.exp(q.lo), hi: ya * Math.exp(q.hi),
        scen: ya * Math.exp(s.yhat), sg: s.yhat, ar: ya * Math.exp(q.yhat_ar) };
    });
    const c = card(out, "Revenue: history and next three quarters", "Model forecast with its 80% interval, and the forecast under your assumptions.",
      "Quarter one uses the nowcast model, quarters two and three the models fitted for forecasts one and two quarters before a release. Intervals come from the partially pooled residual variance and slope uncertainty; they do not include revisions or one-off events.");
    const lastH = hist[hist.length - 1];
    const series = [
      { name: "Reported revenue", color: "--s1", points: hist, fmt: money },
      { name: "Model forecast", color: "--s3", points: (lastH ? [lastH] : []).concat(rows.map((r) => [r.t, r.base])), markers: true, dashed: true,
        band: rows.map((r) => [r.t, r.lo, r.hi]), bandName: "80% interval", fmt: money },
      { name: "Your assumptions", color: "--s2", points: rows.map((r) => [r.t, r.scen]), markersOnly: true, fmt: money },
    ];
    fillLegend(c.legend, series.map((s) => ({ name: s.name, color: s.color, shape: s.markersOnly ? "dot" : null })));
    draw(c.chart, () => lineChart(c.chart, { series, yfmt: moneyTick, tipfmt: money, height: 270, xfmt: (t) => qLabel(t - 45 * 864e5), label: `Revenue history and forecast, ${d.name}` }));
    const head = ["Quarter", "Model growth", "Model revenue", "80% range", "Your growth", "Your revenue", "History-only (AR)"];
    const conv = f.quarters[0].params;
    if (fin(state.scen.__kappa) && fin(conv.rpo_last)) head.push("Backlog conversion");
    const tr = rows.map((r, i) => {
      const a = [qLabel(r.t - 45 * 864e5), pctg(r.q.yhat_bayes), money(r.base), `${money(r.lo)} to ${money(r.hi)}`, pctg(r.sg), money(r.scen), money(r.ar)];
      if (head.length > 7) a.push(i === 0 ? money(state.scen.__kappa * conv.rpo_last) : "–");
      return a;
    });
    const tw = el("div", { class: "ii-tablewrap" }, c.f);
    fillTable(tw, head, tr);
    fillTable(c.table, head, tr);
    if (f.margin && fin(f.margin.gm_year_ago_next)) {
      const mg = f.margin, b = mg.beta;
      const dg = b[0] + b[1] * mg.dgm_last + b[2] * (state.scen.__price || 0) + b[3] * (state.scen.__cost || 0) + b[4] * (mg.g_last || 0);
      const box = el("p", { class: "ii-callout" }, out);
      el("strong", null, box, "Gross margin, next quarter: ");
      box.appendChild(document.createTextNode(`model ${pct(mg.gm_hat_next)} (${pp(mg.dgm_hat)} vs a year earlier); under your price and cost assumptions ${pct(mg.gm_year_ago_next + dg)} (${pp(dg)}). Last reported ${pct(mg.gm_last)}. Out of sample this price-cost model beat a random walk but was about 3% less accurate than simple mean reversion of margins, so read it as arithmetic on your assumptions, not a prediction.`));
    }
  }

  // ------------------------------------------------------------------ historical errors
  function renderErrors() {
    const d = state.data, host = $("#err-body");
    host.textContent = "";
    if (!d || !d.backtest) { el("p", { class: "ii-empty" }, host, "No walk-forward forecasts for this company."); return; }
    const bt = d.backtest.filter((r) => r.h === state.h);
    if (!bt.length) { el("p", { class: "ii-empty" }, host, "No forecasts at this horizon."); return; }
    const c = card(host, `Revenue growth: reported vs forecast (${d.ticker})`, "Each point is a forecast made before the quarter was released.",
      "Shaded: 80% interval of the partially pooled model. 2016–2020 is the development period; 2021 onward is the holdout.");
    const pts = (k) => bt.map((r) => [T(r.q), sg(r.p[k])]).filter((x) => fin(x[1]));
    const series = [
      { name: "Reported", color: "--s1", points: bt.map((r) => [T(r.q), sg(r.y)]), fmt: pctS },
      { name: MODEL_NAMES.BayesComp, color: "--s2", points: pts("BayesComp"), band: bt.map((r) => [T(r.q), sg(r.lo), sg(r.hi)]), bandName: "80% interval", fmt: pctS },
      { name: MODEL_NAMES.RW, color: "--s3", points: pts("RW"), fmt: pctS },
    ];
    fillLegend(c.legend, series.map((s) => ({ name: s.name, color: s.color })));
    draw(c.chart, () => lineChart(c.chart, { series, yfmt: pctAxis, tipfmt: pctS, zero: true, height: 260,
      xfmt: (t) => qLabel(t - 45 * 864e5), label: "Reported and forecast revenue growth" }));
    fillTable(c.table, ["Quarter", "Reported", "Bayes", "Random walk", "History only", "Error (Bayes)"],
      bt.slice().reverse().map((r) => [qLabel(T(r.q) - 45 * 864e5), pctg(r.y), pctg(r.p.BayesComp), pctg(r.p.RW), pctg(r.p.AR),
        fin(r.p.BayesComp) ? `${((r.p.BayesComp - r.y) * 100).toFixed(1)} pp` : "–"]));
    const s = (d.backtest_summary || []).filter((x) => x.h === state.h);
    if (s.length) {
      const order = ["RW", "AR", "Composite", "BayesComp", "MappedRidge", "GBM", "BacklogAR", "Conversion"];
      const by = (m, per) => s.find((x) => x.model === m && x.period === per);
      const t = el("div", { class: "ii-card" }, host);
      el("h3", { class: "ii-card__title" }, t, "Mean absolute error by model, this company");
      el("p", { class: "ii-card__sub" }, t, "Percentage points of revenue growth (log). Ratio below 1 = better than the random walk.");
      const tw = el("div", { class: "ii-tablewrap" }, t);
      const rows = order.filter((m) => by(m, "all")).map((m) => {
        const rw = by("RW", "all"), dev = by(m, "dev"), ho = by(m, "holdout"), all = by(m, "all");
        return [MODEL_NAMES[m] || m, dev ? `${(dev.mae * 100).toFixed(1)}` : "–", ho ? `${(ho.mae * 100).toFixed(1)}` : "–",
          `${(all.mae * 100).toFixed(1)}`, rw ? num(all.mae / rw.mae, 2) : "–", String(all.n)];
      });
      fillTable(tw, ["Model", "2016–20", "2021–26", "All", "vs random walk", "Forecasts"], rows, (r) => r[0] === MODEL_NAMES.BayesComp);
    }
  }

  // ------------------------------------------------------------------ timeline
  function renderTimeline() {
    const d = state.data, chips = $("#tl-kinds"), list = $("#tl-list");
    chips.textContent = ""; list.textContent = "";
    const ev = d.timeline || [];
    if (!ev.length) { el("li", { class: "ii-empty" }, list, "No dated events for this company."); return; }
    const kinds = [["results", "Results"], ["announcement", "Announcements"], ["contract", "Federal contracts"], ["project", "Projects"]]
      .filter(([k]) => ev.some((e) => e.kind === k));
    if (!state.kinds) state.kinds = new Set(kinds.map(([k]) => k).filter((k) => k !== "results"));
    if (!state.kinds.size) state.kinds = new Set(kinds.map(([k]) => k));
    for (const [k, label] of kinds) {
      const n = ev.filter((e) => e.kind === k).length;
      const b = el("button", { class: "ii-chip", type: "button", "aria-pressed": String(state.kinds.has(k)) }, chips, `${label} (${n})`);
      b.addEventListener("click", () => {
        if (state.kinds.has(k)) state.kinds.delete(k); else state.kinds.add(k);
        renderTimeline();
      });
    }
    const shown = ev.filter((e) => state.kinds.has(e.kind)).sort((a, b) => T(b.date) - T(a.date));
    const limit = 40;
    for (const e of shown.slice(0, limit)) {
      const li = el("li", { class: "ii-tl" }, list);
      el("div", { class: "ii-tl__date" }, li, dateLabel(e.date));
      const body = el("div", null, li);
      const tt = el("p", { class: "ii-tl__title" }, body);
      if (e.url && /^https:\/\//.test(e.url)) el("a", { href: e.url, rel: "noopener" }, tt, e.title); else tt.textContent = e.title;
      if (e.detail) {
        const parts = String(e.detail).split(" || ").slice(0, 2);
        for (const ptxt of parts) el("p", { class: "ii-tl__detail" }, body, e.kind === "announcement" || e.kind === "results" ? `“${ptxt}”` : ptxt);
      }
      el("p", { class: "ii-tl__src" }, body, `${e.source}`);
    }
    if (shown.length > limit) el("li", { class: "ii-note ii-more" }, list, `${shown.length - limit} older events not shown.`);
  }

  // ------------------------------------------------------------------ research results (all companies)
  function renderResearch() {
    const host = $("#res-body"), R = state.index.results || {};
    host.textContent = "";
    const rev = (R.revenue || []).filter((r) => r.case === "all");
    if (!rev.length) { el("p", { class: "ii-empty" }, host, "Results not exported."); return; }
    const order = ["RW", "AR", "Composite", "BayesComp", "MappedRidge", "GBM", "BacklogAR", "Conversion"];
    // chart: holdout nowcast MAE relative to random walk
    const ho = rev.filter((r) => r.h === 0 && r.period === "holdout");
    const c = card(host, "Nowcast error relative to the random walk, 2021 onward holdout",
      "Mean absolute error of revenue growth divided by the random walk's; below 1 is better.",
      "The random walk carries the last reported growth forward; the history-only model shrinks it towards the average. Indicator models add the company's mapped indicators as of one second before each release.");
    const items = order.map((m) => ho.find((r) => r.model === m)).filter(Boolean).map((r) => ({ label: MODEL_NAMES[r.model] || r.model, value: r.mae_vs_rw }));
    draw(c.chart, () => hbars(c.chart, { items, ref: 1, xfmt: (v) => num(v, 2), label: "Error relative to random walk by model" }));
    fillTable(c.table, ["Model", "Error vs random walk"], items.map((x) => [x.label, num(x.value, 2)]));
    // full table by horizon and period
    const t = el("div", { class: "ii-card" }, host);
    el("h3", { class: "ii-card__title" }, t, "Revenue growth forecasts, all modelled companies");
    el("p", { class: "ii-card__sub" }, t, "Mean absolute error in percentage points (log). DM: Diebold-Mariano p-value against the history-only model (two-sided); CW: Clark-West p-value that the model adds to it (one-sided). Tests treat each quarter as one observation.");
    const tw = el("div", { class: "ii-tablewrap" }, t);
    const rows = [];
    for (const h of [0, 1, 2]) for (const per of ["dev", "holdout"]) for (const m of order) {
      const r = rev.find((x) => x.h === h && x.period === per && x.model === m);
      if (!r) continue;
      rows.push([["Nowcast", "1 quarter earlier", "2 quarters earlier"][h], per === "dev" ? "2016–20" : "2021–26", MODEL_NAMES[m] || m,
        String(r.n), (r.mae * 100).toFixed(2), num(r.mae_vs_rw, 2), num(r.mae_vs_ar, 2),
        m === "AR" ? "–" : num(r.dm_p_vs_ar, 3), ["RW", "AR"].includes(m) ? "–" : num(r.cw_p_vs_ar, 3)]);
    }
    fillTable(tw, ["~Horizon", "~Period", "~Model", "Forecasts", "Error", "vs RW", "vs AR", "DM p", "CW p"], rows,
      (r) => r[2] === MODEL_NAMES.BayesComp);
    // case studies
    const cases = [["data_center", "Data center power and cooling"], ["caterpillar", "Caterpillar and heavy machinery"],
      ["grid", "Electrical equipment and grid"], ["backlog", "Order backlogs and conversion"], ["semicap", "Semiconductor equipment"]];
    const ct = el("div", { class: "ii-card" }, host);
    el("h3", { class: "ii-card__title" }, ct, "By case study, nowcast horizon, all periods");
    el("p", { class: "ii-card__sub" }, ct, "Each case pools the companies it covers; a company can appear in more than one case.");
    const cw = el("div", { class: "ii-tablewrap" }, ct);
    const crow = [];
    for (const [k, label] of cases) {
      const rr = (R.revenue || []).filter((r) => r.case === k && r.h === 0 && r.period === "all");
      const g = (m) => rr.find((r) => r.model === m);
      if (!g("RW")) continue;
      const best = ["Composite", "BayesComp", "MappedRidge", "GBM", "BacklogAR", "Conversion"].map(g).filter(Boolean).sort((a, b) => a.mae - b.mae)[0];
      crow.push([label, String(g("RW").n), (g("RW").mae * 100).toFixed(2), (g("AR").mae * 100).toFixed(2),
        g("BayesComp") ? (g("BayesComp").mae * 100).toFixed(2) : "–", g("BayesComp") ? num(g("BayesComp").cw_p_vs_ar, 3) : "–",
        best ? `${MODEL_NAMES[best.model] || best.model} (${(best.mae * 100).toFixed(2)})` : "–"]);
    }
    fillTable(cw, ["~Case", "Forecasts", "Random walk", "History only", "Bayes indicators", "CW p", "~Lowest-error model"], crow);
    // sensitivity
    const sens = (R.sensitivity || []).filter((r) => r.model === "BayesComp" && r.period === "all");
    if (sens.length) {
      const st = el("div", { class: "ii-card" }, host);
      el("h3", { class: "ii-card__title" }, st, "Sensitivity: partially pooled indicator model, nowcast, all periods");
      el("p", { class: "ii-card__sub" }, st, "The look-ahead row uses today's revised data with no publication lag: the error a careless backtest would report.");
      const sw = el("div", { class: "ii-tablewrap" }, st);
      fillTable(sw, ["~Variant", "Forecasts", "Error", "vs RW", "vs AR", "CW p"],
        sens.map((r) => [r.variant, String(r.n), (r.mae * 100).toFixed(2), num(r.mae_vs_rw, 2), num(r.mae_vs_ar, 2), num(r.cw_p_vs_ar, 3)]));
    }
    // returns
    const ret = R.returns || [];
    const rt = el("div", { class: "ii-card" }, host);
    el("h3", { class: "ii-card__title" }, rt, "A different question: excess stock returns");
    el("p", { class: "ii-card__sub" }, rt, "Predicting revenue is not predicting the stock. These tests use licensed daily returns (CRSP, through December 2024) that are not published here; only the statistics are.");
    if (ret.length) {
      const rw = el("div", { class: "ii-tablewrap" }, rt);
      fillTable(rw, ["~Test", "Events", "Companies", "Slope", "t-stat", "Mean return, signal > 0", "Mean return, signal ≤ 0"],
        ret.map((r) => [r.test, String(r.n_events), String(r.companies), num(r.slope, 3), num(r.t, 2),
          fin(r.mean_ret_signal_pos) ? `${(r.mean_ret_signal_pos * 100).toFixed(2)}%` : "–",
          fin(r.mean_ret_signal_neg) ? `${(r.mean_ret_signal_neg * 100).toFixed(2)}%` : "–"]));
    } else {
      el("p", { class: "ii-empty" }, rt, "Return tests not run in this build.");
    }
  }

  // ------------------------------------------------------------------ sources
  function renderSources() {
    const host = $("#src-body");
    host.textContent = "";
    const t = el("div", { class: "ii-card" }, host);
    const tw = el("div", { class: "ii-tablewrap" }, t);
    const tab = el("table", { class: "ii-table" }, tw);
    const hr = el("tr", null, el("thead", null, tab));
    for (const h of ["Source", "Used for", "Point-in-time treatment", "Terms", "Status"]) el("th", { class: "l", scope: "col" }, hr, h);
    const tb = el("tbody", null, tab);
    for (const s of state.index.sources || []) {
      const r = el("tr", null, tb);
      const c0 = el("td", { class: "l" }, r);
      if (s.url && /^https:\/\//.test(s.url)) el("a", { href: s.url, rel: "noopener" }, c0, s.name); else c0.textContent = s.name;
      el("td", { class: "l" }, r, s.content);
      el("td", { class: "l" }, r, s.vintage);
      el("td", { class: "l" }, r, s.terms);
      el("td", { class: "l" }, r, s.status);
    }
    const it = card(host, "Indicator registry", "Every series a model may use, declared before testing.", null);
    it.btn.remove();
    const iw = el("div", { class: "ii-tablewrap" }, it.f);
    it.chart.remove();
    fillTable(iw, ["~Indicator", "~Source", "~Point in time", "From", "To"], (state.index.indicators || []).map((i) => [
      i.name, SOURCE_NAMES[i.source] || i.source, VINTAGE[i.vintage_kind] || i.vintage_kind,
      i.first ? monthLabel(T(i.first)) : "no data", i.last ? monthLabel(T(i.last)) : "–"]));
  }

  document.addEventListener("DOMContentLoaded", init);
})();
