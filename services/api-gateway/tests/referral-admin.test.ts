import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

const repo = path.resolve(import.meta.dirname, '../../..');
const read = (relative: string) => readFile(path.join(repo, relative), 'utf8');

/**
 * A referral programme pays for signups, so it attracts the people who are best at manufacturing
 * them. Until now an administrator who found a ring of self-referrals had nothing to do about it.
 */
describe('voiding a referral actually stops it earning', () => {
  const lib = () => read('services/api-gateway/src/lib/referrals.ts');

  /* Three paths, and missing any one of them leaves a hole big enough to walk through: the
   * accrual on every settled wager, the milestone unlock, and -- most importantly -- the claim. */
  it('is excluded from accrual, from the milestone, and from the claim', async () => {
    const code = await lib();
    const accrual = code.slice(code.indexOf('export async function accrueReferralWager'));
    assert.match(accrual.slice(0, accrual.indexOf('export async function', 10)), /voided_at IS NULL/);

    const milestone = code.slice(code.indexOf('export async function tryUnlockMilestone'));
    assert.match(milestone.slice(0, 1200), /voided_at IS NULL/);

    /* The claim is the half that decides whether voiding means anything. Stopping future earnings
     * while still paying out everything the relationship had already banked would make it a
     * formality. */
    const claim = code.slice(code.indexOf('export async function claimReferralRewards'));
    const body = claim.slice(0, claim.indexOf('return { claimedMinor'));
    const guards = body.split('voided_at IS NULL').length - 1;
    assert.equal(guards, 2, 'the claim must filter voided referrals when reading AND when paying');
  });

  /* The row is the evidence. Deleting it would stop the accrual and destroy the case for having
   * stopped it in the same statement, which is exactly backwards for a fraud control. */
  it('marks the row rather than deleting it', async () => {
    const migration = await read('packages/db/migrations/045_referral_voiding.sql');
    assert.match(migration, /ADD COLUMN voided_at timestamptz/);
    assert.doesNotMatch(migration, /DELETE FROM referrals/);
    // And can always say who decided, and why.
    assert.match(migration, /num_nonnulls\(voided_at, voided_by, void_reason\) IN \(0, 3\)/);
  });

  it('never reverses money already paid', async () => {
    const route = await read('services/api-gateway/src/routes/admin-operations.ts');
    const handler = route.slice(route.indexOf("'/v1/admin/referrals/:id/void'"));
    const body = handler.slice(0, handler.indexOf("app.patch(\n    '/v1/admin/referral-codes"));
    for (const table of ['referral_earnings', 'referral_claims', 'wallet_transactions']) {
      assert.ok(!body.includes(table), `voiding touches ${table}, which is append-only history`);
    }
    // The forfeited figure is recorded at the moment it changed hands.
    assert.match(body, /claimableMinor: referral\.revshare_claimable_minor/);
    assert.match(body, /action: body\.voided \? 'referral\.void' : 'referral\.restore'/);
  });

  /* A figure the claim endpoint refuses to pay is not a balance, and showing one produces a
   * button that fails. */
  it('keeps the voided balance out of what a player is told they can claim', async () => {
    const route = await read('services/api-gateway/src/routes/referrals.ts');
    const summary = route.slice(route.indexOf('AS revshare_claimable_minor') - 400);
    assert.match(summary.slice(0, 400), /FILTER \(WHERE r\.voided_at IS NULL\)/);
  });
});

describe('managing the programme from the console', () => {
  it('reports totals over the whole programme, not over the page being shown', async () => {
    const route = await read('services/api-gateway/src/routes/admin-operations.ts');
    const handler = route.slice(route.indexOf("app.get('/v1/admin/referrals'"));
    const totals = handler.slice(handler.indexOf('const totals ='), handler.indexOf('return {'));
    // No filter, no paging: a statistic that moved when somebody searched would describe the
    // filter rather than the business.
    assert.ok(!totals.includes('LIMIT'));
    assert.ok(!totals.includes('ILIKE'));
    assert.match(totals, /FROM referrals\s*`/);
    // Claimable excludes voided, matching what the claim endpoint will actually pay.
    assert.match(totals, /FILTER \(WHERE voided_at IS NULL\)/);
  });

  it('searches a player or a code from one box', async () => {
    const route = await read('services/api-gateway/src/routes/admin-operations.ts');
    const handler = route.slice(route.indexOf("app.get('/v1/admin/referrals'"));
    assert.match(handler.slice(0, 2000), /referee\.minecraft_username ILIKE/);
    assert.match(handler.slice(0, 2000), /referrer\.minecraft_username ILIKE/);
    assert.match(handler.slice(0, 2000), /r\.code ILIKE/);
  });

  /* Renaming is for codes that turn out to be slurs or impersonations. The referrals formed under
   * the old one follow it, so this must not be able to orphan a relationship. */
  it('renames a code without breaking the referrals formed under it', async () => {
    const migration = await read('packages/db/migrations/034_custom_referral_codes.sql');
    assert.match(migration, /ON UPDATE CASCADE/);
    const route = await read('services/api-gateway/src/routes/admin-operations.ts');
    const handler = route.slice(route.indexOf("'/v1/admin/referral-codes/:id'"));
    // A taken code is a conflict, not a 500.
    assert.match(handler, /REFERRAL_CODE_TAKEN/);
    assert.match(handler, /action: 'referral_code\.rename'/);
  });

  it('is reachable as its own tab in the console', async () => {
    const markup = await read('DONUTDROP FRONTEND/Donut Drop/admin/index.html');
    assert.match(markup, /data-panel="referrals"/);
    const code = await read('DONUTDROP FRONTEND/Donut Drop/admin/admin.js');
    assert.match(code, /referrals: loadReferrals,/);
    // Figures in a scanned column are compact, like the rest of the console.
    const loader = code.slice(code.indexOf('async function loadReferrals'));
    assert.match(loader.slice(0, 3000), /compactAmount\(/);
  });
});
