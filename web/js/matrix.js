// The modulation matrix: data inputs -> sound parameters, like a synthesizer's mod matrix.
//
// For each route:  x = clamp((input - inMin) / (inMax - inMin))   // 0..1
//                  x = slew(x, smoothing)                          // glide between readings
//                  y = curve(x)                                    // linear, exp, log, steps, V
//                  param += amount * y                              // amount is -1..+1
// Each parameter starts at its base value, routes are summed, the result is clamped to
// 0..1 and then scaled to the parameter's real range (Hz, dB, BPM...).

export const INPUTS = {
  level:        { label: "Water level",        unit: "m",   digits: 2, auto: (D) => q(D, "level_q", 2, 98, [-5, 5]) },
  rate:         { label: "Rate of change",     unit: "m/h", digits: 2, auto: () => [-2.5, 2.5] },
  residual:     { label: "Residual (obs − pred)", unit: "m", digits: 2, auto: (D) => q(D, "residual_q", 5, 95, [-0.4, 0.4]) },
  residual_pct: { label: "Residual percentile", unit: "%",  digits: 0, auto: () => [0, 100] },
  range_today:  { label: "Tidal range today",  unit: "m",   digits: 2, auto: () => [5, 10] },
  sigma:        { label: "Choppiness (sigma)", unit: "m",   digits: 3, auto: () => [0, 0.08] },
  staleness:    { label: "Data age",           unit: "min", digits: 0, auto: () => [45, 120] },
};

function q(D, key, lo, hi, fallback) {
  const a = D?.normals?.[key];
  return a ? [round(a[lo]), round(a[hi])] : fallback;
}
const round = (v) => Math.round(v * 100) / 100;

const MODE_NAMES = ["Lydian", "Ionian", "Mixolydian", "Dorian", "Aeolian", "Phrygian"];
export const modeIndex = (v) => Math.min(5, Math.floor(v * 6));

export const OUTPUTS = {
  cutoff:        { label: "Pad filter cutoff", min: 150, max: 6000, scale: "exp", unit: "Hz", digits: 0, base: 0.1 },
  pad_level:     { label: "Pad swell",         min: -22, max: -5,   unit: "dB", digits: 1, base: 0.3 },
  arp_density:   { label: "Arpeggio density",  min: 0,   max: 0.9,  unit: "notes/16th", digits: 2, base: 0.05 },
  arp_direction: { label: "Arpeggio direction", min: -1, max: 1,    unit: "↓ … ↑", digits: 2, base: 0 },
  tension:       { label: "Tension (detune, noise, clusters)", min: 0, max: 1, unit: "", digits: 2, base: 0.05 },
  mode:          { label: "Mode (bright → dark)", min: 0, max: 1,   unit: "", digits: 2, base: 0, show: (v) => MODE_NAMES[modeIndex(v)] },
  reverb:        { label: "Reverb mix",        min: 0.1, max: 0.85, unit: "wet", digits: 2, base: 0.2 },
  dynamics:      { label: "Overall dynamics",  min: -14, max: 0,    unit: "dB", digits: 1, base: 0.3 },
  shimmer:       { label: "Shimmer",           min: 0,   max: 0.6,  unit: "notes/16th", digits: 2, base: 0.02 },
  tempo:         { label: "Tempo",             min: 40,  max: 96,   unit: "BPM", digits: 0, base: 0.3 },
  activity:      { label: "Activity (all but the drone)", min: 0, max: 1, unit: "", digits: 2, base: 1 },
};
export { MODE_NAMES };

export const CURVES = {
  linear: (x) => x,
  exp: (x) => (Math.exp(3 * x) - 1) / (Math.exp(3) - 1), // slow start, fast finish
  log: (x) => Math.log(1 + (Math.exp(3) - 1) * x) / 3,    // fast start, slow finish
  steps: (x) => Math.round(x * 4) / 4,                     // 5 levels
  V: (x) => Math.abs(2 * x - 1),                           // distance from the middle: "how unusual"
};

let nextId = 1;
export const route = (input, output, amount, extra = {}) => ({
  id: `r${nextId++}`, on: true, input, output, amount, curve: "linear", auto: true,
  inMin: 0, inMax: 1, smooth: 2, ...extra,
});

// The defaults from docs/sound-design.md.
export function defaultRoutes() {
  return [
    route("level", "cutoff", 85),
    route("level", "pad_level", 60),
    route("rate", "arp_direction", 100),
    route("rate", "arp_density", 70, { curve: "V" }),           // fast flood or ebb = more notes
    route("residual", "tension", 80, { curve: "V" }),           // either direction off-script = tension
    route("residual_pct", "mode", 100, { curve: "V" }),         // typical = bright, extreme = dark
    route("range_today", "reverb", 60),
    route("range_today", "dynamics", 55),
    route("sigma", "shimmer", 100, { curve: "log" }),
    route("staleness", "activity", -100, { smooth: 5 }),        // you can hear the pipeline die
  ];
}

export function defaultOutputs() {
  return Object.fromEntries(Object.entries(OUTPUTS).map(([k, o]) => [k, { base: o.base, min: o.min, max: o.max }]));
}

export function ensureIds(routes) {
  for (const r of routes) {
    if (!r.id) r.id = `r${nextId++}`;
    const n = parseInt(r.id.slice(1), 10);
    if (n >= nextId) nextId = n + 1;
  }
  return routes;
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));

export class Router {
  constructor() { this.slew = {}; }

  // inputs: {name: value}; returns real-unit params, their 0..1 positions, and per-route detail.
  compute(settings, inputs, D, dt) {
    const norm = {};
    for (const [k, o] of Object.entries(settings.outputs)) norm[k] = o.base;
    const routes = {};
    for (const r of settings.routes) {
      const raw = inputs[r.input];
      const [lo, hi] = r.auto ? INPUTS[r.input].auto(D) : [r.inMin, r.inMax];
      const target = raw == null || Number.isNaN(raw) ? null : clamp01((raw - lo) / (hi - lo || 1));
      let x = this.slew[r.id];
      if (target != null) {
        const k = r.smooth > 0 ? 1 - Math.exp(-dt / r.smooth) : 1;
        x = x == null ? target : x + (target - x) * k;
      }
      this.slew[r.id] = x;
      const y = (CURVES[r.curve] ?? CURVES.linear)(x ?? 0);
      const contrib = (r.amount / 100) * y;
      if (r.on && r.output in norm) norm[r.output] += contrib;
      routes[r.id] = { raw, lo, hi, x, y, contrib };
    }
    const params = {};
    for (const [k, o] of Object.entries(settings.outputs)) {
      norm[k] = clamp01(norm[k]);
      params[k] = OUTPUTS[k].scale === "exp"
        ? o.min * Math.pow(o.max / o.min, norm[k])
        : o.min + (o.max - o.min) * norm[k];
    }
    return { params, norm, routes };
  }
}
