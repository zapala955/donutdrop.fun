import type { WebSocket } from 'ws';

/**
 * socket-hub.ts — the socket registry, with no game in it.
 *
 * This is the transport that battle-hub.ts used to own outright. It moved here when skill duels
 * arrived and needed the same thing: a set of sockets, a room per match, a heartbeat that drops
 * the ones that stopped answering, and a send that can never take a settlement down with it.
 *
 * Copying those 180 lines into a second file would have been the faster change and the wrong one.
 * Two hubs drift: one grows a backpressure limit the other does not, one unrefs its heartbeat and
 * the other pins the process open at shutdown, and the bug only ever shows up in whichever mode
 * nobody load-tested. The generic parameter is the entire difference between the two consumers —
 * everything else about moving bytes to a browser is identical, so it is written once.
 *
 * It knows nothing about money, seats, stakes or scores. That is what keeps every settlement path
 * testable without a network.
 */

/**
 * The three frames every hub sends regardless of what game is on top of it.
 *
 * `send` accepts these alongside the caller's own event union, so a consumer does not have to
 * remember to include them in its type — but every consumer does include them anyway, because a
 * client has to be able to switch on them.
 */
export type HubLifecycleEvent =
  | { readonly type: 'hello'; readonly now: number }
  | { readonly type: 'pong'; readonly now: number }
  | { readonly type: 'error'; readonly message: string };

export interface Subscriber {
  readonly socket: WebSocket;
  /** Match codes this socket is watching. Empty means it only wants the lobby list. */
  readonly rooms: Set<string>;
  /**
   * The authenticated user behind the socket, if any.
   *
   * Every caller currently passes null: no socket route on this platform runs an authentication
   * preHandler, because nothing a socket accepts moves money — joining, staking and settling are
   * all CSRF-guarded REST calls. Anything added here that needs to know who is on the other end
   * has to authenticate first rather than read this field and assume.
   */
  readonly userId: string | null;
  /** Set false by the heartbeat when a pong does not come back. */
  alive: boolean;
}

/** Sockets that stop answering are dropped rather than accumulating for the life of the process. */
const HEARTBEAT_MS = 30_000;

/** Never send to a socket whose buffer is already backed up — it is gone, it just has not said so. */
const MAX_BUFFERED_BYTES = 1_000_000;

/** A socket may watch several matches at once, but not unboundedly many. */
const MAX_ROOMS_PER_SOCKET = 12;

export class SocketHub<TEvent> {
  readonly #subscribers = new Set<Subscriber>();
  #heartbeat: NodeJS.Timeout | null = null;

  /** Registers a socket. Returns the subscriber handle used to join and leave rooms. */
  add(socket: WebSocket, userId: string | null): Subscriber {
    const subscriber: Subscriber = { socket, rooms: new Set(), userId, alive: true };
    this.#subscribers.add(subscriber);

    socket.on('pong', () => {
      subscriber.alive = true;
    });
    socket.on('close', () => {
      this.#subscribers.delete(subscriber);
    });
    socket.on('error', () => {
      // A socket that errored is finished; drop it rather than letting it linger half-open.
      this.#subscribers.delete(subscriber);
      try {
        socket.terminate();
      } catch {
        /* already gone */
      }
    });

    this.#ensureHeartbeat();
    this.send(subscriber, { type: 'hello', now: Date.now() });
    return subscriber;
  }

  remove(subscriber: Subscriber): void {
    this.#subscribers.delete(subscriber);
  }

  join(subscriber: Subscriber, code: string): void {
    /* Bounded, or one connection could pin every match on the platform in memory. */
    if (subscriber.rooms.size >= MAX_ROOMS_PER_SOCKET) {
      const oldest = subscriber.rooms.values().next().value;
      if (oldest !== undefined) subscriber.rooms.delete(oldest);
    }
    subscriber.rooms.add(code);
  }

  leave(subscriber: Subscriber, code: string): void {
    subscriber.rooms.delete(code);
  }

  /** Sends to one socket. Never throws: a dead socket must not take a settlement down with it. */
  send(subscriber: Subscriber, event: TEvent | HubLifecycleEvent): void {
    const socket = subscriber.socket;
    if (socket.readyState !== socket.OPEN) return;
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.#subscribers.delete(subscriber);
      try {
        socket.terminate();
      } catch {
        /* already gone */
      }
      return;
    }
    try {
      socket.send(JSON.stringify(event));
    } catch {
      this.#subscribers.delete(subscriber);
    }
  }

  /** Everyone watching the lobby list — that is, every connected socket. */
  broadcastLobby(event: TEvent | HubLifecycleEvent): void {
    for (const subscriber of this.#subscribers) this.send(subscriber, event);
  }

  /** Everyone watching one match. */
  broadcast(code: string, event: TEvent | HubLifecycleEvent): void {
    for (const subscriber of this.#subscribers) {
      if (subscriber.rooms.has(code)) this.send(subscriber, event);
    }
  }

  get size(): number {
    return this.#subscribers.size;
  }

  /** How many sockets are watching a given match. Used by the lobby list's spectator count. */
  watchers(code: string): number {
    let count = 0;
    for (const subscriber of this.#subscribers) if (subscriber.rooms.has(code)) count += 1;
    return count;
  }

  #ensureHeartbeat(): void {
    if (this.#heartbeat) return;
    this.#heartbeat = setInterval(() => {
      for (const subscriber of this.#subscribers) {
        if (!subscriber.alive) {
          this.#subscribers.delete(subscriber);
          try {
            subscriber.socket.terminate();
          } catch {
            /* already gone */
          }
          continue;
        }
        subscriber.alive = false;
        try {
          subscriber.socket.ping();
        } catch {
          this.#subscribers.delete(subscriber);
        }
      }
      if (this.#subscribers.size === 0) this.close();
    }, HEARTBEAT_MS);
    // Never hold the process open for a heartbeat.
    this.#heartbeat.unref?.();
  }

  close(): void {
    if (this.#heartbeat) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = null;
    }
  }
}
