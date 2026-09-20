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

export function sessionCookieOptions(config: AppConfig) {
  return {
    path: '/',
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'strict' as const,
    signed: true,
    maxAge: config.sessionTtlHours * 60 * 60,
  };
}

export function createAuthGuards(db: Database, config: AppConfig) {
  async function authenticate(request: FastifyRequest): Promise<void> {
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

  async function requireCsrf(request: FastifyRequest): Promise<void> {
    await authenticate(request);
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
