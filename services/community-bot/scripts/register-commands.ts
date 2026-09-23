import process from 'node:process';
import { REST, Routes } from 'discord.js';
import { commandDefinitions } from '../src/commands.js';
import { loadConfig } from '../src/config.js';

/**
 * register-commands.ts — tells Discord what commands exist.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * GUILD COMMANDS, NOT GLOBAL
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `applicationGuildCommands` scopes the registration to one server and takes effect instantly.
 * Global commands take up to an hour to propagate and appear in every server the application is
 * ever added to — including one somebody adds it to by copying the invite link. Since the bot
 * leaves unrecognised guilds anyway, a global registration would only advertise commands that
 * cannot work.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A SCRIPT AND NOT PART OF STARTUP
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A PUT here replaces the entire command list. Running it on every boot would mean a container
 * that crash-loops also re-registers twenty commands a minute against a rate limit shared with
 * everything else the application does. It is run deliberately, when the list has changed.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const commands = commandDefinitions();

  const rest = new REST({ version: '10' }).setToken(config.token);
  await rest.put(Routes.applicationGuildCommands(config.applicationId, config.guildId), {
    body: commands,
  });

  const names = commands.map((command) => command.name).sort();
  process.stdout.write(
    `Registered ${commands.length} commands in guild ${config.guildId}:\n  ${names.join('\n  ')}\n`,
  );
}

main().catch((error: unknown) => {
  // The token is in this process. Print the message, never the request that carried it.
  process.stderr.write(
    `Failed to register commands: ${error instanceof Error ? error.message : 'unknown error'}\n`,
  );
  process.exit(1);
});
