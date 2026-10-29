/* derby3d.js — Mob Derby in 3D: six farm mobs on a dirt-path track in the plains, a summer
 * afternoon, villagers along the rail.
 *
 * Every block, mob, item and particle is the game's own, out of the client jar: the pig on PigModel in
 * its skin, the cow and the mooshroom on CowModel, the sheep with SheepFurModel's wool over it (white,
 * and black for the outsider), the chicken on ChickenModel; the dirt path, the oak fences, the hay,
 * the flowers; the villagers on VillagerModel; the name tags in the game's own font; the dust kicked
 * up as the game breaks a block, and the fireworks. What is drawn rather than taken is light: the low
 * sun, its shadows (where the machine can afford them), the sky.
 *
 * Nothing here decides anything. derby.js sends the bet, and hands this the server's winner and the
 * track seed; derbyrace.js turns them into how the field runs. If WebGL is missing or the context is
 * lost, derby.js runs the flat lanes.
 */
import { reduceMotion } from './util.js';
import { getTHREE, loadImage, softDot } from './mc3d.js';
import {
  CHICKEN, COW, PIG, SHEEP, SHEEP_FUR, VILLAGER, atlas, buildModel, makeSprites, pixelTexture, placeEntity, poseChicken, poseQuadruped,
} from './mcmodels.js';
import { BRIGHTNESS, chooseTier, createGovernor, frameMs, minFpsFor, ratioFor } from './quality3d.js';
import { gradePass } from './scenery3d.js';
import { drawText, fontFromImage, textWidth } from './mcfont.js';

const TRACK = 46;            // blocks from the gate to the line
const LANE = 2.4;            // blocks between lanes
const START_X = 0;
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

/* How each racer is built: its model, its skin, and its wool if it has any. */
const BUILDS = {
  pig: { def: PIG, skin: 'pig' },
  cow: { def: COW, skin: 'cow' },
  sheep: { def: SHEEP, skin: 'sheep', fur: 0xf9fffe },
  chicken: { def: CHICKEN, skin: 'chicken' },
  mooshroom: { def: COW, skin: 'mooshroom', mushrooms: true },
  // DyeColor.BLACK's wool, 0x1d1d21.
  black_sheep: { def: SHEEP, skin: 'sheep', fur: 0x1d1d21 },
};

/**
 * Builds the track into `host` and resolves with its controls, or null when this browser cannot draw
 * it. `racers` is the config's field: [{ id, name, oddsX100 }] in lane order.
 */
export async function createDerby3d(host, { racers }) {
  const THREE = await getTHREE();
  const probe = document.createElement('canvas');
  const probeGl = probe.getContext('webgl2');
  if (!probeGl) return null;
  const tier = chooseTier(probeGl);
  probeGl.getExtension('WEBGL_lose_context')?.loseContext();
  const canvas = document.createElement('canvas');
  canvas.className = 'derby__gl';
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
  // The shader-pack sun: real shadows on medium and high, none on a low-end machine.
  const shadows = tier.name !== 'low';
  renderer.shadowMap.enabled = shadows;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const scale = (n) => Math.max(1, Math.round(n * tier.particles));
  const FRAME_MS = frameMs(tier);
  let nextFrameAt = 0;

  const BLOCKS = ['dirt_path_top', 'dirt_path_side', 'grass_block_top', 'grass_block_side', 'dirt', 'oak_planks', 'oak_log', 'oak_log_top',
    'oak_leaves', 'hay_block_side', 'hay_block_top', 'white_wool', 'black_wool', 'red_wool', 'short_grass', 'poppy', 'dandelion',
    'cornflower', 'oxeye_daisy', 'red_mushroom'];
  const ENTITY = ['pig', 'cow', 'mooshroom', 'sheep', 'sheep_wool', 'chicken', 'villager', 'villager_plains', 'experience_orb'];
  const ENV = ['sun', 'clouds'];
  const PARTICLE = ['heart', ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => `spark_${i}`)];
  let loaded;
  try {
    loaded = await Promise.all([
      Promise.all(BLOCKS.map((name) => loadImage(`assets/img/block/${name}.png`))),
      Promise.all(ENTITY.map((name) => loadImage(`assets/img/entity/${name}.png`))),
      Promise.all(ENV.map((name) => loadImage(`assets/img/env/${name}.png`))),
      Promise.all(PARTICLE.map((name) => loadImage(`assets/img/particle/${name}.png`))),
      loadImage('assets/img/gui/ascii.png'),
      tier.composer
        ? import(/* @vite-ignore */ new URL('assets/vendor/three-addons.js', document.baseURI).href).catch(() => null)
        : Promise.resolve(null),
    ]);
  } catch {
    renderer.dispose();
    return null;
  }
  const [blockImgs, entityImgs, envImgs, particleImgs, fontImg, addons] = loaded;
  const img = Object.fromEntries(BLOCKS.map((name, i) => [name, blockImgs[i]]));
  const ent = Object.fromEntries(ENTITY.map((name, i) => [name, entityImgs[i]]));
  const [sunImg, cloudsImg] = envImgs;
  const part = Object.fromEntries(PARTICLE.map((name, i) => [name, particleImgs[i]]));
  const font = fontFromImage(fontImg);
  host.prepend(canvas);

  const reduce = reduceMotion();
  const scene = new THREE.Scene();
  const SKY_FOG = new THREE.Color(0xbcd6ff);
  scene.fog = new THREE.FogExp2(SKY_FOG, 0.008);
  const camera = new THREE.PerspectiveCamera(44, 1, 0.1, 400);
  scene.add(camera);

  let composer = null;
  let bloom = null;
  if (addons) {
    try {
      const target = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: tier.samples });
      composer = new addons.EffectComposer(renderer, target);
      composer.addPass(new addons.RenderPass(scene, camera));
      bloom = new addons.UnrealBloomPass(new THREE.Vector2(4, 4), 0.35, 0.5, 1.2);
      composer.addPass(bloom);
      composer.addPass(new addons.OutputPass());
      composer.addPass(gradePass(THREE, addons, { contrast: 1.04, saturation: 1.08, lift: [0.008, 0.008, 0.012], gain: [1.02, 1.01, 0.98], vignette: 0.16 }));
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

  /* ── light: a warm sun from behind the camera's left, and the sky ── */
  const hemi = new THREE.HemisphereLight(0xcfe3ff, 0x5a6a3a, 1.25);
  scene.add(hemi);
  const SUN_DIR = new THREE.Vector3(-0.35, 0.62, 0.7).normalize();
  const sun = new THREE.DirectionalLight(0xffe2b8, 2.6);
  sun.position.copy(SUN_DIR).multiplyScalar(60).add(new THREE.Vector3(TRACK / 2, 0, 0));
  sun.target.position.set(TRACK / 2, 0, 0);
  if (shadows) {
    sun.castShadow = true;
    const size = tier.name === 'high' ? 2048 : 1024;
    sun.shadow.mapSize.set(size, size);
    sun.shadow.camera.left = -34;
    sun.shadow.camera.right = 34;
    sun.shadow.camera.top = 20;
    sun.shadow.camera.bottom = -20;
    sun.shadow.camera.near = 10;
    sun.shadow.camera.far = 140;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.03;
  }
  scene.add(sun, sun.target);
  const sky = new THREE.Mesh(new THREE.SphereGeometry(300, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: { uTop: { value: new THREE.Color(0x4f86e8) }, uLow: { value: new THREE.Color(0xc7deff) }, uSun: { value: SUN_DIR } },
    vertexShader: 'varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform vec3 uTop; uniform vec3 uLow; uniform vec3 uSun; varying vec3 vDir;
      void main() {
        vec3 col = mix(uLow, uTop, smoothstep(-0.05, 0.55, vDir.y));
        col += vec3(1.0, 0.85, 0.6) * pow(max(0.0, dot(normalize(vDir), uSun)), 24.0) * 0.5;
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  }));
  sky.renderOrder = -10;
  scene.add(sky);
  const sunDisc = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: pixelTexture(THREE, sunImg), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false }));
  sunDisc.renderOrder = -9;
  scene.add(sunDisc);
  /* The game's fancy clouds, slabs over the plains. */
  {
    const c = document.createElement('canvas');
    c.width = cloudsImg.naturalWidth;
    c.height = cloudsImg.naturalHeight;
    const g = c.getContext('2d');
    g.drawImage(cloudsImg, 0, 0);
    const data = g.getImageData(0, 0, c.width, c.height).data;
    const CELL = 8;
    const span = tier.name === 'low' ? 36 : 54;
    const list = [];
    for (let z = 0; z < span; z += 1) for (let x = 0; x < span; x += 1) if (data[(((z + 60) % c.height) * c.width + ((x + 30) % c.width)) * 4 + 3] > 127) list.push([x, z]);
    const clouds = new THREE.InstancedMesh(new THREE.BoxGeometry(CELL, CELL / 3, CELL), new THREE.MeshBasicMaterial({ color: 0xffffff }), list.length);
    const m = new THREE.Matrix4();
    list.forEach(([x, z], i) => clouds.setMatrixAt(i, m.makeTranslation((x - span / 2) * CELL + TRACK / 2, 48, (z - span * 0.8) * CELL)));
    scene.add(clouds);
  }

  /* ── the ground: grass all round, the dirt-path track, its fences and the line ── */
  const zOf = (lane) => (lane - (racers.length - 1) / 2) * LANE;
  const halfWidth = (racers.length / 2) * LANE + 0.6;
  const grassTex = tex('grass_block_top', 160, 160);
  const grass = new THREE.Mesh(new THREE.PlaneGeometry(160, 160), new THREE.MeshLambertMaterial({ map: grassTex, color: 0x91bd59 }));
  grass.rotation.x = -Math.PI / 2;
  grass.position.set(TRACK / 2, 0, 0);
  grass.receiveShadow = shadows;
  scene.add(grass);
  const pathLen = TRACK + 14;
  const path = new THREE.Mesh(new THREE.BoxGeometry(pathLen, 1, halfWidth * 2), [
    new THREE.MeshLambertMaterial({ map: tex('dirt_path_side', 1, 1) }), new THREE.MeshLambertMaterial({ map: tex('dirt_path_side', 1, 1) }),
    new THREE.MeshLambertMaterial({ map: tex('dirt_path_top', pathLen, halfWidth * 2) }), new THREE.MeshLambertMaterial({ map: tex('dirt') }),
    new THREE.MeshLambertMaterial({ map: tex('dirt_path_side', pathLen, 1) }), new THREE.MeshLambertMaterial({ map: tex('dirt_path_side', pathLen, 1) }),
  ]);
  // Just over the grass plane: the ground here is one flat plane, so the path's pixel step is left out.
  path.position.set(START_X + TRACK / 2 + 2, -0.5 + 0.004, 0);
  path.receiveShadow = shadows;
  scene.add(path);
  /* Fences: oak posts and rails down both sides and between the lanes, low between the lanes. */
  {
    const plank = new THREE.MeshLambertMaterial({ map: tex('oak_planks') });
    const PX = 1 / 16;
    const posts = [];
    const rails = [];
    const run = (z, low) => {
      for (let x = START_X - 4; x <= START_X + TRACK + 8; x += 2) posts.push([x, z, low]);
      rails.push([z, low]);
    };
    run(-halfWidth, false);
    run(halfWidth, false);
    for (let lane = 1; lane < racers.length; lane += 1) run(zOf(lane) - LANE / 2, true);
    const postGeo = new THREE.BoxGeometry(4 * PX, 16 * PX, 4 * PX);
    const posts3d = new THREE.InstancedMesh(postGeo, plank, posts.length);
    const m = new THREE.Matrix4();
    posts.forEach(([x, z, low], i) => posts3d.setMatrixAt(i, m.compose(new THREE.Vector3(x, low ? 0.25 : 0.5, z), new THREE.Quaternion(), new THREE.Vector3(1, low ? 0.5 : 1, 1))));
    posts3d.castShadow = shadows;
    scene.add(posts3d);
    for (const [z, low] of rails) {
      for (const y of low ? [0.38] : [0.38, 0.81]) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(TRACK + 12, 3 * PX, 2 * PX), plank);
        rail.position.set(START_X + TRACK / 2 + 2, y, z);
        rail.castShadow = shadows;
        scene.add(rail);
      }
    }
  }
  /* The line: a strip of black and white wool across the track at the finish, and an arch over it. */
  {
    const c = document.createElement('canvas');
    c.width = 32;
    c.height = 16 * Math.ceil(halfWidth * 2);
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    for (let y = 0; y < c.height / 16; y += 1) for (let x = 0; x < 2; x += 1) g.drawImage(img[(x + y) % 2 ? 'black_wool' : 'white_wool'], x * 16, y * 16);
    const line = new THREE.Mesh(new THREE.PlaneGeometry(1, halfWidth * 2), new THREE.MeshLambertMaterial({ map: pixelTexture(THREE, c) }));
    line.rotation.x = -Math.PI / 2;
    line.position.set(START_X + TRACK, 0.012, 0);
    line.receiveShadow = shadows;
    scene.add(line);
    const log = [new THREE.MeshLambertMaterial({ map: tex('oak_log') }), new THREE.MeshLambertMaterial({ map: tex('oak_log_top') })];
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(1, 6, 1), [log[0], log[0], log[1], log[1], log[0], log[0]]);
      post.position.set(START_X + TRACK, 3, side * (halfWidth + 0.8));
      post.castShadow = shadows;
      scene.add(post);
    }
    const banner = new THREE.Mesh(new THREE.BoxGeometry(1, 1, halfWidth * 2 + 2.6), new THREE.MeshLambertMaterial({ map: pixelTexture(THREE, c) }));
    banner.position.set(START_X + TRACK, 6.2, 0);
    banner.castShadow = shadows;
    scene.add(banner);
    // The gate at the start: a red wool bar the field waits behind, lifted on the go.
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.25, halfWidth * 2), new THREE.MeshLambertMaterial({ map: tex('red_wool') }));
    bar.position.set(START_X + 0.9, 0.9, 0);
    bar.castShadow = shadows;
    scene.add(bar);
    scene.userData.gate = bar;
  }
  /* The plains round it: hay bales by the rail, flowers and grass, oak trees, the crowd. */
  {
    const rand = seeded(23);
    const hay = [new THREE.MeshLambertMaterial({ map: tex('hay_block_side') }), new THREE.MeshLambertMaterial({ map: tex('hay_block_top') })];
    const bales = [];
    for (let x = START_X - 2; x < START_X + TRACK + 8; x += 3 + Math.floor(rand() * 4)) {
      for (const side of [-1, 1]) if (rand() < 0.45) bales.push([x + rand(), side * (halfWidth + 1.4 + rand()), rand() < 0.3]);
    }
    const baleMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), [hay[0], hay[0], hay[1], hay[1], hay[0], hay[0]], bales.length * 2);
    const m = new THREE.Matrix4();
    let n = 0;
    for (const [x, z, two] of bales) {
      baleMesh.setMatrixAt(n++, m.makeTranslation(x, 0.5, z));
      if (two) baleMesh.setMatrixAt(n++, m.makeTranslation(x, 1.5, z));
    }
    baleMesh.count = n;
    baleMesh.castShadow = shadows;
    baleMesh.receiveShadow = shadows;
    scene.add(baleMesh);
    // Flowers and short grass: two crossed quads each, as the game draws a cross model.
    const kinds = ['short_grass', 'short_grass', 'short_grass', 'poppy', 'dandelion', 'cornflower', 'oxeye_daisy'];
    const count = Math.round(520 * tier.particles);
    for (const kind of kinds.filter((k, i) => kinds.indexOf(k) === i)) {
      const share = kinds.filter((k) => k === kind).length / kinds.length;
      const material = new THREE.MeshLambertMaterial({ map: tex(kind), alphaTest: 0.5, side: THREE.DoubleSide, color: kind === 'short_grass' ? 0x91bd59 : 0xffffff });
      const quads = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), material, Math.round(count * share) * 2);
      let k = 0;
      for (let i = 0; i < Math.round(count * share); i += 1) {
        let x;
        let z;
        do {
          x = START_X + TRACK / 2 + (rand() - 0.5) * 90;
          z = (rand() - 0.5) * 70;
        } while (Math.abs(z) < halfWidth + 3 && x > START_X - 8 && x < START_X + TRACK + 10);
        for (const r of [Math.PI / 4, -Math.PI / 4]) quads.setMatrixAt(k++, m.compose(new THREE.Vector3(Math.floor(x) + 0.5, 0.5, Math.floor(z) + 0.5), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), r), new THREE.Vector3(1, 1, 1)));
      }
      scene.add(quads);
    }
    // Oak trees on the far side.
    const logMats = [new THREE.MeshLambertMaterial({ map: tex('oak_log') }), new THREE.MeshLambertMaterial({ map: tex('oak_log_top') })];
    const leafMat = new THREE.MeshLambertMaterial({ map: tex('oak_leaves'), color: 0x77ab2f, alphaTest: 0.5 });
    const logs = [];
    const leaves = [];
    for (let i = 0; i < 9; i += 1) {
      const x = Math.floor(START_X - 6 + i * 7 + rand() * 4);
      const z = Math.floor(-halfWidth - 8 - rand() * 10);
      const h = 4 + Math.floor(rand() * 3);
      for (let y = 0; y < h; y += 1) logs.push([x + 0.5, y + 0.5, z + 0.5]);
      for (let y = h - 2; y <= h + 1; y += 1) {
        const r = y > h ? 1 : 2;
        for (let dx = -r; dx <= r; dx += 1) for (let dz = -r; dz <= r; dz += 1) if (!(dx === 0 && dz === 0 && y < h) && !(Math.abs(dx) === r && Math.abs(dz) === r && rand() < 0.5)) leaves.push([x + dx + 0.5, y + 0.5, z + dz + 0.5]);
      }
    }
    const logMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), [logMats[0], logMats[0], logMats[1], logMats[1], logMats[0], logMats[0]], logs.length);
    logs.forEach(([x, y, z], i) => logMesh.setMatrixAt(i, m.makeTranslation(x, y, z)));
    const leafMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), leafMat, leaves.length);
    leaves.forEach(([x, y, z], i) => leafMesh.setMatrixAt(i, m.makeTranslation(x, y, z)));
    for (const mesh of [logMesh, leafMesh]) {
      mesh.castShadow = shadows;
      mesh.receiveShadow = shadows;
      scene.add(mesh);
    }
  }
  /* The crowd: plains villagers along the far rail, cheering when the race is on. */
  const crowd = [];
  {
    const base = new THREE.MeshLambertMaterial({ map: pixelTexture(THREE, ent.villager), alphaTest: 0.5, side: THREE.DoubleSide });
    const plains = new THREE.MeshLambertMaterial({ map: pixelTexture(THREE, ent.villager_plains), alphaTest: 0.5, side: THREE.DoubleSide });
    const rand = seeded(41);
    const count = Math.max(4, Math.round(10 * tier.creatures));
    for (let i = 0; i < count; i += 1) {
      const model = buildModel(THREE, [{ material: base, def: VILLAGER }, { material: plains, def: VILLAGER }]);
      const entity = placeEntity(THREE, model, 0.9375 / 16);
      entity.position.set(START_X + 4 + (i / count) * (TRACK + 2) + rand() * 2, 0, -halfWidth - 1.6 - rand() * 1.2);
      entity.rotation.y = 0;
      entity.traverse((o) => { o.castShadow = shadows; });
      scene.add(entity);
      crowd.push({ model, entity, phase: rand() * 6 });
    }
  }

  /* ── the field ── */
  const furTex = pixelTexture(THREE, ent.sheep_wool);
  const field = racers.map((racer, lane) => {
    const build = BUILDS[racer.id] ?? BUILDS.pig;
    const layers = [{ material: new THREE.MeshLambertMaterial({ map: pixelTexture(THREE, ent[build.skin]), alphaTest: 0.5, side: THREE.DoubleSide }), def: build.def }];
    if (build.fur) layers.push({ material: new THREE.MeshLambertMaterial({ map: furTex, alphaTest: 0.5, side: THREE.DoubleSide, color: build.fur }), def: SHEEP_FUR });
    const model = buildModel(THREE, layers);
    const entity = placeEntity(THREE, model, 1 / 16);
    // Facing down the track (+x).
    entity.rotation.y = Math.PI / 2;
    entity.traverse((o) => { o.castShadow = shadows; });
    if (build.mushrooms) {
      // The mooshroom's red mushrooms on its back, as MushroomCowMushroomLayer puts them.
      const shroom = new THREE.MeshLambertMaterial({ map: tex('red_mushroom'), alphaTest: 0.5, side: THREE.DoubleSide });
      for (const [x, z] of [[0, 1.5], [3, -4], [-3, -4]]) {
        for (const r of [Math.PI / 4, -Math.PI / 4]) {
          const quad = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), shroom);
          quad.position.set(x, -1, z);
          quad.rotation.set(Math.PI, r, 0);
          model.parts.body.parent.add(quad);
        }
      }
    }
    const holder = new THREE.Group();
    holder.add(entity);
    holder.position.set(START_X, 0, zOf(lane));
    scene.add(holder);
    // A name tag over it, as the game draws a named mob's: the name in the game's font on dark glass.
    const tag = nameTag(`${racer.name} ${(racer.oddsX100 / 100).toFixed(2)}x`);
    tag.position.y = racer.id === 'chicken' ? 1.25 : racer.id.includes('sheep') || racer.id === 'pig' ? 1.55 : 1.95;
    holder.add(tag);
    return { racer, model, entity, holder, tag, lane, walk: Math.random() * 10, chicken: racer.id === 'chicken' };
  });
  function nameTag(text) {
    const px = 4;
    const w = textWidth(font, text) * px + 4 * px;
    const h = 10 * px;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    // EntityRenderer's name tag: the background a quarter-opaque black.
    g.fillStyle = 'rgba(0, 0, 0, .25)';
    g.fillRect(0, 0, w, h);
    drawText(g, font, text, 2 * px, px, px, '#ffffff', false);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: pixelTexture(THREE, c), transparent: true, depthWrite: false, fog: false }));
    sprite.scale.set((w / h) * 0.36, 0.36, 1);
    return sprite;
  }

  /* ── particles: the dust off the path, hearts for the winner, fireworks, orbs ── */
  const sprites = [];
  const sprite = (map, opts) => {
    const s = makeSprites(THREE, { map, ...opts });
    scene.add(s.points);
    sprites.push(s);
    return s;
  };
  const dust = sprite(pixelTexture(THREE, img.dirt_path_top), { cols: 4, rows: 4, count: scale(400) });
  const hearts = sprite(pixelTexture(THREE, part.heart), { count: scale(60) });
  const sparks = sprite(atlas(THREE, [0, 1, 2, 3, 4, 5, 6, 7].map((i) => part[`spark_${i}`]), 8, 8).map, { cols: 8, rows: 1, count: scale(600), additive: true });
  const STARS = [[1, 0.27, 0.27], [1, 0.62, 0.15], [0.5, 1, 0.25], [0.35, 0.8, 1], [1, 0.35, 1], [1, 0.95, 0.3]];
  function firework(x, y, z) {
    if (reduce) return;
    const [r, g, b] = STARS[Math.floor(Math.random() * STARS.length)];
    for (let i = 0; i < scale(80); i += 1) {
      const u = Math.random() * 2 - 1;
      const a = Math.random() * Math.PI * 2;
      const rr = Math.sqrt(1 - u * u);
      const speed = 5 + Math.random() * 2;
      sparks.emit({ x, y, z, vx: Math.cos(a) * rr * speed, vy: u * speed, vz: Math.sin(a) * rr * speed, gravity: -2.5, drag: 1.6, life: 1.3 + Math.random() * 0.7, size: 0.45, frame: 7, frameTo: 0, r: r * 1.6, g: g * 1.6, b: b * 1.6, twinkle: true, fade: 0.45 });
    }
  }

  /* ─────────── the race ─────────── */

  const state = { phase: 'idle', script: null, startAt: 0, winner: -1, pick: -1, finishedAt: 0, resolve: null, cued: false, celebrateAt: 0 };
  const fireworksDue = [];
  let shake = 0;
  function placeField(ms) {
    for (const f of field) {
      const p = state.script ? state.script.progress(f.lane, ms) : 0;
      f.holder.position.x = START_X + p * TRACK;
      f.progress = p;
    }
  }

  /* ── the camera: the line-up, then alongside the leaders, then the line ── */
  const cam = { pos: new THREE.Vector3(), look: new THREE.Vector3() };
  const goalPos = new THREE.Vector3();
  const goalLook = new THREE.Vector3();
  const drag = { on: false, x: 0, y: 0, yaw: 0, pitch: 0, baseYaw: 0, basePitch: 0, id: null };
  function frameShot(now, clock) {
    const narrow = camera.aspect < 1 ? 1.5 : 1;
    if (state.phase === 'running' || state.phase === 'countdown') {
      const ms = now - state.startAt;
      const lead = Math.max(...field.map((f) => Math.min(1, f.progress ?? 0)));
      const x = START_X + Math.min(lead * TRACK, TRACK) - 2.5;
      goalLook.set(x + 2, 0.8, 0);
      goalPos.set(x - 3 * narrow, 6.5 + narrow, 15 * narrow);
      if (ms > state.script.finish[state.winner] - 1400) {
        // The finish: down at the line, side on.
        goalLook.set(START_X + TRACK, 0.9, 0);
        goalPos.set(START_X + TRACK + 1.5, 3.2, 11.5 * narrow);
      }
    } else if (state.phase === 'done') {
      // Past the line, looking back at the winner's face, clear of the arch's posts.
      const w = field[state.winner];
      goalLook.set(w.holder.position.x, 0.9, w.holder.position.z);
      goalPos.set(w.holder.position.x + 4.5, 3, Math.max(w.holder.position.z + 7, 10) * narrow);
    } else {
      // The line-up: the field behind the gate, side on, the camera drifting.
      const sway = reduce ? 0 : Math.sin(clock * 0.15) * 1.5;
      goalLook.set(START_X + 2.5, 0.6, 0);
      goalPos.set(START_X + 7 + sway, 5.4 + narrow, 13 * narrow);
    }
  }
  const onDown = (event) => {
    Object.assign(drag, { on: true, x: event.clientX, y: event.clientY, baseYaw: drag.yaw, basePitch: drag.pitch, id: event.pointerId });
    try { canvas.setPointerCapture(event.pointerId); } catch { /* synthetic */ }
  };
  const onMove = (event) => {
    if (!drag.on || event.pointerId !== drag.id) return;
    drag.yaw = THREE.MathUtils.clamp(drag.baseYaw - (event.clientX - drag.x) * 0.004, -0.6, 0.6);
    drag.pitch = THREE.MathUtils.clamp(drag.basePitch + (event.clientY - drag.y) * 0.0025, -0.2, 0.3);
  };
  const onUp = () => { drag.on = false; };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  let lost = false;
  const onLost = (event) => { event.preventDefault(); lost = true; controls.onLost?.(); };
  canvas.addEventListener('webglcontextlost', onLost);

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
    () => { renderer.shadowMap.enabled = false; scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; }); },
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
    camera.fov = Math.max(44, THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(22)) / Math.max(0.5, camera.aspect))));
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

  let raf = 0;
  let last = performance.now();
  let clock = 0;
  const tmp = new THREE.Vector3();
  function stepRace(now) {
    const gate = scene.userData.gate;
    if (state.phase === 'countdown' && now >= state.startAt) {
      state.phase = 'running';
      controls.onCue?.('go');
    }
    if (state.phase === 'running' || state.phase === 'done') {
      const ms = now - state.startAt;
      placeField(ms);
      gate.position.y = lerp(0.9, 3.4, clamp01(ms / 500));
      if (state.phase === 'running' && !state.cued && ms >= state.script.finish[state.winner]) {
        state.cued = true;
        controls.onCue?.('finish', state.winner);
        shake = 0.4;
      }
      if (state.phase === 'running' && ms >= state.script.duration + 400) {
        state.phase = 'done';
        state.finishedAt = now;
        const fn = state.resolve;
        state.resolve = null;
        fn?.();
      }
    } else {
      gate.position.y = 0.9;
    }
  }
  function frame() {
    raf = requestAnimationFrame(frame);
    const now = performance.now();
    stepRace(now);
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
    frameShot(now, clock);
    const k = 1 - Math.exp(-dt * (state.phase === 'running' ? 4 : 2.2));
    if (reduce) {
      cam.pos.copy(goalPos);
      cam.look.copy(goalLook);
    } else {
      cam.pos.lerp(goalPos, k);
      cam.look.lerp(goalLook, k);
    }
    if (!drag.on) {
      drag.yaw *= 0.97;
      drag.pitch *= 0.97;
    }
    tmp.subVectors(cam.pos, cam.look);
    const dist = tmp.length();
    const yaw = Math.atan2(tmp.x, tmp.z) + drag.yaw;
    const pitch = Math.asin(THREE.MathUtils.clamp(tmp.y / dist, -0.99, 0.99)) + drag.pitch;
    camera.position.set(cam.look.x + Math.sin(yaw) * Math.cos(pitch) * dist, cam.look.y + Math.sin(pitch) * dist, cam.look.z + Math.cos(yaw) * Math.cos(pitch) * dist);
    if (shake > 0.01 && !reduce) {
      camera.position.x += (Math.random() - 0.5) * shake * 0.1;
      camera.position.y += (Math.random() - 0.5) * shake * 0.1;
    }
    shake *= Math.exp(-dt * 3);
    camera.lookAt(cam.look);
    sky.position.copy(camera.position);
    sunDisc.position.copy(camera.position).addScaledVector(SUN_DIR, 240);
    sunDisc.lookAt(camera.position);
    sunDisc.scale.setScalar(24);

    // The field: running legs while it runs, idle shuffles while it waits; the leader's dust.
    const running = state.phase === 'running';
    const ms = now - state.startAt;
    for (const f of field) {
      const moving = running && (f.progress ?? 0) < 1.05;
      f.walk += dt * (moving ? 22 : 2);
      const speed = moving ? 0.75 : 0.12;
      if (f.chicken) poseChicken(f.model.parts, f.walk, speed, moving ? Math.abs(Math.sin(clock * 30)) * 1.2 : 0);
      else poseQuadruped(f.model.parts, f.walk, speed, moving ? -0.15 : Math.sin(clock + f.lane) * 0.1);
      f.entity.position.y = moving && !reduce ? Math.abs(Math.sin(f.walk * 0.6662)) * 0.08 : 0;
      if (moving && !reduce && Math.random() < dt * 22) {
        dust.emit({ x: f.holder.position.x - 0.4, y: 0.1, z: f.holder.position.z + (Math.random() - 0.5) * 0.6, vx: -1 - Math.random(), vy: 0.8 + Math.random(), vz: (Math.random() - 0.5) * 0.6, gravity: -6, drag: 0.4, life: 0.5 + Math.random() * 0.3, size: 0.1, frame: Math.floor(Math.random() * 16), fade: 0.3 });
      }
      // Every tag at the gate; in the race only the backed racer's; after it, the winner's and the backed one's.
      f.tag.visible = state.phase === 'idle' || state.phase === 'countdown' || (running && ms < 600) || f.lane === state.pick || (state.phase === 'done' && f.lane === state.winner);
    }
    // The crowd cheers while the race is on: villagers bob and nod.
    for (const c of crowd) {
      const cheer = (running || state.phase === 'done') && !reduce;
      c.entity.position.y = cheer ? Math.abs(Math.sin(clock * 8 + c.phase)) * 0.25 : 0;
      c.model.parts.head.rotation.x = cheer ? Math.sin(clock * 10 + c.phase) * 0.25 : Math.sin(clock * 0.5 + c.phase) * 0.05;
    }
    if (state.phase === 'done' && !reduce && Math.random() < dt * 6 && now - state.finishedAt < 3000) {
      const w = field[state.winner];
      hearts.emit({ x: w.holder.position.x + (Math.random() - 0.5) * 0.8, y: 1.4, z: w.holder.position.z + (Math.random() - 0.5) * 0.8, vy: 0.6, life: 1.2, size: 0.3, fade: 0.4 });
    }
    for (let i = fireworksDue.length - 1; i >= 0; i -= 1) {
      if (now < fireworksDue[i].at) continue;
      const [f] = fireworksDue.splice(i, 1);
      firework(f.x, f.y, f.z);
      controls.onCue?.('firework');
    }
    for (const s of sprites) s.step(dt);
    if (composer) composer.render(dt);
    else renderer.render(scene, camera);
  }

  resize();
  frameShot(performance.now(), 0);
  cam.pos.copy(goalPos);
  cam.look.copy(goalLook);
  try { renderer.compile(scene, camera); } catch { /* compiled on first use */ }
  raf = requestAnimationFrame(frame);

  const controls = {
    onLost: null,
    /** 'go' as the gate lifts, 'finish' (with the winner's lane) as it crosses, 'firework'. */
    onCue: null,
    tier: tier.name,
    /** The racer backed: its name tag stays up through the race. */
    setPick(lane) {
      state.pick = lane;
    },
    /** Runs `script` (derbyrace.js) after `countdownMs`; resolves when the whole field is home. */
    race(script, winner, countdownMs = 0) {
      state.script = script;
      state.winner = winner;
      state.cued = false;
      state.startAt = performance.now() + countdownMs;
      state.phase = 'countdown';
      placeField(0);
      return new Promise((resolve) => {
        state.resolve = resolve;
        setTimeout(() => {
          if (state.resolve !== resolve) return;
          state.phase = 'done';
          state.finishedAt = performance.now();
          state.resolve = null;
          resolve();
        }, countdownMs + script.duration + 4000);
      });
    },
    /** When the gate lifts (a performance.now() time), for the page's own clock. */
    get startAt() { return state.startAt; },
    /** How glad the crowd is: fireworks over the line for a winning bet. */
    celebrate(x100) {
      const x = x100 / 100;
      if (x <= 0) return;
      const now = performance.now();
      const count = x >= 10 ? 5 : x >= 5 ? 3 : 1;
      for (let i = 0; i < count; i += 1) fireworksDue.push({ at: now + 200 + i * 380 + Math.random() * 200, x: START_X + TRACK + (Math.random() - 0.5) * 10, y: 8 + Math.random() * 4, z: -4 - Math.random() * 6 });
    },
    /** Back behind the gate for the next race. */
    reset() {
      state.phase = 'idle';
      state.script = null;
      placeField(0);
    },
    dispose() {
      cancelAnimationFrame(raf);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
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
