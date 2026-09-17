/* reveal.js — the payoff shot.
 *
 * Drawn on a 2D canvas, and that is the whole reason it is fluent.
 *
 * This was a WebGL scene: a field of instanced blocks, a lit chest cut from the
 * entity atlas, shadow maps, a vortex, additive particle systems. It measured at
 * 9fps, and after stripping shadows, halving the particles and dropping the
 * buffer resolution it still only reached 18. The cost was never geometry — it
 * was fill: one fullscreen pass over several overlapping transparent layers,
 * every frame.
 *
 * Everything on screen here is pixel art. Rendering pixel art through a 3D
 * pipeline is fighting the medium: it buys perspective nobody asked for and
 * pays for it in fill rate, framing maths and clipping bugs. In 2D the same shot
 * is a couple of dozen drawImage calls, it cannot clip, there is no camera to
 * solve, and it is crisp at any DPI.
 *
 * The chest lid is not a model. It is Mojang's own animated ender chest render,
 * extracted frame by frame, so the lid moves exactly the way it moves in game.
 *
 * TIMING
 * ------
 * Each sequence is one timeline in seconds, declared in PHASES. Every beat reads
 * its own local 0..1 from that, so changing a duration is changing one number
 * and nothing drifts out of step with anything else. The version before this
 * drove beats with awaited sleeps against a separate per-frame state machine,
 * and the two disagreed: the lid opened while the chest was still flying in.
 *
 * COST
 * ----
 * Everything expensive is pre-rendered once into an offscreen canvas and then
 * blitted: the spotlight, the contact shadow, the light shaft, the glow, the
 * item's own white and ember silhouettes. Nothing builds a gradient per frame.
 * That rule is not stylistic — a viewport-scale radial gradient rasterised per
 * frame measured as a third of all frames missing their deadline.
 */
import { RARITY } from './data.js';
import { $, el, money, reduceMotion } from './util.js';
import { play } from './audio.js';
/* Only the hue remap comes from fx.js here. This file predates that module and
 * still carries its own copies of the blitter, the tint cache and the pools;
 * they are identical, and consolidating them is a separate job from a repaint. */
import { dePurple } from './fx.js';

const IMG = 'assets/img/items/';
const BLK = 'assets/img/block/';

/* The lid, as real frames: c0 wide open through c4, then the shut render. c4 is
 * NOT shut — the lid is still about 25 degrees up — so the sequence needs the
 * sixth frame to actually land. All six come off the same camera, which is why
 * they can be swapped in place without the block jumping. */
const LID = ['c0', 'c1', 'c2', 'c3', 'c4', 'shut'].map((n) => `${IMG}ender_chest_${n}.png`);

/* Where the block actually is inside its 300px render, as fractions of the frame.
 * The render is isometric: the body sits low and left, and the lid swings up to
 * the right, so centring the FRAME puts the chest visibly off-centre and its
 * base floating. Measured off the alpha (dense rows and columns only, so the
 * ambient purple particles do not count): body x 58..241, base y 280. Every
 * frame agrees on those, which is what makes them swappable. */
const BODY = {
  cx: 0.498, w: 0.610, base: 0.933,
  mouth: 0.545,      // the back rim of the opening: where the prize starts, inside
  lip: 0.600,        // the front rim: the line it emerges over
  lidTop: 0.080,
  face: 0.700,       // the middle of the front face, where the void shows through
};

/* Which wins get the full treatment.
 *
 * Every win running the same two-and-a-half second cinematic is how a reveal
 * stops meaning anything — if the Iron Ingot gets the same ceremony as the
 * Elytra then the ceremony is just a loading screen. Common and uncommon take
 * the quick cut; rare and up get the keynote. */
const HERO = new Set(['rare', 'epic', 'legendary']);

const PHASES = {
  /* THE UPGRADER WIN — the prize goes INTO the chest.
   *
   * The chest is the vault, not the source: you staked cash, you won the item,
   * and the shot is it being banked. So it flies in on an arc and the lid snaps
   * on it. An earlier cut had the prize rising out of the chest, which reads as
   * the chest giving you something — wrong story for an upgrader, where the box
   * is where your winnings go.
   *
   * The arc matters as much as the destination. A straight drop is a lift
   * cancelled; a thrown object travels a parabola, rising as it moves across
   * and falling faster than it rose. That is what `arc` is shaped to do. */
  hero: {
    land:   [0.00, 0.46],   // the shut chest settles under the key light
    hum:    [0.32, 0.96],   // the void in its core wakes up and it resonates
    open:   [0.70, 1.30],   // the lid lifts, slow to start, slow to stop
    show:   [1.02, 1.66],   // the prize is presented, turning, motion-blurred
    arc:    [1.66, 2.34],   // it flies across and down into the mouth
    snap:   [2.30, 2.56],   // the lid comes down on it, hard
    seal:   [2.56, 3.05],   // dust settles, the burst rings out
  },
  /* The quick cut. Same geometry, same chest, a third of the running time and
   * none of the theatre: it opens, the prize goes in, done. */
  quick: {
    land:   [0.00, 0.14],
    open:   [0.08, 0.44],
    show:   [0.30, 0.52],
    arc:    [0.52, 0.86],
    snap:   [0.84, 1.00],
    seal:   [1.00, 1.15],
  },
  lose: {
    hover:  [0.00, 0.30],   // it hangs, and then it does not
    fall:   [0.30, 0.74],   // gravity, not easing
    surge:  [0.50, 1.05],   // the magma comes up to meet it
    burn:   [0.70, 0.96],   // white hot on contact
    slag:   [0.86, 1.60],   // it cools to crust and comes apart
    settle: [1.60, 2.05],
  },
};
const DUR = { hero: 3.05, quick: 1.15, lose: 2.05 };

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const span = (t, [a, b]) => clamp01((t - a) / (b - a));
const easeOut = (x) => 1 - Math.pow(1 - x, 3);
const easeIn = (x) => x * x;

/* cubic-bezier(x1,y1,x2,y2) as a function of t, Newton-solved on x.
 * Power curves cannot do what this needs: a lid with weight is slow to start
 * AND slow to stop with speed through the middle, and a levitation is eased off
 * the mark and then hangs. Both of those are beziers, so solve beziers. */
function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const fx = (t) => ((ax * t + bx) * t + cx) * t;
  const dfx = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 6; i++) {            // converges well inside 6 steps here
      const e = fx(t) - x;
      if (Math.abs(e) < 1e-5) break;
      const d = dfx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= e / d;
    }
    return ((ay * t + by) * t + cy) * t;
  };
}
const EASE = {
  lid:    bezier(0.62, 0.03, 0.20, 1.00),   // heavy: reluctant, then settles open
  lift:   bezier(0.34, 0.08, 0.22, 1.00),   // presentation: eases up, then hangs
  toss:   bezier(0.40, 0.00, 0.72, 0.36),   // thrown: floats out, then drops away
  snap:   bezier(0.70, 0.00, 0.30, 1.00),   // a lid falling under its own weight
  settle: bezier(0.22, 1.00, 0.36, 1.00),   // arrivals
  surge:  bezier(0.30, 0.00, 0.15, 1.00),   // liquid climbing a wall
};

/* ─────────── sprite helpers ─────────── */

/* A flat-coloured copy of a sprite, in its exact silhouette, built once and
 * kept. Drawing a sprite over itself with 'lighter' only brightens what is
 * already bright — it whitens an elytra fine and does nothing at all to a dark
 * item — and it can never shift the hue, so it cannot make anything look like
 * it is burning or like it has cooled to slag. A silhouette blended on top
 * does both, and costs one blit. */
const tints = new Map();
function tint(im, colour) {
  const key = im.src + colour;
  let c = tints.get(key);
  if (!c) {
    c = document.createElement('canvas');
    c.width = im.width; c.height = im.height;
    const x = c.getContext('2d');
    x.drawImage(im, 0, 0);
    x.globalCompositeOperation = 'source-in';   // keep the alpha, replace the colour
    x.fillStyle = colour;
    x.fillRect(0, 0, c.width, c.height);
    tints.set(key, c);
  }
  return c;
}

/* Draw a sprite centred on (x,y), fitted to a box of `box` on its longer side.
 * Not every sprite is square — elytra.png is 449x696 — and stretching one into
 * a square box turns the most expensive item on the site into a smear. */
function blit(ctx, im, x, y, box) {
  const k = box / Math.max(im.width, im.height);
  const w = im.width * k, h = im.height * k;
  ctx.drawImage(im, x - w / 2, y - h / 2, w, h);
}

/* A radial falloff, rendered once at a fixed size and blitted at whatever scale
 * the shot needs. `stops` is [offset, css colour] pairs. */
function radial(stops, R = 128) {
  const c = document.createElement('canvas');
  c.width = R * 2; c.height = R * 2;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(R, R, 0, R, R, R);
  for (const [o, col] of stops) g.addColorStop(o, col);
  x.fillStyle = g;
  x.fillRect(0, 0, R * 2, R * 2);
  return c;
}

/* The key light: a soft-edged cone, wide at the bottom, rendered once. A cone
 * is not a radial falloff, so this is built as a stack of horizontal bands with
 * their own alpha rather than as a gradient shape. */
function makeCone(W = 256, H = 256) {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  for (let i = 0; i < H; i++) {
    const v = i / (H - 1);
    const halfW = (0.06 + v * 0.44) * W;       // opens out as it descends
    const a = Math.sin(v * Math.PI) * 0.5 * (1 - v * 0.35);
    const g = x.createLinearGradient(W / 2 - halfW, 0, W / 2 + halfW, 0);
    g.addColorStop(0, 'rgba(255,226,170,0)');
    g.addColorStop(0.5, `rgba(255,236,198,${a.toFixed(4)})`);
    g.addColorStop(1, 'rgba(255,226,170,0)');
    x.fillStyle = g;
    x.fillRect(W / 2 - halfW, i, halfW * 2, 1);
  }
  return c;
}

/* ─────────── particles ─────────── */
/* One flat pool, no allocation per frame. Everything is a small square, because
 * every other thing on screen is made of small squares. The palette index is
 * carried per particle so dust, embers and ash can share one pool and still be
 * drawn in a single pass each. */
function pool(n) {
  const F = 8;                                  // x y vx vy life max size pal
  const p = new Float32Array(n * F);
  let head = 0;
  return {
    spawn(x, y, vx, vy, life, size, pal = 0) {
      const i = (head = (head + 1) % n) * F;
      p[i] = x; p[i + 1] = y; p[i + 2] = vx; p[i + 3] = vy;
      p[i + 4] = life; p[i + 5] = life; p[i + 6] = size; p[i + 7] = pal;
    },
    step(dt, g, drag = 0) {
      const k = drag ? Math.max(0, 1 - drag * dt) : 1;
      for (let i = 0; i < n * F; i += F) {
        if (p[i + 4] <= 0) continue;
        p[i + 4] -= dt;
        p[i + 3] = p[i + 3] * k + g * dt;
        p[i + 2] *= k;
        p[i] += p[i + 2] * dt;
        p[i + 1] += p[i + 3] * dt;
      }
    },
    /* One pass per palette entry, so fillStyle is set once per colour instead
     * of once per particle. */
    draw(ctx, palette, additive = false) {
      ctx.save();
      if (additive) ctx.globalCompositeOperation = 'lighter';
      for (let c = 0; c < palette.length; c++) {
        ctx.fillStyle = palette[c];
        for (let i = 0; i < n * F; i += F) {
          const l = p[i + 4];
          if (l <= 0 || p[i + 7] !== c) continue;
          const k = l / p[i + 5];
          ctx.globalAlpha = k * k;
          const s = p[i + 6] * (0.4 + k * 0.6);
          ctx.fillRect(p[i] - s / 2, p[i + 1] - s / 2, s, s);
        }
      }
      ctx.restore();
    },
    clear() { p.fill(0); },
  };
}

/* ─────────── assets ─────────── */
const cache = new Map();
function img(src) {
  let p = cache.get(src);
  if (!p) {
    p = new Promise((res) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => res(null);
      i.src = src;
    });
    cache.set(src, p);
  }
  return p;
}

let pane = null;
let assets = null;

async function build() {
  if (pane) return;
  pane = el('div', 'rvl');
  pane.hidden = true;
  pane.innerHTML = `
    <canvas class="rvl__cv" id="rvlCv"></canvas>
    <div class="rvl__copy" id="rvlCopy">
      <span class="rvl__kicker mono" id="rvlKicker"></span>
      <span class="rvl__head" id="rvlHead"></span>
      <span class="rvl__sub mono" id="rvlSub"></span>
      <button class="btn btn--go btn--lg" id="rvlBtn">Continue</button>
    </div>`;
  document.body.appendChild(pane);

  /* Load the two sets separately. Destructuring one spread array positionally
   * is a trap: adding a sixth lid frame once silently shifted `lava` onto the
   * shut-chest sprite, and the lava pool rendered as nothing with no error. */
  const [lid, lava] = await Promise.all([
    Promise.all(LID.map(img)),
    img(`${BLK}lava_still.png`),
  ]);
  assets = {
    /* Mojang's render has violet end-particles baked into the PNG, and the
       palette has no violet in it. dePurple rotates just that hue wedge to
       amber and leaves the teal portal face and all the shading alone. */
    lid: lid.filter(Boolean).map((f) => dePurple(f)),
    lava,
    glow: radial([
      [0, 'rgba(255,255,255,.95)'], [0.25, 'rgba(214,231,255,.45)'],
      [0.62, 'rgba(150,190,255,.12)'], [1, 'rgba(120,170,255,0)'],
    ]),
    /* The forge in the chest's core. This was ender-purple, which is the hue
       the palette no longer contains; molten amber reads the same way — dark at
       the very centre so it is depth rather than a lamp — and it now agrees
       with the particle dust that comes out of the same opening. */
    void_: radial([
      [0, 'rgba(40,24,0,.9)'], [0.28, 'rgba(255,170,0,.55)'],
      [0.6, 'rgba(255,140,0,.22)'], [1, 'rgba(70,40,0,0)'],
    ]),
    /* ambient occlusion: the contact shadow the block sits in */
    ao: radial([
      [0, 'rgba(0,0,0,.72)'], [0.45, 'rgba(0,0,0,.42)'],
      [0.75, 'rgba(0,0,0,.14)'], [1, 'rgba(0,0,0,0)'],
    ]),
    heat: radial([
      [0, 'rgba(255,176,72,.55)'], [0.4, 'rgba(255,110,26,.22)'],
      [1, 'rgba(255,80,0,0)'],
    ]),
    cone: makeCone(),
  };
}

/* Warm the sprites before they are needed. The old scene cost ~700ms to build
 * and was doing it at pull time, inside the spin. */
export function warmReveal() { return build().catch(() => null); }

/* ─────────── the shot ─────────── */
export function playReveal({ won, item, stake, payout }) {
  return build().then(() => new Promise((resolve) => {
    const rar = RARITY[item.rarity].color;
    const reduce = reduceMotion();
    const big = HERO.has(item.rarity);
    const kind = won ? (big ? 'hero' : 'quick') : 'lose';
    const ph = PHASES[kind];
    const total = reduce ? 0.2 : DUR[kind];

    const canvas = $('#rvlCv', pane);
    const ctx = canvas.getContext('2d');
    const copy = $('#rvlCopy', pane);

    pane.hidden = false;
    pane.dataset.result = won ? 'win' : 'lose';
    pane.dataset.tier = big && won ? 'hero' : 'plain';
    pane.style.setProperty('--rar', rar);
    copy.dataset.on = '0';
    $('#rvlKicker', pane).textContent = won
      ? (big ? RARITY[item.rarity].name.toUpperCase() : 'IT LANDED')
      : 'IT MISSED';
    $('#rvlHead', pane).textContent = won ? item.name : 'Into the lava';
    $('#rvlHead', pane).style.color = won ? rar : 'var(--lava, #ff8a2b)';

    /* The copy is written NOW, while it is still faded out, not when it
     * appears. The canvas sizes the shot against the top of this block, and
     * measuring it while the payout line was still missing reserved too little
     * room — the chest ended up sitting on the kicker. */
    const sub = $('#rvlSub', pane);
    if (won) {
      sub.innerHTML = `<span class="rvl__tick" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M4 12.5 9.5 18 20 6.5"/></svg>
        </span><b class="rvl__payout" id="rvlPay">${money(payout)}</b><span> paid out</span>`;
    } else {
      sub.textContent = `${money(stake)} gone`;
    }

    const sparks = pool(220);
    sparks.clear();

    let W = 0, H = 0, dpr = 1, stageH = 0;
    let scratch = null, sctx = null;            // for the heat-haze displacement
    const fit = () => {
      const w = pane.clientWidth, h = pane.clientHeight;
      if (!w || !h) return false;
      const d = Math.min(2, devicePixelRatio || 1);
      if (w === W && h === H && d === dpr) return true;
      W = w; H = h; dpr = d;
      canvas.width = Math.round(w * d);
      canvas.height = Math.round(h * d);
      /* How much room the shot actually has: the copy block is laid out in the
       * grid even while it is faded out, so its top edge is the real ceiling.
       * A fixed fraction of the viewport put the chest base under the kicker on
       * a phone, where the copy is the same height but the viewport is not. */
      const top = copy.offsetTop;              // ignores the hidden transform
      const GUTTER = 18;
      stageH = Math.max(h * 0.45, (top > 40 ? top : h * 0.78) - GUTTER);
      if (!scratch) {
        scratch = document.createElement('canvas');
        sctx = scratch.getContext('2d');
      }
      return true;
    };

    let sprite = null;
    img(item.img).then((i) => { sprite = i; });

    let t = 0;
    let raf = 0;
    let last = performance.now();
    let shake = 0;
    let ringT = -1;
    /* Motion-blur history: where the prize was on the previous frames, so the
     * ghosts can be drawn along its real path including its spin. A trail
     * sampled from actual positions bends with the motion; one faked by
     * offsetting a fixed distance does not. */
    const TRAIL = 4;
    const trail = new Float32Array(TRAIL * 4);   // x, y, box, turn
    let trailN = 0;
    const cues = new Set();
    const cue = (name, at, fn) => {
      if (t >= at && !cues.has(name)) { cues.add(name); fn(); }
    };

    function frame() {
      const now = performance.now();
      let dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (window.__rvlSeek != null) { t = window.__rvlSeek; dt = 1 / 60; }
      else t += dt;
      if (!fit()) { raf = requestAnimationFrame(frame); return; }

      const cx = W / 2;
      /* Layout. Two horizontal lines and one size, and everything else is
       * derived, so the prize can never end up behind the open lid and the
       * chest base can never end up floating. The cap on S comes from the
       * clearance test hoverY + S/2 < floorY - 1.75S. */
      const S = Math.min(stageH * 0.27, W * 0.26);
      const hoverY = stageH * 0.13;            // where the losing item starts
      const floorY = stageH;                   // where the chest base rests

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.imageSmoothingEnabled = false;       // pixel art stays pixels

      if (shake > 0) {
        shake = Math.max(0, shake - dt * 3.2);
        const a = shake * shake * 9;
        ctx.translate((Math.random() - 0.5) * a, (Math.random() - 0.5) * a);
      }

      if (won) drawWin(ctx, cx, floorY, S, dt);
      else drawLose(ctx, cx, hoverY, floorY, S, dt);

      if (t >= total && !cues.has('copy')) {
        cues.add('copy');
        showCopy();
      }
      raf = requestAnimationFrame(frame);
    }

    /* ══════════════ the win ══════════════ */
    function drawWin(ctx, cx, floorY, S, dt) {
      // the chest, placed by its body rather than by its frame
      const fw = (S * 1.25) / BODY.w;          // frame width that gives that body
      const chestX = cx - fw * BODY.cx;        // frame left, so body centre = cx
      const chestTop = floorY - fw * BODY.base;
      const mouthY = chestTop + fw * BODY.mouth;
      const lipY = chestTop + fw * BODY.lip;
      const faceY = chestTop + fw * BODY.face;
      /* Where the prize comes to rest: measured off the open lid, not off the
       * viewport. Resting at a fixed fraction of the stage put it near the top
       * of the screen with dead air between it and the chest — the two have to
       * read as one object and its box. */
      const restY = Math.max(S * 0.6, chestTop + fw * BODY.lidTop - S * 0.55);

      const land  = span(t, ph.land);
      const hum   = ph.hum ? span(t, ph.hum) : 0;
      const open  = span(t, ph.open);
      const show  = span(t, ph.show);
      const arc   = span(t, ph.arc);
      const snap  = span(t, ph.snap);
      const seal  = span(t, ph.seal);
      /* the opening stays lit from when the lid clears it until the lid lands */
      const spill = clamp01(open * 1.4) * (1 - snap);

      cue('land', ph.land[0] + 0.22, () => play('click', { volume: .28, rate: .7 }));
      if (big) cue('hum', ph.hum[0], () => play('orb', { volume: .3, rate: .6 }));
      cue('open', ph.open[0], () => play('chestopen', { volume: .5 }));
      cue('show', ph.show[0], () => play('orb', { volume: .45, rate: 1.15 }));
      cue('toss', ph.arc[0], () => play('click', { volume: .3, rate: 1.5 }));
      /* The landing: lid down, chest takes the weight, dust off the rim. This is
       * the beat the whole shot is built around, so everything lands together —
       * sound, shake, ring and particles on the same frame. */
      cue('snap', ph.snap[0] + (big ? 0.10 : 0.05), () => {
        play('chestclosed', { volume: .6 });
        shake = big ? 1 : 0.55;
        ringT = 0;
        for (let i = 0; i < (big ? 46 : 20); i++) {
          const a = Math.random() * Math.PI * 2;
          const sp = 70 + Math.random() * 190;
          sparks.spawn(cx + Math.cos(a) * S * 0.42, mouthY,
            Math.cos(a) * sp, -40 - Math.random() * 110,
            0.5 + Math.random() * 0.7, 2 + Math.random() * 3, 0);
        }
      });

      const e1 = EASE.settle(land);
      const drop0 = (1 - e1) * S * 0.30;
      const chestY = chestTop + drop0;

      /* ── Stage 1: the setup ──
       * Key light from above, and the block sitting in its own contact shadow.
       * Without the shadow the chest floats on the background no matter how
       * well it is lit; ambient occlusion is what puts an object on a floor. */
      if (big && assets.cone) {
        const cw = S * 3.0, chh = floorY - chestTop + S * 1.6;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.30 * e1 * (1 - seal * 0.5);
        ctx.drawImage(assets.cone, cx - cw / 2, chestTop - S * 1.5, cw, chh);
        ctx.restore();
      }
      if (assets.ao) {
        const aw = S * 2.3 * (0.86 + e1 * 0.14), ah = aw * 0.30;
        ctx.save();
        ctx.globalAlpha = 0.85 * e1;
        ctx.drawImage(assets.ao, cx - aw / 2, floorY - ah * 0.52, aw, ah);
        ctx.restore();
      }

      /* ── the resonance ──
       * The obsidian frame swells very slightly and settles, twice, as the void
       * inside it wakes up. 1.2% is deliberately almost nothing: at any more
       * than that a pixel-art sprite visibly resamples and the whole block
       * shimmers instead of breathing. */
      const res = big ? Math.sin(hum * Math.PI * 2) * (1 - hum) * 0.012 : 0;

      /* ── the lid ──
       * The frames run backwards to open (shut..c0) on a heavy curve — reluctant
       * off the mark, quick through the middle, slow into the stop — and then
       * forwards again to snap. The snap curve is deliberately the harsher of
       * the two: a lid falls under its own weight, so it accelerates the whole
       * way and arrives, where lifting one has to be eased at both ends.
       *
       * Rounding rather than flooring the frame index keeps the first and last
       * frames on screen for their full share of the beat instead of a half. */
      const N = assets.lid.length;
      const openness = snap > 0 ? (1 - EASE.snap(snap)) : EASE.lid(open);
      const f = N - 1 - Math.round(openness * (N - 1));
      const im = assets.lid[Math.max(0, Math.min(N - 1, f))];
      if (im) {
        ctx.save();
        ctx.globalAlpha = e1;
        /* The whole block takes the weight for a beat when the lid lands: it
         * squashes on its vertical axis and springs back. Anchored to the base
         * so the chest stays on the floor while it compresses. */
        const hit = snap > 0 ? Math.max(0, Math.sin(clamp01((snap - 0.55) / 0.45) * Math.PI)) : 0;
        if (res || hit) {
          ctx.translate(cx, floorY);
          ctx.scale(1 + res + hit * 0.035, 1 + res - hit * 0.05);
          ctx.translate(-cx, -floorY);
        }
        ctx.drawImage(im, chestX, chestY, fw, fw);
        ctx.restore();
      }

      /* ── the void in the core ──
       * Visible while the chest is still shut: the front face glows with
       * something a long way further in than the back of the box. It fades out
       * as the lid opens, because by then the opening itself is the light. */
      if (big && assets.void_ && open < 0.9) {
        const vk = Math.min(1, hum * 1.5) * (1 - open) * (0.65 + 0.35 * Math.sin(t * 5.5));
        if (vk > 0.01) {
          const vw = S * 0.92, vh = vw * 0.8;
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = 0.8 * vk;
          ctx.drawImage(assets.void_, cx - vw / 2, faceY - vh / 2, vw, vh);
          ctx.restore();
          // motes orbiting inside it, drawn tight so they stay within the face
          if (Math.random() < dt * 34) {
            const a = Math.random() * Math.PI * 2;
            const r = S * (0.10 + Math.random() * 0.16);
            sparks.spawn(cx + Math.cos(a) * r, faceY + Math.sin(a) * r * 0.7,
              -Math.cos(a) * 26, -Math.sin(a) * 20, 0.55, 2, 1);
          }
        }
      }

      /* ── the opening, lit ── */
      if (spill > 0 && assets.glow) {
        const gw = S * (1.5 + spill * 0.7), gh = gw * 0.52;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.42 * spill;
        ctx.drawImage(assets.glow, cx - gw / 2, mouthY - gh * 0.5, gw, gh);
        ctx.restore();
        // dust lifting through the shaft: slow, drifting, barely there
        if (big && Math.random() < dt * 70 * spill) {
          sparks.spawn(cx + (Math.random() - 0.5) * S * 0.9, mouthY + S * 0.05,
            (Math.random() - 0.5) * 26, -28 - Math.random() * 52,
            1.1 + Math.random() * 0.9, 1.5 + Math.random() * 1.5, 2);
        }
      }

      /* ── the prize: presented, then thrown in ──
       *
       * Two beats on one path. `show` floats it up to a hover off to one side
       * of the chest and turns it there; `arc` throws it across and down into
       * the mouth. The arc is a real parabola, not a lerp with a curve on it:
       * x travels linearly across, y is the straight line between the two points
       * plus a lift term that peaks in the middle. That is what makes it read as
       * thrown — it keeps rising for a moment after it has started moving
       * sideways, then falls away faster than it rose.
       *
       * The motion blur is accumulation, not a filter: the sprite redrawn at the
       * positions it actually occupied on previous frames, each fainter than the
       * last. That is how motion blur works physically, it follows the tumble as
       * well as the travel, and it costs one blit per ghost. A CSS or SVG filter
       * cannot be used here at all — the sprite is a drawImage on a canvas, not
       * an element, so there is nothing to attach a filter to. Ghost count comes
       * from measured speed, so it falls to zero on its own. */
      if (sprite && show > 0 && snap < 0.55) {
        const eShow = EASE.lift(show);
        const eArc = EASE.toss(arc);

        // where it is presented: up and to the left of the chest mouth
        const holdX = cx - S * 0.62;
        const holdY = restY;
        const fromY = holdY + S * 1.5;                 // it floats up into frame

        // the two beats, blended by which one is live
        let x, y, box, spin;
        if (arc <= 0) {
          x = holdX;
          y = fromY + (holdY - fromY) * eShow + Math.sin(t * 2.4) * S * 0.022 * show;
          box = S * (0.74 + 0.26 * eShow);
          spin = (t - ph.show[0]) * 2.0;
        } else {
          // straight line from the hover to the mouth, plus a parabolic lift
          const tx = cx, ty = mouthY + S * 0.10;
          const lift = Math.sin(Math.PI * arc) * S * 0.42;
          x = holdX + (tx - holdX) * eArc;
          y = holdY + (ty - holdY) * eArc - lift;
          // it shrinks as it drops in, both from distance and from going inside
          box = S * (1.0 - 0.52 * eArc);
          spin = (t - ph.show[0]) * 2.0 + eArc * 7.5;  // it tumbles as it flies
        }

        // a flat sprite turning on its vertical axis: never edge-on, so it
        // stays readable the whole way
        const turn = 0.82 + 0.18 * Math.cos(spin);
        const lean = arc > 0 ? eArc * 0.85 : (1 - eShow) * -0.10;

        // push this frame onto the history ring
        const slot = (trailN % 4) * 4;
        trail[slot] = x; trail[slot + 1] = y; trail[slot + 2] = box; trail[slot + 3] = turn;
        trailN++;

        ctx.save();
        /* Once it is past the rim the chest hides it. Clipping to above the lip
         * only while the arc is landing means the prize visibly disappears INTO
         * the box rather than in front of it. */
        if (arc > 0.55) {
          ctx.beginPath();
          ctx.rect(0, 0, W, lipY);
          ctx.clip();
        }

        let px = x, py = y;
        if (trailN > 1) {
          const q = ((trailN - 2) % 4) * 4;
          px = trail[q]; py = trail[q + 1];
        }
        const speed = Math.hypot(x - px, y - py) / Math.max(dt, 1e-4);   // px/sec
        const blur = big ? clamp01(speed / (S * 5.5)) : 0;
        const ghosts = Math.min(3, Math.round(blur * 3));
        // read-out for the motion-blur test: counting blits from outside cannot
        // tell a ghost from the glow pass, both being faint additive draws
        window.__rvlBlur = ghosts;

        ctx.globalCompositeOperation = 'lighter';
        for (let g = ghosts; g >= 1; g--) {
          const idx = trailN - 1 - g;
          if (idx < 0) continue;
          const q = (idx % 4) * 4;
          // the oldest ghost is the faintest; the whole trail fades as it slows
          ctx.globalAlpha = 0.42 * blur * (1 - g / (ghosts + 1));
          ctx.save();
          ctx.translate(trail[q], trail[q + 1]);
          ctx.scale(trail[q + 3], 1);
          blit(ctx, sprite, 0, 0, trail[q + 2]);
          ctx.restore();
        }

        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = Math.min(1, show * 3.4) * (1 - clamp01((arc - 0.82) / 0.18));
        ctx.translate(x, y);
        ctx.rotate(lean);
        ctx.scale(turn, 1);
        blit(ctx, sprite, 0, 0, box);
        ctx.globalCompositeOperation = 'lighter';      // it carries its own light
        ctx.globalAlpha = 0.30 * (1 - eShow) + 0.12;
        blit(ctx, tint(sprite, '#ffffff'), 0, 0, box);
        ctx.restore();
      }

      // the burst as it clears the rim
      if (ringT >= 0) {
        ringT += dt;
        const k = ringT / 0.6;
        if (k >= 1) ringT = -1;
        else {
          ctx.save();
          ctx.globalAlpha = (1 - k) * (1 - k) * 0.30;
          // the snap ring is the room's rose, not the item's rarity — the lid
          // closing is the chest's moment, and the item has already gone in
          ctx.strokeStyle = '#ffaa00';
          ctx.lineWidth = Math.max(1, S * 0.03 * (1 - k));
          ctx.beginPath();
          const rx = S * (0.45 + k * 1.35);
          ctx.ellipse(cx, mouthY, rx, rx * 0.32, 0, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }
      }

      sparks.step(dt, -34, 0.7);
      // rose dust off the rim, an amber core spark, pale motes in the shaft.
      // #ffaa00 is the upgrader's own rose: this shot only ever plays from that
      // page, so the particles carry that room's light rather than the site's
      // softer one.
      sparks.draw(ctx, ['#ffaa00', '#ffaa00', 'rgba(255,226,170,.85)'], true);
    }

    /* ══════════════ the loss ══════════════ */
    function drawLose(ctx, cx, cy, floorY, S, dt) {
      const fall  = span(t, ph.fall);
      const surge = span(t, ph.surge);
      const burn  = span(t, ph.burn);
      const slag  = span(t, ph.slag);

      /* The magma climbs to meet the item rather than sitting there waiting
       * for it. A static pool is scenery; a surge is a thing that happens.
       *
       * The hole is a fixed ellipse and the molten rock fills it from the
       * bottom up. The first attempt drew the lava as a wavy-topped rectangle,
       * which on a dark page reads as an orange slab with two hard vertical
       * cuts down its sides — a wall, not a pool. Clipping every part of it to
       * the ellipse is what turns those cuts into a rim. */
      const poolY = floorY - S * 0.34;
      const poolW = S * 1.15;                        // the hole, half-width
      const poolH = S * 0.42;                        // and half-height, in perspective
      const fill = EASE.surge(surge);
      const topY = poolY - poolH * 0.62;             // where the surface ends up
      const surfY = poolY + poolH - fill * (poolY + poolH - topY);

      const wave = (x) => {
        const u = (x - (cx - poolW)) / (poolW * 2);
        return Math.sin(u * 7.1 + t * 3.1) * S * 0.026
             + Math.sin(u * 13.7 - t * 4.6) * S * 0.014
             + Math.sin(u * 3.3 + t * 1.7) * S * 0.020;
      };

      cue('hit', ph.burn[0], () => {
        play('fizz', { volume: .7 });
        shake = 0.85;
        for (let i = 0; i < 54; i++) {
          const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.6;
          const sp = 130 + Math.random() * 320;
          sparks.spawn(cx + (Math.random() - 0.5) * S * 0.8, topY,
            Math.cos(a) * sp, Math.sin(a) * sp, 0.6 + Math.random() * 0.8,
            2 + Math.random() * 3, 0);
        }
      });
      cue('gone', ph.slag[0] + 0.35, () => play('fizz', { volume: .32, rate: .62 }));

      // the hole itself: a dark socket, there before anything fills it
      ctx.save();
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = 'rgba(10,4,2,.92)';
      ctx.beginPath();
      ctx.ellipse(cx, poolY, poolW, poolH, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      /* ── the molten body ──
       * Clipped to the hole, filled from the wavy surface line downwards, and
       * textured with the vanilla lava strip tiled at its own scale rather than
       * stretched to fit. */
      if (assets.lava && fill > 0.01) {
        const fr = Math.floor(t / 0.1) % 20;
        const L = cx - poolW, R = cx + poolW;
        ctx.save();
        ctx.beginPath();
        ctx.ellipse(cx, poolY, poolW, poolH, 0, 0, Math.PI * 2);
        ctx.clip();                                  // everything stays in the hole

        ctx.beginPath();
        ctx.moveTo(L, surfY + wave(L));
        for (let x = L; x <= R; x += 6) ctx.lineTo(x, surfY + wave(x));
        ctx.lineTo(R, poolY + poolH + 2);
        ctx.lineTo(L, poolY + poolH + 2);
        ctx.closePath();
        ctx.save();
        ctx.clip();
        const cell = S * 0.30;
        for (let x = L; x < R; x += cell) {
          for (let y = surfY - cell; y < poolY + poolH + cell; y += cell) {
            ctx.drawImage(assets.lava, 0, fr * 16, 16, 16, x, y, cell, cell);
          }
        }
        // bubbles rising through it, swelling and popping at the surface
        ctx.globalCompositeOperation = 'lighter';
        for (let bb = 0; bb < 7; bb++) {
          const seed = bb * 1.37;
          const cyc = (t * (0.55 + bb * 0.07) + seed) % 1;
          const bx = cx + Math.sin(seed * 9.3) * poolW * 0.74;
          const by = (poolY + poolH) - cyc * (poolY + poolH - surfY);
          const r = S * 0.032 * Math.sin(cyc * Math.PI);
          if (r <= 0.2) continue;
          ctx.globalAlpha = 0.55 * Math.sin(cyc * Math.PI);
          ctx.fillStyle = '#ffd68a';
          ctx.beginPath();
          ctx.arc(bx, by, r, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();

        // the cooled skin where the molten rock meets the air
        ctx.globalCompositeOperation = 'source-over';
        ctx.strokeStyle = 'rgba(26,8,3,.85)';
        ctx.lineWidth = Math.max(1.5, S * 0.020);
        ctx.beginPath();
        ctx.moveTo(L, surfY + wave(L));
        for (let x = L; x <= R; x += 6) ctx.lineTo(x, surfY + wave(x));
        ctx.stroke();
        ctx.restore();
      }

      // the rim of the hole, drawn last so it sits over the lava
      ctx.save();
      ctx.strokeStyle = 'rgba(24,9,4,.95)';
      ctx.lineWidth = Math.max(2, S * 0.045);
      ctx.beginPath();
      ctx.ellipse(cx, poolY, poolW, poolH, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.25 * fill;
      ctx.strokeStyle = '#ff8a2b';
      ctx.lineWidth = Math.max(1, S * 0.014);
      ctx.beginPath();
      ctx.ellipse(cx, poolY, poolW * 0.985, poolH * 0.96, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      {
        // the heat this thing throws
        if (assets.heat) {
          const hw = poolW * 2.6, hh = hw * 0.7;
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = 0.34 * fill;
          ctx.drawImage(assets.heat, cx - hw / 2, surfY - hh * 0.62, hw, hh);
          ctx.restore();
        }

        // embers off the surface
        if (Math.random() < dt * 150 * fill) {
          sparks.spawn(cx + (Math.random() - 0.5) * poolW * 1.7, surfY,
            (Math.random() - 0.5) * 40, -60 - Math.random() * 130,
            0.8 + Math.random() * 0.9, 1.5 + Math.random() * 2.5, 0);
        }
      }

      /* The shimmer goes in here, under the subject. Run after the item is
       * drawn and it displaces the item as well, which reads as a rendering
       * fault rather than as heat coming off the rock. */
      /* ── heat haze ──
       * A real displacement, not a blur: the band of canvas above the surface is
       * copied off and drawn back one thin row at a time, each row shifted
       * sideways by a travelling wave. It has to go through a scratch canvas —
       * drawing a canvas onto itself with overlapping source and destination
       * smears rather than displaces. Runs over a band a few hundred pixels
       * tall, so it is a couple of dozen small blits. */
      if (!reduce && surge > 0.05 && scratch) {
        const bandH = Math.round(S * 1.15);
        const bandY = Math.round(topY - bandH);
        const bandW = Math.round(Math.min(W, poolW * 2.6));
        const bandX = Math.round(cx - bandW / 2);
        if (bandH > 8 && bandW > 8 && bandY > 0) {
          if (scratch.width !== bandW || scratch.height !== bandH) {
            scratch.width = bandW; scratch.height = bandH;
          }
          sctx.clearRect(0, 0, bandW, bandH);
          sctx.drawImage(canvas,
            bandX * dpr, bandY * dpr, bandW * dpr, bandH * dpr,
            0, 0, bandW, bandH);
          const ROW = 7;
          const amp = S * 0.035 * fill;
          ctx.clearRect(bandX, bandY, bandW, bandH);
          for (let i = 0; i < bandH; i += ROW) {
            const h = Math.min(ROW, bandH - i);
            const v = i / bandH;
            // strongest just above the surface, gone by the top of the band
            const k = v * v;
            const off = Math.sin(v * 11 + t * 6.2) * amp * k
                      + Math.sin(v * 5.3 - t * 3.7) * amp * 0.6 * k;
            ctx.drawImage(scratch, 0, i, bandW, h, bandX + off, bandY + i, bandW, h);
          }
        }
      }

      /* ── the item ──
       * It falls, flashes white on contact, cools to black slag, and is clipped
       * to everything above the surface as it goes under. Without that cut it
       * shrinks on top of the lava and its lower half hangs below the near rim,
       * reading as "in front of" rather than "into". */
      if (sprite && slag < 0.95) {
        const y = cy + easeIn(fall) * (topY - cy) + easeIn(slag) * S * 0.85;
        const box = S * (1 - slag * 0.38);
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, W, topY + S * 0.05);
        ctx.clip();
        ctx.globalAlpha = 1 - clamp01((slag - 0.5) / 0.5);
        ctx.translate(cx, y);
        ctx.rotate(fall * 1.6 + slag * 0.5);
        blit(ctx, sprite, 0, 0, box);
        // crust creeps over it as it cools
        if (slag > 0) {
          ctx.globalAlpha = Math.min(0.9, slag * 1.5);
          blit(ctx, tint(sprite, '#140a06'), 0, 0, box);
        }
        ctx.globalCompositeOperation = 'lighter';
        if (burn > 0) {                            // white at the moment it lands
          ctx.globalAlpha = Math.sin(clamp01(burn) * Math.PI) * 0.95;
          blit(ctx, tint(sprite, '#ffffff'), 0, 0, box);
        }
        if (slag > 0) {                            // then it glows through the crust
          ctx.globalAlpha = Math.max(0, 0.85 - slag * 0.8);
          blit(ctx, tint(sprite, '#ff7a1a'), 0, 0, box);
        }
        ctx.restore();

        // ash coming off it as the crust breaks up
        if (slag > 0.15 && Math.random() < dt * 90) {
          sparks.spawn(cx + (Math.random() - 0.5) * box * 0.7, y - box * 0.2,
            (Math.random() - 0.5) * 50, -40 - Math.random() * 70,
            0.9 + Math.random() * 0.8, 1.5 + Math.random() * 2, 3);
        }
      }

      sparks.step(dt, -120, 0.6);
      sparks.draw(ctx, ['#ff7b00', '#ffd479', 'rgba(226,240,255,.8)', '#6b6560'], false);

    }

    function showCopy() {
      copy.dataset.on = '1';
      const node = $('#rvlPay', pane);
      if (!won || !node || reduce) return;
      // counts up from zero into the figure the layout was already sized for
      const t0 = performance.now();
      const up = () => {
        const k = clamp01((performance.now() - t0) / 800);
        node.textContent = money(Math.round(payout * easeOut(k)));
        if (k < 1) requestAnimationFrame(up);
      };
      up();
    }

    const done = () => {
      cancelAnimationFrame(raf);
      $('#rvlBtn', pane).removeEventListener('click', done);
      pane.hidden = true;
      resolve();
    };
    $('#rvlBtn', pane).addEventListener('click', done);
    raf = requestAnimationFrame(frame);
  }));
}
