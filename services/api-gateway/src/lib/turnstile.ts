import type { AppConfig } from '../config.js';
import { AppError } from './errors.js';

/**
 * Cloudflare Turnstile, verified server-side.
 *
 * The widget in the browser produces a token. That token is worth nothing until Cloudflare is
 * asked about it here, because everything the browser holds is client-supplied: a token can be
 * forged, replayed, or simply omitted by anything that is not a browser. The siteverify call is
 * the whole control, and the rest is presentation.
 *
 * Tokens are single-use and short-lived at Cloudflare's end, which is what stops one solved
 * challenge minting an unlimited number of sign-ins.
 */

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 16 * 1024;

/** The token the widget produces. Length-bounded so a huge body cannot be posted at the verifier. */
export const TURNSTILE_TOKEN_PATTERN = /^[A-Za-z0-9._~-]{1,2048}$/;

interface SiteVerifyResponse {
  success?: unknown;
  'error-codes'?: unknown;
}

/**
 * Throws unless Cloudflare confirms this exact token was solved for this site.
 *
 * `remoteIp` is passed when known so Cloudflare can weigh it; it is advisory on their side and the
 * verification does not depend on it being right.
 */
export async function verifyTurnstile(
  config: AppConfig,
  token: string,
  remoteIp?: string,
): Promise<void> {
  if (!TURNSTILE_TOKEN_PATTERN.test(token)) {
    throw new AppError(400, 'CHALLENGE_REQUIRED', 'Complete the challenge and try again');
  }

  const body = new URLSearchParams({ secret: config.turnstileSecretKey, response: token });
  if (remoteIp) body.set('remoteip', remoteIp);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
      signal: controller.signal,
    });
  } catch (error) {
    /* Unreachable is not "passed". Failing closed briefly refuses sign-ins during a Cloudflare
     * outage; failing open would mean the challenge can be removed by anyone who can stop this
     * request from completing. */
    throw new AppError(
      503,
      'CHALLENGE_UNAVAILABLE',
      'Could not check the challenge right now; try again shortly',
      undefined,
      { cause: error instanceof Error ? error.message : 'unknown' },
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new AppError(503, 'CHALLENGE_UNAVAILABLE', 'Could not check the challenge right now', {
      status: response.status,
    });
  }

  const raw = await response.text();
  if (raw.length > MAX_RESPONSE_BYTES) {
    throw new AppError(503, 'CHALLENGE_UNAVAILABLE', 'The challenge service replied unreadably');
  }
  let payload: SiteVerifyResponse;
  try {
    payload = JSON.parse(raw) as SiteVerifyResponse;
  } catch {
    throw new AppError(503, 'CHALLENGE_UNAVAILABLE', 'The challenge service replied unreadably');
  }

  if (payload.success !== true) {
    /* The error codes distinguish "this person needs to try again" from "this deployment is
     * misconfigured", and only the first is the player's problem to solve. */
    const codes = Array.isArray(payload['error-codes'])
      ? payload['error-codes'].filter((code): code is string => typeof code === 'string')
      : [];
    if (codes.includes('invalid-input-secret') || codes.includes('missing-input-secret')) {
      throw new AppError(503, 'CHALLENGE_UNAVAILABLE', 'The challenge is not configured correctly');
    }
    throw new AppError(400, 'CHALLENGE_FAILED', 'The challenge was not passed; try again');
  }
}
