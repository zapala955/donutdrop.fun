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
    /* Matches on FOR UPDATE rather than on the JOIN it used to carry. The gate stopped reading
       `users` when Discord stopped being a condition, and a stub still insisting on that join
       would answer nothing and fail every test for the wrong reason. */
    if (text.includes('FROM referrals') && text.includes('FOR UPDATE')) {
      if (!this.hasReferral) return result([]);
      return result([
        {
          referrer_id: REFERRER,
          wagered_minor: this.state.wagered.toString(),
          bonus_unlocked_at: this.state.bonusUnlocked ? new Date() : null,
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
    /* A 10% edge on 1,000,000 is a 100,000 margin; 5% of that margin is 5,000.
     *
     * Which is 0.5% of the wager — and that equivalence is the whole point of this test now. The
     * referrer's cut is quoted to players as half a percent of what their invitee wagers, and it
     * is IMPLEMENTED as a share of the margin, because every payout on this platform is priced off
     * the margin so their sum can be checked against the edge that funds all of them. The two
     * agree only at this edge: at 5% the same setting would pay 0.25% of wager. Whoever changes
     * HOUSE_EDGE_BPS is changing what referrers earn, and this asserts the arithmetic that makes
     * that true rather than leaving it to be discovered. */
    assert.equal(settings.houseEdgeBps, 1000);
    assert.equal(settings.referralRevshareBps, 500);
    assert.equal(revshareMinor(settings, 1_000_000n), 5_000n);
    // Half a percent of the wager, stated as the wager fraction a player is quoted.
    assert.equal(revshareMinor(settings, 1_000_000n), 1_000_000n / 200n);
    // Emphatically not 5% of the wager, which would be ten times larger.
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
    assert.equal(paid[0]?.amount, revshareMinor(settings, 1_000_000n));
    assert.equal(paid[0]?.userId, REFERRER);
  });

  it('does nothing at all for a player nobody referred', async () => {
    const client = new ReferralClient({}, false);
    await accrueReferralWager(client, config(), REFEREE, 10_000_000n, 'upgrader', 'round-1');
    assert.equal(client.credits.length, 0);
  });

  it('stays out of the way entirely when the programme is off', async () => {
    const client = new ReferralClient({ wagered: 99_000_000n });
    const off = loadConfig(baseEnv0());
    await accrueReferralWager(client, off, REFEREE, 10_000_000n, 'upgrader', 'round-1');
    assert.equal(client.credits.length, 0);
    assert.equal(client.state.bonusUnlocked, false);
  });
});

describe('referral milestone bonus', () => {
  it('fires on the wager and nothing else', async () => {
    /* Every figure below is read off the settings rather than written in, so retuning the
     * programme cannot fail a test that has no opinion about what the bonus is. */
    const settings = config();
    const gate = settings.referralBonusWagerMinor;

    // One unit short: nothing is owed.
    const client = new ReferralClient({ wagered: gate - 2_000_000n });
    await accrueReferralWager(client, settings, REFEREE, 1_000_000n, 'case', 'round-a');
    assert.equal(client.state.bonusUnlocked, false);
    assert.equal(
      client.credits.some((entry) => entry.kind === 'referral_bonus'),
      false,
    );

    // Crossing it pays, with no second condition to wait on.
    await accrueReferralWager(client, settings, REFEREE, 1_000_000n, 'case', 'round-b');
    assert.equal(client.state.wagered, gate);
    assert.equal(client.state.bonusUnlocked, true);
    const bonus = client.credits.filter((entry) => entry.kind === 'referral_bonus');
    assert.equal(bonus.length, 1);
    assert.equal(bonus[0]?.amount, settings.referralBonusMinor);
    assert.equal(bonus[0]?.userId, REFERRER);
  });

  it('does not consult Discord at all', async () => {
    /* The point of the change, asserted where it can actually rot: an unverified referee is paid
     * exactly like a verified one, and the gate's own query no longer reaches the users table. */
    const settings = config();
    const unverified = new ReferralClient({
      discordVerified: false,
      wagered: settings.referralBonusWagerMinor,
    });
    assert.equal(await tryUnlockMilestone(unverified, settings, REFEREE), true);

    /* And the column is unreachable from the whole module, not merely unused by the gate.
       Checked across the file rather than by slicing out the function body: the repo checks out
       CRLF on Windows, so every attempt to cut at a bare newline is a portability bug waiting for
       whoever runs the suite on the other platform. The column name is specific enough that a
       file-wide search says the same thing, and it cannot come back by accident. */
    const source = await readFile(
      path.resolve(import.meta.dirname, '../src/lib/referrals.ts'),
      'utf8',
    );
    assert.doesNotMatch(source, /discord_verified_at/);
    assert.doesNotMatch(source, /JOIN users/i);
  });

  it('refuses to pay a verified referee who is one unit short', async () => {
    const settings = config();
    const client = new ReferralClient({
      wagered: settings.referralBonusWagerMinor - 1n,
    });
    assert.equal(await tryUnlockMilestone(client, settings, REFEREE), false);
    assert.equal(client.credits.length, 0);
  });

  it('pays exactly once, even if the gate is somehow entered twice', async () => {
    const settings = config();
    const client = new ReferralClient({
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
      wagered: settings.referralBonusWagerMinor,
    });
    await tryUnlockMilestone(client, settings, REFEREE);
    const bonus = client.credits.find((entry) => entry.kind === 'referral_bonus');
    assert.equal(bonus?.reference, REFEREE);
  });
});

describe('referral configuration', () => {
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

/** The same environment with the programme switched off. */
function baseEnv0(): Record<string, string> {
  return { ...baseEnv, REFERRALS_ENABLED: 'false' };
}

describe('custom invite codes', () => {
  const route = () =>
    readFile(path.resolve(import.meta.dirname, '../src/routes/referrals.ts'), 'utf8');
  const renameMigration = () =>
    readFile(
      path.resolve(import.meta.dirname, '../../../packages/db/migrations/034_custom_referral_codes.sql'),
      'utf8',
    );

  it('carries existing referrals through a rename instead of stranding them', async () => {
    /* `referrals.code` is a foreign key to `referral_codes.code`. Under the default NO ACTION rule
     * a rename is refused outright while any referral references it, which is why 016 denied the
     * UPDATE grant in the first place. The relationship is to the PERSON, not to the string they
     * were holding, so the cascade is the statement of that. */
    const sql = await renameMigration();
    assert.match(sql, /FOREIGN KEY \(code\) REFERENCES referral_codes\(code\) ON UPDATE CASCADE/);
    // ON DELETE stays NO ACTION: deleting a code would erase a relationship rather than rename it.
    assert.doesNotMatch(sql, /ON DELETE CASCADE/);
  });

  it('grants the rename narrowly enough that a code cannot change owner', async () => {
    /* Column-scoped, so the runtime role can rewrite `code` and nothing else. `user_id` is the
     * primary key and is not granted, which is what makes transferring a code between accounts
     * unexpressible rather than merely unimplemented. */
    const sql = await renameMigration();
    assert.match(sql, /GRANT UPDATE \(code\) ON TABLE referral_codes TO donut_api_runtime;/);
    assert.doesNotMatch(sql, /GRANT UPDATE ON TABLE referral_codes/);
    assert.doesNotMatch(sql, /GRANT DELETE/);
  });

  it('refuses a code that CONTAINS a reserved word, not merely one that equals it', async () => {
    /* A code is pasted into public chat beside a link to this site, so XADMINX impersonates
     * exactly as well as ADMIN does. A rule matching only the exact word would be a rule that
     * advertised its own workaround. */
    const source = await route();
    assert.match(source, /RESERVED_FRAGMENTS\.find\(\(word\) => code\.includes\(word\)\)/);
    assert.match(source, /'ADMIN',/);
    assert.match(source, /'SUPPORT',/);
    assert.match(source, /REFERRAL_CODE_RESERVED/);
  });

  it('decides a contested code in one statement, with no window between check and write', async () => {
    /* Two players racing for the same code leave a gap between a SELECT and an UPDATE that is
     * exactly wide enough for both to win it. A conditional UPDATE has no such gap. */
    /* Asserted against the whole module rather than a sliced-out handler body. The strings are
       specific enough to belong to exactly one endpoint, and slicing on brace or paren depth is a
       parser pretending to be a substring search. */
    const source = await route();
    assert.match(source, /UPDATE referral_codes SET code = \$2/);
    assert.match(
      source,
      /NOT EXISTS \(SELECT 1 FROM referral_codes WHERE code = \$2 AND user_id <> \$1\)/,
    );
    assert.match(source, /REFERRAL_CODE_TAKEN/);
    // Uppercased server-side: the alphabet is uppercase and the client is not the authority on it.
    assert.match(source, /body\.code\.toUpperCase\(\)/);
    /* And there is no SELECT-then-UPDATE pair left to race: the only read of referral_codes by
       code is the attach endpoint's owner lookup, which writes nothing. */
    assert.doesNotMatch(source, /SELECT user_id FROM referral_codes WHERE code = \$2/);
  });

  it('takes the same alphabet the login will redeem', async () => {
    /* A code a player can set but nobody can redeem is a link that silently never works, and the
     * two ends are now in different files: the code is CHOSEN in referrals.ts and SPENT by the
     * login in auth-pay.ts. That is exactly the kind of split where one side gets widened and the
     * other does not, so the pattern is compared across the gap rather than assumed. */
    const rename = (await route()).match(/regex\(\/\^\[A-Z0-9\]\{6,16\}\$\/\)/)?.[0];
    const login = (
      await readFile(path.resolve(import.meta.dirname, '../src/routes/auth-pay.ts'), 'utf8')
    ).match(/regex\(\/\^\[A-Z0-9\]\{6,16\}\$\/\)/)?.[0];
    assert.ok(rename, 'referrals.ts must constrain the code it lets a player set');
    assert.ok(login, 'auth-pay.ts must constrain the code it accepts on a login');
    assert.equal(rename, login);
  });

  it('is redeemed only by the transaction that creates the account', async () => {
    /* The rule is "only somebody who has not signed up yet can use a code", and this is where it
     * is enforced: `existing.rows[0]` is the ownership-locked lookup, so !existing is the only
     * unambiguous "signing up right now" available. */
    const auth = await readFile(
      path.resolve(import.meta.dirname, '../src/routes/auth.ts'),
      'utf8',
    );
    assert.match(auth, /!existing\.rows\[0\] && config\.referralsEnabled && challenge\.referral_code/);
    assert.match(auth, /INSERT INTO referrals \(referee_id, referrer_id, code\)/);

    /* And there is no second path. An attach endpoint is what let an account that had been
     * playing for months redeem a code, and its absence is the enforcement — not a check inside
     * it. */
    const referrals = await route();
    /* Matched on the REGISTRATION, not on the path string: the comment recording why the endpoint
       was removed names it, and a test that fails on its own tombstone teaches people to delete
       the explanation. */
    assert.doesNotMatch(referrals, /app\.(post|put|get)\(\s*'\/v1\/referrals\/attach'/);
    assert.doesNotMatch(referrals, /INSERT INTO referrals \(/);
  });
});
