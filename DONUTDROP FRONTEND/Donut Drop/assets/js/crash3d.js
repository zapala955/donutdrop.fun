/* crash3d.js — Crash in 3D: Steve rides a happy ghast up off a meadow, through the clouds and on into
 * the stars, for as long as the round lasts -- and then the lightning finds him.
 *
 * Every block, item, particle and model is the game's own, out of the client jar: the meadow's
 * grass, flowers, oaks and birches and its river, the clouds from the game's cloud map, the sun, the
 * happy ghast on HappyGhastModel with its tentacles swaying as the game sways them, its harness and
 * goggles on HappyGhastHarnessModel, Steve on PlayerModel sitting on it, two more ghasts out on the
 * sky, a village at the launch with its cows and sheep, the game's fancy clouds, its round shadow
 * under the ghast, the cloud puffs it leaves as it climbs, the firework sparks. What is drawn rather than taken is light: the sky's colour as the air
 * thins, the stars, the bolt of lightning (the game draws its bolts as light, not as a texture).
 *
 * Height is the multiplier: every doubling is twenty blocks more. The clouds are passed a little past
 * four times, the sky darkens past eight, and past fifty it is night up there.
 *
 * Nothing here decides anything. crash.js owns the round: every frame it says what phase the round
 * is in, how long it has been climbing and how fast, where it busted, and who has cashed out.
 * If WebGL is missing or the context is lost, crash.js draws its curve.
 *
 * Low-end machines get less (quality3d.js): no glow, fewer sparks, a smaller meadow, a steady thirty
 * frames a second; a machine that cannot keep up steps down on its own.
 */
import { reduceMotion } from './util.js';
import { getTHREE, loadImage, softDot } from './mc3d.js';
import { COW, HAPPY_GHAST, HAPPY_GHAST_HARNESS, PLAYER, SHEEP, SHEEP_FUR, VILLAGER, atlas, buildModel, makeSprites, pixelTexture, placeEntity, poseGhast } from './mcmodels.js';
import { blobShadow, fancyClouds, gradePass, grazers, shadowMaterial, villageHouse, villagers } from './scenery3d.js';
import { BRIGHTNESS, chooseTier, createGovernor, frameMs, minFpsFor, ratioFor } from './quality3d.js';

const PER_DOUBLING = 20;   // blocks of height a doubling of the multiplier
const HOVER = 3;           // the ghast's height over the meadow before it goes
const CLOUD_Y = 46;        // the clouds' underside (about 4.4x)
const GHAST_PX = 4 / 16;   // HappyGhastModel's layer is drawn four times over
const PLAYER_PX = 0.9375 / 16;
const PLAINS_GRASS = 0x91bd59;
const OAK_LEAVES = 0x77ab2f;
const BIRCH_LEAVES = 0x80a755;

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
/** The ghast's height for a multiplier, in hundredths: twenty blocks a doubling, over its hover. */
export const altitudeOf = (x100) => HOVER + PER_DOUBLING * Math.log2(Math.max(1, x100 / 100));

/**
 * Builds the sky into `host` and resolves with its controls, or null when this browser cannot draw
 * it.
 */
export async function createCrash3d(host) {
  const THREE = await getTHREE();
  const probe = document.createElement('canvas');
  const probeGl = probe.getContext('webgl2');
  if (!probeGl) return null;
  const tier = chooseTier(probeGl);
  probeGl.getExtension('WEBGL_lose_context')?.loseContext();
  const canvas = document.createElement('canvas');
  canvas.className = 'crash__gl';
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
  const BLOCKS = ['grass_block_top', 'dirt', 'oak_log', 'oak_log_top', 'oak_leaves', 'birch_log', 'birch_leaves', 'short_grass', 'poppy',
    'dandelion', 'cornflower', 'oxeye_daisy', 'water_still', 'cobblestone', 'oak_planks', 'glass', 'oak_door_top', 'oak_door_bottom'];
  const ENTITY = ['happy_ghast', 'happy_ghast_red_harness', 'happy_ghast_light_blue_harness', 'happy_ghast_yellow_harness', 'steve', 'cow',
    'sheep', 'sheep_wool', 'villager', 'villager_plains', 'villager_farmer', 'villager_librarian'];
  const PARTICLE = [...Array.from({ length: 8 }, (_, i) => `spark_${i}`), ...Array.from({ length: 8 }, (_, i) => `generic_${i}`)];
  let loaded;
  try {
    loaded = await Promise.all([
      Promise.all(BLOCKS.map((name) => loadImage(`assets/img/block/${name}.png`))),
      Promise.all(ENTITY.map((name) => loadImage(`assets/img/entity/${name}.png`))),
      Promise.all(PARTICLE.map((name) => loadImage(`assets/img/particle/${name}.png`))),
      loadImage('assets/img/env/clouds.png'),
      loadImage('assets/img/env/sun.png'),
      loadImage('assets/img/misc/shadow.png'),
      tier.composer
        ? import(/* @vite-ignore */ new URL('assets/vendor/three-addons.js', document.baseURI).href).catch(() => null)
        : Promise.resolve(null),
    ]);
  } catch {
    renderer.dispose();
    return null;
  }
  const [blockImgs, entityImgs, particleImgs, cloudImg, sunImg, shadowImg, addons] = loaded;
  const img = Object.fromEntries(BLOCKS.map((name, i) => [name, blockImgs[i]]));
  const ent = Object.fromEntries(ENTITY.map((name, i) => [name, entityImgs[i]]));
  const part = Object.fromEntries(PARTICLE.map((name, i) => [name, particleImgs[i]]));
  host.prepend(canvas);

  const reduce = reduceMotion();
  const scene = new THREE.Scene();
  const DAY = new THREE.Color(0x4f8cff);
  const HIGH = new THREE.Color(0x0b1030);
  const DAY_LOW = new THREE.Color(0xa9caff);
  const HIGH_LOW = new THREE.Color(0x1a2450);
  scene.fog = new THREE.Fog(DAY_LOW.clone(), 60, 260);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 900);
  scene.add(camera);

  let composer = null;
  let bloom = null;
  if (addons) {
    try {
      const target = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: tier.samples });
      composer = new addons.EffectComposer(renderer, target);
      composer.addPass(new addons.RenderPass(scene, camera));
      bloom = new addons.UnrealBloomPass(new THREE.Vector2(4, 4), 0.45, 0.4, 0.92);
      composer.addPass(bloom);
      composer.addPass(new addons.OutputPass());
      composer.addPass(gradePass(THREE, addons, { contrast: 1.05, saturation: 1.12, lift: [0.01, 0.015, 0.035], gain: [1.02, 1.01, 0.98], vignette: 0.22 }));
    } catch {
      composer = null;
      bloom = null;
    }
  }
  const tex = (name) => pixelTexture(THREE, img[name]);
  const lambert = (map, opts = {}) => new THREE.MeshLambertMaterial({ map, ...opts });

  /* ── light: the sun, and the sky's own blue from above ── */
  const hemi = new THREE.HemisphereLight(0xcfe0ff, 0x58704a, 1.1);
  scene.add(hemi);
  const sunLight = new THREE.DirectionalLight(0xfff2dc, 1.6);
  sunLight.position.set(-30, 60, 25);
  scene.add(sunLight, sunLight.target);

  /* ── the sky: blue thinning to night with height, the sun, stars past the clouds ── */
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: { uTop: { value: DAY.clone() }, uLow: { value: DAY_LOW.clone() } },
    vertexShader: 'varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform vec3 uTop; uniform vec3 uLow; varying vec3 vDir;
      void main() {
        gl_FragColor = vec4(mix(uLow, uTop, smoothstep(-0.1, 0.6, vDir.y)), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(500, 24, 12), skyMat);
  sky.renderOrder = -10;
  scene.add(sky);
  const STAR_COUNT = scale(800);
  const starPos = new Float32Array(STAR_COUNT * 3);
  {
    const rand = seeded(9);
    for (let i = 0; i < STAR_COUNT; i += 1) {
      const y = 0.05 + rand() * 0.95;
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(1 - y * y);
      starPos.set([Math.cos(a) * r * 450, y * 450, Math.sin(a) * r * 450], i * 3);
    }
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  const starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, fog: false, transparent: true, opacity: 0, depthWrite: false });
  const stars = new THREE.Points(starGeo, starMat);
  stars.renderOrder = -9;
  scene.add(stars);
  const SUN_DIR = new THREE.Vector3(-0.45, 0.55, -0.7).normalize();
  const sun = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: pixelTexture(THREE, sunImg), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false, color: new THREE.Color(1.5, 1.4, 1.2) }));
  sun.renderOrder = -8;
  scene.add(sun);

  /* ── the meadow: grass over dirt in low hills, a river, oaks and birches, flowers ── */
  const MEADOW = tier.name === 'low' ? 44 : 64;
  const VILLAGE = { x: -15, z: -9 };
  {
    const rand = seeded(31);
    const box = new THREE.BoxGeometry(1, 1, 1);
    const grassTop = lambert(tex('grass_block_top'), { color: PLAINS_GRASS });
    const dirt = lambert(tex('dirt'));
    const grassMats = [dirt, dirt, grassTop, dirt, dirt, dirt];
    const cols = [];
    const water = [];
    const plants = { short_grass: [], poppy: [], dandelion: [], cornflower: [], oxeye_daisy: [] };
    const trees = [];
    // Flat where the village stands and the ghast takes off; gentle hills everywhere else.
    const flat = (x, z) => Math.hypot(x - VILLAGE.x, z - VILLAGE.z) < 13 || Math.hypot(x, z) < 7;
    const height = (x, z) => (flat(x, z) ? 0 : Math.max(0, Math.round(1.2 + Math.sin(x * 0.17) * 1.1 + Math.cos(z * 0.21 + 1) * 1.1 + Math.sin((x + z) * 0.09) * 0.8)));
    const river = (x) => Math.sin(x * 0.08) * 6 + 14;
    for (let x = -MEADOW / 2; x < MEADOW / 2; x += 1) {
      for (let z = -MEADOW / 2; z < MEADOW / 2; z += 1) {
        const inRiver = Math.abs(z - river(x)) < 2.2;
        const h = inRiver ? 0 : height(x, z);
        if (inRiver) { water.push([x + 0.5, z + 0.5]); continue; }
        for (let y = 0; y <= h; y += 1) cols.push([x + 0.5, y - 0.5, z + 0.5, y === h]);
        const r = rand();
        const top = h + 0.5;
        if (Math.hypot(x, z) > 19 && !flat(x, z) && r < 0.016 && Math.abs(z - river(x)) > 4) trees.push([x + 0.5, top, z + 0.5, rand() < 0.35]);
        else if (r < 0.2) plants.short_grass.push([x + 0.5, top, z + 0.5]);
        else if (r < 0.215) plants.poppy.push([x + 0.5, top, z + 0.5]);
        else if (r < 0.23) plants.dandelion.push([x + 0.5, top, z + 0.5]);
        else if (r < 0.24) plants.cornflower.push([x + 0.5, top, z + 0.5]);
        else if (r < 0.25) plants.oxeye_daisy.push([x + 0.5, top, z + 0.5]);
      }
    }
    // Only the top of each column carries grass; the blocks under it are dirt all round.
    const tops = cols.filter((c) => c[3]);
    const under = cols.filter((c) => !c[3]);
    const m = new THREE.Matrix4();
    const put = (list, geometry, material) => {
      if (!list.length) return;
      const mesh = new THREE.InstancedMesh(geometry, material, list.length);
      list.forEach(([x, y, z], i) => mesh.setMatrixAt(i, m.makeTranslation(x, y, z)));
      scene.add(mesh);
    };
    put(tops, box, grassMats);
    // Grassland on past the meadow to the haze, so from up high the world has no edge.
    const farTex = tex('grass_block_top');
    farTex.wrapS = farTex.wrapT = THREE.RepeatWrapping;
    farTex.repeat.set(900, 900);
    const far = new THREE.Mesh(new THREE.PlaneGeometry(900, 900).rotateX(-Math.PI / 2), lambert(farTex, { color: PLAINS_GRASS }));
    far.position.y = -0.52;
    scene.add(far);
    put(under, box, dirt);
    const still = document.createElement('canvas');
    still.width = still.height = 16;
    still.getContext('2d').drawImage(img.water_still, 0, 0, 16, 16, 0, 0, 16, 16);
    const waterMat = new THREE.MeshLambertMaterial({ map: pixelTexture(THREE, still), color: 0x3f76e4, transparent: true, opacity: 0.85 });
    put(water.map(([x, z]) => [x, -0.15, z]), new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), waterMat);
    // Trees: a trunk and a round crown, as the game grows a small oak or birch.
    const logs = { oak: [], birch: [] };
    const leaves = { oak: [], birch: [] };
    for (const [x, y, z, birch] of trees) {
      const kind = birch ? 'birch' : 'oak';
      const tall = 4 + Math.floor(rand() * 2);
      for (let k = 0; k < tall; k += 1) logs[kind].push([x, y + k + 0.5, z]);
      for (let dy = tall - 2; dy <= tall + 1; dy += 1) {
        const rr = dy >= tall ? 1 : 2;
        for (let dx = -rr; dx <= rr; dx += 1) {
          for (let dz = -rr; dz <= rr; dz += 1) {
            if ((dx || dz || dy >= tall) && !(Math.abs(dx) === rr && Math.abs(dz) === rr && rand() < 0.6)) leaves[kind].push([x + dx, y + dy + 0.5, z + dz]);
          }
        }
      }
    }
    const oakLog = [lambert(tex('oak_log')), lambert(tex('oak_log_top'))];
    put(logs.oak, box, [oakLog[0], oakLog[0], oakLog[1], oakLog[1], oakLog[0], oakLog[0]]);
    put(logs.birch, box, lambert(tex('birch_log')));
    put(leaves.oak, box, lambert(tex('oak_leaves'), { color: OAK_LEAVES, alphaTest: 0.5 }));
    put(leaves.birch, box, lambert(tex('birch_leaves'), { color: BIRCH_LEAVES, alphaTest: 0.5 }));
    // Plants: two crossed planes each, all of one kind in one draw.
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const one = new THREE.Vector3(1, 1, 1);
    for (const [name, list] of Object.entries(plants)) {
      if (!list.length) continue;
      const tint = name === 'short_grass' ? { color: PLAINS_GRASS } : {};
      const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), lambert(tex(name), { alphaTest: 0.5, side: THREE.DoubleSide, ...tint }), list.length * 2);
      list.forEach(([x, y, z], i) => {
        for (const [k, r] of [[0, Math.PI / 4], [1, -Math.PI / 4]]) {
          q.setFromAxisAngle(up, r);
          mesh.setMatrixAt(i * 2 + k, m.compose(new THREE.Vector3(x, y + 0.5, z), q, one));
        }
      });
      scene.add(mesh);
    }
  }

  /* ── the clouds: the game's cloud map, a pixel twelve blocks, a layer four blocks thick ── */
  const clouds = fancyClouds(THREE, cloudImg, { y: CLOUD_Y, radius: tier.name === 'low' ? 260 : 380, opacity: 0.86 });
  scene.add(clouds.group);

  /* ── the village at the launch: two houses, cows and sheep grazing, the round shadows under them ── */
  const shadowMat = shadowMaterial(THREE, shadowImg);
  const blockTex = (name) => pixelTexture(THREE, img[name]);
  scene.add(villageHouse(THREE, blockTex, { at: [VILLAGE.x - 7, 0, VILLAGE.z - 6], w: 6, d: 5 }));
  scene.add(villageHouse(THREE, blockTex, { at: [VILLAGE.x + 2, 0, VILLAGE.z - 8], w: 5, d: 5 }));
  const herd = grazers(THREE, scene, [
    { def: COW, image: ent.cow },
    { def: SHEEP, image: ent.sheep, fur: { def: SHEEP_FUR, image: ent.sheep_wool, color: 0xf9fffe } },
  ], [[VILLAGE.x + 4, VILLAGE.z + 4, 0], [VILLAGE.x - 2, VILLAGE.z + 5, 1], [VILLAGE.x + 7, VILLAGE.z + 1, 1], [VILLAGE.x - 5, VILLAGE.z + 2, 0], [-6, 6, 1]], { shadowMat });

  /* ── the ghast, its harness and goggles, and Steve sitting on it ── */
  const rider = new THREE.Group();
  // The villagers going about the village, a farmer and a librarian.
  const folk = {
    crews: [
      villagers(THREE, scene, VILLAGER, [ent.villager, ent.villager_plains, ent.villager_farmer], [[[VILLAGE.x - 3, VILLAGE.z + 1], [VILLAGE.x + 1, VILLAGE.z + 3], [VILLAGE.x - 1, VILLAGE.z - 2]]], { shadowMat }),
      villagers(THREE, scene, VILLAGER, [ent.villager, ent.villager_plains, ent.villager_librarian], [[[VILLAGE.x + 5, VILLAGE.z - 1], [VILLAGE.x + 3, VILLAGE.z + 5]]], { shadowMat }),
    ],
    step(dt, now, clock, reduce) { for (const c of this.crews) c.step(dt, now, clock, reduce); },
  };
  scene.add(rider);
  // The game's round shadow under the ghast, on the meadow, fading as it climbs.
  const ghastShadow = blobShadow(THREE, shadowMat, 2.6);
  ghastShadow.position.set(0, 0.04, 0);
  scene.add(ghastShadow);
  const ghastMat = new THREE.MeshLambertMaterial({ map: pixelTexture(THREE, ent.happy_ghast), alphaTest: 0.5 });
  const ghast = buildModel(THREE, [{ material: ghastMat, def: HAPPY_GHAST }]);
  const ghastEntity = placeEntity(THREE, ghast, GHAST_PX);
  rider.add(ghastEntity);
  const harness = buildModel(THREE, [{ material: new THREE.MeshLambertMaterial({ map: pixelTexture(THREE, ent.happy_ghast_red_harness), alphaTest: 0.5 }), def: HAPPY_GHAST_HARNESS }]);
  const harnessEntity = placeEntity(THREE, harness, GHAST_PX);
  rider.add(harnessEntity);
  // The body is drawn a sixteenth smaller in a harness, as HappyGhastModel.setupAnim draws it.
  ghast.parts.body.scale.setScalar(0.9375);
  const steveMat = new THREE.MeshLambertMaterial({ map: pixelTexture(THREE, ent.steve), alphaTest: 0.5, side: THREE.DoubleSide });
  const player = buildModel(THREE, [{ material: steveMat, def: PLAYER }]);
  const steve = placeEntity(THREE, player, PLAYER_PX);
  const P = player.parts;
  const SEAT = new THREE.Vector3(0, 16 * GHAST_PX * 0.9375 - 0.32, 0.5);
  const seat = () => {
    rider.add(steve);
    steve.position.copy(SEAT);
    steve.rotation.set(0, 0, 0);
    P.rightLeg.rotation.set(-1.41, 0.31, 0);
    P.leftLeg.rotation.set(-1.41, -0.31, 0);
    P.rightArm.rotation.set(-0.7, 0, 0);
    P.leftArm.rotation.set(-0.7, 0, 0);
  };
  seat();
  // Two more ghasts out on the sky, for company.
  const others = ['happy_ghast_light_blue_harness', 'happy_ghast_yellow_harness'].map((name, k) => {
    const body = buildModel(THREE, [{ material: ghastMat, def: HAPPY_GHAST }]);
    const gear = buildModel(THREE, [{ material: new THREE.MeshLambertMaterial({ map: pixelTexture(THREE, ent[name]), alphaTest: 0.5 }), def: HAPPY_GHAST_HARNESS }]);
    body.parts.body.scale.setScalar(0.9375);
    const group = new THREE.Group();
    group.add(placeEntity(THREE, body, GHAST_PX), placeEntity(THREE, gear, GHAST_PX));
    scene.add(group);
    return { body, group, a: k * 2.6 + 1, r: 46 + k * 18, h: 30 + k * 26, speed: 0.02 + k * 0.01 };
  });

  /* ── particles: firework sparks for cash-outs ── */
  const sprites = [];
  const sparkSet = makeSprites(THREE, { ...atlas(THREE, PARTICLE.slice(0, 8).map((n) => part[n]), 8, 8), count: scale(700), additive: true });
  // The cloud particle: the generic puff, white, as the game puffs a cloud.
  const puffs = makeSprites(THREE, { ...atlas(THREE, PARTICLE.slice(8).map((n) => part[n]), 8, 8), count: scale(160) });
  scene.add(puffs.points);
  sprites.push(puffs);
  scene.add(sparkSet.points);
  sprites.push(sparkSet);
  const STARS = [[1, 0.27, 0.27], [1, 0.62, 0.15], [0.5, 1, 0.25], [0.35, 0.8, 1], [1, 0.35, 1], [1, 0.95, 0.3]];
  function firework(at, big = false) {
    if (reduce) return;
    const [r, g, b] = STARS[Math.floor(Math.random() * STARS.length)];
    for (let i = 0; i < scale(big ? 140 : 60); i += 1) {
      const u = Math.random() * 2 - 1;
      const a = Math.random() * Math.PI * 2;
      const rr = Math.sqrt(1 - u * u);
      const speed = (big ? 7 : 4.5) + Math.random() * 2;
      sparkSet.emit({ x: at.x, y: at.y, z: at.z, vx: Math.cos(a) * rr * speed, vy: u * speed, vz: Math.sin(a) * rr * speed, gravity: -2.5, drag: 1.5, life: 1.2 + Math.random() * 0.6, size: big ? 0.7 : 0.5, frame: 7, frameTo: 0, r: r * 1.6, g: g * 1.6, b: b * 1.6, twinkle: true, fade: 0.45 });
    }
  }

  /* ── the lightning: the bolt the game draws, a jagged run of light from the sky ── */
  const boltMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 1.6, 2), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, fog: false });
  const bolt = new THREE.Group();
  scene.add(bolt);
  const flashGlow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: softDot('rgba(220,230,255,1)'), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, fog: false }));
  scene.add(flashGlow);
  function strike(at) {
    bolt.clear();
    let x = at.x + (Math.random() - 0.5) * 6;
    let z = at.z + (Math.random() - 0.5) * 6;
    const top = at.y + 70;
    const steps = 9;
    for (let i = 0; i < steps; i += 1) {
      const y0 = top - ((top - at.y) * i) / steps;
      const y1 = top - ((top - at.y) * (i + 1)) / steps;
      const nx = i === steps - 1 ? at.x : x + (Math.random() - 0.5) * 5;
      const nz = i === steps - 1 ? at.z : z + (Math.random() - 0.5) * 5;
      const len = Math.hypot(nx - x, y1 - y0, nz - z);
      for (const width of [0.35, 0.9]) {
        const seg = new THREE.Mesh(new THREE.BoxGeometry(width, len, width), boltMat);
        seg.position.set((x + nx) / 2, (y0 + y1) / 2, (z + nz) / 2);
        seg.lookAt(nx, y1, nz);
        seg.rotateX(Math.PI / 2);
        bolt.add(seg);
      }
      x = nx;
      z = nz;
    }
  }

  /* ─────────── the round, as crash.js describes it ─────────── */

  const round = { phase: 'closed', id: null, x: 1, struckFor: null, markers: 0, mine: null };
  let altitude = HOVER;
  let altitudeGoal = HOVER;
  let boltAt = -1e9;
  let fall = null;          // { start, from, vx, vz } while Steve falls
  let cheerUntil = 0;
  let shake = 0;

  /* ─────────── the camera: alongside the ghast, a slow turn round it ─────────── */

  const cam = { pos: new THREE.Vector3(), look: new THREE.Vector3() };
  const goalPos = new THREE.Vector3();
  const goalLook = new THREE.Vector3();
  function frameShot(clock) {
    const a = reduce ? 0.5 : 0.5 + Math.sin(clock * 0.06) * 0.45;
    const near = round.phase === 'betting' || round.phase === 'closed';
    const d = near ? 13 : 15;
    goalLook.set(0, altitude + 2.9, 0);
    goalPos.set(Math.sin(a) * d, altitude + (near ? 6 : 5.5), Math.cos(a) * d);
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
    () => { for (const o of others) o.group.visible = false; },
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
    camera.fov = Math.max(50, THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(30)) / camera.aspect)));
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
  const low = new THREE.Color();
  const top = new THREE.Color();
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

    // Height: the climb follows the round exactly; coming back down for the next one is quick.
    if (round.phase === 'running' || round.phase === 'busted') altitude = altitudeGoal;
    else altitude += (altitudeGoal - altitude) * (reduce ? 1 : 1 - Math.exp(-dt * 2.2));
    const bob = reduce ? 0 : Math.sin(clock * 1.2) * 0.25;
    rider.position.set(0, altitude + bob, 0);
    rider.rotation.y = reduce ? 0 : Math.sin(clock * 0.2) * 0.3;
    poseGhast(ghast.parts, reduce ? 0 : clock * 20);
    for (const o of others) {
      o.a += reduce ? 0 : dt * o.speed;
      o.group.position.set(Math.cos(o.a) * o.r, o.h + Math.sin(clock * 0.8 + o.a) * 0.6, Math.sin(o.a) * o.r);
      o.group.rotation.y = -o.a;
      poseGhast(o.body.parts, reduce ? 0 : clock * 20 + o.r);
    }

    // The sky thins as the ghast climbs: blue to deep blue to night, the stars coming out.
    const thin = clamp01((altitude - 60) / 80);
    top.copy(DAY).lerp(HIGH, thin);
    low.copy(DAY_LOW).lerp(HIGH_LOW, thin);
    skyMat.uniforms.uTop.value.copy(top);
    skyMat.uniforms.uLow.value.copy(low);
    scene.fog.color.copy(low);
    starMat.opacity = clamp01((altitude - 70) / 60) * 0.95;
    hemi.intensity = lerp(1.1, 0.7, thin);
    sunLight.intensity = lerp(1.6, 1.1, thin);
    // Inside the cloud layer the world goes white.
    const inCloud = clamp01(1 - Math.abs(altitude + 2 - (CLOUD_Y + 2)) / 4);
    scene.fog.near = lerp(60, 2, inCloud);
    scene.fog.far = lerp(320, 30, inCloud);
    if (inCloud > 0) scene.fog.color.lerp(new THREE.Color(0xf4f6ff), inCloud);
    if (!reduce) clouds.step(dt);

    // Steve: holding on, cheering, or falling.
    if (fall) {
      const t = (now - fall.start) / 1000;
      steve.position.set(fall.from.x + fall.vx * t, fall.from.y - 4.9 * t * t, fall.from.z + fall.vz * t);
      steve.rotation.set(t * 3, 0, t * 1.4);
      steveMat.color.setRGB(1, t < 0.35 ? 0.45 : 1, t < 0.35 ? 0.45 : 1);
    } else {
      const cheering = now < cheerUntil && !reduce;
      P.rightArm.rotation.x = cheering ? -2.8 + Math.sin(clock * 14) * 0.3 : -0.7;
      P.leftArm.rotation.x = cheering ? -2.8 + Math.sin(clock * 14 + 1) * 0.3 : -0.7;
      P.head.rotation.x = round.phase === 'running' ? 0.15 : 0;
    }

    // The bolt flickers out; the sky's flash with it.
    const b = (now - boltAt) / 1000;
    const flash = b < 0.6 ? (b < 0.08 || (b > 0.16 && b < 0.26) ? 1 : 0.35) * (1 - b / 0.6) : 0;
    boltMat.opacity = flash;
    bolt.visible = flash > 0;
    flashGlow.material.opacity = flash * 0.8;
    if (flash > 0) {
      flashGlow.position.set(0, altitude + 3, 0);
      flashGlow.quaternion.copy(camera.quaternion);
      flashGlow.scale.setScalar(26);
      skyMat.uniforms.uTop.value.lerp(new THREE.Color(0xdfe6ff), flash * 0.6);
    }

    frameShot(clock);
    const k = reduce ? 1 : 1 - Math.exp(-dt * 3);
    cam.pos.lerp(goalPos, k);
    cam.look.lerp(goalLook, k);
    // While climbing, the camera keeps up exactly: lagging behind would let the ghast slide out.
    if (round.phase === 'running') {
      cam.pos.y = goalPos.y;
      cam.look.y = goalLook.y;
    }
    camera.position.copy(cam.pos);
    if (shake > 0.01 && !reduce) {
      camera.position.x += (Math.random() - 0.5) * shake * 0.4;
      camera.position.y += (Math.random() - 0.5) * shake * 0.4;
    }
    shake *= Math.exp(-dt * 3);
    camera.lookAt(cam.look);
    sky.position.copy(camera.position);
    stars.position.copy(camera.position);
    sun.position.copy(camera.position).addScaledVector(SUN_DIR, 400);
    sun.lookAt(camera.position);
    sun.scale.setScalar(40);
    // The ghast's shadow on the meadow, lighter and wider the higher it is; puffs of cloud behind it
    // while it climbs; the village's animals going about their day.
    const lift = clamp01((altitude - HOVER) / 26);
    ghastShadow.material.opacity = 0.7 * (1 - lift);
    ghastShadow.scale.setScalar(1 + lift * 0.6);
    ghastShadow.visible = lift < 1;
    if (!reduce && round.phase === 'running' && Math.random() < dt * (6 + Math.log2(round.x) * 4)) {
      const a = Math.random() * Math.PI * 2;
      puffs.emit({ x: Math.cos(a) * 1.6, y: altitude - 0.8, z: Math.sin(a) * 1.6, vx: Math.cos(a) * 0.4, vy: -1.6 - Math.random(), vz: Math.sin(a) * 0.4, drag: 0.8, life: 1.6, size: 1.3, sizeTo: 2.6, frame: 7, frameTo: 0, r: 1, g: 1, b: 1, a: 0.8, fade: 0.6 });
    }
    herd.step(dt, now, reduce);
    folk.step(dt, now, clock, reduce);
    for (const s of sprites) s.step(dt);
    if (composer) composer.render(dt);
    else renderer.render(scene, camera);
  }

  const controls = {
    onLost: null,
    /** 'strike', 'firework'. */
    onCue: null,
    tier: tier.name,

    /**
     * The round as crash.js has it this frame: `phase` ('betting', 'running', 'busted', 'closed'),
     * for a running round the `seconds` it has climbed at `growth`, for a busted one its `x100`,
     * the round's `id`, the viewer's own bet (`mine`) and how many have cashed out (`cashouts`).
     */
    update({ phase, seconds = 0, growth = 0.07, x100 = 100, id = null, mine = null, cashouts = 0 }) {
      const now = performance.now();
      const changed = phase !== round.phase || id !== round.id;
      if (phase === 'running') {
        round.x = Math.exp(growth * Math.max(0, seconds));
        altitudeGoal = altitudeOf(round.x * 100);
      } else if (phase === 'busted') {
        round.x = x100 / 100;
        altitudeGoal = altitudeOf(x100);
        if (round.struckFor !== id) {
          round.struckFor = id;
          boltAt = now;
          shake = 1.2;
          strike(new THREE.Vector3(0, altitudeGoal + 4.5, 0));
          controls.onCue?.('strike');
          // Steve comes off unless he was already out.
          if (mine?.status !== 'cashed_out') {
            const from = steve.getWorldPosition(new THREE.Vector3());
            scene.add(steve);
            fall = { start: now, from, vx: (Math.random() - 0.5) * 2, vz: 2 };
          }
        }
      } else if (changed) {
        altitudeGoal = HOVER;
        fall = null;
        steveMat.color.setRGB(1, 1, 1);
        seat();
      }
      // Each cash-out seen this round is a firework off the ghast; the viewer's own a big one.
      if (changed) round.markers = cashouts;
      if (cashouts > round.markers) {
        for (let i = round.markers; i < cashouts; i += 1) firework(new THREE.Vector3((Math.random() - 0.5) * 10, altitude + 6 + Math.random() * 4, (Math.random() - 0.5) * 10));
        round.markers = cashouts;
        controls.onCue?.('firework');
      }
      if (mine?.status === 'cashed_out' && round.mine !== `${id}:out`) {
        round.mine = `${id}:out`;
        cheerUntil = now + 2200;
        firework(new THREE.Vector3(0, altitude + 9, 0), true);
      }
      round.phase = phase;
      round.id = id;
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
  frameShot(0);
  cam.pos.copy(goalPos);
  cam.look.copy(goalLook);
  try { renderer.compile(scene, camera); } catch { /* compiled on first use */ }
  raf = requestAnimationFrame(frame);
  return controls;
}
