import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

/* Mines' casino-floor look (2026-11-09): flat blocks on a lip, tiles that flip over to their diamond
 * or TNT, the rest of the field turning over in a ripple when a game ends, a win card that counts
 * up, the profit so far in the panel, and its own sounds. Flat: no glow, no loss card, no text over
 * the field. */

const frontend = path.resolve(import.meta.dirname, '../../../DONUTDROP FRONTEND/Donut Drop');
const read = async (file: string) => (await readFile(path.join(frontend, file), 'utf8')).replace(/\r\n/g, '\n');

describe('the mines field', () => {
  it('turns tiles over, ripples the reveal out from the last tile, and pops a win card only on a win', async () => {
    const page = await read('assets/js/mines.js');
    assert.match(page, /tileNode\(index\)\?\.animate\(FLIP, \{ duration: 340, easing: EASE \}\);/);
    assert.match(page, /await wait\(320\);\n\s*revealRest\(index, 0\);/);
    assert.match(page, /const ring = steps\(index, origin\);\n\s*const at = delay \+ ring \* 70;/);
    assert.match(page, /countUp\(\$\('span', banner\), Number\(game\.payoutMinor\), 650\);\n\s*revealRest\(game\.revealed\.at\(-1\) \?\? 12, 160\);/);
    assert.match(page, /if \(over && game\.outcome === 'cashout'\) \{\n\s*banner\.hidden = false;/);
    assert.doesNotMatch(page, /minesNow|minesNext|paintReadout/);
  });

  it('shows the profit in the panel: the first diamond before a game, the profit so far in one', async () => {
    const page = await read('assets/js/mines.js');
    assert.match(page, /<div class="mines__profit" id="minesProfitRow">/);
    assert.match(page, /profit = found \? BigInt\(game\.cashoutMinor\) - BigInt\(game\.stakeMinor\) : 0n;/);
    assert.match(page, /inPlay\(\) \? 'Total profit' : 'Profit on first diamond'/);
    // The preview's panel: the TNT as a list beside the diamonds left, and a button that says Bet.
    assert.match(page, /<select id="minesCount">/);
    assert.match(page, /<output id="minesLeft" for="minesCount">/);
    assert.match(page, /text = 'Bet';/);
  });

  it('has its own sounds, a diamond ringing higher for every one found', async () => {
    const [page, audio] = await Promise.all([read('assets/js/mines.js'), read('assets/js/audio-engine.js')]);
    for (const cue of ['minesTap', 'minesStart', 'minesGem', 'minesBoom', 'minesReveal', 'minesCash']) {
      assert.match(audio, new RegExp(`\\n  ${cue}\\(ctx\\) \\{`), cue);
      assert.ok(page.includes(`'${cue}'`), `mines.js plays ${cue}`);
    }
    assert.match(page, /playSound\('minesGem', \{ rate: 1 \+ Math\.min\(found - 1, 20\) \* 0\.045 \}\);/);
    assert.match(page, /class="mtile" data-tile="\$\{index\}" data-kind="hidden" data-sfx="none"/);
  });

  it('is flat, overrides the crate-card tiles, and is still for reduced motion', async () => {
    const [page, css] = await Promise.all([read('assets/js/mines.js'), read('assets/css/mines.css')]);
    assert.doesNotMatch(css, /blur\(|drop-shadow|text-shadow|radial-gradient\(circle/);
    assert.match(css, /body\.lx \.mines \.mtile\[data-kind="hidden"\] \{ background: var\(--lx-3\);/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*body\.lx \.mines \.mtile\[data-kind="boom"\]::after,/);
    for (const motion of ['function wake()', 'function gem(', 'async function boom(', 'function revealRest(']) {
      const body = page.slice(page.indexOf(motion), page.indexOf('\n}\n', page.indexOf(motion)));
      assert.match(body, /reduceMotion\(\)\) return;/, motion);
    }
  });
});
