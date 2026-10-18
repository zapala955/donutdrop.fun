/* mcmodels.js — Minecraft's entity models, built the way the game builds them, and its particles.
 *
 * A model is a tree of parts. Each part has a pivot and a rotation (applied Z, then Y, then X, as
 * the game's PoseStack does) and a list of cuboids in model pixels, y pointing down and the entity
 * facing -z: the game's own model space. Every cuboid is unwrapped exactly as
 * net.minecraft.client.model.geom.ModelPart.Cube unwraps it -- the same six polygons, the same UV
 * rectangles, the same mirror -- so a skin out of the client jar lands on the box the way it does
 * in the game. The definitions below are copied from VillagerModel, LlamaModel and BookModel.
 *
 * `placeEntity` puts a model in the world the way LivingEntityRenderer does (turned upside down
 * about x, feet on the ground, facing +z), at whatever size a pixel is asked to be.
 *
 * `makeSprites` is the particle half: point sprites cut from a texture atlas, so the happy-villager
 * glint, the firework sparks, the experience orbs and the enchanting table's glyphs are the game's
 * own pictures rather than drawn blobs.
 */

/** One cuboid's positions, normals and UVs, as ModelPart.Cube lays them out. */
function cube(THREE, c, texW, texH, out) {
  const k = c.inflate || 0;
  let x0 = c.x - k; let x1 = c.x + c.w + k;
  const y0 = c.y - k; const y1 = c.y + c.h + k;
  const z0 = c.z - k; const z1 = c.z + c.d + k;
  if (c.mirror) [x0, x1] = [x1, x0];
  const V = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const { u, v, w, h, d } = c;
  const f4 = u; const f5 = u + d; const f6 = u + d + w; const f7 = u + d + w + w;
  const f8 = u + d + w + d; const f9 = u + d + w + d + w;
  const f10 = v; const f11 = v + d; const f12 = v + d + h;
  // [vertices, u1, v1, u2, v2]: DOWN, UP, WEST, NORTH, EAST, SOUTH, in the game's order.
  const polys = [
    [[5, 4, 0, 1], f5, f10, f6, f11],
    [[2, 3, 7, 6], f6, f11, f7, f10],
    [[0, 4, 7, 3], f4, f11, f5, f12],
    [[1, 0, 3, 2], f5, f11, f6, f12],
    [[5, 1, 2, 6], f6, f11, f8, f12],
    [[4, 5, 6, 7], f8, f11, f9, f12],
  ];
  const cx = (x0 + x1) / 2; const cy = (y0 + y1) / 2; const cz = (z0 + z1) / 2;
  for (const [ids, u1, v1, u2, v2] of polys) {
    const quad = ids.map((i) => V[i]);
    // The game's polygon UVs: vertex 0 (u2,v1), 1 (u1,v1), 2 (u1,v2), 3 (u2,v2).
    const uvs = [[u2, v1], [u1, v1], [u1, v2], [u2, v2]];
    // The face's outward normal, from where it sits on the box (the winding flips with a mirror).
    const mx = quad.reduce((s, p) => s + p[0], 0) / 4 - cx;
    const my = quad.reduce((s, p) => s + p[1], 0) / 4 - cy;
    const mz = quad.reduce((s, p) => s + p[2], 0) / 4 - cz;
    const ax = Math.abs(mx); const ay = Math.abs(my); const az = Math.abs(mz);
    const n = ax >= ay && ax >= az ? [Math.sign(mx) || 1, 0, 0] : ay >= az ? [0, Math.sign(my) || 1, 0] : [0, 0, Math.sign(mz) || 1];
    for (const i of [0, 1, 2, 0, 2, 3]) {
      out.pos.push(...quad[i]);
      out.nor.push(...n);
      out.uv.push(uvs[i][0] / texW, 1 - uvs[i][1] / texH);
    }
  }
}

/**
 * Builds a model tree. `layers` is [{ material, def }] -- several layers (a llama and its trader
 * blanket) share one tree of parts, so they move as one.
 */
export function buildModel(THREE, layers) {
  const parts = {};
  const root = new THREE.Group();
  const make = (partDefs, parent, path) => {
    partDefs.forEach((def, index) => {
      const key = def.name;
      const group = parts[key] || new THREE.Group();
      if (!parts[key]) {
        group.name = key;
        group.position.set(...(def.pivot || [0, 0, 0]));
        const r = def.rot || [0, 0, 0];
        group.rotation.set(r[0], r[1], r[2], 'ZYX');
        group.userData.rest = { position: group.position.clone(), rotation: group.rotation.clone() };
        parent.add(group);
        parts[key] = group;
      }
      for (const layer of layers) {
        const mine = path.reduce((list, i) => list?.[i]?.children, layer.def.parts)?.[index];
        if (!mine?.cubes?.length) continue;
        const out = { pos: [], nor: [], uv: [] };
        for (const c of mine.cubes) cube(THREE, c, layer.def.texW, layer.def.texH, out);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(out.pos, 3));
        geo.setAttribute('normal', new THREE.Float32BufferAttribute(out.nor, 3));
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(out.uv, 2));
        const mesh = new THREE.Mesh(geo, layer.material);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        group.add(mesh);
      }
      if (def.children) make(def.children, group, [...path, index]);
    });
  };
  make(layers[0].def.parts, root, []);
  return { root, parts };
}

/**
 * Stands a model in the world: upside down about x as LivingEntityRenderer turns it, its feet (model
 * y = 24) on the ground, facing +z, one model pixel `pixel` world units across. Returns the group to
 * place and turn.
 */
export function placeEntity(THREE, model, pixel) {
  const entity = new THREE.Group();
  const scale = new THREE.Group();
  scale.scale.setScalar(pixel);
  model.root.rotation.x = Math.PI;
  model.root.position.y = 24;
  scale.add(model.root);
  entity.add(scale);
  return entity;
}

/* ─────────── the models, from the game's code ─────────── */

/** VillagerModel: the wandering trader wears it, hood and robe as the hat and jacket layers. */
export const VILLAGER = {
  texW: 64,
  texH: 64,
  parts: [
    {
      name: 'head', cubes: [{ u: 0, v: 0, x: -4, y: -10, z: -4, w: 8, h: 10, d: 8 }],
      children: [
        { name: 'hat', cubes: [{ u: 32, v: 0, x: -4, y: -10, z: -4, w: 8, h: 10, d: 8, inflate: 0.51 }] },
        { name: 'nose', pivot: [0, -2, 0], cubes: [{ u: 24, v: 0, x: -1, y: -1, z: -6, w: 2, h: 4, d: 2 }] },
      ],
    },
    {
      name: 'body', cubes: [{ u: 16, v: 20, x: -4, y: 0, z: -3, w: 8, h: 12, d: 6 }],
      children: [{ name: 'jacket', cubes: [{ u: 0, v: 38, x: -4, y: 0, z: -3, w: 8, h: 20, d: 6, inflate: 0.5 }] }],
    },
    {
      name: 'arms', pivot: [0, 3, -1], rot: [-0.75, 0, 0],
      cubes: [
        { u: 44, v: 22, x: -8, y: -2, z: -2, w: 4, h: 8, d: 4 },
        { u: 44, v: 22, x: 4, y: -2, z: -2, w: 4, h: 8, d: 4, mirror: true },
        { u: 40, v: 38, x: -4, y: 2, z: -2, w: 8, h: 4, d: 4 },
      ],
    },
    { name: 'rightLeg', pivot: [-2, 12, 0], cubes: [{ u: 0, v: 22, x: -2, y: 0, z: -2, w: 4, h: 12, d: 4 }] },
    { name: 'leftLeg', pivot: [2, 12, 0], cubes: [{ u: 0, v: 22, x: -2, y: 0, z: -2, w: 4, h: 12, d: 4, mirror: true }] },
  ],
};

/** LlamaModel at a given cube deformation: 0 for the llama, 0.5 for the trader's blanket over it. */
export function llamaModel(k = 0) {
  const leg = { u: 29, v: 29, x: -2, y: 0, z: -2, w: 4, h: 14, d: 4, inflate: k };
  return {
    texW: 128,
    texH: 64,
    parts: [
      {
        name: 'head', pivot: [0, 7, -6],
        cubes: [
          { u: 0, v: 0, x: -2, y: -14, z: -10, w: 4, h: 4, d: 9, inflate: k },
          { u: 0, v: 14, x: -4, y: -16, z: -6, w: 8, h: 18, d: 6, inflate: k },
          { u: 17, v: 0, x: -4, y: -19, z: -4, w: 3, h: 3, d: 2, inflate: k },
          { u: 17, v: 0, x: 1, y: -19, z: -4, w: 3, h: 3, d: 2, inflate: k },
        ],
      },
      { name: 'body', pivot: [0, 5, 2], rot: [Math.PI / 2, 0, 0], cubes: [{ u: 29, v: 0, x: -6, y: -10, z: -7, w: 12, h: 18, d: 10, inflate: k }] },
      { name: 'rightHindLeg', pivot: [-3.5, 10, 6], cubes: [leg] },
      { name: 'leftHindLeg', pivot: [3.5, 10, 6], cubes: [leg] },
      { name: 'rightFrontLeg', pivot: [-3.5, 10, -5], cubes: [leg] },
      { name: 'leftFrontLeg', pivot: [3.5, 10, -5], cubes: [leg] },
    ],
  };
}

/** BookModel: the book over the enchanting table, lids, pages and two leaves that turn. */
export const BOOK = {
  texW: 64,
  texH: 32,
  parts: [
    { name: 'leftLid', pivot: [0, 0, -1], cubes: [{ u: 0, v: 0, x: -6, y: -5, z: -0.005, w: 6, h: 10, d: 0.005 }] },
    { name: 'rightLid', pivot: [0, 0, 1], cubes: [{ u: 16, v: 0, x: 0, y: -5, z: -0.005, w: 6, h: 10, d: 0.005 }] },
    { name: 'seam', rot: [0, Math.PI / 2, 0], cubes: [{ u: 12, v: 0, x: -1, y: -5, z: 0, w: 2, h: 10, d: 0.005 }] },
    { name: 'leftPages', cubes: [{ u: 0, v: 10, x: 0, y: -4, z: -0.99, w: 5, h: 8, d: 1 }] },
    { name: 'rightPages', cubes: [{ u: 12, v: 10, x: 0, y: -4, z: -0.01, w: 5, h: 8, d: 1 }] },
    { name: 'flipPage1', cubes: [{ u: 24, v: 10, x: 0, y: -4, z: 0, w: 5, h: 8, d: 0.005 }] },
    { name: 'flipPage2', cubes: [{ u: 24, v: 10, x: 0, y: -4, z: 0, w: 5, h: 8, d: 0.005 }] },
  ],
};

/** BookModel.setupAnim: `open` 0..1, the two leaves' turn 0..1 each, `time` in ticks. */
export function poseBook(parts, time, rightFlip, leftFlip, open) {
  const f = (Math.sin(time * 0.02) * 0.1 + 1.25) * open;
  parts.leftLid.rotation.y = Math.PI + f;
  parts.rightLid.rotation.y = -f;
  parts.leftPages.rotation.y = f;
  parts.rightPages.rotation.y = -f;
  parts.flipPage1.rotation.y = f - f * 2 * rightFlip;
  parts.flipPage2.rotation.y = f - f * 2 * leftFlip;
  const s = Math.sin(f);
  parts.leftPages.position.x = s;
  parts.rightPages.position.x = s;
  parts.flipPage1.position.x = s;
  parts.flipPage2.position.x = s;
}

/* GuardianModel's twelve spikes: where each sits on the body (π times these turns it out), from the
 * class's own SPIKE_* tables. The elder guardian is the same model, 2.35 times the size. */
const SPIKE_X_ROT = [1.75, 0.25, 0, 0, 0.5, 0.5, 0.5, 0.5, 1.25, 0.75, 0, 0];
const SPIKE_Y_ROT = [0, 0, 0, 0, 0.25, 1.75, 1.25, 0.75, 0, 0, 0, 0];
const SPIKE_Z_ROT = [0, 0, 0.25, 1.75, 0, 0, 0, 0, 0, 0, 0.75, 1.25];
const SPIKE_X = [0, 0, 8, -8, -8, 8, 8, -8, 0, 0, 8, -8];
const SPIKE_Y = [-8, -8, -8, -8, 0, 0, 8, 8, 8, 8, 0, 0];
const SPIKE_Z = [8, -8, 0, 0, -8, -8, 8, 8, 8, -8, 0, 0];
export const ELDER_GUARDIAN_SCALE = 2.35;

/** GuardianModel.createBodyLayer: the body with its fins and plates, the spikes, the eye, the tail. */
export const GUARDIAN = {
  texW: 64,
  texH: 64,
  parts: [
    {
      name: 'head',
      cubes: [
        { u: 0, v: 0, x: -6, y: 10, z: -8, w: 12, h: 12, d: 16 },
        { u: 0, v: 28, x: -8, y: 10, z: -6, w: 2, h: 12, d: 12 },
        { u: 0, v: 28, x: 6, y: 10, z: -6, w: 2, h: 12, d: 12, mirror: true },
        { u: 16, v: 40, x: -6, y: 8, z: -6, w: 12, h: 2, d: 12 },
        { u: 16, v: 40, x: -6, y: 22, z: -6, w: 12, h: 2, d: 12 },
      ],
      children: [
        ...SPIKE_X.map((_, i) => ({
          name: `spike${i}`,
          pivot: [SPIKE_X[i], 16 + SPIKE_Y[i], SPIKE_Z[i]],
          rot: [Math.PI * SPIKE_X_ROT[i], Math.PI * SPIKE_Y_ROT[i], Math.PI * SPIKE_Z_ROT[i]],
          cubes: [{ u: 0, v: 0, x: -1, y: -4.5, z: -1, w: 2, h: 9, d: 2 }],
        })),
        { name: 'eye', pivot: [0, 0, -8.25], cubes: [{ u: 8, v: 0, x: -1, y: 15, z: 0, w: 2, h: 2, d: 1 }] },
        {
          name: 'tail0',
          cubes: [{ u: 40, v: 0, x: -2, y: 14, z: 7, w: 4, h: 4, d: 8 }],
          children: [{
            name: 'tail1',
            pivot: [-1.5, 0.5, 14],
            cubes: [{ u: 0, v: 54, x: 0, y: 14, z: 0, w: 3, h: 3, d: 7 }],
            children: [{
              name: 'tail2',
              pivot: [0.5, 0.5, 6],
              cubes: [
                { u: 41, v: 32, x: 0, y: 14, z: 0, w: 2, h: 2, d: 6 },
                { u: 25, v: 19, x: 1, y: 10.5, z: 3, w: 1, h: 9, d: 9 },
              ],
            }],
          }],
        },
      ],
    },
  ],
};

/**
 * GuardianModel.setupAnim: the spikes drawn in by `extension` (0 out, 0.55 in, as when it swims),
 * breathing a hundredth with `ticks`; the eye's pupil `eyeX` -2..2 across and `eyeY` 0 or 1 down;
 * the tail swinging with `tail`.
 */
export function poseGuardian(parts, ticks, extension, eyeX, eyeY, tail) {
  for (let i = 0; i < 12; i += 1) {
    const offset = 1 + Math.cos(ticks * 1.5 + i) * 0.01 - extension;
    parts[`spike${i}`].position.set(SPIKE_X[i] * offset, 16 + SPIKE_Y[i] * offset, SPIKE_Z[i] * offset);
  }
  parts.eye.position.x = eyeX;
  parts.eye.position.y = eyeY;
  parts.tail0.rotation.y = Math.sin(tail) * Math.PI * 0.05;
  parts.tail1.rotation.y = Math.sin(tail) * Math.PI * 0.1;
  parts.tail2.rotation.y = Math.sin(tail) * Math.PI * 0.15;
}

/** ConduitRenderer's three boxes: the shell (asleep), the cage (awake) and the wind round it. */
export const CONDUIT_SHELL = { texW: 32, texH: 16, parts: [{ name: 'shell', cubes: [{ u: 0, v: 0, x: -3, y: -3, z: -3, w: 6, h: 6, d: 6 }] }] };
export const CONDUIT_CAGE = { texW: 32, texH: 16, parts: [{ name: 'cage', cubes: [{ u: 0, v: 0, x: -4, y: -4, z: -4, w: 8, h: 8, d: 8 }] }] };
export const CONDUIT_WIND = { texW: 64, texH: 32, parts: [{ name: 'wind', cubes: [{ u: 0, v: 0, x: -8, y: -8, z: -8, w: 16, h: 16, d: 16 }] }] };

/* ─────────── particles ─────────── */

/** A texture atlas from equal frames laid left to right, top to bottom. */
export function atlas(THREE, images, frame, cols) {
  const rows = Math.ceil(images.length / cols);
  const c = document.createElement('canvas');
  c.width = cols * frame;
  c.height = rows * frame;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  images.forEach((im, i) => g.drawImage(im, (i % cols) * frame, Math.floor(i / cols) * frame, frame, frame));
  return { map: pixelTexture(THREE, c), cols, rows };
}

export function pixelTexture(THREE, source) {
  const t = new THREE.CanvasTexture(source);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const SPRITE_VERTEX = `
attribute vec4 aColor;
attribute float aSize;
attribute float aFrame;
uniform float uScale;
varying vec4 vColor;
varying float vFrame;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aColor.a > 0.0 ? aSize * uScale / max(0.001, -mv.z) : 0.0;
  vColor = aColor;
  vFrame = aFrame;
}`;
const SPRITE_FRAGMENT = `
uniform sampler2D uMap;
uniform vec2 uGrid;
varying vec4 vColor;
varying float vFrame;
void main() {
  if (vColor.a <= 0.004) discard;
  float f = floor(vFrame + 0.5);
  vec2 cell = vec2(mod(f, uGrid.x), floor(f / uGrid.x));
  vec2 uv = vec2((cell.x + gl_PointCoord.x) / uGrid.x, 1.0 - (cell.y + gl_PointCoord.y) / uGrid.y);
  vec4 tex = texture2D(uMap, uv);
  if (tex.a < 0.5) discard;
  gl_FragColor = vec4(tex.rgb * vColor.rgb, vColor.a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/**
 * Point sprites cut from an atlas, each with its own life, motion, size, colour and frame. The
 * frame can run (`frameTo`) over the particle's life, the way firework sparks burn down.
 */
export function makeSprites(THREE, { map, cols = 1, rows = 1, count = 200, additive = false }) {
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 4);
  const size = new Float32Array(count);
  const frame = new Float32Array(count);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 4));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geo.setAttribute('aFrame', new THREE.BufferAttribute(frame, 1));
  const material = new THREE.ShaderMaterial({
    uniforms: { uMap: { value: map }, uGrid: { value: new THREE.Vector2(cols, rows) }, uScale: { value: 400 } },
    vertexShader: SPRITE_VERTEX,
    fragmentShader: SPRITE_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  const points = new THREE.Points(geo, material);
  points.frustumCulled = false;
  const P = Array.from({ length: count }, () => ({ life: 0 }));
  let cursor = 0;
  let live = false;
  return {
    points,
    /** Point size per world unit at one unit's distance: canvas pixels × projection[1][1] / 2. */
    setScale(value) { material.uniforms.uScale.value = value; },
    emit(o) {
      const i = cursor;
      cursor = (cursor + 1) % count;
      P[i] = {
        life: o.life, max: o.life, vx: o.vx || 0, vy: o.vy || 0, vz: o.vz || 0, gravity: o.gravity || 0, drag: o.drag || 0,
        size0: o.size, size1: o.sizeTo ?? o.size, frame0: o.frame || 0, frame1: o.frameTo ?? o.frame ?? 0,
        r: o.r ?? 1, g: o.g ?? 1, b: o.b ?? 1, twinkle: o.twinkle || false, fade: o.fade ?? 0.3,
      };
      pos[i * 3] = o.x; pos[i * 3 + 1] = o.y; pos[i * 3 + 2] = o.z;
      live = true;
    },
    step(dt) {
      if (!live) return;
      let any = false;
      for (let i = 0; i < count; i += 1) {
        const p = P[i];
        if (!(p.life > 0)) { col[i * 4 + 3] = 0; continue; }
        any = true;
        p.life -= dt;
        p.vy += p.gravity * dt;
        const k = Math.max(0, 1 - p.drag * dt);
        p.vx *= k; p.vy *= k; p.vz *= k;
        pos[i * 3] += p.vx * dt; pos[i * 3 + 1] += p.vy * dt; pos[i * 3 + 2] += p.vz * dt;
        const t = 1 - Math.max(0, p.life) / p.max;
        const alpha = t > 1 - p.fade ? (1 - t) / p.fade : 1;
        col[i * 4] = p.r; col[i * 4 + 1] = p.g; col[i * 4 + 2] = p.b;
        col[i * 4 + 3] = Math.max(0, alpha) * (p.twinkle && Math.random() < 0.3 ? 0.35 : 1);
        size[i] = p.size0 + (p.size1 - p.size0) * t;
        frame[i] = p.frame0 + (p.frame1 - p.frame0) * t;
      }
      live = any;
      geo.attributes.position.needsUpdate = true;
      geo.attributes.aColor.needsUpdate = true;
      geo.attributes.aSize.needsUpdate = true;
      geo.attributes.aFrame.needsUpdate = true;
    },
  };
}
