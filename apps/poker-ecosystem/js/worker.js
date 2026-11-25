// Runs the engine off the main thread. Messages: solve, node, exploit, frontier, equity.
import { prepareSpot, actionLabel, actionCode } from './engine/tree.js';
import { HuSolver } from './engine/solver.js';
import { buildModel } from './engine/profile.js';
import { gameOf, parseCards, parseHandList, cardsStr } from './engine/cards.js';
import { equityAuto, rangeEquityMonteCarlo, runItTwice, runoutCount } from './engine/equity.js';
import { FrequencyTable, reconstructRanges, streetStrengths, isHoldem, DEFAULT_RANGE_OPTIONS } from './engine/ranges.js';
import { reviewRiver, DEFAULT_REVIEW_OPTIONS } from './engine/review.js';

let hhHands = new Map(); // loaded hand histories by id
let hhTable = null;      // their decision frequencies
let hhStrengths = new Map(); // board strengths by hand id (the flop needs every runout, so they are kept)
const strengthsOf = (h) => {
  if (!hhStrengths.has(h.id)) hhStrengths.set(h.id, streetStrengths(h));
  return hhStrengths.get(h.id);
};
let gto = null;        // the equilibrium solve
let rnr = null;        // the latest restricted Nash response
let model = null;      // { player, strategy } of the opponent model
let lastIterations = 500;

const post = (msg) => self.postMessage(msg);

function treeSummary(s) {
  return s.tree.nodes.map((nd) => ({
    kind: nd.kind,
    player: nd.player,
    actions: nd.actions ? nd.actions.map((a) => ({ label: actionLabel(a), code: actionCode(a), type: a.type })) : null,
    children: nd.children || null,
    cards: nd.cards ? nd.cards.map((c) => cardsStr([c])) : null,
    showdown: nd.showdown || false,
    pot: nd.pot,
    contrib: nd.contrib,
    path: nd.path,
    parent: nd.parent,
    board: cardsStr(nd.board),
  }));
}

function report(s, node, opts) {
  const r = s.nodeReport(node, opts);
  return { ...r, actions: r.actions.map((a) => ({ label: actionLabel(a), code: actionCode(a), type: a.type })), rows: r.rows.map((x) => ({ hand: cardsStr(x.hand), weight: x.weight, probs: x.probs, evs: x.evs })) };
}

/** Best response to the model at a node: the action with the highest value for each hand. */
function bestResponseReport(node) {
  const r = gto.nodeReport(node, { vsModel: true });
  const k = r.actions.length, n = gto.hands[r.player].length;
  const sigma = new Float64Array(k * n);
  for (const row of r.rows) {
    let best = 0;
    for (let a = 1; a < k; a++) if (row.evs[a] > row.evs[best] + 1e-12) best = a;
    sigma[best * n + row.h] = 1;
  }
  return report(gto, node, { vsModel: true, strategy: sigma });
}

/**
 * A restricted Nash response solved from scratch, as in the Rust benchmarks. Starting it
 * from the equilibrium solve would leave the equilibrium's strategy sums in the average
 * strategy and understate the exploit (32% of the pot instead of 37% on the benchmark spot).
 */
function solveRnr(config, algo, modelPlayer, strategy, p) {
  const s = new HuSolver(prepareSpot(config), { algo });
  s.setModel(modelPlayer, strategy, p);
  const iterations = Math.max(2 * lastIterations, 300);
  while (s.iterations < iterations) s.iterate();
  return s;
}

function exploiterLoss(s, modelPlayer) {
  s.clearModel();
  const e = s.exploitability();
  const vStar = gto.exploitability().ev[modelPlayer];
  return (100 * Math.max(e.br[modelPlayer] - vStar, 0)) / s.tree.startPot;
}

self.onmessage = (ev) => {
  const m = ev.data;
  try {
    if (m.cmd === 'solve') {
      const t0 = performance.now();
      const s = new HuSolver(prepareSpot(m.config), { algo: m.algo || 'DCFR' });
      gto = s; rnr = null; model = null;
      post({ type: 'tree', id: m.id, tree: treeSummary(s), hands: [s.hands[0].length, s.hands[1].length], game: s.spot.game.code });
      const max = m.maxIterations || 1000, target = m.targetPct ?? 0.2, every = m.checkEvery || 25;
      let e = null;
      while (s.iterations < max) {
        const next = Math.min(s.iterations + every, max);
        while (s.iterations < next) s.iterate();
        e = s.exploitability();
        post({ type: 'progress', id: m.id, iteration: s.iterations, pctPot: e.pctPot, seconds: (performance.now() - t0) / 1000 });
        if (e.pctPot <= target) break;
      }
      lastIterations = s.iterations;
      post({ type: 'solved', id: m.id, iterations: s.iterations, result: e, seconds: (performance.now() - t0) / 1000 });
    } else if (m.cmd === 'node') {
      if (!gto) throw new Error('solve a spot first');
      let r;
      if (m.which === 'rnr' && rnr) r = report(rnr, m.node);
      else if (m.which === 'br' && model) r = bestResponseReport(m.node);
      else r = report(gto, m.node);
      post({ type: 'node', id: m.id, which: m.which || 'gto', report: r });
    } else if (m.cmd === 'exploit') {
      if (!gto) throw new Error('solve a spot first');
      const t0 = performance.now();
      const mp = m.modelPlayer, exploiter = 1 - mp;
      const strategy = buildModel(gto, mp, m.profile);
      model = { player: mp, strategy };
      gto.setModel(mp, strategy, 0);
      const gv = gto.valuesVsModel(exploiter);
      const ge = gto.exploitability();
      rnr = solveRnr(gto.spot.config, gto.algoName, mp, strategy, m.p);
      const rv = rnr.valuesVsModel(exploiter);
      const loss = exploiterLoss(rnr, mp);
      rnr.setModel(mp, strategy, m.p);
      const pot = gto.tree.startPot;
      post({
        type: 'exploit', id: m.id, exploiter, modelPlayer: mp, p: m.p,
        equilibrium: { evVsModel: gv.ev, pctPot: ge.pctPot, value: ge.ev[exploiter] },
        bestResponse: { evVsModel: gv.br },
        rnr: { evVsModel: rv.ev, exploitabilityPct: loss },
        pot, seconds: (performance.now() - t0) / 1000,
      });
    } else if (m.cmd === 'frontier') {
      if (!gto || !model) throw new Error('run an exploit analysis first');
      const mp = model.player, exploiter = 1 - mp, points = [];
      for (const p of m.ps) {
        const s = solveRnr(gto.spot.config, gto.algoName, mp, model.strategy, p);
        const v = s.valuesVsModel(exploiter);
        const loss = exploiterLoss(s, mp);
        points.push({ p, evVsModel: v.ev, exploitabilityPct: loss });
        post({ type: 'frontier-point', id: m.id, point: points[points.length - 1] });
      }
      post({ type: 'frontier', id: m.id, points });
    } else if (m.cmd === 'hh-load') {
      hhHands = new Map(m.hands.map((h) => [h.id, h]));
      hhTable = FrequencyTable.fromHands(m.hands);
      hhStrengths = new Map();
      post({ type: 'hh-loaded', id: m.id, hands: hhTable.hands });
    } else if (m.cmd === 'hh-ranges') {
      const h = hhHands.get(m.hand);
      if (!h || !hhTable) throw new Error('load the hands first');
      const t0 = performance.now();
      const result = reconstructRanges(h, hhTable, m.options || DEFAULT_RANGE_OPTIONS, isHoldem(h) ? strengthsOf(h) : null);
      post({ type: 'hh-ranges', id: m.id, result, seconds: (performance.now() - t0) / 1000 });
    } else if (m.cmd === 'hh-review') {
      const h = hhHands.get(m.hand);
      if (!h || !hhTable) throw new Error('load the hands first');
      const t0 = performance.now();
      const result = reviewRiver(h, hhTable, DEFAULT_RANGE_OPTIONS, DEFAULT_REVIEW_OPTIONS, (pt) => post({ type: 'progress', id: m.id, iteration: pt.iteration, pctPot: pt.pctPot }), isHoldem(h) ? strengthsOf(h) : null);
      post({ type: 'hh-review', id: m.id, result, seconds: (performance.now() - t0) / 1000 });
    } else if (m.cmd === 'hh-review-all') {
      if (!hhTable) throw new Error('load the hands first');
      const t0 = performance.now();
      const all = [...hhHands.values()];
      const reviews = [], failed = [];
      all.forEach((h, i) => {
        try { const r = reviewRiver(h, hhTable, DEFAULT_RANGE_OPTIONS, DEFAULT_REVIEW_OPTIONS, null, isHoldem(h) ? strengthsOf(h) : null); if (r) reviews.push(r); } catch (e) { failed.push([h.id, e.message]); }
        post({ type: 'progress', id: m.id, done: i + 1, total: all.length, reviewed: reviews.length });
      });
      post({ type: 'hh-review-all', id: m.id, reviews, failed, seconds: (performance.now() - t0) / 1000 });
    } else if (m.cmd === 'equity') {
      const game = gameOf(m.game);
      const boards = m.boards.filter((b, i) => i === 0 || b.trim()).map((b) => parseCards(b));
      const dead = m.dead ? parseCards(m.dead) : [];
      const t0 = performance.now();
      let result, rit = null;
      if (m.mode === 'ranges') {
        const used = new Set([...boards.flat(), ...dead]);
        const lists = m.entries.map((e) => parseHandList(game, e, used));
        result = rangeEquityMonteCarlo(game, lists, boards, dead, m.samples || 60000, 11);
      } else {
        const hands = m.entries.map((e) => parseCards(e));
        result = equityAuto(game, hands, boards, dead, { samples: m.samples || 150000, seed: 11 });
        if (hands.length === 2 && boards.length === 1 && (boards[0].length === 3 || boards[0].length === 4)) {
          try { rit = runItTwice(game, hands, boards[0], dead); } catch (e) { rit = null; }
        }
        result.possibleRunouts = runoutCount(game, hands, boards, dead);
      }
      post({ type: 'equity', id: m.id, result, rit, seconds: (performance.now() - t0) / 1000 });
    }
  } catch (err) {
    post({ type: 'error', id: m.id, message: err.message || String(err) });
  }
};
