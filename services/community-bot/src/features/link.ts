import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import { ApiUnavailable, type PlatformApi } from '../api-client.js';
import { COLOR, bad, embed, formatMoney, warn } from '../ui.js';

/**
 * link.ts — `/profile`, what the site knows about a member.
 *
 * `/link` is in rewards.ts now. Linking itself moved to the site on 2026-10-22: the member presses
 * Link Discord on donutluxe.com/discord and authorizes the app, so Discord proves the snowflake and
 * the session proves the account with nobody in between. It used to run through here, from a
 * one-time code the site minted and the member typed into a pop-up. One Discord may carry several
 * accounts (alts); features/accounts.ts lists them and picks the main one.
 */

/**
 * `/profile` — what the site knows about somebody, minus everything it should not say out loud.
 *
 * The balance is not here and is not one option away: the gateway does not return it. A bot that
 * announces how much money somebody is holding on a gambling site is writing a targeting list.
 *
 * Nor is somebody else's Minecraft name. The gateway masks it (`x********`, as on the site) unless
 * the member asking is the member asked about, so a public lookup cannot undo the site's masking.
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
    profile = await api.profile(target.id, interaction.user.id);
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
            ? `You have not linked a DonutLuxe account yet. Run \`/link\`.`
            : `**${target.tag}** has not linked a DonutLuxe account.`,
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
