import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { MASK_WIDTH, maskedName } from '../src/lib/masked-name.js';

/*
 * A player's name must not reach a spectator from any public surface.
 *
 * The masking was written once for the activity feed and nowhere else, so the feed masked names
 * while the battle lobby, the battle fairness panel and the duel arena printed them in full. A
 * mask only has to be missing from one place to be missing from everywhere, which is why these
 * assert the query and not the rendering: a route that selects the raw column has already lost,
 * whatever the client does with it afterwards.
 */

const read = (rel: string) => readFile(path.resolve(import.meta.dirname, rel), 'utf8');
const route = (name: string) => read(`../src/routes/${name}.ts`);
const profanity = () => read('../../../DONUTDROP FRONTEND/Donut Drop/assets/js/profanity.js');

describe('the mask itself', () => {
  it('is a fixed width, whatever the name', () => {
    /* Padding to the real length keeps rows visually distinct and leaks the thing being hidden:
     * among a few hundred regulars an initial plus a length often names somebody outright. */
    const sql = maskedName('u.minecraft_username');
    assert.match(sql, /left\(u\.minecraft_username, 1\)/);
    assert.match(sql, new RegExp(`repeat\\('\\*', ${MASK_WIDTH}\\)`));
    assert.doesNotMatch(sql, /length\(/);
    assert.doesNotMatch(sql, /greatest\(/);
  });

  it('agrees with the client-side mask', async () => {
    /* Two masks that disagree are one mask: the wider one is what a reader learns. */
    const source = await profanity();
    assert.match(source, new RegExp(`const MASK_WIDTH = ${MASK_WIDTH};`));
    assert.match(source, /'\*'\.repeat\(MASK_WIDTH\)/);
    /* The old implementation returned a one-character name untouched, which announced its length
     * by refusing to hide it. */
    assert.doesNotMatch(source, /characters\.length - 1/);
    assert.doesNotMatch(source, /if \(characters\.length <= 1\) return/);
  });
});

describe('public surfaces', () => {
  const surfaces: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['activity', ['u.minecraft_username']],
    ['battles', ['u.minecraft_username', 'display_name']],
    ['duels', ['h.minecraft_username', 'o.minecraft_username']],
  ];

  for (const [name, columns] of surfaces) {
    it(`masks every name ${name} selects`, async () => {
      const source = await route(name);
      for (const column of columns) {
        assert.ok(
          source.includes(`maskedName('${column}')`),
          `${name}.ts must mask ${column}`,
        );
      }
    });
  }

  it('does not select a raw username alongside the masked one', async () => {
    /* The battle lobby and the duel arena both used to. The fairness panel was the worst of them:
     * it labels a client seat's seed, so verifying a battle meant reading the names of everyone
     * who played it. */
    for (const name of ['battles', 'duels']) {
      const source = await route(name);
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      assert.doesNotMatch(
        code,
        /minecraft_username AS (?:host_name|opponent_name)/,
        `${name}.ts still selects a raw name`,
      );
    }
  });

  it('masks every leaderboard query before the response leaves the API', async () => {
    const source = await route('insights');
    assert.equal(source.match(/maskedName\('u\.minecraft_username'\)/g)?.length, 3);
    assert.match(source, /username: row\.username/);
    assert.doesNotMatch(source, /username: row\.minecraft_username/);
  });

  it('keeps the stored name raw, and masks only on the way out', async () => {
    /* battle_players.display_name is captured at join time and an audit of who actually played
     * needs it. The mask belongs in the read, not in the write. */
    const source = await route('battles');
    assert.match(source, /player\.minecraft_username, clientSeed/);
  });
});
