// Exact heads-up showdown sums with card removal (port of pe-equity::sweep).
// For each hero hand: opponent weight it beats, ties and loses to, counting only
// opponent hands that share no card with it. Colliding weight is removed by
// inclusion-exclusion over the non-empty subsets of the hero hand's cards.

// Subsets in the Rust engine's order (decreasing suit-major bit masks), so slot
// numbering and summation order match it exactly.
const suitMajor = (c) => (c & 3) * 16 + (c >> 2);
function subsetKeys(hand) {
  const s = hand.slice().sort((a, b) => suitMajor(a) - suitMajor(b));
  const n = s.length, out = [];
  for (let m = (1 << n) - 1; m >= 1; m--) {
    const members = [];
    for (let j = 0; j < n; j++) if (m & (1 << j)) members.push(s[j]);
    members.sort((a, b) => a - b);
    let key = 1, mul = 1;
    for (const c of members) { key += (c + 1) * mul; mul *= 53; }
    out.push([key, members.length]);
  }
  return out;
}

export class ShowdownPlan {
  constructor(heroVals, heroHands, oppVals, oppHands) {
    const oppSubsets = new Set();
    for (const h of oppHands) for (const [k] of subsetKeys(h)) oppSubsets.add(k);
    const slotOf = new Map();
    this.heroSlots = heroHands.map((h) => {
      const slots = [], signs = [];
      for (const [k, size] of subsetKeys(h)) {
        if (!oppSubsets.has(k)) continue;
        let s = slotOf.get(k);
        if (s === undefined) { s = slotOf.size; slotOf.set(k, s); }
        slots.push(s);
        signs.push(size % 2 === 1 ? 1 : -1);
      }
      return [Int32Array.from(slots), Float64Array.from(signs)];
    });
    this.oppSlots = oppHands.map((h) => Int32Array.from(subsetKeys(h).map(([k]) => slotOf.get(k)).filter((s) => s !== undefined)));
    this.nSlots = slotOf.size;
    this.heroVals = heroVals;
    this.oppVals = oppVals;
    // stable by index on ties, like Rust's sort_by_key
    this.heroOrder = Int32Array.from(heroVals.map((_, i) => i)).sort((a, b) => heroVals[a] - heroVals[b] || a - b);
    this.oppOrder = Int32Array.from(oppVals.map((_, i) => i)).sort((a, b) => oppVals[a] - oppVals[b] || a - b);
  }
  blocked(h, acc) {
    const [slots, signs] = this.heroSlots[h];
    let s = 0;
    for (let i = 0; i < slots.length; i++) s += signs[i] * acc[slots[i]];
    return s;
  }
  /** Returns { win, tie, lose } arrays (opponent weight) for every hero hand. */
  sums(oppW) {
    const nh = this.heroVals.length, no = this.oppVals.length;
    const accAll = new Float64Array(this.nSlots), accLt = new Float64Array(this.nSlots), accLe = new Float64Array(this.nSlots);
    let tAll = 0;
    for (let v = 0; v < no; v++) {
      const w = oppW[v];
      if (w !== 0) { tAll += w; const sl = this.oppSlots[v]; for (let i = 0; i < sl.length; i++) accAll[sl[i]] += w; }
    }
    const win = new Float64Array(nh), tie = new Float64Array(nh), lose = new Float64Array(nh);
    let tLt = 0, tLe = 0, pLt = 0, pLe = 0;
    for (let k = 0; k < nh; k++) {
      const h = this.heroOrder[k], val = this.heroVals[h];
      while (pLt < no && this.oppVals[this.oppOrder[pLt]] < val) {
        const v = this.oppOrder[pLt], w = oppW[v];
        if (w !== 0) { tLt += w; const sl = this.oppSlots[v]; for (let i = 0; i < sl.length; i++) accLt[sl[i]] += w; }
        pLt++;
      }
      while (pLe < no && this.oppVals[this.oppOrder[pLe]] <= val) {
        const v = this.oppOrder[pLe], w = oppW[v];
        if (w !== 0) { tLe += w; const sl = this.oppSlots[v]; for (let i = 0; i < sl.length; i++) accLe[sl[i]] += w; }
        pLe++;
      }
      const total = tAll - this.blocked(h, accAll);
      const lt = tLt - this.blocked(h, accLt);
      const le = tLe - this.blocked(h, accLe);
      win[h] = Math.max(lt, 0);
      tie[h] = Math.max(le - lt, 0);
      lose[h] = Math.max(total - le, 0);
    }
    return { win, tie, lose };
  }
  /** Card-compatible opponent weight for every hero hand. */
  compatible(oppW) {
    const acc = new Float64Array(this.nSlots);
    let t = 0;
    for (let v = 0; v < oppW.length; v++) {
      const w = oppW[v];
      if (w !== 0) { t += w; const sl = this.oppSlots[v]; for (let i = 0; i < sl.length; i++) acc[sl[i]] += w; }
    }
    const out = new Float64Array(this.heroVals.length);
    for (let h = 0; h < out.length; h++) out[h] = Math.max(t - this.blocked(h, acc), 0);
    return out;
  }
}
