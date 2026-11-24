// Heads-up vector-form CFR (port of pe-solver::hu): DCFR, CFR+, Linear CFR,
// vanilla CFR and Predictive CFR+; exact best response and exploitability;
// opponent models, maximally exploitative responses and restricted Nash
// responses; rake, double boards, hi-lo splits and the 7-2 bounty.

import { evalHand, evalLow } from './eval.js';
import { ShowdownPlan } from './sweep.js';
import { buildTree } from './tree.js';

/** x^e with correctly rounded operations for DCFR's exponents (matches the Rust engine bit for bit). */
export function exactPow(x, e) {
  if (e === 0) return 1;
  if (e === 1) return x;
  if (e === 1.5) return x * Math.sqrt(x);
  if (e === 2) return x * x;
  if (e === 3) return x * x * x;
  return Math.pow(x, e);
}

const ALGOS = {
  DCFR: { kind: 'dcfr', alpha: 1.5, beta: 0, gamma: 2 },
  'CFR+': { kind: 'cfrplus' },
  LCFR: { kind: 'linear' },
  CFR: { kind: 'cfr' },
  'PCFR+': { kind: 'pcfr' },
};

export class HuSolver {
  constructor(spot, { algo = 'DCFR', maxNodes = 400000 } = {}) {
    if (spot.ranges.length !== 2) throw new Error('the heads-up solver needs exactly two ranges');
    this.spot = spot;
    this.algo = ALGOS[algo] || ALGOS.DCFR;
    this.algoName = ALGOS[algo] ? algo : 'DCFR';
    this.tree = buildTree(spot, maxNodes);
    this.weights = [spot.ranges[0].weights, spot.ranges[1].weights];
    this.hands = [spot.ranges[0].hands, spot.ranges[1].hands];
    this.masksLo = this.hands.map((hs) => Int32Array.from(hs.map((h) => h.reduce((m, c) => (c < 32 ? m | (1 << c) : m), 0))));
    this.masksHi = this.hands.map((hs) => Int32Array.from(hs.map((h) => h.reduce((m, c) => (c >= 32 ? m | (1 << (c - 32)) : m), 0))));
    const game = spot.game;
    // showdown boards
    this.boardIndex = new Map();
    this.boards = [];
    this.showdownBoard = new Int32Array(this.tree.nodes.length).fill(-1);
    this.tree.nodes.forEach((nd, i) => {
      if (nd.kind !== 'terminal' || !nd.showdown) return;
      const key = nd.board.join(',');
      if (!this.boardIndex.has(key)) { this.boardIndex.set(key, this.boards.length); this.boards.push(this.prepareBoard(nd.board)); }
      this.showdownBoard[i] = this.boardIndex.get(key);
    });
    const zero = [this.hands[0].map(() => 0), this.hands[1].map(() => 0)];
    this.compat = [new ShowdownPlan(zero[0], this.hands[0], zero[1], this.hands[1]), new ShowdownPlan(zero[1], this.hands[1], zero[0], this.hands[0])];
    this.data = this.tree.nodes.map((nd) => {
      if (nd.kind !== 'decision') return null;
      const k = nd.actions.length, n = this.hands[nd.player].length;
      return { player: nd.player, k, n, regrets: new Float64Array(k * n), sum: new Float64Array(k * n), last: this.algo.kind === 'pcfr' ? new Float64Array(k * n) : null, lock: null };
    });
    const used = new Set([...spot.board, ...(spot.board2 || []), ...spot.dead]);
    const deckLeft = (game.rules === 'standard' ? 52 : 36) - used.size;
    this.dealCount = deckLeft - 2 * game.hole;
    this.iterations = 0;
    this.model = null;
    this.rnrP = 0;
  }

  prepareBoard(board) {
    const game = this.spot.game;
    const vals = (p, b, low) => this.hands[p].map((h) => (h.some((c) => b.includes(c)) ? 0 : low ? evalLow(game, h, b) : evalHand(game, h, b)));
    const v = [vals(0, board, false), vals(1, board, false)];
    const plan = (vv, i) => new ShowdownPlan(vv[i], this.hands[i], vv[1 - i], this.hands[1 - i]);
    const out = { hi: [plan(v, 0), plan(v, 1)], vals: v, hi2: null, lo: null, hasLow: null };
    if (this.spot.board2) { const v2 = [vals(0, this.spot.board2, false), vals(1, this.spot.board2, false)]; out.hi2 = [plan(v2, 0), plan(v2, 1)]; }
    if (game.hilo) {
      const lv = [vals(0, board, true), vals(1, board, true)];
      out.lo = [plan(lv, 0), plan(lv, 1)];
      out.hasLow = [lv[0].map((x) => x > 0), lv[1].map((x) => x > 0)];
    }
    return out;
  }

  rakeOf(pot) { const r = this.spot.rake; return r ? Math.min((pot * r.percent) / 100, r.cap) : 0; }

  strategy(node, average) {
    const d = this.data[node];
    if (d.lock) return d.lock;
    const { k, n } = d;
    const src = average ? d.sum : d.regrets;
    const pred = !average && d.last;
    const out = new Float64Array(k * n);
    for (let h = 0; h < n; h++) {
      let tot = 0;
      for (let a = 0; a < k; a++) {
        let x = src[a * n + h];
        if (pred) x += d.last[a * n + h];
        if (!average && x < 0) x = 0;
        out[a * n + h] = x;
        tot += x;
      }
      for (let a = 0; a < k; a++) out[a * n + h] = tot > 0 ? out[a * n + h] / tot : 1 / k;
    }
    return out;
  }
  averageStrategy(node) { return this.strategy(node, true); }

  terminal(node, trav, opp) {
    const nd = this.tree.nodes[node];
    const n = this.hands[trav].length, o = 1 - trav, p0 = this.tree.startPot, B = this.spot.bounty;
    const out = new Float64Array(n);
    if (!nd.showdown) {
      const folder = nd.folded[0] ? 0 : 1, cf = nd.contrib[folder];
      const rake = this.rakeOf(p0 + 2 * cf);
      const tot = this.compat[trav].compatible(opp);
      if (trav !== folder) {
        for (let h = 0; h < n; h++) out[h] = (p0 + cf - rake) * tot[h] + (B > 0 && this.spot.is72[trav][h] ? B * tot[h] : 0);
      } else {
        for (let h = 0; h < n; h++) out[h] = -cf * tot[h];
        if (B > 0) {
          const w72 = opp.map((w, v) => (this.spot.is72[o][v] ? w : 0));
          const t72 = this.compat[trav].compatible(w72);
          for (let h = 0; h < n; h++) out[h] -= B * t72[h];
        }
      }
      return out;
    }
    const m = Math.min(nd.contrib[0], nd.contrib[1]);
    const q = p0 + 2 * m, q2 = q - this.rakeOf(q);
    const bd = this.boards[this.showdownBoard[node]];
    const hi = bd.hi[trav].sums(opp);
    const share = new Float64Array(n);
    for (let h = 0; h < n; h++) share[h] = hi.win[h] + 0.5 * hi.tie[h];
    if (bd.lo) {
      const lo = bd.lo[trav].sums(opp);
      const noLow = opp.map((w, v) => (bd.hasLow[o][v] ? 0 : w));
      const hn = bd.hi[trav].sums(noLow);
      for (let h = 0; h < n; h++) {
        const x = bd.hasLow[trav][h] ? lo.win[h] + 0.5 * lo.tie[h] : hn.win[h] + 0.5 * hn.tie[h];
        share[h] = 0.5 * share[h] + 0.5 * x;
      }
    }
    if (bd.hi2) {
      const s2 = bd.hi2[trav].sums(opp);
      for (let h = 0; h < n; h++) share[h] = 0.5 * share[h] + 0.5 * (s2.win[h] + 0.5 * s2.tie[h]);
    }
    for (let h = 0; h < n; h++) out[h] = q2 * share[h] - m * (hi.win[h] + hi.tie[h] + hi.lose[h]);
    if (B > 0) {
      const w72 = opp.map((w, v) => (this.spot.is72[o][v] ? w : 0));
      const s72 = bd.hi[trav].sums(w72);
      for (let h = 0; h < n; h++) {
        if (this.spot.is72[trav][h]) out[h] += B * hi.win[h];
        out[h] -= B * s72.lose[h];
      }
    }
    return out;
  }

  walk(node, trav, rs, ro, fixed, mode) {
    const nd = this.tree.nodes[node];
    if (nd.kind === 'terminal') {
      if (!fixed) return this.terminal(node, trav, ro);
      const opp = new Float64Array(ro.length);
      for (let i = 0; i < ro.length; i++) opp[i] = ro[i] + fixed[i];
      return this.terminal(node, trav, opp);
    }
    const n = this.hands[trav].length;
    if (nd.kind === 'chance') {
      const o = 1 - trav, out = new Float64Array(n);
      for (let ci = 0; ci < nd.cards.length; ci++) {
        const c = nd.cards[ci];
        const lo = c < 32 ? 1 << c : 0, hi = c >= 32 ? 1 << (c - 32) : 0;
        const hit = (p, i) => (this.masksLo[p][i] & lo) | (this.masksHi[p][i] & hi);
        const r1 = rs.map((r, i) => (hit(trav, i) ? 0 : r));
        const r2 = ro.map((r, i) => (hit(o, i) ? 0 : r));
        const rf = fixed ? fixed.map((r, i) => (hit(o, i) ? 0 : r)) : null;
        const v = this.walk(nd.children[ci], trav, r1, r2, rf, mode);
        for (let h = 0; h < n; h++) if (!hit(trav, h)) out[h] += v[h];
      }
      for (let h = 0; h < n; h++) out[h] /= this.dealCount;
      return out;
    }
    const p = nd.player, k = nd.children.length;
    const average = mode.kind !== 'train';
    const sigma = this.strategy(node, average);
    if (p === trav) {
      const vals = [];
      for (let a = 0; a < k; a++) {
        const r = new Float64Array(n);
        for (let h = 0; h < n; h++) r[h] = rs[h] * sigma[a * n + h];
        vals.push(this.walk(nd.children[a], trav, r, ro, fixed, mode));
      }
      const v = new Float64Array(n);
      if (mode.kind === 'br') {
        for (let h = 0; h < n; h++) { let m = -Infinity; for (let a = 0; a < k; a++) if (vals[a][h] > m) m = vals[a][h]; v[h] = m; }
      } else {
        for (let a = 0; a < k; a++) for (let h = 0; h < n; h++) v[h] += sigma[a * n + h] * vals[a][h];
      }
      if (mode.kind === 'train') this.update(node, sigma, vals, v, rs, mode);
      return v;
    }
    const no = this.hands[p].length;
    const model = fixed && this.model ? this.model[node] : null;
    const v = new Float64Array(n);
    for (let a = 0; a < k; a++) {
      const r = new Float64Array(no);
      let any = false;
      for (let h = 0; h < no; h++) { r[h] = ro[h] * sigma[a * no + h]; if (r[h] !== 0) any = true; }
      let rf = null;
      if (fixed) {
        const src = model || sigma;
        rf = new Float64Array(no);
        for (let h = 0; h < no; h++) { rf[h] = fixed[h] * src[a * no + h]; if (rf[h] !== 0) any = true; }
      }
      if (!any && mode.kind !== 'train') continue;
      const c = this.walk(nd.children[a], trav, rs, r, rf, mode);
      for (let h = 0; h < n; h++) v[h] += c[h];
    }
    return v;
  }

  update(node, sigma, vals, v, rs, mode) {
    const d = this.data[node];
    if (d.lock) return;
    const { k, n } = d, kind = this.algo.kind, t = mode.t;
    for (let a = 0; a < k; a++) for (let h = 0; h < n; h++) {
      const i = a * n + h, r = vals[a][h] - v[h], c = rs[h] * sigma[i];
      if (kind === 'cfr') { d.regrets[i] += r; d.sum[i] += c; }
      else if (kind === 'cfrplus') { d.regrets[i] = Math.max(d.regrets[i] + r, 0); d.sum[i] += t * c; }
      else if (kind === 'linear') { d.regrets[i] += t * r; d.sum[i] += t * c; }
      else if (kind === 'dcfr') { const old = d.regrets[i]; d.regrets[i] = old * (old > 0 ? mode.dpos : mode.dneg) + r; d.sum[i] = d.sum[i] * mode.dsum + c; }
      else { d.regrets[i] = Math.max(d.regrets[i] + r, 0); d.last[i] = r; d.sum[i] += t * t * c; }
    }
  }

  trainMode() {
    const t = this.iterations;
    if (this.algo.kind === 'dcfr') {
      const tp = t - 1, a = exactPow(tp, this.algo.alpha), b = exactPow(tp, this.algo.beta);
      return { kind: 'train', t, dpos: a / (a + 1), dneg: b / (b + 1), dsum: exactPow(tp / t, this.algo.gamma) };
    }
    return { kind: 'train', t, dpos: 1, dneg: 1, dsum: 1 };
  }

  iterate() {
    this.iterations += 1;
    const mode = this.trainMode();
    for (let trav = 0; trav < 2; trav++) {
      const o = 1 - trav;
      if (this.model && this.model.player === o && this.rnrP > 0) {
        const p = this.rnrP;
        this.walk(0, trav, this.weights[trav], this.weights[o].map((w) => w * (1 - p)), this.weights[o].map((w) => w * p), mode);
      } else {
        this.walk(0, trav, this.weights[trav], this.weights[o], null, mode);
      }
    }
  }

  jointWeight() {
    const t = this.compat[0].compatible(this.weights[1]);
    let z = 0;
    for (let h = 0; h < t.length; h++) z += t[h] * this.weights[0][h];
    return z;
  }
  dot(v, w) { let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * w[i]; return s; }

  /** Exact exploitability of the average strategies (NashConv / 2 in % of the starting pot). */
  exploitability() {
    const z = this.jointWeight();
    const ev = [0, 0], br = [0, 0];
    for (let p = 0; p < 2; p++) {
      const o = 1 - p;
      ev[p] = this.dot(this.walk(0, p, this.weights[p], this.weights[o], null, { kind: 'eval' }), this.weights[p]) / z;
      br[p] = this.dot(this.walk(0, p, this.weights[p], this.weights[o], null, { kind: 'br' }), this.weights[p]) / z;
    }
    const nashConv = br[0] - ev[0] + (br[1] - ev[1]);
    return { ev, br, nashConv, pctPot: (100 * nashConv) / 2 / this.tree.startPot, constantSum: !this.spot.rake };
  }

  setModel(player, strategyPerNode, p) { this.model = Object.assign(strategyPerNode.slice(), { player }); this.rnrP = Math.min(Math.max(p, 0), 1); }
  clearModel() { this.model = null; this.rnrP = 0; }

  /** Value of p's average strategy against the model, and of a best response to it. */
  valuesVsModel(p) {
    if (!this.model || this.model.player !== 1 - p) return null;
    const z = this.jointWeight(), o = 1 - p;
    const zero = new Float64Array(this.hands[o].length);
    const ev = this.dot(this.walk(0, p, this.weights[p], zero, this.weights[o], { kind: 'eval' }), this.weights[p]) / z;
    const br = this.dot(this.walk(0, p, this.weights[p], zero, this.weights[o], { kind: 'br' }), this.weights[p]) / z;
    return { ev, br };
  }

  /** Reach of both players into a node under the average strategies (or a model for one player). */
  reachInto(node, modelFor = -1) {
    const path = [node];
    let cur = node;
    while (this.tree.nodes[cur].parent !== null) { cur = this.tree.nodes[cur].parent; path.push(cur); }
    path.reverse();
    const reach = [Float64Array.from(this.weights[0]), Float64Array.from(this.weights[1])];
    for (let i = 0; i + 1 < path.length; i++) {
      const a = this.tree.nodes[path[i]], b = path[i + 1];
      const k = a.children.indexOf(b);
      if (a.kind === 'decision') {
        const q = a.player;
        const sigma = q === modelFor && this.model && this.model[path[i]] ? this.model[path[i]] : this.averageStrategy(path[i]);
        const nq = this.hands[q].length;
        for (let h = 0; h < nq; h++) reach[q][h] *= sigma[k * nq + h];
      } else if (a.kind === 'chance') {
        const c = a.cards[k];
        for (let p = 0; p < 2; p++) this.hands[p].forEach((hand, h) => { if (hand.includes(c)) reach[p][h] = 0; });
      }
    }
    return reach;
  }

  /** Per-hand values of each action at a decision node (chips per hand) and the reaching weight. */
  actionValues(node, vsModel = false) {
    const nd = this.tree.nodes[node];
    if (nd.kind !== 'decision') throw new Error('not a decision node');
    const p = nd.player, o = 1 - p;
    const reach = this.reachInto(node, vsModel ? o : -1);
    const totals = this.compat[p].compatible(reach[o]);
    const zero = new Float64Array(this.hands[o].length);
    const evs = nd.children.map((c) => {
      const v = vsModel ? this.walk(c, p, reach[p], zero, reach[o], { kind: 'eval' }) : this.walk(c, p, reach[p], reach[o], null, { kind: 'eval' });
      return Float64Array.from(v, (x, h) => (totals[h] > 1e-12 ? x / totals[h] : 0));
    });
    const own = Float64Array.from(reach[p], (r, h) => (totals[h] > 1e-12 ? r : 0));
    return { evs, reach: own, oppReach: reach[o] };
  }

  /** Node report: actions, range-weighted frequencies and per-hand rows. */
  nodeReport(node, { vsModel = false, strategy = null } = {}) {
    const nd = this.tree.nodes[node];
    const p = nd.player, k = nd.actions.length, n = this.hands[p].length;
    const sigma = strategy || this.averageStrategy(node);
    const { evs, reach } = this.actionValues(node, vsModel);
    const tot = reach.reduce((a, b) => a + b, 0);
    const freqs = nd.actions.map((_, a) => (tot > 0 ? reach.reduce((s, r, h) => s + r * sigma[a * n + h], 0) / tot : 0));
    const rows = [];
    for (let h = 0; h < n; h++) if (reach[h] > 0) rows.push({ h, hand: this.hands[p][h], weight: reach[h], probs: Array.from({ length: k }, (_, a) => sigma[a * n + h]), evs: Array.from({ length: k }, (_, a) => evs[a][h]) });
    return { node, player: p, path: nd.path, actions: nd.actions, frequencies: freqs, rows };
  }
}

/** Solves to a target (% of pot) or an iteration cap; `onProgress` gets curve points. */
export function solve(solver, { maxIterations = 1000, targetPct = 0.3, checkEvery = 50, onProgress } = {}) {
  const curve = [];
  while (solver.iterations < maxIterations) {
    const next = Math.min(solver.iterations + checkEvery, maxIterations);
    while (solver.iterations < next) solver.iterate();
    const e = solver.exploitability();
    curve.push({ iteration: solver.iterations, pctPot: e.pctPot });
    if (onProgress) onProgress(curve[curve.length - 1], e);
    if (e.pctPot <= targetPct) break;
  }
  return curve;
}
