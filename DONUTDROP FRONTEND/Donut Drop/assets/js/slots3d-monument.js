/* slots3d-monument.js — the Ocean Monument's stage around the machine slots3d.js builds: the
 * guardians' temple under the sea.
 *
 * Prismarine walls and pillars lit by sea lanterns, kelp swaying up into the murk, seagrass on the
 * floor, the light of the surface rippling across it, bubbles rising. A conduit turns over the
 * crown -- its cage, its wind and its eye, as ConduitRenderer draws them -- and draws the nautilus
 * particles in. Two guardians keep the machine: one hovers beside it watching the reels, one patrols
 * behind; when a spin wins they turn on the winning cells and fire their beams at them, charging from
 * violet to gold as the game's beam does. Free spins wake the Elder Guardian: its face sweeps over the
 * screen as the game's curse does, and it rises behind the machine to watch the free spins through.
 *
 * Models and their motion are the game's own (GuardianModel, GuardianRenderer's beam,
 * ElderGuardianParticle, ConduitRenderer; mcmodels.js), on the game's textures.
 */
import {
  CONDUIT_CAGE, CONDUIT_WIND, ELDER_GUARDIAN_SCALE, GUARDIAN, buildModel, makeSprites, pixelTexture, placeEntity, poseGuardian,
} from './mcmodels.js';
import { loadImage } from './mc3d.js';

const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export async function buildMonumentStage(ctx) {
  const { THREE, scene, machine, camera, reduce, dims, kit, block, orbs, cellAt } = ctx;
  const { B, FLOOR_Y, Z_FRAME, ROOF_Y } = dims;
  const { pixel, lambert, halo, dot } = kit;
  const ROOM_BLOCKS = ['prismarine_bricks', 'dark_prismarine', 'water_still', 'kelp', 'kelp_plant', 'seagrass'];
  const ENTITY = ['guardian', 'guardian_elder', 'guardian_beam', 'conduit_cage', 'conduit_wind', 'conduit_open_eye', 'conduit_closed_eye', 'shadow'];
  const [roomImgs, entityImgs, bubbleImg, nautilusImg] = await Promise.all([
    Promise.all(ROOM_BLOCKS.map((name) => loadImage(`assets/img/block/${name}.png`))),
    Promise.all(ENTITY.map((name) => loadImage(`assets/img/entity/${name}.png`))),
    loadImage('assets/img/particle/bubble.png'),
    loadImage('assets/img/particle/nautilus.png'),
  ]);
  const img = Object.fromEntries(ROOM_BLOCKS.map((name, i) => [name, roomImgs[i]]));
  const ent = Object.fromEntries(ENTITY.map((name, i) => [name, entityImgs[i]]));
  /** Every 16-pixel frame of an animated block face, each tiled rx × ry. */
  const frames = (source, rx = 1, ry = 1) => Array.from(
    { length: Math.max(1, Math.floor((source.naturalHeight || 16) / 16)) },
    (_, f) => pixel(source, rx, ry, f),
  );

  /* ── the temple: prismarine floor and wall, pillars with sea lanterns ── */
  const WALL_Z = -7.6;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(70, 70), lambert(pixel(img.prismarine_bricks, 70 / B, 70 / B), { color: 0x5f8a84, roughness: 0.32, metalness: 0.1 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = FLOOR_Y;
  floor.receiveShadow = true;
  scene.add(floor);
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(70, 26), lambert(pixel(img.dark_prismarine, 70 / B, 26 / B), { color: 0x7a9c9c }));
  wall.position.set(0, FLOOR_Y + 13, WALL_Z);
  wall.receiveShadow = true;
  scene.add(wall);
  // The monument's columns: prismarine bricks banded in dark prismarine, a sea lantern set in each.
  const roomBlocks = [];
  for (const side of [-1, 1]) {
    for (const px of [3.2, 8.4]) {
      for (let k = 0; k < 9; k += 1) {
        roomBlocks.push({ mat: k === 0 || k === 8 ? block.band : k === 4 ? block.lamp : block.frame, x: side * px, y: FLOOR_Y + B / 2 + k * B, z: WALL_Z + B / 2 + 0.02 });
      }
    }
  }
  // Sea-lantern light in the water: cold, steady, a slow ripple from the surface on it.
  const lanternLights = [-1, 1].map((side) => {
    const l = new THREE.PointLight(0x9ffff2, 22, 14, 1.8);
    l.position.set(side * 5.8, FLOOR_Y + 2.6, WALL_Z + 1.6);
    scene.add(l);
    return l;
  });

  // The surface's light on the floor: the game's water texture, rippling, laid over it.
  const waterFrames = frames(img.water_still, 20, 20);
  const caustic = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshBasicMaterial({
    map: waterFrames[0], color: 0x1f7f8c, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  caustic.rotation.x = -Math.PI / 2;
  caustic.position.set(0, FLOOR_Y + 0.02, -1);
  scene.add(caustic);

  // Shafts of light from the surface, turned to face whoever looks.
  const shaftTex = (() => {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 256;
    const g = c.getContext('2d');
    const across = g.createLinearGradient(0, 0, 64, 0);
    across.addColorStop(0, 'rgba(255,255,255,0)');
    across.addColorStop(0.5, 'rgba(255,255,255,1)');
    across.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = across;
    g.fillRect(0, 0, 64, 256);
    g.globalCompositeOperation = 'destination-in';
    const down = g.createLinearGradient(0, 0, 0, 256);
    down.addColorStop(0, 'rgba(0,0,0,1)');
    down.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = down;
    g.fillRect(0, 0, 64, 256);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const shafts = [[-6.5, -3.5, 2.4], [-2.2, -5.2, 1.6], [2.8, -4.6, 2.0], [6.8, -2.6, 2.6], [-9.5, 0.5, 1.8], [9.6, 1.2, 1.5]].map(([x, z, w], i) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, 17), new THREE.MeshBasicMaterial({
      map: shaftTex, color: 0x7fe6f0, transparent: true, opacity: 0.1, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    m.position.set(x, FLOOR_Y + 8.5, z);
    m.userData = { phase: i * 1.7, tilt: (i % 2 ? 1 : -1) * 0.12 };
    scene.add(m);
    return m;
  });

  /* ── kelp up the walls and seagrass on the floor, both swaying, both animated as the game animates them ── */
  const PLANT = 2 * B; // a plant block: twice the machine's blocks, half a mob's
  const kelpFrames = frames(img.kelp_plant);
  const kelpTopFrames = frames(img.kelp);
  const grassFrames = frames(img.seagrass);
  const plantMat = (map) => new THREE.MeshLambertMaterial({ map, alphaTest: 0.5, side: THREE.DoubleSide, color: 0xb8d8d0 });
  const kelpMat = plantMat(kelpFrames[0]);
  const kelpTopMat = plantMat(kelpTopFrames[0]);
  const grassMat = plantMat(grassFrames[0]);
  /** Two planes crossed, `h` blocks tall, the texture repeating once a block up them. */
  const cross = (h) => {
    const g = new THREE.BufferGeometry();
    const pos = []; const uv = []; const nor = [];
    for (const a of [Math.PI / 4, -Math.PI / 4]) {
      const dx = Math.cos(a) * PLANT / 2; const dz = Math.sin(a) * PLANT / 2;
      const quad = [[-dx, 0, -dz, 0, 0], [dx, 0, dz, 1, 0], [dx, h * PLANT, dz, 1, h], [-dx, h * PLANT, -dz, 0, h]];
      for (const i of [0, 1, 2, 0, 2, 3]) {
        pos.push(quad[i][0], quad[i][1], quad[i][2]);
        uv.push(quad[i][3], quad[i][4]);
        nor.push(-dz, 0, dx);
      }
    }
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    return g;
  };
  const kelp = [];
  const KELP_AT = [[-8.6, -6.2, 9], [-7.4, -5.0, 6], [-9.8, -4.2, 11], [-6.2, -6.6, 7], [7.6, -6.0, 8], [8.9, -4.6, 10], [6.4, -5.4, 6], [10.2, -6.4, 12]];
  for (const [x, z, h] of KELP_AT) {
    const stalk = new THREE.Group();
    stalk.position.set(x, FLOOR_Y, z);
    stalk.add(new THREE.Mesh(cross(h - 1), kelpMat));
    const top = new THREE.Mesh(cross(1), kelpTopMat);
    top.position.y = (h - 1) * PLANT;
    stalk.add(top);
    stalk.userData.phase = Math.random() * 6;
    scene.add(stalk);
    kelp.push(stalk);
  }
  const GRASS = 46;
  const grass = new THREE.InstancedMesh(cross(1), grassMat, GRASS);
  {
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const v = new THREE.Vector3();
    const sc = new THREE.Vector3();
    for (let i = 0; i < GRASS; i += 1) {
      // Along the walls and out to the sides, never in front of the machine.
      let x; let z;
      do {
        x = (Math.random() - 0.5) * 24;
        z = -7 + Math.random() * 9;
      } while (Math.abs(x) < 4.6 && z > -4);
      const s = 0.7 + Math.random() * 0.5;
      grass.setMatrixAt(i, m4.compose(v.set(x, FLOOR_Y, z), q.setFromAxisAngle(sc.set(0, 1, 0), Math.random() * Math.PI), sc.set(s, s, s)));
    }
  }
  scene.add(grass);

  /* ── particles: bubbles rising, the conduit's nautilus motes ── */
  const bubbles = makeSprites(THREE, { map: pixelTexture(THREE, bubbleImg), count: 220 });
  const motes = makeSprites(THREE, { map: pixelTexture(THREE, nautilusImg), count: 90 });
  scene.add(bubbles.points, motes.points);
  const bubble = (x, y, z, { size = 0.16, up = 1.1, life = 4 } = {}) => {
    bubbles.emit({
      x, y, z, vx: (Math.random() - 0.5) * 0.15, vy: up * (0.7 + Math.random() * 0.6), vz: (Math.random() - 0.5) * 0.15,
      gravity: 0.15, drag: 0.1, life: life * (0.6 + Math.random() * 0.6), size: size * (0.7 + Math.random() * 0.6), fade: 0.25,
    });
  };
  const fizz = (at, n, spread = 0.6) => {
    for (let i = 0; i < n; i += 1) {
      bubble(at.x + (Math.random() - 0.5) * spread, at.y + (Math.random() - 0.5) * spread, at.z + (Math.random() - 0.5) * spread, { size: 0.14, up: 1.6, life: 2.2 });
    }
  };

  /* ── the crown: an active conduit, as ConduitRenderer draws one ── */
  const CROWN_Y = ROOF_Y + 1.55;
  const CP = 0.12; // a conduit pixel
  const crown = new THREE.Group();
  crown.position.set(0, CROWN_Y, Z_FRAME - B);
  crown.userData.introScale = 1;
  machine.add(crown);
  const cage = buildModel(THREE, [{
    material: new THREE.MeshStandardMaterial({ map: pixelTexture(THREE, ent.conduit_cage), alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.6, metalness: 0.1 }),
    def: CONDUIT_CAGE,
  }]);
  const cageSpin = new THREE.Group();
  cageSpin.scale.setScalar(CP);
  cageSpin.add(cage.root);
  crown.add(cageSpin);
  // The wind: a box of the animated wind texture round the cage, twice, the inner one turned over.
  const windTex = pixelTexture(THREE, ent.conduit_wind);
  const WIND_FRAMES = Math.max(1, Math.round((ent.conduit_wind.naturalHeight || 704) / 32));
  windTex.wrapS = windTex.wrapT = THREE.RepeatWrapping;
  windTex.repeat.set(1, 1 / WIND_FRAMES);
  const windMat = new THREE.MeshBasicMaterial({ map: windTex, transparent: true, depthWrite: false, side: THREE.DoubleSide, color: 0xbff8ff, opacity: 0.85 });
  const winds = [1, 0.875].map((s, i) => {
    const wind = buildModel(THREE, [{ material: windMat, def: CONDUIT_WIND }]);
    const holder = new THREE.Group();
    holder.scale.setScalar(CP * s);
    if (i === 1) holder.rotation.set(Math.PI, 0, Math.PI);
    holder.add(wind.root);
    crown.add(holder);
    return holder;
  });
  // The eye: a flat sprite that always faces the camera, open while the conduit hunts.
  const eyeOpen = pixelTexture(THREE, ent.conduit_open_eye);
  const eyeClosed = pixelTexture(THREE, ent.conduit_closed_eye);
  for (const t of [eyeOpen, eyeClosed]) { t.repeat.set(0.5, 0.5); t.offset.set(0, 0.5); }
  const eye = new THREE.Mesh(new THREE.PlaneGeometry(8 * CP * 0.667, 8 * CP * 0.667), new THREE.MeshBasicMaterial({ map: eyeClosed, alphaTest: 0.5, side: THREE.DoubleSide }));
  crown.add(eye);
  const crownGlow = halo(3.0, 0x7ff6ff, 0.4);
  crown.add(crownGlow);
  const crownWorld = new THREE.Vector3();
  const axis = new THREE.Vector3(0.5, 1, 0.5).normalize();
  let crownTurn = 0;

  /* ── guardians ── */
  const PIXEL = 0.135; // as the trader's: a guardian is two machine blocks wide and change
  const guardianMat = (source) => new THREE.MeshStandardMaterial({ map: pixelTexture(THREE, source), alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.7, metalness: 0.05, color: 0xd0d0d0 });
  const beamTex = pixelTexture(THREE, ent.guardian_beam);
  beamTex.wrapS = beamTex.wrapT = THREE.RepeatWrapping;
  /** GuardianRenderer.renderBeam: two planes crossed along the beam, 0.2 blocks out, the texture's
   * left half scrolling down it two and a half times a block, coloured by how far the attack has
   * charged; one unit long here, stretched to the target. */
  const beamGeo = (() => {
    const g = new THREE.BufferGeometry();
    const r = 0.2 * 16 * PIXEL * 0.7;
    const pos = []; const uv = [];
    for (const a of [0, Math.PI / 2]) {
      const x = Math.cos(a) * r; const z = Math.sin(a) * r;
      const quad = [[-x, 0, -z, 0.4999, 0], [x, 0, z, 0, 0], [x, 1, z, 0, 1], [-x, 1, -z, 0.4999, 1]];
      for (const i of [0, 1, 2, 0, 2, 3]) { pos.push(quad[i][0], quad[i][1], quad[i][2]); uv.push(quad[i][3], quad[i][4]); }
    }
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    return g;
  })();
  // The core's falloff across the beam: bright down the middle, nothing at the edges.
  const dotAlong = (() => {
    const c = document.createElement('canvas');
    c.width = 32; c.height = 4;
    const g = c.getContext('2d');
    const across = g.createLinearGradient(0, 0, 32, 0);
    across.addColorStop(0, 'rgba(255,255,255,0)');
    across.addColorStop(0.5, 'rgba(255,255,255,1)');
    across.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = across;
    g.fillRect(0, 0, 32, 4);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    // The beam's UVs run 0..0.5 across: stretch the falloff over that half.
    t.repeat.set(2, 1);
    return t;
  })();
  const makeBeam = () => {
    const map = beamTex.clone();
    map.needsUpdate = true;
    const mesh = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({ map, alphaTest: 0.35, side: THREE.DoubleSide, toneMapped: false, fog: false }));
    mesh.visible = false;
    mesh.frustumCulled = false;
    // A soft core under the game's two lines, so the beam reads at the size the camera sees it.
    const core = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({
      map: dotAlong, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
    }));
    core.scale.set(0.55, 1, 0.55);
    core.frustumCulled = false;
    mesh.add(core);
    scene.add(mesh);
    const flare = halo(1.4, 0xffffff, 0);
    flare.visible = false;
    scene.add(flare);
    return { mesh, map, flare };
  };
  const up = new THREE.Vector3(0, 1, 0);
  const dir = new THREE.Vector3();
  const beamColor = new THREE.Color();
  /** Lays a beam from `from` to `to`: `charge` 0..1 colours it, `time` (ticks) scrolls and turns it. */
  function aimBeam(beam, from, to, charge, time) {
    dir.subVectors(to, from);
    const length = dir.length();
    beam.mesh.position.copy(from);
    beam.mesh.quaternion.setFromUnitVectors(up, dir.normalize());
    beam.mesh.rotateY(time * 0.05 * -1.5);
    beam.mesh.scale.set(1, length, 1);
    const blocks = length / (16 * PIXEL);
    beam.map.repeat.set(1, blocks * 2.5);
    beam.map.offset.set(0, -1 + ((time * 0.5) % 1));
    const s = charge * charge;
    // The game's colour, a little over full so the bloom takes it.
    beamColor.setRGB((64 + s * 191) / 255, (32 + s * 191) / 255, (128 - s * 64) / 255).multiplyScalar(1.6);
    beam.mesh.material.color.copy(beamColor);
    beam.mesh.children[0].material.color.copy(beamColor).multiplyScalar(0.7);
    beam.mesh.visible = true;
  }

  const shadowTex = pixelTexture(THREE, ent.shadow);
  const blobShadow = (radius) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
      map: shadowTex, transparent: true, opacity: 0.35, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
    }));
    m.rotation.x = -Math.PI / 2;
    m.scale.setScalar(radius * 2 * 16 * PIXEL);
    scene.add(m);
    return m;
  };
  const CENTRE = 8 * PIXEL; // a guardian's middle sits eight model pixels over its "feet"
  function makeGuardian(source, scale, home, extra = {}) {
    const model = buildModel(THREE, [{ material: guardianMat(source), def: GUARDIAN }]);
    const body = placeEntity(THREE, model, PIXEL * scale);
    // Turned about its middle rather than its feet: a fish, not a villager.
    const pivot = new THREE.Group();
    body.position.y = -CENTRE * scale;
    pivot.add(body);
    pivot.position.copy(home);
    scene.add(pivot);
    return {
      model, pivot, scale, home: home.clone(), target: home.clone(), vel: new THREE.Vector3(),
      yaw: Math.PI / 2, pitch: 0, roll: 0, spikes: 1, flare: 0, tail: 0, tailSpeed: 0.125,
      look: null, eyeX: 0, eyeY: 0, beams: [], beam: makeBeam(), shot: null, rollStart: -1e9,
      shadow: blobShadow(0.42 * scale), nextWaypoint: performance.now() + 4000 + Math.random() * 6000, glareUntil: 0,
      ...extra,
    };
  }
  const WATCH = new THREE.Vector3(-5.5, FLOOR_Y + 3.6, -0.4);
  const watcher = makeGuardian(ent.guardian, 1, reduce ? WATCH : new THREE.Vector3(-12, FLOOR_Y + 5, 1.5));
  watcher.target.copy(WATCH);
  const patroller = makeGuardian(ent.guardian, 1, new THREE.Vector3(5.2, FLOOR_Y + 6.4, -3.6), { orbit: Math.random() * 6 });
  const guardians = [watcher, patroller];
  const REELS_AT = new THREE.Vector3(0, 0.3, 0.6);
  const eyeWorld = new THREE.Vector3();
  const local = new THREE.Vector3();
  const look = new THREE.Vector3();

  /** One guardian's frame: swim toward its target, turn to what it watches, charge and fire its beams. */
  function stepGuardian(g, dt, now, watching) {
    // Where to be: home while the machine is played, wandering its own patch of water when it is not.
    if (g === watcher) {
      if (watching || g.beams.length || g.shot) g.target.copy(WATCH);
      else if (now > g.nextWaypoint && !reduce) {
        g.target.set(-8.4 + Math.random() * 4.2, FLOOR_Y + 1.8 + Math.random() * 4, -2.5 + Math.random() * 4.5);
        g.nextWaypoint = now + 5000 + Math.random() * 7000;
      }
    } else if (!reduce && !g.shot) {
      // The patroller rounds the back of the machine, slow and wide.
      g.orbit += dt * 0.12;
      g.target.set(Math.cos(g.orbit) * 6.2, FLOOR_Y + 6.2 + Math.sin(g.orbit * 2.3) * 0.8, -3.8 + Math.sin(g.orbit) * 1.6);
    }
    const toTarget = look.subVectors(g.target, g.pivot.position);
    const dist = toTarget.length();
    const speed = g === watcher ? 1.6 : 1.1;
    const want = dist > 0.05 ? toTarget.multiplyScalar(Math.min(speed, dist * 1.4) / dist) : toTarget.set(0, 0, 0);
    g.vel.lerp(want, Math.min(1, dt * 2.2));
    g.pivot.position.addScaledVector(g.vel, dt);
    const moving = g.vel.length() > 0.25;
    // Spikes in while it swims, out when it stops (the client's spikesAnimation); a fright flares them.
    g.spikes += ((moving ? 0 : 1) - g.spikes) * Math.min(1, dt * (moving ? 5 : 1.2));
    g.flare = Math.max(0, g.flare - dt * 1.6);
    // The tail beats fast on the move, idles still (clientSideTailAnimationSpeed).
    g.tailSpeed += ((moving ? 0.5 : 0.125) - g.tailSpeed) * Math.min(1, dt * 4);
    g.tail += g.tailSpeed * dt * 20;

    // What it faces: its beam's target, what it watches, or where it is going.
    let face = null;
    if (g.shot) face = g.shot.at;
    else if (now < g.glareUntil) face = camera.position;
    else if (watching && g === watcher) face = REELS_AT;
    else if (!moving) face = g === watcher ? camera.position : REELS_AT;
    let wantYaw = g.yaw; let wantPitch = 0;
    if (face) {
      local.subVectors(face, g.pivot.position);
      wantYaw = Math.atan2(local.x, local.z);
      wantPitch = -Math.atan2(local.y, Math.hypot(local.x, local.z));
    } else if (moving) {
      wantYaw = Math.atan2(g.vel.x, g.vel.z);
      wantPitch = -Math.atan2(g.vel.y, Math.hypot(g.vel.x, g.vel.z)) * 0.6;
    }
    const turn = Math.min(1, dt * (g.shot ? 6 : 2.4));
    g.yaw += wrap(wantYaw - g.yaw) * turn;
    g.pitch += (THREE.MathUtils.clamp(wantPitch, -0.9, 0.9) - g.pitch) * turn;
    // A win's barrel roll.
    const rt = (now - g.rollStart) / 900;
    g.roll = rt >= 0 && rt < 1 ? easeInOut(rt) * Math.PI * 2 : 0;
    g.pivot.rotation.set(g.pitch, g.yaw, g.roll, 'YXZ');
    g.pivot.position.y += reduce ? 0 : Math.sin(now / 900 + (g === watcher ? 0 : 2)) * 0.002;

    // The eye follows what it faces, as GuardianModel moves the pupil across and down.
    const lookAt = face || camera.position;
    g.pivot.updateMatrixWorld();
    local.copy(lookAt);
    g.pivot.worldToLocal(local);
    const across = clamp01(Math.abs(local.x) / (Math.hypot(local.x, local.z) || 1)) * Math.sign(local.x);
    g.eyeX += (Math.sqrt(Math.abs(across)) * 2 * Math.sign(across) - g.eyeX) * Math.min(1, dt * 8);
    g.eyeY = local.y > 0 ? 0 : 1;
    poseGuardian(g.model.parts, now / 50, (1 - g.spikes) * 0.55 - g.flare * 0.3, g.eyeX, g.eyeY, g.tail);
    g.shadow.position.set(g.pivot.position.x, FLOOR_Y + 0.02, g.pivot.position.z);
    const height = g.pivot.position.y - FLOOR_Y;
    g.shadow.material.opacity = 0.4 * clamp01(1 - height / 9);

    // Beams: charge on a cell, fire, move to the next.
    if (!g.shot && g.beams.length) g.shot = { at: g.beams.shift(), t: 0, len: g.charge || 0.9 };
    if (g.shot) {
      g.shot.t += dt;
      g.model.parts.eye.getWorldPosition(eyeWorld);
      const charge = clamp01(g.shot.t / g.shot.len);
      aimBeam(g.beam, eyeWorld, g.shot.at, charge, now / 50);
      g.beam.flare.visible = true;
      g.beam.flare.position.copy(g.shot.at);
      g.beam.flare.quaternion.copy(camera.quaternion);
      g.beam.flare.material.color.copy(beamColor).multiplyScalar(0.6);
      g.beam.flare.material.opacity = 0.25 + charge * 0.5;
      if (g.shot.t >= g.shot.len) {
        // The hit: a burst of light, experience and bubbles off the cell.
        orbs.emit(5, { x: g.shot.at.x, y: g.shot.at.y, z: g.shot.at.z + 0.2, spread: 0.3, up: 1.6, out: 0.8, life: 1.2 });
        fizz(g.shot.at, 6, 0.5);
        g.shot = null;
        g.beam.mesh.visible = false;
        g.beam.flare.visible = false;
      }
    }
  }

  /* ── the Elder Guardian: risen behind the machine through the free spins, and its curse ── */
  // Behind the cabinet, off its right shoulder: over the roof, clear of the conduit and the marquee.
  const elderAt = new THREE.Vector3(4.4, ROOF_Y + 2.6, -7.2);
  const elder = makeGuardian(ent.guardian_elder, ELDER_GUARDIAN_SCALE, elderAt.clone().add(new THREE.Vector3(0, -9, 0)));
  elder.pivot.visible = false;
  elder.shadow.visible = false;
  const elderState = { shown: false, rise: 0 };
  // ElderGuardianParticle: the elder's face over the screen, sweeping down from above and fading.
  const curseModel = buildModel(THREE, [{
    material: new THREE.MeshBasicMaterial({ map: pixelTexture(THREE, ent.guardian_elder), alphaTest: 0.02, transparent: true, depthTest: false, depthWrite: false, fog: false, side: THREE.DoubleSide }),
    def: GUARDIAN,
  }]);
  const curse = new THREE.Group();
  const curseTurn = new THREE.Group();
  const curseScale = new THREE.Group();
  const curseShift = new THREE.Group();
  curseShift.add(curseModel.root);
  curseScale.add(curseShift);
  curseTurn.add(curseScale);
  curse.add(curseTurn);
  curse.visible = false;
  curse.renderOrder = 50;
  curseModel.root.traverse((o) => { o.renderOrder = 50; });
  scene.add(curse);
  let curseAt = -1e9;
  function stepCurse(now) {
    const p = (now - curseAt) / 1500; // thirty ticks
    curse.visible = p >= 0 && p < 1;
    if (!curse.visible) return;
    // Placed as ElderGuardianParticleGroup places it: in the camera's frame, turned (60 - 150p)°
    // about x, scaled 0.4255 with y and z flipped, pushed 3.5 blocks out -- at the distance our
    // narrower lens needs to show it as large as the game's does.
    const block = 16 * PIXEL;
    const lens = Math.tan(THREE.MathUtils.degToRad(35)) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    curse.position.copy(camera.position);
    curse.quaternion.copy(camera.quaternion);
    curseTurn.rotation.x = THREE.MathUtils.degToRad(60 - 150 * p);
    const k = (0.42553192 * block) / 16;
    curseScale.scale.set(k, -k, -k);
    curseShift.position.set(0, -0.56 * 16, 3.5 * 16 * lens);
    // The game fades it 0.05 + 0.5·sin(πp); a little stronger here, where it crosses a lit scene.
    curseModel.root.traverse((o) => { if (o.material) o.material.opacity = Math.min(0.9, (0.05 + 0.5 * Math.sin(p * Math.PI)) * 1.5); });
  }

  /* ── wins: who fires at what ── */
  let winCells = [];
  const cellWorld = (reel, row) => cellAt(reel, row).add(machine.position);
  function reactGuardians(kind, ratio = 0) {
    const now = performance.now();
    if (kind === 'lose') {
      // Not every miss: now and then the watcher turns its spikes out and glares at the player.
      if (Math.random() < 0.3 && !reduce) {
        watcher.glareUntil = now + 1400;
        watcher.flare = 1;
      }
      return;
    }
    watching = Math.max(watching, now + 6000);
    if (reduce) return;
    const joy = kind === 'big' ? (ratio >= 50 ? 4 : 3) : kind === 'free' ? 2 : ratio >= 5 ? 2 : ratio >= 1 ? 1 : 0;
    watcher.flare = 1;
    if (!winCells.length) return;
    const shots = [0, 1, 2, 4, 6][joy];
    const cells = winCells.slice().sort(() => Math.random() - 0.5);
    for (let i = 0; i < shots; i += 1) {
      const at = cells[i % cells.length];
      // The watcher takes the first, the patroller joins in on the big ones.
      const g = joy >= 3 && i % 2 ? patroller : watcher;
      g.charge = joy >= 3 ? 0.6 : 0.85;
      g.beams.push(at);
    }
    if (joy >= 3) {
      watcher.rollStart = now + 200;
      patroller.rollStart = now + 500;
      for (const g of guardians) fizz(g.pivot.position, 14, 1.2);
    }
    // The biggest wins wake the elder for a moment.
    if (joy >= 4) curseAt = now + 300;
  }
  let watching = 0;

  return {
    roomBlocks,
    sprites: [bubbles, motes],
    crown,

    step(dt, now, { elapsed, clock, flash, modeName, introSettled }) {
      const real = Math.min(0.25, elapsed);
      // The surface's ripple on the floor, and the light coming down through it.
      const wf = waterFrames[Math.floor(now / 100) % waterFrames.length];
      if (caustic.material.map !== wf) caustic.material.map = wf;
      caustic.material.opacity = 0.5 + Math.sin(clock * 0.7) * 0.08;
      for (const shaft of shafts) {
        shaft.rotation.set(0, Math.atan2(camera.position.x - shaft.position.x, camera.position.z - shaft.position.z), shaft.userData.tilt);
        shaft.material.opacity = reduce ? 0.08 : 0.07 + Math.sin(clock * 0.45 + shaft.userData.phase) * 0.035 + flash * 0.05;
      }
      lanternLights.forEach((l, i) => { l.intensity = 20 + Math.sin(clock * 0.9 + i * 2) * 2.5 + flash * 10; });
      // Kelp and seagrass sway and run through their frames.
      const kf = Math.floor(now / 110);
      kelpMat.map = kelpFrames[kf % kelpFrames.length];
      kelpTopMat.map = kelpTopFrames[kf % kelpTopFrames.length];
      grassMat.map = grassFrames[kf % grassFrames.length];
      if (!reduce) {
        for (const stalk of kelp) {
          stalk.rotation.z = Math.sin(clock * 0.55 + stalk.userData.phase) * 0.045;
          stalk.rotation.x = Math.sin(clock * 0.4 + stalk.userData.phase * 1.3) * 0.03;
        }
        // Bubbles up from the floor by the walls, and now and then out of the chute.
        if (Math.random() < dt * 9) {
          const side = Math.random() < 0.5 ? -1 : 1;
          bubble(side * (5 + Math.random() * 6), FLOOR_Y + 0.2, -6.5 + Math.random() * 5);
        }
        if (Math.random() < dt * 1.5) bubble((Math.random() - 0.5) * 2, dims.CHUTE_Y, Z_FRAME + 0.2, { size: 0.1, up: 0.9, life: 3 });
      }
      bubbles.step(dt);

      // The conduit turns, bobs and breathes; its eye opens while it hunts.
      const hunting = modeName === 'free' || now < watching || winCells.length > 0;
      crownTurn += dt * (reduce ? 0 : modeName === 'free' ? 0.9 : 0.35);
      const tick = now / 50;
      let bob = Math.sin(tick * 0.1) / 2 + 0.5;
      bob = bob * bob + bob;
      const lift = (-0.2 + bob * 0.2) * 16 * CP;
      cageSpin.position.y = reduce ? 0 : lift;
      cageSpin.quaternion.setFromAxisAngle(axis, crownTurn);
      const phase = Math.floor(tick / 66) % 3;
      winds[0].rotation.x = phase === 1 ? Math.PI / 2 : 0;
      winds[0].rotation.z = phase === 2 ? Math.PI / 2 : 0;
      windTex.offset.y = 1 - (1 + (Math.floor(tick) % WIND_FRAMES)) / WIND_FRAMES;
      eye.position.y = reduce ? 0 : lift;
      eye.quaternion.copy(crown.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(camera.quaternion));
      eye.material.map = hunting ? eyeOpen : eyeClosed;
      crownGlow.quaternion.copy(eye.quaternion);
      crownGlow.material.opacity = 0.3 + Math.sin(clock * 2) * 0.08 + flash * 0.3 + (modeName === 'free' ? 0.15 : 0);
      if (introSettled && !reduce && Math.random() < dt * (modeName === 'free' ? 10 : 4)) {
        // Nautilus motes drift in to the conduit from the water round it.
        crown.getWorldPosition(crownWorld);
        const a = Math.random() * Math.PI * 2;
        const r = 2 + Math.random() * 2.2;
        const from = { x: crownWorld.x + Math.cos(a) * r, y: crownWorld.y + (Math.random() - 0.4) * 2.4, z: crownWorld.z + Math.sin(a) * r };
        const life = 1.4 + Math.random() * 0.6;
        motes.emit({
          ...from, vx: (crownWorld.x - from.x) / life, vy: (crownWorld.y - from.y) / life, vz: (crownWorld.z - from.z) / life,
          life, size: 0.2, sizeTo: 0.08, fade: 0.3,
        });
      }
      motes.step(dt);

      // The guardians, on real time however slowly frames come.
      const isWatching = now < watching;
      for (const g of guardians) stepGuardian(g, real, now, isWatching);

      // The elder rises behind the machine for the free spins and sinks away after.
      elderState.rise += ((elderState.shown ? 1 : 0) - elderState.rise) * Math.min(1, real * (elderState.shown ? 1.1 : 2));
      elder.pivot.visible = elderState.rise > 0.01;
      if (elder.pivot.visible) {
        elder.target.copy(elderAt).add(look.set(0, (1 - easeInOut(clamp01(elderState.rise))) * -9, 0));
        elder.pivot.position.copy(elder.target);
        elder.spikes = 1;
        elder.tail += real * 2.5;
        local.subVectors(REELS_AT, elder.pivot.position);
        elder.yaw = Math.atan2(local.x, local.z);
        elder.pitch = -Math.atan2(local.y, Math.hypot(local.x, local.z)) * 0.6;
        elder.pivot.rotation.set(elder.pitch, elder.yaw, 0, 'YXZ');
        elder.pivot.position.y += reduce ? 0 : Math.sin(now / 1300) * 0.15;
        elder.pivot.updateMatrixWorld();
        local.copy(camera.position);
        elder.pivot.worldToLocal(local);
        const across = clamp01(Math.abs(local.x) / (Math.hypot(local.x, local.z) || 1)) * Math.sign(local.x);
        poseGuardian(elder.model.parts, tick, 0, Math.sqrt(Math.abs(across)) * 2 * Math.sign(across), local.y > 0 ? 0 : 1, elder.tail);
      }
      stepCurse(now);
    },

    spinStart() {
      watching = performance.now() + 10000;
      winCells = [];
    },

    /** The winning cells of the spin just landed: what the guardians aim at. */
    highlight(wins) {
      const seen = new Set();
      winCells = [];
      for (const win of wins) {
        for (const [reel, row] of win.cells) {
          const key = `${reel}:${row}`;
          if (seen.has(key)) continue;
          seen.add(key);
          winCells.push(cellWorld(reel, row));
        }
      }
    },

    react(kind, ratio) { reactGuardians(kind, ratio); },

    /** Free spins open (or come again): the elder's face sweeps over the screen and it rises. */
    enchant() {
      if (!reduce) curseAt = performance.now();
      elderState.shown = true;
      fizz(look.set(0, ROOF_Y, 0), 24, 3);
    },

    setMode(next, was) {
      if (next === 'free') elderState.shown = true;
      else if (was === 'free') elderState.shown = false;
    },
  };
}
