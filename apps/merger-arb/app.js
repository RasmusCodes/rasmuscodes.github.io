import * as E from "./engine.js?v=4";

const $ = (id) => document.getElementById(id);
const pct = (x, d = 1) => (Number.isFinite(x) ? `${(100 * x).toFixed(d)}%` : "n/a");
const usd = (x, d = 0) => (Number.isFinite(x) ? `${x < 0 && Math.abs(x) >= 0.5 * 10 ** -d ? "-" : ""}$${Math.abs(x).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d })}` : "n/a");
const css = (v) => getComputedStyle(document.querySelector(".viz-root")).getPropertyValue(v).trim();

const snap = await (await fetch("data/snapshot.json?v=4")).json();
const deal = snap.deal;
const T = deal.target, A = deal.acquirer;
const mdl = snap.model;
const defaults = { ratio: deal.ratio, L0: snap.L0, M0: snap.M0, close: deal.expected_close, equity: 10000, lots: 1,
  fee: 100 * snap.borrow_fee, pa: 0.90, pt: 0.90, pr: 0.605, po: 0.97, S: Math.round(snap.standalone.factor_model * 100) / 100,
  kappa: mdl.rebound_kappa, hurdle: 0.05 };

function setInputs(v) { for (const [k, val] of Object.entries(v)) { const el = $(k); if (el) el.value = val; } }
function readInputs() {
  const n = (id) => parseFloat($(id).value);
  return { ratio: n("ratio"), L0: n("L0"), M0: n("M0"), close: $("close").value || deal.expected_close, equity: n("equity"),
    lots: Math.max(0, Math.round(n("lots") || 0)), fee: n("fee") / 100, pa: n("pa"), pt: n("pt"), pr: n("pr"), po: n("po"),
    S: n("S"), kappa: n("kappa"), hurdle: n("hurdle") };
}

const rf = (years) => {
  const c = Object.entries(snap.curve).map(([k, v]) => [parseFloat(k), v]).sort((a, b) => a[0] - b[0]);
  if (years <= c[0][0]) return c[0][1];
  for (let i = 1; i < c.length; i++) if (years <= c[i][0]) return c[i - 1][1] + (c[i][1] - c[i - 1][1]) * (years - c[i - 1][0]) / (c[i][0] - c[i - 1][0]);
  return c.at(-1)[1];
};

function layout(title, extra = {}) {
  return { title: { text: title, x: 0, xanchor: "left", font: { size: 14, color: css("--ink") } }, paper_bgcolor: css("--surface-1"),
    plot_bgcolor: css("--surface-1"), font: { family: "system-ui, -apple-system, Segoe UI, sans-serif", color: css("--ink2"), size: 12 },
    margin: { l: 56, r: 16, t: 44, b: 44 }, xaxis: { gridcolor: css("--grid"), linecolor: css("--axis"), zerolinecolor: css("--axis") },
    yaxis: { gridcolor: css("--grid"), linecolor: css("--axis"), zerolinecolor: css("--axis") },
    legend: { orientation: "h", y: -0.2 }, hoverlabel: { font: { family: "system-ui" } }, ...extra };
}
const cfg = { displayModeBar: false, responsive: true };

// ---------------------------------------------------------------- header + data note
const qL = snap.quotes[T], qM = snap.quotes[A];
$("asof").textContent = `Data as of the ${snap.as_of} close: ${T} $${snap.L0.toFixed(2)}, ${A} $${snap.M0.toFixed(2)}, both ${qL.label}s. Not live. Rebuilt ${snap.built_utc.slice(0, 16).replace("T", " ")} UTC.`;
$("datanote").innerHTML = `This research page recomputes the model in your browser. It has <strong>no trading functionality</strong>. Prices are closing prints from an unofficial source, checked against Cboe and Google Finance. All-stock deal: <strong>${deal.ratio} ${A} per ${T}</strong>, fixed, no collar. Expected close: ${deal.expected_close_text}; final outside date ${deal.final_outside_date}. Research only, not investment advice.`;

function verdictHTML(sig) {
  const cls = sig.decision === "TRADE" ? "b-trade" : sig.decision === "WATCH" ? "b-watch" : "b-no";
  return `<span class="badge ${cls}">${sig.decision}</span> <strong>Report verdict (defaults, revised 25 Nov after a triple check): potentially attractive, small size only.</strong>
  <div class="small muted">${snap.verdict_note}</div>`;
}

// ---------------------------------------------------------------- render
let lastMC = null;
function render() {
  const x = readInputs();
  for (const k of ["pa", "pt", "pr", "po"]) $(`o_${k}`).textContent = pct(x[k], 0);
  $("o_k").textContent = pct(x.kappa, 0); $("o_h").textContent = pct(x.hurdle, 0);
  const p = x.pa * x.pt * x.pr * x.po;
  $("pc").textContent = pct(p, 1);
  const d = { ...deal, ratio: x.ratio, expected_close: x.close };
  const delta = 1 - x.M0 / snap.standalone.acquirer_counterfactual, j = x.kappa * delta / (1 - delta), jf = delta / (1 - delta);
  $("shint").textContent = `factor model ${snap.standalone.factor_model.toFixed(0)} (±${(100 * snap.standalone.sigma).toFixed(0)}%) / stress ${snap.standalone.stress.toFixed(0)}`;
  const years = Math.max(E.yearFrac(snap.as_of, x.close), 1 / 365);
  const w = x.pa * x.pt * (1 - x.pr) / Math.max(1 - p, 1e-12);       // P(regulatory termination | break): pays the fee
  const xIn = { L: x.L0, M: x.M0, date: snap.as_of, close: x.close, fee: x.fee, p, S: x.S, j, Ss: snap.standalone.stress,
    js: jf, rf: rf(years), finRate: rf(years), hurdle: x.hurdle, fresh: true, w, fL: mdl.fee_target_after_tax,
    fM: mdl.fee_acquirer_after_tax, entry: mdl.entry_cost_unit, exitB: mdl.entry_cost_unit, tb: mdl.years_to_break };
  $("feehint").textContent = `If regulators kill the deal, Marvell pays $3.2bn: +${usd(mdl.fee_target_after_tax, 2)} per ${T} share and −${usd(mdl.fee_acquirer_after_tax, 2)} per ${A} share after tax. At these odds ${pct(w, 0)} of breaks would pay it (failed votes pay nothing).`;
  const sig = E.evaluate(d, xIn);
  const m = sig.m;
  $("verdict").innerHTML = verdictHTML(sig);
  const tiles = [["Gross spread", pct(m.gross_spread), `${usd(m.spread_usd, 2)} per ${T} share`],
    ["Annualised if it closes", pct(m.annualized_if_complete), `net of carry and costs, ${years.toFixed(2)} years`],
    ["Expected excess return", `${m.expected_excess_annual >= 0 ? "+" : ""}${pct(m.expected_excess_annual)}/yr`, `after financing the long at ${pct(rf(years), 2)}`],
    ["Break-even P(complete)", pct(m.breakeven_p_base, 0), `stress ${pct(m.breakeven_p_stress, 0)}; yours ${pct(p, 0)}`],
    ["Completion P&L", usd(m.completion_pnl_unit, 2), `per ${T} share, net of carry and costs`],
    ["Break P&L (average)", usd(m.break_pnl_unit_base, 2), `failed vote ${usd(m.break_pnl_unit_base_nofee, 0)}; regulatory ${usd(m.break_pnl_unit_base_regulatory, 0)}; stress ${usd(m.break_pnl_unit_stress, 0)}`],
    ["Spread needed for hurdle", pct(m.required_spread_for_hurdle), `hurdle ${pct(x.hurdle, 0)}/yr after financing`],
    ["Signal", sig.decision, "recomputed from your inputs"]];
  $("tiles").innerHTML = tiles.map(([k, v, s]) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${s}</div></div>`).join("");
  $("reasons").innerHTML = sig.reasons.length ? sig.reasons.map((r) => `<li>${r}</li>`).join("") : "<li>All checks pass. Execution still requires manual approval in the local tool.</li>";

  // spread history
  const h = snap.spread_history;
  Plotly.react("ch_spread", [{ x: h.map((r) => r.date), y: h.map((r) => r.gross_spread), mode: "lines+markers", line: { color: css("--s1"), width: 2 },
    marker: { size: 6 }, hovertemplate: "%{x|%b %d}: %{y:.1%}<extra></extra>", name: "gross spread" }],
    layout(`Gross spread, ${deal.ratio} × ${A} / ${T} − 1 (Oct 29–30: speculation, terms unknown)`, { yaxis: { tickformat: ".0%", gridcolor: css("--grid"), rangemode: "tozero" },
      shapes: [{ type: "line", x0: deal.announced, x1: deal.announced, yref: "paper", y0: 0, y1: 1, line: { color: css("--axis"), width: 1 } }],
      annotations: [{ x: deal.announced, y: 1, yref: "paper", text: "terms announced", showarrow: false, xanchor: "left", font: { color: css("--ink2"), size: 11 } }], showlegend: false }), cfg);

  // EV vs probability
  const ps = []; for (let q = 0.30; q <= 0.951; q += 0.05) ps.push(+q.toFixed(2));
  const line = (S_, j_, name, col) => ({ x: ps, y: ps.map((q) => E.economics(d, { ...xIn, p: q, S: S_, j: j_ }).excess), name, mode: "lines",
    line: { color: col, width: 2 }, hovertemplate: `${name}: P(complete) %{x:.0%} → %{y:+.1%}/yr<extra></extra>` });
  Plotly.react("ch_ev", [line(x.S, j, "your break case", css("--s1")), line(snap.standalone.stress, jf, "stress break", css("--s2"))],
    layout("Expected excess return per year (after financing) vs completion probability", { xaxis: { tickformat: ".0%", gridcolor: css("--grid") },
      yaxis: { tickformat: ".0%", gridcolor: css("--grid") },
      shapes: [{ type: "line", xref: "paper", x0: 0, x1: 1, y0: x.hurdle, y1: x.hurdle, line: { color: css("--muted"), width: 1 } },
        { type: "line", x0: p, x1: p, yref: "paper", y0: 0, y1: 1, line: { color: css("--axis"), width: 1 } }],
      annotations: [{ x: p, y: 1, yref: "paper", text: `your p ${pct(p, 0)}`, showarrow: false, xanchor: "left", font: { size: 11, color: css("--ink2") } },
        { x: 0.31, y: x.hurdle, text: "hurdle", showarrow: false, yanchor: "bottom", xanchor: "left", font: { size: 11, color: css("--ink2") } }] }), cfg);

  // break-even heatmap
  const Ss = []; for (let s = 380; s <= 700; s += 20) Ss.push(s);
  const js = [0, 0.05, +j.toFixed(4), 0.2, +jf.toFixed(4), 0.35].filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b);
  const z = Ss.map((S) => js.map((jj) => E.economics(d, { ...xIn, S, j: jj }).pStar));
  const ramp = ["--seq0", "--seq1", "--seq2", "--seq3", "--seq4", "--seq5", "--seq6"].map((v, i, a) => [i / (a.length - 1), css(v)]);
  Plotly.react("ch_heat", [{ type: "heatmap", z, x: js.map((v) => `+${(100 * v).toFixed(0)}%`), y: Ss.map((v) => `$${v}`), zmin: 0, zmax: 1,
    colorscale: ramp, colorbar: { tickformat: ".0%", outlinewidth: 0 }, hovertemplate: `${A} jump %{x}, ${T} at %{y}: break-even p %{z:.0%}<extra></extra>` }],
    layout("Break-even completion probability (after the fee and financing)", { xaxis: { type: "category", title: { text: `${A} jump on a break` } },
      yaxis: { type: "category", title: { text: `${T} price on a break` } } }), cfg);

  // scenarios
  const pos = E.unitsToPosition(x.lots, x.ratio);
  const g0 = x.ratio * x.M0 / x.L0 - 1;
  const specs = E.defaultScenarios(d, snap.as_of, g0, snap.standalone.factor_model, snap.standalone.stress, j, jf);
  const rows = x.lots ? specs.map((s) => E.runScenario(s, d, pos, x.equity, x.L0, x.M0, snap.as_of, x.fee)) : [];
  $("scen").innerHTML = `<thead><tr><th>Scenario (${pos.t} ${T} long / ${pos.a} ${A} short, ${usd(x.equity)})</th><th>Outcome</th><th>End</th><th>${T} leg</th><th>${A} leg</th><th>Dividends</th><th>Borrow</th><th>Net P&L</th><th>% equity</th><th>Ann.</th><th>Min excess liq.</th><th>Max DD</th></tr></thead><tbody>` +
    rows.map((r) => `<tr><td>${r.name}</td><td>${r.outcome}</td><td>${r.end}</td><td>${usd(r.pnl_long)}</td><td>${usd(r.pnl_short)}</td><td>${usd(r.dividends_paid, 2)}</td><td>${usd(r.borrow_cost, 2)}</td><td><strong>${usd(r.net_pnl)}</strong></td><td>${pct(r.roe)}</td><td>${pct(r.ann)}</td><td>${usd(r.min_excess_liquidity)}</td><td>${pct(r.max_drawdown)}</td></tr>`).join("") + "</tbody>";

  // P&L heatmap for instant moves
  const mv = []; for (let v = -0.4; v <= 0.801; v += 0.1) mv.push(+v.toFixed(2));
  const zp = mv.map((dl) => mv.map((dm) => (pos.t * x.L0 * dl - pos.a * x.M0 * dm) / x.equity));
  const zmax = Math.max(0.01, ...zp.flat().map(Math.abs));
  Plotly.react("ch_pnl", [{ type: "heatmap", z: zp, x: mv.map((v) => `${v >= 0 ? "+" : ""}${(100 * v).toFixed(0)}%`), y: mv.map((v) => `${v >= 0 ? "+" : ""}${(100 * v).toFixed(0)}%`),
    zmin: -zmax, zmax, colorscale: [[0, css("--div-neg")], [0.5, css("--div-mid")], [1, css("--s1")]], colorbar: { tickformat: ".0%", outlinewidth: 0 },
    hovertemplate: `${A} %{x}, ${T} %{y}: %{z:.1%} of equity<extra></extra>` }],
    layout(`Instant-move P&L, % of equity`, { xaxis: { type: "category", title: { text: `${A} move` } }, yaxis: { type: "category", title: { text: `${T} move` } } }), cfg);

  // margin sensitivity: MRVL rally with spread widening to 35%
  const sizes = [[`${x.lots} lots (yours)`, pos, css("--s1")], ["max Reg T", E.unitsToPosition(Math.max(1, Math.floor(x.equity / (0.5 * (2 * x.L0 + 9 * x.M0)))), x.ratio), css("--s2")]];
  const mvs = []; for (let v = 0; v <= 1.501; v += 0.05) mvs.push(+v.toFixed(2));
  Plotly.react("ch_margin", sizes.map(([name, ps_, col]) => ({ x: mvs, y: mvs.map((v) => { const Mx = x.M0 * (1 + v), Lx = v > 0 ? x.ratio * Mx / 1.35 : x.L0;
    const eq = x.equity + ps_.t * (Lx - x.L0) - ps_.a * (Mx - x.M0); return E.accountState(eq, ps_, Lx, Mx).excess / x.equity; }),
    name: `${name} (${ps_.t}/${ps_.a})`, mode: "lines", line: { color: col, width: 2 }, hovertemplate: `${A} %{x:+.0%}: excess liquidity %{y:.0%} of equity<extra></extra>` })),
    layout(`Excess liquidity if ${A} rallies and the spread widens to 35%`, { xaxis: { tickformat: ".0%", gridcolor: css("--grid") }, yaxis: { tickformat: ".0%", gridcolor: css("--grid") },
      shapes: [{ type: "line", xref: "paper", x0: 0, x1: 1, y0: 0, y1: 0, line: { color: css("--ink"), width: 1 } }],
      annotations: [{ xref: "paper", x: 0, y: 0, text: "margin call below", showarrow: false, xanchor: "left", yanchor: "bottom", font: { size: 11, color: css("--ink2") } }] }), cfg);

  const mu = E.maxUnits(x.equity, x.L0, x.M0, x.ratio);
  $("sizing").innerHTML = `Largest size passing the survival policy: <strong>${mu.units} lots</strong> (${E.unitsToPosition(mu.units, x.ratio).t} ${T} / ${E.unitsToPosition(mu.units, x.ratio).a} ${A}); binding constraint: <em>${mu.binding}</em>. The policy: worst plausible stress loss ≤ 10% of equity, excess liquidity ≥ 50%, Reg T met, and no margin call in extreme stresses. The report also caps size by Monte Carlo tail risk (95% expected shortfall ≤ 20% of equity), which gives <strong>1 lot per $10k</strong> at today's inputs. IBKR may charge higher house margin on merger targets; the real requirement comes from IBKR's what-if check.`;
  lastMC = { d, pos, x, p, delta, j, years };
}

function runMC() {
  const { d, pos, x, delta, years } = lastMC;
  if (!x.lots) { $("mcstatus").textContent = "set at least one lot"; return; }
  $("mcstatus").textContent = "running...";
  setTimeout(() => {
    const t0 = performance.now(), c = snap.calibration;
    // model uncertainty as in the repository's base run: break value lognormal around your input, reversal +/- 25 pts
    const r = E.monteCarlo(d, pos, x.equity, x.L0, x.M0, snap.as_of, { n: parseInt($("paths").value, 10), seed: 20261124,
      acqVol: c.acq_vol, sVol: c.standalone_vol, rho: c.rho, spreadVol: c.spread_vol, widen: 0.35, s0: x.S, sSigma: snap.standalone.sigma,
      kLo: Math.max(0, x.kappa - 0.25), kHi: Math.min(1, x.kappa + 0.25), delta,
      pAcqVote: 1 - x.pa, pTgtVote: 1 - x.pt, pReg: 1 - x.pr, pOther: 1 - x.po, vote: "2027-06-30", fee: x.fee,
      feePs: deal.regulatory_fee_per_share, feeAcqPs: deal.regulatory_fee_per_acquirer_share, tax: deal.fee_tax_rate, finRate: rf(years) });
    const s = r.summary;
    $("mcout").innerHTML = `<div class="tiles">${[["Mean P&L", usd(s.mean), `${pct(s.mean / x.equity)} of equity; ${usd(s.meanNet)} after financing`], ["Median", usd(s.median), ""],
      ["P(loss)", pct(s.pLoss, 0), ""], ["95% VaR / ES", `${usd(s.var95)} / ${usd(s.es95)}`, pct(s.es95 / x.equity, 0) + " of equity (ES)"],
      ["P(margin liquidation)", pct(s.pLiq, 2), ""], ["Mean holding", `${s.meanYears.toFixed(2)} yrs`, ""]].map(([k, v, dd]) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${dd}</div></div>`).join("")}</div>`;
    const xs = r.res.map((q) => q.pnl / x.equity).sort((a, b) => a - b);
    Plotly.react("ch_mc", [{ x: xs, y: xs.map((_, i) => (i + 1) / xs.length), mode: "lines", line: { color: css("--s1"), width: 2 }, name: "paths",
      hovertemplate: "P&L ≤ %{x:.1%}: %{y:.0%} of paths<extra></extra>" }],
      layout("Cumulative distribution of account P&L at resolution (step = completion; left tail = breaks)", { xaxis: { tickformat: ".0%", gridcolor: css("--grid") },
        yaxis: { tickformat: ".0%", gridcolor: css("--grid") }, showlegend: false }), cfg);
    const hc = E.hedgeComparison(r.unit, x.L0, x.M0, x.ratio);
    $("hedges").innerHTML = `<thead><tr><th>Hedge (same paths, per ${T} share)</th><th>Short ${A} per ${T}</th><th>Mean</th><th>Std</th><th>P(loss)</th><th>95% ES</th></tr></thead><tbody>` +
      hc.map((h) => `<tr><td>${h.name}</td><td>${h.h.toFixed(2)}</td><td>${usd(h.mean, 2)}</td><td>${usd(h.sd)}</td><td>${pct(h.pLoss, 0)}</td><td>${usd(h.es95)}</td></tr>`).join("") + "</tbody>";
    $("mcstatus").textContent = `${s.n.toLocaleString()} paths in ${((performance.now() - t0) / 1000).toFixed(1)} s (browser RNG; the repository's Python run uses 20,000 paths)`;
  }, 20);
}

function comps() {
  const rows = snap.comparables.slice().sort((a, b) => b.spread_d16 - a.spread_d16);
  $("comps").innerHTML = `<thead><tr><th>Deal</th><th>Consideration</th><th>Outcome</th><th>Day-16 spread</th><th>Median</th><th>Max</th><th>Calendar days</th></tr></thead><tbody>` +
    `<tr><td><strong>${A} / ${T} (today)</strong></td><td>stock</td><td>pending</td><td><strong>${pct(snap.spread_history.at(-1).gross_spread)}</strong></td><td></td><td></td><td></td></tr>` +
    rows.map((r) => `<tr><td>${r.acquirer} / ${r.target}</td><td>${r.consideration}</td><td>${r.outcome === "partial" ? "closed 2025 (data to 2024)" : r.outcome}</td><td>${r.spread_d16.toFixed(1)}%</td><td>${r.median_spread.toFixed(1)}%</td><td>${r.max_spread.toFixed(1)}%</td><td>${r.calendar_days}</td></tr>`).join("") + "</tbody>";
}

function antitrust() {
  const a = snap.antitrust;
  if (!a) return;
  $("gap").textContent = usd(a.gap_at_q50);
  $("gates").innerHTML = `<thead><tr><th>Gate</th><th>P(success)</th></tr></thead><tbody>` +
    a.gates.map((g) => `<tr><td>${g.gate}</td><td>${pct(g.p_success, 1)}</td></tr>`).join("") + "</tbody>";
  const v = $("rev").value, rows = v === "full" ? a.impact_full : v === "half" ? a.impact_half : a.impact_base;
  const keep = ["HSR second request issued", "EU opens phase 2", "SAMR acceptance delayed / pull-and-refile", "US agency sues to block",
    "Court rules for the merger", "Court blocks the merger", "A stockholder vote fails", "Both stockholder votes pass", "SAMR approves (conditional)"];
  $("headlines").innerHTML = `<thead><tr><th>Headline</th><th>Odds after</th><th>${T}</th><th>${A}</th><th>Spread</th><th>P&L / ${T} sh, from today</th><th>on the day</th></tr></thead><tbody>` +
    rows.filter((r) => keep.includes(r.headline)).map((r) => `<tr><td>${r.headline}</td><td>${pct(r.market_q_after, 0)}</td><td>${pct(r.tgt_move)}</td><td>${pct(r.acq_move)}</td><td>${(100 * r.spread_pts >= 0 ? "+" : "") + (100 * r.spread_pts).toFixed(1)} pts</td><td>${usd(r.arb_pnl_unit)}</td><td>${usd(r.arb_pnl_unit_day)}</td></tr>`).join("") + "</tbody>";
}
$("rev").addEventListener("change", antitrust);

$("foot").innerHTML =`Sources: merger agreement (<a href="${deal.sources.merger_agreement}">Ex. 2.1</a>), <a href="${deal.sources.marvell_8k_item_1_01}">Marvell 8-K</a>, <a href="${deal.sources.press_release}">press release</a>; IBKR published margin, interest and commission schedules (2026-11-24); iBorrowDesk; FINRA short interest; US Treasury curve; CRSP (derived statistics only). Full report, model code, tests and the local execution tool: <a href="https://github.com/RasmusCodes/merger-arb-lab">github.com/RasmusCodes/merger-arb-lab</a>.`;

setInputs(defaults);
document.querySelectorAll("#inputs input").forEach((el) => el.addEventListener("input", render));
$("reset").addEventListener("click", () => { setInputs(defaults); render(); });
$("runmc").addEventListener("click", runMC);
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);
render();
comps();
antitrust();
window.__mergerarb = { E, snap };
