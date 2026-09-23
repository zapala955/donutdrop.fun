import process from 'node:process';
import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type ModalSubmitInteraction,
} from 'discord.js';
import pino from 'pino';
import { PlatformApi } from './api-client.js';
import { loadConfig } from './config.js';
import { Database, guildSettings } from './db.js';
import { COLOR, bad, embed } from './ui.js';
import {
  claimTicket,
  closeTicket,
  closeTicketModal,
  createTicket,
  openTicketModal,
  postTicketPanel,
  ticketSetup,
} from './features/tickets.js';
import {
  banMember,
  kickMember,
  modHistory,
  purgeMessages,
  revokeWarning,
  timeoutMember,
  warnMember,
} from './features/moderation.js';
import {
  configure,
  createRoleMenu,
  createSuggestion,
  decideSuggestion,
  onMemberJoin,
  onMemberLeave,
  toggleRole,
  voteSuggestion,
} from './features/community.js';
import {
  endGiveawayCommand,
  enterGiveaway,
  rerollGiveaway,
  startGiveaway,
  startGiveawaySweeper,
} from './features/giveaways.js';
import { configureAutomod, onMessage, startAutomodSweeper } from './features/automod.js';
import { showLink, showProfile } from './features/link.js';
import {
  avatar,
  castPollVote,
  createPoll,
  say,
  serverInfo,
  slowmode,
  userInfo,
} from './features/utility.js';

/**
 * server.ts — the community bot process.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE GUILD IS PINNED, AND EVERY INTERACTION IS CHECKED AGAINST IT
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A bot invite link is public the moment it is used once. Without the check below, anybody who
 * copies it adds this process to their own server, where it would open tickets and write rows
 * into the platform's database on their behalf. `COMMUNITY_GUILD_ID` makes being added elsewhere
 * achieve nothing: the bot leaves guilds it does not recognise, and refuses interactions from
 * them in case it is still there when one arrives.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY MessageContent IS REQUESTED, WHEN THE OPERATOR BOT ASKS FOR NOTHING
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Automod cannot judge a message it cannot read. That is the only reason, and it is a real cost:
 * this process sees every message in a public server, so it holds none of them — `onMessage`
 * inspects and returns, and nothing is written except a log line for a message it deleted.
 *
 * The operator bot asks for no intents at all because it has no business reading a channel. Two
 * different jobs, two different appetites, and that is precisely why they are two processes.
 */

const log = pino({ level: process.env['LOG_LEVEL'] ?? 'info', name: 'community-bot' });

async function main(): Promise<void> {
  const config = loadConfig();
  const db = new Database(config);
  const api = PlatformApi.from(config);

  if (!api) {
    log.warn('No platform API configured — /link and /profile will report themselves unavailable');
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    // Without this a departing member arrives uncached and the goodbye never fires.
    partials: [Partials.GuildMember],
  });

  const wrongGuild = (guildId: string | null): boolean => guildId !== config.guildId;

  client.once(Events.ClientReady, (ready) => {
    log.info({ tag: ready.user.tag, guilds: ready.guilds.cache.size }, 'connected');
    for (const guild of ready.guilds.cache.values()) {
      if (guild.id === config.guildId) continue;
      log.warn({ guildId: guild.id, name: guild.name }, 'leaving an unrecognised guild');
      void guild.leave().catch(() => undefined);
    }
  });

  client.on(Events.GuildCreate, (guild) => {
    if (guild.id === config.guildId) return;
    log.warn({ guildId: guild.id, name: guild.name }, 'added to an unrecognised guild — leaving');
    void guild.leave().catch(() => undefined);
  });

  client.on(Events.GuildMemberAdd, (member) => {
    if (wrongGuild(member.guild.id)) return;
    void onMemberJoin(db, member).catch((error) => log.error({ error }, 'member join failed'));
  });

  client.on(Events.GuildMemberRemove, (member) => {
    if (wrongGuild(member.guild.id)) return;
    void onMemberLeave(
      db,
      member.guild.id,
      member.user?.tag ?? 'Someone',
      member.guild.name,
      member.guild.channels.cache,
    ).catch((error) => log.error({ error }, 'member leave failed'));
  });

  client.on(Events.MessageCreate, (message) => {
    if (wrongGuild(message.guildId)) return;
    void onMessage(db, message).catch((error) => log.error({ error }, 'automod failed'));
  });

  client.on(Events.InteractionCreate, (interaction) => {
    void route(interaction).catch(async (error) => {
      log.error({ error }, 'interaction failed');
      await apologise(interaction);
    });
  });

  async function route(interaction: Interaction): Promise<void> {
    if (interaction.isChatInputCommand()) {
      if (wrongGuild(interaction.guildId)) {
        await interaction.reply({
          embeds: [bad('Not here', 'This bot only works in its own server.')],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await onCommand(interaction);
      return;
    }
    if (interaction.isButton()) {
      if (wrongGuild(interaction.guildId)) return;
      await onButton(interaction);
      return;
    }
    if (interaction.isModalSubmit()) {
      if (wrongGuild(interaction.guildId)) return;
      await onModal(interaction);
    }
  }

  async function onCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    switch (interaction.commandName) {
      case 'ticket-setup':
        return ticketSetup(db, interaction);
      case 'ticket-panel':
        return postTicketPanel(db, interaction);

      case 'warn':
        return warnMember(db, interaction);
      case 'unwarn':
        return revokeWarning(db, interaction);
      case 'timeout':
        return timeoutMember(db, interaction);
      case 'kick':
        return kickMember(db, interaction);
      case 'ban':
        return banMember(db, interaction);
      case 'purge':
        return purgeMessages(db, interaction);
      case 'history':
        return modHistory(db, interaction);

      case 'config':
        return configure(db, interaction);
      case 'automod':
        return onAutomodCommand(interaction);

      case 'rolemenu':
        return createRoleMenu(db, interaction);
      case 'suggest':
        return createSuggestion(db, interaction);
      case 'suggestion-decide':
        return decideSuggestion(db, interaction);

      case 'giveaway-start':
        return startGiveaway(db, interaction);
      case 'giveaway-end':
        return endGiveawayCommand(db, interaction);
      case 'giveaway-reroll':
        return rerollGiveaway(db, interaction);

      case 'link':
        return showLink(api, interaction);
      case 'profile':
        return showProfile(api, interaction);

      case 'userinfo':
        return userInfo(interaction);
      case 'serverinfo':
        return serverInfo(interaction);
      case 'avatar':
        return avatar(interaction);
      case 'poll':
        return createPoll(interaction);
      case 'slowmode':
        return slowmode(interaction);
      case 'say': {
        const settings = await guildSettings(db, interaction.guildId!);
        return say(interaction, settings.modlog_channel_id);
      }
      case 'help':
        return showHelp(interaction);

      default:
        /* A command Discord knows and this build does not, which is what a rollback looks like
         * from the inside: the registration outlives the code. Saying so beats a silent failure
         * that reads as the bot being down. */
        await interaction.reply({
          embeds: [bad('Unknown command', 'This bot no longer has that command.')],
          flags: MessageFlags.Ephemeral,
        });
    }
  }

  async function onAutomodCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const summary = await configureAutomod(db, interaction.guildId!, {
      invites: interaction.options.getBoolean('invites'),
      links: interaction.options.getBoolean('links'),
      spam: interaction.options.getBoolean('spam'),
      caps: interaction.options.getBoolean('caps'),
      exemptRoleId: interaction.options.getRole('exempt_role')?.id ?? null,
    });
    await interaction.reply({
      embeds: [embed('Automod', summary, COLOR.quiet)],
      flags: MessageFlags.Ephemeral,
    });
  }

  /**
   * Buttons are routed by a `prefix:action:id` custom id.
   *
   * The id in a custom id is attacker-controlled — it comes back from a client — so every handler
   * re-reads the row it names and checks the guild. Nothing downstream trusts this string for
   * anything but finding the record.
   */
  async function onButton(interaction: ButtonInteraction): Promise<void> {
    const [prefix, action, ...rest] = interaction.customId.split(':');
    const id = rest.join(':');

    if (prefix === 'ticket') {
      if (action === 'open') return openTicketModal(interaction, id);
      if (action === 'claim') return claimTicket(db, interaction, id);
      if (action === 'close') return closeTicketModal(interaction, id);
    }
    if (prefix === 'role' && action === 'toggle') {
      const [menuId, roleId] = rest;
      if (menuId && roleId) return toggleRole(db, interaction, menuId, roleId);
    }
    if (prefix === 'suggest' && (action === 'up' || action === 'down')) {
      return voteSuggestion(db, interaction, id, action);
    }
    if (prefix === 'gw' && action === 'enter') {
      return enterGiveaway(db, interaction, id);
    }
    if (prefix === 'poll') {
      const choice = Number(action);
      if (Number.isInteger(choice)) return castPollVote(interaction, choice);
    }

    await interaction.reply({
      embeds: [bad('That button is stale', 'It was posted by an older version of this bot.')],
      flags: MessageFlags.Ephemeral,
    });
  }

  async function onModal(interaction: ModalSubmitInteraction): Promise<void> {
    const [prefix, action, ...rest] = interaction.customId.split(':');
    const id = rest.join(':');
    if (prefix === 'ticket' && action === 'create') return createTicket(db, interaction, id);
    if (prefix === 'ticket' && action === 'closing') return closeTicket(db, interaction, id);
  }

  const stopGiveaways = startGiveawaySweeper(db, client);
  const stopAutomod = startAutomodSweeper();

  await client.login(config.token);

  /**
   * Shutdown, in the order that loses least.
   *
   * The Discord socket goes first so no new interaction arrives while the pool is closing — an
   * interaction accepted after the database is gone is one Discord shows as failed.
   */
  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    log.info({ signal }, 'shutting down');
    stopGiveaways();
    stopAutomod();
    await client.destroy().catch(() => undefined);
    await db.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

async function showHelp(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.reply({
    embeds: [
      embed(
        'What I can do',
        [
          '**Tickets** — press a button on the ticket panel for support or a media application.',
          '**/suggest** — put an idea on the board; everyone votes.',
          '**/profile** — show a linked Donut Drop profile. **/link** explains how to connect one.',
          '**/userinfo · /serverinfo · /avatar · /poll** — the usual.',
          '',
          'Staff also have moderation, giveaways, role menus, automod and `/config`.',
          '',
          'Nobody here will ever ask you for a password or a code. Anyone who does is not staff.',
        ].join('\n'),
      ),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

/**
 * Says something went wrong, whichever state the interaction is in.
 *
 * An interaction that is never answered shows the member "the application did not respond", which
 * is indistinguishable from the bot being down. Answering badly beats not answering.
 */
async function apologise(interaction: Interaction): Promise<void> {
  if (!interaction.isRepliable()) return;
  const body = {
    embeds: [bad('Something went wrong', 'That did not work. Try again, or tell a moderator.')],
    flags: MessageFlags.Ephemeral as const,
  };
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(body);
    } else {
      await interaction.reply(body);
    }
  } catch {
    // The token expired or the reply raced. Nothing further to try.
  }
}

main().catch((error) => {
  log.fatal({ error }, 'community bot failed to start');
  process.exit(1);
});
