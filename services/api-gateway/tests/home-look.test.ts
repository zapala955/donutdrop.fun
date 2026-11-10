import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

/* The lobby shows every game (2026-11-10). It had one sideways row: eight cards to a desktop's width,
 * three and a half to a phone's, and the rest -- Blackjack, Roulette, Upgrader, Coinflip, Mines Duel,
 * Cases, Case Battles, Mob Derby -- behind arrows and a "See all games" button. Now the cards wrap
 * into a grid: the fourteen Originals fill two rows of seven on a desktop and four to a row on a
 * phone, with the slot machines under them at the same size. Coinflip and Mines Duel are hidden for
 * now: no card, no sidebar link, no banner mention, never suggested; their pages still open for a
 * game in play. */

const frontend = path.resolve(import.meta.dirname, '../../../DONUTDROP FRONTEND/Donut Drop');
const read = async (file: string) => (await readFile(path.join(frontend, file), 'utf8')).replace(/\r\n/g, '\n');

describe('the lobby', () => {
  it('wraps every game into a grid, with nothing behind an arrow or a "See all games"', async () => {
    const html = await read('index.html');
    const home = html.slice(html.indexOf('data-view="home"'), html.indexOf('<!-- ─────── CRATES'));
    assert.doesNotMatch(home, /lxarrow|lxrow__arrows|id="lxMore"|See all games/);
    const css = await read('assets/css/luxe-home.css');
    assert.match(css, /\.lxrow \{\n\s*--lx-card-gap: 16px;\n\s*display: grid;\n\s*grid-template-columns: repeat\(7, minmax\(0, 1fr\)\);/);
    assert.doesNotMatch(css, /grid-auto-flow: column|scroll-snap-type: x mandatory;\n\s*scrollbar-width: none;\n\}|data-all|\.lxmore|\.lxarrow/);
    // Three to a row on a phone (four made the tiles too small).
    const phone = css.slice(css.indexOf('@media (max-width: 599px) {'));
    assert.match(phone, /\.lxrow \{ --lx-card-gap: 8px; grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); gap: var\(--lx-card-gap\); padding-top: 0; \}/);
  });

  /* 2026-11-10: "the gradient on the main menu tiles, the 3 banners on top etc doesnt fit the premium
   * and its sloppy", then "remove the NEW text". Panels are one flat obsidian material with a hairline
   * edge; the offers show one sprite each in an inventory slot, as the cards do; no card says "New". */
  it('draws the cards and the offers on one flat material, sprites in slots, and no "New" tags', async () => {
    const dopamine = await read('assets/css/dopamine.css');
    const tokens = dopamine.slice(dopamine.indexOf(':root {'), dopamine.indexOf('\n}\n', dopamine.indexOf(':root {')));
    for (const name of ['panel', 'panel-hi', 'frame', 'pop', 'sheet', 'foot']) {
      assert.ok(new RegExp(`--dd-${name}: var\\(--lx-\\d\\);`).test(tokens), `--dd-${name} is a flat step of the ladder`);
    }
    assert.doesNotMatch(tokens, /--lx-[345]: #/, "the control steps are luxe.css's own, not warmed");
    const retro = await read('assets/css/retro.css');
    assert.match(retro, /body\.lx \.lxcard \{\n\s*background: var\(--lx-2\);/);
    assert.doesNotMatch(retro, /\.lxcard::after/);

    const html = await read('index.html');
    const offers = html.slice(html.indexOf('<section class="lxpromos"'), html.indexOf('</section>', html.indexOf('<section class="lxpromos"')));
    const art = [...offers.matchAll(/<span class="lxpromo__art"><img src="([^"]+)" alt="" width="80" height="80" \/><\/span>/g)].map((m) => m[1]);
    assert.deepEqual(art, ['assets/img/brand/donut.svg', 'assets/img/luxe/promo-gift.svg', 'assets/img/luxe/discord-mark.svg']);
    for (const file of art) await readFile(path.join(frontend, file!));
    assert.doesNotMatch(offers, /lxtag--gold/);
    const home = await read('assets/css/luxe-home.css');
    assert.match(home, /\.lxpromo__art img \{\n\s*display: block; width: 80px; height: 80px; object-fit: contain;\n\s*image-rendering: pixelated;/);

    assert.doesNotMatch(html, /gcard__badge|lxcard__badge/);
    const cards = html.slice(html.indexOf('<ul class="lxrow" id="lobbyTrack">'), html.indexOf('</ul>', html.indexOf('id="slotsTrack"')));
    assert.doesNotMatch(cards, />New</);
    assert.doesNotMatch(home, /lxcard__badge/);
    // The "New" tab still knows which games are new: data.js says, not a tag on the card.
    const luxe = await read('assets/js/luxe.js');
    assert.match(luxe, /const isNew = Boolean\(game && isNewGame\(game\)\);/);
  });

  it('puts the games near the top of a phone: a short offer strip, slim search, every tab in sight', async () => {
    /* 2026-11-10: on a phone the games came a long scroll down -- a 180px banner, a 48px search, a
     * tab tray that cut off PvP and hid Cases, and an empty line under every row of cards kept for
     * "N playing". The first card now starts about 130px higher. */
    const css = await read('assets/css/luxe-home.css');
    const phone = css.slice(css.indexOf('@media (max-width: 599px) {'), css.indexOf('@media (prefers-reduced-motion: reduce) {'));
    assert.match(phone, /\.lxpromos \{ grid-template-columns: repeat\(3, 84%\);/);
    assert.match(phone, /\.lxpromo \{ grid-template-columns: 84px minmax\(0, 1fr\); min-height: 96px; \}/);
    assert.match(phone, /\.lxpromo__p \{[^}]*-webkit-line-clamp: 1; \}/);
    assert.match(phone, /\.lxsearch \{ height: 42px;/);
    assert.match(phone, /\.lxtabs__track \{ width: 100%; padding: 3px; \}/);
    assert.match(phone, /\.lxtab \{ flex: 1 1 auto; justify-content: center; height: 34px;/);
    assert.match(phone, /\.lxtab svg \{ display: none; \}/);
    // The player count rides on the card's corner, and takes no room when nobody is playing.
    assert.match(phone, /\.lxlive \{\n\s*position: absolute; top: 6px; right: 6px; z-index: 2;/);
    assert.match(phone, /\.lxlive\[hidden\] \{ display: none; \}/);
    // The rewards: three tiles in a row, the icon over the name.
    assert.match(phone, /\.lxperks__row \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
    assert.match(phone, /\.lxperk \{ flex-direction: column;/);
    assert.match(phone, /\.lxperk__copy span \{ display: none; \}/);
  });

  it('keeps fourteen Originals and two slot machines, Ice Fishing, Coinflip and Mines Duel out', async () => {
    const html = await read('index.html');
    const main = html.slice(html.indexOf('<ul class="lxrow" id="lobbyTrack">'), html.indexOf('</ul>', html.indexOf('id="lobbyTrack"')));
    const slots = html.slice(html.indexOf('<ul class="lxrow" id="slotsTrack"'), html.indexOf('</ul>', html.indexOf('id="slotsTrack"')));
    assert.equal(main.match(/<a class="gcard lxcard"/g)?.length, 14);
    assert.equal(slots.match(/<a class="gcard lxcard"/g)?.length, 2);
    assert.doesNotMatch(main + slots, /ice-fishing|coinflip|mines-duel/);
    const side = html.slice(html.indexOf('<aside class="lxside"'), html.indexOf('</aside>'));
    assert.doesNotMatch(side, /href="\/(coinflip|mines-duel|ice-fishing)"/);
    assert.match(html, /<span class="lxpromo__p" id="pbanLeadP">Crash, Mines, Plinko, Blackjack and more\.<\/span>/);
    const app = await read('assets/js/app.js');
    assert.match(app, /: 'Crash, Mines, Plinko, Blackjack and more\.';/);
    assert.doesNotMatch(await read('assets/js/data.js'), /route: '\/(coinflip|mines-duel|ice-fishing)'/);
    // Hidden, not gone: a game in play can still be finished at its own address.
    for (const [view, mount] of [['coinflip', 'coinflip: mountCoinflip'], ['mines-duel', "'mines-duel': mountMinesDuel"]] as const) {
      assert.match(html, new RegExp(`<section class="view" data-view="${view}" hidden>`));
      assert.ok(app.includes(mount), mount);
    }
  });

  it('drops the scripts that drove the arrows and the "See all games" toggle', async () => {
    const app = await read('assets/js/app.js');
    const home = app.slice(app.indexOf('function mountHome(view)'), app.indexOf('/* The three offers at the top.'));
    assert.doesNotMatch(home, /wireRow|paintArrows|lobbyPrev|lobbyNext|slotsPrev|\.lxmore|scrollLeft/);
    assert.match(home, /mainHead\.hidden = originals === 0 && slots > 0;\n\s*slotsRow\.hidden = slots === 0;\n\s*\};/);
    const luxe = await read('assets/js/luxe.js');
    assert.doesNotMatch(luxe, /lxMore|See all games|Show fewer/);
  });
});
