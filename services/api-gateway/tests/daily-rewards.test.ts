import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { QueryResult, QueryResultRow } from 'pg';
import { loadConfig } from '../src/config.js';
import {
  dailyRewardWagerProgress,
  requireDailyRewardWager,
} from '../src/lib/daily-rewards.js';
import type { DbClient } from '../src/lib/db.js';

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
};

function result<R extends QueryResultRow>(rows: R[]): QueryResult<R> {
  return { command: '', rowCount: rows.length, oid: 0, fields: [], rows };
}

class WagerClient implements DbClient {
  queryText = '';

  constructor(private readonly total: bigint) {}

  async query<R extends QueryResultRow = QueryResultRow>(text: string): Promise<QueryResult<R>> {
    this.queryText = text;
    return result([{ total: this.total.toString() }] as unknown as R[]);
  }
}

describe('daily reward wager gate', () => {
  const config = loadConfig(baseEnv);
  /* The gate is off by default now, so exercising it needs a deployment that asks for it. It is
   * still worth exercising: the figure is runtime-manageable from the admin console, so the gate
   * can come back on a live site without a deploy. */
  const gated = loadConfig({ ...baseEnv, STREAK_DAILY_WAGER_REQUIRED_MINOR: '10000000' });

  /* The default is no requirement at all: a daily reward is a reason to come back, and one that
   * first demands a stake is one most players meet by not coming back. */
  it('defaults to no wager requirement, and does not go to the database to say so', async () => {
    assert.equal(config.streakDailyWagerRequiredMinor, 0n);
    const client = new WagerClient(0n);
    const progress = await dailyRewardWagerProgress(client, config, 'user-1');
    assert.equal(progress.met, true);
    assert.equal(progress.requiredMinor, 0n);
    assert.equal(progress.remainingMinor, 0n);
    // Summing a day of wagers to compare the total against zero is a scan bought for nothing.
    assert.equal(client.queryText, '');
    await assert.doesNotReject(requireDailyRewardWager(client, config, 'user-1'));
  });

  it('still refuses one unit short once a deployment asks for a threshold', async () => {
    const client = new WagerClient(9_000_000n);
    const progress = await dailyRewardWagerProgress(client, gated, 'user-1');
    assert.equal(progress.met, false);
    assert.equal(progress.remainingMinor, 1_000_000n);
    assert.match(client.queryText, /FROM wager_events/);
    assert.match(client.queryText, /date_trunc\('day', now\(\) AT TIME ZONE 'utc'\)/);

    await assert.rejects(
      requireDailyRewardWager(new WagerClient(9_999_999n), gated, 'user-1'),
      (error: { code?: string }) => error.code === 'STREAK_WAGER_REQUIRED',
    );
    const exact = await requireDailyRewardWager(new WagerClient(10_000_000n), gated, 'user-1');
    assert.equal(exact.met, true);
    assert.equal(exact.remainingMinor, 0n);
  });

  it('checks the wager gate before the streak route can credit the wallet', async () => {
    const route = await readFile(
      path.resolve(import.meta.dirname, '../src/routes/engagement.ts'),
      'utf8',
    );
    const claimStart = route.indexOf("'/v1/streak/claim'");
    const gate = route.indexOf('await requireDailyRewardWager(client, config, userId)', claimStart);
    const credit = route.indexOf('await creditWallet(', gate);
    assert.ok(claimStart >= 0 && gate > claimStart, 'daily reward claim has no wager gate');
    assert.ok(credit > gate, 'daily reward wallet credit happens before its wager gate');
  });
});
