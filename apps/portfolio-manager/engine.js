/* qpm engine (browser port of the Python library in src/qpm).
   The QP solver, estimators and construction methods follow the Python code line by line so the demo
   and the research use the same algorithms; demo/tests.html checks parity against Python outputs.
   Units: annualised excess returns and covariances; weights are fractions of capital. */
(function (global) {
  "use strict";
  const INF = 1e20;

  /* ------------------------------------------------------------------ linear algebra */
  const zeros = (n, m) => Array.from({ length: n }, () => new Array(m).fill(0));
  const eye = (n) => { const a = zeros(n, n); for (let i = 0; i < n; i++) a[i][i] = 1; return a; };
  const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
  const matVec = (A, x) => A.map((row) => dot(row, x));
  const tMatVec = (A, y) => { const n = A[0] ? A[0].length : 0; const out = new Array(n).fill(0);
    for (let k = 0; k < A.length; k++) { const r = A[k], yk = y[k]; if (yk === 0) continue; for (let j = 0; j < n; j++) out[j] += r[j] * yk; } return out; };
  const transpose = (A) => A[0].map((_, j) => A.map((r) => r[j]));
  const matMul = (A, B) => { const Bt = transpose(B); return A.map((r) => Bt.map((c) => dot(r, c))); };
  const quad = (w, S) => dot(w, matVec(S, w));
  const sum = (a) => a.reduce((s, v) => s + v, 0);
  const absMax = (a) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const clip = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

  function cholesky(A) {
    const n = A.length, L = zeros(n, n);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j <= i; j++) {
        let s = A[i][j];
        for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
        if (i === j) { if (s <= 0) throw new Error("matrix not positive definite"); L[i][i] = Math.sqrt(s); }
        else L[i][j] = s / L[j][j];
      }
    }
    return L;
  }
  function cholSolve(L, b) {
    const n = L.length, y = new Array(n), x = new Array(n);
    for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i][k] * y[k]; y[i] = s / L[i][i]; }
    for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k]; x[i] = s / L[i][i]; }
    return x;
  }
  /* Gaussian elimination with partial pivoting; returns null when singular */
  function gaussSolve(A, b) {
    const n = A.length, M = A.map((r, i) => r.concat([b[i]]));
    for (let c = 0; c < n; c++) {
      let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      if (Math.abs(M[p][c]) < 1e-300) return null;
      [M[c], M[p]] = [M[p], M[c]];
      for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; if (f === 0) continue; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
    }
    const x = new Array(n);
    for (let i = n - 1; i >= 0; i--) { let s = M[i][n]; for (let k = i + 1; k < n; k++) s -= M[i][k] * x[k]; x[i] = s / M[i][i]; }
    return x.every(Number.isFinite) ? x : null;
  }
  function inverse(A) { const n = A.length, out = zeros(n, n), I = eye(n);
    const L = cholesky(A); for (let j = 0; j < n; j++) { const col = cholSolve(L, I[j]); for (let i = 0; i < n; i++) out[i][j] = col[i]; } return out; }
  /* Jacobi eigenvalue algorithm for symmetric matrices */
  function eigSym(S) {
    const n = S.length, A = S.map((r) => r.slice()), V = eye(n);
    for (let sweep = 0; sweep < 100; sweep++) {
      let off = 0; for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i][j] * A[i][j];
      if (off < 1e-22) break;
      for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
        if (Math.abs(A[p][q]) < 1e-300) continue;
        const th = (A[q][q] - A[p][p]) / (2 * A[p][q]);
        const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < n; k++) { const akp = A[k][p], akq = A[k][q]; A[k][p] = c * akp - s * akq; A[k][q] = s * akp + c * akq; }
        for (let k = 0; k < n; k++) { const apk = A[p][k], aqk = A[q][k]; A[p][k] = c * apk - s * aqk; A[q][k] = s * apk + c * aqk; }
        for (let k = 0; k < n; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq; }
      }
    }
    return { values: A.map((r, i) => r[i]), vectors: V };
  }
  function nearestPSD(S, floor = 1e-10) {
    const n = S.length, M = S.map((r, i) => r.map((v, j) => 0.5 * (v + S[j][i])));
    const { values, vectors } = eigSym(M), lo = floor * Math.max(...values, 1e-300);
    if (Math.min(...values) >= lo) return M;
    const vals = values.map((v) => Math.max(v, lo)), out = zeros(n, n);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { let s = 0; for (let k = 0; k < n; k++) s += vectors[i][k] * vals[k] * vectors[j][k]; out[i][j] = s; }
    return out;
  }

  /* ------------------------------------------------------------------ random numbers */
  function rng(seed) { let a = seed >>> 0; const next = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    let spare = null; next.normal = () => { if (spare !== null) { const s = spare; spare = null; return s; }
      let u = 0, v = 0; while (u === 0) u = next(); v = next(); const r = Math.sqrt(-2 * Math.log(u)); spare = r * Math.sin(2 * Math.PI * v); return r * Math.cos(2 * Math.PI * v); };
    next.chi2 = (df) => { let s = 0; for (let i = 0; i < df; i++) { const z = next.normal(); s += z * z; } return s; };
    return next; }

  /* ------------------------------------------------------------------ estimators (rows = periods) */
  function colMeans(R) { const n = R[0].length, m = new Array(n).fill(0); for (const r of R) for (let j = 0; j < n; j++) m[j] += r[j]; return m.map((v) => v / R.length); }
  function sampleCov(R, ddof = 1) { const t = R.length, n = R[0].length, m = colMeans(R), S = zeros(n, n);
    for (const r of R) for (let i = 0; i < n; i++) { const di = r[i] - m[i]; for (let j = i; j < n; j++) S[i][j] += di * (r[j] - m[j]); }
    for (let i = 0; i < n; i++) for (let j = i; j < n; j++) { S[i][j] /= (t - ddof); S[j][i] = S[i][j]; } return S; }
  function ewmaCov(R, halflife) { const t = R.length, n = R[0].length, lam = Math.pow(0.5, 1 / halflife);
    const w = Array.from({ length: t }, (_, i) => Math.pow(lam, t - 1 - i)), ws = sum(w); for (let i = 0; i < t; i++) w[i] /= ws;
    const m = new Array(n).fill(0); R.forEach((r, k) => r.forEach((v, j) => (m[j] += w[k] * v)));
    const S = zeros(n, n); R.forEach((r, k) => { for (let i = 0; i < n; i++) for (let j = i; j < n; j++) S[i][j] += w[k] * (r[i] - m[i]) * (r[j] - m[j]); });
    const corr = 1 - sum(w.map((v) => v * v)); for (let i = 0; i < n; i++) for (let j = i; j < n; j++) { S[i][j] /= corr; S[j][i] = S[i][j]; } return S; }
  /* Ledoit-Wolf (2003) constant-correlation shrinkage (port of covariance.ledoit_wolf_constant_correlation) */
  function lwConstantCorrelation(R) {
    const t = R.length, n = R[0].length, m = colMeans(R), X = R.map((r) => r.map((v, j) => v - m[j]));
    const S = zeros(n, n); for (const x of X) for (let i = 0; i < n; i++) for (let j = i; j < n; j++) S[i][j] += x[i] * x[j];
    for (let i = 0; i < n; i++) for (let j = i; j < n; j++) { S[i][j] /= t; S[j][i] = S[i][j]; }
    const sd = S.map((r, i) => Math.sqrt(r[i]));
    let rbar = 0; for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j) rbar += S[i][j] / (sd[i] * sd[j]); rbar /= n * (n - 1);
    const F = zeros(n, n); for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) F[i][j] = i === j ? S[i][i] : rbar * sd[i] * sd[j];
    let phi = 0, phiDiag = 0; const theta = zeros(n, n);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      let a = 0, b = 0; for (const x of X) { const p = x[i] * x[j] - S[i][j]; a += p * p; b += x[i] * x[i] * x[i] * x[j]; }
      a /= t; phi += a; if (i === j) phiDiag += a; theta[i][j] = b / t - S[i][i] * S[i][j];
    }
    let rho = phiDiag; for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j) rho += rbar * (sd[j] / sd[i]) * theta[i][j];
    let gamma = 0; for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) gamma += (F[i][j] - S[i][j]) ** 2;
    const kappa = gamma > 0 ? (phi - rho) / gamma : 0, d = clip(kappa / t, 0, 1);
    return { cov: S.map((r, i) => r.map((v, j) => d * F[i][j] + (1 - d) * v)), shrink: d };
  }
  function bayesStein(R) {
    const t = R.length, n = R[0].length, mu = colMeans(R);
    let S = sampleCov(R); if (t > n + 2) S = S.map((r) => r.map((v) => v * (t - 1) / (t - n - 2)));
    const inv = inverse(S), ones = new Array(n).fill(1), invOnes = matVec(inv, ones), invMu = matVec(inv, mu);
    const mu0 = dot(ones, invMu) / dot(ones, invOnes), d = mu.map((v) => v - mu0), denom = (n + 2) + t * dot(d, matVec(inv, d));
    const w = denom > 0 ? Math.min(1, (n + 2) / denom) : 1;
    return { mu: mu.map((v) => (1 - w) * v + w * mu0), w };
  }
  function estimateCov(R, method) {
    if (method === "sample") return sampleCov(R);
    if (method === "ewma") return ewmaCov(R, 36);
    return lwConstantCorrelation(R).cov;
  }

  /* ------------------------------------------------------------------ QP solver (port of optimize/qp.py) */
  function ruiz(P, q, A, iters) {
    const n = P.length, m = A.length; let D = new Array(n).fill(1), E = new Array(m).fill(1), c = 1;
    let Ps = P.map((r) => r.slice()), qs = q.slice(), As = A.map((r) => r.slice());
    for (let it = 0; it < iters; it++) {
      const colx = new Array(n).fill(0), rowz = new Array(m).fill(0);
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) colx[j] = Math.max(colx[j], Math.abs(Ps[i][j]));
      for (let k = 0; k < m; k++) for (let j = 0; j < n; j++) { const a = Math.abs(As[k][j]); colx[j] = Math.max(colx[j], a); rowz[k] = Math.max(rowz[k], a); }
      const dx = colx.map((v) => 1 / Math.sqrt(clip(v < 1e-8 ? 1 : v, 1e-4, 1e4))), dz = rowz.map((v) => 1 / Math.sqrt(clip(v < 1e-8 ? 1 : v, 1e-4, 1e4)));
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) Ps[i][j] *= dx[i] * dx[j];
      for (let j = 0; j < n; j++) qs[j] *= dx[j];
      for (let k = 0; k < m; k++) for (let j = 0; j < n; j++) As[k][j] *= dz[k] * dx[j];
      D = D.map((v, j) => v * dx[j]); E = E.map((v, k) => v * dz[k]);
      let meanCol = 0; for (let j = 0; j < n; j++) { let mx = 0; for (let i = 0; i < n; i++) mx = Math.max(mx, Math.abs(Ps[i][j])); meanCol += mx; } meanCol /= n || 1;
      let g = Math.max(meanCol, absMax(qs)); g = 1 / clip(g > 1e-8 ? g : 1, 1e-4, 1e4);
      for (let i = 0; i < n; i++) { qs[i] *= g; for (let j = 0; j < n; j++) Ps[i][j] *= g; } c *= g;
    }
    return { Ps, qs, As, D, E, c };
  }
  function rhoVector(l, u, rho) { return l.map((li, k) => (Math.abs(u[k] - li) < 1e-10 ? 1e3 * rho : (li <= -INF / 2 && u[k] >= INF / 2 ? 1e-6 : rho))); }
  function factorK(Ps, As, rhoVec, sigma) { const n = Ps.length, K = Ps.map((r) => r.slice());
    for (let i = 0; i < n; i++) K[i][i] += sigma;
    for (let k = 0; k < As.length; k++) { const a = As[k], rk = rhoVec[k]; for (let i = 0; i < n; i++) { if (a[i] === 0) continue; const ai = rk * a[i]; for (let j = 0; j < n; j++) K[i][j] += ai * a[j]; } }
    return cholesky(K); }
  function polish(P, q, A, l, u, x, y, tol = 1e-9, rounds = 12) {
    const n = P.length, m = A.length, z = matVec(A, x);
    const eq = l.map((li, k) => Math.abs(u[k] - li) < 1e-10);
    let lower = eq.map((e, k) => (e ? y[k] <= 0 : z[k] - l[k] < -y[k]) && l[k] > -INF / 2);
    let upper = eq.map((e, k) => (e ? y[k] > 0 : u[k] - z[k] < y[k]) && u[k] < INF / 2 && !lower[k]);
    let scale = 1; for (let k = 0; k < m; k++) { if (l[k] > -INF / 2) scale = Math.max(scale, Math.abs(l[k])); if (u[k] < INF / 2) scale = Math.max(scale, Math.abs(u[k])); }
    for (let r = 0; r < rounds; r++) {
      const act = []; for (let k = 0; k < m; k++) if (lower[k] || upper[k]) act.push(k);
      const kk = act.length, N = n + kk, KKT = zeros(N, N), rhs = new Array(N).fill(0);
      for (let i = 0; i < n; i++) { for (let j = 0; j < n; j++) KKT[i][j] = P[i][j]; rhs[i] = -q[i]; }
      act.forEach((k, a) => { for (let j = 0; j < n; j++) { KKT[j][n + a] = A[k][j]; KKT[n + a][j] = A[k][j]; } rhs[n + a] = lower[k] ? l[k] : u[k]; });
      let sol = gaussSolve(KKT, rhs);
      if (!sol) { const reg = KKT.map((row, i) => row.map((v, j) => (i === j ? v + (i < n ? 1e-10 : -1e-10) : v)));
        sol = gaussSolve(reg, rhs); if (!sol) return null;
        for (let it = 0; it < 5; it++) { const res = rhs.map((b, i) => b - dot(KKT[i], sol)), corr = gaussSolve(reg, res); if (!corr) break; sol = sol.map((v, i) => v + corr[i]); } }
      const xp = sol.slice(0, n), yp = new Array(m).fill(0); act.forEach((k, a) => (yp[k] = sol[n + a]));
      const zp = matVec(A, xp);
      const violLo = l.map((li, k) => li - zp[k] > tol * scale && !lower[k] && !upper[k] && li > -INF / 2);
      const violHi = u.map((ui, k) => zp[k] - ui > tol * scale && !lower[k] && !upper[k] && ui < INF / 2);
      const wrongLo = lower.map((v, k) => v && !eq[k] && yp[k] > tol), wrongHi = upper.map((v, k) => v && !eq[k] && yp[k] < -tol);
      if (!violLo.some(Boolean) && !violHi.some(Boolean) && !wrongLo.some(Boolean) && !wrongHi.some(Boolean)) return { x: xp, y: yp, z: zp };
      if (wrongLo.some(Boolean) || wrongHi.some(Boolean)) { let worst = -1, wv = -Infinity;
        for (let k = 0; k < m; k++) { const b = (wrongLo[k] ? yp[k] : 0) - (wrongHi[k] ? yp[k] : 0); if (b > wv) { wv = b; worst = k; } }
        lower[worst] = upper[worst] = false; }
      lower = lower.map((v, k) => v || violLo[k]); upper = upper.map((v, k) => v || violHi[k]);
    }
    return null;
  }
  function solveQP(P, q, A, l, u, opts = {}) {
    const n = q.length, eps = opts.eps ?? 1e-8, maxIter = opts.maxIter ?? 20000, sigma = 1e-6, alpha = 1.6, checkEvery = 5;
    let rho = 0.1;
    P = P.map((r, i) => r.map((v, j) => 0.5 * (v + P[j][i])));
    l = l.map((v) => clip(v, -INF, INF)); u = u.map((v) => clip(v, -INF, INF));
    const m = A.length;
    if (l.some((v, k) => v > u[k] + 1e-12)) return { x: new Array(n).fill(NaN), y: new Array(m).fill(0), z: [], status: "primal_infeasible", iterations: 0 };
    const { Ps, qs, As, D, E, c } = ruiz(P, q, A, 10);
    const ls = l.map((v, k) => (v > -INF / 2 ? E[k] * v : -INF)), us = u.map((v, k) => (v < INF / 2 ? E[k] * v : INF));
    let rhoVec = rhoVector(ls, us, rho), L = factorK(Ps, As, rhoVec, sigma);
    let x = opts.x0 ? opts.x0.map((v, j) => v / D[j]) : new Array(n).fill(0);
    let z = matVec(As, x).map((v, k) => clip(v, ls[k], us[k])), y = new Array(m).fill(0);
    let status = "max_iter", primRes = Infinity, dualRes = Infinity, it = 0;
    for (it = 1; it <= maxIter; it++) {
      const tmp = z.map((zk, k) => rhoVec[k] * zk - y[k]), rhs = tMatVec(As, tmp).map((v, j) => sigma * x[j] - qs[j] + v);
      const xt = cholSolve(L, rhs), zt = matVec(As, xt);
      const xNew = xt.map((v, j) => alpha * v + (1 - alpha) * x[j]);
      const zRelax = zt.map((v, k) => alpha * v + (1 - alpha) * z[k]);
      const zNew = zRelax.map((v, k) => clip(v + y[k] / rhoVec[k], ls[k], us[k]));
      const yNew = y.map((v, k) => v + rhoVec[k] * (zRelax[k] - zNew[k]));
      const dy = yNew.map((v, k) => v - y[k]);
      x = xNew; z = zNew; y = yNew;
      if (it % checkEvery && it !== maxIter) continue;
      const axs = matVec(As, x), pxs = matVec(Ps, x), atys = tMatVec(As, y);
      primRes = 0; for (let k = 0; k < m; k++) primRes = Math.max(primRes, Math.abs((axs[k] - z[k]) / E[k]));
      dualRes = 0; for (let j = 0; j < n; j++) dualRes = Math.max(dualRes, Math.abs((pxs[j] + qs[j] + atys[j]) / (c * D[j])));
      let nAx = 0, nZ = 0; for (let k = 0; k < m; k++) { nAx = Math.max(nAx, Math.abs(axs[k] / E[k])); nZ = Math.max(nZ, Math.abs(z[k] / E[k])); }
      let nPx = 0, nAty = 0, nQ = 0; for (let j = 0; j < n; j++) { const s = c * D[j]; nPx = Math.max(nPx, Math.abs(pxs[j] / s)); nAty = Math.max(nAty, Math.abs(atys[j] / s)); nQ = Math.max(nQ, Math.abs(qs[j] / s)); }
      if (primRes <= eps + eps * Math.max(nAx, nZ) && dualRes <= eps + eps * Math.max(nPx, nAty, nQ)) { status = "solved"; break; }
      if (it > 50) { /* primal infeasibility certificate */
        const dyu = dy.map((v, k) => E[k] * v / c), ndy = absMax(dyu);
        if (ndy > 1e-12) { const atdy = absMax(tMatVec(A, dyu));
          let bad = false, sup = 0; for (let k = 0; k < m; k++) { const fh = u[k] < INF / 2, fl = l[k] > -INF / 2;
            if ((!fh && dyu[k] > 1e-9 * ndy) || (!fl && dyu[k] < -1e-9 * ndy)) bad = true;
            sup += (fh ? u[k] : 0) * Math.max(dyu[k], 0) + (fl ? l[k] : 0) * Math.min(dyu[k], 0); }
          if (!bad && atdy <= 1e-6 * ndy && sup < -1e-6 * ndy) { status = "primal_infeasible"; break; } }
      }
      if (it % (5 * checkEvery) === 0) {
        let pn = 1e-12, dn = 1e-12, ps = 0, ds = 0;
        for (let k = 0; k < m; k++) { pn = Math.max(pn, Math.abs(axs[k]), Math.abs(z[k])); ps = Math.max(ps, Math.abs(axs[k] - z[k])); }
        for (let j = 0; j < n; j++) { dn = Math.max(dn, Math.abs(pxs[j]), Math.abs(atys[j]), Math.abs(qs[j])); ds = Math.max(ds, Math.abs(pxs[j] + qs[j] + atys[j])); }
        ps /= pn; ds /= dn;
        if (ds > 1e-14) { const nr = clip(rho * Math.sqrt(ps / ds), 1e-6, 1e6);
          if (nr > 5 * rho || nr < rho / 5) { rho = nr; rhoVec = rhoVector(ls, us, rho); L = factorK(Ps, As, rhoVec, sigma); } }
      }
    }
    let xu = x.map((v, j) => D[j] * v), yu = y.map((v, k) => E[k] * v / c), zu = z.map((v, k) => v / E[k]), polished = false;
    if (status === "primal_infeasible") return { x: xu, y: yu, z: zu, status, iterations: it };
    const out = polish(P, q, A, l, u, xu, yu);
    if (out) {
      let pr = 0; for (let k = 0; k < m; k++) pr = Math.max(pr, l[k] - out.z[k], out.z[k] - u[k], 0);
      const st = matVec(P, out.x).map((v, j) => v + q[j]), aty = tMatVec(A, out.y); let dr = 0; for (let j = 0; j < n; j++) dr = Math.max(dr, Math.abs(st[j] + aty[j]));
      const tol = 1e-7 * Math.max(1, absMax(q), Math.max(...P.map(absMax)));
      if (pr <= Math.max(tol, primRes) && dr <= Math.max(tol, dualRes)) { xu = out.x; yu = out.y; zu = out.z; polished = true; status = "solved"; }
    }
    if (status === "max_iter" && primRes < 1e-4 && dualRes < 1e-4) status = "solved_inaccurate";
    return { x: xu, y: yu, z: zu, status, iterations: it, polished };
  }

  /* ------------------------------------------------------------------ constraints (port of constraints.py, subset) */
  const vec = (v, n, dflt) => (v === null || v === undefined ? new Array(n).fill(dflt) : Array.isArray(v) ? v.slice() : new Array(n).fill(v));
  function bounds(cons, n) {
    const lo = cons.lower === null ? new Array(n).fill(-INF) : vec(cons.lower ?? 0, n, -INF);
    const hi = cons.upper === null || cons.upper === undefined ? new Array(n).fill(INF) : vec(cons.upper, n, INF);
    return { lo, hi };
  }
  function checkFeasibility(cons, names) {
    const n = names.length, { lo, hi } = bounds(cons, n), msgs = [];
    lo.forEach((v, i) => { if (v > hi[i] + 1e-12) msgs.push(`${names[i]}: floor ${pct(v)} is above cap ${pct(hi[i])}`); });
    if (cons.budget !== null && cons.budget !== undefined) {
      const loSum = sum(lo.map((v) => (v > -INF / 2 ? v : -Infinity))), hiSum = sum(hi.map((v) => (v < INF / 2 ? v : Infinity)));
      if (loSum > cons.budget + 1e-9) msgs.push(`position floors add up to ${pct(loSum)}, above the ${pct(cons.budget)} budget`);
      if (hiSum < cons.budget - 1e-9) msgs.push(`position caps add up to ${pct(hiSum)}, below the ${pct(cons.budget)} budget: raise the caps or allow cash`);
    }
    for (const g of cons.groups || []) { if (g.min !== null && g.max !== null && g.min > g.max + 1e-12) msgs.push(`group ${g.name}: minimum above maximum`); }
    return msgs;
  }
  function buildQP(Pw, qw, cons, names, extraRows = []) {
    const n = names.length, { lo, hi } = bounds(cons, n), longOnly = lo.every((v) => v >= -1e-15);
    const tc = cons.tradeCost ? vec(cons.tradeCost, n, 0) : null;
    const needT = cons.turnoverMax != null || (tc && tc.some((v) => v !== 0)), needG = cons.grossMax != null && !longOnly;
    const wPrev = cons.wPrev ? cons.wPrev.slice() : new Array(n).fill(0);
    const nv = n + (needT ? n : 0) + (needG ? n : 0), tOff = n, gOff = n + (needT ? n : 0);
    const rows = [], L = [], U = [], labels = [];
    const add = (row, a, b, lab) => { rows.push(row); L.push(a); U.push(b); labels.push(lab); };
    const blank = () => new Array(nv).fill(0);
    for (let i = 0; i < n; i++) { const r = blank(); r[i] = 1; add(r, lo[i], hi[i], `bound:${names[i]}`); }
    { const r = blank(); for (let i = 0; i < n; i++) r[i] = 1;
      if (cons.budget !== null && cons.budget !== undefined) add(r, cons.budget, cons.budget, "budget");
      else if (cons.netMin != null || cons.netMax != null) add(r, cons.netMin ?? -INF, cons.netMax ?? INF, "net"); }
    for (const g of cons.groups || []) { if ((g.min ?? -INF) <= -INF / 2 && (g.max ?? INF) >= INF / 2) continue;
      const r = blank(); g.members.forEach((i) => (r[i] = 1)); add(r, g.min ?? -INF, g.max ?? INF, `group:${g.name}`); }
    for (const f of cons.factors || []) { const r = blank(); f.betas.forEach((b, i) => (r[i] = b)); add(r, f.min ?? -INF, f.max ?? INF, `factor:${f.name}`); }
    const q = new Array(nv).fill(0); for (let i = 0; i < n; i++) q[i] = qw[i];
    if (needT) {
      for (let i = 0; i < n; i++) { let r = blank(); r[i] = 1; r[tOff + i] = -1; add(r, -INF, wPrev[i], `trade+:${names[i]}`);
        r = blank(); r[i] = -1; r[tOff + i] = -1; add(r, -INF, -wPrev[i], `trade-:${names[i]}`); }
      if (cons.turnoverMax != null) { const r = blank(); for (let i = 0; i < n; i++) r[tOff + i] = 1; add(r, -INF, cons.turnoverMax, "turnover"); }
      if (tc) for (let i = 0; i < n; i++) q[tOff + i] = tc[i];
    }
    if (needG) {
      for (let i = 0; i < n; i++) { let r = blank(); r[i] = 1; r[gOff + i] = -1; add(r, -INF, 0, `gross+:${names[i]}`);
        r = blank(); r[i] = -1; r[gOff + i] = -1; add(r, -INF, 0, `gross-:${names[i]}`); }
      const r = blank(); for (let i = 0; i < n; i++) r[gOff + i] = 1; add(r, -INF, cons.grossMax, "gross");
    } else if (cons.grossMax != null) { const r = blank(); for (let i = 0; i < n; i++) r[i] = 1; add(r, -INF, cons.grossMax, "gross"); }
    for (const [lab, rw, a, b] of extraRows) { const r = blank(); rw.forEach((v, i) => (r[i] = v)); add(r, a, b, lab); }
    const P = zeros(nv, nv); for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) P[i][j] = Pw[i][j];
    for (let i = n; i < nv; i++) P[i][i] = 1e-10;
    return { P, q, A: rows, l: L, u: U, labels, n, names };
  }
  function binding(prob, sol, tol = 1e-7) {
    const out = []; prob.labels.forEach((lab, k) => { const y = sol.y[k]; if (Math.abs(y) <= tol) return;
      out.push({ constraint: lab, side: y > 0 ? "upper" : "lower", bound: y > 0 ? prob.u[k] : prob.l[k], shadow: Math.abs(y), value: sol.z[k] }); });
    return out.sort((a, b) => b.shadow - a.shadow);
  }

  /* ------------------------------------------------------------------ portfolios */
  function riskContrib(w, S) { const sw = matVec(S, w), v = dot(w, sw); return v > 0 ? w.map((wi, i) => wi * sw[i] / v) : w.map(() => 0); }
  function finish(w, mu, S, method, status = "closed_form", extra = {}) {
    const vol = Math.sqrt(Math.max(quad(w, S), 0)), er = mu ? dot(w, mu) : null;
    return Object.assign({ weights: w.map((v) => (Math.abs(v) < 1e-12 ? 0 : v)), method, status, expectedReturn: er, volatility: vol,
      sharpe: er !== null && vol > 0 ? er / vol : null, riskContrib: riskContrib(w, S), binding: [], messages: [], info: {} }, extra);
  }
  const ok = (p) => p.status === "solved" || p.status === "solved_inaccurate" || p.status === "closed_form";
  function qpPortfolio(Pw, qw, mu, S, names, cons, method, lam, x0) {
    const msgs = checkFeasibility(cons, names), prob = buildQP(Pw, qw, cons, names), sol = solveQP(prob.P, prob.q, prob.A, prob.l, prob.u, { x0 });
    if (!(sol.status === "solved" || sol.status === "solved_inaccurate"))
      return { weights: names.map(() => NaN), method, status: sol.status, messages: msgs.length ? msgs : [`solver: ${sol.status}`], info: { problem: prob, solution: sol }, binding: [] };
    const n = names.length, w = sol.x.slice(0, n);
    const p = finish(w, mu, S, method, sol.status);
    p.binding = binding(prob, sol); p.messages = msgs;
    const aty = tMatVec(prob.A.map((r) => r.slice(0, n)), sol.y);
    p.muEff = qw.map((v, i) => -v - aty[i]);
    p.info = { problem: prob, solution: sol, lambda: lam, iterations: sol.iterations, polished: sol.polished };
    return p;
  }
  const equalWeight = (S, mu) => finish(S.map(() => 1 / S.length), mu, S, "equal_weight");
  const inverseVol = (S, mu) => { const inv = S.map((r, i) => 1 / Math.sqrt(r[i])), s = sum(inv); return finish(inv.map((v) => v / s), mu, S, "inverse_vol"); };
  const minVariance = (S, cons, names, mu) => qpPortfolio(S, S.map(() => 0), mu, S, names, cons, "min_variance", 1);
  function meanVariance(mu, S, lam, cons, names) {
    let p = qpPortfolio(S.map((r) => r.map((v) => lam * v)), mu.map((v) => -v), mu, S, names, cons, "mean_variance", lam);
    if (cons.maxVol == null || !ok(p) || p.volatility <= cons.maxVol * (1 + 1e-9)) return p;
    let lo = lam, hi = lam, best = null;
    for (let i = 0; i < 60; i++) { hi *= 2; const q = qpPortfolio(S.map((r) => r.map((v) => hi * v)), mu.map((v) => -v), mu, S, names, cons, "mean_variance", hi, p.weights);
      if (!ok(q)) break; if (q.volatility <= cons.maxVol) { best = q; break; } lo = hi; }
    if (!best) { const mv = minVariance(S, cons, names, mu); mv.method = "mean_variance";
      if (ok(mv) && mv.volatility > cons.maxVol) { mv.status = "vol_cap_infeasible"; mv.messages.push(`even the minimum-variance portfolio has volatility ${pct(mv.volatility)}, above the ${pct(cons.maxVol)} cap`); }
      return mv; }
    for (let i = 0; i < 50 && hi / lo > 1 + 1e-9; i++) { const mid = Math.sqrt(lo * hi);
      const q = qpPortfolio(S.map((r) => r.map((v) => mid * v)), mu.map((v) => -v), mu, S, names, cons, "mean_variance", mid, best.weights);
      if (ok(q) && q.volatility <= cons.maxVol) { hi = mid; best = q; } else lo = mid; }
    best.messages.push(`risk aversion raised from ${lam} to ${best.info.lambda.toFixed(2)} to meet the ${pct(cons.maxVol)} volatility cap`);
    return best;
  }
  /* exact max Sharpe as one homogenized QP (port of methods._max_sharpe_homogenized) */
  function maxSharpe(mu, S, cons, names) {
    if (cons.budget === null || cons.budget === undefined) throw new Error("max Sharpe needs a budget");
    const base = buildQP(S, S.map(() => 0), Object.assign({}, cons, { tradeCost: null }), names), n = names.length, nv = base.P.length;
    const rows = [], lo = [], hi = [];
    base.A.forEach((a, k) => { const l = base.l[k], u = base.u[k]; if (l <= -INF / 2 && u >= INF / 2) return;
      if (Math.abs(u - l) < 1e-12) { rows.push(a.concat([-l])); lo.push(0); hi.push(0); return; }
      if (l > -INF / 2) { rows.push(a.concat([-l])); lo.push(0); hi.push(INF); }
      if (u < INF / 2) { rows.push(a.concat([-u])); lo.push(-INF); hi.push(0); } });
    const r1 = new Array(nv + 1).fill(0); for (let i = 0; i < n; i++) r1[i] = mu[i]; rows.push(r1); lo.push(1); hi.push(1);
    const r2 = new Array(nv + 1).fill(0); r2[nv] = 1; rows.push(r2); lo.push(0); hi.push(INF);
    const P = zeros(nv + 1, nv + 1); for (let i = 0; i < nv; i++) for (let j = 0; j < nv; j++) P[i][j] = base.P[i][j]; P[nv][nv] = 1e-12;
    const sol = solveQP(P, new Array(nv + 1).fill(0), rows, lo, hi);
    if (!(sol.status === "solved" || sol.status === "solved_inaccurate") || sol.x[nv] <= 1e-12) {
      const p = meanVariance(mu, S, 4, cons, names); p.method = "max_sharpe"; p.messages.push("no portfolio has a positive expected excess return; showing mean-variance instead"); return p; }
    const w = sol.x.slice(0, n).map((v) => v / sol.x[nv]), v2 = quad(w, S), lam = v2 > 0 ? dot(w, mu) / v2 : 1;
    let p = qpPortfolio(S.map((r) => r.map((v) => lam * v)), mu.map((v) => -v), mu, S, names, cons, "max_sharpe", lam);
    if (!ok(p) || Math.max(...p.weights.map((v, i) => Math.abs(v - w[i]))) > 1e-6) p = finish(w, mu, S, "max_sharpe", "solved");
    return p;
  }
  function ercWeights(S, budgets, tol = 1e-12, maxIter = 10000) {
    const n = S.length, b = budgets ? budgets.map((v) => v / sum(budgets)) : new Array(n).fill(1 / n), d = S.map((r, i) => r[i]);
    let y = d.map((v) => 1 / Math.sqrt(v)); const s0 = Math.sqrt(quad(y, S)); y = y.map((v) => v / s0);
    for (let it = 0; it < maxIter; it++) {
      for (let i = 0; i < n; i++) { const c = dot(S[i], y) - d[i] * y[i]; y[i] = (-c + Math.sqrt(c * c + 4 * d[i] * b[i])) / (2 * d[i]); }
      const sy = matVec(S, y), rc = y.map((v, i) => v * sy[i]), t = sum(rc);
      if (Math.max(...rc.map((v, i) => Math.abs(v / t - b[i]))) < tol) break;
    }
    const s = sum(y); return y.map((v) => v / s);
  }
  /* HRP: single linkage on distance of distances, quasi-diagonal order, recursive bisection */
  function linkage(Dm) {
    const n = Dm.length, big = 2 * n - 1, M = zeros(big, big).map((r) => r.fill(Infinity)), size = new Array(big).fill(0);
    for (let i = 0; i < n; i++) { size[i] = 1; for (let j = 0; j < n; j++) if (i !== j) M[i][j] = Dm[i][j]; }
    let active = Array.from({ length: n }, (_, i) => i); const Z = [];
    for (let k = 0; k < n - 1; k++) {
      const ids = active.slice().sort((a, b) => a - b); let best = Infinity, bi = 0, bj = 1;
      for (let i = 0; i < ids.length; i++) for (let j = 0; j < ids.length; j++) { if (i === j) continue; const v = M[ids[i]][ids[j]]; if (v < best) { best = v; bi = i; bj = j; } }
      let a = ids[bi], b = ids[bj]; if (a > b) [a, b] = [b, a];
      const nw = n + k; size[nw] = size[a] + size[b]; Z.push([a, b, best, size[nw]]);
      for (const c of active) { if (c === a || c === b) continue; const v = Math.min(M[a][c], M[b][c]); M[nw][c] = M[c][nw] = v; }
      active = active.filter((c) => c !== a && c !== b).concat([nw]);
    }
    return Z;
  }
  function quasiDiag(Z) { const n = Z.length + 1; let order = [Z[Z.length - 1][0], Z[Z.length - 1][1]];
    while (order.some((i) => i >= n)) order = order.flatMap((i) => (i >= n ? [Z[i - n][0], Z[i - n][1]] : [i])); return order; }
  function clusterVar(S, idx) { const ivp = idx.map((i) => 1 / S[i][i]), s = sum(ivp), w = ivp.map((v) => v / s); let v = 0;
    idx.forEach((i, a) => idx.forEach((j, b) => (v += w[a] * w[b] * S[i][j]))); return v; }
  function hrpWeights(S) {
    const n = S.length, sd = S.map((r, i) => Math.sqrt(r[i]));
    const d = S.map((r, i) => r.map((v, j) => Math.sqrt(clip((1 - clip(v / (sd[i] * sd[j]), -1, 1)) / 2, 0, Infinity))));
    const dd = d.map((ri) => d.map((rj) => Math.sqrt(sum(ri.map((v, k) => (v - rj[k]) ** 2)))));
    const Z = linkage(dd), order = quasiDiag(Z), w = new Array(n).fill(1), splits = [];
    let clusters = [order];
    while (clusters.length) {
      clusters = clusters.flatMap((c) => (c.length > 1 ? [c.slice(0, Math.floor(c.length / 2)), c.slice(Math.floor(c.length / 2))] : []));
      for (let i = 0; i < clusters.length; i += 2) { const L0 = clusters[i], R0 = clusters[i + 1], vl = clusterVar(S, L0), vr = clusterVar(S, R0), a = 1 - vl / (vl + vr);
        L0.forEach((k) => (w[k] *= a)); R0.forEach((k) => (w[k] *= 1 - a)); splits.push({ left: L0, right: R0, alpha: a }); }
    }
    return { w, order, splits, Z };
  }
  function blPosterior(S, wMkt, P, Q, conf, tau = 0.05, delta = 2.5) {
    const s = sum(wMkt), w = wMkt.map((v) => v / s), pi = matVec(S, w).map((v) => delta * v), n = S.length;
    const tS = S.map((r) => r.map((v) => tau * v));
    if (!P || !P.length) return { pi, mu: pi.slice(), cov: S.map((r, i) => r.map((v, j) => v + tS[i][j])) };
    const PtS = matMul(P, tS), base = matMul(PtS, transpose(P)), k = P.length;
    const omega = base.map((r, i) => r.map((v, j) => (i === j ? ((1 - clip(conf[i], 1e-6, 1)) / clip(conf[i], 1e-6, 1)) * base[i][i] : 0)));
    const Mx = base.map((r, i) => r.map((v, j) => v + omega[i][j] + (i === j ? 1e-14 : 0))), Minv = inverse(Mx);
    const gain = matMul(transpose(PtS), Minv);           // tau S P' (P tau S P' + Omega)^-1  (n x k)
    const resid = Q.map((q, i) => q - dot(P[i], pi)), mu = pi.map((v, i) => v + dot(gain[i], resid));
    const post = tS.map((r, i) => r.map((v, j) => { let s2 = 0; for (let a = 0; a < k; a++) s2 += gain[i][a] * PtS[a][j]; return v - s2; }));
    return { pi, mu, cov: S.map((r, i) => r.map((v, j) => v + post[i][j])), priorView: P.map((r) => dot(r, pi)), posteriorView: P.map((r) => dot(r, mu)) };
  }

  /* methods: names follow the Python registry */
  function optimize(method, ctx) {
    const { mu, cov: S, names } = ctx, cons = ctx.cons || { lower: 0 }, lam = ctx.riskAversion ?? 4;
    switch (method) {
      case "equal_weight": return equalWeight(S, mu);
      case "market_cap": { const w = ctx.marketWeights, s = sum(w); return finish(w.map((v) => v / s), mu, S, "market_cap"); }
      case "inverse_vol": return inverseVol(S, mu);
      case "min_variance": return minVariance(S, cons, names, mu);
      case "erc": return finish(ercWeights(S), mu, S, "erc");
      case "hrp": { const h = hrpWeights(S), p = finish(h.w, mu, S, "hrp"); p.info = { order: h.order, splits: h.splits }; return p; }
      case "mean_variance": return meanVariance(mu, S, lam, cons, names);
      case "max_sharpe": return maxSharpe(mu, S, cons, names);
      case "black_litterman": { const post = blPosterior(S, ctx.marketWeights, ctx.views?.P, ctx.views?.Q, ctx.views?.conf, 0.05, 2.5);
        const p = meanVariance(post.mu, post.cov, 2.5, cons, names); p.method = "black_litterman";
        if (ok(p)) { p.volatility = Math.sqrt(quad(p.weights, S)); p.sharpe = p.expectedReturn / p.volatility; p.riskContrib = riskContrib(p.weights, S); }
        p.info.bl = post; return p; }
      case "kelly": case "kelly_half": { const f = method === "kelly" ? 1 : 0.5;
        const kc = Object.assign({}, cons, { budget: null, netMin: 0, netMax: ctx.kellyLeverage ?? 1.5 });
        const p = meanVariance(mu, S, 1 / f, kc, names); p.method = method; if (ok(p)) p.info.logGrowth = p.expectedReturn - 0.5 * p.volatility ** 2; return p; }
      case "vol_target": { const base = optimize(ctx.baseMethod || "erc", ctx); if (!ok(base)) return base;
        const vol = base.volatility, gross = sum(base.weights.map(Math.abs)); let k = vol > 0 ? (ctx.targetVol ?? 0.1) / vol : 0;
        k = Math.min(k, (ctx.maxLeverage ?? 1) / gross); const p = finish(base.weights.map((v) => k * v), mu, S, "vol_target"); p.info = { scale: k, base: base.method }; return p; }
      case "factor_neutral": { const fc = Object.assign({}, cons, { budget: 0, lower: -(ctx.lsCap ?? 0.25), upper: ctx.lsCap ?? 0.25, grossMax: cons.grossMax ?? 2,
          factors: (ctx.factorBetas || []).map((f) => ({ name: f.name, betas: f.betas, min: 0, max: 0 })) });
        const p = meanVariance(mu, S, lam, fc, names); p.method = "factor_neutral"; return p; }
      case "constrained": { const p = meanVariance(mu, S, lam, cons, names); p.method = "constrained"; return p; }
      default: throw new Error("unknown method " + method);
    }
  }

  /* ------------------------------------------------------------------ explanation (port of explain.py) */
  function explain(p, S, names, labels = {}) {
    const n = names.length, rows = names.map((a, i) => ({ asset: a, label: labels[a] || a, weight: p.weights[i], riskShare: p.riskContrib ? p.riskContrib[i] : 0 }));
    const out = { method: p.method, rows, sentences: {}, hurdle: null };
    if (p.info && p.info.problem && ok(p)) {
      const prob = p.info.problem, sol = p.info.solution, lam = p.info.lambda;
      const families = {};
      prob.labels.forEach((lab, k) => { const y = sol.y[k]; if (Math.abs(y) < 1e-12) return; const row = prob.A[k].slice(0, n); if (!row.some((v) => v !== 0)) return;
        let fam = lab.split(":")[0]; fam = { bound: "position limits", budget: "budget", net: "net exposure", "trade+": "trading", "trade-": "trading", "gross+": "gross exposure", "gross-": "gross exposure" }[fam] || lab;
        families[fam] = families[fam] || new Array(n).fill(0); for (let i = 0; i < n; i++) families[fam][i] -= row[i] * y; });
      const muIn = prob.q.slice(0, n).map((v) => -v), muEff = muIn.map((v, i) => v + Object.values(families).reduce((s, a) => s + a[i], 0));
      const theta = inverse(S), own = {};
      prob.labels.forEach((lab, k) => { if (lab.startsWith("bound:")) own[lab.slice(6)] = sol.y[k]; });
      const bindMap = Object.fromEntries((p.binding || []).map((b) => [b.constraint, b]));
      rows.forEach((r, i) => {
        const s2 = 1 / theta[i][i]; let hedge = 0, betas = [];
        for (let j = 0; j < n; j++) if (j !== i) { const b = -theta[i][j] * s2; hedge += b * muEff[j]; betas.push([names[j], b]); }
        betas.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
        Object.assign(r, { inputReturn: muIn[i], adjustments: Object.fromEntries(Object.entries(families).map(([k, a]) => [k, a[i]])), effectiveReturn: muEff[i],
          hedgeReturn: hedge, uniqueReturn: muEff[i] - hedge, residualVol: Math.sqrt(s2), totalVol: Math.sqrt(S[i][i]), r2: 1 - s2 / S[i][i],
          topHedges: betas.slice(0, 3), weightFromFormula: (muEff[i] - hedge) / s2 / lam });
        r.uniqueUnbounded = r.uniqueReturn + (own[r.asset] || 0);
        const cap = bindMap[`bound:${r.asset}`];
        let why;
        if (cap && cap.side === "upper") why = `at its ${pct(cap.bound, 0)} cap. Net of what the other holdings already deliver it would earn ${spct(r.uniqueUnbounded)} a year, so the optimizer wants more; the cap costs ${pct(cap.shadow)} of expected return at the margin`;
        else if (cap) why = `held at ${Math.abs(cap.bound) < 1e-12 ? "zero" : "its " + pct(cap.bound, 0) + " floor"}: net of what the other holdings already deliver its expected return is ${spct(r.uniqueUnbounded)} a year, so the optimizer would go lower if allowed`;
        else if (Math.abs(r.weight) < 1e-9) why = "no position";
        else why = `its return not explained by the other assets is ${spct(r.uniqueReturn)} a year, against ${pct(r.residualVol)} of volatility the others can't hedge (R² ${pct(r.r2, 0)})`;
        out.sentences[r.asset] = `${r.label}: ${pct(r.weight)}, ${why}.`;
      });
      if (families.budget) out.hurdle = families.budget[0];
      out.families = Object.keys(families);
    } else if (p.method === "erc") {
      rows.forEach((r) => (out.sentences[r.asset] = `${r.label}: ${pct(r.weight)}, sized so that it contributes ${pct(r.riskShare)} of portfolio risk, the same as every other asset.`));
    } else if (p.method === "hrp") {
      rows.forEach((r) => (out.sentences[r.asset] = `${r.label}: ${pct(r.weight)}, from splitting capital between clusters of similar assets in inverse proportion to each cluster's variance.`));
    } else if (p.method === "inverse_vol") {
      rows.forEach((r, i) => (out.sentences[r.asset] = `${r.label}: ${pct(r.weight)}, proportional to 1 / volatility (${pct(Math.sqrt(S[i][i]))}); correlations are ignored.`));
    } else {
      rows.forEach((r) => (out.sentences[r.asset] = `${r.label}: ${pct(r.weight)}.`));
    }
    out.implied = matVec(S, p.weights).map((v) => v * (p.info?.lambda || 2.5));
    return out;
  }

  /* ------------------------------------------------------------------ frontier */
  function efficientFrontier(mu, S, cons, names, nPoints = 30) {
    const mv = minVariance(S, cons, names, mu); if (!ok(mv)) return { points: [], status: mv.status };
    const topProb = buildQP(S.map((r) => r.map((v) => 1e-6 * v)), mu.map((v) => -v), cons, names), top = solveQP(topProb.P, topProb.q, topProb.A, topProb.l, topProb.u);
    const n = names.length, rMin = dot(mv.weights, mu), rMax = dot(top.x.slice(0, n), mu), pts = []; let x0 = null;
    for (let k = 0; k < nPoints; k++) { const target = rMin + (rMax - rMin) * k / (nPoints - 1);
      const prob = buildQP(S, S.map(() => 0), cons, names, [["target", mu, target, INF]]), sol = solveQP(prob.P, prob.q, prob.A, prob.l, prob.u, { x0 });
      if (!(sol.status === "solved" || sol.status === "solved_inaccurate")) continue; x0 = sol.x;
      const w = sol.x.slice(0, n), vol = Math.sqrt(Math.max(quad(w, S), 0)); pts.push({ ret: dot(w, mu), vol, w }); }
    return { points: pts, status: "solved" };
  }

  /* ------------------------------------------------------------------ risk */
  const quantile = (arr, p) => { const a = arr.slice().sort((x, y) => x - y), h = (a.length - 1) * p, lo = Math.floor(h), hi = Math.ceil(h); return a[lo] + (a[hi] - a[lo]) * (h - lo); };
  const meanOf = (a) => sum(a) / a.length;
  const stdOf = (a) => { const m = meanOf(a); return Math.sqrt(sum(a.map((v) => (v - m) ** 2)) / (a.length - 1)); };
  function normInv(p) { /* Acklam's rational approximation */
    const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239],
      b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1],
      c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783],
      d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
    const pl = 0.02425; let q, r;
    if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    if (p > 1 - pl) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    q = p - 0.5; r = q * q; return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  const normPdf = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
  function varReport(port, alpha = 0.99, seed = 7, portVol = null) {
    const m = meanOf(port), s = stdOf(port), z = normInv(1 - alpha), cut = quantile(port, 1 - alpha);
    const tail = port.filter((v) => v <= cut), n = port.length;
    const m2 = sum(port.map((v) => (v - m) ** 2)) / n;   /* population moments, as scipy.stats.skew / kurtosis */
    const sk = sum(port.map((v) => (v - m) ** 3)) / n / Math.pow(m2, 1.5), ku = sum(port.map((v) => (v - m) ** 4)) / n / (m2 * m2) - 3;
    const zcf = z + (z * z - 1) * sk / 6 + (z ** 3 - 3 * z) * ku / 24 - (2 * z ** 3 - 5 * z) * sk * sk / 36;
    const r = rng(seed), df = 5, sims = []; for (let i = 0; i < 20000; i++) { const t = r.normal() / Math.sqrt(r.chi2(df) / df) * Math.sqrt((df - 2) / df); sims.push(m + s * t); }
    const mcCut = quantile(sims, 1 - alpha), mcTail = sims.filter((v) => v <= mcCut);
    return { historical: -cut, historicalES: tail.length ? -meanOf(tail) : -cut, normal: -(m + z * s), normalES: -m + s * normPdf(z) / (1 - alpha),
      cornishFisher: -(m + zcf * s), monteCarloT: -mcCut, monteCarloTES: -meanOf(mcTail), skew: sk, kurtosis: ku, months: n };
  }
  function olsBetas(Y, X) { /* Y: T x n, X: T x k -> n x k betas (with intercept) */
    const t = X.length, k = X[0].length, D = X.map((r) => [1].concat(r)), DtD = zeros(k + 1, k + 1);
    for (const r of D) for (let i = 0; i <= k; i++) for (let j = 0; j <= k; j++) DtD[i][j] += r[i] * r[j];
    const inv = inverse(DtD.map((r, i) => r.map((v, j) => v + (i === j ? 1e-12 : 0)))), n = Y[0].length, B = zeros(n, k), resid = new Array(n).fill(0);
    for (let a = 0; a < n; a++) { const dty = new Array(k + 1).fill(0); D.forEach((r, s) => { for (let i = 0; i <= k; i++) dty[i] += r[i] * Y[s][a]; });
      const coef = matVec(inv, dty); for (let j = 0; j < k; j++) B[a][j] = coef[j + 1];
      let ss = 0; D.forEach((r, s) => { const e = Y[s][a] - dot(r, coef); ss += e * e; }); resid[a] = ss / Math.max(1, t - k - 1); }
    return { betas: B, residVar: resid };
  }
  function concentration(w, S) { const g = sum(w.map(Math.abs)), sh = w.map((v) => Math.abs(v) / g), hhi = sum(sh.map((v) => v * v)), vol = Math.sqrt(quad(w, S));
    const { values, vectors } = eigSym(S), pc = values.map((_, k) => dot(vectors.map((r) => r[k]), w)), risk = pc.map((v, k) => v * v * values[k]), tr = sum(risk);
    const p = risk.map((v) => v / tr).filter((v) => v > 1e-15);
    return { hhi, effectiveN: 1 / hhi, maxWeight: Math.max(...w.map(Math.abs)), diversificationRatio: sum(w.map((v, i) => Math.abs(v) * Math.sqrt(S[i][i]))) / vol,
      effectiveBets: Math.exp(-sum(p.map((v) => v * Math.log(v)))) }; }
  function drawdowns(rets) { let wealth = 1, peak = 1, maxDD = 0; const dd = rets.map((r) => { wealth *= 1 + r; peak = Math.max(peak, wealth); const d = wealth / peak - 1; maxDD = Math.min(maxDD, d); return d; });
    return { dd, maxDD: -maxDD }; }

  /* ------------------------------------------------------------------ stress (port of risk/stress.py) */
  function runScenario(w, sc, ctx) {
    const { assets, betas, factorNames, returns, dates, cov, groups } = ctx, n = assets.length;
    let moves = new Array(n).fill(sc.default_shock || 0), extra = {};
    if (sc.kind === "historical") {
      const s = sc.start.slice(0, 7), e = sc.end.slice(0, 7), idx = dates.map((d, i) => (d >= s && d <= e ? i : -1)).filter((i) => i >= 0);
      if (!idx.length) return { pnl: NaN, moves, error: "no data in window" };
      moves = assets.map((_, j) => idx.reduce((g, i) => g * (1 + returns[i][j]), 1) - 1);
    } else {
      if (sc.factor_shocks && Object.keys(sc.factor_shocks).length) {
        moves = assets.map((_, i) => factorNames.reduce((s, f, k) => s + (sc.factor_shocks[f] ?? 0) * betas[i][k], 0)); }
      if (sc.group_shocks && groups) assets.forEach((a, i) => { if (sc.group_shocks[groups[a]] !== undefined) moves[i] = sc.group_shocks[groups[a]]; });
      assets.forEach((a, i) => { if (sc.asset_shocks && sc.asset_shocks[a] !== undefined) moves[i] = sc.asset_shocks[a]; });
      if (sc.kind === "volatility") {
        const sd = cov.map((r, i) => Math.sqrt(r[i])), wgt = sc.correlation_weight ?? 0.5, tgt = sc.correlation_target;
        let st = cov.map((r, i) => r.map((v, j) => { let c = v / (sd[i] * sd[j]); if (tgt !== null && tgt !== undefined && i !== j) c = (1 - wgt) * c + wgt * tgt; return c * sd[i] * sd[j] * (sc.vol_multiplier ** 2); }));
        st = nearestPSD(st); const h = (sc.horizon_months || 1) / 12, z = normInv(0.99);
        const vb = Math.sqrt(quad(w, cov) * h), vs = Math.sqrt(quad(w, st) * h);
        extra = { baseVol: vb, stressedVol: vs, stressedVaR: -z * vs, stressedES: vs * normPdf(z) / 0.01 };
      }
    }
    const contrib = w.map((wi, i) => wi * moves[i]);
    return Object.assign({ pnl: sum(contrib), moves, contrib }, extra);
  }

  /* ------------------------------------------------------------------ walk-forward backtest (port of backtest/engine.py) */
  function backtest(spec) {
    const { returns: R, rf, dates, window = 120, every = 1, costs, method, cons, mean = "sample", covMethod = "lw_cc", riskAversion = 4, marketWeights, start = null } = spec;
    const T = R.length, n = R[0].length; let first = window; if (start) { const k = dates.indexOf(start); if (k > first) first = k; }
    let w = new Array(n).fill(0); const net = [], gross = [], to = [], cst = [], outDates = [], wHist = [];
    let errors = 0;
    for (let t = first; t < T - 1; t++) {
      let cost = 0;
      if ((t - first) % every === 0) {
        const hist = R.slice(t + 1 - window, t + 1).map((r, i) => r.map((v) => v - rf[t + 1 - window + i]));
        let target;
        try {
          if (method === "equal_weight") target = new Array(n).fill(1 / n);
          else if (method === "market_cap") target = marketWeights(t);
          else {
            const S = estimateCov(hist, covMethod).map((r) => r.map((v) => v * 12));
            const mu = mean === "bayes_stein" ? bayesStein(hist).mu.map((v) => v * 12) : colMeans(hist).map((v) => v * 12);
            const p = optimize(method, { mu, cov: S, names: spec.names, cons: Object.assign({}, cons, cons.turnoverMax != null ? { wPrev: w } : {}), riskAversion,
              marketWeights: marketWeights ? marketWeights(t) : null, kellyLeverage: spec.kellyLeverage });
            if (!ok(p)) throw new Error(p.status);
            target = p.weights;
          }
        } catch (e) { errors++; target = w.slice(); }
        const traded = target.map((v, i) => Math.abs(v - w[i]));
        cost = sum(traded.map((v, i) => v * costs[i] / 1e4));
        w = target; to.push(sum(traded)); cst.push(cost); wHist.push({ date: dates[t], w: w.slice() });
      }
      const r = R[t + 1], cash = 1 - sum(w), port = dot(w, r) + cash * rf[t + 1] - 0.003 / 12 * sum(w.map((v) => Math.max(-v, 0)));
      outDates.push(dates[t + 1]); gross.push(port); net.push((1 - cost) * (1 + port) - 1);
      const grow = w.map((v, i) => v * (1 + r[i])); w = grow.map((v) => v / (1 + port));
    }
    return { dates: outDates, net, gross, turnover: to, costs: cst, weights: wHist, errors, rf: rf.slice(first + 1, T) };
  }
  function perfStats(net, rf, perYear = 12) {
    const ex = net.map((v, i) => v - rf[i]), n = net.length, yrs = n / perYear, growth = net.reduce((g, v) => g * (1 + v), 1);
    const mu = meanOf(ex) * perYear, vol = stdOf(net) * Math.sqrt(perYear), exVol = stdOf(ex) * Math.sqrt(perYear), { maxDD } = drawdowns(net);
    return { annReturn: Math.pow(growth, 1 / yrs) - 1, annExcess: mu, volatility: vol, sharpe: mu / exVol, maxDrawdown: maxDD, months: n };
  }

  /* ------------------------------------------------------------------ signal combination (IC-based, port of signals/combine.py subset) */
  function combineWeights(icHistory, method, opts = {}) {
    /* icHistory: {source: [monthly ICs, oldest first]} ; returns {source: weight} */
    const names = Object.keys(icHistory), K = names.length, eq = Object.fromEntries(names.map((k) => [k, 1 / K]));
    if (method === "equal") return eq;
    if (method === "confidence") { const c = names.map((k) => opts.confidence?.[k] ?? 0.5), s = sum(c); return Object.fromEntries(names.map((k, i) => [k, c[i] / s])); }
    const means = names.map((k) => meanOf(icHistory[k])), vars = names.map((k) => stdOf(icHistory[k]) ** 2 / icHistory[k].length);
    let raw;
    if (method === "ic_weighted") { const hl = opts.halflife ?? 36; raw = names.map((k) => { const a = icHistory[k]; let num = 0, den = 0;
        a.forEach((v, i) => { const wt = Math.pow(0.5, (a.length - 1 - i) / hl); num += wt * v; den += wt; }); return num / den; }); }
    else if (method === "shrunk") { const g = meanOf(means), tau2 = Math.max(0, stdOf(means) ** 2 - meanOf(vars));
      raw = means.map((m, i) => { const b = tau2 > 0 ? vars[i] / (vars[i] + tau2) : 1; return g + (1 - b) * (m - g); }); }
    else if (method === "mean_var") { const T = Math.min(...names.map((k) => icHistory[k].length)), X = Array.from({ length: T }, (_, t) => names.map((k) => icHistory[k][icHistory[k].length - T + t]));
      const C = sampleCov(X).map((r, i) => r.map((v, j) => (i === j ? v : 0.5 * v))); raw = matVec(inverse(C), means); }
    else throw new Error("unknown combination " + method);
    const pos = raw.map((v) => Math.max(v, 0)), s = sum(pos);
    return s > 0 ? Object.fromEntries(names.map((k, i) => [k, pos[i] / s])) : eq;
  }

  /* ------------------------------------------------------------------ formatting helpers */
  const nz = (v, d) => (Math.abs(v * 100) < 0.5 * Math.pow(10, -d) ? 0 : v);   /* no "-0.0%" */
  function pct(v, d = 1) { return Number.isFinite(v) ? (nz(v, d) * 100).toFixed(d).replace(/^-/, "−") + "%" : "–"; }
  function spct(v, d = 2) { if (!Number.isFinite(v)) return "–"; v = nz(v, d); return (v >= 0 ? "+" : "−") + Math.abs(v * 100).toFixed(d) + "%"; }

  global.QPM = { INF, zeros, eye, dot, matVec, matMul, transpose, quad, sum, cholesky, cholSolve, gaussSolve, inverse, eigSym, nearestPSD, rng,
    colMeans, sampleCov, ewmaCov, lwConstantCorrelation, bayesStein, estimateCov, solveQP, buildQP, checkFeasibility, binding,
    equalWeight, inverseVol, minVariance, meanVariance, maxSharpe, ercWeights, hrpWeights, linkage, quasiDiag, blPosterior, optimize, ok,
    riskContrib, explain, efficientFrontier, quantile, meanOf, stdOf, normInv, varReport, olsBetas, concentration, drawdowns,
    runScenario, backtest, perfStats, combineWeights, pct, spct };
})(typeof window !== "undefined" ? window : globalThis);
