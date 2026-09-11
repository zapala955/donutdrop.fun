import pg, { type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import type { AppConfig } from '../config.js';

export interface DbClient {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

export class Database {
  readonly pool: pg.Pool;

  constructor(config: AppConfig) {
    this.pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 8_000,
      application_name: 'donut-upgrader-api',
      options: '-c timezone=UTC',
      ...(config.databaseSsl ? { ssl: { rejectUnauthorized: true } } : {}),
    });
  }

  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>> {
    return this.pool.query<R>(text, values);
  }

  async transaction<T>(work: (client: PoolClient) => Promise<T>, retries = 2): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        const code = (error as { code?: string }).code;
        if ((code === '40001' || code === '40P01') && attempt < retries) continue;
        throw error;
      } finally {
        client.release();
      }
    }
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}
