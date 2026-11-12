// Loads latest.json (the pipeline's only output the page reads) and derives the
// musical inputs from it. Everything here is plain math on the 6-minute series.

export const DATA_URL = "https://storage.googleapis.com/cs452-tides-hk-public/latest.json";
export const STEP = 6 * 60 * 1000; // NOAA's 6-minute interval
const HALF_LUNAR_DAY = 12.42 * 3600 * 1000; // one high + one low tide

export async function loadLatest() {
  // no-cache = "revalidate with the server", so we see a new file as soon as the job writes it.
  const r = await fetch(DATA_URL, { cache: "no-cache" });
  if (!r.ok) throw new Error(`latest.json: HTTP ${r.status}`);
  return prepare(await r.json());
}

export function prepare(doc) {
  const series = doc.series.map((s) => ({ ...s, t: Date.parse(s.t) }));
  let lastObs = null;
  for (const s of series) if (s.obs != null) lastObs = s;
  return {
    doc,
    series,
    t0: series[0].t,
    t1: series.at(-1).t,
    lastObs,
    turns: findTurns(series),
    normals: doc.normals,
    runs: doc.pipeline.runs.map((r) => ({ ...r, started: Date.parse(r.started_at) })),
    generatedAt: Date.parse(doc.generated_at),
  };
}

// High and low tides = local maxima/minima of the predicted curve.
function findTurns(series) {
  const out = [];
  for (let i = 1; i < series.length - 1; i++) {
    const a = series[i - 1].pred, b = series[i].pred, c = series[i + 1].pred;
    if (a == null || b == null || c == null) continue;
    if (b > a && b >= c) out.push({ t: series[i].t, type: "high", v: b });
    else if (b < a && b <= c) out.push({ t: series[i].t, type: "low", v: b });
  }
  return out;
}

// Index of the last row with t <= T (binary search; rows are sorted).
function indexAt(series, T) {
  let lo = 0, hi = series.length - 1;
  if (T <= series[0].t) return 0;
  if (T >= series[hi].t) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (series[mid].t <= T) lo = mid; else hi = mid;
  }
  return lo;
}

const lerp = (a, b, f) => a + (b - a) * f;

function predAt(D, T) {
  const s = D.series, i = indexAt(s, T), j = Math.min(i + 1, s.length - 1);
  const f = s[j].t === s[i].t ? 0 : Math.min(1, Math.max(0, (T - s[i].t) / (s[j].t - s[i].t)));
  return lerp(s[i].pred, s[j].pred, f);
}

function lastResidBefore(D, i) {
  for (let k = i; k >= 0 && k > i - 240; k--) if (D.series[k].resid != null) return D.series[k].resid;
  return 0;
}

// Water level at time T. Measured where we have readings; otherwise a nowcast:
// the prediction plus the most recent residual (the sea stays "off-script" by about
// the same amount for a while).
export function sample(D, T) {
  const s = D.series, i = indexAt(s, T), j = Math.min(i + 1, s.length - 1);
  const pred = predAt(D, T);
  if (D.lastObs && T <= D.lastObs.t) {
    const a = s[i], b = s[j];
    if (a.obs != null && b.obs != null) {
      const f = b.t === a.t ? 0 : (T - a.t) / (b.t - a.t);
      return { level: lerp(a.obs, b.obs, f), pred, resid: lerp(a.resid, b.resid, f), sigma: a.sigma, kind: "measured" };
    }
    const resid = lastResidBefore(D, i); // failed QC or missing: fill in, and flag it
    return { level: pred + resid, pred, resid, sigma: 0, kind: "gap" };
  }
  const resid = D.lastObs ? D.lastObs.resid : 0;
  return { level: pred + resid, pred, resid, sigma: D.lastObs?.sigma ?? 0, kind: "nowcast" };
}

// Where a value falls among this station's historical quantiles for the month (0-100).
export function percentileOf(q, v) {
  if (!q || v == null) return 50;
  if (v <= q[0]) return 0;
  if (v >= q[q.length - 1]) return 100;
  let i = 0;
  while (i < q.length - 2 && q[i + 1] <= v) i++;
  const f = q[i + 1] === q[i] ? 0 : (v - q[i]) / (q[i + 1] - q[i]);
  return ((i + f) / (q.length - 1)) * 100;
}

// All continuous data inputs at time T. `now` is the wall clock; `extraStale` (minutes)
// lets the demo pretend the pipeline stopped.
export function inputsAt(D, T, now, live, extraStale = 0) {
  const s = sample(D, T);
  const a = sample(D, T - STEP), b = sample(D, T + STEP);
  let hi = -Infinity, lo = Infinity;
  for (let k = indexAt(D.series, T - HALF_LUNAR_DAY); k < D.series.length && D.series[k].t <= T + HALF_LUNAR_DAY; k++) {
    const p = D.series[k].pred;
    if (p > hi) hi = p;
    if (p < lo) lo = p;
  }
  const newest = D.lastObs ? D.lastObs.t : D.t0;
  const ageMs = live ? now - newest : Math.max(0, T - newest);
  return {
    sample: s,
    values: {
      level: s.level,
      rate: (b.level - a.level) / ((2 * STEP) / 3600e3), // meters per hour
      residual: s.resid,
      residual_pct: percentileOf(D.normals?.residual_q, s.resid),
      range_today: hi - lo,
      sigma: s.sigma ?? 0,
      staleness: ageMs / 60000 + extraStale,
    },
  };
}

// Tide turns crossed when the playhead moves from prevT to T.
export function turnsBetween(D, prevT, T) {
  if (!(T > prevT) || T - prevT > 6 * 3600e3) return []; // backwards or a big jump: no bells
  return D.turns.filter((x) => x.t > prevT && x.t <= T);
}
