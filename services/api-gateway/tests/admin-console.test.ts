import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

/*
 * The admin console can suspend an account, move a site balance and send real in-game currency.
 * These are source assertions rather than request tests, for the same reason the cash-withdrawal
 * suite next door uses them: the invariants worth protecting here are structural — which guard
 * runs before which write, and which table a failure is allowed to touch — and those are exactly
 * what a later refactor removes without any behavioural test noticing.
 */

/* Resolved from this file rather than from process.cwd(), so the suite passes whether it is run
 * per-workspace or from the repo root. */
const routes = (name: string) =>
  readFile(path.resolve(import.meta.dirname, `../src/routes/${name}.ts`), 'utf8');
const migration = () =>
  readFile(
    path.resolve(import.meta.dirname, '../../../packages/db/migrations/029_admin_console.sql'),
    'utf8',
  );

describe('admin player management', () => {
  it('writes a ledger row for every balance adjustment', async () => {
    /* A balance edited without one is a number that no longer reconciles against the sum of its
     * transactions, and the next person to audit the account cannot tell a correction from a
     * leak. If this assertion fails, the console has grown a way to move money invisibly. */
    const source = await routes('admin');
    const endpoint = source.slice(source.indexOf("'/v1/admin/users/:id/balance'"));
    assert.match(endpoint, /INSERT INTO wallet_transactions/);
    assert.match(endpoint, /'admin_adjustment'/);
    assert.match(endpoint, /appendAudit/);
  });

  it('refuses a debit that would take a balance below zero', async () => {
    /* The guard has to be in the WHERE clause, not a read-then-write: two operators debiting at
     * once would both pass a prior read and both apply. */
    const source = await routes('admin');
    const endpoint = source.slice(source.indexOf("'/v1/admin/users/:id/balance'"));
    assert.match(endpoint, /WHERE user_id = \$1 AND balance_minor \+ \$2 >= 0/);
    assert.match(endpoint, /INSUFFICIENT_FUNDS/);
  });

  it('leaves nothing on this endpoint that can outrank an operator', async () => {
    /* A live self-exclusion used to, deliberately: it was the player's own standing instruction
       and the point was that nobody, including this console, could lift it before it expired.
       Self-exclusion is gone with the rest of the compliance apparatus, so the guard is gone too —
       asserted here so its absence is a decision on the record rather than something that looks
       like it fell out. */
    const source = await routes('admin');
    const endpoint = source.slice(source.indexOf("'/v1/admin/users/:id/status'"));
    assert.doesNotMatch(endpoint, /SELF_EXCLUSION_LOCKED/);
    assert.doesNotMatch(endpoint, /responsible_limits/);
  });

  it('ends live sessions when an account stops being active', async () => {
    const source = await routes('admin');
    const endpoint = source.slice(source.indexOf("'/v1/admin/users/:id/status'"));
    assert.match(endpoint, /UPDATE sessions SET revoked_at = now\(\)/);
  });

  it('stops an administrator locking themselves out', async () => {
    /* How a console ends up with nobody able to open it. */
    const source = await routes('admin');
    assert.match(source, /CANNOT_LOCK_SELF/);
  });

  it('offers no role endpoint, because one here cannot work', async () => {
    /* A lever wrote users.role and reported success. authenticate() re-derives the role from
     * ADMIN_MINECRAFT_IDS on every request and puts the row back, revoking the target's sessions
     * on the way, so the grant lasted until their next request and only logged them out.
     *
     * This asserts the absence AND that the reason survives next to it. Without the note the gap
     * looks like an oversight and the next person fills it back in. */
    const source = await routes('admin');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(code, /users\/:id\/role/);
    assert.doesNotMatch(code, /userRoleSchema/);
    assert.match(source, /THERE IS NO ROLE ENDPOINT/);
    assert.match(source, /ADMIN_MINECRAFT_IDS/);

    const console_ = await readFile(
      path.resolve(import.meta.dirname, '../../../DONUTDROP FRONTEND/Donut Drop/admin/admin.js'),
      'utf8',
    );
    assert.doesNotMatch(console_, /Make admin|Remove admin/);
    assert.match(console_, /not editable here/);
  });
});

describe('admin payouts', () => {
  it('never touches a wallet', async () => {
    /* An admin payout is the house sending in-game currency out of a bot's own balance. It
     * debited nobody, so there is nothing to refund, and the honest outcome of a failure is a
     * failed row somebody looks at. A wallet write anywhere in this endpoint would mean a failed
     * in-game payment silently became site credit — a different payment from the one ordered. */
    const source = await routes('admin');
    const endpoint = source.slice(
      source.indexOf("'/v1/admin/bots/:id/pay'"),
      source.indexOf("'/v1/admin/payouts'"),
    );
    assert.doesNotMatch(endpoint, /user_wallets/);
    assert.doesNotMatch(endpoint, /wallet_transactions/);
    assert.doesNotMatch(endpoint, /creditWallet/);
  });

  it('does not refund or credit when an in-game payout fails', async () => {
    const source = await routes('minecraft-in');
    const failure = source.slice(source.indexOf("if (job.kind === 'admin_payout') {"));
    const branch = failure.slice(0, failure.indexOf("if (job.kind === 'withdrawal') {"));
    assert.doesNotMatch(branch, /refundWithdrawal/);
    assert.doesNotMatch(branch, /user_wallets/);
    assert.match(branch, /UPDATE admin_payouts SET status/);
  });

  it('honours the idempotency key it demands', async () => {
    /* Requiring the header and then ignoring it promises a guarantee that is not delivered: a
     * retried request would pay a second time. */
    const source = await routes('admin');
    const endpoint = source.slice(source.indexOf("'/v1/admin/bots/:id/pay'"));
    assert.match(endpoint, /requireIdempotencyKey/);
    assert.match(endpoint, /ON CONFLICT \(actor_user_id, idempotency_key\) DO NOTHING/);
    const sql = await migration();
    assert.match(sql, /UNIQUE \(actor_user_id, idempotency_key\)/);
  });

  it('reads the replayed row before inserting, never after a failed insert', async () => {
    /* A unique violation aborts the whole transaction in Postgres, so a SELECT inside a catch
     * block around the INSERT can never run. This is the assertion that stops somebody
     * "simplifying" it back into the shape that cannot work. */
    const source = await routes('admin');
    const endpoint = source.slice(source.indexOf("'/v1/admin/bots/:id/pay'"));
    const replayAt = endpoint.indexOf('const replay = await client.query');
    const insertAt = endpoint.indexOf('INSERT INTO admin_payouts');
    assert.ok(replayAt > 0 && insertAt > 0, 'both the replay read and the insert must exist');
    assert.ok(replayAt < insertAt, 'the replay read must come before the insert');
  });

  it('only pays from a bot this deployment holds credentials for', async () => {
    const source = await routes('admin');
    const endpoint = source.slice(source.indexOf("'/v1/admin/bots/:id/pay'"));
    assert.match(endpoint, /provisionedBotIds/);
    assert.match(endpoint, /last_heartbeat_at > now\(\) - interval '45 seconds'/);
    assert.match(endpoint, /botCredentials\.get/);
  });

  it('allows only one live payout per payee', async () => {
    const sql = await migration();
    assert.match(sql, /CREATE UNIQUE INDEX admin_payouts_one_live_idx/);
    assert.match(sql, /WHERE status IN \('queued', 'processing'\)/);
  });
});

describe('bot reconnect', () => {
  it('queues a job rather than pushing, because the gateway cannot reach the bot', async () => {
    const source = await routes('admin');
    const endpoint = source.slice(source.indexOf("'/v1/admin/bots/:id/reconnect'"));
    assert.match(endpoint, /INSERT INTO bot_jobs/);
    assert.match(endpoint, /'reconnect'/);
    assert.match(endpoint, /RECONNECT_ALREADY_QUEUED/);
  });

  it('touches no table that holds money', async () => {
    /* A reconnect moves nothing. If it ever grows a write to a money-bearing table, it has stopped
     * being a reconnect.
     *
     * Asserted against code with the comments stripped, and bounded at the pay route below it.
     * Matching raw words over a raw slice fails on the neighbouring endpoint's prose, which is the
     * assertion being wrong rather than the code. */
    const admin = await routes('admin');
    const endpoint = admin.slice(
      admin.indexOf("'/v1/admin/bots/:id/reconnect'"),
      admin.indexOf("'/v1/admin/bots/:id/pay'"),
    );
    assert.ok(endpoint.length > 0, 'the reconnect route must precede the pay route');
    const code = endpoint.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const table of [
      'user_wallets',
      'wallet_transactions',
      'admin_payouts',
      'cash_withdrawals',
      'withdrawals',
    ]) {
      assert.ok(!code.includes(table), `the reconnect route must not reference ${table}`);
    }
    /* The only row it is allowed to write. */
    assert.match(code, /INSERT INTO bot_jobs/);
    assert.equal(code.match(/INSERT INTO/g)?.length, 1);
  });

  it('is claimable by a bot whose item transfers are switched off', async () => {
    /* None of the non-item kinds opens the inventory, so none is gated on item capability — the
     * bug this mirrors left a queued payout indistinguishable from an empty queue. */
    const source = await routes('minecraft-in');
    assert.match(
      source,
      /AND \(kind IN \('cash_payout', 'admin_payout', 'reconnect'\) OR \$2::boolean\)/,
    );
  });
});

describe('complete admin operations surface', () => {
  it('keeps every cross-product mutation behind the admin guard and audit chain', async () => {
    const source = await routes('admin-operations');
    for (const route of [
      "'/v1/admin/cash-withdrawals/:id/resolve'",
      "'/v1/admin/payouts/:id/resolve'",
      "'/v1/admin/jobs/:id/retry'",
      "'/v1/admin/creator-applications/:id/decision'",
      "'/v1/admin/races'",
      "'/v1/admin/quests'",
    ]) {
      const start = source.indexOf(route);
      assert.ok(start >= 0, `${route} must exist`);
      const endpoint = source.slice(start, start + 9_000);
      assert.match(endpoint, /guards\.requireAdmin/);
      assert.match(endpoint, /appendAudit/);
    }
  });

  it('guards, serializes, and audits operator-funded Lava Rain promotions', async () => {
    const source = await routes('social');
    const endpoint = source.slice(source.indexOf("'/v1/social/rain'"));
    assert.match(endpoint, /guards\.requireAdmin/);
    assert.match(endpoint, /lava-rain-create/);
    assert.match(endpoint, /RAIN_ALREADY_ACTIVE/);
    assert.match(endpoint, /appendAudit/);
  });

  it('never blindly retries a value-bearing bot job', async () => {
    const source = await routes('admin-operations');
    const endpoint = source.slice(source.indexOf("'/v1/admin/jobs/:id/retry'"));
    const bounded = endpoint.slice(0, endpoint.indexOf("'/v1/admin/moderation'"));
    assert.match(bounded, /kind IN \('inventory_resync', 'reconnect'\)/);
    assert.doesNotMatch(bounded, /kind IN \([^)]*cash_payout/);
    assert.match(bounded, /JOB_NOT_RETRYABLE/);
  });

  it('makes system trust roots read-only instead of exposing secret writes', async () => {
    const source = await routes('admin-operations');
    assert.match(source, /app\.get\('\/v1\/admin\/system-config'/);
    assert.doesNotMatch(source, /app\.(?:post|patch|put)\('\/v1\/admin\/system-config'/);
    for (const secret of ['cookieSecret', 'dataEncryptionKey', 'adminTotpSecrets', 'databaseUrl']) {
      const response = source.slice(source.indexOf("'/v1/admin/system-config'"));
      assert.doesNotMatch(response, new RegExp(`${secret}:`));
    }
  });

  it('grants only the additional quest privilege and pins readiness to it', async () => {
    const sql = await readFile(
      path.resolve(import.meta.dirname, '../../../packages/db/migrations/037_admin_operations.sql'),
      'utf8',
    );
    assert.match(sql, /GRANT UPDATE ON TABLE quest_definitions TO donut_api_runtime/);
    assert.match(sql, /CREATE FUNCTION donut_schema_ready_v37\(\) RETURNS boolean/);
    assert.doesNotMatch(sql, /GRANT (?:ALL|DELETE|TRUNCATE)/);
  });
});
