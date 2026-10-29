/* coin3d.js — Coinflip in 3D: a smithy, an anvil, and the coin tossed off it.
 *
 * The coin is a weighted pressure plate struck on both faces: gold on one (Heads, a gold ingot laid
 * on it) and iron on the other (Tails, an iron ingot). It goes up off the anvil turning end over
 * end, comes down on the face the server already chose, and rings on the anvil.
 *
 * Every block, item and particle is the game's own, out of the client jar: the anvil on its block
 * model (template_anvil), gold and iron blocks, the ingots as items, the smithing table and blast
 * furnace, stone bricks and spruce planks, lanterns on chains. What is drawn rather than taken is
 * light: the lanterns' glow, and the shine of the face that came up.
 *
 * Nothing here decides anything; coinflip.js shows a game that is already settled. It lives in the
 * flip's dialog and puts itself away when the dialog closes. If WebGL is missing, coinflip.js spins
 * the flat coin instead.
 */
import { reduceMotion } from './util.js';
import { getTHREE, loadImage, softDot } from './mc3d.js';
import { itemModel, makeSprites, pixelTexture } from './mcmodels.js';
import { glowPoints, gradePass, ironChain } from './scenery3d.js';
import { BRIGHTNESS, chooseTier, frameMs, ratioFor } from './quality3d.js';

const TOSS_MS = 1700;        // up and down again
const SETTLE_MS = 500;       // the bounce and the ring, to 2.2 s: the flat coin's length
const TURNS = 5;
const THICK = 1.5 / 16;
const ANVIL_TOP = 1;

const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
const easeOut = (t) => 1 - (1 - t) ** 3;

/**
 * Points a box's faces (three's order: +x, -x, +y, -y, +z, -z) at regions of a 16-pixel texture,
 * as a block model's element faces do: [u0, v0, u1, v1, rotation].
 */
function modelUV(geometry, faces) {
  const uv = geometry.attributes.uv;
  for (let f = 0; f < 6; f += 1) {
    const face = faces[f];
    if (!face) continue;
    const [u0, v0, u1, v1, rot = 0] = face;
    const a = (-rot * Math.PI) / 180;
    for (let k = 0; k < 4; k += 1) {
      const i = f * 4 + k;
      const x = uv.getX(i) - 0.5;
      const y = uv.getY(i) - 0.5;
      const uu = x * Math.cos(a) - y * Math.sin(a) + 0.5;
      const vv = x * Math.sin(a) + y * Math.cos(a) + 0.5;
      uv.setXY(i, (u0 + uu * (u1 - u0)) / 16, 1 - (v0 + (1 - vv) * (v1 - v0)) / 16);
    }
  }
  uv.needsUpdate = true;
  return geometry;
}

/**
 * Builds the smithy into `host` and resolves with its controls, or null when this browser cannot
 * draw it.
 */
export async function createCoin3d(host) {
  const THREE = await getTHREE();
  const probe = document.createElement('canvas');
  const probeGl = probe.getContext('webgl2');
  if (!probeGl) return null;
  const tier = chooseTier(probeGl);
  probeGl.getExtension('WEBGL_lose_context')?.loseContext();
  const canvas = document.createElement('canvas');
  canvas.className = 'cfcoin__gl';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.dataset.tier = tier.name;
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: tier.antialias, alpha: false, powerPreference: 'high-performance' });
  } catch {
    return null;
  }
  const ratio = ratioFor(tier);
  renderer.setPixelRatio(ratio);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2 * BRIGHTNESS;
  const FRAME_MS = frameMs(tier);
  let nextFrameAt = 0;

  const BLOCKS = ['anvil', 'anvil_top', 'gold_block', 'iron_block', 'stone_bricks', 'spruce_planks', 'smithing_table_front',
    'smithing_table_side', 'smithing_table_top', 'smithing_table_bottom', 'blast_furnace_front', 'blast_furnace_side', 'blast_furnace_top', 'lantern', 'iron_chain'];
  let loaded;
  try {
    loaded = await Promise.all([
      Promise.all(BLOCKS.map((name) => loadImage(`assets/img/block/${name}.png`))),
      loadImage('assets/img/items/gold_ingot.png'),
      loadImage('assets/img/items/iron_ingot.png'),
      loadImage('assets/img/particle/glint.png'),
      tier.composer
        ? import(/* @vite-ignore */ new URL('assets/vendor/three-addons.js', document.baseURI).href).catch(() => null)
        : Promise.resolve(null),
    ]);
  } catch {
    renderer.dispose();
    return null;
  }
  const [blockImgs, goldImg, ironImg, glintImg, addons] = loaded;
  if (!host.isConnected) {
    renderer.dispose();
    return null;
  }
  const img = Object.fromEntries(BLOCKS.map((name, i) => [name, blockImgs[i]]));
  host.prepend(canvas);

  const reduce = reduceMotion();
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0c0a09);
  scene.fog = new THREE.Fog(0x0c0a09, 5, 11);
  const camera = new THREE.PerspectiveCamera(38, 1, 0.05, 50);

  let composer = null;
  if (addons) {
    try {
      const target = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: tier.samples });
      composer = new addons.EffectComposer(renderer, target);
      composer.addPass(new addons.RenderPass(scene, camera));
      composer.addPass(new addons.UnrealBloomPass(new THREE.Vector2(4, 4), 0.5, 0.45, 0.85));
      composer.addPass(new addons.OutputPass());
      composer.addPass(gradePass(THREE, addons, { contrast: 1.07, saturation: 1.1, lift: [0.02, 0.01, 0.0], gain: [1.05, 1.0, 0.93], vignette: 0.35 }));
    } catch {
      composer = null;
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

  /* ── light: lanterns, and the forge's glow from the side ── */
  scene.add(new THREE.HemisphereLight(0x8a90a8, 0x2a1c12, 0.7));
  const key = new THREE.PointLight(0xffc98a, 9, 8, 1.3);
  key.position.set(0.9, 2.6, 1.4);
  scene.add(key);
  const forge = new THREE.PointLight(0xff7a2a, 4, 5, 1.5);
  forge.position.set(1.6, 0.9, -0.6);
  scene.add(forge);
  const fill = new THREE.DirectionalLight(0xbfc8e0, 0.6);
  fill.position.set(-2, 3, 4);
  scene.add(fill);

  /* ── the smithy: a planked floor, stone-brick walls, the smithing table and the blast furnace ── */
  {
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(10, 10).rotateX(-Math.PI / 2), lambert(tex('spruce_planks', 10, 10)));
    scene.add(floor);
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(10, 5), lambert(tex('stone_bricks', 10, 5)));
    wall.position.set(0, 2.5, -2.5);
    scene.add(wall);
    const sides = (side, top, bottom, front) => [lambert(tex(side)), lambert(tex(side)), lambert(tex(top)), lambert(tex(bottom)), lambert(tex(front)), lambert(tex(side))];
    const table = new THREE.Mesh(box, sides('smithing_table_side', 'smithing_table_top', 'smithing_table_bottom', 'smithing_table_front'));
    table.position.set(-1.8, 0.5, -1.5);
    const furnace = new THREE.Mesh(box, sides('blast_furnace_side', 'blast_furnace_top', 'blast_furnace_top', 'blast_furnace_front'));
    furnace.position.set(1.9, 0.5, -1.6);
    furnace.rotation.y = -0.35;
    scene.add(table, furnace);
  }
  // Lanterns on chains from the beams.
  const lanterns = [];
  {
    const lanternMat = lambert(tex('lantern'), { alphaTest: 0.5, emissive: 0x5a3a10 });
    const body = modelUV(new THREE.BoxGeometry(6 / 16, 7 / 16, 6 / 16), [[0, 2, 6, 9], [0, 2, 6, 9], [0, 9, 6, 15], [0, 9, 6, 15], [0, 2, 6, 9], [0, 2, 6, 9]]);
    for (const [x, z] of [[-1.3, -0.9], [1.25, -1.1]]) {
      const chain = ironChain(THREE, img.iron_chain, 1.6);
      chain.position.set(x, 4.4, z);
      const lantern = new THREE.Mesh(body, lanternMat);
      lantern.position.set(x, 4.4 - 1.6 - 3.5 / 16, z);
      scene.add(chain, lantern);
      lanterns.push(lantern.position.clone());
    }
  }
  const halos = glowPoints(THREE, [...lanterns.map((p) => [p.x, p.y, p.z]), [1.75, 0.6, -1.2]], { size: 1.3, color: 0xffb060, opacity: 0.5 });
  scene.add(halos.points);

  /* ── the anvil: template_anvil's four elements ── */
  {
    const body = lambert(tex('anvil'));
    const top = lambert(tex('anvil_top'));
    const anvil = new THREE.Group();
    const part = (from, to, faces, mats = body) => {
      const [x0, y0, z0] = from;
      const [x1, y1, z1] = to;
      const geo = modelUV(new THREE.BoxGeometry((x1 - x0) / 16, (y1 - y0) / 16, (z1 - z0) / 16), faces);
      const mesh = new THREE.Mesh(geo, mats);
      mesh.position.set((x0 + x1) / 32 - 0.5, (y0 + y1) / 32, (z0 + z1) / 32 - 0.5);
      anvil.add(mesh);
    };
    // east, west, up, down, south, north
    part([2, 0, 2], [14, 4, 14], [[4, 2, 0, 14, 270], [0, 2, 4, 14, 90], [2, 2, 14, 14, 180], [2, 2, 14, 14, 180], [2, 12, 14, 16], [2, 12, 14, 16]]);
    part([4, 4, 3], [12, 5, 13], [[5, 3, 4, 13, 270], [4, 3, 5, 13, 90], [4, 3, 12, 13, 180], null, [4, 11, 12, 12], [4, 11, 12, 12]]);
    part([6, 5, 4], [10, 10, 12], [[10, 4, 5, 12, 270], [5, 4, 10, 12, 90], null, null, [6, 6, 10, 11], [6, 6, 10, 11]]);
    part([3, 10, 0], [13, 16, 16], [[16, 0, 10, 16, 270], [10, 0, 16, 16, 90], [3, 0, 13, 16, 180], [3, 0, 13, 16, 180], [3, 0, 13, 6], [3, 0, 13, 6]],
      [body, body, top, body, body, body]);
    anvil.rotation.y = Math.PI / 2;
    scene.add(anvil);
  }

  /* ── the coin: gold on one face with a gold ingot on it, iron on the other with an iron ingot ── */
  const coin = new THREE.Group();
  {
    const gold = lambert(tex('gold_block'));
    const iron = lambert(tex('iron_block'));
    const plate = new THREE.Mesh(modelUV(new THREE.BoxGeometry(14 / 16, THICK, 14 / 16), [[1, 0, 15, 1.5], [1, 0, 15, 1.5], [1, 1, 15, 15], [1, 1, 15, 15], [1, 0, 15, 1.5], [1, 0, 15, 1.5]]),
      [gold, gold, gold, iron, gold, gold]);
    coin.add(plate);
    for (const [image, up] of [[goldImg, 1], [ironImg, -1]]) {
      const model = itemModel(THREE, image);
      const ingot = new THREE.Mesh(model.geometry, model.material);
      ingot.scale.setScalar(0.66);
      ingot.rotation.x = -up * Math.PI / 2;
      ingot.position.y = up * (THICK / 2 + 0.025);
      coin.add(ingot);
    }
  }
  const restY = ANVIL_TOP + THICK / 2;
  coin.position.set(0, restY, 0);
  scene.add(coin);
  const shine = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.6), new THREE.MeshBasicMaterial({ map: softDot('rgba(255,255,255,1)'), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
  scene.add(shine);
  const sparkles = makeSprites(THREE, { map: pixelTexture(THREE, glintImg), count: 80, additive: true });
  scene.add(sparkles.points);

  /* ── framing ── */
  let lastW = 0;
  let lastH = 0;
  function resize() {
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (!w || !h || (w === lastW && h === lastH)) return;
    lastW = w;
    lastH = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    composer?.setPixelRatio(ratio);
    composer?.setSize(w, h);
    sparkles.setScale((h * ratio * camera.projectionMatrix.elements[5]) / 2);
  }
  camera.position.set(0.2, 2.3, 3.9);
  camera.lookAt(0, 1.45, 0);

  /* ── the toss ── */
  let toss = null;   // { at, total, result, resolve, rang }
  let landedAt = -1e9;
  let disposed = false;
  let raf = 0;
  let last = performance.now();
  let clock = 0;
  function frame() {
    raf = requestAnimationFrame(frame);
    if (!host.isConnected) {
      controls.dispose();
      return;
    }
    const now = performance.now();
    // The dialog closed (it keeps its contents until the next one opens): nothing to draw. A toss
    // still in the air lands at once, so the page hears the result it is waiting for.
    if (host.offsetParent === null || document.visibilityState !== 'visible') {
      if (toss && now - toss.at > TOSS_MS + SETTLE_MS) {
        const done = toss;
        toss = null;
        done.resolve();
      }
      last = now;
      return;
    }
    if (FRAME_MS) {
      if (now < nextFrameAt - 2) return;
      nextFrameAt = now - nextFrameAt > FRAME_MS ? now + FRAME_MS : nextFrameAt + FRAME_MS;
    }
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    clock += dt;
    resize();
    if (toss) {
      const e = now - toss.at;
      const t = clamp01(e / TOSS_MS);
      // Up and down on one arc, turning end over end, fast off the anvil and slowing to land.
      coin.position.y = restY + 4 * 0.95 * t * (1 - t);
      coin.rotation.x = toss.total * easeOut(t);
      coin.rotation.y = 0.35 * Math.sin(t * Math.PI);
      if (e >= TOSS_MS) {
        const s = clamp01((e - TOSS_MS) / SETTLE_MS);
        coin.position.y = restY + Math.abs(Math.sin(s * Math.PI * 2)) * 0.06 * (1 - s);
        coin.rotation.x = toss.total;
        coin.rotation.z = Math.sin(s * Math.PI * 6) * 0.05 * (1 - s);
        if (!toss.rang) {
          toss.rang = true;
          landedAt = now;
          controls.onCue?.('land');
          for (let i = 0; i < 24; i += 1) {
            const a = Math.random() * Math.PI * 2;
            sparkles.emit({ x: Math.cos(a) * 0.4, y: restY + 0.05, z: Math.sin(a) * 0.4, vx: Math.cos(a) * 0.8, vy: 0.8 + Math.random() * 0.8, vz: Math.sin(a) * 0.8, gravity: -3, life: 0.7 + Math.random() * 0.4, size: 0.08, sizeTo: 0.02, r: toss.result === 'heads' ? 1.4 : 1.1, g: toss.result === 'heads' ? 1.1 : 1.15, b: toss.result === 'heads' ? 0.5 : 1.25, fade: 0.4 });
          }
        }
        if (s >= 1) {
          coin.rotation.z = 0;
          const done = toss;
          toss = null;
          done.resolve();
        }
      }
    }
    {
      const e = (now - landedAt) / 1000;
      shine.position.set(0, restY + 0.12, 0.25);
      shine.quaternion.copy(camera.quaternion);
      shine.material.opacity = e >= 0 && e < 6 ? Math.min(1, e * 4) * (0.42 + Math.sin(clock * 3) * 0.05) : 0;
    }
    halos.material.opacity = reduce ? 0.5 : 0.5 + Math.sin(clock * 11) * 0.04 + Math.sin(clock * 17) * 0.03;
    key.intensity = 9 + (reduce ? 0 : Math.sin(clock * 9) * 0.3);
    forge.intensity = 4 + (reduce ? 0 : Math.sin(clock * 5) * 0.6 + Math.sin(clock * 13) * 0.3);
    sparkles.step(dt);
    if (composer) composer.render(dt);
    else renderer.render(scene, camera);
  }
  resize();
  try { renderer.compile(scene, camera); } catch { /* compiled on first use */ }
  raf = requestAnimationFrame(frame);

  const controls = {
    tier: tier.name,
    /** 'land'. */
    onCue: null,
    /** Tosses the coin; resolves when it has landed on `result` ('heads' gold up, 'tails' iron up). */
    flip(result) {
      shine.material.color.setHex(result === 'heads' ? 0xffd75e : 0xdfe6f0);
      const total = Math.PI * 2 * TURNS + (result === 'tails' ? Math.PI : 0);
      if (reduce) {
        coin.rotation.x = total;
        landedAt = performance.now();
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        toss = { at: performance.now(), total, result, resolve, rang: false };
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      const pending = toss;
      toss = null;
      pending?.resolve();
      composer?.dispose();
      renderer.dispose();
      renderer.forceContextLoss?.();
      canvas.remove();
    },
  };
  return controls;
}
