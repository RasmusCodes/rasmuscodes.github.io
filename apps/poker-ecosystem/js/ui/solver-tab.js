// Spot solver tab: solve, explore the strategy, compare equilibrium and exploitative play.
import { $, suitHtml, escapeHtml } from '../app.js';
import { PRESETS } from './presets.js';
import { lineChart, barChart, fmtNum } from './charts.js';
import { parseCards, classOf, className } from '../engine/cards.js';

let engine, tree = null, current = 0, curve = [], view = 'gto', lastReport = null, selected = null, solving = false, exploitDone = null, gameCode = 'NLH', solvedOnce = false;
export const solverState = { setProfile: null };

const pct = (x, d = 2) => `${(x).toFixed(d)}%`;
const RANK = '23456789TJQKA';
/** "JsAc" -> "AcJs": cards sorted high to low for display. */
const highFirst = (s) => (s.match(/../g) || []).sort((a, b) => RANK.indexOf(b[0]) - RANK.indexOf(a[0]) || 'cdhs'.indexOf(b[1]) - 'cdhs'.indexOf(a[1])).join('');
function actionColors(actions) {
  const bets = actions.filter((a) => a.type === 'bet' || a.type === 'raise');
  return actions.map((a) => {
    if (a.type === 'fold') return 'var(--a-fold)';
    if (a.type === 'check' || a.type === 'call') return 'var(--a-check)';
    if (a.type === 'allin') return 'var(--a-allin)';
    const i = bets.indexOf(a), k = bets.length;
    return ['var(--a-bet1)', 'var(--a-bet2)', 'var(--a-bet3)'][k <= 1 ? 1 : Math.min(2, Math.round((i / (k - 1)) * 2))];
  });
}

function loadPreset(i) {
  const p = PRESETS[i], c = p.config;
  $('#game').value = c.game; $('#board').value = c.board; $('#board2').value = c.board2 || '';
  $('#r0').value = c.ranges[0]; $('#r1').value = c.ranges[1];
  $('#pot').value = c.pot; $('#stack').value = c.stacks[0];
  $('#bets').value = c.menu.bets.map((x) => Math.round(x * 100)).join(', ');
  $('#raises').value = c.menu.raises.map((x) => Math.round(x * 100)).join(', ');
  $('#maxr').value = c.menu.max_raises;
  $('#rake').value = c.rake ? c.rake.percent : 0; $('#rakecap').value = c.rake ? c.rake.cap : 0;
  $('#bounty').value = c.side_rule ? c.side_rule.amount : 0;
  $('#iters').value = p.iters;
  $('#preset-note').textContent = p.note;
  $('#preset').dataset.allin = c.menu.allin_threshold;
  const pr = p.profile;
  setProfile({ mp: pr.mp, fold_to_bet: pr.fold, raise_vs_bet: pr.raise, bet_when_checked_to: pr.stab ?? null, bluff_share: pr.bluff });
}

/** bet_when_checked_to: a frequency turns that part of the model on, null turns it off. */
function setProfile(pr) {
  if (pr.mp !== undefined) $('#mp').value = String(pr.mp);
  if (pr.fold_to_bet !== undefined) $('#fold').value = pr.fold_to_bet;
  if (pr.raise_vs_bet !== undefined) $('#raise').value = pr.raise_vs_bet;
  if (pr.bet_when_checked_to !== undefined) {
    $('#use-stab').checked = pr.bet_when_checked_to !== null;
    if (pr.bet_when_checked_to !== null) $('#stab').value = pr.bet_when_checked_to;
  }
  if (pr.bluff_share !== undefined) $('#bluff').value = pr.bluff_share;
  syncOutputs();
}
solverState.setProfile = setProfile;

function syncOutputs() {
  for (const k of ['fold', 'raise', 'stab', 'bluff', 'lead', 'p']) $(`#o-${k}`).textContent = ` ${Math.round(100 * $(`#${k}`).value)}${k === 'p' ? '' : '%'}`;
  $('#o-p').textContent = ` ${(+$('#p').value).toFixed(2)}`;
}

function readConfig() {
  const nums = (s) => String(s).split(/[,\s]+/).filter(Boolean).map((x) => +x / 100).filter((x) => x > 0);
  const cfg = {
    game: $('#game').value, board: $('#board').value.trim(), board2: $('#board2').value.trim() || null,
    ranges: [$('#r0').value.trim(), $('#r1').value.trim()], pot: +$('#pot').value, stacks: [+$('#stack').value],
    menu: { bets: nums($('#bets').value), raises: nums($('#raises').value), max_raises: Math.max(1, Math.min(5, +$('#maxr').value || 2)), allin_threshold: +($('#preset').dataset.allin || 0.67), add_allin: false },
  };
  if (+$('#rake').value > 0) cfg.rake = { percent: +$('#rake').value, cap: +$('#rakecap').value || 1e9 };
  if (+$('#bounty').value > 0) cfg.side_rule = { kind: 'seven_deuce', amount: +$('#bounty').value };
  if (!cfg.menu.bets.length) throw new Error('give at least one bet size');
  return cfg;
}

function renderKpis(e, extra = {}) {
  const k = $('#kpis');
  const items = [
    [e ? pct(e.pctPot, 3) : '–', 'exploitability (% of pot)'],
    [e ? fmtNum(e.ev[0], 2) : '–', 'value out of position'],
    [e ? fmtNum(e.ev[1], 2) : '–', 'value in position'],
    [extra.iterations ?? '–', 'iterations'],
    [extra.seconds !== undefined ? `${extra.seconds.toFixed(1)} s` : '–', 'time in this browser'],
    [extra.hands ? `${extra.hands[0]} / ${extra.hands[1]}` : '–', 'hands (OOP / IP)'],
  ];
  k.innerHTML = items.map(([v, l]) => `<div class="kpi"><b>${v}</b><span>${l}</span></div>`).join('');
}

function drawCurve() {
  lineChart($('#conv-chart'), [{ name: 'Exploitability', points: curve.map((c) => [c.iteration, Math.max(c.pctPot, 1e-4)]) }], {
    logY: true, xLabel: 'iteration', yLabel: '% of pot', yFormat: (v) => (v >= 1 ? v.toFixed(0) : v >= 0.01 ? String(v) : v.toExponential(0)), height: 220, label: 'exploitability by iteration',
  });
}

async function solve() {
  if (solving) return;
  let cfg;
  try { cfg = readConfig(); } catch (e) { $('#solve-status').textContent = e.message; $('#solve-status').className = 'status err'; return; }
  solving = true; exploitDone = null; view = 'gto'; $('#view').value = 'gto'; $('#compare-card').hidden = true;
  $('#solve').disabled = true; $('#solve-status').className = 'status'; $('#solve-status').textContent = 'Building the tree…';
  curve = []; drawCurve();
  const iters = Math.max(10, +$('#iters').value || 600);
  let hands = null;
  try {
    const done = await engine.run('solve', { config: cfg, algo: $('#algo').value, maxIterations: iters, targetPct: +$('#target').value || 0, checkEvery: Math.max(10, Math.round(iters / 30)) }, ['solved'], (m) => {
      if (m.type === 'tree') { tree = m.tree; hands = m.hands; gameCode = m.game; $('#solve-status').textContent = `${tree.length} nodes, solving…`; }
      if (m.type === 'progress') {
        curve.push(m); drawCurve();
        $('#solve-status').textContent = `iteration ${m.iteration}: ${m.pctPot.toFixed(3)}% of pot`;
        renderKpis({ pctPot: m.pctPot, ev: [NaN, NaN] }, { iterations: m.iteration, seconds: m.seconds, hands });
      }
    });
    renderKpis(done.result, { iterations: done.iterations, seconds: done.seconds, hands });
    $('#solve-label').textContent = done.result.constantSum ? 'equilibrium approximation · exact exploitability' : 'raked: NashConv/2 reported';
    $('#solve-status').textContent = `Done: ${done.result.pctPot.toFixed(3)}% of the pot from equilibrium in this bet-size game.`;
    current = 0; selected = null; solvedOnce = true;
    await showNode(0);
  } catch (e) {
    $('#solve-status').textContent = e.message; $('#solve-status').className = 'status err';
  } finally { solving = false; $('#solve').disabled = false; }
}

function pathTo(idx) {
  const out = [];
  let i = idx;
  while (tree[i].parent !== null) {
    const p = tree[i].parent, k = tree[p].children.indexOf(i);
    out.unshift({ node: p, label: tree[p].kind === 'chance' ? tree[p].cards[k] : `${tree[p].player === 0 ? 'OOP' : 'IP'} ${tree[p].actions[k].label}` });
    i = p;
  }
  return out;
}

function renderCrumbs() {
  const crumbs = $('#crumbs');
  const steps = pathTo(current);
  crumbs.innerHTML = `<button data-n="0">Root</button>` + steps.map((s, i) => `<span>›</span><button data-n="${steps[i + 1] ? steps[i + 1].node : current}">${escapeHtml(s.label)}</button>`).join('');
  for (const b of crumbs.querySelectorAll('button')) b.addEventListener('click', () => showNode(+b.dataset.n));
}

async function showNode(idx) {
  if (!tree) return;
  current = idx;
  renderCrumbs();
  const nd = tree[idx], head = $('#node-head');
  if (nd.kind === 'terminal') {
    head.innerHTML = `<p>${nd.showdown ? 'Showdown' : 'Someone folded'}: pot ${fmtNum(nd.pot, 2)}. <button class="btn sm" id="up">Back</button></p>`;
    $('#up').addEventListener('click', () => showNode(nd.parent));
    $('#freqbar').innerHTML = ''; $('#legend').innerHTML = ''; $('#rgrid').innerHTML = ''; $('#hand-table').innerHTML = ''; $('#ev-chart').innerHTML = '';
    return;
  }
  if (nd.kind === 'chance') return showNode(nd.children[0]);
  const who = nd.player === 0 ? 'Out of position' : 'In position';
  const parent = nd.parent !== null ? tree[nd.parent] : null;
  const deal = parent && parent.kind === 'chance'
    ? `<label style="max-width:200px">River card <select id="deal">${parent.cards.map((c, i) => `<option value="${parent.children[i]}"${parent.children[i] === idx ? ' selected' : ''}>${c}</option>`).join('')}</select></label>`
    : '';
  head.innerHTML = `${deal}<p><b>${who}</b> to act · pot ${fmtNum(nd.pot, 2)} · board <span class="cards">${suitHtml(nd.board)}</span></p><div class="actions-bar">${nd.actions.map((a, k) => `<button class="btn sm" data-c="${nd.children[k]}">${escapeHtml(a.label)} ›</button>`).join('')}</div>`;
  for (const b of head.querySelectorAll('[data-c]')) b.addEventListener('click', () => showNode(+b.dataset.c));
  if (deal) $('#deal').addEventListener('change', (e) => showNode(+e.target.value));
  const which = view === 'gto' || !exploitDone ? 'gto' : view;
  const msg = await engine.run('node', { node: idx, which }, ['node']);
  lastReport = msg.report;
  renderReport(msg.report, which);
}

function renderReport(r, which) {
  const colors = actionColors(r.actions);
  $('#freqbar').innerHTML = r.frequencies.map((f, a) => `<span style="width:${(100 * f).toFixed(2)}%;background:${colors[a]}" title="${escapeHtml(r.actions[a].label)} ${(100 * f).toFixed(1)}%"></span>`).join('');
  $('#legend').innerHTML = r.actions.map((a, k) => `<span><i style="background:${colors[k]}"></i>${escapeHtml(a.label)} ${(100 * r.frequencies[k]).toFixed(1)}%</span>`).join('') + `<span class="muted">${which === 'gto' ? 'equilibrium' : which === 'rnr' ? 'restricted Nash response' : 'best response to the model'}</span>`;
  const twoCard = r.rows.length && r.rows[0].hand.length === 4;
  const grid = $('#rgrid');
  if (!twoCard) {
    grid.innerHTML = '';
    $('#grid-note').textContent = 'Omaha hands are listed on the right (no 13×13 grid for four-card hands).';
    selected = null;
    renderHands(r, null, colors);
    return;
  }
  const cls = Array.from({ length: 169 }, () => ({ w: 0, p: new Array(r.actions.length).fill(0), ev: new Array(r.actions.length).fill(0), rows: [] }));
  for (const row of r.rows) {
    const [a, b] = parseCards(row.hand), c = classOf(a, b), x = cls[c];
    x.w += row.weight; x.rows.push(row);
    row.probs.forEach((p, k) => { x.p[k] += row.weight * p; x.ev[k] += row.weight * row.evs[k]; });
  }
  grid.innerHTML = '';
  cls.forEach((x, c) => {
    const cell = document.createElement('div');
    cell.className = 'rcell' + (x.w ? '' : ' empty') + (selected === c ? ' sel' : '');
    if (x.w) cell.innerHTML = x.p.map((p, k) => `<span class="fill" style="width:${((100 * p) / x.w).toFixed(2)}%;background:${colors[k]}"></span>`).join('');
    cell.insertAdjacentHTML('beforeend', `<em>${className(c)}</em>`);
    cell.title = x.w ? `${className(c)}: ` + r.actions.map((a, k) => `${a.label} ${((100 * x.p[k]) / x.w).toFixed(0)}%`).join(', ') : `${className(c)}: not in range`;
    if (x.w) cell.addEventListener('click', () => { selected = c; renderReport(r, which); });
    grid.appendChild(cell);
  });
  $('#grid-note').textContent = 'Cells show each hand class\'s action mix, weighted by the combos that reach this point. Click one for its values.';
  if (selected === null || !cls[selected].w) selected = cls.reduce((best, x, c) => (x.w > (cls[best]?.w || 0) ? c : best), 0);
  renderHands(r, cls[selected], colors, className(selected));
}

function renderHands(r, group, colors, name) {
  const rows = group ? group.rows : r.rows.slice().sort((a, b) => b.weight - a.weight).slice(0, 200);
  $('#sel-title').textContent = group ? `${name}: value of each action` : 'Hands reaching this point (largest weight first)';
  if (group) {
    barChart($('#ev-chart'), r.actions.map((a, k) => ({ label: a.label, value: group.ev[k] / group.w, color: colors[k], note: `${fmtNum(group.ev[k] / group.w, 2)} · ${((100 * group.p[k]) / group.w).toFixed(0)}%` })), { row: 26, labelWidth: 110 });
  } else $('#ev-chart').innerHTML = '';
  $('#hand-table').innerHTML = `<thead><tr><th>Hand</th><th class="num">Weight</th>${r.actions.map((a) => `<th class="num">${escapeHtml(a.label)}</th>`).join('')}</tr></thead><tbody>` +
    rows.map((row) => `<tr><td class="cards">${suitHtml(highFirst(row.hand))}</td><td class="num">${row.weight.toFixed(2)}</td>${row.probs.map((p, k) => `<td class="num" title="value ${row.evs[k].toFixed(3)}">${(100 * p).toFixed(0)}% <span class="muted">${row.evs[k].toFixed(2)}</span></td>`).join('')}</tr>`).join('') + '</tbody>';
}

function profileFromForm() {
  const pr = { fold_to_bet: +$('#fold').value, raise_vs_bet: +$('#raise').value, bluff_share: +$('#bluff').value };
  if ($('#use-stab').checked) pr.bet_when_checked_to = +$('#stab').value;
  if ($('#use-lead').checked) pr.lead = +$('#lead').value;
  return pr;
}

async function exploit() {
  if (!solvedOnce || solving) { $('#exploit-status').textContent = 'Solve the spot first.'; return; }
  const mp = +$('#mp').value, p = +$('#p').value;
  $('#exploit').disabled = true; $('#exploit-status').className = 'status'; $('#exploit-status').textContent = 'Building the model and solving the restricted Nash response…';
  try {
    const r = await engine.run('exploit', { modelPlayer: mp, profile: profileFromForm(), p }, ['exploit']);
    exploitDone = r;
    const pot = r.pot, gain = (v) => `${v - r.equilibrium.evVsModel >= 0 ? '+' : ''}${fmtNum(v - r.equilibrium.evVsModel, 2)} (${((100 * (v - r.equilibrium.evVsModel)) / pot).toFixed(1)}% pot)`;
    $('#compare-card').hidden = false;
    $('#exploit-kpis').innerHTML = [
      [fmtNum(r.equilibrium.evVsModel, 2), `equilibrium's value against the model (${r.exploiter === 0 ? 'OOP' : 'IP'})`],
      [gain(r.rnr.evVsModel), `restricted Nash response, p = ${r.p.toFixed(2)}`],
      [gain(r.bestResponse.evVsModel), 'best response (maximum exploitation)'],
      [`${r.rnr.exploitabilityPct.toFixed(2)}%`, 'what a perfect opponent could win back from the RNR strategy (% pot)'],
    ].map(([v, l]) => `<div class="kpi"><b>${v}</b><span>${l}</span></div>`).join('');
    $('#exploit-status').textContent = `Done in ${r.seconds.toFixed(1)} s. Switched the explorer to the exploit view at the exploiter's decision.`;
    view = 'rnr'; $('#view').value = 'rnr';
    let node = 0;
    if (r.exploiter === 1 && tree[0].kind === 'decision') { const k = tree[0].actions.findIndex((a) => a.type === 'check'); if (k >= 0) node = tree[0].children[k]; }
    await showNode(node);
  } catch (e) { $('#exploit-status').textContent = e.message; $('#exploit-status').className = 'status err'; }
  finally { $('#exploit').disabled = false; }
}

async function frontier() {
  if (!exploitDone) { $('#exploit-status').textContent = 'Run "Compare GTO and exploit" first.'; return; }
  $('#frontier').disabled = true;
  const pts = [];
  const base = exploitDone.equilibrium.evVsModel, pot = exploitDone.pot;
  const draw = () => lineChart($('#frontier-chart'), [{ name: 'RNR frontier', points: pts.map((q) => [q.exploitabilityPct, (100 * (q.evVsModel - base)) / pot]) }], { xLabel: 'exploitability of the exploiter (% of pot)', yLabel: 'gain against the model (% of pot)', height: 230, yFormat: (v) => v.toFixed(1), xFormat: (v) => v.toFixed(1) });
  try {
    await engine.run('frontier', { ps: [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1] }, ['frontier'], (m) => {
      if (m.type === 'frontier-point') { pts.push(m.point); draw(); $('#exploit-status').textContent = `frontier: p = ${m.point.p}`; }
    });
    $('#exploit-status').textContent = 'Frontier done: p = 0 is the equilibrium (bottom left), p = 1 the best response.';
  } catch (e) { $('#exploit-status').textContent = e.message; }
  finally { $('#frontier').disabled = false; }
}

export function initSolver(eng) {
  engine = eng;
  $('#preset').innerHTML = PRESETS.map((p, i) => `<option value="${i}">${escapeHtml(p.name)}</option>`).join('');
  $('#preset').addEventListener('change', (e) => { loadPreset(+e.target.value); solve(); });
  for (const k of ['fold', 'raise', 'stab', 'bluff', 'lead', 'p']) $(`#${k}`).addEventListener('input', syncOutputs);
  $('#solve').addEventListener('click', solve);
  $('#exploit').addEventListener('click', exploit);
  $('#frontier').addEventListener('click', frontier);
  $('#view').addEventListener('change', (e) => { view = e.target.value; if (view !== 'gto' && !exploitDone) { $('#exploit-status').textContent = 'Run the opponent model first to see an exploit.'; } showNode(current); });
  loadPreset(0);
  renderKpis(null);
  drawCurve();
  solve();
}
