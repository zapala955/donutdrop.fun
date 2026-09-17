/* mystery.js — the golden question mark: which drops are behind it, and what plays when one lands.
 *
 * This file does NOT implement an animation. The two-stage mystery reveal already existed, and it
 * is the one sitting in the dev animation bench as preset 2, "Gold tier tease → keynote":
 *
 *     await playReel({ item, crate, pool, mystery: true });   // stage one — the gold slot
 *     return playCutscene({ item, crate, pool });             // stage two — the keynote
 *
 * That pairing is the template, so this module composes it rather than reinventing it. An earlier
 * version of this file painted its own CSS overlay — a dimmed veil, a breathing `?`, some embers —
 * which looked close enough in a screenshot and was worse in every way that matters:
 *
 *   - reel.js in mystery mode never draws the item onto the canvas at all. The winning slot is a
 *     gold tile with NO sprite, so there is nothing to glimpse as the strip decelerates and
 *     nothing to recover from a frame grab. A CSS overlay that hides the payload behind an opaque
 *     div still has the payload in the DOM.
 *   - the reel already reads "TOP TIER SECURED / Unidentified / opening…" during the tease, so the
 *     tier is disclosed and the identity is not, which is exactly the right amount to say.
 *   - cutscene.js draws its decoy silhouettes from the crate's real pool, so the near-misses on
 *     screen are outcomes that could genuinely have happened.
 *   - and it is one animation engine to maintain, tuned once, instead of two that drift.
 *
 * What is left here is the part that genuinely did not exist: knowing which drops are mysteries,
 * what the published odds are, and splitting a crate's table into the visible part and the hidden
 * one so the drop drawer can render a `?` tile with real odds beside it.
 */

/**
 * Plays the full two-stage mystery reveal.
 *
 * Stage one is the reel with the gold slot; stage two is the keynote cinematic. Identical to what
 * the dev bench plays for a jackpot, because a mystery landing IS the jackpot.
 *
 * @param {object}   options
 * @param {object}   options.item    the payload that was actually won
 * @param {object}  [options.crate]  the crate it came out of — feeds the strip and the decoys
 * @param {object[]}[options.pool]   outcomes to build the strip from; defaults to the crate's
 * @param {boolean} [options.skipReel] true when the caller already ran the reel, so only the
 *                                     keynote is still owed
 */
export async function playMystery({ item, crate, pool, skipReel = false }) {
  if (!item) return;

  const [{ playReel }, { playCutscene }] = await Promise.all([
    import('./reel.js'),
    import('./cutscene.js'),
  ]);

  const strip = (pool && pool.length ? pool : crate?.drops) || [item];

  if (!skipReel) {
    /* Stage one. `mystery: true` swaps the winning tile for the gold slot; `mysteryOdds` is what
     * the reel prints beside the crate name for the whole spin, so the decorative question marks
     * padding the strip can never be mistaken for the real rate. */
    await playReel({ item, crate, pool: strip, mystery: true, mysteryOdds: mysteryOdds(crate) });
  }
  // Stage two. The payload is named here and nowhere earlier.
  await playCutscene({ item, crate, pool: strip });
}

/** True when this item is a payload that belongs behind the question mark. */
export function isMystery(item) {
  return !!item && (item.mystery === true || item.metadata?.mystery === true);
}

/**
 * The published odds of a crate's mystery slot, as a denominator.
 *
 * Read from the crate's own metadata when present, and otherwise derived from the drop weights,
 * so the figure on screen is the one the server will actually roll rather than a constant typed
 * into the client.
 */
export function mysteryOdds(crate) {
  const stated = Number(crate?.metadata?.mystery?.oddsDenominator ?? 0);
  if (stated > 1) return Math.round(stated);

  const drops = crate?.drops ?? [];
  const total = drops.reduce((sum, drop) => sum + Number(drop.weight || 0), 0);
  const mysteryWeight = drops
    .filter((drop) => isMystery(drop))
    .reduce((sum, drop) => sum + Number(drop.weight || 0), 0);
  if (!total || !mysteryWeight) return 0;
  return Math.round(total / mysteryWeight);
}

/** The mystery drops of a crate, as a list. */
export function mysteryDrops(crate) {
  return (crate?.drops ?? []).filter((drop) => isMystery(drop));
}

/** Every drop that is NOT behind the question mark. */
export function ordinaryDrops(crate) {
  return (crate?.drops ?? []).filter((drop) => !isMystery(drop));
}

/**
 * The sub-pool, as published: each payload with its chance GIVEN the slot landed, and its true
 * end-to-end chance from a single open.
 *
 * Both numbers matter and they differ by orders of magnitude. "1 in 1,613 of the hits" is what a
 * player wants when comparing payloads against each other; "1 in 1.5 million per open" is what
 * they need to understand what they are actually buying. Showing only the first would be the more
 * flattering of the two and the less honest.
 *
 * Derived from the stored weights rather than from the metadata, so the figures on screen are the
 * ones the server will roll even if a crate was seeded by an older generator.
 */
export function mysteryPayloads(crate) {
  const drops = crate?.drops ?? [];
  const total = drops.reduce((sum, drop) => sum + Number(drop.weight || 0), 0);
  const hidden = drops.filter((drop) => isMystery(drop));
  const hiddenWeight = hidden.reduce((sum, drop) => sum + Number(drop.weight || 0), 0);
  if (!total || !hiddenWeight) return [];

  return hidden
    .slice()
    .sort((left, right) => left.value - right.value)
    .map((drop) => ({
      name: drop.displayName || drop.name,
      img: drop.img,
      value: drop.value,
      shareOfPool: Number(drop.weight || 0) / hiddenWeight,
      chancePerOpen: Number(drop.weight || 0) / total,
    }));
}

/**
 * The floor THIS crate's payloads are guaranteed to clear, in minor units.
 *
 * Not a platform constant any more. The floor scales with the crate: a 5,000 crate guarantees
 * $100M, a 150,000,000 crate guarantees $375M, and the rule behind both is that a mystery hit
 * must be worth at least two and a half times what the crate cost. Printing a flat "$100M+" on a
 * high-roller crate would understate its own guarantee by nearly four times.
 *
 * Read from the crate's published metadata, and otherwise derived from the cheapest payload the
 * crate actually holds — so a crate seeded by an older generator still shows a true figure rather
 * than a stale constant.
 */
export function mysteryFloor(crate) {
  const stated = Number(crate?.metadata?.mystery?.valueFloorMinor ?? 0);
  if (stated > 0) return stated;
  const hidden = mysteryDrops(crate);
  if (!hidden.length) return 0;
  return hidden.reduce((least, drop) => Math.min(least, drop.value), Infinity);
}

/**
 * The worst possible mystery payout, as a multiple of the crate price.
 *
 * The guarantee in one number: "even the smallest thing behind this `?` pays 2.6x". It is the
 * single most useful figure about the slot and it is different on every tier, so it is derived
 * rather than assumed.
 */
export function mysteryWorstMultiple(crate) {
  const stated = Number(crate?.metadata?.mystery?.worstMultiple ?? 0);
  if (stated > 0) return stated;
  const floor = mysteryFloor(crate);
  return crate?.price > 0 && floor > 0 ? floor / crate.price : 0;
}

/**
 * Force-dismisses any reveal currently on screen.
 *
 * reel.js and cutscene.js both resolve only when the player presses their button — they are
 * dismissed, not timed. That is the right behaviour for a reveal, but it means a caller that
 * races one against a timeout can have the race resolve while the pane is still up: the page
 * re-enables underneath a full-screen canvas that nobody can now get rid of, and the next open
 * starts a second animation on top of the first.
 *
 * This presses the button rather than hiding the node, so each module runs its own teardown —
 * cancelAnimationFrame, listener removal, and resolving its promise — instead of being left with
 * an orphaned render loop burning a core for the rest of the session.
 */
export function dismissReveals() {
  for (const selector of ['#reelBtn', '#cutBtn']) {
    const button = document.querySelector(selector);
    // offsetParent is null for anything inside a hidden pane, so this only fires on a live one.
    if (button instanceof HTMLElement && button.offsetParent !== null) button.click();
  }
}
