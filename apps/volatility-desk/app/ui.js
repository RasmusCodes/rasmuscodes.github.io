// DOM helpers, formatting, accessible controls, theme observer.

export const SVGNS = 'http://www.w3.org/2000/svg';
let uid = 0;
export const nextId = (p = 'vd') => `${p}-${++uid}`;

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** HTML element builder: h('div', {class: 'x', onclick: f}, ...children). */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

/** SVG element builder. */
export function s(tag, attrs, ...children) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  append(el, children);
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

// ------------------------------------------------------------------ formatting
const MINUS = '−';
const nf = (d) => new Intl.NumberFormat('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const cache = {};
function fmtFixed(x, d) {
  if (!Number.isFinite(x)) return '–';
  const f = cache[d] || (cache[d] = nf(d));
  const out = f.format(Math.abs(x));
  return (x < 0 && Number(out.replace(/,/g, '')) !== 0 ? MINUS : '') + out;
}
export const num = (x, d = 2) => fmtFixed(x, d);
export const signed = (x, d = 2) => (Number.isFinite(x) && x > 0 && fmtFixed(x, d).replace(/[0.,]/g, '') !== '' ? '+' : '') + fmtFixed(x, d);
export const pct = (x, d = 1) => (Number.isFinite(x) ? fmtFixed(x * 100, d) + '%' : '–');
export const spct = (x, d = 1) => (Number.isFinite(x) ? signed(x * 100, d) + '%' : '–');
export const vol = (x, d = 2) => (Number.isFinite(x) ? fmtFixed(x * 100, d) + '%' : '–');
export function money(x, d) {
  if (!Number.isFinite(x)) return '–';
  const dd = d ?? (Math.abs(x) >= 100 ? 0 : 2);
  const out = fmtFixed(Math.abs(x), dd);
  return (x < 0 && Number(out.replace(/,/g, '')) !== 0 ? MINUS : '') + '$' + out;
}
export const smoney = (x, d) => (Number.isFinite(x) && x > 0 && Math.abs(x) >= 0.005 ? '+' : '') + money(x, d);
export function compact(x) {
  if (!Number.isFinite(x)) return '–';
  const a = Math.abs(x);
  const sg = x < 0 ? MINUS : '';
  if (a >= 1e6) return sg + (a / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M';
  if (a >= 1e3) return sg + (a / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'k';
  return sg + a.toFixed(0);
}
export const sci = (x, d = 1) => (Number.isFinite(x) ? (x === 0 ? '0' : x.toExponential(d).replace('-', MINUS)) : '–');

// ------------------------------------------------------------------ controls
export function field(label, control, opts = {}) {
  const id = control.id || (control.id = nextId('f'));
  return h('div', { class: 'vd-field' + (opts.cls ? ' ' + opts.cls : '') },
    h('label', { for: id, title: opts.title || null }, label), control);
}

export function selectEl({ options, value, onchange, id, label, title }) {
  const sel = h('select', { id: id || nextId('sel'), 'aria-label': label || null },
    options.map((o) => h('option', { value: o.value, disabled: o.disabled || null }, o.label)));
  sel.value = value;
  if (onchange) sel.addEventListener('change', () => onchange(sel.value));
  sel.title = title || '';
  return sel;
}

/** Range slider with label and live value output. */
export function slider({ label, min, max, step, value, fmt, oninput, title, id }) {
  const inp = h('input', { type: 'range', min, max, step, id: id || nextId('rng') });
  inp.value = value;
  const out = h('output', { for: inp.id, class: 'vd-num' }, fmt(Number(value)));
  const wrap = h('div', { class: 'vd-slider' },
    h('div', { class: 'vd-slider-top' }, h('label', { for: inp.id, title: title || null }, label), out), inp);
  inp.setAttribute('aria-valuetext', fmt(Number(value)));
  inp.addEventListener('input', () => {
    const v = Number(inp.value);
    out.textContent = fmt(v);
    inp.setAttribute('aria-valuetext', fmt(v));
    oninput(v);
  });
  return {
    el: wrap, input: inp,
    set(v, silent = true) {
      inp.value = v;
      out.textContent = fmt(Number(v));
      inp.setAttribute('aria-valuetext', fmt(Number(v)));
      if (!silent) oninput(Number(v));
    },
    setMax(m) { inp.max = m; },
  };
}

/** Segmented control built from radio inputs (keyboard: arrow keys move within the group). */
export function segmented({ label, options, value, onchange, name }) {
  const nm = name || nextId('seg');
  const group = h('div', { class: 'vd-seg', role: 'radiogroup', 'aria-label': label });
  for (const o of options) {
    const id = nextId('r');
    const inp = h('input', { type: 'radio', name: nm, id, value: o.value });
    inp.checked = o.value === value;
    inp.addEventListener('change', () => inp.checked && onchange(o.value));
    group.append(inp, h('label', { for: id, title: o.title || null }, o.label));
  }
  return {
    el: group,
    set(v) { group.querySelectorAll('input').forEach((i) => { i.checked = i.value === v; }); },
  };
}

export function card(title, ...children) {
  return h('section', { class: 'vd-card' }, title ? h('h3', { class: 'vd-card-title' }, title) : null, ...children);
}

export function note(text, cls = '') {
  return h('p', { class: 'vd-note ' + cls }, text);
}

/** Sortable table. columns: [{key, label, fmt?, align?, title?, sort?: false, cls?}]; rows: objects. */
export function sortableTable({ columns, rows, sortKey, sortDir = 1, caption, rowClass, onSort }) {
  let key = sortKey, dir = sortDir;
  const table = h('table', { class: 'vd-table' });
  const render = () => {
    clear(table);
    if (caption) table.append(h('caption', { class: 'vd-sr' }, caption));
    const sorted = key ? [...rows].sort((a, b) => {
      const x = a[key], y = b[key];
      if (typeof x === 'string' || typeof y === 'string') return dir * String(x ?? '').localeCompare(String(y ?? ''));
      const xn = Number.isFinite(x) ? x : Infinity * dir, yn = Number.isFinite(y) ? y : Infinity * dir;
      return dir * (xn - yn);
    }) : rows;
    const thead = h('thead', null, h('tr', null, columns.map((c) => {
      const active = c.key === key;
      const th = h('th', { scope: 'col', class: (c.align === 'left' ? 'l' : '') + (c.cls ? ' ' + c.cls : ''), title: c.title || null,
        'aria-sort': active ? (dir > 0 ? 'ascending' : 'descending') : (c.sort === false ? null : 'none') });
      if (c.sort === false) th.append(c.label);
      else th.append(h('button', { type: 'button', class: 'vd-th-btn', onclick: () => {
        if (key === c.key) dir = -dir; else { key = c.key; dir = c.defaultDir ?? 1; }
        render();
        onSort && onSort(key, dir);
      } }, c.label, h('span', { class: 'vd-sort', 'aria-hidden': 'true' }, active ? (dir > 0 ? '▲' : '▼') : '')));
      return th;
    })));
    const tbody = h('tbody', null, sorted.map((r) => h('tr', { class: rowClass ? rowClass(r) : null },
      columns.map((c, i) => {
        const v = c.fmt ? c.fmt(r[c.key], r) : r[c.key];
        const cell = h(i === 0 ? 'th' : 'td', { scope: i === 0 ? 'row' : null, class: (c.align === 'left' ? 'l' : '') + (c.cls ? ' ' + c.cls : '') });
        if (v instanceof Node) cell.append(v); else cell.textContent = v ?? '–';
        return cell;
      }))));
    table.append(thead, tbody);
  };
  render();
  return h('div', { class: 'vd-table-wrap' }, table);
}

/** Simple static table: head = [labels], body = [[cells]] (strings or nodes). */
export function simpleTable(head, body, opts = {}) {
  return h('div', { class: 'vd-table-wrap' }, h('table', { class: 'vd-table' + (opts.cls ? ' ' + opts.cls : '') },
    opts.caption ? h('caption', { class: 'vd-sr' }, opts.caption) : null,
    h('thead', null, h('tr', null, head.map((x, i) => h('th', { scope: 'col', class: i === 0 || opts.leftCols?.includes(i) ? 'l' : '' }, x)))),
    h('tbody', null, body.map((row) => h('tr', { class: row.cls || null }, (row.cells || row).map((x, i) =>
      h(i === 0 ? 'th' : 'td', { scope: i === 0 ? 'row' : null, class: i === 0 || opts.leftCols?.includes(i) ? 'l' : '' }, x)))))));
}

// ------------------------------------------------------------------ theme
export function cssVar(name, el = document.documentElement) {
  return getComputedStyle(el).getPropertyValue(name).trim();
}

/** Calls cb when the colour scheme changes (OS setting or the site's data-theme attribute). */
export function onThemeChange(cb) {
  let pending = false;
  const fire = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; cb(); });
  };
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  if (mq.addEventListener) mq.addEventListener('change', fire); else mq.addListener(fire);
  new MutationObserver(fire).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
}

export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Debounce to the next animation frame. */
export function rafThrottle(fn) {
  let id = 0, args = null;
  return (...a) => {
    args = a;
    if (id) return;
    id = requestAnimationFrame(() => { id = 0; fn(...args); });
  };
}
