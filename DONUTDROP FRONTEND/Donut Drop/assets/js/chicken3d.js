/* chicken3d.js — Chicken in 3D: a chicken, twenty rail lines across a meadow, and a minecart on
 * one of them.
 *
 * Every block, item, particle and model is the game's own, out of the client jar: the meadow, the
 * rails on their gravel, the oak sign at every line with what reaching it pays written in the game's
 * font, the chicken on ChickenModel walking and flapping as the game moves it, the minecart on
 * MinecartModel, hay bales and fences at the start, flowers at the far side, the feathers and puff a
 * chicken leaves when something hits it, the hearts, the egg, the experience orbs, a farm at the start
 * with its house, cows and sheep grazing and hens pecking, the game's own round shadows under them,
 * and its fancy clouds overhead. What is drawn rather than taken is light: the next line glowing,
 * the sky, the sun.
 *
 * Nothing here decides anything. chicken.js owns the run: it says how far the chicken has got, what
 * each line pays on the run's difficulty, and, step by step, whether the minecart came. If WebGL is
 * missing or the context is lost, chicken.js shows the flat road.
 *
 * Low-end machines get less (quality3d.js): no glow, fewer particles and flowers, a steady thirty
 * frames a second; a machine that cannot keep up steps down on its own.
 */
import { reduceMotion } from './util.js';
import { getTHREE, loadImage, softDot } from './mc3d.js';
import { CHICKEN, COW, MINECART, SHEEP, SHEEP_FUR, VILLAGER, buildModel, makeSprites, pixelTexture, placeEntity, poseChicken } from './mcmodels.js';
import { blobShadow, fancyClouds, gradePass, grazers, shadowMaterial, villageHouse, villagers } from './scenery3d.js';
import { fontFromImage, drawText, textWidth } from './mcfont.js';
import { BRIGHTNESS, chooseTier, createGovernor, frameMs, minFpsFor, ratioFor } from './quality3d.js';

const LANES = 20;
const LANE = 2;            // a rail line every two blocks
const CURB = 4;            // the meadow before the first line
const RAIL_LEN = 90;
const HOP_MS = 360;
const PLAINS_GRASS = 0x91bd59;

const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
const lerp = (a, b, t) => a + (b - a) * t;
const easeInOut = (t) => t * t * (3 - 2 * t);
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
/** The middle of line `lane` (0-19); -1 is the starting curb, 20 the far side. */
export const laneX = (lane) => (lane < 0 ? CURB - 1.5 : CURB + lane * LANE + LANE / 2);

/**
 * Builds the meadow into `host` and resolves with its controls, or null when this browser cannot
 * draw it.
 */
export async function createChicken3d(host) {
  const THREE = await getTHREE();
  const probe = document.createElement('canvas');
  const probeGl = probe.getContext('webgl2');
  if (!probeGl) return null;
  const tier = chooseTier(probeGl);
  probeGl.getExtension('WEBGL_lose_context')?.loseContext();
  const canvas = document.createElement('canvas');
  canvas.className = 'chicken__gl';
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
  const BLOCKS = ['grass_block_top', 'dirt', 'gravel', 'rail', 'oak_planks', 'oak_sign', 'hay_block_side', 'hay_block_top', 'oak_log',
    'oak_log_top', 'oak_leaves', 'short_grass', 'poppy', 'dandelion', 'cornflower', 'oxeye_daisy', 'cobblestone', 'glass', 'oak_door_top',
    'oak_door_bottom'];
  const ENTITY = ['chicken', 'minecart', 'experience_orb', 'cow', 'sheep', 'sheep_wool', 'villager', 'villager_plains', 'villager_farmer'];
  const PARTICLE = ['heart', ...Array.from({ length: 8 }, (_, i) => `generic_${i}`)];
  let loaded;
  try {
    loaded = await Promise.all([
      Promise.all(BLOCKS.map((name) => loadImage(`assets/img/block/${name}.png`))),
      Promise.all(ENTITY.map((name) => loadImage(`assets/img/entity/${name}.png`))),
      Promise.all(PARTICLE.map((name) => loadImage(`assets/img/particle/${name}.png`))),
      loadImage('assets/img/items/feather.png'),
      loadImage('assets/img/items/egg.png'),
      loadImage('assets/img/gui/ascii.png'),
      loadImage('assets/img/misc/shadow.png'),
      loadImage('assets/img/env/clouds.png'),
      loadImage('assets/img/env/sun.png'),
      tier.composer
        ? import(/* @vite-ignore */ new URL('assets/vendor/three-addons.js', document.baseURI).href).catch(() => null)
        : Promise.resolve(null),
    ]);
  } catch {
    renderer.dispose();
    return null;
  }
  const [blockImgs, entityImgs, particleImgs, featherImg, eggImg, fontImg, shadowImg, cloudImg, sunImg, addons] = loaded;
  const img = Object.fromEntries(BLOCKS.map((name, i) => [name, blockImgs[i]]));
  const ent = Object.fromEntries(ENTITY.map((name, i) => [name, entityImgs[i]]));
  const part = Object.fromEntries(PARTICLE.map((name, i) => [name, particleImgs[i]]));
  const font = fontFromImage(fontImg);
  host.prepend(canvas);

  const reduce = reduceMotion();
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x78a7ff);
  scene.fog = new THREE.Fog(0xb9d3ff, 40, 150);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 400);
  scene.add(camera);

  let composer = null;
  let bloom = null;
  if (addons) {
    try {
      const target = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: tier.samples });
      composer = new addons.EffectComposer(renderer, target);
      composer.addPass(new addons.RenderPass(scene, camera));
      bloom = new addons.UnrealBloomPass(new THREE.Vector2(4, 4), 0.35, 0.4, 0.95);
      composer.addPass(bloom);
      composer.addPass(new addons.OutputPass());
      composer.addPass(gradePass(THREE, addons, { contrast: 1.06, saturation: 1.14, lift: [0.01, 0.015, 0.03], gain: [1.03, 1.01, 0.96], vignette: 0.3 }));
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

  /* ── light: a clear day, the sun casting shadows where the machine can afford them ── */
  scene.add(new THREE.HemisphereLight(0xd8e6ff, 0x5a7048, 1.05));
  const sunLight = new THREE.DirectionalLight(0xfff0d8, 1.75);
  const SUN_OFFSET = new THREE.Vector3(-14, 30, 18);
  sunLight.position.copy(SUN_OFFSET);
  scene.add(sunLight, sunLight.target);
  const shadows = tier.name !== 'low';
  if (shadows) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.set(tier.name === 'high' ? 2048 : 1024, tier.name === 'high' ? 2048 : 1024);
    Object.assign(sunLight.shadow.camera, { left: -22, right: 22, top: 18, bottom: -18, near: 1, far: 90 });
    sunLight.shadow.bias = -0.0006;
    sunLight.shadow.normalBias = 0.03;
  }

  /* ── the sky: blue deepening overhead, the sun, the game's fancy clouds ── */
  const sky = new THREE.Mesh(new THREE.SphereGeometry(300, 24, 12), new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: { uTop: { value: new THREE.Color(0x3f7cf0) }, uLow: { value: new THREE.Color(0xbcd6ff) } },
    vertexShader: 'varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform vec3 uTop; uniform vec3 uLow; varying vec3 vDir;
      void main() {
        gl_FragColor = vec4(mix(uLow, uTop, smoothstep(0.0, 0.55, vDir.y)), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  }));
  sky.renderOrder = -10;
  scene.add(sky);
  const sun = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: pixelTexture(THREE, sunImg), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false, color: new THREE.Color(1.5, 1.4, 1.2) }));
  sun.renderOrder = -9;
  scene.add(sun);
  const SUN_DIR = SUN_OFFSET.clone().normalize();
  const clouds = fancyClouds(THREE, cloudImg, { y: 46, radius: tier.name === 'low' ? 170 : 240 });
  scene.add(clouds.group);
  const shadowMat = shadowMaterial(THREE, shadowImg);

  /* ── the meadow, the gravel beds and the rails on them ── */
  const ROAD_END = CURB + LANES * LANE;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const one = new THREE.Vector3(1, 1, 1);
  const up = new THREE.Vector3(0, 1, 0);
  {
    const grass = new THREE.Mesh(new THREE.PlaneGeometry(260, 200).rotateX(-Math.PI / 2), lambert(tex('grass_block_top', 260, 200), { color: PLAINS_GRASS }));
    grass.position.set(ROAD_END / 2, 0, -20);
    grass.receiveShadow = true;
    scene.add(grass);
    // Each line: a gravel bed a block and a half across, the rail along it.
    const bed = new THREE.InstancedMesh(new THREE.BoxGeometry(1.5, 0.12, RAIL_LEN), lambert(tex('gravel', 1.5, RAIL_LEN)), LANES);
    const railTex = tex('rail', 1, RAIL_LEN);
    const rail = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, RAIL_LEN).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ map: railTex, alphaTest: 0.5 }), LANES);
    for (let lane = 0; lane < LANES; lane += 1) {
      bed.setMatrixAt(lane, m.makeTranslation(laneX(lane), 0.06, -RAIL_LEN / 2 + 20));
      rail.setMatrixAt(lane, m.makeTranslation(laneX(lane), 0.125, -RAIL_LEN / 2 + 20));
    }
    bed.receiveShadow = true;
    rail.receiveShadow = true;
    scene.add(bed, rail);
    // Plants on the grass between the lines and either side of the road.
    const rand = seeded(5);
    const plants = { short_grass: [], poppy: [], dandelion: [], cornflower: [], oxeye_daisy: [] };
    const count = tier.name === 'low' ? 500 : 1100;
    for (let i = 0; i < count; i += 1) {
      const x = -24 + rand() * (ROAD_END + 48);
      const z = -40 + rand() * 50;
      // Not on a rail bed, and not on the chicken's path across.
      const onBed = x > CURB && x < ROAD_END && Math.abs(((x - CURB) % LANE) - LANE / 2) < 0.9;
      if (onBed || Math.abs(z) < 1.3) continue;
      const r = rand();
      const kind = r < 0.8 ? 'short_grass' : r < 0.85 ? 'poppy' : r < 0.9 ? 'dandelion' : r < 0.95 ? 'cornflower' : 'oxeye_daisy';
      plants[kind].push([x, z]);
    }
    for (const [name, list] of Object.entries(plants)) {
      if (!list.length) continue;
      const tint = name === 'short_grass' ? { color: PLAINS_GRASS } : {};
      const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), lambert(tex(name), { alphaTest: 0.5, side: THREE.DoubleSide, ...tint }), list.length * 2);
      list.forEach(([x, z], i) => {
        for (const [k, a] of [[0, Math.PI / 4], [1, -Math.PI / 4]]) {
          q.setFromAxisAngle(up, a);
          mesh.setMatrixAt(i * 2 + k, m.compose(new THREE.Vector3(x, 0.5, z), q, one));
        }
      });
      scene.add(mesh);
    }
    // Hay bales and an oak fence at the start; a few oaks out in the meadow.
    const hay = [lambert(tex('hay_block_side')), lambert(tex('hay_block_top'))];
    for (const [x, y, z] of [[-1, 0.5, -3], [-1, 1.5, -3], [0.2, 0.5, -3.2], [-2.3, 0.5, -2.6], [ROAD_END + 3, 0.5, -3]]) {
      const bale = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), [hay[0], hay[0], hay[1], hay[1], hay[0], hay[0]]);
      bale.position.set(x, y, z);
      scene.add(bale);
    }
    const planks = lambert(tex('oak_planks'));
    const post = new THREE.BoxGeometry(0.25, 1.5, 0.25);
    const rails = new THREE.BoxGeometry(0.125, 0.19, 2);
    for (let z = -9; z <= 7; z += 2) {
      if (Math.abs(z) < 2) continue;
      for (const x of [-3.5, ROAD_END + 5.5]) {
        const p = new THREE.Mesh(post, planks);
        p.position.set(x, 0.75, z);
        scene.add(p);
        for (const y of [0.55, 1.15]) {
          const r = new THREE.Mesh(rails, planks);
          r.position.set(x, y, z + 1);
          scene.add(r);
        }
      }
    }
    const box = new THREE.BoxGeometry(1, 1, 1);
    const logs = [];
    const leaves = [];
    for (const [x, z] of [[-12, -14], [10, -22], [27, -16], [46, -24], [58, -12], [-8, -30], [35, -34], [70, -20]]) {
      for (let y = 0; y < 5; y += 1) logs.push([x, y + 0.5, z]);
      for (let dy = 3; dy <= 6; dy += 1) {
        const rr = dy >= 5 ? 1 : 2;
        for (let dx = -rr; dx <= rr; dx += 1) {
          for (let dz = -rr; dz <= rr; dz += 1) if ((dx || dz || dy >= 5) && !(Math.abs(dx) === rr && Math.abs(dz) === rr)) leaves.push([x + dx, dy + 0.5, z + dz]);
        }
      }
    }
    const logMat = [lambert(tex('oak_log')), lambert(tex('oak_log_top'))];
    const logMesh = new THREE.InstancedMesh(box, [logMat[0], logMat[0], logMat[1], logMat[1], logMat[0], logMat[0]], logs.length);
    logs.forEach(([x, y, z], i) => logMesh.setMatrixAt(i, m.makeTranslation(x, y, z)));
    const leafMesh = new THREE.InstancedMesh(box, lambert(tex('oak_leaves'), { color: 0x77ab2f, alphaTest: 0.5 }), leaves.length);
    leaves.forEach(([x, y, z], i) => leafMesh.setMatrixAt(i, m.makeTranslation(x, y, z)));
    logMesh.castShadow = true;
    leafMesh.castShadow = true;
    scene.add(logMesh, leafMesh);
    for (const o of scene.children) if (o.isMesh && o.geometry?.type === 'BoxGeometry' && !o.castShadow) o.castShadow = true;
  }

  /* ── the farm at the start: a house, a cow and sheep grazing, hens pecking by the hay ── */
  const blockTex = (name) => pixelTexture(THREE, img[name]);
  scene.add(villageHouse(THREE, blockTex, { at: [-7, 0, -16], w: 6, d: 5 }));
  const herd = grazers(THREE, scene, [
    { def: COW, image: ent.cow },
    { def: SHEEP, image: ent.sheep, fur: { def: SHEEP_FUR, image: ent.sheep_wool, color: 0xf9fffe } },
  ], [[-1.5, -9, 0], [-4.5, -7.5, 1], [0.8, -12, 1], [-6, -10.5, 0], [-2.5, -13, 1]], { shadowMat });
  // The farmer, between the hay and the house.
  const farmer = villagers(THREE, scene, VILLAGER, [ent.villager, ent.villager_plains, ent.villager_farmer], [[[-3.6, -6.5], [-0.5, -8.2], [-5.2, -9.5]]], { shadowMat });
  const hens = [[-2.6, -4.2], [-4.4, -2.6], [-1.2, -5.6]].map(([x, z], i) => {
    const model = buildModel(THREE, [{ material: new THREE.MeshLambertMaterial({ map: pixelTexture(THREE, ent.chicken), alphaTest: 0.5 }), def: CHICKEN }]);
    const entity = placeEntity(THREE, model, 1 / 16);
    entity.position.set(x, 0, z);
    entity.rotation.y = i * 2.1;
    scene.add(entity);
    const shadow = blobShadow(THREE, shadowMat, 0.3);
    shadow.position.set(x, 0.02, z);
    scene.add(shadow);
    return { model, entity, phase: i * 1.7 };
  });

  /* ── an oak sign at every line, what reaching it pays written on it in the game's font ── */
  const SIGN_W = 1.5;
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
    const stick = new THREE.Mesh(new THREE.BoxGeometry(2 / 16, 14 / 16, 2 / 16), lambert(pixelTexture(THREE, cut(28, 0, 2, 14))));
    for (let lane = 0; lane < LANES; lane += 1) {
      const face = document.createElement('canvas');
      face.width = 96;
      face.height = 48;
      const texture = pixelTexture(THREE, face);
      const front = new THREE.MeshLambertMaterial({ map: texture });
      const sign = new THREE.Group();
      const board = new THREE.Mesh(new THREE.BoxGeometry(SIGN_W, SIGN_W / 2, 2 / 16), [wood, wood, wood, wood, front, wood]);
      board.position.y = 14 / 16 + SIGN_W / 4;
      const pole = stick.clone();
      pole.position.y = 7 / 16;
      sign.add(board, pole);
      sign.position.set(laneX(lane), 0.12, -2.2);
      sign.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      scene.add(sign);
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
  function writeSign(lane, text, tone) {
    const s = signs[lane];
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
    s.front.color.setHex(tone === 'next' ? 0xffffff : tone === 'done' ? 0x9a9a9a : 0xe8e8e8);
    s.front.emissive.setHex(tone === 'next' ? 0x3a3018 : 0x000000);
  }
  // The next line, lit along its length.
  const nextGlow = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 26).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: softDot('rgba(255,230,140,1)'), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
  scene.add(nextGlow);

  /* ── the chicken and the minecart ── */
  const chickenMat = new THREE.MeshLambertMaterial({ map: pixelTexture(THREE, ent.chicken), alphaTest: 0.5 });
  const chickenModel = buildModel(THREE, [{ material: chickenMat, def: CHICKEN }]);
  const hen = placeEntity(THREE, chickenModel, 1 / 16);
  hen.rotation.y = Math.PI / 2; // facing along the road, the way it crosses
  scene.add(hen);
  const henShadow = blobShadow(THREE, shadowMat, 0.32);
  scene.add(henShadow);
  const cartModel = buildModel(THREE, [{ material: new THREE.MeshLambertMaterial({ map: pixelTexture(THREE, ent.minecart), side: THREE.DoubleSide }), def: MINECART }]);
  // MinecartRenderer: the model turned over and lifted so its floor is an eighth above the rail.
  cartModel.root.rotation.x = Math.PI;
  cartModel.root.position.y = 6;
  const cart = new THREE.Group();
  const cartScale = new THREE.Group();
  cartScale.scale.setScalar(1 / 16);
  cartScale.add(cartModel.root);
  cart.add(cartScale);
  cart.rotation.y = Math.PI / 2; // along the line
  cart.visible = false;
  scene.add(cart);
  const cartShadow = blobShadow(THREE, shadowMat, 0.7);
  scene.add(cartShadow);

  /* ── particles: the puff and feathers of a hit, hearts, an egg, experience ── */
  const sprites = [];
  const sprite = (map, opts) => {
    const s = makeSprites(THREE, { map, ...opts });
    scene.add(s.points);
    sprites.push(s);
    return s;
  };
  const poof = sprite((() => {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 8;
    const g = c.getContext('2d');
    for (let i = 0; i < 8; i += 1) g.drawImage(part[`generic_${i}`], i * 8, 0);
    return pixelTexture(THREE, c);
  })(), { cols: 8, rows: 1, count: scale(120) });
  const feathers = sprite(pixelTexture(THREE, featherImg), { count: scale(40) });
  const hearts = sprite(pixelTexture(THREE, part.heart), { count: scale(40) });
  const eggs = sprite(pixelTexture(THREE, eggImg), { count: 4 });
  const orbs = sprite(pixelTexture(THREE, ent.experience_orb), { cols: 4, rows: 4, count: scale(60), additive: true });

  /* ─────────── the run ─────────── */

  const state = { crossed: 0, labels: [], over: false, outcome: null, cartLane: null };
  const henAt = { x: laneX(-1), from: laneX(-1), to: laneX(-1), hopAt: 0, gone: false };
  let cartRun = null; // { start, lane, to }
  let cheerUntil = 0;
  let shake = 0;
  const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, reduce ? 0 : ms); });
  function hopTo(x) {
    henAt.from = henAt.x;
    henAt.to = x;
    henAt.hopAt = performance.now();
  }
  function paintSigns() {
    for (let lane = 0; lane < LANES; lane += 1) {
      const text = state.labels[lane] ?? '';
      const tone = lane < state.crossed ? 'done' : !state.over && lane === state.crossed ? 'next' : 'ahead';
      writeSign(lane, text, tone);
    }
  }
  function burst(x, z) {
    if (reduce) return;
    for (let i = 0; i < scale(26); i += 1) {
      poof.emit({ x: x + (Math.random() - 0.5) * 0.6, y: 0.4 + Math.random() * 0.4, z: z + (Math.random() - 0.5) * 0.6, vx: (Math.random() - 0.5) * 2, vy: Math.random() * 1.6, vz: (Math.random() - 0.5) * 2, drag: 1.5, life: 0.8 + Math.random() * 0.5, size: 0.3, sizeTo: 0.5, frame: 7, frameTo: 0, r: 0.95, g: 0.95, b: 0.95, fade: 0.5 });
    }
    for (let i = 0; i < scale(12); i += 1) {
      feathers.emit({ x, y: 0.6, z, vx: (Math.random() - 0.5) * 3, vy: 2 + Math.random() * 2, vz: (Math.random() - 0.5) * 3, gravity: -3, drag: 1.2, life: 1.6 + Math.random(), size: 0.3, fade: 0.4 });
    }
  }

  /* ─────────── the camera: alongside the road, keeping the chicken a third of the way in ─────────── */

  const cam = { pos: new THREE.Vector3(), look: new THREE.Vector3() };
  const goalPos = new THREE.Vector3();
  const goalLook = new THREE.Vector3();
  function frameShot() {
    const x = henAt.x + 3;
    goalLook.set(x, 1.1, -4);
    goalPos.set(x - 1.6, 3.5, 6.6);
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
    camera.fov = Math.max(42, THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(30)) / camera.aspect)));
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

  let raf = 0;
  let last = performance.now();
  let clock = 0;
  let walk = 0;
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

    // The chicken: a hop between lines, flapping; at rest a peck now and then.
    const h = reduce ? 1 : clamp01((now - henAt.hopAt) / HOP_MS);
    henAt.x = lerp(henAt.from, henAt.to, easeInOut(h));
    const hopping = h < 1;
    const cheering = now < cheerUntil && !reduce;
    const jump = hopping ? Math.sin(h * Math.PI) * 0.55 : cheering ? Math.abs(Math.sin(clock * 9)) * 0.3 : 0;
    hen.position.set(henAt.x, 0.12 + jump, 0);
    henShadow.position.set(henAt.x, 0.14, 0);
    henShadow.scale.setScalar(1 - jump * 0.5);
    henShadow.visible = !henAt.gone;
    if (hopping) walk += dt * 18;
    poseChicken(chickenModel.parts, walk, hopping ? 1 : 0, hopping || cheering ? Math.sin(clock * 30) * 0.9 + 0.9 : 0);
    chickenModel.parts.head.rotation.x = !hopping && !reduce && Math.sin(clock * 0.9) > 0.92 ? 0.7 : 0;
    hen.visible = !henAt.gone;
    // The next line glowing under the chicken's next step.
    if (!state.over && state.crossed < LANES) {
      nextGlow.position.set(laneX(state.crossed), 0.14, -2);
      nextGlow.material.opacity = 0.32 + (reduce ? 0 : Math.sin(clock * 3) * 0.08);
    } else {
      nextGlow.material.opacity = 0;
    }
    // The minecart coming down its line.
    if (cartRun) {
      const t = clamp01((now - cartRun.start) / cartRun.ms);
      cart.position.set(laneX(cartRun.lane), 0.12, lerp(cartRun.from, cartRun.to, t));
      cartShadow.position.set(cart.position.x, 0.14, cart.position.z);
      if (t >= 1) cartRun = null;
    }

    frameShot();
    const k = reduce ? 1 : 1 - Math.exp(-dt * 4);
    cam.pos.lerp(goalPos, k);
    cam.look.lerp(goalLook, k);
    camera.position.copy(cam.pos);
    if (shake > 0.01 && !reduce) {
      camera.position.x += (Math.random() - 0.5) * shake * 0.2;
      camera.position.y += (Math.random() - 0.5) * shake * 0.2;
    }
    shake *= Math.exp(-dt * 4);
    camera.lookAt(cam.look);
    cartShadow.visible = cart.visible;
    if (cart.visible && !cartRun) cartShadow.position.set(cart.position.x, 0.14, cart.position.z);
    // The farm going about its day.
    herd.step(dt, now, reduce);
    farmer.step(dt, now, clock, reduce);
    for (const h of hens) {
      const pecking = !reduce && Math.sin(clock * 1.3 + h.phase) > 0.6;
      h.model.parts.head.rotation.x = pecking ? 0.9 + Math.sin(clock * 18) * 0.25 : 0;
    }
    if (!reduce) clouds.step(dt);
    // The sun, and its shadows following the chicken across.
    sky.position.copy(camera.position);
    sun.position.copy(camera.position).addScaledVector(SUN_DIR, 260);
    sun.lookAt(camera.position);
    sun.scale.setScalar(26);
    if (shadows) {
      sunLight.target.position.set(henAt.x + 3, 0, -2);
      sunLight.position.copy(sunLight.target.position).add(SUN_OFFSET);
    }
    for (const s of sprites) s.step(dt);
    if (composer) composer.render(dt);
    else renderer.render(scene, camera);
  }

  const controls = {
    onLost: null,
    /** 'hop', 'cart', 'hit', 'egg'. */
    onCue: null,
    tier: tier.name,

    /**
     * The run as chicken.js has it: how many lines are `crossed`, what each line pays (`labels`),
     * and once it is `over`, its `outcome` and the line the minecart was on.
     */
    sync({ crossed = 0, labels = [], over = false, outcome = null, cartLane = null }) {
      const fresh = !over && crossed === 0 && (state.over || state.crossed > 0);
      Object.assign(state, { crossed, labels, over, outcome, cartLane });
      if (fresh) controls.reset();
      if (!hopping() && !henAt.gone) {
        const x = laneX(crossed - 1);
        if (Math.abs(henAt.to - x) > 0.01) {
          henAt.x = henAt.from = henAt.to = x;
        }
      }
      if (over && cartLane !== null && cartLane !== undefined && !cartRun && !cart.visible) {
        // The run is over another way: the minecart shows where it was waiting.
        cart.visible = true;
        cart.position.set(laneX(cartLane), 0.12, -4);
      }
      paintSigns();
    },
    /** The chicken steps onto `lane`; `hit` says the minecart is on it. Resolves when it is done. */
    async step(lane, hit) {
      hopTo(laneX(lane));
      controls.onCue?.('hop');
      await wait(HOP_MS);
      if (!hit) return;
      cart.visible = true;
      cartRun = { start: performance.now(), lane, from: -34, to: 0, ms: reduce ? 0 : 420 };
      controls.onCue?.('cart');
      await wait(400);
      henAt.gone = true;
      burst(laneX(lane), 0);
      shake = 1;
      controls.onCue?.('hit');
      await wait(350);
    },
    /** Cashed out at `bps`: hearts, an egg, experience. */
    celebrate(bps) {
      if (reduce) return;
      const x = bps / 10_000;
      const now = performance.now();
      cheerUntil = now + (x >= 5 ? 2200 : 1200);
      for (let i = 0; i < scale(8); i += 1) hearts.emit({ x: henAt.x + (Math.random() - 0.5) * 0.8, y: 0.8 + Math.random() * 0.4, z: (Math.random() - 0.5) * 0.6, vy: 0.6, life: 1.2, size: 0.25, fade: 0.4 });
      eggs.emit({ x: henAt.x, y: 0.5, z: 0.2, vx: 0.4, vy: 3, vz: 1.2, gravity: -9, life: 0.9, size: 0.4, fade: 0.2 });
      for (let i = 0; i < scale(Math.min(30, 6 + Math.round(Math.log2(Math.max(1, x)) * 5))); i += 1) {
        orbs.emit({ x: henAt.x + (Math.random() - 0.5) * 3, y: 0.3, z: (Math.random() - 0.5) * 3, vx: (Math.random() - 0.5) * 1.5, vy: 2 + Math.random() * 2, vz: (Math.random() - 0.5) * 1.5, gravity: -6, life: 1.2, size: 0.14, frame: Math.floor(Math.random() * 7), r: 0.8, g: 1, b: 0.2, fade: 0.3 });
      }
      controls.onCue?.('egg');
    },
    /** A fresh run: the chicken back on the curb, the minecart gone. */
    reset() {
      henAt.gone = false;
      henAt.x = henAt.from = henAt.to = laneX(-1);
      henAt.hopAt = 0;
      cart.visible = false;
      cartRun = null;
    },
    dispose() {
      cancelAnimationFrame(raf);
      canvas.removeEventListener('webglcontextlost', onLost);
      composer?.dispose();
      renderer.dispose();
      canvas.remove();
    },
  };
  function hopping() {
    return performance.now() - henAt.hopAt < HOP_MS;
  }

  resize();
  frameShot();
  cam.pos.copy(goalPos);
  cam.look.copy(goalLook);
  try { renderer.compile(scene, camera); } catch { /* compiled on first use */ }
  raf = requestAnimationFrame(frame);
  return controls;
}
