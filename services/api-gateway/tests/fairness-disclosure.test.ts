import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createFairRoll, generateServerSeed, hashServerSeed } from '@donut/provably-fair';

const repo = path.resolve(import.meta.dirname, '../../..');
const read = (relative: string) => readFile(path.join(repo, relative), 'utf8');

/**
 * Nobody can know an outcome before they are committed to it.
 *
 * That is the one property the whole provably-fair construction exists to provide, and it does not
 * live in any single function -- it is the product of four separate rules held at once. Each of
 * them is a line or two that a refactor could reorder without anything failing, and the damage
 * would not show up as a bug report. It would show up as somebody quietly never losing.
 */
describe('the outcome cannot be known before the bet', () => {
  /* The commitment leaks nothing. Publishing sha256(seed) before the roll is what makes the
   * reveal afterwards worth anything, and it is only safe because the hash is one-way. */
  it('publishes a commitment that does not narrow the roll', () => {
    const seed = generateServerSeed();
    const hash = hashServerSeed(seed);
    assert.match(hash, /^[a-f0-9]{64}$/);
    assert.notEqual(hash, seed);
    // Same seed, different client seeds: the roll moves, so the commitment alone predicts nothing.
    const a = createFairRoll(seed, 'alpha', 0);
    const b = createFairRoll(seed, 'beta', 0);
    assert.notEqual(a.digest, b.digest);
    // And the reveal is checkable: the seed must hash back to the commitment that was published.
    assert.equal(hashServerSeed(seed), hash);
  });

  /* The endpoint a player polls before betting. If this ever returned the seed -- or the
   * ciphertext, or anything derived from it -- every subsequent roll would be computable. */
  it('never hands out the seed before the roll', async () => {
    const code = await read('services/api-gateway/src/routes/upgrades.ts');
    const handler = code.slice(code.indexOf("app.get('/v1/fairness/current'"));
    const body = handler.slice(0, handler.indexOf('});'));
    assert.match(body, /serverSeedHash: seed\.server_seed_hash/);
    assert.ok(!body.includes('server_seed_ciphertext'), 'the ciphertext is served to the client');
    assert.ok(
      !/serverSeed\s*:/.test(body.replace(/serverSeedHash\s*:/g, '')),
      'the current-seed endpoint returns the seed itself',
    );
  });

  /**
   * ONE ROLL PER SEED.
   *
   * This is the rule that matters most and the easiest to lose. The usual construction reuses a
   * seed across an incrementing nonce and rotates only when asked -- which means that between the
   * reveal and the rotation, every future roll on that seed is computable by anybody who read the
   * response they were just handed.
   *
   * Here the seed is retired AND replaced inside the same transaction that settles the round, so
   * the revealed seed can never produce another roll. Both halves are asserted: retiring without
   * replacing would strand the player, replacing without retiring would leave the old seed live.
   */
  it('retires and replaces the seed in the transaction that reveals it', async () => {
    for (const file of [
      'services/api-gateway/src/routes/upgrades.ts',
      'services/api-gateway/src/routes/cases.ts',
    ]) {
      const code = await read(file);
      const retire = code.indexOf("UPDATE fairness_seeds SET used_at = now()");
      const replace = code.indexOf('insertFairnessSeed(client, config, userId)', retire);
      assert.ok(retire > 0, `${file} never retires the seed it revealed`);
      assert.ok(replace > retire, `${file} does not issue a fresh seed after retiring one`);
      // Both inside the settling transaction, not after it returns.
      const transactionEnd = code.indexOf('});', replace);
      assert.ok(transactionEnd > replace, `${file} rotates the seed outside its transaction`);
    }
  });

  /* A seed that has been used is never selected again, whatever else happens. */
  it('only ever picks up an unused seed', async () => {
    for (const file of [
      'services/api-gateway/src/routes/upgrades.ts',
      'services/api-gateway/src/routes/cases.ts',
    ]) {
      const code = await read(file);
      const selects = code.split('FROM fairness_seeds WHERE user_id = $1').length - 1;
      const guarded = code.split('FROM fairness_seeds WHERE user_id = $1 AND used_at IS NULL').length - 1;
      assert.equal(guarded, selects, `${file} reads a fairness seed without the used_at guard`);
    }
  });

  /* With one roll per seed the nonce never moves, and it must not start moving: an incrementing
   * nonce on a REVEALED seed is exactly the hole this design avoids. */
  it('never advances a nonce on an existing seed', async () => {
    for (const file of [
      'services/api-gateway/src/routes/upgrades.ts',
      'services/api-gateway/src/routes/cases.ts',
      'services/api-gateway/src/routes/battles.ts',
      'services/api-gateway/src/routes/duels.ts',
      'services/api-gateway/src/routes/roulette.ts',
    ]) {
      const code = await read(file);
      assert.ok(!/SET\s+nonce\s*=/.test(code), `${file} advances a nonce`);
      assert.ok(!/nonce\s*=\s*nonce\s*\+/.test(code), `${file} advances a nonce`);
    }
  });
});

describe('the shared-table games reveal only once they have settled', () => {
  /* Roulette is the strongest of the three, because the rule is a database constraint rather
   * than a convention: an open round CANNOT carry a revealed seed, a digest or a result.
   * Postgres refuses the row, so no code path -- including one nobody has written yet -- can
   * publish the answer while the table is still taking chips. */
  it('makes an open roulette round structurally incapable of holding its answer', async () => {
    const migration = await read('packages/db/migrations/039_shared_roulette.sql');
    const constraint = migration.slice(migration.indexOf('CHECK (\n    (status = \'open\''));
    const open = constraint.slice(0, constraint.indexOf('OR'));
    assert.match(open, /server_seed_reveal IS NULL/);
    assert.match(open, /rng_digest IS NULL/);
    assert.match(open, /result IS NULL/);
  });

  /* The seed is written by the same statement that marks the round settled, in all three. A
   * separate UPDATE would open a window, however short, in which the answer is public and the
   * round is not yet closed. */
  it('writes the reveal in the same statement that settles the round', async () => {
    for (const [file, table] of [
      ['services/api-gateway/src/routes/roulette.ts', 'roulette'],
      ['services/api-gateway/src/routes/duels.ts', 'duel'],
      ['services/api-gateway/src/routes/battles.ts', 'battle'],
    ] as const) {
      const code = await read(file);
      const at = code.indexOf('server_seed_reveal = $');
      assert.ok(at > 0, `${file} never reveals a seed`);
      // The same UPDATE sets the status to settled.
      const statement = code.slice(Math.max(0, at - 400), at + 200);
      assert.match(statement, /status = 'settled'/, `${table} reveals outside its settling update`);
    }
  });

  /* Chips are refused once the clock runs out AND once the wheel is spinning, each checked
   * against the round row that was locked -- not against what the browser claimed. */
  it('refuses a chip on a round that has closed or is already spinning', async () => {
    const code = await read('services/api-gateway/src/routes/roulette.ts');
    const place = code.slice(code.indexOf("WHERE id = $1 AND status = 'open' FOR SHARE"));
    const guard = place.slice(0, place.indexOf('table limit'));
    assert.match(guard, /round\.closes_at\.getTime\(\) <= Date\.now\(\)/);
    assert.match(guard, /round\.opens_at\.getTime\(\) > Date\.now\(\)/);
    assert.match(guard, /ROUND_CLOSED/);
  });
});
