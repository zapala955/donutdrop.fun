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

describe('the /test redesign preview', () => {
  it('is served by nginx only under /test, never indexed, with the live assets', async () => {
    const nginx = await read('infra/nginx/nginx.conf');
    const block = nginx.slice(nginx.indexOf('# ── the redesign preview ──'), nginx.indexOf('location ~ ^/admin/(?:index\\.html)?$'));
    assert.match(block, /location \^~ \/test\/assets\/ \{\s+rewrite \^\/test\(\/assets\/\.\*\)\$ \$1 last;/);
    assert.match(block, /location ~ \^\/test\(\?:\/\(\?:home\|crates\|/);
    assert.match(block, /add_header X-Robots-Tag "noindex, nofollow, noarchive" always;/);
    assert.match(block, /try_files \/test\.html =404;/);
    // The live shell is untouched: the root still serves index.html.
    assert.match(nginx, /location ~ \^\/\(\?:index\\\.html\)\?\$ \{[\s\S]*?try_files \/index\.html =404;/);
  });

  it('serves every route the live router knows under the prefix', async () => {
    const nginx = await read('infra/nginx/nginx.conf');
    const live = /location ~ \^\/\(\?:([a-z|-]+)\)\$ \{/.exec(nginx)?.[1];
    const preview = /location ~ \^\/test\(\?:\/\(\?:([a-z|-]+)\)\)\?\/\?\$ \{/.exec(nginx)?.[1];
    assert.ok(live && preview);
    assert.deepEqual(preview.split('|').sort(), live.split('|').sort());
  });

  it('routes the live site exactly as before', async () => {
    await atPath('/crash', (routing) => {
      assert.equal(routing.BASE, '');
      assert.equal(routing.appPath('/crash'), '/crash');
      assert.equal(routing.fullPath('/'), '/');
      assert.equal(routing.fullPath('/mines'), '/mines');
      assert.equal(routing.currentRouteName(), 'crash');
    });
    // A live path that merely starts with "test" is not the preview.
    await atPath('/testing', (routing) => assert.equal(routing.BASE, ''));
  });

  it('keeps the preview under /test as it navigates', async () => {
    await atPath('/test/mines', (routing) => {
      assert.equal(routing.BASE, '/test');
      assert.equal(routing.currentRouteName(), 'mines');
      assert.equal(routing.appPath('/test'), '/');
      assert.equal(routing.appPath('/test/vip'), '/vip');
      assert.equal(routing.fullPath('/'), '/test');
      assert.equal(routing.fullPath('/vip'), '/test/vip');
    });
    await atPath('/test', (routing) => assert.equal(routing.currentRouteName(), 'home'));
    await atPath('/test/', (routing) => assert.equal(routing.currentRouteName(), 'home'));
  });

  it('never asks a crawler to index a preview page', async () => {
    const [seo, html] = await Promise.all([
      read('DONUTDROP FRONTEND/Donut Drop/assets/js/seo.js'),
      read('DONUTDROP FRONTEND/Donut Drop/test.html'),
    ]);
    assert.match(seo, /const robots = BASE \? 'noindex, nofollow'/);
    assert.match(html, /<meta name="robots" content="noindex, nofollow" \/>/);
    // Nothing on the live site links to it.
    const index = await read('DONUTDROP FRONTEND/Donut Drop/index.html');
    assert.doesNotMatch(index, /href="\/test/);
    assert.doesNotMatch(await read('DONUTDROP FRONTEND/Donut Drop/sitemap.xml'), /\/test/);
  });

  it('carries every live view and every element the scripts look up', async () => {
    const [index, html] = await Promise.all([
      read('DONUTDROP FRONTEND/Donut Drop/index.html'),
      read('DONUTDROP FRONTEND/Donut Drop/test.html'),
    ]);
    const views = (doc: string) => [...doc.matchAll(/data-view="([a-z-]+)"/g)].map((m) => m[1]).sort();
    assert.deepEqual(views(html), views(index));
    const ids = [
      'skipToMain', 'burger', 'chat', 'chatScrim', 'chatLog', 'chatForm', 'chatInput', 'wCash',
      'lvlPill', 'lvlNum', 'lvlFill', 'lvlTip', 'muteBtn', 'loginBtn', 'loginHead', 'loginLabel',
      'depositBtn', 'withdrawBtn', 'acctBtn', 'acctMenu', 'menuInvites', 'signOutBtn',
      'vaultJackpot', 'tickerRoot', 'devRoot', 'toasts', 'modal', 'modalTitle', 'modalClose',
      'modalBody', 'main', 'lobby', 'lobbySearch', 'lobbyNone', 'lobbyTrack', 'lobbyTitle',
      'lobbyPrev', 'lobbyNext', 'lobbyReset', 'pbanLead', 'pbanLeadGo', 'pbanLeadCover',
      'pbanExplore', 'pbanLeadEyebrow', 'pbanLeadH', 'pbanLeadP', 'pbanLeadArt', 'pbanInvite',
      'pbanInviteH', 'pbanInviteGo', 'bigDrops',
    ];
    for (const id of ids) assert.match(html, new RegExp(`id="${id}"`), `test.html lost #${id}`);
    // Every game card links to a route and names its game for the live count.
    const cards = [...html.matchAll(/<a class="gcard lxcard" href="\/([a-z-]+)"[^>]*data-game="([a-z-]+)"/g)];
    assert.equal(cards.length, 10);
    for (const [, route, game] of cards) assert.equal(route, game);
    // The scripts are the live ones, plus the shell's own.
    // The same app.js URL the live page asks for, cache-busting version and all.
    const live = /<script type="module" src="(assets\/js\/app\.js[^"]*)"><\/script>/.exec(index)?.[1];
    assert.ok(live, 'index.html no longer loads app.js');
    assert.ok(html.includes(`<script type="module" src="${live}"></script>`), `test.html must load ${live}`);
    // And every stylesheet the live page has, except the home sheet the preview replaces.
    const sheets = (doc: string) => [...doc.matchAll(/<link rel="stylesheet" href="(assets\/css\/[^"]+)"/g)].map((m) => m[1]);
    for (const sheet of sheets(index)) {
      if (sheet === 'assets/css/home.css') continue;
      assert.ok(sheets(html).includes(sheet), `test.html is missing ${sheet}`);
    }
    assert.match(html, /<script type="module" src="assets\/js\/luxe\.js"><\/script>/);
    // The live page loads none of the skin.
    assert.doesNotMatch(index, /assets\/css\/luxe|assets\/js\/luxe\.js/);
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
