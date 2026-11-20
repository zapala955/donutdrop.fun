import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

const repo = path.resolve(import.meta.dirname, '../../..');
const front = (relative: string) => readFile(path.join(repo, 'DONUTDROP FRONTEND/Donut Drop', relative), 'utf8');
const img = (relative: string) => path.join(repo, 'DONUTDROP FRONTEND/Donut Drop/assets/img', relative);

describe('coinflip in 3D', () => {
  it('tosses a gold-and-iron coin off the game’s own anvil', async () => {
    const coin = await front('assets/js/coin3d.js');
    const body = coin.match(/const BLOCKS = \[([^;]+)\];/)?.[1] ?? '';
    const blocks = [...body.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]!);
    for (const name of ['anvil', 'anvil_top', 'gold_block', 'iron_block']) assert.ok(blocks.includes(name), name);
    for (const name of blocks) assert.ok(existsSync(img(`block/${name}.png`)), `block ${name}`);
    for (const [, file] of coin.matchAll(/loadImage\('assets\/img\/([^']+)'\)/g)) assert.ok(existsSync(img(file!)), file);
    // template_anvil's four elements, from and to as the block model has them.
    for (const element of ['[2, 0, 2], [14, 4, 14]', '[4, 4, 3], [12, 5, 13]', '[6, 5, 4], [10, 10, 12]', '[3, 10, 0], [13, 16, 16]']) {
      assert.ok(coin.includes(`part(${element}`), element);
    }
    // Whole turns for Heads (gold up), a half more for Tails (iron up): the face at rest is the result.
    assert.match(coin, /const total = Math\.PI \* 2 \* TURNS \+ \(result === 'tails' \? Math\.PI : 0\);/);
    // Up and down and settled in the flat coin's 2.2 seconds.
    assert.match(coin, /const TOSS_MS = 1700;/);
    assert.match(coin, /const SETTLE_MS = 500;/);
  });

  it('is flat since Coinflip became a flip against the house (2026-11-20): no scene, the flat coin lands the result', async () => {
    const [page, css] = await Promise.all([front('assets/js/coinflip.js'), front('assets/css/coinflip.css')]);
    assert.doesNotMatch(page, /coin3d|view3d/);
    // Five turns, and a half more when the side changes: the face at rest is the result.
    assert.match(page, /const end = turn \+ 5 \* 360 \+ \(\(target - turn \+ 360\) % 360\);/);
    assert.match(css, /\.cflip__face--tails \{\n  transform: rotateX\(180deg\);/);
  });
});
