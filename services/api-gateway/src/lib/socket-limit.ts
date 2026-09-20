/**
 * socket-limit.ts — a token bucket for WebSocket frames.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY HTTP RATE LIMITING DOES NOT COVER THIS
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `@fastify/rate-limit` counts REQUESTS. A WebSocket is one request that then carries an unbounded
 * number of frames, so every socket on this platform was, until this file existed, a hole straight
 * through the limiter: one handshake, then as many JSON parses per second as the attacker's uplink
 * can push. `maxPayload` bounds how big a frame is, not how many arrive.
 *
 * The arena socket makes that worse in a way worth naming, because it is the one an attacker would
 * pick. `spectate` needs no ticket and no account — deliberately, the pit is public — so the flood
 * does not even need a login.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY A TOKEN BUCKET AND NOT A FIXED WINDOW
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A fixed window lets an attacker send the whole allowance in the last millisecond of one window
 * and the whole allowance again in the first millisecond of the next — two bursts back to back at
 * double the nominal rate. A bucket refills continuously, so the sustained rate is the rate and a
 * burst is bounded by the capacity regardless of when it starts.
 *
 * It is also the right shape for the thing being limited. Real input from a player arrives evenly
 * at the client's frame rate; a short burst after a stall is normal and should be absorbed rather
 * than punished, which is exactly what a bucket with capacity above the steady rate does.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * STATE LIVES ON THE SOCKET, NOT IN A MAP
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * One bucket per connection, held in the closure that owns the connection. Nothing to key, nothing
 * to evict, and no map that grows when sockets die in a way the cleanup path did not anticipate.
 * When the socket is collected so is its bucket.
 *
 * Refills are computed from a timestamp on read rather than by a timer, so an idle socket costs
 * nothing at all — no interval, no wakeup, no work proportional to the number of connections.
 */

export interface SocketBudget {
  /**
   * Spends one frame's worth of allowance.
   *
   * Returns false when the caller should ignore the frame. Ignoring is deliberate: replying with
   * an error to a flood doubles the traffic and hands the attacker an amplifier pointed back at
   * the server it is aimed at.
   */
  take(): boolean;
  /** How many frames have been refused. Read on close so a flood leaves a trace in the logs. */
  readonly refused: number;
}

export interface BudgetOptions {
  /** Sustained frames per second. */
  readonly ratePerSecond: number;
  /** Maximum burst. Never below `ratePerSecond`, or a normal second of traffic self-throttles. */
  readonly burst: number;
}

/**
 * Creates one token bucket.
 *
 * `burst` is clamped to at least `ratePerSecond` because a bucket that cannot hold one second of
 * tokens refuses ordinary traffic, and a limiter that fires on correct behaviour is one an
 * operator eventually raises past the point of usefulness.
 */
export function createSocketBudget({ ratePerSecond, burst }: BudgetOptions): SocketBudget {
  const capacity = Math.max(burst, ratePerSecond);
  let tokens = capacity;
  let lastRefillAt = Date.now();
  let refused = 0;

  return {
    take(): boolean {
      const now = Date.now();
      const elapsedMs = now - lastRefillAt;
      /* A clock that jumps backwards (NTP correction, container suspend) must not mint tokens or
       * freeze the bucket forever. Negative elapsed time simply refills nothing and resets the
       * mark, so the worst case is one slightly early refusal rather than a stuck connection. */
      if (elapsedMs > 0) {
        tokens = Math.min(capacity, tokens + (elapsedMs / 1000) * ratePerSecond);
      }
      lastRefillAt = now;
      if (tokens < 1) {
        refused += 1;
        return false;
      }
      tokens -= 1;
      return true;
    },
    get refused(): number {
      return refused;
    },
  };
}

/**
 * Frame budgets, per socket.
 *
 * Arena input is the only one that has to tolerate a real-time stream: the client sends at
 * INPUT_HZ (20), so the sustained rate matches that with headroom for a burst after a stall. A
 * player cannot benefit from sending faster — the server turns the snake at its own bounded rate
 * on its own tick — so this costs nothing a legitimate client would notice.
 *
 * Lobby sockets carry watch/unwatch and a ping. Nothing about them is real-time, and a client
 * sending ten frames a second to a lobby is not a client.
 */
export const LOBBY_SOCKET_BUDGET: BudgetOptions = { ratePerSecond: 10, burst: 20 };
