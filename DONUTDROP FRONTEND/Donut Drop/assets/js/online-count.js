/* online-count.js — the live player counter.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THIS NUMBER IS SIMULATED, AND THE CODE SAYS SO OUT LOUD
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * It is not a count of anybody. It is a smoothed random walk inside a configured band, and it is
 * the ONLY simulated figure anywhere on this platform: every balance, payout, leaderboard row,
 * ticker entry and chat line is a real server fact. That boundary is deliberate and worth keeping
 * — the moment a fake number sits next to a fake bet, nothing on the page can be trusted.
 *
 * `SIMULATED` below is exported so a caller can tell the truth about it in an interface, and
 * `setPresenceSource` swaps the whole module onto a real presence feed the day there is one, with
 * no change to anything that consumes it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY A SINE PLUS A JITTER RATHER THAN A RANDOM NUMBER
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A number that jumps anywhere in the band every few seconds reads as broken — real traffic has a
 * shape. So the figure is a slow sine (the daily swell, compressed to a few minutes) with a small
 * bounded random walk on top: it drifts, it never teleports, and consecutive readings are related
 * to each other the way consecutive readings of a real counter are.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * IT MUST NOT COST A FRAME
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Subscribers are handed a number and write it into a text node themselves. Nothing here re-renders
 * a component or replaces an element, and every target is given a fixed-width tabular font in CSS,
 * so a three-digit count changing cannot reflow the header it sits in.
 */

/** This figure is not measured. Nothing else on the platform shares this property. */
export const SIMULATED = true;

/** The band, inclusive. Centred on the midpoint rather than on a separate baseline constant. */
export const FLOOR = 400;
export const CEILING = 700;

/** The swell: one full cycle every seven minutes, so a session sees it move without watching it. */
const CYCLE_MS = 7 * 60 * 1000;
/** How much of the band the sine owns. The rest is walk. */
const SWELL_SHARE = 0.55;

/** A new reading lands somewhere in this window, never on a fixed beat. */
const MIN_STEP_MS = 2000;
const MAX_STEP_MS = 5000;
/** Each step moves by at least this and at most this, in players. */
const MIN_JITTER = 2;
const MAX_JITTER = 9;

const MID = (FLOOR + CEILING) / 2;
const HALF_BAND = (CEILING - FLOOR) / 2;

let subscribers = new Set();
let timer = 0;
let started = 0;
/** The walk's own offset from the swell. Bounded so the two together stay inside the band. */
let drift = 0;
let current = Math.round(MID);
/** Swapped out by setPresenceSource when a real feed exists. */
let source = null;

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

/**
 * The next reading.
 *
 * The swell is deterministic from the clock; the drift is a bounded random walk that is nudged back
 * toward zero as it approaches its own limit, so the figure cannot stick to the floor or the
 * ceiling for minutes at a time the way an unbiased walk eventually will.
 */
function nextCount() {
  const elapsed = Date.now() - started;
  const swell = Math.sin((elapsed / CYCLE_MS) * Math.PI * 2) * HALF_BAND * SWELL_SHARE;

  const room = HALF_BAND * (1 - SWELL_SHARE);
  const step = MIN_JITTER + Math.random() * (MAX_JITTER - MIN_JITTER);
  /* Pulled toward the middle in proportion to how far out it already is. At the centre it is a
   * coin flip; near the edge it is heavily biased back inward. */
  const pullInward = drift / room;
  const goesUp = Math.random() > 0.5 + pullInward * 0.42;
  drift = clamp(drift + (goesUp ? step : -step), -room, room);

  return Math.round(clamp(MID + swell + drift, FLOOR, CEILING));
}

function tick() {
  current = source ? source() : nextCount();
  for (const notify of subscribers) {
    try {
      notify(current);
    } catch {
      /* One bad subscriber must not stop the counter for the others. */
    }
  }
  timer = window.setTimeout(tick, MIN_STEP_MS + Math.random() * (MAX_STEP_MS - MIN_STEP_MS));
}

/**
 * Subscribes to the counter. Returns an unsubscribe function.
 *
 * The callback fires immediately with the current value, so a element that mounts late is never
 * blank waiting for the next step.
 */
export function onOnlineCount(callback) {
  if (typeof callback !== 'function') return () => {};
  if (!started) {
    started = Date.now();
    current = nextCount();
  }
  subscribers.add(callback);
  callback(current);
  if (!timer) {
    timer = window.setTimeout(tick, MIN_STEP_MS + Math.random() * (MAX_STEP_MS - MIN_STEP_MS));
  }
  return () => {
    subscribers.delete(callback);
    if (subscribers.size === 0) {
      window.clearTimeout(timer);
      timer = 0;
    }
  };
}

/** The last reading, for anything that wants the number once rather than a subscription. */
export function currentOnlineCount() {
  if (!started) {
    started = Date.now();
    current = nextCount();
  }
  return current;
}

/**
 * Replaces the simulation with a real presence feed.
 *
 * The day this platform can count sockets, pass a function that returns the real figure and every
 * subscriber switches over with no other change. Pass null to go back to the simulation.
 */
export function setPresenceSource(readCount) {
  source = typeof readCount === 'function' ? readCount : null;
}

/**
 * Binds the counter to elements, writing into a text node and nothing else.
 *
 * `document.createTextNode` rather than `textContent` on the element: the targets carry sibling
 * markup (a status dot, a label) and replacing textContent would delete it. Writing `node.data` is
 * also the cheapest mutation available and never touches layout beyond the glyphs themselves.
 */
export function bindOnlineCount(...elements) {
  const nodes = elements
    .filter(Boolean)
    .map((element) => {
      const existing = [...element.childNodes].find((node) => node.nodeType === Node.TEXT_NODE);
      if (existing) return existing;
      const created = document.createTextNode('');
      element.appendChild(created);
      return created;
    });
  if (!nodes.length) return () => {};
  return onOnlineCount((count) => {
    const text = String(count);
    for (const node of nodes) {
      if (node.data !== text) node.data = text;
    }
  });
}
