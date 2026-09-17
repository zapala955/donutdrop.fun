/* hero3d.js — the home hero, as a live scene instead of a bobbing PNG.
 *
 * The CSS version was a flat chest render with six item sprites floating on
 * keyframes around it. That reads as a sticker sheet, because every sprite is
 * always in front: nothing ever passes BEHIND the subject, which is the single
 * cue that tells an eye it is looking at depth rather than at layers.
 *
 * So the items ride real elliptical orbits, each tilted off the others' plane,
 * and the chest occludes them for half of every lap. That one fact does more
 * work than any amount of shading.
 *
 * The chest breathes on a slow cycle — opens, holds, shuts — and puffs a few
 * sparks each time, so the hero has a beat without ever demanding attention.
 * The camera drifts on its own and leans a few degrees toward the pointer, which
 * is enough parallax to feel responsive and little enough to never be in the way.
 */
import { reduceMotion } from './util.js';
import {
  getTHREE, loadImage, blockTex, makeSparks, buildChest,
} from './mc3d.js';

/* which items ride the orbits, and where */
const ORBIT = [
  { file: 'nether_star.png', r: 2.05, y: 1.35, tilt: 0.20, spd: 0.20, size: 0.80 },
  { file: 'diamond.png', r: 1.75, y: 0.30, tilt: -0.26, spd: 0.26, size: 0.70 },
  { file: 'totem.png', r: 2.30, y: 0.85, tilt: 0.11, spd: 0.17, size: 0.78 },
  { file: 'elytra.png', r: 1.95, y: 1.55, tilt: -0.14, spd: 0.23, size: 0.86 },
  { file: 'gold_ingot.png', r: 2.40, y: 0.15, tilt: 0.30, spd: 0.15, size: 0.66 },
  { file: 'god_apple.png', r: 1.70, y: 1.05, tilt: -0.34, spd: 0.29, size: 0.72 },
];

const IMGDIR = 'assets/img/items/';
const CYCLE = 9.0;               // seconds for one open-hold-shut breath
const OPEN = -1.45;              // lid angle when open: a right angle, as in game

export async function mountHero3d(host) {
  const THREE = await getTHREE();

  const canvas = document.createElement('canvas');
  canvas.className = 'hero__gl';
  canvas.setAttribute('aria-hidden', 'true');
  host.appendChild(canvas);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  // fill-bound scenes: past 1.5 the extra pixels cost more than they show
  renderer.setPixelRatio(Math.min(1.5, devicePixelRatio || 1));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 60);
  const LOOK = new THREE.Vector3(0, 0.55, 0);
  camera.position.set(0, 1.32, 6.9);
  camera.lookAt(LOOK);

  scene.add(new THREE.HemisphereLight(0x9dc4e0, 0x11201a, 1.0));
  const key = new THREE.DirectionalLight(0xffffff, 1.25);
  key.position.set(3.5, 6, 6);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x2ee88a, 0.55);
  rim.position.set(-4.5, 1.5, -3);
  scene.add(rim);
  const lamp = new THREE.PointLight(0x2ee88a, 2.0, 9, 2);
  lamp.position.set(0, 1.4, 1.6);
  scene.add(lamp);
  const fill = new THREE.DirectionalLight(0xd8ecff, 0.7);
  fill.position.set(-1.5, 1.2, 6);
  scene.add(fill);

  /* a small plinth, so the chest stands on something */
  /* Purpur and crying obsidian are both violet blocks, and the palette has no
     violet in it. Gilded blackstone and polished blackstone are the same dark
     rock with gold veining — the plinth keeps its weight and loses the hue. */
  const [gildedImg, stoneImg] = await Promise.all([
    loadImage('assets/img/block/gilded_blackstone.png'),
    loadImage('assets/img/block/polished_blackstone.png'),
  ]);
  const cube = new THREE.BoxGeometry(1, 1, 1);
  const gilded = new THREE.MeshLambertMaterial({ map: blockTex(gildedImg), color: 0xffc86a });
  const stone = new THREE.MeshLambertMaterial({ map: blockTex(stoneImg) });
  const plinth = new THREE.Group();
  for (let x = -1; x <= 1; x++) {
    for (let z = -1; z <= 1; z++) {
      const edge = Math.abs(x) + Math.abs(z) === 2;   // the four corners
      const m = new THREE.Mesh(cube, edge ? gilded : stone);
      m.position.set(x, -0.5, z);
      plinth.add(m);
    }
  }
  plinth.scale.setScalar(0.62);
  scene.add(plinth);

  const { group: chest, hinge } = await buildChest('assets/img/block/chest_ender.png', 1.5);
  chest.position.y = 0.02;
  scene.add(chest);

  const sparks = makeSparks(90, 0x64f5b0, 0.1);
  scene.add(sparks.points);

  /* the orbiting items — real billboards on real paths, not layered sprites */
  const loader = new THREE.TextureLoader();
  const orbs = ORBIT.map((o, i) => {
    const mat = new THREE.MeshLambertMaterial({
      transparent: true, alphaTest: 0.35, side: THREE.DoubleSide, emissive: 0x0c1a14,
    });
    loader.load(IMGDIR + o.file, (t) => {
      t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter;
      t.colorSpace = THREE.SRGBColorSpace;
      mat.map = t; mat.needsUpdate = true;
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(o.size, o.size), mat);
    scene.add(mesh);
    return { ...o, mesh, phase: (i / ORBIT.length) * Math.PI * 2 };
  });

  /* The orbit carried a tooltip that named whichever item was nearest, with its rarity and its
   * value. It is gone: on a hero whose job is to be looked at rather than read, three lines of
   * text chasing a moving object is the one thing in the frame that demands attention, and it
   * demanded it from the item art it was sitting on top of. The orbit is decoration now, which is
   * what it was always for — the real names, rarities and values live on the crate pages, where a
   * player is actually deciding something. */

  /* ── state ── */
  const reduce = reduceMotion();
  let clock = 0, raf = 0, last = performance.now();
  let px = 0, py = 0, tx = 0, ty = 0;      // pointer parallax, smoothed
  let lastCycle = -1;

  const onMove = (e) => {
    const b = host.getBoundingClientRect();
    if (!b.width) return;
    tx = ((e.clientX - b.left) / b.width - 0.5) * 2;
    ty = ((e.clientY - b.top) / b.height - 0.5) * 2;
  };
  const onLeave = () => { tx = 0; ty = 0; };
  host.addEventListener('pointermove', onMove);
  host.addEventListener('pointerleave', onLeave);

  let lastW = 0, lastH = 0;
  function resize() {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h || (w === lastW && h === lastH)) return;
    lastW = w; lastH = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function frame() {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    clock += dt;
    resize();

    /* the breath: open over the first fifth, hold, shut over the last fifth */
    const c = (clock % CYCLE) / CYCLE;
    const lid = c < 0.18 ? Math.pow(c / 0.18, 0.6)
      : c < 0.74 ? 1
        : c < 0.9 ? 1 - Math.pow((c - 0.74) / 0.16, 2)
          : 0;
    hinge.rotation.x = OPEN * lid;

    // one puff of sparks each time it comes open, rather than a constant stream
    const cyc = Math.floor(clock / CYCLE);
    if (cyc !== lastCycle && c > 0.18) {
      lastCycle = cyc;
      sparks.emit(26, { y: 0.9, spread: 0.55, up: 1.5, out: 0.7, life: 2.4 });
    }
    if (Math.random() < dt * 6) sparks.emit(1, { y: 0.3, spread: 1.5, up: 0.5, out: 0.15, life: 2.6 });
    sparks.step(dt, -0.22);

    lamp.intensity = 1.5 + lid * 2.2;

    chest.rotation.y = reduce ? 0.5 : clock * 0.22;
    plinth.rotation.y = chest.rotation.y;

    // the orbits: each on its own tilted ring, so they cross in front of and
    // behind the chest instead of hovering around it
    for (const o of orbs) {
      const a = o.phase + (reduce ? 0 : clock * o.spd);
      o.mesh.position.set(
        Math.cos(a) * o.r,
        o.y + Math.sin(a * 2 + o.phase) * 0.18 - 0.1,
        Math.sin(a) * o.r * Math.cos(o.tilt) + Math.sin(o.tilt) * 0.5,
      );
      o.mesh.position.y += Math.sin(a) * o.r * Math.sin(o.tilt) * 0.45;
      o.mesh.quaternion.copy(camera.quaternion);
    }

    // parallax, damped hard enough that it never feels like a toy
    px += (tx - px) * Math.min(1, dt * 3.2);
    py += (ty - py) * Math.min(1, dt * 3.2);
    const drift = reduce ? 0 : Math.sin(clock * 0.26) * 0.35;
    camera.position.set(drift + px * 0.7, 1.32 - py * 0.38, 6.9);
    camera.lookAt(LOOK);

    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  host.dataset.mode = '3d';
  return {
    dispose() {
      cancelAnimationFrame(raf);
      host.removeEventListener('pointermove', onMove);
      host.removeEventListener('pointerleave', onLeave);
      renderer.dispose();
      canvas.remove();
      delete host.dataset.mode;
    },
  };
}

