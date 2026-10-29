/* dice3d.js — Dice in 3D: an archery range on a meadow. The roll runs from 0 to 100 along a wall
 * twenty blocks wide, five points to a block; the side of the line that wins is lime wool, the
 * side that loses red, and a stack of end rods glows on the line itself with a target block on top.
 * Steve draws his bow and the arrow sticks in the wall where the roll landed, the number over it in
 * the game's font.
 *
 * Every block, item, particle and model is the game's own, out of the client jar: the wool,
 * smooth stone and stone bricks of the wall, the end rods on their block model, the target block,
 * the oak signs with the scale on them, hay bales, oak fences and trees, the bow as an item with its
 * three pulling frames, the arrow on ArrowModel's crossed planes, the crit particles, Steve on
 * PlayerModel in the game's bow-and-arrow pose, the fancy clouds and the sun. What is drawn rather
 * than taken is light: the end rods' glow, the flash where an arrow lands.
 *
 * Nothing here decides anything. dice.js sends the bet and is told the roll; this only shows it.
 * The line moves as the player draws it on the slider below. If WebGL is missing or the context is
 * lost, dice.js keeps the flat track alone.
 */
import { reduceMotion } from './util.js';
import { getTHREE, loadImage, softDot } from './mc3d.js';
import { PLAYER, atlas, buildModel, itemModel, makeSprites, pixelTexture, placeEntity } from './mcmodels.js';
import { blobShadow, fancyClouds, glowPoints, gradePass, oakTrees, regionUV, shadowMaterial, skyDome } from './scenery3d.js';
import { BRIGHTNESS, chooseTier, createGovernor, frameMs, minFpsFor, ratioFor } from './quality3d.js';
import { shadeScene, shadedTHREE, smoothen } from './shade3d.js';
import { drawText, fontFromImage, textWidth } from './mcfont.js';

const SPAN = 10_000;
const WALL = 20;                         // blocks across, five points to a block
const HIGH = 4;                          // blocks high
const STEVE_AT = { x: -4.2, z: 9.5 };
const PLAYER_PIXEL = 0.9375 / 16;
const DRAW_MS = 520;                     // the bow drawn
const FLIGHT_MS = 640;
const KEEP = 6;                          // arrows left in the wall
const PLAINS_GRASS = 0x91bd59;
const OAK_LEAVES = 0x77ab2f;

const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
const easeOut = (t) => 1 - (1 - t) ** 3;
/** Where a value (0 - 10000) sits across the wall. */
export const xOf = (value) => -WALL / 2 + (value / SPAN) * WALL;

/**
 * Builds the range into `host` and resolves with its controls, or null when this browser cannot
 * draw it.
 */
export async function createDice3d(host) {
  const threeCore = await getTHREE();
  const probe = document.createElement('canvas');
  const probeGl = probe.getContext('webgl2');
  if (!probeGl) return null;
  const tier = chooseTier(probeGl);
  // Physical materials on medium and high, Lambert on low: the lit look (shade3d.js).
  const THREE = shadedTHREE(threeCore, tier);
  probeGl.getExtension('WEBGL_lose_context')?.loseContext();
  const canvas = document.createElement('canvas');
  canvas.className = 'dice__gl';
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
  renderer.toneMappingExposure = 1.0 * BRIGHTNESS;
  const scale = (n) => Math.max(1, Math.round(n * tier.particles));
  const FRAME_MS = frameMs(tier);
  let nextFrameAt = 0;

  /* ── what is loaded ── */
  const BLOCKS = ['lime_wool', 'red_wool', 'smooth_stone', 'stone_bricks', 'end_rod', 'target_side', 'target_top',
    'hay_block_side', 'hay_block_top', 'oak_planks', 'oak_log', 'oak_log_top', 'oak_leaves', 'grass_block_top', 'oak_sign'];
  const ITEMS = ['bow', 'bow_pulling_0', 'bow_pulling_1', 'bow_pulling_2'];
  const PARTICLE = ['critical_hit', 'glint', ...Array.from({ length: 8 }, (_, i) => `spark_${i}`)];
  let loaded;
  try {
    loaded = await Promise.all([
      Promise.all(BLOCKS.map((name) => loadImage(`assets/img/block/${name}.png`))),
      Promise.all(ITEMS.map((name) => loadImage(`assets/img/items/${name}.png`))),
      Promise.all(PARTICLE.map((name) => loadImage(`assets/img/particle/${name}.png`))),
      loadImage('assets/img/entity/steve.png'),
      loadImage('assets/img/entity/arrow.png'),
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
  const [blockImgs, itemImgs, particleImgs, steveImg, arrowImg, fontImg, shadowImg, cloudImg, sunImg, addons] = loaded;
  const img = Object.fromEntries(BLOCKS.map((name, i) => [name, blockImgs[i]]));
  const item = Object.fromEntries(ITEMS.map((name, i) => [name, itemImgs[i]]));
  const part = Object.fromEntries(PARTICLE.map((name, i) => [name, particleImgs[i]]));
  const font = fontFromImage(fontImg);
  host.prepend(canvas);

  const reduce = reduceMotion();
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x78a7ff);
  scene.fog = new THREE.Fog(0xe9cdb4, 50, 170);
  const shading = shadeScene(THREE, { tier, renderer, scene, env: { top: 0x4a7fe0, horizon: 0xf3d2b0, ground: 0x3a4a2a, sun: [-0.55, 0.5, 0.55], sunColor: 0xffd8a8, intensity: 0.6 }, wind: true });
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 500);
  scene.add(camera);

  let composer = null;
  let bloom = null;
  if (addons) {
    try {
      const target = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: tier.samples });
      composer = new addons.EffectComposer(renderer, target);
      composer.addPass(new addons.RenderPass(scene, camera));
      bloom = new addons.UnrealBloomPass(new THREE.Vector2(4, 4), 0.38, 0.4, 0.95);
      composer.addPass(bloom);
      composer.addPass(new addons.OutputPass());
      composer.addPass(gradePass(THREE, addons, { sharpen: 0, contrast: 1.06, saturation: 1.12, lift: [0.01, 0.015, 0.03], gain: [1.03, 1.01, 0.96], vignette: 0.24 }));
      // Smooth, not sharp: soft shadow in the corners, and the edges blended (shade3d.js).
      smoothen(THREE, addons, composer, camera, { tier, ao: 0.45 });
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
  const box = new THREE.BoxGeometry(1, 1, 1);
  const m4 = new THREE.Matrix4();

  /* ── light ── */
  /* Golden afternoon, as Fishing is lit: a warm sun low enough to throw long shadows does the
   * work, and a cool sky fills them rather than flattening everything. The physical materials
   * also take light from the sky (shade3d.js), so the fill is lower there than on Lambert. */
  scene.add(new THREE.HemisphereLight(0xffe6cc, 0x3c4c66, shading.lit ? 0.72 : 1.05));
  const sunLight = new THREE.DirectionalLight(0xffcf98, shading.lit ? 2.6 : 1.7);
  const SUN_OFFSET = new THREE.Vector3(-20, 19, 22);
  sunLight.position.copy(SUN_OFFSET).add(new THREE.Vector3(0, 0, 4));
  sunLight.target.position.set(0, 0, 4);
  scene.add(sunLight, sunLight.target);
  const shadows = tier.name !== 'low';
  if (shadows) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.set(tier.name === 'high' ? 2048 : 1024, tier.name === 'high' ? 2048 : 1024);
    Object.assign(sunLight.shadow.camera, { left: -20, right: 20, top: 20, bottom: -18, near: 1, far: 100 });
    sunLight.shadow.bias = -0.0006;
    sunLight.shadow.normalBias = 0.03;
  }

  /* ── the sky, the meadow, the trees behind the range ── */
  const sky = skyDome(THREE, { top: 0x4a7fe0, low: 0xf3d2b0 });
  scene.add(sky);
  const sun = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: pixelTexture(THREE, sunImg), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false, color: new THREE.Color(1.5, 1.4, 1.2) }));
  sun.renderOrder = -9;
  scene.add(sun);
  const SUN_DIR = SUN_OFFSET.clone().normalize();
  const clouds = fancyClouds(THREE, cloudImg, { y: 44, radius: tier.name === 'low' ? 170 : 240 });
  scene.add(clouds.group);
  const shadowMat = shadowMaterial(THREE, shadowImg);
  {
    const grass = new THREE.Mesh(new THREE.PlaneGeometry(320, 320).rotateX(-Math.PI / 2), lambert(tex('grass_block_top', 320, 320), { color: PLAINS_GRASS }));
    grass.position.y = -0.01;
    grass.receiveShadow = true;
    scene.add(grass);
    scene.add(oakTrees(THREE, { bark: lambert(tex('oak_log')), ring: lambert(tex('oak_log_top')), leaves: lambert(tex('oak_leaves'), { color: OAK_LEAVES, alphaTest: 0.5 }) },
      [[-8, -7, 5], [-1, -9, 6], [7, -7, 5], [14, -10, 6], [-15, -11, 5], [20, -4, 5], [-21, -2, 6], [3, -16, 5]], 7));
  }

  /* ── the wall: smooth stone, framed in stone brick, its face the two sides of the line ── */
  {
    const body = new THREE.Mesh(new THREE.BoxGeometry(WALL, HIGH, 1), lambert(tex('smooth_stone', WALL, HIGH)));
    body.position.set(0, HIGH / 2, -0.5);
    body.castShadow = true;
    body.receiveShadow = true;
    scene.add(body);
    const bricks = [];
    for (let y = 0; y <= HIGH; y += 1) for (const x of [-WALL / 2 - 1, WALL / 2]) bricks.push([x + 0.5, y + 0.5, -0.5]);
    for (let x = -WALL / 2; x < WALL / 2; x += 1) bricks.push([x + 0.5, HIGH + 0.5, -0.5]);
    const frame = new THREE.InstancedMesh(box, lambert(tex('stone_bricks')), bricks.length);
    bricks.forEach(([x, y, z], i) => frame.setMatrixAt(i, m4.makeTranslation(x, y, z)));
    frame.castShadow = true;
    frame.receiveShadow = true;
    scene.add(frame);
    // Hay bales against the ends, and an oak fence down each side of the range.
    const hay = new THREE.InstancedMesh(box, [lambert(tex('hay_block_side')), lambert(tex('hay_block_side')), lambert(tex('hay_block_top')), lambert(tex('hay_block_top')), lambert(tex('hay_block_side')), lambert(tex('hay_block_side'))], 6);
    [[-12.5, 0.5, 0.6], [-12.5, 1.5, 0.6], [-13.5, 0.5, 1.6], [12.5, 0.5, 0.6], [13.5, 0.5, 0.4], [12.5, 0.5, 1.8]].forEach(([x, y, z], i) => hay.setMatrixAt(i, m4.makeTranslation(x, y, z)));
    hay.castShadow = true;
    hay.receiveShadow = true;
    scene.add(hay);
    const posts = [];
    const rails = [];
    for (const side of [-1, 1]) {
      for (let z = 3; z <= 15; z += 2) posts.push([side * 12.5, z]);
      for (let z = 3; z < 15; z += 2) rails.push([side * 12.5, z + 1]);
    }
    const plank = lambert(tex('oak_planks'));
    const post = new THREE.InstancedMesh(new THREE.BoxGeometry(4 / 16, 1, 4 / 16), plank, posts.length);
    posts.forEach(([x, z], i) => post.setMatrixAt(i, m4.makeTranslation(x, 0.5, z)));
    const railGeo = new THREE.BoxGeometry(2 / 16, 3 / 16, 2);
    const rail = new THREE.InstancedMesh(railGeo, plank, rails.length * 2);
    rails.forEach(([x, z], i) => {
      rail.setMatrixAt(i * 2, m4.makeTranslation(x, 0.4, z));
      rail.setMatrixAt(i * 2 + 1, m4.makeTranslation(x, 0.8, z));
    });
    for (const mesh of [post, rail]) {
      mesh.castShadow = true;
      scene.add(mesh);
    }
  }
  // The face: lime on the winning side, red on the losing, each its own block grid carried across
  // the line so the wool does not jump where it is cut.
  const faces = ['lime_wool', 'red_wool'].map((name) => {
    const map = tex(name, 1, HIGH);
    map.wrapS = map.wrapT = THREE.RepeatWrapping;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, HIGH), lambert(map));
    mesh.receiveShadow = true;
    scene.add(mesh);
    return { name, map, mesh };
  });
  // The scale: an oak sign every twenty-five points, on the coping.
  {
    const cut = (x, y, w, h) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      c.getContext('2d').drawImage(img.oak_sign, x, y, w, h, 0, 0, w, h);
      return c;
    };
    const wood = lambert(pixelTexture(THREE, cut(0, 17, 24, 12)));
    for (const value of [0, 25, 50, 75, 100]) {
      const face = cut(0, 1, 24, 12);
      const c = document.createElement('canvas');
      c.width = 96;
      c.height = 48;
      const g = c.getContext('2d');
      g.imageSmoothingEnabled = false;
      g.drawImage(face, 0, 0, 96, 48);
      const text = String(value);
      drawText(g, font, text, Math.round((96 - textWidth(font, text) * 3) / 2), 12, 3, '#000000', false);
      const board = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.8, 2 / 16), [wood, wood, wood, wood, lambert(pixelTexture(THREE, c)), wood]);
      board.position.set(xOf(value * 100), HIGH + 0.5, 0.07);
      board.castShadow = true;
      scene.add(board);
    }
  }
  // The line: end rods stacked up the wall, a target block on the coping over them.
  const lineGroup = new THREE.Group();
  {
    const rodMat = new THREE.MeshBasicMaterial({ map: tex('end_rod'), color: new THREE.Color(1.2, 1.18, 1.15), toneMapped: false });
    const base = regionUV(new THREE.BoxGeometry(4 / 16, 1 / 16, 4 / 16), [[2, 6, 6, 7], [2, 6, 6, 7], [2, 2, 6, 6], [6, 6, 2, 2], [2, 6, 6, 7], [2, 6, 6, 7]]);
    base.translate(0, 0.5 / 16, 0);
    const stick = regionUV(new THREE.BoxGeometry(2 / 16, 15 / 16, 2 / 16), [[0, 0, 2, 15], [0, 0, 2, 15], [2, 0, 4, 2], [2, 0, 4, 2], [0, 0, 2, 15], [0, 0, 2, 15]]);
    stick.translate(0, 1 / 16 + 7.5 / 16, 0);
    for (let y = 0; y < HIGH; y += 1) {
      for (const g of [base, stick]) {
        const rod = new THREE.Mesh(g, rodMat);
        rod.position.set(0, y, 0.16);
        lineGroup.add(rod);
      }
    }
    const targetBlock = new THREE.Mesh(box, [lambert(tex('target_side')), lambert(tex('target_side')), lambert(tex('target_top')), lambert(tex('target_top')), lambert(tex('target_side')), lambert(tex('target_side'))]);
    targetBlock.position.set(0, HIGH + 1.5, -0.5);
    targetBlock.castShadow = true;
    lineGroup.add(targetBlock);
  }
  scene.add(lineGroup);
  const rodGlow = glowPoints(THREE, [0.5, 1.5, 2.5, 3.5].map((y) => [0, y, 0.3]), { size: 1.6, color: 0xfff2dc, opacity: 0.38 });
  lineGroup.add(rodGlow.points);

  /* ── Steve with his bow ── */
  const steveMat = new THREE.MeshLambertMaterial({ map: pixelTexture(THREE, steveImg), alphaTest: 0.5, side: THREE.DoubleSide });
  const player = buildModel(THREE, [{ material: steveMat, def: PLAYER }]);
  const steve = placeEntity(THREE, player, PLAYER_PIXEL);
  const P = player.parts;
  steve.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  steve.position.set(STEVE_AT.x, 0, STEVE_AT.z);
  scene.add(steve);
  const steveShadow = blobShadow(THREE, shadowMat, 0.42);
  steveShadow.position.set(STEVE_AT.x, 0.015, STEVE_AT.z);
  scene.add(steveShadow);
  // The bow in his right hand, one model per frame of the draw.
  const bows = ITEMS.map((name) => {
    const model = itemModel(THREE, item[name]);
    const mesh = new THREE.Mesh(model.geometry, model.material);
    mesh.visible = name === 'bow';
    return mesh;
  });
  {
    const mount = new THREE.Group();
    mount.position.set(-1, 10, -1);
    mount.rotation.set(0, -Math.PI / 2, Math.PI * 0.75);
    mount.scale.setScalar(14);
    for (const b of bows) mount.add(b);
    P.rightArm.add(mount);
  }

  /* ── the arrow, on ArrowModel: two planes crossed along the shaft, the fletching across its tail ── */
  const arrowMat = new THREE.MeshLambertMaterial({ map: pixelTexture(THREE, arrowImg), alphaTest: 0.5, side: THREE.DoubleSide });
  const arrowGeo = (() => {
    const shaft = (angle) => {
      const g = new THREE.PlaneGeometry(1, 5 / 16);
      const uv = g.attributes.uv;
      for (let i = 0; i < uv.count; i += 1) uv.setXY(i, (uv.getX(i) * 16) / 32, 1 - ((1 - uv.getY(i)) * 5) / 32);
      g.rotateX(angle);
      return g;
    };
    const tail = new THREE.PlaneGeometry(5 / 16, 5 / 16);
    {
      const uv = tail.attributes.uv;
      for (let i = 0; i < uv.count; i += 1) uv.setXY(i, (uv.getX(i) * 5) / 32, 1 - (5 + (1 - uv.getY(i)) * 5) / 32);
      tail.rotateY(Math.PI / 2);
      tail.translate(-0.42, 0, 0);
    }
    const parts = [shaft(Math.PI / 4), shaft(-Math.PI / 4), tail];
    const merged = new THREE.BufferGeometry();
    const pos = [];
    const nor = [];
    const uvs = [];
    const index = [];
    let offset = 0;
    for (const g of parts) {
      const gi = g.index.array;
      for (let i = 0; i < gi.length; i += 1) index.push(gi[i] + offset);
      pos.push(...g.attributes.position.array);
      nor.push(...g.attributes.normal.array);
      uvs.push(...g.attributes.uv.array);
      offset += g.attributes.position.count;
    }
    merged.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    merged.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    merged.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    merged.setIndex(index);
    return merged;
  })();
  const arrows = [];   // in the wall, oldest first

  /* ── particles and the flash where an arrow lands ── */
  const sprites = [];
  const sprite = (map, opts) => {
    const s = makeSprites(THREE, { map, ...opts });
    scene.add(s.points);
    sprites.push(s);
    return s;
  };
  const crits = sprite(pixelTexture(THREE, part.critical_hit), { count: scale(160) });
  const sparkles = sprite(pixelTexture(THREE, part.glint), { count: scale(120), additive: true });
  const sparks = sprite(atlas(THREE, Array.from({ length: 8 }, (_, i) => part[`spark_${i}`]), 8, 8).map, { cols: 8, rows: 1, count: scale(420), additive: true });
  const STARS = [[1, 0.27, 0.27], [1, 0.62, 0.15], [0.5, 1, 0.25], [0.35, 0.8, 1], [1, 0.35, 1], [1, 0.95, 0.3]];
  function firework(x, y, z) {
    if (reduce) return;
    const [r, g, b] = STARS[Math.floor(Math.random() * STARS.length)];
    for (let i = 0; i < scale(70); i += 1) {
      const u = Math.random() * 2 - 1;
      const a = Math.random() * Math.PI * 2;
      const rr = Math.sqrt(1 - u * u);
      const speed = 4 + Math.random() * 2;
      sparks.emit({ x, y, z, vx: Math.cos(a) * rr * speed, vy: u * speed, vz: Math.sin(a) * rr * speed, gravity: -2.5, drag: 1.6, life: 1.2 + Math.random() * 0.6, size: 0.45, frame: 7, frameTo: 0, r: r * 1.6, g: g * 1.6, b: b * 1.6, twinkle: true, fade: 0.45 });
    }
  }
  const flash = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: softDot('rgba(255,255,255,1)'), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
  flash.position.z = 0.05;
  scene.add(flash);
  let flashAt = -1e9;
  // The roll over the arrow, in the game's font, green for a win and red for a miss.
  const label = (() => {
    const c = document.createElement('canvas');
    c.width = 160;
    c.height = 40;
    const texture = pixelTexture(THREE, c);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.6), new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false }));
    mesh.visible = false;
    mesh.renderOrder = 3;
    scene.add(mesh);
    return { c, texture, mesh, at: 0 };
  })();
  function writeLabel(text, win) {
    const g = label.c.getContext('2d');
    g.clearRect(0, 0, 160, 40);
    g.imageSmoothingEnabled = false;
    const px = 4;
    drawText(g, font, text, Math.round((160 - textWidth(font, text) * px) / 2), 4, px, win ? '#55ff55' : '#ff5555', true);
    label.texture.needsUpdate = true;
  }
  const fireworksDue = [];

  /* ── the line ── */
  let line = 5000;
  let side = 'under';
  function placeLine() {
    const x = xOf(line);
    const leftW = x + WALL / 2;
    const rightW = WALL - leftW;
    const winLeft = side === 'under';
    const [lime, red] = faces;
    const left = winLeft ? lime : red;
    const right = winLeft ? red : lime;
    left.mesh.scale.x = Math.max(0.001, leftW);
    left.mesh.position.set(-WALL / 2 + leftW / 2, HIGH / 2, 0.01);
    left.map.repeat.set(leftW, HIGH);
    left.map.offset.x = 0;
    right.mesh.scale.x = Math.max(0.001, rightW);
    right.mesh.position.set(x + rightW / 2, HIGH / 2, 0.01);
    right.map.repeat.set(rightW, HIGH);
    right.map.offset.x = leftW % 1;
    lineGroup.position.x = x;
  }
  placeLine();

  /* ── framing, resolution, stepping down ── */
  const goalPos = new THREE.Vector3();
  const goalLook = new THREE.Vector3();
  const cam = { pos: new THREE.Vector3(), look: new THREE.Vector3() };
  let back = 21;
  function frameShot(clock) {
    const sway = reduce ? 0 : Math.sin(clock * 0.19) * 0.5;
    goalLook.set(-0.3, 2.0, 0);
    goalPos.set(2.2 + sway, 4.8, back);
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
    // Far enough back that the whole wall, frame and all, is in the picture at any shape.
    back = Math.max(14.5, 12.8 / (Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect));
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

  /* ─────────── the frame ─────────── */
  const archer = { drawAt: 0, aimYaw: 0, aimPitch: 0, cheerUntil: 0, sulkUntil: 0 };
  let flight = null;
  let raf = 0;
  let last = performance.now();
  let clock = 0;
  const tmp = new THREE.Vector3();
  const forward = new THREE.Vector3(1, 0, 0);
  function frame() {
    raf = requestAnimationFrame(frame);
    const now = performance.now();
    if (FRAME_MS) {
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
    const k = reduce ? 1 : 1 - Math.exp(-dt * 2.6);
    cam.pos.lerp(goalPos, k);
    cam.look.lerp(goalLook, k);
    camera.position.copy(cam.pos);
    camera.lookAt(cam.look);
    sky.position.copy(camera.position);
    sun.position.copy(camera.position).addScaledVector(SUN_DIR, 260);
    sun.scale.setScalar(34);
    sun.lookAt(camera.position);
    clouds.step(reduce ? 0 : dt);

    // Steve: the bow-and-arrow pose (HumanoidModel), both arms out along his aim while he draws.
    {
      const drawing = archer.drawAt && now - archer.drawAt < DRAW_MS + 220;
      const pull = drawing ? clamp01((now - archer.drawAt) / DRAW_MS) : 0;
      const frameIndex = !drawing ? 0 : pull < 0.35 ? 1 : pull < 0.7 ? 2 : 3;
      bows.forEach((b, i) => { b.visible = i === frameIndex; });
      steve.rotation.y = archer.aimYaw;
      const cheering = now < archer.cheerUntil && !reduce;
      P.head.rotation.x = drawing ? -archer.aimPitch : now < archer.sulkUntil ? 0.55 : 0.05;
      P.head.rotation.y = 0;
      if (drawing) {
        P.rightArm.rotation.set(-Math.PI / 2 - archer.aimPitch, -0.1, 0);
        P.leftArm.rotation.set(-Math.PI / 2 - archer.aimPitch, 0.5, 0);
      } else if (cheering) {
        P.rightArm.rotation.set(-2.6 + Math.sin(clock * 14) * 0.3, 0, 0);
        P.leftArm.rotation.set(-2.7 + Math.sin(clock * 14 + 1) * 0.3, 0, 0);
      } else {
        P.rightArm.rotation.set(-0.25 + (reduce ? 0 : Math.sin(clock * 1.3) * 0.04), 0, 0);
        P.leftArm.rotation.set(reduce ? 0 : -Math.sin(clock * 1.3) * 0.04, 0, 0);
      }
      steve.position.y = cheering ? Math.abs(Math.sin(clock * 7)) * 0.3 : 0;
    }

    if (flight) {
      const f = clamp01((now - flight.at) / FLIGHT_MS);
      if (f > 0) {
        flight.arrow.visible = true;
        const { from, to, lift } = flight;
        const y = from.y + (to.y - from.y) * f + Math.sin(f * Math.PI) * lift;
        tmp.set(from.x + (to.x - from.x) * f, y, from.z + (to.z - from.z) * f);
        const dy = (to.y - from.y) + Math.cos(f * Math.PI) * Math.PI * lift;
        const dir = new THREE.Vector3(to.x - from.x, dy, to.z - from.z).normalize();
        flight.arrow.position.copy(tmp);
        flight.arrow.quaternion.setFromUnitVectors(forward, dir);
      }
      if (f >= 1) {
        const done = flight;
        flight = null;
        done.resolve();
      }
    }
    for (let i = 0; i < arrows.length; i += 1) {
      const a = arrows[i];
      const age = arrows.length - 1 - i;
      a.material.opacity = age === 0 ? 1 : Math.max(0.25, 1 - age * 0.15);
    }
    {
      const e = (now - flashAt) / 600;
      flash.material.opacity = e < 1 ? (1 - e) * 0.7 : 0;
      flash.scale.setScalar(1 + easeOut(clamp01(e)) * 2.5);
    }
    if (label.mesh.visible) {
      const e = (now - label.at) / 1000;
      label.mesh.quaternion.copy(camera.quaternion);
      label.mesh.position.y = label.y + (reduce ? 0 : easeOut(clamp01(e / 0.4)) * 0.35);
      label.mesh.scale.setScalar(reduce ? 1 : 0.6 + easeOut(clamp01(e / 0.25)) * 0.4);
    }
    for (let i = fireworksDue.length - 1; i >= 0; i -= 1) {
      if (now < fireworksDue[i].at) continue;
      const [f] = fireworksDue.splice(i, 1);
      firework(f.x, f.y, f.z);
      controls.onCue?.('firework');
    }
    if (!reduce) rodGlow.material.opacity = 0.36 + Math.sin(clock * 3) * 0.04;
    for (const s of sprites) s.step(dt);
    if (composer) composer.render(dt);
    else renderer.render(scene, camera);
  }

  resize();
  frameShot(0);
  cam.pos.copy(goalPos);
  cam.look.copy(goalLook);
  archer.aimYaw = Math.atan2(-STEVE_AT.x, -STEVE_AT.z);
  try { renderer.compile(scene, camera); } catch { /* compiled on first use */ }
  raf = requestAnimationFrame(frame);

  const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, reduce ? 0 : ms); });
  const controls = {
    onLost: null,
    /** 'draw', 'shoot', 'hit', 'firework'. */
    onCue: null,
    tier: tier.name,

    /** The line (0 - 10000) and the side that wins, as the player draws it. */
    setLine(target, direction) {
      if (target === line && direction === side) return;
      line = target;
      side = direction;
      placeLine();
    },
    /** Shoots an arrow to `roll`; resolves when it is in the wall. */
    async shoot(roll, win, bps = 0) {
      const to = new THREE.Vector3(xOf(roll), 1.1 + ((roll * 7919) % 1000) / 1000 * 1.9, 0.02);
      const hand = new THREE.Vector3(STEVE_AT.x + 0.25, 1.45, STEVE_AT.z - 0.4);
      archer.aimYaw = Math.atan2(to.x - STEVE_AT.x, to.z - STEVE_AT.z);
      archer.aimPitch = Math.atan2(to.y - 1.45, Math.hypot(to.x - STEVE_AT.x, to.z - STEVE_AT.z)) + 0.08;
      archer.drawAt = performance.now();
      controls.onCue?.('draw');
      await wait(DRAW_MS);
      controls.onCue?.('shoot');
      const arrow = new THREE.Mesh(arrowGeo, arrowMat.clone());
      arrow.scale.setScalar(1.35);
      arrow.material.transparent = true;
      arrow.castShadow = true;
      arrow.visible = false;
      scene.add(arrow);
      if (!reduce) {
        await new Promise((resolve) => {
          flight = { arrow, from: hand, to: to.clone().add(new THREE.Vector3(0, 0, 0.35)), lift: 0.9, at: performance.now(), resolve };
        });
      }
      // In the wall: the head buried, the shaft and fletching standing out of it toward the bow.
      const dir = new THREE.Vector3().subVectors(to, hand).normalize();
      arrow.visible = true;
      arrow.position.copy(to).addScaledVector(dir, -0.3);
      arrow.quaternion.setFromUnitVectors(forward, dir);
      arrows.push(arrow);
      while (arrows.length > KEEP) {
        const old = arrows.shift();
        scene.remove(old);
        old.material.dispose();
      }
      archer.drawAt = 0;
      const now = performance.now();
      flashAt = now;
      flash.position.set(to.x, to.y, 0.05);
      flash.material.color.setHex(win ? 0x66ff66 : 0xff5544);
      writeLabel((roll / 100).toFixed(2), win);
      label.mesh.visible = true;
      label.at = now;
      label.y = Math.min(HIGH + 1.4, to.y + 0.9);
      label.mesh.position.set(to.x, label.y, 0.6);
      controls.onCue?.('hit');
      if (!reduce) {
        for (let i = 0; i < scale(win ? 26 : 14); i += 1) {
          const a = Math.random() * Math.PI * 2;
          const v = 1 + Math.random() * 2;
          crits.emit({ x: to.x, y: to.y, z: 0.15, vx: Math.cos(a) * v, vy: Math.sin(a) * v + 0.6, vz: 0.6 + Math.random(), gravity: -6, drag: 0.8, life: 0.6 + Math.random() * 0.4, size: 0.16, r: win ? 0.6 : 1, g: win ? 1 : 0.6, b: win ? 0.6 : 0.5, fade: 0.3 });
        }
        if (win) {
          for (let i = 0; i < scale(12); i += 1) sparkles.emit({ x: to.x + (Math.random() - 0.5), y: to.y + (Math.random() - 0.5), z: 0.3, vy: 0.5 + Math.random() * 0.5, life: 0.8 + Math.random() * 0.5, size: 0.14, sizeTo: 0.04, r: 0.7, g: 1.2, b: 0.7, fade: 0.4 });
        }
      }
      const x = bps / 10_000;
      if (win) {
        archer.cheerUntil = now + (x >= 5 ? 2200 : 1100);
        if (x >= 5) {
          const count = x >= 25 ? 4 : 2;
          for (let i = 0; i < count; i += 1) fireworksDue.push({ at: now + 250 + i * 380, x: (Math.random() - 0.5) * 14, y: 8 + Math.random() * 3, z: -2 - Math.random() * 3 });
        }
      } else {
        archer.sulkUntil = now + 1200;
      }
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
  return controls;
}
