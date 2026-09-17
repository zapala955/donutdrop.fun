/* data.js — Donut Drop fixture data.
 * DonutSMP themed. Currency is in-game DonutSMP dollars, never real money.
 * Every icon is a real Minecraft inventory render downloaded to assets/img/items.
 */

export const IMG = 'assets/img/items/';
export const BLK = 'assets/img/block/';

/* Five tiers, five materials, no violet.
 *
 * Epic used to be a bright violet, which was the loudest purple on the site —
 * it landed on every epic tile, badge, ring and broadcast. Redstone crimson
 * takes that slot: it escalates properly out of cyan and stops short of the
 * gold that now belongs to legendary alone. */
export const RARITY = {
  common:    { name: 'Common',    color: '#8fa0ad', weight: 5000 },  // gunmetal
  uncommon:  { name: 'Uncommon',  color: '#7fd4ff', weight: 2200 },  // pale ice
  rare:      { name: 'Rare',      color: '#ffd700', weight: 820 },   // diamond
  epic:      { name: 'Epic',      color: '#ff2222', weight: 230 },   // redstone
  legendary: { name: 'Legendary', color: '#ffaa00', weight: 48 },    // nether gold
};
export const RARITY_ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

const I = (id, name, rarity, value, file) => ({ id, name, rarity, value, img: IMG + file });

/* The ladder, priced off the live DonutSMP auction house.
 *
 * These are not invented numbers. Each one is the MEDIAN per-unit asking price
 * for that exact item id, pulled from /v1/auction/list and filtered by
 * `item.id` — filtering by the search term alone is not safe, because the
 * auction search matches display names, so a shulker box somebody labelled
 * "netherite ingots" comes back for a netherite-ingot query.
 *
 * Median, not lower quartile. The request sorts by lowest_price, so the sample
 * is already drawn from the bottom of the order book; taking a low percentile
 * of it again priced every item at the most desperate undercut on the market
 * rather than at what it changes hands for. Listings more than 3.5 robust
 * deviations from the median are dropped first, which removes scam undercuts
 * and lore-priced collectibles without either tail dragging the estimate.
 *
 * Six items had no live listings at the time of the pull. Those are marked:
 * `derived` is the craft ratio (a block is nine ingots), `estimate` is a
 * judgement call for things that do not craft and rarely list.
 *
 * The order IS the ladder, and rarity follows price rather than taste:
 * under 30K common, under 500K uncommon, under 5M rare, under 50M epic,
 * above that legendary. An Elytra at 350M sits alone at the top, which is
 * exactly where the market puts it.
 *
 * To refresh: re-run tools/prices.mjs with a DonutSMP API key. Do NOT move this
 * fetch into the browser — the key would ship in view-source, and the API sends
 * no CORS headers.
 */
export const ITEMS = [
  I('redstone',     'Redstone Dust',          'common',            305, 'redstone.png'),
  I('slime',        'Slime Ball',             'common',            781, 'slime_ball.png'),
  I('shulker',      'Shulker Box',            'common',          3_900, 'shulker_box.gif'),
  I('obsidian',     'Obsidian',               'common',          6_125, 'obsidian.png'),
  I('xpbottle',     'Bottle o Enchanting',    'common',          7_400, 'xp_bottle.png'),
  I('iron',         'Iron Ingot',             'common',          8_333, 'iron_ingot.png'),
  I('gold',         'Gold Ingot',             'common',         13_700, 'gold_ingot.png'),
  I('pearl',        'Ender Pearl',            'common',         19_986, 'ender_pearl.png'),
  I('emerald',      'Emerald',                'common',         20_000, 'emerald.png'),
  I('diamond',      'Diamond',                'common',         25_000, 'diamond.png'),
  I('nametag',      'Name Tag',               'common',         25_000, 'name_tag.png'),
  I('gapple',       'Golden Apple',           'common',         25_000, 'golden_apple.png'),
  I('mending',      'Mending Book',           'uncommon',       39_910, 'enchanted_book.png'),
  I('totem',        'Totem of Undying',       'uncommon',       69_780, 'totem.png'),
  I('goldblock',    'Block of Gold',          'uncommon',       72_500, 'gold_block.png'),
  I('minecart',     'Minecart',               'uncommon',      100_000, 'minecart.png'),
  I('diamondblock', 'Block of Diamond',       'uncommon',      200_000, 'diamond_block.png'),
  I('beacon',       'Beacon',                 'uncommon',      498_000, 'beacon.png'),
  I('nstar',        'Nether Star',            'rare',          500_000, 'nether_star.png'),
  I('trident',      'Trident',                'rare',          888_999, 'trident.png'),
  I('scrap',        'Netherite Scrap',        'rare',        1_190_000, 'netherite_scrap.png'),
  I('debris',       'Ancient Debris',         'rare',        1_200_000, 'ancient_debris.png'),
  I('godapple',     'Enchanted Golden Apple', 'rare',        1_600_000, 'god_apple.png'),
  I('npick',        'Netherite Pickaxe',      'rare',        3_800_000, 'netherite_pickaxe.png'),
  I('ningot',       'Netherite Ingot',        'rare',        3_800_000, 'netherite_ingot.png'),
  I('nsword',       'Netherite Sword',        'rare',        4_000_000, 'netherite_sword.png'),
  I('nchest',       'Netherite Chestplate',   'rare',        4_000_000, 'netherite_chestplate.png'),
  I('spawner',      'Zombie Spawner',         'epic',       25_000_000, 'spawner.png'),  // estimate
  I('nblock',       'Block of Netherite',     'epic',       35_010_000, 'netherite_block.png'),  // derived
  I('dragonegg',    'Dragon Egg',             'legendary', 150_000_000, 'dragon_egg.png'),  // estimate
  I('elytra',       'Elytra',                 'legendary', 352_000_000, 'elytra.png'),
];

export const BY_ID = Object.fromEntries(ITEMS.map((i) => [i.id, i]));

/* Crates. Drop odds come from each item's rarity weight inside the pool. */
export const CRATES = [
  {
    id: 'starter', art: BLK + 'chest_normal.png', name: 'Starter Crate', price: 35_000, tier: 'common',
    blurb: 'Spawn-kit leftovers. Everyone opens a few.',
    pool: ['redstone', 'slime', 'iron', 'nametag', 'gold', 'gapple', 'obsidian', 'xpbottle', 'diamond'],
  },
  {
    id: 'miner', art: BLK + 'diamond_block.png', name: 'Miner Crate', price: 220_000, tier: 'uncommon',
    blurb: 'Deep-slate odds. Diamonds turn up more than you think.',
    pool: ['iron', 'gold', 'gapple', 'xpbottle', 'emerald', 'diamond', 'pearl', 'goldblock', 'scrap', 'elytra'],
  },
  {
    id: 'raid', art: BLK + 'gilded_blackstone.png', name: 'Raid Crate', price: 900_000, tier: 'rare',
    blurb: 'Pulled off a pillager captain. Gear-grade floor.',
    pool: ['diamond', 'pearl', 'goldblock', 'scrap', 'debris', 'diamondblock', 'elytra', 'trident', 'shulker', 'totem'],
  },
  {
    id: 'nether', art: BLK + 'netherite_block.png', name: 'Nether Crate', price: 3_400_000, tier: 'epic',
    blurb: 'Bastion loot. Brutes not included.',
    pool: ['scrap', 'debris', 'elytra', 'shulker', 'ningot', 'totem', 'nsword', 'npick', 'mending', 'nchest', 'spawner', 'godapple'],
  },
  {
    id: 'end', art: BLK + 'end_stone.png', name: 'End Crate', price: 11_000_000, tier: 'legendary',
    blurb: 'One in a stack pulls the egg. The rest pull stories.',
    pool: ['shulker', 'totem', 'npick', 'mending', 'nchest', 'spawner', 'beacon', 'godapple', 'nblock', 'nstar', 'dragonegg'],
  },
];
export const CRATE_BY_ID = Object.fromEntries(CRATES.map((c) => [c.id, c]));

/* Selling an item back pays this share of book value; the rest is the spread. */
export const SELL_RATE = 0.9;

/* House cuts. Arena modes are player-funded: the site only ever takes the fee. */
/* Crates are house-funded, so the take is the spread between what a crate costs
   and what its pool pays back on average. This is the figure rakeback pays out
   of; it is not charged on top of the price. */
export const CRATE_RAKE = 0.08;
export const ARENA_RAKE = 0.05;
export const DUEL_FEE = 0.03;          // Orb Duel — the lowest cut on the site

/* Rakeback: you earn back a share of every fee you have paid, by level band. */
export const RAKEBACK_TIERS = [
  { level: 0,  rate: 0.03, name: 'Wood' },
  { level: 10, rate: 0.05, name: 'Iron' },
  { level: 25, rate: 0.08, name: 'Diamond' },
  { level: 50, rate: 0.12, name: 'Netherite' },
];
export const rakebackTier = (level) =>
  [...RAKEBACK_TIERS].reverse().find((t) => level >= t.level) || RAKEBACK_TIERS[0];

/* Daily bonus. The real cadence is 24h; the mockup cycles fast so it can be seen. */
export const BONUS = {
  base: 250_000,
  perLevel: 6_000,
  streakStep: 0.15,
  maxStreak: 7,
  cooldownMs: 2 * 60 * 1000,
  realCadence: 'every 24 hours',
};

/* Referral programme. */
export const REFERRAL = {
  commission: 0.15,                    // share of the fee a referred player pays
  signupBonus: 100_000,
};

/* Upgrader. chance = (stake / target payout) * (1 - edge), clamped.
 * The 10% edge is the whole take — there is no separate fee on top. */
export const UPGRADER = {
  edge: 0.10, min: 0.02, max: 0.90,
  stakes: [10_000, 50_000, 250_000, 1_000_000, 5_000_000],
};

/* The arena's design note, kept as the record of what the mode was specified to be.
 *
 * It is NOT configuration and nothing reads it. Every number the arena actually runs on lives on
 * the server — the entry band and the channel length in slither-engine.ts, the platform's cut in
 * configuration — because a browser constant that looks like a rule is a browser constant somebody
 * eventually edits and expects to matter. The `fee` field the first draft of this carried is gone
 * for the same reason: the cut is applied at extraction, server-side, and is never quoted to a
 * client.
 */
export const ARENA_NOTE = {
  id: 'slither',
  name: 'Slither Arena',
  accent: '#ffd700',
  icon: IMG + 'slime_ball.png',
  blurb: 'Your buy-in becomes your snake — more money, longer body. Eat what is on the floor to grow what you are carrying, and whatever dies near you is yours if you get there first.',
  rules: 'Two ways out with the money: steer through one of the four moving gates on the wall, or hold a straight line for three seconds. Turning or boosting resets the channel, so extracting means telling the room exactly where you are going.',
};

export const STAKES = [10_000, 50_000, 250_000, 1_000_000, 5_000_000];

export const PLAYERS = [
  'xX_CreeperAw_Xx', 'notalt', 'diamond_addict', 'BastionBrute', 'pearl_clutch', 'ClutchOrKick',
  'shaft_miner', 'netherite_diff', 'endermain', 'TotemPop_', 'raid_farmer', 'kelp', '360noscope',
  'stackordie', 'obsidian_', 'void_walker', 'GappleGod', 'tnt_dupe', 'shulker_hoard', 'anvil_drop',
];

export const RANKS = [
  { name: 'BRONZE III', color: '#c08457' }, { name: 'BRONZE I', color: '#c08457' },
  { name: 'SILVER II', color: '#b6c2c9' }, { name: 'GOLD I', color: '#fbbf24' },
  { name: 'GOLD III', color: '#fbbf24' }, { name: 'DIAMOND', color: '#38bdf8' },
];

export const CHAT_LINES = [
  'just hit 5x on the upgrader', 'who wants a 1v1 for 500k', 'bro the egg is 150m now',
  'lost 3 stacks in cart circuit lol', 'rain when', 'serpent is free money if you dont boost',
  'pulled a beacon from a raid crate', 'gg', 'someone teach me chunk claim',
  'i have 14k what should i do', '5x7', 'yes', 'bet', 'anyone selling elytra',
  'that spawner pull was insane', 'nether crate is cursed today', 'up 12m today lets gooo',
];

export const START = {
  balance: 12_400_000, level: 37, xp: 620, xpNext: 1000, keys: 3,
  /* Synthetic referrals so the invite page is not an empty shell in the mockup. */
  refs: [
    { name: 'kelp', active: true, joined: '3 weeks ago' },
    { name: 'obsidian_', active: true, joined: '9 days ago' },
    { name: 'tnt_dupe', active: false, joined: '2 months ago' },
  ],
};
