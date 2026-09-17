import { SocketHub, type HubLifecycleEvent, type Subscriber } from './socket-hub.js';

/**
 * slither-hub.ts — the arena's event vocabulary.
 *
 * Same transport as battles and duels (socket-hub.ts), a third problem again.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS ONE PUSHES STATE AND THE OTHER TWO PUSH EVENTS
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A case battle sends one message containing every outcome. A duel sends a handful of messages
 * around a decision. The arena has no decision and no outcome — it has a POSITION, for everybody,
 * twenty times a second, and the only thing a client can do with a position is draw it.
 *
 * So `arena:state` is a snapshot, not a delta, and it is deliberately not a complete one: each
 * socket is sent what its own player can see. That is a bandwidth decision second and an anti-cheat
 * decision first. A client handed the whole pit is a client whose modified build can draw the snake
 * creeping up behind it through the fog, and in a mode where being seen first is the entire game
 * that is not a minor advantage, it is the advantage.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THE CLIENT IS ALLOWED TO SAY BACK
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Three fields: a heading, a boost flag and an extract flag. Nothing else is read. The client never
 * reports a position, a speed, a pickup or a kill, because every one of those is a claim about
 * money and a client that could make one could make a better one. The server simulates, the client
 * steers.
 *
 * `arena:hit` and `arena:cashout` exist so the browser can play a sound and show a number the same
 * frame the server decided it, rather than inferring a death from a snake that stopped appearing in
 * snapshots. They carry no authority — the money has already moved by the time they are sent.
 */

/** One snake, as another player is allowed to see it. */
export interface ArenaSnakeView {
  readonly id: string;
  readonly name: string;
  /**
   * The visible body, as one or more polylines of flattened [x0, y0, x1, y1, ...], head first and
   * rounded to whole units.
   *
   * A list of runs rather than a single path because points outside the viewer's circle are culled
   * from the frame — and a culled point in the middle of one array is a line the client would draw
   * straight across the screen between the two ends of a snake that actually went round behind it.
   * Splitting at the gap makes the omission unrepresentable instead of merely unlikely.
   */
  readonly paths: readonly (readonly number[])[];
  readonly radius: number;
  /** Stake-scaled glow intensity. 0 at the minimum entry, 1 at the maximum, higher when fed. */
  readonly aura: number;
  /** Gross value carried. This is what the HUD and the leaderboard print. */
  readonly valueMinor: string;
  readonly boosting: boolean;
  /** 0..1 progress through the three-second extraction channel. */
  readonly extracting: number;
  readonly isYou: boolean;
}

export interface ArenaOrbView {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly valueMinor: string;
  readonly kind: 'boost' | 'death';
}

export interface ArenaLeaderView {
  readonly name: string;
  readonly valueMinor: string;
  /** Carrying at least what they bought in with — that is, they can walk away up. */
  readonly extractable: boolean;
  readonly isYou: boolean;
}

export type SlitherEvent =
  /**
   * Accepted into the pit. Sent once, to the owning socket only, immediately after the entry
   * ticket is verified — which is the only frame in this vocabulary that carries a session id.
   * Everything broadcast uses the public id instead, so knowing who is on the board never tells
   * you the token that identifies their money.
   */
  | {
      readonly type: 'arena:entered';
      readonly sessionId: string;
      /** The id this snake wears in every snapshot, so the client can recognise itself at once. */
      readonly publicId: string;
      readonly entryMinor: string;
      readonly arenaRadius: number;
      readonly tickHz: number;
      readonly extractSeconds: number;
    }
  /** The world, as this socket may see it. Twenty a second. */
  | {
      readonly type: 'arena:state';
      readonly tick: number;
      readonly you: ArenaSnakeView | null;
      readonly snakes: readonly ArenaSnakeView[];
      readonly orbs: readonly ArenaOrbView[];
      /** Gate centres in radians, for the perimeter markers. Rotate slowly and predictably. */
      readonly gates: readonly number[];
      readonly leaders: readonly ArenaLeaderView[];
      readonly players: number;
      /**
       * Where a SPECTATOR should point its camera, as [x, y].
       *
       * Absent for a player, who has a `you` to follow. Present for a spectator, who does not: it
       * is the position of whoever is carrying the most, or the middle of an empty pit. Sent rather
       * than derived, so every spectator is watching the same thing.
       */
      readonly focus?: readonly number[];
    }
  /** Somebody died. Sent to the whole pit so the floor lighting up has a cause. */
  | {
      readonly type: 'arena:hit';
      /** Public ids. A client recognises itself by comparing against the id in its own `you`. */
      readonly victim: string;
      readonly killer: string | null;
      readonly droppedMinor: string;
    }
  /**
   * A player left with their money.
   *
   * `creditedMinor` is what reached the wallet. It is the only figure sent, and there is no fee
   * field beside it on purpose — the platform's cut is applied on the server and the client is
   * given a cash number, not an invoice.
   */
  | {
      readonly type: 'arena:cashout';
      /** The PUBLIC id, as it appears in snapshots. The session id is never broadcast. */
      readonly id: string;
      readonly name: string;
      readonly creditedMinor: string;
    }
  /** Your snake is off the board, with the reason. Terminal for this socket's session. */
  | {
      readonly type: 'arena:over';
      readonly reason: 'killed' | 'wall' | 'abandoned' | 'cashed_out';
      readonly creditedMinor: string;
    }
  | HubLifecycleEvent;

export class SlitherHub extends SocketHub<SlitherEvent> {}

export type SlitherSubscriber = Subscriber;
