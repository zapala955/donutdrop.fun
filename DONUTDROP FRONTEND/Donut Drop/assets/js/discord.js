/* discord.js — the invite, and nothing else.
 *
 * This page used to be the verification portal: an OAuth link, a status badge and the two
 * conditions that unlocked the referral bonus. The Discord requirement was dropped from the
 * referral programme, which left a page asking people to connect an account for a reward that no
 * longer depended on it — a step with nothing behind it.
 *
 * So it is one card now. No session, no state, no fetch: the tab renders the same for a signed-out
 * visitor as for a player mid-session, which is the point. An invite is public.
 */
import { $, el } from './util.js';

/**
 * The server invite.
 *
 * Here rather than in a config endpoint because it is public, unchanging, and needed before any
 * request completes — fetching it would mean a page that renders empty and fills in. Changing it
 * is a one-line edit; runtime settings only carry numbers and switches, never strings, so it
 * could not have lived there without widening that contract for a single URL.
 */
const INVITE_URL = 'https://discord.gg/aHfRsUaGgx';

let root = null;

export function mountDiscord(view) {
  root = $('#discordRoot', view);
  if (!root) return;
  /* Built once and left alone. There is nothing on this page that can change while somebody is
   * looking at it, so there is nothing to subscribe to and nothing to repaint. */
  if (root.dataset.built) return;
  root.dataset.built = '1';
  root.replaceChildren(inviteCard());
}

function inviteCard() {
  const card = el('section', 'dsync__invite');

  const heading = el('h2', 'dsync__invitetitle');
  heading.textContent = 'Join the Discord';

  const copy = el('p', 'dsync__invitecopy');
  copy.textContent =
    'Drops, giveaways, support and everything else happens in the server. Come and say hello.';

  /* An anchor, not a button with a click handler. It is a link to somewhere else, so it gets the
   * behaviour a link has for free: middle-click, copy the address, open in a new tab, and a
   * status bar that shows where it goes before anybody commits to it. */
  const go = el('a', 'btn btn--go dsync__go');
  go.href = INVITE_URL;
  go.target = '_blank';
  /* noopener is the one that matters: without it the opened tab gets a handle on this window
   * through `opener` and can navigate it somewhere else. */
  go.rel = 'noopener noreferrer';
  go.textContent = 'OPEN DISCORD';
  // The destination is named for a screen reader, since "open discord" does not say where to.
  go.setAttribute('aria-label', `Join the Donut Drop Discord server at ${INVITE_URL}`);

  /* The address in plain text under the button. Somebody reading on a phone and playing on a PC
   * needs to be able to type it, and a link they can only click is no use to them. */
  const address = el('p', 'dsync__inviteurl mono');
  address.textContent = INVITE_URL.replace(/^https:\/\//, '');

  card.append(heading, copy, go, address);
  return card;
}
