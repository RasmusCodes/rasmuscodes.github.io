// Credit & capital-structure lab: browser engine.
// A port of the Python package `creditlab` (waterfall, lognormal/barrier formulas, structural pricing).
// Parity with the Python engine is checked by web/test/index.html against vectors exported by
// scripts/export_web.py. Units: currency millions, years, continuously compounded rates.

const SQRT2 = Math.SQRT2;
const SQRTPI = Math.sqrt(Math.PI);

// ---------------------------------------------------------------- normal distribution
function erfSeries(z) {
  // Maclaurin series, used for |z| < 3 (alternating, ~1e-13 accurate there)
  let term = z, sum = z, n = 0;
  while (Math.abs(term) > 1e-17 * Math.abs(sum) && n < 200) {
    n += 1;
    term *= -z * z / n;
    sum += term / (2 * n + 1);
  }
  return 2 / SQRTPI * sum;
}

function erfcContinuedFraction(z) {
  // Lentz's method for erfc(z) = exp(-z^2)/sqrt(pi) * 1/(z + 1/2/(z + 1/(z + 3/2/(z + ...)))), z >= 3
  const tiny = 1e-300;
  let f = z, C = z, D = 0;
  for (let k = 1; k < 300; k++) {
    const a = k / 2;
    D = z + a * D; D = Math.abs(D) < tiny ? tiny : D; D = 1 / D;
    C = z + a / C; C = Math.abs(C) < tiny ? tiny : C;
    const delta = C * D;
    f *= delta;
    if (Math.abs(delta - 1) < 1e-16) break;
  }
  return Math.exp(-z * z) / SQRTPI / f;
}

export function erfc(z) {
  if (z >= 3) return erfcContinuedFraction(z);
  if (z <= -3) return 2 - erfcContinuedFraction(-z);
  return 1 - erfSeries(z);
}

export function normCdf(x) {
  if (x === Infinity) return 1;
  if (x === -Infinity) return 0;
  return 0.5 * erfc(-x / SQRT2);
}

// ---------------------------------------------------------------- lognormal building blocks
const z = (x, m, sd) => (x - m) / sd;

export function partialMoments(V0, mu, s, T, a, b) {
  // P(a < V_T <= b) and E[V_T 1{a < V_T <= b}] for GBM with drift mu
  const sd = s * Math.sqrt(T);
  const m = Math.log(V0) + (mu - 0.5 * s * s) * T;
  const la = a > 0 ? Math.log(a) : -Infinity;
  const lb = Number.isFinite(b) ? Math.log(b) : Infinity;
  const p = normCdf(z(lb, m, sd)) - normCdf(z(la, m, sd));
  const ev = V0 * Math.exp(mu * T) * (normCdf(z(lb, m + sd * sd, sd)) - normCdf(z(la, m + sd * sd, sd)));
  return { p, ev };
}

export function barrierPartialMoments(V0, mu, s, T, H0, g, a, b) {
  if (!(H0 > 0)) return partialMoments(V0, mu, s, T, a, b);
  const HT = H0 * Math.exp(g * T);
  a = Math.max(a, HT);
  const x0 = Math.log(V0), bb = Math.log(H0);
  const nu = mu - 0.5 * s * s - g;
  const sd = s * Math.sqrt(T);
  const xa = Math.log(a) - g * T;
  const xb = Number.isFinite(b) ? Math.log(b) - g * T : Infinity;
  const refl = 2 * bb - x0;
  const k = Math.exp(2 * nu * (bb - x0) / (s * s));
  const prob = (start) => { const m = start + nu * T; return normCdf(z(xb, m, sd)) - normCdf(z(xa, m, sd)); };
  const expv = (start) => {
    const m = start + nu * T;
    return Math.exp(start + nu * T + 0.5 * sd * sd + g * T) * (normCdf(z(xb, m + sd * sd, sd)) - normCdf(z(xa, m + sd * sd, sd)));
  };
  return { p: Math.max(prob(x0) - k * prob(refl), 0), ev: Math.max(expv(x0) - k * expv(refl), 0) };
}

export function firstPassageProb(V0, mu, s, T, H0, g = 0) {
  if (!(H0 > 0) || T <= 0) return 0;
  if (V0 <= H0) return 1;
  const a = Math.log(V0 / H0);
  const nu = mu - 0.5 * s * s - g;
  const sd = s * Math.sqrt(T);
  const p = normCdf((-a - nu * T) / sd) + Math.exp(-2 * nu * a / (s * s)) * normCdf((-a + nu * T) / sd);
  return Math.min(Math.max(p, 0), 1);
}

export function discountedHit(V0, mu, s, T, H0, r, g = 0) {
  if (!(H0 > 0)) return 0;
  const a = Math.log(V0 / H0);
  const nu = mu - 0.5 * s * s - g;
  const nt = Math.sqrt(nu * nu + 2 * r * s * s);
  const sd = s * Math.sqrt(T);
  return Math.exp(-a * (nu + nt) / (s * s)) * normCdf((-a + nt * T) / sd)
       + Math.exp(-a * (nu - nt) / (s * s)) * normCdf((-a - nt * T) / sd);
}

export function pdTermStructure(V0, sigma, H0, g, r, q, times) {
  return times.map((t) => firstPassageProb(V0, r - q, sigma, t, H0, g));
}

// ---------------------------------------------------------------- waterfall
const RANK_COMMON = 40;

function childrenFirst(entities) {
  const byId = Object.fromEntries(entities.map((e) => [e.id, e]));
  const depth = {};
  const d = (e) => {
    if (e.id in depth) return depth[e.id];
    depth[e.id] = e.parent == null ? 0 : d(byId[e.parent]) + 1;
    return depth[e.id];
  };
  entities.forEach(d);
  return [...entities].sort((a, b) => depth[b.id] - depth[a.id]);
}

export function distribute(S, V, opts = {}) {
  // Absolute-priority waterfall for one value V. S: {entities, pools, claims, admin_cost}
  const inDefault = opts.inDefault !== false;
  const ac = opts.adminCost ?? S.admin_cost ?? 0;
  const gift = opts.gift ?? 0;
  const net = inDefault ? V * (1 - ac) : V;
  const giftAmt = inDefault ? gift * net : 0;
  const creditor = net - giftAmt;
  const out = {}, paid = {};
  for (const c of S.claims) { paid[c.id] = 0; if (c.kind !== "common") out[c.id] = c.amount; }
  const residualUp = Object.fromEntries(S.entities.map((e) => [e.id, 0]));
  let equityResidual = 0;
  const order = S._order || (S._order = childrenFirst(S.entities));
  for (const e of order) {
    const own = creditor * e.share;
    let unenc = own;
    for (const p of S.pools) {
      if (p.entity !== e.id) continue;
      let pv = own * p.share;
      unenc -= pv;
      const secured = [];
      for (const c of S.claims) for (const [pid, lien] of c.secured_by) if (pid === p.id) secured.push([c, lien]);
      const liens = [...new Set(secured.map((x) => x[1]))].sort((a, b) => a - b);
      for (const lien of liens) {
        const group = secured.filter((x) => x[1] === lien).map((x) => x[0]);
        const total = group.reduce((s, c) => s + out[c.id], 0);
        const pay = Math.min(pv, total);
        const frac = total > 0 ? pay / total : 0;
        for (const c of group) { const x = out[c.id] * frac; out[c.id] -= x; paid[c.id] += x; pv -= x; }
      }
      unenc += pv;
    }
    let avail = unenc + residualUp[e.id];
    const tiers = {};
    for (const c of S.claims) {
      if (c.kind === "common") continue;
      if (c.entity === e.id) (tiers[c.rank] = tiers[c.rank] || []).push(c);
      else if ((c.guarantors || []).includes(e.id)) (tiers[c.guarantee_rank ?? 10] = tiers[c.guarantee_rank ?? 10] || []).push(c);
    }
    for (const rank of Object.keys(tiers).map(Number).sort((a, b) => a - b)) {
      if (rank >= RANK_COMMON) continue;
      const group = tiers[rank];
      const total = group.reduce((s, c) => s + out[c.id], 0);
      const payTot = Math.min(Math.max(avail, 0), total);
      const frac = total > 0 ? payTot / total : 0;
      const alloc = {};
      for (const c of group) alloc[c.id] = out[c.id] * frac;
      for (const c of group) {
        for (const b of c.turnover_to || []) {
          if (!(b in out)) continue;
          const already = alloc[b] || 0;
          const shortfall = Math.max(out[b] - already, 0);
          const move = Math.min(alloc[c.id], shortfall);
          alloc[c.id] -= move;
          alloc[b] = already + move;
        }
      }
      for (const [k, x] of Object.entries(alloc)) { out[k] -= x; paid[k] += x; avail -= x; }
    }
    avail = Math.max(avail, 0);
    if (e.parent == null) equityResidual = avail; else residualUp[e.parent] += avail;
  }
  const commons = S.claims.filter((c) => c.kind === "common");
  const toEquity = equityResidual + giftAmt;
  for (const c of commons) paid[c.id] = toEquity / commons.length;
  const recovery = {};
  for (const c of S.claims) recovery[c.id] = c.kind === "common" || !(c.amount > 0) ? null : paid[c.id] / c.amount;
  return { payouts: paid, recovery, residual: toEquity };
}

export function totalDebt(S) {
  return S.claims.filter((c) => !["preferred", "common"].includes(c.kind)).reduce((s, c) => s + c.amount, 0);
}

export function totalClaims(S) {
  return S.claims.filter((c) => c.kind !== "common").reduce((s, c) => s + c.amount, 0);
}

export function fullPaymentThreshold(S, id, opts = {}) {
  const c = S.claims.find((x) => x.id === id);
  if (!(c.amount > 0)) return 0;
  let hi = Math.max(totalClaims(S) * 4, 1);
  const f = (v) => distribute(S, v, opts).payouts[id] - c.amount * (1 - 1e-12);
  while (f(hi) < 0) { hi *= 2; if (hi > 1e15) return Infinity; }
  let lo = 0;
  while (hi - lo > 1e-7 * Math.max(1, hi)) {
    const mid = 0.5 * (lo + hi);
    if (f(mid) >= 0) hi = mid; else lo = mid;
  }
  return hi;
}

export function breakpoints(S, opts = {}) {
  const pts = S.claims.filter((c) => c.kind !== "common" && c.amount > 0)
    .map((c) => fullPaymentThreshold(S, c.id, opts)).filter((p) => Number.isFinite(p) && p > 0);
  return [...new Set(pts.map((p) => +p.toFixed(9)))].sort((a, b) => a - b);
}

export function fulcrum(S, V, opts = {}) {
  const r = distribute(S, V, opts);
  let best = null;
  for (const c of S.claims) {
    if (c.kind === "common" || !(c.amount > 0)) continue;
    const x = r.recovery[c.id];
    if (x > 0 && x < 1 - 1e-9 && (best === null || x > best.x)) best = { id: c.id, x };
  }
  return best && best.id;
}

// ---------------------------------------------------------------- structural pricing of every claim
const GL_X = [-0.9894009349916499, -0.9445750230732326, -0.8656312023878318, -0.7554044083550030, -0.6178762444026438,
  -0.4580167776572274, -0.2816035507792589, -0.0950125098376374, 0.0950125098376374, 0.2816035507792589, 0.4580167776572274,
  0.6178762444026438, 0.7554044083550030, 0.8656312023878318, 0.9445750230732326, 0.9894009349916499];
const GL_W = [0.0271524594117541, 0.0622535239386479, 0.0951585116824928, 0.1246289712555339, 0.1495959888165767,
  0.1691565193950025, 0.1826034150449236, 0.1894506104550685, 0.1894506104550685, 0.1826034150449236, 0.1691565193950025,
  0.1495959888165767, 0.1246289712555339, 0.0951585116824928, 0.0622535239386479, 0.0271524594117541];

export function structureBreakpoints(S, adminCost, gift) {
  const a = breakpoints(S, { inDefault: false });
  const b = breakpoints(S, { inDefault: true, adminCost, gift });
  return [...new Set([...a, ...b])].sort((x, y) => x - y);
}

export function priceStructure(S, p) {
  // p: {V0, sigma, T, r, q, model: 'merton'|'black_cox', H0, defaultPoint, adminCost, gift, bps}
  const { V0, sigma, T, r } = p;
  const q = p.q || 0;
  const ac = p.adminCost ?? S.admin_cost ?? 0;
  const gift = p.gift || 0;
  const DP = p.defaultPoint ?? totalDebt(S);
  const bps = p.bps || structureBreakpoints(S, ac, gift);
  const claims = S.claims;
  const isCommon = claims.map((c) => c.kind === "common");
  const nCommon = Math.max(isCommon.filter(Boolean).length, 1);
  const totClaims = totalClaims(S);
  const mu = r - q;
  const sd = sigma * Math.sqrt(T);
  const m = Math.log(V0) + (mu - 0.5 * sigma * sigma) * T;
  const barrier = p.model === "black_cox" && p.H0 > 0;
  const H0 = barrier ? p.H0 : 0;
  const values = {}, defExp = {}, hitExp = {};
  claims.forEach((c) => { values[c.id] = 0; defExp[c.id] = 0; hitExp[c.id] = 0; });
  if (barrier && V0 <= H0) {
    const res = distribute(S, V0, { adminCost: ac, gift, inDefault: true });
    claims.forEach((c) => { values[c.id] = res.payouts[c.id]; });
    return { values, pd: 1, pdBarrier: 1, condRecovery: res.recovery, defaultPoint: DP };
  }
  const lo = Math.max(Math.exp(m - 9 * sd), barrier ? H0 * (1 + 1e-12) : 0);
  const upper = Math.max(bps.length ? bps[bps.length - 1] : 0, DP, totClaims) * (1 + 1e-9);
  const edges = [lo, ...bps.concat([DP]).filter((b) => b > lo && b < upper), upper];
  const E = [...new Set(edges)].sort((a, b) => a - b);
  const x0 = Math.log(V0), bb = barrier ? Math.log(H0) : 0;
  const nu = mu - 0.5 * sigma * sigma;
  const kref = barrier ? Math.exp(2 * nu * (bb - x0) / (sigma * sigma)) : 0;
  const phi = (x, mean) => Math.exp(-0.5 * ((x - mean) / sd) ** 2) / (sd * Math.sqrt(2 * Math.PI));
  const dens = barrier
    ? (y) => (y > bb ? phi(y, x0 + nu * T) - kref * phi(y, 2 * bb - x0 + nu * T) : 0)
    : (y) => phi(y, m);
  let pDefT = 0;
  for (let i = 0; i + 1 < E.length; i++) {
    const a = E[i], b = E[i + 1];
    if (!(b > a * (1 + 1e-12))) continue;
    const ya = Math.log(a), yb = Math.log(b);
    for (let k = 0; k < 16; k++) {
      const y = 0.5 * (yb - ya) * GL_X[k] + 0.5 * (yb + ya);
      const w = 0.5 * (yb - ya) * GL_W[k] * dens(y);
      if (w === 0) continue;
      const Vt = Math.exp(y);
      const indef = Vt < DP;
      const res = distribute(S, Vt, { adminCost: ac, gift, inDefault: indef });
      for (const c of claims) {
        values[c.id] += res.payouts[c.id] * w;
        if (indef) defExp[c.id] += res.payouts[c.id] * w;
      }
      if (indef) pDefT += w;
    }
  }
  const t = barrier ? barrierPartialMoments(V0, mu, sigma, T, H0, 0, upper, Infinity) : partialMoments(V0, mu, sigma, T, upper, Infinity);
  claims.forEach((c, i) => {
    const tail = isCommon[i] ? (t.ev - totClaims * t.p) / nCommon : c.amount * t.p;
    values[c.id] = (values[c.id] + tail) * Math.exp(-r * T);
  });
  let pHit = 0;
  if (barrier) {
    pHit = firstPassageProb(V0, mu, sigma, T, H0, 0);
    const resH = distribute(S, H0, { adminCost: ac, gift, inDefault: true });
    const dh = discountedHit(V0, mu, sigma, T, H0, r, 0);
    claims.forEach((c) => { values[c.id] += resH.payouts[c.id] * dh; hitExp[c.id] = resH.payouts[c.id] * pHit; });
  }
  const pd = pHit + pDefT;
  const condRecovery = {};
  claims.forEach((c) => {
    condRecovery[c.id] = c.kind === "common" || !(c.amount > 0) || pd <= 1e-14 ? null : (defExp[c.id] + hitExp[c.id]) / (pd * c.amount);
  });
  return { values, pd, pdBarrier: pHit, condRecovery, defaultPoint: DP };
}

// ---------------------------------------------------------------- Monte Carlo default scenarios
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function simulatePaths({ V0, sigma, mu, T, H0, DP, paths = 2000, stepsPerYear = 52, seed = 7, keep = 40 }) {
  // GBM asset paths; default at the first barrier crossing (Brownian-bridge corrected) or at T if V_T < DP.
  const rnd = mulberry32(seed);
  let spare = null;
  const gauss = () => {
    if (spare !== null) { const s = spare; spare = null; return s; }
    let u = 0, v = 0;
    while (u === 0) u = rnd();
    v = rnd();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
  const n = Math.max(1, Math.round(T * stepsPerYear));
  const dt = T / n;
  const drift = (mu - 0.5 * sigma * sigma) * dt, vol = sigma * Math.sqrt(dt);
  const lh = H0 > 0 ? Math.log(H0) : -Infinity;
  const kept = [], defaults = [];
  for (let i = 0; i < paths; i++) {
    let x = Math.log(V0);
    const path = i < keep ? [V0] : null;
    let tDef = null, vDef = null;
    for (let k = 1; k <= n; k++) {
      const xn = x + drift + vol * gauss();
      if (H0 > 0) {
        const a = x - lh, b = xn - lh;
        const crossed = b <= 0 || rnd() < Math.exp(-2 * Math.max(a, 0) * Math.max(b, 0) / (sigma * sigma * dt));
        if (crossed) { tDef = k * dt; vDef = H0; if (path) path.push(H0); break; }
      }
      x = xn;
      if (path) path.push(Math.exp(x));
    }
    if (tDef === null && Math.exp(x) < DP) { tDef = T; vDef = Math.exp(x); }
    if (path) kept.push({ values: path, tDef });
    if (tDef !== null) defaults.push({ t: tDef, v: vDef });
  }
  return { kept, defaults, paths, dt };
}

export function recoveryDistribution(S, defaults, opts, ids) {
  // Waterfall recovery of each claim in every simulated default
  const out = Object.fromEntries(ids.map((id) => [id, []]));
  for (const d of defaults) {
    const r = distribute(S, d.v, Object.assign({ inDefault: true }, opts));
    for (const id of ids) out[id].push(r.recovery[id]);
  }
  return out;
}

export function scaledStructure(S, debtScale = 1, maturityShift = 0) {
  return Object.assign({}, S, {
    _order: undefined,
    claims: S.claims.map((c) => Object.assign({}, c, {
      amount: ["common", "preferred"].includes(c.kind) || c.kind === "admin" ? c.amount : c.amount * debtScale,
      maturity: c.maturity == null ? null : Math.max(c.maturity + maturityShift, 0.01),
    })),
  });
}

export function defaultPoint(S, horizon, ltWeight = 0.5) {
  let st = 0, lt = 0;
  for (const c of S.claims) {
    if (["preferred", "common"].includes(c.kind)) continue;
    if (c.maturity != null && c.maturity <= horizon) st += c.amount; else lt += c.amount;
  }
  return st + ltWeight * lt;
}
