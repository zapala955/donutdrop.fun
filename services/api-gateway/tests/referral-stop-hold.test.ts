import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { AppConfig } from '../src/config.js';
import type { DbClient } from '../src/lib/db.js';
import {
  REFERRAL_FRESH_REFERRER_DAYS,
  REFERRAL_STOP_COUNT,
  REFERRAL_STOP_MARGIN_BPS,
  tryUnlockMilestone,
} from '../src/lib/referrals.js';

/* 2026-10-23, the operator's rule: when two of a referrer's invites wager no more than 10% over the
 * referral wager requirement, the referrer is put on hold until an administrator reviews it. The
 * check runs where the milestone pays; these drive tryUnlockMilestone itself against a recording
 * stand-in for Postgres. */

const REQUIREMENT = 100_000_000n;
const config = {
  referralsEnabled: true,
  referralBonusMinor: 50_000_000n,
  referralBonusWagerMinor: REQUIREMENT,
  auditLogHmacKey: 'a'.repeat(32),
  auditLogKeyId: 'test',
} as unknown as AppConfig;

/** A Postgres stand-in: answers the milestone's queries and records every statement, in order. */
function fakeClient(opts: {
  refereeWagered: bigint;
  earlierStopped: number;
  alreadyHeld?: boolean;
  freshReferrer?: boolean;
}) {
  const statements: string[] = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      statements.push(sql.replace(/\s+/g, ' ').trim());
      if (/FROM referrals\s+WHERE referee_id = \$1 AND voided_at IS NULL\s+FOR UPDATE/.test(sql)) {
        return { rows: [{ referrer_id: 'referrer', wagered_minor: opts.refereeWagered.toString(), bonus_unlocked_at: null, network_reviewed_at: null }], rowCount: 1 };
      }
      if (/AS referrer_blocked/.test(sql)) return { rows: [{ referrer_blocked: false, shared_network: false }], rowCount: 1 };
      if (/INSERT INTO referral_earnings/.test(sql)) return { rows: [], rowCount: 1 };
      if (/SELECT count\(\*\) FROM referrals/.test(sql)) {
        // The earlier invites are counted against 110% of the requirement.
        assert.equal(params[2], ((REQUIREMENT * (10_000n + REFERRAL_STOP_MARGIN_BPS)) / 10_000n).toString());
        assert.equal(params[3], REFERRAL_FRESH_REFERRER_DAYS);
        return { rows: [{ n: String(opts.earlierStopped), fresh: opts.freshReferrer ?? false }], rowCount: 1 };
      }
      if (/UPDATE users u\s+SET payout_hold_reason/.test(sql)) {
        return opts.alreadyHeld ? { rows: [], rowCount: 0 } : { rows: [{ id: 'referrer' }], rowCount: 1 };
      }
      if (/UPDATE user_wallets SET balance_minor = balance_minor \+/.test(sql)) return { rows: [{ balance_minor: '50000000' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  } as unknown as DbClient;
  const held = () => statements.some((sql) => sql.startsWith('UPDATE users u SET payout_hold_reason'));
  const audited = () => statements.some((sql) => /INSERT INTO audit_log/.test(sql));
  return { client, statements, held, audited };
}

describe('a referrer whose invites stop at the wager requirement', () => {
  it('is put on hold when an earlier paid invite also stopped within 10%', async () => {
    assert.equal(REFERRAL_STOP_COUNT, 2);
    const db = fakeClient({ refereeWagered: 101_000_000n, earlierStopped: 1 });
    assert.equal(await tryUnlockMilestone(db.client, config, 'referee'), true, 'the bonus is still paid');
    assert.ok(db.held(), 'held');
    assert.ok(db.audited(), 'and the hold is in the audit log');
    // The account row is locked before the wallet, the order a withdrawal takes them in.
    const hold = db.statements.findIndex((sql) => sql.startsWith('UPDATE users u SET payout_hold_reason'));
    const credit = db.statements.findIndex((sql) => sql.startsWith('UPDATE user_wallets SET balance_minor = balance_minor +'));
    assert.ok(hold >= 0 && credit > hold, 'hold before credit');
  });

  it('is not held when no earlier paid invite stopped within 10% (a first invite, or one that played on)', async () => {
    const first = fakeClient({ refereeWagered: 100_000_000n, earlierStopped: 0 });
    assert.equal(await tryUnlockMilestone(first.client, config, 'referee'), true);
    assert.ok(!first.held());
  });

  it('does not count an invite that crossed the requirement well past 110% in one go', async () => {
    const db = fakeClient({ refereeWagered: 140_000_000n, earlierStopped: 1 });
    assert.equal(await tryUnlockMilestone(db.client, config, 'referee'), true);
    assert.ok(!db.held());
  });

  it('counts exactly 110% as stopping there, and one unit more as playing on', async () => {
    const edge = fakeClient({ refereeWagered: 110_000_000n, earlierStopped: 1 });
    await tryUnlockMilestone(edge.client, config, 'referee');
    assert.ok(edge.held());
    const over = fakeClient({ refereeWagered: 110_000_001n, earlierStopped: 1 });
    await tryUnlockMilestone(over.client, config, 'referee');
    assert.ok(!over.held());
  });

  it('holds a referrer under 7 days old at the first invite that stops there (the chained farm)', async () => {
    const fresh = fakeClient({ refereeWagered: 101_000_000n, earlierStopped: 0, freshReferrer: true });
    assert.equal(await tryUnlockMilestone(fresh.client, config, 'referee'), true);
    assert.ok(fresh.held(), 'held at one');
    assert.ok(fresh.statements.some((sql) => /INSERT INTO audit_log/.test(sql)));
    // But a new account whose friend plays on past 110% is not.
    const played = fakeClient({ refereeWagered: 130_000_000n, earlierStopped: 0, freshReferrer: true });
    await tryUnlockMilestone(played.client, config, 'referee');
    assert.ok(!played.held());
  });

  it('leaves a hold already in place as it is, and writes no second audit row', async () => {
    const db = fakeClient({ refereeWagered: 100_000_000n, earlierStopped: 3, alreadyHeld: true });
    assert.equal(await tryUnlockMilestone(db.client, config, 'referee'), true);
    assert.ok(!db.audited());
  });
});

describe('the hold itself', () => {
  const repo = path.resolve(import.meta.dirname, '../../..');
  const read = async (relative: string) =>
    (await readFile(path.join(repo, relative), 'utf8')).replace(/\r\n/g, '\n');

  it('is the automatic payout hold: never on staff, never over another hold, queued payouts pulled back', async () => {
    const lib = await read('services/api-gateway/src/lib/referrals.ts');
    assert.match(lib, /WHERE u\.id = \$1 AND u\.payout_hold_reason IS NULL AND u\.status = 'active'\n\s*AND NOT \$\{staffPredicate\('u'\)\}/);
    assert.match(lib, /payout_hold_by = NULL/);
    assert.match(lib, /await holdQueuedForUser\(client, referrerId, reason\);/);
  });

  it('also stops tips, so the money cannot walk round the hold to another account', async () => {
    const social = await read('services/api-gateway/src/routes/social.ts');
    const tip = social.slice(social.indexOf("'/v1/social/tip'"));
    assert.match(tip, /'ACCOUNT_ON_HOLD'/);
    assert.ok(tip.indexOf("'ACCOUNT_ON_HOLD'") < tip.indexOf('UPDATE user_wallets SET balance_minor = balance_minor -'));
  });

  it('and item withdrawals, which have no approval queue to wait in', async () => {
    const transfers = await read('services/api-gateway/src/routes/transfers.ts');
    const withdraw = transfers.slice(transfers.indexOf("app.post('/v1/withdrawals'"));
    assert.match(withdraw, /'ACCOUNT_ON_HOLD'/);
    assert.ok(withdraw.indexOf("'ACCOUNT_ON_HOLD'") < withdraw.indexOf('FROM inventory_lots i JOIN catalog_items'));
  });
});
