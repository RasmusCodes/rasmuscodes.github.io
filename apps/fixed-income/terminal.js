/* Fixed income relative-value terminal (front end of fixed-income-rv-engine).
 * Every number is computed in the browser by firv.js from the weekly data in data/*.json:
 * curves are fitted live, trades sized by yield DV01, carry/roll and scenarios by full
 * revaluation. Static tables (scanner, country comparison, France-Poland backtests) come
 * from the Python research run and say so. */
(function () {
  'use strict';
  const F = window.FIRV;
  const root = document.getElementById('fi-terminal');
  if (!root || !F) return;
  const BASE = root.getAttribute('data-base') || './';
  const MARKETS = ['US', 'DE', 'FR', 'UK', 'JP', 'PL'];
  const METHODS = [['nss', 'Svensson'], ['ns', 'Nelson-Siegel'], ['spline', 'Smoothing spline'], ['cubic', 'Cubic spline'], ['bootstrap', 'Bootstrap']];
  const COMPARE = [['none', 'None'], ['4', '1 month'], ['13', '3 months'], ['52', '1 year'], ['260', '5 years']];
  const HORIZONS = [[1 / 12, '1M'], [0.25, '3M'], [0.5, '6M'], [1, '1Y']];
  const STRUCT = [
    ['steep', 'Steepener (2 legs)'], ['flat', 'Flattener (2 legs)'], ['fly', 'Butterfly, long belly'],
    ['flyshort', 'Butterfly, short belly'], ['cross', 'Cross-country spread'], ['outright', 'Outright (1 leg)'],
  ];
  const SERIES = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)', 'var(--s7)', 'var(--s8)'];
  const cache = {};
  let common = null;
  const S = {
    market: 'US', idx: null, method: 'nss', compare: '52', curveView: 'par', spread: '2s10s', tab: 'trade',
    structure: 'steep', t1: 2, t2: 10, t3: 30, belly: 5, weighting: '50/50', hedge: 'dv01', dv01: 10000,
    horizon: 0.25, fundingOverride: null, cross: 'DE', crossT: 10, shocks: { 2: 0, 5: 0, 10: 0, 30: 0 }, shockBoth: true,
  };
  let fitCache = {};

  // ------------------------------------------------------------------ helpers
  const $ = (sel, el) => (el || root).querySelector(sel);
  const h = (tag, attrs, html) => { const e = document.createElement(tag); if (attrs) for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (html != null) e.innerHTML = html; return e; };
  const fmt = (v, d) => (v == null || !isFinite(v) ? '–' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d == null ? 2 : d, maximumFractionDigits: d == null ? 2 : d }));
  const fmtMoney = (v, ccy) => (v == null || !isFinite(v) ? '–' : `${v < 0 ? '−' : ''}${Math.abs(Math.round(v)).toLocaleString('en-US')} ${ccy || ''}`.trim());
  const sgn = (v, d) => (v == null || !isFinite(v) ? '–' : (v > 0 ? '+' : v < 0 ? '−' : '') + fmt(Math.abs(v), d));
  const cls = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
  const tenorLabel = (t) => (t < 1 ? `${Math.round(t * 12)}m` : `${+t.toFixed(2)}y`);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  async function loadMarket(m) {
    if (!cache[m]) {
      const r = await fetch(BASE + 'data/' + m + '.json');
      if (!r.ok) throw new Error('could not load data for ' + m);
      cache[m] = await r.json();
    }
    return cache[m];
  }

  function obsAt(d, i) {
    const t = [], v = [];
    d.tenors.forEach((x, j) => { const y = d.values[i][j]; if (y != null && x <= d.max_tenor + 1e-9) { t.push(x); v.push(y / 100); } });
    return { tenors: t, values: v, kind: d.kind, freq: d.freq };
  }

  function fitAt(m, i, method) {
    const key = `${m}|${i}|${method}`;
    if (fitCache[key]) return fitCache[key];
    const d = cache[m];
    const data = obsAt(d, i);
    let meth = method;
    if (meth === 'bootstrap' && data.kind !== 'par') meth = 'cubic';
    const r = F.fit(meth, data);
    r.usedMethod = meth;
    fitCache[key] = r;
    const keys = Object.keys(fitCache);
    if (keys.length > 60) delete fitCache[keys[0]];
    return r;
  }

  function nearestIdx(d, dateStr) {
    let lo = 0, hi = d.dates.length - 1, best = 0;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (d.dates[mid] <= dateStr) { best = mid; lo = mid + 1; } else hi = mid - 1; }
    return best;
  }

  function fxConv(fromCcy, toCcy, dateStr) {
    // units of toCcy per 1 fromCcy at the latest ECB reference rate on or before the date
    if (fromCcy === toCcy || !common || !common.fx) return 1;
    const fx = common.fx, i = (() => { let b = 0; for (let k = 0; k < fx.dates.length; k++) if (fx.dates[k] <= dateStr) b = k; return b; })();
    const perEur = (c) => (c === 'EUR' ? 1 : fx[c] ? fx[c][i] : NaN);
    return perEur(toCcy) / perEur(fromCcy);
  }

  // ------------------------------------------------------------------ charts (SVG)
  function niceTicks(lo, hi, n) {
    const span = hi - lo || 1, step0 = span / (n || 5), mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => span / s <= (n || 5)) || mag * 10;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
    return out;
  }

  function widthOf(el) {
    // draw in CSS pixels so 11px text stays 11px in narrow columns
    const w = el.getBoundingClientRect().width;
    return Math.max(300, Math.round(w || 760));
  }

  function lineChart(el, opt) {
    // opt: {series:[{name,color,pts:[[x,y]],dash,dots,width}], x:'log'|'lin'|'time', height, yfmt, xfmt, xticks, ylabel, zero}
    el.innerHTML = '';
    const W = widthOf(el), H = opt.height || 300, m = { l: 52, r: 14, t: 10, b: 30 };
    const all = opt.series.flatMap((s) => s.pts.filter((p) => p[1] != null && isFinite(p[1])));
    if (!all.length) { el.innerHTML = '<p class="fi-note">No data for this selection.</p>'; return; }
    const tx = opt.x === 'log' ? (x) => Math.log(x) : (x) => x;
    let x0 = Math.min(...all.map((p) => tx(p[0]))), x1 = Math.max(...all.map((p) => tx(p[0])));
    if (x1 === x0) x1 = x0 + 1;
    let y0 = Math.min(...all.map((p) => p[1])), y1 = Math.max(...all.map((p) => p[1]));
    if (opt.zero) { y0 = Math.min(y0, 0); y1 = Math.max(y1, 0); }
    const pad = (y1 - y0) * 0.08 || 0.1; y0 -= pad; y1 += pad;
    const X = (x) => m.l + (tx(x) - x0) / (x1 - x0) * (W - m.l - m.r);
    const Y = (y) => H - m.b - (y - y0) / (y1 - y0) * (H - m.t - m.b);
    const yt = niceTicks(y0, y1, 5);
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opt.label || 'chart')}"><g class="grid">`;
    yt.forEach((v) => { svg += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}"/>`; });
    svg += '</g><g class="axis">';
    yt.forEach((v) => { svg += `<text x="${m.l - 6}" y="${Y(v) + 4}" text-anchor="end">${(opt.yfmt || ((z) => z))(v)}</text>`; });
    let xt = opt.xticks;
    const maxTicks = Math.max(3, Math.floor((W - m.l - m.r) / 60));
    if (!xt) {
      if (opt.x === 'time') {
        const a = new Date(x0), b = new Date(x1);
        const yrs = []; for (let yv = a.getUTCFullYear() + 1; yv <= b.getUTCFullYear(); yv++) yrs.push(Date.UTC(yv, 0, 1));
        const step = Math.ceil(yrs.length / Math.min(8, maxTicks)) || 1;
        xt = yrs.filter((_, k) => k % step === 0);
      } else xt = niceTicks(x0, x1, Math.min(8, maxTicks));
    } else if (xt.length > maxTicks) {
      const step = Math.ceil(xt.length / maxTicks);
      xt = xt.filter((_, k) => k % step === 0 || k === xt.length - 1);
    }
    xt.filter((v) => tx(v) >= x0 - 1e-9 && tx(v) <= x1 + 1e-9).forEach((v) => {
      svg += `<text x="${X(v)}" y="${H - m.b + 18}" text-anchor="middle">${(opt.xfmt || ((z) => z))(v)}</text>`;
    });
    svg += `<line class="baseline" x1="${m.l}" x2="${W - m.r}" y1="${H - m.b}" y2="${H - m.b}"/>`;
    if (opt.zero && y0 < 0 && y1 > 0) svg += `<line class="baseline" x1="${m.l}" x2="${W - m.r}" y1="${Y(0)}" y2="${Y(0)}"/>`;
    svg += '</g>';
    opt.series.forEach((s) => {
      const pts = s.pts.filter((p) => p[1] != null && isFinite(p[1]));
      if (s.line !== false && pts.length > 1) {
        let d = '', started = false, last = null;
        s.pts.forEach((p) => {
          if (p[1] == null || !isFinite(p[1])) { started = false; return; }
          d += (started ? 'L' : 'M') + X(p[0]).toFixed(1) + ',' + Y(p[1]).toFixed(1); started = true; last = p;
        });
        svg += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.width || 2}" ${s.dash ? 'stroke-dasharray="5 4"' : ''} stroke-linejoin="round" stroke-linecap="round"/>`;
      }
      if (s.dots) pts.forEach((p) => { svg += `<circle cx="${X(p[0])}" cy="${Y(p[1])}" r="4.5" fill="${s.color}" stroke="var(--fi-surface)" stroke-width="2"/>`; });
    });
    svg += `<line class="crosshair" x1="0" x2="0" y1="${m.t}" y2="${H - m.b}" visibility="hidden"/>`;
    svg += `<rect class="hit" x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}"/></svg>`;
    el.innerHTML = svg;
    const tip = h('div', { class: 'fi-tip', hidden: '' });
    el.appendChild(tip);
    const svgEl = el.querySelector('svg'), cross = el.querySelector('.crosshair'), hit = el.querySelector('.hit');
    const xsAll = Array.from(new Set(all.map((p) => p[0]))).sort((a, b) => a - b);
    const move = (ev) => {
      const r = svgEl.getBoundingClientRect(), px = (ev.clientX - r.left) / r.width * W;
      let best = xsAll[0], bd = Infinity;
      xsAll.forEach((x) => { const dd = Math.abs(X(x) - px); if (dd < bd) { bd = dd; best = x; } });
      cross.setAttribute('x1', X(best)); cross.setAttribute('x2', X(best)); cross.setAttribute('visibility', 'visible');
      let html = `<b>${(opt.tipx || opt.xfmt || ((z) => z))(best)}</b>`;
      opt.series.forEach((s) => {
        if (s.notip) return;
        let p = s.pts.find((q) => q[0] === best);
        if (!p && opt.x !== 'time') {
          const ok = s.pts.filter((q) => q[1] != null);
          let nb = null, nd = Infinity; ok.forEach((q) => { const dd = Math.abs(tx(q[0]) - tx(best)); if (dd < nd) { nd = dd; nb = q; } });
          if (nb && nd < 1e-9) p = nb;
          if (!p && s.interp) p = [best, s.interp(best)];
        }
        if (p && p[1] != null && isFinite(p[1])) html += `<div class="row"><span><i class="sw" style="background:${s.color}"></i>${esc(s.name)}</span><b>${(opt.tipy || opt.yfmt || ((z) => z))(p[1])}</b></div>`;
      });
      tip.innerHTML = html;
      tip.hidden = false;
      const left = Math.min(Math.max(ev.clientX - r.left + 14, 0), r.width - 170);
      tip.style.left = left + 'px'; tip.style.top = Math.max(ev.clientY - r.top - 20, 0) + 'px';
    };
    hit.addEventListener('mousemove', move);
    hit.addEventListener('mouseleave', () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); });
    if (opt.legend !== false) {
      const lg = h('div', { class: 'fi-legend' });
      opt.series.filter((s) => !s.nolegend).forEach((s) => {
        lg.appendChild(h('span', null, `<i class="${s.dots && s.line === false ? 'dot' : ''}${s.dash ? ' dash' : ''}" style="background:${s.color}"></i>${esc(s.name)}`));
      });
      el.appendChild(lg);
    }
  }

  function barChart(el, labels, values, opt) {
    el.innerHTML = '';
    const W = widthOf(el), H = opt.height || 200, m = { l: 60, r: 10, t: 10, b: 28 };
    const lo = Math.min(0, ...values), hi = Math.max(0, ...values), pad = (hi - lo) * 0.1 || 1;
    const y0 = lo - (lo < 0 ? pad : 0), y1 = hi + pad;
    const Y = (v) => H - m.b - (v - y0) / (y1 - y0) * (H - m.t - m.b);
    const bw = (W - m.l - m.r) / labels.length;
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opt.label || 'bar chart')}"><g class="grid">`;
    const yt = niceTicks(y0, y1, 4);
    yt.forEach((v) => { svg += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}"/>`; });
    svg += '</g><g class="axis">';
    yt.forEach((v) => { svg += `<text x="${m.l - 6}" y="${Y(v) + 4}" text-anchor="end">${(opt.yfmt || ((z) => z))(v)}</text>`; });
    labels.forEach((lb, i) => { svg += `<text x="${m.l + bw * (i + 0.5)}" y="${H - m.b + 18}" text-anchor="middle">${esc(lb)}</text>`; });
    svg += `<line class="baseline" x1="${m.l}" x2="${W - m.r}" y1="${Y(0)}" y2="${Y(0)}"/></g>`;
    values.forEach((v, i) => {
      const x = m.l + bw * i + bw * 0.18, w = bw * 0.64, y = Math.min(Y(v), Y(0)), hh = Math.max(Math.abs(Y(v) - Y(0)), v === 0 ? 0 : 1);
      svg += `<rect x="${x}" y="${y}" width="${w}" height="${hh}" rx="3" fill="${v >= 0 ? 'var(--s1)' : 'var(--s8)'}"><title>${esc(labels[i])}: ${(opt.tipy || opt.yfmt || ((z) => z))(v)}</title></rect>`;
    });
    el.innerHTML = svg + '</svg>';
  }

  // ------------------------------------------------------------------ layout
  function seg(name, items, current) {
    return `<div class="fi-seg" role="group" aria-label="${name}">${items.map(([v, l]) => `<button type="button" data-${name}="${v}" aria-pressed="${String(v) === String(current)}">${l}</button>`).join('')}</div>`;
  }

  function shell() {
    root.innerHTML = `
<div class="fi-shell">
  <div class="fi-top">
    <div class="fi-brand"><b>Fixed income relative-value terminal</b><span>Curves fitted live in your browser from official and derived data</span></div>
    <div class="fi-ctl"><span class="fi-label">Market</span>${seg('market', MARKETS.map((m) => [m, m]), S.market)}</div>
    <div class="fi-ctl"><label for="fi-date">Week ending</label><select id="fi-date"></select></div>
    <div class="fi-ctl"><label for="fi-method">Curve model</label><select id="fi-method">${METHODS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>
  </div>
  <div class="fi-grid">
    <section class="fi-card" aria-label="Yield curve">
      <div class="fi-card__head"><h3 id="fi-curve-title">Yield curve</h3>
        <div class="fi-ctl"><span class="fi-label">Show</span>${seg('view', [['par', 'Par'], ['zero', 'Zero'], ['fwd', '1y forward']], S.curveView)}</div>
        <div class="fi-ctl"><label for="fi-compare">Compare with</label><select id="fi-compare">${COMPARE.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>
      </div>
      <div class="fi-chart" id="fi-curve-chart"></div>
      <details style="margin-top:8px"><summary class="fi-note">Data table: observed vs fitted</summary><div class="fi-table-wrap" id="fi-curve-table"></div></details>
    </section>
    <section class="fi-card" aria-label="Fit and source">
      <div class="fi-card__head"><h3>Fit</h3><span id="fi-class"></span></div>
      <div class="fi-stats" id="fi-fit-stats"></div>
      <div id="fi-params"></div>
      <p class="fi-note" id="fi-source" style="margin-top:10px"></p>
    </section>
  </div>
  <div class="fi-grid">
    <section class="fi-card" aria-label="Curve history">
      <div class="fi-card__head"><h3>History</h3>
        <div class="fi-ctl"><label for="fi-spread">Series</label><select id="fi-spread"></select></div>
      </div>
      <div class="fi-chart" id="fi-hist-chart"></div>
    </section>
    <section class="fi-card" aria-label="Curve move decomposition">
      <div class="fi-card__head"><h3>What moved</h3><span class="fi-note" id="fi-move-span"></span></div>
      <div class="fi-chart" id="fi-move-chart"></div>
      <p class="fi-note" id="fi-move-note"></p>
    </section>
  </div>
  <div class="fi-card" style="border-bottom:0">
    <div class="fi-tabs" role="tablist">
      ${[['trade', 'Trade builder'], ['scanner', 'RV scanner'], ['country', 'Country comparison'], ['frpl', 'France vs Poland']].map(([v, l]) => `<button role="tab" data-tab="${v}" aria-selected="${S.tab === v}">${l}</button>`).join('')}
    </div>
    <div id="fi-tab-body"></div>
  </div>
  <div class="fi-foot" id="fi-foot"></div>
</div>`;
    root.addEventListener('click', onClick);
    $('#fi-date').addEventListener('change', (e) => { S.idx = +e.target.value; render(); });
    $('#fi-method').addEventListener('change', (e) => { S.method = e.target.value; render(); });
    $('#fi-compare').addEventListener('change', (e) => { S.compare = e.target.value; renderCurve(); renderMove(); });
    $('#fi-spread').addEventListener('change', (e) => { S.spread = e.target.value; renderHistory(); });
    $('#fi-method').value = S.method;
    $('#fi-compare').value = S.compare;
  }

  async function onClick(e) {
    const b = e.target.closest('button');
    if (!b || !root.contains(b)) return;
    if (b.dataset.market) {
      S.market = b.dataset.market;
      root.querySelectorAll('[data-market]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.market === S.market)));
      await selectMarket();
    } else if (b.dataset.view) {
      S.curveView = b.dataset.view;
      root.querySelectorAll('[data-view]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.view === S.curveView)));
      renderCurve();
    } else if (b.dataset.tab) {
      S.tab = b.dataset.tab;
      root.querySelectorAll('[data-tab]').forEach((x) => x.setAttribute('aria-selected', String(x.dataset.tab === S.tab)));
      renderTab();
    }
  }

  async function selectMarket() {
    const body = $('#fi-curve-chart');
    body.innerHTML = '<p class="fi-loading">Loading market data…</p>';
    const d = await loadMarket(S.market);
    S.idx = d.dates.length - 1;
    S.fundingOverride = null;
    const sel = $('#fi-date');
    sel.innerHTML = d.dates.map((x, i) => `<option value="${i}">${x}${i === d.dates.length - 1 ? ' (latest)' : ''}</option>`).reverse().join('');
    sel.value = String(S.idx);
    const sp = $('#fi-spread');
    const opts = spreadOptions(d);
    sp.innerHTML = opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    if (!opts.find((o) => o[0] === S.spread)) S.spread = opts[0][0];
    sp.value = S.spread;
    const avail = availTenors(d, S.idx);
    const snap = (t) => avail.reduce((b, x) => (Math.abs(x - t) < Math.abs(b - t) ? x : b), avail[0]);
    S.t1 = snap(S.t1); S.t2 = snap(S.t2); S.belly = snap(S.belly);
    if (S.cross === S.market) S.cross = S.market === 'DE' ? 'FR' : 'DE';
    render();
  }

  function availTenors(d, i) {
    // tenors with an observation on the selected week (no trades on extrapolated points)
    return d.tenors.filter((t, j) => t >= 1 && t <= d.max_tenor + 1e-9 && d.values[i][j] != null);
  }

  function spreadOptions(d) {
    const has = (t) => d.tenors.some((x) => Math.abs(x - t) < 1e-6);
    const o = [];
    if (has(2) && has(10)) o.push(['2s10s', '2s10s slope']);
    if (has(5) && has(30)) o.push(['5s30s', '5s30s slope']);
    if (has(2) && has(5) && has(10)) o.push(['fly2510', '2s5s10s butterfly']);
    if (has(10)) o.push(['l10', '10y level']);
    if (has(2)) o.push(['l2', '2y level']);
    return o;
  }

  function seriesFor(d, key) {
    const j = (t) => d.tenors.findIndex((x) => Math.abs(x - t) < 1e-6);
    // a missing observation must stay missing: in JavaScript null - 6.3 would be -6.3
    const v = (i, t) => { const x = d.values[i][j(t)]; return x == null ? NaN : x; };
    const f = {
      '2s10s': (i) => (v(i, 10) - v(i, 2)) * 100, '5s30s': (i) => (v(i, 30) - v(i, 5)) * 100,
      fly2510: (i) => (2 * v(i, 5) - v(i, 2) - v(i, 10)) * 100, l10: (i) => v(i, 10), l2: (i) => v(i, 2),
    }[key];
    return d.dates.map((ds, i) => { let y; try { y = f(i); } catch (e) { y = null; } return [Date.parse(ds), y == null || !isFinite(y) ? null : y]; });
  }

  // ------------------------------------------------------------------ render parts
  function render() {
    fitCache = {};
    renderCurve();
    renderFit();
    renderHistory();
    renderMove();
    renderTab();
    renderFoot();
  }

  function curveValue(curve, t, freq, view) {
    if (view === 'zero') return curve.zero(t) * 100;
    if (view === 'fwd') return curve.fwdSimple(t, t + 1) * 100;
    return curve.parYield(t, freq) * 100;
  }

  function renderCurve() {
    const d = cache[S.market];
    const r = fitAt(S.market, S.idx, S.method);
    const data = r.data, view = S.curveView;
    const maxT = Math.max(...data.tenors), minT = Math.min(...data.tenors);
    const grid = [];
    for (let k = 0; k <= 120; k++) grid.push(Math.exp(Math.log(Math.max(minT, 1 / 12)) + k / 120 * (Math.log(maxT) - Math.log(Math.max(minT, 1 / 12)))));
    const series = [{ name: `${METHODS.find((x) => x[0] === r.usedMethod)[1]} fit, ${d.dates[S.idx]}`, color: 'var(--s1)', pts: grid.map((t) => [t, curveValue(r.curve, t, d.freq, view)]), interp: (t) => curveValue(r.curve, t, d.freq, view) }];
    const obsKind = data.kind === 'zero' ? 'zero' : 'par';
    if (view === obsKind) series.push({ name: `Observed (${obsKind === 'zero' ? 'zero rates' : 'par yields'})`, color: 'var(--fi-ink-2)', line: false, dots: true, pts: data.tenors.map((t, i) => [t, data.values[i] * 100]) });
    if (S.compare !== 'none') {
      const ci = Math.max(0, S.idx - +S.compare);
      if (ci !== S.idx) {
        const rc = fitAt(S.market, ci, S.method);
        series.push({ name: `Same model, ${d.dates[ci]}`, color: 'var(--s2)', dash: true, pts: grid.map((t) => [t, curveValue(rc.curve, t, d.freq, view)]), interp: (t) => curveValue(rc.curve, t, d.freq, view) });
      }
    }
    const lbl = { par: 'Par yield', zero: 'Zero rate (cont. comp.)', fwd: '1-year forward rate' }[view];
    $('#fi-curve-title').textContent = `${d.name}: ${lbl.toLowerCase()} curve`;
    lineChart($('#fi-curve-chart'), {
      series, x: 'log', height: 290, label: `${d.name} ${lbl} curve`, yfmt: (v) => v.toFixed(2) + '%', tipy: (v) => v.toFixed(3) + '%',
      xticks: [0.25, 0.5, 1, 2, 3, 5, 7, 10, 20, 30, 40].filter((t) => t >= minT * 0.99 && t <= maxT * 1.01), xfmt: tenorLabel,
    });
    if (view !== obsKind) {
      $('#fi-curve-chart').appendChild(h('p', { class: 'fi-note' }, `The observations for this market are ${obsKind === 'zero' ? 'zero rates' : 'par yields'}; switch to ${obsKind === 'zero' ? 'Zero' : 'Par'} to see them against the fit.`));
    }
    const rows = data.tenors.map((t, i) => `<tr><td>${tenorLabel(t)}</td><td>${fmt(data.values[i] * 100, 3)}</td><td>${fmt(r.fitted[i] * 100, 3)}</td><td class="${cls(r.resid[i])}">${sgn(r.resid[i], 1)}</td></tr>`).join('');
    $('#fi-curve-table').innerHTML = `<table class="fi-table"><thead><tr><th>Tenor</th><th>Observed ${obsKind} %</th><th>Fitted %</th><th>Residual bp</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  function renderFit() {
    const d = cache[S.market];
    const r = fitAt(S.market, S.idx, S.method);
    const fundPct = d.funding[S.idx];
    $('#fi-fit-stats').innerHTML = [
      [fmt(r.rmse, 2) + ' bp', 'RMSE in sample'], [fmt(r.maxAbs, 2) + ' bp', 'largest residual'],
      [fmt(r.curve.parYield(10 <= Math.max(...r.data.tenors) ? 10 : Math.max(...r.data.tenors), d.freq) * 100, 3) + '%', '10y par yield (fitted)'],
      [fundPct == null ? '–' : fmt(fundPct, 2) + '%', 'funding: ' + d.funding_label],
    ].map(([b, s]) => `<div class="fi-stat"><b>${b}</b><span>${s}</span></div>`).join('');
    let ptab = '';
    if (r.usedMethod === 'ns' || r.usedMethod === 'nss') {
      const names = r.usedMethod === 'ns' ? ['β0 (long-run level)', 'β1 (slope)', 'β2 (curvature)', 'τ (years)'] : ['β0 (long-run level)', 'β1 (slope)', 'β2 (curvature 1)', 'β3 (curvature 2)', 'τ1 (years)', 'τ2 (years)'];
      ptab = `<table class="fi-kv"><tbody>${names.map((n, i) => `<tr><td>${n}</td><td>${n.startsWith('τ') ? fmt(r.params[i], 3) : fmt(r.params[i] * 100, 3) + '%'}</td></tr>`).join('')}</tbody></table>`;
      if (r.usedMethod === 'nss' && Math.abs(r.params[5] - r.params[4]) < 0.5) {
        ptab += '<p class="fi-note" style="margin-top:6px">τ1 and τ2 are close, so the two curvature terms are nearly collinear: β2 and β3 offset each other and are not separately interpretable, though the fitted curve is unaffected. Official Svensson curves do the same: Bundesbank and ECB taus are within 0.13 and 0.04 years of each other on 5% of days since 2000.</p>';
      }
    } else if (r.usedMethod === 'spline') ptab = '<p class="fi-note">Cubic B-spline forward curve with a roughness penalty (λ = 0.05 per bp²); knots at 0.5, 1, 2, 3, 5, 7, 10, 15, 20, 30 years.</p>';
    else ptab = `<p class="fi-note">${r.usedMethod === 'bootstrap' ? 'Exact bootstrap: par yields interpolated monotonically onto coupon dates, discount factors solved one date at a time.' : 'Natural cubic spline through zero rates (bootstrapped from par yields where needed): exact at the inputs, so judge it out of sample.'}</p>`;
    if (S.method === 'bootstrap' && r.usedMethod !== 'bootstrap') ptab = '<p class="fi-note">Bootstrap needs par yields; this market publishes a zero curve, so the cubic spline is shown.</p>' + ptab;
    $('#fi-params').innerHTML = ptab;
    $('#fi-class').innerHTML = `<span class="fi-badge${S.market === 'PL' ? ' fi-badge--derived' : ''}">${S.market === 'PL' ? 'derived' : d.source.class === 'estimate' ? 'official estimate' : 'official'}</span>`;
    let src = `${esc(d.classification)} <a href="${esc(d.source.url)}" rel="noopener" target="_blank">${esc(d.source.provider)}</a>.`;
    if (d.fit_stats) src += ` Bond-level fit to the latest fixing: ${d.fit_stats.latest_n_bonds} bonds, RMSE ${fmt(d.fit_stats.latest_rmse_bp, 2)} bp, longest bond ${fmt(d.fit_stats.latest_max_maturity, 1)} years (10y point extrapolated up to one year).`;
    $('#fi-source').innerHTML = src;
  }

  function renderHistory() {
    const d = cache[S.market];
    const pts = seriesFor(d, S.spread);
    const isLevel = S.spread.startsWith('l');
    const cur = pts[S.idx][1];
    const lo = Math.max(0, S.idx - 156), win = pts.slice(lo, S.idx + 1).map((p) => p[1]).filter((v) => v != null);
    const mu = win.reduce((s, v) => s + v, 0) / (win.length || 1), sd = Math.sqrt(win.reduce((s, v) => s + (v - mu) ** 2, 0) / Math.max(win.length - 1, 1));
    const series = [{ name: { '2s10s': '10y minus 2y', '5s30s': '30y minus 5y', fly2510: '2×5y − 2y − 10y', l10: '10y', l2: '2y' }[S.spread] + (isLevel ? ' (%)' : ' (bp)'), color: 'var(--s1)', pts, width: 1.6 }];
    series.push({ name: '3-year mean to selected week', color: 'var(--s2)', dash: true, pts: [[pts[lo][0], mu], [pts[S.idx][0], mu]], notip: true });
    series.push({ name: 'selected week', color: 'var(--fi-ink-2)', line: false, dots: true, pts: [[pts[S.idx][0], cur]], notip: true });
    const f = (v) => (isLevel ? v.toFixed(2) + '%' : v.toFixed(0) + ' bp');
    lineChart($('#fi-hist-chart'), {
      series, x: 'time', height: 230, label: 'history', yfmt: f, tipy: (v) => (isLevel ? v.toFixed(3) + '%' : v.toFixed(1) + ' bp'),
      xfmt: (t) => new Date(t).getUTCFullYear(), tipx: (t) => new Date(t).toISOString().slice(0, 10), zero: !isLevel,
    });
    const z = sd > 0 ? (cur - mu) / sd : NaN;
    const note = h('p', { class: 'fi-note', style: 'margin-top:6px' }, `Selected week: <b>${f(cur)}</b>; 3-year z-score <b>${sgn(z, 2)}</b> (mean ${f(mu)}, s.d. ${isLevel ? sd.toFixed(2) + ' pp' : sd.toFixed(0) + ' bp'}). Observed data only; weekly.`);
    $('#fi-hist-chart').appendChild(note);
  }

  function renderMove() {
    const d = cache[S.market];
    const ci = S.compare === 'none' ? Math.max(0, S.idx - 52) : Math.max(0, S.idx - +S.compare);
    const pca = d.pca;
    const el = $('#fi-move-chart');
    $('#fi-move-span').textContent = `${d.dates[ci]} → ${d.dates[S.idx]}`;
    if (!pca) { el.innerHTML = '<p class="fi-note">No PCA loadings for this market.</p>'; return; }
    // observed change at the PCA tenors (zero-rate markets: from the fitted par curve)
    const rNow = fitAt(S.market, S.idx, 'nss'), rThen = fitAt(S.market, ci, 'nss');
    const tens = pca.tenors;
    const ch = tens.map((t) => (rNow.curve.parYield(t, d.freq) - rThen.curve.parYield(t, d.freq)) * 1e4);
    const L = pca.loadings;
    const scores = [0, 1, 2].map((k) => tens.reduce((s, _, i) => s + ch[i] * L[i][k], 0));
    const fit3 = tens.map((_, i) => [0, 1, 2].reduce((s, k) => s + L[i][k] * scores[k], 0));
    lineChart(el, {
      series: [
        { name: 'change in par yield', color: 'var(--s1)', pts: tens.map((t, i) => [t, ch[i]]), dots: true },
        { name: 'level + slope + curvature', color: 'var(--s2)', dash: true, pts: tens.map((t, i) => [t, fit3[i]]) },
      ], x: 'log', height: 200, zero: true, label: 'curve move', yfmt: (v) => v.toFixed(0) + ' bp', tipy: (v) => v.toFixed(1) + ' bp',
      xticks: [1, 2, 5, 10, 20, 30].filter((t) => t <= Math.max(...tens) + 1e-9), xfmt: tenorLabel,
    });
    const nm = ['level (PC1)', 'slope (PC2)', 'curvature (PC3)'];
    const sdv = pca.vol_bp;
    $('#fi-move-note').innerHTML = 'Factor scores, in daily standard deviations: ' + scores.map((s, k) => `${nm[k]} <b>${sgn(s / sdv[k], 1)}</b>`).join(', ') +
      `. Loadings from daily changes ${pca.start}–${pca.end} (${(pca.explained.slice(0, 3).reduce((a, b) => a + b, 0) * 100).toFixed(0)}% of variance).`;
  }

  // ------------------------------------------------------------------ trade builder
  function tradeControls(d) {
    const ten = availTenors(d, S.idx);
    const opt = (sel) => ten.map((t) => `<option value="${t}" ${Math.abs(t - sel) < 1e-6 ? 'selected' : ''}>${tenorLabel(t)}</option>`).join('');
    const others = MARKETS.filter((m) => m !== S.market);
    const fly = S.structure === 'fly' || S.structure === 'flyshort';
    return `
<div class="fi-builder">
  <div class="fi-ctl"><label for="fi-struct">Structure</label><select id="fi-struct">${STRUCT.map(([v, l]) => `<option value="${v}" ${v === S.structure ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
  <div class="fi-ctl"><label for="fi-t1">${fly ? 'Short wing' : S.structure === 'outright' ? 'Tenor' : 'Short leg'}</label><select id="fi-t1">${opt(S.t1)}</select></div>
  ${fly ? `<div class="fi-ctl"><label for="fi-belly">Belly</label><select id="fi-belly">${opt(S.belly)}</select></div>` : ''}
  ${S.structure !== 'outright' && S.structure !== 'cross' ? `<div class="fi-ctl"><label for="fi-t2">${fly ? 'Long wing' : 'Long leg'}</label><select id="fi-t2">${opt(S.t2)}</select></div>` : ''}
  ${S.structure === 'cross' ? `<div class="fi-ctl"><label for="fi-cross">Short market</label><select id="fi-cross">${others.map((m) => `<option ${m === S.cross ? 'selected' : ''}>${m}</option>`).join('')}</select></div>` : ''}
  ${fly ? `<div class="fi-ctl"><label for="fi-weight">Wing weights</label><select id="fi-weight">${[['50/50', '50/50 DV01'], ['regression', 'Regression (2y weekly)'], ['pca', 'PCA-neutral (PC1, PC2)']].map(([v, l]) => `<option value="${v}" ${v === S.weighting ? 'selected' : ''}>${l}</option>`).join('')}</select></div>` : ''}
  ${S.structure === 'steep' || S.structure === 'flat' || S.structure === 'cross' ? `<div class="fi-ctl"><label for="fi-hedge">Hedge ratio</label><select id="fi-hedge">${[['dv01', 'DV01-neutral'], ['beta', 'Beta-weighted (2y weekly)']].map(([v, l]) => `<option value="${v}" ${v === S.hedge ? 'selected' : ''}>${l}</option>`).join('')}</select></div>` : ''}
  <div class="fi-ctl"><label for="fi-dv01">DV01 per bp (${d.currency})</label><input id="fi-dv01" type="number" min="100" step="1000" value="${S.dv01}"></div>
  <div class="fi-ctl"><span class="fi-label">Horizon</span>${seg('hz', HORIZONS.map(([v, l]) => [v, l]), S.horizon)}</div>
  <div class="fi-ctl"><label for="fi-fund">Funding %</label><input id="fi-fund" type="number" step="0.05" value="${(S.fundingOverride != null ? S.fundingOverride : d.funding[S.idx] || 0).toFixed(2)}"></div>
</div>`;
  }

  function weeklyChanges(d, tenor, n) {
    // weekly changes (bp) of observed yields interpolated linearly in tenor, for the n weeks
    // up to the selected week (located by date in this market's own calendar)
    const end = nearestIdx(d, cache[S.market].dates[S.idx]);
    const out = [];
    const val = (i) => { const pts = d.tenors.map((t, j) => [t, d.values[i][j]]).filter((p) => p[1] != null); return F.interp(tenor, pts.map((p) => p[0]), pts.map((p) => p[1])); };
    for (let i = Math.max(1, end - n + 1); i <= end; i++) out.push({ date: d.dates[i], v: (val(i) - val(i - 1)) * 100 });
    return out;
  }

  function regBeta(y, x) {
    const n = Math.min(y.length, x.length);
    let sxy = 0, sxx = 0, mx = 0, my = 0;
    for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
    mx /= n; my /= n;
    for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; }
    return sxx > 0 ? sxy / sxx : 1;
  }

  async function buildTrade() {
    const d = cache[S.market];
    const curves = {};
    const r = fitAt(S.market, S.idx, S.method);
    curves[S.market] = r.curve;
    const fund = {};
    fund[S.market] = (S.fundingOverride != null ? S.fundingOverride : d.funding[S.idx]) / 100;
    const ccy = d.currency;
    let legs, notes = [];
    if (S.structure === 'steep' || S.structure === 'flat') {
      const [a, b] = [Math.min(S.t1, S.t2), Math.max(S.t1, S.t2)];
      let beta = 1;
      if (S.hedge === 'beta') {
        const ys = weeklyChanges(d, a, 104).map((o) => o.v), yl = weeklyChanges(d, b, 104).map((o) => o.v);
        beta = regBeta(yl, ys);
        notes.push(`Beta of ${tenorLabel(b)} on ${tenorLabel(a)} weekly changes (2 years): ${beta.toFixed(2)}; the ${tenorLabel(a)} leg carries ${beta.toFixed(2)}× the DV01.`);
      }
      const s = S.structure === 'flat' ? -1 : 1;
      legs = [F.legFor(F.parBond(curves, S.market, a, d.freq), curves, s * S.dv01 * beta, `${s > 0 ? 'Buy' : 'Sell'} ${tenorLabel(a)}`),
        F.legFor(F.parBond(curves, S.market, b, d.freq), curves, -s * S.dv01, `${s > 0 ? 'Sell' : 'Buy'} ${tenorLabel(b)}`)];
    } else if (S.structure === 'fly' || S.structure === 'flyshort') {
      const a = S.t1, c = S.t2, bl = S.belly;
      let w = [0.5, 0.5];
      if (S.weighting === 'regression') {
        const dS = weeklyChanges(d, a, 104).map((o) => o.v), dB = weeklyChanges(d, bl, 104).map((o) => o.v), dL = weeklyChanges(d, c, 104).map((o) => o.v);
        w = F.regressionWeights(dS, dB, dL);
        notes.push(`Regression of ${tenorLabel(bl)} weekly changes on the wings (2 years): ${w[0].toFixed(2)} × ${tenorLabel(a)} + ${w[1].toFixed(2)} × ${tenorLabel(c)}.`);
      } else if (S.weighting === 'pca') {
        const p = d.pca, ix = (t) => p.tenors.findIndex((x) => Math.abs(x - t) < 1e-6);
        if ([a, bl, c].every((t) => ix(t) >= 0)) {
          const L = [a, bl, c].map((t) => [p.loadings[ix(t)][0], p.loadings[ix(t)][1]]);
          w = F.pcaFlyWeights(L);
          notes.push(`PCA-neutral wings: ${w[0].toFixed(2)} and ${w[1].toFixed(2)} of the belly DV01 make the fly insensitive to level and slope (loadings ${p.start}–${p.end}).`);
        } else notes.push('PCA loadings are not available at these tenors; 50/50 weights used.');
      }
      legs = F.butterfly(curves, S.market, [a, c], bl, S.dv01, w, S.structure === 'flyshort' ? 'short_belly' : 'long_belly', d.freq);
    } else if (S.structure === 'cross') {
      const d2 = await loadMarket(S.cross);
      const i2 = nearestIdx(d2, d.dates[S.idx]);
      const r2 = fitAt(S.cross, i2, S.method);
      curves[S.cross] = r2.curve;
      fund[S.cross] = d2.funding[i2] / 100;
      const T2 = d2.tenors.some((x) => Math.abs(x - S.t1) < 1e-6) ? S.t1 : 10;
      let beta = 1;
      if (S.hedge === 'beta') {
        const y1 = weeklyChanges(d, S.t1, 104), y2 = weeklyChanges(d2, T2, 104);
        const m2 = Object.fromEntries(y2.map((o) => [o.date, o.v]));
        const pairs = y1.filter((o) => m2[o.date] != null);
        beta = regBeta(pairs.map((o) => o.v), pairs.map((o) => m2[o.date]));
        notes.push(`Beta of ${S.market} ${tenorLabel(S.t1)} on ${S.cross} ${tenorLabel(T2)} weekly changes (2 years): ${beta.toFixed(2)}.`);
      }
      const fx = fxConv(d.currency, d2.currency, d.dates[S.idx]);
      legs = [F.legFor(F.parBond(curves, S.market, S.t1, d.freq), curves, S.dv01, `Buy ${S.market} ${tenorLabel(S.t1)}`),
        F.legFor(F.parBond(curves, S.cross, T2, d2.freq), curves, -S.dv01 * beta * fx, `Sell ${S.cross} ${tenorLabel(T2)}`)];
      if (d.currency !== d2.currency) notes.push(`The ${S.cross} leg's DV01 is converted at ${fx.toFixed(4)} ${d2.currency} per ${d.currency} (ECB reference rate). P&L of each leg is in its own currency; the currency risk of the P&L itself is not hedged.`);
      notes.push(`Each leg is financed at its own short rate (${S.market} ${fmt(fund[S.market] * 100, 2)}%, ${S.cross} ${fmt(fund[S.cross] * 100, 2)}%).`);
    } else {
      legs = [F.legFor(F.parBond(curves, S.market, S.t1, d.freq), curves, S.dv01, `Buy ${tenorLabel(S.t1)}`)];
    }
    return { legs, curves, fund, ccy, notes };
  }

  function legCcy(leg) { return cache[leg.ins.curve].currency; }

  async function renderTrade(body) {
    const d = cache[S.market];
    body.innerHTML = tradeControls(d) + '<div id="fi-trade-out"><p class="fi-loading">Pricing…</p></div>';
    const bind = (id, fn) => { const e = body.querySelector(id); if (e) e.addEventListener('change', fn); };
    bind('#fi-struct', (e) => {
      S.structure = e.target.value;
      if (S.structure === 'fly' || S.structure === 'flyshort') { S.t1 = 2; S.belly = 5; S.t2 = 10; }
      else if (S.structure === 'cross') { S.t1 = 10; }
      else if (S.structure !== 'outright' && S.t1 >= S.t2) { S.t1 = 2; S.t2 = 10; }
      renderTab();
    });
    bind('#fi-t1', (e) => { S.t1 = +e.target.value; renderTab(); });
    bind('#fi-t2', (e) => { S.t2 = +e.target.value; renderTab(); });
    bind('#fi-belly', (e) => { S.belly = +e.target.value; renderTab(); });
    bind('#fi-cross', (e) => { S.cross = e.target.value; renderTab(); });
    bind('#fi-weight', (e) => { S.weighting = e.target.value; renderTab(); });
    bind('#fi-hedge', (e) => { S.hedge = e.target.value; renderTab(); });
    bind('#fi-dv01', (e) => { S.dv01 = Math.max(1, +e.target.value || 10000); renderTab(); });
    bind('#fi-fund', (e) => { S.fundingOverride = +e.target.value; renderTab(); });
    body.querySelectorAll('[data-hz]').forEach((b) => b.addEventListener('click', () => { S.horizon = +b.dataset.hz; renderTab(); }));
    let T;
    try { T = await buildTrade(); } catch (err) { $('#fi-trade-out').innerHTML = `<p class="fi-error">${esc(err.message)}</p>`; return; }
    const { legs, curves, fund, ccy, notes } = T;
    const keys = Array.from(new Set(legs.map((l) => l.ins.curve)));
    const legRows = legs.map((l) => {
      const c = legCcy(l), ydv = l.notional * l.ins.yieldDV01(curves), zdv = F.dv01([l], curves);
      return `<tr><td class="txt">${esc(l.label)}</td><td>${tenorLabel(l.ins.T)}</td><td>${fmt(l.ins.coupon * 100, 3)}%</td><td>${fmtMoney(l.notional, c)}</td><td class="${cls(ydv)}">${fmtMoney(ydv, c)}</td><td class="${cls(zdv)}">${fmtMoney(zdv, c)}</td></tr>`;
    }).join('');
    // carry and roll per leg in its own currency, converted to the base currency
    const dateStr = d.dates[S.idx];
    const cr = { total: 0, carry: 0, roll: 0 };
    legs.forEach((l) => {
      const c = F.carryRoll([l], curves, S.horizon, fund), fx = fxConv(legCcy(l), ccy, dateStr);
      cr.total += c.total * fx; cr.carry += c.carry * fx; cr.roll += c.roll * fx;
    });
    const krd = F.keyRateDV01(legs, curves);
    const netZero = keys.map((k) => `${k}: ${fmtMoney(F.dv01(legs, curves, [k]), cache[k].currency)}`).join(' · ');
    // P&L volatility from 2 years of weekly changes of each leg's yield, aligned by date
    const chMaps = legs.map((l) => Object.fromEntries(weeklyChanges(cache[l.ins.curve], l.ins.T, 104).map((o) => [o.date, o.v])));
    const dates = Object.keys(chMaps[0]).filter((dt) => chMaps.every((mp) => mp[dt] != null && isFinite(mp[dt])));
    const w = legs.map((l) => l.notional * l.ins.yieldDV01(curves) * fxConv(legCcy(l), ccy, d.dates[S.idx]));
    const pnlW = dates.map((dt) => -w.reduce((s, wi, j) => s + wi * chMaps[j][dt], 0));
    const n = Math.max(pnlW.length, 1);
    const mu = pnlW.reduce((s, v) => s + v, 0) / n;
    const vol = Math.sqrt(pnlW.reduce((s, v) => s + (v - mu) ** 2, 0) / Math.max(n - 1, 1)) * Math.sqrt(52);
    const scale = Math.max(...legs.map((l) => Math.abs(l.notional * l.ins.yieldDV01(curves) * fxConv(legCcy(l), ccy, dateStr))));
    const crBp = cr.total / scale;
    const annCR = cr.total / S.horizon;
    const kt = F.KEY_TENORS.map((t) => tenorLabel(t));
    const out = $('#fi-trade-out');
    out.innerHTML = `
<div class="fi-table-wrap"><table class="fi-table"><thead><tr><th>Leg</th><th>Tenor</th><th>Coupon (par)</th><th>Notional</th><th>Yield DV01</th><th>Zero-curve DV01</th></tr></thead><tbody>${legRows}</tbody></table></div>
<p class="fi-note" style="margin:6px 0 12px">Net zero-curve DV01 by curve (gain for a 1 bp parallel fall): ${netZero}. ${notes.map(esc).join(' ')}</p>
<div class="fi-grid fi-grid--even" style="border-top:1px solid var(--fi-rule)">
  <div class="fi-card" style="padding-left:0">
    <h4>Carry and roll-down over ${HORIZONS.find((x) => x[0] === S.horizon)[1]}, curves unchanged</h4>
    <div class="fi-row" style="margin:8px 0 10px">
      <div><div class="fi-big ${cls(cr.total)}">${fmtMoney(cr.total, ccy)}</div><span class="fi-note">total (${sgn(crBp, 2)} bp of the largest leg DV01)</span></div>
      <div><div class="fi-big">${fmtMoney(cr.carry, ccy)}</div><span class="fi-note">carry</span></div>
      <div><div class="fi-big">${fmtMoney(cr.roll, ccy)}</div><span class="fi-note">roll-down</span></div>
    </div>
    <div class="fi-row"><div><div class="fi-big">${fmtMoney(vol, ccy)}</div><span class="fi-note">annual P&amp;L volatility (2y of weekly yield changes)</span></div>
      <div><div class="fi-big">${isFinite(annCR / vol) ? (annCR / vol).toFixed(2) : '–'}</div><span class="fi-note">carry + roll per year ÷ volatility</span></div></div>
  </div>
  <div class="fi-card">
    ${keys.map((k, i) => `<h4${i ? ' style="margin-top:10px"' : ''}>Key-rate DV01, ${keys.length > 1 ? k + ' ' : ''}zero curve (${cache[k].currency} per bp fall)</h4><div class="fi-chart" id="fi-krd-${k}"></div>`).join('')}
  </div>
</div>
<h4 style="margin:14px 0 6px">Scenario P&amp;L (${ccy}), full revaluation</h4>
<div class="fi-table-wrap" id="fi-scen"></div>
<p class="fi-note" style="margin-top:6px">"At horizon" applies the shock after ${HORIZONS.find((x) => x[0] === S.horizon)[1]} of carry and roll-down, to the aged trade. Legs lose DV01 at different speeds as they age, so a DV01-neutral trade drifts unless it is rebalanced; that drift is part of this column.</p>
<h4 style="margin:14px 0 4px">Custom shock (bp, interpolated between 2y, 5y, 10y and 30y)</h4>
<div class="fi-sliders">${[2, 5, 10, 30].map((t) => `<div><label for="fi-sh${t}"><span>${t}y</span><b id="fi-shv${t}">${S.shocks[t]}</b></label><input type="range" id="fi-sh${t}" min="-100" max="100" step="5" value="${S.shocks[t]}"></div>`).join('')}</div>
${keys.length > 1 ? `<label class="fi-note"><input type="checkbox" id="fi-both" ${S.shockBoth ? 'checked' : ''}> apply the custom shock to both markets</label>` : ''}
<div class="fi-row" id="fi-custom" style="margin-top:6px"></div>`;
    keys.forEach((k) => {
      barChart($('#fi-krd-' + k), kt, krd[k], { height: keys.length > 1 ? 130 : 170, label: `key-rate DV01 ${k}`,
        yfmt: (v) => Math.round(v).toLocaleString('en-US'), tipy: (v) => fmtMoney(v, cache[k].currency) });
    });
    renderScenarios(legs, curves, fund, ccy, keys);
    [2, 5, 10, 30].forEach((t) => {
      const inp = $('#fi-sh' + t);
      inp.addEventListener('input', () => { S.shocks[t] = +inp.value; $('#fi-shv' + t).textContent = inp.value; renderCustom(legs, curves, fund, ccy, keys); });
    });
    const both = $('#fi-both');
    if (both) both.addEventListener('change', () => { S.shockBoth = both.checked; renderCustom(legs, curves, fund, ccy, keys); });
    renderCustom(legs, curves, fund, ccy, keys);
  }

  function shockFn(ts, bps) { return (t) => F.interp(t, ts, bps) * 1e-4; }

  function scenarioList(keys) {
    const d = cache[S.market];
    const L = [
      ['Parallel +50 bp', [1, 30], [50, 50]], ['Parallel −50 bp', [1, 30], [-50, -50]],
      ['Parallel +100 bp', [1, 30], [100, 100]], ['Parallel −100 bp', [1, 30], [-100, -100]],
      ['Bear steepener: 2y 0, 10y +25', [2, 10], [0, 25]], ['Bull steepener: 2y −25, 10y 0', [2, 10], [-25, 0]],
      ['Bear flattener: 2y +25, 10y 0', [2, 10], [25, 0]], ['Bull flattener: 2y 0, 10y −25', [2, 10], [0, -25]],
      ['Belly +10: 2y 0, 5y +10, 10y 0', [2, 5, 10], [0, 10, 0]],
    ].map(([n, t, b]) => ({ name: n, shocks: Object.fromEntries(keys.map((k) => [k, shockFn(t, b)])), kind: 'hypothetical' }));
    if (d.pca) {
      const p = d.pca;
      [0, 1, 2].forEach((k) => {
        const bp = p.tenors.map((_, i) => p.loadings[i][k] * p.vol_bp[k] * Math.sqrt(21) * 2);
        L.push({ name: `PC${k + 1} +2 s.d. over a month (${['level', 'slope', 'curvature'][k]})`, shocks: { [S.market]: shockFn(p.tenors, bp) }, kind: 'statistical' });
      });
    }
    (d.episodes || []).forEach((e) => {
      const ts = Object.keys(e.change_bp).map(Number), bp = ts.map((t) => e.change_bp[String(t)] != null ? e.change_bp[String(t)] : e.change_bp[t.toFixed(1)]);
      L.push({ name: `History ${e.start} → ${e.end} (largest ${e.factor === 'PC1' ? 'level' : 'slope'} move)`, shocks: { [S.market]: shockFn(ts, bp) }, kind: 'historical' });
    });
    if (keys.length > 1) {
      L.push({ name: `${keys[0]} +25 bp, ${keys[1]} unchanged`, shocks: { [keys[0]]: shockFn([1, 30], [25, 25]) }, kind: 'hypothetical' });
      L.push({ name: `${keys[1]} +25 bp, ${keys[0]} unchanged`, shocks: { [keys[1]]: shockFn([1, 30], [25, 25]) }, kind: 'hypothetical' });
    }
    return L;
  }

  function pnlInBase(legs, curves, shocked, h, fund, ccy) {
    // per-leg P&L converted to the base currency
    const date = cache[S.market].dates[S.idx];
    let tot = 0;
    for (const l of legs) {
      const p = F.scenarioPnL([l], curves, shocked, h, fund).pnl;
      tot += p * fxConv(legCcy(l), ccy, date);
    }
    return tot;
  }

  function renderScenarios(legs, curves, fund, ccy, keys) {
    const rows = scenarioList(keys).map((sc) => {
      const shocked = {};
      for (const [k, fn] of Object.entries(sc.shocks)) if (curves[k]) shocked[k] = curves[k].shifted(fn);
      const now = pnlInBase(legs, curves, shocked, 0, fund, ccy), hz = pnlInBase(legs, curves, shocked, S.horizon, fund, ccy);
      return `<tr><td class="txt">${esc(sc.name)}</td><td class="txt fi-note">${sc.kind}</td><td class="${cls(now)}">${fmtMoney(now)}</td><td class="${cls(hz)}">${fmtMoney(hz)}</td></tr>`;
    }).join('');
    $('#fi-scen').innerHTML = `<table class="fi-table"><thead><tr><th>Scenario</th><th class="txt">Type</th><th>Now</th><th>At horizon, incl. carry</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  function renderCustom(legs, curves, fund, ccy, keys) {
    const ts = [2, 5, 10, 30], bp = ts.map((t) => S.shocks[t]);
    const fn = shockFn(ts, bp);
    const shocked = {};
    (S.shockBoth ? keys : [keys[0]]).forEach((k) => { shocked[k] = curves[k].shifted(fn); });
    const now = pnlInBase(legs, curves, shocked, 0, fund, ccy), hz = pnlInBase(legs, curves, shocked, S.horizon, fund, ccy);
    $('#fi-custom').innerHTML = `<div><div class="fi-big ${cls(now)}">${fmtMoney(now, ccy)}</div><span class="fi-note">instant</span></div><div><div class="fi-big ${cls(hz)}">${fmtMoney(hz, ccy)}</div><span class="fi-note">at horizon, with carry and roll</span></div>`;
  }

  // ------------------------------------------------------------------ static research tabs
  function tableHTML(rows, cols) {
    return `<div class="fi-table-wrap"><table class="fi-table"><thead><tr>${cols.map((c) => `<th class="${c.txt ? 'txt' : ''}">${c.label}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${cols.map((c) => {
      const v = r[c.key];
      const s = c.fmt ? c.fmt(v, r) : v == null ? '–' : esc(v);
      return `<td class="${c.txt ? 'txt' : ''} ${c.sign ? cls(v) : ''}">${s}</td>`;
    }).join('')}</tr>`).join('')}</tbody></table></div>`;
  }

  function renderScanner(body) {
    if (!common) { body.innerHTML = '<p class="fi-loading">Loading…</p>'; return; }
    const m = S.market;
    const rows = common.scanner.filter((r) => r.market === m || (r.market || '').split('-').includes(m));
    const res = common.pca_residuals.filter((r) => r.market === m);
    body.innerHTML = `<p class="fi-note" style="margin-bottom:8px">Snapshot from the research run (as of ${esc(rows[0] ? rows[0].asof : '')}). X is the spread each trade gains from; z-scores use weekly data. Mean-reversion signals of this kind are backtested in the repository: most did not survive costs out of sample, so this is a measurement, not a recommendation.</p>` +
      tableHTML(rows, [
        { key: 'trade', label: 'Trade', txt: true }, { key: 'level_bp', label: 'X (bp)', fmt: (v) => fmt(v, 1) },
        { key: 'z_1y', label: 'z 1y', fmt: (v) => sgn(v, 2), sign: true }, { key: 'z_3y', label: 'z 3y', fmt: (v) => sgn(v, 2), sign: true },
        { key: 'pct_5y', label: '5y pctile', fmt: (v) => fmt(v, 0) }, { key: 'chg_3m_bp', label: '3m chg', fmt: (v) => sgn(v, 1), sign: true },
        { key: 'carry_roll_3m', label: 'carry+roll 3m (bp)', fmt: (v) => sgn(v, 2), sign: true },
        { key: 'vol_ann_bp', label: 'vol (bp/yr)', fmt: (v) => fmt(v, 0) }, { key: 'carry_to_vol', label: 'carry/vol', fmt: (v) => sgn(v, 2), sign: true },
        { key: 'half_life_w', label: 'half-life (w)', fmt: (v) => (v == null ? '–' : v > 500 ? '>500' : fmt(v, 0)) },
      ]) + `<h4 style="margin:14px 0 6px">PCA rich/cheap by tenor (3 factors on 2 years of yield levels; positive = cheap)</h4>` +
      tableHTML(res, [{ key: 'tenor', label: 'Tenor', fmt: (v) => tenorLabel(v) }, { key: 'yield_pct', label: 'Yield %', fmt: (v) => fmt(v, 3) },
        { key: 'pca_resid_bp', label: 'Residual (bp)', fmt: (v) => sgn(v, 1), sign: true }, { key: 'resid_z', label: 'z', fmt: (v) => sgn(v, 2), sign: true }]);
  }

  function renderCountry(body) {
    if (!common) { body.innerHTML = '<p class="fi-loading">Loading…</p>'; return; }
    const C = common.country, mk = C.map((r) => r.market);
    const rows = [
      ['2y yield %', 'y2', 3], ['5y yield %', 'y5', 3], ['10y yield %', 'y10', 3], ['30y yield %', 'y30', 3],
      ['2s10s slope (bp)', 'slope_2s10s_bp', 0], ['Policy rate %', 'policy_rate', 2], ['1y rate in 1y (1y1y fwd) %', 'fwd_1y1y', 2],
      ['Implied 1y change in 1y rate (bp)', 'implied_1y_change_bp', 0], ['CPI inflation, y/y %', 'cpi_yoy', 2], ['CPI month', 'cpi_month', null],
      ['10y minus CPI %', 'real_10y_expost', 2], ['10y real yield (linkers) %', 'real_10y_market', 2], ['10y breakeven %', 'breakeven_10y', 2],
      ['Gross debt, % GDP (OECD, 2025)', 'debt_gdp_2025', 1], ['Gross debt, % GDP (OECD proj. 2027)', 'debt_gdp_2027_proj', 1],
      ['Net lending, % GDP (2025)', 'deficit_gdp_2025', 1], ['10y spread vs Germany (bp)', 'spread_10y_vs_DE_bp', 0],
      ['10y spread vs US (bp)', 'spread_10y_vs_US_bp', 0], ['10y yield vol, 1y (bp/yr)', 'vol_10y_bp_ann', 0],
      ['10y hedged into EUR %', 'hedged_10y_in_EUR', 2], ['10y hedged into USD %', 'hedged_10y_in_USD', 2],
    ];
    body.innerHTML = `<p class="fi-note" style="margin-bottom:8px">Par yields in each market's own convention as of ${esc(C[0].asof)}. Forwards include term premia. Hedged yields use covered interest parity with overnight/policy rates as the short-rate proxy. Fiscal data: OECD Economic Outlook (2027 is a projection); inflation: BIS consumer price series.</p>
<div class="fi-table-wrap"><table class="fi-table"><thead><tr><th>Measure</th>${mk.map((m) => `<th>${m}</th>`).join('')}</tr></thead><tbody>${rows.map(([l, k, dp]) => `<tr><td class="txt">${l}</td>${C.map((r) => `<td>${dp == null ? esc(r[k] || '–') : fmt(r[k], dp)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }

  function renderFrPl(body) {
    if (!common) { body.innerHTML = '<p class="fi-loading">Loading…</p>'; return; }
    const f = common.frpl, t = f.dates.map((x) => Date.parse(x));
    body.innerHTML = `<p class="fi-note" style="margin-bottom:8px">Weekly. Poland: NSS fit to the BondSpot fixing (derived); France: Banque de France TEC. The case study sets out evidence and evaluates candidate trades with the same backtester; it does not start from a conclusion. Full write-up in the repository.</p>
<div class="fi-grid"><div class="fi-card" style="border-bottom:0;padding-left:0"><h4>Poland minus France, local-currency yields (bp)</h4><div class="fi-chart" id="fi-frpl1"></div></div>
<div class="fi-card" style="border-bottom:0"><h4>10y: hedged into EUR vs unhedged pickup (bp)</h4><div class="fi-chart" id="fi-frpl2"></div></div></div>
<h4 style="margin:10px 0 6px">Candidate trades, weekly backtests (P&L in bp per unit DV01; costs: Polish bid/offer from the fixing)</h4><div id="fi-frpl-tab"></div>`;
    const mk = (k) => t.map((x, i) => [x, f[k][i]]);
    const tf = (v) => new Date(v).getUTCFullYear();
    lineChart($('#fi-frpl1'), { series: [{ name: '2y', color: 'var(--s1)', pts: mk('pl_fr_2y') }, { name: '5y', color: 'var(--s2)', pts: mk('pl_fr_5y') }, { name: '10y', color: 'var(--s3)', pts: mk('pl_fr_10y') }], x: 'time', height: 220, zero: true, yfmt: (v) => v.toFixed(0), tipy: (v) => v.toFixed(1) + ' bp', xfmt: tf, tipx: (v) => new Date(v).toISOString().slice(0, 10) });
    lineChart($('#fi-frpl2'), { series: [{ name: 'unhedged PL−FR 10y', color: 'var(--s3)', pts: mk('pl_fr_10y') }, { name: 'PL 10y hedged to EUR − FR 10y', color: 'var(--s1)', pts: mk('hedged_pickup') }], x: 'time', height: 220, zero: true, yfmt: (v) => v.toFixed(0), tipy: (v) => v.toFixed(1) + ' bp', xfmt: tf, tipx: (v) => new Date(v).toISOString().slice(0, 10) });
    $('#fi-frpl-tab').innerHTML = tableHTML(common.frpl_trades, [
      { key: 'trade', label: 'Trade', txt: true }, { key: 'signal', label: 'Signal', txt: true }, { key: 'test', label: 'Test', txt: true },
      { key: 'ann_return_bp', label: 'Return (bp/yr)', fmt: (v) => sgn(v, 1), sign: true }, { key: 'ann_vol_bp', label: 'Vol', fmt: (v) => fmt(v, 0) },
      { key: 'sharpe', label: 'Sharpe', fmt: (v) => sgn(v, 2), sign: true }, { key: 't_nw', label: 't (NW)', fmt: (v) => sgn(v, 2) },
      { key: 'max_dd_bp', label: 'Max DD', fmt: (v) => fmt(v, 0) }, { key: 'cost_bp_per_year', label: 'Cost/yr', fmt: (v) => fmt(v, 1) },
    ]);
  }

  async function renderTab() {
    const body = $('#fi-tab-body');
    if (!common && S.tab !== 'trade') {
      try { common = await (await fetch(BASE + 'data/common.json')).json(); } catch (e) { body.innerHTML = '<p class="fi-error">Could not load research tables.</p>'; return; }
    }
    if (S.tab === 'trade') await renderTrade(body);
    else if (S.tab === 'scanner') renderScanner(body);
    else if (S.tab === 'country') renderCountry(body);
    else renderFrPl(body);
  }

  function renderFoot() {
    const d = cache[S.market];
    $('#fi-foot').innerHTML = `Data for ${esc(d.name)} through ${esc(d.dates[d.dates.length - 1])}: ${esc(d.source.title)}, ${esc(d.source.provider)} (${esc(d.source.class)}). Weekly observations (last observation of each week) since ${esc(d.dates[0])}. Curves, risk, carry and scenarios are computed in your browser by <code>firv.js</code>, a port of the Python engine checked against it value by value. Scenario shocks are hypothetical or taken from the data as labelled; nothing here is a market quote for trading or investment advice. Code, data sources and methodology: <a href="https://github.com/RasmusCodes/fixed-income-rv-engine" rel="noopener" target="_blank">github.com/RasmusCodes/fixed-income-rv-engine</a>.`;
  }

  // ------------------------------------------------------------------ shareable state (URL hash)
  const HASH_KEYS = { m: 'market', mth: 'method', tab: 'tab', s: 'structure', t1: 't1', t2: 't2', b: 'belly', x: 'cross',
    w: 'weighting', h: 'hedge', dv: 'dv01', hz: 'horizon', cmp: 'compare', v: 'curveView', sp: 'spread' };
  const NUMERIC = new Set(['t1', 't2', 'belly', 'dv01', 'horizon']);
  let pendingDate = null;

  function readHash() {
    const q = new URLSearchParams(location.hash.replace(/^#/, ''));
    for (const [k, prop] of Object.entries(HASH_KEYS)) {
      if (!q.has(k)) continue;
      const v = q.get(k);
      if (prop === 'market' && !MARKETS.includes(v)) continue;
      S[prop] = NUMERIC.has(prop) ? +v : v;
    }
    if (q.has('d')) pendingDate = q.get('d');
  }

  function writeHash() {
    const q = new URLSearchParams();
    for (const [k, prop] of Object.entries(HASH_KEYS)) q.set(k, String(S[prop]));
    const d = cache[S.market];
    if (d && S.idx != null && S.idx !== d.dates.length - 1) q.set('d', d.dates[S.idx]);
    try { history.replaceState(null, '', '#' + q.toString()); } catch (e) { /* file:// or sandboxed */ }
  }

  const _render = render;
  render = function () { _render(); writeHash(); };
  const _renderTab = renderTab;
  renderTab = async function () { await _renderTab(); writeHash(); };

  let lastW = 0, rt = null;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      const w = root.getBoundingClientRect().width;
      if (Math.abs(w - lastW) > 40 && cache[S.market]) { lastW = w; renderCurve(); renderHistory(); renderMove(); renderTab(); }
    }, 250);
  });

  // ------------------------------------------------------------------ boot
  (async function boot() {
    readHash();
    shell();
    lastW = root.getBoundingClientRect().width;
    try {
      common = await (await fetch(BASE + 'data/common.json')).json();
    } catch (e) { common = null; }
    try {
      await selectMarket();
      if (pendingDate) {
        const d = cache[S.market];
        S.idx = nearestIdx(d, pendingDate);
        pendingDate = null;
        $('#fi-date').value = String(S.idx);
        render();
      }
    } catch (e) { root.innerHTML = `<p class="fi-error">The terminal could not start: ${esc(e.message)}</p>`; }
  })();
})();
