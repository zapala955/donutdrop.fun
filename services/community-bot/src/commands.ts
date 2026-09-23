import {
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type RESTPostAPIApplicationCommandsJSONBody,
} from 'discord.js';

/**
 * commands.ts — every slash command, in one list.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * PERMISSIONS ARE DECLARED, NOT CHECKED
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `setDefaultMemberPermissions` puts the gate on Discord's side: a member without the permission
 * does not see the command at all, and an interaction for it never reaches this process. That is
 * strictly better than a handler that replies "you cannot do that", because it cannot be
 * forgotten in one handler out of fifteen — the declaration IS the check.
 *
 * Server owners can still override any of these per role in Server Settings, which is the right
 * place for a server to make that decision rather than here.
 *
 * `setDMPermission(false)` on everything. Every command reads guild settings or acts on a guild
 * member; in a DM there is no guild, and a command that can only fail should not be offered.
 */

const MOD = PermissionFlagsBits.ModerateMembers;
const MANAGE_MESSAGES = PermissionFlagsBits.ManageMessages;
const MANAGE_GUILD = PermissionFlagsBits.ManageGuild;

/** The text channel types a feature can post into. Threads and forums are deliberately excluded. */
const POSTABLE = [ChannelType.GuildText, ChannelType.GuildAnnouncement] as const;

export function commandDefinitions(): RESTPostAPIApplicationCommandsJSONBody[] {
  const builders: SlashCommandBuilder[] = [];
  const add = (builder: SlashCommandBuilder) => {
    builders.push(builder.setDMPermission(false));
  };

  // ── tickets ──────────────────────────────────────────────────────────────

  add(
    new SlashCommandBuilder()
      .setName('ticket-setup')
      .setDescription('Choose where tickets are created and who handles them')
      .setDefaultMemberPermissions(MANAGE_GUILD)
      .addChannelOption((option) =>
        option
          .setName('category')
          .setDescription('The category new ticket channels are created in')
          .addChannelTypes(ChannelType.GuildCategory)
          .setRequired(true),
      )
      .addRoleOption((option) =>
        option
          .setName('staff_role')
          .setDescription('The role that can see and claim tickets')
          .setRequired(true),
      )
      .addChannelOption((option) =>
        option
          .setName('log_channel')
          .setDescription('Where closed-ticket transcripts are posted')
          .addChannelTypes(...POSTABLE),
      ) as SlashCommandBuilder,
  );

  add(
    new SlashCommandBuilder()
      .setName('ticket-panel')
      .setDescription('Post the ticket buttons in this channel')
      .setDefaultMemberPermissions(MANAGE_GUILD),
  );

  // ── moderation ───────────────────────────────────────────────────────────

  add(
    new SlashCommandBuilder()
      .setName('warn')
      .setDescription('Warn a member and record it')
      .setDefaultMemberPermissions(MOD)
      .addUserOption((option) =>
        option.setName('member').setDescription('Who to warn').setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName('reason')
          .setDescription('Why — they are told this')
          .setRequired(true)
          .setMinLength(3)
          .setMaxLength(500),
      ) as SlashCommandBuilder,
  );

  add(
    new SlashCommandBuilder()
      .setName('unwarn')
      .setDescription("Withdraw a member's most recent warning")
      .setDefaultMemberPermissions(MOD)
      .addUserOption((option) =>
        option.setName('member').setDescription('Whose warning to withdraw').setRequired(true),
      )
      .addStringOption((option) =>
        option.setName('reason').setDescription('Why').setMaxLength(500),
      ) as SlashCommandBuilder,
  );

  add(
    new SlashCommandBuilder()
      .setName('timeout')
      .setDescription('Mute a member for a while')
      .setDefaultMemberPermissions(MOD)
      .addUserOption((option) =>
        option.setName('member').setDescription('Who to time out').setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName('duration')
          .setDescription('How long — 10m, 2h, 7d')
          .setRequired(true)
          .setMaxLength(16),
      )
      .addStringOption((option) =>
        option
          .setName('reason')
          .setDescription('Why')
          .setRequired(true)
          .setMinLength(3)
          .setMaxLength(500),
      ) as SlashCommandBuilder,
  );

  add(
    new SlashCommandBuilder()
      .setName('kick')
      .setDescription('Remove a member from the server')
      .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
      .addUserOption((option) =>
        option.setName('member').setDescription('Who to kick').setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName('reason')
          .setDescription('Why')
          .setRequired(true)
          .setMinLength(3)
          .setMaxLength(500),
      ) as SlashCommandBuilder,
  );

  add(
    new SlashCommandBuilder()
      .setName('ban')
      .setDescription('Ban a member')
      .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
      .addUserOption((option) =>
        option.setName('member').setDescription('Who to ban').setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName('reason')
          .setDescription('Why')
          .setRequired(true)
          .setMinLength(3)
          .setMaxLength(500),
      )
      .addIntegerOption((option) =>
        option
          .setName('delete_days')
          .setDescription('Delete their messages from the last N days')
          .setMinValue(0)
          .setMaxValue(7),
      ) as SlashCommandBuilder,
  );

  add(
    new SlashCommandBuilder()
      .setName('purge')
      .setDescription('Bulk delete recent messages in this channel')
      .setDefaultMemberPermissions(MANAGE_MESSAGES)
      .addIntegerOption((option) =>
        option
          .setName('count')
          .setDescription('How many messages')
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(100),
      )
      .addUserOption((option) =>
        option.setName('member').setDescription('Only this member’s messages'),
      ) as SlashCommandBuilder,
  );

  add(
    new SlashCommandBuilder()
      .setName('history')
      .setDescription("Show a member's moderation record")
      .setDefaultMemberPermissions(MOD)
      .addUserOption((option) =>
        option.setName('member').setDescription('Who to look up').setRequired(true),
      ) as SlashCommandBuilder,
  );

  // ── configuration ────────────────────────────────────────────────────────

  add(
    new SlashCommandBuilder()
      .setName('config')
      .setDescription('Set the channels and roles this bot uses, or show them')
      .setDefaultMemberPermissions(MANAGE_GUILD)
      .addChannelOption((option) =>
        option
          .setName('modlog')
          .setDescription('Where moderation actions are logged')
          .addChannelTypes(...POSTABLE),
      )
      .addChannelOption((option) =>
        option
          .setName('welcome')
          .setDescription('Where new members are greeted')
          .addChannelTypes(...POSTABLE),
      )
      .addChannelOption((option) =>
        option
          .setName('goodbye')
          .setDescription('Where departures are noted')
          .addChannelTypes(...POSTABLE),
      )
      .addChannelOption((option) =>
        option
          .setName('suggestions')
          .setDescription('The suggestion board')
          .addChannelTypes(...POSTABLE),
      )
      .addRoleOption((option) =>
        option.setName('autorole').setDescription('Given to every new member'),
      )
      .addStringOption((option) =>
        option
          .setName('welcome_message')
          .setDescription('Use {user} and {server}')
          .setMaxLength(1000),
      ) as SlashCommandBuilder,
  );

  add(
    new SlashCommandBuilder()
      .setName('automod')
      .setDescription('Switch the automatic rules on or off, or show them')
      .setDefaultMemberPermissions(MANAGE_GUILD)
      .addBooleanOption((option) =>
        option.setName('invites').setDescription('Delete Discord invite links'),
      )
      .addBooleanOption((option) => option.setName('links').setDescription('Delete all links'))
      .addBooleanOption((option) =>
        option.setName('spam').setDescription('Delete rapid repeat messages'),
      )
      .addBooleanOption((option) =>
        option.setName('caps').setDescription('Delete messages that are mostly capitals'),
      )
      .addRoleOption((option) =>
        option.setName('exempt_role').setDescription('This role is never filtered'),
      ) as SlashCommandBuilder,
  );

  // ── self-serve roles ─────────────────────────────────────────────────────

  const roleMenu = new SlashCommandBuilder()
    .setName('rolemenu')
    .setDescription('Post a set of buttons members can use to give themselves roles')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addStringOption((option) =>
      option
        .setName('title')
        .setDescription('Heading for the menu')
        .setRequired(true)
        .setMaxLength(120),
    )
    .addRoleOption((option) =>
      option.setName('role1').setDescription('First role').setRequired(true),
    )
    .addStringOption((option) =>
      option.setName('label1').setDescription('Button text for the first role').setMaxLength(60),
    ) as SlashCommandBuilder;
  for (const index of [2, 3, 4, 5]) {
    roleMenu
      .addRoleOption((option) => option.setName(`role${index}`).setDescription(`Role ${index}`))
      .addStringOption((option) =>
        option.setName(`label${index}`).setDescription(`Button text ${index}`).setMaxLength(60),
      );
  }
  add(roleMenu);

  // ── suggestions ──────────────────────────────────────────────────────────

  add(
    new SlashCommandBuilder()
      .setName('suggest')
      .setDescription('Put an idea on the suggestion board')
      .addStringOption((option) =>
        option
          .setName('suggestion')
          .setDescription('What you would change')
          .setRequired(true)
          .setMinLength(8)
          .setMaxLength(1800),
      ) as SlashCommandBuilder,
  );

  add(
    new SlashCommandBuilder()
      .setName('suggestion-decide')
      .setDescription('Accept or decline a suggestion')
      .setDefaultMemberPermissions(MANAGE_GUILD)
      .addIntegerOption((option) =>
        option
          .setName('number')
          .setDescription('Suggestion number')
          .setRequired(true)
          .setMinValue(1),
      )
      .addStringOption((option) =>
        option
          .setName('status')
          .setDescription('The decision')
          .setRequired(true)
          .addChoices(
            { name: 'accepted', value: 'accepted' },
            { name: 'declined', value: 'declined' },
            { name: 'duplicate', value: 'duplicate' },
          ),
      )
      .addStringOption((option) =>
        option.setName('note').setDescription('Shown on the suggestion').setMaxLength(500),
      ) as SlashCommandBuilder,
  );

  // ── giveaways ────────────────────────────────────────────────────────────

  add(
    new SlashCommandBuilder()
      .setName('giveaway-start')
      .setDescription('Start a giveaway in this channel')
      .setDefaultMemberPermissions(MANAGE_GUILD)
      .addStringOption((option) =>
        option
          .setName('prize')
          .setDescription('What is being given away')
          .setRequired(true)
          .setMaxLength(200),
      )
      .addStringOption((option) =>
        option
          .setName('duration')
          .setDescription('How long — 1h, 2d, 30m')
          .setRequired(true)
          .setMaxLength(16),
      )
      .addIntegerOption((option) =>
        option
          .setName('winners')
          .setDescription('How many winners (default 1)')
          .setMinValue(1)
          .setMaxValue(20),
      ) as SlashCommandBuilder,
  );

  add(
    new SlashCommandBuilder()
      .setName('giveaway-end')
      .setDescription('End a running giveaway now')
      .setDefaultMemberPermissions(MANAGE_GUILD)
      .addStringOption((option) =>
        option
          .setName('message_id')
          .setDescription('The giveaway message id')
          .setRequired(true)
          .setMaxLength(32),
      ) as SlashCommandBuilder,
  );

  add(
    new SlashCommandBuilder()
      .setName('giveaway-reroll')
      .setDescription('Draw one more winner for a finished giveaway')
      .setDefaultMemberPermissions(MANAGE_GUILD)
      .addStringOption((option) =>
        option
          .setName('message_id')
          .setDescription('The giveaway message id')
          .setRequired(true)
          .setMaxLength(32),
      ) as SlashCommandBuilder,
  );

  // ── the site ─────────────────────────────────────────────────────────────

  add(
    new SlashCommandBuilder()
      .setName('link')
      .setDescription('How to connect your Discord to your Donut Drop account'),
  );

  add(
    new SlashCommandBuilder()
      .setName('profile')
      .setDescription('Show a linked Donut Drop profile')
      .addUserOption((option) =>
        option.setName('member').setDescription('Whose profile — defaults to yours'),
      ) as SlashCommandBuilder,
  );

  // ── utility ──────────────────────────────────────────────────────────────

  add(
    new SlashCommandBuilder()
      .setName('userinfo')
      .setDescription('Show what Discord knows about a member')
      .addUserOption((option) =>
        option.setName('member').setDescription('Who — defaults to you'),
      ) as SlashCommandBuilder,
  );

  add(new SlashCommandBuilder().setName('serverinfo').setDescription('Show server statistics'));

  add(
    new SlashCommandBuilder()
      .setName('avatar')
      .setDescription("Show a member's avatar at full size")
      .addUserOption((option) =>
        option.setName('member').setDescription('Who — defaults to you'),
      ) as SlashCommandBuilder,
  );

  const poll = new SlashCommandBuilder()
    .setName('poll')
    .setDescription('Ask the server something')
    .addStringOption((option) =>
      option.setName('question').setDescription('The question').setRequired(true).setMaxLength(250),
    )
    .addStringOption((option) =>
      option.setName('option1').setDescription('First option').setRequired(true).setMaxLength(80),
    )
    .addStringOption((option) =>
      option.setName('option2').setDescription('Second option').setRequired(true).setMaxLength(80),
    ) as SlashCommandBuilder;
  for (const index of [3, 4, 5]) {
    poll.addStringOption((option) =>
      option.setName(`option${index}`).setDescription(`Option ${index}`).setMaxLength(80),
    );
  }
  add(poll);

  add(
    new SlashCommandBuilder()
      .setName('slowmode')
      .setDescription('Set slowmode in this channel')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
      .addIntegerOption((option) =>
        option
          .setName('seconds')
          .setDescription('Seconds between messages, 0 to turn off')
          .setRequired(true)
          .setMinValue(0)
          .setMaxValue(21_600),
      ) as SlashCommandBuilder,
  );

  add(
    new SlashCommandBuilder()
      .setName('say')
      .setDescription('Post a message as the bot — logged against your name')
      .setDefaultMemberPermissions(MANAGE_MESSAGES)
      .addStringOption((option) =>
        option
          .setName('message')
          .setDescription('What to post')
          .setRequired(true)
          .setMaxLength(1800),
      ) as SlashCommandBuilder,
  );

  add(new SlashCommandBuilder().setName('help').setDescription('What this bot can do'));

  return builders.map((builder) => builder.toJSON());
}
