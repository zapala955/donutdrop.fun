import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
  type TextChannel,
} from 'discord.js';
import { guildSettings, setGuildSetting, type Database } from '../db.js';
import { COLOR, bad, clip, embed, ok, relative, warn } from '../ui.js';

/**
 * community.ts — joining, leaving, self-serve roles and the suggestion board.
 *
 * The four smallest features share a file because they share one idea: everything is driven by a
 * per-guild setting that may be unset, and an unset feature is silent rather than broken. A
 * server with no welcome channel has a bot that says nothing when somebody joins, not one that
 * throws on every join.
 */

// ── joining and leaving ────────────────────────────────────────────────────

/**
 * Greets a new member and hands them the starting role.
 *
 * Both halves are independent: a welcome message that fails must not cost somebody their role,
 * and a role that cannot be assigned must not cost the greeting. They are caught separately for
 * that reason rather than sharing a try.
 *
 * `origin` is what invite tracking worked out, and it is only shown to staff in the mod log --
 * never in the welcome message. "Invited by X" under somebody's arrival turns every join into a
 * scoreboard update, and the people it names did not ask to be announced.
 */
export async function onMemberJoin(
  db: Database,
  member: GuildMember,
  origin?: { source: string; inviterId: string | null },
): Promise<void> {
  const settings = await guildSettings(db, member.guild.id);

  /* Bots are skipped. They arrive through OAuth with the roles whoever added them chose, and a
   * "Member" role landing on a webhook relay is a permissions surprise nobody asked for. */
  if (settings.autorole_id && !member.user.bot) {
    try {
      await member.roles.add(settings.autorole_id, 'Autorole on join');
    } catch (error) {
      /* NOT swallowed, which it used to be. A role above the bot's own cannot be assigned, and
       * silently doing nothing makes that indistinguishable from a bot that is offline -- the
       * report is always "autorole just doesn't work" with nothing to go on. */
      await reportAutoroleFailure(db, member, settings.autorole_id, error);
    }
  }

  await announceArrival(db, member, settings.modlog_channel_id, origin);

  if (!settings.welcome_channel_id) return;
  const channel = member.guild.channels.cache.get(settings.welcome_channel_id);
  if (!channel?.isTextBased()) return;

  /* {user} and {server} are the only placeholders. More would be a template language nobody asked
   * for, and these two are what every welcome message actually says. */
  const template =
    settings.welcome_message ?? 'Welcome to {server}, {user}. Have a look around and say hello.';
  const body = template
    .replaceAll('{user}', `<@${member.id}>`)
    .replaceAll('{server}', member.guild.name);

  await (channel as TextChannel)
    .send({
      embeds: [
        embed('A new arrival', clip(body, 2000))
          .setThumbnail(member.user.displayAvatarURL())
          .setFooter({ text: `Member #${member.guild.memberCount}` }),
      ],
    })
    .catch(() => undefined);
}

/**
 * Tells staff an autorole failed, once per role rather than once per member.
 *
 * A broken autorole fails for EVERY join, so an unthrottled report would bury the mod log the
 * first time somebody drags a role above the bot's. One message naming the cause is enough to
 * act on; the rest are the same sentence again.
 */
const reportedAutoroleFailures = new Set<string>();

async function reportAutoroleFailure(
  db: Database,
  member: GuildMember,
  roleId: string,
  error: unknown,
): Promise<void> {
  console.error(`[autorole] could not give ${roleId} to ${member.id}`, error);

  const key = `${member.guild.id}:${roleId}`;
  if (reportedAutoroleFailures.has(key)) return;
  reportedAutoroleFailures.add(key);

  const settings = await guildSettings(db, member.guild.id);
  if (!settings.modlog_channel_id) return;
  const channel = member.guild.channels.cache.get(settings.modlog_channel_id);
  if (!channel?.isTextBased()) return;

  const botMember = member.guild.members.me;
  const role = member.guild.roles.cache.get(roleId);
  const reason =
    role && botMember && role.position >= botMember.roles.highest.position
      ? `<@&${roleId}> sits at or above my highest role, so I cannot assign it. Move my role above it in Server Settings > Roles.`
      : `I could not assign <@&${roleId}>. Check that it still exists and that I have Manage Roles.`;

  await (channel as TextChannel)
    .send({ embeds: [warn('Autorole is not working', reason)] })
    .catch(() => undefined);
}

/**
 * The staff-side record of a join: when, how old the account is, and where they came from.
 *
 * The account age is here because it is the one fact that makes a raid obvious — twenty members
 * whose accounts were all made this week is a pattern; twenty names is not.
 */
async function announceArrival(
  db: Database,
  member: GuildMember,
  modlogChannelId: string | null,
  origin?: { source: string; inviterId: string | null },
): Promise<void> {
  if (!modlogChannelId) return;
  const channel = member.guild.channels.cache.get(modlogChannelId);
  if (!channel?.isTextBased()) return;

  const where =
    origin?.source === 'invite' && origin.inviterId
      ? `<@${origin.inviterId}>`
      : origin?.source === 'vanity'
        ? 'Vanity URL'
        : origin?.source === 'bot'
          ? 'Added as a bot'
          : 'Unknown';

  const card = embed('Member joined', `<@${member.id}> — ${clip(member.user.tag, 64)}`, COLOR.quiet)
    .addFields(
      { name: 'Invited by', value: where, inline: true },
      { name: 'Account created', value: relative(member.user.createdAt), inline: true },
      { name: 'Members', value: String(member.guild.memberCount), inline: true },
    )
    .setThumbnail(member.user.displayAvatarURL());

  await (channel as TextChannel).send({ embeds: [card] }).catch(() => undefined);
}

export async function onMemberLeave(
  db: Database,
  guildId: string,
  tag: string,
  guildName: string,
  channels: { get(id: string): unknown },
): Promise<void> {
  const settings = await guildSettings(db, guildId);
  if (!settings.goodbye_channel_id) return;
  const channel = channels.get(settings.goodbye_channel_id) as TextChannel | undefined;
  if (!channel?.isTextBased?.()) return;
  await channel
    .send({ embeds: [embed('Left', `**${clip(tag, 64)}** has left ${guildName}.`, COLOR.quiet)] })
    .catch(() => undefined);
}

// ── self-serve roles ───────────────────────────────────────────────────────

/**
 * Posts a role menu and remembers what its buttons mean.
 *
 * The rows are the point. A menu whose meaning lived only in the message would become a row of
 * buttons that do nothing the first time the bot restarted, because the custom id would map to
 * nothing. Here the button carries the menu id and the role is read back from the database.
 */
export async function createRoleMenu(db: Database, interaction: ChatInputCommandInteraction) {
  const title = interaction.options.getString('title', true);
  const roles = [1, 2, 3, 4, 5]
    .map((index) => ({
      role: interaction.options.getRole(`role${index}`),
      label: interaction.options.getString(`label${index}`),
    }))
    .filter((entry): entry is { role: NonNullable<typeof entry.role>; label: string | null } =>
      Boolean(entry.role),
    );

  if (roles.length === 0) {
    await interaction.reply({
      embeds: [bad('No roles', 'Give the menu at least one role.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const botMember = interaction.guild?.members.me;
  /* Checked before the menu is posted, not when somebody presses it. A picker that looks fine and
   * fails for every member is worse than one that refuses to be created. */
  const unreachable = roles.filter(
    (entry) => botMember && entry.role.position >= botMember.roles.highest.position,
  );
  if (unreachable.length > 0) {
    await interaction.reply({
      embeds: [
        bad(
          'I cannot assign those',
          `${unreachable.map((entry) => `<@&${entry.role.id}>`).join(', ')} sit at or above my ` +
            'highest role. Move my role above them and try again.',
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const menuId = randomUUID();
  await db.transaction(async (client) => {
    await client.query(
      `INSERT INTO discord_role_menus (id, guild_id, channel_id, title)
       VALUES ($1, $2, $3, $4)`,
      [menuId, interaction.guildId, interaction.channelId, clip(title, 128)],
    );
    for (const [index, entry] of roles.entries()) {
      await client.query(
        `INSERT INTO discord_role_menu_options (menu_id, role_id, label, position)
         VALUES ($1, $2, $3, $4)`,
        [menuId, entry.role.id, clip(entry.label ?? entry.role.name, 64), index],
      );
    }
  });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    roles.map((entry, index) =>
      new ButtonBuilder()
        .setCustomId(`role:toggle:${menuId}:${entry.role.id}`)
        .setLabel(clip(entry.label ?? entry.role.name, 64))
        .setStyle(index === 0 ? ButtonStyle.Primary : ButtonStyle.Secondary),
    ),
  );

  /* `isSendable()` rather than a cast: a slash command can be run in a channel this bot cannot
   * post in, and the menu rows are already written by then. Narrowing here keeps that case a
   * message instead of a crash. */
  const here = interaction.channel;
  const posted = here?.isSendable()
    ? await here.send({
        embeds: [
          embed(
            clip(title, 128),
            'Press a button to give yourself the role, press it again to remove it.',
          ),
        ],
        components: [row],
      })
    : null;
  await db.query('UPDATE discord_role_menus SET message_id = $2 WHERE id = $1', [
    menuId,
    posted?.id ?? null,
  ]);

  await interaction.reply({
    embeds: [ok('Menu posted', `${roles.length} role${roles.length === 1 ? '' : 's'}.`)],
    flags: MessageFlags.Ephemeral,
  });
}

/** One button, one role, on or off. The reply is ephemeral so the channel stays clean. */
export async function toggleRole(
  db: Database,
  interaction: ButtonInteraction,
  menuId: string,
  roleId: string,
) {
  const member = interaction.member as GuildMember | null;
  if (!member) return;

  /* The role is confirmed against the menu rather than trusted from the custom id. A custom id is
   * client-supplied: without this, a crafted interaction could name any role in the server. */
  const allowed = await db.query<{ role_id: string }>(
    `SELECT o.role_id FROM discord_role_menu_options o
       JOIN discord_role_menus m ON m.id = o.menu_id
      WHERE o.menu_id = $1 AND o.role_id = $2 AND m.guild_id = $3`,
    [menuId, roleId, interaction.guildId],
  );
  if (!allowed.rows[0]) {
    await interaction.reply({
      embeds: [bad('Not on this menu', 'That button no longer matches a role here.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const has = member.roles.cache.has(roleId);
  try {
    if (has) await member.roles.remove(roleId, 'Self-serve role menu');
    else await member.roles.add(roleId, 'Self-serve role menu');
  } catch {
    await interaction.reply({
      embeds: [
        bad('I could not change that', 'My role needs to sit above it. Tell an administrator.'),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({
    embeds: [ok(has ? 'Removed' : 'Added', `<@&${roleId}> ${has ? 'removed' : 'given'}.`)],
    flags: MessageFlags.Ephemeral,
  });
}

// ── suggestions ────────────────────────────────────────────────────────────

/** Posts a suggestion with vote buttons into the configured board. */
export async function createSuggestion(db: Database, interaction: ChatInputCommandInteraction) {
  const body = interaction.options.getString('suggestion', true);
  const settings = await guildSettings(db, interaction.guildId!);
  if (!settings.suggestion_channel_id) {
    await interaction.reply({
      embeds: [
        bad('No suggestion board', 'An administrator needs to run `/set-suggestions` first.'),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const channel = interaction.guild?.channels.cache.get(settings.suggestion_channel_id);
  if (!channel?.isTextBased()) {
    await interaction.reply({
      embeds: [bad('Board is missing', 'The configured suggestion channel no longer exists.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const suggestionId = randomUUID();
  const number = await db.transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 9002))', [
      `suggestions:${interaction.guildId}`,
    ]);
    const next = await client.query<{ number: string }>(
      'SELECT coalesce(max(number), 0) + 1 AS number FROM discord_suggestions WHERE guild_id = $1',
      [interaction.guildId],
    );
    const value = Number(next.rows[0]?.number ?? 1);
    await client.query(
      `INSERT INTO discord_suggestions
         (id, guild_id, channel_id, number, author_id, body)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [suggestionId, interaction.guildId, channel.id, value, interaction.user.id, clip(body, 2000)],
    );
    return value;
  });

  const card = embed(`Suggestion #${number}`, clip(body, 2000))
    .setAuthor({ name: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() })
    .addFields({ name: 'Votes', value: '▲ 0  ·  ▼ 0' });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`suggest:up:${suggestionId}`)
      .setLabel('Upvote')
      .setEmoji('▲')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`suggest:down:${suggestionId}`)
      .setLabel('Downvote')
      .setEmoji('▼')
      .setStyle(ButtonStyle.Danger),
  );

  const posted = await (channel as TextChannel).send({ embeds: [card], components: [row] });
  await db.query('UPDATE discord_suggestions SET message_id = $2 WHERE id = $1', [
    suggestionId,
    posted.id,
  ]);

  await interaction.reply({
    embeds: [ok('Posted', `Suggestion #${number} is in <#${channel.id}>.`)],
    flags: MessageFlags.Ephemeral,
  });
}

/**
 * Records a vote, or changes one.
 *
 * The primary key on (suggestion, user) is what makes this one vote per person; pressing the
 * other button updates the row rather than adding a second. Pressing the same one again is
 * treated as withdrawing it, because a vote you cannot take back is a vote people stop casting.
 */
export async function voteSuggestion(
  db: Database,
  interaction: ButtonInteraction,
  suggestionId: string,
  direction: 'up' | 'down',
) {
  const vote = direction === 'up' ? 1 : -1;
  const existing = await db.query<{ vote: number }>(
    'SELECT vote FROM discord_suggestion_votes WHERE suggestion_id = $1 AND user_id = $2',
    [suggestionId, interaction.user.id],
  );

  if (existing.rows[0]?.vote === vote) {
    await db.query(
      'DELETE FROM discord_suggestion_votes WHERE suggestion_id = $1 AND user_id = $2',
      [suggestionId, interaction.user.id],
    );
  } else {
    await db.query(
      `INSERT INTO discord_suggestion_votes (suggestion_id, user_id, vote)
       VALUES ($1, $2, $3)
       ON CONFLICT (suggestion_id, user_id) DO UPDATE SET vote = EXCLUDED.vote`,
      [suggestionId, interaction.user.id, vote],
    );
  }

  const tally = await db.query<{ up: string; down: string }>(
    `SELECT count(*) FILTER (WHERE vote = 1)::text AS up,
            count(*) FILTER (WHERE vote = -1)::text AS down
       FROM discord_suggestion_votes WHERE suggestion_id = $1`,
    [suggestionId],
  );
  const up = Number(tally.rows[0]?.up ?? 0);
  const down = Number(tally.rows[0]?.down ?? 0);

  /* The original embed is edited rather than rebuilt, so the suggestion text and author survive
   * a bot that has restarted since it was posted and no longer holds them in memory. */
  const source = interaction.message.embeds[0];
  if (source) {
    const updated = embed(
      source.title ?? 'Suggestion',
      source.description ?? undefined,
      source.color ?? COLOR.brand,
    ).addFields({ name: 'Votes', value: `▲ ${up}  ·  ▼ ${down}` });
    if (source.author) updated.setAuthor(source.author);
    if (source.footer) updated.setFooter(source.footer);
    await interaction.update({ embeds: [updated] });
    return;
  }
  await interaction.deferUpdate();
}

/** `/suggestion-decide` — staff accept or decline, and the card says so afterwards. */
export async function decideSuggestion(db: Database, interaction: ChatInputCommandInteraction) {
  const number = interaction.options.getInteger('number', true);
  const status = interaction.options.getString('status', true) as
    'accepted' | 'declined' | 'duplicate';
  const note = interaction.options.getString('note') ?? '';

  const updated = await db.query<{
    id: string;
    channel_id: string;
    message_id: string | null;
    body: string;
  }>(
    `UPDATE discord_suggestions
        SET status = $3, staff_note = $4, decided_by = $5, decided_at = now()
      WHERE guild_id = $1 AND number = $2 AND status = 'open'
      RETURNING id, channel_id, message_id, body`,
    [interaction.guildId, number, status, clip(note, 512) || null, interaction.user.id],
  );
  const row = updated.rows[0];
  if (!row) {
    await interaction.reply({
      embeds: [bad('Not found', `Suggestion #${number} is not open in this server.`)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const colour =
    status === 'accepted' ? COLOR.good : status === 'declined' ? COLOR.bad : COLOR.quiet;

  if (row.message_id) {
    const channel = interaction.guild?.channels.cache.get(row.channel_id);
    if (channel?.isTextBased()) {
      const message = await (channel as TextChannel).messages
        .fetch(row.message_id)
        .catch(() => null);
      if (message) {
        const card = embed(
          `Suggestion #${number} · ${status}`,
          clip(row.body, 2000),
          colour,
        ).addFields(
          { name: 'Decided by', value: `<@${interaction.user.id}>`, inline: true },
          ...(note ? [{ name: 'Note', value: clip(note, 500) }] : []),
        );
        // Buttons removed with the decision: voting on a closed suggestion is a dead end.
        await message.edit({ embeds: [card], components: [] }).catch(() => undefined);
      }
    }
  }

  await interaction.reply({
    embeds: [ok('Decided', `Suggestion #${number} marked **${status}**.`)],
    flags: MessageFlags.Ephemeral,
  });
}

// ── the settings behind all of it ──────────────────────────────────────────

/** `/config` — one command for the channels and roles every feature above reads. */
export async function configure(db: Database, interaction: ChatInputCommandInteraction) {
  const guildId = interaction.guildId!;
  const changes: string[] = [];

  const pairs: [string, keyof Awaited<ReturnType<typeof guildSettings>>, 'channel' | 'role'][] = [
    ['modlog', 'modlog_channel_id', 'channel'],
    ['welcome', 'welcome_channel_id', 'channel'],
    ['goodbye', 'goodbye_channel_id', 'channel'],
    ['suggestions', 'suggestion_channel_id', 'channel'],
    ['autorole', 'autorole_id', 'role'],
  ];

  const autorole = interaction.options.getRole('autorole');
  if (autorole) {
    /* Refused here rather than discovered on the next join. An autorole the bot cannot assign
     * fails for every single member, and from the outside that looks exactly like a bot that is
     * down -- so the one moment somebody can act on it is while they are setting it. */
    const botMember = interaction.guild?.members.me;
    if (botMember && autorole.position >= botMember.roles.highest.position) {
      await interaction.reply({
        embeds: [
          bad(
            'I cannot assign that role',
            `<@&${autorole.id}> sits at or above my highest role, so Discord would refuse it every time somebody joined.

In **Server Settings > Roles**, drag my role above it, then run this again.`,
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (autorole.id === guildId) {
      // @everyone has the guild's own id, and it is already on everyone.
      await interaction.reply({
        embeds: [bad('Not that one', '`@everyone` is already on every member.')],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

  for (const [option, column, kind] of pairs) {
    const value =
      kind === 'channel'
        ? interaction.options.getChannel(option)
        : interaction.options.getRole(option);
    if (!value) continue;
    await setGuildSetting(db, guildId, column as never, value.id);
    changes.push(`**${option}** → ${kind === 'channel' ? `<#${value.id}>` : `<@&${value.id}>`}`);
  }

  const welcomeMessage = interaction.options.getString('welcome_message');
  if (welcomeMessage) {
    await setGuildSetting(db, guildId, 'welcome_message', clip(welcomeMessage, 1024));
    changes.push('**welcome message** updated');
  }

  if (changes.length === 0) {
    const current = await guildSettings(db, guildId);
    await interaction.reply({
      embeds: [
        embed(
          'Current configuration',
          [
            `Mod log: ${channelOrNone(current.modlog_channel_id)}`,
            `Welcome: ${channelOrNone(current.welcome_channel_id)}`,
            `Goodbye: ${channelOrNone(current.goodbye_channel_id)}`,
            `Suggestions: ${channelOrNone(current.suggestion_channel_id)}`,
            `Autorole: ${current.autorole_id ? `<@&${current.autorole_id}>` : '*not set*'}`,
            `Tickets: ${current.ticket_category_id ? 'configured' : '*run /ticket-setup*'}`,
          ].join('\n'),
          COLOR.quiet,
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({
    embeds: [ok('Updated', changes.join('\n'))],
    flags: MessageFlags.Ephemeral,
  });
}

const channelOrNone = (id: string | null) => (id ? `<#${id}>` : '*not set*');
