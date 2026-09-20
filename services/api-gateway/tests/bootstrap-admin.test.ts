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
    if (text.includes('FROM users WHERE minecraft_identity')) {
      return result(this.target ? ([this.target] as R[]) : []);
    }
    if (text.includes('UPDATE users')) return result([], 1);
    if (text.includes('UPDATE sessions')) return result([], 2);
    if (text.includes('SELECT entry_hash')) return result([]);
    return result([]);
  }
}

function eligibleTarget(overrides: QueryResultRow = {}): QueryResultRow {
  /* A country, a birth date, terms, an age flag, a KYC status and a self-exclusion flag were all
   * part of this fixture, because bootstrap asserted every one of them before granting admin. The
   * records are gone; what still guards this script is ADMIN_MINECRAFT_IDS, which is deployment
   * configuration rather than anything the account can claim about itself. */
  return {
    id: '10000000-0000-4000-8000-000000000099',
    minecraft_identity: identity,
    role: 'player',
    status: 'active',
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

  it('is idempotent for an account that is already an active administrator', async () => {
    const client = new BootstrapClient(eligibleTarget({ role: 'admin', status: 'active' }));
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

  it('rejects an account an operator has already stopped', async () => {
    /* This asserted missing profile data, minors, disallowed countries and self-exclusions too.
     * None of those records exists now. What is left is the one state that still means "do not
     * give this account anything": an operator has suspended or closed it. */
    for (const target of [
      eligibleTarget({ status: 'suspended' }),
      eligibleTarget({ status: 'closed' }),
    ]) {
      await assert.rejects(
        bootstrapAdminInTransaction(new BootstrapClient(target), config, confirmedOptions),
      );
    }
  });
});
