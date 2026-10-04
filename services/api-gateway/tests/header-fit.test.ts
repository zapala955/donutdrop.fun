import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

/*
 * The desktop header is one row whose right half never shrinks, and its width depends on content
 * nobody controls: the VIP label, the username, the balance. The nav to its left scrolls with its
 * scrollbar hidden, so when the row ran out of room the last nav items simply vanished -- the
 * Discord pill on a 1536px screen, the invite pill with it at 1280px.
 *
 * ui.js now measures the row and sheds labels in a fixed order until it fits; obsidian.css says what
 * each step hides. These pin the two halves to each other: a step the script takes that the sheet
 * does not style would be a step that frees no room.
 */
const root = path.resolve(import.meta.dirname, '../../..');
const read = (file: string) => readFile(path.join(root, file), 'utf8');

describe('header fit', () => {
  it('sheds labels in order until the nav fits, and only on desktop', async () => {
    const ui = await read('DONUTDROP FRONTEND/Donut Drop/assets/js/ui.js');
    const steps = /const HEADER_STEPS = \[([^\]]+)\];/.exec(ui)?.[1];
    assert.ok(steps, 'the steps are declared');
    const names = [...steps.matchAll(/'([a-z]+)'/g)].map((match) => match[1] ?? '');
    // Words and decoration before controls; the money labels last of all.
    assert.equal(names[0], 'dc');
    assert.equal(names.at(-1), 'money');
    assert.match(ui, /const fits = \(\) => tabs\.scrollWidth <= tabs\.clientWidth \+ 1;/);
    assert.match(ui, /window\.matchMedia\('\(min-width: 1081px\)'\)/);
    assert.match(ui, /new ResizeObserver\(schedule\)/);

    const css = await read('DONUTDROP FRONTEND/Donut Drop/assets/css/obsidian.css');
    const block = css.slice(css.indexOf('/* ── the header, fitted ──'));
    assert.match(block, /^[\s\S]*?@media \(min-width: 1081px\) \{/);
    for (const name of names) {
      assert.match(block, new RegExp(`\\.top\\[data-squeeze~="${name}"\\]`), name);
    }
    // Past the last step the nav still scrolls, but its end fades so the cut is visible.
    assert.match(block, /\.top\[data-overflow="1"\] \.tabs \{/);

    const app = await read('DONUTDROP FRONTEND/Donut Drop/assets/js/app.js');
    // After the widgets that fill the header, so the first fit measures real labels.
    assert.ok(app.indexOf('initHeaderFit();') > app.indexOf('initVipWidget();'));
  });
});
