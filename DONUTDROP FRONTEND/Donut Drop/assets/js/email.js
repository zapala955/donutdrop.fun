/* email.js — an email on the account (2026-11-10).
 *
 *   paintLoginChoice   the sign-in card, for a name whose account has an email linked: a code to it,
 *                      or paying the bot (2026-11-11; it replaced a separate "Log in with email")
 *   paintLoginCode     the code that signs that account in
 *   emailCard          the profile's Email card: link, change (a code from the old address and one
 *                      from the new), remove (a code from it)
 *   minecraftCard      the profile's Minecraft card: with an email linked, move the account to another
 *                      Minecraft account (a code from the email, then the new account pays the bot,
 *                      exactly like signing up)
 *
 * Every rule lives on the server (routes/email.ts); this only asks and shows the answer. When the
 * site's daily email allowance is spent, the server says so and these say "email is paused for today".
 */
import {
  accountEmail,
  emailConfirmCode,
  emailLinkStart,
  emailLinkVerify,
  emailLoginComplete,
  emailRemove,
  loginStatus,
  relinkComplete,
  relinkStart,
} from './store.js';
import { $ } from './util.js';
import { closeModal, openModal, toast } from './ui.js';

const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const CODE = /^\d{6}$/;
const MINECRAFT_NAME = /^(?:[A-Za-z0-9_]{3,16}|\.[A-Za-z0-9_]{2,15})$/;
const RESEND_SECONDS = 60;
const PAUSED = 'Email is paused for today: the daily email limit has been reached. Try again tomorrow.';

const escapeText = (value) => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

const messageOf = (error, fallback) =>
  error?.code === 'EMAIL_DAILY_LIMIT' ? PAUSED : error?.message || fallback;

/* A button's busy state: disabled, its label swapped, and aria-busy for a screen reader. */
async function busy(button, label, work) {
  const text = button.textContent;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = label;
  try {
    return await work();
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.textContent = text;
    }
  }
}

/* "Send again" that counts down from a minute: the server refuses sooner, so the button does too. */
function armResend(button, send) {
  let timer = 0;
  const tick = (left) => {
    if (!button.isConnected) return;
    button.disabled = left > 0;
    button.textContent = left > 0 ? `Send again in ${left}s` : 'Send again';
    if (left > 0) timer = setTimeout(() => tick(left - 1), 1000);
  };
  button.addEventListener('click', async () => {
    clearTimeout(timer);
    try {
      await busy(button, 'Sending…', send);
      tick(RESEND_SECONDS);
    } catch {
      tick(0);
    }
  });
  tick(RESEND_SECONDS);
}

const codeField = (id) => `
  <div class="auth__field auth__field--code">
    <input id="${id}" class="auth__input auth__input--code" type="text" inputmode="numeric"
           autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" placeholder="000000" spellcheck="false">
  </div>`;

const emailField = (id, placeholder = 'you@example.com') => `
  <div class="auth__field">
    <input id="${id}" class="auth__input" type="email" maxlength="254" autocomplete="email"
           autocapitalize="none" spellcheck="false" placeholder="${placeholder}">
  </div>`;

/* Digits only, as typed or pasted ("123 456" from a mail app arrives as 123456). */
function digitsOnly(input) {
  input.addEventListener('input', () => {
    const clean = input.value.replace(/\D/g, '').slice(0, 6);
    if (clean !== input.value) input.value = clean;
  });
}

/* ═════════════════════════ the sign-in card ═════════════════════════ */

const MAIL_BOLD = '<svg viewBox="0 0 256 256" aria-hidden="true"><path d="M224,44H32A12,12,0,0,0,20,56V192a20,20,0,0,0,20,20H216a20,20,0,0,0,20-20V56A12,12,0,0,0,224,44ZM193.15,68,128,127.72,62.85,68ZM44,188V83.28l75.89,69.57a12,12,0,0,0,16.22,0L212,83.28V188Z"/></svg>';
const COINS_BOLD = '<svg viewBox="0 0 256 256" aria-hidden="true"><path d="M188,86.11V84c0-14.62-10.83-27.55-30.51-36.4C140.87,40.12,119,36,96,36S51.13,40.12,34.51,47.6C14.83,56.45,4,69.38,4,84v40c0,14.62,10.83,27.55,30.51,36.4A131.67,131.67,0,0,0,68,169.88V172c0,14.62,10.83,27.55,30.51,36.4C115.13,215.88,137,220,160,220s44.87-4.12,61.49-11.6C241.17,199.55,252,186.62,252,172V132C252,109.86,226.71,92.08,188,86.11ZM228,132c0,7.75-21.77,22.48-61.81,23.88C180.33,147.4,188,136.3,188,124V110.44C213.88,115.15,228,125.48,228,132ZM107.37,147.63c-3.63.24-7.42.37-11.37.37-5.08,0-9.89-.22-14.43-.61a10.94,10.94,0,0,0-1.14-.09c-1.51-.14-3-.3-4.43-.48V130.93A187,187,0,0,0,96,132a187,187,0,0,0,20-1.07v15.89c-2.49.3-5.07.56-7.75.75C108,147.58,107.66,147.6,107.37,147.63ZM164,117.14V124c0,4.78-8.28,12.21-24,17.54v-15a115.32,115.32,0,0,0,17.49-6.13Q160.93,118.86,164,117.14ZM96,60c44,0,68,15.85,68,24s-24,24-68,24S28,92.15,28,84,52,60,96,60ZM28,124v-6.86q3.08,1.71,6.51,3.26A115.32,115.32,0,0,0,52,126.53v15C36.28,136.21,28,128.78,28,124Zm64,48v0c1.33,0,2.66,0,4,0q5.44,0,10.77-.32,4.45,1.57,9.23,2.86v15C100.28,184.21,92,176.78,92,172Zm48,22.82V178.94A186.45,186.45,0,0,0,160,180a187,187,0,0,0,20-1.07v15.89a170.08,170.08,0,0,1-40,0Zm64-5.28v-15a115.32,115.32,0,0,0,17.49-6.13q3.44-1.54,6.51-3.26V172C228,176.78,219.72,184.21,204,189.54Z"/></svg>';
const CARET_BOLD = '<svg class="lpick__chev" viewBox="0 0 256 256" aria-hidden="true"><path d="M184.49,136.49l-80,80a12,12,0,0,1-17-17L159,128,87.51,56.49a12,12,0,1,1,17-17l80,80A12,12,0,0,1,184.49,136.49Z"/></svg>';

/**
 * The sign-in card, once the name typed belongs to an account with an email linked: two ways in,
 * a code to that email or the payment as always. Painted into `slot`, the card's own progress area,
 * while the card keeps its form (hidden), because the payment path signs in from that same card.
 *
 * `onCode` and `onPay` belong to the card (app.js), which holds the one-use Turnstile token both
 * spend; each paints whatever comes next, or puts the form back with the reason if it fails.
 */
export function paintLoginChoice(slot, { username, onCode, onPay, onBack }) {
  slot.innerHTML = `
    <div class="lpick">
      <p class="auth__lede">Welcome back, <b class="lpick__name"></b>. How do you want to log in?</p>
      <div class="lpick__list">
        <button class="lpick__opt lpick__opt--main" type="button" data-pick="code">
          <span class="lpick__icon">${MAIL_BOLD}</span>
          <span class="lpick__words"><b>Email me a code</b><small>To the email on your account. Nothing to pay.</small></span>
          ${CARET_BOLD}
        </button>
        <button class="lpick__opt" type="button" data-pick="pay">
          <span class="lpick__icon">${COINS_BOLD}</span>
          <span class="lpick__words"><b>Pay the bot</b><small>/pay a small amount in game. It lands in your balance.</small></span>
          ${CARET_BOLD}
        </button>
      </div>
      <button class="auth__link" type="button" data-pick="back">Use a different username</button>
    </div>`;
  $('.lpick__name', slot).textContent = username;
  const options = [...slot.querySelectorAll('.lpick__opt')];
  const choose = async (button, label, work) => {
    options.forEach((option) => { option.disabled = true; });
    button.setAttribute('aria-busy', 'true');
    $('small', button).textContent = label;
    await work();
  };
  slot.querySelector('[data-pick="code"]').addEventListener('click', (event) => {
    void choose(event.currentTarget, 'Sending your code…', onCode);
  });
  slot.querySelector('[data-pick="pay"]').addEventListener('click', (event) => {
    void choose(event.currentTarget, 'Getting your payment ready…', onPay);
  });
  slot.querySelector('[data-pick="back"]').addEventListener('click', onBack);
  options[0].focus();
}

/** The code sent to the account's email, which signs it in. */
export function paintLoginCode(slot, { username, masked, onPay, onDone }) {
  slot.innerHTML = `
    <p class="auth__lede">We sent a 6-digit code to <b class="lpick__mail"></b>. It works for 10 minutes.</p>
    <form id="lcForm" novalidate>
      <label class="auth__label" for="lcCode">Code</label>
      ${codeField('lcCode')}
      <p class="auth__err" id="lcError" role="alert" hidden></p>
      <div class="auth__foot">
        <button class="btn btn--go auth__go" type="submit" id="lcGo" disabled>Log in</button>
      </div>
    </form>
    <p class="auth__note lpick__hint">Not there? Check your spam folder; it can take a minute.</p>
    <button class="auth__link" type="button" id="lcPay">Pay the bot instead</button>`;
  $('.lpick__mail', slot).textContent = masked || 'your email';
  const input = $('#lcCode', slot);
  const go = $('#lcGo', slot);
  const error = $('#lcError', slot);
  const setError = (text) => { error.textContent = text; error.hidden = !text; };
  digitsOnly(input);
  input.addEventListener('input', () => { setError(''); go.disabled = !CODE.test(input.value); });
  $('#lcPay', slot).addEventListener('click', onPay);
  $('#lcForm', slot).addEventListener('submit', async (event) => {
    event.preventDefault();
    if (go.disabled) return;
    try {
      const user = await busy(go, 'Logging in…', () => emailLoginComplete(username, input.value));
      onDone(user);
    } catch (failure) {
      setError(messageOf(failure, 'That code did not work.'));
    }
  });
  input.focus();
}

/* ═════════════════════════ the profile ═════════════════════════ */

/* A card: a heading, a line under it, and a body that the flows below repaint in place. */
function card(title, icon) {
  const section = document.createElement('section');
  section.className = 'prof__card';
  section.innerHTML = `
    <header class="prof__cardhead">
      <span class="prof__icon" aria-hidden="true">${icon}</span>
      <h2 class="prof__h"></h2>
    </header>
    <div class="prof__body"></div>`;
  $('.prof__h', section).textContent = title;
  return { section, body: $('.prof__body', section) };
}

export const MAIL_ICON = '<svg viewBox="0 0 256 256" aria-hidden="true"><path d="M224,48H32a8,8,0,0,0-8,8V192a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A8,8,0,0,0,224,48ZM203.43,64,128,133.15,52.57,64ZM216,192H40V74.19l82.59,75.71a8,8,0,0,0,10.82,0L216,74.19V192Z"/></svg>';
const CUBE_ICON = '<svg viewBox="0 0 256 256"><path d="M223.68,66.15,135.68,18a15.88,15.88,0,0,0-15.36,0l-88,48.17a16,16,0,0,0-8.32,14v95.64a16,16,0,0,0,8.32,14l88,48.17a15.88,15.88,0,0,0,15.36,0l88-48.17a16,16,0,0,0,8.32-14V80.18A16,16,0,0,0,223.68,66.15ZM128,32l80.34,44-29.77,16.3-80.35-44ZM128,120,47.66,76l33.9-18.56,80.34,44ZM40,90l80,43.78v85.79L40,175.82Zm96,129.57V133.82L216,90v85.78Z"/></svg>';

/* English dates, like the rest of the site's words (chat.js uses en-GB too), whatever the browser's language. */
const dateOf = (value) => (value ? new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');

/** The Email card. `info` is GET /v1/account/email; `refresh` repaints the whole profile. */
export function emailCard(info, refresh) {
  const { section, body } = card('Email', MAIL_ICON);

  const idle = () => {
    if (!info.enabled) {
      body.innerHTML = '<p class="prof__p">Email isn\'t available on the site yet.</p>';
      return;
    }
    const paused = !info.available;
    if (!info.email) {
      body.innerHTML = `
        <p class="prof__p">No email linked. Link one to sign in with a code instead of paying the bot,
          and to be able to move your account to another Minecraft account.</p>
        ${paused ? `<p class="prof__note">${PAUSED}</p>` : ''}
        <div class="prof__actions"><button class="btn btn--go prof__btn" type="button" data-act="link" ${paused ? 'disabled' : ''}>Link an email</button></div>`;
    } else {
      body.innerHTML = `
        <div class="prof__value"><b class="prof__strong"></b><span class="prof__tag">Verified</span></div>
        <p class="prof__note">Linked ${escapeText(dateOf(info.verifiedAt))}. Use it to sign in with a code.</p>
        ${paused ? `<p class="prof__note">${PAUSED}</p>` : ''}
        <div class="prof__actions">
          <button class="btn prof__btn" type="button" data-act="change" ${paused ? 'disabled' : ''}>Change</button>
          <button class="btn prof__btn prof__btn--quiet" type="button" data-act="remove" ${paused ? 'disabled' : ''}>Remove</button>
        </div>`;
      $('.prof__strong', body).textContent = info.email;
    }
    body.querySelector('[data-act="link"]')?.addEventListener('click', () => linkFlow(false));
    body.querySelector('[data-act="change"]')?.addEventListener('click', () => confirmFlow('change_email', () => linkFlow(true)));
    body.querySelector('[data-act="remove"]')?.addEventListener('click', () => confirmFlow('remove_email', removeFlow));
  };

  /* A code from the CURRENT address, for a change or a removal; then `next(code)`. */
  const confirmFlow = (action, next) => {
    body.innerHTML = `
      <p class="prof__p">First, confirm it's you: we'll send a code to <b>${escapeText(info.email)}</b>.</p>
      <p class="auth__err" data-err role="alert" hidden></p>
      <div class="prof__actions">
        <button class="btn btn--go prof__btn" type="button" data-act="send">Send code</button>
        <button class="btn prof__btn prof__btn--quiet" type="button" data-act="cancel">Cancel</button>
      </div>`;
    const err = body.querySelector('[data-err]');
    body.querySelector('[data-act="cancel"]').addEventListener('click', idle);
    body.querySelector('[data-act="send"]').addEventListener('click', async (event) => {
      try {
        await busy(event.currentTarget, 'Sending…', () => emailConfirmCode(action));
        next();
      } catch (failure) {
        err.textContent = messageOf(failure, 'The code could not be sent.');
        err.hidden = false;
      }
    });
  };

  /* Linking a new address. With an address already linked (a change), the code from the current one
   * is asked for on the same form, and sent with the new address. */
  const linkFlow = (changing = false) => {
    body.innerHTML = `
      <form class="prof__form" novalidate>
        ${changing ? `<label class="auth__label" for="pfConfirm">Code sent to ${escapeText(info.email)}</label>${codeField('pfConfirm')}` : ''}
        <label class="auth__label" for="pfEmail">${changing ? 'New email' : 'Email'}</label>
        ${emailField('pfEmail')}
        <p class="auth__err" data-err role="alert" hidden></p>
        <div class="prof__actions">
          <button class="btn btn--go prof__btn" type="submit" data-act="send" disabled>Send code</button>
          <button class="btn prof__btn prof__btn--quiet" type="button" data-act="cancel">Cancel</button>
        </div>
      </form>`;
    const form = $('.prof__form', body);
    const email = $('#pfEmail', body);
    const confirm = $('#pfConfirm', body);
    const send = body.querySelector('[data-act="send"]');
    const err = body.querySelector('[data-err]');
    if (confirm) digitsOnly(confirm);
    const sync = () => {
      err.hidden = true;
      send.disabled = !(EMAIL.test(email.value.trim()) && (!confirm || CODE.test(confirm.value)));
    };
    email.addEventListener('input', sync);
    confirm?.addEventListener('input', sync);
    body.querySelector('[data-act="cancel"]').addEventListener('click', idle);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (send.disabled) return;
      const address = email.value.trim();
      try {
        const sent = await busy(send, 'Sending…', () => emailLinkStart(address, confirm?.value));
        codeFlow(sent.email, () => emailLinkStart(address));
      } catch (failure) {
        err.textContent = messageOf(failure, 'The code could not be sent.');
        err.hidden = false;
      }
    });
    (confirm ?? email).focus();
  };

  /* The code sent to the NEW address. Sending it again needs no second code from the old one: the
   * server only re-sends to the address this change already proved the old one for. */
  const codeFlow = (masked, resend) => {
    body.innerHTML = `
      <form class="prof__form" novalidate>
        <p class="prof__p">We sent a 6-digit code to <b>${escapeText(masked)}</b>.</p>
        <label class="auth__label" for="pfCode">Code</label>
        ${codeField('pfCode')}
        <p class="auth__err" data-err role="alert" hidden></p>
        <div class="prof__actions">
          <button class="btn btn--go prof__btn" type="submit" data-act="verify" disabled>Link email</button>
          <button class="btn prof__btn prof__btn--quiet" type="button" data-act="resend">Send again</button>
          <button class="btn prof__btn prof__btn--quiet" type="button" data-act="cancel">Cancel</button>
        </div>
      </form>`;
    const input = $('#pfCode', body);
    const verify = body.querySelector('[data-act="verify"]');
    const err = body.querySelector('[data-err]');
    digitsOnly(input);
    input.addEventListener('input', () => { err.hidden = true; verify.disabled = !CODE.test(input.value); });
    body.querySelector('[data-act="cancel"]').addEventListener('click', idle);
    armResend(body.querySelector('[data-act="resend"]'), async () => {
      try { await resend(); } catch (failure) { err.textContent = messageOf(failure, 'The code could not be sent.'); err.hidden = false; throw failure; }
    });
    $('.prof__form', body).addEventListener('submit', async (event) => {
      event.preventDefault();
      if (verify.disabled) return;
      try {
        const linked = await busy(verify, 'Linking…', () => emailLinkVerify(input.value));
        toast({ kind: 'win', title: 'Email linked', body: linked.email });
        refresh();
      } catch (failure) {
        err.textContent = messageOf(failure, 'That code did not work.');
        err.hidden = false;
      }
    });
    input.focus();
  };

  const removeFlow = () => {
    body.innerHTML = `
      <form class="prof__form" novalidate>
        <p class="prof__p">Enter the code we sent to <b>${escapeText(info.email)}</b> to remove it. You
          won't be able to sign in with it, or change your Minecraft account, until you link one again.</p>
        <label class="auth__label" for="pfRemove">Code</label>
        ${codeField('pfRemove')}
        <p class="auth__err" data-err role="alert" hidden></p>
        <div class="prof__actions">
          <button class="btn prof__btn prof__btn--danger" type="submit" data-act="remove" disabled>Remove email</button>
          <button class="btn prof__btn prof__btn--quiet" type="button" data-act="cancel">Cancel</button>
        </div>
      </form>`;
    const input = $('#pfRemove', body);
    const remove = body.querySelector('[data-act="remove"]');
    const err = body.querySelector('[data-err]');
    digitsOnly(input);
    input.addEventListener('input', () => { err.hidden = true; remove.disabled = !CODE.test(input.value); });
    body.querySelector('[data-act="cancel"]').addEventListener('click', idle);
    $('.prof__form', body).addEventListener('submit', async (event) => {
      event.preventDefault();
      if (remove.disabled) return;
      try {
        await busy(remove, 'Removing…', () => emailRemove(input.value));
        toast({ kind: 'win', title: 'Email removed', body: 'It can no longer be used to sign in.' });
        refresh();
      } catch (failure) {
        err.textContent = messageOf(failure, 'That code did not work.');
        err.hidden = false;
      }
    });
    input.focus();
  };

  idle();
  return section;
}

/* ═════════════════════════ the Minecraft account ═════════════════════════ */

const ARROW_ICON = '<svg class="mcswap__arrow" viewBox="0 0 256 256" aria-hidden="true"><path d="M224.49,136.49l-72,72a12,12,0,0,1-17-17L187,140H40a12,12,0,0,1,0-24H187L135.51,64.48a12,12,0,0,1,17-17l72,72A12,12,0,0,1,224.49,136.49Z"/></svg>';
const DONE_ICON = '<svg viewBox="0 0 256 256" aria-hidden="true"><path d="M176.49,95.51a12,12,0,0,1,0,17l-56,56a12,12,0,0,1-17,0l-24-24a12,12,0,1,1,17-17L112,143l47.51-47.52A12,12,0,0,1,176.49,95.51ZM236,128A108,108,0,1,1,128,20,108.12,108.12,0,0,1,236,128Zm-24,0a84,84,0,1,0-84,84A84.09,84.09,0,0,0,212,128Z"/></svg>';
const PERSON_ICON = '<svg class="auth__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';

/**
 * The Minecraft card: the linked account, head and name, and one button that changes it. The change
 * itself happens in its own window (openRelink), never in a form squeezed into the card.
 */
export function minecraftCard(info, refresh, avatarUrl) {
  const { section, body } = card('Minecraft account', CUBE_ICON);
  const changed = info.minecraftRelinkedAt ? ` · changed ${dateOf(info.minecraftRelinkedAt)}` : '';
  const paused = info.enabled && !info.available;
  const hint = !info.email ? 'Link an email first to be able to change it.' : paused ? PAUSED : '';
  body.innerHTML = `
    <div class="mcacct">
      <img class="mcacct__head" alt="" width="48" height="48">
      <div class="mcacct__who">
        <b class="mcacct__name"></b>
        <span class="mcacct__sub"></span>
      </div>
      <button class="btn prof__btn" type="button" data-act="change" ${info.canChangeMinecraft && !paused ? '' : 'disabled'}>Change account</button>
    </div>
    <p class="prof__note">Deposits are credited from this account and withdrawals are paid to it.</p>
    ${hint ? '<p class="prof__note prof__note--hint"></p>' : ''}`;
  $('.mcacct__name', body).textContent = info.minecraftUsername;
  $('.mcacct__sub', body).textContent = `Linked account${changed}`;
  if (hint) $('.prof__note--hint', body).textContent = hint;
  const head = $('.mcacct__head', body);
  head.src = avatarUrl;
  head.addEventListener('error', () => { head.hidden = true; });
  body.querySelector('[data-act="change"]').addEventListener('click', () => openRelink(info, refresh, avatarUrl));
  return section;
}

/**
 * Changing the linked Minecraft account, one step to a screen:
 *   1  the new username   2  the code sent to the email   3  the payment from the new account,
 *   exactly as at sign-up   then done.
 * The account in hand and the one it is moving to stay on screen the whole way.
 */
function openRelink(info, refresh, avatarUrl) {
  let newName = '';

  const steps = (step) => `
    <ol class="relink__steps" aria-label="Step ${step} of 3">
      ${[1, 2, 3].map((n) => `<li${n < step ? ' data-done' : ''}${n === step ? ' aria-current="step"' : ''}></li>`).join('')}
    </ol>`;
  const swap = () => `
    <div class="mcswap" aria-hidden="true">
      <span class="mcswap__acct"><img class="mcswap__head" alt="" width="32" height="32"><b data-old></b></span>
      ${ARROW_ICON}
      <span class="mcswap__acct mcswap__acct--new"${newName ? ' data-set' : ''}><span class="mcswap__unknown">?</span><b data-new></b></span>
    </div>`;
  const fillSwap = (body) => {
    const head = $('.mcswap__head', body);
    head.src = avatarUrl;
    head.addEventListener('error', () => { head.hidden = true; });
    $('[data-old]', body).textContent = info.minecraftUsername;
    $('[data-new]', body).textContent = newName || 'New account';
  };

  /* 1 · the new username */
  const nameStep = (body) => {
    body.innerHTML = `
      <h3 class="auth__title" aria-hidden="true">Change Minecraft account</h3>
      ${steps(1)}
      <p class="auth__lede">Move this account to a different Minecraft account. Your balance, VIP level
        and history come with it; withdrawals go to the new account from then on.</p>
      ${swap()}
      <form id="rlNameForm" novalidate>
        <label class="auth__label" for="rlName">New Minecraft username</label>
        <div class="auth__field">
          ${PERSON_ICON}
          <input id="rlName" class="auth__input" type="text" maxlength="16" autocomplete="off"
                 autocapitalize="none" spellcheck="false" placeholder="Enter the new username…">
        </div>
        <p class="auth__note">On Bedrock? Your name works with or without the dot.</p>
        <p class="auth__err" id="rlErr" role="alert" hidden></p>
        <div class="auth__foot"><button class="btn btn--go auth__go" type="submit" id="rlGo" disabled>Continue</button></div>
      </form>`;
    fillSwap(body);
    const input = $('#rlName', body);
    const go = $('#rlGo', body);
    const error = $('#rlErr', body);
    input.value = newName;
    const sync = () => {
      error.hidden = true;
      const name = input.value.trim();
      go.disabled = !MINECRAFT_NAME.test(name) || name.toLowerCase() === String(info.minecraftUsername).toLowerCase();
      $('[data-new]', body).textContent = name || 'New account';
      $('.mcswap__acct--new', body).toggleAttribute('data-set', MINECRAFT_NAME.test(name));
    };
    input.addEventListener('input', sync);
    sync();
    $('#rlNameForm', body).addEventListener('submit', async (event) => {
      event.preventDefault();
      if (go.disabled) return;
      newName = input.value.trim();
      try {
        const sent = await busy(go, 'Sending code…', () => emailConfirmCode('change_minecraft'));
        codeStep(body, sent.email);
      } catch (failure) {
        error.textContent = messageOf(failure, 'The code could not be sent.');
        error.hidden = false;
      }
    });
    input.focus();
  };

  /* 2 · the code from the email */
  const codeStep = (body, masked) => {
    body.innerHTML = `
      <h3 class="auth__title" aria-hidden="true">Confirm it's you</h3>
      ${steps(2)}
      <p class="auth__lede">We sent a 6-digit code to <b class="relink__mail"></b>. It works for 10 minutes.</p>
      ${swap()}
      <form id="rlCodeForm" novalidate>
        <label class="auth__label" for="rlCode">Code</label>
        ${codeField('rlCode')}
        <p class="auth__err" id="rlErr" role="alert" hidden></p>
        <div class="auth__foot auth__foot--pair">
          <button class="btn btn--go auth__go" type="submit" id="rlGo" disabled>Continue</button>
          <button class="btn auth__ghost" type="button" id="rlResend">Send again</button>
        </div>
        <button class="auth__link" type="button" id="rlBack">Change the username</button>
      </form>`;
    fillSwap(body);
    $('.relink__mail', body).textContent = masked;
    const input = $('#rlCode', body);
    const go = $('#rlGo', body);
    const error = $('#rlErr', body);
    const fail = (failure, fallback) => { error.textContent = messageOf(failure, fallback); error.hidden = false; };
    digitsOnly(input);
    input.addEventListener('input', () => { error.hidden = true; go.disabled = !CODE.test(input.value); });
    armResend($('#rlResend', body), async () => {
      try { await emailConfirmCode('change_minecraft'); } catch (failure) { fail(failure, 'The code could not be sent.'); throw failure; }
    });
    $('#rlBack', body).addEventListener('click', () => nameStep(body));
    $('#rlCodeForm', body).addEventListener('submit', async (event) => {
      event.preventDefault();
      if (go.disabled) return;
      try {
        const challenge = await busy(go, 'Checking…', () => relinkStart(newName, input.value));
        payStep(body, challenge);
      } catch (failure) {
        fail(failure, 'That did not go through.');
      }
    });
    input.focus();
  };

  /* 3 · the payment from the new account, then the move */
  const payStep = (body, challenge) => {
    body.innerHTML = `
      <h3 class="auth__title" aria-hidden="true">Pay from the new account</h3>
      ${steps(3)}
      <p class="auth__lede">Log in to DonutSMP as <b class="relink__new"></b> and run this exact command. The
        amount is what identifies the account, and it's added to your balance.</p>
      <div class="auth__field auth__field--static"><span class="auth__value auth__value--lg mono" id="rlCommand"></span></div>
      <button class="btn btn--go auth__go" type="button" id="rlCopy">Copy command</button>
      <div class="relink__status" id="rlStatus" data-state="waiting" role="status">
        <i aria-hidden="true"></i><span>Waiting for your payment…</span>
      </div>
      <p class="auth__err" id="rlErr" role="alert" hidden></p>
      <button class="auth__link" type="button" id="rlAgain" hidden>Start again</button>`;
    $('.relink__new', body).textContent = newName;
    $('#rlCommand', body).textContent = challenge.instruction;
    const status = $('#rlStatus', body);
    const error = $('#rlErr', body);
    const say = (state, text) => { status.dataset.state = state; $('span', status).textContent = text; };
    $('#rlAgain', body).addEventListener('click', () => nameStep(body));
    $('#rlCopy', body).addEventListener('click', async (event) => {
      const button = event.currentTarget;
      try { await navigator.clipboard.writeText(challenge.instruction); button.textContent = 'Copied'; } catch { button.textContent = 'Select it above'; }
      setTimeout(() => { if (button.isConnected) button.textContent = 'Copy command'; }, 1800);
    });

    const finish = async () => {
      say('moving', 'Payment received. Moving your account…');
      try {
        const result = await relinkComplete(challenge.challengeId);
        refresh();
        doneStep(body, result.user.minecraftUsername);
      } catch (failure) {
        say('stopped', 'Payment received');
        error.textContent = messageOf(failure, 'The account could not be moved.');
        error.hidden = false;
      }
    };
    const poll = async () => {
      // Closing the window stops the wait; the payment, if it comes, stays redeemable.
      if (!status.isConnected) return;
      try {
        const result = await loginStatus(challenge.challengeId);
        if (result.state === 'confirmed') { void finish(); return; }
        if (result.state === 'completed') { refresh(); doneStep(body, newName); return; }
        if (result.state === 'expired') {
          say('stopped', 'The ten minutes ran out');
          error.textContent = 'No payment arrived in time. Start again to get a new amount.';
          error.hidden = false;
          $('#rlAgain', body).hidden = false;
          return;
        }
      } catch (failure) {
        if (failure?.code === 'MINECRAFT_ACCOUNT_NOT_FOUND') {
          say('stopped', 'Account not found');
          error.textContent = failure.message;
          error.hidden = false;
          $('#rlAgain', body).hidden = false;
          return;
        }
      }
      setTimeout(poll, 2500);
    };
    setTimeout(poll, 2500);
  };

  /* done */
  const doneStep = (body, name) => {
    body.innerHTML = `
      <div class="relink__done">${DONE_ICON}</div>
      <h3 class="auth__title relink__center">All set</h3>
      <p class="auth__lede relink__center">Your account is now linked to <b class="relink__new"></b>. Deposits
        from it are credited to you and withdrawals are paid to it.</p>
      <div class="auth__foot"><button class="btn btn--go auth__go" type="button" id="rlDone">Done</button></div>`;
    $('.relink__new', body).textContent = name;
    $('#rlDone', body).addEventListener('click', closeModal);
    $('#rlDone', body).focus();
  };

  openModal('Change Minecraft account', nameStep, { variant: 'auth' });
}

/** The profile's email data, or a disabled stand-in when the server cannot be asked. */
export async function loadEmailInfo() {
  try {
    return await accountEmail();
  } catch {
    return null;
  }
}
