/* redeem-code.js — the window where a code from the Discord is redeemed.
 *
 * Code drops (2026-11-11, replacing the daily codes): every two hours the community bot posts one
 * code in the Discord, and the first few players to redeem it here get the prize, which they wager
 * a few times over before withdrawing. Nothing has to be wagered to claim one. The prize, the limit
 * and the payment are the server's (services/api-gateway/src/lib/code-drops.ts); this shows what it
 * says.
 *
 * Three ways in, all the same window: the drop post's "Redeem on DonutLuxe" button, whose link
 * carries the code in the URL's FRAGMENT (/#redeem=ABCD2345: a fragment never leaves the browser,
 * so the code reaches no server log; it is read once and cleared from the address bar), the account
 * menu's "Redeem code" row, and the Discord page.
 *
 * It is the site's own window (#modal), built like the sign-in card: the sprite in a slot, then the
 * code. No countdown to the next drop and no claim counts: the owner (2026-11-11) "its not needed".
 * Every state says what to do next:
 *   signed out   → log in (the window comes back, code kept, once they have)
 *   not linked   → the Discord page, where the link code is
 *   switched off → that, plainly
 *   ready        → the field, which formats as it is typed (ABCD-2345) and takes a paste
 *   refused      → the server's own words, under the field
 *   paid         → the prize, and what to wager before withdrawing it
 */
import { api } from './api.js';
import { bus, refreshBalance, turnstileConfig } from './store.js';
import { loadTurnstile } from './turnstile.js';
import { $, money } from './util.js';
import { closeModal, openModal } from './ui.js';

/* A code in a link: letters and digits, the dash optional. The server judges whether it is one. */
const FRAGMENT = /^#(?:redeem|daily)=([A-Za-z0-9-]{8,12})$/;
const CODE_LENGTH = 8;
const TITLE = 'Redeem a code';

let openLogin = () => {};
let typed = ''; // the field, formatted; kept across a login and a refusal
let resumeAfterLogin = false;
let openHost = null; // the window's body while it is showing

const escapeText = (value) => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

/** What was typed, reduced to its characters and shown with the dash: `abcd2345` → `ABCD-2345`. */
export function formatCode(raw) {
  const code = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LENGTH);
  return code.length > 4 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}
const complete = (value) => value.replace('-', '').length === CODE_LENGTH;

/** The code in a URL fragment, formatted, or '' when the fragment is not one. */
export function codeFromFragment(hash) {
  const match = FRAGMENT.exec(hash || '');
  return match ? formatCode(match[1]) : '';
}

function clearFragment() {
  try {
    history.replaceState(null, '', location.pathname + location.search);
  } catch {
    /* an address bar that keeps the fragment is not a problem, only untidy */
  }
}

export function initRedeemCode(options = {}) {
  openLogin = options.openLogin ?? openLogin;

  const row = document.getElementById('dailyCodeBtn');
  if (row) row.addEventListener('click', () => openRedeemCode());

  const fromLink = () => {
    const code = codeFromFragment(location.hash);
    if (!code) return;
    clearFragment();
    openRedeemCode({ code });
  };
  fromLink();
  window.addEventListener('hashchange', fromLink);

  /* Logging in answers "log in to redeem": the window comes back with the code still in it. And a
   * window opened from a link while the page was still starting is read again once it knows who is
   * signed in, so it never stays on a "log in" it did not need. */
  bus.addEventListener('change', (event) => {
    if (resumeAfterLogin && event.detail === 'login') {
      resumeAfterLogin = false;
      openRedeemCode();
      return;
    }
    if (['ready', 'login', 'logout'].includes(event.detail) && openHost?.isConnected && !openHost.querySelector('.rdm__paid')) {
      void load(openHost);
    }
  });
}

/** Opens the window. `code`, when given, fills the field. */
export function openRedeemCode({ code = '' } = {}) {
  if (code) typed = formatCode(code);
  let host = null;
  openModal(TITLE, (body) => {
    host = body;
    paintHead(body, 'Checking your account…');
  }, { variant: 'auth' });
  openHost = host;
  void load(host);
}

async function load(host) {
  let status = null;
  try {
    status = await api.get('/v1/discord/rewards');
  } catch {
    status = null;
  }
  // Gone, or the modal now shows something else (it is shared): nothing to paint.
  if (!host?.isConnected || host !== openHost || $('#modalTitle')?.textContent !== TITLE) return;
  paint(host, status);
}

/* ─────────── painting ─────────── */

const SPRITE = 'assets/img/items/enchanted_book.png';

function paintHead(body, sub) {
  body.innerHTML = `
    <div class="signin__head">
      <span class="signin__slot"><img src="${SPRITE}" alt="" width="48" height="48"></span>
      <div class="signin__titles">
        <h3 class="auth__title signin__title" aria-hidden="true">${TITLE}</h3>
        <p class="signin__sub"></p>
      </div>
    </div>`;
  $('.signin__sub', body).textContent = sub;
}

function paint(host, status) {
  const drops = status?.codeDrops;

  if (!status) {
    paintHead(host, 'The site could not be reached.');
    host.insertAdjacentHTML('beforeend', `<p class="auth__lede rdm__p">Check your connection and try again. Your code is not used up.</p>
      <button class="btn btn--go auth__go" type="button" id="rdmRetry">Try again</button>`);
    $('#rdmRetry', host).addEventListener('click', () => openRedeemCode());
    return;
  }
  if (!drops?.enabled) {
    paintHead(host, 'Code drops are switched off right now.');
    host.insertAdjacentHTML('beforeend', '<p class="auth__lede rdm__p">Check back soon.</p>');
    return;
  }

  paintHead(host, 'Enter a code from the DonutLuxe Discord.');

  // The server's own answer, read with the session cookie: right even before the page has started.
  const signedIn = Boolean(status.signedIn);
  if (!signedIn) {
    host.insertAdjacentHTML('beforeend', `<p class="auth__lede rdm__p">Log in with your Minecraft name and your
        code is waiting here.</p>
      <button class="btn btn--go auth__go" type="button" id="rdmLogin">Log in to redeem</button>`);
    $('#rdmLogin', host).addEventListener('click', () => {
      resumeAfterLogin = true;
      closeModal();
      openLogin();
    });
    return;
  }
  if (!status.linked) {
    host.insertAdjacentHTML('beforeend', `<p class="auth__lede rdm__p">Codes are for players whose Discord is linked.
        Get your link code on the Discord page and run <span class="mono">/link</span> in the server. Your code
        is kept.</p>
      <a class="btn btn--go auth__go rdm__link" href="/discord" id="rdmDiscord">Link Discord</a>`);
    $('#rdmDiscord', host).addEventListener('click', () => closeModal());
    return;
  }
  /* Deposited enough lately? (the owner, 2026-11-14: "add a 50m deposited in the last 3 days rule").
   * Said before a code is typed, from the server's own figures; the server checks again on redeem. */
  const rule = status.codeDropDeposit;
  if (rule && !rule.met) {
    paintHead(host, 'Deposit to unlock codes.');
    host.insertAdjacentHTML('beforeend', `<p class="auth__lede rdm__p" id="rdmDepositText"></p>
      <button class="btn btn--go auth__go" type="button" id="rdmDeposit">Deposit</button>`);
    $('#rdmDepositText', host).textContent = `Codes are for players who deposited ${money(Number(rule.requiredMinor))} `
      + `in the last ${windowText(rule.windowHours)}. You have deposited ${money(Number(rule.depositedMinor))}. Your code is kept.`;
    $('#rdmDeposit', host).addEventListener('click', () => {
      closeModal();
      document.getElementById('depositBtn')?.click();
    });
    return;
  }
  paintForm(host);
}

/** "3 days", "1 day", "36 hours". */
function windowText(hours) {
  if (hours % 24 !== 0) return `${hours} hours`;
  const days = hours / 24;
  return days === 1 ? '1 day' : `${days} days`;
}

/* No note under the button (the owner, 2026-11-12: "remove the text on the bottom"); what to wager
 * is said on the paid screen, once the code has paid. */
function paintForm(host) {
  host.insertAdjacentHTML('beforeend', `
    <form class="rdm__form" id="rdmForm" novalidate>
      <label class="auth__label" for="rdmCode">Your code</label>
      <div class="auth__field auth__field--code" id="rdmField">
        <input id="rdmCode" class="auth__input auth__input--code" type="text" inputmode="text"
               autocomplete="off" autocapitalize="characters" spellcheck="false"
               maxlength="${CODE_LENGTH + 1}" placeholder="ABCD-2345" aria-describedby="rdmError">
      </div>
      <p class="auth__err" id="rdmError" role="alert" hidden></p>
      <div class="auth__challenge" id="rdmChallenge" hidden></div>
      <button class="btn btn--go auth__go" type="submit" id="rdmGo" disabled>Redeem</button>
    </form>`);

  const input = $('#rdmCode', host);
  const field = $('#rdmField', host);
  const go = $('#rdmGo', host);
  const error = $('#rdmError', host);
  const slot = $('#rdmChallenge', host);
  const setError = (text) => {
    error.textContent = text;
    error.hidden = !text;
    field.classList.toggle('is-error', Boolean(text));
  };

  /* Cloudflare's challenge (the owner, 2026-11-13: "add turnstile"), as on the sign-in card: drawn
   * as the form opens, so it is usually passed before the code is pasted. The server says whether it
   * is on; Redeem waits for a passed one. A token is single-use, so every attempt asks for a new one. */
  let challengeRequired = false;
  let challengeToken = '';
  let challengeWidget;
  const ready = () => complete(typed) && (!challengeRequired || Boolean(challengeToken));
  const sync = () => { go.disabled = !ready(); };
  const spendChallenge = () => {
    challengeToken = '';
    if (challengeWidget !== undefined) {
      try {
        window.turnstile?.reset(challengeWidget);
      } catch {
        /* a widget that will not reset still leaves Redeem correctly disabled */
      }
    }
  };
  void (async () => {
    let settings;
    try {
      settings = await turnstileConfig();
    } catch {
      return; // the server decides; if it cannot be asked, Redeem will say so
    }
    if (!settings?.enabled || !settings.siteKey || !slot.isConnected) return;
    challengeRequired = true;
    sync();
    try {
      const turnstile = await loadTurnstile();
      if (!slot.isConnected) return;
      slot.hidden = false;
      challengeWidget = turnstile.render(slot, {
        sitekey: settings.siteKey,
        theme: 'dark',
        callback: (token) => {
          challengeToken = token;
          sync();
        },
        'expired-callback': () => {
          challengeToken = '';
          sync();
        },
        'error-callback': () => {
          challengeToken = '';
          sync();
        },
      });
    } catch {
      slot.hidden = false;
      slot.textContent = 'The challenge could not load. Disable your blocker and reopen this window.';
    }
  })();

  input.value = typed;
  sync();
  input.addEventListener('input', () => {
    typed = formatCode(input.value);
    input.value = typed;
    sync();
    setError('');
  });

  $('#rdmForm', host).addEventListener('submit', async (event) => {
    event.preventDefault();
    if (go.disabled || !ready()) return;
    go.disabled = true;
    go.setAttribute('aria-busy', 'true');
    go.textContent = 'Redeeming…';
    const token = challengeToken;
    let result;
    try {
      result = await api.post('/v1/discord/codes/redeem', token ? { code: typed, turnstileToken: token } : { code: typed });
    } catch (failure) {
      if (failure?.status === 401) {
        void load(host); // the session ran out: the window says "log in" as it does on opening
        return;
      }
      result = { status: 'refused', reason: failure?.message || 'Could not redeem. Try again', keepCode: true };
    } finally {
      spendChallenge();
    }
    go.removeAttribute('aria-busy');
    go.textContent = 'Redeem';
    if (result.status === 'paid') {
      typed = '';
      void refreshBalance();
      paintPaid(host, result);
      return;
    }
    if (!result.keepCode) {
      typed = '';
      input.value = '';
    }
    sync();
    setError(`${result.reason}.`.replace(/\.\.$/, '.'));
    input.focus();
  });
  input.focus();
}

function paintPaid(host, result) {
  host.innerHTML = `
    <div class="rdm__paid">
      <span class="signin__slot rdm__paidslot"><img src="${SPRITE}" alt="" width="48" height="48"></span>
      <p class="rdm__amount">+${escapeText(money(Number(result.prizeMinor)))}</p>
      <h3 class="auth__title rdm__paidtitle">Code redeemed</h3>
      <p class="auth__lede rdm__paidtext"></p>
    </div>
    <button class="btn btn--go auth__go" type="button" id="rdmDone">Done</button>`;
  $('.rdm__paidtext', host).textContent = Number(result.wagerMinor) > 0
    ? `Added to your balance. Wager ${money(Number(result.wagerMinor))} before withdrawing it.`
    : 'Added to your balance.';
  $('#rdmDone', host).addEventListener('click', () => closeModal());
  $('#rdmDone', host).focus();
}
