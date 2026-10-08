import {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import { ApiUnavailable, type PlatformApi } from '../api-client.js';
import { COLOR, absolute, bad, embed, formatMoney, warn } from '../ui.js';
import { linkWithCode } from './rewards.js';

/**
 * link.ts — the bridge to donutwin.fun, such as it is.
 *
 * The bot does not decide who owns what. The site mints a one-time code for a signed-in browser
 * (the session proves the account), the member types it into `/link code:` here (Discord proves the
 * snowflake), and the gateway joins the two. The code never comes from this bot, so the bot cannot
 * choose which account a Discord account lands on. `/link` on its own opens a pop-up asking for the
 * code; `/link code:` still takes it directly. The linking itself is in features/rewards.ts.
 * `/profile` is a read.
 */

/** The pop-up `/link` opens, and its one field. */
export const LINK_MODAL_ID = 'link:code';
export const LINK_CODE_FIELD = 'code';

/**
 * How long `/link` waits to learn whether the member is already linked before opening the pop-up
 * anyway. Discord gives an interaction three seconds to answer, and a pop-up has to BE the answer:
 * it cannot follow a deferred reply. A slow site therefore costs a pop-up that the submit then
 * explains, never a command that times out.
 */
const LINKED_CHECK_MS = 1_500;

export function buildLinkModal(): ModalBuilder {
  const code = new TextInputBuilder()
    .setCustomId(LINK_CODE_FIELD)
    .setLabel('Your link code')
    .setPlaceholder('From donutwin.fun/discord: sign in, press Get link code')
    .setStyle(TextInputStyle.Short)
    // The site's codes are eight characters; spaces and dashes in a paste are forgiven.
    .setMinLength(4)
    .setMaxLength(16)
    .setRequired(true);
  return new ModalBuilder()
    .setCustomId(LINK_MODAL_ID)
    .setTitle('Link your DonutWin account')
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(code));
}

export async function showLink(api: PlatformApi | null, interaction: ChatInputCommandInteraction) {
  if (!api) {
    await interaction.reply({
      embeds: [unavailable()],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const profile = await Promise.race([
    api.profile(interaction.user.id).catch(() => null),
    new Promise<null>((resolve) => {
      const timer = setTimeout(() => resolve(null), LINKED_CHECK_MS);
      timer.unref();
    }),
  ]);

  if (profile?.linked) {
    await interaction.reply({
      embeds: [
        embed(
          'Already linked',
          `This Discord account is linked to **${profile.username}**.` +
            (profile.linkedAt ? `\nLinked ${absolute(new Date(profile.linkedAt))}.` : ''),
          COLOR.good,
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.showModal(buildLinkModal());
}

/** The pop-up's answer: the code, handed to the same linking `/link code:` uses. */
export async function submitLinkCode(api: PlatformApi | null, interaction: ModalSubmitInteraction) {
  if (!api) {
    await interaction.reply({ embeds: [unavailable()], flags: MessageFlags.Ephemeral });
    return;
  }
  const code = interaction.fields.getTextInputValue(LINK_CODE_FIELD).trim();
  await linkWithCode(api, interaction, code);
}

/**
 * `/profile` — what the site knows about somebody, minus everything it should not say out loud.
 *
 * The balance is not here and is not one option away: the gateway does not return it. A bot that
 * announces how much money somebody is holding on a gambling site is writing a targeting list.
 */
export async function showProfile(
  api: PlatformApi | null,
  interaction: ChatInputCommandInteraction,
) {
  if (!api) {
    await interaction.reply({ embeds: [unavailable()], flags: MessageFlags.Ephemeral });
    return;
  }

  const target = interaction.options.getUser('member') ?? interaction.user;
  const self = target.id === interaction.user.id;

  // Somebody else's profile is shown to the channel; your own is ephemeral, since asking about
  // yourself is usually checking something rather than showing it off.
  await interaction.deferReply(self ? { flags: MessageFlags.Ephemeral } : {});

  let profile;
  try {
    profile = await api.profile(target.id);
  } catch (error) {
    await interaction.editReply({ embeds: [lookupFailed(error)] });
    return;
  }

  if (!profile.linked) {
    await interaction.editReply({
      embeds: [
        embed(
          'Not linked',
          self
            ? `You have not linked a DonutWin account yet. Run \`/link\`.`
            : `**${target.tag}** has not linked a DonutWin account.`,
          COLOR.quiet,
        ),
      ],
    });
    return;
  }

  const wagered = BigInt(profile.wageredMinor);
  const percent = Math.round(profile.vip.progress.ratio * 100);

  const card = embed(profile.username, undefined)
    .setThumbnail(target.displayAvatarURL())
    .addFields(
      { name: 'VIP', value: profile.vip.current.label, inline: true },
      { name: 'Rakeback', value: `${profile.vip.current.ratePercent}%`, inline: true },
      { name: 'Wagered', value: formatMoney(wagered), inline: true },
    );

  if (profile.vip.next) {
    card.addFields({
      name: `Next · ${profile.vip.next.label}`,
      value: `${bar(profile.vip.progress.ratio)} ${percent}% · ${formatMoney(
        BigInt(profile.vip.progress.remainingMinor),
      )} to go`,
    });
  } else {
    card.addFields({ name: 'Next', value: 'Top of the ladder. There is nothing above this.' });
  }

  card.setFooter({ text: `Playing since ${new Date(profile.memberSince).toDateString()}` });
  await interaction.editReply({ embeds: [card] });
}

/** Ten blocks. Discord has no progress bar, and an embed field is the whole canvas. */
function bar(ratio: number): string {
  const filled = Math.max(0, Math.min(10, Math.round(ratio * 10)));
  return '▰'.repeat(filled) + '▱'.repeat(10 - filled);
}

const unavailable = () =>
  warn(
    'Not available here',
    'This server is not connected to the site lookup. An administrator would need to configure it.',
  );

const lookupFailed = (error: unknown) =>
  error instanceof ApiUnavailable
    ? bad('The site did not answer', error.message)
    : bad('Something went wrong', 'The lookup failed. Try again in a moment.');
