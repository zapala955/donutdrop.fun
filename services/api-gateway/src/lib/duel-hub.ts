import { SocketHub, type HubLifecycleEvent, type Subscriber } from './socket-hub.js';

/**
 * duel-hub.ts — the skill-duel event vocabulary.
 *
 * Same transport as battles (socket-hub.ts), different problem.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS ONE CANNOT SETTLE UP FRONT, AND WHAT IT BORROWS INSTEAD
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A case battle sends one message containing every outcome, because the outcomes exist the moment
 * the server rolls them. A duel's outcome does not exist yet — it depends on two inputs that have
 * not happened — so there is genuinely a round trip per round and no way to avoid one.
 *
 * What it borrows is the shared timestamp, and that turns out to be the important half.
 * `duel:round` carries `startsAt`, a wall-clock instant a beat in the future. Both clients open
 * the round at that instant rather than on arrival, so a player on a 200ms connection and a player
 * on a 20ms connection start the same round at the same moment. Each then measures its own
 * player's reaction locally against that instant and reports a latency-free number.
 *
 * Without it, `now - messageReceived` would measure reaction PLUS round trip, and the duel would
 * be decided by whose ISP is closer to the datacentre. See duel-engine.ts `judge` for the bound
 * that keeps the locally-measured number honest.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT IS NOT SENT
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The cue offset is NOT in `duel:round`. If it were, a modified client would know exactly when
 * the cue fires before it fires, which is the entire game. The round message says only when the
 * round starts and how long it lasts; the cue itself arrives as `duel:cue` at the moment it is
 * due, and the schedule that produced it is proven honest afterwards by the seed reveal.
 *
 * An opponent's score for a round is likewise withheld until both sides have answered or the
 * window has closed — otherwise the second player to act knows the number they have to beat.
 */

export type DuelEvent =
  /* lobby list */
  | { readonly type: 'duel:created'; readonly duel: unknown }
  | { readonly type: 'duel:updated'; readonly duel: unknown }
  | { readonly type: 'duel:removed'; readonly code: string }
  /* a match */
  | { readonly type: 'duel:joined'; readonly code: string; readonly duel: unknown }
  | {
      readonly type: 'duel:round';
      readonly code: string;
      readonly roundIndex: number;
      /** Wall clock. Both clients open the round here, not on arrival. */
      readonly startsAt: number;
      readonly roundMs: number;
      /** For 'sequence' only: the order to memorise. Empty for the timing variants. */
      readonly symbols: readonly number[];
    }
  /* Sent when the cue is due. Deliberately not bundled into duel:round — see the header. */
  | { readonly type: 'duel:cue'; readonly code: string; readonly roundIndex: number; readonly at: number }
  /* Both sides have answered this round, so the scores can be shown. */
  | {
      readonly type: 'duel:scored';
      readonly code: string;
      readonly roundIndex: number;
      readonly hostScore: number | null;
      readonly opponentScore: number | null;
      readonly hostVerdict: string;
      readonly opponentVerdict: string;
      readonly hostRounds: number;
      readonly opponentRounds: number;
    }
  | { readonly type: 'duel:settled'; readonly code: string; readonly duel: unknown }
  | { readonly type: 'duel:cancelled'; readonly code: string; readonly reason: string }
  | HubLifecycleEvent;

export class DuelHub extends SocketHub<DuelEvent> {}

export type DuelSubscriber = Subscriber;
