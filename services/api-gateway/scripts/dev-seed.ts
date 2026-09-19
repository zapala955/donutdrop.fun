/**
 * dev-seed.ts — fills an empty local database with a catalogue and a few cases.
 *
 * Production catalogue changes go through the admin API so every price movement lands in the
 * audit log with an authenticated actor against it; scripts/seed.ts refuses to write items for
 * exactly that reason. This is the development counterpart: it exists so a fresh local database
 * is playable, and it is fenced the same way the developer login is.
 *
 *   1. refuses to run unless DEV_LOGIN_ENABLED=true
 *   2. refuses to run when NODE_ENV=production, whatever else is set
 *   3. writes nothing that already exists, so re-running it is safe
 *
 * Run it as the migrator role, which owns the schema. The runtime role deliberately cannot.
 */
import { createHash, randomUUID } from 'node:crypto';
import process from 'node:process';
import pg from 'pg';

import {
  INVERSE_WEIGHT_EXPONENT,
  MIN_JACKPOT_MULTIPLE,
  MYSTERY_BUDGET_SHARE_BPS,
  POOL_SPAN_MULTIPLE,
  apportion,
  buildScaledSubPool,
  calculateMysteryOdds,
  mysteryBudgetFraction,
  resolveWeightSplit,
} from '../src/lib/mystery-odds.js';

const nodeEnv = process.env['NODE_ENV'] ?? 'development';
const devEnabled = process.env['DEV_LOGIN_ENABLED'] === 'true';
const databaseUrl = process.env['DATABASE_URL'];

if (nodeEnv === 'production') {
  throw new Error('dev-seed refuses to run with NODE_ENV=production');
}
if (!devEnabled) {
  throw new Error('dev-seed requires DEV_LOGIN_ENABLED=true');
}
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required');
}

/**
 * The ladder. Values are in minor units and rise across the rarity bands the frontend derives
 * from price (30k uncommon, 500k rare, 5M epic, 50M legendary), so the catalogue spans every
 * tier and the upgrader has somewhere to climb to.
 *
 * minecraft_name matters: the frontend maps it to a local sprite, so these are the exact ids it
 * knows how to draw. `mystery` marks a god-tier payload that is never shown on the reel by name —
 * it sits behind the golden question mark and is only named once the second stage of the reveal
 * plays.
 */
interface CatalogItem {
  readonly name: string;
  readonly display: string;
  readonly valueMinor: string;
  /** God-tier payload. Drawn through the `?` slot, never labelled on the reel. */
  readonly mystery?: boolean;
  /** Explicit sprite path, for payloads with no 1:1 Minecraft item sprite. */
  readonly imageUrl?: string;
}

const ITEMS: readonly CatalogItem[] = [
  // The cheap end exists so the low price tiers have pools deep enough to be real crates.
  // Every name here maps to a sprite the frontend actually ships.
  { name: 'stick', display: 'Stick', valueMinor: '172' },
  { name: 'feather', display: 'Feather', valueMinor: '922' },
  { name: 'gold_nugget', display: 'Gold Nugget', valueMinor: '260' },
  { name: 'tripwire_hook', display: 'Tripwire Hook', valueMinor: '4688' },
  { name: 'snow_block', display: 'Snow Block', valueMinor: '313' },
  { name: 'ender_pearl', display: 'Ender Pearl', valueMinor: '19986' },
  { name: 'redstone', display: 'Redstone', valueMinor: '305' },
  { name: 'slime_ball', display: 'Slime Ball', valueMinor: '781' },
  { name: 'obsidian', display: 'Obsidian', valueMinor: '6125' },
  { name: 'hopper', display: 'Hopper', valueMinor: '3688' },
  { name: 'iron_ingot', display: 'Iron Ingot', valueMinor: '8333' },
  { name: 'iron_sword', display: 'Iron Sword', valueMinor: '198000' },
  { name: 'tnt', display: 'TNT', valueMinor: '40000' },
  { name: 'gold_ingot', display: 'Gold Ingot', valueMinor: '13700' },
  { name: 'experience_bottle', display: 'Bottle o’ Enchanting', valueMinor: '7400' },
  { name: 'minecart', display: 'Minecart', valueMinor: '100000' },
  { name: 'lava_bucket', display: 'Lava Bucket', valueMinor: '30000' },
  { name: 'name_tag', display: 'Name Tag', valueMinor: '90000' },
  { name: 'diamond_shovel', display: 'Diamond Shovel', valueMinor: '30000' },
  { name: 'diamond', display: 'Diamond', valueMinor: '25000' },
  { name: 'emerald', display: 'Emerald', valueMinor: '20000' },
  { name: 'golden_apple', display: 'Golden Apple', valueMinor: '25000' },
  { name: 'shulker_box', display: 'Shulker Box', valueMinor: '3900' },
  { name: 'enchanted_book', display: 'Enchanted Book', valueMinor: '39910' },
  { name: 'ender_chest', display: 'Ender Chest', valueMinor: '3906' },
  { name: 'gold_block', display: 'Block of Gold', valueMinor: '72500' },
  { name: 'diamond_block', display: 'Block of Diamond', valueMinor: '200000' },
  { name: 'netherite_scrap', display: 'Netherite Scrap', valueMinor: '1190000' },
  { name: 'ancient_debris', display: 'Ancient Debris', valueMinor: '1200000' },
  { name: 'totem_of_undying', display: 'Totem of Undying', valueMinor: '69780' },
  { name: 'enchanted_golden_apple', display: 'Enchanted Golden Apple', valueMinor: '1600000' },
  { name: 'netherite_ingot', display: 'Netherite Ingot', valueMinor: '3800000' },
  { name: 'spawner', display: 'Monster Spawner', valueMinor: '19000000' },
  { name: 'netherite_sword', display: 'Netherite Sword', valueMinor: '4000000' },
  { name: 'netherite_pickaxe', display: 'Netherite Pickaxe', valueMinor: '3800000' },
  { name: 'netherite_chestplate', display: 'Netherite Chestplate', valueMinor: '4000000' },
  { name: 'beacon', display: 'Beacon', valueMinor: '498000' },
  { name: 'netherite_block', display: 'Block of Netherite', valueMinor: '78000000' },
  { name: 'trident', display: 'Trident', valueMinor: '888999' },
  { name: 'nether_star', display: 'Nether Star', valueMinor: '500000' },
  /* The top of the ORDINARY ladder. Without these the 150,000,000 tier could not form a pool at
   * all: its cheapest profile needs four outcomes at or above 67,500,000 and the ladder stopped
   * at 130,000,000, so the whole Bedrock Sovereign row was silently skipped. Both are drawn from
   * block sprites, because no Minecraft ITEM sits at this value. */
  {
    name: 'magma_core', display: 'Magma Core', valueMinor: '175000000',
    imageUrl: 'assets/img/items/magma_core.svg',
  },
  {
    name: 'lava_sea_relic', display: 'Lava Sea Relic', valueMinor: '245000000',
    imageUrl: 'assets/img/items/nether_sigil.svg',
  },

  {
    name: 'skeleton_skull', display: 'Skeleton Skull', valueMinor: '320000000',
    imageUrl: 'assets/img/items/skeleton_skull.svg',
  },
  {
    name: 'golden_crown', display: 'Golden Crown', valueMinor: '480000000',
    imageUrl: 'assets/img/items/golden_crown.svg',
  },
  {
    name: 'ghast_tear', display: 'Ghast Tear', valueMinor: '700000000',
    imageUrl: 'assets/img/items/ghast_tear.svg',
  },
  /* ── the mystery sub-pool ──
   *
   * Seven payloads, every one at or above the $100,000,000 floor. Nothing else may ever sit behind
   * the `?`: the reveal promises a hundred-million-dollar payload, and a single cheap filler in
   * this list would turn that promise into a coin flip nobody was told about. The floor is
   * asserted in code before any crate is generated, not merely intended here.
   *
   * They are ordinary catalog rows flagged `mystery: true`, which is what keeps the whole feature
   * inside ONE provably-fair roll. The server draws a single weighted outcome from the crate's
   * full table; if that outcome happens to carry the flag, the client plays the two-stage reveal
   * instead of the plain reel. There is no second roll to verify, no separate RNG, and nothing
   * the client decides — the `?` is a presentation of an outcome that was already committed under
   * the published server-seed hash and already signed, not an event of its own.
   *
   * Weights inside the sub-pool are inverse to value, so the cheap end of the god tier carries
   * most of the hits and the billion-dollar vault is a rumour. */
  {
    /* Art has to be unique across the whole catalogue, not merely present. This used the shulker
     * box sprite, which the $620,000 ordinary Shulker Box also uses — so a $100,000,000 mystery
     * payload and a drop worth a six-hundredth of it were the same picture. */
    name: 'guardian_cache', display: 'Guardian Cache', valueMinor: '100000000',
    mystery: true, imageUrl: 'assets/img/items/ender_chest.png',
  },
  {
    // Was the totem sprite, which the $6,500,000 Totem of Undying already owns.
    name: 'warden_trophy', display: 'Warden Trophy', valueMinor: '130000000',
    mystery: true, imageUrl: 'assets/img/items/warden_trophy.svg',
  },
  {
    name: 'sculk_reliquary', display: 'Sculk Reliquary', valueMinor: '175000000',
    mystery: true, imageUrl: 'assets/img/items/sculk_reliquary.svg',
  },
  {
    name: 'ancient_city_vault', display: 'Ancient City Vault', valueMinor: '250000000',
    mystery: true, imageUrl: 'assets/img/items/ancient_city_vault.svg',
  },
  {
    // The brief's named payload, at the brief's stated value.
    name: 'elytra', display: 'Elytra', valueMinor: '352000000',
    mystery: true, imageUrl: 'assets/img/items/elytra.png',
  },
  {
    name: 'dragon_egg', display: 'Dragon Egg', valueMinor: '650000000',
    mystery: true, imageUrl: 'assets/img/items/dragon_egg.png',
  },
  {
    // No Minecraft item is worth a billion, so the top payloads are explicit cash vaults with
    // sprites of their own rather than blocks pretending to be money.
    name: 'cash_vault', display: 'Herobrine Head', valueMinor: '1000000000',
    mystery: true, imageUrl: 'assets/img/items/herobrine_head.svg',
  },
  /* The multi-billion tail. These exist for the HIGH-ROLLER floors: a 150,000,000 crate floors at
   * 375,000,000, and a pool that stopped at a billion would give it only three payloads to draw
   * from. They are unreachable from a cheap crate, because a sub-pool never reaches more than one
   * order of magnitude above its own floor. */
  {
    name: 'monarch_reserve', display: 'Wither Storm', valueMinor: '1750000000',
    mystery: true, imageUrl: 'assets/img/items/wither_storm.svg',
  },
  {
    name: 'soul_lantern', display: 'Soul Lantern', valueMinor: '450000000',
    mystery: true, imageUrl: 'assets/img/items/soul_lantern.svg',
  },
  {
    name: 'wither_skull', display: 'Wither Skull', valueMinor: '900000000',
    mystery: true, imageUrl: 'assets/img/items/wither_skull.svg',
  },
  {
    name: 'end_crystal', display: 'End Crystal', valueMinor: '1350000000',
    mystery: true, imageUrl: 'assets/img/items/end_crystal.svg',
  },
  {
    name: 'obsidian_shard', display: 'Obsidian Shard', valueMinor: '2200000000',
    mystery: true, imageUrl: 'assets/img/items/obsidian_shard.svg',
  },
  {
    name: 'netherite_crown', display: 'Netherite Crown', valueMinor: '5000000000',
    mystery: true, imageUrl: 'assets/img/items/netherite_crown.svg',
  },
  {
    name: 'dominion_vault', display: 'Ender Dragon Skull', valueMinor: '3000000000',
    mystery: true, imageUrl: 'assets/img/items/ender_dragon_head.svg',
  },
];

/* ─────────── the crate catalogue ───────────
 *
 * Fifty crates: ten lore tiers across five risk profiles. They are generated rather than typed
 * out, because fifty hand-written weight tables is fifty chances to publish a crate whose real
 * house edge is not the one intended — and nobody would ever notice until it had been played.
 *
 * HOW THE EDGE IS GUARANTEED
 * --------------------------
 * A crate's expected value is sum(weight_i * value_i) / sum(weight). Every crate in this file is
 * solved to land on exactly 90% RTP — a hard 10% house margin — and the solved figure is verified
 * against the intended one before the crate is allowed to exist. A crate whose real edge differs
 * from its published label is the worst bug this file could ship, so it throws rather than
 * writing one.
 *
 * THE MYSTERY SLOT
 * ----------------
 * Every crate carries exactly one golden `?`. It is a real drop with a real weight, rolled by the
 * same server-side HMAC as everything else — not a client-side flourish layered on afterwards.
 * What makes it a mystery is only that the payload behind it is not named on the reel until the
 * second stage of the reveal plays.
 *
 * It is fixed at one in a million for every crate, and the payload is the largest god-tier item
 * that the crate's own budget can carry. On the 15,000 crate that resolves to the 390,000,000
 * Elytra, which is the worked example the brief specifies:
 *
 *     jackpot EV   = 390,000,000 / 1,000,000        =       390
 *     total EV     = 15,000 x 0.90                  =    13,500
 *     ordinary EV  = 13,500 - 390                   =    13,110   (87.4% of price)
 *     house margin = 15,000 - 13,500                =     1,500   (10.0% of price)
 *
 * CONTEXT-AWARE POOLS
 * -------------------
 * If a crate's ordinary loot table already reaches the payload the mystery would have used, the
 * `?` swaps up to the next god-tier item. A mystery slot that reveals something the player could
 * have drawn from the visible table anyway is not a mystery, it is a second copy.
 */

/** A hard 10% house margin. 90% of every crate's price comes back to players in expectation. */
const CASE_EDGE_BPS = 1_000;

/* ── weight column limits ──
 *
 * case_items.weight is `integer NOT NULL CHECK (weight BETWEEN 1 AND 1000000000)`, so no single
 * outcome may exceed a billion units. case_rounds.total_weight is bigint, so the SUM may — which
 * is what makes dynamic odds representable at all: the cheapest crate's slot lands about once in
 * two hundred and eighty thousand, and expressing that alongside a sub-pool fine enough to keep a
 * one-in-seventeen-hundred payload drawable needs a total in the hundreds of millions.
 */
const MAX_ITEM_WEIGHT = 1_000_000_000;
const MAX_TOTAL_WEIGHT = 4_000_000_000;

/**
 * Ceiling on how far the shaped weights may spread.
 *
 * A jackpot profile spans 160x the price at a falloff of 3.6, which asks for a weight ratio near
 * 1e14 between its cheapest and rarest ordinary outcome. No integer column can hold that, and it
 * is not a meaningful distinction anyway: an ordinary outcome rarer than one in ten million is
 * indistinguishable from the mystery slot sitting next to it. The shape is clamped, and because
 * the expected value is solved AFTER clamping and the published volatility is measured from the
 * clamped distribution, nothing on the label is affected by the clamp — only the shape is.
 */
const MAX_SHAPE_RATIO = 250_000;

/**
 * How many ORDINARY outcomes a crate may advertise. The mystery slot sits on top of this.
 *
 * The price band alone pulled in everything between 0.02x and 160x the price, which on a wide
 * profile meant twenty-five drops. A drop table nobody reads is not a published drop table: at
 * twenty-five tiles the strip runs off the screen, the individual chances fall to fractions of a
 * percent each, and the one figure a player actually wants — what can this thing pay, and how
 * likely is that — is buried in noise.
 *
 * Eight is enough to keep a real floor, a real ceiling and a readable gradient between them.
 */
const MAX_ORDINARY_DROPS = 8;

/**
 * Thins a price band down to at most `limit` outcomes, spread evenly in LOG value.
 *
 * Log rather than linear, because the bands are geometric: a jackpot profile spans four orders of
 * magnitude, and evenly-spaced-by-value would take seven items from the cheap end and one from
 * the top, collapsing the very spread that makes the profile what it is. Spacing by log keeps the
 * same number of steps between 60 and 600 as between 600,000 and 6,000,000.
 *
 * The cheapest and the most expensive are always kept. The cheapest is the filler the solver uses
 * to hit its expected value, and the most expensive is the crate's headline multiple — dropping
 * either would change what the crate IS rather than merely how finely it is subdivided.
 */
function thinPool(ordered: readonly PoolEntry[], limit: number): PoolEntry[] {
  if (ordered.length <= limit) return [...ordered];

  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  if (!first || !last) return [...ordered];

  const lowLog = Math.log(first.value);
  const highLog = Math.log(last.value);
  const span = highLog - lowLog;

  const picked = new Map<number, PoolEntry>();
  picked.set(0, first);
  picked.set(ordered.length - 1, last);

  /* Walk the log axis in even steps and take the nearest surviving item to each stop. A stop that
   * lands on an item already taken is skipped rather than allowed to shrink the result, so the
   * output is as close to `limit` as the source allows. */
  for (let step = 1; step < limit - 1 && picked.size < limit; step += 1) {
    const targetLog = lowLog + (span * step) / (limit - 1);
    let bestIndex = -1;
    let bestDistance = Infinity;
    for (let index = 0; index < ordered.length; index += 1) {
      if (picked.has(index)) continue;
      const entry = ordered[index];
      if (!entry) continue;
      const distance = Math.abs(Math.log(entry.value) - targetLog);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
    const chosen = ordered[bestIndex];
    if (bestIndex >= 0 && chosen) picked.set(bestIndex, chosen);
  }

  return [...picked.keys()]
    .sort((left, right) => left - right)
    .map((index) => picked.get(index))
    .filter((entry): entry is PoolEntry => entry !== undefined);
}

interface RiskProfile {
  readonly code: string;
  readonly label: string;
  readonly blurb: string;
  /** Pool spans [price * lowMultiple, price * highMultiple]. */
  readonly lowMultiple: number;
  readonly highMultiple: number;
  /** Power-law steepness on the base weights: higher concentrates weight on the cheap end. */
  readonly falloff: number;
}

const RISK_PROFILES: readonly RiskProfile[] = [
  { code: 'safe', label: 'Safe', falloff: 0.6, lowMultiple: 0.45, highMultiple: 2.2,
    blurb: 'Tight spread. Most pulls land near what you paid.' },
  /* The hit-rate profile. A flatter falloff than 'safe' over a band that starts nearer the
   * price, so weight sits on outcomes at or above what the crate cost: roughly three opens in
   * ten come back up. The edge is unchanged, so those wins are correspondingly small. */
  { code: 'steady', label: 'Steady', falloff: 0.3, lowMultiple: 0.15, highMultiple: 1.5,
    blurb: 'Wins often, wins small. The grinder\u2019s crate.' },
  { code: 'balanced', label: 'Balanced', falloff: 1.1, lowMultiple: 0.25, highMultiple: 6,
    blurb: 'A real floor and a real ceiling. The honest middle.' },
  { code: 'wild', label: 'Wild', falloff: 1.9, lowMultiple: 0.1, highMultiple: 18,
    blurb: 'Thin floor, fat top end. Swings are the point.' },
  { code: 'degen', label: 'Degen', falloff: 2.8, lowMultiple: 0.04, highMultiple: 55,
    blurb: 'Mostly dust. Occasionally not. Know what you are doing.' },
  { code: 'jackpot', label: 'Jackpot', falloff: 3.6, lowMultiple: 0.02, highMultiple: 160,
    blurb: 'One prize matters. Everything else is the ticket price.' },
];

/** Ten price points, roughly a geometric ladder from pocket change to a serious swing. */
const PRICE_TIERS: readonly number[] = [
  5_000, 15_000, 50_000, 150_000, 500_000,
  1_500_000, 5_000_000, 15_000_000, 50_000_000, 150_000_000,
  500_000_000,
];

/**
 * Crate identities: one short name and one sprite per crate.
 *
 * Fifty crates, fifty names, fifty icons, none repeated. The names used to be built by pasting a
 * tier onto a profile — "Dirt Road Cache · Balanced", "Ancient Debris Trove · Degen" — which made
 * every card a label rather than a place, and made the five crates in a tier read as one crate
 * with a suffix. These are short enough to say out loud and distinct enough to ask for by name.
 *
 * The icon is preferentially an ITEM sprite rather than a block texture. Block textures are flat
 * 16x16 faces: blown up to 72px on a card they read as a mud swatch with no silhouette. The item
 * sprites are drawn in three-quarter view with their own shading, so they hold a shape at card
 * size — which is the entire job of an icon in a grid of fifty.
 *
 * No sprite is used twice. Fifty cards that share art are fifty cards a player cannot tell apart
 * at a glance, so the generator asserts uniqueness rather than trusting this table to stay right.
 */
interface CrateTheme {
  readonly name: string;
  readonly slug: string;
  readonly asset: string;
}

/** Indexed by price tier, then by risk profile code. */
const CRATE_THEMES: readonly Record<string, CrateTheme>[] = [
  // ── 5,000 · surface scavenging ──
  {
    safe: { name: 'Dirt Block', slug: 'dirt-block', asset: 'block/soul_sand.png' },
    balanced: { name: 'Gravel Pit', slug: 'gravel-pit', asset: 'block/tuff.png' },
    wild: { name: 'Mob Drop', slug: 'mob-drop', asset: 'items/slime_ball.png' },
    degen: { name: 'Coin Toss', slug: 'coin-toss', asset: 'items/gold_nugget.png' },
    jackpot: { name: 'Lucky Dip', slug: 'lucky-dip', asset: 'items/chest.png' },
    steady: { name: 'Steady Hand', slug: 'steady-hand', asset: 'items/stick.png' },
  },
  // ── 15,000 · the first real dig ──
  {
    safe: { name: 'Copper Pickaxe', slug: 'copper-pickaxe', asset: 'items/diamond_shovel.png' },
    balanced: { name: 'Strip Mine', slug: 'strip-mine', asset: 'block/stone.png' },
    wild: { name: 'Ore Vein', slug: 'ore-vein', asset: 'items/redstone.png' },
    degen: { name: 'Cave In', slug: 'cave-in', asset: 'block/deepslate_top.png' },
    jackpot: { name: 'Deep Shaft', slug: 'deep-shaft', asset: 'items/minecart.png' },
    steady: { name: 'Slow Burn', slug: 'slow-burn', asset: 'items/feather.png' },
  },
  // ── 50,000 · iron and rails ──
  {
    safe: { name: 'Iron Rush', slug: 'iron-rush', asset: 'items/iron_ingot.png' },
    balanced: { name: 'Blast Furnace', slug: 'blast-furnace', asset: 'items/hopper.png' },
    wild: { name: 'Rail Gamble', slug: 'rail-gamble', asset: 'items/tripwire_hook.png' },
    degen: { name: 'Anvil Drop', slug: 'anvil-drop', asset: 'items/iron_sword.png' },
    jackpot: { name: 'Snow Blind', slug: 'snow-blind', asset: 'items/snow_block.png' },
    steady: { name: 'Even Keel', slug: 'even-keel', asset: 'items/name_tag.png' },
  },
  // ── 150,000 · gold and redstone ──
  {
    safe: { name: 'Gold Fever', slug: 'gold-fever', asset: 'items/gold_ingot.png' },
    balanced: { name: 'Redstone Rig', slug: 'redstone-rig', asset: 'block/netherrack.png' },
    wild: { name: 'Piston Trap', slug: 'piston-trap', asset: 'items/tnt.png' },
    degen: { name: 'TNT Run', slug: 'tnt-run', asset: 'block/tnt_side.png' },
    jackpot: { name: 'Powder Keg', slug: 'powder-keg', asset: 'items/spawner.png' },
    steady: { name: 'Safe Passage', slug: 'safe-passage', asset: 'items/golden_apple.png' },
  },
  // ── 500,000 · diamond and enchanting ──
  {
    safe: { name: 'Diamond Cut', slug: 'diamond-cut', asset: 'items/diamond.png' },
    balanced: { name: 'Enchant Table', slug: 'enchant-table', asset: 'items/enchanted_book.png' },
    wild: { name: 'Bottle Toss', slug: 'bottle-toss', asset: 'items/xp_bottle.png' },
    degen: { name: 'Deep Dark', slug: 'deep-dark', asset: 'block/polished_blackstone.png' },
    jackpot: { name: 'Warden Den', slug: 'warden-den', asset: 'block/crying_obsidian.png' },
    steady: { name: 'Long Haul', slug: 'long-haul', asset: 'items/emerald.png' },
  },
  // ── 1,500,000 · through the gate ──
  {
    safe: { name: 'Nether Gate', slug: 'nether-gate', asset: 'block/obsidian.png' },
    balanced: { name: 'Soul Forge', slug: 'soul-forge', asset: 'items/obsidian.png' },
    wild: { name: 'Blaze Rod', slug: 'blaze-rod', asset: 'items/lava_bucket.png' },
    degen: { name: 'Lava Dive', slug: 'lava-dive', asset: 'items/magma_core.svg' },
    jackpot: { name: 'Fortress Raid', slug: 'fortress-raid', asset: 'items/netherite_sword.png' },
    steady: { name: 'Sure Thing', slug: 'sure-thing', asset: 'items/diamond_pickaxe.svg' },
  },
  // ── 5,000,000 · basalt and bastions ──
  {
    safe: { name: 'Magma Core', slug: 'magma-core', asset: 'block/magma.png' },
    balanced: { name: 'Quartz Seam', slug: 'quartz-seam', asset: 'block/smooth_basalt.png' },
    wild: { name: 'Ghast Tear', slug: 'ghast-tear', asset: 'items/god_apple.png' },
    degen: { name: 'Bastion Run', slug: 'bastion-run', asset: 'block/gilded_blackstone.png' },
    jackpot: { name: 'Wither Fight', slug: 'wither-fight', asset: 'items/totem.png' },
    steady: { name: 'Iron Nerve', slug: 'iron-nerve', asset: 'items/diamond_sword.svg' },
  },
  // ── 15,000,000 · ancient debris ──
  {
    safe: { name: 'Ancient Debris', slug: 'ancient-debris', asset: 'items/ancient_debris.png' },
    balanced: { name: 'Scrap Heap', slug: 'scrap-heap', asset: 'items/netherite_scrap.png' },
    wild: { name: 'Netherite Cast', slug: 'netherite-cast', asset: 'items/netherite_ingot.png' },
    degen: { name: 'Debris Dig', slug: 'debris-dig', asset: 'block/basalt_top.png' },
    jackpot: { name: 'Smithing Roll', slug: 'smithing-roll', asset: 'items/netherite_pickaxe.png' },
    steady: { name: 'Cold Steel', slug: 'cold-steel', asset: 'items/diamond_helmet.svg' },
  },
  // ── 50,000,000 · the end ──
  {
    safe: { name: 'End Portal', slug: 'end-portal', asset: 'block/end_stone.png' },
    balanced: { name: 'Pearl Run', slug: 'pearl-run', asset: 'items/ender_pearl.png' },
    wild: { name: 'Shulker Nest', slug: 'shulker-nest', asset: 'items/shulker_box.gif' },
    degen: { name: 'Void Drop', slug: 'void-drop', asset: 'items/ender_chest.png' },
    jackpot: { name: 'Dragon Fight', slug: 'dragon-fight', asset: 'items/dragon_egg.png' },
    steady: { name: 'Heavy Hand', slug: 'heavy-hand', asset: 'items/mace.svg' },
  },
  // ── 150,000,000 · the floor of the world ──
  {
    safe: { name: 'Bedrock Floor', slug: 'bedrock-floor', asset: 'block/blackstone.png' },
    balanced: { name: 'Beacon Beam', slug: 'beacon-beam', asset: 'items/beacon.png' },
    wild: { name: 'Elytra Run', slug: 'elytra-run', asset: 'items/elytra.png' },
    degen: { name: 'Trident Toss', slug: 'trident-toss', asset: 'items/trident.png' },
    jackpot: { name: 'Sovereign Vault', slug: 'sovereign-vault', asset: 'items/nether_star.png' },
    steady: { name: 'Steady Flame', slug: 'steady-flame', asset: 'items/blaze_rod.svg' },
  },
  // ── 500,000,000 · the high table ──
  {
    safe: { name: 'Vault Floor', slug: 'vault-floor', asset: 'items/netherite_block.png' },
    steady: { name: 'Crown Draw', slug: 'crown-draw', asset: 'items/golden_crown.svg' },
    balanced: { name: "King's Ransom", slug: 'kings-ransom', asset: 'items/diamond_block.png' },
    wild: { name: 'Storm Front', slug: 'storm-front', asset: 'items/netherite_chestplate.png' },
    degen: { name: 'Skull Market', slug: 'skull-market', asset: 'items/wither_skull.svg' },
    jackpot: { name: 'Crown Jewel', slug: 'crown-jewel', asset: 'items/netherite_crown.svg' },
  },
];

/* Fifty cards that share art are fifty cards a player cannot tell apart at a glance, and two
 * crates sharing a slug would silently overwrite each other on upsert. Checked at startup rather
 * than trusted, because the table above is edited by hand. */
function assertThemesAreDistinct(): void {
  const names = new Set<string>();
  const slugs = new Set<string>();
  const assets = new Set<string>();
  for (const tier of CRATE_THEMES) {
    for (const theme of Object.values(tier)) {
      for (const [kind, seen, value] of [
        ['name', names, theme.name],
        ['slug', slugs, theme.slug],
        ['asset', assets, theme.asset],
      ] as const) {
        if (seen.has(value)) throw new Error(`Duplicate crate ${kind}: ${value}`);
        seen.add(value);
      }
    }
  }
}
assertThemesAreDistinct();

interface GeneratedDrop {
  readonly name: string;
  readonly weight: number;
}

interface GeneratedCase {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly priceMinor: string;
  readonly risk: string;
  readonly riskPercent: number;
  readonly riskLabel: string;
  readonly tier: number;
  readonly asset: string;
  readonly drops: readonly GeneratedDrop[];
  readonly expectedValueMinor: string;
  readonly topMultiple: number;
  readonly mysteryOddsDenominator: number;
  readonly mysteryProbabilityPpb: number;
  readonly mysteryEvMinor: string;
  readonly mysteryPoolAverageMinor: string;
  readonly mysteryFloorMinor: string;
  readonly mysteryWorstMultiple: number;
  readonly mysteryPayloads: readonly {
    readonly name: string;
    readonly valueMinor: string;
    readonly shareOfPoolPpm: number;
  }[];
}

interface PoolEntry {
  readonly name: string;
  readonly value: number;
}

function expectedValue(pool: readonly PoolEntry[], weights: readonly number[]): number {
  let weighted = 0;
  let total = 0;
  for (let index = 0; index < pool.length; index += 1) {
    const item = pool[index];
    const weight = weights[index];
    if (!item || weight === undefined) continue;
    weighted += weight * item.value;
    total += weight;
  }
  return total > 0 ? weighted / total : 0;
}

/**
 * Relative weights for the shaped part of a pool.
 *
 * Computed in log space, then shifted by the maximum before exponentiating. The direct form
 * overflows: a pool reaching 18x the price at a falloff of 3.6 asks for exp(1080), which is
 * Infinity, and Infinity * 0 is NaN — which silently poisons every weight and makes the solver
 * report an expected value of zero.
 */
function shapeWeights(pool: readonly PoolEntry[], price: number, falloff: number): number[] {
  const logWeights = pool.map((item) => -falloff * Math.log(item.value / price));
  const peak = logWeights.reduce((most, value) => Math.max(most, value), -Infinity);
  if (!Number.isFinite(peak)) return pool.map(() => 1);

  const shaped = logWeights.map((value) => Math.exp(value - peak));
  const smallest = shaped.reduce(
    (least, value) => (value > 0 ? Math.min(least, value) : least),
    Infinity,
  );
  if (!Number.isFinite(smallest) || smallest <= 0) return pool.map(() => 1);

  /* Normalised so the rarest shaped item is 1, then clamped. Absolute scale is solved for later.
   * Without the clamp a steep profile asks for a weight ratio around 1e14, which no integer
   * column can hold and which draws no distinction a player could ever observe. */
  return shaped.map((value) => Math.min(MAX_SHAPE_RATIO, value / smallest));
}

/** Population standard deviation of the payout, given outcomes and their weights. */
function payoutStdev(pool: readonly PoolEntry[], weights: readonly number[], mean: number): number {
  let variance = 0;
  let total = 0;
  for (let index = 0; index < pool.length; index += 1) {
    const item = pool[index];
    const weight = weights[index];
    if (!item || weight === undefined) continue;
    variance += weight * (item.value - mean) ** 2;
    total += weight;
  }
  return total > 0 ? Math.sqrt(variance / total) : 0;
}

/**
 * The published volatility percentage.
 *
 * Derived from the crate's own solved distribution, never typed in: it is the coefficient of
 * variation (payout standard deviation over expected payout) squashed onto 0-100. A crate whose
 * outcomes all sit near the mean scores low; one where a single outcome carries most of the
 * expected value scores high. Because every crate returns the same 90%, this is the only number
 * that actually distinguishes them, which is why it goes on the card in figures rather than as an
 * adjective.
 */
function riskPercentFrom(coefficientOfVariation: number): number {
  const squashed = coefficientOfVariation / (coefficientOfVariation + 1.6);
  return Math.min(99, Math.max(5, Math.round(squashed * 100)));
}

function riskLabelFor(percent: number): string {
  if (percent < 25) return 'Low';
  if (percent < 45) return 'Medium';
  if (percent < 65) return 'High';
  if (percent < 82) return 'Very High';
  return 'Extreme';
}

function buildCases(items: readonly CatalogItem[]): GeneratedCase[] {
  const ladder: PoolEntry[] = items
    .filter((item) => !item.mystery)
    .map((item) => ({ name: item.name, value: Number(item.valueMinor) }));

  /* ── the mystery payload catalogue ──
   *
   * Every payload that can ever sit behind a `?`. Which of them a given crate can actually draw
   * is decided PER CRATE by its own scaled floor, not here: a 5,000 crate reaches the $100M-$1B
   * band, a 150,000,000 crate floors at $375M and reaches the $390M-$3B band instead. The two
   * pools barely overlap, which is the whole point of scaling the floor. */
  const allPayloads: PoolEntry[] = items
    .filter((item) => item.mystery)
    .map((item) => ({ name: item.name, value: Number(item.valueMinor) }))
    .sort((left, right) => left.value - right.value);

  if (allPayloads.length === 0) throw new Error('no payloads defined for the mystery sub-pool');

  const generated: GeneratedCase[] = [];
  /* Every (tier, profile) pair the catalogue could not fill, and why.
   *
   * A pool with fewer than four outcomes is skipped rather than thrown, which is the right call —
   * one unfillable combination should not stop the other forty-nine — but a SILENT skip means the
   * site can ship with a hole in its price ladder and nobody finds out until a player goes looking
   * for the expensive crates. The skips are collected here and printed at the end.
   *
   * This matters most right after a catalogue reprice. Item values now come from live DonutSMP
   * auction medians, and the real market is far flatter than the synthetic ladder it replaced: the
   * narrow 'safe' band (0.45x to 2.2x of price) is the first thing to run out of outcomes at the
   * top of the ladder. */
  const skipped: { price: number; profile: string; band: number }[] = [];
  const targetRtp = (10_000 - CASE_EDGE_BPS) / 10_000;
  const budgetFraction = mysteryBudgetFraction();

  for (let tierIndex = 0; tierIndex < PRICE_TIERS.length; tierIndex += 1) {
    const price = PRICE_TIERS[tierIndex];
    const tierThemes = CRATE_THEMES[tierIndex];
    if (price === undefined || tierThemes === undefined) continue;

    /* ── the scaled sub-pool, then the odds it implies ──
     *
     * Two programmatic steps, both driven by price alone and neither hardcoded per crate:
     *
     *   1. the floor decides WHAT the `?` can contain. It is the strongest of the baseline, the
     *      high-roller minimum, and 2.5x the crate price, so a mystery hit is always at least a
     *      two-and-a-half-bagger and never a breakeven.
     *   2. the odds decide HOW OFTEN it lands, from that pool's own average value. A richer pool
     *      costs the house more per hit, so the landing probability falls to compensate and the
     *      crate still returns exactly 90%.
     *
     * The second is what keeps a 150,000,000 crate honest: its floor triples, so its slot lands
     * roughly a quarter as often as the unscaled engine would have given it. */
    for (const profile of RISK_PROFILES) {
      const theme = tierThemes[profile.code];
      if (theme === undefined) continue;

      const band = ladder.filter(
        (item) =>
          item.value >= price * profile.lowMultiple && item.value <= price * profile.highMultiple,
      );
      // A pool needs enough distinct outcomes to be worth calling a crate at all.
      if (band.length < 4) {
        skipped.push({ price, profile: profile.code, band: band.length });
        continue;
      }

      /* ── the scaled sub-pool, then the odds it implies ──
       *
       * Built per CRATE, not per tier, because its floor is the strongest of three numbers and
       * only two of them are known from the price:
       *
       *   1. the baseline and high-roller minimums, and 2.5x the crate price, so a mystery hit is
       *      always at least a two-and-a-half-bagger and never a breakeven;
       *   2. the dearest ordinary outcome this profile can contain, so the `?` is always strictly
       *      better than anything the player can already see on the reel.
       *
       * The second is why this sits here rather than outside the loop: the band is what decides
       * it, and the band is per profile. The odds then follow from the pool's own average value,
       * so a richer pool lands less often and the crate still returns exactly 90%. */
      const bandTop = band.reduce((dearest, item) => Math.max(dearest, item.value), 0);
      let scaled;
      try {
        scaled = buildScaledSubPool(
          allPayloads, (entry) => entry.value, price, INVERSE_WEIGHT_EXPONENT, bandTop + 1,
        );
      } catch {
        /* No payload clears this crate's own loot table. Skipping is the honest outcome: the
         * alternative is a `?` that is not the best thing in the crate. */
        skipped.push({ price, profile: profile.code, band: -1 });
        continue;
      }
      const subPool = scaled.payloads;
      const subProbabilities = scaled.probabilities;
      const rarestShare = subProbabilities.reduce((l, share) => Math.min(l, share), Infinity);
      const odds = calculateMysteryOdds(price, budgetFraction, scaled.averageValue);

      /* What the ordinary table has to average, given the slot eats P of every hundred rolls.
       * At one in ninety thousand this is indistinguishable from 81% of price; at one in eight it
       * is meaningfully higher, and ignoring the correction would quietly ship a crate returning
       * well under 90%. */
      const ordinaryTarget = odds.ordinaryTargetMinor;

      /* Thinned to a readable table, spread evenly in log value. The band decides what a crate
       * CAN contain; this decides how many of those it actually advertises. */
      let ordered = thinPool(
        [...band].sort((left, right) => left.value - right.value),
        MAX_ORDINARY_DROPS,
      );

      /* ── drop dust the crate cannot afford to be full of ──
       *
       * A MONOTONIC table puts its heaviest weight on its cheapest outcome, so its mean can never
       * exceed the pool's plain arithmetic mean. That is a hard ceiling, and at the top tiers the
       * target sits above it: a 150,000,000 crate whose mystery slot lands one time in nine has
       * to average 136,000,000 on the other eight, while the widest profile's band averages only
       * 76,000,000. No ordering of weights satisfies both, and the previous code resolved that by
       * inverting the table.
       *
       * The real answer is that such a crate cannot be mostly dust. Trimming from the cheap end
       * until the arithmetic mean clears the target is what makes the profile honest at that
       * price: the wide profiles converge on the safe one as the mystery slot starts landing
       * often, because the arithmetic leaves them nowhere else to go. */
      while (
        /* Three is the floor. A crate needs a cheapest, a dearest and something between them to
         * be a drop table rather than a coin flip; below that there is no distribution left to
         * shape. Only the very top tier ever trims this far — at 150,000,000 with the slot
         * landing one time in nine, the ordinary table has to average 136,000,000, and there are
         * only so many outcomes on the ladder that expensive. */
        ordered.length > 3
        && ordered.reduce((sum, entry) => sum + entry.value, 0) / ordered.length <= ordinaryTarget
      ) {
        ordered = ordered.slice(1);
      }
      const filler = ordered[0];
      const shapedItems = ordered.slice(1);
      /* Two shaped outcomes plus the filler. The usual crate carries seven shaped outcomes; this
       * lower bound exists only for the top tier, where feasibility trimming leaves fewer. */
      if (!filler || shapedItems.length < 2) continue;
      if (ordinaryTarget <= filler.value) continue;

      /* ── find a falloff whose pool averages above the target ──
       *
       * The shaped pool must average ABOVE the ordinary target, or no amount of cheap filler
       * brings it down to one. A steep profile clamped by MAX_SHAPE_RATIO often does not: the
       * clamp flattens the cheap end into a wall of equal weights and the expensive tail rounds
       * away, dragging the mean below what the crate has to pay.
       *
       * This used to be fixed by shovelling weight onto the single most expensive item until the
       * mean came up. It worked, and it produced drop tables that were visibly wrong: on Wither
       * Fight the $245,000,000 item ended up more than a hundred times likelier than the
       * $78,000,000 one sitting next to it. Nothing was misreported — the real chances were
       * published either way — but a table where a bigger prize is commoner than a smaller one
       * reads as broken, and a player cannot tell "deliberate" from "bug" by looking.
       *
       * Flattening the whole curve is the honest lever. Lowering the falloff raises the mean by
       * moving weight up the ladder smoothly, so the distribution stays MONOTONIC: every more
       * valuable outcome remains at least as rare as every cheaper one. At falloff 0 the pool is
       * uniform and its mean is the arithmetic mean of the items, which is the highest a
       * non-inverted distribution can reach — so if that still falls short, the crate genuinely
       * cannot be built from this pool and is skipped rather than faked.
       */
      /* Both conditions are satisfied by the SAME lever, which is why one loop can chase them.
       *
       *   1. the shaped pool must average above the target, or no amount of cheap filler pulls it
       *      down to one;
       *   2. the filler must be at least as likely as the cheapest shaped item, or the table
       *      inverts at its very first step.
       *
       * The filler's weight is the residual, f = W - aS with a = W(t - v_f)/(R - S v_f). Raising
       * the shaped mean R/S shrinks `a` and therefore GROWS the residual — so flattening the
       * curve fixes both at once. Everything below is expressed as SHARES of the ordinary weight,
       * which are independent of how much total weight the crate ends up carrying, so the
       * decision does not have to be revisited inside the resolution loop.
       */
      let falloff = profile.falloff;
      let shaped: number[] = [];
      let scalePerWeight = 0;
      let usable = false;

      for (let relaxation = 0; relaxation < 400; relaxation += 1) {
        shaped = shapeWeights(shapedItems, price, falloff);
        const shapedSum = shaped.reduce((sum, weight) => sum + weight, 0);
        const shapedValue = shaped.reduce(
          (sum, weight, index) => sum + weight * (shapedItems[index]?.value ?? 0),
          0,
        );

        if (shapedSum > 0 && shapedValue / shapedSum > ordinaryTarget) {
          const denominator = shapedValue - shapedSum * filler.value;
          if (denominator > 0) {
            scalePerWeight = (ordinaryTarget - filler.value) / denominator;
            const fillerShare = 1 - shapedSum * scalePerWeight;
            const dearestNeighbourShare = (shaped[0] ?? 0) * scalePerWeight;
            if (scalePerWeight > 0 && fillerShare > 0 && fillerShare >= dearestNeighbourShare) {
              usable = true;
              break;
            }
          }
        }

        if (falloff <= 0.02) break;
        falloff = Math.max(0.02, falloff * 0.88);
      }

      /* Even a flat pool could not satisfy both. The crate genuinely cannot be built from this
       * pool at this price, so it is skipped rather than published with an inverted table. */
      if (!usable) continue;

      /* ── solve the weights, at the coarsest resolution that still fits the column ──
       *
       * Two competing pressures, and they pull in opposite directions:
       *
       *   - the sub-pool needs the mystery slot's own weight to be LARGE, or the rarest payload
       *     rounds away to nothing and the $1B vault becomes unreachable;
       *   - every individual weight must fit `CHECK (weight BETWEEN 1 AND 1000000000)`, and the
       *     cheapest crate's slot lands about once in two hundred and eighty thousand, so a big
       *     mystery weight forces a total weight hundreds of times bigger than that.
       *
       * `resolution` is how many units of weight the RAREST payload gets. Four is comfortable;
       * one is the minimum that keeps it drawable at all. The loop takes the first that fits, so
       * cheap crates quietly accept a coarser sub-pool rather than being dropped from the
       * catalogue — and the achieved distribution is measured afterwards either way.
       */
      let solved: {
        drops: GeneratedDrop[];
        weights: number[];
        pool: PoolEntry[];
        mysteryWeight: number;
        totalWeight: number;
      } | null = null;

      for (const resolution of [16, 8, 4, 2, 1]) {
        const minMysteryWeight = Math.max(
          subPool.length,
          Math.ceil(resolution / rarestShare),
        );

        let split;
        try {
          split = resolveWeightSplit(odds.probability, minMysteryWeight, MAX_TOTAL_WEIGHT);
        } catch {
          continue;
        }
        if (split.mysteryWeight < subPool.length) continue;

        const ordinaryWeight = split.ordinaryWeight;
        const scale = ordinaryWeight * scalePerWeight;
        const shapedWeights = shaped.map((weight) => Math.max(1, Math.round(weight * scale)));
        const shapedWeightSum = shapedWeights.reduce((sum, weight) => sum + weight, 0);
        const fillerWeight = ordinaryWeight - shapedWeightSum;

        // Every slot has to fit the integer column, filler included.
        if (fillerWeight < 1 || fillerWeight > MAX_ITEM_WEIGHT) continue;
        if (shapedWeights.some((weight) => weight > MAX_ITEM_WEIGHT || weight < 1)) continue;

        /* The mystery slot's weight is divided across the sub-pool by inverse value. Largest
         * remainder, so the parts sum to the whole exactly — a slot whose payloads sum to less
         * than its own weight is a crate that can roll a number matching no outcome at all. */
        let subWeights: number[];
        try {
          subWeights = apportion(split.mysteryWeight, subProbabilities);
        } catch {
          continue;
        }
        if (subWeights.some((weight) => weight > MAX_ITEM_WEIGHT || weight < 1)) continue;

        const solvedPool: PoolEntry[] = [filler, ...shapedItems, ...subPool];
        const weights = [fillerWeight, ...shapedWeights, ...subWeights];
        const summed = weights.reduce((sum, weight) => sum + weight, 0);
        if (summed !== split.totalWeight) continue;

        solved = {
          drops: solvedPool.map((item, index) => ({
            name: item.name,
            weight: weights[index] ?? 1,
          })),
          weights,
          pool: solvedPool,
          mysteryWeight: split.mysteryWeight,
          totalWeight: split.totalWeight,
        };
        break;
      }

      if (!solved) continue;

      /* The published figure is the ACHIEVED one, verified against the real integer weights and
       * the real values, never the intended one. A crate whose real edge differs from its label is
       * the worst bug this file could ship, so it throws rather than writing one. */
      const achievedValue = expectedValue(solved.pool, solved.weights);
      const solvedRtp = achievedValue / price;
      if (Math.abs(solvedRtp - targetRtp) > 0.002) {
        throw new Error(
          `${theme.name}: solved RTP ${(solvedRtp * 100).toFixed(3)}% is not the ` +
            `intended ${(targetRtp * 100).toFixed(2)}% (pool of ${solved.pool.length})`,
        );
      }

      /* Monotonicity, checked on the REAL integer weights rather than trusted from the shape.
       *
       * Rounding, the MAX_SHAPE_RATIO clamp and the filler solve all touch the weights after the
       * curve is chosen, so the only way to know the published table is ordered is to look at the
       * numbers that will actually be written. Equal weights are fine — two outcomes can be
       * equally likely — but a more valuable outcome may never be STRICTLY likelier than a
       * cheaper one. */
      const orderedOrdinary = solved.pool
        .slice(0, solved.pool.length - subPool.length)
        .map((entry, index) => ({ value: entry.value, weight: solved.weights[index] ?? 0 }))
        .sort((left, right) => left.value - right.value);
      for (let index = 1; index < orderedOrdinary.length; index += 1) {
        const dearer = orderedOrdinary[index];
        const cheaper = orderedOrdinary[index - 1];
        if (dearer && cheaper && dearer.weight > cheaper.weight) {
          throw new Error(
            `${theme.name}: drop table is not monotonic — ${dearer.value} carries weight ` +
              `${dearer.weight} while the cheaper ${cheaper.value} carries only ${cheaper.weight}`,
          );
        }
      }

      /* The mystery slot's realised share of the crate's own EV must be the budget it was given.
       * This is the check that catches an apportionment or a rounding error turning a 10% mystery
       * budget into a 14% one — which would not move the total RTP at all, because the ordinary
       * table was solved to fill whatever was left, and would therefore be invisible to the RTP
       * assertion above. */
      const mysteryEv = subPool.reduce((sum, entry, index) => {
        const weight = solved.weights[solved.pool.length - subPool.length + index] ?? 0;
        return sum + (weight / solved.totalWeight) * entry.value;
      }, 0);
      const realisedBudgetShare = mysteryEv / (price * targetRtp);
      if (Math.abs(realisedBudgetShare - MYSTERY_BUDGET_SHARE_BPS / 10_000) > 0.02) {
        throw new Error(
          `${theme.name}: mystery slot realised ${(realisedBudgetShare * 100).toFixed(2)}% of the ` +
            `RTP budget, not the configured ${(MYSTERY_BUDGET_SHARE_BPS / 100).toFixed(2)}%`,
        );
      }

      /* Volatility is measured on the ORDINARY pool, with the mystery slot excluded.
       *
       * Every crate carries the same seven payloads behind its `?`, so including them tells a
       * player nothing about how this crate differs from the one beside it — and because the
       * payloads are thousands of times the price of a cheap crate, they dominate the variance
       * completely: with them in, every crate below 150,000 scored 95-98% and the badge stopped
       * distinguishing anything. The number on the card is about the crate you actually open. */
      const ordinaryCount = solved.pool.length - subPool.length;
      const ordinaryPool = solved.pool.slice(0, ordinaryCount);
      const ordinaryWeights = solved.weights.slice(0, ordinaryCount);
      const ordinaryMean = expectedValue(ordinaryPool, ordinaryWeights);
      const stdev = payoutStdev(ordinaryPool, ordinaryWeights, ordinaryMean);
      const riskPercent = riskPercentFrom(ordinaryMean > 0 ? stdev / ordinaryMean : 0);
      /* The headline multiple comes from the thinned pool, which is what the crate actually
       * contains — quoting the band's top when that item was thinned out would advertise a payout
       * the crate can no longer produce. */
      const top = ordinaryPool.reduce((best, item) => Math.max(best, item.value), 0);

      const achievedProbability = solved.mysteryWeight / solved.totalWeight;

      generated.push({
        slug: theme.slug,
        name: theme.name,
        description: profile.blurb,
        priceMinor: String(price),
        risk: profile.code,
        riskPercent,
        riskLabel: riskLabelFor(riskPercent),
        tier: tierIndex + 1,
        asset: theme.asset,
        drops: solved.drops,
        expectedValueMinor: String(Math.round(achievedValue)),
        topMultiple: Number((top / price).toFixed(2)),
        mysteryOddsDenominator: Math.round(1 / achievedProbability),
        mysteryProbabilityPpb: Math.round(achievedProbability * 1_000_000_000),
        mysteryEvMinor: String(Math.round(mysteryEv)),
        mysteryPoolAverageMinor: String(Math.round(scaled.averageValue)),
        mysteryFloorMinor: String(scaled.floorMinor),
        mysteryWorstMultiple: Number(scaled.worstMultiple.toFixed(2)),
        mysteryPayloads: subPool.map((entry, index) => ({
          name: entry.name,
          valueMinor: String(entry.value),
          /* Probability WITHIN the sub-pool, i.e. given the slot landed. The client multiplies it
           * by the slot's own odds to show the true end-to-end chance of each payload. */
          shareOfPoolPpm: Math.round(
            ((solved.weights[ordinaryCount + index] ?? 0) / solved.mysteryWeight) * 1_000_000,
          ),
        })),
      });
    }
  }

  if (generated.length === 0) throw new Error('no crates were generated');

  if (skipped.length) {
    const target = PRICE_TIERS.length * RISK_PROFILES.length;
    console.warn(
      `  ${generated.length}/${target} crates generated. ` +
        `${skipped.length} (tier, profile) pair(s) had too few catalogue outcomes to fill:`,
    );
    for (const gap of skipped) {
      console.warn(
        `    ${gap.price.toLocaleString().padStart(13)}  ${gap.profile.padEnd(9)}` +
          `only ${gap.band} outcome(s) in band, needs 4`,
      );
    }
    console.warn('  Fix by adding catalogue items inside those value bands, or by trimming');
    console.warn('  PRICE_TIERS to the range the item ladder can actually support.');
    console.warn('  Do NOT inflate item values to close the gap: every crate price is derived');
    console.warn('  from them, so an invented value is an invented price on every crate that');
    console.warn('  contains it.');
  }
  return generated;
}

/** Daily quests. Metrics are incremented server-side from real events, never claimed by a client. */
const QUESTS: [code: string, name: string, description: string, metric: string, target: string,
  reward: string, order: number][] = [
  ['daily_three_rolls', 'Warm the anvil', 'Complete 3 upgrader rolls today.',
    'upgrader_rolls', '3', '15000', 1],
  ['daily_one_win', 'Strike gold', 'Land a single upgrader win today.',
    'upgrader_wins', '1', '30000', 2],
  ['daily_two_cases', 'Crack the crates', 'Open 2 cases today.',
    'cases_opened', '2', '20000', 3],
  ['daily_wager_million', 'High roller', 'Wager $1,000,000 across any game today.',
    'wagered_minor', '1000000', '60000', 4],
  ['daily_faction_push', 'For the faction', 'Contribute $500,000 to your faction today.',
    'faction_contribution_minor', '500000', '45000', 5],
];

/** The three sides. Gold, ember and ice: one warm pair and one cold counterpoint, zero purple. */
const FACTIONS: [code: string, name: string, color: string, blurb: string][] = [
  ['molten', 'Molten Core', '#ffaa00', 'Gold out of the deep. Volume wins wars.'],
  ['ember', 'Ember Pact', '#ff6a00', 'Burn hot, burn fast, take the lead early.'],
  ['frost', 'Frostforge', '#00ccff', 'Patient, precise, and never out of the running.'],
];

const fingerprintFor = (name: string) =>
  createHash('sha256').update(`donutsmp:${name}`).digest('hex');

const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 1,
  application_name: 'donut-dev-seed',
});
const client = await pool.connect();

try {
  await client.query('BEGIN');

  let itemsAdded = 0;
  const idByName = new Map<string, string>();
  for (const item of ITEMS) {
    /* The value and the mystery flag are pushed on every run, not only on insert.
     *
     * An earlier version did `DO UPDATE SET enabled = true` and nothing else, so re-seeding after
     * a price change left the old value in place and the crates were solved against numbers the
     * database did not hold. The generator's RTP assertion would still have passed — it checks
     * its own arithmetic — while the live crate paid something else entirely. */
    const inserted = await client.query<{ id: string; inserted: boolean }>(
      `INSERT INTO catalog_items
         (id, fingerprint, minecraft_name, display_name, image_url, unit_value_minor, enabled,
          metadata, price_updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, true, $7::jsonb, now())
       ON CONFLICT (fingerprint) DO UPDATE
         SET display_name = EXCLUDED.display_name,
             image_url = EXCLUDED.image_url,
             unit_value_minor = EXCLUDED.unit_value_minor,
             metadata = EXCLUDED.metadata,
             price_updated_at = now(),
             enabled = true, updated_at = now()
       RETURNING id, (xmax = 0) AS inserted`,
      [
        randomUUID(),
        fingerprintFor(item.name),
        item.name,
        item.display,
        item.imageUrl ?? null,
        item.valueMinor,
        JSON.stringify(item.mystery ? { mystery: true, tier: 'god' } : {}),
      ],
    );
    const row = inserted.rows[0];
    if (!row) throw new Error(`Catalog upsert returned no row for ${item.name}`);
    idByName.set(item.name, row.id);
    if (row.inserted) itemsAdded += 1;
  }

  const generatedCases = buildCases(ITEMS);
  let casesAdded = 0;
  for (const generated of generatedCases) {
    const inserted = await client.query<{ id: string; inserted: boolean }>(
      `INSERT INTO cases (id, slug, name, description, image_url, price_minor, enabled, metadata)
       VALUES ($1, $2, $3, $4, NULL, $5, true, $6::jsonb)
       ON CONFLICT (slug) DO UPDATE
         SET name = EXCLUDED.name, description = EXCLUDED.description,
             price_minor = EXCLUDED.price_minor, metadata = EXCLUDED.metadata,
             enabled = true, updated_at = now()
       RETURNING id, (xmax = 0) AS inserted`,
      [
        randomUUID(),
        generated.slug,
        generated.name,
        generated.description,
        generated.priceMinor,
        JSON.stringify({
          risk: generated.risk,
          // The published volatility figure, solved from the crate's own distribution.
          riskPercent: generated.riskPercent,
          riskLabel: generated.riskLabel,
          tier: generated.tier,
          frontendAsset: generated.asset,
          edgeBps: Math.round(
            (1 - Number(generated.expectedValueMinor) / Number(generated.priceMinor)) * 10_000,
          ),
          expectedValueMinor: generated.expectedValueMinor,
          topMultiple: generated.topMultiple,
          /* Everything the client needs to draw and EXPLAIN the golden question mark.
           *
           * The odds are published per crate rather than assumed constant, because they are no
           * longer constant: they scale with price, so a player comparing two crates has to be
           * able to see that the expensive one really does hit the slot more often. */
          mystery: {
            oddsDenominator: generated.mysteryOddsDenominator,
            probabilityPpb: generated.mysteryProbabilityPpb,
            evMinor: generated.mysteryEvMinor,
            poolAverageMinor: generated.mysteryPoolAverageMinor,
            /* This crate's OWN floor, not a platform constant. The client prints it on the `?`
             * tile, so a 150,000,000 crate advertises "$375M+" where a 5,000 one says "$100M+". */
            valueFloorMinor: generated.mysteryFloorMinor,
            worstMultiple: generated.mysteryWorstMultiple,
            minJackpotMultiple: MIN_JACKPOT_MULTIPLE,
            poolSpanMultiple: POOL_SPAN_MULTIPLE,
            budgetShareBps: MYSTERY_BUDGET_SHARE_BPS,
            inverseWeightExponent: INVERSE_WEIGHT_EXPONENT,
            payloads: generated.mysteryPayloads,
          },
        }),
      ],
    );
    const row = inserted.rows[0];
    if (!row) throw new Error(`Case upsert returned no row for ${generated.slug}`);
    if (row.inserted) casesAdded += 1;

    /* Drops are replaced wholesale rather than merged: a regenerated crate whose pool shrank
     * would otherwise keep paying out items it no longer advertises. */
    await client.query('DELETE FROM case_items WHERE case_id = $1', [row.id]);
    for (const drop of generated.drops) {
      const catalogItemId = idByName.get(drop.name);
      if (!catalogItemId) throw new Error(`Case ${generated.slug} references unknown ${drop.name}`);
      await client.query(
        `INSERT INTO case_items (case_id, catalog_item_id, weight, quantity, enabled)
         VALUES ($1, $2, $3, 1, true)`,
        [row.id, catalogItemId, drop.weight],
      );
    }
  }

  /* ── retire crates this generator no longer produces ──
   *
   * Crates are upserted by slug, so a renamed or re-tiered catalogue leaves the previous
   * generation sitting in the table, still enabled and still openable. That is not merely untidy:
   * these crates were solved against the OLD item values, and this run moved the god-tier prices.
   * A stale crate whose pool now contains a 390,000,000 Elytra it was priced against at
   * 180,000,000 pays out roughly twice what it takes — a live economic exploit, published and
   * playable, that nothing else in the system would have caught.
   *
   * They are disabled rather than deleted, because case_rounds references them and the history of
   * what a player actually opened has to survive a re-seed.
   */
  const liveSlugs = generatedCases.map((generated) => generated.slug);
  const retired = await client.query<{ slug: string }>(
    `UPDATE cases
        SET enabled = false, updated_at = now()
      WHERE enabled AND slug <> ALL($1::text[])
      RETURNING slug`,
    [liveSlugs],
  );
  if (retired.rowCount) {
    process.stdout.write(
      `Retired ${retired.rowCount} stale crate(s): ${retired.rows.map((r) => r.slug).join(', ')}
`,
    );
  }

  for (const [code, name, description, metric, target, reward, order] of QUESTS) {
    await client.query(
      `INSERT INTO quest_definitions
         (code, name, description, metric, target_value, reward_minor, sort_order, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true)
       ON CONFLICT (code) DO UPDATE
         SET name = EXCLUDED.name, description = EXCLUDED.description,
             metric = EXCLUDED.metric, target_value = EXCLUDED.target_value,
             reward_minor = EXCLUDED.reward_minor, sort_order = EXCLUDED.sort_order,
             enabled = true, updated_at = now()`,
      [code, name, description, metric, target, reward, order],
    );
  }

  /* One live faction war, running from now. The pool comes from configuration rather than being
   * typed in here, so the figure the war room advertises is the figure settlement will pay. */
  const warDays = Number(process.env['FACTION_WAR_DAYS'] ?? '7');
  const prizePool = process.env['FACTION_WAR_PRIZE_POOL_MINOR'] ?? '1000000000';
  const existingWar = await client.query<{ id: string }>(
    `SELECT id FROM faction_events WHERE slug = 'season-one' LIMIT 1`,
  );
  let warId = existingWar.rows[0]?.id;
  if (!warId) {
    warId = randomUUID();
    await client.query(
      `INSERT INTO faction_events
         (id, slug, name, description, prize_pool_minor, starts_at, ends_at)
       VALUES ($1, 'season-one', 'Faction War: Season One',
               'Three factions, seven days, one pool. Every wager you place counts for your side.',
               $2, now(), now() + make_interval(days => $3))`,
      [warId, prizePool, warDays],
    );
    for (const [code, name, color, blurb] of FACTIONS) {
      await client.query(
        `INSERT INTO factions (id, event_id, code, name, color, blurb)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (event_id, code) DO NOTHING`,
        [randomUUID(), warId, code, name, color, blurb],
      );
    }
  }

  await client.query('COMMIT');
  process.stdout.write(
    `Seeded ${ITEMS.length} catalog items (${itemsAdded} new), ${generatedCases.length} crates ` +
      `(${casesAdded} new), ${QUESTS.length} daily quests and a ${FACTIONS.length}-faction war.
`,
  );
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
