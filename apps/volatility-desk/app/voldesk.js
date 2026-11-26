// Volatility desk: entry module. Finds #voldesk-app, loads the data bundle (resolved relative to this module, so the
// same files work standalone and under /apps/volatility-desk/ on the website) and renders the tabs.
import { h, clear, selectEl, slider, field, onThemeChange, num, sci, simpleTable, rafThrottle } from './ui.js';
import { setColorRoot, redrawAll } from './charts.js';
import { buildAllSurfaces, MODEL_KEYS, MODEL_LABELS } from './models.js';
import { baseMarket, applyPreset, defaultNear } from './strategy.js';
import { runSelfTest } from './selftest.js';
import { createSurfaceTab } from './tab_surface.js';
import { createStrategyTab } from './tab_strategy.js';
import { createScenariosTab } from './tab_scenarios.js';
import { createBacktestsTab } from './tab_backtests.js';
import { createModelsTab } from './tab_models.js';

const DATA = new URL('../data/', import.meta.url);

async function getJSON(path, optional = false) {
  const r = await fetch(new URL(path, DATA));
  if (!r.ok) {
    if (optional) return null;
    throw new Error(`${path}: HTTP ${r.status}`);
  }
  return r.json();
}

async function init() {
  const root = document.getElementById('voldesk-app');
  if (!root || root.dataset.vdInit) return;
  root.dataset.vdInit = '1';
  root.classList.add('vd');
  setColorRoot(root);
  clear(root).append(h('p', { class: 'vd-loading' }, 'Loading the volatility desk…'));
  let manifest;
  try {
    manifest = await getJSON('manifest.json');
  } catch (e) {
    clear(root).append(h('p', { class: 'vd-error' }, `Could not load the data bundle (${e.message}).`));
    return;
  }
  const [scenarios, models, backtests] = await Promise.all([
    getJSON('scenarios.json', true).catch(() => null),
    getJSON('models.json', true).catch(() => null),
    getJSON('backtests.json', true).catch(() => null),
  ]);
  const unds = Object.keys(manifest.underlyings || {});
  const und0 = unds[0];
  const app = {
    root, manifest, scenarios, models, backtests,
    state: { und: und0, date: manifest.underlyings[und0].dates[0], model: 'svi', shifts: { vol: 0, tilt: 0, rate: 0, div: 0 } },
    surf: { exp: 0, mode: 'model', axis: 'KF', wings: true },
    strat: { legs: [], preset: 'long_straddle', near: 0, horizon: null, greek: 'delta1' },
    scen: { spot: 0, vol: 0, days: 0, sticky: 'moneyness' },
    bundle: null, surfaces: {}, expiries: [], market: null,
    dataVersion: 0, legsVersion: 0, valuesVersion: 0,
  };

  // ------------------------------------------------------------------ top bar
  const undSel = selectEl({ label: 'Underlying', value: und0, options: unds.map((u) => ({ value: u, label: u })),
    onchange: (v) => { const d = manifest.underlyings[v].dates; loadDate(v, d[0]); } });
  const dateSel = selectEl({ label: 'Date', value: app.state.date, options: [], onchange: (v) => loadDate(app.state.und, v) });
  const modelSel = selectEl({ label: 'Model', value: 'svi', options: MODEL_KEYS.map((k) => ({ value: k, label: MODEL_LABELS[k] })),
    onchange: (v) => { app.state.model = v; rebuildMarket(); changed('model'); } });
  const onShift = rafThrottle(() => { rebuildMarket(); changed('shifts'); });
  const sh = app.state.shifts;
  const sVol = slider({ label: 'Vol shift', min: -10, max: 10, step: 0.25, value: 0, fmt: (v) => `${v > 0 ? '+' : ''}${num(v, 2)} vp`,
    title: 'Parallel shift of every implied vol, in vol points', oninput: (v) => { sh.vol = v; onShift(); } });
  const sTilt = slider({ label: 'Skew tilt', min: -5, max: 5, step: 0.25, value: 0, fmt: (v) => `${v > 0 ? '+' : ''}${num(v, 2)} vp`,
    title: 'Adds tilt vol points per 10% of moneyness below the forward (subtracts above), scaled by 1/sqrt(T); capped at 4 units',
    oninput: (v) => { sh.tilt = v; onShift(); } });
  const sRate = slider({ label: 'Rate shift', min: -300, max: 300, step: 5, value: 0, fmt: (v) => `${v > 0 ? '+' : ''}${v} bp`,
    title: 'Parallel shift of the zero rate: D′ = D e^(−dr T), F′ = F e^(dr T)', oninput: (v) => { sh.rate = v; onShift(); } });
  const sDiv = slider({ label: 'Dividend yield shift', min: -300, max: 300, step: 5, value: 0, fmt: (v) => `${v > 0 ? '+' : ''}${v} bp`,
    title: 'Parallel shift of the dividend yield: F′ = F e^(−dq T)', oninput: (v) => { sh.div = v; onShift(); } });
  const resetBtn = h('button', { type: 'button', class: 'vd-btn', onclick: () => {
    Object.assign(sh, { vol: 0, tilt: 0, rate: 0, div: 0 });
    [sVol, sTilt, sRate, sDiv].forEach((x) => x.set(0));
    rebuildMarket(); changed('shifts');
  } }, 'Reset assumptions');
  const info = h('p', { class: 'vd-info' });
  const top = h('div', { class: 'vd-top' },
    h('div', { class: 'vd-top-sel' }, field('Underlying', undSel), field('Date', dateSel), field('Model', modelSel)),
    h('div', { class: 'vd-top-shifts' }, sVol.el, sTilt.el, sRate.el, sDiv.el, h('div', { class: 'vd-top-reset' }, resetBtn)),
    info);

  // ------------------------------------------------------------------ tabs
  const tabs = [
    { id: 'surface', label: 'Surface', make: createSurfaceTab },
    { id: 'strategy', label: 'Strategy', make: createStrategyTab },
    { id: 'scenarios', label: 'Scenarios', make: createScenariosTab },
    { id: 'backtests', label: 'Backtests', make: createBacktestsTab },
    { id: 'models', label: 'Models', make: createModelsTab },
  ];
  const tablist = h('div', { class: 'vd-tabs', role: 'tablist', 'aria-label': 'Volatility desk sections' });
  const panels = h('div', { class: 'vd-panels' });
  let active = 'surface';
  const selectTab = (id, focus = false) => {
    active = id;
    for (const t of tabs) {
      const on = t.id === id;
      t.btn.setAttribute('aria-selected', String(on));
      t.btn.tabIndex = on ? 0 : -1;
      t.panel.hidden = !on;
      if (on && focus) t.btn.focus();
    }
    renderActive();
  };
  tabs.forEach((t, i) => {
    t.btn = h('button', { type: 'button', role: 'tab', id: `vd-tab-${t.id}`, 'aria-controls': `vd-panel-${t.id}`, class: 'vd-tab' }, t.label);
    t.btn.addEventListener('click', () => selectTab(t.id));
    t.btn.addEventListener('keydown', (e) => {
      const n = tabs.length;
      let j = null;
      if (e.key === 'ArrowRight') j = (i + 1) % n;
      else if (e.key === 'ArrowLeft') j = (i - 1 + n) % n;
      else if (e.key === 'Home') j = 0;
      else if (e.key === 'End') j = n - 1;
      if (j != null) { e.preventDefault(); selectTab(tabs[j].id, true); }
    });
    t.panel = h('div', { role: 'tabpanel', id: `vd-panel-${t.id}`, 'aria-labelledby': `vd-tab-${t.id}`, class: 'vd-panel', tabindex: '0' });
    tablist.append(t.btn);
    panels.append(t.panel);
  });

  // ------------------------------------------------------------------ footer + self-test
  const testOut = h('div', { class: 'vd-selftest-out' });
  const testBtn = h('button', { type: 'button', class: 'vd-btn' }, 'Run self-test');
  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    clear(testOut).append(h('p', { class: 'vd-note' }, 'Running…'));
    try {
      const tv = await getJSON('test_vectors.json');
      const date = String(tv.surface || '').replace(/\.json$/, '');
      const und = unds.find((u) => manifest.underlyings[u].dates.includes(date)) || und0;
      const bundle = await getJSON(`surfaces/${und}/${date}.json`);
      const r = runSelfTest(tv, bundle);
      clear(testOut).append(
        h('p', { class: 'vd-note' }, `Reference: ${und} ${date}, computed by the Python library (scripts/make_test_vectors.py). ${r.allPass ? 'All checks pass.' : 'Some checks FAIL.'} (${num(r.ms, 0)} ms)`),
        simpleTable(['Check', 'Max error', 'Target', 'Result', 'Notes'], r.rows.map((x) => [x.name, sci(x.err, 2), `≤ ${sci(x.target, 0)}${x.kind === 'rel' ? ' (rel.)' : ''}`,
          h('span', { class: x.pass ? 'vd-pass' : 'vd-fail' }, x.pass ? 'pass' : 'FAIL'), x.note || '']), { caption: 'Self-test results', leftCols: [4] }));
    } catch (e) {
      clear(testOut).append(h('p', { class: 'vd-error' }, `Self-test could not run: ${e.message}`));
    }
    testBtn.disabled = false;
  });
  const repo = manifest.repo;
  const footer = h('footer', { class: 'vd-footer' },
    h('p', null, 'Data: OptionMetrics IvyDB US and Cboe option data, both via WRDS (each date names its source). The surfaces are rebuilt in your browser from model parameters fitted by the repository’s code; no raw option quotes are shipped. ',
      repo ? h('a', { href: repo, rel: 'noopener' }, 'Source code') : null, '. Educational research tool, not investment advice.'),
    h('details', { class: 'vd-selftest' }, h('summary', null, 'Self-test: JavaScript math vs the Python library'),
      h('p', { class: 'vd-note' }, 'Recomputes model implied vols and Black-76 values and sensitivities and compares them with reference values from the Python code. Targets: SVI, eSSVI, SSVI, SABR ≤ 1e-9; Heston ≤ 2e-4 (COS here, adaptive quadrature in Python); Black relative ≤ 1e-9.'),
      testBtn, testOut));

  clear(root).append(top, tablist, panels, footer);
  for (const t of tabs) {
    t.view = t.make(app);
    t.panel.append(t.view.el);
    t.dirty = true;
  }

  // ------------------------------------------------------------------ state changes
  function rebuildMarket() {
    const srf = app.surfaces[app.state.model];
    app.market = srf ? baseMarket(app.bundle, srf, app.state.shifts) : null;
  }
  function renderActive() {
    const t = tabs.find((x) => x.id === active);
    if (t && t.dirty) {
      t.dirty = false;
      try { t.view.render(); } catch (e) { console.error('voldesk render error', e); }
    }
  }
  function changed() {
    for (const t of tabs) t.dirty = true;
    renderActive();
  }
  app.changed = changed;
  app.applyPreset = () => {
    app.strat.legs = applyPreset(app.strat.preset, app.expiries, app.strat.near, app.market);
    app.legsVersion++;
    changed();
  };
  app.legsChanged = (structural) => {
    if (structural) app.legsVersion++;
    app.valuesVersion++;
    for (const t of tabs) if (t.id !== 'strategy') t.dirty = true;
  };

  async function loadDate(und, date) {
    let bundle;
    try {
      bundle = await getJSON(`surfaces/${und}/${date}.json`);
    } catch (e) {
      info.textContent = `Could not load ${und} ${date}: ${e.message}`;
      return;
    }
    app.state.und = und;
    app.state.date = date;
    app.bundle = bundle;
    app.surfaces = buildAllSurfaces(bundle);
    app.expiries = [...bundle.expiries].sort((a, b) => a.T - b.T);
    const avail = MODEL_KEYS.filter((k) => app.surfaces[k]);
    if (!avail.includes(app.state.model)) app.state.model = avail[0];
    clear(dateSel).append(...manifest.underlyings[und].dates.map((d) => h('option', { value: d }, d)));
    dateSel.value = date;
    undSel.value = und;
    clear(modelSel).append(...MODEL_KEYS.map((k) => h('option', { value: k, disabled: !app.surfaces[k] || null }, MODEL_LABELS[k] + (app.surfaces[k] ? '' : ' (n/a)'))));
    modelSel.value = app.state.model;
    const u = manifest.underlyings[und];
    info.textContent = `${und} · ${u.name || ''} · ${date} · spot ${num(bundle.spot, 2)} · ${app.expiries.length} expiries · source: ${bundle.source || 'n/a'}${/american/i.test(u.name || '') ? ' · American-style options, valued here as European (Black-76), which ignores the early-exercise premium' : ''}`;
    rebuildMarket();
    app.strat.near = defaultNear(app.expiries);
    app.surf.exp = app.strat.near;
    app.dataVersion++;
    app.scen.days = 0;
    app.strat.horizon = null;
    app.applyPreset();
  }

  onThemeChange(() => {
    redrawAll();
    for (const t of tabs) if (t.view.onTheme) t.view.onTheme();
  });
  selectTab('surface');
  await loadDate(app.state.und, app.state.date);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
