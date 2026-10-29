/* tower3d.js — Tower in 3D: the Tower of Worlds. Nine storeys, and every one a different place in
 * the game, stranger the higher it goes, as the multiplier climbs: a ruin of mossy stone brick, a
 * cobblestone dungeon round its spawner, a library of bookshelves, an amethyst geode, an ocean
 * monument of prismarine and sea lanterns, a nether fortress, a bastion of blackstone and gold, an end
 * city of purpur and end rods, and at the top the End itself, obsidian and end stone and the dragon's
 * egg. A beacon on the roof.
 *
 * Outside, the day goes as the tower does: blue sky at the foot, the cloud layer halfway up (Steve
 * climbs through it), sunset above the clouds, and night and stars at the top.
 *
 * On every storey a row of chests (ender chests in the End); in each, that storey's loot -- an
 * emerald, a gold ingot, an enchanted book, an amethyst shard, a heart of the sea, a blaze rod, a
 * netherite ingot, an eye of ender, the nether star -- or a creeper, which climbs out, hisses, flashes
 * and swells as CreeperRenderer draws it, and goes off.
 *
 * Every block, item, particle and model is the game's own, out of the client jar. What is drawn
 * rather than taken is light: halos round torches, lanterns and the rest, the beacon's beam, the
 * flash of the blast, the colour of the sky.
 *
 * Nothing here decides anything. tower.js starts the climb, sends each chest the player picks and
 * says what was in it. Steve climbs the ladder to every storey he clears, and the camera climbs with
 * him. If WebGL is missing or the context is lost, tower.js shows the flat tower.
 *
 * Low-end machines get less (quality3d.js): no glow, no shadows, fewer particles, a steady thirty
 * frames a second; a machine that cannot keep up steps down on its own.
 */
import { reduceMotion } from './util.js';
import { buildChest, getTHREE, loadImage, softDot } from './mc3d.js';
import { CREEPER, PLAYER, atlas, buildModel, itemModel, makeSprites, pixelTexture, placeEntity } from './mcmodels.js';
import { blobShadow, dragonEgg, fancyClouds, glowPoints, gradePass, oakTrees, regionUV, shadowMaterial, skyDome } from './scenery3d.js';
import { BRIGHTNESS, chooseTier, createGovernor, frameMs, minFpsFor, ratioFor } from './quality3d.js';
import { drawText, fontFromImage, textWidth } from './mcfont.js';

export const FLOORS = 9;
const STOREY = 3;             // blocks from one floor to the next
const HALF = 4;               // the inside runs x -HALF .. HALF
const BACK = -3;              // the inside runs z BACK .. FRONT; the back wall is the row behind it
const FRONT = 1;
const CHEST_Z = -1.15;
const SPACING = 1.55;
const STAND = { x: -3.35, z: -0.35 };    // where Steve waits on a storey
const LADDER = { x: -3.62, z: -2.5 };    // and where he climbs
const PLAYER_PIXEL = 0.9375 / 16;
const OPEN = -1.45;                      // a chest's lid, open: a right angle, as in the game
const HISS_MS = 1400;                    // a creeper out of its chest to the blast
const OUT_MS = 520;                      // ... of which climbing out and hopping down in front of it
const PLAINS_GRASS = 0x91bd59;
const OAK_LEAVES = 0x77ab2f;
const CLOUD_Y = 14.6;                    // the cloud layer, between the fifth storey and the sixth

/**
 * The storeys, from the foot. `walls` are the blocks the walls are laid from (the first the most of
 * them), `corner` the front corners, `floor` its floor, `light` the colour of its own lamp, `loot`
 * what a safe chest holds and `shine` the glow round it, `ender` an ender chest instead of a chest.
 */
export const STOREYS = [
  { name: 'ruin', walls: ['stone_bricks', 'mossy_stone_bricks', 'cracked_stone_bricks'], corner: 'chiseled_stone_bricks', floor: 'stone_bricks', light: 0xffc888, loot: 'emerald', shine: 'rgba(120,255,160,1)' },
  { name: 'dungeon', walls: ['cobblestone', 'mossy_cobblestone'], corner: 'mossy_cobblestone', floor: 'mossy_cobblestone', light: 0xffb070, loot: 'gold_ingot', shine: 'rgba(255,220,90,1)' },
  { name: 'library', walls: ['oak_planks', 'bookshelf'], corner: 'oak_log', floor: 'oak_planks', light: 0xffd49a, loot: 'enchanted_book', shine: 'rgba(210,140,255,1)' },
  { name: 'geode', walls: ['amethyst_block', 'budding_amethyst', 'calcite'], corner: 'smooth_basalt', floor: 'calcite', light: 0xc890ff, loot: 'amethyst_shard', shine: 'rgba(200,140,255,1)' },
  { name: 'monument', walls: ['prismarine', 'prismarine_bricks'], corner: 'dark_prismarine', floor: 'dark_prismarine', light: 0x9fffe8, loot: 'heart_of_the_sea', shine: 'rgba(110,220,255,1)' },
  { name: 'fortress', walls: ['nether_bricks', 'red_nether_bricks'], corner: 'nether_bricks', floor: 'nether_bricks', light: 0xff7a30, loot: 'blaze_rod', shine: 'rgba(255,170,60,1)' },
  { name: 'bastion', walls: ['polished_blackstone_bricks', 'blackstone', 'gilded_blackstone'], corner: 'gold_block', floor: 'blackstone', light: 0xffa040, loot: 'netherite_ingot', shine: 'rgba(255,200,120,1)' },
  { name: 'city', walls: ['purpur_block'], corner: 'purpur_pillar_side', floor: 'purpur_block', light: 0xf2d8ff, loot: 'ender_eye', shine: 'rgba(120,255,200,1)', ender: true },
  { name: 'end', walls: ['end_stone_bricks', 'obsidian', 'crying_obsidian'], corner: 'obsidian', floor: 'end_stone_bricks', light: 0xd8c0ff, loot: 'nether_star', shine: 'rgba(255,255,255,1)', ender: true },
];
/* The sky outside, by how far up the camera is (0 the foot, 1 the roof): [at, top, horizon]. */
const SKY = [
  [0, 0x3f7cf0, 0xbcd6ff],
  [0.42, 0x2f6ae8, 0xd8e8ff],
  [0.62, 0x4a4aa0, 0xffb070],
  [0.8, 0x1c1850, 0x7a3a6a],
  [1, 0x05051a, 0x221338],
];

const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
const easeOut = (t) => 1 - (1 - t) ** 3;
const smooth = (a, b, t) => { const x = clamp01((t - a) / (b - a)); return x * x * (3 - 2 * x); };
const lerp = (a, b, t) => a + (b - a) * t;
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
/** Where chest `tile` of `count` stands across a storey. */
export const chestX = (tile, count) => (tile - (count - 1) / 2) * SPACING;
const floorY = (floor) => floor * STOREY;

/**
 * Builds the tower into `host` and resolves with its controls, or null when this browser cannot
 * draw it.
 */
export async function createTower3d(host) {
  const THREE = await getTHREE();
  const probe = document.createElement('canvas');
  const probeGl = probe.getContext('webgl2');
  if (!probeGl) return null;
  const tier = chooseTier(probeGl);
  probeGl.getExtension('WEBGL_lose_context')?.loseContext();
  const canvas = document.createElement('canvas');
  canvas.className = 'tower__gl';
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
  renderer.toneMappingExposure = 1.05 * BRIGHTNESS;
  const scale = (n) => Math.max(1, Math.round(n * tier.particles));
  const FRAME_MS = frameMs(tier);
  let nextFrameAt = 0;

  /* ── what is loaded ── */
  const BLOCKS = [...new Set([
    ...STOREYS.flatMap((s) => [...s.walls, s.corner, s.floor]),
    'stone_bricks', 'mossy_stone_bricks', 'cracked_stone_bricks', 'chiseled_stone_bricks', 'ladder', 'torch', 'oak_log', 'oak_log_top',
    'oak_leaves', 'grass_block_top', 'oak_sign', 'gold_block', 'glass', 'beacon', 'obsidian', 'vine', 'spawner', 'cobweb', 'lantern',
    'amethyst_cluster', 'sea_lantern', 'magma', 'end_rod', 'dragon_egg', 'purpur_pillar_top', 'soul_lantern',
  ])];
  const LOOT = STOREYS.map((s) => s.loot);
  const ENTITY = ['steve', 'creeper', 'experience_orb'];
  const PARTICLE = ['glint', 'flame', 'soul_fire_flame', ...Array.from({ length: 16 }, (_, i) => `explosion_${i}`),
    ...Array.from({ length: 8 }, (_, i) => `generic_${i}`), ...Array.from({ length: 8 }, (_, i) => `spark_${i}`)];
  let loaded;
  try {
    loaded = await Promise.all([
      Promise.all(BLOCKS.map((name) => loadImage(`assets/img/block/${name}.png`))),
      Promise.all(LOOT.map((name) => loadImage(`assets/img/items/${name}.png`))),
      Promise.all(ENTITY.map((name) => loadImage(`assets/img/entity/${name}.png`))),
      Promise.all(PARTICLE.map((name) => loadImage(`assets/img/particle/${name}.png`))),
      loadImage('assets/img/gui/ascii.png'),
      loadImage('assets/img/misc/shadow.png'),
      loadImage('assets/img/env/clouds.png'),
      loadImage('assets/img/env/sun.png'),
      buildChest('assets/img/block/chest_normal.png', 1),
      buildChest('assets/img/block/chest_ender.png', 1),
      tier.composer
        ? import(/* @vite-ignore */ new URL('assets/vendor/three-addons.js', document.baseURI).href).catch(() => null)
        : Promise.resolve(null),
    ]);
  } catch {
    renderer.dispose();
    return null;
  }
  const [blockImgs, lootImgs, entityImgs, particleImgs, fontImg, shadowImg, cloudImg, sunImg, chestProto, enderProto, addons] = loaded;
  const img = Object.fromEntries(BLOCKS.map((name, i) => [name, blockImgs[i]]));
  const ent = Object.fromEntries(ENTITY.map((name, i) => [name, entityImgs[i]]));
  const part = Object.fromEntries(PARTICLE.map((name, i) => [name, particleImgs[i]]));
  const font = fontFromImage(fontImg);
  host.prepend(canvas);

  const reduce = reduceMotion();
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x78a7ff);
  scene.fog = new THREE.Fog(0xb9d3ff, 45, 170);
  const camera = new THREE.PerspectiveCamera(44, 1, 0.1, 500);
  scene.add(camera);

  let composer = null;
  let bloom = null;
  if (addons) {
    try {
      const target = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: tier.samples });
      composer = new addons.EffectComposer(renderer, target);
      composer.addPass(new addons.RenderPass(scene, camera));
      bloom = new addons.UnrealBloomPass(new THREE.Vector2(4, 4), 0.45, 0.45, 0.9);
      composer.addPass(bloom);
      composer.addPass(new addons.OutputPass());
      composer.addPass(gradePass(THREE, addons, { contrast: 1.06, saturation: 1.14, lift: [0.012, 0.012, 0.03], gain: [1.03, 1.01, 0.97], vignette: 0.24 }));
    } catch {
      composer = null;
      bloom = null;
    }
  }
  /** The first frame of a block texture: animated ones (sea lantern, magma, lanterns) are strips. */
  const still = (name) => {
    const image = img[name];
    if (image.height <= image.width) return image;
    const c = document.createElement('canvas');
    c.width = c.height = image.width;
    c.getContext('2d').drawImage(image, 0, 0);
    return c;
  };
  const tex = (name, rx = 1, ry = rx) => {
    const t = pixelTexture(THREE, still(name));
    if (rx !== 1 || ry !== 1) {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(rx, ry);
    }
    return t;
  };
  const lambert = (map, opts = {}) => new THREE.MeshLambertMaterial({ map, ...opts });
  const box = new THREE.BoxGeometry(1, 1, 1);
  const m4 = new THREE.Matrix4();

  /* ── light: the sun outside, and a lamp on the storey being climbed in that storey's colour ── */
  const hemi = new THREE.HemisphereLight(0xd8e6ff, 0x5a6a48, 1.0);
  scene.add(hemi);
  const sunLight = new THREE.DirectionalLight(0xfff0d8, 1.7);
  scene.add(sunLight, sunLight.target);
  const inner = new THREE.PointLight(0xffc888, tier.name === 'low' ? 6 : 5, 10, 1.3);
  scene.add(inner);
  const shadows = tier.name !== 'low';
  if (shadows) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.set(tier.name === 'high' ? 2048 : 1024, tier.name === 'high' ? 2048 : 1024);
    Object.assign(sunLight.shadow.camera, { left: -10, right: 10, top: 10, bottom: -10, near: 1, far: 80 });
    sunLight.shadow.bias = -0.0006;
    sunLight.shadow.normalBias = 0.03;
  }
  const flashLight = new THREE.PointLight(0xffc27a, 0, 16, 1.2);
  scene.add(flashLight);

  /* ── the sky: the day going as the tower goes, the clouds halfway up, stars at the top ── */
  const sky = skyDome(THREE);
  scene.add(sky);
  const sun = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: pixelTexture(THREE, sunImg), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false, color: new THREE.Color(1.5, 1.4, 1.2) }));
  sun.renderOrder = -9;
  scene.add(sun);
  const SUN_HIGH = new THREE.Vector3(-16, 26, 20).normalize();
  const SUN_LOW = new THREE.Vector3(-30, 2.5, 22).normalize();
  const sunDir = new THREE.Vector3();
  const clouds = fancyClouds(THREE, cloudImg, { y: CLOUD_Y, radius: tier.name === 'low' ? 170 : 240, clear: 24 });
  scene.add(clouds.group);
  const stars = (() => {
    const rand = seeded(9);
    const n = tier.name === 'low' ? 300 : 700;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i += 1) {
      const u = 0.05 + rand() * 0.95;
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      pos.set([Math.cos(a) * r * 300, u * 300, Math.sin(a) * r * 300], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const points = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false, fog: false, toneMapped: false }));
    points.renderOrder = -8;
    return points;
  })();
  scene.add(stars);
  const skyTop = new THREE.Color();
  const skyLow = new THREE.Color();
  const ca = new THREE.Color();
  const cb = new THREE.Color();
  function skyAt(t) {
    let i = 0;
    while (i < SKY.length - 2 && t > SKY[i + 1][0]) i += 1;
    const [a0, top0, low0] = SKY[i];
    const [a1, top1, low1] = SKY[i + 1];
    const k = smooth(0, 1, (t - a0) / (a1 - a0));
    skyTop.copy(ca.setHex(top0)).lerp(cb.setHex(top1), k);
    skyLow.copy(ca.setHex(low0)).lerp(cb.setHex(low1), k);
  }
  const shadowMat = shadowMaterial(THREE, shadowImg);

  /* ── the meadow and its oaks ── */
  {
    const grass = new THREE.Mesh(new THREE.PlaneGeometry(320, 320).rotateX(-Math.PI / 2), lambert(tex('grass_block_top', 320, 320), { color: PLAINS_GRASS }));
    grass.position.y = -0.02;
    grass.receiveShadow = true;
    scene.add(grass);
    scene.add(oakTrees(THREE, { bark: lambert(tex('oak_log')), ring: lambert(tex('oak_log_top')), leaves: lambert(tex('oak_leaves'), { color: OAK_LEAVES, alphaTest: 0.5 }) },
      [[-10, -6, 5], [11, -9, 6], [-15, -15, 5], [16, -2, 5], [-20, 3, 6], [6, -18, 5], [22, -14, 6], [-7, -22, 5]]));
  }

  /* ── the tower: every storey laid from its own blocks ── */
  const rand = seeded(41);
  const cells = new Map();   // block name -> [x, y, z] centres
  const put = (name, x, y, z) => {
    if (!cells.has(name)) cells.set(name, []);
    cells.get(name).push([x + 0.5, y + 0.5, z + 0.5]);
  };
  /** One wall block of storey `f`: the theme's own mix, with the ruin mossy low down. */
  const wallBlock = (f, y, side) => {
    const s = STOREYS[f];
    const r = rand();
    if (s.name === 'ruin') return r < Math.max(0.06, 0.34 - y * 0.03) ? 'mossy_stone_bricks' : r > 0.9 ? 'cracked_stone_bricks' : 'stone_bricks';
    if (s.name === 'library') return side && y < floorY(f) + 2 ? 'bookshelf' : y === floorY(f) + 2 ? 'oak_planks' : r < 0.6 ? 'bookshelf' : 'oak_planks';
    if (s.walls.length === 1 || r < 0.62) return s.walls[0];
    return s.walls[1 + Math.floor(rand() * (s.walls.length - 1))];
  };
  const ROOF = floorY(FLOORS);
  for (let f = 0; f <= FLOORS; f += 1) {
    const y0 = floorY(f);
    const s = STOREYS[Math.min(f, FLOORS - 1)];
    // The floor (the roof, over the top storey): one block thick, a shaft left open for the ladder.
    for (let x = -HALF - 1; x < HALF + 1; x += 1) {
      for (let z = BACK - 1; z < FRONT; z += 1) {
        if (f > 0 && x === -HALF && z === BACK) continue;
        const corner = (x === -HALF - 1 || x === HALF) && z === FRONT - 1;
        put(f === FLOORS ? 'obsidian' : corner ? s.corner : s.floor, x, y0 - 1, z);
      }
    }
    if (f === FLOORS) break;
    for (let y = y0; y < y0 + STOREY; y += 1) {
      for (let x = -HALF - 1; x < HALF + 1; x += 1) {
        // The back wall, with a window in the middle of each storey.
        if (!(y === y0 + 1 && x >= -1 && x <= 0)) put(wallBlock(f, y, false), x, y, BACK - 1);
      }
      for (const x of [-HALF - 1, HALF]) {
        for (let z = BACK; z < FRONT; z += 1) {
          // The side walls, with an arrow slit in each; the front corners in the theme's corner block.
          if (y === y0 + 1 && z === BACK + 2) continue;
          put(z === FRONT - 1 ? s.corner : wallBlock(f, y, true), x, y, z);
        }
      }
    }
  }
  // The roof's battlements.
  for (let x = -HALF - 1; x < HALF + 1; x += 1) {
    for (let z = BACK - 1; z < FRONT; z += 1) {
      const edge = x === -HALF - 1 || x === HALF || z === BACK - 1 || z === FRONT - 1;
      if (edge && (x + z) % 2 === 0) put('end_stone_bricks', x, ROOF, z);
    }
  }
  const sided = (side, end) => [lambert(tex(side)), lambert(tex(side)), lambert(tex(end)), lambert(tex(end)), lambert(tex(side)), lambert(tex(side))];
  const blockMat = (name) => {
    if (name === 'oak_log') return sided('oak_log', 'oak_log_top');
    if (name === 'purpur_pillar_side') return sided(name, 'purpur_pillar_top');
    if (name === 'bookshelf') return sided(name, 'oak_planks');
    if (name === 'crying_obsidian') return lambert(tex(name), { emissive: 0x2a0a4a });
    if (name === 'amethyst_block' || name === 'budding_amethyst') return lambert(tex(name), { emissive: 0x1a0a2a });
    if (name === 'gilded_blackstone' || name === 'gold_block') return lambert(tex(name), { emissive: 0x1a1000 });
    return lambert(tex(name));
  };
  for (const [name, list] of cells) {
    const mesh = new THREE.InstancedMesh(box, blockMat(name), list.length);
    list.forEach(([x, y, z], i) => mesh.setMatrixAt(i, m4.makeTranslation(x, y, z)));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
  }
  // The ladder: the block model's one plane, a sixteenth off the wall, all the way up.
  {
    const t = tex('ladder', 1, STOREY * FLOORS);
    const ladder = new THREE.Mesh(new THREE.PlaneGeometry(1, STOREY * FLOORS), lambert(t, { alphaTest: 0.5, side: THREE.DoubleSide }));
    ladder.rotation.y = Math.PI / 2;
    ladder.position.set(-HALF + 0.07, (STOREY * FLOORS) / 2, BACK + 0.5);
    ladder.receiveShadow = true;
    scene.add(ladder);
  }
  // Vines down the front corners of the ruin and the dungeon.
  {
    const vineMat = lambert(tex('vine', 1, 4), { color: OAK_LEAVES, alphaTest: 0.5, side: THREE.DoubleSide });
    for (const [x, y] of [[-HALF - 1.01, 2], [HALF + 1.01, 4.5]]) {
      const vine = new THREE.Mesh(new THREE.PlaneGeometry(1, 4), vineMat);
      vine.rotation.y = Math.PI / 2;
      vine.position.set(x, y, FRONT - 0.5);
      scene.add(vine);
    }
  }

  /* ── what furnishes each storey, and the lights it gives ── */
  const lights = [];        // [x, y, z, colour] for the halos
  const flames = [];        // where flame rises: { x, y, z, soul, inside }
  {
    const cross = (map, size, opts = {}) => {
      const material = lambert(map, { alphaTest: 0.5, side: THREE.DoubleSide, ...opts });
      const g = new THREE.Group();
      for (const a of [Math.PI / 4, -Math.PI / 4]) {
        const plane = new THREE.Mesh(new THREE.PlaneGeometry(size, size), material);
        plane.rotation.y = a;
        plane.position.y = size / 2;
        g.add(plane);
      }
      return g;
    };
    const torchGeo = regionUV(new THREE.BoxGeometry(2 / 16, 10 / 16, 2 / 16), [[7, 6, 9, 16], [7, 6, 9, 16], [7, 6, 9, 8], [7, 14, 9, 16], [7, 6, 9, 16], [7, 6, 9, 16]]);
    const torchMat = lambert(tex('torch'), { emissive: 0x6a4a1a });
    const wallTorch = (x, y, z) => {
      const t = new THREE.Mesh(torchGeo, torchMat);
      t.rotation.x = 0.39;
      t.position.set(x, y, z + 0.2);
      scene.add(t);
      lights.push([x, y + 0.32, z + 0.33, 0xffb060]);
      flames.push({ x, y: y + 0.36, z: z + 0.33 });
    };
    const block = (name, x, y, z, opts) => {
      const b = new THREE.Mesh(box, opts ? lambert(tex(name), opts) : blockMat(name));
      b.position.set(x, y + 0.5, z);
      b.castShadow = true;
      scene.add(b);
      return b;
    };
    // The lantern block model's body, from the first frame of the lantern's strip.
    const lanternGeo = regionUV(new THREE.BoxGeometry(6 / 16, 7 / 16, 6 / 16), [[0, 2, 6, 9], [0, 2, 6, 9], [0, 9, 6, 15], [0, 9, 6, 15], [0, 2, 6, 9], [0, 2, 6, 9]]);
    const lantern = (name, x, y, z, colour) => {
      const l = new THREE.Mesh(lanternGeo, lambert(tex(name), { alphaTest: 0.5, emissive: 0x5a3a10 }));
      l.position.set(x, y + 3.5 / 16, z);
      scene.add(l);
      lights.push([x, y + 0.25, z, colour]);
    };
    const rodGeo = (() => {
      const base = regionUV(new THREE.BoxGeometry(4 / 16, 1 / 16, 4 / 16), [[2, 6, 6, 7], [2, 6, 6, 7], [2, 2, 6, 6], [6, 6, 2, 2], [2, 6, 6, 7], [2, 6, 6, 7]]);
      base.translate(0, 0.5 / 16, 0);
      const stick = regionUV(new THREE.BoxGeometry(2 / 16, 15 / 16, 2 / 16), [[0, 0, 2, 15], [0, 0, 2, 15], [2, 0, 4, 2], [2, 0, 4, 2], [0, 0, 2, 15], [0, 0, 2, 15]]);
      stick.translate(0, 1 / 16 + 7.5 / 16, 0);
      return [base, stick];
    })();
    const rodMat = new THREE.MeshBasicMaterial({ map: tex('end_rod'), color: new THREE.Color(1.2, 1.18, 1.15), toneMapped: false });
    const endRod = (x, y, z) => {
      for (const g of rodGeo) {
        const r = new THREE.Mesh(g, rodMat);
        r.position.set(x, y, z);
        scene.add(r);
      }
      lights.push([x, y + 0.6, z, 0xfff0e0]);
    };
    for (let f = 0; f < FLOORS; f += 1) {
      const y0 = floorY(f);
      const name = STOREYS[f].name;
      if (name === 'ruin') {
        wallTorch(2.6, y0 + 1.5, BACK + 0.02);
        wallTorch(-2.1, y0 + 1.5, BACK + 0.02);
      } else if (name === 'dungeon') {
        // The spawner in its corner, flames turning inside the cage, and cobwebs in the dark.
        block('spawner', 3.4, y0, -2.4, { alphaTest: 0.5, side: THREE.DoubleSide });
        flames.push({ x: 3.4, y: y0 + 0.5, z: -2.4, inside: true });
        lights.push([3.4, y0 + 0.5, -2.4, 0xff9a40]);
        const web = cross(tex('cobweb'), 1);
        web.position.set(3.5, y0 + 2, -2.5);
        scene.add(web);
        wallTorch(-2.1, y0 + 1.5, BACK + 0.02);
      } else if (name === 'library') {
        lantern('lantern', 3.4, y0, -2.5, 0xffc070);
        lantern('lantern', 2.2, y0, -2.6, 0xffc070);
      } else if (name === 'geode') {
        for (const [x, z] of [[3.4, -2.5], [2.5, -2.7], [-2.3, -2.7], [3.6, 0.3], [-1.7, 0.4]]) {
          const c = cross(tex('amethyst_cluster'), 0.9, { emissive: 0x3a1a5a });
          c.position.set(x, y0, z);
          scene.add(c);
          lights.push([x, y0 + 0.45, z, 0xc890ff]);
        }
      } else if (name === 'monument') {
        for (const [x, z] of [[3.5, -2.5], [-2.4, -2.5]]) {
          block('sea_lantern', x, y0, z, { emissive: 0x6aa8a0 });
          lights.push([x, y0 + 0.5, z + 0.4, 0xbffff0]);
        }
      } else if (name === 'fortress') {
        for (const [x, z] of [[3.5, -2.5], [-2.4, -2.5]]) {
          block('magma', x, y0, z, { emissive: 0x8a2a00 });
          flames.push({ x, y: y0 + 1.05, z });
          lights.push([x, y0 + 1.1, z, 0xff8030]);
        }
      } else if (name === 'bastion') {
        for (const [x, y, z] of [[3.5, 0, -2.5], [3.5, 1, -2.5], [2.5, 0, -2.5], [3.5, 0, -1.5]]) block('gold_block', x, y0 + y, z);
        lantern('soul_lantern', -2.3, y0, -2.6, 0x7af0ff);
        flames.push({ x: -2.3, y: y0 + 0.5, z: -2.6, soul: true });
      } else if (name === 'city') {
        endRod(3.6, y0, -2.6);
        endRod(-2.3, y0, -2.7);
        endRod(3.6, y0 + 1, -2.6);
      } else if (name === 'end') {
        block('obsidian', 3.4, y0, -2.4);
        const egg = dragonEgg(THREE, img.dragon_egg);
        egg.position.set(3.4, y0 + 1, -2.4);
        scene.add(egg);
        lights.push([3.4, y0 + 1.5, -2.4, 0xc070ff]);
        endRod(-2.3, y0, -2.7);
      }
    }
  }
  // The beacon on the roof, on a step of gold, and its beam.
  {
    const steps = new THREE.InstancedMesh(box, lambert(tex('gold_block')), 9);
    let i = 0;
    for (let x = -1; x <= 1; x += 1) for (let z = -1; z <= 1; z += 1) steps.setMatrixAt(i++, m4.makeTranslation(x + 0.5, ROOF + 0.5, z - 1.5));
    steps.castShadow = true;
    steps.receiveShadow = true;
    scene.add(steps);
    const beacon = new THREE.Group();
    const glass = new THREE.Mesh(box, lambert(tex('glass'), { transparent: true, depthWrite: false }));
    const core = new THREE.Mesh(new THREE.BoxGeometry(10 / 16, 10 / 16, 10 / 16), lambert(tex('beacon'), { emissive: 0x3a7a7a }));
    core.position.y = 1 / 16;
    const base = new THREE.Mesh(new THREE.BoxGeometry(14 / 16, 3 / 16, 14 / 16), lambert(tex('obsidian')));
    base.position.y = -6.5 / 16;
    beacon.add(base, core, glass);
    beacon.position.set(0.5, ROOF + 1.5, -1);
    scene.add(beacon);
  }
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 200, 12, 1, true), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.7, 1.4, 1.5), transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, fog: false }));
  beam.position.set(0.5, ROOF + 2 + 100, -1);
  scene.add(beam);

  /* ── an oak sign on the front of every storey's ceiling, what clearing it pays in the game's font ── */
  const signs = [];
  {
    const cut = (x, y, w, h) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      c.getContext('2d').drawImage(img.oak_sign, x, y, w, h, 0, 0, w, h);
      return c;
    };
    const wood = lambert(pixelTexture(THREE, cut(0, 17, 24, 12)));
    for (let f = 0; f < FLOORS; f += 1) {
      const face = document.createElement('canvas');
      face.width = 96;
      face.height = 48;
      const texture = pixelTexture(THREE, face);
      const front = new THREE.MeshLambertMaterial({ map: texture });
      const board = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.75, 2 / 16), [wood, wood, wood, wood, front, wood]);
      board.position.set(0, floorY(f + 1) - 0.5, FRONT + 0.07);
      board.castShadow = true;
      scene.add(board);
      signs.push({ face, texture, front, text: '' });
    }
  }
  const signBack = (() => {
    const c = document.createElement('canvas');
    c.width = 24;
    c.height = 12;
    c.getContext('2d').drawImage(img.oak_sign, 0, 1, 24, 12, 0, 0, 24, 12);
    return c;
  })();
  function writeSign(floor, text, tone) {
    const s = signs[floor];
    const key = `${text}|${tone}`;
    if (s.text === key) return;
    s.text = key;
    const g = s.face.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(signBack, 0, 0, 96, 48);
    const px = 2;
    const w = textWidth(font, text) * px;
    drawText(g, font, text, Math.round((96 - w) / 2), 16, px, tone === 'done' ? '#7a5a2a' : '#000000', false);
    s.texture.needsUpdate = true;
    s.front.color.setHex(tone === 'now' ? 0xffffff : tone === 'done' ? 0x9a9a9a : 0xe0e0e0);
    s.front.emissive.setHex(tone === 'now' ? 0x3a3018 : 0x000000);
  }

  /* ── the chests: four to a storey, as many shown as the mode has; the loot, or a creeper ── */
  const loot = lootImgs.map((image) => itemModel(THREE, image));
  const creeperMat = new THREE.MeshLambertMaterial({ map: pixelTexture(THREE, ent.creeper), alphaTest: 0.5 });
  // A creeper's head alone, peeking out of a chest when the climb is over and the chests are shown.
  const HEAD = { texW: 64, texH: 32, parts: [CREEPER.parts[0]] };
  const chests = [];
  const pickables = [];
  for (let f = 0; f < FLOORS; f += 1) {
    const s = STOREYS[f];
    const glowTex = softDot(s.shine);
    for (let tile = 0; tile < 4; tile += 1) {
      const group = (s.ender ? enderProto : chestProto).group.clone();
      const hinge = group.children[1];
      group.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = true;
        o.receiveShadow = true;
        o.userData.chest = f * 4 + tile;
        pickables.push(o);
      });
      scene.add(group);
      const gem = new THREE.Group();
      const gemMesh = new THREE.Mesh(loot[f].geometry, loot[f].material);
      gemMesh.scale.setScalar(0.5);
      gem.add(gemMesh);
      gem.visible = false;
      scene.add(gem);
      const head = placeEntity(THREE, buildModel(THREE, [{ material: creeperMat, def: HEAD }]), 0.55 / 16);
      head.visible = false;
      scene.add(head);
      const glow = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 0.95), new THREE.MeshBasicMaterial({ map: glowTex, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
      scene.add(glow);
      chests.push({ floor: f, tile, group, hinge, gem, head, glow, state: 'closed', busy: false, lid: 0, lidGoal: 0, gemAt: 0, x: 0, y: floorY(f), z: CHEST_Z, phase: rand() * 6 });
    }
  }
  const outline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(0.98, 0.95, 0.98)), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 }));
  outline.visible = false;
  scene.add(outline);
  // The one creeper that climbs out of a chest, hisses and goes off.
  const creeperModel = buildModel(THREE, [{ material: creeperMat, def: CREEPER }]);
  const creeper = placeEntity(THREE, creeperModel, 1 / 16);
  creeper.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  creeper.visible = false;
  scene.add(creeper);
  const hiss = { chest: null, at: 0 };
  const CREEPER_SCALE = 0.8;

  /* ── Steve ── */
  const steveMat = new THREE.MeshLambertMaterial({ map: pixelTexture(THREE, ent.steve), alphaTest: 0.5, side: THREE.DoubleSide });
  const player = buildModel(THREE, [{ material: steveMat, def: PLAYER }]);
  const steve = placeEntity(THREE, player, PLAYER_PIXEL);
  const P = player.parts;
  steve.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  scene.add(steve);
  const steveShadow = blobShadow(THREE, shadowMat, 0.42);
  scene.add(steveShadow);
  // Where he is and where he is going: a storey (FLOORS is the roof), and the leg of the climb he is on.
  const climber = { floor: 0, goal: 0, x: STAND.x, y: 0, z: STAND.z, leg: 'stand', yaw: Math.PI / 2, walk: 0, look: null, hurtUntil: 0, cheerUntil: 0, hopStart: 0, hopUntil: 0 };

  /* ── particles ── */
  const sprites = [];
  const sprite = (map, opts) => {
    const s = makeSprites(THREE, { map, ...opts });
    scene.add(s.points);
    sprites.push(s);
    return s;
  };
  const chips = sprite(pixelTexture(THREE, img.stone_bricks), { cols: 4, rows: 4, count: scale(220) });
  const woodChips = sprite(pixelTexture(THREE, chestProto.atlas), { cols: 8, rows: 8, count: scale(80) });
  const sparkles = sprite(pixelTexture(THREE, part.glint), { count: scale(160) });
  const blasts = sprite(atlas(THREE, Array.from({ length: 16 }, (_, i) => part[`explosion_${i}`]), 32, 4).map, { cols: 4, rows: 4, count: scale(90) });
  const smoke = sprite(atlas(THREE, Array.from({ length: 8 }, (_, i) => part[`generic_${i}`]), 8, 8).map, { cols: 8, rows: 1, count: scale(120) });
  const fire = sprite(pixelTexture(THREE, part.flame), { count: scale(90), additive: true });
  const soulFire = sprite(pixelTexture(THREE, part.soul_fire_flame), { count: scale(30), additive: true });
  const sparks = sprite(atlas(THREE, Array.from({ length: 8 }, (_, i) => part[`spark_${i}`]), 8, 8).map, { cols: 8, rows: 1, count: scale(500), additive: true });
  const orbs = sprite(pixelTexture(THREE, ent.experience_orb), { cols: 4, rows: 4, count: scale(100), additive: true });
  const halos = glowPoints(THREE, lights.map(([x, y, z]) => [x, y, z]), { size: 1.3, color: 0xffffff, opacity: 0.5 });
  lights.forEach(([, , , colour], i) => {
    const c = new THREE.Color(colour);
    halos.setColor(i, c.r, c.g, c.b);
  });
  scene.add(halos.points);
  const blastGlow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: softDot('rgba(255,190,110,1)'), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
  blastGlow.visible = false;
  scene.add(blastGlow);
  let blastAt = 0;
  const blastsDue = [];
  const fireworksDue = [];
  function chip(set, x, y, z, n, spread = 0.9, up = 2.2, frames = 16) {
    if (reduce) return;
    for (let i = 0; i < scale(n); i += 1) {
      const a = Math.random() * Math.PI * 2;
      const v = 0.6 + Math.random() * 1.6;
      set.emit({ x: x + (Math.random() - 0.5) * spread, y: y + (Math.random() - 0.5) * spread, z: z + (Math.random() - 0.5) * spread, vx: Math.cos(a) * v, vy: up * (0.5 + Math.random()), vz: Math.sin(a) * v, gravity: -14, drag: 0.3, life: 0.5 + Math.random() * 0.5, size: 0.1, frame: Math.floor(Math.random() * frames), fade: 0.2 });
    }
  }
  function twinkle(at, n, colour, spread = 0.7) {
    if (reduce) return;
    for (let i = 0; i < scale(n); i += 1) {
      sparkles.emit({ x: at.x + (Math.random() - 0.5) * spread, y: at.y + (Math.random() - 0.5) * spread, z: at.z + (Math.random() - 0.5) * spread, vx: (Math.random() - 0.5) * 0.3, vy: 0.3 + Math.random() * 0.5, vz: (Math.random() - 0.5) * 0.3, drag: 0.6, life: 0.7 + Math.random() * 0.6, size: 0.14, sizeTo: 0.05, r: colour.r * 1.3, g: colour.g * 1.3, b: colour.b * 1.3, fade: 0.4 });
    }
  }
  const STARS = [[1, 0.27, 0.27], [1, 0.62, 0.15], [0.5, 1, 0.25], [0.35, 0.8, 1], [1, 0.35, 1], [1, 0.95, 0.3]];
  function firework(x, y, z) {
    if (reduce) return;
    const [r, g, b] = STARS[Math.floor(Math.random() * STARS.length)];
    for (let i = 0; i < scale(70); i += 1) {
      const u = Math.random() * 2 - 1;
      const a = Math.random() * Math.PI * 2;
      const rr = Math.sqrt(1 - u * u);
      const speed = 4 + Math.random() * 2;
      sparks.emit({ x, y, z, vx: Math.cos(a) * rr * speed, vy: u * speed, vz: Math.sin(a) * rr * speed, gravity: -2.5, drag: 1.6, life: 1.2 + Math.random() * 0.6, size: 0.4, frame: 7, frameTo: 0, r: r * 1.6, g: g * 1.6, b: b * 1.6, twinkle: true, fade: 0.45 });
    }
  }
  function orbsTo(to, n) {
    if (reduce) return;
    for (let i = 0; i < scale(n); i += 1) {
      const t = 0.7 + Math.random() * 0.4;
      const gravity = -5;
      const sx = (Math.random() - 0.5) * 6;
      const sy = to.y + 0.3;
      const sz = CHEST_Z + (Math.random() - 0.5) * 1.5;
      orbs.emit({ x: sx, y: sy, z: sz, vx: (to.x - sx) / t, vy: (to.y - sy) / t - 0.5 * gravity * t, vz: (to.z - sz) / t, gravity, life: t, size: 0.14, frame: Math.floor(Math.random() * 7), r: 0.8, g: 1, b: 0.2, fade: 0.15 });
    }
  }
  function explode(at, now) {
    blastAt = now;
    blastGlow.position.set(at.x, at.y + 0.4, at.z);
    blastGlow.visible = true;
    flashLight.position.set(at.x, at.y + 1.2, at.z + 0.8);
    flashLight.intensity = reduce ? 14 : 40;
    if (reduce) return;
    for (let tick = 0; tick < 8; tick += 1) blastsDue.push({ at: now + tick * 50, x: at.x, y: at.y, z: at.z, age: tick / 8 });
    chip(chips, at.x, at.y, at.z, 30, 1.6, 4);
    chip(woodChips, at.x, at.y, at.z, 26, 0.8, 3.4, 64);
    for (let i = 0; i < scale(22); i += 1) {
      smoke.emit({ x: at.x + (Math.random() - 0.5) * 2, y: at.y + Math.random() * 1.2, z: at.z + (Math.random() - 0.5) * 1.6, vx: (Math.random() - 0.5) * 0.6, vy: 0.4 + Math.random() * 0.6, vz: (Math.random() - 0.5) * 0.6, drag: 0.4, life: 1.4 + Math.random() * 1.2, size: 0.55, sizeTo: 1.1, frame: 7, frameTo: 0, r: 0.32, g: 0.32, b: 0.34, a: 0.85, fade: 0.5 });
    }
  }
  function emitBlast(b) {
    for (let i = 0; i < scale(6); i += 1) {
      const size = 1.8 * (1 - b.age * 0.5);
      const grey = 0.24 + Math.random() * 0.34;
      blasts.emit({ x: b.x + (Math.random() - Math.random()) * 1.4, y: b.y + 0.5 + (Math.random() - Math.random()) * 0.9, z: b.z + (Math.random() - Math.random()) * 1.2, life: (6 + Math.random() * 4) / 20, size, frame: 0, frameTo: 15, r: grey, g: grey, b: grey, fade: 0.05 });
    }
  }

  /* ─────────── the tower, in play ─────────── */

  const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, reduce ? 0 : ms); });
  let tiles = 4;
  let active = false;
  let hovered = -1;
  let focused = -1;
  let current = 0;      // the storey being climbed
  let shake = 0;
  const chestAt = (floor, tile) => chests[floor * 4 + tile];

  /** Puts a chest in a state at once: shut, open with its loot, open with a creeper in it, or gone. */
  function setChest(c, state) {
    c.state = state;
    c.group.visible = state !== 'boom';
    c.lidGoal = state === 'closed' ? 0 : OPEN;
    c.lid = c.lidGoal;
    c.gem.visible = state === 'gem' || state === 'dim';
    c.gemAt = 0;
    c.head.visible = state === 'creeper';
    c.head.position.set(c.x, c.y + 0.42, c.z);
    c.head.rotation.y = 0;
    c.glow.material.opacity = 0;
  }
  function layout() {
    for (const c of chests) {
      const shown = c.tile < tiles;
      c.x = chestX(c.tile, tiles);
      c.group.position.set(c.x, c.y, c.z);
      c.head.position.set(c.x, c.y + 0.42, c.z);
      c.group.visible = shown && c.state !== 'boom';
      if (!shown) {
        c.gem.visible = false;
        c.head.visible = false;
      }
    }
  }

  /* ── framing, resolution, stepping down ── */
  const goalPos = new THREE.Vector3();
  const goalLook = new THREE.Vector3();
  const cam = { pos: new THREE.Vector3(), look: new THREE.Vector3() };
  let narrow = false;
  // How far the camera has drawn back: out while Steve climbs, so the world outside the tower shows
  // (the clouds coming down to meet him, the sun going down), in again when he steps off.
  let pull = 0;
  function frameShot(clock) {
    const y = climber.y;
    const sway = reduce ? 0 : Math.sin(clock * 0.21) * 0.5;
    goalLook.set(0, y + 0.95 + pull * 0.6, -1.1);
    goalPos.set(1.1 + sway + pull * 4.5, y + 1.85 + pull * 1.6, (narrow ? 12.5 : 8.2) + pull * 7);
  }
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
    () => { inner.intensity = 0; },
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
    narrow = camera.aspect < 0.95;
    camera.fov = Math.max(44, THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(28)) / camera.aspect)));
    camera.updateProjectionMatrix();
    if (composer) {
      composer.setPixelRatio(ratio);
      composer.setSize(w, h);
      if (bloom && tier.bloomScale < 1) bloom.setSize(Math.round(w * ratio * tier.bloomScale), Math.round(h * ratio * tier.bloomScale));
    }
    const pxScale = (h * ratio * camera.projectionMatrix.elements[5]) / 2;
    for (const s of sprites) s.setScale(pxScale);
    return true;
  }
  let lost = false;
  const onLost = (event) => { event.preventDefault(); lost = true; controls.onLost?.(); };
  canvas.addEventListener('webglcontextlost', onLost);

  /* ── picking ── */
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  function hit(event) {
    const rect = canvas.getBoundingClientRect();
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    for (const h of raycaster.intersectObjects(pickables, false)) {
      const c = chests[h.object.userData.chest];
      // The raycaster does not know what is hidden: a chest the mode does not use, or one blown up.
      if (c.tile >= tiles || !c.group.visible) continue;
      return c.floor === current && c.state === 'closed' ? c.tile : -1;
    }
    return -1;
  }
  const onMove = (event) => {
    hovered = active ? hit(event) : -1;
    canvas.style.cursor = hovered >= 0 ? 'pointer' : '';
  };
  const onLeave = () => { hovered = -1; canvas.style.cursor = ''; };
  const onClick = (event) => {
    if (!active) return;
    const tile = hit(event);
    if (tile >= 0) controls.onPick?.(tile);
  };
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('click', onClick);

  /* ─────────── the frame ─────────── */
  const innerColour = new THREE.Color(STOREYS[0].light);
  const wantColour = new THREE.Color();
  let raf = 0;
  let last = performance.now();
  let clock = 0;
  function frame() {
    raf = requestAnimationFrame(frame);
    const now = performance.now();
    if (FRAME_MS) {
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

    /* Steve: to the ladder, up it, and off it onto the storey he has reached. */
    {
      const c = climber;
      const goalY = floorY(c.goal);
      if (reduce) {
        c.y = goalY;
        c.x = STAND.x;
        c.z = STAND.z;
        c.leg = 'stand';
      } else if (Math.abs(c.y - goalY) > 0.01 && c.leg === 'stand') {
        c.leg = c.goal > c.floor ? 'toLadder' : 'drop';
      }
      const toward = (tx, tz, speed) => {
        const dx = tx - c.x;
        const dz = tz - c.z;
        const d = Math.hypot(dx, dz);
        if (d < 0.02) return true;
        const s = Math.min(d, dt * speed);
        c.x += (dx / d) * s;
        c.z += (dz / d) * s;
        c.yaw = Math.atan2(dx, dz);
        c.walk += dt * 9;
        return false;
      };
      if (c.leg === 'toLadder' && toward(LADDER.x, LADDER.z, 3.2)) c.leg = 'climb';
      else if (c.leg === 'climb') {
        c.yaw = -Math.PI / 2;
        c.y = Math.min(goalY, c.y + dt * 4.2);
        c.walk += dt * 7;
        if (Math.floor(c.y) !== Math.floor(c.y - dt * 4.2)) controls.onCue?.('climb');
        if (c.y >= goalY - 0.001) { c.y = goalY; c.floor = c.goal; c.leg = 'off'; }
      } else if (c.leg === 'off' && toward(STAND.x, STAND.z, 3.2)) c.leg = 'stand';
      else if (c.leg === 'drop') {
        c.y = goalY;
        c.floor = c.goal;
        c.x = STAND.x;
        c.z = STAND.z;
        c.leg = 'stand';
      }
      if (c.leg === 'stand') {
        const target = c.look ?? (active && (hovered >= 0 || focused >= 0) ? chestAt(current, hovered >= 0 ? hovered : focused) : null);
        const want = target ? Math.atan2(target.x - c.x, target.z - c.z) : Math.PI / 2 - 0.35;
        let d = want - c.yaw;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        c.yaw += d * (reduce ? 1 : 1 - Math.exp(-dt * 8));
      }
      const moving = c.leg === 'toLadder' || c.leg === 'off';
      const climbing = c.leg === 'climb';
      const swing = moving ? Math.cos(c.walk * 0.6662) * 0.9 : 0;
      const cheering = now < c.cheerUntil && !reduce;
      P.rightLeg.rotation.x = climbing ? Math.sin(c.walk) * 0.6 - 0.3 : swing;
      P.leftLeg.rotation.x = climbing ? -Math.sin(c.walk) * 0.6 - 0.3 : -swing;
      P.rightArm.rotation.x = climbing ? -2.6 + Math.sin(c.walk) * 0.4 : cheering ? -2.6 + Math.sin(clock * 14) * 0.3 : c.look ? -1.1 : -swing - 0.05;
      P.leftArm.rotation.x = climbing ? -2.6 - Math.sin(c.walk) * 0.4 : cheering ? -2.7 + Math.sin(clock * 14 + 1) * 0.3 : swing + 0.05;
      P.head.rotation.x = c.look ? 0.45 : climbing ? -0.4 : 0.1;
      const hop = now < c.hopUntil && !reduce ? Math.abs(Math.sin(((now - c.hopStart) / 1000) * Math.PI * 2.4)) * 0.35 : 0;
      steve.position.set(c.x, c.y + hop, c.z);
      steve.rotation.y = c.yaw;
      steveShadow.position.set(c.x, c.y + 0.02, c.z);
      steveShadow.visible = !climbing;
      const hurt = now < c.hurtUntil;
      steveMat.color.setRGB(1, hurt ? 0.45 : 1, hurt ? 0.45 : 1);
    }

    pull += ((climber.leg === 'stand' || reduce ? 0 : 1) - pull) * (1 - Math.exp(-dt * 2.2));
    frameShot(clock);
    const k = reduce ? 1 : 1 - Math.exp(-dt * 2.6);
    cam.pos.lerp(goalPos, k);
    cam.look.lerp(goalLook, k);
    camera.position.copy(cam.pos);
    if (shake > 0.01 && !reduce) {
      camera.position.x += (Math.random() - 0.5) * shake * 0.2;
      camera.position.y += (Math.random() - 0.5) * shake * 0.2;
    }
    shake *= Math.exp(-dt * 3.2);
    camera.lookAt(cam.look);

    /* The day outside, by how high the camera is: blue, through the clouds, sunset, night and stars. */
    {
      const t = clamp01((cam.pos.y - 1.85) / (ROOF - 1));
      skyAt(t);
      sky.material.uniforms.uTop.value.copy(skyTop);
      sky.material.uniforms.uLow.value.copy(skyLow);
      scene.fog.color.copy(skyLow);
      scene.background.copy(skyLow);
      sky.position.copy(camera.position);
      stars.position.copy(camera.position);
      stars.material.opacity = smooth(0.66, 0.92, t) * (reduce ? 1 : 0.85 + Math.sin(clock * 1.7) * 0.1);
      sunDir.copy(SUN_HIGH).lerp(SUN_LOW, smooth(0.35, 0.8, t)).normalize();
      sun.position.copy(camera.position).addScaledVector(sunDir, 260);
      sun.scale.setScalar(34 + smooth(0.45, 0.8, t) * 14);
      sun.lookAt(camera.position);
      sun.material.color.setRGB(1.5, 1.4 - smooth(0.45, 0.8, t) * 0.6, 1.2 - smooth(0.45, 0.8, t) * 0.8);
      sun.material.opacity = 1 - smooth(0.82, 0.95, t);
      sunLight.intensity = lerp(1.7, 0.35, smooth(0.5, 0.95, t));
      sunLight.color.setRGB(1, lerp(0.94, 0.62, smooth(0.45, 0.8, t)), lerp(0.85, 0.5, smooth(0.45, 0.8, t)));
      hemi.intensity = lerp(1.0, 0.6, smooth(0.6, 1, t));
      const focusY = climber.y + 1;
      sunLight.target.position.set(0, focusY, -1);
      sunLight.position.copy(sunLight.target.position).addScaledVector(sunDir, 30);
      // The storey's own lamp, in its own colour, following Steve up.
      wantColour.setHex(STOREYS[Math.min(FLOORS - 1, Math.round(climber.y / STOREY))].light);
      innerColour.lerp(wantColour, reduce ? 1 : 1 - Math.exp(-dt * 3));
      inner.color.copy(innerColour);
      inner.position.set(0.5, focusY + 1.2, -1.6);
    }
    clouds.step(reduce ? 0 : dt);

    /* The chests: lids swinging to where they should be, the loot turning. */
    const lit = active ? (hovered >= 0 ? hovered : focused) : -1;
    for (const c of chests) {
      if (c.tile >= tiles) continue;
      const peek = c.state === 'closed' && c.floor === current && c.tile === lit ? -0.22 : 0;
      c.lid += (c.lidGoal + peek - c.lid) * (reduce ? 1 : 1 - Math.exp(-dt * 12));
      c.hinge.rotation.x = c.lid;
      if (c.gem.visible) {
        const age = c.gemAt ? (now - c.gemAt) / 1000 : 9;
        const up = reduce ? 1 : easeOut(clamp01(age / 0.45));
        const dim = c.state === 'dim';
        c.gem.position.set(c.x, c.y + lerp(0.5, dim ? 0.85 : 1.25, up) + (reduce ? 0 : Math.sin(clock * 2 + c.phase) * 0.06), c.z);
        c.gem.rotation.y = reduce ? 0.5 : clock * 1.6 + c.phase;
        c.gem.scale.setScalar(dim ? 0.7 : 1);
        c.glow.position.set(c.x, c.gem.position.y, c.z + 0.1);
        c.glow.quaternion.copy(camera.quaternion);
        c.glow.material.opacity = dim ? 0.1 : 0.32 + (reduce ? 0 : Math.sin(clock * 2.4 + c.phase) * 0.05);
      }
      if (c.head.visible && !reduce) c.head.rotation.y = Math.sin(clock * 0.8 + c.phase) * 0.5;
    }
    // The creeper: up out of its chest, a hop down in front of it, then CreeperRenderer's swell and
    // its white flash as the fuse burns.
    if (hiss.chest) {
      const c = hiss.chest;
      const e = now - hiss.at;
      const rise = reduce ? 1 : easeOut(clamp01(e / (OUT_MS / 2)));
      const hop = reduce ? 1 : clamp01((e - OUT_MS / 2) / (OUT_MS / 2));
      const swell = clamp01((e - OUT_MS) / (HISS_MS - OUT_MS));
      let f = swell;
      const wobble = 1 + Math.sin(f * 100) * f * 0.01;
      f *= f;
      f *= f;
      const h = (1 + f * 0.4) * wobble;
      const w = (1 + f * 0.1) / wobble;
      creeper.scale.set(CREEPER_SCALE * h, CREEPER_SCALE * w, CREEPER_SCALE * h);
      const outY = lerp(-0.7, 0.55, rise) * (1 - hop) + Math.sin(hop * Math.PI) * 0.35;
      creeper.position.set(c.x, c.y + outY, c.z + hop * 0.95);
      creeper.rotation.y = Math.atan2(climber.x - c.x, climber.z - c.z);
      const white = Math.floor(swell * 10) % 2 === 0 ? 0 : Math.min(1, Math.max(0.5, swell));
      creeperMat.emissive.setScalar(white * 0.8);
    }
    if (lit >= 0 && chestAt(current, lit)?.state === 'closed') {
      const c = chestAt(current, lit);
      outline.visible = true;
      outline.position.set(c.x, c.y + 0.42, c.z);
      outline.material.color.setHex(hovered >= 0 ? 0x000000 : 0xffffff);
      outline.material.opacity = hovered >= 0 ? 0.6 : 0.9;
    } else {
      outline.visible = false;
    }

    for (let i = blastsDue.length - 1; i >= 0; i -= 1) {
      if (now < blastsDue[i].at) continue;
      emitBlast(blastsDue.splice(i, 1)[0]);
    }
    flashLight.intensity *= Math.exp(-dt * 6);
    if (blastGlow.visible) {
      const b = (now - blastAt) / 450;
      if (b >= 1) blastGlow.visible = false;
      else {
        blastGlow.material.opacity = (1 - b) * 0.45;
        blastGlow.scale.setScalar(2 + easeOut(b) * 5);
        blastGlow.quaternion.copy(camera.quaternion);
      }
    }
    for (let i = fireworksDue.length - 1; i >= 0; i -= 1) {
      if (now < fireworksDue[i].at) continue;
      const [f] = fireworksDue.splice(i, 1);
      firework(f.x, f.y, f.z);
      controls.onCue?.('firework');
    }
    if (!reduce) {
      halos.material.opacity = 0.5 + Math.sin(clock * 11) * 0.04 + Math.sin(clock * 17) * 0.03;
      const focusY = climber.y + 1;
      for (const fl of flames) {
        if (Math.abs(fl.y - focusY) > 7 || Math.random() > dt * (fl.inside ? 5 : 2)) continue;
        const set = fl.soul ? soulFire : fire;
        set.emit({ x: fl.x + (fl.inside ? (Math.random() - 0.5) * 0.5 : 0), y: fl.y, z: fl.z + (fl.inside ? (Math.random() - 0.5) * 0.5 : 0), vy: fl.inside ? 0.3 : 0.12, life: 0.5, size: fl.inside ? 0.12 : 0.09, sizeTo: 0.02, r: 1.3, g: 1.1, b: 0.8, fade: 0.5 });
      }
      beam.material.opacity = 0.5 + Math.sin(clock * 2) * 0.05;
    }
    for (const s of sprites) s.step(dt);
    if (composer) composer.render(dt);
    else renderer.render(scene, camera);
  }

  for (const c of chests) setChest(c, 'closed');
  layout();
  resize();
  climber.y = 0;
  frameShot(0);
  cam.pos.copy(goalPos);
  cam.look.copy(goalLook);
  {
    const warm = [creeper.clone(), ...loot.map((l) => new THREE.Mesh(l.geometry, l.material))];
    warm.forEach((mesh, i) => { mesh.visible = true; mesh.position.set(-40 + i * 2, -20, 0); scene.add(mesh); });
    try { renderer.compile(scene, camera); } catch { /* compiled on first use */ }
    warm.forEach((mesh) => scene.remove(mesh));
  }
  raf = requestAnimationFrame(frame);

  const controls = {
    onLost: null,
    /** Called with a chest the player clicked on the storey being climbed. */
    onPick: null,
    /** 'open', 'gem', 'fuse', 'boom', 'climb', 'collect', 'firework'. */
    onCue: null,
    tier: tier.name,

    /** Whether chests can be picked. */
    setActive(on) {
      active = on;
      if (!on) hovered = -1;
    },
    /** The chest the keyboard is on, outlined in white; -1 for none. */
    setFocus(tile) {
      focused = tile;
    },
    /**
     * The tower as the game stands. `floor` is the storey being climbed (or reached, once it is
     * over; FLOORS is the roof), `picks` the chest taken on every storey cleared, `traps` (at the end)
     * where every storey's creepers were, `trapHit` the one that went off, `pays` what each pays.
     */
    sync({ tiles: count, floor, picks, over, traps = null, trapHit = null, pays }) {
      if (count !== tiles) {
        tiles = count;
        layout();
      }
      current = Math.min(floor, FLOORS - 1);
      for (const c of chests) {
        // A chest still opening is left to finish; it ends in the state the game says.
        if (c.tile >= tiles || c.busy) continue;
        const cleared = c.floor < picks.length;
        const lostHere = over && trapHit !== null && c.floor === picks.length;
        let state = 'closed';
        if (cleared && picks[c.floor] === c.tile) state = 'gem';
        else if (lostHere && trapHit === c.tile) state = 'boom';
        else if (traps?.[c.floor]?.includes(c.tile)) state = 'creeper';
        else if (over) state = 'dim';
        if (state !== c.state) setChest(c, state);
        c.group.visible = c.state !== 'boom';
      }
      for (let f = 0; f < FLOORS; f += 1) {
        const tone = f < picks.length ? 'done' : f === floor && !over ? 'now' : 'ahead';
        writeSign(f, (pays[f] || '').replace('×', 'x'), tone);
      }
      if (climber.goal !== floor) {
        climber.goal = floor;
        if (floor < climber.floor) climber.leg = 'drop';
      }
    },
    /** Opens chest `tile` on storey `floor`; `trap` says a creeper was in it. Resolves when it is known. */
    async open(floor, tile, trap) {
      const c = chestAt(floor, tile);
      hovered = -1;
      climber.look = c;
      c.busy = true;
      c.lidGoal = OPEN;
      controls.onCue?.('open');
      await wait(260);
      const now = performance.now();
      if (!trap) {
        c.state = 'gem';
        c.gem.visible = true;
        c.gemAt = now;
        twinkle(new THREE.Vector3(c.x, c.y + 1.1, c.z), 12, new THREE.Color(STOREYS[floor].light));
        controls.onCue?.('gem');
        climber.look = null;
        climber.hopStart = now;
        climber.hopUntil = now + 420;
        await wait(380);
        c.busy = false;
        return;
      }
      // A creeper climbs out, hisses, flashes and swells -- and goes off.
      c.state = 'lit';
      hiss.chest = c;
      hiss.at = now;
      creeper.visible = true;
      controls.onCue?.('fuse');
      await wait(HISS_MS);
      const at = performance.now();
      hiss.chest = null;
      creeper.visible = false;
      creeperMat.emissive.setScalar(0);
      c.state = 'boom';
      c.group.visible = false;
      explode(new THREE.Vector3(c.x, c.y + 0.5, c.z + 0.6), at);
      shake = 1.4;
      controls.onCue?.('boom');
      climber.look = null;
      climber.hurtUntil = at + 350;
      await wait(420);
      c.busy = false;
    },
    /** Cashed out at `bps`: XP to Steve, and the bigger the haul the more fireworks. */
    celebrate(bps) {
      const x = bps / 10_000;
      const now = performance.now();
      const at = new THREE.Vector3(climber.x, climber.y + 1.2, climber.z);
      orbsTo(at, Math.min(16, 3 + Math.round(Math.log2(Math.max(1, x)) * 3)));
      controls.onCue?.('collect');
      climber.hopStart = now;
      climber.hopUntil = now + (x >= 10 ? 2400 : 900);
      if (x >= 2) climber.cheerUntil = now + (x >= 10 ? 2600 : 1400);
      const count = x >= 25 ? 5 : x >= 5 ? 3 : 1;
      for (let i = 0; i < count; i += 1) fireworksDue.push({ at: now + 250 + i * 380 + Math.random() * 200, x: (Math.random() - 0.5) * 9, y: climber.y + 5 + Math.random() * 2, z: -2 - Math.random() * 3 });
      if (x >= 10) shake = 0.4;
    },
    dispose() {
      cancelAnimationFrame(raf);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('click', onClick);
      canvas.removeEventListener('webglcontextlost', onLost);
      composer?.dispose();
      renderer.dispose();
      canvas.remove();
    },
  };
  return controls;
}
