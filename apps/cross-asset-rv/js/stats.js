/* Numerics for the in-browser scanner: OLS, rolling OLS, Kalman hedge, ADF / Engle-Granger with MacKinnon
   p-values, OU half-life, Bayesian mean-reversion probability, z-score rules and the spread backtester.
   Mirrors src/rvscan (Python); app.js runs a self-check against Python's stored backtest results. */
(function (global) {
  "use strict";
  const S = {};
  const isF = (v) => v !== null && v !== undefined && Number.isFinite(v);
  S.isF = isF;

  S.mean = (a) => { let s = 0, n = 0; for (const v of a) if (isF(v)) { s += v; n++; } return n ? s / n : NaN; };
  S.std = (a) => {
    const m = S.mean(a); let s = 0, n = 0;
    for (const v of a) if (isF(v)) { s += (v - m) * (v - m); n++; }
    return n > 1 ? Math.sqrt(s / (n - 1)) : NaN;
  };
  S.quantile = (a, q) => {
    const b = a.filter(isF).sort((x, y) => x - y); if (!b.length) return NaN;
    const pos = (b.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return b[lo] + (b[hi] - b[lo]) * (pos - lo);
  };
  S.median = (a) => S.quantile(a, 0.5);

  // ---------------------------------------------------------------- linear algebra (small)
  function lstsq(X, y) {           // X: array of rows; normal equations with Gaussian elimination
    const k = X[0].length, A = Array.from({ length: k }, () => new Float64Array(k)), b = new Float64Array(k);
    for (let i = 0; i < X.length; i++) {
      const r = X[i];
      for (let p = 0; p < k; p++) { b[p] += r[p] * y[i]; for (let q = 0; q < k; q++) A[p][q] += r[p] * r[q]; }
    }
    return solve(A, b);
  }
  function solve(A, b) {
    const n = b.length, M = A.map((r, i) => [...r, b[i]]);
    for (let c = 0; c < n; c++) {
      let piv = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      [M[c], M[piv]] = [M[piv], M[c]];
      if (Math.abs(M[c][c]) < 1e-300) return new Array(n).fill(NaN);
      for (let r = 0; r < n; r++) if (r !== c) {
        const f = M[r][c] / M[c][c]; for (let q = c; q <= n; q++) M[r][q] -= f * M[c][q];
      }
    }
    return M.map((r, i) => r[n] / r[i]);
  }
  function inv(A) {
    const n = A.length; const cols = [];
    for (let j = 0; j < n; j++) { const e = new Array(n).fill(0); e[j] = 1; cols.push(solve(A.map((r) => [...r]), e)); }
    return A.map((_, i) => cols.map((c) => c[i]));
  }
  S.ols = (y, x) => {
    const X = [], Y = [];
    for (let i = 0; i < y.length; i++) if (isF(y[i]) && isF(x[i])) { X.push([1, x[i]]); Y.push(y[i]); }
    const [a, b] = lstsq(X, Y);
    return { a, b };
  };

  S.rollingOls = (y, x, w) => {
    const n = y.length, alpha = new Array(n).fill(NaN), beta = new Array(n).fill(NaN);
    let c = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    const ok = (i) => isF(y[i]) && isF(x[i]);
    for (let t = 0; t < n; t++) {
      if (ok(t)) { c++; sx += x[t]; sy += y[t]; sxx += x[t] * x[t]; sxy += x[t] * y[t]; }
      const o = t - w;
      if (o >= 0 && ok(o)) { c--; sx -= x[o]; sy -= y[o]; sxx -= x[o] * x[o]; sxy -= x[o] * y[o]; }
      if (t >= w - 1 && c >= 0.8 * w) {
        const mx = sx / c, my = sy / c, vx = sxx / c - mx * mx;
        if (vx > 0) { beta[t] = (sxy / c - mx * my) / vx; alpha[t] = my - beta[t] * mx; }
      }
    }
    return { alpha, beta };
  };

  // Kalman dynamic regression y = a_t + b_t x + e, random-walk states; returns one-step-ahead (prior) paths.
  S.kalman = (y, x, delta = 1e-4, init = 252) => {
    const n = y.length, n0 = Math.min(init, Math.max(Math.floor(n / 4), 5));
    const X = [], Y = [];
    for (let i = 0; i < n0; i++) if (isF(y[i]) && isF(x[i])) { X.push([1, x[i]]); Y.push(y[i]); }
    let th = lstsq(X, Y);
    let R = 0; for (let i = 0; i < X.length; i++) { const e = Y[i] - th[0] - th[1] * X[i][1]; R += e * e; }
    R = Math.max(R / Math.max(X.length - 2, 1), 1e-12);
    const xtx = [[0, 0], [0, 0]];
    for (const r of X) for (let p = 0; p < 2; p++) for (let q = 0; q < 2; q++) xtx[p][q] += r[p] * r[q];
    const xi = inv(xtx);
    let P = [[xi[0][0] * R * 10, xi[0][1] * R * 10], [xi[1][0] * R * 10, xi[1][1] * R * 10]];
    const f = delta / (1 - delta), Q = [Math.max(xi[0][0] * R * n0, 1e-14) * f, Math.max(xi[1][1] * R * n0, 1e-14) * f];
    const ap = new Array(n).fill(NaN), bp = new Array(n).fill(NaN);
    for (let t = 0; t < n; t++) {
      const Pp = [[P[0][0] + Q[0], P[0][1]], [P[1][0], P[1][1] + Q[1]]];
      ap[t] = th[0]; bp[t] = th[1];
      if (!(isF(y[t]) && isF(x[t]))) { P = Pp; continue; }
      const h = [1, x[t]];
      const Ph = [Pp[0][0] * h[0] + Pp[0][1] * h[1], Pp[1][0] * h[0] + Pp[1][1] * h[1]];
      const Sv = h[0] * Ph[0] + h[1] * Ph[1] + R, err = y[t] - (th[0] + th[1] * x[t]);
      const K = [Ph[0] / Sv, Ph[1] / Sv];
      th = [th[0] + K[0] * err, th[1] + K[1] * err];
      P = [[Pp[0][0] - K[0] * Ph[0], Pp[0][1] - K[0] * Ph[1]], [Pp[1][0] - K[1] * Ph[0], Pp[1][1] - K[1] * Ph[1]]];
    }
    for (let t = 0; t < Math.min(init, n); t++) { ap[t] = NaN; bp[t] = NaN; }
    return { alpha: ap, beta: bp };
  };

  // ---------------------------------------------------------------- MacKinnon (1994) p-values (statsmodels tables)
  const TAU = {
    star: { n: [-1.04, -1.53, -2.68, -3.09, -3.07, -3.77], c: [-1.61, -2.62, -3.13, -3.47, -3.78, -3.93] },
    min: { n: [-19.04, -19.62, -21.21, -23.25, -21.63, -25.74], c: [-18.83, -18.86, -23.48, -28.07, -25.96, -23.27] },
    max: { n: [Infinity, 1.51, 0.86, 0.88, 1.05, 1.24], c: [2.74, 0.92, 0.55, 0.61, 0.79, 1.0] },
    small: {
      n: [[0.6344, 1.2378, 3.2496], [1.9129, 1.3857, 3.5322], [2.7648, 1.4502, 3.4186], [3.4336, 1.4835, 3.19], [4.0999, 1.5533, 3.59], [4.5388, 1.5344, 2.9807]],
      c: [[2.1659, 1.4412, 3.8269], [2.92, 1.5012, 3.9796], [3.4699, 1.4856, 3.164], [3.9673, 1.4777, 2.6315], [4.5509, 1.5338, 2.9545], [5.1399, 1.6036, 3.4445]],
    },
    large: {
      n: [[0.4797, 9.3557, -0.6999, 3.3066], [1.5578, 8.558, -2.083, -3.3549], [2.2268, 6.8093, -3.2362, -5.4448], [2.7654, 6.4502, -3.0811, -4.4946], [3.2684, 6.8051, -2.6778, -3.4972], [3.7268, 7.167, -2.3648, -2.8288]],
      c: [[1.7339, 9.3202, -1.2745, -1.0368], [2.1945, 6.4695, -2.9198, -4.2377], [2.5893, 4.5168, -3.6529, -5.0074], [3.0387, 4.5452, -3.3666, -4.1921], [3.5049, 5.2098, -2.9158, -3.3468], [3.9489, 5.8933, -2.5359, -2.721]],
    },
  };
  function normCdf(z) {           // Abramowitz-Stegun 7.1.26 via erf
    const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z / 2);
    return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
  }
  S.normCdf = normCdf;
  S.mackinnonP = (tau, nvars = 1, reg = "c") => {
    const i = nvars - 1;
    if (tau > TAU.max[reg][i]) return 1;
    if (tau < TAU.min[reg][i]) return 0;
    let c;
    if (tau <= TAU.star[reg][i]) { const s = TAU.small[reg][i]; c = [s[0], s[1], s[2] * 1e-2]; }
    else { const l = TAU.large[reg][i]; c = [l[0], l[1] * 1e-1, l[2] * 1e-1, l[3] * 1e-2]; }
    let v = 0; for (let k = c.length - 1; k >= 0; k--) v = v * tau + c[k];
    return normCdf(v);
  };

  // ADF with constant ("c") or none ("n"), AIC lag choice on a common sample.
  S.adf = (xin, { maxLag = null, reg = "c", nvars = 1 } = {}) => {
    const x = xin.filter(isF), n = x.length;
    if (n < 30) return { stat: NaN, p: NaN, lags: 0 };
    let L = maxLag === null ? Math.ceil(12 * Math.pow(n / 100, 0.25)) : maxLag;
    L = Math.max(0, Math.min(L, Math.floor(n / 2) - 3, 12));
    const dx = []; for (let i = 1; i < n; i++) dx.push(x[i] - x[i - 1]);
    const design = (lags) => {
      const rows = [], ys = [];
      for (let t = lags; t < dx.length; t++) {
        const r = [x[t]]; for (let k = 1; k <= lags; k++) r.push(dx[t - k]);
        if (reg === "c") r.push(1);
        rows.push(r); ys.push(dx[t]);
      }
      return [rows, ys];
    };
    let best = 0;
    if (L > 0) {
      const [Xall, yall] = design(L);
      const T = yall.length; let bestIc = Infinity;
      for (let p = 0; p <= L; p++) {
        const X = Xall.map((r) => (reg === "c" ? [...r.slice(0, 1 + p), 1] : r.slice(0, 1 + p)));
        const b = lstsq(X, yall); let ss = 0;
        for (let i = 0; i < T; i++) { let f = 0; for (let k = 0; k < b.length; k++) f += X[i][k] * b[k]; ss += (yall[i] - f) ** 2; }
        const llf = -T / 2 * (Math.log(2 * Math.PI) + Math.log(ss / T) + 1), ic = -2 * llf + 2 * X[0].length;
        if (ic < bestIc - 1e-12) { bestIc = ic; best = p; }
      }
    }
    const [X, y] = design(best);
    const b = lstsq(X, y); let ss = 0;
    for (let i = 0; i < y.length; i++) { let f = 0; for (let k = 0; k < b.length; k++) f += X[i][k] * b[k]; ss += (y[i] - f) ** 2; }
    const k = X[0].length, s2 = ss / Math.max(y.length - k, 1);
    const xtx = Array.from({ length: k }, () => new Array(k).fill(0));
    for (const r of X) for (let p = 0; p < k; p++) for (let q = 0; q < k; q++) xtx[p][q] += r[p] * r[q];
    const se = Math.sqrt(Math.max(inv(xtx)[0][0] * s2, 0));
    const stat = b[0] / se;
    return { stat, p: S.mackinnonP(stat, nvars, reg === "n" && nvars === 1 ? "n" : "c"), lags: best, rho: b[0] };
  };

  S.engleGranger = (y, x) => {
    const Y = [], X = [];
    for (let i = 0; i < y.length; i++) if (isF(y[i]) && isF(x[i])) { Y.push(y[i]); X.push(x[i]); }
    const { a, b } = S.ols(Y, X);
    const resid = Y.map((v, i) => v - a - b * X[i]);
    const r = S.adf(resid, { reg: "n", nvars: 1 });
    return { stat: r.stat, p: S.mackinnonP(r.stat, 2, "c"), alpha: a, beta: b, n: Y.length, lags: r.lags };
  };

  S.fitOU = (sin, nvars = 1, dt = 1 / 252) => {
    const s = sin.filter(isF), n = s.length - 1;
    if (n < 20) return { meanRev: false, hl: Infinity };
    const x = s.slice(0, -1), y = s.slice(1);
    const { a, b } = S.ols(y, x);
    let ss = 0, mx = S.mean(x), sxx = 0;
    for (let i = 0; i < n; i++) { const e = y[i] - a - b * x[i]; ss += e * e; sxx += (x[i] - mx) ** 2; }
    const rsd = Math.sqrt(ss / Math.max(n - 2, 1)), se = rsd / Math.sqrt(sxx), tau = (b - 1) / se;
    const meanRev = b < 1 && S.mackinnonP(tau, nvars, "c") < 0.05;
    if (!(b > 0 && b < 1)) return { a, b, meanRev, hl: Infinity, mu: S.mean(s), rsd, tau };
    const theta = -Math.log(b) / dt;
    return { a, b, theta, mu: a / (1 - b), hl: Math.log(2) / -Math.log(b), meanRev, rsd, tau,
             sigmaEq: rsd / Math.sqrt(1 - b * b) };
  };

  // ---------------------------------------------------------------- Bayesian model comparison (mean reversion vs random walk)
  function gammaln(z) {           // Lanczos approximation
    const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
      -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - gammaln(1 - z);
    z -= 1; let a = c[0]; const t = z + g + 0.5;
    for (let i = 1; i < g + 2; i++) a += c[i] / (z + i);
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
  }
  function nigLogml(y, X, m0, V0, a0, b0) {
    const k = m0.length, n = y.length, V0i = inv(V0);
    const prec = V0i.map((r) => [...r]);
    const xty = new Array(k).fill(0);
    for (let i = 0; i < n; i++) for (let p = 0; p < k; p++) { xty[p] += X[i][p] * y[i]; for (let q = 0; q < k; q++) prec[p][q] += X[i][p] * X[i][q]; }
    const Vn = inv(prec);
    const rhs = xty.map((v, p) => v + V0i[p].reduce((s, w, q) => s + w * m0[q], 0));
    const mn = Vn.map((r) => r.reduce((s, w, q) => s + w * rhs[q], 0));
    let yy = 0; for (const v of y) yy += v * v;
    const q0 = m0.reduce((s, v, p) => s + v * V0i[p].reduce((t, w, q) => t + w * m0[q], 0), 0);
    const qn = mn.reduce((s, v, p) => s + v * prec[p].reduce((t, w, q) => t + w * mn[q], 0), 0);
    const an = a0 + n / 2, bn = Math.max(b0 + 0.5 * (yy + q0 - qn), 1e-300);
    const det = (M) => (M.length === 1 ? M[0][0] : M[0][0] * M[1][1] - M[0][1] * M[1][0]);
    return -n / 2 * Math.log(2 * Math.PI) + 0.5 * (Math.log(det(Vn)) - Math.log(det(V0))) + a0 * Math.log(b0)
      - an * Math.log(bn) + gammaln(an) - gammaln(a0);
  }
  S.bayesPMR = (sin, fairValue = null, bPrior = 0.95, bSd = 0.05) => {
    const s = sin.filter(isF); if (s.length < 30) return NaN;
    const centre = fairValue === null ? S.mean(s) : fairValue;
    const d = s.map((v) => v - centre), y = d.slice(1), x = d.slice(0, -1);
    const dd = []; for (let i = 1; i < d.length; i++) dd.push(d[i] - d[i - 1]);
    const v = S.std(dd) ** 2 * (dd.length - 1) / dd.length + 1e-18, a0 = 2, b0 = v;
    const va = fairValue === null ? 0.05 : 0.01;
    const l1 = nigLogml(y, x.map((xi) => [1, xi]), [0, bPrior], [[va, 0], [0, bSd * bSd / v]], a0, b0);
    const l0 = nigLogml(y.map((yi, i) => yi - x[i]), y.map(() => [1]), [0], [[0.01]], a0, b0);
    const lo = Math.max(-700, Math.min(700, l1 - l0));
    return 1 / (1 + Math.exp(-lo));
  };

  // ---------------------------------------------------------------- spreads, z-scores and the backtester
  S.rollingMean = (a, w, minP) => {
    const out = new Array(a.length).fill(NaN); let s = 0, c = 0;
    for (let t = 0; t < a.length; t++) {
      if (isF(a[t])) { s += a[t]; c++; }
      if (t - w >= 0 && isF(a[t - w])) { s -= a[t - w]; c--; }
      if (c >= minP) out[t] = s / c;
    }
    return out;
  };
  S.rollingStd = (a, w, minP) => {
    const out = new Array(a.length).fill(NaN); let s = 0, s2 = 0, c = 0;
    for (let t = 0; t < a.length; t++) {
      if (isF(a[t])) { s += a[t]; s2 += a[t] * a[t]; c++; }
      if (t - w >= 0 && isF(a[t - w])) { s -= a[t - w]; s2 -= a[t - w] * a[t - w]; c--; }
      if (c >= minP && c > 1) out[t] = Math.sqrt(Math.max((s2 - s * s / c) / (c - 1), 0));
    }
    return out;
  };
  S.fairSeries = (rel) => {
    if (rel.fair_mode === "const") return rel.s.map(() => rel.fair_const);
    if (rel.fair_mode === "series") return rel.f;
    const w = rel.fair_window; return S.rollingMean(rel.s, w, Math.max(12, Math.floor(w / 4)));
  };
  S.zscore = (dev, lookback) => {
    const sd = S.rollingStd(dev, lookback, Math.max(10, Math.floor(lookback / 2)));
    return dev.map((v, i) => (isF(v) && isF(sd[i]) && sd[i] > 0 ? v / sd[i] : NaN));
  };
  const at = (x, i) => (Array.isArray(x) ? (isF(x[i]) ? x[i] : 0) : (isF(x) ? x : 0));

  S.positions = (z, dev, p, opts) => {
    const n = z.length, pos = new Array(n).fill(0);
    const bu = isF(opts.bandUp) ? opts.bandUp : Infinity, bd = isF(opts.bandDown) ? opts.bandDown : Infinity;
    const allowL = ["both", "long_only"].includes(opts.direction), allowS = ["both", "short_only"].includes(opts.direction);
    let cur = 0, held = 0, cool = false;
    for (let t = 0; t < n; t++) {
      const zt = z[t];
      if (!isF(zt) || opts.noTrade[t]) { cur = 0; held = 0; pos[t] = 0; continue; }
      if (cur !== 0) {
        held++;
        if (Math.abs(zt) <= p.exit || (cur > 0 && zt >= 0) || (cur < 0 && zt <= 0)) { cur = 0; held = 0; }
        else if (Math.abs(zt) >= p.stop) { cur = 0; held = 0; cool = true; }
        else if (held >= p.maxHold) { cur = 0; held = 0; cool = true; }
      }
      if (cur === 0) {
        if (cool && Math.abs(zt) < p.entry) cool = false;
        if (!cool && Math.abs(zt) >= p.entry && Math.abs(zt) < p.stop) {
          const d = dev[t];
          const okS = !p.useBand || !Number.isFinite(bu) || d > bu, okL = !p.useBand || !Number.isFinite(bd) || -d > bd;
          if (zt > 0 && allowS && okS) { cur = -1; held = 0; }
          else if (zt < 0 && allowL && okL) { cur = 1; held = 0; }
        }
      }
      pos[t] = cur;
    }
    return pos;
  };

  S.backtest = (rel, p, variant = null) => {
    const s = variant ? variant.s : rel.s, pnl = variant ? variant.pnl : rel.pnl, n = s.length;
    const base = Object.assign({}, rel, { s });
    const fair = S.fairSeries(base), dev = s.map((v, i) => (isF(v) && isF(fair[i]) ? v - fair[i] : NaN));
    const z = S.zscore(dev, p.lookback);
    const ntSet = new Set(rel.no_trade || []), rollSet = new Set(rel.roll || []);
    const nt = rel.d.map((d) => ntSet.has(d)); const ntMask = nt.map((v, i) => v || (i + 1 < n && nt[i + 1]));
    let target;
    if (rel.ctv) target = s.map((v, i) => (isF(v) && isF(rel.ctv[i]) && Math.abs(rel.ctv[i]) >= (p.minCtv ?? 0.25) ? Math.sign(v) : 0));
    else target = S.positions(z, dev, p, { bandUp: rel.band_up, bandDown: rel.band_down, direction: p.direction || rel.direction, noTrade: ntMask });
    const lag = p.lag, held = new Array(n).fill(0);
    for (let t = lag; t < n; t++) held[t] = target[t - lag];
    const out = { pos: held, gross: [], carry: [], hold: [], costs: [], net: [], conv: [], z, dev, fair };
    for (let t = 0; t < n; t++) {
      const prev = t > 0 ? held[t - 1] : 0;
      const pn = isF(pnl[t]) ? pnl[t] : 0, ds = t > 0 && isF(s[t]) && isF(s[t - 1]) ? s[t] - s[t - 1] : 0;
      const g = prev * pn, c = prev * at(rel.carry, t), h = Math.abs(prev) * at(rel.hold, t);
      const crt = at(rel.cost, t) * p.costMult;
      let cost = Math.abs(held[t] - prev) * crt / 2 + Math.abs(prev) * at(rel.rebal, t);
      if (rollSet.has(rel.d[t])) cost += Math.abs(prev) * crt;
      out.gross.push(g); out.carry.push(c); out.hold.push(-h); out.costs.push(-cost); out.net.push(g + c - h - cost);
      out.conv.push(rel.unit === rel.pnl_unit ? prev * ds : NaN);
    }
    out.trades = S.trades(out, rel, s);
    out.metrics = S.metrics(out, rel.freq === "M" ? 12 : 252);
    return out;
  };

  S.trades = (bt, rel, s) => {
    const pos = bt.pos, n = pos.length, rows = [];
    let t = 0;
    while (t < n) {
      if (pos[t] !== 0 && (t === 0 || pos[t - 1] !== pos[t])) {
        const st = t, d = pos[t]; let u = t + 1;
        while (u < n && pos[u] === d) u++;
        let net = bt.costs[st], gross = 0, cum = 0, mae = 0, mfe = 0, carry = 0, costs = bt.costs[st];
        for (let k = st + 1; k <= Math.min(u, n - 1); k++) {
          net += bt.net[k]; gross += bt.gross[k]; carry += bt.carry[k] + bt.hold[k]; costs += bt.costs[k];
          cum += bt.gross[k]; mae = Math.min(mae, cum); mfe = Math.max(mfe, cum);
        }
        rows.push({ entry: rel.d[st], exit: rel.d[Math.min(u, n - 1)], dir: d, z: bt.z[st], periods: u - st, net, gross,
                    carry, costs, mae, mfe, open: u >= n });
        t = u;
      } else t++;
    }
    return rows;
  };

  S.metrics = (bt, ppy) => {
    const net = bt.net, n = net.length;
    let sum = 0, gsum = 0, csum = 0, hsum = 0, ksum = 0, act = 0;
    for (let i = 0; i < n; i++) { sum += net[i]; gsum += bt.gross[i]; csum += bt.carry[i]; hsum += bt.hold[i]; ksum += bt.costs[i]; if (i > 0 && bt.pos[i - 1] !== 0) act++; }
    const sd = S.std(net), g = S.std(bt.gross), years = n / ppy;
    let cum = 0, peak = 0, mdd = 0; for (const v of net) { cum += v; peak = Math.max(peak, cum); mdd = Math.min(mdd, cum - peak); }
    const closed = bt.trades.filter((r) => !r.open);
    return {
      sharpe: sd > 0 ? (sum / n) / sd * Math.sqrt(ppy) : 0, grossSharpe: g > 0 ? (gsum / n) / g * Math.sqrt(ppy) : 0,
      netTotal: sum, grossTotal: gsum, carryTotal: csum, holdTotal: hsum, costTotal: ksum, netPerYear: sum / years,
      years, maxDD: mdd, trades: bt.trades.length, timeInMarket: act / n,
      hit: closed.length ? closed.filter((r) => r.net > 0).length / closed.length : NaN,
      avgNet: closed.length ? S.mean(closed.map((r) => r.net)) : NaN,
      maeMedian: closed.length ? S.median(closed.map((r) => r.mae)) : NaN,
      maeP95: closed.length ? S.quantile(closed.map((r) => r.mae), 0.05) : NaN,
      avgPeriods: closed.length ? S.mean(closed.map((r) => r.periods)) : NaN,
    };
  };

  S.episodes = (z, dev, entry, exit, horizon) => {
    const out = [];
    let t = 1;
    while (t < z.length) {
      if (isF(z[t]) && isF(z[t - 1]) && Math.abs(z[t]) >= entry && Math.abs(z[t - 1]) < entry) {
        const sign = Math.sign(z[t]); let end = null, worst = 0;
        for (let u = t + 1; u < Math.min(t + horizon, z.length); u++) {
          if (isF(dev[u])) worst = Math.max(worst, (dev[u] - dev[t]) * sign);
          if (isF(z[u]) && Math.abs(z[u]) <= exit) { end = u; break; }
        }
        out.push({ t, z: z[t], dev: dev[t], periods: end === null ? null : end - t, reverted: end !== null, mae: worst });
        t = (end || t) + 1;
      } else t++;
    }
    return out;
  };

  S.bh = (p) => {
    const m = p.length, idx = p.map((v, i) => i).sort((a, b) => p[a] - p[b]), q = new Array(m);
    let run = 1;
    for (let r = m - 1; r >= 0; r--) { run = Math.min(run, p[idx[r]] * m / (r + 1)); q[idx[r]] = Math.min(run, 1); }
    return q;
  };

  global.RVStats = S;
})(window);
