import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

const frontend = path.resolve(import.meta.dirname, '../../../DONUTDROP FRONTEND/Donut Drop');
const read = async (file: string) => (await readFile(path.join(frontend, file), 'utf8')).replace(/\r\n/g, '\n');

/* 2026-11-10: on a phone, a tap painted controls in the browser's blue wash and a double tap or a
 * long press selected a button's label; on a desktop a click on Limbo's bet button left a text
 * caret blinking in the empty hint under it. */
describe('touching the controls', () => {
  it('paints no tap wash anywhere', async () => {
    const css = await read('assets/css/app.css');
    assert.match(css, /html \{\n\s*-webkit-tap-highlight-color: transparent;\n\}/);
  });

  it('never selects a control', async () => {
    const css = await read('assets/css/app.css');
    const rule = css.slice(css.indexOf(':where(button, [role="button"]'));
    assert.match(rule.slice(0, 300), /user-select: none;/);
    assert.match(rule.slice(0, 300), /-webkit-touch-callout: none;/);
  });

  it('keeps every game screen free of selection and caret, and only the game screens', async () => {
    const [css, html] = await Promise.all([read('assets/css/app.css'), read('index.html')]);
    const start = css.indexOf(':where(#upgRoot');
    const block = css.slice(start, css.indexOf('{', start));
    const listed = new Set(block.match(/#[A-Za-z]+Root/g));
    // Every game view's root. A game added to the site has to be added here, or it will flash blue.
    const games = [
      'upgrader', 'roulette', 'blackjack', 'crash', 'mines', 'tower', 'chicken', 'plinko', 'dice', 'limbo',
      'fishing', 'derby', 'ore-rush', 'monument', 'mines-duel', 'coinflip', 'skill-duel', 'crates', 'battles',
    ];
    for (const view of games) {
      const at = html.search(new RegExp(`<section[^>]*data-view="${view}"`));
      assert.ok(at >= 0, `no section for ${view}`);
      const root = /id="([A-Za-z]+Root)"/.exec(html.slice(at, html.indexOf('</section>', at)))?.[1];
      assert.ok(root, `no root in ${view}`);
      assert.ok(listed.has(`#${root}`), `${view} (#${root}) is not covered`);
    }
    // Pages that are there to be copied from keep their text selectable.
    for (const page of ['#fairRoot', '#referRoot', '#discordRoot', '#rewardsRoot', '#dailyRoot']) {
      assert.ok(!listed.has(page), `${page} must stay selectable`);
    }
    const rule = css.slice(start, css.indexOf('}', start));
    assert.match(rule, /user-select: none;/);
    assert.match(rule, /caret-color: transparent;/);
    // What you type into keeps its caret and its selection.
    const back = css.slice(css.indexOf(':is(input, textarea, select) {'));
    assert.match(back.slice(0, 200), /user-select: text;\n\s*caret-color: auto;/);
  });
});
