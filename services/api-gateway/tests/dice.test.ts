import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  DICE_HOUSE_EDGE_BPS,
  DICE_MAX_CHANCE,
  DICE_MIN_CHANCE,
  diceChance,
  diceMultiplierBps,
  diceRoll,
  diceWins,
  drawFraction,
  maxStakeAt,
  payoutAt,
} from '../src/lib/dice.js';

const root = path.resolve(import.meta.dirname, '../../..');
const read = (file: string) => readFile(path.join(root, file), 'utf8');

describe('dice: the roll', () => {
  it('is the first 52 bits of the HMAC, scaled to 0..9999, and reproducible', () => {
    const digest = createHmac('sha256', 'server').update('client:7', 'utf8').digest();
    const expected = (digest.readUIntBE(0, 6) * 16 + (digest[6]! >> 4)) / 2 ** 52;
    assert.equal(drawFraction('server', 'client', 7), expected);
    assert.equal(diceRoll('server', 'client', 7), Math.floor(expected * 10_000));
    assert.equal(diceRoll('server', 'client', 7), diceRoll('server', 'client', 7));
    for (let nonce = 0; nonce < 2_000; nonce += 1) {
      const roll = diceRoll('seed', 'c', nonce);
      assert.ok(Number.isInteger(roll) && roll >= 0 && roll <= 9_999);
    }
  });

  it('wins under below the line and over at or above it', () => {
    assert.equal(diceWins('under', 5_000, 4_999), true);
    assert.equal(diceWins('under', 5_000, 5_000), false);
    assert.equal(diceWins('over', 5_000, 5_000), true);
    assert.equal(diceWins('over', 5_000, 4_999), false);
    // The chance is exactly the count of winning rolls.
    for (const [direction, target] of [
      ['under', 2_500],
      ['over', 7_000],
    ] as const) {
      let wins = 0;
      for (let roll = 0; roll < 10_000; roll += 1) if (diceWins(direction, target, roll)) wins += 1;
      assert.equal(wins, diceChance(direction, target));
    }
  });
});

describe('dice: the edge', () => {
  it('returns at most 90% at every chance the table offers, and never pays under 1.01x', () => {
    for (let chance = DICE_MIN_CHANCE; chance <= DICE_MAX_CHANCE; chance += 1) {
      const bps = diceMultiplierBps(chance);
      // Expected return in exact integers: chance/10000 * bps/10000 <= (10000 - edge)/10000.
      assert.ok(chance * bps <= 10_000 * (10_000 - DICE_HOUSE_EDGE_BPS), `chance ${chance}`);
      assert.ok(
        chance * bps > 10_000 * (10_000 - DICE_HOUSE_EDGE_BPS) - chance,
        `chance ${chance}`,
      );
      assert.ok(bps >= 10_100, `chance ${chance} pays ${bps}`);
    }
    assert.throws(() => diceMultiplierBps(DICE_MIN_CHANCE - 1));
    assert.throws(() => diceMultiplierBps(DICE_MAX_CHANCE + 1));
    assert.equal(diceMultiplierBps(5_000), 18_000);
  });

  it('floors payouts and sizes the largest stake to the payout ceiling', () => {
    assert.equal(payoutAt(1_000_001n, 18_000), 1_800_001n);
    assert.equal(payoutAt(3n, 18_000), 5n);
    assert.equal(maxStakeAt(18_000, 1_800_000n), 1_000_000n);
  });
});

describe('dice: the route and the schema', () => {
  it('settles in one transaction from the committed seed, and records the wager once', async () => {
    const route = await read('services/api-gateway/src/routes/dice.ts');
    assert.match(route, /'SELECT \* FROM dice_bets WHERE user_id = \$1 AND idempotency_key = \$2'/);
    assert.match(route, /conflict\('IDEMPOTENCY_KEY_REUSED'/);
    assert.match(route, /FROM fairness_seeds WHERE user_id = \$1 AND used_at IS NULL FOR UPDATE/);
    assert.match(route, /conflict\(\s*'FAIRNESS_COMMITMENT_CHANGED'/);
    assert.match(route, /await assertGameEligible\(client, userId\);/);
    assert.match(route, /'STAKE_OVER_PAYOUT_LIMIT'/);
    assert.match(route, /creditWallet\(client, userId, payout, 'dice_payout', betId\)/);
    assert.match(route, /VALUES \(\$1, \$2, \$3, \$4, 'dice_stake', \$5\)/);
    assert.match(route, /recordWager\(\s+client,\s+config,\s+userId,\s+stake,\s+'dice',/);
  });

  it('widens every source and kind list, and keeps one roll per seed', async () => {
    const sql = await read('packages/db/migrations/056_dice_discord_rewards.sql');
    assert.match(sql, /'dice_stake', 'dice_payout',/);
    assert.equal(sql.match(/'coinflip', 'dice'\)\);/g)?.length, 3);
    assert.match(sql, /CREATE TABLE dice_bets \(/);
    assert.match(sql, /UNIQUE \(fairness_seed_id\),/);
    assert.match(sql, /CHECK \(win = \(payout_minor > 0\)\)/);
    assert.match(sql, /GRANT SELECT, INSERT ON TABLE dice_bets TO donut_api_runtime;/);
    assert.match(sql, /CREATE FUNCTION donut_schema_ready_v56\(\) RETURNS boolean/);
  });
});
