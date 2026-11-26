// Scenarios tab: spot / vol / time sliders with full revaluation and Taylor P&L attribution, a spot x vol P&L
// heatmap, and the strategy under historical and hypothetical stress scenarios (data/scenarios.json).
import { h, clear, card, slider, segmented, field, num, money, smoney, compact, spct, signed, sortableTable, note } from './ui.js';
import { color, mix } from './charts.js';
import { attribute, scenarioPnl, legState, TERMS } from './strategy.js';
import { legLabel } from './tab_strategy.js';

const TERM_LABELS = {
  delta: 'Delta  (∂V/∂F · dF)', gamma: 'Gamma  (½ ∂²V/∂F² · dF²)', vega: 'Vega  (∂V/∂σ · dσ)',
  vanna: 'Vanna  (∂²V/∂F∂σ · dF dσ)', volga: 'Volga  (½ ∂²V/∂σ² · dσ²)', theta: 'Theta  (∂V/∂τ · dτ)',
  rates: 'Discounting  (∂V/∂D · dD)', residual: 'Residual (higher order)', total: 'Full revaluation',
};
const SPOTS = [-20, -15, -10, -5, -2.5, 0, 2.5, 5, 10, 15, 20];
const VOLS = [20, 10, 5, 0, -5, -10];

export function createScenariosTab(app) {
  const sc = app.scen;
  const el = h('div', { class: 'vd-tabbody' });
  const upd = () => update();
  const sSpot = slider({ label: 'Index move', min: -30, max: 30, step: 0.5, value: sc.spot, fmt: (v) => `${v > 0 ? '+' : ''}${num(v, 1)}%`, oninput: (v) => { sc.spot = v; upd(); } });
  const sVol = slider({ label: 'Parallel vol change', min: -20, max: 40, step: 0.5, value: sc.vol, fmt: (v) => `${v > 0 ? '+' : ''}${num(v, 1)} vp`, oninput: (v) => { sc.vol = v; upd(); } });
  const sDays = slider({ label: 'Days forward', min: 0, max: 30, step: 1, value: sc.days, fmt: (v) => `${v} days`, oninput: (v) => { sc.days = v; upd(); } });
  const sticky = segmented({ label: 'Smile dynamics', value: sc.sticky, onchange: (v) => { sc.sticky = v; app.changed(); },
    options: [{ value: 'moneyness', label: 'Sticky moneyness', title: 'The smile moves with the index (vol at fixed K/F unchanged)' },
      { value: 'strike', label: 'Sticky strike', title: 'Vols at fixed strikes are unchanged by the index move' }] });
  const reset = h('button', { type: 'button', class: 'vd-btn vd-btn-ghost', onclick: () => {
    sc.spot = 0; sc.vol = 0; sc.days = 0; sSpot.set(0); sVol.set(0); sDays.set(0); update();
  } }, 'Reset');
  const kpis = h('div', { class: 'vd-kpis' });
  const attrDiv = h('div');
  const heatDiv = h('div');
  const histDiv = h('div');
  el.append(
    h('div', { class: 'vd-grid vd-g-scen' },
      card('Scenario', h('div', { class: 'vd-scen-ctl' }, sSpot.el, sVol.el, sDays.el), h('div', { class: 'vd-controls' }, sticky.el, reset), kpis),
      card('P&L attribution', attrDiv, note('Second-order Taylor expansion of each leg’s Black-76 value in its forward F, implied vol σ, time to expiry τ and discount factor D, using sensitivities at the start; the residual is full revaluation minus the Taylor sum.'))),
    card('P&L heatmap: index move × vol change', heatDiv),
    card('Historical and hypothetical scenarios', histDiv));

  const legsOk = () => app.market && app.strat.legs.length;

  function update() {
    if (!legsOk()) {
      clear(kpis).append(note('Build a strategy in the Strategy tab first.'));
      clear(attrDiv); clear(heatDiv); clear(histDiv);
      return;
    }
    const legs = app.strat.legs, ex = app.expiries, m0 = app.market;
    const m1 = m0.scenario({ x: Math.log(1 + sc.spot / 100), dv: sc.vol / 100, dt: sc.days / 365, sticky: sc.sticky });
    const at = attribute(legs, ex, m0, m1);
    const v0 = legs.reduce((a, g) => { const s = legState(g, ex[g.exp].T, m0); return a + s.q * s.value; }, 0);
    clear(kpis).append(
      h('div', { class: 'vd-kpi' }, h('div', { class: 'vd-kpi-label' }, 'Scenario P&L (full revaluation)'),
        h('div', { class: 'vd-kpi-value vd-num ' + (at.total.total >= 0 ? 'vd-pos' : 'vd-neg') }, smoney(at.total.total)),
        h('div', { class: 'vd-kpi-sub' }, `position value ${money(v0)} → ${money(v0 + at.total.total)}`)),
      h('div', { class: 'vd-kpi' }, h('div', { class: 'vd-kpi-label' }, 'Index'),
        h('div', { class: 'vd-kpi-value vd-num' }, num(m1.spot, 2)), h('div', { class: 'vd-kpi-sub' }, `from ${num(m0.spot, 2)}`)));
    // attribution table
    const rows = [...TERMS, 'residual', 'total'];
    const head = ['Term', 'Total', ...legs.map((g, i) => `L${i + 1} ${legLabel(app, g)}`)];
    const table = h('table', { class: 'vd-table vd-attr' }, h('caption', { class: 'vd-sr' }, 'P&L attribution by term and leg'),
      h('thead', null, h('tr', null, head.map((x, i) => h('th', { scope: 'col', class: i === 0 ? 'l' : '' }, x)))),
      h('tbody', null, rows.map((t) => h('tr', { class: t === 'total' ? 'vd-row-total' : null },
        h('th', { scope: 'row', class: 'l' }, TERM_LABELS[t]),
        h('td', { class: 'vd-num' }, smoney(at.total[t])),
        ...at.perLeg.map((r) => h('td', { class: 'vd-num' }, smoney(r[t])))))));
    clear(attrDiv).append(h('div', { class: 'vd-table-wrap' }, table));
    drawHeat(legs, ex, m0, v0);
    drawHist(legs, ex, m0);
  }

  function drawHeat(legs, ex, m0, v0) {
    const val = (m) => legs.reduce((a, g) => { const s = legState(g, ex[g.exp].T, m); return a + s.q * s.value; }, 0);
    const grid = VOLS.map((dv) => SPOTS.map((ds) => val(m0.scenario({ x: Math.log(1 + ds / 100), dv: dv / 100, dt: sc.days / 365, sticky: sc.sticky })) - v0));
    const amax = Math.max(...grid.flat().map(Math.abs), 1);
    const surf = color('--surface'), pos = color('--vd-div-pos'), neg = color('--vd-div-neg');
    const nearS = SPOTS.reduce((b, v) => (Math.abs(v - sc.spot) < Math.abs(b - sc.spot) ? v : b), SPOTS[0]);
    const nearV = VOLS.reduce((b, v) => (Math.abs(v - sc.vol) < Math.abs(b - sc.vol) ? v : b), VOLS[0]);
    const table = h('table', { class: 'vd-table vd-heat' },
      h('caption', { class: 'vd-sr' }, 'P&L by index move (columns) and vol change (rows)'),
      h('thead', null, h('tr', null, h('th', { scope: 'col', class: 'l' }, 'Vol \\ index'), SPOTS.map((x) => h('th', { scope: 'col' }, `${x > 0 ? '+' : ''}${x}%`)))),
      h('tbody', null, VOLS.map((dv, i) => h('tr', null, h('th', { scope: 'row', class: 'l' }, `${dv > 0 ? '+' : ''}${dv} vp`),
        SPOTS.map((ds, j) => {
          const v = grid[i][j];
          const t = Math.min(1, Math.abs(v) / amax);
          return h('td', { class: 'vd-num' + (ds === nearS && dv === nearV ? ' vd-cell-sel' : ''), title: `${ds}% index, ${dv} vol pts: ${money(v)}`,
            style: { background: mix(surf, v >= 0 ? pos : neg, 0.12 + 0.6 * t) } }, compact(v));
        })))));
    clear(heatDiv).append(h('div', { class: 'vd-table-wrap' }, table),
      note(`Full revaluation after ${sc.days} day${sc.days === 1 ? '' : 's'}, ${sc.sticky === 'moneyness' ? 'sticky moneyness' : 'sticky strike'}; blue cells gain, red cells lose, numbers in dollars. The outlined cell is closest to the sliders.`));
  }

  function drawHist(legs, ex, m0) {
    const list = app.scenarios?.scenarios || [];
    if (!list.length) { clear(histDiv).append(note('Scenario file not available.')); return; }
    const rows = list.map((s) => {
      const r = scenarioPnl(legs, ex, m0, s);
      return { name: s.name, kind: s.kind || 'historical', window: s.start ? `${s.start} → ${s.end}` : '—', days: s.days,
        spot: s.spot_return, atm30: s.atm_change?.['30'], skew30: s.skew_change?.skew30, applied: r.dtDays, pnl: r.pnl };
    });
    const vp = (v) => (Number.isFinite(v) ? signed(v * 100, 1) : '–');
    clear(histDiv).append(sortableTable({
      caption: 'Strategy P&L under historical and hypothetical scenarios', sortKey: 'pnl', sortDir: 1, rows,
      columns: [
        { key: 'name', label: 'Scenario', align: 'left' },
        { key: 'kind', label: 'Type', align: 'left', fmt: (v) => h('span', { class: 'vd-badge ' + (v === 'hypothetical' ? 'hyp' : 'hist') }, v) },
        { key: 'window', label: 'Window', align: 'left' },
        { key: 'days', label: 'Days', fmt: (v) => num(v, 0) },
        { key: 'spot', label: 'Index', fmt: (v) => spct(v, 1) },
        { key: 'atm30', label: '30d ATM vol', title: 'Change in 30-day ATM implied vol, vol points', fmt: vp },
        { key: 'skew30', label: '30d skew', title: 'Change in 30-day 25-delta minus 50-delta put vol, vol points', fmt: vp },
        { key: 'applied', label: 'Days applied', title: 'Time advanced: the scenario length, capped one day before the first leg expires', fmt: (v) => num(v, 1) },
        { key: 'pnl', label: 'Strategy P&L', fmt: (v) => smoney(v), cls: 'vd-strong' },
      ],
    }), note('Each scenario moves the index by its return and every leg’s vol by the ATM-vol change at the leg’s remaining tenor (linear in days between 10, 30, 91, 182 and 365 days, flat outside) plus a put-side skew shock: the 25-minus-50-delta skew change times max(0, −k) / (0.674 · ATM vol · √T), capped at 2x. Time advances by the scenario length, at most to one day before the first expiry; smiles are sticky in moneyness. Historical shocks are measured on the S&P 500 (OptionMetrics standardized surfaces) and applied as-is to the selected underlying.'));
  }

  function render() {
    if (!app.bundle) return;
    const legs = app.strat.legs;
    const maxDays = legs.length ? Math.max(0, Math.floor(Math.min(...legs.map((g) => app.expiries[g.exp].T)) * 365 + 1e-9)) : 0;
    sDays.setMax(maxDays);
    if (sc.days > maxDays) sc.days = maxDays;
    sDays.set(sc.days);
    sticky.set(sc.sticky);
    update();
  }

  return { el, render };
}
