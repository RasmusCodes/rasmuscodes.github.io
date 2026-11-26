// Self-test: the JavaScript models and Black-76 against reference values computed by the Python library
// (data/test_vectors.json, written by scripts/make_test_vectors.py).
import { blackSens, impliedVolBlack } from './math.js';
import { buildSurface, MODEL_LABELS } from './models.js';

export const TARGETS = { svi: 1e-9, essvi: 1e-9, ssvi: 1e-9, sabr: 1e-9, heston: 2e-4, black: 1e-9, ivrt: 1e-12 };
const BLACK_KEYS = ['value', 'dF', 'dFF', 'ds', 'dtau', 'dFs', 'dss', 'dD'];

/** tv: parsed test_vectors.json; bundle: the surface file it was computed from. Returns rows for display. */
export function runSelfTest(tv, bundle) {
  const rows = [];
  const t0 = performance.now();
  for (const [key, grid] of Object.entries(tv.iv || {})) {
    const srf = buildSurface(bundle, key);
    if (!srf) {
      rows.push({ name: `${MODEL_LABELS[key] || key} implied vol`, err: NaN, target: TARGETS[key] ?? 1e-9, kind: 'abs', note: 'model missing' });
      continue;
    }
    let maxErr = 0;
    tv.T.forEach((T, i) => {
      const got = srf.ivs(tv.k, T);
      tv.k.forEach((k, j) => {
        const e = Math.abs(got[j] - grid[i][j]);
        maxErr = Math.max(maxErr, Number.isFinite(e) ? e : Infinity);
      });
    });
    rows.push({ name: `${MODEL_LABELS[key] || key} implied vol`, err: maxErr, target: TARGETS[key] ?? 1e-9, kind: 'abs',
      note: `${tv.T.length} x ${tv.k.length} points` + (key === 'heston' ? ' (COS N=1024 vs Python adaptive quadrature)' : '') });
  }
  if (Array.isArray(tv.black)) {
    let maxRel = 0, maxIv = 0;
    for (const c of tv.black) {
      const s = blackSens(c.cp, c.F, c.K, c.T, c.sigma, c.D);
      for (const k of BLACK_KEYS) {
        if (!(k in c)) continue;
        const ref = c[k];
        const rel = Math.abs(s[k] - ref) / Math.max(Math.abs(ref), 1e-300);
        maxRel = Math.max(maxRel, Number.isFinite(rel) ? rel : Infinity);
      }
      const iv = impliedVolBlack(c.value, c.cp, c.F, c.K, c.T, c.D);
      maxIv = Math.max(maxIv, Number.isFinite(iv) ? Math.abs(iv - c.sigma) : Infinity);
    }
    rows.push({ name: 'Black-76 value and 7 sensitivities', err: maxRel, target: TARGETS.black, kind: 'rel', note: `${tv.black.length} cases, relative error` });
    rows.push({ name: 'Implied-vol round trip', err: maxIv, target: TARGETS.ivrt, kind: 'abs', note: 'Black values back to sigma' });
  }
  for (const r of rows) r.pass = Number.isFinite(r.err) && r.err <= r.target;
  return { rows, allPass: rows.length > 0 && rows.every((r) => r.pass), ms: performance.now() - t0 };
}
