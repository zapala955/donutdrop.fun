import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import {
  RELEASE_HELD_JOB_SQL,
  compactMinor,
  evaluateWithdrawal,
  reasonText,
  rulesFrom,
  type DrainRules,
  type WithdrawalFacts,
} from '../src/lib/anti-drain.js';
import { runtimeSettingDefinitions } from '../src/lib/runtime-settings.js';

const M = 1_000_000n;

const baseEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  APP_ORIGIN: 'http://localhost:3000',
  COOKIE_SECRET: 'c'.repeat(32),
  DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  BOT_CREDENTIALS_JSON: JSON.stringify({
    '20000000-0000-4000-8000-000000000002': {
      secret: Buffer.alloc(32, 2).toString('base64'),
      serverHost: 'donutsmp.net',
      username: 'DonutBot',
    },
  }),
  AUDIT_LOG_HMAC_KEY: 'a'.repeat(32),
  IP_HASH_KEY: 'i'.repeat(32),
  GAME_CURRENCY_ONLY: 'true',
  LOG_LEVEL: 'silent',
};

const rules: DrainRules = {
  enabled: true,
  holdAll: false,
  approvalThresholdMinor: 500n * M,
  netCashoutMinor: 100n * M,
  houseHourlyMinor: 750n * M,
};

const facts = (overrides: Partial<WithdrawalFacts> = {}): WithdrawalFacts => ({
  amountMinor: 10n * M,
  isStaff: false,
  userHoldReason: null,
  depositedMinor: 0n,
  withdrawnMinor: 0n,
  houseNetOutflowHourMinor: 0n,
  ...overrides,
});

describe('the withdrawal rules', () => {
  it('lets an ordinary small request straight through', () => {
    const decision = evaluateWithdrawal(facts(), rules);
    assert.equal(decision.review, false);
    assert.deepEqual(decision.reasons, []);
  });

  it('holds everything while the global hold is on, staff included', () => {
    for (const isStaff of [false, true]) {
      const decision = evaluateWithdrawal(facts({ isStaff }), { ...rules, holdAll: true });
      assert.equal(decision.review, true);
      assert.match(decision.reasons.join(), /All payouts are on hold/);
    }
  });

  it('holds a player who has a hold, with the reason in the words it was given', () => {
    const decision = evaluateWithdrawal(
      facts({ userHoldReason: 'Auto: net winnings 80M in 1h' }),
      rules,
    );
    assert.equal(decision.review, true);
    assert.match(decision.reasons.join(), /Player hold: Auto: net winnings 80M in 1h/);
  });

  it('holds a single request over the approval limit, and a limit of 0 holds every one', () => {
    assert.equal(
      evaluateWithdrawal(facts({ amountMinor: 500n * M, depositedMinor: 900n * M }), rules).review,
      false,
      'exactly the limit is not over it',
    );
    const over = evaluateWithdrawal(
      facts({ amountMinor: 500n * M + 1n, depositedMinor: 900n * M }),
      rules,
    );
    assert.equal(over.review, true);
    assert.match(over.reasons.join(), /approval limit/);
    assert.equal(
      evaluateWithdrawal(facts({ amountMinor: 1n }), { ...rules, approvalThresholdMinor: 0n })
        .review,
      true,
    );
  });

  it('counts what a player has taken out against what they put in', () => {
    // 60M taken out before, 50M now, 20M ever deposited: 90M net, under a 100M allowance.
    const under = evaluateWithdrawal(
      facts({ amountMinor: 50n * M, withdrawnMinor: 60n * M, depositedMinor: 20n * M }),
      rules,
    );
    assert.equal(under.review, false);
    // The same request from somebody who never deposited: 110M net, over it.
    const over = evaluateWithdrawal(
      facts({ amountMinor: 50n * M, withdrawnMinor: 60n * M, depositedMinor: 0n }),
      rules,
    );
    assert.equal(over.review, true);
    assert.match(over.reasons.join(), /Net cash-out 110M/);
    // Deposits are credit against it without limit: a depositor cashing their own money out is fine.
    assert.equal(
      evaluateWithdrawal(
        facts({ amountMinor: 400n * M, withdrawnMinor: 0n, depositedMinor: 400n * M }),
        rules,
      ).review,
      false,
    );
  });

  it('can be switched off per rule with 0, and as a whole', () => {
    const big = facts({ amountMinor: 400n * M, houseNetOutflowHourMinor: 5_000n * M });
    assert.equal(evaluateWithdrawal(big, rules).review, true);
    assert.equal(
      evaluateWithdrawal(big, { ...rules, netCashoutMinor: 0n, houseHourlyMinor: 0n }).review,
      false,
    );
    assert.equal(evaluateWithdrawal(big, { ...rules, enabled: false }).review, false);
  });

  it('holds every request when the house is already bleeding, whoever asks', () => {
    const decision = evaluateWithdrawal(
      facts({ amountMinor: 1n * M, depositedMinor: 50n * M, houseNetOutflowHourMinor: 750n * M }),
      rules,
    );
    assert.equal(decision.review, true);
    assert.match(decision.reasons.join(), /House net outflow 751M in the last hour/);
  });

  it('never applies the automatic rules to staff, but does apply the manual ones', () => {
    const staff = facts({
      isStaff: true,
      amountMinor: 400n * M,
      houseNetOutflowHourMinor: 5_000n * M,
    });
    assert.equal(evaluateWithdrawal(staff, rules).review, false);
    assert.equal(evaluateWithdrawal({ ...staff, userHoldReason: 'x' }, rules).review, true);
    assert.equal(evaluateWithdrawal({ ...staff, amountMinor: 600n * M }, rules).review, true);
  });

  it('keeps every reason, in one string that fits its column', () => {
    const decision = evaluateWithdrawal(
      facts({ amountMinor: 900n * M, userHoldReason: 'x'.repeat(280) }),
      { ...rules, holdAll: true },
    );
    assert.ok(decision.reasons.length >= 3);
    assert.ok(reasonText(decision.reasons).length <= 300);
    assert.equal(reasonText(['a', 'b']), 'a; b');
  });

  it('writes amounts the way an operator reads them', () => {
    assert.equal(compactMinor(340_000_000n), '340M');
    assert.equal(compactMinor(1_250_000_000n), '1.2B');
    assert.equal(compactMinor(999n), '999');
    assert.equal(compactMinor(1_000n), '1K');
    assert.equal(compactMinor(-75_000_000n), '-75M');
    assert.equal(compactMinor(2_000_000_000_000n), '2T');
  });
});

describe('the anti-drain and battle settings', () => {
  it('ships with battles closed and the anti-drain rules on', () => {
    const config = loadConfig(baseEnv);
    assert.equal(
      config.battlesEnabled,
      false,
      'case battles are closed until an operator opens them',
    );
    assert.equal(config.battleBotsEnabled, true);
    assert.equal(config.cashPayoutsHold, false);
    assert.equal(config.antiDrainEnabled, true);
    assert.equal(
      config.cashApprovalThresholdMinor,
      500_000_000n,
      'the existing ceiling is unchanged',
    );
    assert.equal(config.antiDrainNetCashoutMinor, 100_000_000n);
    assert.equal(config.antiDrainHouseHourlyMinor, 750_000_000n);
    assert.equal(config.antiDrainWin1hMinor, 75_000_000n);
    assert.equal(config.antiDrainWin24hMinor, 150_000_000n);
    const live = rulesFrom(config);
    assert.equal(live.enabled && !live.holdAll, true);
  });

  it('reads every switch from the environment', () => {
    const config = loadConfig({
      ...baseEnv,
      BATTLES_ENABLED: 'true',
      BATTLE_BOTS_ENABLED: 'false',
      CASH_PAYOUTS_HOLD: 'true',
      CASH_APPROVAL_THRESHOLD_MINOR: '0',
      ANTI_DRAIN_ENABLED: 'false',
      ANTI_DRAIN_NET_CASHOUT_MINOR: '0',
    });
    assert.equal(config.battlesEnabled, true);
    assert.equal(config.battleBotsEnabled, false);
    assert.equal(config.cashPayoutsHold, true);
    assert.equal(config.cashApprovalThresholdMinor, 0n);
    assert.equal(config.antiDrainEnabled, false);
    assert.equal(config.antiDrainNetCashoutMinor, 0n);
  });

  it('can change every one of them live, from the System tab', () => {
    for (const key of [
      'battlesEnabled',
      'battleBotsEnabled',
      'cashPayoutsHold',
      'cashApprovalThresholdMinor',
      'antiDrainEnabled',
      'antiDrainNetCashoutMinor',
      'antiDrainHouseHourlyMinor',
      'antiDrainWin1hMinor',
      'antiDrainWin24hMinor',
    ] as const) {
      assert.ok(key in runtimeSettingDefinitions, `${key} is not a runtime setting`);
    }
    // 0 is a legal value for every amount: it is how a rule is switched off.
    for (const key of [
      'cashApprovalThresholdMinor',
      'antiDrainNetCashoutMinor',
      'antiDrainHouseHourlyMinor',
      'antiDrainWin1hMinor',
      'antiDrainWin24hMinor',
    ] as const) {
      assert.equal(runtimeSettingDefinitions[key].min, 0n);
    }
  });
});

describe('how the holds are wired', () => {
  const read = (relative: string) => readFile(path.resolve(import.meta.dirname, relative), 'utf8');

  it('only brings back a parked job, and never touches a live one', () => {
    assert.match(RELEASE_HELD_JOB_SQL, /ON CONFLICT \(kind, reference_id\) DO UPDATE/);
    assert.match(RELEASE_HELD_JOB_SQL, /bot_jobs\.status = 'queued'/);
    assert.match(RELEASE_HELD_JOB_SQL, /bot_jobs\.available_at > now\(\) \+ interval '10 years'/);
  });

  it('approving a payout revives its parked job on both paths that queue one', async () => {
    const source = await read('../src/routes/cash-withdrawals.ts');
    assert.equal(source.split('${RELEASE_HELD_JOB_SQL}').length - 1, 2);
    assert.doesNotMatch(
      source,
      /'cash_payout', \$3, \$4, now\(\) \+ \(\$5::integer \* interval '1 second'\)\)\s+ON CONFLICT \(kind, reference_id\) DO NOTHING/,
      'a held payout approved later would collide with its own parked job and never be sent',
    );
  });

  it('pulls a payout back only while the bot has not touched it, with both rows locked first', async () => {
    const source = await read('../src/lib/anti-drain.ts');
    const hold = source.slice(source.indexOf('export async function holdQueuedWithdrawal'));
    assert.match(hold, /SELECT status, funding FROM cash_withdrawals WHERE id = \$1 FOR UPDATE/);
    assert.match(hold, /row\.status !== 'queued' \|\| row\.funding === 'vault'/);
    assert.match(
      hold,
      /kind = 'cash_payout' AND reference_id = \$1 AND status = 'queued'\s+FOR UPDATE/,
    );
    assert.match(
      hold,
      /last_error_code = NULL/,
      'a parked job must not block the money queue behind it',
    );
  });

  it('rejecting a pulled-back payout retires the parked job as well as refunding', async () => {
    const source = await read('../src/routes/admin.ts');
    const reject = source.slice(source.indexOf("'/v1/admin/cash-withdrawals/:id/reject'"));
    assert.match(
      reject,
      /UPDATE bot_jobs SET status = 'failed', last_error_code = 'REJECTED_BY_ADMIN'/,
    );
  });

  it('closes battles on create, join and bot fill, but never on leave', async () => {
    const source = await read('../src/routes/battles.ts');
    assert.equal(source.split('assertOpen();').length - 1, 3);
    const leave = source.slice(
      source.indexOf("'/v1/battles/:code/leave'"),
      source.indexOf("'/v1/battles/:code/speed'"),
    );
    assert.doesNotMatch(
      leave,
      /assertOpen/,
      'a player must always be able to take their stake back',
    );
    assert.match(source, /BATTLES_PAUSED/);
    assert.match(
      source,
      /!config\.battlesEnabled/,
      'the sweeper refunds every open lobby while closed',
    );
  });

  it("keys a seat's ledger rows on the occupancy, so a left seat can be taken again", async () => {
    const source = await read('../src/routes/battles.ts');
    assert.match(source, /const stakeRef = randomUUID\(\);/);
    assert.doesNotMatch(source, /deterministicUuid\('battle_stake'/);
    assert.match(source, /deterministicUuid\('battle_refund', stakeRef\)/);
  });

  it('starts the monitor and registers the queue routes', async () => {
    const app = await read('../src/app.ts');
    assert.match(app, /registerAdminPayoutRoutes\(app, db, config\)/);
    assert.match(app, /startAntiDrainMonitor\(app, db, config\)/);
  });

  it('adds only to the schema: nothing dropped, narrowed or rewritten', async () => {
    const sql = await read('../../../packages/db/migrations/058_anti_drain.sql');
    assert.doesNotMatch(
      sql,
      /DROP (TABLE|COLUMN|CONSTRAINT)|ALTER COLUMN|UPDATE |DELETE FROM|TRUNCATE/i,
    );
    assert.match(sql, /ADD COLUMN payout_hold_reason varchar\(300\)/);
    assert.match(sql, /ALTER TABLE cash_withdrawals ADD COLUMN review_reason/);
    assert.match(sql, /GRANT DELETE ON TABLE battle_players TO donut_api_runtime/);
    assert.match(sql, /ALTER TABLE battle_players ADD COLUMN stake_ref uuid/);
    assert.match(sql, /CREATE FUNCTION donut_schema_ready_v58\(\) RETURNS boolean/);
  });

  it('shows the operator the queue, the holds and the emergency controls', async () => {
    const html = await read('../../../DONUTDROP FRONTEND/Donut Drop/admin/index.html');
    const js = await read('../../../DONUTDROP FRONTEND/Donut Drop/admin/admin.js');
    assert.match(html, /data-panel="payouts"/);
    for (const id of [
      'payControls',
      'payStats',
      'payQueueTable',
      'payHeldTable',
      'payLeaderTable',
    ]) {
      assert.match(html, new RegExp(`id="${id}"`));
    }
    assert.match(js, /payouts: loadPayoutQueue/);
    for (const route of [
      '/v1/admin/payout-queue',
      '/v1/admin/cash-withdrawals/hold-queued',
      '/payout-hold',
      '/payout-release',
    ]) {
      assert.ok(js.includes(route), `the console never calls ${route}`);
    }
    assert.match(js, /'cashPayoutsHold'/);
    assert.match(js, /'battlesEnabled'/);
  });
});
