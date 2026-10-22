/* icefishing3d.js — Ice Fishing in 3D: a frozen lake in a snowy taiga at night, the northern lights
 * over it, and twenty-five places to drill through the ice -- some of it thin.
 *
 * Every block, item, particle and model is the game's own, out of the client jar: the ice and packed
 * ice of the lake and the snow on it, the spruces on the shore, the cod and salmon swimming under the
 * clear ice, the frosted-ice cracks as a hole is drilled, the ice breaking as the game breaks a block,
 * the splash, the catch extruded from its sprite, Steve on PlayerModel, the fireworks. What is drawn
 * rather than taken is light: the aurora, the stars, the moonlight, the lanterns' glow, a hole lit
 * under the cursor.
 *
 * Snow falls in the sheets the game draws round a player, scrolling the same weather texture.
 *
 * Nothing here decides anything. icefishing.js starts the game, sends each hole the player picks, and
 * says what came up: a fish, or thin ice. If WebGL is missing or the context is lost, icefishing.js
 * shows the flat lake.
 *
 * Low-end machines get less (quality3d.js): no glow, fewer flakes, stars and fish, a steady thirty
 * frames a second; a machine that cannot keep up steps down on its own.
 */
import { reduceMotion } from './util.js';
import { getTHREE, loadImage } from './mc3d.js';
import { COD, PLAYER, SALMON, atlas, buildModel, itemModel, makeSprites, pixelTexture, placeEntity, poseCod, poseSalmon } from './mcmodels.js';
import { chooseTier, createGovernor, frameMs, minFpsFor, ratioFor } from './quality3d.js';

const PLAYER_PIXEL = 0.9375 / 16;
const GRID = 5;
const STEP = 1.7;            // blocks between hole centres
const TILE = 1.42;           // a hole's patch of clear ice
const STEVE_AT = { x: -6.1, z: 1.4 };
const GLINTS = new Set(['heart_of_the_sea', 'nautilus_shell']);

const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
const easeOut = (t) => 1 - (1 - t) ** 3;
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
/** The centre of a hole, 0-24 in reading order, on the lake. */
export const holeAt = (hole) => ({ x: ((hole % GRID) - (GRID - 1) / 2) * STEP, z: (Math.floor(hole / GRID) - (GRID - 1) / 2) * STEP });

/**
 * Builds the lake into `host` and resolves with its controls, or null when this browser cannot draw
 * it. `catches` are the item ids a hole can bring up, `icon(id)` the sprite of each.
 */
export async function createIce3d(host, { catches, icon }) {
  const THREE = await getTHREE();
  const probe = document.createElement('canvas');
  const probeGl = probe.getContext('webgl2');
  if (!probeGl) return null;
  const tier = chooseTier(probeGl);
  probeGl.getExtension('WEBGL_lose_context')?.loseContext();
  const canvas = document.createElement('canvas');
  canvas.className = 'icefish__gl';
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
  renderer.toneMappingExposure = 1.1;
  const scale = (n) => Math.max(1, Math.round(n * tier.particles));
  const FRAME_MS = frameMs(tier);
  let nextFrameAt = 0;

  /* ── what is loaded ── */
  const BLOCKS = ['ice', 'packed_ice', 'snow', 'grass_block_snow', 'spruce_log', 'spruce_log_top', 'spruce_leaves', 'lantern',
    'frosted_ice_0', 'frosted_ice_1', 'frosted_ice_2', 'frosted_ice_3', 'water_still', 'campfire_log_lit', 'campfire_fire'];
  const ENTITY = ['steve', 'cod', 'salmon', 'experience_orb'];
  const ENV = ['moon', 'snow'];
  const PARTICLE = ['glint', 'big_smoke_0', 'big_smoke_4', 'big_smoke_8', 'big_smoke_11',
    ...[0, 1, 2, 3].map((i) => `splash_${i}`), ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => `spark_${i}`)];
  let loaded;
  try {
    loaded = await Promise.all([
      Promise.all(BLOCKS.map((name) => loadImage(`assets/img/block/${name}.png`))),
      Promise.all(ENTITY.map((name) => loadImage(`assets/img/entity/${name}.png`))),
      Promise.all(ENV.map((name) => loadImage(`assets/img/env/${name}.png`))),
      Promise.all(PARTICLE.map((name) => loadImage(`assets/img/particle/${name}.png`))),
      loadImage('assets/img/items/fishing_rod.png'),
      loadImage('assets/img/misc/enchanted_glint_item.png'),
      Promise.all(catches.map((id) => loadImage(icon(id)).catch(() => null))),
      tier.composer
        ? import(/* @vite-ignore */ new URL('assets/vendor/three-addons.js', document.baseURI).href).catch(() => null)
        : Promise.resolve(null),
    ]);
  } catch {
    renderer.dispose();
    return null;
  }
  const [blockImgs, entityImgs, envImgs, particleImgs, rodImg, glintImg, catchImgs, addons] = loaded;
  const img = Object.fromEntries(BLOCKS.map((name, i) => [name, blockImgs[i]]));
  const ent = Object.fromEntries(ENTITY.map((name, i) => [name, entityImgs[i]]));
  const [moonImg, snowImg] = envImgs;
  const part = Object.fromEntries(PARTICLE.map((name, i) => [name, particleImgs[i]]));
  host.prepend(canvas);

  const reduce = reduceMotion();
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x0b1430, 0.02);
  const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 400);
  scene.add(camera);

  let composer = null;
  let bloom = null;
  if (addons) {
    try {
      const target = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: tier.antialias ? 4 : 0 });
      composer = new addons.EffectComposer(renderer, target);
      composer.addPass(new addons.RenderPass(scene, camera));
      bloom = new addons.UnrealBloomPass(new THREE.Vector2(4, 4), 0.6, 0.55, 0.92);
      composer.addPass(bloom);
      composer.addPass(new addons.OutputPass());
    } catch {
      composer = null;
      bloom = null;
    }
  }
  const tex = (name, repeat = 1) => {
    const t = pixelTexture(THREE, img[name]);
    if (repeat !== 1) {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(repeat, repeat);
    }
    return t;
  };
  /** One frame of an animated block texture, as its own canvas texture. */
  const frameTex = (name, frame = 0) => {
    const c = document.createElement('canvas');
    c.width = c.height = 16;
    c.getContext('2d').drawImage(img[name], 0, frame * 16, 16, 16, 0, 0, 16, 16);
    return pixelTexture(THREE, c);
  };

  /* ── light: the moon, and warm points of lanterns and fire ── */
  scene.add(new THREE.HemisphereLight(0x6f88cc, 0x141a30, 0.85));
  const MOON_DIR = new THREE.Vector3(-0.45, 0.55, -0.7).normalize();
  const moonLight = new THREE.DirectionalLight(0xbcd2ff, 1.15);
  moonLight.position.copy(MOON_DIR).multiplyScalar(40);
  scene.add(moonLight, moonLight.target);

  /* ── the sky: night, stars, the moon, and the northern lights ── */
  const sky = new THREE.Mesh(new THREE.SphereGeometry(300, 24, 12), new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: { uTop: { value: new THREE.Color(0x050a1c) }, uLow: { value: new THREE.Color(0x1a2a55) } },
    vertexShader: 'varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform vec3 uTop; uniform vec3 uLow; varying vec3 vDir;
      void main() {
        gl_FragColor = vec4(mix(uLow, uTop, smoothstep(-0.05, 0.5, vDir.y)), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  }));
  sky.renderOrder = -10;
  scene.add(sky);
  const STAR_COUNT = scale(700);
  const starPos = new Float32Array(STAR_COUNT * 3);
  {
    const rand = seeded(7);
    for (let i = 0; i < STAR_COUNT; i += 1) {
      const y = 0.08 + rand() * 0.92;
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(1 - y * y);
      starPos.set([Math.cos(a) * r * 250, y * 250, Math.sin(a) * r * 250], i * 3);
    }
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.9, depthWrite: false }));
  stars.renderOrder = -9;
  scene.add(stars);
  const moon = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
    map: pixelTexture(THREE, moonImg), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false,
    color: new THREE.Color(1.6, 1.7, 1.9),
  }));
  moon.renderOrder = -8;
  scene.add(moon);
  const aurora = new THREE.Mesh(new THREE.CylinderGeometry(150, 150, 70, tier.name === 'low' ? 48 : 96, 1, true, Math.PI * 0.62, Math.PI * 0.76), new THREE.ShaderMaterial({
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform float uTime; varying vec2 vUv;
      float wave(float x, float t) { return sin(x * 9.0 + t * 0.35) * 0.5 + sin(x * 23.0 - t * 0.6) * 0.25 + sin(x * 41.0 + t * 0.9) * 0.12; }
      void main() {
        float x = vUv.x;
        float fold = wave(x, uTime);
        float h = vUv.y - (0.32 + fold * 0.08);
        float curtain = smoothstep(0.0, 0.05, h) * (1.0 - smoothstep(0.05, 0.55, h));
        float rays = 0.55 + 0.45 * sin(x * 260.0 + fold * 18.0 + uTime * 0.7);
        float band = 0.6 + 0.4 * sin(x * 6.0 - uTime * 0.2);
        vec3 col = mix(vec3(0.15, 1.0, 0.55), vec3(0.55, 0.25, 1.0), smoothstep(0.12, 0.5, h));
        float a = curtain * rays * band * smoothstep(0.0, 0.08, x) * (1.0 - smoothstep(0.92, 1.0, x));
        gl_FragColor = vec4(col * a * 0.9, a);
      }`,
  }));
  aurora.renderOrder = -7;
  scene.add(aurora);
  const placeSky = (at) => {
    sky.position.copy(at);
    stars.position.copy(at);
    aurora.position.set(at.x, at.y + 38, at.z);
    moon.position.copy(at).addScaledVector(MOON_DIR, 230);
    moon.lookAt(at);
    moon.scale.setScalar(20);
  };

  /* ── under the ice: dark water and the fish in it, seen through the clear holes ── */
  const waterTex = frameTex('water_still');
  waterTex.wrapS = waterTex.wrapT = THREE.RepeatWrapping;
  waterTex.repeat.set(12, 12);
  const water = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), new THREE.MeshBasicMaterial({ map: waterTex, color: 0x1f468e, fog: false }));
  water.rotation.x = -Math.PI / 2;
  water.position.y = -1.3;
  scene.add(water);
  const fishSkins = {
    cod: new THREE.MeshBasicMaterial({ map: pixelTexture(THREE, ent.cod), alphaTest: 0.5, side: THREE.DoubleSide, color: 0x9fb4d8, fog: false }),
    salmon: new THREE.MeshBasicMaterial({ map: pixelTexture(THREE, ent.salmon), alphaTest: 0.5, side: THREE.DoubleSide, color: 0x9fb4d8, fog: false }),
  };
  const fish = Array.from({ length: Math.max(3, Math.round(9 * tier.creatures)) }, (_, i) => {
    const kind = i % 3 === 2 ? 'salmon' : 'cod';
    const model = buildModel(THREE, [{ material: fishSkins[kind], def: kind === 'cod' ? COD : SALMON }]);
    const entity = placeEntity(THREE, model, 1 / 16);
    entity.scale.setScalar(1.1);
    scene.add(entity);
    return { kind, model, entity, r: 0.8 + (i % 4) * 0.9, speed: 0.25 + (i % 3) * 0.1, phase: i * 1.37, y: -0.32 - (i % 2) * 0.18 };
  });
  /* The lake: snow lying on the ice all round, and a field of twenty-five patches of clear ice in it. */
  const LAKE = 60;
  const FIELD = STEP * GRID + 0.6;
  {
    // Snow over the lake with the field cut out of it: a square with a square hole, a block a texture.
    const outer = new THREE.Shape([[-LAKE / 2, -LAKE / 2], [LAKE / 2, -LAKE / 2], [LAKE / 2, LAKE / 2], [-LAKE / 2, LAKE / 2]].map(([x, y]) => new THREE.Vector2(x, y)));
    outer.holes.push(new THREE.Path([[-FIELD / 2, -FIELD / 2], [-FIELD / 2, FIELD / 2], [FIELD / 2, FIELD / 2], [FIELD / 2, -FIELD / 2]].map(([x, y]) => new THREE.Vector2(x, y))));
    const snowTex = tex('snow');
    snowTex.wrapS = snowTex.wrapT = THREE.RepeatWrapping;
    const snowTop = new THREE.Mesh(new THREE.ShapeGeometry(outer), new THREE.MeshLambertMaterial({ map: snowTex, color: 0xaebddc }));
    snowTop.rotation.x = -Math.PI / 2;
    snowTop.position.y = 0.001;
    scene.add(snowTop);
  }
  /* The wells under the holes: dark shafts down to the water, drawn before the ice round them so the
   * field's packed ice is punched through where each hole is. */
  {
    const wellMat = new THREE.MeshBasicMaterial({ color: 0x07122a, side: THREE.BackSide, fog: false });
    const none = new THREE.MeshBasicMaterial({ visible: false });
    const wells = new THREE.InstancedMesh(new THREE.BoxGeometry(TILE, 1.3, TILE), [wellMat, wellMat, none, none, wellMat, wellMat], GRID * GRID);
    const m = new THREE.Matrix4();
    for (let hole = 0; hole < GRID * GRID; hole += 1) {
      const { x, z } = holeAt(hole);
      wells.setMatrixAt(hole, m.makeTranslation(x, -0.65, z));
    }
    scene.add(wells);
  }
  // The cleared field: packed ice between the holes, a ring of it round the field, cut out of the snow.
  const fieldMat = new THREE.MeshLambertMaterial({ map: tex('packed_ice'), color: 0xa9bde6 });
  {
    const bars = [];
    const span = FIELD;
    const gap = STEP - TILE;
    for (let i = 0; i <= GRID; i += 1) {
      const c = (i - GRID / 2) * STEP;
      const w = i === 0 || i === GRID ? 0.3 + gap / 2 : gap;
      bars.push([c + (i === 0 ? -0.15 : i === GRID ? 0.15 : 0), 0, w, span]);
      bars.push([0, c + (i === 0 ? -0.15 : i === GRID ? 0.15 : 0), span, w]);
    }
    const bar = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const mesh = new THREE.InstancedMesh(bar, fieldMat, bars.length);
    const m = new THREE.Matrix4();
    bars.forEach(([x, z, w, d], i) => mesh.setMatrixAt(i, m.compose(new THREE.Vector3(x, 0.002, z), new THREE.Quaternion(), new THREE.Vector3(w, 1, d))));
    scene.add(mesh);
  }
  /* The holes' clear ice: ice is see-through in the game, so the dark water and the fish show. */
  const iceMat = new THREE.MeshLambertMaterial({ map: tex('ice'), transparent: true, opacity: 0.5, depthWrite: false, color: 0xd6e8ff, emissive: 0x0a1630 });
  const tileGeo = new THREE.PlaneGeometry(TILE, TILE).rotateX(-Math.PI / 2);
  const tiles = new THREE.InstancedMesh(tileGeo, iceMat, GRID * GRID);
  {
    const m = new THREE.Matrix4();
    for (let hole = 0; hole < GRID * GRID; hole += 1) {
      const { x, z } = holeAt(hole);
      tiles.setMatrixAt(hole, m.makeTranslation(x, 0.004, z));
    }
  }
  tiles.renderOrder = 2;
  scene.add(tiles);
  /* The hover: the hole under the cursor, lit from below. */
  const hoverMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.6, 1.2, 1.5), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const hover = new THREE.Mesh(tileGeo, hoverMat);
  hover.renderOrder = 3;
  scene.add(hover);
  /* Each hole's state: closed, cracking, open with its catch, or broken through. */
  const crackTex = [0, 1, 2, 3].map((i) => frameTex(`frosted_ice_${i}`));
  const openGeo = new THREE.PlaneGeometry(TILE * 0.82, TILE * 0.82).rotateX(-Math.PI / 2);
  const holes = Array.from({ length: GRID * GRID }, (_, hole) => {
    const { x, z } = holeAt(hole);
    const crack = new THREE.Mesh(tileGeo, new THREE.MeshBasicMaterial({ map: crackTex[0], transparent: true, opacity: 0, depthWrite: false, color: 0xe8f4ff }));
    crack.position.set(x, 0.008, z);
    crack.renderOrder = 4;
    crack.visible = false;
    scene.add(crack);
    const open = new THREE.Mesh(openGeo, new THREE.MeshBasicMaterial({ map: waterTex, color: 0x2a5fb8, fog: false }));
    open.position.set(x, 0.006, z);
    open.visible = false;
    open.renderOrder = 4;
    scene.add(open);
    return { hole, x, z, crack, open, state: 'closed', item: null, born: 0 };
  });

  /* ── the shore: snowy banks and spruces with snow on them ── */
  {
    const rand = seeded(19);
    const box = new THREE.BoxGeometry(1, 1, 1);
    const ground = [];
    const logs = [];
    const leaves = [];
    const caps = [];
    for (let x = -LAKE / 2; x < LAKE / 2; x += 1) {
      for (let z = -LAKE / 2; z < LAKE / 2; z += 1) {
        const d = Math.hypot(x + 0.5, (z + 0.5) * 1.1);
        const shore = 15 + Math.sin(Math.atan2(z, x) * 5) * 1.5 + rand() * 1.2;
        if (d < shore) continue;
        const h = Math.min(4, Math.floor((d - shore) / 2.2) + 1);
        for (let y = 0; y < h; y += 1) ground.push([x + 0.5, y + 0.5, z + 0.5]);
        if (d > shore + 2 && rand() < 0.06 * (tier.name === 'low' ? 0.6 : 1) && z < 6) {
          const tall = 5 + Math.floor(rand() * 4);
          for (let y = h; y < h + tall; y += 1) logs.push([x + 0.5, y + 0.5, z + 0.5]);
          for (let y = h + 2; y <= h + tall; y += 1) {
            const rr = Math.max(0, Math.round((h + tall - y) * 0.45 + (y % 2) * 0.6));
            for (let dx = -rr; dx <= rr; dx += 1) {
              for (let dz = -rr; dz <= rr; dz += 1) {
                if ((dx || dz) && Math.abs(dx) + Math.abs(dz) <= rr + 0.5) leaves.push([x + dx + 0.5, y + 0.5, z + dz + 0.5]);
                if (Math.abs(dx) + Math.abs(dz) <= rr && (y === h + tall || (y % 2 === 0 && Math.abs(dx) + Math.abs(dz) === rr))) caps.push([x + dx + 0.5, y + 1.06, z + dz + 0.5]);
              }
            }
          }
          leaves.push([x + 0.5, h + tall + 0.5, z + 0.5]);
        }
      }
    }
    const lambert = (map, opts = {}) => new THREE.MeshLambertMaterial({ map, ...opts });
    const snowSide = lambert(tex('grass_block_snow'));
    const snowMat = lambert(tex('snow'));
    const logSide = lambert(tex('spruce_log'));
    const logTop = lambert(tex('spruce_log_top'));
    const put = (list, geometry, material) => {
      if (!list.length) return;
      const mesh = new THREE.InstancedMesh(geometry, material, list.length);
      const m = new THREE.Matrix4();
      list.forEach(([x, y, z], i) => mesh.setMatrixAt(i, m.makeTranslation(x, y, z)));
      scene.add(mesh);
    };
    put(ground, box, [snowSide, snowSide, snowMat, snowMat, snowSide, snowSide]);
    put(logs, box, [logSide, logSide, logTop, logTop, logSide, logSide]);
    // FoliageColor's spruce, 0x619961, as the game tints spruce needles.
    put(leaves, box, lambert(tex('spruce_leaves'), { color: 0x619961, alphaTest: 0.5 }));
    put(caps, new THREE.BoxGeometry(1, 2 / 16, 1), snowMat);
  }

  /* ── lanterns on spruce posts at the field's corners, and a campfire ── */
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
    const post = [new THREE.MeshLambertMaterial({ map: tex('spruce_log') }), new THREE.MeshLambertMaterial({ map: tex('spruce_log_top') })];
    const corner = (STEP * GRID) / 2 + 0.9;
    let lights = 0;
    for (const [x, z] of [[-corner, -corner], [corner, -corner], [-corner, corner], [corner, corner]]) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1.6, 0.4), [post[0], post[0], post[1], post[1], post[0], post[0]]);
      p.position.set(x, 0.8, z);
      scene.add(p);
      const lantern = new THREE.Mesh(new THREE.BoxGeometry(6 * PX * 1.4, 7 * PX * 1.4, 6 * PX * 1.4), [glow, glow, cap, cap, glow, glow]);
      lantern.position.set(x, 1.78, z);
      scene.add(lantern);
      if (lights < Math.min(2, tier.lights)) {
        // Two warm lights across the field are the most a machine pays for; the other lanterns glow.
        const light = new THREE.PointLight(0xffb060, 3.2, 9, 1.6);
        light.position.set(x, 1.9, z);
        scene.add(light);
        lights += 1;
      }
    }
  }
  const campfire = { at: new THREE.Vector3(7.8, 0, 2.8), frame: -1 };
  {
    const logMat = new THREE.MeshLambertMaterial({ map: tex('campfire_log_lit') });
    for (const [dx, dz, rot] of [[0, -0.2, 0], [0, 0.2, 0], [-0.2, 0, Math.PI / 2], [0.2, 0, Math.PI / 2]]) {
      const log = new THREE.Mesh(new THREE.BoxGeometry(1, 0.25, 0.25), logMat);
      log.position.set(campfire.at.x + dx, 0.15 + (rot ? 0.2 : 0), campfire.at.z + dz);
      log.rotation.y = rot;
      scene.add(log);
    }
    campfire.frames = Math.max(1, Math.floor(img.campfire_fire.naturalHeight / 16));
    campfire.tex = frameTex('campfire_fire');
    const fireMat = new THREE.MeshBasicMaterial({ map: campfire.tex, transparent: true, alphaTest: 0.1, side: THREE.DoubleSide, toneMapped: false, color: new THREE.Color(1.6, 1.4, 1.2) });
    for (const r of [Math.PI / 4, -Math.PI / 4]) {
      const fire = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), fireMat);
      fire.position.set(campfire.at.x, 0.75, campfire.at.z);
      fire.rotation.y = r;
      scene.add(fire);
    }
    campfire.light = new THREE.PointLight(0xff8a3a, 7, 11, 1.4);
    campfire.light.position.set(campfire.at.x, 1.4, campfire.at.z);
    scene.add(campfire.light);
  }

  /* ── Steve at the field's edge with his rod ── */
  const player = buildModel(THREE, [{ material: new THREE.MeshLambertMaterial({ map: pixelTexture(THREE, ent.steve), alphaTest: 0.5, side: THREE.DoubleSide }), def: PLAYER }]);
  const steve = placeEntity(THREE, player, PLAYER_PIXEL);
  const P = player.parts;
  steve.position.set(STEVE_AT.x, 0, STEVE_AT.z);
  steve.rotation.y = Math.PI / 2 + 0.2;
  scene.add(steve);
  {
    const mount = new THREE.Group();
    mount.position.set(-1, 9.5, -0.5);
    mount.rotation.x = 0.35;
    P.rightArm.add(mount);
    const basis = new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, -1, 0), new THREE.Vector3(-1, 0, 0));
    const rod = new THREE.Group();
    rod.quaternion.setFromRotationMatrix(basis);
    rod.scale.setScalar(16 * 0.85);
    rod.position.copy(new THREE.Vector3(3.5 / 16 - 0.5, 0.5 - 12.5 / 16, 0).applyMatrix4(basis).multiplyScalar(-16 * 0.85));
    mount.add(rod);
    const { geometry, material } = itemModel(THREE, rodImg);
    rod.add(new THREE.Mesh(geometry, material));
  }

  /* ── the catches, extruded, the rare ones glinting ── */
  const glintTex = new THREE.CanvasTexture(glintImg);
  glintTex.wrapS = glintTex.wrapT = THREE.RepeatWrapping;
  glintTex.colorSpace = THREE.SRGBColorSpace;
  glintTex.repeat.set(0.25, 0.25);
  const itemParts = new Map();
  catches.forEach((id, i) => {
    const source = catchImgs[i];
    if (!source) return;
    const { geometry, material } = itemModel(THREE, source);
    // Lit as a held item is, whatever the night does: the catch should read from across the lake.
    material.emissive.setHex(0x5a5a5a);
    let glint = null;
    if (GLINTS.has(id)) {
      const c = document.createElement('canvas');
      c.width = c.height = 16;
      const g = c.getContext('2d');
      g.drawImage(source, 0, 0, 16, 16);
      g.globalCompositeOperation = 'source-in';
      g.fillStyle = '#fff';
      g.fillRect(0, 0, 16, 16);
      glint = new THREE.MeshBasicMaterial({ map: glintTex, alphaMap: pixelTexture(THREE, c), transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, depthFunc: THREE.LessEqualDepth });
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

  /* ── particles ── */
  const sprites = [];
  const sprite = (map, opts) => {
    const s = makeSprites(THREE, { map, ...opts });
    scene.add(s.points);
    sprites.push(s);
    return s;
  };
  const splashes = sprite(atlas(THREE, [0, 1, 2, 3].map((i) => part[`splash_${i}`]), 8, 4).map, { cols: 4, rows: 1, count: scale(260) });
  // Breaking particles are the block's own texture, cut small, as the game breaks ice.
  const chips = sprite(pixelTexture(THREE, img.ice), { cols: 4, rows: 4, count: scale(220) });
  const sparkles = sprite(pixelTexture(THREE, part.glint), { count: scale(140) });
  const smoke = sprite(atlas(THREE, ['big_smoke_0', 'big_smoke_4', 'big_smoke_8', 'big_smoke_11'].map((n) => part[n]), 8, 4).map, { cols: 4, rows: 1, count: scale(40) });
  const sparks = sprite(atlas(THREE, [0, 1, 2, 3, 4, 5, 6, 7].map((i) => part[`spark_${i}`]), 8, 8).map, { cols: 8, rows: 1, count: scale(500), additive: true });
  const orbs = sprite(pixelTexture(THREE, ent.experience_orb), { cols: 4, rows: 4, count: scale(100), additive: true });
  function splash(x, z, n, up = 2.4) {
    if (reduce) return;
    for (let i = 0; i < scale(n); i += 1) {
      const a = Math.random() * Math.PI * 2;
      splashes.emit({ x: x + Math.cos(a) * 0.2, y: 0.05, z: z + Math.sin(a) * 0.2, vx: Math.cos(a) * (0.4 + Math.random()), vy: up * (0.6 + Math.random() * 0.8), vz: Math.sin(a) * (0.4 + Math.random()), gravity: -9, drag: 0.4, life: 0.5 + Math.random() * 0.4, size: 0.18, frame: Math.floor(Math.random() * 4), fade: 0.3 });
    }
  }
  function chip(x, z, n, spread = 1.2, up = 1.8) {
    if (reduce) return;
    for (let i = 0; i < scale(n); i += 1) {
      const a = Math.random() * Math.PI * 2;
      chips.emit({ x: x + (Math.random() - 0.5) * spread, y: 0.08, z: z + (Math.random() - 0.5) * spread, vx: Math.cos(a) * (0.5 + Math.random()), vy: up * (0.8 + Math.random()), vz: Math.sin(a) * (0.5 + Math.random()), gravity: -10, drag: 0.2, life: 0.6 + Math.random() * 0.4, size: 0.12, frame: Math.floor(Math.random() * 16), fade: 0.2 });
    }
  }
  function twinkle(at, n, spread = 0.6) {
    if (reduce) return;
    for (let i = 0; i < scale(n); i += 1) {
      sparkles.emit({ x: at.x + (Math.random() - 0.5) * spread, y: at.y + (Math.random() - 0.5) * spread, z: at.z + (Math.random() - 0.5) * spread, vx: (Math.random() - 0.5) * 0.3, vy: 0.3 + Math.random() * 0.5, vz: (Math.random() - 0.5) * 0.3, drag: 0.6, life: 0.8 + Math.random() * 0.6, size: 0.14, sizeTo: 0.05, fade: 0.4 });
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
      sparks.emit({ x, y, z, vx: Math.cos(a) * rr * speed, vy: u * speed, vz: Math.sin(a) * rr * speed, gravity: -2.5, drag: 1.6, life: 1.3 + Math.random() * 0.7, size: 0.45, frame: 7, frameTo: 0, r: r * 1.6, g: g * 1.6, b: b * 1.6, twinkle: true, fade: 0.45 });
    }
  }
  function orbsFrom(from, n) {
    if (reduce) return;
    const to = new THREE.Vector3(STEVE_AT.x, 1.4, STEVE_AT.z);
    for (let i = 0; i < scale(n); i += 1) {
      const t = 0.8 + Math.random() * 0.4;
      const gravity = -5;
      const sx = from.x + (Math.random() - 0.5) * 3;
      const sz = from.z + (Math.random() - 0.5) * 3;
      orbs.emit({ x: sx, y: from.y, z: sz, vx: (to.x - sx) / t, vy: (to.y - from.y) / t - 0.5 * gravity * t, vz: (to.z - sz) / t, gravity, life: t, size: 0.14, frame: Math.floor(Math.random() * 7), r: 0.8, g: 1, b: 0.2, fade: 0.15 });
    }
  }

  /* ── the weather: snow in the game's sheets round the camera ── */
  const snowTex = pixelTexture(THREE, snowImg);
  snowTex.wrapS = snowTex.wrapT = THREE.RepeatWrapping;
  const snowSheets = [];
  for (const [radius, repeat, speed] of tier.name === 'low' ? [[8, 7, 0.12]] : [[6, 6, 0.15], [11, 10, 0.1]]) {
    const t = snowTex.clone();
    t.needsUpdate = true;
    t.repeat.set(repeat, 2);
    const sheet = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 26, 20, 1, true), new THREE.MeshBasicMaterial({ map: t, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide, color: 0xdde8ff }));
    sheet.renderOrder = 6;
    scene.add(sheet);
    snowSheets.push({ sheet, tex: t, speed });
  }

  /* ─────────── the holes, in play ─────────── */

  const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, reduce ? 0 : ms); });
  const npc = { cheerUntil: 0, sulkUntil: 0, hopStart: 0, hopUntil: 0 };
  let shake = 0;
  let active = false;
  let hovered = -1;
  let busyAnim = 0;
  const fireworksDue = [];
  async function crackOpen(h, frames = 4, ms = 110) {
    h.crack.visible = true;
    h.crack.material.opacity = 1;
    for (let f = 0; f < frames; f += 1) {
      h.crack.material.map = crackTex[f];
      h.crack.material.needsUpdate = true;
      chip(h.x, h.z, 3, 0.9, 1.2);
      controls.onCue?.('crack', f);
      await wait(ms);
    }
  }
  function openWith(h, catchId, now = performance.now()) {
    h.state = 'fish';
    h.crack.visible = false;
    h.open.visible = true;
    h.open.material.color.set(0x2a5fb8);
    if (catchId) {
      h.item = itemMesh(catchId);
      h.item.position.set(h.x, 0.1, h.z);
      h.item.scale.setScalar(0.3);
      h.born = now;
      if (GLINTS.has(catchId)) twinkle(new THREE.Vector3(h.x, 1.1, h.z), 14);
    }
  }
  function breakThrough(h, live) {
    h.state = 'thin';
    h.open.visible = true;
    h.open.material.color.set(live ? 0x0c2650 : 0x14305e);
    h.crack.visible = true;
    h.crack.material.map = crackTex[3];
    h.crack.material.opacity = live ? 0.9 : 0.55;
    h.crack.material.color.set(live ? 0xffb0b0 : 0xd0dcff);
    h.crack.material.needsUpdate = true;
  }

  /* ─────────── the camera: over the field, a little to the front ─────────── */

  const cam = { pos: new THREE.Vector3(), look: new THREE.Vector3() };
  const goalPos = new THREE.Vector3();
  const goalLook = new THREE.Vector3(0, -0.4, 0.2);
  function frameShot(clock) {
    const sway = reduce ? 0 : Math.sin(clock * 0.1) * 0.6;
    goalPos.set(sway, 7.4, 11.4);
  }

  /* ── picking a hole with the pointer ── */
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  function holeUnder(event) {
    const b = canvas.getBoundingClientRect();
    if (!b.width) return -1;
    ndc.set(((event.clientX - b.left) / b.width) * 2 - 1, -((event.clientY - b.top) / b.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObject(tiles, false)[0];
    return hit && hit.instanceId !== undefined ? hit.instanceId : -1;
  }
  const pickable = (hole) => active && hole >= 0 && holes[hole].state === 'closed';
  let lastMove = 0;
  const onMove = (event) => {
    const now = performance.now();
    if (now - lastMove < 40) return; // a pick ray twenty-five times a second is plenty
    lastMove = now;
    const hole = holeUnder(event);
    hovered = pickable(hole) ? hole : -1;
    canvas.style.cursor = hovered >= 0 ? 'pointer' : '';
  };
  const onLeave = () => { hovered = -1; };
  const onClick = (event) => {
    const hole = holeUnder(event);
    if (pickable(hole)) controls.onPick?.(hole);
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
    () => { for (const s of snowSheets) s.sheet.visible = false; aurora.visible = false; },
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
    camera.fov = Math.max(46, THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(25)) / camera.aspect)));
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
    const resized = resize();
    aurora.material.uniforms.uTime.value = reduce ? 0 : clock;
    frameShot(clock);
    const k = reduce ? 1 : 1 - Math.exp(-dt * 2.4);
    cam.pos.lerp(goalPos, k);
    cam.look.lerp(goalLook, k);
    camera.position.copy(cam.pos);
    if (shake > 0.01 && !reduce) {
      camera.position.x += (Math.random() - 0.5) * shake * 0.14;
      camera.position.y += (Math.random() - 0.5) * shake * 0.14;
    }
    shake *= Math.exp(-dt * 3.5);
    camera.lookAt(cam.look);
    placeSky(camera.position);
    for (const s of snowSheets) {
      s.sheet.position.copy(camera.position);
      if (!reduce) s.tex.offset.y += dt * s.speed;
    }
    // The fish under the ice, circling slowly; seen only where the ice is clear.
    for (const f of fish) {
      const a = clock * f.speed + f.phase;
      f.entity.position.set(Math.cos(a) * f.r, f.y + Math.sin(clock + f.phase) * 0.05, Math.sin(a) * f.r * 0.9);
      f.entity.rotation.y = -a;
      if (f.kind === 'cod') poseCod(f.model.parts, clock * 18 + f.phase);
      else poseSalmon(f.model.parts, clock * 18 + f.phase);
    }
    if (!reduce) waterTex.offset.set(clock * 0.01, clock * 0.006);
    // The hovered hole glows from beneath.
    if (hovered >= 0) {
      const { x, z } = holeAt(hovered);
      hover.position.set(x, 0.01, z);
      hoverMat.opacity = 0.18 + (reduce ? 0 : Math.sin(clock * 6) * 0.06);
    } else {
      hoverMat.opacity = 0;
    }
    // What came up hangs over its hole, turning.
    let rising = false;
    for (const h of holes) {
      if (!h.item) continue;
      const age = (now - h.born) / 1000;
      const up = reduce ? 1 : easeOut(clamp01(age / 0.55));
      if (up < 1) rising = true;
      // Turned to the camera, as a dropped item would be seen: the sprite, not its edge.
      h.item.position.y = lerp(0.1, 0.9, up) + (reduce ? 0 : Math.sin(age * 2.2 + h.hole) * 0.05);
      h.item.scale.setScalar(lerp(0.3, 0.95, up));
      h.item.quaternion.copy(camera.quaternion);
      if (!reduce) h.item.rotateY(Math.sin(age * 1.6 + h.hole) * 0.35);
    }
    // The campfire flickers through its frames, and smokes.
    const fireFrame = reduce ? 0 : Math.floor(clock * 8) % campfire.frames;
    if (fireFrame !== campfire.frame) {
      campfire.frame = fireFrame;
      const g = campfire.tex.image.getContext('2d');
      g.clearRect(0, 0, 16, 16);
      g.drawImage(img.campfire_fire, 0, fireFrame * 16, 16, 16, 0, 0, 16, 16);
      campfire.tex.needsUpdate = true;
    }
    campfire.light.intensity = 6.5 + (reduce ? 0 : Math.sin(clock * 13) * 0.8);
    if (!reduce && Math.random() < dt * 3) {
      smoke.emit({ x: campfire.at.x, y: 1, z: campfire.at.z, vx: 0.15, vy: 1.1, life: 4, size: 0.9, sizeTo: 1.6, frame: 0, frameTo: 3, a: 0.5, r: 0.6, g: 0.6, b: 0.65, fadeIn: 0.1, fade: 0.6 });
    }
    // Steve: a cheer, a hop, or a shake of the head.
    {
      const cheering = now < npc.cheerUntil && !reduce;
      P.leftArm.rotation.x = cheering ? -2.7 + Math.sin(clock * 14) * 0.35 : 0;
      P.rightArm.rotation.x = -0.6 + (reduce ? 0 : Math.sin(clock * 1.3) * 0.04);
      const sulking = now < npc.sulkUntil;
      P.head.rotation.x = sulking ? 0.6 : 0.35;
      P.head.rotation.y = sulking && !reduce ? Math.sin(clock * 12) * 0.25 : 0;
      steve.position.y = now < npc.hopUntil && !reduce ? Math.abs(Math.sin(((now - npc.hopStart) / 1000) * Math.PI * 2.4)) * 0.35 : 0;
    }
    if (!reduce) glintTex.offset.set(-((now * 8) % 110000) / 110000, ((now * 8) % 30000) / 30000);
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
  frameShot(0);
  cam.pos.copy(goalPos);
  cam.look.copy(goalLook);
  try { renderer.compile(scene, camera); } catch { /* compiled on first use */ }
  raf = requestAnimationFrame(frame);

  const controls = {
    onLost: null,
    /** Called with a hole the player clicked on the lake. */
    onPick: null,
    /** 'crack' (with the frame), 'catch', 'thin', 'firework'. */
    onCue: null,
    tier: tier.name,

    /** Whether holes can be picked on the lake. */
    setActive(on) {
      active = on;
      if (!on) hovered = -1;
    },
    /** Puts the lake back as a game the server describes: the holes drilled and what they held. */
    setBoard(drilled, catchesOf) {
      controls.reset();
      drilled.forEach((hole, i) => openWith(holes[hole], catchesOf[i], performance.now() - 2000));
    },
    /** Drills `hole`; `catchId` is the fish it held, or null for thin ice. Resolves when it is done. */
    async drill(hole, catchId) {
      const h = holes[hole];
      busyAnim += 1;
      hovered = -1;
      try {
        if (catchId) {
          await crackOpen(h);
          openWith(h, catchId);
          splash(h.x, h.z, 14);
          chip(h.x, h.z, 10, 1.2, 2.2);
          controls.onCue?.('catch');
          npc.hopStart = performance.now();
          npc.hopUntil = npc.hopStart + 500;
        } else {
          // Thin ice: it gives under the drill, the cracks run, the water comes up.
          await crackOpen(h, 4, 60);
          breakThrough(h, true);
          shake = 1;
          splash(h.x, h.z, 40, 3.4);
          chip(h.x, h.z, 40, 2.4, 3);
          controls.onCue?.('thin');
          npc.sulkUntil = performance.now() + 1600;
        }
        await wait(260);
      } finally {
        busyAnim -= 1;
      }
    },
    /** The game is over: the rest of the thin ice shows itself. */
    reveal(thinHoles, thinHit) {
      for (const hole of thinHoles) if (hole !== thinHit && holes[hole].state === 'closed') breakThrough(holes[hole], false);
    },
    /** How glad Steve is about pulling out at `bps`. */
    celebrate(bps) {
      const x = bps / 10_000;
      const now = performance.now();
      orbsFrom(new THREE.Vector3(0, 1, 0), Math.min(14, 2 + Math.round(Math.log2(Math.max(1, x)) * 3)));
      if (x >= 2) {
        npc.hopStart = now;
        npc.hopUntil = now + (x >= 10 ? 2400 : 900);
      }
      if (x >= 5) {
        const count = x >= 25 ? 5 : x >= 10 ? 3 : 1;
        for (let i = 0; i < count; i += 1) fireworksDue.push({ at: now + 250 + i * 380 + Math.random() * 200, x: (Math.random() - 0.5) * 14, y: 7 + Math.random() * 4, z: -6 - Math.random() * 5 });
      }
      if (x >= 10) {
        npc.cheerUntil = now + 2400;
        shake = 0.5;
      }
    },
    /** A fresh lake: every hole frozen over again. */
    reset() {
      for (const h of holes) {
        if (h.item) scene.remove(h.item);
        h.item = null;
        h.state = 'closed';
        h.open.visible = false;
        h.crack.visible = false;
        h.crack.material.color.set(0xe8f4ff);
      }
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
