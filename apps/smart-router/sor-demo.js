/* Smart order router demo: the research simulator, running in the browser.
   The Python package runs unchanged inside a Web Worker (Pyodide); this file draws the controls and charts.
   Mount point: <div id="sor-demo" data-base="/apps/smart-router/"></div> */
(() => {
  "use strict";
  const root = document.getElementById("sor-demo");
  if (!root) return;
  const BASE = new URL(root.dataset.base || "./", location.href).href;
  const NS = "http://www.w3.org/2000/svg";

  const STRATS = [
    ["nbbo", "Naive NBBO sweep", "Crosses the spread, venues ranked by displayed price only, all child orders sent at once."],
    ["post_primary", "Post on primary", "Rests each slice on the primary venue, crosses for what is left."],
    ["post_queue", "Queue-aware post", "Rests where the expected cost is lowest given the queue ahead, fees and fitted fill outcomes."],
    ["smart", "Smart router", "Cont-Kukanov split across venues, queue-aware re-posting, synchronised model-based taking, dark ping."],
    ["primary", "Primary only", "Crosses the spread on the primary venue alone."],
    ["fee", "Fee-aware sweep", "Crosses the spread, venues ranked by all-in price (fees and rebates)."],
    ["sync", "Synchronised sweep", "Fee-aware, with send times staggered so every child order arrives at once."],
    ["model", "Model-based sweep", "Synchronised, sized by each venue's fitted fill rate, dark pool first."],
    ["post_rebate", "Post for rebate", "Rests on the venue paying the highest maker rebate."],
    ["post_adaptive", "Adaptive post", "Thompson sampling over venues, learning within the order."],
    ["ck", "Cont-Kukanov split", "Market order plus limit orders on several venues, from fitted fill scenarios."],
  ];
  const LABEL = Object.fromEntries(STRATS.map((s) => [s[0], s[1]]));
  const DEFAULT = ["nbbo", "post_primary", "post_queue", "smart"];
  const SCENARIOS = [
    ["baseline", "Five venues (baseline)"],
    ["fee_cap_10", "Access fees capped at $0.0010"],
    ["fast_fade", "Faster fading, stronger impact"],
    ["high_vol", "Higher volatility"],
    ["wide_latency", "Wider latency gaps"],
    ["homogeneous", "Four identical venues (control)"],
  ];
  const VENUE_NOTE = {
    ALPHA: "primary, maker-taker", BRAVO: "high rebate", CHARLIE: "inverted", DELTA: "speed bump", ECHO: "dark midpoint",
  };

  const state = {
    scenario: "baseline", side: 0, qty: 20000, schedule: "patient", seed: 1,
    picked: new Set(DEFAULT), results: [], focus: null, frame: 0, busy: false,
    mc: { seeds: [], rows: [], next: 1, key: "" },
  };
  let summary = null;

  // ------------------------------------------------------------------ small helpers
  const h = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid != null) n.append(kid.nodeType ? kid : document.createTextNode(kid));
    return n;
  };
  const s = (name, attrs, parent) => {
    const n = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
    if (parent) parent.appendChild(n);
    return n;
  };
  const css = (el, name) => getComputedStyle(el).getPropertyValue(name).trim();
  const fmtInt = (x) => Math.round(x).toLocaleString("en-US");
  const minus = (x) => (x < 0 ? "−" : "");
  const bps = (x, d = 2) => (x == null || !isFinite(x) ? "–" : minus(x) + Math.abs(x).toFixed(d));
  const sbps = (x, d = 2) => (x == null || !isFinite(x) ? "–" : (x > 0 ? "+" : minus(x)) + Math.abs(x).toFixed(d));
  const pct = (x) => (x == null || !isFinite(x) ? "–" : Math.round(x * 100) + "%");
  const usd = (pu) => "$" + (pu / 10000).toFixed(2);
  const usd4 = (pu) => "$" + (pu / 10000).toFixed(4);
  const money = (x) => (x < 0 ? "−$" : "$") + fmtInt(Math.abs(x));
  const secs = (t) => (t < 10 ? t.toFixed(1) : Math.round(t)) + " s";
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  function niceTicks(lo, hi, count) {
    const span = hi - lo || Math.abs(hi) || 1;
    const raw = span / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / mag;
    const step = (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
    const out = [];
    for (let v = Math.floor(lo / step) * step; v <= hi + step * 0.001; v += step) out.push(Math.round(v / step) * step);
    return out.filter((v) => v >= lo - 1e-9);
  }

  // ------------------------------------------------------------------ worker
  let worker = null, readyP = null, reqId = 0;
  const pending = new Map();

  function engine() {
    if (readyP) return readyP;
    readyP = new Promise((resolve, reject) => {
      try {
        worker = new Worker(BASE + "sor-worker.js");
      } catch (e) {
        reject(e);
        return;
      }
      worker.onmessage = (ev) => {
        const m = ev.data || {};
        if (m.type === "status") setStatus("busy", m.text);
        else if (m.type === "ready") {
          setStatus("ready", `Engine ready: the Python simulator is running in your browser (loaded in ${(m.ms / 1000).toFixed(1)} s).`);
          resolve(m);
        } else if (m.type === "error" && m.id == null) reject(new Error(m.message));
        else {
          const p = pending.get(m.id);
          if (!p) return;
          pending.delete(m.id);
          if (m.type === "error") p.reject(new Error(m.message));
          else p.resolve(m.data);
        }
      };
      worker.onerror = (e) => reject(new Error(e.message || "The engine could not start."));
      worker.postMessage({ type: "init", base: BASE });
    });
    readyP.catch((e) => { setStatus("error", "The engine did not load: " + e.message); readyP = null; });
    return readyP;
  }

  function ask(type, payload) {
    const id = ++reqId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ type, id, ...payload });
    });
  }

  // ------------------------------------------------------------------ layout
  const status = h("span", { class: "sor__status", "data-state": "idle", role: "status", "aria-live": "polite" },
    "The simulator loads when you press Run (about 7 MB, once).");
  const runBtn = h("button", { class: "btn btn--accent", type: "button", onclick: () => run() }, "Run the routers");
  const seedIn = h("input", { type: "number", min: "1", max: "100000", step: "1", value: "1", class: "sor__seed",
    "aria-label": "Seed", onchange: () => { state.seed = Math.max(1, parseInt(seedIn.value, 10) || 1); seedIn.value = state.seed; } });
  const scenarioSel = h("select", { "aria-label": "Market", onchange: () => { state.scenario = scenarioSel.value; resetMc(); } },
    SCENARIOS.map(([k, t]) => h("option", { value: k }, t)));
  const qtySel = h("select", { "aria-label": "Order size", onchange: () => { state.qty = +qtySel.value; resetMc(); } },
    [5000, 10000, 20000, 40000].map((q) => h("option", { value: q, selected: q === 20000 }, fmtInt(q) + " shares")));

  function seg(name, options, current, onPick) {
    const wrap = h("div", { class: "seg", role: "group", "aria-label": name });
    options.forEach(([v, t]) => {
      const b = h("button", { type: "button", class: v === current ? "is-active" : "", "aria-pressed": String(v === current) }, t);
      b.addEventListener("click", () => {
        wrap.querySelectorAll("button").forEach((x) => { x.classList.toggle("is-active", x === b); x.setAttribute("aria-pressed", String(x === b)); });
        onPick(v);
      });
      wrap.append(b);
    });
    return wrap;
  }
  const sideSeg = seg("Side", [[0, "Seed decides"], [1, "Buy"], [-1, "Sell"]], 0, (v) => { state.side = v; resetMc(); });
  const schedSeg = seg("Schedule", [["patient", "Patient: 20 slices"], ["urgent", "Urgent: 5 slices"]], "patient",
    (v) => { state.schedule = v; resetMc(); });

  const chips = h("div", { class: "chips", role: "group", "aria-label": "Routers to compare" },
    STRATS.map(([k, t, d]) => {
      const b = h("button", { type: "button", class: "chipbtn" + (state.picked.has(k) ? " is-active" : ""),
        "aria-pressed": String(state.picked.has(k)), title: d }, t);
      b.addEventListener("click", () => {
        if (state.picked.has(k)) { if (state.picked.size > 1) state.picked.delete(k); } else state.picked.add(k);
        b.classList.toggle("is-active", state.picked.has(k));
        b.setAttribute("aria-pressed", String(state.picked.has(k)));
      });
      return b;
    }));

  const controls = h("div", { class: "sor__controls" },
    h("label", { class: "sor__field" }, h("span", {}, "Market"), scenarioSel),
    h("div", { class: "sor__field" }, h("span", {}, "Parent order"), h("div", { class: "sor__row" }, sideSeg, qtySel)),
    h("div", { class: "sor__field" }, h("span", {}, "Schedule (300 s)"), schedSeg),
    h("div", { class: "sor__field" }, h("span", {}, "Seed"), h("div", { class: "sor__row" }, seedIn,
      h("button", { type: "button", class: "btn btn--sm", onclick: () => { state.seed = 1 + Math.floor(Math.random() * 300); seedIn.value = state.seed; } }, "Random"))),
    h("div", { class: "sor__field sor__field--wide" }, h("span", {}, "Routers to compare"), chips),
  );
  const note = h("p", { class: "sor__note" },
    "Every router faces the same seed: the same news, the same background orders, until its own orders change the market. ",
    h("b", {}, "Seeds 1 to 300"), " are the evaluation seeds of the pre-registered experiments: with the side left to the seed and a 20,000-share order, the five-venue market reproduces the report's runs exactly.");
  const errBox = h("div", { class: "sor__err", hidden: true, role: "alert" });
  const results = h("div", { class: "sor__results", hidden: true });

  const card = h("div", { class: "sor__card" },
    h("div", { class: "sor__head" }, h("h3", {}, "Route a parent order"), status),
    controls,
    h("div", { class: "sor__go" }, runBtn, note),
    errBox,
    results,
  );
  root.classList.add("sor");
  root.replaceChildren(card);

  function setStatus(kind, text) {
    status.dataset.state = kind;
    status.textContent = text;
  }
  function showError(msg) {
    errBox.hidden = !msg;
    errBox.textContent = msg || "";
  }

  // ------------------------------------------------------------------ running
  function cfgFor(strategy, seed) {
    const urgent = state.schedule === "urgent";
    return {
      scenario: state.scenario, strategy, seed,
      parent: { side: state.side, qty: state.qty, horizon_s: 300, slices: urgent ? 5 : 20, tail_s: 60 },
      overrides: urgent ? { wait_frac: 11.25 / 60 } : {},
    };
  }

  async function run() {
    if (state.busy) return;
    state.busy = true;
    runBtn.disabled = true;
    showError("");
    const order = STRATS.map((x) => x[0]).filter((k) => state.picked.has(k));
    try {
      await engine();
      const t0 = performance.now();
      const out = [];
      for (let i = 0; i < order.length; i++) {
        setStatus("busy", `Simulating ${LABEL[order[i]]} (${i + 1} of ${order.length})…`);
        const data = JSON.parse(await ask("run", { cfg: cfgFor(order[i], state.seed) }));
        out.push(data);
        state.results = out.slice();
        if (!state.focus || !order.includes(state.focus)) state.focus = order.includes("smart") ? "smart" : order[0];
        if (state.focus === order[i] || i === order.length - 1) state.frame = 0;
        render();
      }
      const el = (performance.now() - t0) / 1000;
      setStatus("ready", `${order.length} routers on seed ${state.seed}: ${el.toFixed(1)} s of computing in your browser.`);
    } catch (e) {
      showError(String(e.message || e));
      setStatus("error", "Something went wrong.");
    } finally {
      state.busy = false;
      runBtn.disabled = false;
    }
  }

  // ------------------------------------------------------------------ rendering
  function render() {
    results.hidden = false;
    results.replaceChildren(
      tiles(), table(),
      section("Price path and fills", "The NBBO (all venues' best bid and offer, as the market saw it), the simulator's hidden fair value, and every fill of the router you pick.", focusPicker(), priceChart()),
      h("div", { class: "sor__grid2" },
        section("Where the shares went", "Shares filled on each venue, per router. Hover a segment for the passive and aggressive split.", null, mixChart()),
        section("What the router decided", "Its own log: slice plans, Cont-Kukanov allocations, sweeps with their send delays, dark pings.", null, decisionLog())),
      section("Order books", "Top three levels on each lit venue as the order unfolds (the true books, not the router's delayed view).", null, books()),
      monteCarlo(),
    );
  }

  function section(title, sub, extra, body) {
    return h("section", { class: "sor__section" },
      h("header", {}, h("div", {}, h("h3", {}, title), sub ? h("p", {}, sub) : null), extra),
      body);
  }

  function byName(k) { return state.results.find((r) => r.strategy === k); }

  function tiles() {
    const rs = state.results;
    const best = rs.reduce((a, b) => (b.metrics.is_bps < a.metrics.is_bps ? b : a), rs[0]);
    const ref = byName("smart") || best;
    const notional = (r) => r.metrics.qty * (r.arrival_mid / 10000);
    const vs = (k) => {
      const b = byName(k);
      if (!b || b === ref) return null;
      const d = ref.metrics.is_bps - b.metrics.is_bps;
      const dollars = money((Math.abs(d) / 1e4) * notional(ref));
      return h("div", { class: "stat" }, h("span", {}, `${ref.label} vs ${b.label}`),
        h("b", {}, `${sbps(d)} bps`), h("small", {}, d <= 0 ? `${dollars} cheaper on this order` : `${dollars} dearer on this order`));
    };
    return h("div", { class: "stats" },
      h("div", { class: "stat" }, h("span", {}, "Cheapest on this seed"), h("b", {}, best.label),
        h("small", {}, `${bps(best.metrics.is_bps)} bps shortfall`)),
      vs("nbbo"), vs("post_primary"),
      h("div", { class: "stat" }, h("span", {}, "Arrival mid"), h("b", {}, usd(rs[0].arrival_mid)),
        h("small", {}, `${rs[0].side > 0 ? "buy" : "sell"} ${fmtInt(rs[0].qty)} over ${rs[0].horizon_s} s`)),
    );
  }

  function table() {
    const rs = state.results;
    const maxAbs = Math.max(0.5, ...rs.map((r) => Math.abs(r.metrics.is_bps)));
    const best = Math.min(...rs.map((r) => r.metrics.is_bps));
    const rows = rs.map((r) => {
      const m = r.metrics;
      const w = (Math.abs(m.is_bps) / maxAbs) * 50;
      const bar = h("span", { class: "isbar", "aria-hidden": "true" });
      const fill = h("i", { class: m.is_bps < 0 ? "neg" : "" });
      fill.style.width = w + "%";
      fill.style.left = m.is_bps < 0 ? 50 - w + "%" : "50%";
      bar.append(fill);
      return h("tr", { class: m.is_bps === best ? "is-best" : "" },
        h("td", {}, r.label),
        h("td", { class: "num" }, bar, bps(m.is_bps)),
        h("td", { class: "num" }, bps(m.price_bps)),
        h("td", { class: "num" }, bps(m.fee_bps)),
        h("td", { class: "num" }, pct(m.maker_share)),
        h("td", { class: "num" }, m.fade_rate == null ? "–" : pct(m.fade_rate)),
        h("td", { class: "num" }, pct(m.dark_fill / m.qty)),
        h("td", { class: "num" }, fmtInt(m.n_children)),
        h("td", { class: "num" }, m.complete_s == null ? "–" : secs(m.complete_s)));
    });
    return h("div", { class: "table-wrap" }, h("table", { class: "data" },
      h("caption", { class: "sr-only" }, "Execution quality by router, this seed"),
      h("thead", {}, h("tr", {},
        h("th", { scope: "col" }, "Router"),
        h("th", { scope: "col", class: "num", title: "Implementation shortfall vs the arrival mid, fees included; negative = better than the mid" }, "Shortfall, bps"),
        h("th", { scope: "col", class: "num" }, "Price"), h("th", { scope: "col", class: "num" }, "Fees"),
        h("th", { scope: "col", class: "num", title: "Share filled by resting orders" }, "Passive"),
        h("th", { scope: "col", class: "num", title: "Displayed liquidity gone by the time an IOC arrived" }, "Faded"),
        h("th", { scope: "col", class: "num" }, "Dark"),
        h("th", { scope: "col", class: "num" }, "Child orders"),
        h("th", { scope: "col", class: "num" }, "Done at"))),
      h("tbody", {}, rows)));
  }

  function focusPicker() {
    const opts = state.results.map((r) => [r.strategy, r.label]);
    return seg("Router shown", opts, state.focus, (v) => { state.focus = v; state.frame = 0; render(); });
  }

  function chartBox(legend, draw, label) {
    const plot = h("div", { class: "chart__plot", role: "img", "aria-label": label });
    const box = h("figure", { class: "chart" }, legend, plot);
    requestAnimationFrame(() => draw(plot));
    const ro = "ResizeObserver" in window ? new ResizeObserver(() => draw(plot)) : null;
    if (ro) ro.observe(plot);
    plot._redraw = () => draw(plot);
    return box;
  }

  // price path + fills -------------------------------------------------------
  function priceChart() {
    const r = byName(state.focus) || state.results[0];
    const legend = h("div", { class: "chart__legend" },
      h("span", {}, h("i", { class: "key key--nbbo" }), "NBBO bid and offer"),
      h("span", {}, h("i", { class: "key key--line key--fair" }), "Fair value (hidden from the router)"),
      h("span", {}, h("i", { class: "mk mk--pass" }), "Passive fill"),
      h("span", {}, h("i", { class: "mk mk--take" }), "Aggressive fill"),
      h("span", {}, h("i", { class: "mk mk--dark" }), "Dark fill"));
    return chartBox(legend, (plot) => drawPrice(plot, r), `Price path and fills for ${r.label}`);
  }

  function drawPrice(plot, r) {
    const W = Math.max(plot.clientWidth, 300);
    const H = W < 560 ? 240 : 300;
    const M = { l: 58, r: 14, t: 10, b: 30 };
    const S = r.samples.map((x) => x[0]);
    const T = r.horizon_s + 60;
    const darkIdx = r.venues.indexOf("ECHO");
    let lo = Infinity, hi = -Infinity;
    S.forEach(([, b, a, f]) => { if (b != null) lo = Math.min(lo, b, f); if (a != null) hi = Math.max(hi, a, f); });
    r.fills.forEach((f) => { lo = Math.min(lo, f[2]); hi = Math.max(hi, f[2]); });
    const pad = Math.max(50, (hi - lo) * 0.06);
    lo -= pad; hi += pad;
    const ticks = niceTicks(lo / 10000, hi / 10000, 5).map((v) => Math.round(v * 10000));
    const X = (t) => M.l + (t / T) * (W - M.l - M.r);
    const Y = (p) => M.t + (1 - (p - lo) / (hi - lo)) * (H - M.t - M.b);
    plot.replaceChildren();
    const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H });
    plot.append(svg);
    const c = { grid: css(plot, "--grid"), base: css(plot, "--base"), bid: css(plot, "--bid"), ask: css(plot, "--ask"),
      fair: css(plot, "--fair"), acc: css(plot, "--accent"), pass: css(plot, "--pass"), ink: css(plot, "--ink-2"),
      surf: css(plot, "--surface"), dark: css(plot, "--v4") };
    ticks.forEach((p) => {
      if (p < lo || p > hi) return;
      s("line", { x1: M.l, x2: W - M.r, y1: Y(p), y2: Y(p), stroke: c.grid, "stroke-width": 1, "shape-rendering": "crispEdges" }, svg);
      s("text", { x: M.l - 8, y: Y(p) + 4, "text-anchor": "end", class: "axis" }, svg).textContent = usd(p);
    });
    for (let t = 0; t <= T; t += 60) {
      s("line", { x1: X(t), x2: X(t), y1: H - M.b, y2: H - M.b + 4, stroke: c.base }, svg);
      s("text", { x: X(t), y: H - 10, "text-anchor": "middle", class: "axis" }, svg).textContent = t + " s";
    }
    s("line", { x1: X(r.horizon_s), x2: X(r.horizon_s), y1: M.t, y2: H - M.b, stroke: c.base, "stroke-width": 1 }, svg);
    s("text", { x: X(r.horizon_s) - 6, y: M.t + 12, "text-anchor": "end", class: "lbl--muted" }, svg).textContent = "horizon";
    // NBBO band + edges
    let band = "", bidPath = "", askPath = "", fairPath = "";
    S.forEach(([t, b, a, f], i) => {
      const x = X(t).toFixed(1);
      if (b != null) bidPath += (bidPath ? `H${x}V` : `M${x},`) + Y(b).toFixed(1);
      if (a != null) askPath += (askPath ? `H${x}V` : `M${x},`) + Y(a).toFixed(1);
      fairPath += (i ? "L" : "M") + x + "," + Y(f).toFixed(1);
    });
    const tops = S.filter((x) => x[2] != null && x[1] != null);
    if (tops.length) {
      band = "M" + tops.map((x) => `${X(x[0]).toFixed(1)},${Y(x[2]).toFixed(1)}`).join("L") +
        "L" + tops.slice().reverse().map((x) => `${X(x[0]).toFixed(1)},${Y(x[1]).toFixed(1)}`).join("L") + "Z";
      s("path", { d: band, fill: c.acc, "fill-opacity": 0.1, stroke: "none" }, svg);
    }
    s("path", { d: bidPath, fill: "none", stroke: c.bid, "stroke-width": 1.5, "stroke-linejoin": "round" }, svg);
    s("path", { d: askPath, fill: "none", stroke: c.ask, "stroke-width": 1.5, "stroke-linejoin": "round" }, svg);
    s("path", { d: fairPath, fill: "none", stroke: c.fair, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
    // fills
    const marks = [];
    r.fills.forEach((f) => {
      const [t, vi, px, q, liq, fee] = f;
      const x = X(t), y = Y(px);
      let node;
      if (vi === darkIdx) node = s("rect", { x: x - 4.5, y: y - 4.5, width: 9, height: 9, transform: `rotate(45 ${x} ${y})`, fill: c.dark, stroke: c.surf, "stroke-width": 2 }, svg);
      else if (liq === "M") node = s("circle", { cx: x, cy: y, r: 4.5, fill: c.pass, stroke: c.surf, "stroke-width": 2 }, svg);
      else node = s("path", { d: `M${x - 5.5},${y + 4.5}L${x + 5.5},${y + 4.5}L${x},${y - 5.5}Z`, fill: c.ink, stroke: c.surf, "stroke-width": 1.5, "stroke-linejoin": "round" }, svg);
      marks.push({ x, y, f, node });
    });
    // hover
    const cross = s("line", { y1: M.t, y2: H - M.b, stroke: c.base, visibility: "hidden" }, svg);
    const hit = s("rect", { x: M.l, y: 0, width: W - M.l - M.r, height: H, fill: "transparent" }, svg);
    const tip = h("div", { class: "tip", hidden: true });
    plot.append(tip);
    const showAt = (px, py) => {
      let near = null, dist = 12;
      marks.forEach((m) => { const d = Math.hypot(m.x - px, m.y - py); if (d < dist) { dist = d; near = m; } });
      const tt = ((px - M.l) / (W - M.l - M.r)) * T;
      let i = 0;
      while (i < S.length - 1 && S[i + 1][0] <= tt) i++;
      const [t, b, a, f] = S[i];
      cross.setAttribute("x1", px); cross.setAttribute("x2", px); cross.setAttribute("visibility", "visible");
      tip.replaceChildren(h("span", { class: "tip__date" }, `t = ${t.toFixed(1)} s`));
      const row = (k, v) => tip.append(h("div", { class: "tip__row" }, h("b", {}, v), h("span", {}, k)));
      if (near) {
        const [ft, vi, fpx, q, liq, fee] = near.f;
        tip.firstChild.textContent = `Fill at ${ft.toFixed(2)} s`;
        row(r.venues[vi] + (VENUE_NOTE[r.venues[vi]] ? ` (${VENUE_NOTE[r.venues[vi]]})` : ""), fmtInt(q));
        row(vi === darkIdx ? "midpoint" : liq === "M" ? "passive" : "aggressive", usd4(fpx));
        row(fee < 0 ? "rebate per share" : "fee per share", "$" + (Math.abs(fee) / 10000).toFixed(4));
      } else {
        if (b != null) row("best bid", usd(b));
        if (a != null) row("best offer", usd(a));
        row("fair value", usd4(f));
      }
      tip.hidden = false;
      const scale = plot.clientWidth / W;
      let left = px * scale + 14;
      if (left + tip.offsetWidth > plot.clientWidth) left = px * scale - tip.offsetWidth - 14;
      tip.style.transform = `translate(${Math.max(0, left)}px, 8px)`;
    };
    hit.addEventListener("pointermove", (ev) => {
      const rect = svg.getBoundingClientRect();
      showAt(((ev.clientX - rect.left) / rect.width) * W, ((ev.clientY - rect.top) / rect.height) * H);
    });
    hit.addEventListener("pointerleave", () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); });
  }

  // venue mix -----------------------------------------------------------------
  function mixChart() {
    const names = state.results[0].venues;
    const legend = h("div", { class: "chart__legend" },
      names.map((n, i) => h("span", {}, h("i", { class: `key key--sq key--v${i}` }), n)));
    return chartBox(legend, drawMix, "Shares filled on each venue, per router");
  }

  function drawMix(plot) {
    const rs = state.results;
    const names = rs[0].venues;
    const W = Math.max(plot.clientWidth, 260);
    const rowH = 30, M = { l: Math.min(150, W * 0.38), r: 44, t: 4, b: 6 };
    const H = M.t + M.b + rowH * rs.length;
    plot.replaceChildren();
    const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H });
    plot.append(svg);
    const colors = names.map((_, i) => css(plot, `--v${i}`));
    const surf = css(plot, "--surface");
    const tip = h("div", { class: "tip", hidden: true });
    plot.append(tip);
    rs.forEach((r, j) => {
      const y = M.t + j * rowH + 7;
      s("text", { x: M.l - 10, y: y + 12, "text-anchor": "end", class: "lbl" }, svg).textContent = r.label;
      const total = r.metrics.filled || 1;
      let x = M.l;
      const span = W - M.l - M.r;
      names.forEach((n, i) => {
        const q = r.metrics.venue_qty[n] || 0;
        if (!q) return;
        const w = Math.max(1, (q / total) * span - 2);
        const rect = s("rect", { x, y, width: w, height: 16, rx: 3, fill: colors[i] }, svg);
        const maker = (r.metrics.venue_maker || {})[n] || 0;
        rect.addEventListener("pointermove", (ev) => {
          tip.replaceChildren(h("span", { class: "tip__date" }, `${r.label}: ${n}`),
            h("div", { class: "tip__row" }, h("b", {}, fmtInt(q)), h("span", {}, `shares (${pct(q / total)})`)),
            h("div", { class: "tip__row" }, h("b", {}, pct(maker / q)), h("span", {}, "passive")));
          tip.hidden = false;
          const rect2 = plot.getBoundingClientRect();
          let left = ev.clientX - rect2.left + 12;
          if (left + tip.offsetWidth > plot.clientWidth) left -= tip.offsetWidth + 24;
          tip.style.transform = `translate(${Math.max(0, left)}px, ${ev.clientY - rect2.top + 10}px)`;
        });
        rect.addEventListener("pointerleave", () => { tip.hidden = true; });
        x += w + 2;
      });
      s("text", { x: W - M.r + 8, y: y + 12, class: "lbl--muted" }, svg).textContent = pct(r.metrics.maker_share);
    });
    void surf;
  }

  // decision log ----------------------------------------------------------------
  function decisionLog() {
    const r = byName(state.focus) || state.results[0];
    const V = r.venues;
    const items = [];
    r.notes.forEach((n) => {
      let text = "";
      if (n.kind === "slice") text = `Slice ${n.i + 1}: ${fmtInt(n.need)} shares due, ${n.plan.startsWith("take") ? "cross the spread now" : "rest first"}.`;
      else if (n.kind === "ck") {
        const parts = Object.entries(n.L).filter(([, q]) => q > 0).map(([v, q]) => `${V[+v]} ${fmtInt(q)}`);
        text = `Slice ${n.i + 1}: Cont-Kukanov split of ${fmtInt(n.need)}: market order ${fmtInt(n.M)}` +
          (parts.length ? `, limit orders ${parts.join(" · ")}` : "") +
          (n.exp_cost != null ? ` (expected cost ${sbps((n.exp_cost / r.arrival_mid) * 1e4, 2)} bps vs the mid at the end of the wait).` : ".");
      } else if (n.kind === "post") text = `Rest ${fmtInt(n.qty)} on ${V[n.venue]} at ${usd(n.price)}, behind ${fmtInt(n.ahead)} shares.`;
      else if (n.kind === "wave") {
        const parts = n.children.map(([v, q, px, d]) => `${V[v]} ${fmtInt(q)} up to ${usd(px)}${d ? ` (sent ${Math.round(d / 1000)} µs later)` : ""}`);
        text = `Sweep${n.escal ? ` (limit +${n.escal} tick${n.escal > 1 ? "s" : ""})` : ""}: ${parts.join(" · ")}.`;
      } else if (n.kind === "dark") text = `Ping ${V[n.venue]} (dark) for ${fmtInt(n.qty)} at the midpoint.`;
      else return;
      items.push(h("li", {}, h("time", {}, n.t.toFixed(3) + " s"), h("span", {}, text)));
    });
    if (!items.length) items.push(h("li", {}, h("time", {}, ""), h("span", {}, "No decisions logged.")));
    return h("ol", { class: "sor__log", "aria-label": `Decision log of ${r.label}` }, items.slice(0, 250));
  }

  // order books -----------------------------------------------------------------
  let playTimer = null;
  function books() {
    const r = byName(state.focus) || state.results[0];
    const n = r.samples.length;
    const out = h("output", {}, "");
    const slider = h("input", { type: "range", min: 0, max: n - 1, step: 1, value: state.frame, "aria-label": "Time" });
    const grid = h("div", { class: "sor__books" });
    const draw = () => {
      const [row, venues] = r.samples[state.frame];
      out.textContent = row[0].toFixed(1) + " s";
      const nbBid = row[1], nbAsk = row[2];
      let maxQ = 1;
      venues.forEach(([b, a]) => b.concat(a).forEach(([, q]) => { maxQ = Math.max(maxQ, q); }));
      grid.replaceChildren(...venues.map(([bids, asks], k) => {
        const vi = r.lit[k];
        const name = r.venues[vi];
        const lvl = (side, [p, q], nb) => {
          const bar = h("span", { class: "bar" });
          bar.style.width = Math.max(2, (q / maxQ) * 100) + "%";
          return h("div", { class: `sor__lvl sor__lvl--${side}` + (p === nb ? " is-nbbo" : "") },
            h("span", {}, usd(p)), bar, h("span", { class: "q" }, fmtInt(q)));
        };
        return h("div", { class: "sor__book" },
          h("h4", {}, h("i", { class: `key key--sq key--v${vi}` }), name, h("small", {}, VENUE_NOTE[name] || "")),
          ...asks.slice().reverse().map((x) => lvl("ask", x, nbAsk)),
          h("div", { class: "sor__lvl sor__lvl--gap" }),
          ...bids.map((x) => lvl("bid", x, nbBid)));
      }));
    };
    slider.addEventListener("input", () => { state.frame = +slider.value; draw(); });
    const play = h("button", { type: "button", class: "btn btn--sm" }, "Play");
    play.addEventListener("click", () => {
      if (playTimer) { clearInterval(playTimer); playTimer = null; play.textContent = "Play"; return; }
      play.textContent = "Pause";
      playTimer = setInterval(() => {
        state.frame = (state.frame + 1) % n;
        slider.value = state.frame;
        draw();
        if (state.frame === n - 1) { clearInterval(playTimer); playTimer = null; play.textContent = "Play"; }
      }, reduceMotion ? 400 : 100);
    });
    draw();
    return h("div", {}, h("div", { class: "sor__time" }, play, slider, out), grid);
  }

  // many seeds ------------------------------------------------------------------
  function resetMc() { state.mc = { seeds: [], rows: [], next: 1, key: "" }; }

  function mcKey() { return [state.scenario, state.side, state.qty, state.schedule].join("|"); }

  function monteCarlo() {
    const sum = h("p", { class: "sor__note" });
    const btn = h("button", { type: "button", class: "btn btn--sm" }, "Run 10 more seeds");
    const plotWrap = h("div");
    const update = () => {
      const pairs = mcPairs();
      plotWrap.replaceChildren();
      if (!pairs.length) {
        sum.textContent = "Runs the smart router and the two naive routers on evaluation seeds 1, 2, 3… and shows the per-seed difference. One seed is an anecdote; this is how the report's confidence intervals are built.";
        return;
      }
      sum.replaceChildren(...pairs.map((p, i) => [i ? " " : "", h("b", {}, `Smart − ${LABEL[p.base]}: ${sbps(p.mean)} bps`),
        ` (95% interval ${sbps(p.lo)} to ${sbps(p.hi)}, ${p.n} seeds, smart cheaper on ${p.wins} of ${p.n}).`]).flat());
      plotWrap.append(chartBox(h("div", { class: "chart__legend" },
        h("span", {}, "Each dot is one seed: smart router's shortfall minus the comparator's (bps). Left of zero = the smart router was cheaper.")),
      (plot) => drawMc(plot, pairs), "Per-seed shortfall differences"));
    };
    btn.addEventListener("click", async () => {
      if (state.busy) return;
      state.busy = true;
      btn.disabled = true;
      runBtn.disabled = true;
      showError("");
      try {
        await engine();
        if (state.mc.key !== mcKey()) { resetMc(); state.mc.key = mcKey(); }
        const strategies = ["smart", "nbbo", "post_primary"];
        for (let k = 0; k < 10; k++) {
          const seed = state.mc.next++;
          setStatus("busy", `Seed ${seed}: ${strategies.length} routers (${k + 1} of 10)…`);
          const cfg = cfgFor("smart", seed);
          delete cfg.strategy;
          const rows = JSON.parse(await ask("metrics", { cfg: { ...cfg, strategies, seeds: [seed] } }));
          state.mc.rows.push(...rows);
          state.mc.seeds.push(seed);
          update();
        }
        setStatus("ready", `${state.mc.seeds.length} seeds simulated.`);
      } catch (e) {
        showError(String(e.message || e));
        setStatus("error", "Something went wrong.");
      } finally {
        state.busy = false;
        btn.disabled = false;
        runBtn.disabled = false;
      }
    });
    update();
    const ref = summaryLine();
    return section("Is it luck? Run more seeds", "", null, h("div", {}, h("div", { class: "sor__mc" }, btn, sum), ref, plotWrap));
  }

  function mcPairs() {
    const out = [];
    const by = {};
    state.mc.rows.forEach((r) => { (by[r.seed] = by[r.seed] || {})[r.strategy] = r.is_bps; });
    ["nbbo", "post_primary"].forEach((base) => {
      const d = Object.values(by).filter((x) => x.smart != null && x[base] != null).map((x) => x.smart - x[base]);
      if (d.length < 2) return;
      const n = d.length, mean = d.reduce((a, b) => a + b, 0) / n;
      const sd = Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
      const t = n > 30 ? 1.96 : [12.71, 4.30, 3.18, 2.78, 2.57, 2.45, 2.36, 2.31, 2.26, 2.23, 2.20, 2.18, 2.16, 2.14, 2.13, 2.12, 2.11, 2.10, 2.09, 2.09, 2.08, 2.07, 2.07, 2.06, 2.06, 2.06, 2.05, 2.05, 2.05][n - 2] || 2.04;
      out.push({ base, d, n, mean, lo: mean - t * sd / Math.sqrt(n), hi: mean + t * sd / Math.sqrt(n), wins: d.filter((x) => x < 0).length });
    });
    return out;
  }

  function summaryLine() {
    if (!summary || !summary.headline) return null;
    const key = state.schedule === "urgent" ? "urgent" : "patient";
    const rows = (summary.headline[key] || []).filter((x) => x.scenario === state.scenario);
    if (!rows.length || state.qty !== 20000) return null;
    return h("p", { class: "sor__note" }, "Pre-registered result on 300 seeds (this market, this schedule): ",
      ...rows.map((x, i) => [i ? "; " : "", h("b", {}, `smart − ${LABEL[x.baseline]} ${sbps(x.mean)} bps`), ` [${sbps(x.lo)}, ${sbps(x.hi)}]`]).flat(), ".");
  }

  function drawMc(plot, pairs) {
    const W = Math.max(plot.clientWidth, 280);
    const rowH = 56, M = { l: Math.min(150, W * 0.36), r: 16, t: 8, b: 28 };
    const H = M.t + M.b + rowH * pairs.length;
    const all = pairs.flatMap((p) => p.d.concat([p.lo, p.hi, 0]));
    let lo = Math.min(...all), hi = Math.max(...all);
    const pad = (hi - lo) * 0.08 || 0.5;
    lo -= pad; hi += pad;
    const X = (v) => M.l + ((v - lo) / (hi - lo)) * (W - M.l - M.r);
    plot.replaceChildren();
    const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H });
    plot.append(svg);
    const c = { grid: css(plot, "--grid"), base: css(plot, "--base"), acc: css(plot, "--accent"), surf: css(plot, "--surface"), ink: css(plot, "--ink-2") };
    niceTicks(lo, hi, 5).forEach((v) => {
      if (v < lo || v > hi) return;
      s("line", { x1: X(v), x2: X(v), y1: M.t, y2: H - M.b, stroke: v === 0 ? c.base : c.grid, "stroke-width": 1, "shape-rendering": "crispEdges" }, svg);
      s("text", { x: X(v), y: H - 9, "text-anchor": "middle", class: "axis" }, svg).textContent = sbps(v, Math.abs(hi - lo) < 4 ? 1 : 0);
    });
    pairs.forEach((p, j) => {
      const y = M.t + j * rowH + rowH / 2;
      s("text", { x: M.l - 10, y: y + 4, "text-anchor": "end", class: "lbl" }, svg).textContent = "vs " + LABEL[p.base];
      p.d.forEach((v, i) => {
        const jitter = ((i * 37) % 11 - 5) * 1.6;
        s("circle", { cx: X(v), cy: y + jitter, r: 4, fill: c.acc, "fill-opacity": 0.55, stroke: c.surf, "stroke-width": 1.5 }, svg);
      });
      s("line", { x1: X(p.lo), x2: X(p.hi), y1: y + 17, y2: y + 17, stroke: c.ink, "stroke-width": 2, "stroke-linecap": "round" }, svg);
      s("circle", { cx: X(p.mean), cy: y + 17, r: 4.5, fill: c.ink, stroke: c.surf, "stroke-width": 2 }, svg);
    });
  }

  // ------------------------------------------------------------------ theme + boot
  const redrawAll = () => results.querySelectorAll(".chart__plot").forEach((p) => p._redraw && p._redraw());
  new MutationObserver(redrawAll).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", redrawAll);

  fetch(BASE + "summary.json").then((r) => (r.ok ? r.json() : null)).then((j) => { summary = j; }).catch(() => {});

  // Start loading the engine when the demo scrolls into view, then run the default comparison once.
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        engine().then(() => { if (!state.results.length) run(); }).catch(() => {});
      }
    }, { rootMargin: "200px" });
    io.observe(root);
  }
})();
