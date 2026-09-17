import process from 'node:process';
import { REST, Routes } from 'discord.js';
import { commandDefinitions } from '../src/commands.js';
import { loadConfig } from '../src/config.js';

/**
 * register-commands.ts — publishes the slash command surface to one guild.
 *
 * GUILD commands, never global. Two reasons, both of which matter here:
 *
 *   * a global command is offered in every server the application is in and takes up to an hour to
 *     propagate, so removing one is slow — and the command being removed is the kind that
 *     quarantines a bot;
 *   * a guild registration is scoped to the guild it names, which means the commands simply do not
 *     appear anywhere else, and "do not appear" is a better first line than "appear and are then
 *     refused".
 *
 * Run it after changing `commands.ts`. It is idempotent: the PUT replaces the whole set, so a
 * command deleted from the file disappears from Discord on the next run rather than lingering.
 */

const config = loadConfig();
const rest = new REST({ version: '10' }).setToken(config.DISCORD_BOT_TOKEN);

const body = commandDefinitions.map((command) => command.toJSON());

try {
  await rest.put(
    Routes.applicationGuildCommands(config.DISCORD_APPLICATION_ID, config.DISCORD_GUILD_ID),
    { body },
  );
  process.stdout.write(
    `Registered ${body.length} command(s) to guild ${config.DISCORD_GUILD_ID}:\n` +
      body.map((command) => `  /${command.name}`).join('\n') +
      '\n',
  );
} catch (error) {
  /* The message, not the error object: a thrown REST error from discord.js carries the request it
   * made, and that request has the bot token in its headers. */
  process.stderr.write(
    `Failed to register commands: ${error instanceof Error ? error.message : 'unknown error'}\n`,
  );
  process.exit(1);
}
