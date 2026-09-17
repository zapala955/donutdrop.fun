import { EmbedBuilder, type Client } from 'discord.js';
import type { Logger } from 'pino';
import { canonicalJson, hmacHex } from './canonical.js';
import type { ControlApi } from './api-client.js';
import type { BotConfig } from './config.js';

/**
 * alerts.ts — the outbound half: telling an operator something is wrong before they think to ask.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS POLLS INSTEAD OF BEING PUSHED
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A push would mean the settlement path calling Discord, and the rule this codebase already
 * follows — see `discord-flex.ts` — is that a payout never waits on a chat service. Polling keeps
 * the dependency pointing the right way: the bot asks, and if Discord or the gateway is down, the
 * thing that breaks is a notification, not a withdrawal.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * IT REPORTS EDGES, NOT LEVELS
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Posting "3 bots quarantined" every minute trains an operator to mute the channel, and a muted
 * alert channel is worse than none because it looks like coverage. So a counter that has not moved
 * says nothing, and only an increase is worth interrupting somebody for — a number going down is
 * somebody already fixing it.
 */

/** Each counter, and how it reads in a sentence when it rises. */
const WATCHED = [
  ['bots_quarantined', 'bot(s) quarantined'],
  ['bots_stale', 'bot(s) with a stale heartbeat'],
  ['jobs_dead_letter', 'job(s) in dead letter'],
  ['withdrawals_manual_review', 'withdrawal(s) awaiting manual review'],
] as const;

const RED = 0xc0392b;

type Counters = Partial<Record<(typeof WATCHED)[number][0], number>>;

function parseCounters(payload: unknown): Counters {
  if (!payload || typeof payload !== 'object') return {};
  const record = payload as Record<string, unknown>;
  const out: Counters = {};
  for (const [key] of WATCHED) {
    const raw = record[key];
    const value = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
    if (Number.isFinite(value) && value >= 0) out[key] = value;
  }
  return out;
}

/** The alert endpoint is signature-gated but carries no operator, so it is fetched directly. */
async function fetchCounters(config: BotConfig): Promise<Counters> {
  const path = '/internal/v1/discord/alerts';
  const body = {};
  const timestamp = Date.now().toString();
  const signature = hmacHex(
    config.DISCORD_CONTROL_HMAC_KEY,
    canonicalJson({
      audience: 'donut-upgrader-discord-control',
      version: 1,
      method: 'POST',
      path,
      timestamp,
      body,
    }),
  );
  const response = await fetch(new URL(path, config.API_INTERNAL_BASE_URL), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-discord-timestamp': timestamp,
      'x-discord-signature': signature,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`alert poll failed with ${response.status}`);
  return parseCounters(await response.json());
}

export function startAlertFeed(
  client: Client,
  config: BotConfig,
  _api: ControlApi,
  log: Logger,
): void {
  /* `undefined` rather than zero, so the first poll after a restart establishes a baseline instead
   * of announcing every standing problem as though it had just happened. */
  let previous: Counters | undefined;

  const tick = async () => {
    let current: Counters;
    try {
      current = await fetchCounters(config);
    } catch (error) {
      /* Logged at warn, never escalated. A poller that crashes the process because the gateway was
       * restarting would turn a thirty-second blip into an outage of the alerting itself. */
      log.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'alert poll failed',
      );
      return;
    }

    const risen: string[] = [];
    for (const [key, label] of WATCHED) {
      const now = current[key];
      const before = previous?.[key];
      if (now === undefined) continue;
      if (before !== undefined && now > before) risen.push(`**${now}** ${label} (was ${before})`);
    }
    previous = current;
    if (!risen.length) return;

    const channel = await client.channels.fetch(config.DISCORD_ALERT_CHANNEL_ID).catch(() => null);
    if (!channel?.isTextBased() || !('send' in channel)) {
      log.warn({ channel: config.DISCORD_ALERT_CHANNEL_ID }, 'alert channel is not postable');
      return;
    }
    await channel
      .send({
        embeds: [
          new EmbedBuilder()
            .setColor(RED)
            .setTitle('Needs attention')
            .setDescription(risen.join('\n'))
            .setTimestamp(new Date()),
        ],
      })
      .catch((error: unknown) =>
        log.warn(
          { err: error instanceof Error ? error.message : String(error) },
          'alert post failed',
        ),
      );
  };

  const timer = setInterval(() => void tick(), config.ALERT_POLL_SECONDS * 1000);
  /* Without this the interval keeps the event loop alive and the process ignores a clean shutdown
   * until the next poll lands. */
  timer.unref();
  void tick();
  log.info({ seconds: config.ALERT_POLL_SECONDS }, 'alert feed started');
}
