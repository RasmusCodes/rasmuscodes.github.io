// Runs a lab experiment off the main thread: simulate the world, walk every chosen method forward, evaluate.
import { deciles, evaluate, moments, oracleEval, simulate, summarize, walkForward } from "./engine.js?v=20261124a";

self.onmessage = (e) => {
  const { world, methods, opt } = e.data;
  try {
    const t0 = performance.now();
    const W = simulate(world);
    const mom = moments(W);
    const list = ["EW", ...methods.filter((m) => m !== "EW")];
    const runs = {};
    list.forEach((name, i) => {
      const res = walkForward(W, mom, name, opt, (f) => self.postMessage({ type: "progress", value: (i + f) / list.length, name }));
      runs[name] = { ev: evaluate(W, res, opt), weights: res.weights, chosen: res.chosen, deciles: deciles(W, res, opt),
                     contributions: res.contributions };
      self.postMessage({ type: "progress", value: (i + 1) / list.length, name });
    });
    const oracle = oracleEval(W, opt);
    const summary = {};
    for (const name of list) summary[name] = summarize(runs[name].ev, name === "EW" ? null : runs.EW.ev);
    summary.ORACLE = summarize(oracle, runs.EW.ev);
    const months = [];
    for (let t = opt.start; t < W.T - 1; t++) months.push(t);
    self.postMessage({
      type: "done", seconds: (performance.now() - t0) / 1000, months, summary, oracle,
      runs, truth: { weights: Array.from(W.weights), icOracle: W.icOracle, trueW: months.map((t) => Array.from(W.trueW[t])) },
      names: W.names, families: W.families, regime: Array.from(W.regime),
    });
  } catch (err) {
    self.postMessage({ type: "error", message: String(err && err.stack || err) });
  }
};
