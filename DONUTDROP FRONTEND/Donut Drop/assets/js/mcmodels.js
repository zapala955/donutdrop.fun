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
        if (def.scale) group.scale.setScalar(def.scale);
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

/**
 * An item sprite extruded one pixel deep, the way the game builds a dropped or held item: the sprite
 * front and back, and an edge strip wherever a solid pixel meets an empty one, in that pixel's
 * colour. One unit across, centred, facing +z. Returns { geometry, material }.
 */
export function itemModel(THREE, source, opts = {}) {
  const S = 16;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(source, 0, 0, source.naturalWidth || source.width, source.naturalHeight || source.height, 0, 0, S, S);
  const data = g.getImageData(0, 0, S, S).data;
  const solid = (x, y) => x >= 0 && y >= 0 && x < S && y < S && data[(y * S + x) * 4 + 3] > 127;
  const pos = []; const nor = []; const uv = [];
  const d = 0.5 / S;
  const quad = (a, b, c2, e, n, ua, ub, uc, ue) => {
    for (const [v, t] of [[a, ua], [b, ub], [c2, uc], [a, ua], [c2, uc], [e, ue]]) {
      pos.push(...v); nor.push(...n); uv.push(...t);
    }
  };
  quad([-0.5, -0.5, d], [0.5, -0.5, d], [0.5, 0.5, d], [-0.5, 0.5, d], [0, 0, 1], [0, 0], [1, 0], [1, 1], [0, 1]);
  quad([0.5, -0.5, -d], [-0.5, -0.5, -d], [-0.5, 0.5, -d], [0.5, 0.5, -d], [0, 0, -1], [1, 0], [0, 0], [0, 1], [1, 1]);
  for (let y = 0; y < S; y += 1) {
    for (let x = 0; x < S; x += 1) {
      if (!solid(x, y)) continue;
      const x0 = -0.5 + x / S; const x1 = x0 + 1 / S;
      const y1 = 0.5 - y / S; const y0 = y1 - 1 / S;
      const t = [(x + 0.5) / S, 1 - (y + 0.5) / S];
      if (!solid(x - 1, y)) quad([x0, y0, -d], [x0, y0, d], [x0, y1, d], [x0, y1, -d], [-1, 0, 0], t, t, t, t);
      if (!solid(x + 1, y)) quad([x1, y0, d], [x1, y0, -d], [x1, y1, -d], [x1, y1, d], [1, 0, 0], t, t, t, t);
      if (!solid(x, y - 1)) quad([x0, y1, d], [x1, y1, d], [x1, y1, -d], [x0, y1, -d], [0, 1, 0], t, t, t, t);
      if (!solid(x, y + 1)) quad([x0, y0, -d], [x1, y0, -d], [x1, y0, d], [x0, y0, d], [0, -1, 0], t, t, t, t);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  const map = new THREE.CanvasTexture(c);
  map.magFilter = THREE.NearestFilter;
  map.minFilter = THREE.NearestFilter;
  map.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshLambertMaterial({ map, alphaTest: 0.5, emissive: 0x1c1c1c, ...opts });
  return { geometry, material };
}

/** PlayerModel (wide arms) over HumanoidModel: head and hat, body and jacket, arms and sleeves, legs
 * and trousers, the outer layers a quarter (the hat a half) pixel out. Steve's skin fits it. */
export const PLAYER = {
  texW: 64,
  texH: 64,
  parts: [
    {
      name: 'head', cubes: [{ u: 0, v: 0, x: -4, y: -8, z: -4, w: 8, h: 8, d: 8 }],
      children: [{ name: 'hat', cubes: [{ u: 32, v: 0, x: -4, y: -8, z: -4, w: 8, h: 8, d: 8, inflate: 0.5 }] }],
    },
    {
      name: 'body', cubes: [{ u: 16, v: 16, x: -4, y: 0, z: -2, w: 8, h: 12, d: 4 }],
      children: [{ name: 'jacket', cubes: [{ u: 16, v: 32, x: -4, y: 0, z: -2, w: 8, h: 12, d: 4, inflate: 0.25 }] }],
    },
    {
      name: 'rightArm', pivot: [-5, 2, 0], cubes: [{ u: 40, v: 16, x: -3, y: -2, z: -2, w: 4, h: 12, d: 4 }],
      children: [{ name: 'rightSleeve', cubes: [{ u: 40, v: 32, x: -3, y: -2, z: -2, w: 4, h: 12, d: 4, inflate: 0.25 }] }],
    },
    {
      name: 'leftArm', pivot: [5, 2, 0], cubes: [{ u: 32, v: 48, x: -1, y: -2, z: -2, w: 4, h: 12, d: 4 }],
      children: [{ name: 'leftSleeve', cubes: [{ u: 48, v: 48, x: -1, y: -2, z: -2, w: 4, h: 12, d: 4, inflate: 0.25 }] }],
    },
    {
      name: 'rightLeg', pivot: [-1.9, 12, 0], cubes: [{ u: 0, v: 16, x: -2, y: 0, z: -2, w: 4, h: 12, d: 4 }],
      children: [{ name: 'rightPants', cubes: [{ u: 0, v: 32, x: -2, y: 0, z: -2, w: 4, h: 12, d: 4, inflate: 0.25 }] }],
    },
    {
      name: 'leftLeg', pivot: [1.9, 12, 0], cubes: [{ u: 16, v: 48, x: -2, y: 0, z: -2, w: 4, h: 12, d: 4 }],
      children: [{ name: 'leftPants', cubes: [{ u: 0, v: 48, x: -2, y: 0, z: -2, w: 4, h: 12, d: 4, inflate: 0.25 }] }],
    },
  ],
};

/**
 * DrownedModel at a cube deformation: HumanoidModel's mesh (the left limbs mirrored copies of the
 * right) with the drowned's own left arm and left leg. 0 for the drowned, 0.25 for its outer layer.
 */
export function drownedModel(k = 0) {
  const box = (u, v, x, y, z, w, h, d, extra = {}) => ({ u, v, x, y, z, w, h, d, inflate: k, ...extra });
  return {
    texW: 64,
    texH: 64,
    parts: [
      { name: 'head', cubes: [box(0, 0, -4, -8, -4, 8, 8, 8)], children: [{ name: 'hat', cubes: [box(32, 0, -4, -8, -4, 8, 8, 8, { inflate: k + 0.5 })] }] },
      { name: 'body', cubes: [box(16, 16, -4, 0, -2, 8, 12, 4)] },
      { name: 'rightArm', pivot: [-5, 2, 0], cubes: [box(40, 16, -3, -2, -2, 4, 12, 4)] },
      { name: 'leftArm', pivot: [5, 2, 0], cubes: [box(32, 48, -1, -2, -2, 4, 12, 4)] },
      { name: 'rightLeg', pivot: [-1.9, 12, 0], cubes: [box(0, 16, -2, 0, -2, 4, 12, 4)] },
      { name: 'leftLeg', pivot: [1.9, 12, 0], cubes: [box(16, 48, -2, 0, -2, 4, 12, 4)] },
    ],
  };
}

/** BoatModel: the bottom laid flat, the four sides, and the two paddles. 128 × 64. */
export const BOAT = {
  texW: 128,
  texH: 64,
  parts: [
    { name: 'bottom', pivot: [0, 3, 1], rot: [Math.PI / 2, 0, 0], cubes: [{ u: 0, v: 0, x: -14, y: -9, z: -3, w: 28, h: 16, d: 3 }] },
    { name: 'back', pivot: [-15, 4, 4], rot: [0, (3 * Math.PI) / 2, 0], cubes: [{ u: 0, v: 19, x: -13, y: -7, z: -1, w: 18, h: 6, d: 2 }] },
    { name: 'front', pivot: [15, 4, 0], rot: [0, Math.PI / 2, 0], cubes: [{ u: 0, v: 27, x: -8, y: -7, z: -1, w: 16, h: 6, d: 2 }] },
    { name: 'right', pivot: [0, 4, -9], rot: [0, Math.PI, 0], cubes: [{ u: 0, v: 35, x: -14, y: -7, z: -1, w: 28, h: 6, d: 2 }] },
    { name: 'left', pivot: [0, 4, 9], cubes: [{ u: 0, v: 43, x: -14, y: -7, z: -1, w: 28, h: 6, d: 2 }] },
    {
      name: 'leftPaddle', pivot: [3, -5, 9], rot: [0, 0, 0.19634954631328583],
      cubes: [{ u: 62, v: 0, x: -1, y: 0, z: -5, w: 2, h: 2, d: 18 }, { u: 62, v: 0, x: -1.001, y: -3, z: 8, w: 1, h: 6, d: 7 }],
    },
    {
      name: 'rightPaddle', pivot: [3, -5, -9], rot: [0, Math.PI, 0.19634954631328583],
      cubes: [{ u: 62, v: 20, x: -1, y: 0, z: -5, w: 2, h: 2, d: 18 }, { u: 62, v: 20, x: 0.001, y: -3, z: 8, w: 1, h: 6, d: 7 }],
    },
  ],
};

/** SquidModel (the glow squid's too): the body and eight tentacles round its base. 64 × 32. */
export const SQUID = {
  texW: 64,
  texH: 32,
  parts: [
    { name: 'body', pivot: [0, 8, 0], cubes: [{ u: 0, v: 0, x: -6, y: -8, z: -6, w: 12, h: 16, d: 12, inflate: 0.02 }] },
    ...Array.from({ length: 8 }, (_, i) => {
      const a = (i * Math.PI * 2) / 8;
      return {
        name: `tentacle${i}`,
        pivot: [Math.cos(a) * 5, 15, Math.sin(a) * 5],
        rot: [0, (i * Math.PI * -2) / 8 + Math.PI / 2, 0],
        cubes: [{ u: 48, v: 0, x: -1, y: 0, z: -1, w: 2, h: 18, d: 2 }],
      };
    }),
  ],
};
/** SquidModel.setupAnim: every tentacle swung out by the same angle. */
export function poseSquid(parts, tentacleAngle) {
  for (let i = 0; i < 8; i += 1) parts[`tentacle${i}`].rotation.x = tentacleAngle;
}

/** DolphinModel: the body with its fins, tail and tail fin, the head and its nose. 64 × 64. */
export const DOLPHIN = {
  texW: 64,
  texH: 64,
  parts: [
    {
      name: 'body', pivot: [0, 22, -5], cubes: [{ u: 22, v: 0, x: -4, y: -7, z: 0, w: 8, h: 7, d: 13 }],
      children: [
        { name: 'backFin', rot: [Math.PI / 3, 0, 0], cubes: [{ u: 51, v: 0, x: -0.5, y: 0, z: 8, w: 1, h: 4, d: 5 }] },
        { name: 'leftFin', pivot: [2, -2, 4], rot: [Math.PI / 3, 0, (2 * Math.PI) / 3], cubes: [{ u: 48, v: 20, x: -0.5, y: -4, z: 0, w: 1, h: 4, d: 7, mirror: true }] },
        { name: 'rightFin', pivot: [-2, -2, 4], rot: [Math.PI / 3, 0, (-2 * Math.PI) / 3], cubes: [{ u: 48, v: 20, x: -0.5, y: -4, z: 0, w: 1, h: 4, d: 7 }] },
        {
          name: 'tail', pivot: [0, -2.5, 11], rot: [-0.10471975803375244, 0, 0], cubes: [{ u: 0, v: 19, x: -2, y: -2.5, z: 0, w: 4, h: 5, d: 11 }],
          children: [{ name: 'tailFin', pivot: [0, 0, 9], cubes: [{ u: 19, v: 20, x: -5, y: -0.5, z: 0, w: 10, h: 1, d: 6 }] }],
        },
        {
          name: 'head', pivot: [0, -4, -3], cubes: [{ u: 0, v: 0, x: -4, y: -3, z: -3, w: 8, h: 7, d: 6 }],
          children: [{ name: 'nose', cubes: [{ u: 0, v: 13, x: -1, y: 2, z: -7, w: 2, h: 2, d: 4 }] }],
        },
      ],
    },
  ],
};
/** DolphinModel.setupAnim, swimming: the body dips as the tail and tail fin beat. */
export function poseDolphin(parts, ticks, pitch = 0) {
  parts.body.rotation.x = pitch - 0.05 - 0.05 * Math.cos(ticks * 0.3);
  parts.tail.rotation.x = -0.1 * Math.cos(ticks * 0.3);
  parts.tailFin.rotation.x = -0.2 * Math.cos(ticks * 0.3);
}

/** SalmonModel: two halves of body, the head, the fins; the back half sways. 32 × 32. */
export const SALMON = {
  texW: 32,
  texH: 32,
  parts: [
    {
      name: 'bodyFront', pivot: [0, 20, -7.199999809265137], cubes: [{ u: 0, v: 0, x: -1.5, y: -2.5, z: 0, w: 3, h: 5, d: 8 }],
      children: [{ name: 'topFrontFin', pivot: [0, -4.5, 5], cubes: [{ u: 2, v: 1, x: 0, y: 0, z: 0, w: 0, h: 2, d: 3 }] }],
    },
    {
      name: 'bodyBack', pivot: [0, 20, 0.8000001907348633], cubes: [{ u: 0, v: 13, x: -1.5, y: -2.5, z: 0, w: 3, h: 5, d: 8 }],
      children: [
        { name: 'backFin', pivot: [0, 0, 8], cubes: [{ u: 20, v: 10, x: 0, y: -2.5, z: 0, w: 0, h: 5, d: 6 }] },
        { name: 'topBackFin', pivot: [0, -4.5, -1], cubes: [{ u: 0, v: 2, x: 0, y: 0, z: 0, w: 0, h: 2, d: 4 }] },
      ],
    },
    { name: 'head', pivot: [0, 20, -7.199999809265137], cubes: [{ u: 22, v: 0, x: -1, y: -2, z: -3, w: 2, h: 4, d: 3 }] },
    { name: 'rightFin', pivot: [-1.5, 21.5, -7.199999809265137], rot: [0, 0, -Math.PI / 4], cubes: [{ u: -4, v: 0, x: -2, y: 0, z: 0, w: 2, h: 0, d: 2 }] },
    { name: 'leftFin', pivot: [1.5, 21.5, -7.199999809265137], rot: [0, 0, Math.PI / 4], cubes: [{ u: 0, v: 0, x: 0, y: 0, z: 0, w: 2, h: 0, d: 2 }] },
  ],
};
/** SalmonModel.setupAnim: the back half swings, wider out of the water. */
export function poseSalmon(parts, ticks, inWater = true) {
  parts.bodyBack.rotation.y = -(inWater ? 1 : 1.3) * 0.25 * Math.sin((inWater ? 1 : 1.7) * 0.6 * ticks);
}

/**
 * WardenModel: the body with its ribcage, the head with its two tendrils, the long arms, and the
 * legs, all hung from a root bone. 128 × 128. Its bioluminescent layer, its heart and its pulsing
 * spots are the same model drawn again in their own textures.
 */
export const WARDEN = {
  texW: 128,
  texH: 128,
  parts: [
    {
      name: 'bone', pivot: [0, 24, 0],
      children: [
        {
          name: 'body', pivot: [0, -21, 0], cubes: [{ u: 0, v: 0, x: -9, y: -13, z: -4, w: 18, h: 21, d: 11 }],
          children: [
            { name: 'rightRibcage', pivot: [-7, -2, -4], cubes: [{ u: 90, v: 11, x: -2, y: -11, z: -0.10000000149011612, w: 9, h: 21, d: 0 }] },
            { name: 'leftRibcage', pivot: [7, -2, -4], cubes: [{ u: 90, v: 11, x: -7, y: -11, z: -0.10000000149011612, w: 9, h: 21, d: 0, mirror: true }] },
            {
              name: 'head', pivot: [0, -13, 0], cubes: [{ u: 0, v: 32, x: -8, y: -16, z: -5, w: 16, h: 16, d: 10 }],
              children: [
                { name: 'rightTendril', pivot: [-8, -12, 0], cubes: [{ u: 52, v: 32, x: -16, y: -13, z: 0, w: 16, h: 16, d: 0 }] },
                { name: 'leftTendril', pivot: [8, -12, 0], cubes: [{ u: 58, v: 0, x: 0, y: -13, z: 0, w: 16, h: 16, d: 0 }] },
              ],
            },
            { name: 'rightArm', pivot: [-13, -13, 1], cubes: [{ u: 44, v: 50, x: -4, y: 0, z: -4, w: 8, h: 28, d: 8 }] },
            { name: 'leftArm', pivot: [13, -13, 1], cubes: [{ u: 0, v: 58, x: -4, y: 0, z: -4, w: 8, h: 28, d: 8 }] },
          ],
        },
        { name: 'rightLeg', pivot: [-5.900000095367432, -13, 0], cubes: [{ u: 76, v: 48, x: -3.0999999046325684, y: 0, z: -3, w: 6, h: 13, d: 6 }] },
        { name: 'leftLeg', pivot: [5.900000095367432, -13, 0], cubes: [{ u: 76, v: 76, x: -2.9000000953674316, y: 0, z: -3, w: 6, h: 13, d: 6 }] },
      ],
    },
  ],
};

/** CodModel.createBodyLayer: body, head, nose, the two side fins turned 45°, tail and top fin. */
export const COD = {
  texW: 32,
  texH: 32,
  parts: [
    { name: 'body', pivot: [0, 22, 0], cubes: [{ u: 0, v: 0, x: -1, y: -2, z: 0, w: 2, h: 4, d: 7 }] },
    { name: 'head', pivot: [0, 22, 0], cubes: [{ u: 11, v: 0, x: -1, y: -2, z: -3, w: 2, h: 4, d: 3 }] },
    { name: 'nose', pivot: [0, 22, -3], cubes: [{ u: 0, v: 0, x: -1, y: -2, z: -1, w: 2, h: 3, d: 1 }] },
    { name: 'rightFin', pivot: [-1, 23, 0], rot: [0, 0, -Math.PI / 4], cubes: [{ u: 22, v: 1, x: -2, y: 0, z: -1, w: 2, h: 0, d: 2 }] },
    { name: 'leftFin', pivot: [1, 23, 0], rot: [0, 0, Math.PI / 4], cubes: [{ u: 22, v: 4, x: 0, y: 0, z: -1, w: 2, h: 0, d: 2 }] },
    { name: 'tailFin', pivot: [0, 22, 7], cubes: [{ u: 22, v: 3, x: 0, y: -2, z: 0, w: 0, h: 4, d: 4 }] },
    { name: 'topFin', pivot: [0, 20, 0], cubes: [{ u: 20, v: -6, x: 0, y: -1, z: -1, w: 0, h: 1, d: 6 }] },
  ],
};

/** CodModel.setupAnim: the tail sweeps, wider when the fish is out of the water. */
export function poseCod(parts, ticks, inWater = true) {
  parts.tailFin.rotation.y = -(inWater ? 1 : 1.5) * 0.45 * Math.sin(0.6 * ticks);
}

/** ConduitRenderer's three boxes: the shell (asleep), the cage (awake) and the wind round it. */
export const CONDUIT_SHELL = { texW: 32, texH: 16, parts: [{ name: 'shell', cubes: [{ u: 0, v: 0, x: -3, y: -3, z: -3, w: 6, h: 6, d: 6 }] }] };
export const CONDUIT_CAGE = { texW: 32, texH: 16, parts: [{ name: 'cage', cubes: [{ u: 0, v: 0, x: -4, y: -4, z: -4, w: 8, h: 8, d: 8 }] }] };
export const CONDUIT_WIND = { texW: 64, texH: 32, parts: [{ name: 'wind', cubes: [{ u: 0, v: 0, x: -8, y: -8, z: -8, w: 16, h: 16, d: 16 }] }] };

/* ─────────── the farm: the derby's racers ─────────── */

/** QuadrupedModel's four legs: (0, 16) 4 x `h` x 4 boxes at x +-`x`, z 7 behind and -5 in front, their
 * tops at 24 - `h`. One side mirrored, as the game's builder flags say. */
function quadLegs(h, x = 3, k = 0, mirrorLeft = false, mirrorRight = false) {
  const leg = (mirror) => [{ u: 0, v: 16, x: -2, y: 0, z: -2, w: 4, h, d: 4, inflate: k, mirror }];
  return [
    { name: 'rightHindLeg', pivot: [-x, 24 - h, 7], cubes: leg(mirrorRight) },
    { name: 'leftHindLeg', pivot: [x, 24 - h, 7], cubes: leg(mirrorLeft) },
    { name: 'rightFrontLeg', pivot: [-x, 24 - h, -5], cubes: leg(mirrorRight) },
    { name: 'leftFrontLeg', pivot: [x, 24 - h, -5], cubes: leg(mirrorLeft) },
  ];
}
/** PigModel: QuadrupedModel with six-pixel legs, the head and its snout. 64 x 64 (pig_temperate). */
export const PIG = {
  texW: 64,
  texH: 64,
  parts: [
    { name: 'head', pivot: [0, 12, -6], cubes: [{ u: 0, v: 0, x: -4, y: -4, z: -8, w: 8, h: 8, d: 8 }, { u: 16, v: 16, x: -2, y: 0, z: -9, w: 4, h: 3, d: 1 }] },
    { name: 'body', pivot: [0, 11, 2], rot: [Math.PI / 2, 0, 0], cubes: [{ u: 28, v: 8, x: -5, y: -10, z: -7, w: 10, h: 16, d: 8 }] },
    ...quadLegs(6, 3, 0, true, false),
  ],
};
/** CowModel (the 1.21.5 base cow): the head with its muzzle and horns, the body and udder, twelve-pixel
 * legs. 64 x 64; the mooshroom wears it too. */
export const COW = {
  texW: 64,
  texH: 64,
  parts: [
    {
      name: 'head', pivot: [0, 4, -8], cubes: [
        { u: 0, v: 0, x: -4, y: -4, z: -6, w: 8, h: 8, d: 6 },
        { u: 1, v: 33, x: -3, y: 1, z: -7, w: 6, h: 3, d: 1 },
        { u: 22, v: 0, x: -5, y: -5, z: -5, w: 1, h: 3, d: 1 },
        { u: 22, v: 0, x: 4, y: -5, z: -5, w: 1, h: 3, d: 1 },
      ],
    },
    {
      name: 'body', pivot: [0, 5, 2], rot: [Math.PI / 2, 0, 0], cubes: [
        { u: 18, v: 4, x: -6, y: -10, z: -7, w: 12, h: 18, d: 10 },
        { u: 52, v: 0, x: -2, y: 2, z: -8, w: 4, h: 6, d: 1 },
      ],
    },
    ...quadLegs(12, 4, 0, false, true),
  ],
};
/** SheepModel: twelve-pixel legs, a narrow head and body. 64 x 32. */
export const SHEEP = {
  texW: 64,
  texH: 32,
  parts: [
    { name: 'head', pivot: [0, 6, -8], cubes: [{ u: 0, v: 0, x: -3, y: -4, z: -6, w: 6, h: 6, d: 8 }] },
    { name: 'body', pivot: [0, 5, 2], rot: [Math.PI / 2, 0, 0], cubes: [{ u: 28, v: 8, x: -4, y: -10, z: -7, w: 8, h: 16, d: 6 }] },
    ...quadLegs(12, 3, 0, false, true),
  ],
};
/** SheepFurModel: the wool over the sheep, part for part, swollen 0.6 / 1.75 / 0.5. 64 x 32, tinted. */
export const SHEEP_FUR = {
  texW: 64,
  texH: 32,
  parts: [
    { name: 'head', pivot: [0, 6, -8], cubes: [{ u: 0, v: 0, x: -3, y: -4, z: -4, w: 6, h: 6, d: 6, inflate: 0.6 }] },
    { name: 'body', pivot: [0, 5, 2], rot: [Math.PI / 2, 0, 0], cubes: [{ u: 28, v: 8, x: -4, y: -10, z: -7, w: 8, h: 16, d: 6, inflate: 1.75 }] },
    ...[[-3, 7, 'rightHindLeg'], [3, 7, 'leftHindLeg'], [-3, -5, 'rightFrontLeg'], [3, -5, 'leftFrontLeg']].map(([x, z, name]) => (
      { name, pivot: [x, 12, z], cubes: [{ u: 0, v: 16, x: -2, y: 0, z: -2, w: 4, h: 6, d: 4, inflate: 0.5 }] })),
  ],
};
/** AdultChickenModel: the head with its beak and wattle, the body, the legs and the wings. 64 x 32. */
export const CHICKEN = {
  texW: 64,
  texH: 32,
  parts: [
    {
      name: 'head', pivot: [0, 15, -4], cubes: [{ u: 0, v: 0, x: -2, y: -6, z: -2, w: 4, h: 6, d: 3 }],
      children: [
        { name: 'beak', cubes: [{ u: 14, v: 0, x: -2, y: -4, z: -4, w: 4, h: 2, d: 2 }] },
        { name: 'redThing', cubes: [{ u: 14, v: 4, x: -1, y: -2, z: -3, w: 2, h: 2, d: 2 }] },
      ],
    },
    { name: 'body', pivot: [0, 16, 0], rot: [Math.PI / 2, 0, 0], cubes: [{ u: 0, v: 9, x: -3, y: -4, z: -3, w: 6, h: 8, d: 6 }] },
    { name: 'rightLeg', pivot: [-2, 19, 1], cubes: [{ u: 26, v: 0, x: -1, y: 0, z: -3, w: 3, h: 5, d: 3 }] },
    { name: 'leftLeg', pivot: [1, 19, 1], cubes: [{ u: 26, v: 0, x: -1, y: 0, z: -3, w: 3, h: 5, d: 3 }] },
    { name: 'rightWing', pivot: [-4, 13, 0], cubes: [{ u: 24, v: 13, x: 0, y: 0, z: -3, w: 1, h: 4, d: 6 }] },
    { name: 'leftWing', pivot: [4, 13, 0], cubes: [{ u: 24, v: 13, x: -1, y: 0, z: -3, w: 1, h: 4, d: 6 }] },
  ],
};
/** CreeperModel: the head and body on one pivot, four six-pixel legs. 64 x 32. It walks as a
 * quadruped does, so poseQuadruped moves it. */
const creeperLeg = [{ u: 0, v: 16, x: -2, y: 0, z: -2, w: 4, h: 6, d: 4 }];
export const CREEPER = {
  texW: 64,
  texH: 32,
  parts: [
    { name: 'head', pivot: [0, 6, 0], cubes: [{ u: 0, v: 0, x: -4, y: -8, z: -4, w: 8, h: 8, d: 8 }] },
    { name: 'body', pivot: [0, 6, 0], cubes: [{ u: 16, v: 16, x: -4, y: 0, z: -2, w: 8, h: 12, d: 4 }] },
    { name: 'rightHindLeg', pivot: [-2, 18, 4], cubes: creeperLeg },
    { name: 'leftHindLeg', pivot: [2, 18, 4], cubes: creeperLeg },
    { name: 'rightFrontLeg', pivot: [-2, 18, -4], cubes: creeperLeg },
    { name: 'leftFrontLeg', pivot: [2, 18, -4], cubes: creeperLeg },
  ],
};
/** ShulkerModel's shell, as a shulker box wears it: the lid over the base, both pivoted at the
 * bottom. The box opens as ShulkerBoxModel.setupAnim opens it -- see poseShulkerBox. 64 x 64. */
export const SHULKER_BOX = {
  texW: 64,
  texH: 64,
  parts: [
    { name: 'lid', pivot: [0, 24, 0], cubes: [{ u: 0, v: 0, x: -8, y: -16, z: -8, w: 16, h: 12, d: 16 }] },
    { name: 'base', pivot: [0, 24, 0], cubes: [{ u: 0, v: 28, x: -8, y: -8, z: -8, w: 16, h: 8, d: 16 }] },
  ],
};
/** ShulkerBoxModel.setupAnim: the lid rises half a block and turns 270 degrees as it opens (0 to 1). */
export function poseShulkerBox(parts, open) {
  parts.lid.position.y = 24 - open * 0.5 * 16;
  parts.lid.rotation.y = open * 270 * (Math.PI / 180);
}
/** EndermanModel: HumanoidModel stretched -- thirty-pixel arms and legs, the head and body fourteen
 * pixels up. 64 x 32; the eyes are a second layer on the same mesh (enderman_eyes). */
const endermanLimb = (mirror) => [{ u: 56, v: 0, x: -1, y: -2, z: -1, w: 2, h: 30, d: 2, mirror }];
export const ENDERMAN = {
  texW: 64,
  texH: 32,
  parts: [
    {
      name: 'head', pivot: [0, -13, 0], cubes: [{ u: 0, v: 0, x: -4, y: -8, z: -4, w: 8, h: 8, d: 8 }],
      children: [{ name: 'hat', cubes: [{ u: 0, v: 16, x: -4, y: -8, z: -4, w: 8, h: 8, d: 8, inflate: -0.5 }] }],
    },
    { name: 'body', pivot: [0, -14, 0], cubes: [{ u: 32, v: 16, x: -4, y: 0, z: -2, w: 8, h: 12, d: 4 }] },
    { name: 'rightArm', pivot: [-5, -12, 0], cubes: endermanLimb(false) },
    { name: 'leftArm', pivot: [5, -12, 0], cubes: endermanLimb(true) },
    { name: 'rightLeg', pivot: [-2, -5, 0], cubes: [{ u: 56, v: 0, x: -1, y: 0, z: -1, w: 2, h: 30, d: 2 }] },
    { name: 'leftLeg', pivot: [2, -5, 0], cubes: [{ u: 56, v: 0, x: -1, y: 0, z: -1, w: 2, h: 30, d: 2, mirror: true }] },
  ],
};
/** EndCrystalModel's crystal: two glass cubes, the inner at 0.875, the cube inside that at 0.765625
 * (its base left off, as the crystals on the End's obsidian pillars are spawned without one).
 * 64 x 32 (the texture is drawn at twice that). The glass turns as EndCrystalRenderer turns it. */
export const END_CRYSTAL = {
  texW: 64,
  texH: 32,
  parts: [{
    name: 'outerGlass', cubes: [{ u: 0, v: 0, x: -4, y: -4, z: -4, w: 8, h: 8, d: 8 }],
    children: [{
      name: 'innerGlass', scale: 0.875, cubes: [{ u: 0, v: 0, x: -4, y: -4, z: -4, w: 8, h: 8, d: 8 }],
      children: [{ name: 'cube', scale: 0.765625, cubes: [{ u: 32, v: 0, x: -4, y: -4, z: -4, w: 8, h: 8, d: 8 }] }],
    }],
  }],
};
/** BlazeModel: the head, and twelve rods round it in three rings that turn and bob (poseBlaze). 64 x 32. */
export const BLAZE = {
  texW: 64,
  texH: 32,
  parts: [
    { name: 'head', cubes: [{ u: 0, v: 0, x: -4, y: -4, z: -4, w: 8, h: 8, d: 8 }] },
    ...Array.from({ length: 12 }, (_, i) => ({ name: `rod${i}`, cubes: [{ u: 0, v: 16, x: 0, y: 0, z: 0, w: 2, h: 8, d: 2 }] })),
  ],
};
/** BlazeModel.setupAnim: four rods a ring at radius 9, 7 and 5, each ring turning its own way. */
export function poseBlaze(parts, ticks) {
  let a = ticks * Math.PI * -0.1;
  for (let i = 0; i < 4; i += 1, a += Math.PI / 2) parts[`rod${i}`].position.set(Math.cos(a) * 9, -2 + Math.cos((i * 2 + ticks) * 0.25), Math.sin(a) * 9);
  a = Math.PI / 4 + ticks * Math.PI * 0.03;
  for (let i = 4; i < 8; i += 1, a += Math.PI / 2) parts[`rod${i}`].position.set(Math.cos(a) * 7, 2 + Math.cos((i * 2 + ticks) * 0.25), Math.sin(a) * 7);
  a = 0.47123894 + ticks * Math.PI * -0.05;
  for (let i = 8; i < 12; i += 1, a += Math.PI / 2) parts[`rod${i}`].position.set(Math.cos(a) * 5, 11 + Math.cos((i * 1.5 + ticks) * 0.5), Math.sin(a) * 5);
}
/** HappyGhastModel (the grown one): a sixteen-pixel body and nine tentacles under it, the whole
 * layer drawn at four times size (place it at a quarter block a pixel). 64 x 64 (the texture is drawn
 * at twice that). The tentacles sway as GhastModel.animateTentacles sways them: poseGhast. */
const tentacle = (i, h, x, z) => ({ name: `tentacle${i}`, pivot: [x, 7, z], cubes: [{ u: 0, v: 0, x: -1, y: 0, z: -1, w: 2, h, d: 2 }] });
export const HAPPY_GHAST = {
  texW: 64,
  texH: 64,
  parts: [{
    name: 'body', pivot: [0, 16, 0], cubes: [{ u: 0, v: 0, x: -8, y: -8, z: -8, w: 16, h: 16, d: 16 }],
    children: [
      tentacle(0, 5, -3.75, -5), tentacle(1, 7, 1.25, -5), tentacle(2, 4, 6.25, -5),
      tentacle(3, 5, -6.25, 0), tentacle(4, 5, -1.25, 0), tentacle(5, 7, 3.75, 0),
      tentacle(6, 8, -3.75, 5), tentacle(7, 8, 1.25, 5), tentacle(8, 5, 6.25, 5),
    ],
  }],
};
/** HappyGhastHarnessModel: the harness over the body and the goggles across its front. 64 x 64. */
export const HAPPY_GHAST_HARNESS = {
  texW: 64,
  texH: 64,
  parts: [
    { name: 'harness', pivot: [0, 24, 0], cubes: [{ u: 0, v: 0, x: -8, y: -16, z: -8, w: 16, h: 16, d: 16 }] },
    { name: 'goggles', pivot: [0, 14, -5.5], cubes: [{ u: 0, v: 32, x: -8, y: -2.5, z: -2.5, w: 16, h: 5, d: 5, inflate: 0.15 }] },
  ],
};
/** GhastModel.animateTentacles: each tentacle swings 0.2 either side of 0.4, out of step with the next. */
export function poseGhast(parts, ticks) {
  for (let i = 0; i < 9; i += 1) parts[`tentacle${i}`].rotation.x = 0.2 * Math.sin(ticks * 0.3 + i) + 0.4;
}
/** MinecartModel: the floor and four sides round it, flat-packed as the game packs them. 64 x 32. */
export const MINECART = {
  texW: 64,
  texH: 32,
  parts: [
    { name: 'bottom', pivot: [0, 4, 0], rot: [Math.PI / 2, 0, 0], cubes: [{ u: 0, v: 10, x: -10, y: -8, z: -1, w: 20, h: 16, d: 2 }] },
    { name: 'front', pivot: [-9, 4, 0], rot: [0, (3 * Math.PI) / 2, 0], cubes: [{ u: 0, v: 0, x: -8, y: -9, z: -1, w: 16, h: 8, d: 2 }] },
    { name: 'back', pivot: [9, 4, 0], rot: [0, Math.PI / 2, 0], cubes: [{ u: 0, v: 0, x: -8, y: -9, z: -1, w: 16, h: 8, d: 2 }] },
    { name: 'left', pivot: [0, 4, -7], rot: [0, Math.PI, 0], cubes: [{ u: 0, v: 0, x: -8, y: -9, z: -1, w: 16, h: 8, d: 2 }] },
    { name: 'right', pivot: [0, 4, 7], cubes: [{ u: 0, v: 0, x: -8, y: -9, z: -1, w: 16, h: 8, d: 2 }] },
  ],
};
/** QuadrupedModel.setupAnim's walk: the legs swing as cos(0.6662 t) x 1.4 x speed, diagonals together. */
export function poseQuadruped(parts, walk, speed, headPitch = 0) {
  const swing = Math.cos(walk * 0.6662) * 1.4 * speed;
  parts.rightHindLeg.rotation.x = swing;
  parts.leftHindLeg.rotation.x = -swing;
  parts.rightFrontLeg.rotation.x = -swing;
  parts.leftFrontLeg.rotation.x = swing;
  parts.head.rotation.x = headPitch;
}
/** ChickenModel.setupAnim: the legs as a quadruped's, the wings flapping with `flap`. */
export function poseChicken(parts, walk, speed, flap) {
  const swing = Math.cos(walk * 0.6662) * 1.4 * speed;
  parts.rightLeg.rotation.x = swing;
  parts.leftLeg.rotation.x = -swing;
  parts.rightWing.rotation.z = flap;
  parts.leftWing.rotation.z = -flap;
}

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

const opaqueSources = new WeakMap();
/** Whether every pixel of an image is fully opaque (looked at once per image). */
function isOpaque(source) {
  if (opaqueSources.has(source)) return opaqueSources.get(source);
  let opaque = false;
  try {
    const w = source.width;
    const h = source.height;
    if (w && h && w * h <= 512 * 512) {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(source, 0, 0);
      const data = g.getImageData(0, 0, w, h).data;
      opaque = true;
      for (let i = 3; i < data.length; i += 4) if (data[i] < 255) { opaque = false; break; }
    }
  } catch {
    opaque = false;
  }
  opaqueSources.set(source, opaque);
  return opaque;
}

/**
 * A texture drawn as Minecraft draws one: each pixel a sharp square up close. A solid texture (a
 * block's) also gets mipmaps and anisotropic filtering, as the game's own mipmap levels do, so a
 * floor running into the distance holds still instead of crawling; one with see-through pixels
 * keeps to plain nearest sampling, since averaged-down alpha would eat its thin cut-outs.
 */
export function pixelTexture(THREE, source) {
  const t = new THREE.CanvasTexture(source);
  t.magFilter = THREE.NearestFilter;
  t.colorSpace = THREE.SRGBColorSpace;
  if (isOpaque(source)) {
    t.minFilter = THREE.NearestMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 16;
  } else {
    t.minFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
  }
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
 * frame can run (`frameTo`) over the particle's life, the way firework sparks burn down. `a` scales
 * a particle's opacity (smoke is never solid) and `fadeIn` is the share of its life it takes to
 * appear (a firefly lighting up).
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
        r: o.r ?? 1, g: o.g ?? 1, b: o.b ?? 1, a: o.a ?? 1, twinkle: o.twinkle || false, fade: o.fade ?? 0.3,
        fadeIn: o.fadeIn ?? 0,
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
        const alpha = (t > 1 - p.fade ? (1 - t) / p.fade : 1) * (t < p.fadeIn ? t / p.fadeIn : 1) * p.a;
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
