import { PermissionFlagsBits, type Client, type Guild } from 'discord.js';
import type { PlatformApi, VipTier } from '../api-client.js';

/**
 * vip-roles.ts — a linked member's VIP tier on the site, as a role in the server.
 *
 * The owner, 2026-11-17: "sync users vip levels with their roles on the site, bronze role id is
 * 1572199044506325042 silver 1572224218421010514 gold 1572224297265791029 platinum
 * 1572224380287852654 diamond 1572224427297349694 high roller 1572224532268327034 users that didnt
 * link keep the member role the autorole gives them".
 *
 * Every ten minutes the site says which members are linked and at what tier (the account /profile
 * shows for them); each gets that tier's role and loses the other five. A member who is not linked
 * gets none of the six, and nothing else about anybody's roles is touched: the member role the
 * autorole gives stays where it is, linked or not.
 *
 * A role the bot cannot manage (missing, or above the bot's own role) is reported once and left
 * alone, rather than failing the whole sweep member by member.
 */

export const VIP_ROLE_IDS: Record<VipTier, string> = {
  bronze: '1572199044506325042',
  silver: '1572224218421010514',
  gold: '1572224297265791029',
  platinum: '1572224380287852654',
  diamond: '1572224427297349694',
  high_roller: '1572224532268327034',
};
const VIP_ROLES = new Set(Object.values(VIP_ROLE_IDS));

const SWEEP_MS = 10 * 60_000;
const FIRST_SWEEP_MS = 45_000;
/** Between two members' role edits, to stay well inside Discord's rate limits. */
const EDIT_GAP_MS = 400;

/** The VIP roles to add and remove so a member holds exactly the one for their tier (none unlinked). */
export function vipRoleChanges(current: Iterable<string>, tier: VipTier | undefined): { add: string[]; remove: string[] } {
  const want = tier ? VIP_ROLE_IDS[tier] : undefined;
  const held = [...current].filter((id) => VIP_ROLES.has(id));
  return {
    add: want && !held.includes(want) ? [want] : [],
    remove: held.filter((id) => id !== want),
  };
}

interface Log {
  info: (fields: Record<string, unknown>, message: string) => void;
  error: (error: unknown, message: string) => void;
}

/** The VIP roles this bot may give and take: present, and below its own highest role. */
function manageableRoles(guild: Guild): { manageable: Set<string>; blocked: string[]; canManage: boolean } {
  const me = guild.members.me;
  const canManage = Boolean(me?.permissions.has(PermissionFlagsBits.ManageRoles));
  const manageable = new Set<string>();
  const blocked: string[] = [];
  for (const id of VIP_ROLES) {
    const role = guild.roles.cache.get(id);
    if (canManage && me && role && role.position < me.roles.highest.position) manageable.add(id);
    else blocked.push(id);
  }
  return { manageable, blocked, canManage };
}

export function startVipRoleSync(client: Client, api: PlatformApi, guildId: string, log: Log): () => void {
  let stopped = false;
  let running = false;
  let reported = '';
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  async function sweep(): Promise<void> {
    if (running || stopped) return;
    running = true;
    try {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) return;
      if (!guild.members.me) await guild.members.fetchMe();
      const { manageable, blocked, canManage } = manageableRoles(guild);
      const problem = !canManage ? 'no Manage Roles permission' : blocked.length ? `cannot manage ${blocked.join(', ')}` : '';
      if (problem && problem !== reported) {
        log.error(
          new Error(problem),
          'VIP roles: the bot needs Manage Roles and its own role above the six VIP roles',
        );
      }
      reported = problem;
      if (!manageable.size) return;

      const tiers = new Map((await api.vipRoles()).map((member) => [member.discordUserId, member.tier]));
      const members = await guild.members.fetch();
      let added = 0;
      let removed = 0;
      for (const member of members.values()) {
        if (stopped) return;
        if (member.user.bot) continue;
        const change = vipRoleChanges(member.roles.cache.keys(), tiers.get(member.id));
        const add = change.add.filter((id) => manageable.has(id));
        const remove = change.remove.filter((id) => manageable.has(id));
        if (!add.length && !remove.length) continue;
        try {
          if (remove.length) await member.roles.remove(remove, 'VIP tier on DonutLuxe changed');
          if (add.length) await member.roles.add(add, 'VIP tier on DonutLuxe');
          added += add.length;
          removed += remove.length;
        } catch (error) {
          log.error(error, `VIP roles: could not update ${member.id}`);
        }
        await pause(EDIT_GAP_MS);
      }
      log.info({ linked: tiers.size, members: members.size, added, removed }, 'VIP roles synced');
    } catch (error) {
      log.error(error, 'VIP roles: sweep failed');
    } finally {
      running = false;
    }
  }

  const first = setTimeout(() => void sweep(), FIRST_SWEEP_MS);
  const every = setInterval(() => void sweep(), SWEEP_MS);
  return () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(every);
  };
}
