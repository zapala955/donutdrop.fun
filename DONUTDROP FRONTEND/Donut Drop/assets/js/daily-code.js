/* daily-code.js — the window where a daily code is redeemed.
 *
 * The Discord bot DMs a member one personal code a day. It cannot redeem it: redeeming is done here,
 * by a signed-in player, so a code is only ever worth something to the site account whose linked
 * Discord it was sent to. The prize, the draw and the payment are the server's; this window shows
 * what it said.
 *
 * Three ways in, all the same window:
 *   - the DM's "Redeem on the site" button, whose link carries the code in the URL's FRAGMENT
 *     (/#redeem=ABCD2345). A fragment never leaves the browser, so the code reaches neither the
 *     server's logs nor the CDN; it is read once, the window opens with the field filled, and the
 *     address bar is cleared;
 *   - the account menu's "Daily code" row;
 *   - the Discord page.
 *
 * What it says depends on who is looking, and every state says what to do next:
 *   signed out       → log in (the window comes back, code kept, once they have)
 *   not linked       → the Discord page, where the link code is
 *   switched off     → that, plainly
 *   below the day's wagering bar (2M by default) → how far they are, with a bar, a button to go and
 *                      play, and a quiet re-check every few seconds, so the field appears by itself
 *                      the moment the bar is met
 *   ready            → the field, which formats as it is typed (ABCD-2345) and takes a paste
 *   after redeeming  → the prize and the wagering that unlocks it, nothing, or the server's own
 *                      words for why not (and whether the code is kept for another try)
 *
 * A real <dialog> opened with showModal(): the page behind is inert, Escape closes it, focus is
 * trapped inside and goes back to where it was. Its look is popups.css's, plus daily-code.css. */
import { api } from './api.js';
import { bus, refreshBalance } from './store.js';
import { IMG } from './data.js';
import { el, money } from './util.js';

/* A code in a link: letters and digits, the dash optional. The server judges whether it is one. */
const FRAGMENT = /^#(?:redeem|daily)=([A-Za-z0-9-]{8,12})$/;
const CODE_LENGTH = 8;
/* While the bar is not met, how often the window asks again. The player is off playing a game in
 * another tab; the field is waiting for them when they come back. */
const RECHECK_MS = 12_000;

let openLogin = () => {};
let dialog = null;
let opener = null;
let status = null; // GET /v1/discord/rewards, or null when it could not be read
let phase = 'loading'; // loading | error | ready | result
let result = null; // what the server said about the last attempt
let typed = ''; // the field, formatted; kept across a login and a "try again"
let busy = false;
let resumeAfterLogin = false;
let recheck = 0;

/* The day's wagering bar and how far the player is, from the server's own figures. */
const bar = () => Number(status?.dailyCodes?.minWagerMinor ?? 0);
const wagered = () => Number(status?.dailyCodes?.progress?.wageredMinor ?? 0);
const locked = () => bar() > 0 && wagered() < bar();

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

export function initDailyCode(options = {}) {
  openLogin = options.openLogin ?? openLogin;

  const row = document.getElementById('dailyCodeBtn');
  if (row) row.addEventListener('click', () => openDailyCode());

  const fromLink = () => {
    const code = codeFromFragment(location.hash);
    if (!code) return;
    clearFragment();
    openDailyCode({ code });
  };
  fromLink();
  window.addEventListener('hashchange', fromLink);

  // Signing in answers "log in to redeem": the window comes back with the code still in it.
  bus.addEventListener('change', (event) => {
    if (!['login', 'ready', 'logout'].includes(event.detail)) return;
    if (dialog) void load();
    else if (resumeAfterLogin && event.detail === 'login') {
      resumeAfterLogin = false;
      openDailyCode();
    }
  });
}

/** Opens the window. `code`, when given, fills the field. */
export function openDailyCode({ code = '' } = {}) {
  if (code) typed = formatCode(code);
  result = null;
  if (dialog) {
    void load();
    return;
  }
  opener = document.activeElement;
  dialog = document.createElement('dialog');
  dialog.className = 'popup dcode';
  dialog.setAttribute('aria-labelledby', 'dcodeTitle');

  // Escape is the platform's own cancel; a click on the backdrop lands on the dialog itself.
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) close();
  });

  document.body.appendChild(dialog);
  dialog.showModal();
  // Next frame, so the entrance runs from the hidden state rather than starting at the end.
  requestAnimationFrame(() => requestAnimationFrame(() => dialog?.classList.add('is-in')));
  phase = 'loading';
  paint();
  void load();
}

function close() {
  if (!dialog) return;
  window.clearTimeout(recheck);
  const leaving = dialog;
  dialog = null;
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

/** Reads who is looking and how they stand. `quiet` re-reads without blanking the window. */
async function load({ quiet = false } = {}) {
  window.clearTimeout(recheck);
  if (!quiet) {
    phase = 'loading';
    paint();
  }
  try {
    status = await api.get('/v1/discord/rewards');
    if (!quiet || phase === 'ready') phase = 'ready';
  } catch {
    if (quiet) return; // a failed re-check changes nothing on screen
    status = null;
    phase = 'error';
  }
  paint();
  // Below the bar, keep asking: the field appears by itself when they have played enough.
  if (dialog && phase === 'ready' && status?.signedIn && status.linked && locked()) {
    recheck = window.setTimeout(() => void load({ quiet: true }), RECHECK_MS);
  }
}

/* ─────────── painting ─────────── */

function closeButton() {
  const shut = el('button', 'popup__x');
  shut.type = 'button';
  shut.setAttribute('aria-label', 'Close');
  shut.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
  shut.addEventListener('click', close);
  return shut;
}

function art(file) {
  const holder = el('span', 'popup__art');
  holder.setAttribute('aria-hidden', 'true');
  const img = document.createElement('img');
  img.src = `${IMG}${file}`;
  img.alt = '';
  holder.appendChild(img);
  return holder;
}

function heading(eyebrow, parts) {
  const top = el('p', 'popup__eyebrow');
  top.textContent = eyebrow;
  const title = el('h2', 'popup__h');
  title.id = 'dcodeTitle';
  // [before, amount, after]: the amount, when there is one, set in gold.
  const [before, amount, after] = parts;
  if (amount) {
    const gold = el('b');
    gold.textContent = amount;
    title.append(before, gold, after ?? '');
  } else {
    title.textContent = before;
  }
  return [top, title];
}

function paragraph(text) {
  const p = el('p', 'popup__p');
  p.textContent = text;
  return p;
}

function actions(...children) {
  const box = el('div', 'popup__acts');
  box.append(...children);
  return box;
}

function primary(label, onClick) {
  const go = el('button', 'btn btn--go popup__go');
  go.type = 'button';
  go.textContent = label;
  go.addEventListener('click', onClick);
  return go;
}

function secondary(label, onClick) {
  const later = el('button', 'popup__later');
  later.type = 'button';
  later.textContent = label;
  later.addEventListener('click', onClick);
  return later;
}

const ceiling = () => {
  const max = Number(status?.dailyCodes?.maxPrizeMinor ?? 0);
  return max > 0 ? `up to ${money(max)}` : 'up to a big prize';
};

function paint() {
  if (!dialog) return;
  const card = el('div', 'popup__card dcode__card');
  let focus = null;
  card.appendChild(closeButton());

  if (phase === 'loading') {
    card.append(art('ender_chest.png'), ...heading('Daily code', ['Redeem your code']));
    card.appendChild(paragraph('Checking your account…'));
  } else if (phase === 'error') {
    card.append(art('ender_chest.png'), ...heading('Daily code', ['Could not reach the site']));
    card.appendChild(paragraph('Check your connection and try again. Your code is not used up.'));
    const retry = primary('Try again', () => void load());
    card.appendChild(actions(retry, secondary('Close', close)));
    focus = retry;
  } else if (phase === 'result' && result) {
    focus = paintResult(card);
  } else if (!status?.dailyCodes?.enabled) {
    card.append(art('ender_chest.png'), ...heading('Daily code', ['Switched off']));
    card.appendChild(paragraph('Daily codes are switched off right now. Check back soon.'));
    const done = primary('Close', close);
    card.appendChild(actions(done));
    focus = done;
  } else if (!status.signedIn) {
    card.append(art('ender_chest.png'), ...heading('Daily code', ['Log in to redeem']));
    card.appendChild(
      paragraph(
        `Your code is worth ${ceiling()}. Log in with your Minecraft name and it is waiting here.`,
      ),
    );
    const login = primary('Log in', () => {
      resumeAfterLogin = true;
      close();
      openLogin();
    });
    card.appendChild(actions(login, secondary('Not now', close)));
    focus = login;
  } else if (!status.linked) {
    card.append(art('ender_chest.png'), ...heading('Daily code', ['Link Discord first']));
    card.appendChild(
      paragraph(
        'A daily code only works on the account linked to the Discord it was sent to. Get your ' +
          'link code on the Discord page and run /link in the server. Your code is kept for 24 hours.',
      ),
    );
    const go = el('a', 'btn btn--go popup__go');
    go.href = '/discord'; // the router's link handler takes it from here
    go.textContent = 'Link Discord';
    go.addEventListener('click', close);
    card.appendChild(actions(go, secondary('Not now', close)));
    focus = go;
  } else {
    focus = locked() ? paintLocked(card) : paintForm(card);
  }

  dialog.replaceChildren(card);
  if (focus) focus.focus({ preventScroll: true });
}

function paintForm(card) {
  card.append(art('ender_chest.png'), ...heading('Daily code', ['Redeem your code']));
  card.appendChild(
    paragraph(`Paste the code from your Discord DM. It can be worth anything from nothing ${ceiling()}.`),
  );

  const form = el('form', 'dcode__form');
  form.noValidate = true;

  const label = el('label', 'dcode__label');
  label.htmlFor = 'dcodeInput';
  label.textContent = 'Your code';

  const field = el('div', 'dcode__field');
  const input = el('input', 'dcode__input');
  input.id = 'dcodeInput';
  input.type = 'text';
  input.inputMode = 'text';
  input.autocomplete = 'off';
  input.autocapitalize = 'characters';
  input.spellcheck = false;
  input.maxLength = CODE_LENGTH + 1;
  input.placeholder = 'ABCD-2345';
  input.value = typed;
  input.setAttribute('aria-describedby', 'dcodeHint dcodeError');
  field.appendChild(input);

  const hint = el('p', 'dcode__hint');
  hint.id = 'dcodeHint';
  hint.textContent =
    (bar() > 0 ? `You have wagered the ${money(bar())} for today. ` : '') +
    'It works once, for 24 hours, and only on this account.';

  const error = el('p', 'dcode__err');
  error.id = 'dcodeError';
  error.setAttribute('role', 'alert');

  const submit = el('button', 'btn btn--go popup__go');
  submit.type = 'submit';
  submit.textContent = 'Redeem';
  submit.disabled = !complete(typed);

  input.addEventListener('input', () => {
    typed = formatCode(input.value);
    input.value = typed;
    submit.disabled = busy || !complete(typed);
    error.textContent = '';
    field.classList.remove('is-error');
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (busy || !complete(typed)) return;
    void redeem(submit, error, field);
  });

  form.append(label, field, hint, error, actions(submit, secondary('Not now', close)));
  card.appendChild(form);
  return input;
}

async function redeem(submit, error, field) {
  busy = true;
  submit.disabled = true;
  submit.textContent = 'Redeeming…';
  try {
    result = await api.post('/v1/discord/daily-code/redeem', { code: typed });
    if (result.status === 'locked') {
      // Below the bar: show how far they are, as the window does on opening, and keep the code.
      status.dailyCodes.minWagerMinor = result.requiredMinor;
      status.dailyCodes.progress = {
        ...(status.dailyCodes.progress ?? {}),
        requiredMinor: result.requiredMinor,
        wageredMinor: result.wageredMinor,
        hasCode: true,
      };
      result = null;
      phase = 'ready';
      paint();
      window.clearTimeout(recheck);
      recheck = window.setTimeout(() => void load({ quiet: true }), RECHECK_MS);
      return;
    }
    phase = 'result';
    if (result.status === 'paid') void refreshBalance();
    paint();
  } catch (problem) {
    if (problem?.status === 401) {
      // The session ran out while the window was open: say so as the login state does.
      await load();
    } else {
      error.textContent = problem?.message || 'Could not redeem. Try again.';
      field.classList.add('is-error');
      submit.textContent = 'Redeem';
      submit.disabled = !complete(typed);
    }
  } finally {
    busy = false;
  }
}

/** Below the day's bar: how far they are, and the way to go and play. Returns the focus target. */
function paintLocked(card) {
  const need = bar();
  const have = Math.min(wagered(), need);
  card.append(
    art('ender_chest_shut.png'),
    ...heading('Daily code', ['Wager ', money(need - have), ' to unlock']),
  );
  card.appendChild(
    paragraph(
      `Your code opens once you have wagered ${money(need)} today. Play any game on the site; ` +
        'this window updates by itself.',
    ),
  );

  const meter = el('div', 'dcode__meter');
  meter.setAttribute('role', 'progressbar');
  meter.setAttribute('aria-label', 'Wagered today');
  meter.setAttribute('aria-valuemin', '0');
  meter.setAttribute('aria-valuemax', String(need));
  meter.setAttribute('aria-valuenow', String(have));
  const label = el('div', 'dcode__meterlabel');
  const name = el('span');
  name.textContent = 'Wagered today (UTC)';
  const figures = el('b');
  figures.textContent = `${money(have)} / ${money(need)}`;
  label.append(name, figures);
  const track = el('div', 'dcode__track');
  const fill = el('i', 'dcode__fill');
  fill.style.width = `${Math.max(2, Math.min(100, Math.round((have / need) * 100)))}%`;
  track.appendChild(fill);
  meter.append(label, track);
  card.appendChild(meter);

  const play = el('a', 'btn btn--go popup__go');
  play.href = '/'; // the router's link handler takes it from here
  play.textContent = 'Play now';
  play.addEventListener('click', close);
  card.appendChild(actions(play, secondary('Check again', () => void load())));
  return play;
}

/** The answer. Returns the element that should have focus. */
function paintResult(card) {
  if (result.status === 'paid') {
    card.append(
      art('ender_chest_open.png'),
      ...heading('Daily code redeemed', ['+', money(Number(result.prizeMinor)), '']),
    );
    card.appendChild(
      paragraph(
        `Added to your balance, ${result.username}. It is playable now, and can be withdrawn once ` +
          `you have wagered ${money(Number(result.wagerMinor))}.`,
      ),
    );
    typed = '';
    const done = primary('Done', close);
    card.appendChild(actions(done));
    return done;
  }
  if (result.status === 'nothing') {
    card.append(art('ender_chest_shut.png'), ...heading('Daily code redeemed', ['Nothing this time']));
    card.appendChild(
      paragraph(
        `The code was valid, ${result.username}, but today’s draw came up empty. A new code ` +
          'arrives in your DMs tomorrow.',
      ),
    );
    typed = '';
    const done = primary('Done', close);
    card.appendChild(actions(done));
    return done;
  }
  // Refused: the server's own words, and whether the code is still good for another go.
  card.append(art('ender_chest_shut.png'), ...heading('Daily code', ['Not redeemed']));
  card.appendChild(paragraph(`${result.reason}.`.replace(/\.\.$/, '.')));
  if (result.keepCode) {
    // The code is kept, but nothing typed again today will change the answer: Close leads.
    const done = primary('Close', close);
    const back = secondary('Back', () => {
      result = null;
      phase = 'ready';
      paint();
    });
    card.appendChild(actions(done, back));
    return done;
  }
  typed = '';
  const another = primary('Try another code', () => {
    result = null;
    phase = 'ready';
    paint();
  });
  card.appendChild(actions(another, secondary('Close', close)));
  return another;
}
