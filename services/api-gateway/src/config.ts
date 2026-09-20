import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { isIP } from 'node:net';
import { TextDecoder } from 'node:util';
import { z } from 'zod';
import { decodeCanonicalBase32 } from './lib/totp.js';

const FILE_BACKED_SETTINGS = [
  'DATABASE_URL',
  'REDIS_URL',
  'COOKIE_SECRET',
  'DATA_ENCRYPTION_KEY',
  'BOT_CREDENTIALS_JSON',
  'ADMIN_TOTP_SECRETS_JSON',
  'AUDIT_LOG_HMAC_KEY',
  'IP_HASH_KEY',
  'DONUTSMP_API_KEY',
  'DISCORD_CLIENT_SECRET',
  /* A Discord webhook URL is a bearer credential in URL clothing: anyone holding it can post to the
   * channel as the app, forever, with no further authentication. It is file-backed like every other
   * secret here and must never reach a browser. */
  'DISCORD_FLEX_WEBHOOK_URL',
  /* The bot token IS the bot. Anyone holding it can act as the application in every guild it is
   * in, read what it can read and issue what it can issue — and because the control plane treats
   * a Discord operator as an administrator, holding it is one step from holding the platform. */
  'DISCORD_BOT_TOKEN',
  /* Shared HMAC key between the bot process and this gateway. Everything the bot asks for is
   * signed with it, so it is the only thing standing between "a request from the bot" and
   * "a request that claims to be from the bot". */
  'DISCORD_CONTROL_HMAC_KEY',
  /* Maps Discord snowflakes to platform admin identities. Not a secret in the cryptographic
   * sense, but it is the allowlist that decides who can mint an admin session, so it is read the
   * same careful way as one rather than being passed on a command line. */
  'DISCORD_OPERATORS_JSON',
  /* The half of the Turnstile pair that proves a challenge was really solved. The site key beside
   * it is public by design and printed into the page; this one is what stops somebody minting
   * their own "passed" answer, so it is read the same careful way as every other secret here. */
  'TURNSTILE_SECRET_KEY',
] as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;
const MAX_FILE_BACKED_SETTING_BYTES = 256 * 1024;

const booleanString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

function readSecretFile(path: string, setting: string): string {
  let descriptor: number | undefined;
  let value: string;
  try {
    descriptor = openSync(path, 'r');
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size > MAX_FILE_BACKED_SETTING_BYTES) {
      throw new Error('secret file is not a bounded regular file');
    }
    const bytes = Buffer.allocUnsafe(MAX_FILE_BACKED_SETTING_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const bytesRead = readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_FILE_BACKED_SETTING_BYTES) throw new Error('secret file is too large');
    value = new TextDecoder('utf-8', { fatal: true })
      .decode(bytes.subarray(0, offset))
      .replace(/\r?\n$/, '');
  } catch (error) {
    throw new Error(`Unable to read ${setting}_FILE`, { cause: error });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  if (!value || /[\r\n\0]/.test(value)) {
    throw new Error(`${setting}_FILE must contain exactly one non-empty line`);
  }
  return value;
}

function resolveFileBackedSettings(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const resolved = { ...environment };
  for (const setting of FILE_BACKED_SETTINGS) {
    const fileSetting = `${setting}_FILE`;
    const direct = resolved[setting];
    const file = resolved[fileSetting];
    const hasDirect = direct !== undefined;
    const hasFile = file !== undefined;
    if (hasDirect && hasFile) {
      throw new Error(`${setting} and ${fileSetting} are mutually exclusive`);
    }
    if (hasDirect && Buffer.byteLength(direct, 'utf8') > MAX_FILE_BACKED_SETTING_BYTES) {
      throw new Error(`${setting} exceeds the maximum allowed size`);
    }
    if (!hasDirect && hasFile) resolved[setting] = readSecretFile(file, setting);
  }
  return resolved;
}

function decodeCanonicalKey(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) return undefined;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === 32 && decoded.toString('base64') === value ? decoded : undefined;
}

const MINECRAFT_USERNAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/;
const MINECRAFT_HOST_PATTERN =
  /^(?=.{1,253}\.?$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.?$/;

export interface ProvisionedBotCredential {
  readonly secret: Buffer;
  readonly serverHost: string;
  readonly username: string;
}

function parseBotCredentials(value: string): ReadonlyMap<string, ProvisionedBotCredential> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('BOT_CREDENTIALS_JSON must be valid JSON');
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error(
      'BOT_CREDENTIALS_JSON must map bot UUIDs to provisioned identities and secrets',
    );
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length < 1 || entries.length > 64) {
    throw new Error('BOT_CREDENTIALS_JSON must provision between 1 and 64 bots');
  }
  const credentials = new Map<string, ProvisionedBotCredential>();
  for (const [rawBotId, rawCredential] of entries) {
    const botId = rawBotId.toLowerCase();
    if (
      !UUID_PATTERN.test(botId) ||
      !rawCredential ||
      Array.isArray(rawCredential) ||
      typeof rawCredential !== 'object'
    ) {
      throw new Error('BOT_CREDENTIALS_JSON contains an invalid bot UUID or credential');
    }
    const record = rawCredential as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(',') !== 'secret,serverHost,username' ||
      typeof record['secret'] !== 'string' ||
      typeof record['serverHost'] !== 'string' ||
      typeof record['username'] !== 'string'
    ) {
      throw new Error('Every bot credential requires only secret, serverHost, and username');
    }
    const secret = decodeCanonicalKey(record['secret']);
    if (!secret) {
      throw new Error('Every bot secret must be exactly 32 random bytes in canonical base64');
    }
    const serverHost = record['serverHost'].toLowerCase().replace(/\.$/, '');
    if (
      !MINECRAFT_HOST_PATTERN.test(record['serverHost']) ||
      !serverHost ||
      !MINECRAFT_USERNAME_PATTERN.test(record['username'])
    ) {
      throw new Error('Every bot credential requires a valid expected server host and username');
    }
    if (credentials.has(botId))
      throw new Error('BOT_CREDENTIALS_JSON contains a duplicate bot UUID');
    credentials.set(botId, Object.freeze({ secret, serverHost, username: record['username'] }));
  }
  return credentials;
}

function parseAdminTotpSecrets(value: string): ReadonlyMap<string, Buffer> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('ADMIN_TOTP_SECRETS_JSON must be valid JSON');
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('ADMIN_TOTP_SECRETS_JSON must map mc: identities to base32 secrets');
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length > 32) throw new Error('ADMIN_TOTP_SECRETS_JSON contains too many admins');
  const secrets = new Map<string, Buffer>();
  for (const [rawIdentity, rawSecret] of entries) {
    const identity = rawIdentity.toLowerCase();
    const secret = typeof rawSecret === 'string' ? decodeCanonicalBase32(rawSecret) : undefined;
    if (!/^mc:[a-f0-9]{32}$/.test(identity) || !secret || secrets.has(identity)) {
      throw new Error('ADMIN_TOTP_SECRETS_JSON contains an invalid identity or secret');
    }
    secrets.set(identity, secret);
  }
  return secrets;
}

/**
 * Parses the Discord operator allowlist: snowflake -> platform admin identity.
 *
 * This map is the entire authorisation model for the control plane. A Discord account that is not
 * a key here cannot run a command, cannot mint a link and is not told why — and a key whose value
 * is not also in ADMIN_MINECRAFT_IDS is rejected at boot rather than silently granting an identity
 * that the rest of the system does not consider an administrator.
 */
function parseDiscordOperators(value: string): ReadonlyMap<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('DISCORD_OPERATORS_JSON must be valid JSON');
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('DISCORD_OPERATORS_JSON must map Discord user ids to mc: identities');
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length > 32) throw new Error('DISCORD_OPERATORS_JSON contains too many operators');
  const operators = new Map<string, string>();
  for (const [rawSnowflake, rawIdentity] of entries) {
    const snowflake = rawSnowflake.trim();
    const identity = typeof rawIdentity === 'string' ? rawIdentity.trim().toLowerCase() : '';
    if (
      !/^[0-9]{5,32}$/.test(snowflake) ||
      !/^mc:[a-f0-9]{32}$/.test(identity) ||
      operators.has(snowflake)
    ) {
      throw new Error('DISCORD_OPERATORS_JSON contains an invalid Discord id or identity');
    }
    operators.set(snowflake, identity);
  }
  return operators;
}

function isValidCidr(value: string): boolean {
  const [address, prefix, ...rest] = value.split('/');
  if (!address || prefix === undefined || rest.length) return false;
  const family = isIP(address);
  if (!family || !/^\d{1,3}$/.test(prefix)) return false;
  const bits = Number(prefix);
  return Number.isInteger(bits) && bits >= 0 && bits <= (family === 4 ? 32 : 128);
}

function parseTrustedProxyCidrs(value: string): readonly string[] {
  const cidrs = value
    .split(',')
    .map((cidr) => cidr.trim())
    .filter(Boolean);
  if (!cidrs.length || cidrs.length > 16 || cidrs.some((cidr) => !isValidCidr(cidr))) {
    throw new Error('TRUSTED_PROXY_CIDRS must contain 1-16 valid IPv4 or IPv6 CIDRs');
  }
  return Object.freeze(cidrs);
}

function hasOverlyBroadProxyCidr(value: string): boolean {
  return value
    .split(',')
    .map((cidr) => cidr.trim().split('/'))
    .some(([address, prefix]) => {
      const family = address ? isIP(address) : 0;
      const bits = Number(prefix);
      return (family === 4 && bits < 24) || (family === 6 && bits < 64);
    });
}

function looksLikePlaceholder(value: string): boolean {
  return /replace|change[-_ ]?me|example|placeholder/i.test(value) || new Set(value).size < 12;
}

function isExactWebOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function decodedUrlPassword(value: string): string {
  try {
    return decodeURIComponent(new URL(value).password);
  } catch {
    return '';
  }
}

const positiveBigintPattern = /^[1-9]\d{0,18}$/;
/* Zod runs every refinement even after the pattern check has failed, so this callback still sees
 * input like "1.5" or "abc" — and BigInt() throws on those, escaping validation as a 500 rather
 * than the 400 it should be. Re-testing the pattern keeps the conversion on values already known
 * to be convertible. */
const positiveBigintString = z
  .string()
  .regex(positiveBigintPattern)
  .refine(
    (value) => !positiveBigintPattern.test(value) || BigInt(value) <= POSTGRES_BIGINT_MAX,
    'must fit in a PostgreSQL bigint',
  );

function commaSeparatedValuesAre(value: string, pattern: RegExp): boolean {
  if (value === '') return true;
  return value
    .split(',')
    .map((entry) => entry.trim())
    .every((entry) => entry.length > 0 && pattern.test(entry));
}

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.union([z.ipv4(), z.ipv6()]).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
    DATABASE_URL: z
      .string()
      .url()
      .refine((url) => url.startsWith('postgresql://'), {
        message: 'must use postgresql://',
      }),
    DATABASE_SSL: booleanString,
    REDIS_URL: z
      .union([
        z
          .string()
          .url()
          .refine((value) => /^rediss?:\/\//.test(value), {
            message: 'must use redis:// or rediss://',
          }),
        z.literal(''),
      ])
      .default(''),
    APP_ORIGIN: z.string().url().refine(isExactWebOrigin, {
      message: 'must be an exact HTTP(S) origin without credentials, a path, query, or fragment',
    }),
    COOKIE_SECRET: z.string().min(32),
    DATA_ENCRYPTION_KEY: z
      .string()
      .refine(
        (value) => decodeCanonicalKey(value) !== undefined,
        'must be exactly 32 random bytes encoded as canonical base64',
      ),
    BOT_CREDENTIALS_JSON: z.string().min(1),
    ADMIN_TOTP_SECRETS_JSON: z.string().default('{}'),
    AUDIT_LOG_HMAC_KEY: z.string().min(32),
    AUDIT_LOG_KEY_ID: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
      .refine((value) => value !== 'legacy-v1', 'legacy-v1 is reserved for migrated audit rows')
      .default('dev-v1'),
    IP_HASH_KEY: z.string().min(32),
    ADMIN_MINECRAFT_IDS: z
      .string()
      .refine(
        (value) => commaSeparatedValuesAre(value, /^mc:[a-f0-9]{32}$/i),
        'must contain comma-separated mc: identities',
      )
      .default(''),
    SESSION_TTL_HOURS: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 30)
      .default(24),
    HOUSE_EDGE_BPS: z.coerce.number().int().min(0).max(5000).default(1000),
    ITEM_SELL_RATE_BPS: z.coerce.number().int().min(1).max(10_000).default(9000),
    MIN_MULTIPLIER_BPS: z.coerce.number().int().min(10_001).max(1_000_000).default(11_000),
    MAX_MULTIPLIER_BPS: z.coerce.number().int().min(10_002).max(10_000_000).default(1_000_000),
    MAX_WIN_CHANCE_PPM: z.coerce.number().int().min(1).max(1_000_000).default(750_000),
    // Vault yield. Items left alone in the vault earn a daily percentage of their fixed price,
    // paid in cash, capped for the lifetime of the lot. The cap is the only thing standing
    // between a holding incentive and an inflation pump, so it is not optional and the ceiling
    // here is deliberately low: no lot may ever double itself by sitting still.
    VAULT_YIELD_BPS_PER_DAY: z.coerce.number().int().min(0).max(1000).default(100),
    VAULT_YIELD_CAP_BPS: z.coerce.number().int().min(0).max(10_000).default(3000),
    // Developer login. Mints a real session for a disposable test account without the pay-login
    // challenge, so the site can be exercised with no custody bot online. This is an
    // authentication bypass: it is refused outright in production (see the check below), the
    // route is never registered unless it is on, and it still demands a shared token so an
    // exposed dev box is not an open door.
    /* Website-only stock. When on, the house never runs out: an award mints the item rather
     * than consuming a lot the bot is holding, so every catalogue entry is always available.
     *
     * This only makes sense when nothing is physically custodied. With real custody on, minting
     * items the bot does not hold would put the ledger permanently out of step with the bot's
     * real inventory, so the two are mutually exclusive and the process refuses to start with
     * both set. */
    HOUSE_STOCK_UNLIMITED: booleanString,
    /* Cash-only play. Cases and the upgrader still roll a catalog item — that is what carries the
     * rarity, the name and the art the reveal needs — but the prize settles as cash and the
     * player never receives a lot. Conversion is at the item's FULL unit value, never at the sell
     * rate: the upgrader prices its win chance off the target value it quoted, so paying less
     * than that would be a second edge hidden under the published one. */
    CASH_ONLY_PLAY: booleanString,
    /* Chat. Slow mode is the per-user spacing between messages, enforced against the database
     * rather than a disabled button, so a scripted client gains nothing by ignoring the UI. */
    CHAT_ENABLED: booleanString,
    CHAT_SLOW_MODE_SECONDS: z.coerce.number().int().min(0).max(3600).default(5),
    /* What counts as a "big hit" worth announcing in chat. Every payout is in the ticker; only
     * the ones above this reach the conversation, or the chat is just the feed twice. */
    CHAT_BIG_HIT_MINOR: positiveBigintString.default('5000000'),
    /* Faction war. The pool is a real figure that gets paid out of the ledger on settlement, so
     * it is configuration rather than a number typed into a template. */
    FACTION_WAR_PRIZE_POOL_MINOR: positiveBigintString.default('1000000000'),
    FACTION_WAR_DAYS: z.coerce.number().int().min(1).max(60).default(7),
    STREAK_BASE_REWARD_MINOR: positiveBigintString.default('25000'),
    STREAK_MAX_MULTIPLIER: z.coerce.number().int().min(1).max(50).default(7),
    /* Referrals. Two engines on one relationship, and both of them pay out of the house margin.
     *
     * The revenue share is a cut of the margin a referee's wagers earn the house, never a cut of
     * what they lose, so a referrer is never paid more when the person they invited does worse.
     * It is capped at the full margin: a share above 100% would mean the house paying a referrer
     * more than the wager earned it, which is a loss-making faucet rather than a promotion.
     *
     * The milestone bonus is a single fixed payment, unlocked only once the referee has proved a
     * Discord account AND wagered past the threshold. The wager gate is what makes the bonus
     * affordable: at the default house edge the threshold earns back several times the bonus
     * before it is owed, so the programme cannot be farmed by registering accounts. Changing
     * either figure without re-checking that relationship is how a referral programme becomes an
     * unbounded liability, so both are configuration rather than constants. */
    /* Rakeback. Four tiers, four clocks, and every rate is a share of the HOUSE MARGIN rather
     * than of turnover — see the header of migration 017 for why that distinction is the whole
     * ballgame. The four together are capped below at 100% of the margin, because a combined rate
     * above it means the house pays out more on a wager than the wager earned it. */
    /* VIP levels. Thirty sub-levels across six tiers, and the only thing a level grants is a
     * rakeback rate — see lib/vip.ts for the ladder and for why that rate is a share of the WAGER
     * where the four tier rakebacks below are shares of the MARGIN. The ceiling is fixed in the
     * ladder rather than configured, because it is the number the whole scale was solved against;
     * what is configurable is whether the programme runs at all. */
    VIP_ENABLED: booleanString,
    RAKEBACK_ENABLED: booleanString,
    RAKEBACK_INSTANT_BPS: z.coerce.number().int().min(0).max(10_000).default(1_000),
    RAKEBACK_DAILY_BPS: z.coerce.number().int().min(0).max(10_000).default(500),
    RAKEBACK_WEEKLY_BPS: z.coerce.number().int().min(0).max(10_000).default(300),
    RAKEBACK_MONTHLY_BPS: z.coerce.number().int().min(0).max(10_000).default(200),
    /* 1v1 skill duels. The only mode on the platform with NO house edge on the outcome: the
     * house does not hold a side, so it takes 0% of the result and is paid a rake on the pot of
     * a duel it actually decided. That rake is the whole revenue of the mode, which is why it is
     * bounded so tightly here — an operator who could set it to 40% would have turned a skill
     * contest into a worse crate.
     *
     * The ceiling is 1000 bps and the default is 300 (3%). Both are also enforced by the database
     * on duel_lobbies.rake_bps, because the fee is snapshot onto the row at creation and a value
     * that got past config would otherwise be permanent on that duel. */
    SKILL_DUEL_ENABLED: booleanString,
    SKILL_DUEL_RAKE_BPS: z.coerce.number().int().min(0).max(1_000).default(300),
    /* The most a single upgrade may risk.
     *
     * Previously there was no ceiling at all: a stake was clamped to the player's balance and
     * nothing else, so the largest possible bet was however much the largest account happened to
     * be holding. The house carries the other side of an upgrade, and an unbounded stake is an
     * unbounded liability on one roll. */
    UPGRADE_MAX_STAKE_MINOR: positiveBigintString.default('1000000000'),
    SKILL_DUEL_MIN_STAKE_MINOR: positiveBigintString.default('100000'),
    SKILL_DUEL_MAX_STAKE_MINOR: positiveBigintString.default('10000000000'),
    /* A lobby nobody joins holds its host's money. This is how long before the sweeper refunds it
     * and takes it off the board. */
    SKILL_DUEL_LOBBY_TTL_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
    /* ── the vault jackpot ──
     * A share of platform volume set aside into one pot, drawn for on every wager and paid whole to
     * one player. The contribution is a share of the WAGER (the brief's "0.1% of all platform
     * volume"), which against the thinnest configured edge is a fifth of that round's margin — so it
     * is counted by assertVipSolvency alongside the VIP ladder and the tier rakebacks.
     *
     * VAULT_JACKPOT_ODDS_DIVISOR_MINOR sets the odds: the chance a wager wins is
     * `wager / divisor`, capped at even money. At the default a $1M stake is 1 in 50,000 and a $50M
     * stake is 1 in 1,000. Bounded to 1e15 so the draw stays inside an exact integer range. */
    VAULT_JACKPOT_ENABLED: booleanString,
    VAULT_JACKPOT_CONTRIBUTION_BPS: z.coerce.number().int().min(0).max(100).default(10),
    VAULT_JACKPOT_ODDS_DIVISOR_MINOR: positiveBigintString
      .refine((value) => BigInt(value) <= 1_000_000_000_000_000n, 'must be at most 1e15')
      .default('50000000000'),
    /* What the pot resets to after a win, so the bar is never sitting at zero looking broken. Paid
     * by the house out of pocket, once per win, which is why it is bounded tightly. */
    VAULT_JACKPOT_SEED_MINOR: z
      .string()
      .regex(/^(0|[1-9][0-9]{0,15})$/)
      .default('0'),
    /* ── lava rain ──
     * A pot announced in advance and split evenly between everyone who claims inside the window and
     * clears the wagering bar. Operator-funded and discretionary rather than a per-wager rate, which
     * is why it is absent from the solvency guard: there is no automatic accrual to be solvent
     * about. The cap is what stops a fat-fingered admin drop. */
    LAVA_RAIN_ENABLED: booleanString,
    LAVA_RAIN_MAX_POOL_MINOR: positiveBigintString.default('250000000'),
    LAVA_RAIN_MIN_WAGERED_MINOR: z
      .string()
      .regex(/^(0|[1-9][0-9]{0,18})$/)
      .default('10000000'),
    LAVA_RAIN_WINDOW_MINUTES: z.coerce.number().int().min(1).max(1440).default(60),
    LAVA_RAIN_CLAIM_MINUTES: z.coerce.number().int().min(1).max(60).default(5),
    /* ── tips ──
     * Player money moving sideways, with no house cut. Bounded at both ends: a floor so the table
     * is not a spam log, and a ceiling because an unbounded transfer between accounts is the
     * cleanest laundering channel a platform can offer. */
    TIPS_ENABLED: booleanString,
    TIP_MIN_MINOR: positiveBigintString.default('100000'),
    TIP_MAX_MINOR: positiveBigintString.default('100000000'),
    /* ── spectator side bets ──
     * A market on somebody else's match. The house holds both sides and settles from a match it is
     * already refereeing, so it is paid a rake — off the POOL at settlement, never off the stake at
     * entry, so a voided market refunds at face value. */
    SIDE_BETS_ENABLED: booleanString,
    SIDE_BET_RAKE_BPS: z.coerce.number().int().min(0).max(1_000).default(300),
    SIDE_BET_MIN_STAKE_MINOR: positiveBigintString.default('1000000'),
    SIDE_BET_MAX_STAKE_MINOR: positiveBigintString.default('50000000'),
    /* ── the Discord flex feed ──
     * Outbound only, server side only. DISCORD_FLEX_MIN_MINOR is the bar a win has to clear to be
     * worth announcing; below it the channel becomes a firehose nobody reads. */
    DISCORD_FLEX_ENABLED: booleanString,
    DISCORD_FLEX_WEBHOOK_URL: z
      .union([z.string().url().startsWith('https://discord.com/api/webhooks/'), z.literal('')])
      .default(''),
    DISCORD_FLEX_MIN_MINOR: positiveBigintString.default('100000000'),
    /* The public origin a Discord embed links back to. Defaults to APP_ORIGIN. */
    DISCORD_FLEX_LINK_BASE: z.union([z.string().url(), z.literal('')]).default(''),
    /* Wagering races. The pool is real money paid out of the ledger on settlement, so it is
     * configuration rather than a number typed into a template. */
    RACES_ENABLED: booleanString,
    RACE_LEADERBOARD_SIZE: z.coerce.number().int().min(3).max(200).default(50),
    /* The creator programme's boosted revenue share, granted per approved application. Capped at
     * the full margin for the same reason every other share here is. */
    CREATOR_PROGRAMME_ENABLED: booleanString,
    CREATOR_MAX_REVSHARE_BPS: z.coerce.number().int().min(0).max(10_000).default(2_000),
    REFERRALS_ENABLED: booleanString,
    REFERRAL_REVSHARE_BPS: z.coerce.number().int().min(0).max(10_000).default(500),
    REFERRAL_BONUS_MINOR: positiveBigintString.default('10000000'),
    REFERRAL_BONUS_WAGER_MINOR: positiveBigintString.default('100000000'),
    /* Discord OAuth. The client secret is file-backed like every other credential, and the
     * redirect URI is pinned here rather than taken from the request: an attacker-chosen redirect
     * is how an authorization code leaves for somebody else's server. */
    DISCORD_CLIENT_ID: z
      .string()
      .regex(/^$|^[0-9]{5,32}$/, 'must be a Discord application id')
      .default(''),
    DISCORD_CLIENT_SECRET: z.string().default(''),
    DISCORD_REDIRECT_URI: z
      .union([
        z
          .string()
          .url()
          .refine((value) => /^https?:\/\//.test(value), 'must be an HTTP(S) URL'),
        z.literal(''),
      ])
      .default(''),
    /* ── the Discord control plane ──
     *
     * A private guild acts as a remote control for the platform: read commands, moderation
     * commands, and a command that mints a link straight into the admin dashboard.
     *
     * DISCORD_ADMIN_LINK_TTL_SECONDS is capped at fifteen minutes in the schema rather than left
     * to the operator. A redeemed link produces a session with administrator MFA already marked
     * satisfied, so the window in which a leaked URL is worth anything is the single most
     * important number here — and a config file is not the place to be able to type 86400. */
    DISCORD_CONTROL_ENABLED: booleanString,
    DISCORD_BOT_TOKEN: z.string().default(''),
    DISCORD_GUILD_ID: z
      .string()
      .regex(/^$|^[0-9]{5,32}$/, 'must be a Discord guild id')
      .default(''),
    DISCORD_CONTROL_HMAC_KEY: z.string().default(''),
    DISCORD_OPERATORS_JSON: z.string().default('{}'),
    /* Where operational alerts are posted. Outbound only; the bot never reads it. */
    DISCORD_ALERT_CHANNEL_ID: z
      .string()
      .regex(/^$|^[0-9]{5,32}$/, 'must be a Discord channel id')
      .default(''),
    DISCORD_ADMIN_LINK_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(300),
    /* Per-operator command budget, enforced in Postgres so it survives a bot restart. */
    DISCORD_COMMAND_RATE_LIMIT: z.coerce.number().int().min(1).max(600).default(30),
    DISCORD_COMMAND_RATE_WINDOW_SECONDS: z.coerce.number().int().min(10).max(3600).default(60),
    /* How long a destructive command's confirmation stays valid before it has to be re-issued. */
    DISCORD_CONFIRM_TTL_SECONDS: z.coerce.number().int().min(15).max(600).default(120),
    DEV_LOGIN_ENABLED: booleanString,
    DEV_LOGIN_TOKEN: z.string().min(24).max(256).default(''),
    DEV_LOGIN_BALANCE_MINOR: positiveBigintString.default('50000000'),
    MINECRAFT_TRANSFERS_ENABLED: booleanString,
    // Website-only items mean the bot custodies nothing for players, so its real Minecraft
    // inventory is irrelevant and must not reconcile against the ledger. Enable only when
    // physical custody genuinely backs on-site items again.
    PHYSICAL_CUSTODY_ENABLED: booleanString,
    // Login by payment. The amount the player is asked to pay is the one-time secret, so it
    // must stay inside the range DonutSMP renders exactly in chat; at a thousand and above the
    // message abbreviates ("1234" becomes "1.2K") and the nonce stops being readable.
    DONUTSMP_API_BASE_URL: z
      .string()
      .url()
      .refine((value) => value.startsWith('https://'), 'must use HTTPS')
      .transform((value) => value.replace(/\/+$/, ''))
      .default('https://api.donutsmp.net'),
    DONUTSMP_API_KEY: z.string().default(''),
    PAY_LOGIN_MIN_AMOUNT: z.coerce.number().int().min(1).max(999).default(100),
    PAY_LOGIN_MAX_AMOUNT: z.coerce.number().int().min(1).max(999).default(999),
    /* Cloudflare Turnstile on the sign-in card. The site key is public — it is rendered into the
     * widget — and is served to the browser by GET /v1/auth/pay/turnstile so a deployment without
     * Turnstile configured simply does not draw one. */
    TURNSTILE_ENABLED: booleanString,
    TURNSTILE_SITE_KEY: z.string().max(128).default(''),
    TURNSTILE_SECRET_KEY: z.string().max(256).default(''),
    TRUSTED_PROXY_CIDRS: z.string().default('127.0.0.1/32,::1/128'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
  })
  .superRefine((env, context) => {
    if (env.PAY_LOGIN_MIN_AMOUNT > env.PAY_LOGIN_MAX_AMOUNT) {
      context.addIssue({
        code: 'custom',
        path: ['PAY_LOGIN_MAX_AMOUNT'],
        message: 'must not be below PAY_LOGIN_MIN_AMOUNT',
      });
    }
    if (env.MIN_MULTIPLIER_BPS >= env.MAX_MULTIPLIER_BPS) {
      context.addIssue({
        code: 'custom',
        path: ['MAX_MULTIPLIER_BPS'],
        message: 'must exceed minimum',
      });
    }
    /* The developer login bypasses identity proof entirely. There is no legitimate production use
     * for it, so the process refuses to start rather than trusting an operator to have meant it —
     * a config mistake here is an unauthenticated path to any account's privileges. */
    if (env.DEV_LOGIN_ENABLED && env.NODE_ENV === 'production') {
      context.addIssue({
        code: 'custom',
        path: ['DEV_LOGIN_ENABLED'],
        message: 'must never be enabled in production: it bypasses authentication',
      });
    }
    // Enabled without a token would leave the bypass open to anyone who can reach the port.
    if (env.DEV_LOGIN_ENABLED && env.DEV_LOGIN_TOKEN.length < 24) {
      context.addIssue({
        code: 'custom',
        path: ['DEV_LOGIN_TOKEN'],
        message: 'must be at least 24 characters when the developer login is enabled',
      });
    }
    if (env.HOUSE_STOCK_UNLIMITED && env.PHYSICAL_CUSTODY_ENABLED) {
      context.addIssue({
        code: 'custom',
        path: ['HOUSE_STOCK_UNLIMITED'],
        message:
          'cannot be enabled with PHYSICAL_CUSTODY_ENABLED: minting unbacked items would break bot reconciliation',
      });
    }
    if (
      env.REFERRALS_ENABLED &&
      BigInt(env.REFERRAL_BONUS_WAGER_MINOR) < BigInt(env.REFERRAL_BONUS_MINOR)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['REFERRAL_BONUS_WAGER_MINOR'],
        message:
          'must be at least REFERRAL_BONUS_MINOR: a bonus larger than the wager that earns it pays out more than it takes in',
      });
    }
    /* The four rakeback tiers are paid from one pot — the edge on a wager — so what matters is
     * their sum, not any single rate. Above 100% the house is paying out more cash-back than the
     * wager earned it, which is not a generous promotion but a negative-margin product that gets
     * drained by anyone who notices. Refused at boot rather than discovered in a ledger. */
    const rakebackTotalBps =
      env.RAKEBACK_INSTANT_BPS +
      env.RAKEBACK_DAILY_BPS +
      env.RAKEBACK_WEEKLY_BPS +
      env.RAKEBACK_MONTHLY_BPS;
    if (env.RAKEBACK_ENABLED && rakebackTotalBps > 10_000) {
      context.addIssue({
        code: 'custom',
        path: ['RAKEBACK_INSTANT_BPS'],
        message:
          'the four rakeback tiers must sum to at most 10000 bps: they all come out of one house margin',
      });
    }
    /* The duel rake is a house edge, and once skill duels are on it is very likely the SMALLEST
     * one on the platform — 3% against the upgrader's 5%. That matters because rakeback, the VIP
     * ladder and the referral share are all paid out of "the margin", and the existing checks
     * size them against HOUSE_EDGE_BPS. If the duel's margin is thinner than the edge those
     * shares were solved against, every duel pays out a larger fraction of its own rake than
     * intended, and a mode with no house position can run at a structural loss.
     *
     * The VIP ceiling is 200 bps OF WAGER and is the largest single claim on a duel's margin. A
     * duel collects rake_bps of the pot, which is rake_bps of each player's own stake; so the
     * ceiling has to clear the VIP rate with room for the rest. Refused at boot rather than
     * discovered in a month of ledgers. */
    if (env.SKILL_DUEL_ENABLED && env.VIP_ENABLED && env.SKILL_DUEL_RAKE_BPS <= 200) {
      context.addIssue({
        code: 'custom',
        path: ['SKILL_DUEL_RAKE_BPS'],
        message:
          'must exceed the 200 bps VIP rakeback ceiling: a duel rake at or below it pays out more than the duel collected',
      });
    }
    if (
      env.SKILL_DUEL_ENABLED &&
      BigInt(env.SKILL_DUEL_MIN_STAKE_MINOR) > BigInt(env.SKILL_DUEL_MAX_STAKE_MINOR)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['SKILL_DUEL_MAX_STAKE_MINOR'],
        message: 'must be at least SKILL_DUEL_MIN_STAKE_MINOR',
      });
    }
    /* A rake that rounds to nothing on the smallest legal duel is a free mode. Integer division
     * truncates in the player's favour, so a minimum stake small enough that `pot * bps / 10000`
     * floors to zero means the house runs that duel for free and still pays rakeback on it. */
    if (
      env.SKILL_DUEL_ENABLED &&
      env.SKILL_DUEL_RAKE_BPS > 0 &&
      (BigInt(env.SKILL_DUEL_MIN_STAKE_MINOR) * 2n * BigInt(env.SKILL_DUEL_RAKE_BPS)) / 10_000n ===
        0n
    ) {
      context.addIssue({
        code: 'custom',
        path: ['SKILL_DUEL_MIN_STAKE_MINOR'],
        message:
          'is too small for SKILL_DUEL_RAKE_BPS to collect anything: the rake would truncate to zero on a minimum-stake duel',
      });
    }
    /* The arena's cut is a house margin like any other, and rakeback, the VIP ladder and the
     * referral share are all paid out of "the margin". The VIP ceiling is 200 bps OF WAGER and is
     * the largest single claim on it; an arena fee at or below that pays out more rakeback than the
     * extraction collected, on every session, forever. Same arithmetic as the duel check above,
     * and refused at boot for the same reason. */
    if (env.TIPS_ENABLED && BigInt(env.TIP_MIN_MINOR) > BigInt(env.TIP_MAX_MINOR)) {
      context.addIssue({
        code: 'custom',
        path: ['TIP_MAX_MINOR'],
        message: 'must be at least TIP_MIN_MINOR',
      });
    }
    if (
      env.SIDE_BETS_ENABLED &&
      BigInt(env.SIDE_BET_MIN_STAKE_MINOR) > BigInt(env.SIDE_BET_MAX_STAKE_MINOR)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['SIDE_BET_MAX_STAKE_MINOR'],
        message: 'must be at least SIDE_BET_MIN_STAKE_MINOR',
      });
    }
    /* A webhook feed with no webhook posts nowhere and reports no error, which is the failure mode
     * an operator discovers a month later when they ask why the channel is empty. */
    if (env.DISCORD_FLEX_ENABLED && !env.DISCORD_FLEX_WEBHOOK_URL) {
      context.addIssue({
        code: 'custom',
        path: ['DISCORD_FLEX_WEBHOOK_URL'],
        message: 'is required when DISCORD_FLEX_ENABLED is on',
      });
    }
    /* Every one of these is load-bearing when the control plane is on, and every one of them
     * fails silently if it is missing: no token means no bot, no key means unauthenticated
     * requests, no guild means commands answered anywhere the bot was invited, and no operators
     * means a bot nobody can use. Refusing to boot is the only version of this check that an
     * operator cannot skip past. */
    if (env.DISCORD_CONTROL_ENABLED) {
      if (!env.DISCORD_BOT_TOKEN) {
        context.addIssue({
          code: 'custom',
          path: ['DISCORD_BOT_TOKEN'],
          message: 'is required when DISCORD_CONTROL_ENABLED is on',
        });
      }
      if (env.DISCORD_CONTROL_HMAC_KEY.length < 32) {
        context.addIssue({
          code: 'custom',
          path: ['DISCORD_CONTROL_HMAC_KEY'],
          message: 'must be at least 32 characters when DISCORD_CONTROL_ENABLED is on',
        });
      }
      if (!env.DISCORD_GUILD_ID) {
        context.addIssue({
          code: 'custom',
          path: ['DISCORD_GUILD_ID'],
          message:
            'is required when DISCORD_CONTROL_ENABLED is on: an unpinned guild lets the bot be invited elsewhere and answer there',
        });
      }
      if (env.DISCORD_OPERATORS_JSON.trim() === '{}') {
        context.addIssue({
          code: 'custom',
          path: ['DISCORD_OPERATORS_JSON'],
          message: 'must list at least one operator when DISCORD_CONTROL_ENABLED is on',
        });
      }
    }
    /* Half-configured is refused rather than quietly ignored. A deployment that believes it is
     * challenging sign-ups and is not is worse off than one that knows it is not. */
    if (env.TURNSTILE_ENABLED) {
      if (!env.TURNSTILE_SITE_KEY) {
        context.addIssue({
          code: 'custom',
          path: ['TURNSTILE_SITE_KEY'],
          message: 'is required when TURNSTILE_ENABLED is on',
        });
      }
      if (!env.TURNSTILE_SECRET_KEY) {
        context.addIssue({
          code: 'custom',
          path: ['TURNSTILE_SECRET_KEY'],
          message: 'is required when TURNSTILE_ENABLED is on',
        });
      }
    }
        // A daily rate with no ceiling compounds without bound. Refusing the combination outright is
    // safer than shipping a yield that only stops when someone notices the economy has drifted.
    if (env.VAULT_YIELD_BPS_PER_DAY > 0 && env.VAULT_YIELD_CAP_BPS === 0) {
      context.addIssue({
        code: 'custom',
        path: ['VAULT_YIELD_CAP_BPS'],
        message: 'must be set when a daily vault yield is enabled',
      });
    }
    if (env.NODE_ENV === 'production') {
      if (!env.APP_ORIGIN.startsWith('https://')) {
        context.addIssue({
          code: 'custom',
          path: ['APP_ORIGIN'],
          message: 'must use HTTPS in production',
        });
      }
      if (env.AUDIT_LOG_KEY_ID === 'dev-v1') {
        context.addIssue({
          code: 'custom',
          path: ['AUDIT_LOG_KEY_ID'],
          message: 'must identify the deployed audit key in production',
        });
      }
      if (!env.REDIS_URL) {
        context.addIssue({
          code: 'custom',
          path: ['REDIS_URL'],
          message: 'is required for shared production rate limits',
        });
      }
      if (hasOverlyBroadProxyCidr(env.TRUSTED_PROXY_CIDRS)) {
        context.addIssue({
          code: 'custom',
          path: ['TRUSTED_PROXY_CIDRS'],
          message: 'must use narrowly scoped proxy networks in production',
        });
      }
      if (env.MINECRAFT_TRANSFERS_ENABLED) {
        context.addIssue({
          code: 'custom',
          path: ['MINECRAFT_TRANSFERS_ENABLED'],
          message: 'cannot be enabled while the bundled transfer adapter is disabled',
        });
      }
      const databasePassword = decodedUrlPassword(env.DATABASE_URL);
      if (databasePassword.length < 24 || looksLikePlaceholder(databasePassword)) {
        context.addIssue({
          code: 'custom',
          path: ['DATABASE_URL'],
          message: 'must contain a strong database password of at least 24 characters',
        });
      }
      const redisPassword = decodedUrlPassword(env.REDIS_URL);
      if (redisPassword.length < 24 || looksLikePlaceholder(redisPassword)) {
        context.addIssue({
          code: 'custom',
          path: ['REDIS_URL'],
          message: 'must contain a strong Redis password of at least 24 characters',
        });
      }
    }
  });

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const env = environmentSchema.parse(resolveFileBackedSettings(environment));
  const botCredentials = parseBotCredentials(env.BOT_CREDENTIALS_JSON);
  const adminTotpSecrets = parseAdminTotpSecrets(env.ADMIN_TOTP_SECRETS_JSON);
  const trustedProxyCidrs = parseTrustedProxyCidrs(env.TRUSTED_PROXY_CIDRS);
  const normalizeList = (value: string): ReadonlySet<string> =>
    new Set(
      value
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean),
    );
  const adminMinecraftIds = normalizeList(env.ADMIN_MINECRAFT_IDS);
  const discordOperators = parseDiscordOperators(env.DISCORD_OPERATORS_JSON);
  /* An operator mapped to an identity that is not an administrator would be granted a session the
   * rest of the system then refuses on every request — a confusing, silent half-privilege. Worse,
   * if ADMIN_MINECRAFT_IDS is later trimmed and this is not, the mapping quietly becomes a way to
   * hold a role that was supposed to have been removed. Checked at boot, both directions. */
  for (const [snowflake, identity] of discordOperators) {
    if (!adminMinecraftIds.has(identity)) {
      throw new Error(
        `DISCORD_OPERATORS_JSON maps ${snowflake} to an identity that is not in ADMIN_MINECRAFT_IDS`,
      );
    }
  }
  if (
    adminMinecraftIds.size !== adminTotpSecrets.size ||
    [...adminMinecraftIds].some((identity) => !adminTotpSecrets.has(identity))
  ) {
    throw new Error('Every configured admin identity requires exactly one TOTP secret');
  }

  if (env.NODE_ENV === 'production') {
    const secrets = [
      ['DATABASE_URL.password', decodedUrlPassword(env.DATABASE_URL)],
      ['REDIS_URL.password', decodedUrlPassword(env.REDIS_URL)],
      ['COOKIE_SECRET', env.COOKIE_SECRET],
      ['DATA_ENCRYPTION_KEY', env.DATA_ENCRYPTION_KEY],
      ['AUDIT_LOG_HMAC_KEY', env.AUDIT_LOG_HMAC_KEY],
      ['IP_HASH_KEY', env.IP_HASH_KEY],
      ...[...botCredentials].map(
        ([botId, credential]) =>
          [`BOT_CREDENTIALS_JSON.${botId}`, credential.secret.toString('base64')] as const,
      ),
      ...[...adminTotpSecrets].map(
        ([identity, secret]) =>
          [`ADMIN_TOTP_SECRETS_JSON.${identity}`, secret.toString('base64')] as const,
      ),
    ] as const;
    for (const [name, value] of secrets) {
      if (looksLikePlaceholder(value)) throw new Error(`${name} must be a strong generated secret`);
    }
    if (new Set(secrets.map(([, value]) => value)).size !== secrets.length) {
      throw new Error(
        'Database, Redis, cookie, encryption, audit, IP hashing, bot, and MFA secrets must all be distinct',
      );
    }
  }

  return Object.freeze({
    environment: env.NODE_ENV,
    host: env['HOST'],
    port: env.PORT,
    databaseUrl: env.DATABASE_URL,
    databaseSsl: env.DATABASE_SSL,
    redisUrl: env.REDIS_URL || undefined,
    appOrigin: new URL(env.APP_ORIGIN).origin,
    cookieSecret: env.COOKIE_SECRET,
    dataEncryptionKey: decodeCanonicalKey(env.DATA_ENCRYPTION_KEY)!,
    botCredentials,
    auditLogHmacKey: env.AUDIT_LOG_HMAC_KEY,
    auditLogKeyId: env.AUDIT_LOG_KEY_ID,
    ipHashKey: env.IP_HASH_KEY,
    adminMinecraftIds,
    adminTotpSecrets,
    sessionTtlHours: env.SESSION_TTL_HOURS,
    houseEdgeBps: env.HOUSE_EDGE_BPS,
    itemSellRateBps: env.ITEM_SELL_RATE_BPS,
    minMultiplierBps: env.MIN_MULTIPLIER_BPS,
    maxMultiplierBps: env.MAX_MULTIPLIER_BPS,
    maxWinChancePpm: env.MAX_WIN_CHANCE_PPM,
    vaultYieldBpsPerDay: env.VAULT_YIELD_BPS_PER_DAY,
    vaultYieldCapBps: env.VAULT_YIELD_CAP_BPS,
    houseStockUnlimited: env.HOUSE_STOCK_UNLIMITED,
    cashOnlyPlay: env.CASH_ONLY_PLAY,
    chatEnabled: env.CHAT_ENABLED,
    chatSlowModeSeconds: env.CHAT_SLOW_MODE_SECONDS,
    chatBigHitMinor: BigInt(env.CHAT_BIG_HIT_MINOR),
    factionWarPrizePoolMinor: BigInt(env.FACTION_WAR_PRIZE_POOL_MINOR),
    factionWarDays: env.FACTION_WAR_DAYS,
    streakBaseRewardMinor: BigInt(env.STREAK_BASE_REWARD_MINOR),
    streakMaxMultiplier: env.STREAK_MAX_MULTIPLIER,
    vipEnabled: env.VIP_ENABLED,
    rakebackEnabled: env.RAKEBACK_ENABLED,
    rakebackTierBps: Object.freeze({
      instant: env.RAKEBACK_INSTANT_BPS,
      daily: env.RAKEBACK_DAILY_BPS,
      weekly: env.RAKEBACK_WEEKLY_BPS,
      monthly: env.RAKEBACK_MONTHLY_BPS,
    }),
    skillDuelEnabled: env.SKILL_DUEL_ENABLED,
    skillDuelRakeBps: env.SKILL_DUEL_RAKE_BPS,
    skillDuelMinStakeMinor: BigInt(env.SKILL_DUEL_MIN_STAKE_MINOR),
    skillDuelMaxStakeMinor: BigInt(env.SKILL_DUEL_MAX_STAKE_MINOR),
    skillDuelLobbyTtlMinutes: env.SKILL_DUEL_LOBBY_TTL_MINUTES,
    vaultJackpotEnabled: env.VAULT_JACKPOT_ENABLED,
    vaultJackpotContributionBps: env.VAULT_JACKPOT_CONTRIBUTION_BPS,
    vaultJackpotOddsDivisorMinor: BigInt(env.VAULT_JACKPOT_ODDS_DIVISOR_MINOR),
    vaultJackpotSeedMinor: BigInt(env.VAULT_JACKPOT_SEED_MINOR),
    lavaRainEnabled: env.LAVA_RAIN_ENABLED,
    lavaRainMaxPoolMinor: BigInt(env.LAVA_RAIN_MAX_POOL_MINOR),
    lavaRainMinWageredMinor: BigInt(env.LAVA_RAIN_MIN_WAGERED_MINOR),
    lavaRainWindowMinutes: env.LAVA_RAIN_WINDOW_MINUTES,
    lavaRainClaimMinutes: env.LAVA_RAIN_CLAIM_MINUTES,
    tipsEnabled: env.TIPS_ENABLED,
    tipMinMinor: BigInt(env.TIP_MIN_MINOR),
    tipMaxMinor: BigInt(env.TIP_MAX_MINOR),
    sideBetsEnabled: env.SIDE_BETS_ENABLED,
    sideBetRakeBps: env.SIDE_BET_RAKE_BPS,
    sideBetMinStakeMinor: BigInt(env.SIDE_BET_MIN_STAKE_MINOR),
    sideBetMaxStakeMinor: BigInt(env.SIDE_BET_MAX_STAKE_MINOR),
    discordFlexEnabled: env.DISCORD_FLEX_ENABLED,
    discordFlexWebhookUrl: env.DISCORD_FLEX_WEBHOOK_URL,
    discordFlexMinMinor: BigInt(env.DISCORD_FLEX_MIN_MINOR),
    discordFlexLinkBase: env.DISCORD_FLEX_LINK_BASE || env.APP_ORIGIN,
    racesEnabled: env.RACES_ENABLED,
    raceLeaderboardSize: env.RACE_LEADERBOARD_SIZE,
    creatorProgrammeEnabled: env.CREATOR_PROGRAMME_ENABLED,
    creatorMaxRevshareBps: env.CREATOR_MAX_REVSHARE_BPS,
    referralsEnabled: env.REFERRALS_ENABLED,
    referralRevshareBps: env.REFERRAL_REVSHARE_BPS,
    referralBonusMinor: BigInt(env.REFERRAL_BONUS_MINOR),
    referralBonusWagerMinor: BigInt(env.REFERRAL_BONUS_WAGER_MINOR),
    discordClientId: env.DISCORD_CLIENT_ID,
    discordClientSecret: env.DISCORD_CLIENT_SECRET,
    discordRedirectUri: env.DISCORD_REDIRECT_URI,
    discordControlEnabled: env.DISCORD_CONTROL_ENABLED,
    discordBotToken: env.DISCORD_BOT_TOKEN,
    discordGuildId: env.DISCORD_GUILD_ID,
    discordControlHmacKey: env.DISCORD_CONTROL_HMAC_KEY,
    discordOperators,
    discordAlertChannelId: env.DISCORD_ALERT_CHANNEL_ID,
    discordAdminLinkTtlSeconds: env.DISCORD_ADMIN_LINK_TTL_SECONDS,
    discordCommandRateLimit: env.DISCORD_COMMAND_RATE_LIMIT,
    discordCommandRateWindowSeconds: env.DISCORD_COMMAND_RATE_WINDOW_SECONDS,
    discordConfirmTtlSeconds: env.DISCORD_CONFIRM_TTL_SECONDS,
    devLoginEnabled: env.DEV_LOGIN_ENABLED,
    devLoginToken: env.DEV_LOGIN_TOKEN,
    devLoginBalanceMinor: BigInt(env.DEV_LOGIN_BALANCE_MINOR),
    minecraftTransfersEnabled: env.MINECRAFT_TRANSFERS_ENABLED,
    physicalCustodyEnabled: env.PHYSICAL_CUSTODY_ENABLED,
    donutsmpApiBaseUrl: env.DONUTSMP_API_BASE_URL,
    donutsmpApiKey: env.DONUTSMP_API_KEY,
    upgradeMaxStakeMinor: BigInt(env.UPGRADE_MAX_STAKE_MINOR),
    payLoginMinAmount: env.PAY_LOGIN_MIN_AMOUNT,
    payLoginMaxAmount: env.PAY_LOGIN_MAX_AMOUNT,
    turnstileEnabled: env.TURNSTILE_ENABLED,
    turnstileSiteKey: env.TURNSTILE_SITE_KEY,
    turnstileSecretKey: env.TURNSTILE_SECRET_KEY,
    trustedProxyCidrs,
    logLevel: env.LOG_LEVEL,
    secureCookies: env.NODE_ENV === 'production',
  });
}
