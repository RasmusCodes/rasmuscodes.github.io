// Alpha Combination Lab - browser engine.
// A JavaScript port of the repository's synthetic generator, combination methods and walk-forward protocol
// (src/alphacomb). Deterministic for a given seed. Linear methods are checked against the Python implementation
// in tests.html (fixtures written by scripts/export_demo_fixtures.py); the tree learners are simplified
// histogram versions of the LightGBM models used in the study.

// ------------------------------------------------------------------ random numbers
export function makeRng(seed) {
  let a = (seed >>> 0) || 1;
  const uniform = () => {                       // mulberry32
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let spare = null;
  const normal = () => {
    if (spare !== null) { const s = spare; spare = null; return s; }
    let u = 0, v = 0;
    while (u <= 1e-300) u = uniform();
    v = uniform();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
  const int = (n) => Math.floor(uniform() * n);
  return { uniform, normal, int };
}

// ------------------------------------------------------------------ small dense linear algebra
export const zeros = (n, m) => Array.from({ length: n }, () => new Float64Array(m));
export const eye = (n) => { const I = zeros(n, n); for (let i = 0; i < n; i++) I[i][i] = 1; return I; };
export const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
export function matVec(A, x) { const out = new Float64Array(A.length); for (let i = 0; i < A.length; i++) out[i] = dot(A[i], x); return out; }
export function quad(A, x) { return dot(x, matVec(A, x)); }
export function clone(A) { return A.map((r) => Float64Array.from(r)); }

export function lu(A) {
  const n = A.length, M = clone(A), piv = Array.from({ length: n }, (_, i) => i);
  let sign = 1;
  for (let k = 0; k < n; k++) {
    let p = k, mx = Math.abs(M[k][k]);
    for (let i = k + 1; i < n; i++) if (Math.abs(M[i][k]) > mx) { mx = Math.abs(M[i][k]); p = i; }
    if (p !== k) { [M[p], M[k]] = [M[k], M[p]]; [piv[p], piv[k]] = [piv[k], piv[p]]; sign = -sign; }
    const d = M[k][k];
    if (Math.abs(d) < 1e-300) continue;
    for (let i = k + 1; i < n; i++) {
      const f = (M[i][k] /= d);
      if (f !== 0) for (let j = k + 1; j < n; j++) M[i][j] -= f * M[k][j];
    }
  }
  return { M, piv, sign };
}

export function solve(A, b) {
  const n = A.length, { M, piv } = lu(A), x = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = b[piv[i]]; for (let j = 0; j < i; j++) s -= M[i][j] * x[j]; x[i] = s; }
  for (let i = n - 1; i >= 0; i--) {
    let s = x[i];
    for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j];
    x[i] = Math.abs(M[i][i]) < 1e-300 ? 0 : s / M[i][i];
  }
  return x;
}

export function inverse(A) {
  const n = A.length, out = zeros(n, n);
  for (let j = 0; j < n; j++) { const e = new Float64Array(n); e[j] = 1; const c = solve(A, e); for (let i = 0; i < n; i++) out[i][j] = c[i]; }
  return out;
}

export function logdet(A) {
  const { M } = lu(A);
  let s = 0;
  for (let i = 0; i < A.length; i++) s += Math.log(Math.abs(M[i][i]));
  return s;
}

export function cholesky(A) {
  const n = A.length, L = zeros(n, n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) { if (s <= 1e-12) return null; L[i][i] = Math.sqrt(s); } else L[i][j] = s / L[j][j];
    }
  }
  return L;
}

// Jacobi eigenvalue algorithm for small symmetric matrices: returns {values (desc), vectors (columns)}
export function eigSym(A) {
  const n = A.length, a = clone(A), v = eye(n);
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
    if (off < 1e-22) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(a[p][q]) < 1e-300) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) {
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < n; k++) {
        const apk = a[p][k], aqk = a[q][k];
        a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < n; k++) {
        const vkp = v[k][p], vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  const idx = Array.from({ length: n }, (_, i) => i).sort((i, j) => a[j][j] - a[i][i]);
  return { values: idx.map((i) => a[i][i]), vectors: idx.map((i) => Float64Array.from(v.map((r) => r[i]))) };
}

// Nearest positive-definite correlation matrix by eigenvalue clipping (for visitor-edited correlations)
export function nearestCorrelation(C, floor = 1e-3) {
  const { values, vectors } = eigSym(C), n = C.length, out = zeros(n, n);
  for (let k = 0; k < n; k++) {
    const l = Math.max(values[k], floor);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) out[i][j] += l * vectors[k][i] * vectors[k][j];
  }
  const d = Array.from({ length: n }, (_, i) => Math.sqrt(out[i][i]));
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) out[i][j] /= d[i] * d[j];
  return out;
}

// ------------------------------------------------------------------ statistics helpers
export function ranks(x) {
  const idx = Array.from(x, (_, i) => i).sort((i, j) => x[i] - x[j]);
  const r = new Float64Array(x.length);
  for (let a = 0; a < idx.length;) {
    let b = a;
    while (b + 1 < idx.length && x[idx[b + 1]] === x[idx[a]]) b++;
    const avg = (a + b) / 2 + 1;
    for (let k = a; k <= b; k++) r[idx[k]] = avg;
    a = b + 1;
  }
  return r;
}
export function corr(a, b) {
  const n = a.length; let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; sab += da * db; saa += da * da; sbb += db * db; }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : NaN;
}
export const rankCorr = (a, b) => corr(ranks(a), ranks(b));
export const mean = (x) => { let s = 0, n = 0; for (const v of x) if (Number.isFinite(v)) { s += v; n++; } return n ? s / n : NaN; };
export function sd(x) {
  const m = mean(x); let s = 0, n = 0;
  for (const v of x) if (Number.isFinite(v)) { s += (v - m) ** 2; n++; }
  return n > 1 ? Math.sqrt(s / (n - 1)) : NaN;
}
export const sharpe = (x, per = 12) => mean(x) / sd(x) * Math.sqrt(per);
export function nwT(x) {
  const v = x.filter(Number.isFinite), T = v.length; if (T < 5) return NaN;
  const m = mean(v), u = v.map((e) => e - m), L = Math.floor(4 * (T / 100) ** (2 / 9));
  let s = dot(u, u) / T;
  for (let l = 1; l <= L; l++) { let g = 0; for (let t = l; t < T; t++) g += u[t] * u[t - l]; s += 2 * (1 - l / (L + 1)) * g / T; }
  return m / Math.sqrt(Math.max(s, 1e-300) / T);
}
export function stationaryIdx(T, block, rng) {
  const out = new Int32Array(T);
  out[0] = rng.int(T);
  for (let t = 1; t < T; t++) out[t] = rng.uniform() < 1 / block ? rng.int(T) : (out[t - 1] + 1) % T;
  return out;
}
export function bootstrapCI(fn, series, B = 500, block = 6, seed = 1) {
  const rng = makeRng(seed), T = series[0].length, draws = [];
  for (let b = 0; b < B; b++) {
    const idx = stationaryIdx(T, block, rng);
    draws.push(fn(...series.map((s) => Array.from(idx, (i) => s[i]))));
  }
  draws.sort((a, b) => a - b);
  return [draws[Math.floor(0.025 * B)], draws[Math.floor(0.975 * B)]];
}

// ------------------------------------------------------------------ synthetic world
// signals: [{name, family, ic, persistence}]; corr: K x K correlation (PD); the true linear weights are
// w = C^-1 ic, so each signal's standalone correlation with returns equals its ic and the oracle IC is
// sqrt(ic' C^-1 ic).
export function simulate(cfg) {
  const { N, T, signals, seed = 1 } = cfg;
  const K = signals.length, rng = makeRng(seed);
  let C = cfg.corr;
  let L = cholesky(C);
  if (!L) { C = nearestCorrelation(C); L = cholesky(C); }
  const ic = Float64Array.from(signals.map((s) => s.ic));
  let w = solve(C, ic);
  let r2 = dot(ic, w);
  if (r2 > 0.25) { const f = Math.sqrt(0.25 / r2); for (let k = 0; k < K; k++) { w[k] *= f; ic[k] *= f; } r2 = 0.25; }
  const nonlin = cfg.nonlinear || 0, regimeOn = !!cfg.regime, decayOn = !!cfg.decay;
  const famIndex = families(signals);
  // regime chain (observable)
  const reg = new Int8Array(T);
  for (let t = 1; t < T; t++) reg[t] = rng.uniform() < (cfg.regimeStay ?? 0.95) ? reg[t - 1] : 1 - reg[t - 1];
  const phi = signals.map((s) => s.persistence ?? 0.8);
  const nf = 3, fs = cfg.factorShare ?? 0.3;
  const lam = Array.from({ length: N }, () => Array.from({ length: nf }, () => rng.normal()));
  const X = new Float64Array(T * N * K), ret = new Float64Array(T * N), oracle = new Float64Array(T * N);
  const trueW = zeros(T, K);
  const z = zeros(N, K), e = new Float64Array(K);
  for (let i = 0; i < N; i++) { for (let k = 0; k < K; k++) e[k] = rng.normal(); for (let k = 0; k < K; k++) { let s = 0; for (let j = 0; j <= k; j++) s += L[k][j] * e[j]; z[i][k] = s; } }
  const firstFam = famIndex[0]?.idx ?? [0];
  for (let t = 0; t < T; t++) {
    if (t > 0) for (let i = 0; i < N; i++) {
      for (let k = 0; k < K; k++) e[k] = rng.normal();
      for (let k = 0; k < K; k++) { let s = 0; for (let j = 0; j <= k; j++) s += L[k][j] * e[j]; z[i][k] = phi[k] * z[i][k] + Math.sqrt(1 - phi[k] ** 2) * s; }
    }
    // true weights this month
    const wt = Float64Array.from(w);
    if (regimeOn && reg[t] === 1) for (const k of firstFam) wt[k] = -1.5 * w[k];
    if (decayOn && t >= T / 2) for (let k = 0; k < K; k++) if (signals[k].decays) wt[k] = 0;
    trueW[t] = wt;
    const mu = new Float64Array(N);
    for (let i = 0; i < N; i++) mu[i] = dot(z[i], wt);
    if (nonlin > 0 && K >= 3) {
      const nl = new Float64Array(N);
      for (let i = 0; i < N; i++) nl[i] = z[i][0] * z[i][1] + (Math.abs(z[i][2]) - Math.sqrt(2 / Math.PI));
      standardizeInPlace(nl); standardizeInPlace(mu);
      for (let i = 0; i < N; i++) mu[i] = Math.sqrt(1 - nonlin) * mu[i] + Math.sqrt(nonlin) * nl[i];
    } else standardizeInPlace(mu);
    const icOracle = Math.sqrt(r2);
    const F = Array.from({ length: nf }, () => rng.normal());
    for (let i = 0; i < N; i++) {
      let common = 0; for (let f = 0; f < nf; f++) common += lam[i][f] * F[f];
      const u = Math.sqrt(fs) * common / Math.sqrt(nf) + Math.sqrt(1 - fs) * rng.normal();
      ret[t * N + i] = 0.08 * (icOracle * mu[i] + Math.sqrt(1 - icOracle * icOracle) * u);
      oracle[t * N + i] = mu[i];
      for (let k = 0; k < K; k++) X[(t * N + i) * K + k] = z[i][k];
    }
  }
  // cross-sectional standardization of each signal and of the target, month by month
  const y = new Float64Array(T * N);
  for (let t = 0; t < T; t++) {
    for (let k = 0; k < K; k++) {
      let m = 0, s = 0;
      for (let i = 0; i < N; i++) m += X[(t * N + i) * K + k];
      m /= N;
      for (let i = 0; i < N; i++) s += (X[(t * N + i) * K + k] - m) ** 2;
      s = Math.sqrt(s / N) || 1;
      for (let i = 0; i < N; i++) X[(t * N + i) * K + k] = (X[(t * N + i) * K + k] - m) / s;
    }
    let m = 0, s = 0;
    for (let i = 0; i < N; i++) m += ret[t * N + i];
    m /= N;
    for (let i = 0; i < N; i++) s += (ret[t * N + i] - m) ** 2;
    s = Math.sqrt(s / N) || 1;
    for (let i = 0; i < N; i++) y[t * N + i] = (ret[t * N + i] - m) / s;
  }
  return { N, T, K, X, y, ret, oracle, regime: reg, trueW, weights: w, icOracle: Math.sqrt(r2),
           names: signals.map((s) => s.name), fams: famIndex, families: signals.map((s) => s.family) };
}

function standardizeInPlace(a) {
  const n = a.length; let m = 0, s = 0;
  for (let i = 0; i < n; i++) m += a[i];
  m /= n;
  for (let i = 0; i < n; i++) s += (a[i] - m) ** 2;
  s = Math.sqrt(s / n) || 1;
  for (let i = 0; i < n; i++) a[i] = (a[i] - m) / s;
}

export function families(signals) {
  const map = new Map();
  signals.forEach((s, k) => { if (!map.has(s.family)) map.set(s.family, []); map.get(s.family).push(k); });
  return [...map.entries()].map(([name, idx]) => ({ name, idx }));
}

export function correlationFromFamilies(signals, rhoWithin, rhoBetween, overrides = {}) {
  const K = signals.length, C = zeros(K, K);
  for (let i = 0; i < K; i++) for (let j = 0; j < K; j++) {
    if (i === j) C[i][j] = 1;
    else {
      const key = i < j ? `${i},${j}` : `${j},${i}`;
      C[i][j] = key in overrides ? overrides[key] : (signals[i].family === signals[j].family ? rhoWithin : rhoBetween);
    }
  }
  return C;
}

// ------------------------------------------------------------------ per-month moments (as in Moments.from_panel)
export function moments(W) {
  const { N, T, K, X, y, ret } = W;
  const G = [], c = [], yy = new Float64Array(T), n = new Float64Array(T), fm = [], ic = [], fret = [];
  for (let t = 0; t < T; t++) {
    const Gt = zeros(K, K), ct = new Float64Array(K);
    let syy = 0;
    for (let i = 0; i < N; i++) {
      const o = (t * N + i) * K, yi = y[t * N + i];
      for (let a = 0; a < K; a++) { const xa = X[o + a]; ct[a] += xa * yi; for (let b = a; b < K; b++) Gt[a][b] += xa * X[o + b]; }
      syy += yi * yi;
    }
    for (let a = 0; a < K; a++) for (let b = 0; b < a; b++) Gt[a][b] = Gt[b][a];
    G.push(Gt); c.push(ct); yy[t] = syy; n[t] = N;
    fm.push(solve(Gt, ct));
    const ict = new Float64Array(K), fr = new Float64Array(K);
    let rm = 0; for (let i = 0; i < N; i++) rm += ret[t * N + i]; rm /= N;
    for (let k = 0; k < K; k++) {
      ict[k] = ct[k] / Math.sqrt(Gt[k][k] * syy);
      let s = 0; for (let i = 0; i < N; i++) s += X[(t * N + i) * K + k] * (ret[t * N + i] - rm);
      fr[k] = s / N;
    }
    ic.push(ict); fret.push(fr);
  }
  return { G, c, yy, n, fm, ic, fret, K, T };
}

function sums(mom, months) {
  const K = mom.K, G = zeros(K, K), c = new Float64Array(K);
  let yy = 0, n = 0;
  for (const t of months) {
    for (let a = 0; a < K; a++) { c[a] += mom.c[t][a]; for (let b = 0; b < K; b++) G[a][b] += mom.G[t][a][b]; }
    yy += mom.yy[t]; n += mom.n[t];
  }
  return { G, c, yy, n };
}

export function deff(mom, months) {
  if (months.length <= 24) return 1;
  const { G, c, yy, n } = sums(mom, months);
  const b = solve(G, c);
  const s2 = Math.max((yy - 2 * dot(b, c) + quad(G, b)) / n, 1e-12);
  const Ginv = inverse(G), K = mom.K;
  const ratios = [];
  for (let k = 0; k < K; k++) {
    const v = months.map((t) => mom.fm[t][k]);
    const m = mean(v), vf = v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1) / v.length;
    ratios.push(vf / Math.max(s2 * Ginv[k][k], 1e-300));
  }
  ratios.sort((a, b) => a - b);
  const med = K % 2 ? ratios[(K - 1) / 2] : (ratios[K / 2 - 1] + ratios[K / 2]) / 2;
  return Math.max(1, med);
}

function ridgeMoments(G, c, n, lam) {
  const K = c.length, A = zeros(K, K), b = new Float64Array(K);
  for (let i = 0; i < K; i++) { b[i] = c[i] / n; for (let j = 0; j < K; j++) A[i][j] = G[i][j] / n + (i === j ? lam : 0); }
  return solve(A, b);
}

export function enetMoments(G, c, n, lam, alpha, tol = 1e-12, maxIter = 20000) {
  const K = c.length, b = new Float64Array(K), l1 = lam * alpha, l2 = lam * (1 - alpha);
  for (let it = 0; it < maxIter; it++) {
    let maxd = 0;
    for (let j = 0; j < K; j++) {
      const gjj = G[j][j] / n;
      if (gjj <= 0) { b[j] = 0; continue; }
      let r = c[j] / n;
      for (let k = 0; k < K; k++) r -= G[j][k] / n * b[k];
      r += gjj * b[j];
      const nb = Math.sign(r) * Math.max(Math.abs(r) - l1, 0) / (gjj + l2);
      maxd = Math.max(maxd, Math.abs(nb - b[j]));
      b[j] = nb;
    }
    if (maxd < tol) break;
  }
  return b;
}

// Ledoit-Wolf (2004) shrinkage to a scaled identity, as scikit-learn's LedoitWolf
function ledoitWolf(F) {
  const n = F.length, p = F[0].length, m = new Float64Array(p);
  for (const row of F) for (let j = 0; j < p; j++) m[j] += row[j] / n;
  const Xc = F.map((row) => Float64Array.from(row, (v, j) => v - m[j]));
  const S = zeros(p, p);
  for (const x of Xc) for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) S[i][j] += x[i] * x[j] / n;
  let mu = 0; for (let i = 0; i < p; i++) mu += S[i][i] / p;
  let d2 = 0; for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) d2 += (S[i][j] - (i === j ? mu : 0)) ** 2;
  let b2 = 0;
  for (const x of Xc) { let s = 0; for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) s += (x[i] * x[j] - S[i][j]) ** 2; b2 += s; }
  b2 /= n * n;
  const shrink = d2 > 0 ? Math.min(b2, d2) / d2 : 1;
  const out = zeros(p, p);
  for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) out[i][j] = (1 - shrink) * S[i][j] + (i === j ? shrink * mu : 0);
  return out;
}

// ------------------------------------------------------------------ histogram trees (RF / GBM)
function binEdges(W, rows, nb = 32) {
  const K = W.K, edges = [];
  for (let k = 0; k < K; k++) {
    const v = rows.map((r) => W.X[r * K + k]).sort((a, b) => a - b);
    const e = [];
    for (let q = 1; q < nb; q++) e.push(v[Math.floor(q / nb * (v.length - 1))]);
    edges.push(Float64Array.from(new Set(e)));
  }
  return edges;
}
function binOf(edges, v) { let lo = 0, hi = edges.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (v > edges[mid]) lo = mid + 1; else hi = mid; } return lo; }
function binRows(W, rows, edges) {
  const K = W.K, B = rows.map((r) => { const b = new Uint8Array(K); for (let k = 0; k < K; k++) b[k] = binOf(edges[k], W.X[r * K + k]); return b; });
  return B;
}
function buildTree(B, target, rowIdx, opt, rng, nbins) {
  const K = B[0].length;
  const node = (idx, depth) => {
    let S = 0; for (const i of idx) S += target[i];
    const n = idx.length, leaf = { leaf: true, value: S / (n + opt.l2) };
    if (depth >= opt.depth || n < 2 * opt.minLeaf) return leaf;
    let feats = Array.from({ length: K }, (_, k) => k);
    if (opt.featureFraction < 1) {
      const m = Math.max(1, Math.round(opt.featureFraction * K));
      for (let i = K - 1; i > 0; i--) { const j = rng.int(i + 1); [feats[i], feats[j]] = [feats[j], feats[i]]; }
      feats = feats.slice(0, m);
    }
    let best = null, bestGain = 1e-12;
    const parent = S * S / n;
    for (const k of feats) {
      const hs = new Float64Array(nbins + 1), hn = new Float64Array(nbins + 1);
      for (const i of idx) { const b = B[i][k]; hs[b] += target[i]; hn[b]++; }
      let ls = 0, ln = 0;
      for (let b = 0; b < nbins; b++) {
        ls += hs[b]; ln += hn[b];
        const rn = n - ln;
        if (ln < opt.minLeaf || rn < opt.minLeaf) continue;
        const gain = ls * ls / ln + (S - ls) ** 2 / rn - parent;
        if (gain > bestGain) { bestGain = gain; best = { k, b }; }
      }
    }
    if (!best) return leaf;
    const L = [], R = [];
    for (const i of idx) (B[i][best.k] <= best.b ? L : R).push(i);
    return { leaf: false, k: best.k, b: best.b, left: node(L, depth + 1), right: node(R, depth + 1) };
  };
  return node(rowIdx, 0);
}
function treePredict(tree, bins) { let t = tree; while (!t.leaf) t = bins[t.k] <= t.b ? t.left : t.right; return t.value; }

// ------------------------------------------------------------------ methods
const ONE = (K) => new Float64Array(K).fill(1 / K);

export const METHODS = {
  EW: { label: "Equal weights", kind: "simple", fit: (D) => ({ beta: ONE(D.K) }) },
  HEW: {
    label: "Family-equal weights", kind: "simple",
    fit: (D) => { const b = new Float64Array(D.K); for (const f of D.W.fams) for (const k of f.idx) b[k] = 1 / (D.W.fams.length * f.idx.length); return { beta: b }; },
  },
  ICW: {
    label: "IC-weighted", kind: "simple",
    fit: (D) => {
      const b = new Float64Array(D.K);
      for (let k = 0; k < D.K; k++) b[k] = Math.max(mean(D.months.map((t) => D.mom.ic[t][k])), 0);
      const s = b.reduce((a, v) => a + v, 0);
      return { beta: s > 0 ? b.map((v) => v / s) : ONE(D.K) };
    },
  },
  OLS: { label: "Linear regression", kind: "linear", fit: (D) => { const s = sums(D.mom, D.months); return { beta: ridgeMoments(s.G, s.c, s.n, 1e-10) }; } },
  RIDGE: {
    label: "Ridge", kind: "linear", grid: [30, 10, 3, 1, 0.3, 0.1, 0.03, 0.01].map((lam) => ({ lam })),
    fit: (D, p) => { const s = sums(D.mom, D.months); return { beta: ridgeMoments(s.G, s.c, s.n, p.lam) }; },
  },
  LASSO: {
    label: "Lasso", kind: "linear", grid: [0.9, 0.6, 0.3, 0.1, 0.03, 0.01].map((frac) => ({ frac })),
    fit: (D, p) => { const s = sums(D.mom, D.months); const lm = Math.max(...s.c.map((v) => Math.abs(v / s.n))); return { beta: enetMoments(s.G, s.c, s.n, p.frac * lm, 1) }; },
  },
  ENET: {
    label: "Elastic net", kind: "linear",
    grid: [0.6, 0.3, 0.1, 0.03, 0.01].flatMap((frac) => [0.9, 0.5, 0.1].map((alpha) => ({ frac, alpha }))),
    fit: (D, p) => { const s = sums(D.mom, D.months); const lm = Math.max(...s.c.map((v) => Math.abs(v / s.n))) / Math.max(p.alpha, 1e-3); return { beta: enetMoments(s.G, s.c, s.n, p.frac * lm, p.alpha) }; },
  },
  PCR: {
    label: "Principal components", kind: "linear", grid: [1, 2, 3, 4, 6, 8, 12, 16].map((k) => ({ k })),
    fit: (D, p) => {
      const s = sums(D.mom, D.months), R = s.G.map((r) => r.map((v) => v / s.n)), { values, vectors } = eigSym(R);
      const k = Math.min(p.k, D.K), beta = new Float64Array(D.K);
      for (let j = 0; j < k; j++) { const g = dot(vectors[j], s.c) / s.n / Math.max(values[j], 1e-12); for (let i = 0; i < D.K; i++) beta[i] += g * vectors[j][i]; }
      return { beta };
    },
  },
  MVO: {
    label: "Signal mean-variance", kind: "linear",
    fit: (D) => {
      const F = D.months.map((t) => D.mom.fret[t]);
      if (F.length < 2 * D.K) return { beta: ONE(D.K) };
      const mu = new Float64Array(D.K); for (const f of F) for (let k = 0; k < D.K; k++) mu[k] += f[k] / F.length;
      const b = solve(ledoitWolf(F), mu), s = b.reduce((a, v) => a + Math.abs(v), 0);
      return { beta: b.map((v) => v / s) };
    },
  },
  BMA: {
    label: "Bayesian model averaging", kind: "bayes",
    fit: (D) => {
      const { G, c, yy, n } = sums(D.mom, D.months), K = D.K, ne = Math.max(n / deff(D.mom, D.months), K + 2), g = ne;
      const lp = [], betas = [];
      const lchoose = (a, b) => { let s = 0; for (let i = 1; i <= b; i++) s += Math.log(a - b + i) - Math.log(i); return s; };
      for (let mask = 0; mask < 1 << K; mask++) {
        const S = []; for (let k = 0; k < K; k++) if (mask & (1 << k)) S.push(k);
        const prior = -Math.log(K + 1) - lchoose(K, S.length);
        if (!S.length) { lp.push(prior); betas.push(null); continue; }
        const Gs = S.map((i) => Float64Array.from(S.map((j) => G[i][j]))), cs = Float64Array.from(S.map((i) => c[i]));
        const b = solve(Gs, cs), r2 = Math.min(Math.max(dot(b, cs) / yy, 0), 1 - 1e-12);
        lp.push(0.5 * (ne - 1 - S.length) * Math.log1p(g) - 0.5 * (ne - 1) * Math.log1p(g * (1 - r2)) + prior);
        betas.push({ S, b });
      }
      const mx = Math.max(...lp), w = lp.map((v) => Math.exp(v - mx)), tot = w.reduce((a, v) => a + v, 0);
      const beta = new Float64Array(K), incl = new Float64Array(K);
      betas.forEach((e, m) => { if (!e) return; const wt = w[m] / tot; e.S.forEach((k, j) => { beta[k] += wt * e.b[j] * g / (1 + g); incl[k] += wt; }); });
      return { beta, inclusion: incl };
    },
  },
  BSHRINK: {
    label: "Bayesian shrinkage to equal weights", kind: "bayes",
    fit: (D) => {
      const K = D.K, Bm = D.months.map((t) => D.mom.fm[t]);
      if (Bm.length < K + 12) return { beta: ONE(K) };
      const T = Bm.length, bbar = new Float64Array(K);
      for (const b of Bm) for (let k = 0; k < K; k++) bbar[k] += b[k] / T;
      const S = zeros(K, K);
      for (const b of Bm) for (let i = 0; i < K; i++) for (let j = 0; j < K; j++) S[i][j] += (b[i] - bbar[i]) * (b[j] - bbar[j]) / (T - 1) / T;
      const one = new Float64Array(K).fill(1);
      let best = null;
      for (const tau2 of [0, ...Array.from({ length: 65 }, (_, i) => 10 ** (-9 + i * 8 / 64))]) {
        const V = S.map((r, i) => r.map((v, j) => v + (i === j ? tau2 : 0)));
        if (!cholesky(V)) continue;                        // not positive definite (as Python's slogdet sign check)
        const Wm = inverse(V), kappa = quad(Wm, one) > 0 ? dot(one, matVec(Wm, bbar)) / quad(Wm, one) : 0;
        const r = bbar.map((v) => v - kappa), ll = -0.5 * (logdet(V) + quad(Wm, r));
        if (!best || ll > best.ll) best = { ll, tau2, kappa, Wm, r };
      }
      const adj = matVec(best.Wm, best.r);
      return { beta: Float64Array.from({ length: K }, (_, k) => best.kappa + best.tau2 * adj[k]), tau2: best.tau2 };
    },
  },
  RF: {
    label: "Random forest", kind: "tree", rows: true, grid: [2, 4, 6].map((depth) => ({ depth })),
    fit: (D, p, opt = {}) => {
      const rng = makeRng(17 + D.months.length), rows = D.rows(opt.maxRows ?? 12000, rng);
      const edges = binEdges(D.W, rows), B = binRows(D.W, rows, edges), y = Float64Array.from(rows, (r) => D.W.y[r]);
      const trees = [], nT = opt.trees ?? 40;
      for (let m = 0; m < nT; m++) {
        const idx = []; for (let i = 0; i < rows.length; i++) if (rng.uniform() < 0.3) idx.push(i);
        trees.push(buildTree(B, y, idx, { depth: p.depth, minLeaf: 50, featureFraction: 0.5, l2: 0 }, rng, 32));
      }
      return { edges, predictRows: (X) => X.map((x) => { const b = Uint8Array.from(x, (v, k) => binOf(edges[k], v)); let s = 0; for (const t of trees) s += treePredict(t, b); return s / trees.length; }) };
    },
  },
  GBM: {
    label: "Gradient boosting", kind: "tree", rows: true, grid: [1, 2, 3].flatMap((depth) => [25, 50, 100, 200].map((rounds) => ({ depth, rounds }))),
    fit: (D, p, opt = {}) => {
      const rng = makeRng(29 + D.months.length), rows = D.rows(opt.maxRows ?? 12000, rng);
      const edges = binEdges(D.W, rows), B = binRows(D.W, rows, edges), y = Float64Array.from(rows, (r) => D.W.y[r]);
      const F = new Float64Array(rows.length), trees = [], lr = 0.05;
      const resid = new Float64Array(rows.length);
      const R = opt.maxRounds ?? p.rounds;
      for (let m = 0; m < R; m++) {
        for (let i = 0; i < rows.length; i++) resid[i] = y[i] - F[i];
        const idx = []; for (let i = 0; i < rows.length; i++) if (rng.uniform() < 0.5) idx.push(i);
        const t = buildTree(B, resid, idx, { depth: p.depth, minLeaf: 100, featureFraction: 0.8, l2: 10 }, rng, 32);
        trees.push(t);
        for (let i = 0; i < rows.length; i++) F[i] += lr * treePredict(t, B[i]);
      }
      // predictions after the first `rounds` trees (staged, so one fit serves every round count in tuning)
      return { edges, trees, predictRows: (X, rounds = p.rounds) => X.map((x) => { const b = Uint8Array.from(x, (v, k) => binOf(edges[k], v)); let s = 0; for (let m = 0; m < Math.min(rounds, trees.length); m++) s += lr * treePredict(trees[m], b); return s; }) };
    },
  },
  DMA: {
    label: "Dynamic model averaging", kind: "dynamic", online: true,
    init: (D) => {
      const fams = D.W.fams, models = [];
      for (let mask = 1; mask < 1 << fams.length; mask++) {
        const idx = []; fams.forEach((f, j) => { if (mask & (1 << j)) idx.push(...f.idx); });
        idx.sort((a, b) => a - b); models.push(idx);
      }
      const st = { models, beta: models.map((m) => new Float64Array(m.length)), P: models.map((m) => eye(m.length).map((r) => r.map((v) => v * 0.01))),
                   logpi: new Float64Array(models.length).fill(-Math.log(models.length)), deff: deff(D.mom, D.months), K: D.K };
      return st;
    },
    step: (st, mom, t, p = {}) => {
      const lam = p.lam ?? 0.99, alpha = p.alpha ?? 0.99;
      const d = st.deff, G = mom.G[t].map((r) => r.map((v) => v / d)), c = mom.c[t].map((v) => v / d), yy = mom.yy[t] / d, n = mom.n[t] / d;
      const prior = st.logpi.map((v) => alpha * v);
      const lse = (a) => { const m = Math.max(...a); return m + Math.log(a.reduce((s, v) => s + Math.exp(v - m), 0)); };
      const pz = lse(prior);
      const ll = st.models.map((idx, i) => {
        const b = st.beta[i], P = st.P[i].map((r) => r.map((v) => v / lam));
        const Gm = idx.map((a) => Float64Array.from(idx.map((bb) => G[a][bb]))), cm = Float64Array.from(idx.map((a) => c[a]));
        const Pinv = inverse(P), A = Pinv.map((r, a) => r.map((v, bb) => v + Gm[a][bb]));
        const ee = yy - 2 * dot(b, cm) + quad(Gm, b), xe = Float64Array.from(cm, (v, a) => v - dot(Gm[a], b));
        const Ainv = inverse(A), logdetv = n * 0 + logdet(P) + logdet(A), q = ee - quad(Ainv, xe);
        const nb = matVec(Ainv, Float64Array.from(matVec(Pinv, b), (v, a) => v + cm[a]));
        st.beta[i] = nb; st.P[i] = Ainv;
        return -0.5 * (n * Math.log(2 * Math.PI) + logdetv + q);
      });
      const post = prior.map((v, i) => v - pz + ll[i]);
      const z = lse(post);
      st.logpi = Float64Array.from(post, (v) => v - z);
    },
    beta: (st, p = {}) => {
      const alpha = p.alpha ?? 0.99;
      const prior = st.logpi.map((v) => alpha * v), m = Math.max(...prior), w = prior.map((v) => Math.exp(v - m)), s = w.reduce((a, v) => a + v, 0);
      const beta = new Float64Array(st.K);
      st.models.forEach((idx, i) => idx.forEach((k, j) => { beta[k] += w[i] / s * st.beta[i][j]; }));
      return beta;
    },
  },
  REGIME: {
    label: "Regime-conditioned ensemble", kind: "dynamic", grid: [10, 1, 0.3, 0.1, 0.03, 0.01].map((kappa) => ({ kappa })),
    fit: (D, p) => {
      const s = sums(D.mom, D.months), pool = ridgeMoments(s.G, s.c, s.n, 1e-8), byRegime = {};
      for (const r of [0, 1]) {
        const m = D.months.filter((t) => D.W.regime[t] === r);
        if (!m.length) continue;
        const sr = sums(D.mom, m), A = sr.G.map((row, i) => row.map((v, j) => v / sr.n + (i === j ? p.kappa : 0)));
        byRegime[r] = solve(A, Float64Array.from(sr.c, (v, i) => v / sr.n + p.kappa * pool[i]));
      }
      return { beta: pool, byRegime };
    },
  },
  ONLINE_EG: {
    label: "Online multiplicative weights", kind: "dynamic", online: true, grid: [0, 0.05, 0.1, 0.2, 0.5, 1, 2].map((eta) => ({ eta })),
    init: (D) => ({ cum: new Float64Array(D.K), K: D.K }),
    step: (st, mom, t) => { for (let k = 0; k < st.K; k++) st.cum[k] += Number.isFinite(mom.ic[t][k]) ? mom.ic[t][k] : 0; },
    beta: (st, p) => { const mx = Math.max(...st.cum), w = st.cum.map((v) => Math.exp(p.eta * (v - mx))), s = w.reduce((a, v) => a + v, 0); return w.map((v) => v / s); },
  },
  ONLINE_RLS: {
    label: "Online least squares (forgetting)", kind: "dynamic", online: true, grid: [1, 0.995, 0.99, 0.98, 0.95].map((forget) => ({ forget })),
    init: (D) => ({ G: zeros(D.K, D.K), c: new Float64Array(D.K), n: 0, K: D.K }),
    step: (st, mom, t, p) => {
      const f = p.forget;
      for (let a = 0; a < st.K; a++) { st.c[a] = f * st.c[a] + mom.c[t][a]; for (let b = 0; b < st.K; b++) st.G[a][b] = f * st.G[a][b] + mom.G[t][a][b]; }
      st.n = f * st.n + mom.n[t];
    },
    beta: (st) => ridgeMoments(st.G, st.c, Math.max(st.n, 1), 1e-4),
  },
};
export const ORDER = ["EW", "HEW", "ICW", "OLS", "RIDGE", "LASSO", "ENET", "PCR", "MVO", "BMA", "BSHRINK", "RF", "GBM", "DMA", "REGIME", "ONLINE_EG", "ONLINE_RLS"];

// ------------------------------------------------------------------ a fitted model: one interface for all methods
function trainData(W, mom, months) {
  return {
    W, mom, months, K: W.K,
    rows(maxRows, rng) {
      const all = []; for (const t of months) for (let i = 0; i < W.N; i++) all.push(t * W.N + i);
      if (all.length <= maxRows) return all;
      for (let i = all.length - 1; i > 0; i--) { const j = rng.int(i + 1); [all[i], all[j]] = [all[j], all[i]]; }
      return all.slice(0, maxRows).sort((a, b) => a - b);
    },
  };
}

function fitModel(name, W, mom, months, params, opt) {
  const M = METHODS[name], D = trainData(W, mom, months);
  if (M.online) {
    const st = M.init(D);
    for (const t of months) M.step(st, mom, t, params);
    return { name, online: true, st, params, last: months[months.length - 1],
             update(t) { M.step(this.st, mom, t, this.params); this.last = t; },
             beta() { return M.beta(this.st, this.params); },
             predictRows(X) { const b = this.beta(); return X.map((x) => dot(x, b)); },
             predictMonth(t) { const b = this.beta(); return monthPred(W, t, b); } };
  }
  const f = M.fit(D, params, opt);
  return { name, online: false, f, params,
           beta() { return f.beta ?? null; },
           predictRows(X, t) {
             if (f.predictRows) return f.predictRows(X);
             const b = f.byRegime && f.byRegime[W.regime[t]] ? f.byRegime[W.regime[t]] : f.beta;
             return X.map((x) => dot(x, b));
           },
           predictMonth(t) {
             if (f.predictRows) { const X = []; for (let i = 0; i < W.N; i++) X.push(Array.from({ length: W.K }, (_, k) => W.X[(t * W.N + i) * W.K + k])); return Float64Array.from(f.predictRows(X)); }
             const b = f.byRegime && f.byRegime[W.regime[t]] ? f.byRegime[W.regime[t]] : f.beta;
             return monthPred(W, t, b);
           } };
}

function monthPred(W, t, b) {
  const out = new Float64Array(W.N);
  for (let i = 0; i < W.N; i++) { let s = 0; const o = (t * W.N + i) * W.K; for (let k = 0; k < W.K; k++) s += W.X[o + k] * b[k]; out[i] = s; }
  return out;
}

function monthRankIC(W, t, pred) { return rankCorr(pred, W.ret.subarray(t * W.N, (t + 1) * W.N)); }

// nested selection on forward-chaining folds inside the training months
function select(name, W, mom, train, opt) {
  const M = METHODS[name];
  if (!M.grid || !opt.autoTune) return opt.manual?.[name] ?? (M.grid ? M.grid[Math.floor(M.grid.length / 2)] : {});
  const block = opt.innerBlock ?? 24, folds = [];
  for (let j = 2; j >= 1; j--) {
    const vEnd = train.length - (j - 1) * block, vStart = vEnd - block;
    if (vStart < 36) continue;
    folds.push({ tr: train.slice(0, vStart - 1), va: train.slice(vStart, vEnd) });
  }
  if (!folds.length) return M.grid[Math.floor(M.grid.length / 2)];
  let best = null;
  if (name === "GBM") {                                   // staged: one fit per depth, scored at every round count
    const rounds = [...new Set(M.grid.map((g) => g.rounds))].sort((a, b) => a - b);
    for (const depth of [...new Set(M.grid.map((g) => g.depth))]) {
      const sc = Object.fromEntries(rounds.map((r) => [r, []]));
      for (const f of folds) {
        const m = METHODS.GBM.fit(trainData(W, mom, f.tr), { depth, rounds: rounds[rounds.length - 1] }, opt);
        for (const t of f.va) {
          const X = []; for (let i = 0; i < W.N; i++) X.push(Array.from({ length: W.K }, (_, k) => W.X[(t * W.N + i) * W.K + k]));
          for (const r of rounds) sc[r].push(monthRankIC(W, t, Float64Array.from(m.predictRows(X, r))));
        }
      }
      for (const r of rounds) { const s = mean(sc[r]); if (!best || s > best.sc) best = { sc: s, p: { depth, rounds: r } }; }
    }
    return best.p;
  }
  for (const p of M.grid) {
    const scores = [];
    for (const f of folds) {
      const m = fitModel(name, W, mom, f.tr, p, { ...opt, trees: Math.min(opt.trees ?? 40, 20) });
      for (const t of f.va) {
        if (m.online) for (let s = m.last + 1; s < t; s++) m.update(s);
        scores.push(monthRankIC(W, t, m.predictMonth(t)));
      }
    }
    const sc = mean(scores);
    if (!best || sc > best.sc) best = { sc, p };
  }
  return best.p;
}

// Walk-forward: refit every `refit` months from month `start`, re-select hyperparameters every `tuneEvery`.
export function walkForward(W, mom, name, opt, progress) {
  const start = opt.start, refit = opt.refit ?? 12, tuneEvery = opt.tuneEvery ?? 60, T = W.T;
  const pred = new Float64Array(T * W.N).fill(NaN), weights = [], chosen = [];
  let params = null, lastTune = -1e9, lastModel = null, lastMonth = null;
  for (let r = start; r < T - 1; r += refit) {
    const train = []; for (let t = 0; t <= r - 2; t++) train.push(t);
    if (!params || r - lastTune >= tuneEvery) { params = select(name, W, mom, train, opt); lastTune = r; }
    chosen.push({ month: r, params });
    const model = fitModel(name, W, mom, train, params, opt);
    for (let t = r; t < Math.min(r + refit, T - 1); t++) {
      if (model.online) for (let s = model.last + 1; s < t; s++) model.update(s);
      const p = model.predictMonth(t);
      pred.set(p, t * W.N);
      const b = model.beta();
      weights.push(b ? Float64Array.from(model.f?.byRegime?.[W.regime[t]] ?? b) : null);
      lastModel = model; lastMonth = t;
    }
    progress?.((r - start) / Math.max(T - 1 - start, 1));
  }
  return { name, pred, weights, chosen, contributions: contributions(W, lastModel, lastMonth) };
}

// Signal contributions in the last forecast month for the top, middle and bottom stock by the method's score:
// w_k x_k for linear methods; for trees, the forecast minus the forecast with that signal set to neutral (0).
function contributions(W, model, t) {
  if (!model) return null;
  const p = model.predictMonth(t), order = Array.from(p, (_, i) => i).sort((a, b) => p[b] - p[a]);
  const pick = { top: order[0], middle: order[Math.floor(order.length / 2)], bottom: order[order.length - 1] };
  const out = { month: t };
  for (const [lab, i] of Object.entries(pick)) {
    const x = Array.from({ length: W.K }, (_, k) => W.X[(t * W.N + i) * W.K + k]);
    const base = model.predictRows([x], t)[0];
    const contrib = x.map((_, k) => { const x0 = x.slice(); x0[k] = 0; return base - model.predictRows([x0], t)[0]; });
    out[lab] = { stock: i, score: base, signals: x, contrib };
  }
  return out;
}

export const _internal = { fitModel, trainData, sums, select };

// Build a world object from arrays (used by the parity tests and for loading saved worlds)
export function worldFromArrays({ N, T, K, X, y, ret, regime, names, families: fam }) {
  const signals = names.map((n, k) => ({ name: n, family: fam[k] }));
  return { N, T, K, X: Float64Array.from(X), y: Float64Array.from(y), ret: Float64Array.from(ret),
           regime: Int8Array.from(regime), oracle: new Float64Array(T * N), names, families: fam,
           fams: families(signals) };
}

// ------------------------------------------------------------------ evaluation
export function evaluate(W, res, opt) {
  const { start } = opt, T = W.T, N = W.N, costBp = opt.costBp ?? 10;
  const ic = [], gross = [], net = [], turn = [];
  let prevW = null, prevR = null;
  for (let t = start; t < T - 1; t++) {
    const p = res.pred.subarray(t * N, (t + 1) * N), r = W.ret.subarray(t * N, (t + 1) * N);
    ic.push(rankCorr(p, r));
    const rk = ranks(p), mr = (N + 1) / 2;
    let s = 0; for (let i = 0; i < N; i++) s += Math.abs(rk[i] - mr);
    const w = Float64Array.from(rk, (v) => 2 * (v - mr) / s);
    let g = 0; for (let i = 0; i < N; i++) g += w[i] * r[i];
    let tr = 0;
    if (prevW) {
      let rp = 0; for (let i = 0; i < N; i++) rp += prevW[i] * prevR[i];
      for (let i = 0; i < N; i++) tr += Math.abs(w[i] - prevW[i] * (1 + prevR[i]) / (1 + rp));
    } else for (let i = 0; i < N; i++) tr += Math.abs(w[i]);
    gross.push(g); net.push(g - tr * costBp * 1e-4); turn.push(tr / 2);
    prevW = w; prevR = r;
  }
  return { ic, gross, net, turnover: turn };
}

export function summarize(ev, bench) {
  const out = { rankIC: mean(ev.ic), icT: nwT(ev.ic), sharpeGross: sharpe(ev.gross), sharpeNet: sharpe(ev.net),
                turnover: mean(ev.turnover.slice(1)) * 12 };
  if (bench) {
    const d = ev.ic.map((v, i) => v - bench.ic[i]);
    out.icDiff = mean(d); out.icDiffT = nwT(d);
    out.sharpeDiff = out.sharpeNet - sharpe(bench.net);
    out.sharpeDiffCI = bootstrapCI((a, b) => sharpe(a) - sharpe(b), [ev.net, bench.net], 400, 6, 3);
  }
  return out;
}

export function oracleEval(W, opt) {
  return evaluate(W, { pred: W.oracle }, opt);
}

// Deciles of the forecast vs mean realized return (pooled over the OOS months)
export function deciles(W, res, opt) {
  const sums = new Float64Array(10), cnt = new Float64Array(10);
  for (let t = opt.start; t < W.T - 1; t++) {
    const p = res.pred.subarray(t * W.N, (t + 1) * W.N), r = W.ret.subarray(t * W.N, (t + 1) * W.N), rk = ranks(p);
    let m = 0; for (let i = 0; i < W.N; i++) m += r[i]; m /= W.N;
    for (let i = 0; i < W.N; i++) { const d = Math.min(9, Math.floor((rk[i] - 1) / W.N * 10)); sums[d] += r[i] - m; cnt[d]++; }
  }
  return Array.from(sums, (s, i) => s / cnt[i]);
}
