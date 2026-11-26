// Browser port of the mergerarb Python model (spread, carry, break P&L, signal, IBKR-style margin, sizing,
// deterministic scenarios, Monte Carlo). Checked against Python outputs in data/parity.json (see checkParity()).
// No trading functionality exists in the public build.

export const DAY = 86400000;
export const toDay = (s) => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d) / DAY; };
export const fromDay = (n) => new Date(n * DAY).toISOString().slice(0, 10);
export const isBiz = (n) => { const w = new Date(n * DAY).getUTCDay(); return w !== 0 && w !== 6; };
export const yearFrac = (a, b) => (toDay(b) - toDay(a)) / 365.25;
const addDays = (s, k) => fromDay(toDay(s) + k);

export function exDatesBetween(div, start, end) {
  if (!div || div.amount <= 0 || !div.freq || !div.last_ex_dates.length) return [];
  const step = 12 / div.freq;
  let [y, m, d] = div.last_ex_dates.slice().sort().at(-1).split("-").map(Number);
  const out = [];
  for (let i = 0; i < 200; i++) {
    let mm = m - 1 + step; y += Math.floor(mm / 12); m = (mm % 12) + 1; d = Math.min(d, 28);
    const s = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (s > end) break;
    if (s > start) out.push(s);
  }
  return out;
}

// ---------------- broker terms (IBKR Pro, 2026-11-24)
export const BROKER = { perShare: 0.005, min: 1.0, maxPct: 0.01, bm: 0.0388, debit1: 0.015, creditThreshold: 10000,
  creditSpread: -0.005, zeroTier: 100000, tier2: -0.0125, navFull: 100000, halfSpreadBps: 5, slippageBps: 5 };
export function commission(q, p, b = BROKER) { if (q <= 0) return 0; return Math.min(Math.max(b.min, b.perShare * q), b.maxPct * q * p); }
export function creditRate(cash, nav, b = BROKER) {
  if (cash <= b.creditThreshold) return 0;
  const full = Math.max(b.bm + b.creditSpread, 0), scale = Math.min(1, Math.max(nav, 0) / b.navFull);
  return full * scale * (cash - b.creditThreshold) / cash;
}
export function proceedsRate(p, nav, b = BROKER) {
  if (p <= b.zeroTier) return 0;
  const t = Math.max(b.bm + b.tier2, 0), scale = Math.min(1, Math.max(nav, 0) / b.navFull);
  return t * scale * (p - b.zeroTier) / p;
}
export const debitRate = (loan, b = BROKER) => (loan > 0 ? b.bm + b.debit1 : 0);

// ---------------- margin (IBKR US stocks)
export const RULES = { longInit: 0.2625, longMaint: 0.25, shortInit: 0.315, shortMaint: 0.30, regt: 0.5, minEquity: 2000, house: 1.0 };
export function shortMaintPerShare(px, r = RULES) { if (px > 16.67) return r.shortMaint * px; if (px > 5) return 5; if (px > 2.5) return px; return 2.5; }
export function accountState(equity, pos, L, M, r = RULES) {
  const lv = pos.t * L, sv = pos.a * M;
  const maint = r.house * (r.longMaint * lv + pos.a * shortMaintPerShare(M, r));
  const regt = r.regt * (lv + sv);
  return { equity, lv, sv, maint, regt, init: r.house * (r.longInit * lv + r.shortInit * sv), excess: equity - maint,
    regtExcess: equity - regt, lev: equity > 0 ? (lv + sv) / equity : Infinity, call: equity < maint };
}
export function exactLot(ratio, maxLot = 10000) { for (let k = 1; k <= maxLot; k++) if (Math.abs(k * ratio - Math.round(k * ratio)) < 1e-9) return k; return null; }
export function unitsToPosition(units, ratio) { const lot = exactLot(ratio) || 1; return { t: units * lot, a: Math.round(units * lot * ratio) }; }
export const STRESSES = [[-0.124, 0.27], [0.10, 0.40], [0.60, 0.60]];
export const SURVIVAL = [[-0.40, 0.50], [1.50, 1.50], [0.20, 1.00]];
const stressLoss = (pos, L, M, s) => pos.t * L * s[0] - pos.a * M * s[1];
function survives(eq0, pos, L, M, s, buf) { const eq = eq0 + stressLoss(pos, L, M, s); return eq >= accountState(eq, pos, L * (1 + s[0]), M * (1 + s[1])).maint * (1 + buf); }
export function maxUnits(equity, L, M, ratio, pol = { maxLoss: 0.10, minExcess: 0.50, buf: 0.25 }) {
  let best = 0, binding = "no size passes (equity too small?)";
  for (let u = 1; u <= 200; u++) {
    const pos = unitsToPosition(u, ratio), st = accountState(equity, pos, L, M);
    if (st.lv + st.sv > 20 * equity) break;
    const worst = Math.min(...STRESSES.map((s) => stressLoss(pos, L, M, s))) / equity;
    const checks = [["Reg T end-of-day initial", st.regtExcess >= 0], ["minimum equity", equity >= RULES.minEquity],
      ["excess liquidity floor", st.excess >= pol.minExcess * equity], ["loss budget (worst plausible stress)", worst >= -pol.maxLoss],
      ["survival (no margin call in extreme stresses)", SURVIVAL.every((s) => survives(equity, pos, L, M, s, pol.buf))]];
    const f = checks.find((c) => !c[1]);
    if (f) { binding = f[0]; break; }
    best = u;
  }
  return { units: best, binding };
}

// ---------------- probabilities and the signal (port of analytics/probability.py + analytics/signal.py)
// Break P&L per unit: target -> S (+ fee received), acquirer jumps by j and, when it pays the fee, loses accFee per share.
export function breakPnl(L0, M0, R, S, j, feePs = 0, carry = 0, accFee = 0) { return (S + feePs - L0) - R * (M0 * j - accFee) - carry; }
// averaged over break types: a share w of breaks are regulatory terminations that pay the reverse fee (s8.2(d))
export function mixedBreakPnl(L0, M0, R, S, j, carry, w, fL, fM) {
  return (1 - w) * breakPnl(L0, M0, R, S, j, 0, carry, 0) + w * breakPnl(L0, M0, R, S, j, fL, carry, fM);
}
export function breakevenP(C, B) { if (C <= 0) return 1; if (B >= 0) return 0; return -B / (C - B); }
export function carryUnit(deal, M, start, end, fee) {
  const yrs = Math.max(yearFrac(start, end), 0), n = exDatesBetween(deal.acq_dividend, start, end).length;
  return deal.ratio * (n * deal.acq_dividend.amount + fee * M * yrs);
}
// x: L, M, date, close, fee (borrow), p, S, j, Ss, js, rf, finRate, hurdle, fresh, w (P(regulatory | break)),
//    fL / fM (after-tax fee per target / acquirer share), entry / exitB (trading costs per unit), tb (years to a break)
export function economics(deal, x, L = x.L, fee = x.fee) {
  const R = deal.ratio, M = x.M, V = R * M + deal.cash;
  const years = Math.max(yearFrac(x.date, x.close), 1 / 365.25);
  const half = addDays(x.date, Math.floor((toDay(x.close) - toDay(x.date)) / 2));
  const tb = x.tb ?? years / 2, fin = x.finRate ?? x.rf, w = x.w || 0, fL = x.fL || 0, fM = x.fM || 0;
  const en = x.entry || 0, costB = en + (x.exitB || 0);
  const cc = carryUnit(deal, M, x.date, x.close, fee), cb = carryUnit(deal, M, x.date, half, fee);
  const C = (V - L) - cc - en;
  const B = mixedBreakPnl(L, M, R, x.S, x.j, cb, w, fL, fM) - costB, Bs = mixedBreakPnl(L, M, R, x.Ss, x.js, cb, w, fL, fM) - costB;
  const B0 = mixedBreakPnl(L, M, R, x.S, x.j, cb, 0, fL, fM) - costB, B1 = mixedBreakPnl(L, M, R, x.S, x.j, cb, 1, fL, fM) - costB;
  const finC = fin * L * years, finB = fin * L * tb, p = x.p;
  const cap = 0.5 * (L + R * M), capY = cap * (p * years + (1 - p) * tb);
  const ev = p * C + (1 - p) * B, evS = p * C + (1 - p) * Bs;
  const evN = p * (C - finC) + (1 - p) * (B - finB), evSN = p * (C - finC) + (1 - p) * (Bs - finB);
  return { V, years, tb, C, B, Bs, B0, B1, finC, finB, cap, capY, ev, evS, evN, evSN, excess: evN / capY, excessS: evSN / capY,
    pStar: breakevenP(C - finC, B - finB), pStarS: breakevenP(C - finC, Bs - finB), pStarG: breakevenP(C, B) };
}
export function evaluate(deal, x) {
  const L = x.L, e = economics(deal, x), V = e.V, years = e.years;
  const ann = (r) => (r > -1 ? Math.pow(1 + r, 1 / years) - 1 : -1);
  let lo = 0.2 * V, hi = V;
  for (let i = 0; i < 80; i++) { const mid = 0.5 * (lo + hi); if (economics(deal, x, mid, x.fee).excess >= x.hurdle) lo = mid; else hi = mid; }
  let fmax = 0;
  if (economics(deal, x, L, 0).excess >= x.hurdle) { let a = 0, b = 2; for (let i = 0; i < 80; i++) { const mid = 0.5 * (a + b); if (economics(deal, x, L, mid).excess >= x.hurdle) a = mid; else b = mid; } fmax = a; }
  const hard = [], soft = [], excess = e.excess;
  if (!x.fresh) hard.push("market data stale or unavailable");
  if (x.fee > 0.03) hard.push(`borrow fee ${(100 * x.fee).toFixed(2)}% above the 3% limit`);
  if (x.close > deal.final_outside_date) hard.push(`expected close ${x.close} is after the final outside date ${deal.final_outside_date}`);
  if (excess < 0) hard.push(`expected excess return ${(100 * excess).toFixed(1)}%/yr (after financing the long) is negative at p=${Math.round(100 * x.p)}%`);
  else if (excess < x.hurdle) soft.push(`expected excess return ${(100 * excess).toFixed(1)}%/yr is below the ${Math.round(100 * x.hurdle)}% hurdle`);
  const edge = x.p - e.pStar;
  if (edge < 0.10) (edge < 0 ? hard : soft).push(`probability edge ${(100 * edge).toFixed(0)} pts (p ${Math.round(100 * x.p)}% vs break-even ${Math.round(100 * e.pStar)}%) is below 10 pts`);
  if (e.evSN < 0) soft.push(`expected P&L is negative under the stress break case (break-even p ${Math.round(100 * e.pStarS)}%)`);
  return { decision: hard.length ? "NO TRADE" : soft.length ? "WATCH" : "TRADE", reasons: [...hard, ...soft],
    m: { gross_spread: V / L - 1, spread_usd: V - L, implied_value: V, years_to_close: years,
      annualized_if_complete: Math.pow(1 + e.C / L, 1 / years) - 1, completion_pnl_unit: e.C, break_pnl_unit_base: e.B,
      break_pnl_unit_base_nofee: e.B0, break_pnl_unit_base_regulatory: e.B1, break_pnl_unit_stress: e.Bs, reg_break_share: x.w || 0,
      breakeven_p_base: e.pStar, breakeven_p_base_gross: e.pStarG, breakeven_p_stress: e.pStarS, expected_pnl_unit: e.ev,
      expected_pnl_unit_stress: e.evS, expected_pnl_unit_net: e.evN, expected_pnl_unit_stress_net: e.evSN,
      financing_cost_complete: e.finC, financing_cost_break: e.finB, years_to_break: e.tb, regt_capital_unit: e.cap,
      capital_years_unit: e.capY, expected_return_on_capital: e.ev / e.cap, expected_annualized: ann(e.ev / e.cap),
      expected_excess_annual: excess, expected_excess_annual_stress: e.excessS, expected_annualized_stress: ann(e.evS / e.cap),
      required_spread_for_hurdle: V / lo - 1, max_borrow_fee_for_hurdle: fmax, edge } };
}

// ---------------- deterministic scenarios (port of analytics/scenarios.py)
export function defaultScenarios(deal, start, g0, Sopt, Sstress, jb, jf, vote = "2027-06-30", tax = 0.21) {
  const close = deal.expected_close, fod = deal.final_outside_date;
  const d3 = addDays(close, 91), d6 = addDays(close, 183), mid = addDays(start, 183), q = addDays(start, 92);
  const w = Math.max(g0, 0.30), fee = deal.regulatory_fee_per_share * (1 - tax), accFee = (deal.regulatory_fee_per_acquirer_share || 0) * (1 - tax);
  return [
    { key: "1_on_schedule", name: `Closes on schedule (${close})`, end: close, outcome: "complete", knots: [[start, 1, g0], [close, 1, 0]] },
    { key: "2_delay_3m", name: `Closes 3 months late (${d3})`, end: d3, outcome: "complete", knots: [[start, 1, g0], [d3, 1, 0]] },
    { key: "3_delay_6m", name: `Closes 6 months late (${d6}) - after the outside date`, end: d6, outcome: "complete", knots: [[start, 1, g0], [d6, 1, 0]] },
    { key: "4_break_unaffected", name: "Fails; both back to Oct-28 prices", end: vote, outcome: "break", knots: [[start, 1, g0], [vote, 1, w]], bt: deal.unaffected_target },
    { key: "4b_break_model", name: `Fails at votes; factor-model standalone, ${Math.round(100 * jb / jf)}% of MRVL's discount reverses`, end: vote, outcome: "break", knots: [[start, 1, g0], [vote, 1, w]], bt: Sopt, bmMult: 1 + jb },
    { key: "4c_break_stress", name: "Fails at votes; worst-peer standalone, full reversal", end: vote, outcome: "break", knots: [[start, 1, g0], [vote, 1, w]], bt: Sstress, bmMult: 1 + jf },
    { key: "4d_break_regulatory", name: "Regulatory failure at final outside date (+ fee, after tax; MRVL pays it)", end: fod, outcome: "break", knots: [[start, 1, g0], [addDays(fod, -1), 1, w]], bt: Sstress, bmMult: 1 + jf, fee, accFee },
    { key: "5_mrvl_down40", name: "MRVL -40%, deal closes", end: close, outcome: "complete", knots: [[start, 1, g0], [mid, 0.6, g0], [close, 0.6, 0]] },
    { key: "6_mrvl_up60_lite_lags", name: "MRVL +60% while LITE lags (spread 35%), closes", end: close, outcome: "complete", knots: [[start, 1, g0], [q, 1.6, 0.35], [close, 1.6, 0]] },
    { key: "7_both_down40", name: "Both -40%, closes", end: close, outcome: "complete", knots: [[start, 1, g0], [mid, 0.6, g0], [close, 0.6, 0]] },
    { key: "8_borrow_5pct", name: "Borrow fee 5% from 2027-01-01, closes", end: close, outcome: "complete", knots: [[start, 1, g0], [close, 1, 0]], borrow: [["2027-01-01", 0.05]] },
    { key: "9_htb_recall", name: "Hard to borrow: 30% fee, recall at a 30% spread", end: "2027-06-01", outcome: "forced_close", knots: [[start, 1, g0], ["2027-06-01", 1, 0.30]], borrow: [["2027-03-01", 0.30]] },
  ];
}
function interp(x, xs, ys) { if (x <= xs[0]) return ys[0]; for (let i = 1; i < xs.length; i++) if (x <= xs[i]) return ys[i - 1] + (ys[i] - ys[i - 1]) * (x - xs[i - 1]) / (xs[i] - xs[i - 1]); return ys.at(-1); }
export function runScenario(spec, deal, pos, equity0, L0, M0, start, fee0, liqBps = 25) {
  const R = deal.ratio, b = BROKER;
  const days = []; for (let n = toDay(start); n <= toDay(spec.end); n++) if (isBiz(n)) days.push(n);
  if (!days.length || days[0] !== toDay(start)) days.unshift(toDay(start));
  const kx = spec.knots.map((k) => toDay(k[0])), km = spec.knots.map((k) => k[1]), kg = spec.knots.map((k) => k[2]);
  const M = days.map((d) => M0 * interp(d, kx, km)), g = days.map((d) => interp(d, kx, kg));
  const L = M.map((m, i) => R * m / (1 + g[i]) + deal.cash / (1 + g[i]));
  L[0] = L0; M[0] = M0;
  const exd = exDatesBetween(deal.acq_dividend, start, spec.end).map(toDay);
  const steps = (spec.borrow || []).map(([d, v]) => [toDay(d), v]).sort((a, c) => a[0] - c[0]);
  const feeOn = (d) => { let f = fee0; for (const [sd, v] of steps) if (d >= sd) f = v; return f; };
  let comm = commission(pos.t, L0) + commission(pos.a, M0) + (pos.t * L0 + pos.a * M0) * (b.halfSpreadBps + b.slippageBps) / 1e4;
  let div = 0, bor = 0, int = 0, prev = days[0], peak = equity0 - comm, mdd = 0, liq = false, liqDate = null, last = days.length - 1;
  const eqp = [], mp = [], xp = [];
  for (let i = 0; i < days.length; i++) {
    const d = days[i], cal = d - prev;
    if (i > 0) {
      const sv = pos.a * M[i - 1];
      bor += feeOn(d) * sv * cal / 365;
      const cash = equity0 - pos.t * L0 + pos.a * M0, nav = eqp.length ? eqp.at(-1) : equity0, free = equity0 - pos.t * L0;
      int += creditRate(free, nav) * Math.max(free, 0) * cal / 365 + proceedsRate(sv, nav) * sv * cal / 365;
      if (cash < 0) int -= debitRate(-cash) * (-cash) * cal / 365;
      if (exd.some((x) => prev < x && x <= d)) div += deal.acq_dividend.amount * pos.a;
    }
    const mtm = pos.t * (L[i] - L0) - pos.a * (M[i] - M0), eq = equity0 + mtm - div - bor + int - comm;
    const st = accountState(eq, pos, L[i], M[i]);
    eqp.push(eq); mp.push(st.maint); xp.push(st.excess);
    peak = Math.max(peak, eq); mdd = Math.max(mdd, peak > 0 ? (peak - eq) / peak : 0);
    if (st.call && i < last) { liq = true; liqDate = fromDay(d); comm += (pos.t * L[i] + pos.a * M[i]) * liqBps / 1e4; last = i; break; }
    prev = d;
  }
  let Le = L[last], Me = M[last], outcome = spec.outcome;
  if (liq) outcome = "liquidated (margin call)";
  else if (spec.outcome === "complete") Le = R * Me + deal.cash;
  else if (spec.outcome === "break") { Le = spec.bt + (spec.fee || 0); Me = M0 * (spec.bmMult ?? (deal.unaffected_acquirer / M0)) - (spec.accFee || 0); comm += commission(pos.t, Le) + commission(pos.a, Me); }
  else if (spec.outcome === "forced_close") { comm += commission(pos.t, Le) + commission(pos.a, Me) + (pos.t * Le + pos.a * Me) * (b.halfSpreadBps + b.slippageBps) / 1e4; }
  const pl = pos.t * (Le - L0), ps = -pos.a * (Me - M0), net = pl + ps - div - bor + int - comm;
  const endD = fromDay(days[last]), years = Math.max((days[last] - toDay(start)) / 365.25, 1 / 365.25), roe = net / equity0;
  return { key: spec.key, name: spec.name, outcome, end: endD, pnl_long: pl, pnl_short: ps, dividends_paid: div, borrow_cost: bor,
    net_pnl: net, roe, ann: roe > -1 ? Math.pow(1 + roe, 1 / years) - 1 : -1, min_excess_liquidity: Math.min(...xp),
    max_drawdown: Math.max(mdd, peak > 0 ? (Math.max(peak, equity0 + net) - (equity0 + net)) / Math.max(peak, equity0 + net) : 0), liquidated: liq, liqDate };
}

// ---------------- Monte Carlo (same structure as analytics/montecarlo.py; different RNG, so numbers differ by noise)
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export function monteCarlo(deal, pos, equity, L0, M0, start, c) {
  const rnd = mulberry32(c.seed || 7), norm = () => { let u = 0, v = 0; while (u === 0) u = rnd(); while (v === 0) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const R = deal.ratio, horizon = deal.final_outside_date, days = [];
  for (let n = toDay(start); n <= toDay(horizon); n++) if (isBiz(n)) days.push(n);
  const D = days.length, dt = 1 / 252, x0 = Math.log(R * M0 / L0), xb = Math.log(1 + (c.widen || 0.35));
  const divIdx = new Set(exDatesBetween(deal.acq_dividend, start, horizon).map((s) => days.findIndex((d) => d >= toDay(s))));
  const idxOf = (s) => { const t = toDay(s); let k = days.findIndex((d) => d >= t); return k < 1 ? 1 : k; };
  const tri = (a, m, b) => { const u = rnd(), f = (m - a) / (b - a); return u < f ? a + Math.sqrt(u * (b - a) * (m - a)) : b - Math.sqrt((1 - u) * (b - a) * (b - m)); };
  const res = [], unit = [];
  const pC = (1 - c.pAcqVote) * (1 - c.pTgtVote) * (1 - c.pReg) * (1 - c.pOther), pB = Math.max(1 - pC, 1e-12);
  const wReg = (1 - c.pAcqVote) * (1 - c.pTgtVote) * c.pReg / pB, tax = c.tax ?? 0.21;
  for (let p = 0; p < c.n; p++) {
    const vf = rnd() < c.pAcqVote || rnd() < c.pTgtVote, rf = !vf && rnd() < c.pReg, of = !vf && !rf && rnd() < c.pOther;
    const out = vf ? 1 : rf ? 2 : of ? 3 : 0;
    let rIdx;
    if (out === 1) rIdx = idxOf(addDays(c.vote, Math.round((rnd() * 2 - 1) * 60)));
    else if (out === 2) rIdx = idxOf(fromDay(Math.round(toDay("2027-09-01") + rnd() * (toDay(horizon) - toDay("2027-09-01")))));
    else if (out === 3) rIdx = idxOf(fromDay(Math.round(toDay(start) + rnd() * (toDay(deal.expected_close) - toDay(start)))));
    else rIdx = idxOf(fromDay(Math.round(tri(toDay("2027-11-01"), toDay(deal.expected_close), toDay(horizon)))));
    rIdx = Math.min(rIdx, D - 1);
    const s0 = c.sSigma ? c.s0 * Math.exp(c.sSigma * norm())
      : c.sLo && c.sHi ? Math.exp(Math.log(c.sLo) + rnd() * (Math.log(c.sHi) - Math.log(c.sLo))) : c.s0;
    const kap = c.kLo !== undefined ? c.kLo + rnd() * (c.kHi - c.kLo) : c.kappa, j = kap * c.delta / (1 - c.delta);
    const T = rIdx * dt;
    let lm = 0, ls = 0, W = 0, bor = 0, div = 0, peak = equity, mdd = 0, liq = false, endI = rIdx, Lc = L0, Mc = M0;
    const Wpath = new Float64Array(rIdx + 1);
    for (let i = 1; i <= rIdx; i++) Wpath[i] = Wpath[i - 1] + Math.sqrt(dt) * norm();
    const WT = Wpath[rIdx];
    for (let i = 1; i <= rIdx; i++) {
      const z1 = norm(), z2 = norm(), zs = c.rho * z1 + Math.sqrt(1 - c.rho * c.rho) * z2;
      bor += c.fee * pos.a * Mc * dt;
      lm += (-0.5 * c.acqVol * c.acqVol) * dt + c.acqVol * Math.sqrt(dt) * z1;
      ls += (-0.5 * c.sVol * c.sVol) * dt + c.sVol * Math.sqrt(dt) * zs;
      Mc = M0 * Math.exp(lm);
      const fr = Math.min(i * dt / Math.max(T, dt), 1);
      let x = out === 0 ? x0 * (1 - fr) + c.spreadVol * (Wpath[i] - fr * WT) : x0 + (xb - x0) * fr + c.spreadVol * Wpath[i];
      x = Math.max(x, 0);
      Lc = R * Mc / Math.exp(x);
      if (divIdx.has(i)) div += deal.acq_dividend.amount * pos.a;
      const eq = equity + pos.t * (Lc - L0) - pos.a * (Mc - M0) - bor - div;
      peak = Math.max(peak, eq); mdd = Math.max(mdd, (peak - eq) / peak);
      if (i < rIdx && eq < 0.25 * pos.t * Lc + 0.30 * pos.a * Mc) { liq = true; endI = i; break; }
    }
    let Le = Lc, Me = Mc;
    const Sx = s0 * Math.exp(ls), feeV = out === 2 ? (c.feePs || 0) * (1 - tax) : 0, feeMV = out === 2 ? (c.feeAcqPs || 0) * (1 - tax) : 0;
    if (!liq && out === 0) Le = R * Me;
    if (!liq && out > 0) { Le = Sx + feeV; Me = Mc * (1 + j) - feeMV; }
    const slip = liq ? (pos.t * Le + pos.a * Me) * 25 / 1e4 : 0;
    const pnl = pos.t * (Le - L0) - pos.a * (Me - M0) - bor - div - slip;
    res.push({ pnl, out: liq ? 4 : out, years: endI * dt, dd: Math.max(mdd, (peak - (equity + pnl)) / peak) });
    // completion-state acquirer value for the hedge comparison: M0 = p*M_C + (1-p)*E[M_B]
    const kc = Math.max((1 - (1 - pC) * ((1 + j) - wReg * (c.feeAcqPs || 0) * (1 - tax) / M0)) / Math.max(pC, 1e-12), 0.05);
    const dL = (out === 0 ? R * Mc * kc : Sx + feeV) - L0, dM = (out === 0 ? Mc * kc : Mc * (1 + j) - feeMV) - M0;
    unit.push({ dL, dM, carry: (bor + div) / Math.max(pos.a, 1), out });
  }
  const pn = res.map((r) => r.pnl).sort((a, b) => a - b), mean = pn.reduce((a, b) => a + b, 0) / pn.length;
  const q05 = pn[Math.floor(0.05 * pn.length)], tail = pn.filter((v) => v <= q05);
  const meanNet = res.reduce((a, r) => a + r.pnl - (c.finRate || 0) * pos.t * L0 * r.years, 0) / res.length;
  return { res, unit, summary: { n: pn.length, mean, meanNet, median: pn[Math.floor(pn.length / 2)], pLoss: pn.filter((v) => v < 0).length / pn.length,
    var95: -q05, es95: -tail.reduce((a, b) => a + b, 0) / tail.length, pLiq: res.filter((r) => r.out === 4).length / res.length,
    meanYears: res.reduce((a, r) => a + r.years, 0) / res.length } };
}
export function hedgeComparison(unit, L0, M0, R) {
  const dL = unit.map((u) => u.dL), dM = unit.map((u) => u.dM), n = unit.length;
  const mL = dL.reduce((a, b) => a + b, 0) / n, mM = dM.reduce((a, b) => a + b, 0) / n;
  let cov = 0, vM = 0; for (let i = 0; i < n; i++) { cov += (dL[i] - mL) * (dM[i] - mM); vM += (dM[i] - mM) ** 2; }
  const hs = cov / vM;
  return [["ratio-neutral (contract)", R], ["dollar-neutral", L0 / M0], ["variance-minimising", hs], ["unhedged long target", 0]].map(([name, h]) => {
    const p = unit.map((u) => u.dL - h * u.dM - h * u.carry).sort((a, b) => a - b), m = p.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(p.reduce((a, b) => a + (b - m) ** 2, 0) / n), q = p[Math.floor(0.05 * n)], t = p.filter((v) => v <= q);
    return { name, h, mean: m, sd, pLoss: p.filter((v) => v < 0).length / n, es95: -t.reduce((a, b) => a + b, 0) / t.length };
  });
}

// ---------------- parity check against Python (run in the console: (await import('./engine.js')).checkParity(snapshot, parity))
export function checkParity(snap, cases) {
  const deal = { ...snap.deal };
  const rows = [];
  for (const c of cases) {
    const x = c.inputs, js = x.kappa * x.delta / (1 - x.delta), jf = x.delta / (1 - x.delta);
    const s = evaluate(deal, { L: x.L0, M: x.M0, date: snap.as_of, close: deal.expected_close, fee: x.fee, p: x.p, S: x.S, j: js,
      Ss: snap.standalone.stress, js: jf, rf: x.rf, finRate: x.fin, hurdle: 0.05, fresh: true, w: x.w, fL: x.fL, fM: x.fM,
      entry: x.entry, exitB: x.entry, tb: x.tb });
    for (const k of Object.keys(c.signal)) rows.push({ case: x.lots, key: k, py: c.signal[k], js: s.m[k], diff: Math.abs((s.m[k] ?? NaN) - c.signal[k]) });
    rows.push({ case: x.lots, key: "decision", py: c.decision, js: s.decision, diff: c.decision === s.decision ? 0 : 1 });
    const pos = unitsToPosition(x.lots, deal.ratio);
    const specs = defaultScenarios(deal, snap.as_of, deal.ratio * x.M0 / x.L0 - 1, snap.standalone.factor_model, snap.standalone.stress, js, jf, "2027-06-30", x.tax);
    for (const sp of specs) { const r = runScenario(sp, deal, pos, x.equity, x.L0, x.M0, snap.as_of, x.fee); rows.push({ case: x.lots, key: sp.key, py: c.scenarios[sp.key].net_pnl, js: r.net_pnl, diff: Math.abs(r.net_pnl - c.scenarios[sp.key].net_pnl) }); }
    const mu = maxUnits(x.equity, x.L0, x.M0, deal.ratio); rows.push({ case: x.lots, key: "max_units", py: c.max_units, js: mu.units, diff: Math.abs(mu.units - c.max_units) });
  }
  for (const r of rows) if (!Number.isFinite(r.diff)) r.diff = Infinity;   // a missing value is a failure, never a pass
  return { maxDiff: Math.max(...rows.map((r) => r.diff)), worst: rows.sort((a, b) => b.diff - a.diff).slice(0, 5), n: rows.length };
}
