// Settings: defaults, saved in localStorage, and shareable as a URL (#s=<base64 JSON>).

import { defaultOutputs, defaultRoutes, ensureIds } from "./matrix.js";
import { LAYERS } from "./engine.js";

const KEY = "tides-settings-v1";

export function defaults() {
  return {
    routes: defaultRoutes(),
    outputs: defaultOutputs(),
    music: { root: "D", scale: "auto", tempoMode: "auto", bpm: 56, octaves: 2, baseOct: 4 },
    mixer: {
      master: -2,
      ...Object.fromEntries(LAYERS.map((l) => [l, { db: l === "noise" ? -4 : 0, mute: false, solo: false }])),
    },
    events: { turn: true, gap: true, ping: true },
    time: { mode: "live", speed: 5, stale: false },
  };
}

// Fill in anything missing (e.g. an old saved copy from before a new option existed).
function merge(base, saved) {
  if (Array.isArray(base) || typeof base !== "object" || base === null) return saved ?? base;
  const out = { ...base };
  for (const k of Object.keys(saved ?? {})) out[k] = k in base ? merge(base[k], saved[k]) : saved[k];
  return out;
}

export function load() {
  const fromUrl = location.hash.startsWith("#s=") ? decode(location.hash.slice(3)) : null;
  let saved = fromUrl;
  if (!saved) try { saved = JSON.parse(localStorage.getItem(KEY)); } catch { saved = null; }
  const s = merge(defaults(), saved);
  ensureIds(s.routes);
  return s;
}

let timer;
export function save(s) {
  clearTimeout(timer);
  timer = setTimeout(() => localStorage.setItem(KEY, JSON.stringify(s)), 300);
}

export function shareUrl(s) {
  const json = JSON.stringify({ ...s, time: { ...s.time, stale: false } });
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(json))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${location.origin}${location.pathname}#s=${b64}`;
}

function decode(b64) {
  try {
    const bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  } catch { return null; }
}
