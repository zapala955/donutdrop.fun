import {
  MessageFlags,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
} from 'discord.js';
import type { Database } from '../db.js';
import { COLOR, bad, embed, ok, relative } from '../ui.js';

/**
 * invites.ts — which invite somebody came through, and who made it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * HOW THIS IS EVEN POSSIBLE
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Discord does not say. The join event carries no invite, and no endpoint will tell you
 * afterwards. Every bot that does this works the same way: hold the use count of every invite,
 * and when somebody joins, fetch them all again and find the counter that moved.
 *
 * That means the answer is inferred, not reported, and it can genuinely be unavailable — see
 * `attribute` below. When it is, this records `unknown` rather than picking the most likely
 * candidate. A leaderboard that silently credits the wrong person is worse than one that admits
 * a gap, because nobody can tell the difference until someone is accused of faking invites.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE SNAPSHOT IS IN POSTGRES, NOT IN A MAP
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Held in memory, the first person to join after every restart would be unattributable, because
 * there would be nothing to compare the fresh counts against. Deploys are frequent enough that
 * this would be a visible hole rather than a theoretical one.
 */

/** What the bot needs to read invites at all. Checked so the failure is a sentence, not silence. */
const NEEDS_PERMISSION = 'Manage Server';

export interface Attribution {
  readonly source: 'invite' | 'vanity' | 'bot' | 'unknown';
  readonly code: string | null;
  readonly inviterId: string | null;
}

/**
 * Re-reads every invite and writes the counts down.
 *
 * Called on startup and after each join. Returns false when the invites could not be read at all,
 * which is almost always the missing permission rather than an outage.
 */
export async function refreshSnapshot(db: Database, guild: Guild): Promise<boolean> {
  const live = await fetchInvites(guild);
  if (!live) return false;

  await db.transaction(async (client) => {
    for (const invite of live) {
      await client.query(
        `INSERT INTO discord_invite_snapshots (guild_id, code, inviter_id, uses, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (guild_id, code) DO UPDATE
           SET uses = EXCLUDED.uses, inviter_id = EXCLUDED.inviter_id, updated_at = now()`,
        [guild.id, invite.code, invite.inviterId, invite.uses],
      );
    }
    /* Invites Discord no longer lists are dropped, so a code that is deleted and later recreated
     * starts from zero here as it does there. Attributions already recorded keep their code --
     * they are history, and history does not change because a link was revoked. */
    const codes = live.map((invite) => invite.code);
    await client.query(
      'DELETE FROM discord_invite_snapshots WHERE guild_id = $1 AND code <> ALL($2::text[])',
      [guild.id, codes],
    );
  });
  return true;
}

/**
 * Works out how a member got in, and records it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THE JOINS ARE HANDLED ONE AT A TIME
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The method is "diff the counters", and two joins being processed concurrently would both fetch
 * the post-both state and each see two counters move, or one see none. Serialising per guild
 * turns a race that silently misattributes into a queue that is correct. Joins arrive slowly
 * enough that the queue is never long.
 */
export async function attributeJoin(db: Database, member: GuildMember): Promise<Attribution> {
  return enqueue(member.guild.id, async () => {
    const attribution = await attribute(db, member);
    await recordJoin(db, member, attribution);
    return attribution;
  });
}

async function attribute(db: Database, member: GuildMember): Promise<Attribution> {
  // A bot is added through OAuth, not an invite link. Crediting somebody for it would be wrong.
  if (member.user.bot) return { source: 'bot', code: null, inviterId: null };

  const before = await db.query<{ code: string; inviter_id: string | null; uses: number }>(
    'SELECT code, inviter_id, uses FROM discord_invite_snapshots WHERE guild_id = $1',
    [member.guild.id],
  );
  const previous = new Map(before.rows.map((row) => [row.code, row]));

  const live = await fetchInvites(member.guild);
  if (!live) return { source: 'unknown', code: null, inviterId: null };

  // Written back before the answer is worked out, so a throw below cannot leave the snapshot
  // stale and misattribute the NEXT person too.
  await refreshFrom(db, member.guild.id, live);

  const used = chooseUsedInvite(
    new Map([...previous].map(([code, row]) => [code, row.uses])),
    live,
  );
  if (used) return { source: 'invite', code: used.code, inviterId: used.inviterId };

  if (await usedVanity(member.guild, previous.size)) {
    return { source: 'vanity', code: null, inviterId: null };
  }

  return { source: 'unknown', code: null, inviterId: null };
}

/**
 * Picks the one invite whose use count went up, or nothing.
 *
 * Split out and exported because this is the entire inference, and everything it can get wrong is
 * a person being credited for an invite that was not theirs.
 *
 * EXACTLY ONE counter must have moved. Two or more means joins this process did not serialise --
 * someone joining while the bot was restarting, most often -- and there is no way to tell which
 * invite belongs to the member in hand. None means the invite was deleted between the join and
 * the fetch, or it was the vanity URL. Each of those returns null so the caller records the join
 * as unattributed, which is the honest answer and the one a leaderboard can survive.
 *
 * An invite that is brand new since the snapshot counts as moved only if it has actually been
 * used, which is why the fallback is 0 rather than the invite's own count.
 */
export function chooseUsedInvite(
  previousUses: ReadonlyMap<string, number>,
  live: readonly LiveInvite[],
): LiveInvite | null {
  const moved = live.filter((invite) => invite.uses > (previousUses.get(invite.code) ?? 0));
  return moved.length === 1 ? moved[0]! : null;
}

/**
 * Writes the attribution down, keeping the FIRST one if this member has been here before.
 *
 * Rejoining is the cheapest way to inflate an invite count, and the count is the thing people
 * compete over. The original inviter keeps the credit and `join_count` records the churn, so a
 * leaderboard reflects arrivals rather than laps.
 */
async function recordJoin(
  db: Database,
  member: GuildMember,
  attribution: Attribution,
): Promise<void> {
  await db.query(
    `INSERT INTO discord_invited_members
       (guild_id, member_id, code, inviter_id, source)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (guild_id, member_id) DO UPDATE
       SET last_joined_at = now(),
           join_count = discord_invited_members.join_count + 1,
           left_at = NULL`,
    [member.guild.id, member.id, attribution.code, attribution.inviterId, attribution.source],
  );
}

/** Marks a departure. The row stays so "still here" can be answered. */
export async function recordLeave(db: Database, guildId: string, memberId: string): Promise<void> {
  await db.query(
    `UPDATE discord_invited_members SET left_at = now()
      WHERE guild_id = $1 AND member_id = $2 AND left_at IS NULL`,
    [guildId, memberId],
  );
}

/** Keeps the snapshot current when an invite is made or revoked while the bot is watching. */
export async function noteInviteCreated(
  db: Database,
  guildId: string,
  code: string,
  inviterId: string | null,
  uses: number,
): Promise<void> {
  await db.query(
    `INSERT INTO discord_invite_snapshots (guild_id, code, inviter_id, uses, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (guild_id, code) DO UPDATE
       SET uses = EXCLUDED.uses, inviter_id = EXCLUDED.inviter_id, updated_at = now()`,
    [guildId, code, inviterId, uses],
  );
}

export async function noteInviteDeleted(
  db: Database,
  guildId: string,
  code: string,
): Promise<void> {
  await db.query('DELETE FROM discord_invite_snapshots WHERE guild_id = $1 AND code = $2', [
    guildId,
    code,
  ]);
}

// ── the commands ───────────────────────────────────────────────────────────

/** `/invites` — one person's tally. */
export async function showInvites(db: Database, interaction: ChatInputCommandInteraction) {
  const target = interaction.options.getUser('member') ?? interaction.user;

  const tally = await db.query<{ total: string; here: string; left: string; rejoins: string }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE left_at IS NULL)::text AS here,
            count(*) FILTER (WHERE left_at IS NOT NULL)::text AS left,
            coalesce(sum(join_count - 1), 0)::text AS rejoins
       FROM discord_invited_members
      WHERE guild_id = $1 AND inviter_id = $2`,
    [interaction.guildId, target.id],
  );
  const row = tally.rows[0];
  const total = Number(row?.total ?? 0);

  const card = embed(`Invites · ${target.tag}`)
    .setThumbnail(target.displayAvatarURL())
    .addFields(
      { name: 'Brought in', value: String(total), inline: true },
      { name: 'Still here', value: String(row?.here ?? 0), inline: true },
      { name: 'Left since', value: String(row?.left ?? 0), inline: true },
    );

  if (Number(row?.rejoins ?? 0) > 0) {
    // Surfaced rather than buried: rejoins are how an invite count gets padded.
    card.addFields({
      name: 'Rejoins',
      value: `${row?.rejoins} — counted once each, not per join.`,
    });
  }
  if (total === 0) {
    card.setDescription('Nobody yet. Only joins the bot could attribute are counted.');
    card.setColor(COLOR.quiet);
  }

  await interaction.reply({ embeds: [card] });
}

/** `/invite-leaderboard` — the top ten, by people who actually stayed. */
export async function inviteLeaderboard(db: Database, interaction: ChatInputCommandInteraction) {
  const rows = await db.query<{ inviter_id: string; total: string; here: string }>(
    `SELECT inviter_id, count(*)::text AS total,
            count(*) FILTER (WHERE left_at IS NULL)::text AS here
       FROM discord_invited_members
      WHERE guild_id = $1 AND inviter_id IS NOT NULL
      GROUP BY inviter_id
      ORDER BY count(*) FILTER (WHERE left_at IS NULL) DESC, count(*) DESC
      LIMIT 10`,
    [interaction.guildId],
  );

  if (rows.rows.length === 0) {
    await interaction.reply({
      embeds: [
        embed(
          'No invites tracked yet',
          'Nobody has been attributed to an invite so far. Tracking starts from when the bot ' +
            'joined — it cannot work out who invited the people already here.',
          COLOR.quiet,
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const medals = ['🥇', '🥈', '🥉'];
  const lines = rows.rows.map((row, index) => {
    const rank = medals[index] ?? `\`${String(index + 1).padStart(2, ' ')}\``;
    return `${rank} <@${row.inviter_id}> — **${row.here}** still here (${row.total} total)`;
  });

  await interaction.reply({
    // Ordered by who stayed, because that is the number worth competing over.
    embeds: [
      embed('Invite leaderboard', lines.join('\n')).setFooter({
        text: 'Ranked by members still in the server.',
      }),
    ],
  });
}

/** `/invite-check` — where one member came from, for staff looking at a raid. */
export async function whoInvited(db: Database, interaction: ChatInputCommandInteraction) {
  const target = interaction.options.getUser('member', true);
  const found = await db.query<{
    code: string | null;
    inviter_id: string | null;
    source: string;
    first_joined_at: Date;
    join_count: number;
    left_at: Date | null;
  }>(
    `SELECT code, inviter_id, source, first_joined_at, join_count, left_at
       FROM discord_invited_members WHERE guild_id = $1 AND member_id = $2`,
    [interaction.guildId, target.id],
  );
  const row = found.rows[0];

  if (!row) {
    await interaction.reply({
      embeds: [
        bad(
          'Nothing recorded',
          `**${target.tag}** joined before the bot started tracking, or has never been here.`,
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const origin =
    row.source === 'invite'
      ? `<@${row.inviter_id}> — \`${row.code}\``
      : row.source === 'vanity'
        ? "The server's vanity URL"
        : row.source === 'bot'
          ? 'Added as a bot, not through an invite'
          : 'Could not be determined';

  await interaction.reply({
    embeds: [
      embed(
        `Origin · ${target.tag}`,
        undefined,
        row.source === 'invite' ? COLOR.brand : COLOR.quiet,
      ).addFields(
        { name: 'Invited by', value: origin },
        { name: 'First joined', value: relative(row.first_joined_at), inline: true },
        { name: 'Joins', value: String(row.join_count), inline: true },
        {
          name: 'Status',
          value: row.left_at ? `Left ${relative(row.left_at)}` : 'In the server',
          inline: true,
        },
      ),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

/** `/invite-sync` — re-read the counters, and say plainly if the permission is missing. */
export async function syncInvites(db: Database, interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guild = interaction.guild;
  if (!guild) return;

  if (await refreshSnapshot(db, guild)) {
    const counted = await db.query<{ total: string }>(
      'SELECT count(*)::text AS total FROM discord_invite_snapshots WHERE guild_id = $1',
      [guild.id],
    );
    await interaction.editReply({
      embeds: [ok('Synced', `Watching ${counted.rows[0]?.total ?? 0} invite(s).`)],
    });
    return;
  }

  await interaction.editReply({
    embeds: [
      bad(
        'I cannot read the invites',
        `Invite tracking needs the **${NEEDS_PERMISSION}** permission. Without it every join is ` +
          'recorded as "unknown".',
      ),
    ],
  });
}

// ── internals ──────────────────────────────────────────────────────────────

export interface LiveInvite {
  readonly code: string;
  readonly inviterId: string | null;
  readonly uses: number;
}

async function fetchInvites(guild: Guild): Promise<LiveInvite[] | null> {
  try {
    const invites = await guild.invites.fetch();
    return invites.map((invite) => ({
      code: invite.code,
      inviterId: invite.inviter?.id ?? null,
      uses: invite.uses ?? 0,
    }));
  } catch {
    // Missing Manage Server, almost always. The caller turns this into a message.
    return null;
  }
}

async function refreshFrom(db: Database, guildId: string, live: LiveInvite[]): Promise<void> {
  await db.transaction(async (client) => {
    for (const invite of live) {
      await client.query(
        `INSERT INTO discord_invite_snapshots (guild_id, code, inviter_id, uses, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (guild_id, code) DO UPDATE
           SET uses = EXCLUDED.uses, inviter_id = EXCLUDED.inviter_id, updated_at = now()`,
        [guildId, invite.code, invite.inviterId, invite.uses],
      );
    }
    await client.query(
      'DELETE FROM discord_invite_snapshots WHERE guild_id = $1 AND code <> ALL($2::text[])',
      [guildId, live.map((invite) => invite.code)],
    );
  });
}

/**
 * Whether the vanity URL is the likely explanation for a join nothing else accounts for.
 *
 * Deliberately weak: Discord reports vanity uses as a lifetime total that does not line up with
 * the per-invite counters, so this only asks whether the server HAS one. Called solely when no
 * ordinary invite moved, so the alternative is `unknown` either way.
 */
async function usedVanity(guild: Guild, knownInvites: number): Promise<boolean> {
  if (!guild.features.includes('VANITY_URL')) return false;
  if (knownInvites === 0) return true;
  try {
    const vanity = await guild.fetchVanityData();
    return Boolean(vanity.code);
  } catch {
    return false;
  }
}

/**
 * A one-at-a-time queue per guild.
 *
 * Each call chains onto the previous one's promise, so the counter diff in `attribute` never runs
 * against a state another join is halfway through changing. The catch keeps one failure from
 * poisoning the chain for every join after it.
 */
const queues = new Map<string, Promise<unknown>>();

function enqueue<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.then(work, work);
  queues.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}
