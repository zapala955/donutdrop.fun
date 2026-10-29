/* shade3d.js — the lit look the table games share with Blackjack and Fishing.
 *
 * The scenes were built on MeshLambertMaterial: light falls on a face and that is all, so a gold
 * block, a wool wall and a pane of ice come out the same matte card. On a machine with the room
 * for it (medium and high, see quality3d.js) every one of those materials is drawn physically
 * instead -- MeshStandardMaterial, a roughness and a metalness for each, picked from the game's own
 * texture by its name -- inside a sky of the scene's own colours that the shiny ones reflect and
 * every face takes a little light from. A sun can cast soft shadows, and grass, crops and leaves
 * lean in a wind written into their vertex shader. Low keeps Lambert: the same scene, cheaper.
 *
 * Nothing in a scene has to change to get it but where THREE comes from: `shadedTHREE` hands back
 * the scene's THREE with MeshLambertMaterial standing for the material the tier can afford, so the
 * shared builders (mcmodels.js, scenery3d.js) are lit the same way without knowing it. A scene may
 * pass roughness and metalness to a Lambert material for a finish of its own; Lambert ignores them.
 *
 * Every picture is still the game's own. What is added is light.
 */

/** Options only a Lambert material takes, and only a physical one. Each is dropped from the other. */
const LAMBERT_ONLY = ['combine', 'reflectivity', 'refractionRatio', 'specularMap'];
const PBR_ONLY = ['roughness', 'metalness', 'roughnessMap', 'metalnessMap', 'envMapIntensity'];
const without = (params, keys) => {
  if (!params) return params;
  const out = { ...params };
  for (const key of keys) delete out[key];
  return out;
};

/* The finish of a block or item, by its texture's file name. Matte is the default: stone, wood, wool,
 * dirt and every mob are rough. Metals are metal, gems and glass and ice are glassy, and polished
 * stone has a sheen. Ores stay stone: their flecks are a few pixels of a rough block. */
const METAL = new Set(['gold_block', 'raw_gold_block', 'gold_ingot', 'gold_nugget', 'bell', 'iron_block', 'iron_bars',
  'iron_chain', 'chain', 'anvil', 'anvil_top', 'chipped_anvil_top', 'damaged_anvil_top', 'iron_ingot', 'iron_nugget',
  'rail', 'rail_corner', 'powered_rail', 'powered_rail_on', 'detector_rail', 'activator_rail', 'lantern', 'soul_lantern',
  'cauldron_side', 'cauldron_top', 'cauldron_inner', 'hopper_outside', 'hopper_inside', 'netherite_block',
  'copper_block', 'cut_copper', 'lightning_rod', 'minecart', 'heavy_weighted_pressure_plate', 'light_weighted_pressure_plate',
  'iron_door_top', 'iron_door_bottom', 'iron_trapdoor', 'blast_furnace_top', 'smithing_table_top']);
const GOLDEN = /^(gold|golden_|raw_gold|bell|light_weighted)/;
const GLASSY = new Set(['diamond_block', 'emerald_block', 'diamond', 'emerald', 'amethyst_block', 'budding_amethyst',
  'amethyst_cluster', 'amethyst_shard', 'large_amethyst_bud', 'medium_amethyst_bud', 'glass', 'tinted_glass', 'ice',
  'packed_ice', 'blue_ice', 'frosted_ice_0', 'sea_lantern', 'prismarine_crystals', 'ender_pearl', 'ender_eye',
  'end_crystal', 'quartz', 'lapis_block', 'redstone_block', 'beacon', 'slime_block', 'honey_block', 'echo_shard']);
const SHEEN = /^(obsidian|crying_obsidian|polished_|smooth_|deepslate_tiles|deepslate_bricks|end_stone_bricks|purpur|quartz_|chiseled_quartz|prismarine|dark_prismarine|nether_bricks|red_nether_bricks|magma|glazed|.*_glazed_terracotta|terracotta|.*_concrete$|stripped_)/;

/** The roughness and metalness for a texture, or null for the default. */
export function finishFor(map) {
  const src = map?.image?.src;
  if (typeof src !== 'string') return null;
  const name = src.slice(src.lastIndexOf('/') + 1).replace(/\.png.*$/, '');
  /* Metal, but not all the way: a fully metallic face shows only what it reflects, and a scene's sky
   * is a soft thing, so gold in a dim smithy came out brown. Part metal keeps the colour and the shine. */
  if (METAL.has(name)) return { metalness: GOLDEN.test(name) ? 0.6 : 0.5, roughness: GOLDEN.test(name) ? 0.3 : 0.42 };
  if (GLASSY.has(name) || /_stained_glass$/.test(name)) return { metalness: 0, roughness: 0.16 };
  if (SHEEN.test(name)) return { metalness: 0, roughness: 0.5 };
  return null;
}

/**
 * The scene's THREE, with MeshLambertMaterial meaning the material `tier` can afford: physical on
 * medium and high, Lambert on low. Everything else is THREE itself.
 */
export function shadedTHREE(THREE, tier) {
  if (tier.name === 'low') {
    class FlatMaterial extends THREE.MeshLambertMaterial {
      constructor(params) {
        super(without(params, PBR_ONLY));
      }
    }
    return { ...THREE, MeshLambertMaterial: FlatMaterial };
  }
  const smoothCutouts = tier.samples > 0;
  class LitMaterial extends THREE.MeshStandardMaterial {
    constructor(params) {
      super({ roughness: 0.86, metalness: 0.02, ...finishFor(params?.map), ...without(params, LAMBERT_ONLY) });
      /* A cut-out texture (grass, rails, leaves, flowers) has a hard pixel edge where alphaTest
       * throws the rest away. With multisampling the edge is spread over the samples instead, so it
       * comes out smooth rather than as a staircase. */
      if (smoothCutouts && this.alphaTest > 0) this.alphaToCoverage = true;
    }
  }
  return { ...THREE, MeshLambertMaterial: LitMaterial };
}

/* Soft shadow in the corners (every read is textureLod: no gradients inside the loop): where one block meets another, under a sign, round a mob's feet. Read
 * from the depth alone -- a sample nearer the camera than this pixel, and close behind it, is
 * something leaning over it -- so it needs no second render of the scene. Fades out with distance. */
const AO_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    uTexel: { value: null },
    uNear: { value: 0.1 },
    uFar: { value: 200 },
    uProj: { value: 1 },
    uRadius: { value: 0.6 },
    uStrength: { value: 0.55 },
  },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform sampler2D tDepth; uniform vec2 uTexel;
    uniform float uNear; uniform float uFar; uniform float uProj; uniform float uRadius; uniform float uStrength;
    varying vec2 vUv;
    float linearDepth(vec2 at) {
      float z = textureLod(tDepth, at, 0.0).r * 2.0 - 1.0;
      return 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear));
    }
    void main() {
      vec4 color = textureLod(tDiffuse, vUv, 0.0);
      float raw = textureLod(tDepth, vUv, 0.0).r;
      if (raw >= 0.9999) { gl_FragColor = color; return; }
      float z = linearDepth(vUv);
      // The radius in screen space: the same half block near and far.
      vec2 reach = vec2(uTexel.x / uTexel.y, 1.0) * uRadius * uProj / z;
      // Interleaved gradient noise turns the pattern per pixel, so it reads as grain, not rings.
      float spin = 6.2831853 * fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
      float occlusion = 0.0;
      for (int i = 0; i < AO_SAMPLES; i++) {
        float t = (float(i) + 0.5) / float(AO_SAMPLES);
        float a = spin + float(i) * 2.3999632;
        vec2 at = vUv + vec2(cos(a), sin(a)) * reach * t;
        float lead = z - linearDepth(at);
        occlusion += clamp(lead / (0.12 + 0.02 * z), 0.0, 1.0) * (1.0 - smoothstep(0.4, 1.6, lead));
      }
      occlusion = occlusion / float(AO_SAMPLES) * (1.0 - smoothstep(18.0, 60.0, z));
      gl_FragColor = vec4(color.rgb * (1.0 - uStrength * occlusion), color.a);
    }`,
};

/* FXAA, the console version: the last thing drawn, on the finished picture, so every hard step
 * along an edge -- a block's silhouette, a rail, a sign -- is blended across. */
const FXAA_SHADER = {
  uniforms: { tDiffuse: { value: null }, uTexel: { value: null } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform vec2 uTexel; varying vec2 vUv;
    void main() {
      vec3 nw = texture2D(tDiffuse, vUv + vec2(-1.0, -1.0) * uTexel).rgb;
      vec3 ne = texture2D(tDiffuse, vUv + vec2(1.0, -1.0) * uTexel).rgb;
      vec3 sw = texture2D(tDiffuse, vUv + vec2(-1.0, 1.0) * uTexel).rgb;
      vec3 se = texture2D(tDiffuse, vUv + vec2(1.0, 1.0) * uTexel).rgb;
      vec4 mid = texture2D(tDiffuse, vUv);
      vec3 toLuma = vec3(0.299, 0.587, 0.114);
      float lNW = dot(nw, toLuma); float lNE = dot(ne, toLuma);
      float lSW = dot(sw, toLuma); float lSE = dot(se, toLuma);
      float lM = dot(mid.rgb, toLuma);
      float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
      float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
      vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
      float reduce = max((lNW + lNE + lSW + lSE) * 0.03125, 1.0 / 128.0);
      float scale = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
      dir = clamp(dir * scale, vec2(-8.0), vec2(8.0)) * uTexel;
      vec3 a = 0.5 * (texture2D(tDiffuse, vUv + dir * (1.0 / 3.0 - 0.5)).rgb + texture2D(tDiffuse, vUv + dir * (2.0 / 3.0 - 0.5)).rgb);
      vec3 b = a * 0.5 + 0.25 * (texture2D(tDiffuse, vUv - dir * 0.5).rgb + texture2D(tDiffuse, vUv + dir * 0.5).rgb);
      float lB = dot(b, toLuma);
      gl_FragColor = vec4((lB < lMin || lB > lMax) ? a : b, mid.a);
    }`,
};

const shaderPass = (THREE, addons, shader, defines = {}) => {
  const pass = new addons.ShaderPass({
    defines,
    uniforms: THREE.UniformsUtils.clone(shader.uniforms),
    vertexShader: shader.vertexShader,
    fragmentShader: shader.fragmentShader,
  });
  pass.uniforms.uTexel.value = new THREE.Vector2(1 / 4, 1 / 4);
  pass.setSize = (width, height) => pass.uniforms.uTexel.value.set(1 / Math.max(1, width), 1 / Math.max(1, height));
  return pass;
};

/**
 * Smooths a scene's picture: soft shadow in its corners (ambient occlusion, straight after the scene
 * is drawn) and FXAA over the finished frame. Call once the composer has its passes, before its
 * first frame; the depth it reads is attached to the composer's own buffers here. `ao` is how dark
 * a corner gets, 0 for none. High looks fourteen times round each pixel, medium (most laptops) eight.
 */
export function smoothen(THREE, addons, composer, camera, { tier, ao = 0.55, radius = 0.6 } = {}) {
  if (!composer || !addons?.ShaderPass) return;
  if (ao > 0) {
    for (const target of [composer.renderTarget1, composer.renderTarget2]) {
      target.depthTexture = new THREE.DepthTexture(target.width, target.height);
    }
    const occlusion = shaderPass(THREE, addons, AO_SHADER, { AO_SAMPLES: tier?.name === 'high' ? 14 : 8 });
    occlusion.uniforms.uStrength.value = ao;
    occlusion.uniforms.uRadius.value = radius;
    const render = occlusion.render.bind(occlusion);
    occlusion.render = (renderer, writeBuffer, readBuffer, delta, mask) => {
      const u = occlusion.uniforms;
      u.tDepth.value = readBuffer.depthTexture;
      u.uNear.value = camera.near;
      u.uFar.value = camera.far;
      u.uProj.value = camera.projectionMatrix.elements[5] * 0.5;
      render(renderer, writeBuffer, readBuffer, delta, mask);
    };
    composer.insertPass(occlusion, 1);
  }
  composer.addPass(shaderPass(THREE, addons, FXAA_SHADER));
}

/**
 * A sky of three colours and a sun, rendered once into the environment every physical material in
 * the scene reflects and takes a little light from. Colours are the scene's: a cave's is near black
 * with warm torchlight low down, a meadow's blue over green. Returns the render target to dispose.
 */
function skyEnvironment(THREE, renderer, scene, { top, horizon, ground, sun = null, sunColor = 0xffffff, intensity }) {
  const envScene = new THREE.Scene();
  const geometry = new THREE.SphereGeometry(10, 48, 24);
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uTop: { value: new THREE.Color(top) },
      uHorizon: { value: new THREE.Color(horizon) },
      uGround: { value: new THREE.Color(ground) },
      uSun: { value: new THREE.Vector3(...(sun ?? [0, 1, 0])).normalize() },
      uSunColor: { value: new THREE.Color(sunColor).multiplyScalar(sun ? 1 : 0) },
    },
    vertexShader: 'varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uGround; uniform vec3 uSun; uniform vec3 uSunColor;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        vec3 c = d.y > 0.0 ? mix(uHorizon, uTop, pow(d.y, 0.55)) : mix(uHorizon, uGround, pow(-d.y, 0.35));
        float s = max(dot(d, uSun), 0.0);
        c += uSunColor * (pow(s, 90.0) * 6.0 + pow(s, 8.0) * 0.35);
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  envScene.add(new THREE.Mesh(geometry, material));
  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromScene(envScene, 0.015);
  pmrem.dispose();
  geometry.dispose();
  material.dispose();
  scene.environment = target.texture;
  scene.environmentIntensity = intensity;
  return target;
}

/* Grass, crops, flowers and leaves, by texture name: what the wind moves. */
const FOLIAGE = /(_leaves|^short_grass|^tall_grass|^grass$|^fern|^large_fern|^wheat_stage|^carrots_stage|^potatoes_stage|^beetroots_stage|^sugar_cane|^vine|^kelp|^seagrass|^tall_seagrass|^dandelion|^poppy|^blue_orchid|^allium|^azure_bluet|_tulip$|^oxeye_daisy|^cornflower|^lily_of_the_valley|^sweet_berry_bush|^dead_bush|^bamboo|^cave_vines|^glow_lichen|^hanging_roots|^spore_blossom)/;
const LEAVES = /_leaves$/;

/**
 * Leans a foliage material in the wind: the top of a plant sways about its root, a block of leaves
 * shivers as one. The sway is a function of the vertex's place in the world, so neighbouring blocks
 * move together and never part at a seam, and of `time`, which the scene advances.
 */
function swayMaterial(material, time, leaves) {
  if (material.userData.swaying) return;
  material.userData.swaying = true;
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous?.call(material, shader, renderer);
    shader.uniforms.uWindTime = time;
    shader.vertexShader = `uniform float uWindTime;\n${shader.vertexShader}`.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      {
        vec4 windWorld = modelMatrix * vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          windWorld = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
        #endif
        float windPhase = uWindTime * 1.7 + windWorld.x * 0.45 + windWorld.z * 0.31;
        float windGust = 0.65 + 0.35 * sin(uWindTime * 0.37 + windWorld.x * 0.05);
        ${leaves
          ? 'float windWeight = 0.022;'
          : 'float windWeight = 0.075 * clamp(uv.y, 0.0, 1.0);'}
        transformed.x += sin(windPhase) * windWeight * windGust;
        transformed.z += cos(windPhase * 0.83) * windWeight * 0.6 * windGust;
        ${leaves ? 'transformed.y += sin(windPhase * 1.3) * windWeight * 0.4;' : ''}
      }`,
    );
  };
  const key = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => `${key ? key() : ''}|sway${leaves ? 'L' : 'P'}`;
  material.needsUpdate = true;
}

/** Whether every material of a mesh is one a light falls on (not a sky, a glow or a sprite). */
const litMesh = (object) => {
  const materials = Array.isArray(object.material) ? object.material : [object.material];
  return materials.every((m) => m?.isMeshStandardMaterial || m?.isMeshLambertMaterial);
};
const solidMesh = (object) => {
  const materials = Array.isArray(object.material) ? object.material : [object.material];
  return materials.every((m) => !m.transparent && m.depthWrite !== false);
};

/**
 * The look, for one scene: a sky to reflect (medium and high), soft shadows, and the wind. Call
 * `tick(seconds)` from the frame loop; it moves the wind and, every so often, finds what was added
 * since -- foliage to sway, and meshes to cast and take shadows once `shadows(scene)` has asked for
 * them. `env` is the sky's colours, the direction of the sun it glows round and how much light it
 * gives; `wind` false for a scene with nothing growing in it.
 */
export function shadeScene(THREE, { tier, renderer, scene, env, wind = true }) {
  const lit = tier.name !== 'low';
  const target = lit && env ? skyEnvironment(THREE, renderer, scene, env) : null;
  const time = { value: 0 };
  const seen = new WeakSet();
  const reduceWind = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  let shadowRule = null;
  const castAndTake = (object, { cast = true, receive = true, skip = () => false }) => {
    if (!litMesh(object) || skip(object)) return;
    if (cast && solidMesh(object)) object.castShadow = true;
    if (receive) object.receiveShadow = true;
  };
  const scan = () => {
    scene.traverse((object) => {
      if (!object.isMesh || seen.has(object)) return;
      seen.add(object);
      if (shadowRule) castAndTake(object, shadowRule);
      if (!wind || reduceWind) return;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        const src = material?.map?.image?.src;
        if (typeof src !== 'string') continue;
        const name = src.slice(src.lastIndexOf('/') + 1).replace(/\.png.*$/, '');
        if (FOLIAGE.test(name)) swayMaterial(material, time, LEAVES.test(name));
      }
    });
  };
  let sinceScan = Infinity;
  return {
    lit,
    /** Gives a light soft shadows: a directional one over a square `size` blocks either side of its
     * target, a spot over its own cone. */
    sun(light, { size = 12, near = 0.5, far = 80, mapSize = tier.name === 'high' ? 2048 : 1024, bias = -0.0004, normalBias = 0.03 } = {}) {
      if (!lit) return false;
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      light.castShadow = true;
      const cam = light.shadow.camera;
      if (cam.isOrthographicCamera) Object.assign(cam, { left: -size, right: size, top: size, bottom: -size });
      cam.near = near;
      cam.far = far;
      cam.updateProjectionMatrix();
      light.shadow.mapSize.set(mapSize, mapSize);
      light.shadow.bias = bias;
      light.shadow.normalBias = normalBias;
      return true;
    },
    /** Every lit, opaque mesh under `root` casts and takes shadows, but those `skip` names. A sky,
     * a glow or a sprite (shader, basic and points materials) is left alone. Asked of the whole
     * scene, it holds for whatever is added later too. */
    shadows(root, rule = {}) {
      if (!lit) return;
      if (root === scene) shadowRule = rule;
      root.traverse((object) => {
        if (object.isMesh) castAndTake(object, rule);
      });
    },
    tick(seconds) {
      time.value = seconds;
      sinceScan += 1;
      if (sinceScan > 45) {
        sinceScan = 0;
        scan();
      }
    },
    dispose() {
      if (target) {
        if (scene.environment === target.texture) scene.environment = null;
        target.dispose();
      }
    },
  };
}
