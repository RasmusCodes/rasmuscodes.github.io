// Automatic river review: a port of crates/pe-hh/src/review.rs. Each heads-up river
// decision is compared with an equilibrium of the river as the hand reached it:
// both players' ranges from the street-by-street reconstruction, the hand's board,
// pot and stacks, and a bet menu that contains the sizes actually used.

import { NUM_COMBOS, comboCards, comboIndex, parseCards, cardsStr } from './cards.js';
import { prepareSpot, actionLabel } from './tree.js';
import { HuSolver, solve } from './solver.js';
import { decisions, isHoldem, reconstructRanges, DEFAULT_RANGE_OPTIONS } from './ranges.js';

export const DEFAULT_REVIEW_OPTIONS = { max_iterations: 600, target_pct: 0.5, check_every: 50, prune: 1e-4 };
/** A decision both players reach with some regularity at the equilibrium (own line at least 5%, the opponent's range at least 2%). */
export const onPath = (d) => d.path_probability !== null && d.path_probability >= 0.05 && d.opponent_path_probability >= 0.02;
const ORDER = { preflop: 0, flop: 1, turn: 2, river: 3 };

const holeOf = (hand, seat) => {
  const p = hand.players.find((x) => x.seat === seat);
  let cards = p && p.hole && p.hole.length ? p.hole : null;
  if (!cards) { const s = hand.shown.find((x) => x.seat === seat); cards = s && s.cards.length ? s.cards : null; }
  if (!cards) return null;
  try { const c = parseCards(cards.join('')); return c.length === 2 && c[0] !== c[1] ? comboIndex(c[0], c[1]) : null; } catch (e) { return null; }
};

/** Reviews the river of one hand; null when it has no heads-up river decision. `strengths` may be precomputed (streetStrengths). */
export function reviewRiver(hand, table, ropts = DEFAULT_RANGE_OPTIONS, opts = DEFAULT_REVIEW_OPTIONS, onProgress = null, strengths = null) {
  if (!isHoldem(hand) || hand.board_kind !== 'single' || !(hand.bb > 0)) return null;
  const river = hand.streets.find((s) => s.name === 'river');
  const boardStr = (hand.boards[0] || []).join('');
  if (!river || !river.actions.length || (hand.boards[0] || []).length !== 5) return null;
  const board = parseCards(boardStr);
  const ds = decisions(hand);
  const first = ds.find((d) => d.street === 'river');
  if (!first) return null;
  const folded = new Set(ds.filter((d) => ORDER[d.street] < 3 && d.action === 'fold').map((d) => d.seat));
  const alive = [...new Set(hand.players.filter((p) => !p.sitting_out).map((p) => p.seat))].sort((a, b) => a - b).filter((s) => !folded.has(s));
  if (alive.length !== 2) return null;
  const oop = first.seat, ip = alive[0] === oop ? alive[1] : alive[0];
  const seats = [oop, ip];
  const bb = hand.bb;
  const stackAt = (seat) => {
    let s = (hand.players.find((p) => p.seat === seat) || {}).stack ?? 0;
    for (const p of hand.posts) if (p.seat === seat) s -= p.amount;
    for (const st of hand.streets) if (ORDER[st.name] < 3) for (const a of st.actions) if (a.seat === seat) s -= a.amount;
    return s;
  };
  const stacks = [stackAt(oop), stackAt(ip)];
  const potStart = first.pot_before;
  let bets = [0.33, 0.75], raises = [1.0];
  let streetIn = [0, 0], potNow = potStart, aggressions = 0;
  const side = (seat) => (seat !== oop ? 1 : 0);
  for (const a of river.actions) {
    const p = side(a.seat);
    const maxIn = Math.max(streetIn[0], streetIn[1]);
    if (a.type === 'bet') { bets.push((streetIn[p] + a.amount) / potNow); aggressions++; }
    else if (a.type === 'raise') { const call = maxIn - streetIn[p]; raises.push((streetIn[p] + a.amount - maxIn) / (potNow + call)); aggressions++; }
    streetIn[p] += a.amount;
    potNow += a.amount;
  }
  const tidy = (v) => {
    const s = v.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
    const out = [];
    for (const x of s) if (!out.length || Math.abs(x - out[out.length - 1]) >= 1e-9) out.push(x);
    return out;
  };
  bets = tidy(bets);
  raises = tidy(raises);
  const menu = { bets, raises, max_raises: Math.max(aggressions, 2), allin_threshold: 1.0, add_allin: true };
  const ranges = reconstructRanges(hand, table, ropts, strengths);
  const snap = ranges.snapshots.find((s) => s.label === 'river');
  if (!snap) throw new Error(`hand ${hand.id}: no river snapshot`);
  const known = seats.map((s) => holeOf(hand, s));
  const lists = [], effective = [0, 0];
  for (let k = 0; k < 2; k++) {
    const sr = snap.seats.find((s) => s.seat === seats[k]);
    if (!sr) throw new Error(`hand ${hand.id}: seat ${seats[k]} has no river range`);
    effective[k] = sr.effective_combos;
    const probs = sr.probs;
    let max = 0;
    for (const p of probs) max = Math.max(max, p);
    const hands = [], weights = [];
    for (let i = 0; i < NUM_COMBOS; i++) {
      const p = probs[i];
      if (p <= 0 || (p < opts.prune * max && known[k] !== i)) continue;
      const [a, b] = comboCards(i);
      hands.push([b, a]);
      weights.push(p);
    }
    lists.push({ hands, weights });
  }
  const combos = [lists[0].hands.length, lists[1].hands.length];
  const cfg = { game: 'NLH', board: boardStr, ranges: ['reconstructed', 'reconstructed'], pot: potStart / bb, stacks: [stacks[0] / bb, stacks[1] / bb], menu };
  const solver = new HuSolver(prepareSpot(cfg, lists), { algo: 'DCFR', maxNodes: 2000000 });
  solve(solver, { maxIterations: opts.max_iterations, targetPct: opts.target_pct, checkEvery: opts.check_every, onProgress });
  const e = solver.exploitability();
  let node = 0;
  streetIn = [0, 0];
  const path = [1, 1]; // probability that the equilibrium, with this hand, takes the player's earlier river actions
  const rangePath = [1, 1]; // probability that each player's equilibrium range takes their river actions so far
  const out = [];
  river.actions.forEach((a, j) => {
    const p = side(a.seat);
    const nd = solver.tree.nodes[node];
    if (nd.kind !== 'decision') throw new Error(`hand ${hand.id}: the river tree ends before the actions do`);
    if (nd.player !== p) throw new Error(`hand ${hand.id}: the acting order differs from the tree`);
    let taken = -1, matched = true;
    if (a.type === 'fold' || a.type === 'check' || a.type === 'call') taken = nd.actions.findIndex((x) => x.type === a.type);
    else {
      const target = (streetIn[p] + a.amount) / bb;
      let best = null;
      nd.actions.forEach((x, i) => {
        if (x.type !== 'bet' && x.type !== 'raise' && x.type !== 'allin') return;
        const d = a.all_in && x.type === 'allin' ? -1 : Math.abs(x.to - target);
        if (best === null || d < best[1]) best = [i, d];
      });
      if (best) { taken = best[0]; matched = best[1] <= 1e-6 * Math.max(target, 1); } else matched = false;
    }
    if (taken < 0) throw new Error(`hand ${hand.id}: action ${a.type} is not in the river tree`);
    const k = nd.actions.length, n = solver.hands[p].length;
    const sigma = solver.averageStrategy(node);
    const { evs, reach } = solver.actionValues(node);
    let tot = 0;
    for (let h = 0; h < n; h++) tot += reach[h];
    const rangeFreqs = nd.actions.map((_, x) => { if (!(tot > 0)) return 0; let s = 0; for (let h = 0; h < n; h++) s += reach[h] * sigma[x * n + h]; return s / tot; });
    const d = { index: first.index + j, seat: a.seat, name: (hand.players.find((q) => q.seat === a.seat) || {}).name || '', actions: nd.actions.map(actionLabel), taken, size_matched: matched, range_frequencies: rangeFreqs, hand: null, probs: [], evs: [], best: null, frequency: null, ev_loss_bb: null, path_probability: null, opponent_path_probability: rangePath[1 - p] };
    rangePath[p] *= rangeFreqs[taken];
    const ci = known[p];
    if (ci !== null) {
      const [c1, c2] = comboCards(ci);
      const h = solver.hands[p].findIndex((hh) => hh.includes(c1) && hh.includes(c2));
      if (h >= 0) {
        const probs = Array.from({ length: k }, (_, x) => sigma[x * n + h]);
        const ev = Array.from({ length: k }, (_, x) => evs[x][h]);
        let best = 0;
        for (let x = 1; x < k; x++) if (ev[x] > ev[best]) best = x;
        Object.assign(d, { hand: cardsStr([c1, c2]), probs, evs: ev, best, frequency: probs[taken], ev_loss_bb: ev[best] - ev[taken], path_probability: path[p] });
        path[p] *= probs[taken];
      }
    }
    out.push(d);
    node = nd.children[taken];
    streetIn[p] += a.amount;
  });
  return {
    id: hand.id, board: boardStr, pot_bb: potStart / bb, stacks_bb: [stacks[0] / bb, stacks[1] / bb], seats,
    names: seats.map((s) => (hand.players.find((q) => q.seat === s) || {}).name || ''), combos, effective_combos: effective,
    bets, raises, iterations: solver.iterations, exploitability_pct: e.pctPot, decisions: out,
    label: 'Equilibrium of the river with model-based ranges and the hand\'s own bet sizes; costs assume an opponent playing that equilibrium',
  };
}
