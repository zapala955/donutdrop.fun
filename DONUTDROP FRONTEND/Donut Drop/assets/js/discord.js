/* discord.js — the invite, and what the server pays.
 *
 * Two cards. The invite is public and static: it renders the same for a signed-out visitor as for
 * a player mid-session. The rewards card is the player's: what joining and wearing the server tag
 * pay, what they have collected, and -- until their Discord is linked -- the Link Discord button.
 *
 * Linking is done on Discord, by authorizing the app (routes/discord-link.ts): the session proves
 * the account and Discord proves the Discord, with nobody in between. Discord sends the browser
 * back to `/discord?link=<outcome>`. It replaced a one-time code typed into the bot's `/link`.
 */
import { api } from './api.js';
import { bus, startDiscordLink, state } from './store.js';
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

let root = null;
let rewards = null; // the rewards card's host
let status = null;

export function mountDiscord(view) {
  root = $('#discordRoot', view);
  if (!root) return;
  if (!root.dataset.built) {
    root.dataset.built = '1';
    rewards = el('section', 'dsync__rewards');
    rewards.setAttribute('aria-live', 'polite');
    root.replaceChildren(inviteCard(), rewards);
    bus.addEventListener('change', (event) => {
      if (['ready', 'login', 'logout'].includes(event.detail)) void loadStatus();
    });
  }
  announceReturn();
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

/* ─────────── the rewards, and the link ─────────── */

async function loadStatus() {
  try {
    status = await api.get('/v1/discord/rewards');
  } catch {
    status = null;
  }
  paintRewards();
}

/* Off to Discord's Authorize screen. Discord sends the browser back to `/discord?link=<outcome>`,
 * which announceReturn reads. */
async function goLink(button) {
  button.disabled = true;
  button.dataset.state = 'loading';
  try {
    location.assign(await startDiscordLink());
  } catch (error) {
    toast({ kind: 'lose', title: 'Discord', body: error?.message || 'Could not start the link' });
    button.disabled = false;
    delete button.dataset.state;
  }
}

/* What Discord's round trip came back with: said once, then stripped from the address so a reload
 * does not say it again. */
const RETURNS = {
  linked: { kind: 'win', title: 'Discord linked' },
  reward: { kind: 'win', title: 'Discord linked', body: 'The join reward is in your balance' },
  join: {
    kind: 'win',
    title: 'Discord linked',
    body: 'Join the server and run /link there to collect the join reward',
  },
  limit: {
    kind: 'lose',
    title: 'That Discord is full',
    body: 'Unlink an account with /accounts unlink in the server first',
  },
  taken: {
    kind: 'lose',
    title: 'Already linked',
    body: 'This account is on a different Discord. Unlink it first',
  },
  inactive: { kind: 'lose', title: 'This account cannot be linked' },
  expired: { kind: 'lose', title: 'The link expired', body: 'Press Link Discord again' },
  cancelled: { kind: 'lose', title: 'Linking cancelled' },
  failed: { kind: 'lose', title: 'Discord declined', body: 'Try again in a moment' },
};

function announceReturn() {
  const params = new URLSearchParams(location.search);
  const outcome = params.get('link');
  if (!outcome) return;
  params.delete('link');
  const rest = params.toString();
  history.replaceState(null, '', `${location.pathname}${rest ? `?${rest}` : ''}`);
  if (RETURNS[outcome]) toast(RETURNS[outcome]);
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
      ? ' To add another, sign in to it here and press Link Discord.'
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
  } else {
    paintRewardList();
  }
  paintLink();
}

function paintRewardList() {
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
}

/* Linking, whether or not the rewards are on: a linked Discord is also what daily codes and /profile
 * in the server read. It is done on Discord itself, by authorizing the app. */
function paintLink() {
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
    /* Linked, but Discord did not see them in the server then: being there is what the join reward
     * is for, and /link in the server is where it is collected. */
    if (status.enabled && Number(status.amounts?.joinMinor) > 0 && !status.join?.claimed) {
      const join = el('p', 'dsync__fine');
      join.textContent = 'Join reward waiting: join the server and run /link there to collect it.';
      rewards.appendChild(join);
    }
    rewards.appendChild(accountsNote(status.accounts));
    rewards.appendChild(unlinkButton());
    return;
  }

  if (!status.oauthAvailable) {
    const soon = el('p', 'dsync__fine');
    soon.textContent = 'Linking a Discord is not set up yet. Check back soon.';
    rewards.appendChild(soon);
    return;
  }

  const link = el('button', 'btn btn--go dsync__go');
  link.type = 'button';
  link.textContent = 'LINK DISCORD';
  link.addEventListener('click', () => void goLink(link));
  const how = el('p', 'dsync__fine');
  how.textContent = 'Opens Discord: authorize DonutLuxe there and you come straight back, linked.';
  rewards.append(link, how);
}
