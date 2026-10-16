/* audio-engine.js — the site's game sounds.
 *
 * Real recordings, not oscillators: chips, cards, coins, impacts and three short jingles from
 * Kenney's CC0 packs (assets/sound/casino, SOURCES.txt). The cues used to be synthesized from
 * square, sawtooth and triangle waves, and they sounded like it -- a beep standing in for a chip.
 *
 * THE RULES THIS FILE KEEPS
 * -------------------------
 * 1. The context is created on the first real gesture, and the samples (about 250 KB) are fetched
 *    then too. Browsers suspend an AudioContext built before a user interaction, and a suspended
 *    context nobody resumes is silence nobody can debug.
 * 2. Nothing plays when the page is muted or the user asked for reduced motion -- the people who do
 *    not want the screen lurching usually do not want it chiming either.
 * 3. Ordinary buttons and hovering make no sound. Sound is for the game: a bet going down, a safe
 *    step, a card, a win, a loss, a payout landing. A site that clicks at every press is noise.
 * 4. Every voice disconnects when it finishes, and only so many play at once: leaked nodes are the
 *    classic way a tab's audio graph grows until the page stutters.
 * 5. A cue never repeats itself exactly. Each picks another take than last time and drifts a few
 *    percent in pitch and level, because the same sample twice in a row is what makes a game sound
 *    cheap by the tenth click.
 */

/* The older sample player in audio.js still drives the crate reveal, reel and cutscene. Both engines
 * answer to one mute control, or muting the site silences half of it and the player has no idea
 * which half. This module owns the control and forwards every change. */
import { setMuted as setLegacyMuted } from './audio.js';

const SAMPLE_BASE = new URL('../sound/casino/', import.meta.url);
const MASTER_GAIN = 0.55;
const MAX_VOICES = 24;
/* A cue asked for before the samples finish loading plays if they arrive this soon, and is dropped
 * otherwise: a sound landing a second after the thing it belonged to is worse than none. */
const LATE_MS = 250;

/**
 * What each cue is made of. A cue is one or more layers played together; a layer picks one take
 * from `takes` at random (never the same one twice running), at `gain`, after `delay` seconds,
 * repitched by `rate` and drifted by `jitter`.
 */
const CUES = {
  /** A bet going down: a chip set on the felt. Starting a round, dropping a ball, opening a crate. */
  click: [{ takes: ['chip-lay-1', 'chip-lay-2', 'chip-lay-3'], gain: 0.9 }],
  /** A safe step: a mines diamond, a tower floor, a chicken lane. Climbs with stepRate(). */
  tick: [{ takes: ['gem-1', 'gem-2', 'gem-3'], gain: 0.42 }],
  /** A card dealt. */
  card: [{ takes: ['card-1', 'card-2', 'card-3'], gain: 0.8, jitter: 0.04 }],
  /** A plinko peg, a crate reel passing an item. Fires often, so it is tiny. */
  reeltick: [{ takes: ['tick-1', 'tick-2'], gain: 0.22, jitter: 0.08 }],
  /** A win: chips pushed across, and a small bright ding over them. */
  win: [
    { takes: ['chips-collide-1', 'chips-collide-2', 'chips-collide-3', 'chips-collide-4'], gain: 0.9 },
    { takes: ['confirm-1'], gain: 0.3, delay: 0.05, jitter: 0 },
  ],
  /** Money landing: a payout, a deposit, a claim. */
  coin: [{ takes: ['chips-stack-1', 'chips-stack-2', 'chips-handle-1'], gain: 0.85 }],
  /** A big win: chips, and a rising phrase of plucked strings. */
  reward: [
    { takes: ['chips-collide-1', 'chips-collide-3', 'chips-collide-4'], gain: 0.9 },
    { takes: ['jingle-win'], gain: 0.55, delay: 0.04, jitter: 0 },
  ],
  /** The biggest hits only, or it stops meaning anything: chips and a climbing steel-drum run. */
  jackpot: [
    { takes: ['chips-stack-1', 'chips-stack-2'], gain: 0.9 },
    { takes: ['jingle-jackpot'], gain: 0.7, delay: 0.05, jitter: 0 },
  ],
  /** A loss: one soft, low thud. Said, not rubbed in. */
  lose: [{ takes: ['thud-1', 'thud-2', 'thud-3'], gain: 0.32, rate: 0.85 }],
  /** The mine, the minecart, the bust that ends a run: a heavy hit with metal in it. */
  slam: [
    { takes: ['hit-1', 'hit-2'], gain: 0.75 },
    { takes: ['crash-1', 'crash-2'], gain: 0.4 },
  ],
  /** The upgrader's strike, a duel's round, joining a faction. */
  anvil: [{ takes: ['anvil-1', 'anvil-2', 'anvil-3'], gain: 0.6 }],
  /** Something good that is not money: a level, a rain claim, a draw. */
  chime: [{ takes: ['confirm-2'], gain: 0.55, jitter: 0.02 }],
  /** A VIP level reached. */
  portal: [{ takes: ['jingle-level'], gain: 0.6, jitter: 0 }],
};

let context = null;
let master = null;
let muted = readMutePreference();
let voices = 0;
let samples = null; // Map(take -> { buffer, offset }) once loaded
let loading = null;
const lastTake = new Map();

const MUTE_KEY = 'donutdrop.muted';

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
    context = new Ctor();
    /* A limiter last in the chain: a win layered over a payout over a tick must never clip, and
     * nothing here should ever be louder than the player's own volume setting expects. */
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.12;
    master = context.createGain();
    master.gain.value = MASTER_GAIN;
    master.connect(limiter);
    limiter.connect(context.destination);
  }
  if (context.state === 'suspended') void context.resume();
  void loadSamples(context);
  return context;
}

/** Where the sound starts: the recordings carry a little silence before the hit, and a chip that
 *  lands 60ms after the click reads as lag. */
function onsetOf(buffer) {
  const data = buffer.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < data.length; i += 1) peak = Math.max(peak, Math.abs(data[i]));
  const floor = peak * 0.03;
  for (let i = 0; i < data.length; i += 1) {
    if (Math.abs(data[i]) > floor) return Math.max(0, i / buffer.sampleRate - 0.004);
  }
  return 0;
}

/** Fetches and decodes every take once. A take that fails is left out; its cue uses the others. */
function loadSamples(ctx) {
  if (loading) return loading;
  const takes = [...new Set(Object.values(CUES).flatMap((layers) => layers.flatMap((layer) => layer.takes)))];
  loading = Promise.all(
    takes.map(async (take) => {
      try {
        const response = await fetch(new URL(`${take}.ogg`, SAMPLE_BASE));
        if (!response.ok) return null;
        const buffer = await ctx.decodeAudioData(await response.arrayBuffer());
        return [take, { buffer, offset: onsetOf(buffer) }];
      } catch {
        return null;
      }
    }),
  ).then((entries) => {
    samples = new Map(entries.filter(Boolean));
    return samples;
  });
  return loading;
}

function pickTake(layerKey, takes) {
  const ready = takes.filter((take) => samples?.has(take));
  if (!ready.length) return null;
  if (ready.length === 1) return ready[0];
  const previous = lastTake.get(layerKey);
  const choices = ready.filter((take) => take !== previous);
  const take = choices[Math.floor(Math.random() * choices.length)];
  lastTake.set(layerKey, take);
  return take;
}

function voice(ctx, name, rate) {
  CUES[name].forEach((layer, index) => {
    if (voices >= MAX_VOICES) return;
    const take = pickTake(`${name}:${index}`, layer.takes);
    if (!take) return;
    const { buffer, offset } = samples.get(take);
    const jitter = layer.jitter ?? 0.03;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate * (layer.rate ?? 1) * (1 + (Math.random() * 2 - 1) * jitter);
    const amp = ctx.createGain();
    amp.gain.value = layer.gain * (1 - Math.random() * 0.08);
    source.connect(amp);
    amp.connect(master);
    voices += 1;
    // Release the nodes once the voice is done, or the graph grows for the life of the tab.
    source.onended = () => {
      voices -= 1;
      source.disconnect();
      amp.disconnect();
    };
    source.start(ctx.currentTime + (layer.delay ?? 0), offset);
  });
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
    master.gain.setValueAtTime(MASTER_GAIN, context.currentTime);
  }
  return muted;
}

export function toggleMuted() {
  return setMuted(!muted);
}

/**
 * How much higher the n-th safe step sounds than the first: a little each time, so a run climbs
 * as it gets riskier, and capped so a long run never squeaks.
 */
export function stepRate(step) {
  return 1 + Math.min(Math.max(Number(step) || 0, 0), 16) * 0.035;
}

/**
 * Plays a cue. `rate` repitches the whole cue (a safe step climbs with stepRate()).
 *
 * Never throws. An interface that breaks because a sound failed is worse than a silent interface.
 */
export function playSound(name, { rate = 1 } = {}) {
  if (!CUES[name]) return;
  try {
    const ctx = ensureContext();
    if (!ctx) return;
    if (samples) {
      voice(ctx, name, rate);
      return;
    }
    const asked = performance.now();
    void loadSamples(ctx).then(() => {
      if (performance.now() - asked <= LATE_MS && !muted) voice(ctx, name, rate);
    });
  } catch {
    /* A failed cue must never take an interaction down with it. */
  }
}

/**
 * Unlocks audio on the first gesture and starts loading the samples, so the first real cue -- often
 * played after a server answer, outside any gesture -- has a running context and its sound ready.
 * Plays nothing itself: ordinary presses and hovering are silent (rule 3).
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

  const unlock = () => {
    if (!ensureContext()) return;
    document.removeEventListener('pointerdown', unlock, true);
    document.removeEventListener('keydown', unlock, true);
  };
  document.addEventListener('pointerdown', unlock, { capture: true, passive: true });
  document.addEventListener('keydown', unlock, { capture: true, passive: true });
}
