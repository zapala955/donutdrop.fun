import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
  type TextChannel,
} from 'discord.js';
import { COLOR, absolute, bad, clip, embed, humanDuration, ok, relative } from '../ui.js';

/**
 * utility.ts — the small commands a server ends up installing a second bot for.
 *
 * None of these touch the database. They read what Discord already knows and render it, which is
 * why they are grouped together: nothing here can fail in a way that needs recovering from.
 */

const POLL_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'] as const;

export async function userInfo(interaction: ChatInputCommandInteraction) {
  const target = interaction.options.getMember('member') ?? interaction.member;
  const user = interaction.options.getUser('member') ?? interaction.user;
  const member = target as GuildMember | null;

  const card = embed(user.tag)
    .setThumbnail(user.displayAvatarURL({ size: 256 }))
    .addFields(
      { name: 'Account created', value: absolute(user.createdAt), inline: true },
      {
        name: 'Joined server',
        value: member?.joinedAt ? absolute(member.joinedAt) : 'Not a member',
        inline: true,
      },
      { name: 'ID', value: user.id, inline: true },
    );

  if (member) {
    /* @everyone is on every member and says nothing, so it is dropped. Roles come back highest
     * first because that is the order that answers "what is this person". */
    const roles = member.roles.cache
      .filter((role) => role.id !== interaction.guildId)
      .sort((left, right) => right.position - left.position)
      .map((role) => `<@&${role.id}>`);
    card.addFields({
      name: `Roles (${roles.length})`,
      value: roles.length > 0 ? clip(roles.join(' '), 1000) : 'None',
    });

    const timeout = member.communicationDisabledUntil;
    if (timeout && timeout.getTime() > Date.now()) {
      card.addFields({ name: 'Timed out until', value: relative(timeout) }).setColor(COLOR.warn);
    }
  }

  await interaction.reply({ embeds: [card] });
}

export async function serverInfo(interaction: ChatInputCommandInteraction) {
  const guild = interaction.guild;
  if (!guild) return;

  const channels = guild.channels.cache;
  const card = embed(guild.name).addFields(
    { name: 'Members', value: String(guild.memberCount), inline: true },
    {
      name: 'Channels',
      value: String(channels.filter((channel) => channel.type !== ChannelType.GuildCategory).size),
      inline: true,
    },
    { name: 'Roles', value: String(guild.roles.cache.size), inline: true },
    { name: 'Created', value: absolute(guild.createdAt), inline: true },
    { name: 'Boosts', value: String(guild.premiumSubscriptionCount ?? 0), inline: true },
    { name: 'Owner', value: `<@${guild.ownerId}>`, inline: true },
  );

  const icon = guild.iconURL({ size: 256 });
  if (icon) card.setThumbnail(icon);
  await interaction.reply({ embeds: [card] });
}

export async function avatar(interaction: ChatInputCommandInteraction) {
  const user = interaction.options.getUser('member') ?? interaction.user;
  const url = user.displayAvatarURL({ size: 1024 });
  await interaction.reply({
    embeds: [embed(user.tag).setImage(url).setDescription(`[Open full size](${url})`)],
  });
}

/**
 * `/poll` — a question, up to five options, and a button per option.
 *
 * Buttons rather than reactions. A reaction poll needs the bot to add every emoji first, which is
 * rate limited and visibly slow, and anybody can add a sixth option nobody offered. The tally
 * lives in the message itself — see `castPollVote` — so a restart cannot lose it.
 */
export async function createPoll(interaction: ChatInputCommandInteraction) {
  const question = interaction.options.getString('question', true);
  const options = [1, 2, 3, 4, 5]
    .map((index) => interaction.options.getString(`option${index}`))
    .filter((value): value is string => Boolean(value));

  if (options.length < 2) {
    await interaction.reply({
      embeds: [bad('Not enough options', 'A poll needs at least two.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const card = embed(
    clip(question, 256),
    renderTally(
      options,
      options.map(() => 0),
    ),
  ).setFooter({
    text: `Poll by ${interaction.user.tag} · one vote each`,
  });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    options.map((_, index) =>
      new ButtonBuilder()
        .setCustomId(`poll:${index}`)
        .setLabel(String(index + 1))
        .setEmoji(POLL_EMOJI[index] ?? '▫️')
        .setStyle(ButtonStyle.Secondary),
    ),
  );

  await interaction.reply({ embeds: [card], components: [row] });
}

/**
 * A poll vote.
 *
 * The state is the message: voters are listed per option in a hidden field, and the tally is
 * recomputed from that list. It means a poll survives a restart with no table behind it, and it
 * means one person cannot vote twice — their id is removed from every option before being added
 * to the one they pressed.
 */
export async function castPollVote(interaction: ButtonInteraction, choice: number) {
  const source = interaction.message.embeds[0];
  if (!source?.title) {
    await interaction.deferUpdate();
    return;
  }

  const options = parseOptions(source.description ?? '');
  if (choice < 0 || choice >= options.length) {
    await interaction.deferUpdate();
    return;
  }

  const ballots = parseBallots(source.fields?.find((field) => field.name === BALLOT_FIELD)?.value);
  for (const list of ballots) list.delete(interaction.user.id);
  while (ballots.length < options.length) ballots.push(new Set());
  ballots[choice]?.add(interaction.user.id);

  const counts = options.map((_, index) => ballots[index]?.size ?? 0);
  const updated = embed(source.title, renderTally(options, counts), source.color ?? COLOR.brand)
    .addFields({ name: BALLOT_FIELD, value: renderBallots(ballots) })
    .setFooter(source.footer ?? { text: 'one vote each' });

  await interaction.update({ embeds: [updated] });
}

export async function slowmode(interaction: ChatInputCommandInteraction) {
  const seconds = interaction.options.getInteger('seconds', true);
  const channel = interaction.channel;
  if (!channel || !('setRateLimitPerUser' in channel)) {
    await interaction.reply({
      embeds: [bad('Not here', 'That channel does not support slowmode.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    await (channel as TextChannel).setRateLimitPerUser(seconds, `Set by ${interaction.user.tag}`);
  } catch {
    await interaction.reply({
      embeds: [bad('I could not set that', 'I need Manage Channels here.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({
    embeds: [
      ok(
        'Slowmode',
        seconds === 0 ? 'Turned off.' : `One message every ${humanDuration(seconds)}.`,
      ),
    ],
  });
}

/**
 * `/say` — the bot posts a message as itself.
 *
 * Restricted to Manage Messages, and the reply naming the author is ephemeral but the mod log
 * entry is not optional: a bot that can post anonymously in the server's voice is a bot that will
 * eventually be used to post something nobody will admit to.
 */
export async function say(
  interaction: ChatInputCommandInteraction,
  modlogChannelId: string | null,
) {
  const text = interaction.options.getString('message', true);
  const channel = interaction.channel;
  if (!channel?.isTextBased()) return;

  await (channel as TextChannel).send({ content: clip(text, 2000) });
  await interaction.reply({
    embeds: [ok('Sent', 'Logged against your name.')],
    flags: MessageFlags.Ephemeral,
  });

  if (modlogChannelId) {
    const log = interaction.guild?.channels.cache.get(modlogChannelId);
    if (log?.isTextBased()) {
      await (log as TextChannel)
        .send({
          embeds: [
            embed('Bot message sent', undefined, COLOR.quiet).addFields(
              { name: 'By', value: `<@${interaction.user.id}>`, inline: true },
              { name: 'Channel', value: `<#${channel.id}>`, inline: true },
              { name: 'Message', value: clip(text, 1000) },
            ),
          ],
        })
        .catch(() => undefined);
    }
  }
}

export const SAY_PERMISSIONS = PermissionFlagsBits.ManageMessages;

// ── poll rendering ─────────────────────────────────────────────────────────

const BALLOT_FIELD = 'ballots';

function renderTally(options: string[], counts: number[]): string {
  const total = counts.reduce((sum, count) => sum + count, 0);
  return options
    .map((option, index) => {
      const count = counts[index] ?? 0;
      const share = total > 0 ? count / total : 0;
      const filled = Math.round(share * 12);
      return `${POLL_EMOJI[index] ?? '▫️'} **${clip(option, 80)}**\n\`${'▰'.repeat(
        filled,
      )}${'▱'.repeat(12 - filled)}\` ${count}`;
    })
    .join('\n');
}

/** Reads the option labels back out of a rendered tally, so the poll needs no stored copy. */
function parseOptions(description: string): string[] {
  return [...description.matchAll(/\*\*(.+?)\*\*/g)].map((match) => match[1] ?? '');
}

const parseBallots = (value: string | undefined): Set<string>[] =>
  (value ?? '').split('|').map(
    (group) =>
      new Set(
        group
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean),
      ),
  );

/* Voter ids are stored in a field rather than a table, and a Discord embed field caps at 1024
 * characters -- roughly fifty snowflakes. Past that the oldest are dropped, so a very large poll
 * loses double-vote protection rather than breaking. A poll that big wants a real tool. */
const renderBallots = (ballots: Set<string>[]): string =>
  clip(ballots.map((group) => [...group].join(',')).join('|'), 1000) || '​';
