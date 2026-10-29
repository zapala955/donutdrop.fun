/* mines3d.js — Mines in 3D: a cave deep under the world, a five-by-five vein of stone on a mined-out
 * floor, and somewhere in it the TNT.
 *
 * Every block, item, particle and model is the game's own, out of the client jar: the deepslate,
 * tuff and ores of the walls, the lava falling down the back of the cave into its pool, the mineshaft
 * mouth with its oak posts, rails and torches, the amethyst and dripstone and cobwebs, the cracks a
 * block shows as it is mined (destroy_stage), the diamond dropped as an item turning over the floor,
 * the TNT that flashes white and swells before it goes, the explosion's own sprites, Steve on
 * PlayerModel with his diamond pickaxe, and a creeper on CreeperModel wandering at the back, the
 * game's round shadow under each of them and under every dropped diamond. What is drawn rather than
 * taken is light: the torchlight and its halos, the lava's glow, dust hanging in the light, the flash
 * of the blast, a block lifted under the cursor.
 *
 * Nothing here decides anything. mines.js starts the game, sends each block the player picks, and
 * says what was in it: a diamond, or TNT. If WebGL is missing or the context is lost, mines.js shows
 * the flat field.
 *
 * Low-end machines get less (quality3d.js): no glow, fewer particles, one warm light, a steady thirty
 * frames a second; a machine that cannot keep up steps down on its own.
 */
import { reduceMotion } from './util.js';
import { getTHREE, loadImage, softDot } from './mc3d.js';
import { CREEPER, MINECART, PLAYER, atlas, buildModel, itemModel, makeSprites, pixelTexture, placeEntity, poseQuadruped } from './mcmodels.js';
import { blobShadow, glowPoints, gradePass, ironChain, shadowMaterial } from './scenery3d.js';
import { BRIGHTNESS, chooseTier, createGovernor, frameMs, minFpsFor, ratioFor } from './quality3d.js';
import { shadeScene, shadedTHREE, smoothen } from './shade3d.js';

const GRID = 5;
const TILES = GRID * GRID;
const STEP = 1.14;            // block centre to block centre: a sliver of floor between blocks
const PLAYER_PIXEL = 0.9375 / 16;
const STEVE_AT = { x: -4.25, z: 1.3 };
const STAGE_MS = { gem: 34, tnt: 30 };   // a crack stage, of the ten a block shows as it is mined
const FUSE_MS = 900;                     // TNT lit to TNT gone
const SWELL_MS = 500;                    // the last ten ticks of the fuse, when it swells

const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
const easeOut = (t) => 1 - (1 - t) ** 3;
const easeOutBack = (t) => 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2;
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
/** The centre of a block, 0-24 in reading order, on the floor. */
export const tileAt = (tile) => ({ x: ((tile % GRID) - (GRID - 1) / 2) * STEP, z: (Math.floor(tile / GRID) - (GRID - 1) / 2) * STEP });

/** Points a box's six faces (three's order: +x, -x, +y, -y, +z, -z) at regions of a 16-pixel texture,
 * as a block model's element faces do: [u0, v0, u1, v1] in pixels. */
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
 * Builds the cave into `host` and resolves with its controls, or null when this browser cannot draw
 * it.
 */
export async function createMines3d(host) {
  const threeCore = await getTHREE();
  const probe = document.createElement('canvas');
  const probeGl = probe.getContext('webgl2');
  if (!probeGl) return null;
  const tier = chooseTier(probeGl);
  // Physical materials on medium and high, Lambert on low: the lit look (shade3d.js).
  const THREE = shadedTHREE(threeCore, tier);
  probeGl.getExtension('WEBGL_lose_context')?.loseContext();
  const canvas = document.createElement('canvas');
  canvas.className = 'mines__gl';
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
  renderer.toneMappingExposure = 1.3 * BRIGHTNESS;
  const scale = (n) => Math.max(1, Math.round(n * tier.particles));
  const FRAME_MS = frameMs(tier);
  let nextFrameAt = 0;

  /* ── what is loaded ── */
  const STAGES = Array.from({ length: 10 }, (_, i) => `destroy_stage_${i}`);
  const ORES = ['coal', 'iron', 'gold', 'redstone', 'lapis', 'diamond'];
  const BLOCKS = ['stone', 'andesite', 'gravel', 'deepslate', 'deepslate_top', 'cobbled_deepslate', 'deepslate_tiles', 'tuff',
    'tnt_side', 'tnt_top', 'tnt_bottom', 'diamond_ore', 'coal_ore', 'iron_ore', ...ORES.map((o) => `deepslate_${o}_ore`),
    'lava_still', 'lava_flow', 'oak_planks', 'torch', 'rail', 'glow_lichen', 'amethyst_block', 'amethyst_cluster', 'cobweb',
    'pointed_dripstone_up_tip', 'pointed_dripstone_up_frustum', 'pointed_dripstone_up_base', 'dripstone_block', 'lantern', 'iron_chain', ...STAGES];
  const ENTITY = ['steve', 'creeper', 'experience_orb', 'minecart'];
  const PARTICLE = ['glint', 'flame', 'lava', ...Array.from({ length: 16 }, (_, i) => `explosion_${i}`),
    ...Array.from({ length: 8 }, (_, i) => `generic_${i}`), ...Array.from({ length: 8 }, (_, i) => `spark_${i}`)];
  let loaded;
  try {
    loaded = await Promise.all([
      Promise.all(BLOCKS.map((name) => loadImage(`assets/img/block/${name}.png`))),
      Promise.all(ENTITY.map((name) => loadImage(`assets/img/entity/${name}.png`))),
      Promise.all(PARTICLE.map((name) => loadImage(`assets/img/particle/${name}.png`))),
      loadImage('assets/img/items/diamond.png'),
      loadImage('assets/img/items/diamond_pickaxe.png'),
      loadImage('assets/img/misc/shadow.png'),
      tier.composer
        ? import(/* @vite-ignore */ new URL('assets/vendor/three-addons.js', document.baseURI).href).catch(() => null)
        : Promise.resolve(null),
    ]);
  } catch {
    renderer.dispose();
    return null;
  }
  const [blockImgs, entityImgs, particleImgs, diamondImg, pickaxeImg, shadowImg, addons] = loaded;
  const img = Object.fromEntries(BLOCKS.map((name, i) => [name, blockImgs[i]]));
  const ent = Object.fromEntries(ENTITY.map((name, i) => [name, entityImgs[i]]));
  const part = Object.fromEntries(PARTICLE.map((name, i) => [name, particleImgs[i]]));
  host.prepend(canvas);

  const reduce = reduceMotion();
  const scene = new THREE.Scene();
  const DARK = 0x07080d;
  scene.background = new THREE.Color(DARK);
  scene.fog = new THREE.FogExp2(DARK, 0.042);
  const shading = shadeScene(THREE, { tier, renderer, scene, env: { top: 0x0b0c12, horizon: 0x4a3018, ground: 0x140c08, intensity: 0.55 }, wind: true });
  const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 200);
  scene.add(camera);

  let composer = null;
  let bloom = null;
  if (addons) {
    try {
      const target = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: tier.samples });
      composer = new addons.EffectComposer(renderer, target);
      composer.addPass(new addons.RenderPass(scene, camera));
      bloom = new addons.UnrealBloomPass(new THREE.Vector2(4, 4), 0.55, 0.5, 0.9);
      composer.addPass(bloom);
      composer.addPass(new addons.OutputPass());
      composer.addPass(gradePass(THREE, addons, { sharpen: 0, contrast: 1.08, saturation: 1.1, lift: [0.025, 0.015, 0.0], gain: [1.04, 1.0, 0.94], vignette: 0.18 }));
      // Smooth, not sharp: soft shadow in the corners, and the edges blended (shade3d.js).
      smoothen(THREE, addons, composer, camera, { tier, ao: 0.6 });
    } catch {
      composer = null;
      bloom = null;
    }
  }
  const tex = (name) => pixelTexture(THREE, img[name]);
  /** One frame of an animated block texture, as its own canvas texture. */
  const frameTex = (name, frame = 0, size = 16) => {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    c.getContext('2d').drawImage(img[name], 0, frame * size, size, size, 0, 0, size, size);
    return pixelTexture(THREE, c);
  };
  const lambert = (map, opts = {}) => new THREE.MeshLambertMaterial({ map, ...opts });
  const sideTop = (side, top, bottom = top) => [side, side, top, bottom, side, side];

  /* ── light: dim cave air, torchlight round the field, the lava's glow ── */
  scene.add(new THREE.HemisphereLight(0x6a7088, 0x16121a, tier.name === 'low' ? 0.9 : 0.65));
  // A cool light from over the player's shoulder, so the faces of the blocks turned to the camera are
  // not lost -- the game shades a block's sides lighter or darker by the way they face, never black.
  const fill = new THREE.DirectionalLight(0xc4cad8, tier.name === 'low' ? 1.25 : 1.05);
  fill.position.set(-2, 6, 10);
  scene.add(fill, fill.target);
  const FIELD_LIGHT = tier.name === 'low' ? 8 : 7;
  const fieldLight = new THREE.PointLight(0xffcf98, FIELD_LIGHT, 15, 1.3);
  fieldLight.position.set(0, 3.6, 0.6);
  scene.add(fieldLight);
  // Where the machine can afford it, a lamp straight over the field throws the blocks' shadows on the
  // floor and on each other: the field stands up off the ground.
  const shadows = tier.name !== 'low';
  let fieldLamp = null;
  if (shadows) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    fieldLamp = new THREE.SpotLight(0xffe2bc, 26, 22, 0.62, 0.65, 1.4);
    fieldLamp.position.set(-1.5, 9, 3.5);
    fieldLamp.target.position.set(0, 0, -0.3);
    fieldLamp.castShadow = true;
    fieldLamp.shadow.mapSize.set(tier.name === 'high' ? 2048 : 1024, tier.name === 'high' ? 2048 : 1024);
    fieldLamp.shadow.bias = -0.0008;
    fieldLamp.shadow.normalBias = 0.02;
    scene.add(fieldLamp, fieldLamp.target);
  }
  const shadowMat = shadowMaterial(THREE, shadowImg, 0.75);
  // The blast's flash: always in the scene, dark until something goes off -- a light added later
  // would recompile every material in the cave at the worst moment.
  const flashLight = new THREE.PointLight(0xffc27a, 0, 18, 1.2);
  scene.add(flashLight);

  /* ── the cave: a floor, walls of deepslate and tuff with ores in them, a tunnel and a lava fall ── */
  const rand = seeded(23);
  const zBack = (x) => -6.3 - (x * x) / 42 + Math.sin(x * 0.9) * 0.45;
  const xSide = (z) => 9.3 + Math.sin(z * 0.7 + 1) * 0.6 + (z > 1 ? (z - 1) * 0.35 : 0);
  const inside = (cx, cz) => Math.abs(cx + 0.5) < xSide(cz + 0.5) && cz + 0.5 > zBack(cx + 0.5);
  /** The face of the back wall in the column holding `x`, and the outermost open column at depth `z`. */
  const backFace = (x) => Math.floor(zBack(Math.floor(x) + 0.5) - 0.5) + 1;
  const sideEdge = (z) => Math.floor(xSide(Math.floor(z) + 0.5) - 0.5) + 0.5;
  const TUNNEL = { x0: -8, x1: -5, height: 3, depth: 4 };  // cells x0 .. x1-1, back from the wall
  const LAVA_X = 5;
  let lavaBack = 0;
  for (let cz = 0; cz > -14; cz -= 1) {
    if (!inside(LAVA_X, cz)) { lavaBack = cz; break; }
  }
  const POOL = { x0: 4, x1: 7, z0: lavaBack + 1, z1: lavaBack + 3 };
  const inPool = (cx, cz) => cx >= POOL.x0 && cx < POOL.x1 && cz >= POOL.z0 && cz < POOL.z1;
  const tunnelBack = (cx) => {
    if (cx < TUNNEL.x0 || cx >= TUNNEL.x1) return null;
    let cz = 0;
    while (inside(cx, cz)) cz -= 1;
    return cz; // the first wall cell; the tunnel runs from here back `depth` cells
  };
  const inTunnel = (cx, cz) => {
    const back = tunnelBack(cx);
    return back !== null && cz <= back && cz > back - TUNNEL.depth;
  };

  const box = new THREE.BoxGeometry(1, 1, 1);
  const floorTile = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const mats = {
    stone: lambert(tex('stone')),
    andesite: lambert(tex('andesite')),
    gravel: lambert(tex('gravel')),
    deepslate: sideTop(lambert(tex('deepslate')), lambert(tex('deepslate_top'))),
    cobbled_deepslate: lambert(tex('cobbled_deepslate')),
    tuff: lambert(tex('tuff')),
    coal_ore: lambert(tex('coal_ore')),
    iron_ore: lambert(tex('iron_ore')),
    amethyst_block: lambert(tex('amethyst_block'), { emissive: 0x1a0a2a }),
    dripstone_block: lambert(tex('dripstone_block')),
  };
  for (const o of ORES) mats[`deepslate_${o}_ore`] = lambert(tex(`deepslate_${o}_ore`), o === 'diamond' ? { emissive: 0x06181a } : {});
  const floorMats = {
    deepslate_top: lambert(tex('deepslate_top')),
    cobbled_deepslate: mats.cobbled_deepslate,
    tuff: mats.tuff,
    gravel: mats.gravel,
    deepslate_tiles: lambert(tex('deepslate_tiles')),
  };
  const walls = {};
  const floors = {};
  const putBlock = (name, x, y, z) => { (walls[name] ||= []).push([x, y, z]); };
  const putFloor = (name, x, z) => { (floors[name] ||= []).push([x, z]); };
  const geode = { x: -9.5, y: 2.2, z: -3 };
  const backHeight = tier.name === 'low' ? 8 : 10;
  for (let cx = -14; cx < 14; cx += 1) {
    for (let cz = -13; cz < 9; cz += 1) {
      const x = cx + 0.5;
      const z = cz + 0.5;
      const tunnel = inTunnel(cx, cz);
      if (inside(cx, cz) || tunnel) {
        if (inPool(cx, cz)) continue;
        if (Math.abs(x) < 3.6 && Math.abs(z) < 3.6) putFloor('deepslate_tiles', x, z);
        else {
          const r = rand();
          putFloor(r < 0.58 ? 'deepslate_top' : r < 0.78 ? 'cobbled_deepslate' : r < 0.92 ? 'tuff' : 'gravel', x, z);
        }
        // The tunnel has rock over it; the cave is open to the dark.
        if (!tunnel) continue;
      }
      // Only a shell of rock round the cave: what is deeper than three blocks is never seen.
      const nearBack = z > zBack(x) - 3.2;
      const nearSide = Math.abs(x) < xSide(z) + 3.2;
      if (!tunnel && (!nearBack || !nearSide || z > 5)) continue;
      const back = z < zBack(x) + 0.5 && Math.abs(x) < xSide(z);
      const h = back ? backHeight + Math.floor(rand() * 3) : z < -2 ? 7 + Math.floor(rand() * 2) : 4 + Math.floor(rand() * 2) - (z > 2 ? 1 : 0);
      if (cx === LAVA_X && cz === lavaBack) continue; // the lava fall's notch
      for (let y = tunnel ? TUNNEL.height : 0; y < h; y += 1) {
        const yc = y + 0.5;
        if (Math.hypot(x - geode.x, yc - geode.y, z - geode.z) < 2.1) { putBlock('amethyst_block', x, yc, z); continue; }
        const r = rand();
        if (y >= 6) {
          putBlock(r < 0.66 ? 'stone' : r < 0.82 ? 'andesite' : r < 0.88 ? 'gravel' : r < 0.95 ? 'coal_ore' : 'iron_ore', x, yc, z);
          continue;
        }
        const band = Math.sin(x * 0.45 + yc * 0.8) + Math.sin(z * 0.6 - yc * 0.3);
        if (r < 0.065) {
          const o = rand();
          const ore = x > 2.5 && o < 0.18 ? 'diamond' : o < 0.32 ? 'coal' : o < 0.6 ? 'iron' : o < 0.74 ? 'gold' : o < 0.88 ? 'redstone' : 'lapis';
          putBlock(`deepslate_${ore}_ore`, x, yc, z);
        } else if (band > 1.1) putBlock('tuff', x, yc, z);
        else if (band < -1.2 && x > 0) putBlock('dripstone_block', x, yc, z);
        else putBlock(r < 0.72 ? 'deepslate' : 'cobbled_deepslate', x, yc, z);
      }
    }
  }
  {
    const m = new THREE.Matrix4();
    for (const [name, list] of Object.entries(walls)) {
      const mesh = new THREE.InstancedMesh(box, mats[name], list.length);
      list.forEach(([x, y, z], i) => mesh.setMatrixAt(i, m.makeTranslation(x, y, z)));
      scene.add(mesh);
    }
    for (const [name, list] of Object.entries(floors)) {
      const mesh = new THREE.InstancedMesh(floorTile, floorMats[name], list.length);
      mesh.receiveShadow = true;
      list.forEach(([x, z], i) => mesh.setMatrixAt(i, m.makeTranslation(x, 0, z)));
      scene.add(mesh);
    }
  }

  /* ── the lava: a fall down the back wall into a pool ── */
  const lava = { still: frameTex('lava_still'), flow: frameTex('lava_flow', 0, 32), stillFrame: -1, flowFrame: -1 };
  lava.stillFrames = Math.max(1, Math.floor(img.lava_still.naturalHeight / 16));
  lava.flowFrames = Math.max(1, Math.floor(img.lava_flow.naturalHeight / 32));
  lava.still.wrapS = lava.still.wrapT = THREE.RepeatWrapping;
  lava.flow.wrapS = lava.flow.wrapT = THREE.RepeatWrapping;
  const LAVA_GLOW = new THREE.Color(1.25, 1.12, 1.05);
  const fallHeight = backHeight + 2;
  {
    // A flowing face shows half its 32-pixel frame per block, as the game draws flowing fluid.
    const flowTex = lava.flow;
    flowTex.repeat.set(0.5, fallHeight * 0.5);
    const fall = new THREE.Mesh(new THREE.BoxGeometry(0.98, fallHeight, 0.98), new THREE.MeshBasicMaterial({ map: flowTex, color: LAVA_GLOW, toneMapped: false }));
    fall.position.set(LAVA_X + 0.5, fallHeight / 2 - 0.12, lavaBack + 0.5);
    scene.add(fall);
    lava.still.repeat.set(POOL.x1 - POOL.x0, POOL.z1 - POOL.z0);
    const pool = new THREE.Mesh(new THREE.PlaneGeometry(POOL.x1 - POOL.x0, POOL.z1 - POOL.z0).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: lava.still, color: LAVA_GLOW, toneMapped: false }));
    pool.position.set((POOL.x0 + POOL.x1) / 2, -0.12, (POOL.z0 + POOL.z1) / 2);
    scene.add(pool);
    // The pool's sides, down to the lava.
    const rim = new THREE.Mesh(new THREE.BoxGeometry(POOL.x1 - POOL.x0, 0.24, POOL.z1 - POOL.z0), [...Array(6)].map(() => new THREE.MeshLambertMaterial({ map: tex('deepslate'), side: THREE.BackSide })));
    rim.position.set((POOL.x0 + POOL.x1) / 2, -0.12, (POOL.z0 + POOL.z1) / 2);
    scene.add(rim);
  }
  const lavaAt = new THREE.Vector3((POOL.x0 + POOL.x1) / 2, 0.2, (POOL.z0 + POOL.z1) / 2);
  let lavaLight = null;
  if (tier.lights >= 2) {
    lavaLight = new THREE.PointLight(0xff7a26, 8, 11, 1.4);
    lavaLight.position.set(lavaAt.x, 1.6, lavaAt.z + 0.5);
    scene.add(lavaLight);
  }

  /* ── the mineshaft mouth: oak posts and a plank beam, rails out of the dark ── */
  const torchTex = tex('torch');
  const torchMat = new THREE.MeshBasicMaterial({ map: torchTex, color: new THREE.Color(1.3, 1.2, 1.05), toneMapped: false });
  // The torch model: a stick two pixels square and ten tall, its flame the top of the texture.
  const torchGeo = regionUV(new THREE.BoxGeometry(2 / 16, 10 / 16, 2 / 16), [[7, 6, 9, 16], [7, 6, 9, 16], [7, 6, 9, 8], [7, 13, 9, 15], [7, 6, 9, 16], [7, 6, 9, 16]]);
  torchGeo.translate(0, 5 / 16, 0);
  const flames = [];
  function torch(x, y, z, lean = null) {
    const t = new THREE.Mesh(torchGeo, torchMat);
    t.position.set(x, y, z);
    if (lean) {
      // A wall torch leans 22.5 degrees out from the wall it hangs on.
      t.rotation.set(lean.x * 0.3927, 0, lean.z * 0.3927);
    }
    scene.add(t);
    const tip = new THREE.Vector3(0, 10.5 / 16, 0).applyEuler(t.rotation).add(t.position);
    flames.push(tip);
    return t;
  }
  {
    const planks = tex('oak_planks');
    // A fence post, as a mineshaft props its roof: four pixels square, a block a piece.
    const postGeo = regionUV(new THREE.BoxGeometry(4 / 16, 1, 4 / 16), [[6, 0, 10, 16], [6, 0, 10, 16], [6, 6, 10, 10], [6, 6, 10, 10], [6, 0, 10, 16], [6, 0, 10, 16]]);
    const postMat = lambert(planks);
    const mouth = tunnelBack(TUNNEL.x0) + 1;
    for (const x of [TUNNEL.x0 + 0.2, TUNNEL.x1 - 0.2]) {
      for (const y of [0.5, 1.5]) {
        const post = new THREE.Mesh(postGeo, postMat);
        post.position.set(x, y, mouth - 0.3);
        scene.add(post);
      }
      // On the post's inner side, leaning away from it.
      torch(x + (x < -6 ? 0.2 : -0.2), 1.05, mouth - 0.3, { x: 0, z: x < -6 ? -1 : 1 });
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(TUNNEL.x1 - TUNNEL.x0, 0.5, 0.5), lambert(planks));
    beam.position.set((TUNNEL.x0 + TUNNEL.x1) / 2, 2.25, mouth - 0.3);
    scene.add(beam);
    // Rails: the flat texture laid on the floor, from deep in the tunnel to the front of the cave.
    const railMat = new THREE.MeshLambertMaterial({ map: tex('rail'), alphaTest: 0.5 });
    const railX = (TUNNEL.x0 + TUNNEL.x1) / 2;
    const from = mouth - TUNNEL.depth;
    const rails = new THREE.InstancedMesh(floorTile, railMat, 6 - from);
    const m = new THREE.Matrix4();
    for (let z = from, i = 0; z < 6; z += 1, i += 1) rails.setMatrixAt(i, m.makeTranslation(railX, 0.012, z + 0.5));
    scene.add(rails);
  }
  // Torches standing at the platform's corners, and two on the back wall.
  for (const [x, z] of [[-3.5, -3.5], [3.5, -3.5], [-3.5, 3.5], [3.5, 3.5]]) torch(x, 0, z);
  for (const x of [-2.4, 1.6]) torch(Math.floor(x) + 0.5, 2.9, backFace(x) + 0.1, { x: 1, z: 0 });
  // Lanterns on chains from the dark overhead, either side at the back of the field.
  const hanging = [];
  {
    const PX = 1 / 16;
    const cut = (x, y, w, h) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      c.getContext('2d').drawImage(img.lantern, x, y, w, h, 0, 0, w, h);
      return pixelTexture(THREE, c);
    };
    const glow = new THREE.MeshBasicMaterial({ map: cut(0, 2, 6, 7), color: new THREE.Color(1.6, 1.3, 0.85), toneMapped: false });
    const cap = new THREE.MeshLambertMaterial({ map: cut(0, 9, 6, 6) });
    for (const [x, z] of [[-3.3, -3.7], [3.3, -3.7]]) {
      const chain = ironChain(THREE, img.iron_chain, 5);
      chain.position.set(x, 8.4, z);
      scene.add(chain);
      const lantern = new THREE.Mesh(new THREE.BoxGeometry(6 * PX * 1.6, 7 * PX * 1.6, 6 * PX * 1.6), [glow, glow, cap, cap, glow, glow]);
      lantern.position.set(x, 8.4 - 5 - 0.3, z);
      scene.add(lantern);
      hanging.push({ chain, lantern, x, z, phase: x });
    }
  }
  // A minecart of TNT left on the rails in the tunnel mouth.
  {
    const model = buildModel(THREE, [{ material: new THREE.MeshLambertMaterial({ map: pixelTexture(THREE, ent.minecart), side: THREE.DoubleSide }), def: MINECART }]);
    model.root.rotation.x = Math.PI;
    model.root.position.y = 6;
    const scaled = new THREE.Group();
    scaled.scale.setScalar(1 / 16);
    scaled.add(model.root);
    const cartGroup = new THREE.Group();
    cartGroup.add(scaled);
    const tntInside = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.62, 0.62), sideTop(lambert(tex('tnt_side')), lambert(tex('tnt_top')), lambert(tex('tnt_bottom'))));
    tntInside.position.y = 0.45;
    cartGroup.add(tntInside);
    cartGroup.rotation.y = Math.PI / 2;
    cartGroup.position.set((TUNNEL.x0 + TUNNEL.x1) / 2, 0.02, tunnelBack(TUNNEL.x0) - 0.4);
    cartGroup.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    scene.add(cartGroup);
  }
  let backLight = null;
  if (tier.lights >= 4) {
    backLight = new THREE.PointLight(0xffa860, 4, 8, 1.5);
    backLight.position.set((TUNNEL.x0 + TUNNEL.x1) / 2, 1.8, tunnelBack(TUNNEL.x0) + 1.2);
    scene.add(backLight);
  }

  /* ── what grows down here: glow lichen, amethyst, dripstone, cobwebs ── */
  {
    const plane = new THREE.PlaneGeometry(1, 1);
    const crossAt = (material, x, y, z, w = 1, h = 1) => {
      for (const r of [Math.PI / 4, -Math.PI / 4]) {
        const mesh = new THREE.Mesh(plane, material);
        mesh.rotation.y = r;
        mesh.scale.set(w, h, 1);
        mesh.position.set(x, y + h / 2, z);
        scene.add(mesh);
      }
    };
    const lichen = new THREE.MeshBasicMaterial({ map: tex('glow_lichen'), transparent: true, alphaTest: 0.4, color: new THREE.Color(0.5, 0.6, 0.55), side: THREE.DoubleSide });
    const r = seeded(5);
    for (let i = 0; i < 9; i += 1) {
      const x = -8 + r() * 15;
      const y = Math.floor(1 + r() * 6) + 0.5;
      if (Math.abs(x - LAVA_X - 0.5) < 1.6 || (x > TUNNEL.x0 - 0.5 && x < TUNNEL.x1 + 0.5)) continue;
      const mesh = new THREE.Mesh(plane, lichen);
      mesh.position.set(Math.floor(x) + 0.5, y, backFace(x) + 0.01);
      scene.add(mesh);
    }
    const amethyst = new THREE.MeshBasicMaterial({ map: tex('amethyst_cluster'), alphaTest: 0.5, side: THREE.DoubleSide, color: new THREE.Color(1.15, 1.0, 1.25), toneMapped: false });
    for (const [x, z] of [[-7.6, -2.2], [-7.3, -3.6], [-8.2, -1.2]]) crossAt(amethyst, x, 0, z, 0.8, 0.8);
    const drip = ['pointed_dripstone_up_base', 'pointed_dripstone_up_frustum', 'pointed_dripstone_up_tip'].map((n) => new THREE.MeshLambertMaterial({ map: tex(n), alphaTest: 0.5, side: THREE.DoubleSide }));
    for (const [x, z, tall] of [[sideEdge(-1.5), -1.5, 3], [sideEdge(-0.4) - 1, -0.4, 2], [-sideEdge(1.6) + 1, 1.6, 2], [2.6, lavaBack + 1.4, 1], [-1.2, backFace(-1.2) + 0.5, 2]]) {
      for (let k = 0; k < tall; k += 1) crossAt(drip[tall === 1 ? 2 : k === tall - 1 ? 2 : k === 0 ? 0 : 1], x, k, z);
    }
    const web = new THREE.MeshLambertMaterial({ map: tex('cobweb'), alphaTest: 0.4, side: THREE.DoubleSide, color: 0xbfc4cc });
    const mouth = tunnelBack(TUNNEL.x0) + 1;
    for (const [x, y, z] of [[TUNNEL.x0 + 0.6, 2, mouth - 0.7], [sideEdge(-3), 3, -3], [-sideEdge(0.5), 3.5, 0.5]]) crossAt(web, x, y, z, 0.95, 0.95);
  }

  /* ── the field: twenty-five blocks of stone on the platform ── */
  const stoneMat = lambert(tex('stone'));
  const tntSide = tex('tnt_side');
  const tntTop = tex('tnt_top');
  const tntBottom = tex('tnt_bottom');
  const tntMats = sideTop(lambert(tntSide), lambert(tntTop), lambert(tntBottom));
  const tntDim = sideTop(lambert(tntSide, { color: 0xc4c4c4 }), lambert(tntTop, { color: 0xc4c4c4 }), lambert(tntBottom, { color: 0xc4c4c4 }));
  const oreDim = lambert(tex('diamond_ore'), { color: 0xb4b4b4 });
  const stageTex = STAGES.map((n) => tex(n));
  const glowTex = softDot('rgba(150,240,255,1)');
  const tiles = Array.from({ length: TILES }, (_, tile) => {
    const { x, z } = tileAt(tile);
    const mesh = new THREE.Mesh(box, stoneMat);
    mesh.position.set(x, 0.5, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.tile = tile;
    scene.add(mesh);
    const glow = new THREE.Mesh(floorTile, new THREE.MeshBasicMaterial({ map: glowTex, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    glow.position.set(x, 0.02, z);
    glow.scale.setScalar(1.5);
    glow.visible = false;
    scene.add(glow);
    return { tile, x, z, mesh, glow, state: 'stone', item: null, born: 0, lift: 0, riseAt: 0, popAt: 0, litAt: 0, jx: 0, jz: 0, flying: null };
  });
  const tileMeshes = tiles.map((t) => t.mesh);
  // The live TNT has its own materials: it flashes white without the rest of the field doing so.
  const tntLive = sideTop(lambert(tntSide), lambert(tntTop), lambert(tntBottom));
  // The cracks, on a shell just outside the block being mined, blended as the game blends them:
  // colour times the block's colour twice over, so mid-grey leaves the block alone and the dark
  // lines darken it; what is all but transparent is dropped.
  const crack = new THREE.Mesh(new THREE.BoxGeometry(1.004, 1.004, 1.004), new THREE.MeshBasicMaterial({
    map: stageTex[0], transparent: true, alphaTest: 0.1, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.DstColorFactor, blendDst: THREE.SrcColorFactor,
    toneMapped: false, fog: false,
  }));
  crack.visible = false;
  crack.renderOrder = 3;
  scene.add(crack);
  // The block outline the game draws round what the crosshair is on; white for the keyboard's focus.
  const outline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1.012, 1.012, 1.012)), new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.6 }));
  outline.visible = false;
  scene.add(outline);

  /* ── the diamond, extruded from its sprite, dropped as an item ── */
  const diamond = itemModel(THREE, diamondImg);
  diamond.material.emissive.setHex(0x3a4a4c);
  function dropDiamond(t, now) {
    const holder = new THREE.Group();
    const spin = new THREE.Group();
    spin.add(new THREE.Mesh(diamond.geometry, diamond.material));
    holder.add(spin);
    holder.scale.setScalar(0.62);
    holder.position.set(t.x, 0.35, t.z);
    scene.add(holder);
    const shade = blobShadow(THREE, shadowMat, 0.28);
    shade.position.set(t.x, 0.015, t.z);
    holder.userData.shadow = shade;
    scene.add(shade);
    t.item = { holder, spin, phase: t.tile * 0.7 };
    t.born = now;
    t.glow.visible = true;
  }

  /* ── Steve, pickaxe in hand, at the edge of the platform ── */
  const steveMat = new THREE.MeshLambertMaterial({ map: pixelTexture(THREE, ent.steve), alphaTest: 0.5, side: THREE.DoubleSide });
  const player = buildModel(THREE, [{ material: steveMat, def: PLAYER }]);
  const steve = placeEntity(THREE, player, PLAYER_PIXEL);
  const P = player.parts;
  steve.position.set(STEVE_AT.x, 0, STEVE_AT.z);
  steve.rotation.y = Math.PI / 2;
  scene.add(steve);
  const steveShadow = blobShadow(THREE, shadowMat, 0.42);
  steveShadow.position.set(STEVE_AT.x, 0.015, STEVE_AT.z);
  scene.add(steveShadow);
  {
    const mount = new THREE.Group();
    mount.position.set(-1, 9.5, -0.5);
    mount.rotation.x = 0.35;
    P.rightArm.add(mount);
    const basis = new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, -1, 0), new THREE.Vector3(-1, 0, 0));
    const held = new THREE.Group();
    held.quaternion.setFromRotationMatrix(basis);
    held.scale.setScalar(16 * 0.85);
    held.position.copy(new THREE.Vector3(3.5 / 16 - 0.5, 0.5 - 12.5 / 16, 0).applyMatrix4(basis).multiplyScalar(-16 * 0.85));
    mount.add(held);
    const { geometry, material } = itemModel(THREE, pickaxeImg);
    held.add(new THREE.Mesh(geometry, material));
  }
  const miner = { yaw: Math.PI / 2, target: null, swinging: false, hopStart: 0, hopUntil: 0, cheerUntil: 0, sulkUntil: 0, hurtUntil: 0 };

  /* ── a creeper, wandering along the back of the cave ── */
  const creeperMat = new THREE.MeshLambertMaterial({ map: pixelTexture(THREE, ent.creeper), alphaTest: 0.5 });
  const creeperModel = buildModel(THREE, [{ material: creeperMat, def: CREEPER }]);
  const creeper = placeEntity(THREE, creeperModel, 1 / 16);
  const crawl = { x: -2, z: zBack(0) + 1.7, dir: 1, walk: 0, pauseUntil: 0, hopStart: 0, hopUntil: 0, hurtUntil: 0 };
  creeper.position.set(crawl.x, 0, crawl.z);
  scene.add(creeper);
  const creeperShadow = blobShadow(THREE, shadowMat, 0.45);
  scene.add(creeperShadow);

  /* ── particles ── */
  const sprites = [];
  const sprite = (map, opts) => {
    const s = makeSprites(THREE, { map, ...opts });
    scene.add(s.points);
    sprites.push(s);
    return s;
  };
  // Breaking particles are the block's own texture, cut small, as the game breaks stone.
  const chips = sprite(pixelTexture(THREE, img.stone), { cols: 4, rows: 4, count: scale(320) });
  const tntChips = sprite(pixelTexture(THREE, img.tnt_side), { cols: 4, rows: 4, count: scale(80) });
  const sparkles = sprite(pixelTexture(THREE, part.glint), { count: scale(160) });
  const blasts = sprite(atlas(THREE, Array.from({ length: 16 }, (_, i) => part[`explosion_${i}`]), 32, 4).map, { cols: 4, rows: 4, count: scale(90) });
  const smoke = sprite(atlas(THREE, Array.from({ length: 8 }, (_, i) => part[`generic_${i}`]), 8, 8).map, { cols: 8, rows: 1, count: scale(120) });
  const flameSprites = sprite(pixelTexture(THREE, part.flame), { count: scale(60), additive: true });
  const lavaPops = sprite(pixelTexture(THREE, part.lava), { count: scale(40), additive: true });
  const sparks = sprite(atlas(THREE, Array.from({ length: 8 }, (_, i) => part[`spark_${i}`]), 8, 8).map, { cols: 8, rows: 1, count: scale(400), additive: true });
  const orbs = sprite(pixelTexture(THREE, ent.experience_orb), { cols: 4, rows: 4, count: scale(100), additive: true });
  function chip(set, x, y, z, n, spread = 0.9, up = 2.2) {
    if (reduce) return;
    for (let i = 0; i < scale(n); i += 1) {
      const a = Math.random() * Math.PI * 2;
      const v = 0.6 + Math.random() * 1.6;
      set.emit({ x: x + (Math.random() - 0.5) * spread, y: y + (Math.random() - 0.5) * spread, z: z + (Math.random() - 0.5) * spread, vx: Math.cos(a) * v, vy: up * (0.5 + Math.random()), vz: Math.sin(a) * v, gravity: -14, drag: 0.3, life: 0.5 + Math.random() * 0.5, size: 0.1, frame: Math.floor(Math.random() * 16), fade: 0.2 });
    }
  }
  function twinkle(at, n, spread = 0.7) {
    if (reduce) return;
    for (let i = 0; i < scale(n); i += 1) {
      sparkles.emit({ x: at.x + (Math.random() - 0.5) * spread, y: at.y + (Math.random() - 0.5) * spread, z: at.z + (Math.random() - 0.5) * spread, vx: (Math.random() - 0.5) * 0.3, vy: 0.3 + Math.random() * 0.5, vz: (Math.random() - 0.5) * 0.3, drag: 0.6, life: 0.7 + Math.random() * 0.6, size: 0.14, sizeTo: 0.05, r: 0.7, g: 1, b: 1, fade: 0.4 });
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
  function orbsFrom(from, n) {
    if (reduce) return;
    const to = new THREE.Vector3(STEVE_AT.x, 1.4, STEVE_AT.z);
    for (let i = 0; i < scale(n); i += 1) {
      const t = 0.7 + Math.random() * 0.4;
      const gravity = -5;
      const sx = from.x + (Math.random() - 0.5) * 3;
      const sz = from.z + (Math.random() - 0.5) * 3;
      orbs.emit({ x: sx, y: from.y, z: sz, vx: (to.x - sx) / t, vy: (to.y - from.y) / t - 0.5 * gravity * t, vz: (to.z - sz) / t, gravity, life: t, size: 0.14, frame: Math.floor(Math.random() * 7), r: 0.8, g: 1, b: 0.2, fade: 0.15 });
    }
  }
  /* The blast: the game's explosion emitter puts out six puffs a tick for eight ticks, scattered up
   * to two blocks round it, each running through the sixteen frames in six to ten ticks, grey from
   * 0.4 to 1, shrinking as the emitter ages. */
  const halos = glowPoints(THREE, [...flames.map((f) => [f.x, f.y, f.z]), ...hanging.map((h) => [h.x, h.lantern.position.y, h.z]), [lavaAt.x, 0.6, lavaAt.z], [LAVA_X + 0.5, 3, lavaBack + 1]], { size: 1.4, color: 0xffb060, opacity: 0.5 });
  scene.add(halos.points);
  const dust = sprite(pixelTexture(THREE, part.generic_0), { count: scale(80), additive: true });
  const blastsDue = [];
  const blastGlow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: softDot('rgba(255,190,110,1)'), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
  blastGlow.visible = false;
  scene.add(blastGlow);
  let blastAt = 0;
  function explode(at, now) {
    blastAt = now;
    blastGlow.position.set(at.x, at.y + 0.4, at.z);
    blastGlow.visible = true;
    flashLight.position.set(at.x, at.y + 1.2, at.z);
    flashLight.intensity = reduce ? 14 : 40;
    if (reduce) return;
    for (let tick = 0; tick < 8; tick += 1) blastsDue.push({ at: now + tick * 50, x: at.x, y: at.y, z: at.z, age: tick / 8 });
    chip(chips, at.x, 0.5, at.z, 46, 2.4, 4.2);
    chip(tntChips, at.x, 0.5, at.z, 22, 0.8, 3.4);
    for (let i = 0; i < scale(26); i += 1) {
      smoke.emit({ x: at.x + (Math.random() - 0.5) * 2.4, y: 0.4 + Math.random() * 1.2, z: at.z + (Math.random() - 0.5) * 2.4, vx: (Math.random() - 0.5) * 0.6, vy: 0.4 + Math.random() * 0.6, vz: (Math.random() - 0.5) * 0.6, drag: 0.4, life: 1.4 + Math.random() * 1.2, size: 0.55, sizeTo: 1.1, frame: 7, frameTo: 0, r: 0.32, g: 0.32, b: 0.34, a: 0.85, fade: 0.5 });
    }
  }
  function emitBlast(b) {
    const n = scale(6);
    // A little smaller and darker than the game's: under the camera's glow its grey reads as white.
    for (let i = 0; i < n; i += 1) {
      const size = 1.9 * (1 - b.age * 0.5);
      const grey = 0.24 + Math.random() * 0.34;
      blasts.emit({ x: b.x + (Math.random() - Math.random()) * 1.6, y: b.y + 0.5 + (Math.random() - Math.random()) * 0.9, z: b.z + (Math.random() - Math.random()) * 1.6, life: (6 + Math.random() * 4) / 20, size, frame: 0, frameTo: 15, r: grey, g: grey, b: grey, fade: 0.05 });
    }
  }

  /* ─────────── the field, in play ─────────── */

  const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, reduce ? 0 : ms); });
  let shake = 0;
  let active = false;
  let hovered = -1;
  let focused = -1;
  const fireworksDue = [];
  function setStone(t) {
    t.state = 'stone';
    t.mesh.material = stoneMat;
    t.mesh.visible = true;
    t.litAt = 0;
    if (t.item) scene.remove(t.item.holder, t.item.holder.userData.shadow);
    t.item = null;
    t.flying = null;
    t.glow.visible = false;
  }
  async function mine(t, stageMs) {
    miner.target = t;
    miner.swinging = true;
    crack.visible = true;
    crack.position.copy(t.mesh.position);
    for (let s = 0; s < STAGES.length; s += 1) {
      crack.material.map = stageTex[s];
      crack.material.needsUpdate = true;
      if (s % 2 === 0) {
        chip(chips, t.x, 0.9, t.z, 2, 0.8, 1.2);
        controls.onCue?.('crack', s);
      }
      await wait(stageMs);
    }
    crack.visible = false;
    miner.swinging = false;
  }
  function breakStone(t) {
    t.mesh.visible = false;
    chip(chips, t.x, 0.5, t.z, 26, 0.9, 2.6);
    controls.onCue?.('break');
  }

  /* ─────────── the camera: over the field, a little to the front ─────────── */

  const cam = { pos: new THREE.Vector3(), look: new THREE.Vector3() };
  const goalPos = new THREE.Vector3();
  const goalLook = new THREE.Vector3(0, 0.1, -0.75);
  function frameShot(clock) {
    const sway = reduce ? 0 : Math.sin(clock * 0.12) * 0.45;
    goalPos.set(sway, 6.9, 8.5);
  }

  /* ── picking a block with the pointer ── */
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  function tileUnder(event) {
    const b = canvas.getBoundingClientRect();
    if (!b.width) return -1;
    ndc.set(((event.clientX - b.left) / b.width) * 2 - 1, -((event.clientY - b.top) / b.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObjects(tileMeshes, false).find((h) => h.object.visible);
    return hit ? hit.object.userData.tile : -1;
  }
  const pickable = (tile) => active && tile >= 0 && tiles[tile].state === 'stone';
  let lastMove = 0;
  const onMove = (event) => {
    const now = performance.now();
    if (now - lastMove < 40) return; // a pick ray twenty-five times a second is plenty
    lastMove = now;
    const tile = tileUnder(event);
    hovered = pickable(tile) ? tile : -1;
    canvas.style.cursor = hovered >= 0 ? 'pointer' : '';
  };
  const onLeave = () => { hovered = -1; };
  const onClick = (event) => {
    const tile = tileUnder(event);
    if (pickable(tile)) controls.onPick?.(tile);
  };
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('click', onClick);
  let lost = false;
  const onLost = (event) => { event.preventDefault(); lost = true; controls.onLost?.(); };
  canvas.addEventListener('webglcontextlost', onLost);

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
    () => { if (lavaLight) lavaLight.intensity = 0; if (backLight) backLight.intensity = 0; },
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
    // Wide enough across for the whole field: on a phone held upright the lens opens up.
    camera.fov = Math.max(46, THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(27)) / camera.aspect)));
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

  /** Copies one frame of an animated strip into its canvas texture, when the frame has changed. */
  function animate(texture, source, frame, size) {
    const g = texture.image.getContext('2d');
    g.clearRect(0, 0, size, size);
    g.drawImage(source, 0, frame * size, size, size, 0, 0, size, size);
    texture.needsUpdate = true;
  }

  let raf = 0;
  let last = performance.now();
  let clock = 0;
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
    shading.tick(now / 1000);
    const elapsed = (now - last) / 1000;
    const dt = Math.min(0.05, elapsed);
    last = now;
    if (lost || host.offsetParent === null || document.visibilityState !== 'visible') return;
    clock += dt;
    governor.frame(elapsed);
    resize();
    frameShot(clock);
    const k = reduce ? 1 : 1 - Math.exp(-dt * 2.4);
    cam.pos.lerp(goalPos, k);
    cam.look.lerp(goalLook, k);
    camera.position.copy(cam.pos);
    if (shake > 0.01 && !reduce) {
      camera.position.x += (Math.random() - 0.5) * shake * 0.2;
      camera.position.y += (Math.random() - 0.5) * shake * 0.2;
    }
    shake *= Math.exp(-dt * 3.2);
    camera.lookAt(cam.look);

    // The lava runs through its frames; the fall's flow and the pool's slow churn.
    const stillFrame = reduce ? 0 : Math.floor(clock * 10) % lava.stillFrames;
    if (stillFrame !== lava.stillFrame) { lava.stillFrame = stillFrame; animate(lava.still, img.lava_still, stillFrame, 16); }
    const flowFrame = reduce ? 0 : Math.floor(clock * 7) % lava.flowFrames;
    if (flowFrame !== lava.flowFrame) { lava.flowFrame = flowFrame; animate(lava.flow, img.lava_flow, flowFrame, 32); }
    if (!reduce) lava.flow.offset.y = (clock * 0.35) % 1;
    if (lavaLight) lavaLight.intensity = 7.5 + (reduce ? 0 : Math.sin(clock * 3.1) * 0.8 + Math.sin(clock * 7.3) * 0.4);
    fieldLight.intensity = FIELD_LIGHT + (reduce ? 0 : Math.sin(clock * 11) * 0.25 + Math.sin(clock * 17) * 0.15);
    if (!reduce && Math.random() < dt * 1.4) {
      const a = Math.random() * Math.PI * 2;
      lavaPops.emit({ x: lavaAt.x + (Math.random() - 0.5) * 2.4, y: -0.05, z: lavaAt.z + (Math.random() - 0.5) * 1.4, vx: Math.cos(a) * 0.6, vy: 2.6 + Math.random(), vz: Math.sin(a) * 0.6, gravity: -9, life: 0.9, size: 0.12, sizeTo: 0.05, r: 1.4, g: 1.1, b: 0.8, fade: 0.3 });
    }
    // The torches' flames.
    if (!reduce) {
      for (const tip of flames) {
        if (Math.random() < dt * 2.2) flameSprites.emit({ x: tip.x, y: tip.y, z: tip.z, vy: 0.12, life: 0.5, size: 0.09, sizeTo: 0.02, r: 1.3, g: 1.1, b: 0.8, fade: 0.5 });
        if (Math.random() < dt * 0.8) smoke.emit({ x: tip.x, y: tip.y + 0.05, z: tip.z, vy: 0.35, life: 1, size: 0.08, sizeTo: 0.12, frame: 7, frameTo: 0, r: 0.25, g: 0.25, b: 0.27, a: 0.7, fade: 0.5 });
      }
    }

    // The field: blocks rising back, lifting under the cursor, jolted by a blast, live TNT swelling.
    const lit = hovered >= 0 ? hovered : focused;
    for (const t of tiles) {
      let s = 1;
      if (t.riseAt) {
        const r = (now - t.riseAt) / 260;
        if (r < 0) s = 0.001;
        else if (r < 1) s = easeOutBack(r);
        else t.riseAt = 0;
      }
      if (t.popAt) {
        const p = (now - t.popAt) / 220;
        if (p >= 0 && p < 1) s *= 1 + Math.sin(p * Math.PI) * 0.08;
        else if (p >= 1) t.popAt = 0;
      }
      if (t.state === 'lit') {
        const e = now - t.litAt;
        // TntRenderer: white every other five ticks, and in the last ten ticks a swell to 1.3.
        const white = Math.floor(e / 250) % 2 === 0;
        for (const m of tntLive) m.emissive.setScalar(white ? 0.85 : 0);
        const left = FUSE_MS - e;
        if (left < SWELL_MS) {
          let f = clamp01(1 - left / SWELL_MS);
          f *= f;
          f *= f;
          s *= 1 + f * 0.3;
        }
      }
      const want = t.tile === lit && t.state === 'stone' ? 0.06 : 0;
      t.lift += (want - t.lift) * (reduce ? 1 : 1 - Math.exp(-dt * 18));
      t.jx *= Math.exp(-dt * 7);
      t.jz *= Math.exp(-dt * 7);
      t.mesh.scale.setScalar(s);
      t.mesh.position.set(t.x + t.jx, s / 2 + t.lift, t.z + t.jz);
      // A dropped item turns and bobs, as ItemEntityRenderer turns and bobs it.
      if (t.item) {
        const age = (now - t.born) / 1000;
        const it = t.item;
        if (t.flying) {
          const f = clamp01((now - t.flying.at) / 380);
          if (f >= 1) {
            scene.remove(it.holder, it.holder.userData.shadow);
            t.item = null;
            t.flying = null;
            t.glow.visible = false;
            controls.onCue?.('collect');
            continue;
          }
          if (f > 0) {
            const from = t.flying.from;
            it.holder.position.set(lerp(from.x, STEVE_AT.x, f), lerp(from.y, 1.2, f) + Math.sin(f * Math.PI) * 0.8, lerp(from.z, STEVE_AT.z, f));
            it.holder.scale.setScalar(lerp(0.62, 0.2, f));
          }
        } else {
          const up = reduce ? 1 : easeOut(clamp01(age / 0.35));
          it.holder.position.y = lerp(0.35, 0.72, up) + (reduce ? 0 : Math.sin(age * 2 + it.phase) * 0.07);
          it.holder.rotation.set(-0.35, 0, 0);
          it.spin.rotation.y = reduce ? 0.5 : age * 1.6 + it.phase;
        }
        t.glow.material.opacity = 0.32 + (reduce ? 0 : Math.sin(age * 2.4 + it.phase) * 0.06);
      }
    }
    if (lit >= 0 && tiles[lit].state === 'stone' && active) {
      outline.visible = true;
      outline.position.copy(tiles[lit].mesh.position);
      outline.material.color.setHex(hovered >= 0 ? 0x000000 : 0xffffff);
      outline.material.opacity = hovered >= 0 ? 0.6 : 0.9;
    } else {
      outline.visible = false;
    }
    if (crack.visible && miner.target) crack.position.copy(miner.target.mesh.position);

    // The blast: its puffs on schedule, the flash dying away.
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

    // Steve: turned to the block he is mining, the pickaxe going; a hop, a cheer, a shake of the head.
    {
      const target = miner.target ? Math.atan2(miner.target.x - STEVE_AT.x, miner.target.z - STEVE_AT.z) : Math.PI / 2;
      let d = target - miner.yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      miner.yaw += d * (reduce ? 1 : 1 - Math.exp(-dt * 10));
      steve.rotation.y = miner.yaw;
      const swing = miner.swinging && !reduce ? Math.sin(((now / 260) % 1) * Math.PI) : 0;
      const cheering = now < miner.cheerUntil && !reduce;
      P.rightArm.rotation.x = miner.swinging ? -0.5 - swing * 1.5 : cheering ? -2.6 + Math.sin(clock * 14) * 0.3 : -0.3 + (reduce ? 0 : Math.sin(clock * 1.3) * 0.04);
      P.leftArm.rotation.x = cheering ? -2.7 + Math.sin(clock * 14 + 1) * 0.3 : 0;
      const sulking = now < miner.sulkUntil;
      P.head.rotation.x = miner.target ? 0.5 : sulking ? 0.6 : 0.2;
      P.head.rotation.y = sulking && !reduce ? Math.sin(clock * 12) * 0.25 : 0;
      steve.position.y = now < miner.hopUntil && !reduce ? Math.abs(Math.sin(((now - miner.hopStart) / 1000) * Math.PI * 2.4)) * 0.35 : 0;
      // The hurt flash the game puts on anything caught in a blast.
      const hurt = now < miner.hurtUntil;
      steveMat.color.setRGB(1, hurt ? 0.45 : 1, hurt ? 0.45 : 1);
    }
    // The creeper: a slow walk up and down the back of the cave, a pause, a look at the camera.
    {
      const walking = now >= crawl.pauseUntil && !reduce;
      if (walking) {
        crawl.x += crawl.dir * dt * 0.75;
        crawl.walk += dt * 9;
        if (crawl.x > 3 || crawl.x < -3) {
          crawl.dir = -crawl.dir;
          crawl.x = Math.max(-3, Math.min(3, crawl.x));
          crawl.pauseUntil = now + 1800 + Math.random() * 2500;
        }
      }
      creeper.position.set(crawl.x, now < crawl.hopUntil && !reduce ? Math.sin(((now - crawl.hopStart) / 500) * Math.PI) * 0.5 : 0, crawl.z);
      creeperShadow.position.set(crawl.x, 0.015, crawl.z);
      creeper.rotation.y = walking ? (crawl.dir > 0 ? Math.PI / 2 : -Math.PI / 2) : 0;
      poseQuadruped(creeperModel.parts, crawl.walk, walking ? 0.6 : 0, walking ? 0 : 0.15);
      creeperModel.parts.head.rotation.y = walking ? 0 : Math.sin(clock * 0.7) * 0.35;
      const hurt = now < crawl.hurtUntil;
      creeperMat.color.setRGB(1, hurt ? 0.45 : 1, hurt ? 0.45 : 1);
    }
    for (let i = fireworksDue.length - 1; i >= 0; i -= 1) {
      if (now < fireworksDue[i].at) continue;
      const [f] = fireworksDue.splice(i, 1);
      firework(f.x, f.y, f.z);
      controls.onCue?.('firework');
    }
    // The hanging lanterns sway a little on their chains.
    for (const h of hanging) {
      const sway = reduce ? 0 : Math.sin(clock * 0.9 + h.phase) * 0.035;
      h.chain.rotation.z = sway;
      h.lantern.position.x = h.x - Math.sin(sway) * 5.3;
      h.lantern.rotation.z = sway;
    }
    if (!reduce) {
      halos.material.opacity = 0.5 + Math.sin(clock * 11) * 0.04 + Math.sin(clock * 17) * 0.03;
      if (Math.random() < dt * 5) {
        dust.emit({ x: (Math.random() - 0.5) * 9, y: 0.3 + Math.random() * 3.2, z: (Math.random() - 0.5) * 8 - 0.5, vx: (Math.random() - 0.5) * 0.08, vy: 0.03, vz: (Math.random() - 0.5) * 0.08, life: 6, size: 0.05, r: 1.2, g: 1, b: 0.75, a: 0.55, fadeIn: 0.3, fade: 0.4 });
      }
    }
    for (const t of tiles) if (t.item?.holder.userData.shadow) t.item.holder.userData.shadow.visible = !t.flying;
    for (const s of sprites) s.step(dt);
    if (composer) composer.render(dt);
    else renderer.render(scene, camera);
  }

  resize();
  frameShot(0);
  cam.pos.copy(goalPos);
  cam.look.copy(goalLook);
  // Compiled now, the TNT and the diamond included, so the first of either costs no frame.
  {
    const warm = [new THREE.Mesh(box, tntMats), new THREE.Mesh(box, tntDim), new THREE.Mesh(box, oreDim), new THREE.Mesh(box, tntLive), new THREE.Mesh(diamond.geometry, diamond.material)];
    warm.forEach((m, i) => { m.position.set(-40 + i * 2, -20, 0); scene.add(m); });
    try { renderer.compile(scene, camera); } catch { /* compiled on first use */ }
    warm.forEach((m) => scene.remove(m));
  }
  raf = requestAnimationFrame(frame);

  const controls = {
    onLost: null,
    /** Called with a block the player clicked in the cave. */
    onPick: null,
    /** 'crack' (with the stage), 'break', 'gem', 'fuse', 'boom', 'collect', 'firework'. */
    onCue: null,
    tier: tier.name,

    /** Whether blocks can be picked. */
    setActive(on) {
      active = on;
      if (!on) hovered = -1;
    },
    /** The block the keyboard is on, outlined in white; -1 for none. */
    setFocus(tile) {
      focused = tile;
    },
    /** Puts the field back as a game the server describes: the blocks already mined, a diamond on each. */
    setBoard(revealed) {
      const now = performance.now();
      for (const t of tiles) {
        setStone(t);
        t.riseAt = 0;
      }
      for (const tile of revealed) {
        const t = tiles[tile];
        t.state = 'gem';
        t.mesh.visible = false;
        dropDiamond(t, now - 2000);
      }
    },
    /** Mines `tile`; `tnt` says what was in it. Resolves when the block is gone (or has gone off). */
    async dig(tile, tnt) {
      const t = tiles[tile];
      hovered = -1;
      if (!tnt) {
        await mine(t, STAGE_MS.gem);
        breakStone(t);
        t.state = 'gem';
        const now = performance.now();
        dropDiamond(t, now);
        twinkle(new THREE.Vector3(t.x, 0.8, t.z), 10);
        controls.onCue?.('gem');
        miner.hopStart = now;
        miner.hopUntil = now + 420;
        miner.target = null;
        await wait(200);
        return;
      }
      await mine(t, STAGE_MS.tnt);
      // Under the stone, TNT -- and the pickaxe has lit it.
      chip(chips, t.x, 0.5, t.z, 18, 0.9, 2.2);
      controls.onCue?.('break');
      t.mesh.material = tntLive;
      t.state = 'lit';
      t.litAt = performance.now();
      controls.onCue?.('fuse');
      await wait(FUSE_MS);
      const now = performance.now();
      t.state = 'gone';
      t.mesh.visible = false;
      for (const m of tntLive) m.emissive.setScalar(0);
      explode(new THREE.Vector3(t.x, 0.5, t.z), now);
      shake = 1.5;
      controls.onCue?.('boom');
      // Everything near is thrown back from it.
      for (const o of tiles) {
        if (o === t) continue;
        const dx = o.x - t.x;
        const dz = o.z - t.z;
        const d = Math.hypot(dx, dz);
        if (d < 2.6) {
          o.jx = (dx / d) * 0.22 * (2.6 - d);
          o.jz = (dz / d) * 0.22 * (2.6 - d);
        }
      }
      miner.target = null;
      miner.hurtUntil = now + 350;
      miner.sulkUntil = now + 1700;
      crawl.hopStart = now;
      crawl.hopUntil = now + 500;
      crawl.hurtUntil = now + 350;
      await wait(420);
    },
    /** The game is over: what was in every block left standing, rippling out from `from`. */
    reveal(tntTiles, from = null) {
      const now = performance.now();
      const mines = new Set(tntTiles);
      const centre = from !== null && from >= 0 ? tiles[from] : { x: 0, z: 0 };
      for (const t of tiles) {
        if (t.state !== 'stone') continue;
        const d = Math.hypot(t.x - centre.x, t.z - centre.z);
        const at = reduce ? 0 : d * 60;
        t.state = mines.has(t.tile) ? 'tnt' : 'ore';
        const material = t.state === 'tnt' ? tntDim : oreDim;
        setTimeout(() => {
          if (t.state === 'tnt' || t.state === 'ore') {
            t.mesh.material = material;
            t.popAt = performance.now();
          }
        }, at);
        if (at === 0) {
          t.mesh.material = material;
          t.popAt = now;
        }
      }
    },
    /** Pulled out at `bps`: the diamonds fly to Steve, and the bigger the haul the more he cheers. */
    celebrate(bps) {
      const x = bps / 10_000;
      const now = performance.now();
      let i = 0;
      for (const t of tiles) {
        if (!t.item) continue;
        t.flying = { at: now + (reduce ? 0 : 120 + i * 70), from: t.item.holder.position.clone() };
        i += 1;
      }
      orbsFrom(new THREE.Vector3(0, 1, 0), Math.min(16, 3 + Math.round(Math.log2(Math.max(1, x)) * 3)));
      miner.hopStart = now;
      miner.hopUntil = now + (x >= 10 ? 2400 : 900);
      if (x >= 3) miner.cheerUntil = now + (x >= 10 ? 2600 : 1400);
      if (x >= 5) {
        const count = x >= 25 ? 5 : x >= 10 ? 3 : 1;
        for (let k = 0; k < count; k += 1) fireworksDue.push({ at: now + 300 + k * 380 + Math.random() * 200, x: (Math.random() - 0.5) * 8, y: 4.5 + Math.random() * 1.5, z: -3 - Math.random() * 2 });
      }
      if (x >= 10) shake = 0.4;
    },
    /** A fresh field: every block stone again, built back up from the floor. */
    reset(animated = true) {
      const now = performance.now();
      const changed = tiles.some((t) => t.state !== 'stone');
      for (const t of tiles) {
        setStone(t);
        t.popAt = 0;
        t.riseAt = animated && changed && !reduce ? now + (Math.floor(t.tile / GRID) + (t.tile % GRID)) * 28 : 0;
      }
    },
    dispose() {
      cancelAnimationFrame(raf);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('click', onClick);
      canvas.removeEventListener('webglcontextlost', onLost);
      composer?.dispose();
      shading.dispose();
      renderer.dispose();
      canvas.remove();
    },
  };
  return controls;
}
