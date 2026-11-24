// Equity tab: hands or ranges, one or two boards, exact or Monte Carlo, run-it-twice statistics.
import { $, escapeHtml } from '../app.js';
import { barChart } from './charts.js';

let engine;
const DEFAULTS = {
  hands: { NLH: ['AhKh', 'QsQd', 'JcTc'], PLO: ['AhAdKhQd', 'JsTs9c8c'], PLO5: ['AhAdKhQdJc', 'JsTs9c8c7d'], SD: ['AhKh', 'JsJd'], O8: ['As2sKdKc', 'QhQdJhJd'], BIGO: ['As2sKdKc3h', 'QhQdJhJd9c'] },
  ranges: { NLH: ['TT+,AQs+,AKo', 'random'], PLO: ['AAxx', 'KKQQ,JT98'], PLO5: ['AAxxx', 'random'], SD: ['JJ+,AK', 'random'], O8: ['A2xx', 'random'], BIGO: ['A2xxx', 'random'] },
};
const COLORS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)', 'var(--a-fold)'];

function setEntries(list) {
  $('#eq-entries').innerHTML = list.map((v, i) => `<label>Player ${i + 1} <input class="eq-entry" value="${escapeHtml(v)}" spellcheck="false"></label>`).join('');
}
function entries() { return [...document.querySelectorAll('.eq-entry')].map((e) => e.value.trim()).filter(Boolean); }

async function compute() {
  const mode = $('#eq-mode').value;
  const list = entries();
  if (list.length < 2) { $('#eq-status').textContent = 'Give at least two players.'; return; }
  $('#eq-go').disabled = true; $('#eq-status').className = 'status'; $('#eq-status').textContent = 'Computing…';
  try {
    const r = await engine.run('equity', { game: $('#eq-game').value, mode, entries: list, boards: [$('#eq-board').value, $('#eq-board2').value], dead: $('#eq-dead').value.trim(), samples: mode === 'ranges' ? 60000 : 150000 }, ['equity']);
    const res = r.result;
    $('#eq-label').textContent = res.exact ? 'exact enumeration' : 'Monte Carlo';
    $('#eq-label').className = res.exact ? 'label-chip' : 'label-chip approx';
    barChart($('#eq-chart'), res.equity.map((e, i) => ({
      label: list[i].length > 16 ? `Player ${i + 1}` : list[i], value: 100 * e, color: COLORS[i % COLORS.length],
      lo: res.exact ? undefined : 100 * (e - 1.96 * res.stdError[i]), hi: res.exact ? undefined : 100 * (e + 1.96 * res.stdError[i]),
      note: res.exact ? `${(100 * e).toFixed(2)}%` : `${(100 * e).toFixed(2)}% ± ${(196 * res.stdError[i]).toFixed(2)}`,
    })), { max: 100, labelWidth: 150 });
    $('#eq-meta').textContent = res.exact ? `${res.runouts.toLocaleString()} runouts enumerated in ${r.seconds.toFixed(2)} s.` : `${res.runouts.toLocaleString()} sampled deals in ${r.seconds.toFixed(2)} s; bars show 95% intervals.${res.possibleRunouts ? ` Exact would need ${res.possibleRunouts.toLocaleString()} runouts.` : ''}`;
    const card = $('#rit-card');
    if (r.rit) {
      card.hidden = false;
      const x = r.rit;
      $('#rit-body').innerHTML = `<div class="table-wrap"><table><thead><tr><th>Player</th><th class="num">Equity</th><th class="num">SD, once</th><th class="num">SD, twice</th><th class="num">Correlation of runs</th></tr></thead><tbody>${x.equity.map((e, i) => `<tr><td>${escapeHtml(list[i])}</td><td class="num">${(100 * e).toFixed(2)}%</td><td class="num">${(100 * x.sdOnce[i]).toFixed(1)}%</td><td class="num">${(100 * x.sdTwice[i]).toFixed(1)}%</td><td class="num">${x.corrRuns[i].toFixed(3)}</td></tr>`).join('')}</tbody></table></div>
        <p class="note">Running it twice leaves the expected share unchanged (each run is marginally a fair runout) and cuts the spread of the result. The two runs are negatively correlated because the second is dealt from what the first left behind, so the variance falls by more than half. Computed exactly over all ${x.runouts.toLocaleString()} first runs and every disjoint second run.</p>`;
    } else card.hidden = true;
    $('#eq-status').textContent = '';
  } catch (e) { $('#eq-status').textContent = e.message; $('#eq-status').className = 'status err'; }
  finally { $('#eq-go').disabled = false; }
}

export function initEquity(eng) {
  engine = eng;
  const reset = () => { setEntries(DEFAULTS[$('#eq-mode').value][$('#eq-game').value]); };
  $('#eq-game').addEventListener('change', () => { reset(); $('#eq-board').value = ''; $('#eq-board2').value = ''; });
  $('#eq-mode').addEventListener('change', reset);
  $('#eq-add').addEventListener('click', () => { const l = entries(); if (l.length < 6) setEntries([...l, '']); });
  $('#eq-remove').addEventListener('click', () => { const l = [...document.querySelectorAll('.eq-entry')].map((e) => e.value); if (l.length > 2) setEntries(l.slice(0, -1)); });
  $('#eq-go').addEventListener('click', compute);
  setEntries(DEFAULTS.hands.NLH);
  $('#eq-board').value = 'Th7h2c';
  compute();
}
