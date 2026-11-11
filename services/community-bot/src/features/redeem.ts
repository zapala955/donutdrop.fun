import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type Message } from 'discord.js';
import { COLOR, embed } from '../ui.js';

/**
 * redeem.ts — how a code reads, where it is redeemed, and the answer to one sent to the bot by DM.
 *
 * Codes are redeemed ON THE SITE, by a signed-in player, and nowhere else: the bot posts them (code
 * drops, features/code-drops.ts) and cannot spend one. What was here before 2026-11-11 also sent a
 * personal daily code by DM; code drops replaced that, and only these pieces outlived it.
 */

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

/** `ABCD-EFGH`, which is how a code is shown. */
export const formatCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

/** What was typed or pasted, reduced to the code it names, or null if it is not one. */
export function normalizeCode(raw: string): string | null {
  const code = raw.replace(/[\s-]/g, '').toUpperCase();
  return new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`).test(code) ? code : null;
}

/**
 * Where a code is redeemed: the site, with the code in the URL's FRAGMENT. A fragment never leaves
 * the browser, so the code reaches neither the site's logs nor Cloudflare's; the page reads it,
 * fills the redeem window and clears it from the address bar.
 */
export const redeemUrl = (siteUrl: string, code?: string) =>
  `${siteUrl.replace(/\/+$/, '')}/${code ? `#redeem=${code}` : ''}`;

/**
 * The custom id of the old "Get my daily code" button, still on welcome DMs already sent. It now
 * turns code pings on (server.ts), so an old message keeps doing something useful.
 */
export const LEGACY_DAILY_BUTTON = 'daily:on';

// ── a reply to the DM ──────────────────────────────────────────────────────

/** One pointer per member every few minutes: a bot that answers every message can be made to spam. */
const lastHelp = new Map<string, number>();
const HELP_EVERY_MS = 5 * 60_000;
const MAX_TRACKED = 5_000;

/** Anyone can DM a bot, so what is remembered about them is capped: stale entries go first. */
function forgetStale(now: number) {
  if (lastHelp.size < MAX_TRACKED) return;
  for (const [id, time] of lastHelp) {
    if (now - time >= HELP_EVERY_MS) lastHelp.delete(id);
  }
}

/**
 * A direct message to the bot. Codes are redeemed on the site, so whatever is sent, a code or a
 * question, gets the same short pointer, at most once every few minutes, so the bot can never be
 * talked into a reply loop or used to spam. Nothing is spent or read beyond "is this a code":
 * that only decides whether the button carries it.
 */
export async function onDirectMessage(
  message: Message,
  siteUrl: string,
  now: number = Date.now(),
): Promise<void> {
  if (message.author.bot || message.guildId) return;
  const id = message.author.id;
  forgetStale(now);
  const last = lastHelp.get(id);
  if (last !== undefined && now - last < HELP_EVERY_MS) return;
  lastHelp.set(id, now);

  const code = normalizeCode(message.content);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel(code ? 'Redeem on the site' : 'Open the site')
      .setURL(redeemUrl(siteUrl, code ?? undefined)),
  );
  await message.reply({
    embeds: [
      embed(
        code ? 'Redeem it on the site' : 'Codes',
        code
          ? 'That looks like a code. Codes are redeemed on the site, not here: tap the button and ' +
              'it is filled in for you.'
          : 'Codes are redeemed on the site, in the **Redeem code** window (account menu). New ' +
              'codes drop in the server every few hours.',
        COLOR.quiet,
      ),
    ],
    components: [row],
  });
}
