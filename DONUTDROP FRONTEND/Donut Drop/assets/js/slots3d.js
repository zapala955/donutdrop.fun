/* slots3d.js — a slot machine standing in a room, a camera that walks around it. Two themes share
 * the machine: Ore Rush in a bastion vault (slots3d-bastion.js) and the Ocean Monument in the
 * guardians' temple (slots3d-monument.js). The theme picks the cabinet's blocks, the marquee, the
 * light and the loot; its stage module builds the room, the crown, the free-spin herald and the mobs.
 *
 * Each reel is a drum whose facets ARE that reel's strip, in the server's order (lib/slots.ts), so
 * what turns past the glass is the machine the server plays, not a picture of one. A landed reel
 * shows the strip index the server stopped it at in its top row.
 *
 * The machine is built the way the rest of the site's scenes are (mc3d.js): Minecraft block textures
 * on real boxes, nearest-filtered, lit and shadowed. Pillars banded in gold, a marquee ringed with
 * chase lights, a crown, a ledge with the game's own GUI buttons, a lever on the right pillar and a
 * payout chute that spills what a spin paid onto the floor.
 *
 * Items are Minecraft's own: every sprite is extruded into a one-pixel-deep model the way the game
 * builds a dropped item, so a winning symbol lifts off its drum as a real object, turning and
 * bobbing, and the payout is the theme's loot bouncing across the floor.
 *
 * The camera is a director, not a viewer: three-quarters on the machine while nobody plays, square
 * on the reels for a spin, pushed in on the last reels when two scatters are down, closer and
 * shaking for a big win, pulled back for the herald that opens free spins. Dragging turns it.
 *
 * Nothing here decides anything. slots.js hands it the stops the server returned and waits for the
 * drums to land on them. If WebGL is missing or the context is lost, slots.js keeps the flat reels.
 */
import { reduceMotion } from './util.js';
import { getTHREE, loadImage, crop, softDot } from './mc3d.js';
import { atlas, pixelTexture, makeSprites } from './mcmodels.js';
import { gradePass } from './scenery3d.js';
import { buildBastionStage } from './slots3d-bastion.js';
import { buildMonumentStage } from './slots3d-monument.js';
import { BRIGHTNESS } from './quality3d.js';

const TILE = 128;            // one symbol in the drum atlas
const ATLAS_COLS = 4;
const REEL_W = 0.96;         // a drum's width; a facet is one unit tall
const PITCH = 1.1;           // drum centre to drum centre: five drums fill the window
const B = 0.54;              // one block
const Z0 = 0;                // where every drum's front facet sits
const OPEN_W = 10 * B;       // the window: ten blocks wide ...
const OPEN_H = 6 * B;        // ... six tall, three rows and a sliver of the next
const FRAME_X = OPEN_W / 2 + B / 2;
const FRAME_Y = OPEN_H / 2 + B / 2;
const Z_FRAME = Z0 + B / 2 + 0.04;
const FRONT = Z_FRAME + B / 2;       // the machine's front face
const PILLAR_X = FRAME_X + B;
const MARQUEE_Y = FRAME_Y + B * 1.5;
const ROOF_Y = FRAME_Y + B * 2.5;
const LEDGE_Y = -FRAME_Y - B;
const CHUTE_Y = -FRAME_Y - 2 * B;
const PLINTH_Y = -FRAME_Y - 3 * B;
const FLOOR_Y = PLINTH_Y - B / 2;
const BACK_Z = Z_FRAME - 3.5 * B;    // the back of the cabinet
const LEDGE_FRONT = 1.2;

const MAX_SPEED = 15;        // radians a second at full spin
const ACCEL = 70;
const LAND_TIME = 0.42;      // seconds from braking to rest
const BACK = 0.6;            // easeOutBack: a small settle past the stop and back
const LINE_COLORS = [0xffff55, 0x55ffff, 0x55ff55, 0xff55ff, 0xffaa00, 0xff5555, 0x5555ff, 0xffffff, 0x00aaaa, 0x00aa00];
const FIREWORK_COLORS = [0xff5555, 0xffaa00, 0xffff55, 0x55ff55, 0x55ffff, 0x5555ff, 0xff55ff, 0xffffff];
const SCATTER_COLOR = 0xff55ff;

const easeOutBack = (t) => 1 + (BACK + 1) * (t - 1) ** 3 + BACK * (t - 1) ** 2;
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const easeOut = (t) => 1 - (1 - t) ** 3;
const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
const mod = (a, n) => ((a % n) + n) % n;

/* The camera's shots. Each frames a box of the scene (centre, half width, half height, half depth)
 * from a yaw and a pitch; the distance is worked out for whatever shape the canvas is. */
const SHOTS = {
  intro: { c: [0.4, 0.6, 0], hw: 4.7, hh: 4.6, hd: 1.8, yaw: 1.15, pitch: 0.5, zoom: 1.9 },
  idle: { c: [-0.7, 0.3, 0.2], hw: 5.2, hh: 4.45, hd: 1.8, yaw: 0.42, pitch: 0.11, zoom: 1 },
  idleWide: { c: [-1.75, 0.35, 0.3], hw: 6.5, hh: 4.5, hd: 2.0, yaw: 0.36, pitch: 0.1, zoom: 1 },
  playWide: { c: [-1.55, 0.35, 0.7], hw: 5.8, hh: 3.05, hd: 0.6, yaw: 0.12, pitch: 0.05, zoom: 1 },
  winWide: { c: [-0.7, -0.3, 0.6], hw: 5.1, hh: 3.8, hd: 0.8, yaw: 0.16, pitch: 0.13, zoom: 1 },
  freeWide: { c: [-1.5, 1.3, 0.4], hw: 5.7, hh: 4.3, hd: 0.8, yaw: 0.08, pitch: 0.08, zoom: 1 },
  bigWide: { c: [-1.75, 0.0, 0.6], hw: 5.9, hh: 3.4, hd: 0.6, yaw: 0.06, pitch: 0.06, zoom: 1 },
  play: { c: [0.12, 0.42, 0.3], hw: 3.75, hh: 3.05, hd: 0.6, yaw: 0.1, pitch: 0.05, zoom: 1 },
  tease: { c: [1.55, 0.05, 0.3], hw: 2.75, hh: 2.15, hd: 0.5, yaw: 0.22, pitch: 0.03, zoom: 1 },
  big: { c: [0, 0.3, 0.3], hw: 3.45, hh: 2.6, hd: 0.5, yaw: -0.05, pitch: 0.05, zoom: 1 },
  free: { c: [0, 1.55, 0.3], hw: 3.95, hh: 4.2, hd: 0.8, yaw: -0.16, pitch: 0.08, zoom: 1 },
  win: { c: [0.15, -0.3, 0.6], hw: 3.9, hh: 3.8, hd: 0.8, yaw: 0.16, pitch: 0.13, zoom: 1 },
};

/* What differs between the machines: the blocks the cabinet is built of (assets/img/block, by role),
 * the marquee, the light, the chase-light colours, the inventory slots behind the symbols, the loot
 * the chute spills (smallest first), and the stage that builds the room, the crown and the mobs. */
const THEMES = {
  'ore-rush': {
    room: 0x0b0708,
    fog: [19, 44],
    blocks: {
      frame: 'polished_blackstone', accent: 'gold_block', band: 'gilded_blackstone', base: 'blackstone',
      lever: 'stone', lamp: 'magma', back: 'deepslate_top', backFree: 'crying_obsidian',
    },
    mats: { frame: { roughness: 0.58, metalness: 0.04 }, band: { roughness: 0.48, metalness: 0.38 } },
    tint: { shell: 0x9a9aa4, ledge: 0xc0bcc8, back: 0x55555f, backFree: 0x8a6aa8 },
    lamp: { emissive: 0x7a2a00, free: 0x5a1a7a, glow: 0xff7a20, glowFree: 0xa040ff, frameMs: 400 },
    light: {
      hemi: [0xc4b4d4, 0x24100a, 0.55], key: [0xffe6cc, 0.8], spot: [0xffe2bc, 230], rim: [0xff7a3a, 1.1],
      pool: 0xffa860, lamp: 0xffb85c, lampFree: 0x9b4dff,
    },
    marquee: { text: 'ORE RUSH', icon: 'netherite_pickaxe', fill: '#ffaa00', shade: '#2a2a00', dim: 0.55, emissive: 0x3a2400 },
    bulbs: { attract: [1, 0.82, 0.45], free: [0.78, 0.38, 1], tease: [1, 0.33, 1] },
    glint: ['rgba(120,60,255,0)', 'rgba(150,80,255,.25)', 'rgba(210,150,255,1)'],
    slot: ['#2c2c32', '#4c4c56', '#121216', '#1f1f25'],
    loot: ['gold_nugget', 'emerald', 'gold_ingot', 'diamond'],
    stage: buildBastionStage,
  },
  monument: {
    room: 0x02141c,
    fog: [13, 38],
    blocks: {
      frame: 'prismarine_bricks', accent: 'gold_block', band: 'dark_prismarine', base: 'dark_prismarine',
      lever: 'prismarine_bricks', lamp: 'sea_lantern', back: 'dark_prismarine', backFree: 'prismarine',
    },
    // Prismarine's pale cyan a shade down, so the cabinet sits in the water rather than glowing in it.
    mats: { frame: { roughness: 0.5, metalness: 0.04, color: 0xa4bcb8 }, band: { roughness: 0.55, metalness: 0.04 } },
    tint: { shell: 0x7a9090, ledge: 0x9ab0b0, back: 0x3a5a5a, backFree: 0x6a8aa8 },
    lamp: { emissive: 0x5a8a84, free: 0x5a4ab0, glow: 0x9ffff0, glowFree: 0x8f6aff, frameMs: 250 },
    light: {
      hemi: [0x9fe8ff, 0x041a22, 0.6], key: [0xd8f6ff, 0.7], spot: [0xc8f4ff, 230], rim: [0x29b6c8, 1.0],
      pool: 0x5ad0e0, lamp: 0xc8fff8, lampFree: 0x8a6cff,
    },
    marquee: { text: 'MONUMENT', icon: 'trident', fill: '#55ffff', shade: '#002a2a', dim: 0.5, emissive: 0x003838 },
    bulbs: { attract: [0.55, 1, 0.92], free: [0.66, 0.5, 1], tease: [0.55, 1, 1] },
    glint: ['rgba(40,200,220,0)', 'rgba(60,220,230,.25)', 'rgba(170,255,250,1)'],
    slot: ['#1e2c30', '#36505a', '#0b1417', '#152328'],
    loot: ['prismarine_shard', 'prismarine_crystals', 'gold_ingot', 'heart_of_the_sea'],
    // Free spins pull back far enough to show the Elder Guardian risen behind the machine.
    shots: {
      free: { c: [0, 2.3, 0.3], hw: 4.4, hh: 4.95, hd: 0.8, yaw: -0.12, pitch: 0.1, zoom: 1 },
      freeWide: { c: [-1.2, 2.2, 0.4], hw: 6.2, hh: 4.95, hd: 0.8, yaw: 0.06, pitch: 0.1, zoom: 1 },
    },
    stage: buildMonumentStage,
  },
};

/**
 * Builds the machine into `host` and resolves with its controls, or with null when this browser
 * cannot draw it (no WebGL), in which case nothing is left behind in `host`.
 */
export async function createMachine3d(host, { strips, symbols, scatter, lines, icon, theme = 'ore-rush', onLever, onAuto, onTurbo }) {
  const THEME = THEMES[theme] || THEMES['ore-rush'];
  const [SLOT, SLOT_HI, SLOT_LO, SLOT_IN] = THEME.slot;
  const THREE = await getTHREE();
  // Asked first on a scratch canvas, so a browser without WebGL gets the flat reels and a quiet console.
  const probe = document.createElement('canvas');
  if (!(probe.getContext('webgl2') || probe.getContext('webgl'))) return null;
  const canvas = document.createElement('canvas');
  canvas.className = 'slots__gl';
  canvas.setAttribute('aria-hidden', 'true');
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  } catch {
    return null;
  }
  // The resolution follows the frame rate (see `adapt` below), starting from the screen's own.
  const MAX_RATIO = Math.min(1.5, devicePixelRatio || 1);
  let ratio = MAX_RATIO;
  renderer.setPixelRatio(ratio);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0 * BRIGHTNESS;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  // The drums are big wheels; only the band behind the glass is drawn.
  renderer.localClippingEnabled = true;
  renderer.setClearColor(THEME.room, 1);
  host.prepend(canvas);

  const BLOCK_NAMES = [...new Set(Object.values(THEME.blocks))];
  const [items, lootImgs, blockImgs, pick] = await Promise.all([
    Promise.all(symbols.map((s) => loadImage(icon(s.id)))),
    Promise.all(THEME.loot.map((name) => loadImage(`assets/img/items/${name}.png`))),
    Promise.all(BLOCK_NAMES.map((name) => loadImage(`assets/img/block/${name}.png`))),
    loadImage(`assets/img/items/${THEME.marquee.icon}.png`),
  ]);
  const byName = Object.fromEntries(BLOCK_NAMES.map((name, i) => [name, blockImgs[i]]));
  // The cabinet's block faces by the part they play: tex.frame, tex.accent, tex.band, ...
  const tex = Object.fromEntries(Object.entries(THEME.blocks).map(([part, name]) => [part, byName[name]]));
  try { await document.fonts?.load('900 100px Archivo'); } catch { /* the fallback face still reads */ }
  // Particles straight out of the client jar (assets/img/entity, assets/img/particle).
  const [orbImg, sparkImgs, guiImgs, addons] = await Promise.all([
    loadImage('assets/img/entity/experience_orb.png'),
    Promise.all(Array.from({ length: 8 }, (_, i) => loadImage(`assets/img/particle/spark_${i}.png`))),
    // The ledge buttons: the game's GUI button in its three states, and its font.
    Promise.all(['button', 'button_highlighted', 'button_disabled', 'ascii'].map((name) => loadImage(`assets/img/gui/${name}.png`))),
    /* Bloom and the rest of the post-processing; without them the scene is drawn straight to screen.
     * Against the page, as mc3d.js loads three.js: the build bundles this module into a chunk under
     * /b/<id>/, and the addons' own import of ./three.module.min.js then finds the same copy of three. */
    import(/* @vite-ignore */ new URL('assets/vendor/three-addons.js', document.baseURI).href).catch(() => null),
  ]);

  const reduce = reduceMotion();
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(THEME.room);
  scene.fog = new THREE.Fog(THEME.room, THEME.fog[0], THEME.fog[1]);
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 120);
  const machine = new THREE.Group();
  scene.add(machine);
  const maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  /* Image-based light from a neutral room, so gold reads as metal and polished blackstone shines;
   * and a post chain: the scene into a multisampled HDR target, bloom on what is bright (lava, lamps,
   * bulbs, the star, firework stars), then tone mapping and sRGB in the output pass. */
  let composer = null;
  let bloom = null;
  let roomEnv = null;
  if (addons) {
    try {
      const pmrem = new THREE.PMREMGenerator(renderer);
      roomEnv = pmrem.fromScene(new addons.RoomEnvironment(), 0.04).texture;
      // Faint for the stone; the metals take theirs below, at their own strength.
      scene.environment = roomEnv;
      scene.environmentIntensity = 0.12;
      pmrem.dispose();
      const target = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: renderer.capabilities.isWebGL2 ? 4 : 0 });
      composer = new addons.EffectComposer(renderer, target);
      composer.addPass(new addons.RenderPass(scene, camera));
      bloom = new addons.UnrealBloomPass(new THREE.Vector2(4, 4), 0.4, 0.4, 1.1);
      composer.addPass(bloom);
      composer.addPass(new addons.OutputPass());
      composer.addPass(gradePass(THREE, addons, { contrast: 1.03, saturation: 1.05, vignette: 0.12 }));
    } catch {
      composer = null;
      bloom = null;
    }
  }

  /* ── textures ── */
  /** A block face, pixel-sharp up close and smooth far off, tiled rx × ry times. */
  const pixel = (source, rx = 1, ry = 1, frame = 0, size = 16) => {
    const t = crop(source, 0, frame * size, size, size);
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = maxAniso;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(rx, ry);
    return t;
  };
  const lambert = (map, opts = {}) => new THREE.MeshStandardMaterial({ map, roughness: 0.8, metalness: 0.04, ...opts });
  const block = {
    frame: lambert(pixel(tex.frame), THEME.mats.frame),
    accent: lambert(pixel(tex.accent), { roughness: 0.26, metalness: 0.92 }),
    band: lambert(pixel(tex.band), THEME.mats.band),
    base: lambert(pixel(tex.base), { roughness: 0.85 }),
    lever: lambert(pixel(tex.lever), { roughness: 0.9 }),
  };
  if (roomEnv) {
    for (const [m, strength] of [[block.accent, 0.75], [block.band, 0.3]]) {
      m.envMap = roomEnv;
      m.envMapIntensity = strength;
    }
  }
  // The pillar lamps (magma, sea lanterns) glow with their own face, animated frame by frame as in the game.
  const lampFrames = Array.from({ length: Math.max(1, Math.floor((tex.lamp.naturalHeight || 16) / 16)) }, (_, f) => pixel(tex.lamp, 1, 1, f));
  block.lamp = lambert(lampFrames[0]);
  block.lamp.emissiveMap = lampFrames[0];
  block.lamp.emissive = new THREE.Color(THEME.lamp.emissive);
  const dot = softDot();
  const halo = (size, color, opacity) => new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({
    map: dot, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  }));

  /* ── the drum atlas: every symbol in its inventory slot, sharp and motion-blurred ── */
  const rows = Math.ceil(symbols.length / ATLAS_COLS);
  const atlasCanvas = (draw) => {
    const c = document.createElement('canvas');
    c.width = ATLAS_COLS * TILE;
    c.height = rows * TILE;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    symbols.forEach((_, i) => draw(g, (i % ATLAS_COLS) * TILE, Math.floor(i / ATLAS_COLS) * TILE, items[i]));
    return c;
  };
  // An inventory slot, bevel and all, in dark: the light GUI grey under the cabinet lamp washes the items out.
  const slotBack = (g, x, y) => {
    g.fillStyle = SLOT; g.fillRect(x, y, TILE, TILE);
    g.fillStyle = SLOT_LO; g.fillRect(x + 6, y + 6, TILE - 12, 6); g.fillRect(x + 6, y + 6, 6, TILE - 12);
    g.fillStyle = SLOT_HI; g.fillRect(x + 6, y + TILE - 12, TILE - 12, 6); g.fillRect(x + TILE - 12, y + 6, 6, TILE - 12);
    g.fillStyle = SLOT_IN; g.fillRect(x + 12, y + 12, TILE - 24, TILE - 24);
  };
  const canvasTex = (c, srgb = true) => {
    const t = new THREE.CanvasTexture(c);
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.anisotropy = maxAniso;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  const sharp = canvasTex(atlasCanvas((g, x, y, im) => { slotBack(g, x, y); g.drawImage(im, x + 16, y + 16, 96, 96); }));
  const blurred = canvasTex(atlasCanvas((g, x, y, im) => {
    slotBack(g, x, y);
    for (let k = -5; k <= 5; k += 1) {
      g.globalAlpha = 0.16;
      g.drawImage(im, x + 16, y + 16 + k * 5, 96, 96);
    }
    g.globalAlpha = 1;
  }));
  // The items' own pixels, white on nothing: the glint's mask (an alphaMap reads the green channel).
  const mask = canvasTex(atlasCanvas((g, x, y, im) => {
    g.drawImage(im, x + 16, y + 16, 96, 96);
    g.globalCompositeOperation = 'source-atop';
    g.fillStyle = '#fff';
    g.fillRect(x, y, TILE, TILE);
    g.globalCompositeOperation = 'source-over';
  }), false);
  const glint = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 128, 128);
    const [edge, mid, core] = THEME.glint;
    grad.addColorStop(0, edge);
    grad.addColorStop(0.42, mid);
    grad.addColorStop(0.5, core);
    grad.addColorStop(0.58, mid);
    grad.addColorStop(1, edge);
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(3, 3);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();

  /* ── items: a sprite extruded one pixel deep, the way the game builds a dropped item ── */
  function itemModel(source) {
    const S = 16;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(source, 0, 0, source.naturalWidth || source.width, source.naturalHeight || source.height, 0, 0, S, S);
    const data = g.getImageData(0, 0, S, S).data;
    const solid = (x, y) => x >= 0 && y >= 0 && x < S && y < S && data[(y * S + x) * 4 + 3] > 127;
    const pos = []; const nor = []; const uv = [];
    const d = 0.5 / S;
    const quad = (a, b, c2, e, n, ua, ub, uc, ue) => {
      for (const [v, t] of [[a, ua], [b, ub], [c2, uc], [a, ua], [c2, uc], [e, ue]]) {
        pos.push(...v); nor.push(...n); uv.push(...t);
      }
    };
    // The faces: the whole sprite, front and back; transparent pixels are cut by alphaTest.
    quad([-0.5, -0.5, d], [0.5, -0.5, d], [0.5, 0.5, d], [-0.5, 0.5, d], [0, 0, 1], [0, 0], [1, 0], [1, 1], [0, 1]);
    quad([0.5, -0.5, -d], [-0.5, -0.5, -d], [-0.5, 0.5, -d], [0.5, 0.5, -d], [0, 0, -1], [1, 0], [0, 0], [0, 1], [1, 1]);
    // The edges: a strip one pixel deep wherever a solid pixel meets an empty one, in that pixel's colour.
    for (let y = 0; y < S; y += 1) {
      for (let x = 0; x < S; x += 1) {
        if (!solid(x, y)) continue;
        const x0 = -0.5 + x / S; const x1 = x0 + 1 / S;
        const y1 = 0.5 - y / S; const y0 = y1 - 1 / S;
        const t = [(x + 0.5) / S, 1 - (y + 0.5) / S];
        if (!solid(x - 1, y)) quad([x0, y0, -d], [x0, y0, d], [x0, y1, d], [x0, y1, -d], [-1, 0, 0], t, t, t, t);
        if (!solid(x + 1, y)) quad([x1, y0, d], [x1, y0, -d], [x1, y1, -d], [x1, y1, d], [1, 0, 0], t, t, t, t);
        if (!solid(x, y - 1)) quad([x0, y1, d], [x1, y1, d], [x1, y1, -d], [x0, y1, -d], [0, 1, 0], t, t, t, t);
        if (!solid(x, y + 1)) quad([x0, y0, -d], [x1, y0, -d], [x1, y0, d], [x0, y0, d], [0, -1, 0], t, t, t, t);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    const map = new THREE.CanvasTexture(c);
    map.magFilter = THREE.NearestFilter;
    map.minFilter = THREE.NearestFilter;
    map.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.MeshLambertMaterial({ map, alphaTest: 0.5, emissive: 0x1c1c1c });
    return { geometry, material };
  }
  const symbolModels = items.map(itemModel);
  // The payout, smallest first: what spills from the chute, the rarer the bigger the win.
  const loot = lootImgs.map(itemModel);

  /* ── experience orbs: what rises from winning cells, and from whoever celebrates ── */
  const orbSprites = makeSprites(THREE, { map: pixelTexture(THREE, orbImg), cols: 4, rows: 4, count: 240, additive: true });
  // Experience orbs, tinted the way the game tints them, green to yellow.
  const orbs = {
    points: orbSprites.points,
    emit(n, { x, y, z, spread = 0.3, up = 1.4, out = 0.6, life = 1.2 }) {
      for (let i = 0; i < n; i += 1) {
        const a = Math.random() * Math.PI * 2;
        const r = spread * Math.random();
        orbSprites.emit({
          x: x + Math.cos(a) * r, y, z: z + Math.sin(a) * r,
          vx: Math.cos(a) * out * (0.4 + Math.random()), vy: up * (0.6 + Math.random()), vz: Math.sin(a) * out * (0.4 + Math.random()),
          gravity: -2.6, drag: 0.5, life: life * (0.7 + Math.random() * 0.6), size: 0.2 + Math.random() * 0.14,
          frame: Math.floor(Math.random() * 7), r: 0.7 + Math.random() * 0.3, g: 1, b: 0.2, fade: 0.35,
        });
      }
    },
    step(dt) { orbSprites.step(dt); },
  };
  scene.add(orbs.points);

  /* ── the stage: the theme's room, its crown, the herald of free spins, its mobs ── */
  const stage = await THEME.stage({
    THREE, scene, machine, camera, reduce,
    dims: { B, FLOOR_Y, Z_FRAME, FRONT, ROOF_Y, CHUTE_Y, PILLAR_X, OPEN_W, OPEN_H, MARQUEE_Y, Z0 },
    kit: { pixel, lambert, halo, dot, itemModel, crop },
    block,
    orbs,
    // Where a cell's middle is, in the machine's space (the drums are built below).
    cellAt: (reel, row) => cellCentre(reel, row),
  });

  /* ── light ── */
  const L = THEME.light;
  scene.add(new THREE.HemisphereLight(L.hemi[0], L.hemi[1], L.hemi[2]));
  const key = new THREE.DirectionalLight(L.key[0], L.key[1]);
  key.position.set(6, 11, 10);
  scene.add(key);
  // A stage spot from above the player's shoulder: the pool of light the machine stands in, and its shadow.
  // Wide enough to take in the mobs beside it.
  const spot = new THREE.SpotLight(L.spot[0], L.spot[1], 36, 0.66, 0.6, 1.3);
  spot.position.set(2, 13, 10);
  spot.target.position.set(-1.9, -1.2, 0.5);
  spot.castShadow = true;
  spot.shadow.mapSize.set(1024, 1024);
  spot.shadow.bias = -0.0005;
  spot.shadow.normalBias = 0.03;
  scene.add(spot, spot.target);
  const pool = new THREE.Mesh(new THREE.PlaneGeometry(18, 9), new THREE.MeshBasicMaterial({
    map: dot, color: L.pool, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  pool.rotation.x = -Math.PI / 2;
  pool.position.set(-1.8, FLOOR_Y + 0.015, 1.4);
  scene.add(pool);
  const rim = new THREE.DirectionalLight(L.rim[0], L.rim[1]);
  rim.position.set(-7, 5, -7);
  scene.add(rim);
  const lamp = new THREE.PointLight(L.lamp, 9, 7, 1.6);
  lamp.position.set(0, OPEN_H / 2 + 0.25, 1.4);
  machine.add(lamp);

  /* ── the drums ── */
  const tileUV = (symbol) => {
    const col = symbol % ATLAS_COLS;
    const row = Math.floor(symbol / ATLAS_COLS);
    const inset = 0.5 / (ATLAS_COLS * TILE);
    const insetV = 0.5 / (rows * TILE);
    return {
      u0: col / ATLAS_COLS + inset, u1: (col + 1) / ATLAS_COLS - inset,
      vTop: 1 - row / rows - insetV, vBot: 1 - (row + 1) / rows + insetV,
    };
  };

  /* A prism with one facet per strip entry. Facet k is centred at angle k·step below the front, so
   * turning the drum forward (rotation.x up) carries the symbols downward past the glass. */
  function drumGeometry(strip) {
    const n = strip.length;
    const step = (Math.PI * 2) / n;
    const r = 0.5 / Math.sin(step / 2); // corner radius: every facet is exactly one unit tall
    const pos = [];
    const nor = [];
    const uv = [];
    const half = REEL_W / 2;
    strip.forEach((symbol, k) => {
      const a0 = k * step - step / 2;
      const a1 = k * step + step / 2;
      const am = k * step;
      const p = (x, a) => [x, -r * Math.sin(a), r * Math.cos(a)];
      const A = p(-half, a0); const Bv = p(half, a0); const C = p(half, a1); const D = p(-half, a1);
      const { u0, u1, vTop, vBot } = tileUV(symbol);
      for (const [v, t] of [[A, [u0, vTop]], [D, [u0, vBot]], [C, [u1, vBot]], [A, [u0, vTop]], [C, [u1, vBot]], [Bv, [u1, vTop]]]) {
        pos.push(...v);
        nor.push(0, -Math.sin(am), Math.cos(am));
        uv.push(...t);
      }
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    return { geo, step, apothem: 0.5 / Math.tan(step / 2), radius: r };
  }

  const band = OPEN_H / 2 + B / 2;
  const clip = [
    new THREE.Plane(new THREE.Vector3(0, -1, 0), band),
    new THREE.Plane(new THREE.Vector3(0, 1, 0), band),
    new THREE.Plane(new THREE.Vector3(0, 0, 1), -(Z0 - 1.3)),
  ];
  const capMat = new THREE.MeshLambertMaterial({ color: 0x1a1a20, clippingPlanes: clip, side: THREE.DoubleSide });
  const reels = strips.map((strip, i) => {
    const { geo, step, apothem, radius } = drumGeometry(strip);
    const material = new THREE.MeshLambertMaterial({ map: sharp, clippingPlanes: clip });
    const drum = new THREE.Mesh(geo, material);
    // Each drum sits back by its own apothem, so every front facet meets the glass at Z0.
    const x = (i - 2) * PITCH;
    drum.position.set(x, 0, Z0 - apothem);
    machine.add(drum);
    for (const side of [-1, 1]) {
      const cap = new THREE.Mesh(new THREE.CircleGeometry(radius, 48), capMat);
      cap.rotation.y = side * Math.PI / 2;
      cap.position.set(x + side * (REEL_W / 2), 0, Z0 - apothem);
      machine.add(cap);
    }
    const shine = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      map: glint, alphaMap: mask, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false,
      clippingPlanes: clip,
    }));
    shine.scale.set(1, 1.003, 1.003);
    shine.visible = false;
    drum.add(shine);
    return {
      strip, step, apothem, x, drum, material, shine,
      angle: 0, speed: 0, state: 'idle', top: 0, landTime: LAND_TIME,
      landAt: 0, from: 0, to: 0, t0: 0, dur: 0, startLand: 0, arc: 0, spinSince: 0,
    };
  });

  const angleFor = (reel, top) => -mod(top + 1, reel.strip.length) * reel.step;
  const setAngle = (reel, angle) => { reel.angle = angle; reel.drum.rotation.x = angle; };

  /* ── the cabinet, block by block (instanced per texture, so the intro can build it) ── */
  const cube = new THREE.BoxGeometry(B, B, B);
  const placed = [];
  const place = (mat, x, y, z) => placed.push({ mat, x, y, z });
  // The window frame, gold at the corners.
  for (let ix = -6; ix <= 5; ix += 1) {
    const x = (ix + 0.5) * B;
    for (const y of [-FRAME_Y, FRAME_Y]) place(ix === -6 || ix === 5 ? block.accent : block.frame, x, y, Z_FRAME);
  }
  for (let iy = -2; iy <= 3; iy += 1) for (const x of [-FRAME_X, FRAME_X]) place(block.frame, x, (iy - 0.5) * B, Z_FRAME);
  // Two pillars, four blocks deep, banded in gold, a lamp on each.
  for (const x of [-PILLAR_X, PILLAR_X]) {
    for (let k = 0; k < 12; k += 1) {
      const y = CHUTE_Y + k * B;
      for (let j = 0; j < 4; j += 1) place(k === 0 || k === 11 || k === 5 ? block.accent : block.frame, x, y, Z_FRAME - j * B);
    }
    place(block.lamp, x, CHUTE_Y + 12 * B, Z_FRAME);
  }
  // The body under the ledge, with the payout chute open in the middle.
  for (let ix = -6; ix <= 5; ix += 1) {
    if (ix >= -2 && ix <= 1) continue;
    place(block.frame, (ix + 0.5) * B, CHUTE_Y, Z_FRAME);
  }
  // The plinth, banded at the front.
  for (let ix = -7; ix <= 6; ix += 1) {
    for (let j = -2; j <= 3; j += 1) place(j === -2 ? block.band : block.base, (ix + 0.5) * B, PLINTH_Y, Z_FRAME - j * B);
  }
  // The crown: three blocks on the roof.
  for (const x of [-B, 0, B]) place(x === 0 ? block.accent : block.band, x, ROOF_Y + 0.16 + B / 2, Z_FRAME - B);
  for (const r of stage.roomBlocks || []) placed.push({ ...r, room: true });

  const blockMeshes = [];
  const matrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const one = new THREE.Vector3(1, 1, 1);
  const vec = new THREE.Vector3();
  const scaleV = new THREE.Vector3();
  {
    const groups = new Map();
    for (const b of placed) {
      const key2 = `${b.room ? 'room' : 'machine'}:${b.mat.uuid}`;
      if (!groups.has(key2)) groups.set(key2, []);
      groups.get(key2).push(b);
    }
    for (const list of groups.values()) {
      const mesh = new THREE.InstancedMesh(cube, list[0].mat, list.length);
      list.forEach((b, i) => {
        // Bottom up, with a little scatter: the build order of the intro.
        b.delay = 0.1 + ((b.y - FLOOR_Y) / 9) * 1.15 + Math.random() * 0.12 + (b.room ? 0 : 0.05);
        mesh.setMatrixAt(i, matrix.compose(vec.set(b.x, b.y, b.z), quat.identity(), one));
      });
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      (list[0].room ? scene : machine).add(mesh);
      blockMeshes.push({ mesh, list });
    }
  }

  /** A box of block texture tiled at one block per face unit, whatever the box's size. */
  function slab(source, w, h, d, tint = 0xffffff) {
    const t = (rx, ry) => lambert(pixel(source, rx / B, ry / B), { color: tint });
    const mats = [t(d, h), t(d, h), t(w, d), t(w, d), t(w, h), t(w, h)];
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mats);
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  }

  // The window's back, behind the gaps between drums: dark, and the theme's free-spin face in free spins.
  const backMap = pixel(tex.back, 10, 6);
  const backFreeMap = pixel(tex.backFree, 10, 6);
  const back = new THREE.Mesh(new THREE.PlaneGeometry(OPEN_W + 0.2, OPEN_H + 0.2), lambert(backMap, { color: THEME.tint.back }));
  back.position.set(0, 0, Z0 - 1.25);
  machine.add(back);
  // Dark-gold mullions between the drums hide the drums' ends.
  const mullion = new THREE.BoxGeometry(PITCH - REEL_W + 0.02, OPEN_H, 0.34);
  for (let i = 0; i < 4; i += 1) {
    const m = new THREE.Mesh(mullion, block.band);
    m.position.set((i - 1.5) * PITCH, 0, Z0 + 0.1);
    machine.add(m);
  }
  // The cabinet's back and roof close the box.
  const shell = slab(tex.frame, OPEN_W + 2 * B, ROOF_Y - CHUTE_Y + B / 2, 0.3, THEME.tint.shell);
  shell.position.set(0, (ROOF_Y + CHUTE_Y - B / 2) / 2, BACK_Z + 0.15);
  machine.add(shell);
  const roofDepth = Z_FRAME + B / 2 + 0.06 - BACK_Z;
  const roof = slab(tex.band, 2 * PILLAR_X + B, 0.16, roofDepth);
  roof.position.set(0, ROOF_Y + 0.08, BACK_Z + roofDepth / 2);
  machine.add(roof);
  // The ledge, with the buttons on it, a gold trim on its nose.
  const ledgeDepth = LEDGE_FRONT - BACK_Z;
  const ledge = slab(tex.frame, OPEN_W + 2 * B, B, ledgeDepth, THEME.tint.ledge);
  ledge.position.set(0, LEDGE_Y, BACK_Z + ledgeDepth / 2);
  machine.add(ledge);
  const nose = new THREE.Mesh(new THREE.BoxGeometry(OPEN_W + 2 * B + 0.02, 0.09, 0.09), block.accent);
  nose.position.set(0, LEDGE_Y + B / 2, LEDGE_FRONT);
  machine.add(nose);
  // The chute: a dark mouth with a gold lip the payout spills over.
  const chuteW = 4 * B;
  const chuteBack = new THREE.Mesh(new THREE.BoxGeometry(chuteW, B, 0.06), new THREE.MeshLambertMaterial({ color: 0x0c0a0c }));
  chuteBack.position.set(0, CHUTE_Y, Z_FRAME - B / 2);
  machine.add(chuteBack);
  const lip = new THREE.Mesh(new THREE.BoxGeometry(chuteW, 0.08, 1.0), block.accent);
  lip.position.set(0, CHUTE_Y - B / 2 + 0.04, Z_FRAME + 0.25);
  lip.castShadow = lip.receiveShadow = true;
  machine.add(lip);

  // The marquee: a slab of the band block whose face carries the name.
  const marqueeTex = (() => {
    const c = document.createElement('canvas');
    c.width = 1024; c.height = 192;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    for (let x = 0; x < c.width; x += 48) for (let y = 0; y < c.height; y += 48) g.drawImage(tex.band, 0, 0, 16, 16, x, y, 48, 48);
    g.fillStyle = `rgba(0,0,0,${THEME.marquee.dim})`;
    g.fillRect(0, 0, c.width, c.height);
    const text = THEME.marquee.text;
    // As large as fits between the two icons.
    let size = 104;
    g.font = `900 ${size}px Archivo, "Arial Black", sans-serif`;
    while (size > 60 && g.measureText(text).width > c.width - 300) {
      size -= 4;
      g.font = `900 ${size}px Archivo, "Arial Black", sans-serif`;
    }
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = THEME.marquee.shade;
    g.fillText(text, c.width / 2 + 9, c.height / 2 + 13);
    g.fillStyle = THEME.marquee.fill;
    g.fillText(text, c.width / 2, c.height / 2 + 4);
    const w = g.measureText(text).width;
    g.drawImage(pick, c.width / 2 - w / 2 - 120, c.height / 2 - 48, 96, 96);
    g.save();
    g.translate(c.width / 2 + w / 2 + 120, 0);
    g.scale(-1, 1);
    g.drawImage(pick, 0, c.height / 2 - 48, 96, 96);
    g.restore();
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = maxAniso;
    return t;
  })();
  const marqueeW = OPEN_W + 2 * B;
  const marqueeH = 2 * B;
  const marqueeFace = new THREE.MeshLambertMaterial({ map: marqueeTex, emissive: THEME.marquee.emissive, emissiveMap: marqueeTex });
  const marqueeSide = lambert(pixel(tex.band));
  const marquee = new THREE.Mesh(new THREE.BoxGeometry(marqueeW, marqueeH, B), [
    marqueeSide, marqueeSide, marqueeSide, marqueeSide, marqueeFace, marqueeSide,
  ]);
  marquee.position.set(0, MARQUEE_Y, Z_FRAME + 0.06);
  marquee.castShadow = true;
  machine.add(marquee);

  // The glass: a faint pane with reflection streaks, in front of the drums.
  const glassTex = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    g.translate(128, 128);
    g.rotate(-0.55);
    // Barely there: under bloom, anything stronger reads as a beam of light across the reels.
    for (const [x, w, a] of [[-60, 46, 0.025], [10, 14, 0.018], [70, 70, 0.012]]) {
      const grad = g.createLinearGradient(x - w / 2, 0, x + w / 2, 0);
      grad.addColorStop(0, 'rgba(255,255,255,0)');
      grad.addColorStop(0.5, `rgba(255,255,255,${a})`);
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.fillRect(x - w / 2, -200, w, 400);
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(OPEN_W, OPEN_H), new THREE.MeshBasicMaterial({
    map: glassTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  glass.position.set(0, 0, FRONT - 0.12);
  glass.renderOrder = 5;
  machine.add(glass);

  /* ── buttons on the ledge and the lever on the pillar ── */
  /* ── the ledge buttons: the game's own GUI button, cut to width the way it nine-slices them,
   * lettered in the game's font with its drop shadow, in a gold bezel ── */
  const [btnImg, btnHiImg, btnOffImg, fontImg] = guiImgs;
  const fontCanvas = document.createElement('canvas');
  fontCanvas.width = fontCanvas.height = 128;
  const fontCtx = fontCanvas.getContext('2d', { willReadFrequently: true });
  fontCtx.drawImage(fontImg, 0, 0);
  const fontPixels = fontCtx.getImageData(0, 0, 128, 128).data;
  // A glyph is as wide as its rightmost lit column, and the game advances one pixel past it; a space is four.
  const advance = (code) => {
    if (code === 32) return 4;
    let w = 0;
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 8; x += 1) {
        if (fontPixels[(((code >> 4) * 8 + y) * 128 + (code & 15) * 8 + x) * 4 + 3] > 0) w = Math.max(w, x + 1);
      }
    }
    return w + 1;
  };
  /** Text in the game's font, one canvas pixel to a font pixel, in one colour. */
  const inkText = (text, color) => {
    const codes = [...text].map((ch) => ch.charCodeAt(0) & 255);
    const c = document.createElement('canvas');
    c.width = Math.max(1, codes.reduce((sum, code) => sum + advance(code), 0) - 1);
    c.height = 8;
    const g = c.getContext('2d');
    let x = 0;
    for (const code of codes) {
      g.drawImage(fontCanvas, (code & 15) * 8, (code >> 4) * 8, 8, 8, x, 0, 8, 8);
      x += advance(code);
    }
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = color;
    g.fillRect(0, 0, c.width, c.height);
    return c;
  };
  // The game shades a label's shadow at a quarter of its colour.
  const shadowOf = (hex) => `#${[1, 3, 5].map((i) => Math.floor(parseInt(hex.slice(i, i + 2), 16) / 4).toString(16).padStart(2, '0')).join('')}`;
  const BTN_PX = 4; // canvas pixels to a GUI pixel
  const buttonFace = (sprite, text, color, width, tint) => {
    const c = document.createElement('canvas');
    c.width = width * BTN_PX; c.height = 20 * BTN_PX;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    // Narrower than the sprite's 200: its left part, then its right border.
    const sprite9 = () => {
      g.drawImage(sprite, 0, 0, width - 3, 20, 0, 0, (width - 3) * BTN_PX, 20 * BTN_PX);
      g.drawImage(sprite, 197, 0, 3, 20, (width - 3) * BTN_PX, 0, 3 * BTN_PX, 20 * BTN_PX);
    };
    sprite9();
    if (tint) {
      // Dyed in hue only, so the bevel keeps its light and shade (the sprite is opaque edge to edge).
      g.globalCompositeOperation = 'color';
      g.fillStyle = tint;
      g.fillRect(0, 0, c.width, c.height);
      g.globalCompositeOperation = 'source-over';
    }
    const ink = inkText(text, color);
    const shade = inkText(text, shadowOf(color));
    const x = Math.round((width - ink.width) / 2);
    const y = 6; // (20 - 8) / 2: where the game sets a label
    g.drawImage(shade, (x + 1) * BTN_PX, (y + 1) * BTN_PX, shade.width * BTN_PX, 8 * BTN_PX);
    g.drawImage(ink, x * BTN_PX, y * BTN_PX, ink.width * BTN_PX, 8 * BTN_PX);
    const t = new THREE.CanvasTexture(c);
    t.magFilter = THREE.NearestFilter;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = maxAniso;
    return t;
  };
  const BTN_H = 0.34; // the face: 20 GUI pixels tall
  const makeButton = (text, w, x, tint = null) => {
    const px = Math.round((w / BTN_H) * 20);
    // The game's states: plain, hovered (white border, pale yellow label), on, and disabled.
    const faces = {
      normal: buttonFace(btnImg, text, '#ffffff', px, tint),
      hover: buttonFace(btnHiImg, text, '#ffffa0', px, tint),
      on: buttonFace(btnHiImg, text, '#ffff55', px, tint),
      off: buttonFace(btnOffImg, text, '#a0a0a0', px, tint),
    };
    // The face is a screen of the game's GUI: unlit, so it shows the sprite's own greys.
    // A touch under full white, so the unlit face sits in the dim cabinet rather than glaring from it.
    const front = new THREE.MeshBasicMaterial({ map: faces.normal, color: new THREE.Color().setScalar(0.82) });
    const side = new THREE.MeshLambertMaterial({ color: tint ? 0x5a1a12 : 0x2a2a2a });
    const top = new THREE.MeshLambertMaterial({ color: tint ? 0xa03a28 : 0x7a7a7a });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, BTN_H, 0.3), [side, side, top, side, front, side]);
    const baseY = LEDGE_Y + B / 2 + 0.08 + BTN_H / 2;
    mesh.position.set(x, baseY, 0.78);
    mesh.castShadow = true;
    machine.add(mesh);
    const base = new THREE.Mesh(new THREE.BoxGeometry(w + 0.14, 0.08, 0.44), block.accent);
    base.position.set(x, LEDGE_Y + B / 2 + 0.04, 0.76);
    base.castShadow = base.receiveShadow = true;
    machine.add(base);
    return { mesh, base, front, faces, face: 'normal', press: -1, baseY };
  };
  const spinButton = makeButton('SPIN', 1.6, 0, '#e8402a');
  const autoButton = makeButton('AUTO', 1.05, -1.95);
  const turboButton = makeButton('TURBO', 1.05, 1.95);
  let hoveredButton = null;

  const leverX = PILLAR_X + B;
  const leverBase = new THREE.Mesh(cube, block.lever);
  leverBase.position.set(leverX, -0.27, Z_FRAME);
  leverBase.castShadow = true;
  machine.add(leverBase);
  const pivot = new THREE.Group();
  pivot.position.set(leverX, -0.27 + B / 2, Z_FRAME);
  const stick = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.45, 0.12), new THREE.MeshLambertMaterial({ color: 0x7a5530 }));
  stick.position.y = 0.72;
  stick.castShadow = true;
  const knob = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), new THREE.MeshLambertMaterial({ color: 0xd8342b, emissive: 0x3a0604 }));
  knob.position.y = 1.48;
  knob.castShadow = true;
  pivot.add(stick, knob);
  machine.add(pivot);
  const LEVER_REST = -0.42;
  pivot.rotation.x = LEVER_REST;
  let leverT = -1;

  /* ── the lamps' glow ── */
  const lampGlows = [-PILLAR_X, PILLAR_X].map((x) => {
    const h = halo(2.2, THEME.lamp.glow, 0.5);
    h.position.set(x, CHUTE_Y + 12 * B, FRONT + 0.05);
    machine.add(h);
    return h;
  });

  /* ── chase lights round the marquee and up the pillars ── */
  const bulbSpots = [];
  {
    const x0 = -marqueeW / 2 + 0.12; const x1 = marqueeW / 2 - 0.12;
    const yTop = ROOF_Y - 0.1; const yBot = ROOF_Y - marqueeH + 0.1;
    const z = Z_FRAME + 0.06 + B / 2 + 0.03;
    const n = 20;
    for (let i = 0; i < n; i += 1) bulbSpots.push([x0 + ((x1 - x0) * i) / (n - 1), yTop, z]);
    for (const y of [yTop - 0.3, yTop - 0.6]) bulbSpots.push([x1, y, z]);
    for (let i = n - 1; i >= 0; i -= 1) bulbSpots.push([x0 + ((x1 - x0) * i) / (n - 1), yBot, z]);
    for (const y of [yBot + 0.3, yBot + 0.6]) bulbSpots.push([x0, y, z]);
    for (const x of [-PILLAR_X, PILLAR_X]) {
      for (let k = 1; k <= 10; k += 1) bulbSpots.push([x, CHUTE_Y + k * B, FRONT + 0.03]);
    }
  }
  const bulbs = new THREE.InstancedMesh(new THREE.BoxGeometry(0.14, 0.14, 0.05), new THREE.MeshBasicMaterial({ toneMapped: false }), bulbSpots.length);
  bulbSpots.forEach(([x, y, z], i) => {
    bulbs.setMatrixAt(i, matrix.compose(vec.set(x, y, z), quat.identity(), one));
    bulbs.setColorAt(i, new THREE.Color(0x2a1a08));
  });
  machine.add(bulbs);
  const bulbGlowPos = new Float32Array(bulbSpots.length * 3);
  const bulbGlowCol = new Float32Array(bulbSpots.length * 3);
  bulbSpots.forEach(([x, y, z], i) => bulbGlowPos.set([x, y, z + 0.02], i * 3));
  const bulbGlowGeo = new THREE.BufferGeometry();
  bulbGlowGeo.setAttribute('position', new THREE.BufferAttribute(bulbGlowPos, 3));
  bulbGlowGeo.setAttribute('color', new THREE.BufferAttribute(bulbGlowCol, 3));
  const bulbGlow = new THREE.Points(bulbGlowGeo, new THREE.PointsMaterial({
    size: 0.85, map: dot, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  }));
  bulbGlow.frustumCulled = false;
  machine.add(bulbGlow);
  const bulbColor = new THREE.Color();

  /* ── the win layer: per cell a frame, a wash, a dimmer and the lifted item ── */
  const frameGeo = (() => {
    const s = new THREE.Shape();
    const o = 0.47; const i = 0.41;
    s.moveTo(-o, -o); s.lineTo(o, -o); s.lineTo(o, o); s.lineTo(-o, o); s.lineTo(-o, -o);
    const hole = new THREE.Path();
    hole.moveTo(-i, -i); hole.lineTo(-i, i); hole.lineTo(i, i); hole.lineTo(i, -i); hole.lineTo(-i, -i);
    s.holes.push(hole);
    return new THREE.ShapeGeometry(s);
  })();
  const plane = new THREE.PlaneGeometry(0.94, 0.94);
  const cells = reels.map((reel) => [0, 1, 2].map((row) => {
    const b = (row - 1) * reel.step;
    const holder = new THREE.Group();
    holder.position.set(reel.x, -reel.apothem * Math.sin(b), Z0 - reel.apothem + reel.apothem * Math.cos(b));
    holder.rotation.x = b;
    // Covers the drum's own copy of the symbol, so the lifted item is the only one in the cell.
    const wash = new THREE.Mesh(plane, new THREE.MeshBasicMaterial({ color: 0xffff55, transparent: true, opacity: 0.95, depthWrite: false }));
    wash.position.z = 0.012;
    const dim = new THREE.Mesh(plane, new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.55, depthWrite: false }));
    dim.position.z = 0.014;
    const frame = new THREE.Mesh(frameGeo, new THREE.MeshBasicMaterial({ color: 0xffff55, transparent: true, depthWrite: false, toneMapped: false }));
    frame.position.z = 0.016;
    const item = new THREE.Mesh(symbolModels[0].geometry, symbolModels[0].material);
    item.castShadow = true;
    const glow = halo(1.5, 0xffff55, 0);
    glow.position.z = 0.03;
    for (const m of [wash, dim, frame, item, glow]) { m.visible = false; holder.add(m); }
    machine.add(holder);
    return { holder, wash, dim, frame, item, glow, b, lit: false, rest: false, liftT: 0, phase: Math.random() * 6 };
  }));
  const washBase = new THREE.Color(SLOT_IN);
  const tint = new THREE.Color();
  const cellCentre = (reel, row) => {
    const r = reels[reel];
    const b = (row - 1) * r.step;
    return new THREE.Vector3(r.x, -r.apothem * Math.sin(b), Z0 - r.apothem + r.apothem * Math.cos(b) + 0.42);
  };

  // The ten lines across the glass, each a chain of glowing bars, drawn on from the left.
  const bar = new THREE.BoxGeometry(1, 1, 1);
  const lineMeshes = lines.map((rowsOf, index) => {
    const group = new THREE.Group();
    group.userData = { segments: [], count: 0, shownAt: 0 };
    const color = LINE_COLORS[index % LINE_COLORS.length];
    const core = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, toneMapped: false });
    const haloMat = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, toneMapped: false });
    for (let r = 0; r < rowsOf.length - 1; r += 1) {
      const a = cellCentre(r, rowsOf[r]);
      const b = cellCentre(r + 1, rowsOf[r + 1]);
      const dir = b.clone().sub(a).normalize();
      const length = a.distanceTo(b) + 0.05;
      const pair = [];
      for (const [m, thick] of [[core, 0.065], [haloMat, 0.22]]) {
        const seg = new THREE.Mesh(bar, m);
        seg.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
        seg.renderOrder = m === core ? 21 : 20;
        seg.userData = { a, dir, length, thick };
        group.add(seg);
        pair.push(seg);
      }
      group.userData.segments.push(pair);
    }
    group.visible = false;
    machine.add(group);
    return group;
  });
  /* A line is drawn as far as it paid: three in a row lights two segments, not the whole line. */
  const showLine = (index, count) => {
    const group = lineMeshes[index];
    const was = group.visible && group.userData.count === count;
    group.visible = count > 1;
    group.userData.count = count;
    if (!was) group.userData.shownAt = performance.now();
  };
  function stepLines(now) {
    for (const group of lineMeshes) {
      if (!group.visible) continue;
      const { segments, count, shownAt } = group.userData;
      const p = reduce ? count : clamp01((now - shownAt) / 420) * (count - 1);
      segments.forEach((pair, k) => {
        const local = k < count - 1 ? clamp01(p - k) : 0;
        for (const seg of pair) {
          const { a, dir, length, thick } = seg.userData;
          seg.visible = local > 0;
          seg.scale.set(Math.max(0.001, length * local), thick, thick);
          seg.position.copy(a).addScaledVector(dir, (length * local) / 2);
        }
      });
    }
  }

  // Tease: two books down, the reels still turning get a purple frame.
  const teaseFrames = reels.map((reel) => {
    const s = new THREE.Shape();
    const w = REEL_W / 2 + 0.06; const h = OPEN_H / 2; const t = 0.06;
    s.moveTo(-w, -h); s.lineTo(w, -h); s.lineTo(w, h); s.lineTo(-w, h); s.lineTo(-w, -h);
    const hole = new THREE.Path();
    hole.moveTo(-w + t, -h + t); hole.lineTo(-w + t, h - t); hole.lineTo(w - t, h - t); hole.lineTo(w - t, -h + t); hole.lineTo(-w + t, -h + t);
    s.holes.push(hole);
    const m = new THREE.Mesh(new THREE.ShapeGeometry(s), new THREE.MeshBasicMaterial({ color: SCATTER_COLOR, transparent: true, depthTest: false, toneMapped: false }));
    m.position.set(reel.x, 0, Z0 + 0.36);
    m.renderOrder = 15;
    m.visible = false;
    machine.add(m);
    return m;
  });

  /* ── particles ── */
    /** Firework stars and their trails: the game's spark sprites, burning down frame by frame. */
  const sparkAtlas = atlas(THREE, sparkImgs, 8, 8);
  function makeBursts(count, size) {
    const sprites = makeSprites(THREE, { map: sparkAtlas.map, cols: sparkAtlas.cols, rows: sparkAtlas.rows, count, additive: true });
    return {
      points: sprites.points,
      setScale: sprites.setScale,
      emit(x, y, z, vx, vy, vz, color, life, drag = 0, twinkle = false) {
        sprites.emit({ x, y, z, vx, vy, vz, r: color.r, g: color.g, b: color.b, life, drag, twinkle, gravity: -2.2, size, sizeTo: size * 0.55, frame: 0, frameTo: 7, fade: 0.45 });
      },
      step(dt) { sprites.step(dt); },
    };
  }
  const bursts = makeBursts(1400, 0.22);
  scene.add(bursts.points);
  const rockets = [];
  const trailColor = new THREE.Color(0xffb060);
  function launchRocket(delay) {
    // Fired from the floor in front of the machine, bursting across the glass where the camera is looking.
    rockets.push({
      x: (Math.random() - 0.5) * 7.5, y: FLOOR_Y + 0.3, z: 1.7 + Math.random() * 1.6,
      vy: 9 + Math.random() * 2.5, t: -delay, burstAt: 0.38 + Math.random() * 0.2,
      color: FIREWORK_COLORS[Math.floor(Math.random() * FIREWORK_COLORS.length)],
      fade: FIREWORK_COLORS[Math.floor(Math.random() * FIREWORK_COLORS.length)],
    });
  }
  function stepRockets(dt) {
    for (let i = rockets.length - 1; i >= 0; i -= 1) {
      const r = rockets[i];
      r.t += dt;
      if (r.t < 0) continue;
      r.y += r.vy * dt;
      r.vy -= 6 * dt;
      bursts.emit(r.x, r.y, r.z, (Math.random() - 0.5) * 0.4, -1, (Math.random() - 0.5) * 0.4, trailColor, 0.35);
      if (r.t >= r.burstAt) {
        const main = new THREE.Color(r.color);
        const fade = new THREE.Color(r.fade);
        const n = 110;
        for (let k = 0; k < n; k += 1) {
          // Evenly over a sphere (a Fibonacci spiral), at one speed: the round star of the game.
          const yv = 1 - (2 * (k + 0.5)) / n;
          const rr = Math.sqrt(1 - yv * yv);
          const th = k * 2.39996;
          const speed = 4.2 + Math.random() * 0.6;
          bursts.emit(r.x, r.y, r.z, Math.cos(th) * rr * speed, yv * speed, Math.sin(th) * rr * speed, k % 3 ? main : fade, 1.4 + Math.random() * 0.5, 1.6, true);
        }
        rockets.splice(i, 1);
      }
    }
  }

  // The payout out of the chute, bouncing on the floor; sizes by tier, smallest first.
  const LOOT_SIZE = [0.34, 0.36, 0.42, 0.38];
  const LOOT_SLOTS = 48;
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  const lootPools = loot.map((model, tier) => {
    const mesh = new THREE.InstancedMesh(model.geometry, model.material, LOOT_SLOTS);
    mesh.castShadow = true;
    mesh.frustumCulled = false;
    for (let i = 0; i < LOOT_SLOTS; i += 1) mesh.setMatrixAt(i, zero);
    scene.add(mesh);
    return { mesh, slots: Array.from({ length: LOOT_SLOTS }, () => ({ alive: false })), cursor: 0, size: LOOT_SIZE[tier] };
  });
  const pendingLoot = [];
  const euler = new THREE.Euler();
  function spawnLoot(tier) {
    const pool = lootPools[tier];
    const slot = pool.slots[pool.cursor];
    pool.cursor = (pool.cursor + 1) % pool.slots.length;
    Object.assign(slot, {
      alive: true, age: 0, max: 3.6 + Math.random() * 1.4, landed: false, ground: FLOOR_Y,
      x: (Math.random() - 0.5) * chuteW * 0.8, y: CHUTE_Y - 0.05, z: Z_FRAME + 0.1,
      vx: (Math.random() - 0.5) * 4.6, vy: 4 + Math.random() * 3.5, vz: 2.6 + Math.random() * 2.4,
      rot: Math.random() * 6, spin: 2 + Math.random() * 3, tilt: (Math.random() - 0.5) * 0.6,
    });
  }
  function stepLoot(dt, now) {
    while (pendingLoot.length && pendingLoot[0].at <= now) spawnLoot(pendingLoot.shift().tier);
    for (const pool of lootPools) {
      let dirty = false;
      pool.slots.forEach((s, i) => {
        if (!s.alive) return;
        dirty = true;
        s.age += dt;
        if (!s.landed) {
          s.vy -= 12 * dt;
          s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
          // The plinth stands in the way at the front; the floor everywhere else.
          const onPlinth = Math.abs(s.x) < 7 * B && s.z < Z_FRAME + 2.5 * B;
          const ground = (onPlinth ? PLINTH_Y + B / 2 : FLOOR_Y) + pool.size * 0.5;
          if (s.y < ground && s.vy < 0) {
            s.y = ground;
            if (s.vy > -1.6) { s.landed = true; s.vy = 0; s.ground = ground; } else {
              s.vy = -s.vy * 0.38; s.vx *= 0.7; s.vz *= 0.7;
            }
          }
        } else {
          // At rest it bobs and turns, as a dropped item does.
          s.x += s.vx * dt * 0.2; s.z += s.vz * dt * 0.2;
          s.vx *= 0.9; s.vz *= 0.9;
        }
        s.rot += s.spin * dt;
        const bob = s.landed ? Math.sin(s.age * 3 + s.rot) * 0.04 + 0.04 : 0;
        const k = s.age > s.max - 0.5 ? clamp01((s.max - s.age) / 0.5) : clamp01(s.age / 0.12);
        if (s.age >= s.max) s.alive = false;
        euler.set(s.landed ? 0 : s.tilt, s.rot, 0);
        quat.setFromEuler(euler);
        const sc = s.alive ? pool.size * k : 0;
        pool.mesh.setMatrixAt(i, matrix.compose(vec.set(s.x, (s.landed ? s.ground : s.y) + bob, s.z), quat, scaleV.set(sc, sc, sc)));
      });
      if (dirty) pool.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /* ── state ── */
  let modeName = 'base';
  let raf = 0;
  let last = performance.now();
  let clock = 0;
  let flash = 0;
  let lost = false;
  let landing = null; // { pending, resolve, onStop, teaseFrom }
  let lastActive = performance.now();
  let bulbMode = 'attract';
  let bulbUntil = 0;
  let shot = reduce ? 'play' : 'intro';
  let shotUntil = 0;
  let shake = 0;
  let jolt = 0;
  let flags = { auto: false, turbo: false };
  const introStart = performance.now();
  let introDone = reduce;
  let framed = false;

  /* ── the camera director ── */
  const cam = { target: new THREE.Vector3(), yaw: 0, pitch: 0, dist: 20 };
  const goal = { target: new THREE.Vector3(), yaw: 0, pitch: 0, dist: 20 };
  const drag = { on: false, x: 0, y: 0, yaw: 0, pitch: 0, baseYaw: 0, basePitch: 0, releasedAt: 0, moved: 0, id: null };
  let hoverX = 0; let hoverY = 0;
  // What the camera actually uses: the pointer and the drag, eased, so the view glides after the mouse
  // instead of stepping with every pointer event.
  const view = { hoverX: 0, hoverY: 0, yaw: 0, pitch: 0 };
  const SHOT_SET = { ...SHOTS, ...(THEME.shots || {}) };
  function frameShot(name) {
    // On a wide canvas the mobs beside the machine are in the shot.
    const s = (camera.aspect >= 1.25 && SHOT_SET[`${name}Wide`]) || SHOT_SET[name];
    const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const hw = s.hw * Math.cos(s.yaw) + s.hd * Math.abs(Math.sin(s.yaw));
    const hh = s.hh * Math.cos(s.pitch) + s.hd * Math.sin(Math.abs(s.pitch));
    const dist = (Math.max(hh / tan, hw / (tan * camera.aspect)) * 1.05 + s.hd) * s.zoom;
    goal.target.set(s.c[0], s.c[1], s.c[2]);
    goal.yaw = s.yaw;
    goal.pitch = s.pitch;
    goal.dist = dist;
  }

  /* ── pointer: drag to turn, the lever and the buttons as buttons ── */
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const hits = [
    { parts: [leverBase, stick, knob], act: () => onLever?.() },
    { parts: [spinButton.mesh], button: spinButton, act: () => onLever?.() },
    { parts: [autoButton.mesh], button: autoButton, act: () => { autoButton.press = 0; onAuto?.(); } },
    { parts: [turboButton.mesh], button: turboButton, act: () => { turboButton.press = 0; onTurbo?.(); } },
  ];
  const hitParts = hits.flatMap((h) => h.parts);
  const hitAt = (event) => {
    const b = canvas.getBoundingClientRect();
    ndc.set(((event.clientX - b.left) / b.width) * 2 - 1, -((event.clientY - b.top) / b.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const found = ray.intersectObjects(hitParts, false)[0];
    return found ? hits.find((h) => h.parts.includes(found.object)) : null;
  };
  const onMove = (event) => {
    const b = canvas.getBoundingClientRect();
    if (!b.width) return;
    hoverX = ((event.clientX - b.left) / b.width - 0.5) * 2;
    hoverY = ((event.clientY - b.top) / b.height - 0.5) * 2;
    if (drag.on && event.pointerId === drag.id) {
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      drag.moved = Math.max(drag.moved, Math.abs(dx) + Math.abs(dy));
      drag.yaw = THREE.MathUtils.clamp(drag.baseYaw - dx * 0.0042, -0.7, 0.7);
      drag.pitch = THREE.MathUtils.clamp(drag.basePitch + dy * 0.0026, -0.1, 0.36);
      return;
    }
    const hit = hitAt(event);
    hoveredButton = hit?.button ?? null;
    canvas.style.cursor = hit ? 'pointer' : 'grab';
  };
  const onLeave = () => { hoverX = 0; hoverY = 0; hoveredButton = null; };
  const onDown = (event) => {
    Object.assign(drag, { on: true, x: event.clientX, y: event.clientY, baseYaw: drag.yaw, basePitch: drag.pitch, moved: 0, id: event.pointerId });
    try { canvas.setPointerCapture(event.pointerId); } catch { /* a synthetic event has no capture */ }
    canvas.style.cursor = 'grabbing';
  };
  const onUp = (event) => {
    if (!drag.on) return;
    drag.on = false;
    drag.releasedAt = performance.now();
    canvas.style.cursor = '';
    // A press that did not travel is a click.
    if (drag.moved < 7) hitAt(event)?.act();
  };
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  const onLost = (event) => { event.preventDefault(); lost = true; controls.onLost?.(); };
  canvas.addEventListener('webglcontextlost', onLost);

  /* ── framing ── */
  let lastW = 0; let lastH = 0;
  let slowFor = 0; let fastFor = 0;
  /* Dynamic resolution: a machine that cannot hold the frame rate draws fewer pixels until it can,
   * and takes them back once it has room. Spent in quarter steps between 0.6 and the screen's own. */
  function adapt(elapsed) {
    if (elapsed > 0.5) return; // a hidden tab or a stall, not the scene's cost
    if (elapsed > 1 / 40) { slowFor += elapsed; fastFor = 0; } else if (elapsed < 1 / 55) { fastFor += elapsed; slowFor = 0; }
    let next = ratio;
    if (slowFor > 1.2 && ratio > 0.6) { next = Math.max(0.6, ratio - 0.25); slowFor = 0; }
    if (fastFor > 5 && ratio < MAX_RATIO) { next = Math.min(MAX_RATIO, ratio + 0.25); fastFor = 0; }
    // Still too slow at the lowest resolution: the glow goes before the frame rate does, then the
    // whole post chain, and the scene is drawn straight to the canvas.
    if (slowFor > 1.2 && ratio <= 0.6 && composer) {
      if (bloom?.enabled) bloom.enabled = false;
      else { composer.dispose(); composer = null; }
      slowFor = 0;
    }
    if (next !== ratio) {
      ratio = next;
      renderer.setPixelRatio(ratio);
      composer?.setPixelRatio(ratio);
      lastW = 0;
    }
  }
  function resize() {
    const w = host.clientWidth; const h = host.clientHeight;
    if (!w || !h || (w === lastW && h === lastH)) return false;
    lastW = w; lastH = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (composer) {
      composer.setPixelRatio(ratio);
      composer.setSize(w, h);
    }
    // Sprites are sized in world units: canvas pixels × the projection's focal term, halved.
    const spriteScale = (h * ratio * camera.projectionMatrix.elements[5]) / 2;
    for (const sprites of [orbSprites, bursts, ...(stage.sprites || [])]) sprites.setScale(spriteScale);
    return true;
  }

  /* ── the drums each frame ── */
  function stepReel(reel, i, dt, now) {
    if (reel.state === 'spin' || reel.state === 'approach') {
      reel.speed = Math.min(MAX_SPEED, reel.speed + ACCEL * dt);
      setAngle(reel, reel.angle + reel.speed * dt);
      if (reel.state === 'spin' && reel.landAt && now >= reel.landAt) {
        // Brake from a point exactly one braking arc before the stop, the next time the drum passes it.
        const arc = (reel.speed * reel.landTime) / (3 + BACK);
        const stop = angleFor(reel, reel.top);
        reel.startLand = reel.angle + mod(stop - arc - reel.angle, Math.PI * 2);
        reel.arc = arc;
        reel.state = 'approach';
      }
      if (reel.state === 'approach' && reel.angle >= reel.startLand) {
        reel.state = 'land';
        reel.from = reel.startLand;
        reel.to = reel.startLand + reel.arc;
        reel.dur = reel.landTime;
        reel.t0 = now - ((reel.angle - reel.startLand) / reel.speed) * 1000;
      }
    }
    if (reel.state === 'land') {
      const t = Math.min(1, (now - reel.t0) / 1000 / reel.dur);
      setAngle(reel, reel.from + (reel.to - reel.from) * easeOutBack(t));
      reel.speed = t < 1 ? ((reel.to - reel.from) * (3 + BACK) * (1 - t) ** 2) / reel.dur : 0;
      if (t >= 1) {
        setAngle(reel, angleFor(reel, reel.top));
        reel.state = 'idle';
        reel.landAt = 0;
        teaseFrames[i].visible = false;
        landed(i);
      }
    }
    reel.material.map = reel.speed > 7 ? blurred : sharp;
    if (reel.state === 'idle') {
      // Attract mode: the drums rock a little, as if someone had just let go of them.
      const sway = !reduce && shot === 'idle' ? Math.sin(clock * 0.9 + i * 0.7) * 0.045 : 0;
      reel.drum.rotation.x = reel.angle + sway;
    }
  }

  function landed(i) {
    if (!reduce) shake = Math.max(shake, 0.014);
    if (!landing) return;
    landing.onStop?.(i, reels[i].strip, reels[i].top);
    landing.pending -= 1;
    // Only the teased reels still turning: the camera leans in on them.
    if (landing.teaseFrom >= 0 && landing.pending > 0 && i === landing.teaseFrom - 1) setShot('tease', 0);
    if (landing.pending === 0) {
      const done = landing.resolve;
      landing = null;
      if (shot === 'tease') setShot(modeName === 'free' ? 'free' : 'play', 0);
      if (bulbMode === 'tease' || bulbMode === 'spin') bulbMode = modeName === 'free' ? 'free' : 'attract';
      lastActive = performance.now();
      done();
    }
  }

  function setShot(name, ms) {
    if (reduce && name !== 'play' && name !== 'free') return;
    shot = name;
    shotUntil = ms ? performance.now() + ms : 0;
  }

  /* ── the intro: the machine builds itself, bottom up, while the camera comes round ── */
  const introParts = [[ledge, 0.45], [lip, 0.5], [chuteBack, 0.5], [nose, 0.55], [shell, 0.7], [spinButton.base, 0.86], [spinButton.mesh, 0.9],
    [autoButton.base, 0.91], [autoButton.mesh, 0.95], [turboButton.base, 0.96], [turboButton.mesh, 1.0], [leverBase, 1.05], [pivot, 1.1], [marquee, 1.15], [roof, 1.3], ...(stage.crown ? [[stage.crown, 1.7]] : [])];
  function stepIntro(now) {
    const t = (now - introStart) / 1000;
    for (const { mesh, list } of blockMeshes) {
      list.forEach((b, i) => {
        const k = introDone ? 1 : easeOutBack(clamp01((t - b.delay) / 0.3));
        mesh.setMatrixAt(i, matrix.compose(vec.set(b.x, b.y + (1 - Math.min(1, k)) * 0.6, b.z), quat.identity(), scaleV.set(k, k, k)));
      });
      mesh.instanceMatrix.needsUpdate = true;
    }
    const late = (delay) => (introDone ? 1 : easeOutBack(clamp01((t - delay) / 0.35)));
    for (const [obj, delay] of introParts) {
      const k = Math.max(0.001, late(delay));
      obj.scale.setScalar((obj.userData.introScale ?? 1) * k);
    }
    for (const reel of reels) reel.drum.scale.x = Math.max(0.001, late(0.8 + Math.abs(reel.x) * 0.05));
  }
  let introSettled = reduce;
  function finishIntro() {
    if (introDone) return;
    introDone = true;
  }

  /* ── chase lights ── */
  function stepBulbs(now) {
    const t = now / 1000;
    if (bulbUntil && now > bulbUntil) { bulbUntil = 0; bulbMode = modeName === 'free' ? 'free' : 'attract'; }
    const lit = introDone ? 1 : clamp01(((now - introStart) / 1000 - 1.5) / 0.8);
    const n = bulbSpots.length;
    for (let i = 0; i < n; i += 1) {
      let on;
      let [r, g, b] = THEME.bulbs.attract;
      switch (bulbMode) {
        case 'spin': on = (i + Math.floor(t * 22)) % 3 === 0; break;
        case 'win': on = (i % 2 === 0) === (Math.floor(t * 7) % 2 === 0); break;
        case 'big': {
          on = (i + Math.floor(t * 26)) % 2 === 0;
          bulbColor.setHSL(((i / n) + t * 0.9) % 1, 1, 0.6);
          r = bulbColor.r; g = bulbColor.g; b = bulbColor.b;
          break;
        }
        case 'free': on = (i + Math.floor(t * 9)) % 4 < 2; [r, g, b] = THEME.bulbs.free; break;
        case 'tease': on = Math.sin(t * 14) > 0; [r, g, b] = THEME.bulbs.tease; break;
        default: on = (i + Math.floor(t * 6)) % 4 === 0;
      }
      if (i / n > lit) on = false;
      const k = on ? 1 : 0.13;
      bulbColor.setRGB(r * k, g * k, b * k);
      bulbs.setColorAt(i, bulbColor);
      bulbGlowCol[i * 3] = on ? r * 0.9 : 0; bulbGlowCol[i * 3 + 1] = on ? g * 0.9 : 0; bulbGlowCol[i * 3 + 2] = on ? b * 0.9 : 0;
    }
    bulbs.instanceColor.needsUpdate = true;
    bulbGlowGeo.attributes.color.needsUpdate = true;
  }

  /* ── one frame ── */
  const toHolder = new THREE.Quaternion();
  function frame() {
    raf = requestAnimationFrame(frame);
    const now = performance.now();
    const elapsed = (now - last) / 1000;
    const dt = Math.min(0.05, elapsed);
    last = now;
    // A machine nobody can see is not drawn, but its drums still finish turning -- on real time, so a
    // slow frame rate makes the spin choppier, never longer.
    const visible = host.offsetParent !== null && document.visibilityState === 'visible';
    reels.forEach((reel, i) => stepReel(reel, i, Math.min(0.25, elapsed), now));
    stepLoot(dt, now);
    if (!visible || lost) return;
    clock += dt;
    adapt(elapsed);
    const resized = resize();
    if (!introSettled) {
      stepIntro(now);
      if (introDone || (now - introStart) / 1000 > 2.4) {
        introDone = true;
        introSettled = true;
        stepIntro(now);
        if (shot === 'intro') setShot('idle', 0);
      }
    }

    // Who is the camera looking at?
    const spinning = reels.some((r) => r.state !== 'idle');
    if (shotUntil && now > shotUntil) { shotUntil = 0; shot = modeName === 'free' ? 'free' : 'play'; }
    if (introDone && !spinning && !shotUntil && modeName === 'base' && shot !== 'idle' && now - lastActive > 7000) {
      shot = 'idle';
      bulbMode = 'attract';
    }
    frameShot(shot);
    if (!framed || (resized && reduce)) {
      cam.target.copy(goal.target); cam.yaw = goal.yaw; cam.pitch = goal.pitch; cam.dist = goal.dist;
      framed = true;
    }
    const k = 1 - Math.exp(-dt * (shot === 'idle' ? 1.1 : !introSettled ? 1.2 : 2.6));
    cam.target.lerp(goal.target, k);
    cam.yaw += (goal.yaw - cam.yaw) * k;
    cam.pitch += (goal.pitch - cam.pitch) * k;
    cam.dist += (goal.dist - cam.dist) * k;
    // Drag springs back after a moment; the pointer leans the view a little; idle drifts.
    if (!drag.on && now - drag.releasedAt > 2200) {
      const back2 = 1 - Math.exp(-dt * 1.4);
      drag.yaw -= drag.yaw * back2;
      drag.pitch -= drag.pitch * back2;
    }
    // Eased toward the pointer: quick under a drag, slow for the lean of a mouse merely passing over.
    const chase = 1 - Math.exp(-dt * (drag.on ? 14 : 6));
    const lean = 1 - Math.exp(-dt * 2.2);
    view.yaw += (drag.yaw - view.yaw) * chase;
    view.pitch += (drag.pitch - view.pitch) * chase;
    view.hoverX += ((drag.on ? 0 : hoverX) - view.hoverX) * lean;
    view.hoverY += ((drag.on ? 0 : hoverY) - view.hoverY) * lean;
    const sway = reduce ? 0 : shot === 'idle' ? Math.sin(clock * 0.22) * 0.2 : Math.sin(clock * 0.31) * 0.025;
    const yaw = cam.yaw + view.yaw + sway + (reduce ? 0 : view.hoverX * 0.035);
    const pitch = cam.pitch + view.pitch + (reduce ? 0 : view.hoverY * 0.018);
    camera.position.set(
      cam.target.x + Math.sin(yaw) * Math.cos(pitch) * cam.dist,
      cam.target.y + Math.sin(pitch) * cam.dist,
      cam.target.z + Math.cos(yaw) * Math.cos(pitch) * cam.dist,
    );
    shake *= Math.exp(-dt * 3.2);
    if (shake > 0.002 && !reduce) {
      camera.position.x += Math.sin(clock * 53) * shake;
      camera.position.y += Math.sin(clock * 61 + 1) * shake * 0.7;
    }
    camera.lookAt(cam.target);

    // The lever swings forward and springs back; the machine takes the jolt.
    if (leverT >= 0) {
      leverT += dt;
      const t = leverT;
      const pull = t < 0.16 ? 1 - (1 - t / 0.16) ** 2 : 1 - easeOutBack(Math.min(1, (t - 0.16) / 0.5));
      pivot.rotation.x = LEVER_REST + 1.55 * pull;
      if (t > 0.66) { leverT = -1; pivot.rotation.x = LEVER_REST; }
    }
    jolt *= Math.exp(-dt * 9);
    machine.position.y = reduce ? 0 : -Math.abs(Math.sin(clock * 40)) * jolt * 0.05;
    for (const btn of [spinButton, autoButton, turboButton]) {
      if (btn.press >= 0) {
        btn.press += dt;
        const p = btn.press < 0.08 ? btn.press / 0.08 : 1 - clamp01((btn.press - 0.08) / 0.25);
        btn.mesh.position.y = btn.baseY - 0.06 * p;
        if (btn.press > 0.35) { btn.press = -1; btn.mesh.position.y = btn.baseY; }
      }
    }
    // Which face each button shows: disabled while the reels turn, on while its mode is, hovered.
    const faceOf = (btn, on, off) => (off ? 'off' : on ? 'on' : hoveredButton === btn ? 'hover' : 'normal');
    for (const [btn, key] of [
      [spinButton, faceOf(spinButton, false, spinning)],
      [autoButton, faceOf(autoButton, flags.auto, false)],
      [turboButton, faceOf(turboButton, flags.turbo, false)],
    ]) {
      if (btn.face !== key) { btn.face = key; btn.front.map = btn.faces[key]; }
    }
    // SPIN breathes while it waits for a press.
    spinButton.front.color.setScalar(0.82 + (!spinning && !reduce ? Math.max(0, Math.sin(clock * 3)) * 0.18 : 0));

    // Lit cells: the item lifts off the drum, turning and bobbing like a dropped item.
    for (const column of cells) {
      for (const cell of column) {
        if (!cell.lit) continue;
        cell.liftT += dt;
        const kk = easeOutBack(clamp01(cell.liftT / 0.45));
        const s = 0.8 * (cell.rest ? 0.86 : 1) * Math.max(0.001, kk);
        cell.item.scale.set(s, s, s * 1.6);
        // Lifted straight out toward the player, not along the tilted facet, so it stays in its own
        // cell and behind the glass; and stood upright, whatever row of the drum it sits on.
        const lift = 0.05 + 0.3 * kk + (reduce ? 0 : Math.sin(clock * 3 + cell.phase) * 0.03);
        cell.item.position.set(0, Math.sin(cell.b) * lift, Math.cos(cell.b) * lift);
        cell.item.rotation.set(-cell.b, reduce ? 0.3 : Math.sin(clock * 1.6 + cell.phase) * 0.4, 0);
        const pulse = 0.75 + Math.sin(clock * 6 + cell.phase) * 0.25;
        cell.frame.material.opacity = cell.rest ? 0.35 : pulse;
        cell.glow.material.opacity = cell.rest ? 0.06 : 0.2 * pulse;
        // The halo faces the camera from inside the tilted cell.
        toHolder.copy(cell.holder.quaternion).invert();
        cell.glow.quaternion.copy(toHolder).multiply(camera.quaternion);
      }
    }
    for (const frameMesh of teaseFrames) if (frameMesh.visible) frameMesh.material.opacity = 0.55 + Math.sin(clock * 10) * 0.35;
    stepLines(now);

    if (modeName === 'free') {
      glint.offset.x = (clock * 0.22) % 1;
      glint.offset.y = (clock * 0.11) % 1;
    }
    flash = Math.max(0, flash - dt * 0.8);
    lamp.color.setHex(modeName === 'free' ? L.lampFree : L.lamp);
    lamp.intensity = 9 + flash * 22;
    const lampFrame = lampFrames[Math.floor(now / THEME.lamp.frameMs) % lampFrames.length];
    if (block.lamp.map !== lampFrame) { block.lamp.map = lampFrame; block.lamp.emissiveMap = lampFrame; }
    block.lamp.emissive.setHex(modeName === 'free' ? THEME.lamp.free : THEME.lamp.emissive);
    block.lamp.emissiveIntensity = 1 + flash * 2.5 + Math.sin(clock * 2.4) * 0.2;
    marqueeFace.emissiveIntensity = 0.85 + flash * 1.5;
    for (const h of lampGlows) {
      h.material.color.setHex(modeName === 'free' ? THEME.lamp.glowFree : THEME.lamp.glow);
      h.quaternion.copy(camera.quaternion);
    }

    stepBulbs(now);
    stepRockets(dt);
    bursts.step(dt, -2.2);
    orbs.step(dt, -1.6);
    // The room, the crown, the herald and the mobs.
    stage.step(dt, now, { elapsed, clock, flash, modeName, introSettled, introDone });
    // With reduced motion nothing on the machine moves on its own, so it is drawn a few times a second.
    if (reduce && !resized && now - lastRender < 200) return;
    lastRender = now;
    if (composer) composer.render(dt);
    else renderer.render(scene, camera);
  }
  let lastRender = 0;
  // Every material compiled now, the hidden ones included, so the first win does not stall a frame.
  {
    const hidden = [];
    scene.traverse((o) => { if (!o.visible) { hidden.push(o); o.visible = true; } });
    try { renderer.compile(scene, camera); } catch { /* compiled on first use instead */ }
    for (const o of hidden) o.visible = false;
  }
  raf = requestAnimationFrame(frame);

  const controls = {
    onLost: null,

    /** Put the drums on these stops at once. */
    showStops(tops) {
      reels.forEach((reel, i) => {
        reel.top = tops[i];
        reel.state = 'idle';
        reel.speed = 0;
        reel.landAt = 0;
        setAngle(reel, angleFor(reel, tops[i]));
      });
    },

    /** Start every drum turning now, before the server has answered. */
    spinStart() {
      finishIntro();
      lastActive = performance.now();
      stage.spinStart?.();
      bulbMode = 'spin';
      bulbUntil = 0;
      setShot(modeName === 'free' ? 'free' : 'play', 0);
      if (reduce) return;
      const now = performance.now();
      reels.forEach((reel, i) => {
        if (reel.state !== 'idle') return;
        reel.state = 'spin';
        reel.landAt = 0;
        reel.speed = -2.5 - i * 0.2; // a small kick back before the drum takes off
        reel.spinSince = now;
      });
    },

    /**
     * Land on the server's stops, left to right. Resolves once the last drum is at rest.
     * `minSpin` keeps a quick answer from looking like no spin at all; `gap` spaces the stops;
     * reels after two books spin on, framed, for `tease` more seconds each.
     */
    land(tops, { minSpin = 0.55, gap = 0.22, tease = 0.7, landTime = LAND_TIME, onStop } = {}) {
      return new Promise((resolve) => {
        if (reduce) {
          controls.showStops(tops);
          tops.forEach((_, i) => onStop?.(i, reels[i].strip, tops[i]));
          resolve();
          return;
        }
        finishIntro();
        lastActive = performance.now();
        bulbMode = 'spin';
        if (shot === 'idle' || shot === 'intro') setShot(modeName === 'free' ? 'free' : 'play', 0);
        landing = { pending: reels.length, resolve, onStop, teaseFrom: -1 };
        const now = performance.now();
        let books = 0;
        let teaseFrom = -1;
        reels.forEach((reel, i) => {
          if (reel.state === 'idle') { reel.state = 'spin'; reel.speed = MAX_SPEED * 0.6; reel.spinSince = now; }
          reel.top = tops[i];
          reel.landTime = landTime;
          const since = reel.spinSince || now;
          let at = Math.max(now, since + minSpin * 1000) + i * gap * 1000;
          if (teaseFrom >= 0) {
            at += (i - teaseFrom + 1) * tease * 1000;
            teaseFrames[i].visible = true;
          }
          reel.landAt = at;
          for (let row = 0; row < 3; row += 1) if (reel.strip[(tops[i] + row) % reel.strip.length] === scatter) books += 1;
          if (books >= 2 && teaseFrom < 0 && i < reels.length - 1) teaseFrom = i + 1;
        });
        landing.teaseFrom = teaseFrom;
        if (teaseFrom >= 0) { bulbMode = 'tease'; bulbUntil = 0; }
      });
    },

    /**
     * Light the winning cells and dim the rest. `wins` is [{ line: n | 'scatter', cells: [[reel,row]] }].
     */
    highlight(wins) {
      lastActive = performance.now();
      const lit = new Map();
      for (const win of wins) {
        const color = win.line === 'scatter' ? SCATTER_COLOR : LINE_COLORS[win.line % LINE_COLORS.length];
        for (const [r, row] of win.cells) if (!lit.has(`${r}:${row}`)) lit.set(`${r}:${row}`, color);
      }
      cells.forEach((column, r) => column.forEach((cell, row) => {
        const color = lit.get(`${r}:${row}`);
        cell.lit = color !== undefined;
        cell.rest = false;
        cell.dim.visible = !cell.lit;
        cell.wash.visible = cell.frame.visible = cell.item.visible = cell.glow.visible = cell.lit;
        if (!cell.lit) return;
        cell.wash.material.color.copy(washBase).lerp(tint.setHex(color), 0.3);
        cell.frame.material.color.setHex(color);
        cell.glow.material.color.setHex(color);
        const reel = reels[r];
        const symbol = reel.strip[(reel.top + row) % reel.strip.length];
        cell.item.geometry = symbolModels[symbol].geometry;
        cell.item.material = symbolModels[symbol].material;
        cell.liftT = 0;
        cell.item.position.set(0, 0, 0.05);
        if (!reduce) {
          const p = cellCentre(r, row);
          orbs.emit(6, { x: p.x, y: p.y, z: p.z + 0.2, spread: 0.25, up: 1.6, out: 0.7, life: 1.2 });
        }
      }));
      lineMeshes.forEach((_, index) => {
        const win = wins.find((w) => w.line === index);
        showLine(index, win ? win.cells.length : 0);
      });
      bulbMode = 'win';
      bulbUntil = performance.now() + 2200;
      stage.highlight?.(wins);
    },

    /** Bring one win forward: its line alone, its cells at full strength, the other lit cells resting. */
    focus(win) {
      const mine = new Set(win.cells.map(([r, row]) => `${r}:${row}`));
      const color = win.line === 'scatter' ? SCATTER_COLOR : LINE_COLORS[win.line % LINE_COLORS.length];
      cells.forEach((column, r) => column.forEach((cell, row) => {
        if (!cell.lit) return;
        cell.rest = !mine.has(`${r}:${row}`);
        if (!cell.rest) {
          cell.frame.material.color.setHex(color);
          cell.wash.material.color.copy(washBase).lerp(tint.setHex(color), 0.3);
          cell.glow.material.color.setHex(color);
        }
      }));
      lineMeshes.forEach((_, index) => showLine(index, win.line === index ? win.cells.length : 0));
    },

    clear() {
      for (const column of cells) {
        for (const cell of column) {
          cell.lit = false;
          cell.wash.visible = cell.dim.visible = cell.frame.visible = cell.item.visible = cell.glow.visible = false;
        }
      }
      for (const group of lineMeshes) { group.visible = false; group.userData.count = 0; }
    },

    setMode(next) {
      const was = modeName;
      modeName = next;
      for (const reel of reels) reel.shine.visible = next === 'free';
      back.material.map = next === 'free' ? backFreeMap : backMap;
      back.material.color.setHex(next === 'free' ? THEME.tint.backFree : THEME.tint.back);
      bulbMode = next === 'free' ? 'free' : 'attract';
      stage.setMode?.(next, was);
      if (next === 'free') setShot('free', 0);
      else if (was === 'free') setShot('play', 0);
    },

    pull() {
      finishIntro();
      spinButton.press = 0;
      if (reduce) return;
      leverT = 0;
      jolt = 1;
    },

    /** A big win: the lamps flare, fireworks go up, the camera comes in and shakes. */
    celebrate(strength = 1) {
      flash = Math.min(1.5, 0.6 + strength * 0.3);
      bulbMode = 'big';
      bulbUntil = performance.now() + 2600 + strength * 600;
      if (reduce) return;
      setShot('big', 2400 + strength * 400);
      shake = 0.05 + strength * 0.04;
      for (let i = 0; i < 2 + strength * 2; i += 1) launchRocket(i * 0.28 + Math.random() * 0.15);
    },

    /** What a spin paid, spilled out of the chute: more, and finer, the bigger the win. */
    payout(ratio) {
      if (reduce || !(ratio > 0)) return;
      const count = Math.min(LOOT_SLOTS, Math.round(3 + Math.log2(1 + ratio) * 7));
      const now = performance.now();
      if (shot === 'play' || shot === 'idle') setShot('win', 2600);
      for (let i = 0; i < count; i += 1) {
        const roll = Math.random();
        const tier = ratio >= 15 && roll < 0.18 ? 3
          : ratio >= 15 && roll < 0.32 ? 2
            : ratio >= 3 && roll < 0.42 ? 1
              : 0;
        pendingLoot.push({ tier, at: now + i * (900 / count) + Math.random() * 40 });
      }
      pendingLoot.sort((a, b) => a.at - b.at);
    },

    /** Free spins open (or come again): the stage's herald -- the enchanting book, the Elder Guardian. */
    enchant(kind = 'enchant') {
      finishIntro();
      flash = Math.max(flash, 0.8);
      stage.enchant?.(kind);
      if (!reduce) shake = Math.max(shake, 0.03);
      bulbMode = 'free';
      bulbUntil = 0;
      setShot('free', 0);
    },

    setFlags(next) { flags = { ...flags, ...next }; },

    /** How a spin went, for the mobs beside the machine: 'win', 'big', 'free', or 'lose'. */
    react(kind, ratio) { stage.react?.(kind, ratio); },

    dispose() {
      cancelAnimationFrame(raf);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('webglcontextlost', onLost);
      renderer.dispose();
      canvas.remove();
    },
  };
  return controls;
}
