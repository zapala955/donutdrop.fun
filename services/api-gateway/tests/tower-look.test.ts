import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

/* Tower's casino-floor look (2026-11-09): tiles that flip
 * over to their gem or TNT, the rest of the tower turning over when a climb ends, a win card that
 * counts up, a sliding difficulty pill, and the tower's own sounds. Flat: no glow, no loss banner. */

const frontend = path.resolve(import.meta.dirname, '../../../DONUTDROP FRONTEND/Donut Drop');
const read = async (file: string) => (await readFile(path.join(frontend, file), 'utf8')).replace(/\r\n/g, '\n');

describe('the tower table', () => {
  it('marks the floor being climbed by its tiles alone, with no frame round it (the operator’s call)', async () => {
    const [page, css] = await Promise.all([read('assets/js/tower.js'), read('assets/css/tower.css')]);
    assert.doesNotMatch(page, /tower__cursor|'--at'/);
    assert.doesNotMatch(css, /tower__cursor|var\(--at/);
    assert.match(css, /body\.lx \.tower \.tfloor\[data-state="now"\] \.ttile\[data-kind="hidden"\] \{ background: var\(--lx-4\); \}/);
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
    assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\.tower__modes::before,[\s\S]*\.ttile\[data-kind="boom"\]::after,/);
    for (const motion of ['function wake()', 'function gem(', 'async function boom(']) {
      const body = page.slice(page.indexOf(motion), page.indexOf('\n}\n', page.indexOf(motion)));
      assert.match(body, /reduceMotion\(\)\) return;/, motion);
    }
  });
});
