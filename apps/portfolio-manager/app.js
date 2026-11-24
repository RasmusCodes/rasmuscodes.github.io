/* Portfolio manager demo: UI and state. All numbers are computed here with the QPM engine (engine.js). */
(async function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const E = window.QPM, C = window.Charts, fmt = C.fmt, esc = C.esc;
  const pct = (v, d = 1) => E.pct(v, d), spct = (v, d = 2) => E.spct(v, d);

  /* ---------------------------------------------------------------- embedding: theme + height */
  const embedded = window.self !== window.top;
  if (embedded) {
    document.body.classList.add("embedded");
    try {
      const pdoc = window.parent.document.documentElement;
      const sync = () => { const t = pdoc.getAttribute("data-theme"); if (t) document.documentElement.setAttribute("data-theme", t); else document.documentElement.removeAttribute("data-theme"); };
      sync(); new MutationObserver(sync).observe(pdoc, { attributes: true, attributeFilter: ["data-theme"] });
    } catch (e) { /* cross-origin parent: fall back to the OS colour scheme */ }
    const post = () => window.parent.postMessage({ type: "qpm-demo-height", height: document.documentElement.scrollHeight }, "*");
    new ResizeObserver(post).observe(document.body); window.addEventListener("load", post);
  }

  /* ---------------------------------------------------------------- data */
  const B = window.QPM_DATA;   /* data/bundle.js */
  if (!B) { $("messages").innerHTML = `<div class="msg msg--bad">Could not load the demo data.</div>`; return; }
  const DATA = { universes: { multi_asset: B.universe_multi_asset, sleeves: B.universe_sleeves }, signals: B.signals, scenarios: B.scenarios, study: B.study };

  const METHOD_INFO = {
    equal_weight: ["Equal weight (1/N)", "The same weight in every asset. No estimates at all, which is why it is hard to beat."],
    market_cap: ["Market weight (60/40)", "60% in industries by market value, 20% in each Treasury. The passive benchmark."],
    inverse_vol: ["Risk parity (inverse volatility)", "Weights proportional to 1 / volatility; ignores correlations."],
    min_variance: ["Minimum variance", "The least volatile portfolio allowed by the constraints. Uses only the covariance."],
    erc: ["Equal risk contribution", "Each asset contributes the same share of portfolio volatility, correlations included."],
    hrp: ["Hierarchical risk parity", "Clusters similar assets, then splits capital between clusters by inverse variance (López de Prado 2016)."],
    mean_variance: ["Mean-variance", "Maximises expected return minus (risk aversion / 2) × variance."],
    max_sharpe: ["Maximum Sharpe ratio", "The constrained portfolio with the highest expected excess return per unit of volatility."],
    black_litterman: ["Black-Litterman", "Starts from market-implied returns and tilts toward the active signals as views."],
    kelly_half: ["Kelly (half)", "Growth-optimal sizing at half strength; cash makes up the rest, gross exposure up to 150%."],
    kelly: ["Kelly (full)", "Growth-optimal sizing under a normal approximation; very sensitive to expected returns."],
    vol_target: ["Volatility target (ERC at 10%)", "Equal risk contribution scaled to 10% volatility, with cash, no leverage."],
    factor_neutral: ["Market-neutral mean-variance", "Long-short, dollar-neutral and with zero equity-market beta."],
  };
  const BT_METHODS = { equal_weight: "1/N", market_cap: "60/40", inverse_vol: "Inverse vol", min_variance: "Min variance", erc: "ERC", hrp: "HRP",
    mean_variance: "MV (sample)", mv_bs: "MV (Bayes-Stein)", max_sharpe: "Max Sharpe (sample)", kelly_half: "Half Kelly" };
  const FAMILY = { statistical_arbitrage: "Statistical arbitrage", equity_factor: "Equity factor", options_volatility: "Options & volatility",
    alternative_data: "Alternative data", earnings_event: "Earnings & events", credit: "Credit", macro_fixed_income: "Macro & fixed income", microstructure: "Microstructure" };

  const S = {
    key: "multi_asset", U: null, excluded: new Set(), custom: [], edits: {}, method: "max_sharpe", compare: "equal_weight",
    riskAversion: 4, meanSource: "historical", covMethod: "lw_cc", window: 120,
    enabledSignals: new Set(DATA.signals.signals.filter((s) => !s.illustrative).map((s) => s.source)),
    userSignals: [], comboMethod: "equal", comboIC: 0.04, scenarios: DATA.scenarios.map((s) => Object.assign({}, s)), selectedScenario: 0,
    tab: "construct", last: null,
  };

  /* ---------------------------------------------------------------- universe + inputs */
  function setUniverse(key) {
    S.key = key; S.U = DATA.universes[key]; S.excluded = new Set(); S.custom = []; S.edits = {};
    const U = S.U;
    $("asof").textContent = `Monthly data ${U.dates[0]} to ${U.dates[U.dates.length - 1]}`;
    $("last-month").textContent = U.dates[U.dates.length - 1];
    fillMethodSelects(); renderAssetTable(); renderGroupCaps(); fillBacktestControls(); fillSignalForm();
  }
  function assetsAll() { return S.U.assets.map((a, j) => ({ name: a, label: S.U.labels[a] || a, j, group: S.U.groups[a] })).concat(S.custom.map((c) => ({ name: c.name, label: c.name, j: -1, group: "Custom", custom: c }))); }
  function active() { return assetsAll().filter((a) => !S.excluded.has(a.name)); }

  function windowRows() {
    const U = S.U, T = U.returns.length, w = Math.min(S.window, T);
    return { from: T - w, to: T };
  }
  function marketWeights(list) {
    const U = S.U;
    if (S.key !== "multi_asset" || !U.mcap_last) return list.map(() => 1 / list.length);
    const eq = list.filter((a) => a.group === "Equity"), bonds = list.filter((a) => a.group === "Treasury");
    const capSum = E.sum(eq.map((a) => U.mcap_last[a.name] || 0)) || 1, eqShare = bonds.length ? 0.6 : 1, bShare = eq.length ? 0.4 : 1;
    return list.map((a) => a.group === "Equity" ? eqShare * (U.mcap_last[a.name] || 0) / capSum : a.group === "Treasury" ? bShare / bonds.length : 0.02);
  }

  /* expected excess returns and covariance (annualised) for the active assets */
  function inputs() {
    const U = S.U, list = active(), hist = list.filter((a) => a.j >= 0), { from, to } = windowRows();
    const X = []; for (let t = from; t < to; t++) X.push(hist.map((a) => U.returns[t][a.j] - U.rf[t]));
    const n = list.length;
    let cov = E.zeros(n, n), muHist = new Array(n).fill(0);
    if (hist.length >= 2) {
      const ch = E.estimateCov(X, S.covMethod).map((r) => r.map((v) => v * 12));
      const mh = S.meanSource === "bayes_stein" ? E.bayesStein(X).mu : E.colMeans(X);
      const hIdx = list.map((a) => hist.indexOf(a));
      for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) if (hIdx[i] >= 0 && hIdx[k] >= 0) cov[i][k] = ch[hIdx[i]][hIdx[k]];
      list.forEach((a, i) => { if (hIdx[i] >= 0) muHist[i] = mh[hIdx[i]] * 12; });
      // custom assets: one-factor covariance through the equity market
      const fm = U.factors.names.indexOf("Mkt-RF"), m = []; for (let t = from; t < to; t++) m.push(U.factors.values[t][fm]);
      const vm = E.stdOf(m) ** 2 * 12;
      list.forEach((a, i) => { if (!a.custom) return; const c = a.custom; cov[i][i] = c.vol * c.vol;
        list.forEach((b, k) => { if (b.custom || k === i) return; const xb = X.map((r) => r[hIdx[k]]), mb = E.meanOf(xb), mm = E.meanOf(m);
          let cv = 0; for (let t = 0; t < m.length; t++) cv += (xb[t] - mb) * (m[t] - mm); cv = cv / (m.length - 1) * 12;
          cov[i][k] = cov[k][i] = c.rho * c.vol / Math.sqrt(vm) * cv; }); });
      list.forEach((a, i) => { if (!a.custom) return; list.forEach((b, k) => { if (b.custom && k !== i) cov[i][k] = cov[k][i] = a.custom.rho * b.custom.rho * a.custom.vol * b.custom.vol; }); });
    } else { list.forEach((a, i) => { cov[i][i] = a.custom ? a.custom.vol ** 2 : 0.04; }); }
    // volatility overrides keep correlations
    list.forEach((a, i) => { const ed = S.edits[a.name]; if (ed && Number.isFinite(ed.vol)) { const s = ed.vol / Math.sqrt(cov[i][i]); for (let k = 0; k < n; k++) { cov[i][k] *= s; cov[k][i] *= s; } cov[i][i] = ed.vol * ed.vol; } });
    cov = E.nearestPSD(cov);
    const wm = marketWeights(list), pi = E.matVec(cov, wm).map((v) => 2.5 * v);
    let mu;
    if (S.meanSource === "historical" || S.meanSource === "bayes_stein") mu = muHist.slice();
    else if (S.meanSource === "equilibrium") mu = pi.slice();
    else { const z = combinedScores(list), vol = cov.map((r, i) => Math.sqrt(r[i])); mu = pi.map((p, i) => p + S.comboIC * vol[i] * (z[list[i].name] || 0)); }
    list.forEach((a, i) => { if (a.custom) mu[i] = a.custom.mu; const ed = S.edits[a.name]; if (ed && Number.isFinite(ed.mu)) mu[i] = ed.mu; });
    return { list, names: list.map((a) => a.name), labels: Object.fromEntries(list.map((a) => [a.name, a.label])), mu, cov, wm, pi, muHist };
  }

  function constraints(inp) {
    const n = inp.list.length, ls = $("long-short").checked, minW = +$("min-w").value / 100, maxW = +$("max-w").value / 100;
    const cons = { lower: ls ? Math.min(minW, maxW) : Math.max(0, Math.min(minW, maxW)), upper: maxW, budget: 1 };
    if (ls) cons.grossMax = +$("gross").value / 100;
    const groups = []; document.querySelectorAll("[data-group-cap]").forEach((inpEl) => { const v = inpEl.value.trim(); if (v === "") return;
      const g = inpEl.dataset.groupCap, members = inp.list.map((a, i) => (a.group === g ? i : -1)).filter((i) => i >= 0); if (members.length) groups.push({ name: g, members, min: null, max: +v / 100 }); });
    cons.groups = groups;
    const mv = $("max-vol").value.trim(); if (mv !== "") cons.maxVol = +mv / 100;
    return cons;
  }
  function marketBetas(inp) {
    const U = S.U, { from, to } = windowRows(), fm = U.factors.names.indexOf("Mkt-RF"), Y = [], X = [];
    for (let t = from; t < to; t++) { Y.push(inp.list.map((a) => (a.j >= 0 ? U.returns[t][a.j] - U.rf[t] : 0))); X.push([U.factors.values[t][fm]]); }
    const b = E.olsBetas(Y, X).betas.map((r) => r[0]);
    inp.list.forEach((a, i) => { if (a.custom) b[i] = a.custom.rho * a.custom.vol / Math.sqrt(E.stdOf(X.map((r) => r[0])) ** 2 * 12); });
    return b;
  }

  function runMethod(method, inp, cons) {
    const ctx = { mu: inp.mu, cov: inp.cov, names: inp.names, cons, riskAversion: S.riskAversion, marketWeights: inp.wm, kellyLeverage: 1.5, baseMethod: "erc", targetVol: 0.10, maxLeverage: 1 };
    if (method === "black_litterman") {
      const z = combinedScores(inp.list), vol = inp.cov.map((r, i) => Math.sqrt(r[i])), idx = inp.list.map((a, i) => (Math.abs(z[a.name] || 0) > 1e-9 ? i : -1)).filter((i) => i >= 0);
      ctx.views = { P: idx.map((i) => inp.names.map((_, k) => (k === i ? 1 : 0))), Q: idx.map((i) => inp.pi[i] + S.comboIC * vol[i] * z[inp.names[i]]), conf: idx.map(() => 0.25) };
    }
    if (method === "factor_neutral" || $("beta-neutral").checked) {
      if (!["mean_variance", "max_sharpe", "factor_neutral", "kelly", "kelly_half"].includes(method)) {
        const p = E.optimize(method, ctx); p.messages = (p.messages || []).concat(["Market-neutral applies only to the return-based methods (mean-variance, max Sharpe); ignored here."]); return p; }
      ctx.factorBetas = [{ name: "Mkt-RF", betas: marketBetas(inp) }]; ctx.lsCap = Math.max(0.05, cons.upper); ctx.cons = Object.assign({}, cons, { grossMax: cons.grossMax ?? 2 });
      if (method !== "factor_neutral") { const fc = Object.assign({}, ctx.cons, { budget: 0, lower: -ctx.lsCap, upper: ctx.lsCap, factors: [{ name: "Mkt-RF", betas: ctx.factorBetas[0].betas, min: 0, max: 0 }] });
        ctx.cons = fc; const p = method === "max_sharpe" ? E.maxSharpe(inp.mu, inp.cov, fc, inp.names) : E.meanVariance(inp.mu, inp.cov, S.riskAversion, fc, inp.names); p.method = method; return p; }
      return E.optimize("factor_neutral", ctx);
    }
    try { return E.optimize(method, ctx); } catch (e) { return { weights: inp.names.map(() => NaN), status: "error", messages: [e.message], info: {}, binding: [] }; }
  }

  /* ---------------------------------------------------------------- signals */
  function allSignals() { return DATA.signals.signals.concat(S.userSignals); }
  function combinedScores(list) {
    const names = list.map((a) => a.name), sigs = allSignals().filter((s) => S.enabledSignals.has(s.source));
    if (!sigs.length) return {};
    const withHist = Object.fromEntries(sigs.filter((s) => s.ic_history && s.ic_history.length > 24).map((s) => [s.source, s.ic_history]));
    let w;
    if (S.comboMethod === "equal") w = Object.fromEntries(sigs.map((s) => [s.source, 1 / sigs.length]));
    else if (S.comboMethod === "confidence") { const c = sigs.map((s) => s.confidence ?? 0.5), t = E.sum(c); w = Object.fromEntries(sigs.map((s, i) => [s.source, c[i] / t])); }
    else { w = Object.keys(withHist).length ? E.combineWeights(withHist, S.comboMethod) : {}; sigs.forEach((s) => { if (!(s.source in w)) w[s.source] = 0; }); }
    S.lastComboWeights = w;
    const raw = {}; names.forEach((a) => { let v = 0, cov = false; sigs.forEach((s) => { const z = s.values[a]; if (z !== undefined && z !== null) { v += (w[s.source] || 0) * z; cov = true; } }); if (cov) raw[a] = v; });
    const keys = Object.keys(raw); if (keys.length < 2) return raw;
    const m = E.meanOf(keys.map((k) => raw[k])), sd = E.stdOf(keys.map((k) => raw[k])) || 1;
    return Object.fromEntries(keys.map((k) => [k, (raw[k] - m) / sd]));
  }

  /* ---------------------------------------------------------------- UI builders */
  function fillMethodSelects() {
    const keys = Object.keys(METHOD_INFO).filter((k) => S.key === "multi_asset" || k !== "market_cap");
    $("method").innerHTML = keys.map((k) => `<option value="${k}">${METHOD_INFO[k][0]}</option>`).join("");
    $("compare").innerHTML = `<option value="">Nothing</option>` + keys.map((k) => `<option value="${k}">${METHOD_INFO[k][0]}</option>`).join("");
    $("method").value = S.method; $("compare").value = S.compare;
  }
  function renderAssetTable() {
    const inp = inputs();
    const rows = assetsAll().map((a) => {
      const i = inp.names.indexOf(a.name), mu = i >= 0 ? inp.mu[i] : null, vol = i >= 0 ? Math.sqrt(inp.cov[i][i]) : null, ed = S.edits[a.name] || {};
      return `<tr><td><input type="checkbox" data-incl="${esc(a.name)}" ${S.excluded.has(a.name) ? "" : "checked"} aria-label="Include ${esc(a.label)}"></td>
        <td class="nm" title="${esc(a.label)}">${esc(a.label)}</td>
        <td><input type="number" step="0.5" data-mu="${esc(a.name)}" value="${Number.isFinite(ed.mu) ? (ed.mu * 100).toFixed(1) : ""}" placeholder="${mu === null ? "" : (mu * 100).toFixed(1)}" aria-label="Expected return of ${esc(a.label)}"></td>
        <td><input type="number" step="1" min="0.5" data-vol="${esc(a.name)}" value="${Number.isFinite(ed.vol) ? (ed.vol * 100).toFixed(1) : ""}" placeholder="${vol === null ? "" : (vol * 100).toFixed(1)}" aria-label="Volatility of ${esc(a.label)}"></td>
        <td>${a.custom ? `<button class="rm" data-rm="${esc(a.name)}" aria-label="Remove ${esc(a.label)}">×</button>` : ""}</td></tr>`; }).join("");
    $("asset-table").innerHTML = `<thead><tr><th></th><th>Asset</th><th class="num">E[r] %</th><th class="num">Vol %</th><th></th></tr></thead><tbody>${rows}</tbody>`;
  }
  function renderGroupCaps() {
    const groups = [...new Set(Object.values(S.U.groups))];
    $("group-caps").innerHTML = groups.length > 1 ? `<div class="row2">${groups.map((g) => `<label class="field">Max in ${esc(g)} <input type="number" data-group-cap="${esc(g)}" placeholder="none" step="5" min="0" max="100"><span class="unit">%</span></label>`).join("")}</div>` : "";
  }

  /* ---------------------------------------------------------------- CONSTRUCT */
  function construct() {
    const inp = inputs(), cons = constraints(inp);
    const p = runMethod(S.method, inp, cons), q = S.compare ? runMethod(S.compare, inp, cons) : null;
    S.last = { inp, cons, p, q };
    renderAssetPlaceholders(inp);
    const msgs = [];
    (p.messages || []).forEach((m) => msgs.push([E.ok(p) ? "warn" : "bad", m]));
    if (!E.ok(p)) msgs.unshift(["bad", `${METHOD_INFO[S.method][0]} could not be solved (${p.status}). ${p.status === "primal_infeasible" ? "The constraints cannot all hold at once." : ""}`]);
    if (S.custom.length) msgs.push(["info", "Custom assets have no return history: their covariances come from a one-factor model, and history-based risk measures leave them out."]);
    $("messages").innerHTML = msgs.map(([k, m]) => `<div class="msg msg--${k}">${esc(m)}</div>`).join("");
    $("method-hint").textContent = METHOD_INFO[S.method][1];
    $("ra-field").style.display = ["mean_variance", "black_litterman", "factor_neutral"].includes(S.method) ? "" : "none";
    $("ra-val").textContent = S.riskAversion;
    $("gross-field").style.display = $("long-short").checked ? "" : "none";
    if (!E.ok(p)) { ["tiles", "weights-chart", "risk-chart", "why", "why-intro", "why-table"].forEach((id) => ($(id).innerHTML = "")); return; }
    const conc = E.concentration(p.weights, inp.cov), cash = 1 - E.sum(p.weights), gross = E.sum(p.weights.map(Math.abs));
    const tiles = [["Expected excess return", pct(p.expectedReturn), q && E.ok(q) ? `vs ${pct(q.expectedReturn)}` : ""],
      ["Volatility", pct(p.volatility), q && E.ok(q) ? `vs ${pct(q.volatility)}` : ""],
      ["Sharpe ratio (ex ante)", Number.isFinite(p.sharpe) ? p.sharpe.toFixed(2) : "–", q && E.ok(q) && Number.isFinite(q.sharpe) ? `vs ${q.sharpe.toFixed(2)}` : ""],
      ["Effective positions", conc.effectiveN.toFixed(1), `largest ${pct(conc.maxWeight)}`],
      ["Gross / cash", `${pct(gross, 0)}`, `cash ${pct(cash, 0)}`]];
    $("tiles").innerHTML = tiles.map(([l, v, d]) => `<div class="tile"><div class="tile__label">${l}</div><div class="tile__value">${v}</div><div class="tile__delta">${d}</div></div>`).join("");
    const series = [{ name: METHOD_INFO[S.method][0], values: p.weights }]; if (q && E.ok(q)) series.push({ name: METHOD_INFO[S.compare][0], values: q.weights });
    const labels = inp.list.map((a) => a.label);
    C.legend($("weights-legend"), series);
    C.bars($("weights-chart"), { categories: inp.names, labels, series, format: fmt.pct1 });
    const rs = [{ name: series[0].name, values: p.riskContrib }]; if (q && E.ok(q)) rs.push({ name: series[1].name, values: q.riskContrib });
    C.bars($("risk-chart"), { categories: inp.names, labels, series: rs, format: fmt.pct0 });
    renderWhy(p, inp);
  }
  function renderAssetPlaceholders(inp) {
    document.querySelectorAll("[data-mu]").forEach((el) => { const i = inp.names.indexOf(el.dataset.mu); el.placeholder = i >= 0 ? (inp.mu[i] * 100).toFixed(1) : ""; });
    document.querySelectorAll("[data-vol]").forEach((el) => { const i = inp.names.indexOf(el.dataset.vol); el.placeholder = i >= 0 ? (Math.sqrt(inp.cov[i][i]) * 100).toFixed(1) : ""; });
  }
  function renderWhy(p, inp) {
    const ex = E.explain(p, inp.cov, inp.names, inp.labels), order = inp.names.map((n, i) => i).sort((a, b) => Math.abs(p.weights[b]) - Math.abs(p.weights[a]));
    let intro = "";
    if (ex.rows[0] && ex.rows[0].effectiveReturn !== undefined) {
      const fam = ex.families || [];
      intro = `The optimizer holds each asset in proportion to the part of its expected return that the other assets cannot replicate, divided by the risk they cannot hedge away: weight = (effective return − hedge return) ÷ (risk aversion × unhedgeable variance). Binding constraints act like changes to expected returns${fam.length ? ` (here: ${fam.join(", ")})` : ""}.`;
      if (ex.hurdle !== null && Math.abs(ex.hurdle) > 1e-6) intro += ` Being fully invested shifts every asset's effective return by ${spct(ex.hurdle)}.`;
      if (p.method === "min_variance") intro += " Minimum variance is the special case where every asset is assumed to have the same expected return.";
      const bind = (p.binding || []).slice(0, 4).map((b) => `${b.constraint.replace("bound:", "").replace("group:", "group ")} (${b.side}, shadow price ${pct(b.shadow, 2)})`);
      if (bind.length) intro += ` Most expensive constraints: ${esc(bind.join("; "))}.`;
    } else if (p.method === "hrp") intro = "Hierarchical risk parity orders assets so that similar ones sit together, then repeatedly splits the list in two and gives each half capital in inverse proportion to its variance. Expected returns play no part.";
    else if (p.method === "erc") intro = "Equal risk contribution sizes positions so each contributes the same share of portfolio volatility. Expected returns play no part.";
    else if (p.method === "vol_target") intro = `Equal risk contribution, scaled by ${(p.info.scale || 1).toFixed(2)} to reach the volatility target; the rest is cash.`;
    else intro = METHOD_INFO[p.method] ? METHOD_INFO[p.method][1] : "";
    $("why-intro").textContent = intro;
    $("why").innerHTML = order.map((i) => { const s = ex.sentences[inp.names[i]] || ""; const k = s.indexOf(":"); return `<p><b>${esc(s.slice(0, k))}</b>${esc(s.slice(k))}</p>`; }).join("");
    if (ex.rows[0] && ex.rows[0].effectiveReturn !== undefined) {
      const fams = ex.families || [];
      $("why-table").innerHTML = `<div class="table-wrap"><table><thead><tr><th>Asset</th><th class="num">Weight</th><th class="num">Input return</th>${fams.map((f) => `<th class="num">${esc(f)}</th>`).join("")}<th class="num">Effective</th><th class="num">Explained by others</th><th class="num">Unique</th><th class="num">Unhedgeable vol</th><th class="num">R²</th><th>Main hedges (betas)</th></tr></thead><tbody>${
        order.map((i) => { const r = ex.rows[i]; return `<tr><td>${esc(r.label)}</td><td class="num">${pct(r.weight)}</td><td class="num">${pct(r.inputReturn, 2)}</td>${fams.map((f) => `<td class="num">${spct(r.adjustments[f] || 0)}</td>`).join("")}<td class="num">${pct(r.effectiveReturn, 2)}</td><td class="num">${pct(r.hedgeReturn, 2)}</td><td class="num">${spct(r.uniqueReturn)}</td><td class="num">${pct(r.residualVol)}</td><td class="num">${pct(r.r2, 0)}</td><td>${esc(r.topHedges.map(([nm, b]) => `${inp.labels[nm] || nm} ${b >= 0 ? "+" : "−"}${Math.abs(b).toFixed(2)}`).join(", "))}</td></tr>`; }).join("")}</tbody></table></div>`;
    } else $("why-table").innerHTML = `<p class="hint">The decomposition table applies to optimizer-based methods.</p>`;
  }

  /* ---------------------------------------------------------------- SIGNALS */
  function renderSignals() {
    const list = active(), names = list.map((a) => a.name), sigs = allSignals();
    $("sig-asof").textContent = `as of ${DATA.signals.as_of}`;
    const cell = (z) => { if (z === undefined || z === null) return `<span class="cell" style="background:var(--surface-2)"></span>`; const a = Math.min(1, Math.abs(z) / 2);
      return `<span class="cell" title="${z.toFixed(2)}" style="background:color-mix(in srgb, ${z >= 0 ? "var(--pos)" : "var(--neg)"} ${Math.round(a * 100)}%, var(--mid))"></span>`; };
    $("sig-table").innerHTML = `<thead><tr><th></th><th>Signal</th><th>Family</th><th>Horizon</th><th class="num">IC</th><th class="num">t</th><th class="num">Hit rate</th><th class="num">Months</th><th>Scores by asset (blue = positive)</th></tr></thead><tbody>${
      sigs.map((s) => { const tr = s.track_record || {}; return `<tr><td><input type="checkbox" data-sig="${esc(s.source)}" ${S.enabledSignals.has(s.source) ? "checked" : ""} aria-label="Use ${esc(s.label)}"></td>
        <td><b>${esc(s.label)}</b><div class="note">${esc(s.source)} · v${esc(s.model_version)} · ${esc(s.provenance)}</div></td>
        <td><span class="badge${s.illustrative ? " badge--example" : ""}">${s.illustrative ? "Illustrative · " : ""}${esc(FAMILY[s.family] || s.family)}</span></td>
        <td>${s.horizon_days} days</td><td class="num">${tr.ic_mean != null ? tr.ic_mean.toFixed(3) : "–"}</td><td class="num">${tr.ic_t != null ? tr.ic_t.toFixed(1) : "–"}</td>
        <td class="num">${tr.hit_rate != null ? pct(tr.hit_rate, 0) : "–"}</td><td class="num">${tr.n_obs ?? "–"}</td>
        <td><div class="cells">${names.map((a) => cell(s.values[a])).join("")}</div></td></tr>`; }).join("")}</tbody>`;
    $("ic-val").textContent = S.comboIC.toFixed(3);
    const z = combinedScores(list), w = S.lastComboWeights || {}, inp = inputs(), vol = inp.cov.map((r, i) => Math.sqrt(r[i]));
    const enabled = sigs.filter((s) => S.enabledSignals.has(s.source));
    C.bars($("combo-weights"), { categories: enabled.map((s) => s.source), labels: enabled.map((s) => s.label), series: [{ name: "Signal weight", values: enabled.map((s) => w[s.source] || 0) }], format: fmt.pct0 });
    const alpha = inp.names.map((a, i) => S.comboIC * vol[i] * (z[a] || 0));
    C.bars($("combo-chart"), { categories: inp.names, labels: inp.list.map((a) => a.label), series: [{ name: "Expected return tilt (IC × vol × z)", values: alpha }], format: fmt.spct1, colorBySign: true,
      extraTip: (i) => `<div>Combined z-score: <b>${Number.isFinite(z[inp.names[i]]) ? z[inp.names[i]].toFixed(2) : "no signal"}</b></div><div>Equilibrium return: ${pct(inp.pi[i])}</div>` });
  }
  function fillSignalForm() {
    $("us-family").innerHTML = Object.entries(FAMILY).map(([k, v]) => `<option value="${k}">${v}</option>`).join("");
    $("us-instrument").innerHTML = assetsAll().map((a) => `<option value="${esc(a.name)}">${esc(a.label)}</option>`).join("");
  }

  /* ---------------------------------------------------------------- RISK */
  function backfill(p, inp) {
    const U = S.U, idx = inp.list.map((a) => a.j), out = [], dates = [];
    for (let t = 0; t < U.returns.length; t++) { let r = 0, w = 0; idx.forEach((j, i) => { if (j >= 0) { r += p.weights[i] * U.returns[t][j]; w += p.weights[i]; } }); out.push(r + (1 - w) * U.rf[t]); dates.push(U.dates[t]); }
    return { rets: out, dates };
  }
  function renderRisk() {
    if (!S.last || !E.ok(S.last.p)) { $("risk-intro").textContent = "Build a portfolio in the Construct tab first."; return; }
    const { p, inp } = S.last, U = S.U, alpha = +$("var-level").value, bf = backfill(p, inp), rep = E.varReport(bf.rets, alpha);
    $("risk-intro").textContent = `Risk of the ${METHOD_INFO[S.method][0].toLowerCase()} portfolio from the Construct tab. History-based measures hold today's weights over ${U.dates[0]} to ${U.dates[U.dates.length - 1]} (${bf.rets.length} months).`;
    const conc = E.concentration(p.weights, inp.cov), dd = E.drawdowns(bf.rets);
    const tiles = [["Volatility (ex ante)", pct(p.volatility)], ["Effective positions", conc.effectiveN.toFixed(1)], ["Effective independent bets", conc.effectiveBets.toFixed(1)], ["Diversification ratio", conc.diversificationRatio.toFixed(2)], ["Worst backfilled drawdown", pct(-dd.maxDD, 0)]];
    $("risk-tiles").innerHTML = tiles.map(([l, v]) => `<div class="tile"><div class="tile__label">${l}</div><div class="tile__value">${v}</div></div>`).join("");
    const z = E.normInv(alpha), exAnte = z * p.volatility / Math.sqrt(12);
    const rows = [["Historical", rep.historical, rep.historicalES], ["Normal (parametric)", rep.normal, rep.normalES], ["Cornish-Fisher (skew and kurtosis)", rep.cornishFisher, null], ["Monte Carlo, Student t (5 df)", rep.monteCarloT, rep.monteCarloTES], ["Ex ante, from the covariance", exAnte, null]];
    $("var-table").innerHTML = `<table><thead><tr><th>Method</th><th class="num">VaR ${pct(alpha, 0)}</th><th class="num">Expected shortfall</th></tr></thead><tbody>${rows.map(([n, v, es]) => `<tr><td>${n}</td><td class="num">${pct(v)}</td><td class="num">${es === null ? "–" : pct(es)}</td></tr>`).join("")}</tbody></table>`;
    $("var-note").textContent = `Losses over one month as a share of capital. Monthly returns here have skewness ${rep.skew.toFixed(2)} and excess kurtosis ${rep.kurtosis.toFixed(1)}; on daily data the study found unconditional VaR models breach too often and in clusters (Study results).`;
    // factor exposures over the window
    const { from, to } = windowRows(), fn = U.factors.names, Y = [], X = [];
    for (let t = from; t < to; t++) { Y.push(inp.list.map((a) => (a.j >= 0 ? U.returns[t][a.j] - U.rf[t] : 0))); X.push(U.factors.values[t]); }
    const ob = E.olsBetas(Y, X), expo = fn.map((_, k) => E.sum(p.weights.map((w, i) => w * ob.betas[i][k])));
    const Fc = E.sampleCov(X).map((r) => r.map((v) => v * 12)), fv = E.quad(expo, Fc), idio = E.sum(p.weights.map((w, i) => w * w * ob.residVar[i] * 12));
    C.bars($("factor-chart"), { categories: fn, labels: fn.map((f) => ({ "Mkt-RF": "Equity market", SMB: "Size", HML: "Value", RMW: "Profitability", CMA: "Investment", Mom: "Momentum", Rates: "Rates (10y Treasury)" }[f] || f)),
      series: [{ name: "Exposure (beta)", values: expo }], format: fmt.num2, colorBySign: true });
    $("factor-note").textContent = `Factors explain ${pct(fv / (fv + idio), 0)} of the portfolio's variance; the rest is specific to its holdings.`;
    C.lines($("dd-chart"), { x: bf.dates, series: [{ name: "Drawdown", values: dd.dd, color: "var(--neg)" }], format: fmt.pct0, height: 220, area: true, endLabels: false });
    // liquidity
    const aum = +$("aum").value, hasCaps = S.key === "multi_asset";
    if (!hasCaps) { $("liq").innerHTML = `<p class="hint">Factor sleeves are long-short portfolios of thousands of stocks; their trading capacity is not measurable from these data. Switch to the industries universe for liquidity analysis.</p>`; }
    else {
      const rows2 = inp.list.map((a, i) => { const adv = a.group === "Treasury" ? 5e10 : a.custom ? 1e9 : (U.mcap_last[a.name] || 0) * 1e6 * 0.004, pos = Math.abs(p.weights[i]) * aum;
        const days = adv > 0 ? pos / (0.1 * adv) : Infinity, vol = Math.sqrt(inp.cov[i][i]) / Math.sqrt(252), cost = adv > 0 ? Math.abs(p.weights[i]) * 0.5 * vol * Math.sqrt(pos / adv) : 0;
        return { a, pos, adv, days, cost }; }).filter((r) => r.pos > 0);
      const prof = [1, 5, 20].map((h) => E.sum(rows2.map((r) => Math.min(r.pos, 0.1 * r.adv * h))) / E.sum(rows2.map((r) => r.pos)));
      $("liq").innerHTML = `<p class="hint">ADV proxy: 0.4% of an industry's market value traded a day; $50bn a day for each Treasury. Exit at 10% of ADV; cost from the square-root law (η = 0.5).</p>
        <div class="tiles">${prof.map((v, k) => `<div class="tile"><div class="tile__label">Sellable in ${[1, 5, 20][k]} day${k ? "s" : ""}</div><div class="tile__value">${pct(v, 0)}</div></div>`).join("")}<div class="tile"><div class="tile__label">Exit cost</div><div class="tile__value">${(E.sum(rows2.map((r) => r.cost)) * 1e4).toFixed(1)} bp</div></div></div>
        <div class="table-wrap"><table><thead><tr><th>Asset</th><th class="num">Position</th><th class="num">ADV</th><th class="num">Days to exit</th></tr></thead><tbody>${rows2.sort((x, y) => y.days - x.days).slice(0, 8).map((r) => `<tr><td>${esc(r.a.label)}</td><td class="num">$${(r.pos / 1e6).toFixed(0)}m</td><td class="num">$${(r.adv / 1e9).toFixed(1)}bn</td><td class="num">${r.days < 0.1 ? "<0.1" : r.days.toFixed(1)}</td></tr>`).join("")}</tbody></table></div>`;
    }
    // correlation breakdown by volatility regime: months whose trailing 12-month market volatility is in the top
    // fifth. (Picking months by their own market return would bias correlations down: Forbes and Rigobon 2002.)
    const hist = inp.list.filter((a) => a.j >= 0), fm = fn.indexOf("Mkt-RF"), mk = U.factors.values.map((r) => r[fm]);
    const rv = mk.map((_, t) => (t >= 11 ? E.stdOf(mk.slice(t - 11, t + 1)) : NaN)), thr = E.quantile(rv.filter(Number.isFinite), 0.8);
    const rows3 = (hi) => { const X2 = []; for (let t = 11; t < U.returns.length; t++) if ((rv[t] > thr) === hi) X2.push(hist.map((a) => U.returns[t][a.j])); return X2; };
    const corrOf = (X2) => { const S2 = E.sampleCov(X2), sd = S2.map((r, i) => Math.sqrt(r[i])); return S2.map((r, i) => r.map((v, j) => v / (sd[i] * sd[j]))); };
    const Xs = rows3(true), Xc = rows3(false), cs = corrOf(Xs), cc = corrOf(Xc);
    const risky = hist.map((a, i) => (a.group === "Treasury" ? -1 : i)).filter((i) => i >= 0), bondIdx = hist.map((a, i) => (a.group === "Treasury" ? i : -1)).filter((i) => i >= 0);
    const avg = (M) => { let s = 0, k = 0; risky.forEach((i) => risky.forEach((j) => { if (i < j) { s += M[i][j]; k++; } })); return k ? s / k : NaN; };
    const sbCorr = (X2) => { if (!bondIdx.length || !risky.length) return null; const a = X2.map((r) => E.meanOf(risky.map((i) => r[i]))), b = X2.map((r) => E.meanOf(bondIdx.map((i) => r[i])));
      const ma = E.meanOf(a), mb = E.meanOf(b); let c = 0; for (let t = 0; t < a.length; t++) c += (a[t] - ma) * (b[t] - mb); return c / (a.length - 1) / (E.stdOf(a) * E.stdOf(b)); };
    const sbS = sbCorr(Xs), sbC = sbCorr(Xc);
    $("corr-note").textContent = `High-volatility months (${Xs.length}): average correlation among risky assets ${avg(cs).toFixed(2)}, against ${avg(cc).toFixed(2)} in the other ${Xc.length}` +
      (sbS !== null ? `; stocks vs Treasuries ${sbS.toFixed(2)} vs ${sbC.toFixed(2)}.` : ".") + " Part of the rise is mechanical when a common factor gets more volatile.";
    C.heatmap($("corr-chart"), { labels: hist.map((a) => a.name), matrix: cs, tipLabel: "Correlation in high-volatility months" });
  }

  /* ---------------------------------------------------------------- STRESS */
  function stressContext(inp) {
    const U = S.U, { from, to } = windowRows(), Y = [], X = [];
    for (let t = from; t < to; t++) { Y.push(inp.list.map((a) => (a.j >= 0 ? U.returns[t][a.j] - U.rf[t] : 0))); X.push(U.factors.values[t]); }
    const ob = E.olsBetas(Y, X);
    inp.list.forEach((a, i) => { if (a.custom) { const k = U.factors.names.indexOf("Mkt-RF"); ob.betas[i] = ob.betas[i].map((_, kk) => (kk === k ? a.custom.rho * a.custom.vol / 0.16 : 0)); } });
    const R = U.returns.map((r) => inp.list.map((a) => (a.j >= 0 ? r[a.j] : 0)));
    return { assets: inp.names, betas: ob.betas, factorNames: U.factors.names, returns: R, dates: U.dates, cov: inp.cov, groups: Object.fromEntries(inp.list.map((a) => [a.name, a.group])) };
  }
  function renderStress() {
    if (!S.last || !E.ok(S.last.p)) return;
    const { p, q, inp } = S.last, ctx = stressContext(inp);
    const res = S.scenarios.map((sc) => ({ sc, a: E.runScenario(p.weights, sc, ctx), b: q && E.ok(q) ? E.runScenario(q.weights, sc, ctx) : null }));
    const series = [{ name: METHOD_INFO[S.method][0], values: res.map((r) => r.a.pnl) }]; if (q && E.ok(q)) series.push({ name: METHOD_INFO[S.compare][0], values: res.map((r) => r.b.pnl) });
    C.legend($("stress-legend"), series);
    C.bars($("stress-chart"), { categories: res.map((r) => r.sc.key), labels: res.map((r) => r.sc.name.replace(/ \((replay|hypothetical)\)/, "").replace(" (+150 bp, hypothetical)", " +150 bp")), series, format: fmt.spct1,
      extraTip: (i) => `<div class="note">${esc(res[i].sc.kind)} · click for detail</div>` });
    $("stress-chart").querySelectorAll("rect.hit").forEach((r, i) => r.addEventListener("click", () => { S.selectedScenario = i; renderStressDetail(res); }));
    renderStressDetail(res);
  }
  function renderStressDetail(res) {
    const r = res[Math.min(S.selectedScenario, res.length - 1)], { inp } = S.last;
    $("stress-detail-title").textContent = r.sc.name;
    let desc = r.sc.description || "";
    if (r.a.stressedVol) desc += ` One-month volatility ${pct(r.a.baseVol)} → ${pct(r.a.stressedVol)}; stressed 99% VaR ${pct(r.a.stressedVaR)}.`;
    if (S.custom.length && r.sc.kind === "historical") desc += " Custom assets have no history and count as unchanged.";
    $("stress-desc").textContent = `${desc} Portfolio: ${spct(r.a.pnl, 1)}.`;
    C.bars($("stress-detail"), { categories: inp.names, labels: inp.list.map((a) => a.label), series: [{ name: "Contribution to P&L", values: r.a.contrib }], format: fmt.spct1, colorBySign: true,
      extraTip: (i) => `<div>Asset move: <b>${spct(r.a.moves[i], 1)}</b></div>` });
    $("scenario-json").value = JSON.stringify(Object.fromEntries(Object.entries(r.sc).filter(([k]) => k !== "key")), null, 1);
  }

  /* ---------------------------------------------------------------- FRONTIER + ESTIMATION ERROR */
  function renderFrontier() {
    if (!S.last || !E.ok(S.last.p)) return;
    const { p, q, inp, cons } = S.last;
    let fcons = Object.assign({}, cons); delete fcons.maxVol;
    const fr = E.efficientFrontier(inp.mu, inp.cov, fcons, inp.names, 28), lines = [], points = [];
    if (fr.points.length) lines.push({ name: "Efficient frontier", points: fr.points.map((x) => ({ x: x.vol, y: x.ret })), color: "var(--series-1)" });
    inp.list.forEach((a, i) => points.push({ x: Math.sqrt(inp.cov[i][i]), y: inp.mu[i], label: a.label, r: 4, color: "var(--chart-muted)" }));
    const ew = E.equalWeight(inp.cov, inp.mu);
    points.push({ x: ew.volatility, y: ew.expectedReturn, label: "Equal weight", r: 6, color: "var(--series-3)", showLabel: true, strong: true });
    points.push({ x: p.volatility, y: p.expectedReturn, label: METHOD_INFO[S.method][0], r: 7, color: "var(--series-1)", showLabel: true, strong: true });
    if (q && E.ok(q)) points.push({ x: q.volatility, y: q.expectedReturn, label: METHOD_INFO[S.compare][0], r: 7, color: "var(--series-2)", showLabel: true, strong: true });
    C.legend($("frontier-legend"), [{ name: "Frontier", color: "var(--series-1)" }, { name: "Assets", color: "var(--chart-muted)" }]);
    C.scatter($("frontier-chart"), { lines, points, xLabel: "Volatility (annual)", yLabel: "Expected excess return", height: 360 });
    $("frontier-note").textContent = fr.points.length ? `Frontier under the Construct constraints (volatility cap not applied), using the current expected returns (${$("mean-source").selectedOptions[0].text.toLowerCase()}). Portfolios below it are not optimal for these inputs; whether the inputs deserve that trust is the question the lab below answers.` : "No frontier: the constraints are infeasible.";
  }
  async function runEE() {
    if (!S.last || !E.ok(S.last.p)) return;
    const { inp, cons } = S.last, T = +$("ee-T").value, N = +$("ee-n").value, n = inp.names.length, method = S.method;
    const btn = $("ee-run"); btn.disabled = true;
    const L = E.cholesky(inp.cov.map((r, i) => r.map((v, j) => v / 12 + (i === j ? 1e-12 : 0)))), r = E.rng(17), muM = inp.mu.map((v) => v / 12);
    const truthP = runMethod(method, inp, cons), trueSR = (w) => E.dot(w, inp.mu) / Math.sqrt(E.quad(w, inp.cov));
    const promised = [], delivered = [], W = [];
    for (let b = 0; b < N; b++) {
      const X = []; for (let t = 0; t < T; t++) { const z = Array.from({ length: n }, () => r.normal()); X.push(muM.map((m, i) => m + E.dot(L[i].slice(0, i + 1), z.slice(0, i + 1)))); }
      const muE = E.colMeans(X).map((v) => v * 12), covE = E.estimateCov(X, S.covMethod).map((row) => row.map((v) => v * 12));
      const piE = E.matVec(covE, inp.wm).map((v) => 2.5 * v);
      let muUsed = muE;   /* re-estimate expected returns the way the Construct tab does */
      if (S.meanSource === "bayes_stein") muUsed = E.bayesStein(X).mu.map((v) => v * 12);
      else if (S.meanSource === "equilibrium") muUsed = piE;
      else if (S.meanSource === "signals") { const z = combinedScores(inp.list); muUsed = piE.map((p, i) => p + S.comboIC * Math.sqrt(covE[i][i]) * (z[inp.names[i]] || 0)); }
      inp.list.forEach((a, i) => { if (a.custom) muUsed[i] = inp.mu[i]; });
      const sim = Object.assign({}, inp, { mu: muUsed, cov: covE, pi: piE }), pp = runMethod(method, sim, cons);
      if (E.ok(pp)) { promised.push(E.dot(pp.weights, muE) / Math.sqrt(E.quad(pp.weights, covE))); delivered.push(trueSR(pp.weights)); W.push(pp.weights); }
      if (b % 10 === 9) { $("ee-status").textContent = `${b + 1} / ${N}`; await new Promise((res) => setTimeout(res)); }
    }
    btn.disabled = false; $("ee-status").textContent = `${W.length} simulations`;
    const ewSR = trueSR(new Array(n).fill(1 / n)), tSR = E.ok(truthP) ? trueSR(truthP.weights) : NaN;
    const pts = promised.map((v, i) => ({ x: delivered[i], y: v, r: 3.5, color: "var(--series-1)", label: "One simulated history" }));
    const lo = Math.min(0, ...delivered, ...promised), hi = Math.max(...delivered, ...promised, tSR || 0);
    C.scatter($("ee-sharpe"), { points: pts.concat([{ x: tSR, y: tSR, r: 7, color: "var(--series-2)", label: "With the true inputs", showLabel: true, strong: true }, { x: ewSR, y: ewSR, r: 6, color: "var(--series-3)", label: "Equal weight", showLabel: true, strong: true }]),
      lines: [{ name: "promise kept", points: [{ x: lo, y: lo }, { x: hi, y: hi }], color: "var(--chart-muted)", thin: true }], xFormat: fmt.num2, yFormat: fmt.num2, xLabel: "Delivered Sharpe (true inputs)", yLabel: "Promised Sharpe (estimates)", height: 300 });
    const q = (a, p) => E.quantile(a, p);
    const stats = inp.names.map((_, i) => { const col = W.map((w) => w[i]); return { min: q(col, 0.05), q1: q(col, 0.25), med: q(col, 0.5), q3: q(col, 0.75), max: q(col, 0.95), ref: E.ok(truthP) ? truthP.weights[i] : NaN }; });
    C.boxes($("ee-weights"), { labels: inp.list.map((a) => a.label), stats, format: fmt.pct0 });
    const mp = E.meanOf(promised), md = E.meanOf(delivered);
    /* Black-Litterman's views come from the signals, not from the simulated history, so it is not in this list */
    const usesMeans = ["mean_variance", "max_sharpe", "kelly", "kelly_half", "factor_neutral"].includes(method) && S.meanSource !== "equilibrium" && S.meanSource !== "signals";
    $("ee-note").textContent = `${METHOD_INFO[method][0]}: promised Sharpe ${mp.toFixed(2)} on average (what each simulated history shows in-sample), delivered ${md.toFixed(2)}; with the true inputs ${Number.isFinite(tSR) ? tSR.toFixed(2) : "–"}, equal weight ${ewSR.toFixed(2)}. ` +
      (usesMeans ? "This method feeds on estimated means, so its weights swing with sampling noise and it promises far more than it delivers."
        : "This method does not use the simulated means, so its weights barely move and what it delivers is close to what it would with the truth.");
  }

  /* ---------------------------------------------------------------- BACKTEST */
  function fillBacktestControls() {
    const keys = Object.keys(BT_METHODS).filter((k) => S.key === "multi_asset" || k !== "market_cap"), def = ["equal_weight", "min_variance", "erc", "max_sharpe"];
    $("bt-methods").innerHTML = `<legend>Methods (up to 4)</legend>` + keys.map((k) => `<label><input type="checkbox" value="${k}" ${def.includes(k) ? "checked" : ""}> ${BT_METHODS[k]}</label>`).join("");
    const years = [...new Set(S.U.dates.map((d) => d.slice(0, 4)))].filter((y, i, a) => i >= Math.ceil(S.window / 12));
    $("bt-start").innerHTML = years.map((y) => `<option value="${y}">${y}</option>`).join("");
    $("bt-cost-b").closest(".field").style.display = S.key === "multi_asset" ? "" : "none";
  }
  async function runBacktest() {
    const chosen = [...$("bt-methods").querySelectorAll("input:checked")].map((x) => x.value).slice(0, 4);
    if (!chosen.length) return;
    const U = S.U, list = active().filter((a) => a.j >= 0), names = list.map((a) => a.name), every = +$("bt-every").value;
    const R = U.returns.map((r) => list.map((a) => r[a.j])), costs = list.map((a) => (a.group === "Treasury" ? +$("bt-cost-b").value : +$("bt-cost").value));
    const inp0 = { list, names }, cons0 = constraints(Object.assign({}, inp0)); delete cons0.maxVol;
    const startIdx = U.dates.findIndex((d) => d.startsWith($("bt-start").value)), window = S.window;
    const first = Math.max(window, startIdx);
    $("bt-progress").hidden = false; $("bt-run").disabled = true; const bar = $("bt-progress").firstElementChild;
    const results = [];
    for (let m = 0; m < chosen.length; m++) {
      const key = chosen[m], method = key === "mv_bs" ? "mean_variance" : key, mean = key === "mv_bs" ? "bayes_stein" : "sample";
      let w = new Array(names.length).fill(0); const net = [], dates = [], rfOut = [], to = [], cst = []; let x0 = null;
      for (let t = first; t < R.length - 1; t++) {
        let cost = 0;
        if ((t - first) % every === 0) {
          const hist = R.slice(t + 1 - window, t + 1).map((row, i) => row.map((v) => v - U.rf[t + 1 - window + i]));
          let target;
          try {
            if (method === "equal_weight") target = names.map(() => 1 / names.length);
            else if (method === "market_cap") target = marketWeights(list);
            else {
              const cov = E.estimateCov(hist, S.covMethod).map((r) => r.map((v) => v * 12)), mu = (mean === "bayes_stein" ? E.bayesStein(hist).mu : E.colMeans(hist)).map((v) => v * 12);
              const p = E.optimize(method, { mu, cov, names, cons: cons0, riskAversion: S.riskAversion, marketWeights: marketWeights(list), kellyLeverage: 1.5 });
              if (!E.ok(p)) throw new Error(p.status); target = p.weights;
            }
          } catch (e) { target = w.slice(); }
          const traded = target.map((v, i) => Math.abs(v - w[i])); cost = E.sum(traded.map((v, i) => v * costs[i] / 1e4)); w = target; to.push(E.sum(traded)); cst.push(cost);
        }
        const r = R[t + 1], cash = 1 - E.sum(w), port = E.dot(w, r) + cash * U.rf[t + 1] - 0.003 / 12 * E.sum(w.map((v) => Math.max(-v, 0)));
        net.push((1 - cost) * (1 + port) - 1); dates.push(U.dates[t + 1]); rfOut.push(U.rf[t + 1]);
        w = w.map((v, i) => v * (1 + r[i]) / (1 + port));
        if ((t - first) % 24 === 0) { bar.style.width = `${Math.round(100 * (m + (t - first) / (R.length - first)) / chosen.length)}%`; await new Promise((res) => setTimeout(res)); }
      }
      const st = E.perfStats(net, rfOut), yrs = net.length / 12;
      results.push({ name: BT_METHODS[key], net, dates, st, turnover: E.sum(to) / yrs, cost: E.sum(cst) / yrs });
    }
    bar.style.width = "100%"; $("bt-run").disabled = false; setTimeout(() => ($("bt-progress").hidden = true), 300);
    $("bt-out").hidden = false;
    const growth = results.map((r) => { let g = 1; return { name: r.name, values: r.net.map((v) => (g *= 1 + v)) }; });
    C.legend($("bt-legend"), growth, true);
    C.lines($("bt-growth"), { x: results[0].dates, series: growth, log: true, height: 320 });
    C.lines($("bt-dd"), { x: results[0].dates, series: results.map((r) => ({ name: r.name, values: E.drawdowns(r.net).dd })), format: fmt.pct0, height: 200, endLabels: false });
    $("bt-table").innerHTML = `<div class="table-wrap"><table><thead><tr><th>Method</th><th class="num">Return</th><th class="num">Volatility</th><th class="num">Sharpe</th><th class="num">Max drawdown</th><th class="num">Turnover / yr</th><th class="num">Costs / yr</th></tr></thead><tbody>${
      results.map((r) => `<tr><td>${esc(r.name)}</td><td class="num">${pct(r.st.annReturn)}</td><td class="num">${pct(r.st.volatility)}</td><td class="num">${r.st.sharpe.toFixed(2)}</td><td class="num">${pct(r.st.maxDrawdown, 0)}</td><td class="num">${r.turnover.toFixed(2)}</td><td class="num">${pct(r.cost, 2)}</td></tr>`).join("")}</tbody></table></div>
      <p class="hint">${results[0].dates[0]} to ${results[0].dates[results[0].dates.length - 1]}, ${S.window}-month window, ${({ 1: "monthly", 3: "quarterly", 12: "annual" })[every]} rebalancing, ${$("cov-method").selectedOptions[0].text.toLowerCase()} covariance. Sharpe differences of this size are usually within noise: the study's paired bootstrap intervals are about ±0.15.</p>`;
  }

  /* ---------------------------------------------------------------- STUDY */
  function renderStudy() {
    const st = DATA.study, el = $("study");
    if (el.dataset.done) return; el.dataset.done = "1";
    const tbl = (head, rows) => `<div class="table-wrap"><table><thead><tr>${head.map((h, i) => `<th${i ? ' class="num"' : ""}>${h}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${i ? ' class="num"' : ""}>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
    let html = `<div class="card study"><h3>What the study found</h3><p class="finding">Pre-registered tests on public data, 1972 to 2026, after costs. Full report, data and code are on GitHub.</p><ul class="finding">
      <li>No optimizer beat equal weights by more than chance. Sample-mean maximum Sharpe trailed by 0.13 Sharpe; the best (Black-Litterman with momentum views) led by 0.06, with a 95% interval of −0.03 to +0.15.</li>
      <li>Risk-based methods delivered the same Sharpe with much less risk: minimum variance 7.7% volatility and an 18% worst drawdown, against 13.1% and 43% for equal weight.</li>
      <li>In simulations with known parameters, errors in expected returns cost about 0.07 of Sharpe, errors in the covariance about 0.01. Optimizers promised a Sharpe of about 0.8 and delivered about 0.5.</li>
      <li>Learned signal combinations beat equal weights, against the pre-registered expectation, because one signal (industry residual reversal) had the wrong sign. Fixing that sign by hand made equal weights as good as learning.</li>
      <li>Optimization did not create alpha. Where results improved, they came from better inputs or from less risk.</li></ul></div>`;
    if (st.E1_base) {
      const s = st.E1_base.stats, t = st.E1_base.tests || {};
      html += `<div class="card"><div class="card__head"><h3>Horse race: 14 methods, multi-asset universe</h3><span class="note">monthly, 10-year window, 10 bp (2 bp Treasuries) costs</span></div>${tbl(["Method", "Return", "Volatility", "Sharpe", "Max drawdown", "Turnover/yr", "Sharpe vs 1/N (95% CI)", "p (Holm)"],
        Object.keys(s).map((k) => [esc(k), pct(s[k].ann_return), pct(s[k].volatility), s[k].sharpe.toFixed(2), pct(s[k].max_drawdown, 0), s[k].turnover.toFixed(2),
          t[k] ? `${t[k].diff >= 0 ? "+" : "−"}${Math.abs(t[k].diff).toFixed(2)} (${t[k].ci_low.toFixed(2)} to ${t[k].ci_high.toFixed(2)})` : "–", t[k] ? t[k].p_boot_holm.toFixed(2) : "–"]))}
        <div class="card__head"><h4>Growth of $1 after costs (log scale)</h4><div class="legend" id="study-legend"></div></div><div id="study-growth" class="chart chart--tall"></div></div>`;
    }
    if (st.E2) {
      const rows = st.E2.filter((r) => r.T === 120), names = { max_sharpe: "Max Sharpe", mean_variance: "Mean-variance", kelly_full: "Full Kelly", min_variance: "Min variance", erc: "ERC", equal: "1/N" };
      const g = (m, c, f = "true_sr") => { const r = rows.find((x) => x.method === m && x.case === c); return r ? r[f].toFixed(2) : "–"; };
      html += `<div class="card"><h3>Estimation error, simulated with known parameters (10-year histories, 300 draws)</h3>${tbl(["Method", "Promised", "Delivered", "With true means", "With true covariance", "Truth"],
        Object.keys(names).map((m) => [names[m], g(m, "estimated", "estimated_sr"), g(m, "estimated"), g(m, "true_mean"), g(m, "true_cov"), g(m, "truth")]))}</div>`;
    }
    if (st.E4) {
      const lab = { "signal:momentum_12_1": "Momentum alone", "signal:value_bm": "Value alone", "signal:low_beta": "Low beta alone", "signal:residual_reversal": "Residual reversal alone", equal: "Equal weights", ic_weighted: "Dynamic confidence", shrunk: "Shrinkage", mean_var: "Mean-variance on ICs", bma: "Bayesian model averaging", regime: "Regime-dependent", ridge: "Ridge ensemble" };
      const ic = st.E4.ic_summary, tests = st.E4.tests;
      const row = (m) => { const a = ic.find((r) => r.universe === "industries12" && r.method === m), b = ic.find((r) => r.universe === "industries49" && r.method === m), ta = tests.find((r) => r.universe === "industries12" && r.method === m), tb = tests.find((r) => r.universe === "industries49" && r.method === m);
        return [lab[m], a ? a.ic_mean.toFixed(3) : "–", ta ? ta.p_holm.toFixed(3) : "", b ? b.ic_mean.toFixed(3) : "–", tb ? tb.p_holm.toFixed(3) : ""]; };
      html += `<div class="card"><h3>Signal combination: out-of-sample rank IC</h3>${tbl(["Signal or method", "12 industries IC", "p vs equal (Holm)", "49 industries IC", "p vs equal (Holm)"], Object.keys(lab).map(row))}
        <p class="hint">Exploratory follow-up (not pre-registered): equal weights with the reversal signal's sign flipped reached IC 0.059 (12 industries) and 0.035 (49), level with the learned methods.</p></div>`;
    }
    if (st.E5) {
      const cases = [...new Set(st.E5.map((r) => r.case))], methods = ["equal", "ic_weighted", "shrunk", "mean_var", "bma", "regime", "ridge"];
      html += `<div class="card"><h3>Synthetic signal lab: share of the oracle's IC captured</h3>${tbl(["Case"].concat(["Equal", "Dyn. conf.", "Shrinkage", "MV on ICs", "BMA", "Regime", "Ridge"]),
        cases.map((c) => [esc(c)].concat(methods.map((m) => { const r = st.E5.find((x) => x.case === c && x.method === m); return r ? pct(r.share_of_oracle, 0) : "–"; }))))}
        <p class="hint">Learning pays when signals differ in strength or some are junk; with uniformly weak signals equal weights is as good; nothing works well when ICs drift.</p></div>`;
    }
    if (st.E10 && st.E10.var_backtest) {
      const v = st.E10.var_backtest, rows = Object.entries(v).filter(([k]) => k !== "sample").map(([k, x]) => [k, x.kupiec.exceptions, x.kupiec.expected.toFixed(0), x.kupiec.p_value.toFixed(3), x.independence.p_value.toFixed(3)]);
      html += `<div class="card"><h3>VaR model check: 99% one-day VaR on daily data, ${v.sample.first} to ${v.sample.last}</h3>${tbl(["Model", "Exceptions", "Expected", "Kupiec p", "Clustering p"], rows)}<p class="hint">Unconditional models breach in clusters. Filtered historical simulation (exploratory) gets the breach count right (169 vs 156) but breaches still cluster.</p></div>`;
    }
    el.innerHTML = html;
    if (st.E1_base) { const keys = ["1/N", "Min variance", "Max Sharpe sample", "Black-Litterman"], series = keys.map((k) => ({ name: k, values: st.E1_base.growth[k].map(Math.exp) }));
      C.legend($("study-legend"), series, true); C.lines($("study-growth"), { x: st.E1_base.dates, series, log: true, height: 320 }); }
  }

  /* ---------------------------------------------------------------- tabs + events */
  function render() {
    if (S.tab === "construct") construct();
    else { if (!S.last) construct(); if (S.tab === "signals") renderSignals(); else if (S.tab === "risk") renderRisk(); else if (S.tab === "stress") renderStress(); else if (S.tab === "frontier") renderFrontier(); else if (S.tab === "study") renderStudy(); }
  }
  function showTab(tab) {
    S.tab = tab; document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === tab ? "true" : "false"));
    document.querySelectorAll(".panel").forEach((p) => (p.hidden = p.id !== `tab-${tab}`));
    if (tab !== "construct") construct();
    render();
  }
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
  $("universe").addEventListener("change", (e) => { setUniverse(e.target.value); S.last = null; render(); });
  $("method").addEventListener("change", (e) => { S.method = e.target.value; construct(); });
  $("compare").addEventListener("change", (e) => { S.compare = e.target.value; construct(); });
  $("risk-aversion").addEventListener("input", (e) => { S.riskAversion = +e.target.value; construct(); });
  $("mean-source").addEventListener("change", (e) => { S.meanSource = e.target.value; construct(); });
  $("cov-method").addEventListener("change", (e) => { S.covMethod = e.target.value; construct(); });
  $("window").addEventListener("change", (e) => { S.window = +e.target.value; fillBacktestControls(); construct(); });
  ["long-short", "min-w", "max-w", "gross", "max-vol", "beta-neutral"].forEach((id) => $(id).addEventListener("change", construct));
  $("group-caps").addEventListener("change", construct);
  $("asset-table").addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.incl) { if (t.checked) S.excluded.delete(t.dataset.incl); else S.excluded.add(t.dataset.incl); }
    if (t.dataset.mu !== undefined) { S.edits[t.dataset.mu] = S.edits[t.dataset.mu] || {}; S.edits[t.dataset.mu].mu = t.value === "" ? NaN : +t.value / 100; }
    if (t.dataset.vol !== undefined) { S.edits[t.dataset.vol] = S.edits[t.dataset.vol] || {}; S.edits[t.dataset.vol].vol = t.value === "" ? NaN : Math.max(0.005, +t.value / 100); }
    if (active().length < 2) { t.checked = true; S.excluded.delete(t.dataset.incl); }
    construct();
  });
  $("asset-table").addEventListener("click", (e) => { if (e.target.dataset.rm) { S.custom = S.custom.filter((c) => c.name !== e.target.dataset.rm); renderAssetTable(); fillSignalForm(); construct(); } });
  $("add-asset").addEventListener("click", () => {
    const name = $("new-name").value.trim().slice(0, 24); if (!name || assetsAll().some((a) => a.name === name)) { $("new-name").focus(); return; }
    S.custom.push({ name, mu: +$("new-mu").value / 100, vol: Math.max(0.01, +$("new-vol").value / 100), rho: Math.max(-0.9, Math.min(0.9, +$("new-rho").value)) });
    $("new-name").value = ""; renderAssetTable(); fillSignalForm(); construct();
  });
  $("sig-table").addEventListener("change", (e) => { const s = e.target.dataset.sig; if (!s) return; if (e.target.checked) S.enabledSignals.add(s); else S.enabledSignals.delete(s); renderSignals(); });
  $("combo-method").addEventListener("change", (e) => { S.comboMethod = e.target.value; renderSignals(); });
  $("combo-ic").addEventListener("input", (e) => { S.comboIC = +e.target.value; renderSignals(); });
  $("use-signals").addEventListener("click", () => { S.meanSource = "signals"; $("mean-source").value = "signals"; showTab("construct"); });
  $("us-add").addEventListener("click", () => {
    const src = ($("us-source").value.trim() || "my.model").slice(0, 32), inst = $("us-instrument").value, z = Math.max(-3, Math.min(3, +$("us-value").value));
    let sig = S.userSignals.find((s) => s.source === src);
    if (!sig) { sig = { source: src, label: src, family: $("us-family").value, kind: "score", horizon_days: 21, model_version: "user", provenance: "entered in the demo", values: {}, confidence: Math.max(0, Math.min(1, +$("us-conf").value)), track_record: null, ic_history: null, illustrative: false }; S.userSignals.push(sig); }
    sig.values[inst] = z; S.enabledSignals.add(src); renderSignals();
  });
  $("var-level").addEventListener("change", renderRisk);
  $("aum").addEventListener("change", renderRisk);
  $("scenario-apply").addEventListener("click", () => {
    try {
      const obj = JSON.parse($("scenario-json").value);
      if (!obj.name || !["historical", "factor", "asset", "volatility"].includes(obj.kind)) throw new Error("needs a name and a kind (historical, factor, asset or volatility)");
      if (obj.kind === "historical" && !(obj.start && obj.end)) throw new Error("historical scenarios need start and end dates");
      const i = S.scenarios.findIndex((s) => s.name === obj.name), key = i >= 0 ? S.scenarios[i].key : "user_" + S.scenarios.length;
      if (i >= 0) S.scenarios[i] = Object.assign(obj, { key }); else { S.scenarios.push(Object.assign(obj, { key })); S.selectedScenario = S.scenarios.length - 1; }
      $("scenario-msg").textContent = i >= 0 ? "Scenario updated." : "Scenario added."; renderStress();
    } catch (e) { $("scenario-msg").textContent = "Not saved: " + e.message; }
  });
  $("ee-run").addEventListener("click", runEE);
  $("bt-run").addEventListener("click", runBacktest);
  let rt; window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(render, 150); });

  $("engine-note").textContent = "Computed in your browser with a JavaScript port of the Python engine (same solver and methods, checked against Python outputs).";
  setUniverse("multi_asset");
  const TABS = ["construct", "signals", "risk", "stress", "frontier", "backtest", "study"];
  const fromHash = () => { const h = location.hash.replace("#", ""); return TABS.includes(h) ? h : "construct"; };
  window.addEventListener("hashchange", () => showTab(fromHash()));
  showTab(fromHash());
  const params = new URLSearchParams(location.search);
  if (params.get("run") === "backtest") runBacktest();
  if (params.get("run") === "ee") runEE();
  if (params.get("selftest")) selftest();

  /* ?selftest=1 : every method on both universes, every tab, the lab and a backtest; report in #selftest */
  async function selftest() {
    const errs = [], log = [];
    window.addEventListener("error", (e) => errs.push("uncaught: " + e.message));
    const step = async (label, fn) => { try { const r = await fn(); if (r) log.push(`${label}: ${r}`); } catch (e) { errs.push(`${label}: ${e.message}`); } };
    for (const u of ["multi_asset", "sleeves"]) {
      $("universe").value = u; setUniverse(u); S.last = null;
      for (const m of Object.keys(METHOD_INFO)) {
        if (u === "sleeves" && m === "market_cap") continue;
        await step(`${u}/${m}`, () => { S.method = m; construct(); const p = S.last.p; if (!E.ok(p)) throw new Error(p.status + " " + (p.messages || []).join(";"));
          const ex = E.explain(p, S.last.inp.cov, S.last.inp.names); if (Object.keys(ex.sentences).length !== S.last.inp.names.length) throw new Error("missing explanations");
          return `${p.status} w=${E.sum(p.weights).toFixed(3)} vol ${pct(p.volatility)} SR ${Number.isFinite(p.sharpe) ? p.sharpe.toFixed(2) : "-"}`; });
      }
      for (const t of TABS) await step(`${u}/tab:${t}`, () => { showTab(t); return "ok"; });
    }
    $("universe").value = "multi_asset"; setUniverse("multi_asset"); S.method = "max_sharpe";
    await step("long-short + gross 150%", () => { $("long-short").checked = true; $("min-w").value = "-20"; construct(); return `${S.last.p.status} gross ${pct(E.sum(S.last.p.weights.map(Math.abs)), 0)}`; });
    await step("market-neutral max Sharpe", () => { $("beta-neutral").checked = true; construct(); return `${S.last.p.status} net ${pct(E.sum(S.last.p.weights))}`; });
    $("beta-neutral").checked = false; $("long-short").checked = false; $("min-w").value = "0";
    await step("vol cap 6% on mean-variance", () => { S.method = "mean_variance"; $("max-vol").value = "6"; construct(); return `${S.last.p.status} vol ${pct(S.last.p.volatility)}`; });
    $("max-vol").value = "";
    await step("infeasible caps reported", () => { $("max-w").value = "5"; construct(); const bad = !E.ok(S.last.p); $("max-w").value = "25"; construct(); if (!bad) throw new Error("not flagged"); return "flagged"; });
    await step("custom asset", () => { $("new-name").value = "Gold"; $("add-asset").click(); return `${S.last.inp.names.length} assets, ${S.last.p.status}`; });
    await step("signals as expected returns", () => { $("use-signals").click(); S.method = "black_litterman"; construct(); return `${S.last.p.status} via ${S.meanSource}`; });
    await step("estimation-error lab", async () => { showTab("frontier"); $("ee-n").value = "50"; await runEE(); return $("ee-note").textContent.slice(0, 120); });
    await step("backtest", async () => { showTab("backtest"); $("bt-every").value = "3"; await runBacktest(); return $("bt-table").textContent.slice(0, 160); });
    for (const sc of S.scenarios) await step(`scenario ${sc.key}`, () => { const r = E.runScenario(S.last.p.weights, sc, stressContext(S.last.inp)); if (!Number.isFinite(r.pnl)) throw new Error("no P&L"); return spct(r.pnl, 1); });
    const pre = document.createElement("pre"); pre.id = "selftest"; pre.textContent = JSON.stringify({ errors: errs, log }); document.body.appendChild(pre);
  }
})();
