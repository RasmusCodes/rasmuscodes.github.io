/* qros dashboard app: renders a registry export (data/index.json + data/experiments/*.json). */
(function () {
  "use strict";
  const { h, s, fmt } = QC;
  const qs = new URLSearchParams(location.search);
  const state = { index: null, details: {}, audit: null, embed: qs.has("embed"), charts: [], filters: { q: "", hyp: "", fam: "", verdict: "", tag: "" }, selected: new Set(), sort: { key: "id", dir: 1 } };
  const M = { exp: {}, hyp: {}, fam: {}, ver: {}, ds: {}, tf: {}, warnByExp: {}, warnByScope: {} };

  // ------------------------------------------------------------------ data
  async function getJSON(path) {
    const r = await fetch(path, { cache: "no-cache" });
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return r.json();
  }
  async function loadIndex() {
    const idx = await getJSON("data/index.json");
    state.index = idx;
    idx.experiments.forEach((e) => (M.exp[e.id] = e));
    idx.hypotheses.forEach((x) => (M.hyp[x.id] = x));
    idx.families.forEach((f) => (M.fam[f.name] = f));
    idx.versions.forEach((v) => (M.ver[v.id] = v));
    idx.datasets.forEach((d) => (M.ds[d.id] = d));
    idx.transforms.forEach((t) => (M.tf[t.id] = t));
    idx.warnings.forEach((w) => {
      if (w.experiment_id) (M.warnByExp[w.experiment_id] = M.warnByExp[w.experiment_id] || []).push(w);
      (M.warnByScope[w.scope_key] = M.warnByScope[w.scope_key] || []).push(w);
    });
  }
  async function detail(id) {
    if (!state.details[id]) state.details[id] = await getJSON(`data/experiments/${encodeURIComponent(id)}.json`);
    return state.details[id];
  }

  // ------------------------------------------------------------------ small helpers
  const ICON = {
    check: "M3 8.5l3 3 7-7", alert: "M8 2l6.5 11.5h-13L8 2zM8 6.5v3.2M8 11.6v.4", x: "M4 4l8 8M12 4l-8 8",
    minus: "M3.5 8h9", help: "M6 6.2a2 2 0 1 1 2.6 1.9c-.4.2-.6.5-.6.9v.6M8 11.6v.4", info: "M8 7v4.5M8 4.6v.4",
    arrow: "M3 8h10M9 4l4 4-4 4", ext: "M9 3h4v4M13 3l-6 6M11 9.5V13H3V5h3.5",
  };
  function icon(name, size = 12) {
    const svg = s("svg", { viewBox: "0 0 16 16", width: size, height: size, fill: "none", stroke: "currentColor", "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" });
    s("path", { d: ICON[name] }, svg);
    if (name === "info" || name === "help") s("circle", { cx: 8, cy: 8, r: 6.2 }, svg);
    return svg;
  }
  const VERDICT = {
    robust: ["check", "Robust"], fragile: ["alert", "Fragile"], "no-edge": ["minus", "No edge"], invalid: ["x", "Invalid"],
    insufficient: ["help", "Insufficient data"], running: ["minus", "Running"], failed: ["x", "Failed"],
  };
  function verdictBadge(v) {
    const [ic, label] = VERDICT[v] || ["minus", v || "–"];
    return h("span", { class: `badge badge--${v || "running"}`, title: label }, icon(ic), label);
  }
  const SEV = { critical: ["x", "Critical"], warning: ["alert", "Warning"], info: ["info", "Info"] };
  function sevBadge(sv) { const [ic, label] = SEV[sv] || ["info", sv]; return h("span", { class: `badge badge--${sv}` }, icon(ic), label); }
  const STATUS = { supported: "check", rejected: "minus", abandoned: "x", inconclusive: "help", registered: "minus", draft: "minus" };
  function statusBadge(st) { return h("span", { class: `badge badge--${st}` }, icon(STATUS[st] || "minus"), st.charAt(0).toUpperCase() + st.slice(1)); }
  function gate(status) {
    const map = { pass: ["check", "Pass"], fail: ["x", "Fail"], na: ["minus", "n/a"], info: ["info", "Info"] };
    const [ic, label] = map[status] || ["minus", status];
    return h("span", { class: `gate gate--${status}` }, icon(ic, 13), label);
  }
  function wcount(w) {
    if (!w) return "";
    const box = h("span", { class: "wcount" });
    if (w.critical) box.appendChild(h("span", { class: "c", title: `${w.critical} critical` }, icon("x"), String(w.critical)));
    if (w.warning) box.appendChild(h("span", { class: "w", title: `${w.warning} warnings` }, icon("alert"), String(w.warning)));
    if (w.info) box.appendChild(h("span", { class: "i", title: `${w.info} info` }, icon("info"), String(w.info)));
    return box;
  }
  const a = (href, text, attrs) => h("a", { href, ...(attrs || {}) }, text);
  const expLink = (id) => a(`#/exp/${id}`, id, { class: "mono" });
  const hypLink = (id) => (id ? a(`#/hyp/${id}`, id, { class: "mono" }) : "–");
  const famLink = (name) => (name ? a(`#/family/${encodeURIComponent(name)}`, name) : "–");
  const short = (hash, n = 12) => (hash ? hash.slice(0, n) : "–");
  const when = (iso) => (iso ? iso.replace("T", " ").replace("Z", "").slice(0, 16) : "–");
  const day = (iso) => (iso ? fmt.date(iso.slice(0, 10)) : "–");
  function numCell(v, d = 2, pct = false) {
    const td = h("td", { class: "num" + (v != null && v < 0 ? " neg" : "") });
    td.textContent = v == null ? "–" : pct ? fmt.pctPlain(v, 1) : fmt.num(v, d);
    return td;
  }
  function metric(e, scope, key) { return ((e.metrics || {})[scope] || {})[key]; }
  function card(title, sub, ...body) {
    const head = h("div", { class: "card__head" }, h("h3", { class: "card__title", text: title }), sub ? h("span", { class: "card__sub", text: sub }) : null);
    return h("section", { class: "card" }, head, ...body);
  }
  function table(headers, rows, opts = {}) {
    const thead = h("thead", null, h("tr", null, ...headers.map((x) => {
      const th = h("th", { class: (x.num ? "num" : "") + (x.sort ? " sortable" : ""), scope: "col", text: typeof x === "string" ? x : (x.label ?? "") });
      if (x.sort && opts.onSort) th.addEventListener("click", () => opts.onSort(x.sort));
      if (x.sort && opts.sort && opts.sort.key === x.sort) th.textContent += opts.sort.dir > 0 ? " ▲" : " ▼";
      return th;
    })));
    const tbody = h("tbody", null, ...rows);
    return h("div", { class: "table-wrap" }, h("table", { class: "data" }, thead, tbody));
  }
  function td(content, cls) { const c = h("td", cls ? { class: cls } : null); if (content instanceof Node) c.appendChild(content); else c.textContent = content == null ? "–" : String(content); return c; }
  function chartBox(render) {
    const box = h("div", { class: "chart" });
    const fn = () => render(box);
    state.charts.push(fn);
    requestAnimationFrame(fn);
    return box;
  }
  function kv(pairs) {
    const dl = h("dl", { class: "kv" });
    for (const [k, v] of pairs) {
      if (v === undefined) continue;
      dl.appendChild(h("dt", { text: k }));
      const dd = h("dd");
      if (v instanceof Node) dd.appendChild(v); else dd.textContent = v == null ? "–" : String(v);
      dl.appendChild(dd);
    }
    return dl;
  }
  function hashNode(hash, n) { return h("span", { class: "hash", title: hash || "" , text: n ? short(hash, n) : (hash || "–") }); }
  function paramsText(p) { return Object.entries(p || {}).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`).join(", "); }
  function seriesColor(i) { return `var(--series-${(i % 4) + 1})`; }
  const truthLabel = (t) => (!t ? null : t.planted_effect === true ? "real effect planted" : t.planted_effect === false ? "no effect planted" : "not applicable");

  // ------------------------------------------------------------------ shell
  const NAV = [["", "Overview"], ["experiments", "Experiments"], ["compare", "Compare"], ["families", "Sweeps"], ["hypotheses", "Hypotheses"], ["data", "Data"], ["hygiene", "Warnings"], ["reproduce", "Reproduce"], ["audit", "Audit log"]];
  let main, nav;
  function shell() {
    const app = document.getElementById("app");
    app.replaceChildren();
    if (state.embed) document.body.classList.add("embed");
    const idx = state.index;
    const actions = h("div", { class: "topbar__actions" });
    if (state.embed) {
      const full = location.pathname + location.hash;
      actions.appendChild(h("a", { class: "btn btn--sm", href: full, target: "_blank", rel: "noopener" }, "Open full screen ", icon("ext")));
    } else {
      const btn = h("button", { class: "icon-btn", type: "button", "aria-label": "Switch light or dark mode", title: "Light or dark" }, icon("help", 16));
      btn.replaceChildren(themeIcon());
      btn.addEventListener("click", toggleTheme);
      actions.appendChild(btn);
    }
    app.appendChild(h("header", { class: "topbar" },
      h("div", { class: "brand" }, h("div", { class: "brand__mark", text: "qr" }),
        h("div", null, h("div", { class: "brand__title", text: idx.title || "Research OS" }),
          h("div", { class: "brand__sub", text: `${idx.generated_by} · ${idx.registry.experiments} experiments · ${idx.registry.hypotheses} hypotheses` }))),
      actions));
    nav = h("nav", { class: "nav", "aria-label": "Views" }, ...NAV.map(([k, label]) => a(`#/${k}`, label, { "data-k": k })));
    app.appendChild(nav);
    if (idx.demo) {
      app.appendChild(h("div", { class: "synthetic-banner", role: "note" }, icon("alert", 16),
        h("div", null, h("b", { text: "Synthetic data. " }),
          "Every series comes from a simulated market with planted effects (seed " + idx.demo.seed + "), so the right answer is known. Dates are simulated; no real securities.")));
    }
    main = h("main", { id: "view" });
    app.appendChild(main);
    app.appendChild(h("footer", { class: "footer" },
      h("span", null, "Built with ", a("https://github.com/RasmusCodes/quant-research-os", "quant-research-os", { target: "_blank", rel: "noopener" }), " (MIT)."),
      h("span", { text: `Audit chain: ${idx.audit.events} events, head ${short(idx.audit.head, 16)}` })));
  }
  function themeIcon() {
    const svg = s("svg", { viewBox: "0 0 16 16", width: 16, height: 16, fill: "none", stroke: "currentColor", "stroke-width": 1.6, "aria-hidden": "true" });
    s("circle", { cx: 8, cy: 8, r: 5.5 }, svg);
    s("path", { d: "M8 2.5a5.5 5.5 0 0 1 0 11z", fill: "currentColor", stroke: "none" }, svg);
    return svg;
  }
  function currentTheme() {
    const t = document.documentElement.getAttribute("data-theme");
    if (t) return t;
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  function toggleTheme() {
    const next = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("theme", next); } catch (e) { /* storage may be unavailable */ }
    redrawCharts();
  }
  function redrawCharts() { QC.hideTip(); state.charts.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } }); postHeight(); }

  // ------------------------------------------------------------------ embed: height + theme sync
  let lastHeight = 0;
  function postHeight() {
    if (!state.embed || window.parent === window) return;
    const height = Math.ceil(document.documentElement.scrollHeight);
    if (Math.abs(height - lastHeight) < 2) return;
    lastHeight = height;
    window.parent.postMessage({ type: "qros-height", height }, "*");
  }
  function syncParentTheme() {
    try {
      const root = window.parent.document.documentElement;
      const apply = () => {
        const t = root.getAttribute("data-theme");
        if (t) document.documentElement.setAttribute("data-theme", t); else document.documentElement.removeAttribute("data-theme");
        redrawCharts();
      };
      new MutationObserver(apply).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    } catch (e) { /* cross-origin parent: keep our own theme */ }
  }

  // ------------------------------------------------------------------ router
  const ROUTES = [
    [/^$/, overview], [/^experiments$/, experiments], [/^exp\/(.+)$/, experimentView], [/^compare(?:\/(.*))?$/, compare],
    [/^families$/, familiesIndex], [/^family\/(.+)$/, familyView], [/^hypotheses$/, hypotheses], [/^hyp\/(.+)$/, hypothesisView],
    [/^data(?:\/(.+))?$/, dataView], [/^hygiene$/, hygiene], [/^reproduce$/, reproduceView], [/^audit$/, auditView],
  ];
  async function route() {
    const path = decodeURIComponent((location.hash || "#/").replace(/^#\/?/, ""));
    state.charts = [];
    QC.hideTip();
    const key = path.split("/")[0];
    const navKey = { exp: "experiments", family: "families", hyp: "hypotheses" }[key] ?? key;
    nav.querySelectorAll("a").forEach((el) => el.classList.toggle("is-active", el.dataset.k === navKey));
    main.replaceChildren(h("div", { class: "loading", text: "Loading…" }));
    for (const [re, fn] of ROUTES) {
      const m = path.match(re);
      if (m) {
        try {
          const node = await fn(...m.slice(1));
          main.replaceChildren(node);
        } catch (err) {
          console.error(err);
          main.replaceChildren(h("div", { class: "callout callout--bad" }, h("b", { text: "Could not render this view. " }), String(err.message || err)));
        }
        if (!state.embed) window.scrollTo(0, 0);
        else window.parent.postMessage({ type: "qros-navigate" }, "*");
        setTimeout(postHeight, 60);
        return;
      }
    }
    main.replaceChildren(h("p", null, "Unknown view. ", a("#/", "Back to the overview")));
  }

  // ------------------------------------------------------------------ overview
  function findWarning(code) { return state.index.warnings.find((w) => w.code === code); }
  function overview() {
    const idx = state.index, exps = idx.experiments.filter((e) => e.status === "completed");
    const verdictCount = (v) => exps.filter((e) => e.verdict === v).length;
    const critical = idx.warnings.filter((w) => w.severity === "critical").length;
    const root = h("div", { class: "stack" });
    const counts = `${idx.registry.hypotheses} hypotheses, ${idx.registry.experiments} experiments and ${idx.versions.length} dataset versions, all recorded by the research OS as the work happened.`;
    const caught = [["PIT_VIOLATION", "a look-ahead join"], ["SURVIVORSHIP_BIAS", "a survivor-only universe"], ["UNADJUSTED_PRICES", "unadjusted prices"],
      ["HYPOTHESIS_AMENDED_AFTER_RESULTS", "a hypothesis rewritten after its results"], ["HOLDOUT_OVERUSE", "a holdout used too often"], ["NONREPRODUCIBLE", "a result that did not reproduce"]]
      .filter(([code]) => idx.warnings.some((w) => w.code === code)).map(([, text]) => text);
    const caughtText = caught.length ? ` Among the problems it flagged: ${caught.slice(0, -1).join(", ")}${caught.length > 1 ? " and " : ""}${caught[caught.length - 1]}. Click anything to see why.` : " Click anything to inspect it.";
    root.appendChild(h("div", null,
      h("h1", { class: "page-title", text: idx.demo ? "A research project, replayed and audited" : "Research registry" }),
      h("p", { class: "lead" }, counts + caughtText)));
    const tiles = h("div", { class: "grid grid--tiles" },
      tile("Experiments", fmt.int(idx.registry.experiments), `${idx.registry.completed} completed`),
      tile("Hypotheses", fmt.int(idx.registry.hypotheses), `${idx.hypotheses.filter((x) => x.status === "supported").length} supported`),
      tile("Robust results", String(verdictCount("robust")), "pass every core check"),
      tile("Fragile", String(verdictCount("fragile")), "attractive in-sample only"),
      tile("Invalid", String(verdictCount("invalid")), "integrity problem found"),
      tile("Critical warnings", String(critical), `${idx.warnings.length} active in total`));
    root.appendChild(tiles);
    if (idx.demo) root.appendChild(truthCard(exps));
    root.appendChild(h("h2", { class: "section-title", text: "Start here" }));
    root.appendChild(h("p", { class: "section-sub", text: "Each card opens the evidence for one lesson: the record, the checks and the warnings." }));
    root.appendChild(tour());
    root.appendChild(h("h2", { class: "section-title", text: "Research log" }));
    root.appendChild(h("p", { class: "section-sub", text: "Built from the registry's own records. Timestamps are simulated for the demo (January to March 2025)." }));
    root.appendChild(card("What happened, in order", null, researchLog()));
    return root;
  }
  function tile(label, value, note) { return h("div", { class: "tile" }, h("div", { class: "tile__label", text: label }), h("div", { class: "tile__value", text: value }), note ? h("div", { class: "tile__note", text: note }) : null); }
  function truthCard(exps) {
    const verdicts = ["robust", "fragile", "no-edge", "invalid", "insufficient"];
    const cols = [["real effect planted", (e) => e.truth && e.truth.planted_effect === true], ["no effect planted", (e) => e.truth && e.truth.planted_effect === false], ["not applicable", (e) => !e.truth || e.truth.planted_effect == null]];
    const rows = verdicts.map((v) => {
      const tr = h("tr", null, td(verdictBadge(v)));
      for (const [, f] of cols) {
        const n = exps.filter((e) => e.verdict === v && f(e)).length;
        tr.appendChild(h("td", { class: "num", text: n ? String(n) : "·" }));
      }
      return tr;
    });
    const robust = exps.filter((e) => e.verdict === "robust");
    const falsePos = robust.filter((e) => e.truth && e.truth.planted_effect === false);
    const lead = h("p", { class: "small muted" },
      `Because the market is simulated, each experiment can be scored against what was planted. ${robust.length} experiment${robust.length === 1 ? " is" : "s are"} graded robust`,
      robust.length ? h("span", null, " (", ...robust.flatMap((e, i) => [i ? ", " : "", expLink(e.id)]), ")") : "",
      falsePos.length ? `, including ${falsePos.length} where no effect was planted.` : "; none of them is a false discovery. Real effects can still be graded fragile or no-edge when the evidence is too weak or decays out of sample.");
    return card("Verdicts against the planted truth", "synthetic data only", lead,
      table([{ label: "Verdict" }, ...cols.map(([l]) => ({ label: l, num: true }))], rows));
  }
  function tour() {
    const idx = state.index;
    const items = [];
    const robust = idx.experiments.find((e) => e.verdict === "robust");
    if (robust) items.push([`#/exp/${robust.id}`, "The result that survives", `${robust.id}: ${robust.name}. Pre-registered, deflated for its trials, confirmed on the sealed holdout.`]);
    const fragile = idx.experiments.filter((e) => e.verdict === "fragile").sort((x, y) => (metric(y, "is", "sharpe") || 0) - (metric(x, "is", "sharpe") || 0))[0];
    if (fragile) items.push([`#/exp/${fragile.id}`, "Attractive, but fragile", `${fragile.name}: in-sample Sharpe ${fmt.num(metric(fragile, "is", "sharpe"))}, out of sample ${fmt.num(metric(fragile, "oos", "sharpe"))}.`]);
    const pit = findWarning("PIT_VIOLATION");
    if (pit) items.push([`#/exp/${pit.experiment_id}`, "Look-ahead, caught from the rows used", "Fundamentals joined on the period end instead of the publication date."]);
    const hark = findWarning("HYPOTHESIS_AMENDED_AFTER_RESULTS");
    if (hark) items.push([`#/hyp/${hark.hypothesis_id}`, "A hypothesis rewritten after the results", "The prediction flipped sign after the first test, and was then 'confirmed' on the same data."]);
    const bigFam = idx.families.slice().sort((x, y) => (y.counts.total || 0) - (x.counts.total || 0))[0];
    if (bigFam) items.push([`#/family/${encodeURIComponent(bigFam.name)}`, `${bigFam.counts.total} tries at one idea`, "The sweep, the deflated Sharpe ratio and the probability of backtest overfitting."]);
    const ho = findWarning("HOLDOUT_OVERUSE");
    if (ho) items.push(["#/hygiene", "A holdout looked at too often", "Three looks were allowed; the ledger records every one."]);
    const surv = findWarning("SURVIVORSHIP_BIAS");
    if (surv) {
      const fam = M.exp[surv.experiment_id] && M.exp[surv.experiment_id].family;
      const other = idx.experiments.find((e) => e.family === fam && e.id !== surv.experiment_id);
      items.push([`#/compare/${surv.experiment_id}${other ? "," + other.id : ""}`, "Survivorship bias, side by side", "The same rule on today's survivors and on every firm ever listed."]);
    }
    items.push(["#/reproduce", "Reproduce an experiment in your browser", "Your browser re-runs a recorded experiment and checks its SHA-256 against the registry."]);
    items.push(["#/audit", "Verify the audit log", "Recompute the hash chain over every recorded event, then tamper with one."]);
    return h("div", { class: "tour" }, ...items.map(([href, t, d], i) => h("a", { href }, h("div", { class: "n", text: String(i + 1).padStart(2, "0") }), h("div", { class: "t", text: t }), h("div", { class: "d", text: d }))));
  }
  function researchLog() {
    const idx = state.index, ev = [];
    for (const v of idx.versions) ev.push([v.created_at, "info", `Dataset version ${v.id}: ${(M.ds[v.dataset_id] || {}).name || v.dataset_id}${v.label ? " (" + v.label + ")" : ""}`, `#/data/${v.id}`]);
    for (const x of idx.hypotheses) {
      if (x.registered_at) ev.push([x.registered_at, "good", `${x.id} pre-registered: ${x.title}`, `#/hyp/${x.id}`]);
      for (const v of x.versions.slice(1)) ev.push([v.created_at, "critical", `${x.id} amended to v${v.version}: ${v.reason}`, `#/hyp/${x.id}`]);
    }
    const byDayFam = {};
    for (const e of idx.experiments) {
      if (!e.finished) continue;
      const k = e.finished.slice(0, 10) + "|" + e.family;
      (byDayFam[k] = byDayFam[k] || []).push(e);
    }
    for (const [k, list] of Object.entries(byDayFam)) {
      const counts = {};
      list.forEach((e) => (counts[e.verdict] = (counts[e.verdict] || 0) + 1));
      const text = list.length === 1 ? `${list[0].id} ${list[0].name}: ${VERDICT[list[0].verdict] ? VERDICT[list[0].verdict][1].toLowerCase() : list[0].verdict}`
        : `${list.length} experiments in ${k.split("|")[1]}: ` + Object.entries(counts).map(([v, n]) => `${n} ${VERDICT[v] ? VERDICT[v][1].toLowerCase() : v}`).join(", ");
      const kind = list.some((e) => e.verdict === "invalid") ? "critical" : list.some((e) => e.verdict === "robust") ? "good" : "info";
      ev.push([list[0].finished, kind, text, list.length === 1 ? `#/exp/${list[0].id}` : `#/family/${encodeURIComponent(k.split("|")[1])}`]);
    }
    for (const ho of idx.holdouts) ho.accesses.forEach((acc, i) => ev.push([acc.accessed_at, i + 1 > ho.max_touches ? "critical" : "warn", `Holdout look #${i + 1} of ${ho.max_touches} allowed: ${acc.experiment_id} (${acc.purpose})`, `#/exp/${acc.experiment_id}`]));
    for (const r of idx.reproductions) ev.push([r.run_at, r.status === "exact" || r.status === "numerical" ? "good" : "critical", `Re-ran ${r.experiment_id}: ${r.status}`, `#/exp/${r.experiment_id}`]);
    ev.sort((x, y) => (x[0] < y[0] ? -1 : 1));
    const list = h("ul", { class: "timeline" });
    const render = (n) => {
      list.replaceChildren(...ev.slice(0, n).map(([t, kind, text, href]) => h("li", { class: `k-${kind}` }, h("span", { class: "when", text: when(t) }), href ? a(href, text) : text)));
    };
    render(30);
    const more = ev.length > 30 ? h("button", { class: "btn btn--sm", type: "button", text: `Show all ${ev.length} entries` }) : null;
    if (more) more.addEventListener("click", () => { render(ev.length); more.remove(); postHeight(); });
    return h("div", null, list, more);
  }

  // ------------------------------------------------------------------ experiments list
  function experiments() {
    const idx = state.index;
    const root = h("div", { class: "stack" });
    root.appendChild(h("div", null, h("h1", { class: "page-title", text: "Experiment registry" }),
      h("p", { class: "lead", text: "Every experiment, with its hypothesis, family, out-of-sample record, deflated Sharpe ratio and verdict. Select up to four to compare." })));
    const f = state.filters;
    const search = h("input", { type: "search", placeholder: "Search name, id, tag", value: f.q, "aria-label": "Search experiments" });
    const sel = (label, key, values) => {
      const el = h("select", { "aria-label": label }, h("option", { value: "", text: `All ${label}` }), ...values.map(([v, t]) => h("option", { value: v, text: t })));
      el.value = f[key];
      el.addEventListener("change", () => { f[key] = el.value; draw(); });
      return el;
    };
    const tags = [...new Set(idx.experiments.flatMap((e) => e.tags))].sort();
    const compareBtn = h("button", { class: "btn btn--accent btn--sm", type: "button", text: "Compare selected" });
    compareBtn.addEventListener("click", () => { location.hash = `#/compare/${[...state.selected].join(",")}`; });
    const filters = h("div", { class: "filters" }, search,
      sel("hypotheses", "hyp", idx.hypotheses.map((x) => [x.id, `${x.id} ${x.title}`])),
      sel("families", "fam", idx.families.map((x) => [x.name, x.name])),
      sel("verdicts", "verdict", Object.keys(VERDICT).slice(0, 5).map((v) => [v, VERDICT[v][1]])),
      sel("tags", "tag", tags.map((t) => [t, t])), h("span", { class: "spacer" }), compareBtn);
    search.addEventListener("input", () => { f.q = search.value; draw(); });
    const holder = h("div", { class: "card card--flush" });
    const countLine = h("p", { class: "small muted" });
    root.appendChild(filters);
    root.appendChild(countLine);
    root.appendChild(holder);
    const cols = [
      { label: "", key: null }, { label: "ID", sort: "id" }, { label: "Experiment", sort: "name" }, { label: "Hyp." , sort: "hypothesis"}, { label: "Family", sort: "family" },
      { label: "IS Sharpe", num: true, sort: "is" }, { label: "OOS Sharpe", num: true, sort: "oos" }, { label: "Holdout", num: true, sort: "ho" },
      { label: "DSR", num: true, sort: "dsr" }, { label: "Trials", num: true, sort: "trials" }, { label: "Verdict", sort: "verdict" }, { label: "Warnings" },
    ];
    if (idx.demo) cols.push({ label: "Planted truth" });
    const keyFn = {
      id: (e) => e.id, name: (e) => e.name, hypothesis: (e) => e.hypothesis || "", family: (e) => e.family || "",
      is: (e) => metric(e, "is", "sharpe") ?? -99, oos: (e) => metric(e, "oos", "sharpe") ?? -99, ho: (e) => metric(e, "holdout", "sharpe") ?? -99,
      dsr: (e) => e.sig.dsr ?? -1, trials: (e) => e.sig.n_trials ?? 0, verdict: (e) => e.verdict || "",
    };
    function draw() {
      const q = f.q.trim().toLowerCase();
      let list = idx.experiments.filter((e) =>
        (!q || (e.id + " " + e.name + " " + e.tags.join(" ") + " " + (e.model || "")).toLowerCase().includes(q)) &&
        (!f.hyp || e.hypothesis === f.hyp) && (!f.fam || e.family === f.fam) && (!f.verdict || e.verdict === f.verdict) && (!f.tag || e.tags.includes(f.tag)));
      const kf = keyFn[state.sort.key] || keyFn.id;
      list = list.slice().sort((x, y) => { const p = kf(x), q2 = kf(y); return (p < q2 ? -1 : p > q2 ? 1 : 0) * state.sort.dir; });
      countLine.textContent = `${list.length} of ${idx.experiments.length} experiments`;
      compareBtn.disabled = state.selected.size < 2;
      compareBtn.textContent = state.selected.size ? `Compare selected (${state.selected.size})` : "Compare selected";
      const rows = list.map((e) => {
        const box = h("input", { type: "checkbox", "aria-label": `Select ${e.id}` });
        box.checked = state.selected.has(e.id);
        box.addEventListener("change", () => {
          if (box.checked) { if (state.selected.size >= 4) { box.checked = false; return; } state.selected.add(e.id); } else state.selected.delete(e.id);
          draw();
        });
        const tr = h("tr", { class: state.selected.has(e.id) ? "is-selected" : "" }, td(box), td(expLink(e.id)), td(a(`#/exp/${e.id}`, e.name)), td(hypLink(e.hypothesis)), td(famLink(e.family)),
          numCell(metric(e, "is", "sharpe")), numCell(metric(e, "oos", "sharpe")), numCell(metric(e, "holdout", "sharpe")),
          numCell(e.sig.dsr, 3), h("td", { class: "num", text: e.sig.n_trials ?? "–" }), td(verdictBadge(e.verdict || e.status)), td(wcount(e.warnings)));
        if (idx.demo) tr.appendChild(td(truthLabel(e.truth) || "–", "small"));
        return tr;
      });
      holder.replaceChildren(table(cols, rows, { sort: state.sort, onSort: (k) => { state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : 1 }; draw(); } }));
      postHeight();
    }
    draw();
    return root;
  }

  // ------------------------------------------------------------------ experiment detail
  function bands(e) {
    const out = [];
    if (e.periods.train) out.push({ from: e.periods.train[0], to: e.periods.train[1], label: "In-sample", fill: "transparent" });
    if (e.periods.test) out.push({ from: e.periods.test[0], to: e.periods.test[1], label: "Out-of-sample", fill: "var(--band-oos)" });
    const ho = e.holdout && state.index.holdouts.find((x) => x.id === e.holdout);
    if (ho && metric(e, "holdout", "n_obs")) out.push({ from: ho.start, to: ho.end, label: "Holdout", fill: "var(--band-holdout)" });
    return out;
  }
  function yearlyTable(eq) {
    const rows = [];
    let prevYear = null, prevVal = 1;
    const last = {};
    eq.d.forEach((d, i) => { last[d.slice(0, 4)] = eq.v[i]; });
    for (const y of Object.keys(last)) {
      const v = last[y];
      rows.push(h("tr", null, td(y), numCell(v / prevVal - 1, 2, true), numCell(v - 1, 2, true)));
      prevVal = v; prevYear = y;
    }
    return table([{ label: "Year" }, { label: "Return", num: true }, { label: "Cumulative", num: true }], rows);
  }
  async function experimentView(id) {
    const e = M.exp[id];
    if (!e) throw new Error(`No experiment ${id}`);
    const d = await detail(id);
    const rep = d.report || {};
    const root = h("div", { class: "stack" });
    const hyp = e.hypothesis && M.hyp[e.hypothesis];
    root.appendChild(h("div", null,
      h("p", { class: "small muted" }, a("#/experiments", "Experiments"), " / ", h("span", { class: "mono", text: e.id })),
      h("div", { class: "row" }, h("h1", { class: "page-title", text: e.name }), verdictBadge(e.verdict || e.status)),
      rep.verdict_reason ? h("p", { class: "lead", text: rep.verdict_reason }) : null,
      h("p", { class: "small muted" }, "Hypothesis ", hypLink(e.hypothesis), e.hypothesis_version ? ` v${e.hypothesis_version}` : "", " · family ", famLink(e.family),
        e.model ? ` · model ${e.model} v${e.model_version}` : "", e.parent ? h("span", null, " · parent ", expLink(e.parent)) : "",
        ` · ${e.source} run · seed ${e.seed ?? "none"} · finished ${when(e.finished)}`),
      e.tags.length ? h("div", null, ...e.tags.map((t) => h("span", { class: "tag", text: t }))) : null));
    if (e.truth) {
      root.appendChild(h("div", { class: "callout callout--truth" }, h("b", { text: "Planted truth: " }), `${truthLabel(e.truth)}. ${e.truth.label}.`));
    }
    if (e.metrics_only) {
      root.appendChild(card("Scalar results", "no return series", kv(Object.entries(e.custom || {}).map(([k, v]) => [k, fmt.num(v, 4)]))));
    }
    if (d.series) {
      const ser = d.series;
      const S = (k) => ({ d: ser.d, v: ser[k] });
      // Net and gross only: a long-only benchmark has a different risk profile and would squash the scale.
      const lines = [{ label: "Strategy, net of costs", color: "var(--series-1)", d: ser.d, v: ser.equity.map((v) => v - 1) }];
      if (ser.gross_equity) lines.push({ label: "Before costs", color: "var(--series-2)", d: ser.d, v: ser.gross_equity.map((v) => (v == null ? null : v - 1)), width: 1.5 });
      root.appendChild(card("Cumulative return", "weekly samples of the daily series; shaded windows from the experiment record",
        chartBox((el) => QC.line(el, { series: lines, bands: bands(e), yFormat: (v) => fmt.pct(v, 0), includeZero: true, height: 300, endLabels: true,
          ariaLabel: "Cumulative return chart", table: () => yearlyTable(S("equity")), note: "Hover or focus the chart and use the arrow keys to read values." }))));
      const pair = h("div", { class: "grid grid--2" });
      pair.appendChild(card("Drawdown", "from the running peak",
        chartBox((el) => QC.line(el, { series: [{ label: "Drawdown", color: "var(--series-1)", d: ser.d, v: ser.drawdown, area: true }], bands: bands(e), yFormat: (v) => fmt.pctPlain(v, 0), height: 200 }))));
      if (ser.rolling_sharpe) {
        pair.appendChild(card("Rolling one-year Sharpe ratio", "annualised",
          chartBox((el) => QC.line(el, { series: [{ label: "Rolling Sharpe", color: "var(--series-1)", d: ser.rolling_sharpe.d, v: ser.rolling_sharpe.v }], bands: bands(e), yFormat: (v) => fmt.num(v, 1), includeZero: true, height: 200 }))));
      }
      root.appendChild(pair);
    }
    if (rep.scorecard) root.appendChild(scorecardCard(rep));
    const g2 = h("div", { class: "grid grid--2" });
    g2.appendChild(metricsCard(e));
    if (rep.significance) g2.appendChild(significanceCard(e, rep));
    root.appendChild(g2);
    const g3 = h("div", { class: "grid grid--2" });
    if (rep.sensitivity) g3.appendChild(sensitivityCard(e, rep));
    if (rep.regimes && (rep.regimes.volatility || rep.regimes.years)) g3.appendChild(regimeCard(rep));
    if (g3.childNodes.length) root.appendChild(g3);
    if (rep.walk_forward) root.appendChild(walkForwardCard(rep.walk_forward));
    root.appendChild(warningsCard(d.warnings, e));
    const g4 = h("div", { class: "grid grid--2" });
    if (hyp) g4.appendChild(hypothesisCard(e, hyp));
    g4.appendChild(provenanceCard(e, d));
    root.appendChild(g4);
    root.appendChild(historyCard(e, d));
    return root;
  }
  function scorecardCard(rep) {
    const rows = rep.scorecard.map((g) => h("tr", null, td(gate(g.status)), td(g.label + (g.core ? "" : " (informational)")),
      td(g.value == null ? "–" : typeof g.value === "number" ? fmt.num(g.value, 3) : typeof g.value === "boolean" ? (g.value ? "yes" : "no") : String(g.value), "num"), td(g.threshold || "–", "small muted"), td(g.note, "small")));
    return card("Robustness scorecard", "the verdict is a rule over these checks", table([{ label: "" }, { label: "Check" }, { label: "Value", num: true }, { label: "Needs" }, { label: "Detail" }], rows),
      h("p", { class: "small muted", style: "margin-top:8px" }, "Robust = every applicable core check passes. Invalid = an integrity problem. Fragile = attractive in-sample but fails a core check. ", a("https://github.com/RasmusCodes/quant-research-os/blob/main/docs/VALIDATION.md", "How each check is computed", { target: "_blank", rel: "noopener" }), "."));
  }
  function metricsCard(e) {
    const scopes = [["is", "In-sample"], ["oos", "Out-of-sample"], ["holdout", "Holdout"], ["full", "All non-holdout"]].filter(([k]) => e.metrics[k]);
    const rowsDef = [["sharpe", "Sharpe ratio", 2], ["ann_return", "Annual return", "pct"], ["ann_vol", "Annual volatility", "pct"], ["max_drawdown", "Max drawdown", "pct"], ["sortino", "Sortino", 2], ["hit_rate", "Hit rate", "pct"], ["nw_t_stat", "t-stat (Newey-West)", 2], ["psr0", "P(Sharpe > 0)", 3], ["ann_turnover", "Annual turnover", 1], ["ann_cost", "Annual cost drag", "pct"], ["skew", "Skewness", 2], ["kurtosis", "Kurtosis", 2], ["n_obs", "Observations", 0]];
    const rows = rowsDef.filter(([k]) => scopes.some(([s2]) => e.metrics[s2][k] != null)).map(([k, label, d]) =>
      h("tr", null, td(label), ...scopes.map(([s2]) => { const v = e.metrics[s2][k]; return d === "pct" ? numCell(v, 2, true) : d === 0 ? h("td", { class: "num", text: v == null ? "–" : fmt.int(v) }) : numCell(v, d); })));
    return card("Performance by window", "same metric code for every strategy", table([{ label: "" }, ...scopes.map(([, l]) => ({ label: l, num: true }))], rows));
  }
  function ciRow(label, b) {
    if (!b || b.lo == null) return null;
    const lo = Math.min(b.lo, 0), hi = Math.max(b.hi, 0), span = hi - lo || 1;
    const pos = (v) => ((v - lo) / span * 100).toFixed(1) + "%";
    return h("tr", null, td(label), td(h("div", { class: "ci", style: "min-width:140px" }, h("span", { class: "zero", style: `left:${pos(0)}` }),
      h("span", { class: "line", style: `left:${pos(b.lo)};width:${((b.hi - b.lo) / span * 100).toFixed(1)}%` }), h("span", { class: "dot", style: `left:${pos(b.sharpe)}` }))),
      td(`${fmt.num(b.sharpe)} [${fmt.num(b.lo)}, ${fmt.num(b.hi)}]`, "num"), numCell(b.prob_le_0, 3));
  }
  function significanceCard(e, rep) {
    const sig = rep.significance, boot = rep.bootstrap || {};
    const hc = sig.haircut || {};
    const pairs = [
      ["Trials in family", `${sig.n_trials ?? "–"} (effective ${fmt.num(sig.n_eff, 1)}${sig.avg_corr != null ? `, average correlation ${fmt.num(sig.avg_corr)}` : ""})`],
      ["Expected best noise Sharpe", sig.sr0_annual != null ? fmt.num(sig.sr0_annual) + " (the hurdle the deflated Sharpe ratio uses)" : "–"],
      ["P(Sharpe > 0), in-sample", fmt.num(sig.is_psr0, 4)],
      ["Deflated Sharpe ratio", sig.dsr != null ? fmt.num(sig.dsr, 4) : "–"],
      ["Haircut Sharpe (Holm)", hc.sharpe_adjusted != null ? `${fmt.num(hc.sharpe_adjusted)} (haircut ${fmt.pctPlain(hc.haircut, 0)})` : "–"],
      ["Out-of-sample p", sig.oos_p != null ? `${fmt.num(sig.oos_p, 4)} raw · ${fmt.num(sig.oos_p_holm, 4)} Holm · ${fmt.num(sig.oos_p_bh, 4)} BH (${sig.oos_tests} tests)` : "–"],
      ["Holdout p", sig.holdout_p != null ? fmt.num(sig.holdout_p, 4) : "–"],
      ["Minimum track record", sig.min_trl_years != null && isFinite(sig.min_trl_years) ? `${fmt.num(sig.min_trl_years, 1)} years for 95% confidence` : "not reached"],
    ];
    const ciRows = [ciRow("In-sample", boot.is), ciRow("Out-of-sample", boot.oos), ciRow("Holdout", boot.holdout)].filter(Boolean);
    return card("Statistical significance", "deflated for every trial in the family", kv(pairs),
      ciRows.length ? h("div", { style: "margin-top:12px" }, h("div", { class: "small muted", text: "Stationary-bootstrap 95% intervals for the Sharpe ratio" }),
        table([{ label: "Window" }, { label: "Interval" }, { label: "Sharpe [95% CI]", num: true }, { label: "P(SR ≤ 0)", num: true }], ciRows)) : null);
  }
  function sensitivityCard(e, rep) {
    const sens = rep.sensitivity, out = card("Sensitivity", "does the result survive small changes?");
    const nb = sens.neighborhood;
    if (nb && nb.keys && nb.keys.length) {
      out.appendChild(kv([["Rank in family", `${nb.rank} of ${nb.n_configs} by in-sample Sharpe`], ["Neighbours tried", String(nb.n_neighbours)],
        ["Neighbour average", nb.n_neighbours ? `${fmt.num(nb.neighbour_mean)} vs ${fmt.num(nb.metric)} here (ratio ${fmt.num(nb.plateau_ratio)})` : "–"],
        ["Family median", fmt.num(nb.family_median)], ["Share with Sharpe > 0", fmt.pctPlain(nb.share_positive, 0)]]));
    }
    if (sens.costs) {
      const items = ["0x", "1x", "2x", "3x"].filter((k) => sens.costs[k] != null).map((k) => ({ label: k === "0x" ? "No costs" : `${k} modelled costs`, value: sens.costs[k] }));
      out.appendChild(h("div", { class: "small muted", style: "margin-top:12px", text: "Sharpe ratio as trading costs scale (all non-holdout data)" }));
      out.appendChild(chartBox((el) => QC.bars(el, { items, format: (v) => fmt.num(v) })));
    }
    if (sens.drop_best) out.appendChild(kv([["Trimmed Sharpe", `${fmt.num(sens.drop_best.sharpe_trimmed)} after removing the ${sens.drop_best.removed} best and worst periods (${fmt.num(sens.drop_best.sharpe)} untrimmed)`]]));
    if (sens.variants) out.appendChild(kv(Object.entries(sens.variants).map(([k, v]) => [k, fmt.num(v)])));
    return out;
  }
  function regimeCard(rep) {
    const rg = rep.regimes, out = card("Regimes", "labels use only past data");
    const set = rg.volatility ? [["Volatility regime", rg.volatility], ["Market trend", rg.trend]] : [];
    for (const [title, r] of set) {
      if (!r) continue;
      out.appendChild(h("div", { class: "small muted", text: title }));
      out.appendChild(chartBox((el) => QC.bars(el, { items: r.regimes.map((x) => ({ label: `${x.regime} (${x.n_obs} days)`, value: x.sharpe })), format: (v) => fmt.num(v) })));
    }
    if (rg.years) {
      const rows = rg.years.regimes.map((x) => h("tr", null, td(x.regime), numCell(x.sharpe), numCell(x.ann_return, 2, true), h("td", { class: "num", text: String(x.n_obs) })));
      const box = h("details", null, h("summary", { class: "small", text: `Calendar years: positive in ${fmt.pctPlain(rg.years.share_positive, 0)} of ${rg.years.n_regimes}` }),
        table([{ label: "Year" }, { label: "Sharpe", num: true }, { label: "Return (ann.)", num: true }, { label: "Days", num: true }], rows));
      box.addEventListener("toggle", postHeight);
      out.appendChild(box);
    }
    return out;
  }
  function walkForwardCard(wf) {
    const rows = (wf.folds || []).map((f) => h("tr", null, td(f.test_range ? `${f.test_range[0].slice(0, 4)}` : f.index), td(f.selected, "mono"), numCell(f.train_score * Math.sqrt(252)), h("td", { class: "num", text: String(f.n_train) })));
    return card("Walk-forward selection", `${wf.distinct_selections} different winners in ${wf.folds.length} years; switch rate ${fmt.pctPlain(wf.switch_rate, 0)}`,
      h("p", { class: "small muted", text: "Each year trades the configuration with the best Sharpe ratio on all earlier years, so the stitched record is out-of-sample for the search itself. Frequent switching means the 'best' parameters are not stable." }),
      table([{ label: "Traded year" }, { label: "Selected (fast/slow)" }, { label: "Train Sharpe", num: true }, { label: "Train days", num: true }], rows));
  }
  function warningsCard(list, e) {
    const famW = (M.warnByScope[`family:${e.family}`] || []);
    const hypW = e.hypothesis ? (M.warnByScope[`hypothesis:${e.hypothesis}`] || []) : [];
    const all = [...(list || []), ...famW, ...hypW];
    if (!all.length) return card("Research-hygiene warnings", null, h("p", { class: "small muted", text: "No warnings for this experiment, its family or its hypothesis." }));
    const rules = state.index.rules;
    const order = { critical: 0, warning: 1, info: 2 };
    const rows = all.sort((x, y) => order[x.severity] - order[y.severity]).map((w) => h("tr", null, td(sevBadge(w.severity)),
      td(h("div", null, h("b", { text: (rules[w.code] || {}).title || w.code }), h("div", { class: "small", text: w.message }), h("div", { class: "small muted", text: (rules[w.code] || {}).why || "" }))),
      td(w.scope_key.startsWith("EXP") ? "this experiment" : w.scope_key, "small mono")));
    return card("Research-hygiene warnings", `${all.length} active`, table([{ label: "Severity" }, { label: "Warning" }, { label: "Scope" }], rows));
  }
  function hypothesisCard(e, hyp) {
    const v = hyp.versions.find((x) => x.version === e.hypothesis_version) || hyp.versions[0];
    const pre = e.gates && e.gates.preregistered ? e.gates.preregistered[0] === "pass" : hyp.registered_at && hyp.registered_at <= (e.started || "");
    return card("Hypothesis tested", `${hyp.id}, version ${v.version} of ${hyp.versions.length}`,
      h("p", null, h("b", { text: hyp.title + ". " }), v.statement),
      kv([["Registered", hyp.registered_at ? when(hyp.registered_at) : "never"], ["Experiment started", when(e.started)],
        ["Pre-registered?", pre ? "yes, before the run" : "no"], ["Prediction", v.prediction ? JSON.stringify(v.prediction) : "–"],
        ["Criteria", v.criteria ? v.criteria.map((c) => `${c.metric} ${c.op} ${c.value}`).join("; ") : "–"], ["Text hash", hashNode(v.text_sha256, 16)]]),
      h("p", { class: "small", style: "margin-top:8px" }, a(`#/hyp/${hyp.id}`, "Full hypothesis history")));
  }
  function provenanceCard(e, d) {
    const dataRows = (d.data || []).map((v) => h("tr", null, td(v.role, "small"), td(a(`#/data/${v.id}`, v.id, { class: "mono" })), td(((M.ds[v.dataset_id] || {}).name || v.dataset_id) + (v.label ? ` (${v.label})` : ""), "small"), td(hashNode(v.content_hash, 12))));
    const code = d.code || {};
    const env = d.environment || {};
    const arts = (d.artifacts || []).map((x) => h("tr", null, td(x.name, "mono small"), td(x.kind, "small"), h("td", { class: "num", text: fmt.int(x.size) }), td(hashNode(x.sha256, 12))));
    return card("Provenance", "what produced this result",
      dataRows.length ? table([{ label: "Role" }, { label: "Version" }, { label: "Dataset" }, { label: "Content hash" }], dataRows) : h("p", { class: "small muted", text: "No registered datasets (data generated from the seed)." }),
      h("div", { style: "margin-top:12px" }, kv([
        ["Code", code.module ? `${code.module}:${(code.qualname || "").split(".").pop()}` : (code.repo || "–")],
        ["Source file hash", code.file_sha256 ? hashNode(code.file_sha256, 16) : (code.source_sha256 ? hashNode(code.source_sha256, 16) : "–")],
        ["Parameters", paramsText(e.params) || "–"], ["Seed", e.seed ?? "none"],
        ["Spec hash", hashNode(e.spec_hash, 16)], ["Result hash", hashNode(e.result_hash, 16)],
        ["Environment", env.python ? `Python ${env.python}, ${env.system} ${env.machine}; numpy ${(env.packages || {}).numpy || "?"}, pandas ${(env.packages || {}).pandas || "?"}` : "not declared"],
        ["Package list hash", env.packages_sha256 ? hashNode(env.packages_sha256, 16) : "–"],
      ])),
      arts.length ? h("details", { style: "margin-top:10px" }, h("summary", { class: "small", text: `${arts.length} stored artifacts (content-addressed)` }), table([{ label: "Name" }, { label: "Kind" }, { label: "Bytes", num: true }, { label: "SHA-256" }], arts)) : null);
  }
  function historyCard(e, d) {
    const hist = (d.history || []).map((x) => h("tr", null, td(when(x.computed_at), "small mono"), h("td", { class: "num", text: x.n_trials ?? "–" }), numCell(x.n_eff, 1), numCell(x.dsr, 3), td(verdictBadge(x.verdict))));
    const reps = (d.reproductions || []).map((r) => h("tr", null, td(when(r.run_at), "small mono"), td(r.status), td(hashNode(r.result_hash, 12)), td(r.note || "", "small")));
    const evs = (d.events || []).map((x) => h("tr", null, h("td", { class: "num mono small", text: String(x.seq) }), td(when(x.at), "small mono"), td(x.action, "small"), td(hashNode(x.hash))));
    const notes = (d.notes || []).map((n) => h("li", null, h("span", { class: "when", text: when(n.created_at) }), n.text));
    const out = card("History", "validation reports are append-only: earlier ones are kept",
      table([{ label: "Validated" }, { label: "Trials", num: true }, { label: "Effective", num: true }, { label: "DSR", num: true }, { label: "Verdict" }], hist));
    if (reps.length) out.appendChild(h("div", { style: "margin-top:12px" }, h("div", { class: "small muted", text: "Reproductions" }), table([{ label: "Run" }, { label: "Status" }, { label: "Result hash" }, { label: "Note" }], reps)));
    if (notes.length) out.appendChild(h("div", { style: "margin-top:12px" }, h("div", { class: "small muted", text: "Researcher notes" }), h("ul", { class: "timeline" }, ...notes)));
    const det = h("details", { style: "margin-top:12px" }, h("summary", { class: "small", text: `Audit trail: ${evs.length} events in the hash chain` }), table([{ label: "Seq", num: true }, { label: "At" }, { label: "Action" }, { label: "Hash" }], evs));
    det.addEventListener("toggle", postHeight);
    out.appendChild(det);
    return out;
  }

  // ------------------------------------------------------------------ compare
  function suggestions() {
    const idx = state.index, out = [];
    const w = (code) => idx.warnings.find((x) => x.code === code && x.experiment_id);
    const pit = w("PIT_VIOLATION");
    if (pit) { const fam = M.exp[pit.experiment_id].family; const other = idx.experiments.find((e) => e.family === fam && e.id !== pit.experiment_id && e.params.point_in_time === true); if (other) out.push(["Look-ahead vs point in time", [pit.experiment_id, other.id]]); }
    const surv = w("SURVIVORSHIP_BIAS");
    if (surv) { const fam = M.exp[surv.experiment_id].family; const other = idx.experiments.find((e) => e.family === fam && e.id !== surv.experiment_id); if (other) out.push(["Survivors only vs full listing history", [surv.experiment_id, other.id]]); }
    for (const e of idx.experiments) {
      if (e.parent && e.tags.includes("data-v2")) out.push(["Same model, data v1 vs v2", [e.parent, e.id]]);
      if (e.parent && e.tags.includes("model-v2")) out.push(["Model version 1 vs 2", [e.parent, e.id]]);
    }
    const robust = idx.experiments.find((e) => e.verdict === "robust");
    const fragile = idx.experiments.filter((e) => e.verdict === "fragile").sort((x, y) => (metric(y, "is", "sharpe") || 0) - (metric(x, "is", "sharpe") || 0))[0];
    if (robust && fragile) out.unshift(["Robust vs attractive-but-fragile", [robust.id, fragile.id]]);
    return out;
  }
  async function compare(idsText) {
    const ids = (idsText || "").split(",").map((x) => x.trim()).filter((x) => M.exp[x]).slice(0, 4);
    const root = h("div", { class: "stack" });
    root.appendChild(h("div", null, h("h1", { class: "page-title", text: "Compare experiments" }),
      h("p", { class: "lead", text: "Side by side: what differs in the inputs, how the records compare, and which robustness checks each one passes. Robust results pass the same checks that fragile ones fail." })));
    const sug = suggestions();
    root.appendChild(h("div", { class: "row" }, h("span", { class: "small muted", text: "Try:" }), ...sug.map(([label, pair]) => a(`#/compare/${pair.join(",")}`, label, { class: "btn btn--sm" }))));
    if (ids.length < 2) {
      root.appendChild(h("p", { class: "callout" }, "Pick two to four experiments in the ", a("#/experiments", "registry"), ", or use one of the suggestions above."));
      return root;
    }
    const exps = ids.map((i) => M.exp[i]);
    const dets = await Promise.all(ids.map(detail));
    const head = [{ label: "" }, ...exps.map((e, i) => ({ label: e.id }))];
    const legendRow = h("tr", null, td("Experiment"), ...exps.map((e, i) => td(h("span", null, h("i", { style: `display:inline-block;width:14px;height:2px;border-radius:2px;margin-right:6px;vertical-align:middle;background:${seriesColor(i)}` }), a(`#/exp/${e.id}`, e.name)))));
    const row = (label, f, cls) => h("tr", null, td(label), ...exps.map((e, i) => { const v = f(e, dets[i]); return v instanceof Node ? td(v) : td(v, cls); }));
    const diffRow = (label, f) => {
      const vals = exps.map((e, i) => f(e, dets[i]));
      const differ = new Set(vals.map((v) => JSON.stringify(v))).size > 1;
      return h("tr", { class: differ ? "is-selected" : "" }, td(label + (differ ? " (differs)" : "")), ...vals.map((v) => td(typeof v === "string" ? v : JSON.stringify(v), "small mono")));
    };
    root.appendChild(card("Records", null, table(head, [legendRow,
      row("Verdict", (e) => verdictBadge(e.verdict)),
      row("Sharpe in-sample", (e) => fmt.num(metric(e, "is", "sharpe")), "num"), row("Sharpe out-of-sample", (e) => fmt.num(metric(e, "oos", "sharpe")), "num"),
      row("Sharpe holdout", (e) => fmt.num(metric(e, "holdout", "sharpe")), "num"), row("Annual return, OOS", (e) => fmt.pctPlain(metric(e, "oos", "ann_return"), 1), "num"),
      row("Max drawdown, OOS", (e) => fmt.pctPlain(metric(e, "oos", "max_drawdown"), 1), "num"), row("Deflated Sharpe", (e) => fmt.num(e.sig.dsr, 3), "num"),
      row("Trials in family", (e) => e.sig.n_trials ?? "–", "num"), row("OOS p (Holm)", (e) => fmt.num(e.sig.oos_p_holm, 3), "num"),
      row("PBO (family)", (e) => fmt.num(e.pbo, 2), "num"), row("Warnings", (e) => wcount(e.warnings) || "–")])));
    const lines = dets.map((d, i) => d.series ? { label: exps[i].id, color: seriesColor(i), d: d.series.d, v: d.series.equity.map((v) => v - 1), endLabel: exps[i].id } : null).filter(Boolean);
    if (lines.length) root.appendChild(card("Cumulative return", "net of costs", chartBox((el) => QC.line(el, { series: lines, yFormat: (v) => fmt.pct(v, 0), includeZero: true, height: 300, endLabels: lines.length <= 4 }))));
    const gateKeys = [];
    dets.forEach((d) => (d.report?.scorecard || []).forEach((g) => { if (!gateKeys.find((x) => x[0] === g.key)) gateKeys.push([g.key, g.label]); }));
    const gateRows = gateKeys.map(([k, label]) => h("tr", null, td(label), ...dets.map((d) => { const g = (d.report?.scorecard || []).find((x) => x.key === k); return td(g ? gate(g.status) : "–"); })));
    root.appendChild(card("Robustness scorecard", "each check, each experiment", table(head, gateRows)));
    const keys = [...new Set(exps.flatMap((e) => Object.keys(e.params)))].sort();
    root.appendChild(card("Inputs", "rows that differ are highlighted", table(head, [
      diffRow("Hypothesis", (e) => `${e.hypothesis || "–"} v${e.hypothesis_version || "–"}`), diffRow("Family", (e) => e.family),
      diffRow("Model", (e) => `${e.model || "–"} v${e.model_version || "–"}`), ...keys.map((k) => diffRow(`param ${k}`, (e) => e.params[k] ?? "–")),
      diffRow("Seed", (e) => String(e.seed ?? "–")), ...[...new Set(exps.flatMap((e) => Object.keys(e.data)))].sort().map((r) => diffRow(`data ${r}`, (e) => e.data[r] || "–")),
      diffRow("Train window", (e) => (e.periods.train || ["–"]).join(" to ")), diffRow("Test window", (e) => (e.periods.test || ["–"]).join(" to ")),
      diffRow("Holdout opened", (e) => (e.holdout_opened ? "yes" : "no")), diffRow("Code hash", (e) => short(e.code_hash)), diffRow("Spec hash", (e) => short(e.spec_hash)),
    ])));
    return root;
  }

  // ------------------------------------------------------------------ families / sweeps
  function familiesIndex() {
    const idx = state.index;
    const rows = idx.families.slice().sort((x, y) => y.counts.total - x.counts.total).map((f) => {
      const members = f.members.map((i) => M.exp[i]);
      const best = members.slice().sort((x, y) => (metric(y, "is", "sharpe") ?? -9) - (metric(x, "is", "sharpe") ?? -9))[0];
      return h("tr", null, td(famLink(f.name)), h("td", { class: "num", text: String(f.counts.total) }), numCell(f.n_eff, 1), numCell(f.sr0_annual), numCell(best ? metric(best, "is", "sharpe") : null), numCell(f.pbo ? f.pbo.pbo : null), td(wcount({ critical: f.warnings.filter((w) => w.severity === "critical").length, warning: f.warnings.filter((w) => w.severity === "warning").length, info: f.warnings.filter((w) => w.severity === "info").length })));
    });
    return h("div", { class: "stack" }, h("div", null, h("h1", { class: "page-title", text: "Trial families and parameter sweeps" }),
      h("p", { class: "lead", text: "A family is every configuration tried for one idea. Its size sets the hurdle: the best of many noise trials looks good by luck, so significance is deflated by the (effective) number of trials, and the probability of backtest overfitting asks how often the in-sample winner disappoints out of sample." })),
      card("Families", null, table([{ label: "Family" }, { label: "Trials", num: true }, { label: "Effective", num: true }, { label: "Noise hurdle", num: true }, { label: "Best IS Sharpe", num: true }, { label: "PBO", num: true }, { label: "Warnings" }], rows)));
  }
  async function familyView(name) {
    const f = M.fam[name];
    if (!f) throw new Error(`No family ${name}`);
    const members = f.members.map((i) => M.exp[i]).filter(Boolean);
    const isVals = members.map((e) => metric(e, "is", "sharpe")).filter((v) => v != null);
    const best = members.slice().sort((x, y) => (metric(y, "is", "sharpe") ?? -9) - (metric(x, "is", "sharpe") ?? -9))[0];
    const hyp = members.find((e) => e.hypothesis);
    const root = h("div", { class: "stack" });
    root.appendChild(h("div", null, h("p", { class: "small muted" }, a("#/families", "Sweeps"), " / ", name),
      h("h1", { class: "page-title", text: `Family: ${name}` }),
      h("p", { class: "lead" }, hyp ? h("span", null, "Tests ", hypLink(hyp.hypothesis), " (", (M.hyp[hyp.hypothesis] || {}).title || "", "). ") : "",
        `${f.counts.registered} registered runs, ${f.counts.distinct} distinct specifications${f.counts.external ? `, plus ${f.counts.external} declared outside qros` : ""}.`)));
    root.appendChild(h("div", { class: "grid grid--tiles" },
      tile("Trials counted", String(f.counts.total), "distinct specs + declared"), tile("Effective trials", fmt.num(f.n_eff, 1), f.avg_corr != null ? `average correlation ${fmt.num(f.avg_corr)}` : ""),
      tile("Noise hurdle", fmt.num(f.sr0_annual), "expected best Sharpe of that many noise trials"), tile("Best in-sample Sharpe", best ? fmt.num(metric(best, "is", "sharpe")) : "–", best ? best.id : ""),
      tile("PBO", f.pbo ? fmt.num(f.pbo.pbo) : "–", f.pbo ? `${fmt.int(f.pbo.n_combinations)} CSCV splits` : "needs 4+ configurations")));
    if (isVals.length >= 3) {
      const lo = Math.floor(Math.min(...isVals, 0) * 10) / 10, hi = Math.ceil(Math.max(...isVals, f.sr0_annual || 0) * 10) / 10;
      const nb = Math.min(20, Math.max(6, Math.round(isVals.length / 2)));
      const w = (hi - lo) / nb || 0.1;
      const bins = Array.from({ length: nb }, (_, i) => ({ x0: lo + i * w, x1: lo + (i + 1) * w, count: 0, items: [] }));
      members.forEach((e) => { const v = metric(e, "is", "sharpe"); if (v == null) return; const k = Math.min(nb - 1, Math.max(0, Math.floor((v - lo) / w))); bins[k].count++; bins[k].items.push(e.id); if (best && e.id === best.id) bins[k].highlight = true; });
      const markers = [];
      if (f.sr0_annual != null) markers.push({ x: f.sr0_annual, label: `noise hurdle ${fmt.num(f.sr0_annual)}` });
      if (best) markers.push({ x: metric(best, "is", "sharpe"), label: `best ${fmt.num(metric(best, "is", "sharpe"))}`, row: 1 });
      const g = h("div", { class: "grid grid--2" });
      g.appendChild(card("In-sample Sharpe ratios of all trials", "the selected maximum vs the noise hurdle",
        chartBox((el) => QC.histogram(el, { bins, markers, countLabel: "trials", xFormat: (v) => fmt.num(v, 1), legend: [{ label: "trials", color: "var(--series-1)" }, { label: "bin holding the best trial", color: "var(--series-2)" }],
          table: () => table([{ label: "Experiment" }, { label: "IS Sharpe", num: true }], members.map((e) => h("tr", null, td(expLink(e.id)), numCell(metric(e, "is", "sharpe"))))) }))));
      const pts = members.filter((e) => metric(e, "is", "sharpe") != null && metric(e, "oos", "sharpe") != null).map((e) => ({ x: metric(e, "is", "sharpe"), y: metric(e, "oos", "sharpe"), id: e.id, label: `${e.id} ${e.name}`, highlight: best && e.id === best.id, tag: best && e.id === best.id ? "best in-sample" : null }));
      g.appendChild(card("In-sample vs out-of-sample", "points below the diagonal lost Sharpe out of sample",
        chartBox((el) => QC.scatter(el, { points: pts, xLabel: "Sharpe in-sample", yLabel: "Sharpe out-of-sample", diagonal: true, onClick: (id) => (location.hash = `#/exp/${id}`),
          table: () => table([{ label: "Experiment" }, { label: "IS", num: true }, { label: "OOS", num: true }], pts.map((p) => h("tr", null, td(expLink(p.id)), numCell(p.x), numCell(p.y)))) }))));
      root.appendChild(g);
    }
    if (f.pbo && f.pbo.logit_hist) {
      const lh = f.pbo.logit_hist;
      const bins = lh.counts.map((c, i) => ({ x0: lh.edges[i], x1: lh.edges[i + 1], count: c }));
      root.appendChild(card("Probability of backtest overfitting", `PBO = ${fmt.num(f.pbo.pbo)}: share of splits where the in-sample winner ranks at or below the out-of-sample median`,
        h("p", { class: "small muted", text: `Combinatorially symmetric cross-validation: the ${f.pbo.n_obs} common observations are cut into ${f.pbo.n_splits} blocks; each of the ${fmt.int(f.pbo.n_combinations)} ways of choosing half the blocks as in-sample picks a winner and records its out-of-sample rank as a logit. Mass left of zero is overfitting.` }),
        chartBox((el) => QC.histogram(el, { bins, shadeBelow: 0, shadeLabel: "winner below the OOS median", countLabel: "splits", xFormat: (v) => fmt.num(v, 1), height: 200,
          table: () => table([{ label: "Logit from" }, { label: "to" }, { label: "Splits", num: true }], bins.map((b) => h("tr", null, numCell(b.x0), numCell(b.x1), h("td", { class: "num", text: String(b.count) })))) }))));
    }
    if (f.heat && f.heat.is && f.heat.is.xs.length) {
      const holder = h("div");
      const which = h("div", { class: "row" });
      let mode = "is";
      const drawHeat = () => {
        const hm = f.heat[mode];
        holder.replaceChildren();
        const box = h("div", { class: "chart" });
        holder.appendChild(box);
        const render = () => QC.heatmap(box, { xs: hm.xs, ys: hm.ys, z: hm.z, xLabel: hm.x, yLabel: hm.y, valueLabel: mode === "is" ? "Sharpe in-sample" : "Sharpe out-of-sample",
          highlight: best ? { x: best.params[hm.x], y: best.params[hm.y] } : null, scaleNote: "Sharpe ratio (blue positive, red negative)",
          onClick: (xv, yv) => { const e = members.find((m) => m.params[hm.x] === xv && m.params[hm.y] === yv); if (e) location.hash = `#/exp/${e.id}`; },
          table: () => table([{ label: `${hm.y} \\ ${hm.x}` }, ...hm.xs.map((x) => ({ label: String(x), num: true }))], hm.ys.map((y, r) => h("tr", null, td(String(y)), ...hm.xs.map((x, c) => numCell(hm.z[r][c]))))) });
        state.charts.push(render);
        render();
        postHeight();
      };
      for (const [k, label] of [["is", "In-sample"], ["oos", "Out-of-sample"]]) {
        const b = h("button", { class: "btn btn--sm", type: "button", "aria-pressed": String(k === mode), text: label });
        b.addEventListener("click", () => { mode = k; which.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); drawHeat(); });
        which.appendChild(b);
      }
      root.appendChild(card("Parameter sensitivity", "Sharpe over the grid; the outlined cell is the in-sample winner", which, holder));
      requestAnimationFrame(drawHeat);
    }
    const rows = members.map((e) => h("tr", null, td(expLink(e.id)), td(paramsText(e.params), "small mono"), numCell(metric(e, "is", "sharpe")), numCell(metric(e, "oos", "sharpe")), numCell(metric(e, "holdout", "sharpe")), numCell(e.sig.dsr, 3), td(verdictBadge(e.verdict))));
    root.appendChild(card("Members", `${members.length} completed runs`, table([{ label: "ID" }, { label: "Parameters" }, { label: "IS", num: true }, { label: "OOS", num: true }, { label: "Holdout", num: true }, { label: "DSR", num: true }, { label: "Verdict" }], rows)));
    if (f.warnings.length) root.appendChild(warningsCard(f.warnings, { family: "__none__" }));
    return root;
  }

  // ------------------------------------------------------------------ hypotheses
  function hypotheses() {
    const rows = state.index.hypotheses.map((x) => {
      const exps = x.experiments.map((i) => M.exp[i]).filter(Boolean);
      const counts = {};
      exps.forEach((e) => (counts[e.verdict] = (counts[e.verdict] || 0) + 1));
      return h("tr", null, td(hypLink(x.id)), td(a(`#/hyp/${x.id}`, x.title)), td(statusBadge(x.status)), td(x.registered_at ? when(x.registered_at) : "never", "small mono"),
        h("td", { class: "num", text: String(x.versions.length) }), td(Object.entries(counts).map(([v, n]) => `${n} ${VERDICT[v] ? VERDICT[v][1].toLowerCase() : v}`).join(", "), "small"),
        td(wcount({ critical: x.warnings.filter((w) => w.severity === "critical").length })));
    });
    return h("div", { class: "stack" }, h("div", null, h("h1", { class: "page-title", text: "Hypotheses" }),
      h("p", { class: "lead", text: "Each hypothesis is registered (locked) before it is tested. Amendments create new versions; earlier versions stay readable, and an amendment after results is flagged, because rewriting a hypothesis to fit the data makes that data useless as evidence for it." })),
      card("Registered hypotheses", null, table([{ label: "ID" }, { label: "Title" }, { label: "Status" }, { label: "Registered" }, { label: "Versions", num: true }, { label: "Experiments" }, { label: "Critical" }], rows)));
  }
  function wordDiff(aText, bText) {
    const A = aText.split(/(\s+)/), B = bText.split(/(\s+)/);
    const dp = Array.from({ length: A.length + 1 }, () => new Array(B.length + 1).fill(0));
    for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const out = h("p", { class: "diff" });
    let i = 0, j = 0;
    while (i < A.length || j < B.length) {
      if (i < A.length && j < B.length && A[i] === B[j]) { out.appendChild(document.createTextNode(A[i])); i++; j++; }
      else if (j < B.length && (i >= A.length || dp[i][j + 1] >= dp[i + 1][j])) { out.appendChild(h("ins", { text: B[j] })); j++; }
      else { out.appendChild(h("del", { text: A[i] })); i++; }
    }
    return out;
  }
  function criteriaMet(e, crit) {
    if (!crit || !crit.length) return null;
    return crit.every((c) => {
      const [scope, key] = c.metric.split(".");
      const v = scope === "validation" ? e.sig[key] : metric(e, scope, key);
      if (v == null) return false;
      return { ">=": v >= c.value, ">": v > c.value, "<=": v <= c.value, "<": v < c.value }[c.op];
    });
  }
  function hypothesisView(id) {
    const x = M.hyp[id];
    if (!x) throw new Error(`No hypothesis ${id}`);
    const root = h("div", { class: "stack" });
    root.appendChild(h("div", null, h("p", { class: "small muted" }, a("#/hypotheses", "Hypotheses"), " / ", id),
      h("div", { class: "row" }, h("h1", { class: "page-title", text: `${x.id}: ${x.title}` }), statusBadge(x.status)),
      h("p", { class: "lead", text: x.statement }), x.status_note ? h("p", { class: "small muted", text: x.status_note }) : null));
    for (const w of x.warnings) root.appendChild(h("div", { class: "callout callout--bad" }, sevBadge(w.severity), " ", h("b", { text: (state.index.rules[w.code] || {}).title || w.code }), ". ", w.message));
    const vers = h("div", { class: "stack" });
    x.versions.forEach((v, i) => {
      const prev = x.versions[i - 1];
      vers.appendChild(h("div", null, h("div", { class: "small muted" }, `Version ${v.version} · ${when(v.created_at)} · ${v.reason || ""} · `, hashNode(v.text_sha256, 12)),
        prev ? wordDiff(prev.statement, v.statement) : h("p", { text: v.statement }),
        v.prediction ? h("div", { class: "small" }, "Prediction: ", h("code", { text: JSON.stringify(v.prediction) })) : null,
        v.criteria ? h("div", { class: "small" }, "Success criteria: ", h("code", { text: v.criteria.map((c) => `${c.metric} ${c.op} ${c.value}`).join("; ") })) : null));
    });
    root.appendChild(card("Version history", x.registered_at ? `locked ${when(x.registered_at)}; first result ${when(x.first_result_at)}` : "never registered", vers));
    const tl = h("ul", { class: "timeline" });
    const items = [];
    for (const ev of x.timeline) items.push([ev.at, ev.action === "hypothesis.amended" ? "critical" : ev.action === "hypothesis.registered" ? "good" : "info", ev.action.replace("hypothesis.", "") + (ev.payload.reason ? `: ${ev.payload.reason}` : ev.payload.status ? `: ${ev.payload.status}` : ""), null]);
    for (const i of x.experiments) { const e = M.exp[i]; if (e && e.finished) items.push([e.finished, e.verdict === "invalid" ? "critical" : e.verdict === "robust" ? "good" : "info", `${e.id} finished (tests v${e.hypothesis_version}): ${e.name}, ${VERDICT[e.verdict] ? VERDICT[e.verdict][1].toLowerCase() : e.verdict}`, `#/exp/${e.id}`]); }
    for (const n of x.notes) items.push([n.created_at, "info", `Note: ${n.text}`, null]);
    items.sort((p, q) => (p[0] < q[0] ? -1 : 1)).forEach(([t, k, text, href]) => tl.appendChild(h("li", { class: `k-${k}` }, h("span", { class: "when", text: when(t) }), href ? a(href, text) : text)));
    root.appendChild(card("Timeline", "registration, amendments, results and status changes", tl));
    const crit = x.versions[x.versions.length - 1].criteria;
    const rows = x.experiments.map((i) => M.exp[i]).filter(Boolean).map((e) => {
      const met = criteriaMet(e, crit);
      return h("tr", null, td(expLink(e.id)), td(a(`#/exp/${e.id}`, e.name)), h("td", { class: "num", text: `v${e.hypothesis_version}` }), numCell(metric(e, "oos", "sharpe")), numCell(metric(e, "holdout", "sharpe")), numCell(e.sig.dsr, 3), td(met == null ? "–" : met ? gate("pass") : gate("fail")), td(verdictBadge(e.verdict)));
    });
    root.appendChild(card("Experiments", "criteria = the pre-registered success criteria of the current version", table([{ label: "ID" }, { label: "Experiment" }, { label: "Tests", num: true }, { label: "OOS", num: true }, { label: "Holdout", num: true }, { label: "DSR", num: true }, { label: "Criteria" }, { label: "Verdict" }], rows)));
    return root;
  }

  // ------------------------------------------------------------------ data provenance
  function dataView(versionId) {
    const idx = state.index;
    const root = h("div", { class: "stack" });
    root.appendChild(h("div", null, h("h1", { class: "page-title", text: "Data provenance" }),
      h("p", { class: "lead", text: "Every dataset version is content-addressed: its id comes from a canonical hash of the data, so a result can always be traced to the exact bytes behind it and re-verified. Derived data records the transform and its inputs." })));
    const nodes = idx.versions.map((v) => {
      const ds = M.ds[v.dataset_id] || {};
      return { id: v.id, label: `${ds.name || v.dataset_id}`, sub: `${v.id}${v.label ? " · " + v.label : ""}`, kind: ds.kind, flag: ds.survivorship_free === false || (ds.adjusted === false && ds.kind !== "raw"),
        tip: [{ label: "content", value: short(v.content_hash, 16) }, { label: "rows", value: v.n_rows == null ? "file" : fmt.int(v.n_rows) }, { label: "as of", value: v.knowledge_time || "–" }, { label: "used by", value: `${v.used_by.length} experiments` }] };
    });
    const edges = idx.lineage.map((l) => ({ from: l.input_id, to: l.output_id, label: (M.tf[l.transform_id] || {}).name }));
    const dagBox = h("div");
    root.appendChild(card("Lineage", "raw snapshots on the left, derived data to the right; click a version", dagBox,
      h("p", { class: "small muted", style: "margin-top:6px", text: "Outlined in red: the survivorship-biased universe. Transforms: " + idx.transforms.map((t) => `${t.name} (${t.kind})`).join(", ") + "." })));
    requestAnimationFrame(() => QC.dag(dagBox, { nodes, edges, onClick: (id) => (location.hash = `#/data/${id}`) }));
    if (versionId && M.ver[versionId]) root.appendChild(versionCard(M.ver[versionId]));
    const dsRows = idx.datasets.map((d) => h("tr", null, td(d.name), td(d.kind, "small"), td(d.available_col ? `yes (${d.available_col})` : "–", "small"),
      td(d.survivorship_free == null ? "–" : d.survivorship_free ? "yes" : h("b", { text: "no", style: "color:var(--short)" })), td(d.adjusted == null ? "–" : d.adjusted ? "yes" : "no"),
      td(d.licensed ? "licensed" : "free", "small"), td(d.description || "", "small")));
    root.appendChild(card("Datasets", "flags drive the hygiene rules", table([{ label: "Dataset" }, { label: "Kind" }, { label: "Point in time" }, { label: "Survivor-free" }, { label: "Adjusted" }, { label: "Terms" }, { label: "Description" }], dsRows)));
    const vRows = idx.versions.map((v) => h("tr", { class: v.id === versionId ? "is-selected" : "" }, td(a(`#/data/${v.id}`, v.id, { class: "mono" })), td((M.ds[v.dataset_id] || {}).name || v.dataset_id, "small"), td(v.label || "", "small"),
      h("td", { class: "num", text: v.n_rows == null ? "file" : fmt.int(v.n_rows) }), td(v.time_start ? `${v.time_start} to ${v.time_end}` : "–", "small mono"), td(v.knowledge_time || "–", "small mono"),
      td(hashNode(v.content_hash, 12)), h("td", { class: "num", text: String(v.used_by.length) })));
    root.appendChild(card("Versions", "immutable once written", table([{ label: "Version" }, { label: "Dataset" }, { label: "Label" }, { label: "Rows", num: true }, { label: "Covers" }, { label: "Known as of" }, { label: "Content hash" }, { label: "Used by", num: true }], vRows)));
    if (idx.demo && idx.demo.bad_ticks_v1 && idx.demo.bad_ticks_v1.length) {
      root.appendChild(card("What changed between price versions v1 and v2", "vendor correction", h("p", { class: "small", text: `Version 1 carried ${idx.demo.bad_ticks_v1.length} bad prints, one-day prices multiplied by a wrong factor; version 2 corrects them. Experiments record which version they used, so results on v1 stay traceable after the fix.` }),
        table([{ label: "Ticker" }, { label: "Date" }, { label: "Wrong factor", num: true }], idx.demo.bad_ticks_v1.map((b) => h("tr", null, td(b.ticker, "mono"), td(b.date, "mono"), numCell(b.factor))))));
    }
    return root;
  }
  function versionCard(v) {
    const ds = M.ds[v.dataset_id] || {};
    const q = v.quality || {};
    const used = v.used_by.map((i) => expLink(i));
    const parents = state.index.lineage.filter((l) => l.output_id === v.id);
    return card(`${v.id}: ${ds.name}`, v.label || "",
      kv([["Content hash", hashNode(v.content_hash)], ["Fingerprint", v.fingerprint_version], ["Stored as", `${v.storage}${v.object_sha256 ? " · object " + short(v.object_sha256, 12) : ""}`],
        ["Shape", v.n_rows == null ? "raw file" : `${fmt.int(v.n_rows)} rows × ${v.n_cols} columns`], ["Covers", v.time_start ? `${v.time_start} to ${v.time_end}` : "–"], ["Known as of", v.knowledge_time || "–"],
        ["Derived from", parents.length ? h("span", null, ...parents.flatMap((p, i) => [i ? ", " : "", a(`#/data/${p.input_id}`, p.input_id, { class: "mono" }), ` via ${(M.tf[p.transform_id] || {}).name || "–"}`])) : "raw snapshot"],
        ["Quality", Object.keys(q).length ? Object.entries(q).filter(([k]) => typeof q[k] !== "object").map(([k, val]) => `${k.replace(/_/g, " ")} ${typeof val === "number" ? (Number.isInteger(val) ? fmt.int(val) : fmt.num(val, 4)) : val}`).join(" · ") : "–"],
        ["Used by", used.length ? h("span", null, ...used.flatMap((n, i) => [i ? ", " : "", n])) : "no experiment"], ["Notes", v.notes || "–"]]));
  }

  // ------------------------------------------------------------------ hygiene + holdout ledger
  function hygiene() {
    const idx = state.index;
    const root = h("div", { class: "stack" });
    root.appendChild(h("div", null, h("h1", { class: "page-title", text: "Research-hygiene warnings" }),
      h("p", { class: "lead", text: "Rules that flag practices which make backtests look better than they are. Each warning belongs to an experiment, a trial family, a hypothesis or a holdout, and is re-evaluated whenever the registry changes." })));
    for (const ho of idx.holdouts) {
      const rows = ho.accesses.map((acc, i) => {
        const e = M.exp[acc.experiment_id];
        const over = i + 1 > ho.max_touches;
        return h("tr", { class: over ? "is-selected" : "" }, h("td", { class: "num", text: `#${i + 1}` }), td(when(acc.accessed_at), "small mono"), td(acc.experiment_id ? expLink(acc.experiment_id) : "–"), td(e ? e.name : "", "small"), td(acc.purpose, "small"), td(e ? verdictBadge(e.verdict) : "–"), td(over ? sevBadge("critical") : gate("pass")));
      });
      root.appendChild(card(`Holdout ledger: ${ho.name}`, `${ho.start} to ${ho.end} · ${ho.accesses.length} looks, ${ho.max_touches} allowed`,
        h("p", { class: "small muted", text: (ho.description || "") + " The ledger is append-only; a strategy cannot even read holdout data until an experiment opens it, and every opening is recorded here." }),
        table([{ label: "Look", num: true }, { label: "When" }, { label: "Experiment" }, { label: "Name" }, { label: "Purpose" }, { label: "Verdict" }, { label: "Within limit" }], rows)));
    }
    const groups = {};
    idx.warnings.forEach((w) => (groups[w.code] = groups[w.code] || []).push(w));
    const order = { critical: 0, warning: 1, info: 2 };
    const codes = Object.keys(groups).sort((x, y) => order[idx.rules[x].severity] - order[idx.rules[y].severity] || groups[y].length - groups[x].length);
    for (const code of codes) {
      const rule = idx.rules[code];
      const rows = groups[code].map((w) => h("tr", null, td(sevBadge(w.severity)), td(w.experiment_id ? expLink(w.experiment_id) : w.hypothesis_id ? hypLink(w.hypothesis_id) : w.family ? famLink(w.family) : w.scope_key), td(w.message, "small")));
      const det = h("details", { class: "card" }, h("summary", null, h("b", { text: `${rule.title} ` }), h("span", { class: "small muted", text: `${code} · ${groups[code].length}` })),
        h("p", { class: "small muted", style: "margin:8px 0", text: rule.why }), table([{ label: "Severity" }, { label: "Scope" }, { label: "Message" }], rows));
      det.addEventListener("toggle", postHeight);
      root.appendChild(det);
    }
    const unused = Object.keys(idx.rules).filter((c) => !groups[c]);
    if (unused.length) root.appendChild(h("p", { class: "small muted", text: "Rules with no active warning: " + unused.map((c) => idx.rules[c].title).join("; ") + "." }));
    return root;
  }

  // ------------------------------------------------------------------ reproduce in the browser
  function reproduceView() {
    const idx = state.index;
    const root = h("div", { class: "stack" });
    root.appendChild(h("div", null, h("h1", { class: "page-title", text: "Reproduce an experiment in your browser" }),
      h("p", { class: "lead" }, "These toy experiments were run by the Python package and recorded with SHA-256 hashes of their input data and their return series. Your browser re-runs them from the recorded seed and parameters with a JavaScript port of the same generator and strategy, which uses only operations IEEE-754 defines exactly, so the bytes and therefore the hashes must match. Locally: ", h("code", { text: "qros toy --seed 7 --lookback 20" }), ".")));
    if (!idx.toy || !idx.toy.length) { root.appendChild(h("p", { class: "callout", text: "This registry has no browser-reproducible experiments." })); return root; }
    const result = h("div", { class: "stack" });
    const rows = idx.toy.map((t) => {
      const btn = h("button", { class: "btn btn--accent btn--sm", type: "button", text: "Reproduce" });
      btn.addEventListener("click", () => runToy(t, result, btn));
      return h("tr", null, td(expLink(t.id)), td(t.name), h("td", { class: "num", text: String(t.seed) }), h("td", { class: "num", text: String(t.lookback) }), h("td", { class: "num", text: String(t.cost_bps) }), td(hashNode(t.returns_sha256, 16)), td(btn));
    });
    root.appendChild(card("Recorded runs", "from the registry", table([{ label: "ID" }, { label: "Experiment" }, { label: "Seed", num: true }, { label: "Window", num: true }, { label: "Cost (bp)", num: true }, { label: "Recorded returns hash" }, { label: "" }], rows)));
    root.appendChild(result);
    root.appendChild(trialsLesson(idx.toy[0]));
    return root;
  }
  async function runToy(t, out, btn) {
    btn.disabled = true;
    const t0 = performance.now();
    const res = await QToy.run(t.seed, t.lookback, t.cost_bps, t.n);
    const ms = performance.now() - t0;
    btn.disabled = false;
    const okData = res.data_sha256 === t.data_sha256, okRet = res.returns_sha256 === t.returns_sha256;
    const check = (ok) => h("span", { class: ok ? "match-yes" : "match-no" }, icon(ok ? "check" : "x", 13), ok ? " match" : " differs");
    let eq = 1;
    const equity = res.net.map((v) => (eq = eq * (1 + v)) - 1);
    const card1 = card(`Re-ran ${t.id} in ${ms.toFixed(0)} ms`, okData && okRet ? "identical to the recorded run" : "does not match the recorded run",
      h("div", { class: "hashcheck" },
        h("span", { class: "muted", text: "Data, recorded" }), hashNode(t.data_sha256), h("span", { class: "muted", text: "Data, your browser" }), h("span", null, hashNode(res.data_sha256), " ", check(okData)),
        h("span", { class: "muted", text: "Returns, recorded" }), hashNode(t.returns_sha256), h("span", { class: "muted", text: "Returns, your browser" }), h("span", null, hashNode(res.returns_sha256), " ", check(okRet))),
      h("div", { class: "grid grid--3", style: "margin-top:12px" }, tile("Sharpe ratio", fmt.num(res.stats.sharpe), `recorded ${fmt.num(t.stats.sharpe)}`), tile("Final equity", fmt.num(res.stats.final_equity, 4), `recorded ${fmt.num(t.stats.final_equity, 4)}`), tile("Max drawdown", fmt.pctPlain(res.stats.max_drawdown, 1), `recorded ${fmt.pctPlain(t.stats.max_drawdown, 1)}`)),
      chartBox((el) => QC.line(el, { series: [{ label: "Strategy (recomputed)", color: "var(--series-1)", d: res.dates, v: equity }], yFormat: (v) => fmt.pct(v, 0), includeZero: true, height: 220 })));
    out.replaceChildren(card1);
    postHeight();
  }
  function trialsLesson(base) {
    const trials = [];
    const n = base.n;
    const dates = QToy.businessDays(n);
    const isEnd = dates.findIndex((d) => d > "2017-12-31");
    const slider = h("input", { type: "range", min: 2, max: 120, value: 15, class: "range", "aria-label": "Lookback window in days" });
    const val = h("b", { text: "15" });
    const costIn = h("select", { "aria-label": "Trading cost" }, ...[0, 2, 5, 10].map((c) => h("option", { value: c, text: `${c} bp` })));
    costIn.value = String(base.cost_bps);
    const runBtn = h("button", { class: "btn btn--accent btn--sm", type: "button", text: "Run this trial" });
    const out = h("div");
    slider.addEventListener("input", () => (val.textContent = slider.value));
    runBtn.addEventListener("click", async () => {
      const L = Number(slider.value), c = Number(costIn.value);
      if (trials.find((x) => x.L === L && x.c === c)) { draw(`Already tried window ${L} at ${c} bp: a repeat is not a new trial.`); return; }
      const ret = QToy.generateReturns(base.seed, n);
      const res = QToy.runStrategy(ret, L, c);
      const isR = res.net.slice(1, isEnd), oosR = res.net.slice(isEnd);
      const mi = QToy.moments(isR), mo = QToy.moments(oosR);
      trials.push({ L, c, is: mi.mean / mi.sd, isA: mi.mean / mi.sd * Math.sqrt(252), oosA: mo.mean / mo.sd * Math.sqrt(252), m: mi });
      draw();
    });
    function draw(msg) {
      out.replaceChildren();
      if (msg) out.appendChild(h("p", { class: "small muted", text: msg }));
      if (!trials.length) return;
      const best = trials.slice().sort((x, y) => y.isA - x.isA)[0];
      const srs = trials.map((x) => x.is);
      const mean = srs.reduce((p, q) => p + q, 0) / srs.length;
      const variance = srs.length > 1 ? srs.reduce((p, q) => p + (q - mean) * (q - mean), 0) / (srs.length - 1) : 0;
      const sr0 = QToy.expectedMax(trials.length, variance);
      const psr = QToy.psr(best.is, best.m.n, best.m.skew, best.m.kurt, 0);
      const dsr = QToy.psr(best.is, best.m.n, best.m.skew, best.m.kurt, sr0);
      out.appendChild(h("div", { class: "grid grid--tiles" }, tile("Your trials", String(trials.length), "distinct windows and costs"), tile("Best in-sample Sharpe", fmt.num(best.isA), `window ${best.L}, ${best.c} bp`),
        tile("Noise hurdle", fmt.num(sr0 * Math.sqrt(252)), `expected best of ${trials.length} noise trials`), tile("P(Sharpe > 0), alone", fmt.num(psr, 3), "ignores the search"),
        tile("Deflated Sharpe", fmt.num(dsr, 3), dsr >= 0.95 ? "still significant" : "not significant after the search"), tile("Its out-of-sample Sharpe", fmt.num(best.oosA), "2018 to 2019")));
      out.appendChild(h("div", { class: "meter", style: "margin-top:12px", title: "Deflated Sharpe ratio" }, h("i", { style: `width:${(dsr * 100).toFixed(1)}%` })));
      out.appendChild(h("p", { class: "small muted", style: "margin-top:6px", text: "In-sample = 2015 to 2017 of the same synthetic series. The hurdle uses the variance of your trials' Sharpe ratios and their number (Bailey and López de Prado's deflated Sharpe ratio); try many windows and watch the best one stop being significant." }));
      out.appendChild(table([{ label: "Window", num: true }, { label: "Cost", num: true }, { label: "IS Sharpe", num: true }, { label: "OOS Sharpe", num: true }], trials.map((x) => h("tr", { class: x === best ? "is-selected" : "" }, h("td", { class: "num", text: String(x.L) }), h("td", { class: "num", text: `${x.c} bp` }), numCell(x.isA), numCell(x.oosA)))));
      postHeight();
    }
    return card("Try your own trials", "every configuration you test is a trial, and the trials add up",
      h("div", { class: "row" }, h("label", { class: "small" }, "Window: ", val, " days"), h("div", { style: "flex:1;min-width:160px" }, slider), costIn, runBtn), out);
  }

  // ------------------------------------------------------------------ audit log
  function auditView() {
    const idx = state.index;
    const root = h("div", { class: "stack" });
    root.appendChild(h("div", null, h("h1", { class: "page-title", text: "Audit log" }),
      h("p", { class: "lead", text: "Every write to the registry appends an event whose hash covers the previous event's hash. Editing, inserting or deleting any event breaks every hash after it. Verify the chain here, then try tampering with one event." })));
    const status = h("div", { class: "callout" }, `The export says: ${idx.audit.events} events, head ${short(idx.audit.head, 24)}.`);
    const verifyBtn = h("button", { class: "btn btn--accent", type: "button", text: "Verify the chain in your browser" });
    const tamperBtn = h("button", { class: "btn", type: "button", text: "Tamper with one event, then verify" });
    const out = h("div", { class: "stack" });
    async function load() { if (!state.audit) state.audit = await getJSON("data/audit.json"); return state.audit; }
    verifyBtn.addEventListener("click", async () => {
      verifyBtn.disabled = true;
      const events = await load();
      const t0 = performance.now();
      const res = await QToy.verifyChain(events, (k) => (status.textContent = `Checked ${k} of ${events.length}…`));
      verifyBtn.disabled = false;
      status.className = "callout " + (res.ok ? "callout--good" : "callout--bad");
      status.textContent = res.ok ? `Verified all ${res.checked} events in ${(performance.now() - t0).toFixed(0)} ms. Head ${short(res.head, 24)} matches.` : `Broken at event ${res.firstBad}.`;
    });
    tamperBtn.addEventListener("click", async () => {
      tamperBtn.disabled = true;
      const events = await load();
      const target = events.find((e) => e.action === "hypothesis.amended") || events.find((e) => e.action === "experiment.completed") || events[Math.floor(events.length / 2)];
      const copy = events.map((e) => ({ ...e }));
      const k = copy.findIndex((e) => e.seq === target.seq);
      const before = copy[k].payload_json;
      copy[k].payload_json = before.replace(/"reason":"[^"]*"/, '"reason":"(edited later to look better)"');
      if (copy[k].payload_json === before) copy[k].payload_json = before.replace(/:"/, ':"x');
      const res = await QToy.verifyChain(copy);
      tamperBtn.disabled = false;
      out.replaceChildren(card("Tamper test", "on an in-memory copy; nothing is changed on the server",
        h("p", { class: "small" }, `Changed the payload of event ${target.seq} (${target.action}). Recomputing the chain: `, h("b", { class: res.ok ? "match-yes" : "match-no", text: res.ok ? "still verifies (unexpected)" : `breaks at event ${res.firstBad}` }), "."),
        kv([["Stored hash", hashNode(res.stored || "")], ["Recomputed", hashNode(res.recomputed || "")]]),
        h("p", { class: "small muted", text: "A tamper-evident log, not a tamper-proof one: someone who rewrites every later event too gets a consistent chain with a different head. Publishing or committing the head hash (as this page does in its footer) pins it." })));
      postHeight();
    });
    root.appendChild(h("div", { class: "row" }, verifyBtn, tamperBtn));
    root.appendChild(status);
    root.appendChild(out);
    const rows = idx.audit.recent.slice().reverse().map((e) => h("tr", null, h("td", { class: "num mono small", text: String(e.seq) }), td(when(e.at), "small mono"), td(e.action, "small"), td(e.id || "", "mono small"), td(hashNode(e.hash))));
    root.appendChild(card("Most recent events", `last ${rows.length} of ${idx.audit.events}`, table([{ label: "Seq", num: true }, { label: "At" }, { label: "Action" }, { label: "Entity" }, { label: "Hash" }], rows)));
    return root;
  }

  // ------------------------------------------------------------------ boot
  let resizeTimer = null;
  window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(redrawCharts, 180); });
  window.addEventListener("hashchange", route);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", redrawCharts);
  async function boot() {
    try {
      await loadIndex();
    } catch (err) {
      document.getElementById("app").replaceChildren(h("div", { class: "callout callout--bad" }, h("b", { text: "Could not load data/index.json. " }), String(err.message || err)));
      return;
    }
    shell();
    if (state.embed) {
      syncParentTheme();
      if ("ResizeObserver" in window) new ResizeObserver(postHeight).observe(document.body);
    }
    await route();
  }
  boot();
})();
