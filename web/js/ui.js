// The control panel. Builds the DOM once; `live()` updates the numbers a few times a second.

import { CURVES, INPUTS, OUTPUTS, MODE_NAMES, defaultOutputs, defaultRoutes, route } from "./matrix.js";
import { LAYERS, ROOTS } from "./engine.js";
import { shareUrl } from "./settings.js";

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) el.append(c);
  return el;
}
const opt = (value, label, sel) => h("option", { value, selected: value === sel }, label);
const fmt = (v, digits, unit = "") => (v == null || Number.isNaN(v) ? "—" : `${v.toFixed(digits)}${unit ? " " + unit : ""}`);
const bar = () => h("div", { class: "bar" }, h("i"));
const setBar = (el, f) => { el.firstChild.style.width = `${Math.max(0, Math.min(1, f ?? 0)) * 100}%`; };

export class Panel {
  constructor(root, S, onChange, actions) {
    this.root = root;
    this.S = S;
    this.changed = () => onChange(S);
    this.actions = actions;
    this.refs = { inputs: {}, outputs: {}, routes: {} };
    this.build();
  }

  build() {
    this.root.replaceChildren(
      this.liveView(),
      this.section("Routing: which data drives which sound", this.routingView(), true),
      this.section("Sound parameters", this.outputsView()),
      this.section("Music", this.musicView()),
      this.section("Mixer", this.mixerView()),
      this.section("Time and events", this.timeView(), true),
    );
  }

  rebuild() { this.refs = { inputs: {}, outputs: {}, routes: {} }; this.build(); this.changed(); }

  section(title, body, open = false) {
    return h("details", { class: "panel", open }, h("summary", {}, title), body);
  }

  // ---- live view: data in, sound out
  liveView() {
    const ins = Object.entries(INPUTS).map(([k, d]) => {
      const val = h("span", { class: "num" }), b = bar();
      this.refs.inputs[k] = { val, b, d };
      return h("div", { class: "meter" }, h("label", {}, d.label), val, b);
    });
    const outs = Object.entries(OUTPUTS).map(([k, d]) => {
      const val = h("span", { class: "num" }), b = bar();
      this.refs.outputs[k] = { val, b, d };
      return h("div", { class: "meter" }, h("label", {}, d.label), val, b);
    });
    this.refs.kind = h("span", { class: "pill" });
    this.refs.chord = h("span", { class: "muted" });
    return h("div", { class: "live" },
      h("div", {}, h("h3", {}, "Data in ", this.refs.kind), ...ins),
      h("div", { class: "arrow", "aria-hidden": "true" }, "→"),
      h("div", {}, h("h3", {}, "Sound out ", this.refs.chord), ...outs));
  }

  // ---- routing matrix (one row per route)
  routingView() {
    const S = this.S;
    const rows = S.routes.map((r) => {
      const boxes = {};
      const num = (key, step) => (boxes[key] = h("input", {
        type: "number", step, value: r[key], disabled: r.auto, class: "small",
        oninput: (e) => { r[key] = parseFloat(e.target.value); this.changed(); },
      }));
      const amtLabel = h("span", { class: "num" }, `${r.amount}%`);
      const live = h("span", { class: "num live-route" }), xb = bar(), cb = h("div", { class: "bar bipolar" }, h("i"));
      this.refs.routes[r.id] = { live, xb, cb, r, boxes };
      return h("tr", { class: r.on ? "" : "off" },
        h("td", {}, h("input", { type: "checkbox", checked: r.on, title: "on/off", onchange: (e) => { r.on = e.target.checked; this.rebuild(); } })),
        h("td", {}, h("select", { onchange: (e) => { r.input = e.target.value; this.rebuild(); } },
          Object.entries(INPUTS).map(([k, d]) => opt(k, d.label, r.input)))),
        h("td", { class: "arrowcell" }, "→"),
        h("td", {}, h("select", { onchange: (e) => { r.output = e.target.value; this.changed(); } },
          Object.entries(OUTPUTS).map(([k, d]) => opt(k, d.label, r.output)))),
        h("td", { class: "amount" }, h("input", {
          type: "range", min: -100, max: 100, step: 5, value: r.amount, title: "amount (negative inverts)",
          oninput: (e) => { r.amount = +e.target.value; amtLabel.textContent = `${r.amount}%`; this.changed(); },
        }), amtLabel),
        h("td", {}, h("select", { onchange: (e) => { r.curve = e.target.value; this.changed(); } },
          Object.keys(CURVES).map((c) => opt(c, c, r.curve)))),
        h("td", { class: "range" },
          h("label", { title: "use this station's historical range" },
            h("input", { type: "checkbox", checked: r.auto, onchange: (e) => {
              r.auto = e.target.checked;
              if (!r.auto) { const [lo, hi] = INPUTS[r.input].auto(this.D); r.inMin = lo; r.inMax = hi; }
              this.rebuild();
            } }), "auto"),
          num("inMin", 0.1), num("inMax", 0.1)),
        h("td", {}, h("input", { type: "number", min: 0, max: 60, step: 0.5, value: r.smooth, class: "small", title: "smoothing (s)",
          oninput: (e) => { r.smooth = parseFloat(e.target.value) || 0; this.changed(); } }), " s"),
        h("td", { class: "liveval" }, live, xb, cb),
        h("td", {}, h("button", { class: "icon", title: "remove route", onclick: () => { S.routes.splice(S.routes.indexOf(r), 1); this.rebuild(); } }, "✕")));
    });
    const share = h("button", { onclick: async () => {
      const url = shareUrl(S);
      history.replaceState(null, "", url);
      try { await navigator.clipboard.writeText(url); share.textContent = "Link copied"; } catch { share.textContent = "Link in address bar"; }
      setTimeout(() => (share.textContent = "Copy share link"), 2000);
    } }, "Copy share link");
    return h("div", {},
      h("p", { class: "help" }, "Each route maps a data input (scaled to 0–1 over its input range, then shaped by the curve) onto a sound parameter. ",
        "Amounts add up; negative amounts invert. Curve ", h("b", {}, "V"), " means “distance from the middle”: how unusual a value is in either direction."),
      h("div", { class: "scroll" }, h("table", { class: "routes" },
        h("thead", {}, h("tr", {}, ["", "Input", "", "Sound parameter", "Amount", "Curve", "Input range", "Smooth", "Live: in → amount", ""].map((t) => h("th", {}, t)))),
        h("tbody", {}, rows))),
      h("div", { class: "buttons" },
        h("button", { onclick: () => { S.routes.push(route("level", "tempo", 50)); this.rebuild(); } }, "+ Add route"),
        h("button", { onclick: () => { S.routes = defaultRoutes(); S.outputs = defaultOutputs(); this.rebuild(); } }, "Reset to defaults"),
        share));
  }

  // ---- sound parameters: base value and output range
  outputsView() {
    const S = this.S;
    const rows = Object.entries(OUTPUTS).map(([k, d]) => {
      const o = S.outputs[k];
      const baseLabel = h("span", { class: "num" }, `${Math.round(o.base * 100)}%`);
      const n = (key) => h("input", { type: "number", class: "small", value: o[key], step: d.max - d.min > 50 ? 10 : 0.05,
        oninput: (e) => { o[key] = parseFloat(e.target.value); this.changed(); } });
      return h("tr", {},
        h("td", {}, d.label),
        h("td", {}, h("input", { type: "range", min: 0, max: 1, step: 0.01, value: o.base,
          oninput: (e) => { o.base = +e.target.value; baseLabel.textContent = `${Math.round(o.base * 100)}%`; this.changed(); } }), baseLabel),
        h("td", {}, n("min"), " – ", n("max"), " ", h("span", { class: "muted" }, d.unit)));
    });
    return h("div", {},
      h("p", { class: "help" }, "Base = where a parameter sits before any route moves it. The output range is what 0% and 100% mean."),
      h("table", { class: "outs" }, h("thead", {}, h("tr", {}, ["Parameter", "Base", "Output range"].map((t) => h("th", {}, t)))), h("tbody", {}, rows)));
  }

  musicView() {
    const m = this.S.music;
    const set = (k, cast = (v) => v) => (e) => { m[k] = cast(e.target.value); this.changed(); };
    const bpmLabel = h("span", { class: "num" }, `${m.bpm} BPM`);
    return h("div", { class: "grid2" },
      h("label", {}, "Root note", h("select", { onchange: set("root") }, ROOTS.map((r) => opt(r, r, m.root)))),
      h("label", {}, "Scale / mode", h("select", { onchange: set("scale") }, opt("auto", "auto (from the “mode” parameter)", m.scale), MODE_NAMES.map((n) => opt(n, n, m.scale)))),
      h("label", {}, "Tempo", h("select", { onchange: set("tempoMode") }, opt("auto", "auto (from the “tempo” parameter)", m.tempoMode), opt("fixed", "fixed", m.tempoMode))),
      h("label", {}, "Fixed tempo", h("input", { type: "range", min: 40, max: 120, value: m.bpm,
        oninput: (e) => { m.bpm = +e.target.value; bpmLabel.textContent = `${m.bpm} BPM`; this.changed(); } }), bpmLabel),
      h("label", {}, "Arpeggio octaves", h("select", { onchange: set("octaves", Number) }, [1, 2, 3].map((n) => opt(n, String(n), m.octaves)))),
      h("label", {}, "Arpeggio starts at octave", h("select", { onchange: set("baseOct", Number) }, [3, 4, 5].map((n) => opt(n, String(n), m.baseOct)))));
  }

  mixerView() {
    const mx = this.S.mixer;
    const strips = LAYERS.map((l) => {
      const s = mx[l];
      const lab = h("span", { class: "num" }, `${s.db} dB`);
      const tog = (key, text) => h("button", { class: `toggle ${s[key] ? "on" : ""}`, "aria-pressed": String(s[key]),
        onclick: (e) => { s[key] = !s[key]; e.target.classList.toggle("on", s[key]); e.target.setAttribute("aria-pressed", String(s[key])); this.changed(); } }, text);
      return h("div", { class: "strip" }, h("b", {}, l),
        h("input", { type: "range", min: -40, max: 6, value: s.db, oninput: (e) => { s.db = +e.target.value; lab.textContent = `${s.db} dB`; this.changed(); } }),
        lab, h("div", {}, tog("mute", "M"), tog("solo", "S")));
    });
    const ml = h("span", { class: "num" }, `${mx.master} dB`);
    return h("div", {}, h("div", { class: "strips" }, strips,
      h("div", { class: "strip" }, h("b", {}, "master"),
        h("input", { type: "range", min: -40, max: 0, value: mx.master, oninput: (e) => { mx.master = +e.target.value; ml.textContent = `${mx.master} dB`; this.changed(); } }), ml)));
  }

  timeView() {
    const t = this.S.time, ev = this.S.events;
    const check = (obj, key, text) => h("label", { class: "check" }, h("input", { type: "checkbox", checked: obj[key], onchange: (e) => { obj[key] = e.target.checked; this.changed(); } }), text);
    return h("div", { class: "grid2" },
      h("label", {}, "Playback", h("select", { onchange: (e) => { t.mode = e.target.value; this.changed(); this.actions.modeChanged(); } },
        opt("live", "Live: follow now", t.mode), opt("replay", "Replay the last 2 days + forecast", t.mode))),
      h("label", {}, "Replay speed", h("select", { onchange: (e) => { t.speed = +e.target.value; this.changed(); } },
        [2, 5, 10, 30].map((s) => opt(s, `1 hour of tide per ${s} s`, t.speed)))),
      h("div", {},
        check(ev, "turn", "Bells at each high and low tide"),
        check(ev, "gap", "Static when a reading failed QC"),
        check(ev, "ping", "Soft chime when new data arrives from the pipeline")),
      h("div", {},
        check(t, "stale", "Pretend the pipeline stopped (+90 min of data age)"),
        h("div", { class: "buttons" },
          h("button", { onclick: () => this.actions.test("high") }, "Test bell"),
          h("button", { onclick: () => this.actions.test("gap") }, "Test static"))),
      h("p", { class: "help" }, "In replay, click the chart to jump. Times are in your local time zone."));
  }

  // ---- per-tick updates
  live(inputs, kind, out, engine) {
    for (const [k, r] of Object.entries(this.refs.inputs)) {
      const v = inputs[k], [lo, hi] = r.d.auto(this.D);
      r.val.textContent = fmt(v, r.d.digits, r.d.unit);
      setBar(r.b, (v - lo) / (hi - lo));
    }
    this.refs.kind.textContent = { measured: "measured", nowcast: "nowcast", gap: "gap (failed QC)" }[kind];
    this.refs.kind.className = `pill ${kind}`;
    for (const [k, r] of Object.entries(this.refs.outputs)) {
      const v = out.params[k];
      r.val.textContent = r.d.show ? r.d.show(v) : fmt(v, r.d.digits, r.d.unit);
      setBar(r.b, out.norm[k]);
    }
    this.refs.chord.textContent = engine.started ? `${this.S.music.root} ${engine.modeName}` : "(press Play to hear it)";
    for (const [id, r] of Object.entries(this.refs.routes)) {
      const v = out.routes[id];
      if (!v) continue;
      const def = INPUTS[this.S.routes.find((x) => x.id === id)?.input];
      r.live.textContent = `${fmt(v.raw, def?.digits ?? 2)} → ${v.contrib >= 0 ? "+" : ""}${Math.round(v.contrib * 100)}%`;
      setBar(r.xb, v.x);
      if (r.r.auto && r.boxes.inMin) { r.boxes.inMin.value = v.lo; r.boxes.inMax.value = v.hi; } // show the auto range
      const c = r.cb.firstChild, f = Math.max(-1, Math.min(1, v.contrib));
      c.style.left = `${50 + Math.min(0, f) * 50}%`; c.style.width = `${Math.abs(f) * 50}%`;
    }
  }
}

// ---- pipeline status strip (from the run ledger inside latest.json)
const STATUS = { success: ["good", "✓", "new data"], no_new_data: ["neutral", "○", "no new data"], skipped: ["warning", "↷", "skipped (locked)"], failed: ["critical", "✕", "failed"] };

export function renderStatus(el, D, now, nextFetch) {
  const ago = (t) => { const m = Math.round((now - t) / 60000); return m < 1 ? "just now" : m < 120 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };
  const last = D.runs[0];
  const [cls, icon, text] = STATUS[last?.status] ?? ["neutral", "?", "unknown"];
  const age = D.lastObs ? (now - D.lastObs.t) / 60000 : Infinity;
  const fresh = age < 45 ? ["good", "✓", "fresh"] : age < 90 ? ["warning", "⚠", "late"] : ["critical", "✕", "stale"];
  const day = D.runs.filter((r) => now - r.started < 24 * 3600e3);
  const counts = {};
  for (const r of day) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const squares = D.runs.slice(0, 96).reverse().map((r) => {
    const [c, i, label] = STATUS[r.status] ?? ["neutral", "?", r.status];
    return h("i", { class: `sq ${c}`, title: `${new Date(r.started).toLocaleString()} · ${r.run_trigger} · ${label}${r.obs_inserted ? ` · +${r.obs_inserted} readings` : ""}${r.error ? ` · ${r.error}` : ""}` });
  });
  const next = nextFetch ? Math.max(0, Math.round((nextFetch - now) / 1000)) : null;
  el.replaceChildren(
    h("div", {}, h("span", { class: "k" }, "Last pipeline run"), h("span", { class: `pill ${cls}` }, `${icon} ${text}`), " ", last ? `${ago(last.started)} (${last.run_trigger})` : "—"),
    h("div", {}, h("span", { class: "k" }, "Newest reading"), h("span", { class: `pill ${fresh[0]}` }, `${fresh[1]} ${fresh[2]}`), " ", D.lastObs ? `${new Date(D.lastObs.t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} (${ago(D.lastObs.t)})` : "—"),
    h("div", {}, h("span", { class: "k" }, "Runs, last 24 h"), `${day.length} of 96 scheduled + reverify`, h("span", { class: "muted" }, ` · ${Object.entries(counts).map(([k, n]) => `${n} ${STATUS[k]?.[2] ?? k}`).join(", ")}`)),
    h("div", { class: "squares", "aria-label": "recent runs, oldest to newest" }, squares),
    h("div", { class: "muted" }, next != null ? `Checking for new data in ${Math.floor(next / 60)}:${String(next % 60).padStart(2, "0")}` : ""));
}

// ---- data table (accessible alternative to the chart)
export function renderTable(el, D) {
  const rows = D.series.filter((s) => s.status !== "predicted_only").slice(-20).reverse();
  const f = (v) => (v == null ? "—" : v.toFixed(3));
  el.replaceChildren(h("table", { class: "data" },
    h("thead", {}, h("tr", {}, ["Time", "Observed (m)", "Predicted (m)", "Residual (m)", "Sigma", "Quality", "Status"].map((t) => h("th", {}, t)))),
    h("tbody", {}, rows.map((s) => h("tr", {},
      h("td", {}, new Date(s.t).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })),
      h("td", {}, f(s.obs)), h("td", {}, f(s.pred)), h("td", {}, f(s.resid)), h("td", {}, f(s.sigma)), h("td", {}, s.q ?? "—"), h("td", {}, s.status))))));
}
