/* discord.js — the Discord page.
 *
 * Rewritten 2026-11-11 (the owner: "its so shit"; and "remove the discord invite in plain text and
 * keep the button to join discord"). Three parts, in the redesign's own pieces:
 *
 *   the server   the Discord mark in a slot, how many are on it right now (Discord's own counts, via
 *                GET /v1/discord/server, cached there), and one button that opens the invite
 *   rewards      what the server pays, a sprite to a row, and where this player stands on each
 *   link         the three steps from here to a linked account, the code, then who it is linked as
 *
 * The link code is minted for this session by the site, never by the bot, so the bot can only report
 * who typed it, not choose which account it lands on. It lives ten minutes and works once. While one
 * is on screen the page re-reads its status every few seconds, so it notices the link the moment the
 * bot makes it.
 */
import { api } from './api.js';
import { bus, state } from './store.js';
import { $, el, money } from './util.js';
import { toast } from './ui.js';
import { openRedeemCode } from './redeem-code.js';

/**
 * The server invite.
 *
 * Here rather than in a config endpoint because it is public, unchanging, and needed before any
 * request completes — fetching it would mean a page that renders empty and fills in.
 */
const INVITE_URL = 'https://discord.gg/aHfRsUaGgx';
const WATCH_MS = 4000;

const MARK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.2 5.3A16.3 16.3 0 0 0 15.1 4l-.5 1.1a15 15 0 0 0-5.2 0L8.9 4a16.3 16.3 0 0 0-4.1 1.3C2.2 9.2 1.5 13 1.9 16.7A16.6 16.6 0 0 0 7 19.3l1.2-1.7c-.7-.3-1.4-.7-2-1.2l.5-.4c3.8 1.8 7.9 1.8 11.6 0l.5.4c-.6.5-1.3.9-2 1.2l1.2 1.7a16.6 16.6 0 0 0 5.1-2.6c.5-4.3-.8-8.1-2.9-11.4ZM8.5 14.5c-1 0-1.9-.9-1.9-2s.8-2 1.9-2 1.9.9 1.9 2-.9 2-1.9 2Zm7 0c-1 0-1.9-.9-1.9-2s.8-2 1.9-2 1.9.9 1.9 2-.8 2-1.9 2Z"/></svg>';
const COPY = '<svg viewBox="0 0 256 256" aria-hidden="true"><path d="M216,28H88A12,12,0,0,0,76,40V76H40A12,12,0,0,0,28,88V216a12,12,0,0,0,12,12H168a12,12,0,0,0,12-12V180h36a12,12,0,0,0,12-12V40A12,12,0,0,0,216,28ZM156,204H52V100H156Zm48-48H180V88a12,12,0,0,0-12-12H100V52H204Z"/></svg>';
const CHECK = '<svg viewBox="0 0 256 256" aria-hidden="true"><path d="M232.49,80.49l-128,128a12,12,0,0,1-17,0l-56-56a12,12,0,1,1,17-17L96,183,215.51,63.51a12,12,0,0,1,17,17Z"/></svg>';
const CLOCK = '<svg viewBox="0 0 256 256" aria-hidden="true"><path d="M128,20A108,108,0,1,0,236,128,108.12,108.12,0,0,0,128,20Zm0,192a84,84,0,1,1,84-84A84.09,84.09,0,0,1,128,212Zm68-84a12,12,0,0,1-12,12H128a12,12,0,0,1-12-12V72a12,12,0,0,1,24,0v44h44A12,12,0,0,1,196,128Z"/></svg>';

const escapeText = (value) => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const count = (value) => Number(value).toLocaleString('en-US');

let root = null;
let rewardsHost = null;
let linkHost = null;
let status = null;
let pendingCode = null; // { code, expiresAt }
let watch = 0;

export function mountDiscord(view) {
  root = $('#discordRoot', view);
  if (!root) return;
  if (!root.dataset.built) {
    root.dataset.built = '1';
    root.className = 'dsc';
    rewardsHost = el('section', 'dsc__panel dsc__rewards');
    rewardsHost.setAttribute('aria-labelledby', 'dscRewardsH');
    linkHost = el('section', 'dsc__panel dsc__link');
    linkHost.setAttribute('aria-labelledby', 'dscLinkH');
    linkHost.setAttribute('aria-live', 'polite');
    const grid = el('div', 'dsc__grid');
    grid.append(rewardsHost, linkHost);
    root.replaceChildren(serverCard(), grid);
    bus.addEventListener('change', (event) => {
      if (['ready', 'login', 'logout'].includes(event.detail)) {
        pendingCode = null;
        void loadStatus();
      }
    });
  }
  void loadCounts();
  void loadStatus();
}

/* ─────────── the server ─────────── */

function serverCard() {
  const card = el('section', 'dsc__hero');
  card.innerHTML = `
    <span class="dsc__slot"><img src="assets/img/luxe/discord-mark.svg" alt="" width="64" height="64"></span>
    <div class="dsc__intro">
      <span class="lxtag">Community</span>
      <h2 class="dsc__title">Join the DonutLuxe Discord</h2>
      <p class="dsc__lede">Giveaways, drops, codes and support, all in one server. Link your account
        there and the server pays you too.</p>
      <p class="dsc__live" id="dscLive" hidden><i aria-hidden="true"></i><span></span></p>
    </div>`;
  /* An anchor, not a button with a click handler: middle-click, copy the address and a status bar
   * that shows where it goes all come for free. noopener keeps the new tab from steering this one.
   * The address is not printed on the page (the owner, 2026-11-11): the button is the way in. */
  const join = el('a', 'dsc__join', `${MARK}<span>Join the server</span>`);
  join.href = INVITE_URL;
  join.target = '_blank';
  join.rel = 'noopener noreferrer';
  join.setAttribute('aria-label', 'Join the DonutLuxe Discord server (opens Discord)');
  card.appendChild(join);
  return card;
}

/* Discord's own figures for the invite. Left out entirely when they cannot be had. */
async function loadCounts() {
  let counts = null;
  try {
    counts = await api.get('/v1/discord/server');
  } catch {
    return;
  }
  const live = root && $('#dscLive', root);
  if (!live) return;
  const parts = [];
  if (Number.isInteger(counts?.online)) parts.push(`<b>${escapeText(count(counts.online))}</b> online now`);
  if (Number.isInteger(counts?.members)) parts.push(`<b>${escapeText(count(counts.members))}</b> members`);
  live.hidden = parts.length === 0;
  live.classList.toggle('dsc__live--online', Number.isInteger(counts?.online));
  $('span', live).innerHTML = parts.join('<span class="dsc__sep" aria-hidden="true">·</span>');
}

/* ─────────── the status ─────────── */

async function loadStatus() {
  try {
    status = await api.get('/v1/discord/rewards');
  } catch {
    status = null;
  }
  /* A code on screen is finished with once the account is linked. */
  if (status?.linked) pendingCode = null;
  paintRewards();
  paintLink();
  scheduleWatch();
}

function scheduleWatch() {
  window.clearTimeout(watch);
  if (!pendingCode || status?.linked) return;
  if (Date.parse(pendingCode.expiresAt) <= Date.now()) {
    pendingCode = null;
    paintLink();
    return;
  }
  watch = window.setTimeout(() => void loadStatus(), WATCH_MS);
}

/* ─────────── what the server pays ─────────── */

/* The tag pays the moment it is on, then again for every 24 hours worn. Where this player stands. */
function tagState(tag) {
  if (!tag?.days) return null;
  if (tag.nextAt) {
    const left = Date.parse(tag.nextAt) - Date.now();
    if (left <= 0) return { kind: 'ready', text: 'Ready: run /tag' };
    const hours = Math.floor(left / 3_600_000);
    return { kind: 'wait', text: `Next in ${hours ? `${hours}h` : `${Math.max(1, Math.ceil(left / 60_000))}m`}` };
  }
  return { kind: 'idle', text: 'Put the tag back on' };
}

/* A row: the sprite, the words, and on the right the amount, or the row's own button. */
function rewardRow({ sprite, title, detail, amount, action, chip }) {
  const row = el('li', 'dsc__reward');
  row.innerHTML = `
    <span class="dsc__sprite"><img src="assets/img/items/${sprite}" alt="" width="32" height="32"></span>
    <span class="dsc__rtext"><b></b><small></small></span>
    ${action ? '' : '<span class="dsc__ramount"><b></b></span>'}`;
  $('.dsc__rtext b', row).textContent = title;
  $('.dsc__rtext small', row).textContent = detail;
  if (action) row.appendChild(action);
  else $('.dsc__ramount b', row).textContent = amount;
  if (chip) {
    const tag = el('span', `dsc__chip dsc__chip--${chip.kind}`, chip.kind === 'done' ? CHECK : chip.kind === 'wait' ? CLOCK : '');
    tag.appendChild(document.createTextNode(chip.text));
    $('.dsc__rtext', row).appendChild(tag);
  }
  return row;
}

function paintRewards() {
  if (!rewardsHost) return;
  rewardsHost.innerHTML = '<h2 class="dsc__h" id="dscRewardsH">What the server pays</h2>';
  if (!status) {
    rewardsHost.insertAdjacentHTML('beforeend', '<p class="dsc__p">The rewards could not be loaded. Reload the page to try again.</p>');
    return;
  }
  if (!status.enabled) {
    rewardsHost.insertAdjacentHTML('beforeend', '<p class="dsc__p">The server rewards are switched off right now.</p>');
    return;
  }

  const signedIn = Boolean(status.signedIn && state.authenticated);
  const list = el('ul', 'dsc__list');
  const join = Number(status.amounts?.joinMinor ?? 0);
  if (join > 0) {
    list.appendChild(rewardRow({
      sprite: 'emerald.png',
      title: 'Join and link your account',
      detail: 'Paid once, the moment /link goes through.',
      amount: money(join),
      chip: signedIn && status.join?.claimed ? { kind: 'done', text: 'Collected' } : null,
    }));
  }
  const tag = Number(status.amounts?.tagMinor ?? 0);
  if (tag > 0) {
    list.appendChild(rewardRow({
      sprite: 'name_tag.png',
      title: 'Wear the server tag',
      detail: 'Put the DonutLuxe tag on in Discord, then run /tag. It pays again for every 24 hours it stays on.',
      // One line, as the owner asked (2026-11-11): "$5M/day", not a figure with small print under it.
      amount: `${money(tag)}/day`,
      chip: signedIn ? tagState(status.tag) : null,
    }));
  }
  /* Code drops (2026-11-11, replacing the daily codes): a code in the Discord every two hours, for
   * the first few to redeem it. The figures are the site's; the code itself only the post gives. */
  const drops = status.codeDrops;
  if (drops?.enabled) {
    const every = drops.everyMinutes === 60 ? 'every hour' : drops.everyMinutes % 60 === 0
      ? `every ${drops.everyMinutes / 60} hours` : `every ${drops.everyMinutes} minutes`;
    const left = Date.parse(drops.nextAt) - Date.now();
    const minutes = Math.max(1, Math.round(left / 60_000));
    const nextIn = minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
    const row = rewardRow({
      sprite: 'enchanted_book.png',
      title: 'Code drops',
      detail: `A code drops in the Discord ${every}. The first ${drops.maxClaims} to redeem it get ` +
        `${money(Number(drops.prizeMinor))} each.`,
      amount: money(Number(drops.prizeMinor)),
      chip: drops.current && drops.current.claimsLeft > 0
        ? { kind: 'ready', text: `${drops.current.claimsLeft} of ${drops.current.maxClaims} left on the current code` }
        : { kind: 'wait', text: `Next drop in ${nextIn}` },
    });
    const redeem = el('button', 'dsc__btn dsc__redeem', 'Redeem a code');
    redeem.type = 'button';
    redeem.addEventListener('click', () => openRedeemCode());
    $('.dsc__rtext', row).appendChild(redeem);
    list.appendChild(row);
  }
  rewardsHost.appendChild(list);

  const fine = el('p', 'dsc__fine');
  fine.textContent =
    `The join reward needs a Discord account at least ${status.minAccountAgeDays} days old. ` +
    'Rewards are playable at once and withdrawable once wagered, like the sign-up bonus.';
  rewardsHost.appendChild(fine);
}

/* ─────────── linking ─────────── */

/* One Discord may carry several accounts (a main and its alts); the main one is the account the
 * bot pays /tag to. Said here so an alt does not wonder where its tag rewards went. */
function accountsNote(accounts) {
  const note = el('p', 'dsc__fine');
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
  const button = el('button', 'dsc__btn dsc__btn--quiet', 'Unlink this account');
  button.type = 'button';
  let armed = 0;
  button.addEventListener('click', async () => {
    if (!armed) {
      button.textContent = 'Press again to unlink';
      button.dataset.armed = '1';
      armed = window.setTimeout(() => {
        armed = 0;
        if (!button.isConnected) return;
        button.textContent = 'Unlink this account';
        delete button.dataset.armed;
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
      button.textContent = 'Unlink this account';
      delete button.dataset.armed;
    }
  });
  return button;
}

async function getCode(button) {
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = 'Getting your code…';
  try {
    pendingCode = await api.post('/v1/discord/link-code', {});
    paintLink();
    scheduleWatch();
  } catch (error) {
    toast({ kind: 'lose', title: 'Discord', body: error?.message || 'Could not make a code' });
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.textContent = 'Get my link code';
  }
}

/* The three steps, numbered; a step is ticked once it is behind the player. */
function steps(done) {
  const items = [
    ['Join the server', 'With the button at the top of the page.'],
    ['Get your link code', 'Right here. It works once, for ten minutes.'],
    ['Run /link in the server', 'Paste the code into the box Discord opens. That is it.'],
  ];
  const list = el('ol', 'dsc__steps');
  items.forEach(([title, detail], index) => {
    const item = el('li', 'dsc__step');
    if (index < done) item.dataset.done = '1';
    item.innerHTML = `<span class="dsc__n" aria-hidden="true">${index < done ? CHECK : index + 1}</span>
      <span class="dsc__stext"><b></b><small></small></span>`;
    $('b', item).textContent = title;
    $('small', item).textContent = detail;
    list.appendChild(item);
  });
  return list;
}

function paintLink() {
  if (!linkHost) return;
  linkHost.innerHTML = '<h2 class="dsc__h" id="dscLinkH">Link your account</h2>';
  const signedIn = Boolean(status?.signedIn && state.authenticated);

  if (signedIn && status?.linked) {
    const done = el('div', 'dsc__linked');
    done.innerHTML = `<span class="dsc__linkedicon">${CHECK}</span>
      <span class="dsc__linkedtext"><b>Linked</b><small></small></span>`;
    $('small', done).textContent = status.discordUsername ? `as @${status.discordUsername}` : 'to your Discord';
    linkHost.append(done, accountsNote(status.accounts), unlinkButton());
    return;
  }

  if (signedIn && pendingCode) {
    linkHost.appendChild(steps(2));
    const box = el('div', 'dsc__code');
    /* `/link` opens a pop-up in Discord asking for this code, so the code alone is what gets
     * copied: nobody has to type the command's option syntax. */
    box.innerHTML = `<span class="dsc__codelabel">Your link code</span>
      <div class="dsc__coderow"><code class="dsc__codevalue"></code>
        <button class="dsc__btn dsc__copy" type="button">${COPY}<span>Copy</span></button></div>
      <div class="dsc__wait" role="status"><i aria-hidden="true"></i><span>Waiting for /link in the server…</span></div>
      <p class="dsc__fine dsc__codeexp"></p>`;
    $('.dsc__codevalue', box).textContent = pendingCode.code;
    const minutes = Math.max(1, Math.round((Date.parse(pendingCode.expiresAt) - Date.now()) / 60000));
    $('.dsc__codeexp', box).textContent =
      `Works once, for about ${minutes} more minute${minutes === 1 ? '' : 's'}. Never share it.`;
    const copy = $('.dsc__copy', box);
    copy.addEventListener('click', async () => {
      const label = $('span', copy);
      try {
        await navigator.clipboard.writeText(pendingCode.code);
        label.textContent = 'Copied';
        copy.dataset.state = 'done';
      } catch {
        label.textContent = 'Select it';
      }
      window.setTimeout(() => {
        if (!copy.isConnected) return;
        label.textContent = 'Copy';
        delete copy.dataset.state;
      }, 1800);
    });
    linkHost.appendChild(box);
    return;
  }

  linkHost.appendChild(steps(0));
  if (!signedIn) {
    const login = el('button', 'dsc__btn dsc__btn--go', 'Log in to link');
    login.type = 'button';
    login.addEventListener('click', () => document.querySelector('#loginBtn')?.click());
    linkHost.appendChild(login);
    return;
  }
  const link = el('button', 'dsc__btn dsc__btn--go', 'Get my link code');
  link.type = 'button';
  link.addEventListener('click', () => void getCode(link));
  linkHost.appendChild(link);
}
