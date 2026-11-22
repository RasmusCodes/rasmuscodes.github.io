/* Web Worker: runs the smartrouter Python package in Pyodide (CPython compiled to WebAssembly).
   Messages in:  {type: "init", base} | {type: "run", id, cfg} | {type: "metrics", id, cfg} | {type: "info", id, name}
   Messages out: {type: "status", text} | {type: "ready", ms, version} | {type: "result"|"metrics"|"info", id, data}
                 | {type: "error", id, message} */
"use strict";

const PYODIDE_VERSION = "0.27.2";
const PYODIDE_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
let ready = null;

async function boot(base) {
  const t0 = performance.now();
  postMessage({ type: "status", text: "Downloading the Python runtime (about 7 MB, cached after the first visit)…" });
  importScripts(PYODIDE_URL + "pyodide.js");
  const py = await loadPyodide({ indexURL: PYODIDE_URL });
  postMessage({ type: "status", text: "Loading the simulator…" });
  const res = await fetch(base + "engine.zip", { cache: "no-cache" });
  if (!res.ok) throw new Error(`engine.zip: HTTP ${res.status}`);
  py.unpackArchive(await res.arrayBuffer(), "zip", { extractDir: "/home/pyodide/sor" });
  py.runPython([
    "import sys",
    "sys.path.insert(0, '/home/pyodide/sor')",
    "import smartrouter.demo as demo",
  ].join("\n"));
  return { py, ms: Math.round(performance.now() - t0) };
}

function call(py, fn, arg) {
  py.globals.set("_arg", arg);
  return py.runPython(`demo.${fn}(_arg)`);
}

onmessage = async (ev) => {
  const msg = ev.data || {};
  try {
    if (msg.type === "init") {
      if (!ready) ready = boot(msg.base);
      const { ms } = await ready;
      postMessage({ type: "ready", ms, version: PYODIDE_VERSION });
      return;
    }
    if (!ready) throw new Error("engine not initialised");
    const { py } = await ready;
    if (msg.type === "run") {
      postMessage({ type: "result", id: msg.id, data: call(py, "run_one", JSON.stringify(msg.cfg)) });
    } else if (msg.type === "metrics") {
      postMessage({ type: "metrics", id: msg.id, data: call(py, "run_metrics", JSON.stringify(msg.cfg)) });
    } else if (msg.type === "info") {
      postMessage({ type: "info", id: msg.id, data: call(py, "scenario_info", msg.name) });
    }
  } catch (err) {
    postMessage({ type: "error", id: msg.id, message: String(err && err.message ? err.message : err) });
  }
};
