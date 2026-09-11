import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { QueryResult, QueryResultRow } from 'pg';
import {
  bootstrapAdminInTransaction,
  parseBootstrapAdminArguments,
} from '../scripts/bootstrap-admin.js';
import { loadConfig } from '../src/config.js';
import type { DbClient } from '../src/lib/db.js';

const identity = `mc:${'a'.repeat(32)}`;

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
  ADMIN_MINECRAFT_IDS: identity,
  ADMIN_TOTP_SECRETS_JSON: JSON.stringify({
    [identity]: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
  }),
  AUDIT_LOG_HMAC_KEY: 'a'.repeat(32),
  IP_HASH_KEY: 'i'.repeat(32),
  ALLOWED_COUNTRIES: 'PL',
});

function result<R extends QueryResultRow>(rows: R[], rowCount = rows.length): QueryResult<R> {
  return { command: '', rowCount, oid: 0, fields: [], rows };
}

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

class BootstrapClient implements DbClient {
  readonly queries: RecordedQuery[] = [];

  constructor(
    private readonly target: QueryResultRow | undefined,
    private readonly otherActiveAdmin = false,
  ) {}

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<QueryResult<R>> {
    this.queries.push({ text, values });
    if (text.includes("role = 'admin' AND status = 'active'")) {
      return result(this.otherActiveAdmin ? ([{ id: 'other-admin' }] as unknown as R[]) : []);
    }
    if (text.includes('JOIN responsible_limits')) {
      return result(this.target ? ([this.target] as R[]) : []);
    }
    if (text.includes('UPDATE users')) return result([], 1);
    if (text.includes('UPDATE sessions')) return result([], 2);
    if (text.includes('SELECT entry_hash')) return result([]);
    return result([]);
  }
}

function eligibleTarget(overrides: QueryResultRow = {}): QueryResultRow {
  return {
    id: '10000000-0000-4000-8000-000000000099',
    minecraft_identity: identity,
    role: 'player',
    status: 'pending_compliance',
    country_code: 'PL',
    date_of_birth: '2000-01-01',
    terms_accepted_at: '2026-09-09T00:00:00.000Z',
    age_verified_at: null,
    kyc_status: 'pending',
    self_exclusion_active: false,
    database_today: '2026-09-09',
    ...overrides,
  };
}

const confirmedOptions = Object.freeze({
  identity,
  kycReviewConfirmed: true as const,
});

describe('administrator bootstrap', () => {
  it('requires exactly the canonical identity and explicit KYC confirmation', () => {
    assert.deepEqual(
      parseBootstrapAdminArguments([`--identity=${identity}`, '--confirm-kyc-reviewed']),
      confirmedOptions,
    );
    assert.throws(() => parseBootstrapAdminArguments([`--identity=${identity}`]));
    assert.throws(() =>
      parseBootstrapAdminArguments([`--identity=mc:${'A'.repeat(32)}`, '--confirm-kyc-reviewed']),
    );
    assert.throws(() =>
      parseBootstrapAdminArguments([`--identity=${identity}`, '--confirm-kyc-reviewed', '--force']),
    );
  });

  it('activates only an eligible linked user, revokes sessions, and appends an audit row', async () => {
    const client = new BootstrapClient(eligibleTarget());
    const outcome = await bootstrapAdminInTransaction(client, config, confirmedOptions);

    assert.deepEqual(outcome, {
      status: 'bootstrapped',
      userId: '10000000-0000-4000-8000-000000000099',
      minecraftIdentity: identity,
      sessionsRevoked: 2,
    });
    assert.ok(client.queries.some((query) => query.text.includes("SET role = 'admin'")));
    assert.ok(client.queries.some((query) => query.text.includes('UPDATE sessions')));
    const auditInsert = client.queries.find((query) =>
      query.text.includes('INSERT INTO audit_log'),
    );
    assert.ok(auditInsert);
    assert.equal(auditInsert.values[1], null);
    assert.equal(auditInsert.values[2], 'admin.bootstrap');
    assert.equal(auditInsert.values[4], outcome.userId);
  });

  it('refuses to create a second active administrator', async () => {
    const client = new BootstrapClient(eligibleTarget(), true);
    await assert.rejects(
      bootstrapAdminInTransaction(client, config, confirmedOptions),
      /another active administrator/,
    );
    assert.equal(
      client.queries.some((query) => query.text.includes('UPDATE users')),
      false,
    );
  });

  it('is idempotent for the same compliant active administrator', async () => {
    const client = new BootstrapClient(
      eligibleTarget({
        role: 'admin',
        status: 'active',
        age_verified_at: '2026-09-09T00:00:00.000Z',
        kyc_status: 'verified',
      }),
    );
    const outcome = await bootstrapAdminInTransaction(client, config, confirmedOptions);
    assert.equal(outcome.status, 'already_active');
    assert.equal(
      client.queries.some((query) => query.text.includes('UPDATE users')),
      false,
    );
    assert.equal(
      client.queries.some((query) => query.text.includes('INSERT INTO audit_log')),
      false,
    );
  });

  it('rejects missing profile data, minors, disallowed countries, and exclusions', async () => {
    for (const target of [
      eligibleTarget({ terms_accepted_at: null }),
      eligibleTarget({ date_of_birth: '2010-01-01' }),
      eligibleTarget({ country_code: 'US' }),
      eligibleTarget({ self_exclusion_active: true }),
      eligibleTarget({ status: 'self_excluded' }),
    ]) {
      await assert.rejects(
        bootstrapAdminInTransaction(new BootstrapClient(target), config, confirmedOptions),
      );
    }
  });
});
