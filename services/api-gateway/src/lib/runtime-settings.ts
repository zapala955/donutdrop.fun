import type { AppConfig } from '../config.js';
import type { DbClient } from './db.js';
import { AppError } from './errors.js';

type SettingKind = 'boolean' | 'integer' | 'bigint';

interface Definition {
  readonly kind: SettingKind;
  readonly group: 'features' | 'chat' | 'rewards' | 'roulette' | 'limits';
  readonly label: string;
  readonly min?: bigint;
  readonly max?: bigint;
}

/**
 * The complete allow-list of values that may be changed without a deployment.
 *
 * Deliberately absent: secrets, origins, custody switches, the house edge, payout curves, bot
 * credentials and cryptographic material. Those values define the trust boundary or game maths
 * and remain controlled deployment inputs. Every key below is a reversible operational control.
 */
export const runtimeSettingDefinitions = {
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
    max: 9_223_372_036_854_775_807n,
  },
  streakBaseRewardMinor: {
    kind: 'bigint',
    group: 'rewards',
    label: 'Daily reward base amount',
    min: 0n,
    max: 9_223_372_036_854_775_807n,
  },
  streakDailyWagerRequiredMinor: {
    kind: 'bigint',
    group: 'rewards',
    label: 'Daily reward wager requirement',
    min: 0n,
    max: 9_223_372_036_854_775_807n,
  },
  referralBonusMinor: {
    kind: 'bigint',
    group: 'rewards',
    label: 'Referral invite reward',
    min: 0n,
    max: 9_223_372_036_854_775_807n,
  },
  referralBonusWagerMinor: {
    kind: 'bigint',
    group: 'rewards',
    label: 'Referral wager to unlock',
    min: 0n,
    max: 9_223_372_036_854_775_807n,
  },
  upgradeMaxStakeMinor: {
    kind: 'bigint',
    group: 'limits',
    label: 'Upgrader maximum stake',
    min: 1n,
    max: 9_223_372_036_854_775_807n,
  },
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
    max: 9_223_372_036_854_775_807n,
  },
  rouletteMaxStakeMinor: {
    kind: 'bigint',
    group: 'roulette',
    label: 'Roulette maximum chip',
    min: 1n,
    max: 9_223_372_036_854_775_807n,
  },
  roulettePaused: {
    kind: 'boolean',
    group: 'roulette',
    label: 'Pause after current round',
  },
} as const satisfies Record<string, Definition>;

export type RuntimeSettingKey = keyof typeof runtimeSettingDefinitions;
export type RuntimeSettingInput = Partial<Record<RuntimeSettingKey, boolean | number | string>>;
export const runtimeSettingKeys = Object.freeze(
  Object.keys(runtimeSettingDefinitions) as RuntimeSettingKey[],
);

interface RuntimeSettingRow {
  key: string;
  value: unknown;
  updated_by?: string;
  updated_at?: Date;
}

function isRuntimeKey(value: string): value is RuntimeSettingKey {
  return Object.hasOwn(runtimeSettingDefinitions, value);
}

function parseValue(key: RuntimeSettingKey, raw: unknown): boolean | number | bigint {
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

function jsonValue(value: boolean | number | bigint): boolean | number | string {
  return typeof value === 'bigint' ? value.toString() : value;
}

export class RuntimeSettings {
  readonly config: AppConfig;
  readonly #base: AppConfig;
  readonly #overrides = new Map<RuntimeSettingKey, boolean | number | bigint>();
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
        if (typeof property === 'string' && isRuntimeKey(property) && this.#overrides.has(property)) {
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
        throw new Error(`Invalid persisted runtime setting ${row.key}: ${(error as Error).message}`, {
          cause: error,
        });
      }
    }
    this.#validateRelationships();
  }

  validate(input: RuntimeSettingInput): Map<RuntimeSettingKey, boolean | number | bigint> {
    const parsed = new Map<RuntimeSettingKey, boolean | number | bigint>();
    for (const [rawKey, rawValue] of Object.entries(input)) {
      if (!isRuntimeKey(rawKey)) throw new AppError(400, 'SETTING_NOT_ALLOWED', 'Setting is not runtime-manageable');
      parsed.set(rawKey, parseValue(rawKey, rawValue));
    }
    if (parsed.size === 0) throw new AppError(400, 'SETTINGS_EMPTY', 'Choose at least one setting');

    const minimum = (parsed.get('rouletteMinStakeMinor') ?? this.config.rouletteMinStakeMinor) as bigint;
    const maximum = (parsed.get('rouletteMaxStakeMinor') ?? this.config.rouletteMaxStakeMinor) as bigint;
    if (minimum > maximum) {
      throw new AppError(400, 'ROULETTE_LIMITS_INVALID', 'Roulette minimum cannot exceed maximum');
    }
    return parsed;
  }

  apply(values: Map<RuntimeSettingKey, boolean | number | bigint>, actorId?: string): void {
    const now = new Date();
    for (const [key, value] of values) {
      this.#overrides.set(key, value);
      this.#metadata.set(key, { updated_by: actorId, updated_at: now });
    }
    this.#validateRelationships();
  }

  reset(keys: RuntimeSettingKey[]): void {
    for (const key of keys) {
      this.#overrides.delete(key);
      this.#metadata.delete(key);
    }
    this.#validateRelationships();
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

  static databaseValue(value: boolean | number | bigint): boolean | number | string {
    return jsonValue(value);
  }

  get roulettePaused(): boolean {
    return (this.#overrides.get('roulettePaused') ?? false) as boolean;
  }

  #defaultValue(key: RuntimeSettingKey): boolean | number | bigint {
    if (key === 'roulettePaused') return false;
    return (this.#base as unknown as Record<string, boolean | number | bigint>)[key]!;
  }

  #validateRelationships(): void {
    if (this.config.rouletteMinStakeMinor > this.config.rouletteMaxStakeMinor) {
      throw new Error('Persisted roulette minimum stake exceeds maximum stake');
    }
  }
}
