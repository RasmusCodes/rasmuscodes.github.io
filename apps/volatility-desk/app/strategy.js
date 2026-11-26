// Option strategies on one underlying: a Market (curves + vol function, scenario moves as in
// voldesk.strategies.market), legs and presets, Black-76 pricing, desk Greeks, Taylor P&L attribution
// (voldesk.strategies.book.attribute) and historical / hypothetical scenario shocks.
import { blackPrice, blackSens, forwardDelta, bisect, interp } from './math.js';
import { curveNodes } from './models.js';

export const VOL_FLOOR = 1e-4;
export const MULT = 100;

export class Market {
  constructor({ spot, tau, F, D, volFn, t = 0 }) {
    this.spot = spot; this.tau = tau; this.F = F; this.D = D; this.volFn = volFn; this.t = t;
    this.lnF = F.map(Math.log); this.lnD = D.map(Math.log);
  }
  _curve(tau, y0, ys) {
    const xs = this.tau, n = xs.length;
    if (!n) return y0;
    if (tau > xs[n - 1]) return y0 + (ys[n - 1] - y0) / xs[n - 1] * tau;
    if (tau <= 0) return y0;
    let j = 0;
    while (xs[j] < tau) j++;
    const xa = j === 0 ? 0 : xs[j - 1], ya = j === 0 ? y0 : ys[j - 1];
    return ya + (ys[j] - ya) * (tau - xa) / (xs[j] - xa);
  }
  forward(tau) { return Math.exp(this._curve(tau, Math.log(this.spot), this.lnF)); }
  discount(tau) { return Math.exp(this._curve(tau, 0, this.lnD)); }
  iv(K, tau) { return Math.max(this.volFn(Math.log(K / this.forward(tau)), tau), VOL_FLOOR); }
  price(cp, K, tau) { return blackPrice(cp, this.forward(tau), K, tau, this.iv(K, tau), this.discount(tau)); }
  with(patch) { return new Market({ spot: this.spot, tau: this.tau, F: this.F, D: this.D, volFn: this.volFn, t: this.t, ...patch }); }
  /** Index log return x; 'moneyness': the smile moves with the index; 'strike': vols at fixed strikes unchanged. */
  move(x, sticky = 'moneyness') {
    const g = Math.exp(x), f = this.volFn;
    return this.with({ spot: this.spot * g, F: this.F.map((v) => v * g), volFn: sticky === 'strike' ? (k, tau) => f(k + x, tau) : f });
  }
  shiftVol(a) {
    if (!a) return this;
    const f = this.volFn;
    return this.with({ volFn: (k, tau) => Math.max(f(k, tau) + a, VOL_FLOOR) });
  }
  /** Clock advances dt years at an unchanged index: forwards lose dt of carry, the surface keeps its shape in tau. */
  roll(dt) {
    if (!(dt > 0)) return this;
    const keep = this.tau.map((t, i) => i).filter((i) => this.tau[i] > dt + 1e-12);
    if (!keep.length) {
      const n = this.tau.length - 1, T = this.tau[n];
      const carry = Math.log(this.F[n] / this.spot) / T, rate = -Math.log(this.D[n]) / T;
      return this.with({ t: this.t + dt, tau: [1], F: [this.spot * Math.exp(carry)], D: [Math.exp(-rate)] });
    }
    return this.with({
      t: this.t + dt,
      tau: keep.map((i) => this.tau[i] - dt),
      F: keep.map((i) => this.F[i] * Math.exp(-Math.log(this.F[i] / this.spot) / this.tau[i] * dt)),
      D: keep.map((i) => this.D[i] * Math.exp(-Math.log(this.D[i]) / this.tau[i] * dt)),
    });
  }
  scenario({ x = 0, dv = 0, dt = 0, sticky = 'moneyness' } = {}) {
    return this.roll(dt).move(x, sticky).shiftVol(dv);
  }
}

/** Skew tilt: +tilt vol points per 10% of moneyness below the forward, scaled by 1/sqrt(T), capped at 4 units. */
export function tiltTerm(k, T, tilt) {
  if (!tilt) return 0;
  const z = Math.max(-4, Math.min(4, -k / (0.1 * Math.sqrt(Math.max(T, 1e-6)))));
  return tilt / 100 * z;
}
export function shiftedVol(base, k, T, shifts) {
  return base + (shifts.vol || 0) / 100 + tiltTerm(k, T, shifts.tilt || 0);
}

/** Base market of a surface bundle with the top-bar assumptions (vol shift, skew tilt, rate and dividend shifts). */
export function baseMarket(bundle, surface, shifts) {
  const n = curveNodes(bundle);
  const dr = (shifts.rate || 0) / 1e4, dq = (shifts.div || 0) / 1e4;
  return new Market({
    spot: n.spot, tau: n.tau,
    F: n.F.map((f, i) => f * Math.exp((dr - dq) * n.tau[i])),
    D: n.D.map((d, i) => d * Math.exp(-dr * n.tau[i])),
    volFn: (k, tau) => shiftedVol(surface.iv(k, tau), k, tau, shifts),
  });
}

// ------------------------------------------------------------------ legs and presets
export function strikeStep(F) {
  return F >= 800 ? 5 : F >= 25 ? 1 : 0.5;
}
export const roundStrike = (K, F) => Math.max(strikeStep(F), Math.round(K / strikeStep(F)) * strikeStep(F));

/** Strike for a target: mode 'K' (strike), 'pct' (% of the expiry's forward), 'delta' (|forward delta| in %). */
export function solveStrike(mode, target, cp, T, mkt) {
  const F = mkt.forward(T);
  if (mode === 'K') return target;
  if (mode === 'pct') return roundStrike(F * target / 100, F);
  const atm = mkt.iv(F, T), sd = atm * Math.sqrt(T);
  const tgt = Math.max(0.5, Math.min(99.5, target)) / 100;
  const f = (k) => Math.abs(forwardDelta(cp, F, F * Math.exp(k), T, mkt.iv(F * Math.exp(k), T))) - tgt;
  const k = bisect(f, -8 * sd - 0.05, 8 * sd + 0.05, 70);
  return roundStrike(F * Math.exp(k), F);
}

let legId = 0;
export const newLeg = (p) => ({ id: ++legId, side: 1, qty: 1, cp: 1, exp: 0, mode: 'pct', target: 100, K: NaN, ...p });

export const PRESETS = [
  { id: 'long_straddle', name: 'Long straddle (ATM)', legs: [{ side: 1, cp: 1, mode: 'pct', target: 100 }, { side: 1, cp: -1, mode: 'pct', target: 100 }] },
  { id: 'short_straddle', name: 'Short straddle (ATM)', legs: [{ side: -1, cp: 1, mode: 'pct', target: 100 }, { side: -1, cp: -1, mode: 'pct', target: 100 }] },
  { id: 'long_strangle', name: 'Long strangle (25Δ)', legs: [{ side: 1, cp: -1, mode: 'delta', target: 25 }, { side: 1, cp: 1, mode: 'delta', target: 25 }] },
  { id: 'short_strangle', name: 'Short strangle (25Δ)', legs: [{ side: -1, cp: -1, mode: 'delta', target: 25 }, { side: -1, cp: 1, mode: 'delta', target: 25 }] },
  { id: 'bull_call', name: 'Call vertical (long 100% / short 105%)', legs: [{ side: 1, cp: 1, mode: 'pct', target: 100 }, { side: -1, cp: 1, mode: 'pct', target: 105 }] },
  { id: 'bear_put', name: 'Put vertical (long 100% / short 95%)', legs: [{ side: 1, cp: -1, mode: 'pct', target: 100 }, { side: -1, cp: -1, mode: 'pct', target: 95 }] },
  { id: 'put_spread', name: 'Put spread (short 25Δ / long 10Δ)', legs: [{ side: -1, cp: -1, mode: 'delta', target: 25 }, { side: 1, cp: -1, mode: 'delta', target: 10 }] },
  { id: 'risk_reversal', name: 'Risk reversal (long 25Δ call / short 25Δ put)', legs: [{ side: 1, cp: 1, mode: 'delta', target: 25 }, { side: -1, cp: -1, mode: 'delta', target: 25 }] },
  { id: 'butterfly', name: 'Call butterfly (95 / 100 / 105%)', legs: [{ side: 1, cp: 1, mode: 'pct', target: 95 }, { side: -1, qty: 2, cp: 1, mode: 'pct', target: 100 }, { side: 1, cp: 1, mode: 'pct', target: 105 }] },
  { id: 'iron_condor', name: 'Iron condor (short 25Δ, long 10Δ wings)', legs: [{ side: 1, cp: -1, mode: 'delta', target: 10 }, { side: -1, cp: -1, mode: 'delta', target: 25 }, { side: -1, cp: 1, mode: 'delta', target: 25 }, { side: 1, cp: 1, mode: 'delta', target: 10 }] },
  { id: 'calendar', name: 'Calendar (short near / long far ATM call)', legs: [{ side: -1, cp: 1, mode: 'pct', target: 100 }, { side: 1, cp: 1, mode: 'K', far: true, sameStrikeAs: 0 }] },
  { id: 'diagonal', name: 'Diagonal (short near 25Δ / long far 50Δ call)', legs: [{ side: -1, cp: 1, mode: 'delta', target: 25 }, { side: 1, cp: 1, mode: 'delta', target: 50, far: true }] },
  { id: 'long_call', name: 'Long call (ATM)', legs: [{ side: 1, cp: 1, mode: 'pct', target: 100 }] },
  { id: 'long_put', name: 'Long put (ATM)', legs: [{ side: 1, cp: -1, mode: 'pct', target: 100 }] },
  { id: 'short_call', name: 'Short call (25Δ)', legs: [{ side: -1, cp: 1, mode: 'delta', target: 25 }] },
  { id: 'short_put', name: 'Short put (25Δ)', legs: [{ side: -1, cp: -1, mode: 'delta', target: 25 }] },
];

/** Default near expiry: the listed expiry closest to 30 days (at least 7); far: closest to near + 60 days. */
export function defaultNear(expiries) {
  let best = 0, bd = Infinity;
  expiries.forEach((e, i) => { const d = Math.abs(e.T * 365 - 30) + (e.T * 365 < 7 ? 1e3 : 0); if (d < bd) { bd = d; best = i; } });
  return best;
}
export function farIndex(expiries, near) {
  let best = Math.min(near + 1, expiries.length - 1), bd = Infinity;
  expiries.forEach((e, i) => { if (i <= near) return; const d = Math.abs(e.T - expiries[near].T - 60 / 365); if (d < bd) { bd = d; best = i; } });
  return best;
}

export function applyPreset(id, expiries, near, mkt) {
  const p = PRESETS.find((x) => x.id === id) || PRESETS[0];
  const far = farIndex(expiries, near);
  const legs = [];
  for (const L of p.legs) {
    const leg = newLeg({ side: L.side, qty: L.qty || 1, cp: L.cp, exp: L.far ? far : near, mode: L.mode, target: L.target });
    if (L.sameStrikeAs != null) { leg.K = legs[L.sameStrikeAs].K; leg.target = leg.K; leg.mode = 'K'; } else leg.K = solveStrike(leg.mode, leg.target, leg.cp, expiries[leg.exp].T, mkt);
    legs.push(leg);
  }
  return legs;
}

// ------------------------------------------------------------------ valuation, Greeks, attribution
/** State of one leg in a market: tau, F, D, vol, Black value and sensitivities (null sens when expired). */
export function legState(leg, T, mkt) {
  const tau = T - mkt.t;
  const q = leg.side * leg.qty * MULT;
  if (tau <= 1e-10) {
    const value = Math.max(leg.cp * (mkt.spot - leg.K), 0);
    return { tau, q, value, expired: true };
  }
  const F = mkt.forward(tau), D = mkt.discount(tau), vol = mkt.iv(leg.K, tau);
  const sens = blackSens(leg.cp, F, leg.K, tau, vol, D);
  return { tau, q, F, D, vol, k: Math.log(leg.K / F), value: sens.value, sens, fwdDelta: forwardDelta(leg.cp, F, leg.K, tau, vol) };
}

export function deskGreeks(st, S) {
  if (!st.sens) return { delta: 0, delta1: 0, gamma1: 0, vega1: 0, theta1: 0, vanna1: 0, volga1: 0 };
  const { q, F, sens: b } = st;
  return {
    delta: q * b.dF * F / S,
    delta1: q * b.dF * F / 100,
    gamma1: q * 0.5 * b.dFF * F * F / 1e4,
    vega1: q * b.ds / 100,
    theta1: -q * b.dtau / 365,
    vanna1: q * b.dFs * F / 1e4,
    volga1: q * 0.5 * b.dss / 1e4,
  };
}

export function portfolio(legs, expiries, mkt) {
  const states = legs.map((g) => legState(g, expiries[g.exp].T, mkt));
  const tot = { value: 0, delta: 0, delta1: 0, gamma1: 0, vega1: 0, theta1: 0, vanna1: 0, volga1: 0 };
  states.forEach((st) => {
    tot.value += st.q * st.value;
    const g = deskGreeks(st, mkt.spot);
    for (const k of Object.keys(g)) tot[k] += g[k];
  });
  return { ...tot, states };
}

export const valueOf = (legs, expiries, mkt) => legs.reduce((a, g) => a + legState(g, expiries[g.exp].T, mkt).q * legState(g, expiries[g.exp].T, mkt).value, 0);

export const TERMS = ['delta', 'gamma', 'vega', 'vanna', 'volga', 'theta', 'rates'];

/** Second-order Taylor attribution of the value change m0 -> m1 in each leg's F, vol, tau and D. */
export function attribute(legs, expiries, m0, m1) {
  const perLeg = legs.map((g) => {
    const T = expiries[g.exp].T;
    const out = Object.fromEntries(TERMS.map((t) => [t, 0]));
    const a = legState(g, T, m0), b = legState(g, T, m1);
    const k = a.q;
    const actual = k * (b.value - a.value);
    if (!a.expired && !b.expired) {
      const s = a.sens, dF = b.F - a.F, ds = b.vol - a.vol, dt = b.tau - a.tau, dD = b.D - a.D;
      out.delta = k * s.dF * dF;
      out.gamma = k * 0.5 * s.dFF * dF * dF;
      out.vega = k * s.ds * ds;
      out.vanna = k * s.dFs * dF * ds;
      out.volga = k * 0.5 * s.dss * ds * ds;
      out.theta = k * s.dtau * dt;
      out.rates = k * s.dD * dD;
    }
    out.residual = actual - TERMS.reduce((acc, t) => acc + out[t], 0);
    out.total = actual;
    return out;
  });
  const total = Object.fromEntries([...TERMS, 'residual', 'total'].map((t) => [t, perLeg.reduce((a, r) => a + r[t], 0)]));
  return { total, perLeg };
}

// ------------------------------------------------------------------ historical / hypothetical scenarios
const TENORS = [10, 30, 91, 182, 365];
export function atmShock(change, days) {
  const xs = [], ys = [];
  for (const t of TENORS) { const v = change?.[String(t)]; if (Number.isFinite(v)) { xs.push(t); ys.push(v); } }
  return xs.length ? interp(days, xs, ys) : 0;
}
export function skewShock(change, days) {
  const xs = [], ys = [];
  if (Number.isFinite(change?.skew30)) { xs.push(30); ys.push(change.skew30); }
  if (Number.isFinite(change?.skew91)) { xs.push(91); ys.push(change.skew91); }
  return xs.length ? interp(days, xs, ys) : 0;
}

/** Apply a scenario (spot return, ATM-vol change by tenor, put-skew change) to the legs; returns P&L in dollars. */
export function scenarioPnl(legs, expiries, m0, sc) {
  const minT = Math.min(...legs.map((g) => expiries[g.exp].T));
  const dtDays = Math.max(0, Math.min(sc.days ?? 0, minT * 365 - 1));
  const r = Number.isFinite(sc.spot_return) ? sc.spot_return : 0;
  const m1 = m0.roll(dtDays / 365).move(Math.log(1 + r), 'moneyness');
  let pnl = 0;
  for (const g of legs) {
    const T = expiries[g.exp].T;
    const a = legState(g, T, m0);
    const tau1 = T - m1.t;
    let v1;
    if (tau1 <= 1e-10) v1 = Math.max(g.cp * (m1.spot - g.K), 0);
    else {
      const F1 = m1.forward(tau1), D1 = m1.discount(tau1);
      const base = m1.iv(g.K, tau1), atm = m1.iv(F1, tau1);
      const days = tau1 * 365;
      const k1 = Math.log(g.K / F1);
      const z = Math.min(2, Math.max(0, -k1) / (0.674 * atm * Math.sqrt(tau1)));
      const s1 = Math.max(base + atmShock(sc.atm_change, days) + skewShock(sc.skew_change, days) * z, VOL_FLOOR);
      v1 = blackPrice(g.cp, F1, g.K, tau1, s1, D1);
    }
    pnl += a.q * (v1 - a.value);
  }
  return { pnl, dtDays };
}
