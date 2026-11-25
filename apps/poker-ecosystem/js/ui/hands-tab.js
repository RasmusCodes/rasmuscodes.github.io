// Hand-history tab: parse PokerStars text in the browser, filter, replay, all-in equity,
// street-by-street ranges and an equilibrium review of heads-up river decisions.
import { $, escapeHtml, suitHtml } from '../app.js';
import { parsePokerStars, analyseHand } from '../engine/hh.js';
import { className } from '../engine/cards.js';

let hands = [], shown = [], active = null;
let engine = null, loaded = Promise.resolve(), rangeResult = null, rangeLabel = null;
let precomputed = null; // river reviews of the simulated sample, written by `pe hh review` (same model, same numbers)
const bb = (h, milli) => (h.bb ? milli / h.bb : milli / 1000);
const fmtBb = (h, milli) => `${bb(h, milli).toFixed(1)} bb`;
const name = (h, seat) => (h.players.find((p) => p.seat === seat) || {}).name || `seat ${seat}`;
const reached = (h) => {
  const n = Math.max(0, ...h.boards.map((b) => b.length));
  return n >= 5 ? 'river' : n === 4 ? 'turn' : n === 3 ? 'flop' : 'preflop';
};
const special = (h) => h.bomb_pot || h.board_kind !== 'single' || h.posts.some((p) => p.kind === 'straddle' || p.kind === 'mississippi');
const pct = (x) => `${(100 * x).toFixed(0)}%`;
/** Off the equilibrium path: the hand's own line under 5% or the opponent's range line under 2% (review.rs::on_path). */
const off = (d) => !(d.path_probability !== null && d.path_probability >= 0.05 && d.opponent_path_probability >= 0.02);
/** A hold'em hand with a river decision between exactly two players (what the review covers). */
function headsUpRiver(h) {
  if (!['NLH', 'FLH', 'LHE'].includes(h.game) || h.board_kind !== 'single' || (h.boards[0] || []).length !== 5) return false;
  const river = h.streets.find((s) => s.name === 'river');
  if (!river || !river.actions.length) return false;
  const folded = new Set(h.streets.filter((s) => s.name !== 'river').flatMap((s) => s.actions.filter((a) => a.type === 'fold').map((a) => a.seat)));
  return h.players.filter((p) => !p.sitting_out && !folded.has(p.seat)).length === 2;
}

function filtered() {
  const player = $('#f-player').value.trim().toLowerCase(), pos = $('#f-pos').value, minPot = +$('#f-pot').value || 0, street = $('#f-street').value;
  const order = ['preflop', 'flop', 'turn', 'river'];
  return hands.filter((h) => {
    if (player && !h.players.some((p) => p.name.toLowerCase().includes(player) && (!pos || p.position === pos))) return false;
    if (!player && pos && !h.players.some((p) => p.position === pos)) return false;
    if (bb(h, h.total_pot) < minPot) return false;
    if (street && order.indexOf(reached(h)) < order.indexOf(street)) return false;
    if ($('#f-sd').checked && !(h.derived && h.derived.showdown_seats.length)) return false;
    if ($('#f-ai').checked && !(h.derived && h.derived.allin)) return false;
    if ($('#f-special').checked && !special(h)) return false;
    return true;
  });
}

function renderList() {
  shown = filtered();
  $('#hh-count').textContent = `${shown.length} of ${hands.length}`;
  $('#hh-table').innerHTML = `<thead><tr><th>Hand</th><th>Game</th><th class="num">Pot</th><th>Winner</th><th>Board</th><th>Notes</th></tr></thead><tbody>` +
    shown.slice(0, 400).map((h, i) => {
      const winners = [...new Set(h.collected.map((c) => name(h, c.seat)))].join(', ');
      const notes = [h.derived && !h.derived.ok ? '⚠ mismatch' : '', h.derived && h.derived.allin ? 'all-in' : '', h.bomb_pot ? 'bomb pot' : '', h.board_kind === 'double' ? 'double board' : '', h.board_kind === 'run_twice' ? 'run twice' : '', h.posts.some((p) => p.kind === 'straddle') ? 'straddle' : '', h.posts.some((p) => p.kind === 'mississippi') ? 'Mississippi straddle' : '', headsUpRiver(h) ? 'river review' : ''].filter(Boolean).join(' · ');
      return `<tr class="clickable${active === h ? ' active' : ''}" data-i="${i}"><td class="mono">${escapeHtml(h.id)}</td><td>${h.game}</td><td class="num">${fmtBb(h, h.total_pot)}</td><td>${escapeHtml(winners)}</td><td class="cards">${suitHtml((h.boards[0] || []).join(''))}</td><td class="small">${notes}</td></tr>`;
    }).join('') + '</tbody>';
  for (const tr of document.querySelectorAll('#hh-table tr[data-i]')) tr.addEventListener('click', () => replay(shown[+tr.dataset.i]));
  summary();
}

function summary() {
  const per = new Map();
  for (const h of shown) {
    const pre = h.streets.find((s) => s.name === 'preflop');
    for (const p of h.players) {
      const x = per.get(p.name) || { hands: 0, vpip: 0, pfr: 0, net: 0, luck: 0, allins: 0 };
      x.hands++;
      if (pre && pre.actions.some((a) => a.seat === p.seat && (a.type === 'call' || a.type === 'raise' || a.type === 'bet'))) x.vpip++;
      if (pre && pre.actions.some((a) => a.seat === p.seat && a.type === 'raise')) x.pfr++;
      const net = h.derived ? h.derived.net[p.seat] || 0 : 0;
      x.net += bb(h, net);
      if (h.derived && h.derived.allin && h.derived.allin.ev_net[p.seat] !== undefined) { x.luck += bb(h, net - h.derived.allin.ev_net[p.seat]); x.allins++; }
      per.set(p.name, x);
    }
  }
  const rows = [...per].sort((a, b) => b[1].hands - a[1].hands).slice(0, 12);
  $('#hh-summary').innerHTML = rows.length ? `<div class="table-wrap"><table><thead><tr><th>Player</th><th class="num">Hands</th><th class="num">VPIP</th><th class="num">PFR</th><th class="num">Net</th><th class="num">All-in luck</th></tr></thead><tbody>${rows.map(([n, x]) => `<tr><td>${escapeHtml(n)}</td><td class="num">${x.hands}</td><td class="num">${(100 * x.vpip / x.hands).toFixed(0)}%</td><td class="num">${(100 * x.pfr / x.hands).toFixed(0)}%</td><td class="num">${x.net.toFixed(1)} bb</td><td class="num" title="${x.allins} all-ins">${x.luck.toFixed(1)} bb</td></tr>`).join('')}</tbody></table></div><p class="muted">All-in luck = actual result minus the equity-based expectation in hands that were all-in before the river with cards known.</p>` : '';
}

function replay(h) {
  active = h;
  renderList();
  $('#replay-card').hidden = false;
  $('#replay-title').textContent = `Hand ${h.id} · ${h.game} ${h.limit} · ${(h.sb / 1000)}/${(h.bb / 1000)} ${h.currency}`;
  const d = h.derived || {};
  let pot = h.posts.reduce((a, p) => a + p.amount, 0);
  const players = `<div class="table-wrap"><table><thead><tr><th>Seat</th><th>Player</th><th>Position</th><th class="num">Stack</th><th>Cards</th><th class="num">Net</th></tr></thead><tbody>${h.players.map((p) => `<tr><td>${p.seat}</td><td>${escapeHtml(p.name)}${p.hero ? ' (hero)' : ''}</td><td>${p.position || ''}</td><td class="num">${fmtBb(h, p.stack)}</td><td class="cards">${p.hole ? suitHtml(p.hole.join('')) : '<span class="muted">unknown</span>'}</td><td class="num">${d.net && d.net[p.seat] !== undefined ? fmtBb(h, d.net[p.seat]) : ''}</td></tr>`).join('')}</tbody></table></div>`;
  const posts = h.posts.length ? `<p class="small">${h.posts.map((p) => `${escapeHtml(name(h, p.seat))} posts ${p.kind} ${fmtBb(h, p.amount)}`).join(' · ')}</p>` : '';
  const streets = h.streets.map((s) => {
    const n = { preflop: 0, flop: 3, turn: 4, river: 5 }[s.name];
    const boards = s.name === 'preflop' ? '' : h.boards.map((b) => `<span class="cards">${suitHtml(b.slice(0, n).join(''))}</span>`).join(' / ');
    const acts = s.actions.map((a) => { pot += a.amount; return `${escapeHtml(name(h, a.seat))} ${a.type}${a.amount ? ' ' + fmtBb(h, a.amount) : ''}${a.type === 'raise' ? ' to ' + fmtBb(h, a.to) : ''}${a.all_in ? ' (all-in)' : ''}`; }).join(' · ');
    return `<div class="street"><h4>${s.name[0].toUpperCase() + s.name.slice(1)} ${boards}</h4><p class="small">${acts}</p><p class="small muted">pot after: ${fmtBb(h, pot)}</p></div>`;
  }).join('');
  const boards = `<p>Board${h.boards.length > 1 ? 's' : ''}: ${h.boards.map((b) => `<span class="cards">${suitHtml(b.join(''))}</span>`).join(' / ')}${h.board_kind === 'run_twice' ? ' (run twice)' : h.board_kind === 'double' ? ' (double board)' : ''}</p>`;
  const shownCards = h.shown.length ? `<p class="small">Shown: ${h.shown.map((s) => `${escapeHtml(name(h, s.seat))} <span class="cards">${suitHtml(s.cards.join(''))}</span>${s.description ? ` (${escapeHtml(s.description)})` : ''}`).join(' · ')}</p>` : '';
  const collected = `<p class="small">Collected: ${h.collected.map((c) => `${escapeHtml(name(h, c.seat))} ${fmtBb(h, c.amount)}${c.pot ? ` (side pot ${c.pot})` : ''}${c.board ? ` (board ${c.board})` : ''}`).join(' · ')}; total pot ${fmtBb(h, h.total_pot)}, rake ${fmtBb(h, h.rake)}.</p>`;
  const check = d.ok ? `<p class="small"><span class="label-chip">reconstructs</span> contributions, side pots, rake and collections agree with the summary.</p>` : `<p class="small status err">Reconstruction issues: ${escapeHtml((d.issues || []).join('; '))}</p>`;
  const pots = d.pots && d.pots.length > 1 ? `<p class="small">Pots: ${d.pots.map((p, i) => `${i ? 'side ' + i : 'main'} ${fmtBb(h, p.amount)} (${p.eligible.map((s) => escapeHtml(name(h, s))).join(', ')})`).join(' · ')}</p>` : '';
  const ai = d.allin ? `<p class="small"><b>All-in on the ${d.allin.street}.</b> Equity in the main pot: ${Object.entries(d.allin.equity).map(([s, e]) => `${escapeHtml(name(h, +s))} ${(100 * e).toFixed(1)}%`).join(', ')}. Expected net: ${Object.entries(d.allin.ev_net).map(([s, e]) => `${escapeHtml(name(h, +s))} ${fmtBb(h, e)}`).join(', ')}; luck = actual minus expected.</p>` : '';
  $('#replay').innerHTML = players + posts + streets + boards + shownCards + collected + pots + check + ai;
  rangeResult = null;
  $('#rg-out').innerHTML = '';
  $('#rv-out').innerHTML = '';
  $('#rg-status').textContent = '';
  const holdem = ['NLH', 'FLH', 'LHE'].includes(h.game);
  $('#rg-run').disabled = !holdem;
  $('#rv-run').disabled = !headsUpRiver(h);
  $('#rv-run').title = headsUpRiver(h) ? '' : 'The review covers hold\'em rivers played by exactly two players on one board.';
  if (!holdem) $('#rg-status').textContent = 'Ranges are reconstructed for hold\'em hands only.';
}

// ---------------------------------------------------------------- ranges

function gridHtml(seat) {
  // probability per combo of each class, shaded from the least likely class (empty) to the most likely (full)
  const dens = seat.grid.map((m, c) => (seat.grid_combos[c] ? m / seat.grid_combos[c] : 0));
  const live = dens.filter((d, c) => seat.grid_combos[c]);
  const max = Math.max(...live), min = Math.min(...live);
  const span = max - min > 1e-15 ? max - min : 1;
  return `<div class="rgrid mini">${dens.map((d, c) => {
    const w = seat.grid_combos[c] ? (100 * (d - min)) / span : 0;
    const combos = seat.grid_combos[c];
    return `<div class="rcell${combos ? '' : ' empty'}" title="${className(c)}: ${(100 * seat.grid[c]).toFixed(2)}% of the range${combos ? `, ${combos} combos possible` : ', blocked by the board'}">${w > 0.5 ? `<span class="fill" style="width:${w.toFixed(1)}%;background:var(--accent)"></span>` : ''}<em>${className(c)}</em></div>`;
  }).join('')}</div>`;
}

function seatHtml(seat) {
  const a = seat.actual;
  const actual = a ? `<p class="small">Actual <span class="cards">${suitHtml(a.cards)}</span>: ${(2 ** a.bits).toFixed(a.bits < -3 ? 3 : 1)}× as likely as a random combo; ${pct(1 - a.hpd_quantile)} of the range is less likely than it.</p>` : '';
  const top = `<p class="small muted">Most likely: ${seat.top.slice(0, 6).map(([c, p]) => `<span class="cards">${suitHtml(c)}</span> ${(100 * p).toFixed(1)}%`).join(', ')}</p>`;
  return `<div class="range-seat"><h4>${escapeHtml(seat.name)} <span class="sub">${seat.position}</span></h4><p class="small">As uncertain as ${seat.effective_combos.toFixed(0)} equally likely combos of ${seat.possible_combos}.</p>${gridHtml(seat)}${actual}${top}</div>`;
}

const CONTEXT = {
  open_early: 'unopened, early position', open_late: 'unopened, late position', open_blind: 'unopened, from the blinds', option: 'option (nothing to call)',
  vs_open: 'facing an open', vs_3bet: 'facing a 3-bet or more', cbet: 'c-bet spot', lead: 'leading into the aggressor', stab: 'first to bet', vs_bet: 'facing a bet', vs_raise: 'facing a raise',
};
function renderRanges() {
  const r = rangeResult;
  if (!r) return;
  const labels = r.snapshots.map((s) => s.label);
  if (!labels.includes(rangeLabel)) rangeLabel = labels.includes('river') ? 'river' : labels[labels.length - 1];
  const snap = r.snapshots.find((s) => s.label === rangeLabel);
  const name = (seat) => (active.players.find((p) => p.seat === seat) || {}).name || `seat ${seat}`;
const LABEL = { preflop: 'Dealt', flop: 'Flop', turn: 'Turn', river: 'River', end: 'End of hand' };
  const tabs = `<div class="row seg"><span class="small muted">Range at the start of:</span>${labels.map((l) => `<button type="button" class="btn${l === rangeLabel ? ' primary' : ''}" data-label="${l}">${LABEL[l] || l}</button>`).join('')}</div>`;
  const notes = r.actions.filter((a) => a.street === rangeLabel || (rangeLabel === 'end' && a.street === r.snapshots[r.snapshots.length - 2]?.label)).map((a) => {
    const ctx = a.context.slice(a.context.indexOf('_') + 1);
    return `<li>${escapeHtml(name(a.seat))} <b>${a.action}</b> <span class="muted">(${CONTEXT[ctx] || ctx}: fold ${pct(a.frequencies[0])}, check/call ${pct(a.frequencies[1])}, bet/raise ${pct(a.frequencies[2])}${a.likelihood_actual !== null ? `; with the actual cards the model gave this action ${pct(a.likelihood_actual)}` : ''})</span></li>`;
  }).join('');
  const board = snap.board ? `<p class="small">Board <span class="cards">${suitHtml(snap.board)}</span></p>` : '';
  $('#rg-out').innerHTML = `${tabs}${board}<div class="range-seats">${snap.seats.map(seatHtml).join('')}</div><p class="small muted">Each cell is shaded from the least likely starting hand (empty) to the most likely (full); hover for the share of the range. Uniform is the starting point, and the model keeps every hand possible.</p>${notes ? `<p class="small"><b>Actions on this street</b>, with the player's estimated frequencies in that spot:</p><ul class="small">${notes}</ul>` : ''}`;
  for (const b of document.querySelectorAll('#rg-out [data-label]')) b.addEventListener('click', () => { rangeLabel = b.dataset.label; renderRanges(); });
}

async function runRanges() {
  const h = active;
  $('#rg-status').textContent = 'Reconstructing (the flop needs every runout)…';
  try {
    await loaded;
    const r = await engine.run('hh-ranges', { hand: h.id }, ['hh-ranges']);
    if (active !== h) return;
    rangeResult = r.result;
    $('#rg-status').textContent = `Done in ${r.seconds.toFixed(1)} s.`;
    renderRanges();
  } catch (e) { $('#rg-status').textContent = e.message; }
}

// ---------------------------------------------------------------- river review

function reviewHtml(r) {
  const name = (seat) => (active && active.players.find((p) => p.seat === seat) || {}).name || `seat ${seat}`;
  const head = `<p class="small"><span class="label-chip approx">equilibrium of the abstracted river</span> River <span class="cards">${suitHtml(r.board)}</span>, pot ${r.pot_bb.toFixed(1)} bb, stacks ${r.stacks_bb.map((s) => s.toFixed(1)).join(' / ')} bb. ${escapeHtml(r.names[0])} is out of position. Ranges of ${r.combos[0]} and ${r.combos[1]} combos (as uncertain as ${r.effective_combos[0].toFixed(0)} and ${r.effective_combos[1].toFixed(0)}), bets of ${r.bets.map((b) => pct(b)).join(', ')} of the pot, raises of ${r.raises.map((b) => pct(b)).join(', ')}. Solved to ${r.exploitability_pct.toFixed(2)}% of the pot from equilibrium in ${r.iterations} iterations.</p>`;
  const rows = r.decisions.map((d) => {
    const th = d.actions.map((a, i) => `<th class="num">${escapeHtml(a)}${i === d.taken ? ' <span class="label-chip">taken</span>' : ''}${d.best === i && d.best !== d.taken ? ' ★' : ''}</th>`).join('');
    const range = `<tr><td>Range at equilibrium</td>${d.range_frequencies.map((f) => `<td class="num">${pct(f)}</td>`).join('')}</tr>`;
    const hand = d.hand ? `<tr><td><span class="cards">${suitHtml(d.hand)}</span> at equilibrium</td>${d.probs.map((p) => `<td class="num">${pct(p)}</td>`).join('')}</tr><tr><td>Value of each action (bb)</td>${d.evs.map((v) => `<td class="num">${v.toFixed(2)}</td>`).join('')}</tr>` : '';
    const ownOn = d.path_probability === null || d.path_probability >= 0.05;
    const oppOn = d.opponent_path_probability >= 0.02;
    const freq = !oppOn
      ? `the opponent's line so far is one the equilibrium takes only ${(100 * d.opponent_path_probability).toFixed(1)}% of the time, so the solver explores this point little and its strategy and values here are rough`
      : ownOn ? `the equilibrium plays it ${pct(d.frequency)} of the time with this hand` : `with this hand the equilibrium would get here only ${(100 * d.path_probability).toFixed(1)}% of the time, so its frequencies at this point say little; the values still compare the actions from here`;
    const verdict = d.hand ? `<p class="small">${d.ev_loss_bb > 0.005 ? `Cost of ${escapeHtml(d.actions[d.taken])}: <b>${d.ev_loss_bb.toFixed(2)} bb</b> against ${escapeHtml(d.actions[d.best])}` : '<b>No cost</b>: the action taken is the best or tied'}; ${freq}.${d.size_matched ? '' : ' The size used is not in the menu; the nearest size stands in.'}</p>` : `<p class="small muted">${escapeHtml(d.name)}'s cards are unknown, so only the range's equilibrium frequencies are shown.</p>`;
    return `<h4>${escapeHtml(name(d.seat))}</h4><div class="table-wrap"><table><thead><tr><th></th>${th}</tr></thead><tbody>${range}${hand}</tbody></table></div>${verdict}`;
  }).join('');
  return head + rows + `<p class="small muted">${escapeHtml(r.label)}. Values assume both players play the equilibrium from here; a cost is not money lost against this opponent.</p>`;
}

async function runReview() {
  const h = active;
  $('#rg-status').textContent = 'Reconstructing the ranges and solving the river…';
  try {
    await loaded;
    const r = await engine.run('hh-review', { hand: h.id }, ['hh-review'], (m) => { if (m.type === 'progress') $('#rg-status').textContent = `Solving the river: ${m.pctPot.toFixed(2)}% of the pot after ${m.iteration} iterations…`; });
    if (active !== h) return;
    $('#rg-status').textContent = `Done in ${r.seconds.toFixed(1)} s.`;
    $('#rv-out').innerHTML = r.result ? `<h3>River review</h3>${reviewHtml(r.result)}` : '<p class="small">No heads-up river decision in this hand.</p>';
  } catch (e) { $('#rg-status').textContent = e.message; }
}

async function reviewAll() {
  $('#rv-all-status').textContent = 'Starting…';
  $('#rv-all-out').innerHTML = '';
  try {
    await loaded;
    const r = precomputed
      ? { reviews: precomputed.reviews, failed: precomputed.failed || [], seconds: precomputed.cpu_seconds || 0, rust: true }
      : await engine.run('hh-review-all', {}, ['hh-review-all'], (m) => { if (m.type === 'progress') $('#rv-all-status').textContent = `Hand ${m.done} of ${m.total}: ${m.reviewed} rivers reviewed…`; });
    const decisions = r.reviews.flatMap((rv) => rv.decisions.filter((d) => d.ev_loss_bb !== null).map((d) => ({ id: rv.id, d })));
    decisions.sort((a, b) => b.d.ev_loss_bb - a.d.ev_loss_bb || (a.id < b.id ? -1 : 1));
    const mean = decisions.length ? decisions.reduce((s, x) => s + x.d.ev_loss_bb, 0) / decisions.length : 0;
    $('#rv-all-status').textContent = r.rust
      ? `${r.reviews.length} rivers, ${decisions.length} decisions with known cards, reviewed in advance by the Rust engine with the same model (${r.seconds.toFixed(0)} CPU seconds); click a row to rerun it live in your browser.`
      : `${r.reviews.length} rivers, ${decisions.length} decisions with known cards, in ${r.seconds.toFixed(0)} s${r.failed.length ? `; ${r.failed.length} failed` : ''}.`;
    $('#rv-all-out').innerHTML = decisions.length ? `<p>Average cost ${mean.toFixed(2)} bb per decision. The costliest:</p><div class="table-wrap"><table><thead><tr><th>Hand</th><th>Player</th><th>Cards</th><th>Taken</th><th>Best</th><th class="num">Cost</th><th class="num">Played at eq.</th></tr></thead><tbody>${decisions.slice(0, 12).map(({ id, d }) => `<tr class="clickable" data-id="${escapeHtml(id)}"><td class="mono">${escapeHtml(id)}</td><td>${escapeHtml(d.name)}</td><td class="cards">${suitHtml(d.hand)}</td><td>${escapeHtml(d.actions[d.taken])}</td><td>${escapeHtml(d.actions[d.best])}</td><td class="num">${d.ev_loss_bb.toFixed(2)} bb${off(d) ? '*' : ''}</td><td class="num">${off(d) ? 'off path' : pct(d.frequency)}</td></tr>`).join('')}</tbody></table></div><p class="muted">* Off the equilibrium path: the equilibrium would rarely reach this decision (with this hand, or given the opponent's line), so the solver explores it little and the numbers are rough.</p>` : '';
    for (const tr of document.querySelectorAll('#rv-all-out tr[data-id]')) tr.addEventListener('click', () => { const h = hands.find((x) => x.id === tr.dataset.id); if (h) { replay(h); $('#replay-card').scrollIntoView({ behavior: 'smooth' }); runReview(); } });
  } catch (e) { $('#rv-all-status').textContent = e.message; }
}

function load(list, label) {
  hands = list.map((h) => analyseHand(h));
  active = null;
  $('#replay-card').hidden = true;
  $('#rv-all-out').innerHTML = '';
  $('#rv-all-status').textContent = '';
  const bad = hands.filter((h) => !h.derived.ok).length;
  const rivers = hands.filter(headsUpRiver).length;
  $('#hh-status').textContent = `${label}: ${hands.length} hands${bad ? `, ${bad} with reconstruction issues` : ', all reconstruct'}; ${rivers} heads-up rivers to review.`;
  if (engine) loaded = engine.run('hh-load', { hands }, ['hh-loaded']);
  renderList();
}

export async function initHands(eng) {
  engine = eng;
  $('#rg-run').addEventListener('click', runRanges);
  $('#rv-run').addEventListener('click', runReview);
  $('#rv-all').addEventListener('click', reviewAll);
  try { $('#hh-text').value = await (await fetch('data/pokerstars-sample.txt')).text(); } catch (e) { /* the box stays empty */ }
  $('#hh-parse').addEventListener('click', () => {
    const { hands: hs, warnings } = parsePokerStars($('#hh-text').value);
    precomputed = null;
    load(hs, `Parsed${warnings.length ? ` with ${warnings.length} warnings (${escapeHtml(warnings[0])})` : ''}`);
  });
  $('#hh-synth').addEventListener('click', async () => {
    $('#hh-status').textContent = 'Loading…';
    try {
      const list = await (await fetch('data/hands-sample.json')).json();
      let reviews = null;
      try { reviews = await (await fetch('data/hands-sample-reviews.json')).json(); } catch (e) { /* reviews run live instead */ }
      load(list, 'Simulated corpus sample');
      precomputed = reviews;
    } catch (e) { $('#hh-status').textContent = 'Could not load the sample.'; }
  });
  for (const id of ['#f-player', '#f-pos', '#f-pot', '#f-street', '#f-sd', '#f-ai', '#f-special']) $(id).addEventListener('input', renderList);
  $('#hh-parse').click();
}
