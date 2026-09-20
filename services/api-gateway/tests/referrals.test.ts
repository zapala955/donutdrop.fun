import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { QueryResult, QueryResultRow } from 'pg';
import { loadConfig, type AppConfig } from '../src/config.js';
import type { DbClient } from '../src/lib/db.js';
import { accrueReferralWager, revshareMinor, tryUnlockMilestone } from '../src/lib/referrals.js';

const migrationPath = path.resolve(
  import.meta.dirname,
  '../../../packages/db/migrations/016_referrals_and_discord.sql',
);
const settlementPath = path.resolve(import.meta.dirname, '../src/lib/cash-settlement.ts');

const baseEnv = {
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
  REFERRALS_ENABLED: 'true',
  DISCORD_CLIENT_ID: '123456789012345678',
  DISCORD_CLIENT_SECRET: 'd'.repeat(32),
  DISCORD_REDIRECT_URI: 'http://localhost:3001/v1/referrals/discord/callback',
};

const REFEREE = '20000000-0000-4000-8000-000000000002';
const REFERRER = '30000000-0000-4000-8000-000000000003';

function result<R extends QueryResultRow>(rows: R[], rowCount = rows.length): QueryResult<R> {
  return { command: '', rowCount, oid: 0, fields: [], rows };
}

interface ReferralState {
  wagered: bigint;
  discordVerified: boolean;
  bonusUnlocked: boolean;
  /** Reference ids the earnings table has already seen, which is what makes a replay a no-op. */
  seenEarnings: Set<string>;
}

/**
 * A fake that models the three tables the engine touches, rather than a script of canned rows.
 *
 * Modelling them matters here: the properties worth testing are "a replayed round pays once" and
 * "the bonus fires on whichever condition lands second", and neither of those is observable
 * against a stub that returns the same answer every call.
 */
class ReferralClient implements DbClient {
  readonly credits: { userId: string; amount: bigint; kind: string; reference: string }[] = [];
  readonly state: ReferralState;

  constructor(
    state: Partial<ReferralState> = {},
    private readonly hasReferral = true,
  ) {
    this.state = {
      wagered: 0n,
      discordVerified: false,
      bonusUnlocked: false,
      seenEarnings: new Set(),
      ...state,
    };
  }

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<QueryResult<R>> {
    if (text.includes('FROM referrals') && text.includes('JOIN users')) {
      if (!this.hasReferral) return result([]);
      return result([
        {
          referrer_id: REFERRER,
          wagered_minor: this.state.wagered.toString(),
          bonus_unlocked_at: this.state.bonusUnlocked ? new Date() : null,
          discord_verified_at: this.state.discordVerified ? new Date() : null,
        },
      ] as unknown as R[]);
    }
    if (text.includes('FROM referrals WHERE referee_id')) {
      if (!this.hasReferral) return result([]);
      return result([
        {
          referrer_id: REFERRER,
          wagered_minor: this.state.wagered.toString(),
          bonus_unlocked_at: this.state.bonusUnlocked ? new Date() : null,
        },
      ] as unknown as R[]);
    }
    if (text.includes('UPDATE referrals') && text.includes('wagered_minor = $2')) {
      this.state.wagered = BigInt(String(values[1]));
      return result([], 1);
    }
    if (text.includes('UPDATE referrals') && text.includes('bonus_unlocked_at = now()')) {
      this.state.bonusUnlocked = true;
      return result([], 1);
    }
    if (text.includes('INSERT INTO referral_earnings')) {
      // The unique index is on (kind, reference_id), so the key here is the same pair.
      const kind = text.includes("'milestone'") ? 'milestone' : 'revshare';
      const reference = kind === 'milestone' ? String(values[2]) : String(values[5]);
      const key = `${kind}:${reference}`;
      if (this.state.seenEarnings.has(key)) return result([], 0);
      this.state.seenEarnings.add(key);
      return result([], 1);
    }
    if (text.includes('INSERT INTO user_wallets')) return result([], 1);
    if (text.includes('UPDATE user_wallets')) {
      return result([{ balance_minor: '999999999' }] as unknown as R[], 1);
    }
    if (text.includes('INSERT INTO wallet_transactions')) {
      this.credits.push({
        userId: String(values[1]),
        amount: BigInt(String(values[2])),
        kind: String(values[4]),
        reference: String(values[5]),
      });
      return result([], 1);
    }
    return result([]);
  }
}

const config = (overrides: Record<string, string> = {}): AppConfig =>
  loadConfig({ ...baseEnv, ...overrides });

describe('referral revenue share', () => {
  it('pays a cut of the house margin, never a cut of the wager', () => {
    const settings = config();
    // 5% house edge on 1,000,000 is a 50,000 margin; 5% of that margin is 2,500.
    assert.equal(settings.houseEdgeBps, 500);
    assert.equal(settings.referralRevshareBps, 500);
    assert.equal(revshareMinor(settings, 1_000_000n), 2_500n);
    // Emphatically not 5% of the wager, which would be twenty times larger.
    assert.notEqual(revshareMinor(settings, 1_000_000n), 50_000n);
  });

  it('truncates rather than rounding a fraction of a unit up', () => {
    const settings = config();
    // A wager too small to produce a whole unit of commission earns nothing at all.
    assert.equal(revshareMinor(settings, 100n), 0n);
    assert.equal(revshareMinor(settings, 0n), 0n);
    assert.equal(revshareMinor(settings, -5n), 0n);
  });

  it('credits the referrer once per round, however many times it is replayed', async () => {
    const client = new ReferralClient();
    const settings = config();
    const round = '40000000-0000-4000-8000-000000000004';

    await accrueReferralWager(client, settings, REFEREE, 1_000_000n, 'case', round);
    await accrueReferralWager(client, settings, REFEREE, 1_000_000n, 'case', round);

    const paid = client.credits.filter((entry) => entry.kind === 'referral_revshare');
    assert.equal(paid.length, 1);
    assert.equal(paid[0]?.amount, 2_500n);
    assert.equal(paid[0]?.userId, REFERRER);
  });

  it('does nothing at all for a player nobody referred', async () => {
    const client = new ReferralClient({}, false);
    await accrueReferralWager(client, config(), REFEREE, 10_000_000n, 'upgrader', 'round-1');
    assert.equal(client.credits.length, 0);
  });

  it('stays out of the way entirely when the programme is off', async () => {
    const client = new ReferralClient({ discordVerified: true, wagered: 99_000_000n });
    const off = loadConfig(baseEnv0());
    await accrueReferralWager(client, off, REFEREE, 10_000_000n, 'upgrader', 'round-1');
    assert.equal(client.credits.length, 0);
    assert.equal(client.state.bonusUnlocked, false);
  });
});

describe('referral milestone bonus', () => {
  it('needs both conditions, and fires on whichever lands second', async () => {
    /* Every figure below is read off the settings rather than written in.
     *
     * These numbers used to be literals — 24M, 26M, 20M — pinned to the defaults of the day, so
     * retuning the programme failed four tests that have no opinion about what the bonus is. The
     * gate is what is under test: BOTH conditions, in either order, exactly once. What the two
     * thresholds happen to be is one test's business, below, and not this one's. */
    const settings = config();
    const gate = settings.referralBonusWagerMinor;

    // Wager threshold crossed, Discord still unverified: nothing is owed.
    const wagerFirst = new ReferralClient({ wagered: gate - 1_000_000n });
    await accrueReferralWager(wagerFirst, settings, REFEREE, 2_000_000n, 'case', 'round-a');
    assert.equal(wagerFirst.state.wagered, gate + 1_000_000n);
    assert.equal(wagerFirst.state.bonusUnlocked, false);
    assert.equal(
      wagerFirst.credits.some((entry) => entry.kind === 'referral_bonus'),
      false,
    );

    // Discord arrives afterwards. The gate is retested from the verification path and pays.
    wagerFirst.state.discordVerified = true;
    assert.equal(await tryUnlockMilestone(wagerFirst, settings, REFEREE), true);
    const bonus = wagerFirst.credits.filter((entry) => entry.kind === 'referral_bonus');
    assert.equal(bonus.length, 1);
    assert.equal(bonus[0]?.amount, settings.referralBonusMinor);
    assert.equal(bonus[0]?.userId, REFERRER);
  });

  it('fires from the wager path when Discord was verified first', async () => {
    const settings = config();
    const gate = settings.referralBonusWagerMinor;
    const client = new ReferralClient({ discordVerified: true, wagered: gate - 1n });
    await accrueReferralWager(client, settings, REFEREE, 1n, 'upgrader', 'round-b');
    assert.equal(client.state.wagered, gate);
    assert.equal(client.state.bonusUnlocked, true);
    assert.equal(client.credits.filter((e) => e.kind === 'referral_bonus').length, 1);
  });

  it('refuses to pay a verified referee who is one unit short', async () => {
    const settings = config();
    const client = new ReferralClient({
      discordVerified: true,
      wagered: settings.referralBonusWagerMinor - 1n,
    });
    assert.equal(await tryUnlockMilestone(client, settings, REFEREE), false);
    assert.equal(client.credits.length, 0);
  });

  it('pays exactly once, even if the gate is somehow entered twice', async () => {
    const settings = config();
    const client = new ReferralClient({
      discordVerified: true,
      wagered: settings.referralBonusWagerMinor,
    });

    assert.equal(await tryUnlockMilestone(client, settings, REFEREE), true);
    // Force the row back to its pre-payment state: only the earnings index should stop the second
    // payment, which is the guarantee the unique constraint is actually there to provide.
    client.state.bonusUnlocked = false;
    assert.equal(await tryUnlockMilestone(client, settings, REFEREE), false);
    assert.equal(client.credits.filter((e) => e.kind === 'referral_bonus').length, 1);
  });

  it('references the referee, so the bonus is unpayable twice by construction', async () => {
    const settings = config();
    const client = new ReferralClient({
      discordVerified: true,
      wagered: settings.referralBonusWagerMinor,
    });
    await tryUnlockMilestone(client, settings, REFEREE);
    const bonus = client.credits.find((entry) => entry.kind === 'referral_bonus');
    assert.equal(bonus?.reference, REFEREE);
  });
});

describe('referral configuration', () => {
  it('refuses to run the programme without a Discord application', () => {
    assert.throws(() => loadConfig({ ...baseEnv, DISCORD_CLIENT_ID: '' }));
    assert.throws(() => loadConfig({ ...baseEnv, DISCORD_CLIENT_SECRET: '' }));
    assert.throws(() => loadConfig({ ...baseEnv, DISCORD_REDIRECT_URI: '' }));
  });

  it('refuses a bonus larger than the wager that unlocks it', () => {
    assert.throws(() =>
      loadConfig({
        ...baseEnv,
        REFERRAL_BONUS_MINOR: '30000000',
        REFERRAL_BONUS_WAGER_MINOR: '25000000',
      }),
    );
  });

  it('defaults to the published $10M bonus at a $100M wager gate', () => {
    /* The one place the figures are written down, on purpose: this test is the record of what the
     * programme pays, so changing the terms has to change it and be read in review. Everything
     * else derives from the config.
     *
     * $10M for $100M wagered is a 10% cost of acquisition against a margin thinner than that on
     * every mode, so it is the WAGER GATE that makes it solvent rather than the bonus being small.
     * It is not a signup bonus and it must not be retuned into one. */
    const settings = config();
    assert.equal(settings.referralBonusMinor, 10_000_000n);
    assert.equal(settings.referralBonusWagerMinor, 100_000_000n);
    assert.ok(
      settings.referralBonusWagerMinor >= settings.referralBonusMinor * 10n,
      'the gate must stay at least ten times the bonus, or acquisition costs more than 10%',
    );
  });
});

describe('referral schema and wiring', () => {
  it('makes every payment append-only and idempotent on its natural key', async () => {
    const sql = await readFile(migrationPath, 'utf8');
    assert.match(sql, /CREATE TABLE referral_earnings/);
    assert.match(sql, /CREATE TRIGGER referral_earnings_append_only/);
    assert.match(sql, /CREATE UNIQUE INDEX referral_earnings_reference_idx/);
    // One referrer per account, forever: the referee is the primary key.
    assert.match(sql, /referee_id uuid PRIMARY KEY REFERENCES users\(id\)/);
    assert.match(sql, /CHECK \(referee_id <> referrer_id\)/);
    assert.match(sql, /CREATE FUNCTION donut_schema_ready_v16\(\) RETURNS boolean/);
  });

  it('binds one Discord account to at most one site account', async () => {
    const sql = await readFile(migrationPath, 'utf8');
    assert.match(sql, /CREATE UNIQUE INDEX users_discord_user_id_idx/);
    assert.match(sql, /WHERE discord_user_id IS NOT NULL/);
    // The id and its proof are written together or not at all.
    assert.match(sql, /num_nonnulls\(discord_user_id, discord_verified_at\) IN \(0, 2\)/);
  });

  it('stores only the hash of an OAuth state, and consumes it once', async () => {
    const sql = await readFile(migrationPath, 'utf8');
    assert.match(sql, /state_hash char\(64\) PRIMARY KEY/);
    assert.match(sql, /consumed_at timestamptz/);
    assert.doesNotMatch(sql, /state text NOT NULL/);
  });

  it('accrues from the one place every game route settles a wager through', async () => {
    const source = await readFile(settlementPath, 'utf8');
    assert.match(source, /export async function recordWager/);
    assert.match(source, /await accrueReferralWager\(client, config, userId, amountMinor/);
  });

  it('keeps referral money on the same wallet ledger as everything else', async () => {
    const sql = await readFile(migrationPath, 'utf8');
    assert.match(sql, /'referral_revshare', 'referral_bonus'/);
  });
});

/** The same environment with the programme switched off, and therefore no Discord requirement. */
function baseEnv0(): Record<string, string> {
  return { ...baseEnv, REFERRALS_ENABLED: 'false' };
}
