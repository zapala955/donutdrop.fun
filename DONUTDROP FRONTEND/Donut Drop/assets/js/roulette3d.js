/* roulette3d.js — the shared roulette wheel in 3D, in a hall of a Nether fortress, blazes keeping
 * watch over it.
 *
 * Every block, item, particle and model is the game's own, out of the client jar: the nether bricks
 * of the hall, red and chiseled, the polished blackstone of the wheel's bowl and its pedestal, the
 * gilded blackstone of its cone, the pockets in red, black and green concrete with their numbers in
 * the game's font, the gold-block frets and turret, the fire charge for a ball, the lava falling
 * down the walls, magma, soul sand and nether wart, lanterns and soul lanterns, a blaze spawner, and
 * the blazes on BlazeModel, their twelve rods turning as the game turns them. What is drawn rather
 * than taken is light: the lava's and the lanterns' glow and their halos, the fire a running ball
 * trails, a lamp over the wheel throwing the turret's and the frets' shadows, a pocket lit when the
 * ball settles in it.
 *
 * Nothing here decides anything. roulette.js has the round's result from the server and says which
 * pocket to land in and how long the spin may take; this module turns the wheel and runs the ball so
 * it comes to rest in that pocket exactly then. If WebGL is missing or the context is lost,
 * roulette.js shows the flat wheel.
 *
 * Low-end machines get less (quality3d.js): no glow, fewer particles, one warm light, a steady thirty
 * frames a second; a machine that cannot keep up steps down on its own.
 */
import { reduceMotion } from './util.js';
import { getTHREE, loadImage, softDot } from './mc3d.js';
import { BLAZE, buildModel, makeSprites, pixelTexture, placeEntity, poseBlaze } from './mcmodels.js';
import { blobShadow, glowPoints, gradePass, ironChain, shadowMaterial } from './scenery3d.js';
import { fontFromImage, drawText, textWidth } from './mcfont.js';
import { BRIGHTNESS, chooseTier, createGovernor, frameMs, minFpsFor, ratioFor } from './quality3d.js';
import { shadeScene, shadedTHREE, smoothen } from './shade3d.js';

const R_RIM = 3.2;      // the bowl's lip
const R_TRACK = 2.72;   // where the ball runs
const R_POCKET = 1.98;  // where it comes to rest
const R_HEAD = 2.4;     // the turning head: pockets and numbers out to here
const R_CONE = 1.55;    // the cone rises from here
const HEAD_Y = -0.3;    // the pockets' floor
const BALL = 0.32;      // the fire charge's sprite
const IDLE_SPIN = 0.22; // the head turning on its own, radians a second
const CELL = { w: 24, h: 40 };

const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
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

/**
 * Builds the hall into `host` and resolves with its controls, or null when this browser cannot draw
 * it. `order` is the wheel's numbers in their order round it, `red` the red ones.
 */
export async function createRoulette3d(host, { order, red }) {
  const threeCore = await getTHREE();
  const probe = document.createElement('canvas');
  const probeGl = probe.getContext('webgl2');
  if (!probeGl) return null;
  const tier = chooseTier(probeGl);
  // Physical materials on medium and high, Lambert on low: the lit look (shade3d.js).
  const THREE = shadedTHREE(threeCore, tier);
  probeGl.getExtension('WEBGL_lose_context')?.loseContext();
  const canvas = document.createElement('canvas');
  canvas.className = 'roulette__gl';
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
  const BLOCKS = ['nether_bricks', 'red_nether_bricks', 'chiseled_nether_bricks', 'cracked_nether_bricks', 'red_concrete', 'black_concrete',
    'green_concrete', 'gold_block', 'polished_blackstone_bricks', 'gilded_blackstone', 'polished_basalt_top', 'polished_basalt_side',
    'lava_still', 'lava_flow', 'magma', 'soul_sand', 'nether_wart_stage2', 'lantern', 'soul_lantern', 'spawner', 'iron_chain', 'raw_gold_block'];
  const PARTICLE = ['flame', 'lava', ...Array.from({ length: 8 }, (_, i) => `generic_${i}`)];
  let loaded;
  try {
    loaded = await Promise.all([
      Promise.all(BLOCKS.map((name) => loadImage(`assets/img/block/${name}.png`))),
      Promise.all(PARTICLE.map((name) => loadImage(`assets/img/particle/${name}.png`))),
      loadImage('assets/img/entity/blaze.png'),
      loadImage('assets/img/items/fire_charge.png'),
      loadImage('assets/img/gui/ascii.png'),
      loadImage('assets/img/misc/shadow.png'),
      tier.composer
        ? import(/* @vite-ignore */ new URL('assets/vendor/three-addons.js', document.baseURI).href).catch(() => null)
        : Promise.resolve(null),
    ]);
  } catch {
    renderer.dispose();
    return null;
  }
  const [blockImgs, particleImgs, blazeImg, chargeImg, fontImg, shadowImg, addons] = loaded;
  const img = Object.fromEntries(BLOCKS.map((name, i) => [name, blockImgs[i]]));
  const part = Object.fromEntries(PARTICLE.map((name, i) => [name, particleImgs[i]]));
  const font = fontFromImage(fontImg);
  host.prepend(canvas);

  const reduce = reduceMotion();
  const scene = new THREE.Scene();
  const HAZE = 0x2a0806;
  scene.background = new THREE.Color(0x140403);
  scene.fog = new THREE.FogExp2(HAZE, 0.04);
  const shading = shadeScene(THREE, { tier, renderer, scene, env: { top: 0x1a0606, horizon: 0x8a3a12, ground: 0x2a0c06, intensity: 0.5 }, wind: false });
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
  scene.add(camera);

  let composer = null;
  let bloom = null;
  if (addons) {
    try {
      const target = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: tier.samples });
      composer = new addons.EffectComposer(renderer, target);
      composer.addPass(new addons.RenderPass(scene, camera));
      bloom = new addons.UnrealBloomPass(new THREE.Vector2(4, 4), 0.5, 0.45, 0.88);
      composer.addPass(bloom);
      composer.addPass(new addons.OutputPass());
      composer.addPass(gradePass(THREE, addons, { sharpen: 0, contrast: 1.09, saturation: 1.1, lift: [0.03, 0.008, 0.0], gain: [1.05, 0.98, 0.92], vignette: 0.15 }));
      // Smooth, not sharp: soft shadow in the corners, and the edges blended (shade3d.js).
      smoothen(THREE, addons, composer, camera, { tier, ao: 0.6 });
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
  /** One frame of an animated block texture, as its own canvas texture. */
  const frameTex = (name, frame = 0, size = 16) => {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    c.getContext('2d').drawImage(img[name], 0, frame * size, size, size, 0, 0, size, size);
    return pixelTexture(THREE, c);
  };
  const lambert = (map, opts = {}) => new THREE.MeshLambertMaterial({ map, ...opts });

  /* ── light: the Nether's red murk, warm light over the wheel, the lava's glow ── */
  scene.add(new THREE.HemisphereLight(0xff9a70, 0x2a0e0a, tier.name === 'low' ? 1.05 : 0.8));
  const fill = new THREE.DirectionalLight(0xffe2c8, 0.75);
  fill.position.set(-2, 9, 7);
  scene.add(fill, fill.target);
  const WHEEL_LIGHT = tier.name === 'low' ? 9 : 7.5;
  const wheelLight = new THREE.PointLight(0xffd6a6, WHEEL_LIGHT, 13, 1.3);
  wheelLight.position.set(0, 4.2, 0.6);
  scene.add(wheelLight);
  // Where the machine can afford it, a lamp over the wheel throws the turret's and the frets' shadows
  // across the pockets, and the wheel's on the pedestal.
  const shadows = tier.name !== 'low';
  if (shadows) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const lamp = new THREE.SpotLight(0xffe0b0, 30, 18, 0.55, 0.6, 1.3);
    lamp.position.set(1.6, 8.5, 2.4);
    lamp.target.position.set(0, -0.3, 0);
    lamp.castShadow = true;
    lamp.shadow.mapSize.set(tier.name === 'high' ? 2048 : 1024, tier.name === 'high' ? 2048 : 1024);
    lamp.shadow.bias = -0.0006;
    lamp.shadow.normalBias = 0.015;
    scene.add(lamp, lamp.target);
  }
  const shadowMat = shadowMaterial(THREE, shadowImg, 0.55);

  /* ── the hall: a nether brick floor and walls, lava down two of them ── */
  const lava = { still: frameTex('lava_still'), flow: frameTex('lava_flow', 0, 32), stillFrame: -1, flowFrame: -1 };
  lava.stillFrames = Math.max(1, Math.floor(img.lava_still.naturalHeight / 16));
  lava.flowFrames = Math.max(1, Math.floor(img.lava_flow.naturalHeight / 32));
  for (const t of [lava.still, lava.flow]) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  const LAVA_GLOW = new THREE.Color(1.25, 1.12, 1.05);
  const FLOOR_Y = -1;
  const BACK_Z = -8;
  {
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(34, 26).rotateX(-Math.PI / 2), lambert(tex('nether_bricks', 34, 26)));
    floor.position.set(0, FLOOR_Y, -1);
    floor.receiveShadow = true;
    scene.add(floor);
    const rand = seeded(13);
    const box = new THREE.BoxGeometry(1, 1, 1);
    const walls = { nether_bricks: [], red_nether_bricks: [], chiseled_nether_bricks: [], cracked_nether_bricks: [] };
    const height = 9;
    const put = (x, y, z) => {
      const band = y === 2 || y === 6;
      const r = rand();
      const name = band ? (r < 0.5 ? 'red_nether_bricks' : 'chiseled_nether_bricks') : r < 0.12 ? 'cracked_nether_bricks' : 'nether_bricks';
      walls[name].push([x, y + FLOOR_Y + 0.5, z]);
    };
    const falls = [-5, 6];
    for (let x = -13; x <= 13; x += 1) {
      for (let y = 0; y < height; y += 1) if (!falls.includes(x) || y < 0) put(x + 0.5, y, BACK_Z - 0.5);
    }
    for (const side of [-1, 1]) {
      for (let z = BACK_Z; z < 4; z += 1) {
        for (let y = 0; y < (z > 0 ? 3 : height); y += 1) put(side * 13.5, y, z + 0.5);
      }
    }
    // Pillars round the wheel, four high, a lantern on each.
    for (const [x, z] of [[-4.5, -4.5], [4.5, -4.5], [-5.5, 2.5], [5.5, 2.5]]) {
      for (let y = 0; y < 3; y += 1) walls[y === 2 ? 'chiseled_nether_bricks' : 'nether_bricks'].push([x, y + FLOOR_Y + 0.5, z]);
    }
    const m = new THREE.Matrix4();
    for (const [name, list] of Object.entries(walls)) {
      if (!list.length) continue;
      const mesh = new THREE.InstancedMesh(box, lambert(tex(name)), list.length);
      list.forEach(([x, y, z], i) => mesh.setMatrixAt(i, m.makeTranslation(x, y, z)));
      scene.add(mesh);
    }
    // The lava falls, flowing down the wall, and the pools they fill.
    lava.flow.repeat.set(0.5, height * 0.5);
    lava.still.repeat.set(1, 2);
    for (const x of falls) {
      const fall = new THREE.Mesh(new THREE.BoxGeometry(0.98, height, 0.98), new THREE.MeshBasicMaterial({ map: lava.flow, color: LAVA_GLOW, toneMapped: false }));
      fall.position.set(x + 0.5, FLOOR_Y + height / 2, BACK_Z - 0.5);
      scene.add(fall);
      const pool = new THREE.Mesh(new THREE.PlaneGeometry(1, 2).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: lava.still, color: LAVA_GLOW, toneMapped: false }));
      pool.position.set(x + 0.5, FLOOR_Y + 0.01, BACK_Z + 1);
      scene.add(pool);
    }
    // Magma in the floor, soul sand and nether wart along the back.
    const magmaSpots = [[-8.5, -3.5], [8.5, -1.5], [-9.5, 1.5], [10.5, -5.5], [2.5, -6.5]];
    const magma = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), lambert(frameTex('magma'), { emissive: 0x7a2a08 }), magmaSpots.length);
    magmaSpots.forEach(([x, z], i) => magma.setMatrixAt(i, m.makeTranslation(x, FLOOR_Y + 0.004, z)));
    scene.add(magma);
    const soul = lambert(tex('soul_sand', 6, 1));
    const sand = new THREE.Mesh(new THREE.PlaneGeometry(6, 1).rotateX(-Math.PI / 2), soul);
    sand.position.set(-10, FLOOR_Y + 0.006, BACK_Z + 0.5);
    scene.add(sand);
    const wart = new THREE.MeshLambertMaterial({ map: tex('nether_wart_stage2'), alphaTest: 0.5, side: THREE.DoubleSide });
    // The crop as the game draws one: two crossed planes, all of them one draw.
    const warts = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), wart, 12);
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    let i = 0;
    for (let x = -12.5; x < -7; x += 1) {
      for (const r of [Math.PI / 4, -Math.PI / 4]) {
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r);
        warts.setMatrixAt(i, m.compose(new THREE.Vector3(x, FLOOR_Y + 0.5, BACK_Z + 0.5), q, one));
        i += 1;
      }
    }
    scene.add(warts);
  }
  const lavaAt = new THREE.Vector3(0.5, FLOOR_Y + 1, BACK_Z + 1);
  let lavaLight = null;
  if (tier.lights >= 2) {
    lavaLight = new THREE.PointLight(0xff6a20, 6, 14, 1.4);
    lavaLight.position.copy(lavaAt);
    scene.add(lavaLight);
  }

  /* ── lanterns on the pillars ── */
  const flames = [];
  {
    const PX = 1 / 16;
    const cut = (name, x, y, w, h) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      c.getContext('2d').drawImage(img[name], x, y, w, h, 0, 0, w, h);
      return pixelTexture(THREE, c);
    };
    let lights = 0;
    for (const [x, z, name] of [[-4.5, -4.5, 'soul_lantern'], [4.5, -4.5, 'soul_lantern'], [-5.5, 2.5, 'lantern'], [5.5, 2.5, 'lantern']]) {
      const soul = name === 'soul_lantern';
      const glow = new THREE.MeshBasicMaterial({ map: cut(name, 0, 2, 6, 7), color: soul ? new THREE.Color(0.9, 1.4, 1.6) : new THREE.Color(1.6, 1.3, 0.85), toneMapped: false });
      const cap = new THREE.MeshLambertMaterial({ map: cut(name, 0, 9, 6, 6) });
      const lantern = new THREE.Mesh(new THREE.BoxGeometry(6 * PX * 1.4, 7 * PX * 1.4, 6 * PX * 1.4), [glow, glow, cap, cap, glow, glow]);
      lantern.position.set(x, FLOOR_Y + 3 + 0.3, z);
      scene.add(lantern);
      flames.push({ at: lantern.position.clone(), soul });
      if (tier.lights >= 4 && lights < 2) {
        const light = new THREE.PointLight(soul ? 0x5ad8ff : 0xffb060, 3, 7, 1.6);
        light.position.copy(lantern.position);
        scene.add(light);
        lights += 1;
      }
    }
  }

  /* ── lanterns on chains over the wheel, the fortress's gold piled at the sides ── */
  const hanging = [];
  {
    const PX = 1 / 16;
    const cut = (name, x, y, w, h) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      c.getContext('2d').drawImage(img[name], x, y, w, h, 0, 0, w, h);
      return pixelTexture(THREE, c);
    };
    for (const [x, z, name] of [[-3.6, -3, 'lantern'], [3.6, -3, 'lantern'], [0, -4.4, 'soul_lantern']]) {
      const soul = name === 'soul_lantern';
      const glow = new THREE.MeshBasicMaterial({ map: cut(name, 0, 2, 6, 7), color: soul ? new THREE.Color(0.9, 1.4, 1.6) : new THREE.Color(1.6, 1.3, 0.85), toneMapped: false });
      const cap = new THREE.MeshLambertMaterial({ map: cut(name, 0, 9, 6, 6) });
      const chain = ironChain(THREE, img.iron_chain, 5);
      chain.position.set(x, 8, z);
      scene.add(chain);
      const lantern = new THREE.Mesh(new THREE.BoxGeometry(6 * PX * 1.6, 7 * PX * 1.6, 6 * PX * 1.6), [glow, glow, cap, cap, glow, glow]);
      lantern.position.set(x, 8 - 5 - 0.3, z);
      scene.add(lantern);
      hanging.push({ chain, lantern, x, z, soul, phase: x + z });
    }
    // Gold, as a bastion keeps it: blocks of it and of raw gold in low heaps.
    const box = new THREE.BoxGeometry(1, 1, 1);
    const gold = lambert(tex('gold_block'));
    const raw = lambert(tex('raw_gold_block'));
    const heaps = [];
    for (const [cx, cz] of [[-6.6, 0.2], [7, -0.6]]) {
      for (let y = 0; y < 3; y += 1) {
        const r = 2 - y;
        for (let dx = -r; dx <= r; dx += 1) for (let dz = -Math.min(r, 1); dz <= Math.min(r, 1); dz += 1) heaps.push([cx + dx, FLOOR_Y + y + 0.5, cz + dz, (dx + dz + y) % 3 === 0]);
      }
    }
    for (const [list, material] of [[heaps.filter((h) => !h[3]), gold], [heaps.filter((h) => h[3]), raw]]) {
      const mesh = new THREE.InstancedMesh(box, material, list.length);
      const mm = new THREE.Matrix4();
      list.forEach(([x, y, z], i) => mesh.setMatrixAt(i, mm.makeTranslation(x, y, z)));
      mesh.castShadow = true;
      scene.add(mesh);
    }
  }

  /* ── the pedestal and the wheel's bowl ── */
  const step = (Math.PI * 2) / order.length;
  const PED_R = 3.5;
  {
    const sideTex = tex('polished_blackstone_bricks', 22, 1);
    const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(PED_R, PED_R + 0.15, -FLOOR_Y, 64, 1, true), lambert(sideTex));
    pedestal.position.y = FLOOR_Y / 2;
    scene.add(pedestal);
    const topTex = tex('polished_blackstone_bricks', 4, 4);
    const top = new THREE.Mesh(new THREE.RingGeometry(R_RIM - 0.02, PED_R, 64, 1).rotateX(-Math.PI / 2), lambert(topTex));
    top.position.y = 0.001;
    scene.add(top);
    // The bowl: the lip, the ball track sloping in, the step down to the turning head.
    const profile = [[R_RIM, 0], [3.0, -0.02], [2.95, -0.08], [2.45, -0.22], [R_HEAD + 0.03, -0.24], [R_HEAD + 0.02, HEAD_Y - 0.05]].map(([r, y]) => new THREE.Vector2(r, y));
    const bowlTex = tex('polished_basalt_top', 28, 1);
    const bowl = new THREE.Mesh(new THREE.LatheGeometry(profile, 72), lambert(bowlTex, { side: THREE.DoubleSide }));
    scene.add(bowl);
  }
  /** The bowl's height at radius r, where the ball rolls. */
  const trackY = (r) => (r >= 2.95 ? lerp(-0.08, -0.02, (r - 2.95) / 0.05) : r >= 2.45 ? lerp(-0.22, -0.08, (r - 2.45) / 0.5) : HEAD_Y);

  /* ── the turning head: pockets with their numbers, frets, the cone and the turret ── */
  const head = new THREE.Group();
  scene.add(head);
  {
    // The pockets' faces: a strip of cells, each the pocket's concrete with its number on it in the
    // game's font, laid round the head.
    const strip = document.createElement('canvas');
    strip.width = CELL.w * order.length;
    strip.height = CELL.h;
    const g = strip.getContext('2d');
    g.imageSmoothingEnabled = false;
    order.forEach((number, i) => {
      const concrete = img[number === 0 ? 'green_concrete' : red.has(number) ? 'red_concrete' : 'black_concrete'];
      for (let y = 0; y < CELL.h; y += 16) for (let x = 0; x < CELL.w; x += 16) g.drawImage(concrete, i * CELL.w + x, y);
      const text = String(number);
      drawText(g, font, text, i * CELL.w + Math.round((CELL.w - textWidth(font, text)) / 2), 3, 1, '#ffffff');
    });
    const stripTex = pixelTexture(THREE, strip);
    const pos = [];
    const uv = [];
    const SEG = 3;
    order.forEach((_, i) => {
      for (let s = 0; s < SEG; s += 1) {
        const a0 = (i - 0.5 + s / SEG) * step;
        const a1 = (i - 0.5 + (s + 1) / SEG) * step;
        const u0 = (i + s / SEG) / order.length;
        const u1 = (i + (s + 1) / SEG) / order.length;
        const p = (a, r) => [Math.sin(a) * r, HEAD_Y, -Math.cos(a) * r];
        const quad = [[p(a0, R_CONE), [u0, 0]], [p(a1, R_CONE), [u1, 0]], [p(a1, R_HEAD), [u1, 1]], [p(a0, R_HEAD), [u0, 1]]];
        for (const k of [0, 1, 2, 0, 2, 3]) {
          pos.push(...quad[k][0]);
          uv.push(...quad[k][1]);
        }
      }
    });
    const ringGeo = new THREE.BufferGeometry();
    ringGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    ringGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    ringGeo.computeVertexNormals();
    const pockets = new THREE.Mesh(ringGeo, lambert(stripTex));
    pockets.receiveShadow = true;
    head.add(pockets);
    // Gold frets between the pockets.
    const gold = lambert(tex('gold_block'));
    const fret = new THREE.BoxGeometry(0.04, 0.1, R_HEAD - R_CONE);
    const frets = new THREE.InstancedMesh(fret, gold, order.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const mid = (R_HEAD + R_CONE) / 2;
    order.forEach((_, i) => {
      const a = (i + 0.5) * step;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -a);
      m.compose(new THREE.Vector3(Math.sin(a) * mid, HEAD_Y + 0.05, -Math.cos(a) * mid), q, new THREE.Vector3(1, 1, 1));
      frets.setMatrixAt(i, m);
    });
    frets.castShadow = true;
    frets.receiveShadow = true;
    head.add(frets);
    // The cone, gilded blackstone, rising to the turret.
    const cone = new THREE.Mesh(new THREE.LatheGeometry([[R_CONE, HEAD_Y], [1.3, HEAD_Y + 0.12], [0.75, 0.02], [0.45, 0.06]].map(([r, y]) => new THREE.Vector2(r, y)), 48), lambert(tex('gilded_blackstone', 8, 1)));
    cone.receiveShadow = true;
    head.add(cone);
    // The turret: a gold block with four arms.
    const turret = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.42, 0.42), gold);
    turret.position.y = 0.27;
    turret.castShadow = true;
    head.add(turret);
    for (let k = 0; k < 4; k += 1) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.55), gold);
      const a = k * (Math.PI / 2);
      arm.position.set(Math.sin(a) * 0.45, 0.32, -Math.cos(a) * 0.45);
      arm.rotation.y = -a;
      head.add(arm);
    }
  }
  // The pocket the ball came to rest in, lit from below.
  const pocketGlow = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.85).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: softDot('rgba(255,220,140,1)'), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
  head.add(pocketGlow);

  /* ── the ball: a fire charge, drawn as its sprite turned to the camera ── */
  const ball = new THREE.Mesh(new THREE.PlaneGeometry(BALL, BALL), new THREE.MeshBasicMaterial({ map: pixelTexture(THREE, chargeImg), alphaTest: 0.5, color: new THREE.Color(1.35, 1.25, 1.15), toneMapped: false }));
  scene.add(ball);
  // Its fire, lighting the wood round it, so it reads on the dark pockets.
  const ballGlow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: softDot('rgba(255,170,80,1)'), transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
  ballGlow.scale.setScalar(BALL * 3.2);
  scene.add(ballGlow);

  /* ── blazes keeping watch, and the spawner they come from ── */
  // Full bright, as the game draws a blaze, a shade under white so the glow does not swallow it.
  const blazeMat = new THREE.MeshBasicMaterial({ map: pixelTexture(THREE, blazeImg), alphaTest: 0.5, color: new THREE.Color(0.8, 0.78, 0.74) });
  const blazes = Array.from({ length: tier.name === 'low' ? 2 : 3 }, (_, k) => {
    const model = buildModel(THREE, [{ material: blazeMat, def: BLAZE }]);
    const entity = placeEntity(THREE, model, 1 / 16);
    scene.add(entity);
    const shadow = blobShadow(THREE, shadowMat, 0.55);
    scene.add(shadow);
    entity.userData.shadow = shadow;
    // Each keeps to its own stretch of the hall behind the wheel, never between it and the camera.
    return { model, entity, centre: -Math.PI / 2 + (k - 1) * 0.85, a: 0, r: 4.7 + (k % 2) * 0.5, h: 0.25 + k * 0.3, speed: 0.18 + k * 0.05, ticks: k * 37 };
  });
  {
    const spawner = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ map: tex('spawner'), alphaTest: 0.3, side: THREE.DoubleSide }));
    spawner.position.set(-9.5, FLOOR_Y + 0.5, -5.5);
    scene.add(spawner);
    const model = buildModel(THREE, [{ material: blazeMat, def: BLAZE }]);
    const tiny = placeEntity(THREE, model, 1 / 16 * 0.32);
    tiny.position.set(-9.5, FLOOR_Y + 0.3, -5.5);
    scene.add(tiny);
    blazes.push({ model, entity: tiny, caged: true, ticks: 0, spin: 0 });
  }

  /* ── particles ── */
  const sprites = [];
  const sprite = (map, opts) => {
    const s = makeSprites(THREE, { map, ...opts });
    scene.add(s.points);
    sprites.push(s);
    return s;
  };
  const flame = sprite(pixelTexture(THREE, part.flame), { count: scale(220), additive: true });
  const embers = sprite(pixelTexture(THREE, part.lava), { count: scale(60), additive: true });
  const smoke = sprite((() => {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 8;
    const g = c.getContext('2d');
    for (let i = 0; i < 8; i += 1) g.drawImage(part[`generic_${i}`], i * 8, 0);
    return pixelTexture(THREE, c);
  })(), { cols: 8, rows: 1, count: scale(160) });
  const charges = sprite(pixelTexture(THREE, chargeImg), { count: scale(12) });
  const halos = glowPoints(THREE, [...flames.map((f) => [f.at.x, f.at.y, f.at.z]), ...hanging.map((h) => [h.x, h.lantern.position.y, h.z]), [-4.5, FLOOR_Y + 1.2, BACK_Z + 0.2], [6.5, FLOOR_Y + 1.2, BACK_Z + 0.2], [-4.5, FLOOR_Y + 4.5, BACK_Z], [6.5, FLOOR_Y + 4.5, BACK_Z]], { size: 2, color: 0xffa050, opacity: 0.55 });
  scene.add(halos.points);
  function burst(x, y, z, n, speed = 2) {
    if (reduce) return;
    for (let i = 0; i < scale(n); i += 1) {
      const u = Math.random() * 2 - 1;
      const a = Math.random() * Math.PI * 2;
      const rr = Math.sqrt(1 - u * u);
      flame.emit({ x, y, z, vx: Math.cos(a) * rr * speed, vy: u * speed + 0.6, vz: Math.sin(a) * rr * speed, drag: 2.2, life: 0.5 + Math.random() * 0.5, size: 0.16, sizeTo: 0.04, r: 1.4, g: 1.2, b: 0.9, fade: 0.4 });
    }
    for (let i = 0; i < scale(Math.round(n / 3)); i += 1) {
      smoke.emit({ x: x + (Math.random() - 0.5) * 0.4, y, z: z + (Math.random() - 0.5) * 0.4, vx: (Math.random() - 0.5) * 0.6, vy: 0.6 + Math.random() * 0.5, vz: (Math.random() - 0.5) * 0.6, drag: 0.5, life: 1.2 + Math.random() * 0.6, size: 0.3, sizeTo: 0.6, frame: 7, frameTo: 0, r: 0.3, g: 0.28, b: 0.28, a: 0.8, fade: 0.5 });
    }
  }
  const volleys = [];

  /* ─────────── the spin ─────────── */

  let wheelAngle = 0;        // the head's turn, radians clockwise from above
  let ballRel = 0;           // the ball's angle on the head
  let ballR = R_POCKET;
  let ballY = HEAD_Y + BALL / 2;
  let spin = null;           // { start, ms, from, to, rel0, rel1, wheel0, extra }
  let restIndex = 0;
  let settledAt = 0;
  let shake = 0;
  const pocketAngle = (index) => index * step;
  function rest(index) {
    restIndex = index;
    spin = null;
    ballRel = pocketAngle(index);
    ballR = R_POCKET;
    ballY = HEAD_Y + BALL / 2;
  }
  function placeGlow(index) {
    const a = pocketAngle(index);
    const r = (R_CONE + R_HEAD) / 2;
    pocketGlow.position.set(Math.sin(a) * r, HEAD_Y + 0.02, -Math.cos(a) * r);
    pocketGlow.rotation.y = -a;
  }

  /* ─────────── the camera: above the wheel, from the front ─────────── */

  const cam = { pos: new THREE.Vector3(), look: new THREE.Vector3() };
  const goalPos = new THREE.Vector3();
  const goalLook = new THREE.Vector3(0, -0.35, -1.05);
  function frameShot(clock, spinning) {
    const sway = reduce ? 0 : Math.sin(clock * 0.15) * 0.35;
    // A little closer while the ball is running.
    goalPos.set(sway, spinning ? 5.2 : 5.6, spinning ? 5.7 : 6.4);
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
    () => { if (lavaLight) lavaLight.intensity = 0; },
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
    // Wide enough across for the whole wheel: on a narrow screen the lens opens up.
    camera.fov = Math.max(42, THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(24)) / camera.aspect)));
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

  function animateStrip(texture, source, frame, size) {
    const g = texture.image.getContext('2d');
    g.clearRect(0, 0, size, size);
    g.drawImage(source, 0, frame * size, size, size, 0, 0, size, size);
    texture.needsUpdate = true;
  }

  let raf = 0;
  let last = performance.now();
  let clock = 0;
  let lastBounce = 0;
  const v = new THREE.Vector3();
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

    // The wheel and the ball. Spinning, the head is thrown round faster and slows back to its own
    // pace; the ball runs the other way on the track, slows, drops in, rattles, and is in its pocket
    // when the spin's time is up.
    if (spin) {
      const u = clamp01((now - spin.start) / spin.ms);
      const t = (now - spin.start) / 1000;
      wheelAngle = spin.wheel0 + (reduce ? 0 : IDLE_SPIN * t + spin.extra * (1 - (1 - u) ** 3));
      const glide = 1 - (1 - u) ** 2.2;
      ballRel = lerp(spin.rel0, spin.rel1, glide);
      const drop = clamp01((u - 0.58) / 0.22);
      ballR = lerp(R_TRACK, R_POCKET, drop * drop * (3 - 2 * drop));
      let hop = 0;
      if (u > 0.78 && u < 0.97) {
        // The rattle: a few hops between frets, each lower than the last.
        const k = (u - 0.78) / 0.19;
        hop = Math.abs(Math.sin(k * Math.PI * 4)) * 0.16 * (1 - k);
        ballRel += Math.sin(k * Math.PI * 4) * 0.07 * (1 - k);
        const bounce = Math.floor(k * 4);
        if (bounce !== lastBounce) {
          lastBounce = bounce;
          controls.onCue?.('bounce', bounce);
        }
      }
      ballY = (ballR > R_HEAD ? trackY(ballR) : lerp(trackY(R_HEAD + 0.01), HEAD_Y, clamp01((R_HEAD - ballR) / 0.15))) + BALL / 2 + hop;
      if (u >= 1) {
        rest(spin.index);
        settledAt = now;
        placeGlow(restIndex);
        controls.onCue?.('settle');
      }
    } else if (!reduce) {
      wheelAngle += IDLE_SPIN * dt;
    }
    head.rotation.y = -wheelAngle;
    const ballAngle = wheelAngle + ballRel;
    ball.position.set(Math.sin(ballAngle) * ballR, ballY, -Math.cos(ballAngle) * ballR);
    ball.quaternion.copy(camera.quaternion);
    if (!reduce && spin) {
      ball.rotateZ(clock * 9);
      if (Math.random() < dt * 40) flame.emit({ x: ball.position.x, y: ball.position.y, z: ball.position.z, vx: (Math.random() - 0.5) * 0.2, vy: 0.35, vz: (Math.random() - 0.5) * 0.2, life: 0.35, size: 0.11, sizeTo: 0.03, r: 1.4, g: 1.1, b: 0.75, fade: 0.6 });
    }
    ballGlow.position.copy(ball.position);
    ballGlow.quaternion.copy(camera.quaternion);
    const glow = settledAt ? clamp01(1 - (now - settledAt) / 2600) : 0;
    pocketGlow.material.opacity = glow * 0.85;

    // The camera.
    frameShot(clock, Boolean(spin));
    const k = reduce ? 1 : 1 - Math.exp(-dt * 1.6);
    cam.pos.lerp(goalPos, k);
    cam.look.lerp(goalLook, k);
    camera.position.copy(cam.pos);
    if (shake > 0.01 && !reduce) {
      camera.position.x += (Math.random() - 0.5) * shake * 0.12;
      camera.position.y += (Math.random() - 0.5) * shake * 0.12;
    }
    shake *= Math.exp(-dt * 3.5);
    camera.lookAt(cam.look);

    // The lava through its frames.
    const stillFrame = reduce ? 0 : Math.floor(clock * 10) % lava.stillFrames;
    if (stillFrame !== lava.stillFrame) { lava.stillFrame = stillFrame; animateStrip(lava.still, img.lava_still, stillFrame, 16); }
    const flowFrame = reduce ? 0 : Math.floor(clock * 7) % lava.flowFrames;
    if (flowFrame !== lava.flowFrame) { lava.flowFrame = flowFrame; animateStrip(lava.flow, img.lava_flow, flowFrame, 32); }
    if (!reduce) lava.flow.offset.y = (clock * 0.35) % 1;
    if (lavaLight) lavaLight.intensity = 5.5 + (reduce ? 0 : Math.sin(clock * 3.3) * 0.7);
    wheelLight.intensity = WHEEL_LIGHT + (reduce ? 0 : Math.sin(clock * 9) * 0.2);
    if (!reduce && Math.random() < dt * 4) {
      const x = Math.random() < 0.5 ? -4.5 : 6.5;
      embers.emit({ x: x + (Math.random() - 0.5) * 0.8, y: FLOOR_Y + 0.1, z: BACK_Z + 1 + Math.random(), vx: (Math.random() - 0.5) * 0.5, vy: 2.4 + Math.random() * 1.2, vz: (Math.random() - 0.2) * 0.6, gravity: -6, life: 0.9, size: 0.1, sizeTo: 0.04, r: 1.4, g: 1.1, b: 0.8, fade: 0.3 });
    }

    // The blazes: drifting round the wheel, bobbing, their rods turning; flames and smoke off them.
    for (const b of blazes) {
      b.ticks += dt * 20;
      poseBlaze(b.model.parts, reduce ? 0 : b.ticks);
      if (b.caged) {
        b.entity.rotation.y += reduce ? 0 : dt * 2.5;
        continue;
      }
      b.a = b.centre + (reduce ? 0 : Math.sin(clock * b.speed + b.ticks * 0.001) * 0.4);
      const y = b.h + (reduce ? 0 : Math.sin(clock * 1.3 + b.centre * 3) * 0.25);
      b.entity.position.set(Math.cos(b.a) * b.r, y, Math.sin(b.a) * b.r * 0.85 - 0.6);
      b.entity.userData.shadow?.position.set(b.entity.position.x, FLOOR_Y + 0.02, b.entity.position.z);
      b.entity.rotation.y = Math.atan2(-b.entity.position.x, -b.entity.position.z);
      b.model.parts.head.rotation.x = 0.35;
      if (!reduce && Math.random() < dt * 5) {
        flame.emit({ x: b.entity.position.x + (Math.random() - 0.5) * 0.7, y: y + 0.6 + Math.random() * 0.8, z: b.entity.position.z + (Math.random() - 0.5) * 0.7, vy: 0.3, life: 0.6, size: 0.12, sizeTo: 0.03, r: 1.4, g: 1.15, b: 0.8, fade: 0.5 });
      }
      if (!reduce && Math.random() < dt * 2) {
        smoke.emit({ x: b.entity.position.x + (Math.random() - 0.5) * 0.6, y: y + 0.8, z: b.entity.position.z, vy: 0.5, life: 1.1, size: 0.18, sizeTo: 0.35, frame: 7, frameTo: 0, r: 0.25, g: 0.22, b: 0.22, a: 0.7, fade: 0.5 });
      }
    }
    // The lanterns' flames flicker a spark now and then.
    if (!reduce) {
      for (const f of flames) {
        if (Math.random() < dt * 1.2) flame.emit({ x: f.at.x, y: f.at.y + 0.1, z: f.at.z, vy: 0.2, life: 0.5, size: 0.07, sizeTo: 0.02, r: f.soul ? 0.6 : 1.4, g: f.soul ? 1.3 : 1.1, b: f.soul ? 1.5 : 0.8, fade: 0.5 });
      }
    }
    // Fire charges the blazes loose for a winner, bursting overhead.
    for (let i = volleys.length - 1; i >= 0; i -= 1) {
      const f = volleys[i];
      if (now < f.at) continue;
      if (!f.flying) {
        f.flying = true;
        charges.emit({ x: f.from.x, y: f.from.y, z: f.from.z, vx: (f.to.x - f.from.x) / 0.7, vy: (f.to.y - f.from.y) / 0.7, vz: (f.to.z - f.from.z) / 0.7, life: 0.7, size: 0.3, fade: 0.05 });
        controls.onCue?.('shoot');
        continue;
      }
      if (now >= f.at + 700) {
        volleys.splice(i, 1);
        burst(f.to.x, f.to.y, f.to.z, 36, 2.6);
        controls.onCue?.('burst');
      }
    }
    if (!reduce) halos.material.opacity = 0.55 + Math.sin(clock * 9) * 0.05;
    for (const h of hanging) {
      const sway = reduce ? 0 : Math.sin(clock * 0.8 + h.phase) * 0.03;
      h.chain.rotation.z = sway;
      h.lantern.position.x = h.x - Math.sin(sway) * 5.3;
      h.lantern.rotation.z = sway;
    }
    for (const s of sprites) s.step(dt);
    if (composer) composer.render(dt);
    else renderer.render(scene, camera);
  }

  const controls = {
    onLost: null,
    /** 'bounce' (with which), 'settle', 'shoot', 'burst'. */
    onCue: null,
    tier: tier.name,

    /** The ball at rest in the pocket at `index` of the wheel's order. */
    rest(index) {
      if (index < 0) return;
      rest(index);
    },
    /** Runs the ball into the pocket at `index`, coming to rest in `ms` milliseconds. */
    spin(index, ms) {
      if (index < 0) return;
      if (reduce || ms < 400) {
        rest(index);
        settledAt = performance.now();
        placeGlow(index);
        return;
      }
      // The ball starts on the track at the front of the wheel and runs against the wheel's turn.
      const startAbs = Math.PI;
      const rel0 = startAbs - wheelAngle;
      let rel1 = pocketAngle(index);
      const turns = Math.max(3, Math.round(ms / 900));
      while (rel1 > rel0 - turns * Math.PI * 2) rel1 -= Math.PI * 2;
      spin = { start: performance.now(), ms, index, wheel0: wheelAngle, extra: Math.PI * 1.5, rel0, rel1 };
      settledAt = 0;
      lastBounce = -1;
    },
    /** The round paid this player: the blazes loose fire charges over the wheel. */
    cheer(big = false) {
      if (reduce) return;
      const now = performance.now();
      const shooters = blazes.filter((b) => !b.caged);
      const count = big ? 6 : 3;
      for (let i = 0; i < count; i += 1) {
        const b = shooters[i % shooters.length];
        volleys.push({ at: now + i * 220, from: b.entity.position.clone().add(v.set(0, 1, 0)), to: new THREE.Vector3((Math.random() - 0.5) * 4, 3.4 + Math.random(), -1 - Math.random() * 2) });
      }
      if (big) shake = 0.5;
    },
    dispose() {
      cancelAnimationFrame(raf);
      canvas.removeEventListener('webglcontextlost', onLost);
      composer?.dispose();
      shading.dispose();
      renderer.dispose();
      canvas.remove();
    },
  };

  resize();
  frameShot(0, false);
  cam.pos.copy(goalPos);
  cam.look.copy(goalLook);
  rest(0);
  try { renderer.compile(scene, camera); } catch { /* compiled on first use */ }
  raf = requestAnimationFrame(frame);
  return controls;
}
