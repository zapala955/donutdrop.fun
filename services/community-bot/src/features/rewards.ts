import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type ChatInputCommandInteraction,
  type User,
} from 'discord.js';
import { ApiRefused, ApiUnavailable, type PlatformApi, type RewardStatus } from '../api-client.js';
import { COLOR, bad, embed, formatMoney, ok, relative, warn } from '../ui.js';
import { watchTag } from './tag-watch.js';

/**
 * rewards.ts — what this server pays, and the commands that collect it.
 *
 *   /link         linking happens on the site (authorize the app); here a linked member collects
 *                 the join reward, and anybody else gets a button to the site.
 *   /tag          the reward for wearing the server's tag: the first at once, then one for every
 *                 24 hours it stays on.
 *   /rewards      where you stand.
 *
 * The bot decides nothing about money. It reports who typed what, and whether they wear the tag;
 * the gateway holds every rule (once per account, 24 hours straight between tag rewards, the
 * account-age floor) and is the only thing that can pay. See
 * services/api-gateway/src/lib/discord-rewards.ts, and tag-watch.ts for how the 24 hours are seen.
 */

const SITE = 'https://donutluxe.com/discord';

/** Whether this user object shows THIS server's tag. */
export function showsServerTag(
  candidate: Pick<User, 'primaryGuild'> | null | undefined,
  guildId: string,
): boolean {
  return Boolean(
    candidate?.primaryGuild?.identityEnabled && candidate.primaryGuild.identityGuildId === guildId,
  );
}

/**
 * Whether somebody wears THIS server's tag right now.
 *
 * The interaction's user object usually carries the primary guild, but discord.js cannot tell a
 * missing field from "no tag" (both read as null), so a miss is confirmed against a fresh fetch
 * before anybody is told they are not wearing it.
 */
export async function wearsServerTag(user: User, guildId: string): Promise<boolean> {
  if (showsServerTag(user, guildId)) return true;
  const fresh = await user.client.users.fetch(user.id, { force: true }).catch(() => null);
  return showsServerTag(fresh, guildId);
}

/**
 * `/link`. Linking itself happens on the site, by authorizing the app, so a member who is not linked
 * gets a button to the Discord page. A member who is linked collects the join reward here if it is
 * still due: running a command in this server is the membership that reward is for.
 */
export async function linkFromServer(
  api: PlatformApi | null,
  interaction: ChatInputCommandInteraction,
) {
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
    const result = await api.joinReward({
      discordUserId: interaction.user.id,
      guildId: interaction.guildId,
    });
    if (!result.linked) {
      await interaction.editReply({
        embeds: [
          embed(
            'Link your DonutLuxe account',
            'Linking happens on the site: sign in at **donutluxe.com**, open the Discord page, press ' +
              '**Link Discord** and authorize the app. Then run `/link` here again to collect the ' +
              'join reward.',
            COLOR.quiet,
          ),
        ],
        components: [siteButton()],
      });
      return;
    }
    const lines = [`This Discord account is linked to **${result.username}**.`];
    if (result.paidMinor) {
      lines.push(`🎁 Join reward: **${formatMoney(BigInt(result.paidMinor))}** added to your balance.`);
    } else if (result.skipped) {
      lines.push(`_${result.skipped}._`);
    }
    lines.push(
      '',
      'Wear the server tag and run `/tag`: the first reward is yours straight away, then one for ' +
        'every 24 hours you keep the tag on.',
    );
    await interaction.editReply({ embeds: [ok('Linked', lines.join('\n'))] });
  } catch (error) {
    await interaction.editReply({ embeds: [failed(error)] });
  }
}

/** A link button to the site's Discord page, where the account is linked. */
function siteButton(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setLabel('Open the Discord page').setStyle(ButtonStyle.Link).setURL(SITE),
  );
}

/** `/tag` — the tag reward, if it is due. */
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
      // Watched from now, not from the next sweep, so the next 24 hours are seen from the start.
      watchTag(interaction.user.id);
      await interaction.editReply({
        embeds: [
          ok(
            'Tag reward claimed',
            `**${formatMoney(BigInt(result.amountMinor))}** added to **${result.username}**. ` +
              `Keep the tag on: the next one opens ${relative(new Date(Date.now() + 86_400_000))}. ` +
              'Taking it off starts the 24 hours again.',
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
        : `Not linked yet. Open **${SITE}**, press Link Discord and authorize the app.`,
    ).addFields(
      {
        name: `Join · ${money(status.amounts.joinMinor)}`,
        value: status.join?.claimed ? '✅ Collected' : 'Paid once when you link',
        inline: true,
      },
      {
        name: `Server tag · ${money(status.amounts.tagMinor)} per 24h worn`,
        value: tagLine(status.tag),
        inline: true,
      },
    );
    card.setFooter({
      text: `The join reward needs a Discord account at least ${status.minAccountAgeDays} days old.`,
    });
    await interaction.editReply({ embeds: [card] });
  } catch (error) {
    await interaction.editReply({ embeds: [failed(error)] });
  }
}

/** Where somebody stands on the tag reward, in one line. */
function tagLine(tag: RewardStatus['tag']): string {
  if (!tag || tag.days === 0) return 'Wear the tag, then `/tag`: the first one is instant';
  const count = `${tag.days} collected`;
  if (tag.nextAt) {
    const next = new Date(tag.nextAt);
    return next.getTime() <= Date.now()
      ? `✅ Ready now: run \`/tag\` · ${count}`
      : `Next one ${relative(next)} if the tag stays on · ${count}`;
  }
  return `Put the tag on: the next one needs 24 hours straight · ${count}`;
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
