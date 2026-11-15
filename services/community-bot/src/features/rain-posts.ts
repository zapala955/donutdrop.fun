import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type ButtonInteraction,
  type Client,
  type MessageCreateOptions,
} from 'discord.js';
import type { PlatformApi, RainPost, RainRules } from '../api-client.js';
import { COLOR, bad, embed, formatMoney, ok, relative } from '../ui.js';

/**
 * rain-posts.ts — every Lava Rain announced in the rain channel, pinging the rain role (2026-11-14).
 *
 * The owner: "send messages to the discord channel the id of the channel is 1571305826965131456 and
 * rain ping role id is 1571306576311230624".
 *
 * The SITE opens every drop and owns its figures (services/api-gateway/src/lib/lava-rain.ts). Every
 * few seconds this asks about the current one: when told to announce it, it posts it with the ping
 * and reports the message; a failed post is handed back so the next ask tries again. When the drop
 * pays out, the post is edited to say what it paid. It cannot start, claim or pay a drop.
 *
 * No wager line in the post, as the owner asked of code drops: the site says it.
 */

/** The custom id of the button that gives or takes the rain-pings role. */
export const RAIN_PING_BUTTON = 'rain:ping';

const ASK_EVERY_MS = 10_000;

export const rainPingButton = () =>
  new ButtonBuilder().setCustomId(RAIN_PING_BUTTON).setStyle(ButtonStyle.Secondary).setEmoji('🔔').setLabel('Rain pings');

/** "3 days", "1 day", "36 hours". */
function hoursText(hours: number): string {
  if (hours % 24 !== 0) return `${hours} hours`;
  const days = hours / 24;
  return days === 1 ? '1 day' : `${days} days`;
}

/** "1 hour", "45 minutes". */
function minutesText(minutes: number): string {
  if (minutes % 60 === 0) return minutes === 60 ? '1 hour' : `${minutes / 60} hours`;
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

/** Who may claim, from the site's live settings. */
export function rulesText(rules: RainRules): string {
  const lines: string[] = [];
  if (rules.tagRequired) lines.push('• Wear the **DonutLuxe** server tag');
  if (BigInt(rules.minDepositMinor) > 0n) {
    lines.push(`• **${formatMoney(BigInt(rules.minDepositMinor))}** deposited in the last ${hoursText(rules.depositWindowHours)}`);
  }
  if (BigInt(rules.minWageredMinor) > 0n) {
    lines.push(`• **${formatMoney(BigInt(rules.minWageredMinor))}** wagered in the last ${minutesText(rules.wagerWindowMinutes)}`);
  }
  return lines.length ? lines.join('\n') : 'Everybody with a site account.';
}

export interface RainFacts {
  readonly rain: RainPost;
  readonly rules: RainRules;
  readonly siteUrl: string;
  readonly roleId: string | null;
}

/** Where a claim is made: the site with the chat open on the rain card. */
export const claimUrl = (siteUrl: string) => `${siteUrl}/?rain=1`;

/** The post. Pure: nothing here talks to Discord or the platform. */
export function buildRainMessage(facts: RainFacts): MessageCreateOptions & { content?: string } {
  const { rain } = facts;
  const pool = formatMoney(BigInt(rain.poolMinor));
  const falling = rain.status === 'open';

  let message;
  if (falling) {
    message = embed(
      `Lava Rain: ${pool}`,
      `**${pool}** is falling. Claim it on the site in the next **${minutesText(rain.claimMinutes)}**: ` +
        'it is split evenly between everyone who does.',
    ).addFields(
      { name: 'Closes', value: relative(new Date(rain.closesAt)), inline: true },
      { name: 'In so far', value: `**${rain.claimants}**`, inline: true },
      { name: 'Who can claim', value: rulesText(facts.rules) },
      {
        name: 'How to claim',
        value: 'Tap **Claim on DonutLuxe**, then **Claim** on the rain card in chat. Your Discord has to be linked to your site account (`/link`).',
      },
    );
  } else if (rain.status === 'settled') {
    const each = formatMoney(BigInt(rain.perClaimMinor ?? '0'));
    message = embed(
      `Lava Rain paid: ${pool}`,
      `Split between **${rain.claimants}** ${rain.claimants === 1 ? 'player' : 'players'}: **${each}** each.`,
      COLOR.good,
    );
  } else {
    message = embed(`Lava Rain over: ${pool}`, 'Nobody claimed this one.', COLOR.quiet);
  }
  message.setFooter({ text: 'Tap Rain pings to be pinged for every Lava Rain.' });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...(falling
      ? [new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Claim on DonutLuxe').setURL(claimUrl(facts.siteUrl))]
      : []),
    rainPingButton(),
  );
  const ping = falling && facts.roleId;
  return {
    ...(ping ? { content: `<@&${facts.roleId}> Lava Rain is falling: ${pool}` } : {}),
    embeds: [message],
    components: [row],
    // Only the rain-pings role is ever pinged, and only by a drop's first post.
    allowedMentions: { roles: ping ? [ping] : [] },
  };
}

export interface RainPostOptions {
  readonly siteUrl: string;
  readonly channelId: string;
  readonly roleId: string | null;
  readonly onError: (error: unknown, message: string) => void;
}

/**
 * Asks about the current drop every ten seconds for the life of the process, posting and editing as
 * the site says. A failed ask is logged, not fatal. Returns a stop function.
 */
export function startRainPosts(client: Client, api: PlatformApi, options: RainPostOptions): () => void {
  /** What each post was last shown as ("open:12", "settled"), so it is only edited when that changes. */
  const shown = new Map<string, string>();
  let running = false;
  const stateOf = (rain: RainPost) => (rain.status === 'open' ? `open:${rain.claimants}` : rain.status);

  const tick = async () => {
    const state = await api.rainTick();
    if (!state.enabled || !state.rain) return;
    const rain = state.rain;
    const facts = { rain, rules: state.rules, siteUrl: options.siteUrl, roleId: options.roleId };

    if (state.announce) {
      const channel = await client.channels.fetch(options.channelId).catch(() => null);
      if (!channel?.isTextBased() || !('send' in channel)) {
        await api.rainMessage({ rainId: rain.id, failed: true }).catch(() => undefined);
        throw new Error(`The rain channel ${options.channelId} cannot be found or is not a text channel`);
      }
      let message;
      try {
        message = await channel.send(buildRainMessage(facts));
      } catch (error) {
        // Handed back, so the next ask tries again.
        await api.rainMessage({ rainId: rain.id, failed: true }).catch(() => undefined);
        throw error;
      }
      await api.rainMessage({ rainId: rain.id, channelId: message.channelId, messageId: message.id });
      shown.set(rain.id, stateOf(rain));
      return;
    }

    // After the post: keep its count true while it falls, and say what it paid once it has.
    if (!rain.channelId || !rain.messageId || shown.get(rain.id) === stateOf(rain)) return;
    const channel = await client.channels.fetch(rain.channelId).catch(() => null);
    if (!channel?.isTextBased()) return;
    const message = await channel.messages.fetch(rain.messageId).catch(() => null);
    if (!message) return;
    const built = buildRainMessage(facts);
    // An edit never pings: only the post itself does, once.
    await message.edit({ content: built.content ?? null, embeds: built.embeds ?? [], components: built.components ?? [], allowedMentions: { parse: [] } });
    shown.set(rain.id, stateOf(rain));
  };

  const run = () => {
    if (running) return;
    running = true;
    tick()
      .catch((error) => options.onError(error, 'rain post tick failed'))
      .finally(() => {
        running = false;
      });
  };
  run();
  const timer = setInterval(run, ASK_EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * The "Rain pings" button: gives the role, or takes it back. Looked up in the bot's own server, so
 * only a member can have the role.
 */
export async function onRainPingButton(
  client: Client,
  guildId: string,
  roleId: string | null,
  interaction: ButtonInteraction,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!roleId) {
    await interaction.editReply({ embeds: [bad('Not set up', 'Rain pings are not set up yet.')] });
    return;
  }
  const member = await client.guilds.cache
    .get(guildId)
    ?.members.fetch(interaction.user.id)
    .catch(() => null);
  if (!member) {
    await interaction.editReply({ embeds: [bad('Join the server first', 'Rain pings are for members. Join the server, then tap again.')] });
    return;
  }
  const has = member.roles.cache.has(roleId);
  try {
    if (has) await member.roles.remove(roleId, 'Rain pings off');
    else await member.roles.add(roleId, 'Rain pings on');
  } catch {
    await interaction.editReply({
      embeds: [bad('I could not change that', 'My role needs to sit above the rain-pings role. Tell an administrator.')],
    });
    return;
  }
  await interaction.editReply({
    embeds: [
      has
        ? embed('Rain pings off', 'You will not be pinged for Lava Rain any more. Tap again to turn them back on.', COLOR.quiet)
        : ok('Rain pings on', 'You will be pinged every time Lava Rain starts. Tap again to turn them off.'),
    ],
  });
}
