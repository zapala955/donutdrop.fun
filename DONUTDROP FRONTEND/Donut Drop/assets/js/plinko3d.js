/* plinko3d.js — Plinko in 3D: a board in the End, ender pearls falling through end rods into
 * shulker boxes.
 *
 * Every block, item, particle and model is the game's own, out of the client jar: the purpur wall and
 * its pillars, the end rods standing out of it as pegs (the block model's base and rod), the
 * dispenser at the top the pearls drop from, the ender pearl as a thrown pearl is drawn (its item
 * sprite, turned to the camera), the shulker boxes the pearls land in -- ShulkerModel's shell, the lid
 * rising and turning as ShulkerBoxModel opens it -- the end stone island, the obsidian pillars and
 * the crystals on them, chorus plants, two endermen with their glowing eyes, the end sky, the portal
 * particles a pearl leaves where it lands and the end rods' glitter, end city towers out on the
 * island. What is drawn rather than taken is light: the rods' glow and their halos, a box lit as a
 * pearl goes in, the crystals', the purple flash the End's sky gives now and then.
 *
 * Nothing here decides anything. plinko.js owns every ball: it hands this module the position of
 * each falling pearl in board units, every frame it moves, the peg each one strikes and the slot it
 * lands in. The payouts stay the page's own row of slots under the canvas; this module says where
 * its shulker boxes stand (onLayout), so the row lines up under them. If WebGL is missing or the
 * context is lost, plinko.js puts the flat board back.
 *
 * Low-end machines get less (quality3d.js): no glow, fewer particles, a steady thirty frames a
 * second; a machine that cannot keep up steps down on its own.
 */
import { reduceMotion } from './util.js';
import { getTHREE, loadImage, softDot } from './mc3d.js';
import { ENDERMAN, END_CRYSTAL, SHULKER_BOX, atlas, buildModel, makeSprites, pixelTexture, placeEntity, poseShulkerBox } from './mcmodels.js';
import { dragonEgg, glowPoints, gradePass } from './scenery3d.js';
import { BRIGHTNESS, chooseTier, createGovernor, frameMs, minFpsFor, ratioFor } from './quality3d.js';

/* The board, in the units plinko.js uses: one peg gap. Mirrored from plinko.js. */
const TOP = 1.1;
const ROW = 0.9;
const FOOT = 0.9;
const BALL_R = 0.26;
const G = 0.5;                 // world blocks per board unit: the pegs half a block apart
const ROD = 0.5;               // the end rods at half size, so a peg is a peg and not a fence
const SLOT = G * 0.9;          // a shulker box, a little narrower than its slot
const PEARL = 0.36;            // the pearl's sprite, so its round body is the ball's width
const ROD_Z = 16 * (ROD / 16); // how far a rod stands out of the wall
const PEARL_Z = ROD_Z * 0.6;
// Gold at the centre to crimson at the edges, as the page colours its slots.
const COLOURS = ['yellow', 'orange', 'red', 'magenta'];

const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
const easeOut = (t) => 1 - (1 - t) ** 3;
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** How far out a slot sits, 0 at the centre to 1 at the edge -- as plinko.js colours it. */
const heat = (slot, n) => Math.pow(Math.abs(slot - n / 2) / (n / 2), 1.3);

/** Points a box's six faces (three's order: +x, -x, +y, -y, +z, -z) at regions of a 16-pixel
 * texture, as a block model's element faces do: [u0, v0, u1, v1] in pixels. */
function regionUV(geometry, faces, size = 16) {
  const uv = geometry.attributes.uv;
  for (let f = 0; f < 6; f += 1) {
    const [u0, v0, u1, v1] = faces[f];
    for (let k = 0; k < 4; k += 1) {
      const i = f * 4 + k;
      const uu = uv.getX(i);
      const vv = uv.getY(i);
      uv.setXY(i, (u0 + uu * (u1 - u0)) / size, 1 - (v0 + (1 - vv) * (v1 - v0)) / size);
    }
  }
  uv.needsUpdate = true;
  return geometry;
}

/**
 * Builds the End into `host` and resolves with its controls, or null when this browser cannot draw
 * it.
 */
export async function createPlinko3d(host) {
  const THREE = await getTHREE();
  const probe = document.createElement('canvas');
  const probeGl = probe.getContext('webgl2');
  if (!probeGl) return null;
  const tier = chooseTier(probeGl);
  probeGl.getExtension('WEBGL_lose_context')?.loseContext();
  const canvas = document.createElement('canvas');
  canvas.className = 'plinko__gl';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.dataset.tier = tier.name;
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: tier.antialias, powerPreference: 'high-performance' });
  } catch {
    return null;
  }
  let ratio = ratioFor(tier);
  canvas.dataset.ratio = String(ratio);
  renderer.setPixelRatio(ratio);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1 * BRIGHTNESS;
  const scale = (n) => Math.max(1, Math.round(n * tier.particles));
  const FRAME_MS = frameMs(tier);
  let nextFrameAt = 0;

  /* ── what is loaded ── */
  const BLOCKS = ['end_rod', 'purpur_block', 'purpur_pillar_side', 'purpur_pillar_top', 'end_stone', 'end_stone_bricks', 'obsidian',
    'dispenser_front_vertical', 'furnace_side', 'furnace_top', 'chorus_plant', 'chorus_flower', 'bedrock', 'dragon_egg', 'torch'];
  const ENTITY = ['enderman', 'enderman_eyes', 'end_crystal', ...COLOURS.map((c) => `shulker_${c}`)];
  const PARTICLE = [...Array.from({ length: 8 }, (_, i) => `glitter_${i}`), ...Array.from({ length: 8 }, (_, i) => `generic_${i}`)];
  let loaded;
  try {
    loaded = await Promise.all([
      Promise.all(BLOCKS.map((name) => loadImage(`assets/img/block/${name}.png`))),
      Promise.all(ENTITY.map((name) => loadImage(`assets/img/entity/${name}.png`))),
      Promise.all(PARTICLE.map((name) => loadImage(`assets/img/particle/${name}.png`))),
      loadImage('assets/img/env/end_sky.png'),
      loadImage('assets/img/items/ender_pearl.png'),
      tier.composer
        ? import(/* @vite-ignore */ new URL('assets/vendor/three-addons.js', document.baseURI).href).catch(() => null)
        : Promise.resolve(null),
    ]);
  } catch {
    renderer.dispose();
    return null;
  }
  const [blockImgs, entityImgs, particleImgs, skyImg, pearlImg, addons] = loaded;
  const img = Object.fromEntries(BLOCKS.map((name, i) => [name, blockImgs[i]]));
  const ent = Object.fromEntries(ENTITY.map((name, i) => [name, entityImgs[i]]));
  const part = Object.fromEntries(PARTICLE.map((name, i) => [name, particleImgs[i]]));
  host.prepend(canvas);

  const reduce = reduceMotion();
  const scene = new THREE.Scene();
  const VOID = 0x0c0912;
  scene.background = new THREE.Color(VOID);
  scene.fog = new THREE.FogExp2(VOID, 0.011);
  const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 400);
  scene.add(camera);

  let composer = null;
  let bloom = null;
  if (addons) {
    try {
      const target = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: tier.samples });
      composer = new addons.EffectComposer(renderer, target);
      composer.addPass(new addons.RenderPass(scene, camera));
      bloom = new addons.UnrealBloomPass(new THREE.Vector2(4, 4), 0.55, 0.45, 0.9);
      composer.addPass(bloom);
      composer.addPass(new addons.OutputPass());
      composer.addPass(gradePass(THREE, addons, { contrast: 1.07, saturation: 1.12, lift: [0.02, 0.0, 0.035], gain: [1.0, 0.97, 1.04], vignette: 0.18 }));
    } catch {
      composer = null;
      bloom = null;
    }
  }
  const tex = (name, rx = 1, ry = rx) => {
    const t = pixelTexture(THREE, img[name]);
    if (rx !== 1 || ry !== 1) {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(rx, ry);
    }
    return t;
  };
  const lambert = (map, opts = {}) => new THREE.MeshLambertMaterial({ map, ...opts });

  /* ── light: the End has no sun; a still, cool light everywhere, brighter when the sky flashes ── */
  const hemi = new THREE.HemisphereLight(0xc8b8e0, 0x2c2436, 1.25);
  scene.add(hemi);
  const front = new THREE.DirectionalLight(0xf0e8ff, 0.9);
  front.position.set(-3, 6, 12);
  scene.add(front, front.target);

  /* ── the sky: the end sky's noise, tinted as the game tints it, round everything ── */
  const skyTex = pixelTexture(THREE, skyImg);
  skyTex.wrapS = skyTex.wrapT = THREE.RepeatWrapping;
  skyTex.repeat.set(16, 16);
  const SKY = new THREE.Color(0.085, 0.065, 0.11);
  const skyMat = new THREE.MeshBasicMaterial({ map: skyTex, color: SKY.clone(), side: THREE.BackSide, fog: false, depthWrite: false });
  const sky = new THREE.Mesh(new THREE.BoxGeometry(300, 300, 300), skyMat);
  sky.renderOrder = -10;
  scene.add(sky);

  /* ── the island: end stone underfoot, chorus at its edges, the void and other islands beyond ── */
  {
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(70, 46).rotateX(-Math.PI / 2), lambert(tex('end_stone', 70, 46)));
    ground.position.set(0, 0, -8);
    scene.add(ground);
    const rand = seeded(41);
    const box = new THREE.BoxGeometry(1, 1, 1);
    const stone = lambert(tex('end_stone'));
    const blocks = [];
    // A ragged rim of end stone round the island, and floating islands out in the void.
    for (let i = 0; i < 90; i += 1) {
      const a = (i / 90) * Math.PI * 2;
      const r = 30 + rand() * 6;
      const x = Math.cos(a) * r;
      const z = -10 + Math.sin(a) * r * 0.75;
      if (z > 8) continue;
      for (let y = 0; y < 1 + Math.floor(rand() * 3); y += 1) blocks.push([Math.round(x) + 0.5, y + 0.5, Math.round(z) + 0.5]);
    }
    for (const [cx, cy, cz, size] of [[-46, 6, -70, 6], [52, -2, -80, 8], [10, 14, -110, 9], [-70, -4, -40, 5], [70, 9, -50, 5]]) {
      for (let k = 0; k < size * size * 1.4; k += 1) {
        const x = cx + Math.round((rand() - 0.5) * size * 2);
        const z = cz + Math.round((rand() - 0.5) * size * 2);
        const d = Math.hypot(x - cx, z - cz) / size;
        if (d > 1) continue;
        const depth = Math.ceil((1 - d) * size * 0.8);
        for (let y = 0; y < depth; y += 1) blocks.push([x + 0.5, cy - y + 0.5, z + 0.5]);
      }
    }
    const mesh = new THREE.InstancedMesh(box, stone, blocks.length);
    const m = new THREE.Matrix4();
    blocks.forEach(([x, y, z], i) => mesh.setMatrixAt(i, m.makeTranslation(x, y, z)));
    scene.add(mesh);
    // Chorus: stalks of chorus plant topped with a flower, a branch or two off them.
    const chorus = lambert(tex('chorus_plant'));
    const flower = lambert(tex('chorus_flower'), { emissive: 0x1a0f22 });
    const stalk = new THREE.BoxGeometry(10 / 16, 1, 10 / 16);
    const parts = [];
    const tops = [];
    for (const [x, z, tall] of [[-10, -3, 4], [-13, -7, 6], [11, -4, 5], [14, -9, 3], [-7, -11, 3], [8, -12, 4], [-17, -1, 3]]) {
      for (let y = 0; y < tall; y += 1) parts.push([x + 0.5, y + 0.5, z + 0.5]);
      tops.push([x + 0.5, tall + 0.5, z + 0.5]);
      const side = rand() < 0.5 ? 1 : -1;
      const at = Math.max(1, tall - 2);
      parts.push([x + 0.5 + side, at + 0.5, z + 0.5]);
      parts.push([x + 0.5 + side, at + 1.5, z + 0.5]);
      tops.push([x + 0.5 + side, at + 2.5, z + 0.5]);
    }
    const stalks = new THREE.InstancedMesh(stalk, chorus, parts.length);
    parts.forEach(([x, y, z], i) => stalks.setMatrixAt(i, m.makeTranslation(x, y, z)));
    scene.add(stalks);
    const flowers = new THREE.InstancedMesh(box, flower, tops.length);
    tops.forEach(([x, y, z], i) => flowers.setMatrixAt(i, m.makeTranslation(x, y, z)));
    scene.add(flowers);
  }

  /* ── end city towers out on the island: purpur, a wider floor near the top, end rods on the roof ── */
  {
    const box = new THREE.BoxGeometry(1, 1, 1);
    const purpur = [];
    const pillars = [];
    const rods = [];
    for (const [cx, cz, tall] of [[-21, -24, 15], [24, -27, 19], [-34, -12, 11]]) {
      for (let y = 0; y < tall; y += 1) {
        const r = y > tall - 4 ? 3 : 2;
        for (let dx = -r; dx <= r; dx += 1) {
          for (let dz = -r; dz <= r; dz += 1) {
            const edge = Math.abs(dx) === r || Math.abs(dz) === r;
            if (!edge && y > 0 && y < tall - 1) continue;
            const corner = Math.abs(dx) === r && Math.abs(dz) === r;
            (corner ? pillars : purpur).push([cx + dx, y + 0.5, cz + dz]);
          }
        }
      }
      for (const [dx, dz] of [[-3, -3], [3, -3], [-3, 3], [3, 3]]) rods.push([cx + dx, tall + 0.5, cz + dz]);
    }
    const m = new THREE.Matrix4();
    const put = (list, material) => {
      const mesh = new THREE.InstancedMesh(box, material, list.length);
      list.forEach(([x, y, z], i) => mesh.setMatrixAt(i, m.makeTranslation(x, y, z)));
      scene.add(mesh);
    };
    put(purpur, lambert(tex('purpur_block')));
    put(pillars, [lambert(tex('purpur_pillar_side')), lambert(tex('purpur_pillar_side')), lambert(tex('purpur_pillar_top')), lambert(tex('purpur_pillar_top')), lambert(tex('purpur_pillar_side')), lambert(tex('purpur_pillar_side'))]);
    const towerGlow = glowPoints(THREE, rods, { size: 2.2, color: 0xffe6ff, opacity: 0.7 });
    scene.add(towerGlow.points);
  }

  /* ── the obsidian pillars, an end crystal turning on each ── */
  const crystals = [];
  {
    const crystalMat = new THREE.MeshLambertMaterial({ map: pixelTexture(THREE, ent.end_crystal), transparent: true, alphaTest: 0.1, side: THREE.DoubleSide, emissive: 0x5a3a6a });
    const glowTex = softDot('rgba(255,190,255,1)');
    for (const [x, z, h, w] of [[-24, -34, 22, 4], [18, -40, 28, 5], [-8, -58, 34, 5], [36, -28, 16, 3], [-42, -22, 19, 4], [44, -56, 30, 5]]) {
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(w, h, w), lambert(tex('obsidian', w, h)));
      pillar.position.set(x, h / 2 - 2, z);
      scene.add(pillar);
      const model = buildModel(THREE, [{ material: crystalMat, def: END_CRYSTAL }]);
      const holder = new THREE.Group();
      holder.add(model.root);
      model.root.scale.setScalar(2 / 16);
      holder.position.set(x, h - 2 + 1.4, z);
      scene.add(holder);
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: new THREE.Color(1.4, 0.9, 1.6), transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
      glow.scale.setScalar(5);
      holder.add(glow);
      crystals.push({ model, holder, phase: x * 0.13 });
    }
  }

  /* ── the board: purpur, end rods for pegs, the dispenser, the shulker boxes ── */
  const purpurMat = new THREE.MeshLambertMaterial({ map: tex('purpur_block') });
  const pillarMats = [lambert(tex('purpur_pillar_side')), lambert(tex('purpur_pillar_top'))];
  const brickTex = tex('end_stone_bricks');
  brickTex.wrapS = brickTex.wrapT = THREE.RepeatWrapping;
  const rodTex = tex('end_rod');
  const rodMat = new THREE.MeshBasicMaterial({ map: rodTex, color: new THREE.Color(1.15, 1.12, 1.1), toneMapped: false });
  // The end rod block model at half size, standing out of the wall at the camera: its base flat on
  // the purpur, the rod from it.
  const rodBase = regionUV(new THREE.BoxGeometry(4 / 16, 1 / 16, 4 / 16), [[2, 6, 6, 7], [2, 6, 6, 7], [2, 2, 6, 6], [6, 6, 2, 2], [2, 6, 6, 7], [2, 6, 6, 7]]);
  rodBase.translate(0, 0.5 / 16, 0);
  const rodStick = regionUV(new THREE.BoxGeometry(2 / 16, 15 / 16, 2 / 16), [[0, 0, 2, 15], [0, 0, 2, 15], [2, 0, 4, 2], [2, 0, 4, 2], [0, 0, 2, 15], [0, 0, 2, 15]]);
  rodStick.translate(0, 1 / 16 + 7.5 / 16, 0);
  for (const g of [rodBase, rodStick]) {
    g.scale(ROD, ROD, ROD);
    g.rotateX(Math.PI / 2);
  }
  const shulkerMats = Object.fromEntries(COLOURS.map((c) => [c, new THREE.MeshLambertMaterial({ map: pixelTexture(THREE, ent[`shulker_${c}`]) })]));
  const dispenser = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), [
    lambert(tex('furnace_side')), lambert(tex('furnace_side')), lambert(tex('furnace_top')),
    lambert(tex('dispenser_front_vertical')), lambert(tex('furnace_side')), lambert(tex('furnace_side')),
  ]);
  scene.add(dispenser);

  const board = { n: 0, group: null, pegs: null, bases: null, pegIndex: new Map(), flashes: new Map(), shulkers: [], y0: 0, width: 0, height: 0 };
  const rodColour = new THREE.Color(1, 1, 1);
  function buildBoard(n) {
    if (board.group) {
      scene.remove(board.group);
      board.group.traverse((o) => { if (o.isInstancedMesh) o.dispose(); });
    }
    const group = new THREE.Group();
    const mid = (n + 2) / 2;
    const depth = TOP + (n - 1) * ROW + FOOT;
    const y0 = depth * G + SLOT;
    const width = (n + 2) * G;
    const height = y0 + 1.4;
    Object.assign(board, { n, group, y0, width, height, mid, pegIndex: new Map(), flashes: new Map(), shulkers: [] });
    // The wall, a block of purpur a block, from the ground to over the dispenser.
    const wallW = width + 0.5;
    const wallTex = tex('purpur_block', wallW, height);
    // A shade darker than the pillars, so the rods' light carries across it.
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(wallW, height), new THREE.MeshLambertMaterial({ map: wallTex, color: 0x8d7aa3 }));
    wall.position.set(0, height / 2, 0);
    group.add(wall);
    // Purpur pillars either side, end stone bricks along the top.
    for (const side of [-1, 1]) {
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.75, height + 0.4, 0.75), [pillarMats[0], pillarMats[0], pillarMats[1], pillarMats[1], pillarMats[0], pillarMats[0]]);
      pillar.position.set(side * (wallW / 2 + 0.375), (height + 0.4) / 2, 0.1);
      group.add(pillar);
    }
    const topTex = brickTex.clone();
    topTex.needsUpdate = true;
    topTex.repeat.set(wallW + 1.5, 1);
    const beam = new THREE.Mesh(new THREE.BoxGeometry(wallW + 1.5, 0.5, 0.9), lambert(topTex));
    beam.position.set(0, height + 0.15, 0.15);
    group.add(beam);
    // The pegs: one instance per end rod, its colour lit when a pearl strikes it.
    let count = 0;
    for (let r = 0; r < n; r += 1) count += r + 3;
    const bases = new THREE.InstancedMesh(rodBase, rodMat, count);
    const pegs = new THREE.InstancedMesh(rodStick, rodMat, count);
    const m = new THREE.Matrix4();
    let i = 0;
    for (let r = 0; r < n; r += 1) {
      for (let j = 0; j < r + 3; j += 1) {
        const x = (j - (r + 2) / 2) * G;
        const y = y0 - (TOP + r * ROW) * G;
        m.makeTranslation(x, y, 0.001);
        bases.setMatrixAt(i, m);
        pegs.setMatrixAt(i, m);
        pegs.setColorAt(i, rodColour);
        board.pegIndex.set(`${r}:${j}`, i);
        i += 1;
      }
    }
    pegs.instanceColor.setUsage(THREE.DynamicDrawUsage);
    group.add(bases, pegs);
    board.pegs = pegs;
    // A halo at every rod's tip, as an end rod glows; flared when a pearl strikes it.
    const tips = [];
    for (let r = 0; r < n; r += 1) for (let j = 0; j < r + 3; j += 1) tips.push([(j - (r + 2) / 2) * G, y0 - (TOP + r * ROW) * G, ROD_Z]);
    board.halos = glowPoints(THREE, tips, { size: 0.6, color: 0xf3e2ff, opacity: 0.62 });
    group.add(board.halos.points);
    // A light over every box, dark until a pearl goes in.
    board.boxGlow = glowPoints(THREE, Array.from({ length: n + 1 }, (_, slot) => [(1 + slot - mid) * G, SLOT * 0.9, SLOT + 0.1]), { size: 1.4, color: 0x000000, opacity: 0.9 });
    group.add(board.boxGlow.points);
    // The shulker boxes, one a slot, coloured as far out as they sit.
    for (let slot = 0; slot <= n; slot += 1) {
      const colour = COLOURS[Math.min(COLOURS.length - 1, Math.floor(heat(slot, n) * COLOURS.length))];
      const model = buildModel(THREE, [{ material: shulkerMats[colour], def: SHULKER_BOX }]);
      const entity = placeEntity(THREE, model, SLOT / 16);
      entity.position.set((1 + slot - mid) * G, 0, SLOT / 2 + 0.02);
      group.add(entity);
      board.shulkers.push({ model, entity, openAt: 0, x: (1 + slot - mid) * G });
    }
    dispenser.position.set(0, y0 + 0.45, 0.5);
    // The dragon egg on its bedrock pillar beside the board, four torches round it, as the exit
    // portal keeps it.
    const pillarX = -(wallW / 2 + 1.7);
    const EGG_Z = -2.6; // behind the enderman who stands at that side
    const bedrock = new THREE.Mesh(new THREE.BoxGeometry(1, 3, 1), lambert(tex('bedrock', 1, 3)));
    bedrock.position.set(pillarX, 1.5, EGG_Z);
    group.add(bedrock);
    const egg = dragonEgg(THREE, img.dragon_egg);
    egg.position.set(pillarX, 3, EGG_Z);
    group.add(egg);
    const torchGeo = new THREE.BoxGeometry(2 / 16, 10 / 16, 2 / 16);
    const torchUV = torchGeo.attributes.uv;
    for (let k = 0; k < torchUV.count; k += 1) torchUV.setXY(k, (7 + torchUV.getX(k) * 2) / 16, 1 - (6 + (1 - torchUV.getY(k)) * 10) / 16);
    const torchMat = new THREE.MeshBasicMaterial({ map: tex('torch'), color: new THREE.Color(1.3, 1.2, 1.05), toneMapped: false });
    const torchTips = [];
    for (const [dx, dz, rx, rz] of [[0.62, 0, 0, -1], [-0.62, 0, 0, 1], [0, 0.62, 1, 0], [0, -0.62, -1, 0]]) {
      const t = new THREE.Mesh(torchGeo, torchMat);
      t.position.set(pillarX + dx, 2.15, EGG_Z + dz);
      t.rotation.set(rx * 0.3927, 0, rz * 0.3927);
      group.add(t);
      torchTips.push([pillarX + dx * 1.25, 2.55, EGG_Z + dz * 1.25]);
    }
    const eggGlow = glowPoints(THREE, [...torchTips, [pillarX, 3.5, EGG_Z]], { size: 1.3, color: 0xffc070, opacity: 0.55 });
    eggGlow.setColor(4, 0.75, 0.35, 1);
    group.add(eggGlow.points);
    scene.add(group);
    layout(true);
  }
  /** A board position, in board units, to the world. */
  const toWorld = (x, y, out) => out.set((x - board.mid) * G, board.y0 - y * G, PEARL_Z);

  /* ── the pearls: thrown items, drawn as their sprite turned to the camera ── */
  const MAX_PEARLS = 32;
  const pearlMat = new THREE.MeshBasicMaterial({ map: pixelTexture(THREE, pearlImg), alphaTest: 0.5, color: new THREE.Color(1.05, 1.05, 1.05) });
  const pearls = new THREE.InstancedMesh(new THREE.PlaneGeometry(PEARL, PEARL), pearlMat, MAX_PEARLS);
  pearls.count = 0;
  pearls.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  pearls.frustumCulled = false;
  scene.add(pearls);
  let pearlList = [];

  /* ── two endermen, standing about; now and then one is somewhere else ── */
  const endermanMat = new THREE.MeshLambertMaterial({ map: pixelTexture(THREE, ent.enderman), alphaTest: 0.5 });
  const eyesMat = new THREE.MeshBasicMaterial({ map: pixelTexture(THREE, ent.enderman_eyes), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, color: new THREE.Color(1.4, 1.2, 1.6) });
  const endermen = [0, 1].map((k) => {
    const model = buildModel(THREE, [{ material: endermanMat, def: ENDERMAN }, { material: eyesMat, def: ENDERMAN }]);
    const entity = placeEntity(THREE, model, 1 / 16);
    scene.add(entity);
    return { model, entity, spot: k, look: k * 2.1, nextHop: 0 };
  });
  const spots = () => {
    const edge = board.width / 2 + 2.2;
    return [[-edge, 1.4], [edge, 1.1], [-edge - 3.5, -2.5], [edge + 3.2, -3], [-edge - 1, 3.4], [edge + 1.2, 3.6]];
  };
  const placeEnderman = (e) => {
    const [x, z] = spots()[e.spot];
    e.entity.position.set(x, 0, z);
    e.entity.rotation.y = Math.atan2(-x * 0.3, 8);
  };

  /* ── particles ── */
  const sprites = [];
  const sprite = (map, opts) => {
    const s = makeSprites(THREE, { map, ...opts });
    scene.add(s.points);
    sprites.push(s);
    return s;
  };
  const glitter = sprite(atlas(THREE, Array.from({ length: 8 }, (_, i) => part[`glitter_${i}`]), 8, 8).map, { cols: 8, rows: 1, count: scale(260), additive: true });
  const portal = sprite(atlas(THREE, Array.from({ length: 8 }, (_, i) => part[`generic_${i}`]), 8, 8).map, { cols: 8, rows: 1, count: scale(420), additive: true });
  /** End rod particles: the glitter running down from its brightest frame, drifting and falling. */
  function sparkle(x, y, z, n, spread = 0.1, up = 0.3) {
    if (reduce) return;
    for (let i = 0; i < scale(n); i += 1) {
      glitter.emit({ x: x + (Math.random() - 0.5) * spread, y: y + (Math.random() - 0.5) * spread, z: z + (Math.random() - 0.5) * spread, vx: (Math.random() - 0.5) * 0.4, vy: up * (Math.random() - 0.2), vz: Math.random() * 0.3, gravity: -0.6, drag: 0.6, life: 0.8 + Math.random() * 0.8, size: 0.11, sizeTo: 0.05, frame: 7, frameTo: 0, r: 1.2, g: 1.2, b: 1.25, fade: 0.4 });
    }
  }
  /** Portal particles, purple, in a burst where a pearl lands or an enderman goes. */
  function portalBurst(x, y, z, n, spread = 0.5, speed = 1.2) {
    if (reduce) return;
    for (let i = 0; i < scale(n); i += 1) {
      const k = 0.4 + Math.random() * 0.6;
      const a = Math.random() * Math.PI * 2;
      const u = Math.random() * 2 - 1;
      const rr = Math.sqrt(1 - u * u);
      portal.emit({ x: x + (Math.random() - 0.5) * spread, y: y + (Math.random() - 0.5) * spread, z: z + (Math.random() - 0.5) * spread, vx: Math.cos(a) * rr * speed, vy: u * speed + 0.3, vz: Math.sin(a) * rr * speed * 0.5, drag: 1.8, life: 0.6 + Math.random() * 0.6, size: 0.08, sizeTo: 0.02, frame: Math.floor(Math.random() * 8), r: 0.9 * k * 1.4, g: 0.3 * k * 1.4, b: k * 1.4, fade: 0.4 });
    }
  }

  /* ─────────── the camera: square on to the board, its slots along the bottom ─────────── */

  const look = new THREE.Vector3();
  const PITCH = THREE.MathUtils.degToRad(5);
  let rowLeft = -1;
  let rowWidth = -1;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  /** Frames the board: tall enough for all of it, wide enough on a narrow screen, and tells the page
   * where the row of shulker boxes now stands so the payouts can sit under it. */
  function layout(force = false) {
    if (!board.n) return;
    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    // Room round the board for the End: its pillars, the endermen, the void.
    const h = board.height * 1.12 + 0.5;
    const w = board.width + 1.6;
    const dist = Math.max(h / 2 / tanV, w / 2 / (tanV * camera.aspect));
    // The view's bottom edge a strip of island below the boxes: they sit just over the page's row of
    // payouts, and whatever height a narrow screen has to spare goes to the sky.
    look.set(0, -0.35 + dist * tanV, 0);
    camera.position.set(0, look.y + Math.sin(PITCH) * dist, Math.cos(PITCH) * dist);
    camera.lookAt(look);
    camera.updateMatrixWorld();
    // The row's ends: the outer edges of the first and last slots, at the boxes' front faces.
    a.set((0.5 - board.mid) * G, SLOT / 2, SLOT + 0.02).project(camera);
    b.set((board.n + 1.5 - board.mid) * G, SLOT / 2, SLOT + 0.02).project(camera);
    const left = ((a.x + 1) / 2) * lastW;
    const right = ((b.x + 1) / 2) * lastW;
    if (force || Math.abs(left - rowLeft) > 0.5 || Math.abs(right - left - rowWidth) > 0.5) {
      rowLeft = left;
      rowWidth = right - left;
      controls.onLayout?.({ left: rowLeft, width: rowWidth, host: lastW });
    }
    for (const e of endermen) placeEnderman(e);
  }

  /* ── framing, resolution, stepping down ── */
  let lastW = 0;
  let lastH = 0;
  const setRatio = (value) => {
    ratio = value;
    renderer.setPixelRatio(ratio);
    canvas.dataset.ratio = String(ratio);
    lastW = 0;
  };
  const governor = createGovernor([
    () => { if (bloom) bloom.enabled = false; },
    () => { composer?.dispose(); composer = null; },
    () => setRatio(Math.max(0.6, ratio * 0.75)),
    () => { for (const c of crystals) c.holder.visible = false; },
    () => setRatio(Math.max(0.5, ratio * 0.8)),
  ], { minFps: minFpsFor(tier) });
  function resize() {
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (!w || !h || (w === lastW && h === lastH)) return false;
    lastW = w;
    lastH = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (composer) {
      composer.setPixelRatio(ratio);
      composer.setSize(w, h);
      if (bloom && tier.bloomScale < 1) bloom.setSize(Math.round(w * ratio * tier.bloomScale), Math.round(h * ratio * tier.bloomScale));
    }
    const pxScale = (h * ratio * camera.projectionMatrix.elements[5]) / 2;
    for (const s of sprites) s.setScale(pxScale);
    layout(true);
    return true;
  }
  let lost = false;
  const onLost = (event) => { event.preventDefault(); lost = true; controls.onLost?.(); };
  canvas.addEventListener('webglcontextlost', onLost);

  let raf = 0;
  let last = performance.now();
  let clock = 0;
  let flashAt = -1e9;
  let flashPower = 0;
  let nextFlash = performance.now() + 9000 + Math.random() * 12000;
  let shake = 0;
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const v = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  const lit = new THREE.Color();
  function frame() {
    raf = requestAnimationFrame(frame);
    const now = performance.now();
    // The tier's frame cap: the whole scene steps at most this often, so a low-end machine runs a
    // steady thirty instead of a ragged forty; the time between still counts, in `dt`.
    if (FRAME_MS) {
      // On a schedule, not by the gap since the last frame: a 144 Hz screen still gets its sixty.
      if (now < nextFrameAt - 2) return;
      nextFrameAt = now - nextFrameAt > FRAME_MS ? now + FRAME_MS : nextFrameAt + FRAME_MS;
    }
    const elapsed = (now - last) / 1000;
    const dt = Math.min(0.05, elapsed);
    last = now;
    if (lost || host.offsetParent === null || document.visibilityState !== 'visible') return;
    clock += dt;
    governor.frame(elapsed);
    resize();
    if (shake > 0.01 && !reduce) {
      camera.position.x = (Math.random() - 0.5) * shake * 0.08;
      shake *= Math.exp(-dt * 4);
    } else if (camera.position.x !== 0) camera.position.x = 0;

    // The End's sky flashes purple now and then, and everything is lit by it for a moment.
    if (!reduce && now > nextFlash) {
      flashAt = now;
      flashPower = 0.7;
      nextFlash = now + 14000 + Math.random() * 20000;
    }
    const f = flashPower * Math.max(0, 1 - (now - flashAt) / 1600) * (0.75 + 0.25 * Math.sin((now - flashAt) / 40));
    skyMat.color.setRGB(SKY.r + f * 0.6, SKY.g + f * 0.22, SKY.b + f * 0.75);
    hemi.intensity = 1.25 + f * 1.4;
    if (!reduce) skyTex.offset.set(clock * 0.002, 0);

    // The pearls where plinko.js says they are, turned to the camera.
    pearls.count = Math.min(MAX_PEARLS, pearlList.length);
    q.copy(camera.quaternion);
    for (let i = 0; i < pearls.count; i += 1) {
      const p = pearlList[i];
      toWorld(p.x, p.y, v);
      m4.compose(v, q, one);
      pearls.setMatrixAt(i, m4);
    }
    pearls.instanceMatrix.needsUpdate = true;
    // Struck rods glow and fade.
    if (board.flashes.size) {
      for (const [index, at] of board.flashes) {
        const k = clamp01(1 - (now - at) / 380);
        lit.setRGB(1 + k * 1.6, 1 + k * 1.2, 1 + k * 1.9);
        board.pegs.setColorAt(index, lit);
        const hb = board.halos.base;
        board.halos.setColor(index, hb.r * (1 + k * 2.6), hb.g * (1 + k * 2.2), hb.b * (1 + k * 2.8));
        if (k <= 0) board.flashes.delete(index);
      }
      board.pegs.instanceColor.needsUpdate = true;
    }
    // A rod gives off its glitter now and then, as end rods do.
    if (!reduce && board.n && Math.random() < dt * 3) {
      const r = Math.floor(Math.random() * board.n);
      const j = Math.floor(Math.random() * (r + 3));
      sparkle((j - (r + 2) / 2) * G, board.y0 - (TOP + r * ROW) * G, ROD_Z, 1, 0.05, 0.1);
    }
    // The shulker boxes: a lid up and turning as a pearl goes in, then shut.
    for (const s of board.shulkers) {
      if (!s.openAt) continue;
      const t = (now - s.openAt) / 1000;
      const open = t < 0.12 ? easeOut(t / 0.12) : t < 0.32 ? 1 : t < 0.7 ? 1 - easeOut((t - 0.32) / 0.38) : 0;
      poseShulkerBox(s.model.parts, open * s.wide);
      if (t >= 0.7) s.openAt = 0;
    }
    // The crystals turn in their glass.
    for (const c of crystals) {
      const t = clock + c.phase;
      c.model.parts.outerGlass.rotation.set(Math.sin(t * 0.5) * 0.6, t * 1.2, 0.785);
      c.model.parts.innerGlass.rotation.set(0.785, t * 1.2, 0);
      c.holder.position.y += Math.sin(t * 1.5) * 0.004;
    }
    // The endermen look about, and now and then one is gone, somewhere else in a puff of purple.
    for (const e of endermen) {
      const P = e.model.parts;
      P.head.rotation.y = Math.sin(clock * 0.3 + e.look) * 0.5;
      P.head.rotation.x = 0.1 + Math.sin(clock * 0.21 + e.look) * 0.1;
      P.rightArm.rotation.x = Math.sin(clock * 0.8 + e.look) * 0.05;
      P.leftArm.rotation.x = -Math.sin(clock * 0.8 + e.look) * 0.05;
      if (!reduce && now > e.nextHop) {
        if (e.nextHop) {
          const from = e.entity.position.clone();
          portalBurst(from.x, 1.4, from.z, 40, 0.8, 1.6);
          const taken = new Set(endermen.map((o) => o.spot));
          const free = spots().map((_, i) => i).filter((i) => !taken.has(i));
          e.spot = free[Math.floor(Math.random() * free.length)];
          placeEnderman(e);
          portalBurst(e.entity.position.x, 1.4, e.entity.position.z, 40, 0.8, 1.6);
          controls.onCue?.('teleport');
        }
        e.nextHop = now + 12000 + Math.random() * 16000;
      }
    }
    // Each lit box fades back to dark.
    for (const [slot, glow] of board.boxGlows ?? []) {
      const k = clamp01(1 - (now - glow.at) / 1100);
      board.boxGlow.setColor(slot, glow.r * k, glow.g * k, glow.b * k);
      if (k <= 0) board.boxGlows.delete(slot);
    }
    // A thin wake of portal particles behind every falling pearl.
    if (!reduce && pearlList.length) {
      for (const p of pearlList) {
        if (Math.random() > dt * 14) continue;
        toWorld(p.x, p.y, v);
        portal.emit({ x: v.x + (Math.random() - 0.5) * 0.1, y: v.y + 0.05, z: v.z - 0.05, vx: (Math.random() - 0.5) * 0.2, vy: 0.25, vz: 0, drag: 1, life: 0.6, size: 0.06, sizeTo: 0.02, frame: Math.floor(Math.random() * 8), r: 1.1, g: 0.45, b: 1.4, fade: 0.5 });
      }
    }
    for (const s of sprites) s.step(dt);
    if (composer) composer.render(dt);
    else renderer.render(scene, camera);
  }

  const controls = {
    onLost: null,
    /** Called with { left, width, host } in CSS pixels: where the row of shulker boxes stands. */
    onLayout: null,
    /** 'teleport', 'land' (with the multiplier). */
    onCue: null,
    tier: tier.name,

    /** The board for `rows` rows: its pegs and its row of shulker boxes. */
    setBoard(rows) {
      if (rows !== board.n) buildBoard(rows);
      else layout(true);
    },
    /** Every falling pearl, in board units, as plinko.js places it this frame. */
    balls(list) {
      pearlList = list;
    },
    /** A pearl struck the peg `key` ("row:index"). */
    strike(key) {
      const index = board.pegIndex.get(key);
      if (index === undefined) return;
      board.flashes.set(index, performance.now());
      if (!reduce && Math.random() < 0.5) {
        const [r, j] = key.split(':').map(Number);
        sparkle((j - (r + 2) / 2) * G, board.y0 - (TOP + r * ROW) * G, ROD_Z, 1);
      }
    },
    /** A pearl went into `slot`'s box, paying `bps`. */
    land(slot, bps) {
      const s = board.shulkers[slot];
      if (!s) return;
      const x = bps / 10_000;
      s.openAt = performance.now();
      // The box lights up: warm and bright for a win, a dim purple for a loss.
      const bright = x >= 10 ? 1.6 : x >= 1 ? 1 : 0.45;
      const tint = x >= 1 ? [1, 0.82, 0.55] : [0.7, 0.55, 0.9];
      (board.boxGlows ??= new Map()).set(slot, { at: performance.now(), r: tint[0] * bright, g: tint[1] * bright, b: tint[2] * bright });
      // The lid lifts as high as the game's opening for a win, a crack for a loss.
      s.wide = x >= 1 ? 1 : 0.45;
      portalBurst(s.x, SLOT + 0.1, SLOT / 2, x >= 10 ? 60 : x >= 1 ? 24 : 10, 0.3, x >= 10 ? 2.4 : 1.1);
      if (x >= 10) {
        sparkle(s.x, SLOT + 0.2, SLOT / 2, 40, 0.4, 3);
        flashAt = performance.now();
        flashPower = x >= 100 ? 1.3 : 0.6;
        shake = x >= 100 ? 1 : 0.4;
      }
    },
    dispose() {
      cancelAnimationFrame(raf);
      canvas.removeEventListener('webglcontextlost', onLost);
      composer?.dispose();
      renderer.dispose();
      canvas.remove();
    },
  };

  resize();
  // Compiled now, the board's materials included, so the first pearl costs no frame.
  buildBoard(12);
  try { renderer.compile(scene, camera); } catch { /* compiled on first use */ }
  raf = requestAnimationFrame(frame);
  return controls;
}
