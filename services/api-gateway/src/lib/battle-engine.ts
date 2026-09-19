import { createHash, createHmac } from 'node:crypto';

/**
 * battle-engine.ts — the maths and the fairness of a Case Battle.
 *
 * Pure functions only. Nothing here touches the database, a socket or a clock, so every rule the
 * engine enforces can be tested directly rather than inferred from the behaviour of a live match.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHERE THE HOUSE EDGE COMES FROM
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * It comes from the crates, and from nowhere else.
 *
 * A battle's pot is the sum of what the reels ACTUALLY DROPPED, not the sum of what the players
 * staked. Every crate on the platform returns 90% of its price in expectation, so a battle
 * returns 90% of everything wagered into it — to exactly one winner instead of spread across the
 * table. The platform keeps the same 10% it would have kept had those players opened those crates
 * alone.
 *
 * That is why there is no rake here. Taking a percentage of the pot on top would charge the edge
 * twice, and the second charge would be invisible to a player reading the crate's published odds:
 * they would see 90% on the label and receive 81% in practice. The one number a gambling site
 * must never quietly contradict is the one it prints on the box.
 *
 * A consequence worth stating plainly: an individual battle can and will lose the house money,
 * because the pot is a sum of real outcomes rather than a fixed fraction. Over many battles it
 * converges on the crates' own 10%.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * PROVABLE FAIRNESS ACROSS SEVERAL PLAYERS
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * One battle, one server seed, committed as a hash the moment the lobby opens — before anybody
 * has joined, so the outcomes are fixed before a single client seed is known. Every player then
 * contributes their own entropy, and the seeds are combined in SEAT ORDER:
 *
 *     combined = SHA256(serverSeed + clientSeed[0] + clientSeed[1] + ... + nonce)
 *
 * Seat order, not join order or sorted order, because seat order is recorded on the battle row
 * and is therefore reproducible by anyone auditing it later. Every individual reel then derives
 * from that one combined seed:
 *
 *     digest(round, seat) = HMAC-SHA256(combined, "round:seat")
 *
 * which makes each reel independent, deterministic, and recomputable by any participant holding
 * the revealed server seed and the published client seeds. No player can steer the outcome:
 * changing your own client seed changes every reel in the battle, including your opponents', in a
 * way you cannot predict without the server seed you do not have.
 */

/** Seats are laid out team-major: team 0 takes the first `teamSize` seats, and so on. */
export interface BattleShape {
  readonly teamCount: number;
  readonly teamSize: number;
  readonly seatCount: number;
}

export type BattleMode = 'standard' | 'crazy';

/** The published game modes, as data rather than as a switch statement. */
export const BATTLE_MODES: readonly {
  readonly code: string;
  readonly label: string;
  readonly teamCount: number;
  readonly teamSize: number;
  readonly blurb: string;
}[] = [
  { code: '1v1', label: '1v1', teamCount: 2, teamSize: 1, blurb: 'Two players, one pot.' },
  { code: '1v1v1', label: '1v1v1', teamCount: 3, teamSize: 1, blurb: 'Three ways, winner takes all.' },
  { code: '1v1v1v1', label: '1v1v1v1', teamCount: 4, teamSize: 1, blurb: 'Four ways. Long odds, big pot.' },
  { code: '2v2', label: '2v2', teamCount: 2, teamSize: 2, blurb: 'Teams of two. Totals combine.' },
];

export const MIN_ROUNDS = 1;
export const MAX_ROUNDS = 10;

/** How long a lobby may sit unfilled before it is cancelled and every stake refunded. */
export const LOBBY_TTL_MS = 15 * 60 * 1000;

/** The animation clock. Both are shared by every client so the reels stay in lockstep. */
export const ROUND_MS = 6_000;
export const FAST_ROUND_MS = 2_400;

/**
 * Lead time between announcing the start and the first reel moving.
 *
 * The whole synchronisation design rests on this. Rather than streaming animation frames, the
 * server settles every round up front and broadcasts one message carrying the outcomes and a
 * wall-clock start time slightly in the future. Each client then animates locally against that
 * shared timestamp, so nothing about the animation depends on when a message happened to arrive.
 * A player on a slow connection sees the same reel land at the same instant as everyone else,
 * because the only thing the network had to deliver in time was a number.
 *
 * Two and a half seconds is enough for a bad mobile connection to receive the payload and decode
 * its sprites before the first spin begins.
 */
export const START_LEAD_MS = 2_500;

export function shapeFor(modeCode: string): BattleShape {
  const found = BATTLE_MODES.find((entry) => entry.code === modeCode);
  if (!found) throw new RangeError(`unknown battle format: ${modeCode}`);
  return {
    teamCount: found.teamCount,
    teamSize: found.teamSize,
    seatCount: found.teamCount * found.teamSize,
  };
}

/** Which team a seat belongs to. Team-major layout, so this is integer division. */
export function teamForSeat(seat: number, teamSize: number): number {
  if (!Number.isInteger(seat) || seat < 0) throw new RangeError('seat must be a non-negative integer');
  if (!Number.isInteger(teamSize) || teamSize < 1) throw new RangeError('teamSize must be >= 1');
  return Math.floor(seat / teamSize);
}

/**
 * The combined seed: the server's commitment plus every player's entropy.
 *
 * @param serverSeed  64 hex characters, revealed only after settlement
 * @param clientSeeds one per seat, IN SEAT ORDER — the order is part of the definition
 * @param nonce       the battle's nonce, allowing a seed to be reused across battles safely
 */
export function combineSeeds(
  serverSeed: string,
  clientSeeds: readonly string[],
  nonce: number,
): string {
  if (!/^[a-f0-9]{64}$/.test(serverSeed)) {
    throw new TypeError('serverSeed must be 32 bytes of lowercase hex');
  }
  if (clientSeeds.length === 0) throw new RangeError('a battle needs at least one client seed');
  if (!Number.isSafeInteger(nonce) || nonce < 0) {
    throw new RangeError('nonce must be a non-negative safe integer');
  }
  for (const seed of clientSeeds) {
    const bytes = Buffer.byteLength(seed, 'utf8');
    if (bytes < 1 || bytes > 128) {
      throw new TypeError('every client seed must contain 1-128 UTF-8 bytes');
    }
    for (const character of seed) {
      const code = character.codePointAt(0) ?? 0;
      if (code <= 31 || code === 127) {
        throw new TypeError('client seeds must not contain control characters');
      }
    }
  }

  const hash = createHash('sha256');
  hash.update(serverSeed, 'utf8');
  for (const seed of clientSeeds) hash.update(seed, 'utf8');
  hash.update(String(nonce), 'utf8');
  return hash.digest('hex');
}

/**
 * The digest for one reel.
 *
 * Keyed by the combined seed and labelled by position, so the same battle never produces the same
 * digest twice and every reel is independent of every other.
 */
export function reelDigest(combinedSeed: string, roundIndex: number, seat: number): string {
  if (!/^[a-f0-9]{64}$/.test(combinedSeed)) {
    throw new TypeError('combinedSeed must be 32 bytes of lowercase hex');
  }
  if (!Number.isInteger(roundIndex) || roundIndex < 0) {
    throw new RangeError('roundIndex must be a non-negative integer');
  }
  if (!Number.isInteger(seat) || seat < 0) throw new RangeError('seat must be a non-negative integer');

  return createHmac('sha256', combinedSeed)
    .update(`${roundIndex}:${seat}`, 'utf8')
    .digest('hex');
}

/**
 * Maps a digest onto a position in a crate's weight table.
 *
 * Identical to the single-player path in routes/cases.ts, deliberately: a battle reel and a solo
 * open must be the same draw from the same distribution, or the crate's published odds would mean
 * two different things depending on where it was opened.
 */
export function digestToRollWeight(digest: string, totalWeight: bigint): bigint {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new RangeError('digest must be 64 hex characters');
  if (totalWeight <= 0n) throw new RangeError('totalWeight must be positive');
  return (BigInt(`0x${digest}`) * totalWeight) >> 256n;
}

export interface SeatTotal {
  readonly seat: number;
  readonly team: number;
  readonly totalDropMinor: bigint;
}

export interface BattleOutcome {
  /** The team that takes the pot. */
  readonly winningTeam: number;
  /** Seats on the winning team, in seat order. */
  readonly winningSeats: readonly number[];
  /** Total of every drop across every reel — the pot. */
  readonly potMinor: bigint;
  /** What each winning seat receives. Sums exactly to potMinor. */
  readonly payouts: ReadonlyMap<number, bigint>;
  /** Per-team totals, for the scoreboard. */
  readonly teamTotals: ReadonlyMap<number, bigint>;
}

/**
 * Decides a battle and splits the pot.
 *
 * `crazy` inverts the comparison: the LOWEST team total wins. It is a genuinely different game
 * rather than a reskin — under crazy rules a player wants the cheap drops, which makes a
 * high-variance crate a liability instead of a prize — but the economics are identical, because
 * the pot is the same sum of the same drops either way.
 *
 * Ties are split evenly among the tied teams' seats. A tie is rare but not impossible (two seats
 * drawing the same item from the same crate list is entirely reachable at low round counts), and
 * leaving it undefined would mean a pot that either vanishes or pays twice.
 */
export function resolveBattle(
  seatTotals: readonly SeatTotal[],
  mode: BattleMode,
  botSeats: ReadonlySet<number> = new Set(),
): BattleOutcome {
  if (seatTotals.length === 0) throw new RangeError('a battle needs at least one seat');

  const teamTotals = new Map<number, bigint>();
  let potMinor = 0n;
  for (const entry of seatTotals) {
    potMinor += entry.totalDropMinor;
    teamTotals.set(entry.team, (teamTotals.get(entry.team) ?? 0n) + entry.totalDropMinor);
  }

  /* EVERY team competes, bots included.
   *
   * This used to narrow the comparison to teams carrying at least one human, on the reasoning that
   * a bot stakes nothing and so cannot be paid. That is true of PAYING a bot and false of letting
   * one WIN, and conflating the two made a bot battle unloseable: in a 1v1 the human was the only
   * team in the comparison, so they won whatever either side rolled, and took a pot that their own
   * entry had funded only half of. Against three bots it paid four reels for one entry. The comment
   * that used to sit here claimed this was "a real contest rather than a free win"; it was exactly
   * a free win, and a repeatable one.
   *
   * A bot team can now win. When it does nobody is paid and the house keeps the pot, which is what
   * happens on every other losing wager on this platform. */
  if (!seatTotals.some((entry) => !botSeats.has(entry.seat))) {
    throw new RangeError('a battle needs at least one human seat');
  }

  let best: bigint | null = null;
  for (const team of teamTotals.keys()) {
    const total = teamTotals.get(team) ?? 0n;
    if (best === null) best = total;
    else if (mode === 'crazy' ? total < best : total > best) best = total;
  }

  const winners = [...teamTotals.keys()].filter((team) => (teamTotals.get(team) ?? 0n) === best);
  const winningTeam = winners[0] ?? 0;

  /* Only human seats on a winning team are paid. A 2v2 with one bot partner pays the whole team
   * share to the human, rather than burning half of it. */
  const winningSeats = seatTotals
    .filter((entry) => winners.includes(entry.team) && !botSeats.has(entry.seat))
    .map((entry) => entry.seat)
    .sort((left, right) => left - right);

  /* Integer division leaves a remainder that has to go somewhere, or the pot does not balance.
   * It goes to the earliest seat — an arbitrary but DETERMINISTIC rule, which is the property
   * that matters: the same battle settles the same way however many times it is recomputed. */
  const payouts = new Map<number, bigint>();
  if (winningSeats.length > 0) {
    const share = potMinor / BigInt(winningSeats.length);
    const remainder = potMinor - share * BigInt(winningSeats.length);
    winningSeats.forEach((seat, index) => {
      payouts.set(seat, index === 0 ? share + remainder : share);
    });
  }

  /* The pot is paid out in full, or not at all.
   *
   * "Not at all" is the bot-wins case: there is no human on the winning team, so the stakes stay
   * with the house exactly as they do when a player loses any other wager. Every other case must
   * still balance to the penny — that check is what stops a battle minting money or losing it, and
   * relaxing it into an inequality would have quietly permitted both. */
  const paid = [...payouts.values()].reduce((sum, value) => sum + value, 0n);
  const expected = winningSeats.length > 0 ? potMinor : 0n;
  if (paid !== expected) {
    throw new Error(`battle payout ${paid} does not balance against an expected ${expected}`);
  }

  return { winningTeam, winningSeats, potMinor, payouts, teamTotals };
}

/**
 * The wall-clock schedule every client animates against.
 *
 * Returned as absolute epoch milliseconds rather than as offsets, so a client that joins late —
 * or reconnects mid-battle — lands on exactly the right reel by comparing against its own clock
 * instead of replaying from the beginning.
 */
export function roundSchedule(
  startsAt: number,
  roundCount: number,
  fast: boolean,
): { readonly startsAt: number; readonly roundMs: number; readonly endsAt: number } {
  if (!Number.isFinite(startsAt)) throw new RangeError('startsAt must be a finite timestamp');
  if (!Number.isInteger(roundCount) || roundCount < MIN_ROUNDS || roundCount > MAX_ROUNDS) {
    throw new RangeError(`roundCount must be between ${MIN_ROUNDS} and ${MAX_ROUNDS}`);
  }
  const roundMs = fast ? FAST_ROUND_MS : ROUND_MS;
  return { startsAt, roundMs, endsAt: startsAt + roundMs * roundCount };
}

/** A short, unambiguous lobby code. No vowels, so it cannot spell anything. */
const CODE_ALPHABET = '23456789BCDFGHJKLMNPQRSTVWXZ';

export function battleCodeFrom(bytes: Buffer, length = 8): string {
  if (bytes.length < length) throw new RangeError('not enough entropy for a battle code');
  let code = '';
  for (let index = 0; index < length; index += 1) {
    code += CODE_ALPHABET[(bytes[index] ?? 0) % CODE_ALPHABET.length];
  }
  return code;
}

/**
 * A stable UUID derived from a namespace and its parts.
 *
 * The wallet ledger is keyed `UNIQUE (kind, reference_id)` and reference_id is a uuid column, so
 * idempotency depends on the SAME logical event always producing the SAME id. A random uuid would
 * satisfy the column and defeat the constraint: a retried settlement would mint a second, equally
 * valid row and pay the pot twice.
 *
 * Derived rather than stored, so nothing has to be looked up before a payment can be made
 * idempotent. Shaped as a v5-style name-based UUID: SHA-256 of the joined parts, first 16 bytes,
 * with the version and variant bits set so the value is a well-formed UUID rather than arbitrary
 * hex that happens to fit.
 */
export function deterministicUuid(namespace: string, ...parts: (string | number)[]): string {
  const digest = createHash('sha256')
    .update(`${namespace}:${parts.join(':')}`, 'utf8')
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  // Version 5 (name-based, SHA-1 by the spec; SHA-256 here, which is strictly stronger).
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  // RFC 4122 variant.
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
