import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

/* The flat wheel is the preview's (2026-11-21, the owner: "roulette"): drawn on a canvas, always
 * turning slowly, the ball resting in the last pocket. A spin kicks the wheel faster and runs the
 * ball round the track against it, off the track, over the frets, into the pocket the server named.
 * Still no pointer: it is a roulette wheel, not a prize wheel. */

const frontend = path.resolve(import.meta.dirname, '../../../DONUTDROP FRONTEND/Donut Drop');
const read = async (file: string) => (await readFile(path.join(frontend, file), 'utf8')).replace(/\r\n/g, '\n');

describe('the roulette ball', () => {
  it('is the preview\'s wheel, on a canvas, with a ball and no pointer', async () => {
    const page = await read('assets/js/roulette.js');
    assert.match(page, /<canvas class="roulette__wheel" id="rouletteWheel" width="\$\{WHEEL_PX\}" height="\$\{WHEEL_PX\}" aria-hidden="true"><\/canvas>/);
    assert.doesNotMatch(page, /roulette__pointer/);
    // The turning part is drawn once; every frame only turns it and puts the ball on it.
    assert.match(page, /ctx\.rotate\(wheelAngle\);\n\s*ctx\.drawImage\(wheelImg, -c0, -c0\);/);
    assert.match(page, /const a = wheelAngle \+ ballAngle;/);
  });

  it('lands in the pocket the server named, whatever the frame rate', async () => {
    const page = await read('assets/js/roulette.js');
    /* The ball is placed in the wheel's own frame and its run is measured to end on the pocket: the
       run's last angle is the pocket's angle plus whole turns, and at the end it is put exactly there. */
    assert.match(page, /const ahead = \(\(\(target - from\) % TAU\) \+ TAU\) % TAU;/);
    assert.match(page, /ballRun = \{ from, delta: ahead - TAU \* turns, started: performance\.now\(\), ms \};/);
    assert.match(page, /ballAngle = ballRun\.from \+ ballRun\.delta \* \(1 - \(1 - k\) \*\* 3\);/);
    assert.match(page, /function settleBall\(index\) \{\n\s*ballRun = null;\n\s*ballPocket = index;\n\s*ballAngle = pocketAngle\(index\);/);
    // Run for the wheel's own spin, and settled in the pocket when it stops.
    assert.match(page, /if \(!wheel3d\) rollBall\(index, animationMs\);/);
    assert.match(page, /wheel\.classList\.remove\('is-spinning'\);\n\s*settleBall\(index\);/);
    // Still no source of chance in the page.
    assert.doesNotMatch(page, /Math\.random|crypto\.getRandomValues/);
  });

  it('runs on the track and rests in the pocket ring the canvas draws', async () => {
    const page = await read('assets/js/roulette.js');
    const radius = (name: string) => Number(new RegExp(`const ${name} = (\\d+);`).exec(page)?.[1]);
    const [track, numOuter, numInner, pocketInner, rest] = ['TRACK', 'NUM_O', 'NUM_I', 'POCK_I', 'REST'].map(radius) as [
      number, number, number, number, number,
    ];
    assert.ok(track > numOuter, 'the track is outside the numbers');
    assert.ok(rest > pocketInner && rest < numInner, 'a ball at rest sits in the pocket ring');
    assert.match(page, /if \(k < 0\.58\) return TRACK;/);
  });

  it('stops drawing when nobody can see it', async () => {
    const page = await read('assets/js/roulette.js');
    assert.match(page, /if \(!root\?\.isConnected \|\| root\.closest\('\.view'\)\?\.hidden \|\| wheel3d\) return;/);
    assert.match(page, /if \(speed > 0 \|\| ballRun\) wheelRaf = requestAnimationFrame\(turnWheel\);/);
  });
});
