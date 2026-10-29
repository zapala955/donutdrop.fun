/* fishing3d.js — Fishing: a deep dive, in 3D, with the look of the shader packs the game is played
 * with.
 *
 * Above the water: a sunset ocean, the swell moving and the sky mirrored in it, an oak boat and
 * Steve in it with his rod. The cast goes out, the lure goes under, and the camera goes down with it:
 * past the shallows, a coral reef, a kelp forest, a shipwreck, an ocean monument, the abyss, and an
 * ancient city at the bottom of it all. Every block, plant, creature, particle and item is the game's
 * own, out of the client jar; what is drawn rather than taken is light: the shafts of sun through the
 * water, the caustics they throw on the stone, the glow round a sea lantern, the lantern on the lure.
 *
 * The depth is the multiplier: 22 blocks for every doubling. Reel up and the catch comes up the line
 * to the boat; go too deep and something down there cuts it -- a drowned in the upper waters, a
 * guardian round the monument and in the abyss, the warden in the ancient city.
 *
 * Nothing here decides anything. fishing.js casts on the click, says when the lure goes under and
 * how deep the line is each frame, and whether it was reeled up or cut. If WebGL is missing or the
 * context is lost, fishing.js shows the flat pond.
 *
 * Low-end machines get less of everything (quality3d.js): no glow, fewer particles and creatures, a
 * shorter view into the water, a coarser sea; and a machine that cannot keep up steps down further
 * on its own.
 */
import { reduceMotion } from './util.js';
import { buildChest, getTHREE, loadImage, softDot } from './mc3d.js';
import {
  BOAT, COD, DOLPHIN, GUARDIAN, PLAYER, SALMON, SQUID, WARDEN, atlas, buildModel, drownedModel, itemModel,
  makeSprites, pixelTexture, placeEntity, poseCod, poseDolphin, poseGuardian, poseSalmon, poseSquid,
} from './mcmodels.js';
import { BRIGHTNESS, chooseTier, createGovernor, frameMs, minFpsFor, ratioFor } from './quality3d.js';
import { gradePass } from './scenery3d.js';

/* ─────────── the dive ─────────── */

const PER_DOUBLING = 22;                 // blocks of depth for every doubling of the multiplier
/** How deep the lure is at a multiplier (in hundredths), in blocks. */
export const depthOf = (x100) => PER_DOUBLING * Math.log2(Math.max(100, x100) / 100);
const LURE_TOP = -1.4;                   // the lure's height when the dive starts
const PLAYER_PIXEL = 0.9375 / 16;        // PlayerRenderer draws the model at 15/16
const BOAT_AT = { x: -2.6, z: 6.6 };
const SHOW = { x: 0, y: 2.2, z: 3.8 };   // where a catch hangs over the water, off the boat's bow
/** The lure's shaft: nothing is ever built where the lure and its line go down. */
const inShaft = (x, z) => x >= -2 && x <= 1 && z >= -2 && z <= 1;

/* The zones, from the multiplier each starts at (the page names them from the same list). */
export const ZONES = [
  {
    id: 'shallows', fromX: 1, fog: 0x2f9fc0, density: 0.026, hemi: [0xd0f2ff, 0x3a7f8c, 1.9], beam: 1, caustic: 1.15,
    snow: [0.8, 0.95, 1], wall: [['sand', 7], ['gravel', 2], ['clay', 2]],
    plants: [['seagrass', 6], ['tall_seagrass_bottom', 2], ['kelp', 1]], shelves: 0.16,
  },
  {
    id: 'reef', fromX: 1.5, fog: 0x2794b8, density: 0.028, hemi: [0xc8f0ff, 0x336f80, 2.0], beam: 0.85, caustic: 0.95,
    snow: [0.8, 0.95, 1],
    wall: [['sand', 4], ['tube_coral_block', 2], ['brain_coral_block', 2], ['bubble_coral_block', 2], ['fire_coral_block', 2], ['horn_coral_block', 2]],
    plants: [['tube_coral', 2], ['brain_coral', 2], ['bubble_coral', 2], ['fire_coral', 2], ['horn_coral', 2], ['tube_coral_fan', 1],
      ['brain_coral_fan', 1], ['fire_coral_fan', 1], ['horn_coral_fan', 1], ['bubble_coral_fan', 1], ['seagrass', 3], ['sea_pickle', 2]],
    shelves: 0.28,
  },
  {
    id: 'kelp', fromX: 3, fog: 0x1d7a8c, density: 0.031, hemi: [0xa8e4ec, 0x234f58, 1.75], beam: 0.6, caustic: 0.6,
    snow: [0.75, 0.9, 0.95], wall: [['gravel', 3], ['stone', 3], ['clay', 2], ['dirt', 1]],
    plants: [['seagrass', 2], ['kelp', 5]], kelp: true, shelves: 0.3,
  },
  {
    id: 'wreck', fromX: 5, fog: 0x165a72, density: 0.034, hemi: [0x8cc8dc, 0x1a3c48, 1.55], beam: 0.35, caustic: 0.35,
    snow: [0.7, 0.85, 0.9], wall: [['stone', 3], ['gravel', 2], ['mossy_cobblestone', 2], ['cobblestone', 2]],
    plants: [['seagrass', 3], ['kelp', 1]], kelp: true, shelves: 0.16,
  },
  {
    id: 'monument', fromX: 10, fog: 0x0f4a5e, density: 0.036, hemi: [0x7cc8c4, 0x163a40, 1.4], beam: 0.15, caustic: 0.18,
    snow: [0.6, 0.9, 0.85], wall: [['prismarine', 4], ['prismarine_bricks', 3], ['dark_prismarine', 2]],
    plants: [], glow: [['sea_lantern', 1]], shelves: 0.1,
  },
  {
    id: 'abyss', fromX: 25, fog: 0x0a1c3a, density: 0.042, hemi: [0x6a86c0, 0x141e34, 1.15], beam: 0, caustic: 0,
    snow: [0.45, 0.6, 1], wall: [['deepslate', 5], ['cobbled_deepslate', 3], ['tuff', 2], ['smooth_basalt', 1], ['obsidian', 1]],
    plants: [], faces: [['glow_lichen', 1]], glow: [['magma', 3], ['crying_obsidian', 1]], shelves: 0.12,
  },
  {
    id: 'city', fromX: 60, fog: 0x07222a, density: 0.036, hemi: [0x64a8ac, 0x142c32, 1.35], beam: 0, caustic: 0,
    snow: [0.3, 0.85, 0.9], wall: [['deepslate_tiles', 4], ['polished_deepslate', 2], ['cobbled_deepslate', 2], ['sculk', 4], ['chiseled_deepslate', 1]],
    plants: [], faces: [['sculk_vein', 1]], shelves: 0.12,
  },
];
for (const zone of ZONES) zone.from = depthOf(Math.round(zone.fromX * 100));
const zoneAt = (depth) => {
  let at = ZONES[0];
  for (const zone of ZONES) if (depth >= zone.from) at = zone;
  return at;
};
/** How bright each block that glows is, over what light it gets. */
const GLOWING = {
  sea_lantern: 1.6, magma: 1.3, crying_obsidian: 0.7, sculk_catalyst_side_bloom: 0.3, sea_pickle: 1.1, glow_lichen: 0.55, sculk: 0.7, sculk_vein: 0.5,
  amethyst_cluster: 0.5, gold_block: 0.15, sculk_sensor_side: 0.35, sculk_shrieker_side: 0.25,
};

/** What cuts a line too deep, by the zone it is cut in. */
export const CUTTER = { shallows: 'drowned', reef: 'drowned', kelp: 'drowned', wreck: 'drowned', monument: 'guardian', abyss: 'guardian', city: 'warden' };

/* The sinker on the line: how fast it goes down is the server's affair; this is only how it looks. */
const SINKERS = ['feather', 'iron', 'anvil'];

const GLINTS = new Set(['enchanted_golden_apple', 'trident', 'heart_of_the_sea']);

const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
const easeOut = (t) => 1 - (1 - t) ** 3;
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const lerp = (a, b, t) => a + (b - a) * t;

/** A small seeded generator, so every dive goes down the same trench. */
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
/** A stable hash of a block position, 0..1. */
function hash3(x, y, z) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
/** Smooth value noise in two dimensions, for the trench walls. */
function noise2(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  return lerp(lerp(hash3(xi, yi, 7), hash3(xi + 1, yi, 7), u), lerp(hash3(xi, yi + 1, 7), hash3(xi + 1, yi + 1, 7), u), v);
}
/** The back wall's face, a few blocks in and out. */
const wallZ = (x, y) => -6 - Math.floor(noise2(x * 0.22, y * 0.18) * 3);

/**
 * Builds the dive into `host` and resolves with its controls, or with null when this browser cannot
 * draw it (no WebGL), in which case nothing is left behind in `host`. `catches` are the item ids that
 * can come up and `icon(id)` the sprite of each.
 */
export async function createPond3d(host, { sinker = 'feather', catches = [], icon }) {
  const THREE = await getTHREE();
  const probe = document.createElement('canvas');
  const probeGl = probe.getContext('webgl2');
  if (!probeGl) return null;
  const tier = chooseTier(probeGl);
  probeGl.getExtension('WEBGL_lose_context')?.loseContext();
  const canvas = document.createElement('canvas');
  canvas.className = 'fishing__gl';
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
  for (const zone of ZONES) {
    zone.c ??= { fog: new THREE.Color(zone.fog), sky: new THREE.Color(zone.hemi[0]), ground: new THREE.Color(zone.hemi[1]) };
  }

  /* ── what is loaded ── */
  const TILES = [
    'sand', 'gravel', 'clay', 'dirt', 'stone', 'cobblestone', 'mossy_cobblestone', 'seagrass', 'tall_seagrass_bottom',
    'tall_seagrass_top', 'kelp', 'kelp_plant', 'tube_coral_block', 'brain_coral_block', 'bubble_coral_block', 'fire_coral_block',
    'horn_coral_block', 'tube_coral', 'brain_coral', 'bubble_coral', 'fire_coral', 'horn_coral', 'tube_coral_fan', 'brain_coral_fan',
    'bubble_coral_fan', 'fire_coral_fan', 'horn_coral_fan', 'sea_pickle', 'oak_planks', 'spruce_planks', 'spruce_log',
    'stripped_spruce_log', 'prismarine', 'prismarine_bricks', 'dark_prismarine', 'sea_lantern', 'gold_block', 'wet_sponge',
    'deepslate', 'cobbled_deepslate', 'tuff', 'smooth_basalt', 'obsidian', 'crying_obsidian', 'magma', 'amethyst_block',
    'amethyst_cluster', 'glow_lichen', 'deepslate_tiles', 'polished_deepslate', 'chiseled_deepslate', 'reinforced_deepslate_side',
    'sculk', 'sculk_vein', 'sculk_catalyst_side_bloom', 'sculk_shrieker_side', 'sculk_sensor_side', 'iron_bars', 'bone_block_side',
  ];
  const BLOCKS = ['soul_lantern', 'grass_block_top', 'grass_block_side', 'oak_leaves', 'oak_log', 'oak_log_top', 'water_still', 'iron_block', 'anvil', 'anvil_top'];
  const ENTITY = ['steve', 'fishing_hook', 'cod', 'salmon', 'squid', 'glow_squid', 'dolphin', 'drowned', 'drowned_outer_layer',
    'guardian', 'guardian_elder', 'guardian_beam', 'warden', 'warden_bioluminescent_layer', 'warden_heart', 'boat_oak', 'experience_orb'];
  const ENV = ['sun', 'clouds'];
  const PARTICLE = ['bubble', 'glow', 'glint',
    ...[0, 1, 2, 3, 4].map((i) => `bubble_pop_${i}`), ...[0, 1, 2, 3].map((i) => `splash_${i}`), ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => `spark_${i}`),
    ...Array.from({ length: 16 }, (_, i) => `sonic_boom_${i}`), ...Array.from({ length: 11 }, (_, i) => `sculk_soul_${i}`)];
  let loaded;
  try {
    loaded = await Promise.all([
      Promise.all([...TILES, ...BLOCKS].map((name) => loadImage(`assets/img/block/${name}.png`))),
      Promise.all(ENTITY.map((name) => loadImage(`assets/img/entity/${name}.png`))),
      Promise.all(ENV.map((name) => loadImage(`assets/img/env/${name}.png`))),
      Promise.all(PARTICLE.map((name) => loadImage(`assets/img/particle/${name}.png`))),
      loadImage('assets/img/items/fishing_rod.png'),
      loadImage('assets/img/items/fishing_rod_cast.png'),
      loadImage('assets/img/items/feather.png'),
      loadImage('assets/img/misc/enchanted_glint_item.png'),
      loadImage('assets/img/misc/underwater.png'),
      Promise.all(catches.map((id) => loadImage(icon(id)).catch(() => null))),
      buildChest('assets/img/block/chest_normal.png', 1).catch(() => null),
      tier.composer
        ? import(/* @vite-ignore */ new URL('assets/vendor/three-addons.js', document.baseURI).href).catch(() => null)
        : Promise.resolve(null),
    ]);
  } catch {
    renderer.dispose();
    return null;
  }
  const [blockImgs, entityImgs, envImgs, particleImgs, rodImg, rodCastImg, featherImg, glintImg, underwaterImg, catchImgs, chestModel, addons] = loaded;
  const img = Object.fromEntries([...TILES, ...BLOCKS].map((name, i) => [name, blockImgs[i]]));
  const ent = Object.fromEntries(ENTITY.map((name, i) => [name, entityImgs[i]]));
  const [sunImg, cloudsImg] = envImgs;
  const part = Object.fromEntries(PARTICLE.map((name, i) => [name, particleImgs[i]]));
  host.prepend(canvas);

  const reduce = reduceMotion();
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0xd8a98c, 0.0045);
  const camera = new THREE.PerspectiveCamera(52, 1, 0.08, 320);
  scene.add(camera);

  let composer = null;
  let bloom = null;
  if (addons) {
    try {
      const target = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: tier.samples });
      composer = new addons.EffectComposer(renderer, target);
      composer.addPass(new addons.RenderPass(scene, camera));
      bloom = new addons.UnrealBloomPass(new THREE.Vector2(4, 4), 0.6, 0.55, 1.1);
      composer.addPass(bloom);
      composer.addPass(new addons.OutputPass());
      composer.addPass(gradePass(THREE, addons, { contrast: 1.04, saturation: 1.06, lift: [0.0, 0.006, 0.014], gain: [1.01, 1.0, 0.99], vignette: 0.16 }));
    } catch {
      composer = null;
      bloom = null;
    }
  }

  /* ── the block atlas: every block and plant of the dive on one texture, animated in place ── */
  const ATLAS_COLS = 8;
  const ATLAS_ROWS = Math.ceil(TILES.length / ATLAS_COLS);
  const atlasCanvas = document.createElement('canvas');
  atlasCanvas.width = ATLAS_COLS * 16;
  atlasCanvas.height = ATLAS_ROWS * 16;
  const atlasG = atlasCanvas.getContext('2d');
  atlasG.imageSmoothingEnabled = false;
  const tileOf = new Map(TILES.map((name, i) => [name, i]));
  const framesOf = (name) => Math.max(1, Math.floor(img[name].naturalHeight / 16));
  const animated = TILES.filter((name) => framesOf(name) > 1);
  const shownFrame = new Map();
  function drawTile(name, frame) {
    const i = tileOf.get(name);
    const x = (i % ATLAS_COLS) * 16;
    const y = Math.floor(i / ATLAS_COLS) * 16;
    const f = frame % framesOf(name);
    atlasG.clearRect(x, y, 16, 16);
    atlasG.drawImage(img[name], 0, f * 16, 16, 16, x, y, 16, 16);
    shownFrame.set(name, f);
  }
  for (const name of TILES) drawTile(name, 0);
  const atlasTex = pixelTexture(THREE, atlasCanvas);
  /** The atlas tile's corner in uv space. */
  const tileUv = (name) => {
    const i = tileOf.get(name);
    return [(i % ATLAS_COLS) / ATLAS_COLS, 1 - (Math.floor(i / ATLAS_COLS) + 1) / ATLAS_ROWS];
  };
  function stepAtlas(clock) {
    if (reduce) return;
    let dirty = false;
    for (const name of animated) {
      // The game's frame times: prismarine and the sea lantern slow, the plants a little quicker.
      // On a low-end machine the plants sway in fewer frames: each change re-uploads the atlas.
      const speed = (name === 'prismarine' ? 1.5 : name === 'sea_lantern' ? 0.25 : name === 'magma' ? 0.4 : 0.1) * (tier.name === 'low' ? 2.5 : 1);
      const frame = Math.floor(clock / speed) % framesOf(name);
      if (shownFrame.get(name) !== frame) {
        drawTile(name, frame);
        dirty = true;
      }
    }
    if (dirty) atlasTex.needsUpdate = true;
  }

  /* ── the undersea look: caustics by world position, a glow per block, the atlas tile, plants in
   * the current ── */
  const sea = {
    uTime: { value: 0 },
    uCaustic: { value: 0 },
    uTile: { value: new THREE.Vector2(1 / ATLAS_COLS, 1 / ATLAS_ROWS) },
  };
  const CAUSTIC_GLSL = `
    float causticAt(vec2 p, float t) {
      p = floor(p * 8.0) / 8.0;
      vec2 q = p * 0.75;
      float c = 0.0;
      for (int i = 0; i < 3; i++) {
        q += vec2(sin(q.y * 1.7 + t * 0.9 + float(i)), cos(q.x * 1.3 - t * 0.7 + float(i) * 1.7)) * 0.65;
        c += 0.18 / (0.08 + abs(sin(q.x * 1.9) * sin(q.y * 2.1)));
      }
      return clamp(pow(c * 0.11, 3.0), 0.0, 1.6);
    }`;
  /** Puts the undersea look on a Lambert material drawn from the atlas, per instance. */
  function undersea(material, plants) {
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, sea);
      shader.vertexShader = `
        attribute vec2 aTile;
        attribute float aGlow;
        uniform float uTime;
        uniform vec2 uTile;
        varying float vGlow;
        varying vec3 vSeaWorld;
        varying float vSeaUp;
        ${shader.vertexShader}`
        .replace('#include <uv_vertex>', `#include <uv_vertex>
          vMapUv = aTile + (0.03125 + uv * 0.9375) * uTile;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          ${plants ? `
          vec2 swayAt = instanceMatrix[3].xz + instanceMatrix[3].y;
          float swayK = clamp(position.y + 0.5, 0.0, 1.0);
          transformed.x += sin(uTime * 1.3 + swayAt.x * 0.6 + swayAt.y * 0.4) * 0.11 * swayK;
          transformed.z += cos(uTime * 1.1 + swayAt.x * 0.3 + swayAt.y * 0.7) * 0.07 * swayK;` : ''}`)
        .replace('#include <project_vertex>', `#include <project_vertex>
          vec4 seaW = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
          vSeaWorld = seaW.xyz;
          vSeaUp = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * objectNormal).y;
          vGlow = aGlow;`);
      shader.fragmentShader = `
        uniform float uTime;
        uniform float uCaustic;
        varying float vGlow;
        varying vec3 vSeaWorld;
        varying float vSeaUp;
        ${CAUSTIC_GLSL}
        ${shader.fragmentShader}`
        .replace('#include <map_fragment>', `#include <map_fragment>
          float seaC = uCaustic * clamp(1.0 + vSeaWorld.y / 60.0, 0.0, 1.0) * (${plants ? '0.6' : '0.3 + 0.7 * max(vSeaUp, 0.0)'});
          if (seaC > 0.001) diffuseColor.rgb *= 1.0 + causticAt(vSeaWorld.xz + vSeaWorld.y * 0.35, uTime) * seaC;`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          totalEmissiveRadiance += diffuseColor.rgb * vGlow;`);
    };
    material.customProgramCacheKey = () => `undersea:${plants}`;
    return material;
  }
  const blockMat = undersea(new THREE.MeshLambertMaterial({ map: atlasTex }), false);
  const plantMat = undersea(new THREE.MeshLambertMaterial({ map: atlasTex, alphaTest: 0.5, side: THREE.DoubleSide }), true);
  const faceMat = undersea(new THREE.MeshLambertMaterial({ map: atlasTex, alphaTest: 0.5, side: THREE.DoubleSide }), false);

  /* ── light ── */
  const hemi = new THREE.HemisphereLight(0xffe0c2, 0x30405a, 1.25);
  scene.add(hemi);
  const SUN_DIR = new THREE.Vector3(0.52, 0.12, -0.85).normalize();
  const sunLight = new THREE.DirectionalLight(0xffc08a, 2.3);
  sunLight.position.copy(SUN_DIR).multiplyScalar(30);
  scene.add(sunLight, sunLight.target);
  // The lure carries a light: a lantern's glow on the line, what the deep is seen by.
  const lureLight = new THREE.PointLight(0xffd9a0, 0, 18, 1.2);
  scene.add(lureLight);

  /* ─────────── above the water ─────────── */

  /* The sky: a sunset gradient dome, the sun low over the sea, and the game's fancy clouds. */
  const sky = new THREE.Mesh(new THREE.SphereGeometry(280, 32, 16), new THREE.ShaderMaterial({
    uniforms: {
      uTop: { value: new THREE.Color(0x3a5fa8) },
      uHorizon: { value: new THREE.Color(0xf2a36b) },
      uGlow: { value: new THREE.Color(0xffb36b) },
      uSunDir: { value: SUN_DIR },
    },
    side: THREE.BackSide,
    depthWrite: false,
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 uTop;
      uniform vec3 uHorizon;
      uniform vec3 uGlow;
      uniform vec3 uSunDir;
      varying vec3 vDir;
      void main() {
        vec3 dir = normalize(vDir);
        float d = max(0.0, dot(dir, uSunDir));
        vec3 col = mix(uHorizon, uTop, smoothstep(-0.02, 0.45, dir.y));
        col = mix(col, uGlow, pow(d, 4.0) * 0.55 * (1.0 - smoothstep(0.0, 0.6, dir.y)));
        col += uGlow * (pow(d, 16.0) * 0.3 + pow(d, 96.0) * 0.45);
        col = mix(col, uHorizon * 0.6, smoothstep(0.0, -0.3, dir.y));
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  }));
  sky.renderOrder = -10;
  scene.add(sky);
  const sunDisc = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
    map: pixelTexture(THREE, sunImg), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    toneMapped: false, color: new THREE.Color(1.5, 1.2, 0.85),
  }));
  const sunGlow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
    map: softDot(), color: 0xff9a50, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    toneMapped: false,
  }));
  sunDisc.renderOrder = -9;
  sunGlow.renderOrder = -9;
  scene.add(sunDisc, sunGlow);
  const placeSun = (at) => {
    sky.position.copy(at);
    sunDisc.position.copy(at).addScaledVector(SUN_DIR, 240);
    sunDisc.lookAt(at);
    sunDisc.scale.setScalar(18);
    sunGlow.position.copy(sunDisc.position);
    sunGlow.lookAt(at);
    sunGlow.scale.setScalar(46);
  };

  /* Fancy clouds: every opaque pixel of clouds.png a slab, lit warm on the side facing the sunset. */
  const CLOUD_CELL = 7;
  const CLOUD_SPAN = tier.name === 'low' ? 40 : 60;
  const cloudPixels = (() => {
    const c = document.createElement('canvas');
    c.width = cloudsImg.naturalWidth;
    c.height = cloudsImg.naturalHeight;
    const g = c.getContext('2d');
    g.drawImage(cloudsImg, 0, 0);
    return { data: g.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height };
  })();
  const cloudGeo = new THREE.BoxGeometry(CLOUD_CELL, CLOUD_CELL / 3, CLOUD_CELL);
  {
    const normal = cloudGeo.attributes.normal;
    const shade = new Float32Array(normal.count * 3);
    for (let i = 0; i < normal.count; i += 1) {
      const nx = normal.getX(i);
      const ny = normal.getY(i);
      const nz = normal.getZ(i);
      // The game's cloud faces (top full, bottom darkest, sides between), and the sunset on its side.
      const base = ny > 0.5 ? 1 : ny < -0.5 ? 0.62 : Math.abs(nx) > 0.5 ? 0.86 : 0.78;
      const warm = Math.max(0, nx * SUN_DIR.x + nz * SUN_DIR.z) * 0.35;
      shade.set([base + warm, base + warm * 0.55, base + warm * 0.2], i * 3);
    }
    cloudGeo.setAttribute('color', new THREE.BufferAttribute(shade, 3));
  }
  const clouds = new THREE.InstancedMesh(cloudGeo, new THREE.MeshBasicMaterial({ vertexColors: true, color: 0xffe2cc }), CLOUD_SPAN * CLOUD_SPAN);
  clouds.frustumCulled = false;
  clouds.count = 0;
  scene.add(clouds);
  let cloudColumn = null;
  function layClouds(column) {
    const m = new THREE.Matrix4();
    let n = 0;
    for (let cz = 0; cz < CLOUD_SPAN; cz += 1) {
      for (let cx = 0; cx < CLOUD_SPAN; cx += 1) {
        const u = (((cx - column) % cloudPixels.w) + cloudPixels.w) % cloudPixels.w;
        const v = (cz + 40) % cloudPixels.h;
        if (cloudPixels.data[(v * cloudPixels.w + u) * 4 + 3] < 128) continue;
        clouds.setMatrixAt(n, m.makeTranslation((cx - CLOUD_SPAN / 2) * CLOUD_CELL, 46, (cz - CLOUD_SPAN * 0.75) * CLOUD_CELL));
        n += 1;
      }
    }
    clouds.count = n;
    clouds.instanceMatrix.needsUpdate = true;
  }
  function driftClouds(clock) {
    const drift = reduce ? 0 : clock * 0.5;
    const column = Math.floor(drift / CLOUD_CELL);
    if (column !== cloudColumn) {
      cloudColumn = column;
      layClouds(column);
    }
    clouds.position.x = drift - column * CLOUD_CELL;
  }

  /* The sea: the game's still water on a moving swell, the sky mirrored in it and the sun's path on it.
   * From below it is the bright skin of the surface. */
  const waterCanvas = document.createElement('canvas');
  waterCanvas.width = waterCanvas.height = 16;
  const waterG = waterCanvas.getContext('2d');
  const waterTex = new THREE.CanvasTexture(waterCanvas);
  waterTex.magFilter = THREE.NearestFilter;
  waterTex.minFilter = THREE.LinearMipmapLinearFilter;
  waterTex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  waterTex.colorSpace = THREE.SRGBColorSpace;
  waterTex.wrapS = waterTex.wrapT = THREE.RepeatWrapping;
  waterTex.repeat.set(160, 160);
  const WATER_FRAMES = Math.max(1, Math.floor(img.water_still.naturalHeight / 16));
  let waterFrame = -1;
  const showWaterFrame = (n) => {
    if (n === waterFrame) return;
    waterFrame = n;
    waterG.clearRect(0, 0, 16, 16);
    waterG.drawImage(img.water_still, 0, n * 16, 16, 16, 0, 0, 16, 16);
    waterTex.needsUpdate = true;
  };
  showWaterFrame(0);
  /* The swell: four waves, [height, direction x, direction z, frequency]. */
  const WAVES = [[0.07, 0.31, 0.9, 1.1], [0.05, -0.47, 0.55, 1.6], [0.03, 0.83, -0.4, 2.3], [0.02, -0.2, -0.95, 3.1]];
  /** The swell's height at a point, as the sea's shader moves it. */
  const waveAt = (x, z, t) => (reduce ? 0 : WAVES.reduce((sum, [a, dx, dz, f]) => sum + a * Math.sin((dx * x + dz * z) * f + t * f * 1.3), 0));
  const seaUniforms = { uTime: sea.uTime, uUnder: { value: new THREE.Color(0x7fe0f2) } };
  const seaMat = new THREE.MeshStandardMaterial({
    map: waterTex, color: 0x2f5fd8, roughness: 0.12, metalness: 0, transparent: true, opacity: 0.94, envMapIntensity: 0.7,
    side: THREE.DoubleSide, emissive: new THREE.Color(0x0b2a55), emissiveIntensity: 0.4,
  });
  seaMat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, seaUniforms);
    const waves = WAVES.map(([a, dx, dz, f]) => `vec4(${a.toFixed(3)}, ${dx.toFixed(3)}, ${dz.toFixed(3)}, ${f.toFixed(3)})`).join(', ');
    // The plane lies flat (local z is up, local y is world -z); the swell is worked out in the world.
    shader.vertexShader = `uniform float uTime;\n${shader.vertexShader}`
      .replace('#include <beginnormal_vertex>', `
        vec4 W[4] = vec4[4](${waves});
        vec3 seaP = (modelMatrix * vec4(position, 1.0)).xyz;
        float dhx = 0.0;
        float dhz = 0.0;
        float seaH = 0.0;
        for (int i = 0; i < 4; i++) {
          float ph = (W[i].y * seaP.x + W[i].z * seaP.z) * W[i].w + uTime * W[i].w * 1.3;
          seaH += W[i].x * sin(ph);
          dhx += W[i].x * W[i].y * W[i].w * cos(ph);
          dhz += W[i].x * W[i].z * W[i].w * cos(ph);
        }
        vec3 objectNormal = normalize(vec3(-dhx, dhz, 1.0));`)
      .replace('#include <begin_vertex>', `
        vec3 transformed = vec3(position);
        transformed.z += seaH;`);
    shader.fragmentShader = `uniform vec3 uUnder;\n${shader.fragmentShader}`
      .replace('#include <map_fragment>', `#include <map_fragment>
        diffuseColor.a = opacity;`)
      .replace('#include <dithering_fragment>', `#include <dithering_fragment>
        if (!gl_FrontFacing) gl_FragColor = vec4(mix(uUnder, uUnder * 1.6, diffuseColor.r), 0.85);`);
  };
  seaMat.customProgramCacheKey = () => (reduce ? 'deepsea-flat' : 'deepsea-swell');
  const seaSurface = new THREE.Mesh(new THREE.PlaneGeometry(220, 220, tier.waves, tier.waves), seaMat);
  seaSurface.rotation.x = -Math.PI / 2;
  seaSurface.renderOrder = 1;
  scene.add(seaSurface);

  /* Two islands on the horizon, sand and grass and an oak each, so the sea has a far side. */
  {
    const box = new THREE.BoxGeometry(1, 1, 1);
    const spots = { sand: [], grass: [], log: [], leaves: [] };
    const rand = seeded(11);
    for (const [cx, cz, r] of [[-46, -70, 7], [38, -88, 5]]) {
      for (let x = -r; x <= r; x += 1) {
        for (let z = -r; z <= r; z += 1) {
          const d = Math.hypot(x, z) + rand() * 1.2;
          if (d > r) continue;
          spots.sand.push([cx + x, -0.5 + (d < r - 2 ? 1 : 0), cz + z]);
          if (d < r - 2.5) spots.grass.push([cx + x, 1.5, cz + z]);
        }
      }
      for (let y = 2; y < 7; y += 1) spots.log.push([cx, y + 0.5, cz]);
      for (let y = 5; y <= 8; y += 1) {
        const rr = y >= 7 ? 1 : 2;
        for (let x = -rr; x <= rr; x += 1) {
          for (let z = -rr; z <= rr; z += 1) {
            if ((x === 0 && z === 0 && y < 7) || (Math.abs(x) === rr && Math.abs(z) === rr && rand() < 0.5)) continue;
            spots.leaves.push([cx + x, y + 0.5, cz + z]);
          }
        }
      }
    }
    const lambert = (map, opts = {}) => new THREE.MeshLambertMaterial({ map: pixelTexture(THREE, map), ...opts });
    const grassTop = lambert(img.grass_block_top, { color: 0x91bd59 });
    const grassSide = lambert(img.grass_block_side);
    const logSide = lambert(img.oak_log);
    const logTop = lambert(img.oak_log_top);
    for (const [list, mat] of [
      [spots.sand, lambert(img.sand)],
      [spots.grass, [grassSide, grassSide, grassTop, grassSide, grassSide, grassSide]],
      [spots.log, [logSide, logSide, logTop, logTop, logSide, logSide]],
      [spots.leaves, lambert(img.oak_leaves, { color: 0x77ab2f, alphaTest: 0.5 })],
    ]) {
      const mesh = new THREE.InstancedMesh(box, mat, list.length);
      const m = new THREE.Matrix4();
      list.forEach(([x, y, z], i) => mesh.setMatrixAt(i, m.makeTranslation(x, y, z)));
      scene.add(mesh);
    }
  }

  /* The boat, and Steve sitting in it with his rod. */
  const boatGroup = new THREE.Group();
  {
    const skin = new THREE.MeshLambertMaterial({ map: pixelTexture(THREE, ent.boat_oak), alphaTest: 0.5, side: THREE.DoubleSide });
    const boat = buildModel(THREE, [{ material: skin, def: BOAT }]);
    // BoatRenderer: up 0.375, turned over (scale -1, -1, 1 after the half turn is a half turn about x),
    // a quarter turn about y, a pixel a sixteenth of a block.
    const holder = new THREE.Group();
    holder.scale.setScalar(1 / 16);
    holder.rotation.set(Math.PI, Math.PI / 2, 0);
    holder.position.y = 0.375;
    holder.add(boat.root);
    boatGroup.add(holder);
    // The water inside the hull is hidden, as the game's water patch hides it: depth only, no colour.
    const patch = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.5, 1.7), new THREE.MeshBasicMaterial({ colorWrite: false }));
    patch.position.y = 0.05;
    boatGroup.add(patch);
  }
  const BOAT_YAW = -0.25;
  boatGroup.position.set(BOAT_AT.x, 0, BOAT_AT.z);
  boatGroup.rotation.y = BOAT_YAW;
  scene.add(boatGroup);

  const steveSkin = new THREE.MeshLambertMaterial({ map: pixelTexture(THREE, ent.steve), alphaTest: 0.5, side: THREE.DoubleSide });
  const player = buildModel(THREE, [{ material: steveSkin, def: PLAYER }]);
  const steve = placeEntity(THREE, player, PLAYER_PIXEL);
  const P = player.parts;
  // Riding: HumanoidModel's sitting legs, forward and a little apart.
  P.rightLeg.rotation.set(-1.4137167, Math.PI / 10, 0.07853982, 'ZYX');
  P.leftLeg.rotation.set(-1.4137167, -Math.PI / 10, -0.07853982, 'ZYX');
  const SEAT_Y = -0.32;                  // the hips on the boat's floor
  steve.position.y = SEAT_Y;
  steve.rotation.y = Math.PI;            // facing -z, out over the water to the cast
  boatGroup.add(steve);
  /* His rod: the item side on, grip in the fist, tip forward and up. */
  const rodMount = new THREE.Group();
  rodMount.position.set(-1, 9.5, -0.5);
  rodMount.rotation.x = 0.35;
  P.rightArm.add(rodMount);
  const rodBasis = new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, -1, 0), new THREE.Vector3(-1, 0, 0));
  const ROD_SCALE = 16 * 0.85;
  const rodItem = new THREE.Group();
  rodItem.quaternion.setFromRotationMatrix(rodBasis);
  rodItem.scale.setScalar(ROD_SCALE);
  rodItem.position.copy(new THREE.Vector3(3.5 / 16 - 0.5, 0.5 - 12.5 / 16, 0).applyMatrix4(rodBasis).multiplyScalar(-ROD_SCALE));
  rodMount.add(rodItem);
  const rodModels = [rodImg, rodCastImg].map((source) => {
    const { geometry, material } = itemModel(THREE, source);
    const mesh = new THREE.Mesh(geometry, material);
    rodItem.add(mesh);
    return mesh;
  });
  const setRodCast = (cast) => { rodModels[0].visible = !cast; rodModels[1].visible = cast; };
  setRodCast(false);
  const rodTip = new THREE.Object3D();
  rodTip.position.set(14.5 / 16 - 0.5, 0.5 - 1.5 / 16, 0);
  rodItem.add(rodTip);

  /* ─────────── below the water ─────────── */

  /* The trench the lure goes down: built in slices of eight blocks as the camera reaches them, the
   * slices it has left far behind reused for the ones ahead. Each slice is three instanced meshes from
   * the one atlas -- its blocks, its plants (two crossed quads swaying in the current), and what lies
   * flat on a face (glow lichen, sculk veins) -- three draw calls a slice. */
  const SLICE = 8;
  const BOTTOM = 240;                    // the trench goes no further than the line ever does
  const VIEW_ABOVE = Math.round(20 * tier.view);
  const VIEW_BELOW = Math.round(40 * tier.view);
  const BLOCK_CAP = 2400;
  const PLANT_CAP = 900;
  const FACE_CAP = 300;
  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  const quadGeo = new THREE.PlaneGeometry(1, 1);
  /** An instanced mesh whose instances each carry an atlas tile and a glow. */
  function atlasMesh(base, material, cap) {
    const geometry = new THREE.BufferGeometry();
    geometry.setIndex(base.index);
    for (const name of ['position', 'normal', 'uv']) geometry.setAttribute(name, base.attributes[name]);
    const tiles = new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2);
    const glows = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
    tiles.setUsage(THREE.DynamicDrawUsage);
    glows.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aTile', tiles);
    geometry.setAttribute('aGlow', glows);
    const mesh = new THREE.InstancedMesh(geometry, material, cap);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.visible = false;
    return { mesh, tiles, glows };
  }
  const pool = [];
  const POOL_SIZE = Math.ceil((VIEW_ABOVE + VIEW_BELOW) / SLICE) + 3;
  for (let i = 0; i < POOL_SIZE; i += 1) {
    const blocks = atlasMesh(boxGeo, blockMat, BLOCK_CAP);
    const plants = atlasMesh(quadGeo, plantMat, PLANT_CAP);
    const faces = atlasMesh(quadGeo, faceMat, FACE_CAP);
    scene.add(blocks.mesh, plants.mesh, faces.mesh);
    pool.push({ index: null, blocks, plants, faces });
  }
  const pick = (list, r) => {
    let total = 0;
    for (const [, w] of list) total += w;
    let at = r * total;
    for (const [name, w] of list) {
      at -= w;
      if (at <= 0) return name;
    }
    return list[list.length - 1][0];
  };

  /* The structures, laid out once and handed to whichever slice holds them. */
  const structureBlocks = new Map();
  const structurePlants = new Map();
  const put = (map, x, y, z, tile, extra = {}) => {
    const s = Math.floor(-y / SLICE);
    if (!map.has(s)) map.set(s, []);
    map.get(s).push({ x, y, z, tile, ...extra });
  };
  const block = (x, y, z, tile) => put(structureBlocks, x, y, z, tile);
  const plantAt = (x, y, z, tile, extra) => put(structurePlants, x, y, z, tile, extra);
  const structureFaces = new Map();
  const yOf = (zoneId) => -ZONES.find((zone) => zone.id === zoneId).from;
  const extras = [];                     // what stands on its own: the wreck's chests, the city's lanterns
  {
    const rand = seeded(29);
    /* The shipwreck: a spruce hull on a stone shelf against the back wall, ribs showing, its mast
     * broken and leaning, two chests in the hold. */
    const wy = Math.round(yOf('wreck') - 9);
    for (let x = -12; x <= 10; x += 1) for (let z = -8; z <= -2; z += 1) block(x, wy - 1, z, rand() < 0.5 ? 'stone' : 'gravel');
    for (let x = -9; x <= 6; x += 1) {
      for (let z = -6; z <= -3; z += 1) if (rand() < 0.85) block(x, wy, z, 'spruce_planks');
      for (const z of [-7, -2]) {
        for (let h = 1; h <= 3; h += 1) if (rand() < (h === 3 ? 0.55 : 0.85)) block(x, wy + h, z, x % 3 === 0 ? 'stripped_spruce_log' : 'spruce_planks');
      }
      if (x % 3 === 0) for (let z = -6; z <= -3; z += 1) if (rand() < 0.5) block(x, wy + 3, z, 'spruce_log');
    }
    for (let z = -6; z <= -3; z += 1) for (let h = 1; h <= 2; h += 1) if (rand() < 0.7) block(7, wy + h, z, 'oak_planks');
    for (let h = 1; h <= 8; h += 1) block(-4 - Math.floor(h / 3), wy + h, -5, 'spruce_log');
    for (let x = -11; x <= 9; x += 1) if (rand() < 0.45) plantAt(x, wy, -2, rand() < 0.7 ? 'seagrass' : 'kelp');
    extras.push({ kind: 'chest', x: -1.2, y: wy + 1, z: -4.4, rot: 0.4 });
    extras.push({ kind: 'chest', x: 3.6, y: wy + 1, z: -4.6, rot: -0.3 });

    /* The ocean monument: dark prismarine pillars standing out of the wall, brick bands across them,
     * sea lanterns set in, the gold of its treasure room behind, a floor with sponges on it. */
    const my = Math.round(yOf('monument') - 6);
    for (const px of [-11, -6, 3, 8]) {
      for (let h = 0; h < 16; h += 1) {
        for (let dx = 0; dx < 2; dx += 1) {
          for (let dz = 0; dz < 2; dz += 1) block(px + dx, my - h, -5 + dz, h % 5 === 0 && dx === 0 && dz === 1 ? 'sea_lantern' : 'dark_prismarine');
        }
      }
    }
    for (let x = -12; x <= 11; x += 1) {
      block(x, my + 1, -5, 'prismarine_bricks');
      block(x, my - 7, -5, 'prismarine_bricks');
      if (x % 4 === 0) block(x, my - 7, -4, 'sea_lantern');
    }
    for (let x = -3; x <= 2; x += 1) for (let h = 9; h <= 13; h += 1) block(x, my - h, -6, h === 13 || x === -3 || x === 2 ? 'prismarine_bricks' : 'gold_block');
    for (let x = -12; x <= 11; x += 1) {
      for (let z = -7; z <= -3; z += 1) block(x, my - 17, z, z === -3 || x === -12 || x === 11 ? 'dark_prismarine' : 'prismarine_bricks');
    }
    for (let x = -10; x <= 9; x += 5) block(x, my - 16, -4, 'wet_sponge');

    /* The abyss: a geode broken open in the wall, amethyst round it; magma seams. */
    const ay = Math.round(yOf('abyss') - 10);
    for (let x = -10; x <= -2; x += 1) {
      for (let y = ay - 7; y <= ay; y += 1) {
        const d = Math.hypot(x + 6, y - ay + 3.5);
        if (d < 3.8) block(x, y, wallZ(x, y) + 1, d < 2.6 ? 'amethyst_block' : 'smooth_basalt');
        if (d >= 2.6 && d < 3.2 && rand() < 0.7) plantAt(x, y, wallZ(x, y) + 2, 'amethyst_cluster');
      }
    }

    /* The ancient city: a deepslate terrace across the trench round the shaft, the reinforced
     * deepslate frame at a city's heart, soul lanterns hung on iron bars, sculk over all of it. */
    const cy = Math.round(yOf('city') - 18);
    for (let x = -12; x <= 12; x += 1) {
      for (let z = -6; z <= 0; z += 1) {
        const top = Math.abs(x) <= 10 && z >= -5;
        block(x, cy, z, !top ? 'deepslate_tiles' : rand() < 0.35 ? 'sculk' : rand() < 0.5 ? 'deepslate_tiles' : 'polished_deepslate');
      }
      block(x, cy - 1, -6, 'chiseled_deepslate');
      if (rand() < 0.4) put(structureFaces, x, cy, 1, 'sculk_vein');
    }
    for (const side of [-1, 1]) {
      for (let h = 1; h <= 12; h += 1) {
        for (const dx of [0, 1]) block(side * (5 + dx), cy + h, -5, h % 4 === 0 ? 'chiseled_deepslate' : 'reinforced_deepslate_side');
      }
      for (let h = 9; h <= 12; h += 1) block(side * 4, cy + h, -5, 'reinforced_deepslate_side');
    }
    for (let x = -4; x <= 4; x += 1) block(x, cy + 13, -5, 'reinforced_deepslate_side');
    for (let x = -3; x <= 3; x += 1) block(x, cy + 14, -5, 'deepslate_tiles');
    for (const x of [-9, -4, 3, 9]) {
      const top = cy + 9 + Math.floor(rand() * 3);
      for (let y = cy + 3; y < top; y += 1) plantAt(x, y, -3, 'iron_bars');
      extras.push({ kind: 'lantern', x: x + 0.5, y: cy + 2.7, z: -2.5 });
    }
    for (let i = 0; i < 8; i += 1) {
      const x = Math.floor(rand() * 20 - 10);
      if (!inShaft(x, -1)) block(x, cy + 1, -1, rand() < 0.5 ? 'sculk_catalyst_side_bloom' : 'sculk');
    }
  }
  const CITY_FLOOR = Math.round(yOf('city') - 18);

  /** Fills a pooled slice with the trench between its top and bottom. */
  const sliceM = new THREE.Matrix4();
  const sliceQ = new THREE.Quaternion();
  const sliceP = new THREE.Vector3();
  const sliceS = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);
  function buildSlice(entry, index) {
    entry.index = index;
    const { blocks, plants, faces } = entry;
    let nb = 0;
    let np = 0;
    let nf = 0;
    const addBlock = (x, y, z, tile, glow = GLOWING[tile] ?? 0) => {
      if (nb >= BLOCK_CAP || inShaft(x, z)) return;
      blocks.mesh.setMatrixAt(nb, sliceM.makeTranslation(x + 0.5, y + 0.5, z + 0.5));
      const [u, v] = tileUv(tile);
      blocks.tiles.setXY(nb, u, v);
      blocks.glows.setX(nb, glow);
      nb += 1;
    };
    // A plant is two crossed quads, as the game draws a cross model.
    const addPlant = (x, y, z, tile) => {
      if (inShaft(x, z) || y >= 0) return;
      const [u, v] = tileUv(tile);
      for (const k of [0, 1]) {
        if (np >= PLANT_CAP) return;
        sliceP.set(x + 0.5, y + 0.5, z + 0.5);
        sliceQ.setFromAxisAngle(UP, Math.PI / 4 + k * Math.PI / 2);
        plants.mesh.setMatrixAt(np, sliceM.compose(sliceP, sliceQ, sliceS.set(1, 1, 1)));
        plants.tiles.setXY(np, u, v);
        plants.glows.setX(np, GLOWING[tile] ?? 0);
        np += 1;
      }
    };
    // What lies flat on the face of the block behind it, facing the trench.
    const addFace = (x, y, z, tile) => {
      if (nf >= FACE_CAP) return;
      faces.mesh.setMatrixAt(nf, sliceM.makeTranslation(x + 0.5, y + 0.5, z + 0.01));
      const [u, v] = tileUv(tile);
      faces.tiles.setXY(nf, u, v);
      faces.glows.setX(nf, GLOWING[tile] ?? 0);
      nf += 1;
    };
    const yTop = -index * SLICE;
    for (let r = 0; r < SLICE; r += 1) {
      const y = yTop - 1 - r;
      if (y > -3) continue;              // the top of the trench stays under the swell
      // Zone edges are ragged, a row or two either way.
      const zone = zoneAt(-y + (hash3(0, y, 3) - 0.5) * 4);
      const tileAt = (x, z) => pick(zone.wall, clamp01(noise2(x * 0.3 + z * 0.17 + 40, y * 0.3) * 0.82 + hash3(x, y, z) * 0.18));
      for (let x = -14; x <= 14; x += 1) {
        const zf = wallZ(x, y);
        let tile = tileAt(x, zf);
        if (zone.glow && hash3(x, y, 99) < 0.035) tile = pick(zone.glow, hash3(x, y, 98));
        addBlock(x, y, zf, tile);
        addBlock(x, y, zf - 1, tileAt(x, zf - 1));
        // A pocket in the wall now and then, with something growing in it, or lying on it.
        if (zone.plants.length && hash3(x, y, 5) < 0.1) addPlant(x, y, zf + 1, pick(zone.plants, hash3(x, y, 6)));
        if (zone.faces && hash3(x, y, 8) < 0.14) addFace(x, y, zf + 1, pick(zone.faces, hash3(x, y, 9)));
      }
      // The trench's side walls, ragged.
      for (const side of [-1, 1]) {
        for (let z = -9; z <= 6; z += 1) {
          const xw = side * (13 + Math.floor(noise2(z * 0.3 + side * 10, y * 0.2) * 3));
          addBlock(xw, y, z, tileAt(xw, z));
          if (zone.plants.length && hash3(xw, y, z) < 0.06) addPlant(xw - side, y, z, pick(zone.plants, hash3(z, y, xw)));
        }
      }
      // A shelf out of the wall every so often, with what grows at this depth on it.
      if (hash3(1, y, 2) < zone.shelves) {
        const x0 = Math.floor(hash3(2, y, 3) * 22) - 12;
        const w = 3 + Math.floor(hash3(3, y, 4) * 6);
        const reach = 2 + Math.floor(hash3(4, y, 5) * 3);
        for (let x = x0; x < x0 + w; x += 1) {
          const zf = wallZ(x, y);
          for (let z = zf + 1; z <= zf + reach; z += 1) {
            addBlock(x, y, z, tileAt(x, z));
            if (!zone.plants.length || hash3(x, y, z) > 0.65) continue;
            const name = pick(zone.plants, hash3(x, z, y));
            if (zone.kelp && name === 'kelp') {
              // A kelp stalk, up to ten blocks of it, its tip the kelp head.
              const tall = 3 + Math.floor(hash3(x, y, z + 1) * 8);
              for (let k = 1; k < tall; k += 1) addPlant(x, y + k, z, 'kelp_plant');
              addPlant(x, y + tall, z, 'kelp');
            } else if (name === 'tall_seagrass_bottom') {
              addPlant(x, y + 1, z, 'tall_seagrass_bottom');
              addPlant(x, y + 2, z, 'tall_seagrass_top');
            } else {
              addPlant(x, y + 1, z, name);
            }
          }
        }
      }
    }
    for (const b of structureBlocks.get(index) ?? []) addBlock(b.x, b.y, b.z, b.tile);
    for (const p of structurePlants.get(index) ?? []) addPlant(p.x, p.y, p.z, p.tile);
    for (const f of structureFaces.get(index) ?? []) if (!inShaft(f.x, f.z - 1)) addFace(f.x, f.y, f.z, f.tile);
    blocks.mesh.count = nb;
    plants.mesh.count = np;
    faces.mesh.count = nf;
    // Only the instances the slice uses go up to the GPU, not the pool's whole capacity.
    for (const [mesh, n] of [[blocks, nb], [plants, np], [faces, nf]]) {
      for (const [attribute, size] of [[mesh.mesh.instanceMatrix, 16], [mesh.tiles, 2], [mesh.glows, 1]]) {
        attribute.clearUpdateRanges();
        attribute.addUpdateRange(0, Math.max(1, n) * size);
        attribute.needsUpdate = true;
      }
    }
  }
  /** Builds the slices round height `y` that are missing, from the pool's entries furthest off. */
  function streamTrench(y, budget = 2) {
    const top = Math.max(0, Math.floor(-(y + VIEW_ABOVE) / SLICE));
    const bottom = Math.min(BOTTOM / SLICE, Math.floor(-(y - VIEW_BELOW) / SLICE));
    const have = new Set(pool.map((entry) => entry.index));
    let built = 0;
    for (let s = top; s <= bottom && built < budget; s += 1) {
      if (have.has(s)) continue;
      let entry = pool.find((e) => e.index === null);
      if (!entry) {
        entry = pool.reduce((far, e) => (Math.abs(e.index * SLICE + y) > Math.abs(far.index * SLICE + y) ? e : far), pool[0]);
        if (entry.index >= top && entry.index <= bottom) break;
      }
      buildSlice(entry, s);
      built += 1;
    }
    for (const entry of pool) {
      const shown = entry.index !== null && entry.index >= top - 1 && entry.index <= bottom + 1;
      for (const mesh of [entry.blocks.mesh, entry.plants.mesh, entry.faces.mesh]) mesh.visible = shown && mesh.count > 0;
    }
  }

  /* What stands on its own: the wreck's chests, the city's soul lanterns (LanternBlock's model). */
  const lanternTex = (x, y, w, h) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(img.soul_lantern, x, y, w, h, 0, 0, w, h);
    return pixelTexture(THREE, c);
  };
  const lanternSide = new THREE.MeshBasicMaterial({ map: lanternTex(0, 2, 6, 7), color: new THREE.Color(1.5, 2.1, 2.3), toneMapped: false });
  const lanternTop = new THREE.MeshLambertMaterial({ map: lanternTex(0, 9, 6, 6) });
  const soulLights = [];
  for (const extra of extras) {
    if (extra.kind === 'chest' && chestModel) {
      const chest = chestModel.group.clone(true);
      chest.position.set(extra.x, extra.y, extra.z);
      chest.rotation.y = extra.rot;
      scene.add(chest);
    } else if (extra.kind === 'lantern') {
      const PX = 1 / 16;
      const lantern = new THREE.Mesh(new THREE.BoxGeometry(6 * PX, 7 * PX, 6 * PX), [lanternSide, lanternSide, lanternTop, lanternTop, lanternSide, lanternSide]);
      lantern.position.set(extra.x, extra.y, extra.z);
      scene.add(lantern);
      if (soulLights.length < tier.lights - 1) {
        const light = new THREE.PointLight(0x55e0ff, 1.4, 9, 1.6);
        light.position.copy(lantern.position);
        scene.add(light);
        soulLights.push(light);
      }
    }
  }

  /* Light through the water: shafts of the low sun slanting down, fading with depth. */
  const shaftTex = (() => {
    const c = document.createElement('canvas');
    c.width = 32;
    c.height = 128;
    const g = c.getContext('2d');
    const across = g.createLinearGradient(0, 0, 32, 0);
    across.addColorStop(0, 'rgba(255,255,255,0)');
    across.addColorStop(0.5, 'rgba(255,255,255,1)');
    across.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = across;
    g.fillRect(0, 0, 32, 128);
    g.globalCompositeOperation = 'destination-in';
    const down = g.createLinearGradient(0, 0, 0, 128);
    down.addColorStop(0, 'rgba(0,0,0,1)');
    down.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = down;
    g.fillRect(0, 0, 32, 128);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const shafts = Array.from({ length: tier.name === 'low' ? 5 : 9 }, (_, i) => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2 + (i % 3), 44), new THREE.MeshBasicMaterial({
      map: shaftTex, color: 0xbfefff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      side: THREE.DoubleSide,
    }));
    mesh.renderOrder = 5;
    mesh.visible = false;
    scene.add(mesh);
    return { mesh, x: (i / 8 - 0.5) * 26 + Math.sin(i * 7.3) * 3, z: -4 + Math.cos(i * 3.1) * 5, phase: i * 1.7 };
  });
  let shaftsOn = true;

  /* The game's underwater overlay over the view, moving as the camera turns. */
  const overlayTex = pixelTexture(THREE, underwaterImg);
  overlayTex.wrapS = overlayTex.wrapT = THREE.RepeatWrapping;
  overlayTex.repeat.set(4, 4);
  const overlay = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
    map: overlayTex, transparent: true, opacity: 0, depthTest: false, depthWrite: false, fog: false, color: 0x9ad7ff,
  }));
  overlay.renderOrder = 999;
  overlay.position.z = -0.2;
  camera.add(overlay);

  /* ─────────── who lives down there ─────────── */

  const skin = (image, opts = {}) => new THREE.MeshLambertMaterial({ map: pixelTexture(THREE, image), alphaTest: 0.5, side: THREE.DoubleSide, ...opts });
  const creatureCount = (n) => Math.max(1, Math.round(n * tier.creatures));
  /* Schools of cod and salmon, circling at their depths. */
  const schools = [];
  for (const [kind, depth, count] of [['cod', 5, 7], ['cod', 22, 6], ['salmon', 42, 6], ['salmon', 62, 4]]) {
    const material = skin(ent[kind]);
    const fish = Array.from({ length: creatureCount(count) }, () => {
      const model = buildModel(THREE, [{ material, def: kind === 'cod' ? COD : SALMON }]);
      const entity = placeEntity(THREE, model, 1 / 16);
      scene.add(entity);
      return { model, entity, off: new THREE.Vector3((Math.random() - 0.5) * 3, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2), phase: Math.random() * 6 };
    });
    schools.push({ kind, depth, fish, speed: 0.35 + Math.random() * 0.2, a: Math.random() * 6.28, r: 6 + Math.random() * 3 });
  }
  /* Dolphins in the shallows, leaping clear of the swell while the boat waits. */
  const dolphinSkin = skin(ent.dolphin);
  const dolphins = Array.from({ length: creatureCount(2) }, (_, i) => {
    const model = buildModel(THREE, [{ material: dolphinSkin, def: DOLPHIN }]);
    const entity = placeEntity(THREE, model, 1 / 16);
    scene.add(entity);
    return { model, entity, phase: i * 2.9, r: 14 + i * 5, splashed: false };
  });
  /* Squid in the kelp, glow squid in the abyss: the glow squid drawn full bright, as the game does. */
  const squidSkin = skin(ent.squid);
  const glowSkin = new THREE.MeshBasicMaterial({ map: pixelTexture(THREE, ent.glow_squid), alphaTest: 0.5, side: THREE.DoubleSide, color: new THREE.Color(1.15, 1.35, 1.35), toneMapped: false });
  const squids = [];
  for (const [material, depth, count] of [[squidSkin, 44, 2], [squidSkin, 60, 1], [glowSkin, 108, 3], [glowSkin, 122, 2]]) {
    for (let i = 0; i < creatureCount(count); i += 1) {
      const model = buildModel(THREE, [{ material, def: SQUID }]);
      const entity = placeEntity(THREE, model, 1 / 16);
      entity.scale.setScalar(0.85);
      scene.add(entity);
      squids.push({ model, entity, depth: depth + i * 4, x: (Math.random() - 0.5) * 16, z: -2.5 + Math.random() * 2, phase: Math.random() * 6, glow: material === glowSkin });
    }
  }
  /* Guardians round the monument and down into the abyss, and the elder one in its treasure room. */
  const guardianSkin = skin(ent.guardian);
  const elderSkin = skin(ent.guardian_elder);
  const guardians = [];
  for (const [material, depth, x, size] of [[guardianSkin, 80, -6, 1], [guardianSkin, 90, 6, 1], [elderSkin, 97, -9, 2.35], [guardianSkin, 112, 7, 1]]) {
    if (guardians.length >= creatureCount(4)) break;
    const model = buildModel(THREE, [{ material, def: GUARDIAN }]);
    const entity = placeEntity(THREE, model, size / 16);
    scene.add(entity);
    guardians.push({ model, entity, depth, x, phase: Math.random() * 6 });
  }
  /* A drowned: what cuts a line in the upper waters. */
  const drowned = buildModel(THREE, [{ material: skin(ent.drowned), def: drownedModel(0) }, { material: skin(ent.drowned_outer_layer), def: drownedModel(0.25) }]);
  const drownedEntity = placeEntity(THREE, drowned, PLAYER_PIXEL);
  drownedEntity.visible = false;
  scene.add(drownedEntity);
  /* The warden on the city's terrace, its heart and its spots pulsing. */
  const wardenGlow = new THREE.MeshBasicMaterial({
    map: pixelTexture(THREE, ent.warden_bioluminescent_layer), transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending,
    depthWrite: false, toneMapped: false, color: new THREE.Color(1.4, 2, 2),
  });
  const wardenHeart = new THREE.MeshBasicMaterial({
    map: pixelTexture(THREE, ent.warden_heart), transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
    depthWrite: false, toneMapped: false, color: new THREE.Color(2, 2.4, 2.4),
  });
  const warden = buildModel(THREE, [{ material: skin(ent.warden), def: WARDEN }, { material: wardenGlow, def: WARDEN }, { material: wardenHeart, def: WARDEN }]);
  const wardenEntity = placeEntity(THREE, warden, 1 / 16);
  const WARDEN_HOME = new THREE.Vector3(4.5, CITY_FLOOR + 1, -3.5);
  wardenEntity.position.copy(WARDEN_HOME);
  wardenEntity.rotation.y = -0.6;
  scene.add(wardenEntity);

  /* ─────────── the lure, the line and the catch ─────────── */

  const hook = new THREE.Sprite(new THREE.SpriteMaterial({ map: pixelTexture(THREE, ent.fishing_hook), alphaTest: 0.5 }));
  hook.scale.set(0.5, 0.5, 0.5);
  hook.visible = false;
  scene.add(hook);
  /* The sinker under the hook: a feather, an iron block, or an anvil. */
  const sinkers = {};
  {
    const feather = itemModel(THREE, featherImg);
    sinkers.feather = new THREE.Mesh(feather.geometry, feather.material);
    sinkers.feather.scale.setScalar(0.45);
    sinkers.iron = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.32, 0.32), new THREE.MeshLambertMaterial({ map: pixelTexture(THREE, img.iron_block) }));
    const side = new THREE.MeshLambertMaterial({ map: pixelTexture(THREE, img.anvil) });
    const top = new THREE.MeshLambertMaterial({ map: pixelTexture(THREE, img.anvil_top) });
    // The anvil block's model: base, foot, waist and the wide working top.
    const anvil = new THREE.Group();
    const PX = 1 / 16;
    for (const [x0, y0, z0, x1, y1, z1] of [[2, 0, 2, 14, 4, 14], [4, 4, 3, 12, 5, 13], [6, 5, 4, 10, 10, 12], [3, 10, 0, 13, 16, 16]]) {
      const box = new THREE.Mesh(new THREE.BoxGeometry((x1 - x0) * PX, (y1 - y0) * PX, (z1 - z0) * PX), [side, side, top, side, side, side]);
      box.position.set(((x0 + x1) / 2 - 8) * PX, ((y0 + y1) / 2 - 8) * PX, ((z0 + z1) / 2 - 8) * PX);
      anvil.add(box);
    }
    anvil.scale.setScalar(0.4);
    sinkers.anvil = anvil;
    for (const mesh of Object.values(sinkers)) {
      mesh.visible = false;
      scene.add(mesh);
    }
  }
  let sinkerKind = SINKERS.includes(sinker) ? sinker : 'feather';

  /* The line: from the hook straight up to where it meets the water, then sagging to the rod's tip,
   * a ribbon turned to face the camera. */
  const LINE_POINTS = 24;
  const linePos = new Float32Array(LINE_POINTS * 2 * 3);
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.BufferAttribute(linePos, 3));
  {
    const index = [];
    for (let i = 0; i < LINE_POINTS - 1; i += 1) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    lineGeo.setIndex(index);
  }
  const fishingLine = new THREE.Mesh(lineGeo, new THREE.MeshBasicMaterial({ color: 0x101010, side: THREE.DoubleSide, transparent: true, opacity: 0.9 }));
  fishingLine.frustumCulled = false;
  fishingLine.visible = false;
  scene.add(fishingLine);
  const points = Array.from({ length: LINE_POINTS }, () => new THREE.Vector3());
  const tipWorld = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();
  const lineBottom = new THREE.Vector3();
  const lineEntry = new THREE.Vector3();
  const side = new THREE.Vector3();
  const toEye = new THREE.Vector3();
  let lineCut = null;                    // after a cut: where the line now ends, drifting up
  function drawLine(clock) {
    rodTip.getWorldPosition(tipWorld);
    if (lineCut) lineBottom.copy(lineCut);
    else lineBottom.copy(hook.position).setY(hook.position.y + 0.2);
    lineEntry.set(lineBottom.x, Math.min(0, lineBottom.y), lineBottom.z);
    const under = Math.max(0, -lineBottom.y);
    const split = under > 0.5 ? Math.round(LINE_POINTS * 0.7) : 0;
    for (let i = 0; i < LINE_POINTS; i += 1) {
      if (i < split) {
        const f = i / (split - 1);
        const drift = Math.sin(f * Math.PI) * Math.min(1.2, under * 0.02) * Math.sin(clock * 0.7 + f * 3);
        points[i].set(lerp(lineBottom.x, lineEntry.x, f) + drift, lerp(lineBottom.y, lineEntry.y, f), lineBottom.z);
      } else {
        const f = (i - split) / (LINE_POINTS - 1 - split);
        const from = split ? lineEntry : lineBottom;
        points[i].set(lerp(from.x, tipWorld.x, f), from.y + (tipWorld.y - from.y) * (f * f + f) * 0.5, lerp(from.z, tipWorld.z, f));
      }
    }
    for (let i = 0; i < LINE_POINTS; i += 1) {
      const a = points[i];
      if (i === LINE_POINTS - 1) tmp.subVectors(a, points[i - 1]);
      else tmp.subVectors(points[i + 1], a);
      toEye.copy(camera.position).sub(a);
      side.copy(tmp).cross(toEye).normalize().multiplyScalar(0.012 * Math.max(1, toEye.length() * 0.1));
      linePos.set([a.x - side.x, a.y - side.y, a.z - side.z, a.x + side.x, a.y + side.y, a.z + side.z], i * 6);
    }
    lineGeo.attributes.position.needsUpdate = true;
  }

  /* The items that can come up, extruded, the enchanted ones glinting. */
  const glintTex = (() => {
    const t = new THREE.CanvasTexture(glintImg);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.repeat.set(0.25, 0.25);
    t.center.set(0.5, 0.5);
    t.rotation = Math.PI / 18;
    return t;
  })();
  const itemParts = new Map();
  catches.forEach((id, i) => {
    const source = catchImgs[i];
    if (!source) return;
    const { geometry, material } = itemModel(THREE, source);
    let glint = null;
    if (GLINTS.has(id)) {
      const c = document.createElement('canvas');
      c.width = c.height = 16;
      const g = c.getContext('2d');
      g.imageSmoothingEnabled = false;
      g.drawImage(source, 0, 0, 16, 16);
      g.globalCompositeOperation = 'source-in';
      g.fillStyle = '#fff';
      g.fillRect(0, 0, 16, 16);
      glint = new THREE.MeshBasicMaterial({
        map: glintTex, alphaMap: pixelTexture(THREE, c), transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending,
        depthWrite: false, depthFunc: THREE.LessEqualDepth, fog: false,
      });
    }
    itemParts.set(id, { geometry, material, glint });
  });
  function itemMesh(id) {
    const parts = itemParts.get(id);
    const group = new THREE.Group();
    if (parts) {
      group.add(new THREE.Mesh(parts.geometry, parts.material));
      if (parts.glint) group.add(new THREE.Mesh(parts.geometry, parts.glint));
    }
    scene.add(group);
    return group;
  }

  /* ─────────── particles ─────────── */

  const sprites = [];
  const sprite = (map, opts) => {
    const s = makeSprites(THREE, { map, ...opts });
    scene.add(s.points);
    sprites.push(s);
    return s;
  };
  const bubbleSprites = sprite(pixelTexture(THREE, part.bubble), { count: scale(260) });
  const pops = sprite(atlas(THREE, [0, 1, 2, 3, 4].map((i) => part[`bubble_pop_${i}`]), 16, 5).map, { cols: 5, rows: 1, count: scale(40) });
  const splashes = sprite(atlas(THREE, [0, 1, 2, 3].map((i) => part[`splash_${i}`]), 8, 4).map, { cols: 4, rows: 1, count: scale(420) });
  const glows = sprite(pixelTexture(THREE, part.glow), { count: scale(160), additive: true });
  const sparkles = sprite(pixelTexture(THREE, part.glint), { count: scale(120) });
  const orbs = sprite(pixelTexture(THREE, ent.experience_orb), { cols: 4, rows: 4, count: scale(160), additive: true });
  const sparks = sprite(atlas(THREE, [0, 1, 2, 3, 4, 5, 6, 7].map((i) => part[`spark_${i}`]), 8, 8).map, { cols: 8, rows: 1, count: scale(600), additive: true });
  const souls = sprite(atlas(THREE, Array.from({ length: 11 }, (_, i) => part[`sculk_soul_${i}`]), 16, 4).map, { cols: 4, rows: 3, count: scale(60), additive: true });
  const booms = sprite(atlas(THREE, Array.from({ length: 16 }, (_, i) => part[`sonic_boom_${i}`]), 32, 4).map, { cols: 4, rows: 4, count: 40, additive: true });
  /* Marine snow: specks drifting in the light round the camera. */
  const SNOW = scale(500);
  const snowPos = new Float32Array(SNOW * 3);
  const snowGeo = new THREE.BufferGeometry();
  snowGeo.setAttribute('position', new THREE.BufferAttribute(snowPos, 3));
  for (let i = 0; i < SNOW; i += 1) snowPos.set([(Math.random() - 0.5) * 30, -Math.random() * 30, (Math.random() - 0.5) * 30], i * 3);
  const snowMat = new THREE.PointsMaterial({ map: softDot(), size: 0.09, transparent: true, opacity: 0, depthWrite: false, color: 0xdff6ff, blending: THREE.AdditiveBlending });
  const snow = new THREE.Points(snowGeo, snowMat);
  snow.frustumCulled = false;
  scene.add(snow);
  let snowOn = true;

  function splash(x, z, n, { spread = 0.3, up = 2.4 } = {}) {
    if (reduce) return;
    for (let i = 0; i < scale(n); i += 1) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * spread;
      splashes.emit({
        x: x + Math.cos(a) * r, y: 0.05, z: z + Math.sin(a) * r,
        vx: Math.cos(a) * (0.3 + Math.random() * 0.8), vy: up * (0.4 + Math.random() * 0.8), vz: Math.sin(a) * (0.3 + Math.random() * 0.8),
        gravity: -9, drag: 0.4, life: 0.5 + Math.random() * 0.4, size: 0.2, frame: Math.floor(Math.random() * 4), fade: 0.3,
      });
    }
  }
  function bubbles(x, y, z, n, spread = 0.3) {
    if (reduce) return;
    for (let i = 0; i < scale(n); i += 1) {
      bubbleSprites.emit({
        x: x + (Math.random() - 0.5) * spread, y: y + (Math.random() - 0.5) * spread, z: z + (Math.random() - 0.5) * spread,
        vx: (Math.random() - 0.5) * 0.2, vy: 0.9 + Math.random() * 1.1, vz: (Math.random() - 0.5) * 0.2,
        drag: 0.3, life: 1.2 + Math.random() * 1.4, size: 0.12 + Math.random() * 0.08, fade: 0.2,
      });
    }
  }
  function twinkle(at, n, spread = 0.6) {
    if (reduce) return;
    for (let i = 0; i < scale(n); i += 1) {
      sparkles.emit({
        x: at.x + (Math.random() - 0.5) * spread, y: at.y + (Math.random() - 0.5) * spread, z: at.z + (Math.random() - 0.5) * spread,
        vx: (Math.random() - 0.5) * 0.3, vy: 0.3 + Math.random() * 0.5, vz: (Math.random() - 0.5) * 0.3,
        drag: 0.6, life: 0.8 + Math.random() * 0.6, size: 0.14, sizeTo: 0.05, fade: 0.4,
      });
    }
  }
  function orbsTo(from, to, n, life = 0.9) {
    if (reduce) return;
    for (let i = 0; i < scale(n); i += 1) {
      const t = life * (0.7 + Math.random() * 0.5);
      const gravity = -5;
      const sx = from.x + (Math.random() - 0.5) * 0.5;
      const sz = from.z + (Math.random() - 0.5) * 0.5;
      orbs.emit({
        x: sx, y: from.y, z: sz, vx: (to.x - sx) / t, vy: (to.y - from.y) / t - 0.5 * gravity * t, vz: (to.z - sz) / t,
        gravity, life: t, size: 0.12 + Math.random() * 0.06, frame: Math.floor(Math.random() * 7), r: 0.7 + Math.random() * 0.3, g: 1, b: 0.2, fade: 0.15,
      });
    }
  }
  const STARS = [[1, 0.27, 0.27], [1, 0.62, 0.15], [0.5, 1, 0.25], [0.35, 0.8, 1], [1, 0.35, 1], [1, 0.95, 0.3]];
  function firework(x, y, z) {
    if (reduce) return;
    const [r, g, b] = STARS[Math.floor(Math.random() * STARS.length)];
    for (let i = 0; i < scale(80); i += 1) {
      const u = Math.random() * 2 - 1;
      const a = Math.random() * Math.PI * 2;
      const rr = Math.sqrt(1 - u * u);
      const speed = 5 + Math.random() * 2;
      sparks.emit({
        x, y, z, vx: Math.cos(a) * rr * speed, vy: u * speed, vz: Math.sin(a) * rr * speed,
        gravity: -2.5, drag: 1.6, life: 1.3 + Math.random() * 0.7, size: 0.45, frame: 7, frameTo: 0,
        r: r * 1.6, g: g * 1.6, b: b * 1.6, twinkle: true, fade: 0.45,
      });
    }
  }

  /* ─────────── the cast, step by step ─────────── */

  const SNAP_MS = 1300;
  const FALL_MS = 900;
  const RETURN_MS = 1300;
  const line = {
    phase: 'idle', t0: 0, from: new THREE.Vector3(), splashAt: new THREE.Vector3(),
    diveAt: 0, x100: 100, depth: 0, tierId: null, zone: ZONES[0],
    resolveCast: null, resolveReel: null, resolveSnap: null, item: null, itemId: null, result: null,
    ascentFrom: 0, ascentMs: 1200, shownAt: 0, cutter: null, fallFrom: 0, boomed: false, returnFrom: 0,
  };
  const npc = { cheerUntil: 0, sulkUntil: 0, swingAt: -1e9, swingMs: 320, hopStart: 0, hopUntil: 0 };
  const showAt = new THREE.Vector3(SHOW.x, SHOW.y, SHOW.z);
  const chestAt = new THREE.Vector3(BOAT_AT.x, 1.2, BOAT_AT.z);
  const fireworksDue = [];
  let onLine = null;
  let shake = 0;
  const settle = (which) => {
    const fn = line[which];
    line[which] = null;
    fn?.();
  };
  const setPhase = (phase, now) => {
    line.phase = phase;
    line.t0 = now;
  };
  function putOnLine(id) {
    if (onLine) scene.remove(onLine);
    onLine = id ? itemMesh(id) : null;
    if (onLine) onLine.scale.setScalar(0.5);
    line.tierId = id;
  }
  function clearShow() {
    if (line.item) scene.remove(line.item);
    line.item = null;
  }
  function hideLine() {
    hook.visible = false;
    fishingLine.visible = false;
    lineCut = null;
    putOnLine(null);
  }

  /** Each frame: the phases move on by the clock, whether or not the sea is on screen. */
  function stepLine(now) {
    const t = now - line.t0;
    switch (line.phase) {
      case 'cast': {
        const k = clamp01(t / (reduce ? 1 : 700));
        hook.position.lerpVectors(line.from, line.splashAt, easeOut(k));
        hook.position.y = lerp(line.from.y, 0, k) + Math.sin(k * Math.PI) * 2.2;
        if (k >= 1) {
          splash(line.splashAt.x, line.splashAt.z, 18, { up: 2.2 });
          controls.onCue?.('land');
          setPhase('plunge', now);
          settle('resolveCast');
        }
        break;
      }
      case 'plunge': {
        // Under, and down to where the dive begins; it waits there for the page's word.
        const k = clamp01(t / (reduce ? 1 : 500));
        hook.position.set(line.splashAt.x, lerp(0, LURE_TOP, easeOut(k)), line.splashAt.z);
        if (line.diveAt && now >= line.diveAt) {
          setPhase('dive', now);
          controls.onCue?.('dive');
        }
        break;
      }
      case 'dive':
        // The page moves the lure by the multiplier (`climb`).
        hook.position.set(line.splashAt.x, LURE_TOP - line.depth, line.splashAt.z);
        break;
      case 'ascend': {
        const k = clamp01(t / line.ascentMs);
        const y = lerp(line.ascentFrom, 0.2, easeInOut(k));
        hook.position.set(line.splashAt.x, y, line.splashAt.z);
        if (k >= 1) {
          // Out of the water and into the air over the boat.
          splash(line.splashAt.x, line.splashAt.z, 36, { up: 3.4, spread: 0.5 });
          controls.onCue?.('breach');
          hideLine();
          clearShow();
          line.item = itemMesh(line.itemId);
          line.item.position.set(line.splashAt.x, 0.3, line.splashAt.z);
          line.item.scale.setScalar(0.5);
          setRodCast(false);
          npc.swingAt = now;
          setPhase('fly', now);
        }
        break;
      }
      case 'fly': {
        const k = clamp01(t / (reduce ? 1 : 750));
        line.item.position.lerpVectors(tmp.set(line.splashAt.x, 0.3, line.splashAt.z), showAt, easeInOut(k));
        line.item.position.y += Math.sin(k * Math.PI) * 2.4;
        line.item.scale.setScalar(lerp(0.5, 1.1, easeOut(k)));
        line.item.rotation.y = k * 9;
        if (!reduce && Math.random() < 0.6) twinkle(line.item.position, 1, 0.2);
        if (k >= 1) {
          line.item.position.copy(showAt);
          line.shownAt = now;
          setPhase('show', now);
          celebrate(now);
          settle('resolveReel');
        }
        break;
      }
      case 'snap':
        // The cutter does its work (stepCutter); then the hook, cut loose, falls into the dark.
        if (t >= (reduce ? 1 : SNAP_MS)) {
          if (lineCut === null) cut();
          setPhase('fall', now);
        }
        break;
      case 'fall': {
        const k = clamp01(t / (reduce ? 1 : FALL_MS));
        hook.position.y = line.fallFrom - k * k * 6;
        if (lineCut) lineCut.y += 0.01;
        if (k >= 1) {
          hideLine();
          line.returnFrom = camera.position.y;
          setPhase('return', now);
        }
        break;
      }
      case 'return':
        // The camera rises back to the boat (frameShot); Steve takes it badly.
        if (t >= (reduce ? 1 : RETURN_MS)) {
          drownedEntity.visible = false;
          line.cutter = null;
          setRodCast(false);
          setPhase('idle', now);
          npc.sulkUntil = now + 1500;
          settle('resolveSnap');
        }
        break;
      case 'slack': {
        const k = clamp01(t / (reduce ? 1 : 400));
        rodTip.getWorldPosition(tipWorld);
        hook.position.lerpVectors(line.from, tipWorld, easeInOut(k));
        if (k >= 1) {
          hideLine();
          setRodCast(false);
          setPhase('idle', now);
          settle('resolveCast');
          settle('resolveReel');
        }
        break;
      }
      default:
    }
    for (let i = fireworksDue.length - 1; i >= 0; i -= 1) {
      if (now < fireworksDue[i].at) continue;
      const [f] = fireworksDue.splice(i, 1);
      camera.getWorldDirection(tmp).setY(0).normalize();
      firework(camera.position.x + tmp.x * f.ahead - tmp.z * f.across, f.up, camera.position.z + tmp.z * f.ahead + tmp.x * f.across);
      controls.onCue?.('firework');
    }
  }

  /** The catch is over the boat: how much it paid decides how glad Steve is. */
  function celebrate(now) {
    const x = (line.result?.x100 ?? 100) / 100;
    if (GLINTS.has(line.itemId) || line.result?.kind === 'treasure') twinkle(showAt, 18);
    orbsTo(showAt, chestAt, Math.min(14, 2 + Math.round(Math.log2(Math.max(1, x)) * 3)));
    if (x >= 2) {
      npc.hopStart = now;
      npc.hopUntil = now + (x >= 10 ? 2400 : 900);
    }
    if (x >= 5) {
      const count = x >= 100 ? 7 : x >= 25 ? 5 : x >= 10 ? 3 : 1;
      for (let i = 0; i < count; i += 1) {
        fireworksDue.push({ at: now + 250 + i * 380 + Math.random() * 200, ahead: 16 + Math.random() * 8, across: (Math.random() - 0.5) * 14, up: 5 + Math.random() * 4 });
      }
    }
    if (x >= 10) {
      npc.cheerUntil = now + 2400;
      shake = 0.6;
    }
  }

  /* The cutter at work: a drowned grabbing the line, a guardian's beam, the warden's sonic boom. */
  const beamTex = pixelTexture(THREE, ent.guardian_beam);
  beamTex.wrapS = beamTex.wrapT = THREE.RepeatWrapping;
  const beamMat = new THREE.MeshBasicMaterial({ map: beamTex, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
  const beam = new THREE.Mesh(new THREE.BoxGeometry(0.25, 1, 0.25), beamMat);
  beam.visible = false;
  scene.add(beam);
  function cut() {
    lineCut = hook.position.clone().setY(hook.position.y + 1.2);
    shake = Math.max(shake, 0.8);
    bubbles(hook.position.x, hook.position.y, hook.position.z, 30, 0.6);
    pops.emit({ x: hook.position.x, y: hook.position.y + 0.3, z: hook.position.z, life: 0.5, size: 0.6, frame: 0, frameTo: 4 });
    line.fallFrom = hook.position.y;
    controls.onCue?.('cut');
  }
  function stepCutter(now, clock) {
    beam.visible = false;
    const cutting = line.phase === 'snap';
    if (line.cutter === 'warden' && (cutting || line.phase === 'fall')) {
      // Up out of the dark beside the lure, then its sonic boom along the line.
      const lure = hook.position;
      const t = cutting ? (now - line.t0) / SNAP_MS : 1;
      const k = easeOut(clamp01(t / 0.3));
      wardenEntity.position.set(lure.x - 4.4, lerp(line.fallFrom - 10, line.fallFrom - 2.6, k), lure.z - 1.2);
      wardenEntity.rotation.y = Math.PI / 2;
      if (cutting && !line.boomed && t > 0.4) {
        line.boomed = true;
        const from = tmp.copy(wardenEntity.position).add(tmp2.set(0.6, 2.2, 0));
        for (let i = 0; i < 10; i += 1) {
          const f = i / 9;
          booms.emit({
            x: lerp(from.x, lure.x, f), y: lerp(from.y, lure.y, f), z: lerp(from.z, lure.z, f),
            life: 0.45 + f * 0.25, size: 1.6, frame: 0, frameTo: 15, fade: 0.2, fadeIn: f * 0.5,
          });
        }
        controls.onCue?.('boom');
      }
      if (cutting && t > 0.6 && lineCut === null) cut();
      return;
    }
    if (!cutting) return;
    const t = (now - line.t0) / SNAP_MS;
    const lure = hook.position;
    if (line.cutter === 'drowned') {
      // In from the side, a grab at the line, and off down into the dark.
      drownedEntity.visible = true;
      const k = easeOut(Math.min(1, t / 0.45));
      drownedEntity.position.lerpVectors(tmp.set(lure.x - 5, lure.y - 1.8, lure.z + 1), tmp2.set(lure.x - 0.7, lure.y - 1.5, lure.z + 0.2), k);
      if (t > 0.6) drownedEntity.position.y -= (t - 0.6) * 4;
      drownedEntity.rotation.set(0, Math.PI / 2, 0);
      // ZombieModel's arms out in front, raised for the grab; the legs kicking.
      const reach = t > 0.45 ? 0.6 : 0;
      drowned.parts.rightArm.rotation.x = -Math.PI / 2 - reach;
      drowned.parts.leftArm.rotation.x = -Math.PI / 2 - reach;
      drowned.parts.rightLeg.rotation.x = Math.sin(clock * 9) * 0.5;
      drowned.parts.leftLeg.rotation.x = -Math.sin(clock * 9) * 0.5;
      if (t > 0.45 && lineCut === null) cut();
    } else if (line.cutter === 'guardian' && guardians[0]) {
      // A guardian come for it: its eye on the lure, its beam charging purple to gold.
      const g = guardians[0];
      present(g.entity, true);
      g.entity.position.set(lure.x - 4.5, lure.y - 0.2, lure.z + 1.2);
      g.entity.rotation.y = Math.PI / 2;
      poseGuardian(g.model.parts, clock * 20, 0, 0, 0, clock * 4);
      if (t < 0.75) {
        const eye = tmp.copy(g.entity.position).add(tmp2.set(0.5, 0.5, 0));
        beam.visible = true;
        beam.position.lerpVectors(eye, lure, 0.5);
        beam.lookAt(lure);
        beam.rotateX(Math.PI / 2);
        beam.scale.set(1, eye.distanceTo(lure), 1);
        // GuardianRenderer's beam colour: (64, 32, 128) to (255, 223, 64) as it charges.
        const charge = Math.min(1, t / 0.6);
        beamMat.color.setRGB(((64 + charge * 191) / 255) * 1.6, ((32 + charge * 191) / 255) * 1.6, ((128 - charge * 64) / 255) * 1.6);
        beamTex.offset.y = -clock * 2;
      }
      if (t > 0.6 && lineCut === null) cut();
    }
  }

  /* ─────────── each frame: the sea, the deep and who lives in it ─────────── */

  const SKY_FOG = new THREE.Color(0xd8a98c);
  const zoneFog = new THREE.Color();
  let underwater = false;
  /** The light at a depth: the zone's, blended into the next zone's over the last part of it. */
  function lightAt(depth) {
    const zone = zoneAt(depth);
    const next = ZONES[Math.min(ZONES.length - 1, ZONES.indexOf(zone) + 1)];
    const span = next === zone ? 1 : next.from - zone.from;
    const k = next === zone ? 0 : clamp01((depth - zone.from - span * 0.6) / (span * 0.4));
    zoneFog.copy(zone.c.fog).lerp(next.c.fog, k);
    hemi.color.copy(zone.c.sky).lerp(next.c.sky, k);
    hemi.groundColor.copy(zone.c.ground).lerp(next.c.ground, k);
    hemi.intensity = lerp(zone.hemi[2], next.hemi[2], k);
    return { zone, density: lerp(zone.density, next.density, k), beam: lerp(zone.beam, next.beam, k), caustic: lerp(zone.caustic, next.caustic, k) };
  }
  function stepWorld(now, dt, clock) {
    const depth = -camera.position.y;
    const wasUnder = underwater;
    underwater = camera.position.y < waveAt(camera.position.x, camera.position.z, clock) - 0.05;
    if (underwater !== wasUnder) controls.onUnderwater?.(underwater);
    if (underwater) {
      const lit = lightAt(Math.max(0, depth));
      // The warden's darkness: the water closing in, pulsing, while it is roused.
      const dark = line.cutter === 'warden' && (line.phase === 'snap' || line.phase === 'fall') ? 1.6 + Math.sin(clock * 6) * 0.4 : 1;
      scene.fog.color.copy(zoneFog);
      scene.fog.density = (lit.density / tier.view) * dark;
      sunLight.intensity = 1.6 * lit.beam;
      sunLight.color.set(0x9fe6ff);
      sea.uCaustic.value = reduce ? 0 : lit.caustic;
      renderer.setClearColor(zoneFog, 1);
      sky.visible = false;
      sunDisc.visible = false;
      sunGlow.visible = false;
      clouds.visible = depth < 6;
      overlay.material.opacity = 0.16;
      snow.visible = snowOn;
      snowMat.color.setRGB(...lit.zone.snow);
      snowMat.opacity = 0.55;
      for (const shaft of shafts) {
        shaft.mesh.visible = shaftsOn && lit.beam > 0.02;
        if (!shaft.mesh.visible) continue;
        shaft.mesh.position.set(camera.position.x * 0.2 + shaft.x, -22, shaft.z);
        shaft.mesh.rotation.set(0, Math.atan2(camera.position.x - shaft.mesh.position.x, camera.position.z - shaft.mesh.position.z), 0.32);
        shaft.mesh.material.opacity = (reduce ? 0.12 : 0.1 + Math.sin(clock * 0.6 + shaft.phase) * 0.05) * lit.beam;
      }
    } else {
      scene.fog.color.copy(SKY_FOG);
      scene.fog.density = 0.0045;
      hemi.color.set(0xffe0c2);
      hemi.groundColor.set(0x30405a);
      hemi.intensity = 1.25;
      sunLight.intensity = 2.3;
      sunLight.color.set(0xffc08a);
      sea.uCaustic.value = 0;
      sky.visible = true;
      sunDisc.visible = true;
      sunGlow.visible = true;
      clouds.visible = true;
      overlay.material.opacity = 0;
      snow.visible = false;
      for (const shaft of shafts) shaft.mesh.visible = false;
    }
    // The lure's lantern: hardly there in daylight, the only light in the deep.
    const lureDepth = -hook.position.y;
    lureLight.position.copy(hook.position).add(tmp.set(0.2, 0.5, 0.8));
    lureLight.intensity = hook.visible && lureDepth > 2 ? 4 + Math.min(10, lureDepth / 12) : 0;
    lureLight.color.set(lureDepth > ZONES[6].from - 10 ? 0xa8f4ff : 0xffe0b0);
    // The marine snow falls slowly through the water round the camera.
    if (snow.visible) {
      const c = camera.position;
      for (let i = 0; i < SNOW; i += 1) {
        const j = i * 3;
        let x = snowPos[j] + Math.sin(clock * 0.3 + i) * dt * 0.1;
        let y = snowPos[j + 1] - dt * 0.25;
        let z = snowPos[j + 2];
        if (x < c.x - 15) x += 30; else if (x > c.x + 15) x -= 30;
        if (y < c.y - 15) y += 30; else if (y > c.y + 15) y -= 30;
        if (z < c.z - 15) z += 30; else if (z > c.z + 15) z -= 30;
        snowPos[j] = x; snowPos[j + 1] = y; snowPos[j + 2] = z;
      }
      snowGeo.attributes.position.needsUpdate = true;
    }
    // The boat rides the swell.
    boatGroup.position.y = waveAt(BOAT_AT.x, BOAT_AT.z, clock);
    boatGroup.rotation.z = (waveAt(BOAT_AT.x + 1, BOAT_AT.z, clock) - boatGroup.position.y) * 0.6;
    boatGroup.rotation.x = (waveAt(BOAT_AT.x, BOAT_AT.z + 1, clock) - boatGroup.position.y) * 0.4;
  }

  const near = (y, range) => Math.abs(y - camera.position.y) < range;
  /** In the scene only while it can be seen: out of the graph, a creature costs nothing a frame --
   * no matrices to update, no list to sort it out of. */
  const present = (object, show) => {
    if (show && object.parent !== scene) scene.add(object);
    else if (!show && object.parent === scene) scene.remove(object);
    object.visible = show;
  };
  function stepCreatures(dt, clock) {
    for (const school of schools) {
      const y = -school.depth;
      const show = near(y, 32);
      for (const f of school.fish) present(f.entity, show);
      if (!show) continue;
      school.a += school.speed * dt;
      const cx = Math.cos(school.a) * school.r;
      const cz = -1 + Math.sin(school.a) * 2.5;
      const heading = Math.atan2(-Math.sin(school.a) * school.r, Math.cos(school.a) * 2.5);
      for (const f of school.fish) {
        f.entity.position.set(cx + f.off.x + Math.sin(clock * 1.3 + f.phase) * 0.2, y + f.off.y + Math.sin(clock + f.phase) * 0.15, cz + f.off.z);
        f.entity.rotation.y = heading;
        if (school.kind === 'cod') poseCod(f.model.parts, clock * 20 + f.phase);
        else poseSalmon(f.model.parts, clock * 20 + f.phase);
      }
    }
    for (const d of dolphins) {
      const show = near(-3, 26);
      present(d.entity, show);
      if (!show) continue;
      const a = clock * 0.35 + d.phase;
      const x = Math.cos(a) * d.r;
      const z = -10 + Math.sin(a) * d.r * 0.6;
      const leap = Math.max(0, Math.sin(a * 3.1)) ** 6;
      d.entity.position.set(x, -2.2 + leap * 3.6, z);
      d.entity.rotation.y = Math.atan2(-Math.sin(a) * d.r, Math.cos(a) * d.r * 0.6);
      poseDolphin(d.model.parts, clock * 20 + d.phase, -Math.cos(a * 3.1) * leap * 0.8);
      const out = leap > 0.18;
      if (out !== d.splashed) {
        d.splashed = out;
        splash(x, z, 8, { up: 1.8 });
      }
    }
    for (const s of squids) {
      const y = -s.depth + Math.sin(clock * 0.5 + s.phase) * 1.5;
      const show = near(y, 30);
      present(s.entity, show);
      if (!show) continue;
      s.entity.position.set(s.x + Math.sin(clock * 0.2 + s.phase) * 2, y, s.z);
      s.entity.rotation.y = clock * 0.15 + s.phase;
      poseSquid(s.model.parts, (Math.sin(clock * 2 + s.phase) * 0.5 + 0.5) * 0.9);
      if (s.glow && !reduce && Math.random() < dt * 6) {
        glows.emit({
          x: s.entity.position.x + (Math.random() - 0.5) * 1.2, y: y + Math.random() * 1.2, z: s.z + (Math.random() - 0.5) * 1.2,
          vy: 0.1, life: 1.2 + Math.random(), size: 0.18, r: 0.6, g: 1.4, b: 1.3, fadeIn: 0.3, fade: 0.5,
        });
      }
    }
    for (const g of guardians) {
      if (line.phase === 'snap' && line.cutter === 'guardian' && g === guardians[0]) continue;
      const y = -g.depth + Math.sin(clock * 0.4 + g.phase) * 1.2;
      const show = near(y, 34);
      present(g.entity, show);
      if (!show) continue;
      const sway = Math.sin(clock * 0.25 + g.phase);
      g.entity.position.set(g.x + sway * 3, y, -2 + Math.cos(clock * 0.2 + g.phase));
      g.entity.rotation.y = Math.cos(clock * 0.25 + g.phase) > 0 ? Math.PI / 2 : -Math.PI / 2;
      poseGuardian(g.model.parts, clock * 20 + g.phase * 10, 0.5 + Math.sin(clock + g.phase) * 0.5, Math.sin(clock * 0.7) * 2, 0, clock * 2);
    }
    const roused = line.cutter === 'warden' && (line.phase === 'snap' || line.phase === 'fall');
    const showWarden = roused || near(CITY_FLOOR, 36);
    present(wardenEntity, showWarden);
    if (showWarden) {
      if (!roused) {
        wardenEntity.position.copy(WARDEN_HOME);
        wardenEntity.rotation.y = -0.3 + Math.sin(clock * 0.3) * 0.3;
      }
      // Its heart beats and its tendrils twitch, both faster when it is roused.
      const beat = Math.max(0, Math.sin(clock * (roused ? 9 : 3)));
      wardenHeart.opacity = beat * 0.9;
      wardenGlow.opacity = 0.55 + beat * 0.3;
      const twitch = Math.sin(clock * 6) * (roused ? 0.45 : 0.1);
      warden.parts.leftTendril.rotation.x = twitch;
      warden.parts.rightTendril.rotation.x = -twitch;
      warden.parts.rightArm.rotation.x = Math.sin(clock * 1.1) * 0.08 - (roused ? 0.5 : 0);
      warden.parts.leftArm.rotation.x = -Math.sin(clock * 1.1) * 0.08 - (roused ? 0.5 : 0);
      if (!reduce && !roused && Math.random() < dt * 3) {
        souls.emit({ x: (Math.random() - 0.5) * 20, y: CITY_FLOOR + 1.2, z: -4 + Math.random() * 4, vy: 0.5 + Math.random() * 0.4, life: 1.6, size: 0.4, frame: 0, frameTo: 10, fade: 0.3 });
      }
    }
    // Bubbles off the magma in the abyss.
    if (!reduce && underwater && zoneAt(-camera.position.y).id === 'abyss' && Math.random() < dt * 8) {
      bubbles((Math.random() - 0.5) * 18, camera.position.y - 6 - Math.random() * 10, -5 + Math.random() * 2, 2, 0.4);
    }
  }

  /* Steve: the cast, how he takes a catch, and how he takes a cut line. */
  function stepSteve(now, clock) {
    const s = (now - npc.swingAt) / npc.swingMs;
    // Riding, both arms come forward a fifth of a turn; the rod arm raised further while the line is out.
    let armX = -Math.PI / 5 - (hook.visible ? 0.45 : 0.15) + (reduce ? 0 : Math.sin(clock * 1.3) * 0.04);
    if (s >= 0 && s < 1) armX -= Math.sin(s * Math.PI) * 1.3;
    const cheering = now < npc.cheerUntil && !reduce;
    P.rightArm.rotation.x = armX;
    P.leftArm.rotation.x = cheering ? -2.7 + Math.sin(clock * 14) * 0.35 : -Math.PI / 5;
    P.leftArm.rotation.z = cheering ? -0.25 : 0;
    const sulking = now < npc.sulkUntil;
    P.head.rotation.x = sulking ? 0.6 : 0.25;
    P.head.rotation.y = sulking && !reduce ? Math.sin((now / 1000) * 12) * 0.25 : 0;
    const hop = now < npc.hopUntil && !reduce ? Math.abs(Math.sin(((now - npc.hopStart) / 1000) * Math.PI * 2.4)) * 0.3 : 0;
    steve.position.y = SEAT_Y + hop;
  }

  /* ─────────── the camera ─────────── */

  const cam = { pos: new THREE.Vector3(), look: new THREE.Vector3() };
  const goalPos = new THREE.Vector3();
  const goalLook = new THREE.Vector3();
  const drag = { on: false, x: 0, y: 0, yaw: 0, pitch: 0, baseYaw: 0, basePitch: 0, id: null };
  let hoverX = 0;
  let hoverY = 0;
  const hover = { x: 0, y: 0 };
  let framed = false;
  function frameShot(now, clock) {
    const narrow = camera.aspect < 1.2 ? Math.min(1.8, 1.2 / camera.aspect) : 1;
    const lure = hook.position;
    switch (line.phase) {
      case 'cast':
        goalLook.set(lerp(BOAT_AT.x, lure.x, 0.6), 1, lerp(BOAT_AT.z, lure.z, 0.6));
        goalPos.set(BOAT_AT.x + 7 * narrow, 3.4, BOAT_AT.z + 7 * narrow);
        break;
      case 'plunge':
      case 'dive':
      case 'snap':
      case 'fall': {
        const wide = line.phase === 'snap' || line.phase === 'fall' ? 1.4 : 1;
        const y = line.phase === 'fall' ? line.fallFrom - 1.4 : lure.y - 0.6;
        const sway = reduce ? 0 : Math.sin(clock * 0.31) * 0.8;
        goalLook.set(lure.x, y, lure.z);
        goalPos.set(lure.x + (1.9 + sway) * wide * narrow, y + 1.1 * wide, lure.z + 5.6 * wide * narrow);
        break;
      }
      case 'ascend':
        goalLook.set(lure.x, lure.y + 1.4, lure.z);
        goalPos.set(lure.x + 1.7 * narrow, Math.min(-0.4, lure.y - 0.3), lure.z + 4.8 * narrow);
        break;
      case 'return': {
        // Straight back up to the boat, quickly: the deep goes by in a rush.
        const k = easeInOut(clamp01((now - line.t0) / RETURN_MS));
        const y = lerp(line.returnFrom, 2.6, k);
        goalLook.set(lerp(0, BOAT_AT.x + 0.4, k), y - lerp(1.4, 1.5, k), lerp(0, BOAT_AT.z - 2.2, k));
        goalPos.set(lerp(2.4 * narrow, BOAT_AT.x + Math.sin(0.6) * 8.5 * narrow, k), y, lerp(7.2 * narrow, BOAT_AT.z + Math.cos(0.6) * 8.5 * narrow, k));
        cam.pos.copy(goalPos);
        cam.look.copy(goalLook);
        break;
      }
      case 'fly':
      case 'show':
        goalLook.copy(showAt).add(tmp.set(-0.4, -0.4, 0));
        goalPos.copy(showAt).add(tmp.set(4.4 * narrow, 0.9, 3.4 * narrow));
        break;
      default: {
        // The boat on the sunset sea, the camera drifting slowly round it.
        const a = (reduce ? 0 : clock * 0.04) + 0.6;
        goalLook.set(BOAT_AT.x + 0.4, 1.1, BOAT_AT.z - 2.2);
        goalPos.set(BOAT_AT.x + Math.sin(a) * 8.5 * narrow, 2.6, BOAT_AT.z + Math.cos(a) * 8.5 * narrow);
      }
    }
  }
  const onMove = (event) => {
    const b = canvas.getBoundingClientRect();
    if (!b.width) return;
    hoverX = ((event.clientX - b.left) / b.width - 0.5) * 2;
    hoverY = ((event.clientY - b.top) / b.height - 0.5) * 2;
    if (drag.on && event.pointerId === drag.id) {
      drag.yaw = THREE.MathUtils.clamp(drag.baseYaw - (event.clientX - drag.x) * 0.004, -0.9, 0.9);
      drag.pitch = THREE.MathUtils.clamp(drag.basePitch + (event.clientY - drag.y) * 0.0025, -0.3, 0.45);
    }
  };
  const onLeave = () => { hoverX = 0; hoverY = 0; };
  const onDown = (event) => {
    Object.assign(drag, { on: true, x: event.clientX, y: event.clientY, baseYaw: drag.yaw, basePitch: drag.pitch, id: event.pointerId });
    try { canvas.setPointerCapture(event.pointerId); } catch { /* a synthetic event has no capture */ }
  };
  const onUp = () => { drag.on = false; };
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  let lost = false;
  const onLost = (event) => { event.preventDefault(); lost = true; controls.onLost?.(); };
  canvas.addEventListener('webglcontextlost', onLost);

  /* ── the sea mirrors the sky: caught once into a cube from just above the water ── */
  let envTarget = null;
  function mirrorSky() {
    if (!tier.mirror) return;
    try {
      envTarget = new THREE.WebGLCubeRenderTarget(128, { type: THREE.HalfFloatType });
      const cubeCam = new THREE.CubeCamera(0.5, 300, envTarget);
      for (const eye of cubeCam.children) eye.layers.set(1);
      for (const object of [sky, sunDisc, sunGlow, clouds]) object.layers.enable(1);
      cubeCam.position.set(0, 1, 0);
      placeSun(cubeCam.position);
      cubeCam.update(renderer, scene);
      seaMat.envMap = envTarget.texture;
      seaMat.needsUpdate = true;
    } catch {
      envTarget = null;                  // no mirror is still a sea
    }
  }

  /* ── framing, resolution, and stepping down on a machine that cannot keep up ── */
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
    () => { snowOn = false; shaftsOn = false; },
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
    // The underwater overlay fills the view at its distance.
    const vh = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 0.2;
    overlay.scale.set(vh * camera.aspect * 1.02, vh * 1.02, 1);
    return true;
  }

  /* ── one frame ── */
  let raf = 0;
  let last = performance.now();
  let clock = 0;
  function frame() {
    raf = requestAnimationFrame(frame);
    const now = performance.now();
    // The cast goes on by the clock even off screen, so the page is never left waiting on it.
    stepLine(now);
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
    const resized = resize();
    sea.uTime.value = reduce ? 0 : clock;
    showWaterFrame(reduce ? 0 : Math.floor(clock * 10) % WATER_FRAMES);
    stepAtlas(clock);
    driftClouds(clock);

    frameShot(now, clock);
    if (!framed || reduce) {
      cam.pos.copy(goalPos);
      cam.look.copy(goalLook);
      framed = true;
    } else {
      const rate = line.phase === 'ascend' ? 14 : line.phase === 'dive' || line.phase === 'plunge' ? 5 : 2.2;
      const k = 1 - Math.exp(-dt * rate);
      cam.pos.lerp(goalPos, k);
      cam.look.lerp(goalLook, k);
    }
    if (!drag.on) {
      drag.yaw *= 0.97;
      drag.pitch *= 0.97;
    }
    hover.x += (hoverX - hover.x) * Math.min(1, dt * 3);
    hover.y += (hoverY - hover.y) * Math.min(1, dt * 3);
    // The drag and the pointer turn the camera round what it is looking at.
    tmp.subVectors(cam.pos, cam.look);
    const dist = tmp.length();
    const yaw = Math.atan2(tmp.x, tmp.z) + drag.yaw + (reduce ? 0 : hover.x * 0.05);
    const pitch = Math.asin(THREE.MathUtils.clamp(tmp.y / dist, -0.99, 0.99)) + drag.pitch + (reduce ? 0 : hover.y * 0.03);
    camera.position.set(
      cam.look.x + Math.sin(yaw) * Math.cos(pitch) * dist,
      cam.look.y + Math.sin(pitch) * dist,
      cam.look.z + Math.cos(yaw) * Math.cos(pitch) * dist,
    );
    if (shake > 0.01 && !reduce) {
      camera.position.x += (Math.random() - 0.5) * shake * 0.12;
      camera.position.y += (Math.random() - 0.5) * shake * 0.12;
    }
    shake *= Math.exp(-dt * 3);
    camera.lookAt(cam.look);
    overlayTex.offset.set((-yaw / Math.PI) * 2, (pitch / Math.PI) * 2);
    placeSun(camera.position);

    streamTrench(camera.position.y, line.phase === 'ascend' || line.phase === 'return' ? 3 : 1);
    stepWorld(now, dt, clock);
    stepCreatures(dt, clock);
    stepCutter(now, clock);
    stepSteve(now, clock);
    // The lure: the sinker under the hook, the catch so far hanging beside it, bubbles as it goes down.
    const lureOut = hook.visible && line.phase !== 'cast' && line.phase !== 'slack' && line.phase !== 'fall';
    for (const [kind, mesh] of Object.entries(sinkers)) mesh.visible = lureOut && kind === sinkerKind;
    const sinkerMesh = sinkers[sinkerKind];
    if (sinkerMesh.visible) {
      sinkerMesh.position.copy(hook.position).add(tmp.set(0, -0.45, 0));
      sinkerMesh.rotation.y += dt * (sinkerKind === 'feather' ? 1.2 : 0.4);
      if (sinkerKind === 'feather') sinkerMesh.rotation.z = Math.sin(clock * 2) * 0.4;
    }
    if (onLine && (line.phase === 'dive' || line.phase === 'snap' || line.phase === 'ascend')) {
      onLine.position.copy(hook.position).add(tmp.set(0.35, -0.2, 0.15));
      onLine.rotation.y += dt * 2;
    }
    if (line.phase === 'dive' && !reduce && Math.random() < dt * 9) bubbles(hook.position.x, hook.position.y - 0.4, hook.position.z, 1, 0.2);
    if (fishingLine.visible) drawLine(clock);
    if (line.phase === 'show' && line.item) {
      line.item.rotation.y += reduce ? 0 : dt;
      line.item.position.y = SHOW.y + (reduce ? 0 : Math.sin(((now - line.shownAt) / 1000) * 2) * 0.06);
    }
    if (!reduce) glintTex.offset.set(-((now * 8) % 110000) / 110000, ((now * 8) % 30000) / 30000);
    for (const s of sprites) s.step(dt);

    if (composer) composer.render(dt);
    else renderer.render(scene, camera);
  }

  // Every material compiled now, and the sea's mirror caught, so the first cast does not stall.
  resize();
  driftClouds(0);
  streamTrench(2.6, POOL_SIZE);
  mirrorSky();
  {
    const warm = catches.map((id) => itemMesh(id));
    const hidden = [];
    scene.traverse((object) => {
      if (!object.visible) {
        hidden.push(object);
        object.visible = true;
      }
    });
    try { renderer.compile(scene, camera); } catch { /* compiled on first use instead */ }
    for (const object of hidden) object.visible = false;
    for (const mesh of warm) scene.remove(mesh);
  }
  raf = requestAnimationFrame(frame);

  const controls = {
    onLost: null,
    /** Called at the moments that make a sound: 'land', 'dive', 'tier', 'reel', 'breach', 'snap', 'cut', 'boom', 'firework'. */
    onCue: null,
    /** Called with a zone's id as the lure goes down into it. */
    onZone: null,
    /** Called as the camera goes under the surface (true) and comes back up (false). */
    onUnderwater: null,
    /** The tier the dive was built at: 'low', 'medium' or 'high'. */
    tier: tier.name,

    /** The sinker on the line: 'feather', 'iron' or 'anvil'. */
    setSinker(name) {
      if (SINKERS.includes(name)) sinkerKind = name;
    },

    /** Swings the rod and casts. Resolves when the lure is in the water. */
    cast() {
      const now = performance.now();
      settle('resolveCast');
      settle('resolveReel');
      settle('resolveSnap');
      clearShow();
      hideLine();
      Object.assign(line, { diveAt: 0, depth: 0, x100: 100, cutter: null, boomed: false, zone: ZONES[0] });
      drownedEntity.visible = false;
      npc.swingAt = now;
      rodTip.getWorldPosition(line.from);
      line.splashAt.set((Math.random() - 0.5) * 1.5, 0, (Math.random() - 0.5) * 1.5);
      hook.position.copy(line.from);
      hook.visible = true;
      fishingLine.visible = true;
      setRodCast(true);
      setPhase('cast', now);
      return new Promise((resolve) => { line.resolveCast = resolve; });
    },

    /** The dive begins at `perfMs` (a performance.now() time): the multiplier climbs from there. */
    hookAt(perfMs) {
      line.diveAt = perfMs;
    },

    /** The dive: how far the multiplier has climbed (hundredths), and what is on the hook by now. */
    climb(x100, tierId) {
      line.x100 = x100;
      line.depth = depthOf(x100);
      if (line.phase !== 'dive') return;
      const zone = zoneAt(line.depth);
      if (zone !== line.zone) {
        line.zone = zone;
        controls.onZone?.(zone.id);
      }
      if (tierId !== line.tierId) {
        const first = line.tierId === null;
        putOnLine(tierId);
        if (!first) {
          twinkle(tmp.copy(hook.position).add(tmp2.set(0.3, 0, 0.2)), 10, 0.5);
          bubbles(hook.position.x, hook.position.y, hook.position.z, 8, 0.4);
          controls.onCue?.('tier');
        }
      }
    },

    /** Reeled up at `x100` with `catchId` on the hook: the catch comes up the line and out over the boat. */
    land(catchId, x100, kind = 'fish') {
      if (!['plunge', 'dive'].includes(line.phase)) return Promise.resolve();
      const now = performance.now();
      line.result = { catchId, kind, x100 };
      line.itemId = catchId;
      if (line.tierId !== catchId) putOnLine(catchId);
      line.ascentFrom = hook.position.y;
      line.ascentMs = reduce ? 1 : Math.min(2600, 900 + Math.sqrt(Math.max(0, -hook.position.y)) * 140);
      npc.swingAt = now;
      setPhase('ascend', now);
      controls.onCue?.('reel');
      return new Promise((resolve) => {
        line.resolveReel = resolve;
        // A frame that never comes (a hidden tab) must not hold the page: the catch lands regardless.
        setTimeout(() => {
          if (line.resolveReel !== resolve) return;
          hideLine();
          clearShow();
          line.item = itemMesh(catchId);
          line.item.position.copy(showAt);
          line.item.scale.setScalar(1.1);
          line.shownAt = performance.now();
          setPhase('show', line.shownAt);
          settle('resolveReel');
        }, 7000);
      });
    },

    /** Cut: whatever lives at the lure's depth takes the line. Resolves when the camera is back at the boat. */
    snap() {
      if (!['cast', 'plunge', 'dive'].includes(line.phase)) return Promise.resolve();
      settle('resolveCast');
      if (line.phase === 'cast') hook.position.copy(line.splashAt).setY(LURE_TOP);
      line.cutter = CUTTER[zoneAt(line.depth).id];
      line.boomed = false;
      line.fallFrom = hook.position.y;
      setPhase('snap', performance.now());
      controls.onCue?.('snap');
      return new Promise((resolve) => {
        line.resolveSnap = resolve;
        setTimeout(() => {
          if (line.resolveSnap !== resolve) return;
          hideLine();
          drownedEntity.visible = false;
          line.cutter = null;
          setPhase('idle', performance.now());
          settle('resolveSnap');
        }, 7000);
      });
    },

    /** Nothing came of the cast (the request failed): the line comes back empty. */
    slack() {
      if (line.phase === 'idle' || line.phase === 'show') return Promise.resolve();
      settle('resolveCast');
      line.from.copy(hook.position);
      setPhase('slack', performance.now());
      return new Promise((resolve) => { line.resolveReel = resolve; });
    },

    /** Takes the catch on show away. */
    clear() {
      clearShow();
    },

    dispose() {
      cancelAnimationFrame(raf);
      settle('resolveCast');
      settle('resolveReel');
      settle('resolveSnap');
      envTarget?.dispose();
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('webglcontextlost', onLost);
      composer?.dispose();
      renderer.dispose();
      canvas.remove();
    },
  };
  return controls;
}
