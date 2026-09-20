import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { isDepositEligible } from '../src/lib/eligibility.js';

/*
 * Deposit eligibility.
 *
 * This file used to assert eleven combinations of country, terms, age, KYC, cooldown and
 * self-exclusion. All six are gone: they were the real-money compliance apparatus, and this
 * platform settles in DonutSMP dollars.
 *
 * One rule is left, so there is one thing to test and one thing to keep anybody from quietly
 * adding back — a deposit is refused for any account that is not active, and refused by DEFAULT,
 * which is the property that matters when the row is missing or the shape changes underneath it.
 */

describe('deposit eligibility', () => {
  it('credits an active account', () => {
    assert.equal(isDepositEligible({ status: 'active' }), true);
  });

  it('refuses every other status', () => {
    for (const status of ['suspended', 'closed', 'pending', '']) {
      assert.equal(isDepositEligible({ status }), false, `${status} must not be credited`);
    }
  });

  it('fails closed on a missing row', () => {
    /* The callers pass `rows[0]`, which is undefined when the account does not exist or the lock
     * found nothing. Returning true here would credit a deposit to an account nobody looked up. */
    assert.equal(isDepositEligible(undefined), false);
  });

  it('asks nothing about who the player is', async () => {
    /* The point of the change, asserted where it can rot. A country, a birth date or a KYC status
     * appearing in this module again would mean the compliance gate had grown back around a wallet
     * that holds server-local game currency. */
    const source = await readFile(
      path.resolve(import.meta.dirname, '../src/lib/eligibility.ts'),
      'utf8',
    );
    /* Column names, not the words. The comment above the function explains which checks were
       removed and names them in prose, and a test that fails on its own explanation teaches the
       next person to delete the explanation. `cooldown_until` cannot appear in a sentence. */
    for (const gone of [
      /country_code/,
      /date_of_birth/,
      /kyc_status/,
      /age_verified_at/,
      /self_excluded_until/,
      /cooldown_until/,
    ]) {
      assert.doesNotMatch(source, gone, `${gone.source} must not return to eligibility`);
    }
  });
});
