// Equity in the browser (port of pe-equity): exact enumeration when the number
// of runouts is small enough, otherwise seeded Monte Carlo with standard errors.
// Any number of players, one or two boards, high or hi-lo games; exact
// run-it-twice statistics for flop and turn all-ins.

import { deckCards, rankOf, suitOf, rng as makeRng } from './cards.js';
import { evalSuits } from './eval.js';

const choose = (n, k) => { if (k < 0 || k > n) return 0; let r = 1; for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1); return Math.round(r); };

function prepHand(cards) {
  const s = [0, 0, 0, 0];
  for (const c of cards) s[suitOf(c)] |= 1 << rankOf(c);
  const pairs = [];
  for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) {
    const p = [0, 0, 0, 0];
    p[suitOf(cards[i])] |= 1 << rankOf(cards[i]);
    p[suitOf(cards[j])] |= 1 << rankOf(cards[j]);
    pairs.push(p);
  }
  return { cards, s, pairs, low: lowRanks(cards) };
}
const lowBit = (c) => { const r = rankOf(c); return r === 12 ? 0 : r <= 6 ? r + 1 : -1; };
function lowRanks(cards) { let m = 0; for (const c of cards) { const b = lowBit(c); if (b >= 0) m |= 1 << b; } return m; }
function popcount(x) { let n = 0; while (x) { x &= x - 1; n++; } return n; }
function lowestBits(m, k) {
  if (popcount(m) < k) return -1;
  let out = 0, rest = m;
  for (let i = 0; i < k; i++) { const b = rest & -rest; out |= b; rest &= rest - 1; }
  return out;
}

function prepBoard(cards) {
  const s = [0, 0, 0, 0];
  for (const c of cards) s[suitOf(c)] |= 1 << rankOf(c);
  const triples = [];
  for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) for (let k = j + 1; k < cards.length; k++) {
    const t = [0, 0, 0, 0];
    for (const c of [cards[i], cards[j], cards[k]]) t[suitOf(c)] |= 1 << rankOf(c);
    triples.push(t);
  }
  return { s, triples, low: lowRanks(cards) };
}

function highValue(game, h, b) {
  if (!game.omaha) return evalSuits(h.s[0] | b.s[0], h.s[1] | b.s[1], h.s[2] | b.s[2], h.s[3] | b.s[3], game.rules);
  let best = 0;
  for (const t of b.triples) for (const p of h.pairs) {
    const v = evalSuits(p[0] | t[0], p[1] | t[1], p[2] | t[2], p[3] | t[3], game.rules);
    if (v > best) best = v;
  }
  return best;
}
function lowValue(game, h, b) {
  if (!game.hilo || popcount(b.low) < 3) return 0;
  if (!game.omaha) { const l = lowestBits(h.low | b.low, 5); return l < 0 ? 0 : 256 - l; }
  let best = Infinity;
  const bits = [];
  for (let x = 0; x < 8; x++) if (h.low & (1 << x)) bits.push(x);
  for (let i = 0; i < bits.length; i++) for (let j = i + 1; j < bits.length; j++) {
    const pair = (1 << bits[i]) | (1 << bits[j]);
    const t = lowestBits(b.low & ~pair, 3);
    if (t >= 0 && (pair | t) < best) best = pair | t;
  }
  return best === Infinity ? 0 : 256 - best;
}

/** Adds each player's pot share for one complete deal into `out` (ties split, hi-lo halves, boards split). */
function addShares(game, hands, boards, out) {
  const per = 1 / boards.length;
  for (const b of boards) {
    let bestHi = 0;
    const hv = hands.map((h) => { const v = highValue(game, h, b); if (v > bestHi) bestHi = v; return v; });
    let hiPart = per;
    if (game.hilo) {
      let bestLo = 0;
      const lv = hands.map((h) => { const v = lowValue(game, h, b); if (v > bestLo) bestLo = v; return v; });
      if (bestLo > 0) {
        hiPart = per / 2;
        const nl = lv.filter((v) => v === bestLo).length;
        lv.forEach((v, i) => { if (v === bestLo) out[i] += hiPart / nl; });
      }
    }
    const nh = hv.filter((v) => v === bestHi).length;
    hv.forEach((v, i) => { if (v === bestHi) out[i] += hiPart / nh; });
  }
}

function validate(game, hands, boards, dead) {
  if (hands.length < 2 || hands.length > 10) throw new Error('need 2 to 10 hands');
  if (!boards.length || boards.length > 2) throw new Error('one or two boards');
  const deck = new Set(deckCards(game));
  const used = new Set();
  const add = (c) => {
    if (!deck.has(c)) throw new Error(`a card is not in the ${game.code} deck`);
    if (used.has(c)) throw new Error('a card is used twice');
    used.add(c);
  };
  for (const h of hands) { if (h.length !== game.hole) throw new Error(`${game.code} needs ${game.hole} hole cards per hand`); h.forEach(add); }
  for (const b of boards) { if (b.length > 5) throw new Error('a board has at most five cards'); b.forEach(add); }
  dead.forEach(add);
  return deckCards(game).filter((c) => !used.has(c));
}

/** Number of runouts an exact computation would enumerate. */
export function runoutCount(game, hands, boards, dead = []) {
  const left = validate(game, hands, boards, dead).length;
  const need = boards.map((b) => 5 - b.length);
  return need.length === 1 ? choose(left, need[0]) : choose(left, need[0]) * choose(left - need[0], need[1]);
}

export function equityExact(game, hands, boards, dead = []) {
  const remaining = validate(game, hands, boards, dead);
  const ph = hands.map(prepHand);
  const need = boards.map((b) => 5 - b.length);
  const sums = new Array(hands.length).fill(0);
  let count = 0;
  const sub = (arr, k, start, prefix, f) => {
    if (prefix.length === k) { f(prefix); return; }
    for (let i = start; i <= arr.length - (k - prefix.length); i++) { prefix.push(arr[i]); sub(arr, k, i + 1, prefix, f); prefix.pop(); }
  };
  sub(remaining, need[0], 0, [], (r0) => {
    const b0 = prepBoard([...boards[0], ...r0]);
    if (boards.length === 1) { addShares(game, ph, [b0], sums); count++; return; }
    const rest = remaining.filter((c) => !r0.includes(c));
    sub(rest, need[1], 0, [], (r1) => { addShares(game, ph, [b0, prepBoard([...boards[1], ...r1])], sums); count++; });
  });
  return { equity: sums.map((s) => s / count), stdError: sums.map(() => 0), runouts: count, exact: true };
}

export function equityMonteCarlo(game, hands, boards, dead = [], samples = 100000, seed = 1) {
  const remaining = validate(game, hands, boards, dead);
  const ph = hands.map(prepHand);
  const need = boards.map((b) => 5 - b.length);
  const r = makeRng(seed);
  const n = hands.length, sum = new Array(n).fill(0), sq = new Array(n).fill(0), one = new Array(n);
  const deck = remaining.slice();
  const total = need.reduce((a, b) => a + b, 0);
  for (let s = 0; s < samples; s++) {
    for (let i = 0; i < total; i++) { const j = i + r.below(deck.length - i); const t = deck[i]; deck[i] = deck[j]; deck[j] = t; }
    let pos = 0;
    const pb = boards.map((b, k) => { const cards = [...b, ...deck.slice(pos, pos + need[k])]; pos += need[k]; return prepBoard(cards); });
    one.fill(0);
    addShares(game, ph, pb, one);
    for (let i = 0; i < n; i++) { sum[i] += one[i]; sq[i] += one[i] * one[i]; }
  }
  const equity = sum.map((x) => x / samples);
  const stdError = equity.map((e, i) => Math.sqrt(Math.max(sq[i] / samples - e * e, 0) / samples));
  return { equity, stdError, runouts: samples, exact: false };
}

/** Exact when the runout count is at most `exactLimit`, Monte Carlo otherwise. */
export function equityAuto(game, hands, boards, dead = [], { exactLimit = 400000, samples = 200000, seed = 1 } = {}) {
  const runs = runoutCount(game, hands, boards, dead);
  const limit = game.omaha ? exactLimit / 30 : exactLimit;
  return runs <= limit ? equityExact(game, hands, boards, dead) : equityMonteCarlo(game, hands, boards, dead, samples, seed);
}

/** Monte Carlo equity of weighted ranges ({hands, weights}), with exact card removal by rejection. */
export function rangeEquityMonteCarlo(game, ranges, boards, dead = [], samples = 50000, seed = 1) {
  const fixed = new Set([...boards.flat(), ...dead]);
  const lists = ranges.map((r) => {
    const hs = [], ws = [];
    r.hands.forEach((h, i) => { if (!h.some((c) => fixed.has(c)) && r.weights[i] > 0) { hs.push(h); ws.push(r.weights[i]); } });
    if (!hs.length) throw new Error('a range is empty after removing the board');
    let acc = 0;
    return { hands: hs.map(prepHand), cum: ws.map((w) => (acc += w)), raw: hs };
  });
  const deckAll = deckCards(game).filter((c) => !fixed.has(c));
  const need = boards.map((b) => 5 - b.length);
  const r = makeRng(seed);
  const n = lists.length, sum = new Array(n).fill(0), sq = new Array(n).fill(0), one = new Array(n);
  let done = 0, rejected = 0;
  while (done < samples) {
    const picks = [], used = new Set();
    let ok = true;
    for (const l of lists) {
      const x = r.float() * l.cum[l.cum.length - 1];
      let lo = 0, hi = l.cum.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (l.cum[mid] <= x) lo = mid + 1; else hi = mid; }
      const h = l.raw[lo];
      if (h.some((c) => used.has(c))) { ok = false; break; }
      h.forEach((c) => used.add(c));
      picks.push(l.hands[lo]);
    }
    if (!ok) { if (++rejected > 1000 + 1000 * (done + 1)) break; continue; }
    const deck = deckAll.filter((c) => !used.has(c));
    const total = need.reduce((a, b) => a + b, 0);
    for (let i = 0; i < total; i++) { const j = i + r.below(deck.length - i); const t = deck[i]; deck[i] = deck[j]; deck[j] = t; }
    let pos = 0;
    const pb = boards.map((b, k) => { const cards = [...b, ...deck.slice(pos, pos + need[k])]; pos += need[k]; return prepBoard(cards); });
    one.fill(0);
    addShares(game, picks, pb, one);
    for (let i = 0; i < n; i++) { sum[i] += one[i]; sq[i] += one[i] * one[i]; }
    done++;
  }
  if (!done) throw new Error('the ranges are incompatible');
  const equity = sum.map((x) => x / done);
  return { equity, stdError: equity.map((e, i) => Math.sqrt(Math.max(sq[i] / done - e * e, 0) / done)), runouts: done, exact: false };
}

/** Exact run-it-twice statistics for a turn or flop all-in (one or two cards to come). */
export function runItTwice(game, hands, board, dead = []) {
  const remaining = validate(game, hands, [board], dead);
  const k = 5 - board.length;
  if (k < 1 || k > 2) throw new Error('exact run-it-twice statistics are computed in the browser for flop and turn all-ins');
  const ph = hands.map(prepHand), p = hands.length, N = remaining.length;
  const runs = [];
  if (k === 1) for (let i = 0; i < N; i++) runs.push([i]);
  else for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) runs.push([i, j]);
  const shares = runs.map((r) => { const o = new Array(p).fill(0); addShares(game, ph, [prepBoard([...board, ...r.map((x) => remaining[x])])], o); return o; });
  const total = new Array(p).fill(0), A = Array.from({ length: N }, () => new Array(p).fill(0));
  runs.forEach((r, ri) => { for (let i = 0; i < p; i++) { total[i] += shares[ri][i]; for (const c of r) A[c][i] += shares[ri][i]; } });
  const nr = runs.length, n2 = k === 1 ? N - 1 : choose(N - 2, 2);
  const out = { equity: [], sdOnce: [], sdTwice: [], corrRuns: [], runouts: nr };
  for (let i = 0; i < p; i++) {
    let sq = 0, cross = 0;
    runs.forEach((r, ri) => {
      const s = shares[ri][i];
      // sum over disjoint second runs: total - runs touching r (+ r itself, counted twice for k = 2)
      const inner = k === 1 ? total[i] - s : total[i] - A[r[0]][i] - A[r[1]][i] + s;
      sq += s * s; cross += s * inner;
    });
    const mu = total[i] / nr, e2 = sq / nr, e12 = cross / (nr * n2);
    const v1 = Math.max(e2 - mu * mu, 0), v2 = Math.max((e2 + e12) / 2 - mu * mu, 0);
    out.equity.push(mu); out.sdOnce.push(Math.sqrt(v1)); out.sdTwice.push(Math.sqrt(v2)); out.corrRuns.push(v1 > 0 ? (e12 - mu * mu) / v1 : 0);
  }
  return out;
}
