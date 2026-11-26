// Backtests tab: the repository's strategy library (data/backtests.json): cumulative P&L, statistics under three
// cost models, P&L attribution and trade statistics.
import { h, clear, card, selectEl, segmented, field, num, pct, money, sortableTable, note } from './ui.js';
import { lineChart, barChart, slotColor } from './charts.js';

const COSTS = [{ value: 'base', label: 'Base costs' }, { value: 'stress', label: 'Stress costs' }, { value: 'frictionless', label: 'Frictionless' }];
const ATTR = ['delta', 'gamma', 'vega', 'vanna', 'volga', 'theta', 'rates', 'residual', 'hedge', 'costs'];
const MAX_SEL = 8;

export function createBacktestsTab(app) {
  const el = h('div', { class: 'vd-tabbody' });
  const B = app.backtests;
  if (!B || !Array.isArray(B.strategies) || !B.strategies.length) {
    el.append(card('Backtests', note('Backtest results are not available in this build (data/backtests.json is missing).')));
    return { el, render() {} };
  }
  const strategies = B.strategies;
  const slots = new Map(); // name -> colour slot, kept while selected (colour follows the strategy)
  const defaults = ['short_straddle', 'long_put_10', 'short_straddle_dh', 'iron_condor_25_10'].filter((n) => strategies.some((s) => s.name === n));
  (defaults.length ? defaults : strategies.slice(0, 3).map((s) => s.name)).forEach((n, i) => slots.set(n, i));
  let cost = 'base';
  let attrName = strategies[0].name;
  const t = (B.dates || []).map((d) => Date.parse(d + 'T00:00:00Z'));

  const picker = h('div', { class: 'vd-picker' });
  const limitNote = h('p', { class: 'vd-note', 'aria-live': 'polite' });
  const chartDiv = h('div');
  const statsDiv = h('div');
  const costSeg = segmented({ label: 'Cost model', value: cost, options: COSTS, onchange: (v) => { cost = v; drawStats(); } });
  const attrSel = selectEl({ label: 'Strategy', value: attrName, options: strategies.map((s) => ({ value: s.name, label: s.name })), onchange: (v) => { attrName = v; drawAttr(); } });
  const attrDiv = h('div');
  const tradesDiv = h('div');
  el.append(
    h('p', { class: 'vd-caveat' }, 'Historical simulation with estimated transaction costs on SPX option data. It shows how each structure behaved, including its tail events; it is not evidence of a tradable edge, and past results do not predict future ones.'),
    card('Cumulative P&L', picker, limitNote, chartDiv),
    card('Statistics', h('div', { class: 'vd-controls' }, costSeg.el), statsDiv),
    h('div', { class: 'vd-grid vd-g-2' },
      card('P&L attribution (base costs)', h('div', { class: 'vd-controls' }, field('Strategy', attrSel)), attrDiv),
      card('Trades', tradesDiv)));

  function freeSlot() {
    const used = new Set(slots.values());
    for (let i = 0; i < MAX_SEL; i++) if (!used.has(i)) return i;
    return -1;
  }

  function drawPicker() {
    clear(picker);
    const groups = [...new Set(strategies.map((s) => s.group || 'Other'))];
    for (const g of groups) {
      const box = h('fieldset', { class: 'vd-group' }, h('legend', null, g));
      for (const s of strategies.filter((x) => (x.group || 'Other') === g)) {
        const id = `vd-bt-${s.name}`;
        const on = slots.has(s.name);
        const cb = h('input', { type: 'checkbox', id, checked: on });
        cb.addEventListener('change', () => {
          if (cb.checked) {
            const sl = freeSlot();
            if (sl < 0) { cb.checked = false; limitNote.textContent = `At most ${MAX_SEL} strategies at once; clear one first.`; return; }
            slots.set(s.name, sl);
          } else slots.delete(s.name);
          limitNote.textContent = '';
          drawPicker();
          drawChart();
          drawStats();
        });
        box.append(h('div', { class: 'vd-check', title: s.description || '' }, cb,
          on ? h('span', { class: 'vd-swatch', style: { background: slotColor(slots.get(s.name)), borderColor: slotColor(slots.get(s.name)) } }) : null,
          h('label', { for: id }, s.name)));
      }
      picker.append(box);
    }
  }

  function drawChart() {
    const sel = strategies.filter((s) => slots.has(s.name));
    lineChart(chartDiv, {
      height: 300,
      series: sel.map((s) => ({ key: s.name, name: s.name, color: slotColor(slots.get(s.name)), width: 1.6, points: t.map((x, i) => [x, s.weekly?.[i]]) })),
      hlines: [{ y: 0, strong: true }],
      x: { type: 'time', fmt: (v) => new Date(v).toISOString().slice(0, 10) },
      y: { label: 'Cumulative P&L per $1 notional', fmt: (v) => num(v, 2) },
      tipX: (v) => `Week of ${new Date(v).toISOString().slice(0, 10)}`,
      toggle: false, forceLegend: sel.length > 0,
      aria: 'Cumulative P&L of the selected backtested strategies',
      caption: `${B.units || 'Cumulative P&L per $1 of notional'}; weekly points, ${B.dates?.[0] ?? ''} to ${B.dates?.[B.dates.length - 1] ?? ''}.`,
    });
  }

  function drawStats() {
    const rows = strategies.map((s) => {
      const st = s.stats?.[cost] || {};
      return { name: s.name, group: s.group || '', hedge: s.hedge || '', ret: st.ann_return_notional, vol: st.ann_vol_notional, sharpe: st.sharpe,
        dd: st.max_drawdown_notional, worst: st.worst_day_notional, skew: st.skew_daily, sel: slots.has(s.name) };
    });
    clear(statsDiv).append(sortableTable({
      caption: `Strategy statistics, ${cost} costs`, rows, sortKey: 'sharpe', sortDir: -1,
      rowClass: (r) => (r.sel ? 'vd-row-sel' : null),
      columns: [
        { key: 'name', label: 'Strategy', align: 'left' },
        { key: 'group', label: 'Group', align: 'left' },
        { key: 'hedge', label: 'Hedge', align: 'left' },
        { key: 'ret', label: 'Ann. return', title: 'Per $1 of underlying notional', fmt: (v) => pct(v, 2), defaultDir: -1 },
        { key: 'vol', label: 'Ann. vol', fmt: (v) => pct(v, 2), defaultDir: -1 },
        { key: 'sharpe', label: 'Sharpe', fmt: (v) => num(v, 2), defaultDir: -1 },
        { key: 'dd', label: 'Max drawdown', fmt: (v) => pct(v, 1) },
        { key: 'worst', label: 'Worst day', fmt: (v) => pct(v, 2) },
        { key: 'skew', label: 'Daily skew', fmt: (v) => num(v, 2) },
      ],
    }), note('Returns, volatility and drawdowns per $1 of underlying notional. Base and stress use the repository’s estimated bid-ask and hedging costs; frictionless removes them.'));
  }

  function drawAttr() {
    const s = strategies.find((x) => x.name === attrName);
    const A = s?.attribution || {};
    barChart(attrDiv, {
      items: ATTR.filter((k) => k in A).map((k) => ({ label: k, value: A[k] })),
      fmt: (v) => money(v, 0),
      aria: `P&L attribution for ${attrName}`,
      caption: `${s?.description || ''} Totals in dollars over the backtest (base costs), split by Greek; hedge = the delta hedge, costs = estimated transaction costs.`,
    });
    const T = s?.trades || {};
    clear(tradesDiv).append(h('dl', { class: 'vd-dl' },
      h('dt', null, 'Trades'), h('dd', { class: 'vd-num' }, num(T.n_trades, 0)),
      h('dt', null, 'Win rate'), h('dd', { class: 'vd-num' }, pct(T.win_rate, 1)),
      h('dt', null, 'Median margin'), h('dd', { class: 'vd-num' }, money(T.median_margin, 0)),
      h('dt', null, 'Average return on margin'), h('dd', { class: 'vd-num' }, pct(T.avg_return_on_margin, 1)),
      h('dt', null, 'Worst trade on margin'), h('dd', { class: 'vd-num' }, pct(T.worst_trade_on_margin, 1)),
      h('dt', null, 'Costs / gross P&L'), h('dd', { class: 'vd-num' }, num(T.cost_share_of_gross, 2))),
    note(`Per-trade statistics for ${attrName} (base costs).`));
  }

  let drawn = false;
  function render() {
    if (drawn) { drawChart(); return; }
    drawn = true;
    drawPicker();
    drawChart();
    drawStats();
    drawAttr();
  }
  return { el, render };
}
