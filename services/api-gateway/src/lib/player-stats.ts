import { z } from 'zod';
import { MINECRAFT_USERNAME_PATTERN } from './minecraft-username.js';

/**
 * DonutSMP player stats, read by the stats bot from the server's own /stats.
 *
 * The owner, 2026-11-17: "players do /stats (player) in the community bot and it shows a players
 * stats in the donutsmp ... money, shards, kills, deaths, playtime, blocks placed, blocks broken ...
 * make sure it gets the stats by running /stats on donutsmp". DonutSMP's public stats API is gone
 * (the bots read /bal for the same reason), so the figures are what the server shows a player who
 * runs /stats, read off the menu by the bot (services/minecraft-bot/src/stats-reader.ts) and checked
 * here before anything is stored or drawn.
 */

/** The seven figures, in the order the card shows them. */
export const STAT_KEYS = ['money', 'shards', 'kills', 'deaths', 'playtime', 'blocksPlaced', 'blocksBroken'] as const;
export type StatKey = (typeof STAT_KEYS)[number];

export const STAT_LABELS: Record<StatKey, string> = {
  money: 'Money',
  shards: 'Shards',
  kills: 'Kills',
  deaths: 'Deaths',
  playtime: 'Playtime',
  blocksPlaced: 'Blocks placed',
  blocksBroken: 'Blocks broken',
};

/** A Java name, or a Bedrock one with DonutSMP's leading '.': the site's own rule. */
export const playerNameSchema = z.string().trim().regex(MINECRAFT_USERNAME_PATTERN, 'Not a Minecraft name');

/* One figure: what the server wrote ("$1.2B", "3d 4h") and that as a number (dollars, seconds or a
 * count) when it reads as one. The display is what the card prints, so it is short, printable text. */
const statValueSchema = z
  .object({
    display: z.string().min(1).max(40).regex(/^[\p{L}\p{N}\p{P}\p{Zs}$+]+$/u, 'Not printable'),
    value: z.number().finite().nonnegative().nullable(),
  })
  .strict();
export type StatValue = z.infer<typeof statValueSchema>;

export const statsSchema = z
  .object({
    money: statValueSchema.optional(),
    shards: statValueSchema.optional(),
    kills: statValueSchema.optional(),
    deaths: statValueSchema.optional(),
    playtime: statValueSchema.optional(),
    blocksPlaced: statValueSchema.optional(),
    blocksBroken: statValueSchema.optional(),
  })
  .strict()
  .refine((stats) => STAT_KEYS.some((key) => stats[key] !== undefined), 'No figure was read');
export type PlayerStats = z.infer<typeof statsSchema>;

/** A skin is only ever fetched from Mojang's own texture host. */
export const SKIN_URL_PATTERN = /^https?:\/\/textures\.minecraft\.net\/texture\/[0-9a-f]{20,80}$/;

/** How long a lookup is reused for the same player, so a popular name costs one /stats. */
export const STATS_CACHE_SECONDS = 300;
/** A member's lookups: one per this many seconds, and at most STATS_HOURLY_LIMIT an hour. */
export const STATS_COOLDOWN_SECONDS = 10;
export const STATS_HOURLY_LIMIT = 30;
/** Lookups waiting at once before new ones are turned away. */
export const STATS_QUEUE_LIMIT = 20;
/** A claimed lookup the bot has not answered in this long is given back (once) or failed. */
export const STATS_RUNNING_TIMEOUT_SECONDS = 40;
/** A queued lookup nobody claimed in this long is failed: the member stopped waiting. */
export const STATS_QUEUED_TIMEOUT_SECONDS = 90;
/** How many times a lookup is tried before it fails. */
export const STATS_MAX_ATTEMPTS = 2;
