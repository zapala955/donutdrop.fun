import type { AppConfig } from '../config.js';
import { containsMarkup, containsUnsafeCharacters } from './sanitize.js';

/**
 * The Discord OAuth round trip behind linking a Discord to a site account (routes/discord-link.ts):
 * the player presses Link Discord, authorizes the app on Discord, and Discord sends them back with
 * a code the gateway trades for who they are. The redirect URI is pinned in the config, never taken
 * from a request: Discord refuses a token exchange whose redirect differs from the one the code was
 * minted for, and an attacker-chosen redirect is how a code leaves for somebody else's server.
 */

export const DISCORD_AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
const DISCORD_TOKEN_URL = 'https://discord.com/api/oauth2/token';
const DISCORD_USER_URL = 'https://discord.com/api/users/@me';

/* The raw state is randomToken(32): 32 bytes as unpadded base64url, 43 characters. */
export const OAUTH_STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * What the link asks Discord for. `identify` is the account id, which is all the link itself
 * needs; it has no business reading an email address or a server list. `guilds.members.read` is
 * added only when the community server is configured, and is used for one question -- is this
 * player a member of THAT server -- because the join reward is paid only to members.
 */
export function discordScopes(config: AppConfig): string {
  return config.communityGuildId ? 'identify guilds.members.read' : 'identify';
}

/** The authorize URL for one round trip. Always with Discord's consent screen: a link is a one-off. */
export function discordAuthorizeUrl(config: AppConfig, redirectUri: string, state: string): string {
  const authorize = new URL(DISCORD_AUTHORIZE_URL);
  authorize.searchParams.set('client_id', config.discordClientId);
  authorize.searchParams.set('redirect_uri', redirectUri);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('scope', discordScopes(config));
  authorize.searchParams.set('state', state);
  authorize.searchParams.set('prompt', 'consent');
  return authorize.toString();
}

export interface DiscordIdentity {
  readonly id: string;
  readonly username: string;
  /**
   * Whether the player is a member of the community server: true, false, or null when that was not
   * asked (no server configured) or Discord did not say. Only `true` pays the join reward.
   */
  readonly member: boolean | null;
}

/**
 * Trades the authorization code for a token, then reads the account behind it and, when the
 * community server is configured, whether the account is in it.
 *
 * The token is used for these reads and dropped on the floor -- the link needs an identifier, not
 * ongoing access -- so nothing is persisted and there is no refresh to manage.
 */
export async function exchangeDiscordCode(
  config: AppConfig,
  code: string,
  redirectUri: string,
): Promise<DiscordIdentity> {
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
  const authorization = `${token.token_type} ${token.access_token}`;

  const userResponse = await fetch(DISCORD_USER_URL, {
    headers: { Authorization: authorization },
    signal: AbortSignal.timeout(8_000),
  });
  if (!userResponse.ok) throw new Error('Discord refused the identity lookup');
  const user = (await userResponse.json()) as { id?: unknown; username?: unknown };
  if (typeof user.id !== 'string' || !/^[0-9]{5,32}$/.test(user.id)) {
    throw new Error('Discord returned an unusable account id');
  }
  /* The display name is cosmetic, attacker-chosen, and rendered on other people's pages -- three
   * properties that together mean it cannot be stored as it arrives. Rejecting is wrong here,
   * unlike everywhere else this platform validates text: the player did not type this into our
   * form and cannot fix it without renaming themselves on another service, so a refusal would
   * strand a legitimate link. The identifier is what the link needs; a label that cannot be
   * displayed safely is replaced rather than allowed to block it. */
  const raw = typeof user.username === 'string' ? user.username.normalize('NFC').trim() : '';
  const username =
    raw.length > 0 && raw.length <= 64 && !containsUnsafeCharacters(raw) && !containsMarkup(raw)
      ? raw
      : 'discord user';

  return { id: user.id, username, member: await communityMembership(config, authorization) };
}

/**
 * Whether the token's owner is in the community server: Discord answers the member read with 200
 * for a member and 404 for anybody else. Anything else (a timeout, a rate limit, an older grant
 * without the scope) is "did not say", which pays nothing and leaves `/link` in the server to do it.
 */
async function communityMembership(config: AppConfig, authorization: string): Promise<boolean | null> {
  if (!config.communityGuildId) return null;
  try {
    const response = await fetch(
      `${DISCORD_USER_URL}/guilds/${encodeURIComponent(config.communityGuildId)}/member`,
      { headers: { Authorization: authorization }, signal: AbortSignal.timeout(8_000) },
    );
    if (response.ok) return true;
    if (response.status === 404) return false;
    return null;
  } catch {
    return null;
  }
}
