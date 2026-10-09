/* nudge.js — one offer in the corner, now and then.
 *
 * The home page carries its offers as banners, but most visits never go back to the home page.
 * This puts one of them in the bottom corner once somebody has been on the site a little while,
 * picked for who is looking:
 *
 *   signed out                      → the signup bonus, opening the login form
 *   signed in, Discord not linked   → the Discord page, where the link code is
 *   otherwise                       → the invite link, or a game to try (data.js SPOTLIGHT_GAMES)
 *
 * It never blocks anything: no backdrop, focus is left where it was, and the × or Escape closes
 * it. It never lands on a game table either, where a card in the corner could sit over a board or
 * a bet button; it waits for a calmer page, and leaves if the player walks into a game.
 *
 * At most one per page load, and once shown it stays away for an hour (six once it has been used).
 * That is remembered in this browser only; with storage blocked it simply may show again on the
 * next visit, which is the harmless way for that to fail. Every figure is the server's. */
import { api } from './api.js';
import { bus, state } from './store.js';
import { IMG, pickSpotlight, isNewGame } from './data.js';
import { el, money } from './util.js';
import { currentRouteName, onNavigate } from './routing.js';

const KEY = 'dw.nudge.next';
const FIRST_DELAY_MS = 25_000;
const SEEN_HOLD_MS = 60 * 60_000;
const USED_HOLD_MS = 6 * 60 * 60_000;
const RETRY_MS = 10_000;

/* Pages with a live table on them. */
const TABLES = new Set([
  'upgrader', 'roulette', 'blackjack', 'crash', 'mines', 'plinko', 'coinflip', 'mines-duel',
  'battles', 'crates', 'duel', 'studio',
]);

const DISCORD_PATH = 'M19.2 5.3A16.3 16.3 0 0 0 15.1 4l-.5 1.1a15 15 0 0 0-5.2 0L8.9 4a16.3 16.3 0 0 0-4.1 1.3C2.2 9.2 1.5 13 1.9 16.7A16.6 16.6 0 0 0 7 19.3l1.2-1.7c-.7-.3-1.4-.7-2-1.2l.5-.4c3.8 1.8 7.9 1.8 11.6 0l.5.4c-.6.5-1.3.9-2 1.2l1.2 1.7a16.6 16.6 0 0 0 5.1-2.6c.5-4.3-.8-8.1-2.9-11.4ZM8.5 14.5c-1 0-1.9-.9-1.9-2s.8-2 1.9-2 1.9.9 1.9 2-.9 2-1.9 2Zm7 0c-1 0-1.9-.9-1.9-2s.8-2 1.9-2 1.9.9 1.9 2-.8 2-1.9 2Z';

let openLogin = () => {};
let due = false;
let card = null;

function heldUntil() {
  try { return Number(localStorage.getItem(KEY)) || 0; } catch { return 0; }
}
function holdFor(ms) {
  try { localStorage.setItem(KEY, String(Date.now() + ms)); } catch { /* this visit only */ }
}
const atTable = () => TABLES.has(currentRouteName());

export function initNudge(options = {}) {
  openLogin = options.openLogin ?? openLogin;
  window.setTimeout(() => { due = true; void tryShow(); }, FIRST_DELAY_MS);

  onNavigate(() => {
    // Walking into a game takes the card away; leaving one is the moment to try again.
    if (card && atTable()) close(SEEN_HOLD_MS);
    if (due && !card) window.setTimeout(() => void tryShow(), 4000);
  });
  // Signing in answers the login offer.
  bus.addEventListener('change', () => {
    if (card?.dataset.kind === 'login' && state.authenticated) close(SEEN_HOLD_MS);
  });
}

async function tryShow() {
  if (!due || card) return;
  if (Date.now() < heldUntil()) { due = false; return; }
  if (atTable()) return;                                    // waits for the next calm page
  if (document.querySelector('#modal')?.open || document.hidden) {
    window.setTimeout(() => void tryShow(), RETRY_MS);
    return;
  }
  const offer = await pickOffer();
  if (!offer || !due || card || atTable()) return;
  due = false;
  show(offer);
}

async function pickOffer() {
  const route = currentRouteName();

  if (!state.authenticated) {
    const bonus = Number(state.promotions?.signupBonus?.amountMinor ?? 0);
    return {
      kind: 'login',
      eyebrow: 'New players',
      title: bonus > 0 ? ['Get ', money(bonus), ' free'] : ['Log in to play'],
      line: bonus > 0
        ? 'Added the moment your account is created.'
        : 'Log in with your Minecraft name and deposit in game.',
      cta: 'Log in',
      art: 'gold_block.png',
    };
  }

  if (route !== 'discord') {
    try {
      const status = await api.get('/v1/discord/rewards');
      if (status && status.linked === false) {
        return {
          kind: 'discord',
          eyebrow: 'Community',
          title: ['Join the Discord'],
          line: 'Chat with other players and link your account with /link.',
          cta: 'Join Discord',
          href: '/discord',
        };
      }
    } catch { /* no answer: offer something else */ }
  }

  const bonus = Number(state.promotions?.referral?.bonusMinor ?? 0);
  if (bonus > 0 && route !== 'referrals' && Math.random() < 0.5) {
    return {
      kind: 'invite',
      eyebrow: 'Invite & earn',
      title: ['', money(bonus), ' per friend'],
      line: 'Share your link with your friends on DonutSMP.',
      cta: 'Get your link',
      href: '/referrals',
      art: 'totem.png',
    };
  }

  const game = pickSpotlight(`/${route}`);
  return {
    kind: 'game',
    eyebrow: isNewGame(game) ? 'New game' : 'Try a game',
    title: [game.name],
    line: game.line,
    cta: `Play ${game.name}`,
    href: game.route,
    art: game.art,
  };
}

function show(offer) {
  holdFor(SEEN_HOLD_MS);

  card = el('aside', 'nudge');
  card.dataset.kind = offer.kind;
  card.setAttribute('aria-label', offer.eyebrow);

  const shut = el('button', 'nudge__x');
  shut.type = 'button';
  shut.setAttribute('aria-label', 'Close');
  shut.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
  shut.addEventListener('click', () => close(SEEN_HOLD_MS));

  const art = el('span', 'nudge__art');
  art.setAttribute('aria-hidden', 'true');
  if (offer.kind === 'discord') {
    art.innerHTML = `<svg viewBox="0 0 24 24"><path d="${DISCORD_PATH}"/></svg>`;
  } else {
    const img = document.createElement('img');
    img.src = `${IMG}${offer.art}`;
    img.alt = '';
    art.appendChild(img);
  }

  const copy = el('div', 'nudge__copy');
  const eyebrow = el('p', 'nudge__eyebrow');
  eyebrow.textContent = offer.eyebrow;
  const title = el('p', 'nudge__h');
  // [before, amount, after]: the amount, when there is one, set in gold.
  const [before, amount, after] = offer.title;
  if (amount) {
    const gold = el('b');
    gold.textContent = amount;
    title.append(before, gold, after ?? '');
  } else {
    title.textContent = before;
  }
  const line = el('p', 'nudge__p');
  line.textContent = offer.line;
  copy.append(eyebrow, title, line);

  let go;
  if (offer.href) {
    go = el('a', 'btn btn--go nudge__go');
    go.href = offer.href;                 // the router's link handler takes it from here
  } else {
    go = el('button', 'btn btn--go nudge__go');
    go.type = 'button';
    go.addEventListener('click', () => openLogin());
  }
  go.textContent = offer.cta;
  go.addEventListener('click', () => close(USED_HOLD_MS));

  card.append(shut, art, copy, go);
  card.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close(SEEN_HOLD_MS);
  });
  document.body.appendChild(card);
  // Next frame, so the entrance runs from the hidden state rather than starting at the end.
  requestAnimationFrame(() => requestAnimationFrame(() => card?.classList.add('is-in')));
}

function close(holdMs) {
  if (!card) return;
  holdFor(holdMs);
  const leaving = card;
  card = null;
  leaving.classList.remove('is-in');
  // Removed on a timer rather than on transitionend, which never fires with motion reduced.
  window.setTimeout(() => leaving.remove(), 260);
}
