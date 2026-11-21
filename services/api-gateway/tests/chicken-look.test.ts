import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

/* Chicken's casino-floor look (2026-11-10): a block on every lane carrying its price, the chicken
 * hopping from block to block, the minecart coming down on a hit, a win card that counts up on a
 * cash-out, a sliding difficulty pill, and the road's own sounds. Flat: no glow, no line of text over
 * the road, no loss banner. */

const frontend = path.resolve(import.meta.dirname, '../../../DONUTDROP FRONTEND/Donut Drop');
const read = async (file: string) => (await readFile(path.join(frontend, file), 'utf8')).replace(/\r\n/g, '\n');

describe('the chicken road', () => {
  it('has no line of text over the road, and a card on a cash-out only', async () => {
    const page = await read('assets/js/chicken.js');
    assert.doesNotMatch(page, /chickenNow|chickenNext|paintReadout|chicken__readout/);
    assert.match(page, /if \(over\(\) && game\.outcome === 'cashout'\) \{\n\s*banner\.hidden = false;/);
    assert.match(page, /countUp\(\$\('span', banner\), Number\(game\.payoutMinor\), 650\);/);
    assert.doesNotMatch(page, /'Minecart'|data-tone="lost"|dataset\.tone = won/);
  });

  it('hops in an arc onto a block that presses in, and knocks the chicken over when the minecart lands', async () => {
    const page = await read('assets/js/chicken.js');
    assert.match(page, /\$\('#chickenHen img', root\)\?\.animate\(HOP, \{ duration: HOP_MS, easing: 'linear' \}\);\n\s*pressBlock\(laneNode\(lane\), LAND_MS\);/);
    assert.match(page, /\$\('#chickenHen img', root\)\?\.animate\(KNOCKED, \{ duration: 900, easing: 'linear' \}\);\n\s*feathers\(lane, CART_HITS_MS\);/);
    // The feathers are thrown round a circle, not at random.
    assert.doesNotMatch(page, /Math\.random/);
    // The lit block is a second Go.
    assert.match(page, /if \(lane && inPlay\(\) && !busy && Number\(lane\.dataset\.lane\) === game\.crossed\) void step\(\);/);
  });

  it('has its own sounds, a landing that rings higher every lane', async () => {
    const [page, audio] = await Promise.all([read('assets/js/chicken.js'), read('assets/js/audio-engine.js')]);
    for (const cue of ['chickenStart', 'chickenHop', 'chickenLand', 'chickenCart', 'chickenCrash', 'chickenReveal', 'chickenCash']) {
      assert.match(audio, new RegExp(`\\n  ${cue}\\(ctx\\) \\{`), cue);
      assert.ok(page.includes(`'${cue}'`), `chicken.js plays ${cue}`);
    }
    assert.match(page, /playSound\('chickenLand', \{ rate: 1 \+ lane \* 0\.045 \}\)/);
    // Go and Cash out play the run's own sounds, not every button's click.
    assert.match(page, /id="chickenGo" type="submit" data-tone="go" data-sfx="none"/);
    assert.match(page, /id="chickenCash" type="button" data-sfx="none" hidden/);
  });

  it('is flat: no blur, no drop shadow, a sliding pill, buttons on a lip, and still under reduced motion', async () => {
    const css = await read('assets/css/chicken.css');
    assert.doesNotMatch(css, /blur\(|drop-shadow|text-shadow/);
    assert.match(css, /transform: translate\(calc\(var\(--mode-x, 0\) \* 100%\), calc\(var\(--mode-y, 0\) \* 100%\)\);/);
    assert.match(css, /body\.lx \.chicken \.chicken__mode\[aria-checked="true"\] \{ background: transparent; box-shadow: none; \}/);
    assert.match(css, /body\.lx #chickenGo:active:not\(:disabled\) \{ transform: translateY\(3px\);/);
    assert.match(css, /body\.lx #chickenCash:active:not\(:disabled\) \{ transform: translateY\(3px\);/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[^]*\.chicken__hen img,[^]*animation: none;/);
  });
});
