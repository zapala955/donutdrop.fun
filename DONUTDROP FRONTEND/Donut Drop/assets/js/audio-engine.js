/* audio-engine.js — the site's interface and game sound.
 *
 * The redesign preview's engine (2026-11-21, the owner: "now do the sounds from the preview"):
 * cues built at call time from FM bells, inharmonic coins and filtered noise, through one
 * compressed bus with a small room on it, plus five short Minecraft clips (about 50 KB of MP3 in
 * all, fetched once on the first sound) where a clip fits. Every cue still plays without them.
 *
 * THREE RULES THIS FILE KEEPS
 * --------------------------
 * 1. The context is created lazily, on the first real gesture. Browsers suspend an AudioContext
 *    built before a user interaction, and a suspended context that nobody resumes is silence
 *    nobody can debug.
 * 2. Nothing plays when the page is muted or the user asked for reduced motion — the same people
 *    who do not want the screen lurching usually do not want it chiming either.
 * 3. Every voice disconnects when it finishes. Leaked oscillator nodes are the classic way a
 *    tab's audio graph grows until the whole page stutters.
 */

/* The older sample player in audio.js still drives the reveal, reel and cutscene. Both engines
 * have to answer to one mute control, or muting the site silences half of it and the player has
 * no idea which half. This module owns the control and forwards every change. */
import { setMuted as setLegacyMuted } from './audio.js';

let context = null;
let master = null;
let muted = readMutePreference();
/* The volume slider on /settings, 0 to 100, kept with the other display settings (prefs-boot.js).
 * 100 is the level every cue was tuned at. */
let volume = readVolume();

const MUTE_KEY = 'donutdrop.muted';
/* The preview's bus level: its cues are mixed for 0.9 into the compressor. */
const MASTER_GAIN = 0.9;

function readVolume() {
  const stored = Number(globalThis.DonutPrefs?.get?.().volume);
  return Number.isFinite(stored) ? Math.min(100, Math.max(0, Math.round(stored))) : 100;
}

function masterGain() {
  return (MASTER_GAIN * volume) / 100;
}

function readMutePreference() {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    // Private windows throw on access. Defaulting to audible matches the visible mute control.
    return false;
  }
}

function persistMutePreference(value) {
  try {
    localStorage.setItem(MUTE_KEY, value ? '1' : '0');
  } catch {
    /* nothing to persist to; the in-memory flag still governs this session */
  }
}

function reduceMotion() {
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Created on demand so the first gesture owns it and it is never born suspended. */
function ensureContext() {
  if (muted || reduceMotion()) return null;
  if (!context) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    try {
      context = new Ctor({ latencyHint: 'interactive' });
    } catch {
      context = new Ctor();
    }
    buildGraph(context);
  }
  if (context.state === 'suspended') void context.resume();
  return context;
}

export function isMuted() {
  return muted;
}

export function setMuted(value) {
  muted = !!value;
  persistMutePreference(muted);
  try {
    setLegacyMuted(muted);
  } catch {
    /* the legacy player is optional; never let it break the toggle */
  }
  if (muted && context) {
    // Silence anything mid-flight rather than letting a tail ring out after the toggle.
    master.gain.cancelScheduledValues(context.currentTime);
    master.gain.setValueAtTime(0, context.currentTime);
  } else if (!muted && master && context) {
    master.gain.setValueAtTime(masterGain(), context.currentTime);
  }
  // The top bar's button and the settings page both show this; either can change it.
  try {
    globalThis.dispatchEvent?.(new Event('lx:mute'));
  } catch {
    /* nothing listening is fine */
  }
  return muted;
}

export function getVolume() {
  return volume;
}

/** 0 to 100. Applied to anything already sounding, and remembered with the other settings. */
export function setVolume(value) {
  const next = Number(value);
  if (!Number.isFinite(next)) return volume;
  volume = Math.min(100, Math.max(0, Math.round(next)));
  if (master && context && !muted) master.gain.setValueAtTime(masterGain(), context.currentTime);
  globalThis.DonutPrefs?.update?.({ volume });
  return volume;
}

export function toggleMuted() {
  return setMuted(!muted);
}

/* ─────────── the voice: the redesign preview's sound (2026-11-21) ───────────
 *
 * Every cue runs into one bus, through a gentle compressor, with a short room reverb on a send, so
 * a coin, a bell and a blast sit in the same space instead of each beeping on its own. Bells are
 * two-operator FM (bright when struck, mellowing as they ring), coins are inharmonic partials, and
 * noise is shaped by a sweeping filter. Five Minecraft clips (the orb, the level-up, the click, the
 * fizz and the chest) are fetched once as MP3 and used where they fit; until one has decoded, or if
 * it never does, the cue plays its synth part alone.
 *
 * `pitch` is the caller's `rate` while a cue is being built: every tone, bell, filter and clip in
 * that cue is scaled by it, so a gem can ring a step higher for every one found. */

const SAMPLE_BASE = '/assets/sound/';
const SAMPLES = ['orb', 'levelup', 'click', 'fizz', 'chestopen'];
const buffers = {};
let verb = null;
let noiseBuffer = null;
let pitch = 1;
let lastPeg = -1;

const semi = (n) => 2 ** (n / 12);
const rnd = (low, high) => low + Math.random() * (high - low);
const PENT = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24, 26, 28, 31, 33, 36];

/** A small room: decaying stereo noise as the reverb's impulse. */
function room(ctx, seconds, decay) {
  const rate = ctx.sampleRate;
  const frames = Math.floor(rate * seconds);
  const buffer = ctx.createBuffer(2, frames, rate);
  for (let channel = 0; channel < 2; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < frames; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / frames) ** decay * Math.min(1, i / (rate * 0.01));
  }
  return buffer;
}

function loadSamples(ctx) {
  if (typeof fetch !== 'function') return;
  for (const name of SAMPLES) {
    fetch(`${SAMPLE_BASE}${name}.mp3`)
      .then((response) => (response.ok ? response.arrayBuffer() : Promise.reject(new Error(String(response.status)))))
      // The callback form, which older Safari needs; the promise wraps it for everyone else.
      .then((bytes) => new Promise((resolve, reject) => { ctx.decodeAudioData(bytes, resolve, reject); }))
      .then((buffer) => { buffers[name] = buffer; })
      .catch(() => { /* the synth part of each cue covers for it */ });
  }
}

/** The bus and the room, built with the context. */
function buildGraph(ctx) {
  const squash = ctx.createDynamicsCompressor();
  squash.threshold.value = -15;
  squash.knee.value = 10;
  squash.ratio.value = 5;
  squash.attack.value = 0.002;
  squash.release.value = 0.2;
  master = ctx.createGain();
  master.gain.value = masterGain();
  master.connect(squash);
  squash.connect(ctx.destination);
  verb = ctx.createConvolver();
  verb.buffer = room(ctx, 1.6, 3.2);
  const wet = ctx.createGain();
  wet.gain.value = 0.32;
  verb.connect(wet);
  wet.connect(master);
  loadSamples(ctx);
}

/** Routes a voice to the bus (panned, and with some of it sent to the room). Returns the nodes it
 *  added, so the voice can let go of them all when it ends. */
function out(ctx, node, send = 0.15, pan = 0) {
  const added = [];
  let tail = node;
  if (pan && ctx.createStereoPanner) {
    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    tail.connect(panner);
    tail = panner;
    added.push(panner);
  }
  tail.connect(master);
  if (send) {
    const sendGain = ctx.createGain();
    sendGain.gain.value = send;
    tail.connect(sendGain);
    sendGain.connect(verb);
    added.push(sendGain);
  }
  return added;
}

/** Releases a finished voice's nodes, or the graph grows for the life of the tab. */
function release(source, nodes) {
  source.onended = () => {
    for (const node of nodes) node.disconnect();
  };
}

/* The gain starts silent, not at its default of 1: a voice that starts a hair before its envelope
 * would otherwise let one full-level sample through, and through a high-pass that is a click. */
function envelope(gain, at, attack, peak, decay) {
  gain.gain.value = 0.0001;
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), at + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
}

/** A filter frequency the context can take, after the caller's pitch. */
function hz(ctx, value) {
  return Math.min(ctx.sampleRate / 2 - 100, Math.max(20, value * pitch));
}

/** One oscillator with an exponential envelope, optionally swept and low-passed. */
function tone(ctx, freq, { t = 0, type = 'sine', a = 0.004, d = 0.18, vol = 0.1, to = 0, lp = 0, send = 0.15, pan = 0 } = {}) {
  const at = ctx.currentTime + t;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq * pitch, at);
  if (to) osc.frequency.exponentialRampToValueAtTime(to * pitch, at + a + d);
  const nodes = [osc, gain];
  let head = osc;
  if (lp) {
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = hz(ctx, lp);
    osc.connect(filter);
    head = filter;
    nodes.push(filter);
  }
  envelope(gain, at, a, vol, d);
  head.connect(gain);
  nodes.push(...out(ctx, gain, send, pan));
  release(osc, nodes);
  osc.start(at);
  osc.stop(at + a + d + 0.05);
}

/** Filtered noise with an envelope: air, sand, water, a blast. */
function hiss(ctx, { t = 0, a = 0.002, d = 0.1, vol = 0.1, type = 'bandpass', f = 2000, to = 0, q = 1, send = 0.1, pan = 0 } = {}) {
  if (!noiseBuffer || noiseBuffer.sampleRate !== ctx.sampleRate) {
    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
  }
  const at = ctx.currentTime + t;
  const source = ctx.createBufferSource();
  const filter = ctx.createBiquadFilter();
  const gain = ctx.createGain();
  source.buffer = noiseBuffer;
  source.loop = true;
  filter.type = type;
  filter.Q.value = q;
  filter.frequency.setValueAtTime(hz(ctx, f), at);
  if (to) filter.frequency.exponentialRampToValueAtTime(hz(ctx, to), at + a + d);
  envelope(gain, at, a, vol, d);
  source.connect(filter);
  filter.connect(gain);
  release(source, [source, filter, gain, ...out(ctx, gain, send, pan)]);
  source.start(at, Math.random() * 0.8);
  source.stop(at + a + d + 0.05);
}

/** Two-operator FM: a struck bell that loses its brightness as it rings. */
function bell(ctx, freq, { t = 0, vol = 0.08, d = 0.8, ratio = 3.5, index = 1.6, send = 0.35, pan = 0 } = {}) {
  const at = ctx.currentTime + t;
  const f = freq * pitch;
  const carrier = ctx.createOscillator();
  const modulator = ctx.createOscillator();
  const depth = ctx.createGain();
  const gain = ctx.createGain();
  carrier.frequency.setValueAtTime(f, at);
  modulator.frequency.setValueAtTime(f * ratio, at);
  depth.gain.setValueAtTime(f * index, at);
  depth.gain.exponentialRampToValueAtTime(Math.max(1, f * 0.02), at + d * 0.6);
  modulator.connect(depth);
  depth.connect(carrier.frequency);
  carrier.connect(gain);
  envelope(gain, at, 0.002, vol, d);
  release(carrier, [carrier, modulator, depth, gain, ...out(ctx, gain, send, pan)]);
  carrier.start(at);
  modulator.start(at);
  carrier.stop(at + d + 0.1);
  modulator.stop(at + d + 0.1);
}

/** Inharmonic partials: a coin, or the edge of a chip. */
function clink(ctx, freq, { t = 0, vol = 0.05, d = 0.35, send = 0.3, pan = 0 } = {}) {
  [1, 2.76, 5.4].forEach((ratio, i) => tone(ctx, freq * ratio, { t, a: 0.001, d: d / (1 + i), vol: vol / (1 + i * 1.3), send, pan }));
}

/** One of the Minecraft clips; false when it has not decoded, so the cue can fall back. */
function sample(ctx, name, { rate = 1, vol = 0.4, t = 0, send = 0.12, pan = 0 } = {}) {
  const buffer = buffers[name];
  if (!buffer) return false;
  const source = ctx.createBufferSource();
  const gain = ctx.createGain();
  source.buffer = buffer;
  source.playbackRate.value = rate * pitch;
  gain.gain.value = vol;
  source.connect(gain);
  release(source, [source, gain, ...out(ctx, gain, send, pan)]);
  source.start(ctx.currentTime + t);
  return true;
}

/* The preview's building blocks, shared by the cues below. */
function coins(ctx, n = 6, spread = 0.4) {
  for (let i = 0; i < n; i += 1) clink(ctx, rnd(1900, 3200), { t: Math.random() * spread, vol: 0.034, d: 0.32, pan: rnd(-0.6, 0.6) });
}
function winBells(ctx, m = 2) {
  const notes = m >= 5 ? [0, 4, 7, 12] : m >= 2 ? [0, 7, 12] : [0, 7];
  notes.forEach((n, i) => bell(ctx, 1046.5 * semi(n), { t: i * 0.065, vol: 0.075, d: 0.95, index: 1.2, pan: (i - 1) * 0.18 }));
  sample(ctx, 'orb', { rate: 1.25, vol: 0.16, t: 0.02 });
}
function cash(ctx, m = 2) {
  coins(ctx, 5 + Math.min(8, Math.floor(m)), 0.35);
  winBells(ctx, m);
}
function big(ctx) {
  if (!sample(ctx, 'levelup', { vol: 0.42, send: 0.25 })) [0, 4, 7, 12, 16].forEach((n, i) => bell(ctx, 784 * semi(n), { t: i * 0.08, vol: 0.08 }));
  [0, 4, 7, 12, 16].forEach((n, i) => bell(ctx, 1046.5 * semi(n), { t: 0.05 + i * 0.075, vol: 0.05, d: 1.3, pan: (i - 2) * 0.15 }));
  coins(ctx, 14, 1.1);
}
function boom(ctx, size = 1) {
  hiss(ctx, { type: 'lowpass', f: 2400, to: 80, q: 0.7, a: 0.003, d: 1.15, vol: 0.85 * size, send: 0.4 });
  tone(ctx, 115, { to: 32, a: 0.002, d: 0.65, vol: 0.55 * size, send: 0.1 });
  tone(ctx, 58, { type: 'triangle', to: 28, a: 0.004, d: 0.95, vol: 0.32 * size, send: 0 });
  for (let i = 0; i < 10; i += 1) hiss(ctx, { t: 0.03 + Math.random() * 0.55, type: 'highpass', f: rnd(2400, 6000), d: rnd(0.015, 0.05), vol: rnd(0.06, 0.15) * size, pan: rnd(-0.7, 0.7), send: 0.25 });
}
function gem(ctx, quiet = false) {
  if (!sample(ctx, 'orb', { rate: 0.72, vol: quiet ? 0.16 : 0.3, send: 0.2 })) bell(ctx, 1046.5, { vol: 0.07, d: 0.6 });
  bell(ctx, 2093, { t: 0.015, vol: quiet ? 0.012 : 0.022, d: 0.5, ratio: 2, index: 0.7 });
}
function whoosh(ctx, { d = 0.35, up = true, vol = 0.1 } = {}) {
  hiss(ctx, { type: 'bandpass', f: up ? 320 : 2600, to: up ? 2600 : 320, q: 1.3, a: d * 0.6, d: d * 0.4, vol, send: 0.15 });
}
function tickVoice(ctx, p = 0, vol = 1) {
  hiss(ctx, { type: 'highpass', f: 6000, d: 0.012, vol: 0.05 * vol, send: 0 });
  tone(ctx, 1500 * semi(p), { type: 'triangle', d: 0.03, vol: 0.024 * vol, send: 0.05 });
}
function chipClack(ctx) {
  const f = rnd(2900, 3700);
  hiss(ctx, { f, q: 8, d: 0.02, vol: 0.3, send: 0.05 });
  hiss(ctx, { t: 0.025, f: f * 0.86, q: 8, d: 0.025, vol: 0.18, send: 0.05 });
}
function betClack(ctx) {
  hiss(ctx, { f: 3400, q: 7, d: 0.022, vol: 0.34, send: 0.05 });
  hiss(ctx, { t: 0.032, f: 2900, q: 7, d: 0.03, vol: 0.24, send: 0.05 });
  tone(ctx, 2650, { t: 0.032, type: 'triangle', d: 0.05, vol: 0.018, send: 0.1 });
}
function dieLand(ctx) {
  hiss(ctx, { type: 'lowpass', f: 1100, d: 0.05, vol: 0.2, send: 0.05 });
  tone(ctx, 230, { d: 0.05, vol: 0.05, send: 0 });
}
function launch(ctx, vol = 1) {
  hiss(ctx, { type: 'lowpass', f: 180, to: 1500, q: 0.8, a: 0.35, d: 0.6, vol: 0.32 * vol, send: 0.2 });
  tone(ctx, 70, { to: 150, a: 0.2, d: 0.6, vol: 0.12 * vol });
}
function ball(ctx, v = 1, t = 0) {
  hiss(ctx, { t, type: 'bandpass', f: 4300, q: 5, d: 0.008, vol: 0.22 * v, send: 0.06 });
  tone(ctx, 3100, { t, d: 0.012, vol: 0.012 * v, send: 0 });
}

/* The cue library. The names are the site's; each one is voiced the way the preview voices the same
 * moment (its Mines gem for a diamond, its cart for the minecart, its cash for a cash-out). */
const CUES = {
  /** Any ordinary press: the Minecraft click, high and quiet. It fires constantly. */
  click(ctx) {
    if (!sample(ctx, 'click', { rate: 1.45, vol: 0.16, send: 0 })) tone(ctx, 2400, { d: 0.02, vol: 0.03, send: 0 });
  },
  /** Hovering a live control: a breath of air, almost nothing. */
  hover(ctx) {
    hiss(ctx, { type: 'highpass', f: 7000, d: 0.006, vol: 0.015, send: 0 });
  },
  /** Anvil: a metal clink over a low knock. A duel's hit. */
  anvil(ctx) {
    clink(ctx, rnd(1650, 1950), { vol: 0.08, d: 0.5 });
    hiss(ctx, { type: 'lowpass', f: 650, d: 0.05, vol: 0.18, send: 0 });
    tone(ctx, 120, { to: 60, d: 0.22, vol: 0.18, send: 0.1 });
  },
  /** Coins: a handful of clinks, spread a little. */
  coin(ctx) {
    coins(ctx, 5, 0.3);
  },
  /** Portal: a rising whoosh into a soft bell. */
  portal(ctx) {
    whoosh(ctx, { d: 0.45, up: true, vol: 0.1 });
    bell(ctx, 784, { t: 0.22, vol: 0.05, d: 0.9, ratio: 2, index: 0.8 });
  },
  /** Win: root, fifth and octave on bells, with the orb. */
  win(ctx) {
    winBells(ctx, 2);
  },
  /** Loss: a falling tone and a soft low knock, never a buzzer. */
  lose(ctx) {
    tone(ctx, 370, { type: 'triangle', to: 185, a: 0.005, d: 0.34, vol: 0.06, lp: 1300, send: 0.22 });
    hiss(ctx, { type: 'lowpass', f: 320, d: 0.09, vol: 0.12, send: 0 });
  },
  /** Reward claimed: coins under four bells. */
  reward(ctx) {
    cash(ctx, 5);
  },
  /** A tick: a dry click with a little pitch to it. Pitched by the caller. */
  tick(ctx) {
    tickVoice(ctx, 0);
  },
  /** A heavy hit: the blast, held back. */
  slam(ctx) {
    boom(ctx, 0.7);
  },
  /** One click of a reel going round. It fires every 70 to 95 ms, so it stays small. */
  reeltick(ctx) {
    tickVoice(ctx, 0, 0.75);
  },
  /** Glass breaking: a bright scatter over a low thud. Also every firework, pitched up. */
  shatter(ctx) {
    hiss(ctx, { type: 'highpass', f: 3200, a: 0.001, d: 0.3, vol: 0.3, send: 0.35 });
    for (let i = 0; i < 12; i += 1) tone(ctx, rnd(2600, 6800), { t: Math.random() * 0.22, d: rnd(0.06, 0.22), vol: rnd(0.015, 0.035), pan: rnd(-0.7, 0.7), send: 0.45 });
    tone(ctx, 95, { to: 45, d: 0.35, vol: 0.28 });
    hiss(ctx, { t: 0.06, type: 'lowpass', f: 1100, to: 220, d: 0.65, vol: 0.28, send: 0.45 });
  },
  /** A bright bell. Level-up, the rain claim, a book landing on a reel, the derby's finish. */
  chime(ctx) {
    bell(ctx, 1568, { vol: 0.09, d: 0.9, ratio: 2, index: 0.8 });
    sample(ctx, 'orb', { rate: 1.5, vol: 0.1, t: 0.02 });
  },
  /** Boost: a short rising whoosh. */
  boost(ctx) {
    whoosh(ctx, { d: 0.3, up: true, vol: 0.12 });
  },
  /** An orb collected: the Minecraft orb, small. It can fire several times a second. */
  absorb(ctx) {
    if (!sample(ctx, 'orb', { rate: rnd(1.5, 1.8), vol: 0.07, send: 0.05 })) bell(ctx, 2093, { vol: 0.015, d: 0.2, ratio: 2, index: 0.7 });
  },
  /** Coins spilling out over a soft thud. */
  spill(ctx) {
    hiss(ctx, { type: 'lowpass', f: 420, d: 0.06, vol: 0.12, send: 0 });
    coins(ctx, 8, 0.5);
  },
  /* ── the lake ── */
  /** A line whipped out over the water: a quick rising swish. */
  cast(ctx) {
    whoosh(ctx, { d: 0.28, up: true, vol: 0.11 });
  },
  /** Water: a rising wash with spray on top. */
  splash(ctx) {
    hiss(ctx, { type: 'bandpass', f: 700, to: 2600, q: 0.8, a: 0.012, d: 0.26, vol: 0.2, send: 0.3 });
    hiss(ctx, { t: 0.07, type: 'highpass', f: 3500, d: 0.2, vol: 0.05, send: 0.2 });
  },
  /** Thunder far off: a long low rumble. */
  thunder(ctx) {
    hiss(ctx, { type: 'lowpass', f: 500, to: 60, q: 0.7, a: 0.05, d: 1.6, vol: 0.45, send: 0.4 });
    tone(ctx, 55, { type: 'triangle', to: 30, a: 0.02, d: 1.2, vol: 0.2, send: 0.1 });
  },
  /* ── the mine ── */
  /** A pickaxe on stone: a dry crack over a dull knock. Pitched by the caller per crack. */
  dig(ctx) {
    hiss(ctx, { type: 'highpass', f: 2600, d: 0.05, vol: 0.2, send: 0.2 });
    tone(ctx, 3800, { d: 0.05, vol: 0.02 });
    hiss(ctx, { type: 'lowpass', f: 900, d: 0.04, vol: 0.12, send: 0 });
  },
  /** TNT lit: the Minecraft fizz. */
  fuse(ctx) {
    if (!sample(ctx, 'fizz', { rate: 1.35, vol: 0.2, send: 0.05 })) hiss(ctx, { type: 'highpass', f: 4000, a: 0.02, d: 0.35, vol: 0.08 });
  },
  /** TNT going off: a roar falling away, a sub drop and debris. */
  explode(ctx) {
    boom(ctx, 1);
  },
  /** Something enormous: the level-up, a run of bells and a rain of coins. */
  jackpot(ctx) {
    big(ctx);
  },
  /* ── Plinko ── */
  /** A ball leaving the hand: the click. */
  plinkoDrop(ctx) {
    CUES.click(ctx);
  },
  /** A ball on a peg: a small tap, never more than one every 28 ms. Pitched by the caller. */
  pegtap(ctx) {
    const now = ctx.currentTime;
    if (now - lastPeg < 0.028) return;
    lastPeg = now;
    tone(ctx, 1100 + rnd(-30, 30), { type: 'triangle', d: 0.05, vol: 0.022, send: 0.1 });
    hiss(ctx, { type: 'highpass', f: 7000, d: 0.006, vol: 0.03, send: 0 });
  },
  /** Into a slot that pays back less than the ball cost: a low knock. */
  plinkoLow(ctx) {
    tone(ctx, 196, { type: 'triangle', d: 0.12, vol: 0.05, lp: 900, send: 0.05 });
    hiss(ctx, { type: 'lowpass', f: 420, d: 0.05, vol: 0.08, send: 0 });
  },
  /** About even (1x to 2x): one bell. */
  plinkoEven(ctx) {
    bell(ctx, 1318.5, { vol: 0.05, d: 0.45 });
  },
  /** A real win (2x and up). */
  plinkoWin(ctx) {
    winBells(ctx, 2);
  },
  /** 10x and up: four bells and coins. 100x and up is the jackpot. */
  plinkoBig(ctx) {
    cash(ctx, 5);
  },
  /* ── Dice ── */
  /** The line moving one point: a tiny tick. Pitched by the caller with where the line is. */
  diceTick(ctx) {
    tone(ctx, 1020, { type: 'triangle', d: 0.02, vol: 0.022, send: 0 });
    hiss(ctx, { type: 'highpass', f: 7000, d: 0.005, vol: 0.02, send: 0 });
  },
  /** The roll going out: a die rattling in a cup. */
  diceRoll(ctx) {
    let t = 0;
    for (let i = 0; i < 7; i += 1) {
      hiss(ctx, { t, f: rnd(2300, 4200), q: 4, d: 0.014, vol: 0.18, send: 0.05, pan: rnd(-0.3, 0.3) });
      t += 0.035 + i * 0.016;
    }
  },
  /** A win: the die lands, then the bells. */
  diceWin(ctx) {
    dieLand(ctx);
    winBells(ctx, 2);
  },
  /** 10x and up: the die lands, then the level-up. */
  diceBig(ctx) {
    dieLand(ctx);
    big(ctx);
  },
  /** A miss: the die lands, then the soft fall. */
  diceLose(ctx) {
    dieLand(ctx);
    CUES.lose(ctx);
  },
  /* ── Tower ── */
  /** A tile chosen: the click over a soft knock. */
  towerTap(ctx) {
    if (!sample(ctx, 'click', { rate: 1.1, vol: 0.2, send: 0 })) tone(ctx, 1800, { d: 0.02, vol: 0.03, send: 0 });
    hiss(ctx, { type: 'lowpass', f: 900, d: 0.03, vol: 0.1, send: 0 });
  },
  /** A climb starting: the bet going down. */
  towerStart(ctx) {
    betClack(ctx);
  },
  /** A gem: the orb with a bell over it. Pitched by the caller, a step up for every floor. */
  towerGem(ctx) {
    gem(ctx);
  },
  /** The next floor waking: a spring up and a soft landing. */
  towerClimb(ctx) {
    tone(ctx, 380, { to: 820, a: 0.005, d: 0.11, vol: 0.045, type: 'triangle', send: 0.1 });
    hiss(ctx, { t: 0.26, type: 'lowpass', f: 520, d: 0.06, vol: 0.15, send: 0 });
  },
  /** TNT: the fizz, then the blast. */
  towerBoom(ctx) {
    sample(ctx, 'fizz', { rate: 1.6, vol: 0.12, send: 0.05 });
    boom(ctx, 0.85);
  },
  /** The rest of the tower turning over: a small tick per floor, pitched up by the caller. */
  towerReveal(ctx) {
    tickVoice(ctx, 0, 0.7);
  },
  /** Cashed out: coins and bells. */
  towerCash(ctx) {
    cash(ctx, 3);
  },
  /* ── Mines ── */
  /** A tile chosen: a dry crack. */
  minesTap(ctx) {
    hiss(ctx, { type: 'highpass', f: 2600, d: 0.05, vol: 0.2, send: 0.2 });
    tone(ctx, 3800, { d: 0.05, vol: 0.02 });
  },
  minesStart(ctx) { CUES.towerStart(ctx); },
  /** A diamond: the orb with a bell over it. Pitched by the caller, a step up per diamond. */
  minesGem(ctx) {
    gem(ctx);
  },
  minesBoom(ctx) { CUES.towerBoom(ctx); },
  minesReveal(ctx) { CUES.towerReveal(ctx); },
  minesCash(ctx) { CUES.towerCash(ctx); },
  /* ── Upgrader ── */
  /** The stake going in: a low rising launch. */
  upgStart(ctx) {
    launch(ctx);
  },
  /** One graduation past the pointer: a dry tick, pitched up by the dial as it slows. */
  upgTick(ctx) {
    tickVoice(ctx, 0, 0.85);
  },
  /** About to land near an edge: a low swell. */
  upgTense(ctx) {
    hiss(ctx, { type: 'lowpass', f: 180, to: 600, q: 0.8, a: 0.3, d: 0.3, vol: 0.15, send: 0.2 });
    tone(ctx, 70, { to: 110, a: 0.25, d: 0.35, vol: 0.08 });
  },
  /** A hit: coins and bells. */
  upgWin(ctx) {
    cash(ctx, 3);
  },
  /** A miss: the soft fall. */
  upgLose(ctx) {
    CUES.lose(ctx);
  },
  /* ── Roulette ── */
  /** A chip set down on the felt: two quick clacks. */
  rouChip(ctx) {
    chipClack(ctx);
  },
  /** The ball round the wheel: a whoosh, and the ball's ticks spacing out as it slows. */
  rouSpin(ctx) {
    whoosh(ctx, { d: 0.5, up: true, vol: 0.12 });
    let at = 0.12;
    let gap = 0.045;
    for (let i = 0; i < 34 && at < 2.6; i += 1) {
      ball(ctx, Math.max(0.25, 1 - at / 2.6), at);
      at += gap;
      gap *= 1.07;
    }
  },
  /** The ball dropping into its pocket: two bounces and the pocket. */
  rouLand(ctx) {
    ball(ctx, 0.7);
    ball(ctx, 0.5, 0.09);
    hiss(ctx, { t: 0.16, type: 'lowpass', f: 1300, d: 0.07, vol: 0.26, send: 0.1 });
    clink(ctx, 1500, { t: 0.16, vol: 0.04, d: 0.25 });
  },
  /** A win on the table. */
  rouWin(ctx) { CUES.upgWin(ctx); },
  /* ── Limbo ── */
  /** The number climbing: a tick, then a rising whoosh. The caller fits its pitch to the climb. */
  limboRise(ctx) {
    tickVoice(ctx, 7);
    whoosh(ctx, { d: 0.6, up: true, vol: 0.09 });
  },
  limboWin(ctx) { winBells(ctx, 2); },
  limboBig(ctx) { big(ctx); },
  limboLose(ctx) { CUES.lose(ctx); },
  /* ── Chicken ── */
  /** A run starting: the bet going down. */
  chickenStart(ctx) {
    betClack(ctx);
  },
  /** A hop: a soft spring up. */
  chickenHop(ctx) {
    tone(ctx, 380, { to: 820, a: 0.005, d: 0.11, vol: 0.045, type: 'triangle', send: 0.1 });
  },
  /** Landing on a block: a soft thud and the orb. Pitched by the caller, a step up per lane. */
  chickenLand(ctx) {
    hiss(ctx, { type: 'lowpass', f: 520, d: 0.06, vol: 0.15, send: 0 });
    gem(ctx, true);
  },
  /** The minecart coming down its rails: a rising rumble and the wheels on the joints. */
  chickenCart(ctx) {
    hiss(ctx, { type: 'lowpass', f: 200, to: 700, q: 1, a: 0.22, d: 0.18, vol: 0.45, send: 0.1 });
    for (const t of [0.04, 0.12, 0.2, 0.28]) hiss(ctx, { t, type: 'bandpass', f: 1600, q: 5, d: 0.012, vol: 0.12, send: 0 });
  },
  /** The minecart landing: the blast, smaller. */
  chickenCrash(ctx) {
    boom(ctx, 0.6);
  },
  /** After a cash-out, the minecart rolling into view: a soft rumble. */
  chickenReveal(ctx) {
    hiss(ctx, { type: 'lowpass', f: 200, to: 500, q: 1, a: 0.2, d: 0.3, vol: 0.18, send: 0.1 });
  },
  /** Cashed out: coins and bells. */
  chickenCash(ctx) {
    cash(ctx, 3);
  },
  /* ── Crash ── */
  /** The bet going in: the clack. */
  crashBet(ctx) {
    betClack(ctx);
  },
  /** One of the last three seconds: a tick, pitched up by the caller. */
  crashTick(ctx) {
    tickVoice(ctx, 5);
  },
  /** The launch: a low rising roar. */
  crashLaunch(ctx) {
    launch(ctx);
  },
  /** A whole multiplier passed: a small bell, pitched up by the caller as it climbs. */
  crashUp(ctx) {
    bell(ctx, 1046.5 * semi(PENT[2]), { vol: 0.05, d: 0.6, ratio: 2, index: 0.9 });
  },
  /** The bust: the blast. */
  crashBust(ctx) {
    boom(ctx, 0.8);
  },
  /** Cashed out: coins and bells. */
  crashCash(ctx) {
    cash(ctx, 3);
  },
};

/**
 * Plays a cue.
 *
 * `rate` repitches the whole cue: every tone, bell, filter and clip in it (see `pitch` above). The
 * upgrader climbs its ticks this way as the dial slows, and a Mines diamond rings a step higher for
 * every one found.
 *
 * Never throws. An interface that breaks because a sound failed is worse than a silent interface.
 */
export function playSound(name, { rate = 1 } = {}) {
  const cue = CUES[name];
  if (!cue) return;
  const ctx = ensureContext();
  if (!ctx) return;
  pitch = Number.isFinite(rate) && rate > 0 ? rate : 1;
  try {
    cue(ctx);
  } catch {
    /* A failed cue must never take an interaction down with it. */
  } finally {
    pitch = 1;
  }
}

/**
 * Wires the global gesture sounds once.
 *
 * Delegated from the document so controls rendered later still make noise, and only for elements
 * that opted in with data-sfx (a Plinko drop, a Battles chip). Ordinary buttons are silent: the
 * Minecraft click on every press (opening the chat, the menu, a tab) went on 2026-11-21, the owner:
 * "no need for the minecraft sounds every click". The games still sound their own moments.
 */
export function initAudioEngine() {
  if (document.body.dataset.sfx === '1') return;
  document.body.dataset.sfx = '1';

  // Align the legacy player with the remembered preference before anything can play.
  try {
    setLegacyMuted(muted);
  } catch {
    /* optional */
  }

  document.addEventListener(
    'pointerdown',
    (event) => {
      const target = event.target.closest('[data-sfx]');
      if (!target || target.disabled) return;
      playSound(target.dataset.sfx);
    },
    { passive: true },
  );

  document.addEventListener(
    'pointerover',
    (event) => {
      const target = event.target.closest('.btn--go, .cratecard, .cases__n, .cases__quick');
      if (!target || target.disabled) return;
      playSound('hover');
    },
    { passive: true },
  );
}
