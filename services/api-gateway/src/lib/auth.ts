import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import type { Database } from './db.js';
import { AppError } from './errors.js';
import { safeEqualBuffer, safeEqualText, sha256, sha256Hex } from './crypto.js';

interface SessionRow {
  session_id: string;
  user_id: string;
  minecraft_identity: string;
  minecraft_username: string;
  role: 'player' | 'admin';
  status: 'active' | 'suspended' | 'closed';
  csrf_hash: Buffer;
  admin_mfa_verified_at: Date | null;
  admin_mfa_key_fingerprint: string | null;
}

export function sessionCookieName(config: AppConfig): string {
  return config.secureCookies ? '__Host-du_session' : 'du_session';
}

export function linkCookieName(config: AppConfig): string {
  return config.secureCookies ? '__Host-du_link' : 'du_link';
}

/**
 * The CSRF cookie is deliberately readable by the browser application, which makes it the one
 * cookie a sibling subdomain could otherwise overwrite for the parent domain. Overwriting it
 * cannot forge a request, because requireCsrf compares the supplied header against the hash
 * stored on the session row rather than against this cookie, but it would wedge the victim's
 * session into permanent INVALID_CSRF. The __Host- prefix makes the cookie host-only and
 * secure with path=/, which forbids that overwrite.
 */
export function csrfCookieName(config: AppConfig): string {
  return config.secureCookies ? '__Host-du_csrf' : 'du_csrf';
}

/* Lax, not Strict. Strict withholds the cookie whenever the visit starts on another site, and
 * players arrive from Discord links, DMs and old bookmarks; some browsers then also withheld it from
 * that page's own API calls, and the player was shown the Log in button with a valid session in
 * hand. Lax still keeps the cookie off every cross-site POST, and nothing here changes state on a
 * GET: every write goes through requireCsrf (an X-CSRF-Token header no other site can set). */
export function sessionCookieOptions(config: AppConfig, maxAgeSeconds = config.sessionTtlHours * 60 * 60) {
  return {
    path: '/',
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'lax' as const,
    signed: true,
    maxAge: maxAgeSeconds,
  };
}

/** The readable CSRF cookie: same lifetime and same SameSite as the session it belongs to. */
export function csrfCookieOptions(config: AppConfig, maxAgeSeconds = config.sessionTtlHours * 60 * 60) {
  return {
    path: '/',
    httpOnly: false,
    secure: config.secureCookies,
    sameSite: 'lax' as const,
    maxAge: maxAgeSeconds,
  };
}

/* A player's session is renewed while it is used: once less than half its lifetime is left, the
 * next authenticated request moves the expiry to a full lifetime from now (one write per half
 * lifetime, not one per request). It never runs past SESSION_MAX_DAYS from the sign-in, so a
 * stolen cookie cannot be kept alive for ever. Administrator sessions keep their fixed, shorter
 * lifetime: they carry MFA and are not renewed. */
const SESSION_MAX_DAYS = 30;

export function createAuthGuards(db: Database, config: AppConfig) {
  async function authenticate(request: FastifyRequest, reply?: FastifyReply): Promise<void> {
    const signed = request.cookies[sessionCookieName(config)];
    if (!signed) throw new AppError(401, 'AUTH_REQUIRED', 'Authentication is required');
    const unsigned = request.unsignCookie(signed);
    if (!unsigned.valid || !unsigned.value) {
      throw new AppError(401, 'INVALID_SESSION', 'The session is invalid');
    }
    const result = await db.query<SessionRow>(
      `SELECT s.id AS session_id, u.id AS user_id, u.minecraft_identity,
              u.minecraft_username, u.role, u.status, s.csrf_hash, s.admin_mfa_verified_at,
              s.admin_mfa_key_fingerprint
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1
          AND s.revoked_at IS NULL
          AND s.expires_at > now()`,
      [sha256(unsigned.value)],
    );
    const row = result.rows[0];
    if (!row) throw new AppError(401, 'INVALID_SESSION', 'The session is invalid or expired');
    const expectedRole = config.adminMinecraftIds.has(row.minecraft_identity.toLowerCase())
      ? 'admin'
      : 'player';
    if (row.role !== expectedRole) {
      await db.transaction(async (client) => {
        await client.query(
          'UPDATE users SET role = $2, updated_at = now() WHERE id = $1 AND role <> $2',
          [row.user_id, expectedRole],
        );
        await client.query(
          'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
          [row.user_id],
        );
      });
      throw new AppError(
        401,
        'SESSION_PRIVILEGES_CHANGED',
        'Account privileges changed; authenticate again',
      );
    }
    const configuredAdminTotp = config.adminTotpSecrets.get(row.minecraft_identity.toLowerCase());
    const expectedMfaKeyFingerprint = configuredAdminTotp
      ? sha256Hex(configuredAdminTotp)
      : undefined;
    if (
      row.role === 'admin' &&
      (!row.admin_mfa_verified_at ||
        !row.admin_mfa_key_fingerprint ||
        !expectedMfaKeyFingerprint ||
        !safeEqualText(row.admin_mfa_key_fingerprint, expectedMfaKeyFingerprint))
    ) {
      await db.query(
        'UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
        [row.session_id],
      );
      throw new AppError(401, 'ADMIN_MFA_REQUIRED', 'Administrator MFA is required');
    }
    if (row.role === 'player') {
      await renewSession(request, reply, row.session_id, unsigned.value, row.csrf_hash);
    }
    request.authUser = {
      id: row.user_id,
      sessionId: row.session_id,
      minecraftIdentity: row.minecraft_identity,
      minecraftUsername: row.minecraft_username,
      role: row.role,
      status: row.status,
      csrfHash: row.csrf_hash,
    };
  }

  /**
   * Moves a player's expiry forward once less than half its lifetime is left, and hands the browser
   * both cookies again to live exactly as long. The row and the cookies move together or not at
   * all: renewing the row without new cookies (no reply to set them on) would leave the browser's
   * copies to lapse first, and the window this checks would by then be closed until they had. The
   * page reads its CSRF token from that cookie, and only its hash is stored, so it can be renewed
   * only from the value the browser sent -- without it the session is left to run out as issued
   * rather than outliving the token every write needs.
   */
  async function renewSession(
    request: FastifyRequest,
    reply: FastifyReply | undefined,
    sessionId: string,
    token: string,
    csrfHash: Buffer,
  ): Promise<void> {
    if (!reply) return;
    const csrf = request.cookies?.[csrfCookieName(config)];
    if (typeof csrf !== 'string' || !safeEqualBuffer(sha256(csrf), csrfHash)) return;
    const renewed = await db.query<{ seconds_left: string }>(
      `UPDATE sessions
          SET expires_at = LEAST(now() + ($2 * interval '1 hour'), created_at + ($3 * interval '1 day')),
              last_seen_at = now()
        WHERE id = $1
          AND revoked_at IS NULL
          AND expires_at < now() + ($2 * interval '1 hour') / 2
          AND expires_at < created_at + ($3 * interval '1 day')
        RETURNING floor(extract(epoch FROM (expires_at - now())))::text AS seconds_left`,
      [sessionId, config.sessionTtlHours, SESSION_MAX_DAYS],
    );
    const left = Number(renewed.rows[0]?.seconds_left ?? 0);
    if (left <= 0) return;
    reply.setCookie(sessionCookieName(config), token, sessionCookieOptions(config, left));
    reply.setCookie(csrfCookieName(config), csrf, csrfCookieOptions(config, left));
  }

  async function requireCsrf(request: FastifyRequest, reply?: FastifyReply): Promise<void> {
    await authenticate(request, reply);
    const origin = request.headers.origin;
    if (!origin || !safeEqualText(origin, config.appOrigin)) {
      throw new AppError(403, 'INVALID_ORIGIN', 'Request origin is not allowed');
    }
    const supplied = request.headers['x-csrf-token'];
    if (typeof supplied !== 'string' || !request.authUser) {
      throw new AppError(403, 'CSRF_REQUIRED', 'A valid CSRF token is required');
    }
    const expected = request.authUser.csrfHash;
    const actual = sha256(supplied);
    if (!safeEqualBuffer(actual, expected)) {
      throw new AppError(403, 'INVALID_CSRF', 'The CSRF token is invalid');
    }
  }

  async function requireAdmin(request: FastifyRequest): Promise<void> {
    await requireCsrf(request);
    if (request.authUser?.role !== 'admin' || request.authUser.status !== 'active') {
      throw new AppError(403, 'ADMIN_REQUIRED', 'Administrator access is required');
    }
  }

  function clearSession(reply: FastifyReply): void {
    reply.clearCookie(sessionCookieName(config), { path: '/' });
    reply.clearCookie(csrfCookieName(config), { path: '/' });
  }

  return { authenticate, requireCsrf, requireAdmin, clearSession };
}
