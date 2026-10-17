import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

const repo = path.resolve(import.meta.dirname, '../../..');
const frontend = path.join(repo, 'DONUTDROP FRONTEND/Donut Drop');
const read = (relative: string) => readFile(path.join(repo, relative), 'utf8');

type Routing = {
  BASE: string;
  appPath(pathname: string): string;
  fullPath(path: string): string;
  currentRouteName(): string;
};

/* routing.js reads the prefix from location once, at import, and the route on every call. Each
 * case imports its own copy of the file (the loader caches by path) with location standing in for
 * the address bar, and keeps it there while it asserts. */
let instance = 0;
async function atPath<T>(pathname: string, check: (routing: Routing) => T | Promise<T>): Promise<T> {
  const holder = globalThis as { location?: unknown };
  holder.location = { pathname, origin: 'https://donutluxe.com', hash: '' };
  const copy = path.join(tmpdir(), `routing-${process.pid}-${instance++}.mjs`);
  await writeFile(copy, await readFile(path.join(frontend, 'assets/js/routing.js'), 'utf8'));
  try {
    return await check((await import(pathToFileURL(copy).href)) as Routing);
  } finally {
    delete holder.location;
    await rm(copy, { force: true });
  }
}

describe('the casino-lobby shell', () => {
  it('is the live page, with every element the scripts look up', async () => {
    const html = await read('DONUTDROP FRONTEND/Donut Drop/index.html');
    const ids = [
      'skipToMain', 'burger', 'chat', 'chatScrim', 'chatLog', 'chatForm', 'chatInput', 'wCash',
      'lvlPill', 'lvlNum', 'lvlFill', 'lvlTip', 'muteBtn', 'loginBtn', 'loginHead', 'loginLabel',
      'depositBtn', 'withdrawBtn', 'acctBtn', 'acctMenu', 'menuInvites', 'signOutBtn', 'dailyCodeBtn',
      'vaultJackpot', 'tickerRoot', 'devRoot', 'toasts', 'modal', 'modalTitle', 'modalClose',
      'modalBody', 'main', 'lobby', 'lobbySearch', 'lobbyNone', 'lobbyTrack', 'lobbyTitle',
      'lobbyPrev', 'lobbyNext', 'lobbyReset', 'pbanLead', 'pbanLeadGo', 'pbanLeadCover',
      'pbanExplore', 'pbanLeadEyebrow', 'pbanLeadH', 'pbanLeadP', 'pbanLeadArt', 'pbanInvite',
      'pbanInviteH', 'pbanInviteGo', 'bigDrops', 'lxSide', 'lxSideBtn', 'lxChatBtn', 'lxRegister',
    ];
    for (const id of ids) assert.match(html, new RegExp(`id="${id}"`), `index.html lost #${id}`);
    assert.match(html, /<body class="lx">/);
    // Every game card links to a route and names its game for the live count.
    const cards = [...html.matchAll(/<a class="gcard lxcard" href="\/([a-z-]+)"[^>]*data-game="([a-z-]+)"/g)];
    assert.equal(cards.length, 13);
    for (const [, route, game] of cards) assert.equal(route, game);
    // The skin and its script, after app.js; the old home sheet is gone with the old home.
    assert.match(html, /<script type="module" src="assets\/js\/app\.js\?v=\d+"><\/script>[\s\S]*<script type="module" src="assets\/js\/luxe\.js\?v=\d+"><\/script>/);
    assert.doesNotMatch(html, /assets\/css\/home\.css/);
    // Retro skin: every card wears a real Minecraft item sprite (retro.css draws it pixel-sharp).
    const cardArt = [...html.matchAll(/<img class="lxcard__art retroart" src="([^"]+)"/g)];
    assert.equal(cardArt.length, 13);
    for (const [, src] of cardArt) assert.match(src ?? '', /^assets\/img\/items\/[a-z_]+\.(png|svg)$/);
  });

  it('keeps the SEO head nginx rewrites per route', async () => {
    const html = await read('DONUTDROP FRONTEND/Donut Drop/index.html');
    assert.match(html, /<meta name="robots" content="index, follow" \/>/);
    assert.match(html, /<link rel="canonical" href="https:\/\/donutluxe\.com\/" \/>/);
    assert.match(html, /<script type="application\/ld\+json">/);
    // The preview page it grew out of is gone; nothing serves a noindex copy of the site.
    await assert.rejects(read('DONUTDROP FRONTEND/Donut Drop/test.html'));
  });

  it('sends links to the old /test preview to the same page on the live site, and nowhere else', async () => {
    const nginx = await read('infra/nginx/nginx.conf');
    const block = nginx.slice(nginx.indexOf('# ── the old redesign preview ──'), nginx.indexOf('location ~ ^/admin/(?:index\\.html)?$'));
    // Only a route-shaped name is carried: an encoded slash cannot make the target //elsewhere.
    assert.match(block, /location ~ \^\/test\(\?:\/\(\[a-z-\]\+\)\)\?\/\?\$ \{/);
    assert.match(block, /return 308 \/\$1\$is_args\$args;/);
    assert.doesNotMatch(block, /try_files/);
    // Behind the TLS proxy nginx knows itself as http:8080; an absolute redirect built from that
    // pointed visitors at http://donutluxe.com:8080/ (it did, for /test and /admin).
    assert.match(nginx, /\n {4}absolute_redirect off;/);
  });

  it('routes the live site exactly as before', async () => {
    await atPath('/crash', (routing) => {
      assert.equal(routing.BASE, '');
      assert.equal(routing.appPath('/crash'), '/crash');
      assert.equal(routing.fullPath('/'), '/');
      assert.equal(routing.fullPath('/mines'), '/mines');
      assert.equal(routing.currentRouteName(), 'crash');
    });
    // A live path that merely starts with "test" is not a preview.
    await atPath('/testing', (routing) => assert.equal(routing.BASE, ''));
  });

  it('can still keep a preview under /test, should one be served there again', async () => {
    await atPath('/test/mines', (routing) => {
      assert.equal(routing.BASE, '/test');
      assert.equal(routing.currentRouteName(), 'mines');
      assert.equal(routing.appPath('/test/vip'), '/vip');
      assert.equal(routing.fullPath('/vip'), '/test/vip');
    });
    await atPath('/test', (routing) => assert.equal(routing.currentRouteName(), 'home'));
  });

  it('shows the chat to anybody who once folded the old rail away', async () => {
    const [luxe, css] = await Promise.all([
      read('DONUTDROP FRONTEND/Donut Drop/assets/js/luxe.js'),
      read('DONUTDROP FRONTEND/Donut Drop/assets/css/luxe.css'),
    ]);
    // social.css squeezes the chat to nothing under this flag; the panel clears it.
    assert.match(luxe, /delete body\.dataset\.chatCollapsed;/);
    assert.match(css, /body\.lx \.chat__dock \{ display: none; \}/);
    // Lying over the page, the chat is over the top bar too, close button and all.
    assert.match(css, /body\.lx \.chat \{ z-index: 105; \}/);
  });

  it('lays the top bar out as a row, so nothing in it can be pushed over anything else', async () => {
    const css = await read('DONUTDROP FRONTEND/Donut Drop/assets/css/luxe.css');
    const bar = css.slice(css.indexOf('.lxtop__in {'), css.indexOf('}', css.indexOf('.lxtop__in {')));
    assert.match(bar, /display: flex;/);
    assert.doesNotMatch(css, /\.lxtop__in \{[^}]*grid-template-columns/);
    // The level chip and then search and sound step aside when the bar runs out of room.
    assert.match(css, /@container lxtop \(max-width: 1040px\) \{ body\.lx \.lxtop \.lxtop__end \.lvl \{ display: none; \} \}/);
  });
});

describe('players per game', () => {
  it('counts real players over a fixed window, never an estimate', async () => {
    const route = await read('services/api-gateway/src/routes/activity.ts');
    const playing = route.slice(route.indexOf("'/v1/activity/playing'"));
    assert.ok(playing.length > 0, 'the endpoint is missing');
    assert.match(route, /const PLAYING_WINDOW_MINUTES = 15;/);
    assert.match(playing, /count\(DISTINCT seat\.user_id\)::integer AS players/);
    assert.match(playing, /now\(\) - make_interval\(mins => \$1\)/);
    // Both seats of a two-player game are playing it.
    assert.equal(playing.match(/VALUES \(g\.host_user_id\), \(g\.opponent_user_id\)/g)?.length, 2);
    // A game nobody is in is left out rather than sent as a zero.
    assert.match(playing, /if \(row\.players > 0\) games\[row\.game\] = Number\(row\.players\);/);
    // No names, no amounts: only a number per game.
    assert.doesNotMatch(playing.slice(0, playing.indexOf('GROUP BY seat.game')), /minecraft_username|stake_minor|payout_minor/);
  });

  it('is what the lobby prints, and a game with nobody in it says nothing', async () => {
    const luxe = await read('DONUTDROP FRONTEND/Donut Drop/assets/js/luxe.js');
    assert.match(luxe, /api\.get\('\/v1\/activity\/playing'\)/);
    assert.match(luxe, /line\.hidden = !\(players > 0\);/);
  });
});
