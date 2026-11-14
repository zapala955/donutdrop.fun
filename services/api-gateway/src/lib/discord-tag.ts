import type { AppConfig } from '../config.js';

/**
 * discord-tag.ts — whether a Discord account wears the public server's tag right now.
 *
 * A code drop claim needs it (the owner, 2026-11-14: "u also need to have the discord server tag
 * equipped to claim the code drops"). The tag is part of the member's profile, Discord's
 * `primary_guild`, so the gateway asks Discord for the profile with the community bot's token: the
 * same test the bot makes for the tag reward (community-bot features/rewards.ts showsServerTag),
 * from the same server, but at the moment of the claim, so a tag put on a second ago counts.
 *
 * Three answers, because Discord can fail to give one: a profile that cannot be read is "unknown",
 * never "not wearing", and the claim says it could not check rather than telling a wearer they
 * are not one.
 */

export type TagState = 'wearing' | 'not-wearing' | 'unknown';

type TagConfig = Pick<AppConfig, 'communityBotToken' | 'communityGuildId'>;

const PROFILE_TIMEOUT_MS = 4_000;
/* A tag seen worn is believed for this long by the code window (never by a claim, which always asks):
 * the window is opened again and again around a drop, and each opening would be a call to Discord. A
 * tag seen off is not remembered at all, so "Check again" right after putting it on works. */
const WEARING_REMEMBERED_MS = 30_000;
const MAX_REMEMBERED = 5_000;
const SNOWFLAKE = /^[0-9]{5,32}$/;

const seenWearing = new Map<string, number>();

/** Whether a Discord user object shows `guildId`'s tag: the tag is that server's and is switched on. */
export function profileWearsTag(profile: unknown, guildId: string): boolean {
  const primary = (profile as { primary_guild?: { identity_guild_id?: unknown; identity_enabled?: unknown } | null } | null)
    ?.primary_guild;
  return Boolean(primary && primary.identity_enabled === true && primary.identity_guild_id === guildId);
}

/**
 * Asks Discord whether `discordUserId` wears the server's tag. `fresh` skips what the window was
 * told a moment ago; a claim always passes it.
 */
export async function serverTagState(
  config: TagConfig,
  discordUserId: string,
  options: { fresh?: boolean; fetchImpl?: typeof fetch; now?: number } = {},
): Promise<TagState> {
  const token = config.communityBotToken;
  const guildId = config.communityGuildId;
  if (!token || !guildId || !SNOWFLAKE.test(discordUserId)) return 'unknown';
  const now = options.now ?? Date.now();
  if (!options.fresh) {
    const at = seenWearing.get(discordUserId);
    if (at !== undefined && now - at < WEARING_REMEMBERED_MS) return 'wearing';
  }
  let profile: unknown;
  try {
    const response = await (options.fetchImpl ?? fetch)(`https://discord.com/api/v10/users/${discordUserId}`, {
      headers: { authorization: `Bot ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS),
    });
    if (!response.ok) return 'unknown';
    profile = await response.json();
  } catch {
    return 'unknown';
  }
  if (!profileWearsTag(profile, guildId)) {
    seenWearing.delete(discordUserId);
    return 'not-wearing';
  }
  if (seenWearing.size >= MAX_REMEMBERED) seenWearing.clear();
  seenWearing.set(discordUserId, now);
  return 'wearing';
}
