import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

/* Tower's casino-floor look (2026-11-09): a gold frame that climbs with the player, tiles that flip
 * over to their gem or TNT, the rest of the tower turning over when a climb ends, a win card that
 * counts up, a sliding difficulty pill, and the tower's own sounds. Flat: no glow, no loss banner. */

const frontend = path.resolve(import.meta.dirname, '../../../DONUTDROP FRONTEND/Donut Drop');
const read = async (file: string) => (await readFile(path.join(frontend, file), 'utf8')).replace(/\r\n/g, '\n');

describe('the tower table', () => {
  it('frames the floor being climbed and slides the frame up as the player climbs', async () => {
    const [page, css] = await Promise.all([read('assets/js/tower.js'), read('assets/css/tower.css')]);
    assert.match(page, /<div class="tower__cursor" aria-hidden="true"><\/div>/);
    assert.match(page, /if \(inPlay\(\)\) board\.style\.setProperty\('--at', String\(current\)\);/);
    assert.match(css, /transform: translateY\(calc\(var\(--at, 0\) \* -1 \* \(var\(--tower-tile-h\) \+ var\(--tower-gap\)\)\)\);/);
    assert.match(css, /\.tower__board\[data-state="play"\] \.tower__cursor \{ opacity: 1; \}/);
  });

  it('turns tiles over, reveals the rest of the tower when a climb ends, and pops a win card only on a win', async () => {
    const page = await read('assets/js/tower.js');
    assert.match(page, /tileNode\(floor, tile\)\?\.animate\(FLIP, \{ duration: 340, easing: EASE \}\);/);
    assert.match(page, /await wait\(320\);\n\s*revealRest\(floor, 0\);/);
    assert.match(page, /countUp\(\$\('span', banner\), Number\(game\.payoutMinor\), 650\);\n\s*revealRest\(game\.picks\.length, 160\);/);
    assert.match(page, /if \(over\(\) && game\.outcome === 'cashout'\) \{\n\s*banner\.hidden = false;/);
    // No line of text over the tower.
    assert.doesNotMatch(page, /towerNow|towerNext|paintReadout/);
  });

  it('has its own sounds, a gem ringing higher the higher the floor', async () => {
    const [page, audio] = await Promise.all([read('assets/js/tower.js'), read('assets/js/audio-engine.js')]);
    for (const cue of ['towerTap', 'towerStart', 'towerGem', 'towerClimb', 'towerBoom', 'towerReveal', 'towerCash']) {
      assert.match(audio, new RegExp(`\\n  ${cue}\\(ctx\\) \\{`), cue);
      assert.ok(page.includes(`'${cue}'`), `tower.js plays ${cue}`);
    }
    assert.match(page, /playSound\('towerGem', \{ rate: 1 \+ floor \* 0\.07 \}\);/);
    // A tile's press is the pick's own tap, not every button's click.
    assert.match(page, /button\.dataset\.sfx = 'none';/);
  });

  it('slides a gold pill under the difficulty and is still for reduced motion', async () => {
    const [page, css] = await Promise.all([read('assets/js/tower.js'), read('assets/css/tower.css')]);
    assert.match(page, /\$\('\.tower__modes', root\)\.style\.setProperty\('--mode-i', String\(MODE_NAMES\.indexOf\(name\)\)\);/);
    assert.match(css, /transform: translateX\(calc\(var\(--mode-i, 0\) \* 100%\)\);/);
    assert.doesNotMatch(css, /blur\(|drop-shadow|text-shadow/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\.tower__cursor,[\s\S]*\.ttile\[data-kind="boom"\]::after,/);
    for (const motion of ['function wake()', 'function gem(', 'async function boom(']) {
      const body = page.slice(page.indexOf(motion), page.indexOf('\n}\n', page.indexOf(motion)));
      assert.match(body, /reduceMotion\(\)\) return;/, motion);
    }
  });
});
