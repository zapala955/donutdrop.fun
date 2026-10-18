/* slots3d-bastion.js — Ore Rush's stage around the machine slots3d.js builds: a bastion vault of
 * blackstone and gold with lava falling behind it, the Nether Star turning over the crown, the
 * enchanting book that opens free spins (the game's BookModel, its runes flying in), and the
 * wandering trader with his llama beside the machine, cheering its wins.
 *
 * Everything is the game's: block faces, the trader's and llama's skins on their own models
 * (mcmodels.js), the glint and angry-villager particles, the Standard Galactic glyphs.
 */
import { BOOK, VILLAGER, buildModel, llamaModel, makeSprites, pixelTexture, placeEntity, poseBook } from './mcmodels.js';
import { crop, loadImage, makeSparks } from './mc3d.js';

const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const mod = (a, n) => ((a % n) + n) % n;

export async function buildBastionStage(ctx) {
  const { THREE, scene, machine, camera, reduce, dims, kit, block, orbs } = ctx;
  const { B, FLOOR_Y, Z_FRAME, ROOF_Y } = dims;
  const { pixel, lambert, halo, dot, itemModel } = kit;
  const ROOM_BLOCKS = ['polished_blackstone', 'blackstone', 'lava_flow', 'lava_still'];
  const ENTITY = ['wandering_trader', 'llama_creamy', 'trader_llama', 'enchanting_table_book', 'shadow'];
  const [roomImgs, starImg, entityImgs, glyphImgs, glintImg, angryImg] = await Promise.all([
    Promise.all(ROOM_BLOCKS.map((name) => loadImage(`assets/img/block/${name}.png`))),
    loadImage('assets/img/items/nether_star.png'),
    Promise.all(ENTITY.map((name) => loadImage(`assets/img/entity/${name}.png`))),
    Promise.all([...'abcdefghijklmnopqrstuvwxyz'].map((c) => loadImage(`assets/img/particle/sga_${c}.png`))),
    loadImage('assets/img/particle/glint.png'),
    loadImage('assets/img/particle/angry.png'),
  ]);
  const img = Object.fromEntries(ROOM_BLOCKS.map((name, i) => [name, roomImgs[i]]));

  /* ── the room: a bastion vault, lava falling behind the machine ── */
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(70, 70), lambert(pixel(img.polished_blackstone, 70 / B, 70 / B), { color: 0xaaa0b4, roughness: 0.3, metalness: 0.18 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = FLOOR_Y;
  floor.receiveShadow = true;
  scene.add(floor);
  const WALL_Z = -7.6;
  const LAVA_X = 9.4;
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(70, 26), lambert(pixel(img.blackstone, 70 / B, 26 / B), { color: 0x9a8f9a }));
  wall.position.set(0, FLOOR_Y + 13, WALL_Z);
  wall.receiveShadow = true;
  scene.add(wall);
  // Gold-banded pillars along the wall, as a bastion has them.
  const roomBlocks = [];
  for (const side of [-1, 1]) {
    for (const px of [3.2, 8.4]) {
      for (let k = 0; k < 9; k += 1) {
        roomBlocks.push({ mat: k === 0 || k === 5 ? block.accent : k % 2 ? block.base : block.frame, x: side * px, y: FLOOR_Y + B / 2 + k * B, z: WALL_Z + B / 2 + 0.02 });
      }
    }
  }
  const lavaFrame = crop(img.lava_flow, 0, 0, 32, 32);
  lavaFrame.wrapS = lavaFrame.wrapT = THREE.RepeatWrapping;
  lavaFrame.repeat.set(2, 11);
  [-1, 1].forEach((side) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 14), new THREE.MeshBasicMaterial({ map: lavaFrame, color: new THREE.Color(0xd89a68).multiplyScalar(1.7) }));
    m.position.set(side * LAVA_X, FLOOR_Y + 7, WALL_Z + 0.03);
    scene.add(m);
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(6, 15), new THREE.MeshBasicMaterial({
      map: dot, color: 0xff6a1a, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    glow.position.set(side * LAVA_X, FLOOR_Y + 6.5, WALL_Z + 0.06);
    scene.add(glow);
  });
  const poolFrames = Array.from({ length: Math.max(1, Math.floor((img.lava_still.naturalHeight || 320) / 16)) }, (_, f) => {
    const t = crop(img.lava_still, 0, f * 16, 16, 16);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(5, 3);
    return t;
  });
  const pools = [-1, 1].map((side) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 1.9), new THREE.MeshBasicMaterial({ map: poolFrames[0], color: 0xffc090 }));
    m.rotation.x = -Math.PI / 2;
    m.position.set(side * LAVA_X, FLOOR_Y + 0.012, WALL_Z + 1.0);
    scene.add(m);
    return m;
  });
  const lavaLights = [-1, 1].map((side) => {
    const l = new THREE.PointLight(0xff5a14, 40, 15, 1.8);
    l.position.set(side * LAVA_X, FLOOR_Y + 1.6, WALL_Z + 1.6);
    scene.add(l);
    return l;
  });
  const embers = makeSparks(160, 0xff8a33, 0.1);
  const sparkle = makeSparks(60, 0xfff4b0, 0.09);
  scene.add(embers.points, sparkle.points);

  /* ── the crown: a Nether Star turning over the roof ── */
  const starModel = itemModel(starImg);
  const star = new THREE.Mesh(starModel.geometry, starModel.material);
  star.scale.setScalar(1.05);
  star.userData.introScale = 1.05;
  const STAR_Y = ROOF_Y + 1.5;
  star.position.set(0, STAR_Y, Z_FRAME - B);
  star.castShadow = true;
  machine.add(star);
  const starGlow = halo(3.2, 0xfff2b0, 0.55);
  starGlow.position.copy(star.position);
  machine.add(starGlow);

  /* ── the enchanting book that opens free spins (the game's BookModel), and the runes flying into it ── */
  const bookModel = buildModel(THREE, [{
    material: new THREE.MeshStandardMaterial({ map: pixelTexture(THREE, entityImgs[3]), alphaTest: 0.5, side: THREE.DoubleSide, roughness: 1, color: 0xc8c0d0 }),
    def: BOOK,
  }]);
  const book = new THREE.Group();
  const BOOK_Y = STAR_Y - 0.35; // where the star turns, which shrinks away while the book is out
  book.position.set(0, BOOK_Y, Z_FRAME - B + 0.7);
  // Its pages open toward +x; turned to the camera and tipped a little toward it, since it floats above.
  const bookTilt = new THREE.Group();
  bookTilt.rotation.z = -0.35;
  const bookPixels = new THREE.Group();
  bookPixels.scale.setScalar(0.11);
  bookPixels.add(bookModel.root);
  bookTilt.add(bookPixels);
  book.add(bookTilt);
  const bookGlow = halo(3.6, 0xa060ff, 0.35);
  book.add(bookGlow);
  // In front of the book and below it: it lights the marquee and reels violet, not its own pages.
  const bookLight = new THREE.PointLight(0xa060ff, 0, 7, 2);
  bookLight.position.set(0, -1.4, 1.2);
  book.add(bookLight);
  book.visible = false;
  book.scale.setScalar(0.001);
  machine.add(book);
  const bookState = { open: 0, target: 0, shown: false, flipAt: 0 };
  let bookFlip = 0;

  // Runes: the enchanting table's own glyph particles, the Standard Galactic alphabet.
  const glyphTex = glyphImgs.map((im) => pixelTexture(THREE, im));
  const glyphs = Array.from({ length: 40 }, (_, i) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.24, 0.24), new THREE.MeshBasicMaterial({
      map: glyphTex[i % glyphTex.length], color: 0xd8c0ff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    }));
    m.visible = false;
    scene.add(m);
    return { mesh: m, life: 0, from: new THREE.Vector3(), mid: new THREE.Vector3() };
  });
  let glyphUntil = 0;
  let glyphNext = 0;
  const bookWorld = new THREE.Vector3();
  function spawnGlyph() {
    const g = glyphs.find((x) => x.life <= 0);
    if (!g) return;
    const a = Math.random() * Math.PI * 2;
    g.from.set(Math.cos(a) * (3 + Math.random() * 3), FLOOR_Y + 1 + Math.random() * 5, 1 + Math.sin(a) * 2.5);
    g.mid.set(g.from.x * 0.4, g.from.y + 2.2, g.from.z + 1);
    g.life = 1;
    g.mesh.visible = true;
  }
  function stepGlyphs(dt, now) {
    if (now < glyphUntil && now >= glyphNext && !reduce) {
      spawnGlyph();
      glyphNext = now + 35;
    }
    book.getWorldPosition(bookWorld);
    for (const g of glyphs) {
      if (g.life <= 0) continue;
      g.life -= dt / 1.25;
      if (g.life <= 0) { g.mesh.visible = false; continue; }
      const t = 1 - g.life;
      // A quadratic curve from where it rose to the book, accelerating in.
      const u = t * t;
      g.mesh.position.set(
        (1 - u) * (1 - u) * g.from.x + 2 * (1 - u) * u * g.mid.x + u * u * bookWorld.x,
        (1 - u) * (1 - u) * g.from.y + 2 * (1 - u) * u * g.mid.y + u * u * bookWorld.y,
        (1 - u) * (1 - u) * g.from.z + 2 * (1 - u) * u * g.mid.z + u * u * bookWorld.z,
      );
      g.mesh.quaternion.copy(camera.quaternion);
      g.mesh.material.opacity = Math.min(1, t * 4) * Math.min(1, g.life * 3);
    }
  }
  function stepBook(dt, now) {
    if (!bookState.shown && book.scale.x <= 0.002) { book.visible = false; return; }
    book.visible = true;
    const s = book.scale.x + ((bookState.shown ? 1 : 0) - book.scale.x) * Math.min(1, dt * 5);
    book.scale.setScalar(Math.max(0.001, s));
    bookState.open += (bookState.target - bookState.open) * Math.min(1, dt * 3);
    book.position.y = BOOK_Y + (reduce ? 0 : Math.sin(now / 520) * 0.1);
    // It turns to face the camera the way the enchanting table's book follows the player.
    const face = Math.atan2(camera.position.x - book.position.x, camera.position.z - book.position.z);
    book.rotation.set(0, face - Math.PI / 2, 0);
    // EnchantTableRenderer's page turning: two leaves a quarter of a flip apart.
    if (!reduce) bookFlip += dt * (now < glyphUntil ? 1.2 : 0.4);
    const frac = (x) => x - Math.floor(x);
    const right = clamp01(frac(bookFlip + 0.25) * 1.6 - 0.3);
    const left = clamp01(frac(bookFlip + 0.75) * 1.6 - 0.3);
    poseBook(bookModel.parts, now / 50, right, left, bookState.open);
    bookGlow.quaternion.copy(book.quaternion).invert().multiply(camera.quaternion);
    bookLight.intensity = 2.2 * book.scale.x;
    bookGlow.material.opacity = 0.3 * book.scale.x * (0.8 + Math.sin(now / 300) * 0.2);
  }

  /* ── the wandering trader and his llama ── */
  const PIXEL = 0.135; // one model pixel: the trader stands about as tall as the cabinet's window and marquee
  // A touch under full albedo: the llama's cream wool would otherwise sit above the bloom threshold.
  const entityMat = (im, color = 0xc8c8c8) => new THREE.MeshStandardMaterial({ map: pixelTexture(THREE, im), alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.95, color });
  // The round shadow the game puts under every mob (misc/shadow.png), radius in blocks.
  const shadowTex = pixelTexture(THREE, entityImgs[4]);
  const blobShadow = (radius) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
      map: shadowTex, transparent: true, opacity: 0.6, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
    }));
    m.rotation.x = -Math.PI / 2;
    m.position.y = 0.015;
    m.scale.setScalar(radius * 2 * 16 * PIXEL);
    return m;
  };
  const trader = buildModel(THREE, [{ material: entityMat(entityImgs[0]), def: VILLAGER }]);
  const traderBody = placeEntity(THREE, trader, PIXEL);
  const HOME = new THREE.Vector3(-4.7, FLOOR_Y, 0.5);
  const WANDER = { x0: -7.9, x1: -4.6, z0: -1.4, z1: 2.9 };
  // He walks in from the left while the machine builds itself.
  traderBody.position.set(reduce ? HOME.x : -11.5, FLOOR_Y, reduce ? HOME.z : 2.2);
  const traderShadow = blobShadow(0.5);
  traderBody.add(traderShadow);
  scene.add(traderBody);
  const llama = buildModel(THREE, [
    { material: entityMat(entityImgs[1], 0xb4aea8), def: llamaModel(0) },
    { material: entityMat(entityImgs[2], 0xc4c4c4), def: llamaModel(0.5) },
  ]);
  const llamaBody = placeEntity(THREE, llama, PIXEL);
  const llamaShadow = blobShadow(0.7);
  llamaBody.add(llamaShadow);
  llamaBody.position.set(reduce ? -7.2 : -14, FLOOR_Y, reduce ? -0.6 : 1.4);
  scene.add(llamaBody);
  const npc = {
    state: reduce ? 'idle' : 'walk', target: HOME.clone(), yaw: Math.PI / 2, limb: 0, amount: 0,
    headYaw: 0, headPitch: 0, nod: 0, shake: 0, watchUntil: 0, nextWander: performance.now() + 14000,
    // A win's celebration: how many hops, how high, how many turns on the spot, arms up or not.
    party: { start: 0, until: 0, hops: 0, height: 0, turns: 0, arms: false, joy: 0, burst: 0 }, arm: 0,
  };
  const pet = { yaw: Math.PI / 2, limb: 0, amount: 0, headYaw: 0, headPitch: 0, look: 'trader', nextLook: 0, hopsUntil: 0, hopStart: 0 };
  const happy = makeSprites(THREE, { map: pixelTexture(THREE, glintImg), count: 90 });
  const angry = makeSprites(THREE, { map: pixelTexture(THREE, angryImg), count: 12 });
  scene.add(happy.points, angry.points);
  const headWorld = new THREE.Vector3();
  const lookPoint = new THREE.Vector3();
  const REELS_AT = new THREE.Vector3(0, 0.3, 0.6);
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const follow = new THREE.Vector3();

  /** Steps a body toward `target`; true once it is there. */
  function walk(body, state, target, speed, dt) {
    const dx = target.x - body.position.x;
    const dz = target.z - body.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.08) { state.amount = Math.max(0, state.amount - dt * 4); return true; }
    const step = Math.min(dist, speed * dt);
    body.position.x += (dx / dist) * step;
    body.position.z += (dz / dist) * step;
    state.yaw += wrap(Math.atan2(dx, dz) - state.yaw) * Math.min(1, dt * 7);
    state.amount = Math.min(1, state.amount + dt * 4);
    return false;
  }
  /** Turns a head toward a point, within what a neck allows, eased. */
  function lookTowards(head, body, state, point, dt, limit = 1.15) {
    head.getWorldPosition(headWorld);
    const dx = point.x - headWorld.x; const dy = point.y - headWorld.y; const dz = point.z - headWorld.z;
    const yaw = THREE.MathUtils.clamp(wrap(Math.atan2(dx, dz) - state.yaw), -limit, limit);
    const pitch = THREE.MathUtils.clamp(Math.atan2(-dy, Math.hypot(dx, dz)), -0.55, 0.65);
    const k = Math.min(1, dt * 5);
    state.headYaw += (yaw - state.headYaw) * k;
    state.headPitch += (pitch - state.headPitch) * k;
  }
  function cheer(n, spread = 1.3) {
    trader.parts.head.getWorldPosition(headWorld);
    for (let i = 0; i < n; i += 1) {
      happy.emit({
        x: headWorld.x + (Math.random() - 0.5) * spread, y: headWorld.y + 0.7 + Math.random() * 1.4, z: headWorld.z + (Math.random() - 0.5) * spread,
        vy: 0.2, life: 1.2 + Math.random() * 0.8, size: 0.22, fade: 0.4,
      });
    }
  }
  function reactNpc(kind, ratio = 0) {
    const now = performance.now();
    if (kind === 'lose') {
      // Not every miss: a trader who shakes his head at every spin is a nag.
      if (Math.random() < 0.35) {
        npc.shake = 1.1;
        if (Math.random() < 0.4) {
          trader.parts.head.getWorldPosition(headWorld);
          angry.emit({ x: headWorld.x, y: headWorld.y + 1.7, z: headWorld.z, vy: 0.3, life: 1.1, size: 0.3, fade: 0.4 });
        }
      }
      return;
    }
    npc.watchUntil = Math.max(npc.watchUntil, now + 6000);
    if (reduce) return;
    // How excited: a win that paid back less than the stake gets a nod, a big one a dance.
    const joy = kind === 'big' ? (ratio >= 50 ? 4 : 3) : kind === 'free' ? 2 : ratio >= 5 ? 2 : ratio >= 1 ? 1 : 0;
    const PARTY = [
      { hops: 0, height: 0, turns: 0, arms: false, ms: 1100, glints: 5 },
      { hops: 1, height: 0.35, turns: 0, arms: true, ms: 1400, glints: 8 },
      { hops: 2, height: 0.45, turns: 0, arms: true, ms: 2000, glints: 14 },
      { hops: 3, height: 0.6, turns: 1, arms: true, ms: 3200, glints: 22 },
      { hops: 5, height: 0.75, turns: 2, arms: true, ms: 4600, glints: 30 },
    ][joy];
    // A smaller win never cuts a bigger celebration short.
    if (now < npc.party.until && npc.party.joy > joy) return;
    npc.party = { start: now, until: now + PARTY.ms, hops: PARTY.hops, height: PARTY.height, turns: PARTY.turns, arms: PARTY.arms, joy, burst: 0 };
    npc.nod = PARTY.ms / 1000;
    cheer(PARTY.glints);
    if (joy >= 3) {
      // The llama catches it too.
      pet.hopStart = now;
      pet.hopsUntil = now + (joy >= 4 ? 2600 : 1500);
    }
  }
  /** The trader's celebration, frame by frame: hops, a turn on the spot, arms thrown up. */
  function stepParty(now) {
    const party = npc.party;
    const t = (now - party.start) / 1000;
    const on = now < party.until;
    let hop = 0;
    const HOP = 0.42;
    if (on && t < party.hops * HOP) {
      hop = Math.sin(((t % HOP) / HOP) * Math.PI) * party.height;
      // Every landing throws a few more glints; the big ones a fountain of experience orbs.
      const landed = Math.floor(t / HOP);
      if (landed > party.burst) {
        party.burst = landed;
        cheer(Math.ceil(party.hops * 1.5));
        if (party.joy >= 3) {
          trader.parts.head.getWorldPosition(headWorld);
          orbs.emit(party.joy >= 4 ? 10 : 6, { x: headWorld.x, y: headWorld.y + 0.4, z: headWorld.z, spread: 0.4, up: 2.2, out: 1.1, life: 1.4 });
        }
      }
    }
    const turnTime = 0.7 * party.turns;
    const spin = on && party.turns && t < turnTime ? easeInOut(t / turnTime) * Math.PI * 2 * party.turns : 0;
    npc.arm += ((on && party.arms ? 1 : 0) - npc.arm) * 0.18;
    return { hop, spin, pump: on && party.arms ? Math.sin(t * 13) : 0, t, on };
  }
  function stepNpc(dt, now) {
    // The trader: home while the machine is played, wandering his patch of floor when it is not.
    const watching = now < npc.watchUntil;
    if (npc.state === 'walk') {
      if (walk(traderBody, npc, npc.target, 1.25, dt)) {
        npc.state = 'idle';
        npc.nextWander = now + 7000 + Math.random() * 8000;
      }
    } else {
      npc.amount = Math.max(0, npc.amount - dt * 4);
      if (!watching && !reduce && now > npc.nextWander) {
        npc.target.set(WANDER.x0 + Math.random() * (WANDER.x1 - WANDER.x0), FLOOR_Y, WANDER.z0 + Math.random() * (WANDER.z1 - WANDER.z0));
        npc.state = 'walk';
      }
      // Standing: he turns his shoulders toward what he watches -- the reels, or whoever is playing.
      const toward = watching ? REELS_AT : camera.position;
      const want = Math.atan2(toward.x - traderBody.position.x, toward.z - traderBody.position.z);
      npc.yaw += wrap(want - npc.yaw) * Math.min(1, dt * (watching ? 2.5 : 0.8)) * 0.7;
    }
    const party = stepParty(now);
    traderBody.rotation.y = npc.yaw + party.spin;
    traderBody.position.y = FLOOR_Y + party.hop;
    // The shadow stays on the floor and shrinks under him, as the game draws it.
    traderShadow.position.y = 0.015 - party.hop;
    traderShadow.scale.setScalar(16 * PIXEL * (1 - party.hop * 0.4));
    npc.limb += dt * 11 * npc.amount;
    const swing = Math.cos(npc.limb * 0.6662) * 1.4 * npc.amount * 0.5;
    // In the air his legs tuck, a little apart.
    trader.parts.rightLeg.rotation.x = swing - party.hop * 0.9;
    trader.parts.leftLeg.rotation.x = -swing - party.hop * 0.9;
    trader.parts.rightLeg.rotation.z = party.hop * 0.35;
    trader.parts.leftLeg.rotation.z = -party.hop * 0.35;
    // Celebrating, he looks at whoever won; otherwise at the reels while they turn.
    lookTowards(trader.parts.head, traderBody, npc, party.on || !watching ? lookPoint.copy(camera.position) : REELS_AT, dt);
    npc.nod = Math.max(0, npc.nod - dt);
    npc.shake = Math.max(0, npc.shake - dt);
    const head = trader.parts.head;
    head.rotation.y = -npc.headYaw;
    head.rotation.x = npc.headPitch + (npc.nod > 0 ? Math.sin(now / 1000 * 18) * 0.32 : 0) + (npc.shake > 0 ? 0.4 : 0) - npc.arm * 0.25;
    // VillagerModel's "no": the head rolls side to side.
    head.rotation.z = npc.shake > 0 ? 0.3 * Math.sin(now / 1000 * 9) : 0;
    // A small breath, so he never stands like a statue. Celebrating, his folded arms bounce out in
    // front of him; raised any higher, the villager's one arm piece would cover his face.
    trader.parts.arms.rotation.x = -0.75 + Math.sin(now / 900) * 0.03 - npc.arm * (0.85 + party.pump * 0.45);

    // The llama keeps a couple of blocks off the trader's far side, out from behind him as the camera sees it.
    follow.set(traderBody.position.x - 2.1, FLOOR_Y, traderBody.position.z + 0.6);
    const far = Math.hypot(follow.x - llamaBody.position.x, follow.z - llamaBody.position.z) > 1.1;
    if (far || pet.amount > 0.05) {
      if (walk(llamaBody, pet, follow, 1.3, dt)) pet.amount = Math.max(0, pet.amount - dt * 4);
    }
    // Never inside the trader: if the two come too close, the llama gives way.
    const gapX = llamaBody.position.x - traderBody.position.x;
    const gapZ = llamaBody.position.z - traderBody.position.z;
    const gap = Math.hypot(gapX, gapZ);
    if (gap < 1.9 && gap > 0.001) {
      llamaBody.position.x += (gapX / gap) * (1.9 - gap);
      llamaBody.position.z += (gapZ / gap) * (1.9 - gap);
    }
    // The llama's hops: front legs up first, a buck.
    const llamaT = (now - pet.hopStart) / 1000;
    const llamaHop = now < pet.hopsUntil ? Math.abs(Math.sin(llamaT * Math.PI / 0.5)) * 0.4 : 0;
    llamaBody.position.y = FLOOR_Y + llamaHop;
    llamaShadow.position.y = 0.015 - llamaHop;
    llamaShadow.scale.setScalar(1.4 * 16 * PIXEL * (1 - llamaHop * 0.4));
    llama.root.rotation.x = Math.PI + llamaHop * 0.35;
    llamaBody.rotation.y = pet.yaw;
    pet.limb += dt * 10 * pet.amount;
    const leg = Math.cos(pet.limb * 0.6662) * 1.4 * pet.amount;
    llama.parts.rightHindLeg.rotation.x = leg;
    llama.parts.leftHindLeg.rotation.x = -leg;
    llama.parts.rightFrontLeg.rotation.x = -leg;
    llama.parts.leftFrontLeg.rotation.x = leg;
    if (now > pet.nextLook) {
      pet.look = ['trader', 'camera', 'reels', 'camera'][Math.floor(Math.random() * 4)];
      pet.nextLook = now + 2500 + Math.random() * 3500;
    }
    if (pet.look === 'trader') trader.parts.head.getWorldPosition(lookPoint);
    else if (pet.look === 'reels') lookPoint.copy(REELS_AT);
    else lookPoint.copy(camera.position);
    lookTowards(llama.parts.head, llamaBody, pet, lookPoint, dt, 0.9);
    llama.parts.head.rotation.y = -pet.headYaw;
    llama.parts.head.rotation.x = pet.headPitch * 0.6 + (reduce ? 0 : Math.sin(now / 1300) * 0.04);
    happy.step(dt);
    angry.step(dt);
  }

  return {
    roomBlocks,
    sprites: [happy, angry],
    crown: star,

    /** One frame of the room, the crown, the book and the trader. */
    step(dt, now, { elapsed, clock, flash, introSettled, introDone }) {
      // The room: lava runs, the pools churn, the light breathes.
      lavaFrame.offset.y = mod(lavaFrame.offset.y + dt * 0.35, 1);
      const pf = poolFrames[Math.floor(clock * 6) % poolFrames.length];
      for (const p of pools) p.material.map = pf;
      lavaLights.forEach((l, i) => { l.intensity = 34 + Math.sin(clock * 3.1 + i * 2) * 6 + Math.sin(clock * 7.7 + i) * 3; });
      if (!reduce && Math.random() < dt * 14) {
        const side = Math.random() < 0.5 ? -1 : 1;
        embers.emit(1, { x: side * LAVA_X, y: FLOOR_Y + 0.1, z: WALL_Z + 1.0, spread: 1.2, up: 0.6, out: 0.25, life: 4.5 });
      }
      embers.step(dt, 0.18);

      // The Nether Star turns over the crown and now and then sheds a spark.
      star.rotation.y = reduce ? 0.4 : clock * 1.3;
      star.position.y = STAR_Y + (reduce ? 0 : Math.sin(clock * 1.7) * 0.12);
      if (introSettled) {
        // The book takes the star's place over the crown while free spins run.
        const want = bookState.shown ? 0.001 : 1.05;
        star.scale.setScalar(star.scale.x + (want - star.scale.x) * Math.min(1, dt * 6));
        starGlow.visible = !bookState.shown;
      }
      starGlow.position.y = star.position.y;
      starGlow.quaternion.copy(camera.quaternion);
      starGlow.material.opacity = 0.45 + Math.sin(clock * 2.3) * 0.12 + flash * 0.3;
      if (!reduce && introDone && Math.random() < dt * 3) sparkle.emit(1, { x: 0, y: star.position.y, z: star.position.z, spread: 0.4, up: 0.3, out: 0.5, life: 1.4 });
      sparkle.step(dt, -0.2);

      stepGlyphs(dt, now);
      stepBook(dt, now);
      // The trader walks in real time, however slowly frames come.
      stepNpc(Math.min(0.25, elapsed), now);
    },

    spinStart() {
      // The trader comes back to watch.
      npc.watchUntil = performance.now() + 10000;
      if (traderBody.position.distanceTo(HOME) > 0.6 && !reduce) { npc.target.copy(HOME); npc.state = 'walk'; }
    },

    /** How a spin went: 'win', 'big', 'free' -- a nod, a hop, a dance -- or 'lose'. */
    react(kind, ratio) { reactNpc(kind, ratio); },

    /** Free spins open (or come again): the book rises, opens and pulls the runes in. */
    enchant(kind) {
      bookState.shown = true;
      bookState.target = 0.85;
      bookState.flipAt = performance.now();
      glyphUntil = performance.now() + (kind === 'retrigger' ? 900 : 2000);
    },

    setMode(next, was) {
      if (next === 'free') {
        bookState.shown = true;
        bookState.target = 0.85;
      } else if (was === 'free') {
        bookState.target = 0;
        bookState.shown = false;
      }
    },
  };
}
