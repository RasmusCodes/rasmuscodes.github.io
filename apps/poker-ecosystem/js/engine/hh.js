// PokerStars hand histories in the browser: a port of pe-hh's parser,
// pot reconstruction and all-in equity. Produces the same pe-hh/1 objects
// (amounts in thousandths) as the Rust parser.

import { parseCard, parseCards, gameOf } from './cards.js';
import { evalHand, describe } from './eval.js';
import { equityAuto } from './equity.js';

export function parseAmount(s) {
  const t = String(s).trim().replace(/[$€£,\s]/g, '').replace(/[A-Za-z]+$/, '');
  if (!/^-?\d*(\.\d*)?$/.test(t) || t === '' || t === '-') return null;
  const neg = t.startsWith('-');
  const [i, f = ''] = (neg ? t.slice(1) : t).split('.');
  const v = (i ? parseInt(i, 10) : 0) * 1000 + parseInt((f + '000').slice(0, 3), 10);
  return neg ? -v : v;
}

const POS = [[], ['CO'], ['HJ', 'CO'], ['UTG', 'HJ', 'CO'], ['UTG', 'LJ', 'HJ', 'CO'], ['UTG', 'UTG1', 'LJ', 'HJ', 'CO'], ['UTG', 'UTG1', 'UTG2', 'LJ', 'HJ', 'CO'], ['UTG', 'UTG1', 'UTG2', 'UTG3', 'LJ', 'HJ', 'CO']];
export function positionLabels(n) {
  if (n === 0) return [];
  if (n === 1) return ['BTN'];
  if (n === 2) return ['BTN', 'BB'];
  return ['BTN', 'SB', 'BB', ...(POS[n - 3] || POS[7])];
}
/** Dealt seats clockwise from the button (a dead button counts as the last dealt seat before it). */
export function clockwiseFromButton(hand) {
  const seats = [...new Set(hand.players.filter((p) => !p.sitting_out).map((p) => p.seat))].sort((a, b) => a - b);
  if (!seats.length) return seats;
  const btn = seats.filter((s) => s <= hand.button).pop() ?? seats[seats.length - 1];
  const i = seats.indexOf(btn);
  return [...seats.slice(i), ...seats.slice(0, i)];
}
/** Seat -> position label. */
export function seatPositions(hand) {
  const order = clockwiseFromButton(hand);
  const labels = positionLabels(order.length);
  return new Map(order.map((s, k) => [s, labels[k]]));
}
function assignPositions(hand) {
  const map = seatPositions(hand);
  for (const p of hand.players) p.position = p.sitting_out ? null : map.get(p.seat);
}
/**
 * Straddles are written alike; the seat decides. The seat after the previous live blind (big blind,
 * then under the gun for a re-straddle) posts an ordinary straddle, any other seat (usually the
 * button) a Mississippi straddle, which acts last before the flop.
 */
export function classifyStraddles(hand) {
  const order = clockwiseFromButton(hand);
  const bb = hand.posts.find((p) => p.kind === 'bb');
  if (!bb || !order.length) return;
  let prev = order.indexOf(bb.seat);
  if (prev < 0) return;
  for (const p of hand.posts) {
    if (p.kind !== 'straddle' && p.kind !== 'mississippi') continue;
    const next = (prev + 1) % order.length;
    if (order[next] === p.seat) { p.kind = 'straddle'; prev = next; } else p.kind = 'mississippi';
  }
}

function brackets(line) {
  const out = [];
  for (const m of line.matchAll(/\[([^\]]*)\]/g)) {
    const cards = m[1].trim().split(/\s+/).filter(Boolean);
    try { if (cards.length && cards.every((c) => parseCard(c) >= 0)) out.push(cards.map((c) => { const x = parseCard(c); return '23456789TJQKA'[x >> 2] + 'cdhs'[x & 3]; })); } catch (e) { /* not cards */ }
  }
  return out;
}

function header(line, hand) {
  hand.site = 'PokerStars';
  hand.id = (/Hand #(\d+)/.exec(line) || [])[1] || '';
  const lower = line.toLowerCase();
  const tournament = lower.includes('tournament #');
  hand.game = lower.includes('5 card omaha') ? 'PLO5' : lower.includes('omaha hi/lo') ? 'O8' : lower.includes('omaha') ? 'PLO' : lower.includes("6+ hold'em") ? 'SD' : 'NLH';
  hand.limit = lower.includes('no limit') ? 'NL' : lower.includes('pot limit') ? 'PL' : 'FL';
  hand.bomb_pot = lower.includes('[bomb pot]');
  if (lower.includes('[double board]')) hand.board_kind = 'double';
  const groups = [...line.matchAll(/\(([^)]*\/[^)]*)\)/g)];
  if (groups.length) {
    const s = groups[groups.length - 1][1];
    const [a, b] = s.split('/');
    hand.sb = parseAmount(a) ?? 0;
    hand.bb = parseAmount((b || '').trim().split(/\s+/)[0]) ?? 0;
    hand.currency = tournament ? 'chips' : /€|EUR/.test(s) ? 'EUR' : /£|GBP/.test(s) ? 'GBP' : /\$|USD/.test(s) ? 'USD' : 'chips';
  }
  const dash = line.lastIndexOf(' - ');
  if (dash >= 0) hand.time = line.slice(dash + 3).trim();
}

function newHand() {
  return { schema: 'pe-hh/1', id: '', site: '', game: 'NLH', limit: 'NL', currency: 'chips', time: '', table: '', max_seats: 0, button: 0, sb: 0, bb: 0, ante: 0, bomb_pot: false, board_kind: 'single', players: [], posts: [], streets: [], boards: [], shown: [], collected: [], uncalled: [], total_pot: 0, rake: 0, synthetic: false };
}

function parseBlock(lines, warnings) {
  const hand = newHand();
  header(lines[0], hand);
  const ctx = { street: hand.bomb_pot ? null : 'preflop', contrib: new Map(), boards: [[], []], run: [[], []], summary: false, sdBoard: null, runTwice: false };
  const names = [];
  const nameAt = (l, sep) => {
    let best = null;
    for (const [n, seat] of names) if (l.startsWith(n) && l.slice(n.length).startsWith(sep) && (!best || n.length > best[0].length)) best = [n, seat];
    return best;
  };
  const addShown = (seat, cards) => { if (cards && cards.length && !hand.shown.some((s) => s.seat === seat)) hand.shown.push({ seat, cards, description: '' }); };
  const push = (seat, type, amount, allIn) => {
    const street = ctx.street || 'preflop';
    const c = (ctx.contrib.get(seat) || 0) + amount;
    ctx.contrib.set(seat, c);
    if (!hand.streets.length || hand.streets[hand.streets.length - 1].name !== street) hand.streets.push({ name: street, actions: [] });
    hand.streets[hand.streets.length - 1].actions.push({ seat, type, amount, to: c, all_in: allIn });
  };
  for (const raw of lines.slice(1)) {
    const l = raw.trim();
    if (l.startsWith("Table '")) {
      const m = /Table '(.*)'/.exec(l); if (m) hand.table = m[1];
      const mx = /(\d+)-max/.exec(l); if (mx) hand.max_seats = +mx[1];
      const b = /Seat #(\d+)/.exec(l); if (b) hand.button = +b[1];
      continue;
    }
    const seat = !ctx.summary && /^Seat (\d+): (.*) \(([^)]*) in chips[^)]*\)(.*)$/.exec(l);
    if (seat) {
      hand.players.push({ seat: +seat[1], name: seat[2], stack: parseAmount(seat[3]) ?? 0, position: null, hole: null, hero: false, sitting_out: /sitting out|out of hand/.test(seat[4]) });
      names.push([seat[2], +seat[1]]);
      continue;
    }
    if (l.startsWith('*** ')) {
      const name = l.slice(4).split(' ***')[0].trim();
      const cards = brackets(l).flat();
      if (name === 'HOLE CARDS') ctx.street = 'preflop';
      else if (['FLOP', 'TURN', 'RIVER'].includes(name)) {
        ctx.street = name.toLowerCase(); ctx.contrib.clear(); ctx.boards[0] = cards;
        if (!hand.streets.length || hand.streets[hand.streets.length - 1].name !== ctx.street) hand.streets.push({ name: ctx.street, actions: [] });
      } else if (/^(FLOP|TURN|RIVER) 2$/.test(name)) ctx.boards[1] = cards;
      else if (/^FIRST (FLOP|TURN|RIVER)$/.test(name)) { ctx.runTwice = true; ctx.run[0] = cards; }
      else if (/^SECOND (FLOP|TURN|RIVER)$/.test(name)) { ctx.runTwice = true; ctx.run[1] = cards; }
      else if (name === 'SHOW DOWN') ctx.sdBoard = null;
      else if (name === 'FIRST SHOW DOWN') ctx.sdBoard = 1;
      else if (name === 'SECOND SHOW DOWN') ctx.sdBoard = 2;
      else if (name === 'SUMMARY') ctx.summary = true;
      else warnings.push(`hand ${hand.id}: unknown section '${name}'`);
      continue;
    }
    if (ctx.summary) {
      if (l.startsWith('Total pot ')) {
        hand.total_pot = parseAmount(l.slice(10).split(/\s+/)[0]) ?? 0;
        const r = /Rake (\S+)/.exec(l); if (r) hand.rake = parseAmount(r[1]) ?? 0;
      } else if (l.startsWith('Hand was run twice')) ctx.runTwice = true;
      else if (/^(FIRST |SECOND )?Board/.test(l)) {
        const cards = brackets(l).flat();
        if (l.startsWith('FIRST')) { if (ctx.run[0].length < cards.length) ctx.run[0] = cards; }
        else if (l.startsWith('SECOND')) { if (ctx.run[1].length < cards.length) ctx.run[1] = cards; }
        else if (l.startsWith('Board 2')) { if (ctx.boards[1].length < cards.length) ctx.boards[1] = cards; }
        else if (ctx.boards[0].length < cards.length) ctx.boards[0] = cards;
      } else if (l.startsWith('Seat ')) {
        const body = l.slice(l.indexOf(': ') + 2);
        const who = nameAt(body, ' ') || names.find(([n]) => body.startsWith(n));
        if (who && /(showed|mucked) \[/.test(body)) addShown(who[1], brackets(body)[0]);
      }
      continue;
    }
    if (l.startsWith('Dealt to ')) {
      const rest = l.slice(9);
      const who = nameAt(rest, ' ') || names.find(([n]) => rest === n);
      if (who) {
        const g = brackets(rest.slice(who[0].length));
        const p = hand.players.find((x) => x.seat === who[1]);
        if (p && g.length) { p.hole = g[g.length - 1]; p.hero = true; }
      }
      continue;
    }
    const unc = /^Uncalled bet \(([^)]*)\) returned to (.*)$/.exec(l);
    if (unc) {
      const who = names.find(([n]) => n === unc[2].trim());
      if (who) {
        const amount = parseAmount(unc[1]) ?? 0;
        hand.uncalled.push({ seat: who[1], amount });
        if (ctx.contrib.has(who[1])) ctx.contrib.set(who[1], ctx.contrib.get(who[1]) - amount);
      }
      continue;
    }
    const act = nameAt(l, ': ');
    if (act) {
      const s = act[1];
      const rest = l.slice(act[0].length + 2);
      const allIn = rest.includes('and is all-in');
      const r = rest.replace(' and is all-in', '').trim();
      const w = r.split(/\s+/);
      if (w[0] === 'folds') { push(s, 'fold', 0, allIn); addShown(s, brackets(r)[0]); }
      else if (w[0] === 'checks') push(s, 'check', 0, allIn);
      else if (w[0] === 'calls') push(s, 'call', parseAmount(w[1]) ?? 0, allIn);
      else if (w[0] === 'bets') push(s, 'bet', parseAmount(w[1]) ?? 0, allIn);
      else if (w[0] === 'raises') {
        const to = parseAmount(w[w.indexOf('to') + 1]);
        if (to === null) warnings.push(`hand ${hand.id}: unreadable raise '${r}'`);
        else push(s, 'raise', to - (ctx.contrib.get(s) || 0), allIn);
      } else if (w[0] === 'posts') {
        const amount = parseAmount(w[w.length - 1]) ?? 0;
        const low = r.toLowerCase();
        let kind, live = amount;
        if (low.includes('small & big blinds')) { const dead = Math.max(amount - hand.bb, 0); if (dead > 0) hand.posts.push({ seat: s, kind: 'dead', amount: dead }); kind = 'bb'; live = amount - dead; }
        else if (low.includes('small blind')) kind = 'sb';
        else if (low.includes('big blind')) kind = 'bb';
        else if (low.includes('bomb pot')) kind = 'bomb';
        else if (low.includes('ante')) kind = 'ante';
        else if (low.includes('straddle')) kind = 'straddle';
        else if (low.includes('dead')) kind = 'dead';
        else { warnings.push(`hand ${hand.id}: unknown post '${r}'`); continue; }
        hand.posts.push({ seat: s, kind, amount: live });
        if (['sb', 'bb', 'straddle', 'mississippi'].includes(kind)) ctx.contrib.set(s, (ctx.contrib.get(s) || 0) + live);
        if (kind === 'ante' && !hand.ante) hand.ante = amount;
      } else if (w[0] === 'shows') addShown(s, brackets(r)[0]);
      continue;
    }
    const lead = nameAt(l, ' ');
    if (lead) {
      const rest = l.slice(lead[0].length).trim();
      if (rest.startsWith('collected ')) {
        const after = rest.slice(10);
        const side = /side pot-(\d+)/.exec(after);
        hand.collected.push({ seat: lead[1], amount: parseAmount(after.split(/\s+/)[0]) ?? 0, pot: side ? +side[1] : after.includes('side pot') ? 1 : 0, board: ctx.sdBoard });
      } else if (/^(shows|mucks)/.test(rest)) addShown(lead[1], brackets(rest)[0]);
      continue;
    }
    warnings.push(`hand ${hand.id}: skipped '${l.slice(0, 80)}'`);
  }
  hand.streets = hand.streets.filter((s) => s.actions.length);
  if (ctx.runTwice) { hand.board_kind = 'run_twice'; hand.boards = [ctx.run[0], ctx.run[1]]; }
  else if (hand.board_kind === 'double') hand.boards = [ctx.boards[0], ctx.boards[1]];
  else hand.boards = [ctx.boards[0]];
  for (const p of hand.players) if (!p.hole) { const s = hand.shown.find((x) => x.seat === p.seat); if (s) p.hole = s.cards; }
  try {
    const game = gameOf(hand.game);
    const board = hand.boards[0].length === 5 ? parseCards(hand.boards[0].join('')) : null;
    if (board) for (const s of hand.shown) { const c = parseCards(s.cards.join('')); if (c.length === game.hole) s.description = describe(evalHand(game, c, board), game.rules); }
  } catch (e) { /* descriptions are cosmetic */ }
  assignPositions(hand);
  classifyStraddles(hand);
  return hand;
}

/** Parses PokerStars text into pe-hh/1 hands plus warnings. */
export function parsePokerStars(text) {
  const hands = [], warnings = [];
  let block = [];
  const flush = () => { if (block.length) { if (block[0].includes('Hand #')) hands.push(parseBlock(block, warnings)); else warnings.push(`skipped text that is not a hand: '${block[0].slice(0, 60)}'`); } block = []; };
  for (const raw of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.includes('Hand #') && line.includes('PokerStars')) flush();
    if (line.trim()) block.push(line);
  }
  flush();
  return { hands, warnings };
}

export function sidePots(contrib, folded) {
  const levels = [...new Set([...contrib.values()].filter((c) => c > 0))].sort((a, b) => a - b);
  const raw = [];
  let prev = 0;
  for (const lv of levels) {
    let amount = 0;
    for (const c of contrib.values()) amount += Math.min(c, lv) - Math.min(c, prev);
    raw.push({ amount, eligible: [...contrib].filter(([s, c]) => c >= lv && !folded.has(s)).map(([s]) => s).sort((a, b) => a - b) });
    prev = lv;
  }
  const out = [];
  let carry = 0;
  for (const p of raw) {
    if (!p.eligible.length) { carry += p.amount; continue; }
    const amount = p.amount + carry; carry = 0;
    const last = out[out.length - 1];
    if (last && last.eligible.join() === p.eligible.join()) last.amount += amount; else out.push({ amount, eligible: p.eligible });
  }
  if (carry && out.length) out[out.length - 1].amount += carry;
  return out;
}

/** Replays a hand: contributions, pots, the summary check, all-in equity. Adds `derived`. */
export function analyseHand(hand) {
  const issues = [];
  const contrib = new Map(hand.players.filter((p) => !p.sitting_out).map((p) => [p.seat, 0]));
  for (const p of hand.posts) contrib.set(p.seat, (contrib.get(p.seat) || 0) + p.amount);
  for (const s of hand.streets) for (const a of s.actions) contrib.set(a.seat, (contrib.get(a.seat) || 0) + a.amount);
  for (const u of hand.uncalled) contrib.set(u.seat, (contrib.get(u.seat) || 0) - u.amount);
  const folded = new Set(hand.streets.flatMap((s) => s.actions.filter((a) => a.type === 'fold').map((a) => a.seat)));
  const pots = sidePots(contrib, folded);
  const total = [...contrib.values()].reduce((a, b) => a + b, 0);
  if (hand.total_pot && total !== hand.total_pot) issues.push(`contributions add to ${total}, the summary says ${hand.total_pot}`);
  const collected = hand.collected.reduce((a, c) => a + c.amount, 0);
  const stated = hand.total_pot || total;
  if (collected + hand.rake !== stated) issues.push(`collected ${collected} plus rake ${hand.rake} differs from the pot ${stated}`);
  const net = new Map([...contrib].map(([s, c]) => [s, -c]));
  for (const c of hand.collected) net.set(c.seat, (net.get(c.seat) || 0) + c.amount);
  const stillIn = [...contrib.keys()].filter((s) => !folded.has(s));
  const derived = { ok: !issues.length, issues, contrib: Object.fromEntries(contrib), net: Object.fromEntries(net), pots, showdown_seats: stillIn.length >= 2 ? stillIn : [], allin: null };
  // all-in before the river with every remaining hand known
  const last = hand.streets.length ? hand.streets[hand.streets.length - 1].name : hand.bomb_pot ? 'flop' : 'preflop';
  const behind = stillIn.filter((s) => (hand.players.find((p) => p.seat === s)?.stack ?? 0) - (contrib.get(s) || 0) > 0).length;
  const known = stillIn.map((s) => hand.players.find((p) => p.seat === s)?.hole);
  if (stillIn.length >= 2 && last !== 'river' && behind <= 1 && known.every((h) => h && h.length)) {
    try {
      const game = gameOf(hand.game);
      const k = { preflop: 0, flop: 3, turn: 4 }[last];
      const boards = hand.board_kind === 'double' ? hand.boards.map((b) => parseCards(b.slice(0, k).join(''))) : [parseCards((hand.boards[0] || []).slice(0, k).join(''))];
      const cards = new Map(stillIn.map((s, i) => [s, parseCards(known[i].join(''))]));
      const factor = total > 0 ? Math.max(total - hand.rake, 0) / total : 1;
      const expected = new Map(stillIn.map((s) => [s, 0]));
      let mainEquity = {};
      pots.forEach((pot, pi) => {
        const elig = pot.eligible.filter((s) => cards.has(s));
        if (!elig.length) return;
        const eqs = elig.length === 1 ? [1] : equityAuto(game, elig.map((s) => cards.get(s)), boards, [], { samples: 30000, seed: 7 + pi }).equity;
        elig.forEach((s, i) => { expected.set(s, expected.get(s) + eqs[i] * pot.amount * factor); if (pi === 0) mainEquity[s] = eqs[i]; });
      });
      derived.allin = { street: last, seats: stillIn, equity: mainEquity, ev_net: Object.fromEntries([...expected].map(([s, e]) => [s, Math.round(e) - (contrib.get(s) || 0)])) };
    } catch (e) { /* equity needs every card */ }
  }
  hand.derived = derived;
  return hand;
}
