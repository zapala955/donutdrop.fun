import type { AppConfig } from '../config.js';

/**
 * discord-flex.ts — outbound win announcements.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS ON THE SERVER AND CANNOT BE ANYWHERE ELSE
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A Discord webhook URL is a bearer credential wearing a URL's clothes: anyone who holds it can
 * post to that channel as the application, forever, with no further authentication and no way to
 * tell the messages apart from real ones. Shipping it to a browser publishes it — "view source" is
 * the entire attack — and the first thing that happens is the channel fills with fake jackpots.
 *
 * It is also the only reason this file exists at all rather than the client posting its own wins:
 * a client that could announce a win could announce a win it did not have.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * IT MUST NEVER BE ABLE TO DELAY OR FAIL A SETTLEMENT
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Every call here is fire-and-forget, made AFTER the transaction that paid the player has already
 * committed, with a hard timeout and no retry. Discord being slow, rate limited, or down is not a
 * reason a player's payout is slow, and an exception escaping this module into a settlement path
 * would be a genuine outage caused by a decoration. So nothing in here throws — the worst case is
 * a log line and a message nobody sees.
 */

/** One announcement. Everything the embed needs, and nothing that identifies the account. */
export interface FlexPayload {
  /** Minecraft username. Used for the head render and the title. */
  readonly username: string;
  readonly amountMinor: bigint;
  /** "Upgrader", "Slither Arena", "Vault Jackpot" — where it happened. */
  readonly mode: string;
  /** Payout over stake, when the mode has one. Omitted for a jackpot, which has no multiplier. */
  readonly multiplier?: number;
  /** Deep link path back into the platform, e.g. '#/upgrader'. */
  readonly path?: string;
}

/** Nether gold, as an integer, which is the only colour format a Discord embed accepts. */
const NETHER_GOLD = 0xffaa00;

/** Discord drops a slow webhook rather than queueing it, and so do we. */
const TIMEOUT_MS = 4_000;

/**
 * $12.4M / $720K — the same ladder the site uses, so a figure reads identically in Discord and on
 * the page it links to. Duplicated rather than imported because the frontend copy lives in the
 * browser bundle and this is the server.
 */
function money(amountMinor: bigint): string {
  const value = Number(amountMinor);
  const trim = (scaled: number) => {
    const text =
      scaled >= 100 ? scaled.toFixed(0) : scaled >= 10 ? scaled.toFixed(1) : scaled.toFixed(2);
    return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
  };
  if (value >= 1e12) return `$${trim(value / 1e12)}T`;
  if (value >= 1e9) return `$${trim(value / 1e9)}B`;
  if (value >= 1e6) return `$${trim(value / 1e6)}M`;
  if (value >= 1e3) return `$${trim(value / 1e3)}K`;
  return `$${Math.round(value).toLocaleString('en-US')}`;
}

/**
 * Whether a win clears the bar for announcement.
 *
 * Exported so a caller can skip building a payload it is not going to send — the check is cheap,
 * but the username lookup behind it sometimes is not.
 */
export function shouldFlex(config: AppConfig, amountMinor: bigint): boolean {
  return (
    config.discordFlexEnabled &&
    config.discordFlexWebhookUrl !== '' &&
    amountMinor >= config.discordFlexMinMinor
  );
}

/**
 * Posts one embed. Returns nothing and throws nothing.
 *
 * `logger` is passed in rather than imported so this module stays free of the Fastify instance and
 * can be unit tested without one.
 */
export async function announceWin(
  config: AppConfig,
  payload: FlexPayload,
  logger?: { error: (context: unknown, message: string) => void },
): Promise<void> {
  if (!shouldFlex(config, payload.amountMinor)) return;

  /* The username is interpolated into a URL and into embed text. It is already constrained to
   * Minecraft's own [A-Za-z0-9_]{1,16} by the database, but this is a value leaving the platform
   * for a third party that renders markdown, so it is re-checked here rather than assumed. A name
   * that cannot be a Minecraft name is a name something else wrote. */
  if (!/^[A-Za-z0-9_]{1,16}$/.test(payload.username)) {
    logger?.error({ username: payload.username }, 'refusing to flex a malformed username');
    return;
  }

  const link = payload.path
    ? `${config.discordFlexLinkBase.replace(/\/$/, '')}/${payload.path.replace(/^\//, '')}`
    : config.discordFlexLinkBase;

  const fields: { name: string; value: string; inline: boolean }[] = [
    { name: 'Payout', value: money(payload.amountMinor), inline: true },
    { name: 'Mode', value: payload.mode, inline: true },
  ];
  if (payload.multiplier !== undefined && Number.isFinite(payload.multiplier)) {
    fields.push({ name: 'Multiplier', value: `${payload.multiplier.toFixed(2)}x`, inline: true });
  }

  const body = {
    username: 'Donut Drop',
    embeds: [
      {
        title: `${payload.username} just hit ${money(payload.amountMinor)}`,
        url: link,
        color: NETHER_GOLD,
        /* mc-heads renders the head from a username with no API key and no account linkage. It is
         * the only third-party call this module makes and it is made by DISCORD, not by us — the
         * URL is handed over in the embed and their CDN fetches it. */
        thumbnail: { url: `https://mc-heads.net/head/${payload.username}/128` },
        fields,
        footer: { text: 'Donut Drop' },
        timestamp: new Date().toISOString(),
      },
    ],
    /* A link button, because the whole point of the feed is the trip back to the platform. Discord
     * only renders link-style buttons for non-application webhooks, which is exactly what this is. */
    components: [
      {
        type: 1,
        components: [{ type: 2, style: 5, label: '🎮 WATCH REPLAY', url: link }],
      },
    ],
    /* Nothing this posts may ping anybody. A win feed that @everyone's a server is a win feed an
     * admin switches off within the hour. */
    allowed_mentions: { parse: [] as string[] },
  };

  try {
    const response = await fetch(config.discordFlexWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      logger?.error({ status: response.status }, 'discord flex webhook rejected the announcement');
    }
  } catch (error) {
    /* Swallowed on purpose. This runs after the player has already been paid; there is nothing
     * here worth propagating into a settlement path. */
    logger?.error({ error }, 'discord flex webhook failed');
  }
}
