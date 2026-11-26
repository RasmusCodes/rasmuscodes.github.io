// Numerical core: error functions (W. J. Cody's rational approximations), the normal distribution,
// Black-76 prices and sensitivities, Black implied volatility (normalised Halley solver, a port of
// voldesk.pricing.implied_vol) and small complex-number helpers (principal branches).

export const SQRT2 = Math.SQRT2;
export const SQRT2PI = Math.sqrt(2 * Math.PI);
export const EPS = 2.220446049250313e-16;
const SQRPI = 5.6418958354775628695e-1; // 1/sqrt(pi)

// ---------------------------------------------------------------------------------------------
// Cody (1969, 1993) CALERF: erf (jint 0), erfc (jint 1), erfcx = exp(x^2) erfc(x) (jint 2)
// ---------------------------------------------------------------------------------------------
const A = [3.16112374387056560e00, 1.13864154151050156e02, 3.77485237685302021e02, 3.20937758913846947e03,
  1.85777706184603153e-1];
const B = [2.36012909523441209e01, 2.44024637934444173e02, 1.28261652607737228e03, 2.84423683343917062e03];
const C = [5.64188496988670089e-1, 8.88314979438837594e00, 6.61191906371416295e01, 2.98635138197400131e02,
  8.81952221241769090e02, 1.71204761263407058e03, 2.05107837782607147e03, 1.23033935479799725e03,
  2.15311535474403846e-8];
const D = [1.57449261107098347e01, 1.17693950891312499e02, 5.37181101862009858e02, 1.62138957456669019e03,
  3.29079923573345963e03, 4.36261909014324716e03, 3.43936767414372164e03, 1.23033935480374942e03];
const P = [3.05326634961232344e-1, 3.60344899949804439e-1, 1.25781726111229246e-1, 1.60837851487422766e-2,
  6.58749161529837803e-4, 1.63153871373020978e-2];
const Q = [2.56852019228982242e00, 1.87295284992346725e00, 5.27905102951428412e-1, 6.05183413124413191e-2,
  2.33520497626869185e-3];
const XNEG = -26.628, XSMALL = 1.11e-16, XBIG = 26.543, XHUGE = 6.71e7, XMAX = 2.53e307;

function calerf(x, jint) {
  const y = Math.abs(x);
  let result, ysq, xnum, xden;
  if (y <= 0.46875) {
    ysq = y > XSMALL ? y * y : 0;
    xnum = A[4] * ysq;
    xden = ysq;
    for (let i = 0; i < 3; i++) {
      xnum = (xnum + A[i]) * ysq;
      xden = (xden + B[i]) * ysq;
    }
    result = x * (xnum + A[3]) / (xden + B[3]);
    if (jint !== 0) result = 1 - result;
    if (jint === 2) result = Math.exp(ysq) * result;
    return result;
  }
  if (y <= 4) {
    xnum = C[8] * y;
    xden = y;
    for (let i = 0; i < 7; i++) {
      xnum = (xnum + C[i]) * y;
      xden = (xden + D[i]) * y;
    }
    result = (xnum + C[7]) / (xden + D[7]);
    if (jint !== 2) {
      ysq = Math.trunc(y * 16) / 16;
      const del = (y - ysq) * (y + ysq);
      result = Math.exp(-ysq * ysq) * Math.exp(-del) * result;
    }
  } else {
    result = 0;
    let skip = false;
    if (y >= XBIG) {
      if (jint !== 2 || y >= XMAX) skip = true;
      else if (y >= XHUGE) { result = SQRPI / y; skip = true; }
    }
    if (!skip) {
      ysq = 1 / (y * y);
      xnum = P[5] * ysq;
      xden = ysq;
      for (let i = 0; i < 4; i++) {
        xnum = (xnum + P[i]) * ysq;
        xden = (xden + Q[i]) * ysq;
      }
      result = ysq * (xnum + P[4]) / (xden + Q[4]);
      result = (SQRPI - result) / y;
      if (jint !== 2) {
        ysq = Math.trunc(y * 16) / 16;
        const del = (y - ysq) * (y + ysq);
        result = Math.exp(-ysq * ysq) * Math.exp(-del) * result;
      }
    }
  }
  // fix-up for negative arguments
  if (jint === 0) {
    result = (0.5 - result) + 0.5;
    if (x < 0) result = -result;
  } else if (jint === 1) {
    if (x < 0) result = 2 - result;
  } else if (x < 0) {
    if (x < XNEG) result = Infinity;
    else {
      ysq = Math.trunc(x * 16) / 16;
      const del = (x - ysq) * (x + ysq);
      const yy = Math.exp(ysq * ysq) * Math.exp(del);
      result = (yy + yy) - result;
    }
  }
  return result;
}

export const erf = (x) => calerf(x, 0);
export const erfc = (x) => calerf(x, 1);
export const erfcx = (x) => calerf(x, 2);

export function normCdf(x) {
  return 0.5 * erfc(-x / SQRT2);
}
export function normPdf(x) {
  return Math.exp(-0.5 * x * x) / SQRT2PI;
}

/** Inverse error function: Winitzki start, then Halley steps on erf(x) - y (Cody erf). */
export function erfinv(y) {
  if (!(y > -1 && y < 1)) return y === 1 ? Infinity : y === -1 ? -Infinity : NaN;
  if (y === 0) return 0;
  const a = 0.147;
  const ln = Math.log((1 - y) * (1 + y));
  const t = 2 / (Math.PI * a) + ln / 2;
  let x = Math.sign(y) * Math.sqrt(Math.sqrt(t * t - ln / a) - t);
  for (let i = 0; i < 4; i++) {
    const f = erf(x) - y;
    const fp = 2 / Math.sqrt(Math.PI) * Math.exp(-x * x);
    const step = f / (fp + x * f);
    x -= step;
    if (Math.abs(step) <= 1e-17 * Math.abs(x)) break;
  }
  return x;
}

// ---------------------------------------------------------------------------------------------
// Black-76 (normalised form, as voldesk.pricing.bsm)
// ---------------------------------------------------------------------------------------------
/** c(x, s) = e^{x/2} N(x/s + s/2) - e^{-x/2} N(x/s - s/2) for x <= 0: the normalised OTM value. */
export function otmNormalized(x, s) {
  if (!(s > 0)) return 0;
  const d1 = x / s + 0.5 * s;
  const d2 = d1 - s;
  let res;
  if (d1 < -1) {
    const pref = 0.5 * Math.exp(-0.5 * (x / s) * (x / s) - 0.125 * s * s);
    res = pref * (erfcx(-d1 / SQRT2) - erfcx(-d2 / SQRT2));
  } else {
    res = Math.exp(0.5 * x) * normCdf(d1) - Math.exp(-0.5 * x) * normCdf(d2);
  }
  return Math.max(res, 0);
}

export function normalizedBlack(x, s, th) {
  const intrinsic = Math.max(th * 2 * Math.sinh(0.5 * x), 0);
  return intrinsic + otmNormalized(-Math.abs(x), s);
}

/** Black-76 price; cp = +1 call / -1 put. T <= 0 or sigma = 0 gives the discounted intrinsic value. */
export function blackPrice(cp, F, K, T, sigma, Df = 1) {
  if (!(F > 0 && K > 0 && T >= 0 && sigma >= 0 && Df > 0)) return NaN;
  const x = Math.log(F / K);
  const s = sigma * Math.sqrt(Math.max(T, 0));
  return Df * Math.sqrt(F * K) * normalizedBlack(x, s, cp);
}

/** Value and derivatives in F, sigma, tau (fixed F and D) and D: keys as voldesk.strategies.book.black_sensitivities. */
export function blackSens(cp, F, K, tau, sigma, Df) {
  const sq = Math.sqrt(tau);
  const v = sigma * sq;
  const d1 = Math.log(F / K) / v + 0.5 * v;
  const d2 = d1 - v;
  const n = normPdf(d1);
  const value = blackPrice(cp, F, K, tau, sigma, Df);
  const ds = Df * F * n * sq;
  return {
    value,
    dF: Df * cp * normCdf(cp * d1),
    dFF: Df * n / (F * v),
    ds,
    dtau: Df * F * n * sigma / (2 * sq),
    dFs: -Df * n * d2 / sigma,
    dss: ds * d1 * d2 / sigma,
    dD: value / Df,
    d1,
    d2,
  };
}

/** Forward delta (undiscounted) of a call/put at vol sigma. */
export function forwardDelta(cp, F, K, tau, sigma) {
  const v = sigma * Math.sqrt(tau);
  const d1 = Math.log(F / K) / v + 0.5 * v;
  return cp * normCdf(cp * d1);
}

// ---------------------------------------------------------------------------------------------
// Implied volatility (port of voldesk.pricing.implied_vol: normalised, bracketed Halley)
// ---------------------------------------------------------------------------------------------
function solveOtm(x, tv, maxIter) {
  const lnb = Math.log(tv);
  const sc = Math.sqrt(-2 * x);
  const upper = tv >= otmNormalized(x, sc);
  let lo = upper ? sc : -x / Math.sqrt(-2 * lnb);
  let hi = upper ? Infinity : sc;
  if (upper) {
    let h = Math.max(2 * sc, sc + 1);
    let need = true;
    for (let i = 0; i < 60; i++) {
      need = otmNormalized(x, h) <= tv;
      if (!need) break;
      h *= 2;
    }
    hi = h;
    if (need) return NaN;
  }
  const sh = Math.sinh(0.5 * x), ch = Math.cosh(0.5 * x);
  const a = tv - sh;
  const sCm = SQRT2PI / (2 * ch) * (a + Math.sqrt(Math.max(a * a - 4 * sh * sh / Math.PI, 0)));
  let s = (Number.isFinite(sCm) && sCm > lo && sCm < hi) ? sCm : (upper ? 0.5 * (lo + hi) : lo);
  for (let it = 0; it < maxIter; it++) {
    const c = otmNormalized(x, s);
    const g = Math.log(c) - lnb;
    const vega = Math.exp(-0.5 * (x / s) * (x / s) - 0.125 * s * s) / SQRT2PI;
    const g1 = vega / c;
    const g2 = g1 * (x * x / (s * s * s) - 0.25 * s) - g1 * g1;
    const newton = -g / g1;
    const den = 1 + 0.5 * newton * g2 / g1;
    const step = (Number.isFinite(den) && den > 0.5) ? newton / den : newton;
    const loA = g < 0 ? Math.max(lo, s) : lo;
    const hiA = g > 0 ? Math.min(hi, s) : hi;
    const sNew = s + step;
    const out = !Number.isFinite(sNew) || sNew <= loA || sNew >= hiA;
    let sNext = out ? 0.5 * (loA + hiA) : sNew;
    const smallRes = Math.abs(g) <= 32 * EPS;
    if (smallRes && Number.isFinite(sNew) && sNew > 0) sNext = sNew;
    const conv = smallRes || (!out && Math.abs(step) <= 2 ** -40 * s) || (hiA - loA <= 2 ** -50 * hiA);
    s = sNext; lo = loA; hi = hiA;
    if (conv) return s;
  }
  return NaN;
}

/** Black-76 implied vol of a European price (NaN where none fits; 0 at intrinsic value). */
export function impliedVolBlack(price, cp, F, K, T, Df = 1, maxIter = 50) {
  if (!(Number.isFinite(price) && F > 0 && K > 0 && T > 0 && Df > 0)) return NaN;
  const x = Math.log(F / K);
  const beta = price / (Df * Math.sqrt(F * K));
  const intrinsic = Math.max(cp * 2 * Math.sinh(0.5 * x), 0);
  const tv = beta - intrinsic;
  const ax = -Math.abs(x);
  const tolInt = 4 * EPS * (intrinsic + Math.abs(beta));
  if (tv < -tolInt) return NaN;
  if (tv <= tolInt) return 0;
  if (tv >= Math.exp(0.5 * ax)) return NaN;
  const s = ax === 0 ? 2 * SQRT2 * erfinv(tv) : solveOtm(ax, tv, maxIter);
  return s / Math.sqrt(T);
}

// ---------------------------------------------------------------------------------------------
// Complex numbers as {re, im}; principal branches of sqrt and log (as numpy)
// ---------------------------------------------------------------------------------------------
export const cx = (re, im = 0) => ({ re, im });
export const cadd = (a, b) => ({ re: a.re + b.re, im: a.im + b.im });
export const csub = (a, b) => ({ re: a.re - b.re, im: a.im - b.im });
export const cmul = (a, b) => ({ re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re });
export const cscale = (a, k) => ({ re: a.re * k, im: a.im * k });
export function cdiv(a, b) {
  // Smith's algorithm (avoids overflow)
  if (Math.abs(b.re) >= Math.abs(b.im)) {
    const r = b.im / b.re, den = b.re + b.im * r;
    return { re: (a.re + a.im * r) / den, im: (a.im - a.re * r) / den };
  }
  const r = b.re / b.im, den = b.re * r + b.im;
  return { re: (a.re * r + a.im) / den, im: (a.im * r - a.re) / den };
}
export function csqrt(a) {
  const { re, im } = a;
  if (re === 0 && im === 0) return { re: 0, im: im };
  const r = Math.hypot(re, im);
  if (re >= 0) {
    const t = Math.sqrt(0.5 * (r + re));
    return { re: t, im: im / (2 * t) };
  }
  const t = Math.sqrt(0.5 * (r - re));
  const sgn = (im < 0 || Object.is(im, -0)) ? -1 : 1;
  return { re: Math.abs(im) / (2 * t), im: sgn * t };
}
export const clog = (a) => ({ re: Math.log(Math.hypot(a.re, a.im)), im: Math.atan2(a.im, a.re) });
export function cexp(a) {
  const e = Math.exp(a.re);
  return { re: e * Math.cos(a.im), im: e * Math.sin(a.im) };
}

// ---------------------------------------------------------------------------------------------
// Small numeric utilities
// ---------------------------------------------------------------------------------------------
/** Linear interpolation with flat extrapolation (xs ascending). */
export function interp(x, xs, ys) {
  const n = xs.length;
  if (n === 0) return NaN;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid; else hi = mid;
  }
  const t = (x - xs[lo]) / (xs[hi] - xs[lo]);
  return ys[lo] + t * (ys[hi] - ys[lo]);
}

/** Bisection root of a monotone function on [a, b]. */
export function bisect(f, a, b, iters = 80) {
  let fa = f(a);
  for (let i = 0; i < iters; i++) {
    const m = 0.5 * (a + b);
    const fm = f(m);
    if ((fm > 0) === (fa > 0)) { a = m; fa = fm; } else b = m;
  }
  return 0.5 * (a + b);
}

export function linspace(a, b, n) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = n === 1 ? a : a + (b - a) * i / (n - 1);
  return out;
}
