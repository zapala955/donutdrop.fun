import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

/* Blackjack's controls on a phone (2026-11-10). Through a hand the stake box and a "Deal again"
 * stayed on screen, because the frame's grid outranked the plain [hidden] rule; Hit sat half under
 * the bottom bar and Stand and Double were below the fold. Now one set of controls shows at a time,
 * the table gives up height so the moves fit the screen, and Hit and Stand sit side by side. */

const frontend = path.resolve(import.meta.dirname, '../../../DONUTDROP FRONTEND/Donut Drop');
const read = async (file: string) => (await readFile(path.join(frontend, file), 'utf8')).replace(/\r\n/g, '\n');
// The phone block that lays the table out (other sheets' phone blocks come and go around it).
const phone = (css: string) => {
  const at = css.lastIndexOf('@media (max-width: 1023px) {', css.indexOf('body.lx .bj { grid-template-columns: minmax(0, 1fr);'));
  return css.slice(at, css.indexOf('\n}\n', at));
};

describe('the blackjack controls', () => {
  it('shows the stake and the deal, or the moves, never both', async () => {
    const page = await read('assets/js/blackjack.js');
    assert.match(page, /\$\('#bjBetting', root\)\.hidden = inPlay;\n\s*\$\('#bjActions', root\)\.hidden = !inPlay;/);
    const frame = await read('assets/css/luxe-games.css');
    assert.match(frame, /body\.lx \.bj__betting\[hidden\], body\.lx \.bj__actions\[hidden\] \{ display: none; \}/);
    // The rule that hides must come after the one that lays the form out, or the grid wins again.
    assert.ok(frame.indexOf('body.lx .bj__betting[hidden]') > frame.indexOf('body.lx .bj__betting { display: grid;'));
  });

  it('fits the moves on a phone screen: a table that gives up height, Hit beside Stand, Double below', async () => {
    const block = phone(await read('assets/css/luxe-games.css'));
    assert.match(block, /body\.lx \.bj__table \{\s*min-height: clamp\(304px, calc\(100dvh - 308px - env\(safe-area-inset-bottom\)\), 480px\);/);
    assert.match(block, /body\.lx \.bj__controls \{ min-height: 164px; \}/);
    assert.match(block, /body\.lx \.bj__actions \{ grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\);/);
    assert.match(block, /body\.lx \.bj__actions \.btn \{ height: 56px; margin-top: 0;/);
    assert.match(block, /body\.lx \.bj__actions #bjDouble \{ grid-column: 1 \/ -1; height: 48px;/);
    // The arc is unreadable at this size, so the line under it carries both payouts.
    assert.match(block, /body\.lx \.bj__felt \{ display: none; \}\n\s*body\.lx \.bj__rules-tie \{ display: inline; \}/);
    const page = await read('assets/js/blackjack.js');
    assert.match(page, /<span class="bj__rules-tie">Wins pay 1\.8× · Blackjack pays 2\.5× · <\/span>/);
  });

  /* 2026-11-10: "the blackjack doesnt fit the sites premium theme at all". The emerald felt became the
   * site's warm obsidian under one lamp, the print a gold-lined band, the backs a gold lattice with the
   * pixel donut, the bet a chip; and the frame's shadow no longer boxes the print in. */
  it('is a card room in the site\'s obsidian and gold, not a green felt', async () => {
    const css = await read('assets/css/blackjack.css');
    const tokens = css.slice(css.indexOf('.bj {'), css.indexOf('\n}\n', css.indexOf('.bj {')));
    const felts = [...tokens.matchAll(/--bj-(felt(?:-hi|-lo)?): (#[0-9a-f]{6});/g)];
    assert.equal(felts.length, 3);
    for (const [, name, value] of felts) {
      const [r, g, b] = [1, 3, 5].map((at) => parseInt(value!.slice(at, at + 2), 16));
      assert.ok(r! >= g! && g! >= b!, `--bj-${name} is warm, not green: ${value}`);
    }
    assert.doesNotMatch(css, /#0c2a21|#134133|#06140f/);
    assert.match(css, /\.bjcard__back \{[\s\S]*?url\("\.\.\/img\/brand\/donut\.svg"\)/);
    assert.match(css, /\.bj__bet::before \{[\s\S]*?repeating-conic-gradient/);
    const page = await read('assets/js/blackjack.js');
    assert.equal(page.split('class="bj__inlay"').length - 1, 2, 'two gold lines round the printed band');
    assert.match(page, /box\.dataset\.outcome = current\.outcome/);
    const frame = await read('assets/css/luxe-games.css');
    assert.doesNotMatch(frame, /\.bj__felt, \.mduel__panel/, 'no shadow boxing the print in');
    assert.doesNotMatch(frame, /body\.lx \.bj__result \{/, 'the result plate is drawn in blackjack.css');
    assert.match(frame, /:root\[data-lxtheme\] \.bj \{\n\s*--bj-felt: var\(--lx-1\);/);
  });

  it('makes the buttons finger-sized things that press in, and leaves no hover behind after a tap', async () => {
    const frame = await read('assets/css/luxe-games.css');
    assert.match(frame, /body\.lx \.bj :is\(\.bj__deal, \.bj__actions \.btn\) \{\n\s*touch-action: manipulation; -webkit-tap-highlight-color: transparent; user-select: none;\n\s*box-shadow: 0 4px 0 var\(--bj-lip\);/);
    assert.match(frame, /body\.lx \.bj :is\(\.bj__deal, \.bj__actions \.btn\):active:not\(:disabled\) \{ transform: translateY\(3px\); box-shadow: 0 1px 0 var\(--bj-lip\); \}/);
    assert.match(frame, /@media \(hover: hover\) \{\n\s*body\.lx \.bj__actions \.btn:not\(\.btn--go\):hover:not\(:disabled\) \{ background: var\(--lx-5\); \}\n\}/);
    assert.match(frame, /@media \(prefers-reduced-motion: reduce\) \{\n\s*body\.lx \.bj :is\(\.bj__deal, \.bj__actions \.btn\) \{ transition: none; \}/);
  });
});
