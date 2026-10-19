import { randomInt, randomUUID } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type EmbedBuilder,
  type Message,
} from 'discord.js';
import type { PlatformApi } from '../api-client.js';
import { guildSettings, type Database } from '../db.js';
import { COLOR, bad, embed, formatMoney, ok } from '../ui.js';

/**
 * daily-codes.ts — a personal code in your DMs every day, redeemed for a prize.
 *
 * A member opts in with `/daily on`. Once a day (at the hour the dashboard sets, UTC) the bot DMs
 * them a one-use code. They redeem it ON THE SITE, in a window the DM's button opens with the code
 * already filled in, for a random prize from nothing up to a ceiling the operator sets.
 *
 * The bot ISSUES and DELIVERS codes and nothing else. It cannot redeem one: which prize a code is
 * worth, whether it is still valid, whether the account may redeem, and the payment itself are all
 * the gateway's (services/api-gateway/src/lib/daily-codes.ts), asked by a signed-in player on the
 * site. The bot has no wallet access and no way to spend a code, so a code that leaks from a DM is
 * still only worth something to the site account linked to that Discord.
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
  /** The day's wagering bar, or null/absent when there is none or it could not be read. */
  readonly minWagerMinor?: string | null | undefined;
}

/**
 * The day's wagering bar as a figure, or null when there is none. Nothing is said about a bar the
 * platform did not report: a message that promises "wager $0" or a made-up number is worse than one
 * that stays silent.
 */
function barText(minWagerMinor: string | null | undefined): string | null {
  try {
    if (minWagerMinor && BigInt(minWagerMinor) > 0n) return formatMoney(BigInt(minWagerMinor));
  } catch {
    /* an unreadable figure is left out, not guessed */
  }
  return null;
}

/** The welcome prize (a first code's floor) as a figure, or null when it is off or unknown. */
const welcomeText = (firstPrizeMinor: string | null | undefined) => barText(firstPrizeMinor);

/** The ceiling as a figure, or plain words when the platform could not say. Never a guess. */
function ceilingText(maxPrizeMinor: string | null): string {
  try {
    if (maxPrizeMinor && BigInt(maxPrizeMinor) > 0n) return formatMoney(BigInt(maxPrizeMinor));
  } catch {
    /* an unreadable figure is left out, not guessed */
  }
  return 'a big prize';
}

/**
 * Where a code is redeemed: the site, with the code in the URL's FRAGMENT. A fragment never leaves
 * the browser, so the code reaches neither the site's logs nor Cloudflare's; the page reads it,
 * fills the redeem window and clears it from the address bar.
 */
export const redeemUrl = (siteUrl: string, code?: string) =>
  `${siteUrl.replace(/\/+$/, '')}/${code ? `#redeem=${code}` : ''}`;

/** How to redeem, step by step. With a bar, the first step is meeting it. */
export function redeemSteps(minWagerMinor?: string | null): string {
  const bar = barText(minWagerMinor);
  const steps = [
    ...(bar
      ? [
          `Wager **${bar}** on the site today. That unlocks the code; the window shows your progress.`,
        ]
      : []),
    'Tap **Redeem on the site** below. The code is already filled in.',
    'Log in with your Minecraft name if you are not already, then press **Redeem**.',
  ];
  return (
    steps.map((step, index) => `${index + 1}. ${step}`).join('\n') +
    '\nNo button? Open the site, open the account menu and choose **Daily code**.'
  );
}

export function buildCodeDm(facts: DailyCodeFacts) {
  const ceiling = ceilingText(facts.maxPrizeMinor);
  const message = embed(
    'Your daily code',
    `Redeem it on the site for a prize from nothing up to **${ceiling}**.`,
  )
    .addFields(
      { name: 'Code', value: `\`\`\`${formatCode(facts.code)}\`\`\`` },
      { name: 'How to redeem', value: redeemSteps(facts.minWagerMinor) },
      {
        name: 'Good to know',
        value:
          'It works once and for 24 hours, and only on the site account linked to this Discord ' +
          '(`/link`). ' +
          (barText(facts.minWagerMinor)
            ? 'Wagering counts from 00:00 UTC on the day the code arrives, so play from earlier ' +
              'today counts too. '
            : '') +
          'A prize is playable at once and can be withdrawn after it has been wagered. ' +
          'Stop these any time with `/daily off`.',
      },
    )
    .setFooter({ text: 'One code a day. Codes are redeemed on the site only.' });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel('Redeem on the site')
      .setURL(redeemUrl(facts.siteUrl, facts.code)),
  );
  return { embeds: [message], components: [row] };
}

// ── the invitation ─────────────────────────────────────────────────────────

/** The custom id of the "Get my daily code" button on the welcome DM and the invitation. */
export const DAILY_ON_BUTTON = 'daily:on';

export const dailyOnButton = () =>
  new ButtonBuilder()
    .setCustomId(DAILY_ON_BUTTON)
    .setStyle(ButtonStyle.Success)
    .setLabel('Get my daily code');

/** The one-line offer, shared by the welcome DM and the invitation so they never disagree. */
export function dailyPitch(
  maxPrizeMinor: string | null,
  minWagerMinor?: string | null,
  firstPrizeMinor?: string | null,
): string {
  const bar = barText(minWagerMinor);
  const welcome = welcomeText(firstPrizeMinor);
  return (
    'A personal code in your DMs every day, worth anything from nothing up to ' +
    `**${ceilingText(maxPrizeMinor)}**. ` +
    (welcome ? `Your first one is worth at least **${welcome}**. ` : '') +
    (bar ? `Wager **${bar}** on the site that day to unlock it. ` : '') +
    'Tap **Get my daily code** or run `/daily on`.'
  );
}

export interface DailyInviteFacts {
  readonly siteUrl: string;
  /** The ceiling the operator has set, or null when the platform could not be asked. */
  readonly maxPrizeMinor: string | null;
  /** The day's wagering bar, or null/absent when there is none or it could not be read. */
  readonly minWagerMinor?: string | null | undefined;
  /** The welcome prize, or null/absent when it is off or could not be read. */
  readonly firstPrizeMinor?: string | null | undefined;
}

/** The first message a member gets about daily codes: what it is, and a button that turns it on. */
export function buildDailyInviteDm(facts: DailyInviteFacts) {
  const welcome = welcomeText(facts.firstPrizeMinor);
  const message = embed(
    'A free code in your DMs, every day',
    'Turn on daily codes and I will send you one personal code a day. Redeem it for a prize from ' +
      `nothing up to **${ceilingText(facts.maxPrizeMinor)}**, playable on the site straight away.` +
      (welcome ? ` Your first code is worth at least **${welcome}**.` : ''),
  )
    .addFields(
      {
        name: 'How it works',
        value:
          '1. Tap **Get my daily code** below, or run `/daily on` in the server.\n' +
          '2. Your first code arrives here at once.\n' +
          (barText(facts.minWagerMinor)
            ? `3. Wager **${barText(facts.minWagerMinor)}** on the site that day: that unlocks it.\n` +
              '4. Redeem it on the site: tap **Redeem on the site** on that message.'
            : '3. Redeem it on the site: tap **Redeem on the site** on that message.'),
      },
      {
        name: 'Good to know',
        value:
          'Link your Discord to your site account with `/link` before a code can pay out. A prize ' +
          'can be withdrawn once it has been wagered. One code a day, and you can stop any time ' +
          'with `/daily off`.',
      },
    )
    .setFooter({ text: 'You only get this message once.' });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    dailyOnButton(),
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel('Open the site')
      .setURL(facts.siteUrl.replace(/\/+$/, '')),
  );
  return { embeds: [message], components: [row] };
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
    minWagerMinor: status?.dailyCodes?.minWagerMinor ?? null,
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
  await interaction.editReply({
    embeds: [await enableDaily(db, client, api, siteUrl, guildId, userId)],
  });
}

/**
 * Turns daily codes on for one member and sends their first code at once. The same thing whether
 * they typed `/daily on` or tapped the button on the welcome DM or the invitation, so the two can
 * never drift apart. Returns the reply to show them.
 */
export async function enableDaily(
  db: Database,
  client: Client,
  api: PlatformApi | null,
  siteUrl: string,
  guildId: string,
  userId: string,
): Promise<EmbedBuilder> {
  const settings = await guildSettings(db, guildId);
  if (!settings.daily_codes_enabled) {
    return embed('Not yet', 'Daily codes are not switched on yet. Check back soon.', COLOR.quiet);
  }
  const outcome = await subscribe(db, guildId, userId);
  const delivery = await deliverDailyCode(db, client, api, siteUrl, guildId, userId);
  if (delivery === 'closed' || delivery === 'unreachable') {
    // A subscription nobody can read is not kept: they would only fail three days running.
    await unsubscribe(db, guildId, userId);
    return bad(
      'Could not DM you',
      'Open your DMs for this server (Server menu → Privacy Settings → Direct Messages), ' +
        'then try again.',
    );
  }
  return ok(
    outcome === 'subscribed' ? 'Daily codes on' : 'Daily codes already on',
    (delivery === 'sent'
      ? 'Your first code is in your DMs now. '
      : 'You already had today’s code. ') +
      `A new one comes at ${String(settings.daily_codes_hour).padStart(2, '0')}:00 UTC. ` +
      'Redeem it on the site with the button on that message.',
  );
}

/**
 * The "Get my daily code" button. It lives in a DM, so there is no guild on the interaction: the
 * bot's own server is used, and only somebody who is still a member of it can turn codes on.
 */
export async function onDailyButton(
  db: Database,
  client: Client,
  api: PlatformApi | null,
  siteUrl: string,
  guildId: string,
  interaction: ButtonInteraction,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const member = await client.guilds.cache
    .get(guildId)
    ?.members.fetch(interaction.user.id)
    .catch(() => null);
  if (!member) {
    await interaction.editReply({
      embeds: [
        bad(
          'Join the server first',
          'Daily codes are for members. Join the server, then tap again.',
        ),
      ],
    });
    return;
  }
  await interaction.editReply({
    embeds: [await enableDaily(db, client, api, siteUrl, guildId, interaction.user.id)],
  });
}

// ── a reply to the DM ──────────────────────────────────────────────────────

/** One pointer per member every few minutes: a bot that answers every message can be made to spam. */
const lastHelp = new Map<string, number>();
const HELP_EVERY_MS = 5 * 60_000;
const MAX_TRACKED = 5_000;

/** Anyone can DM a bot, so what is remembered about them is capped: stale entries go first. */
function forgetStale(now: number) {
  if (lastHelp.size < MAX_TRACKED) return;
  for (const [id, time] of lastHelp) {
    if (now - time >= HELP_EVERY_MS) lastHelp.delete(id);
  }
}

/**
 * A direct message to the bot. Codes are redeemed on the site, so whatever is sent, a code or a
 * question, gets the same short pointer, at most once every few minutes, so the bot can never be
 * talked into a reply loop or used to spam. Nothing is spent or read beyond "is this a code":
 * that only decides whether the button carries it.
 */
export async function onDirectMessage(
  message: Message,
  siteUrl: string,
  now: number = Date.now(),
): Promise<void> {
  if (message.author.bot || message.guildId) return;
  const id = message.author.id;
  forgetStale(now);
  const last = lastHelp.get(id);
  if (last !== undefined && now - last < HELP_EVERY_MS) return;
  lastHelp.set(id, now);

  const code = normalizeCode(message.content);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel(code ? 'Redeem on the site' : 'Open the site')
      .setURL(redeemUrl(siteUrl, code ?? undefined)),
  );
  await message.reply({
    embeds: [
      embed(
        code ? 'Redeem it on the site' : 'Daily codes',
        code
          ? 'That looks like a daily code. Codes are redeemed on the site, not here: tap the ' +
              'button and it is filled in for you.'
          : 'Codes are redeemed on the site, in the **Daily code** window (account menu). To get ' +
              'a code every day, run `/daily on` in the server.',
        COLOR.quiet,
      ),
    ],
    components: [row],
  });
}
