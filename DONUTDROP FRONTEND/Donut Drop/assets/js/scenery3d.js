/* scenery3d.js — what the 3D games share of the game's world beyond their own models.
 *
 * The round shadow the game puts under every mob and dropped item (misc/shadow.png); the clouds as
 * the game draws them in fancy mode, a box for every white pixel of its cloud map, twelve blocks
 * across and four deep, their faces shaded as the game shades them; a glow round a light that is
 * one draw for all of them; a small village house of the game's blocks; animals grazing; villagers
 * about the village; a hanging chain; the dragon egg; and a colour grade for the end of the post chain.
 *
 * Every picture is the game's own. What is drawn rather than taken is light: the glows, the grade.
 */
import { buildModel, pixelTexture, placeEntity, poseQuadruped } from './mcmodels.js';
import { softDot } from './mc3d.js';

/** The entity shadow's material: the game's round shadow, laid on the ground under a mob. */
export function shadowMaterial(THREE, image, opacity = 0.7) {
  const map = new THREE.CanvasTexture(image);
  map.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshBasicMaterial({ map, transparent: true, opacity, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, fog: true });
}
/** A shadow `radius` blocks round, flat on the ground; move it under its mob each frame. */
export function blobShadow(THREE, material, radius) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(radius * 2, radius * 2).rotateX(-Math.PI / 2), material);
  mesh.renderOrder = 1;
  return mesh;
}

/**
 * The game's fancy clouds: every white pixel of `image` (the cloud map) a box `cell` blocks across
 * and four deep at height `y`, out to `radius` blocks round the origin, drifting west as the game's
 * do. Faces are shaded as the game shades a cloud: the top full, the sides 0.9 and 0.8, the bottom 0.7.
 * `clear` keeps that many blocks round the origin free of cloud even as the layer drifts, for a scene
 * the camera climbs up through.
 */
export function fancyClouds(THREE, image, { y, radius = 260, cell = 12, opacity = 0.82, tint = 0xffffff, clear = 0 } = {}) {
  const c = document.createElement('canvas');
  c.width = image.naturalWidth || image.width;
  c.height = image.naturalHeight || image.height;
  const g = c.getContext('2d');
  g.drawImage(image, 0, 0);
  const data = g.getImageData(0, 0, c.width, c.height).data;
  const span = Math.ceil(radius / cell);
  const cells = [];
  for (let gz = -span; gz <= span; gz += 1) {
    for (let gx = -span; gx <= span; gx += 1) {
      if (Math.hypot(gx, gz) > span) continue;
      if (clear && Math.hypot(gx * cell, gz * cell) < clear + cell) continue;
      const px = ((gx % c.width) + c.width) % c.width;
      const pz = ((gz % c.height) + c.height) % c.height;
      if (data[(pz * c.width + px) * 4 + 3] > 127) cells.push([gx * cell, gz * cell]);
    }
  }
  const shade = (k) => new THREE.MeshBasicMaterial({ color: new THREE.Color(tint).multiplyScalar(k), transparent: true, opacity, depthWrite: false, fog: true });
  const mats = [shade(0.9), shade(0.9), shade(1), shade(0.7), shade(0.8), shade(0.8)];
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(cell, 4, cell), mats, Math.max(1, cells.length));
  const m = new THREE.Matrix4();
  cells.forEach(([x, z], i) => mesh.setMatrixAt(i, m.makeTranslation(x, y + 2, z)));
  mesh.count = cells.length;
  mesh.renderOrder = 4;
  const group = new THREE.Group();
  group.add(mesh);
  let drift = 0;
  return {
    group,
    mats,
    /** Drifts the layer west, a block every few seconds, wrapping on whole cells. */
    step(dt) {
      drift = (drift + dt * 0.6) % cell;
      group.position.x = -drift;
    },
  };
}

/**
 * Glows round lights, every one of them in a single draw: soft dots, added to the light behind them.
 * `points` are [x, y, z]; `size` is a dot's width in blocks. setColor/setSize for flicker and flashes.
 */
export function glowPoints(THREE, points, { size = 1, color = 0xffc070, opacity = 0.6 } = {}) {
  const pos = new Float32Array(points.length * 3);
  const col = new Float32Array(points.length * 3);
  const base = new THREE.Color(color);
  points.forEach(([x, y, z], i) => {
    pos.set([x, y, z], i * 3);
    col.set([base.r, base.g, base.b], i * 3);
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const material = new THREE.PointsMaterial({ map: softDot(), size, sizeAttenuation: true, vertexColors: true, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, fog: false });
  const cloud = new THREE.Points(geo, material);
  cloud.frustumCulled = false;
  return {
    points: cloud,
    material,
    setColor(i, r, g, b) {
      col[i * 3] = r;
      col[i * 3 + 1] = g;
      col[i * 3 + 2] = b;
      geo.attributes.color.needsUpdate = true;
    },
    base,
  };
}

/**
 * A small house as a village builds one: a cobblestone footing, oak log corners, oak plank walls with
 * glass windows and an oak door, a roof of stepped planks. `at` is its front-left corner on the
 * ground, `w` x `d` its footprint; it faces +z. Returns the group of instanced blocks.
 */
export function villageHouse(THREE, tex, { at, w = 5, d = 5, rand = Math.random }) {
  const box = new THREE.BoxGeometry(1, 1, 1);
  const lists = { cobblestone: [], oak_planks: [], oak_log: [], glass: [] };
  const H = 4;
  for (let x = 0; x < w; x += 1) {
    for (let z = 0; z < d; z += 1) {
      const edge = x === 0 || z === 0 || x === w - 1 || z === d - 1;
      const corner = (x === 0 || x === w - 1) && (z === 0 || z === d - 1);
      lists.cobblestone.push([x, 0, z]);
      if (!edge) continue;
      for (let y = 1; y < H; y += 1) {
        if (corner) { lists.oak_log.push([x, y, z]); continue; }
        const door = z === d - 1 && x === Math.floor(w / 2) && y <= 2;
        if (door) continue;
        const window = y === 2 && ((z === 0 || z === d - 1) ? x % 2 === 1 : z % 2 === 1);
        lists[window ? 'glass' : 'oak_planks'].push([x, y, z]);
      }
    }
  }
  // The roof: planks stepping in from both long sides to a ridge.
  for (let k = 0; k <= Math.ceil(d / 2); k += 1) {
    for (let x = -1; x <= w; x += 1) {
      lists.oak_planks.push([x, H + k, k - 1]);
      lists.oak_planks.push([x, H + k, d - k]);
    }
  }
  const group = new THREE.Group();
  const m = new THREE.Matrix4();
  for (const [name, list] of Object.entries(lists)) {
    if (!list.length) continue;
    const material = name === 'oak_log'
      ? new THREE.MeshLambertMaterial({ map: tex('oak_log') })
      : new THREE.MeshLambertMaterial({ map: tex(name), ...(name === 'glass' ? { transparent: true, opacity: 0.85 } : {}) });
    const mesh = new THREE.InstancedMesh(box, material, list.length);
    list.forEach(([x, y, z], i) => mesh.setMatrixAt(i, m.makeTranslation(x + 0.5, y + 0.5, z + 0.5)));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  // The door, its two halves.
  const doorX = Math.floor(w / 2) + 0.5;
  for (const [y, name] of [[1.5, 'oak_door_bottom'], [2.5, 'oak_door_top']]) {
    const door = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 3 / 16), new THREE.MeshLambertMaterial({ map: tex(name), alphaTest: 0.5 }));
    door.position.set(doorX, y, d - 0.1);
    group.add(door);
  }
  group.position.set(at[0], at[1], at[2]);
  void rand;
  return group;
}

/**
 * Animals grazing in a pen or a field: each wanders a little, stops, puts its head down to eat.
 * `kinds` are { def, image, fur?: { def, image } }; returns an object with step(dt, clock) and the
 * list of their entities (to hang a shadow under each).
 */
export function grazers(THREE, scene, kinds, spots, { shadowMat = null, rand = Math.random } = {}) {
  const herd = spots.map(([x, z, k], i) => {
    const kind = kinds[k % kinds.length];
    const layers = [{ material: new THREE.MeshLambertMaterial({ map: pixelTexture(THREE, kind.image), alphaTest: 0.5 }), def: kind.def }];
    if (kind.fur) layers.push({ material: new THREE.MeshLambertMaterial({ map: pixelTexture(THREE, kind.fur.image), alphaTest: 0.5, side: THREE.DoubleSide, color: kind.fur.color ?? 0xffffff }), def: kind.fur.def });
    const model = buildModel(THREE, layers);
    const entity = placeEntity(THREE, model, 1 / 16);
    entity.position.set(x, 0, z);
    entity.rotation.y = rand() * Math.PI * 2;
    scene.add(entity);
    let shadow = null;
    if (shadowMat) {
      shadow = blobShadow(THREE, shadowMat, 0.6);
      shadow.position.set(x, 0.02, z);
      scene.add(shadow);
    }
    return { model, entity, shadow, home: [x, z], walk: rand() * 10, until: 0, moving: false, heading: entity.rotation.y, grazeUntil: 0, phase: i };
  });
  return {
    herd,
    step(dt, now, reduce) {
      for (const a of herd) {
        if (reduce) {
          poseQuadruped(a.model.parts, 0, 0, 0.5);
          continue;
        }
        if (now > a.until) {
          a.moving = Math.random() < 0.4;
          a.until = now + (a.moving ? 1500 + Math.random() * 2000 : 2500 + Math.random() * 4000);
          if (a.moving) {
            // Back toward home when it has strayed.
            const [hx, hz] = a.home;
            const away = Math.hypot(a.entity.position.x - hx, a.entity.position.z - hz);
            a.heading = away > 3 ? Math.atan2(hx - a.entity.position.x, hz - a.entity.position.z) : Math.random() * Math.PI * 2;
          } else {
            a.grazeUntil = now + 1200 + Math.random() * 2000;
          }
        }
        if (a.moving) {
          a.entity.rotation.y += ((a.heading - a.entity.rotation.y + Math.PI * 3) % (Math.PI * 2) - Math.PI) * Math.min(1, dt * 3);
          a.entity.position.x += Math.sin(a.entity.rotation.y) * dt * 0.7;
          a.entity.position.z += Math.cos(a.entity.rotation.y) * dt * 0.7;
          a.walk += dt * 8;
        }
        poseQuadruped(a.model.parts, a.walk, a.moving ? 0.6 : 0, !a.moving && now < a.grazeUntil ? 0.9 : 0);
        if (a.shadow) a.shadow.position.set(a.entity.position.x, 0.02, a.entity.position.z);
      }
    },
  };
}

/**
 * A colour grade for the end of the post chain (medium and high only): a light sharpen, a touch of
 * contrast and saturation, shadows lifted toward one colour and highlights toward another, and a
 * vignette. Works on the finished picture, after OutputPass; one fullscreen pass.
 *
 * The shadows are lifted on a gentle curve (`gamma` under 1), so a dark cave or a night sky stays
 * dark without its detail sinking into black.
 *
 * The sharpen pulls a pixel away from the average of its four neighbours but never past the
 * darkest or brightest of them, so soft edges (glow, fog, distant texture) firm up without the
 * bright rims a plain unsharp mask leaves.
 */
export function gradePass(THREE, addons, { contrast = 1.06, saturation = 1.12, lift = [0, 0, 0], gain = [1, 1, 1], vignette = 0.25, sharpen = 0.6, gamma = 0.84 } = {}) {
  const pass = new addons.ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      uTexel: { value: new THREE.Vector2(1 / 1024, 1 / 1024) },
      uSharpen: { value: sharpen },
      uGamma: { value: gamma },
      uContrast: { value: contrast },
      uSaturation: { value: saturation },
      uLift: { value: new THREE.Vector3(...lift) },
      uGain: { value: new THREE.Vector3(...gain) },
      uVignette: { value: vignette },
    },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform sampler2D tDiffuse; uniform vec2 uTexel; uniform float uSharpen; uniform float uGamma;
      uniform float uContrast; uniform float uSaturation; uniform vec3 uLift; uniform vec3 uGain; uniform float uVignette;
      varying vec2 vUv;
      void main() {
        vec4 c = texture2D(tDiffuse, vUv);
        vec3 a = texture2D(tDiffuse, vUv + vec2(uTexel.x, 0.0)).rgb;
        vec3 b = texture2D(tDiffuse, vUv - vec2(uTexel.x, 0.0)).rgb;
        vec3 e = texture2D(tDiffuse, vUv + vec2(0.0, uTexel.y)).rgb;
        vec3 f = texture2D(tDiffuse, vUv - vec2(0.0, uTexel.y)).rgb;
        vec3 lo = min(c.rgb, min(min(a, b), min(e, f)));
        vec3 hi = max(c.rgb, max(max(a, b), max(e, f)));
        vec3 col = clamp(c.rgb + (c.rgb * 4.0 - a - b - e - f) * 0.25 * uSharpen, lo, hi);
        col = pow(max(col, vec3(0.0)), vec3(uGamma));
        col = (col - 0.5) * uContrast + 0.5;
        float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
        col = mix(vec3(l), col, uSaturation);
        col = col * uGain + uLift * (1.0 - col);
        vec2 d = vUv - 0.5;
        col *= clamp(1.0 - uVignette * dot(d, d) * 1.5, 0.0, 1.0);
        gl_FragColor = vec4(clamp(col, 0.0, 1.0), c.a);
      }`,
  });
  // The composer hands every pass the size of its buffers; the sharpen needs one pixel's step.
  pass.setSize = (width, height) => pass.uniforms.uTexel.value.set(1 / Math.max(1, width), 1 / Math.max(1, height));
  return pass;
}

/** Points a box's six faces (three's order: +x, -x, +y, -y, +z, -z) at regions of a 16-pixel
 * texture, as a block model's element faces do: [u0, v0, u1, v1] in pixels. */
export function regionUV(geometry, faces, size = 16) {
  const uv = geometry.attributes.uv;
  for (let f = 0; f < 6; f += 1) {
    const [u0, v0, u1, v1] = faces[f];
    for (let k = 0; k < 4; k += 1) {
      const i = f * 4 + k;
      const uu = uv.getX(i);
      const vv = uv.getY(i);
      uv.setXY(i, (u0 + uu * (u1 - u0)) / size, 1 - (v0 + (1 - vv) * (v1 - v0)) / size);
    }
  }
  uv.needsUpdate = true;
  return geometry;
}

/**
 * A chain hanging `length` blocks, as the block model draws one: two planes three pixels wide,
 * crossed at 45 degrees, the texture's first three columns on one and the next three on the other.
 * Its top is at the group's origin; it hangs down -y.
 */
export function ironChain(THREE, image, length) {
  const make = (u0, u1) => {
    const t = pixelTexture(THREE, image);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    const geo = new THREE.PlaneGeometry(3 / 16, length);
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i += 1) uv.setXY(i, (u0 + uv.getX(i) * (u1 - u0)) / 16, uv.getY(i) * length);
    return new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: t, alphaTest: 0.5, side: THREE.DoubleSide }));
  };
  const group = new THREE.Group();
  const a = make(0, 3);
  a.rotation.y = Math.PI / 4;
  const b = make(3, 6);
  b.rotation.y = -Math.PI / 4;
  for (const m of [a, b]) {
    m.position.y = -length / 2;
    group.add(m);
  }
  return group;
}

/** The dragon egg's block model: six stacked boxes rounding to its tip. One block tall, origin at its base. */
export function dragonEgg(THREE, image) {
  const map = pixelTexture(THREE, image);
  const material = new THREE.MeshLambertMaterial({ map, emissive: 0x1a0626 });
  const group = new THREE.Group();
  for (const [[x0, y0, z0], [x1, y1, z1], side, up] of [
    [[6, 15, 6], [10, 16, 10], [6, 0, 10, 1], [6, 6, 10, 10]],
    [[5, 14, 5], [11, 15, 11], [5, 1, 11, 2], [5, 5, 11, 11]],
    [[4, 13, 4], [12, 14, 12], [4, 2, 12, 3], [4, 4, 12, 12]],
    [[3, 0, 3], [13, 13, 13], [3, 3, 13, 16], [3, 3, 13, 13]],
    [[2, 1, 2], [14, 11, 14], [2, 5, 14, 15], [2, 2, 14, 14]],
    [[1, 3, 1], [15, 8, 15], [1, 8, 15, 13], [1, 1, 15, 15]],
  ]) {
    const geo = regionUV(new THREE.BoxGeometry((x1 - x0) / 16, (y1 - y0) / 16, (z1 - z0) / 16), [side, side, up, up, side, side]);
    const box = new THREE.Mesh(geo, material);
    box.position.set((x0 + x1) / 32 - 0.5, (y0 + y1) / 32, (z0 + z1) / 32 - 0.5);
    box.castShadow = true;
    group.add(box);
  }
  return group;
}

/**
 * Villagers about a village: each built in its layers (the base, its biome's clothes, its trade),
 * walking a little between its spots and stopping to look about. `images` are [base, biome,
 * profession?]; spots are [x, z] pairs, the first its home.
 */
export function villagers(THREE, scene, VILLAGER, images, people, { shadowMat = null } = {}) {
  const skin = (im, layer) => new THREE.MeshLambertMaterial({
    map: pixelTexture(THREE, im), alphaTest: 0.5, side: THREE.DoubleSide,
    polygonOffset: layer > 0, polygonOffsetFactor: -layer, polygonOffsetUnits: -layer,
  });
  const crowd = people.map((spots, i) => {
    const layers = images.filter(Boolean).map((im, k) => ({ material: skin(im, k), def: VILLAGER }));
    const model = buildModel(THREE, layers);
    const entity = placeEntity(THREE, model, 0.9375 / 16);
    const [x, z] = spots[0];
    entity.position.set(x, 0, z);
    scene.add(entity);
    let shadow = null;
    if (shadowMat) {
      shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), shadowMat);
      shadow.renderOrder = 1;
      scene.add(shadow);
    }
    return { model, entity, shadow, spots, at: 0, until: 0, moving: false, walk: i * 3, look: i * 1.7 };
  });
  return {
    crowd,
    step(dt, now, clock, reduce) {
      for (const v of crowd) {
        const P = v.model.parts;
        if (!reduce && now > v.until) {
          v.moving = !v.moving && v.spots.length > 1;
          if (v.moving) v.at = (v.at + 1) % v.spots.length;
          v.until = now + (v.moving ? 6000 : 3000 + Math.random() * 4000);
        }
        if (v.moving && !reduce) {
          const [tx, tz] = v.spots[v.at];
          const dx = tx - v.entity.position.x;
          const dz = tz - v.entity.position.z;
          const d = Math.hypot(dx, dz);
          if (d < 0.1) {
            v.moving = false;
            v.until = now + 3000 + Math.random() * 4000;
          } else {
            v.entity.rotation.y = Math.atan2(dx, dz);
            const step = Math.min(d, dt * 1.1);
            v.entity.position.x += (dx / d) * step;
            v.entity.position.z += (dz / d) * step;
            v.walk += dt * 9;
          }
        }
        const swing = v.moving && !reduce ? Math.cos(v.walk * 0.6662) * 1.2 : 0;
        P.rightLeg.rotation.x = swing;
        P.leftLeg.rotation.x = -swing;
        P.head.rotation.y = reduce || v.moving ? 0 : Math.sin(clock * 0.5 + v.look) * 0.6;
        if (v.shadow) v.shadow.position.set(v.entity.position.x, 0.02, v.entity.position.z);
      }
    },
  };
}

/** The clear day the meadow scenes share: blue deepening overhead, pale at the horizon. A dome to
 * move with the camera (its position copied each frame), drawn before everything and never fogged. */
export function skyDome(THREE, { top = 0x3f7cf0, low = 0xbcd6ff, radius = 320 } = {}) {
  const sky = new THREE.Mesh(new THREE.SphereGeometry(radius, 24, 12), new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { uTop: { value: new THREE.Color(top) }, uLow: { value: new THREE.Color(low) } },
    vertexShader: 'varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform vec3 uTop; uniform vec3 uLow; varying vec3 vDir;
      void main() {
        gl_FragColor = vec4(mix(uLow, uTop, smoothstep(0.0, 0.55, vDir.y)), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  }));
  sky.renderOrder = -10;
  return sky;
}

/**
 * Oak trees as the game grows the small ones: a trunk of logs `h` high, a crown of leaves two
 * blocks out for two layers and one block out for two more, the corners trimmed at random. `trees`
 * are [x, z, h]; `mats` the bark (sides and rings) and the leaves. One draw for the logs, one for
 * the leaves, both casting shadows.
 */
export function oakTrees(THREE, { bark, ring, leaves }, trees, seed = 41) {
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const logs = [];
  const crown = [];
  for (const [tx, tz, h] of trees) {
    for (let y = 0; y < h; y += 1) logs.push([tx, y + 0.5, tz]);
    for (let y = h - 2; y <= h + 1; y += 1) {
      const r = y >= h ? 1 : 2;
      for (let dx = -r; dx <= r; dx += 1) {
        for (let dz = -r; dz <= r; dz += 1) {
          if (Math.abs(dx) === r && Math.abs(dz) === r && (y === h + 1 || rand() < 0.5)) continue;
          if (dx === 0 && dz === 0 && y < h) continue;
          crown.push([tx + dx, y + 0.5, tz + dz]);
        }
      }
    }
  }
  const group = new THREE.Group();
  const box = new THREE.BoxGeometry(1, 1, 1);
  const m = new THREE.Matrix4();
  for (const [list, material] of [[logs, [bark, bark, ring, ring, bark, bark]], [crown, leaves]]) {
    const mesh = new THREE.InstancedMesh(box, material, list.length);
    list.forEach(([x, y, z], i) => mesh.setMatrixAt(i, m.makeTranslation(x, y, z)));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}
