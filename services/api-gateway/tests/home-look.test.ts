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
    // The rewards: two tiles in a row (the Wager Race tile came off on 2026-11-11), the icon over the name.
    assert.match(phone, /\.lxperks__row \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
    assert.match(phone, /\.lxperk \{ flex-direction: column;/);
    assert.match(phone, /\.lxperk__copy span \{ display: none; \}/);
  });

  it('keeps thirteen Originals (Coinflip came back against the house 2026-11-20), two slot machines, Battles and two cases games, Ice Fishing and Mines Duel out', async () => {
    const html = await read('index.html');
    const track = (id: string) => html.slice(html.indexOf(`id="${id}"`), html.indexOf('</ul>', html.indexOf(`id="${id}"`)));
    const main = track('lobbyTrack');
    const slots = track('slotsTrack');
    assert.match(html, /<ul class="lxrow" id="lobbyTrack">/);
    assert.equal(main.match(/<a class="gcard lxcard"/g)?.length, 13);
    assert.equal(slots.match(/<a class="gcard lxcard"/g)?.length, 2);
    assert.equal(track('pvpTrack').match(/<a class="gcard lxcard"/g)?.length, 1);
    assert.equal(track('casesTrack').match(/<a class="gcard lxcard"/g)?.length, 2);
    assert.doesNotMatch(html.slice(html.indexOf('data-view="home"'), html.indexOf('id="lobbyNone"')), /href="\/(ice-fishing|mines-duel)"/);
    assert.match(main, /<a class="gcard lxcard" href="\/coinflip" data-cat="casino" data-game="coinflip"/);
    const side = html.slice(html.indexOf('<aside class="lxside"'), html.indexOf('</aside>'));
    assert.doesNotMatch(side, /href="\/(mines-duel|ice-fishing)"/);
    assert.match(side, /<a class="lxnav" href="\/\?c=casino" data-cat="casino" data-tip="Originals">/);
    assert.match(html, /<span class="lxpromo__p" id="pbanLeadP">Crash, Mines, Plinko, Blackjack and more\.<\/span>/);
    const app = await read('assets/js/app.js');
    assert.match(app, /: 'Crash, Mines, Plinko, Blackjack and more\.';/);
    assert.doesNotMatch(await read('assets/js/data.js'), /route: '\/(mines-duel|ice-fishing)'/);
    // Hidden, not gone: a game in play can still be finished at its own address.
    for (const [view, mount] of [['coinflip', 'coinflip: mountCoinflip'], ['mines-duel', "'mines-duel': mountMinesDuel"]] as const) {
      assert.match(html, new RegExp(`<section class="view" data-view="${view}" hidden>`));
      assert.ok(app.includes(mount), mount);
    }
  });

  it('shows every Original on the lobby, in rows that wrap, and hides a row a kind empties', async () => {
    /* 2026-11-21, the owner: "ppl dont rlly see games other than show on the main page and they need
     * to click see all and maybe they wont notice it". The Originals were a row that scrolled behind
     * two arrows; now every card is in sight, at the card size the other rows use. */
    const app = await read('assets/js/app.js');
    const home = app.slice(app.indexOf('function mountHome(view)'), app.indexOf('/* The three offers at the top.'));
    assert.doesNotMatch(home, /wireRow|paintArrows|lobbyPrev|lobbyNext|slotsPrev|\.lxmore|scrollLeft|lobbySearch/);
    assert.match(home, /for \(const row of rows\) row\.hidden = !\$\$\('\.gcard', row\)\.some\(\(card\) => !card\.parentElement\.hidden\);/);
    const luxe = await read('assets/js/luxe.js');
    assert.doesNotMatch(luxe, /lxMore|See all games|Show fewer|wireRails|data-rail/);
    const html = await read('index.html');
    assert.doesNotMatch(html, /data-rail-(prev|next)|lxrail/);
    assert.match(html, /<a class="lxband__see" href="\/\?c=casino">See all/);
    const css = await read('assets/css/preview.css');
    assert.match(css, /body\.lx #lobby #lobbyTrack \{\n\s*grid-auto-flow: row; grid-auto-columns: auto; grid-template-columns: repeat\(auto-fill, var\(--tile-w\)\);/);
    assert.doesNotMatch(css, /#lobbyTrack \{ overflow-x: auto;/);
  });

  it('has no search box in the bar or the lobby, and no click on every press', async () => {
    /* 2026-11-21, the owner: "u can remove the search" and "no need for the minecraft sounds every
     * click lol like when opening chat etc". The games keep their own sounds. */
    const html = await read('index.html');
    assert.doesNotMatch(html, /type="search"|id="lxFind"|id="lxSearchBtn"|id="lobbySearch"/);
    const luxe = await read('assets/js/luxe.js');
    assert.doesNotMatch(luxe, /lxFind|focusSearch|lobbySearch|key\.toLowerCase\(\) === 'k'/);
    const engine = await read('assets/js/audio-engine.js');
    assert.match(engine, /const target = event\.target\.closest\('\[data-sfx\]'\);/);
    assert.doesNotMatch(engine, /closest\('button, \.btn/);
    assert.doesNotMatch(await read('assets/js/chat.js'), /playSound\('click'\)/);
  });

  it('puts the chat on the left and the menu on the right, opening on hover', async () => {
    /* 2026-11-21, the owner: "move the chat to left and the left sidebar to the right and make it
     * like expand when hovering over it". */
    const css = await read('assets/css/preview.css');
    const wide = css.slice(css.indexOf('/* ═════════ the chat on the left, the menu on the right'));
    assert.match(wide, /body\.lx \.lxside \{ inset: 0 0 0 auto;/);
    assert.match(wide, /body\.lx \.chat \{ left: 0; right: auto;/);
    assert.match(wide, /body\.lx\[data-chat="open"\] \.lxapp \{ margin-left: var\(--lx-chat\); \}/);
    assert.match(wide, /margin-right: var\(--lx-rail\);/);
    const luxe = await read('assets/js/luxe.js');
    assert.match(luxe, /side\.addEventListener\('pointerenter', \(event\) => \{\n\s*if \(!phone\.matches && event\.pointerType === 'mouse'\) hoverTo\(true, 120\);/);
    assert.match(luxe, /body\.dataset\.side = 'closed';/);
    assert.doesNotMatch(luxe, /SIDE_KEY|lx:side/);
  });
});
