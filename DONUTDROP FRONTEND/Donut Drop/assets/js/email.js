/* email.js — an email on the account (2026-11-10).
 *
 *   offerEmailLink     the sign-in card's last step after a FIRST sign-up: link an email, or skip
 *   renderEmailSignIn  "Log in with email" on the sign-in card: a code instead of paying the bot
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
  emailConfig,
  emailConfirmCode,
  emailLinkStart,
  emailLinkVerify,
  emailLoginComplete,
  emailLoginStart,
  emailRemove,
  loginStatus,
  relinkComplete,
  relinkStart,
  turnstileConfig,
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

/**
 * After a first sign-up: an optional email, before the card closes. Skipping is one click and the
 * profile offers it again any time.
 */
export async function offerEmailLink(body, { username, onDone }) {
  let config;
  try {
    config = await emailConfig();
  } catch {
    config = null;
  }
  if (!config?.enabled || !config.available || !body.isConnected) {
    onDone();
    return;
  }
  body.innerHTML = `
    <h3 class="auth__title">You're in, ${escapeText(username)}</h3>
    <p class="auth__lede">Link an email to your account? You can then sign in with a code instead of
      paying the bot, and move your account to another Minecraft account if you ever need to.</p>
    <form id="elForm" novalidate>
      <label class="auth__label" for="elEmail">Email</label>
      ${emailField('elEmail')}
      <p class="auth__err" id="elError" role="alert" hidden></p>
      <div class="auth__foot auth__foot--pair">
        <button class="btn btn--go auth__go" type="submit" id="elSend" disabled>Send code</button>
        <button class="btn auth__ghost" type="button" id="elSkip">Skip for now</button>
      </div>
      <p class="auth__note">Optional. You can link one later in your profile.</p>
    </form>`;
  const input = $('#elEmail', body);
  const send = $('#elSend', body);
  const error = $('#elError', body);
  const setError = (text) => { error.textContent = text; error.hidden = !text; };
  input.addEventListener('input', () => { setError(''); send.disabled = !EMAIL.test(input.value.trim()); });
  $('#elSkip', body).addEventListener('click', onDone);
  $('#elForm', body).addEventListener('submit', async (event) => {
    event.preventDefault();
    if (send.disabled) return;
    const email = input.value.trim();
    try {
      const sent = await busy(send, 'Sending…', () => emailLinkStart(email));
      verifyStep(body, { masked: sent.email, onDone, onBack: () => offerEmailLink(body, { username, onDone }), resend: () => emailLinkStart(email) });
    } catch (failure) {
      setError(messageOf(failure, 'The code could not be sent.'));
    }
  });
  input.focus();
}

/* The code that links an address. */
function verifyStep(body, { masked, onDone, onBack, resend }) {
  body.innerHTML = `
    <h3 class="auth__title">Check your email</h3>
    <p class="auth__lede">We sent a 6-digit code to <b>${escapeText(masked)}</b>. It works for 10 minutes.</p>
    <form id="evForm" novalidate>
      <label class="auth__label" for="evCode">Code</label>
      ${codeField('evCode')}
      <p class="auth__err" id="evError" role="alert" hidden></p>
      <div class="auth__foot auth__foot--pair">
        <button class="btn btn--go auth__go" type="submit" id="evGo" disabled>Link email</button>
        <button class="btn auth__ghost" type="button" id="evResend">Send again</button>
      </div>
      <button class="auth__link" type="button" id="evBack">Use a different email</button>
    </form>`;
  const input = $('#evCode', body);
  const go = $('#evGo', body);
  const error = $('#evError', body);
  const setError = (text) => { error.textContent = text; error.hidden = !text; };
  digitsOnly(input);
  input.addEventListener('input', () => { setError(''); go.disabled = !CODE.test(input.value); });
  armResend($('#evResend', body), async () => {
    try { await resend(); } catch (failure) { setError(messageOf(failure, 'The code could not be sent.')); throw failure; }
  });
  $('#evBack', body).addEventListener('click', onBack);
  $('#evForm', body).addEventListener('submit', async (event) => {
    event.preventDefault();
    if (go.disabled) return;
    try {
      const linked = await busy(go, 'Linking…', () => emailLinkVerify(input.value));
      toast({ kind: 'win', title: 'Email linked', body: linked.email });
      onDone(linked);
    } catch (failure) {
      setError(messageOf(failure, 'That code did not work.'));
    }
  });
  input.focus();
}

/**
 * "Log in with email" on the sign-in card. Turnstile, when the site uses it, guards sending the
 * code exactly as it guards the pay-login (`loadTurnstile` is the sign-in card's own loader).
 */
export function renderEmailSignIn(body, { loadTurnstile, onBack, onDone }) {
  body.innerHTML = `
    <h3 class="auth__title">Log in with email</h3>
    <p class="auth__lede">Enter the email linked to your account and we'll send you a 6-digit code.</p>
    <form id="eiForm" novalidate>
      <label class="auth__label" for="eiEmail">Email</label>
      ${emailField('eiEmail')}
      <p class="auth__err" id="eiError" role="alert" hidden></p>
      <div class="auth__challenge" id="eiChallenge" hidden></div>
      <div class="auth__foot">
        <button class="btn btn--go auth__go" type="submit" id="eiSend" disabled>Send code</button>
      </div>
      <button class="auth__link" type="button" id="eiBack">Log in with Minecraft instead</button>
    </form>`;
  const input = $('#eiEmail', body);
  const send = $('#eiSend', body);
  const error = $('#eiError', body);
  const slot = $('#eiChallenge', body);
  const setError = (text) => { error.textContent = text; error.hidden = !text; };
  let needChallenge = false;
  let token = '';
  let widget;
  const sync = () => { send.disabled = !(EMAIL.test(input.value.trim()) && (!needChallenge || token)); };
  input.addEventListener('input', () => { setError(''); sync(); });
  $('#eiBack', body).addEventListener('click', onBack);

  void (async () => {
    try {
      const settings = await turnstileConfig();
      if (!settings?.enabled || !settings.siteKey || !slot.isConnected) return;
      needChallenge = true;
      sync();
      const turnstile = await loadTurnstile();
      slot.hidden = false;
      widget = turnstile.render(slot, {
        sitekey: settings.siteKey,
        theme: 'dark',
        callback: (value) => { token = value; sync(); },
        'expired-callback': () => { token = ''; sync(); },
        'error-callback': () => { token = ''; sync(); },
      });
    } catch {
      /* Submitting says what is wrong if the server wanted a challenge it did not get. */
    }
  })();

  $('#eiForm', body).addEventListener('submit', async (event) => {
    event.preventDefault();
    if (send.disabled) return;
    const email = input.value.trim();
    try {
      const sent = await busy(send, 'Sending…', () => emailLoginStart(email, token || undefined));
      codeSignInStep(body, { email, masked: sent.email, onBack: () => renderEmailSignIn(body, { loadTurnstile, onBack, onDone }), onDone });
    } catch (failure) {
      setError(messageOf(failure, 'The code could not be sent.'));
      token = '';
      if (widget !== undefined) { try { window.turnstile?.reset(widget); } catch { /* stays disabled */ } }
      sync();
    }
  });
  input.focus();
}

function codeSignInStep(body, { email, masked, onBack, onDone }) {
  body.innerHTML = `
    <h3 class="auth__title">Check your email</h3>
    <p class="auth__lede">If <b>${escapeText(masked)}</b> is linked to an account, a 6-digit code is on
      its way. It works for 10 minutes.</p>
    <form id="ecForm" novalidate>
      <label class="auth__label" for="ecCode">Code</label>
      ${codeField('ecCode')}
      <p class="auth__err" id="ecError" role="alert" hidden></p>
      <div class="auth__foot">
        <button class="btn btn--go auth__go" type="submit" id="ecGo" disabled>Log in</button>
      </div>
      <button class="auth__link" type="button" id="ecBack">Use a different email</button>
    </form>`;
  const input = $('#ecCode', body);
  const go = $('#ecGo', body);
  const error = $('#ecError', body);
  const setError = (text) => { error.textContent = text; error.hidden = !text; };
  digitsOnly(input);
  input.addEventListener('input', () => { setError(''); go.disabled = !CODE.test(input.value); });
  $('#ecBack', body).addEventListener('click', onBack);
  $('#ecForm', body).addEventListener('submit', async (event) => {
    event.preventDefault();
    if (go.disabled) return;
    try {
      const user = await busy(go, 'Logging in…', () => emailLoginComplete(email, input.value));
      onDone(user);
    } catch (failure) {
      setError(messageOf(failure, 'That code did not work.'));
    }
  });
  input.focus();
}

/** Whether to offer "Log in with email" at all: on, and today's allowance not spent. */
export async function emailSignInOffered() {
  try {
    const config = await emailConfig();
    return Boolean(config?.enabled && config.available);
  } catch {
    return false;
  }
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
