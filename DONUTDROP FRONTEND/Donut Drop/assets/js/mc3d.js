/* mc3d.js — the Minecraft-in-WebGL primitives every 3D scene on the site shares.
 *
 * Two scenes needed the same chest, the same atlas unwrap and the same particle
 * system, and a third was about to. Rather than let three copies of the UV maths
 * drift apart, they live here once: the atlas cropper, the vanilla box unwrap,
 * block textures, the additive spark pool, and the chest itself.
 *
 * Three is loaded once and shared. The dynamic import is cached by the browser,
 * so a second caller gets the same module object rather than a second download.
 *
 * It is served from this origin, not from a CDN. The page ships script-src 'self', so the CDN
 * copy was blocked outright and every 3D scene on the site silently failed to start — the hero
 * chest, the reveal, the upgrader wheel. Relaxing the policy to admit a third-party origin would
 * have meant trusting a host that can change what it serves at any time to run code with full
 * access to a logged-in session. Vendoring the file keeps the policy at 'self' and makes the
 * dependency something that ships, gets reviewed, and cannot change underneath us.
 */

import { dePurple } from './fx.js';

const THREE_URL = new URL('../vendor/three.module.min.js', import.meta.url).href;
export const PX = 1 / 16;                // one Minecraft pixel in world units

let THREE = null;
let loading = null;

export async function getTHREE() {
  if (THREE) return THREE;
  if (!loading) loading = import(/* @vite-ignore */ THREE_URL).then((m) => (THREE = m));
  return loading;
}

export function loadImage(src) {
  return new Promise((res, rej) => {
    const i = new Image();
    i.crossOrigin = 'anonymous';
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = src;
  });
}

/* Crop a region out of an atlas into its own nearest-filtered texture. */
export function crop(img, x, y, w, h, flip = false) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  if (flip) { ctx.translate(w, 0); ctx.scale(-1, 1); }
  ctx.drawImage(img, x, y, w, h, 0, 0, w, h);
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* Six materials in Three's face order: +X, -X, +Y, -Y, +Z, -Z.
 * Minecraft unwraps a w x h x d box at atlas offset (u, v) like this:
 *   row 1 (v .. v+d)      : top at u+d, bottom at u+d+w
 *   row 2 (v+d .. v+d+h)  : right at u, back at u+d, left at u+d+w, front at u+d+w+d
 */
export function boxMats(img, u, v, w, h, d) {
  const mk = (x, y, cw, ch, flip) => new THREE.MeshLambertMaterial({
    map: crop(img, x, y, cw, ch, flip), transparent: false,
  });
  return [
    mk(u, v + d, d, h),                    // +X right
    mk(u + d + w, v + d, d, h),            // -X left
    mk(u + d, v, w, d),                    // +Y top
    mk(u + d + w, v, w, d, true),          // -Y bottom
    mk(u + d + w + d, v + d, w, h),        // +Z front
    mk(u + d, v + d, w, h),                // -Z back
  ];
}

/* A block texture as its own nearest texture. Animated blocks ship as a vertical
 * strip of 16x16 frames, so take the one asked for. */
export function blockTex(img, frame = 0, repeat = 1) {
  const t = crop(img, 0, frame * 16, 16, 16);
  if (repeat !== 1) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat, repeat);
  }
  return t;
}

/* A soft round dot for additive particles. Nothing in Minecraft is round, but
 * these are light rather than matter, and light has no pixels. */
export function softDot(inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)') {
  /* The gradient has to reach zero BEFORE the bitmap edge.
   *
   * Drawn edge to edge, the corners of a radial gradient still carry alpha —
   * the gradient is circular, the canvas is square, so the corners sit at
   * 1.41x the radius and clamp-to-edge then smears that leftover value along
   * every border. That is the hard rectangle showing up around every glow on
   * the site. Ending the ramp at 70% of the half-width puts real zeros in the
   * corners and leaves a clean transparent margin all the way round. */
  const S = 128, H = S / 2;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(H, H, 0, H, H, H * 0.7);
  g.addColorStop(0, inner);
  g.addColorStop(0.35, 'rgba(255,255,255,.55)');
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  // belt and braces: clear a transparent frame so no filter tap can reach ink
  ctx.clearRect(0, 0, S, 2); ctx.clearRect(0, S - 2, S, 2);
  ctx.clearRect(0, 0, 2, S); ctx.clearRect(S - 2, 0, 2, S);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/* An additive point cloud that both drifts and bursts. Fading is done with a
 * per-point colour attribute — under additive blending black IS invisible, so
 * this costs one attribute upload instead of a custom shader. */
export function makeSparks(count, tint, size) {
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mat = new THREE.PointsMaterial({
    size, map: softDot(), vertexColors: true, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  const P = [];
  for (let i = 0; i < count; i++) P.push({ life: 0, max: 1, vx: 0, vy: 0, vz: 0 });

  return {
    points, P, pos, col, geo, tint: new THREE.Color(tint),

    /* Emit up to n particles from the free pool. */
    /* `out` is outward speed; a NEGATIVE out draws the particle toward the
     * centre instead, which is what a charge reads as rather than a burst. */
    emit(n, { x = 0, y = 0, z = 0, spread = 1.4, up = 1.4, out = 0.5, life = 2 } = {}) {
      let made = 0;
      for (let i = 0; i < P.length && made < n; i++) {
        if (P[i].life > 0) continue;
        const a = Math.random() * Math.PI * 2;
        const rad = Math.sqrt(Math.random()) * spread;
        pos[i * 3] = x + Math.cos(a) * rad;
        pos[i * 3 + 1] = y + Math.random() * 0.15;
        pos[i * 3 + 2] = z + Math.sin(a) * rad;
        P[i].vx = Math.cos(a) * out * (0.4 + Math.random());
        P[i].vy = up * (0.45 + Math.random());
        P[i].vz = Math.sin(a) * out * (0.4 + Math.random());
        P[i].max = life * (0.6 + Math.random() * 0.7);
        P[i].life = P[i].max;
        made++;
      }
    },

    step(dt, gravity = -1.1) {
      for (let i = 0; i < P.length; i++) {
        const p = P[i];
        if (p.life <= 0) { col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = 0; continue; }
        p.life -= dt;
        p.vy += gravity * dt;
        pos[i * 3] += p.vx * dt;
        pos[i * 3 + 1] += p.vy * dt;
        pos[i * 3 + 2] += p.vz * dt;
        // snap in over the first tenth of the life, then fall away as k squared
        const k = Math.max(0, p.life / p.max);
        const a = Math.min(1, (1 - k) * 9) * k * k;
        col[i * 3] = this.tint.r * a;
        col[i * 3 + 1] = this.tint.g * a;
        col[i * 3 + 2] = this.tint.b * a;
      }
      geo.attributes.position.needsUpdate = true;
      geo.attributes.color.needsUpdate = true;
    },

    clear() {
      for (let i = 0; i < P.length; i++) {
        P[i].life = 0;
        col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = 0;
      }
      geo.attributes.color.needsUpdate = true;
    },
  };
}

/* The chest, built the way Minecraft builds it: a 14x10x14 base and a 14x5x14
 * lid, both cut from the 64x64 entity atlas, with the lid parented to a hinge
 * group sitting on the base's back-top edge so it swings on the real axis.
 * Returns { group, hinge, base, lid } — callers drive hinge.rotation.x. */
export async function buildChest(src, scale = 1) {
  /* The ender chest atlas has violet baked into it, and the palette contains no
     violet. dePurple rotates only that hue wedge to amber, leaving the teal
     portal face and every bit of shading alone — the same remap the 2D films
     run on the same artwork, so the block matches itself across the site. */
  const atlas = dePurple(await loadImage(src));
  const group = new THREE.Group();

  const base = new THREE.Mesh(
    new THREE.BoxGeometry(14 * PX, 10 * PX, 14 * PX),
    boxMats(atlas, 0, 19, 14, 10, 14),
  );
  base.position.y = 5 * PX;
  base.castShadow = true; base.receiveShadow = true;
  group.add(base);

  const hinge = new THREE.Group();
  hinge.position.set(0, 10 * PX, -7 * PX);
  const lid = new THREE.Mesh(
    new THREE.BoxGeometry(14 * PX, 5 * PX, 14 * PX),
    boxMats(atlas, 0, 0, 14, 5, 14),
  );
  lid.position.set(0, 2.5 * PX, 7 * PX);
  lid.castShadow = true;
  hinge.add(lid);
  group.add(hinge);

  group.scale.setScalar(scale);
  return { group, hinge, base, lid, atlas };
}

/* A vertical beam of light: a hot core with a real cross-section, plus a
 * camera-facing card carrying the glow. The card matters — a cylinder only
 * falls off along its length, so on its own it silhouettes as a hard-edged slab
 * rather than as light. Returns { group, core, halo, face(camera), set(k) }. */
