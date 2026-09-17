import { SocketHub, type HubLifecycleEvent, type Subscriber } from './socket-hub.js';

/**
 * battle-hub.ts — the case-battle event vocabulary.
 *
 * The transport underneath this moved to socket-hub.ts when skill duels needed the same registry;
 * see that file for why it is shared rather than copied. What stays here is the part that is
 * actually about battles: the set of messages a battle can send, and the reason there are so few
 * of them.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THERE IS NO PER-FRAME TRAFFIC
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The obvious way to synchronise four spinning reels is to stream their positions. It is also the
 * wrong way: every client would render at the mercy of its own latency, and the reels would drift
 * apart by exactly as much as the network jitter between the players.
 *
 * So nothing here streams. The server settles the entire battle up front and sends ONE message
 * containing every outcome and a wall-clock timestamp a couple of seconds in the future. Each
 * client then animates locally against that shared timestamp. The only thing the network has to
 * deliver on time is a number, and a client that receives it 400ms late simply starts its
 * animation 400ms further along — landing on the same reel at the same instant as everyone else.
 *
 * That design has a second benefit that matters more in practice than the first: a player who
 * reloads mid-battle recovers perfectly. They fetch the battle, get the same outcomes and the
 * same start time, compare against their own clock and drop straight into the correct round.
 *
 * A skill duel cannot use that trick — its outcome depends on input that has not happened yet —
 * but it borrows the shared-timestamp half of it. See duel-hub.ts.
 */

export type BattleEvent =
  | { readonly type: 'lobby:created'; readonly battle: unknown }
  | { readonly type: 'lobby:updated'; readonly battle: unknown }
  | { readonly type: 'lobby:removed'; readonly code: string }
  | { readonly type: 'battle:seat'; readonly code: string; readonly battle: unknown }
  | { readonly type: 'battle:start'; readonly code: string; readonly battle: unknown }
  | { readonly type: 'battle:speed'; readonly code: string; readonly fast: boolean; readonly startsAt: number; readonly roundMs: number }
  | { readonly type: 'battle:settled'; readonly code: string; readonly battle: unknown }
  | { readonly type: 'battle:cancelled'; readonly code: string; readonly reason: string }
  | HubLifecycleEvent;

export class BattleHub extends SocketHub<BattleEvent> {}

export type BattleSubscriber = Subscriber;
