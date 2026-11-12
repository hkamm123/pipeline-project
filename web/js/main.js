// Wires it together: load data -> every 200 ms compute inputs at the playhead, run the
// matrix, set the sound, update the panel; redraw the chart every animation frame.

import { inputsAt, loadLatest, sample, turnsBetween } from "./data.js";
import { Router } from "./matrix.js";
import { Engine } from "./engine.js";
import { Chart } from "./chart.js";
import { Panel, renderStatus, renderTable } from "./ui.js";
import * as settings from "./settings.js";

const $ = (id) => document.getElementById(id);
const S = settings.load();
const engine = new Engine();
const router = new Router();
let D = null, playT = Date.now(), prevT = playT, prevKind = null, lastTick = performance.now(), out = null, nextFetch = null;

const panel = new Panel($("controls"), S, (s) => { settings.save(s); engine.mix(s.mixer); }, {
  modeChanged: () => { playT = S.time.mode === "live" ? Date.now() : D.t0; prevT = playT; },
  test: (what) => (what === "gap" ? engine.gap() : engine.bell(what)),
});
const chart = new Chart($("chart"), $("tooltip"), (t) => { if (S.time.mode === "replay") { playT = t; prevT = t; } });

// ---- fetching: latest.json changes only when the pipeline runs (minutes 4, 19, 34, 49
// UTC), so ask shortly after each run instead of polling constantly.
function nextRunAfter(ms) {
  const d = new Date(ms);
  d.setUTCSeconds(0, 0);
  do d.setUTCMinutes(d.getUTCMinutes() + 1); while (d.getUTCMinutes() % 15 !== 4);
  return d.getTime() + 50_000; // a run takes ~15-30 s
}

async function refresh(retries = 0) {
  try {
    const fresh = await loadLatest();
    const isNew = D && fresh.generatedAt !== D.generatedAt;
    const gotRows = D && fresh.lastObs?.t !== D.lastObs?.t;
    if (!D || isNew) {
      D = fresh;
      panel.D = D;
      renderTable($("table"), D);
      $("error").hidden = true;
      if (gotRows && S.events.ping) engine.ping();
    }
    nextFetch = !isNew && D && retries < 3 && Date.now() - D.generatedAt > 14 * 60e3 ? Date.now() + 60_000 : nextRunAfter(Date.now());
    setTimeout(() => refresh(isNew ? 0 : retries + 1), nextFetch - Date.now());
  } catch (e) {
    $("error").hidden = false;
    $("error").textContent = `Could not load the pipeline's output (${e.message}). Retrying in a minute.`;
    nextFetch = Date.now() + 60_000;
    setTimeout(() => refresh(retries), 60_000);
  }
}

// ---- the control loop
function tick() {
  if (!D) return;
  const now = Date.now(), t = performance.now(), dt = Math.min(1, (t - lastTick) / 1000);
  lastTick = t;
  if (S.time.mode === "live") playT = now;
  else {
    playT += dt * (3600e3 / S.time.speed);
    if (playT > D.t1) { playT = D.t0; prevT = playT; }
  }
  const { values, sample: s } = inputsAt(D, playT, now, S.time.mode === "live", S.time.stale ? 90 : 0);
  out = router.compute(S, values, D, dt);
  engine.apply(out.params, S.music);

  if (S.events.turn) for (const tr of turnsBetween(D, prevT, playT)) engine.bell(tr.type);
  if (S.events.gap && s.kind === "gap" && prevKind !== "gap") engine.gap();
  prevKind = s.kind;
  prevT = playT;

  panel.live(values, s.kind, out, engine);
  renderStatus($("status"), D, now, nextFetch);
  $("clock").textContent = `${S.time.mode === "live" ? "Live" : "Replay"} · ${new Date(playT).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })} · level ${s.level >= 0 ? "+" : ""}${s.level.toFixed(2)} m`;
}

function frame() {
  if (D) chart.draw(D, playT, Date.now());
  requestAnimationFrame(frame);
}

$("play").addEventListener("click", async () => {
  const b = $("play");
  if (!engine.started) {
    b.disabled = true;
    b.textContent = "Starting…";
    await engine.start();
    engine.mix(S.mixer);
    if (out) engine.apply(out.params, S.music);
    b.disabled = false;
  } else if (engine.paused) engine.resume();
  else engine.pause();
  b.textContent = engine.paused ? "▶ Play" : "❚❚ Pause";
  b.classList.toggle("playing", !engine.paused);
});

// Debug/demo hook: ?autoplay starts audio without a click (needs a browser flag in headless tests).
if (new URLSearchParams(location.search).has("autoplay")) setTimeout(() => $("play").click(), 500);

await refresh();
setInterval(tick, 200);
tick();
requestAnimationFrame(frame);
window.__tides = { S, engine, get D() { return D; }, get out() { return out; }, sample };
