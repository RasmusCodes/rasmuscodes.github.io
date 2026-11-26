// Surface tab: 3D implied-vol surface (model or difference to SVI), smile by expiry, ATM term structure,
// per-expiry fit statistics and the date's static-arbitrage diagnostics.
import { h, clear, card, selectEl, segmented, field, num, signed, pct, sci, simpleTable, note } from './ui.js';
import { lineChart, modelColor, color, niceTicks, seqStops, divStops, toRgb, rampRgb } from './charts.js';
import { Surface3D } from './surface3d.js';
import { MODEL_KEYS, MODEL_LABELS, MODEL_BLURB, quotedRange, daysLabel } from './models.js';
import { shiftedVol, VOL_FLOOR } from './strategy.js';
import { linspace } from './math.js';

const NC = 41;
const AXES = {
  KF: { label: 'Moneyness K/F', f: (k) => Math.exp(k), fmt: (v) => num(v, 2) },
  k: { label: 'Log-moneyness ln(K/F)', f: (k) => k, fmt: (v) => num(v, 2) },
  std: { label: 'Standardised moneyness ln(K/F)/√T', f: (k, T) => k / Math.sqrt(T), fmt: (v) => num(v, 1) },
};
const T_TICKS = [7, 14, 30, 61, 91, 182, 273, 365, 547, 730, 1095];

export function createSurfaceTab(app) {
  const st = app.surf;
  const cache = new Map();
  const el = h('div', { class: 'vd-tabbody' });

  // ---------------------------------------------------------------- controls + 3D
  const modeSeg = segmented({ label: 'Surface shown', value: st.mode, onchange: (v) => { st.mode = v; draw3d(); },
    options: [{ value: 'model', label: 'Selected model' }, { value: 'diff', label: 'Difference to SVI' }] });
  const axisSel = selectEl({ label: 'Moneyness axis', value: st.axis, onchange: (v) => { st.axis = v; render(); },
    options: [{ value: 'KF', label: 'K/F' }, { value: 'k', label: 'ln(K/F)' }, { value: 'std', label: 'ln(K/F)/√T' }] });
  const wings = h('input', { type: 'checkbox', id: 'vd-wings' });
  wings.checked = st.wings;
  wings.addEventListener('change', () => { st.wings = wings.checked; render(); });
  const resetView = h('button', { type: 'button', class: 'vd-btn vd-btn-ghost', onclick: () => surf3d.reset() }, 'Reset view');
  const wrap3d = h('div', { class: 'vd-3d' });
  const surf3d = new Surface3D(wrap3d);
  const colorbar = h('div', { class: 'vd-colorbar' });
  const msg3d = h('p', { class: 'vd-note' });
  const blurb = h('p', { class: 'vd-note' });
  const card3d = card('Implied volatility surface',
    h('div', { class: 'vd-controls' }, modeSeg.el, field('Axis', axisSel),
      h('div', { class: 'vd-check' }, wings, h('label', { for: 'vd-wings' }, 'Extrapolated wings')), resetView),
    wrap3d, colorbar, msg3d, blurb);

  // ---------------------------------------------------------------- smile + term structure
  const expSel = selectEl({ label: 'Expiry', value: '0', options: [], onchange: (v) => { st.exp = Number(v); drawSmile(); drawTerm(); drawFit(); } });
  const smileDiv = h('div');
  const termDiv = h('div');
  const cardSmile = card('Smile by expiry', h('div', { class: 'vd-controls' }, field('Expiry', expSel)), smileDiv);
  const cardTerm = card('ATM term structure', termDiv);

  // ---------------------------------------------------------------- tables
  const fitDiv = h('div');
  const arbDiv = h('div');
  const cardFit = card('Fit quality by expiry', note('RMSE of model minus mid implied vol (vol points) and the share of quotes whose model vol lies inside the bid-ask spread, per fitted expiry.'), fitDiv);
  const cardArb = card('Static-arbitrage diagnostics for this date', note('Butterfly: min of the Gatheral-Jacquier g function and share of grid points with g < 0, on the quoted range and on the extrapolated grid. Calendar: share of points where total variance falls with maturity. Local variance valid: share of the grid with a usable Dupire local variance.'), arbDiv);

  el.append(h('div', { class: 'vd-grid vd-g-surface' }, card3d, h('div', { class: 'vd-stack' }, cardSmile, cardTerm)), h('div', { class: 'vd-grid vd-g-2' }, cardFit, cardArb));

  // ---------------------------------------------------------------- helpers
  const avail = () => MODEL_KEYS.filter((k) => app.surfaces[k]);
  const volOf = (base, k, T) => Math.max(shiftedVol(base, k, T, app.state.shifts), VOL_FLOOR);

  function baseGrid(key) {
    const srf = app.surfaces[key];
    if (!srf) return null;
    const ck = `${app.state.und}|${app.state.date}|${key}|${st.wings}`;
    if (cache.has(ck)) return cache.get(ck);
    const Ts = app.expiries.map((e) => e.T);
    const rowsT = [];
    Ts.forEach((T, i) => { rowsT.push(T); if (i < Ts.length - 1) for (const f of [1 / 3, 2 / 3]) rowsT.push(T + f * (Ts[i + 1] - T)); });
    const rows = rowsT.map((T) => {
      const [lo, hi] = quotedRange(app.bundle, T);
      const span = Math.max(hi - lo, 0.02), mg = st.wings ? 0.3 * span : 0;
      const ks = new Float64Array(NC), ex = new Uint8Array(NC);
      for (let j = 0; j < NC; j++) {
        ks[j] = lo - mg + (span + 2 * mg) * j / (NC - 1);
        ex[j] = ks[j] < lo - 1e-9 || ks[j] > lo + span + 1e-9 ? 1 : 0;
      }
      return { T, ks, iv: srf.ivs(ks, T), ex };
    });
    cache.set(ck, rows);
    if (cache.size > 30) cache.delete(cache.keys().next().value);
    return rows;
  }

  function nearestExpiry(T) {
    let best = app.expiries[0], bd = Infinity;
    for (const e of app.expiries) { const d = Math.abs(e.T - T); if (d < bd) { bd = d; best = e; } }
    return best;
  }

  function draw3d() {
    const key = app.state.model;
    const rows = baseGrid(key);
    msg3d.textContent = '';
    blurb.textContent = MODEL_BLURB[key] || '';
    if (!rows) { surf3d.setData(null); msg3d.textContent = 'This model is not available for this date.'; return; }
    const diff = st.mode === 'diff';
    const ref = diff ? baseGrid('svi') : null;
    if (diff && !ref) msg3d.textContent = 'SVI is not available for this date, so no difference can be shown.';
    if (diff && key === 'svi') msg3d.textContent = 'Select another model in the top bar to see its difference to SVI (zero everywhere here).';
    const ax = AXES[st.axis];
    const T0 = rows[0].T, Tn = rows[rows.length - 1].T;
    const sq0 = Math.sqrt(T0), sqn = Math.sqrt(Tn);
    let xmin = Infinity, xmax = -Infinity, zmin = Infinity, zmax = -Infinity;
    const out = rows.map((r, ri) => {
      const x = new Float64Array(NC), z = new Float64Array(NC);
      for (let j = 0; j < NC; j++) {
        x[j] = ax.f(r.ks[j], r.T);
        z[j] = diff ? (ref ? (r.iv[j] - ref[ri].iv[j]) * 100 : 0) : volOf(r.iv[j], r.ks[j], r.T) * 100;
        if (Number.isFinite(x[j])) { xmin = Math.min(xmin, x[j]); xmax = Math.max(xmax, x[j]); }
        if (Number.isFinite(z[j])) { zmin = Math.min(zmin, z[j]); zmax = Math.max(zmax, z[j]); }
      }
      return { T: r.T, t: (Math.sqrt(r.T) - sq0) / (sqn - sq0 || 1), xr: x, z, ex: r.ex, ks: r.ks };
    });
    if (diff) { const a = Math.max(Math.abs(zmin), Math.abs(zmax), 0.25); zmin = -a; zmax = a; }
    for (const r of out) { r.x = Float64Array.from(r.xr, (v) => (v - xmin) / (xmax - xmin || 1)); }
    const xTicks = niceTicks(xmin, xmax, 5).map((v) => ({ p: (v - xmin) / (xmax - xmin), label: ax.fmt(v) }));
    const tTicks = T_TICKS.map((d) => d / 365).filter((T) => T >= T0 * 0.98 && T <= Tn * 1.02)
      .map((T) => ({ p: (Math.sqrt(T) - sq0) / (sqn - sq0), label: daysLabel(T) }));
    const zTicks = niceTicks(zmin, zmax, 4).map((v) => ({ v, label: diff ? signed(v, 1) : num(v, 0) + '%' }));
    surf3d.setData({
      rows: out, zMin: zmin, zMax: zmax, mode: diff ? 'div' : 'seq', xTicks, tTicks, zTicks,
      xLabel: ax.label, tLabel: 'Maturity', zLabel: diff ? `${MODEL_LABELS[key]} − SVI (vol pts)` : 'Implied vol',
      hoverText: (ri, ci) => {
        const r = out[ri], k = r.ks[ci], e = nearestExpiry(r.T);
        const head = `${daysLabel(r.T)} (${num(r.T * 365, 0)} days; nearest expiry ${e.expiry})`;
        const mny = `K/F ${num(Math.exp(k), 3)} · ln(K/F) ${num(k, 3)}`;
        const val = diff ? `${MODEL_LABELS[key]} − SVI ${signed(r.z[ci], 2)} vol pts` : `implied vol ${num(r.z[ci], 2)}%`;
        return `${head} · ${mny} · ${val}${r.ex[ci] ? ' · extrapolated (outside the quoted range)' : ''}`;
      },
    });
    // colour bar
    const stops = diff ? divStops() : seqStops();
    const grad = stops.map((c, i) => `${toRgb(c)} ${(i / (stops.length - 1) * 100).toFixed(0)}%`).join(', ');
    clear(colorbar).append(
      h('span', { class: 'vd-num' }, diff ? signed(zmin, 1) : num(zmin, 1) + '%'),
      h('span', { class: 'vd-cbar', style: { background: `linear-gradient(90deg, ${grad})` }, 'aria-hidden': 'true' }),
      h('span', { class: 'vd-num' }, diff ? signed(zmax, 1) : num(zmax, 1) + '%'),
      h('span', { class: 'vd-cbar-label' }, diff ? 'model minus SVI, vol points' : 'implied vol'),
      st.wings ? h('span', { class: 'vd-hatch-key' }, h('span', { class: 'vd-hatch', 'aria-hidden': 'true' }), 'extrapolated beyond the quoted moneyness range') : null);
  }

  function drawSmile() {
    const e = app.expiries[st.exp];
    if (!e) return;
    const ax = AXES[st.axis];
    const span = Math.max(e.k_max - e.k_min, 0.02);
    const ks = linspace(e.k_min - 0.3 * span, e.k_max + 0.3 * span, 121);
    const series = avail().map((key) => {
      const iv = app.surfaces[key].ivs(ks, e.T);
      return { key, name: MODEL_LABELS[key], color: modelColor(key), width: key === app.state.model ? 3 : 1.6,
        opacity: key === app.state.model ? 1 : 0.85, points: ks.map((k, i) => [ax.f(k, e.T), volOf(iv[i], k, e.T) * 100]) };
    });
    const shifted = app.state.shifts.vol || app.state.shifts.tilt;
    lineChart(smileDiv, {
      height: 250, series,
      markers: Number.isFinite(e.atm_iv) ? [{ key: 'atm', name: 'ATM vol (data)', color: color('--ink'), points: [[ax.f(0, e.T), e.atm_iv * 100, `ATM vol in the data (${e.expiry})`]] }] : [],
      bands: [{ x0: ax.f(e.k_min, e.T), x1: ax.f(e.k_max, e.T), label: 'quoted range' }],
      x: { label: ax.label, fmt: ax.fmt }, y: { label: 'Implied vol (%)', fmt: (v) => num(v, 1) },
      tipX: (v) => `${ax.label}: ${ax.fmt(v)}`,
      aria: `Implied volatility smile for the ${e.expiry} expiry, all models`,
      caption: `${e.expiry} · ${num(e.T * 365, 0)} days · forward ${num(e.F, 2)} · ${e.n ?? '?'} quotes, median bid-ask ${num((e.spread_med ?? NaN) * 100, 2)} vol pts${shifted ? ' · model curves include the assumption shifts' : ''}`,
    });
  }

  function drawTerm() {
    const Ts = app.expiries.map((e) => e.T);
    const T0 = Ts[0] * 0.6, Tn = Ts[Ts.length - 1] * 1.05;
    const grid = linspace(Math.sqrt(T0), Math.sqrt(Tn), 70).map((v) => v * v);
    const series = avail().map((key) => {
      const srf = app.surfaces[key];
      return { key, name: MODEL_LABELS[key], color: modelColor(key), width: key === app.state.model ? 3 : 1.6,
        points: grid.map((T) => [T * 365, volOf(srf.iv(0, T), 0, T) * 100]) };
    });
    const sel = app.expiries[st.exp];
    lineChart(termDiv, {
      height: 230, series,
      markers: [{ key: 'atmq', name: 'ATM vol (data)', color: color('--ink'), points: app.expiries.filter((e) => Number.isFinite(e.atm_iv)).map((e) => [e.T * 365, e.atm_iv * 100, `${e.expiry} ATM vol (data)`]) }],
      vlines: sel ? [{ x: sel.T * 365, label: sel.expiry }] : [],
      x: { label: 'Days to expiry (square-root scale)', type: 'sqrt', min: T0 * 365, max: Tn * 365,
        ticks: [7, 30, 91, 182, 365, 730].map((d) => ({ v: d, label: daysLabel(d / 365) })) },
      y: { label: 'ATM implied vol (%)', fmt: (v) => num(v, 1) },
      tipX: (v) => `${num(v, 0)} days`,
      aria: 'At-the-money implied volatility term structure by model, with the ATM vols in the data as dots',
    });
  }

  function drawFit() {
    const ks = avail();
    const M = app.bundle.models;
    const head = ['Expiry', 'Days', 'Quotes', 'Spread (vp)', ...ks.flatMap((k) => [`${MODEL_LABELS[k]} RMSE`, `${MODEL_LABELS[k]} inside`])];
    const body = app.expiries.map((e, i) => {
      const cells = [e.expiry, num(e.T * 365, 0), String(e.n ?? '–'), num((e.spread_med ?? NaN) * 100, 2)];
      for (const k of ks) {
        const f = (M[k].fit || []).find((r) => Math.abs(r.T - e.T) < 1e-6 || r.expiry === e.expiry);
        cells.push(f ? num(f.rmse, 2) : '–', f ? pct(f.inside, 0) : '–');
      }
      return { cells, cls: i === st.exp ? 'vd-row-sel' : null };
    });
    clear(fitDiv).append(simpleTable(head, body, { caption: 'Fit statistics by expiry and model' }));
  }

  function drawArb() {
    const M = app.bundle.models;
    const ks = MODEL_KEYS.filter((k) => M[k]);
    const g = (k) => M[k].arbitrage || {};
    const fmtG = (v) => (Number.isFinite(v) ? (Math.abs(v) >= 0.01 ? num(v, 3) : sci(v, 1)) : '–');
    const rows = [
      ['Fit converged', (k) => (M[k].success === true ? 'yes' : M[k].success === false ? 'no' : '–')],
      ['Fit time (s)', (k) => num(M[k].seconds, 2)],
      ['min g, quoted range', (k) => fmtG(g(k).min_g_quoted)],
      ['min g, extrapolated', (k) => fmtG(g(k).min_g_extrap)],
      ['g < 0 share, extrapolated', (k) => pct(g(k).share_g_neg_extrap, 2)],
      ['Calendar violations, quoted', (k) => pct(g(k).share_calendar_viol_quoted ?? g(k).share_calendar_viol, 2)],
      ['Calendar violations, extrapolated', (k) => pct(g(k).share_calendar_viol_extrap, 2)],
      ['Worst calendar Δw', (k) => fmtG(g(k).worst_calendar_dw)],
      ['Local variance valid', (k) => pct(g(k).share_localvar_valid, 1)],
      ['Wing slope left / right', (k) => `${num(g(k).wing_slope_left, 3)} / ${num(g(k).wing_slope_right, 3)}`],
    ];
    if (M.heston && Number.isFinite(M.heston.feller)) rows.push(['Heston Feller ratio 2κθ/σ²', (k) => (k === 'heston' ? num(M.heston.feller, 3) : '')]);
    clear(arbDiv).append(simpleTable(['Diagnostic', ...ks.map((k) => MODEL_LABELS[k])], rows.map(([lab, f]) => [lab, ...ks.map(f)]),
      { caption: 'Arbitrage diagnostics by model' }));
  }

  function render() {
    if (!app.bundle) return;
    clear(expSel).append(...app.expiries.map((e, i) => h('option', { value: String(i) }, `${e.expiry} (${num(e.T * 365, 0)}d)`)));
    st.exp = Math.min(st.exp, app.expiries.length - 1);
    expSel.value = String(st.exp);
    draw3d();
    drawSmile();
    drawTerm();
    drawFit();
    drawArb();
  }

  return { el, render, onTheme: () => { if (app.bundle) draw3d(); } };
}
