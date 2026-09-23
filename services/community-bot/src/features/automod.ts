import { PermissionFlagsBits, type GuildMember, type Message, type TextChannel } from 'discord.js';
import { guildSettings, setGuildSetting, type Database } from '../db.js';
import { COLOR, clip, embed } from '../ui.js';

/**
 * automod.ts — the four rules worth having, each one switchable and all four off by default.
 *
 * A bot that starts deleting messages the moment it joins is a bot that gets removed the same day,
 * so nothing here does anything until somebody runs `/automod`.
 *
 * The deliberate omission is a word filter. A slur list is a moderation policy, not a feature, and
 * one shipped with guessed contents is either useless or embarrassing. Discord's own AutoMod holds
 * the server's list; this covers what it does not.
 */

const INVITE = /(?:discord\.(?:gg|io|me|li)|discord(?:app)?\.com\/invite)\/[a-z0-9-]+/i;
/* Deliberately not a URL parser. It matches what somebody would call a link in chat, which is the
 * thing being moderated -- a stricter grammar would miss `example.com/x` written without a scheme,
 * and that is exactly how advertising is posted. */
const LINK = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|net|org|gg|io|xyz|shop|link|ru)\b/i;

const SPAM_WINDOW_MS = 7_000;
const SPAM_LIMIT = 5;
const CAPS_MIN_LENGTH = 12;
const CAPS_RATIO = 0.7;

/** Recent message times per member, for the spam rule. Memory only — see `sweepSpamState`. */
const recent = new Map<string, number[]>();

export interface AutomodHit {
  rule: 'invites' | 'links' | 'spam' | 'caps';
  explanation: string;
}

/**
 * Judges one message.
 *
 * Pure apart from the spam window, so the rules can be tested without a Discord client. The caller
 * decides what to do about a hit.
 */
export function inspect(
  content: string,
  authorKey: string,
  enabled: { invites: boolean; links: boolean; spam: boolean; caps: boolean },
  now = Date.now(),
): AutomodHit | null {
  if (enabled.spam) {
    const times = (recent.get(authorKey) ?? []).filter((at) => now - at < SPAM_WINDOW_MS);
    times.push(now);
    recent.set(authorKey, times);
    if (times.length > SPAM_LIMIT) {
      return {
        rule: 'spam',
        explanation: `${times.length} messages in ${Math.round(SPAM_WINDOW_MS / 1000)} seconds`,
      };
    }
  }

  /* Invites are checked before links, and both are checked even when only `links` is on, because
   * an invite is a link: a server that blocks links and allows invites is not what anyone means. */
  if (enabled.invites && INVITE.test(content)) {
    return { rule: 'invites', explanation: 'server invite' };
  }
  if (enabled.links && LINK.test(content)) {
    return { rule: 'links', explanation: 'link' };
  }

  if (enabled.caps) {
    const letters = content.replace(/[^a-z]/gi, '');
    if (letters.length >= CAPS_MIN_LENGTH) {
      const upper = letters.replace(/[^A-Z]/g, '').length;
      if (upper / letters.length >= CAPS_RATIO) {
        return {
          rule: 'caps',
          explanation: `${Math.round((upper / letters.length) * 100)}% capitals`,
        };
      }
    }
  }

  return null;
}

/** Drops spam timings nobody will read again. Called on a timer so the map cannot grow unbounded. */
export function sweepSpamState(now = Date.now()): void {
  for (const [key, times] of recent) {
    const live = times.filter((at) => now - at < SPAM_WINDOW_MS);
    if (live.length === 0) recent.delete(key);
    else recent.set(key, live);
  }
}

export function startAutomodSweeper(): () => void {
  const timer = setInterval(() => sweepSpamState(), 60_000);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * The gateway handler: read the settings, judge, delete, tell them why.
 *
 * Everyone who can moderate is exempt, along with the configured exempt role. A staff member
 * posting the server's own invite link is the normal case, not the rule's target.
 */
export async function onMessage(db: Database, message: Message): Promise<void> {
  if (!message.inGuild() || message.author.bot) return;

  const settings = await guildSettings(db, message.guildId);
  const enabled = {
    invites: settings.automod_invites,
    links: settings.automod_links,
    spam: settings.automod_spam,
    caps: settings.automod_caps,
  };
  if (!enabled.invites && !enabled.links && !enabled.spam && !enabled.caps) return;

  const member = message.member;
  if (member && isExempt(member, settings.automod_exempt_role_id)) return;

  const hit = inspect(message.content, `${message.guildId}:${message.author.id}`, enabled);
  if (!hit) return;

  const deleted = await message.delete().then(
    () => true,
    () => false,
  );
  if (!deleted) return;

  /* A DM would be the polite channel, but most members have them closed and a silent deletion
   * reads as a bug. The in-channel note is short and disappears on its own. */
  const notice = await message.channel
    .send({
      embeds: [
        embed(
          'Message removed',
          `<@${message.author.id}> — ${hit.explanation} is not allowed here.`,
          COLOR.warn,
        ),
      ],
    })
    .catch(() => null);
  if (notice) {
    setTimeout(() => void notice.delete().catch(() => undefined), 8_000).unref?.();
  }

  if (settings.modlog_channel_id) {
    const log = message.guild?.channels.cache.get(settings.modlog_channel_id);
    if (log?.isTextBased()) {
      await (log as TextChannel)
        .send({
          embeds: [
            embed('Automod', undefined, COLOR.warn).addFields(
              { name: 'Member', value: `<@${message.author.id}>`, inline: true },
              { name: 'Rule', value: hit.rule, inline: true },
              { name: 'Channel', value: `<#${message.channelId}>`, inline: true },
              { name: 'Content', value: clip(message.content || '*empty*', 1000) },
            ),
          ],
        })
        .catch(() => undefined);
    }
  }
}

const isExempt = (member: GuildMember, exemptRoleId: string | null): boolean =>
  member.permissions.has(PermissionFlagsBits.ManageMessages) ||
  (exemptRoleId !== null && member.roles.cache.has(exemptRoleId));

/** `/automod` — switches, and a read-out when called with no options. */
export async function configureAutomod(
  db: Database,
  guildId: string,
  changes: {
    invites?: boolean | null;
    links?: boolean | null;
    spam?: boolean | null;
    caps?: boolean | null;
    exemptRoleId?: string | null;
  },
): Promise<string> {
  const applied: string[] = [];
  const pairs = [
    ['invites', 'automod_invites'],
    ['links', 'automod_links'],
    ['spam', 'automod_spam'],
    ['caps', 'automod_caps'],
  ] as const;

  for (const [key, column] of pairs) {
    const value = changes[key];
    // `null` is "not supplied" here; `false` is a real choice and must still be written.
    if (value === null || value === undefined) continue;
    await setGuildSetting(db, guildId, column, value);
    applied.push(`**${key}** ${value ? 'on' : 'off'}`);
  }

  if (changes.exemptRoleId !== undefined && changes.exemptRoleId !== null) {
    await setGuildSetting(db, guildId, 'automod_exempt_role_id', changes.exemptRoleId);
    applied.push(`**exempt role** <@&${changes.exemptRoleId}>`);
  }

  if (applied.length > 0) return applied.join('\n');

  const current = await guildSettings(db, guildId);
  return [
    `Invites: ${current.automod_invites ? 'on' : 'off'}`,
    `Links: ${current.automod_links ? 'on' : 'off'}`,
    `Spam: ${current.automod_spam ? 'on' : 'off'}`,
    `Caps: ${current.automod_caps ? 'on' : 'off'}`,
    `Exempt role: ${current.automod_exempt_role_id ? `<@&${current.automod_exempt_role_id}>` : '*none*'}`,
    '',
    'Moderators are always exempt.',
  ].join('\n');
}
