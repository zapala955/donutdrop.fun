import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { scaleDigestToWeight } from '../src/routes/cases.js';

describe('case weighted RNG', () => {
  it('maps the full committed digest into the configured integer range', () => {
    assert.equal(scaleDigestToWeight('0'.repeat(64), 100n), 0n);
    assert.equal(scaleDigestToWeight('f'.repeat(64), 100n), 99n);
    assert.equal(scaleDigestToWeight('8' + '0'.repeat(63), 10_000n), 5000n);
  });

  it('rejects malformed digests and unsupported totals', () => {
    assert.throws(() => scaleDigestToWeight('not-a-digest', 100n));
    assert.throws(() => scaleDigestToWeight('0'.repeat(64), 0n));
    assert.throws(() => scaleDigestToWeight('0'.repeat(64), 9_223_372_036_854_775_808n));
  });
});

describe('the crate house edge', () => {
  const source = () =>
    readFile(path.resolve(import.meta.dirname, '../src/routes/cases.ts'), 'utf8');

  it('is enforced where crates are actually created, not only in the seed', async () => {
    /* dev-seed.ts solves every crate to exactly 90% RTP and refuses to write one that misses,
     * which is the right discipline and is ALSO unreachable in production: that script throws on
     * NODE_ENV=production by design, so live crates come through the admin API instead.
     *
     * The guarantee everybody believed the catalogue had was therefore a property of a script that
     * cannot touch the live database. This asserts the check sits on the endpoint that can. */
    const seed = await readFile(
      path.resolve(import.meta.dirname, '../scripts/dev-seed.ts'),
      'utf8',
    );
    assert.match(seed, /dev-seed refuses to run with NODE_ENV=production/);

    const routes = await source();
    assert.match(routes, /const MIN_CASE_EDGE_BPS = 700;/);
    assert.match(routes, /const MAX_CASE_EDGE_BPS = 1_000;/);
    assert.match(routes, /CASE_EDGE_OUT_OF_BAND/);
  });

  it('checks both write paths, and re-checks a price change on its own', async () => {
    /* A patch may move the price, the drops, or both, and each alone changes the edge. Checking
     * only when `drops` is present would let a price cut through unexamined, which is the cheaper
     * way to give a crate away. */
    const routes = await source();
    assert.match(routes, /await assertCaseEdge\(client, BigInt\(body\.priceMinor\), body\.drops\);/);
    assert.match(routes, /if \(body\.priceMinor !== undefined \|\| body\.drops\) \{/);
    /* And the stored drops are read before the old ones are disabled, or the crate would be
       measured against a drop table that no longer exists.
       Matched on the CALLS — `await x(` — rather than the bare names: the comment explaining this
       ordering names both functions above the code that performs it, and a test that trips on its
       own explanation teaches the next person to delete the explanation. */
    const patch = routes.slice(routes.indexOf("app.patch('/v1/admin/cases/:id'"));
    assert.ok(
      patch.indexOf('await assertCaseEdge(') < patch.indexOf('await upsertDrops('),
      'the edge must be checked before the old drops are disabled',
    );
  });

  it('measures expected value in BigInt, because the products pass 2^53', async () => {
    /* A billion-unit weight times a fifty-million item is 5e16. In a double that is past the point
     * where integers stop being exact, and an EV that rounds down makes a crate look cheaper to
     * run than it is — the one direction of error this check exists to catch. */
    const routes = await source();
    const fn = routes.slice(routes.indexOf('async function assertCaseEdge'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    assert.match(body, /weightedValue \+= unit \* BigInt\(drop\.quantity\) \* BigInt\(drop\.weight\);/);
    assert.doesNotMatch(body, /Number\(unit\)/);
  });

  it('rounds once, so a crate solved to exactly the ceiling is not refused', async () => {
    /* Flooring the EV and then dividing again rounds twice, and both roundings push the measured
     * edge upward — on a cheap crate that is enough to read a crate solved to exactly 10% as 1010
     * bps and refuse it. That is a refusal an operator cannot act on, because nothing they can type
     * will fix it. The comparison is scaled by the total weight so the expected value stays exact
     * and one truncation is left, at the end, worth under a basis point. */
    const routes = await source();
    const fn = routes.slice(routes.indexOf('async function assertCaseEdge'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    assert.match(body, /const scaledPrice = priceMinor \* totalWeight;/);
    assert.match(body, /\(\(scaledPrice - weightedValue\) \* 10_000n\) \/ scaledPrice/);
    // The two-step form, which is the bug: an EV floored on its own before the ratio is taken.
    assert.doesNotMatch(body, /weightedValue \/ totalWeight/);
  });
});
