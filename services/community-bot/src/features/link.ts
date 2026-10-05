import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import { ApiUnavailable, type PlatformApi } from '../api-client.js';
import { COLOR, absolute, bad, embed, formatMoney, warn } from '../ui.js';

/**
 * link.ts — the bridge to donutwin.fun, such as it is.
 *
 * The bot does not decide who owns what. The site mints a one-time code for a signed-in browser
 * (the session proves the account), the member types it into `/link code:` here (Discord proves the
 * snowflake), and the gateway joins the two. The code never comes from this bot, so the bot cannot
 * choose which account a Discord account lands on. Without a code, `/link` is a signpost; the
 * linking itself is in features/rewards.ts. `/profile` is a read.
 */

const LINK_PAGE = 'https://donutwin.fun/discord';

export async function showLink(api: PlatformApi | null, interaction: ChatInputCommandInteraction) {
  if (!api) {
    await interaction.reply({
      embeds: [unavailable()],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let profile;
  try {
    profile = await api.profile(interaction.user.id);
  } catch (error) {
    await interaction.editReply({ embeds: [lookupFailed(error)] });
    return;
  }

  if (profile.linked) {
    await interaction.editReply({
      embeds: [
        embed(
          'Already linked',
          `This Discord account is linked to **${profile.username}**.` +
            (profile.linkedAt ? `\nLinked ${absolute(new Date(profile.linkedAt))}.` : ''),
          COLOR.good,
        ),
      ],
    });
    return;
  }

  await interaction.editReply({
    embeds: [
      embed(
        'Link your account',
        [
          `1. Sign in at **${LINK_PAGE}**`,
          '2. Press **Get link code**',
          '3. Run `/link code:<the code>` here',
          '',
          'The code is shown to you on the site and works once, for ten minutes. Never paste ' +
            'somebody else’s code, and never give yours away: anyone who asks for it is not staff.',
        ].join('\n'),
      ),
    ],
  });
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
