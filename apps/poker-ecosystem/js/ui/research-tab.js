// Research tab: benchmark results from research/results (via web/data/research.json).
import { $, escapeHtml } from '../app.js';
import { lineChart, barChart } from './charts.js';

const COLORS = { CFR: 'var(--a-fold)', 'CFR+': 'var(--series-3)', LCFR: 'var(--series-4)', DCFR: 'var(--series-1)', 'PCFR+': 'var(--series-5)', 'ES-MCCFR': 'var(--series-2)', 'OS-MCCFR(eps=0.6)': 'var(--a-bet2)' };
const REPO = 'https://github.com/RasmusCodes/poker-ecosystem/blob/main/';
const sci = (v) => (v >= 1 ? v.toFixed(0) : v >= 0.01 ? String(+v.toPrecision(2)) : v.toExponential(0));
const card = (title, body, note = '', link = '') => `<div class="card stack"><h2>${title}</h2>${body}${note ? `<p class="note">${note}</p>` : ''}${link ? `<p class="small"><a href="${REPO}${link}">Full report on GitHub</a></p>` : ''}</div>`;
const table = (head, rows) => `<div class="table-wrap"><table><thead><tr>${head.map((h, i) => `<th${i ? ' class="num"' : ''}>${h}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${i ? ' class="num"' : ''}>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;

export async function initResearch() {
  const root = $('#research');
  let d;
  try { d = await (await fetch('data/research.json')).json(); } catch (e) { root.innerHTML = '<p>Could not load research data.</p>'; return; }
  const parts = [];
  if (d.analytic) {
    const a = d.analytic;
    parts.push(card('Known answers', table(['Benchmark', 'Known', 'Computed', 'Error'], [
      ['Kuhn poker, value for the first player (DCFR)', (-1 / 18).toFixed(6), a.kuhn.computed.toFixed(6), a.kuhn.error.toExponential(1)],
      ['Leduc hold\'em, value for the first player', a.leduc.published, a.leduc.computed.toFixed(5), `exploitability ${a.leduc.exploitability.toExponential(1)}`],
      ...a.clairvoyance.map((c) => [`Clairvoyance river, bet ${c.bet}× pot: bluff / call frequency`, `${c.closed.bluff_freq.toFixed(4)} / ${c.closed.call_freq.toFixed(4)}`, `${c.final.bluff_freq.toFixed(4)} / ${c.final.call_freq.toFixed(4)}`, `${Math.max(c.final.bluff_error, c.final.call_error).toExponential(1)}`]),
    ]), 'The clairvoyance river is solved as a real card game (quads or air against bluff-catchers on 2-2-2-7-7) by the range solver, and matches the closed-form equilibrium.', 'research/reports/validation.md'));
  }
  if (d.cfr && d.cfr['leduc-2p']) {
    const L = d.cfr['leduc-2p'];
    const full = ['CFR', 'CFR+', 'LCFR', 'DCFR', 'PCFR+'].filter((m) => L[m]);
    parts.push(card('The CFR family on Leduc hold\'em', '<div id="r-cfr"></div><div id="r-cfr-nodes"></div>',
      'Exploitability (chips per hand) of the average strategy. Top: by iteration. Bottom: by nodes touched, which puts Monte Carlo CFR (one sampled trajectory or one opponent action per update) on the same footing. Floored regrets, discounting and prediction (CFR+, DCFR, PCFR+) beat vanilla CFR by one to two and a half orders of magnitude at equal iterations.', 'research/reports/cfr-algorithms.md'));
    requestAnimationFrame(() => {
      lineChart($('#r-cfr'), full.map((m) => ({ name: m, points: L[m].iterations.filter((p) => p[1] > 0), color: COLORS[m] })), { logX: true, logY: true, xLabel: 'iterations', yLabel: 'exploitability', yFormat: sci, height: 240 });
      lineChart($('#r-cfr-nodes'), Object.keys(L).map((m) => ({ name: m.replace('(eps=0.6)', ''), points: L[m].nodes.filter((p) => p[1] > 0 && p[0] > 0), color: COLORS[m] })), { logX: true, logY: true, xLabel: 'nodes touched', yLabel: 'exploitability', yFormat: sci, xFormat: sci, height: 240 });
    });
  }
  if (d.river) {
    const rows = d.river.map((r) => [escapeHtml(r.spot), r.algorithm, `${r.hands[0]} / ${r.hands[1]}`, r.iterations_to['0.5'] ?? '>2000', r.iterations_to['0.1'] ?? '>2000', r.final_pct_pot.toFixed(3), r.cpu_seconds.toFixed(1), (r.memory_bytes / 1e6).toFixed(1)]);
    parts.push(card('River solving in the Rust engine', table(['Spot', 'Algorithm', 'Hands', 'Iter. to 0.5%', 'Iter. to 0.1%', 'Final % pot', 'CPU s', 'MB'], rows),
      'Exploitability is checked every 50 iterations (so iteration counts are multiples of 50) and measured exactly by a vector best response. CPU seconds on a shared laptop with 4 threads. The PLO spot holds 32,352 and 41,844 four-card hands.', 'research/reports/solver-benchmarks.md'));
  }
  if (d.abstraction) {
    const ab = d.abstraction;
    parts.push(card('Sensitivity to abstraction', '<div id="r-buckets"></div>' + table(['Bet menu', 'EV out of position', 'EV in position', 'Exploitability % pot', 'Decision nodes'], ab.menus.map((m) => [escapeHtml(m.menu), m.ev[0].toFixed(3), m.ev[1].toFixed(3), m.pct_pot.toFixed(3), m.decision_nodes])),
      `Card abstraction: river hands grouped into equal-weight strength buckets that share a strategy, solved, then measured in the real game. Exploitability falls from ${ab.buckets[0].pct_pot.toFixed(1)}% of the pot with ${ab.buckets[0].buckets} buckets to ${ab.buckets[ab.buckets.length - 2].pct_pot.toFixed(2)}% with ${ab.buckets[ab.buckets.length - 2].buckets}; the exact solve reaches ${ab.buckets[ab.buckets.length - 1].pct_pot.toFixed(3)}%. Bet-size abstraction: the same spot with richer menus moves each player's value by at most a few hundredths of a big blind here. In Leduc, merging jacks with queens leaves the "solved" strategy ${ab.leduc.merged[ab.leduc.merged.length - 1][1].toFixed(2)} chips per hand exploitable in the real game.`, 'research/reports/abstraction.md'));
    requestAnimationFrame(() => lineChart($('#r-buckets'), [{ name: 'bucketed', points: ab.buckets.filter((b) => b.buckets).map((b) => [b.buckets, b.pct_pot]) }], { logX: true, logY: true, xLabel: 'strength buckets per river node', yLabel: '% of pot', yFormat: sci, height: 210 }));
  }
  if (d.players || d.multiway) {
    const pl = (d.players || []).map((r) => [r.game, r.method, r.infosets.toLocaleString(), r.nodes.toLocaleString(), r.cpu_per_iteration ? `${(1000 * r.cpu_per_iteration).toFixed(2)} ms` : '–', `${r.curve[r.curve.length - 1][0].toLocaleString()} it: ${r.curve[r.curve.length - 1][1].toExponential(1)}`]);
    const mw = (d.multiway || []).map((r) => [`${r.players} players`, r.tuples.toLocaleString(), `${(1000 * r.cpu_seconds_per_iteration).toFixed(1)} ms`, `${r.curve[0][1].toFixed(1)}% → ${r.final.nash_conv_pct_pot.toFixed(3)}%`, (r.memory_bytes / 1e3).toFixed(0) + ' kB']);
    parts.push(card('Performance as the player count grows', table(['Game', 'Method', 'Information sets', 'Tree nodes', 'CPU / iteration', 'NashConv at the end'], pl) + '<h3>Multiway river, about 17 combos per player</h3>' + table(['Table', 'Joint hand combinations', 'CPU / iteration', 'NashConv (% of pot)', 'Memory'], mw),
      'Two players: NashConv / 2 is the exploitability and CFR provably drives it to zero. Three or more: CFR still runs and NashConv is still computed exactly, but no theorem says it falls, and a small NashConv only certifies an approximate equilibrium of this abstracted game, one of possibly many. Cost grows with the product of the range sizes: the joint hand combinations grow about twelvefold per added player here, and the time per iteration faster still.', 'research/reports/multiplayer.md'));
  }
  if (d.exploit) {
    const ex = d.exploit;
    parts.push(card('Exploitation versus safety (restricted Nash responses)', '<div id="r-frontier"></div>',
      'Each line is one opponent model on the single-raised-pot river. Moving along a line raises p, the weight on the model: the gain against the model grows, and so does what a perfect opponent could win back. p = 0 is the equilibrium; p = 1 the best response.', 'research/reports/exploitation.md'));
    requestAnimationFrame(() => lineChart($('#r-frontier'), ex.profiles.map((p, i) => ({
      name: p.profile.length > 34 ? p.profile.slice(0, 33) + '…' : p.profile,
      points: p.frontier.map((f) => [Math.max(f.exploitability_of_exploiter_pct_pot, 0.01), (100 * (f.ev_vs_model - p.frontier[0].ev_vs_model)) / 6.0]),
      color: ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)'][i],
    })), { logX: true, xLabel: 'exploitability of the exploiting strategy (% of pot, log scale)', yLabel: 'gain vs model (% of pot)', xFormat: sci, height: 260 }));
  }
  if (d.equity) {
    const q = d.equity;
    parts.push(card('Equity accuracy', table(['Monte Carlo samples', 'Mean absolute error', 'RMSE', '95% interval coverage', 'Runs'], q.mc.rows.map((r) => [r.samples.toLocaleString(), (100 * r.mean_abs_error).toFixed(3) + ' pp', (100 * r.rmse).toFixed(3) + ' pp', (100 * r.ci95_coverage).toFixed(0) + '%', r.repetitions])) +
      table(['Exact enumeration', 'Runouts', 'CPU s'], q.exact.map((r) => [escapeHtml(r.case), r.runouts.toLocaleString(), r.cpu_seconds.toFixed(2)])) +
      table(['Run it twice (exact)', 'Equity', 'SD once', 'SD twice', 'Correlation'], q.rit.map((r) => [escapeHtml(r.case), (100 * r.equity[0]).toFixed(2) + '%', (100 * r.sd_once[0]).toFixed(1) + '%', (100 * r.sd_twice[0]).toFixed(1) + '%', r.corr_runs[0].toFixed(3)])),
      `Monte Carlo against the exact answer for ${escapeHtml(q.mc.case)} (${(100 * q.mc.exact_equity).toFixed(3)}%): the error shrinks like one over the square root of the samples and the reported 95% intervals cover the truth at about the nominal rate. Running it twice never changes equity; the negative correlation between runs comes from card removal.`, 'research/reports/equity.md'));
  }
  if (d.opponent) {
    const o = d.opponent;
    parts.push(card('Opponent model on simulated players', '<div id="r-opp"></div>' + table(['Hands per player', 'Posterior MAE', 'Raw-frequency MAE', '90% coverage', 'Style recovery (ARI, mixture)'], o.sizes.map((s) => [s.hands.toLocaleString(), s.mae.toFixed(3), s.raw_mae.toFixed(3), (100 * s.coverage).toFixed(0) + '%', s.gmm_ari === null || s.gmm_ari === undefined ? '–' : s.gmm_ari.toFixed(2)])),
      'Bots with known styles play a simulated 6-max game; every decision records the probabilities the bot used, so each true frequency is known exactly. The hierarchical model\'s error is about half that of raw frequencies at every sample size, and its 90% intervals contain the truth close to 90% of the time. The corpus is synthetic: real players are not this stationary.', 'research/reports/opponent-model.md'));
    requestAnimationFrame(() => lineChart($('#r-opp'), [
      { name: 'posterior', points: o.sizes.map((s) => [s.hands, s.mae]), color: 'var(--series-1)' },
      { name: 'raw frequency', points: o.sizes.map((s) => [s.hands, s.raw_mae]), color: 'var(--series-2)' },
    ], { logX: true, xLabel: 'hands per player', yLabel: 'mean absolute error', yFormat: (v) => v.toFixed(2), height: 220 }));
  }
  if (d.ranges) {
    const g = d.ranges;
    const pct = (x) => `${(100 * x).toFixed(0)}%`;
    const row = (label, m) => [label, m.n.toLocaleString(), m.mean_bits.toFixed(2), pct(m.coverage_50), pct(m.coverage_80), pct(m.coverage_90), pct(m.mean_effective_share)];
    const snaps = g.held_out.by_snapshot.map((s) => row(`start of the ${s.snapshot}`.replace('start of the end', 'end of the hand'), s.metrics));
    const abl = g.ablations;
    parts.push(card('Street-by-street ranges on simulated hands', '<div id="r-ranges"></div>' + table(['Held-out snapshot', 'Players', 'Bits about the hand', '50% region', '80% region', '90% region', 'Range kept'], [
      ...snaps, row('all, with population frequencies only', abl.population_frequencies_only.all), row('all, without noise', abl.no_noise.all),
    ]), `Every player's hidden hand is known in the simulated corpus, so the reconstructed ranges can be scored. Bits: log2 of how much more likely the true hand is under the range than under a uniform one (0 = no information). Regions: how often the true hand lies inside the 50%, 80% and 90% most likely part of the range (calibrated when equal to the level). The noise level (${g.chosen_noise}) is the share of actions treated as carrying no information about the cards; it was fitted on ${(g.corpus.evaluated_hands / 2).toFixed(0)} hands and scored on the other half. Without it the model is badly over-confident.`, 'research/reports/hand-histories.md'));
    requestAnimationFrame(() => lineChart($('#r-ranges'), [
      { name: 'mean bits about the true hand', points: g.grid.map((x) => [x.noise, x.tuning_half.mean_bits]), color: 'var(--series-1)' },
    ], { xLabel: 'noise (share of uninformative actions)', yLabel: 'bits', yFormat: (v) => v.toFixed(1), height: 200 }));
  }
  if (d.review) {
    const rv = d.review;
    const p0 = (x) => `${(100 * x).toFixed(0)}%`;
    const styles = rv.by_style.filter((s) => s.style).map(({ style, stats: s }) => [escapeHtml(style.replace('_', '-')), s.decisions.n.toLocaleString(), p0(s.share_on_path), s.on_path.mean_loss_bb.toFixed(2), s.on_path.median_loss_bb.toFixed(2), p0(s.on_path.share_over_1bb), p0(s.share_rarely_played), s.decisions.mean_loss_bb.toFixed(2)]);
    parts.push(card('River review of simulated players', table(['Style', 'Decisions', 'On the eq. path', 'Mean cost on path (bb)', 'Median', 'Cost > 1 bb', 'Rarely played at eq.', 'Mean cost, all (bb)'], styles),
      `${rv.reviewed_hands.toLocaleString()} heads-up rivers from ${rv.hands.toLocaleString()} simulated hands, each solved to ${rv.mean_exploitability_pct.toFixed(2)}% of the pot on average. Cost: the value of the best action minus the value of the action taken, against an opponent playing the equilibrium of the river with the reconstructed ranges. On the path: the equilibrium reaches the decision with the hand's own line at least 5% of the time and with the opponent's range at least 2%; elsewhere the solver explores little and its values are rough. "Rarely played": on-path decisions the equilibrium takes less than 5% of the time. These are costs in a model, not the bots' true losses.`, 'research/reports/hand-histories.md'));
  }
  if (d.eval) parts.push(card('Evaluator speed', table(['Evaluator', 'ns per hand', 'Hands timed'], d.eval.map((r) => [escapeHtml(r.evaluator), r.ns_per_eval.toFixed(1), r.evals.toLocaleString()])), 'One thread, CPU time. Correctness is checked exhaustively: all 133,784,560 seven-card hands give the published category counts.'));
  root.innerHTML = parts.join('');
}
