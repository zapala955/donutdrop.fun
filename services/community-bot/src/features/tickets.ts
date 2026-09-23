import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type ModalSubmitInteraction,
  type TextChannel,
} from 'discord.js';
import { guildSettings, type Database } from '../db.js';
import { COLOR, bad, clip, embed, ok } from '../ui.js';

/**
 * tickets.ts — private channels for support and media applications.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE ROW OUTLIVES THE CHANNEL
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A ticket is a Discord channel while it is open and a database row forever. Once somebody tidies
 * up the category, Discord cannot answer "what did we tell that player in March" -- so the
 * transcript is rendered at close and stored, and the channel becomes disposable.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE DATABASE HOLDS THE "ONE AT A TIME" RULE, NOT THIS FILE
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A partial unique index on (guild, opener, category) where the ticket is not closed is what
 * stops nine channels appearing when somebody double-clicks. A check in this handler would pass
 * twice for two clicks half a second apart; an index cannot.
 */

const CATEGORY = {
  support: {
    label: 'Support',
    blurb: 'A problem with your account, a deposit, a withdrawal or a round.',
    emoji: '🎫',
    prefix: 'support',
  },
  media: {
    label: 'Media application',
    blurb: 'Applying for the creator programme as a streamer or video maker.',
    emoji: '🎥',
    prefix: 'media',
  },
} as const;

export type TicketCategory = keyof typeof CATEGORY;

const isCategory = (value: string): value is TicketCategory => value in CATEGORY;

/** The panel members click. Posted once into a channel and left there. */
export function ticketPanel() {
  const panel = embed(
    'Need a hand?',
    'Open a ticket and a member of staff will pick it up. Choose the one that fits — it decides ' +
      'who gets pinged, so the right people see it sooner.\n\n' +
      `${CATEGORY.support.emoji} **${CATEGORY.support.label}** — ${CATEGORY.support.blurb}\n` +
      `${CATEGORY.media.emoji} **${CATEGORY.media.label}** — ${CATEGORY.media.blurb}`,
  );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket:open:support')
      .setLabel(CATEGORY.support.label)
      .setEmoji(CATEGORY.support.emoji)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('ticket:open:media')
      .setLabel(CATEGORY.media.label)
      .setEmoji(CATEGORY.media.emoji)
      .setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [panel], components: [row] };
}

/**
 * The button opens a form rather than a channel.
 *
 * Asking for the subject up front is what turns "hello" followed by twenty minutes of silence
 * into a ticket staff can triage from the list. A media application asks for the links, because
 * that application is unanswerable without them.
 */
export async function openTicketModal(interaction: ButtonInteraction, category: string) {
  if (!isCategory(category)) return;
  const meta = CATEGORY[category];
  const modal = new ModalBuilder().setCustomId(`ticket:create:${category}`).setTitle(meta.label);

  const subject = new TextInputBuilder()
    .setCustomId('subject')
    .setLabel(category === 'media' ? 'Your channel or handle' : 'What is this about?')
    .setStyle(TextInputStyle.Short)
    .setMaxLength(100)
    .setRequired(true);

  const detail = new TextInputBuilder()
    .setCustomId('detail')
    .setLabel(category === 'media' ? 'Links and audience size' : 'Tell us what happened')
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(1500)
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(subject),
    new ActionRowBuilder<TextInputBuilder>().addComponents(detail),
  );
  await interaction.showModal(modal);
}

/** Creates the channel and the row, in that order, and repairs itself if the second half fails. */
export async function createTicket(
  db: Database,
  interaction: ModalSubmitInteraction,
  category: string,
) {
  if (!isCategory(category) || !interaction.guild) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const settings = await guildSettings(db, interaction.guild.id);
  if (!settings.ticket_category_id) {
    await interaction.editReply({
      embeds: [
        bad(
          'Tickets are not set up yet',
          'A server administrator needs to run `/ticket-setup` and choose the category channels ' +
            'are created under.',
        ),
      ],
    });
    return;
  }

  const subject = clip(interaction.fields.getTextInputValue('subject'), 100);
  const detail = clip(interaction.fields.getTextInputValue('detail'), 1500);

  /* The number is taken inside the transaction that inserts the row, so two people opening at
   * once cannot both be #7. Postgres serialises them on the unique index; the loser retries with
   * the next number rather than failing. */
  let ticket: { id: string; number: number } | null = null;
  try {
    ticket = await db.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 9001))', [
        `tickets:${interaction.guild!.id}`,
      ]);
      const next = await client.query<{ number: string }>(
        'SELECT coalesce(max(number), 0) + 1 AS number FROM discord_tickets WHERE guild_id = $1',
        [interaction.guild!.id],
      );
      const number = Number(next.rows[0]?.number ?? 1);
      const id = randomUUID();
      await client.query(
        `INSERT INTO discord_tickets
           (id, guild_id, channel_id, number, category, opener_id, opener_tag, subject)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          id,
          interaction.guild!.id,
          // Filled in a moment. A placeholder rather than null because the column is NOT NULL and
          // the row must exist before the channel, so the unique index can refuse a second one.
          `pending:${id}`,
          number,
          category,
          interaction.user.id,
          clip(interaction.user.tag, 64),
          subject,
        ],
      );
      return { id, number };
    });
  } catch (error) {
    // 23505 on the partial unique index: they already have one open in this category.
    if ((error as { code?: string }).code === '23505') {
      await interaction.editReply({
        embeds: [warnAlreadyOpen(CATEGORY[category].label)],
      });
      return;
    }
    throw error;
  }

  const channel = await createTicketChannel(
    interaction.guild,
    settings.ticket_category_id,
    settings.ticket_staff_role_id,
    `${CATEGORY[category].prefix}-${String(ticket.number).padStart(4, '0')}`,
    interaction.user.id,
  ).catch(async (error: unknown) => {
    /* The row exists and the channel does not, so the member now holds an open ticket they cannot
     * see. Delete the row rather than leaving them locked out of opening another one. */
    await db.query('DELETE FROM discord_tickets WHERE id = $1', [ticket.id]);
    throw error;
  });

  await db.query('UPDATE discord_tickets SET channel_id = $2 WHERE id = $1', [
    ticket.id,
    channel.id,
  ]);

  const intro = embed(
    `${CATEGORY[category].label} · #${String(ticket.number).padStart(4, '0')}`,
    `**${subject}**\n\n${detail}`,
  )
    .setFooter({ text: `Opened by ${interaction.user.tag}` })
    .setTimestamp(new Date());

  const controls = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`ticket:claim:${ticket.id}`)
      .setLabel('Claim')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`ticket:close:${ticket.id}`)
      .setLabel('Close')
      .setStyle(ButtonStyle.Danger),
  );

  await channel.send({
    content: settings.ticket_staff_role_id
      ? `<@&${settings.ticket_staff_role_id}> · <@${interaction.user.id}>`
      : `<@${interaction.user.id}>`,
    embeds: [intro],
    components: [controls],
  });

  await interaction.editReply({
    embeds: [ok('Ticket opened', `Head to <#${channel.id}>.`)],
  });
}

function warnAlreadyOpen(label: string) {
  return bad(
    'You already have one open',
    `Your existing ${label.toLowerCase()} ticket is still open. Use that one, or close it first — ` +
      'opening several makes it slower for everybody, not faster.',
  );
}

/**
 * A channel only the opener and staff can see.
 *
 * The permission overwrites are the privacy. @everyone is denied at the channel, the opener is
 * granted, and the staff role is granted if one is configured -- which means a ticket in a server
 * with no staff role set is visible to the opener and to administrators, never to the room.
 */
async function createTicketChannel(
  guild: Guild,
  parentId: string,
  staffRoleId: string | null,
  name: string,
  openerId: string,
): Promise<TextChannel> {
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: openerId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
      ],
    },
  ];
  if (staffRoleId) {
    overwrites.push({
      id: staffRoleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageMessages,
      ],
    });
  }
  return await guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: parentId,
    permissionOverwrites: overwrites,
  });
}

/** Claiming says who owns it, so two staff do not answer the same ticket twice. */
export async function claimTicket(db: Database, interaction: ButtonInteraction, ticketId: string) {
  const claimed = await db.query<{ number: number; claimed_by: string | null }>(
    `UPDATE discord_tickets
        SET status = 'claimed', claimed_by = $2, claimed_at = now()
      WHERE id = $1 AND status = 'open'
      RETURNING number, claimed_by`,
    [ticketId, interaction.user.id],
  );
  if (!claimed.rows[0]) {
    const current = await db.query<{ claimed_by: string | null; status: string }>(
      'SELECT claimed_by, status FROM discord_tickets WHERE id = $1',
      [ticketId],
    );
    const row = current.rows[0];
    await interaction.reply({
      embeds: [
        bad(
          'Already taken',
          row?.claimed_by
            ? `<@${row.claimed_by}> is on this one.`
            : 'That ticket is no longer open.',
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.reply({
    embeds: [ok('Claimed', `<@${interaction.user.id}> is handling this ticket.`)],
  });
}

/** Asks why before closing. A ticket closed with no reason is a ticket nobody can learn from. */
export async function closeTicketModal(interaction: ButtonInteraction, ticketId: string) {
  const modal = new ModalBuilder()
    .setCustomId(`ticket:closing:${ticketId}`)
    .setTitle('Close ticket');
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId('reason')
        .setLabel('How was it resolved?')
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(400)
        .setRequired(true),
    ),
  );
  await interaction.showModal(modal);
}

/**
 * Closes the ticket: renders the transcript, stores it, logs it, deletes the channel.
 *
 * The transcript is read before anything is deleted and written before the channel goes, so a
 * failure at any point leaves a ticket that still has its conversation rather than one that has
 * lost it.
 */
export async function closeTicket(
  db: Database,
  interaction: ModalSubmitInteraction,
  ticketId: string,
) {
  await interaction.deferReply();
  const reason = clip(interaction.fields.getTextInputValue('reason'), 400);

  const found = await db.query<{
    channel_id: string;
    number: number;
    category: string;
    opener_id: string;
    subject: string | null;
    status: string;
  }>(
    'SELECT channel_id, number, category, opener_id, subject, status FROM discord_tickets WHERE id = $1',
    [ticketId],
  );
  const ticket = found.rows[0];
  if (!ticket || ticket.status === 'closed') {
    await interaction.editReply({ embeds: [bad('Already closed', 'Nothing to do.')] });
    return;
  }

  const channel = interaction.guild?.channels.cache.get(ticket.channel_id);
  const transcript =
    channel && channel.isTextBased() ? await renderTranscript(channel as TextChannel) : null;

  await db.query(
    `UPDATE discord_tickets
        SET status = 'closed', closed_by = $2, closed_at = now(), close_reason = $3,
            transcript = $4
      WHERE id = $1`,
    [ticketId, interaction.user.id, reason, transcript],
  );

  const settings = interaction.guild ? await guildSettings(db, interaction.guild.id) : null;
  if (settings?.ticket_log_channel_id && interaction.guild) {
    const log = interaction.guild.channels.cache.get(settings.ticket_log_channel_id);
    if (log?.isTextBased()) {
      const summary = embed(
        `Ticket #${String(ticket.number).padStart(4, '0')} closed`,
        `**${ticket.subject ?? 'No subject'}**\n\n${reason}`,
        COLOR.quiet,
      ).addFields(
        { name: 'Opened by', value: `<@${ticket.opener_id}>`, inline: true },
        { name: 'Closed by', value: `<@${interaction.user.id}>`, inline: true },
        { name: 'Category', value: ticket.category, inline: true },
      );
      const files = transcript
        ? [
            {
              attachment: Buffer.from(transcript, 'utf8'),
              name: `ticket-${String(ticket.number).padStart(4, '0')}.txt`,
            },
          ]
        : [];
      await (log as TextChannel).send({ embeds: [summary], files }).catch(() => undefined);
    }
  }

  await interaction.editReply({
    embeds: [ok('Closed', 'This channel will be deleted in a few seconds.')],
  });

  /* Deleted last and on a delay, so the member sees the confirmation before the channel vanishes
   * under them. Everything that had to be kept is already stored. */
  setTimeout(() => {
    void channel?.delete().catch(() => undefined);
  }, 5_000);
}

/**
 * The conversation as plain text.
 *
 * Capped at 500 messages: a transcript is a record of a support conversation, and one longer than
 * that has a different problem than storage. Oldest first, because a transcript read bottom-up is
 * not a transcript.
 */
async function renderTranscript(channel: TextChannel): Promise<string> {
  const collected: string[] = [];
  let before: string | undefined;
  for (let page = 0; page < 5; page += 1) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (batch.size === 0) break;
    for (const message of batch.values()) {
      const when = message.createdAt.toISOString();
      const body = message.content || (message.embeds.length ? '[embed]' : '[no text]');
      const files = message.attachments.map((a) => ` [file: ${a.name}]`).join('');
      collected.push(`[${when}] ${message.author.tag}: ${body}${files}`);
    }
    before = batch.last()?.id;
    if (batch.size < 100) break;
  }
  return collected.reverse().join('\n');
}

/** `/ticket-setup` — points the feature at the channels it needs. */
export async function ticketSetup(db: Database, interaction: ChatInputCommandInteraction) {
  const category = interaction.options.getChannel('category', true);
  const log = interaction.options.getChannel('log_channel');
  const staff = interaction.options.getRole('staff_role');

  if (category.type !== ChannelType.GuildCategory) {
    await interaction.reply({
      embeds: [
        bad('Not a category', 'Pick the category that ticket channels should be created under.'),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await db.query(
    `INSERT INTO discord_guild_settings
       (guild_id, ticket_category_id, ticket_log_channel_id, ticket_staff_role_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (guild_id) DO UPDATE
       SET ticket_category_id = EXCLUDED.ticket_category_id,
           ticket_log_channel_id = coalesce(EXCLUDED.ticket_log_channel_id,
                                            discord_guild_settings.ticket_log_channel_id),
           ticket_staff_role_id = coalesce(EXCLUDED.ticket_staff_role_id,
                                           discord_guild_settings.ticket_staff_role_id),
           updated_at = now()`,
    [interaction.guildId, category.id, log?.id ?? null, staff?.id ?? null],
  );

  await interaction.reply({
    embeds: [
      ok(
        'Tickets configured',
        `Channels open under **${category.name}**.\n` +
          `Transcripts: ${log ? `<#${log.id}>` : 'not set — closed tickets are stored but not posted'}\n` +
          `Staff role: ${staff ? `<@&${staff.id}>` : 'not set — only administrators will see tickets'}`,
      ),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

/**
 * `/ticket-panel` — posts the two buttons members actually press.
 *
 * Separate from `/ticket-setup` so the panel can be reposted (or moved to another channel) years
 * later without touching the configuration, and so a server can put it exactly where it wants
 * rather than wherever setup happened to be run.
 */
export async function postTicketPanel(db: Database, interaction: ChatInputCommandInteraction) {
  const settings = await guildSettings(db, interaction.guildId!);
  if (!settings.ticket_category_id) {
    await interaction.reply({
      embeds: [
        bad(
          'Not configured yet',
          'Run `/ticket-setup` first, so the buttons have somewhere to open tickets.',
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const here = interaction.channel;
  if (!here?.isSendable()) {
    await interaction.reply({
      embeds: [bad('I cannot post here', 'Give me permission to send messages in this channel.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await here.send(ticketPanel());
  await interaction.reply({
    embeds: [ok('Panel posted', 'Members can open tickets from here now.')],
    flags: MessageFlags.Ephemeral,
  });
}
