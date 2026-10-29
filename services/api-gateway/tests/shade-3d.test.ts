import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

const repo = path.resolve(import.meta.dirname, '../../..');
const front = (relative: string) => readFile(path.join(repo, 'DONUTDROP FRONTEND/Donut Drop', relative), 'utf8');

const SCENES = ['mines3d', 'plinko3d', 'roulette3d', 'crash3d', 'chicken3d', 'tower3d', 'dice3d', 'coin3d'];

describe('the lit look (shade3d.js)', () => {
  it('draws physically on medium and high, and keeps Lambert on low', async () => {
    const shade = await front('assets/js/shade3d.js');
    assert.match(shade, /if \(tier\.name === 'low'\) \{\n    class FlatMaterial extends THREE\.MeshLambertMaterial/);
    assert.match(shade, /class LitMaterial extends THREE\.MeshStandardMaterial/);
    assert.match(shade, /return \{ \.\.\.THREE, MeshLambertMaterial: LitMaterial \};/);
    // A sky to reflect, soft shadows and the wind are all medium and high only.
    assert.match(shade, /const lit = tier\.name !== 'low';/);
    assert.match(shade, /const target = lit && env \? skyEnvironment\(/);
    assert.match(shade, /sun\(light, [^)]*\) \{\n      if \(!lit\) return false;/);
    // Reduced motion: nothing sways.
    assert.match(shade, /prefers-reduced-motion: reduce/);
  });

  it('gives metal, gems and polished stone their finish by the game’s own texture name, ores stay stone', async () => {
    const shade = await front('assets/js/shade3d.js');
    for (const name of ['gold_block', 'iron_block', 'anvil', 'rail', 'lantern']) assert.match(shade, new RegExp(`'${name}'`));
    for (const name of ['diamond_block', 'emerald', 'amethyst_cluster', 'glass', 'ice']) assert.match(shade, new RegExp(`'${name}'`));
    assert.doesNotMatch(shade, /'[a-z_]+_ore'/);
  });

  it('is what every table game is built with, ticked each frame and let go on dispose', async () => {
    for (const name of SCENES) {
      const scene = await front(`assets/js/${name}.js`);
      assert.match(scene, /import \{ shadeScene, shadedTHREE, smoothen \} from '\.\/shade3d\.js';/, name);
      assert.match(scene, /const threeCore = await getTHREE\(\);/, name);
      assert.match(scene, /const tier = chooseTier\(probeGl\);\n[^\n]*\n  const THREE = shadedTHREE\(threeCore, tier\);/, name);
      assert.match(scene, /const shading = shadeScene\(THREE, \{ tier, renderer, scene, env: \{/, name);
      assert.ok(scene.includes('shading.tick(now / 1000);'), `${name} does not tick the look`);
      assert.ok(scene.includes('shading.dispose();'), `${name} does not dispose the look`);
      assert.doesNotMatch(scene, /const THREE = await getTHREE\(\);/, name);
    }
  });

  it('draws every table game smooth, not sharp: corners shaded, edges and cut-outs blended', async () => {
    const shade = await front('assets/js/shade3d.js');
    assert.match(shade, /if \(smoothCutouts && this\.alphaTest > 0\) this\.alphaToCoverage = true;/);
    assert.match(shade, /composer\.insertPass\(occlusion, 1\);/);
    assert.match(shade, /composer\.addPass\(shaderPass\(THREE, addons, FXAA_SHADER\)\);/);
    for (const name of SCENES) {
      const scene = await front(`assets/js/${name}.js`);
      assert.match(scene, /composer\.addPass\(gradePass\(THREE, addons, \{ sharpen: 0, /, name);
      assert.match(scene, /smoothen\(THREE, addons, composer, camera, \{ tier, ao: 0\.\d+ \}\);/, name);
    }
  });

  it('crosses the chicken by night: the moon, the stars, a torch at every sign, a lamp on the hen', async () => {
    const chicken = await front('assets/js/chicken3d.js');
    assert.match(chicken, /loadImage\('assets\/img\/env\/moon\.png'\)/);
    assert.match(chicken, /new THREE\.DirectionalLight\(0xaec0ff, /);
    assert.match(chicken, /const torches = new THREE\.InstancedMesh\(torchGeo, torchMat, spots\.length\);/);
    assert.match(chicken, /henLamp\.position\.set\(henAt\.x, 1\.5, -1\.2\);/);
    // A multiplier still reads in the dark: the sign faces glow a little.
    assert.match(chicken, /emissiveMap: texture, emissiveIntensity: 0\.3/);
  });

  it('lights the tower chests from the player’s side, so their fronts are never lost in shadow', async () => {
    const tower = await front('assets/js/tower3d.js');
    assert.match(tower, /const faceLight = new THREE\.DirectionalLight\(/);
    assert.match(tower, /faceLight\.target\.position\.set\(0, focusY, CHEST_Z\);/);
  });

  it('lights the outdoor games for a golden afternoon, as Fishing is lit, and the End with a lamp', async () => {
    for (const name of ['dice3d', 'crash3d', 'tower3d']) {
      const scene = await front(`assets/js/${name}.js`);
      assert.match(scene, /new THREE\.HemisphereLight\(0xffe6cc, 0x3c4c(66|5a)/, name);
      assert.match(scene, /new THREE\.DirectionalLight\(0xffcf98, /, name);
      assert.match(scene, /horizon: 0xf[03][d][0-9a-f]{3}/, name);
    }
    const plinko = await front('assets/js/plinko3d.js');
    assert.match(plinko, /const lamp = new THREE\.SpotLight\(/);
    assert.match(plinko, /if \(shading\.sun\(lamp, /);
    assert.match(plinko, /hemi\.intensity = HEMI \+ f \* 1\.4;/);
    assert.match(plinko, /shading\.shadows\(scene\);/);
  });
});
