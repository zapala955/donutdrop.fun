import { createHmac } from 'node:crypto';

/**
 * duel-engine.ts — the rules of a 1v1 skill duel, with no database and no network in them.
 *
 * Everything here is a pure function of its arguments, which is what makes the fee arithmetic and
 * the anti-cheat verdicts testable without standing up Postgres or a socket.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE ONE THING THIS MODE GETS PAID FOR
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The house has no position in the outcome. It does not roll, it does not hold a side, and it
 * cannot lose — which also means it cannot win, and 0% of a skill result is exactly what it takes.
 * Its revenue is the rake on the pot of a duel it actually decided. If no winner is produced —
 * a draw, an abandonment, an expiry — both stakes go back whole and the house is paid nothing.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY REACTION TIME IS MEASURED ON THE CLIENT
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * This looks wrong and is not. If the server timed the reaction by its own clock — cue sent at
 * T, input received at T+n — then n is the player's reaction PLUS their round trip, and a duel
 * between a 20ms connection and a 200ms connection is decided by their ISPs before either player
 * moves. That is not a skill mode.
 *
 * So the cue fires at a wall-clock instant both clients are told in advance, each client measures
 * locally against that instant, and the number it reports is latency-free. The server's job is
 * not to produce that number but to BOUND it: see `judge` below, which refuses anything the
 * player's own arrival time proves they could not have done.
 *
 * That bound is real but it is not a proof. A modified client can report a plausible lie, and no
 * amount of server validation changes that, because the server cannot see the player's screen.
 * What is achievable is making a lie expensive and detectable: the cue schedule is committed and
 * unpredictable so it cannot be pre-programmed, superhuman times are refused outright, times that
 * contradict their own transport are refused, and `consistencySuspicion` gives the fraud pipeline
 * a variance signal across rounds that a human hand does not produce. Treat it as the deterrent
 * it is, not as proof of a human.
 */

export type DuelVariant = 'reflex' | 'precision' | 'sequence';
export type DuelVerdict = 'valid' | 'too_early' | 'too_late' | 'implausible';
export type DuelOutcome = 'decided' | 'draw' | 'forfeit' | 'expired';

/**
 * The floor on a human visual reaction.
 *
 * Simple-visual-stimulus reaction in a healthy adult sits around 200-250ms, and the literature
 * puts the hard physiological floor near 100ms — below that the signal has not finished crossing
 * the nervous system, so an input that fast was not a reaction to anything. Anything under this is
 * either a lucky pre-emptive press that happened to land after the cue, or a program.
 */
export const HUMAN_FLOOR_MS = 100;

/**
 * How far a reported time may sit in front of what its arrival can account for.
 *
 * A player reporting a 180ms reaction whose packet arrives 1.4s after the cue is claiming a
 * round trip of 1.2s. That is possible on a bad mobile connection, so the slack is generous; what
 * it catches is the other direction — a report that is FASTER than the transport could have
 * carried, which is physically impossible rather than merely unlikely.
 */
export const TRANSPORT_SLACK_MS = 2_500;

export interface DuelRules {
  /** How many rounds decide the duel. Odd, so a decided duel does not need a tiebreak. */
  readonly rounds: number;
  /** The window a player has to respond once a round begins, cue included. */
  readonly roundMs: number;
  /** Earliest and latest the cue may fire inside that window. */
  readonly cueMinMs: number;
  readonly cueMaxMs: number;
}

export const VARIANT_RULES: Readonly<Record<DuelVariant, DuelRules>> = Object.freeze({
  /* The cue may fire anywhere in an 800ms-4000ms spread. The spread is the whole defence: a fixed
   * delay is a metronome, and a metronome can be answered by a timer instead of a person. */
  reflex: Object.freeze({ rounds: 5, roundMs: 10_000, cueMinMs: 800, cueMaxMs: 4_000 }),
  /* The needle sweeps the full window and the target sits somewhere in the middle 70% of it, so
   * neither edge of the sweep is a free answer. */
  precision: Object.freeze({ rounds: 5, roundMs: 10_000, cueMinMs: 1_500, cueMaxMs: 8_500 }),
  /* Longer window: the player has to read a symbol order back, which is not a reaction. */
  sequence: Object.freeze({ rounds: 3, roundMs: 10_000, cueMinMs: 1_200, cueMaxMs: 2_400 }),
});

/* ═════════════════════════ the fee ═════════════════════════ */

export interface DuelSettlementMoney {
  /** Both stakes. */
  readonly potMinor: bigint;
  /** What the house keeps for producing a winner. */
  readonly rakeMinor: bigint;
  /** What the winner is credited. */
  readonly payoutMinor: bigint;
}

/**
 * Splits a decided duel's pot into the winner's payout and the house's rake.
 *
 * Integer arithmetic throughout, and the rake TRUNCATES, which means every rounding remainder goes
 * to the player rather than the house. Over a large number of small duels that is a real, if
 * tiny, cost — and it is the correct direction for it to fall, because the alternative is a
 * platform that rounds a fraction of a unit in its own favour a few million times a day.
 *
 * The payout is derived by subtraction rather than by a second multiplication, so pot and payout
 * and rake cannot drift apart the way two independently-rounded percentages do. The database
 * re-checks that identity in `duel_rake_adds_up`.
 */
export function splitPot(stakeMinor: bigint, rakeBps: number): DuelSettlementMoney {
  if (stakeMinor <= 0n) throw new Error('A duel stake must be positive');
  if (!Number.isInteger(rakeBps) || rakeBps < 0 || rakeBps > 1_000) {
    throw new Error('Duel rake must be an integer between 0 and 1000 bps');
  }
  const potMinor = stakeMinor * 2n;
  const rakeMinor = (potMinor * BigInt(rakeBps)) / 10_000n;
  return { potMinor, rakeMinor, payoutMinor: potMinor - rakeMinor };
}

/**
 * The house margin attributable to ONE player's stake, for rakeback and referral accrual.
 *
 * Those two engines are paid out of the margin a player generated, and every other game on the
 * platform derives that as `wager * houseEdgeBps`. A duel does not have a house edge, so that
 * derivation would invent a margin that was never collected. The real number is half the rake,
 * because the two players contributed the pot equally.
 *
 * Truncating again, and again in the player's favour is not the concern here — this one is paid
 * TO the player, so truncation favours the house by a rounding unit. That asymmetry is deliberate:
 * both roundings err toward not paying out money that was never collected.
 */
export function duelMarginPerPlayer(money: DuelSettlementMoney): bigint {
  return money.rakeMinor / 2n;
}

/* ═════════════════════════ the schedule ═════════════════════════ */

export interface RoundSchedule {
  readonly roundIndex: number;
  /** ms from the round's shared start at which the cue fires. */
  readonly cueOffsetMs: number;
  /** For 'precision', where the needle should be stopped. Null for the other variants. */
  readonly targetOffsetMs: number | null;
  /** For 'sequence', the symbol order to reproduce. Empty for the other variants. */
  readonly symbols: readonly number[];
}

/**
 * Derives one round's cue schedule from the committed server seed.
 *
 * Deterministic, so the reveal lets a player replay it and confirm the cue they were shown is the
 * cue the commitment promised. Unpredictable before the reveal, so it cannot be pre-programmed —
 * which is the only reason the reflex variant is a test of anything.
 *
 * Both players in a round get the SAME schedule. A duel where each side reacts to a different cue
 * is two solo tests being compared, not a contest.
 */
export function scheduleFor(
  serverSeed: string,
  variant: DuelVariant,
  roundIndex: number,
): RoundSchedule {
  const rules = VARIANT_RULES[variant];
  const digest = createHmac('sha256', serverSeed)
    .update(`duel:${variant}:${roundIndex}`)
    .digest();

  /* Two independent 32-bit draws out of one digest: one places the cue, one places the target.
   * Reading them from different offsets rather than hashing twice keeps this to one HMAC. */
  const cueDraw = digest.readUInt32BE(0);
  const targetDraw = digest.readUInt32BE(4);

  const span = rules.cueMaxMs - rules.cueMinMs;
  const cueOffsetMs = rules.cueMinMs + (cueDraw % (span + 1));

  let targetOffsetMs: number | null = null;
  if (variant === 'precision') {
    /* The middle 70% of the window. A target that can sit at either extreme makes "slam it
     * immediately" and "never press" into winning strategies on some rounds. */
    const low = Math.round(rules.roundMs * 0.15);
    const high = Math.round(rules.roundMs * 0.85);
    targetOffsetMs = low + (targetDraw % (high - low + 1));
  }

  const symbols: number[] = [];
  if (variant === 'sequence') {
    /* Four symbols out of six, drawn from successive bytes. Repeats are allowed: a sequence that
     * can never repeat leaks information about every position the player has already seen. */
    for (let index = 0; index < 4; index += 1) {
      symbols.push(digest[8 + index]! % 6);
    }
  }

  return { roundIndex, cueOffsetMs, targetOffsetMs, symbols: Object.freeze(symbols) };
}

/* ═════════════════════════ the verdict ═════════════════════════ */

export interface InputClaim {
  /** What the client says the player did, in ms from the round's shared start. */
  readonly reportedMs: number;
  /** When the server actually received it, same ms space. */
  readonly arrivedMs: number;
  /** For 'sequence', the order the player entered. Absent for the timing variants. */
  readonly symbols?: readonly number[] | undefined;
}

export interface Judgement {
  readonly verdict: DuelVerdict;
  /** Lower is better. Null unless the verdict is 'valid'. */
  readonly score: number | null;
}

/**
 * Decides whether one claimed input counts, and what it scored.
 *
 * The checks run cheapest-and-most-decisive first, and each one refuses a specific, nameable way
 * of not being a legitimate input:
 *
 *   too_late     — nothing arrived inside the window, or the claim itself is outside it.
 *   too_early    — the input predates the cue. Either a guess or a timer; both lose the round.
 *   implausible  — inside the window but not reachable: faster than a nervous system, or a report
 *                  its own arrival time contradicts.
 *
 * A refused input is not an error and does not interrupt the duel. It loses the round, which is
 * the correct consequence: throwing a 400 at a player who jumped the gun would turn a normal part
 * of the game into a failure dialog.
 */
export function judge(
  variant: DuelVariant,
  schedule: RoundSchedule,
  claim: InputClaim,
): Judgement {
  const rules = VARIANT_RULES[variant];

  if (!Number.isFinite(claim.reportedMs) || claim.reportedMs < 0) {
    return { verdict: 'implausible', score: null };
  }
  if (claim.reportedMs > rules.roundMs || claim.arrivedMs > rules.roundMs + TRANSPORT_SLACK_MS) {
    return { verdict: 'too_late', score: null };
  }
  /* A report cannot precede its own arrival by more than the transport could explain. This is the
   * check that makes the client-side measurement bounded rather than merely trusted: a client
   * claiming an impossibly fast time still has to get the packet here, and the packet's arrival
   * is measured by a clock it does not control. */
  if (claim.arrivedMs + TRANSPORT_SLACK_MS < claim.reportedMs) {
    return { verdict: 'implausible', score: null };
  }

  if (variant === 'sequence') {
    /* Not a reaction test, so the timing checks above are the only ones that apply. The score is
     * how many symbols were wrong, so lower stays better and the comparison below is uniform. */
    const entered = claim.symbols ?? [];
    let wrong = 0;
    for (let index = 0; index < schedule.symbols.length; index += 1) {
      if (entered[index] !== schedule.symbols[index]) wrong += 1;
    }
    return { verdict: 'valid', score: wrong };
  }

  if (variant === 'precision') {
    const target = schedule.targetOffsetMs ?? 0;
    /* Distance from the mark, in either direction. Stopping early and stopping late are the same
     * mistake and are scored the same. */
    return { verdict: 'valid', score: Math.abs(claim.reportedMs - target) };
  }

  // reflex
  if (claim.reportedMs < schedule.cueOffsetMs) {
    return { verdict: 'too_early', score: null };
  }
  const reaction = claim.reportedMs - schedule.cueOffsetMs;
  if (reaction < HUMAN_FLOOR_MS) {
    return { verdict: 'implausible', score: null };
  }
  return { verdict: 'valid', score: reaction };
}

/* ═════════════════════════ the result ═════════════════════════ */

export interface RoundResult {
  readonly roundIndex: number;
  readonly hostScore: number | null;
  readonly opponentScore: number | null;
}

export interface DuelResult {
  readonly outcome: DuelOutcome;
  /** 'host', 'opponent', or null on a draw. */
  readonly winner: 'host' | 'opponent' | null;
  readonly hostRounds: number;
  readonly opponentRounds: number;
}

/**
 * Counts rounds won and names the winner.
 *
 * Lower score wins every variant — reaction time, distance from the mark and wrong symbols are all
 * "less is better" — so one comparison covers all three rather than three that could disagree.
 *
 * A round where both sides were refused is nobody's: it is not awarded to the player who cheated
 * less. A round where exactly one side produced a valid input goes to that side, which is what
 * makes jumping the gun cost something.
 */
export function resolveDuel(rounds: readonly RoundResult[]): DuelResult {
  let hostRounds = 0;
  let opponentRounds = 0;

  for (const round of rounds) {
    const host = round.hostScore;
    const opponent = round.opponentScore;
    if (host === null && opponent === null) continue;
    if (opponent === null) { hostRounds += 1; continue; }
    if (host === null) { opponentRounds += 1; continue; }
    if (host < opponent) hostRounds += 1;
    else if (opponent < host) opponentRounds += 1;
    /* An exact tie on the millisecond is a genuine draw for that round and is awarded to neither.
     * It is rare enough not to matter and arbitrary enough that breaking it would be worse. */
  }

  if (hostRounds === opponentRounds) {
    return { outcome: 'draw', winner: null, hostRounds, opponentRounds };
  }
  return {
    outcome: 'decided',
    winner: hostRounds > opponentRounds ? 'host' : 'opponent',
    hostRounds,
    opponentRounds,
  };
}

/**
 * A variance signal for the fraud pipeline, not a verdict.
 *
 * Human reaction times scatter. Across five rounds a person produces a spread of tens of
 * milliseconds; a script producing a constant offset produces almost none. This returns the
 * population standard deviation of the valid scores, and a caller flags a duel for review when it
 * is implausibly tight — it does NOT refuse a payout on its own.
 *
 * That restraint is deliberate. The false positive here is a genuinely consistent player having
 * their winnings confiscated by a statistic, and a gambling platform that does that to real
 * players over a heuristic has done something much worse than let one cheater through.
 */
export function consistencySuspicion(scores: readonly number[]): number | null {
  const valid = scores.filter((score) => Number.isFinite(score));
  if (valid.length < 3) return null;
  const mean = valid.reduce((sum, score) => sum + score, 0) / valid.length;
  const variance = valid.reduce((sum, score) => sum + (score - mean) ** 2, 0) / valid.length;
  return Math.sqrt(variance);
}
