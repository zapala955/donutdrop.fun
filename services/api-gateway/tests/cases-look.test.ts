import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

/* The Cases page (2026-11-10). The owner: "rewrite cases like u did with mines, etc but dont touch the
 * spin and win animation". It is now the frame every game has -- the controls in a panel on the left,
 * the case and everything in it on the dark stage on the right, the bar with its name under both --
 * with every case to choose from under the bar. The reel, the cutscene and the mystery keynote are
 * called exactly as before. */

const frontend = path.resolve(import.meta.dirname, '../../../DONUTDROP FRONTEND/Donut Drop');
const read = async (file: string) => (await readFile(path.join(frontend, file), 'utf8')).replace(/\r\n/g, '\n');

describe('the Cases page', () => {
  it('is a game frame: the panel, the stage, the bar under them, every case under the bar', async () => {
    const html = await read('index.html');
    const page = html.slice(html.indexOf('<section class="view" data-view="crates" hidden>'), html.indexOf('<!-- ─────── REFERRALS'));
    assert.match(page, /<h1>Cases<\/h1>/);
    assert.match(page, /<div class="crates" id="crateRoot"><\/div>\n\s*<section class="cratebrowse" id="crateBrowse" aria-labelledby="crateBrowseH"><\/section>/);

    const css = await read('assets/css/luxe-games.css');
    // The bar goes under the frame because .crates is one of the frames.
    assert.equal(css.split('.bj, .roulette, .upg, .crates))').length - 1, 8);
    assert.match(css, /body\.lx \.crates \{[\s\S]*?grid-template-columns: minmax\(260px, 300px\) minmax\(0, 1fr\);\n\s*grid-template-areas: "panel stage";/);
    assert.match(css, /body\.lx \.view:has\(> \.crates\) > \.cratebrowse \{ order: 3;/);
    assert.match(css, /body\.lx \.cases__stage \{[\s\S]*?min-height: 600px;[\s\S]*?background: var\(--lx-0\);/);
    // On a phone the stage goes on top, as every game's does, and its items become one strip.
    assert.match(css, /body\.lx \.crates \{ grid-template-columns: minmax\(0, 1fr\); grid-template-areas: "stage" "panel"; \}/);
    assert.match(css, /\.cases__grid \{\n\s*grid-template-columns: none; grid-auto-flow: column;/);

    // The case browser is out of the frame but still has the crate page's tokens.
    const platform = await read('assets/css/platform.css');
    assert.match(platform, /\.crates, \.cratebrowse, \.quests, \.war, \.fair \{/);
  });

  it('puts the odds of every item on the stage, beside the button that charges for them', async () => {
    const crates = await read('assets/js/crates.js');
    assert.match(crates, /<div class="cases__grid" id="casesItems" role="list"/);
    assert.match(crates, /<button class="btn btn--go cases__go" id="casesGo" type="button">/);
    // The figures on the button are the total for the quantity picked.
    assert.match(crates, /go\.textContent = opening \? 'Opening…' : `\$\{what\} · \$\{money\(total\)\}`;/);
    // The stage is never empty while there are cases.
    assert.match(crates, /if \(!selected && state\.cases\.length\) \{\n\s*selected = \[\.\.\.state\.cases\]\.sort\(\(a, b\) => a\.price - b\.price\)\[0\];/);
  });

  it('opens a case exactly as before: the reel, the cutscene, the mystery, then the settlement', async () => {
    const crates = await read('assets/js/crates.js');
    const opening = crates.slice(crates.indexOf('async function openSelected()'), crates.indexOf('function withTimeout('));
    assert.match(opening, /const result = await requestCaseOpen\(crate, \{ defer: true \}\);/);
    assert.match(opening, /await withTimeout\(\n\s*playMystery\(\{ item, crate, pool, skipReel: view\.quickOpen \}\),\n\s*view\.quickOpen \? 180_000 : 240_000,\n\s*\);/);
    assert.match(opening, /await withTimeout\(playReel\(\{ item, crate, pool, mystery: false \}\), 180_000\);\n\s*if \(jackpot\) await withTimeout\(playCutscene\(\{ item, crate, pool \}\), 180_000\);/);
    assert.match(opening, /\} finally \{\n\s*\/\* The reel has stopped[^\n]*\n\s*await result\.settle\(\);/);
  });
});
