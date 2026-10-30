/* popups.js — a pop-up with one button, shown rarely, for the thing worth doing next.
 *
 * Where nudge.js is a quiet card in the corner, this is a real dialog in the middle of the page
 * with a backdrop, for the moments that deserve one:
 *
 *   signed out                  → register now: the signup bonus, opening the login form
 *   signed in                   → this week's quests (weekly-quests.js): the deposit race and the
 *                                 recruit quest, each its own pop-up with its own rest
 *   signed in                   → a new game mode (data.js SPOTLIGHT_GAMES, while it is new)
 *   signed in, Discord unlinked → the Discord page, where the link code is
 *   signed in                   → invite & earn
 *
 * It is not allowed to be a nuisance, because a pop-up that is is a reason to leave:
 *   - one per page load, and never within twenty minutes of the last one on any page;
 *   - each kind has its own rest: a day or three after it is closed, two weeks after it was used;
 *   - never on a game table, where it could cover a board or a bet button, and never over another
 *     dialog or while the corner card is up;
 *   - the × button, Escape, a click on the backdrop and "Maybe later" all close it, and focus goes
 *     back to where it was;
 *   - somebody who arrived on an invite link already has the login form open, so is left alone.
 *
 * What it has shown, and when, is remembered in this browser only. With storage blocked it may show
 * again on the next visit, which is the harmless way for that to fail. Every figure is the server's. */
import { api } from './api.js';
import { bus, state } from './store.js';
import { IMG, SPOTLIGHT_GAMES, isNewGame } from './data.js';
import { el, money } from './util.js';
import { currentRouteName, onNavigate } from './routing.js';
import { pendingReferralCode } from './referrals.js';
import { placeName, readWeeklyQuests, timeLeft } from './weekly-quests.js';

const ANY_KEY = 'dw.popup.any';
const NUDGE_KEY = 'dw.nudge.next';
const MIN_GAP_MS = 20 * 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const FIRST_DELAY_SIGNED_OUT_MS = 12_000;
const FIRST_DELAY_SIGNED_IN_MS = 16_000;
const RETRY_MS = 8_000;

/* Pages with a live table on them. The same list nudge.js keeps off, for the same reason. */
const TABLES = new Set([
  'upgrader', 'roulette', 'blackjack', 'crash', 'mines', 'tower', 'chicken', 'plinko', 'dice', 'fishing', 'ice-fishing', 'derby', 'ore-rush', 'monument', 'coinflip', 'mines-duel',
  'battles', 'crates', 'duel', 'studio',
]);

let openLogin = () => {};
let dialog = null;
let opener = null;
let done = false;

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
  // Signing in answers the register pop-up.
  bus.addEventListener('change', () => {
    if (dialog?.dataset.kind === 'register' && state.authenticated) close('used');
  });
  onNavigate(() => {
    // Walking into a game takes it away; it is not worth a click on a bet button.
    if (dialog && atTable()) close('seen');
  });
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

  // This week's quests, first: they are what brings deposits and players in. Not on their own page.
  const quest = await questPopup(due);
  if (quest) return quest;


  // A game that is still new, once for each game; it stops being offered when it stops being new.
  const fresh = SPOTLIGHT_GAMES.filter(isNewGame).find((game) => due(`game:${game.route}`));
  if (fresh) {
    return {
      id: `game:${fresh.route}`,
      eyebrow: 'New game mode',
      title: [fresh.name],
      line: fresh.line,
      cta: `Try ${fresh.name}`,
      href: fresh.route,
      art: fresh.art,
      later: 'Not now',
      seenFor: 3 * DAY_MS,
      usedFor: 30 * DAY_MS,
    };
  }

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

/**
 * The week's quests, one pop-up each: the deposit race while it is open, the recruit quest unless
 * this player has already finished it. Every figure is the board's (GET /v1/quests/weekly).
 */
async function questPopup(due) {
  if (currentRouteName() === 'quests') return null;
  const wantRace = due('quest:deposit_race');
  const wantRecruit = due('quest:recruit');
  if (!wantRace && !wantRecruit) return null;
  const board = await readWeeklyQuests();
  if (!board?.enabled || !board.depositRace || !board.recruit) return null;
  const left = timeLeft(board.endsAt);

  if (wantRace) {
    const race = board.depositRace;
    const prizes = race.prizes.map((prize, index) => `${placeName(index + 1)} ${money(Number(prize))}`).join(', ');
    const rank = race.you?.rank;
    return {
      id: 'quest:deposit_race',
      eyebrow: 'Weekly quest · ends in ' + left,
      title: ['', money(Number(race.potMinor)), ' deposit race'],
      line: rank
        ? `You are ${placeName(rank)} right now. The biggest deposits of the week win: ${prizes}.`
        : `The biggest deposits of the week win: ${prizes}. Deposit and play at least ${money(Number(race.minDepositMinor))} to place.`,
      cta: 'See the race',
      href: '/quests',
      art: 'gold_block.png',
      later: 'Not now',
      seenFor: DAY_MS,
      usedFor: 3 * DAY_MS,
    };
  }

  const recruit = board.recruit;
  if (recruit.you?.done) return null;
  return {
    id: 'quest:recruit',
    eyebrow: 'Weekly quest · ends in ' + left,
    title: [`Bring ${recruit.friendsNeeded} friends, share `, money(Number(recruit.potMinor)), ''],
    line: `Invite new players with your link. Each deposits ${money(Number(recruit.friendDepositMinor))} and wagers ${money(Number(recruit.friendWagerMinor))} this week. `
      + (recruit.finishers > 0
        ? `${recruit.finishers} finished so far.`
        : 'Nobody has finished yet: the first takes the whole pot.'),
    cta: 'Start recruiting',
    href: '/quests',
    art: 'totem.png',
    later: 'Not now',
    seenFor: DAY_MS,
    usedFor: 3 * DAY_MS,
  };
}

function show(popup) {
  // Counted as shown now, so a crash or a reload cannot make it come straight back.
  write(`dw.popup.${popup.id}`, Date.now() + popup.seenFor);
  write(ANY_KEY, Date.now() + MIN_GAP_MS);
  // The corner card steps back for an hour: one ask at a time.
  write(NUDGE_KEY, Date.now() + HOUR_MS);

  opener = document.activeElement;
  dialog = document.createElement('dialog');
  dialog.className = 'popup';
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
  if (popup.href) {
    go = el('a', 'btn btn--go popup__go');
    go.href = popup.href;                 // the router's link handler takes it from here
    go.addEventListener('click', () => close('used'));
  } else {
    go = el('button', 'btn btn--go popup__go');
    go.type = 'button';
    go.addEventListener('click', () => {
      close('used');
      openLogin();
    });
  }
  go.textContent = popup.cta;
  const later = el('button', 'popup__later');
  later.type = 'button';
  later.textContent = popup.later;
  later.addEventListener('click', () => close('seen'));
  actions.append(go, later);

  card.append(shut, art, eyebrow, title, line, actions);
  dialog.appendChild(card);

  // Escape is the platform's own cancel; a click on the backdrop lands on the dialog itself.
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close('seen');
  });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) close('seen');
  });

  document.body.appendChild(dialog);
  dialog.showModal();
  // Next frame, so the entrance runs from the hidden state rather than starting at the end.
  requestAnimationFrame(() => requestAnimationFrame(() => dialog?.classList.add('is-in')));
  go.focus({ preventScroll: true });
}

function close(how) {
  if (!dialog) return;
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
  if (opener && typeof opener.focus === 'function' && document.contains(opener)) {
    opener.focus({ preventScroll: true });
  }
  opener = null;
}
