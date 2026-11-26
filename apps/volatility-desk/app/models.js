// Implied-volatility surface models rebuilt from fitted parameters (same formulas and interpolation as the
// Python library: voldesk.surface.svi / sabr / heston / compare), forward and discount curves, quoted ranges.
import { impliedVolBlack, interp, cadd, csub, cmul, cdiv, csqrt, clog, cexp, cscale } from './math.js';

export const MODEL_KEYS = ['svi', 'essvi', 'ssvi', 'sabr', 'heston'];
export const MODEL_LABELS = { svi: 'SVI', essvi: 'eSSVI', ssvi: 'SSVI', sabr: 'SABR', heston: 'Heston' };
export const MODEL_BLURB = {
  svi: 'Raw SVI per expiry (5 parameters), butterfly constraints imposed on a wide grid; slices joined linearly in total variance.',
  essvi: 'Extended SSVI: one (theta, rho, psi) per expiry with closed-form no-arbitrage constraints; free of static arbitrage by construction.',
  ssvi: 'Power-law SSVI: three global parameters plus the ATM total-variance curve; arbitrage-free by construction, least flexible.',
  sabr: 'SABR (beta = 1) per expiry via the Hagan et al. lognormal approximation; slices joined linearly in total variance.',
  heston: 'Heston stochastic volatility: five parameters for the whole surface, priced by the COS method and inverted to Black vols.',
};

// ------------------------------------------------------------------ slice total-variance functions
export function sviW(p, k) {
  const x = k - p.m;
  return p.a + p.b * (p.rho * x + Math.sqrt(x * x + p.s * p.s));
}
export function ssviW(k, theta, rho, phi) {
  const q = phi * k + rho;
  return theta / 2 * (1 + rho * phi * k + Math.sqrt(q * q + 1 - rho * rho));
}
export function essviW(p, k) {
  return ssviW(k, p.theta, p.rho, p.psi / p.theta);
}
/** Hagan et al. (2002) lognormal SABR vol at log-moneyness k with F = 1, K = e^k (as the Python bundle code). */
export function sabrIv(p, k) {
  const beta = p.beta ?? 1;
  const ob = 1 - beta;
  const L = -k;
  const fkb = Math.exp(k * ob / 2);
  const denom = fkb * (1 + ob * ob / 24 * L * L + ob ** 4 / 1920 * L ** 4);
  const z = p.nu / p.alpha * fkb * L;
  let zx;
  if (Math.abs(z) < 1e-7) zx = 1 - p.rho * z / 2;
  else zx = z / Math.log((Math.sqrt(1 - 2 * p.rho * z + z * z) + z - p.rho) / (1 - p.rho));
  const corr = 1 + (ob * ob / 24 * p.alpha * p.alpha / (fkb * fkb) + p.rho * beta * p.nu * p.alpha / (4 * fkb)
    + (2 - 3 * p.rho * p.rho) / 24 * p.nu * p.nu) * p.T;
  return p.alpha / denom * zx * corr;
}

// ------------------------------------------------------------------ surfaces
/** Per-slice total variance joined linearly in T at fixed k; w scales with T before the first / after the last slice. */
class SliceSurface {
  constructor(key, Ts, wfs) {
    const o = Ts.map((T, i) => i).sort((i, j) => Ts[i] - Ts[j]);
    this.key = key;
    this.Ts = o.map((i) => Ts[i]);
    this.wf = o.map((i) => wfs[i]);
  }
  w(k, T) {
    const Ts = this.Ts, n = Ts.length;
    if (T <= Ts[0]) return this.wf[0](k) * T / Ts[0];
    if (T >= Ts[n - 1]) return this.wf[n - 1](k) * T / Ts[n - 1];
    let j = 1;
    while (Ts[j] < T) j++;
    const i = j - 1;
    const lam = (T - Ts[i]) / (Ts[j] - Ts[i]);
    return (1 - lam) * this.wf[i](k) + lam * this.wf[j](k);
  }
  iv(k, T) {
    return Math.sqrt(Math.max(this.w(k, T), 0) / T);
  }
  ivs(ks, T) {
    const out = new Float64Array(ks.length);
    for (let i = 0; i < ks.length; i++) out[i] = this.iv(ks[i], T);
    return out;
  }
}

class SSVISurface {
  constructor(m) {
    const o = m.Ts.map((T, i) => i).sort((i, j) => m.Ts[i] - m.Ts[j]);
    this.key = 'ssvi';
    this.Ts = o.map((i) => m.Ts[i]);
    this.thetas = o.map((i) => m.thetas[i]);
    this.rho = m.rho; this.eta = m.eta; this.gamma = m.gamma;
  }
  theta(T) {
    const Ts = this.Ts, th = this.thetas, n = Ts.length;
    if (T <= Ts[0]) return th[0] * T / Ts[0];
    if (T >= Ts[n - 1]) return th[n - 1] * T / Ts[n - 1];
    return interp(T, Ts, th);
  }
  phi(theta) {
    return this.eta * theta ** (-this.gamma) * (1 + theta) ** (this.gamma - 1);
  }
  w(k, T) {
    const th = this.theta(T);
    return ssviW(k, th, this.rho, this.phi(th));
  }
  iv(k, T) {
    return Math.sqrt(Math.max(this.w(k, T), 0) / T);
  }
  ivs(ks, T) {
    const th = this.theta(T), ph = this.phi(th);
    const out = new Float64Array(ks.length);
    for (let i = 0; i < ks.length; i++) out[i] = Math.sqrt(Math.max(ssviW(ks[i], th, this.rho, ph), 0) / T);
    return out;
  }
}

/** Characteristic function of ln(S_T/F_T) under Heston, "little trap" form. */
export function hestonCf(u, T, p) {
  const s2 = p.sigma * p.sigma;
  const a = { re: p.kappa, im: -p.rho * p.sigma * u };
  const d = csqrt(cadd(cmul(a, a), { re: s2 * u * u, im: s2 * u }));
  const amd = csub(a, d);
  const g = cdiv(amd, cadd(a, d));
  const e = cexp(cscale(d, -T));
  const one = { re: 1, im: 0 };
  const omge = csub(one, cmul(g, e));
  const C = cscale(csub(cscale(amd, T), cscale(clog(cdiv(omge, csub(one, g))), 2)), p.kappa * p.theta / s2);
  const Dv = cmul(cscale(amd, 1 / s2), cdiv(csub(one, e), omge));
  return cexp(cadd(C, cscale(Dv, p.v0)));
}

class HestonSurface {
  constructor(m, N = 1024, L = 12) {
    this.key = 'heston';
    this.p = { v0: m.v0, kappa: m.kappa, theta: m.theta, sigma: m.sigma, rho: m.rho };
    this.N = N; this.L = L;
    this.cache = new Map();
  }
  _prep(T) {
    let c = this.cache.get(T);
    if (c) return c;
    const p = this.p, N = this.N;
    const meanVar = p.theta * T + (p.v0 - p.theta) * (1 - Math.exp(-p.kappa * T)) / p.kappa;
    const sd = Math.sqrt(Math.max(meanVar, 1e-12)) * (1 + p.sigma);
    const a = -0.5 * meanVar - this.L * sd, b = -0.5 * meanVar + this.L * sd;
    const du = Math.PI / (b - a);
    const phRe = new Float64Array(N), phIm = new Float64Array(N), V = new Float64Array(N);
    const ea = Math.exp(a);
    for (let j = 0; j < N; j++) {
      const u = j * du;
      const ph = hestonCf(u, T, p);
      phRe[j] = ph.re; phIm[j] = ph.im;
      // chi, psi on [c, d] = [a, 0]
      const chi = (Math.cos(-u * a) - ea + u * Math.sin(-u * a)) / (1 + u * u);
      const psi = j === 0 ? -a : Math.sin(-u * a) / u;
      V[j] = 2 / (b - a) * (psi - chi);
    }
    V[0] *= 0.5;
    c = { a, b, du, phRe, phIm, V };
    if (this.cache.size > 400) this.cache.clear();
    this.cache.set(T, c);
    return c;
  }
  /** OTM Heston price (F = 1, D = 1) at log-moneyness k: put if k < 0, call otherwise. */
  otmPrice(k, T) {
    const { a, du, phRe, phIm, V } = this._prep(T);
    const N = this.N;
    const th1 = du * (-k - a);
    const c1 = Math.cos(th1), s1 = Math.sin(th1);
    let zr = 1, zi = 0, sum = 0;
    for (let j = 0; j < N; j++) {
      if (j > 0) {
        if ((j & 63) === 0) { zr = Math.cos(j * th1); zi = Math.sin(j * th1); } else {
          const nr = zr * c1 - zi * s1;
          zi = zr * s1 + zi * c1;
          zr = nr;
        }
      }
      sum += (phRe[j] * zr - phIm[j] * zi) * V[j];
    }
    const K = Math.exp(k);
    const put = Math.max(K * sum, Math.max(K - 1, 0));
    return k >= 0 ? put + (1 - K) : put;
  }
  iv(k, T) {
    const K = Math.exp(k);
    return impliedVolBlack(this.otmPrice(k, T), k >= 0 ? 1 : -1, 1, K, T, 1);
  }
  ivs(ks, T) {
    const out = new Float64Array(ks.length);
    for (let i = 0; i < ks.length; i++) out[i] = this.iv(ks[i], T);
    return out;
  }
}

const finite = (...v) => v.every((x) => typeof x === 'number' && Number.isFinite(x));

/** Surface object {key, iv(k, T), ivs(ks, T)} for a model of a surface bundle, or null if unavailable. */
export function buildSurface(bundle, key) {
  const m = bundle?.models?.[key];
  if (!m) return null;
  try {
    if (key === 'svi' || key === 'essvi' || key === 'sabr') {
      const sl = (m.slices || []).filter((s) => finite(s.T) && s.T > 0);
      if (!sl.length) return null;
      let wfs;
      if (key === 'svi') {
        if (!sl.every((s) => finite(s.a, s.b, s.rho, s.m, s.s))) return null;
        wfs = sl.map((s) => (k) => sviW(s, k));
      } else if (key === 'essvi') {
        if (!sl.every((s) => finite(s.theta, s.rho, s.psi) && s.theta > 0)) return null;
        wfs = sl.map((s) => (k) => essviW(s, k));
      } else {
        if (!sl.every((s) => finite(s.alpha, s.rho, s.nu))) return null;
        wfs = sl.map((s) => (k) => { const v = sabrIv(s, k); return v * v * s.T; });
      }
      return new SliceSurface(key, sl.map((s) => s.T), wfs);
    }
    if (key === 'ssvi') {
      if (!(Array.isArray(m.Ts) && Array.isArray(m.thetas) && m.Ts.length && m.Ts.length === m.thetas.length
        && finite(m.rho, m.eta, m.gamma))) return null;
      return new SSVISurface(m);
    }
    if (key === 'heston') {
      if (!finite(m.v0, m.kappa, m.theta, m.sigma, m.rho) || m.sigma <= 0 || m.kappa <= 0) return null;
      return new HestonSurface(m);
    }
  } catch (e) {
    console.warn('voldesk: could not build', key, e);
  }
  return null;
}

export function buildAllSurfaces(bundle) {
  const out = {};
  for (const k of MODEL_KEYS) {
    const s = buildSurface(bundle, k);
    if (s) out[k] = s;
  }
  return out;
}

// ------------------------------------------------------------------ curves and quoted ranges
/** Node arrays of the forward and discount curves (sorted by T). */
export function curveNodes(bundle) {
  const ex = [...bundle.expiries].filter((e) => finite(e.T, e.F, e.D) && e.T > 0).sort((a, b) => a.T - b.T);
  return { spot: bundle.spot, tau: ex.map((e) => e.T), F: ex.map((e) => e.F), D: ex.map((e) => e.D) };
}

/** Quoted log-moneyness range at maturity T, interpolated linearly across expiries (flat outside). */
export function quotedRange(bundle, T) {
  const ex = bundle.expiries.filter((e) => finite(e.T, e.k_min, e.k_max));
  if (!ex.length) return [-0.2, 0.1];
  const Ts = ex.map((e) => e.T);
  return [interp(T, Ts, ex.map((e) => e.k_min)), interp(T, Ts, ex.map((e) => e.k_max))];
}

export function daysLabel(T) {
  const d = T * 365;
  if (d < 60) return `${Math.round(d)}d`;
  if (d < 350) return `${Math.round(d / 30.4)}m`;
  return `${(d / 365).toFixed(d < 3 * 365 ? 1 : 0)}y`;
}
