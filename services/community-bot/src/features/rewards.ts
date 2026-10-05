import { MessageFlags, type ChatInputCommandInteraction, type User } from 'discord.js';
import { ApiRefused, ApiUnavailable, type PlatformApi } from '../api-client.js';
import { COLOR, bad, embed, formatMoney, ok, relative, warn } from '../ui.js';

/**
 * rewards.ts — what this server pays, and the commands that collect it.
 *
 *   /link <code>  ties this Discord account to the DonutWin account that showed the code, and
 *                 pays the join reward (and the inviter's reward) that the link unlocks.
 *   /tag          today's reward for wearing the server's tag.
 *   /rewards      where you stand.
 *
 * The bot decides nothing about money. It reports who typed what, and whether they wear the tag;
 * the gateway holds every rule (once per account, once per day, the account-age floor, the
 * inviter's daily cap) and is the only thing that can pay. See
 * services/api-gateway/src/lib/discord-rewards.ts.
 */

const SITE = 'https://donutwin.fun/discord';

/**
 * Whether somebody wears THIS server's tag right now.
 *
 * The interaction's user object usually carries the primary guild, but discord.js cannot tell a
 * missing field from "no tag" (both read as null), so a miss is confirmed against a fresh fetch
 * before anybody is told they are not wearing it.
 */
export async function wearsServerTag(user: User, guildId: string): Promise<boolean> {
  const matches = (candidate: User | null) =>
    Boolean(
      candidate?.primaryGuild?.identityEnabled &&
      candidate.primaryGuild.identityGuildId === guildId,
    );
  if (matches(user)) return true;
  const fresh = await user.client.users.fetch(user.id, { force: true }).catch(() => null);
  return matches(fresh);
}

/** `/link` with a code: the link and its rewards. Without one, `showLink` explains the steps. */
export async function linkWithCode(
  api: PlatformApi,
  interaction: ChatInputCommandInteraction,
  code: string,
) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!interaction.guildId) {
    await interaction.editReply({ embeds: [bad('Server only', 'Run this inside the server.')] });
    return;
  }
  try {
    const result = await api.link({
      discordUserId: interaction.user.id,
      discordUsername: interaction.user.username,
      guildId: interaction.guildId,
      code,
    });
    const lines = [`This Discord account is now linked to **${result.username}**.`];
    for (const reward of result.rewards) {
      const amount = formatMoney(BigInt(reward.amountMinor));
      if (reward.kind === 'join')
        lines.push(`🎁 Join reward: **${amount}** added to your balance.`);
      else if (reward.to === 'you')
        lines.push(`📨 Invite reward: **${amount}** for someone you invited.`);
      else lines.push(`📨 Whoever invited you just earned **${amount}**.`);
    }
    if (result.joinSkipped) lines.push(`_${result.joinSkipped}._`);
    lines.push('', 'Wear the server tag and run `/tag` every day for a daily reward.');
    await interaction.editReply({ embeds: [ok('Linked', lines.join('\n'))] });
  } catch (error) {
    await interaction.editReply({ embeds: [failed(error)] });
  }
}

/** `/tag` — today's tag reward. */
export async function claimTag(api: PlatformApi | null, interaction: ChatInputCommandInteraction) {
  if (!api) {
    await interaction.reply({ embeds: [unavailable()], flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!interaction.guildId) {
    await interaction.editReply({ embeds: [bad('Server only', 'Run this inside the server.')] });
    return;
  }
  try {
    const wearing = await wearsServerTag(interaction.user, interaction.guildId);
    const result = await api.claimTag(interaction.user.id, wearing);
    if (result.paid) {
      await interaction.editReply({
        embeds: [
          ok(
            'Tag reward claimed',
            `**${formatMoney(BigInt(result.amountMinor))}** added to **${result.username}**. ` +
              'Come back tomorrow (UTC) for the next one.',
          ),
        ],
      });
      return;
    }
    const next = result.nextAt ? ` Next one ${relative(new Date(result.nextAt))}.` : '';
    await interaction.editReply({
      embeds: [embed('No reward this time', `${result.reason}.${next}`, COLOR.quiet)],
    });
  } catch (error) {
    await interaction.editReply({ embeds: [failed(error)] });
  }
}

/** `/rewards` — what is on offer and what you have collected. */
export async function showRewards(
  api: PlatformApi | null,
  interaction: ChatInputCommandInteraction,
) {
  if (!api) {
    await interaction.reply({ embeds: [unavailable()], flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const status = await api.rewardStatus(interaction.user.id);
    if (!status.enabled) {
      await interaction.editReply({
        embeds: [
          embed('Rewards are off', 'The server rewards are switched off right now.', COLOR.quiet),
        ],
      });
      return;
    }
    const money = (value: string) => formatMoney(BigInt(value));
    const card = embed(
      'Server rewards',
      status.linked
        ? `Linked to **${status.username}**.`
        : `Not linked yet. Get a code at **${SITE}** and run \`/link code:<your code>\`.`,
    ).addFields(
      {
        name: `Join · ${money(status.amounts.joinMinor)}`,
        value: status.join?.claimed ? '✅ Collected' : 'Paid once when you link',
        inline: true,
      },
      {
        name: `Server tag · ${money(status.amounts.tagMinor)}/day`,
        value: status.tag?.claimedToday
          ? `✅ Collected today · ${status.tag.days} day${status.tag.days === 1 ? '' : 's'} so far`
          : 'Wear the tag, then `/tag`',
        inline: true,
      },
      {
        name: `Invites · ${money(status.amounts.inviteMinor)} each`,
        value: status.invites
          ? `${status.invites.rewarded} rewarded · ${money(status.invites.totalMinor)}`
          : 'Paid when someone you invited links',
        inline: true,
      },
    );
    card.setFooter({
      text: `Join and invite rewards need a Discord account at least ${status.minAccountAgeDays} days old.`,
    });
    await interaction.editReply({ embeds: [card] });
  } catch (error) {
    await interaction.editReply({ embeds: [failed(error)] });
  }
}

const unavailable = () =>
  warn(
    'Not available here',
    'This server is not connected to the site. An administrator would need to configure it.',
  );

function failed(error: unknown) {
  if (error instanceof ApiRefused) return bad('Not done', error.message);
  if (error instanceof ApiUnavailable) return bad('The site did not answer', error.message);
  return bad('Something went wrong', 'Try again in a moment.');
}
