/* fx.js — the shared 2D primitives behind every cinematic on the site.
 *
 * The upgrader reveal and the case-opening cutscene are different films, but
 * they are shot on the same equipment: the same easing solver, the same
 * particle pool, the same pre-rendered lights, the same sprite blitter. Those
 * lived in reveal.js and were about to be copied wholesale into cutscene.js,
 * which is how two animations start disagreeing about what "ease out" means.
 *
 * THE ONE RULE
 * ------------
 * Anything expensive is rendered ONCE into an offscreen canvas and then
 * blitted. Nothing in a frame loop may build a gradient. That is not a style
 * preference: a viewport-scale radial gradient rasterised per frame measured as
 * a third of all frames missing their 16.7ms deadline, and moving it offscreen
 * took the whole scene to 0.12ms.
 */

/* ─────────── maths ─────────── */

export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Local 0..1 progress through a [start, end] window on a timeline. */
export const span = (t, [a, b]) => clamp01((t - a) / (b - a));

export const easeOut = (x) => 1 - Math.pow(1 - x, 3);
export const easeIn = (x) => x * x;
export const easeInOut = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);

/* Blend between two values on a curve. */
export const mix = (a, b, k) => a + (b - a) * k;

/**
 * cubic-bezier(x1,y1,x2,y2) as a function of t, Newton-solved on x.
 *
 * Power curves cannot express what motion design actually needs: a lid with
 * weight is slow to start AND slow to stop with speed through the middle; a
 * levitation is eased off the mark and then hangs; a thrown object floats out
 * and drops away. All three are beziers, so solve beziers.
 */
export function bezier(x1, y1, x2, y2) {
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

/** The house curves. Everything on the site eases on one of these. */
export const EASE = {
  lid:    bezier(0.62, 0.03, 0.20, 1.00),   // heavy: reluctant, then settles open
  lift:   bezier(0.34, 0.08, 0.22, 1.00),   // ascent: eases up, then hangs
  settle: bezier(0.22, 1.00, 0.36, 1.00),   // arrivals
  toss:   bezier(0.40, 0.00, 0.72, 0.36),   // thrown: floats out, then drops away
  snap:   bezier(0.70, 0.00, 0.30, 1.00),   // falling under its own weight
  surge:  bezier(0.30, 0.00, 0.15, 1.00),   // liquid climbing a wall
  camIn:  bezier(0.30, 0.00, 0.10, 1.00),   // a camera push: commits, then arrives
  camOut: bezier(0.16, 0.90, 0.30, 1.00),   // a camera pull: leaves hard, drifts in
  glide:  bezier(0.44, 0.00, 0.20, 1.00),   // a dolly across
};

/* ─────────── sprites ─────────── */

/**
 * Draw a sprite centred on (x,y), fitted to `box` on its longer side.
 *
 * Not every sprite is square — elytra.png is 449x696 — and forcing one into a
 * square box turns the most expensive item on the site into an unreadable
 * smear. Fit by the longer side and the aspect survives.
 */
export function blit(ctx, im, x, y, box) {
  const k = box / Math.max(im.width, im.height);
  const w = im.width * k, h = im.height * k;
  ctx.drawImage(im, x - w / 2, y - h / 2, w, h);
}

/**
 * A flat-coloured copy of a sprite in its exact silhouette, built once and kept.
 *
 * Drawing a sprite over itself with 'lighter' only brightens what is already
 * bright — it whitens an elytra fine and does nothing at all to a dark item —
 * and it can never shift the hue, so it cannot make anything look like it is
 * burning, or cooled to slag, or backlit. A silhouette does both, for one blit.
 */
const tints = new Map();
export function tint(im, colour) {
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

/* ─────────── pre-rendered lights ─────────── */

/**
 * A radial falloff, rendered once at a fixed size and blitted at whatever scale
 * the shot needs. `stops` is a list of [offset, css colour] pairs.
 */
export function radial(stops, R = 128) {
  const c = document.createElement('canvas');
  c.width = R * 2; c.height = R * 2;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(R, R, 0, R, R, R);
  for (const [o, col] of stops) g.addColorStop(o, col);
  x.fillStyle = g;
  x.fillRect(0, 0, R * 2, R * 2);
  return c;
}

/**
 * A soft-edged light cone, wide at the bottom.
 *
 * A cone is not a radial falloff, so it is built as a stack of horizontal bands
 * each with its own horizontal gradient and alpha, rather than as a gradient
 * shape. Rendered once at 256x256 and stretched to whatever the shot needs.
 */
export function makeCone(W = 256, H = 256) {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  for (let i = 0; i < H; i++) {
    const v = i / (H - 1);
    const halfW = (0.06 + v * 0.44) * W;       // opens out as it descends
    const a = Math.sin(v * Math.PI) * 0.5 * (1 - v * 0.35);
    const g = x.createLinearGradient(W / 2 - halfW, 0, W / 2 + halfW, 0);
    g.addColorStop(0, 'rgba(214,235,255,0)');
    g.addColorStop(0.5, `rgba(226,240,255,${a.toFixed(4)})`);
    g.addColorStop(1, 'rgba(214,235,255,0)');
    x.fillStyle = g;
    x.fillRect(W / 2 - halfW, i, halfW * 2, 1);
  }
  return c;
}

/**
 * A single soft fog puff. Several of these drifting at different scales and
 * speeds is atmosphere; one big one is a smudge.
 */
export function makeFog(R = 96) {
  return radial([
    [0, 'rgba(150,170,220,.13)'],
    [0.45, 'rgba(120,140,190,.07)'],
    [1, 'rgba(100,120,170,0)'],
  ], R);
}

/* ─────────── particles ─────────── */

/**
 * One flat pool, no allocation per frame. Everything is a small square, because
 * every other thing on screen is made of small squares.
 *
 * The palette index is carried per particle so dust, embers, ash and firework
 * sparks can share a single pool and still be drawn one colour at a time —
 * fillStyle is then set once per colour instead of once per particle.
 */
export function pool(n) {
  const F = 8;                                  // x y vx vy life max size pal
  const p = new Float32Array(n * F);
  let head = 0;
  return {
    spawn(x, y, vx, vy, life, size, pal = 0) {
      const i = (head = (head + 1) % n) * F;
      p[i] = x; p[i + 1] = y; p[i + 2] = vx; p[i + 3] = vy;
      p[i + 4] = life; p[i + 5] = life; p[i + 6] = size; p[i + 7] = pal;
    },
    /** `g` is gravity in px/s^2 (negative floats upward); `drag` is per second. */
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

/* ─────────── hue surgery ─────────── */

/**
 * Recolour a sprite's violet pixels to amber, once, and keep the result.
 *
 * The zero-purple rule covers assets, and Mojang's ender chest render has
 * purple baked into it: the ambient end particles around the block and the
 * violet cast on its trim. No amount of CSS reaches inside a PNG, so the
 * pixels are remapped here at load time.
 *
 * It works in HSL and only touches hues between 250 and 330 degrees, which is
 * exactly the violet-through-magenta wedge and nothing else. The block's teal
 * portal face sits at ~175 degrees and is untouched, so the chest keeps its
 * character and only loses the hue the palette does not contain. Saturation and
 * lightness are carried across unchanged, so the shading survives intact —
 * this is a hue rotation, not a tint, and a tint would flatten the render.
 */
/* WHICH SPRITES GET REMAPPED, AND WHY IT IS A LIST
 *
 * The first attempt inferred it: remap any pixel in the violet hue wedge above
 * a saturation floor, on the theory that real purple is saturated and dark
 * Minecraft rock is not. Measuring the actual distributions killed that idea —
 * the violet-hued pixels in these sprites sit at:
 *
 *     netherite_sword      sat p50 0.287
 *     obsidian             sat p50 0.367
 *     ender_chest          sat p50 0.360
 *     shulker_box          sat p50 0.181
 *     dragon_egg           sat p50 0.957
 *
 * Netherite lands between shulker and obsidian. There is no floor that catches
 * the shulker box and the chest while sparing netherite, because "is this a
 * purple accent or is this dark metal" is not a fact about the pixels — it is a
 * fact about the artwork. So it is declared, per sprite, and reviewable.
 *
 * On the list: sprites that read as purple on screen.
 * Off the list: netherite (brown-black), and anything else whose hue only
 * grazes the wedge. */
const PURPLE_SPRITES = new Set([
  'shulker_box.gif',
  'dragon_egg.png',
  'obsidian.png',
  'god_apple.png',
  'spawner.png',
  'ender_chest.png', 'ender_chest_open.png', 'ender_chest_shut.png',
  'ender_chest_c0.png', 'ender_chest_c1.png', 'ender_chest_c2.png',
  'ender_chest_c3.png', 'ender_chest_c4.png',
  'chest_ender.png',
]);

/**
 * Remap a sprite only if it is one of the ones that actually reads as purple.
 * Everything else is handed back untouched, so netherite stays netherite.
 */
export function deviolet(im) {
  if (!im || !im.src) return im;
  const name = im.src.split('/').pop().split('?')[0];
  return PURPLE_SPRITES.has(name) ? dePurple(im) : im;
}

const recoloured = new Map();
export function dePurple(im, targetHue = 38) {
  if (!im) return im;
  const key = im.src + '@' + targetHue;
  let c = recoloured.get(key);
  if (c) return c;

  c = document.createElement('canvas');
  c.width = im.width; c.height = im.height;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(im, 0, 0);
  let d;
  try {
    d = x.getImageData(0, 0, c.width, c.height);
  } catch (_) {
    // a cross-origin sprite taints the canvas; better the original than nothing
    recoloured.set(key, im);
    return im;
  }
  const px = d.data;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    const r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), delta = mx - mn;
    if (delta < 0.04) continue;                 // greys have no hue to move
    let h;
    if (mx === r) h = ((g - b) / delta) % 6;
    else if (mx === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h *= 60; if (h < 0) h += 360;
    if (h < 250 || h > 335) continue;           // the violet..magenta wedge only

    const l = (mx + mn) / 2;
    const sat = l > 0.5 ? delta / (2 - mx - mn) : delta / (mx + mn);
    // back to rgb at the new hue, same saturation and lightness
    const cc = (1 - Math.abs(2 * l - 1)) * sat;
    const hp = targetHue / 60;
    const xx = cc * (1 - Math.abs((hp % 2) - 1));
    let r1 = 0, g1 = 0, b1 = 0;
    if (hp < 1) { r1 = cc; g1 = xx; }
    else if (hp < 2) { r1 = xx; g1 = cc; }
    else if (hp < 3) { g1 = cc; b1 = xx; }
    else if (hp < 4) { g1 = xx; b1 = cc; }
    else if (hp < 5) { r1 = xx; b1 = cc; }
    else { r1 = cc; b1 = xx; }
    const m = l - cc / 2;
    px[i] = Math.round((r1 + m) * 255);
    px[i + 1] = Math.round((g1 + m) * 255);
    px[i + 2] = Math.round((b1 + m) * 255);
  }
  x.putImageData(d, 0, 0);
  recoloured.set(key, c);
  return c;
}

/* ─────────── image loading ─────────── */

const cache = new Map();
/** Decode an image once and hand the same promise to every later caller. */
export function img(src) {
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

/* ─────────── motion blur ─────────── */

/**
 * A ring of recent transforms, for accumulation motion blur.
 *
 * The blur is not a filter. The sprite is redrawn at the positions and
 * orientations it ACTUALLY occupied on previous frames, each fainter than the
 * last. That is how motion blur works physically: it follows a tumble as
 * faithfully as a translation, it bends around a curved path, and it costs one
 * blit per ghost. It is also the only option available here — the subject is a
 * drawImage on a canvas, not an element, so there is nothing for a CSS or SVG
 * filter to attach to.
 *
 * Ghost count is driven by measured speed, so the trail thins out and vanishes
 * on its own as the subject slows. Nothing has to remember to turn it off, and
 * the subject snaps to full clarity the instant it settles.
 */
export function trail(len = 6, fields = 5) {
  const buf = new Float32Array(len * fields);
  let n = 0;
  return {
    /** Record this frame's transform. `vals` must be `fields` long. */
    push(vals) {
      const i = (n % len) * fields;
      for (let k = 0; k < fields; k++) buf[i + k] = vals[k];
      n++;
    },
    /** The transform `back` frames ago, or null if it has not happened yet. */
    at(back) {
      const idx = n - 1 - back;
      if (idx < 0) return null;
      const i = (idx % len) * fields;
      return buf.subarray(i, i + fields);
    },
    get count() { return n; },
    get max() { return len; },
    clear() { buf.fill(0); n = 0; },
  };
}
