/* Cross-asset RV scanner: UI. Data: data/catalog.json (summary of every relationship), data/rel/<id>.json
   (series for one relationship, loaded on demand), data/open/<group>.json (open-data series for the pair builder). */
(function () {
  "use strict";
  const S = window.RVStats, C = window.RVChart;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const isF = S.isF;
  const state = {
    meta: null, rels: [], byId: {}, cache: {}, open: {}, verdicts: {},
    p: { entry: 2, exit: 0.5, stop: 4, lookback: 126, maxHold: 126, lag: 1, costMult: 1, useBand: true },
    f: { classes: new Set(), tiers: new Set(), types: new Set(), status: null, q: "", onlyExec: false },
    sort: { k: "rank", d: 1 }, current: null,
  };
  const STATUS = ["executable", "executable (not enforceable)", "statistical signal", "watch", "no signal", "monitor", "insufficient data"];
  const STATUS_LABEL = { "executable": "Executable", "executable (not enforceable)": "Executable, not enforceable",
    "statistical signal": "Statistical signal", "watch": "Watch (fails a check)", "no signal": "No signal",
    "monitor": "Monitor only", "insufficient data": "Insufficient data" };
  const TIER_LABEL = { arbitrage: "Arbitrage", quasi: "Economic link", statistical: "Statistical" };
  const slug = (s) => s.toLowerCase().replace(/[^a-z]+/g, "-").replace(/^-|-$/g, "");
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const num = (v, d = 2) => (isF(v) ? v.toFixed(d) : "–");
  const signed = (v, d = 1) => (isF(v) ? (v > 0 ? "+" : "") + v.toFixed(d) : "–");
  const money = (v) => !isF(v) ? "–" : v >= 1e9 ? `$${(v / 1e9).toFixed(1)}bn` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}m` : v >= 1e3 ? `$${(v / 1e3).toFixed(0)}k` : `$${v.toFixed(0)}`;
  const pct = (v, d = 0) => (isF(v) ? (100 * v).toFixed(d) + "%" : "–");
  const hl = (v) => (!isF(v) ? "none" : v > 999 ? ">999" : v.toFixed(v < 10 ? 1 : 0));
  const unitLabel = (r) => (r.unit === "usd" ? "$/bbl" : r.unit === "yield_bp" ? "bp of yield" : "bp");
  const per = (r) => (r.freq === "M" ? "months" : "days");
  const badge = (cls, txt) => `<span class="badge ${cls}">${esc(txt)}</span>`;
  const tierBadge = (t) => badge("tier-" + t, TIER_LABEL[t] || t);
  const statusBadge = (s) => badge("st-" + slug(s), STATUS_LABEL[s] || s);

  // ------------------------------------------------------------------------------------------ boot
  async function boot() {
    const res = await fetch("data/catalog.json");
    const cat = await res.json();
    state.meta = cat.meta;
    state.rels = cat.relationships;
    for (const r of state.rels) state.byId[r.id] = r;
    $("#asof").textContent = state.meta.asof;
    fillResearchSpans();
    buildFilters();
    bindTabs();
    bindParams();
    rescan();
    route();
    window.addEventListener("hashchange", route);
    window.addEventListener("storage", (e) => { if (e.key === "theme") { applyTheme(e.newValue); } });
    try { if (window.parent !== window) { const t = window.parent.document.documentElement.getAttribute("data-theme"); if (t) applyTheme(t); } } catch (e) { /* cross-origin */ }
    resizeParent();
    new ResizeObserver(resizeParent).observe(document.querySelector(".app"));
  }
  function applyTheme(t) { if (t) document.documentElement.setAttribute("data-theme", t); else document.documentElement.removeAttribute("data-theme"); redrawCharts(); }
  function resizeParent() {
    // Size the embedding iframe to the app's CONTENT height. documentElement.scrollHeight can't be used: inside an
    // iframe it is never smaller than the iframe itself, so the height could only ever grow.
    try {
      if (!window.frameElement) return;
      const app = document.querySelector(".app");
      const h = Math.max(600, Math.ceil(app.getBoundingClientRect().height) + 24);
      const cur = parseInt(window.frameElement.style.height || "0", 10);
      if (Math.abs(cur - h) > 4) window.frameElement.style.height = h + "px";
    } catch (e) { /* cross-origin */ }
  }
  const charts = new Set();
  function chart(el, opts) { const c = new C.LineChart(el, opts); charts.add(c); return c; }
  function redrawCharts() { for (const c of charts) if (document.body.contains(c.el)) c.draw(); else charts.delete(c); }

  function fillResearchSpans() {
    const e2 = state.meta.research?.e2 || {};
    $$("[data-r]").forEach((el) => {
      const k = el.getAttribute("data-r");
      if (k === "same_close_gt1") el.textContent = e2.same_close_sharpe_gt1 ?? "…";
      if (k === "base_gt1") el.textContent = e2.base_sharpe_gt1 === 0 ? "none" : (e2.base_sharpe_gt1 ?? "…");
    });
  }

  // ------------------------------------------------------------------------------------------ routing / tabs
  function bindTabs() {
    $$(".tabs button").forEach((b) => b.addEventListener("click", () => { location.hash = b.dataset.tab; }));
  }
  function showTab(tab) {
    $$(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
    for (const t of ["scan", "build", "research", "about"]) $("#tab-" + t).hidden = t !== tab;
    if (tab === "build") renderBuild();
    if (tab === "research") renderResearch();
    resizeParent();
  }
  function route() {
    const h = decodeURIComponent(location.hash.slice(1));
    if (h.startsWith("rel=")) { showTab("scan"); openDetail(h.slice(4)); return; }
    showTab(["scan", "build", "research", "about"].includes(h) ? h : "scan");
    if (h === "scan" || !h) closeDetail();
  }

  // ------------------------------------------------------------------------------------------ filters
  function buildFilters() {
    const m = state.meta;
    const classesUsed = new Set(state.rels.flatMap((r) => r.asset_classes));
    $("#f-classes").innerHTML = Object.entries(m.asset_classes).filter(([k]) => classesUsed.has(k))
      .map(([k, v]) => `<label><input type="checkbox" value="${k}" checked> ${esc(v)}</label>`).join("");
    $("#f-tiers").innerHTML = ["arbitrage", "quasi", "statistical"].map((t) => `<label><input type="checkbox" value="${t}" checked> ${tierBadge(t)}</label>`).join("");
    const typesUsed = [...new Set(state.rels.map((r) => r.type))];
    $("#f-types").innerHTML = typesUsed.map((t) => `<label><input type="checkbox" value="${t}" checked> ${esc(m.types[t] || t)}</label>`).join("");
    for (const [id, set] of [["#f-classes", state.f.classes], ["#f-tiers", state.f.tiers], ["#f-types", state.f.types]]) {
      $$(id + " input").forEach((i) => { set.add(i.value); i.addEventListener("change", () => { i.checked ? set.add(i.value) : set.delete(i.value); renderTable(); }); });
    }
    $("#q").addEventListener("input", (e) => { state.f.q = e.target.value.trim().toLowerCase(); renderTable(); });
    $("#p-only-exec").addEventListener("change", (e) => { state.f.onlyExec = e.target.checked; renderTable(); });
  }
  function bindParams() {
    const upd = () => {
      state.p.entry = +$("#p-entry").value; state.p.exit = Math.min(+$("#p-exit").value, state.p.entry - 0.25);
      state.p.costMult = +$("#p-cost").value;
      $("#v-entry").textContent = state.p.entry.toFixed(2); $("#v-exit").textContent = state.p.exit.toFixed(2);
      $("#v-cost").textContent = state.p.costMult.toFixed(2) + "×";
      rescan();
    };
    ["#p-entry", "#p-exit", "#p-cost"].forEach((id) => $(id).addEventListener("input", upd));
  }

  // ------------------------------------------------------------------------------------------ verdicts (mirror of scanners/evaluate.py)
  function bdaysBetween(a, b) {
    const d0 = new Date(a + "T00:00:00Z"), d1 = new Date(b + "T00:00:00Z"); let n = 0;
    for (let d = new Date(d0); d < d1; d.setUTCDate(d.getUTCDate() + 1)) { const w = d.getUTCDay(); if (w !== 0 && w !== 6) n++; }
    return n;
  }
  function verdict(r, p) {
    const s = r.scan;
    if (!s || s.status === "insufficient data") return { status: "insufficient data", reasons: ["fewer than 60 observations"], position: 0, edge: NaN, checks: [] };
    const reasons = [], checks = [];
    const z = s.z, dev = s.deviation;
    const isCarry = r.id.startsWith("CARRY_");
    let position = 0;
    if (isCarry) { if (isF(s.carry_to_vol) && Math.abs(s.carry_to_vol) >= 0.25) position = s.spread > 0 ? 1 : -1; }
    else if (isF(z) && Math.abs(z) >= p.entry) position = z > 0 ? -1 : 1;
    const old = bdaysBetween(s.date, state.meta.asof);
    const fresh = old <= 3;
    if (!fresh) reasons.push(`data end ${s.date} (${old} business days old)`);
    const sync = r.sync_gap_h <= 1;
    if (!sync) reasons.push(`closing prices ${r.sync_gap_h.toFixed(1)} h apart: deviation partly a timing artefact`);
    const structural = r.tier === "arbitrage" && r.fair_mode === "const";
    const H = isF(s.half_life) ? Math.min(Math.max(2 * s.half_life, 5), p.maxHold) : p.maxHold;
    let conv = 0;
    if (!isCarry && isF(s.half_life) && s.half_life > 0) conv = Math.abs(s.spread - s.ou_mu) * (1 - Math.pow(2, -H / s.half_life));
    const cost = (s.cost_rt ?? 0) / (state.meta.default_params.cost_mult || 1) * p.costMult;
    let carryH = position ? (position * (s.carry_per_period || 0) - (s.hold_per_period || 0)) * H : 0;
    if (isCarry && position) carryH = Math.abs(s.spread) * 63 / 252;
    let edge = position ? conv * (r.unit === r.pnl_unit ? 1 : 1) - cost + carryH : NaN;
    if (r.unit !== r.pnl_unit && position && isF(s.net_edge) && isF(s.cost_rt)) edge = s.net_edge + s.cost_rt - cost; // unit conversion done in Python
    const band = s.band;
    const bandOk = !(isF(band) && Math.abs(dev) <= band);
    const mr = isCarry || structural || !!s.ou_mean_reverting;
    const hlOk = isCarry || !(isF(s.half_life) && s.half_life < 1);
    const borrow = s.borrow_ok !== false;
    const dirOk = !(r.direction === "short_only" && position > 0 || r.direction === "long_only" && position < 0 || r.direction === "none");
    checks.push({ k: "Mechanism can force convergence", v: r.tier === "arbitrage" ? "ok" : r.tier === "quasi" ? "na" : "no",
                  note: r.tier === "arbitrage" ? "arbitrage relationship" : r.tier === "quasi" ? "economic link only" : "statistical only" });
    checks.push({ k: "Prices synchronous (closes within 1 h)", v: sync ? "ok" : "no", note: `${r.sync_gap_h.toFixed(1)} h apart` });
    checks.push({ k: "Outside the no-arbitrage band", v: !isF(band) ? "na" : bandOk ? "ok" : "no", note: isF(band) ? `band ${band.toFixed(1)} ${unitLabel(r)}` : "no band defined" });
    checks.push({ k: "Expected convergence covers costs", v: !position ? "na" : edge > 0 ? "ok" : "no", note: position ? `edge ${signed(edge)} ${r.pnl_unit === "yield_bp" ? "bp of yield" : "bp"}` : "no position" });
    checks.push({ k: "Mean reversion in recent history", v: mr ? "ok" : "no", note: `ADF p = ${num(s.adf_p, 2)}` });
    checks.push({ k: "Half-life above one period", v: hlOk ? "ok" : "no", note: `half-life ${hl(s.half_life)} ${per(r)}` });
    checks.push({ k: "Short leg borrowable", v: !position ? "na" : borrow && dirOk ? "ok" : "no", note: (s.borrow || []).join("; ") || "–" });
    checks.push({ k: "Data current", v: fresh ? "ok" : "no", note: `to ${s.date}` });
    checks.push({ k: "Tradable as specified", v: r.tradable ? "ok" : "no", note: r.tradable ? "" : "monitor only" });
    let status;
    if (!r.tradable) status = "monitor";
    else if (!position) status = "no signal";
    else {
      if (!bandOk) reasons.push("inside the no-arbitrage band");
      if (!mr) reasons.push(`no evidence of mean reversion in the trailing window (ADF p = ${num(s.adf_p, 2)})`);
      if (!hlOk) reasons.push("half-life under one period: mostly closing-print noise that reverts before a next-day trade");
      if (!(edge > 0)) reasons.push("expected convergence does not cover costs");
      if (!borrow) reasons.push("short leg not borrowable");
      if (!dirOk) reasons.push("direction blocked by conversion / borrow limits");
      if (reasons.length) status = "watch";
      else status = r.tier === "arbitrage" ? "executable" : r.tier === "quasi" ? "executable (not enforceable)" : "statistical signal";
    }
    return { status, reasons, position, edge, conv, cost, checks };
  }
  function rescan() {
    for (const r of state.rels) state.verdicts[r.id] = verdict(r, state.p);
    renderTable();
  }

  // ------------------------------------------------------------------------------------------ table
  const COLS = [
    { k: "name", t: "Relationship" }, { k: "tier", t: "Strength" }, { k: "status", t: "Verdict" },
    { k: "z", t: "z", num: true }, { k: "dev", t: "Deviation", num: true }, { k: "hl", t: "Half-life", num: true, cls: "hide-sm" },
    { k: "pmr", t: "P(mean-rev.)", num: true, cls: "hide-sm" }, { k: "cost", t: "Cost r/t", num: true, cls: "hide-sm" },
    { k: "edge", t: "Net edge", num: true }, { k: "liq", t: "Min ADV", num: true, cls: "hide-sm" }, { k: "sharpe", t: "Backtest Sharpe", num: true, cls: "hide-sm" },
  ];
  function rowVal(r, k) {
    const s = r.scan || {}, v = state.verdicts[r.id] || {};
    switch (k) {
      case "name": return r.name; case "tier": return ["arbitrage", "quasi", "statistical"].indexOf(r.tier);
      case "status": return STATUS.indexOf(v.status); case "z": return isF(s.z) ? Math.abs(s.z) : -1;
      case "dev": return isF(s.deviation) ? Math.abs(s.deviation) : -1; case "hl": return isF(s.half_life) ? s.half_life : 1e9;
      case "pmr": return s.bayes_p_mr ?? -1; case "cost": return s.cost_rt ?? -1; case "edge": return isF(v.edge) ? v.edge : -1e9;
      case "liq": return s.adv_min_usd ?? -1; case "sharpe": return r.backtest?.base?.sharpe ?? -9;
      case "rank": return STATUS.indexOf(v.status) * 100 - Math.min(Math.abs(s.z || 0), 99);
      default: return 0;
    }
  }
  function visible() {
    const f = state.f;
    return state.rels.filter((r) => {
      if (!f.tiers.has(r.tier) || !f.types.has(r.type)) return false;
      if (!r.asset_classes.some((c) => f.classes.has(c))) return false;
      const v = state.verdicts[r.id];
      if (f.status && v.status !== f.status) return false;
      if (f.onlyExec && !(v.status === "executable" || v.status === "executable (not enforceable)")) return false;
      if (f.q) {
        const hay = (r.name + " " + r.id + " " + r.legs.map((l) => l.name + " " + l.symbol).join(" ")).toLowerCase();
        if (!hay.includes(f.q)) return false;
      }
      return true;
    });
  }
  function renderTable() {
    const rows = visible();
    const k = state.sort.k, d = state.sort.d;
    rows.sort((a, b) => { const x = rowVal(a, k), y = rowVal(b, k); return (x > y ? 1 : x < y ? -1 : 0) * d; });
    const counts = {}; for (const r of rows) { const s = state.verdicts[r.id].status; counts[s] = (counts[s] || 0) + 1; }
    $("#counts").innerHTML = STATUS.filter((s) => counts[s] || state.f.status === s).map((s) =>
      `<button class="count-chip ${state.f.status === s ? "on" : ""}" data-s="${esc(s)}">${statusBadge(s)} <b>${counts[s] || 0}</b></button>`).join("") +
      (state.f.status ? `<button class="count-chip" data-s="">Clear</button>` : "");
    $$("#counts .count-chip").forEach((b) => b.addEventListener("click", () => { state.f.status = b.dataset.s || null; renderTable(); }));
    $("#tbl thead").innerHTML = `<tr>${COLS.map((c) => `<th data-k="${c.k}" class="${c.num ? "num" : ""} ${c.cls || ""}">${c.t}${state.sort.k === c.k ? (d > 0 ? " ▲" : " ▼") : ""}</th>`).join("")}</tr>`;
    $$("#tbl th").forEach((th) => th.addEventListener("click", () => {
      const kk = th.dataset.k; state.sort = { k: kk, d: state.sort.k === kk ? -state.sort.d : (["name", "tier", "status", "hl", "cost"].includes(kk) ? 1 : -1) }; renderTable();
    }));
    $("#tbl tbody").innerHTML = rows.map((r) => {
      const s = r.scan || {}, v = state.verdicts[r.id];
      return `<tr data-id="${r.id}">
        <td><b>${esc(r.name)}</b><span class="sub">${esc(state.meta.types[r.type] || r.type)}${r.license === "vendor" ? " · derived" : " · open data"}</span></td>
        <td>${tierBadge(r.tier)}</td><td>${statusBadge(v.status)}</td>
        <td class="num">${num(s.z, 2)}</td><td class="num">${num(s.deviation, r.unit === "usd" ? 2 : 1)}<span class="sub">${unitLabel(r)}</span></td>
        <td class="num hide-sm">${hl(s.half_life)}</td><td class="num hide-sm">${pct(s.bayes_p_mr)}</td>
        <td class="num hide-sm">${num(v.cost, 1)}</td><td class="num">${v.position ? signed(v.edge) : "–"}</td>
        <td class="num hide-sm">${money(s.adv_min_usd)}</td><td class="num hide-sm">${num(r.backtest?.base?.sharpe, 2)}</td></tr>`;
    }).join("");
    $$("#tbl tbody tr").forEach((tr) => tr.addEventListener("click", () => { location.hash = "rel=" + tr.dataset.id; }));
    $("#tbl-note").textContent = `${rows.length} of ${state.rels.length} relationships. Deviation = spread minus fair value; net edge = expected convergence over two half-lives minus round-trip costs plus carry (bp of one leg's notional, or bp of yield). Backtest Sharpe: next-close execution, base costs, full history.`;
    resizeParent();
  }

  // ------------------------------------------------------------------------------------------ detail
  function closeDetail() { $("#detail").hidden = true; state.current = null; }
  async function loadRel(id) {
    if (!state.cache[id]) { const res = await fetch(`data/rel/${encodeURIComponent(id)}.json`); state.cache[id] = await res.json(); }
    return state.cache[id];
  }
  async function openDetail(id) {
    const r = state.byId[id]; if (!r) return;
    const el = $("#detail"); el.hidden = false;
    el.innerHTML = `<p><span class="spinner"></span> Loading ${esc(r.name)}…</p>`;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    const data = await loadRel(id);
    state.current = { r, data, p: Object.assign({}, state.p), variant: "base" };
    renderDetail();
  }

  function renderDetail() {
    const { r, data } = state.current, s = r.scan || {}, v = verdict(r, state.p);
    const legs = r.legs.map((l) => `<li><b>${esc(l.symbol)}</b> ${esc(l.name)} <span class="muted">(${esc(l.ccy)}, ${esc(l.venue)})</span> <span class="lic ${l.license !== "vendor" ? "open" : ""}">${l.license === "vendor" ? "vendor, derived only" : "open data"}</span></li>`).join("");
    const el = $("#detail");
    el.innerHTML = `
      <div class="detail-head">
        <div><button class="btn btn--sm" id="back">← All relationships</button>
          <h2 style="margin-top:8px">${esc(r.name)}</h2>
          <div class="badges">${tierBadge(r.tier)} ${statusBadge(v.status)} <span class="badge st-no-signal">${esc(state.meta.types[r.type] || r.type)}</span></div></div>
        <div class="small muted" style="max-width:460px">${esc(r.mechanism)}</div>
      </div>
      ${v.reasons.length ? `<div class="note warn"><b>Why it is not executable:</b> ${v.reasons.map(esc).join("; ")}.</div>` : v.status.startsWith("executable") ? `<div class="note">All checks pass at the current settings. ${r.tier === "quasi" ? "Convergence is likely but cannot be forced." : ""}</div>` : ""}
      ${r.license === "vendor" ? `<div class="note">Vendor prices: shown as derived analytics only (spread, hedged-position P&amp;L, costs). The instruments' own prices are not published.</div>` : ""}
      <div class="kpis" id="kpis"></div>
      <div class="subtabs" id="dtabs">${["Spread and signal", "Trade simulator", "Hedge ratio", "Historical convergence", "Risk and costs", "Details"].map((t, i) => `<button data-i="${i}" class="${i === 0 ? "on" : ""}">${t}</button>`).join("")}</div>
      <div id="dpanes"></div>`;
    $("#back").addEventListener("click", () => { location.hash = "scan"; });
    const kp = [
      ["z-score", num(s.z, 2), `entry at ±${state.p.entry}`], ["Deviation", num(s.deviation, r.unit === "usd" ? 2 : 1), unitLabel(r)],
      ["Half-life", hl(s.half_life), per(r)], ["P(mean reversion)", pct(s.bayes_p_mr), "Bayes factor vs random walk"],
      ["Regime P(MR)", pct(s.regime_p_mr), "Markov-switching filter"], ["Round-trip cost", num(v.cost, 1), r.pnl_unit === "yield_bp" ? "bp of yield" : "bp, stress-scaled"],
      ["Net edge", v.position ? signed(v.edge) : "–", "after costs and carry"], ["Capacity", money(s.capacity_usd), "5% of min ADV"],
      ["Timing gap", r.sync_gap_h.toFixed(1) + " h", "between closing prints"], ["Backtest Sharpe", num(r.backtest?.base?.sharpe, 2), "next-close, base costs"],
    ];
    $("#kpis").innerHTML = kp.map(([a, b, c]) => `<div class="kpi"><span>${a}</span><b>${b}</b><small>${c}</small></div>`).join("");
    const panes = [paneSpread, paneSim, paneHedge, paneConv, paneRisk, paneAbout];
    const show = (i) => { $$("#dtabs button").forEach((b) => b.classList.toggle("on", +b.dataset.i === i)); $("#dpanes").innerHTML = ""; panes[i](); resizeParent(); };
    $$("#dtabs button").forEach((b) => b.addEventListener("click", () => show(+b.dataset.i)));
    show(0);
  }

  function seriesFor() {
    const { r, data, variant } = state.current;
    if (variant !== "base" && data.alt && data.alt[variant]) return data.alt[variant];
    return { s: data.s, pnl: data.pnl };
  }
  function simulate(p) {
    const { r, data } = state.current;
    if (!data.pnl) return null;
    const v = seriesFor();
    return S.backtest(Object.assign({}, data, { id: r.id }), Object.assign({}, p, { direction: data.direction }), v);
  }

  function paneSpread() {
    const { r, data } = state.current;
    const host = $("#dpanes");
    host.innerHTML = `<div class="panel"><h3>Spread vs fair value</h3><div id="c-spread"></div>
      <p class="small muted">Shaded band: fair value ± entry z × trailing ${state.p.lookback}-${r.freq === "M" ? "month" : "day"} standard deviation. Markers: simulated entries (▲ long the spread, ▼ short) and exits (dots), using the current rule and next-close execution.</p></div>
      <div class="panel"><h3>z-score</h3><div id="c-z"></div></div>`;
    const v = seriesFor(), base = Object.assign({}, data, { s: v.s });
    const fair = S.fairSeries(base), dev = v.s.map((x, i) => (isF(x) && isF(fair[i]) ? x - fair[i] : NaN));
    const sd = S.rollingStd(dev, state.p.lookback, Math.floor(state.p.lookback / 2));
    const lo = fair.map((f, i) => (isF(f) && isF(sd[i]) ? f - state.p.entry * sd[i] : null));
    const hi = fair.map((f, i) => (isF(f) && isF(sd[i]) ? f + state.p.entry * sd[i] : null));
    const bt = data.pnl ? simulate(state.p) : null;
    const markers = [];
    if (bt) for (let i = 1; i < bt.pos.length; i++) {
      if (bt.pos[i] !== bt.pos[i - 1]) {
        if (bt.pos[i] !== 0) markers.push({ x: data.d[i], y: v.s[i], shape: bt.pos[i] > 0 ? "up" : "down", color: "--ink" });
        else markers.push({ x: data.d[i], y: v.s[i], color: "--muted" });
      }
    }
    const series = [{ y: fair, color: "--muted", dash: [5, 4], label: "Fair value", area: { lo, hi, alpha: 0.12 } }, { y: v.s, color: "--series-1", label: "Spread", width: 1.3 }];
    if (data.full_carry) series.push({ y: data.full_carry, color: "--series-2", dash: [2, 3], label: "Full-carry bound" });
    chart($("#c-spread"), { height: 300, yFmt: (x) => x.toFixed(Math.abs(x) < 10 ? 1 : 0) }).setData({ x: data.d, series, markers: markers.slice(-400) });
    const z = S.zscore(dev, state.p.lookback);
    chart($("#c-z"), { height: 170, yFmt: (x) => x.toFixed(1) }).setData({ x: data.d, series: [{ y: z, color: "--series-1", label: "z-score" }],
      hlines: [state.p.entry, -state.p.entry].map((y) => ({ y, color: "--ink-2" })).concat([state.p.exit, -state.p.exit].map((y) => ({ y, color: "--muted" }))), clip: [-8, 8] });
  }

  function paneSim() {
    const { r, data } = state.current;
    const host = $("#dpanes");
    if (!data.pnl) { host.innerHTML = `<div class="note">Monitor only: this spread is not tradable as specified (${esc((r.notes || []).slice(-1)[0] || "")}).</div>`; return; }
    const p = state.current.p;
    const isYield = r.pnl_unit === "yield_bp";
    host.innerHTML = `<div class="panel"><h3>Run a hypothetical trade</h3>
      <div class="controls">
        <label>Entry |z| <input type="number" id="s-entry" step="0.25" min="0.5" max="6" value="${p.entry}"></label>
        <label>Exit |z| <input type="number" id="s-exit" step="0.25" min="0" max="3" value="${p.exit}"></label>
        <label>Stop |z| <input type="number" id="s-stop" step="0.5" min="1" max="12" value="${p.stop}"></label>
        <label>z window (${per(r)}) <input type="number" id="s-lb" step="1" min="10" max="756" value="${p.lookback}"></label>
        <label>Max holding (${per(r)}) <input type="number" id="s-mh" step="1" min="1" max="1000" value="${p.maxHold}"></label>
        <label>Execution <select id="s-lag"><option value="1" ${p.lag === 1 ? "selected" : ""}>Next close (realistic)</option><option value="0" ${p.lag === 0 ? "selected" : ""}>Same close (optimistic)</option><option value="2" ${p.lag === 2 ? "selected" : ""}>Two closes later</option></select></label>
        <label>Cost multiplier <input type="number" id="s-cost" step="0.25" min="0" max="5" value="${p.costMult}"></label>
        <label>${isYield ? "DV01 per unit ($/bp)" : "Notional per unit ($)"} <input type="number" id="s-not" step="1000" min="0" value="${isYield ? 10000 : 1000000}"></label>
        <label><span>Respect arbitrage band</span><select id="s-band"><option value="1">Yes</option><option value="0" ${p.useBand ? "" : "selected"}>No</option></select></label>
      </div>
      <div class="two"><div><div id="c-eq"></div><p class="small muted">Cumulative P&amp;L of one unit: net and before costs and carry, in ${isYield ? "bp of yield per DV01 unit" : "bp of one leg's notional"}.</p></div>
      <div><table class="metrics-table" id="m-tab"></table></div></div></div>
      <div class="two"><div class="panel"><h3>P&amp;L attribution</h3><div id="attr"></div><div id="attr-legs"></div></div>
      <div class="panel"><h3>Risk of the simulated trades</h3><div id="risk-sim"></div></div></div>
      <div class="panel"><h3>Trades</h3><div class="table-wrap" style="max-height:320px"><table class="grid" id="trades"></table></div></div>`;
    const read = () => ({ entry: +$("#s-entry").value, exit: +$("#s-exit").value, stop: +$("#s-stop").value, lookback: Math.round(+$("#s-lb").value),
      maxHold: Math.round(+$("#s-mh").value), lag: +$("#s-lag").value, costMult: +$("#s-cost").value, useBand: $("#s-band").value === "1" });
    const go = () => { state.current.p = read(); drawSim(+$("#s-not").value); };
    $$("#dpanes .controls input, #dpanes .controls select").forEach((i) => i.addEventListener("change", go));
    go();
  }
  function drawSim(notional) {
    const { r, data, p } = state.current;
    const bt = simulate(p);
    const isYield = r.pnl_unit === "yield_bp";
    const toUsd = (x) => (isYield ? x * notional : x / 1e4 * notional);
    let cn = 0, cg = 0; const net = [], gross = [];
    for (let i = 0; i < bt.net.length; i++) { cn += bt.net[i]; cg += bt.gross[i]; net.push(cn); gross.push(cg); }
    chart($("#c-eq"), { height: 260, yFmt: (x) => x.toFixed(0) }).setData({ x: data.d, series: [
      { y: gross, color: "--series-2", label: "Before costs and carry" }, { y: net, color: "--series-1", label: "Net", width: 1.6 }] });
    const m = bt.metrics, py = r.backtest?.base;
    const rows = [["Net Sharpe (annualised)", num(m.sharpe, 2)], ["Gross Sharpe", num(m.grossSharpe, 2)], ["Net per year", num(m.netPerYear, 1) + (isYield ? " bp" : " bp")],
      ["Net per year, $", money(toUsd(m.netPerYear)).replace("$-", "-$")], ["Trades", m.trades], ["Hit rate", pct(m.hit)], ["Average net per trade", num(m.avgNet, 1)],
      ["Average holding", num(m.avgPeriods, 1) + " " + per(r)], ["Time in market", pct(m.timeInMarket)], ["Max drawdown", num(m.maxDD, 0)],
      ["Costs paid", num(m.costTotal, 0)], ["Years", num(m.years, 1)]];
    if (py && p.lag === 1 && p.entry === 2 && p.exit === 0.5 && p.stop === 4 && p.lookback === 126 && p.costMult === 1 && state.current.variant === "base")
      rows.push(["Python engine, full history", num(py.sharpe, 2)]);
    $("#m-tab").innerHTML = rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join("");
    const conv = bt.conv.filter(isF).reduce((a, b) => a + b, 0);
    const items = [{ label: "Spread convergence", v: r.unit === r.pnl_unit ? conv : NaN }, { label: "Hedge slippage / basis", v: r.unit === r.pnl_unit ? m.grossTotal - conv : NaN },
      { label: "Gross (position × P&L)", v: m.grossTotal }, { label: "Carry", v: m.carryTotal }, { label: "Funding and borrow", v: m.holdTotal },
      { label: "Transaction costs", v: m.costTotal }, { label: "Net", v: m.netTotal }].filter((d) => isF(d.v));
    C.bars($("#attr"), items, (x) => x.toFixed(0));
    if (data.legpnl) {
      const legItems = Object.entries(data.legpnl).map(([k, arr]) => { let t = 0; for (let i = 1; i < arr.length; i++) if (isF(arr[i])) t += bt.pos[i - 1] * arr[i]; return { label: k, v: t }; });
      $("#attr-legs").innerHTML = `<h4>By leg (open data)</h4><div id="attr-l2"></div>`; C.bars($("#attr-l2"), legItems, (x) => x.toFixed(0));
    } else $("#attr-legs").innerHTML = `<p class="small muted">Leg-level attribution is shown only where every leg is open data.</p>`;
    const pn = (seriesFor().pnl || []).slice(-504).filter(isF), sdp = S.std(pn);
    $("#risk-sim").innerHTML = `<table class="metrics-table">
      <tr><td>Maximum adverse excursion, median trade</td><td>${num(m.maeMedian, 1)}</td></tr>
      <tr><td>Maximum adverse excursion, worst 5% of trades</td><td>${num(m.maeP95, 1)}</td></tr>
      <tr><td>Daily P&amp;L s.d. of one unit (basis risk, last 2 years)</td><td>${num(sdp, 1)}</td></tr>
      <tr><td>99% ${r.freq === "M" ? "1-month" : "10-day"} loss of one unit (normal)</td><td>${num(2.33 * sdp * (r.freq === "M" ? 1 : Math.sqrt(10)), 0)}</td></tr>
      <tr><td>Same, in dollars at the chosen size</td><td>${money(toUsd(2.33 * sdp * (r.freq === "M" ? 1 : Math.sqrt(10))))}</td></tr>
      <tr><td>Currency exposure</td><td>${esc(r.scan?.fx_exposure || "–")}</td></tr></table>
      <p class="small muted">Units: ${isYield ? "bp of yield per DV01 unit" : "bp of one leg's notional"}. MAE is the worst mark-to-market loss inside a trade before it closed.</p>`;
    $("#trades").innerHTML = `<thead><tr><th>Entry</th><th>Exit</th><th>Side</th><th class="num">Entry z</th><th class="num">${per(r)}</th><th class="num">Gross</th><th class="num">Costs</th><th class="num">Net</th><th class="num">MAE</th></tr></thead><tbody>` +
      bt.trades.slice(-60).reverse().map((t) => `<tr><td class="mono">${C.fmtDate(t.entry)}</td><td class="mono">${t.open ? "open" : C.fmtDate(t.exit)}</td><td>${t.dir > 0 ? "long spread" : "short spread"}</td>
      <td class="num">${num(t.z, 2)}</td><td class="num">${t.periods}</td><td class="num">${num(t.gross, 1)}</td><td class="num">${num(t.costs, 1)}</td><td class="num">${num(t.net, 1)}</td><td class="num">${num(t.mae, 1)}</td></tr>`).join("") + "</tbody>";
  }

  function paneHedge() {
    const { r, data } = state.current, host = $("#dpanes");
    if (data.beta) {
      const hasAlt = !!data.alt;
      host.innerHTML = `<div class="panel"><h3>Hedge ratio over time</h3>
        ${hasAlt ? `<div class="subtabs" id="hv">${[["base", "Rolling 252-day OLS (default)"], ["kalman", "Kalman filter"], ["ratio", "1:1 dollar-neutral"]].map(([k, t]) => `<button data-v="${k}" class="${state.current.variant === k ? "on" : ""}">${t}</button>`).join("")}</div>
        <p class="small muted">The selected method drives the spread, signals and simulator on the other tabs. Each estimate uses data up to the day before it is applied.</p>` : ""}
        <div id="c-beta"></div>
        <p class="small muted">Hedge ratio = dollars of the second leg sold per dollar of the first leg bought (elasticity of log prices${r.type === "bond_spreads" ? "; for credit ETFs a rolling return beta" : ""}).</p></div>`;
      const series = [{ y: data.beta.rolling, color: "--series-1", label: r.type === "bond_spreads" ? "Return beta (126d)" : "Rolling OLS" }];
      if (data.beta.kalman) series.push({ y: data.beta.kalman, color: "--series-2", label: "Kalman" });
      chart($("#c-beta"), { height: 260, yFmt: (x) => x.toFixed(2) }).setData({ x: data.d, series });
      $$("#hv button").forEach((b) => b.addEventListener("click", () => { state.current.variant = b.dataset.v; $$("#hv button").forEach((x) => x.classList.toggle("on", x === b)); }));
      return;
    }
    let text = "";
    if (r.type === "adr" || r.type === "cross_listing") text = `Fixed by the security's terms, not estimated: ${esc(r.name.match(/\(x([\d.]+)\)/)?.[1] || "1")} home share(s) per US line, converted at the Fed H.10 noon rate. Estimating this ratio from prices would remove exactly the premium the scanner is looking for.`;
    else if (r.type === "etf_nav") text = "1:1 against the basket, valued at the fund's own NAV.";
    else if (r.type === "futures_basis") text = "1:1 futures against the index basket (traded through the ETF). Fair basis = (financing rate − dividend yield) × time to expiry; the chart shows the implied financing rate over the overnight rate.";
    else if (r.type === "bond_spreads") text = "DV01-neutral weights: each leg sized so a 1 bp parallel move has equal and opposite value.";
    else if (r.type === "calendar") text = "1:1 notional in the two delivery months (rolled each month).";
    else if (r.type === "carry_funding") text = "Single position: long the currency against USD, funded at the USD rate.";
    else text = "Fixed weights from the relationship's economics.";
    host.innerHTML = `<div class="panel"><h3>Hedge ratio</h3><p>${text}</p><div id="c-extra"></div></div>`;
    if (data.implied_fin) chart($("#c-extra"), { height: 220, yFmt: (x) => x.toFixed(0) }).setData({ x: data.d, series: [{ y: data.implied_fin, color: "--series-2", label: "Implied financing over overnight rate (bp/yr)" }], clip: [-400, 400] });
  }

  function paneConv() {
    const { r, data } = state.current, host = $("#dpanes"), p = state.p;
    const v = seriesFor(), base = Object.assign({}, data, { s: v.s });
    const fair = S.fairSeries(base), dev = v.s.map((x, i) => (isF(x) && isF(fair[i]) ? x - fair[i] : NaN));
    const z = S.zscore(dev, p.lookback);
    const ep = S.episodes(z, dev, p.entry, p.exit, r.freq === "M" ? 36 : 252);
    const rev = ep.filter((e) => e.reverted), periods = rev.map((e) => e.periods);
    const buckets = r.freq === "M" ? [1, 2, 3, 6, 12, 36] : [1, 5, 10, 21, 63, 126, 252];
    const hist = buckets.map((b, i) => ({ label: `≤ ${b} ${per(r)}`, v: periods.filter((x) => x <= b && (i === 0 || x > buckets[i - 1])).length }));
    hist.push({ label: "not within horizon", v: ep.length - rev.length });
    host.innerHTML = `<div class="two"><div class="panel"><h3>How past deviations ended</h3>
      <p>${ep.length} times the |z| crossed ${p.entry}. ${pct(ep.length ? rev.length / ep.length : NaN)} returned inside |z| ${p.exit} within ${r.freq === "M" ? "36 months" : "a year"}, after a median ${num(S.median(periods), 0)} ${per(r)}. On the way, the worst move against the position had a median of ${num(S.median(ep.map((e) => e.mae)), 1)} and a 95th percentile of ${num(S.quantile(ep.map((e) => e.mae), 0.95), 1)} ${unitLabel(r)}.</p>
      <div id="hist"></div></div>
      <div class="panel"><h3>Model view now</h3><table class="metrics-table">
        <tr><td>OU half-life (trailing window)</td><td>${hl(r.scan?.half_life)} ${per(r)}</td></tr>
        <tr><td>Dickey-Fuller p (spread stationary)</td><td>${num(r.scan?.adf_p, 3)}</td></tr>
        <tr><td>Bayesian P(mean reversion)</td><td>${pct(r.scan?.bayes_p_mr)}</td></tr>
        <tr><td>P(reach exit band within ${r.scan?.horizon ?? "–"} ${per(r)})</td><td>${pct(r.scan?.bayes_p_hit)}</td></tr>
        <tr><td>P(stop first)</td><td>${pct(r.scan?.bayes_p_stop)}</td></tr>
        <tr><td>Regime filter P(mean-reverting state)</td><td>${pct(r.scan?.regime_p_mr)}</td></tr>
        <tr><td>Expected convergence over horizon</td><td>${num(r.scan?.expected_convergence, 1)}</td></tr></table>
        <p class="small muted">Bayesian probabilities average a mean-reverting AR(1) and a random walk by their marginal likelihoods, so a fragile half-life widens the forecast instead of promising convergence.</p></div></div>
      <div class="panel"><h3>Recent episodes</h3><div class="table-wrap" style="max-height:300px"><table class="grid"><thead><tr><th>Start</th><th class="num">z</th><th class="num">Deviation</th><th class="num">${per(r)} to revert</th><th class="num">Worst adverse move</th></tr></thead><tbody>
      ${ep.slice(-40).reverse().map((e) => `<tr><td class="mono">${C.fmtDate(data.d[e.t])}</td><td class="num">${num(e.z, 2)}</td><td class="num">${num(e.dev, 1)}</td><td class="num">${e.reverted ? e.periods : "–"}</td><td class="num">${num(e.mae, 1)}</td></tr>`).join("")}</tbody></table></div></div>`;
    C.bars($("#hist"), hist, (x) => x.toFixed(0));
  }

  function paneRisk() {
    const { r } = state.current, s = r.scan || {}, v = verdict(r, state.p), host = $("#dpanes");
    const bt = r.backtest || {};
    const row = (k) => bt[k] ? `<tr><td>${k === "base" ? "Base (next close)" : k === "stress_costs" ? "Costs doubled" : "Same-close fills (optimistic)"}</td><td>${num(bt[k].sharpe, 2)}</td><td>${num(bt[k].net_per_year, 1)}</td><td>${bt[k].trades ?? "–"}</td><td>${num(bt[k].is_sharpe, 2)}</td><td>${num(bt[k].oos_sharpe, 2)}</td></tr>` : "";
    host.innerHTML = `<div class="two"><div class="panel"><h3>Executability checklist</h3><ul class="checklist">${v.checks.map((c) => `<li class="${c.v}"><b>${esc(c.k)}</b> <span class="muted small">${esc(c.note)}</span></li>`).join("")}</ul></div>
      <div class="panel"><h3>Costs, carry and liquidity</h3><table class="metrics-table">
        <tr><td>Round-trip cost (spreads, commissions, taxes, FX)</td><td>${num(v.cost, 1)}</td></tr>
        <tr><td>No-arbitrage band at this deviation</td><td>${num(s.band, 1)}</td></tr>
        <tr><td>Directional carry per ${r.freq === "M" ? "month" : "day"} (long spread)</td><td>${num(s.carry_per_period, 3)}</td></tr>
        <tr><td>Funding and borrow per ${r.freq === "M" ? "month" : "day"}</td><td>${num(s.hold_per_period, 3)}</td></tr>
        <tr><td>Minimum ADV across legs</td><td>${money(s.adv_min_usd)}</td></tr>
        <tr><td>Capacity at 5% of ADV</td><td>${money(s.capacity_usd)}</td></tr>
        <tr><td>Borrow</td><td>${esc((s.borrow || []).join("; ") || (s.borrow_ok === false ? "not available" : "n/a"))}</td></tr>
        <tr><td>Currency exposure</td><td>${esc(s.fx_exposure || "–")}</td></tr>
        <tr><td>Basis risk (daily P&amp;L s.d., one unit)</td><td>${num(s.basis_risk_sd, 1)}</td></tr>
        <tr><td>99% ${r.freq === "M" ? "1-month" : "10-day"} loss, one unit</td><td>${num(s.loss_99_10d, 0)}</td></tr></table></div></div>
      <div class="panel"><h3>Backtests (Python engine, full history)</h3><table class="grid"><thead><tr><th>Variant</th><th class="num">Net Sharpe</th><th class="num">Net / year</th><th class="num">Trades</th><th class="num">Sharpe to 2015</th><th class="num">Sharpe 2016-</th></tr></thead><tbody>${row("base")}${row("stress_costs")}${row("same_close")}</tbody></table>
      <p class="small muted">Same parameters for every relationship, fixed before looking at results. The gap between same-close and next-close fills measures how much of an apparent edge is closing-print noise or non-synchronous prices.</p></div>`;
  }

  function paneAbout() {
    const { r } = state.current, host = $("#dpanes");
    host.innerHTML = `<div class="two"><div class="panel"><h3>Mechanism</h3><p>${esc(r.mechanism)}</p><h4>Notes and constraints</h4><ul>${(r.notes || []).map((n) => `<li>${esc(n)}</li>`).join("")}</ul></div>
      <div class="panel"><h3>Legs and data</h3><ul>${r.legs.map((l) => `<li><b>${esc(l.symbol)}</b> ${esc(l.name)}<br><span class="small muted">${esc(l.source)} · ${l.license === "vendor" ? "vendor (derived analytics only)" : l.license}</span></li>`).join("")}</ul>
      <p class="small muted">History ${r.first} to ${r.last}. Units: spread in ${unitLabel(r)}; P&amp;L in ${r.pnl_unit === "yield_bp" ? "bp of yield per DV01 unit" : "bp of one leg's notional"}.</p></div></div>`;
  }

  // ------------------------------------------------------------------------------------------ build a pair (open data)
  async function loadGroup(g) {
    if (!state.open[g]) { const res = await fetch(`data/open/${g}.json`); state.open[g] = await res.json(); }
    return state.open[g];
  }
  function renderBuild() {
    const host = $("#tab-build");
    if (host.dataset.ready) return;
    host.dataset.ready = "1";
    const groups = state.meta.open_groups;
    host.innerHTML = `<div class="build-layout"><aside class="filters">
        <h3>Data set</h3><select id="b-group" class="btn" style="width:100%">${Object.entries(groups).map(([k, g]) => `<option value="${k}">${esc(g.label)}</option>`).join("")}</select>
        <h3>Instruments</h3><div class="pick" id="b-pick"></div>
        <h3>Window</h3><select id="b-win" class="btn" style="width:100%"><option value="756">Last 3 years</option><option value="1260" selected>Last 5 years</option><option value="2520">Last 10 years</option><option value="0">Everything</option></select>
        <p style="margin-top:10px"><button class="btn btn--accent" id="b-scan">Scan selected for cointegration</button></p>
        <p class="small muted">Every pair among the selected series is tested with Engle-Granger in both orderings (the larger p-value counts) and the p-values are corrected for the number of pairs (Benjamini-Hochberg). Pure open data: US Treasury, Fed, New York Fed, ECB, Bundesbank, Japan MoF, Bank of Canada, RBA, Bank of England, EIA, OECD.</p>
      </aside><div><div id="b-results" class="panel"><h3>Pick a data set and instruments, then scan</h3><p class="muted">Or analyse one pair directly below.</p></div>
        <div class="panel"><h3>Analyse a pair</h3><div class="controls">
          <label>Leg A <select id="b-a"></select></label><label>Leg B <select id="b-b"></select></label>
          <label>Hedge <select id="b-h"><option value="ols">OLS on the window</option><option value="kalman">Kalman (dynamic)</option><option value="one">1:1</option></select></label>
          <label>Round-trip cost <input type="number" id="b-cost" step="0.5" min="0" value="1"></label>
          <label>Entry |z| <input type="number" id="b-entry" step="0.25" value="2"></label><label>Exit |z| <input type="number" id="b-exit" step="0.25" value="0.5"></label>
          <label>z window <input type="number" id="b-lb" step="1" value="126"></label>
          <label>Execution <select id="b-lag"><option value="1">Next close</option><option value="0">Same close</option></select></label>
        </div><button class="btn btn--accent" id="b-go">Analyse</button><div id="b-out"></div></div></div></div>`;
    const loadPick = async () => {
      const g = await loadGroup($("#b-group").value);
      const ids = Object.keys(g.series);
      $("#b-pick").innerHTML = ids.map((id, i) => `<label><input type="checkbox" value="${id}" ${i < 6 ? "checked" : ""}> ${esc(g.series[id].name)}</label>`).join("");
      const opts = ids.map((id) => `<option value="${id}">${esc(g.series[id].name)}</option>`).join("");
      $("#b-a").innerHTML = opts; $("#b-b").innerHTML = opts; $("#b-b").selectedIndex = Math.min(1, ids.length - 1);
      $("#b-cost").value = g.kind === "yield" ? 1 : g.group === "energy" ? 8 : 2;
    };
    $("#b-group").addEventListener("change", loadPick);
    $("#b-scan").addEventListener("click", scanOpen);
    $("#b-go").addEventListener("click", () => analysePair($("#b-a").value, $("#b-b").value));
    loadPick();
  }
  function windowed(g, a, b) {
    const w = +$("#b-win").value, d = g.d, A = g.series[a].v, B = g.series[b].v, xs = [], ya = [], yb = [];
    for (let i = 0; i < d.length; i++) if (isF(A[i]) && isF(B[i])) { xs.push(d[i]); ya.push(A[i]); yb.push(B[i]); }
    const k = w > 0 ? Math.max(0, xs.length - w) : 0;
    return { d: xs.slice(k), a: ya.slice(k), b: yb.slice(k) };
  }
  const lv = (g, v) => (g.kind === "price" ? v.map((x) => Math.log(x)) : v);
  async function scanOpen() {
    const g = await loadGroup($("#b-group").value);
    const ids = $$("#b-pick input:checked").map((i) => i.value).slice(0, 14);
    const out = $("#b-results");
    if (ids.length < 2) { out.innerHTML = "<p>Select at least two instruments.</p>"; return; }
    out.innerHTML = `<p><span class="spinner"></span> Testing ${ids.length * (ids.length - 1) / 2} pairs…</p>`;
    await new Promise((r) => setTimeout(r, 30));
    const rows = [];
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const w = windowed(g, ids[i], ids[j]); if (w.d.length < 120) continue;
      const A = lv(g, w.a), B = lv(g, w.b);
      const e1 = S.engleGranger(A, B), e2 = S.engleGranger(B, A);
      const resid = A.map((x, k) => x - e1.alpha - e1.beta * B[k]);
      const ou = S.fitOU(resid, 2, g.freq === "M" ? 1 / 12 : 1 / 252);
      const sd = S.std(resid.slice(-252)), z = (resid[resid.length - 1] - S.mean(resid.slice(-252))) / sd;
      rows.push({ a: ids[i], b: ids[j], p: Math.max(e1.p, e2.p), pmin: Math.min(e1.p, e2.p), beta: e1.beta, hl: ou.hl, z, n: w.d.length });
    }
    const q = S.bh(rows.map((r) => r.p)); rows.forEach((r, k) => (r.q = q[k]));
    rows.sort((x, y) => x.p - y.p);
    const sig = rows.filter((r) => r.p < 0.05).length, sigq = rows.filter((r) => r.q < 0.05).length;
    out.innerHTML = `<h3>${rows.length} pairs tested</h3><p>${sig} pass Engle-Granger at 5% (about ${(0.05 * rows.length).toFixed(1)} would by chance alone); <b>${sigq}</b> survive the Benjamini-Hochberg correction. Even survivors are statistical relationships unless an economic mechanism links them. Click a row to analyse it.</p>
      <div class="table-wrap" style="max-height:360px"><table class="grid"><thead><tr><th>Pair</th><th class="num">EG p (worse order)</th><th class="num">BH q</th><th class="num">Hedge β</th><th class="num">Half-life</th><th class="num">z now</th><th class="num">Obs</th></tr></thead><tbody>
      ${rows.map((r) => `<tr data-a="${r.a}" data-b="${r.b}"><td><b>${esc(g.series[r.a].name)}</b><span class="sub">vs ${esc(g.series[r.b].name)}</span></td><td class="num">${num(r.p, 3)}</td><td class="num">${num(r.q, 3)}</td><td class="num">${num(r.beta, 3)}</td><td class="num">${hl(r.hl)}</td><td class="num">${num(r.z, 2)}</td><td class="num">${r.n}</td></tr>`).join("")}</tbody></table></div>`;
    $$("#b-results tbody tr").forEach((tr) => tr.addEventListener("click", () => { $("#b-a").value = tr.dataset.a; $("#b-b").value = tr.dataset.b; analysePair(tr.dataset.a, tr.dataset.b); }));
    resizeParent();
  }
  async function analysePair(a, b) {
    const g = await loadGroup($("#b-group").value), out = $("#b-out");
    if (a === b) { out.innerHTML = "<p>Pick two different series.</p>"; return; }
    const w = windowed(g, a, b), A = lv(g, w.a), B = lv(g, w.b), n = w.d.length;
    if (n < 120) { out.innerHTML = "<p>Not enough overlapping data.</p>"; return; }
    const mode = $("#b-h").value, scale = g.kind === "price" ? 1e4 : 100;
    let alpha = new Array(n).fill(0), beta = new Array(n).fill(1);
    if (mode === "ols") { const o = S.ols(A, B); alpha.fill(o.a); beta.fill(o.b); }
    if (mode === "kalman") { const k = S.kalman(A, B, 1e-4, Math.min(252, Math.floor(n / 3))); alpha = k.alpha; beta = k.beta; }
    const s = A.map((x, i) => (isF(alpha[i]) && isF(beta[i]) ? scale * (x - alpha[i] - beta[i] * B[i]) : null));
    const pnl = s.map((x, i) => {
      if (i === 0 || !isF(beta[i - 1])) return null;
      if (g.kind === "price") return 1e4 * ((w.a[i] / w.a[i - 1] - 1) - beta[i - 1] * (w.b[i] / w.b[i - 1] - 1));
      return scale * ((w.a[i] - w.a[i - 1]) - beta[i - 1] * (w.b[i] - w.b[i - 1]));
    });
    const rel = { id: "OPEN", d: w.d, s, pnl, fair_mode: mode === "ols" ? "const" : "rolling", fair_const: 0, fair_window: g.freq === "M" ? 36 : 252,
      cost: +$("#b-cost").value, carry: 0, hold: 0, rebal: 0, band_up: null, band_down: null, no_trade: [], roll: [], direction: "both", freq: g.freq,
      unit: "bp", pnl_unit: "bp" };
    const p = { entry: +$("#b-entry").value, exit: +$("#b-exit").value, stop: 4, lookback: Math.round(+$("#b-lb").value), maxHold: g.freq === "M" ? 36 : 126,
      lag: +$("#b-lag").value, costMult: 1, useBand: false };
    const bt = S.backtest(rel, p);
    const e1 = S.engleGranger(A, B), e2 = S.engleGranger(B, A), adfS = S.adf(s, { nvars: mode === "one" ? 1 : 2 });
    const ou = S.fitOU(s, mode === "one" ? 1 : 2, g.freq === "M" ? 1 / 12 : 1 / 252), pmr = S.bayesPMR(s.slice(-504));
    const m = bt.metrics, ep = S.episodes(bt.z, bt.dev, p.entry, p.exit, g.freq === "M" ? 36 : 252);
    const unitTxt = g.kind === "price" ? "bp (log spread)" : "bp of yield";
    out.innerHTML = `<div class="kpis">
      <div class="kpi"><span>Engle-Granger p</span><b>${num(Math.max(e1.p, e2.p), 3)}</b><small>worse of both orderings</small></div>
      <div class="kpi"><span>ADF p (this spread)</span><b>${num(adfS.p, 3)}</b><small>${mode === "one" ? "no estimated hedge" : "EG critical values"}</small></div>
      <div class="kpi"><span>Half-life</span><b>${hl(ou.hl)}</b><small>${g.freq === "M" ? "months" : "days"}</small></div>
      <div class="kpi"><span>P(mean reversion)</span><b>${pct(pmr)}</b><small>Bayes, last 2 years</small></div>
      <div class="kpi"><span>Hedge β (OLS)</span><b>${num(e1.beta, 3)}</b><small>A on B</small></div>
      <div class="kpi"><span>Net Sharpe</span><b>${num(m.sharpe, 2)}</b><small>${p.lag ? "next close" : "same close"}</small></div>
      <div class="kpi"><span>Trades</span><b>${m.trades}</b><small>hit ${pct(m.hit)}</small></div>
      <div class="kpi"><span>MAE, worst 5%</span><b>${num(m.maeP95, 0)}</b><small>${unitTxt}</small></div></div>
      <div id="b-c1"></div><div id="b-c2" style="margin-top:10px"></div>
      <p class="small muted">${ep.length} past entries; ${pct(ep.length ? ep.filter((e) => e.reverted).length / ep.length : NaN)} reverted. ${mode === "ols" ? "OLS on the whole window uses information from the future of each day: fine for describing the relationship, optimistic for trading. Use Kalman for a causal hedge." : ""} ${g.kind === "yield" ? "Yield spreads: P&L per DV01-neutral unit (carry and roll-down not included here)." : ""}</p>`;
    chart($("#b-c1"), { height: 260, yFmt: (x) => x.toFixed(0) }).setData({ x: w.d, series: [{ y: s, color: "--series-1", label: "Spread (" + unitTxt + ")" }] });
    let cn = 0; const eq = bt.net.map((x) => (cn += x));
    chart($("#b-c2"), { height: 200, yFmt: (x) => x.toFixed(0) }).setData({ x: w.d, series: [{ y: eq, color: "--series-1", label: "Cumulative net P&L of one unit" }] });
    resizeParent();
  }

  // ------------------------------------------------------------------------------------------ research
  function renderResearch() {
    const host = $("#tab-research");
    if (host.dataset.ready) return;
    host.dataset.ready = "1";
    const R = state.meta.research || {}, e1 = R.e1 || {}, e2 = R.e2 || {}, e3 = R.e3 || {}, e4 = R.e4 || {}, e5 = R.e5 || {}, e6 = R.e6 || {}, e7 = R.e7 || {}, e8 = R.e8 || {}, e9 = R.e9 || {};
    const tiers = ["arbitrage", "quasi", "statistical"];
    const sc = e2.same_close_vs_base || {};
    host.innerHTML = `<div class="cards">
      <div class="card"><h3>Same-close fills invent arbitrage</h3><p>Median net Sharpe by strength, same parameters and costs, only the execution timing changed:</p><div id="r-lag"></div>
        <p class="small muted">${e2.same_close_sharpe_gt1 ?? "–"} relationships exceed a Sharpe of 1 if you assume you trade at the very close that produced the signal; ${e2.base_sharpe_gt1 ?? "–"} do with next-close execution. The "profits" are bid-ask bounce at the close, stale NAVs and non-synchronous closing prices.</p></div>
      <div class="card"><h3>Multiple testing</h3><div class="funnel">
        <div>Strategies backtested <b>${e3.n_tested ?? "–"}</b></div><div>Positive at p &lt; 5% <b>${e3.raw_p_lt_005 ?? "–"}</b></div>
        <div>Expected by chance <b>${num(e3.expected_false_raw, 1)}</b></div><div>Survive Benjamini-Hochberg (q &lt; 10%) <b>${e3.bh_q_lt_010 ?? "–"}</b></div>
        <div>Reality check p for the best <b>${num(e3.reality_check?.pvalue, 2)}</b></div><div>Deflated Sharpe of the best <b>${num(e3.deflated_sharpe_best?.dsr, 3)}</b></div></div></div>
      <div class="card"><h3>The cointegration scan</h3><div class="funnel">
        <div>Pairs tested, last 3 years <b>${e4.latest_pairs ?? "–"}</b></div><div>Engle-Granger p &lt; 5% (worse order) <b>${e4.latest_raw_p05 ?? "–"}</b></div>
        <div>False-positive rate on random walks <b>${pct(e4.null_rate_eg_756, 1)}</b></div><div>Survive Benjamini-Hochberg <b>${e4.latest_bh_q05 ?? "–"}</b></div></div>
        <p class="small muted">Re-tested over the next three years, ${pct(e4.rolling?.bh_q05?.mean_persist)} of BH-selected pairs and ${pct(e4.rolling?.raw_p05?.mean_persist)} of raw-p selections were still cointegrated, against a base rate of ${pct(e4.rolling?.all?.mean_persist)}. Traded out of sample with frozen hedges, they earned ${num(e4.oos_trading?.bh_q05?.mean_net, 0)} and ${num(e4.oos_trading?.raw_p05?.mean_net, 0)} bp per pair-year after costs.</p></div>
      <div class="card"><h3>What the scan shows today</h3><div id="r-scan"></div><p class="small muted">As of ${e1.asof ?? state.meta.asof}. Most "signals" fail a check: non-synchronous prices, costs above the expected convergence, or no evidence of mean reversion.</p></div>
      <div class="card"><h3>Hedge ratios</h3><p>Across ${e5.n_pairs ?? "–"} statistical pairs, median net Sharpe: rolling OLS ${num(e5.median_sharpe?.rolling, 2)}, Kalman ${num(e5.median_sharpe?.kalman, 2)}, 1:1 ${num(e5.median_sharpe?.ratio, 2)}, static formation hedge ${num(e5.median_sharpe?.static, 2)}. Estimation choices move results less than costs and timing do; a frozen hedge decays.</p></div>
      <div class="card"><h3>Regime and Bayesian gates</h3><p>Trading only when a walk-forward Markov-switching filter or the Bayesian model says the spread is mean-reverting changed the median Sharpe by ${signed(e6.regime_minus_none_median, 2)} (regime) and ${signed(e6.bayes_minus_none_median, 2)} (Bayes) across ${e6.n ?? "–"} economic-link and statistical relationships, improving ${pct(e6.regime_better_share)} and ${pct(e6.bayes_better_share)} of them.</p></div>
      <div class="card"><h3>False positives worth knowing</h3><ul class="small">
        <li>ADR premium vs next day's home-market return: median correlation ${num(e7.adr_timing?.asia_median_corr, 2)} for Asian listings (the home market catches up overnight) vs ${num(e7.adr_timing?.europe_median_corr, 2)} for European ones.</li>
        <li>International ETFs' "premium" predicts the next NAV change (median correlation ${num(e7.nav_staleness?.equity_intl?.corr_prem_next_nav, 2)}): the NAV is stale, not the price.</li>
        <li>FX triangle from two official fixings 6 hours apart: same-close Sharpe ${num(e7.fx_triangle?.TRI_EURJPY?.same_close_sharpe, 1)}, next-close ${num(e7.fx_triangle?.TRI_EURJPY?.next_close_sharpe, 1)}.</li>
        <li>WTI front spread in April 2020: contango reached ${num(e7.wti_2020?.max_contango_bp, 0)} bp against a full-carry bound of ${num(e7.wti_2020?.full_carry_bp_that_day, 0)} bp: the bound assumed storage that did not exist.</li>
        <li>Berkshire A/B: class B traded through the conversion bound on ${pct(e7.brk_bound?.share_days_below_minus_band, 1)} of days (closing-print noise).</li></ul></div>
      <div class="card"><h3>Costs decide</h3><div id="r-cost"></div><p class="small muted">Median net Sharpe by cost multiplier (0 = free trading). Stability: the share of rolling two-year windows in which the spread is stationary is ${pct(e9.by_tier?.arbitrage?.median_share_stationary)} for arbitrage links, ${pct(e9.by_tier?.quasi?.median_share_stationary)} for economic links and ${pct(e9.by_tier?.statistical?.median_share_stationary)} for statistical ones.</p></div>
    </div>
    <p class="small muted" style="margin-top:14px">Full report with methods, tables and every failed idea: <a href="https://github.com/RasmusCodes/cross-asset-rv-scanner/blob/main/reports/REPORT.md" target="_blank" rel="noopener">reports/REPORT.md on GitHub</a>.</p>`;
    C.bars($("#r-lag"), tiers.flatMap((t) => [{ label: `${TIER_LABEL[t]}: same close`, v: sc[t]?.same_close ?? NaN }, { label: `${TIER_LABEL[t]}: next close`, v: sc[t]?.base ?? NaN }]).filter((d) => isF(d.v)), (x) => x.toFixed(2));
    const bs = e1.by_status || {};
    C.bars($("#r-scan"), STATUS.filter((s) => bs[s]).map((s) => ({ label: STATUS_LABEL[s], v: bs[s] })), (x) => x.toFixed(0));
    const cs = e8.median_sharpe_by_tier_and_cost || {};
    C.bars($("#r-cost"), tiers.flatMap((t) => ["0.0", "1.0", "2.0"].map((m) => ({ label: `${TIER_LABEL[t]} ×${m}`, v: cs[t]?.[m] ?? NaN }))).filter((d) => isF(d.v)), (x) => x.toFixed(2));
    resizeParent();
  }

  // ------------------------------------------------------------------------------------------ self-check (JS engine vs Python engine)
  window.__rvSelfCheck = async (ids) => {
    const out = [];
    ids = ids || state.rels.filter((r) => r.tradable).slice(0, 25).map((r) => r.id);
    for (const id of ids) {
      const data = await loadRel(id);
      if (!data.py_check) continue;
      const bt = S.backtest(Object.assign({}, data, { id }), Object.assign({}, { entry: 2, exit: 0.5, stop: 4, lookback: 126, maxHold: 126, lag: 1, costMult: 1, useBand: true, direction: data.direction }));
      out.push({ id, js_sharpe: +bt.metrics.sharpe.toFixed(4), py_sharpe: +data.py_check.sharpe.toFixed(4), js_trades: bt.metrics.trades, py_trades: data.py_check.trades,
                 js_net: +bt.metrics.netTotal.toFixed(2), py_net: +data.py_check.net_total.toFixed(2) });
    }
    return out;
  };

  boot().catch((e) => { document.querySelector(".app").insertAdjacentHTML("beforeend", `<p class="note warn">Could not load data: ${esc(e.message)}</p>`); });
})();
