import type { ServerResponse } from 'node:http';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import { createAuthGuards } from './auth.js';
import type { Database } from './db.js';

export type LiveTopic =
  | 'activity'
  | 'balance'
  | 'chat'
  // A Lava Rain drop opened, gained a claimant, or settled.
  | 'rain'
  | 'roulette'
  | 'settings'
  // A crash round changed: a bet, a cash-out, the curve starting, a new round opening.
  | 'crash'
  // The round busted. Sent the moment it happens so every screen stops the curve at once, instead
  // of drawing past the crash point for as long as a refetch takes.
  | 'crash_bust'
  // A coinflip game opened, was taken or closed.
  | 'coinflip'
  // A mines duel opened, was taken, had a player finish, or settled. Carries nothing about a
  // player's tiles: a refresh reads what the reader is allowed to see.
  | 'minesduel'
  // A crown changed hands or fell, or a bounty was won or ran out (lib/crowns.ts).
  | 'crowns'
  // Stocks, per player: one of your positions opened, closed, was liquidated or hit the payout cap.
  // Your page re-reads your positions; nobody else's does.
  | 'stocks'
  // Stocks: positions that just settled, as the strip on the stage shows them (publishData). The same
  // rows GET /v1/stocks lists for anyone, masked names included.
  | 'stocks_feed'
  // Stocks: the shared chart's newest prices, carried in the event itself (publishData). Public by
  // design: every price is one that has already happened, never one still to come.
  | 'stocks_tick'
  // Per player: something for the notification bell landed -- a deposit, a withdrawal paid or
  // refunded, a tip, a reward (lib/notifications.ts). The page re-reads the bell and the deposits.
  | 'notice';

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
    this.#send(topic, { at: new Date().toISOString() }, userIds);
  }

  /**
   * Sends a payload with the event, to everyone. Only for data that is public as it stands -- the
   * stocks chart's past prices -- because every subscriber, signed in or not, receives it.
   */
  publishData(topic: LiveTopic, data: Record<string, unknown>): void {
    this.#send(topic, { at: new Date().toISOString(), ...data });
  }

  #send(topic: LiveTopic, data: Record<string, unknown>, userIds?: Iterable<string>): void {
    const targets = userIds ? new Set(userIds) : null;
    const frame = `event: ${topic}\ndata: ${JSON.stringify(data)}\n\n`;
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
        /* A hijacked reply bypasses Fastify's own header flush, so the CORS headers @fastify/cors
         * has already set on it would be dropped. Same-origin production never noticed; the local
         * setup (page on APP_ORIGIN, API on another port) lost every live event to the browser's
         * CORS check, and with it the balance, feed and table updates. */
        ...(reply.getHeaders() as Record<string, string | string[]>),
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
