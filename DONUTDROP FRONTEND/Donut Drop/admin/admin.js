/*
 * admin.js — the admin console.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE FIRST THING THIS FILE DOES IS SPEND A CREDENTIAL
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The one-time token arrives in `location.hash`. That placement is the whole reason the link
 * survives being posted into Discord: a fragment is never sent in an HTTP request, so Discord's
 * unfurler fetches `/admin/` and gets an ordinary page rather than spending the token building a
 * preview. It also keeps the token out of server access logs, proxy logs and the `Referer` header.
 *
 * It is cleared from the address bar the moment it is read — before the network call, not after —
 * so a screenshot, a shoulder, or a browser sync of the URL bar never carries it. The token is
 * dead after one POST regardless, but the window where it is visible should still be as close to
 * zero as it can be made.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * NOTHING HERE IS AN AUTHORISATION DECISION
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * This page renders what the API returns and disables what the API refuses. It does not check
 * whether you are an admin, because a check in a script the browser downloaded is a suggestion.
 * Every request carries the session cookie and the CSRF header and is judged on the server.
 */

const API_BASE = (
  document.querySelector('meta[name="api-base-url"]')?.content?.trim() ||
  (/^https?:$/.test(window.location.protocol) ? window.location.origin : 'http://localhost:3001')
).replace(/\/$/, '');

const $ = (id) => document.getElementById(id);

/* ═════════════════════════ transport ═════════════════════════ */

let csrf = '';

function cookie(name) {
  const prefix = `${name}=`;
  const found = document.cookie
    .split(';')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(prefix));
  return found ? decodeURIComponent(found.slice(prefix.length)) : '';
}

function csrfToken() {
  return csrf || cookie('__Host-du_csrf') || cookie('du_csrf');
}

class ApiError extends Error {
  constructor(status, code, message) {
    super(message || 'Request failed');
    this.status = status;
    this.code = code || 'REQUEST_FAILED';
  }
}

async function request(method, path, body, options = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  /* Minted per call, not per attempt: the point is that the SAME key rides a retry, so a request
     the server already accepted cannot land twice. */
  if (options.idempotency) headers['Idempotency-Key'] = crypto.randomUUID();
  if (!['GET', 'HEAD'].includes(method)) {
    const token = csrfToken();
    if (token) headers['X-CSRF-Token'] = token;
  }
  let response;
  try {
    response = await fetch(API_BASE + path, {
      method,
      headers,
      // The session is a cookie; without this the console is permanently signed out.
      credentials: 'include',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server');
  }
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const problem = payload.error || {};
    throw new ApiError(response.status, problem.code, problem.message);
  }
  return payload;
}

const api = {
  get: (path) => request('GET', path),
  post: (path, body, options) => request('POST', path, body, options),
  patch: (path, body) => request('PATCH', path, body),
};

/* ═════════════════════════ chrome ═════════════════════════ */

function toast(message, tone = 'ok') {
  const node = document.createElement('div');
  node.className = 'toast';
  node.dataset.tone = tone;
  node.textContent = message;
  $('toasts').append(node);
  window.setTimeout(() => node.remove(), 6000);
}

function gate(title, body, { error = false, hint = false } = {}) {
  $('gateTitle').textContent = title;
  $('gateBody').textContent = body;
  $('gate').dataset.state = error ? 'error' : 'busy';
  $('gateHint').hidden = !hint;
}

/** Everything that reaches the DOM goes through a text node. No interpolation into markup. */
function cell(value, { mono = false } = {}) {
  const td = document.createElement('td');
  if (mono) td.className = 'mono';
  td.textContent =
    value === null || value === undefined || value === ''
      ? '—'
      : typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)
        ? new Date(value).toLocaleString()
        : String(value);
  return td;
}

function pill(text, tone) {
  const span = document.createElement('span');
  span.className = 'pill';
  if (tone) span.dataset.tone = tone;
  span.textContent = text ?? '—';
  return span;
}

function table(node, columns, rows, renderRow) {
  node.replaceChildren();
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const column of columns) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = column;
    headRow.append(th);
  }
  head.append(headRow);
  const body = document.createElement('tbody');
  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.className = 'empty';
    td.colSpan = columns.length;
    td.textContent = 'Nothing to show.';
    tr.append(td);
    body.append(tr);
  } else {
    for (const row of rows) body.append(renderRow(row));
  }
  node.append(head, body);
}

/* ═════════════════════════ confirmation ═════════════════════════ */

/**
 * Asks before anything destructive, and makes the operator type a reason.
 *
 * The reason is not ceremony: it is a required field on the audit entry, so an action taken at
 * 3am is explainable at 9am by somebody who was not there. Resolving with `null` means cancelled.
 */
function confirmAction(message) {
  return new Promise((resolve) => {
    const dialog = $('confirm');
    const reason = $('confirmReason');
    $('confirmBody').textContent = message;
    $('confirmMoney').hidden = true;
    reason.value = '';
    const done = () => {
      dialog.removeEventListener('close', done);
      resolve(
        dialog.returnValue === 'go' && reason.value.trim().length >= 3 ? reason.value.trim() : null,
      );
    };
    dialog.addEventListener('close', done);
    dialog.showModal();
  });
}

/* ═════════════════════════ money ═════════════════════════ */

/**
 * Reads an operator's amount.
 *
 * `250k` and `250000` both mean the same thing, because these balances run to ten figures and
 * demanding every zero is how one gets typed twice. Returns a BigInt, or null for anything it
 * cannot read — never 0, because a field that silently becomes zero when you fat-finger it is how
 * somebody credits nothing and believes they credited a fortune.
 *
 * BigInt all the way through: these figures pass 2^53, and a Number here would round the amount
 * somebody is about to be paid.
 */
const SUFFIX = { k: 3, m: 6, b: 9, t: 12 };
function parseAmount(input, { signed = false } = {}) {
  const raw = String(input).trim().toLowerCase().replaceAll(',', '').replaceAll('$', '');
  const match = /^(-?)(\d+)(?:\.(\d+))?([kmbt]?)$/.exec(raw);
  if (!match) return null;
  const [, sign, whole, fraction = '', suffix] = match;
  if (sign && !signed) return null;
  const zeros = suffix ? SUFFIX[suffix] : 0;
  /* Decimal shorthand is resolved by shifting digits, not by multiplying a float: `1.1b` through
   * Number is 1100000000.0000001 on a bad day, and this is somebody's money. */
  if (fraction.length > zeros) return null;
  const digits = whole + fraction + '0'.repeat(zeros - fraction.length);
  const value = BigInt(digits);
  if (value === 0n) return null;
  return sign === '-' ? -value : value;
}

/** Exact and grouped. An operator moving money needs the figure, not an approximation of it. */
function amountText(minor) {
  const value = typeof minor === 'bigint' ? minor : BigInt(minor ?? 0);
  const sign = value < 0n ? '-' : '';
  const digits = (value < 0n ? -value : value).toString();
  return sign + '$' + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * The same dialog, plus an amount.
 *
 * The parsed figure is echoed under the field as it is typed, so the shorthand is never the last
 * word on what is about to move — the operator confirms against the exact number, not against
 * their own mental expansion of `1.2b`. Resolves null on cancel or on anything unreadable.
 */
function confirmAmount(message, { label = 'Amount', signed = false } = {}) {
  return new Promise((resolve) => {
    const dialog = $('confirm');
    const reason = $('confirmReason');
    const amount = $('confirmAmount');
    const echo = $('confirmEcho');
    $('confirmBody').textContent = message;
    $('confirmAmountLabel').textContent = label;
    $('confirmMoney').hidden = false;
    reason.value = '';
    amount.value = '';
    echo.textContent = '';
    echo.dataset.tone = '';

    const preview = () => {
      const parsed = amount.value.trim() ? parseAmount(amount.value, { signed }) : null;
      if (!amount.value.trim()) {
        echo.textContent = '';
        echo.dataset.tone = '';
        return;
      }
      echo.textContent = parsed === null ? 'Not a readable amount' : '= ' + amountText(parsed);
      echo.dataset.tone = parsed === null ? 'bad' : 'ok';
    };
    amount.addEventListener('input', preview);

    const done = () => {
      dialog.removeEventListener('close', done);
      amount.removeEventListener('input', preview);
      $('confirmMoney').hidden = true;
      const parsed = parseAmount(amount.value, { signed });
      const why = reason.value.trim();
      resolve(
        dialog.returnValue === 'go' && why.length >= 3 && parsed !== null
          ? { amountMinor: parsed.toString(), reason: why }
          : null,
      );
    };
    dialog.addEventListener('close', done);
    dialog.showModal();
  });
}

/* ═════════════════════════ panels ═════════════════════════ */

async function loadOverview() {
  const [users, bots, jobs] = await Promise.all([
    api.get('/v1/admin/users?limit=50'),
    api.get('/v1/admin/bots'),
    api.get('/v1/admin/jobs'),
  ]);
  const botRows = bots.bots ?? [];
  const jobRows = jobs.jobs ?? [];
  const quarantined = botRows.filter((bot) => bot.status === 'quarantined').length;
  const deadLetter = jobRows.filter((job) => job.status === 'dead_letter').length;

  const tiles = [
    /* The users endpoint pages and reports no grand total, so this counts what a page returned
       rather than inventing a number. Labelled "recent" so it is not misread as the player base. */
    ['Recent players', (users.users ?? []).length, false],
    ['Bots', botRows.length, false],
    ['Quarantined', quarantined, quarantined > 0],
    [
      'Open jobs',
      jobRows.filter((job) => job.status === 'queued' || job.status === 'leased').length,
      false,
    ],
    ['Dead letter', deadLetter, deadLetter > 0],
  ];
  const host = $('overviewStats');
  host.replaceChildren();
  for (const [label, value, alarm] of tiles) {
    const card = document.createElement('div');
    card.className = 'stat';
    if (alarm) card.dataset.alarm = '1';
    const name = document.createElement('span');
    name.className = 'stat__label';
    name.textContent = label;
    const figure = document.createElement('span');
    figure.className = 'stat__value';
    figure.textContent = String(value ?? 0);
    card.append(name, figure);
    host.append(card);
  }
}

async function loadPlayers(query = '') {
  const search = query ? `&search=${encodeURIComponent(query)}` : '';
  const data = await api.get(`/v1/admin/users?limit=50${search}`);
  table(
    $('playerTable'),
    ['Username', 'Status', 'KYC', 'Role', 'Joined', ''],
    data.users ?? [],
    (user) => {
      const tr = document.createElement('tr');
      tr.append(cell(user.minecraft_username));
      const status = document.createElement('td');
      status.append(pill(user.status, statusTone(user.status)));
      tr.append(status);
      const kyc = document.createElement('td');
      kyc.append(pill(user.kyc_status, user.kyc_status === 'verified' ? 'ok' : 'warn'));
      tr.append(kyc, cell(user.role), cell(user.created_at));

      /* The id column became this button. The raw uuid was taking a third of the row's width to
         say something an operator never reads and cannot act on; the sheet prints it at the top
         for the one case where it is wanted. */
      const actions = document.createElement('td');
      const manage = document.createElement('button');
      manage.type = 'button';
      manage.className = 'btn';
      manage.textContent = 'Manage';
      manage.addEventListener('click', () => void openPlayer(user.id));
      actions.append(manage);
      tr.append(actions);
      return tr;
    },
  );
}

function statusTone(status) {
  if (status === 'active') return 'ok';
  if (status === 'suspended' || status === 'closed') return 'bad';
  return 'warn';
}

/* ═════════════════════════ one player ═════════════════════════ */

/** The account currently open in the sheet, so an action knows what it is acting on. */
let sheetUserId = null;

async function openPlayer(id) {
  sheetUserId = id;
  const data = await api.get(`/v1/admin/users/${encodeURIComponent(id)}`);
  renderPlayer(data);
  const sheet = $('playerSheet');
  if (!sheet.open) sheet.showModal();
}

/** Re-reads the account and repaints, after an action that changed it. */
async function refreshPlayer() {
  if (!sheetUserId) return;
  renderPlayer(await api.get(`/v1/admin/users/${encodeURIComponent(sheetUserId)}`));
}

function renderPlayer(data) {
  const user = data.user;
  $('sheetName').textContent = user.minecraft_username;
  $('sheetId').textContent = user.id;

  /* The facts that decide whether to act, in the order an operator asks them: what can this
     account do, what is it holding, and is anything already restraining it. */
  const facts = [
    ['Status', user.status, statusTone(user.status)],
    ['Role', user.role, user.role === 'admin' ? 'warn' : null],
    ['Balance', amountText(data.balanceMinor), null],
    ['KYC', user.kyc_status, user.kyc_status === 'verified' ? 'ok' : 'warn'],
    ['Age verified', user.age_verified_at ? 'yes' : 'no', user.age_verified_at ? 'ok' : 'warn'],
    ['Sessions', String((data.sessions ?? []).length), null],
    ['Last login', user.last_login_at ? new Date(user.last_login_at).toLocaleString() : 'never', null],
    [
      'Self-excluded',
      data.selfExcludedUntil ? `until ${new Date(data.selfExcludedUntil).toLocaleString()}` : 'no',
      data.selfExcludedUntil ? 'bad' : null,
    ],
  ];
  const host = $('sheetFacts');
  host.replaceChildren();
  for (const [label, value, tone] of facts) {
    const item = document.createElement('div');
    item.className = 'fact';
    const name = document.createElement('span');
    name.className = 'fact__k';
    name.textContent = label;
    const figure = document.createElement('span');
    figure.className = 'fact__v';
    if (tone) {
      figure.append(pill(value, tone));
    } else {
      figure.textContent = value;
    }
    item.append(name, figure);
    host.append(item);
  }

  renderPlayerActions(user, data);

  table(
    $('sheetSessions'),
    ['Started', 'Last seen', 'Expires', 'Agent'],
    data.sessions ?? [],
    (session) => {
      const tr = document.createElement('tr');
      tr.append(
        cell(session.created_at),
        cell(session.last_seen_at),
        cell(session.expires_at),
        cell(session.user_agent),
      );
      return tr;
    },
  );

  table(
    $('sheetLedger'),
    ['When', 'Kind', 'Amount', 'Balance after'],
    data.transactions ?? [],
    (entry) => {
      const tr = document.createElement('tr');
      tr.append(cell(entry.created_at), cell(entry.kind));
      const amount = document.createElement('td');
      amount.className = 'mono';
      amount.dataset.sign = String(entry.amount_minor).startsWith('-') ? 'down' : 'up';
      amount.textContent = amountText(entry.amount_minor);
      tr.append(amount, cell(amountText(entry.balance_after_minor), { mono: true }));
      return tr;
    },
  );
}

function renderPlayerActions(user, data) {
  const host = $('sheetActions');
  host.replaceChildren();

  /** One lever. `run` returns false to mean "the operator cancelled", so nothing is reported. */
  const lever = (text, tone, run) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = tone === 'danger' ? 'btn btn--danger' : 'btn';
    button.textContent = text;
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const acted = await run();
        if (acted !== false) await refreshPlayer();
      } catch (error) {
        toast(`${error.code}: ${error.message}`, 'bad');
      } finally {
        button.disabled = false;
      }
    });
    host.append(button);
    return button;
  };

  const id = encodeURIComponent(user.id);

  if (user.status === 'active') {
    lever('Suspend', 'danger', async () => {
      const reason = await confirmAction(
        `Suspend ${user.minecraft_username}? They cannot wager or sign in, and every live `
          + 'session ends immediately.',
      );
      if (!reason) return false;
      const result = await api.patch(`/v1/admin/users/${id}/status`, {
        status: 'suspended',
        reason,
      });
      toast(`Suspended. ${result.sessionsRevoked} session(s) ended.`, 'ok');
    });
  } else {
    lever('Reactivate', null, async () => {
      const reason = await confirmAction(
        `Return ${user.minecraft_username} to active? They can wager and sign in again.`,
      );
      if (!reason) return false;
      await api.patch(`/v1/admin/users/${id}/status`, { status: 'active', reason });
      toast('Account is active.', 'ok');
    });
  }

  if (user.status !== 'closed') {
    lever('Close account', 'danger', async () => {
      const reason = await confirmAction(
        `Close ${user.minecraft_username}'s account? This is the heaviest state: no wagering, no `
          + 'sign-in, all sessions ended. It can be reversed from here, but treat it as final.',
      );
      if (!reason) return false;
      await api.patch(`/v1/admin/users/${id}/status`, { status: 'closed', reason });
      toast('Account closed.', 'ok');
    });
  }

  lever('Credit balance', null, async () => {
    const answer = await confirmAmount(
      `Add to ${user.minecraft_username}'s site balance. Currently `
        + `${amountText(data.balanceMinor)}. Writes an admin_adjustment to the ledger.`,
      { label: 'Amount to add' },
    );
    if (!answer) return false;
    const result = await api.post(`/v1/admin/users/${id}/balance`, answer);
    toast(`Credited. New balance ${amountText(result.balanceMinor)}.`, 'ok');
  });

  lever('Debit balance', 'danger', async () => {
    const answer = await confirmAmount(
      `Take from ${user.minecraft_username}'s site balance. Currently `
        + `${amountText(data.balanceMinor)}. Refused if it would go below zero.`,
      { label: 'Amount to take' },
    );
    if (!answer) return false;
    /* Sent as a negative. The endpoint takes one signed figure rather than an amount plus a
       direction flag, because a flag is one inverted boolean away from crediting what was meant
       to be clawed back. */
    const result = await api.post(`/v1/admin/users/${id}/balance`, {
      amountMinor: '-' + answer.amountMinor,
      reason: answer.reason,
    });
    toast(`Debited. New balance ${amountText(result.balanceMinor)}.`, 'ok');
  });

  if ((data.sessions ?? []).length) {
    lever('Sign out everywhere', null, async () => {
      const reason = await confirmAction(
        `End all ${data.sessions.length} live session(s) for ${user.minecraft_username}? `
          + 'The account keeps every permission it has — this only ends the sign-ins.',
      );
      if (!reason) return false;
      const result = await api.post(`/v1/admin/users/${id}/sessions/revoke`, { reason });
      toast(`${result.sessionsRevoked} session(s) ended.`, 'ok');
    });
  }

  /* No role lever, because one here cannot work.
   *
   * A button used to write `users.role` and report success. The write never survived: the API
   * re-derives the role from ADMIN_MINECRAFT_IDS on every request and puts the row back, revoking
   * the target's sessions on the way. The grant lasted until their next request and the only thing
   * it achieved was logging them out.
   *
   * So the role is stated, not offered, and the note says where the change actually lives. A
   * disabled button would imply the power exists somewhere in this console; it does not. */
  const note = document.createElement('p');
  note.className = 'sheet__note';
  note.textContent =
    user.role === 'admin'
      ? 'Administrator. Roles come from ADMIN_MINECRAFT_IDS and are not editable here — remove '
        + 'the identity from that variable and restart to revoke.'
      : 'Player. Roles come from ADMIN_MINECRAFT_IDS and are not editable here — an administrator '
        + 'also needs an ADMIN_TOTP_SECRETS entry, and the API will not start without one.';
  host.append(note);
}

async function loadBots() {
  const data = await api.get('/v1/admin/bots');
  table(
    $('botTable'),
    ['Bot', 'Status', 'Reconciliation', 'Transfers', 'Heartbeat', 'Open jobs', ''],
    data.bots ?? [],
    (bot) => {
      const tr = document.createElement('tr');
      tr.append(cell(bot.username));
      const status = document.createElement('td');
      status.append(
        pill(
          bot.status,
          bot.status === 'quarantined' ? 'bad' : bot.status === 'degraded' ? 'warn' : 'ok',
        ),
      );
      tr.append(status);
      const recon = document.createElement('td');
      recon.append(
        pill(bot.reconciliation_status, bot.reconciliation_status === 'matched' ? 'ok' : 'bad'),
      );
      tr.append(recon);
      const transfers = document.createElement('td');
      transfers.append(
        pill(bot.transfer_capable ? 'enabled' : 'disabled', bot.transfer_capable ? 'ok' : 'warn'),
      );
      tr.append(transfers, cell(bot.last_heartbeat_at), cell(bot.open_jobs, { mono: true }));

      const actions = document.createElement('td');
      actions.className = 'rowacts';

      /* Live enough to take an order. The same test the gateway applies before it will queue one,
         so a button that is enabled here is a button the server will honour. Mirroring the rule
         rather than guessing keeps the console from offering an action that always fails — the
         server is still the one that decides. */
      const live =
        bot.status === 'online' &&
        bot.last_heartbeat_at !== null &&
        Date.now() - new Date(bot.last_heartbeat_at).getTime() < 45_000;

      const rejoin = document.createElement('button');
      rejoin.type = 'button';
      rejoin.className = 'btn';
      rejoin.textContent = 'Rejoin';
      rejoin.disabled = !live;
      rejoin.title = live
        ? 'Drop the connection and come straight back'
        : 'The bot has not checked in recently enough to be given an order';
      rejoin.addEventListener('click', async () => {
        const reason = await confirmAction(
          `Tell ${bot.username} to reconnect? It drops its connection and rejoins about ten `
            + 'seconds later. Anything it is part-way through is abandoned.',
        );
        if (!reason) return;
        rejoin.disabled = true;
        try {
          await api.post(`/v1/admin/bots/${bot.id}/reconnect`, { reason });
          toast(`${bot.username} is reconnecting.`, 'ok');
          await loadBots();
        } catch (error) {
          toast(`${error.code}: ${error.message}`, 'bad');
          rejoin.disabled = false;
        }
      });

      const pay = document.createElement('button');
      pay.type = 'button';
      pay.className = 'btn';
      pay.textContent = 'Pay a player';
      pay.disabled = !live;
      pay.title = live
        ? "Send in-game currency from this bot's own balance"
        : 'The bot has not checked in recently enough to pay anybody';
      pay.addEventListener('click', () => void payFromBot(bot));

      actions.append(rejoin, pay);

      const quarantining = bot.status !== 'quarantined';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = quarantining ? 'btn btn--danger' : 'btn';
      button.textContent = quarantining ? 'Quarantine' : 'Release';
      button.addEventListener('click', async () => {
        const reason = await confirmAction(
          `${quarantining ? 'Quarantine' : 'Release'} ${bot.username}? ` +
            (quarantining
              ? 'Queued jobs move to dead letter and affected withdrawals go to manual review.'
              : 'Release requires a fresh matching snapshot and heartbeat.'),
        );
        if (!reason) return;
        button.disabled = true;
        try {
          await api.patch(`/v1/admin/bots/${bot.id}/quarantine`, {
            quarantined: quarantining,
            reason,
          });
          toast(`${bot.username} ${quarantining ? 'quarantined' : 'released'}`, 'ok');
          await loadBots();
        } catch (error) {
          toast(`${error.code}: ${error.message}`, 'bad');
          button.disabled = false;
        }
      });
      actions.append(button);
      tr.append(actions);
      return tr;
    },
  );
}

/**
 * Pays a Minecraft player from a bot's own in-game balance.
 *
 * Two prompts on purpose. The payee is asked for first, as plain text, because it is the field a
 * mistake is unrecoverable in: money sent to a mistyped name on DonutSMP is money gone, and there
 * is no site record to reverse. The amount and the reason follow in the dialog that echoes the
 * exact figure back before anything is confirmed.
 */
async function payFromBot(bot) {
  const payee = window.prompt(
    `Pay which player, from ${bot.username}'s in-game balance?\n\n`
      + 'Exact Minecraft name. This sends real in-game currency and cannot be reversed.',
  );
  if (payee === null) return;
  const name = payee.trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) {
    toast('That is not a Minecraft username.', 'bad');
    return;
  }
  const answer = await confirmAmount(
    `Pay ${name} from ${bot.username}'s own in-game balance. This does not touch anybody's site `
      + 'wallet and there is nothing to refund if it fails.',
    { label: `Amount to send ${name}` },
  );
  if (!answer) return;
  try {
    const result = await api.post(
      `/v1/admin/bots/${bot.id}/pay`,
      { payee: name, ...answer },
      /* An idempotency key, so a double-click or a retried request cannot pay twice. */
      { idempotency: true },
    );
    toast(`Queued: ${amountText(answer.amountMinor)} to ${name} via ${result.bot}.`, 'ok');
    await loadBots();
  } catch (error) {
    toast(`${error.code}: ${error.message}`, 'bad');
  }
}

async function loadPayouts() {
  const data = await api.get('/v1/admin/payouts');
  table(
    $('payoutTable'),
    ['When', 'Payee', 'Amount', 'Status', 'Bot', 'Ordered by', 'Reason'],
    data.payouts ?? [],
    (payout) => {
      const tr = document.createElement('tr');
      tr.append(cell(payout.created_at), cell(payout.payee_username));
      tr.append(cell(amountText(payout.amount_minor), { mono: true }));
      const status = document.createElement('td');
      status.append(
        pill(
          payout.status === 'failed' && payout.error_code
            ? `${payout.status} · ${payout.error_code}`
            : payout.status,
          payout.status === 'paid'
            ? 'ok'
            : payout.status === 'failed' || payout.status === 'manual_review'
              ? 'bad'
              : 'warn',
        ),
      );
      tr.append(status, cell(payout.bot_username), cell(payout.actor_username));
      const reason = document.createElement('td');
      reason.className = 'wrap';
      reason.textContent = payout.reason ?? '—';
      tr.append(reason);
      return tr;
    },
  );
}

async function loadJobs() {
  const data = await api.get('/v1/admin/jobs');
  table(
    $('jobTable'),
    ['Job', 'Type', 'Status', 'Attempts', 'Last error', 'Updated'],
    data.jobs ?? [],
    (job) => {
      const tr = document.createElement('tr');
      tr.append(cell(job.id, { mono: true }), cell(job.kind));
      const status = document.createElement('td');
      status.append(
        pill(
          job.status,
          job.status === 'dead_letter' ? 'bad' : job.status === 'completed' ? 'ok' : 'warn',
        ),
      );
      tr.append(
        status,
        cell(job.attempts, { mono: true }),
        cell(job.last_error_code),
        cell(job.updated_at),
      );
      return tr;
    },
  );
}

async function loadItems() {
  const data = await api.get('/v1/admin/observed-items');
  table(
    $('itemTable'),
    ['Item', 'Minecraft name', 'Quantity', 'In catalog', 'Last seen'],
    data.items ?? [],
    (item) => {
      const tr = document.createElement('tr');
      tr.append(
        cell(item.display_name),
        cell(item.minecraft_name),
        cell(item.last_quantity, { mono: true }),
      );
      const known = document.createElement('td');
      known.append(pill(item.catalog_item_id ? 'yes' : 'no', item.catalog_item_id ? 'ok' : 'warn'));
      tr.append(known, cell(item.last_seen_at));
      return tr;
    },
  );
}

/**
 * Publishes the upgrader's fixed prize ladder: fifty-one denominations from $100K to $10B.
 *
 * The prices are fixed in the server's code and nothing about them is sent from here — this posts
 * a reason and nothing else. A console that could name the figures would be the bulk price-setting
 * tool the catalogue rules exist to prevent, and the reason field is what makes a publish at 3am
 * answerable at 9am.
 *
 * Safe to press twice. Rungs already at the right price are left alone, and a publish that changed
 * nothing writes no audit entry.
 */
async function publishLadder() {
  const reason = await confirmAction(
    'Publish the upgrader prize ladder: 51 fixed denominations from $100K to $10B. '
      + 'Prices already correct are left alone, but every rung is re-enabled — '
      + 'including any you switched off by hand.',
  );
  if (!reason) return;
  const button = $('publishLadder');
  button.disabled = true;
  try {
    const result = await api.post('/v1/admin/catalog-ladder', { reason });
    toast(
      result.created + ' created, ' + result.repriced + ' repriced, '
        + result.unchanged + ' already at the right price.',
    );
    await show('items');
  } catch (error) {
    /* Status and code, not just the message. An ApiError always carries a message — 'Request
     * failed' when the response had no JSON body — so the `||` fallback that used to be here could
     * never fire, and a route that is not deployed yet reported itself as a generic failure with
     * nothing in it to act on. A 404 here means the API container is older than the console. */
    toast(error.status + ' ' + error.code + ': ' + error.message, 'bad');
  } finally {
    button.disabled = false;
  }
}

const LOADERS = {
  overview: loadOverview,
  players: () => loadPlayers($('playerQuery').value.trim()),
  /* The payout log is the receipt for the Pay button above it, so it is never stale relative to
     the table it belongs to. */
  bots: async () => {
    await loadBots();
    await loadPayouts();
  },
  jobs: loadJobs,
  items: loadItems,
};

async function show(name) {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.setAttribute('aria-selected', String(tab.dataset.panel === name));
  }
  for (const panel of document.querySelectorAll('.panel')) {
    panel.hidden = panel.dataset.panel !== name;
  }
  try {
    await LOADERS[name]();
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      signedOut('Your session ended. Mint a new link from Discord.');
      return;
    }
    toast(`${error.code}: ${error.message}`, 'bad');
  }
}

function signedOut(message) {
  $('console').hidden = true;
  $('who').hidden = true;
  $('gate').hidden = false;
  gate('Signed out', message, { error: true, hint: true });
}

/* ═════════════════════════ startup ═════════════════════════ */

/**
 * Turns the fragment into a session, exactly once.
 *
 * The hash is captured and erased before the request is made. `replaceState` is used rather than
 * assigning `location.hash` so no history entry is created — pressing Back must not resurrect a
 * URL that once held a credential.
 */
async function redeemFromFragment() {
  const token = window.location.hash.replace(/^#/, '').trim();
  if (!token) return false;
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  try {
    const session = await api.post('/v1/admin/link/redeem', { token });
    csrf = session.csrfToken || '';
    $('whoName').textContent = session.minecraftUsername || 'admin';
    return true;
  } catch (error) {
    gate(
      'That link did not work',
      error.status === 429
        ? 'Too many attempts. Wait a few minutes, then mint a new link.'
        : 'It has already been used, it expired, or it was never valid.',
      { error: true, hint: true },
    );
    return false;
  }
}

/** With no fragment, an existing cookie may already be a valid admin session. */
async function resumeSession() {
  try {
    const me = await api.get('/v1/auth/me');
    if (me?.role !== 'admin' || me.status !== 'active') {
      gate('Not an administrator', 'This account cannot open the console.', {
        error: true,
        hint: true,
      });
      return false;
    }
    $('whoName').textContent = me.minecraftUsername || 'admin';
    return true;
  } catch {
    gate('No session', 'Open this console from the link Discord gave you.', {
      error: true,
      hint: true,
    });
    return false;
  }
}

async function start() {
  const hadFragment = window.location.hash.length > 1;
  const ready = hadFragment ? await redeemFromFragment() : await resumeSession();
  if (!ready) return;

  $('gate').hidden = true;
  $('console').hidden = false;
  $('who').hidden = false;

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => void show(tab.dataset.panel));
  }
  for (const button of document.querySelectorAll('[data-refresh]')) {
    button.addEventListener('click', () => void show(button.dataset.refresh));
  }
  $('publishLadder').addEventListener('click', () => void publishLadder());
  $('sheetClose').addEventListener('click', () => $('playerSheet').close());
  /* Esc closes it natively; this clears the account it was pointed at so a later refresh cannot
     repaint a sheet nobody is looking at. */
  $('playerSheet').addEventListener('close', () => {
    sheetUserId = null;
  });
  $('playerSearch').addEventListener('submit', (event) => {
    event.preventDefault();
    void show('players');
  });
  $('signOut').addEventListener('click', async () => {
    /* Best effort. Even if the call fails the console is closed locally, because the operator has
     * said they are done and leaving the page open is the greater risk. */
    await api.post('/v1/auth/logout', {}).catch(() => undefined);
    signedOut('You signed out.');
  });

  await show('overview');
}

void start();
