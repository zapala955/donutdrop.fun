import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type ChatInputCommandInteraction,
  type EmbedBuilder,
  type GuildMember,
} from 'discord.js';
import type { PlatformApi, Promotions, RewardStatus } from '../api-client.js';
import { guildSettings, type Database, type GuildSettings } from '../db.js';
import { bad, clip, embed, formatMoney, ok } from '../ui.js';
import { dailyOnButton, dailyPitch } from './daily-codes.js';

/**
 * welcome-dm.ts — the one message a new member gets in their DMs.
 *
 * It says four things and stops: where the games are, how to link a Discord account, how to use the
 * server tag, and how to bring friends. Every figure in it is the platform's own (the signup bonus,
 * the join and tag rewards, the invite bonus), read when the message is built; a figure that cannot
 * be read is left out rather than guessed, so the message degrades to the same sentence without a
 * number instead of quoting one that went stale.
 *
 * It is sent once per member, ever (`welcomed_at`, claimed BEFORE the send), never to bots, and a
 * member with closed DMs is simply skipped: that is the ordinary case on a public server, not an
 * error worth a log line. It can be switched off with WELCOME_DM_ENABLED=false.
 */

export interface WelcomeOptions {
  readonly enabled: boolean;
  /** The public address, with no trailing slash. */
  readonly siteUrl: string;
}

export interface WelcomeFacts {
  readonly guildName: string;
  readonly displayName: string;
  readonly siteUrl: string;
  readonly rewards: RewardStatus | null;
  readonly promotions: Promotions | null;
  /** Present when daily codes are on: the message then offers them, with a button. */
  readonly dailyCodes?: { readonly maxPrizeMinor: string | null } | null;
}

/**
 * Whether the welcome message should offer daily codes: the dashboard's switch is on, and the
 * platform has not said it is turned off on its side. The ceiling is the platform's own figure.
 */
export function dailyOffer(
  settings: Pick<GuildSettings, 'daily_codes_enabled'>,
  rewards: RewardStatus | null,
): { readonly maxPrizeMinor: string | null } | null {
  if (!settings.daily_codes_enabled || rewards?.dailyCodes?.enabled === false) return null;
  return { maxPrizeMinor: rewards?.dailyCodes?.maxPrizeMinor ?? null };
}

/** A whole-dollar amount as the site writes it, or null for anything missing, zero or unreadable. */
function amount(minor: string | null | undefined): string | null {
  if (!minor) return null;
  try {
    const value = BigInt(minor);
    return value > 0n ? formatMoney(value) : null;
  } catch {
    return null;
  }
}

export interface WelcomeMessage {
  readonly embeds: EmbedBuilder[];
  readonly components: ActionRowBuilder<ButtonBuilder>[];
}

/** The message itself. Pure: nothing here talks to Discord or the platform. */
export function buildWelcomeDm(facts: WelcomeFacts): WelcomeMessage {
  const site = facts.siteUrl.replace(/\/+$/, '');
  const host = site.replace(/^https?:\/\//, '');
  const signup = amount(facts.promotions?.signupBonus?.amountMinor);
  const invite = amount(facts.promotions?.referral?.bonusMinor);
  const join = amount(facts.rewards?.amounts.joinMinor);
  const tag = amount(facts.rewards?.amounts.tagMinor);
  const rewardsOn = facts.rewards ? facts.rewards.enabled : true;

  const play =
    `**[${host}](${site})** is where the games are: Upgrader, Crash, Mines, Blackjack, Roulette, ` +
    'Coinflip, Mines Duel and more, all played with your DonutSMP money. Log in with your ' +
    'Minecraft name and deposit in game.' +
    (signup ? ` New accounts get **${signup}** free.` : '');

  const age = facts.rewards?.minAccountAgeDays ?? 0;
  const link =
    `Open [${host}/discord](${site}/discord), copy your code and run \`/link\` here in the server.` +
    (rewardsOn && join ? ` Linking pays **${join}**.` : '') +
    (rewardsOn && age > 0 ? ` Your Discord account has to be at least ${age} days old.` : '');

  const tagLine =
    'Set this server’s tag as your own (User Settings → Profiles → Server Tag), ' +
    'then run `/tag` once a day' +
    (rewardsOn && tag ? ` for **${tag}**.` : ' for a reward.');

  const friends =
    'Bring your friends from DonutSMP.' +
    (invite
      ? ` On the site you earn **${invite} per invite** once they have played`
      : ' On the site you earn a bonus per invite once they have played') +
    ` — your link is on [Invite & Earn](${site}/referrals). Here, \`/invites\` shows who you` +
    ' brought and `/invite-leaderboard` ranks everyone.';

  const message = embed(
    `Welcome to ${clip(facts.guildName, 200)}`,
    `Hey ${clip(facts.displayName, 64)}, glad you are here. This is everything you need to get going.`,
  )
    .addFields(
      { name: '🎮 Play', value: clip(play, 1000) },
      { name: '🔗 Link your account', value: clip(link, 1000) },
      { name: '🏷️ Use the server tag', value: clip(tagLine, 1000) },
      { name: '🤝 Invite friends', value: clip(friends, 1000) },
      ...(facts.dailyCodes
        ? [
            {
              name: '🎁 Daily codes',
              value: clip(dailyPitch(facts.dailyCodes.maxPrizeMinor), 1000),
            },
          ]
        : []),
      {
        name: 'ℹ️ Handy',
        value:
          '`/rewards` what you can collect · `/profile` your stats · `/invites` your invites.' +
          ' Need a hand? Open a ticket in the server.',
      },
    )
    .setFooter({ text: 'Automatic message — replies here are not read.' });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...(facts.dailyCodes ? [dailyOnButton()] : []),
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Play now').setURL(site),
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel('Discord rewards')
      .setURL(`${site}/discord`),
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel('Invite & earn')
      .setURL(`${site}/referrals`),
  );
  return { embeds: [message], components: [row] };
}

/** What the platform says is on offer. Either lookup may fail; the message copes with both. */
async function lookups(api: PlatformApi | null, discordUserId: string) {
  if (!api) return { rewards: null, promotions: null };
  const [rewards, promotions] = await Promise.all([
    api.rewardStatus(discordUserId).catch(() => null),
    api.promotions().catch(() => null),
  ]);
  return { rewards, promotions };
}

/** Discord's "cannot send messages to this user": closed DMs, or a block. Expected, not a fault. */
const CANNOT_DM = 50007;
const dmClosed = (error: unknown) =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === CANNOT_DM;

export type WelcomeOutcome = 'sent' | 'closed' | 'skipped';

/**
 * Sends the welcome DM to a member who has just joined.
 *
 * The mark is written first and by one guarded statement, so two joins racing each other send one
 * message, a rejoin sends none, and a closed-DM member is not retried on the next join. If the row
 * does not exist yet (attribution failed) it is created as an unknown arrival, which is what the
 * attribution would have written anyway.
 */
export async function sendWelcomeDm(
  db: Database,
  api: PlatformApi | null,
  member: GuildMember,
  options: WelcomeOptions,
): Promise<WelcomeOutcome> {
  if (!options.enabled || member.user.bot) return 'skipped';
  // The dashboard's switch, read each time so turning it off takes effect on the very next join.
  const settings = await guildSettings(db, member.guild.id);
  if (!settings.welcome_dm_enabled) return 'skipped';

  const claimed = await db.query(
    `INSERT INTO discord_invited_members (guild_id, member_id, source, welcomed_at)
     VALUES ($1, $2, 'unknown', now())
     ON CONFLICT (guild_id, member_id)
     DO UPDATE SET welcomed_at = now() WHERE discord_invited_members.welcomed_at IS NULL
     RETURNING member_id`,
    [member.guild.id, member.id],
  );
  if (claimed.rowCount === 0) return 'skipped';

  const { rewards, promotions } = await lookups(api, member.id);
  const dailyCodes = dailyOffer(settings, rewards);
  try {
    await member.send(
      buildWelcomeDm({
        guildName: member.guild.name,
        displayName: member.displayName,
        siteUrl: options.siteUrl,
        rewards,
        promotions,
        dailyCodes,
      }),
    );
    if (dailyCodes) await markInvited(db, member.guild.id, member.id, 'sent');
    return 'sent';
  } catch (error) {
    if (dmClosed(error)) {
      if (dailyCodes) await markInvited(db, member.guild.id, member.id, 'closed');
      return 'closed';
    }
    throw error;
  }
}

/**
 * Notes that a member has been offered daily codes (the welcome DM did it), so a later
 * `/daily-invite send` skips them. Best effort: a failure here must never turn a delivered welcome
 * into an error.
 */
async function markInvited(
  db: Database,
  guildId: string,
  memberId: string,
  outcome: 'sent' | 'closed',
): Promise<void> {
  await db
    .query(
      `INSERT INTO discord_daily_invites (guild_id, discord_user_id, outcome) VALUES ($1, $2, $3)
       ON CONFLICT (guild_id, discord_user_id) DO NOTHING`,
      [guildId, memberId, outcome],
    )
    .catch(() => undefined);
}

/**
 * Who counts as an owner: the server's owner, the owner of the bot's application (or the owner of
 * its team), anybody listed in COMMUNITY_OWNER_IDS, and anybody added in the admin dashboard.
 * De-duplicated, in that order.
 *
 * Pure, so the rule is testable without a Discord connection.
 */
export function resolveOwners(sources: {
  readonly guildOwnerId: string | null | undefined;
  readonly applicationOwnerIds: readonly string[];
  readonly extra: readonly string[];
}): string[] {
  const all = [sources.guildOwnerId ?? '', ...sources.applicationOwnerIds, ...sources.extra];
  return [...new Set(all.filter((id) => /^[0-9]{5,32}$/.test(id)))];
}

/** The dashboard's list of ids, as the bot compares them: whole ids only, in order, once each. */
export function parseOwnerIds(raw: string | null | undefined): string[] {
  return [
    ...new Set(
      (raw ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter((id) => /^[0-9]{5,32}$/.test(id)),
    ),
  ];
}

/** The person (or the team's owner) behind a Discord application. */
export function applicationOwnerIds(owner: unknown): string[] {
  if (!owner || typeof owner !== 'object') return [];
  const candidate = owner as { id?: string; ownerId?: string | null };
  // A Team has an `ownerId` (its own `id` is the team's, not a person's); a User only has an `id`.
  if ('ownerId' in candidate) return candidate.ownerId ? [candidate.ownerId] : [];
  return candidate.id ? [candidate.id] : [];
}

/**
 * `/test` — sends the welcome message to the OWNERS, and to nobody else.
 *
 * It exists because the real message goes out once per member, so rejoining to look at it sends
 * nothing. It never touches the once-only mark and never messages a member: whoever runs it, the
 * recipients are the owners, and anybody who is not one is told so and nothing is sent. Discord's
 * own permission (Administrator) only hides the command; this check is the lock.
 */
/**
 * The owners as of this moment: the server's owner, the application's owner, the environment's
 * list and the dashboard's list (read now, so a change there is live at once). Shared by every
 * owners-only command, so "who is an owner" has exactly one answer.
 */
export async function currentOwners(
  db: Database,
  interaction: ChatInputCommandInteraction,
  extraOwnerIds: readonly string[],
): Promise<string[]> {
  const guild = interaction.guild;
  if (!guild) return [];
  const application = await interaction.client.application.fetch().catch(() => null);
  const settings = await guildSettings(db, guild.id);
  return resolveOwners({
    guildOwnerId: guild.ownerId,
    applicationOwnerIds: applicationOwnerIds(application?.owner),
    extra: [...extraOwnerIds, ...parseOwnerIds(settings.test_owner_ids)],
  });
}

export async function testWelcomeDm(
  db: Database,
  api: PlatformApi | null,
  interaction: ChatInputCommandInteraction,
  options: WelcomeOptions & { readonly extraOwnerIds: readonly string[] },
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply({ embeds: [bad('Server only', 'Run this inside the server.')] });
    return;
  }
  const settings = await guildSettings(db, guild.id);
  const owners = await currentOwners(db, interaction, options.extraOwnerIds);
  if (!owners.includes(interaction.user.id)) {
    await interaction.editReply({
      embeds: [bad('Owners only', 'Only the server owner can run this test.')],
    });
    return;
  }

  const { rewards, promotions } = await lookups(api, interaction.user.id);
  const message = buildWelcomeDm({
    guildName: guild.name,
    displayName: interaction.user.displayName,
    siteUrl: options.siteUrl,
    rewards,
    promotions,
    dailyCodes: dailyOffer(settings, rewards),
  });

  const reached: string[] = [];
  const closed: string[] = [];
  for (const id of owners) {
    try {
      const user = await interaction.client.users.fetch(id);
      await user.send({
        content: '**Test** \u2014 this is the message a new member gets in their DMs.',
        ...message,
      });
      reached.push(id);
    } catch (error) {
      if (!dmClosed(error)) throw error;
      closed.push(id);
    }
  }

  const lines = [
    reached.length
      ? `Sent to ${reached.map((id) => `<@${id}>`).join(', ')}.`
      : 'Nobody could be reached.',
  ];
  if (closed.length) {
    lines.push(`Their DMs are closed: ${closed.map((id) => `<@${id}>`).join(', ')}.`);
  }
  if (!options.enabled) {
    lines.push('Note: the real welcome DM is switched off (WELCOME_DM_ENABLED=false).');
  }
  await interaction.editReply({
    embeds: [(reached.length ? ok : bad)('Test DM', lines.join('\n'))],
  });
}
