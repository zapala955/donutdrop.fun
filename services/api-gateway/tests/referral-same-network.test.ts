import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { QueryResult, QueryResultRow } from 'pg';
import { loadConfig } from '../src/config.js';
import { hmacHex } from '../src/lib/crypto.js';
import type { DbClient } from '../src/lib/db.js';
import { networkHash, networkOf, SAME_NETWORK_REASON } from '../src/lib/referral-network.js';
import { claimReferralRewards, tryUnlockMilestone } from '../src/lib/referrals.js';

/* Inviting your own second account: an invite between two accounts that have used the same network
 * is voided, at the invite and again before any referral money is paid. Only that invite: neither
 * account is blocked, and both go on earning from the other players they invite. */

const repo = path.resolve(import.meta.dirname, '../../..');
// Line endings normalised: a checkout on Windows has CRLF, and the markers below are written with LF.
const read = async (relative: string) =>
  (await readFile(path.join(repo, relative), 'utf8')).replace(/\r\n/g, '\n');

const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  APP_ORIGIN: 'http://localhost:3000',
  PUBLIC_BASE_URL: 'http://localhost:3001',
  COOKIE_SECRET: 'c'.repeat(32),
  DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  INTERNAL_WEBHOOK_SECRET: 'w'.repeat(32),
  BOT_CREDENTIALS_JSON: JSON.stringify({
    '10000000-0000-4000-8000-000000000099': {
      secret: Buffer.alloc(32, 2).toString('base64'),
      serverHost: 'donutsmp.net',
      username: 'DonutBot',
    },
  }),
  AUDIT_LOG_HMAC_KEY: 'a'.repeat(32),
  IP_HASH_KEY: 'i'.repeat(32),
  LOG_LEVEL: 'silent',
  REFERRALS_ENABLED: 'true',
});

const REFEREE = '20000000-0000-4000-8000-000000000002';
const REFERRER = '30000000-0000-4000-8000-000000000003';
const GENUINE = '40000000-0000-4000-8000-000000000004';

function result<R extends QueryResultRow>(rows: R[], rowCount = rows.length): QueryResult<R> {
  return { command: '', rowCount, oid: 0, fields: [], rows };
}

/**
 * One referral past its milestone with a balance to claim, and what the standing check answers.
 * With `genuine`, the referrer also has a second invitee, on another network, with 7000 to claim.
 */
class Programme implements DbClient {
  readonly statements: Array<{ text: string; values: unknown[] }> = [];
  readonly credits: Array<{ kind: string; amount: string }> = [];
  voided = false;
  blocked = new Set<string>();

  constructor(
    private readonly standing: { referrerBlocked: boolean; sharedNetwork: boolean },
    private readonly reviewed = false,
    private readonly genuine = false,
  ) {
    if (standing.referrerBlocked) this.blocked.add(REFERRER);
  }

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<QueryResult<R>> {
    this.statements.push({ text, values });
    const rows = (list: unknown[]) => result(list as R[]);
    if (text.includes('AS shared_network')) {
      const shared = values[0] === REFEREE && this.standing.sharedNetwork;
      return rows([{ referrer_blocked: this.blocked.has(REFERRER), shared_network: shared }]);
    }
    if (text.includes('FROM referrals') && text.includes('WHERE referrer_id = $1') && text.includes('FOR UPDATE')) {
      return rows([
        { referee_id: REFEREE, revshare_claimable_minor: '5000', network_reviewed_at: this.reviewed ? new Date() : null },
        ...(this.genuine ? [{ referee_id: GENUINE, revshare_claimable_minor: '7000', network_reviewed_at: null }] : []),
      ]);
    }
    if (text.includes('FROM referrals') && text.includes('FOR UPDATE')) {
      return rows([{ referrer_id: REFERRER, wagered_minor: String(config.referralBonusWagerMinor), bonus_unlocked_at: null, network_reviewed_at: this.reviewed ? new Date() : null }]);
    }
    if (text.includes('UPDATE referrals') && text.includes('voided_at = now()')) {
      this.voided = true;
      return rows([{ revshare_claimable_minor: '5000' }]);
    }
    if (text.includes('UPDATE users') && text.includes('referral_blocked_at')) {
      throw new Error('the same-network check must not block an account');
    }
    if (text.includes('INSERT INTO referral_earnings')) return result([], 1);
    if (text.includes('UPDATE user_wallets')) return rows([{ balance_minor: '1' }]);
    if (text.includes('INSERT INTO wallet_transactions')) {
      this.credits.push({ kind: String(values[4]), amount: String(values[2]) });
      return result([], 1);
    }
    return rows([]);
  }

  audited(): unknown[] {
    return this.statements
      .filter(({ text }) => text.includes('INSERT INTO audit_log'))
      .map(({ values }) => values[2]);
  }
}

describe('what counts as one network', () => {
  it('is an IPv4 address itself, hashed exactly as sign-in has always hashed it', () => {
    assert.equal(networkOf('83.21.4.9'), '83.21.4.9');
    assert.equal(networkOf('::ffff:83.21.4.9'), '83.21.4.9');
    // Comparable with sessions.ip_hash, which the migration seeds the table from.
    assert.deepEqual(networkHash(config, '83.21.4.9'), Buffer.from(hmacHex(config.ipHashKey, '83.21.4.9'), 'hex'));
  });

  it('is an IPv6 /64, so a device rotating its address is still the same household', () => {
    assert.equal(networkOf('2a02:a31a:4040:2c00:5d3e:9c1:41b8:22f1'), '2a02:a31a:4040:2c00::/64');
    assert.equal(networkOf('2a02:a31a:4040:2c00::1'), '2a02:a31a:4040:2c00::/64');
    assert.notEqual(networkOf('2a02:a31a:4040:2c01::1'), networkOf('2a02:a31a:4040:2c00::1'));
    assert.equal(networkOf('64:ff9b::808:808'), '8.8.8.8');
  });

  it('is never a private or proxy address, which would make every player one person', () => {
    for (const internal of ['127.0.0.1', '10.1.2.3', '172.29.0.1', '172.30.0.5', '192.168.0.10',
      '100.64.0.1', '169.254.1.1', '::1', '::', 'fe80::1', 'fd12::1']) {
      assert.equal(networkOf(internal), null, internal);
      assert.equal(networkHash(config, internal), null, internal);
    }
    for (const junk of ['', 'nonsense', '1::2::3', '1:2:3:4:5:6:7:8:9', undefined, null]) {
      assert.equal(networkOf(junk), null, String(junk));
    }
  });
});

describe('the milestone bonus', () => {
  it('is not paid to an inviter whose invite shares their network: voided, audited, nobody blocked', async () => {
    const client = new Programme({ referrerBlocked: false, sharedNetwork: true });
    assert.equal(await tryUnlockMilestone(client, config, REFEREE), false);
    assert.deepEqual(client.credits, []);
    assert.equal(client.voided, true);
    assert.deepEqual([...client.blocked], []);
    assert.deepEqual(client.audited(), ['referral.same_network']);
    const voiding = client.statements.find(({ text }) => text.includes('voided_at = now()'))!;
    assert.match(voiding.text, /voided_by = NULL/);
    assert.deepEqual(voiding.values, [REFEREE, SAME_NETWORK_REASON]);
  });

  it('waits while the inviter is blocked, without voiding anything', async () => {
    const client = new Programme({ referrerBlocked: true, sharedNetwork: false });
    assert.equal(await tryUnlockMilestone(client, config, REFEREE), false);
    assert.deepEqual(client.credits, []);
    assert.equal(client.voided, false);
  });

  it('pays a pair an administrator has restored, network or not', async () => {
    const client = new Programme({ referrerBlocked: false, sharedNetwork: true }, true);
    assert.equal(await tryUnlockMilestone(client, config, REFEREE), true);
    assert.deepEqual(client.credits.map(({ kind }) => kind), ['referral_bonus']);
    assert.equal(client.voided, false);
  });

  it('pays an ordinary invite exactly as before', async () => {
    const client = new Programme({ referrerBlocked: false, sharedNetwork: false });
    assert.equal(await tryUnlockMilestone(client, config, REFEREE), true);
    assert.deepEqual(client.credits.map(({ kind }) => kind), ['referral_bonus']);
  });
});

describe('claiming revenue share', () => {
  it('voids an invite that turns out to share the network, and pays the genuine ones', async () => {
    const client = new Programme({ referrerBlocked: false, sharedNetwork: true }, false, true);
    const claim = await claimReferralRewards(client, config, REFERRER, '83.21.4.9');
    assert.equal(claim.blocked || claim.empty ? null : claim.claimedMinor, '7000');
    assert.equal(claim.blocked ? null : claim.voidedInvites, 1);
    assert.deepEqual(client.credits, [{ kind: 'referral_revshare', amount: '7000' }]);
    assert.equal(client.voided, true);
    assert.deepEqual([...client.blocked], []);
    // Only the genuine invite's balance moves to paid; the voided one keeps its frozen figure.
    const paid = client.statements.find(({ text }) => text.includes('revshare_claimable_minor = 0'))!;
    assert.deepEqual(paid.values, [REFERRER, [GENUINE]]);
    // The network the claim came from is recorded before anything is compared.
    const first = client.statements.findIndex(({ text }) => text.includes('INSERT INTO user_networks'));
    const compared = client.statements.findIndex(({ text }) => text.includes('AS shared_network'));
    assert.ok(first >= 0 && first < compared);
  });

  it('pays nothing when the only balance was the self-invite, and keeps the void', async () => {
    const client = new Programme({ referrerBlocked: false, sharedNetwork: true });
    // Returned, not thrown: thrown inside the transaction, the void would roll back with it.
    assert.deepEqual(await claimReferralRewards(client, config, REFERRER), {
      blocked: false,
      empty: true,
      voidedInvites: 1,
    });
    assert.deepEqual(client.credits, []);
    assert.equal(client.voided, true);
    assert.deepEqual([...client.blocked], []);
  });

  it('pays nothing to an inviter an administrator blocked, and voids nothing more', async () => {
    const client = new Programme({ referrerBlocked: true, sharedNetwork: false });
    assert.deepEqual(await claimReferralRewards(client, config, REFERRER), { blocked: true });
    assert.deepEqual(client.credits, []);
    assert.equal(client.voided, false);
  });

  it('pays an ordinary inviter as before', async () => {
    const client = new Programme({ referrerBlocked: false, sharedNetwork: false });
    const claim = await claimReferralRewards(client, config, REFERRER);
    assert.equal(claim.blocked, false);
    assert.deepEqual(client.credits, [{ kind: 'referral_revshare', amount: '5000' }]);
  });
});

describe('the invite itself', () => {
  it('at sign-up: a blocked inviter recruits nobody, and an invite from their own network is voided', async () => {
    const auth = await read('services/api-gateway/src/routes/auth.ts');
    const signup = auth.slice(auth.indexOf('The invite code is redeemed HERE'), auth.indexOf('The signup bonus'));
    assert.match(signup, /referralStanding\(client, row\.id, referrerId\)/);
    assert.match(signup, /if \(!standing\.referrerBlocked\) \{/);
    assert.match(signup, /if \(bound\.rowCount && standing\.sharedNetwork\) \{\s*await voidSameNetworkReferral\(client, config, row\.id, referrerId, 'invite'\);/);
    // The network is on record before the comparison is made.
    assert.ok(auth.indexOf('await recordNetwork(client, config, row.id, request.ip);') < auth.indexOf('referralStanding(client, row.id'));
  });

  it('in Settings: refused for blocked accounts, and a self-invite is recorded before it is refused', async () => {
    const routes = await read('services/api-gateway/src/routes/referrals.ts');
    const attach = routes.slice(routes.indexOf("'/v1/referrals/attach'"), routes.indexOf('// ── Discord verification'));
    assert.match(attach, /if \(await referralBlocked\(client, userId\)\) throw blockedError\(\);/);
    assert.match(attach, /'REFERRAL_CODE_BLOCKED'/);
    assert.match(attach, /return \{ sameNetwork: true as const \};/);
    // Thrown after the transaction: thrown inside, the void would roll back with it.
    const after = attach.slice(attach.indexOf('      });\n      // Thrown after the commit'));
    assert.match(after, /'REFERRAL_SAME_NETWORK'/);
    assert.match(after, /Both accounts can still earn from inviting other players\./);
    // So is the claim's, when the self-invite was all there was to collect.
    const claim = routes.slice(routes.indexOf("'/v1/referrals/claim'"), routes.indexOf('// ── choosing your own code'));
    assert.match(claim, /if \(claim\.empty\) \{\s*throw new AppError\(\s*409,\s*'REFERRAL_SAME_NETWORK',/);
  });

  it('blocks nobody: the only write to the block columns is the administrator\'s', async () => {
    for (const file of ['lib/referral-network.ts', 'lib/referrals.ts', 'routes/referrals.ts', 'routes/auth.ts']) {
      const code = await read(`services/api-gateway/src/${file}`);
      assert.doesNotMatch(code, /referral_blocked_at =|blockSameNetworkReferral/, file);
    }
  });

  it('is shown to a blocked player as a reason and a way to dispute it, not as an offer', async () => {
    const page = await read('DONUTDROP FRONTEND/Donut Drop/assets/js/referrals.js');
    assert.match(page, /if \(data\.self\?\.referralBlocked\) \{\s*root\.appendChild\(blockedNotice\(\)\);\s*return;/);
    assert.match(page, /support\.href = '\/support';/);
    const route = await read('services/api-gateway/src/routes/referrals.ts');
    assert.match(route, /referralBlocked: blocked,/);
  });
});

describe('what an administrator can do about it', () => {
  it('restores a pair for good, and lifts a block with an audited reason', async () => {
    const admin = await read('services/api-gateway/src/routes/admin-operations.ts');
    assert.match(admin, /network_reviewed_at = CASE WHEN \$2::boolean THEN network_reviewed_at\s*ELSE now\(\) END/);
    const block = admin.slice(admin.indexOf("'/v1/admin/referral-blocks/:id'"));
    assert.match(block.slice(0, 2000), /preHandler: guards\.requireAdmin/);
    assert.match(block.slice(0, 2000), /action: body\.blocked \? 'referral\.block' : 'referral\.unblock'/);
    const console = await read('DONUTDROP FRONTEND/Donut Drop/admin/admin.js');
    assert.match(console, /api\.patch\(`\/v1\/admin\/referral-blocks\/\$\{account\.id\}`, \{ blocked: false, reason \}\)/);
    assert.match(console, /\['Blocked', 'blocked'\]/);
  });
});

describe('the migrations', () => {
  it('lifts only the blocks the check set, and leaves the voids and hand-set blocks alone', async () => {
    const sql = await read('packages/db/migrations/074_referral_network_unblock.sql');
    const update = sql.slice(sql.indexOf('UPDATE users'), sql.indexOf(';', sql.indexOf('UPDATE users')));
    assert.match(update, /SET referral_blocked_at = NULL,\s*referral_block_reason = NULL,/);
    // The exact text the check wrote, so no administrator's own reason can match it.
    assert.ok(update.includes(`AND referral_block_reason = '${SAME_NETWORK_REASON}'`));
    assert.doesNotMatch(sql, /UPDATE referrals|DELETE FROM/);
    assert.match(sql, /CREATE FUNCTION donut_schema_ready_v74\(\) RETURNS boolean/);
  });

  it('adds the block, the network table and an automatic void, without rewriting anything', async () => {
    const sql = await read('packages/db/migrations/066_referral_same_network.sql');
    assert.match(sql, /ADD COLUMN referral_blocked_at timestamptz/);
    assert.match(sql, /CREATE TABLE user_networks/);
    assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE user_networks TO donut_api_runtime;/);
    // Weaker than migration 045's rule, so every existing row passes it.
    assert.match(sql, /num_nonnulls\(voided_at, void_reason\) IN \(0, 2\)/);
    assert.match(sql, /CREATE FUNCTION donut_schema_ready_v66\(\) RETURNS boolean/);
    assert.doesNotMatch(sql, /UPDATE (wallet_transactions|referral_earnings|referral_claims)/);
  });

  it('keeps network records only 90 days', async () => {
    const maintenance = await read('services/api-gateway/scripts/maintenance.ts');
    assert.match(maintenance, /DELETE FROM user_networks WHERE last_seen_at < now\(\) - interval '90 days'/);
  });
});
