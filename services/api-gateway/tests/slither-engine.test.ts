import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ARENA_RADIUS,
  BOOST_FLOOR_MINOR,
  EXTRACT_TICKS,
  MAX_ENTRY_MINOR,
  MIN_ENTRY_MINOR,
  arenaValueMinor,
  createArena,
  entryIsLegal,
  expectedMarginMinor,
  gatesAt,
  isBoosting,
  sizeFor,
  spawnSnake,
  splitExtraction,
  stepArena,
  sweepFloor,
  type Arena,
  type Snake,
} from '../src/lib/slither-engine.js';

/* ═════════════════════════ the entry band ═════════════════════════ */

test('the entry band is exactly $1M to $100M, inclusive at both ends', () => {
  assert.equal(MIN_ENTRY_MINOR, 1_000_000n);
  assert.equal(MAX_ENTRY_MINOR, 100_000_000n);
  assert.equal(entryIsLegal(1_000_000n), true);
  assert.equal(entryIsLegal(100_000_000n), true);
  assert.equal(entryIsLegal(999_999n), false);
  assert.equal(entryIsLegal(100_000_001n), false);
  assert.equal(entryIsLegal(0n), false);
});

/* ═════════════════════════ stake to size ═════════════════════════ */

test('a minimum-stake snake is small, fast and agile; a maximum-stake one is not', () => {
  const small = sizeFor(MIN_ENTRY_MINOR);
  const large = sizeFor(MAX_ENTRY_MINOR);

  assert.ok(large.radius > small.radius, 'the leviathan is thicker');
  assert.ok(large.points > small.points, 'the leviathan is longer');
  // The trade that makes a whale beatable: it is slower and it turns worse.
  assert.ok(large.speed < small.speed, 'the leviathan is slower');
  assert.ok(large.turnRate < small.turnRate, 'the leviathan turns worse');

  assert.equal(Math.round(small.aura * 1000) / 1000, 0);
  assert.equal(Math.round(large.aura * 1000) / 1000, 1);
});

test('size is monotonic in value across the whole band', () => {
  let previous = sizeFor(MIN_ENTRY_MINOR);
  for (let value = 2_000_000n; value <= MAX_ENTRY_MINOR; value += 1_000_000n) {
    const next = sizeFor(value);
    assert.ok(next.radius >= previous.radius, `radius went backwards at ${value}`);
    assert.ok(next.points >= previous.points, `length went backwards at ${value}`);
    assert.ok(next.speed <= previous.speed, `speed went up at ${value}`);
    previous = next;
  }
});

test('the midpoint of the band sits at the geometric mean, not the arithmetic one', () => {
  /* $10M is sqrt(1M * 100M). On a logarithm that is the middle of the band, which is the whole
   * reason the interpolation is logarithmic: a linear map would put $10M at 9% and render nine
   * tenths of every stake anyone actually plays as the same minimum worm. */
  const mid = sizeFor(10_000_000n);
  assert.ok(Math.abs(mid.aura - 0.5) < 0.001, `aura at $10M was ${mid.aura}`);
});

test('a snake fed past the maximum stake keeps growing visually but is clamped physically', () => {
  const max = sizeFor(MAX_ENTRY_MINOR);
  const fed = sizeFor(MAX_ENTRY_MINOR * 50n);
  assert.ok(fed.aura > 1.4, 'the aura keeps reporting how far past the cap it is');
  assert.ok(fed.radius <= 13 + 31 * 1.35 + 0.001, 'the body is clamped');
  assert.ok(fed.radius > max.radius);
});

/* ═════════════════════════ the platform cut ═════════════════════════ */

test('an extraction always splits exactly, at every value and every legal rate', () => {
  for (const gross of [0n, 1n, 7n, 999n, 1_000_000n, 99_999_999n, 10n ** 18n]) {
    for (const bps of [0, 1, 37, 300, 999, 1000]) {
      const split = splitExtraction(gross, bps);
      assert.equal(
        split.creditedMinor + split.feeMinor,
        split.grossMinor,
        `gross=${gross} bps=${bps}`,
      );
      assert.ok(split.feeMinor >= 0n);
      assert.ok(split.creditedMinor >= 0n);
    }
  }
});

test('the cut truncates toward the player, never toward the house', () => {
  // 300 bps of 2 is 0.06. It must floor to nothing rather than round up to a unit.
  assert.equal(splitExtraction(2n, 300).feeMinor, 0n);
  assert.equal(splitExtraction(2n, 300).creditedMinor, 2n);
});

test('the expected margin on an entry is the cut it would pay on the way out', () => {
  assert.equal(expectedMarginMinor(100_000_000n, 300), 3_000_000n);
  assert.equal(expectedMarginMinor(1_000_000n, 300), 30_000n);
});

/* ═════════════════════════ the arena ═════════════════════════ */

let nextId = 0;

/**
 * An angle that is not a gate, on the given tick and for a good while after.
 *
 * Gates sit a quarter turn apart and rotate slowly, so the point diagonally between two of them is
 * the furthest any spot on the wall ever is from a way out. Tests that want the wall to be lethal
 * have to aim there — the first draft of two of them aimed at angle zero, which on tick one is the
 * middle of the first gate, and got a clean extraction instead of the death they asserted.
 */
function solidWallAngle(tick: number): number {
  const first = gatesAt(tick)[0];
  assert.ok(first);
  return first.angle + Math.PI / 4;
}

function join(arena: Arena, entryMinor: bigint): Snake {
  nextId += 1;
  return spawnSnake(arena, {
    sessionId: `00000000-0000-4000-8000-${String(nextId).padStart(12, '0')}`,
    userId: `user-${nextId}`,
    name: `Player${nextId}`,
    entryMinor,
    feeBps: 300,
  });
}

test('a spawned snake starts inside the arena, carrying exactly its buy-in', () => {
  const arena = createArena();
  const snake = join(arena, 25_000_000n);
  assert.equal(snake.valueMinor, 25_000_000n);
  assert.ok(Math.hypot(snake.x, snake.y) < ARENA_RADIUS, 'spawned inside the wall');
  // The body is laid down behind the head at spawn, so a fresh snake is hittable immediately
  // rather than being a single point that nothing can collide with.
  assert.ok(snake.trail.length > 10);
});

test('spawns are placed away from everyone already on the board', () => {
  const arena = createArena();
  const first = join(arena, 100_000_000n);
  const second = join(arena, 1_000_000n);
  assert.ok(
    Math.hypot(second.x - first.x, second.y - first.y) > 800,
    'a new snake must not land in somebody else',
  );
});

test('value is conserved across a long run of ticks with boosting and eating', () => {
  /* The invariant the whole mode rests on: the arena never creates or destroys money, it only
   * moves it between snakes and the floor. Three snakes, all boosting, for a thousand ticks. */
  const arena = createArena();
  const snakes = [join(arena, 100_000_000n), join(arena, 10_000_000n), join(arena, 1_000_000n)];
  const staked = snakes.reduce((total, snake) => total + snake.entryMinor, 0n);
  for (const snake of snakes) snake.wantBoost = true;

  let extracted = 0n;
  let onTheFloorAtDeath = 0n;
  for (let tick = 0; tick < 1000; tick += 1) {
    // Steer each snake in a slow circle so nobody simply drives into the wall and ends the test.
    for (const snake of arena.snakes.values()) {
      snake.wantHeading = snake.heading + 0.25;
      snake.silentTicks = 0;
    }
    const events = stepArena(arena);
    assert.equal(events.leakedMinor, 0n, `value leaked on tick ${tick}`);
    for (const cashout of events.cashouts) {
      extracted += cashout.grossMinor;
      arena.snakes.delete(cashout.sessionId);
    }
    for (const kill of events.kills) {
      onTheFloorAtDeath += kill.droppedMinor;
      arena.snakes.delete(kill.victimSessionId);
    }
    assert.equal(
      arenaValueMinor(arena) + extracted,
      staked,
      `conservation broke on tick ${tick}`,
    );
  }
  assert.ok(onTheFloorAtDeath >= 0n);
});

test('boost drains the snake and drops every drained unit onto the floor', () => {
  const arena = createArena();
  const snake = join(arena, 50_000_000n);
  snake.wantBoost = true;
  for (let tick = 0; tick < 60; tick += 1) {
    snake.wantHeading = snake.heading + 0.2;
    snake.silentTicks = 0;
    stepArena(arena);
  }
  assert.ok(snake.valueMinor < 50_000_000n, 'boosting must cost something');
  // Roughly 0.5% a second for three seconds. Bounded loosely because orbs the snake has looped
  // back over are its own drain coming straight back.
  assert.ok(snake.valueMinor > 45_000_000n, 'boosting must not cost everything');
  assert.equal(arenaValueMinor(arena), 50_000_000n, 'the drain went onto the floor, not away');
});

test('boost stops working at the floor rather than eating the snake to nothing', () => {
  const arena = createArena();
  const snake = join(arena, 1_000_000n);
  snake.valueMinor = BOOST_FLOOR_MINOR;
  snake.wantBoost = true;
  assert.equal(isBoosting(snake), false);
  const before = snake.valueMinor;
  stepArena(arena);
  assert.equal(snake.valueMinor, before);
});

test('running into the wall kills you and spills the whole value', () => {
  const arena = createArena();
  const snake = join(arena, 8_000_000n);
  // Point it at a solid stretch of the edge and hold the line.
  const angle = solidWallAngle(arena.tick + 1);
  snake.x = Math.cos(angle) * (ARENA_RADIUS - 120);
  snake.y = Math.sin(angle) * (ARENA_RADIUS - 120);
  snake.heading = angle;
  snake.wantHeading = angle;

  let killed: bigint | null = null;
  for (let tick = 0; tick < 60 && killed === null; tick += 1) {
    snake.silentTicks = 0;
    const events = stepArena(arena);
    for (const kill of events.kills) {
      assert.equal(kill.cause, 'wall');
      assert.equal(kill.killerSessionId, null);
      killed = kill.droppedMinor;
    }
  }
  assert.equal(killed, 8_000_000n, 'the whole value hits the floor');
  assert.equal(arenaValueMinor(arena), 8_000_000n, 'and it is all still in the arena as orbs');
});

test('a death drops orbs summing to the victim value, to the unit', () => {
  /* An odd figure on purpose: an even split with a remainder is the only place a scatter can
   * quietly lose a few units, and "a little is lost to the floor" is a second fee. */
  const arena = createArena();
  const snake = join(arena, 7_777_777n);
  const angle = solidWallAngle(arena.tick + 1);
  snake.x = Math.cos(angle) * (ARENA_RADIUS - 60);
  snake.y = Math.sin(angle) * (ARENA_RADIUS - 60);
  snake.heading = angle;
  snake.wantHeading = angle;
  for (let tick = 0; tick < 60 && arena.snakes.get(snake.sessionId)?.alive; tick += 1) {
    snake.silentTicks = 0;
    stepArena(arena);
  }
  arena.snakes.delete(snake.sessionId);
  assert.equal(sweepFloor(arena), 7_777_777n);
});

test('a silent socket is taken by the floor rather than keeping its stake', () => {
  const arena = createArena();
  const snake = join(arena, 4_000_000n);
  let abandoned = false;
  for (let tick = 0; tick < 400 && !abandoned; tick += 1) {
    // Never reset silentTicks: this is a player whose connection died.
    for (const live of arena.snakes.values()) live.silentTicks += 1;
    for (const kill of stepArena(arena).kills) {
      if (kill.cause === 'abandoned') {
        abandoned = true;
        assert.equal(kill.droppedMinor, 4_000_000n, 'the stake goes to the floor, not home');
      }
    }
  }
  assert.equal(abandoned, true, 'a silent snake must eventually be taken');
  assert.equal(snake.alive, false);
});

/* ═════════════════════════ getting out ═════════════════════════ */

test('holding a straight line for three seconds extracts the whole value', () => {
  const arena = createArena();
  const snake = join(arena, 12_000_000n);
  // Park it in the middle pointing inward so it cannot reach the wall inside the channel.
  snake.x = 0;
  snake.y = 0;
  snake.heading = 0;
  snake.wantHeading = 0;
  snake.wantExtract = true;

  let cashed: bigint | null = null;
  for (let tick = 0; tick <= EXTRACT_TICKS + 2 && cashed === null; tick += 1) {
    snake.silentTicks = 0;
    for (const cashout of stepArena(arena).cashouts) cashed = cashout.grossMinor;
  }
  assert.equal(cashed, 12_000_000n);
  assert.equal(arena.orbs.size, 0, 'an extraction leaves nothing on the floor');
});

test('turning or boosting resets the channel', () => {
  const arena = createArena();
  const snake = join(arena, 12_000_000n);
  snake.x = 0;
  snake.y = 0;
  snake.heading = 0;
  snake.wantHeading = 0;
  snake.wantExtract = true;

  for (let tick = 0; tick < EXTRACT_TICKS - 5; tick += 1) {
    snake.silentTicks = 0;
    stepArena(arena);
  }
  assert.ok(snake.extractTicks > 0, 'the channel was building');

  snake.wantHeading = snake.heading + 1.2; // a hard turn
  snake.silentTicks = 0;
  stepArena(arena);
  assert.equal(snake.extractTicks, 0, 'turning breaks it');

  snake.wantHeading = snake.heading;
  snake.wantBoost = true;
  snake.silentTicks = 0;
  stepArena(arena);
  assert.equal(snake.extractTicks, 0, 'and so does boosting');
});

test('the gates move, predictably and without a clock', () => {
  const now = gatesAt(0);
  const later = gatesAt(600); // thirty seconds
  assert.equal(now.length, 4);
  assert.notEqual(now[0]?.angle, later[0]?.angle, 'the way out is never in the same place twice');
  // Deterministic: the same tick is the same arrangement on any machine, forever.
  assert.deepEqual(gatesAt(600), later);
});

test('steering into a gate extracts without holding anything', () => {
  const arena = createArena();
  const snake = join(arena, 33_000_000n);
  const gate = gatesAt(arena.tick + 1)[0];
  assert.ok(gate);
  // Just inside the gate band, pointing out through it.
  snake.x = Math.cos(gate.angle) * (ARENA_RADIUS - 50);
  snake.y = Math.sin(gate.angle) * (ARENA_RADIUS - 50);
  snake.heading = gate.angle;
  snake.wantHeading = gate.angle;
  snake.silentTicks = 0;

  const events = stepArena(arena);
  assert.equal(events.cashouts.length, 1);
  assert.equal(events.cashouts[0]?.via, 'gate');
  assert.equal(events.cashouts[0]?.grossMinor, 33_000_000n);
  assert.equal(events.kills.length, 0, 'a gate is the one part of the wall that is not fatal');
});

test('a snake cannot both die and extract on the same tick', () => {
  /* Extraction is resolved after collisions precisely so that money is never payable out of a
   * snake that has already spilled onto the floor. Driving at the wall with extract held is the
   * shape of that attempt. */
  const arena = createArena();
  const snake = join(arena, 20_000_000n);
  const gate = gatesAt(arena.tick + 1)[0];
  assert.ok(gate);
  // The far side of the arena from every gate, so the wall it reaches is solid.
  const deadly = gate.angle + Math.PI / 4;
  snake.x = Math.cos(deadly) * (ARENA_RADIUS - 40);
  snake.y = Math.sin(deadly) * (ARENA_RADIUS - 40);
  snake.heading = deadly;
  snake.wantHeading = deadly;
  snake.wantExtract = true;
  snake.extractTicks = EXTRACT_TICKS; // already fully channelled

  const events = stepArena(arena);
  assert.equal(events.kills.length, 1);
  assert.equal(events.cashouts.length, 0, 'the dead do not cash out');
});

/* ═════════════════════════ killing ═════════════════════════ */

test('a head that touches another body dies, and the body it touched does not', () => {
  const arena = createArena();
  // The big one goes in alone and lays a body across the middle. The small one is not spawned
  // until afterwards: a snake parked off the board to keep it out of the way is a snake outside
  // the wall, which is its own kind of death and not the one under test.
  const wall = join(arena, 60_000_000n);
  wall.x = 0;
  wall.y = 0;
  wall.heading = 0;
  wall.wantHeading = 0;
  for (let tick = 0; tick < 40; tick += 1) {
    wall.silentTicks = 0;
    stepArena(arena);
  }

  const victim = join(arena, 5_000_000n);
  // Now drop the small snake's head onto a point that is unambiguously the big one's body.
  const bodyIndex = Math.min(wall.trail.length - 1, 12);
  victim.x = wall.trail.x(bodyIndex);
  victim.y = wall.trail.y(bodyIndex);
  victim.heading = wall.heading;
  victim.wantHeading = wall.heading;
  victim.silentTicks = 0;
  wall.silentTicks = 0;

  const events = stepArena(arena);
  const death = events.kills.find((kill) => kill.victimSessionId === victim.sessionId);
  assert.ok(death, 'the one that ran into a body is the one that dies');
  assert.equal(death.killerSessionId, wall.sessionId);
  assert.equal(death.droppedMinor, 5_000_000n);
  assert.equal(wall.alive, true, 'being run into costs you nothing');
  assert.equal(wall.kills, 1);
});

test('a killed snake pays the killer nothing directly — the value goes to the floor', () => {
  /* The rule the kills table also encodes. A kill does not credit anybody; it puts the money down
   * where anyone can reach it, and very often the player who caused the death is not the one who
   * gets there first. */
  const arena = createArena();
  const killer = join(arena, 30_000_000n);
  killer.x = 0;
  killer.y = 0;
  killer.heading = 0;
  killer.wantHeading = 0;
  for (let tick = 0; tick < 30; tick += 1) {
    killer.silentTicks = 0;
    stepArena(arena);
  }
  const killerValueBefore = killer.valueMinor;

  const victim = join(arena, 9_000_000n);
  // Onto the killer's TAIL, so the spill lands well behind the killer's head and the assertion is
  // about the kill itself rather than about how fast the killer got back to the orbs.
  const bodyIndex = killer.trail.length - 1;
  victim.x = killer.trail.x(bodyIndex);
  victim.y = killer.trail.y(bodyIndex);
  victim.heading = killer.heading;
  victim.wantHeading = killer.heading;
  victim.silentTicks = 0;
  killer.silentTicks = 0;
  const events = stepArena(arena);

  assert.equal(victim.alive, false);
  assert.equal(events.kills[0]?.killerSessionId, killer.sessionId);
  assert.equal(
    killer.valueMinor,
    killerValueBefore,
    'the killer is not paid for the kill; they are paid for reaching the orbs',
  );
});
