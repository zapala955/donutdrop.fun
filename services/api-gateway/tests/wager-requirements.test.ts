import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Database, DbClient } from '../src/lib/db.js';
import { AppError } from '../src/lib/errors.js';
import {
  assertWagerRequirementMet,
  reduceWagerRequirement,
  requirementFor,
} from '../src/lib/wager-requirements.js';

const repo = path.resolve(import.meta.dirname, '../../..');
const read = (relative: string) => readFile(path.join(repo, relative), 'utf8');

const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  APP_ORIGIN: 'http://localhost:3000',
  COOKIE_SECRET: 'c'.repeat(32),
  DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  BOT_CREDENTIALS_JSON: JSON.stringify({
    '10000000-0000-4000-8000-000000000001': {
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

function recordingClient(remaining: string | null) {
  const statements: string[] = [];
  const client = {
    query: async (sql: string) => {
      statements.push(sql);
      if (sql.includes('FROM user_wager_requirements')) {
        return { rows: remaining === null ? [] : [{ remaining_minor: remaining }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as DbClient;
  return { client, statements };
}

describe('the wager requirement', () => {
  it('owes free money once and a deposit once, by default', () => {
    assert.equal(config.signupBonusMinor, 2_000_000n);
    assert.equal(config.signupBonusWagerMultiplier, 1);
    assert.equal(config.depositWagerMultiplier, 1);
    assert.equal(requirementFor(2_000_000n, 5), 10_000_000n);
    assert.equal(requirementFor(750n, 1), 750n);
    // 0 is "off", and nothing negative or fractional can add a requirement.
    assert.equal(requirementFor(2_000_000n, 0), 0n);
    assert.equal(requirementFor(0n, 5), 0n);
    assert.equal(requirementFor(2_000_000n, 1.5), 0n);
    // A deposit's settlement must never fail on an overflow.
    assert.equal(requirementFor(9_000_000_000_000_000_000n, 100), 9_223_372_036_854_775_807n);
  });

  it('refuses to let money leave while anything is owed, and says how much', async () => {
    const { client, statements } = recordingClient('10000000');
    await assert.rejects(
      assertWagerRequirementMet(client, 'user-1', 'withdrawing'),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'WAGER_REQUIREMENT' &&
        error.statusCode === 409 &&
        error.message === 'Wager $10,000,000 more before withdrawing' &&
        (error.details as { remainingMinor: string }).remainingMinor === '10000000',
    );
    // The wallet row is locked before the requirement is read; see assertWagerRequirementMet.
    assert.match(statements[0] ?? '', /FROM user_wallets WHERE user_id = \$1 FOR UPDATE/);
  });

  it('lets money leave once nothing is owed, or when nothing ever was', async () => {
    await assertWagerRequirementMet(recordingClient('0').client, 'user-1', 'tipping');
    await assertWagerRequirementMet(recordingClient(null).client, 'user-1', 'tipping');
  });

  it('counts wagers down without going below zero', async () => {
    const { client, statements } = recordingClient(null);
    await reduceWagerRequirement(client, 'user-1', 500n);
    assert.match(statements[0] ?? '', /GREATEST\(remaining_minor - \$2::bigint, 0\)/);
    assert.match(statements[0] ?? '', /remaining_minor > 0/);
    await reduceWagerRequirement(client, 'user-1', 0n);
    assert.equal(statements.length, 1);
  });

  it('is added by every deposit and counted down by every wager', async () => {
    const [settlement, auth, minecraft] = await Promise.all([
      read('services/api-gateway/src/lib/cash-settlement.ts'),
      read('services/api-gateway/src/routes/auth.ts'),
      read('services/api-gateway/src/routes/minecraft-in.ts'),
    ]);
    const recordWager = settlement.slice(settlement.indexOf('export async function recordWager('));
    assert.match(recordWager, /await reduceWagerRequirement\(client, userId, amountMinor\)/);
    assert.match(auth, /'signup_bonus', row\.id\)/);
    assert.match(auth, /requirementFor\(config\.signupBonusMinor, config\.signupBonusWagerMultiplier\)/);
    assert.match(auth, /addDepositRequirement\(client, config, row\.id, BigInt\(payment\.pay_amount!\)\)/);
    const cashDeposit = minecraft.slice(minecraft.indexOf("'cash_deposit',"));
    assert.match(cashDeposit.slice(0, 400), /addDepositRequirement\(client, config, userId, amount\)/);
  });

  it('guards every way money leaves an account, before the debit', async () => {
    const [withdrawals, social, transfers] = await Promise.all([
      read('services/api-gateway/src/routes/cash-withdrawals.ts'),
      read('services/api-gateway/src/routes/social.ts'),
      read('services/api-gateway/src/routes/transfers.ts'),
    ]);
    const cashGate = withdrawals.indexOf("assertWagerRequirementMet(client, userId, 'withdrawing')");
    const cashDebit = withdrawals.indexOf('balance_minor = balance_minor - $2', cashGate);
    assert.ok(cashGate > 0 && cashDebit > cashGate, 'cash withdrawal is not gated before its debit');
    const tipGate = social.indexOf("assertWagerRequirementMet(client, fromUserId, 'tipping')");
    const tipDebit = social.indexOf('balance_minor = balance_minor - $2', tipGate);
    assert.ok(tipGate > 0 && tipDebit > tipGate, 'tips are not gated before their debit');
    assert.match(transfers, /assertWagerRequirementMet\(client, userId, 'withdrawing'\)/);
  });

  it('locks every kind of free money, not only the signup bonus', async () => {
    /* The streak, quest rewards, Lava Rain shares and admin giveaways were credited with no
     * requirement at all, so an alt could collect them and withdraw having never placed a bet. Each
     * credit must be followed, before the next statement that could commit, by its lock at the
     * signup bonus's multiplier. */
    const [engagement, social, admin, daily, discord, crowns] = await Promise.all([
      read('services/api-gateway/src/routes/engagement.ts'),
      read('services/api-gateway/src/routes/social.ts'),
      read('services/api-gateway/src/routes/admin.ts'),
      read('services/api-gateway/src/lib/daily-codes.ts'),
      read('services/api-gateway/src/lib/discord-rewards.ts'),
      read('services/api-gateway/src/lib/crowns.ts'),
    ]);
    // `credit` is the line that pays: the ledger kind as the credit writes it.
    const lockedAfter = (source: string, credit: string, amount: string, file: string) => {
      const at = source.indexOf(credit);
      assert.ok(at > 0, `${file} no longer pays with ${credit}`);
      const lock = `requirementFor(${amount}, config.signupBonusWagerMultiplier)`;
      const after = source.slice(at, at + 900);
      assert.ok(after.includes(lock), `${credit} in ${file} is credited without a wager lock`);
    };
    lockedAfter(engagement, "'quest_reward',", 'reward', 'engagement.ts');
    lockedAfter(engagement, "'streak_reward',", 'reward', 'engagement.ts');
    lockedAfter(social, "'rain_claim',\n", 'each', 'social.ts');
    lockedAfter(admin, "$4, 'admin_adjustment', $5)", 'delta', 'admin.ts');
    lockedAfter(daily, "'daily_code_reward', row.id)", 'prize', 'daily-codes.ts');
    lockedAfter(crowns, "'bounty_reward', bounty.id)", 'prize', 'crowns.ts');
    assert.match(discord, /creditWallet\(client, userId, amount, kind, rewardId\);\s+await addWagerRequirement\(/);
    // A giveaway locks unless the operator says it is a refund; a debit never adds anything.
    assert.match(admin, /delta > 0n && body\.wagerLock !== false/);
  });

  it('gives the admin panel a giveaway and a refund, never one ambiguous credit', async () => {
    const panel = await read('DONUTDROP FRONTEND/Donut Drop/admin/admin.js');
    assert.match(panel, /lever\('Give money'[\s\S]{0,700}wagerLock: true/);
    assert.match(panel, /lever\('Refund'[\s\S]{0,700}wagerLock: false/);
    assert.doesNotMatch(panel, /lever\('Credit balance'/);
  });

  it('only widens the ledger kinds, adding signup_bonus', async () => {
    /* Narrowing a CHECK is validated against rows that already exist, which is how migration 030
     * took production down. 048 must keep every kind 039 allowed. */
    const kinds = (sql: string) => {
      const start = sql.indexOf('ADD CONSTRAINT wallet_transactions_kind_check');
      const list = sql.slice(start, sql.indexOf('));', start));
      return new Set([...list.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]));
    };
    const before = kinds(await read('packages/db/migrations/039_shared_roulette.sql'));
    const after = kinds(
      await read('packages/db/migrations/048_signup_bonus_and_wager_requirements.sql'),
    );
    assert.ok(before.size > 30);
    for (const kind of before) assert.ok(after.has(kind), `048 drops the ledger kind ${kind}`);
    assert.ok(after.has('signup_bonus'));
    assert.equal(after.size, before.size + 1);
  });
});

describe('the public promotions', () => {
  it('tells a visitor the signup bonus and the invite terms without a session', async () => {
    const database = {
      query: async () => ({ rows: [], rowCount: 0 }),
      close: async () => undefined,
    } as unknown as Database;
    const app = await buildApp(config, database);
    try {
      const response = await app.inject({ method: 'GET', url: '/v1/promotions' });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), {
        signupBonus: { amountMinor: '2000000', wagerMultiplier: 1, wagerMinor: '2000000' },
        // The lifetime share too: signed out, the invite page shows the whole deal (2026-10-25).
        referral: { bonusMinor: '20000000', bonusWagerMinor: '50000000', revshareWagerBps: 50 },
        depositWagerMultiplier: 1,
      });
    } finally {
      await app.close();
    }
  });
});
