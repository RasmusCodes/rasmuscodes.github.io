// Strategy tab: presets and editable legs, Black-76 pricing off the selected model, desk Greeks,
// P&L-vs-spot (first expiry, today, horizon) and Greeks-vs-spot charts.
import { h, clear, card, selectEl, slider, field, num, money, vol, note } from './ui.js';
import { lineChart, color, slotColor } from './charts.js';
import { PRESETS, newLeg, solveStrike, portfolio, legState } from './strategy.js';
import { linspace } from './math.js';

export const GREEKS = [
  { key: 'delta1', label: 'Delta ($ per +1% index move)', short: 'Delta $/1%' },
  { key: 'gamma1', label: 'Gamma ($, 2nd-order P&L of a 1% move)', short: 'Gamma $/1%' },
  { key: 'vega1', label: 'Vega ($ per vol point)', short: 'Vega $/vp' },
  { key: 'theta1', label: 'Theta ($ per calendar day)', short: 'Theta $/day' },
  { key: 'vanna1', label: 'Vanna ($ for +1% index and +1 vol point)', short: 'Vanna' },
  { key: 'volga1', label: 'Volga ($, 2nd-order P&L of 1 vol point)', short: 'Volga' },
  { key: 'delta', label: 'Delta (index units)', short: 'Delta units' },
];
const round1 = (x) => Math.round(x * 10) / 10;

export function legLabel(app, g) {
  const e = app.expiries[g.exp];
  return `${g.side > 0 ? '+' : '−'}${g.qty} ${e ? e.expiry.slice(2) : '?'} ${num(g.K, g.K % 1 ? 1 : 0)}${g.cp > 0 ? 'C' : 'P'}`;
}

export function createStrategyTab(app) {
  const S = app.strat;
  const el = h('div', { class: 'vd-tabbody' });
  let seenData = -1, seenLegs = -1;
  const refs = new Map();

  const presetSel = selectEl({ label: 'Preset', value: S.preset, options: PRESETS.map((p) => ({ value: p.id, label: p.name })),
    onchange: (v) => { S.preset = v; app.applyPreset(); } });
  const nearSel = selectEl({ label: 'Preset expiry', value: '0', options: [], onchange: (v) => { S.near = Number(v); app.applyPreset(); } });
  const applyBtn = h('button', { type: 'button', class: 'vd-btn vd-btn-ghost', onclick: () => app.applyPreset() }, 'Re-apply preset');
  const addBtn = h('button', { type: 'button', class: 'vd-btn', onclick: () => {
    const g = newLeg({ exp: S.near, side: 1, cp: 1, mode: 'pct', target: 100 });
    g.K = solveStrike(g.mode, g.target, g.cp, app.expiries[g.exp].T, app.market);
    S.legs.push(g);
    app.legsChanged(true);
    rebuildRows();
    update();
  } }, '+ Add leg');
  const tbody = h('tbody');
  const legsTable = h('div', { class: 'vd-table-wrap' }, h('table', { class: 'vd-table vd-legs' },
    h('caption', { class: 'vd-sr' }, 'Strategy legs'),
    h('thead', null, h('tr', null, ['Side', 'Qty', 'Type', 'Expiry', 'Strike by', 'Input', 'Strike', 'Vol', 'Price', 'Fwd Δ', 'Value', ''].map((x, i) =>
      h('th', { scope: 'col', class: i < 6 ? 'l' : '' }, x)))), tbody));
  const builder = card('Strategy builder',
    h('div', { class: 'vd-controls' }, field('Preset', presetSel), field('Preset expiry', nearSel), applyBtn, addBtn),
    legsTable,
    note('Each leg is priced with Black-76 at the selected model’s implied vol for its strike and expiry, after the top-bar assumption shifts; contract multiplier 100. A strike set by delta or % of forward is solved once and then held fixed, so scenarios move the market, not the strikes.'));

  const kpis = h('div', { class: 'vd-kpis' });
  const cardPos = card('Position', kpis, note('Desk Greeks: delta per +1% index move, gamma as the second-order P&L of a 1% move, vega per vol point, theta per calendar day at a fixed forward, vanna as the cross term of +1% and +1 vol point, volga as the second-order P&L of 1 vol point.'));

  const horizon = slider({ label: 'Horizon', min: 0, max: 30, step: 1, value: 0, fmt: (v) => `${v} days`, oninput: (v) => { S.horizon = v; drawCharts(); } });
  const payoffDiv = h('div');
  const cardPay = card('P&L vs index level', h('div', { class: 'vd-controls' }, horizon.el), payoffDiv);
  const greekSel = selectEl({ label: 'Greek', value: S.greek, options: GREEKS.map((g) => ({ value: g.key, label: g.label })), onchange: (v) => { S.greek = v; drawCharts(); } });
  const greekDiv = h('div');
  const cardGreek = card('Greeks vs index level', h('div', { class: 'vd-controls' }, field('Greek', greekSel)), greekDiv);
  el.append(builder, h('div', { class: 'vd-grid vd-g-pos' }, cardPos, cardPay), cardGreek);

  function legChanged(g, resolve) {
    if (resolve && g.mode !== 'K') {
      g.K = solveStrike(g.mode, g.target, g.cp, app.expiries[g.exp].T, app.market);
    }
    app.legsChanged(false);
    update();
  }

  function rebuildRows() {
    clear(tbody);
    refs.clear();
    const expOpts = app.expiries.map((e, i) => ({ value: String(i), label: `${e.expiry} (${num(e.T * 365, 0)}d)` }));
    S.legs.forEach((g, n) => {
      const L = `leg ${n + 1}`;
      const side = selectEl({ label: `Side, ${L}`, value: String(g.side), options: [{ value: '1', label: 'Buy' }, { value: '-1', label: 'Sell' }],
        onchange: (v) => { g.side = Number(v); legChanged(g, false); } });
      const qty = h('input', { type: 'number', min: 1, max: 1000, step: 1, value: String(g.qty), 'aria-label': `Quantity, ${L}`, class: 'vd-in-num' });
      qty.addEventListener('change', () => {
        const q = Math.round(Number(qty.value));
        if (!(q >= 1 && q <= 1000)) { qty.value = String(g.qty); return; }
        g.qty = q; legChanged(g, false);
      });
      const type = selectEl({ label: `Type, ${L}`, value: String(g.cp), options: [{ value: '1', label: 'Call' }, { value: '-1', label: 'Put' }],
        onchange: (v) => { g.cp = Number(v); legChanged(g, g.mode === 'delta'); } });
      const exp = selectEl({ label: `Expiry, ${L}`, value: String(g.exp), options: expOpts, onchange: (v) => { g.exp = Number(v); legChanged(g, g.mode !== 'K'); } });
      const target = h('input', { type: 'number', value: String(g.target), 'aria-label': `Strike input, ${L}`, class: 'vd-in-num' });
      const setStep = () => { target.step = g.mode === 'K' ? '1' : '0.5'; target.min = g.mode === 'K' ? '0' : '0.5'; target.max = g.mode === 'delta' ? '99.5' : g.mode === 'pct' ? '400' : ''; };
      setStep();
      const mode = selectEl({ label: `Strike by, ${L}`, value: g.mode, options: [{ value: 'K', label: 'Strike' }, { value: 'delta', label: '|Δ| %' }, { value: 'pct', label: '% of fwd' }],
        onchange: (v) => {
          const T = app.expiries[g.exp].T;
          const stt = legState(g, T, app.market);
          if (v === 'K') g.target = g.K;
          else if (v === 'pct') g.target = round1(g.K / app.market.forward(T) * 100);
          else g.target = round1(Math.abs(stt.fwdDelta ?? 0.5) * 100);
          g.mode = v;
          target.value = String(g.target);
          setStep();
          legChanged(g, false);
        } });
      target.addEventListener('change', () => {
        const t = Number(target.value);
        const ok = g.mode === 'K' ? t > 0 : g.mode === 'pct' ? t >= 1 && t <= 400 : t >= 0.5 && t <= 99.5;
        if (!ok) { target.value = String(g.target); return; }
        g.target = t;
        if (g.mode === 'K') g.K = t;
        legChanged(g, g.mode !== 'K');
      });
      const cells = { K: h('td', { class: 'vd-num' }), vol: h('td', { class: 'vd-num' }), price: h('td', { class: 'vd-num' }), delta: h('td', { class: 'vd-num' }), value: h('td', { class: 'vd-num' }) };
      const rm = h('button', { type: 'button', class: 'vd-btn vd-btn-icon', 'aria-label': `Remove ${L}`, title: 'Remove leg', onclick: () => {
        S.legs = S.legs.filter((x) => x !== g);
        app.legsChanged(true);
        rebuildRows();
        update();
      } }, '×');
      refs.set(g.id, { cells, target });
      tbody.append(h('tr', null, h('td', { class: 'l' }, side), h('td', { class: 'l' }, qty), h('td', { class: 'l' }, type), h('td', { class: 'l' }, exp),
        h('td', { class: 'l' }, mode), h('td', { class: 'l' }, target), cells.K, cells.vol, cells.price, cells.delta, cells.value, h('td', null, rm)));
    });
    if (!S.legs.length) tbody.append(h('tr', null, h('td', { colspan: 12, class: 'l vd-note' }, 'No legs. Pick a preset or add a leg.')));
    seenLegs = app.legsVersion;
  }

  function kpi(label, value, sub) {
    return h('div', { class: 'vd-kpi' }, h('div', { class: 'vd-kpi-label' }, label), h('div', { class: 'vd-kpi-value vd-num' }, value), sub ? h('div', { class: 'vd-kpi-sub' }, sub) : null);
  }

  function update() {
    const m0 = app.market;
    if (!m0) return;
    const pf = portfolio(S.legs, app.expiries, m0);
    pf.states.forEach((st, i) => {
      const g = S.legs[i], r = refs.get(g.id);
      if (!r) return;
      r.cells.K.textContent = num(g.K, g.K % 1 ? 2 : 0);
      r.cells.vol.textContent = st.expired ? '–' : vol(st.vol, 2);
      r.cells.price.textContent = num(st.value, 2);
      r.cells.delta.textContent = st.expired ? '–' : num(st.fwdDelta, 3);
      r.cells.value.textContent = money(st.q * st.value);
      if (document.activeElement !== r.target) r.target.value = String(g.target);
    });
    clear(kpis).append(
      kpi(pf.value >= 0 ? 'Net debit' : 'Net credit', money(Math.abs(pf.value)), 'model value of the position'),
      kpi('Delta', `${num(pf.delta, 2)} units`, `${money(pf.delta1)} per +1% index`),
      kpi('Gamma', money(pf.gamma1), 'P&L of a 1% move (2nd order)'),
      kpi('Vega', money(pf.vega1), 'per vol point'),
      kpi('Theta', money(pf.theta1), 'per calendar day'),
      kpi('Vanna', money(pf.vanna1), '+1% index and +1 vol point'),
      kpi('Volga', money(pf.volga1), '1 vol point, 2nd order'),
      kpi('Index', num(m0.spot, 2), `${app.state.und} on ${app.state.date}`));
    drawCharts();
  }

  function drawCharts() {
    const m0 = app.market, legs = S.legs, ex = app.expiries;
    if (!m0 || !legs.length) { clear(payoffDiv); clear(greekDiv); return; }
    const minT = Math.min(...legs.map((g) => ex[g.exp].T));
    const maxDays = Math.max(0, Math.floor(minT * 365 + 1e-9));
    horizon.setMax(maxDays);
    if (S.horizon == null || S.horizon > maxDays) S.horizon = Math.round(maxDays / 2);
    horizon.set(S.horizon);
    const sticky = app.scen.sticky;
    const S0 = m0.spot;
    const atm = m0.iv(m0.forward(minT), minT);
    const R = Math.max(0.08, Math.min(0.35, 4 * atm * Math.sqrt(minT)));
    const spots = linspace(S0 * (1 - R), S0 * (1 + R), 121);
    const val = (m) => legs.reduce((a, g) => { const st = legState(g, ex[g.exp].T, m); return a + st.q * st.value; }, 0);
    const v0 = val(m0);
    const mExp = m0.roll(minT), mH = m0.roll(S.horizon / 365);
    const curve = (m) => spots.map((x) => [x, val(m.move(Math.log(x / S0), sticky)) - v0]);
    const atExp = curve(mExp), today = curve(m0), atH = curve(mH);
    const be = [];
    for (let i = 1; i < atExp.length; i++) {
      const [x0, y0] = atExp[i - 1], [x1, y1] = atExp[i];
      if ((y0 < 0 && y1 >= 0) || (y0 >= 0 && y1 < 0)) be.push(x0 + (x1 - x0) * (0 - y0) / (y1 - y0 || 1));
    }
    const strikes = [...new Set(legs.map((g) => g.K))];
    const fmtS = (v) => num(v, S0 >= 1000 ? 0 : 1);
    const tipX = (v) => `Index ${fmtS(v)} (${v >= S0 ? '+' : '−'}${num(Math.abs(v / S0 - 1) * 100, 1)}%)`;
    const firstExp = ex[legs.find((g) => ex[g.exp].T === minT).exp].expiry;
    lineChart(payoffDiv, {
      height: 280,
      series: [
        { key: 'exp', name: `At first expiry (${firstExp})`, color: color('--ink'), width: 2, points: atExp },
        { key: 'today', name: 'Today', color: slotColor(0), width: 2, points: today },
        { key: 'h', name: `In ${S.horizon} days`, color: slotColor(1), width: 2, dash: '6 4', points: atH },
      ],
      hlines: [{ y: 0, strong: true }],
      vlines: [{ x: S0, label: 'index', strong: true, dash: '' }, ...strikes.map((k) => ({ x: k, dash: '2 3' })), ...be.map((b, i) => ({ x: b, label: `BE ${fmtS(b)}`, row: i + 1 }))],
      x: { label: `Index level (${sticky === 'moneyness' ? 'sticky moneyness' : 'sticky strike'} vols)`, fmt: fmtS },
      y: { label: 'P&L ($)', fmt: (v, tip) => (tip ? money(v) : compactMoney(v)) },
      tipX,
      aria: 'Strategy profit and loss against the index level at the first expiry, today and at the horizon',
      caption: 'P&L relative to today’s model value. Later-dated legs are revalued with the model surface at the first expiry; dashed verticals mark strikes, BE marks break-evens at the first expiry.',
    });
    const gk = S.greek, gi = GREEKS.find((x) => x.key === gk);
    const gcurve = (m) => spots.map((x) => [x, portfolio(legs, ex, m.move(Math.log(x / S0), sticky))[gk]]);
    lineChart(greekDiv, {
      height: 240,
      series: [
        { key: 'today', name: 'Today', color: slotColor(0), width: 2, points: gcurve(m0) },
        { key: 'h', name: `In ${S.horizon} days`, color: slotColor(1), width: 2, dash: '6 4', points: gcurve(mH) },
      ],
      hlines: [{ y: 0, strong: true }],
      vlines: [{ x: S0, label: 'index', strong: true, dash: '' }],
      x: { label: 'Index level', fmt: fmtS },
      y: { label: gi.short, fmt: (v, tip) => (gk === 'delta' ? num(v, 2) : tip ? money(v) : compactMoney(v)) },
      tipX,
      aria: `${gi.label} against the index level`,
    });
  }

  function render() {
    if (!app.bundle) return;
    if (seenData !== app.dataVersion) {
      clear(nearSel).append(...app.expiries.map((e, i) => h('option', { value: String(i) }, `${e.expiry} (${num(e.T * 365, 0)}d)`)));
      seenData = app.dataVersion;
    }
    nearSel.value = String(S.near);
    presetSel.value = S.preset;
    if (seenLegs !== app.legsVersion) rebuildRows();
    update();
  }

  return { el, render };
}

function compactMoney(v) {
  const a = Math.abs(v), sg = v < 0 ? '−' : '';
  if (a >= 1e6) return `${sg}$${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${sg}$${(a / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
  return `${sg}$${a.toFixed(0)}`;
}
