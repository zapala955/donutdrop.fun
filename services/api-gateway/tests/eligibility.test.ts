import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AppConfig } from '../src/config.js';
import type { DbClient } from '../src/lib/db.js';
import { isDepositEligible, type DepositEligibilityState } from '../src/lib/eligibility.js';
import { AppError } from '../src/lib/errors.js';
import { assertGameEligible } from '../src/lib/game-eligibility.js';

const eligible: DepositEligibilityState = {
  status: 'active',
  country_code: 'PL',
  terms_accepted_at: new Date(0),
  age_verified_at: new Date(0),
  kyc_status: 'verified',
  cooldown_until: null,
  self_excluded_until: null,
};

describe('deposit eligibility', () => {
  it('requires current compliance and an allowed country', () => {
    assert.equal(isDepositEligible(eligible, new Set(['pl']), 1_000), true);
    assert.equal(
      isDepositEligible({ ...eligible, status: 'suspended' }, new Set(['pl']), 1_000),
      false,
    );
    assert.equal(
      isDepositEligible({ ...eligible, kyc_status: 'rejected' }, new Set(['pl']), 1_000),
      false,
    );
    assert.equal(isDepositEligible(eligible, new Set(['de']), 1_000), false);
  });

  it('skips only the compliance profile for game-currency-only deployments', () => {
    const unverified = {
      ...eligible,
      country_code: null,
      terms_accepted_at: null,
      age_verified_at: null,
      kyc_status: 'not_started',
    };
    assert.equal(isDepositEligible(unverified, new Set(), 1_000, true), true);
    assert.equal(
      isDepositEligible({ ...unverified, status: 'suspended' }, new Set(), 1_000, true),
      false,
    );
    assert.equal(
      isDepositEligible({ ...unverified, self_excluded_until: 'infinity' }, new Set(), 1_000, true),
      false,
    );
  });

  it('fails closed for active, infinite, and malformed restrictions', () => {
    assert.equal(
      isDepositEligible({ ...eligible, cooldown_until: new Date(2_000) }, new Set(), 1_000),
      false,
    );
    assert.equal(
      isDepositEligible({ ...eligible, self_excluded_until: 'infinity' }, new Set(), 1_000),
      false,
    );
    assert.equal(
      isDepositEligible({ ...eligible, self_excluded_until: 'not-a-date' }, new Set(), 1_000),
      false,
    );
    assert.equal(
      isDepositEligible({ ...eligible, cooldown_until: new Date(999) }, new Set(), 1_000),
      true,
    );
  });
});

describe('game eligibility', () => {
  const config = {
    gameCurrencyOnly: true,
    allowedCountries: new Set<string>(),
  } as unknown as AppConfig;

  function client(state: Partial<DepositEligibilityState>): DbClient {
    return {
      query: async () => ({ rows: [{ ...eligible, ...state }], rowCount: 1 }),
    } as unknown as DbClient;
  }

  it('allows an active game-currency account without a compliance profile', async () => {
    await assert.doesNotReject(
      assertGameEligible(
        client({
          country_code: null,
          terms_accepted_at: null,
          age_verified_at: null,
          kyc_status: 'not_started',
        }),
        config,
        'game-user-id',
      ),
    );
  });

  it('still blocks self-exclusion in game-currency-only mode', async () => {
    await assert.rejects(
      assertGameEligible(
        client({ self_excluded_until: new Date(Date.now() + 60_000) }),
        config,
        'game-user-id',
      ),
      (error: unknown) => error instanceof AppError && error.code === 'SELF_EXCLUDED',
    );
  });
});
