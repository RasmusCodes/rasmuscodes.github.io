// Alpha Combination Lab - interactive demo. Mounts into every element with [data-acl-lab].
import { barChart, columns, dotInterval, heatmap, lineChart, seriesColor } from "./charts.js?v=20261124a";
import { cholesky, correlationFromFamilies, dot, eigSym, METHODS, nearestCorrelation, ORDER, solve } from "./engine.js?v=20261124a";

const HERE = new URL(".", import.meta.url);
const FAMILIES = ["momentum", "value", "quality", "reversal", "investment", "lowrisk", "seasonality", "other"];
const MAX_SIGNALS = 8;
const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : "n/a");
const f3 = (v) => (Number.isFinite(v) ? v.toFixed(3) : "n/a");
const f4 = (v) => (Number.isFinite(v) ? v.toFixed(4) : "n/a");
const pct = (v, d = 1) => (Number.isFinite(v) ? `${(100 * v).toFixed(d)}%` : "n/a");

// Summary sentence for one window of the signal-extension test (D.extension in real_results.json).
function extText(x) {
  const sg = (v, f) => (v > 0 ? "+" : "") + f(v);
  const ew = x.rows.find((r) => r.method === "EW" && r.set !== "16 signals");
  const top = x.rows.find((r) => r.method === x.top_sharpe.method);
  const hedge = top && ew && x.top_sharpe.diff > 0 && top.sharpe_hedged < ew.sharpe_hedged
    ? ` Hedged against the market, ${top.method} trails equal weighting (${f2(top.sharpe_hedged)} vs ${f2(ew.sharpe_hedged)}).` : "";
  return `${x.label.charAt(0).toUpperCase()}${x.label.slice(1)} (${x.months} months). Equal weighting with the new signals gains ` +
    `${f4(x.h10.ic_diff)} rank IC (Holm p ${f3(x.h10.p_ic_holm)}) and ${f2(x.h10.sharpe_diff)} net Sharpe (p ${f3(x.h10.p_sharpe)}). ` +
    `Best complex method against it: ${x.top_sharpe.method} ${sg(x.top_sharpe.diff, f2)} net Sharpe (Holm p ${f3(x.top_sharpe.p_holm)}), ` +
    `${x.top_ic.method} ${sg(x.top_ic.diff, f4)} rank IC (Holm p ${f3(x.top_ic.p_holm)}).${hedge} ` +
    `Pre-registered rule met: ${x.rule_met ? "yes" : "no"}.`;
}

// ------------------------------------------------------------------ tiny DOM helpers
function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "style") Object.assign(e.style, v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) e.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid);
  return e;
}
function slider({ label, min, max, step, value, fmt = (v) => v, oninput }) {
  const out = h("output", { text: fmt(value) });
  const inp = h("input", { type: "range", min, max, step, value, "aria-label": label });
  inp.addEventListener("input", () => { out.textContent = fmt(Number(inp.value)); oninput(Number(inp.value)); });
  return h("div", { class: "acl-ctl" }, h("label", { text: label }), out, inp);
}
function stat(label, value, note) { return h("div", { class: "acl-stat" }, h("span", { text: label }), h("b", { text: value }), note ? h("small", { text: note }) : null); }

// ------------------------------------------------------------------ presets for the lab
const PRESETS = {
  realistic: {
    label: "Realistic (S&P 500-like ICs)",
    signals: [["Momentum 12-1", "momentum", 0.02, 0.92], ["52-week high", "momentum", 0.015, 0.9], ["Book-to-market", "value", 0.015, 0.97],
              ["Earnings yield", "value", 0.015, 0.95], ["Gross profitability", "quality", 0.015, 0.98], ["Accruals", "quality", 0.01, 0.9],
              ["1-month reversal", "reversal", 0.025, 0.0], ["Low volatility", "lowrisk", 0.01, 0.95]],
    world: { rhoWithin: 0.55, rhoBetween: 0.05 },
  },
  strong: {
    label: "Strong signals",
    signals: [["Signal A", "momentum", 0.05, 0.8], ["Signal B", "momentum", 0.03, 0.8], ["Signal C", "value", 0.05, 0.9],
              ["Signal D", "value", 0.02, 0.9], ["Signal E", "quality", 0.04, 0.9], ["Signal F", "reversal", 0.0, 0.2]],
    world: { rhoWithin: 0.6, rhoBetween: 0.1 },
  },
  redundant: {
    label: "Six near-copies + two originals",
    signals: [["Value 1", "value", 0.03, 0.9], ["Value 2", "value", 0.03, 0.9], ["Value 3", "value", 0.03, 0.9], ["Value 4", "value", 0.03, 0.9],
              ["Value 5", "value", 0.03, 0.9], ["Value 6", "value", 0.03, 0.9], ["Momentum", "momentum", 0.03, 0.9], ["Quality", "quality", 0.03, 0.9]],
    world: { rhoWithin: 0.9, rhoBetween: 0.0 },
  },
  nonlinear: {
    label: "Non-linear world",
    signals: [["Signal A", "momentum", 0.04, 0.8], ["Signal B", "value", 0.04, 0.8], ["Signal C", "quality", 0.03, 0.8], ["Signal D", "lowrisk", 0.02, 0.8]],
    world: { rhoWithin: 0.5, rhoBetween: 0.1, nonlinear: 0.6 },
  },
  regime: {
    label: "Momentum crashes in a hidden-but-observable regime",
    signals: [["Momentum", "momentum", 0.04, 0.85], ["Industry momentum", "momentum", 0.03, 0.85], ["Value", "value", 0.03, 0.95], ["Quality", "quality", 0.03, 0.95]],
    world: { rhoWithin: 0.6, rhoBetween: 0.0, regime: true },
  },
  decay: {
    label: "Half the signals stop working (publication)",
    signals: [["Old anomaly 1", "value", 0.04, 0.9, true], ["Old anomaly 2", "value", 0.04, 0.9, true], ["Durable 1", "quality", 0.03, 0.9], ["Durable 2", "momentum", 0.03, 0.9]],
    world: { rhoWithin: 0.5, rhoBetween: 0.1, decay: true },
  },
};

const COMPLEXITY = {          // manual mode: grid position 0..1 -> configuration
  RIDGE: "lam", LASSO: "frac", ENET: "frac", PCR: "k", RF: "depth", GBM: "depth", REGIME: "kappa", ONLINE_EG: "eta", ONLINE_RLS: "forget",
};

function newState(preset = "realistic") {
  const P = PRESETS[preset];
  return {
    preset,
    signals: P.signals.map(([name, family, ic, persistence, decays]) => ({ name, family, ic, persistence, decays: !!decays })),
    rhoWithin: P.world.rhoWithin, rhoBetween: P.world.rhoBetween, overrides: {},
    N: 200, years: 30, trainYears: 10, nonlinear: P.world.nonlinear ?? 0, regime: !!P.world.regime, decay: !!P.world.decay,
    factorShare: 0.3, costBp: 10, seed: 7,
    methods: new Set(["EW", "HEW", "OLS", "RIDGE", "LASSO", "BMA", "BSHRINK", "GBM", "DMA", "REGIME", "ONLINE_EG"]),
    autoTune: true, complexity: Object.fromEntries(Object.keys(COMPLEXITY).map((m) => [m, 0.5])),
    selected: "RIDGE",
  };
}

// ======================================================================================== mount
export function mount(root) {
  if (root.dataset.aclMounted) return;
  root.dataset.aclMounted = "1";
  root.classList.add("acl");
  if (root.dataset.wide !== undefined) root.classList.add("acl--wide");
  const tabs = [["learn", "Ten signals, one bet"], ["lab", "Combination lab"], ["real", "S&P 500 results, 1980-2024"]];
  const panels = {};
  const bar = h("div", { class: "acl-tabs", role: "tablist" });
  const shell = h("div", { class: "acl-shell" }, bar);
  for (const [id, label] of tabs) {
    const p = h("section", { class: "acl-panel", role: "tabpanel", hidden: id !== "learn" });
    panels[id] = p;
    const b = h("button", { class: "acl-tab", role: "tab", "aria-selected": id === "learn" ? "true" : "false", text: label, type: "button",
                            onclick: () => {
                              for (const x of bar.children) x.setAttribute("aria-selected", x === b ? "true" : "false");
                              for (const [k, panel] of Object.entries(panels)) panel.hidden = k !== id;
                              if (id === "real" && !panels.real.dataset.loaded) loadReal(panels.real);
                              if (id === "lab" && !panels.lab.dataset.built) buildLab(panels.lab);
                            } });
    bar.appendChild(b);
    shell.appendChild(p);
  }
  root.replaceChildren(shell);
  buildLearn(panels.learn);
}

// ======================================================================================== tab 1: education
function buildLearn(panel) {
  const st = { K: 10, rho: 0.7, c: 0.03, ic1: 0.04, ic2: 0.025, rho12: 0.5, T: 240, N: 500 };
  const tiles = h("div", { class: "acl-stats" });
  const curve = h("div"), eig = h("div"), opt = h("div"), oos = h("div"), tiles2 = h("div", { class: "acl-stats" });
  const draw = () => {
    const { K, rho, c } = st;
    const neff = K / (1 + (K - 1) * rho), comb = c * Math.sqrt(neff);
    tiles.replaceChildren(
      stat("Effective independent signals", neff.toFixed(2), `out of ${K}`),
      stat("Combined IC", comb.toFixed(3), `${Math.sqrt(neff).toFixed(2)}x one signal`),
      stat("If they were independent", (c * Math.sqrt(K)).toFixed(3), `${Math.sqrt(K).toFixed(2)}x one signal`),
      stat("Ceiling as K grows", rho > 0 ? (c / Math.sqrt(rho)).toFixed(3) : "none", rho > 0 ? "IC / sqrt(correlation)" : "grows with sqrt(K)"));
    const ks = Array.from({ length: 20 }, (_, i) => i + 1);
    const line = (r) => ks.map((k) => c * Math.sqrt(k / (1 + (k - 1) * r)));
    lineChart(curve, { x: ks, xLabel: (k) => `${k}`, yFormat: f3, height: 240, series: [
      { name: "independent", values: line(0), color: seriesColor(0) },
      { name: `correlation ${rho.toFixed(2)}`, values: line(rho), color: seriesColor(1) },
    ] });
    const lam = [1 + (K - 1) * rho, ...Array(K - 1).fill(1 - rho)];
    barChart(eig, { labels: lam.map((_, i) => `PC ${i + 1}`), values: lam, format: f2, valueLabel: "variance" });
    // two-signal card
    const ic = [st.ic1, st.ic2], C = [[1, st.rho12], [st.rho12, 1]];
    let w = solve(C.map((r) => Float64Array.from(r)), Float64Array.from(ic));
    const r2 = dot(ic, w);
    const wn = Array.from(w, (v) => v / (Math.abs(w[0]) + Math.abs(w[1])));
    barChart(opt, { labels: ["Signal 1", "Signal 2"], values: wn, compare: [0.5, 0.5], compareLabel: "equal weights", valueLabel: "optimal weights", format: f2 });
    const icEW = (ic[0] + ic[1]) / Math.sqrt(2 + 2 * st.rho12), icOpt = Math.sqrt(Math.max(r2, 0));
    const Ts = Array.from({ length: 50 }, (_, i) => 12 * (i + 1));
    const icOLS = (T) => { const ne = T * st.N / 3; return r2 / Math.sqrt(r2 + 2 * (1 - r2) / ne); };
    lineChart(oos, { x: Ts, xLabel: (t) => `${t / 12}y`, yFormat: f3, height: 230, series: [
      { name: "true weights (unknowable)", values: Ts.map(() => icOpt), color: seriesColor(2) },
      { name: "equal weights", values: Ts.map(() => icEW), color: seriesColor(0) },
      { name: "estimated weights (regression)", values: Ts.map(icOLS), color: seriesColor(1) },
    ] });
    const be = Ts.find((T) => icOLS(T) > icEW);
    tiles2.replaceChildren(
      stat("Optimal weight on signal 2", wn[1].toFixed(2), wn[1] < 0 ? "negative: hedges signal 1" : "positive"),
      stat("Best possible IC", icOpt.toFixed(4), `equal weights ${icEW.toFixed(4)}`),
      stat("History needed to beat equal weights", be ? `${(be / 12).toFixed(0)} years` : "> 50 years", `${st.N} stocks, design effect 3`));
  };
  panel.append(
    h("div", { class: "acl-callout", text: "Ten signals that are 70% correlated are not ten sources of alpha. If every signal has the same information coefficient (IC) c and every pair has correlation rho, the best possible combination has IC c x sqrt(K / (1 + (K - 1) rho)). The correlated part of the signals counts once." }),
    h("div", { class: "acl-side" },
      h("div", { class: "acl-card" },
        h("h4", { text: "Your signals" }),
        slider({ label: "Number of signals K", min: 1, max: 20, step: 1, value: st.K, oninput: (v) => { st.K = v; draw(); } }),
        slider({ label: "Correlation between any two", min: 0, max: 0.95, step: 0.05, value: st.rho, fmt: f2, oninput: (v) => { st.rho = v; draw(); } }),
        slider({ label: "IC of each signal", min: 0.005, max: 0.1, step: 0.005, value: st.c, fmt: f3, oninput: (v) => { st.c = v; draw(); } }),
        h("p", { class: "acl-note", text: "IC: the month-by-month cross-sectional correlation between a signal and next month's returns. 0.02-0.05 is typical for published equity signals." })),
      h("div", {}, tiles,
        h("div", { class: "acl-grid2" },
          h("div", { class: "acl-card" }, h("h4", { text: "Combined IC as signals are added" }), curve),
          h("div", { class: "acl-card" }, h("h4", { text: "Variance carried by each principal component" }), eig,
            h("p", { class: "acl-note", text: "Correlated signals load on one dominant component: most of what they say, they say together." }))))),
    h("h3", { text: "Two signals: correlation moves the optimal weights, and estimation noise eats the gain", style: { marginTop: "22px" } }),
    h("div", { class: "acl-side" },
      h("div", { class: "acl-card" },
        slider({ label: "IC of signal 1", min: 0, max: 0.08, step: 0.005, value: st.ic1, fmt: f3, oninput: (v) => { st.ic1 = v; draw(); } }),
        slider({ label: "IC of signal 2", min: 0, max: 0.08, step: 0.005, value: st.ic2, fmt: f3, oninput: (v) => { st.ic2 = v; draw(); } }),
        slider({ label: "Correlation between them", min: -0.5, max: 0.95, step: 0.05, value: st.rho12, fmt: f2, oninput: (v) => { st.rho12 = v; draw(); } }),
        slider({ label: "Stocks in the cross-section", min: 50, max: 2000, step: 50, value: st.N, oninput: (v) => { st.N = v; draw(); } }),
        h("p", { class: "acl-note", text: "Optimal weights are C^-1 x IC. When the correlation exceeds IC2 / IC1 the weaker signal gets a negative weight: it is used to hedge the stronger one. A regression must estimate that from noisy data; its expected out-of-sample IC is R^2 / sqrt(R^2 + K(1 - R^2) / n_eff), with n_eff = months x stocks / 3 (the design effect measured on the S&P 500 data)." })),
      h("div", {}, tiles2, h("div", { class: "acl-grid2" },
        h("div", { class: "acl-card" }, h("h4", { text: "Optimal vs equal weights (normalized)" }), opt),
        h("div", { class: "acl-card" }, h("h4", { text: "Expected out-of-sample IC vs years of history" }), oos)))));
  draw();
}

// ======================================================================================== tab 2: lab
function buildLab(panel) {
  panel.dataset.built = "1";
  let S = newState("realistic");
  let worker = null, last = null;
  const side = h("div", { class: "acl-card" });
  const main = h("div", {});
  panel.append(h("div", { class: "acl-callout", text: "Build a world where you know the truth, then see which combination methods find it out of sample. Every run is a full walk-forward: annual refits, hyperparameters chosen by nested validation inside each training window, monthly long-short portfolios after costs. Results vary with the seed: that is the point." }),
               h("div", { class: "acl-side" }, side, main));
  const corrHost = h("div"), sigHost = h("div"), methHost = h("div"), cxHost = h("div");
  const prog = h("div", { class: "acl-progress" }, h("i")), status = h("p", { class: "acl-note", text: "" });
  const runBtn = h("button", { class: "acl-btn acl-btn--primary", type: "button", text: "Run walk-forward", onclick: () => run() });

  function corrMatrix() {
    let C = correlationFromFamilies(S.signals, S.rhoWithin, S.rhoBetween, S.overrides);
    const ok = !!cholesky(C);
    if (!ok) C = nearestCorrelation(C);
    return { C, ok };
  }
  function renderSignals() {
    const body = h("tbody");
    S.signals.forEach((s, i) => {
      const fam = h("select", { "aria-label": "family", onchange: (e) => { s.family = e.target.value; renderCorr(); } },
        FAMILIES.map((f) => h("option", { value: f, selected: f === s.family, text: f })));
      body.appendChild(h("tr", {},
        h("td", {}, h("input", { type: "text", value: s.name, "aria-label": "signal name", oninput: (e) => { s.name = e.target.value || `Signal ${i + 1}`; renderCorr(); } })),
        h("td", {}, fam),
        h("td", {}, h("input", { type: "number", step: "0.005", min: "-0.1", max: "0.15", value: s.ic, "aria-label": "IC", onchange: (e) => { s.ic = Number(e.target.value) || 0; } })),
        h("td", {}, h("input", { type: "number", step: "0.05", min: "0", max: "0.99", value: s.persistence, "aria-label": "persistence", onchange: (e) => { s.persistence = Math.min(0.99, Math.max(0, Number(e.target.value) || 0)); } })),
        S.decay ? h("td", {}, h("input", { type: "checkbox", checked: s.decays, "aria-label": "stops working halfway", onchange: (e) => { s.decays = e.target.checked; } })) : null,
        h("td", {}, h("button", { class: "acl-x", type: "button", title: "Remove signal", "aria-label": `Remove ${s.name}`, text: "x",
                                  onclick: () => { if (S.signals.length > 2) { S.signals.splice(i, 1); S.overrides = {}; renderSignals(); renderCorr(); } } }))));
    });
    sigHost.replaceChildren(
      h("div", { class: "acl-tablewrap" }, h("table", { class: "acl-sigs" },
        h("thead", {}, h("tr", {}, ["Signal", "Family", "IC", "Persistence", S.decay ? "Decays" : null, ""].filter((x) => x !== null).map((t) => h("th", { text: t })))), body)),
      h("div", { class: "acl-row", style: { marginTop: "8px" } },
        h("button", { class: "acl-btn", type: "button", text: "+ Add signal", disabled: S.signals.length >= MAX_SIGNALS,
                      onclick: () => { S.signals.push({ name: `Signal ${S.signals.length + 1}`, family: "other", ic: 0.02, persistence: 0.8, decays: false }); S.overrides = {}; renderSignals(); renderCorr(); } }),
        h("span", { class: "acl-note", text: `${S.signals.length} of ${MAX_SIGNALS}. IC = standalone correlation with next month's return.` })));
  }
  function renderCorr() {
    const { C, ok } = corrMatrix();
    const labels = S.signals.map((s) => s.name.length > 12 ? s.name.slice(0, 11) + "." : s.name);
    corrHost.replaceChildren();
    const hm = h("div");
    corrHost.append(...[
      slider({ label: "Correlation within a family", min: 0, max: 0.95, step: 0.05, value: S.rhoWithin, fmt: f2, oninput: (v) => { S.rhoWithin = v; renderCorrOnly(); } }),
      slider({ label: "Correlation across families", min: -0.3, max: 0.8, step: 0.05, value: S.rhoBetween, fmt: f2, oninput: (v) => { S.rhoBetween = v; renderCorrOnly(); } }),
      hm,
      h("p", { class: "acl-note", text: ok ? "Click a cell to set one pair's correlation." : "These correlations are impossible together; the nearest valid matrix is used." }),
      Object.keys(S.overrides).length ? h("button", { class: "acl-btn", type: "button", text: "Clear pair edits", onclick: () => { S.overrides = {}; renderCorr(); } }) : null,
    ].filter(Boolean));
    const drawHm = () => {
      const { C: C2 } = corrMatrix();
      heatmap(hm, { matrix: C2, labels, onCell: (i, j, v) => {
        const ans = window.prompt(`Correlation between ${S.signals[i].name} and ${S.signals[j].name} (-0.9 to 0.99)`, v.toFixed(2));
        if (ans === null) return;
        const x = Math.max(-0.9, Math.min(0.99, Number(ans)));
        if (Number.isFinite(x)) { S.overrides[i < j ? `${i},${j}` : `${j},${i}`] = x; renderCorr(); }
      }, highlight: (i, j) => (i < j ? `${i},${j}` : `${j},${i}`) in S.overrides });
    };
    function renderCorrOnly() { drawHm(); }
    drawHm();
    void C;
  }
  function renderMethods() {
    methHost.replaceChildren(h("div", { class: "acl-chips" }, ORDER.map((m) => h("label", { class: "acl-chip", title: METHODS[m].label },
      h("input", { type: "checkbox", checked: S.methods.has(m) || m === "EW", disabled: m === "EW",
                   onchange: (e) => { if (e.target.checked) S.methods.add(m); else S.methods.delete(m); renderComplexity(); } }), m))));
    renderComplexity();
  }
  function renderComplexity() {
    const items = Object.keys(COMPLEXITY).filter((m) => S.methods.has(m));
    cxHost.replaceChildren(
      h("label", { class: "acl-chip", style: { marginBottom: "8px" } },
        h("input", { type: "checkbox", checked: S.autoTune, onchange: (e) => { S.autoTune = e.target.checked; renderComplexity(); } }),
        "Choose complexity by nested validation (as in the study)"),
      S.autoTune ? h("p", { class: "acl-note", text: "Each tunable method picks its own complexity every five years from validation blocks inside its training window." }) :
        h("div", {}, items.map((m) => {
          const grid = METHODS[m].grid, idx = Math.round(S.complexity[m] * (grid.length - 1));
          const desc = (i) => Object.entries(grid[i]).map(([k, v]) => `${k} ${v}`).join(", ");
          return slider({ label: `${m}: simple to complex`, min: 0, max: 1, step: 1 / Math.max(grid.length - 1, 1), value: S.complexity[m],
                          fmt: (v) => desc(Math.round(v * (grid.length - 1))), oninput: (v) => { S.complexity[m] = v; } });
        })));
  }
  function renderSide() {
    const presetSel = h("select", { class: "acl-select", "aria-label": "preset", onchange: (e) => { S = newState(e.target.value); renderSide(); } },
      Object.entries(PRESETS).map(([k, p]) => h("option", { value: k, selected: k === S.preset, text: p.label })));
    side.replaceChildren(
      h("h4", { text: "1. Start from" }), presetSel,
      h("h4", { text: "2. Signals", style: { marginTop: "16px" } }), sigHost,
      h("h4", { text: "3. Correlations", style: { marginTop: "16px" } }), corrHost,
      h("h4", { text: "4. World", style: { marginTop: "16px" } }),
      slider({ label: "Stocks", min: 100, max: 400, step: 50, value: S.N, oninput: (v) => { S.N = v; } }),
      slider({ label: "Years of data", min: 15, max: 40, step: 1, value: S.years, oninput: (v) => { S.years = v; } }),
      slider({ label: "Years before the first forecast", min: 5, max: 20, step: 1, value: S.trainYears, oninput: (v) => { S.trainYears = v; } }),
      slider({ label: "Non-linear share of the true signal", min: 0, max: 0.8, step: 0.1, value: S.nonlinear, fmt: (v) => pct(v, 0), oninput: (v) => { S.nonlinear = v; } }),
      slider({ label: "Common-shock share of returns", min: 0, max: 0.6, step: 0.1, value: S.factorShare, fmt: (v) => pct(v, 0), oninput: (v) => { S.factorShare = v; } }),
      slider({ label: "Trading cost, one way (bp)", min: 0, max: 50, step: 1, value: S.costBp, oninput: (v) => { S.costBp = v; } }),
      h("div", { class: "acl-row" },
        h("label", { class: "acl-chip" }, h("input", { type: "checkbox", checked: S.regime, onchange: (e) => { S.regime = e.target.checked; } }), "Regime switches"),
        h("label", { class: "acl-chip" }, h("input", { type: "checkbox", checked: S.decay, onchange: (e) => { S.decay = e.target.checked; renderSignals(); } }), "Alpha decay"),
        h("label", { class: "acl-chip" }, "Seed ", h("input", { type: "number", value: S.seed, min: 1, max: 9999, style: { width: "64px" }, onchange: (e) => { S.seed = Number(e.target.value) || 1; } }))),
      h("h4", { text: "5. Methods", style: { marginTop: "16px" } }), methHost,
      h("h4", { text: "6. Complexity", style: { marginTop: "16px" } }), cxHost,
      h("div", { style: { marginTop: "14px" } }, runBtn, prog, status));
    renderSignals(); renderCorr(); renderMethods();
  }

  function manualParams() {
    const out = {};
    for (const m of Object.keys(COMPLEXITY)) { const g = METHODS[m].grid; out[m] = g[Math.round(S.complexity[m] * (g.length - 1))]; }
    return out;
  }

  function run() {
    if (worker) worker.terminate();
    const { C } = corrMatrix();
    const world = { N: S.N, T: S.years * 12, signals: S.signals.map((s) => ({ ...s })), corr: C.map((r) => Array.from(r)),
                    nonlinear: S.nonlinear, regime: S.regime, decay: S.decay, factorShare: S.factorShare, seed: S.seed };
    const opt = { start: S.trainYears * 12, refit: 12, tuneEvery: 60, autoTune: S.autoTune, manual: manualParams(), costBp: S.costBp, trees: 40, maxRows: 12000 };
    const methods = ORDER.filter((m) => S.methods.has(m));
    runBtn.disabled = true;
    status.textContent = "Simulating...";
    prog.firstChild.style.width = "0%";
    main.style.opacity = last ? "0.55" : "1";
    worker = new Worker(new URL("./worker.js?v=20261124a", import.meta.url), { type: "module" });
    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === "progress") { prog.firstChild.style.width = `${Math.round(100 * msg.value)}%`; status.textContent = `Running ${msg.name}...`; }
      else if (msg.type === "done") {
        runBtn.disabled = false; main.style.opacity = "1"; worker.terminate(); worker = null;
        status.textContent = `Done in ${msg.seconds.toFixed(1)} s: ${msg.months.length} out-of-sample months.`;
        last = msg; renderResults(msg);
      } else if (msg.type === "error") {
        runBtn.disabled = false; main.style.opacity = "1"; status.textContent = "Something went wrong: " + msg.message.split("\n")[0];
      }
    };
    worker.postMessage({ world, methods, opt });
  }

  function renderResults(R) {
    const names = R.names, methods = Object.keys(R.runs);
    if (!R.runs[S.selected]) S.selected = methods.find((m) => m !== "EW") ?? "EW";
    const best = methods.reduce((a, m) => (R.summary[m].sharpeNet > R.summary[a].sharpeNet ? m : a), methods[0]);
    const beat = methods.filter((m) => m !== "EW" && R.summary[m].sharpeDiffCI && R.summary[m].sharpeDiffCI[0] > 0).length;
    const worse = methods.filter((m) => m !== "EW" && R.summary[m].sharpeDiffCI && R.summary[m].sharpeDiffCI[1] < 0).length;
    const tiles = h("div", { class: "acl-stats" },
      stat("Oracle IC (the truth)", f3(R.truth.icOracle), `net Sharpe ${f2(R.summary.ORACLE.sharpeNet)}`),
      stat("Equal weights", `Sharpe ${f2(R.summary.EW.sharpeNet)}`, `rank IC ${f3(R.summary.EW.rankIC)}, net of costs`),
      stat("Best this run", best, `net Sharpe ${f2(R.summary[best].sharpeNet)}`),
      stat("Clearly better than EW", `${beat} of ${methods.length - 1}`, `${worse} clearly worse (95% interval excludes 0)`));
    // table
    const rows = methods.map((m) => {
      const s = R.summary[m], d = s.sharpeDiffCI;
      return h("tr", { class: (m === "EW" ? "is-bench " : "") + (m === S.selected ? "is-sel" : ""), onclick: () => { S.selected = m; renderResults(R); } },
        h("td", { text: m, title: METHODS[m].label }),
        h("td", { text: f3(s.rankIC) }),
        h("td", { text: m === "EW" ? "" : f2(s.icDiffT) }),
        h("td", { text: f2(s.sharpeGross) }),
        h("td", { text: f2(s.sharpeNet) }),
        h("td", { class: d ? (d[0] > 0 ? "pos" : d[1] < 0 ? "neg" : "") : "", text: m === "EW" ? "benchmark" : `${f2(s.sharpeDiff)} [${f2(d[0])}, ${f2(d[1])}]` }),
        h("td", { text: f2(s.turnover) }));
    });
    const table = h("div", { class: "acl-tablewrap" }, h("table", { class: "acl-table" },
      h("thead", {}, h("tr", {}, ["Method", "Rank IC", "IC t vs EW", "Sharpe gross", "Sharpe net", "Net Sharpe minus EW [95%]", "Turnover / yr"].map((t) => h("th", { text: t })))),
      h("tbody", {}, rows)));
    const dots = h("div"), cum = h("div"), wts = h("div"), paths = h("div"), contrib = h("div"), dec = h("div");
    const sel = S.selected, run = R.runs[sel];
    const lastW = [...run.weights].reverse().find((w) => w);
    const truth = R.truth.trueW[R.truth.trueW.length - 1];
    const norm = (w) => { const s = w.reduce((a, v) => a + Math.abs(v), 0) || 1; return w.map((v) => v / s); };
    const whichC = { v: "top" };
    const contribSel = h("select", { class: "acl-select", "aria-label": "stock", onchange: (e) => { whichC.v = e.target.value; drawContrib(); } },
      [["top", "highest-ranked stock"], ["middle", "middle stock"], ["bottom", "lowest-ranked stock"]].map(([v, t]) => h("option", { value: v, text: t })));
    main.replaceChildren(tiles, h("div", { class: "acl-card" }, h("h4", { text: "Out of sample, after costs (click a row for details)" }), table,
      h("p", { class: "acl-note", text: "Interval: stationary block bootstrap of the paired monthly returns. Rank IC: Spearman correlation of the forecast with next month's return, averaged over months." })),
      h("div", { class: "acl-grid2", style: { marginTop: "14px" } },
        h("div", { class: "acl-card" }, h("h4", { text: "Net Sharpe minus equal weights" }), dots),
        h("div", { class: "acl-card" }, h("h4", { text: "Growth of $1 after costs" }), cum)),
      h("div", { class: "acl-grid2", style: { marginTop: "14px" } },
        h("div", { class: "acl-card" }, h("h4", { text: `${sel}: estimated vs true weights (last month)` }), wts),
        h("div", { class: "acl-card" }, h("h4", { text: `${sel}: weights over time` }), paths)),
      h("div", { class: "acl-grid2", style: { marginTop: "14px" } },
        h("div", { class: "acl-card" }, h("div", { class: "acl-row" }, h("h4", { text: `${sel}: why one stock ranks where it does`, style: { margin: 0 } }), contribSel), contrib),
        h("div", { class: "acl-card" }, h("h4", { text: `${sel}: next-month return by forecast decile` }), dec)));
    const rowsD = methods.filter((m) => m !== "EW").map((m) => ({ label: m, value: R.summary[m].sharpeDiff, lo: R.summary[m].sharpeDiffCI[0], hi: R.summary[m].sharpeDiffCI[1], emphasis: m === sel }));
    dotInterval(dots, { rows: rowsD, ref: 0, refLabel: "EW", format: f2, xTitle: "difference in annualized net Sharpe" });
    const cumv = (arr) => { let w = 1; return arr.map((r) => (w *= 1 + r)); };
    const xm = R.months.map((t) => t + 1);
    const series = [{ name: "EW", values: cumv(R.runs.EW.ev.net), color: seriesColor(0) },
                    { name: "Oracle", values: cumv(R.oracle.net), color: seriesColor(2) }];
    if (sel !== "EW") series.push({ name: sel, values: cumv(run.ev.net), color: seriesColor(1) });
    if (best !== sel && best !== "EW") series.push({ name: best, values: cumv(R.runs[best].ev.net), color: seriesColor(3) });
    lineChart(cum, { x: xm, xLabel: (t) => `y${Math.floor(t / 12)}`, yFormat: (v) => `${v.toFixed(2)}x`, height: 250, log: true, series });
    if (lastW) {
      barChart(wts, { labels: names, values: norm(Array.from(lastW)), compare: norm(truth), compareLabel: "true weights", valueLabel: `${sel} estimate`, format: f2 });
      const W = run.weights.filter(Boolean);
      lineChart(paths, { x: xm.slice(0, W.length), xLabel: (t) => `y${Math.floor(t / 12)}`, yFormat: f2, height: 230, zero: true,
                         series: names.map((n, k) => ({ name: n, values: W.map((w) => norm(Array.from(w))[k]), color: seriesColor(k) })) });
    } else {
      wts.replaceChildren(h("p", { class: "acl-note", text: `${sel} is not linear: it has no single weight per signal. The contribution panel shows how it treats each signal for one stock.` }));
      paths.replaceChildren(h("p", { class: "acl-note", text: "No weight path for a non-linear model." }));
    }
    function drawContrib() {
      const c = run.contributions?.[whichC.v];
      if (!c) { contrib.replaceChildren(h("p", { class: "acl-note", text: "No contributions available." })); return; }
      barChart(contrib, { labels: names, values: c.contrib, format: f3, valueLabel: "contribution to the score" });
    }
    drawContrib();
    columns(dec, { labels: Array.from({ length: 10 }, (_, i) => String(i + 1)), values: run.deciles.map((v) => 100 * v), format: (v) => `${v.toFixed(2)}%`, valueLabel: "mean excess return next month" });
  }

  main.replaceChildren(h("div", { class: "acl-card" }, h("h4", { text: "Ready" }),
    h("p", { text: "Pick a preset or edit the signals, then press Run. A run with the default settings takes about 10-30 seconds in the browser (tree models are the slowest)." })));
  renderSide();
}

// ======================================================================================== tab 3: real data
async function loadReal(panel) {
  panel.dataset.loaded = "1";
  panel.replaceChildren(h("p", { class: "acl-note", text: "Loading results..." }));
  let D;
  try { D = await (await fetch(new URL("./data/real_results.json?v=20261124a", HERE))).json(); }
  catch (e) { panel.replaceChildren(h("p", { text: "Could not load the results file." })); return; }
  const order = D.order, M = D.methods, months = D.months;
  const ew = M.EW.stats;
  const best = order.reduce((a, m) => (M[m].stats.sharpe_net > M[a].stats.sharpe_net ? m : a), order[0]);
  const sig = order.filter((m) => m !== "EW" && M[m].vs_ew && M[m].vs_ew.p_sharpe_holm < 0.05);
  const tiles = h("div", { class: "acl-stats" },
    stat("Equal weights, net Sharpe", f2(ew.sharpe_net), `rank IC ${f3(ew.rank_ic)}`),
    stat("Best method, net Sharpe", f2(M[best].stats.sharpe_net), best),
    stat("Methods beating EW (Holm 5%)", `${sig.filter((m) => M[m].vs_ew.sharpe_diff > 0).length} of ${order.length - 1}`, "net Sharpe, two-sided"),
    stat("SPA p, best complex vs EW", D.spa_complex ? `${f3(D.spa_complex.net_return.p_consistent)} | ${f3(D.spa_complex.rank_ic.p_consistent)}` : "n/a",
         `net return (${D.spa_complex?.net_return.best}) | rank IC (${D.spa_complex?.rank_ic.best})${D.pbo !== null ? `; PBO ${f2(D.pbo)}` : ""}`));
  const pick = new Set(["EW", "RIDGE", "GBM"]);
  let selected = "RIDGE";
  const tbl = h("div", { class: "acl-tablewrap" }), cum = h("div"), roll = h("div"), fam = h("div"), heat = h("div"), sigs = h("div");
  const chips = h("div", { class: "acl-chips" });
  const H = D.hedged || {};
  const drawTable = () => {
    tbl.replaceChildren(h("table", { class: "acl-table" },
      h("thead", {}, h("tr", {}, ["Method", "Rank IC", "Sharpe gross", "Sharpe net [95%]", "Net minus EW", "Holm p", "Net, market-hedged*", "Turnover / yr", "Alpha (7 factors)"].map((t) => h("th", { text: t })))),
      h("tbody", {}, order.map((m) => {
        const s = M[m].stats, v = M[m].vs_ew;
        return h("tr", { class: (m === "EW" ? "is-bench " : "") + (m === selected ? "is-sel" : ""), onclick: () => { selected = m; drawTable(); drawSel(); } },
          h("td", { text: m, title: M[m].label }), h("td", { text: f4(s.rank_ic) }), h("td", { text: f2(s.sharpe_gross) }),
          h("td", { text: `${f2(s.sharpe_net)} [${f2(s.sharpe_net_lo)}, ${f2(s.sharpe_net_hi)}]` }),
          h("td", { class: v ? (v.p_sharpe_holm < 0.05 ? (v.sharpe_diff > 0 ? "pos" : "neg") : "") : "", text: v ? f2(v.sharpe_diff) : "benchmark" }),
          h("td", { text: v ? f3(v.p_sharpe_holm) : "" }),
          h("td", { text: H[m] ? f2(H[m].hedged) : "" }),
          h("td", { text: f2(s.turnover) }),
          h("td", { text: Number.isFinite(s.alpha) ? `${pct(s.alpha)} (t ${f2(s.alpha_t)})` : "" }));
      }))));
  };
  const drawCum = () => {
    const ser = [...pick].map((m, i) => { let w = 1; return { name: m, values: M[m].net.map((r) => (w *= 1 + (r ?? 0))), color: seriesColor(order.indexOf(m) % 8) }; });
    lineChart(cum, { x: months, xLabel: (s) => s.slice(0, 4), yFormat: (v) => `${v.toFixed(1)}x`, log: true, height: 280, series: ser });
  };
  const drawSel = () => {
    const m = selected;
    const d = M[m].ic.map((v, i) => (v ?? NaN) - (M.EW.ic[i] ?? NaN));
    const r60 = d.map((_, i) => { if (i < 59) return NaN; let s = 0, n = 0; for (let j = i - 59; j <= i; j++) if (Number.isFinite(d[j])) { s += d[j]; n++; } return n ? s / n : NaN; });
    lineChart(roll, { x: months, xLabel: (s) => s.slice(0, 4), yFormat: f3, height: 220, zero: true, endLabels: false,
                      series: [{ name: `${m} minus EW, 5-year average rank IC`, values: r60, color: seriesColor(1) }] });
    const wy = M[m].weights_by_year;
    if (wy) {
      const famNames = [...new Set(D.families)];
      const ser = famNames.map((f, j) => ({ name: f, color: seriesColor(j), values: wy.w.map((row) => row.reduce((s, v, k) => s + (D.families[k] === f ? v : 0), 0)) }));
      lineChart(fam, { x: wy.years, xLabel: (y) => String(y), yFormat: f2, height: 240, zero: true, series: ser });
    } else fam.replaceChildren(h("p", { class: "acl-note", text: `${m} is not linear: no weights to show. See the importance table in the report.` }));
  };
  chips.replaceChildren(...order.map((m) => h("label", { class: "acl-chip" }, h("input", { type: "checkbox", checked: pick.has(m), onchange: (e) => {
    if (e.target.checked) { if (pick.size >= 5) { e.target.checked = false; return; } pick.add(m); } else pick.delete(m); drawCum(); } }), m)));
  panel.replaceChildren(...[
    h("div", { class: "acl-callout", text: `The confirmatory study: ${order.length} methods, 16 published signals, S&P 500 members as of each month (survivorship-free CRSP data), monthly returns from ${months[0]} to ${months[months.length - 1]} (each forecast formed the month before), rank-weighted long-short portfolios after trading costs. Every number below is out of sample.` }),
    tiles,
    h("div", { class: "acl-card" }, h("h4", { text: "Every method (click a row)" }), tbl,
      h("p", { class: "acl-note", text: "Net minus EW: difference in annualized net Sharpe; Holm p adjusts the Ledoit-Wolf bootstrap test for 16 comparisons. *Market-hedged: each method's return minus an ex-ante market hedge (36-month beta), 1983-2024; an exploratory analysis decided after the main results. Equal weights carries a market beta of about -0.5 from its low-risk signals; once it is hedged, no method beats it. Alpha: annualized intercept on market, size, value, profitability, investment, momentum and short-term reversal factors." })),
    D.subperiods ? h("div", { class: "acl-card" }, h("h4", { text: "Net Sharpe by period: every method fades" }), (() => {
      const pers = Object.keys(D.subperiods).sort();
      return h("div", { class: "acl-tablewrap" }, h("table", { class: "acl-table" },
        h("thead", {}, h("tr", {}, ["Method", ...pers.flatMap((p) => [`${p} net Sharpe`, "rank IC"])].map((t) => h("th", { text: t })))),
        h("tbody", {}, order.map((m) => h("tr", { class: m === "EW" ? "is-bench" : "" }, h("td", { text: m }),
          ...pers.flatMap((p) => [h("td", { text: f2(D.subperiods[p][m]?.sharpe_net) }), h("td", { text: f3(D.subperiods[p][m]?.rank_ic) })]))))));
    })()) : null,
    D.extension ? h("div", { class: "acl-card" }, h("h4", { text: "Adding analyst and options signals (a second pre-registered test)" }),
      h("p", { class: "acl-note", text: "Four I/B/E/S signals (forecast revisions, revision breadth, earnings surprise, forecast dispersion) and three OptionMetrics signals (volatility skew, call-put volatility spread, realized minus implied volatility), compared on the same months as the sixteen alone. The pre-registered rule needs a complex method that beats equal weighting on all signals after the Holm correction and in an SPA test." }),
      ...Object.values(D.extension).map((x) => h("div", { class: "acl-tablewrap", style: { marginTop: "8px" } },
        h("p", { text: extText(x) }),
        h("table", { class: "acl-table" },
          h("thead", {}, h("tr", {}, ["Signals", "Method", "Rank IC", "Net Sharpe", "Net, market-hedged"].map((t) => h("th", { text: t })))),
          h("tbody", {}, x.rows.map((r) => h("tr", { class: r.method === "EW" ? "is-bench" : "" },
            h("td", { text: r.set }), h("td", { text: r.method }), h("td", { text: f4(r.rank_ic) }),
            h("td", { text: f2(r.sharpe_net) }), h("td", { text: f2(r.sharpe_hedged) })))))))) : null,
    h("div", { class: "acl-card" }, h("h4", { text: "Growth of $1 after costs (pick up to five)" }), chips, cum),
    h("div", { class: "acl-grid2", style: { marginTop: "14px" } },
      h("div", { class: "acl-card" }, h("h4", { text: "Rolling 5-year rank IC, selected method minus EW" }), roll),
      h("div", { class: "acl-card" }, h("h4", { text: "Weight on each signal family, by year (selected method)" }), fam)),
    h("div", { class: "acl-grid2", style: { marginTop: "14px" } },
      h("div", { class: "acl-card" }, h("h4", { text: "How the 16 signals correlate (average within-month rank correlation)" }), heat),
      h("div", { class: "acl-card" }, h("h4", { text: "Each signal alone" }), sigs)),
  ].filter(Boolean));
  drawTable(); drawCum(); drawSel();
  heatmap(heat, { matrix: D.signal_corr, labels: D.signals, format: f2 });
  sigs.replaceChildren(h("table", { class: "acl-table" },
    h("thead", {}, h("tr", {}, ["Signal", "Family", "Rank IC", "Net Sharpe"].map((t) => h("th", { text: t })))),
    h("tbody", {}, D.signals.map((n, k) => h("tr", {}, h("td", { text: n }), h("td", { text: D.families[k] }),
      h("td", { text: f4(D.signal_stats[n].rank_ic) }), h("td", { text: f2(D.signal_stats[n].sharpe_net) }))))));
}

for (const el of document.querySelectorAll("[data-acl-lab]")) mount(el);
