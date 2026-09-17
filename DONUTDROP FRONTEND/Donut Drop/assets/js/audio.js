/* audio.js — the real Minecraft sound effects, used sparingly.
 *
 * Only the payoff moment makes noise. No UI click sounds, no ambience: if every
 * button chirped, the one sound that should mean something would not.
 *
 * Browsers block audio until the user has interacted with the page, and every
 * call here originates from a click, so nothing is ever forced on anyone. The
 * mute state persists, and muted is honoured before anything is even decoded.
 */

const FILES = {
  fizz: 'fizz.ogg',              // item burning in lava
  chestopen: 'chestopen.ogg',
  chestclosed: 'chestclosed.ogg',
  orb: 'orb.ogg',                // XP pickup — the payout chime
  levelup: 'levelup.ogg',        // reserved for a genuinely big hit
  click: 'click.ogg',
};
const BASE = 'assets/sound/';
const KEY = 'donutdrop.muted';

const pool = new Map();
let muted = (() => {
  try { return localStorage.getItem(KEY) === '1'; } catch (_) { return false; }
})();

/* Each sound gets a small pool so a rapid re-trigger does not cut itself off. */
function voice(name) {
  if (!FILES[name]) return null;
  let list = pool.get(name);
  if (!list) {
    list = Array.from({ length: 3 }, () => {
      const a = new Audio(BASE + FILES[name]);
      a.preload = 'auto';
      return a;
    });
    pool.set(name, list);
  }
  return list.find((a) => a.paused || a.ended) || list[0];
}

export function play(name, { volume = 0.65, rate = 1 } = {}) {
  if (muted) return;
  const a = voice(name);
  if (!a) return;
  try {
    a.currentTime = 0;
    a.volume = Math.max(0, Math.min(1, volume));
    a.playbackRate = rate;
    // a blocked play() is not an error worth surfacing — the visuals carry it
    a.play().catch(() => {});
  } catch (_) {}
}

/* ─────────── the sub-bass hum ───────────
 *
 * Synthesised rather than loaded. A sub-bass bed is a pure tone with an
 * envelope on it — shipping a .ogg for that would be a download, a decode and a
 * loop-point to get wrong, when twelve lines of WebAudio produce it exactly.
 *
 * Two detuned oscillators an octave apart: the lower one is the weight you feel
 * and the upper one is what makes it audible on a laptop speaker that cannot
 * reproduce 38Hz at all. The lowpass takes the edge off the square harmonics so
 * it reads as pressure rather than as a buzz.
 *
 * The context is created lazily, on a real gesture, so nothing is constructed
 * for a visitor who never opens a case.
 */
let actx = null;
function ctx() {
  if (actx) return actx;
  const C = window.AudioContext || window.webkitAudioContext;
  if (!C) return null;
  try { actx = new C(); } catch (_) { actx = null; }
  return actx;
}

export function hum({ duration = 2.4, freq = 38, volume = 0.5, rise = 0.8 } = {}) {
  if (muted) return () => {};
  const ac = ctx();
  if (!ac) return () => {};
  try {
    if (ac.state === 'suspended') ac.resume().catch(() => {});
    const now = ac.currentTime;
    const out = ac.createGain();
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(220, now);

    const low = ac.createOscillator();
    low.type = 'sine';
    low.frequency.setValueAtTime(freq, now);
    const high = ac.createOscillator();
    high.type = 'triangle';
    high.frequency.setValueAtTime(freq * 2, now);
    const highGain = ac.createGain();
    highGain.gain.setValueAtTime(0.35, now);

    // swell in, hold, fall away — never a hard start, which clicks
    out.gain.setValueAtTime(0.0001, now);
    out.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume), now + rise);
    out.gain.setValueAtTime(Math.max(0.0002, volume), now + duration * 0.7);
    out.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    low.connect(lp);
    high.connect(highGain).connect(lp);
    lp.connect(out).connect(ac.destination);
    low.start(now); high.start(now);
    low.stop(now + duration + 0.05);
    high.stop(now + duration + 0.05);

    // the caller can cut it short if the scene is dismissed early
    return () => {
      try {
        out.gain.cancelScheduledValues(ac.currentTime);
        out.gain.setValueAtTime(out.gain.value, ac.currentTime);
        out.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.18);
        low.stop(ac.currentTime + 0.2); high.stop(ac.currentTime + 0.2);
      } catch (_) {}
    };
  } catch (_) {
    return () => {};
  }
}

/* ─────────── the riser ───────────
 *
 * The sound under a build-up: a tone sweeping upward while a noise bed swells
 * behind it, both cut dead at the drop. Synthesised for the same reason the hum
 * is — it is a frequency ramp, which is three lines of WebAudio and would
 * otherwise be a download, a decode and a loop point to get wrong.
 *
 * The sweep is exponential, not linear. Pitch is perceived logarithmically, so
 * a linear ramp from 110Hz to 1.4kHz sounds like it races up and then stalls;
 * an exponential one climbs at a constant musical rate, which is what makes a
 * riser feel like it is still accelerating right up to the cut.
 *
 * Returns a stop function. Call it ON the drop: a riser that fades out has no
 * drop, and the silence it leaves is half the impact.
 */
export function riser({ duration = 3.2, from = 110, to = 1500, volume = 0.3 } = {}) {
  if (muted) return () => {};
  const ac = ctx();
  if (!ac) return () => {};
  try {
    if (ac.state === 'suspended') ac.resume().catch(() => {});
    const now = ac.currentTime;
    const out = ac.createGain();
    out.gain.setValueAtTime(0.0001, now);
    out.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume), now + duration * 0.92);

    // the sweeping tone
    const osc = ac.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(from, now);
    osc.frequency.exponentialRampToValueAtTime(to, now + duration);
    const oscGain = ac.createGain();
    oscGain.gain.setValueAtTime(0.5, now);

    // a noise bed under it, opening its filter as the tone climbs
    const len = Math.max(1, Math.floor(ac.sampleRate * duration));
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const noise = ac.createBufferSource();
    noise.buffer = buf;
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.setValueAtTime(1.2, now);
    bp.frequency.setValueAtTime(from * 2, now);
    bp.frequency.exponentialRampToValueAtTime(to * 1.6, now + duration);
    const noiseGain = ac.createGain();
    noiseGain.gain.setValueAtTime(0.35, now);

    osc.connect(oscGain).connect(out);
    noise.connect(bp).connect(noiseGain).connect(out);
    out.connect(ac.destination);
    osc.start(now); noise.start(now);
    osc.stop(now + duration + 0.1);
    noise.stop(now + duration + 0.1);

    return () => {
      try {
        const n = ac.currentTime;
        out.gain.cancelScheduledValues(n);
        out.gain.setValueAtTime(out.gain.value, n);
        // 40ms, not a fade: the cut IS the drop
        out.gain.exponentialRampToValueAtTime(0.0001, n + 0.04);
        osc.stop(n + 0.06); noise.stop(n + 0.06);
      } catch (_) {}
    };
  } catch (_) {
    return () => {};
  }
}

/* The BOOM: a short pitched-down thump with a noise transient on the front.
 * This is the impact the riser has been promising, and it has to arrive within
 * a frame of the flash or the two read as separate events. */
export function boom({ volume = 0.6 } = {}) {
  if (muted) return;
  const ac = ctx();
  if (!ac) return;
  try {
    if (ac.state === 'suspended') ac.resume().catch(() => {});
    const now = ac.currentTime;
    const out = ac.createGain();
    out.gain.setValueAtTime(volume, now);
    out.gain.exponentialRampToValueAtTime(0.0001, now + 1.1);

    const osc = ac.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, now);
    osc.frequency.exponentialRampToValueAtTime(36, now + 0.55);

    const len = Math.floor(ac.sampleRate * 0.14);
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const crack = ac.createBufferSource();
    crack.buffer = buf;
    const crackGain = ac.createGain();
    crackGain.gain.setValueAtTime(0.5, now);

    osc.connect(out);
    crack.connect(crackGain).connect(out);
    out.connect(ac.destination);
    osc.start(now); crack.start(now);
    osc.stop(now + 1.2); crack.stop(now + 0.2);
  } catch (_) {}
}

export const isMuted = () => muted;

export function setMuted(v) {
  muted = !!v;
  try { localStorage.setItem(KEY, muted ? '1' : '0'); } catch (_) {}
  if (muted) {
    for (const list of pool.values()) for (const a of list) { try { a.pause(); } catch (_) {} }
    // a synthesised hum is not in the pool, so it is silenced at the context
    if (actx) { try { actx.suspend(); } catch (_) {} }
  } else if (actx) {
    try { actx.resume(); } catch (_) {}
  }
  return muted;
}

/* Warm the files up on the first real interaction so the payoff never lags. */
let warmed = false;
export function warm() {
  if (warmed) return;
  warmed = true;
  Object.keys(FILES).forEach(voice);
}

export function initMuteButton(btn) {
  if (!btn) return;
  const paint = () => {
    btn.dataset.muted = muted ? '1' : '0';
    btn.setAttribute('aria-pressed', String(muted));
    btn.setAttribute('aria-label', muted ? 'Unmute sound' : 'Mute sound');
    btn.title = muted ? 'Sound off' : 'Sound on';
  };
  btn.addEventListener('click', () => { setMuted(!muted); warm(); paint(); });
  paint();
  window.addEventListener('pointerdown', warm, { once: true });
  window.addEventListener('keydown', warm, { once: true });
}
