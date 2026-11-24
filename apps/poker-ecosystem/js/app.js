// App shell: tabs, theme, engine workers.
import { initSolver } from './ui/solver-tab.js';
import { initEquity } from './ui/equity-tab.js';
import { initOpponents } from './ui/opponents-tab.js';
import { initHands } from './ui/hands-tab.js';
import { initResearch } from './ui/research-tab.js';

/** A promise-based client for a module worker. */
export class Engine {
  constructor() {
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    this.seq = 0;
    this.jobs = new Map();
    this.worker.onmessage = (e) => {
      const m = e.data, job = this.jobs.get(m.id);
      if (!job) return;
      if (m.type === 'error') { this.jobs.delete(m.id); job.reject(new Error(m.message)); return; }
      if (job.final.includes(m.type)) { this.jobs.delete(m.id); job.resolve(m); return; }
      if (job.onMessage) job.onMessage(m);
    };
    this.worker.onerror = (e) => { for (const j of this.jobs.values()) j.reject(new Error(e.message || 'worker error')); this.jobs.clear(); };
  }
  run(cmd, payload = {}, final = [], onMessage = null) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.jobs.set(id, { resolve, reject, final, onMessage });
      this.worker.postMessage({ cmd, id, ...payload });
    });
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export function suitHtml(cards) {
  return String(cards).replace(/([2-9TJQKA])([cdhs])/g, (_, r, s) => `<span class="suit-${s}">${r}${{ c: '♣', d: '♦', h: '♥', s: '♠' }[s]}</span>`);
}
export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const solverEngine = new Engine();
const equityEngine = new Engine();
const started = new Set();
const inits = {
  solver: () => initSolver(solverEngine),
  equity: () => initEquity(equityEngine),
  opponents: () => initOpponents(),
  hands: () => initHands(),
  research: () => initResearch(),
};

function show(tab) {
  for (const b of $$('.tab')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  for (const p of $$('[role="tabpanel"]')) p.hidden = p.id !== `tab-${tab}`;
  if (!started.has(tab)) { started.add(tab); inits[tab](); }
  try { history.replaceState(null, '', `#${tab}`); } catch (e) { /* file:// */ }
}
export function goTo(tab) { show(tab); window.scrollTo({ top: 0, behavior: 'smooth' }); }

// ?embed: shown inside the project page, which already has the site's header
if (new URLSearchParams(location.search).has('embed')) document.body.classList.add('embed');
for (const b of $$('.tab')) b.addEventListener('click', () => show(b.dataset.tab));
$('#theme').addEventListener('click', () => {
  const root = document.documentElement;
  const dark = root.getAttribute('data-theme') ? root.getAttribute('data-theme') === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  root.setAttribute('data-theme', next);
  try { localStorage.setItem('theme', next); } catch (e) { /* storage blocked */ }
});
const initial = (location.hash || '').slice(1);
show(inits[initial] ? initial : 'solver');
