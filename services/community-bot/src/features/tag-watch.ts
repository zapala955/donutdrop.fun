import type { Client, PartialUser, User } from 'discord.js';
import type { PlatformApi, TagSighting } from '../api-client.js';
import { showsServerTag } from './rewards.js';

/**
 * tag-watch.ts — how the 24 hours of wearing the tag are seen.
 *
 * Every tag reward after the first needs the server's tag worn for 24 hours straight. Only this bot
 * can see a Discord profile, so it keeps looking at everybody who has collected a tag reward lately
 * (the gateway says who) and reports what it sees; the gateway keeps since when each one has worn
 * the tag without a break, and judges the next `/tag` on that.
 *
 * Two ways of seeing, because neither is enough alone:
 *   * a sweep every ten minutes, a fresh fetch of each watched profile -- slow, but it does not
 *     depend on Discord telling anybody anything;
 *   * the `userUpdate` event, when Discord does say a watched member's tag changed -- so a tag taken
 *     off between two sweeps is still caught.
 *
 * A profile that cannot be fetched is skipped, not reported as tag-off: an outage at Discord must
 * not end everybody's streak.
 */

const SWEEP_MS = 10 * 60_000;
const FIRST_SWEEP_MS = 60_000;
/** Between two profile fetches, to stay far inside Discord's rate limits. */
const FETCH_GAP_MS = 250;
const REPORT_BATCH = 200;

const watched = new Set<string>();

/** Starts watching somebody at once, rather than from the next sweep (called after a tag reward). */
export function watchTag(discordUserId: string): void {
  watched.add(discordUserId);
}

type Log = (error: unknown, message: string) => void;

export function startTagWatch(
  client: Client,
  api: PlatformApi,
  guildId: string,
  onError: Log,
): () => void {
  let stopped = false;
  let running = false;
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  async function sweep(): Promise<void> {
    if (running || stopped) return;
    running = true;
    try {
      const ids = await api.tagWatchList();
      watched.clear();
      for (const id of ids) watched.add(id);
      const sightings: TagSighting[] = [];
      for (const id of ids) {
        if (stopped) return;
        const user = await client.users.fetch(id, { force: true }).catch(() => null);
        if (user) sightings.push({ discordUserId: id, wearing: showsServerTag(user, guildId) });
        await pause(FETCH_GAP_MS);
      }
      for (let at = 0; at < sightings.length; at += REPORT_BATCH) {
        await api.reportTagSightings(sightings.slice(at, at + REPORT_BATCH));
      }
    } catch (error) {
      onError(error, 'tag sweep failed');
    } finally {
      running = false;
    }
  }

  const first = setTimeout(() => void sweep(), FIRST_SWEEP_MS);
  const every = setInterval(() => void sweep(), SWEEP_MS);
  return () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(every);
  };
}

/** A watched member's profile changed: if the tag went on or off, say so now. */
export function onUserUpdate(
  api: PlatformApi,
  guildId: string,
  before: User | PartialUser,
  after: User,
  onError: Log,
): void {
  if (!watched.has(after.id)) return;
  const was = showsServerTag(before, guildId);
  const now = showsServerTag(after, guildId);
  if (was === now) return;
  void api
    .reportTagSightings([{ discordUserId: after.id, wearing: now }])
    .catch((error) => onError(error, 'tag change report failed'));
}
