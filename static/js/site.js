(() => {
  "use strict";
  const root = document.documentElement;

  // Light / dark toggle (remembers the choice on this device only)
  const toggle = document.querySelector("[data-theme-toggle]");
  if (toggle) {
    toggle.addEventListener("click", () => {
      const current = root.getAttribute("data-theme") ||
        (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      const next = current === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try { localStorage.setItem("theme", next); } catch (e) { /* private mode */ }
    });
  }

  // Header rule on scroll + reading progress on posts
  const masthead = document.querySelector("[data-masthead]");
  const progress = document.querySelector("[data-progress]");
  const article = document.querySelector(".post .prose");
  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      if (masthead) masthead.classList.toggle("is-scrolled", window.scrollY > 4);
      if (progress && article) {
        const rect = article.getBoundingClientRect();
        const span = Math.max(rect.height - window.innerHeight * 0.55, 1);
        const done = Math.min(1, Math.max(0, -rect.top / span));
        progress.style.width = (done * 100).toFixed(2) + "%";
      }
      spy();
    });
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll);

  // Share buttons: always share an absolute URL, even when site.yaml has no url yet
  document.querySelectorAll("[data-share]").forEach((box) => {
    const url = new URL(box.dataset.share || location.pathname, location.href).href;
    const title = box.dataset.title || document.title;
    const u = encodeURIComponent(url);
    const t = encodeURIComponent(title);
    box.querySelectorAll("[data-net]").forEach((a) => {
      if (a.dataset.net === "x") a.href = `https://x.com/intent/post?url=${u}&text=${t}`;
      if (a.dataset.net === "linkedin") a.href = `https://www.linkedin.com/sharing/share-offsite/?url=${u}`;
      if (a.dataset.net === "email") a.href = `mailto:?subject=${t}&body=${u}`;
    });
    const copy = box.querySelector("[data-copy]");
    if (!copy) return;
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(url);
      } catch (e) {
        const field = document.createElement("textarea");
        field.value = url;
        document.body.append(field);
        field.select();
        document.execCommand("copy");
        field.remove();
      }
      const label = copy.querySelector("span");
      const before = label ? label.textContent : "";
      copy.classList.add("is-done");
      if (label) label.textContent = "Copied";
      setTimeout(() => {
        copy.classList.remove("is-done");
        if (label) label.textContent = before;
      }, 1600);
    });
  });

  // Table of contents: collapse on small screens, highlight the current section
  const toc = document.querySelector(".toc");
  let tocLinks = [];
  let tocHeads = [];
  if (toc) {
    const box = toc.querySelector("details");
    if (box && window.innerWidth < 1260) box.open = false;
    tocLinks = [...toc.querySelectorAll('a[href^="#"]')];
    tocHeads = tocLinks.map((a) => document.getElementById(decodeURIComponent(a.hash.slice(1))));
    tocLinks.forEach((a) => a.addEventListener("click", () => {
      if (box && window.innerWidth < 1260) box.open = false;
    }));
  }
  function spy() {
    if (!tocLinks.length) return;
    let current = -1;
    tocHeads.forEach((h, i) => { if (h && h.getBoundingClientRect().top < 140) current = i; });
    tocLinks.forEach((a, i) => a.classList.toggle("is-active", i === current));
  }

  // Archive: filter by section and search
  const archive = document.querySelector("[data-archive]");
  if (archive) {
    const chips = [...archive.querySelectorAll("[data-filter]")];
    const input = archive.querySelector("[data-search]");
    const items = [...archive.querySelectorAll(".alist__item")];
    const years = [...archive.querySelectorAll("[data-year]")];
    const none = archive.querySelector("[data-noresults]");
    let filter = "all";
    const norm = (s) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
    items.forEach((li) => { li.dataset.text = norm(li.dataset.text || ""); });
    const apply = () => {
      const q = norm((input ? input.value : "").trim());
      let shown = 0;
      items.forEach((li) => {
        const ok = (filter === "all" || li.dataset.section === filter) && (!q || li.dataset.text.includes(q));
        li.hidden = !ok;
        if (ok) shown += 1;
      });
      years.forEach((y) => { y.hidden = !y.querySelector(".alist__item:not([hidden])"); });
      if (none) none.hidden = shown > 0;
    };
    chips.forEach((chip) => chip.addEventListener("click", () => {
      filter = chip.dataset.filter;
      chips.forEach((c) => {
        c.classList.toggle("is-active", c === chip);
        c.setAttribute("aria-pressed", String(c === chip));
      });
      apply();
    }));
    if (input) {
      input.addEventListener("input", apply);
      const q = new URLSearchParams(location.search).get("q");
      if (q) { input.value = q; apply(); }
    }
  }

  // Maths: only loads KaTeX on pages that contain \( … \) or \[ … \]
  const maths = document.querySelectorAll(".prose eq, .prose eqn");
  if (maths.length) {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css";
    document.head.append(css);
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js";
    script.onload = () => maths.forEach((el) => {
      try {
        window.katex.render(el.textContent, el, { displayMode: el.tagName === "EQN", throwOnError: false });
      } catch (e) { /* leave the raw TeX visible */ }
    });
    document.head.append(script);
  }

  // Portfolio: performance chart and activity filters
  const perfBox = document.querySelector("[data-perf]");
  const perfJson = document.getElementById("perf-data");
  if (perfBox && perfJson) {
    try { perfChart(perfBox, JSON.parse(perfJson.textContent)); } catch (e) { /* the tables still carry the data */ }
  }
  const activity = document.querySelector("[data-activity]");
  if (activity) {
    const buttons = [...activity.querySelectorAll("[data-act]")];
    const items = [...activity.querySelectorAll(".act")];
    const years = [...activity.querySelectorAll("[data-act-year]")];
    const apply = (group) => {
      items.forEach((li) => { li.hidden = group !== "all" && li.dataset.group !== group; });
      years.forEach((y) => { y.hidden = !y.querySelector(".act:not([hidden])"); });
    };
    buttons.forEach((b) => b.addEventListener("click", () => {
      buttons.forEach((x) => { x.classList.toggle("is-active", x === b); x.setAttribute("aria-pressed", String(x === b)); });
      if (b.dataset.act !== "all") activity.classList.remove("is-collapsed");
      apply(b.dataset.act);
    }));
    const more = activity.querySelector("[data-act-more]");
    if (more) more.addEventListener("click", () => activity.classList.remove("is-collapsed"));
  }

  function perfChart(box, data) {
    const plot = box.querySelector("[data-chart]");
    const all = data.series.map((p) => ({ ...p, t: Date.parse(p.d + "T00:00:00Z") }));
    if (!plot || all.length < 2) return;
    const events = (data.events || []).map((e) => ({ ...e, t: Date.parse(e.d + "T00:00:00Z") }));
    const state = { range: "all", view: "return", index: null };
    const NS = "http://www.w3.org/2000/svg";
    const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const day = (t) => { const d = new Date(t); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
    const pct = (x) => (Math.abs(x) < 0.05 ? "0.0%" : (x > 0 ? "+" : "−") + Math.abs(x).toFixed(1) + "%");
    const eur = (x) => "€" + Math.round(x).toLocaleString("en-US");
    const eurShort = (x) => (Math.abs(x) >= 1000 ? "€" + Math.round(x / 1000) + "K" : "€" + Math.round(x));
    const legendA = box.querySelector("[data-legend-a] b");
    const legendB = box.querySelector("[data-legend-b] b");
    const labels = { a: legendA ? legendA.textContent : "Portfolio", b: legendB ? legendB.textContent : data.benchmark };
    const el = (name, attrs, parent) => {
      const node = document.createElementNS(NS, name);
      Object.entries(attrs || {}).forEach(([k, v]) => node.setAttribute(k, v));
      if (parent) parent.appendChild(node);
      return node;
    };
    const color = (name) => getComputedStyle(plot).getPropertyValue(name).trim();

    function visible() {
      const last = new Date(all[all.length - 1].t);
      const y = last.getUTCFullYear(), m = last.getUTCMonth(), d = last.getUTCDate();
      const from = { ytd: Date.UTC(y, 0, 1), "1y": Date.UTC(y - 1, m, d), "3y": Date.UTC(y - 3, m, d) }[state.range] ?? -Infinity;
      const before = all.filter((p) => p.t < from).pop();
      const pts = all.filter((p) => p.t >= from);
      return before ? [before, ...pts] : pts;
    }

    function niceTicks(lo, hi, count) {
      const span = hi - lo || Math.abs(hi) || 1;
      const raw = span / count;
      const mag = Math.pow(10, Math.floor(Math.log10(raw)));
      const n = raw / mag;
      const step = (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
      const ticks = [];
      for (let v = Math.floor(lo / step) * step; v <= Math.ceil(hi / step) * step + step / 2; v += step) ticks.push(Math.round(v / step) * step);
      return ticks;
    }

    let tip = null, cross = null, dot = null, dotB = null, geom = null;

    function render() {
      const pts = visible();
      const valueView = state.view === "value" && data.amounts;
      const base = pts[0];
      const A = pts.map((p) => (valueView ? p.v : (p.p / base.p - 1) * 100));
      const B = pts.map((p) => (valueView ? p.n : (p.b != null && base.b != null ? (p.b / base.b - 1) * 100 : null)));
      if (legendA) legendA.textContent = valueView ? "Portfolio value" : labels.a;
      if (legendB) legendB.textContent = valueView ? "Money put in" : labels.b;
      const W = Math.max(plot.clientWidth, 280);
      const H = W < 520 ? 230 : 290;
      const M = { l: valueView ? 52 : 46, r: W < 520 ? 52 : 64, t: 12, b: 46 };
      const vals = A.concat(B.filter((v) => v != null));
      let lo = Math.min(...vals), hi = Math.max(...vals);
      if (!valueView) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); } else { lo = Math.min(lo, 0); }
      const ticks = niceTicks(lo, hi, H < 260 ? 4 : 5);
      const y0 = ticks[0], y1 = ticks[ticks.length - 1];
      const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
      const X = (t) => M.l + ((t - t0) / (t1 - t0 || 1)) * (W - M.l - M.r);
      const Y = (v) => M.t + (1 - (v - y0) / (y1 - y0 || 1)) * (H - M.t - M.b);
      const c = { a: color("--chart-a"), b: color("--chart-b"), grid: color("--rule"), zero: color("--rule-strong"),
        dep: color("--chart-dep"), sell: color("--chart-sell"), surface: color("--surface"), ink: color("--ink") };

      plot.querySelectorAll("svg, .tip").forEach((n) => n.remove());
      const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, "aria-hidden": "true" }, null);
      plot.appendChild(svg);
      // grid + y axis
      ticks.forEach((v) => {
        el("line", { x1: M.l, x2: W - M.r, y1: Y(v), y2: Y(v), stroke: v === 0 && !valueView ? c.zero : c.grid, "stroke-width": 1, "shape-rendering": "crispEdges" }, svg);
        const label = el("text", { x: M.l - 8, y: Y(v) + 4, "text-anchor": "end", class: "axis" }, svg);
        label.textContent = valueView ? eurShort(v) : (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v) + "%";
      });
      // x axis: years, or months on short ranges
      const span = (t1 - t0) / 864e5;
      const marks = [];
      const startD = new Date(t0);
      for (let y = startD.getUTCFullYear(), mo = startD.getUTCMonth() + 1; ; mo++) {
        if (mo > 11) { mo = 0; y++; }
        const t = Date.UTC(y, mo, 1);
        if (t > t1) break;
        if (span > 800 ? mo === 0 : span > 300 ? mo % 3 === 0 : true) marks.push({ t, text: mo === 0 ? String(y) : MONTHS[mo] });
      }
      let lastX = -Infinity;
      marks.forEach((mk) => {
        const x = X(mk.t);
        if (x - lastX < 40 || x > W - M.r) return;
        lastX = x;
        el("line", { x1: x, x2: x, y1: H - M.b, y2: H - M.b + 4, stroke: c.zero, "stroke-width": 1 }, svg);
        const label = el("text", { x, y: H - 10, "text-anchor": "middle", class: "axis" }, svg);
        label.textContent = mk.text;
      });
      // event rug: money added (triangles) and sales (dots), between the plot and the axis labels
      const rugY = H - M.b + 17;
      events.filter((e) => e.t >= t0 && e.t <= t1 && (e.k === "money" || e.k === "sell")).forEach((e) => {
        const x = X(e.t);
        if (e.k === "money") {
          if (!/^Added/.test(e.title)) return;
          el("path", { d: `M${x - 4.5},${rugY + 4} L${x + 4.5},${rugY + 4} L${x},${rugY - 4} Z`, fill: c.dep, stroke: c.surface, "stroke-width": 1.5, "stroke-linejoin": "round" }, svg);
        } else {
          el("circle", { cx: x, cy: rugY, r: 4, fill: c.sell, stroke: c.surface, "stroke-width": 2 }, svg);
        }
      });
      // lines
      const path = (arr, step) => arr.map((v, i) => {
        if (v == null) return "";
        const x = X(pts[i].t).toFixed(1), y = Y(v).toFixed(1);
        if (i === 0) return `M${x},${y}`;
        return step ? `H${x}V${y}` : `L${x},${y}`;
      }).join("");
      el("path", { d: path(B, valueView), fill: "none", stroke: c.b, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
      el("path", { d: path(A, false), fill: "none", stroke: c.a, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
      // end dots and labels (the benchmark label is dropped when the two would collide)
      const last = pts.length - 1;
      const endA = Y(A[last]), endB = B[last] != null ? Y(B[last]) : null;
      el("circle", { cx: X(pts[last].t), cy: endA, r: 4, fill: c.a, stroke: c.surface, "stroke-width": 2 }, svg);
      if (endB != null) el("circle", { cx: X(pts[last].t), cy: endB, r: 4, fill: c.b, stroke: c.surface, "stroke-width": 2 }, svg);
      const fmt = valueView ? eurShort : pct;
      const la = el("text", { x: X(pts[last].t) + 9, y: endA + 4, class: "endlabel" }, svg);
      la.textContent = fmt(A[last]);
      if (endB != null && Math.abs(endA - endB) >= 15) {
        const lb = el("text", { x: X(pts[last].t) + 9, y: endB + 4, class: "endlabel endlabel--b" }, svg);
        lb.textContent = fmt(B[last]);
      }
      // hover layer
      cross = el("line", { y1: M.t, y2: H - M.b, stroke: c.zero, "stroke-width": 1, visibility: "hidden" }, svg);
      dotB = el("circle", { r: 4, fill: c.b, stroke: c.surface, "stroke-width": 2, visibility: "hidden" }, svg);
      dot = el("circle", { r: 4, fill: c.a, stroke: c.surface, "stroke-width": 2, visibility: "hidden" }, svg);
      const hit = el("rect", { x: M.l, y: 0, width: W - M.l - M.r, height: H, fill: "transparent" }, svg);
      tip = document.createElement("div");
      tip.className = "tip";
      tip.hidden = true;
      plot.appendChild(tip);
      geom = { pts, A, B, X, Y, W, M, valueView, fmt };
      hit.addEventListener("pointermove", (ev) => {
        const rect = svg.getBoundingClientRect();
        const x = ((ev.clientX - rect.left) / rect.width) * W;
        show(nearest(x));
      });
      hit.addEventListener("pointerleave", hide);
      if (state.index != null) show(Math.min(state.index, pts.length - 1));
    }

    function nearest(x) {
      const { pts, X } = geom;
      let best = 0, dist = Infinity;
      pts.forEach((p, i) => { const d = Math.abs(X(p.t) - x); if (d < dist) { dist = d; best = i; } });
      return best;
    }

    function show(i) {
      const { pts, A, B, X, Y, W, valueView, fmt } = geom;
      state.index = i;
      const x = X(pts[i].t);
      cross.setAttribute("x1", x); cross.setAttribute("x2", x); cross.setAttribute("visibility", "visible");
      dot.setAttribute("cx", x); dot.setAttribute("cy", Y(A[i])); dot.setAttribute("visibility", "visible");
      if (B[i] != null) { dotB.setAttribute("cx", x); dotB.setAttribute("cy", Y(B[i])); dotB.setAttribute("visibility", "visible"); }
      else dotB.setAttribute("visibility", "hidden");
      tip.replaceChildren();
      const head = document.createElement("span");
      head.className = "tip__date";
      head.textContent = (i === 0 ? "" : "Week to ") + day(pts[i].t);
      tip.appendChild(head);
      const row = (value, label, key) => {
        const r = document.createElement("div");
        r.className = "tip__row";
        const k = document.createElement("i");
        k.className = "key key--line " + key;
        const b = document.createElement("b");
        b.textContent = value;
        const s = document.createElement("span");
        s.textContent = label;
        r.append(k, b, s);
        tip.appendChild(r);
      };
      row(valueView ? eur(A[i]) : fmt(A[i]), valueView ? "Portfolio value" : labels.a, "key--a");
      if (B[i] != null) row(valueView ? eur(B[i]) : fmt(B[i]), valueView ? "Money put in" : labels.b, "key--b");
      const from = i > 0 ? pts[i - 1].t : -Infinity;
      const hits = events.filter((e) => e.t > from && e.t <= pts[i].t);
      if (hits.length) {
        const list = document.createElement("ul");
        list.className = "tip__events";
        hits.slice(0, 4).forEach((e) => {
          const li = document.createElement("li");
          const k = document.createElement("i");
          k.className = "key " + (e.k === "money" ? "key--dep" : e.k === "sell" ? "key--sell" : "key--line key--b");
          const s = document.createElement("span");
          s.textContent = e.title;
          li.append(k, s);
          list.appendChild(li);
        });
        if (hits.length > 4) {
          const li = document.createElement("li");
          li.textContent = `and ${hits.length - 4} more`;
          list.appendChild(li);
        }
        tip.appendChild(list);
      }
      tip.hidden = false;
      const scale = plot.clientWidth / W;
      const tw = tip.offsetWidth;
      let left = x * scale + 14;
      if (left + tw > plot.clientWidth) left = x * scale - tw - 14;
      tip.style.transform = `translate(${Math.max(0, left)}px, 8px)`;
    }

    function hide() {
      state.index = null;
      if (!tip) return;
      tip.hidden = true;
      [cross, dot, dotB].forEach((n) => n.setAttribute("visibility", "hidden"));
    }

    plot.addEventListener("keydown", (ev) => {
      if (!geom) return;
      const n = geom.pts.length;
      if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
        ev.preventDefault();
        const i = state.index == null ? n - 1 : state.index + (ev.key === "ArrowLeft" ? -1 : 1);
        show(Math.max(0, Math.min(n - 1, i)));
      } else if (ev.key === "Escape") hide();
    });
    plot.addEventListener("focus", () => { if (geom && state.index == null) show(geom.pts.length - 1); });
    plot.addEventListener("blur", hide);

    box.querySelectorAll("[data-range]").forEach((b) => b.addEventListener("click", () => {
      state.range = b.dataset.range;
      state.index = null;
      box.querySelectorAll("[data-range]").forEach((x) => { x.classList.toggle("is-active", x === b); x.setAttribute("aria-pressed", String(x === b)); });
      render();
    }));
    box.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => {
      state.view = b.dataset.view;
      state.index = null;
      box.querySelectorAll("[data-view]").forEach((x) => { x.classList.toggle("is-active", x === b); x.setAttribute("aria-pressed", String(x === b)); });
      render();
    }));
    let lastWidth = 0;
    if ("ResizeObserver" in window) {
      new ResizeObserver(() => { if (Math.abs(plot.clientWidth - lastWidth) > 2) { lastWidth = plot.clientWidth; render(); } }).observe(plot);
    } else {
      window.addEventListener("resize", render);
    }
    new MutationObserver(render).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);
    render();
  }

  onScroll();
})();
