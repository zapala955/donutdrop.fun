import process from 'node:process';
import {
  Client,
  GatewayIntentBits,
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
} from 'discord.js';
import pino from 'pino';
import { ApiError, ControlApi, type CommandContext } from './api-client.js';
import { loadConfig } from './config.js';
import { startAlertFeed } from './alerts.js';
import { renderError, renderResult } from './render.js';

/**
 * server.ts — the bot process.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * EVERY REPLY IS EPHEMERAL, WITHOUT EXCEPTION
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Not a preference. `/dashboard` returns a credential, `/user` returns a player's balance, and
 * `/stats` returns figures that would be a gift to somebody deciding whether this platform is
 * worth attacking. A single non-ephemeral reply in a channel with one extra member is a leak that
 * nobody notices, so the flag is applied in one place — `reply` below — and no call site chooses.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE INTENTS ARE THE MINIMUM, AND THAT IS A SECURITY DECISION
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `Guilds` only. The bot cannot read message content, cannot see members it was not handed by an
 * interaction, and needs no privileged intent to be approved for. A bot that cannot read the
 * channel cannot be made to act on something written in it, which removes an entire class of
 * "somebody posted a message that the bot interpreted" problem before it exists.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE BOT DOES NOT KNOW WHO THE ADMINISTRATORS ARE
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * There is no allowlist in this file. Every command is forwarded with the invoking user's id and
 * the gateway decides. That is why a compromised bot token is not a compromised platform: it lets
 * an attacker ask, and the answer is still no.
 */

const config = loadConfig();
const log = pino({
  level: config.LOG_LEVEL,
  /* The token and the HMAC key must never reach a log sink, including inside a serialized error
   * from `fetch` that happens to have captured request options. */
  redact: {
    paths: [
      'config.DISCORD_BOT_TOKEN',
      'config.DISCORD_CONTROL_HMAC_KEY',
      '*.token',
      '*.headers.x-discord-signature',
      '*.url',
    ],
    censor: '[REDACTED]',
  },
});

const api = new ControlApi(config);
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

/** Maps a slash command's options onto the request body the gateway's union expects. */
function buildRequest(interaction: ChatInputCommandInteraction): Record<string, unknown> {
  const name = interaction.commandName;
  switch (name) {
    case 'stats':
    case 'bots':
    case 'jobs':
    case 'dashboard':
      return { command: name };
    case 'user':
      return { command: 'user', query: interaction.options.getString('query', true) };
    case 'quarantine-bot':
      return {
        command: 'quarantine-bot',
        botId: interaction.options.getString('bot-id', true),
        quarantined: interaction.options.getBoolean('quarantined', true),
        reason: interaction.options.getString('reason', true),
      };
    case 'suspend-user':
      return {
        command: 'suspend-user',
        userId: interaction.options.getString('user-id', true),
        suspended: interaction.options.getBoolean('suspended', true),
        reason: interaction.options.getString('reason', true),
      };
    default:
      throw new ApiError(400, 'UNKNOWN_COMMAND', 'That command is not available');
  }
}

function contextOf(interaction: Interaction): CommandContext {
  return {
    discordUserId: interaction.user.id,
    discordGuildId: interaction.guildId,
    discordChannelId: interaction.channelId,
  };
}

/**
 * Runs a request and answers the interaction.
 *
 * Deferred first, always. Discord abandons an interaction that is not acknowledged within three
 * seconds, and a command that waits on the gateway, the database and an audit write can exceed
 * that under load — at which point the operator sees a generic failure for a command that in fact
 * succeeded. Deferring converts the deadline into a spinner.
 */
type Actionable = ChatInputCommandInteraction | ButtonInteraction;

async function run(interaction: Actionable, request: Record<string, unknown>) {
  const started = Date.now();
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const result = await api.command(contextOf(interaction), request);
    const rendered = renderResult(result);
    await interaction.editReply({
      embeds: rendered.embeds,
      components: rendered.components,
    });
    log.info(
      { command: request['command'], user: interaction.user.id, ms: Date.now() - started },
      'command completed',
    );
  } catch (error) {
    const failure =
      error instanceof ApiError
        ? error
        : new ApiError(500, 'BOT_ERROR', 'The bot could not complete that command');
    /* The gateway's message is written for an operator and already avoids saying anything an
     * unauthorised caller should not learn, so it is shown as-is rather than replaced with
     * something vague that would make a real problem harder to diagnose. */
    const rendered = renderError(failure.code, failure.message);
    await interaction
      .editReply({ embeds: rendered.embeds, components: [] })
      .catch(() => undefined);
    log.warn(
      {
        command: request['command'],
        user: interaction.user.id,
        code: failure.code,
        status: failure.status,
        ms: Date.now() - started,
      },
      'command failed',
    );
  }
}

client.on('interactionCreate', (interaction: Interaction) => {
  void (async () => {
    /* The guild pin, enforced here as well as on the gateway. Two checks because they fail
     * differently: this one keeps the bot from answering at all in a server it was invited to by
     * someone else, and the gateway's keeps a forged request from succeeding even if this process
     * is the thing that has been tampered with. */
    if (interaction.guildId && interaction.guildId !== config.DISCORD_GUILD_ID) {
      if (interaction.isRepliable()) {
        await interaction
          .reply({
            content: 'These commands are not available in this server.',
            flags: MessageFlags.Ephemeral,
          })
          .catch(() => undefined);
      }
      return;
    }

    if (interaction.isChatInputCommand()) {
      let request: Record<string, unknown>;
      try {
        request = buildRequest(interaction);
      } catch {
        await interaction
          .reply({ content: 'That command is not available.', flags: MessageFlags.Ephemeral })
          .catch(() => undefined);
        return;
      }
      await run(interaction, request);
      return;
    }

    if (interaction.isButton()) {
      if (interaction.customId === 'cancel') {
        await interaction
          .update({ content: 'Cancelled. Nothing was changed.', embeds: [], components: [] })
          .catch(() => undefined);
        return;
      }
      const [kind, nonce] = interaction.customId.split(':');
      if (kind !== 'confirm' || !nonce) return;
      /* The nonce is passed straight through. It is opaque to this process: the gateway decides
       * whether it is live, whether it belongs to this Discord user, and what it authorises. */
      await run(interaction, { command: 'confirm', nonce });
    }
  })();
});

client.once('clientReady', () => {
  log.info({ user: client.user?.tag, guild: config.DISCORD_GUILD_ID }, 'discord bot ready');
  if (config.alertsEnabled) startAlertFeed(client, config, api, log);
});

client.on('error', (error: Error) => log.error({ err: error.message }, 'discord client error'));
client.on('shardError', (error: Error) => log.error({ err: error.message }, 'shard error'));

/* An unhandled rejection in a process that holds an administrative credential should not be left
 * running in an unknown state. Exit and let the supervisor restart it clean. */
process.on('unhandledRejection', (reason: unknown) => {
  log.fatal({ err: reason instanceof Error ? reason.message : String(reason) }, 'unhandled rejection');
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log.info({ signal }, 'shutting down');
    void client.destroy().finally(() => process.exit(0));
  });
}

await client.login(config.DISCORD_BOT_TOKEN);
