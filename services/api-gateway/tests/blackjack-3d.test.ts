import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

/* The 3D blackjack table (blackjack3d.js): the librarian dealing in a village library. It only
 * shows what the server dealt; these hold how it is wired to the flat table it sits on. */

const frontend = path.resolve(import.meta.dirname, '../../../DONUTDROP FRONTEND/Donut Drop');
const source = async (relative: string) =>
  (await readFile(path.join(frontend, relative), 'utf8')).replace(/\r\n/g, '\n');

describe('the 3D blackjack table', () => {
  it('is loaded only when it is wanted, and the 2D/3D choice is remembered', async () => {
    const page = await source('assets/js/blackjack.js');
    // Its own chunk: a player on the flat table never downloads it.
    assert.match(page, /const \{ createTable3d \} = await import\('\.\/blackjack3d\.js'\);/);
    assert.doesNotMatch(page, /^import .*blackjack3d/m);
    assert.match(page, /const wants3d = \(\) => wantsScenes\(\) && globalThis\.DonutPrefs\?\.get\?\.\(\)\.bjView !== '2d';/);
    assert.match(page, /setWants3d\(mode !== '2d'\);/);
    assert.match(page, /<div class="bj__view" id="bjView" role="group" aria-label="Table view">/);
    // No WebGL: the switch goes and the flat table stays.
    assert.match(page, /if \(!built\) \{\s*no3d = true;/);
    assert.match(page, /table3d\.onLost = \(\) => \{\s*table3d = null;\s*delete host\.dataset\.render;/);
  });

  it('puts every card in the DOM as well, and waits for the villager to land it', async () => {
    const page = await source('assets/js/blackjack.js');
    const deliver = page.slice(page.indexOf('async function deliver('), page.indexOf('async function animateDeal('));
    assert.match(deliver, /seat\(which\)\.cards\.append\(slot\);\n\s*if \(table3d\) await table3d\.deal\(which\.toLowerCase\(\), face, \{ delay, sideways \}\);\n\s*else await flyIn\(slot, delay\);/);
    assert.match(page, /await flip\(hole, dealerCards\[1\], 1\);/);
    assert.match(page, /if \(table3d\) await table3d\.collect\(\);\n\s*clearTable\(\);/);
    // A deal or an action never starts against a table that is still being built.
    assert.equal(page.split('if (starting3d) await starting3d;').length - 1, 2);
    const css = await source('assets/css/blackjack.css');
    assert.match(css, /\.bj__table:is\(\[data-render="3d"\], \[data-render="loading"\]\) \.bj__cards \{\s*position: absolute;\s*width: 1px;\s*height: 1px;[\s\S]*?clip: rect\(0 0 0 0\);/);
  });

  it('draws only what it has: every texture it loads is on disk', async () => {
    const table = await source('assets/js/blackjack3d.js');
    const lists = [...table.matchAll(/const (BLOCKS|ENTITY) = \[([^\]]+)\];/g)];
    assert.equal(lists.length, 2);
    for (const [, kind, names] of lists) {
      for (const name of (names ?? '').match(/'([a-z_]+)'/g)!.map((quoted) => quoted.slice(1, -1))) {
        const file = path.join(frontend, 'assets/img', kind === 'BLOCKS' ? 'block' : 'entity', `${name}.png`);
        assert.ok(existsSync(file), `${name}.png`);
      }
    }
    for (const [, file] of table.matchAll(/loadImage\('(assets\/img\/[^']+)'\)/g)) {
      assert.ok(existsSync(path.join(frontend, file!)), file);
    }
    // The dealer is the game's villager model, in the librarian's layers.
    assert.match(table, /'villager', 'villager_plains', 'villager_librarian', 'villager_level_diamond'/);
    assert.match(table, /buildModel\(THREE, \[\n\s*\{ material: skin\(entityImgs\[0\], 0\), def: VILLAGER \}/);
  });

  it('lays the table out in one column on a phone, in 2D and in 3D', async () => {
    const games = await source('assets/css/luxe-games.css');
    const phones = games.slice(games.indexOf('@media (max-width: 1023px) {'));
    assert.match(phones, /body\.lx \.bj \{ grid-template-columns: minmax\(0, 1fr\); grid-template-areas: "table" "controls"; \}/);
  });
});
