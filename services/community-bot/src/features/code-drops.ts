import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type MessageCreateOptions,
} from 'discord.js';
import type { CodeDrop, PlatformApi } from '../api-client.js';
import { COLOR, bad, embed, formatMoney, ok, relative } from '../ui.js';
import { formatCode, redeemUrl } from './redeem.js';

/**
 * code-drops.ts — a code in the drop channel every two hours (2026-11-11, replacing daily codes).
 *
 * The owner: "the community bot [will] send a code every 2 hours that gives 10m and only 5 ppl can
 * claim it, wager req to withdraw it is 3x and make sure in the code message there is a button to
 * get a role that pings them everytime a code drops."
 *
 * The SITE mints every drop and owns its figures (services/api-gateway/src/lib/code-drops.ts). Each
 * minute this asks for the current one: when told to announce it, it posts it, pinging the role,
 * and reports the message; a failed post is handed back so the next minute tries again. Between
 * drops it keeps the post's "claims left" true, and when a new code drops the last post is marked
 * as over. It cannot claim a code or see a balance.
 */

/** The custom id of the button that gives or takes the code-pings role. */
export const DROP_PING_BUTTON = 'drops:ping';

export const dropPingButton = () =>
  new ButtonBuilder()
    .setCustomId(DROP_PING_BUTTON)
    .setStyle(ButtonStyle.Secondary)
    .setEmoji('🔔')
    .setLabel('Code pings');

/** "every 2 hours", "every hour", "every 45 minutes". */
export function cadence(everyMinutes: number): string {
  if (everyMinutes === 60) return 'every hour';
  if (everyMinutes % 60 === 0) return `every ${everyMinutes / 60} hours`;
  return `every ${everyMinutes} minutes`;
}

export interface DropFacts {
  readonly drop: CodeDrop;
  readonly siteUrl: string;
  readonly roleId: string | null;
  readonly everyMinutes: number;
  readonly nextAt: Date;
  /** A drop whose time is up, shown as over once the next one is out. */
  readonly over?: boolean;
}

/** The post. Pure: nothing here talks to Discord or the platform. */
export function buildDropMessage(facts: DropFacts): MessageCreateOptions & { content?: string } {
  const { drop } = facts;
  const prize = formatMoney(BigInt(drop.prizeMinor));
  const left = Math.max(0, drop.maxClaims - drop.claims);
  const done = facts.over === true || left === 0;
  const wager =
    drop.wagerMultiplier > 0 ? formatMoney(BigInt(drop.prizeMinor) * BigInt(drop.wagerMultiplier)) : null;
  const code = formatCode(drop.code);

  const message = done
    ? embed(
        left === 0 ? `Claimed: ${prize}` : `Over: ${prize}`,
        (left === 0
          ? `All ${drop.maxClaims} claims on this code are gone.`
          : 'This code has expired.') + ` The next code drops ${relative(facts.nextAt)}.`,
        COLOR.quiet,
      ).addFields(
        { name: 'Code', value: `~~\`${code}\`~~`, inline: true },
        { name: 'Claimed', value: `${drop.claims} of ${drop.maxClaims}`, inline: true },
      )
    : embed(
        `Code drop: ${prize}`,
        `The first **${drop.maxClaims}** to redeem it on the site get **${prize}** each.`,
      ).addFields(
        { name: 'Code', value: `\`\`\`${code}\`\`\`` },
        { name: 'Claims left', value: `**${left}** of ${drop.maxClaims}`, inline: true },
        { name: 'Expires', value: relative(new Date(drop.expiresAt)), inline: true },
        {
          name: 'How to claim',
          value:
            'Tap **Redeem on DonutLuxe**: the code is filled in for you. Your Discord has to be ' +
            'linked to your site account (`/link`).' +
            (wager ? ` Wager it ${drop.wagerMultiplier}× (**${wager}**) before withdrawing it.` : ''),
        },
      );
  message.setFooter({
    text: `A new code drops ${cadence(facts.everyMinutes)}. Tap Code pings to be pinged for every one.`,
  });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...(done
      ? []
      : [
          new ButtonBuilder()
            .setStyle(ButtonStyle.Link)
            .setLabel('Redeem on DonutLuxe')
            .setURL(redeemUrl(facts.siteUrl, drop.code)),
        ]),
    dropPingButton(),
  );
  return {
    ...(facts.roleId && !done ? { content: `<@&${facts.roleId}> a new code just dropped` } : {}),
    embeds: [message],
    components: [row],
    // Only the code-pings role is ever pinged, and only by a new drop.
    allowedMentions: { roles: facts.roleId && !done ? [facts.roleId] : [] },
  };
}

export interface CodeDropOptions {
  readonly siteUrl: string;
  readonly channelId: string;
  readonly roleId: string | null;
  readonly onError: (error: unknown, message: string) => void;
}

interface Posted {
  readonly drop: CodeDrop;
  readonly channelId: string;
  readonly messageId: string;
}

/**
 * Asks for the current drop once a minute for the life of the process, posting and updating as
 * the site says. A failed minute is logged, not fatal. Returns a stop function.
 */
export function startCodeDrops(client: Client, api: PlatformApi, options: CodeDropOptions): () => void {
  /** How many claims each post was last shown with, so it is only edited when that changes. */
  const shown = new Map<string, number>();
  let last: Posted | null = null;
  let running = false;

  const editPost = async (posted: Posted, facts: Omit<DropFacts, 'drop'>, drop: CodeDrop) => {
    const channel = await client.channels.fetch(posted.channelId).catch(() => null);
    if (!channel?.isTextBased()) return;
    const message = await channel.messages.fetch(posted.messageId).catch(() => null);
    if (!message) return;
    // An edit never pings: only the post itself does, once.
    const built = buildDropMessage({ ...facts, drop });
    await message.edit({
      embeds: built.embeds ?? [],
      components: built.components ?? [],
      allowedMentions: { parse: [] },
    });
  };

  const tick = async () => {
    const state = await api.codeDropTick();
    if (!state.enabled || !state.drop) return;
    const drop = state.drop;
    const nextAt = new Date(state.nextAt);
    const everyMinutes = Math.max(1, Math.round((nextAt.getTime() - Date.parse(drop.slotStart)) / 60_000));
    const facts = { siteUrl: options.siteUrl, roleId: options.roleId, everyMinutes, nextAt };

    if (state.announce) {
      const channel = await client.channels.fetch(options.channelId).catch(() => null);
      if (!channel?.isTextBased() || !('send' in channel)) {
        await api.codeDropMessage({ dropId: drop.id, failed: true }).catch(() => undefined);
        throw new Error(`The code-drop channel ${options.channelId} cannot be found or is not a text channel`);
      }
      let message;
      try {
        message = await channel.send(buildDropMessage({ ...facts, drop }));
      } catch (error) {
        // Handed back, so the next minute tries again.
        await api.codeDropMessage({ dropId: drop.id, failed: true }).catch(() => undefined);
        throw error;
      }
      await api.codeDropMessage({ dropId: drop.id, channelId: message.channelId, messageId: message.id });
      shown.set(drop.id, drop.claims);
      // The previous drop's post, if this process made it, now reads as over.
      if (last && last.drop.id !== drop.id) {
        const previous = last;
        await editPost(previous, { ...facts, over: true }, previous.drop).catch((error) =>
          options.onError(error, 'marking the last code drop as over failed'),
        );
      }
      last = { drop, channelId: message.channelId, messageId: message.id };
      return;
    }

    // Between drops: keep "claims left" on the post true.
    if (drop.channelId && drop.messageId && shown.get(drop.id) !== drop.claims) {
      const posted = { drop, channelId: drop.channelId, messageId: drop.messageId };
      await editPost(posted, facts, drop);
      shown.set(drop.id, drop.claims);
      last = posted;
    }
  };

  const run = () => {
    if (running) return;
    running = true;
    tick()
      .catch((error) => options.onError(error, 'code drop tick failed'))
      .finally(() => {
        running = false;
      });
  };
  run();
  const timer = setInterval(run, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * The "Code pings" button: gives the role, or takes it back. On a drop post it arrives from the
 * server; on the welcome DM it arrives from a DM, so the member is always looked up in the bot's
 * own server, and only a member can have the role.
 */
export async function onDropPingButton(
  client: Client,
  guildId: string,
  roleId: string | null,
  interaction: ButtonInteraction,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!roleId) {
    await interaction.editReply({ embeds: [bad('Not set up', 'Code pings are not set up yet.')] });
    return;
  }
  const member = await client.guilds.cache
    .get(guildId)
    ?.members.fetch(interaction.user.id)
    .catch(() => null);
  if (!member) {
    await interaction.editReply({
      embeds: [bad('Join the server first', 'Code pings are for members. Join the server, then tap again.')],
    });
    return;
  }
  const has = member.roles.cache.has(roleId);
  try {
    if (has) await member.roles.remove(roleId, 'Code pings off');
    else await member.roles.add(roleId, 'Code pings on');
  } catch {
    await interaction.editReply({
      embeds: [bad('I could not change that', 'My role needs to sit above the code-pings role. Tell an administrator.')],
    });
    return;
  }
  await interaction.editReply({
    embeds: [
      has
        ? embed('Code pings off', 'You will not be pinged for code drops any more. Tap again to turn them back on.', COLOR.quiet)
        : ok('Code pings on', 'You will be pinged every time a code drops. Tap again to turn them off.'),
    ],
  });
}

/**
 * `/daily` and `/daily-invite`, which code drops replaced. Discord keeps a command until it is
 * registered away, so a member who still finds one is told where the codes are now.
 */
export async function dailyRetired(
  interaction: ChatInputCommandInteraction,
  channelId: string,
): Promise<void> {
  await interaction.reply({
    embeds: [
      embed(
        'Daily codes are gone',
        `Codes now drop in <#${channelId}> instead: the first players to redeem each one on the ` +
          'site get the prize. Tap **Code pings** to be pinged every time one drops.',
        COLOR.quiet,
      ),
    ],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(dropPingButton())],
    flags: MessageFlags.Ephemeral,
  });
}
