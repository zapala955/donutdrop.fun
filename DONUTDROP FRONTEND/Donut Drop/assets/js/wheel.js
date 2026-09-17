/* wheel.js — the upgrader dial.
 *
 * Drawn on a 2D canvas, deliberately.
 *
 * This was a WebGL scene for several passes and every fault it had came from
 * that choice, not from the design: geometry clipped at the frame edge, the
 * camera had to be re-solved every time a part changed size, cylinders
 * silhouetted as hard rectangles, and "make it bigger" meant re-deriving a
 * field of view. The thing being drawn is a flat ring with an arc on it. In two
 * dimensions there is no camera to frame, nothing can fall outside the canvas,
 * the radius is a number of pixels rather than the result of a tangent, and it
 * is crisp on any display.
 *
 * What survived from the 3D version is the part that was always right: the
 * motion. The marker does not ease. An easing curve that ends at zero velocity
 * spends its last second covering a fraction of a degree, so the dial appears
 * to freeze a beat before it stops — the opposite of tension. Instead an
 * angular VELOCITY profile is integrated once, at load, into a normalised
 * position table:
 *
 *     v(s) = ramp(s) · [ (1-s)^FLING  +  CRAWL_W · (1-s)^CRAWL ]
 *
 * The first term is the fling: it dies inside a second and supplies the blur.
 * The second is the crawl, a low stubborn term with a fractional exponent that
 * is still moving at s = 0.99 and stops only because it must. Integrating a
 * table rather than solving a curve means the landing angle is exact by
 * construction (F(1) = 1) and velocity is continuous throughout, so there is no
 * seam between "fast" and "slow".
 *
 * The POINTER IS FIXED and the ring turns under it, which is how a prize wheel
 * actually works: you watch the target zone come round rather than watching a
 * needle hunt for it. An earlier pass had it the other way about.
 *
 * Geometry contract, which everything drawn here must agree on or the dial lies
 * about the result. The ring carries its own local angle, measured
 * counter-clockwise from its zero. The arc occupies local [0, chance·2π). The
 * local angle sitting under the fixed pointer is S.angle. Canvas angles run
 * clockwise from +X, so a local angle L is drawn at
 *
 *     canvas = TOP + S.angle − L
 *
 * which puts L = S.angle at the pointer, as required. A win is therefore
 * exactly `S.angle mod 2π < chance·2π` — unchanged from when the marker moved,
 * because which object rotates is a presentation choice and the predicate is
 * not.
 */
import { reduceMotion } from './util.js';
import { play } from './audio.js';

const TICKS = 72;                // graduations, and the click resolution
const SPIN_TIME = 5.2;           // seconds from release to dead stop
const TURNS = 5;                 // whole turns before the landing angle

/* the velocity profile — see the header */
const LAUNCH = 0.045;            // fraction of the spin spent winding up
const FLING = 7;                 // how fast the launch energy dies
const CRAWL = 0.5;               // fractional: still moving at the very end
const CRAWL_W = 0.0625;          // the crawl's share of the total angle, ~25%
const SETTLE = 0.7;              // seconds of rock-back after the stop
const SAMPLES = 2400;

const PROFILE = (() => {
  const v = new Float64Array(SAMPLES + 1);
  for (let i = 0; i <= SAMPLES; i++) {
    const s = i / SAMPLES;
    const r = Math.min(1, s / LAUNCH);
    const ramp = r * r * (3 - 2 * r);          // smoothstep, so it starts from rest
    v[i] = ramp * (Math.pow(1 - s, FLING) + CRAWL_W * Math.pow(1 - s, CRAWL));
  }
  const F = new Float64Array(SAMPLES + 1);
  let acc = 0;
  for (let i = 1; i <= SAMPLES; i++) { acc += (v[i] + v[i - 1]) * 0.5; F[i] = acc; }
  for (let i = 0; i <= SAMPLES; i++) F[i] /= acc;   // F(1) = 1 exactly
  return F;
})();

function progress(s) {
  if (s <= 0) return 0;
  if (s >= 1) return 1;
  const x = s * SAMPLES;
  const i = x | 0;
  return PROFILE[i] + (PROFILE[i + 1] - PROFILE[i]) * (x - i);
}

const TAU = Math.PI * 2;
/* The display datum: where local angle 0 is drawn, and where the fixed pointer
 * sits. It is SIX o'clock now rather than twelve, so the pointer sits at the
 * foot of the dial and leaves the crown free for the glyph and the number.
 *
 * This is one constant on purpose. The ring's rotation (`spin = TOP + angle`)
 * and the pointer are both drawn from it, so moving it rotates the whole
 * instrument as one piece and the geometry contract still holds:
 *
 *     canvas = TOP + S.angle - L        and        win  <=>  S.angle mod 2PI < chance * 2PI
 *
 * Drawing the pointer somewhere else while leaving the maths here is the bug
 * this comment exists to prevent: the arrow would point at one place and the
 * outcome would be decided at another. */
const TOP = Math.PI / 2;         // six o'clock, in canvas angles (y grows down)

/* The win zone, as the gold-to-orange sweep the platform runs on.
 *
 * This was one flat emerald, on the reasoning that a shape whose only job is to
 * say WHERE the win is should not also be saying something else along its
 * length. That still holds for hue — the gradient here runs gold to orange,
 * which is one colour family reading as one band, not two colours meaning two
 * things. What it buys is depth: a flat stroke on a dark ring reads as a
 * sticker, and a graded one reads as lit. */
const ZONE_HOT = '#ffe45c';
const ZONE_MID = '#ffaa00';
const ZONE_LOW = '#ff6a00';
const TRACK = '#221d14';
const RIM = 'rgba(255,214,150,.14)';
const TICK = 'rgba(255,200,120,.3)';

export function createWheel(canvas) {
  const ctx = canvas.getContext('2d');

  const S = {
    chance: 0, angle: 0, spinning: false,
    t: 0, total: 0, from: 0, dur: SPIN_TIME,
    lastTick: 0, onDone: null, result: null,
    settleT: -1, zoom: 0, edgeTicks: 99, tenseFired: false,
    kick: 0, kickV: 0, lastClick: 0,
  };

  let w = 0, h = 0, dpr = 1;
  function resize() {
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    if (!cw || !ch) return false;
    const d = Math.min(2, devicePixelRatio || 1);
    if (cw === w && ch === h && d === dpr) return true;
    w = cw; h = ch; dpr = d;
    canvas.width = Math.round(w * d);
    canvas.height = Math.round(h * d);
    return true;
  }

  function draw() {
    if (!resize()) return;
    const cx = w / 2, cy = h / 2;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    /* The near-miss push. In 3D this was a dolly; here it is a scale about the
     * centre, which is the same thing and cannot clip anything off the canvas
     * because everything is drawn after it. */
    const z = 1 + S.zoom * 0.13;
    ctx.translate(cx, cy);
    ctx.scale(z, z);
    ctx.translate(-cx, -cy);

    const R = Math.min(w, h) * 0.335;     // centre of the track
    const TW = R * 0.30;                  // track width
    const sweep = Math.max(0, Math.min(1, S.chance)) * TAU;
    // where the ring's local zero has been carried to
    const spin = TOP + S.angle + S.kick * 0.4;

    // ── the track: a full circle, so it needs no rotation of its own ──
    ctx.lineWidth = TW;
    ctx.strokeStyle = TRACK;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, TAU);
    ctx.stroke();
    // a hairline on each rim, so the track has an edge rather than fading out
    ctx.lineWidth = Math.max(1, R * 0.008);
    ctx.strokeStyle = RIM;
    ctx.beginPath(); ctx.arc(cx, cy, R + TW / 2, 0, TAU); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, R - TW / 2, 0, TAU); ctx.stroke();

    // ── graduations: these DO turn with the ring, and are most of what tells
    //    you it is moving once the arc has swept past ──
    ctx.strokeStyle = TICK;
    ctx.lineWidth = Math.max(1, R * 0.011);
    ctx.beginPath();
    for (let i = 0; i < TICKS; i++) {
      const a = spin - (i / TICKS) * TAU;
      const r0 = R - TW / 2 - R * 0.045, r1 = r0 - R * 0.055;
      ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
    }
    ctx.stroke();

    /* ── the target zone ──
     *
     * One flat colour and nothing else. It carried a per-segment emerald-to-gold
     * gradient and a glow underneath, which meant ~200 strokes plus a blur pass
     * every frame and a shape whose colour changed along its length — and the
     * one job this shape has is to say, unambiguously, where the win is. A
     * single arc in a single colour says it in one stroke. */
    if (sweep > 0.001) {
      ctx.lineCap = 'butt';
      ctx.lineWidth = TW;
      /* The gradient is built across the zone's own bounding box rather than
       * the whole canvas, so a 3% sliver gets the full gold-to-orange ramp
       * instead of one flat sample out of the middle of it. */
      const a0 = spin - sweep, a1 = spin;
      const g = ctx.createLinearGradient(
        cx + Math.cos(a0) * R, cy + Math.sin(a0) * R,
        cx + Math.cos(a1) * R, cy + Math.sin(a1) * R);
      g.addColorStop(0, ZONE_LOW);
      g.addColorStop(0.55, ZONE_MID);
      g.addColorStop(1, ZONE_HOT);
      ctx.strokeStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, R, a0, a1);
      ctx.stroke();
    }

    /* ── the pointer: fixed at six o'clock, reaching up across the track ──
     * It does not move, so there is nothing to track with your eye; the ring
     * turning under it is the whole read. It sits at the foot of the dial
     * rather than the crown so it does not compete with the glyph and the
     * number stacked in the middle. */
    {
      const out = R + TW / 2 + R * 0.14;
      const inn = R - TW / 2 - R * 0.04;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(TOP);

      ctx.fillStyle = '#ffd24a';
      ctx.fillRect(inn, -R * 0.018, out - inn, R * 0.036);
      const hs = R * 0.085;
      ctx.beginPath();
      ctx.moveTo(out, 0);
      ctx.lineTo(out + hs * 1.7, -hs * 1.15);
      ctx.lineTo(out + hs * 1.7, hs * 1.15);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

  }

  /* ─── the loop ─── */
  let last = performance.now();
  let raf = 0;
  function frame() {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    if (S.spinning) {
      S.t += dt;
      const k = Math.min(1, S.t / S.dur);
      S.angle = S.from + S.total * progress(k);
      window.__ddWheel = {
        angle: S.angle, k, turns: S.angle / TAU,
        zoom: +S.zoom.toFixed(3), edge: S.edgeTicks,
      };

      // every graduation that passes the marker clicks and knocks it
      const idx = Math.floor((S.angle / TAU) * TICKS);
      if (idx !== S.lastTick) {
        const crossed = Math.min(4, Math.abs(idx - S.lastTick));
        S.lastTick = idx;
        S.kickV -= 6 * crossed;
        /* Clicks are throttled by TIME, not by chance.
         *
         * They were thinned with a 22% random gate, which sounds reasonable
         * until you count: at launch the ring crosses about 380 graduations a
         * second, so 22% is ~84 plays a second against a three-voice pool, and
         * every play() is a seek plus a promise. That is real main-thread work
         * landing in exactly the window where the spin is fastest — measured,
         * the first dozen frames ran 22-47ms while the rest held a steady 16.7.
         *
         * A minimum gap caps the rate at ~20/sec no matter how fast the ring is
         * going, and it sounds better: a ratchet you can count rather than a
         * buzz. Late in the spin the graduations are further apart than the gap,
         * so every one of them still clicks. */
        if (now - S.lastClick >= 50) {
          S.lastClick = now;
          play('click', { volume: 0.16 + k * 0.26, rate: 0.92 + Math.random() * 0.22 });
        }
      }

      /* If this one lands within a few graduations of the arc's edge, lean in.
       * Nothing about the outcome changes — the landing angle was fixed before
       * anything moved — but the last beat is spent on the only part of the
       * dial that still matters. */
      const tense = S.edgeTicks <= 3 && k > 0.76;
      S.zoom += ((tense ? 1 : 0) - S.zoom) * Math.min(1, dt * 2.6);
      if (tense && !S.tenseFired) {
        S.tenseFired = true;
        play('orb', { volume: 0.26, rate: 0.62 });
        canvas.dispatchEvent(new CustomEvent('wheel:tense', { bubbles: true }));
      }

      if (k >= 1) {
        S.spinning = false;
        S.settleT = 0;
        S.kickV -= 4;
        if (S.onDone) { const f = S.onDone; S.onDone = null; f(); }
      }
    } else {
      S.zoom += ((0) - S.zoom) * Math.min(1, dt * 2.2);
    }

    // it settles back against the stop rather than arriving dead
    if (S.settleT >= 0) {
      S.settleT += dt;
      if (S.settleT > SETTLE) S.settleT = -1;
    }

    // sprung marker: stiff, well damped, clamped so it never swings off the ring
    S.kickV += -S.kick * 200 * dt;
    S.kickV *= Math.exp(-dt * 12);
    S.kick = Math.max(-0.05, Math.min(0.05, S.kick + S.kickV * dt));

    draw();
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  return {
    setChance(chance) { S.chance = chance; },

    /* `landing` is the resting angle in radians, counter-clockwise from the
     * dial's zero. `edgeTicks` is how many graduations separate it from the
     * nearest edge of the arc — the caller knows it because it chose the angle. */
    spin(landing, result, edgeTicks = 99) {
      if (S.spinning) return Promise.resolve();
      const reduce = reduceMotion();
      const cur = ((S.angle % TAU) + TAU) % TAU;
      const delta = ((landing - cur) + TAU) % TAU;
      S.result = result;
      S.edgeTicks = edgeTicks;
      S.tenseFired = false;
      S.from = S.angle;
      S.total = (reduce ? 0 : TURNS) * TAU + delta;
      S.t = 0;
      S.dur = reduce ? 0.05 : SPIN_TIME;
      S.lastTick = Math.floor((S.angle / TAU) * TICKS);
      S.settleT = -1;
      S.spinning = true;
      return new Promise((res) => { S.onDone = res; });
    },

    reset() {},
    dispose() { cancelAnimationFrame(raf); },
  };
}
