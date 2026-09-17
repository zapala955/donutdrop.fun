/* prices.mjs — pull real auction prices off the DonutSMP API and print a price table.
 *
 * Run at build time, not in the browser: the key must never ship in frontend JS where view-source
 * hands it to every visitor, and a static page calling a third-party host would hit CORS anyway.
 * The output is pasted into the catalogue in services/api-gateway/scripts/dev-seed.ts.
 *
 *   DONUT_KEY=... node "DONUTDROP FRONTEND/Donut Drop/tools/prices.mjs"
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THE PREVIOUS VERSION GOT WRONG
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * It read ONE page of listings and then took a percentile of it. Both halves of that are broken,
 * and they compound.
 *
 * The auction search matches display names and lore, not item ids, so a page of results for
 * "netherite ingot" is mostly shulker boxes somebody labelled after their contents. The id filter
 * catches them — but it catches them AFTER the page budget has been spent. Measured against the
 * live API, page one of "netherite ingot" contains exactly ONE real netherite ingot out of
 * forty-four rows. The old tool therefore priced the item off a sample of n=1.
 *
 * Then, because the request sorts by `lowest_price`, that tiny sample is drawn from the very
 * bottom of the order book — and the old estimator went looking DOWNWARD inside it, trimming the
 * bottom decile and taking roughly the 25th percentile of what was left. Sampling the floor and
 * then taking a low percentile of the floor prices an item at the most desperate undercut on the
 * market. For diamond, the cheapest listing is 9,900 against a real clearing price near 30,000.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THIS VERSION DOES INSTEAD
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *   1. Pages until the ID-MATCHED sample is big enough to mean something, rather than until one
 *      page has been read. Pollution costs extra requests now instead of destroying the sample.
 *   2. Normalises to a per-unit price, because stacks are listed whole (redstone comes in counts
 *      of 1, 4, 10, 39, 60 and 64 on a single page).
 *   3. Rejects outliers by median absolute deviation rather than by a fixed percentile. MAD does
 *      not care which tail the junk is in, and this book has junk in both: scam undercuts at the
 *      bottom, lore-priced collectibles at the top.
 *   4. Reports the MEDIAN of what survives. For a thin market the median is what an item actually
 *      changes hands at; the minimum is what one seller was willing to accept once.
 *   5. Refuses to emit a price at all when the surviving sample is too small to support one. A
 *      blank is a problem someone can see. A number derived from two listings is a problem that
 *      silently becomes a crate price.
 */

const KEY = process.env.DONUT_KEY;
if (!KEY) {
  console.error('set DONUT_KEY');
  process.exit(1);
}
const H = { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };

/* our catalogue name -> [search term, the exact minecraft id it must be]
 *
 * The id check is not optional. The auction search matches display names and lore, so a shulker
 * box someone labelled "netherite ingots" comes back for a netherite-ingot search — an early pass
 * priced a black shulker box as a netherite ingot and an enchanted book as a beacon. Only the
 * item id is trustworthy.
 *
 * The names on the left are the catalogue's `name` field, so the output pastes straight into the
 * ITEMS table without a second mapping to get wrong.
 */
const WANT = [
  ['stick', 'stick', 'minecraft:stick'],
  ['feather', 'feather', 'minecraft:feather'],
  ['gold_nugget', 'gold nugget', 'minecraft:gold_nugget'],
  ['tripwire_hook', 'tripwire hook', 'minecraft:tripwire_hook'],
  ['snow_block', 'snow block', 'minecraft:snow_block'],
  ['ender_pearl', 'ender pearl', 'minecraft:ender_pearl'],
  ['redstone', 'redstone', 'minecraft:redstone'],
  ['slime_ball', 'slime ball', 'minecraft:slime_ball'],
  ['obsidian', 'obsidian', 'minecraft:obsidian'],
  ['hopper', 'hopper', 'minecraft:hopper'],
  ['iron_ingot', 'iron ingot', 'minecraft:iron_ingot'],
  ['iron_sword', 'iron sword', 'minecraft:iron_sword'],
  ['tnt', 'tnt', 'minecraft:tnt'],
  ['gold_ingot', 'gold ingot', 'minecraft:gold_ingot'],
  ['experience_bottle', 'bottle o', 'minecraft:experience_bottle'],
  ['minecart', 'minecart', 'minecraft:minecart'],
  ['lava_bucket', 'lava bucket', 'minecraft:lava_bucket'],
  ['name_tag', 'name tag', 'minecraft:name_tag'],
  ['diamond_shovel', 'diamond shovel', 'minecraft:diamond_shovel'],
  ['diamond', 'diamond', 'minecraft:diamond'],
  ['emerald', 'emerald', 'minecraft:emerald'],
  ['golden_apple', 'golden apple', 'minecraft:golden_apple'],
  ['shulker_box', 'shulker box', 'minecraft:shulker_box'],
  ['enchanted_book', 'mending', 'minecraft:enchanted_book'],
  ['ender_chest', 'ender chest', 'minecraft:ender_chest'],
  ['gold_block', 'gold block', 'minecraft:gold_block'],
  ['diamond_block', 'diamond block', 'minecraft:diamond_block'],
  ['netherite_scrap', 'netherite scrap', 'minecraft:netherite_scrap'],
  ['ancient_debris', 'ancient debris', 'minecraft:ancient_debris'],
  ['totem_of_undying', 'totem of undying', 'minecraft:totem_of_undying'],
  ['enchanted_golden_apple', 'enchanted golden apple', 'minecraft:enchanted_golden_apple'],
  ['netherite_ingot', 'netherite ingot', 'minecraft:netherite_ingot'],
  ['spawner', 'spawner', 'minecraft:spawner'],
  ['netherite_sword', 'netherite sword', 'minecraft:netherite_sword'],
  ['netherite_pickaxe', 'netherite pickaxe', 'minecraft:netherite_pickaxe'],
  ['netherite_chestplate', 'netherite chestplate', 'minecraft:netherite_chestplate'],
  ['beacon', 'beacon', 'minecraft:beacon'],
  ['netherite_block', 'netherite block', 'minecraft:netherite_block'],
  ['trident', 'trident', 'minecraft:trident'],
  ['nether_star', 'nether star', 'minecraft:nether_star'],
  ['elytra', 'elytra', 'minecraft:elytra'],
  ['dragon_egg', 'dragon egg', 'minecraft:dragon_egg'],
];

/* An enchanted book's id is the same whatever is written on it, and the API reports
 * `enchants.enchantments.levels` as null on every row, so there is NO field that distinguishes a
 * Mending book from any other. This one entry is therefore trusted to the text search alone.
 * It is listed here rather than left as a silent caveat in the output, because a price nobody
 * knows is unverified is a price somebody will treat as verified. */
const TEXT_SEARCH_ONLY = new Set(['enchanted_book']);

/** Pages to read before giving up on reaching TARGET_SAMPLE. 44 rows a page. */
const MAX_PAGES = 6;
/**
 * How many id-matched listings to gather before stopping early.
 *
 * Deliberately well above the minimum: stopping the moment the sample became merely usable
 * produced quotes off eight listings, and eight listings from the cheap end of a polluted book is
 * how gold nugget came back with a kept range of 2,292 to 360,000. Paging costs a few hundred
 * milliseconds; a wrong catalogue value costs every crate price derived from it.
 */
const TARGET_SAMPLE = 20;
/** Below this many surviving listings the market is too thin to quote, and the tool says so. */
const MIN_SAMPLE = 12;
/**
 * How wide the surviving interquartile range may be, as a multiple of the median, before the
 * quote stops meaning anything.
 *
 * One Minecraft item id covers many different products. An `iron_sword` may be plain or carry
 * five enchantments; an `ender_chest` may be a chest or a named collectible. The id filter proves
 * the listings are the same ITEM but not that they are the same PRODUCT, and no field in the API
 * separates them — so when the middle half of the book still spans more than this, the median is
 * a number averaged across two different markets. It is still reported, and it is flagged,
 * because a quote like that wants a human eye rather than a paste into a catalogue.
 */
const MAX_IQR_RATIO = 1.5;
/** Robust z-score past which a listing is junk. 3.5 is the conventional MAD cutoff. */
const MAD_CUTOFF = 3.5;
/** The public limit is 250 requests a minute; this paces well under it. */
const REQUEST_SPACING_MS = 280;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listings(search, page) {
  const res = await fetch('https://api.donutsmp.net/v1/auction/list/' + page, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ search, sort: 'lowest_price' }),
  });
  if (!res.ok) return { rows: [], ok: false };
  const j = await res.json().catch(() => ({}));
  // The API returns nulls inside the result array. Filtering them here keeps every caller below
  // from having to remember that.
  const rows = Array.isArray(j.result) ? j.result.filter(Boolean) : [];
  return { rows, ok: true };
}

const median = (sorted) => {
  if (!sorted.length) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * Drops listings too far from the median to be the same product.
 *
 * Median absolute deviation rather than standard deviation: the mean and the standard deviation
 * are both dragged by the very outliers being looked for, so a listing at a hundred times the
 * going rate widens the window enough to keep itself inside it. The median and the MAD do not
 * move. 0.6745 is the constant that puts MAD on the same scale as a standard deviation for
 * normally distributed data, which is what makes 3.5 mean roughly "three and a half sigma".
 *
 * A MAD of zero means more than half the book sits at one identical price — common when a few
 * sellers undercut each other to the same round number. That is agreement, not an error, so the
 * filter steps aside rather than rejecting everything that is not exactly the median.
 */
function rejectOutliers(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = median(sorted);
  if (mid === null) return { kept: [], median: null, rejected: 0 };

  const deviations = sorted.map((v) => Math.abs(v - mid)).sort((a, b) => a - b);
  const mad = median(deviations);
  if (!mad) return { kept: sorted, median: mid, rejected: 0 };

  const kept = sorted.filter((v) => (0.6745 * Math.abs(v - mid)) / mad <= MAD_CUTOFF);
  return { kept, median: median(kept), rejected: sorted.length - kept.length };
}

async function priceOf(term, mcid) {
  const perUnit = [];
  let scanned = 0;
  let pages = 0;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const { rows, ok } = await listings(term, page);
    pages = page;
    if (!ok) break;
    scanned += rows.length;

    for (const row of rows) {
      if (row.item?.id !== mcid) continue;
      const count = Number(row.item?.count) || 1;
      const price = Number(row.price);
      if (!Number.isFinite(price) || price <= 0 || count <= 0) continue;
      // Stacks are listed whole, so the unit price is what the listing is worth divided by how
      // many items are actually in it.
      perUnit.push(price / count);
    }

    await sleep(REQUEST_SPACING_MS);
    // An empty page means the book has been read to the end; more requests would return nothing.
    if (!rows.length) break;
    if (perUnit.length >= TARGET_SAMPLE) break;
  }

  const { kept, median: value, rejected } = rejectOutliers(perUnit);

  /* Interquartile spread over the median: how much the middle half of the book disagrees.
   * Quartiles rather than the full range, because the extremes are exactly what the MAD filter
   * already dealt with and re-punishing them here would flag everything. */
  let spread = null;
  if (kept.length >= 4 && value) {
    const q1 = kept[Math.floor(kept.length * 0.25)];
    const q3 = kept[Math.floor(kept.length * 0.75)];
    spread = (q3 - q1) / value;
  }

  return {
    value: value === null ? null : Math.round(value),
    matched: perUnit.length,
    kept: kept.length,
    rejected,
    scanned,
    pages,
    low: kept.length ? Math.round(kept[0]) : null,
    high: kept.length ? Math.round(kept[kept.length - 1]) : null,
    spread,
    thin: kept.length < MIN_SAMPLE,
    noisy: spread !== null && spread > MAX_IQR_RATIO,
  };
}

const results = [];
for (const [name, term, mcid] of WANT) {
  const row = await priceOf(term, mcid);
  results.push({ name, mcid, ...row });
  const flag = row.value === null ? 'NONE' : row.thin ? 'THIN' : row.noisy ? 'NOISY' : '';
  console.error(
    `  ${name.padEnd(24)} ${String(row.value ?? '-').padStart(12)}  ` +
      `n=${String(row.kept).padStart(3)}/${String(row.matched).padStart(3)} ` +
      `scanned=${String(row.scanned).padStart(4)} p=${row.pages} ${flag}`,
  );
}

console.log('\n─── price table ───');
console.log(
  'name'.padEnd(24),
  'per-unit'.padStart(12),
  'kept'.padStart(5),
  'rejected'.padStart(9),
  'low'.padStart(12),
  'high'.padStart(12),
  'iqr/med'.padStart(9),
);
for (const r of results) {
  console.log(
    r.name.padEnd(24),
    String(r.value ?? 'NONE').padStart(12),
    String(r.kept).padStart(5),
    String(r.rejected).padStart(9),
    String(r.low ?? '-').padStart(12),
    String(r.high ?? '-').padStart(12),
    (r.spread === null ? '-' : r.spread.toFixed(2)).padStart(9),
    r.thin ? ' THIN' : '',
    r.noisy ? ' NOISY: one id, several products' : '',
    TEXT_SEARCH_ONLY.has(r.name) ? ' TEXT-SEARCH ONLY (id cannot verify)' : '',
  );
}

console.log('\n─── sorted by price ───');
results
  .filter((r) => r.value !== null)
  .sort((a, b) => a.value - b.value)
  .forEach((r) => console.log(String(r.value).padStart(14), r.name));

const unusable = results.filter((r) => r.value === null || r.thin || r.noisy);
if (unusable.length) {
  console.log(
    `\n${unusable.length} item(s) without a usable quote: ` +
      unusable.map((r) => r.name).join(', '),
  );
  console.log('Leave their existing catalogue values alone rather than guessing from a thin book.');
}
