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
import type { Database } from '../db.js';
import { bad, clip, embed, formatMoney, ok } from '../ui.js';

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
      {
        name: 'ℹ️ Handy',
        value:
          '`/rewards` what you can collect · `/profile` your stats · `/invites` your invites.' +
          ' Need a hand? Open a ticket in the server.',
      },
    )
    .setFooter({ text: 'Automatic message — replies here are not read.' });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
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
  try {
    await member.send(
      buildWelcomeDm({
        guildName: member.guild.name,
        displayName: member.displayName,
        siteUrl: options.siteUrl,
        rewards,
        promotions,
      }),
    );
    return 'sent';
  } catch (error) {
    if (dmClosed(error)) return 'closed';
    throw error;
  }
}

/**
 * `/welcome-preview` — shows a manager exactly what a new member receives.
 *
 * Needed because the real thing fires once per member: rejoining to look at it would not send it
 * again, by design. It goes to the manager's own DMs and falls back to an ephemeral copy in the
 * channel when those are closed.
 */
export async function previewWelcomeDm(
  api: PlatformApi | null,
  interaction: ChatInputCommandInteraction,
  options: WelcomeOptions,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply({ embeds: [bad('Server only', 'Run this inside the server.')] });
    return;
  }
  const { rewards, promotions } = await lookups(api, interaction.user.id);
  const message = buildWelcomeDm({
    guildName: guild.name,
    displayName: interaction.user.displayName,
    siteUrl: options.siteUrl,
    rewards,
    promotions,
  });
  try {
    await interaction.user.send(message);
    await interaction.editReply({
      embeds: [
        ok(
          'Sent',
          'The welcome message is in your DMs.' +
            (options.enabled ? '' : ' Note: it is switched off (WELCOME_DM_ENABLED=false).'),
        ),
      ],
    });
  } catch (error) {
    if (!dmClosed(error)) throw error;
    await interaction.editReply({
      content: 'Your DMs are closed, so here is the message instead:',
      ...message,
    });
  }
}
