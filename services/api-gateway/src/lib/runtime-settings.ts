import type { AppConfig } from '../config.js';
import type { DbClient } from './db.js';
import { AppError } from './errors.js';
import { assertVipSolvency } from './vip.js';

type SettingKind = 'boolean' | 'integer' | 'bigint';

type SettingGroup =
  | 'features'
  | 'economy'
  | 'chat'
  | 'rewards'
  | 'rakeback'
  | 'roulette'
  | 'blackjack'
  | 'crash'
  | 'mines'
  | 'tower'
  | 'chicken'
  | 'plinko'
  | 'slots'
  | 'dice'
  | 'fishing'
  | 'icefishing'
  | 'derby'
  | 'discord'
  | 'alerts'
  | 'duels'
  | 'coinflip'
  | 'minesduel'
  | 'payouts'
  | 'dailycodes'
  | 'crowns'
  | 'staking'
  | 'weeklyQuests'
  | 'jackpot'
  | 'rain'
  | 'social'
  | 'bots'
  | 'limits';

interface Definition {
  readonly kind: SettingKind;
  readonly group: SettingGroup;
  readonly label: string;
  readonly min?: bigint;
  readonly max?: bigint;
}

const BIGINT_MAX = 9_223_372_036_854_775_807n;

/**
 * The complete allow-list of values that may be changed without a deployment.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A KEY BELONGS HERE ONLY IF ITS CONSUMER RE-READS IT PER REQUEST
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `buildApp` replaces its `config` with this class's Proxy before a single route is registered,
 * so any handler reading `config.x` at request time observes an override immediately. A value
 * captured once at boot — the Fastify logger's level, the trusted proxy list, the database pool —
 * would not, and listing it here would put a dial in the admin panel that visibly moves and
 * changes nothing. That is worse than not offering it, so those stay deployment-only.
 *
 * `factionWarPrizePoolMinor` and `factionWarDays` are absent for the same reason from the other
 * direction: nothing in the service reads them at all today.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * DELIBERATELY ABSENT
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Secrets and cryptographic material; the app origin and redirect URIs; the custody switches
 * (`physicalCustodyEnabled`, `minecraftTransfersEnabled`, `houseStockUnlimited`), because minting
 * against stock no bot is holding puts the ledger permanently out of step; `devLoginEnabled`,
 * which is an authentication bypass; the Discord control plane, which is the remote control for
 * this very panel; Turnstile and the pay-login window, which guard the sign-in path; and the
 * session TTL. Those define the trust boundary rather than the economy, and a panel that can
 * rewrite its own guard rails is not a guard rail.
 *
 * Everything below is a reversible operational or economic control, and every write goes through
 * `appendAudit` carrying the previous value, the new value and a mandatory reason.
 */
export const runtimeSettingDefinitions = {
  /* ── what is switched on ── */
  chatEnabled: { kind: 'boolean', group: 'features', label: 'Chat enabled' },
  rouletteEnabled: { kind: 'boolean', group: 'features', label: 'Roulette enabled' },
  vipEnabled: { kind: 'boolean', group: 'features', label: 'VIP enabled' },
  rakebackEnabled: { kind: 'boolean', group: 'features', label: 'Rakeback enabled' },
  skillDuelEnabled: { kind: 'boolean', group: 'features', label: 'Skill duels enabled' },
  vaultJackpotEnabled: { kind: 'boolean', group: 'features', label: 'Vault jackpot enabled' },
  lavaRainEnabled: { kind: 'boolean', group: 'features', label: 'Lava Rain enabled' },
  tipsEnabled: { kind: 'boolean', group: 'features', label: 'Tips enabled' },
  sideBetsEnabled: { kind: 'boolean', group: 'features', label: 'Side bets enabled' },
  racesEnabled: { kind: 'boolean', group: 'features', label: 'Races enabled' },
  creatorProgrammeEnabled: {
    kind: 'boolean',
    group: 'features',
    label: 'Creator programme enabled',
  },
  referralsEnabled: { kind: 'boolean', group: 'features', label: 'Referrals enabled' },
  /* Case battles. Read on every create, join and bot fill, so flipping it closes the door at once.
   * A player can still LEAVE a lobby and take their stake back with it off, and every open lobby
   * is refunded by the sweeper while it stays off. */
  battlesEnabled: { kind: 'boolean', group: 'features', label: 'Case battles open' },
  battleBotsEnabled: {
    kind: 'boolean',
    group: 'features',
    label: 'Case battles: fill with bots',
  },
  discordFlexEnabled: { kind: 'boolean', group: 'features', label: 'Discord flex enabled' },
  /* Settles crate and upgrader prizes as cash instead of a lot. Safe to move either way: the item
   * still carries the rarity, the name and the art the reveal needs, rounds already settled are
   * untouched, and switching it back off with no custody stock reports the target out of stock
   * rather than corrupting anything. */
  cashOnlyPlay: { kind: 'boolean', group: 'features', label: 'Cash-only play' },

  /* ── the house's own maths ──
   *
   * The edge is safe to move mid-flight because nothing quotes it and settles later against a
   * re-read: roulette writes `payout_bps` onto each chip as it is placed and settles from that
   * row, and an upgrader round prices its chance and resolves inside one transaction. Chips
   * already on the table therefore keep the price they were quoted, and only the next bet sees
   * the new figure. */
  houseEdgeBps: {
    kind: 'integer',
    group: 'economy',
    label: 'House edge (bps)',
    min: 0n,
    max: 5_000n,
  },
  itemSellRateBps: {
    kind: 'integer',
    group: 'economy',
    label: 'Item sell rate (bps)',
    min: 1n,
    max: 10_000n,
  },
  minMultiplierBps: {
    kind: 'integer',
    group: 'economy',
    label: 'Upgrader minimum multiplier (bps)',
    min: 10_001n,
    max: 1_000_000n,
  },
  maxMultiplierBps: {
    kind: 'integer',
    group: 'economy',
    label: 'Upgrader maximum multiplier (bps)',
    min: 10_002n,
    max: 10_000_000n,
  },
  maxWinChancePpm: {
    kind: 'integer',
    group: 'economy',
    label: 'Upgrader maximum win chance (ppm)',
    min: 1n,
    max: 1_000_000n,
  },
  vaultYieldBpsPerDay: {
    kind: 'integer',
    group: 'economy',
    label: 'Vault yield per day (bps)',
    min: 0n,
    max: 1_000n,
  },
  vaultYieldCapBps: {
    kind: 'integer',
    group: 'economy',
    label: 'Vault yield lifetime cap (bps)',
    min: 0n,
    max: 10_000n,
  },

  /* ── chat ── */
  chatSlowModeSeconds: {
    kind: 'integer',
    group: 'chat',
    label: 'Chat slow mode (seconds)',
    min: 0n,
    max: 3600n,
  },
  chatBigHitMinor: {
    kind: 'bigint',
    group: 'chat',
    label: 'Big-hit chat threshold',
    min: 0n,
    max: BIGINT_MAX,
  },

  /* ── what the house gives back ── */
  streakBaseRewardMinor: {
    kind: 'bigint',
    group: 'rewards',
    label: 'Daily reward base amount',
    min: 0n,
    max: BIGINT_MAX,
  },
  streakDailyWagerRequiredMinor: {
    kind: 'bigint',
    group: 'rewards',
    label: 'Daily reward wager requirement',
    min: 0n,
    max: BIGINT_MAX,
  },
  streakMaxMultiplier: {
    kind: 'integer',
    group: 'rewards',
    label: 'Daily reward streak cap',
    min: 1n,
    max: 50n,
  },
  referralBonusMinor: {
    kind: 'bigint',
    group: 'rewards',
    label: 'Referral invite reward',
    min: 0n,
    max: BIGINT_MAX,
  },
  referralBonusWagerMinor: {
    kind: 'bigint',
    group: 'rewards',
    label: 'Referral wager to unlock',
    min: 0n,
    max: BIGINT_MAX,
  },
  signupBonusMinor: {
    kind: 'bigint',
    group: 'rewards',
    label: 'Signup bonus (0 turns it off)',
    min: 0n,
    max: BIGINT_MAX,
  },
  signupBonusWagerMultiplier: {
    kind: 'integer',
    group: 'rewards',
    label: 'Free money wager before withdrawing (x amount: bonus, codes, rewards, rain, giveaways)',
    min: 0n,
    max: 100n,
  },
  depositWagerMultiplier: {
    kind: 'integer',
    group: 'limits',
    label: 'Deposit wager before withdrawing (x deposit)',
    min: 0n,
    max: 100n,
  },
  referralRevshareBps: {
    kind: 'integer',
    group: 'rewards',
    label: 'Referral revenue share (bps of margin)',
    min: 0n,
    max: 10_000n,
  },
  creatorMaxRevshareBps: {
    kind: 'integer',
    group: 'rewards',
    label: 'Creator revenue share ceiling (bps of margin)',
    min: 0n,
    max: 10_000n,
  },
  raceLeaderboardSize: {
    kind: 'integer',
    group: 'rewards',
    label: 'Race leaderboard size',
    min: 3n,
    max: 200n,
  },

  /* ── rakeback ──
   *
   * A share of the house MARGIN, not of turnover, and it is added to the VIP ladder and the
   * referral share by the solvency guard below before it is allowed to take effect.
   *
   * One rate since migration 042. The daily, weekly and monthly clocks were retired, so raising
   * this is how the programme is made more generous now. */
  rakebackInstantBps: {
    kind: 'integer',
    group: 'rakeback',
    label: 'Instant rakeback (bps of margin)',
    min: 0n,
    max: 10_000n,
  },

  /* ── the roulette table ── */
  rouletteRoundSeconds: {
    kind: 'integer',
    group: 'roulette',
    label: 'Roulette betting window (seconds)',
    min: 5n,
    max: 300n,
  },
  rouletteSpinSeconds: {
    kind: 'integer',
    group: 'roulette',
    label: 'Roulette spin duration (seconds)',
    min: 1n,
    max: 60n,
  },
  rouletteMinStakeMinor: {
    kind: 'bigint',
    group: 'roulette',
    label: 'Roulette minimum chip',
    min: 1n,
    max: BIGINT_MAX,
  },
  rouletteMaxStakeMinor: {
    kind: 'bigint',
    group: 'roulette',
    label: 'Roulette maximum chip',
    min: 1n,
    max: BIGINT_MAX,
  },
  rouletteMaxRoundStakeMinor: {
    kind: 'bigint',
    group: 'roulette',
    label: 'Roulette table limit (per player, per spin)',
    min: 1n,
    max: BIGINT_MAX,
  },
  roulettePaused: {
    kind: 'boolean',
    group: 'roulette',
    label: 'Pause after current round',
  },

  /* ── blackjack ── The edge is the table's rules, not a dial; see lib/blackjack.ts. */
  blackjackEnabled: {
    kind: 'boolean',
    group: 'blackjack',
    label: 'Blackjack open (hands in play can always finish)',
  },
  blackjackMinStakeMinor: {
    kind: 'bigint',
    group: 'blackjack',
    label: 'Blackjack minimum stake',
    min: 1n,
    max: BIGINT_MAX,
  },
  blackjackMaxStakeMinor: {
    kind: 'bigint',
    group: 'blackjack',
    label: 'Blackjack maximum stake (a double puts twice this on the table)',
    min: 1n,
    max: BIGINT_MAX,
  },

  /* ── crash ── The edge is fixed in lib/crash.ts; these are the table's limits. */
  crashEnabled: {
    kind: 'boolean',
    group: 'crash',
    label: 'Crash open (a round already running always finishes and pays)',
  },
  crashMinStakeMinor: {
    kind: 'bigint',
    group: 'crash',
    label: 'Crash minimum bet',
    min: 1n,
    max: BIGINT_MAX,
  },
  crashMaxStakeMinor: {
    kind: 'bigint',
    group: 'crash',
    label: 'Crash maximum bet',
    min: 1n,
    max: BIGINT_MAX,
  },
  crashMaxPayoutMinor: {
    kind: 'bigint',
    group: 'crash',
    label: 'Crash maximum payout per bet (a bet cashes out automatically when it reaches this)',
    min: 1n,
    max: BIGINT_MAX,
  },

  /* ── mines ── The edge is fixed in lib/mines.ts; these are the table's limits. */
  minesEnabled: {
    kind: 'boolean',
    group: 'mines',
    label: 'Mines open (a game in play can always finish)',
  },
  minesMinStakeMinor: {
    kind: 'bigint',
    group: 'mines',
    label: 'Mines minimum stake',
    min: 1n,
    max: BIGINT_MAX,
  },
  minesMaxStakeMinor: {
    kind: 'bigint',
    group: 'mines',
    label: 'Mines maximum stake',
    min: 1n,
    max: BIGINT_MAX,
  },
  minesMaxPayoutMinor: {
    kind: 'bigint',
    group: 'mines',
    label: 'Mines maximum payout per game (a game cashes out automatically when it reaches this)',
    min: 1n,
    max: BIGINT_MAX,
  },

  /* ── tower ── The edge and the modes are fixed in lib/tower.ts; these are the table's limits. */
  towerEnabled: {
    kind: 'boolean',
    group: 'tower',
    label: 'Tower open (a climb in play can always finish)',
  },
  towerMinStakeMinor: {
    kind: 'bigint',
    group: 'tower',
    label: 'Tower minimum stake',
    min: 1n,
    max: BIGINT_MAX,
  },
  towerMaxStakeMinor: {
    kind: 'bigint',
    group: 'tower',
    label: 'Tower maximum stake',
    min: 1n,
    max: BIGINT_MAX,
  },
  towerMaxPayoutMinor: {
    kind: 'bigint',
    group: 'tower',
    label: 'Tower maximum payout per game (a climb cashes out automatically when it reaches this)',
    min: 1n,
    max: BIGINT_MAX,
  },

  /* ── chicken ── The edge and the modes are fixed in lib/chicken.ts; these are the road's limits. */
  chickenEnabled: {
    kind: 'boolean',
    group: 'chicken',
    label: 'Chicken open (a run in play can always finish)',
  },
  chickenMinStakeMinor: {
    kind: 'bigint',
    group: 'chicken',
    label: 'Chicken minimum stake',
    min: 1n,
    max: BIGINT_MAX,
  },
  chickenMaxStakeMinor: {
    kind: 'bigint',
    group: 'chicken',
    label: 'Chicken maximum stake',
    min: 1n,
    max: BIGINT_MAX,
  },
  chickenMaxPayoutMinor: {
    kind: 'bigint',
    group: 'chicken',
    label: 'Chicken maximum payout per run (a run cashes out automatically when it reaches this)',
    min: 1n,
    max: BIGINT_MAX,
  },

  /* ── plinko ── The edge is fixed in lib/plinko.ts; these are the board's limits. */
  plinkoEnabled: {
    kind: 'boolean',
    group: 'plinko',
    label: 'Plinko open',
  },
  plinkoMinStakeMinor: {
    kind: 'bigint',
    group: 'plinko',
    label: 'Plinko minimum stake per ball',
    min: 1n,
    max: BIGINT_MAX,
  },
  plinkoMaxStakeMinor: {
    kind: 'bigint',
    group: 'plinko',
    label: 'Plinko maximum stake per ball',
    min: 1n,
    max: BIGINT_MAX,
  },
  plinkoMaxPayoutMinor: {
    kind: 'bigint',
    group: 'plinko',
    label: 'Plinko maximum payout per ball (a stake whose best slot would pay more is refused)',
    min: 1n,
    max: BIGINT_MAX,
  },

  /* ── slots ── The strips, pays and the 1,000x round ceiling are fixed in lib/slots.ts. */
  slotsEnabled: {
    kind: 'boolean',
    group: 'slots',
    label: 'Slots open',
  },
  slotsMinStakeMinor: {
    kind: 'bigint',
    group: 'slots',
    label: 'Slots minimum stake per spin',
    min: 1n,
    max: BIGINT_MAX,
  },
  slotsMaxStakeMinor: {
    kind: 'bigint',
    group: 'slots',
    label: 'Slots maximum stake per spin',
    min: 1n,
    max: BIGINT_MAX,
  },
  slotsMaxPayoutMinor: {
    kind: 'bigint',
    group: 'slots',
    label: 'Slots maximum payout per spin (a stake whose 1,000x ceiling would pay more is refused)',
    min: 1n,
    max: BIGINT_MAX,
  },

  /* ── dice ── The edge is fixed in lib/dice.ts; these are the limits. */
  diceEnabled: { kind: 'boolean', group: 'dice', label: 'Dice open' },
  diceMinStakeMinor: {
    kind: 'bigint',
    group: 'dice',
    label: 'Dice minimum stake',
    min: 1n,
    max: BIGINT_MAX,
  },
  diceMaxStakeMinor: {
    kind: 'bigint',
    group: 'dice',
    label: 'Dice maximum stake',
    min: 1n,
    max: BIGINT_MAX,
  },
  diceMaxPayoutMinor: {
    kind: 'bigint',
    group: 'dice',
    label: 'Dice maximum payout per roll (a stake whose win would pay more is refused)',
    min: 1n,
    max: BIGINT_MAX,
  },

  /* ── fishing ── The edge is fixed in lib/fishing.ts; these are the limits. */
  fishingEnabled: { kind: 'boolean', group: 'fishing', label: 'Fishing open' },
  fishingMinStakeMinor: {
    kind: 'bigint',
    group: 'fishing',
    label: 'Fishing minimum stake per cast',
    min: 1n,
    max: BIGINT_MAX,
  },
  fishingMaxStakeMinor: {
    kind: 'bigint',
    group: 'fishing',
    label: 'Fishing maximum stake per cast',
    min: 1n,
    max: BIGINT_MAX,
  },
  fishingMaxPayoutMinor: {
    kind: 'bigint',
    group: 'fishing',
    label: 'Fishing maximum payout per cast (a stake whose best catch would pay more is refused)',
    min: 1n,
    max: BIGINT_MAX,
  },

  /* ── ice fishing ── The edge is fixed in lib/ice-fishing.ts; these are the limits. */
  iceFishingEnabled: { kind: 'boolean', group: 'icefishing', label: 'Ice Fishing open' },
  iceFishingMinStakeMinor: {
    kind: 'bigint',
    group: 'icefishing',
    label: 'Ice Fishing minimum stake per spin',
    min: 1n,
    max: BIGINT_MAX,
  },
  iceFishingMaxStakeMinor: {
    kind: 'bigint',
    group: 'icefishing',
    label: 'Ice Fishing maximum stake per spin',
    min: 1n,
    max: BIGINT_MAX,
  },
  iceFishingMaxPayoutMinor: {
    kind: 'bigint',
    group: 'icefishing',
    label: 'Ice Fishing maximum payout per spin (a stake whose best spin would pay more is refused)',
    min: 1n,
    max: BIGINT_MAX,
  },

  /* ── mob derby ── The edge is fixed in lib/derby.ts; these are the limits. */
  derbyEnabled: { kind: 'boolean', group: 'derby', label: 'Mob Derby open' },
  derbyMinStakeMinor: {
    kind: 'bigint',
    group: 'derby',
    label: 'Mob Derby minimum stake per race',
    min: 1n,
    max: BIGINT_MAX,
  },
  derbyMaxStakeMinor: {
    kind: 'bigint',
    group: 'derby',
    label: 'Mob Derby maximum stake per race',
    min: 1n,
    max: BIGINT_MAX,
  },
  derbyMaxPayoutMinor: {
    kind: 'bigint',
    group: 'derby',
    label: 'Mob Derby maximum payout per race (a stake whose win would pay more is refused)',
    min: 1n,
    max: BIGINT_MAX,
  },

  /* ── discord rewards ── Paid through the community bot to accounts linked to Discord. */
  discordRewardsEnabled: { kind: 'boolean', group: 'discord', label: 'Discord rewards on' },
  discordJoinRewardMinor: {
    kind: 'bigint',
    group: 'discord',
    label: 'Discord join reward (once per account, 0 = off)',
    min: 0n,
    max: BIGINT_MAX,
  },
  discordTagRewardMinor: {
    kind: 'bigint',
    group: 'discord',
    label: 'Discord server-tag reward (per UTC day, 0 = off)',
    min: 0n,
    max: BIGINT_MAX,
  },
  discordRewardMinAccountAgeDays: {
    kind: 'integer',
    group: 'discord',
    label: 'Minimum Discord account age for the join reward (days)',
    min: 0n,
    max: 3650n,
  },

  /* ── staff alerts ── Read by the control bot's alert poll each minute (lib/staff-alerts.ts). The
   * two ids are Discord snowflakes, typed as plain digits; they are stored as bigints because that
   * is the one kind here wide enough to hold one. */
  staffAlertChannelId: {
    kind: 'bigint',
    group: 'alerts',
    label: 'Staff alert channel (Discord channel id, 0 = the bot\'s own setting)',
    min: 0n,
    max: BIGINT_MAX,
  },
  staffAlertRoleId: {
    kind: 'bigint',
    group: 'alerts',
    label: 'Role pinged by a money alert (Discord role id, 0 = no ping)',
    min: 0n,
    max: BIGINT_MAX,
  },
  staffAlertBigWinMinor: {
    kind: 'bigint',
    group: 'alerts',
    label: 'Alert on one round won with at least this much profit (0 = off)',
    min: 0n,
    max: BIGINT_MAX,
  },
  staffAlertDailyProfitMinor: {
    kind: 'bigint',
    group: 'alerts',
    label: 'Alert when a player is this far up over 24 hours (0 = off)',
    min: 0n,
    max: BIGINT_MAX,
  },

  /* ── 1v1 skill duels ── */
  skillDuelRakeBps: {
    kind: 'integer',
    group: 'duels',
    label: 'Duel rake (bps of pot)',
    min: 0n,
    max: 1_000n,
  },
  skillDuelMinStakeMinor: {
    kind: 'bigint',
    group: 'duels',
    label: 'Duel minimum stake',
    min: 1n,
    max: BIGINT_MAX,
  },
  skillDuelMaxStakeMinor: {
    kind: 'bigint',
    group: 'duels',
    label: 'Duel maximum stake',
    min: 1n,
    max: BIGINT_MAX,
  },
  skillDuelLobbyTtlMinutes: {
    kind: 'integer',
    group: 'duels',
    label: 'Duel lobby expiry (minutes)',
    min: 1n,
    max: 1440n,
  },

  /* ── coinflip ── The rake is snapshot onto each game as it opens, so a change only prices the
   * next one. */
  coinflipEnabled: {
    kind: 'boolean',
    group: 'coinflip',
    label: 'Coinflip open',
  },
  coinflipRakeBps: {
    kind: 'integer',
    group: 'coinflip',
    label: 'Coinflip rake (bps of pot)',
    min: 0n,
    max: 1_000n,
  },
  coinflipMinStakeMinor: {
    kind: 'bigint',
    group: 'coinflip',
    label: 'Coinflip minimum stake',
    min: 1n,
    max: BIGINT_MAX,
  },
  coinflipMaxStakeMinor: {
    kind: 'bigint',
    group: 'coinflip',
    label: 'Coinflip maximum stake',
    min: 1n,
    max: BIGINT_MAX,
  },
  coinflipLobbyTtlMinutes: {
    kind: 'integer',
    group: 'coinflip',
    label: 'Coinflip open game expiry (minutes)',
    min: 1n,
    max: 1440n,
  },

  /* ── mines duel ── The rake and the clock are snapshot onto each game as it opens, so a change
   * only prices the next one. */
  minesDuelEnabled: {
    kind: 'boolean',
    group: 'minesduel',
    label: 'Mines Duel open',
  },
  minesDuelRakeBps: {
    kind: 'integer',
    group: 'minesduel',
    label: 'Mines Duel rake (bps of pot)',
    min: 0n,
    max: 1_000n,
  },
  minesDuelMinStakeMinor: {
    kind: 'bigint',
    group: 'minesduel',
    label: 'Mines Duel minimum stake',
    min: 1n,
    max: BIGINT_MAX,
  },
  minesDuelMaxStakeMinor: {
    kind: 'bigint',
    group: 'minesduel',
    label: 'Mines Duel maximum stake',
    min: 1n,
    max: BIGINT_MAX,
  },
  minesDuelLobbyTtlMinutes: {
    kind: 'integer',
    group: 'minesduel',
    label: 'Mines Duel open game expiry (minutes)',
    min: 1n,
    max: 1440n,
  },
  minesDuelPlaySeconds: {
    kind: 'integer',
    group: 'minesduel',
    label: 'Mines Duel play time (seconds both players share)',
    min: 15n,
    max: 600n,
  },

  /* ── daily codes ──
   *
   * Read on every redemption. The ceiling scales every prize; the budget is what the day's prizes
   * together can never pass, and a prize that would pass it is clipped to what is left. */
  dailyCodesEnabled: {
    kind: 'boolean',
    group: 'dailycodes',
    label: 'Daily codes can be redeemed',
  },
  dailyCodeMaxPrizeMinor: {
    kind: 'bigint',
    group: 'dailycodes',
    label: 'Top daily-code prize (every prize is a fraction of this)',
    min: 1n,
    max: BIGINT_MAX,
  },
  dailyCodeBudgetMinor: {
    kind: 'bigint',
    group: 'dailycodes',
    label: 'Most daily codes may pay out in one UTC day, all together',
    min: 1n,
    max: BIGINT_MAX,
  },
  dailyCodeMinWagerMinor: {
    kind: 'bigint',
    group: 'dailycodes',
    label: 'Wagered on the site that UTC day before a daily code can be redeemed (0 = no bar)',
    min: 0n,
    max: BIGINT_MAX,
  },
  dailyCodeFirstPrizeMinor: {
    kind: 'bigint',
    group: 'dailycodes',
    label: 'A player’s first daily code pays at least this (0 = ordinary draw)',
    min: 0n,
    max: BIGINT_MAX,
  },

  /* ── crowns ──
   *
   * Read by the sweeper on every pass and by the board on every request. A longer window keeps
   * crowns longer; a higher stake floor makes them harder to take. The sweep interval is boot-only. */
  crownsEnabled: {
    kind: 'boolean',
    group: 'crowns',
    label: 'Crowns and bounties are kept and shown',
  },
  crownWindowDays: {
    kind: 'integer',
    group: 'crowns',
    label: 'A crown falls when its round is older than this (days)',
    min: 1n,
    max: 365n,
  },
  crownMinStakeMinor: {
    kind: 'bigint',
    group: 'crowns',
    label: 'Smallest stake a round needs to take a crown',
    min: 1n,
    max: BIGINT_MAX,
  },
  crownBountyMaxPrizeMinor: {
    kind: 'bigint',
    group: 'crowns',
    label: 'Largest prize staff may put on one bounty',
    min: 1n,
    max: BIGINT_MAX,
  },

  /* ── house pool ──
   *
   * Read on every stake and by the settler for each day it settles, so a change applies from the
   * next settled day. Closing the pool stops new stakes; what is in keeps settling and unlocking. */
  stakingEnabled: {
    kind: 'boolean',
    group: 'staking',
    label: 'The house pool takes new stakes',
  },
  stakingShareBps: {
    kind: 'integer',
    group: 'staking',
    label: 'Share of the daily house result a full pool gets (bps)',
    min: 0n,
    max: 5_000n,
  },
  stakingPoolCapMinor: {
    kind: 'bigint',
    group: 'staking',
    label: 'Most the pool may hold (a full pool earns the whole share)',
    min: 1n,
    max: BIGINT_MAX,
  },
  stakingMinStakeMinor: {
    kind: 'bigint',
    group: 'staking',
    label: 'Smallest stake',
    min: 1n,
    max: BIGINT_MAX,
  },
  stakingMaxPerPlayerMinor: {
    kind: 'bigint',
    group: 'staking',
    label: 'Most one player may have staked',
    min: 1n,
    max: BIGINT_MAX,
  },
  stakingUnstakeHours: {
    kind: 'integer',
    group: 'staking',
    label: 'Cool-down before an unstaked amount is paid back (hours)',
    min: 1n,
    max: 720n,
  },

  /* ── weekly quests ──
   *
   * A round freezes its pot and thresholds when it opens on Monday, so a change here applies from
   * the next week; switching them off stops new rounds, and an open one still settles and pays.
   * The race's split and the sweep interval are boot-only. */
  weeklyQuestsEnabled: {
    kind: 'boolean',
    group: 'weeklyQuests',
    label: 'Weekly quests open each Monday and are shown',
  },
  depositRacePotMinor: {
    kind: 'bigint',
    group: 'weeklyQuests',
    label: 'Deposit race: prize pot per week',
    min: 1n,
    max: BIGINT_MAX,
  },
  depositRaceMinDepositMinor: {
    kind: 'bigint',
    group: 'weeklyQuests',
    label: 'Deposit race: least a player must deposit and play to place',
    min: 1n,
    max: BIGINT_MAX,
  },
  recruitQuestPotMinor: {
    kind: 'bigint',
    group: 'weeklyQuests',
    label: 'Recruit quest: prize pot per week, split among everyone who finishes',
    min: 1n,
    max: BIGINT_MAX,
  },
  recruitQuestFriends: {
    kind: 'integer',
    group: 'weeklyQuests',
    label: 'Recruit quest: new friends needed',
    min: 1n,
    max: 50n,
  },
  recruitFriendDepositMinor: {
    kind: 'bigint',
    group: 'weeklyQuests',
    label: 'Recruit quest: what each friend must deposit',
    min: 1n,
    max: BIGINT_MAX,
  },
  recruitFriendWagerMinor: {
    kind: 'bigint',
    group: 'weeklyQuests',
    label: 'Recruit quest: what each friend must wager',
    min: 1n,
    max: BIGINT_MAX,
  },
  weeklyQuestGraceHours: {
    kind: 'integer',
    group: 'weeklyQuests',
    label: 'Hours after the week before a round settles',
    min: 0n,
    max: 168n,
  },


  /* ── media test mode ──
   *
   * Read on every request. Turning it off puts every test-mode session straight back on its real
   * account; the play money stays on the test accounts, untouched, for when it is turned on. */
  mediaTestModeEnabled: {
    kind: 'boolean',
    group: 'features',
    label: 'Media test mode (creators play with play money for clips)',
  },
  mediaTestBalanceMinor: {
    kind: 'bigint',
    group: 'economy',
    label: 'Play money a media test account is filled up to',
    min: 1n,
    max: BIGINT_MAX,
  },

  /* ── Discord ── */
  discordMaxAccounts: {
    kind: 'integer',
    group: 'limits',
    label: 'Site accounts one Discord may be linked to (alts; rewards stay once per Discord)',
    min: 1n,
    max: 25n,
  },

  /* ── invite codes entered after sign-up ── */
  referralLateEntryDays: {
    kind: 'integer',
    group: 'limits',
    label: 'Oldest account (days) that may use its one invite-code entry in Settings (0 = none)',
    min: 0n,
    max: 3650n,
  },

  /* ── payouts and the anti-drain rules ──
   *
   * Every one is read when a withdrawal is requested or when the monitor runs, never captured at
   * boot. Holding a payout never takes money from a player: the wallet was debited when they
   * asked, and a hold only decides whether the bot is told to send it yet. */
  cashPayoutsHold: {
    kind: 'boolean',
    group: 'payouts',
    label: 'HOLD ALL PAYOUTS: every withdrawal waits for a human',
  },
  cashApprovalThresholdMinor: {
    kind: 'bigint',
    group: 'payouts',
    label: 'A single withdrawal above this waits for a human (0 = every one)',
    min: 0n,
    max: BIGINT_MAX,
  },
  antiDrainEnabled: {
    kind: 'boolean',
    group: 'payouts',
    label: 'Anti-drain rules and monitor on',
  },
  antiDrainNetCashoutMinor: {
    kind: 'bigint',
    group: 'payouts',
    label: 'Net cash-out per player before review (withdrawn less deposited, 0 = off)',
    min: 0n,
    max: BIGINT_MAX,
  },
  antiDrainHouseHourlyMinor: {
    kind: 'bigint',
    group: 'payouts',
    label: 'House net outflow per hour before every payout waits (0 = off)',
    min: 0n,
    max: BIGINT_MAX,
  },
  antiDrainWin1hMinor: {
    kind: 'bigint',
    group: 'payouts',
    label: 'Player net winnings in 1 hour that earns a payout hold (0 = off)',
    min: 0n,
    max: BIGINT_MAX,
  },
  antiDrainWin24hMinor: {
    kind: 'bigint',
    group: 'payouts',
    label: 'Player net winnings in 24 hours that earns a payout hold (0 = off)',
    min: 0n,
    max: BIGINT_MAX,
  },

  /* ── the vault jackpot ── */
  vaultJackpotContributionBps: {
    kind: 'integer',
    group: 'jackpot',
    label: 'Jackpot contribution (bps of wager)',
    min: 0n,
    max: 100n,
  },
  vaultJackpotOddsDivisorMinor: {
    kind: 'bigint',
    group: 'jackpot',
    label: 'Jackpot odds divisor',
    min: 1n,
    max: 1_000_000_000_000_000n,
  },
  vaultJackpotSeedMinor: {
    kind: 'bigint',
    group: 'jackpot',
    label: 'Jackpot reseed after a win',
    min: 0n,
    max: 9_999_999_999_999_999n,
  },

  /* ── lava rain ── */
  lavaRainMaxPoolMinor: {
    kind: 'bigint',
    group: 'rain',
    label: 'Lava Rain maximum pool',
    min: 1n,
    max: BIGINT_MAX,
  },
  lavaRainMinWageredMinor: {
    kind: 'bigint',
    group: 'rain',
    label: 'Lava Rain wagering bar',
    min: 0n,
    max: BIGINT_MAX,
  },
  lavaRainWindowMinutes: {
    kind: 'integer',
    group: 'rain',
    label: 'Lava Rain announcement window (minutes)',
    min: 1n,
    max: 1440n,
  },
  lavaRainClaimMinutes: {
    kind: 'integer',
    group: 'rain',
    label: 'Lava Rain claim window (minutes)',
    min: 1n,
    max: 60n,
  },
  lavaRainAutoEveryMinutes: {
    kind: 'integer',
    group: 'rain',
    label: 'Lava Rain automatic drop every N minutes (0 = only by hand)',
    min: 0n,
    max: 10080n,
  },
  lavaRainAutoPoolMinor: {
    kind: 'bigint',
    group: 'rain',
    label: 'Lava Rain automatic drop pool',
    min: 1n,
    max: BIGINT_MAX,
  },

  /* ── money moving sideways ── */
  tipMinMinor: { kind: 'bigint', group: 'social', label: 'Minimum tip', min: 1n, max: BIGINT_MAX },
  tipMaxMinor: { kind: 'bigint', group: 'social', label: 'Maximum tip', min: 1n, max: BIGINT_MAX },
  sideBetRakeBps: {
    kind: 'integer',
    group: 'social',
    label: 'Side bet rake (bps of pool)',
    min: 0n,
    max: 1_000n,
  },
  sideBetMinStakeMinor: {
    kind: 'bigint',
    group: 'social',
    label: 'Side bet minimum stake',
    min: 1n,
    max: BIGINT_MAX,
  },
  sideBetMaxStakeMinor: {
    kind: 'bigint',
    group: 'social',
    label: 'Side bet maximum stake',
    min: 1n,
    max: BIGINT_MAX,
  },
  discordFlexMinMinor: {
    kind: 'bigint',
    group: 'social',
    label: 'Discord flex threshold',
    min: 1n,
    max: BIGINT_MAX,
  },

  /* ── the teller's float ──
   *
   * How much the public-facing bot is allowed to hold. Everything above it is swept to the vault,
   * so this is the ceiling on what is sitting on the account whose name every player knows.
   * Raising it means fewer in-game transfers and faster withdrawals; lowering it means less
   * exposed. Zero sweeps everything. */
  tellerFloatTargetMinor: {
    kind: 'bigint',
    group: 'bots',
    label: 'Teller float (swept down to this)',
    min: 0n,
    max: BIGINT_MAX,
  },
  /* The teller is emptied once it is holding this much, not continuously. Below it nothing
   * moves, which keeps one in-game transfer from riding behind every single deposit. */
  tellerSweepThresholdMinor: {
    kind: 'bigint',
    group: 'bots',
    label: 'Sweep the teller once it holds this much',
    min: 0n,
    max: BIGINT_MAX,
  },
  /* The pause between the vault paying the teller and the teller paying the player, so the two
   * legs are not adjacent in the server's public chat log. */
  withdrawalHopDelaySeconds: {
    kind: 'integer',
    group: 'bots',
    label: 'Delay between withdrawal hops (seconds)',
    min: 0n,
    max: 300n,
  },

  /* ── the single largest thing one roll may risk ── */
  upgradeMaxStakeMinor: {
    kind: 'bigint',
    group: 'limits',
    label: 'Upgrader maximum stake',
    min: 1n,
    max: BIGINT_MAX,
  },
} as const satisfies Record<string, Definition>;

export type RuntimeSettingKey = keyof typeof runtimeSettingDefinitions;
export type RuntimeSettingInput = Partial<Record<RuntimeSettingKey, boolean | number | string>>;
export const runtimeSettingKeys = Object.freeze(
  Object.keys(runtimeSettingDefinitions) as RuntimeSettingKey[],
);

type SettingValue = boolean | number | bigint;

/**
 * The four rakeback rates live under one frozen `rakebackTierBps` object on AppConfig, and a Proxy
 * only intercepts top-level property access. Each rate is therefore its own allow-list key, and
 * the Proxy recomposes the object from whichever of the four are overridden.
 */
const rakebackTierKeys = Object.freeze({
  rakebackInstantBps: 'instant',
} as const);

type RakebackTierKey = keyof typeof rakebackTierKeys;

function isRakebackTierKey(key: RuntimeSettingKey): key is RakebackTierKey {
  return Object.hasOwn(rakebackTierKeys, key);
}

interface RuntimeSettingRow {
  key: string;
  value: unknown;
  updated_by?: string;
  updated_at?: Date;
}

function isRuntimeKey(value: string): value is RuntimeSettingKey {
  return Object.hasOwn(runtimeSettingDefinitions, value);
}

function parseValue(key: RuntimeSettingKey, raw: unknown): SettingValue {
  const definition = runtimeSettingDefinitions[key];
  if (definition.kind === 'boolean') {
    if (typeof raw !== 'boolean') throw new Error(`${key} must be a boolean`);
    return raw;
  }

  let value: bigint;
  try {
    if (typeof raw === 'number' && Number.isSafeInteger(raw)) value = BigInt(raw);
    else if (typeof raw === 'string' && /^(0|[1-9]\d*)$/.test(raw)) value = BigInt(raw);
    else throw new Error();
  } catch {
    throw new Error(`${key} must be a non-negative integer`);
  }
  if (definition.min !== undefined && value < definition.min) {
    throw new Error(`${key} must be at least ${definition.min.toString()}`);
  }
  if (definition.max !== undefined && value > definition.max) {
    throw new Error(`${key} must be at most ${definition.max.toString()}`);
  }
  if (definition.kind === 'integer') {
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw new Error(`${key} exceeds the safe integer range`);
    return number;
  }
  return value;
}

function jsonValue(value: SettingValue): boolean | number | string {
  return typeof value === 'bigint' ? value.toString() : value;
}

/**
 * Every invariant that spans more than one setting, checked against a complete prospective config.
 *
 * Run BEFORE anything is written, never after. The route persists inside a transaction and then
 * updates this object in memory; an invariant that threw from `apply` would leave a committed row
 * the running process had just rejected, and the next restart would read it back and refuse to
 * boot. A guard that takes the site down is a failure mode this codebase has already paid for.
 */
function assertInvariants(view: AppConfig): void {
  if (view.rouletteMinStakeMinor > view.rouletteMaxStakeMinor) {
    throw new AppError(400, 'ROULETTE_LIMITS_INVALID', 'Roulette minimum cannot exceed maximum');
  }
  const ordered: ReadonlyArray<readonly [string, bigint, string, bigint]> = [
    [
      'Roulette maximum chip',
      view.rouletteMaxStakeMinor,
      'the table limit',
      view.rouletteMaxRoundStakeMinor,
    ],
    ['Duel minimum stake', view.skillDuelMinStakeMinor, 'the maximum', view.skillDuelMaxStakeMinor],
    ['Coinflip minimum stake', view.coinflipMinStakeMinor, 'the maximum', view.coinflipMaxStakeMinor],
    ['Mines Duel minimum stake', view.minesDuelMinStakeMinor, 'the maximum', view.minesDuelMaxStakeMinor],
    ['Side bet minimum stake', view.sideBetMinStakeMinor, 'the maximum', view.sideBetMaxStakeMinor],
    ['Minimum tip', view.tipMinMinor, 'the maximum', view.tipMaxMinor],
    ['Blackjack minimum stake', view.blackjackMinStakeMinor, 'the maximum', view.blackjackMaxStakeMinor],
    ['Crash minimum bet', view.crashMinStakeMinor, 'the maximum', view.crashMaxStakeMinor],
    ['Mines minimum stake', view.minesMinStakeMinor, 'the maximum', view.minesMaxStakeMinor],
    ['Mines maximum stake', view.minesMaxStakeMinor, 'the maximum payout', view.minesMaxPayoutMinor],
    ['Tower minimum stake', view.towerMinStakeMinor, 'the maximum', view.towerMaxStakeMinor],
    ['Tower maximum stake', view.towerMaxStakeMinor, 'the maximum payout', view.towerMaxPayoutMinor],
    ['Chicken minimum stake', view.chickenMinStakeMinor, 'the maximum', view.chickenMaxStakeMinor],
    ['Chicken maximum stake', view.chickenMaxStakeMinor, 'the maximum payout', view.chickenMaxPayoutMinor],
    ['Plinko minimum stake', view.plinkoMinStakeMinor, 'the maximum', view.plinkoMaxStakeMinor],
    ['Plinko maximum stake', view.plinkoMaxStakeMinor, 'the maximum payout', view.plinkoMaxPayoutMinor],
    ['Slots minimum stake', view.slotsMinStakeMinor, 'the maximum', view.slotsMaxStakeMinor],
    ['Slots maximum stake', view.slotsMaxStakeMinor, 'the maximum payout', view.slotsMaxPayoutMinor],
    ['Dice minimum stake', view.diceMinStakeMinor, 'the maximum', view.diceMaxStakeMinor],
    ['Dice maximum stake', view.diceMaxStakeMinor, 'the maximum payout', view.diceMaxPayoutMinor],
    ['Fishing minimum stake', view.fishingMinStakeMinor, 'the maximum', view.fishingMaxStakeMinor],
    ['Fishing maximum stake', view.fishingMaxStakeMinor, 'the maximum payout', view.fishingMaxPayoutMinor],
    ['Ice Fishing minimum stake', view.iceFishingMinStakeMinor, 'the maximum', view.iceFishingMaxStakeMinor],
    ['Ice Fishing maximum stake', view.iceFishingMaxStakeMinor, 'the maximum payout', view.iceFishingMaxPayoutMinor],
    ['Mob Derby minimum stake', view.derbyMinStakeMinor, 'the maximum', view.derbyMaxStakeMinor],
    ['Mob Derby maximum stake', view.derbyMaxStakeMinor, 'the maximum payout', view.derbyMaxPayoutMinor],
    ['Lava Rain automatic pool', view.lavaRainAutoPoolMinor, 'the maximum pool', view.lavaRainMaxPoolMinor],
    /* The same floor config.ts holds a deployment to at boot. Without it here, the panel could save
     * what the environment would refuse: an invite paying more than the wager that unlocks it. */
    [
      'Referral invite reward',
      view.referralBonusMinor,
      'the wager that unlocks it',
      view.referralBonusWagerMinor,
    ],
  ];
  for (const [lowLabel, low, highLabel, high] of ordered) {
    if (low > high) {
      throw new AppError(400, 'SETTING_RANGE_INVALID', `${lowLabel} cannot exceed ${highLabel}`);
    }
  }
  if (view.minMultiplierBps >= view.maxMultiplierBps) {
    throw new AppError(
      400,
      'SETTING_RANGE_INVALID',
      'Upgrader minimum multiplier must stay below the maximum',
    );
  }
  // The same floor config.ts holds a deployment to: the largest bet must be able to win 1.01x.
  if (view.crashMaxPayoutMinor * 100n < view.crashMaxStakeMinor * 101n) {
    throw new AppError(
      400,
      'SETTING_RANGE_INVALID',
      'Crash maximum payout must be at least 1.01x the maximum bet',
    );
  }
  /* The one invariant that is about money rather than ordering. The VIP ladder, the four tier
   * rakebacks, the referral share and the jackpot are all drawn from the same margin, each is
   * individually sane, and only the sum can be insolvent — so it has to be re-checked on every
   * change to any of them, including a change to the edge they are all a share of.
   *
   * It runs here rather than only at boot because boot is far too late: `assertVipSolvency` is a
   * process-refuses-to-start check, and an admin who saved an insolvent combination at 3pm would
   * not find out until the next deploy failed to come back up. */
  try {
    assertVipSolvency(view);
  } catch (error) {
    throw new AppError(400, 'SETTINGS_NOT_SOLVENT', (error as Error).message);
  }
}

export class RuntimeSettings {
  readonly config: AppConfig;
  readonly #base: AppConfig;
  readonly #overrides = new Map<RuntimeSettingKey, SettingValue>();
  readonly #metadata = new Map<
    RuntimeSettingKey,
    { updated_by: string | undefined; updated_at: Date | undefined }
  >();

  constructor(base: AppConfig) {
    this.#base = base;
    // loadConfig freezes its result (correctly). A Proxy is not allowed to report a different
    // value for a frozen, non-configurable property, so use a shallow target while retaining the
    // frozen object separately as the deployment fallback.
    const target = { ...base } as AppConfig;
    this.config = new Proxy(target, {
      get: (target, property, receiver) => {
        if (property === 'rakebackTierBps') return this.#rakebackTiers();
        if (
          typeof property === 'string' &&
          isRuntimeKey(property) &&
          this.#overrides.has(property)
        ) {
          return this.#overrides.get(property);
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
  }

  async load(client: DbClient): Promise<void> {
    const result = await client.query<RuntimeSettingRow>(
      'SELECT key, value, updated_by, updated_at FROM runtime_settings ORDER BY key',
    );
    for (const row of result.rows) {
      if (!isRuntimeKey(row.key)) continue;
      try {
        this.#overrides.set(row.key, parseValue(row.key, row.value));
        this.#metadata.set(row.key, { updated_by: row.updated_by, updated_at: row.updated_at });
      } catch (error) {
        /* The cause is kept. A persisted setting that will not parse is a startup failure, and the
           parser's own message is the only thing that says which value was wrong. */
        throw new Error(
          `Invalid persisted runtime setting ${row.key}: ${(error as Error).message}`,
          { cause: error },
        );
      }
    }
    try {
      assertInvariants(this.config);
    } catch (error) {
      /* Only reachable if the table was written outside this class, because every write path
       * validates the whole prospective config first. Name the undo in the message, because
       * whoever meets it is holding an API that will not start. */
      throw new Error(
        `Persisted runtime settings are not valid together: ${(error as Error).message}. ` +
          'Undo with: DELETE FROM runtime_settings WHERE key = ANY(ARRAY[...]);',
        { cause: error },
      );
    }
  }

  /** Parses a requested change and proves the result coheres before anything is written. */
  validate(input: RuntimeSettingInput): Map<RuntimeSettingKey, SettingValue> {
    const parsed = new Map<RuntimeSettingKey, SettingValue>();
    for (const [rawKey, rawValue] of Object.entries(input)) {
      if (!isRuntimeKey(rawKey)) {
        throw new AppError(400, 'SETTING_NOT_ALLOWED', 'Setting is not runtime-manageable');
      }
      parsed.set(rawKey, parseValue(rawKey, rawValue));
    }
    if (parsed.size === 0) throw new AppError(400, 'SETTINGS_EMPTY', 'Choose at least one setting');
    assertInvariants(this.#project(parsed, []));
    return parsed;
  }

  /**
   * The same proof for the other direction. Dropping an override restores a deployment default,
   * and a default is only known to be coherent alongside the OTHER defaults — put one back while
   * its counterpart is still overridden and the pair can cross.
   */
  validateReset(keys: readonly RuntimeSettingKey[]): RuntimeSettingKey[] {
    const unique = [...new Set(keys)];
    for (const key of unique) {
      if (!isRuntimeKey(key)) {
        throw new AppError(400, 'SETTING_NOT_ALLOWED', 'Setting is not runtime-manageable');
      }
    }
    assertInvariants(this.#project(new Map(), unique));
    return unique;
  }

  apply(values: Map<RuntimeSettingKey, SettingValue>, actorId?: string): void {
    const now = new Date();
    for (const [key, value] of values) {
      this.#overrides.set(key, value);
      this.#metadata.set(key, { updated_by: actorId, updated_at: now });
    }
  }

  reset(keys: readonly RuntimeSettingKey[]): void {
    for (const key of keys) {
      this.#overrides.delete(key);
      this.#metadata.delete(key);
    }
  }

  /** What these keys hold right now, shaped for the `before` side of an audit entry. */
  snapshot(keys: Iterable<RuntimeSettingKey>): Record<string, boolean | number | string> {
    const previous: Record<string, boolean | number | string> = {};
    for (const key of keys) {
      previous[key] = jsonValue(this.#overrides.get(key) ?? this.#defaultValue(key));
    }
    return previous;
  }

  rows() {
    return (Object.keys(runtimeSettingDefinitions) as RuntimeSettingKey[]).map((key) => {
      const definition: Definition = runtimeSettingDefinitions[key];
      const fallback = this.#defaultValue(key);
      const effective = this.#overrides.get(key) ?? fallback;
      const metadata = this.#metadata.get(key);
      return {
        key,
        label: definition.label,
        group: definition.group,
        kind: definition.kind,
        value: jsonValue(effective),
        defaultValue: jsonValue(fallback),
        overridden: this.#overrides.has(key),
        min: definition.min?.toString() ?? null,
        max: definition.max?.toString() ?? null,
        updatedBy: metadata?.updated_by ?? null,
        updatedAt: metadata?.updated_at?.toISOString() ?? null,
      };
    });
  }

  static databaseValue(value: SettingValue): boolean | number | string {
    return jsonValue(value);
  }

  get roulettePaused(): boolean {
    return (this.#overrides.get('roulettePaused') ?? false) as boolean;
  }

  /** A complete config as it WOULD be: current overrides, plus `changes`, minus `removals`. */
  #project(
    changes: Map<RuntimeSettingKey, SettingValue>,
    removals: readonly RuntimeSettingKey[],
  ): AppConfig {
    const dropped = new Set(removals);
    const view = { ...this.#base } as Record<string, unknown>;
    const tiers = { ...this.#base.rakebackTierBps };
    const settle = (key: RuntimeSettingKey, value: SettingValue) => {
      if (isRakebackTierKey(key)) tiers[rakebackTierKeys[key]] = Number(value);
      else view[key] = value;
    };
    for (const [key, value] of this.#overrides) {
      if (dropped.has(key) || changes.has(key)) continue;
      settle(key, value);
    }
    for (const [key, value] of changes) settle(key, value);
    view['rakebackTierBps'] = Object.freeze(tiers);
    return view as AppConfig;
  }

  #rakebackTiers(): AppConfig['rakebackTierBps'] {
    const base = this.#base.rakebackTierBps;
    let overridden = false;
    const composed = { ...base };
    for (const key of Object.keys(rakebackTierKeys) as RakebackTierKey[]) {
      const value = this.#overrides.get(key);
      if (value === undefined) continue;
      composed[rakebackTierKeys[key]] = Number(value);
      overridden = true;
    }
    return overridden ? Object.freeze(composed) : base;
  }

  #defaultValue(key: RuntimeSettingKey): SettingValue {
    if (key === 'roulettePaused') return false;
    if (isRakebackTierKey(key)) return this.#base.rakebackTierBps[rakebackTierKeys[key]];
    return (this.#base as unknown as Record<string, SettingValue>)[key]!;
  }
}
