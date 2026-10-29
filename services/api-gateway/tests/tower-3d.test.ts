import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

const repo = path.resolve(import.meta.dirname, '../../..');
const front = (relative: string) => readFile(path.join(repo, 'DONUTDROP FRONTEND/Donut Drop', relative), 'utf8');
const img = (relative: string) => path.join(repo, 'DONUTDROP FRONTEND/Donut Drop/assets/img', relative);

describe('tower in 3D', () => {
  it('builds the tower only from the game’s own pictures and models', async () => {
    const tower = await front('assets/js/tower3d.js');
    const quoted = (list: string) => {
      const body = tower.match(new RegExp(`const ${list} = \\[([^;]+)\\];`))?.[1] ?? '';
      return [...body.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]!);
    };
    const blocks = quoted('BLOCKS');
    for (const name of ['stone_bricks', 'chiseled_stone_bricks', 'ladder', 'oak_sign', 'beacon', 'spawner', 'end_rod', 'dragon_egg']) {
      assert.ok(blocks.includes(name), name);
    }
    for (const name of blocks) assert.ok(existsSync(img(`block/${name}.png`)), `block ${name}`);
    // The Tower of Worlds: nine storeys, each laid from its own place's blocks, each with its own loot.
    const storeys = [...tower.matchAll(/\{ name: '([a-z]+)', walls: \[([^\]]+)\], corner: '([a-z_]+)', floor: '([a-z_]+)', light: 0x[0-9a-f]+, loot: '([a-z_]+)'/g)];
    assert.deepEqual(storeys.map((m) => m[1]), ['ruin', 'dungeon', 'library', 'geode', 'monument', 'fortress', 'bastion', 'city', 'end']);
    for (const [, , walls, corner, floor, loot] of storeys) {
      for (const name of [...[...walls!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!), corner!, floor!]) assert.ok(existsSync(img(`block/${name}.png`)), `block ${name}`);
      assert.ok(existsSync(img(`items/${loot}.png`)), `item ${loot}`);
    }
    for (const name of quoted('ENTITY')) assert.ok(existsSync(img(`entity/${name}.png`)), `entity ${name}`);
    for (const name of quoted('PARTICLE')) assert.ok(existsSync(img(`particle/${name}.png`)), `particle ${name}`);
    for (const [name, frames] of [['explosion', 16], ['generic', 8], ['spark', 8]] as const) {
      for (let i = 0; i < frames; i += 1) assert.ok(existsSync(img(`particle/${name}_${i}.png`)), `${name}_${i}`);
    }
    for (const [, file] of tower.matchAll(/loadImage\('assets\/img\/([^']+)'\)/g)) assert.ok(existsSync(img(file!)), file);
    // The chest on its own model, the lid on its real hinge, and Steve on PlayerModel.
    assert.match(tower, /buildChest\('assets\/img\/block\/chest_normal\.png', 1\)/);
    assert.match(tower, /const OPEN = -1\.45;/);
    assert.ok(tower.includes('{ material: steveMat, def: PLAYER }'));
    // The trap is a creeper, swelling and flashing as CreeperRenderer draws it.
    assert.ok(tower.includes('{ material: creeperMat, def: CREEPER }'));
    assert.match(tower, /const h = \(1 \+ f \* 0\.4\) \* wobble;\n\s*const w = \(1 \+ f \* 0\.1\) \/ wobble;/);
    assert.match(tower, /const white = Math\.floor\(swell \* 10\) % 2 === 0 \? 0 : Math\.min\(1, Math\.max\(0\.5, swell\)\);/);
    // Every storey's sign says what clearing it pays, in the game's font (which has no ×).
    assert.match(tower, /writeSign\(f, \(pays\[f\] \|\| ''\)\.replace\('×', 'x'\), tone\);/);
  });

  it('asks of a low-end machine only what it can do, and keeps the flat tower for everyone else', async () => {
    const [tower, page, css] = await Promise.all([front('assets/js/tower3d.js'), front('assets/js/tower.js'), front('assets/css/tower.css')]);
    assert.match(tower, /import \{ BRIGHTNESS, chooseTier, createGovernor, frameMs, minFpsFor, ratioFor \} from '\.\/quality3d\.js';/);
    for (const use of ['tier.particles', 'tier.composer', 'tier.antialias', 'tier.samples', 'frameMs(tier)', 'minFpsFor(tier)']) assert.ok(tower.includes(use), use);
    // Its own chunk, loaded only when the page can draw it; the board stays for the keyboard.
    assert.match(page, /await import\('\.\/tower3d\.js'\)/);
    // The chest is opened in the tower before the page says what was in it.
    assert.match(page, /if \(tower3d\) await tower3d\.open\(floor, tile, game\.outcome === 'trap'\);\n\s*if \(game\.outcome === 'trap'\) \{\n\s*if \(!tower3d\) boom\(floor, tile\);/);
    assert.match(page, /tower3d\?\.celebrate\(game\.multiplierBps\);/);
    assert.match(page, /board\.addEventListener\('focusin'/);
    assert.match(css, /\.tower\[data-render="3d"\] \.tower__board \{\n  position: absolute;\n  inset: 0;\n  opacity: 0;\n  pointer-events: none;\n\}/);
    // The raycaster does not know what is hidden; a hidden chest never takes a click.
    assert.match(tower, /if \(c\.tile >= tiles \|\| !c\.group\.visible\) continue;/);
  });
});
