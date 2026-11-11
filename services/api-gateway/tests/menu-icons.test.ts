import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

/* The menu's icons (2026-11-10). The owner: "the icons on the left look a bit goofy". They were drawn
 * by hand, one at a time -- a blob for the chicken, a triangle for the fishing rod, bricks for the
 * tower -- each in its own proportions. They are now one family, Phosphor (MIT), at one weight: a
 * filled path on a 256 grid for every icon in the rail, the phone's bottom bar and the lobby's tabs
 * beside them. */

const frontend = path.resolve(import.meta.dirname, '../../../DONUTDROP FRONTEND/Donut Drop');
const read = async (file: string) => (await readFile(path.join(frontend, file), 'utf8')).replace(/\r\n/g, '\n');
const between = (text: string, start: string, end: string) => {
  const at = text.indexOf(start);
  assert.ok(at >= 0, `${start} is missing`);
  return text.slice(at, text.indexOf(end, at));
};

describe('the menu icons', () => {
  it('draws every icon in the rail, the bottom bar and the lobby tabs from one family', async () => {
    const html = await read('index.html');
    const surfaces = [
      between(html, '<aside class="lxside"', '</aside>'),
      between(html, '<nav class="lxdock"', '</nav>'),
      between(html, '<div class="lxtabs__track"', '</div>'),
    ];
    let count = 0;
    for (const surface of surfaces) {
      for (const [svg] of surface.matchAll(/<svg[\s\S]*?<\/svg>/g)) {
        count += 1;
        assert.match(svg, /^<svg viewBox="0 0 256 256" aria-hidden="true"><path d="[^"]+"\/><\/svg>$/, svg.slice(0, 90));
      }
    }
    // 30 in the rail (Wager Race came off on 2026-11-11), 5 in the bottom bar, 5 lobby tabs.
    assert.equal(count, 40);
  });

  it('fills them in the text colour, and gold when they are the page you are on', async () => {
    const luxe = await read('assets/css/luxe.css');
    assert.match(luxe, /Phosphor glyphs \(MIT licence, Copyright \(c\) 2023 Phosphor Icons/);
    for (const rule of ['.lxside__burger svg { width: 22px; height: 22px; fill: currentColor; }',
      '.lxmode svg { flex: none; width: 20px; height: 20px; fill: currentColor; }',
      '.lxnav svg { flex: none; width: 20px; height: 20px; fill: currentColor; }',
      '.lxdock__btn svg { width: 22px; height: 22px; fill: currentColor; }',
      '.lxdock__btn[aria-current="page"] svg, .lxdock__btn[aria-expanded="true"] svg { fill: var(--lx-gold); }']) {
      assert.ok(luxe.includes(rule), rule);
    }
    const home = await read('assets/css/luxe-home.css');
    assert.ok(home.includes('.lxtab svg { width: 18px; height: 18px; fill: currentColor; }'));
    assert.ok(home.includes('.lxtab[aria-pressed="true"] svg { fill: var(--lx-gold); }'));
  });
});
