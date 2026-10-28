import { randomInt } from 'node:crypto';
import { compactMoney, multiplierText } from './win-card.js';

/**
 * Win cards: a player's own settled win, shared as a short link that previews as a picture of it
 * and brings whoever follows it in on the player's invite code (migration 080).
 *
 * Any win can be shared, from the history (assets/js/account.js). It began as five times the bet or
 * $10M of profit, and the owner asked for every bet in the history (2026-10-28); that rule now only
 * decides which wins the site offers a card for unasked, after the round (assets/js/share.js).
 */
export function isShareable(wagerMinor: bigint, payoutMinor: bigint): boolean {
  return wagerMinor > 0n && payoutMinor > wagerMinor;
}

/* The referral-code alphabet (lib/referrals.ts): no 0/O or 1/I, so a link read off a screenshot
 * can be typed back. Eight characters is a trillion links. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const SHARE_ID_PATTERN = /^[A-HJ-NP-Z2-9]{8}$/;

export function newShareId(): string {
  let id = '';
  for (let i = 0; i < 8; i += 1) id += ALPHABET[randomInt(ALPHABET.length)];
  return id;
}

/**
 * Whether a request for a share link comes from a link preview rather than a person.
 *
 * A preview reads the page's tags and stops, so it gets the page with the card on it. A person is
 * sent straight on to the site with the invite code, because this page has nothing for them and the
 * API's own policy forbids it the refresh that would move them along.
 */
const PREVIEWERS =
  /discordbot|twitterbot|facebookexternalhit|facebot|whatsapp|slackbot|telegrambot|linkedinbot|redditbot|skypeuripreview|embedly|pinterest|vkshare|applebot|googlebot|bingbot|mastodon|bluesky|iframely|snapchat|viber|line\//i;

export function isLinkPreview(userAgent: string | undefined): boolean {
  return Boolean(userAgent && PREVIEWERS.test(userAgent));
}

/**
 * A share as the world sees it: the round as it was when shared, and the player as the site shows
 * one to a stranger.
 *
 * `playerName` is the MASKED name ("A********"), read through lib/masked-name.ts exactly as the live
 * feed reads it; the real one stays in win_shares.player_name and never leaves the database. The
 * first card printed the real name, and the next none at all; the owner asked for it masked, as
 * everywhere else on the site (2026-10-28).
 */
export interface WinShare {
  readonly id: string;
  readonly game: string;
  readonly gameName: string;
  readonly playerName: string;
  readonly wagerMinor: bigint;
  readonly payoutMinor: bigint;
  readonly referralCode: string | null;
}

export function shareTitle(share: WinShare): string {
  return `${share.playerName} won ${compactMoney(share.payoutMinor)} on ${share.gameName}`;
}

export function shareDescription(share: WinShare): string {
  const round = `${multiplierText(share.wagerMinor, share.payoutMinor)} on a ${compactMoney(share.wagerMinor)} bet.`;
  return share.referralCode
    ? `${round} Join DonutLuxe with ${share.playerName}'s invite.`
    : `${round} DonutLuxe, the DonutSMP casino.`;
}

/** Where a person following the link lands: the site, with the invite code when there is one. */
export function shareLandingPath(share: WinShare): string {
  const query = new URLSearchParams();
  if (share.referralCode) query.set('ref', share.referralCode);
  query.set('win', share.id);
  return `/?${query.toString()}`;
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

/**
 * The card's address. The version is the card's design: bump it whenever the picture changes, so
 * previews and caches fetch the new one rather than keep the old. Version 1 printed the player's
 * name; anything that cached it is left holding that address, not this one. Version 3 carries the
 * masked name.
 */
export const CARD_VERSION = 3;

export function shareImageUrl(share: WinShare, origin: string): string {
  return `${origin}/w/${share.id}.png?v=${CARD_VERSION}`;
}

/** The page a link preview reads: the card as its image, the win as its title. */
export function sharePageHtml(share: WinShare, origin: string): string {
  const title = escapeHtml(shareTitle(share));
  const description = escapeHtml(shareDescription(share));
  const page = escapeHtml(`${origin}/w/${share.id}`);
  const image = escapeHtml(shareImageUrl(share, origin));
  const landing = escapeHtml(`${origin}${shareLandingPath(share)}`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${title} | DonutLuxe</title>
<meta name="description" content="${description}" />
<meta name="robots" content="noindex" />
<meta name="theme-color" content="#ffd700" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="DonutLuxe" />
<meta property="og:title" content="${title}" />
<meta property="og:description" content="${description}" />
<meta property="og:url" content="${page}" />
<meta property="og:image" content="${image}" />
<meta property="og:image:type" content="image/png" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:image:alt" content="${title}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${title}" />
<meta name="twitter:description" content="${description}" />
<meta name="twitter:image" content="${image}" />
</head>
<body>
<p><a href="${landing}">${title} on DonutLuxe</a></p>
</body>
</html>
`;
}
