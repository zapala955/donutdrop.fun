import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

const repo = path.resolve(import.meta.dirname, '../../..');
const read = (relative: string) => readFile(path.join(repo, relative), 'utf8');

/* The owner, 2026-11-11: "remake the support page with a lot of articles that will help lost
 * players". The help centre in assets/js/info.js. */
describe('the help centre', () => {
  it('has articles in every group, searchable, each with its own address', async () => {
    const info = (await read('DONUTDROP FRONTEND/Donut Drop/assets/js/info.js')).replace(/\r\n/g, '\n');
    const ids = [...info.matchAll(/\{ id: '([a-z-]+)', group: '([a-z]+)', title: /g)];
    assert.ok(ids.length >= 25, `only ${ids.length} articles`);
    assert.equal(new Set(ids.map((match) => match[1])).size, ids.length, 'two articles share an id');
    for (const group of ['start', 'deposit', 'withdraw', 'wager', 'rewards', 'discord', 'safe', 'fix']) {
      assert.ok(ids.some((match) => match[2] === group), `no article in ${group}`);
    }
    assert.match(info, /input\.addEventListener\('input', \(\) => \{\n\s+query = input\.value;/);
    assert.match(info, /const wanted = location\.hash\.slice\(1\);/);
  });

  it('quotes figures from the server, never from the page', async () => {
    const info = await read('DONUTDROP FRONTEND/Donut Drop/assets/js/info.js');
    const support = info.slice(info.indexOf('// ─────────── /support'), info.indexOf('// ─────────── /terms'));
    for (const route of ['/v1/promotions', '/v1/discord/rewards', '/v1/cash-withdrawals/info']) {
      assert.ok(support.includes(`api.get('${route}')`), route);
    }
    // No dollar figure typed into an article except the $1,000 the server's own rule uses.
    const typed = [...support.matchAll(/\$\d[\d,.]*[MKB]?/g)].map((match) => match[0]);
    assert.deepEqual([...new Set(typed)].sort(), ['$1,000', '$10M']);
  });

  it('ends at a ticket in the Discord', async () => {
    const info = await read('DONUTDROP FRONTEND/Donut Drop/assets/js/info.js');
    assert.match(info, /const SUPPORT_INVITE_URL = 'https:\/\/discord\.gg\/aHfRsUaGgx';/);
    assert.match(info, /root\.appendChild\(ticketCard\(false\)\);/);
  });
});
