import { randomInt, randomUUID } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type ChatInputCommandInteraction,
  type Client,
  type EmbedBuilder,
  type Message,
} from 'discord.js';
import type { DailyRedeemResult, PlatformApi } from '../api-client.js';
import { guildSettings, type Database } from '../db.js';
import { COLOR, bad, embed, formatMoney, ok, warn } from '../ui.js';

/**
 * daily-codes.ts — a personal code in your DMs every day, redeemed for a prize.
 *
 * A member opts in with `/daily on`. Once a day (at the hour the dashboard sets, UTC) the bot DMs
 * them a one-use code. They redeem it with `/redeem`, or by simply replying to the DM with it, for
 * a random prize from nothing up to a ceiling the operator sets.
 *
 * The bot ISSUES and DELIVERS codes and nothing else. Which prize a code is worth, whether it is
 * still valid, whether the account may redeem, and the payment itself are all the gateway's
 * (services/api-gateway/src/lib/daily-codes.ts): the bot has no wallet access and cannot pick a
 * prize, only report which Discord account typed which code.
 *
 * Once a day means once: the day's mark is claimed by a guarded UPDATE BEFORE the DM goes out, so two
 * ticks racing each other send one code and a crash never sends two. Three DMs in a row that cannot
 * be delivered unsubscribe the member, because a code nobody can read is not a code.
 */

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const MAX_CONSECUTIVE_FAILURES = 3;
const SEND_SPACING_MS = 1_500;
const PER_TICK = 20;

/** Eight characters from an alphabet without 0, 1, I or O. `random` is injectable for tests. */
export function generateCode(random: (max: number) => number = (max) => randomInt(0, max)): string {
  let code = '';
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    code += CODE_ALPHABET[random(CODE_ALPHABET.length)];
  }
  return code;
}

/** `ABCD-EFGH`, which is how it is shown. */
export const formatCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

/** What was typed or pasted, reduced to the code it names, or null if it is not one. */
export function normalizeCode(raw: string): string | null {
  const code = raw.replace(/[\s-]/g, '').toUpperCase();
  return new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`).test(code) ? code : null;
}

const utcDay = (when: Date) => when.toISOString().slice(0, 10);

/** Discord's "cannot send messages to this user", and "unknown user". Ordinary, not faults. */
const CANNOT_DM = 50007;
const UNKNOWN_USER = 10013;
const codeOf = (error: unknown) =>
  typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;

// ── the message ────────────────────────────────────────────────────────────

export interface DailyCodeFacts {
  readonly code: string;
  readonly siteUrl: string;
  /** The ceiling the operator has set, or null when the platform could not be asked. */
  readonly maxPrizeMinor: string | null;
}

export function buildCodeDm(facts: DailyCodeFacts) {
  let ceiling = 'a big prize';
  try {
    if (facts.maxPrizeMinor && BigInt(facts.maxPrizeMinor) > 0n) {
      ceiling = formatMoney(BigInt(facts.maxPrizeMinor));
    }
  } catch {
    /* an unreadable figure is left out, not guessed */
  }
  const message = embed(
    'Your daily code',
    `Redeem it for a prize from nothing up to **${ceiling}**. Reply to this message with the code, ` +
      'or run `/redeem` in the server.',
  )
    .addFields(
      { name: 'Code', value: `\`\`\`${formatCode(facts.code)}\`\`\`` },
      {
        name: 'Good to know',
        value:
          'It works once and for 24 hours, and only for this Discord account, which has to be ' +
          'linked with `/link`. A prize is playable at once and can be withdrawn after it has ' +
          'been wagered. Stop these any time with `/daily off`.',
      },
    )
    .setFooter({ text: 'One code a day. Replies that are not a code are ignored.' });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel('Open the site')
      .setURL(facts.siteUrl.replace(/\/+$/, '')),
  );
  return { embeds: [message], components: [row] };
}

/** What a redemption looks like to the person who made it. */
export function describeRedeem(result: DailyRedeemResult): EmbedBuilder {
  if (result.status === 'paid') {
    return ok(
      'Daily code redeemed',
      `**${formatMoney(BigInt(result.prizeMinor))}** was added to **${result.username}**.\n` +
        `It is playable now and can be withdrawn once you have wagered ` +
        `**${formatMoney(BigInt(result.wagerMinor))}**.`,
    );
  }
  if (result.status === 'nothing') {
    return embed(
      'Nothing this time',
      `The code was valid but today’s draw came up empty, **${result.username}**. A new code ` +
        'arrives tomorrow.',
      COLOR.quiet,
    );
  }
  return (result.keepCode ? warn : bad)('Not redeemed', result.reason);
}

// ── opting in and out ──────────────────────────────────────────────────────

export async function subscribe(
  db: Database,
  guildId: string,
  discordUserId: string,
): Promise<'subscribed' | 'already'> {
  const result = await db.query<{ inserted: boolean }>(
    `INSERT INTO discord_daily_subscribers (guild_id, discord_user_id) VALUES ($1, $2)
     ON CONFLICT (guild_id, discord_user_id) DO UPDATE SET failures = 0
     RETURNING (xmax = 0) AS inserted`,
    [guildId, discordUserId],
  );
  return result.rows[0]?.inserted ? 'subscribed' : 'already';
}

export async function unsubscribe(
  db: Database,
  guildId: string,
  discordUserId: string,
): Promise<boolean> {
  const result = await db.query(
    'DELETE FROM discord_daily_subscribers WHERE guild_id = $1 AND discord_user_id = $2',
    [guildId, discordUserId],
  );
  return result.rowCount > 0;
}

// ── delivery ───────────────────────────────────────────────────────────────

export type DeliveryOutcome = 'sent' | 'already' | 'closed' | 'unreachable' | 'off';

/** Inserts today's code, or returns the one already there (a crash after the claim, say). */
async function todaysCode(
  db: Database,
  guildId: string,
  discordUserId: string,
  day: string,
): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const result = await db.query<{ code: string }>(
        `INSERT INTO discord_daily_codes (id, guild_id, discord_user_id, code, issued_on, expires_at)
         VALUES ($1, $2, $3, $4, $5::date, now() + interval '24 hours')
         ON CONFLICT (guild_id, discord_user_id, issued_on)
         DO UPDATE SET issued_on = discord_daily_codes.issued_on
         RETURNING code`,
        [randomUUID(), guildId, discordUserId, generateCode(), day],
      );
      const code = result.rows[0]?.code;
      if (code) return code;
    } catch (error) {
      // Two members drawing the same eight characters: draw again.
      if ((error as { code?: string }).code !== '23505') throw error;
    }
  }
  throw new Error('Could not mint a unique daily code');
}

/**
 * Sends one member today's code, if they have not had it. The day's mark is claimed first, by one
 * statement, so this is safe to call from the opt-in command and the hourly sender alike.
 */
export async function deliverDailyCode(
  db: Database,
  client: Client,
  api: PlatformApi | null,
  siteUrl: string,
  guildId: string,
  discordUserId: string,
  now: Date = new Date(),
): Promise<DeliveryOutcome> {
  if (!(await guildSettings(db, guildId)).daily_codes_enabled) return 'off';

  const day = utcDay(now);
  const claimed = await db.query(
    `UPDATE discord_daily_subscribers SET last_sent_on = $3::date
      WHERE guild_id = $1 AND discord_user_id = $2
        AND (last_sent_on IS NULL OR last_sent_on < $3::date)
      RETURNING discord_user_id`,
    [guildId, discordUserId, day],
  );
  if (claimed.rowCount === 0) return 'already';

  const code = await todaysCode(db, guildId, discordUserId, day);
  const status = await api?.rewardStatus(discordUserId).catch(() => null);
  const message = buildCodeDm({
    code,
    siteUrl,
    maxPrizeMinor: status?.dailyCodes?.maxPrizeMinor ?? null,
  });

  try {
    const user = await client.users.fetch(discordUserId);
    await user.send(message);
    await db.query(
      'UPDATE discord_daily_subscribers SET failures = 0 WHERE guild_id = $1 AND discord_user_id = $2',
      [guildId, discordUserId],
    );
    return 'sent';
  } catch (error) {
    const reason = codeOf(error);
    if (reason !== CANNOT_DM && reason !== UNKNOWN_USER) throw error;
    const failed = await db.query<{ failures: number }>(
      `UPDATE discord_daily_subscribers SET failures = failures + 1
        WHERE guild_id = $1 AND discord_user_id = $2 RETURNING failures`,
      [guildId, discordUserId],
    );
    const failures = failed.rows[0]?.failures ?? 0;
    if (reason === UNKNOWN_USER || failures >= MAX_CONSECUTIVE_FAILURES) {
      await unsubscribe(db, guildId, discordUserId);
      return 'unreachable';
    }
    return 'closed';
  }
}

/**
 * One pass of the hourly sender: everybody who is due today, once the dashboard's hour has come.
 * Returns how many were handled. Spaced out, because Discord rate-limits opening DMs.
 */
export async function runDailySender(
  db: Database,
  client: Client,
  api: PlatformApi | null,
  siteUrl: string,
  guildId: string,
  now: Date = new Date(),
  spacingMs: number = SEND_SPACING_MS,
): Promise<number> {
  const settings = await guildSettings(db, guildId);
  if (!settings.daily_codes_enabled || now.getUTCHours() < settings.daily_codes_hour) return 0;

  const due = await db.query<{ discord_user_id: string }>(
    `SELECT discord_user_id FROM discord_daily_subscribers
      WHERE guild_id = $1 AND (last_sent_on IS NULL OR last_sent_on < $2::date)
      ORDER BY subscribed_at LIMIT ${PER_TICK}`,
    [guildId, utcDay(now)],
  );
  let handled = 0;
  for (const row of due.rows) {
    await deliverDailyCode(db, client, api, siteUrl, guildId, row.discord_user_id, now);
    handled += 1;
    if (spacingMs > 0) await new Promise((resolve) => setTimeout(resolve, spacingMs));
  }
  return handled;
}

/** Runs the sender every minute for the life of the process. A failed pass is logged, not fatal. */
export function startDailySender(
  db: Database,
  client: Client,
  api: PlatformApi | null,
  siteUrl: string,
  guildId: string,
  onError: (error: unknown) => void,
): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    runDailySender(db, client, api, siteUrl, guildId)
      .catch(onError)
      .finally(() => {
        running = false;
      });
  }, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}

// ── commands ───────────────────────────────────────────────────────────────

const unavailable = () =>
  bad('Not available', 'The connection to the site is not set up, so codes cannot be redeemed.');

/** `/daily on | off | status`. */
export async function dailyCommand(
  db: Database,
  client: Client,
  api: PlatformApi | null,
  siteUrl: string,
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.editReply({ embeds: [bad('Server only', 'Run this inside the server.')] });
    return;
  }
  const settings = await guildSettings(db, guildId);
  const sub = interaction.options.getSubcommand();
  const userId = interaction.user.id;

  if (sub === 'off') {
    const removed = await unsubscribe(db, guildId, userId);
    await interaction.editReply({
      embeds: [
        embed(
          removed ? 'Daily codes off' : 'Already off',
          removed
            ? 'No more codes. Turn them back on any time with `/daily on`.'
            : 'You were not subscribed.',
          COLOR.quiet,
        ),
      ],
    });
    return;
  }

  if (sub === 'status') {
    const row = await db.query<{ last_sent_on: string | null }>(
      'SELECT last_sent_on::text FROM discord_daily_subscribers WHERE guild_id = $1 AND discord_user_id = $2',
      [guildId, userId],
    );
    if (!row.rows[0]) {
      await interaction.editReply({
        embeds: [
          embed('Daily codes', 'You are not subscribed. Run `/daily on` to start.', COLOR.quiet),
        ],
      });
      return;
    }
    const today = await db.query<{ redeemed_at: Date | null; prize_minor: string | null }>(
      `SELECT redeemed_at, prize_minor::text FROM discord_daily_codes
        WHERE guild_id = $1 AND discord_user_id = $2 AND issued_on = $3::date`,
      [guildId, userId, utcDay(new Date())],
    );
    const code = today.rows[0];
    const todayLine = !code
      ? 'No code yet today.'
      : code.redeemed_at
        ? `Today’s code is used (${formatMoney(BigInt(code.prize_minor ?? '0'))}).`
        : 'Today’s code is in your DMs and not used yet.';
    await interaction.editReply({
      embeds: [
        ok(
          'Daily codes: on',
          `${todayLine}\nA new code comes at ${String(settings.daily_codes_hour).padStart(2, '0')}:00 UTC.` +
            (settings.daily_codes_enabled ? '' : '\n_Sending is switched off at the moment._'),
        ),
      ],
    });
    return;
  }

  // `on`
  if (!settings.daily_codes_enabled) {
    await interaction.editReply({
      embeds: [
        embed('Not yet', 'Daily codes are not switched on yet. Check back soon.', COLOR.quiet),
      ],
    });
    return;
  }
  const outcome = await subscribe(db, guildId, userId);
  const delivery = await deliverDailyCode(db, client, api, siteUrl, guildId, userId);
  if (delivery === 'closed' || delivery === 'unreachable') {
    // A subscription nobody can read is not kept: they would only fail three days running.
    await unsubscribe(db, guildId, userId);
    await interaction.editReply({
      embeds: [
        bad(
          'Could not DM you',
          'Open your DMs for this server (Server menu → Privacy Settings → Direct Messages), ' +
            'then run `/daily on` again.',
        ),
      ],
    });
    return;
  }
  await interaction.editReply({
    embeds: [
      ok(
        outcome === 'subscribed' ? 'Daily codes on' : 'Daily codes already on',
        (delivery === 'sent'
          ? 'Your first code is in your DMs now. '
          : 'You already had today’s code. ') +
          `A new one comes at ${String(settings.daily_codes_hour).padStart(2, '0')}:00 UTC. ` +
          'Redeem it by replying to the DM, or with `/redeem`.',
      ),
    ],
  });
}

/** `/redeem code:`. */
export async function redeemCommand(
  api: PlatformApi | null,
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!api) {
    await interaction.editReply({ embeds: [unavailable()] });
    return;
  }
  const code = interaction.options.getString('code', true);
  try {
    const result = await api.redeemDailyCode(interaction.user.id, code);
    await interaction.editReply({ embeds: [describeRedeem(result)] });
  } catch {
    await interaction.editReply({
      embeds: [bad('Try again', 'The site did not answer. Your code has not been used.')],
    });
  }
}

// ── redeeming by replying to the DM ────────────────────────────────────────

/** Attempts per member per minute: a code is long and single-use, but nobody needs sixty tries. */
const ATTEMPTS_PER_MINUTE = 8;
const attempts = new Map<string, number[]>();
const lastHelp = new Map<string, number>();
const HELP_EVERY_MS = 5 * 60_000;
const MAX_TRACKED = 5_000;

/** Anyone can DM a bot, so what is remembered about them is capped: stale entries go first. */
function forgetStale(now: number) {
  if (attempts.size + lastHelp.size < MAX_TRACKED) return;
  for (const [id, times] of attempts) {
    if (times.every((time) => now - time >= 60_000)) attempts.delete(id);
  }
  for (const [id, time] of lastHelp) {
    if (now - time >= HELP_EVERY_MS) lastHelp.delete(id);
  }
}

/**
 * A direct message to the bot. A code is redeemed; anything else gets a short pointer, at most once
 * every few minutes, so the bot can never be talked into a reply loop or used to spam.
 */
export async function onDirectMessage(
  api: PlatformApi | null,
  message: Message,
  now: number = Date.now(),
): Promise<void> {
  if (message.author.bot || message.guildId) return;
  const id = message.author.id;
  forgetStale(now);

  const code = normalizeCode(message.content);
  if (!code) {
    const last = lastHelp.get(id);
    if (last !== undefined && now - last < HELP_EVERY_MS) return;
    lastHelp.set(id, now);
    await message.reply({
      embeds: [
        embed(
          'Daily codes',
          'Send me your daily code (eight letters and numbers) to redeem it. To get a code every ' +
            'day, run `/daily on` in the server.',
          COLOR.quiet,
        ),
      ],
    });
    return;
  }

  const recent = (attempts.get(id) ?? []).filter((time) => now - time < 60_000);
  if (recent.length >= ATTEMPTS_PER_MINUTE) {
    attempts.set(id, recent);
    await message.reply({ embeds: [warn('Slow down', 'Try again in a minute.')] });
    return;
  }
  attempts.set(id, [...recent, now]);

  if (!api) {
    await message.reply({ embeds: [unavailable()] });
    return;
  }
  try {
    const result = await api.redeemDailyCode(id, code);
    await message.reply({ embeds: [describeRedeem(result)] });
  } catch {
    await message.reply({
      embeds: [bad('Try again', 'The site did not answer. Your code has not been used.')],
    });
  }
}
