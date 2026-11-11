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
     * credit must be followed, before the next statement that could commit, by its lock: at the
     * signup bonus's multiplier, but a quest reward at the quests' own and the referral milestone at
     * the referral bonus's. */
    const [engagement, social, admin, drops, discord, crowns] = await Promise.all([
      read('services/api-gateway/src/routes/engagement.ts'),
      read('services/api-gateway/src/routes/social.ts'),
      read('services/api-gateway/src/routes/admin.ts'),
      read('services/api-gateway/src/lib/code-drops.ts'),
      read('services/api-gateway/src/lib/discord-rewards.ts'),
      read('services/api-gateway/src/lib/crowns.ts'),
    ]);
    // `credit` is the line that pays: the ledger kind as the credit writes it.
    const lockedAfter = (source: string, credit: string, amount: string, file: string, multiplier = 'signupBonusWagerMultiplier', reach = 900) => {
      const at = source.indexOf(credit);
      assert.ok(at > 0, `${file} no longer pays with ${credit}`);
      const lock = `requirementFor(${amount}, config.${multiplier})`;
      const after = source.slice(at, at + reach);
      assert.ok(after.includes(lock), `${credit} in ${file} is credited without a wager lock`);
    };
    lockedAfter(engagement, "'quest_reward',", 'reward', 'engagement.ts', 'questRewardWagerMultiplier');
    const [board, referrals] = await Promise.all([
      read('services/api-gateway/src/lib/quest-board.ts'),
      read('services/api-gateway/src/lib/referrals.ts'),
    ]);
    // The claim's row goes in between, in the same transaction: a second claim rolls the credit back.
    lockedAfter(board, "'quest_reward', claimId)", 'reward', 'quest-board.ts', 'questRewardWagerMultiplier', 1400);
    lockedAfter(referrals, "'referral_bonus', refereeId)", 'bonus', 'referrals.ts', 'referralBonusWagerMultiplier');
    lockedAfter(engagement, "'streak_reward',", 'reward', 'engagement.ts');
    lockedAfter(social, "'rain_claim',\n", 'each', 'social.ts');
    lockedAfter(admin, "$4, 'admin_adjustment', $5)", 'delta', 'admin.ts');
    // A code drop carries its own multiple, copied onto it when it was minted (3x by default).
    assert.match(drops, /const owed = requirementFor\(prize, Number\(drop\.wager_multiplier\)\);/);
    assert.match(drops, /await creditWallet\(client, user\.id, prize, 'daily_code_reward', claimId\);\s+await addWagerRequirement\(client, user\.id, owed\);/);
    lockedAfter(crowns, "'bounty_reward', bounty.id)", 'prize', 'crowns.ts');
    assert.match(discord, /creditWallet\(client, userId, amount, kind, rewardId\);\s+await addWagerRequirement\(/);
    // A giveaway locks unless the operator says it is a refund; a debit never adds anything.
    assert.match(admin, /delta > 0n && body\.wagerLock !== false/);
  });

  it('prices each kind of free money by its own live setting, defaulting to 5x, 3x and 1x as asked', async () => {
    const settings = await read('services/api-gateway/src/lib/runtime-settings.ts');
    for (const key of ['signupBonusWagerMultiplier', 'questRewardWagerMultiplier', 'referralBonusWagerMultiplier', 'depositWagerMultiplier']) {
      assert.match(settings, new RegExp(`  ${key}: \\{\\n    kind: 'integer',`), key);
    }
    assert.equal(config.questRewardWagerMultiplier, 3);
    assert.equal(config.referralBonusWagerMultiplier, 1);
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
        // What a referral link's visitor is offered instead of the signup bonus.
        referralSignupBonus: { amountMinor: '10000000', wagerMultiplier: 10, wagerMinor: '100000000' },
        depositWagerMultiplier: 1,
      });
    } finally {
      await app.close();
    }
  });
});

/* Against a real database when CI provides one: the operator's own example. A signup bonus, then a
 * deposit: the bonus's requirement must still be there, the deposit's added to it, and nothing may
 * leave until both are wagered. */
const requirementDatabaseUrl = process.env['TEST_DATABASE_URL'];

describe('the wager requirement against PostgreSQL', { skip: !requirementDatabaseUrl }, () => {
  it('keeps the bonus requirement through a deposit, adds the deposit, and holds every withdrawal until both are wagered', async () => {
    if (!requirementDatabaseUrl) return;
    const { randomUUID } = await import('node:crypto');
    const pg = (await import('pg')).default;
    const { addDepositRequirement, addWagerRequirement, wagerRequirementRemaining } = await import('../src/lib/wager-requirements.js');
    const pool = new pg.Pool({ connectionString: requirementDatabaseUrl, max: 1 });
    const user = randomUUID();
    const tag = user.slice(0, 8);
    const atMultipliers = (bonus: number, deposit: number) =>
      ({ ...config, signupBonusWagerMultiplier: bonus, depositWagerMultiplier: deposit }) as typeof config;
    try {
      await pool.query(
        `INSERT INTO users (id, minecraft_identity, minecraft_username, normalized_username, role, status, terms_accepted_at)
         VALUES ($1, $2, $3, $4, 'player', 'active', now())`,
        [user, `mc:wager${tag}`, `Wager${tag}`, `wager${tag}`],
      );
      await pool.query('INSERT INTO user_wallets (user_id, balance_minor) VALUES ($1, 100000000)', [user]);
      const blocked = () => assert.rejects(assertWagerRequirementMet(pool, user, 'withdrawing'), { code: 'WAGER_REQUIREMENT' });

      // A $1M bonus at 3x: $3M owed. A $50M deposit at 0x leaves it exactly where it was.
      let rules = atMultipliers(3, 0);
      await addWagerRequirement(pool, user, requirementFor(1_000_000n, rules.signupBonusWagerMultiplier));
      assert.equal(await wagerRequirementRemaining(pool, user), 3_000_000n);
      await addDepositRequirement(pool, rules, user, 50_000_000n);
      assert.equal(await wagerRequirementRemaining(pool, user), 3_000_000n, 'a deposit never clears the bonus requirement');
      await blocked();

      // At 1x a deposit adds its own amount on top; it never replaces what was owed.
      rules = atMultipliers(3, 1);
      await addDepositRequirement(pool, rules, user, 10_000_000n);
      assert.equal(await wagerRequirementRemaining(pool, user), 13_000_000n);

      // Wagers count it down, whatever money they were made with, and never below zero.
      await reduceWagerRequirement(pool, user, 12_000_000n);
      assert.equal(await wagerRequirementRemaining(pool, user), 1_000_000n);
      await blocked();
      await reduceWagerRequirement(pool, user, 5_000_000n);
      assert.equal(await wagerRequirementRemaining(pool, user), 0n);
      await assert.doesNotReject(assertWagerRequirementMet(pool, user, 'withdrawing'));

      // At 0x the bonus owes nothing at all: that is the setting, not the code.
      rules = atMultipliers(0, 0);
      await addWagerRequirement(pool, user, requirementFor(1_000_000n, rules.signupBonusWagerMultiplier));
      assert.equal(await wagerRequirementRemaining(pool, user), 0n);
    } finally {
      await pool.end();
    }
  });
});

/* The owner, 2026-11-11: "when someone loses their money if they all in and then deposit again the
 * old deposits counts too". Losses never counted a requirement down, so a busted player's leftover
 * stacked onto their next deposit. The behaviour was run against a real database before shipping;
 * these pin the guards that keep the forgiveness from being a way round the wagering. */
describe('a requirement dies with the money it was for', () => {
  it('forgives the leftover on a deposit made from a spent balance, before adding the deposit\u2019s own', async () => {
    const source = await read('services/api-gateway/src/lib/wager-requirements.ts');
    const deposit = source.slice(source.indexOf('export async function addDepositRequirement'));
    assert.match(deposit, /await forgiveSpentRequirement\(client, userId, depositMinor\);\s+await addWagerRequirement\(/);
    assert.match(source, /export const SPENT_BALANCE_MINOR = 1_000n;/);
    assert.match(source, /balance_minor FROM user_wallets w WHERE w\.user_id = \$1\) - \$2::bigint < \$3::bigint/);
  });

  it('forgives nothing while a stake is still in play or items are still held', async () => {
    const source = await read('services/api-gateway/src/lib/wager-requirements.ts');
    const query = source.slice(source.indexOf('export async function forgiveSpentRequirement'));
    for (const table of [
      'mines_games', 'tower_games', 'chicken_games', 'blackjack_hands', 'ice_fishing_games',
      'fishing_casts', 'crash_bets', 'roulette_bets', 'side_bets', 'coinflip_games',
      'mines_duel_games', 'duel_lobbies', 'battle_players', 'inventory_lots',
    ]) {
      assert.ok(query.includes(`NOT EXISTS (SELECT 1 FROM ${table} `), table);
    }
  });
});
