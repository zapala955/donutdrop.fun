import pg from 'pg';
import type { CommunityConfig } from './config.js';

/**
 * db.ts — the bot's own connection to the platform database.
 *
 * A small pool, because this process is one Discord gateway connection and a handful of button
 * presses, not a web server. Twenty connections would be twenty idle sockets on a database the
 * API also needs.
 *
 * Every bigint comes back as a string. `pg` parses int8 into a JavaScript number by default,
 * which silently rounds past 2^53 -- and this database holds balances that pass it. Nothing here
 * reads money today, but the parser is process-wide and the next person to add a query should not
 * have to know that.
 */
pg.types.setTypeParser(20, (value) => value);

export type QueryResult<T> = { rows: T[]; rowCount: number };

export class Database {
  readonly #pool: pg.Pool;

  constructor(config: CommunityConfig) {
    this.#pool = new pg.Pool({
      connectionString: config.databaseUrl,
      ssl: config.databaseSsl ? { rejectUnauthorized: true } : undefined,
      max: 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      // A query that hangs holds a connection and a Discord interaction that has three seconds
      // to be acknowledged. Bound it rather than letting it wait forever.
      statement_timeout: 8_000,
    });
  }

  async query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    const result = await this.#pool.query<T>(text, values as unknown[]);
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  }

  /** Runs `work` inside a transaction, rolling back on any throw. */
  async transaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}

export interface GuildSettings {
  guild_id: string;
  ticket_category_id: string | null;
  ticket_log_channel_id: string | null;
  ticket_staff_role_id: string | null;
  modlog_channel_id: string | null;
  welcome_channel_id: string | null;
  welcome_message: string | null;
  goodbye_channel_id: string | null;
  autorole_id: string | null;
  suggestion_channel_id: string | null;
  automod_invites: boolean;
  automod_links: boolean;
  automod_spam: boolean;
  automod_caps: boolean;
  automod_exempt_role_id: string | null;
}

/**
 * The guild's settings, creating the row on first use.
 *
 * Every column is nullable and every feature reads its own: a server that has not chosen a
 * mod-log channel has moderation that works and logs nothing, rather than moderation that throws.
 */
export async function guildSettings(db: Database, guildId: string): Promise<GuildSettings> {
  const existing = await db.query<GuildSettings>(
    'SELECT * FROM discord_guild_settings WHERE guild_id = $1',
    [guildId],
  );
  if (existing.rows[0]) return existing.rows[0];
  const created = await db.query<GuildSettings>(
    `INSERT INTO discord_guild_settings (guild_id) VALUES ($1)
     ON CONFLICT (guild_id) DO UPDATE SET guild_id = EXCLUDED.guild_id
     RETURNING *`,
    [guildId],
  );
  const row = created.rows[0];
  if (!row) throw new Error('Guild settings upsert returned no row');
  return row;
}

/** Writes one setting. The column name is chosen by the caller from a fixed list, never by input. */
export async function setGuildSetting(
  db: Database,
  guildId: string,
  column: keyof Omit<GuildSettings, 'guild_id'>,
  value: string | boolean | null,
): Promise<void> {
  await guildSettings(db, guildId);
  /* Interpolated, and safe because `column` is a key of a compile-time type rather than anything
   * a user typed -- an identifier cannot be a bind parameter in Postgres. The allowed set is the
   * GuildSettings interface, enforced by the type checker at every call site. */
  await db.query(
    `UPDATE discord_guild_settings SET ${column} = $2, updated_at = now() WHERE guild_id = $1`,
    [guildId, value],
  );
}
