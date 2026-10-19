/* blackjack3d.js — the blackjack table in 3D: a village library's card room, and the librarian
 * dealing.
 *
 * A table of green wool rimmed in dark oak, under a lantern, between walls of bookshelves. The dealer
 * is a villager -- the librarian, in the game's own skin, plains clothes and master's badge -- on the
 * game's VillagerModel (mcmodels.js). Cards leave the shoe in front
 * of him one at a time, turning over in the air; the hole card lands face down and turns when the
 * player is done. The bet is a stack of emeralds, the currency every villager trades in: a win is
 * paid onto it from his side of the table, a loss is taken back across it.
 *
 * The cards are drawn in the game's style rather than a casino's: 40 × 56 pixels, the rank in the
 * game's own font (assets/img/gui/ascii.png), the suits as pixel shapes, an emerald on the back.
 *
 * Nothing here decides anything. blackjack.js hands it what the server dealt and waits for each card
 * to land. Every card is also in the DOM, out of sight, for a screen reader; if WebGL is missing or
 * the context is lost, blackjack.js puts the flat table back.
 */
import { reduceMotion } from './util.js';
import { getTHREE, loadImage, crop, softDot } from './mc3d.js';
import { VILLAGER, buildModel, makeSprites, pixelTexture, placeEntity } from './mcmodels.js';

const B = 0.5;                // one block
const PIXEL = B / 16;         // one model pixel
const FLOOR_Y = -B;           // the table is one block tall; its felt is y = 0
const TABLE = { w: 3.5, d: 2.0 };
const RIM = 0.22;             // the dark oak rail round the felt
const CARD = { w: 0.34, h: 0.476, t: 0.01 };
const ROW = { dealer: -0.5, player: 0.36 };
const SPACING = 0.27;         // card centre to card centre in a hand
const STACK = { x: 0.86, z: 0.44 };    // the player's bet, at his right hand
const SHOE = { x: 0.92, z: -0.64 };    // in front of the dealer, at his left hand
const DISCARD = { x: -0.95, z: -0.66 };
const DEALER = { x: 0, z: -1.3 };
const FLIGHT_MS = 480;        // shoe to seat
const DEAL_GAP_MS = 300;      // between the dealer's throws
const FLIP_MS = 420;
const SWEEP_MS = 420;
const ARMS_REST = -0.75;      // VillagerModel's folded arms

const CW = 40;                // a card's texture, in pixels
const CH = 56;
const SUIT_INK = ['#16161a', '#b3202a', '#b3202a', '#16161a']; // spades, hearts, diamonds, clubs
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
/* The four suits on a 7-pixel grid (the card's centre, drawn twice the size) and a 5-pixel one
 * (under the corner rank). */
const SUIT7 = [
  ['...#...', '..###..', '.#####.', '#######', '#######', '.#.#.#.', '..###..'],
  ['.##.##.', '#######', '#######', '#######', '.#####.', '..###..', '...#...'],
  ['...#...', '..###..', '.#####.', '#######', '.#####.', '..###..', '...#...'],
  ['..###..', '..###..', '##.#.##', '#######', '##.#.##', '...#...', '..###..'],
];
const SUIT5 = [
  ['..#..', '.###.', '#####', '..#..', '.###.'],
  ['##.##', '#####', '#####', '.###.', '..#..'],
  ['..#..', '.###.', '#####', '.###.', '..#..'],
  ['.###.', '#.#.#', '#####', '..#..', '.###.'],
];
const CROWN = ['#.#.#.#', '#######', '#######'];

const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
const easeOut = (t) => 1 - (1 - t) ** 3;
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const lerp = (a, b, t) => a + (b - a) * t;

/* The camera's shots, as in slots3d.js: a box of the scene to frame, from a yaw and a pitch. */
const SHOTS = {
  idle: { c: [0, 0.2, -0.5], hw: 1.85, hh: 0.88, yaw: 0, pitch: 0.4 },
  play: { c: [0, 0.06, -0.22], hw: 1.58, hh: 0.8, yaw: 0, pitch: 0.6 },
  win: { c: [0, 0.02, 0.08], hw: 1.32, hh: 0.7, yaw: 0, pitch: 0.68 },
};

/**
 * Builds the table into `host` and resolves with its controls, or with null when this browser
 * cannot draw it (no WebGL), in which case nothing is left behind in `host`.
 */
export async function createTable3d(host) {
  const THREE = await getTHREE();
  const probe = document.createElement('canvas');
  if (!(probe.getContext('webgl2') || probe.getContext('webgl'))) return null;
  const canvas = document.createElement('canvas');
  canvas.className = 'bj__gl';
  canvas.setAttribute('aria-hidden', 'true');
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  } catch {
    return null;
  }
  const MAX_RATIO = Math.min(1.5, devicePixelRatio || 1);
  let ratio = MAX_RATIO;
  renderer.setPixelRatio(ratio);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const ROOM = 0x140c08;
  renderer.setClearColor(ROOM, 1);

  const BLOCKS = ['dark_oak_planks', 'stripped_dark_oak_log', 'dark_oak_log', 'green_wool', 'bookshelf',
    'lantern', 'spruce_planks'];
  const ENTITY = ['villager', 'villager_plains', 'villager_librarian', 'villager_level_diamond', 'shadow'];
  let loaded;
  try {
    loaded = await Promise.all([
      Promise.all(BLOCKS.map((name) => loadImage(`assets/img/block/${name}.png`))),
      Promise.all(ENTITY.map((name) => loadImage(`assets/img/entity/${name}.png`))),
      loadImage('assets/img/items/emerald.png'),
      loadImage('assets/img/items/gold_nugget.png'),
      loadImage('assets/img/gui/ascii.png'),
      loadImage('assets/img/particle/glint.png'),
      // Bloom, against the page as mc3d.js loads three.js (see slots3d.js).
      import(/* @vite-ignore */ new URL('assets/vendor/three-addons.js', document.baseURI).href).catch(() => null),
    ]);
  } catch {
    renderer.dispose();
    return null;
  }
  const [blockImgs, entityImgs, emeraldImg, nuggetImg, fontImg, glintImg, addons] = loaded;
  const img = Object.fromEntries(BLOCKS.map((name, i) => [name, blockImgs[i]]));
  host.prepend(canvas);

  const reduce = reduceMotion();
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(ROOM);
  scene.fog = new THREE.Fog(ROOM, 6, 15);
  const camera = new THREE.PerspectiveCamera(36, 1, 0.05, 60);
  const maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  let composer = null;
  let bloom = null;
  if (addons) {
    try {
      const target = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: renderer.capabilities.isWebGL2 ? 4 : 0 });
      composer = new addons.EffectComposer(renderer, target);
      composer.addPass(new addons.RenderPass(scene, camera));
      bloom = new addons.UnrealBloomPass(new THREE.Vector2(4, 4), 0.42, 0.45, 1.35);
      composer.addPass(bloom);
      composer.addPass(new addons.OutputPass());
    } catch {
      composer = null;
      bloom = null;
    }
  }

  /* ── textures and materials ── */
  const pixel = (source, rx = 1, ry = 1, x = 0, y = 0, w = 16, h = 16) => {
    const t = crop(source, x, y, w, h);
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = maxAniso;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(rx, ry);
    return t;
  };
  const mat = (map, opts = {}) => new THREE.MeshStandardMaterial({ map, roughness: 0.85, metalness: 0.02, ...opts });
  /** A box of block faces, each face tiled to the box's own size in blocks. */
  const blockBox = (source, w, h, d, opts = {}) => {
    const faces = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]].map(([a, b]) => mat(pixel(source, a / B, b / B), opts));
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), faces);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  };
  const plane = (source, w, h, opts = {}) => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat(pixel(source, w / B, h / B), opts));
    mesh.receiveShadow = true;
    return mesh;
  };

  /* ── the game's font, for the cards and the felt ── */
  const fontCanvas = document.createElement('canvas');
  fontCanvas.width = 128;
  fontCanvas.height = 128;
  const fontG = fontCanvas.getContext('2d');
  fontG.drawImage(fontImg, 0, 0);
  const fontPixels = fontG.getImageData(0, 0, 128, 128).data;
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
  const shadowOf = (hex) => `#${[1, 3, 5].map((i) => Math.floor(parseInt(hex.slice(i, i + 2), 16) / 4).toString(16).padStart(2, '0')).join('')}`;
  const drawGrid = (g, rows, x, y, color, s = 1) => {
    g.fillStyle = color;
    rows.forEach((row, ry) => [...row].forEach((ch, rx) => { if (ch === '#') g.fillRect(x + rx * s, y + ry * s, s, s); }));
  };

  /* ── the cards ── */
  const cardBody = (g, fill, edge, shade) => {
    g.fillStyle = edge;
    g.fillRect(1, 0, CW - 2, CH);
    g.fillRect(0, 1, CW, CH - 2);
    g.fillStyle = fill;
    g.fillRect(2, 1, CW - 4, CH - 2);
    g.fillRect(1, 2, CW - 2, CH - 4);
    g.fillStyle = shade;
    g.fillRect(2, CH - 2, CW - 4, 1);
    g.fillRect(CW - 2, 2, 1, CH - 4);
  };
  const cardTexture = (c) => {
    const t = pixelTexture(THREE, c);
    t.anisotropy = maxAniso;
    return t;
  };
  const faceTextures = new Map();
  function faceTexture(face) {
    if (faceTextures.has(face)) return faceTextures.get(face);
    const rank = face % 13;
    const suit = Math.floor(face / 13);
    const ink = SUIT_INK[suit];
    const c = document.createElement('canvas');
    c.width = CW;
    c.height = CH;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    cardBody(g, '#f4efe2', '#2a2622', '#d6cfbc');
    // The corner: the rank in the game's font, the suit under it; and the same, upside down, opposite.
    const corner = document.createElement('canvas');
    corner.width = 13;
    corner.height = 15;
    const cg = corner.getContext('2d');
    const label = inkText(RANKS[rank], ink);
    cg.drawImage(label, Math.max(0, Math.floor((7 - label.width) / 2)), 0);
    drawGrid(cg, SUIT5[suit], 1, 9, ink);
    g.drawImage(corner, 3, 3);
    g.save();
    g.translate(CW - 3, CH - 3);
    g.rotate(Math.PI);
    g.drawImage(corner, 0, 0);
    g.restore();
    // The centre: the suit, twice the size, under a gold crown on a court card.
    if (rank >= 10) drawGrid(g, CROWN, 13, 13, '#d9a52a', 2);
    drawGrid(g, SUIT7[suit], 13, 21, ink, 2);
    const t = cardTexture(c);
    faceTextures.set(face, t);
    return t;
  }
  const backTexture = (() => {
    const c = document.createElement('canvas');
    c.width = CW;
    c.height = CH;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    cardBody(g, '#123d2b', '#081a12', '#0b2a1d');
    g.fillStyle = '#1b5a40';
    for (let y = 5; y < CH - 4; y += 6) for (let x = 5 + ((y / 6) % 2) * 3; x < CW - 4; x += 6) g.fillRect(x, y, 1, 1);
    g.fillStyle = '#d9a52a';
    g.fillRect(3, 3, CW - 6, 1); g.fillRect(3, CH - 4, CW - 6, 1);
    g.fillRect(3, 3, 1, CH - 6); g.fillRect(CW - 4, 3, 1, CH - 6);
    g.drawImage(emeraldImg, 12, 20, 16, 16);
    return cardTexture(c);
  })();
  const cardGeo = new THREE.BoxGeometry(CARD.w, CARD.t, CARD.h);
  const edgeMat = mat(null, { color: 0xd8d1c0, roughness: 0.9 });
  const backMat = mat(backTexture, { roughness: 0.85 });
  function makeCard(face) {
    const front = mat(face === null ? backTexture : faceTexture(face), { roughness: 0.95, color: 0xd2ccc0 });
    // BoxGeometry's faces: +x, -x, +y (the face), -y (the back), +z, -z.
    const mesh = new THREE.Mesh(cardGeo, [edgeMat, edgeMat, front, backMat, edgeMat, edgeMat]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.visible = false;
    scene.add(mesh);
    return { mesh, front, face, up: face !== null, home: new THREE.Vector3(), yaw: 0, sideways: false, flying: false };
  }
  function setFace(card, face) {
    card.face = face;
    card.front.map = faceTexture(face);
    card.front.needsUpdate = true;
  }

  /* ── the room: a library, bookshelves on every wall, dark oak underfoot ── */
  const floor = plane(img.dark_oak_planks, 16, 16, { roughness: 0.75, color: 0xb8a898 });
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = FLOOR_Y;
  scene.add(floor);
  const WALL_Z = -2.55;
  const back = plane(img.bookshelf, 12, 5, { color: 0xb0a090 });
  back.position.set(0, FLOOR_Y + 2.5, WALL_Z);
  scene.add(back);
  for (const side of [-1, 1]) {
    const wall = plane(img.bookshelf, 10, 5, { color: 0xa09080 });
    wall.rotation.y = -side * Math.PI / 2;
    wall.position.set(side * 3.9, FLOOR_Y + 2.5, 1.5);
    scene.add(wall);
    const post = blockBox(img.dark_oak_log, B, 5, B, { color: 0xc0b0a0 });
    post.position.set(side * 3.65, FLOOR_Y + 2.5, WALL_Z + B / 2);
    scene.add(post);
  }
  // A beam across the top of the back wall.
  const beam = blockBox(img.stripped_dark_oak_log, 7.8, B, B, { color: 0xb8a898 });
  beam.position.set(0, FLOOR_Y + 3.2, WALL_Z + B / 2);
  scene.add(beam);

  /* ── the table ── */
  const table = new THREE.Group();
  scene.add(table);
  const top = blockBox(img.dark_oak_planks, TABLE.w, 0.14, TABLE.d, { color: 0xc8b8a8 });
  top.position.y = -0.07;
  table.add(top);
  const felt = plane(img.green_wool, TABLE.w - 2 * RIM, TABLE.d - 2 * RIM, { roughness: 0.98, color: 0x9ccf9c });
  felt.rotation.x = -Math.PI / 2;
  felt.position.y = 0.001;
  table.add(felt);
  const rails = [
    [TABLE.w, RIM, 0, (TABLE.d - RIM) / 2], [TABLE.w, RIM, 0, -(TABLE.d - RIM) / 2],
    [RIM, TABLE.d - 2 * RIM, (TABLE.w - RIM) / 2, 0], [RIM, TABLE.d - 2 * RIM, -(TABLE.w - RIM) / 2, 0],
  ];
  for (const [w, d, x, z] of rails) {
    const rail = blockBox(img.stripped_dark_oak_log, w, 0.1, d, { color: 0xd0c0b0, roughness: 0.55 });
    rail.position.set(x, 0.05, z);
    table.add(rail);
  }
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const leg = blockBox(img.dark_oak_log, 0.22, B - 0.14, 0.22, { color: 0xb0a090 });
      leg.position.set(sx * (TABLE.w / 2 - 0.25), FLOOR_Y + (B - 0.14) / 2, sz * (TABLE.d / 2 - 0.25));
      table.add(leg);
    }
  }
  // What the felt says, in gold in the game's font, and where the cards and the bet go.
  const print = (() => {
    const S = 200; // canvas pixels a world unit
    const w = (TABLE.w - 2 * RIM) * S;
    const h = (TABLE.d - 2 * RIM) * S;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    const gold = '#ffcc55';
    const line = (text, y, scale, color) => {
      const ink = inkText(text, color);
      const shade = inkText(text, shadowOf(color));
      const x = Math.round((w - ink.width * scale) / 2);
      g.drawImage(shade, x + scale, y + scale, ink.width * scale, 8 * scale);
      g.drawImage(ink, x, y, ink.width * scale, 8 * scale);
    };
    const zToY = (z) => Math.round((z + (TABLE.d - 2 * RIM) / 2) * S);
    line('BLACKJACK PAYS 2.5X', zToY(-0.21), 3, gold);
    line('WINS PAY 1.8X - TIES PUSH - DEALER HITS SOFT 17', zToY(-0.04), 2, '#e8dcb8');
    // The betting square, dotted in gold, where the emeralds stand.
    g.fillStyle = 'rgba(255, 204, 85, .55)';
    const bx = Math.round((STACK.x + (TABLE.w - 2 * RIM) / 2) * S);
    const by = zToY(STACK.z);
    const r = 34;
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 24) g.fillRect(Math.round(bx + Math.cos(a) * r) - 2, Math.round(by + Math.sin(a) * r) - 2, 4, 4);
    const t = new THREE.CanvasTexture(c);
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.anisotropy = maxAniso;
    t.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(TABLE.w - 2 * RIM, TABLE.d - 2 * RIM), new THREE.MeshStandardMaterial({
      map: t, transparent: true, depthWrite: false, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -1,
    }));
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0.002;
    mesh.receiveShadow = true;
    return mesh;
  })();
  table.add(print);

  // The shoe: a box of dark oak with the next card showing on top.
  const shoe = blockBox(img.spruce_planks, 0.44, 0.16, 0.56, { color: 0xb8a898 });
  shoe.position.set(SHOE.x, 0.08, SHOE.z);
  table.add(shoe);
  const shoeTop = new THREE.Mesh(cardGeo, [edgeMat, edgeMat, backMat, backMat, edgeMat, edgeMat]);
  shoeTop.position.set(SHOE.x, 0.166, SHOE.z + 0.02);
  shoeTop.castShadow = true;
  table.add(shoeTop);
  const SHOE_MOUTH = new THREE.Vector3(SHOE.x, 0.2, SHOE.z + 0.06);

  /* ── the lantern over the table ── */
  const LANTERN_Y = 1.45;
  const lanternTex = (x, y, w, h) => pixel(img.lantern, 1, 1, x, y, w, h);
  const lanternGlow = { color: 0xffffff, emissive: new THREE.Color(0xffc070), emissiveIntensity: 1.6, roughness: 0.6 };
  const lantern = new THREE.Group();
  {
    const sideBody = mat(lanternTex(0, 2, 6, 7), { ...lanternGlow, emissiveMap: lanternTex(0, 2, 6, 7) });
    const capBody = mat(lanternTex(0, 9, 6, 6), { roughness: 0.6 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(6 * PIXEL, 7 * PIXEL, 6 * PIXEL), [sideBody, sideBody, capBody, capBody, sideBody, sideBody]);
    lantern.add(body);
    const capSide = mat(lanternTex(0, 0, 4, 2), { roughness: 0.6 });
    const cap = new THREE.Mesh(new THREE.BoxGeometry(4 * PIXEL, 2 * PIXEL, 4 * PIXEL), [capSide, capSide, capBody, capBody, capSide, capSide]);
    cap.position.y = 4.5 * PIXEL;
    lantern.add(cap);
    const chain = new THREE.Mesh(new THREE.BoxGeometry(1.2 * PIXEL, 1.6, 1.2 * PIXEL), new THREE.MeshStandardMaterial({ color: 0x2a2c34, roughness: 0.5, metalness: 0.6 }));
    chain.position.y = 0.8 + 5 * PIXEL;
    lantern.add(chain);
  }
  lantern.position.set(0, LANTERN_Y, -0.1);
  scene.add(lantern);
  const dot = softDot();
  const toCamera = new THREE.Vector3(0, 0, 0.3);
  const halo = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 1.4), new THREE.MeshBasicMaterial({
    map: dot, color: 0xffb860, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  }));
  halo.position.copy(lantern.position);
  scene.add(halo);

  /* ── light ── */
  scene.add(new THREE.HemisphereLight(0xffe2c0, 0x1a0e06, 0.45));
  const spot = new THREE.SpotLight(0xffc888, 17, 7, 1.05, 0.6, 1.6);
  spot.position.set(0, LANTERN_Y - 0.12, -0.1);
  spot.target.position.set(0, 0, 0.05);
  spot.castShadow = true;
  spot.shadow.mapSize.set(1024, 1024);
  spot.shadow.bias = -0.0004;
  spot.shadow.normalBias = 0.02;
  scene.add(spot, spot.target);
  const warm = new THREE.PointLight(0xff9a50, 6, 9, 1.8);
  warm.position.set(0, LANTERN_Y + 0.2, -0.4);
  scene.add(warm);
  // A cool fill from where the player sits, so the dealer's face is not lost against the shelves.
  const fill = new THREE.DirectionalLight(0xcfd8ff, 0.32);
  fill.position.set(1.5, 2.2, 4);
  scene.add(fill);

  /* ── the librarian ── */
  const skin = (im, layer) => new THREE.MeshStandardMaterial({
    map: pixelTexture(THREE, im), alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.95, color: 0xd8d0c8,
    // Each clothing layer drawn just in front of the one under it, as the game's render layers are.
    polygonOffset: layer > 0, polygonOffsetFactor: -layer, polygonOffsetUnits: -layer,
  });
  const villager = buildModel(THREE, [
    { material: skin(entityImgs[0], 0), def: VILLAGER },
    { material: skin(entityImgs[1], 1), def: VILLAGER },
    { material: skin(entityImgs[2], 2), def: VILLAGER },
    { material: skin(entityImgs[3], 3), def: VILLAGER },
  ]);
  const dealer = placeEntity(THREE, villager, PIXEL);
  dealer.position.set(DEALER.x, FLOOR_Y, DEALER.z);
  scene.add(dealer);
  const shadowTex = pixelTexture(THREE, entityImgs[4]);
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
    map: shadowTex, transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
  }));
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.012;
  blob.scale.setScalar(16 * PIXEL);
  dealer.add(blob);
  /* ── emeralds: the bet, and what a win pays onto it ── */
  const emeraldMat = new THREE.MeshStandardMaterial({ map: pixelTexture(THREE, emeraldImg), alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.3, metalness: 0.1, emissive: new THREE.Color(0x0a3a1a) });
  const nuggetMat = new THREE.MeshStandardMaterial({ map: pixelTexture(THREE, nuggetImg), alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.3, metalness: 0.6 });
  const gemGeo = new THREE.PlaneGeometry(0.21, 0.21);
  const stack = [];   // the emeralds on the bet, bottom up
  const loose = [];   // emeralds in flight: paid in, or taken away
  function gem(material = emeraldMat) {
    const mesh = new THREE.Mesh(gemGeo, material);
    mesh.castShadow = true;
    mesh.rotation.x = -Math.PI / 2;
    mesh.rotation.z = Math.random() * Math.PI * 2;
    scene.add(mesh);
    return mesh;
  }
  const stackSpot = (i) => new THREE.Vector3(
    STACK.x + Math.sin(i * 2.4) * 0.012,
    0.004 + i * 0.012,
    STACK.z + Math.cos(i * 1.7) * 0.012,
  );
  /** How many emeralds a bet is: one at the table minimum, one more for every doubling, ten at most. */
  const gemsFor = (minor, minMinor) => Math.max(1, Math.min(10, 1 + Math.round(Math.log2(Math.max(1, Number(minor) / Math.max(1, Number(minMinor)))))));
  let tableMin = 100000;
  function setStack(count, animate) {
    while (stack.length > count) scene.remove(stack.pop());
    while (stack.length < count) {
      const mesh = gem();
      const at = stackSpot(stack.length);
      mesh.position.copy(at);
      if (animate && !reduce) {
        mesh.visible = false;
        loose.push({ mesh, from: at.clone().setY(at.y + 0.5), to: at, start: performance.now() + stack.length * 40, dur: 260, keep: true, hideUntilStart: true });
      }
      stack.push(mesh);
    }
  }

  /* ── particles: the happy-villager glint ── */
  const happy = makeSprites(THREE, { map: pixelTexture(THREE, glintImg), count: 120 });
  scene.add(happy.points);
  function sparkle(at, n, spread = 0.35, up = 0.6) {
    if (reduce) return;
    for (let i = 0; i < n; i += 1) {
      happy.emit({
        x: at.x + (Math.random() - 0.5) * spread, y: at.y + Math.random() * 0.2, z: at.z + (Math.random() - 0.5) * spread,
        vx: (Math.random() - 0.5) * 0.3, vy: up * (0.5 + Math.random()), vz: (Math.random() - 0.5) * 0.3,
        gravity: -0.4, drag: 0.6, life: 0.9 + Math.random() * 0.6, size: 0.07, sizeTo: 0.035, fade: 0.4,
      });
    }
  }

  /* ── the hands ── */
  const seats = { player: [], dealer: [] };
  const flights = []; // a card on its way somewhere: { card, from, start, dur, flipFrom, flipTo, resolve, discard }
  let queueEnd = 0;
  const gesture = { at: -1e9, target: new THREE.Vector3(SHOE.x, 0, SHOE.z) };
  function layout(which) {
    const row = seats[which];
    const widths = row.map((card) => (card.sideways ? CARD.h : CARD.w) + (SPACING - CARD.w));
    const total = widths.reduce((sum, w) => sum + w, 0) - (SPACING - CARD.w);
    let x = -total / 2;
    row.forEach((card, i) => {
      const w = card.sideways ? CARD.h : CARD.w;
      card.home.set(x + w / 2, 0.006 + i * 0.0025, ROW[which] + (card.sideways ? 0.02 : 0));
      card.yaw = card.sideways ? Math.PI / 2 : (i % 2 ? 0.035 : -0.03);
      x += widths[i];
    });
  }
  function place(card) {
    card.mesh.position.copy(card.home);
    card.mesh.rotation.set(0, card.yaw, card.up ? 0 : Math.PI);
    card.mesh.visible = true;
  }
  function removeAll() {
    for (const which of ['player', 'dealer']) {
      for (const card of seats[which]) { scene.remove(card.mesh); card.front.dispose(); }
      seats[which] = [];
    }
    for (const f of flights.splice(0)) f.resolve?.();
    for (const l of loose.splice(0)) if (!l.keep) scene.remove(l.mesh);
  }

  /* ── the camera ── */
  const goal = { target: new THREE.Vector3(), yaw: 0, pitch: 0, dist: 6 };
  const cam = { target: new THREE.Vector3(0, 0, 0), yaw: 0, pitch: 0.5, dist: 6 };
  let shot = 'idle';
  let shotUntil = 0;
  let framed = false;
  const drag = { on: false, x: 0, y: 0, yaw: 0, pitch: 0, baseYaw: 0, basePitch: 0, id: null };
  let hoverX = 0; let hoverY = 0;
  const view = { hoverX: 0, hoverY: 0 };
  function frameShot(name) {
    const s = SHOTS[name];
    const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    /* A phone held upright is taller than the table is wide: framing the whole width there leaves
     * the cards small under a sky of bookshelves. It crops the table's ends instead, from higher. */
    const narrow = camera.aspect < 0.9;
    const hw = s.hw * (narrow ? 0.66 : 1);
    const dist = Math.max(s.hh / tan, hw / (tan * camera.aspect)) * 1.08;
    goal.target.set(s.c[0], s.c[1] - (narrow ? 0.06 : 0), s.c[2] + (narrow ? 0.12 : 0));
    goal.yaw = s.yaw;
    goal.pitch = s.pitch + (narrow ? 0.2 : 0);
    goal.dist = dist;
  }
  function setShot(name, ms = 0) {
    if (reduce && name === 'win') return;
    shot = name;
    shotUntil = ms ? performance.now() + ms : 0;
  }
  const onMove = (event) => {
    const b = canvas.getBoundingClientRect();
    if (!b.width) return;
    hoverX = ((event.clientX - b.left) / b.width - 0.5) * 2;
    hoverY = ((event.clientY - b.top) / b.height - 0.5) * 2;
    if (drag.on && event.pointerId === drag.id) {
      drag.yaw = THREE.MathUtils.clamp(drag.baseYaw - (event.clientX - drag.x) * 0.004, -0.6, 0.6);
      drag.pitch = THREE.MathUtils.clamp(drag.basePitch + (event.clientY - drag.y) * 0.0025, -0.25, 0.3);
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

  /* ── framing and resolution ── */
  let lastW = 0; let lastH = 0;
  let slowFor = 0; let fastFor = 0;
  function adapt(elapsed) {
    if (elapsed > 0.5) return;
    if (elapsed > 1 / 40) { slowFor += elapsed; fastFor = 0; } else if (elapsed < 1 / 55) { fastFor += elapsed; slowFor = 0; }
    let next = ratio;
    if (slowFor > 1.2 && ratio > 0.6) { next = Math.max(0.6, ratio - 0.25); slowFor = 0; }
    if (fastFor > 5 && ratio < MAX_RATIO) { next = Math.min(MAX_RATIO, ratio + 0.25); fastFor = 0; }
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
    happy.setScale((h * ratio * camera.projectionMatrix.elements[5]) / 2);
    return true;
  }

  /* ── the dealer, each frame ── */
  const npc = { headYaw: 0, headPitch: 0, nod: 0, nodUntil: 0, shake: 0, shakeUntil: 0, hop: 0, hopUntil: 0, hopStart: 0, arms: 0 };
  const headWorld = new THREE.Vector3();
  const lookPoint = new THREE.Vector3();
  function stepDealer(now, dt, clock) {
    const head = villager.parts.head;
    // Who he looks at: the card he just threw, else the player.
    const recent = now - gesture.at < 900;
    if (recent) lookPoint.copy(gesture.target);
    else lookPoint.copy(camera.position).lerp(toCamera, 0.35);
    head.getWorldPosition(headWorld);
    const dx = lookPoint.x - headWorld.x; const dy = lookPoint.y - headWorld.y; const dz = lookPoint.z - headWorld.z;
    const yaw = THREE.MathUtils.clamp(Math.atan2(dx, dz), -1.0, 1.0);
    const pitch = THREE.MathUtils.clamp(Math.atan2(-dy, Math.hypot(dx, dz)), -0.4, 0.75);
    const k = Math.min(1, dt * (recent ? 9 : 4));
    npc.headYaw += (yaw - npc.headYaw) * k;
    npc.headPitch += (pitch - npc.headPitch) * k;
    const nod = now < npc.nodUntil ? Math.sin((now / 1000) * 16) * 0.3 : 0;
    const shake = now < npc.shakeUntil ? Math.sin((now / 1000) * 20) * 0.35 : 0;
    // The model is turned upside down about x, so its head's yaw runs the other way.
    head.rotation.y = -(npc.headYaw + shake);
    head.rotation.x = npc.headPitch + nod;
    // The throw: the folded arms dip toward the shoe and come back.
    const t = (now - gesture.at) / 320;
    const dip = t >= 0 && t < 1 ? Math.sin(t * Math.PI) : 0;
    villager.parts.arms.rotation.x = ARMS_REST - dip * 0.42 + (reduce ? 0 : Math.sin(clock * 1.7) * 0.015);
    villager.parts.body.rotation.x = -dip * 0.06;
    // A hop for a blackjack: the house paying out in style.
    const h = now < npc.hopUntil ? Math.abs(Math.sin(((now - npc.hopStart) / 1000) * Math.PI * 2.6)) * 0.12 : 0;
    dealer.position.y = FLOOR_Y + h;
    blob.position.y = 0.012 - h;
    blob.scale.setScalar(16 * PIXEL * (1 - h * 1.5));
  }

  /* ── one frame ── */
  let raf = 0;
  let last = performance.now();
  let clock = 0;
  let lastRender = 0;
  const tmp = new THREE.Vector3();
  function stepFlights(now) {
    for (let i = flights.length - 1; i >= 0; i -= 1) {
      const f = flights[i];
      const t = (now - f.start) / f.dur;
      if (t < 0) continue;
      const card = f.card;
      if (!card.mesh.visible) {
        card.mesh.visible = true;
        if (f.thrown) { gesture.at = now; gesture.target.copy(card.home); }
      }
      const k = clamp01(t);
      const e = f.kind === 'flip' ? easeInOut(k) : easeOut(k);
      const to = f.discard ? f.to : card.home;
      tmp.lerpVectors(f.from, to, e);
      tmp.y += Math.sin(k * Math.PI) * (f.kind === 'flip' ? 0.12 : f.discard ? 0.16 : 0.2);
      card.mesh.position.copy(tmp);
      card.mesh.rotation.set(0, lerp(f.yawFrom, f.discard ? f.yawTo : card.yaw, e), lerp(f.flipFrom, f.flipTo, f.kind === 'flip' ? e : easeInOut(clamp01(k * 1.25 - 0.1))));
      if (t >= 1) {
        flights.splice(i, 1);
        card.flying = false;
        if (f.discard) { scene.remove(card.mesh); card.front.dispose(); } else place(card);
        f.resolve?.();
      }
    }
    // Every card at rest eases to its place, so a hand re-centres as it grows.
    for (const which of ['player', 'dealer']) {
      for (const card of seats[which]) {
        if (card.flying || !card.mesh.visible) continue;
        card.mesh.position.lerp(card.home, reduce ? 1 : 0.2);
        card.mesh.rotation.y += (card.yaw - card.mesh.rotation.y) * (reduce ? 1 : 0.2);
      }
    }
    for (let i = loose.length - 1; i >= 0; i -= 1) {
      const l = loose[i];
      const t = (now - l.start) / l.dur;
      if (t < 0) { l.mesh.visible = !l.hideUntilStart; continue; }
      l.mesh.visible = true;
      const k = clamp01(t);
      tmp.lerpVectors(l.from, l.to, easeOut(k));
      tmp.y += Math.sin(k * Math.PI) * (l.arc ?? 0.25);
      l.mesh.position.copy(tmp);
      if (t >= 1) {
        loose.splice(i, 1);
        l.mesh.position.copy(l.to);
        if (!l.keep) scene.remove(l.mesh);
        l.done?.();
      }
    }
  }
  function frame() {
    raf = requestAnimationFrame(frame);
    const now = performance.now();
    const elapsed = (now - last) / 1000;
    const dt = Math.min(0.05, elapsed);
    last = now;
    // The cards still land on real time when nobody can see the table, so a hand is never stuck.
    stepFlights(now);
    const visible = host.offsetParent !== null && document.visibilityState === 'visible';
    if (!visible || lost) return;
    clock += dt;
    adapt(elapsed);
    const resized = resize();
    if (shotUntil && now > shotUntil) { shotUntil = 0; shot = 'play'; }
    frameShot(shot);
    if (!framed || reduce) {
      cam.target.copy(goal.target); cam.yaw = goal.yaw; cam.pitch = goal.pitch; cam.dist = goal.dist;
      framed = true;
    } else {
      const k = Math.min(1, dt * 2.2);
      cam.target.lerp(goal.target, k);
      cam.yaw += (goal.yaw - cam.yaw) * k;
      cam.pitch += (goal.pitch - cam.pitch) * k;
      cam.dist += (goal.dist - cam.dist) * k;
    }
    if (!drag.on) { drag.yaw *= 0.96; drag.pitch *= 0.96; }
    view.hoverX += (hoverX - view.hoverX) * Math.min(1, dt * 3);
    view.hoverY += (hoverY - view.hoverY) * Math.min(1, dt * 3);
    const yaw = cam.yaw + drag.yaw + (reduce ? 0 : view.hoverX * 0.06 + Math.sin(clock * 0.21) * 0.025);
    const pitch = cam.pitch + drag.pitch + (reduce ? 0 : view.hoverY * 0.03);
    camera.position.set(
      cam.target.x + Math.sin(yaw) * Math.cos(pitch) * cam.dist,
      cam.target.y + Math.sin(pitch) * cam.dist,
      cam.target.z + Math.cos(yaw) * Math.cos(pitch) * cam.dist,
    );
    camera.lookAt(cam.target);
    stepDealer(now, dt, clock);
    // The lantern breathes, as a flame does.
    const flicker = reduce ? 1 : 1 + Math.sin(clock * 7.3) * 0.04 + Math.sin(clock * 13.1) * 0.03;
    spot.intensity = 17 * flicker;
    warm.intensity = 6 * flicker;
    halo.lookAt(camera.position);
    halo.material.opacity = 0.5 * flicker;
    happy.step(dt);
    if (reduce && !resized && now - lastRender < 200 && !flights.length && !loose.length) return;
    lastRender = now;
    if (composer) composer.render(dt);
    else renderer.render(scene, camera);
  }
  {
    // Every material compiled now, so the first card does not stall a frame.
    try { renderer.compile(scene, camera); } catch { /* compiled on first use instead */ }
  }
  raf = requestAnimationFrame(frame);

  const controls = {
    onLost: null,

    /** The table's smallest stake, which sizes one emerald. */
    setLimits(minStakeMinor) { tableMin = Number(minStakeMinor) || tableMin; },

    /** Lay a hand down at once: arriving mid-hand, or a hand already over. */
    setHands({ player = [], dealer: dealerCards = [], doubled = false }) {
      removeAll();
      player.forEach((face, i) => {
        const card = makeCard(face);
        card.sideways = doubled && i === 2;
        seats.player.push(card);
      });
      dealerCards.forEach((face) => seats.dealer.push(makeCard(face)));
      layout('player');
      layout('dealer');
      for (const card of [...seats.player, ...seats.dealer]) place(card);
      setShot(player.length ? 'play' : 'idle');
    },

    /** The bet on the table, as emeralds. */
    setBet(onTableMinor, animate = true) {
      setStack(onTableMinor ? gemsFor(onTableMinor, tableMin) : 0, animate);
    },

    /**
     * The dealer throws one card from the shoe to a seat: face up, or face down (face null) for his
     * hole card. Throws are spaced as a dealer spaces them; resolves when this one lands.
     */
    deal(which, face, { delay = 0, sideways = false } = {}) {
      const now = performance.now();
      const start = Math.max(now + delay, queueEnd);
      queueEnd = start + (reduce ? 0 : DEAL_GAP_MS);
      const card = makeCard(face);
      card.sideways = sideways;
      card.flying = true;
      seats[which].push(card);
      layout(which);
      setShot('play');
      return new Promise((resolve) => {
        flights.push({
          kind: 'deal', card, thrown: true, from: SHOE_MOUTH.clone(), start, dur: reduce ? 1 : FLIGHT_MS,
          yawFrom: 0.5, flipFrom: Math.PI, flipTo: face === null ? Math.PI : 0, resolve,
        });
      });
    },

    /** Turns the dealer's card at `index` over to show `face`. */
    flip(index, face) {
      const card = seats.dealer[index];
      if (!card) return Promise.resolve();
      setFace(card, face);
      card.up = true;
      card.flying = true;
      gesture.at = performance.now();
      gesture.target.copy(card.home);
      return new Promise((resolve) => {
        flights.push({
          kind: 'flip', card, from: card.home.clone(), start: performance.now(), dur: reduce ? 1 : FLIP_MS,
          yawFrom: card.yaw, flipFrom: Math.PI, flipTo: 0, resolve,
        });
      });
    },

    /** Clears the felt for the next hand: the cards into the discard, the emeralds off the table. */
    collect() {
      const cards = [...seats.player, ...seats.dealer];
      seats.player = [];
      seats.dealer = [];
      queueEnd = 0;
      const gems = stack.splice(0);
      for (const mesh of gems) loose.push({ mesh, from: mesh.position.clone(), to: new THREE.Vector3(STACK.x, 0.3, TABLE.d / 2 + 0.4), start: performance.now(), dur: reduce ? 1 : 300, arc: 0.1 });
      if (!cards.length) return Promise.resolve();
      const now = performance.now();
      return Promise.all(cards.map((card, i) => new Promise((resolve) => {
        card.flying = true;
        flights.push({
          kind: 'sweep', card, discard: true, from: card.mesh.position.clone(),
          to: new THREE.Vector3(DISCARD.x + (Math.random() - 0.5) * 0.04, 0.02 + i * 0.004, DISCARD.z + (Math.random() - 0.5) * 0.04),
          start: now + (reduce ? 0 : i * 45), dur: reduce ? 1 : SWEEP_MS, yawFrom: card.mesh.rotation.y, yawTo: 0.2,
          flipFrom: card.mesh.rotation.z, flipTo: Math.PI, resolve,
        });
      })));
    },

    /**
     * How the hand went: 'win', 'lose' or 'push', with `blackjack` for a natural. A win is paid onto
     * the stack from the dealer's side; a loss goes back across the table to him.
     */
    result(tone, { blackjack = false, animate = true } = {}) {
      const now = performance.now();
      const at = new THREE.Vector3(STACK.x, 0.1, STACK.z);
      if (tone === 'win') {
        const paid = Math.max(1, Math.round(stack.length * (blackjack ? 1.5 : 0.8)));
        for (let i = 0; i < paid; i += 1) {
          const mesh = gem(blackjack && i % 3 === 2 ? nuggetMat : emeraldMat);
          const to = stackSpot(stack.length);
          stack.push(mesh);
          if (!animate || reduce) { mesh.position.copy(to); continue; }
          mesh.position.set(DEALER.x, 0.35, DEALER.z + 0.3);
          mesh.visible = false;
          loose.push({ mesh, from: new THREE.Vector3(DEALER.x + (Math.random() - 0.5) * 0.3, 0.35, DEALER.z + 0.35), to, start: now + 200 + i * 70, dur: 420, keep: true, hideUntilStart: true, arc: 0.35 });
        }
        if (animate) {
          npc.nodUntil = now + 900;
          setTimeout(() => sparkle(at, blackjack ? 26 : 12), 300);
          if (blackjack) { npc.hopStart = now; npc.hopUntil = now + 1400; }
          setShot('win', 2600);
        }
      } else if (tone === 'lose') {
        const gems = stack.splice(0);
        gems.forEach((mesh, i) => {
          if (!animate || reduce) { scene.remove(mesh); return; }
          loose.push({ mesh, from: mesh.position.clone(), to: new THREE.Vector3(DEALER.x + 0.15, 0.25, DEALER.z + 0.25), start: now + 250 + i * 50, dur: 460, arc: 0.3 });
        });
        if (animate) npc.shakeUntil = now + 700;
      } else if (animate) {
        npc.nodUntil = now + 450;
      }
    },

    /** Everything off the table at once. */
    clear() {
      removeAll();
      setStack(0, false);
      setShot('idle');
    },

    dispose() {
      cancelAnimationFrame(raf);
      for (const f of flights.splice(0)) f.resolve?.();
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
