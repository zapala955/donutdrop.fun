/* discord.js — the invite, and what the server pays.
 *
 * Two cards. The invite is public and static: it renders the same for a signed-out visitor as for
 * a player mid-session. The rewards card is the player's: what joining and wearing the server tag
 * pay, what they have collected, and -- until their Discord is linked -- a one-time code to paste
 * into the pop-up `/link` opens in the server.
 *
 * The code is minted for this session by the site, never by the bot, so the bot can only report
 * who typed it, not choose which account it lands on. It lives ten minutes and works once. While
 * one is on screen the card re-reads its status every few seconds, so the page notices the link the
 * moment the bot makes it.
 */
import { api } from './api.js';
import { bus, state } from './store.js';
import { $, el, money } from './util.js';
import { toast } from './ui.js';
import { openDailyCode } from './daily-code.js';

/**
 * The server invite.
 *
 * Here rather than in a config endpoint because it is public, unchanging, and needed before any
 * request completes — fetching it would mean a page that renders empty and fills in.
 */
const INVITE_URL = 'https://discord.gg/aHfRsUaGgx';
const WATCH_MS = 4000;

let root = null;
let rewards = null; // the rewards card's host
let status = null;
let pendingCode = null; // { code, expiresAt }
let watch = 0;

export function mountDiscord(view) {
  root = $('#discordRoot', view);
  if (!root) return;
  if (!root.dataset.built) {
    root.dataset.built = '1';
    rewards = el('section', 'dsync__rewards');
    rewards.setAttribute('aria-live', 'polite');
    root.replaceChildren(inviteCard(), rewards);
    bus.addEventListener('change', (event) => {
      if (['ready', 'login', 'logout'].includes(event.detail)) {
        pendingCode = null;
        void loadStatus();
      }
    });
  }
  void loadStatus();
}

function inviteCard() {
  const card = el('section', 'dsync__invite');

  const heading = el('h2', 'dsync__invitetitle');
  heading.textContent = 'Join the Discord';

  const copy = el('p', 'dsync__invitecopy');
  copy.textContent =
    'Drops, giveaways, support and everything else happens in the server. Come and say hello.';

  /* An anchor, not a button with a click handler: middle-click, copy the address and a status bar
   * that shows where it goes all come for free. noopener keeps the new tab from steering this one. */
  const go = el('a', 'btn btn--go dsync__go');
  go.href = INVITE_URL;
  go.target = '_blank';
  go.rel = 'noopener noreferrer';
  go.textContent = 'OPEN DISCORD';
  go.setAttribute('aria-label', `Join the DonutLuxe Discord server at ${INVITE_URL}`);

  /* The address in plain text, for somebody reading on a phone and playing on a PC. */
  const address = el('p', 'dsync__inviteurl mono');
  address.textContent = INVITE_URL.replace(/^https:\/\//, '');

  card.append(heading, copy, go, address);
  return card;
}

/* ─────────── the rewards ─────────── */

async function loadStatus() {
  try {
    status = await api.get('/v1/discord/rewards');
  } catch {
    status = null;
  }
  /* A code on screen is finished with once the account is linked. */
  if (status?.linked) pendingCode = null;
  paintRewards();
  scheduleWatch();
}

function scheduleWatch() {
  window.clearTimeout(watch);
  if (!pendingCode || status?.linked) return;
  if (Date.parse(pendingCode.expiresAt) <= Date.now()) {
    pendingCode = null;
    paintRewards();
    return;
  }
  watch = window.setTimeout(() => void loadStatus(), WATCH_MS);
}

async function getCode(button) {
  button.disabled = true;
  try {
    pendingCode = await api.post('/v1/discord/link-code', {});
    paintRewards();
    scheduleWatch();
  } catch (error) {
    toast({ kind: 'lose', title: 'Discord', body: error?.message || 'Could not make a code' });
    button.disabled = false;
  }
}

/* One Discord may carry several accounts (a main and its alts); the main one is the account the
 * bot pays /tag to. Said here so an alt does not wonder where its tag rewards went. Absent on an
 * older gateway, which allows one account per Discord. */
function accountsNote(accounts) {
  const note = el('p', 'dsync__fine');
  if (!accounts) return note;
  const role = accounts.main
    ? 'This is your main account: /tag in the server pays it.'
    : `This is an alt. /tag pays your main account${accounts.mainUsername ? `, ${accounts.mainUsername}` : ''}; /accounts main in the server changes which one that is.`;
  const room =
    accounts.count < accounts.max
      ? ' To add another, sign in to it here, get its link code and /link it.'
      : ' That is the most one Discord may carry.';
  note.textContent = `${role} ${accounts.count} of ${accounts.max} accounts on this Discord.${room}`;
  return note;
}

/* Unlinks THIS account (the others on the Discord are managed from Discord, with /accounts). Two
 * presses: the first only arms it, for four seconds. */
function unlinkButton() {
  const button = el('button', 'btn btn--tiny dsync__unlink');
  button.type = 'button';
  button.textContent = 'UNLINK THIS ACCOUNT';
  let armed = 0;
  button.addEventListener('click', async () => {
    if (!armed) {
      button.textContent = 'PRESS AGAIN TO UNLINK';
      armed = window.setTimeout(() => {
        armed = 0;
        if (button.isConnected) button.textContent = 'UNLINK THIS ACCOUNT';
      }, 4000);
      return;
    }
    window.clearTimeout(armed);
    armed = 0;
    button.disabled = true;
    try {
      const result = await api.post('/v1/discord/unlink', {});
      toast({
        kind: 'win',
        title: 'Discord unlinked',
        body: result?.newMain ? `${result.newMain} is your main account now` : '',
      });
      await loadStatus();
    } catch (error) {
      toast({ kind: 'lose', title: 'Discord', body: error?.message || 'Could not unlink' });
      button.disabled = false;
      button.textContent = 'UNLINK THIS ACCOUNT';
    }
  });
  return button;
}

function row(label, value, done = false) {
  const item = el('li', 'dsync__reward');
  if (done) item.dataset.done = '1';
  const name = el('span', 'dsync__rewardname');
  name.textContent = label;
  const what = el('b', 'dsync__rewardvalue');
  what.textContent = value;
  item.append(name, what);
  return item;
}

/* The tag reward: the first is paid the moment the tag is on, every one after it needs the tag worn
 * for 24 hours straight. Kept short, because it sits in the value column of a one-line row. */
const tagWaiting = (tag) => Boolean(tag?.nextAt && Date.parse(tag.nextAt) > Date.now());

function tagValue(amount, tag) {
  if (!tag?.days) return `${amount} at once, then per 24h worn`;
  if (tag.nextAt) {
    const left = Date.parse(tag.nextAt) - Date.now();
    if (left <= 0) return `${amount} · ready now`;
    const hours = Math.floor(left / 3_600_000);
    const label = hours ? `${hours}h` : `${Math.max(1, Math.ceil(left / 60_000))}m`;
    return `${amount} · next in ${label}`;
  }
  // Collected before, and the tag is not seen on: the next 24 hours start when it goes back on.
  return `${amount} per 24h worn`;
}

function paintRewards() {
  if (!rewards) return;
  rewards.replaceChildren();
  if (!status) return;

  const heading = el('h2', 'dsync__invitetitle');
  heading.textContent = 'Server rewards';
  rewards.appendChild(heading);

  if (!status.enabled) {
    const off = el('p', 'dsync__invitecopy');
    off.textContent = 'The server rewards are switched off right now.';
    rewards.appendChild(off);
    return;
  }

  const amounts = status.amounts;
  const list = el('ul', 'dsync__rewardlist');
  list.append(
    row(
      'Join the server and link your account',
      Number(amounts.joinMinor) > 0
        ? `${money(Number(amounts.joinMinor))} once${status.join?.claimed ? ' · collected' : ''}`
        : 'off',
      Boolean(status.join?.claimed),
    ),
    row(
      'Wear the server tag, then /tag in Discord',
      Number(amounts.tagMinor) > 0 ? tagValue(money(Number(amounts.tagMinor)), status.tag) : 'off',
      tagWaiting(status.tag),
    ),
  );
  /* The daily code is delivered by the bot and redeemed here. */
  const dailyMax = Number(status.dailyCodes?.maxPrizeMinor ?? 0);
  if (status.dailyCodes?.enabled && dailyMax > 0) {
    list.appendChild(
      row('A daily code in your DMs (/daily on in Discord), redeemed here', `up to ${money(dailyMax)}`),
    );
  }
  rewards.appendChild(list);

  if (status.dailyCodes?.enabled) {
    const redeem = el('button', 'btn dsync__redeem');
    redeem.type = 'button';
    redeem.textContent = 'REDEEM A DAILY CODE';
    redeem.addEventListener('click', () => openDailyCode());
    rewards.appendChild(redeem);
  }

  const small = el('p', 'dsync__fine');
  small.textContent =
    `The join reward needs a Discord account at least ${status.minAccountAgeDays} days old. ` +
    'Rewards are playable at once and withdrawable once wagered, like the sign-up bonus.';
  rewards.appendChild(small);

  if (!status.signedIn || !state.authenticated) {
    const login = el('button', 'btn btn--go dsync__go');
    login.type = 'button';
    login.textContent = 'LOG IN TO LINK';
    login.addEventListener('click', () => document.querySelector('#loginBtn')?.click());
    rewards.appendChild(login);
    return;
  }

  if (status.linked) {
    const done = el('p', 'dsync__linked');
    done.textContent = `Linked to Discord${status.discordUsername ? ` as @${status.discordUsername}` : ''}.`;
    rewards.appendChild(done);
    rewards.appendChild(accountsNote(status.accounts));
    rewards.appendChild(unlinkButton());
    return;
  }

  if (pendingCode) {
    const box = el('div', 'dsync__code');
    /* `/link` opens a pop-up in Discord asking for this code, so the code alone is what gets
     * copied: nobody has to type the command's option syntax. */
    const label = el('span', 'dsync__codelabel');
    label.textContent = 'In the Discord server, run /link and paste this code';
    const command = el('code', 'dsync__codecmd mono');
    command.textContent = pendingCode.code;
    const copy = el('button', 'btn btn--tiny dsync__copy');
    copy.type = 'button';
    copy.textContent = 'COPY';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(pendingCode.code);
        copy.textContent = 'COPIED';
      } catch {
        copy.textContent = 'SELECT IT';
      }
    });
    const expires = el('span', 'dsync__codeexp');
    const minutes = Math.max(
      1,
      Math.round((Date.parse(pendingCode.expiresAt) - Date.now()) / 60000),
    );
    expires.textContent = `Works once, for about ${minutes} more minute${minutes === 1 ? '' : 's'}. Never share it.`;
    box.append(label, command, copy, expires);
    rewards.appendChild(box);
    return;
  }

  const link = el('button', 'btn btn--go dsync__go');
  link.type = 'button';
  link.textContent = 'GET LINK CODE';
  link.addEventListener('click', () => void getCode(link));
  rewards.appendChild(link);
}
