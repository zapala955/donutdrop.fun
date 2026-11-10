import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

/* The flat wheel is a roulette wheel (2026-11-10): no pointer, a ball that runs round the track
 * against the wheel, falls in and rides the winning pocket to the top as the wheel stops. */

const frontend = path.resolve(import.meta.dirname, '../../../DONUTDROP FRONTEND/Donut Drop');
const read = async (file: string) => (await readFile(path.join(frontend, file), 'utf8')).replace(/\r\n/g, '\n');

describe('the roulette ball', () => {
  it('has a ball and no pointer', async () => {
    const page = await read('assets/js/roulette.js');
    assert.match(page, /<div class="roulette__orbit" id="rouletteOrbit" aria-hidden="true"><span class="roulette__ball" id="rouletteBall"><\/span><\/div>/);
    assert.doesNotMatch(page, /<span class="roulette__pointer"/);
  });

  it('lands in the pocket the server named, read off the wheel as it is drawn', async () => {
    const page = await read('assets/js/roulette.js');
    // Where the pocket really is, every frame: the wheel's own transform plus the pocket's place on it.
    assert.match(page, /const pocket = wheelAngleNow\(wheel\) \+ index \* step;/);
    assert.match(page, /const pull = t < 0\.72 \? 0 : t > 0\.88 \? 1 : \(t - 0\.72\) \/ 0\.16;/);
    // Run for the wheel's own spin, and put exactly at the top of its pocket when it stops.
    assert.match(page, /if \(!wheel3d\) rollBall\(index, animationMs\);/);
    assert.match(page, /cancelAnimationFrame\(ballFrame\);\n\s*placeBall\(0, BALL_POCKET\);/);
    // Still no source of chance in the page.
    assert.doesNotMatch(page, /Math\.random|crypto\.getRandomValues/);
  });

  it('runs on the track the bowl draws and rests in the pocket ring', async () => {
    const [page, css] = await Promise.all([read('assets/js/roulette.js'), read('assets/css/roulette.css')]);
    assert.match(page, /const BALL_TRACK = 0\.462;/);
    assert.match(page, /const BALL_POCKET = 0\.272;/);
    // The wheel is inset 7.5%, so its edge is at 0.425 of the width and the track band runs out to the rim.
    assert.match(css, /\.roulette__wheel \{\n  position: absolute;\n  inset: 7\.5%;/);
    assert.match(css, /top: calc\(\(0\.5 - var\(--r, 0\.272\)\) \* 100%\);/);
  });
});
