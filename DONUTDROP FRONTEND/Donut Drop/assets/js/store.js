/* store.js — server-backed application state.
 *
 * The backend is authoritative for identity, balance, inventory, prices, and every game result.
 * This module only caches API responses so independent views repaint from one snapshot.
 */
import { api, ApiError, clientSeed, idempotencyKey, setCsrfToken } from './api.js';

export const bus = new EventTarget();

export const state = {
  ready: false,
  online: true,
  authenticated: false,
  user: null,
  balance: 0,
  balanceMinor: '0',
  inventory: [],
  catalog: [],
  cases: [],
  activities: [],
  fairness: null,
  upgradeConfig: null,
  vaultConfig: null,
  piggyDeposits: [],
  chat: { messages: [], slowModeSeconds: 0, maxLength: 240, bigHitMinor: '0' },
  quests: [],
  questDay: null,
  streak: null,
  war: null,
  referrals: null,
  rakeback: null,
  races: null,
  creator: null,
  leaderboard: null,
  statistics: null,
  account: null,
  transactions: [],
  vip: null,
  lastError: null,

  // Kept at neutral values for legacy read-only profile components. No browser-side economy uses
  // these fields anymore.
  level: 0,
  xp: 0,
  xpNext: 1,
  keys: 0,
  history: [],
  wagered: 0,
  feesPaid: 0,
  rakebackTaken: 0,
  bonusTaken: 0,
  bonusAt: 0,
  bonusStreak: 0,
  refEarned: 0,
  refs: [],
};

/* minecraft_name -> sprite file.
 *
 * Anything missing here falls back to chest.png, which is SILENT: the tile renders, nothing
 * errors, and the item simply shows the wrong picture. Twelve of the catalogue’s items were in
 * exactly that state — Stick, Feather, TNT, Lava Bucket and the rest all drew a wooden chest —
 * so a reel that should have been a row of distinct objects was half identical boxes.
 *
 * tests/catalog-sprites.test.ts now walks the seed’s item list against this table and the files
 * on disk, so an item added without art fails the build instead of quietly becoming a chest. */
const IMAGE_BY_ITEM = {
  // the cheap end
  stick: 'stick.png', feather: 'feather.png', gold_nugget: 'gold_nugget.png',
  tripwire_hook: 'tripwire_hook.png', snow_block: 'snow_block.png', hopper: 'hopper.png',
  iron_sword: 'iron_sword.png', tnt: 'tnt.png', lava_bucket: 'lava_bucket.png',
  diamond_shovel: 'diamond_shovel.png', ender_chest: 'ender_chest.png',
  /* god_apple is deliberately absent. It and enchanted_golden_apple are the SAME Minecraft item
     — an Enchanted Golden Apple is the god apple — and the catalogue carried both, at $480,000
     and $9,500,000, sharing one sprite. Two names, one picture, twenty times the price: the drop
     table looked like a bug and the reel gave no way to tell which one had landed. The cheap
     duplicate is gone from the ladder; the real item keeps its art below. */
  ender_pearl: 'ender_pearl.png', redstone: 'redstone.png', slime_ball: 'slime_ball.png',
  obsidian: 'obsidian.png', iron_ingot: 'iron_ingot.png', shulker_box: 'shulker_box.gif',
  gold_ingot: 'gold_ingot.png', diamond: 'diamond.png', minecart: 'minecart.png',
  emerald: 'emerald.png', experience_bottle: 'xp_bottle.png', name_tag: 'name_tag.png',
  enchanted_book: 'enchanted_book.png', golden_apple: 'golden_apple.png',
  gold_block: 'gold_block.png', totem_of_undying: 'totem.png', diamond_block: 'diamond_block.png',
  beacon: 'beacon.png', nether_star: 'nether_star.png', trident: 'trident.png',
  ancient_debris: 'ancient_debris.png', netherite_scrap: 'netherite_scrap.png',
  enchanted_golden_apple: 'god_apple.png', netherite_pickaxe: 'netherite_pickaxe.png',
  netherite_ingot: 'netherite_ingot.png', netherite_sword: 'netherite_sword.png',
  netherite_chestplate: 'netherite_chestplate.png', spawner: 'spawner.png',
  netherite_block: 'netherite_block.png', dragon_egg: 'dragon_egg.png', elytra: 'elytra.png',
};

function emit(kind = 'sync') {
  bus.dispatchEvent(new CustomEvent('change', { detail: kind }));
}

function toSafeNumber(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rarityFor(value, metadata = {}) {
  if (['common', 'uncommon', 'rare', 'epic', 'legendary'].includes(metadata.rarity)) {
    return metadata.rarity;
  }
  if (value >= 50_000_000) return 'legendary';
  if (value >= 5_000_000) return 'epic';
  if (value >= 500_000) return 'rare';
  if (value >= 30_000) return 'uncommon';
  return 'common';
}

function localAsset(minecraftName, metadata = {}, fallback = 'chest.png') {
  const configured = metadata.frontendAsset || metadata.imageFile;
  /* A flat filename with a real image extension, and nothing else. The previous pattern allowed
   * any run of [A-Za-z0-9_.-], which matches ".." — so a crafted metadata value could walk the
   * path out of the sprite folder. */
  if (typeof configured === 'string'
    && /^[A-Za-z0-9_-]+\.(?:png|gif|jpe?g|webp)$/.test(configured)) {
    return 'assets/img/items/' + configured;
  }
  const key = String(minecraftName || '').split(':').pop();
  return 'assets/img/items/' + (IMAGE_BY_ITEM[key] || fallback);
}

export function normalizeItem(raw, lot = false) {
  const metadata = raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {};
  const unitValueMinor = String(raw.unitValueMinor ?? raw.unit_value_minor ?? '0');
  const value = toSafeNumber(unitValueMinor);
  const minecraftName = raw.minecraftName ?? raw.minecraft_name ?? '';
  const catalogItemId = raw.catalogItemId ?? raw.catalog_item_id ?? raw.id;
  return {
    id: lot ? raw.id : catalogItemId,
    lotId: lot ? raw.id : null,
    catalogItemId,
    minecraftName,
    name: raw.displayName ?? raw.display_name ?? minecraftName,
    displayName: raw.displayName ?? raw.display_name ?? minecraftName,
    img: raw.imageUrl ?? raw.image_url ?? localAsset(minecraftName, metadata),
    imageUrl: raw.imageUrl ?? raw.image_url ?? null,
    unitValueMinor,
    value,
    sellValueMinor: String(raw.sellValueMinor ?? raw.sell_value_minor ?? '0'),
    sellRateBps: Number(raw.sellRateBps ?? raw.sell_rate_bps ?? 0),
    quantity: Number(raw.quantity ?? 1),
    state: raw.state ?? 'available',
    availableQuantity: Number(raw.availableQuantity ?? raw.available_quantity ?? 0),
    metadata,
    /* A god-tier payload that sits behind the golden question mark. The reel never names it; the
     * two-stage reveal does. Read from the item metadata rather than inferred from value, so a
     * crate can carry an expensive ordinary drop without it turning into a mystery. */
    mystery: metadata.mystery === true,
    rarity: rarityFor(value, metadata),
  };
}

function normalizeCase(raw) {
  const drops = (raw.drops || []).map((drop) => ({
    ...normalizeItem(drop),
    weight: Number(drop.weight),
    chancePpm: Number(drop.chancePpm || 0),
    chance: Number(drop.chancePpm || 0) / 1_000_000,
    quantity: Number(drop.quantity || 1),
  }));
  const metadata = raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {};
  /* The crate decal. Accepted as either a bare filename (historically always a block) or a
   * folder-qualified one, because some tiers are themed on an item sprite rather than a block —
   * a lava bucket, a dragon egg. The pattern allows exactly one known folder and a flat filename:
   * no traversal, no absolute paths, no second slash, so a crafted metadata value cannot point
   * the client at anything outside the two sprite folders. */
  const artFile = typeof metadata.frontendAsset === 'string'
    && /^(?:(?:items|block)\/)?[A-Za-z0-9_-]+\.(?:png|gif|jpe?g|webp)$/.test(metadata.frontendAsset)
    ? (metadata.frontendAsset.includes('/') ? metadata.frontendAsset : `block/${metadata.frontendAsset}`)
    : null;
  return {
    id: raw.id,
    slug: raw.slug,
    name: raw.name,
    blurb: raw.description || '',
    description: raw.description || '',
    imageUrl: raw.imageUrl || null,
    art: raw.imageUrl || (artFile ? `assets/img/${artFile}` : 'assets/img/items/chest.png'),
    priceMinor: String(raw.priceMinor),
    price: toSafeNumber(raw.priceMinor),
    totalWeight: String(raw.totalWeight || '0'),
    enabled: raw.enabled !== false,
    metadata,
    drops,
    pool: drops,
  };
}

function normalizeActivity(raw) {
  /* A faction contribution is not a round: it has no item, no payout and no multiple. Building a
   * zero-valued item for it would put a phantom "0" drop in every consumer that reads
   * activity.item, so the field stays null and the feed renders it as its own kind of row. */
  const isFaction = raw.kind === 'faction';
  const payoutRaw = raw.payout_minor ?? raw.payoutMinor;
  return {
    id: raw.id,
    kind: raw.kind,
    createdAt: raw.created_at ?? raw.createdAt,
    player: raw.player,
    sourceName: raw.source_name ?? raw.sourceName,
    // The faction's hex colour. Validated again at the point it reaches a style property.
    accent: raw.accent ?? raw.color ?? null,
    chancePpm: Number(raw.chance_ppm ?? raw.chancePpm ?? 0),
    // What the round cost and what it returned. The feed derives the multiple from these rather
    // than inferring it from the item, so a loss is a real row instead of a missing one.
    wagerMinor: String(raw.wager_minor ?? raw.wagerMinor ?? '0'),
    wager: toSafeNumber(raw.wager_minor ?? raw.wagerMinor),
    payoutMinor: payoutRaw == null ? null : String(payoutRaw),
    payout: payoutRaw == null ? 0 : toSafeNumber(payoutRaw),
    item: isFaction ? null : normalizeItem({
      id: raw.catalog_item_id ?? raw.catalogItemId,
      minecraft_name: raw.minecraft_name ?? raw.minecraftName,
      display_name: raw.display_name ?? raw.displayName,
      image_url: raw.image_url ?? raw.imageUrl,
      unit_value_minor: raw.unit_value_minor ?? raw.unitValueMinor,
      metadata: raw.metadata,
      quantity: raw.quantity,
    }),
  };
}

export async function bootstrap() {
  state.lastError = null;
  const publicLoads = await Promise.allSettled([refreshCases(false), refreshActivity(false)]);
  if (publicLoads.every((entry) => entry.status === 'rejected')) state.online = false;
  try {
    state.user = await api.get('/v1/auth/me');
    state.authenticated = true;
    try {
      await refreshPrivate(false);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) throw error;
      // /auth/me already proved this session is valid. Keep the player signed in when one
      // secondary dashboard endpoint is unavailable and allow the normal refresh cycle to retry.
      state.lastError = error;
      console.warn('Authenticated data refresh failed', error);
    }
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 401)) {
      state.online = false;
      state.lastError = error;
    }
    state.authenticated = false;
    state.user = null;
    state.balance = 0;
    state.balanceMinor = '0';
    state.inventory = [];
    state.catalog = [];
  }
  state.ready = true;
  emit('ready');
}

export async function refreshCases(notify = true) {
  const result = await api.get('/v1/cases?limit=100');
  state.cases = (result.cases || []).map(normalizeCase);
  state.online = true;
  if (notify) emit('cases');
  return state.cases;
}

export async function refreshActivity(notify = true) {
  const result = await api.get('/v1/activity/recent?limit=40');
  state.activities = (result.activities || []).map(normalizeActivity);
  if (notify) emit('activity');
  return state.activities;
}

/* The catalogue, whole.
 *
 * The server caps a page at a hundred items and orders them cheapest first, so one request
 * silently drops everything above the hundredth-cheapest row. With the upgrader's fifty-one fixed
 * denominations sitting on top of the observed catalogue, what a single request drops is the
 * entire top of the ladder — the half players are actually aiming at, and the half a truncation
 * gives no sign of having removed.
 *
 * Paging until a short page comes back is the only version of this that stays correct the next
 * time the catalogue grows. The page ceiling below is a runaway guard rather than a size limit: a
 * server that kept answering with full pages would otherwise spin here forever. */
const CATALOG_PAGE = 100;
const CATALOG_MAX_PAGES = 20;

async function fetchCatalogItems() {
  const items = [];
  for (let page = 0; page < CATALOG_MAX_PAGES; page += 1) {
    const result = await api.get(
      '/v1/catalog/items?limit=' + CATALOG_PAGE + '&offset=' + page * CATALOG_PAGE,
    );
    const batch = result.items || [];
    items.push(...batch);
    if (batch.length < CATALOG_PAGE) break;
  }
  return items.map((item) => normalizeItem(item));
}

export async function refreshPrivate(notify = true) {
  if (!state.authenticated) return;
  const [balance, inventory, catalog, fairness, upgradeConfig] = await Promise.all([
    api.get('/v1/balance'),
    api.get('/v1/inventory'),
    fetchCatalogItems(),
    api.get('/v1/fairness/current'),
    api.get('/v1/upgrades/config'),
  ]);
  state.balanceMinor = String(balance.balanceMinor || '0');
  state.balance = toSafeNumber(state.balanceMinor);
  state.inventory = (inventory.items || []).map((item) => normalizeItem(item, true));
  state.catalog = catalog;
  state.fairness = fairness;
  state.upgradeConfig = upgradeConfig;
  await Promise.all([
    refreshVaultConfig(false), refreshPiggy(false), refreshQuests(false), refreshWar(false),
    refreshReferrals(false), refreshRakeback(false), refreshVip(false),
  ]);
  if (notify) emit('private');
}

export async function turnstileConfig() {
  return api.get('/v1/auth/pay/turnstile');
}

export async function startLogin(minecraftUsername, turnstileToken) {
  /* The field is omitted rather than sent empty: the request schema is strict, and a deployment
   * with no challenge configured would refuse a body carrying one. */
  return api.post('/v1/auth/pay/start', {
    minecraftUsername,
    ...(turnstileToken ? { turnstileToken } : {}),
  });
}

export async function loginStatus(challengeId) {
  return api.get('/v1/auth/pay/status?challengeId=' + encodeURIComponent(challengeId));
}

export async function completeLogin(challengeId) {
  const result = await api.post('/v1/auth/link/complete', { challengeId });
  setCsrfToken(result.csrfToken);
  state.user = result.user;
  state.authenticated = true;
  state.online = true;
  try {
    await refreshPrivate(false);
  } catch (error) {
    // The session already exists at this point. A secondary dashboard endpoint must not make the
    // completed login look like it failed, or a retry hits CHALLENGE_USED and strands the modal.
    state.lastError = error;
    console.warn('Post-login data refresh failed', error);
  }
  emit('login');
  return result.user;
}

/* Developer login. Skips the pay-login challenge so the site can be worked on with no custody
 * bot online, and returns a real session — everything after it is the genuine server path, not a
 * mock. The endpoint only exists when the backend was started with DEV_LOGIN_ENABLED, and the
 * backend refuses to start with that set in production. */
export async function devLogin(token, balanceMinor) {
  const payload = { token };
  if (balanceMinor) payload.balanceMinor = String(balanceMinor);
  const result = await api.post('/v1/dev/login', payload);
  setCsrfToken(result.csrfToken);
  state.user = result.user;
  state.authenticated = true;
  state.online = true;
  await refreshPrivate(false);
  emit('login');
  return result;
}

export async function logout() {
  await api.post('/v1/auth/logout', {});
  state.authenticated = false;
  state.user = null;
  state.balance = 0;
  state.balanceMinor = '0';
  state.inventory = [];
  state.catalog = [];
  state.fairness = null;
  emit('logout');
}

export async function openCase(selectedCase) {
  if (!state.authenticated) throw new ApiError(401, 'AUTH_REQUIRED', 'Log in before opening a case');
  if (!state.fairness) state.fairness = await api.get('/v1/fairness/current');
  const result = await api.post(
    '/v1/cases/' + encodeURIComponent(selectedCase.id) + '/open',
    {
      clientSeed: clientSeed(),
      serverSeedHash: state.fairness.serverSeedHash,
      expectedPriceMinor: selectedCase.priceMinor,
    },
    { idempotencyKey: idempotencyKey() },
  );
  state.balanceMinor = String(result.balanceMinor);
  state.balance = toSafeNumber(state.balanceMinor);
  await Promise.all([refreshInventory(false), refreshFairness(false), refreshActivity(false)]);
  emit('case-open');
  return { ...result, item: normalizeItem(result.item) };
}

export async function runUpgrade(inventoryItem, targetItem, quantity = 1) {
  if (!state.authenticated) throw new ApiError(401, 'AUTH_REQUIRED', 'Log in before upgrading');
  if (!state.fairness) state.fairness = await api.get('/v1/fairness/current');
  const result = await api.post(
    '/v1/upgrades',
    {
      clientSeed: clientSeed(),
      serverSeedHash: state.fairness.serverSeedHash,
      targetCatalogItemId: targetItem.catalogItemId,
      targetQuantity: 1,
      expectedTargetUnitValueMinor: targetItem.unitValueMinor,
      stakes: [{
        inventoryLotId: inventoryItem.lotId,
        quantity,
        expectedUnitValueMinor: inventoryItem.unitValueMinor,
      }],
    },
    { idempotencyKey: idempotencyKey() },
  );
  await Promise.all([refreshInventory(false), refreshCatalog(false), refreshFairness(false), refreshActivity(false)]);
  emit('upgrade');
  return result;
}

/* The same wager with cash as its source of value. The backend debits the wallet instead of
 * consuming a lot, and a win still awards a real item, so the only differences here are the
 * request body and the need to re-read the balance afterwards. */
export async function runBalanceUpgrade(stakeMinor, targetItem) {
  if (!state.authenticated) throw new ApiError(401, 'AUTH_REQUIRED', 'Log in before upgrading');
  if (!state.fairness) state.fairness = await api.get('/v1/fairness/current');
  const result = await api.post(
    '/v1/upgrades',
    {
      clientSeed: clientSeed(),
      serverSeedHash: state.fairness.serverSeedHash,
      targetCatalogItemId: targetItem.catalogItemId,
      targetQuantity: 1,
      expectedTargetUnitValueMinor: targetItem.unitValueMinor,
      balanceStake: { balanceMinor: String(stakeMinor) },
    },
    { idempotencyKey: idempotencyKey() },
  );
  await Promise.all([
    refreshBalance(false), refreshInventory(false), refreshCatalog(false),
    refreshFairness(false), refreshActivity(false),
  ]);
  emit('upgrade');
  return result;
}

/* ─────────── piggy bank, quests, streak, faction war ───────────
 * Every figure here is server-derived. Nothing counts up locally: a number the browser invents is
 * a number the next refresh contradicts.
 */
export async function refreshPiggy(notify = true) {
  if (!state.authenticated) return state.piggyDeposits;
  const piggy = await api.get('/v1/vault/piggy-bank');
  state.piggyDeposits = (piggy.deposits || []).map(normalizePiggyDeposit);
  if (notify) emit('piggy');
  return state.piggyDeposits;
}

export async function refreshVaultConfig(notify = true) {
  if (!state.authenticated) return state.vaultConfig;
  state.vaultConfig = await api.get('/v1/vault/config');
  if (notify) emit('piggy');
  return state.vaultConfig;
}

function normalizePiggyDeposit(raw) {
  return {
    id: raw.id,
    principalMinor: String(raw.principalMinor || '0'),
    principal: toSafeNumber(raw.principalMinor),
    aprBps: Number(raw.aprBps || 0),
    lockDays: Number(raw.lockDays || 0),
    maturedPayoutMinor: String(raw.maturedPayoutMinor || '0'),
    maturedPayout: toSafeNumber(raw.maturedPayoutMinor),
    payoutMinor: raw.payoutMinor == null ? null : String(raw.payoutMinor),
    payout: raw.payoutMinor == null ? null : toSafeNumber(raw.payoutMinor),
    openedAt: raw.openedAt ? new Date(raw.openedAt) : null,
    unlocksAt: raw.unlocksAt ? new Date(raw.unlocksAt) : null,
    claimedAt: raw.claimedAt ? new Date(raw.claimedAt) : null,
    brokenAt: raw.brokenAt ? new Date(raw.brokenAt) : null,
    state: raw.state || 'open',
    matured: !!raw.matured,
  };
}

export async function openPiggyBank(principalMinor, lockDays) {
  if (!state.authenticated) throw new ApiError(401, 'AUTH_REQUIRED', 'Log in before depositing');
  const result = await api.post(
    '/v1/vault/piggy-bank',
    { principalMinor: String(principalMinor), lockDays: Number(lockDays) },
    { idempotencyKey: idempotencyKey() },
  );
  await Promise.all([refreshBalance(false), refreshPiggy(false)]);
  emit('piggy-open');
  return normalizePiggyDeposit(result);
}

export async function settlePiggyBank(depositId) {
  if (!state.authenticated) throw new ApiError(401, 'AUTH_REQUIRED', 'Log in before claiming');
  const result = await api.post(
    '/v1/vault/piggy-bank/' + encodeURIComponent(depositId) + '/settle',
    {},
    { idempotencyKey: idempotencyKey() },
  );
  await Promise.all([refreshBalance(false), refreshPiggy(false)]);
  emit('piggy-settle');
  return normalizePiggyDeposit(result);
}

/* ─────────── chat ───────────
 * Reads are public so the rail has content before login; writing needs a session. The big-hit
 * threshold comes from the server alongside the messages, so the client never has to guess what
 * counts as big. */
export async function refreshChat(notify = true) {
  const result = await api.get('/v1/chat?limit=50');
  state.chat = {
    messages: result.messages || [],
    slowModeSeconds: Number(result.slowModeSeconds || 0),
    maxLength: Number(result.maxLength || 240),
    bigHitMinor: String(result.bigHitMinor ?? state.chat?.bigHitMinor ?? '0'),
  };
  if (notify) emit('chat');
  return state.chat;
}

export async function sendChat(body) {
  if (!state.authenticated) throw new ApiError(401, 'AUTH_REQUIRED', 'Log in before chatting');
  const result = await api.post('/v1/chat', { body });
  // Append immediately rather than waiting for the next poll: your own message should appear the
  // instant it is accepted, not up to six seconds later.
  state.chat.messages = [...state.chat.messages, result.message].slice(-100);
  emit('chat');
  return result.message;
}

export async function refreshQuests(notify = true) {
  if (!state.authenticated) return state.quests;
  const [quests, streak] = await Promise.all([api.get('/v1/quests'), api.get('/v1/streak')]);
  state.quests = quests.quests || [];
  state.questDay = quests.questDay;
  state.streak = streak;
  if (notify) emit('quests');
  return state.quests;
}

export async function claimQuest(questCode) {
  const result = await api.post('/v1/quests/claim', { questCode });
  await Promise.all([refreshBalance(false), refreshQuests(false)]);
  emit('quest-claim');
  return result;
}

export async function claimStreak() {
  const result = await api.post('/v1/streak/claim', {});
  await Promise.all([refreshBalance(false), refreshQuests(false)]);
  emit('streak-claim');
  return result;
}

export async function refreshWar(notify = true) {
  if (!state.authenticated) return state.war;
  state.war = await api.get('/v1/factions');
  if (notify) emit('war');
  return state.war;
}

export async function joinFaction(factionId) {
  const result = await api.post('/v1/factions/join', { factionId });
  await refreshWar(false);
  emit('war-join');
  return result;
}

export async function verifyFairness(serverSeed, clientSeed, nonce) {
  return api.post('/v1/fairness/verify', { serverSeed, clientSeed, nonce: Number(nonce) });
}

export async function upgradeHistory(limit = 25) {
  return api.get('/v1/upgrades/history?limit=' + Number(limit));
}

export async function caseHistory(limit = 25) {
  return api.get('/v1/cases/history?limit=' + Number(limit));
}

export async function refreshBalance(notify = true) {
  if (!state.authenticated) return state.balanceMinor;
  const balance = await api.get('/v1/balance');
  state.balanceMinor = String(balance.balanceMinor || '0');
  state.balance = toSafeNumber(state.balanceMinor);
  if (notify) emit('balance');
  return state.balanceMinor;
}

/* ─────────── money that arrives from outside the browser ───────────
 *
 * Every other credit on this platform is the answer to something this tab asked for: you open a
 * crate, the response carries the payout. A deposit is not like that. Somebody pays the bot in
 * game, the bot reports the chat receipt and the gateway credits the account — all of it finishes
 * without this tab being involved, so there is no response to react to and nothing to await. The
 * only way the page finds out is by asking, which is what this does.
 *
 * The ledger is polled rather than the balance, because a balance alone cannot say what moved. A
 * player who deposits 1M while a duel settles sees one number change and has to guess which event
 * it was; the ledger names it, and the toast can too.
 */
const DEPOSIT_KINDS = new Set(['cash_deposit', 'pay_login_deposit']);

/** The newest row already accounted for. Null means "not yet established for this session". */
let depositWatermark = null;

/**
 * Returns deposits credited since the previous call, oldest first.
 *
 * The first call after a login only sets the watermark and reports nothing. History is not news,
 * and announcing every past deposit the moment somebody signs in would train people to dismiss the
 * toast that actually matters.
 */
export async function pollDeposits() {
  if (!state.authenticated) {
    depositWatermark = null;
    return [];
  }
  const result = await api.get('/v1/balance/transactions?limit=25');
  const rows = result.transactions || [];
  if (!rows.length) return [];

  if (depositWatermark === null) {
    depositWatermark = rows[0].id;
    return [];
  }
  if (rows[0].id === depositWatermark) return [];

  const fresh = [];
  for (const row of rows) {
    if (row.id === depositWatermark) break;
    if (DEPOSIT_KINDS.has(row.kind)) fresh.push(row);
  }
  depositWatermark = rows[0].id;

  /* The newest row carries the balance the server computed after it, so the pill can be corrected
   * from what we already fetched instead of racing a second request against the next round. */
  state.balanceMinor = String(rows[0].balance_after_minor ?? state.balanceMinor);
  state.balance = toSafeNumber(state.balanceMinor);
  emit('balance');

  return fresh.reverse();
}

export async function sellInventoryItem(item, quantity = 1) {
  const result = await api.post(
    '/v1/inventory/' + encodeURIComponent(item.lotId) + '/sell',
    {
      quantity,
      expectedUnitValueMinor: item.unitValueMinor,
      expectedSellRateBps: item.sellRateBps,
    },
    { idempotencyKey: idempotencyKey() },
  );
  state.balanceMinor = String(result.balanceMinor);
  state.balance = toSafeNumber(state.balanceMinor);
  await Promise.all([refreshInventory(false), refreshCatalog(false)]);
  emit('sale');
  return result;
}

export async function cashDepositInfo() {
  return api.get('/v1/cash-deposits/info');
}

/* ─────────── cash withdrawals ───────────
 *
 * Separate from withdrawInventoryItem below it, which moves physical items and stays closed. This
 * moves a number: the bot pays the player with DonutSMP's own /pay.
 */

export async function cashWithdrawalInfo() {
  return api.get('/v1/cash-withdrawals/info');
}

export async function requestCashWithdrawal(amountMinor) {
  /* The idempotency key is what makes a double-tapped Send one payout rather than two. The server
   * replays the first result instead of debiting again. */
  const result = await api.post(
    '/v1/cash-withdrawals',
    { amountMinor: String(amountMinor) },
    { idempotencyKey: idempotencyKey() },
  );
  emit('balance');
  return result;
}

export async function cashWithdrawalStatus(id) {
  return api.get('/v1/cash-withdrawals/' + encodeURIComponent(id));
}

export async function withdrawInventoryItem(item, quantity = 1) {
  const result = await api.post(
    '/v1/withdrawals',
    { items: [{ inventoryLotId: item.lotId, quantity }] },
    { idempotencyKey: idempotencyKey() },
  );
  await refreshInventory(false);
  emit('withdrawal');
  return result;
}

async function refreshInventory(notify = true) {
  const result = await api.get('/v1/inventory');
  state.inventory = (result.items || []).map((item) => normalizeItem(item, true));
  if (notify) emit('inventory');
}

async function refreshCatalog(notify = true) {
  state.catalog = await fetchCatalogItems();
  if (notify) emit('catalog');
}

async function refreshFairness(notify = true) {
  state.fairness = await api.get('/v1/fairness/current');
  if (notify) emit('fairness');
}

/* ─────────── referrals ───────────
 *
 * The dashboard is one call. Everything on it — the code, the per-invite progress, the totals —
 * is computed server-side from the same row the payout gate reads, so the bars on the page and
 * the money in the ledger cannot tell different stories.
 *
 * A 404 means the programme is switched off in this deployment rather than that the request
 * failed, so it resolves to null instead of throwing: the page renders a disabled state and the
 * console stays clean.
 */
export async function refreshReferrals(notify = true) {
  if (!state.authenticated) {
    state.referrals = null;
    return null;
  }
  try {
    state.referrals = await api.get('/v1/referrals');
  } catch (error) {
    /* Never fatal. This call sits inside refreshPrivate's fan-out, which bootstrap awaits, so a
     * rethrow here would take the whole app offline over an optional promotions page — a 500 on
     * /v1/referrals would log the player out of crates, the upgrader and their wallet. A 404 is
     * the programme being switched off; anything else is a fault worth seeing in the console but
     * not worth breaking the site for. Either way the page renders its unavailable state. */
    state.referrals = null;
    if (!(error instanceof ApiError && error.status === 404)) {
      console.warn('referrals unavailable', error);
    }
  }
  if (notify) emit('referrals');
  return state.referrals;
}

export async function attachReferralCode(code) {
  const result = await api.post('/v1/referrals/attach', { code });
  await refreshReferrals(false);
  emit('referrals');
  return result;
}

/* Hands back Discord's own authorize URL rather than navigating here, so the caller decides when
 * the page leaves. The state parameter inside it is single-use and short-lived. */
export async function startDiscordVerification() {
  const result = await api.post('/v1/referrals/discord/start', {});
  return result.authorizeUrl;
}

/* ─────────── rakeback, races, creators, boards ───────────
 *
 * Every one of these is optional per deployment: the route answers 404 when the programme is off.
 * A 404 therefore resolves to null rather than throwing, exactly as the referral loader does, so a
 * disabled feature renders its own unavailable state instead of taking a page down.
 *
 * None of them is fatal either. These run inside refreshPrivate's fan-out, which bootstrap awaits,
 * so a rethrow would put the whole app offline over a promotions page.
 */
async function loadOptional(path, slot, notify) {
  try {
    state[slot] = await api.get(path);
  } catch (error) {
    state[slot] = null;
    if (!(error instanceof ApiError && error.status === 404)) {
      console.warn(slot + ' unavailable', error);
    }
  }
  if (notify) emit(slot);
  return state[slot];
}

/* The VIP standing: lifetime wager, the level it earns, and the whole thirty-row ladder.
 *
 * Optional per deployment like the other programmes, so a 404 resolves to null rather than
 * throwing, and never fatal — it rides in refreshPrivate's fan-out, which bootstrap awaits. */
export function refreshVip(notify = true) {
  if (!state.authenticated) { state.vip = null; return Promise.resolve(null); }
  return loadOptional('/v1/vip', 'vip', notify);
}

export function refreshRakeback(notify = true) {
  if (!state.authenticated) { state.rakeback = null; return Promise.resolve(null); }
  return loadOptional('/v1/rakeback', 'rakeback', notify);
}

/* Public: a race leaderboard is worth showing to somebody who has not signed up yet. */
export function refreshRaces(notify = true) {
  return loadOptional('/v1/races', 'races', notify);
}

export function refreshCreator(notify = true) {
  if (!state.authenticated) { state.creator = null; return Promise.resolve(null); }
  return loadOptional('/v1/creators/me', 'creator', notify);
}

export function refreshLeaderboard(board = 'wagered', notify = true) {
  return loadOptional('/v1/leaderboard?board=' + encodeURIComponent(board), 'leaderboard', notify);
}

export function refreshStatistics(notify = true) {
  if (!state.authenticated) { state.statistics = null; return Promise.resolve(null); }
  return loadOptional('/v1/statistics', 'statistics', notify);
}

export async function claimRakeback(tier) {
  const result = await api.post('/v1/rakeback/claim', { tier });
  state.balanceMinor = String(result.balanceMinor || state.balanceMinor);
  state.balance = toSafeNumber(state.balanceMinor);
  await refreshRakeback(false);
  emit('rakeback');
  return result;
}

export async function settleRaces() {
  const result = await api.post('/v1/races/settle', {});
  await refreshRaces(false);
  emit('races');
  return result;
}

export async function applyForCreatorCode(application) {
  const result = await api.post('/v1/creators/apply', application);
  await refreshCreator(false);
  emit('creator');
  return result;
}

export async function withdrawCreatorApplication() {
  const result = await api.post('/v1/creators/withdraw', {});
  await refreshCreator(false);
  emit('creator');
  return result;
}

/* ─────────── account, wallet ledger, responsible play ───────────
 *
 * These back the profile, wallet, history and settings routes. Unlike the promotions above they
 * are core account surfaces rather than optional programmes, so a failure here is surfaced to the
 * caller instead of being swallowed — a settings page that silently shows stale limits is worse
 * than one that says it could not load.
 */
export async function refreshAccount(notify = true) {
  if (!state.authenticated) {
    state.account = null;
    return null;
  }
  const result = await api.get('/v1/account');
  state.account = result.account ?? null;
  if (notify) emit('account');
  return state.account;
}

export async function refreshTransactions(limit = 50, notify = true) {
  if (!state.authenticated) {
    state.transactions = [];
    return [];
  }
  const result = await api.get('/v1/balance/transactions?limit=' + Number(limit));
  state.transactions = result.transactions || [];
  if (notify) emit('transactions');
  return state.transactions;
}

/* Cooldown only. The daily wager limit it used to sit beside was removed — both the
 * platform-wide ceiling and the per-player self-set figure — so this endpoint now carries one
 * control, and that control only ever moves the cooldown forward. */
export async function setCooldown(cooldownHours) {
  const result = await api.put('/v1/account/limits', { cooldownHours });
  await refreshAccount(false);
  emit('account');
  return result;
}

export async function setSelfExclusion(durationDays) {
  const result = await api.post('/v1/account/self-exclusion', { durationDays });
  await refreshAccount(false);
  emit('account');
  return result;
}

export const canAfford = (amount) => state.authenticated && state.balance >= amount;

// Legacy exports remain no-op so old, now-unmounted demo modules cannot mutate authoritative state.
export const spend = () => false;
export const credit = () => undefined;
export const useKey = () => false;
export const addKeys = () => undefined;
export const addXp = () => [];
export const logMatch = () => undefined;
export const noteWager = () => undefined;
export const bonusReady = () => false;
export const bonusIn = () => 0;
export const bonusAmount = () => 0;
export const claimBonus = () => 0;
export const referralTick = () => 0;
export const resetAll = () => undefined;
