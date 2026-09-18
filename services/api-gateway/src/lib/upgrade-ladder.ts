import { createHash } from 'node:crypto';

/**
 * The upgrader's prize ladder: fifty-one fixed denominations from $100,000 to $10,000,000,000.
 *
 * WHAT THESE ARE
 * --------------
 * They are not Minecraft items and nothing about them is ever delivered in game. The upgrader runs
 * in cash-only mode (`CASH_ONLY_PLAY`), where a win credits the target's full value to the wallet
 * and reserves no lot, draws nothing out of house stock, and needs no bot. The catalogue row exists
 * only to give the round a target with a price attached — the price IS the prize.
 *
 * That is why they are named for their denomination rather than for a pretend artefact. A player
 * chasing the "6.5B Reserve" is chasing $6,500,000,000, and calling it a Dragon Egg would hide the
 * one fact that matters at the moment they commit a stake.
 *
 * WHY A LADDER AND NOT A HANDFUL
 * ------------------------------
 * The server only accepts a target between MIN_MULTIPLIER_BPS and MAX_MULTIPLIER_BPS of the stake
 * — 1.1x to 100x as configured. A sparse catalogue means a player picks a stake and finds two legal
 * targets, or none. Ten rungs per decade (ratio ~1.26) puts roughly twenty targets inside that
 * window at any stake in range, so the choice is a real one wherever they start.
 *
 * WHY THE VALUES ARE ROUND
 * ------------------------
 * Every rung is a figure a person can hold in their head and say out loud. A geometric ladder with
 * an exact ratio would have produced 1,258,925 and 1,584,893; those are the same spacing and a
 * worse number to bet on.
 */

/** The banding. Each tier owns one piece of art, so the value band is readable before the label. */
export interface LadderTier {
  readonly tier: number;
  readonly noun: string;
  readonly art: string;
}

const TIERS: readonly LadderTier[] = [
  { tier: 1, noun: 'Chip', art: 'assets/img/items/ladder-chip.svg' },
  { tier: 2, noun: 'Stack', art: 'assets/img/items/ladder-stack.svg' },
  { tier: 3, noun: 'Crate', art: 'assets/img/items/ladder-crate.svg' },
  { tier: 4, noun: 'Vault', art: 'assets/img/items/ladder-vault.svg' },
  { tier: 5, noun: 'Reserve', art: 'assets/img/items/ladder-reserve.svg' },
  // The ceiling gets art of its own. It is the only rung a player can never upgrade out of, and it
  // should not look like the nine rungs below it.
  { tier: 6, noun: 'Sovereign', art: 'assets/img/items/ladder-sovereign.svg' },
];

/** Ten steps per decade. The gap between neighbours is 1.25x-1.33x, comfortably over the 1.1x floor. */
const STEPS = [100, 125, 150, 200, 250, 300, 400, 500, 650, 800] as const;

const DECADES = [
  { base: 1_000n, tier: 1, suffix: 'K', unit: 1_000 },
  { base: 10_000n, tier: 2, suffix: 'M', unit: 1_000_000 },
  { base: 100_000n, tier: 3, suffix: 'M', unit: 1_000_000 },
  { base: 1_000_000n, tier: 4, suffix: 'M', unit: 1_000_000 },
  { base: 10_000_000n, tier: 5, suffix: 'B', unit: 1_000_000_000 },
] as const;

export interface LadderRung {
  /** Whole DonutSMP dollars, as a decimal string. Despite the `_minor` column name this is not cents. */
  readonly unitValueMinor: string;
  /** The short form a player reads: 100K, 1.25M, 6.5B. */
  readonly label: string;
  /** What the catalogue calls it: "1.25M Stack". */
  readonly displayName: string;
  readonly minecraftName: string;
  readonly fingerprint: string;
  readonly imageUrl: string;
  readonly tier: number;
}

/** 1250000 -> "1.25M". Trailing zeros are dropped; a whole number never grows a ".0". */
function shortLabel(value: bigint, unit: number, suffix: string): string {
  const scaled = Number(value) / unit;
  return `${Number(scaled.toFixed(2))}${suffix}`;
}

/**
 * Stable across every run and every environment, because it is derived from the value alone.
 *
 * `catalog_items.fingerprint` is the natural key the upsert conflicts on, so re-publishing the
 * ladder has to land on the rows it landed on last time. Deriving it from the price means a rung
 * cannot be silently re-pointed at a different figure: a new price is a new row, not a quiet edit
 * of an old one.
 */
function fingerprintFor(unitValueMinor: string): string {
  return createHash('sha256').update(`donutdrop:upgrade-ladder:${unitValueMinor}`).digest('hex');
}

function rung(value: bigint, tier: number, unit: number, suffix: string): LadderRung {
  const unitValueMinor = value.toString();
  const band = TIERS[tier - 1];
  if (!band) throw new Error(`No ladder tier ${tier}`);
  const label = shortLabel(value, unit, suffix);
  return {
    unitValueMinor,
    label,
    displayName: `${label} ${band.noun}`,
    minecraftName: `upgrade_ladder_${unitValueMinor}`,
    fingerprint: fingerprintFor(unitValueMinor),
    imageUrl: band.art,
    tier,
  };
}

function buildLadder(): readonly LadderRung[] {
  const rungs: LadderRung[] = [];
  for (const decade of DECADES) {
    for (const step of STEPS) {
      rungs.push(rung(decade.base * BigInt(step), decade.tier, decade.unit, decade.suffix));
    }
  }
  rungs.push(rung(10_000_000_000n, 6, 1_000_000_000, 'B'));
  return rungs;
}

export const UPGRADE_LADDER: readonly LadderRung[] = buildLadder();

export const LADDER_FLOOR_MINOR = 100_000n;
export const LADDER_CEILING_MINOR = 10_000_000_000n;

/** Marks a row as ours, so the ladder can be told apart from items a bot actually observed. */
export const LADDER_METADATA = { upgradeLadder: true } as const;

export function ladderMetadataFor(rung: LadderRung): Record<string, unknown> {
  return { ...LADDER_METADATA, tier: rung.tier, label: rung.label };
}
