import {
  AttachmentBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { ApiRefused, ApiUnavailable, type PlatformApi, type StatsResult } from '../api-client.js';
import { bad, embed, COLOR, warn } from '../ui.js';

/**
 * /stats <player>: a player's DonutSMP stats, as a picture.
 *
 * The owner, 2026-11-17: "players do /stats (player) in the community bot and it shows a players stats
 * in the donutsmp it can be a photo or an embed an photo whould be better". The stats bot runs the
 * server's own /stats in game (services/minecraft-bot), the gateway draws the card
 * (services/api-gateway/src/lib/stats-card.ts), and this posts it. The answer is public, since showing
 * a player's stats is the point; a refusal (a cooldown, the stats bot being offline) goes only to the
 * member who asked, so a busy channel is not filled with them.
 */

const NAME = /^(?:[A-Za-z0-9_]{3,16}|\.[A-Za-z0-9_]{2,15})$/;
/** How long the member is kept waiting for the stats bot, and how often it is asked. */
const WAIT_MS = 45_000;
const POLL_MS = 1_500;

const DONE = new Set(['found', 'not_found', 'failed']);

export async function showStats(api: PlatformApi | null, interaction: ChatInputCommandInteraction): Promise<void> {
  if (!api) {
    await interaction.reply({
      embeds: [warn('Not available here', 'This server is not connected to the site. An administrator would need to configure it.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const player = interaction.options.getString('player', true).trim();
  if (!NAME.test(player)) {
    await interaction.reply({
      embeds: [bad('Not a Minecraft name', 'Use the in-game name, like `teexs`. A Bedrock name keeps its dot, like `.Steve`.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();

  let lookupId: string;
  try {
    lookupId = (await api.statsRequest(player, interaction.user.id)).lookupId;
  } catch (error) {
    await refuse(interaction, refusal(error));
    return;
  }

  let result: StatsResult | undefined;
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    try {
      result = await api.statsResult(lookupId);
    } catch (error) {
      await refuse(interaction, refusal(error));
      return;
    }
    if (DONE.has(result.status)) break;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  if (!result || !DONE.has(result.status)) {
    await refuse(interaction, warn('Still waiting on DonutSMP', 'The stats bot has not answered yet. Try again in a minute.'));
    return;
  }
  if (result.status === 'not_found') {
    await interaction.editReply({
      embeds: [embed('No such player', `DonutSMP has no player called **${escapeMarkdown(player)}**.`, COLOR.quiet)],
    });
    return;
  }
  if (result.status !== 'found' || !result.cardPng) {
    await refuse(interaction, bad('Could not read the stats', 'DonutSMP did not answer in a way the bot could read. Try again in a minute.'));
    return;
  }

  const card = new AttachmentBuilder(Buffer.from(result.cardPng, 'base64'), {
    name: `stats-${result.player.replace(/[^A-Za-z0-9_]/g, '')}.png`,
    description: describe(result),
  });
  await interaction.editReply({ files: [card] });
}

/** The card in words, for a screen reader: the alt text Discord shows under the image. */
function describe(result: StatsResult): string {
  const labels: Record<string, string> = {
    money: 'money', shards: 'shards', kills: 'kills', deaths: 'deaths', playtime: 'playtime',
    blocksPlaced: 'blocks placed', blocksBroken: 'blocks broken',
  };
  const parts = Object.entries(result.stats ?? {}).map(([key, stat]) => `${labels[key] ?? key} ${stat.display}`);
  return `DonutSMP stats for ${result.player}${parts.length ? `: ${parts.join(', ')}` : ''}`.slice(0, 1000);
}

/** The gateway's own sentence for a refusal it explains; a plain apology for anything else. */
function refusal(error: unknown) {
  if (error instanceof ApiRefused) return warn('Not right now', error.message);
  if (error instanceof ApiUnavailable) return bad('The site did not answer', error.message);
  return bad('Something went wrong', 'The lookup failed. Try again in a moment.');
}

/** Takes the public "thinking" message away and tells only the member why. */
async function refuse(interaction: ChatInputCommandInteraction, message: ReturnType<typeof warn>): Promise<void> {
  try {
    await interaction.deleteReply();
    await interaction.followUp({ embeds: [message], flags: MessageFlags.Ephemeral });
  } catch {
    await interaction.editReply({ embeds: [message] }).catch(() => undefined);
  }
}

const escapeMarkdown = (text: string) => text.replace(/([\\*_`~|>])/g, '\\$1');
