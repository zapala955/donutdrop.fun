import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isDepositEligible, type DepositEligibilityState } from '../src/lib/eligibility.js';

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
