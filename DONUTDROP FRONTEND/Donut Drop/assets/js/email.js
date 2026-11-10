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
import { toast } from './ui.js';

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
  <div class="auth__field">
    <input id="${id}" class="auth__input auth__input--code mono" type="text" inputmode="numeric"
           autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" placeholder="123456" spellcheck="false">
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

const MAIL_ICON = '<svg viewBox="0 0 256 256"><path d="M224,48H32a8,8,0,0,0-8,8V192a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A8,8,0,0,0,224,48ZM203.43,64,128,133.15,52.57,64ZM216,192H40V74.19l82.59,75.71a8,8,0,0,0,10.82,0L216,74.19V192Z"/></svg>';
const CUBE_ICON = '<svg viewBox="0 0 256 256"><path d="M223.68,66.15,135.68,18a15.88,15.88,0,0,0-15.36,0l-88,48.17a16,16,0,0,0-8.32,14v95.64a16,16,0,0,0,8.32,14l88,48.17a15.88,15.88,0,0,0,15.36,0l88-48.17a16,16,0,0,0,8.32-14V80.18A16,16,0,0,0,223.68,66.15ZM128,32l80.34,44-29.77,16.3-80.35-44ZM128,120,47.66,76l33.9-18.56,80.34,44ZM40,90l80,43.78v85.79L40,175.82Zm96,129.57V133.82L216,90v85.78Z"/></svg>';

const dateOf = (value) => (value ? new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');

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

/** The Minecraft account card: the linked name, and moving the account to another one. */
export function minecraftCard(info, refresh, avatarUrl) {
  const { section, body } = card('Minecraft account', CUBE_ICON);

  const idle = () => {
    const changed = info.minecraftRelinkedAt ? `Changed ${escapeText(dateOf(info.minecraftRelinkedAt))}.` : '';
    const paused = info.enabled && !info.available;
    body.innerHTML = `
      <div class="prof__value prof__value--player">
        <img class="prof__head" alt="" width="40" height="40">
        <b class="prof__strong"></b>
      </div>
      <p class="prof__note">Deposits are credited from this account and withdrawals are paid to it. ${changed}</p>
      ${!info.email ? '<p class="prof__note">Link an email to be able to move your account to a different Minecraft account.</p>' : ''}
      ${info.email && paused ? `<p class="prof__note">${PAUSED}</p>` : ''}
      <div class="prof__actions">
        <button class="btn prof__btn" type="button" data-act="change" ${info.canChangeMinecraft && !paused ? '' : 'disabled'}>Change Minecraft account</button>
      </div>`;
    $('.prof__strong', body).textContent = info.minecraftUsername;
    const head = $('.prof__head', body);
    head.src = avatarUrl;
    head.addEventListener('error', () => { head.hidden = true; });
    body.querySelector('[data-act="change"]').addEventListener('click', explain);
  };

  const explain = () => {
    body.innerHTML = `
      <p class="prof__p">Your balance, VIP level and history stay with your account. Withdrawals go to the
        new Minecraft account from then on, and deposits are credited from it.</p>
      <ol class="prof__steps">
        <li>We send a code to <b>${escapeText(info.email)}</b>.</li>
        <li>You enter it with the new Minecraft username.</li>
        <li>You pay the bot a small exact amount from the new account, as at sign-up. It's added to your balance.</li>
      </ol>
      <p class="auth__err" data-err role="alert" hidden></p>
      <div class="prof__actions">
        <button class="btn btn--go prof__btn" type="button" data-act="send">Send code</button>
        <button class="btn prof__btn prof__btn--quiet" type="button" data-act="cancel">Cancel</button>
      </div>`;
    const err = body.querySelector('[data-err]');
    body.querySelector('[data-act="cancel"]').addEventListener('click', idle);
    body.querySelector('[data-act="send"]').addEventListener('click', async (event) => {
      try {
        await busy(event.currentTarget, 'Sending…', () => emailConfirmCode('change_minecraft'));
        details();
      } catch (failure) {
        err.textContent = messageOf(failure, 'The code could not be sent.');
        err.hidden = false;
      }
    });
  };

  const details = () => {
    body.innerHTML = `
      <form class="prof__form" novalidate>
        <label class="auth__label" for="mcCode">Code sent to ${escapeText(info.email)}</label>
        ${codeField('mcCode')}
        <label class="auth__label" for="mcName">New Minecraft username</label>
        <div class="auth__field">
          <input id="mcName" class="auth__input" type="text" maxlength="16" autocapitalize="none" spellcheck="false" placeholder="Enter the new username…">
        </div>
        <p class="auth__note">On Bedrock? Your name works with or without the dot.</p>
        <p class="auth__err" data-err role="alert" hidden></p>
        <div class="prof__actions">
          <button class="btn btn--go prof__btn" type="submit" data-act="go" disabled>Continue</button>
          <button class="btn prof__btn prof__btn--quiet" type="button" data-act="cancel">Cancel</button>
        </div>
      </form>`;
    const code = $('#mcCode', body);
    const name = $('#mcName', body);
    const go = body.querySelector('[data-act="go"]');
    const err = body.querySelector('[data-err]');
    digitsOnly(code);
    const sync = () => { err.hidden = true; go.disabled = !(CODE.test(code.value) && MINECRAFT_NAME.test(name.value.trim())); };
    code.addEventListener('input', sync);
    name.addEventListener('input', sync);
    body.querySelector('[data-act="cancel"]').addEventListener('click', idle);
    $('.prof__form', body).addEventListener('submit', async (event) => {
      event.preventDefault();
      if (go.disabled) return;
      try {
        const challenge = await busy(go, 'Checking…', () => relinkStart(name.value.trim(), code.value));
        pay(challenge, name.value.trim());
      } catch (failure) {
        err.textContent = messageOf(failure, 'That did not go through.');
        err.hidden = false;
      }
    });
    code.focus();
  };

  /* The payment, then the move: the same command and the same wait as signing up. */
  const pay = (challenge, newName) => {
    body.innerHTML = `
      <p class="prof__p">Log in to DonutSMP as <b>${escapeText(newName)}</b> and run this exact command:</p>
      <div class="auth__field auth__field--static"><span class="auth__value auth__value--lg mono"></span></div>
      <div class="prof__actions"><button class="btn btn--go prof__btn" type="button" data-act="copy">Copy command</button></div>
      <p class="auth__note">Pay exactly $${escapeText(String(challenge.payAmount))}: the amount is what identifies you. It's added to your balance.</p>
      <div class="kv"><span>status</span><span data-state>waiting for your payment</span></div>
      <p class="auth__err" data-err role="alert" hidden></p>
      <div class="prof__actions"><button class="btn prof__btn prof__btn--quiet" type="button" data-act="cancel">Cancel</button></div>`;
    $('.auth__value', body).textContent = challenge.instruction;
    const status = body.querySelector('[data-state]');
    const err = body.querySelector('[data-err]');
    let stopped = false;
    body.querySelector('[data-act="cancel"]').addEventListener('click', () => { stopped = true; idle(); });
    body.querySelector('[data-act="copy"]').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      try { await navigator.clipboard.writeText(challenge.instruction); button.textContent = 'Copied'; } catch { button.textContent = 'Select it above'; }
      setTimeout(() => { if (button.isConnected) button.textContent = 'Copy command'; }, 1800);
    });

    const finish = async () => {
      status.textContent = 'payment received, moving your account';
      try {
        const result = await relinkComplete(challenge.challengeId);
        toast({ kind: 'win', title: 'Minecraft account changed', body: `Now linked to ${result.user.minecraftUsername}` });
        refresh();
      } catch (failure) {
        status.textContent = 'payment received';
        err.textContent = messageOf(failure, 'The account could not be moved.');
        err.hidden = false;
      }
    };
    const poll = async () => {
      if (stopped || !body.isConnected) return;
      try {
        const result = await loginStatus(challenge.challengeId);
        if (result.state === 'confirmed') { void finish(); return; }
        if (result.state === 'completed') { refresh(); return; }
        if (result.state === 'expired') {
          status.textContent = 'expired';
          err.textContent = 'The ten minutes ran out before a payment arrived. Start again.';
          err.hidden = false;
          return;
        }
      } catch (failure) {
        /* A name that resolves to no Minecraft account stops here; anything else is retried. */
        if (failure?.code === 'MINECRAFT_ACCOUNT_NOT_FOUND') {
          err.textContent = failure.message;
          err.hidden = false;
          return;
        }
      }
      setTimeout(poll, 2500);
    };
    setTimeout(poll, 2500);
  };

  idle();
  return section;
}

/** The profile's email data, or a disabled stand-in when the server cannot be asked. */
export async function loadEmailInfo() {
  try {
    return await accountEmail();
  } catch {
    return null;
  }
}
