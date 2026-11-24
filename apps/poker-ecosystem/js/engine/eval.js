// Exact hand evaluation: a port of crates/pe-eval with the same value encoding
// (order << 26 | category << 22 | payload), so values compare with the Rust engine.

import { rankOf, suitOf } from './cards.js';

export const CATEGORY_NAMES = ['high card', 'pair', 'two pair', 'three of a kind', 'straight', 'flush', 'full house', 'four of a kind', 'straight flush'];
// category -> order under each rule set
const ORDER = {
  standard: [0, 1, 2, 3, 4, 5, 6, 7, 8],
  triton: [0, 1, 2, 4, 3, 6, 5, 7, 8],
  classic: [0, 1, 2, 3, 4, 6, 5, 7, 8],
};
const POP = new Uint8Array(8192);
for (let i = 1; i < 8192; i++) POP[i] = POP[i >> 1] + (i & 1);
const top = (m) => 31 - Math.clz32(m);
function keepTop(m, k) { while (POP[m] > k) m &= m - 1; return m; }
function straightTop(m, short) {
  const t = m & (m >> 1) & (m >> 2) & (m >> 3) & (m >> 4);
  if (t) return top(t) + 4;
  if (short) { if ((m & 0x10f0) === 0x10f0) return 7; } else if ((m & 0x100f) === 0x100f) return 3;
  return -1;
}
const make = (cat, payload, rules) => ((ORDER[rules][cat] << 26) | (cat << 22) | payload) >>> 0;
export const categoryOf = (v) => (v >>> 22) & 15;

/** Best high hand from four 13-bit suit masks (5-7 cards). */
export function evalSuits(s0, s1, s2, s3, rules = 'standard') {
  const short = rules !== 'standard';
  for (const sm of [s0, s1, s2, s3]) {
    if (POP[sm] >= 5) {
      const t = straightTop(sm, short);
      return t >= 0 ? make(8, t, rules) : make(5, keepTop(sm, 5), rules);
    }
  }
  const any = s0 | s1 | s2 | s3;
  const two = (s0 & s1) | (s2 & s3) | ((s0 | s1) & (s2 | s3));
  const three = (s0 & s1 & (s2 | s3)) | (s2 & s3 & (s0 | s1));
  const four = s0 & s1 & s2 & s3;
  if (four) { const q = top(four); return make(7, (q << 4) | top(any & ~(1 << q)), rules); }
  let trips = -1;
  if (three) {
    const t = top(three), rest = two & ~(1 << t);
    if (rest) return make(6, (t << 4) | top(rest), rules);
    trips = make(3, (t << 13) | keepTop(any & ~(1 << t), 2), rules);
  }
  const st = straightTop(any, short);
  if (st >= 0) { const sv = make(4, st, rules); return trips > sv ? trips : sv; }
  if (trips >= 0) return trips;
  if (two) {
    const p1 = top(two), rest = two & ~(1 << p1);
    if (rest) { const p2 = top(rest); return make(2, (p1 << 8) | (p2 << 4) | top(any & ~(1 << p1) & ~(1 << p2)), rules); }
    return make(1, (p1 << 13) | keepTop(any & ~(1 << p1), 3), rules);
  }
  return make(0, keepTop(any, 5), rules);
}

export function suitMasks(cards) {
  const s = [0, 0, 0, 0];
  for (const c of cards) s[suitOf(c)] |= 1 << rankOf(c);
  return s;
}
export function evalCards(cards, rules = 'standard') {
  const s = suitMasks(cards);
  return evalSuits(s[0], s[1], s[2], s[3], rules);
}

/** Omaha high: exactly two hole cards and three board cards. */
export function evalOmaha(hole, board, rules = 'standard') {
  let best = 0;
  const bs = [];
  for (let i = 0; i < board.length; i++) for (let j = i + 1; j < board.length; j++) for (let k = j + 1; k < board.length; k++) bs.push(suitMasks([board[i], board[j], board[k]]));
  for (let a = 0; a < hole.length; a++) for (let b = a + 1; b < hole.length; b++) {
    const h = suitMasks([hole[a], hole[b]]);
    for (const t of bs) {
      const v = evalSuits(h[0] | t[0], h[1] | t[1], h[2] | t[2], h[3] | t[3], rules);
      if (v > best) best = v;
    }
  }
  return best;
}

// ace-to-five low: bit 0 = ace ... bit 7 = eight
const lowBit = (c) => { const r = rankOf(c); return r === 12 ? 0 : r <= 6 ? r + 1 : -1; };
const lowRanks = (cards) => cards.reduce((m, c) => { const b = lowBit(c); return b >= 0 ? m | (1 << b) : m; }, 0);
function keepLow(m, k) {
  if (POP[m & 0xff] < k) return -1;
  let out = 0, rest = m;
  for (let i = 0; i < k; i++) { const b = rest & -rest; out |= b; rest &= rest - 1; }
  return out;
}
/** Omaha eight-or-better low: 0 when none qualifies, else 256 - mask (bigger is better). */
export function evalOmahaLow(hole, board) {
  const bl = lowRanks(board);
  if (POP[bl] < 3) return 0;
  const hl = lowRanks(hole);
  const bits = [];
  for (let b = 0; b < 8; b++) if (hl & (1 << b)) bits.push(b);
  let best = Infinity;
  for (let i = 0; i < bits.length; i++) for (let j = i + 1; j < bits.length; j++) {
    const pair = (1 << bits[i]) | (1 << bits[j]);
    const t = keepLow(bl & ~pair, 3);
    if (t >= 0 && (pair | t) < best) best = pair | t;
  }
  return best === Infinity ? 0 : 256 - best;
}

export function evalHand(game, hole, board) {
  return game.omaha ? evalOmaha(hole, board, game.rules) : evalCards([...hole, ...board], game.rules);
}
export function evalLow(game, hole, board) {
  if (!game.hilo) return 0;
  if (game.omaha) return evalOmahaLow(hole, board);
  const t = keepLow(lowRanks([...hole, ...board]), 5);
  return t < 0 ? 0 : 256 - t;
}

const NAMES = ['Deuce', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Jack', 'Queen', 'King', 'Ace'];
const PLURALS = ['Deuces', 'Threes', 'Fours', 'Fives', 'Sixes', 'Sevens', 'Eights', 'Nines', 'Tens', 'Jacks', 'Queens', 'Kings', 'Aces'];
/** PokerStars-style description, e.g. "a pair of Queens". */
export function describe(v, rules = 'standard') {
  const p = v & ((1 << 22) - 1), short = rules !== 'standard';
  const low = (t) => (short && t === 7) || (!short && t === 3) ? 12 : t - 4;
  switch (categoryOf(v)) {
    case 0: return `high card ${NAMES[top(p)]}`;
    case 1: return `a pair of ${PLURALS[p >> 13]}`;
    case 2: return `two pair, ${PLURALS[p >> 8]} and ${PLURALS[(p >> 4) & 15]}`;
    case 3: return `three of a kind, ${PLURALS[p >> 13]}`;
    case 4: return `a straight, ${NAMES[low(p)]} to ${NAMES[p]}`;
    case 5: return `a flush, ${NAMES[top(p)]} high`;
    case 6: return `a full house, ${PLURALS[p >> 4]} full of ${PLURALS[p & 15]}`;
    case 7: return `four of a kind, ${PLURALS[p >> 4]}`;
    default: return p === 12 ? 'a Royal Flush' : `a straight flush, ${NAMES[low(p)]} to ${NAMES[p]}`;
  }
}
