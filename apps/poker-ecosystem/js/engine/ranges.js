// Street-by-street ranges: a port of crates/pe-hh/src/ranges.rs. Every step is the
// same arithmetic in the same order, so the probabilities equal the Rust engine's
// to the last bit (summaries that use log and exp agree to about 1e-15).
//
// Bayes' rule with a model of play: all 1,326 combos start equally likely; each
// action's likelihood is a threshold strategy built from the player's estimated
// frequencies in that context (polarised bets and raises after the flop), mixed
// with `noise` (the action follows the frequencies regardless of the cards) and a
// tiny uniform `tremble`.

import { NUM_COMBOS, comboCards, comboIndex, classOf, preflopRanking, cardsStr, parseCards } from './cards.js';
import { evalSuits } from './eval.js';
import { seatPositions } from './hh.js';

export const CATEGORIES = ['fold', 'check/call', 'bet/raise'];
// noise fitted by `pe bench ranges` (log score on held-out simulated hands)
export const DEFAULT_RANGE_OPTIONS = { noise: 0.5, tremble: 0.001, player_prior: 10, population_prior: 20 };
const BET_BLUFF = 0.66 / 2.32;
const RAISE_BLUFF = 1.0 / 3.0;
const STREETS = ['preflop', 'flop', 'turn', 'river'];
const BOARD_LEN = { preflop: 0, flop: 3, turn: 4, river: 5 };
const LIVE = new Set(['sb', 'bb', 'straddle', 'mississippi']);
const COMBO = Array.from({ length: NUM_COMBOS }, (_, i) => comboCards(i)); // [hi, lo]
const COMBO_LO = COMBO.map(([a, b]) => (a < 32 ? 1 << a : 0) | (b < 32 ? 1 << b : 0));
const COMBO_HI = COMBO.map(([a, b]) => (a >= 32 ? 1 << (a - 32) : 0) | (b >= 32 ? 1 << (b - 32) : 0));
const blocks = (i, lo, hi) => (COMBO_LO[i] & lo) !== 0 || (COMBO_HI[i] & hi) !== 0;
const maskOf = (cards) => { let lo = 0, hi = 0; for (const c of cards) { if (c < 32) lo |= 1 << c; else hi |= 1 << (c - 32); } return [lo, hi]; };

export const isHoldem = (h) => h.game === 'NLH' || h.game === 'FLH' || h.game === 'LHE';
export const categoryOf = (type) => (type === 'fold' ? 0 : type === 'check' || type === 'call' ? 1 : 2);

// ---------------------------------------------------------------- decisions

/** Replays a hand and labels every action with its public context. */
export function decisions(hand) {
  const dealt = [...new Set(hand.players.filter((p) => !p.sitting_out).map((p) => p.seat))].sort((a, b) => a - b);
  const pos = seatPositions(hand);
  const stack = new Map(dealt.map((s) => [s, (hand.players.find((p) => p.seat === s) || {}).stack ?? 0]));
  const streetIn = new Map(dealt.map((s) => [s, 0]));
  const folded = new Set();
  let pot = 0;
  for (const p of hand.posts) {
    stack.set(p.seat, (stack.get(p.seat) ?? 0) - p.amount);
    pot += p.amount;
    if (LIVE.has(p.kind)) streetIn.set(p.seat, (streetIn.get(p.seat) ?? 0) + p.amount);
  }
  const out = [];
  let initiative = null, index = 0;
  for (const st of hand.streets) {
    if (st.name !== 'preflop') for (const k of streetIn.keys()) streetIn.set(k, 0);
    let aggressions = 0, lastAggressor = null;
    st.actions.forEach((a, acted) => {
      const maxIn = Math.max(0, ...streetIn.values());
      const mine = streetIn.get(a.seat) ?? 0;
      const toCall = Math.max(maxIn - mine, 0);
      const myStack = stack.get(a.seat) ?? 0;
      const others = dealt.some((s) => s !== a.seat && !folded.has(s) && (stack.get(s) ?? 0) > 0);
      const available = [toCall > 0, true, myStack > toCall && others];
      const category = categoryOf(a.type);
      available[category] = true;
      let spot;
      if (st.name === 'preflop') {
        if (aggressions === 0) {
          const p = pos.get(a.seat);
          spot = toCall > 0 ? (p === 'SB' || p === 'BB' ? 'open_blind' : p === 'BTN' || p === 'CO' ? 'open_late' : 'open_early') : 'option';
        } else spot = aggressions === 1 ? 'vs_open' : 'vs_3bet';
      } else {
        const leading = initiative !== null && initiative !== a.seat && !folded.has(initiative) && acted === 0;
        if (aggressions === 0) spot = initiative === a.seat ? 'cbet' : leading ? 'lead' : 'stab';
        else spot = aggressions === 1 ? 'vs_bet' : 'vs_raise';
      }
      out.push({ index, street: st.name, seat: a.seat, action: a.type, context: `${st.name}_${spot}`, category, available, pot_before: pot, to_call: toCall, stack_before: myStack });
      stack.set(a.seat, (stack.get(a.seat) ?? 0) - a.amount);
      streetIn.set(a.seat, (streetIn.get(a.seat) ?? 0) + a.amount);
      pot += a.amount;
      if (a.type === 'fold') folded.add(a.seat);
      if (a.type === 'bet' || a.type === 'raise') { aggressions++; lastAggressor = a.seat; }
      index++;
    });
    initiative = lastAggressor;
  }
  return out;
}

// ---------------------------------------------------------------- frequencies

export function defaultFrequencies(context) {
  const cut = context.indexOf('_');
  const street = cut >= 0 ? context.slice(0, cut) : '', spot = cut >= 0 ? context.slice(cut + 1) : context;
  switch (spot) {
    case 'open_early': return [0.80, 0.03, 0.17];
    case 'open_late': return [0.60, 0.05, 0.35];
    case 'open_blind': return [0.60, 0.15, 0.25];
    case 'option': return [0.0, 0.85, 0.15];
    case 'vs_open': return [0.70, 0.20, 0.10];
    case 'vs_3bet': return [0.50, 0.35, 0.15];
    case 'cbet': return street === 'flop' ? [0.0, 0.40, 0.60] : street === 'turn' ? [0.0, 0.50, 0.50] : [0.0, 0.55, 0.45];
    case 'lead': return [0.0, 0.92, 0.08];
    case 'stab': return [0.0, 0.60, 0.40];
    case 'vs_bet': return [0.45, 0.45, 0.10];
    default: return [0.40, 0.45, 0.15];
  }
}

/** Decision counts by player and context (fold, check/call, bet/raise). */
export class FrequencyTable {
  constructor() { this.population = new Map(); this.players = new Map(); this.hands = 0; }

  static fromHands(hands) {
    const t = new FrequencyTable();
    for (const h of hands) {
      if (!isHoldem(h)) continue;
      t.hands++;
      for (const d of decisions(h)) {
        if (!d.available[2]) continue;
        const name = (h.players.find((p) => p.seat === d.seat) || {}).name || '';
        if (!t.population.has(d.context)) t.population.set(d.context, [0, 0, 0]);
        t.population.get(d.context)[d.category] += 1;
        if (!t.players.has(name)) t.players.set(name, new Map());
        const m = t.players.get(name);
        if (!m.has(d.context)) m.set(d.context, [0, 0, 0]);
        m.get(d.context)[d.category] += 1;
      }
    }
    return t;
  }

  estimate(player, context, available, opts) {
    const d = defaultFrequencies(context);
    const pc = this.population.get(context) || [0, 0, 0];
    const pn = pc[0] + pc[1] + pc[2];
    const m0 = opts.population_prior;
    const pop = [(pc[0] + m0 * d[0]) / (pn + m0), (pc[1] + m0 * d[1]) / (pn + m0), (pc[2] + m0 * d[2]) / (pn + m0)];
    const mc = (this.players.get(player) && this.players.get(player).get(context)) || [0, 0, 0];
    const mn = mc[0] + mc[1] + mc[2];
    const m = opts.player_prior;
    const p = [(mc[0] + m * pop[0]) / (mn + m), (mc[1] + m * pop[1]) / (mn + m), (mc[2] + m * pop[2]) / (mn + m)];
    for (let a = 0; a < 3; a++) if (!available[a]) p[a] = 0;
    const t = p[0] + p[1] + p[2];
    if (t > 0) for (let a = 0; a < 3; a++) p[a] /= t;
    else { const k = available.filter(Boolean).length; for (let a = 0; a < 3; a++) p[a] = available[a] ? 1 / k : 0; }
    return p;
  }
}

// ---------------------------------------------------------------- strength

let PREFLOP = null;
export function preflopStrengths() {
  if (PREFLOP) return PREFLOP;
  const order = preflopRanking();
  const rank = new Array(169).fill(0);
  order.forEach((c, i) => { rank[c] = i; });
  PREFLOP = Float64Array.from({ length: NUM_COMBOS }, (_, i) => 168 - rank[classOf(COMBO[i][0], COMBO[i][1])]);
  return PREFLOP;
}

/** On a complete board: each combo's share of random holdings it beats (ties half), card removal exact; -1 if blocked. */
export function showdownShares(board) {
  const [blo, bhi] = maskOf(board);
  const bs = [0, 0, 0, 0];
  for (const c of board) bs[c & 3] |= 1 << (c >> 2);
  const idx = [], vals = [];
  for (let i = 0; i < NUM_COMBOS; i++) {
    if (blocks(i, blo, bhi)) continue;
    const [a, b] = COMBO[i];
    const s = [bs[0], bs[1], bs[2], bs[3]];
    s[a & 3] |= 1 << (a >> 2);
    s[b & 3] |= 1 << (b >> 2);
    idx.push(i);
    vals.push(evalSuits(s[0], s[1], s[2], s[3]));
  }
  const order = Array.from(idx, (_, k) => k).sort((x, y) => vals[x] - vals[y] || x - y);
  const left = 52 - board.length - 2;
  const compatible = (left * (left - 1)) / 2;
  const out = new Float64Array(NUM_COMBOS).fill(-1);
  let below = 0;
  const belowCard = new Float64Array(52);
  let g = 0;
  while (g < order.length) {
    const v = vals[order[g]];
    let e = g;
    while (e < order.length && vals[order[e]] === v) e++;
    const eqCard = new Float64Array(52);
    for (let k = g; k < e; k++) { const [a, b] = COMBO[idx[order[k]]]; eqCard[a] += 1; eqCard[b] += 1; }
    const size = e - g;
    for (let k = g; k < e; k++) {
      const [a, b] = COMBO[idx[order[k]]];
      const lt = below - belowCard[a] - belowCard[b];
      const eq = size - eqCard[a] - eqCard[b] + 1;
      out[idx[order[k]]] = (lt + 0.5 * eq) / compatible;
    }
    below += size;
    for (let c = 0; c < 52; c++) belowCard[c] += eqCard[c];
    g = e;
  }
  return out;
}

/** Strength of every combo on a board of 0, 3, 4 or 5 cards; -1 when blocked. */
export function boardStrengths(board) {
  if (board.length === 0) return preflopStrengths();
  if (board.length === 5) return showdownShares(board);
  const used = new Set(board);
  const rest = [];
  for (let c = 0; c < 52; c++) if (!used.has(c)) rest.push(c);
  const acc = new Float64Array(NUM_COMBOS), cnt = new Float64Array(NUM_COMBOS);
  const add = (extra) => {
    const s = showdownShares([...board, ...extra]);
    for (let i = 0; i < NUM_COMBOS; i++) if (s[i] >= 0) { acc[i] += s[i]; cnt[i] += 1; }
  };
  if (board.length === 4) for (const c of rest) add([c]);
  else for (let i = 0; i < rest.length; i++) for (let j = i + 1; j < rest.length; j++) add([rest[i], rest[j]]);
  return Float64Array.from({ length: NUM_COMBOS }, (_, i) => (cnt[i] > 0 ? acc[i] / cnt[i] : -1));
}

// ---------------------------------------------------------------- threshold strategy

export function bands(context, f) {
  if (context.startsWith('preflop')) return [[0, f[0]], [1, f[1]], [2, f[2]]];
  const spot = context.slice(context.indexOf('_') + 1);
  if (spot === 'cbet' || spot === 'lead' || spot === 'stab') return [[0, f[0]], [2, f[2] * BET_BLUFF], [1, f[1]], [2, f[2] * (1.0 - BET_BLUFF)]];
  return [[2, f[2] * RAISE_BLUFF], [0, f[0]], [1, f[1]], [2, f[2] * (1.0 - RAISE_BLUFF)]];
}

/** Consecutive bands by strength (weakest first); equal strengths are treated alike. Returns [3] per combo. */
export function bandStrategy(weights, strength, bandList) {
  const out = Array.from({ length: NUM_COMBOS }, () => [0, 0, 0]);
  const order = [];
  for (let i = 0; i < NUM_COMBOS; i++) if (weights[i] > 0) order.push(i);
  order.sort((a, b) => strength[a] - strength[b] || a - b);
  let total = 0;
  for (const i of order) total += weights[i];
  if (total <= 0) return out;
  const bounds = [];
  let acc = 0;
  bandList.forEach(([, s], k) => { acc += s * total; bounds.push(k + 1 === bandList.length ? total : acc); });
  let lo = 0, g = 0;
  while (g < order.length) {
    const s = strength[order[g]];
    let e = g, w = 0;
    while (e < order.length && strength[order[e]] === s) { w += weights[order[e]]; e++; }
    const hi = lo + w;
    const sigma = [0, 0, 0];
    let bLo = 0;
    bandList.forEach(([cat], k) => {
      const bHi = bounds[k];
      const overlap = Math.max(Math.min(hi, bHi) - Math.max(lo, bLo), 0);
      sigma[cat] += overlap / w;
      bLo = bHi;
    });
    for (let k = g; k < e; k++) out[order[k]] = sigma;
    lo = hi;
    g = e;
  }
  return out;
}

// ---------------------------------------------------------------- reconstruction

const holeOf = (hand, seat) => {
  const p = hand.players.find((x) => x.seat === seat);
  let cards = p && p.hole && p.hole.length ? p.hole : null;
  if (!cards) { const s = hand.shown.find((x) => x.seat === seat); cards = s && s.cards.length ? s.cards : null; }
  if (!cards) return null;
  try { const c = parseCards(cards.join('')); return c.length === 2 && c[0] !== c[1] ? comboIndex(c[0], c[1]) : null; } catch (e) { return null; }
};
const boardCards = (hand, i) => { try { return parseCards((hand.boards[i] || []).join('')); } catch (e) { return []; } };

function summarise(hand, seat, probs, blo, bhi) {
  const grid = new Array(169).fill(0), gridCombos = new Array(169).fill(0);
  let entropy = 0, possible = 0;
  for (let i = 0; i < NUM_COMBOS; i++) {
    if (blocks(i, blo, bhi)) continue;
    possible++;
    const c = classOf(COMBO[i][0], COMBO[i][1]);
    gridCombos[c]++;
    grid[c] += probs[i];
    if (probs[i] > 0) entropy -= probs[i] * Math.log(probs[i]);
  }
  const ranked = [];
  for (let i = 0; i < NUM_COMBOS; i++) if (probs[i] > 0) ranked.push(i);
  ranked.sort((a, b) => probs[b] - probs[a] || a - b);
  const top = ranked.slice(0, 10).map((i) => [cardsStr([COMBO[i][0], COMBO[i][1]]), probs[i]]);
  const ci = holeOf(hand, seat);
  let actual = null;
  if (ci !== null && !blocks(ci, blo, bhi)) {
    const p = probs[ci];
    let above = 0, equal = 0;
    for (let i = 0; i < NUM_COMBOS; i++) { const q = probs[i]; if (q > p) above += q; else if (q === p) equal += q; }
    actual = { cards: cardsStr([COMBO[ci][0], COMBO[ci][1]]), prob: p, bits: Math.log2(Math.max(p, 1e-300) * possible), hpd_quantile: above + 0.5 * equal };
  }
  const pl = hand.players.find((x) => x.seat === seat) || {};
  return { seat, name: pl.name || '', position: pl.position || '', probs: Float64Array.from(probs), grid, grid_combos: gridCombos, effective_combos: Math.exp(entropy), possible_combos: possible, top, actual };
}

function normalise(w) {
  let t = 0;
  for (let i = 0; i < w.length; i++) t += w[i];
  if (t > 0) for (let i = 0; i < w.length; i++) w[i] /= t;
}

/** Strength vectors for each street of the hand that has actions. */
export function streetStrengths(hand) {
  const b0 = boardCards(hand, 0);
  return hand.streets.map((st) => boardStrengths(b0.slice(0, Math.min(BOARD_LEN[st.name], b0.length))));
}

/** Every player's range street by street (hold'em only). */
export function reconstructRanges(hand, table, opts = DEFAULT_RANGE_OPTIONS, strengths = null) {
  if (!isHoldem(hand)) throw new Error(`hand ${hand.id}: ranges are reconstructed for hold'em only (game ${hand.game})`);
  const str = strengths || streetStrengths(hand);
  const dealt = [...new Set(hand.players.filter((p) => !p.sitting_out).map((p) => p.seat))].sort((a, b) => a - b);
  const w = new Map(dealt.map((s) => [s, new Float64Array(NUM_COMBOS).fill(1.0 / NUM_COMBOS)]));
  const folded = new Set();
  const ds = decisions(hand);
  const board0 = boardCards(hand, 0);
  const board1 = hand.board_kind === 'double' ? boardCards(hand, 1) : [];
  const visible = (len) => {
    const b = board0.slice(0, len);
    const [lo0, hi0] = maskOf(b), [lo1, hi1] = maskOf(board1.slice(0, len));
    return [b, lo0 | lo1, hi0 | hi1];
  };
  const removeBlocked = (lo, hi) => {
    for (const v of w.values()) {
      for (let i = 0; i < NUM_COMBOS; i++) if (blocks(i, lo, hi)) v[i] = 0;
      normalise(v);
    }
  };
  const nameOf = (seat) => (hand.players.find((p) => p.seat === seat) || {}).name || '';
  const snapshots = [], notes = [];
  let di = 0, lastLen = 0;
  hand.streets.forEach((st, si) => {
    const len = Math.min(BOARD_LEN[st.name], board0.length);
    const [board, lo, hi] = visible(len);
    lastLen = len;
    removeBlocked(lo, hi);
    const strength = str[si];
    snapshots.push({ label: st.name, board: cardsStr(board), seats: dealt.filter((s) => !folded.has(s)).map((s) => summarise(hand, s, w.get(s), lo, hi)) });
    while (di < ds.length && ds[di].street === st.name) {
      const d = ds[di++];
      const f = table.estimate(nameOf(d.seat), d.context, d.available, opts);
      const sigma = bandStrategy(w.get(d.seat), strength, bands(d.context, f));
      const k = d.available.filter(Boolean).length;
      const informed = 1.0 - opts.noise - opts.tremble, noise = opts.noise * f[d.category], tremble = opts.tremble / k;
      const likelihood = (i) => informed * sigma[i][d.category] + noise + tremble;
      const ci = holeOf(hand, d.seat);
      const v = w.get(d.seat);
      for (let i = 0; i < NUM_COMBOS; i++) if (v[i] > 0) v[i] *= likelihood(i);
      normalise(v);
      notes.push({ index: d.index, street: d.street, seat: d.seat, action: d.action, context: d.context, frequencies: f, likelihood_actual: ci === null ? null : likelihood(ci) });
      if (d.action === 'fold') folded.add(d.seat);
    }
  });
  const endLen = dealt.length - folded.size >= 2 ? board0.length : lastLen;
  const [board, lo, hi] = visible(endLen);
  removeBlocked(lo, hi);
  snapshots.push({ label: 'end', board: cardsStr(board), seats: dealt.filter((s) => !folded.has(s)).map((s) => summarise(hand, s, w.get(s), lo, hi)) });
  return { id: hand.id, snapshots, actions: notes };
}

export { STREETS };
