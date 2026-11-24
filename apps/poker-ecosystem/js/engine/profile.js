// Opponent profiles -> model strategies (port of pe-solver::profile).
// The player's equilibrium strategy is overridden wherever a profile parameter
// applies, with threshold strategies on the range reaching the node: raise the
// strongest share, fold the weakest, call the rest; bet the strongest share for
// value and the weakest as bluffs. Strength = high-hand value on the current board.

import { evalHand } from './eval.js';

function streetActions(path) {
  const seg = path.split('|').pop() || '';
  return seg.split('-').filter(Boolean);
}

function chooseAggressive(actions, size) {
  let best = -1, bestD = Infinity;
  actions.forEach((a, i) => {
    let s = null;
    if (a.type === 'bet' || a.type === 'raise') s = a.size;
    else if (a.type === 'allin') s = 100;
    if (s === null) return;
    const d = Math.abs(s - (size ?? 0));
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

/** Per hand [top, middle, bottom] fractions: `top` share from the strongest, `bottom` from the weakest. */
export function thresholds(strength, reach, top, bottom) {
  const n = strength.length;
  const total = reach.reduce((a, b) => a + b, 0);
  const out = Array.from({ length: n }, () => [0, 1, 0]);
  if (total <= 0) return out;
  const order = [];
  for (let h = 0; h < n; h++) if (reach[h] > 0) order.push(h);
  order.sort((a, b) => strength[b] - strength[a]);
  const tc = Math.min(Math.max(top, 0), 1);
  const topW = tc * total, botW = Math.min(Math.max(bottom, 0), 1 - tc) * total;
  let acc = 0;
  for (const h of order) { const w = reach[h]; out[h][0] = Math.min(Math.max(topW - acc, 0), w) / w; acc += w; }
  acc = 0;
  for (let i = order.length - 1; i >= 0; i--) {
    const h = order[i], w = reach[h], room = w * (1 - out[h][0]);
    const take = Math.min(Math.max(botW - acc, 0), room);
    out[h][2] = w > 0 ? take / w : 0;
    acc += take;
  }
  for (const o of out) o[1] = Math.max(1 - o[0] - o[2], 0);
  return out;
}

/** A complete model strategy for `player` (array indexed by node; null for other nodes). */
export function buildModel(solver, player, profile) {
  const tree = solver.tree, spot = solver.spot;
  const hands = solver.hands[player], n = hands.length;
  const bluffShare = profile.bluff_share ?? 0.33;
  const model = new Array(tree.nodes.length).fill(null);
  const stack = [[0, Float64Array.from(solver.weights[player])]];
  while (stack.length) {
    const [node, reach] = stack.pop();
    const nd = tree.nodes[node];
    if (nd.kind === 'terminal') continue;
    if (nd.kind === 'chance') {
      nd.cards.forEach((c, i) => stack.push([nd.children[i], reach.map((w, h) => (hands[h].includes(c) ? 0 : w))]));
      continue;
    }
    if (nd.player !== player) { for (const ch of nd.children) stack.push([ch, reach.slice()]); continue; }
    const k = nd.actions.length;
    const sigma = Float64Array.from(solver.averageStrategy(node));
    const acts = streetActions(nd.path);
    const facing = nd.actions.some((a) => a.type === 'fold');
    const aggressions = acts.filter((c) => c[0] === 'b' || c[0] === 'r' || c === 'a').length;
    const strength = hands.map((h) => (h.some((c) => nd.board.includes(c)) ? 0 : evalHand(spot.game, h, nd.board)));
    const apply = (top, bottom, ta, ma, ba) => {
      const th = thresholds(strength, reach, top, bottom);
      for (let h = 0; h < n; h++) {
        for (let a = 0; a < k; a++) sigma[a * n + h] = 0;
        sigma[ta * n + h] += th[h][0];
        sigma[ma * n + h] += th[h][1];
        sigma[ba * n + h] += th[h][2];
      }
    };
    if (facing) {
      const foldA = nd.actions.findIndex((a) => a.type === 'fold');
      const callA = nd.actions.findIndex((a) => a.type === 'call');
      const raiseA = chooseAggressive(nd.actions, profile.size);
      const fold = aggressions >= 2 ? profile.fold_to_raise : profile.fold_to_bet;
      if (fold !== undefined && fold !== null) {
        const r = aggressions >= 2 ? 0 : profile.raise_vs_bet ?? 0;
        if (raiseA >= 0 && r > 0) apply(r, fold, raiseA, callA, foldA);
        else apply(0, fold, callA, callA, foldA);
      }
    } else {
      const checkA = nd.actions.findIndex((a) => a.type === 'check');
      const freq = acts.length === 0 ? profile.lead : profile.bet_when_checked_to;
      const betA = chooseAggressive(nd.actions, profile.size);
      if (freq !== undefined && freq !== null && betA >= 0) {
        const bl = Math.min(Math.max(bluffShare, 0), 1);
        const th = thresholds(strength, reach, freq * (1 - bl), freq * bl);
        for (let h = 0; h < n; h++) {
          for (let a = 0; a < k; a++) sigma[a * n + h] = 0;
          sigma[betA * n + h] = th[h][0] + th[h][2];
          sigma[checkA * n + h] = th[h][1];
        }
      }
    }
    nd.children.forEach((ch, a) => stack.push([ch, reach.map((w, h) => w * sigma[a * n + h])]));
    model[node] = sigma;
  }
  return model;
}
