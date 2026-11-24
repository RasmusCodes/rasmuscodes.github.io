// Opponents tab: posterior estimates for a simulated population, a Bayesian updater,
// and a hand-off of a player's river tendencies to the solver's opponent model.
import { $, escapeHtml, goTo } from '../app.js';
import { intervalChart, densityChart } from './charts.js';
import { posterior, betaDensity } from '../engine/bayes.js';
import { solverState } from './solver-tab.js';

let data = null, chosen = null;
const COLS = ['vpip', 'pfr', 'three_bet', 'cbet_flop', 'fold_vs_cbet_flop', 'wtsd', 'fold_vs_bet_river'];
const p = (x) => (x === null || x === undefined ? '–' : `${(100 * x).toFixed(0)}`);

function renderTable() {
  const label = Object.fromEntries(data.stats.map((s) => [s.key, s.label]));
  $('#opp-table').innerHTML = `<thead><tr><th>Player</th><th>Inferred type</th><th>True style</th><th class="num">Hands</th>${COLS.map((c) => `<th class="num">${escapeHtml(label[c])}</th>`).join('')}</tr></thead><tbody>` +
    data.players.map((pl, i) => `<tr class="clickable${chosen === i ? ' active' : ''}" data-i="${i}"><td>${escapeHtml(pl.name)}</td><td>${escapeHtml(pl.cluster || '')}</td><td class="muted">${escapeHtml((pl.style || '').replace('_', '-'))}</td><td class="num">${pl.hands.toLocaleString()}</td>${COLS.map((c) => {
      const e = pl.estimates[c];
      return `<td class="num" title="90% interval ${p(e.lo)}-${p(e.hi)}%, n = ${e.n}">${p(e.mean)}%</td>`;
    }).join('')}</tr>`).join('') + '</tbody>';
  for (const tr of document.querySelectorAll('#opp-table tr[data-i]')) tr.addEventListener('click', () => choose(+tr.dataset.i));
}

function choose(i) {
  chosen = i;
  const pl = data.players[i];
  renderTable();
  $('#opp-title').textContent = `${pl.name}: posterior frequencies (90% intervals)`;
  intervalChart($('#opp-chart'), data.stats.map((s) => {
    const e = pl.estimates[s.key];
    return { label: `${s.label} (n=${e.n})`, lo: e.lo, hi: e.hi, mean: e.mean, prior: e.prior_mean, truth: e.truth };
  }));
  $('#opp-chart').insertAdjacentHTML('beforeend', '<p class="small muted">Bar: 90% credible interval; dot: posterior mean; dashed tick: population prior mean; ◆: the bot\'s true frequency.</p>');
  $('#opp-exploit').disabled = false;
}

function updater() {
  const key = $('#bu-stat').value, prior = data.population[key];
  const k = Math.max(0, +$('#bu-k').value || 0), n = Math.max(k, +$('#bu-n').value || 0);
  const post = posterior(k, n, { a: prior.a, b: prior.b }, 0.9);
  densityChart($('#bu-chart'), betaDensity(post.a, post.b), post.lo, post.hi, { prior: prior.mean });
  $('#bu-text').innerHTML = `Prior from the population: Beta(${prior.a.toFixed(1)}, ${prior.b.toFixed(1)}), mean ${(100 * prior.mean).toFixed(1)}%. After ${k} of ${n}: posterior mean <b>${(100 * post.mean).toFixed(1)}%</b>, 90% interval ${(100 * post.lo).toFixed(1)}-${(100 * post.hi).toFixed(1)}%. The raw rate would be ${n ? (100 * k / n).toFixed(1) + '%' : 'undefined'}; with few observations the estimate leans on the population.`;
}

export async function initOpponents() {
  try {
    data = await (await fetch('data/opponents.json')).json();
  } catch (e) { $('#opp-source').textContent = 'could not load data/opponents.json'; return; }
  $('#opp-source').textContent = data.source;
  renderTable();
  $('#bu-stat').innerHTML = data.stats.map((s) => `<option value="${s.key}">${escapeHtml(s.label)}</option>`).join('');
  $('#bu-stat').value = 'fold_vs_bet_river';
  for (const id of ['#bu-stat', '#bu-k', '#bu-n']) $(id).addEventListener('input', updater);
  updater();
  choose(0);
  $('#opp-exploit').addEventListener('click', () => {
    const ex = data.players[chosen].exploit;
    goTo('solver');
    solverState.setProfile({ mp: 1, fold_to_bet: ex.fold_to_bet.mean, raise_vs_bet: ex.raise_freq.mean, bet_when_checked_to: ex.bet_freq.mean, bluff_share: ex.bluff_share.mean });
    const status = document.querySelector('#exploit-status');
    if (status) status.textContent = `Loaded ${data.players[chosen].name}'s river posteriors (fold to bet ${p(ex.fold_to_bet.mean)}%, raise ${p(ex.raise_freq.mean)}%, bet when checked to ${p(ex.bet_freq.mean)}%, bluffs ${p(ex.bluff_share.mean)}%) as the in-position player. Press "Compare GTO and exploit".`;
  });
}
