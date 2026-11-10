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
    // Four to a row on a phone, and the "New" tag small enough not to cover the icon.
    const phone = css.slice(css.indexOf('@media (max-width: 599px) {'));
    assert.match(phone, /\.lxrow \{ --lx-card-gap: 8px; grid-template-columns: repeat\(4, minmax\(0, 1fr\)\); gap: var\(--lx-card-gap\); padding-top: 0; \}/);
    assert.match(phone, /\.lxcard__badge \{ top: 4px; left: 4px; padding: 1px 4px; font-size: \.5625rem; \}/);
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
    assert.match(phone, /\.lxlive \{\n\s*position: absolute; top: 4px; right: 4px; z-index: 2;/);
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
