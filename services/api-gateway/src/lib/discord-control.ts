import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import { appendAudit } from './audit.js';
import type { Database, DbClient } from './db.js';
import { AppError } from './errors.js';
import { canonicalJson, hmacHex, randomToken, safeEqualText, sha256, sha256Hex } from './crypto.js';

/**
 * discord-control.ts — the trust boundary between a chat client and an administrative API.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THE BOT IS, AND WHAT IT DELIBERATELY IS NOT
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The bot is a TRANSPORT. It holds a Discord gateway socket, turns interactions into signed HTTP
 * calls, and renders whatever comes back. It has no database handle, no session, no knowledge of
 * who is an administrator and no ability to decide anything. Every authorisation question is
 * answered here, on the server, from configuration the bot cannot read.
 *
 * That split is the whole design. A bot process that could decide who is an admin would be an
 * admin, and it runs in whatever container happens to have network access to Discord.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THE BOT'S IDENTITY IS NOT ENOUGH ON ITS OWN
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Requests carry two independent facts: an HMAC proving the caller is the bot, and a Discord user
 * id naming the human who typed the command. The signature is checked here; the user id is checked
 * against the operator allowlist here. Neither alone is sufficient — the signature says "the bot
 * sent this", not "an administrator asked for it", and the user id is a plain number the bot is
 * simply asserting. Requiring both means compromising the bot token gets an attacker as far as
 * "can talk to the API" and no further, because they still have to name an operator, and the set
 * of operators lives in this process's configuration.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE ONE-TIME LINK, AND THE RISK IT CARRIES
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `redeemAdminLink` mints a session with `admin_mfa_verified_at` already set. That is a real
 * bypass of the TOTP requirement `authenticate()` enforces everywhere else, chosen deliberately so
 * that an operator can go from Discord to a working dashboard in one click.
 *
 * The consequence, stated once and plainly: control of the operator's Discord account is control
 * of the platform. Everything here is built to shrink that window rather than pretend it is not
 * there — minutes-long TTLs, single use, one live link at a time, hashed at rest, bound to the
 * Discord id that asked, both ends audited. If the trade stops looking worth it, mint with
 * `requireTotp` and the session comes out unverified, which `authenticate()` then refuses until
 * the operator completes the normal TOTP step.
 */

/** The bot may only reach its own namespace. Anything else is a signature for the wrong audience. */
const CONTROL_PATH_PREFIX = '/internal/v1/discord/';

/** Constant-time comparison needs something to compare against when the feature is switched off. */
const DISABLED_DUMMY_KEY = 'donut-upgrader:discord-control:disabled';

/** Hard ceiling on a redeemed session, independent of SESSION_TTL_HOURS. */
const LINK_SESSION_TTL_HOURS = 8;

export interface DiscordOperator {
  /** The Discord snowflake that typed the command. */
  readonly discordUserId: string;
  /** The platform identity it maps to, e.g. `mc:…`. */
  readonly minecraftIdentity: string;
  readonly userId: string;
  readonly minecraftUsername: string;
}

export function discordControlSignaturePayload(
  method: string,
  path: string,
  timestamp: string,
  body: unknown,
): string {
  return canonicalJson({
    audience: 'donut-upgrader-discord-control',
    version: 1,
    method: method.toUpperCase(),
    path,
    timestamp,
    body,
  });
}

/**
 * Proves the caller is the bot process.
 *
 * Mirrors `verifyBotSignature` deliberately: same header shape, same replay window, same
 * constant-time comparison against a dummy key when no real key is configured so that "control
 * plane disabled" and "wrong signature" take the same time to answer.
 */
export function verifyDiscordControlSignature(request: FastifyRequest, config: AppConfig): void {
  const timestampHeader = request.headers['x-discord-timestamp'];
  const signature = request.headers['x-discord-signature'];
  if (typeof timestampHeader !== 'string' || typeof signature !== 'string') {
    throw new AppError(
      401,
      'DISCORD_SIGNATURE_REQUIRED',
      'Discord control authentication headers are required',
    );
  }
  if (!/^\d{13}$/.test(timestampHeader) || !/^[a-f0-9]{64}$/.test(signature)) {
    throw new AppError(
      401,
      'INVALID_DISCORD_SIGNATURE',
      'Discord control authentication headers are malformed',
    );
  }
  const timestampMs = Number(timestampHeader);
  if (!Number.isSafeInteger(timestampMs) || Math.abs(Date.now() - timestampMs) > 60_000) {
    throw new AppError(
      401,
      'STALE_DISCORD_SIGNATURE',
      'Discord control signature timestamp is outside the allowed window',
    );
  }
  const path = request.routeOptions.url;
  if (typeof path !== 'string' || !path.startsWith(CONTROL_PATH_PREFIX)) {
    throw new AppError(401, 'INVALID_DISCORD_SIGNATURE', 'Discord control audience is invalid');
  }
  const method = typeof request.method === 'string' ? request.method.toUpperCase() : '';
  if (!method) {
    throw new AppError(401, 'INVALID_DISCORD_SIGNATURE', 'Discord control audience is invalid');
  }
  let payload: string;
  try {
    payload = discordControlSignaturePayload(method, path, timestampHeader, request.body);
  } catch {
    throw new AppError(
      400,
      'INVALID_DISCORD_BODY',
      'Discord control body is not canonicalizable JSON',
    );
  }
  const key = config.discordControlEnabled
    ? config.discordControlHmacKey || DISABLED_DUMMY_KEY
    : DISABLED_DUMMY_KEY;
  const expected = hmacHex(key, payload);
  if (!config.discordControlEnabled || !safeEqualText(signature, expected)) {
    throw new AppError(401, 'INVALID_DISCORD_SIGNATURE', 'Discord control signature is invalid');
  }
}

/**
 * Turns the Discord user id the bot asserted into a platform administrator, or refuses.
 *
 * The refusal is deliberately identical whether the snowflake is unknown, maps to a user that has
 * been deleted, or maps to one whose role or status has since changed. A Discord user probing the
 * bot learns only that they are not an operator, which is all they are entitled to know.
 */
export async function resolveOperator(
  db: DbClient,
  config: AppConfig,
  discordUserId: unknown,
): Promise<DiscordOperator> {
  if (typeof discordUserId !== 'string' || !/^[0-9]{5,32}$/.test(discordUserId)) {
    throw new AppError(403, 'NOT_AN_OPERATOR', 'This Discord account cannot use these commands');
  }
  const identity = config.discordOperators.get(discordUserId);
  if (!identity) {
    throw new AppError(403, 'NOT_AN_OPERATOR', 'This Discord account cannot use these commands');
  }
  const result = await db.query<{
    id: string;
    minecraft_username: string;
    role: string;
    status: string;
  }>(
    `SELECT id, minecraft_username, role, status
       FROM users
      WHERE minecraft_identity = $1`,
    [identity],
  );
  const row = result.rows[0];
  /* The allowlist says this identity is an administrator, but the database is the authority on
   * whether the account is currently one and currently usable. A suspended admin is not an admin,
   * and a mapping that outlived its account must not resurrect it. */
  if (!row || row.role !== 'admin' || row.status !== 'active') {
    throw new AppError(403, 'NOT_AN_OPERATOR', 'This Discord account cannot use these commands');
  }
  return {
    discordUserId,
    minecraftIdentity: identity,
    userId: row.id,
    minecraftUsername: row.minecraft_username,
  };
}

/**
 * Spends one unit of an operator's command budget.
 *
 * In Postgres rather than in the bot, because a limit held in a process's memory is bypassed by
 * restarting the process — and the bot is the component an attacker who has the token controls.
 *
 * The `WHERE` on the conflict branch is what makes this safe under concurrency: the increment only
 * applies while the row is under budget, so two commands arriving together cannot both read "29"
 * and both write "30".
 */
export async function spendCommandBudget(
  db: DbClient,
  config: AppConfig,
  discordUserId: string,
): Promise<boolean> {
  const windowSeconds = config.discordCommandRateWindowSeconds;
  const windowStart = new Date(
    Math.floor(Date.now() / (windowSeconds * 1000)) * windowSeconds * 1000,
  );
  const result = await db.query<{ spent: number }>(
    `INSERT INTO discord_command_budgets (discord_user_id, window_started_at, spent)
          VALUES ($1, $2, 1)
     ON CONFLICT (discord_user_id, window_started_at)
     DO UPDATE SET spent = discord_command_budgets.spent + 1
           WHERE discord_command_budgets.spent < $3
       RETURNING spent`,
    [discordUserId, windowStart, config.discordCommandRateLimit],
  );
  return result.rows.length > 0;
}

/** Arguments are operator-typed free text. Truncate hard and never store anything secret-shaped. */
function redactArguments(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, unknown> = {};
  let count = 0;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (count >= 16) break;
    if (!/^[a-z][a-z0-9_-]{0,31}$/i.test(key)) continue;
    if (/token|secret|code|password|key/i.test(key)) {
      out[key] = '[REDACTED]';
    } else if (typeof raw === 'string') {
      out[key] = raw.slice(0, 128);
    } else if (typeof raw === 'number' || typeof raw === 'boolean' || raw === null) {
      out[key] = raw;
    } else {
      continue;
    }
    count += 1;
  }
  return out;
}

export interface CommandLogEntry {
  readonly discordUserId: string;
  readonly discordGuildId?: string | null;
  readonly discordChannelId?: string | null;
  readonly command: string;
  readonly arguments?: unknown;
  readonly actorUserId?: string | null;
  readonly outcome: 'ok' | 'denied' | 'rate_limited' | 'error';
  readonly errorCode?: string | null;
  readonly latencyMs?: number | null;
}

/**
 * Records one invocation, successful or not.
 *
 * Never throws. A command that worked must not be reported as failed because the log write lost a
 * race, and a command that was refused must not turn into a 500 that looks like a bug in the bot.
 * Losing a log line is bad; losing it loudly in the middle of an operator's incident response is
 * worse.
 */
export async function logCommand(db: Database, entry: CommandLogEntry): Promise<void> {
  try {
    await db.query(
      `INSERT INTO discord_command_invocations
         (id, discord_user_id, discord_guild_id, discord_channel_id, command,
          arguments, actor_user_id, outcome, error_code, latency_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        randomUUID(),
        entry.discordUserId,
        entry.discordGuildId ?? null,
        entry.discordChannelId ?? null,
        entry.command,
        JSON.stringify(redactArguments(entry.arguments)),
        entry.actorUserId ?? null,
        entry.outcome,
        entry.errorCode ?? null,
        entry.latencyMs ?? null,
      ],
    );
  } catch {
    /* Deliberately swallowed. See the note above. */
  }
}

export interface MintedAdminLink {
  /** The raw token. Exists here and in the URL handed to the operator, and nowhere else, ever. */
  readonly token: string;
  readonly expiresAt: Date;
}

/**
 * Mints a one-time dashboard link for an operator.
 *
 * Revoking the operator's other live links first is not tidiness. Without it, every `/dashboard`
 * that an operator ran and then ignored stays redeemable until it expires, so the number of live
 * credentials grows with how often they change their mind. One live link means one thing to
 * invalidate when something looks wrong.
 */
export async function mintAdminLink(
  db: Database,
  config: AppConfig,
  operator: DiscordOperator,
  options: { guildId?: string | null; requireTotp?: boolean } = {},
): Promise<MintedAdminLink> {
  const token = randomToken(32);
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + config.discordAdminLinkTtlSeconds * 1000);

  await db.transaction(async (client) => {
    await client.query(
      `UPDATE discord_admin_links
          SET revoked_at = now(), revoked_reason = 'superseded'
        WHERE user_id = $1 AND claimed_at IS NULL AND revoked_at IS NULL`,
      [operator.userId],
    );
    await client.query(
      `INSERT INTO discord_admin_links
         (id, token_hash, discord_user_id, discord_guild_id, user_id, require_totp, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        sha256(token),
        operator.discordUserId,
        options.guildId ?? null,
        operator.userId,
        options.requireTotp ?? false,
        expiresAt,
      ],
    );
    /* Issuance is an administrative act in its own right: it creates a credential. It belongs in
     * the hash-chained log next to what the credential is later used to do. */
    await appendAudit(client, config, {
      actorUserId: operator.userId,
      action: 'discord.admin_link.issued',
      targetType: 'discord_admin_link',
      targetId: id,
      details: {
        discordUserId: operator.discordUserId,
        guildId: options.guildId ?? null,
        requireTotp: options.requireTotp ?? false,
        expiresAt: expiresAt.toISOString(),
      },
    });
  });

  return { token, expiresAt };
}

export interface RedeemedSession {
  readonly sessionToken: string;
  readonly csrfToken: string;
  readonly ttlHours: number;
  readonly minecraftUsername: string;
}

/**
 * Redeems a one-time link and produces an administrator session.
 *
 * The claim is a single conditional UPDATE, which is the only part of this that has to be exactly
 * right: two browsers opening the same URL at the same moment must not both get a session. Doing
 * the check as a SELECT and the claim as a later UPDATE would leave precisely that window open.
 *
 * `admin_mfa_verified_at` is set from the link unless it was minted with `require_totp`. That is
 * the bypass described in this file's header, expressed in one place so it can be found.
 */
export async function redeemAdminLink(
  db: Database,
  config: AppConfig,
  rawToken: unknown,
  context: { ip: string; userAgent: string | null },
): Promise<RedeemedSession> {
  if (typeof rawToken !== 'string' || rawToken.length < 16 || rawToken.length > 256) {
    throw new AppError(401, 'INVALID_ADMIN_LINK', 'This link is not valid');
  }
  const ipHash = Buffer.from(hmacHex(config.ipHashKey, context.ip), 'hex');
  const userAgent = context.userAgent?.slice(0, 512) ?? null;
  const sessionToken = randomToken(32);
  const csrfToken = randomToken();
  const sessionId = randomUUID();

  return db.transaction(async (client) => {
    const claim = await client.query<{
      id: string;
      user_id: string;
      require_totp: boolean;
      discord_user_id: string;
    }>(
      `UPDATE discord_admin_links
          SET claimed_at = now(), claimed_ip_hash = $2, claimed_user_agent = $3
        WHERE token_hash = $1
          AND claimed_at IS NULL
          AND revoked_at IS NULL
          AND expires_at > now()
      RETURNING id, user_id, require_totp, discord_user_id`,
      [sha256(rawToken), ipHash, userAgent],
    );
    const link = claim.rows[0];
    /* One message for expired, already-used, revoked and never-existed. Telling the difference
     * would confirm to somebody holding a stolen URL that it was real and merely late. */
    if (!link) throw new AppError(401, 'INVALID_ADMIN_LINK', 'This link is not valid');

    const userResult = await client.query<{
      minecraft_identity: string;
      minecraft_username: string;
      role: string;
      status: string;
    }>(
      `SELECT minecraft_identity, minecraft_username, role, status
         FROM users WHERE id = $1 FOR UPDATE`,
      [link.user_id],
    );
    const user = userResult.rows[0];
    /* Re-checked at redemption, not merely at issue. A link minted five minutes ago for an admin
     * who has since been suspended must not still work — the whole point of a short TTL is that
     * the world can change inside it. */
    if (!user || user.role !== 'admin' || user.status !== 'active') {
      throw new AppError(403, 'ADMIN_REQUIRED', 'Administrator access is required');
    }

    const totpSecret = config.adminTotpSecrets.get(user.minecraft_identity);
    /* An administrator with no configured TOTP secret has no valid MFA fingerprint, and
     * `authenticate()` rejects an admin session without one on every request. Minting a session
     * that is dead on arrival would present as a mystery logout, so it is refused here instead. */
    if (!totpSecret) {
      throw new AppError(403, 'ADMIN_MFA_REQUIRED', 'Administrator MFA is not configured');
    }
    const mfaSatisfied = !link.require_totp;

    await client.query(
      `INSERT INTO sessions
         (id, user_id, token_hash, csrf_hash, ip_hash, user_agent, expires_at,
          admin_mfa_verified_at, admin_mfa_key_fingerprint)
       VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 * interval '1 hour'),
               CASE WHEN $8::boolean THEN now() ELSE NULL END, $9)`,
      [
        sessionId,
        link.user_id,
        sha256(sessionToken),
        sha256(csrfToken),
        ipHash,
        userAgent,
        LINK_SESSION_TTL_HOURS,
        mfaSatisfied,
        mfaSatisfied ? sha256Hex(totpSecret) : null,
      ],
    );
    await client.query('UPDATE discord_admin_links SET session_id = $2 WHERE id = $1', [
      link.id,
      sessionId,
    ]);
    await appendAudit(client, config, {
      actorUserId: link.user_id,
      action: 'discord.admin_link.redeemed',
      targetType: 'session',
      targetId: sessionId,
      details: {
        linkId: link.id,
        discordUserId: link.discord_user_id,
        mfaSatisfiedByLink: mfaSatisfied,
      },
    });

    return {
      sessionToken,
      csrfToken,
      ttlHours: LINK_SESSION_TTL_HOURS,
      minecraftUsername: user.minecraft_username,
    };
  });
}

export interface IssuedConfirmation {
  readonly nonce: string;
  readonly expiresAt: Date;
}

/**
 * Parks a destructive action behind a nonce the operator has to send back.
 *
 * The payload is stored already validated, and validated again on consumption. That is not
 * belt-and-braces for its own sake: between issue and confirm the row is data sitting in a table,
 * and treating stored data as pre-trusted is how a validation bug becomes a privilege escalation.
 */
export async function issueConfirmation(
  db: DbClient,
  config: AppConfig,
  operator: DiscordOperator,
  action: string,
  payload: Record<string, unknown>,
  summary: string,
): Promise<IssuedConfirmation> {
  const nonce = randomToken(24);
  const expiresAt = new Date(Date.now() + config.discordConfirmTtlSeconds * 1000);
  await db.query(
    `INSERT INTO discord_action_confirmations
       (id, nonce_hash, discord_user_id, actor_user_id, action, payload, summary, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      randomUUID(),
      sha256(nonce),
      operator.discordUserId,
      operator.userId,
      action,
      JSON.stringify(payload),
      summary.slice(0, 512),
      expiresAt,
    ],
  );
  return { nonce, expiresAt };
}

export interface ConsumedConfirmation {
  readonly action: string;
  readonly payload: Record<string, unknown>;
}

/**
 * Consumes a confirmation nonce, once.
 *
 * Bound to the Discord id that was issued it, so one operator cannot confirm another's pending
 * action by lifting a component id out of the channel.
 */
export async function consumeConfirmation(
  client: DbClient,
  operator: DiscordOperator,
  rawNonce: unknown,
): Promise<ConsumedConfirmation> {
  if (typeof rawNonce !== 'string' || rawNonce.length < 16 || rawNonce.length > 256) {
    throw new AppError(400, 'INVALID_CONFIRMATION', 'This confirmation is no longer valid');
  }
  const result = await client.query<{ action: string; payload: Record<string, unknown> }>(
    `UPDATE discord_action_confirmations
        SET consumed_at = now()
      WHERE nonce_hash = $1
        AND discord_user_id = $2
        AND consumed_at IS NULL
        AND expires_at > now()
    RETURNING action, payload`,
    [sha256(rawNonce), operator.discordUserId],
  );
  const row = result.rows[0];
  if (!row) throw new AppError(400, 'INVALID_CONFIRMATION', 'This confirmation is no longer valid');
  return { action: row.action, payload: row.payload };
}

/**
 * Prunes what is safe to prune.
 *
 * Expired links, spent confirmations and old budget windows are all reconstructible noise. The
 * command log is not touched here and has no DELETE grant at all — it is the record of who asked
 * for what, which is the thing an incident review needs and the thing an attacker would most like
 * to tidy away.
 */
export async function sweepDiscordControl(client: DbClient): Promise<{
  linksRemoved: number;
  confirmationsRemoved: number;
  budgetsRemoved: number;
}> {
  /* Takes a client rather than the pool so it runs inside the maintenance transaction, under the
   * advisory lock that already serialises maintenance. A parallel connection would be a second
   * writer the lock does not cover. */
  const links = await client.query(
    `DELETE FROM discord_admin_links WHERE expires_at < now() - interval '7 days'`,
  );
  const confirmations = await client.query(
    `DELETE FROM discord_action_confirmations WHERE expires_at < now() - interval '1 day'`,
  );
  const budgets = await client.query(
    `DELETE FROM discord_command_budgets WHERE window_started_at < now() - interval '1 day'`,
  );
  return {
    linksRemoved: links.rowCount ?? 0,
    confirmationsRemoved: confirmations.rowCount ?? 0,
    budgetsRemoved: budgets.rowCount ?? 0,
  };
}
