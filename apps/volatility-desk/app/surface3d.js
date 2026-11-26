// Canvas 3D surface: painter's-algorithm quad mesh with rotation (drag / arrow keys), zoom (wheel / pinch / +-),
// hover readout and hatched extrapolated cells. Colours come from CSS custom properties at draw time.
import { h } from './ui.js';
import { color, rampRgb, seqStops, divStops, toRgb, parseColor } from './charts.js';

const XW = 1.3, YD = 1.0, ZH = 0.72;

export class Surface3D {
  constructor(wrap) {
    this.wrap = wrap;
    this.canvas = h('canvas', { class: 'vd-canvas3d', tabindex: '0', role: 'img',
      'aria-label': 'Implied volatility surface. Drag or use the arrow keys to rotate, wheel, pinch or plus and minus to zoom, 0 to reset.' });
    this.readout = h('div', { class: 'vd-readout', 'aria-live': 'polite' }, 'Drag to rotate, wheel or pinch to zoom, hover for values.');
    wrap.append(this.canvas, this.readout);
    this.reset(false);
    this.data = null;
    this.hover = null;
    this.drawn = [];
    this.pointers = new Map();
    this.pinch = 0;
    this._raf = 0;
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { c.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      if (this.pointers.size === 2) this.pinch = this._pinchDist();
      if (e.pointerType !== 'mouse') this._hoverAt(e);
    });
    c.addEventListener('pointermove', (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) { this._hoverAt(e); return; }
      if (this.pointers.size === 1) {
        this.yaw += (e.clientX - p.x) * 0.008;
        this.pitch = Math.max(0.05, Math.min(1.5, this.pitch + (e.clientY - p.y) * 0.008));
        p.x = e.clientX; p.y = e.clientY;
        this.requestRender();
      } else {
        p.x = e.clientX; p.y = e.clientY;
        const d = this._pinchDist();
        if (this.pinch > 0 && d > 0) this.setZoom(this.zoom * d / this.pinch);
        this.pinch = d;
      }
    });
    const up = (e) => { this.pointers.delete(e.pointerId); this.pinch = this.pointers.size === 2 ? this._pinchDist() : 0; };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('pointerleave', (e) => { if (!this.pointers.size && e.pointerType === 'mouse') { this.hover = null; this.requestRender(); } });
    c.addEventListener('wheel', (e) => { e.preventDefault(); this.setZoom(this.zoom * Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
    c.addEventListener('keydown', (e) => {
      const k = e.key;
      if (k === 'ArrowLeft') this.yaw -= 0.08;
      else if (k === 'ArrowRight') this.yaw += 0.08;
      else if (k === 'ArrowUp') this.pitch = Math.min(1.5, this.pitch + 0.06);
      else if (k === 'ArrowDown') this.pitch = Math.max(0.05, this.pitch - 0.06);
      else if (k === '+' || k === '=') this.zoom = Math.min(3, this.zoom * 1.1);
      else if (k === '-' || k === '_') this.zoom = Math.max(0.5, this.zoom / 1.1);
      else if (k === '0') this.reset(false);
      else return;
      e.preventDefault();
      this.requestRender();
    });
    if ('ResizeObserver' in window) new ResizeObserver(() => this.requestRender()).observe(c);
  }
  _pinchDist() {
    const p = [...this.pointers.values()];
    return p.length < 2 ? 0 : Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
  }
  reset(render = true) {
    this.yaw = -0.55; this.pitch = 0.5; this.zoom = 1;
    if (render) this.requestRender();
  }
  setZoom(z) {
    this.zoom = Math.max(0.5, Math.min(3, z));
    this.requestRender();
  }
  setData(d) {
    this.data = d;
    this.hover = null;
    this.requestRender();
  }
  requestRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.render(); });
  }
  _proj(X, Y, Z) {
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw), cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const xr = X * cy - Y * sy, yr = X * sy + Y * cy, zc = Z - ZH / 2;
    const up = zc * cp + yr * sp, depth = yr * cp - zc * sp;
    return [this.cx + this.S * xr, this.cy - this.S * up, depth];
  }
  _world(row, ci) {
    const d = this.data;
    const span = d.zMax - d.zMin || 1;
    const zt = Math.max(-0.05, Math.min(1.05, (row.z[ci] - d.zMin) / span));
    return [(row.x[ci] - 0.5) * XW, (row.t - 0.5) * YD, zt * ZH];
  }
  render() {
    const c = this.canvas;
    const cw = c.clientWidth, ch = c.clientHeight;
    if (!cw || !ch) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (c.width !== Math.round(cw * dpr) || c.height !== Math.round(ch * dpr)) {
      c.width = Math.round(cw * dpr); c.height = Math.round(ch * dpr);
    }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    const d = this.data;
    if (!d || !d.rows.length) return;
    this.S = Math.min(cw / 2.0, ch / 1.55) * this.zoom;
    this.cx = cw / 2; this.cy = ch * 0.43;
    const ink = color('--ink-2'), muted = color('--muted'), ruleS = color('--rule-strong'), surf = color('--surface');
    const mono = (getComputedStyle(this.wrap).getPropertyValue('--mono') || '').trim() || 'ui-monospace, monospace';
    const font = `11px ${mono}`;
    ctx.font = font;
    // projected vertices
    const rows = d.rows;
    const P = rows.map((row) => Array.from(row.x, (_, ci) => this._proj(...this._world(row, ci))));
    // floor and back axis
    const hx = XW / 2, hy = YD / 2;
    const corners = [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]].map(([X, Y]) => this._proj(X, Y, 0));
    ctx.strokeStyle = ruleS; ctx.lineWidth = 1;
    ctx.beginPath();
    corners.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.closePath(); ctx.stroke();
    let back = 0;
    corners.forEach((p, i) => { if (p[2] > corners[back][2]) back = i; });
    const bc = [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]][back];
    const top = this._proj(bc[0], bc[1], ZH);
    ctx.beginPath(); ctx.moveTo(corners[back][0], corners[back][1]); ctx.lineTo(top[0], top[1]); ctx.stroke();
    // z ticks on the back edge
    ctx.fillStyle = muted;
    const span = d.zMax - d.zMin || 1;
    const leftSide = corners[back][0] < this.cx;
    ctx.textAlign = leftSide ? 'right' : 'left';
    for (const t of d.zTicks || []) {
      const zt = (t.v - d.zMin) / span;
      if (zt < -0.001 || zt > 1.001) continue;
      const p = this._proj(bc[0], bc[1], zt * ZH);
      ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(p[0] + (leftSide ? -4 : 4), p[1]); ctx.stroke();
      ctx.fillText(t.label, p[0] + (leftSide ? -7 : 7), p[1] + 3.5);
    }
    if (d.zLabel) { ctx.fillText(d.zLabel, top[0] + (leftSide ? -7 : 7), top[1] - 8); }
    // quads, far to near
    const quads = [];
    for (let i = 0; i < rows.length - 1; i++) {
      const n = Math.min(rows[i].x.length, rows[i + 1].x.length);
      for (let j = 0; j < n - 1; j++) {
        const a = P[i][j], b = P[i][j + 1], cc = P[i + 1][j + 1], dd = P[i + 1][j];
        if (![a, b, cc, dd].every((p) => Number.isFinite(p[1]))) continue;
        quads.push({ i, j, depth: (a[2] + b[2] + cc[2] + dd[2]) / 4, pts: [a, b, cc, dd] });
      }
    }
    quads.sort((q1, q2) => q2.depth - q1.depth);
    const seq = seqStops(), div = divStops();
    const L = normalize([-0.35, -0.55, 0.75]);
    const hatch = this._hatch(ctx, muted);
    const surfRgb = parseColor(surf);
    for (const q of quads) {
      const r0 = rows[q.i], r1 = rows[q.i + 1];
      const zv = (r0.z[q.j] + r0.z[q.j + 1] + r1.z[q.j + 1] + r1.z[q.j]) / 4;
      let rgb;
      if (d.mode === 'div') {
        const amax = Math.max(Math.abs(d.zMin), Math.abs(d.zMax)) || 1;
        rgb = rampRgb(div, (Math.max(-1, Math.min(1, zv / amax)) + 1) / 2);
      } else rgb = rampRgb(seq, (zv - d.zMin) / span);
      const w00 = this._world(r0, q.j), w01 = this._world(r0, q.j + 1), w10 = this._world(r1, q.j);
      const nrm = normalize(cross(sub(w01, w00), sub(w10, w00)));
      const shade = 0.8 + 0.2 * Math.abs(dot(nrm, L));
      rgb = rgb.map((v) => v * shade);
      const exN = r0.ex[q.j] + r0.ex[q.j + 1] + r1.ex[q.j + 1] + r1.ex[q.j];
      const extrap = exN >= 2;
      if (extrap) rgb = rgb.map((v, k) => v + (surfRgb[k] - v) * 0.45);
      ctx.beginPath();
      q.pts.forEach((p, k) => (k ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      ctx.closePath();
      ctx.fillStyle = toRgb(rgb);
      ctx.fill();
      if (extrap && hatch) { ctx.fillStyle = hatch; ctx.fill(); }
      ctx.strokeStyle = toRgb(rgb.map((v, k) => v + (surfRgb[k] - v) * 0.35));
      ctx.lineWidth = 0.5;
      ctx.stroke();
    }
    this.drawn = quads;
    // x ticks on the nearer y-edge, maturity ticks on the nearer x-edge
    ctx.fillStyle = muted;
    const yEdge = this._proj(0, -hy, 0)[2] < this._proj(0, hy, 0)[2] ? -hy : hy;
    const xEdge = this._proj(-hx, 0, 0)[2] < this._proj(hx, 0, 0)[2] ? -hx : hx;
    const yOut = yEdge < 0 ? -0.07 : 0.07, xOut = xEdge < 0 ? -0.07 : 0.07;
    ctx.textAlign = 'center';
    for (const t of d.xTicks || []) {
      const p0 = this._proj((t.p - 0.5) * XW, yEdge, 0), p1 = this._proj((t.p - 0.5) * XW, yEdge + yOut, 0);
      ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p0[0] + (p1[0] - p0[0]) * 0.4, p0[1] + (p1[1] - p0[1]) * 0.4); ctx.stroke();
      ctx.fillText(t.label, p1[0], p1[1] + 4);
    }
    if (d.xLabel) { const p = this._proj(0, yEdge + yOut * 3.1, 0); ctx.fillStyle = ink; ctx.fillText(d.xLabel, p[0], p[1] + 4); ctx.fillStyle = muted; }
    for (const t of d.tTicks || []) {
      const p0 = this._proj(xEdge, (t.p - 0.5) * YD, 0), p1 = this._proj(xEdge + xOut, (t.p - 0.5) * YD, 0);
      ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p0[0] + (p1[0] - p0[0]) * 0.4, p0[1] + (p1[1] - p0[1]) * 0.4); ctx.stroke();
      ctx.textAlign = p1[0] < p0[0] ? 'right' : 'left';
      ctx.fillText(t.label, p1[0], p1[1] + 4);
    }
    if (d.tLabel) {
      const p = this._proj(xEdge + xOut * 4.4, 0, 0);
      ctx.textAlign = 'center'; ctx.fillStyle = ink; ctx.fillText(d.tLabel, p[0], p[1] + 4);
    }
    // hover marker
    if (this.hover) {
      const p = P[this.hover.ri]?.[this.hover.ci];
      if (p) {
        ctx.beginPath(); ctx.arc(p[0], p[1], 4.5, 0, 2 * Math.PI);
        ctx.fillStyle = color('--ink'); ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = surf; ctx.stroke();
      }
    }
  }
  _hatch(ctx, col) {
    const pc = document.createElement('canvas');
    pc.width = 7; pc.height = 7;
    const g = pc.getContext('2d');
    g.strokeStyle = col; g.globalAlpha = 0.55; g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, 7); g.lineTo(7, 0); g.moveTo(-1, 1); g.lineTo(1, -1); g.moveTo(6, 8); g.lineTo(8, 6); g.stroke();
    return ctx.createPattern(pc, 'repeat');
  }
  _hoverAt(e) {
    if (!this.data) return;
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    let hit = null;
    for (let n = this.drawn.length - 1; n >= 0; n--) {
      const q = this.drawn[n];
      if (pointInPoly(x, y, q.pts)) { hit = q; break; }
    }
    if (!hit) {
      if (this.hover) { this.hover = null; this.requestRender(); }
      return;
    }
    const cand = [[hit.i, hit.j], [hit.i, hit.j + 1], [hit.i + 1, hit.j + 1], [hit.i + 1, hit.j]];
    let best = cand[0], bd = Infinity;
    hit.pts.forEach((p, k) => { const dd = (p[0] - x) ** 2 + (p[1] - y) ** 2; if (dd < bd) { bd = dd; best = cand[k]; } });
    const hv = { ri: best[0], ci: best[1] };
    if (!this.hover || this.hover.ri !== hv.ri || this.hover.ci !== hv.ci) {
      this.hover = hv;
      this.readout.textContent = this.data.hoverText ? this.data.hoverText(hv.ri, hv.ci) : '';
      this.requestRender();
    }
  }
}

function pointInPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function normalize(v) { const n = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / n, v[1] / n, v[2] / n]; }
