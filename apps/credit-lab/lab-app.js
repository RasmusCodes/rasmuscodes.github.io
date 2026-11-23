// Credit & capital-structure lab: interactive demo. Mounts into <div id="credit-lab" class="clab">.
import * as E from "./lab-engine.js?v=cca88c6e59";

const root = document.getElementById("credit-lab");
const DATA_URL = new URL("./data/cases.json?v=cca88c6e59", import.meta.url);
const REPO = "https://github.com/RasmusCodes/credit-capital-structure-lab";
const GROUP_VAR = { Priority: "--t-priority", Secured: "--t-secured", "Senior unsecured": "--t-senior",
  Subordinated: "--t-sub", Preferred: "--t-pref", Equity: "--t-equity", Other: "--t-sub" };
const GROUP_ORDER = ["Priority", "Secured", "Senior unsecured", "Subordinated", "Preferred"];

let DATA = null, cur = null, st = null, bpsCache = new Map(), sim = null;

// ---------------------------------------------------------------- formatting
const money = (x) => {
  if (x == null || !Number.isFinite(x)) return "n/a";
  const a = Math.abs(x);
  return a >= 1000 ? `$${(x / 1000).toFixed(a >= 100000 ? 0 : 1)}bn` : `$${Math.round(x)}m`;
};
const pct = (x, d = 0) => (x == null || !Number.isFinite(x) ? "n/a" : `${(x * 100).toFixed(d)}%`);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const css = (v) => getComputedStyle(root).getPropertyValue(v).trim();
const h = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstChild; };

// ---------------------------------------------------------------- state
function defaultsFor(c) {
  const cal = c.calibration;
  const tc = E.totalClaims(c.structure);
  return {
    debtScale: 1, maturityShift: 0, assetScale: 1,
    sigma: cal ? cal.sigma : 0.3,
    horizon: cal ? Math.round(Math.min(Math.max(cal.T, 1), 10) * 2) / 2 : 5,
    adminCost: c.structure.admin_cost || 0, gift: 0,
    vdef: c.scenarios ? c.scenarios.central : tc * 0.6,
    model: cal && cal.model === "black_cox" ? "black_cox" : "merton",
    barrierScale: 1,
  };
}

function structureNow() {
  return E.scaledStructure(cur.structure, st.debtScale, st.maturityShift);
}

function bpsFor(S) {
  const key = [cur.id, st.debtScale, st.maturityShift, st.adminCost, st.gift].join("|");
  if (!bpsCache.has(key)) bpsCache.set(key, E.structureBreakpoints(S, st.adminCost, st.gift));
  return bpsCache.get(key);
}

function barrierFor(S) {
  const cal = cur.calibration;
  if (st.model !== "black_cox" || !cal) return null;
  const base0 = E.defaultPoint(cur.structure, 1);
  const ratio = cal.H0 ? cal.H0 / base0 : 0.9;
  return E.defaultPoint(S, 1) * ratio * st.barrierScale;
}

function survivalFn(S, V0, sigma, H0, r, q) {
  if (H0) return (t) => 1 - E.firstPassageProb(V0, r - q, sigma, t, H0, 0);
  // Merton is a one-period model: each horizon t assumes all debt falls due at t, so 1 - P(V_t < D) is not a
  // cumulative survival curve (it can rise with t when the firm starts below its debt). Labelled as such.
  const DP = E.totalDebt(S);
  return (t) => {
    if (t <= 0) return 1;
    const d2 = (Math.log(V0 / DP) + (r - q - 0.5 * sigma * sigma) * t) / (sigma * Math.sqrt(t));
    return 1 - E.normCdf(-d2);
  };
}

function bondPrice(claim, surv, R, r) {
  // structural hybrid: survival from the asset process, recovery from the waterfall; semiannual coupons
  const M = claim.maturity;
  if (!(M > 0)) return null;
  const cpn = (claim.coupon || 0) * 100 / 2;
  let pv = 0, t = M;
  const times = [];
  while (t > 1e-6) { times.push(t); t -= 0.5; }
  for (const tk of times) pv += cpn * Math.exp(-r * tk) * surv(tk);
  pv += 100 * Math.exp(-r * M) * surv(M);
  const n = Math.max(8, Math.ceil(M * 24));
  let prev = 1;
  for (let i = 1; i <= n; i++) {
    const ti = (M * i) / n, s = Math.min(surv(ti), prev);
    pv += R * 100 * Math.exp(-r * (ti - M / (2 * n))) * (prev - s);
    prev = s;
  }
  const first = times[times.length - 1];
  const accrued = cpn * (1 - first / 0.5);
  return pv - accrued;
}

function compute() {
  const S = structureNow();
  const opts = { adminCost: st.adminCost, gift: st.gift };
  const out = { S };
  out.wf = E.distribute(S, st.vdef, opts);
  out.fulcrum = E.fulcrum(S, st.vdef, opts);
  out.totalClaims = E.totalClaims(S);
  out.totalDebt = E.totalDebt(S);
  const cal = cur.calibration;
  if (!cal) return out;
  const V0 = cal.V0 * st.assetScale, sigma = st.sigma, T = st.horizon, r = cal.r, q = cal.q || 0;
  const H0 = barrierFor(S);
  const bps = bpsFor(S);
  const pr = E.priceStructure(S, { V0, sigma, T, r, q, model: H0 ? "black_cox" : "merton", H0, defaultPoint: out.totalDebt,
    adminCost: st.adminCost, gift: st.gift, bps });
  const surv = survivalFn(S, V0, sigma, H0, r, q);
  const recAtDefault = H0 ? E.distribute(S, H0, Object.assign({ inDefault: true }, opts)).recovery : pr.condRecovery;
  Object.assign(out, { V0, sigma, T, r, q, H0, pr, surv, recAtDefault });
  out.pd1 = 1 - surv(1); out.pd5 = 1 - surv(5);
  out.dd = (Math.log(V0 / out.totalDebt) + (r - q - 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  return out;
}

// ---------------------------------------------------------------- SVG charts
function axes(g, W, H, pad, xs, ys, xFmt, yFmt, xLabel, yLabel) {
  let s = "";
  for (const y of ys.ticks) {
    const py = ys.map(y);
    s += `<line class="gridl" x1="${pad.l}" x2="${W - pad.r}" y1="${py}" y2="${py}"/>`;
    s += `<text x="${pad.l - 6}" y="${py + 3.5}" text-anchor="end">${yFmt(y)}</text>`;
  }
  for (const x of xs.ticks) {
    const px = xs.map(x);
    s += `<text x="${px}" y="${H - pad.b + 15}" text-anchor="middle">${xFmt(x)}</text>`;
  }
  s += `<line class="axisl" x1="${pad.l}" x2="${W - pad.r}" y1="${H - pad.b}" y2="${H - pad.b}"/>`;
  if (xLabel) s += `<text x="${(pad.l + W - pad.r) / 2}" y="${H - 4}" text-anchor="middle">${esc(xLabel)}</text>`;
  if (yLabel) s += `<text x="${pad.l}" y="${pad.t - 8}" text-anchor="start">${esc(yLabel)}</text>`;
  return s;
}

function niceTicks(max, n = 5) {
  if (!(max > 0)) return [0, 1];
  const step0 = max / n, mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0);
  const out = [];
  for (let v = 0; v <= max + 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

function lineChart(host, cfg) {
  // cfg: {series:[{name,color,pts:[[x,y]],dash}], xMax, yMax, xFmt, yFmt, xLabel, yLabel, vlines:[{x,label}], markers:[{x,y,label,color}]}
  const W = 640, H = cfg.height || 260, pad = { l: 46, r: 18, t: 24, b: 38 };
  const xMax = cfg.xMax, yMax = cfg.yMax;
  const xs = { map: (x) => pad.l + (x / xMax) * (W - pad.l - pad.r), ticks: cfg.xTicks || niceTicks(xMax, 6) };
  const ys = { map: (y) => H - pad.b - (y / yMax) * (H - pad.t - pad.b), ticks: cfg.yTicks || niceTicks(yMax, 4) };
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(cfg.aria || "")}">`;
  s += axes(null, W, H, pad, xs, ys, cfg.xFmt, cfg.yFmt, cfg.xLabel, cfg.yLabel);
  for (const v of cfg.vlines || []) {
    const px = xs.map(Math.min(v.x, xMax));
    s += `<line x1="${px}" x2="${px}" y1="${pad.t}" y2="${H - pad.b}" stroke="var(--c-faint)" stroke-dasharray="3 3"/>`;
    if (v.label) s += `<text x="${px}" y="${pad.t - 2}" text-anchor="middle">${esc(v.label)}</text>`;
  }
  for (const se of cfg.series) {
    const d = se.pts.filter((p) => Number.isFinite(p[1])).map((p, i) => `${i ? "L" : "M"}${xs.map(p[0]).toFixed(1)},${ys.map(Math.min(p[1], yMax)).toFixed(1)}`).join("");
    s += `<path d="${d}" fill="none" stroke="${se.color}" stroke-width="2" ${se.dash ? `stroke-dasharray="${se.dash}"` : ""} stroke-linejoin="round"/>`;
    if (se.label !== false) {
      const p = se.pts[Math.floor(se.pts.length * (se.labelAt ?? 0.62))];
      if (p && Number.isFinite(p[1])) s += `<text class="lbl" x="${xs.map(p[0]) + 6}" y="${ys.map(Math.min(p[1], yMax)) - 6}">${esc(se.name)}</text>`;
    }
  }
  for (const m of cfg.markers || []) {
    s += `<circle cx="${xs.map(m.x)}" cy="${ys.map(Math.min(m.y, yMax))}" r="5" fill="${m.color}" stroke="var(--c-surface)" stroke-width="2"/>`;
  }
  s += `<line class="xh" x1="0" x2="0" y1="${pad.t}" y2="${H - pad.b}" stroke="var(--c-faint)" visibility="hidden"/>`;
  s += `<rect class="hit" x="${pad.l}" y="${pad.t}" width="${W - pad.l - pad.r}" height="${H - pad.t - pad.b}" fill="transparent"/></svg>`;
  host.innerHTML = `<div class="chartwrap">${s}<div class="tip"></div></div>`;
  const svg = host.querySelector("svg"), tip = host.querySelector(".tip"), xh = host.querySelector(".xh");
  const hit = host.querySelector(".hit");
  hit.addEventListener("mousemove", (ev) => {
    const rc = svg.getBoundingClientRect();
    const fx = ((ev.clientX - rc.left) / rc.width) * W;
    const x = ((fx - pad.l) / (W - pad.l - pad.r)) * xMax;
    xh.setAttribute("x1", fx); xh.setAttribute("x2", fx); xh.setAttribute("visibility", "visible");
    let rows = `<div>${esc(cfg.xFmtLong ? cfg.xFmtLong(x) : cfg.xFmt(x))}</div>`;
    for (const se of cfg.series) {
      let best = se.pts[0];
      for (const p of se.pts) if (Math.abs(p[0] - x) < Math.abs(best[0] - x)) best = p;
      rows += `<div><span style="color:${se.color}">&#9679;</span> ${esc(se.name)}: <b>${cfg.yFmt(best[1])}</b></div>`;
    }
    tip.innerHTML = rows; tip.style.display = "block";
    const px = ev.clientX - rc.left, py = ev.clientY - rc.top;
    tip.style.left = `${Math.min(px + 14, rc.width - tip.offsetWidth - 4)}px`; tip.style.top = `${Math.max(py - 10, 0)}px`;
  });
  hit.addEventListener("mouseleave", () => { tip.style.display = "none"; xh.setAttribute("visibility", "hidden"); });
}

function dotRows(host, rows, cfg) {
  // rows: [{label, a, b}] two values per row on a common scale; a = market (slot 1), b = model (slot 2)
  const W = 640, rowH = 30, pad = { l: 190, r: 40, t: 26, b: 34 }, H = pad.t + pad.b + rows.length * rowH;
  const max = cfg.max;
  const x = (v) => pad.l + (Math.min(Math.max(v, 0), max) / max) * (W - pad.l - pad.r);
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(cfg.aria)}">`;
  for (const t of niceTicks(max, 5)) {
    s += `<line class="gridl" x1="${x(t)}" x2="${x(t)}" y1="${pad.t - 6}" y2="${H - pad.b}"/><text x="${x(t)}" y="${H - pad.b + 15}" text-anchor="middle">${t}</text>`;
  }
  rows.forEach((r, i) => {
    const y = pad.t + i * rowH + rowH / 2;
    s += `<text class="lbl" x="${pad.l - 10}" y="${y + 4}" text-anchor="end">${esc(r.label)}</text>`;
    if (Number.isFinite(r.a) && Number.isFinite(r.b)) s += `<line x1="${x(r.a)}" x2="${x(r.b)}" y1="${y}" y2="${y}" stroke="var(--c-rule-strong)" stroke-width="2"/>`;
    if (Number.isFinite(r.a)) s += `<circle cx="${x(r.a)}" cy="${y}" r="6" fill="var(--s1)" stroke="var(--c-surface)" stroke-width="2"><title>${esc(cfg.aName)}: ${r.a.toFixed(2)}</title></circle>`;
    if (Number.isFinite(r.b)) s += `<circle cx="${x(r.b)}" cy="${y}" r="6" fill="var(--s2)" stroke="var(--c-surface)" stroke-width="2"><title>${esc(cfg.bName)}: ${r.b.toFixed(2)}</title></circle>`;
  });
  s += `<text x="${(pad.l + W - pad.r) / 2}" y="${H - 4}" text-anchor="middle">${esc(cfg.xLabel)}</text></svg>`;
  host.innerHTML = s;
}

function histogram(host, values, cfg) {
  const W = 640, H = 200, pad = { l: 46, r: 14, t: 20, b: 36 };
  const bins = cfg.bins || 20, counts = new Array(bins).fill(0);
  values.forEach((v) => { counts[Math.min(bins - 1, Math.max(0, Math.floor(v * bins)))] += 1; });
  const n = values.length || 1, maxF = Math.max(...counts) / n || 1;
  const bw = (W - pad.l - pad.r) / bins;
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(cfg.aria)}">`;
  for (const t of niceTicks(maxF * 100, 3)) {
    const y = H - pad.b - (t / (maxF * 100)) * (H - pad.t - pad.b);
    s += `<line class="gridl" x1="${pad.l}" x2="${W - pad.r}" y1="${y}" y2="${y}"/><text x="${pad.l - 6}" y="${y + 3.5}" text-anchor="end">${t}%</text>`;
  }
  counts.forEach((c, i) => {
    const hgt = (c / n / maxF) * (H - pad.t - pad.b);
    if (hgt > 0) s += `<rect x="${pad.l + i * bw + 1}" y="${H - pad.b - hgt}" width="${bw - 2}" height="${hgt}" rx="3" fill="var(--s1)"><title>${(i / bins * 100).toFixed(0)}-${((i + 1) / bins * 100).toFixed(0)}%: ${(c / n * 100).toFixed(1)}% of defaults</title></rect>`;
  });
  for (const t of [0, 0.25, 0.5, 0.75, 1]) s += `<text x="${pad.l + t * (W - pad.l - pad.r)}" y="${H - pad.b + 15}" text-anchor="middle">${t * 100}%</text>`;
  s += `<line class="axisl" x1="${pad.l}" x2="${W - pad.r}" y1="${H - pad.b}" y2="${H - pad.b}"/>`;
  s += `<text x="${(pad.l + W - pad.r) / 2}" y="${H - 4}" text-anchor="middle">${esc(cfg.xLabel)}</text></svg>`;
  host.innerHTML = s;
}

function pathChart(host, simr, cfg) {
  // log scale: asset paths are lognormal, and a few runaway paths would flatten a linear axis
  const W = 640, H = 240, pad = { l: 56, r: 16, t: 20, b: 36 };
  const all = simr.kept.flatMap((p) => p.values).filter((v) => v > 0);
  const yMin = Math.min(...all, cfg.H0 || Infinity, cfg.DP) * 0.85, yMax = Math.max(...all, cfg.DP) * 1.1;
  const L0 = Math.log(yMin), L1 = Math.log(yMax);
  const nSteps = Math.max(...simr.kept.map((p) => p.values.length)) - 1;
  const x = (k) => pad.l + (k / nSteps) * (W - pad.l - pad.r);
  const y = (v) => H - pad.b - ((Math.log(Math.max(v, yMin)) - L0) / (L1 - L0)) * (H - pad.t - pad.b);
  const ticks = [];
  for (let e = Math.floor(Math.log10(yMin)); e <= Math.ceil(Math.log10(yMax)); e++) for (const m of [1, 2, 5]) {
    const t = m * 10 ** e;
    if (t >= yMin && t <= yMax) ticks.push(t);
  }
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Simulated asset paths (log scale)">`;
  for (const t of ticks) s += `<line class="gridl" x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}"/><text x="${pad.l - 6}" y="${y(t) + 3.5}" text-anchor="end">${money(t)}</text>`;
  for (const p of simr.kept) {
    const d = p.values.map((v, k) => `${k ? "L" : "M"}${x(k).toFixed(1)},${y(v).toFixed(1)}`).join("");
    s += `<path d="${d}" fill="none" stroke="${p.tDef !== null ? "var(--s2)" : "var(--s1)"}" stroke-opacity="${p.tDef !== null ? 0.95 : 0.45}" stroke-width="${p.tDef !== null ? 1.6 : 1.1}"/>`;
  }
  if (cfg.H0) s += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(cfg.H0)}" y2="${y(cfg.H0)}" stroke="var(--c-ink-2)" stroke-dasharray="5 4"/><text class="lbl" x="${W - pad.r}" y="${y(cfg.H0) - 5}" text-anchor="end">default barrier</text>`;
  s += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(cfg.DP)}" y2="${y(cfg.DP)}" stroke="var(--c-faint)" stroke-dasharray="2 3"/><text x="${pad.l + 4}" y="${y(cfg.DP) - 5}">debt due at horizon</text>`;
  s += `<line class="axisl" x1="${pad.l}" x2="${W - pad.r}" y1="${H - pad.b}" y2="${H - pad.b}"/>`;
  for (const t of niceTicks(cfg.T, 5)) s += `<text x="${pad.l + (t / cfg.T) * (W - pad.l - pad.r)}" y="${H - pad.b + 15}" text-anchor="middle">${t}y</text>`;
  s += `<text x="${(pad.l + W - pad.r) / 2}" y="${H - 4}" text-anchor="middle">Years (risk-neutral asset paths, log scale)</text></svg>`;
  host.innerHTML = s;
}

// ---------------------------------------------------------------- layout
function slider(id, label, min, max, step, value, fmtv, help) {
  return `<div class="ctl"><div class="row"><label for="cl-${id}">${esc(label)}</label><b id="cl-${id}-v">${fmtv(value)}</b></div>
    <input type="range" id="cl-${id}" min="${min}" max="${max}" step="${step}" value="${value}" aria-describedby="cl-${id}-h">
    ${help ? `<div class="sub" id="cl-${id}-h">${esc(help)}</div>` : ""}</div>`;
}

function buildShell() {
  const opts = DATA.cases.map((c) => `<option value="${c.id}">${esc(c.name)}${c.kind === "historical" ? " - restructuring test" : ""}${c.kind === "example" ? " (hypothetical)" : ""}</option>`).join("");
  root.innerHTML = `
    <div class="clab-top">
      <div class="pick"><label for="cl-case">Capital structure</label><select id="cl-case">${opts}</select></div>
      <div class="about" id="cl-about"></div>
    </div>
    <div class="clab-grid">
      <aside class="clab-controls" id="cl-controls" aria-label="Model inputs"></aside>
      <section class="clab-main" id="cl-main"></section>
    </div>`;
  root.querySelector("#cl-case").addEventListener("change", (e) => selectCase(e.target.value));
}

function buildControls() {
  const c = cur, cal = c.calibration, tc = E.totalClaims(c.structure);
  const host = root.querySelector("#cl-controls");
  const vmax = Math.ceil(tc * 1.3 / 100) * 100;
  let html = `<fieldset><legend>Capital structure</legend>
    ${slider("debt", "Debt vs today", 0.5, 1.6, 0.05, st.debtScale, (v) => `${(+v).toFixed(2)}x`, "Scales every debt claim (leverage).")}
    ${slider("mat", "Shift maturities", -2, 3, 0.25, st.maturityShift, (v) => `${v > 0 ? "+" : ""}${(+v).toFixed(2)}y`, "Moves debt due within a year into or out of the default point.")}
    </fieldset>
    <fieldset><legend>Default and recovery</legend>
    ${slider("vdef", "Value at default", 0, vmax, Math.max(1, Math.round(vmax / 400)), st.vdef, (v) => money(+v), "What the business is worth when it defaults.")}
    <div class="chips" id="cl-scen"></div>
    ${slider("admin", "Admin and legal costs", 0, 0.15, 0.005, st.adminCost, (v) => pct(+v, 1), "Lost to the bankruptcy process.")}
    ${slider("gift", "Gift to old equity", 0, 0.1, 0.005, st.gift, (v) => pct(+v, 1), "Deviation from absolute priority.")}
    </fieldset>`;
  if (cal) {
    html += `<fieldset><legend>Asset process</legend>
      ${slider("asset", "Asset value", 0.4, 1.8, 0.01, st.assetScale, (v) => money(cal.V0 * v), cal.model === "observed" ? "Observed: bitcoin + cash." : "Calibrated to the equity = 1.00x.")}
      ${slider("sigma", "Asset volatility", 0.05, 1.2, 0.01, st.sigma, (v) => pct(+v), "")}
      ${slider("hor", "Horizon (all debt due)", 1, 10, 0.5, st.horizon, (v) => `${(+v).toFixed(1)}y`, "")}
      ${slider("bar", "Default barrier", 0.5, 1.5, 0.05, st.barrierScale, (v) => `${(+v).toFixed(2)}x`, "Black-Cox only: x the calibrated barrier.")}
      <div class="seg" role="group" aria-label="Model"><button data-m="merton">Merton</button><button data-m="black_cox">Black-Cox</button></div>
      </fieldset>`;
  }
  html += `<button class="reset" id="cl-reset">Reset to the case's inputs</button>`;
  host.innerHTML = html;
  const bind = (id, key) => {
    const el = host.querySelector(`#cl-${id}`);
    if (!el) return;
    el.addEventListener("input", () => {
      st[key] = +el.value;
      host.querySelector(`#cl-${id}-v`).textContent = ({ debt: (v) => `${v.toFixed(2)}x`, mat: (v) => `${v > 0 ? "+" : ""}${v.toFixed(2)}y`,
        vdef: money, admin: (v) => pct(v, 1), gift: (v) => pct(v, 1), asset: (v) => money(cal.V0 * v), sigma: (v) => pct(v),
        hor: (v) => `${v.toFixed(1)}y`, bar: (v) => `${v.toFixed(2)}x` })[id](st[key]);
      schedule();
    });
  };
  [["debt", "debtScale"], ["mat", "maturityShift"], ["vdef", "vdef"], ["admin", "adminCost"], ["gift", "gift"], ["asset", "assetScale"],
    ["sigma", "sigma"], ["hor", "horizon"], ["bar", "barrierScale"]].forEach(([i, k]) => bind(i, k));
  host.querySelectorAll(".seg button").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.m === st.model));
    b.addEventListener("click", () => { st.model = b.dataset.m; host.querySelectorAll(".seg button").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); schedule(); });
  });
  const sc = host.querySelector("#cl-scen");
  if (c.scenarios) {
    const lab = c.scenario_labels || { low: "Low", central: "Central", high: "High" };
    sc.innerHTML = ["low", "central", "high"].map((k) => `<button class="chip" data-k="${k}" aria-pressed="${st.vdef === c.scenarios[k]}">${esc(lab[k])} ${money(c.scenarios[k])}</button>`).join("");
    sc.querySelectorAll(".chip").forEach((b) => b.addEventListener("click", () => {
      st.vdef = c.scenarios[b.dataset.k];
      const el = host.querySelector("#cl-vdef"); el.value = st.vdef; host.querySelector("#cl-vdef-v").textContent = money(st.vdef);
      sc.querySelectorAll(".chip").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      schedule();
    }));
  }
  host.querySelector("#cl-reset").addEventListener("click", () => { st = defaultsFor(cur); sim = null; buildControls(); render(); });
}

function buildMain() {
  const c = cur;
  const main = root.querySelector("#cl-main");
  const hist = c.kind === "historical";
  main.innerHTML = `
    ${c.calibration ? `<div class="kpis" id="cl-kpis"></div>` : ""}
    <div class="panel"><div class="panel-head"><div><h3>Recovery waterfall</h3><p class="sub">Who gets paid if the company defaults with the value on the left. Bars are allowed claims; the filled part is what each recovers, in the order the waterfall pays.</p></div></div>
      <div class="meter" id="cl-meter"></div><div class="ladder" id="cl-ladder"></div>
      <div class="keyrow" id="cl-key"></div>
      <details class="data"><summary>Data table</summary><div class="tblwrap" id="cl-wftable"></div></details></div>
    ${hist ? `<div class="panel" id="cl-hist"></div>` : ""}
    <div class="panel"><div class="panel-head"><div><h3>Recovery as value at default changes</h3><p class="sub">Recovery of each class of claim along the whole range of outcomes; dashed line = the value set on the left.</p></div></div><div id="cl-curves"></div></div>
    ${c.calibration ? `
    <div class="two">
      <div class="panel"><div class="panel-head"><div><h3>Default probability over time</h3><p class="sub">Risk-neutral, from the asset process. Dots: what the markets imply (case analysis).</p></div></div><div id="cl-pd"></div></div>
      <div class="panel"><div class="panel-head"><div><h3>Model value vs market price</h3><p class="sub">Per 100 face. Converts are shown without their conversion option.</p></div></div><div id="cl-mvm"></div></div>
    </div>
    <div class="panel"><div class="panel-head"><div><h3>Securities under stress</h3><p class="sub">Model prices per 100 face (equity per share) as the asset value or volatility moves, and in a default at the value set on the left.</p></div></div><div class="tblwrap" id="cl-stress"></div></div>
    <div class="panel"><div class="panel-head"><div><h3>Simulate default scenarios</h3><p class="sub">2,000 risk-neutral asset paths to the horizon. Each default goes through the waterfall at the asset value it happened at.</p></div>
      <div><label class="sub" for="cl-simclaim">Recovery of </label><select id="cl-simclaim"></select> <button class="simbtn" id="cl-simrun">Run simulation</button></div></div>
      <div id="cl-simout"><p class="note">Press run. Paths use the asset value, volatility, horizon and barrier set on the left.</p></div></div>` : ""}
    ${c.signals && c.signals.length ? `<div class="panel"><div class="panel-head"><div><h3>Relative-value signals</h3><p class="sub">From the scanner over the case analysis (20 Nov 2026 data). Candidates for research, each with the frictions that can keep the gap open.</p></div></div><div class="sigs" id="cl-sigs"></div></div>` : ""}
    <p class="note">Model and data: <a href="${REPO}">github.com/RasmusCodes/credit-capital-structure-lab</a>. Prices are dated snapshots; nothing here is investment advice.</p>`;
  if (c.calibration) {
    const sel = main.querySelector("#cl-simclaim");
    const claims = c.structure.claims.filter((x) => x.kind !== "common" && x.amount > 0);
    sel.innerHTML = claims.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join("");
    const pref = claims.find((x) => ["senior_unsecured", "convertible"].includes(x.kind)) || claims[0];
    sel.value = pref.id;
    main.querySelector("#cl-simrun").addEventListener("click", runSim);
    sel.addEventListener("change", () => { if (sim) renderSim(); });
  }
}

// ---------------------------------------------------------------- render
let pending = false;
function schedule() {
  // coalesce slider events into one render per frame; the timer covers pages where animation frames are paused
  // (background tabs, hidden previews), so a change is never left unrendered
  if (pending) return;
  pending = true;
  const run = () => { if (!pending) return; pending = false; render(); };
  requestAnimationFrame(run);
  setTimeout(run, 60);
}

function render() {
  const R = compute();
  renderAbout();
  renderLadder(R);
  renderCurves(R);
  if (cur.calibration) { renderKpis(R); renderPd(R); renderMvm(R); renderStress(R); if (sim) renderSim(); }
  if (cur.kind === "historical") renderHistorical(R);
  if (cur.signals && cur.signals.length) renderSignals();
}

function renderAbout() {
  const c = cur;
  const links = c.report ? ` <a href="${c.report}">Case report</a> &middot; <a href="${c.case_file}">Inputs and sources</a>` : "";
  const dates = c.kind === "example" ? "Hypothetical structure for exploring the mechanics." :
    `Balance sheet ${c.balance_sheet_date}; market data ${c.market_date} close.`;
  root.querySelector("#cl-about").innerHTML = `${esc(c.summary)}<div class="meta">${dates}${links}</div>`;
}

function waterfallOrder(S, R) {
  // pay order = descending recovery at the current value (ties by rank): the order value fills the ladder
  const claims = S.claims.filter((c) => c.kind !== "common" && c.amount > 0);
  return claims.map((c) => ({ c, rec: R.wf.recovery[c.id] }))
    .sort((a, b) => (b.rec - a.rec) || (a.c.rank - b.c.rank) || (b.c.amount - a.c.amount));
}

function renderLadder(R) {
  const S = R.S;
  const order = waterfallOrder(S, R);
  const maxAmt = Math.max(...order.map((o) => o.c.amount));
  const tc = R.totalClaims;
  const net = st.vdef * (1 - st.adminCost);
  root.querySelector("#cl-meter").innerHTML = `<div class="bar" title="Value at default vs all claims"><div class="fill" style="width:${Math.min(100, (st.vdef / tc) * 100)}%"></div></div>
    <div class="legendline"><span>Value at default <b class="num">${money(st.vdef)}</b> (${pct(st.vdef / tc)} of claims)</span><span>After ${pct(st.adminCost, 1)} costs: <b class="num">${money(net)}</b></span><span>Claims ahead of equity <b class="num">${money(tc)}</b></span></div>`;
  const fulcRec = R.fulcrum ? R.wf.recovery[R.fulcrum] : null;
  root.querySelector("#cl-ladder").innerHTML = order.map(({ c, rec }) => {
    const w = (c.amount / maxAmt) * 100;
    const col = `var(${GROUP_VAR[c.group] || "--t-senior"})`;
    const ent = S.entities.length > 1 ? ` <small>${esc((S.entities.find((e) => e.id === c.entity) || {}).name || c.entity)}</small>` : "";
    const isF = fulcRec !== null && Math.abs(rec - fulcRec) < 1e-6;
    return `<div class="rung${isF ? " fulcrum" : ""}" title="${esc(c.name)}: claim ${money(c.amount)}, recovers ${money(R.wf.payouts[c.id])}">
      <div class="name">${esc(c.name)}${ent}</div>
      <div class="track"><div class="claim" style="width:${w}%"></div><div class="rec" style="width:${w * Math.max(0, Math.min(1, rec))}%;background:${col}"></div></div>
      <div class="pct">${pct(rec)}</div></div>`;
  }).join("") + (R.wf.residual > 0.5 ? `<div class="rung"><div class="name">Common equity</div><div class="track"><div class="rec" style="width:${Math.min(100, R.wf.residual / maxAmt * 100)}%;background:var(--t-equity)"></div></div><div class="pct">${money(R.wf.residual)}</div></div>` : "");
  const groups = [...new Set(S.claims.filter((c) => c.kind !== "common").map((c) => c.group))];
  root.querySelector("#cl-key").innerHTML = GROUP_ORDER.filter((g) => groups.includes(g)).map((g) => `<span style="--k:var(${GROUP_VAR[g]})">${g}</span>`).join("")
    + `<span style="--k:var(--t-equity)">Equity</span><span class="unrec">Not recovered</span>`;
  root.querySelector("#cl-wftable").innerHTML = `<table class="tbl"><thead><tr><th>Claim</th><th>Obligor</th><th>Allowed claim</th><th>Recovery</th><th>Recovered</th></tr></thead><tbody>${
    order.map(({ c, rec }) => `<tr><td>${esc(c.name)}</td><td>${esc(c.entity)}</td><td>${money(c.amount)}</td><td>${pct(rec, 1)}</td><td>${money(R.wf.payouts[c.id])}</td></tr>`).join("")}</tbody></table>`;
}

function groupRecoveryCurves(S, xs) {
  const groups = GROUP_ORDER.filter((g) => S.claims.some((c) => c.group === g && c.amount > 0));
  const res = xs.map((v) => E.distribute(S, v, { adminCost: st.adminCost, gift: st.gift }));
  return groups.slice(0, 4).map((g, i) => {
    const ids = S.claims.filter((c) => c.group === g && c.amount > 0);
    const amt = ids.reduce((s, c) => s + c.amount, 0);
    return { name: g, color: `var(${GROUP_VAR[g]})`, labelAt: 0.25 + i * 0.15,
      pts: xs.map((v, k) => [v, ids.reduce((s, c) => s + res[k].payouts[c.id], 0) / amt]) };
  });
}

function renderCurves(R) {
  const S = R.S;
  const xMax = Math.max(R.totalClaims * 1.25, st.vdef * 1.05);
  const xs = Array.from({ length: 81 }, (_, i) => (xMax * i) / 80);
  const series = groupRecoveryCurves(S, xs);
  lineChart(root.querySelector("#cl-curves"), { series, xMax, yMax: 1, yTicks: [0, 0.25, 0.5, 0.75, 1], xFmt: money, yFmt: (v) => pct(v),
    xLabel: "Value at default", yLabel: "Recovery", vlines: [{ x: st.vdef, label: "set" }], aria: "Recovery by class versus value at default" });
}

function renderKpis(R) {
  const c = cur;
  const eqModel = R.pr.values[(R.S.claims.find((x) => x.kind === "common") || {}).id];
  const mc = c.equity ? c.equity.market_cap : null;
  const tiles = [
    ["Asset value", money(R.V0), `vol ${pct(R.sigma)}${c.calibration.model === "observed" ? " (observed)" : ""}`],
    ["Claims / assets", `${(R.totalClaims / R.V0).toFixed(2)}x`, `claims ${money(R.totalClaims)}`],
    ["PD 1 year", pct(R.pd1, 1), R.H0 ? "first passage" : "Merton: debt due in 1y"],
    ["PD 5 years", pct(R.pd5, 1), `to horizon ${pct(R.pr.pd, 1)}`],
    ["Distance to default", R.dd.toFixed(2), "standard deviations"],
  ];
  if (mc) tiles.push(["Model equity", money(eqModel), `market ${money(mc)}`]);
  root.querySelector("#cl-kpis").innerHTML = tiles.map(([k, v, d]) => `<div class="kpi"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${esc(d)}</div></div>`).join("");
}

function renderPd(R) {
  const ts = Array.from({ length: 41 }, (_, i) => i * 0.25);
  const pts = ts.map((t) => [t, t === 0 ? 0 : 1 - R.surv(t)]);
  const markers = [];
  const slot = ["var(--s2)", "var(--s3)", "var(--s4)", "var(--s2)"];
  let rows = "";
  (cur.pd_sources || []).forEach((p, i) => {
    const T = p.pd_5y != null ? 5 : p.T, v = p.pd_5y != null ? p.pd_5y : p.pd_T;
    if (v == null) return;
    rows += `<tr><td>${esc(p.label)}</td><td>${T.toFixed(1)}y</td><td>${pct(v, 1)}</td></tr>`;
    if (!/Black-Cox|CreditGrades|Observed/.test(p.label)) markers.push({ x: T, y: v, color: slot[markers.length % 4], label: p.label });
  });
  const series = [{ name: R.H0 ? "Black-Cox (this model)" : "Merton: debt due at t", color: "var(--s1)", pts, labelAt: 0.5 }];
  lineChart(root.querySelector("#cl-pd"), { series, xMax: 10, yMax: 1, yTicks: [0, 0.25, 0.5, 0.75, 1], xFmt: (v) => `${v}y`,
    xFmtLong: (v) => `${v.toFixed(2)} years`, yFmt: (v) => pct(v, 1), xLabel: "Years",
    yLabel: R.H0 ? "Cumulative default probability" : "Probability assets are below debt at t", markers,
    aria: "Default probability term structure", height: 240 });
  const key = markers.map((m) => `<span style="--k:${m.color}">${esc(m.label)}</span>`).join("");
  const mertonNote = R.H0 ? "" : `<p class="note">Merton is a one-period model: each point assumes all debt falls due on that date, so the curve can fall with time when assets start below the debt. Black-Cox gives a true cumulative curve.</p>`;
  root.querySelector("#cl-pd").insertAdjacentHTML("beforeend", `${mertonNote}<div class="keyrow"><span style="--k:var(--s1)">${R.H0 ? "Black-Cox" : "Merton"} (sliders)</span>${key}</div>
    <details class="data"><summary>Market-implied sources (case analysis)</summary><table class="tbl"><thead><tr><th>Source</th><th>Horizon</th><th>PD</th></tr></thead><tbody>${rows}</tbody></table></details>`);
}

function tradedRows(R, survFn, recFn) {
  const out = [];
  for (const cl of R.S.claims) {
    const m = (cur.market || {})[cl.id];
    if (!m || m.type === "preferred" || !(cl.maturity > 0)) continue;
    const model = bondPrice(cl, survFn, Math.max(0, Math.min(0.99, recFn(cl.id) ?? 0)), R.r);
    out.push({ label: `${cl.name.replace(/ Senior Notes| Convertible Senior Notes| Convertible Notes/, "").slice(0, 34)}${m.type === "convertible" ? " (conv.)" : ""}`,
      a: m.price, b: model, id: cl.id, conv: m.type === "convertible" });
  }
  return out;
}

function renderMvm(R) {
  const rows = tradedRows(R, R.surv, (id) => R.recAtDefault[id]);
  const host = root.querySelector("#cl-mvm");
  if (!rows.length) { host.innerHTML = `<p class="note">No traded bonds in this structure.</p>`; return; }
  const max = Math.max(120, ...rows.map((r) => Math.max(r.a || 0, r.b || 0))) > 130 ? 200 : 120;
  dotRows(host, rows, { max, aName: "Market", bName: "Model", xLabel: "Price per 100 face", aria: "Model value versus market price" });
  host.insertAdjacentHTML("beforeend", `<div class="keyrow"><span style="--k:var(--s1)">Market (last trade)</span><span style="--k:var(--s2)">Model</span></div>
    <details class="data"><summary>Data table</summary><table class="tbl"><thead><tr><th>Security</th><th>Market</th><th>Model</th><th>Gap</th></tr></thead><tbody>${
      rows.map((r) => `<tr><td>${esc(r.label)}</td><td>${r.a.toFixed(2)}</td><td>${r.b.toFixed(2)}</td><td>${(r.a - r.b).toFixed(2)}</td></tr>`).join("")}</tbody></table></details>`);
}

function renderStress(R) {
  const c = cur, S = R.S, cal = c.calibration;
  const common = S.claims.find((x) => x.kind === "common");
  const shares = c.equity ? c.equity.shares_m : null;
  const scen = [["Now", R.V0, R.sigma], ["Assets -25%", R.V0 * 0.75, R.sigma], ["Assets -50%", R.V0 * 0.5, R.sigma], ["Vol x1.5", R.V0, R.sigma * 1.5]];
  const cols = scen.map(([name, V0, sigma]) => {
    const surv = survivalFn(S, V0, sigma, R.H0, R.r, R.q);
    const pr = E.priceStructure(S, { V0, sigma, T: R.T, r: R.r, q: R.q, model: R.H0 ? "black_cox" : "merton", H0: R.H0, defaultPoint: R.totalDebt,
      adminCost: st.adminCost, gift: st.gift, bps: bpsFor(S) });
    const rec = R.H0 ? R.recAtDefault : pr.condRecovery;
    const rows = tradedRows(R, surv, (id) => rec[id]);
    return { name, rows, eq: shares ? pr.values[common.id] / shares : null, pd5: 1 - surv(5) };
  });
  const dflt = { name: `Default at ${money(st.vdef)}`, rows: tradedRows(R, () => 1, () => 0).map((r) => Object.assign({}, r, { b: 100 * (R.wf.recovery[r.id] ?? 0) })),
    eq: shares ? R.wf.residual / shares : null, pd5: 1 };
  cols.push(dflt);
  const names = cols[0].rows.map((r) => r.label);
  let html = `<table class="tbl"><thead><tr><th>Security</th><th>Market</th>${cols.map((k) => `<th>${esc(k.name)}</th>`).join("")}</tr></thead><tbody>`;
  names.forEach((n, i) => { html += `<tr><td>${esc(n)}</td><td>${cols[0].rows[i].a.toFixed(1)}</td>${cols.map((k) => `<td>${k.rows[i].b.toFixed(1)}</td>`).join("")}</tr>`; });
  if (shares) html += `<tr><td>Equity per share</td><td>${c.equity.price.toFixed(2)}</td>${cols.map((k) => `<td>${k.eq.toFixed(2)}</td>`).join("")}</tr>`;
  html += `<tr><td>PD within 5 years</td><td></td>${cols.map((k) => `<td>${pct(k.pd5)}</td>`).join("")}</tr></tbody></table>`;
  root.querySelector("#cl-stress").innerHTML = html + `<p class="note">Bond prices use survival from the asset process and the waterfall recovery at the default barrier (or the model's expected recovery under Merton). Converts exclude the conversion option.</p>`;
}

function runSim() {
  const btn = root.querySelector("#cl-simrun");
  btn.disabled = true; btn.textContent = "Running...";
  setTimeout(() => {
    const R = compute();
    const r = E.simulatePaths({ V0: R.V0, sigma: R.sigma, mu: R.r - R.q, T: R.T, H0: R.H0, DP: R.totalDebt, paths: 2000, seed: 11 });
    sim = { r, R };
    renderSim();
    btn.disabled = false; btn.textContent = "Run again";
  }, 20);
}

function renderSim() {
  const { r, R } = sim;
  const id = root.querySelector("#cl-simclaim").value;
  const recs = E.recoveryDistribution(R.S, r.defaults, { adminCost: st.adminCost, gift: st.gift }, [id])[id];
  const mean = recs.length ? recs.reduce((s, x) => s + x, 0) / recs.length : null;
  const tMean = r.defaults.length ? r.defaults.reduce((s, d) => s + d.t, 0) / r.defaults.length : null;
  const host = root.querySelector("#cl-simout");
  host.innerHTML = `<div class="kpis"><div class="kpi"><div class="k">Paths defaulting</div><div class="v">${pct(r.defaults.length / r.paths, 1)}</div><div class="d">${r.defaults.length} of ${r.paths} in ${R.T.toFixed(1)}y</div></div>
    <div class="kpi"><div class="k">Mean default time</div><div class="v">${tMean ? tMean.toFixed(1) + "y" : "n/a"}</div><div class="d">among defaults</div></div>
    <div class="kpi"><div class="k">Mean recovery</div><div class="v">${pct(mean)}</div><div class="d">${esc(R.S.claims.find((c) => c.id === id).name)}</div></div></div>
    <div class="two" style="margin-top:12px"><div id="cl-paths"></div><div id="cl-hist2"></div></div>
    <div class="keyrow"><span style="--k:var(--s1)">Survives</span><span style="--k:var(--s2)">Defaults</span></div>`;
  pathChart(host.querySelector("#cl-paths"), r, { H0: R.H0, DP: R.totalDebt, T: R.T });
  if (recs.length) {
    histogram(host.querySelector("#cl-hist2"), recs, { xLabel: "Recovery in default (share of claim)", aria: "Distribution of recoveries in simulated defaults" });
    host.querySelector("#cl-hist2").insertAdjacentHTML("beforeend", R.H0
      ? `<p class="note">Under Black-Cox every barrier default happens at the same asset value, so recoveries pile up at one level; only defaults at the horizon are spread out. Switch to Merton to see recoveries vary with the asset value at maturity.</p>`
      : `<p class="note">Under Merton default happens only at the horizon, at whatever asset value the path ends on, so recoveries spread out.</p>`);
  } else host.querySelector("#cl-hist2").innerHTML = `<p class="note">No defaults in this simulation.</p>`;
}

function renderHistorical(R) {
  const h = cur.historical;
  const S = R.S;
  const liq = (v) => E.distribute(S, v, { adminCost: 0 }).recovery;
  const lo = liq(h.liquidation.low), hi = liq(h.liquidation.high);
  const rep = h.liquidation_reported;
  const rows = [["Senior secured notes (incl. make-whole)", "ssn", "ssn"], ["Administrative and priority claims", "admin", "admin"], ["Unsecured (converts, Renesas, trade)", "cv_2029", "unsecured"]];
  const d = h.plan_recoveries_derived;
  root.querySelector("#cl-hist").innerHTML = `<div class="panel-head"><div><h3>Test against the real restructuring</h3><p class="sub">Wolfspeed's 2025 Chapter 11. The engine reproduces the court-filed liquidation analysis exactly; the confirmed plan paid unsecured creditors far more than absolute priority at the plan's valuation would have.</p></div></div>
    <div class="tblwrap"><table class="tbl"><thead><tr><th>Class</th><th>Engine, Ch. 7 low</th><th>Filed</th><th>Engine, Ch. 7 high</th><th>Filed</th></tr></thead><tbody>${
      rows.map(([n, id, k]) => `<tr><td>${n}</td><td>${pct(lo[id], 1)}</td><td>${pct(rep[k][0], 1)}</td><td>${pct(hi[id], 1)}</td><td>${pct(rep[k][1], 1)}</td></tr>`).join("")}</tbody></table></div>
    <div class="tblwrap" style="margin-top:12px"><table class="tbl"><thead><tr><th>Plan outcome</th><th>As filed</th><th>Recomputed (mid equity value)</th><th>Absolute priority at ${money(h.plan_ev.mid)}</th></tr></thead><tbody>
      <tr><td>Senior secured notes</td><td>${esc(h.plan_recoveries_reported.ssn)}</td><td>${pct(d.mid.ssn)}</td><td>${pct(E.distribute(S, h.plan_ev.mid, { adminCost: 0 }).recovery.ssn)}</td></tr>
      <tr><td>Convertible notes</td><td>${esc(h.plan_recoveries_reported.convertible)}</td><td>${pct(d.mid.convertible)}</td><td>${pct(E.distribute(S, h.plan_ev.mid, { adminCost: 0 }).recovery.cv_2029, 1)}</td></tr>
      <tr><td>Renesas</td><td>${esc(h.plan_recoveries_reported.renesas)}</td><td>${pct(d.mid.renesas)}</td><td>${pct(E.distribute(S, h.plan_ev.mid, { adminCost: 0 }).recovery.renesas, 1)}</td></tr>
      <tr><td>Old equity</td><td>${esc(h.plan_recoveries_reported.old_equity)}</td><td>${money(d.mid.old_equity_value)}</td><td>$0</td></tr></tbody></table></div>
    <p class="note">Source: disclosure statement filed as Ex. 99.1 to Wolfspeed's 8-K of 1 July 2025 (liquidation analysis, Exhibit D; valuation, Exhibit F).</p>`;
}

function renderSignals() {
  root.querySelector("#cl-sigs").innerHTML = cur.signals.map((s) => `<div class="sig"><div class="h"><span>${esc(s.kind.replaceAll("_", " "))}: long ${esc(s.long)} / short ${esc(s.short)}</span><span class="conf">${esc(s.confidence)} confidence</span></div>
    <div class="r">${esc(s.read)}</div><div class="f">${(s.flags || []).map((f) => `<span>${esc(f.replaceAll("_", " "))}</span>`).join("")}</div></div>`).join("");
}

function selectCase(id) {
  cur = DATA.cases.find((c) => c.id === id) || DATA.cases[0];
  st = defaultsFor(cur);
  sim = null;
  root.querySelector("#cl-case").value = cur.id;
  try { history.replaceState(null, "", `#${cur.id}`); } catch (e) { /* sandboxed */ }
  buildControls();
  buildMain();
  render();
}

async function init() {
  if (!root) return;
  root.innerHTML = `<div class="loading">Loading the capital structures...</div>`;
  try {
    DATA = await (await fetch(DATA_URL)).json();
  } catch (e) {
    root.innerHTML = `<p class="err">Could not load the data (${esc(e.message)}).</p>`;
    return;
  }
  buildShell();
  const hash = (location.hash || "").slice(1);
  selectCase(DATA.cases.some((c) => c.id === hash) ? hash : "coreweave");
}

init();
