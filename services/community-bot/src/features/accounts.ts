import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import { ApiRefused, ApiUnavailable, type PlatformApi } from '../api-client.js';
import { COLOR, bad, clip, embed, ok, relative, warn } from '../ui.js';

/**
 * accounts.ts — `/accounts`: the DonutLuxe accounts linked to your Discord.
 *
 * One Discord may carry several site accounts (a main Minecraft account and its alts). All of them
 * can be signed in to with "Log in with Discord" on the site; the MAIN one is the account this bot
 * acts for, because a command here has a Discord in hand and nothing else to choose by: `/tag` pays
 * it, `/profile` and `/rewards` show it.
 *
 *   /accounts list              every linked account, main first
 *   /accounts main account:     make one of them the main account
 *   /accounts unlink account:   take one off this Discord (frees a slot for another)
 *
 * Every answer is ephemeral: a member's alts are their business, not the channel's. The member can
 * only ever touch accounts on their own Discord -- the gateway is told the interaction's Discord,
 * never one the member types -- and the rules (the limit, which account becomes main after an
 * unlink) live in services/api-gateway/src/lib/discord-accounts.ts.
 */

export async function handleAccounts(
  api: PlatformApi | null,
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!api) {
    await interaction.reply({
      embeds: [
        warn(
          'Not available here',
          'This server is not connected to the site. An administrator would need to configure it.',
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const sub = interaction.options.getSubcommand();
  try {
    if (sub === 'main') {
      const name = interaction.options.getString('account', true).trim();
      const result = await api.setMainAccount(interaction.user.id, name);
      await interaction.editReply({
        embeds: [
          ok(
            'Main account changed',
            `**${result.username}** is now your main account: \`/tag\` pays it, and \`/profile\` and ` +
              '`/rewards` show it. Every linked account can still log in with Discord on the site.',
          ),
        ],
      });
      return;
    }
    if (sub === 'unlink') {
      const name = interaction.options.getString('account', true).trim();
      const result = await api.unlinkAccount(interaction.user.id, name);
      const lines = [`**${result.unlinked}** is no longer linked to this Discord.`];
      if (result.newMain) lines.push(`**${result.newMain}** is your main account now.`);
      lines.push(
        '',
        'Rewards it already collected stay on it. This Discord’s join reward stays claimed.',
      );
      await interaction.editReply({ embeds: [ok('Unlinked', lines.join('\n'))] });
      return;
    }
    await interaction.editReply({ embeds: [await listCard(api, interaction.user.id)] });
  } catch (error) {
    await interaction.editReply({ embeds: [failed(error)] });
  }
}

async function listCard(api: PlatformApi, discordUserId: string) {
  const { max, accounts } = await api.accounts(discordUserId);
  if (!accounts.length) {
    return embed(
      'No accounts linked',
      'Sign in at donutluxe.com, open the Discord page, press **Link Discord** and authorize the app.',
      COLOR.quiet,
    );
  }
  const lines = accounts.map((account) => {
    const tags = [
      account.main ? '⭐ main' : null,
      account.active ? null : 'unavailable',
      account.lastLoginAt ? `last on ${relative(new Date(account.lastLoginAt))}` : null,
    ].filter(Boolean);
    return `**${clip(account.username, 32)}**${tags.length ? ` · ${tags.join(' · ')}` : ''}`;
  });
  lines.push(
    '',
    `${accounts.length} of ${max} accounts. ` +
      (accounts.length < max
        ? 'To add another: sign in to it on the site and press Link Discord on the Discord page.'
        : 'That is the most one Discord may carry; `/accounts unlink` frees a slot.'),
    '`/accounts main` picks which one `/tag` pays. All of them can log in with Discord on the site.',
  );
  return embed('Your linked accounts', lines.join('\n'), COLOR.brand);
}

function failed(error: unknown) {
  if (error instanceof ApiRefused) return bad('Not done', error.message);
  if (error instanceof ApiUnavailable) return bad('The site did not answer', error.message);
  return bad('Something went wrong', 'Try again in a moment.');
}
