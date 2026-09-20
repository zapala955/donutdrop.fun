import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

/*
 * The avatar proxy exists for one reason: a player's Minecraft name must never appear in a URL the
 * browser can be pointed at. These assertions guard that property, because the regression is
 * invisible — putting the name back would look like it worked, and the leak is only found by
 * somebody right-clicking a head.
 */

const read = (rel: string) => readFile(path.resolve(import.meta.dirname, rel), 'utf8');
const route = () => read('../src/routes/avatars.ts');
const chat = () => read('../../../DONUTDROP FRONTEND/Donut Drop/assets/js/chat.js');
const app = () => read('../../../DONUTDROP FRONTEND/Donut Drop/assets/js/app.js');

describe('avatar proxy', () => {
  it('is keyed on an id, never on a name', async () => {
    const source = await route();
    assert.match(source, /'\/v1\/avatars\/:id'/);
    assert.match(source, /z\.uuid\(\)/);
    /* Asserted against code with the comments stripped. The prose above the route necessarily
       says the word "username" — it is explaining what was removed — and matching raw text would
       fail on the explanation rather than on the behaviour. */
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(code, /username/i);
    assert.doesNotMatch(code, /minecraft_username/);
  });

  it('resolves the account privately and fetches upstream by UUID', async () => {
    const source = await route();
    assert.match(source, /SELECT minecraft_identity FROM users WHERE id = \$1/);
    /* The upstream URL is built from a 32-hex UUID extracted by regex, so nothing a caller
       supplies can reach it. */
    assert.match(source, /\/\^mc:\(\[a-f0-9\]\{32\}\)\$\//);
    assert.match(source, /\$\{UPSTREAM\}\$\{uuid\}\/\$\{size\}/);
  });

  it('refuses to put a Bedrock name upstream', async () => {
    /* A Bedrock identity is `bedrock:<name>`. It has no Mojang UUID, and the only way to ask
       mc-heads for one would be to send the name — the exact thing this route prevents. */
    const source = await route();
    const guard = source.slice(source.indexOf('const uuid ='), source.indexOf('let upstream'));
    assert.match(guard, /if \(!uuid\)/);
    assert.match(guard, /return notFound\(reply\)/);
  });

  it('bounds the sizes it will fetch', async () => {
    /* An open size parameter is an unbounded set of cache keys and upstream fetches. */
    const source = await route();
    assert.match(source, /const SIZES = new Set\(\[22, 40\]\)/);
    assert.match(source, /SIZES\.has\(query\.s\)/);
  });

  it('caps what it will proxy back', async () => {
    const source = await route();
    assert.match(source, /MAX_IMAGE_BYTES/);
    assert.match(source, /contentType\.startsWith\('image\/'\)/);
  });
});

describe('chat renderer', () => {
  it('never builds a third-party avatar URL from a username', async () => {
    const source = await chat();
    const fn = source.slice(source.indexOf('function avatarFor'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    assert.doesNotMatch(body, /mc-heads\.net\/avatar\/\$\{/);
    assert.match(body, /\/v1\/avatars\/\$\{encodeURIComponent\(userId\)\}/);
  });

  it('falls back to initials when there is no id to ask by', async () => {
    /* Drop cards and tip lines carry only a server-masked name. There is nothing to look a head up
       by that would not mean un-masking it first, so they get the letter tile. */
    const source = await chat();
    assert.match(source, /avatarFor\(null, activity\.player/);
    assert.match(source, /avatarFor\(null, username\)/);
    const fn = source.slice(source.indexOf('function avatarFor'));
    assert.match(fn.slice(0, fn.indexOf('\n}')), /if \(!userId\) return initials\(\)/);
  });

  it('passes the id the chat payload already carries', async () => {
    const source = await chat();
    assert.match(source, /avatarFor\(message\.authorId, message\.author\)/);
  });
});

describe('account header avatar', () => {
  it('loads the signed-in player head through the private avatar proxy', async () => {
    const source = await app();
    const fn = source.slice(source.indexOf('const paintAuthChrome'));
    const body = fn.slice(0, fn.indexOf("bus.addEventListener('change'"));
    assert.match(body, /\/v1\/avatars\/\$\{encodeURIComponent\(state\.user\.id\)\}\?s=40/);
    assert.doesNotMatch(body, /encodeURIComponent\(state\.user\.minecraftUsername\)/);
    assert.match(body, /dataset\.avatar = 'fallback'/);
  });
});
