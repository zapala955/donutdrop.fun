import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';

/* The owner, 2026-11-15, after rain money that was lost kept a player's own deposit locked: "make sure
 * every wager req works correctly scan everything so theres so issue like this in the future".
 *
 * The scan found the same fault in the running figure (a requirement only ever came down by wagering,
 * so a lost bonus stayed owed and stacked onto the next deposit) and one credit paid with no
 * requirement at all (vault yield). Both are fixed in lib/wager-requirements.ts and migration 101.
 *
 * What this file is for is the next one. Every test below reads the code and the migrations as they
 * stand and fails the moment something new touches money without anybody deciding how it stands
 * against the wagering: a new ledger kind, a new place that pays, a new place that takes a stake, a
 * new game whose stake rides between requests. The failure says what to decide. */

const repo = path.resolve(import.meta.dirname, '../../..');
const src = path.join(repo, 'services/api-gateway/src');
const read = (relative: string) => readFile(path.join(repo, relative), 'utf8');

async function sources(): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const dir of ['routes', 'lib']) {
    for (const name of await readdir(path.join(src, dir))) {
      if (name.endsWith('.ts')) files.set(`${dir}/${name}`, await readFile(path.join(src, dir, name), 'utf8'));
    }
  }
  return files;
}

async function migrations(): Promise<{ name: string; sql: string }[]> {
  const dir = path.join(repo, 'packages/db/migrations');
  const names = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
  return Promise.all(names.map(async (name) => ({ name, sql: await readFile(path.join(dir, name), 'utf8') })));
}

/** Every kind the ledger can hold: the newest wallet_transactions_kind_check. */
async function ledgerKinds(): Promise<Set<string>> {
  const all = await migrations();
  const latest = all.filter((m) => m.sql.includes('ADD CONSTRAINT wallet_transactions_kind_check')).at(-1);
  assert.ok(latest, 'no migration defines the ledger kinds');
  const start = latest.sql.lastIndexOf('ADD CONSTRAINT wallet_transactions_kind_check');
  const list = latest.sql.slice(start, latest.sql.indexOf('));', start));
  return new Set([...list.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]!));
}

/* ── Money in ─────────────────────────────────────────────────────────────────────────────────────
 * Every ledger kind, decided. FREE money carries the running requirement, paid in the files named
 * (each must lock it right after crediting it); a DEPOSIT carries the deposit's own; RAIN is held on
 * its own. The rest is a stake, a game paying out a stake, a refund of the player's own money, or
 * money the player already wagered for at the house's price, each with its reason. */
const FREE: Record<string, string[]> = {
  signup_bonus: ['routes/auth.ts'],
  streak_reward: ['routes/engagement.ts'],
  quest_reward: ['routes/engagement.ts', 'lib/quest-board.ts'],
  weekly_quest_reward: ['lib/weekly-quests.ts'],
  feedback_reward: ['lib/feedback.ts'],
  bounty_reward: ['lib/crowns.ts'],
  daily_code_reward: ['lib/code-drops.ts'],
  discord_join_reward: ['lib/discord-rewards.ts'],
  discord_tag_reward: ['lib/discord-rewards.ts'],
  discord_invite_reward: ['lib/discord-rewards.ts'],
  referral_bonus: ['lib/referrals.ts'],
  admin_adjustment: ['routes/admin.ts'],
  vault_yield: ['routes/vault.ts'],
};
const DEPOSIT: Record<string, string[]> = {
  cash_deposit: ['routes/minecraft-in.ts'],
  pay_login_deposit: ['routes/auth.ts', 'routes/email.ts'],
};
const RAIN: Record<string, string[]> = { rain_claim: ['routes/social.ts'] };
const EXEMPT: Record<string, string> = {
  rakeback_claim: 'a share of the house margin the player’s own wagers paid',
  race_payout: 'a place in a wagering race, won by wagering',
  referral_revshare: 'a share of the margin the friend’s wagers paid',
  creator_royalty: 'carved from the margin of crates other players opened',
  jackpot_win: 'drawn by a wager, the ticket is the wager',
  tip_received: 'only free money can be tipped (assertWagerRequirementMet before the debit)',
  staking_release: 'the player’s own staked money back; only free money can be staked',
  staking_reward: 'the pool’s return on free money that was at risk in it',
  demo_topup: 'play money on a test twin, which cannot move money out (TEST_MODE_ROUTES)',
  item_sale: 'an item sold back; items come from wagered rounds (no item deposits run)',
  cash_withdrawal_refund: 'a withdrawal of free money handed back',
  faction_payout: 'retired: no code pays it any more',
  piggy_claim: 'retired', piggy_break: 'retired', slither_cashout: 'retired', slither_refund: 'retired',
};
const STAKE_OR_PAYOUT = /_(stake|payout|win|refund|double|open|sent)$|^cash_withdrawal$/;

describe('every way money arrives is decided against the wagering requirement', () => {
  it('classifies every ledger kind, so a new one fails until somebody decides', async () => {
    const kinds = await ledgerKinds();
    assert.ok(kinds.size > 80);
    const decided = new Set([...Object.keys(FREE), ...Object.keys(DEPOSIT), ...Object.keys(RAIN), ...Object.keys(EXEMPT)]);
    for (const kind of kinds) {
      assert.ok(
        decided.has(kind) || STAKE_OR_PAYOUT.test(kind),
        `ledger kind ${kind} is not decided: free money (FREE, with its requirement), a deposit, or EXEMPT with the reason`,
      );
    }
    for (const kind of decided) assert.ok(kinds.has(kind), `${kind} is decided here but the ledger cannot hold it`);
  });

  it('pays free money only where its requirement is added straight after, with what was credited', async () => {
    const files = await sources();
    // Every place in the code that writes a ledger kind: a creditWallet call or a raw ledger insert.
    const writers = new Map<string, Set<string>>();
    const kinds = await ledgerKinds();
    /* Dev login's top-up is play money for a local lab: the routes are never registered unless
     * DEV_LOGIN_ENABLED, which the config refuses in production. */
    assert.match(files.get('routes/dev.ts')!, /if \(!config\.devLoginEnabled\) return;/);
    for (const [file, text] of files) {
      if (file === 'lib/wallet.ts' || file === 'lib/cash-settlement.ts' || file === 'routes/dev.ts') continue;
      for (const call of text.matchAll(/creditWallet\(([\s\S]*?)\);/g)) {
        for (const literal of call[1]!.matchAll(/'([a-z_]+)'/g)) {
          if (kinds.has(literal[1]!)) (writers.get(literal[1]!) ?? writers.set(literal[1]!, new Set()).get(literal[1]!))!.add(file);
        }
      }
      for (const insert of text.matchAll(/INSERT INTO wallet_transactions[^`]*`/g)) {
        for (const literal of insert[0].matchAll(/'([a-z_]+)'/g)) {
          if (kinds.has(literal[1]!)) (writers.get(literal[1]!) ?? writers.set(literal[1]!, new Set()).get(literal[1]!))!.add(file);
        }
      }
    }
    // The Discord rewards pass their kind as a variable: the one creditWallet call there, pinned.
    const discord = files.get('lib/discord-rewards.ts')!;
    assert.match(discord, /creditWallet\(client, userId, amount, kind, rewardId\);\s+await addWagerRequirement\(\s*client,\s*userId,\s*requirementFor\(amount, config\.signupBonusWagerMultiplier\),\s*amount,\s*\);/);
    for (const kind of ['discord_join_reward', 'discord_tag_reward', 'discord_invite_reward']) {
      (writers.get(kind) ?? writers.set(kind, new Set()).get(kind))!.add('lib/discord-rewards.ts');
    }

    const lockAfter: Record<string, RegExp> = {
      FREE: /addWagerRequirement\(/,
      DEPOSIT: /addDepositRequirement\(/,
      RAIN: /addRainLock\(/,
    };
    for (const [group, table] of [['FREE', FREE], ['DEPOSIT', DEPOSIT], ['RAIN', RAIN]] as const) {
      for (const [kind, expected] of Object.entries(table)) {
        const actual = [...(writers.get(kind) ?? [])].sort();
        assert.deepEqual(actual, [...expected].sort(), `${kind} is paid from ${actual.join(', ') || 'nowhere'}; every payer must add its requirement`);
        for (const file of expected) {
          const text = files.get(file)!;
          if (kind.startsWith('discord_')) continue; // pinned above
          let at = text.indexOf(`'${kind}'`);
          assert.ok(at > 0, `${file} no longer pays ${kind}`);
          for (; at > 0; at = text.indexOf(`'${kind}'`, at + 1)) {
            // Skip mentions that are not a payment (a SELECT, a comment).
            const before = text.slice(Math.max(0, at - 400), at);
            if (!/creditWallet\([^;]*$|INSERT INTO wallet_transactions[^;]*$/.test(before)) continue;
            const after = text.slice(at, at + 1600);
            assert.match(after, lockAfter[group]!, `${kind} in ${file} is credited without its requirement after it`);
          }
        }
      }
    }
  });

  it('gives every requirement its basis, so none can outlive the money it was for', async () => {
    const files = await sources();
    for (const [file, text] of files) {
      if (file === 'lib/wager-requirements.ts') continue;
      for (const call of text.matchAll(/addWagerRequirement\(([^;]*?)\);/g)) {
        // Four arguments: the client, the player, what is owed and what was credited.
        const args = call[1]!.replace(/requirementFor\([^)]*\)/g, 'R').split(',').map((arg) => arg.trim()).filter(Boolean);
        assert.equal(args.length, 4, `${file}: addWagerRequirement(${call[1]!.trim()}) does not say what was credited`);
      }
    }
  });
});

/* ── Money out and money in play ──────────────────────────────────────────────────────────────────
 * Every file that takes money off a balance, decided: an exit (gated by the requirement before the
 * debit), a stake against another player (rain money stays, and its table is in the idle guard), a
 * house game whose stake rides between requests (its table is in the idle guard), or a house game
 * that takes the stake and settles it in one transaction. */
const EXIT: Record<string, string> = {
  'routes/cash-withdrawals.ts': "assertWagerRequirementMet(client, userId, 'withdrawing', amount)",
  'routes/social.ts': "assertWagerRequirementMet(client, fromUserId, 'tipping', amount)",
  'lib/staking.ts': "assertWagerRequirementMet(client, userId, 'staking', amount)",
};
const PVP: Record<string, string> = {
  'routes/coinflip.ts': 'coinflip_games',
  'routes/sidebets.ts': 'side_bets',
  'routes/duels.ts': 'duel_lobbies',
  'routes/mines-duel.ts': 'mines_duel_games',
  'routes/battles.ts': 'battle_players',
};
const RIDES: Record<string, string> = {
  'routes/mines.ts': 'mines_games',
  'routes/tower.ts': 'tower_games',
  'routes/chicken.ts': 'chicken_games',
  'routes/blackjack.ts': 'blackjack_hands',
  'routes/ice-fishing.ts': 'ice_fishing_games',
  'routes/fishing.ts': 'fishing_casts',
  'routes/crash.ts': 'crash_bets',
  'routes/stocks.ts': 'stocks_positions',
  'routes/roulette.ts': 'roulette_bets',
};
const ONE_TRANSACTION = new Set([
  'routes/dice.ts', 'routes/limbo.ts', 'routes/plinko.ts', 'routes/slots.ts', 'routes/derby.ts',
  'routes/cases.ts', 'routes/upgrades.ts',
]);

async function idleGuard(): Promise<string> {
  const lib = await read('services/api-gateway/src/lib/wager-requirements.ts');
  return lib.slice(lib.indexOf('const IDLE_SQL'), lib.indexOf('export const SPENT_BALANCE_MINOR'));
}

describe('every way money leaves or rides is decided against the wagering requirement', () => {
  it('knows every file that debits a balance, so a new one fails until somebody decides', async () => {
    const files = await sources();
    const debits = [...files].filter(([, text]) => /balance_minor = (w\.)?balance_minor - /.test(text)).map(([file]) => file).sort();
    const decided = [...Object.keys(EXIT), ...Object.keys(PVP), ...Object.keys(RIDES), ...ONE_TRANSACTION].sort();
    assert.deepEqual(debits, decided,
      'a file debits a balance without a decision: EXIT (gate it), PVP or RIDES (add its table to IDLE_SQL) or ONE_TRANSACTION');
  });

  it('gates every exit by the requirement before the debit', async () => {
    const files = await sources();
    for (const [file, gate] of Object.entries(EXIT)) {
      const text = files.get(file)!;
      const at = text.indexOf(gate);
      assert.ok(at > 0, `${file} no longer gates with ${gate}`);
      assert.ok(text.indexOf('balance_minor = balance_minor - $2', at) > at, `${file} debits before its gate`);
    }
  });

  it('keeps rain money out of every stake against another player, before the debit', async () => {
    const files = await sources();
    for (const file of Object.keys(PVP)) {
      const text = files.get(file)!;
      const at = text.indexOf('await assertRainMoneyStays(client, userId, stake);');
      assert.ok(at > 0, `${file} takes a PvP stake without assertRainMoneyStays`);
      assert.ok(/balance_minor = balance_minor - \$2/.test(text.slice(at)), `${file} debits before keeping rain money out`);
    }
  });

  it('lets go of nothing while a stake rides: every such table is in the idle guard', async () => {
    const guard = await idleGuard();
    for (const table of [...Object.values(PVP), ...Object.values(RIDES), 'inventory_lots']) {
      assert.ok(guard.includes(`NOT EXISTS (SELECT 1 FROM ${table} `), `${table} is missing from IDLE_SQL`);
    }
  });

  it('decides every table whose status says money may still be in play', async () => {
    /* A status of active, open, lobby, running or playing is how this schema says "not over yet". Each
     * such table is a stake the idle guard waits for, or is not a player's stake at all. */
    const NOT_A_STAKE: Record<string, string> = {
      users: 'an account, not a stake',
      crash_rounds: 'the round; its stakes are crash_bets',
      roulette_rounds: 'the round; its stakes are roulette_bets',
      side_bet_markets: 'the market; its stakes are side_bets',
      crown_bounties: 'a prize the house offers; nobody stakes on it',
      lava_rain_events: 'the house’s pool',
      staking_lots: 'only free money can be staked (assertWagerRequirementMet, staking)',
      discord_suggestions: 'no money', discord_tickets: 'no money',
      player_stats_lookups: 'a /stats lookup for the community bot; no money (migration 102)',
    };
    const guard = await idleGuard();
    const live = new Set<string>();
    for (const { sql } of await migrations()) {
      for (const table of sql.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\n\);/g)) {
        for (const check of table[2]!.matchAll(/CHECK \((?:status|state) IN \(([^)]*)\)\)/g)) {
          if (/'(active|open|lobby|running|playing)'/.test(check[1]!)) live.add(table[1]!);
        }
      }
    }
    assert.ok(live.size >= 20);
    for (const table of live) {
      if (table === 'battles') { assert.match(guard, /JOIN battles b/); continue; }
      assert.ok(
        guard.includes(`FROM ${table} `) || table in NOT_A_STAKE,
        `${table} has an in-play status: add it to IDLE_SQL in lib/wager-requirements.ts, or to NOT_A_STAKE here with the reason`,
      );
    }
  });
});

/* ── The figure lets go of lost money ───────────────────────────────────────────────────────────── */
describe('the running figure dies with the money it was for', () => {
  it('settles like the rain hold: only down, never mid-game, before every read and every deposit', async () => {
    const lib = await read('services/api-gateway/src/lib/wager-requirements.ts');
    const settle = lib.slice(lib.indexOf('export async function settleWagerRequirement'), lib.indexOf('export async function settleRequirements'));
    assert.match(settle, /\$\{IDLE_SQL\}/, 'nothing is let go of while a stake rides or items are held');
    assert.match(settle, /r\.basis_minor > s\.settled/, 'it only lowers, and only when money is gone');
    assert.match(settle, /LEAST\(r\.remaining_minor, ceil\(/, 'what is owed only ever comes down');
    const add = lib.slice(lib.indexOf('export async function addWagerRequirement'), lib.indexOf('export async function addDepositRequirement'));
    assert.match(add, /basis_minor = CASE WHEN user_wager_requirements\.remaining_minor <= 0 THEN EXCLUDED\.basis_minor/);
    const reduce = lib.slice(lib.indexOf('export async function reduceWagerRequirement'));
    assert.match(reduce, /SET basis_minor = CASE WHEN remaining_minor <= \$2::bigint THEN 0 ELSE basis_minor END/);
    const forgive = lib.slice(lib.indexOf('export async function forgiveSpentRequirement'), lib.indexOf('export async function addRainLock'));
    assert.match(forgive, /SET remaining_minor = 0, basis_minor = 0/);
  });

  it('estimates the basis of what was owed before 2026-11-15 from below, at 10x for the invite bonus and 5x for the rest', async () => {
    const sql = await read('packages/db/migrations/101_requirement_basis.sql');
    assert.match(sql, /ADD COLUMN basis_minor bigint NOT NULL DEFAULT 0 CHECK \(basis_minor >= 0\)/);
    assert.match(sql, /THEN 10 ELSE 5 END\)::bigint\n WHERE q\.remaining_minor > 0;/);
    assert.match(sql, /CREATE FUNCTION donut_schema_ready_v101\(\)/);
    /* 5x is at least every multiplier any credit has carried apart from the invite bonus: the
     * signup bonus peaked at 5x, deposits at 2x, quests and code drops are 3x. If a default here is
     * ever raised above it, the estimate is no longer from below. */
    const config = testConfig();
    for (const multiplier of [config.signupBonusWagerMultiplier, config.depositWagerMultiplier, config.questRewardWagerMultiplier,
      config.referralBonusWagerMultiplier, config.codeDropWagerMultiplier]) {
      assert.ok(multiplier <= 5, `a default multiplier of ${multiplier} is above the 5x migration 101 assumed`);
    }
    assert.ok(config.referralSignupBonusWagerMultiplier <= 10);
  });
});

function testConfig() {
  return loadConfig({
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
}

const databaseUrl = process.env['TEST_DATABASE_URL'];

describe('the running figure against PostgreSQL', { skip: !databaseUrl }, () => {
  it('lets go of a lost bonus, keeps it while the player’s own money is what was lost, and frees a deposit made after', async () => {
    if (!databaseUrl) return;
    const { randomUUID } = await import('node:crypto');
    const pg = (await import('pg')).default;
    const {
      addDepositRequirement, addWagerRequirement, assertWagerRequirementMet, reduceWagerRequirement,
      requirementFor, settleWagerRequirement, wagerRequirementRemaining,
    } = await import('../src/lib/wager-requirements.js');
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    const rules = { ...testConfig(), depositWagerMultiplier: 1 } as ReturnType<typeof testConfig>;
    const player = async (balance: bigint) => {
      const id = randomUUID();
      const tag = id.slice(0, 8);
      await pool.query(
        `INSERT INTO users (id, minecraft_identity, minecraft_username, normalized_username, role, status, terms_accepted_at)
         VALUES ($1, $2, $3, $4, 'player', 'active', now())`,
        [id, `mc:fig${tag}`, `Fig${tag}`, `fig${tag}`],
      );
      await pool.query('INSERT INTO user_wallets (user_id, balance_minor) VALUES ($1, $2)', [id, balance.toString()]);
      return id;
    };
    const setBalance = (id: string, balance: bigint) =>
      pool.query('UPDATE user_wallets SET balance_minor = $2 WHERE user_id = $1', [id, balance.toString()]);
    const basis = async (id: string) =>
      BigInt((await pool.query('SELECT basis_minor FROM user_wager_requirements WHERE user_id = $1', [id])).rows[0]?.basis_minor ?? '0');
    try {
      // A $10M code at 3x: $30M owed for $10M. $5M wagered, and all but $2M of it lost.
      const a = await player(10_000_000n);
      await addWagerRequirement(pool, a, requirementFor(10_000_000n, 3), 10_000_000n);
      assert.equal(await basis(a), 10_000_000n);
      await reduceWagerRequirement(pool, a, 5_000_000n);
      await setBalance(a, 2_000_000n);
      // Checked on the way out: $25M owed for $10M becomes $5M for the $2M that is left.
      await assert.rejects(assertWagerRequirementMet(pool, a, 'withdrawing', 1_000_000n), { code: 'WAGER_REQUIREMENT' });
      assert.equal(await wagerRequirementRemaining(pool, a), 5_000_000n);
      assert.equal(await basis(a), 2_000_000n);
      // A $50M deposit owes its own $50M and nothing for what was lost before it.
      await setBalance(a, 52_000_000n);
      await addDepositRequirement(pool, rules, a, 50_000_000n);
      assert.equal(await wagerRequirementRemaining(pool, a), 55_000_000n);
      assert.equal(await basis(a), 52_000_000n);
      // Wagered off, everything may leave, and the basis is gone with it.
      await reduceWagerRequirement(pool, a, 55_000_000n);
      assert.equal(await basis(a), 0n);
      await assert.doesNotReject(assertWagerRequirementMet(pool, a, 'withdrawing', 52_000_000n));

      // The player's own money is lost first: $50M of their own and a $10M bonus, $40M lost.
      const b = await player(60_000_000n);
      await addWagerRequirement(pool, b, requirementFor(10_000_000n, 3), 10_000_000n);
      await setBalance(b, 20_000_000n);
      await settleWagerRequirement(pool, b);
      assert.equal(await wagerRequirementRemaining(pool, b), 30_000_000n, 'the bonus is all still there');
      // Down to $1M of it: $3M owed. A win afterwards brings nothing back.
      await setBalance(b, 1_000_000n);
      await settleWagerRequirement(pool, b);
      assert.equal(await wagerRequirementRemaining(pool, b), 3_000_000n);
      await setBalance(b, 900_000_000n);
      await settleWagerRequirement(pool, b);
      assert.equal(await wagerRequirementRemaining(pool, b), 3_000_000n, 'it never rises');
      // Lost to dust, it is gone.
      await setBalance(b, 400n);
      await settleWagerRequirement(pool, b);
      assert.equal(await wagerRequirementRemaining(pool, b), 0n);
      assert.equal(await basis(b), 0n);

      // A figure with no basis (written by an older API mid-deploy) has nothing to measure by: kept.
      const c = await player(1_000_000n);
      await pool.query('INSERT INTO user_wager_requirements (user_id, remaining_minor, basis_minor) VALUES ($1, 9000000, 0)', [c]);
      await settleWagerRequirement(pool, c);
      assert.equal(await wagerRequirementRemaining(pool, c), 9_000_000n);
    } finally {
      await pool.end();
    }
  });

  it('backfills what was owed before it at most 5x the balance, 10x for the invite bonus (migration 101)', async () => {
    if (!databaseUrl) return;
    const { randomUUID } = await import('node:crypto');
    const pg = (await import('pg')).default;
    const { settleWagerRequirement, wagerRequirementRemaining } = await import('../src/lib/wager-requirements.js');
    const sql = await read('packages/db/migrations/101_requirement_basis.sql');
    const backfill = sql.slice(sql.indexOf('UPDATE user_wager_requirements q'), sql.indexOf(';', sql.indexOf('UPDATE user_wager_requirements q')));
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      const make = async (owed: bigint, inviteBonus: boolean) => {
        const id = randomUUID();
        const tag = id.slice(0, 8);
        await client.query(
          `INSERT INTO users (id, minecraft_identity, minecraft_username, normalized_username, role, status, terms_accepted_at)
           VALUES ($1, $2, $3, $4, 'player', 'active', now())`,
          [id, `mc:old${tag}`, `Old${tag}`, `old${tag}`],
        );
        await client.query('INSERT INTO user_wallets (user_id, balance_minor) VALUES ($1, 1000000)', [id]);
        if (inviteBonus) {
          await client.query(
            `INSERT INTO wallet_transactions (id, user_id, amount_minor, balance_after_minor, kind, reference_id)
             VALUES ($1, $2, 10000000, 10000000, 'signup_bonus', $2)`,
            [randomUUID(), id],
          );
        }
        await client.query('INSERT INTO user_wager_requirements (user_id, remaining_minor, basis_minor) VALUES ($1, $2, 0)', [id, owed.toString()]);
        return id;
      };
      const ordinary = await make(30_000_000n, false);
      const invited = await make(100_000_000n, true);
      // The migration's own statement, on these two accounts only (other test files run alongside).
      await client.query(`${backfill} AND q.user_id = ANY($1::uuid[])`, [[ordinary, invited]]);
      const basisOf = async (id: string) =>
        (await client.query('SELECT basis_minor FROM user_wager_requirements WHERE user_id = $1', [id])).rows[0].basis_minor;
      assert.equal(await basisOf(ordinary), '6000000');
      assert.equal(await basisOf(invited), '10000000');
      // Each down to $1M: $5M owed (5x) and $10M (10x), from $30M and $100M.
      await settleWagerRequirement(client, ordinary);
      await settleWagerRequirement(client, invited);
      assert.equal(await wagerRequirementRemaining(client, ordinary), 5_000_000n);
      assert.equal(await wagerRequirementRemaining(client, invited), 10_000_000n);
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  });
});
