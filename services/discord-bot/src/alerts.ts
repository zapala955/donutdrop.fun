import { EmbedBuilder, escapeMarkdown, type Client } from 'discord.js';
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
 * somebody already fixing it. The money alerts follow the same rule: each win and each hold is
 * posted once, and a player up on the day is posted again only when they pass the next multiple
 * of the bar.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHERE IT POSTS
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * To the channel the admin panel names (the staff alert settings), or failing that to
 * DISCORD_ALERT_CHANNEL_ID, pinging the role the panel names, if any. With neither channel set the
 * feed still polls and keeps its baseline, so naming a channel later does not dump a backlog.
 */

/** Each counter, and how it reads in a sentence when it rises. */
const WATCHED = [
  ['bots_quarantined', 'bot(s) quarantined'],
  ['bots_stale', 'bot(s) with a stale heartbeat'],
  ['jobs_dead_letter', 'job(s) in dead letter'],
  ['withdrawals_manual_review', 'withdrawal(s) awaiting manual review'],
  ['cash_withdrawals_waiting', 'cash withdrawal(s) waiting for an operator'],
] as const;

const RED = 0xc0392b;
const GOLD = 0xffaa00;
const ORANGE = 0xe67e22;

/** Discord takes ten embeds a message; one list never runs longer than this many lines. */
const MAX_LINES = 10;
/** What the feed remembers having posted, and for how long. The API's window is ten minutes. */
const REMEMBER_MS = 2 * 60 * 60 * 1000;
/** A player up on the day is remembered for a day, the window the API sums over. */
const REMEMBER_PROFIT_MS = 24 * 60 * 60 * 1000;

type Counters = Partial<Record<(typeof WATCHED)[number][0], number>>;

export interface BigWin {
  readonly id: string;
  readonly game: string;
  readonly username: string;
  readonly wagerMinor: bigint;
  readonly payoutMinor: bigint;
}

export interface Profit {
  readonly userId: string;
  readonly username: string;
  readonly netMinor: bigint;
}

export interface Hold {
  readonly userId: string;
  readonly username: string;
  readonly reason: string;
  readonly at: string;
}

export interface MoneyAlerts {
  readonly channelId: string | null;
  readonly roleId: string | null;
  readonly dailyProfitMinor: bigint;
  readonly wins: readonly BigWin[];
  readonly profits: readonly Profit[];
  readonly holds: readonly Hold[];
}

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

const SNOWFLAKE = /^[0-9]{5,32}$/;
const MINOR = /^-?(0|[1-9][0-9]{0,18})$/;

function text(value: unknown, max = 200): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function minor(value: unknown): bigint | null {
  return typeof value === 'string' && MINOR.test(value) ? BigInt(value) : null;
}

function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
    : [];
}

/** Everything the gateway sent, checked: a malformed row is dropped, never posted half-filled. */
export function parseMoneyAlerts(payload: unknown): MoneyAlerts {
  const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const id = (value: unknown) => (typeof value === 'string' && SNOWFLAKE.test(value) ? value : null);
  const wins: BigWin[] = [];
  for (const row of list(record['wins'])) {
    const wager = minor(row['wagerMinor']);
    const payout = minor(row['payoutMinor']);
    const winId = text(row['id'], 64);
    const username = text(row['username'], 32);
    if (wager === null || payout === null || !winId || !username) continue;
    wins.push({ id: winId, game: text(row['game'], 40) || 'a game', username, wagerMinor: wager, payoutMinor: payout });
  }
  const profits: Profit[] = [];
  for (const row of list(record['profits'])) {
    const net = minor(row['netMinor']);
    const userId = text(row['userId'], 64);
    const username = text(row['username'], 32);
    if (net === null || !userId || !username) continue;
    profits.push({ userId, username, netMinor: net });
  }
  const holds: Hold[] = [];
  for (const row of list(record['holds'])) {
    const userId = text(row['userId'], 64);
    const username = text(row['username'], 32);
    const at = text(row['at'], 40);
    if (!userId || !username || !at) continue;
    holds.push({ userId, username, reason: text(row['reason'], 300), at });
  }
  return {
    channelId: id(record['channelId']),
    roleId: id(record['roleId']),
    dailyProfitMinor: minor(record['dailyProfitMinor']) ?? 0n,
    wins,
    profits,
    holds,
  };
}

/** $12.4M / $720K — the ladder the site and the flex feed use, so a figure reads the same. */
export function money(amountMinor: bigint): string {
  const sign = amountMinor < 0n ? '-' : '';
  const value = Math.abs(Number(amountMinor));
  const trim = (scaled: number) => {
    const fixed = scaled >= 100 ? scaled.toFixed(0) : scaled >= 10 ? scaled.toFixed(1) : scaled.toFixed(2);
    return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
  };
  if (value >= 1e12) return `${sign}$${trim(value / 1e12)}T`;
  if (value >= 1e9) return `${sign}$${trim(value / 1e9)}B`;
  if (value >= 1e6) return `${sign}$${trim(value / 1e6)}M`;
  if (value >= 1e3) return `${sign}$${trim(value / 1e3)}K`;
  return `${sign}$${Math.round(value).toLocaleString('en-US')}`;
}

function multiplier(win: BigWin): string {
  if (win.wagerMinor <= 0n) return '';
  const x = Number((win.payoutMinor * 100n) / win.wagerMinor) / 100;
  return ` (${x.toFixed(2)}×)`;
}

/**
 * What a poll has not posted before, and the memory that says so. Kept apart from Discord so the
 * rules -- the baseline, each thing once, the next multiple of the bar -- can be tested alone.
 */
export class MoneyAlertMemory {
  readonly #wins = new Map<string, number>();
  readonly #holds = new Map<string, number>();
  readonly #profits = new Map<string, { net: bigint; at: number }>();
  #baselined = false;

  /** The lines to post for this poll: none on the first, which only learns what is already there. */
  take(alerts: MoneyAlerts, now = Date.now()): { wins: BigWin[]; profits: Profit[]; holds: Hold[] } {
    this.#prune(now);
    const fresh = { wins: [] as BigWin[], profits: [] as Profit[], holds: [] as Hold[] };
    for (const win of alerts.wins) {
      if (this.#wins.has(win.id)) continue;
      this.#wins.set(win.id, now);
      fresh.wins.push(win);
    }
    for (const hold of alerts.holds) {
      const key = `${hold.userId}:${hold.at}`;
      if (this.#holds.has(key)) continue;
      this.#holds.set(key, now);
      fresh.holds.push(hold);
    }
    const bar = alerts.dailyProfitMinor;
    for (const profit of alerts.profits) {
      if (bar <= 0n || profit.netMinor < bar) continue;
      const before = this.#profits.get(profit.userId);
      // Posted again only on passing the next multiple of the bar: 1x, then 2x, then 3x...
      if (before && profit.netMinor / bar <= before.net / bar) continue;
      this.#profits.set(profit.userId, { net: profit.netMinor, at: now });
      fresh.profits.push(profit);
    }
    if (!this.#baselined) {
      this.#baselined = true;
      return { wins: [], profits: [], holds: [] };
    }
    return fresh;
  }

  #prune(now: number): void {
    for (const [key, at] of this.#wins) if (now - at > REMEMBER_MS) this.#wins.delete(key);
    for (const [key, at] of this.#holds) if (now - at > REMEMBER_MS) this.#holds.delete(key);
    for (const [key, entry] of this.#profits) {
      if (now - entry.at > REMEMBER_PROFIT_MS) this.#profits.delete(key);
    }
  }
}

/** The embeds for one poll's fresh alerts, biggest first, each list capped. */
export function moneyEmbeds(fresh: { wins: BigWin[]; profits: Profit[]; holds: Hold[] }): EmbedBuilder[] {
  const name = (username: string) => `**${escapeMarkdown(username)}**`;
  const embeds: EmbedBuilder[] = [];
  const capped = (lines: string[]) =>
    lines.length > MAX_LINES
      ? [...lines.slice(0, MAX_LINES), `…and ${lines.length - MAX_LINES} more`]
      : lines;

  if (fresh.holds.length) {
    embeds.push(
      new EmbedBuilder()
        .setColor(RED)
        .setTitle(fresh.holds.length === 1 ? 'Anti-drain placed a hold' : 'Anti-drain placed holds')
        .setDescription(
          capped(fresh.holds.map((hold) => `${name(hold.username)} — ${escapeMarkdown(hold.reason)}`)).join('\n'),
        )
        .setTimestamp(new Date()),
    );
  }
  if (fresh.wins.length) {
    const wins = [...fresh.wins].sort((a, b) =>
      b.payoutMinor - b.wagerMinor > a.payoutMinor - a.wagerMinor ? 1 : -1,
    );
    embeds.push(
      new EmbedBuilder()
        .setColor(GOLD)
        .setTitle(wins.length === 1 ? 'Big win' : `${wins.length} big wins`)
        .setDescription(
          capped(
            wins.map(
              (win) =>
                `${name(win.username)} won **${money(win.payoutMinor - win.wagerMinor)}** on ${escapeMarkdown(win.game)}` +
                ` — staked ${money(win.wagerMinor)}, paid ${money(win.payoutMinor)}${multiplier(win)}`,
            ),
          ).join('\n'),
        )
        .setTimestamp(new Date()),
    );
  }
  if (fresh.profits.length) {
    const profits = [...fresh.profits].sort((a, b) => (b.netMinor > a.netMinor ? 1 : -1));
    embeds.push(
      new EmbedBuilder()
        .setColor(ORANGE)
        .setTitle('Up big over 24 hours')
        .setDescription(
          capped(
            profits.map(
              (profit) => `${name(profit.username)} is up **${money(profit.netMinor)}** on games and promotions`,
            ),
          ).join('\n'),
        )
        .setTimestamp(new Date()),
    );
  }
  return embeds;
}

/** The alert endpoints are signature-gated but carry no operator, so they are fetched directly. */
async function signedPost(config: BotConfig, path: string): Promise<unknown> {
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
  if (!response.ok) throw new Error(`alert poll ${path} failed with ${response.status}`);
  return response.json();
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
  const memory = new MoneyAlertMemory();
  const warn = (error: unknown, message: string) =>
    log.warn({ err: error instanceof Error ? error.message : String(error) }, message);

  const post = async (channelId: string, roleId: string | null, embeds: EmbedBuilder[]) => {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased() || !('send' in channel)) {
      log.warn({ channel: channelId }, 'alert channel is not postable');
      return;
    }
    await channel
      .send({
        ...(roleId ? { content: `<@&${roleId}>` } : {}),
        // Only the staff role, never @everyone or a user named in a reason.
        allowedMentions: roleId ? { roles: [roleId] } : { parse: [] },
        embeds,
      })
      .catch((error: unknown) => warn(error, 'alert post failed'));
  };

  const tick = async () => {
    /* The two polls fail apart. Logged at warn, never escalated: a poller that crashes the process
     * because the gateway was restarting would turn a thirty-second blip into an outage of the
     * alerting itself. */
    const [counterResult, moneyResult] = await Promise.allSettled([
      signedPost(config, '/internal/v1/discord/alerts'),
      signedPost(config, '/internal/v1/discord/alerts/money'),
    ]);

    const money = moneyResult.status === 'fulfilled' ? parseMoneyAlerts(moneyResult.value) : null;
    if (moneyResult.status === 'rejected') warn(moneyResult.reason, 'money alert poll failed');
    const channelId = money?.channelId ?? (config.DISCORD_ALERT_CHANNEL_ID || null);
    const roleId = money?.roleId ?? null;

    const embeds: EmbedBuilder[] = [];
    if (counterResult.status === 'fulfilled') {
      const current = parseCounters(counterResult.value);
      const risen: string[] = [];
      for (const [key, label] of WATCHED) {
        const now = current[key];
        const before = previous?.[key];
        if (now === undefined) continue;
        if (before !== undefined && now > before) risen.push(`**${now}** ${label} (was ${before})`);
      }
      previous = current;
      if (risen.length) {
        embeds.push(
          new EmbedBuilder()
            .setColor(RED)
            .setTitle('Needs attention')
            .setDescription(risen.join('\n'))
            .setTimestamp(new Date()),
        );
      }
    } else {
      warn(counterResult.reason, 'alert poll failed');
    }
    if (money) embeds.push(...moneyEmbeds(memory.take(money)));

    if (!embeds.length || !channelId) return;
    await post(channelId, roleId, embeds.slice(0, 10));
  };

  /* Caught here as well as inside: server.ts exits on an unhandled rejection, and nothing in an
   * alert is worth restarting the bot that holds the operator commands over. */
  const safeTick = () => tick().catch((error: unknown) => warn(error, 'alert tick failed'));
  const timer = setInterval(() => void safeTick(), config.ALERT_POLL_SECONDS * 1000);
  /* Without this the interval keeps the event loop alive and the process ignores a clean shutdown
   * until the next poll lands. */
  timer.unref();
  void safeTick();
  log.info({ seconds: config.ALERT_POLL_SECONDS }, 'alert feed started');
}
