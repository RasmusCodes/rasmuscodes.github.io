/* In-browser reproduction: a JavaScript port of qros.examples.toy that produces the same bytes, plus
   the audit-chain verifier. Only IEEE-754 +, -, *, / and sqrt are used, in the same order as Python,
   so the SHA-256 of the generated data and of the strategy returns must equal the hashes the Python
   registry recorded. (Python's sum() is avoided there for the same reason: it uses compensated
   summation since 3.12.) */
(function (global) {
  "use strict";
  const MU = 0.0002, PHI = 0.08, SIGMA = 0.01, N_DAYS = 1260;

  function splitmix32(state) {
    state = (state + 0x9E3779B9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x85EBCA6B) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xC2B2AE35) >>> 0;
    z = (z ^ (z >>> 16)) >>> 0;
    return [state, z];
  }
  const rotl = (x, k) => ((x << k) | (x >>> (32 - k))) >>> 0;

  function Xoshiro128ss(seed) {
    let state = seed >>> 0;
    const w = [];
    for (let i = 0; i < 4; i++) { const r = splitmix32(state); state = r[0]; w.push(r[1]); }
    if (!w[0] && !w[1] && !w[2] && !w[3]) w[0] = 1;
    let [s0, s1, s2, s3] = w;
    this.nextU32 = function () {
      const result = Math.imul(rotl(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0;
      const t = (s1 << 9) >>> 0;
      s2 = (s2 ^ s0) >>> 0;
      s3 = (s3 ^ s1) >>> 0;
      s1 = (s1 ^ s2) >>> 0;
      s0 = (s0 ^ s3) >>> 0;
      s2 = (s2 ^ t) >>> 0;
      s3 = rotl(s3, 11);
      return result;
    };
    this.uniform = function () { return this.nextU32() / 4294967296.0; };
  }

  function generateReturns(seed, n = N_DAYS) {
    const rng = new Xoshiro128ss(seed);
    const out = new Array(n);
    let prev = 0.0;
    for (let i = 0; i < n; i++) {
      let acc = 0.0;
      for (let k = 0; k < 12; k++) acc = acc + rng.uniform();
      const z = acc - 6.0;
      const r = MU + PHI * prev + SIGMA * z;
      out[i] = r;
      prev = r;
    }
    return out;
  }

  function runStrategy(returns, lookback, costBps) {
    const n = returns.length, cost = costBps / 10000.0;
    const pos = new Array(n).fill(0.0);
    for (let t = 0; t < n; t++) {
      if (t + 1 >= lookback) {
        let s = 0.0;
        for (let k = t - lookback + 1; k <= t; k++) s = s + returns[k];
        pos[t] = s > 0.0 ? 1.0 : (s < 0.0 ? -1.0 : 0.0);
      }
    }
    const net = new Array(n).fill(0.0), gross = new Array(n).fill(0.0), costs = new Array(n).fill(0.0);
    for (let t = 1; t < n; t++) {
      const held = pos[t - 1], before = t >= 2 ? pos[t - 2] : 0.0;
      gross[t] = held * returns[t];
      costs[t] = cost * Math.abs(held - before);
      net[t] = gross[t] - costs[t];
    }
    return { position: pos, gross, cost: costs, net };
  }

  function floatBytes(values) {
    const buf = new ArrayBuffer(values.length * 8);
    const view = new DataView(buf);
    values.forEach((v, i) => view.setFloat64(i * 8, v === 0 ? 0 : v, true));
    return buf;
  }

  // SHA-256 (FIPS 180-4), synchronous so a long hash chain verifies in milliseconds.
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
  const W = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  function sha256Sync(input) {
    const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
    const len = bytes.length;
    const total = ((len + 9 + 63) >> 6) << 6;
    const buf = new Uint8Array(total);
    buf.set(bytes);
    buf[len] = 0x80;
    const dv = new DataView(buf.buffer);
    dv.setUint32(total - 8, Math.floor((len * 8) / 4294967296));
    dv.setUint32(total - 4, (len * 8) >>> 0);
    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a, h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    for (let off = 0; off < total; off += 64) {
      for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) {
        const x = W[i - 15], y = W[i - 2];
        const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
        const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
      }
      let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, hh = h7;
      for (let i = 0; i < 64; i++) {
        const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) >>> 0;
        const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
      h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + hh) >>> 0;
    }
    return [h0, h1, h2, h3, h4, h5, h6, h7].map((v) => v.toString(16).padStart(8, "0")).join("");
  }
  async function sha256Hex(data) { return sha256Sync(data); }
  async function sha256Subtle(data) {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  function stats(net, ppy = 252) {
    const n = net.length;
    let total = 0.0;
    for (const v of net) total = total + v;
    const mean = total / n;
    let ss = 0.0;
    for (const v of net) { const d = v - mean; ss = ss + d * d; }
    const sd = Math.sqrt(ss / (n - 1));
    let equity = 1.0, peak = 1.0, maxDd = 0.0;
    for (const v of net) {
      equity = equity * (1.0 + v);
      if (equity > peak) peak = equity;
      const dd = equity / peak - 1.0;
      if (dd < maxDd) maxDd = dd;
    }
    return { mean, sd, sharpe: mean / sd * Math.sqrt(ppy), final_equity: equity, max_drawdown: maxDd };
  }

  // Business days from 2015-01-01 (pandas bdate_range: weekends skipped, no holidays).
  function businessDays(n, start = "2015-01-01") {
    const out = [];
    let t = Date.parse(start + "T00:00:00Z");
    while (out.length < n) {
      const d = new Date(t).getUTCDay();
      if (d !== 0 && d !== 6) out.push(new Date(t).toISOString().slice(0, 10));
      t += 86400000;
    }
    return out;
  }

  async function run(seed, lookback, costBps = 5.0, n = N_DAYS) {
    const returns = generateReturns(seed, n);
    const res = runStrategy(returns, lookback, costBps);
    const [dataHash, retHash] = await Promise.all([sha256Hex(floatBytes(returns)), sha256Hex(floatBytes(res.net))]);
    return { seed, lookback, cost_bps: costBps, n, data_sha256: dataHash, returns_sha256: retHash,
             stats: stats(res.net), returns, net: res.net, dates: businessDays(n) };
  }

  // ---------------------------------------------------------------- statistics for the trials lesson
  function erf(x) {
    // Abramowitz & Stegun 7.1.26 (|error| < 1.5e-7): display only, nothing is hashed.
    const s = Math.sign(x), a = Math.abs(x), t = 1 / (1 + 0.3275911 * a);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
    return s * y;
  }
  const normCdf = (x) => 0.5 * (1 + erf(x / Math.SQRT2));
  function normPpf(p) {
    // Acklam's rational approximation (relative error ~1e-9).
    const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
    const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
    const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
    const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
    const lo = 0.02425, hi = 1 - lo;
    let q, r;
    if (p < lo) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    if (p > hi) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    q = p - 0.5; r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  function moments(x) {
    const n = x.length;
    const mean = x.reduce((s, v) => s + v, 0) / n;
    let m2 = 0, m3 = 0, m4 = 0;
    for (const v of x) { const dv = v - mean; m2 += dv * dv; m3 += dv * dv * dv; m4 += dv * dv * dv * dv; }
    m2 /= n; m3 /= n; m4 /= n;
    const sd = Math.sqrt(m2 * n / (n - 1));
    return { n, mean, sd, skew: m2 > 0 ? m3 / Math.pow(m2, 1.5) : 0, kurt: m2 > 0 ? m4 / (m2 * m2) : 3 };
  }
  function psr(sr, n, skew, kurt, bench) {
    const den = Math.max(1e-12, 1 - skew * sr + (kurt - 1) / 4 * sr * sr);
    return normCdf((sr - bench) * Math.sqrt(n - 1) / Math.sqrt(den));
  }
  function expectedMax(nTrials, variance) {
    if (nTrials <= 1 || variance <= 0) return 0;
    const g = 0.5772156649015329;
    return Math.sqrt(variance) * ((1 - g) * normPpf(1 - 1 / nTrials) + g * normPpf(1 - 1 / (nTrials * Math.E)));
  }

  // ---------------------------------------------------------------- audit chain
  function canonicalEventBody(e) {
    const J = (v) => JSON.stringify(v === undefined ? null : v);
    return `{"action":${J(e.action)},"actor":${J(e.actor)},"at":${J(e.at)},"entity":${J(e.entity)},` +
      `"entity_id":${J(e.entity_id)},"payload":${J(e.payload_json)},"seq":${e.seq}}`;
  }
  async function verifyChain(events, onProgress) {
    let prev = "0".repeat(64);
    let expected = 1;
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      const h = sha256Sync(prev + "|" + canonicalEventBody(e));
      if (e.seq !== expected || e.prev_hash !== prev || h !== e.hash) {
        return { ok: false, firstBad: e.seq, checked: i + 1, recomputed: h, stored: e.hash };
      }
      prev = e.hash;
      expected = e.seq + 1;
      if (onProgress && i % 200 === 0) { onProgress(i + 1); await new Promise((r) => setTimeout(r, 0)); }
    }
    return { ok: true, head: prev, checked: events.length };
  }

  global.QToy = { generateReturns, runStrategy, stats, run, sha256Hex, sha256Sync, sha256Subtle, floatBytes, businessDays,
                  moments, psr, expectedMax, normCdf, normPpf, verifyChain, canonicalEventBody, N_DAYS };
})(window);
