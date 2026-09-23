import type { FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import { AppError } from './errors.js';
import { canonicalJson, hmacHex, safeEqualText } from './crypto.js';

/**
 * community-bot-auth.ts — proving a request came from the PUBLIC server's bot.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT `verifyDiscordControlSignature`
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The two look almost identical and that is the point of keeping them apart. The control plane's
 * key turns a Discord snowflake into a platform ADMINISTRATOR; this one reads a player's public
 * profile. Sharing a key would mean the process running in a public Discord server — invited by
 * whoever has Manage Server, running automod on messages from strangers — holds the credential
 * that mints admin sessions.
 *
 * So: a different key, a different audience string, and a different path prefix, each checked.
 * A signature minted by the community bot does not verify against a control-plane route even if
 * the body is identical, because the audience inside the signed payload differs. A key stolen
 * from the community bot buys profile lookups; it does not buy an admin session.
 *
 * Everything else is deliberately the same as the control plane: the replay window, the
 * constant-time comparison, and the dummy key that makes "disabled" and "wrong signature" take
 * the same time to answer.
 */

const COMMUNITY_PATH_PREFIX = '/internal/v1/community/';
const AUDIENCE = 'donut-upgrader-community-bot';
const DISABLED_DUMMY_KEY = 'donut-upgrader:community-bot:disabled';
const REPLAY_WINDOW_MS = 60_000;

export function communityBotSignaturePayload(
  method: string,
  path: string,
  timestamp: string,
  body: unknown,
): string {
  return canonicalJson({
    audience: AUDIENCE,
    version: 1,
    method: method.toUpperCase(),
    path,
    timestamp,
    body,
  });
}

export function verifyCommunityBotSignature(request: FastifyRequest, config: AppConfig): void {
  const timestampHeader = request.headers['x-community-timestamp'];
  const signature = request.headers['x-community-signature'];
  if (typeof timestampHeader !== 'string' || typeof signature !== 'string') {
    throw new AppError(
      401,
      'COMMUNITY_SIGNATURE_REQUIRED',
      'Community bot authentication headers are required',
    );
  }
  if (!/^\d{13}$/.test(timestampHeader) || !/^[a-f0-9]{64}$/.test(signature)) {
    throw new AppError(
      401,
      'INVALID_COMMUNITY_SIGNATURE',
      'Community bot authentication headers are malformed',
    );
  }
  const timestampMs = Number(timestampHeader);
  if (!Number.isSafeInteger(timestampMs) || Math.abs(Date.now() - timestampMs) > REPLAY_WINDOW_MS) {
    throw new AppError(
      401,
      'STALE_COMMUNITY_SIGNATURE',
      'Community bot signature timestamp is outside the allowed window',
    );
  }

  /* The ROUTE pattern, not the request URL. `request.url` carries whatever the caller typed,
   * including a query string they control; the route is what Fastify matched. Signing the former
   * would let a caller move a signature onto a different path by appending to it. */
  const path = request.routeOptions.url;
  if (typeof path !== 'string' || !path.startsWith(COMMUNITY_PATH_PREFIX)) {
    throw new AppError(401, 'INVALID_COMMUNITY_SIGNATURE', 'Community bot audience is invalid');
  }
  const method = typeof request.method === 'string' ? request.method.toUpperCase() : '';
  if (!method) {
    throw new AppError(401, 'INVALID_COMMUNITY_SIGNATURE', 'Community bot audience is invalid');
  }

  let payload: string;
  try {
    payload = communityBotSignaturePayload(method, path, timestampHeader, request.body);
  } catch {
    throw new AppError(400, 'INVALID_COMMUNITY_BODY', 'Community bot body is not canonicalizable');
  }

  const key = config.communityBotEnabled
    ? config.communityBotHmacKey || DISABLED_DUMMY_KEY
    : DISABLED_DUMMY_KEY;
  const expected = hmacHex(key, payload);
  if (!config.communityBotEnabled || !safeEqualText(signature, expected)) {
    throw new AppError(401, 'INVALID_COMMUNITY_SIGNATURE', 'Community bot signature is invalid');
  }
}
