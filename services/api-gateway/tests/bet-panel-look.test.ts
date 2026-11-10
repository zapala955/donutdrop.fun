import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

/* The betting panel (2026-11-10). The stages went flat and cool-dark game by game; the panel beside
 * them kept the crate page's warm brown (dopamine.css warms the control steps and lays a brown ramp
 * on the frame) and a gold gradient on whatever was picked. One block in luxe-games.css now puts
 * every game's panel on the stages' obsidian: luxe.css's cool control steps when no theme is picked,
 * flat gold for a pick, and keys on a lip that press in. */

const frontend = path.resolve(import.meta.dirname, '../../../DONUTDROP FRONTEND/Donut Drop');
const read = async (file: string) => (await readFile(path.join(frontend, file), 'utf8')).replace(/\r\n/g, '\n');
const block = async () => {
  const css = await read('assets/css/luxe-games.css');
  return css.slice(css.indexOf('/* ═════════ the betting panel (2026-11-10) ═════════'));
};
const PANELS = '.crash__panel, .crash__players, .mines__panel, .tower__panel, .chicken__panel, .dice__panel, .limbo__panel, .fishing__panel, .icefish__panel, .derby__panel, .slots__panel, .plinko__panel, .ug__panel, .bj__controls';

describe('the betting panel', () => {
  it('stands on the stages’ cool obsidian, and leaves a picked theme its own ladder', async () => {
    const css = await block();
    assert.ok(css.length > 1000, 'the block is missing');
    assert.ok(css.includes(`:root:not([data-lxtheme]) body.lx .view :is(${PANELS}) {\n  --lx-3: #24242b;\n  --lx-4: #2f2f38;\n  --lx-5: #3a3a45;\n}`));
    assert.ok(css.includes(`body.lx .view :is(${PANELS}) {\n  --dd-ramp: var(--lx-gold);`));
    assert.match(css, /--bp-lip: rgba\(0, 0, 0, \.5\);\n\s*--bp-ease: cubic-bezier\(\.22, 1, \.36, 1\);\n\s*background: var\(--lx-2\);/);
    // The only raw colours are the tokens at the top.
    const rules = css.slice(css.indexOf('/* The stake well'));
    assert.doesNotMatch(rules, /#[0-9a-fA-F]{3,8}\b|rgba?\(/, 'a raw colour outside the token block');
  });

  it('sets ½, 2× and Max into the well as keys, and every pick on a lip that presses in', async () => {
    const css = await block();
    assert.match(css, /\.bj__adj, \.mines__step\) \{\n\s*align-self: center;\n\s*height: 32px; min-width: 42px; margin: 0 0 2px 4px;[\s\S]*?box-shadow: 0 2px 0 var\(--bp-lip\);/);
    assert.match(css, /\.mines__step\):active:not\(:disabled\) \{\n\s*transform: translateY\(2px\); box-shadow: 0 0 0 var\(--bp-lip\);/);
    assert.match(css, /\.ug__bands \.bandchip\) \{\n\s*border: 0; border-radius: 6px;\n\s*background: var\(--lx-4\); color: var\(--lx-ink\);\n\s*box-shadow: 0 3px 0 var\(--bp-lip\);/);
    assert.match(css, /\[aria-pressed="true"\]:hover:not\(:disabled\) \{\n\s*background: var\(--lx-gold\); color: var\(--lx-on-gold\);\n\s*box-shadow: 0 3px 0 var\(--lx-gold-lo\);/);
    assert.match(css, /:is\(\.tower__modes, \.chicken__modes, \.plinko__risks\)::before \{ box-shadow: 0 2px 0 var\(--lx-gold-lo\); \}/);
  });

  it('meets the stage along a hairline, and holds still for reduced motion', async () => {
    const css = await block();
    assert.match(css, /\.plinko__panel\) \{\n\s*box-shadow: inset -1px 0 0 var\(--lx-3\);\n\}/);
    assert.match(css, /@media \(max-width: 1023px\) \{[\s\S]*?box-shadow: inset 0 1px 0 var\(--lx-3\);/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\{ transition: none; \}[\s\S]*?:active:not\(:disabled\) \{ transform: none; \}/);
  });
});
