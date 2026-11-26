/* firv.js - browser port of the firv curve and risk engine (fixed-income-rv-engine).
 *
 * Same conventions as the Python package: rates are decimals, times in years, zero rates
 * continuously compounded, DV01 = value gain for a 1 bp fall in yields. Trades are sized by
 * yield DV01 (street convention); key-rate DV01s use triangular zero-rate bumps.
 * Checked against values produced by the Python engine (web/selftest.html).
 */
(function (root) {
  'use strict';
  const F = {};
  const BP = 1e-4;

  // ------------------------------------------------------------------ linear algebra
  function solve(A, b) {
    const n = b.length;
    const M = A.map((r, i) => r.concat([b[i]]));
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      [M[c], M[p]] = [M[p], M[c]];
      const d = M[c][c] || 1e-300;
      for (let r = c + 1; r < n; r++) {
        const f = M[r][c] / d;
        if (f !== 0) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    const x = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r--) {
      let s = M[r][n];
      for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
      x[r] = s / (M[r][r] || 1e-300);
    }
    return x;
  }

  function lstsq(X, y, w, ridge) {
    const m = X[0].length;
    const A = Array.from({ length: m }, () => new Array(m).fill(0));
    const b = new Array(m).fill(0);
    for (let i = 0; i < X.length; i++) {
      const wi = w ? w[i] : 1;
      for (let a = 0; a < m; a++) {
        b[a] += wi * X[i][a] * y[i];
        for (let c = 0; c < m; c++) A[a][c] += wi * X[i][a] * X[i][c];
      }
    }
    for (let a = 0; a < m; a++) A[a][a] += ridge || 1e-14;
    return solve(A, b);
  }

  // Levenberg-Marquardt with numerical Jacobian and box constraints (projected steps)
  function lm(fn, x0, opts) {
    opts = opts || {};
    const lo = opts.lo, hi = opts.hi, maxIter = opts.maxIter || 200;
    const clamp = (x) => x.map((v, i) => Math.min(hi ? hi[i] : Infinity, Math.max(lo ? lo[i] : -Infinity, v)));
    let x = clamp(x0.slice());
    let r = fn(x);
    let cost = r.reduce((s, v) => s + v * v, 0);
    let mu = 1e-3;
    for (let it = 0; it < maxIter; it++) {
      const n = x.length, m = r.length;
      const J = Array.from({ length: m }, () => new Array(n).fill(0));
      for (let j = 0; j < n; j++) {
        const h = 1e-6 * Math.max(1, Math.abs(x[j]));
        const xp = x.slice();
        xp[j] += h;
        const rp = fn(clamp(xp));
        for (let i = 0; i < m; i++) J[i][j] = (rp[i] - r[i]) / h;
      }
      const JtJ = Array.from({ length: n }, (_, a) => Array.from({ length: n }, (_, c) => {
        let s = 0;
        for (let i = 0; i < m; i++) s += J[i][a] * J[i][c];
        return s;
      }));
      const Jtr = Array.from({ length: n }, (_, a) => {
        let s = 0;
        for (let i = 0; i < m; i++) s += J[i][a] * r[i];
        return s;
      });
      let improved = false;
      for (let tries = 0; tries < 12; tries++) {
        const A = JtJ.map((row, a) => row.map((v, c) => v + (a === c ? mu * (JtJ[a][a] + 1e-12) : 0)));
        const step = solve(A, Jtr.map((v) => -v));
        const xn = clamp(x.map((v, i) => v + step[i]));
        const rn = fn(xn);
        const cn = rn.reduce((s, v) => s + v * v, 0);
        if (isFinite(cn) && cn < cost) {
          const rel = (cost - cn) / Math.max(cost, 1e-300);
          x = xn; r = rn; cost = cn; mu = Math.max(mu / 3, 1e-12); improved = true;
          if (rel < 1e-12) return { x, cost, iters: it };
          break;
        }
        mu *= 4;
      }
      if (!improved) break;
    }
    return { x, cost };
  }

  // ------------------------------------------------------------------ curves
  function l1(x) { return Math.abs(x) < 1e-8 ? 1 - x / 2 : (1 - Math.exp(-x)) / x; }
  function l2(x) { return l1(x) - Math.exp(-x); }

  function couponGrid(T, freq, start) {
    start = start || 0;
    const step = 1 / freq, times = [];
    let t = T;
    while (t > start + 1e-9) { times.push(t); t -= step; }
    times.reverse();
    const accr = times.map(() => 1);
    if (times.length) accr[0] = Math.min((times[0] - start) / step, 1);
    return { times, accr };
  }

  class Curve {
    zero(t) { throw new Error('abstract'); }
    df(t) { return Math.exp(-this.zero(t) * t); }
    fwdSimple(a, b) { return (this.df(a) / this.df(b) - 1) / Math.max(b - a, 1e-6); }
    forward(a, b) { return (this.zero(b) * b - this.zero(a) * a) / Math.max(b - a, 1e-6); }
    instFwd(t) {
      const h = 1e-4, lo = Math.max(t - h, 0), hi = t + h;
      return (this.zero(hi) * hi - this.zero(lo) * lo) / (hi - lo);
    }
    annuity(T, freq, start) {
      const g = couponGrid(T, freq, start || 0);
      let s = 0;
      for (let i = 0; i < g.times.length; i++) s += g.accr[i] * this.df(g.times[i]);
      return s / freq;
    }
    parYield(T, freq, start) {
      start = start || 0;
      if (T - start <= 1 / freq + 1e-9) return this.fwdSimple(start, T);
      return (this.df(start) - this.df(T)) / this.annuity(T, freq, start);
    }
    shifted(fn) { return new ShiftedCurve(this, typeof fn === 'function' ? fn : () => fn); }
    keyRateBumped(keys, bumps) { return new ShiftedCurve(this, (t) => interp(t, keys, bumps)); }
  }

  function interp(x, xs, ys) {
    if (x <= xs[0]) return ys[0];
    const n = xs.length;
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 1;
    while (xs[i] < x) i++;
    const w = (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
    return ys[i - 1] + w * (ys[i] - ys[i - 1]);
  }

  class ShiftedCurve extends Curve {
    constructor(base, fn) { super(); this.base = base; this.fn = fn; this.label = base.label; }
    zero(t) { return this.base.zero(t) + this.fn(t); }
  }

  class NelsonSiegel extends Curve {
    constructor(p) { super(); this.p = p.slice(); this.label = 'Nelson-Siegel'; }
    zero(t) { const [b0, b1, b2, tau] = this.p, x = t / tau; return b0 + b1 * l1(x) + b2 * l2(x); }
    instFwd(t) { const [b0, b1, b2, tau] = this.p, e = Math.exp(-t / tau); return b0 + b1 * e + b2 * (t / tau) * e; }
  }

  class Svensson extends Curve {
    constructor(p) { super(); this.p = p.slice(); this.label = 'Nelson-Siegel-Svensson'; }
    zero(t) {
      const [b0, b1, b2, b3, t1, t2] = this.p, x1 = t / t1, x2 = t / t2;
      return b0 + b1 * l1(x1) + b2 * l2(x1) + b3 * l2(x2);
    }
    instFwd(t) {
      const [b0, b1, b2, b3, t1, t2] = this.p, e1 = Math.exp(-t / t1), e2 = Math.exp(-t / t2);
      return b0 + b1 * e1 + b2 * (t / t1) * e1 + b3 * (t / t2) * e2;
    }
  }

  // natural cubic spline (as scipy CubicSpline bc_type='natural')
  function naturalSpline(xs, ys) {
    // second-derivative-free boundary: c (half the second derivative) is 0 at both ends
    const n = xs.length, h = [], al = [0], l = [1], mu = [0], z = [0];
    for (let i = 0; i < n - 1; i++) h.push(xs[i + 1] - xs[i]);
    for (let i = 1; i < n - 1; i++) al[i] = 3 / h[i] * (ys[i + 1] - ys[i]) - 3 / h[i - 1] * (ys[i] - ys[i - 1]);
    for (let i = 1; i < n - 1; i++) {
      l[i] = 2 * (xs[i + 1] - xs[i - 1]) - h[i - 1] * mu[i - 1];
      mu[i] = h[i] / l[i];
      z[i] = (al[i] - h[i - 1] * z[i - 1]) / l[i];
    }
    const c = new Array(n).fill(0), b = new Array(n - 1), d = new Array(n - 1);
    for (let j = n - 2; j >= 0; j--) {
      c[j] = z[j] - mu[j] * c[j + 1];
      b[j] = (ys[j + 1] - ys[j]) / h[j] - h[j] * (c[j + 1] + 2 * c[j]) / 3;
      d[j] = (c[j + 1] - c[j]) / (3 * h[j]);
    }
    return (x) => {
      let i = n - 2;
      for (let k = 0; k < n - 1; k++) if (x < xs[k + 1]) { i = k; break; }
      const dx = x - xs[i];
      return ys[i] + b[i] * dx + c[i] * dx * dx + d[i] * dx * dx * dx;
    };
  }

  // monotone cubic (as scipy PchipInterpolator, with its edge rule)
  function pchip(xs, ys) {
    const n = xs.length;
    if (n === 2) return (x) => ys[0] + (ys[1] - ys[0]) * (x - xs[0]) / (xs[1] - xs[0]);
    const h = [], m = [];
    for (let i = 0; i < n - 1; i++) { h.push(xs[i + 1] - xs[i]); m.push((ys[i + 1] - ys[i]) / h[i]); }
    const d = new Array(n).fill(0);
    for (let k = 1; k < n - 1; k++) {
      if (m[k - 1] * m[k] <= 0) { d[k] = 0; continue; }
      const w1 = 2 * h[k] + h[k - 1], w2 = h[k] + 2 * h[k - 1];
      d[k] = (w1 + w2) / (w1 / m[k - 1] + w2 / m[k]);
    }
    const edge = (h0, h1, m0, m1) => {
      let dd = ((2 * h0 + h1) * m0 - h0 * m1) / (h0 + h1);
      if (Math.sign(dd) !== Math.sign(m0)) dd = 0;
      else if (Math.sign(m0) !== Math.sign(m1) && Math.abs(dd) > Math.abs(3 * m0)) dd = 3 * m0;
      return dd;
    };
    d[0] = edge(h[0], h[1], m[0], m[1]);
    d[n - 1] = edge(h[n - 2], h[n - 3], m[n - 2], m[n - 3]);
    return (x) => {
      let i = n - 2;
      for (let k = 0; k < n - 1; k++) if (x < xs[k + 1]) { i = k; break; }
      if (x < xs[0]) i = 0;
      const hh = h[i], t = (x - xs[i]) / hh;
      const h00 = 2 * t ** 3 - 3 * t ** 2 + 1, h10 = t ** 3 - 2 * t ** 2 + t;
      const h01 = -2 * t ** 3 + 3 * t ** 2, h11 = t ** 3 - t ** 2;
      return h00 * ys[i] + h10 * hh * d[i] + h01 * ys[i + 1] + h11 * hh * d[i + 1];
    };
  }

  class ZeroCurve extends Curve {
    constructor(t, z, mode) {
      super();
      const idx = t.map((v, i) => i).sort((a, b) => t[a] - t[b]);
      this.t = idx.map((i) => t[i]); this.z = idx.map((i) => z[i]); this.mode = mode || 'linear';
      this.label = 'Zero curve';
      if (this.mode === 'cubic') this.f = naturalSpline(this.t, this.z);
      if (this.mode === 'loglinear') this.lndf = this.t.map((v, i) => -this.z[i] * v);
    }
    zero(t) {
      const tc = Math.min(Math.max(t, this.t[0]), this.t[this.t.length - 1]);
      if (this.mode === 'cubic') return this.f(tc);
      if (this.mode === 'loglinear') {
        if (tc <= this.t[0]) return this.z[0];
        return -interp(tc, this.t, this.lndf) / Math.max(tc, 1e-6);
      }
      return interp(tc, this.t, this.z);
    }
  }

  // ----- B-spline forward curve (smoothing spline)
  const DEFAULT_KNOTS = [0, 0.5, 1, 2, 3, 5, 7, 10, 15, 20, 30, 40];
  const GL4 = { x: [-0.8611363115940526, -0.3399810435848563, 0.3399810435848563, 0.8611363115940526],
    w: [0.3478548451374538, 0.6521451548625461, 0.6521451548625461, 0.3478548451374538] };
  const GL8 = { x: [-0.9602898564975363, -0.7966664774136267, -0.5255324099163290, -0.1834346424956498,
    0.1834346424956498, 0.5255324099163290, 0.7966664774136267, 0.9602898564975363],
    w: [0.1012285362903763, 0.2223810344533745, 0.3137066458778873, 0.3626837833783620,
      0.3626837833783620, 0.3137066458778873, 0.2223810344533745, 0.1012285362903763] };

  function bsplineAll(x, knots, k) {
    // all degree-k basis values at x (Cox-de Boor); right end included in the last span
    const n = knots.length - k - 1;
    const last = knots[knots.length - 1];
    let N = new Array(knots.length - 1).fill(0);
    for (let i = 0; i < knots.length - 1; i++) {
      if ((x >= knots[i] && x < knots[i + 1]) || (x === last && knots[i] < knots[i + 1] && knots[i + 1] === last)) N[i] = 1;
    }
    for (let d = 1; d <= k; d++) {
      const M = new Array(knots.length - 1 - d).fill(0);
      for (let i = 0; i < M.length; i++) {
        const a = knots[i + d] - knots[i], b = knots[i + d + 1] - knots[i + 1];
        M[i] = (a > 0 ? (x - knots[i]) / a * N[i] : 0) + (b > 0 ? (knots[i + d + 1] - x) / b * N[i + 1] : 0);
      }
      N = M;
    }
    return N.slice(0, n);
  }

  function bsplineDeriv2(x, knots, k) {
    // second derivatives of the degree-k basis via the derivative recursion
    const lower = bsplineAll(x, knots, k - 2).concat([0, 0, 0]);
    const n = knots.length - k - 1;
    const d1 = (j, kk, vals) => {
      const a = knots[j + kk] - knots[j], b = knots[j + kk + 1] - knots[j + 1];
      return (a > 0 ? kk / a * vals(j) : 0) - (b > 0 ? kk / b * vals(j + 1) : 0);
    };
    const first = (j) => d1(j, k - 1, (i) => lower[i] || 0);     // derivative of degree k-1 basis
    const out = [];
    for (let j = 0; j < n; j++) out.push(d1(j, k, first));
    return out;
  }

  class SplineBasis {
    constructor(breaks, k) {
      k = k || 3;
      const b = Array.from(new Set(breaks)).sort((a, c) => a - c);
      this.k = k;
      this.knots = Array(k).fill(b[0]).concat(b, Array(k).fill(b[b.length - 1]));
      this.n = this.knots.length - k - 1;
      this.tmax = b[b.length - 1];
      this.breaks = b;
      // cumulative integrals of each basis function at every break
      this.cum = [new Array(this.n).fill(0)];
      for (let s = 0; s < b.length - 1; s++) {
        const seg = this.segIntegral(b[s], b[s + 1]);
        this.cum.push(this.cum[s].map((v, j) => v + seg[j]));
      }
      this.penalty = this.makePenalty();
      this.endVals = bsplineAll(this.tmax, this.knots, k);
    }
    segIntegral(a, c) {
      const out = new Array(this.n).fill(0);
      if (c <= a) return out;
      for (let q = 0; q < 4; q++) {
        const x = 0.5 * (c - a) * GL4.x[q] + 0.5 * (a + c), w = 0.5 * (c - a) * GL4.w[q];
        const v = bsplineAll(x, this.knots, this.k);
        for (let j = 0; j < this.n; j++) out[j] += w * v[j];
      }
      return out;
    }
    values(t) { return bsplineAll(Math.min(Math.max(t, 0), this.tmax), this.knots, this.k); }
    integrals(t) {
      const tc = Math.min(Math.max(t, 0), this.tmax);
      let s = 0;
      while (s < this.breaks.length - 2 && this.breaks[s + 1] <= tc) s++;
      const part = this.segIntegral(this.breaks[s], tc);
      const out = this.cum[s].map((v, j) => v + part[j]);
      if (t > this.tmax) for (let j = 0; j < this.n; j++) out[j] += (t - this.tmax) * this.endVals[j];
      return out;
    }
    makePenalty() {
      const n = this.n, O = Array.from({ length: n }, () => new Array(n).fill(0));
      for (let s = 0; s < this.breaks.length - 1; s++) {
        const a = this.breaks[s], c = this.breaks[s + 1];
        for (let q = 0; q < 8; q++) {
          const x = 0.5 * (c - a) * GL8.x[q] + 0.5 * (a + c), w = 0.5 * (c - a) * GL8.w[q];
          const v = bsplineDeriv2(x, this.knots, this.k);
          for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) O[i][j] += w * v[i] * v[j];
        }
      }
      return O;
    }
  }

  class ForwardSpline extends Curve {
    constructor(basis, c) { super(); this.basis = basis; this.c = c.slice(); this.label = 'Smoothing spline'; }
    zero(t) {
      const tt = Math.max(t, 1e-6), I = this.basis.integrals(tt);
      let s = 0;
      for (let j = 0; j < I.length; j++) s += I[j] * this.c[j];
      return s / tt;
    }
    instFwd(t) {
      const v = this.basis.values(t);
      let s = 0;
      for (let j = 0; j < v.length; j++) s += v[j] * this.c[j];
      return s;
    }
  }

  const basisCache = {};
  function splineBasis(maxT) {
    const br = DEFAULT_KNOTS.filter((k) => k < maxT - 1e-9).concat([Math.max(maxT, 1)]);
    const key = br.join(',');
    if (!basisCache[key]) basisCache[key] = new SplineBasis(br, 3);
    return basisCache[key];
  }

  // ------------------------------------------------------------------ bootstrapping
  function bootstrapPar(tenors, par, freq) {
    const idx = tenors.map((v, i) => i).sort((a, b) => tenors[a] - tenors[b]);
    const t = idx.map((i) => tenors[i]), y = idx.map((i) => par[i]);
    const step = 1 / freq, nt = [], nd = [];
    for (let i = 0; i < t.length; i++) if (t[i] <= step + 1e-9) { nt.push(t[i]); nd.push(1 / (1 + y[i] * t[i])); }
    const coupT = t.filter((v) => v > step + 1e-9);
    if (coupT.length) {
      const fpar = pchip(t, y);
      const nmax = Math.round(coupT[coupT.length - 1] * freq);
      const dfs = [];
      for (let n = 0; n < nmax; n++) {
        const tn = (n + 1) * step;
        const c = tn >= t[0] ? fpar(tn) : y[0];
        if (n === 0) {
          if (nt.length && Math.abs(nt[nt.length - 1] - tn) < 1e-9) { dfs.push(nd[nd.length - 1]); continue; }
          dfs.push(1 / (1 + c / freq));
        } else {
          const sum = dfs.reduce((s, v) => s + v, 0);
          dfs.push((1 - c / freq * sum) / (1 + c / freq));
        }
      }
      for (let n = 0; n < nmax; n++) {
        const tn = (n + 1) * step;
        if (!nt.length || tn > nt[nt.length - 1] + 1e-9) { nt.push(tn); nd.push(dfs[n]); }
      }
    }
    return new ZeroCurve(nt, nd.map((d, i) => -Math.log(d) / nt[i]), 'loglinear');
  }

  // ------------------------------------------------------------------ fitting
  const TAU_GRID = Array.from({ length: 28 }, (_, i) => Math.exp(Math.log(0.15) + i * (Math.log(12) - Math.log(0.15)) / 27));

  function approxZero(data) {
    if (data.kind === 'zero') return data.values.slice();
    return data.values.map((y) => data.freq * Math.log1p(y / data.freq));
  }

  function modelValues(curve, data) {
    if (data.kind === 'zero') return data.tenors.map((t) => curve.zero(t));
    return data.tenors.map((t) => curve.parYield(t, data.freq));
  }

  function nsRows(t, tau) { return t.map((x) => [1, l1(x / tau), l2(x / tau)]); }
  function nssRows(t, t1, t2) { return t.map((x) => [1, l1(x / t1), l2(x / t1), l2(x / t2)]); }

  function sse(X, z, beta) {
    let s = 0;
    for (let i = 0; i < X.length; i++) { let v = -z[i]; for (let j = 0; j < beta.length; j++) v += X[i][j] * beta[j]; s += v * v; }
    return s;
  }

  function fitNS(data) {
    const t = data.tenors, z = approxZero(data);
    let best = null;
    for (const tau of TAU_GRID) {
      const X = nsRows(t, tau), beta = lstsq(X, z), s = sse(X, z, beta);
      if (!best || s < best.s) best = { s, p: beta.concat([tau]) };
    }
    const fn = (x) => { const c = new NelsonSiegel([x[0], x[1], x[2], Math.exp(x[3])]); return modelValues(c, data).map((v, i) => (v - data.values[i]) * 1e4); };
    const r = lm(fn, [best.p[0], best.p[1], best.p[2], Math.log(best.p[3])], { lo: [-1, -1, -1, Math.log(0.05)], hi: [1, 1, 1, Math.log(30)] });
    const c = new NelsonSiegel([r.x[0], r.x[1], r.x[2], Math.exp(r.x[3])]);
    return finish('ns', c, data, c.p);
  }

  function fitNSS(data) {
    const t = data.tenors, z = approxZero(data);
    const cands = [];
    for (let i = 0; i < TAU_GRID.length; i++) for (let j = i + 2; j < TAU_GRID.length; j++) {
      const X = nssRows(t, TAU_GRID[i], TAU_GRID[j]), beta = lstsq(X, z);
      cands.push({ s: sse(X, z, beta), p: beta.concat([TAU_GRID[i], TAU_GRID[j]]) });
    }
    cands.sort((a, b) => a.s - b.s);
    const lo = [-1, -1, -1, -1, Math.log(0.05), Math.log(0.1)], hi = [1, 1, 1, 1, Math.log(30), Math.log(40)];
    const mk = (x) => { const t1 = Math.exp(x[4]); return new Svensson([x[0], x[1], x[2], x[3], t1, t1 + Math.exp(x[5])]); };
    const fn = (x) => modelValues(mk(x), data).map((v, i) => (v - data.values[i]) * 1e4);
    let best = null;
    for (const cand of cands.slice(0, 3)) {
      const p = cand.p, t1 = Math.max(p[4], 0.05), gap = Math.max(p[5] - t1, 0.1);
      const r = lm(fn, [p[0], p[1], p[2], p[3], Math.log(t1), Math.log(gap)], { lo, hi });
      if (!best || r.cost < best.cost) best = r;
    }
    const c = mk(best.x);
    return finish('nss', c, data, c.p);
  }

  function choleskyRoot(O) {
    // symmetric square root via Jacobi eigen-decomposition (small matrices)
    const n = O.length, A = O.map((r) => r.slice()), V = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
    for (let sweep = 0; sweep < 60; sweep++) {
      let off = 0;
      for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += A[p][q] * A[p][q];
      if (off < 1e-24) break;
      for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
        if (Math.abs(A[p][q]) < 1e-30) continue;
        const th = (A[q][q] - A[p][p]) / (2 * A[p][q]);
        const tt = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
        const c = 1 / Math.sqrt(tt * tt + 1), s = tt * c;
        for (let k = 0; k < n; k++) {
          const akp = A[k][p], akq = A[k][q];
          A[k][p] = c * akp - s * akq; A[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = A[p][k], aqk = A[q][k];
          A[p][k] = c * apk - s * aqk; A[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k][p], vkq = V[k][q];
          V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq;
        }
      }
    }
    // L = diag(sqrt(lambda)) V^T  so that L^T L = O
    return Array.from({ length: n }, (_, i) => V.map((row) => Math.sqrt(Math.max(A[i][i], 0)) * row[i]));
  }

  function fitSpline(data, lam) {
    lam = lam == null ? 0.05 : lam;
    const t = data.tenors, z = approxZero(data);
    const basis = splineBasis(Math.max(...t));
    const A = t.map((x) => basis.integrals(Math.max(x, 1e-6)).map((v) => v / Math.max(x, 1e-6)));
    const n = basis.n;
    const M = Array.from({ length: n }, (_, a) => Array.from({ length: n }, (_, b) => {
      let s = lam * basis.penalty[a][b];
      for (let i = 0; i < A.length; i++) s += A[i][a] * A[i][b];
      return s + (a === b ? 1e-12 : 0);
    }));
    const rhs = Array.from({ length: n }, (_, a) => A.reduce((s, row, i) => s + row[a] * z[i], 0));
    let c = solve(M, rhs);
    if (data.kind !== 'zero') {
      const L = choleskyRoot(basis.penalty), scale = Math.sqrt(lam) * 1e4;
      const fn = (cc) => {
        const curve = new ForwardSpline(basis, cc);
        const r = modelValues(curve, data).map((v, i) => (v - data.values[i]) * 1e4);
        for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < n; j++) s += L[i][j] * cc[j]; r.push(scale * s); }
        return r;
      };
      c = lm(fn, c, { maxIter: 60 }).x;
    }
    const curve = new ForwardSpline(basis, c);
    return finish('spline', curve, data, c);
  }

  function fitCubic(data) {
    let curve;
    if (data.kind === 'zero') curve = new ZeroCurve(data.tenors, data.values, 'cubic');
    else {
      const boot = bootstrapPar(data.tenors, data.values, data.freq);
      curve = new ZeroCurve(data.tenors, data.tenors.map((x) => boot.zero(x)), 'cubic');
    }
    curve.label = 'Cubic spline';
    return finish('cubic', curve, data, null);
  }

  function fitBootstrap(data) {
    if (data.kind !== 'par') throw new Error('bootstrap needs par yields');
    const curve = bootstrapPar(data.tenors, data.values, data.freq);
    curve.label = 'Bootstrap';
    return finish('bootstrap', curve, data, null);
  }

  function finish(method, curve, data, params) {
    const fitted = modelValues(curve, data);
    const resid = fitted.map((v, i) => (v - data.values[i]) * 1e4);
    const rmse = Math.sqrt(resid.reduce((s, v) => s + v * v, 0) / resid.length);
    return { method, curve, data, fitted, resid, rmse, maxAbs: Math.max(...resid.map(Math.abs)), params };
  }

  function fit(method, data, opts) {
    if (method === 'ns') return fitNS(data);
    if (method === 'nss') return fitNSS(data);
    if (method === 'spline') return fitSpline(data, opts && opts.lambda);
    if (method === 'cubic') return fitCubic(data);
    if (method === 'bootstrap') return fitBootstrap(data);
    throw new Error('unknown method ' + method);
  }

  // ------------------------------------------------------------------ instruments
  function bondFlows(T, cpn, freq) {
    if (T <= 1e-9) return { times: [], amounts: [], accrued: 0 };
    const g = couponGrid(T, freq);
    const amounts = g.times.map(() => cpn / freq);
    amounts[amounts.length - 1] += 1;
    return { times: g.times, amounts, accrued: cpn / freq * (1 - g.accr[0]) };
  }

  function brent(f, a, b, tol) {
    let fa = f(a), fb = f(b);
    if (fa * fb > 0) return NaN;
    let c = a, fc = fa, d = b - a, e = d;
    for (let i = 0; i < 200; i++) {
      if (fb * fc > 0) { c = a; fc = fa; d = b - a; e = d; }
      if (Math.abs(fc) < Math.abs(fb)) { a = b; b = c; c = a; fa = fb; fb = fc; fc = fa; }
      const tol1 = 2e-16 * Math.abs(b) + 0.5 * (tol || 1e-14), xm = 0.5 * (c - b);
      if (Math.abs(xm) <= tol1 || fb === 0) return b;
      if (Math.abs(e) >= tol1 && Math.abs(fa) > Math.abs(fb)) {
        let s = fb / fa, p, q;
        if (a === c) { p = 2 * xm * s; q = 1 - s; } else {
          q = fa / fc; const r = fb / fc;
          p = s * (2 * xm * q * (q - r) - (b - a) * (r - 1)); q = (q - 1) * (r - 1) * (s - 1);
        }
        if (p > 0) q = -q; else p = -p;
        if (2 * p < Math.min(3 * xm * q - Math.abs(tol1 * q), Math.abs(e * q))) { e = d; d = p / q; } else { d = xm; e = d; }
      } else { d = xm; e = d; }
      a = b; fa = fb;
      b += Math.abs(d) > tol1 ? d : (xm > 0 ? tol1 : -tol1);
      fb = f(b);
    }
    return b;
  }

  function streetDV01(times, amounts, freq, dirty) {
    if (!times.length) return 0;
    const price = (y) => times.reduce((s, t, i) => s + amounts[i] / Math.pow(1 + y / freq, t * freq), 0);
    const y = brent((yy) => price(yy) - dirty, -0.5, 2.0, 1e-14);
    return times.reduce((s, t, i) => s + amounts[i] * t * Math.pow(1 + y / freq, -t * freq - 1), 0) * BP;
  }

  class Bond {
    constructor(T, coupon, freq, curve, label) {
      this.kind = 'bond'; this.T = T; this.coupon = coupon; this.freq = freq; this.curve = curve; this.label = label || '';
    }
    flows() { return bondFlows(this.T, this.coupon, this.freq); }
    pv(curves, spread) {
      const f = this.flows(), c = curves[this.curve], s = spread || 0;
      let v = 0;
      for (let i = 0; i < f.times.length; i++) v += f.amounts[i] * Math.exp(-(c.zero(f.times[i]) + s) * f.times[i]);
      return v;
    }
    aged(h) { return new Bond(Math.max(this.T - h, 0), this.coupon, this.freq, this.curve, this.label); }
    cashIn(h) { const f = this.flows(); return f.amounts.reduce((s, a, i) => s + (f.times[i] <= h + 1e-9 ? a : 0), 0); }
    yieldDV01(curves) { const f = this.flows(); return streetDV01(f.times, f.amounts, this.freq, this.pv(curves)); }
    ytm(curves) {
      const f = this.flows(), dirty = this.pv(curves);
      return brent((y) => f.times.reduce((s, t, i) => s + f.amounts[i] / Math.pow(1 + y / this.freq, t * this.freq), 0) - dirty, -0.5, 2, 1e-14);
    }
  }

  function parBond(curves, key, T, freq, label) {
    return new Bond(T, curves[key].parYield(T, freq), freq, key, label || `${key} ${T}y`);
  }

  // ------------------------------------------------------------------ risk
  const KEY_TENORS = [0.25, 0.5, 1, 2, 3, 5, 7, 10, 15, 20, 30];

  function tradeValue(legs, curves) { return legs.reduce((s, l) => s + l.notional * l.ins.pv(curves), 0); }

  function withShift(curves, keys, fn) {
    const out = Object.assign({}, curves);
    for (const k of keys) out[k] = curves[k].shifted(fn);
    return out;
  }

  function curveKeys(legs) { return Array.from(new Set(legs.map((l) => l.ins.curve))); }

  function dv01(legs, curves, keys) {
    keys = keys || curveKeys(legs);
    return tradeValue(legs, withShift(curves, keys, () => -0.5 * BP)) - tradeValue(legs, withShift(curves, keys, () => 0.5 * BP));
  }

  function keyRateDV01(legs, curves, keyTenors) {
    keyTenors = keyTenors || KEY_TENORS;
    const out = {};
    for (const k of curveKeys(legs)) {
      out[k] = keyTenors.map((_, i) => {
        const e = keyTenors.map((__, j) => (i === j ? 1 : 0));
        const up = Object.assign({}, curves), dn = Object.assign({}, curves);
        up[k] = curves[k].keyRateBumped(keyTenors, e.map((v) => v * 0.5 * BP));
        dn[k] = curves[k].keyRateBumped(keyTenors, e.map((v) => -v * 0.5 * BP));
        return tradeValue(legs, dn) - tradeValue(legs, up);
      });
    }
    return out;
  }

  function constantYieldValue(ins, curves, h) {
    const f = ins.flows();
    if (!f.times.length) return 0;
    const v0 = ins.pv(curves), fr = ins.freq;
    const price = (y, ex) => f.amounts.reduce((s, a, i) => s + a / Math.pow(1 + y / fr, ex[i]), 0);
    const ex0 = f.times.map((t) => t * fr);
    const y = brent((yy) => price(yy, ex0) - v0, -0.5, 2, 1e-14);
    let s = 0;
    for (let i = 0; i < f.times.length; i++) if (f.times[i] > h + 1e-9) s += f.amounts[i] / Math.pow(1 + y / fr, (f.times[i] - h) * fr);
    return s;
  }

  function carryRoll(legs, curves, h, funding) {
    funding = funding || {};
    let total = 0, carry = 0;
    const rows = [];
    for (const l of legs) {
      const ins = l.ins, k = ins.curve, v0 = ins.pv(curves);
      const r = funding[k] != null ? funding[k] : curves[k].fwdSimple(0, h);
      const fin = v0 * r * h, cash = ins.cashIn(h);
      const lt = ins.aged(h).pv(curves) + cash - v0 - fin;
      const lc = constantYieldValue(ins, curves, h) + cash - v0 - fin;
      rows.push({ label: l.label, total: l.notional * lt, carry: l.notional * lc, roll: l.notional * (lt - lc) });
      total += l.notional * lt; carry += l.notional * lc;
    }
    return { total, carry, roll: total - carry, legs: rows };
  }

  function scenarioPnL(legs, curves, shocked, h, funding) {
    const nw = Object.assign({}, curves, shocked);
    if (!h) { const p = tradeValue(legs, nw) - tradeValue(legs, curves); return { pnl: p, shock: p, carryRoll: 0 }; }
    const cr = carryRoll(legs, curves, h, funding);
    const aged = legs.map((l) => ({ ins: l.ins.aged(h), notional: l.notional, label: l.label }));
    const shock = tradeValue(aged, nw) - tradeValue(aged, curves);
    return { pnl: cr.total + shock, shock, carryRoll: cr.total };
  }

  // size a leg so that its yield DV01 equals amount (signed)
  function legFor(ins, curves, amount, label) {
    const u = ins.yieldDV01(curves);
    return { ins, notional: amount / u, label: label || ins.label };
  }

  // ------------------------------------------------------------------ trade constructors
  function curveTrade(curves, key, sT, lT, amount, direction, freq) {
    const s = direction === 'flattener' ? -1 : 1;
    return [legFor(parBond(curves, key, sT, freq), curves, s * amount, `${s > 0 ? 'Buy' : 'Sell'} ${sT}y`),
      legFor(parBond(curves, key, lT, freq), curves, -s * amount, `${s > 0 ? 'Sell' : 'Buy'} ${lT}y`)];
  }

  function butterfly(curves, key, wings, belly, amount, weights, direction, freq) {
    const s = direction === 'short_belly' ? -1 : 1;
    const [ws, wl] = weights || [0.5, 0.5];
    return [legFor(parBond(curves, key, belly, freq), curves, s * amount, `${s > 0 ? 'Buy' : 'Sell'} ${belly}y (belly)`),
      legFor(parBond(curves, key, wings[0], freq), curves, -s * amount * ws, `${s > 0 ? 'Sell' : 'Buy'} ${wings[0]}y`),
      legFor(parBond(curves, key, wings[1], freq), curves, -s * amount * wl, `${s > 0 ? 'Sell' : 'Buy'} ${wings[1]}y`)];
  }

  function pcaFlyWeights(L) {
    // L: rows short, belly, long; columns PC1, PC2
    const A = [[L[0][0], L[2][0]], [L[0][1], L[2][1]]];
    return solve(A, [L[1][0], L[1][1]]);
  }

  function regressionWeights(dS, dB, dL) {
    // belly changes regressed on wing changes (no intercept): belly ~ a*short + b*long
    const X = dS.map((v, i) => [v, dL[i]]);
    return lstsq(X, dB);
  }

  function spreadTrade(curves, a, b, amount, beta) {
    // a, b: {key, T, freq}; long a, short beta x DV01 of b
    return [legFor(parBond(curves, a.key, a.T, a.freq), curves, amount, `Buy ${a.key} ${a.T}y`),
      legFor(parBond(curves, b.key, b.T, b.freq), curves, -(beta || 1) * amount, `Sell ${b.key} ${b.T}y`)];
  }

  Object.assign(F, {
    BP, solve, lstsq, lm, couponGrid, interp, Curve, ShiftedCurve, NelsonSiegel, Svensson, ZeroCurve,
    ForwardSpline, SplineBasis, splineBasis, naturalSpline, pchip, bootstrapPar, fit, modelValues,
    Bond, parBond, bondFlows, streetDV01, brent, KEY_TENORS, tradeValue, dv01, keyRateDV01, carryRoll,
    scenarioPnL, legFor, curveTrade, butterfly, pcaFlyWeights, regressionWeights, spreadTrade, constantYieldValue,
  });
  root.FIRV = F;
})(typeof window !== 'undefined' ? window : globalThis);
