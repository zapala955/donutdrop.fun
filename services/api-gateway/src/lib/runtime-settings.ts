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
  | 'duels'
  | 'jackpot'
  | 'rain'
  | 'social'
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

  /* ── the four rakeback clocks ──
   *
   * Shares of the house MARGIN, not of turnover, and the four are added together by the solvency
   * guard below before any of them is allowed to take effect. */
  rakebackInstantBps: {
    kind: 'integer',
    group: 'rakeback',
    label: 'Instant rakeback (bps of margin)',
    min: 0n,
    max: 10_000n,
  },
  rakebackDailyBps: {
    kind: 'integer',
    group: 'rakeback',
    label: 'Daily rakeback (bps of margin)',
    min: 0n,
    max: 10_000n,
  },
  rakebackWeeklyBps: {
    kind: 'integer',
    group: 'rakeback',
    label: 'Weekly rakeback (bps of margin)',
    min: 0n,
    max: 10_000n,
  },
  rakebackMonthlyBps: {
    kind: 'integer',
    group: 'rakeback',
    label: 'Monthly rakeback (bps of margin)',
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
  rakebackDailyBps: 'daily',
  rakebackWeeklyBps: 'weekly',
  rakebackMonthlyBps: 'monthly',
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
    ['Side bet minimum stake', view.sideBetMinStakeMinor, 'the maximum', view.sideBetMaxStakeMinor],
    ['Minimum tip', view.tipMinMinor, 'the maximum', view.tipMaxMinor],
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
