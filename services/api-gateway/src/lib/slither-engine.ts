/**
 * slither-engine.ts — the rules of the arena, with no database and no network in them.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THE SIMULATION LIVES ON THE SERVER AND NOTHING ELSE DOES
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A client in this mode is allowed to say exactly two things: which way it wants to point, and
 * whether it is holding boost. It never says where it is, how fast it went, what it ate, or who
 * it killed — every one of those is a money statement, and a client that could make one could
 * make a better one. So the whole simulation runs here, at a fixed tick, and the browser receives
 * positions it had no hand in computing.
 *
 * That choice is what makes the rest of the file look the way it does. The step function is
 * deterministic, takes a fixed timestep, and has no clock in it: given the same arena and the same
 * inputs it produces the same tick every time, on any machine, which is the property that makes a
 * disputed kill something you can replay rather than something you argue about.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THERE IS NO RANDOMNESS IN THE MONEY PATH, SO THERE IS NOTHING TO COMMIT TO
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Crates and duels ship a hashed server seed because something unpredictable decides part of the
 * result — a drop, a cue offset. Nothing unpredictable decides anything here. Spawn points are
 * chosen by a rule (the lattice point furthest from every live snake, lowest index wins a tie),
 * cashout gates rotate on a fixed rate off the tick counter, and the only place a pseudo-random
 * number appears at all is the ANGLE orbs scatter at when a snake dies — which changes where the
 * money lands by a few metres and cannot change how much of it there is.
 *
 * That is a stronger claim than a commitment, not a weaker one: a seed you must trust us to have
 * fixed in advance is replaced by arithmetic you can re-run. Even the scatter is derived from the
 * session id and the tick, so it too replays.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * MONEY IS bigint AND GEOMETRY IS number, ALWAYS, AND THEY NEVER MEET
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Position, heading and radius are floats because they are physics. Value is bigint because it is
 * money and a double stops representing whole dollars exactly somewhere below the maximum stake
 * multiplied by a lucky evening. The single bridge between the two worlds is `sizeFor`, which
 * reads a value and returns a shape — one direction, never the other. Nothing in this file ever
 * computes a payout from a float.
 */

/* ═════════════════════════ the constants the mode is balanced on ═════════════════════════ */

/** Twenty ticks a second. Every duration in this file is expressed in ticks, not milliseconds. */
export const TICK_HZ = 20;
export const TICK_MS = 1000 / TICK_HZ;
const DT = 1 / TICK_HZ;

/** The pit is a disc. Touching the edge anywhere that is not a gate kills you. */
export const ARENA_RADIUS = 3600;

/**
 * The entry band, and it is not configuration.
 *
 * The whole mode is balanced around a snake whose size is a logarithmic interpolation between
 * these two numbers: $1M is the compact, fast, agile end and $100M is the leviathan. A stake
 * outside the band has no defined shape, which is why the database carries the same two figures as
 * a CHECK constraint rather than trusting whatever configuration happened to be loaded.
 */
export const MIN_ENTRY_MINOR = 1_000_000n;
export const MAX_ENTRY_MINOR = 100_000_000n;

/** Spacing between stored trail points, in world units. The body is drawn along this path. */
const SEGMENT_STEP = 11;

/** Boost costs 0.5% of current value per second, which at 20Hz is 25 parts in 100 000 per tick. */
const BOOST_DRAIN_NUMERATOR = 25n;
const BOOST_DRAIN_DENOMINATOR = 100_000n;
/**
 * The same rate as basis points per second, for quoting to a player before they buy in.
 *
 * Derived from the two figures above rather than written out again, so the number on the entry
 * screen cannot drift away from the number the simulation actually charges. 25/100000 per tick at
 * 20 ticks a second is 0.5% a second, which is 50 bps.
 */
export const BOOST_BURN_BPS_PER_SECOND =
  Number(BOOST_DRAIN_NUMERATOR) * TICK_HZ * (10_000 / Number(BOOST_DRAIN_DENOMINATOR));
export const BOOST_SPEED_MULTIPLIER = 1.5;

/**
 * Boost stops working below this, rather than eating the snake down to nothing.
 *
 * A value of zero has no size — `sizeFor` interpolates on a logarithm and a logarithm of zero is
 * not a snake. Rather than clamp the shape and let a player ride a free zero-mass rocket, boost
 * simply stops responding here. It is also the floor that makes the drain honest: with a minimum
 * drain of one unit per tick, a snake that could boost at any value would reach zero eventually
 * for free.
 */
export const BOOST_FLOOR_MINOR = 250_000n;

/** Extraction takes three seconds of holding a straight line. See `EXTRACT_TICKS`. */
export const EXTRACT_SECONDS = 3;
export const EXTRACT_TICKS = EXTRACT_SECONDS * TICK_HZ;

/**
 * How far off a straight line a channelling snake may drift before the channel breaks, per tick.
 *
 * This is the whole cost of extracting, and it is a social cost rather than a mechanical one:
 * holding a line for three seconds in a pit full of people means announcing exactly where you will
 * be for three seconds. Boosting breaks it too — you do not get to leave at speed.
 */
const EXTRACT_MAX_TURN_PER_TICK = 0.035;

/** Four gates, rotating slowly, so the way out is never in the same place twice. */
export const GATE_COUNT = 4;
const GATE_HALF_WIDTH_RAD = 0.15;
const GATE_ROTATION_RAD_PER_SEC = 0.055;
/** A gate is a band of the wall, not a line on it: the inner edge is this far in. */
const GATE_INNER_RADIUS = ARENA_RADIUS - 70;

/** How long a disconnected snake keeps playing before the floor takes it. */
export const ABANDON_GRACE_TICKS = 6 * TICK_HZ;

/**
 * The floor is bounded. When it is full the oldest orb is merged into its nearest neighbour, which
 * moves money a few metres and never creates or destroys any of it.
 */
const MAX_ORBS = 1200;

/** Broadphase cell size. Comfortably larger than the biggest head, which is what makes 3x3 enough. */
const GRID_CELL = 120;

/**
 * Trail capacity, fixed for every snake regardless of what it paid to get in.
 *
 * `sizeFor` clamps its interpolation at 1.35, so this is genuinely the longest body the mode can
 * produce however much a snake eats. Allocating it up front means a snake that doubles its value
 * mid-chase does not reallocate its own hitbox on the tick it is being chased.
 */
const MAX_TRAIL_POINTS = 216;

/* ═════════════════════════ shape ═════════════════════════ */

export interface SnakeShape {
  /** Body and head radius in world units. */
  readonly radius: number;
  /** Trail points retained. Multiplied by SEGMENT_STEP this is the body length. */
  readonly points: number;
  /** Units per second, unboosted. */
  readonly speed: number;
  /** Radians per second the heading may change. */
  readonly turnRate: number;
  /** 0 at the minimum stake, 1 at the maximum, above 1 for a snake that has eaten well. */
  readonly aura: number;
}

const LOG_MIN = Math.log(Number(MIN_ENTRY_MINOR));
const LOG_SPAN = Math.log(Number(MAX_ENTRY_MINOR)) - LOG_MIN;

/**
 * Value to body, on a logarithm.
 *
 * Linear interpolation was the obvious first attempt and it is wrong by two orders of magnitude:
 * $100M is a hundred times $1M, so a linear map makes every stake below about $20M render as the
 * same indistinguishable minimum worm while the top of the band is a continent. On a logarithm the
 * band spreads evenly — $10M sits halfway between the two ends, which is where a player who has
 * staked $10M expects to find themselves.
 *
 * `aura` is allowed past 1. A $100M snake that eats another $100M is genuinely bigger than the
 * largest thing anyone can buy, and the client draws that; the physical figures are clamped at
 * 1.35 so a whale is frightening rather than unplayable.
 */
export function sizeFor(valueMinor: bigint): SnakeShape {
  const value = Number(valueMinor > 0n ? valueMinor : 1n);
  const aura = (Math.log(value) - LOG_MIN) / LOG_SPAN;
  const t = Math.max(0, Math.min(1.35, aura));
  return {
    radius: 13 + 31 * t,
    points: Math.round(30 + 132 * t),
    // Big is slow and small is nimble, which is the only thing stopping the largest snake in the
    // pit from simply running everyone else down.
    speed: 236 - 74 * t,
    turnRate: 4.5 - 2.4 * t,
    aura,
  };
}

/* ═════════════════════════ money ═════════════════════════ */

export interface Extraction {
  readonly grossMinor: bigint;
  readonly feeMinor: bigint;
  readonly creditedMinor: bigint;
}

/**
 * Splits an extraction into the platform's cut and the player's credit.
 *
 * Integer division truncates, which rounds in the player's favour on every partial unit. That is
 * deliberate and matches every other settlement on the platform: the house never gains from a
 * rounding it chose the direction of.
 */
export function splitExtraction(grossMinor: bigint, feeBps: number): Extraction {
  if (grossMinor < 0n) throw new Error('Refusing to extract a negative value');
  const feeMinor = (grossMinor * BigInt(feeBps)) / 10_000n;
  return { grossMinor, feeMinor, creditedMinor: grossMinor - feeMinor };
}

/** The margin an entry is expected to generate, for the rakeback and referral engines. */
export function expectedMarginMinor(entryMinor: bigint, feeBps: number): bigint {
  return (entryMinor * BigInt(feeBps)) / 10_000n;
}

/** Whether a buy-in is inside the band. Enforced here, in the route, and in the schema. */
export function entryIsLegal(entryMinor: bigint): boolean {
  return entryMinor >= MIN_ENTRY_MINOR && entryMinor <= MAX_ENTRY_MINOR;
}

/* ═════════════════════════ the trail ═════════════════════════ */

/**
 * A snake's body, as a ring buffer of points with the head at the newest end.
 *
 * It is a ring rather than an array with `shift()` because this is touched every tick by every
 * snake in the pit: `shift()` is O(n) and re-homes every point in the body forty times a second
 * for no reason. The capacity is the largest body the mode allows, so a snake that grows never
 * reallocates mid-match.
 */
export class Trail {
  readonly #xs: Float64Array;
  readonly #ys: Float64Array;
  readonly #capacity: number;
  #head = 0;
  #count = 0;

  constructor(capacity: number) {
    this.#capacity = capacity;
    this.#xs = new Float64Array(capacity);
    this.#ys = new Float64Array(capacity);
  }

  get length(): number {
    return this.#count;
  }

  push(x: number, y: number, keep: number): void {
    this.#head = (this.#head + 1) % this.#capacity;
    this.#xs[this.#head] = x;
    this.#ys[this.#head] = y;
    this.#count = Math.min(this.#count + 1, Math.min(keep, this.#capacity));
  }

  /** Drops the oldest points until at most `keep` remain. Used when a snake shrinks. */
  trim(keep: number): void {
    this.#count = Math.max(0, Math.min(this.#count, keep));
  }

  /** Index 0 is the head; higher indices run back toward the tail. */
  x(index: number): number {
    return this.#xs[this.#wrap(index)] as number;
  }

  y(index: number): number {
    return this.#ys[this.#wrap(index)] as number;
  }

  #wrap(index: number): number {
    const raw = (this.#head - index) % this.#capacity;
    return raw < 0 ? raw + this.#capacity : raw;
  }
}

/* ═════════════════════════ entities ═════════════════════════ */

/* Only deaths put anything on the floor now. Boosting used to drop its drain here too, which
 * meant a player could grow by hoovering up what other people shed — money gained without a kill.
 * The kind is kept as a union of one rather than deleted so the wire shape and the renderer's
 * switch stay honest about what an orb is. */
export type OrbKind = 'death';

export interface Orb {
  readonly id: number;
  x: number;
  y: number;
  valueMinor: bigint;
  readonly kind: OrbKind;
  /** The tick it landed. Only used to decide which orb merges away when the floor is full. */
  readonly bornTick: number;
}

export type DeathCause = 'body' | 'wall' | 'abandoned';

export interface Snake {
  /** The slither_sessions row id. Stable for the whole life of this snake. */
  readonly sessionId: string;
  readonly userId: string;
  readonly name: string;
  readonly entryMinor: bigint;
  readonly feeBps: number;

  x: number;
  y: number;
  heading: number;
  valueMinor: bigint;
  peakMinor: bigint;
  kills: number;
  readonly trail: Trail;
  shape: SnakeShape;

  /* ── input, as last received. The client sets these two and nothing else. ── */
  wantHeading: number;
  wantBoost: boolean;
  wantExtract: boolean;

  /* ── derived per tick ── */
  /** Ticks of straight-line extraction accumulated. Reset by turning, boosting or a hit. */
  extractTicks: number;
  /**
   * Value drained by boost that has not yet reached the size of a droppable orb.
   *
   * It has already left `valueMinor` and has not yet landed on the floor, which makes it the one
   * place in the simulation where money is genuinely in flight. Everything that totals the arena
   * or ends a snake has to account for it, or the mode leaks a fraction of a percent per boosted
   * second — see `carriedMinor`.
   */
  /** How long since the socket last spoke. Past ABANDON_GRACE_TICKS the floor takes them. */
  silentTicks: number;
  /** Distance travelled since the last trail point was laid down. */
  sinceLastPoint: number;
  alive: boolean;
}

export interface Gate {
  /** Centre angle of the arc, radians. */
  readonly angle: number;
  readonly halfWidth: number;
}

export interface Arena {
  tick: number;
  readonly snakes: Map<string, Snake>;
  readonly orbs: Map<number, Orb>;
  nextOrbId: number;
}

export function createArena(): Arena {
  return { tick: 0, snakes: new Map(), orbs: new Map(), nextOrbId: 1 };
}

/* ═════════════════════════ events ═════════════════════════ */

export interface KillEvent {
  readonly victimSessionId: string;
  /** Null for a wall hit or an abandonment: nobody killed them. */
  readonly killerSessionId: string | null;
  readonly cause: DeathCause;
  readonly droppedMinor: bigint;
}

export interface CashoutEvent {
  readonly sessionId: string;
  readonly grossMinor: bigint;
  /** 'gate' if they steered through a gate, 'channel' if they held the line. */
  readonly via: 'gate' | 'channel';
}

export interface TickEvents {
  readonly kills: readonly KillEvent[];
  readonly cashouts: readonly CashoutEvent[];
  /** Value that merged off the floor as a rounding remainder. Always 0; asserted by the tests. */
  readonly leakedMinor: bigint;
  /**
   * Value boosting destroyed this tick. Platform revenue, and reported rather than dropped.
   *
   * It is not a leak — it is a deliberate sink — but it is the same KIND of thing, so it travels
   * the same way: named, returned, and added up by the caller. The mode's promise is not that value
   * is conserved on the floor; it is that no unit is ever unaccounted for. Every unit staked is, at
   * any instant, on a snake, on the floor, extracted, or burned.
   */
  readonly burnedMinor: bigint;
}

/* ═════════════════════════ spawning ═════════════════════════ */

/**
 * Candidate spawn points: a fixed sunflower lattice, computed once.
 *
 * A fixed lattice rather than a random point because a random spawn can land you inside somebody's
 * tail through no fault of your own, and "you lost $40M to a coin flip at the door" is not a thing
 * a skill mode gets to say. The rule instead is: of these points, take the one furthest from every
 * live snake. Deterministic, and it degrades gracefully — in a packed arena it still finds the
 * emptiest corner rather than giving up.
 */
const SPAWN_LATTICE: readonly { readonly x: number; readonly y: number }[] = (() => {
  const points: { x: number; y: number }[] = [];
  const count = 96;
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let index = 0; index < count; index += 1) {
    // Square root spacing, so the points are spread evenly by AREA rather than crowding the middle.
    const radius = ARENA_RADIUS * 0.82 * Math.sqrt((index + 0.5) / count);
    const angle = index * golden;
    points.push({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
  }
  return points;
})();

export interface SpawnPoint {
  readonly x: number;
  readonly y: number;
  readonly heading: number;
}

export function chooseSpawn(arena: Arena): SpawnPoint {
  let best = SPAWN_LATTICE[0] as { x: number; y: number };
  let bestClearance = -1;
  for (const candidate of SPAWN_LATTICE) {
    let clearance = Number.POSITIVE_INFINITY;
    for (const snake of arena.snakes.values()) {
      if (!snake.alive) continue;
      for (let index = 0; index < snake.trail.length; index += 3) {
        const dx = snake.trail.x(index) - candidate.x;
        const dy = snake.trail.y(index) - candidate.y;
        const distance = Math.hypot(dx, dy);
        if (distance < clearance) clearance = distance;
      }
    }
    if (clearance > bestClearance) {
      bestClearance = clearance;
      best = candidate;
    }
  }
  // Facing the middle, because facing the wall from a spawn you did not choose is a death sentence.
  return { x: best.x, y: best.y, heading: Math.atan2(-best.y, -best.x) };
}

export function spawnSnake(
  arena: Arena,
  session: {
    readonly sessionId: string;
    readonly userId: string;
    readonly name: string;
    readonly entryMinor: bigint;
    readonly feeBps: number;
  },
): Snake {
  const spawn = chooseSpawn(arena);
  const shape = sizeFor(session.entryMinor);
  const trail = new Trail(MAX_TRAIL_POINTS);
  const snake: Snake = {
    sessionId: session.sessionId,
    userId: session.userId,
    name: session.name,
    entryMinor: session.entryMinor,
    feeBps: session.feeBps,
    x: spawn.x,
    y: spawn.y,
    heading: spawn.heading,
    valueMinor: session.entryMinor,
    peakMinor: session.entryMinor,
    kills: 0,
    trail,
    shape,
    wantHeading: spawn.heading,
    wantBoost: false,
    wantExtract: false,
    extractTicks: 0,
    silentTicks: 0,
    sinceLastPoint: 0,
    alive: true,
  };
  // Lay the body down behind the head so a fresh snake is not a single point that nothing can hit.
  for (let index = shape.points - 1; index >= 0; index -= 1) {
    const back = index * SEGMENT_STEP;
    trail.push(
      spawn.x - Math.cos(spawn.heading) * back,
      spawn.y - Math.sin(spawn.heading) * back,
      shape.points,
    );
  }
  arena.snakes.set(snake.sessionId, snake);
  return snake;
}

/* ═════════════════════════ gates ═════════════════════════ */

/** Where the four gates are on a given tick. Pure arithmetic on the tick counter — no clock. */
export function gatesAt(tick: number): Gate[] {
  const drift = tick * DT * GATE_ROTATION_RAD_PER_SEC;
  const gates: Gate[] = [];
  for (let index = 0; index < GATE_COUNT; index += 1) {
    gates.push({
      angle: normalizeAngle(drift + (index * 2 * Math.PI) / GATE_COUNT),
      halfWidth: GATE_HALF_WIDTH_RAD,
    });
  }
  return gates;
}

function inGate(tick: number, x: number, y: number): boolean {
  if (Math.hypot(x, y) < GATE_INNER_RADIUS) return false;
  const angle = Math.atan2(y, x);
  for (const gate of gatesAt(tick)) {
    if (Math.abs(angleDelta(angle, gate.angle)) <= gate.halfWidth) return true;
  }
  return false;
}

/* ═════════════════════════ the tick ═════════════════════════ */

/**
 * Advances the arena by exactly one tick and returns everything that has to reach the database.
 *
 * Order matters and is not arbitrary:
 *   1. steer and move        — nothing can be resolved against positions half of which are stale
 *   2. boost drain           — the orbs it drops must exist before anyone can eat them
 *   3. absorb orbs           — growth is applied before collisions, so the snake you just fed is
 *                              the size it looks on the screen when it hits you
 *   4. collisions            — deaths are decided against one consistent set of positions
 *   5. extraction            — last, so a player cannot extract on the same tick they died on
 *
 * Step 5 being last is the one that would be a real bug the other way round. Money must not be
 * payable out of a snake that the same tick has already spilled onto the floor.
 */
export function stepArena(arena: Arena): TickEvents {
  arena.tick += 1;
  const kills: KillEvent[] = [];
  const cashouts: CashoutEvent[] = [];

  for (const snake of arena.snakes.values()) {
    if (snake.alive) steerAndMove(snake);
  }
  let burnedMinor = 0n;
  for (const snake of arena.snakes.values()) {
    if (snake.alive) burnedMinor += applyBoostDrain(snake);
  }
  absorbOrbs(arena);
  resolveCollisions(arena, kills);
  resolveExtractions(arena, cashouts);
  const leakedMinor = enforceOrbCap(arena);

  return { kills, cashouts, leakedMinor, burnedMinor };
}

function steerAndMove(snake: Snake): void {
  const previousHeading = snake.heading;
  const maxTurn = snake.shape.turnRate * DT;
  const delta = angleDelta(snake.wantHeading, snake.heading);
  snake.heading = normalizeAngle(snake.heading + Math.max(-maxTurn, Math.min(maxTurn, delta)));

  const boosting = isBoosting(snake);
  const speed = snake.shape.speed * (boosting ? BOOST_SPEED_MULTIPLIER : 1);
  const step = speed * DT;
  snake.x += Math.cos(snake.heading) * step;
  snake.y += Math.sin(snake.heading) * step;

  /* The trail is sampled by DISTANCE, not by time. Sampling per tick would make a boosted snake's
   * body coarser than a slow one's — its own hitbox would develop gaps at exactly the moment it is
   * moving fast enough for that to matter. */
  snake.sinceLastPoint += step;
  while (snake.sinceLastPoint >= SEGMENT_STEP) {
    snake.sinceLastPoint -= SEGMENT_STEP;
    snake.trail.push(snake.x, snake.y, snake.shape.points);
  }

  // Turning breaks the extraction channel, and so does boosting. See EXTRACT_MAX_TURN_PER_TICK.
  const turned = Math.abs(angleDelta(snake.heading, previousHeading));
  if (!snake.wantExtract || boosting || turned > EXTRACT_MAX_TURN_PER_TICK) {
    snake.extractTicks = 0;
  } else {
    snake.extractTicks += 1;
  }
}

export function isBoosting(snake: Snake): boolean {
  return snake.wantBoost && snake.valueMinor > BOOST_FLOOR_MINOR;
}

/**
 * Boost costs 0.5% of current value per second, and that value is BURNED.
 *
 * It used to land on the floor behind the snake for anybody to take. That made boosting a way to
 * feed other players, and eating what they shed a way to grow without ever killing anyone — which
 * is the thing this mode is now explicitly not meant to allow. The only way to take value off
 * another player is to kill them.
 *
 * Burned value does not vanish quietly. It is returned as `burnedMinor` and the caller records it
 * as platform revenue, the same treatment `sweepFloor` gives an orphaned floor. The arena still
 * never loses track of a unit: every unit staked is, at any moment, on a snake, on the floor,
 * extracted, or burned. The test asserts exactly that sum.
 *
 * NOTE ON THE EDGE. This is a second house margin alongside the cashout fee, and it is one players
 * pay by playing well — boosting is how you chase and how you escape. It was chosen deliberately;
 * it is not free, and it is not the 10% on the way out. Anyone tuning the economics should read
 * these two together rather than either alone.
 */
function applyBoostDrain(snake: Snake): bigint {
  if (!isBoosting(snake)) return 0n;
  let drain = (snake.valueMinor * BOOST_DRAIN_NUMERATOR) / BOOST_DRAIN_DENOMINATOR;
  if (drain < 1n) drain = 1n;
  if (drain > snake.valueMinor) drain = snake.valueMinor;
  snake.valueMinor -= drain;
  resize(snake);
  return drain;
}

function dropOrb(arena: Arena, x: number, y: number, valueMinor: bigint, kind: OrbKind): void {
  if (valueMinor <= 0n) return;
  const id = arena.nextOrbId;
  arena.nextOrbId += 1;
  const clamped = clampToArena(x, y, ARENA_RADIUS - 24);
  arena.orbs.set(id, {
    id,
    x: clamped.x,
    y: clamped.y,
    valueMinor,
    kind,
    bornTick: arena.tick,
  });
}

/* ═════════════════════════ broadphase ═════════════════════════ */

/**
 * A uniform grid, rebuilt every tick.
 *
 * Forty snakes with a hundred and fifty body points each is six thousand points, and testing every
 * head against every point is a quarter of a million distance checks twenty times a second — for a
 * game where the answer is "no" essentially always. The grid turns that into nine cell lookups per
 * head. It is rebuilt rather than maintained because every point moves every tick anyway, so there
 * is nothing to preserve between them.
 */
class Grid<T> {
  readonly #cells = new Map<number, T[]>();

  insert(x: number, y: number, item: T): void {
    const key = this.#key(x, y);
    const bucket = this.#cells.get(key);
    if (bucket) bucket.push(item);
    else this.#cells.set(key, [item]);
  }

  /** Everything in the 3x3 block of cells around a point. */
  near(x: number, y: number, into: T[]): T[] {
    into.length = 0;
    const cellX = Math.floor(x / GRID_CELL);
    const cellY = Math.floor(y / GRID_CELL);
    for (let ox = -1; ox <= 1; ox += 1) {
      for (let oy = -1; oy <= 1; oy += 1) {
        const bucket = this.#cells.get(this.#keyFromCell(cellX + ox, cellY + oy));
        if (bucket) for (const item of bucket) into.push(item);
      }
    }
    return into;
  }

  #key(x: number, y: number): number {
    return this.#keyFromCell(Math.floor(x / GRID_CELL), Math.floor(y / GRID_CELL));
  }

  #keyFromCell(cellX: number, cellY: number): number {
    // Both coordinates fit comfortably inside a 16-bit half after the arena offset, so one integer
    // key is enough and a string key per cell per tick is not paid for.
    return ((cellX + 2048) << 12) | ((cellY + 2048) & 0xfff);
  }
}

/* ═════════════════════════ eating ═════════════════════════ */

function absorbOrbs(arena: Arena): void {
  if (arena.orbs.size === 0) return;
  const grid = new Grid<Orb>();
  for (const orb of arena.orbs.values()) grid.insert(orb.x, orb.y, orb);

  const scratch: Orb[] = [];
  for (const snake of arena.snakes.values()) {
    if (!snake.alive) continue;
    // A bigger mouth is a bigger pickup radius, which is most of why a whale is worth becoming.
    const reach = snake.shape.radius + 16;
    for (const orb of grid.near(snake.x, snake.y, scratch)) {
      if (!arena.orbs.has(orb.id)) continue;
      if (Math.hypot(orb.x - snake.x, orb.y - snake.y) > reach) continue;
      // 100% of the orb. There is no absorption tax: the thing that makes a kill worth chasing is
      // that the money on the floor is the money you get.
      snake.valueMinor += orb.valueMinor;
      arena.orbs.delete(orb.id);
    }
    if (snake.valueMinor > snake.peakMinor) snake.peakMinor = snake.valueMinor;
    resize(snake);
  }
}

function resize(snake: Snake): void {
  snake.shape = sizeFor(snake.valueMinor);
  snake.trail.trim(snake.shape.points);
}

/* ═════════════════════════ dying ═════════════════════════ */

/**
 * One pass, one consistent set of positions.
 *
 * Every death is decided against the positions all snakes hold at the END of movement, and the
 * spill is applied afterwards. Resolving a snake's death the moment it is found would let the orbs
 * of the first death be eaten by the second snake before the second snake had been told it was also
 * dead — which is how two players who hit each other on the same tick end up with one of them
 * mysteriously richer.
 */
function resolveCollisions(arena: Arena, kills: KillEvent[]): void {
  interface BodyPoint {
    readonly snake: Snake;
    readonly x: number;
    readonly y: number;
  }
  const grid = new Grid<BodyPoint>();
  for (const snake of arena.snakes.values()) {
    if (!snake.alive) continue;
    /* The first few points are skipped: they are underneath the snake's own head, and including
     * them would mean every snake on the board is permanently colliding with itself. */
    const skip = Math.ceil((snake.shape.radius * 2) / SEGMENT_STEP) + 1;
    for (let index = skip; index < snake.trail.length; index += 1) {
      grid.insert(snake.trail.x(index), snake.trail.y(index), {
        snake,
        x: snake.trail.x(index),
        y: snake.trail.y(index),
      });
    }
  }

  const doomed: { snake: Snake; killer: Snake | null; cause: DeathCause }[] = [];
  const scratch: BodyPoint[] = [];
  for (const snake of arena.snakes.values()) {
    if (!snake.alive) continue;

    // Silence first. A snake whose socket died stops being a player and becomes scenery, and after
    // the grace period the floor takes it — exactly as if it had run into somebody.
    if (snake.silentTicks > ABANDON_GRACE_TICKS) {
      doomed.push({ snake, killer: null, cause: 'abandoned' });
      continue;
    }

    // The wall, except where a gate is. A gate is the one part of the edge that is not fatal.
    if (
      Math.hypot(snake.x, snake.y) + snake.shape.radius >= ARENA_RADIUS &&
      !inGate(arena.tick, snake.x, snake.y)
    ) {
      doomed.push({ snake, killer: null, cause: 'wall' });
      continue;
    }

    let killer: Snake | null = null;
    for (const point of grid.near(snake.x, snake.y, scratch)) {
      if (point.snake === snake) continue;
      if (!point.snake.alive) continue;
      const reach = snake.shape.radius + point.snake.shape.radius * 0.9;
      if (Math.hypot(point.x - snake.x, point.y - snake.y) <= reach) {
        killer = point.snake;
        break;
      }
    }
    if (killer) doomed.push({ snake, killer, cause: 'body' });
  }

  for (const death of doomed) {
    /* The in-flight drain spills with everything else. Reading `valueMinor` alone here would make
     * every death quietly destroy whatever the victim had drained since its last orb. */
    const dropped = carriedMinor(death.snake);
    death.snake.alive = false;
    death.snake.valueMinor = 0n;
    scatter(arena, death.snake, dropped);
    if (death.killer && death.killer.alive) death.killer.kills += 1;
    kills.push({
      victimSessionId: death.snake.sessionId,
      killerSessionId: death.killer?.sessionId ?? null,
      cause: death.cause,
      droppedMinor: dropped,
    });
  }
}

/**
 * Spills a dead snake's whole value across the length of its body.
 *
 * Split evenly with the remainder on the first orb, so the arithmetic is exact: the sum of the
 * orbs is the value that died, to the unit, and the tests assert it. A percentage-based scatter
 * that "loses a little to the floor" is a fee, and this mode has exactly one fee.
 */
function scatter(arena: Arena, snake: Snake, totalMinor: bigint): void {
  if (totalMinor <= 0n) return;
  const count = BigInt(
    Math.max(6, Math.min(60, Math.round(Math.sqrt(Number(totalMinor) / 50_000)))),
  );
  const each = totalMinor / count;
  let remainder = totalMinor - each * count;

  const random = splitmix32(hashString(snake.sessionId) ^ (arena.tick * 0x9e3779b9));
  const span = Math.max(1, snake.trail.length - 1);
  for (let index = 0; index < Number(count); index += 1) {
    const along = Math.round((index / Number(count)) * span);
    // A few metres of jitter so a spill reads as an explosion rather than a dotted line. This is
    // the only pseudo-random number in the file, and it moves money sideways, never up or down.
    const angle = random() * Math.PI * 2;
    const spread = 18 + random() * snake.shape.radius * 2.4;
    let value = each;
    if (remainder > 0n) {
      value += 1n;
      remainder -= 1n;
    }
    dropOrb(
      arena,
      snake.trail.x(along) + Math.cos(angle) * spread,
      snake.trail.y(along) + Math.sin(angle) * spread,
      value,
      'death',
    );
  }
}

/* ═════════════════════════ leaving with it ═════════════════════════ */

function resolveExtractions(arena: Arena, cashouts: CashoutEvent[]): void {
  for (const snake of arena.snakes.values()) {
    if (!snake.alive) continue;
    const viaGate = inGate(arena.tick, snake.x, snake.y);
    const viaChannel = snake.extractTicks >= EXTRACT_TICKS;
    if (!viaGate && !viaChannel) continue;

    const gross = carriedMinor(snake);
    snake.alive = false;
    snake.valueMinor = 0n;
    /* Nothing is scattered. This is the whole point of extracting: the value leaves the pit with
     * the player instead of landing on the floor for whoever is nearest. */
    cashouts.push({
      sessionId: snake.sessionId,
      grossMinor: gross,
      via: viaGate ? 'gate' : 'channel',
    });
  }
}

/* ═════════════════════════ the floor ═════════════════════════ */

/**
 * Keeps the floor bounded by MERGING, never by deleting.
 *
 * The obvious implementation expires old orbs, and the obvious implementation is a silent second
 * fee: money a player dropped, that another player could have reached, vanishing into the house
 * because a timer ran out. Instead the oldest orb is folded into its nearest neighbour. The floor
 * gets shorter, the money stays on it, and `leakedMinor` is returned so a test can assert that it
 * is always zero.
 */
function enforceOrbCap(arena: Arena): bigint {
  const leaked = 0n;
  while (arena.orbs.size > MAX_ORBS) {
    let oldest: Orb | null = null;
    for (const orb of arena.orbs.values()) {
      if (!oldest || orb.bornTick < oldest.bornTick) oldest = orb;
    }
    if (!oldest) break;
    let nearest: Orb | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const orb of arena.orbs.values()) {
      if (orb.id === oldest.id) continue;
      const distance = Math.hypot(orb.x - oldest.x, orb.y - oldest.y);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = orb;
      }
    }
    if (!nearest) break;
    nearest.valueMinor += oldest.valueMinor;
    arena.orbs.delete(oldest.id);
  }
  return leaked;
}

/**
 * Everything still on the floor when the last snake leaves.
 *
 * The pit cannot hold value with nobody in it — there would be nobody to take it and it would
 * still be on the books. It is swept, and the amount is returned so the caller can record it as
 * platform revenue rather than let it disappear from the arithmetic.
 */
export function sweepFloor(arena: Arena): bigint {
  let total = 0n;
  for (const orb of arena.orbs.values()) total += orb.valueMinor;
  arena.orbs.clear();
  return total;
}

/**
 * Everything a snake is holding, which is what it pays out or spills.
 *
 * This used to add a drain bucket: value that had left `valueMinor` but had not yet been dropped as
 * an orb, which a death would otherwise have destroyed silently. Boosting burns now, so the value
 * leaves on the tick it is spent and there is nothing in flight to carry. Kept as a named concept
 * rather than inlined, because "what this snake would pay out right now" is the question three
 * different call sites are asking and it deserves to be asked in one place.
 */
export function carriedMinor(snake: Snake): bigint {
  return snake.valueMinor;
}

/** The total value the arena is holding, across snakes and floor. The conservation invariant. */
export function arenaValueMinor(arena: Arena): bigint {
  let total = 0n;
  for (const snake of arena.snakes.values()) if (snake.alive) total += carriedMinor(snake);
  for (const orb of arena.orbs.values()) total += orb.valueMinor;
  return total;
}

/* ═════════════════════════ small maths ═════════════════════════ */

export function normalizeAngle(angle: number): number {
  const wrapped = angle % (Math.PI * 2);
  if (wrapped > Math.PI) return wrapped - Math.PI * 2;
  if (wrapped < -Math.PI) return wrapped + Math.PI * 2;
  return wrapped;
}

/** Signed shortest rotation from `from` to `to`, in radians. */
export function angleDelta(to: number, from: number): number {
  return normalizeAngle(to - from);
}

function clampToArena(x: number, y: number, limit: number): { x: number; y: number } {
  const distance = Math.hypot(x, y);
  if (distance <= limit || distance === 0) return { x, y };
  const scale = limit / distance;
  return { x: x * scale, y: y * scale };
}

function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Deterministic, seeded, and used for nothing but where an orb lands. */
function splitmix32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    return ((z ^ (z >>> 15)) >>> 0) / 4294967296;
  };
}
