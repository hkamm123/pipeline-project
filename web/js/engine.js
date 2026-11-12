// The sound: six layers built from Tone.js (loaded as the global `Tone`).
//
//   pad ──filter──┐
//   arp ──delay───┤
//   bells ────────┼── life gain (activity) ──┐
//   texture ──────┤                          ├── dropout ── reverb ── dynamics ── master ── limiter ── speakers
//   noise (sea) ──┘                          │
//   drone ───────────────────────────────────┘   (the drone ignores activity: it's what's left when data stops)

import { MODE_NAMES, modeIndex } from "./matrix.js";

export const LAYERS = ["pad", "arp", "bells", "texture", "noise", "drone"];
const MODES = {
  Lydian: [0, 2, 4, 6, 7, 9, 11], Ionian: [0, 2, 4, 5, 7, 9, 11], Mixolydian: [0, 2, 4, 5, 7, 9, 10],
  Dorian: [0, 2, 3, 5, 7, 9, 10], Aeolian: [0, 2, 3, 5, 7, 8, 10], Phrygian: [0, 1, 3, 5, 7, 8, 10],
};
export const ROOTS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
const pick = (a) => a[Math.floor(Math.random() * a.length)];

export class Engine {
  constructor() {
    this.started = false;
    this.p = null;
    this.music = { root: "D", scale: "auto", tempoMode: "auto", bpm: 56, octaves: 2, baseOct: 4 };
    this.degree = 0;
    this.chord = [];
    this.arpIndex = 0;
    this.modeName = "Lydian";
  }

  async start() {
    await Tone.start();
    const T = Tone;
    this.limiter = new T.Limiter(-1).toDestination();
    this.master = new T.Volume(-2).connect(this.limiter);
    this.dyn = new T.Volume(-6).connect(this.master);
    this.reverb = new T.Reverb({ decay: 9, preDelay: 0.04, wet: 0.3 }).connect(this.dyn);
    await this.reverb.ready;
    this.dropout = new T.Gain(1).connect(this.reverb);
    this.life = new T.Gain(1).connect(this.dropout);

    this.bus = {};
    for (const name of LAYERS) this.bus[name] = new T.Volume(0).connect(name === "drone" ? this.dropout : this.life);

    // pad: detuned saws through a low-pass filter (cutoff follows the water level)
    this.padFilter = new T.Filter({ type: "lowpass", frequency: 600, rolloff: -24, Q: 0.7 }).connect(this.bus.pad);
    this.pad = new T.PolySynth(T.Synth, {
      oscillator: { type: "fatsawtooth", count: 3, spread: 12 },
      envelope: { attack: 4, decay: 1, sustain: 0.8, release: 7 },
      volume: -16,
    }).connect(this.padFilter);
    this.pad.maxPolyphony = 16;

    // arpeggio: soft plucks with a dotted-eighth echo
    this.arpDelay = new T.FeedbackDelay({ delayTime: "8n.", feedback: 0.35, wet: 0.35 }).connect(this.bus.arp);
    this.arp = new T.Synth({
      oscillator: { type: "triangle" },
      envelope: { attack: 0.005, decay: 0.35, sustain: 0.05, release: 1.4 },
      volume: -14,
    }).connect(this.arpDelay);

    // bells: FM synthesis with an inharmonic ratio sounds metallic
    this.bells = new T.PolySynth(T.FMSynth, {
      harmonicity: 3.01, modulationIndex: 12,
      envelope: { attack: 0.002, decay: 4, sustain: 0, release: 4 },
      modulationEnvelope: { attack: 0.002, decay: 0.6, sustain: 0, release: 0.6 },
      volume: -12,
    }).connect(this.bus.bells);

    // texture: high glassy sparkles (choppiness)
    this.texture = new T.PolySynth(T.Synth, {
      oscillator: { type: "sine" },
      envelope: { attack: 0.01, decay: 0.9, sustain: 0, release: 1.5 },
      volume: -22,
    }).connect(this.bus.texture);

    // noise: pink noise, band-passed, swelling slowly like surf; louder with tension
    this.noiseLevel = new T.Volume(-40).connect(this.bus.noise);
    this.surf = new T.Gain(0.5).connect(this.noiseLevel);
    new T.LFO({ frequency: 0.07, min: 0.15, max: 1 }).connect(this.surf.gain).start();
    this.noiseFilter = new T.Filter({ type: "bandpass", frequency: 700, Q: 0.6 }).connect(this.surf);
    new T.Noise("pink").connect(this.noiseFilter).start();
    // crackle for data gaps
    this.crackle = new T.NoiseSynth({ noise: { type: "white" }, envelope: { attack: 0.001, decay: 0.02, sustain: 0 }, volume: -10 })
      .connect(new T.Filter({ type: "highpass", frequency: 2500 }).connect(this.bus.noise));

    // drone: root and fifth, very low
    this.droneVol = new T.Volume(-20).connect(this.bus.drone);
    const droneFilter = new T.Filter({ type: "lowpass", frequency: 500 }).connect(this.droneVol);
    this.drone = [new T.Oscillator(hz(this.rootMidi(2)), "sine"), new T.Oscillator(hz(this.rootMidi(2) + 7), "triangle")];
    this.drone.forEach((o) => o.connect(droneFilter).start());
    this.drone[1].volume.value = -10;

    const tr = T.getTransport();
    tr.bpm.value = 56;
    this.chordLoop = new T.Loop((time) => this.nextChord(time), "2m").start(0);
    this.noteLoop = new T.Loop((time) => this.tick16(time), "16n").start("4n");
    tr.start();
    this.started = true;
  }

  // Pause/resume (the audio graph stays built, so resuming is instant).
  pause() {
    if (!this.started) return;
    Tone.getDestination().volume.rampTo(-60, 0.4);
    setTimeout(() => { Tone.getTransport().pause(); Tone.getDestination().mute = true; }, 450);
    this.paused = true;
  }

  resume() {
    Tone.getDestination().mute = false;
    Tone.getDestination().volume.rampTo(0, 0.4);
    Tone.getTransport().start();
    this.paused = false;
  }

  rootMidi(octave) { return 12 * (octave + 1) + ROOTS.indexOf(this.music.root); }

  scale() {
    const name = this.music.scale === "auto" && this.p ? MODE_NAMES[modeIndex(this.p.mode)] : this.music.scale === "auto" ? "Lydian" : this.music.scale;
    this.modeName = name;
    return MODES[name];
  }

  // A scale degree (any integer) -> MIDI note
  degreeMidi(d, octave) {
    const sc = this.scale();
    const o = Math.floor(d / 7);
    return this.rootMidi(octave + o) + sc[((d % 7) + 7) % 7];
  }

  nextChord(time) {
    // A gentle random walk around the tonic.
    const moves = { 0: [3, 5, 4, 1], 1: [4, 0], 3: [0, 4, 1], 4: [0, 5, 3], 5: [3, 1, 0] };
    this.degree = pick(moves[this.degree] ?? [0]);
    const d = this.degree;
    const notes = [d, d + 2, d + 4, d + 6].map((x) => this.degreeMidi(x, 3));
    const t = this.p?.tension ?? 0;
    if (Math.random() < t) notes.push(this.degreeMidi(d + 1, 4)); // a cluster note: dissonance
    this.chord = notes;
    const dur = Tone.Time("2m").toSeconds() * 0.95;
    this.pad.triggerAttackRelease(notes.map(hz), dur, time, 0.5);
  }

  tick16(time) {
    const p = this.p;
    if (!p || !this.chord.length) return;
    if (Math.random() < p.arp_density) {
      const pool = [];
      for (let o = 0; o < this.music.octaves; o++) for (const m of this.chord.slice(0, 4)) pool.push(m + 12 * (this.music.baseOct - 3 + o));
      pool.sort((a, b) => a - b);
      const up = Math.random() < (1 + p.arp_direction) / 2; // direction is a probability, so it can drift
      this.arpIndex = (this.arpIndex + (up ? 1 : -1) + pool.length) % pool.length;
      this.arp.triggerAttackRelease(hz(pool[this.arpIndex]), "16n", time, 0.35 + Math.random() * 0.35);
    }
    if (Math.random() < p.shimmer) {
      const m = this.degreeMidi(Math.floor(Math.random() * 7), 6 + (Math.random() < 0.4 ? 1 : 0));
      this.texture.triggerAttackRelease(hz(m), "32n", time, 0.2 + Math.random() * 0.4);
    }
  }

  // Continuous parameters, called a few times a second.
  apply(p, music) {
    this.p = p;
    const rootChanged = music.root !== this.music.root;
    this.music = { ...music };
    if (!this.started) return;
    this.padFilter.frequency.rampTo(p.cutoff, 0.4);
    this.pad.volume.rampTo(p.pad_level, 0.4);
    this.reverb.wet.rampTo(p.reverb, 0.6);
    this.dyn.volume.rampTo(p.dynamics, 0.6);
    this.life.gain.rampTo(p.activity, 1.5);
    this.noiseLevel.volume.rampTo(-44 + 28 * p.tension, 0.6);
    const spread = Math.round(8 + 60 * p.tension);
    if (spread !== this.spread) { this.pad.set({ oscillator: { spread } }); this.spread = spread; }
    const bpm = music.tempoMode === "auto" ? p.tempo : music.bpm;
    if (Math.abs(Tone.getTransport().bpm.value - bpm) > 0.5) Tone.getTransport().bpm.rampTo(bpm, 2);
    if (rootChanged) {
      this.drone[0].frequency.rampTo(hz(this.rootMidi(2)), 2);
      this.drone[1].frequency.rampTo(hz(this.rootMidi(2) + 7), 2);
    }
    this.scale(); // keeps modeName current for the UI
  }

  mix(mixer) {
    if (!this.started) return;
    const anySolo = LAYERS.some((l) => mixer[l]?.solo);
    for (const l of LAYERS) {
      const m = mixer[l];
      this.bus[l].volume.rampTo(m.db, 0.1);
      this.bus[l].mute = m.mute || (anySolo && !m.solo);
    }
    this.master.volume.rampTo(mixer.master, 0.1);
  }

  // Events
  bell(type) {
    if (!this.started) return;
    const now = Tone.now();
    const notes = type === "high" ? [this.degreeMidi(0, 5), this.degreeMidi(4, 5), this.degreeMidi(7, 5)] : [this.degreeMidi(0, 3), this.degreeMidi(4, 3)];
    notes.forEach((m, i) => this.bells.triggerAttackRelease(hz(m), 5, now + i * 0.35, 0.6));
  }

  ping() { // new data arrived from the pipeline
    if (!this.started) return;
    this.bells.triggerAttackRelease(hz(this.degreeMidi(4, 6)), 2, Tone.now(), 0.18);
  }

  gap() { // a failed-QC reading: a short dropout and some static
    if (!this.started) return;
    const now = Tone.now() + 0.02;
    this.dropout.gain.rampTo(0.12, 0.03, now);
    this.dropout.gain.rampTo(1, 0.3, now + 0.6);
    let t = now;
    for (let i = 0; i < 14; i++) {
      t += 0.025 + Math.random() * 0.06; // strictly increasing: a mono synth can't go back in time
      this.crackle.triggerAttackRelease(0.005 + Math.random() * 0.015, t, 0.3 + Math.random() * 0.7);
    }
  }
}
