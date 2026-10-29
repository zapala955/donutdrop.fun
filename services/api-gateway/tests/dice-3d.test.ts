import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

const repo = path.resolve(import.meta.dirname, '../../..');
const front = (relative: string) => readFile(path.join(repo, 'DONUTDROP FRONTEND/Donut Drop', relative), 'utf8');
const img = (relative: string) => path.join(repo, 'DONUTDROP FRONTEND/Donut Drop/assets/img', relative);

describe('dice in 3D', () => {
  it('builds the range only from the game’s own pictures and models', async () => {
    const range = await front('assets/js/dice3d.js');
    const quoted = (list: string) => {
      const body = range.match(new RegExp(`const ${list} = \\[([^;]+)\\];`))?.[1] ?? '';
      return [...body.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]!);
    };
    for (const name of quoted('BLOCKS')) assert.ok(existsSync(img(`block/${name}.png`)), `block ${name}`);
    for (const name of quoted('ITEMS')) assert.ok(existsSync(img(`items/${name}.png`)), `item ${name}`);
    assert.deepEqual(quoted('ITEMS'), ['bow', 'bow_pulling_0', 'bow_pulling_1', 'bow_pulling_2']);
    for (const name of quoted('PARTICLE')) assert.ok(existsSync(img(`particle/${name}.png`)), `particle ${name}`);
    for (let i = 0; i < 8; i += 1) assert.ok(existsSync(img(`particle/spark_${i}.png`)), `spark_${i}`);
    for (const [, file] of range.matchAll(/loadImage\('assets\/img\/([^']+)'\)/g)) assert.ok(existsSync(img(file!)), file);
    assert.ok(range.includes('{ material: steveMat, def: PLAYER }'));
    // The wall runs 0 to 100 across twenty blocks; the arrow lands where the roll says.
    assert.match(range, /export const xOf = \(value\) => -WALL \/ 2 \+ \(value \/ SPAN\) \* WALL;/);
    assert.match(range, /const to = new THREE\.Vector3\(xOf\(roll\),/);
    // The winning side is lime, whichever side of the line that is.
    assert.match(range, /const winLeft = side === 'under';/);
  });

  it('sits over the track, never instead of it, and shows a roll that already exists', async () => {
    const [range, page, css] = await Promise.all([front('assets/js/dice3d.js'), front('assets/js/dice.js'), front('assets/css/dice.css')]);
    assert.match(range, /import \{ BRIGHTNESS, chooseTier, createGovernor, frameMs, minFpsFor, ratioFor \} from '\.\/quality3d\.js';/);
    for (const use of ['tier.particles', 'tier.composer', 'tier.antialias', 'tier.samples', 'frameMs(tier)', 'minFpsFor(tier)']) assert.ok(range.includes(use), use);
    assert.match(page, /await import\('\.\/dice3d\.js'\)/);
    assert.match(page, /return range3d\.shoot\(bet\.roll, bet\.win, bet\.multiplierBps\);/);
    assert.match(page, /range3d\?\.setLine\(target, direction\);/);
    // The slider stays where it is: the scene is a row above the board, hidden in 2D.
    assert.match(page, /<div class="dice__scene"><\/div>\n\n\s*<div class="dice__board">/);
    assert.match(css, /\.dice__scene \{ display: none; \}/);
  });
});
