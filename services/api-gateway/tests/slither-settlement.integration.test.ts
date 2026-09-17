import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, it } from 'node:test';
import { splitExtraction } from '../src/lib/slither-engine.js';

/**
 * The arena's settlement constraints, against a real PostgreSQL.
 *
 * WHY THIS EXISTS AS AN INTEGRATION TEST AND NOT A UNIT ONE
 * ---------------------------------------------------------
 * The bug it was written for could not have been caught anywhere else. `slither_sessions` carries
 * three overlapping CHECK constraints — the fee identity, "a loss pays nobody", and "a void refunds
 * whole" — and each one is obviously correct on its own. The first version of the fee identity
 * applied to EVERY exit, which together with the second made a death mathematically impossible to
 * write: a death records what hit the floor in `final_value_minor` while both other columns are
 * pinned to zero, so `credited + fee = final` could only hold for a snake that died carrying
 * nothing.
 *
 * Nothing in the TypeScript noticed. The route logged a constraint violation from inside a promise,
 * the player was correctly told they had died, and the row stayed `alive` — where the orphan sweeper
 * would eventually have refunded a stake that had already been eaten by somebody else. That is a
 * money bug with no failing unit test in front of it, and the only thing that can prove the fix is
 * the database that rejected it.
 *
 * Every case below inserts the exact row shape the route writes and rolls back, so the test leaves
 * nothing behind and needs no fixtures.
 */

const databaseUrl = process.env['TEST_DATABASE_URL'];

const ENTRY = 25_000_000n;
const FEE_BPS = 300;

async function withRolledBackUser(
  pool: pg.Pool,
  work: (client: pg.PoolClient, userId: string) => Promise<void>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userId = randomUUID();
    // minecraft_username is varchar(16) because that is Minecraft's own limit.
    const handle = `slt_${userId.slice(0, 8)}`;
    await client.query(
      /* $3 is cast explicitly: used bare it is deduced as varchar in one position and text inside
       * lower(), and PostgreSQL refuses the statement rather than picking one. */
      `INSERT INTO users (id, minecraft_identity, minecraft_username, normalized_username)
       VALUES ($1, $2, $3::varchar, lower($3::varchar))`,
      [userId, userId, handle],
    );
    await work(client, userId);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

function insertSession(client: pg.PoolClient, userId: string, id: string): Promise<unknown> {
  return client.query(
    `INSERT INTO slither_sessions (id, user_id, entry_minor, fee_bps, status, peak_value_minor)
     VALUES ($1, $2, $3, $4, 'alive', $3)`,
    [id, userId, ENTRY.toString(), FEE_BPS],
  );
}

function endSession(
  client: pg.PoolClient,
  id: string,
  status: string,
  finalMinor: bigint,
  feeMinor: bigint,
  creditedMinor: bigint,
): Promise<unknown> {
  return client.query(
    `UPDATE slither_sessions
        SET status = $2, ended_at = now(), final_value_minor = $3,
            fee_minor = $4, credited_minor = $5
      WHERE id = $1 AND status = 'alive'`,
    [id, status, finalMinor.toString(), feeMinor.toString(), creditedMinor.toString()],
  );
}

void describe('arena settlement constraints', { skip: !databaseUrl }, () => {
  void it('accepts every terminal status the route can actually produce', async () => {
    if (!databaseUrl) return;
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    try {
      await withRolledBackUser(pool, async (client, userId) => {
        /* An extraction: the cut comes off and the identity holds. */
        const cashed = randomUUID();
        await insertSession(client, userId, cashed);
        const split = splitExtraction(24_652_424n, FEE_BPS);
        await endSession(
          client,
          cashed,
          'cashed_out',
          split.grossMinor,
          split.feeMinor,
          split.creditedMinor,
        );

        /* A death carrying real money. THIS is the case the first constraint set forbade. */
        const killed = randomUUID();
        await insertSession(client, userId, killed);
        await endSession(client, killed, 'killed', 3_000_000n, 0n, 0n);

        /* An abandonment is a death by another name and must be equally writable. */
        const abandoned = randomUUID();
        await insertSession(client, userId, abandoned);
        await endSession(client, abandoned, 'abandoned', 63_000_000n, 0n, 0n);

        /* A void hands the buy-in back whole. */
        const voided = randomUUID();
        await insertSession(client, userId, voided);
        await endSession(client, voided, 'voided', ENTRY, 0n, ENTRY);

        const rows = await client.query<{ status: string; final_value_minor: string }>(
          `SELECT status, final_value_minor FROM slither_sessions
            WHERE user_id = $1 ORDER BY status`,
          [userId],
        );
        assert.deepEqual(
          rows.rows.map((row) => row.status),
          ['abandoned', 'cashed_out', 'killed', 'voided'],
        );
        // The death rows keep the amount that hit the floor rather than zeroing it to satisfy a rule.
        assert.equal(
          rows.rows.find((row) => row.status === 'killed')?.final_value_minor,
          '3000000',
        );
      });
    } finally {
      await pool.end();
    }
  });

  void it('still refuses a settlement whose arithmetic does not add up', async () => {
    if (!databaseUrl) return;
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    try {
      await withRolledBackUser(pool, async (client, userId) => {
        const id = randomUUID();
        await insertSession(client, userId, id);
        await client.query('SAVEPOINT attempt');
        await assert.rejects(
          () => endSession(client, id, 'cashed_out', 10_000_000n, 300_000n, 9_000_000n),
          /slither_fee_adds_up/,
          'an extraction that loses money between the three columns must be refused',
        );
        await client.query('ROLLBACK TO SAVEPOINT attempt');

        await client.query('SAVEPOINT loser');
        await assert.rejects(
          () => endSession(client, id, 'killed', 3_000_000n, 90_000n, 0n),
          /slither_loss_pays_nobody/,
          'the house must not be able to take a cut of a death',
        );
        await client.query('ROLLBACK TO SAVEPOINT loser');

        /* Internally consistent — credited + fee really does equal final — so `fee_adds_up` is
         * satisfied and the only rule left to catch it is the one under test. Shorting the refund
         * AND breaking the identity would have been caught by whichever constraint PostgreSQL
         * happened to evaluate first, which proves nothing about this one. */
        await client.query('SAVEPOINT shortvoid');
        await assert.rejects(
          () => endSession(client, id, 'voided', ENTRY - 1n, 0n, ENTRY - 1n),
          /slither_void_refunds_whole/,
          'a void must return the whole buy-in, not merely a self-consistent fraction of it',
        );
        await client.query('ROLLBACK TO SAVEPOINT shortvoid');
      });
    } finally {
      await pool.end();
    }
  });

  void it('allows one live snake per account and no more', async () => {
    if (!databaseUrl) return;
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    try {
      await withRolledBackUser(pool, async (client, userId) => {
        await insertSession(client, userId, randomUUID());
        await client.query('SAVEPOINT second');
        await assert.rejects(
          () => insertSession(client, userId, randomUUID()),
          /slither_one_live_session_idx/,
          'a second live snake on one account is how somebody feeds their own orbs to themselves',
        );
        await client.query('ROLLBACK TO SAVEPOINT second');

        // Ending the first frees the account to buy in again.
        const rows = await client.query<{ id: string }>(
          `SELECT id FROM slither_sessions WHERE user_id = $1`,
          [userId],
        );
        const first = rows.rows[0]?.id;
        assert.ok(first);
        await endSession(client, first, 'killed', 1_000_000n, 0n, 0n);
        await insertSession(client, userId, randomUUID());
      });
    } finally {
      await pool.end();
    }
  });

  void it('refuses a buy-in outside the $1M to $100M band', async () => {
    if (!databaseUrl) return;
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    try {
      await withRolledBackUser(pool, async (client, userId) => {
        for (const outside of ['999999', '100000001']) {
          await client.query('SAVEPOINT band');
          await assert.rejects(
            () =>
              client.query(
                `INSERT INTO slither_sessions
                   (id, user_id, entry_minor, fee_bps, status, peak_value_minor)
                 VALUES ($1, $2, $3, $4, 'alive', $3)`,
                [randomUUID(), userId, outside, FEE_BPS],
              ),
            /slither_sessions_entry_minor_check/,
            `${outside} has no defined snake size and must not reach the table`,
          );
          await client.query('ROLLBACK TO SAVEPOINT band');
        }
      });
    } finally {
      await pool.end();
    }
  });
});
