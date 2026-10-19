import type { AppConfig } from '../config.js';
import { containsMarkup, containsUnsafeCharacters } from './sanitize.js';

/**
 * The Discord OAuth round trip, shared by the two flows that use it: verifying a Discord for the
 * referral programme (routes/referrals.ts) and signing in with a Discord that is already linked
 * (routes/discord-login.ts). Each flow registers its own callback, so each passes its own redirect
 * URI; Discord refuses a token exchange whose redirect differs from the one the code was minted for.
 */

export const DISCORD_AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
const DISCORD_TOKEN_URL = 'https://discord.com/api/oauth2/token';
const DISCORD_USER_URL = 'https://discord.com/api/users/@me';

/* The raw state is randomToken(32): 32 bytes as unpadded base64url, 43 characters. */
export const OAUTH_STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** The authorize URL for one round trip. `identify` alone: an id is all either flow needs. */
export function discordAuthorizeUrl(config: AppConfig, redirectUri: string, state: string): string {
  const authorize = new URL(DISCORD_AUTHORIZE_URL);
  authorize.searchParams.set('client_id', config.discordClientId);
  authorize.searchParams.set('redirect_uri', redirectUri);
  authorize.searchParams.set('response_type', 'code');
  // identify alone. The programme needs to know the account is real and unique; it has no
  // business reading an email address or a guild list to do that.
  authorize.searchParams.set('scope', 'identify');
  authorize.searchParams.set('state', state);
  authorize.searchParams.set('prompt', 'consent');
  return authorize.toString();
}

/**
 * Trades the authorization code for a token, then reads the account behind it.
 *
 * The token is used once and dropped on the floor — the programme needs an identifier, not
 * ongoing access — so nothing is persisted and there is no refresh to manage.
 */
export async function exchangeDiscordCode(
  config: AppConfig,
  code: string,
  redirectUri: string,
): Promise<{ id: string; username: string }> {
  const tokenResponse = await fetch(DISCORD_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.discordClientId,
      client_secret: config.discordClientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!tokenResponse.ok) throw new Error('Discord rejected the authorization code');
  const token = (await tokenResponse.json()) as { access_token?: unknown; token_type?: unknown };
  if (typeof token.access_token !== 'string' || typeof token.token_type !== 'string') {
    throw new Error('Discord returned an unusable token');
  }

  const userResponse = await fetch(DISCORD_USER_URL, {
    headers: { Authorization: `${token.token_type} ${token.access_token}` },
    signal: AbortSignal.timeout(8_000),
  });
  if (!userResponse.ok) throw new Error('Discord refused the identity lookup');
  const user = (await userResponse.json()) as { id?: unknown; username?: unknown };
  if (typeof user.id !== 'string' || !/^[0-9]{5,32}$/.test(user.id)) {
    throw new Error('Discord returned an unusable account id');
  }
  /* The display name is cosmetic, attacker-chosen, and rendered on the referrals dashboard —
   * three properties that together mean it cannot be stored as it arrives. A Discord username is
   * whatever its owner typed, so truncation alone let control characters, bidi overrides and
   * tag-shaped text into a column that is read back into other people's pages.
   *
   * Rejecting is wrong here, unlike everywhere else this platform validates text: the user did not
   * type this into our form and cannot fix it without renaming themselves on another service, so a
   * refusal would strand a legitimate account mid-verification. The identifier is what the
   * programme actually needs; the label is decoration, so decoration that cannot be displayed
   * safely is replaced rather than allowed to block a verification. */
  const raw = typeof user.username === 'string' ? user.username.normalize('NFC').trim() : '';
  const username =
    raw.length > 0 && raw.length <= 64 && !containsUnsafeCharacters(raw) && !containsMarkup(raw)
      ? raw
      : 'discord user';
  return { id: user.id, username };
}
