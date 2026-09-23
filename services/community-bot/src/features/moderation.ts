import { randomUUID } from 'node:crypto';
import {
  MessageFlags,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type GuildMember,
  type TextChannel,
} from 'discord.js';
import { guildSettings, type Database } from '../db.js';
import { COLOR, bad, clip, embed, humanDuration, ok, parseDuration, relative } from '../ui.js';

/**
 * moderation.ts — warn, timeout, kick, ban, purge, and the record of all of it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * EVERY ACTION IS WRITTEN DOWN BEFORE IT IS TAKEN
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The row goes in first. A ban that succeeded but was never recorded is a ban nobody can explain
 * later, and "why is this person banned" is the question the table exists to answer. If Discord
 * then refuses the action the row is removed -- the opposite order would leave real bans missing
 * from their own history.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE BOT REFUSES WHAT DISCORD WOULD ALLOW
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Role hierarchy is checked here as well as by Discord, because Discord's error for "you cannot
 * touch that member" arrives as a generic 50013 that tells the moderator nothing. Checking first
 * turns it into a sentence.
 */

export type ModAction = 'warn' | 'timeout' | 'kick' | 'ban' | 'unban' | 'untimeout' | 'purge';

interface LogInput {
  readonly guildId: string;
  readonly targetId: string;
  readonly targetTag?: string | null;
  readonly moderatorId: string;
  readonly action: ModAction;
  readonly reason: string;
  readonly durationSeconds?: number | null;
}

async function record(db: Database, input: LogInput): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO discord_mod_actions
       (id, guild_id, target_id, target_tag, moderator_id, action, reason, duration_seconds)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      input.guildId,
      input.targetId,
      input.targetTag ? clip(input.targetTag, 64) : null,
      input.moderatorId,
      input.action,
      clip(input.reason, 512),
      input.durationSeconds ?? null,
    ],
  );
  return id;
}

/**
 * Posts to the mod-log if one is configured. A missing channel is not an error.
 *
 * Takes a wider type than `ModAction` because this is a heading, not a stored value: withdrawing
 * a warning updates a row rather than inserting one, so 'unwarn' is a thing the log announces and
 * deliberately not a thing the `action` CHECK accepts.
 */
async function announce(
  db: Database,
  interaction: ChatInputCommandInteraction,
  action: ModAction | 'unwarn',
  targetId: string,
  reason: string,
  extra?: string,
) {
  if (!interaction.guild) return;
  const settings = await guildSettings(db, interaction.guild.id);
  if (!settings.modlog_channel_id) return;
  const channel = interaction.guild.channels.cache.get(settings.modlog_channel_id);
  if (!channel?.isTextBased()) return;
  const colour = action === 'warn' ? COLOR.warn : action === 'unwarn' ? COLOR.good : COLOR.bad;
  const card = embed(action.toUpperCase(), undefined, colour)
    .addFields(
      { name: 'Member', value: `<@${targetId}>`, inline: true },
      { name: 'Moderator', value: `<@${interaction.user.id}>`, inline: true },
      ...(extra ? [{ name: 'Duration', value: extra, inline: true }] : []),
      { name: 'Reason', value: clip(reason, 1000) },
    )
    .setTimestamp(new Date());
  await (channel as TextChannel).send({ embeds: [card] }).catch(() => undefined);
}

/**
 * Whether this moderator may act on this member.
 *
 * Three refusals, in the order somebody would think of them. The self check first because it is
 * the most common mistake, then the bot, then the hierarchy -- which is the one Discord would
 * otherwise report as an unexplained permission error.
 */
function refuseReason(
  actor: GuildMember,
  target: GuildMember | null,
  botMember: GuildMember | null,
): string | null {
  if (!target) return null;
  if (target.id === actor.id) return 'You cannot moderate yourself.';
  if (target.id === botMember?.id) return 'I am not going to moderate myself.';
  if (target.id === target.guild.ownerId) return 'That member owns the server.';
  if (
    actor.id !== actor.guild.ownerId &&
    target.roles.highest.position >= actor.roles.highest.position
  ) {
    return 'That member has a role at or above yours, so you cannot act on them.';
  }
  if (botMember && target.roles.highest.position >= botMember.roles.highest.position) {
    return 'That member has a role above mine — move my role higher and try again.';
  }
  return null;
}

export async function warnMember(db: Database, interaction: ChatInputCommandInteraction) {
  const target = interaction.options.getMember('member') as GuildMember | null;
  const reason = interaction.options.getString('reason', true);
  const actor = interaction.member as GuildMember;
  const refusal = refuseReason(actor, target, interaction.guild?.members.me ?? null);
  if (!target || refusal) {
    await interaction.reply({
      embeds: [bad('Not done', refusal ?? 'That member is not in this server.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await record(db, {
    guildId: interaction.guildId!,
    targetId: target.id,
    targetTag: target.user.tag,
    moderatorId: interaction.user.id,
    action: 'warn',
    reason,
  });

  const count = await warningCount(db, interaction.guildId!, target.id);

  /* Told directly, and the failure is not treated as one. A member with DMs closed still gets
   * warned; the alternative is a moderator believing the action failed because a message bounced. */
  await target
    .send({
      embeds: [
        embed(
          `Warning in ${interaction.guild?.name ?? 'the server'}`,
          `${reason}\n\nThis is warning **${count}**.`,
          COLOR.warn,
        ),
      ],
    })
    .catch(() => undefined);

  await announce(db, interaction, 'warn', target.id, reason);
  await interaction.reply({
    embeds: [ok('Warned', `<@${target.id}> — warning **${count}**.\n${clip(reason, 500)}`)],
  });
}

export async function timeoutMember(db: Database, interaction: ChatInputCommandInteraction) {
  const target = interaction.options.getMember('member') as GuildMember | null;
  const durationInput = interaction.options.getString('duration', true);
  const reason = interaction.options.getString('reason', true);
  const actor = interaction.member as GuildMember;

  const seconds = parseDuration(durationInput);
  if (seconds === null) {
    await interaction.reply({
      embeds: [bad('Unreadable duration', 'Use a form like `10m`, `2h`, `1d` or `1h30m`.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  // Discord's own ceiling. Refused here so the error names the limit rather than the API code.
  if (seconds > 28 * 86_400) {
    await interaction.reply({
      embeds: [
        bad('Too long', 'Discord caps a timeout at 28 days. Use a ban for longer than that.'),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const refusal = refuseReason(actor, target, interaction.guild?.members.me ?? null);
  if (!target || refusal) {
    await interaction.reply({
      embeds: [bad('Not done', refusal ?? 'That member is not in this server.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const id = await record(db, {
    guildId: interaction.guildId!,
    targetId: target.id,
    targetTag: target.user.tag,
    moderatorId: interaction.user.id,
    action: 'timeout',
    reason,
    durationSeconds: seconds,
  });

  try {
    await target.timeout(seconds * 1000, clip(`${interaction.user.tag}: ${reason}`, 512));
  } catch {
    // The record described something that did not happen, so it goes.
    await db.query('DELETE FROM discord_mod_actions WHERE id = $1', [id]).catch(() => undefined);
    await interaction.reply({
      embeds: [
        bad('Discord refused it', 'I could not time that member out. Check my permissions.'),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const until = new Date(Date.now() + seconds * 1000);
  await announce(db, interaction, 'timeout', target.id, reason, humanDuration(seconds));
  await interaction.reply({
    embeds: [ok('Timed out', `<@${target.id}> until ${relative(until)}.\n${clip(reason, 500)}`)],
  });
}

export async function kickMember(db: Database, interaction: ChatInputCommandInteraction) {
  const target = interaction.options.getMember('member') as GuildMember | null;
  const reason = interaction.options.getString('reason', true);
  const actor = interaction.member as GuildMember;
  const refusal = refuseReason(actor, target, interaction.guild?.members.me ?? null);
  if (!target || refusal) {
    await interaction.reply({
      embeds: [bad('Not done', refusal ?? 'That member is not in this server.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const id = await record(db, {
    guildId: interaction.guildId!,
    targetId: target.id,
    targetTag: target.user.tag,
    moderatorId: interaction.user.id,
    action: 'kick',
    reason,
  });

  // DM first: after the kick they are no longer a member and the channel to reach them is gone.
  await target
    .send({
      embeds: [embed(`Removed from ${interaction.guild?.name ?? 'the server'}`, reason, COLOR.bad)],
    })
    .catch(() => undefined);

  try {
    await target.kick(clip(`${interaction.user.tag}: ${reason}`, 512));
  } catch {
    await db.query('DELETE FROM discord_mod_actions WHERE id = $1', [id]).catch(() => undefined);
    await interaction.reply({
      embeds: [bad('Discord refused it', 'I could not remove that member. Check my permissions.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await announce(db, interaction, 'kick', target.id, reason);
  await interaction.reply({ embeds: [ok('Kicked', `<@${target.id}>\n${clip(reason, 500)}`)] });
}

export async function banMember(db: Database, interaction: ChatInputCommandInteraction) {
  const user = interaction.options.getUser('member', true);
  const reason = interaction.options.getString('reason', true);
  const purgeDays = interaction.options.getInteger('purge_days') ?? 0;
  const actor = interaction.member as GuildMember;
  const target = interaction.options.getMember('member') as GuildMember | null;

  /* `target` is null when banning somebody who has already left, which is a legitimate thing to
   * do -- so a missing member is only checked for hierarchy, never required. */
  const refusal = refuseReason(actor, target, interaction.guild?.members.me ?? null);
  if (refusal) {
    await interaction.reply({
      embeds: [bad('Not done', refusal)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const id = await record(db, {
    guildId: interaction.guildId!,
    targetId: user.id,
    targetTag: user.tag,
    moderatorId: interaction.user.id,
    action: 'ban',
    reason,
  });

  await target
    ?.send({
      embeds: [embed(`Banned from ${interaction.guild?.name ?? 'the server'}`, reason, COLOR.bad)],
    })
    .catch(() => undefined);

  try {
    await interaction.guild?.members.ban(user.id, {
      reason: clip(`${interaction.user.tag}: ${reason}`, 512),
      deleteMessageSeconds: Math.min(7, Math.max(0, purgeDays)) * 86_400,
    });
  } catch {
    await db.query('DELETE FROM discord_mod_actions WHERE id = $1', [id]).catch(() => undefined);
    await interaction.reply({
      embeds: [bad('Discord refused it', 'I could not ban that account. Check my permissions.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await announce(db, interaction, 'ban', user.id, reason);
  await interaction.reply({ embeds: [ok('Banned', `<@${user.id}>\n${clip(reason, 500)}`)] });
}

/**
 * Deletes recent messages in this channel.
 *
 * Discord's bulk delete refuses anything older than fourteen days, so the count reported is what
 * actually went rather than what was asked for -- a moderator who is told "50 deleted" when nine
 * survived will not look again.
 */
export async function purgeMessages(db: Database, interaction: ChatInputCommandInteraction) {
  const amount = interaction.options.getInteger('amount', true);
  const from = interaction.options.getUser('from');
  const channel = interaction.channel;
  if (!channel || !('bulkDelete' in channel)) {
    await interaction.reply({
      embeds: [bad('Wrong channel', 'That only works in a normal text channel.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const fetched = await channel.messages.fetch({ limit: Math.min(100, Math.max(1, amount)) });
  const cutoff = Date.now() - 14 * 86_400 * 1000;
  const doomed = [...fetched.values()].filter(
    (message) => message.createdTimestamp > cutoff && (!from || message.author.id === from.id),
  );
  if (doomed.length === 0) {
    await interaction.editReply({
      embeds: [
        bad('Nothing to delete', 'Discord will not bulk delete messages older than fourteen days.'),
      ],
    });
    return;
  }
  const deleted = await channel.bulkDelete(doomed, true);

  await record(db, {
    guildId: interaction.guildId!,
    targetId: from?.id ?? interaction.user.id,
    targetTag: from?.tag ?? null,
    moderatorId: interaction.user.id,
    action: 'purge',
    // Every channel that can bulk delete has a name; the ternary that stood here was dead.
    reason: `${deleted.size} messages in #${channel.name}`,
  });

  await interaction.editReply({
    embeds: [ok('Purged', `Deleted **${deleted.size}** message${deleted.size === 1 ? '' : 's'}.`)],
  });
}

async function warningCount(db: Database, guildId: string, userId: string): Promise<number> {
  const result = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM discord_mod_actions
      WHERE guild_id = $1 AND target_id = $2 AND action = 'warn' AND revoked_at IS NULL`,
    [guildId, userId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

/** `/history` — what this server has already done about this member. */
export async function modHistory(db: Database, interaction: ChatInputCommandInteraction) {
  const user = interaction.options.getUser('member', true);
  const result = await db.query<{
    action: string;
    reason: string;
    moderator_id: string;
    duration_seconds: number | null;
    revoked_at: Date | null;
    created_at: Date;
  }>(
    `SELECT action, reason, moderator_id, duration_seconds, revoked_at, created_at
       FROM discord_mod_actions
      WHERE guild_id = $1 AND target_id = $2
      ORDER BY created_at DESC LIMIT 15`,
    [interaction.guildId, user.id],
  );

  if (result.rows.length === 0) {
    await interaction.reply({
      embeds: [ok('Nothing on record', `<@${user.id}> has no moderation history here.`)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const active = result.rows.filter((r) => r.action === 'warn' && !r.revoked_at).length;
  const lines = result.rows.map((row) => {
    const when = relative(row.created_at);
    const length = row.duration_seconds ? ` · ${humanDuration(row.duration_seconds)}` : '';
    const struck = row.revoked_at ? ' · *withdrawn*' : '';
    return `**${row.action}**${length} · <@${row.moderator_id}> · ${when}${struck}\n${clip(row.reason, 180)}`;
  });

  await interaction.reply({
    embeds: [
      embed(`History · ${user.tag}`, lines.join('\n\n'), COLOR.quiet).setFooter({
        text: `${active} active warning${active === 1 ? '' : 's'} · showing the last ${result.rows.length}`,
      }),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

/**
 * `/unwarn` — withdraws the most recent active warning.
 *
 * The row is UPDATEd, never deleted: the table carries a BEFORE DELETE trigger precisely so that
 * a withdrawn warning stays legible as a thing that happened and was taken back. A history that
 * can be emptied is not a history, and "were they warned before?" is the only question it exists
 * to answer.
 */
export async function revokeWarning(db: Database, interaction: ChatInputCommandInteraction) {
  const user = interaction.options.getUser('member', true);
  const reason = interaction.options.getString('reason') ?? 'No reason given';

  /* The subquery picks one row. Without the LIMIT this would withdraw every warning the member
   * has, which is a different command and not the one anybody typed. */
  const revoked = await db.query<{ reason: string; created_at: Date }>(
    `UPDATE discord_mod_actions
        SET revoked_at = now(), revoked_by = $3
      WHERE id = (
        SELECT id FROM discord_mod_actions
         WHERE guild_id = $1 AND target_id = $2 AND action = 'warn' AND revoked_at IS NULL
         ORDER BY created_at DESC LIMIT 1
      )
      RETURNING reason, created_at`,
    [interaction.guildId, user.id, interaction.user.id],
  );

  const row = revoked.rows[0];
  if (!row) {
    await interaction.reply({
      embeds: [bad('Nothing to withdraw', `<@${user.id}> has no active warnings here.`)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const remaining = await db.query<{ total: string }>(
    `SELECT count(*)::text AS total FROM discord_mod_actions
      WHERE guild_id = $1 AND target_id = $2 AND action = 'warn' AND revoked_at IS NULL`,
    [interaction.guildId, user.id],
  );

  await interaction.reply({
    embeds: [
      ok(
        'Warning withdrawn',
        `The warning from ${relative(row.created_at)} no longer counts.
` +
          `> ${clip(row.reason, 180)}

` +
          `${remaining.rows[0]?.total ?? '0'} active warning(s) remain.`,
      ),
    ],
  });

  await announce(db, interaction, 'unwarn', user.id, reason);
}

/** The permission every moderation command is gated on, applied at registration. */
export const MOD_PERMISSIONS = PermissionFlagsBits.ModerateMembers;
