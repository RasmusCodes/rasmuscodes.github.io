// Models tab: panel-wide comparison of the five surface models (data/models.json).
import { h, clear, card, num, pct, simpleTable, note } from './ui.js';
import { lineChart, groupedBars, modelColor } from './charts.js';
import { MODEL_KEYS, MODEL_LABELS } from './models.js';

const BUCKETS = [['<=30d', '≤ 30 days'], ['31-91d', '31–91 days'], ['92-365d', '92–365 days'], ['>1y', '> 1 year']];

export function createModelsTab(app) {
  const el = h('div', { class: 'vd-tabbody' });
  const sumDiv = h('div'), bucketDiv = h('div'), seriesDiv = h('div');
  const logBox = h('input', { type: 'checkbox', id: 'vd-rmse-log' });
  logBox.checked = true;
  logBox.addEventListener('change', () => drawSeries());
  el.append(
    card('Closer fit or guaranteed absence of arbitrage?',
      h('p', { class: 'vd-prose' }, 'The five models trade fit against structure. Raw SVI and SABR fit each expiry separately with five or three free parameters, so they track the quoted smiles most closely, but nothing forces neighbouring expiries to be consistent: their extrapolated wings can cross (calendar arbitrage) or imply a negative density (butterfly arbitrage), and their local variance is not always usable. eSSVI and SSVI are built so that static arbitrage is impossible by construction, eSSVI with three parameters per expiry and SSVI with three for the whole surface plus the ATM curve; the price is a looser fit, most visibly for short expiries. Heston prices the whole surface from five dynamic parameters, which makes it consistent across expiries but too rigid for the steep short-dated skew. A desk that marks books or hedges off a surface usually prefers the arbitrage-free fit where the errors stay inside the bid-ask spread.'),
      sumDiv),
    h('div', { class: 'vd-grid vd-g-2' },
      card('Median RMSE by maturity bucket', bucketDiv),
      card('Fit error through time', h('div', { class: 'vd-controls' }, h('div', { class: 'vd-check' }, logBox, h('label', { for: 'vd-rmse-log' }, 'Log scale'))), seriesDiv)));

  const data = () => app.models;
  const keys = () => MODEL_KEYS.filter((k) => data()?.summary?.[k]);

  function drawSummary() {
    const S = data().summary;
    const rows = keys().map((k) => [MODEL_LABELS[k], num(S[k].rmse_median, 2), pct(S[k].inside_median, 0), num(S[k].seconds_median, 2),
      pct(S[k].butterfly_viol_extrap, 2), pct(S[k].calendar_viol_extrap, 2), pct(S[k].localvar_valid, 1)]);
    clear(sumDiv).append(simpleTable(['Model', 'Median RMSE (vol pts)', 'Median inside bid-ask', 'Median fit time (s)', 'Butterfly violations (extrap.)', 'Calendar violations (extrap.)', 'Local variance valid'],
      rows, { caption: 'Model comparison summary' }),
    note(`Medians over ${data().n_dates ?? '?'} month-end SPX dates. RMSE is model minus mid implied vol; violation shares are measured on a grid that extends beyond the quotes.`));
  }

  function drawBuckets() {
    const B = data().by_bucket || {};
    groupedBars(bucketDiv, {
      groups: BUCKETS.map((b) => b[1]),
      series: keys().map((k) => ({ name: MODEL_LABELS[k], color: modelColor(k), values: BUCKETS.map((b) => B[b[0]]?.[k]) })),
      fmt: (v) => num(v, 2), yLabel: 'Median RMSE (vol pts)', height: 250,
      aria: 'Median RMSE by maturity bucket and model',
    });
  }

  function drawSeries() {
    const R = data().rmse_series;
    if (!R?.dates) { clear(seriesDiv); return; }
    const t = R.dates.map((d) => Date.parse(d + 'T00:00:00Z'));
    let gapTxt = '';
    for (let i = 1; i < t.length; i++) if (t[i] - t[i - 1] > 120 * 86400e3) gapTxt += ` No dates between ${R.dates[i - 1]} and ${R.dates[i]}.`;
    lineChart(seriesDiv, {
      height: 260,
      series: keys().filter((k) => Array.isArray(R[k])).map((k) => ({ key: k, name: MODEL_LABELS[k], color: modelColor(k), width: 1.5, points: t.map((x, i) => [x, R[k][i]]) })),
      x: { type: 'time', gap: 120 * 86400e3, fmt: (v) => new Date(v).toISOString().slice(0, 10) },
      y: { label: 'RMSE (vol pts)', log: logBox.checked, fmt: (v) => num(v, v < 1 ? 2 : 1) },
      tipX: (v) => new Date(v).toISOString().slice(0, 10),
      aria: 'Surface fit RMSE through time by model',
      caption: `One point per date in the panel (${R.dates[0]} to ${R.dates[R.dates.length - 1]}).${gapTxt} Click a legend entry to hide a model.`,
    });
  }

  function render() {
    if (!data()?.summary) { clear(sumDiv).append(note('Model comparison data (data/models.json) is not available.')); return; }
    drawSummary();
    drawBuckets();
    drawSeries();
  }
  return { el, render };
}
