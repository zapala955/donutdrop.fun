/* cutscene.js — the case-opening film.
 *
 * This is NOT the upgrader reveal. There is no ender chest in it, on purpose.
 * The upgrader's story is "your winnings get banked", so that shot has a vault
 * and the prize flies into it. A case opening has no vault: the case is already
 * gone by the time this plays, and the only thing that matters is the object
 * you just pulled. So the set is a void, and the film is about one object in
 * it, shot the way a product launch shoots a phone.
 *
 * WHAT MAKES IT READ AS 3D
 * ------------------------
 * Nothing here is 3D, and that is deliberate: every WebGL scene this project
 * shipped measured between 9 and 18fps, because the cost was never geometry but
 * fill. Three flat tricks do the whole job at 0.1ms a frame:
 *
 *   camera      a transform around the subject — pan, dolly, roll. Shots cut
 *               and sweep between keyframed camera states, which is where
 *               "multiple angles" comes from.
 *   orientation a flat sprite turned on three axes: yaw as scaleX(cos), pitch
 *               as scaleY(cos), roll as rotate. A pixel sprite tumbling on all
 *               three reads as a solid object turning in space.
 *   parallax    fog and dust move at a fraction of camera speed, so the void
 *               has depth the subject can travel through.
 *
 * THE SHOT LIST
 * -------------
 * Keyframed, declared once in SHOTS, and the camera is interpolated between
 * them. Changing the film is changing that table — no beat reaches into
 * another's business, which is the failure that made the first version of the
 * upgrader reveal open its lid while the chest was still flying in.
 */
import { RARITY } from './data.js';
import { $, el, money, reduceMotion } from './util.js';
import { play, hum, riser, boom } from './audio.js';
import {
  clamp01, span, mix, easeOut, EASE,
  blit, tint, radial, makeCone, makeFog, pool, img, trail, deviolet,
} from './fx.js';

/* WHICH PULLS EARN THE FILM
 *
 * Not rarity — profit. A Legendary out of the End Crate can pay less than the
 * crate cost, and a Rare out of the Starter Crate can pay eighty times it. The
 * player does not experience a rarity tier; they experience the number going up
 * by a lot, relative to what they just spent. So that is what the trigger reads.
 *
 * JACKPOT_X is the multiple of the crate price at which the cinematic fires.
 * Eight is chosen so it stays genuinely uncommon: across the five published
 * pools it lands on roughly the top few percent of outcomes, which is the point
 * — a cinematic everybody sees is a loading screen.
 *
 * A pull with no crate behind it (the upgrader's bonus item, say) has no price
 * to measure against, so it falls back to the rarity tiers. */
const JACKPOT_X = 8;
const CINEMATIC = new Set(['rare', 'epic', 'legendary']);

/**
 * Does this pull earn the jackpot cinematic?
 * @param {object} item  the item drawn
 * @param {object} [crate]  the crate it came out of, if any
 */
export function isJackpot(item, crate) {
  if (crate && crate.price > 0) return item.value / crate.price >= JACKPOT_X;
  return CINEMATIC.has(item.rarity);
}

/** How many times its own price the crate just paid back. */
export function profitMultiple(item, crate) {
  if (!crate || !crate.price) return 0;
  return item.value / crate.price;
}

/* ─────────── the shot list ───────────
 * Each shot is a camera state held at its start, eased into over its window.
 * Camera space is normalised: x and y are fractions of the stage, zoom is a
 * multiplier on the subject, roll is radians. The subject's own orientation is
 * keyframed alongside so a camera move and a tumble can be composed.
 */
const SHOTS = [
  {
    name: 'plunge', at: [0.00, 1.10], ease: EASE.glide,
    cam:  { x: 0.00, y: 0.06, zoom: 0.50, roll: -0.08 },
    item: { yaw: 2.4, pitch: 0.45, roll: -0.30, lift: 1.10, glow: 0.00 },
    note: 'the room goes out; mist closes; something is in there',
  },
  {
    name: 'shroud', at: [1.10, 3.40], ease: EASE.glide,
    cam:  { x: 0.02, y: 0.01, zoom: 0.78, roll: -0.03 },
    item: { yaw: 1.1, pitch: 0.16, roll: -0.10, lift: 0.34, glow: 0.10 },
    note: 'THE LONG ONE — silhouettes shift in the mist and none of them is it',
  },
  {
    name: 'riser', at: [3.40, 5.20], ease: EASE.camIn,
    cam:  { x: 0.00, y: -0.02, zoom: 1.02, roll: 0.00 },
    item: { yaw: 0.5, pitch: 0.06, roll: -0.03, lift: 0.10, glow: 0.26 },
    note: 'pulse quickens, mist tightens, the sound climbs',
  },
  {
    name: 'apex', at: [5.20, 5.85], ease: EASE.settle,
    cam:  { x: 0.00, y: 0.00, zoom: 1.14, roll: 0.00 },
    item: { yaw: 0.0, pitch: 0.00, roll: 0.00, lift: 0.02, glow: 0.30 },
    note: 'DEAD STOP. Everything holds. This silence is the whole trick.',
  },
  {
    name: 'boom', at: [5.85, 6.35], ease: EASE.settle,
    cam:  { x: 0.00, y: 0.00, zoom: 1.42, roll: 0.00 },
    item: { yaw: 0.0, pitch: 0.00, roll: 0.00, lift: 0.00, glow: 1.00 },
    note: 'flash, shockwave, razor-sharp',
  },
  {
    name: 'hold', at: [6.35, 7.40], ease: EASE.settle,
    cam:  { x: 0.00, y: 0.00, zoom: 1.38, roll: 0.00 },
    item: { yaw: 0.0, pitch: 0.00, roll: 0.00, lift: 0.00, glow: 1.00 },
    note: 'it hovers while the fireworks come down',
  },
];

/* THE SUSPENSE MODEL
 * ------------------
 * The old cut opened on the item already visible and spent five seconds moving
 * a camera around it. That is a presentation, not a reveal: by second one you
 * knew what you had, so the remaining four were decoration.
 *
 * This one withholds. For the whole `shroud` beat — the longest in the film —
 * the subject is a SILHOUETTE in mist, and it is not always the silhouette of
 * what you actually won. It cross-fades between candidates drawn from the same
 * crate pool, each one a flat black-and-rose shape with no readable detail, so
 * the shape you are looking at keeps almost resolving into something and then
 * becoming something else.
 *
 * That is the "omg what did I pull" mechanic, and it is honest: every shape
 * shown is a real item from the pool you actually opened, so it never implies
 * odds that were not there. It only withholds which one, which the reveal is
 * about to tell you anyway.
 *
 * Then `apex` stops dead. No camera, no rotation, no particles spawning. A
 * held frame before an impact is worth more than any amount of motion, because
 * the ear and the eye both read stillness as a held breath.
 */
const SHROUD = SHOTS.find((sh) => sh.name === 'shroud');
const APEX = SHOTS.find((sh) => sh.name === 'apex');
const BOOM_AT = SHOTS.find((sh) => sh.name === 'boom').at[0];
/* how long each candidate silhouette holds before crossing to the next */
const MORPH = 0.42;

const DUR = SHOTS[SHOTS.length - 1].at[1];

/* ─────────── the standard reveal ───────────
 *
 * What a normal pull gets. Not a shorter cut of the keynote — a different film
 * with a different job. The keynote's job is impact; this one's job is the wait
 * before it, so almost nothing happens for the first second and a half.
 *
 * The item does not arrive, it CONDENSES: it starts oversized, deep in shadow
 * and almost entirely transparent, sunk in fog, and resolves inward — scale
 * falling toward 1, opacity climbing, shadow lifting — so the eye has to work
 * to identify it before it is legible. That is where the suspense is. The
 * camera barely moves; a still camera makes the subject the only thing
 * changing, and anything the camera does here would be a distraction from the
 * one question the shot is asking, which is "what is it".
 */
const SLOW = [
  {
    name: 'settle', at: [0.00, 1.15], ease: EASE.glide,
    cam:  { x: 0.00, y: 0.02, zoom: 0.62, roll: 0.00 },
    item: { yaw: 0.9, pitch: 0.10, roll: -0.07, lift: 0.55, glow: 0.00 },
    note: 'fog closes over an empty stage; something is in there, barely',
  },
  {
    name: 'form', at: [1.15, 2.55], ease: EASE.glide,
    cam:  { x: 0.00, y: 0.00, zoom: 0.86, roll: 0.00 },
    item: { yaw: 0.35, pitch: 0.04, roll: -0.02, lift: 0.16, glow: 0.45 },
    note: 'it condenses out of the mist — the long beat, almost no motion',
  },
  {
    name: 'clear', at: [2.55, 3.35], ease: EASE.settle,
    cam:  { x: 0.00, y: 0.00, zoom: 1.05, roll: 0.00 },
    item: { yaw: 0.00, pitch: 0.00, roll: 0.00, lift: 0.00, glow: 1.00 },
    note: 'shadow lifts, it locks crisp and square',
  },
  {
    name: 'rest', at: [3.35, 3.95], ease: EASE.settle,
    cam:  { x: 0.00, y: 0.00, zoom: 1.05, roll: 0.00 },
    item: { yaw: 0.00, pitch: 0.00, roll: 0.00, lift: 0.00, glow: 1.00 },
    note: 'it floats',
  },
];
const SLOW_DUR = SLOW[SLOW.length - 1].at[1];
const SLOW_LOCK = SLOW.find((sh) => sh.name === 'clear').at[1];



/* The instant everything lands: flash, shake, fireworks, and the moment the
 * subject stops being a silhouette. It is the first frame of `boom`, so the
 * crispness and the bang are the same event — split them by even two frames
 * and the impact reads as a lighting change followed by a reveal. */
const IMPACT = BOOM_AT;

/* ─────────── assets ─────────── */
let pane = null;
let assets = null;

async function build() {
  if (pane) return;
  pane = el('div', 'cut');
  pane.hidden = true;
  pane.innerHTML = `
    <canvas class="cut__cv" id="cutCv"></canvas>
    <div class="cut__flash" id="cutFlash" aria-hidden="true"></div>
    <div class="cut__copy" id="cutCopy">
      <span class="cut__banner" id="cutBanner" hidden></span>
      <span class="cut__tier mono" id="cutTier"></span>
      <span class="cut__name" id="cutName"></span>
      <span class="cut__val mono" id="cutVal"></span>
      <button class="btn btn--go btn--lg" id="cutBtn">Collect</button>
    </div>`;
  document.body.appendChild(pane);

  assets = {
    cone: makeCone(),
    /* Atmospheric smoke: neutral charcoal with the faintest warm lift, so it
       reads as lit air rather than as a coloured haze. */
    fog: radial([
      [0, 'rgba(196,186,170,.12)'],
      [0.45, 'rgba(150,142,130,.065)'],
      [1, 'rgba(120,114,104,0)'],
    ], 96),
    /* the key light behind the subject, which is what separates it from a black
       background without lighting the background itself */
    /* white core, rose shoulder, gold mid, cyan falloff — the site identity
       reading outward from the hottest point */
    rim: radial([
      [0, 'rgba(255,255,255,.92)'], [0.22, 'rgba(240,167,183,.5)'],
      [0.44, 'rgba(255,214,138,.34)'], [0.7, 'rgba(255,170,0,.13)'],
      [1, 'rgba(0,150,200,0)'],
    ]),
    /* the floor pool the subject hovers over: contact without a hard shadow */
    ao: radial([
      [0, 'rgba(0,0,0,.7)'], [0.45, 'rgba(0,0,0,.4)'],
      [0.78, 'rgba(0,0,0,.12)'], [1, 'rgba(0,0,0,0)'],
    ]),
  };
}

/** Decode and pre-render before anyone is waiting on it. */
export function warmCutscene() { return build().catch(() => null); }

/** Rarity-only test, for callers with no crate price to measure against. */
export function isCinematic(item) { return CINEMATIC.has(item.rarity); }

/* ─────────── the film ─────────── */
/**
 * The keynote: for drops worth stopping the page for.
 */
export function playCutscene({ item, crate, pool: crPool }) {
  return run({
    item, crate, shots: SHOTS, dur: DUR, impact: IMPACT, mode: 'hero',
    multiple: profitMultiple(item, crate), crPool,
  });
}

/**
 * The standard reveal: for everything else.
 *
 * Same engine, different film. It runs the slow shot list, materialises the
 * item out of the fog instead of flying a camera around it, and lands with a
 * soft settle rather than fireworks — the bang is what makes a rare pull feel
 * rare, so a normal pull must not have one.
 */
export function playStandardReveal({ item, crate }) {
  return run({ item, crate, shots: SLOW, dur: SLOW_DUR, impact: SLOW_LOCK, mode: 'slow' });
}

function run({ item, crate, shots, dur, impact, mode, multiple = 0, crPool }) {
  return build().then(() => new Promise((resolve) => {
    const rar = RARITY[item.rarity];
    const reduce = reduceMotion();
    const total = reduce ? 0.25 : dur;
    const hero = mode === 'hero';

    const canvas = $('#cutCv', pane);
    const ctx = canvas.getContext('2d');
    const copy = $('#cutCopy', pane);
    const flashEl = $('#cutFlash', pane);

    pane.hidden = false;
    pane.dataset.mode = mode;
    pane.style.setProperty('--rar', rar.color);
    copy.dataset.on = '0';
    flashEl.dataset.on = '0';
    $('#cutTier', pane).textContent = rar.name.toUpperCase();
    $('#cutName', pane).textContent = item.name;
    $('#cutName', pane).style.color = rar.color;
    $('#cutVal', pane).textContent = `${money(item.value)}${crate ? ' · ' + crate.name : ''}`;

    /* The banner names the multiple, because the multiple is the thing that
     * just happened. "Legendary" is a property of the item; "62x" is a property
     * of the moment, and it is the one the player is reacting to. */
    const banner = $('#cutBanner', pane);
    if (hero && multiple >= 2) {
      banner.hidden = false;
      banner.innerHTML = `<span>profit</span><b>${multiple >= 10
        ? Math.round(multiple) : multiple.toFixed(1)}×</b><span>the case</span>`;
    } else {
      banner.hidden = true;
    }

    /* The sub-bass bed. It starts under the first frame and swells through the
     * approach, so the room is already humming before anything is visible —
     * that low pressure is most of why the void reads as a place rather than as
     * a black rectangle. */
    let stopHum = () => {};
    if (hero && !reduce) {
      stopHum = hum({ duration: dur + 0.6, freq: 34, volume: 0.4, rise: impact * 0.7 });
    }

    const dust = pool(260);
    const spark = pool(300);
    dust.clear(); spark.clear();

    /* Fog banks: fixed slots drifting on their own clocks, so the void is never
     * empty and never repeats. Positions are in stage space, parallaxed against
     * the camera so the subject travels through them. */
    const FOG = 7;
    const fog = Array.from({ length: FOG }, (_, i) => ({
      x: (i / FOG) * 2.4 - 1.2,
      y: 0.15 + Math.sin(i * 2.7) * 0.42,
      s: 0.7 + (i % 3) * 0.55,
      v: 0.012 + (i % 4) * 0.008,
      d: 0.25 + (i % 3) * 0.28,          // parallax depth: 0 near, 1 far
    }));

    let W = 0, H = 0, dpr = 1, stageH = 0;
    const fit = () => {
      const w = pane.clientWidth, h = pane.clientHeight;
      if (!w || !h) return false;
      const d = Math.min(2, devicePixelRatio || 1);
      if (w === W && h === H && d === dpr) return true;
      W = w; H = h; dpr = d;
      canvas.width = Math.round(w * d);
      canvas.height = Math.round(h * d);
      /* the copy block is laid out even while faded out, so its top edge is the
         real ceiling for the stage */
      const top = copy.offsetTop;
      stageH = Math.max(h * 0.45, (top > 40 ? top : h * 0.78) - 18);
      return true;
    };

    let sprite = null;
    img(item.img).then((i) => { sprite = i ? deviolet(i) : i; });

    /* The decoys.
     *
     * Real items from the pool that was actually opened — never invented ones,
     * and never items that could not have dropped. Shown only as silhouettes,
     * so the player learns nothing about the outcome from them except that it
     * is still hidden. Five is enough to stop the cycle being memorable inside
     * one shroud beat, and few enough to decode without a stall. */
    const decoys = [];
    if (hero && !reduce) {
      const src = (crPool && crPool.length ? crPool : (crate && crate.pool ? [] : []))
        .filter((it) => it && it.img && it.id !== item.id);
      const picks = [];
      for (let i = 0; i < 5 && src.length; i++) {
        picks.push(src[Math.floor(Math.random() * src.length)]);
      }
      for (const d of picks) img(d.img).then((im) => { if (im) decoys.push(deviolet(im)); });
    }

    /* The build. The hum is the floor, the riser is the climb, and the riser is
     * CUT at the boom rather than faded — the silence it leaves is the impact. */
    let stopRiser = () => {};

    let t = 0;
    let raf = 0;
    let last = performance.now();
    let shake = 0;
    const rings = [];
    const path = trail(6, 6);                 // x, y, scale, yaw, pitch, roll
    const cues = new Set();
    const cue = (name, at, fn) => {
      if (t >= at && !cues.has(name)) { cues.add(name); fn(); }
    };

    /* Interpolate the camera and the subject's orientation at time `t`.
     *
     * Finding the live shot and easing from the previous one is the whole
     * camera system. Holding the state on the shot rather than on the subject
     * is what lets a cut and a move be the same kind of thing: a cut is just a
     * shot whose window is short. */
    function frameAt(time) {
      let i = 0;
      while (i < shots.length - 1 && time >= shots[i].at[1]) i++;
      const cur = shots[i];
      const prev = shots[i - 1] || shots[0];
      const k = cur.ease(span(time, cur.at));
      const c = {}, it = {};
      for (const key of ['x', 'y', 'zoom', 'roll']) c[key] = mix(prev.cam[key], cur.cam[key], k);
      for (const key of ['yaw', 'pitch', 'roll', 'lift', 'glow']) {
        it[key] = mix(prev.item[key], cur.item[key], k);
      }
      return { cam: c, item: it, shot: cur.name };
    }

    function fireworks(cx, cy, S) {
      for (let i = 0; i < 150; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = 120 + Math.random() * 520;
        spark.spawn(cx, cy, Math.cos(a) * sp, Math.sin(a) * sp - 120,
          0.9 + Math.random() * 1.1, 2 + Math.random() * 3.5,
          i % 3 === 0 ? 1 : (i % 4 === 0 ? 2 : 0));
      }
      for (let i = 0; i < 40; i++) {
        const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.1;
        spark.spawn(cx + (Math.random() - 0.5) * S, cy,
          Math.cos(a) * 90, Math.sin(a) * (260 + Math.random() * 320),
          1.4 + Math.random() * 0.9, 2 + Math.random() * 2, 1);
      }
      /* Three rings, not one. A single expanding circle reads as a ripple; a
       * fast thick one chased by two thinner ones reads as a pressure front,
       * because that is what a shockwave actually looks like — a hard leading
       * edge with rarefaction behind it. */
      rings.push(
        { t: 0, life: 0.42, w: 9, hue: '#ffffff' },
        { t: -0.05, life: 0.78, w: 4, hue: '#ffd700' },
        { t: -0.14, life: 1.15, w: 2.4, hue: '#ffaa00' },
      );
    }

    function frame() {
      const now = performance.now();
      let dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (window.__cutSeek != null) { t = window.__cutSeek; dt = 1 / 60; }
      else t += dt;
      if (!fit()) { raf = requestAnimationFrame(frame); return; }

      const cx = W / 2;
      const cy = stageH * 0.5;
      const S = Math.min(stageH * 0.30, W * 0.26);   // the subject at zoom 1

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.imageSmoothingEnabled = false;             // pixel art stays pixels

      const { cam, item: ori, shot } = frameAt(t);

      cue('start', 0.02, () => play('orb', { volume: hero ? .32 : .22, rate: .55 }));
      if (hero) {
        cue('shroud', SHROUD.at[0], () => play('orb', { volume: .2, rate: .5 }));
        /* The riser starts at the top of the shroud and is timed to land its
         * peak exactly on the apex, NOT on the boom — so the last two thirds of
         * a second before the flash is pure held silence. That gap is the most
         * valuable part of the whole film. */
        cue('riser', SHROUD.at[0], () => {
          stopRiser = riser({
            duration: Math.max(0.4, APEX.at[0] - SHROUD.at[0]),
            from: 90, to: 1400, volume: .26,
          });
        });
        cue('apex', APEX.at[0], () => { stopRiser(); stopRiser = () => {}; });
        cue('bang', impact, () => {
          stopRiser();
          boom({ volume: .55 });
          play('levelup', { volume: .55 });
          shake = 1;
          flashEl.dataset.on = '1';
          setTimeout(() => { flashEl.dataset.on = '0'; }, 110);
          fireworks(cx, cy, S);
        });
      } else {
        /* The standard lock is a click and a breath of light, nothing more.
         * Give this the keynote's flash and screen shake and the keynote stops
         * meaning anything. */
        cue('form', shots[1].at[0], () => play('orb', { volume: .26, rate: .9 }));
        cue('lock', impact, () => {
          play('click', { volume: .34, rate: 1.15 });
          rings.push({ t: 0, life: 0.7 });
        });
      }

      if (shake > 0) {
        shake = Math.max(0, shake - dt * 2.6);
        const a = shake * shake * 16;
        ctx.translate((Math.random() - 0.5) * a, (Math.random() - 0.5) * a);
      }

      /* ── the void ──
       * Fog first, parallaxed against the camera so the subject has something to
       * be in front of. Depth 1 barely moves; depth 0 tracks the camera fully. */
      if (assets.fog) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        for (const f of fog) {
          const par = 1 - f.d;
          const fx2 = cx + (f.x + t * f.v) * W * 0.5 - cam.x * W * 0.5 * par;
          const fy2 = cy + f.y * stageH * 0.6 - cam.y * stageH * 0.5 * par;
          const sz = S * f.s * (2.2 + cam.zoom * 0.4 * par);
          ctx.globalAlpha = (hero ? 0.5 : 0.85) * (0.4 + f.d * 0.6);
          ctx.drawImage(assets.fog, fx2 - sz / 2, fy2 - sz / 2, sz, sz);
        }
        ctx.restore();
      }

      // the key light, raking down through the fog
      if (assets.cone) {
        const cw = S * (3.4 + cam.zoom), chh = stageH * 1.25;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.24 * (0.4 + ori.glow * 0.6);
        ctx.translate(cx - cam.x * W * 0.18, 0);
        ctx.drawImage(assets.cone, -cw / 2, -stageH * 0.3, cw, chh);
        ctx.restore();
      }

      /* dust motes hanging in the light, drifting up at a crawl. They exist to
         give the void a scale — without them a camera move on a black field is
         indistinguishable from no move at all. */
      if (!reduce && Math.random() < dt * 120) {
        dust.spawn(cx + (Math.random() - 0.5) * W * 0.8,
          cy + (Math.random() - 0.5) * stageH * 0.95,
          (Math.random() - 0.5) * 16, -8 - Math.random() * 22,
          2.4 + Math.random() * 2.2, 1 + Math.random() * 1.7,
          Math.random() < 0.25 ? 1 : 0);
      }
      dust.step(dt, -3, 0.1);
      // embers rising through the light, with a few colder motes among them
      dust.draw(ctx, ['rgba(224,137,155,.5)', 'rgba(255,170,0,.4)'], true);

      /* ── the subject ── */
      if (sprite) {
        // camera: pan and dolly in stage units, roll about the subject
        const sx = cx + cam.x * W * 0.34;
        const sy = cy + cam.y * stageH * 0.5 + ori.lift * S;
        const scale = cam.zoom;
        const box = S * scale;

        // a flat sprite on three axes. cos() never reaches zero here because
        // the amplitudes stay under a quarter turn — it must not go edge-on,
        // or a pixel sprite vanishes to a line and reads as a glitch.
        const yawS = 0.72 + 0.28 * Math.cos(ori.yaw);
        const pitchS = 0.80 + 0.20 * Math.cos(ori.pitch * 2.4);

        path.push([sx, sy, box, yawS, pitchS, ori.roll + cam.roll]);

        // measured speed drives the blur: translation plus the change in the
        // sprite's own projected size from turning
        const p1 = path.at(1);
        let blur = 0;
        if (p1 && !reduce) {
          const dx = sx - p1[0], dy = sy - p1[1];
          const dTurn = Math.abs(yawS - p1[3]) + Math.abs(pitchS - p1[4]);
          const speed = (Math.hypot(dx, dy) + dTurn * box * 2.4) / Math.max(dt, 1e-4);
          blur = clamp01(speed / (S * 7));
        }
        // the lock beat kills the trail outright: it must snap, not fade
        if (t >= impact) blur = 0;
        const ghosts = Math.min(path.max - 1, Math.round(blur * (path.max - 1)));
        window.__cutBlur = ghosts;

        // the rim light behind it, which is what lifts it off the void
        if (assets.rim) {
          const rw = box * 2.3;
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = 0.30 * ori.glow;
          ctx.drawImage(assets.rim, sx - rw / 2, sy - rw / 2, rw, rw);
          ctx.restore();
        }
        // the floor pool, so it is hovering over something
        if (assets.ao) {
          const aw = box * 1.5, ah = aw * 0.26;
          ctx.save();
          ctx.globalAlpha = 0.55 * clamp01(ori.glow * 1.4);
          ctx.drawImage(assets.ao, sx - aw / 2, sy + box * 0.62 - ah / 2, aw, ah);
          ctx.restore();
        }

        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        for (let g = ghosts; g >= 1; g--) {
          const q = path.at(g);
          if (!q) continue;
          ctx.globalAlpha = 0.4 * blur * (1 - g / (ghosts + 1));
          ctx.save();
          ctx.translate(q[0], q[1]);
          ctx.rotate(q[5]);
          ctx.scale(q[3], q[4]);
          blit(ctx, sprite, 0, 0, q[2]);
          ctx.restore();
        }
        ctx.restore();

        /* ── the shroud ──
         * Before the boom the subject is a SILHOUETTE, and not reliably its own.
         * It cross-fades between real items out of the same pool, each drawn as
         * a flat shape with no readable interior, so the form keeps almost
         * resolving and then becoming something else.
         *
         * Nothing here can mislead about odds: every shape shown could actually
         * have dropped from the crate that was opened. The only thing withheld
         * is which one, and the next beat answers that. */
        const shrouded = hero && t < impact;
        if (shrouded) {
          const k = (t - SHROUD.at[0]) / MORPH;
          const slot = Math.max(0, Math.floor(k));
          const frac = clamp01(k - slot);
          const pool2 = decoys.length ? decoys : [sprite];
          const a = pool2[slot % pool2.length] || sprite;
          const b2 = pool2[(slot + 1) % pool2.length] || sprite;
          /* tightness: the mist thins and the shape firms up as the build
             climbs, so by the apex it is a clear silhouette of SOMETHING */
          const firm = clamp01((t - SHROUD.at[0]) / Math.max(0.1, APEX.at[1] - SHROUD.at[0]));
          ctx.save();
          ctx.translate(sx, sy);
          ctx.rotate(ori.roll + cam.roll);
          ctx.scale(yawS, pitchS);
          ctx.globalAlpha = (0.34 + firm * 0.5) * (1 - frac);
          blit(ctx, tint(a, '#180a02'), 0, 0, box * (1.2 - firm * 0.2));
          ctx.globalAlpha = (0.34 + firm * 0.5) * frac;
          blit(ctx, tint(b2, '#180a02'), 0, 0, box * (1.2 - firm * 0.2));
          // a rose rim on whichever shape is currently dominant
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = 0.16 + firm * 0.28;
          blit(ctx, tint(frac < 0.5 ? a : b2, '#ffaa00'), 0, 0, box * (1.24 - firm * 0.22));
          ctx.restore();

          /* ── the churning shroud ──
           * Seven puffs orbiting the subject at different radii and rates,
           * drawn OVER the silhouette so the shape is never cleanly readable.
           * Two things make it churn rather than merely sit there: each puff
           * orbits on its own period so the cluster never repeats a
           * configuration, and each one breathes on a second, slower period so
           * the density itself pulses.
           *
           * It tightens as the build climbs — the mist closes in rather than
           * thinning out, which is the opposite of what a reveal normally does
           * and is exactly why the boom lands. */
          if (assets.fog) {
            const close = 0.5 + firm * 0.5;
            ctx.save();
            for (let i = 0; i < 7; i++) {
              const seed = i * 1.9;
              const orbit = t * (0.35 + (i % 3) * 0.22) + seed;
              const rad = box * (0.30 + (i % 4) * 0.16) * (1.5 - close * 0.5);
              const px = sx + Math.cos(orbit) * rad;
              const py = sy + Math.sin(orbit * 0.8) * rad * 0.7;
              const breathe = 0.72 + 0.28 * Math.sin(t * (0.9 + i * 0.17) + seed);
              const sz = box * (1.5 + (i % 3) * 0.42) * breathe;
              ctx.globalAlpha = (0.34 + close * 0.3) * (0.6 + 0.4 * breathe);
              ctx.drawImage(assets.fog, px - sz / 2, py - sz / 2, sz, sz);
            }
            ctx.restore();
          }
        }

        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate(ori.roll + cam.roll);
        ctx.scale(yawS, pitchS);
        /* THE REAL ITEM IS NOT DRAWN AT ALL WHILE SHROUDED.
         *
         * It used to be drawn at full alpha and merely COVERED by a black pass
         * whose opacity fell as the glow climbed — so the item bled through
         * more and more as the build went on. Measured with a deliberately
         * loud green item, 7,156 of its pixels were visible by the apex, 46%
         * of the fully-revealed count: half the prize on screen at exactly the
         * moment the shot is supposed to be withholding it.
         *
         * Masking is the wrong mechanism for a secret. Not drawing it is the
         * right one, because then there is no opacity anywhere that can drift
         * and no ordering mistake that can expose it. The silhouette pass above
         * is the only thing on screen until the boom. */
        if (!shrouded) {
          /* The standard film materialises rather than arrives: drawn oversized
           * and nearly transparent, resolving inward as the glow climbs. Fading
           * in at final size is just a dissolve; over-scaling first is what
           * reads as condensing out of the fog, because the silhouette is still
           * changing while the opacity is still climbing. */
          const drawBox = hero ? box : box * (1 + (1 - ori.glow) * 0.55);
          ctx.globalAlpha = hero ? 1 : clamp01(ori.glow * 1.35 + 0.06);
          blit(ctx, sprite, 0, 0, drawBox);
          if (ori.glow < 0.98) {                  // still partly in shadow
            ctx.globalAlpha = (1 - ori.glow) * (hero ? 0.85 : 0.7);
            blit(ctx, tint(sprite, '#05060a'), 0, 0, drawBox);
          }
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = 0.10 + ori.glow * 0.22;
          blit(ctx, tint(sprite, rar.color), 0, 0, drawBox);
        }
        ctx.restore();
      }

      /* ── the low-frequency pulse ──
       * A slow bloom of rose light out of the centre, quickening as the build
       * climbs — the visual half of the riser. It stops dead at the apex along
       * with everything else, so the held frame is genuinely held. */
      if (hero && t < APEX.at[0]) {
        const climb = clamp01((t - SHROUD.at[0]) / Math.max(0.1, APEX.at[0] - SHROUD.at[0]));
        const rate = 0.9 + climb * 4.2;
        const beat = 0.5 + 0.5 * Math.sin(t * rate * Math.PI);
        const p = beat * (0.1 + climb * 0.42);
        if (p > 0.01 && assets.rim) {
          const pw = S * (2.6 + climb * 2.4 + beat * 0.8);
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = p * 0.4;
          ctx.drawImage(assets.rim, cx - pw / 2, cy - pw / 2, pw, pw);
          ctx.restore();
        }
      }

      /* ── the bang ── */
      for (let i = rings.length - 1; i >= 0; i--) {
        const r = rings[i];
        r.t += dt;
        const k = r.t / r.life;
        if (k >= 1) { rings.splice(i, 1); continue; }
        if (k < 0) continue;
        ctx.save();
        ctx.globalAlpha = (1 - k) * (1 - k) * 0.62;
        ctx.strokeStyle = r.hue || '#ffaa00';
        ctx.lineWidth = Math.max(1, S * 0.012 * (r.w || 3) * (1 - k));
        ctx.beginPath();
        const rx = S * (0.3 + k * 2.6);
        ctx.ellipse(cx, cy, rx, rx * 0.86, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      spark.step(dt, 320, 0.5);
      spark.draw(ctx, ['#ffd700', '#ffffff', '#ffaa00'], true);

      if (t >= total && !cues.has('copy')) {
        cues.add('copy');
        copy.dataset.on = '1';
      }
      raf = requestAnimationFrame(frame);
    }

    const done = () => {
      cancelAnimationFrame(raf);
      stopHum();                                  // or it keeps humming over the page
      stopRiser();                                // and a riser with no drop is worse
      $('#cutBtn', pane).removeEventListener('click', done);
      pane.hidden = true;
      resolve();
    };
    $('#cutBtn', pane).addEventListener('click', done);
    raf = requestAnimationFrame(frame);
  }));
}
