import {
  MessageFlags,
  type ChatInputCommandInteraction,
  type Client,
  type EmbedBuilder,
  type Guild,
} from 'discord.js';
import type { PlatformApi } from '../api-client.js';
import { guildSettings, type Database } from '../db.js';
import { COLOR, bad, embed, ok, warn } from '../ui.js';
import { buildDailyInviteDm } from './daily-codes.js';
import { currentOwners } from './welcome-dm.js';

/**
 * daily-invite.ts — `/daily-invite`: one first message about daily codes, to every member.
 *
 * The message says what daily codes are and carries a button that turns them on (the same button the
 * welcome DM has). An owner can look at it first (`preview`), send it to everybody who has not had
 * it (`send`), watch it (`status`) and stop it (`stop`).
 *
 * Sending to a whole server is the one thing a bot can do that Discord watches closely, so this is
 * built to be slow and careful rather than fast:
 *
 *   - ONE message per member, ever. Each member is recorded (`discord_daily_invites`) BEFORE the
 *     send, by one guarded statement, so a restart resumes where it stopped, running it twice sends
 *     nothing new, and a member who already has daily codes, or already got the welcome DM's offer,
 *     is skipped.
 *   - one message every few seconds, with a little jitter, never in bursts;
 *   - it STOPS at the first thing Discord does not call an ordinary closed DM (rate limits, a
 *     flagged account, anything unexpected), puts that member back so they are not lost, and says
 *     why. It never retries into a wall;
 *   - it re-reads the dashboard's switch before every send, so turning daily codes off stops it;
 *   - owners only, by the very same rule as `/test`.
 */

/** Between two messages: this plus up to JITTER_MS more. A member every ~3 seconds. */
const SPACING_MS = 2_500;
const JITTER_MS = 1_000;
const PAGE = 1_000;

/** Discord's "cannot send messages to this user", and "unknown user": ordinary, not faults. */
const CANNOT_DM = 50007;
const UNKNOWN_USER = 10013;
const codeOf = (error: unknown) =>
  typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;

export interface InviteJob {
  readonly guildId: string;
  readonly startedBy: string;
  readonly startedAt: number;
  /** How many members this run set out to reach. */
  readonly total: number;
  sent: number;
  closed: number;
  skipped: number;
  running: boolean;
  stopRequested: boolean;
  endedAt: number | null;
  /** Why it ended, in words an owner can act on. Null while it is running. */
  endReason: string | null;
}

const jobs = new Map<string, InviteJob>();
export const inviteJob = (guildId: string): InviteJob | undefined => jobs.get(guildId);
/** For tests: forget every job. */
export const forgetInviteJobs = () => jobs.clear();

export interface Pacing {
  readonly spacingMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: () => number;
  readonly now: () => number;
}
const realPacing: Pacing = {
  spacingMs: SPACING_MS,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
  now: Date.now,
};

// ── who is left to invite ──────────────────────────────────────────────────

/** Every human member's id, read a page at a time. Bots are never invited. */
export async function humanMemberIds(guild: Guild): Promise<string[]> {
  const ids: string[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await guild.members.list({ limit: PAGE, ...(after ? { after } : {}) });
    for (const member of page.values()) {
      if (!member.user.bot) ids.push(member.id);
    }
    after = page.lastKey();
    if (page.size < PAGE || !after) break;
  }
  return ids;
}

/** Everybody who has not been invited and does not already have daily codes. */
export async function pendingRecipients(
  db: Database,
  guildId: string,
  memberIds: readonly string[],
): Promise<string[]> {
  const done = await db.query<{ discord_user_id: string }>(
    `SELECT discord_user_id FROM discord_daily_invites WHERE guild_id = $1
     UNION
     SELECT discord_user_id FROM discord_daily_subscribers WHERE guild_id = $1`,
    [guildId],
  );
  const skip = new Set(done.rows.map((row) => row.discord_user_id));
  return memberIds.filter((id) => !skip.has(id));
}

// ── the broadcast ──────────────────────────────────────────────────────────

type InviteMessage = ReturnType<typeof buildDailyInviteDm>;

/** The summary an owner is DMed when a run ends, and `status` shows while it runs. */
export function describeJob(job: InviteJob): EmbedBuilder {
  const lines = [
    `Sent: **${job.sent}** · DMs closed: **${job.closed}** · skipped: **${job.skipped}** · ` +
      `of **${job.total}** this run.`,
  ];
  if (job.running) {
    return embed('Daily invites: sending', lines.join('\n'));
  }
  lines.push(job.endReason ?? 'Finished');
  const clean = job.endReason === 'Finished';
  return (clean ? ok : warn)(
    clean ? 'Daily invites: done' : 'Daily invites: stopped',
    lines.join('\n'),
  );
}

/**
 * Sends the invitation to each recipient in turn. Never throws: whatever goes wrong becomes the
 * job's `endReason`, and the starter is told.
 */
export async function runInvite(
  db: Database,
  client: Client,
  job: InviteJob,
  recipients: readonly string[],
  message: InviteMessage,
  pacing: Pacing = realPacing,
): Promise<void> {
  try {
    for (const id of recipients) {
      if (job.stopRequested) {
        job.endReason = 'Stopped by an owner. Run `/daily-invite send` again to carry on.';
        break;
      }
      if (!(await guildSettings(db, job.guildId)).daily_codes_enabled) {
        job.endReason = 'Daily codes were switched off in the dashboard.';
        break;
      }
      // Claimed first, by one statement; and not for somebody who has turned codes on meanwhile.
      const claimed = await db.query(
        `INSERT INTO discord_daily_invites (guild_id, discord_user_id)
         SELECT $1::varchar, $2::varchar
          WHERE NOT EXISTS (SELECT 1 FROM discord_daily_subscribers
                             WHERE guild_id = $1 AND discord_user_id = $2)
         ON CONFLICT (guild_id, discord_user_id) DO NOTHING
         RETURNING discord_user_id`,
        [job.guildId, id],
      );
      if (claimed.rowCount === 0) {
        job.skipped += 1;
        continue;
      }
      try {
        const user = await client.users.fetch(id);
        await user.send(message);
        await settle(db, job.guildId, id, 'sent');
        job.sent += 1;
      } catch (error) {
        const reason = codeOf(error);
        if (reason === CANNOT_DM || reason === UNKNOWN_USER) {
          await settle(db, job.guildId, id, 'closed');
          job.closed += 1;
        } else {
          // Not an ordinary closed DM: give the member back and stop, rather than push on.
          await db.query(
            `DELETE FROM discord_daily_invites
              WHERE guild_id = $1 AND discord_user_id = $2 AND outcome = 'claimed'`,
            [job.guildId, id],
          );
          job.endReason =
            `Discord refused a message (${error instanceof Error ? error.message : 'unknown error'}). ` +
            'Nothing was lost: run `/daily-invite send` again later to carry on.';
          break;
        }
      }
      await pacing.sleep(pacing.spacingMs + Math.floor(pacing.random() * JITTER_MS));
    }
    job.endReason ??= 'Finished';
  } catch (error) {
    job.endReason = `It failed (${error instanceof Error ? error.message : 'unknown error'}). Run \`/daily-invite send\` again to carry on.`;
  } finally {
    job.running = false;
    job.endedAt = pacing.now();
  }
}

async function settle(
  db: Database,
  guildId: string,
  memberId: string,
  outcome: 'sent' | 'closed',
): Promise<void> {
  await db.query(
    `UPDATE discord_daily_invites SET outcome = $3, updated_at = now()
      WHERE guild_id = $1 AND discord_user_id = $2`,
    [guildId, memberId, outcome],
  );
}

// ── the command ────────────────────────────────────────────────────────────

export interface InviteCommandOptions {
  readonly siteUrl: string;
  readonly extraOwnerIds: readonly string[];
  readonly pacing?: Pacing;
  /** Called with the finished job, to tell the person who started it. Defaults to a DM. */
  readonly onFinished?: (job: InviteJob) => Promise<void>;
}

export async function dailyInviteCommand(
  db: Database,
  api: PlatformApi | null,
  interaction: ChatInputCommandInteraction,
  options: InviteCommandOptions,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply({ embeds: [bad('Server only', 'Run this inside the server.')] });
    return;
  }
  const owners = await currentOwners(db, interaction, options.extraOwnerIds);
  if (!owners.includes(interaction.user.id)) {
    await interaction.editReply({
      embeds: [bad('Owners only', 'Only the server owner can run this.')],
    });
    return;
  }

  const sub = interaction.options.getSubcommand();
  const current = inviteJob(guild.id);

  if (sub === 'status') {
    const counts = await db.query<{ outcome: string; n: string }>(
      `SELECT outcome, count(*)::text AS n FROM discord_daily_invites
        WHERE guild_id = $1 GROUP BY outcome`,
      [guild.id],
    );
    const by = (outcome: string) => counts.rows.find((row) => row.outcome === outcome)?.n ?? '0';
    const subscribers = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM discord_daily_subscribers WHERE guild_id = $1',
      [guild.id],
    );
    const totals =
      `Ever invited: **${by('sent')}** reached, **${by('closed')}** with closed DMs. ` +
      `Daily codes on for **${subscribers.rows[0]?.n ?? '0'}** members.`;
    await interaction.editReply({
      embeds: [
        current
          ? describeJob(current).addFields({ name: 'All time', value: totals })
          : embed('Daily invites', `Nothing running. ${totals}`, COLOR.quiet),
      ],
    });
    return;
  }

  if (sub === 'stop') {
    if (!current?.running) {
      await interaction.editReply({
        embeds: [embed('Nothing to stop', 'No invitations are being sent.', COLOR.quiet)],
      });
      return;
    }
    current.stopRequested = true;
    await interaction.editReply({
      embeds: [warn('Stopping', 'It stops before the next message. You will get a DM summary.')],
    });
    return;
  }

  const maxPrizeMinor =
    (await api?.rewardStatus(interaction.user.id).catch(() => null))?.dailyCodes?.maxPrizeMinor ??
    null;
  const message = buildDailyInviteDm({ siteUrl: options.siteUrl, maxPrizeMinor });

  if (sub === 'preview') {
    try {
      const user = await interaction.client.users.fetch(interaction.user.id);
      await user.send({
        content: '**Preview** — this is the message members get, once.',
        ...message,
      });
      await interaction.editReply({ embeds: [ok('Preview sent', 'Check your DMs.')] });
    } catch (error) {
      if (codeOf(error) !== CANNOT_DM) throw error;
      await interaction.editReply({
        embeds: [bad('Could not DM you', 'Your DMs are closed, so there is nowhere to send it.')],
      });
    }
    return;
  }

  // `send`
  if (current?.running) {
    await interaction.editReply({
      embeds: [describeJob(current).setFooter({ text: 'Already running. `stop` ends it.' })],
    });
    return;
  }
  const settings = await guildSettings(db, guild.id);
  if (!settings.daily_codes_enabled) {
    await interaction.editReply({
      embeds: [
        bad(
          'Switch daily codes on first',
          'Turn on “Send daily codes” in the dashboard (Programs → Discord bot). Until then the ' +
            'button in the message would only say “not yet”.',
        ),
      ],
    });
    return;
  }

  const everyone = await humanMemberIds(guild);
  let recipients = await pendingRecipients(db, guild.id, everyone);
  const outstanding = recipients.length;
  const limit = interaction.options.getInteger('count');
  if (limit && limit > 0) recipients = recipients.slice(0, limit);
  if (recipients.length === 0) {
    await interaction.editReply({
      embeds: [
        ok(
          'Nobody left',
          `All **${everyone.length}** members have already been invited or have daily codes.`,
        ),
      ],
    });
    return;
  }

  const pacing = options.pacing ?? realPacing;
  const job: InviteJob = {
    guildId: guild.id,
    startedBy: interaction.user.id,
    startedAt: pacing.now(),
    total: recipients.length,
    sent: 0,
    closed: 0,
    skipped: 0,
    running: true,
    stopRequested: false,
    endedAt: null,
    endReason: null,
  };
  jobs.set(guild.id, job);
  const minutes = Math.max(
    1,
    Math.round((recipients.length * (pacing.spacingMs + JITTER_MS / 2)) / 60_000),
  );
  void runInvite(db, interaction.client, job, recipients, message, pacing).then(() =>
    (options.onFinished ?? ((finished) => tellStarter(interaction.client, finished)))(job).catch(
      () => undefined,
    ),
  );

  await interaction.editReply({
    embeds: [
      ok(
        'Sending',
        `Inviting **${recipients.length}** members` +
          (outstanding > recipients.length ? ` (of ${outstanding} still to do)` : '') +
          `, one every few seconds: about **${minutes} min**. ` +
          'Watch it with `/daily-invite status`, end it with `/daily-invite stop`. ' +
          'You get a DM when it is done.',
      ),
    ],
  });
}

/** Tells whoever started the run how it ended. A closed DM here is not worth raising. */
async function tellStarter(client: Client, job: InviteJob): Promise<void> {
  try {
    const user = await client.users.fetch(job.startedBy);
    await user.send({ embeds: [describeJob(job)] });
  } catch {
    /* the summary is also in /daily-invite status */
  }
}
