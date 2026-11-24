// Spots and public betting trees (port of pe-solver::spot and ::tree).

import { gameOf, parseCards, parseHandList, deckCards, rankOf, suitOf } from './cards.js';

const EPS = 1e-9;

export const DEFAULT_MENU = { bets: [0.33, 0.75], raises: [1.0], max_raises: 2, allin_threshold: 0.67, add_allin: false };

/** Validates a spot configuration (same JSON as the Rust SpotConfig) and prepares it. */
export function prepareSpot(cfg) {
  const game = gameOf(cfg.game);
  const board = parseCards(cfg.board);
  if (board.length < 3 || board.length > 5) throw new Error('the board needs 3 to 5 cards');
  const board2 = cfg.board2 && String(cfg.board2).trim() ? parseCards(cfg.board2) : null;
  if (board2 && board2.length !== board.length) throw new Error('both boards need the same number of cards');
  const dead = new Set(cfg.dead && String(cfg.dead).trim() ? parseCards(cfg.dead) : []);
  const used = new Set([...board, ...(board2 || [])]);
  if (used.size !== board.length + (board2 ? board2.length : 0)) throw new Error('the boards share a card');
  const deck = new Set(deckCards(game));
  for (const c of used) {
    if (!deck.has(c)) throw new Error(`a board card is not in the ${game.code} deck`);
    if (dead.has(c)) throw new Error('a dead card is on the board');
  }
  const n = cfg.ranges.length;
  if (n < 2 || n > 6) throw new Error('2 to 6 players');
  const deadAll = new Set([...used, ...dead]);
  const ranges = cfg.ranges.map((r, i) => {
    const l = parseHandList(game, r, deadAll);
    if (!l.hands.length) throw new Error(`range ${i + 1} is empty on this board`);
    return l;
  });
  const stacks = cfg.stacks.length === 1 ? new Array(n).fill(cfg.stacks[0]) : cfg.stacks.slice();
  if (stacks.length !== n) throw new Error('give one stack or one per player');
  if (!(cfg.pot > 0)) throw new Error('the pot must be positive');
  const is72 = ranges.map((r) => r.hands.map((h) => h.length === 2 && [rankOf(h[0]), rankOf(h[1])].sort((a, b) => a - b).join() === '0,5' && suitOf(h[0]) !== suitOf(h[1])));
  const menu = { ...DEFAULT_MENU, ...(cfg.menu || {}) };
  const bounty = cfg.side_rule && cfg.side_rule.kind === 'seven_deuce' ? cfg.side_rule.amount : 0;
  return { config: cfg, game, board, board2, dead, ranges, pot: cfg.pot, stacks, is72, menu, rake: cfg.rake || null, bounty };
}

export function actionCode(a) {
  switch (a.type) {
    case 'fold': return 'f';
    case 'check': return 'x';
    case 'call': return 'c';
    case 'bet': return 'b' + Math.round(a.size * 100);
    case 'raise': return 'r' + Math.round(a.size * 100);
    default: return 'a';
  }
}
export function actionLabel(a) {
  switch (a.type) {
    case 'fold': return 'Fold';
    case 'check': return 'Check';
    case 'call': return 'Call';
    case 'bet': return `Bet ${Math.round(a.size * 100)}%`;
    case 'raise': return `Raise ${Math.round(a.size * 100)}%`;
    default: return 'All-in';
  }
}

/** Builds the public tree. Nodes: { kind, player, actions, children, cards, showdown, board, contrib, folded, pot, parent, path }. */
export function buildTree(spot, maxNodes = 400000) {
  const n = spot.ranges.length;
  const nodes = [];
  const startPot = spot.pot;
  const menu = spot.menu;
  const fixed = new Set([...spot.board, ...(spot.board2 || []), ...spot.dead]);
  const deck = deckCards(spot.game);
  const push = (st, parent, kind) => {
    if (nodes.length >= maxNodes) throw new Error(`the tree exceeds ${maxNodes} nodes: use fewer bet sizes or a later street`);
    nodes.push({ ...kind, board: st.board.slice(), contrib: st.contrib.slice(), folded: st.folded.slice(), pot: startPot + st.contrib.reduce((a, b) => a + b, 0), parent, path: st.path });
    return nodes.length - 1;
  };
  const actionsFor = (st, p) => {
    const maxC = Math.max(...st.street);
    const facing = st.street[p] < maxC - EPS;
    const call = Math.min(maxC - st.street[p], st.stacks[p]);
    const potNow = startPot + st.contrib.reduce((a, b) => a + b, 0);
    const acts = facing ? [{ type: 'fold' }, { type: 'call' }] : [{ type: 'check' }];
    let othersCanAct = false;
    for (let q = 0; q < n; q++) if (q !== p && !st.folded[q] && st.stacks[q] > EPS) othersCanAct = true;
    if (st.raises < menu.max_raises && st.stacks[p] > call + EPS && othersCanAct) {
      const maxTo = st.street[p] + st.stacks[p];
      const raising = facing || st.raises > 0;
      const sizes = raising ? menu.raises : menu.bets;
      const tos = [];
      for (const x of sizes) {
        let to = raising ? maxC + x * (potNow + call) : st.street[p] + x * potNow;
        to = Math.max(to, maxC + Math.max(st.lastInc, EPS));
        const added = to - st.street[p];
        if (to >= maxTo - EPS || added >= menu.allin_threshold * st.stacks[p]) tos.push([maxTo, { type: 'allin', to: maxTo }]);
        else tos.push([to, { type: raising ? 'raise' : 'bet', to, size: x }]);
      }
      if (menu.add_allin) tos.push([maxTo, { type: 'allin', to: maxTo }]);
      tos.sort((a, b) => a[0] - b[0]);
      let last = -Infinity;
      for (const [to, a] of tos) if (to > last + 1e-6) { acts.push(a); last = to; }
    }
    return acts;
  };
  const decision = (st, p, parent) => {
    const actions = actionsFor(st, p);
    const idx = push(st, parent, { kind: 'decision', player: p, actions, children: [] });
    nodes[idx].children = actions.map((a) => apply(st, p, a, idx));
    return idx;
  };
  const apply = (st, p, a, parent) => {
    const s = { ...st, contrib: st.contrib.slice(), street: st.street.slice(), stacks: st.stacks.slice(), folded: st.folded.slice(), need: st.need.slice() };
    const maxC = Math.max(...st.street);
    s.need[p] = false;
    if (a.type === 'fold') s.folded[p] = true;
    else if (a.type === 'call') {
      const add = Math.min(maxC - s.street[p], s.stacks[p]);
      s.street[p] += add; s.contrib[p] += add; s.stacks[p] -= add;
    } else if (a.type !== 'check') {
      const add = a.to - s.street[p], inc = a.to - maxC;
      s.street[p] = a.to; s.contrib[p] += add; s.stacks[p] = Math.max(s.stacks[p] - add, 0);
      s.raises += 1;
      if (inc > s.lastInc) s.lastInc = inc;
      for (let q = 0; q < n; q++) if (q !== p && !s.folded[q] && s.stacks[q] > EPS) s.need[q] = true;
    }
    s.path = s.path + (s.path && !s.path.endsWith('|') ? '-' : '') + actionCode(a);
    if (s.folded.filter((f) => !f).length === 1) return push(s, parent, { kind: 'terminal', showdown: false });
    for (let k = 1; k <= n; k++) {
      const q = (p + k) % n;
      if (!s.folded[q] && s.need[q] && s.stacks[q] > EPS) return decision(s, q, parent);
    }
    return streetOver(s, parent);
  };
  const streetOver = (s, parent) => {
    if (s.board.length >= 5) return push(s, parent, { kind: 'terminal', showdown: true });
    if (spot.board2) throw new Error('double-board spots are solved on the river (both boards complete)');
    const onBoard = new Set([...s.board, ...fixed]);
    const cards = deck.filter((c) => !onBoard.has(c));
    const idx = push(s, parent, { kind: 'chance', cards, children: [] });
    nodes[idx].children = cards.map((c) => {
      const t = { ...s, board: [...s.board, c], street: new Array(n).fill(0), raises: 0, lastInc: 0, contrib: s.contrib.slice(), stacks: s.stacks.slice(), folded: s.folded.slice() };
      t.need = t.folded.map((f, q) => !f && t.stacks[q] > EPS);
      t.path = `${s.path}|${'23456789TJQKA'[c >> 2]}${'cdhs'[c & 3]}|`;
      if (t.need.filter(Boolean).length >= 2) return decision(t, t.need.indexOf(true), idx);
      t.need = t.need.map(() => false);
      return streetOver(t, idx);
    });
    return idx;
  };
  const st = {
    board: spot.board.slice(), contrib: new Array(n).fill(0), street: new Array(n).fill(0), stacks: spot.stacks.slice(),
    folded: new Array(n).fill(false), need: spot.stacks.map((s) => s > EPS), raises: 0, lastInc: 0, path: '',
  };
  if (st.need.filter(Boolean).length >= 2) decision(st, st.need.indexOf(true), null);
  else streetOver(st, null);
  return { nodes, players: n, startPot };
}

export function findNode(tree, codes) {
  let idx = 0;
  for (const code of codes) {
    const nd = tree.nodes[idx];
    if (nd.kind !== 'decision') return -1;
    const k = nd.actions.findIndex((a) => actionCode(a) === code);
    if (k < 0) return -1;
    idx = nd.children[k];
  }
  return idx;
}
