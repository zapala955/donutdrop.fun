/* audio-engine.js — synthesized interface sound.
 *
 * Every cue is generated from oscillators and noise at call time. No sample files: a dozen short
 * clips is a dozen network requests and a megabyte of payload for sounds that are, in the end,
 * a few sine waves and an envelope.
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
const MASTER_GAIN = 0.22;

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
    context = new Ctor();
    master = context.createGain();
    master.gain.value = masterGain();
    master.connect(context.destination);
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

/**
 * One tone with an exponential decay.
 *
 * Exponential rather than linear because a linear fade on a short note reads as a click at the
 * end — the amplitude hits zero while the waveform is still mid-cycle.
 */
function tone(ctx, { freq, type = 'sine', start = 0, duration = 0.18, gain = 0.5, sweepTo = null }) {
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  const at = ctx.currentTime + start;

  osc.type = type;
  osc.frequency.setValueAtTime(freq, at);
  if (sweepTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1, sweepTo), at + duration);

  amp.gain.setValueAtTime(0.0001, at);
  amp.gain.exponentialRampToValueAtTime(gain, at + 0.008);
  amp.gain.exponentialRampToValueAtTime(0.0001, at + duration);

  osc.connect(amp);
  amp.connect(master);
  osc.start(at);
  osc.stop(at + duration + 0.02);
  // Release the nodes once the voice is done, or the graph grows for the life of the tab.
  osc.onended = () => {
    osc.disconnect();
    amp.disconnect();
  };
}

/** Filtered white noise — the transient that makes a clang sound like metal rather than a beep. */
function noise(ctx, { start = 0, duration = 0.12, gain = 0.25, frequency = 2200, q = 0.8 }) {
  const frames = Math.max(1, Math.floor(ctx.sampleRate * duration));
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const channel = buffer.getChannelData(0);
  for (let index = 0; index < frames; index += 1) {
    // Decaying noise: full energy at the transient, gone by the end of the window.
    channel[index] = (Math.random() * 2 - 1) * (1 - index / frames);
  }

  const source = ctx.createBufferSource();
  source.buffer = buffer;

  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = frequency;
  filter.Q.value = q;

  const amp = ctx.createGain();
  const at = ctx.currentTime + start;
  amp.gain.setValueAtTime(gain, at);
  amp.gain.exponentialRampToValueAtTime(0.0001, at + duration);

  source.connect(filter);
  filter.connect(amp);
  amp.connect(master);
  source.start(at);
  source.onended = () => {
    source.disconnect();
    filter.disconnect();
    amp.disconnect();
  };
}

/* The cue library. Each one is a tiny arrangement rather than a single beep, because a lone sine
 * reads as a system error and a two-voice cluster reads as an object. */
const CUES = {
  /** Soft tick for any ordinary press. Quiet on purpose: it fires constantly. */
  click(ctx) {
    tone(ctx, { freq: 660, type: 'triangle', duration: 0.05, gain: 0.16 });
  },
  /** Hovering a live control. Almost subliminal. */
  hover(ctx) {
    tone(ctx, { freq: 880, type: 'sine', duration: 0.035, gain: 0.05 });
  },
  /** Anvil: a broadband strike over two detuned partials. */
  anvil(ctx) {
    noise(ctx, { duration: 0.16, gain: 0.34, frequency: 3200, q: 0.6 });
    tone(ctx, { freq: 320, type: 'square', duration: 0.2, gain: 0.22, sweepTo: 190 });
    tone(ctx, { freq: 484, type: 'triangle', duration: 0.26, gain: 0.14, sweepTo: 300 });
  },
  /** Coins: four quick descending pings with a little randomness in the spacing. */
  coin(ctx) {
    [0, 0.045, 0.085, 0.13].forEach((offset, index) => {
      tone(ctx, {
        freq: 1180 - index * 90,
        type: 'triangle',
        start: offset,
        duration: 0.13,
        gain: 0.2 - index * 0.03,
      });
    });
  },
  /** Portal: a low sweep under a slow beat between two close partials. */
  portal(ctx) {
    tone(ctx, { freq: 90, type: 'sine', duration: 1.1, gain: 0.24, sweepTo: 210 });
    tone(ctx, { freq: 136, type: 'sine', duration: 1.1, gain: 0.12, sweepTo: 272 });
    tone(ctx, { freq: 139, type: 'sine', duration: 1.1, gain: 0.1, sweepTo: 276 });
  },
  /** Win: a major triad, arpeggiated upward. */
  win(ctx) {
    [523.25, 659.25, 783.99, 1046.5].forEach((freq, index) => {
      tone(ctx, { freq, type: 'triangle', start: index * 0.06, duration: 0.32, gain: 0.26 });
    });
    noise(ctx, { start: 0.02, duration: 0.3, gain: 0.1, frequency: 5200, q: 0.5 });
  },
  /** Loss: one falling minor third. Short, not punishing. */
  lose(ctx) {
    tone(ctx, { freq: 300, type: 'sawtooth', duration: 0.3, gain: 0.16, sweepTo: 150 });
    tone(ctx, { freq: 252, type: 'sine', start: 0.05, duration: 0.3, gain: 0.1, sweepTo: 126 });
  },
  /** Reward claimed: coins with a bright cap on top. */
  reward(ctx) {
    CUES.coin(ctx);
    tone(ctx, { freq: 1318.5, type: 'sine', start: 0.14, duration: 0.36, gain: 0.2 });
  },
  /** The upgrader wheel ticking past a graduation. Pitched by caller. */
  tick(ctx) {
    tone(ctx, { freq: 1400, type: 'square', duration: 0.02, gain: 0.07 });
  },
  /* ── the high-dopamine set ──
   * Four cues the platform's loudest moments were missing. Each one is an arrangement rather than a
   * beep, because a lone sine reads as a system error and a two-voice cluster reads as an object.
   */
  /** A heavy anvil hit with a sub-bass drop under it. The big-multiplier upgrader win. */
  slam(ctx) {
    noise(ctx, { duration: 0.09, gain: 0.34, frequency: 2600, q: 0.7 });
    tone(ctx, { freq: 196, type: 'square', duration: 0.13, gain: 0.26, sweepTo: 88 });
    // The drop: an octave below anything else on the site, and the reason this cue is felt.
    tone(ctx, { freq: 58, type: 'sine', start: 0.04, duration: 0.9, gain: 0.42, sweepTo: 28 });
    tone(ctx, { freq: 87, type: 'sine', start: 0.04, duration: 0.7, gain: 0.18, sweepTo: 42 });
  },
  /** One click of a crate reel. Pitched by the caller as the reel slows. */
  reeltick(ctx) {
    tone(ctx, { freq: 2100, type: 'square', duration: 0.014, gain: 0.05 });
    noise(ctx, { duration: 0.02, gain: 0.05, frequency: 5200, q: 2.4 });
  },
  /** Coins breaking apart. A kill, or a big orb going in. */
  shatter(ctx) {
    noise(ctx, { duration: 0.22, gain: 0.16, frequency: 3400, q: 0.5 });
    [1568, 2093, 2637].forEach((freq, index) => {
      tone(ctx, { freq, type: 'triangle', start: index * 0.018, duration: 0.16, gain: 0.12 });
    });
    tone(ctx, { freq: 140, type: 'sine', duration: 0.24, gain: 0.16, sweepTo: 70 });
  },
  /** A bright portal chime. Level-up, and the lava rain claim. */
  chime(ctx) {
    [1318.5, 1760, 2637].forEach((freq, index) => {
      tone(ctx, { freq, type: 'sine', start: index * 0.05, duration: 0.55, gain: 0.2 });
    });
    tone(ctx, { freq: 659.25, type: 'triangle', duration: 0.6, gain: 0.12, sweepTo: 1318.5 });
  },

  /* ── the arena ──
   * Three cues for a mode where the player is looking at the floor, not at the interface, and has
   * to be told what happened without reading anything.
   */
  /** Boost: a short rising whoosh under a filtered hiss. Fires on press, never on hold. */
  boost(ctx) {
    tone(ctx, { freq: 150, type: 'sawtooth', duration: 0.18, gain: 0.12, sweepTo: 520 });
    noise(ctx, { duration: 0.16, gain: 0.07, frequency: 1800, q: 0.6 });
  },
  /** Orb absorbed. Deliberately tiny: it fires several times a second at speed. */
  absorb(ctx) {
    tone(ctx, { freq: 880, type: 'sine', duration: 0.05, gain: 0.08, sweepTo: 1320 });
  },
  /** Something died nearby and the floor lit up. A low thud with a bright tail of coins. */
  spill(ctx) {
    tone(ctx, { freq: 80, type: 'sine', duration: 0.5, gain: 0.26, sweepTo: 40 });
    noise(ctx, { start: 0.01, duration: 0.35, gain: 0.14, frequency: 900, q: 0.4 });
    [1046.5, 1318.5].forEach((freq, index) => {
      tone(ctx, { freq, type: 'triangle', start: 0.09 + index * 0.06, duration: 0.24, gain: 0.14 });
    });
  },
  /* ── the lake ── */
  /** A line whipped out over the water: a quick rising swish. */
  cast(ctx) {
    noise(ctx, { duration: 0.18, gain: 0.1, frequency: 3200, q: 1.2 });
    tone(ctx, { freq: 400, type: 'sine', duration: 0.15, gain: 0.05, sweepTo: 900 });
  },
  /** Water: the bobber landing, a fish taking it. Low filtered noise with a bright spray on top. */
  splash(ctx) {
    noise(ctx, { duration: 0.28, gain: 0.22, frequency: 900, q: 0.5 });
    noise(ctx, { start: 0.03, duration: 0.2, gain: 0.12, frequency: 2400, q: 0.7 });
    tone(ctx, { freq: 180, type: 'sine', duration: 0.18, gain: 0.12, sweepTo: 90 });
  },
  /** Thunder far off: a long low rumble under the storm. */
  thunder(ctx) {
    noise(ctx, { duration: 1.6, gain: 0.3, frequency: 120, q: 0.4 });
    noise(ctx, { start: 0.1, duration: 1.2, gain: 0.18, frequency: 260, q: 0.5 });
    tone(ctx, { freq: 48, type: 'sine', duration: 1.4, gain: 0.25, sweepTo: 30 });
  },
  /* ── the mine ── */
  /** A pickaxe on stone: a dry knock, a gritty top and a dull body. Pitched by caller per crack. */
  dig(ctx) {
    noise(ctx, { duration: 0.07, gain: 0.16, frequency: 1500, q: 1.1 });
    noise(ctx, { duration: 0.04, gain: 0.06, frequency: 4200, q: 1.4 });
    tone(ctx, { freq: 210, type: 'triangle', duration: 0.07, gain: 0.08, sweepTo: 140 });
  },
  /** TNT lit: a thin, bright hiss that runs on under the fuse. */
  fuse(ctx) {
    noise(ctx, { duration: 0.9, gain: 0.09, frequency: 5200, q: 0.9 });
    noise(ctx, { start: 0.02, duration: 0.7, gain: 0.05, frequency: 2600, q: 1.2 });
  },
  /** TNT going off: a hard crack over a long low roar, and the sub-bass under it. */
  explode(ctx) {
    noise(ctx, { duration: 0.12, gain: 0.32, frequency: 1800, q: 0.5 });
    noise(ctx, { duration: 1.1, gain: 0.34, frequency: 160, q: 0.35 });
    noise(ctx, { start: 0.04, duration: 0.6, gain: 0.16, frequency: 600, q: 0.6 });
    tone(ctx, { freq: 70, type: 'sine', duration: 0.9, gain: 0.3, sweepTo: 28 });
  },
  /** Something enormous landed. Used sparingly or it stops meaning anything. */
  jackpot(ctx) {
    CUES.anvil(ctx);
    [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((freq, index) => {
      tone(ctx, { freq, type: 'triangle', start: 0.1 + index * 0.075, duration: 0.6, gain: 0.24 });
    });
    tone(ctx, { freq: 65, type: 'sine', start: 0.1, duration: 1.2, gain: 0.3 });
  },

  /* ── Plinko's flat board ──
   * A peg tap that fires a dozen times a ball, so it is the quietest thing here, and a landing in
   * four sizes, so the ear knows how a ball did before the eye finds its slot.
   */
  /** A ball leaving the hand: a short rising pop. */
  plinkoDrop(ctx) {
    tone(ctx, { freq: 420, type: 'triangle', duration: 0.07, gain: 0.13, sweepTo: 760 });
    noise(ctx, { duration: 0.03, gain: 0.03, frequency: 3000, q: 1.2 });
  },
  /** A ball on a peg: a small glassy tap. Pitched by the caller, higher as the ball falls. */
  pegtap(ctx) {
    tone(ctx, { freq: 1180, type: 'sine', duration: 0.05, gain: 0.07 });
    tone(ctx, { freq: 2360, type: 'triangle', duration: 0.022, gain: 0.022 });
  },
  /** Into a slot that pays back less than the ball cost: a soft, low knock. */
  plinkoLow(ctx) {
    tone(ctx, { freq: 300, type: 'triangle', duration: 0.12, gain: 0.12, sweepTo: 220 });
    noise(ctx, { duration: 0.05, gain: 0.035, frequency: 1300, q: 1 });
  },
  /** About even (1x to 2x): two quick notes going up. */
  plinkoEven(ctx) {
    tone(ctx, { freq: 659.25, type: 'triangle', duration: 0.12, gain: 0.13 });
    tone(ctx, { freq: 987.77, type: 'triangle', start: 0.05, duration: 0.16, gain: 0.11 });
  },
  /** A real win (2x and up): three bright notes with a glint on top. */
  plinkoWin(ctx) {
    [783.99, 987.77, 1318.5].forEach((freq, index) => {
      tone(ctx, { freq, type: 'triangle', start: index * 0.05, duration: 0.24, gain: 0.16 });
    });
    noise(ctx, { start: 0.09, duration: 0.18, gain: 0.05, frequency: 6200, q: 0.8 });
  },
  /** 10x and up: a longer run of notes over a low swell. 100x and up is the jackpot. */
  plinkoBig(ctx) {
    [523.25, 783.99, 1046.5, 1318.5, 1567.98].forEach((freq, index) => {
      tone(ctx, { freq, type: 'triangle', start: index * 0.06, duration: 0.42, gain: 0.17 });
    });
    tone(ctx, { freq: 130.81, type: 'sine', duration: 0.6, gain: 0.2, sweepTo: 196 });
    noise(ctx, { start: 0.1, duration: 0.4, gain: 0.06, frequency: 5600, q: 0.6 });
  },

  /* ── Dice ──
   * The line ticks as it is dragged, the roll rattles out, and the landing says win or miss.
   */
  /** The line moving one point: a dry, tiny click. Pitched by the caller with where the line is. */
  diceTick(ctx) {
    tone(ctx, { freq: 1700, type: 'triangle', duration: 0.014, gain: 0.035 });
    noise(ctx, { duration: 0.012, gain: 0.018, frequency: 4200, q: 2 });
  },
  /** The roll going out: three quick knocks, a die shaken in a cup. */
  diceRoll(ctx) {
    [0, 0.05, 0.11].forEach((start, index) => {
      noise(ctx, { start, duration: 0.032, gain: 0.08 - index * 0.018, frequency: 2600 - index * 320, q: 1.6 });
      tone(ctx, { freq: 540 + index * 110, type: 'triangle', start, duration: 0.035, gain: 0.06 });
    });
  },
  /** A win: two bright notes going up, with a glint. */
  diceWin(ctx) {
    tone(ctx, { freq: 880, type: 'triangle', duration: 0.12, gain: 0.14 });
    tone(ctx, { freq: 1318.5, type: 'triangle', start: 0.065, duration: 0.24, gain: 0.13 });
    noise(ctx, { start: 0.065, duration: 0.12, gain: 0.03, frequency: 6400, q: 0.8 });
  },
  /** 10x and up: a run of four notes over a low swell. */
  diceBig(ctx) {
    [659.25, 880, 1108.73, 1318.5].forEach((freq, index) => {
      tone(ctx, { freq, type: 'triangle', start: index * 0.055, duration: 0.36, gain: 0.15 });
    });
    tone(ctx, { freq: 164.81, type: 'sine', duration: 0.5, gain: 0.16, sweepTo: 246.94 });
    noise(ctx, { start: 0.12, duration: 0.3, gain: 0.05, frequency: 5800, q: 0.6 });
  },
  /** A miss: a soft, low knock, never a buzzer. */
  diceLose(ctx) {
    tone(ctx, { freq: 250, type: 'triangle', duration: 0.13, gain: 0.11, sweepTo: 175 });
    noise(ctx, { duration: 0.05, gain: 0.03, frequency: 900, q: 1 });
  },

  /* ── Tower ──
   * A tap as a tile is chosen, a gem that rings higher the higher the floor, a lift as the next
   * floor wakes, a short blast for TNT, the rest of the tower ticking over, and the cash-out.
   */
  /** A tile chosen: a soft, wooden press. */
  towerTap(ctx) {
    tone(ctx, { freq: 620, type: 'triangle', duration: 0.045, gain: 0.07, sweepTo: 480 });
    noise(ctx, { duration: 0.02, gain: 0.025, frequency: 2600, q: 1.4 });
  },
  /** A climb starting: two notes going up. */
  towerStart(ctx) {
    tone(ctx, { freq: 523.25, type: 'triangle', duration: 0.1, gain: 0.11 });
    tone(ctx, { freq: 783.99, type: 'triangle', start: 0.07, duration: 0.16, gain: 0.1 });
  },
  /** A gem: a glassy ring with a glint. Pitched by the caller, a step up for every floor. */
  towerGem(ctx) {
    tone(ctx, { freq: 1046.5, type: 'sine', duration: 0.22, gain: 0.12 });
    tone(ctx, { freq: 1568, type: 'triangle', start: 0.035, duration: 0.18, gain: 0.07 });
    noise(ctx, { start: 0.02, duration: 0.08, gain: 0.025, frequency: 7000, q: 0.9 });
  },
  /** The next floor waking: a short rise. */
  towerClimb(ctx) {
    tone(ctx, { freq: 330, type: 'sine', duration: 0.14, gain: 0.05, sweepTo: 660 });
  },
  /** TNT: a hard crack and a short low boom, not the long roar of the mine. */
  towerBoom(ctx) {
    noise(ctx, { duration: 0.08, gain: 0.28, frequency: 1700, q: 0.6 });
    noise(ctx, { duration: 0.45, gain: 0.24, frequency: 190, q: 0.4 });
    tone(ctx, { freq: 90, type: 'sine', duration: 0.4, gain: 0.24, sweepTo: 38 });
  },
  /** The rest of the tower turning over: a tiny tick per floor, pitched up by the caller. */
  towerReveal(ctx) {
    tone(ctx, { freq: 760, type: 'sine', duration: 0.035, gain: 0.03 });
  },
  /** Cashed out: a quick run of four notes and a shimmer. */
  towerCash(ctx) {
    [783.99, 987.77, 1174.66, 1567.98].forEach((freq, index) => {
      tone(ctx, { freq, type: 'triangle', start: index * 0.055, duration: 0.3, gain: 0.14 });
    });
    noise(ctx, { start: 0.12, duration: 0.3, gain: 0.05, frequency: 6200, q: 0.7 });
    tone(ctx, { freq: 196, type: 'sine', duration: 0.4, gain: 0.12, sweepTo: 262 });
  },

  /* ── Mines ──
   * The same language as the Tower's, so a pick, a find and a blast sound alike across the two: a
   * tap as a tile is chosen, a diamond that rings a step higher for every one found, a short blast,
   * the field ticking over in rings, and the cash-out.
   */
  /** A tile chosen: a soft press, a touch brighter than the Tower's. */
  minesTap(ctx) {
    tone(ctx, { freq: 700, type: 'triangle', duration: 0.04, gain: 0.07, sweepTo: 540 });
    noise(ctx, { duration: 0.02, gain: 0.025, frequency: 2900, q: 1.4 });
  },
  /** A game starting: two notes going up. */
  minesStart(ctx) { CUES.towerStart(ctx); },
  /** A diamond: a bright crystal ping with a glint. Pitched by the caller, a step up per diamond. */
  minesGem(ctx) {
    tone(ctx, { freq: 1174.66, type: 'sine', duration: 0.2, gain: 0.12 });
    tone(ctx, { freq: 1760, type: 'triangle', start: 0.03, duration: 0.16, gain: 0.07 });
    noise(ctx, { start: 0.015, duration: 0.07, gain: 0.025, frequency: 7400, q: 0.9 });
  },
  /** TNT: a hard crack and a short low boom. */
  minesBoom(ctx) { CUES.towerBoom(ctx); },
  /** The rest of the field turning over: a tiny tick per ring, pitched up by the caller. */
  minesReveal(ctx) { CUES.towerReveal(ctx); },
  /** Cashed out: a quick run of notes and a shimmer. */
  minesCash(ctx) { CUES.towerCash(ctx); },

  /* ── Upgrader ──
   * A rise as the stake goes in, a ratchet click for every graduation that passes the pointer
   * (pitched up by the dial as it slows), a low swell when it is about to land on an edge, and the
   * landing: a bright chord for a hit, a soft knock for a miss.
   */
  /** The stake going in: a short rising sweep with a click on top. */
  upgStart(ctx) {
    tone(ctx, { freq: 260, type: 'triangle', duration: 0.18, gain: 0.08, sweepTo: 620 });
    noise(ctx, { duration: 0.03, gain: 0.04, frequency: 3200, q: 1.3 });
  },
  /** One graduation past the pointer: a dry, short tick. */
  upgTick(ctx) {
    tone(ctx, { freq: 1500, type: 'triangle', duration: 0.016, gain: 0.04 });
    noise(ctx, { duration: 0.012, gain: 0.02, frequency: 4600, q: 2 });
  },
  /** About to land near an edge: a low swell under the ticks. */
  upgTense(ctx) {
    tone(ctx, { freq: 110, type: 'sine', duration: 0.9, gain: 0.12, sweepTo: 165 });
  },
  /** A hit: a bright chord going up, with a shimmer. */
  upgWin(ctx) {
    [659.25, 830.61, 987.77, 1318.5].forEach((freq, index) => {
      tone(ctx, { freq, type: 'triangle', start: index * 0.05, duration: 0.32, gain: 0.14 });
    });
    noise(ctx, { start: 0.1, duration: 0.26, gain: 0.045, frequency: 6400, q: 0.7 });
  },
  /** A miss: a soft, low knock, never a buzzer. */
  upgLose(ctx) {
    tone(ctx, { freq: 230, type: 'triangle', duration: 0.16, gain: 0.12, sweepTo: 150 });
    noise(ctx, { duration: 0.05, gain: 0.03, frequency: 850, q: 1 });
  },

  /* ── Roulette ──
   * A chip clacking onto the felt, the ball rattling round a slowing wheel, the drop into the
   * pocket, and a win.
   */
  /** A clay chip set down on the felt: two quick, dry clacks. */
  rouChip(ctx) {
    noise(ctx, { duration: 0.025, gain: 0.09, frequency: 3400, q: 1.8 });
    tone(ctx, { freq: 1250, type: 'triangle', duration: 0.03, gain: 0.05 });
    noise(ctx, { start: 0.035, duration: 0.02, gain: 0.05, frequency: 3900, q: 2 });
  },
  /** The ball round the wheel: a soft whoosh, and a rattle of ticks that spaces out as it slows. */
  rouSpin(ctx) {
    noise(ctx, { duration: 0.6, gain: 0.05, frequency: 900, q: 0.6 });
    let at = 0.12;
    let gap = 0.045;
    for (let i = 0; i < 34 && at < 2.6; i += 1) {
      tone(ctx, { freq: 2100 - i * 18, type: 'triangle', start: at, duration: 0.012, gain: 0.018 + i * 0.0007 });
      at += gap;
      gap *= 1.07;
    }
  },
  /** The ball dropping into its pocket: a couple of bounces and a clack. */
  rouLand(ctx) {
    tone(ctx, { freq: 1500, type: 'triangle', duration: 0.02, gain: 0.05 });
    tone(ctx, { freq: 1300, type: 'triangle', start: 0.07, duration: 0.02, gain: 0.04 });
    noise(ctx, { start: 0.12, duration: 0.05, gain: 0.08, frequency: 2600, q: 1.4 });
    tone(ctx, { freq: 420, type: 'sine', start: 0.12, duration: 0.09, gain: 0.07, sweepTo: 300 });
  },
  /** A win on the table: a bright run of notes. */
  rouWin(ctx) { CUES.upgWin(ctx); },
};

/**
 * Plays a cue.
 *
 * `rate` repitches the whole cue — the upgrader uses it to climb the wheel ticks as a spin slows,
 * so the same twenty-millisecond click carries tension without a second sound.
 *
 * Never throws. An interface that breaks because a sound failed is worse than a silent interface.
 */
export function playSound(name, { rate = 1 } = {}) {
  const cue = CUES[name];
  if (!cue) return;
  const ctx = ensureContext();
  if (!ctx) return;
  try {
    if (rate === 1) {
      cue(ctx);
      return;
    }
    // Repitching is applied by temporarily wrapping tone() frequencies through the master detune;
    // simplest correct approach is to call the cue with a scaled frequency table.
    const original = context.createOscillator;
    context.createOscillator = function createScaledOscillator() {
      const osc = original.call(this);
      const setValueAtTime = osc.frequency.setValueAtTime.bind(osc.frequency);
      osc.frequency.setValueAtTime = (value, when) => setValueAtTime(value * rate, when);
      const rampTo = osc.frequency.exponentialRampToValueAtTime.bind(osc.frequency);
      osc.frequency.exponentialRampToValueAtTime = (value, when) => rampTo(value * rate, when);
      return osc;
    };
    try {
      cue(ctx);
    } finally {
      context.createOscillator = original;
    }
  } catch {
    /* A failed cue must never take an interaction down with it. */
  }
}

/**
 * Wires the global gesture sounds once.
 *
 * Delegated from the document so controls rendered later still make noise, and scoped to elements
 * that opted in with data-sfx plus the ordinary buttons, so scrolling a list of links is silent.
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
      const target = event.target.closest('button, .btn, [data-sfx]');
      if (!target || target.disabled) return;
      playSound(target.dataset.sfx || 'click');
    },
    { passive: true },
  );

  document.addEventListener(
    'pointerover',
    (event) => {
      const target = event.target.closest('.btn--go, .cratecard, .qty__b, .quick');
      if (!target || target.disabled) return;
      playSound('hover');
    },
    { passive: true },
  );
}
