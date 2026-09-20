import type { FastifyInstance } from 'fastify';
import type { Database } from '../lib/db.js';

interface ReadinessCache {
  ping(): Promise<string>;
}

export async function registerHealthRoutes(
  app: FastifyInstance,
  db: Database,
  cache?: ReadinessCache,
) {
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_request, reply) => {
    try {
      const [schema, cacheResponse] = await Promise.all([
        db.query<{ ready: boolean }>('SELECT public.donut_schema_ready_v37() AS ready'),
        cache ? cache.ping() : Promise.resolve('PONG'),
      ]);
      if (schema.rows[0]?.ready !== true || cacheResponse !== 'PONG') {
        throw new Error('Required backend dependency is not ready');
      }
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'not_ready' });
    }
  });
}
