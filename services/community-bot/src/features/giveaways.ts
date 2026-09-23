import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type TextChannel,
} from 'discord.js';
import type { Database } from '../db.js';
import { COLOR, absolute, bad, clip, embed, ok, parseDuration, relative } from '../ui.js';

/**
 * giveaways.ts — a prize, a deadline, and a button.
 *
 * The deadline lives in the database rather than in a `setTimeout`. A timer is a promise the
 * process can only keep while it is running, and a bot that restarts mid-giveaway would otherwise
 * leave a message counting down to nothing. The sweeper below re-reads the due rows every fifteen
 * seconds, so a restart costs at most fifteen seconds of lateness.
 */

const MAX_WINNERS = 20;

export async function startGiveaway(db: Database, interaction: ChatInputCommandInteraction) {
  const prize = interaction.options.getString('prize', true);
  const winnerCount = interaction.options.getInteger('winners') ?? 1;
  const durationRaw = interaction.options.getString('duration', true);

  const seconds = parseDuration(durationRaw);
  if (seconds === null) {
    await interaction.reply({
      embeds: [bad('I cannot read that duration', 'Try `30m`, `12h`, `3d` or `1d12h`.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (winnerCount < 1 || winnerCount > MAX_WINNERS) {
    await interaction.reply({
      embeds: [bad('Too many winners', `Between 1 and ${MAX_WINNERS}.`)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const endsAt = new Date(Date.now() + seconds * 1000);
  const id = randomUUID();

  await db.query(
    `INSERT INTO discord_giveaways
       (id, guild_id, channel_id, prize, winner_count, host_id, ends_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      interaction.guildId,
      interaction.channelId,
      clip(prize, 256),
      winnerCount,
      interaction.user.id,
      endsAt.toISOString(),
    ],
  );

  const here = interaction.channel;
  const posted = here?.isSendable()
    ? await here.send({
        embeds: [giveawayCard(clip(prize, 256), winnerCount, endsAt, interaction.user.id, 0)],
        components: [entryRow(id)],
      })
    : null;

  /* Written after the message exists. If the send fails there is a row with no message, which the
   * sweeper ends harmlessly with no entries -- far better than a live giveaway nobody recorded. */
  await db.query('UPDATE discord_giveaways SET message_id = $2 WHERE id = $1', [
    id,
    posted?.id ?? null,
  ]);

  await interaction.reply({
    embeds: [ok('Started', `Ends ${relative(endsAt)}.`)],
    flags: MessageFlags.Ephemeral,
  });
}

/** The Enter button. Pressing it twice does nothing the second time, by primary key. */
export async function enterGiveaway(
  db: Database,
  interaction: ButtonInteraction,
  giveawayId: string,
) {
  const giveaway = await db.query<{ ended_at: string | null; guild_id: string }>(
    'SELECT ended_at, guild_id FROM discord_giveaways WHERE id = $1',
    [giveawayId],
  );
  const row = giveaway.rows[0];
  if (!row || row.guild_id !== interaction.guildId) {
    await interaction.reply({
      embeds: [bad('Gone', 'That giveaway no longer exists.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (row.ended_at) {
    await interaction.reply({
      embeds: [bad('Already over', 'This giveaway has ended.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const inserted = await db.query(
    `INSERT INTO discord_giveaway_entries (giveaway_id, user_id)
     VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [giveawayId, interaction.user.id],
  );

  const total = await countEntries(db, giveawayId);
  await interaction.reply({
    embeds: [
      inserted.rowCount > 0
        ? ok('You are in', `Entry number ${total}. Good luck.`)
        : embed('Already entered', 'One entry each. You are on the list.', COLOR.quiet),
    ],
    flags: MessageFlags.Ephemeral,
  });

  // The count on the card is best-effort: a failed edit must not undo somebody's entry.
  await refreshCard(db, interaction.client, giveawayId).catch(() => undefined);
}

/** `/giveaway-end` — ends one early, by message id. */
export async function endGiveawayCommand(db: Database, interaction: ChatInputCommandInteraction) {
  const messageId = interaction.options.getString('message_id', true).trim();
  const found = await db.query<{ id: string }>(
    `SELECT id FROM discord_giveaways
      WHERE guild_id = $1 AND message_id = $2 AND ended_at IS NULL`,
    [interaction.guildId, messageId],
  );
  const id = found.rows[0]?.id;
  if (!id) {
    await interaction.reply({
      embeds: [bad('Not found', 'No live giveaway here has that message id.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const winners = await endGiveaway(db, interaction.client, id);
  await interaction.editReply({
    embeds: [ok('Ended', winners.length > 0 ? describeWinners(winners) : 'Nobody entered.')],
  });
}

/** `/giveaway-reroll` — a second draw that cannot land on the same people. */
export async function rerollGiveaway(db: Database, interaction: ChatInputCommandInteraction) {
  const messageId = interaction.options.getString('message_id', true).trim();
  const found = await db.query<{
    id: string;
    channel_id: string;
    winner_ids: string | null;
    prize: string;
  }>(
    `SELECT id, channel_id, winner_ids, prize FROM discord_giveaways
      WHERE guild_id = $1 AND message_id = $2 AND ended_at IS NOT NULL`,
    [interaction.guildId, messageId],
  );
  const row = found.rows[0];
  if (!row) {
    await interaction.reply({
      embeds: [bad('Not found', 'No ended giveaway here has that message id.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const previous = splitWinners(row.winner_ids);
  const drawn = await drawWinners(db, row.id, 1, previous);
  if (drawn.length === 0) {
    await interaction.reply({
      embeds: [bad('Nobody left', 'Everyone who entered has already won.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Appended, not replaced: the next reroll must exclude this one too.
  await db.query('UPDATE discord_giveaways SET winner_ids = $2 WHERE id = $1', [
    row.id,
    [...previous, ...drawn].join(','),
  ]);

  const channel = interaction.guild?.channels.cache.get(row.channel_id);
  if (channel?.isTextBased()) {
    await (channel as TextChannel)
      .send({
        content: drawn.map((winner) => `<@${winner}>`).join(' '),
        embeds: [ok('Reroll', `${describeWinners(drawn)} — you win **${clip(row.prize, 200)}**.`)],
      })
      .catch(() => undefined);
  }

  await interaction.reply({
    embeds: [ok('Rerolled', describeWinners(drawn))],
    flags: MessageFlags.Ephemeral,
  });
}

/**
 * Ends a giveaway: draws, announces, marks.
 *
 * The UPDATE carries `ended_at IS NULL` in its WHERE clause and everything downstream hangs off
 * whether it changed a row. That is what stops the sweeper and a `/giveaway-end` running a second
 * apart from announcing two sets of winners for one prize.
 */
export async function endGiveaway(db: Database, client: Client, id: string): Promise<string[]> {
  const claimed = await db.query<{
    channel_id: string;
    message_id: string | null;
    prize: string;
    winner_count: number;
    host_id: string;
  }>(
    `UPDATE discord_giveaways SET ended_at = now()
      WHERE id = $1 AND ended_at IS NULL
      RETURNING channel_id, message_id, prize, winner_count, host_id`,
    [id],
  );
  const row = claimed.rows[0];
  if (!row) return [];

  const winners = await drawWinners(db, id, row.winner_count, []);
  await db.query('UPDATE discord_giveaways SET winner_ids = $2 WHERE id = $1', [
    id,
    winners.join(',') || null,
  ]);

  const channel = await client.channels.fetch(row.channel_id).catch(() => null);
  if (channel?.isTextBased()) {
    const text = channel as TextChannel;
    if (row.message_id) {
      const message = await text.messages.fetch(row.message_id).catch(() => null);
      await message
        ?.edit({
          embeds: [
            embed(
              `Ended · ${clip(row.prize, 200)}`,
              winners.length > 0
                ? `Winner${winners.length === 1 ? '' : 's'}: ${describeWinners(winners)}`
                : 'Nobody entered.',
              COLOR.quiet,
            ).addFields({ name: 'Hosted by', value: `<@${row.host_id}>`, inline: true }),
          ],
          components: [],
        })
        .catch(() => undefined);
    }
    await text
      .send(
        winners.length > 0
          ? {
              content: winners.map((winner) => `<@${winner}>`).join(' '),
              embeds: [ok('Congratulations', `You win **${clip(row.prize, 200)}**.`)],
            }
          : {
              embeds: [
                embed('No entries', `**${clip(row.prize, 200)}** goes unclaimed.`, COLOR.quiet),
              ],
            },
      )
      .catch(() => undefined);
  }

  return winners;
}

/**
 * The sweeper. Ends everything whose deadline has passed, on a timer the process owns.
 *
 * Errors are swallowed per giveaway rather than per tick: one channel the bot can no longer post
 * in must not stop every other giveaway on the server from ending.
 */
export function startGiveawaySweeper(db: Database, client: Client): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const due = await db.query<{ id: string }>(
        'SELECT id FROM discord_giveaways WHERE ended_at IS NULL AND ends_at <= now() LIMIT 25',
      );
      for (const row of due.rows) {
        await endGiveaway(db, client, row.id).catch((error) => {
          console.error(`[giveaways] failed to end ${row.id}`, error);
        });
      }
    } catch (error) {
      console.error('[giveaways] sweeper tick failed', error);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), 15_000);
  timer.unref?.();
  void tick();
  return () => clearInterval(timer);
}

// ── internals ──────────────────────────────────────────────────────────────

function giveawayCard(
  prize: string,
  winnerCount: number,
  endsAt: Date,
  hostId: string,
  entries: number,
) {
  return embed(
    prize,
    `Press **Enter** below.\n\nEnds ${relative(endsAt)} · ${absolute(endsAt)}`,
  ).addFields(
    { name: 'Winners', value: String(winnerCount), inline: true },
    { name: 'Entries', value: String(entries), inline: true },
    { name: 'Hosted by', value: `<@${hostId}>`, inline: true },
  );
}

const entryRow = (id: string) =>
  new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`gw:enter:${id}`)
      .setLabel('Enter')
      .setEmoji('🎉')
      .setStyle(ButtonStyle.Primary),
  );

async function countEntries(db: Database, giveawayId: string): Promise<number> {
  const result = await db.query<{ total: string }>(
    'SELECT count(*)::text AS total FROM discord_giveaway_entries WHERE giveaway_id = $1',
    [giveawayId],
  );
  return Number(result.rows[0]?.total ?? 0);
}

/**
 * `ORDER BY random()` is the draw.
 *
 * Fine at this scale — a server giveaway is hundreds of rows, not millions — and it keeps the
 * selection in one statement rather than pulling every entrant into memory to shuffle.
 */
async function drawWinners(
  db: Database,
  giveawayId: string,
  count: number,
  exclude: string[],
): Promise<string[]> {
  const result = await db.query<{ user_id: string }>(
    `SELECT user_id FROM discord_giveaway_entries
      WHERE giveaway_id = $1 AND user_id <> ALL($2::text[])
      ORDER BY random() LIMIT $3`,
    [giveawayId, exclude, count],
  );
  return result.rows.map((row) => row.user_id);
}

async function refreshCard(db: Database, client: Client, giveawayId: string): Promise<void> {
  const found = await db.query<{
    channel_id: string;
    message_id: string | null;
    prize: string;
    winner_count: number;
    host_id: string;
    ends_at: string;
  }>(
    `SELECT channel_id, message_id, prize, winner_count, host_id, ends_at
       FROM discord_giveaways WHERE id = $1 AND ended_at IS NULL`,
    [giveawayId],
  );
  const row = found.rows[0];
  if (!row?.message_id) return;

  const channel = await client.channels.fetch(row.channel_id).catch(() => null);
  if (!channel?.isTextBased()) return;
  const message = await (channel as TextChannel).messages.fetch(row.message_id).catch(() => null);
  if (!message) return;

  const entries = await countEntries(db, giveawayId);
  await message.edit({
    embeds: [
      giveawayCard(row.prize, row.winner_count, new Date(row.ends_at), row.host_id, entries),
    ],
    components: [entryRow(giveawayId)],
  });
}

const splitWinners = (value: string | null): string[] =>
  (value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

const describeWinners = (ids: string[]) => ids.map((id) => `<@${id}>`).join(', ');
