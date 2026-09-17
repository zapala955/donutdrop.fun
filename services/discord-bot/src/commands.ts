import { SlashCommandBuilder } from 'discord.js';

/**
 * commands.ts — the command surface, defined once.
 *
 * This list is the contract in three places at the same time: what Discord will let an operator
 * type, what `buildRequest` will send, and what the gateway's discriminated union will accept. A
 * command added here that the gateway does not know is refused server-side rather than doing
 * something approximate, which is the correct direction for the two to disagree in.
 *
 * Note what is NOT modelled: there is no free-text "run this query" command and no way to pass a
 * fragment of SQL, a URL or a path. Every argument is a bounded scalar the gateway re-validates.
 * A chat box is an untrusted input device and the command surface is the place to keep it narrow.
 */

export const commandDefinitions = [
  new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Platform totals: players, sessions, wallet float, queue health'),

  new SlashCommandBuilder()
    .setName('user')
    .setDescription('Look up players by username')
    .addStringOption((option) =>
      option
        .setName('query')
        .setDescription('Username or prefix')
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(32),
    ),

  new SlashCommandBuilder().setName('bots').setDescription('Minecraft bot health and open jobs'),

  new SlashCommandBuilder().setName('jobs').setDescription('Job queue depth by status'),

  new SlashCommandBuilder()
    .setName('dashboard')
    .setDescription('Mint a single-use link into the admin dashboard'),

  new SlashCommandBuilder()
    .setName('quarantine-bot')
    .setDescription('Quarantine or release a Minecraft bot')
    .addStringOption((option) =>
      option.setName('bot-id').setDescription('Bot UUID').setRequired(true).setMaxLength(64),
    )
    .addBooleanOption((option) =>
      option
        .setName('quarantined')
        .setDescription('True to quarantine, false to release')
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('reason')
        .setDescription('Why — recorded in the audit log')
        .setRequired(true)
        .setMinLength(3)
        .setMaxLength(256),
    ),

  new SlashCommandBuilder()
    .setName('suspend-user')
    .setDescription('Suspend or reinstate a player account')
    .addStringOption((option) =>
      option.setName('user-id').setDescription('User UUID').setRequired(true).setMaxLength(64),
    )
    .addBooleanOption((option) =>
      option
        .setName('suspended')
        .setDescription('True to suspend, false to reinstate')
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('reason')
        .setDescription('Why — recorded in the audit log')
        .setRequired(true)
        .setMinLength(3)
        .setMaxLength(256),
    ),
] as const;
