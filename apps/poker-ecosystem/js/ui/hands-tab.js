// Hand-history tab: parse PokerStars text in the browser, filter, replay, all-in equity.
import { $, escapeHtml, suitHtml } from '../app.js';
import { parsePokerStars, analyseHand } from '../engine/hh.js';

let hands = [], shown = [], active = null;
const bb = (h, milli) => (h.bb ? milli / h.bb : milli / 1000);
const fmtBb = (h, milli) => `${bb(h, milli).toFixed(1)} bb`;
const name = (h, seat) => (h.players.find((p) => p.seat === seat) || {}).name || `seat ${seat}`;
const reached = (h) => {
  const n = Math.max(0, ...h.boards.map((b) => b.length));
  return n >= 5 ? 'river' : n === 4 ? 'turn' : n === 3 ? 'flop' : 'preflop';
};
const special = (h) => h.bomb_pot || h.board_kind !== 'single' || h.posts.some((p) => p.kind === 'straddle');

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
      const notes = [h.derived && !h.derived.ok ? '⚠ mismatch' : '', h.derived && h.derived.allin ? 'all-in' : '', h.bomb_pot ? 'bomb pot' : '', h.board_kind === 'double' ? 'double board' : '', h.board_kind === 'run_twice' ? 'run twice' : '', h.posts.some((p) => p.kind === 'straddle') ? 'straddle' : ''].filter(Boolean).join(' · ');
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
}

function load(list, label) {
  hands = list.map((h) => analyseHand(h));
  active = null;
  $('#replay-card').hidden = true;
  const bad = hands.filter((h) => !h.derived.ok).length;
  $('#hh-status').textContent = `${label}: ${hands.length} hands${bad ? `, ${bad} with reconstruction issues` : ', all reconstruct'}.`;
  renderList();
}

export async function initHands() {
  try { $('#hh-text').value = await (await fetch('data/pokerstars-sample.txt')).text(); } catch (e) { /* the box stays empty */ }
  $('#hh-parse').addEventListener('click', () => {
    const { hands: hs, warnings } = parsePokerStars($('#hh-text').value);
    load(hs, `Parsed${warnings.length ? ` with ${warnings.length} warnings (${escapeHtml(warnings[0])})` : ''}`);
  });
  $('#hh-synth').addEventListener('click', async () => {
    $('#hh-status').textContent = 'Loading…';
    try { load(await (await fetch('data/hands-sample.json')).json(), 'Simulated corpus sample'); } catch (e) { $('#hh-status').textContent = 'Could not load the sample.'; }
  });
  for (const id of ['#f-player', '#f-pos', '#f-pot', '#f-street', '#f-sd', '#f-ai', '#f-special']) $(id).addEventListener('input', renderList);
  $('#hh-parse').click();
}
