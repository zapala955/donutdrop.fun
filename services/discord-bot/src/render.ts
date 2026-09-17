import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type APIEmbedField,
} from 'discord.js';
import type { CommandResult } from './api-client.js';

/**
 * render.ts — turning an API answer into something readable in a chat window.
 *
 * Nothing here decides anything; it formats. The one rule it does enforce is that a value coming
 * back from the API is treated as text, never as markup: `inlineCode` around every field means a
 * player who names themselves `**@everyone**` cannot use an admin's own console to shout at a
 * server, and cannot forge convincing-looking structure inside an embed an operator is reading to
 * make a decision.
 */

/** Nether gold, matching the platform's own palette. */
const GOLD = 0xffaa00;
const RED = 0xc0392b;

/** Discord's own limits. Exceeding either is a 400 from the API, not a truncation. */
const MAX_FIELDS = 25;
const MAX_VALUE = 1024;

/**
 * Renders any value as a safe inline code span.
 *
 * Every branch is explicit because the input is whatever a Postgres column held: a bare
 * `String(value)` on an object silently produces `[object Object]`, which in a console an
 * operator is reading to make a decision is worse than showing nothing — it looks like data.
 * Backticks are the only character that can break out of the span, so they are replaced.
 */
function inlineCode(value: unknown): string {
  const text =
    value === null || value === undefined
      ? '—'
      : value instanceof Date
        ? value.toISOString()
        : typeof value === 'string'
          ? value
          : typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint'
            ? String(value)
            : JSON.stringify(value) ?? '—';
  const flattened = text.replace(/[\r\n]+/g, ' ').slice(0, MAX_VALUE - 8);
  return `\`${flattened.replace(/`/g, 'ˋ')}\``;
}

/** `users_total` reads as a column name; `Users total` reads as a label. */
function humanise(key: string): string {
  const spaced = key.replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function fieldsFrom(record: Record<string, unknown>): APIEmbedField[] {
  return Object.entries(record)
    .slice(0, MAX_FIELDS)
    .map(([key, value]) => ({ name: humanise(key), value: inlineCode(value), inline: true }));
}

/**
 * Builders are converted to plain API objects before they leave this module.
 *
 * discord.js accepts either, but a builder instance carries its own nominal type from
 * `@discordjs/builders`, and under this repo's `exactOptionalPropertyTypes` that type does not line
 * up with what `editReply` declares it takes. Serialising here makes the boundary structural, which
 * also means a future discord.js bump cannot break the call sites — only this one function.
 */
type RenderedEmbed = ReturnType<EmbedBuilder['toJSON']>;
type RenderedRow = ReturnType<ActionRowBuilder<ButtonBuilder>['toJSON']>;

export interface RenderedReply {
  readonly embeds: RenderedEmbed[];
  readonly components: RenderedRow[];
}

export function renderResult(result: CommandResult): RenderedReply {
  switch (result.kind) {
    case 'data':
      return {
        embeds: [
          new EmbedBuilder()
            .setColor(GOLD)
            .setTitle(result.title)
            .addFields(fieldsFrom(result.fields))
            .setTimestamp(new Date())
            .toJSON(),
        ],
        components: [],
      };

    case 'rows': {
      const embed = new EmbedBuilder().setColor(GOLD).setTitle(result.title).setTimestamp(new Date());
      if (!result.rows.length) {
        embed.setDescription('Nothing to show.');
        return { embeds: [embed.toJSON()], components: [] };
      }
      /* One field per row rather than a table: Discord has no monospace table that survives a
       * phone, and a wrapped table is less readable than a short list. */
      for (const row of result.rows.slice(0, 10)) {
        const [firstKey, ...restKeys] = Object.keys(row);
        const heading = firstKey ? inlineCode(row[firstKey]) : '—';
        const detail = restKeys
          .slice(0, 6)
          .map((key) => `${humanise(key)}: ${inlineCode(row[key])}`)
          .join('\n');
        embed.addFields({ name: heading.slice(0, 256), value: detail.slice(0, MAX_VALUE) || '—' });
      }
      if (result.rows.length > 10) {
        embed.setFooter({ text: `${result.rows.length - 10} more not shown` });
      }
      return { embeds: [embed.toJSON()], components: [] };
    }

    case 'link':
      return {
        embeds: [
          new EmbedBuilder()
            .setColor(GOLD)
            .setTitle('Admin dashboard')
            /* The URL goes in the description rather than a button because a button's URL is
             * rendered by every client that can see the message, and an embed field keeps it
             * inside the ephemeral reply where only the invoking operator can read it. */
            .setDescription(
              `[Open the dashboard](${result.url})\n\n` +
                'Single use. It stops working the moment it is opened once, or when it expires — ' +
                'whichever comes first. Do not paste it anywhere.',
            )
            .addFields({
              name: 'Expires',
              value: `<t:${Math.floor(new Date(result.expiresAt).getTime() / 1000)}:R>`,
            })
            .setTimestamp(new Date())
            .toJSON(),
        ],
        components: [],
      };

    case 'confirm':
      return {
        embeds: [
          new EmbedBuilder()
            .setColor(RED)
            .setTitle('Confirm this action')
            .setDescription(inlineCode(result.summary))
            .setFooter({ text: 'This confirmation expires shortly.' })
            .setTimestamp(new Date())
            .toJSON(),
        ],
        components: [
          new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
            /* The nonce rides in the custom id. It is single use, expiry-bound and tied to the
             * Discord id it was issued to, so another member lifting it out of the payload gets a
             * refusal rather than somebody else's pending action. */
              new ButtonBuilder()
                .setCustomId(`confirm:${result.nonce}`)
                .setLabel('Confirm')
                .setStyle(ButtonStyle.Danger),
              new ButtonBuilder()
                .setCustomId('cancel')
                .setLabel('Cancel')
                .setStyle(ButtonStyle.Secondary),
            )
            .toJSON(),
        ],
      };

    case 'done':
      return {
        embeds: [
          new EmbedBuilder()
            .setColor(GOLD)
            .setTitle('Done')
            .setDescription(inlineCode(result.summary))
            .setTimestamp(new Date())
            .toJSON(),
        ],
        components: [],
      };

    default: {
      const unreachable: never = result;
      throw new Error(`Unrenderable result ${JSON.stringify(unreachable)}`);
    }
  }
}

export function renderError(code: string, message: string): RenderedReply {
  return {
    embeds: [
      new EmbedBuilder()
        .setColor(RED)
        .setTitle('That did not work')
        .setDescription(inlineCode(message))
        .setFooter({ text: code })
        .setTimestamp(new Date())
        .toJSON(),
    ],
    components: [],
  };
}
