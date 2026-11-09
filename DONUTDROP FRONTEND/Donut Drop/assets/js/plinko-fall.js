/* plinko-fall.js — the flat board's ball, falling as a real ball falls.
 *
 * The server has already decided where every ball goes: one left or right per row of pegs. This
 * works out a fall that gets there by physics alone: gravity, a bounce off each peg that loses
 * energy, and a true parabola between bounces. Nothing is steered in the air. The one choice made
 * is at each bounce: which side of the next peg the ball meets, and so which way it goes on -- the
 * part of a real bounce no one can see, decided by a hair's breadth of where ball meets peg.
 *
 * Every arc is checked against every peg it passes: a ball never cuts through one (in the rare tight
 * spot, about one hop in five thousand, it may graze one by under a hundredth of a peg gap -- less
 * than the pegs are drawn short of their true size, so it never shows). A fall is worked
 * out once, when the ball is dropped, as a list of arcs and the moments it strikes a peg; drawing it
 * is reading off a parabola, so it looks the same at any frame rate.
 *
 * Board units: one peg gap. The first row of pegs at TOP, the rows ROW apart, the slots FOOT under
 * the last row; a peg PEG_R, the ball BALL_R. Times in milliseconds.
 */

export const TOP = 1.1;
export const ROW = 0.9;
export const FOOT = 0.9;
export const PEG_R = 0.1;
export const BALL_R = 0.26;

/* The physics, in peg gaps and seconds: about a quarter of a second a row, so twelve rows take a
 * little over three seconds and sixteen a little over four. */
const GRAVITY = 52; // gaps per second, per second
const BOUNCE = [0.36, 0.52]; // how much of the ball's speed into the peg comes back out of it
const OTHER = [0.6, 0.26, 0.7, 0.18, 0.8]; // livelier or deader bounces, when the next peg can only be reached so
const SCUFF = 0.82; // how much of its speed along the peg survives the contact
const TOUCH = PEG_R + BALL_R; // centre to centre when the ball meets a peg

/** Where peg `j` of row `r` stands on a board of `rows` rows. */
export function pegAt(rows, r, j) {
  return { x: (rows + 2) / 2 + j - (r + 2) / 2, y: TOP + r * ROW };
}

/** The ball's height at the bottom of the board, where it drops into its slot. */
export const floorOf = (rows) => TOP + (rows - 1) * ROW + FOOT - BALL_R;

/** Seconds for a ball at height `y` going `vy` (down is +) to reach height `to`. */
function flight(y, vy, to) {
  const drop = to - y;
  return (-vy + Math.sqrt(Math.max(0, vy * vy + 2 * GRAVITY * drop))) / GRAVITY;
}

/** The pegs an arc from row `from` to row `to` can come near: the rows it leaves and meets, and the
 * row above, which a high hop can reach. */
function nearPegs(rows, from, to) {
  const out = [];
  for (let r = Math.max(0, from - 1); r <= Math.min(rows - 1, to); r += 1) {
    for (let j = 0; j < r + 3; j += 1) out.push(pegAt(rows, r, j));
  }
  return out;
}

/** How near the arc comes to any peg, the two it leaves and meets included (those it may only
 * touch at its ends): at least TOUCH is clear. */
function nearest(arc, pegs) {
  const steps = Math.max(8, Math.ceil(arc.dt / 0.003));
  let near = Infinity;
  for (let k = 1; k < steps; k += 1) {
    const t = (arc.dt * k) / steps;
    const x = arc.x + arc.vx * t;
    const y = arc.y + arc.vy * t + 0.5 * GRAVITY * t * t;
    for (const peg of pegs) near = Math.min(near, Math.hypot(x - peg.x, y - peg.y));
  }
  return near;
}

/**
 * The fall of one ball along `path` (0 left, 1 right, one per row) on a board of `rows` rows.
 * Returns its arcs ({ t, dt, x, y, vx, vy }: from time t, for dt seconds), the moments it strikes a
 * peg ({ t, peg: "row:index", row }), and how long it takes (`duration`), all in milliseconds
 * except each arc's own seconds.
 */
export function simulateFall(path, rows, random = Math.random) {
  const arcs = [];
  const hits = [];
  let clock = 0;
  let rights = 0;
  // Let go just above the top peg, a hair off its middle, from rest.
  let x = (rows + 2) / 2 + (random() - 0.5) * 0.04;
  let y = TOP - 0.85;
  let from = -1; // the row of the peg the ball is leaving
  let fromPeg = null;
  let leave = () => 0; // the ball's upward speed off the last peg, for a given bounce; none at the start
  let rough = 0; // arcs that had to graze a peg (none, on these boards)

  for (let r = 0; r <= rows; r += 1) {
    const last = r === rows;
    const peg = last ? null : pegAt(rows, r, 1 + rights);
    const side = last ? 0 : path[r] ? 1 : -1;
    const pegs = nearPegs(rows, from, last ? rows - 1 : r);
    let arc = null;
    let best = null; // the arc that came nearest to clear, should none be
    // An ordinary bounce first, and a livelier or deader one only when the next peg cannot be reached
    // cleanly otherwise (a ball that must cross back over the peg it left has to hop to do it). For
    // each, contact points from the most natural outwards, until one is reached without touching a
    // peg on the way. The first one almost always is.
    const bounces = fromPeg ? [BOUNCE[0] + random() * (BOUNCE[1] - BOUNCE[0]), ...OTHER] : [0];
    for (const bounce of bounces) {
      const vy = leave(bounce);
      for (let attempt = 0; attempt < 12 && !arc; attempt += 1) {
        let tx;
        let ty;
        if (last) {
          // Into the slot: its middle, give or take, at the foot of the board.
          tx = rights + 1 + (random() - 0.5) * (attempt < 8 ? 0.3 : 0.04);
          ty = floorOf(rows);
        } else {
          // Onto the peg's shoulder on the side the path goes: a few degrees off its top.
          const angle = ((6 + random() * 16) * (1 - attempt / 16) * Math.PI) / 180;
          tx = peg.x + side * TOUCH * Math.sin(angle);
          ty = peg.y - TOUCH * Math.cos(angle);
        }
        const dt = flight(y, vy, ty);
        if (!(dt > 0.02)) continue;
        const candidate = { t: clock, dt, x, y, vx: (tx - x) / dt, vy };
        // Leaving a peg, the ball heads off the side it is on: the way the path went.
        if (fromPeg && Math.sign(candidate.vx) !== Math.sign(x - fromPeg.x) && Math.abs(candidate.vx) > 0.05) continue;
        const near = nearest(candidate, pegs);
        if (near >= TOUCH - 0.002) arc = candidate;
        else if (!best || near > best.near) best = { arc: candidate, near };
      }
      if (arc) break;
    }
    if (!arc) {
      // Nothing quite clean: the one that passes nearest to clear (a hair's graze at most).
      rough += 1;
      arc = best?.arc;
    }
    if (!arc) {
      const vy = leave(BOUNCE[0]);
      const tx = last ? rights + 1 : peg.x + side * TOUCH * 0.2;
      const ty = last ? floorOf(rows) : peg.y - TOUCH * 0.98;
      const dt = flight(y, vy, ty);
      arc = { t: clock, dt, x, y, vx: (tx - x) / dt, vy };
    }
    arcs.push(arc);
    clock += arc.dt;
    x = arc.x + arc.vx * arc.dt;
    y = arc.y + arc.vy * arc.dt + 0.5 * GRAVITY * arc.dt * arc.dt;
    if (last) break;

    hits.push({ t: clock * 1000, peg: `${r}:${1 + rights}`, row: r });
    // The bounce: the speed into the peg comes back out along the line between their centres, less
    // what the contact takes; the speed along the peg mostly carries on.
    const inVx = arc.vx;
    const inVy = arc.vy + GRAVITY * arc.dt;
    const nx = (x - peg.x) / TOUCH;
    const ny = (y - peg.y) / TOUCH;
    const into = inVx * nx + inVy * ny;
    const alongY = inVy - into * ny;
    leave = (bounce) => alongY * SCUFF - into * bounce * ny;
    from = r;
    fromPeg = peg;
    rights += path[r] ? 1 : 0;
  }
  return { arcs, hits, duration: clock * 1000, rough };
}

/** Where the ball is `ms` into its fall. `cursor` ({ i }) remembers the arc it was last on. */
export function fallAt(fall, ms, cursor = { i: 0 }) {
  const s = Math.max(0, ms) / 1000;
  const { arcs } = fall;
  let i = Math.min(cursor.i, arcs.length - 1);
  while (i < arcs.length - 1 && s > arcs[i].t + arcs[i].dt) i += 1;
  cursor.i = i;
  const arc = arcs[i];
  const t = Math.min(arc.dt, Math.max(0, s - arc.t));
  return { x: arc.x + arc.vx * t, y: arc.y + arc.vy * t + 0.5 * GRAVITY * t * t };
}
