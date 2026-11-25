/* Small canvas line chart: many points, shaded bands, markers, crosshair tooltip, light/dark aware. */
(function (global) {
  "use strict";
  const css = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  const DAY = 86400000;
  const fmtDate = (d) => new Date(d * DAY).toISOString().slice(0, 10);

  class LineChart {
    constructor(el, opts = {}) {
      this.el = el;
      this.opts = Object.assign({ height: 260, yFmt: (v) => v.toFixed(1), legend: true }, opts);
      this.canvas = document.createElement("canvas");
      this.canvas.className = "chart-canvas";
      this.tip = document.createElement("div");
      this.tip.className = "chart-tip";
      this.tip.hidden = true;
      el.innerHTML = "";
      el.classList.add("chart");
      el.appendChild(this.canvas);
      el.appendChild(this.tip);
      if (this.opts.legend) { this.leg = document.createElement("div"); this.leg.className = "chart-legend"; el.appendChild(this.leg); }
      this.data = null;
      this.ro = new ResizeObserver(() => this.draw());
      this.ro.observe(el);
      this.canvas.addEventListener("mousemove", (e) => this.hover(e));
      this.canvas.addEventListener("mouseleave", () => { this.tip.hidden = true; this.hoverX = null; this.draw(); });
      this.mql = window.matchMedia("(prefers-color-scheme: dark)");
      this.mql.addEventListener?.("change", () => this.draw());
    }
    setData(d) { this.data = d; this.draw(); if (this.leg) this.renderLegend(); }
    renderLegend() {
      const d = this.data;
      this.leg.innerHTML = (d.series || []).filter((s) => s.label).map((s) =>
        `<span><i style="background:${s.color.startsWith("--") ? css(s.color, "#888") : s.color};${s.dash ? "height:2px;border-top:2px dashed currentColor;background:none" : ""}"></i>${s.label}</span>`).join("");
    }
    color(c) { return c && c.startsWith("--") ? css(c, "#888") : c; }
    draw() {
      const d = this.data; if (!d || !d.x || !d.x.length) return;
      const W = this.el.clientWidth, H = this.opts.height, dpr = window.devicePixelRatio || 1;
      this.canvas.width = W * dpr; this.canvas.height = H * dpr;
      this.canvas.style.width = W + "px"; this.canvas.style.height = H + "px";
      const g = this.canvas.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
      const pad = { l: 56, r: 12, t: 10, b: 24 };
      const xs = d.x, n = xs.length, x0 = xs[0], x1 = xs[n - 1] === x0 ? x0 + 1 : xs[n - 1];
      let lo = Infinity, hi = -Infinity;
      const scan = (arr) => { for (const v of arr) if (v !== null && Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } };
      for (const s of d.series || []) { scan(s.y); if (s.area) { scan(s.area.lo); scan(s.area.hi); } }
      for (const h of d.hlines || []) { if (Number.isFinite(h.y)) { lo = Math.min(lo, h.y); hi = Math.max(hi, h.y); } }
      if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
      if (d.yMin !== undefined) lo = Math.min(lo, d.yMin);
      if (hi - lo < 1e-12) { hi += 1; lo -= 1; }
      const padY = (hi - lo) * 0.06; lo -= padY; hi += padY;
      if (d.clip) { lo = Math.max(lo, d.clip[0]); hi = Math.min(hi, d.clip[1]); }
      this.geom = { pad, W, H, x0, x1, lo, hi };
      const X = (v) => pad.l + (v - x0) / (x1 - x0) * (W - pad.l - pad.r);
      const Y = (v) => pad.t + (hi - v) / (hi - lo) * (H - pad.t - pad.b);
      this.X = X; this.Y = Y;
      const rule = css("--rule", "#e6e2d8"), muted = css("--muted", "#6b6963"), ink = css("--ink", "#1a1a18");
      g.font = "11px " + css("--sans", "sans-serif");
      // grid + y ticks
      const ticks = niceTicks(lo, hi, 5);
      g.strokeStyle = rule; g.fillStyle = muted; g.lineWidth = 1; g.textAlign = "right"; g.textBaseline = "middle";
      for (const t of ticks) { const y = Math.round(Y(t)) + 0.5; g.beginPath(); g.moveTo(pad.l, y); g.lineTo(W - pad.r, y); g.stroke(); g.fillText(this.opts.yFmt(t), pad.l - 6, y); }
      // x ticks (years or months)
      g.textAlign = "center"; g.textBaseline = "top";
      const spanYears = (x1 - x0) / 365.25;
      const step = spanYears > 16 ? 4 : spanYears > 8 ? 2 : 1;
      const y0 = new Date(x0 * DAY).getUTCFullYear(), y1 = new Date(x1 * DAY).getUTCFullYear();
      if (spanYears >= 1.5) {
        for (let yr = y0 + 1; yr <= y1; yr++) {
          if ((yr - y0) % step) continue;
          const xd = Date.UTC(yr, 0, 1) / DAY; if (xd < x0 || xd > x1) continue;
          const xp = X(xd); g.fillText(String(yr), xp, H - pad.b + 6);
          g.strokeStyle = rule; g.beginPath(); g.moveTo(xp + 0.5, H - pad.b); g.lineTo(xp + 0.5, H - pad.b + 4); g.stroke();
        }
      } else {
        const months = Math.max(1, Math.round((x1 - x0) / 30 / 6));
        const d0 = new Date(x0 * DAY);
        for (let m = 0; m < 30; m += months) {
          const dt = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + m + 1, 1) / DAY; if (dt > x1) break;
          g.fillText(fmtDate(dt).slice(0, 7), X(dt), H - pad.b + 6);
        }
      }
      // shaded bands (constant) and areas
      for (const b of d.bands || []) {
        g.fillStyle = this.color(b.color); g.globalAlpha = b.alpha ?? 0.12;
        const ya = Y(Math.min(Math.max(b.y1, lo), hi)), yb = Y(Math.min(Math.max(b.y0, lo), hi));
        g.fillRect(pad.l, ya, W - pad.l - pad.r, yb - ya); g.globalAlpha = 1;
      }
      for (const s of d.series || []) {
        if (!s.area) continue;
        g.fillStyle = this.color(s.color); g.globalAlpha = s.area.alpha ?? 0.15; g.beginPath();
        let started = false; const back = [];
        for (let i = 0; i < n; i++) {
          const a = s.area.lo[i], b2 = s.area.hi[i]; if (a === null || b2 === null || !Number.isFinite(a) || !Number.isFinite(b2)) continue;
          const xp = X(xs[i]); if (!started) { g.moveTo(xp, Y(b2)); started = true; } else g.lineTo(xp, Y(b2)); back.push([xp, Y(a)]);
        }
        for (let i = back.length - 1; i >= 0; i--) g.lineTo(back[i][0], back[i][1]);
        g.closePath(); g.fill(); g.globalAlpha = 1;
      }
      for (const h of d.hlines || []) {
        if (!Number.isFinite(h.y) || h.y < lo || h.y > hi) continue;
        g.strokeStyle = this.color(h.color || "--muted"); g.setLineDash(h.dash || [4, 4]); g.lineWidth = 1;
        const y = Math.round(Y(h.y)) + 0.5; g.beginPath(); g.moveTo(pad.l, y); g.lineTo(W - pad.r, y); g.stroke(); g.setLineDash([]);
      }
      // lines (decimated to ~2 points per pixel)
      const pxStep = Math.max(1, Math.floor(n / ((W - pad.l - pad.r) * 2)));
      for (const s of d.series || []) {
        if (s.hidden || !s.y) continue;
        g.strokeStyle = this.color(s.color); g.lineWidth = s.width || 1.4; g.setLineDash(s.dash || []);
        g.beginPath(); let pen = false;
        for (let i = 0; i < n; i += pxStep) {
          let v = s.y[i];
          if (pxStep > 1) { // keep extremes inside each bucket
            let mn = Infinity, mx = -Infinity;
            for (let k = i; k < Math.min(i + pxStep, n); k++) { const w = s.y[k]; if (w !== null && Number.isFinite(w)) { mn = Math.min(mn, w); mx = Math.max(mx, w); } }
            if (mn === Infinity) { pen = false; continue; }
            const xp = X(xs[i]); if (!pen) { g.moveTo(xp, Y(mn)); pen = true; } g.lineTo(xp, Y(mn)); g.lineTo(xp, Y(mx));
            continue;
          }
          if (v === null || !Number.isFinite(v)) { pen = false; continue; }
          const xp = X(xs[i]), yp = Y(Math.min(Math.max(v, lo), hi));
          if (!pen) { g.moveTo(xp, yp); pen = true; } else g.lineTo(xp, yp);
        }
        g.stroke(); g.setLineDash([]);
      }
      for (const m of d.markers || []) {
        if (m.y === null || !Number.isFinite(m.y)) continue;
        g.fillStyle = this.color(m.color); const xp = X(m.x), yp = Y(Math.min(Math.max(m.y, lo), hi));
        g.beginPath();
        if (m.shape === "up") { g.moveTo(xp, yp - 5); g.lineTo(xp - 4, yp + 3); g.lineTo(xp + 4, yp + 3); }
        else if (m.shape === "down") { g.moveTo(xp, yp + 5); g.lineTo(xp - 4, yp - 3); g.lineTo(xp + 4, yp - 3); }
        else g.arc(xp, yp, 2.5, 0, 2 * Math.PI);
        g.fill();
      }
      if (this.hoverX !== null && this.hoverX !== undefined) {
        g.strokeStyle = ink; g.globalAlpha = 0.35; g.beginPath(); g.moveTo(this.hoverX + 0.5, pad.t); g.lineTo(this.hoverX + 0.5, H - pad.b); g.stroke(); g.globalAlpha = 1;
      }
    }
    hover(e) {
      const d = this.data; if (!d || !this.geom) return;
      const r = this.canvas.getBoundingClientRect(), px = e.clientX - r.left;
      const { pad, W, x0, x1 } = this.geom;
      if (px < pad.l || px > W - pad.r) { this.tip.hidden = true; return; }
      const xv = x0 + (px - pad.l) / (W - pad.l - pad.r) * (x1 - x0);
      let lo2 = 0, hi2 = d.x.length - 1;
      while (hi2 - lo2 > 1) { const mid = (lo2 + hi2) >> 1; if (d.x[mid] < xv) lo2 = mid; else hi2 = mid; }
      const i = Math.abs(d.x[lo2] - xv) < Math.abs(d.x[hi2] - xv) ? lo2 : hi2;
      this.hoverX = this.X(d.x[i]);
      const rows = (d.series || []).filter((s) => s.label && s.y).map((s) => {
        const v = s.y[i]; return `<div><i style="background:${this.color(s.color)}"></i>${s.label}: <b>${v === null || !Number.isFinite(v) ? "–" : this.opts.yFmt(v)}</b></div>`;
      }).join("");
      this.tip.innerHTML = `<div class="chart-tip__d">${fmtDate(d.x[i])}</div>${rows}${d.tipExtra ? d.tipExtra(i) : ""}`;
      this.tip.hidden = false;
      const tw = this.tip.offsetWidth, left = this.hoverX + 12 + tw > W ? this.hoverX - tw - 12 : this.hoverX + 12;
      this.tip.style.left = left + "px"; this.tip.style.top = "8px";
      this.draw();
    }
  }

  function niceTicks(lo, hi, n) {
    const span = hi - lo, raw = span / n, mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n + 1) || 10 * mag;
    const out = []; for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
    return out;
  }

  // Simple horizontal bar chart for attribution / summaries (SVG).
  function bars(el, items, fmt = (v) => v.toFixed(1)) {
    const max = Math.max(1e-9, ...items.map((d) => Math.abs(d.v)));
    el.innerHTML = `<div class="bars">${items.map((d) => {
      const w = Math.abs(d.v) / max * 50;
      return `<div class="bars__row"><span class="bars__lab">${d.label}</span><span class="bars__track"><span class="bars__bar ${d.v < 0 ? "neg" : "pos"}" style="width:${w}%;${d.v < 0 ? `right:50%` : `left:50%`}"></span></span><span class="bars__val">${fmt(d.v)}</span></div>`;
    }).join("")}</div>`;
  }

  global.RVChart = { LineChart, bars, fmtDate, DAY };
})(window);
