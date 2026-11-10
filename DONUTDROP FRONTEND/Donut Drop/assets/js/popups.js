/* popups.js — a pop-up with one button, shown rarely, for the thing worth doing next.
 *
 * Like nudge.js, this is a quiet card in the bottom corner that never blocks the page — a larger
 * one than the nudge, with its own art and a single button, for the moments that deserve more:
 *
 *   signed out                  → register now: the signup bonus, opening the login form
 *   signed in, Discord unlinked → the Discord page, where the link code is
 *   signed in                   → invite & earn
 *   signed in, balance run out  → buy more for cheap in the Discord shop (see watchBalance)
 *
 * It is not allowed to be a nuisance, because a pop-up that is is a reason to leave:
 *   - one per page load, and never within twenty minutes of the last one on any page;
 *   - each kind has its own rest: a day or three after it is closed, two weeks after it was used;
 *   - never on a game table, where it could cover a board or a bet button, and never over another
 *     dialog or while the corner card is up;
 *   - it opens non-modally and never takes focus, so the page stays live and keys keep working; it
 *     slips away on its own after a short while, or on the × or Escape — nothing has to be closed;
 *   - somebody who arrived on an invite link already has the login form open, so is left alone.
 *
 * The one exception is running out of money. That card answers the balance rather than the page
 * load, so it comes when it is true -- a second or so after the round that emptied the account, on
 * the table where it happened, since there is no bet left there for it to cover -- and then rests
 * six hours (a day once it has been used). Never for a media test twin, whose money is play money.
 *
 * What it has shown, and when, is remembered in this browser only. With storage blocked it may show
 * again on the next visit, which is the harmless way for that to fail. Every figure is the server's. */
import { api } from './api.js';
import { bus, refreshBalance, state } from './store.js';
import { IMG } from './data.js';
import { el, money } from './util.js';
import { currentRouteName, onNavigate } from './routing.js';
import { pendingReferralCode } from './referrals.js';

const ANY_KEY = 'dw.popup.any';
const NUDGE_KEY = 'dw.nudge.next';
const MIN_GAP_MS = 20 * 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const FIRST_DELAY_SIGNED_OUT_MS = 12_000;
const FIRST_DELAY_SIGNED_IN_MS = 16_000;
const RETRY_MS = 8_000;
/* An ignored card leaves on its own rather than sitting in the corner for the whole visit. A hover
 * or a focus is read as interest and stops the clock (see show). */
const AUTO_DISMISS_MS = 18_000;
/* Where a player who has run out can buy more, cheap. */
const SHOP_URL = 'https://discord.gg/qEyuAew5m';
/* Out of money: less than the smallest stake any game takes ($100K, every game's default minimum). */
const BROKE_BELOW = 100_000;
/* Long enough after the round that emptied the account for its result to be read first. */
const BROKE_DELAY_MS = 1_500;

/* Pages with a live table on them. The same list nudge.js keeps off, for the same reason. */
const TABLES = new Set([
  'upgrader', 'roulette', 'blackjack', 'crash', 'mines', 'tower', 'chicken', 'plinko', 'dice', 'limbo', 'fishing', 'ice-fishing', 'derby', 'ore-rush', 'monument', 'coinflip', 'mines-duel',
  'battles', 'crates', 'duel', 'studio',
]);

let openLogin = () => {};
let dialog = null;
let done = false;
let autoTimer = 0;
let brokeTimer = 0;

function read(key) {
  try { return Number(localStorage.getItem(key)) || 0; } catch { return 0; }
}
function write(key, value) {
  try { localStorage.setItem(key, String(value)); } catch { /* this visit only */ }
}
const atTable = () => TABLES.has(currentRouteName());

export function initPopups(options = {}) {
  openLogin = options.openLogin ?? openLogin;
  const delay = state.authenticated ? FIRST_DELAY_SIGNED_IN_MS : FIRST_DELAY_SIGNED_OUT_MS;
  window.setTimeout(() => void tryShow(), delay);
  // Signing in answers the register pop-up; a balance that has run out asks for the shop.
  /* Every change, not only 'balance': the first figure arrives with 'ready', and a crate, an upgrade
   * or a deposit each announce their own. watchBalance is a timer and a comparison until the balance
   * really is under the smallest stake. */
  bus.addEventListener('change', () => {
    if (dialog?.dataset.kind === 'register' && state.authenticated) close('used');
    watchBalance();
  });
  onNavigate(() => {
    // Walking into a game takes it away; it is not worth a click on a bet button. The shop stays:
    // somebody who has run out has no bet to click.
    if (dialog && atTable() && dialog.dataset.kind !== 'broke') close('seen');
  });
}

/**
 * Offers the Discord shop once the balance is under the smallest stake. Asked on every balance
 * change, and decided a moment later, so a round's result is seen before the card and a balance that
 * is topped straight back up never shows it. Another corner card steps aside for it; a window the
 * player is using (a deposit, a withdrawal) is waited out.
 */
function watchBalance() {
  // Already asked: the answer reads the balance as it is then, so another change needs no new timer.
  if (brokeTimer) return;
  brokeTimer = window.setTimeout(async () => {
    brokeTimer = 0;
    if (!state.authenticated || state.user?.testMode?.active) return;
    if (!(Number(state.balance) < BROKE_BELOW)) return;
    if (dialog?.dataset.kind === 'broke' || Date.now() < read('dw.popup.broke')) return;
    /* Read from the wallet itself before saying so: the store starts at 0 until the first answer
     * lands, and a pill held still for a round in the air can be behind. */
    try {
      if (!(Number(await refreshBalance()) < BROKE_BELOW)) return;
    } catch {
      return;
    }
    if (document.hidden || document.querySelector('dialog[open]:not(.popup--corner)')) {
      brokeTimer = window.setTimeout(() => { brokeTimer = 0; watchBalance(); }, RETRY_MS);
      return;
    }
    if (dialog) close('seen');
    // One card a page load: the page-load offer, if it has not come yet, does not follow this one.
    done = true;
    show({
      id: 'broke',
      eyebrow: 'Discord shop',
      title: ['No money left?'],
      line: 'Come buy some for cheap in our Discord. We have the best prices.',
      cta: 'Buy on Discord',
      url: SHOP_URL,
      art: 'emerald.png',
      seenFor: 6 * HOUR_MS,
      usedFor: DAY_MS,
    });
  }, BROKE_DELAY_MS);
}

async function tryShow() {
  if (done || dialog) return;
  const blocked =
    document.hidden
    || document.querySelector('dialog[open]')
    || document.querySelector('.nudge')
    || atTable();
  if (blocked) {
    window.setTimeout(() => void tryShow(), RETRY_MS);
    return;
  }
  if (Date.now() < read(ANY_KEY)) { done = true; return; }
  const popup = await pick();
  // Settled one way or the other for this page load, so a slow answer cannot show two.
  done = true;
  if (!popup || dialog || atTable()) return;
  show(popup);
}

/** The first kind that is allowed for who is looking and is not resting, or null. */
async function pick() {
  const due = (id) => Date.now() >= read(`dw.popup.${id}`);

  if (!state.authenticated) {
    // An invite link opens the login form by itself; a second window on top would be the nag.
    if (pendingReferralCode() || !due('register')) return null;
    const bonus = Number(state.promotions?.signupBonus?.amountMinor ?? 0);
    return {
      id: 'register',
      eyebrow: 'New here?',
      title: bonus > 0 ? ['Get ', money(bonus), ' free'] : ['Join in a minute'],
      line: bonus > 0
        ? 'Make your account with your Minecraft name. The bonus is added the moment it exists.'
        : 'Log in with your Minecraft name and deposit in game. No email, no card.',
      cta: 'Register now',
      art: 'gold_block.png',
      later: 'Maybe later',
      seenFor: DAY_MS,
      usedFor: 3 * DAY_MS,
    };
  }

  // No "new game mode" pop-up since 2026-11-10: the owner asked for them to go.

  if (due('discord')) {
    try {
      const status = await api.get('/v1/discord/rewards');
      if (status && status.linked === false) {
        return {
          id: 'discord',
          eyebrow: 'Community',
          title: ['Join the Discord'],
          line: 'Chat with other players, hear about drops first, and link your account with /link.',
          cta: 'Join Discord',
          href: '/discord',
          art: 'diamond.png',
          later: 'Not now',
          seenFor: 3 * DAY_MS,
          usedFor: 14 * DAY_MS,
        };
      }
    } catch { /* no answer: offer something else */ }
  }

  const bonus = Number(state.promotions?.referral?.bonusMinor ?? 0);
  if (bonus > 0 && due('invite') && currentRouteName() !== 'referrals') {
    return {
      id: 'invite',
      eyebrow: 'Invite & earn',
      title: ['', money(bonus), ' per invite'],
      line: 'Share your link with friends from DonutSMP. You are paid once they have played.',
      cta: 'Get your link',
      href: '/referrals',
      art: 'totem.png',
      later: 'Not now',
      seenFor: 3 * DAY_MS,
      usedFor: 14 * DAY_MS,
    };
  }
  return null;
}

function show(popup) {
  // Counted as shown now, so a crash or a reload cannot make it come straight back.
  write(`dw.popup.${popup.id}`, Date.now() + popup.seenFor);
  write(ANY_KEY, Date.now() + MIN_GAP_MS);
  // The nudge card steps back for an hour: one ask in the corner at a time.
  write(NUDGE_KEY, Date.now() + HOUR_MS);

  dialog = document.createElement('dialog');
  dialog.className = 'popup popup--corner';
  dialog.dataset.kind = popup.id.split(':')[0];
  dialog.dataset.id = popup.id;
  dialog.setAttribute('aria-labelledby', 'popupTitle');
  dialog.__popup = popup;

  const card = el('div', 'popup__card');

  const shut = el('button', 'popup__x');
  shut.type = 'button';
  shut.setAttribute('aria-label', 'Close');
  shut.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
  shut.addEventListener('click', () => close('seen'));

  const art = el('span', 'popup__art');
  art.setAttribute('aria-hidden', 'true');
  const img = document.createElement('img');
  img.src = `${IMG}${popup.art}`;
  img.alt = '';
  art.appendChild(img);

  const eyebrow = el('p', 'popup__eyebrow');
  eyebrow.textContent = popup.eyebrow;
  const title = el('h2', 'popup__h');
  title.id = 'popupTitle';
  // [before, amount, after]: the amount, when there is one, set in gold.
  const [before, amount, after] = popup.title;
  if (amount) {
    const gold = el('b');
    gold.textContent = amount;
    title.append(before, gold, after ?? '');
  } else {
    title.textContent = before;
  }
  const line = el('p', 'popup__p');
  line.textContent = popup.line;

  const actions = el('div', 'popup__acts');
  let go;
  if (popup.url) {
    // Off the site, in a new tab: the router leaves a link with a target alone.
    go = el('a', 'btn btn--go popup__go');
    go.href = popup.url;
    go.target = '_blank';
    go.rel = 'noopener noreferrer';
    go.addEventListener('click', () => close('used'));
  } else if (popup.href) {
    go = el('a', 'btn btn--go popup__go');
    go.href = popup.href;                 // the router's link handler takes it from here
    go.addEventListener('click', () => close('used'));
  } else {
    go = el('button', 'btn btn--go popup__go');
    go.type = 'button';
    go.addEventListener('click', () => {
      close('used');
      // A pop-up with its own window (feedback) opens it; the rest open the login form.
      if (popup.action) void popup.action();
      else openLogin();
    });
  }
  go.textContent = popup.cta;
  // No "Maybe later": in a card that blocks nothing, it does the same as the × and the Escape key
  // and just adds a second thing to read. Ignoring the card is now the way to say "later".
  actions.append(go);

  card.append(shut, art, eyebrow, title, line, actions);
  dialog.appendChild(card);

  // A non-modal dialog raises no cancel event and has no backdrop to click, so Escape is handled
  // here. Focus is never moved into the card, so this only fires once somebody has tabbed in.
  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); close('seen'); }
  });

  document.body.appendChild(dialog);
  // show(), not showModal(): the page behind stays live, nothing goes inert, and focus is left
  // where the player had it — so the card can be read, or ignored, without being closed first.
  dialog.show();
  // Next frame, so the entrance runs from the hidden state rather than starting at the end.
  requestAnimationFrame(() => requestAnimationFrame(() => dialog?.classList.add('is-in')));

  // Leaves on its own if nobody touches it; the first hover or focus is taken as interest and stops
  // the clock, after which only the player (or walking into a game) closes it.
  clearTimeout(autoTimer);
  autoTimer = window.setTimeout(() => close('seen'), AUTO_DISMISS_MS);
  const keep = () => { clearTimeout(autoTimer); autoTimer = 0; };
  card.addEventListener('pointerenter', keep, { once: true });
  card.addEventListener('focusin', keep, { once: true });
}

function close(how) {
  if (!dialog) return;
  clearTimeout(autoTimer);
  autoTimer = 0;
  const leaving = dialog;
  const popup = leaving.__popup;
  dialog = null;
  if (how === 'used') write(`dw.popup.${popup.id}`, Date.now() + popup.usedFor);
  leaving.classList.remove('is-in');
  // Removed on a timer rather than on transitionend, which never fires with motion reduced.
  window.setTimeout(() => {
    if (leaving.open) leaving.close();
    leaving.remove();
  }, 220);
}
