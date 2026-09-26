import type { ServerResponse } from 'node:http';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import { createAuthGuards } from './auth.js';
import type { Database } from './db.js';

export type LiveTopic =
  | 'activity'
  | 'balance'
  | 'chat'
  | 'roulette'
  | 'settings'
  // A crash round changed: a bet, a cash-out, the curve starting, a new round opening.
  | 'crash'
  // The round busted. Sent the moment it happens so every screen stops the curve at once, instead
  // of drawing past the crash point for as long as a refetch takes.
  | 'crash_bust';

interface Subscriber {
  readonly response: ServerResponse;
  readonly userId: string | null;
}

const MAX_SUBSCRIBERS = 10_000;
const MAX_BUFFERED_BYTES = 1_000_000;

/** Small same-process invalidation stream. Payloads never carry account or game data. */
export class LiveEventHub {
  readonly #subscribers = new Set<Subscriber>();
  #heartbeat: NodeJS.Timeout | null = null;

  add(response: ServerResponse, userId: string | null): (() => void) | null {
    if (this.#subscribers.size >= MAX_SUBSCRIBERS) return null;
    const subscriber = { response, userId };
    this.#subscribers.add(subscriber);
    this.#ensureHeartbeat();
    return () => {
      this.#subscribers.delete(subscriber);
      if (this.#subscribers.size === 0) this.#stopHeartbeat();
    };
  }

  publish(topic: LiveTopic, userIds?: Iterable<string>): void {
    const targets = userIds ? new Set(userIds) : null;
    const frame = `event: ${topic}\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`;
    for (const subscriber of this.#subscribers) {
      if (targets && (!subscriber.userId || !targets.has(subscriber.userId))) continue;
      const socket = subscriber.response.socket;
      if (!socket || socket.destroyed || socket.writableLength > MAX_BUFFERED_BYTES) {
        this.#subscribers.delete(subscriber);
        continue;
      }
      try {
        subscriber.response.write(frame);
      } catch {
        this.#subscribers.delete(subscriber);
      }
    }
  }

  close(): void {
    this.#stopHeartbeat();
    for (const subscriber of this.#subscribers) subscriber.response.end();
    this.#subscribers.clear();
  }

  #ensureHeartbeat(): void {
    if (this.#heartbeat) return;
    this.#heartbeat = setInterval(() => {
      for (const subscriber of this.#subscribers) {
        try {
          subscriber.response.write(
            `event: heartbeat\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`,
          );
        } catch {
          this.#subscribers.delete(subscriber);
        }
      }
      if (this.#subscribers.size === 0) this.#stopHeartbeat();
    }, 2_500);
    this.#heartbeat.unref?.();
  }

  #stopHeartbeat(): void {
    if (!this.#heartbeat) return;
    clearInterval(this.#heartbeat);
    this.#heartbeat = null;
  }
}

export const liveEvents = new LiveEventHub();

export function publishLiveSoon(topic: LiveTopic, userIds?: Iterable<string>): void {
  const targets = userIds ? [...userIds] : undefined;
  const timer = setTimeout(() => liveEvents.publish(topic, targets), 75);
  timer.unref?.();
}

export async function registerLiveEventRoutes(
  app: FastifyInstance,
  db: Database,
  config: AppConfig,
): Promise<void> {
  const guards = createAuthGuards(db, config);
  const softAuth = async (request: FastifyRequest) => {
    try {
      await guards.authenticate(request);
    } catch {
      // Public topics stay public. Authentication only scopes private balance invalidations.
    }
  };

  app.get(
    '/v1/live',
    {
      preHandler: softAuth,
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      reply.raw.write(`retry: 2000\nevent: hello\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
      const remove = liveEvents.add(reply.raw, request.authUser?.id ?? null);
      if (!remove) {
        reply.raw.end();
        return;
      }
      request.raw.once('close', remove);
    },
  );

  app.addHook('onClose', async () => liveEvents.close());
}
