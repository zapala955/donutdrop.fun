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
  delete: (path, body) => request('DELETE', path, body),
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

/* What a payout error code means, and what to do about it, in words. The code alone
 * ("PAYOUT_UNCONFIRMED") left an operator with two buttons and no idea which was right. */
const PAYOUT_ERRORS = {
  PAYOUT_INSUFFICIENT_FUNDS:
    'Bot did not have the money in game, so nothing was sent. It waits in the payout queue and goes out by itself once the bot has the money: pay the bot in game.',
  PAYOUT_UNCONFIRMED:
    'The server never answered the /pay. Check the bot’s in-game payment history before choosing paid or not paid.',
  PAYOUT_NOT_SENT: 'Never reached the server (the bot was offline). Nothing was sent.',
  PAYOUT_AMOUNT_MISMATCH: 'The server confirmed a smaller amount than was asked for. Check in game.',
  PAYOUT_FAILED: 'The bot hit an error while paying. Check the bot’s in-game payment history.',
  LEASE_EXPIRED: 'The bot took the job and went quiet. Check the bot’s in-game payment history.',
};

/** A table cell for an error code: the code, and on hover and for screen readers, what it means. */
function errorCell(code) {
  const td = cell(code);
  const meaning = code ? PAYOUT_ERRORS[code] : undefined;
  if (meaning) {
    td.title = meaning;
    td.classList.add('wrap');
    const note = document.createElement('div');
    note.className = 'faint';
    note.textContent = meaning;
    td.append(note);
  }
  return td;
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

function button(label, handler, { danger = false, disabled = false, title = '' } = {}) {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = danger ? 'btn btn--danger' : 'btn';
  node.textContent = label;
  node.disabled = disabled;
  if (title) node.title = title;
  node.addEventListener('click', () => {
    Promise.resolve(handler(node)).catch((error) => {
      toast(`${error.code || 'ERROR'}: ${error.message || 'Action failed'}`, 'bad');
      node.disabled = false;
    });
  });
  return node;
}

function actions(...nodes) {
  const td = document.createElement('td');
  td.className = 'rowacts';
  td.append(...nodes);
  return td;
}

function renderStats(host, tiles) {
  host.replaceChildren();
  for (const [label, value, alarm = false, title = ''] of tiles) {
    const card = document.createElement('div');
    card.className = 'stat';
    if (alarm) card.dataset.alarm = '1';
    const name = document.createElement('span');
    name.className = 'stat__label';
    name.textContent = label;
    const amount = document.createElement('strong');
    amount.className = 'stat__value';
    amount.textContent = String(value);
    if (title) amount.title = title;
    card.append(name, amount);
    host.append(card);
  }
}

function prettyJson(value) {
  return JSON.stringify(value ?? {}, null, 2);
}

/** A reusable, typed form without HTML interpolation. */
function editRecord({ title, description = '', fields, submitLabel = 'Save' }) {
  return new Promise((resolve) => {
    const dialog = $('editor');
    const form = $('editorForm');
    const host = $('editorFields');
    dialog.returnValue = '';
    $('editorTitle').textContent = title;
    $('editorBody').textContent = description;
    $('editorSave').textContent = submitLabel;
    host.replaceChildren();

    for (const field of fields) {
      const label = document.createElement('label');
      label.className = field.wide ? 'editor__field editor__field--wide' : 'editor__field';
      const caption = document.createElement('span');
      caption.className = 'confirm__label';
      caption.textContent = field.label;
      let input;
      if (field.type === 'select') {
        input = document.createElement('select');
        for (const optionValue of field.options ?? []) {
          const option = document.createElement('option');
          option.value = typeof optionValue === 'object' ? optionValue.value : optionValue;
          option.textContent = typeof optionValue === 'object' ? optionValue.label : optionValue;
          input.append(option);
        }
      } else if (field.type === 'textarea') {
        input = document.createElement('textarea');
        input.rows = field.rows ?? 5;
      } else {
        input = document.createElement('input');
        input.type = field.type === 'checkbox' ? 'checkbox' : field.type || 'text';
      }
      input.className = field.type === 'checkbox' ? 'editor__check' : 'confirm__input';
      input.name = field.name;
      input.required =
        field.type === 'checkbox' ? field.required === true : field.required !== false;
      if (field.type === 'checkbox') input.checked = Boolean(field.value);
      else input.value = field.value ?? '';
      /* Every dialog's `reason` is the same audit field, and the server holds all ten of them to
       * safeText(3, 256). This form built its inputs without a length bound, so a two-character
       * reason passed the browser, failed the schema, and came back as `VALIDATION_ERROR: the
       * request is invalid` -- with the offending field named only in the server-side detail the
       * response deliberately withholds. The bound belongs on the input, where it can be met
       * before anything is sent rather than guessed at afterwards.
       *
       * The confirm dialog beside this one has carried minlength="3" in its markup all along;
       * this is the same contract for the dialogs that are built in script. */
      const bounds = field.name === 'reason' ? { minlength: 3, maxlength: 256 } : field;
      if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
        if (bounds.minlength !== undefined) input.minLength = bounds.minlength;
        if (bounds.maxlength !== undefined) input.maxLength = bounds.maxlength;
      }
      if (field.name === 'reason' && !field.placeholder) {
        input.placeholder = 'At least 3 characters — recorded in the audit log';
      }
      if (field.placeholder) input.placeholder = field.placeholder;
      if (field.min !== undefined) input.min = String(field.min);
      if (field.max !== undefined) input.max = String(field.max);
      label.append(caption, input);
      host.append(label);
    }

    const done = () => {
      dialog.removeEventListener('close', done);
      if (dialog.returnValue !== 'save') {
        resolve(null);
        return;
      }
      const values = {};
      for (const field of fields) {
        const input = form.elements.namedItem(field.name);
        values[field.name] = field.type === 'checkbox' ? input.checked : input.value.trim();
      }
      resolve(values);
    };
    dialog.addEventListener('close', done);
    dialog.showModal();
  });
}

function jsonField(raw, name) {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    throw new ApiError(0, 'INVALID_JSON', `${name} is not valid JSON`);
  }
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
 * The same figure, readable at a glance: $1.93m rather than $1,932,525.
 *
 * Used where a column is SCANNED -- balances, ledger rows -- and never where a number is being
 * acted on. amountText stays the default for anything an operator is about to approve or pay,
 * because $1.93m is three different amounts and a payout confirmation must say which one.
 *
 * BigInt all the way down. These balances pass 2^53 and a Number here would round the figure
 * somebody is reading to decide whether the float is right.
 */
function compactAmount(minor) {
  const value = typeof minor === 'bigint' ? minor : BigInt(minor ?? 0);
  const sign = value < 0n ? '-' : '';
  const n = value < 0n ? -value : value;
  for (const [suffix, scale] of [
    ['t', 1000000000000n],
    ['b', 1000000000n],
    ['m', 1000000n],
    ['k', 1000n],
  ]) {
    if (n < scale) continue;
    /* Two decimals, produced by integer arithmetic rather than by dividing into a float:
     * 1932525 -> 1.93m. Trailing zeros are dropped so a round figure reads as 2m, not 2.00m. */
    const whole = n / scale;
    const rest = ((n % scale) * 100n) / scale;
    const decimals = rest.toString().padStart(2, '0').replace(/0+$/, '');
    return sign + '$' + whole.toString() + (decimals ? '.' + decimals : '') + suffix;
  }
  return sign + '$' + n.toString();
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
  const [{ metrics: m, shortBots = [] }] = await Promise.all([
    api.get('/v1/admin/overview'),
    loadDashboard(),
  ]);
  const short = $('overviewShortBots');
  short.replaceChildren(
    ...shortBots.map((bot) => {
      const card = document.createElement('div');
      card.className = 'shortbot';
      const head = document.createElement('b');
      head.textContent = `${bot.username} (${bot.role}) is out of money in game`;
      const body = document.createElement('p');
      body.textContent =
        `The server refused to let it pay ${amountText(bot.largest_minor ?? 0)}` +
        ` (${bot.waiting} payout${bot.waiting === '1' ? '' : 's'} waiting since ` +
        `${new Date(bot.since).toLocaleString()}). Nothing was sent. The site's books say it holds ` +
        `${amountText(bot.tracked_balance_minor ?? 0)}, so its real balance is lower than that.`;
      const action = document.createElement('p');
      action.textContent =
        `To fix: pay ${bot.username} in game. The payouts wait in the queue in order and go out ` +
        'by themselves the moment it receives money (and every 5 minutes regardless).';
      card.append(head, body, action);
      return card;
    }),
  );
  short.hidden = shortBots.length === 0;
  /* Players only: admins, the developer test login and the system accounts are counted apart, so
   * a test balance is never read as money the site owes its players. */
  renderStats($('overviewStats'), [
    ['Players', m.users_total ?? 0],
    ['Active accounts', m.users_active ?? 0],
    ['Live sessions', m.sessions_live ?? 0],
    /* Read at a glance here; the exact figure is on hover and on the Economy tab. */
    [
      'Player balances',
      compactAmount(m.wallet_total_minor ?? 0),
      false,
      amountText(m.wallet_total_minor ?? 0),
    ],
    [
      'Staff balances',
      compactAmount(m.wallet_staff_minor ?? 0),
      false,
      amountText(m.wallet_staff_minor ?? 0),
    ],
    [
      'Wagered today',
      compactAmount(m.wagered_today_minor ?? 0),
      false,
      amountText(m.wagered_today_minor ?? 0),
    ],
    [
      'Roulette wagered today',
      compactAmount(m.roulette_wagered_today_minor ?? 0),
      false,
      amountText(m.roulette_wagered_today_minor ?? 0),
    ],
    ['Roulette open bets', m.roulette_open_bets ?? 0],
    ['Enabled cases', m.cases_enabled ?? 0],
    ['Catalog items', m.catalog_items_enabled ?? 0],
  ]);
  const attention = [
    ['Quarantined bots', m.bots_quarantined ?? 0, Number(m.bots_quarantined) > 0],
    ['Dead-letter jobs', m.jobs_dead_letter ?? 0, Number(m.jobs_dead_letter) > 0],
    [
      'Payouts needing attention',
      m.withdrawals_attention ?? 0,
      Number(m.withdrawals_attention) > 0,
    ],
    [
      'Payout queue',
      `${m.withdrawals_queued ?? 0} · ${amountText(m.withdrawals_queued_minor ?? 0)}`,
      shortBots.length > 0,
    ],
    [
      'Creator applications',
      m.creator_applications_pending ?? 0,
      Number(m.creator_applications_pending) > 0,
    ],
    ['Active chat timeouts', m.chat_timeouts_active ?? 0],
  ];
  renderStats($('overviewAttention'), attention);
  /* The operations tiles sit under the dashboard, so anything alarming among them is also named at
   * the top -- a dead-letter job must not wait for somebody to scroll past the charts. */
  const alarms = attention.filter(([, , alarm]) => alarm).map(([label]) => label);
  const alert = $('overviewAlert');
  alert.hidden = alarms.length === 0;
  alert.textContent = alarms.length
    ? `Needs attention: ${alarms.join(' · ')} — jump to operations`
    : '';
}

/* ═════════════════════════ the dashboard ═════════════════════════
 *
 * What the site earned over a period, from /v1/admin/stats: turnover, what the house kept (GGR),
 * what it paid back (rakeback, referrals, races, rain, bonuses, item buybacks) and the net, each
 * against the period before it, with the series behind them as charts. Staff accounts are left
 * out unless "Include staff" is on: an operator's test spins are not turnover.
 *
 * Amounts arrive as decimal strings of minor units and are formatted from BigInt. Charts convert
 * to Number only to place marks -- a pixel does not need 2^53 -- and every label and tooltip
 * shows the figure from the exact value. */

const DASH_RANGES = [
  [1, 'Today'],
  [7, '7 days'],
  [30, '30 days'],
  [90, '90 days'],
];
const dashState = { days: 7, includeStaff: false, seq: 0, report: null, bound: false };
try {
  const saved = JSON.parse(localStorage.getItem('du_admin_dash') || '{}');
  if (DASH_RANGES.some(([days]) => days === saved.days)) dashState.days = saved.days;
  dashState.includeStaff = saved.includeStaff === true;
} catch {
  /* Storage is a convenience; without it the dashboard opens on its defaults. */
}

const big = (value) => BigInt(value ?? 0);
const countText = (value) => Number(value ?? 0).toLocaleString('en-US');
const compactCount = (value) =>
  Number(value).toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 });
/** Hold, edge, share: a ratio of two exact amounts, to one decimal. */
function percentOf(part, whole) {
  const w = big(whole);
  if (w === 0n) return '—';
  return `${(Number((big(part) * 10000n) / w) / 100).toFixed(1)}%`;
}

function bindDashboard() {
  if (dashState.bound) return;
  dashState.bound = true;
  const range = $('dashRange');
  for (const [days, label] of DASH_RANGES) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.dataset.days = String(days);
    chip.textContent = label;
    chip.addEventListener('click', () => {
      dashState.days = days;
      void reloadDashboard();
    });
    range.append(chip);
  }
  $('dashStaff').addEventListener('click', () => {
    dashState.includeStaff = !dashState.includeStaff;
    void reloadDashboard();
  });
  $('overviewAlert').addEventListener('click', () =>
    $('opsHead').scrollIntoView({ behavior: 'smooth', block: 'start' }),
  );
  /* Charts are drawn at their real width, so they are redrawn when it changes: a resized window,
   * or the panel coming back from hidden (zero width) when its tab is chosen again. */
  let frame = 0;
  let drawnAt = 0;
  new ResizeObserver(([entry]) => {
    // Width only: a chart's table opening makes the panel taller, and must not redraw (and close) it.
    const width = Math.round(entry.contentRect.width);
    if (width === drawnAt) return;
    drawnAt = width;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (dashState.report) drawDashboardCharts(dashState.report);
    });
  }).observe($('dash'));
}

async function reloadDashboard() {
  try {
    await loadDashboard();
  } catch (error) {
    toast(`${error.code || 'ERROR'}: ${error.message || 'Could not load the dashboard'}`, 'bad');
  }
}

async function loadDashboard() {
  bindDashboard();
  try {
    localStorage.setItem(
      'du_admin_dash',
      JSON.stringify({ days: dashState.days, includeStaff: dashState.includeStaff }),
    );
  } catch {
    /* see above */
  }
  for (const chip of $('dashRange').children) {
    chip.setAttribute('aria-pressed', String(Number(chip.dataset.days) === dashState.days));
  }
  $('dashStaff').setAttribute('aria-pressed', String(dashState.includeStaff));
  const seq = ++dashState.seq;
  $('dash').setAttribute('aria-busy', 'true');
  try {
    const report = await api.get(
      `/v1/admin/stats?days=${dashState.days}&includeStaff=${dashState.includeStaff ? 1 : 0}`,
    );
    // A slower answer to an earlier click must not overwrite the period chosen since.
    if (seq !== dashState.seq) return;
    dashState.report = report;
    renderDashboard(report);
  } finally {
    if (seq === dashState.seq) $('dash').setAttribute('aria-busy', 'false');
  }
}

const UTC_DAY = { timeZone: 'UTC', month: 'short', day: 'numeric' };
function bucketLabel(at, unit, { long = false } = {}) {
  const date = new Date(at);
  if (unit === 'hour') {
    const hour = date.toISOString().slice(11, 16);
    if (!long) return hour;
    const next = new Date(date.getTime() + 3_600_000).toISOString().slice(11, 16);
    return `${date.toLocaleDateString('en-US', UTC_DAY)}, ${hour}–${next} UTC`;
  }
  return long
    ? date.toLocaleDateString('en-US', { ...UTC_DAY, weekday: 'short' })
    : date.toLocaleDateString('en-US', UTC_DAY);
}

function periodWords(days) {
  return days === 1 ? 'yesterday at this time' : `the previous ${days} days`;
}

/**
 * The change against the previous period, as words and a direction. `good` says which way is
 * good news for this figure (a cost going up is not); the arrow and the sign carry the direction
 * so it never rests on colour alone.
 */
function deltaOf(current, previous, good = 'up') {
  const now = Number(current);
  const before = Number(previous);
  if (now === 0 && before === 0) return { text: 'no change', tone: 'flat' };
  if (before === 0) {
    if (good === 'none') return { text: 'new', tone: 'flat' };
    return { text: 'new', tone: (now > 0) === (good === 'up') ? 'good' : 'bad' };
  }
  const change = ((now - before) / Math.abs(before)) * 100;
  if (Math.abs(change) < 0.05) return { text: '0.0%', tone: 'flat' };
  const up = change > 0;
  const size = Math.abs(change);
  const text = `${up ? '▲' : '▼'} ${size >= 1000 ? `${Math.round(size / 100) / 10}k` : size.toFixed(1)}%`;
  if (good === 'none') return { text, tone: 'flat' };
  return { text, tone: up === (good === 'up') ? 'good' : 'bad' };
}

function renderDashboard(report) {
  const { totals: t, previous: p, window: w } = report;
  const days = dashState.days;
  const from = new Date(w.from);
  const to = new Date(w.to);
  const span =
    days === 1
      ? `Today, ${from.toLocaleDateString('en-US', UTC_DAY)} 00:00–${to.toISOString().slice(11, 16)} UTC`
      : `${from.toLocaleDateString('en-US', UTC_DAY)} – ${to.toLocaleDateString('en-US', UTC_DAY)} (UTC)`;
  $('dashWindow').textContent = report.includeStaff
    ? `${span} · staff included`
    : `${span} · ${report.staffAccounts} staff account${report.staffAccounts === 1 ? '' : 's'} excluded`;

  /* ── the headline ── */
  const hero = $('dashHero');
  hero.replaceChildren();
  const label = document.createElement('span');
  label.className = 'hero__label';
  label.textContent = 'Net profit';
  const value = document.createElement('strong');
  value.className = 'hero__value';
  value.dataset.sign = big(t.net) < 0n ? 'down' : 'up';
  value.textContent = compactAmount(t.net);
  value.title = amountText(t.net);
  const change = deltaOf(t.net, p.net);
  const foot = document.createElement('p');
  foot.className = 'hero__delta';
  const badge = document.createElement('span');
  badge.className = 'delta';
  badge.dataset.tone = change.tone;
  badge.textContent = change.text;
  foot.append(badge, ` vs ${periodWords(days)} (${compactAmount(p.net)})`);
  /* How the net is made, left to right, so a bad day says whether the games lost or the promos
   * cost: house take, less what was paid back, less items bought back. */
  const bridge = document.createElement('dl');
  bridge.className = 'bridge';
  for (const [name, amount, sign] of [
    ['House take', t.ggr, ''],
    ['Promos & rewards', t.promo, '−'],
    ['Item buybacks', t.itemBuybacks, '−'],
    ['Net', t.net, '='],
  ]) {
    const item = document.createElement('div');
    item.className = 'bridge__item';
    const dt = document.createElement('dt');
    dt.textContent = sign ? `${sign} ${name}` : name;
    const dd = document.createElement('dd');
    dd.textContent = compactAmount(amount);
    dd.title = amountText(amount);
    item.append(dt, dd);
    bridge.append(item);
  }
  const text = document.createElement('div');
  text.className = 'hero__text';
  text.append(label, value, foot, bridge);
  const chart = document.createElement('div');
  chart.className = 'chart chart--hero';
  chart.id = 'chartNet';
  hero.append(text, chart);

  /* ── the tiles ── */
  const series = report.series;
  const pick = (key) => series.map((point) => Number(point[key]));
  const avgBet = t.bets > 0 ? big(t.wagered) / BigInt(t.bets) : 0n;
  const previousAvgBet = p.bets > 0 ? big(p.wagered) / BigInt(p.bets) : 0n;
  const perPlayer = t.players > 0 ? big(t.net) / BigInt(t.players) : 0n;
  const previousPerPlayer = p.players > 0 ? big(p.net) / BigInt(p.players) : 0n;
  const variance = big(t.ggr) - big(t.expectedGgr);
  const tiles = [
    {
      label: 'Wagered',
      value: compactAmount(t.wagered),
      exact: amountText(t.wagered),
      delta: deltaOf(t.wagered, p.wagered),
      spark: pick('wagered'),
      note: `${countText(t.bets)} bets`,
    },
    {
      label: 'House take (GGR)',
      value: compactAmount(t.ggr),
      exact: amountText(t.ggr),
      delta: deltaOf(t.ggr, p.ggr),
      spark: pick('ggr'),
      note: `Hold ${percentOf(t.ggr, t.wagered)}`,
    },
    {
      label: 'Promos & buybacks',
      value: compactAmount(big(t.promo) + big(t.itemBuybacks)),
      exact: amountText(big(t.promo) + big(t.itemBuybacks)),
      delta: deltaOf(big(t.promo) + big(t.itemBuybacks), big(p.promo) + big(p.itemBuybacks), 'down'),
      spark: pick('promo'),
      // A share of a take that was zero or negative says nothing; say what it means instead.
      note:
        big(t.ggr) > 0n
          ? `${percentOf(big(t.promo) + big(t.itemBuybacks), t.ggr)} of take`
          : big(t.promo) + big(t.itemBuybacks) > 0n
            ? 'More than the house took'
            : '',
    },
    {
      label: 'Expected take',
      value: compactAmount(t.expectedGgr),
      exact: amountText(t.expectedGgr),
      note: `${variance >= 0n ? 'Ran hot' : 'Ran cold'}: ${variance >= 0n ? '+' : ''}${compactAmount(variance)}`,
      title: 'What the games’ edges predict the house keeps from these wagers. The gap to the real take is luck.',
    },
    {
      label: 'Deposits',
      value: compactAmount(t.deposits),
      exact: amountText(t.deposits),
      delta: deltaOf(t.deposits, p.deposits),
      spark: pick('deposits'),
      note: `${countText(t.depositors)} depositor${t.depositors === 1 ? '' : 's'}`,
    },
    {
      label: 'Withdrawals',
      value: compactAmount(t.withdrawals),
      exact: amountText(t.withdrawals),
      delta: deltaOf(t.withdrawals, p.withdrawals, 'none'),
      spark: pick('withdrawals'),
    },
    {
      label: 'Net cash in',
      value: compactAmount(big(t.deposits) - big(t.withdrawals)),
      exact: amountText(big(t.deposits) - big(t.withdrawals)),
      delta: deltaOf(big(t.deposits) - big(t.withdrawals), big(p.deposits) - big(p.withdrawals)),
      note:
        big(t.adjustments) !== 0n
          ? `Manual adjustments ${big(t.adjustments) > 0n ? '+' : ''}${compactAmount(t.adjustments)}`
          : 'Deposits less withdrawals',
    },
    {
      label: 'Average bet',
      value: compactAmount(avgBet),
      exact: amountText(avgBet),
      delta: deltaOf(avgBet, previousAvgBet),
    },
    {
      label: 'Active players',
      value: countText(t.players),
      delta: deltaOf(t.players, p.players),
      spark: pick('players'),
      note: 'Placed at least one bet',
    },
    {
      label: 'New players',
      value: countText(t.newPlayers),
      delta: deltaOf(t.newPlayers, p.newPlayers),
      spark: pick('newPlayers'),
    },
    {
      label: 'Net per player',
      value: compactAmount(perPlayer),
      exact: amountText(perPlayer),
      delta: deltaOf(perPlayer, previousPerPlayer),
      note: 'Net profit ÷ active players',
    },
    {
      label: 'Bets placed',
      value: countText(t.bets),
      delta: deltaOf(t.bets, p.bets),
      spark: pick('bets'),
    },
  ];
  $('dashKpis').replaceChildren(...tiles.map(kpiTile));

  renderGames(report);
  renderCosts(report);
  renderPeople($('dashTop'), report.topPlayers, 'No bets in this period.');
  renderPeople($('dashWinners'), report.winners, 'Nobody came out ahead.');
  renderPeople($('dashLosers'), report.losers, 'Nobody came out behind.');
  drawDashboardCharts(report);
}

function kpiTile({ label, value, exact, delta, spark, note, title }) {
  const card = document.createElement('div');
  card.className = 'kpi';
  if (title) card.title = title;
  const name = document.createElement('span');
  name.className = 'kpi__label';
  name.textContent = label;
  const amount = document.createElement('strong');
  amount.className = 'kpi__value';
  amount.textContent = value;
  if (exact) amount.title = exact;
  card.append(name, amount);
  const foot = document.createElement('span');
  foot.className = 'kpi__foot';
  if (delta) {
    const badge = document.createElement('span');
    badge.className = 'delta';
    badge.dataset.tone = delta.tone;
    badge.textContent = delta.text;
    foot.append(badge);
  }
  if (note) {
    const words = document.createElement('span');
    words.textContent = note;
    foot.append(words);
  }
  if (foot.childNodes.length) card.append(foot);
  if (spark && spark.length > 1 && spark.some((point) => point !== 0)) card.append(sparkline(spark));
  return card;
}

/** The trend under a tile: one quiet line, no axis. The chart below carries the numbers. */
function sparkline(values) {
  const low = Math.min(0, ...values);
  const high = Math.max(0, ...values);
  const range = high - low || 1;
  const step = 100 / (values.length - 1);
  const root = svgNode('svg', {
    class: 'kpi__spark',
    viewBox: '0 0 100 24',
    preserveAspectRatio: 'none',
    'aria-hidden': 'true',
  });
  svgNode(
    'polyline',
    {
      points: values.map((v, i) => `${(i * step).toFixed(2)},${(22 - ((v - low) / range) * 20).toFixed(2)}`).join(' '),
      'vector-effect': 'non-scaling-stroke',
    },
    root,
  );
  return root;
}

function renderGames(report) {
  const games = [...report.games].sort((a, b) => (big(b.wagered) > big(a.wagered) ? 1 : -1));
  const most = games.reduce((top, game) => (big(game.wagered) > top ? big(game.wagered) : top), 0n);
  const total = big(report.totals.wagered);
  table(
    $('dashGames'),
    ['Game', 'Wagered', 'Share', 'Bets', 'Players', 'House take', 'Hold'],
    games,
    (game) => {
      const tr = document.createElement('tr');
      const share = document.createElement('td');
      share.className = 'sharecell';
      const bar = document.createElement('span');
      bar.className = 'sharebar';
      const fill = document.createElement('span');
      fill.style.width = most > 0n ? `${Number((big(game.wagered) * 1000n) / most) / 10}%` : '0%';
      bar.append(fill);
      const pct = document.createElement('span');
      pct.className = 'sharecell__pct';
      pct.textContent = percentOf(game.wagered, total);
      share.append(bar, pct);
      const take = cell(compactAmount(game.ggr), { mono: true });
      take.title = amountText(game.ggr);
      take.dataset.sign = big(game.ggr) < 0n ? 'down' : 'up';
      const wagered = cell(compactAmount(game.wagered), { mono: true });
      wagered.title = amountText(game.wagered);
      tr.append(
        cell(game.label),
        wagered,
        share,
        cell(countText(game.bets), { mono: true }),
        cell(countText(game.players), { mono: true }),
        take,
        cell(percentOf(game.ggr, game.wagered), { mono: true }),
      );
      return tr;
    },
  );
}

/** What the house paid back, largest first: a bar per programme, the amount written beside it. */
function renderCosts(report) {
  const host = $('dashCosts');
  host.replaceChildren();
  const rows = report.promo;
  if (!rows.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'Nothing paid out in rewards or buybacks in this period.';
    host.append(empty);
    return;
  }
  const most = rows.reduce((top, row) => (big(row.amount) > top ? big(row.amount) : top), 1n);
  const take = big(report.totals.ggr);
  for (const row of rows) {
    const line = document.createElement('div');
    line.className = 'hbar';
    const name = document.createElement('span');
    name.className = 'hbar__label';
    name.textContent = row.label;
    const track = document.createElement('span');
    track.className = 'hbar__track';
    const fill = document.createElement('span');
    fill.className = 'hbar__fill';
    fill.style.width = `${Math.max(0.5, Number((big(row.amount) * 1000n) / most) / 10)}%`;
    track.append(fill);
    const amount = document.createElement('span');
    amount.className = 'hbar__value';
    amount.textContent = compactAmount(row.amount);
    amount.title = `${amountText(row.amount)}${take > 0n ? ` · ${percentOf(row.amount, take)} of the house take` : ''}`;
    line.append(name, track, amount);
    host.append(line);
  }
}

/** A player list; a row opens the player sheet, where every lever for that account already is. */
function renderPeople(node, rows, emptyText) {
  table(node, ['Player', 'Wagered', 'Bets', 'Their result'], rows, (row) => {
    const tr = document.createElement('tr');
    tr.className = 'rowlink';
    tr.tabIndex = 0;
    tr.title = `Open ${row.name}`;
    const open = () => void openPlayer(row.id);
    tr.addEventListener('click', open);
    tr.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open();
      }
    });
    const wagered = cell(compactAmount(row.wagered), { mono: true });
    wagered.title = amountText(row.wagered);
    const result = cell(`${big(row.net) > 0n ? '+' : ''}${compactAmount(row.net)}`, { mono: true });
    result.title = amountText(row.net);
    result.dataset.sign = big(row.net) < 0n ? 'down' : 'up';
    tr.append(cell(row.name), wagered, cell(countText(row.bets), { mono: true }), result);
    return tr;
  });
  if (!rows.length) node.querySelector('.empty').textContent = emptyText;
}

/* ═════════════════════════ charts ═════════════════════════
 *
 * Plain SVG, drawn at the container's real width. One y-axis per chart, hairline gridlines, thin
 * marks: columns at most 24px wide with a 4px rounded end at the data and a gap of at least 2px,
 * 2px lines. Every chart answers the pointer -- the column under it, or a crosshair across lines --
 * with a tooltip naming the bucket and each value. Colours: blue first, orange second (validated
 * for colour-blind separation against this panel's surface); net profit runs blue above zero and
 * red below. Text is always in the ink colours, never the series colour. */

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgNode(tag, attributes = {}, parent = null) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  parent?.append(node);
  return node;
}

function drawDashboardCharts(report) {
  const unit = report.window.unit;
  const at = report.series.map((point) => point.at);
  const money = (key) => ({
    values: report.series.map((point) => Number(point[key])),
    exact: report.series.map((point) => point[key]),
  });
  drawChart($('chartNet'), {
    unit,
    at,
    axis: 'money',
    diverging: true,
    series: [{ label: 'Net profit', ...money('net') }],
  });
  drawChart($('chartWagered'), {
    unit,
    at,
    axis: 'money',
    series: [{ label: 'Wagered', color: 'var(--viz-1)', ...money('wagered') }],
  });
  drawChart($('chartCash'), {
    unit,
    at,
    axis: 'money',
    lines: true,
    series: [
      { label: 'Deposits', color: 'var(--viz-1)', ...money('deposits') },
      { label: 'Withdrawals', color: 'var(--viz-2)', ...money('withdrawals') },
    ],
  });
  drawChart($('chartPlayers'), {
    unit,
    at,
    axis: 'count',
    lines: true,
    series: [
      { label: 'Active players', color: 'var(--viz-1)', values: report.series.map((p) => p.players) },
      { label: 'New players', color: 'var(--viz-2)', values: report.series.map((p) => p.newPlayers) },
    ],
  });
}

function niceScale(low, high, count = 4) {
  if (low === high) high = low + 1;
  const raw = (high - low) / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw);
  const lo = Math.floor(low / step) * step;
  const hi = Math.ceil(high / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.abs(v) < step / 1e6 ? 0 : v);
  return { lo, hi, ticks };
}

function columnPath(x, width, base, end, radius) {
  const height = Math.abs(base - end);
  const r = Math.min(radius, width / 2, height);
  const up = end < base;
  const edge = up ? end + r : end - r;
  return (
    `M${x},${base}V${edge}Q${x},${end} ${x + r},${end}H${x + width - r}` +
    `Q${x + width},${end} ${x + width},${edge}V${base}Z`
  );
}

function drawChart(host, spec) {
  if (!host) return;
  const width = host.clientWidth;
  if (!width) return; // hidden; the resize observer draws it once it has a size
  const height = host.classList.contains('chart--hero') ? 150 : 190;
  const multi = spec.series.length > 1;
  const pad = { top: 10, right: multi ? 92 : 10, bottom: 24, left: 52 };
  const plotW = Math.max(10, width - pad.left - pad.right);
  const plotH = height - pad.top - pad.bottom;
  const n = spec.at.length;
  const all = spec.series.flatMap((s) => s.values);
  const { lo, hi, ticks } = niceScale(Math.min(0, ...all), Math.max(0, ...all));
  const y = (v) => pad.top + plotH - ((v - lo) / (hi - lo)) * plotH;
  const slot = plotW / Math.max(1, n);
  const cx = (i) => pad.left + slot * i + slot / 2;
  const tickText = (v) =>
    spec.axis === 'money' ? compactAmount(BigInt(Math.round(v))) : compactCount(v);
  const valueText = (s, i) =>
    s.exact ? compactAmount(s.exact[i]) : countText(s.values[i]);

  host.replaceChildren();
  const root = svgNode('svg', {
    class: 'chart__svg',
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    'aria-label': `${spec.series.map((s) => s.label).join(' and ')} by ${spec.unit}`,
  });
  host.append(root);

  /* Grid and the y-axis: recessive, with the zero line a step stronger. */
  for (const tick of ticks) {
    svgNode(
      'line',
      { class: tick === 0 ? 'chart__zero' : 'chart__grid', x1: pad.left, x2: pad.left + plotW, y1: y(tick), y2: y(tick) },
      root,
    );
    const label = svgNode('text', { class: 'chart__tick', x: pad.left - 8, y: y(tick) + 4, 'text-anchor': 'end' }, root);
    label.textContent = tickText(tick);
  }
  /* The x-axis: at most about one label per 70px, always including the first bucket. */
  const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plotW / 70))));
  for (let i = 0; i < n; i += every) {
    const label = svgNode('text', { class: 'chart__tick', x: cx(i), y: height - 6, 'text-anchor': 'middle' }, root);
    label.textContent = bucketLabel(spec.at[i], spec.unit);
  }

  const marks = svgNode('g', {}, root);
  const columns = [];
  if (!spec.lines) {
    const series = spec.series[0];
    const barW = Math.max(2, Math.min(24, slot - 2, slot * 0.72));
    series.values.forEach((v, i) => {
      if (v === 0) return;
      let end = y(v);
      const base = y(0);
      if (Math.abs(base - end) < 1.5) end = base + (v > 0 ? -1.5 : 1.5);
      const path = svgNode(
        'path',
        { d: columnPath(cx(i) - barW / 2, barW, base, end, 4), class: 'chart__col' },
        marks,
      );
      path.style.fill = spec.diverging ? (v < 0 ? 'var(--viz-neg)' : 'var(--viz-1)') : series.color;
      columns[i] = path;
    });
  } else {
    for (const series of spec.series) {
      const points = series.values.map((v, i) => `${cx(i).toFixed(1)},${y(v).toFixed(1)}`);
      if (n === 1) {
        svgNode('circle', { cx: cx(0), cy: y(series.values[0]), r: 4, class: 'chart__dot', fill: series.color }, marks);
      } else {
        const line = svgNode('polyline', { points: points.join(' '), class: 'chart__line' }, marks);
        line.style.stroke = series.color;
      }
    }
    /* Direct labels at the line ends, nudged apart so two close lines do not print on each other. */
    const ends = spec.series
      .map((series) => ({ series, at: y(series.values[n - 1] ?? 0) }))
      .sort((a, b) => a.at - b.at);
    for (let i = 1; i < ends.length; i += 1) {
      if (ends[i].at - ends[i - 1].at < 14) ends[i].at = ends[i - 1].at + 14;
    }
    for (const end of ends) {
      const tag = svgNode('text', { class: 'chart__end', x: pad.left + plotW + 8, y: end.at + 4 }, root);
      tag.textContent = end.series.label;
    }
  }

  /* The hover layer: one target over the whole plot, resolved to the bucket under the pointer. */
  const cross = svgNode('line', { class: 'chart__cross', y1: pad.top, y2: pad.top + plotH, visibility: 'hidden' }, root);
  const dots = spec.lines
    ? spec.series.map((series) => svgNode('circle', { r: 4, class: 'chart__dot', fill: series.color, visibility: 'hidden' }, root))
    : [];
  const tip = document.createElement('div');
  tip.className = 'tip';
  tip.hidden = true;
  host.append(tip);
  const target = svgNode('rect', { x: pad.left, y: pad.top, width: plotW, height: plotH, class: 'chart__hit' }, root);
  let shown = -1;
  const show = (event) => {
    const box = root.getBoundingClientRect();
    const i = Math.min(n - 1, Math.max(0, Math.floor((event.clientX - box.left - pad.left) / slot)));
    if (i === shown) return;
    shown = i;
    const x = cx(i);
    cross.setAttribute('x1', x);
    cross.setAttribute('x2', x);
    cross.setAttribute('visibility', spec.lines ? 'visible' : 'hidden');
    spec.series.forEach((series, k) => {
      if (!dots[k]) return;
      dots[k].setAttribute('cx', x);
      dots[k].setAttribute('cy', y(series.values[i]));
      dots[k].setAttribute('visibility', 'visible');
    });
    columns.forEach((column, k) => column?.classList.toggle('is-dim', k !== i));
    const head = document.createElement('b');
    head.textContent = bucketLabel(spec.at[i], spec.unit, { long: true });
    const rows = spec.series.map((series) => {
      const row = document.createElement('span');
      row.className = 'tip__row';
      const swatch = document.createElement('i');
      const v = series.values[i];
      swatch.style.background = spec.diverging ? (v < 0 ? 'var(--viz-neg)' : 'var(--viz-1)') : series.color;
      const name = document.createElement('span');
      name.textContent = series.label;
      const amount = document.createElement('strong');
      amount.textContent = valueText(series, i);
      if (series.exact) amount.title = amountText(series.exact[i]);
      row.append(swatch, name, amount);
      return row;
    });
    tip.replaceChildren(head, ...rows);
    tip.hidden = false;
    const left = Math.min(Math.max(x - tip.offsetWidth / 2, 0), width - tip.offsetWidth);
    tip.style.left = `${left}px`;
  };
  const hide = () => {
    shown = -1;
    tip.hidden = true;
    cross.setAttribute('visibility', 'hidden');
    for (const dot of dots) dot.setAttribute('visibility', 'hidden');
    for (const column of columns) column?.classList.remove('is-dim');
  };
  target.addEventListener('pointermove', show);
  target.addEventListener('pointerdown', show);
  target.addEventListener('pointerleave', hide);

  /* The same numbers as a table, for a screen reader and for anyone who wants the figures. */
  const data = document.createElement('details');
  data.className = 'chart__data';
  const summary = document.createElement('summary');
  summary.textContent = 'Show as table';
  data.append(summary);
  data.addEventListener(
    'toggle',
    () => {
      if (!data.open || data.querySelector('table')) return;
      const wrap = document.createElement('div');
      wrap.className = 'tablewrap';
      const grid = document.createElement('table');
      grid.className = 'grid';
      wrap.append(grid);
      data.append(wrap);
      table(grid, [spec.unit === 'hour' ? 'Hour (UTC)' : 'Day (UTC)', ...spec.series.map((s) => s.label)], spec.at.map((_, i) => i), (i) => {
        const tr = document.createElement('tr');
        tr.append(cell(bucketLabel(spec.at[i], spec.unit, { long: true })));
        for (const series of spec.series) tr.append(cell(series.exact ? amountText(series.exact[i]) : countText(series.values[i]), { mono: true }));
        return tr;
      });
    },
  );
  host.append(data);
}

async function loadPlayers(query = '') {
  const search = query ? `&search=${encodeURIComponent(query)}` : '';
  const data = await api.get(`/v1/admin/users?limit=50${search}`);
  table(
    $('playerTable'),
    /* KYC stood between Status and Role. It is gone with the compliance apparatus behind it — a
       column whose value was the same for every account and could not change anything an operator
       was going to do about a player using in-game currency. */
    ['Username', 'Status', 'Role', 'Joined', ''],
    data.users ?? [],
    (user) => {
      const tr = document.createElement('tr');
      tr.append(cell(user.minecraft_username));
      const status = document.createElement('td');
      status.append(pill(user.status, statusTone(user.status)));
      tr.append(status);
      tr.append(cell(user.role), cell(user.created_at));

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
     account do, what is it holding, and what has it actually done here.

     The KYC, age-verified and self-excluded rows are gone with the compliance apparatus behind
     them. They were the only three facts on this sheet that could not change anything an operator
     was going to do about an account playing with in-game currency.

     PnL is from the player's side, so a positive figure is a player who is up on the house. That
     direction is stated in the label rather than left to be inferred, because the same number read
     the other way round is the opposite conclusion about whether to look harder at an account. */
  const stats = data.stats ?? {};
  const pnl = BigInt(stats.pnlMinor ?? '0');
  const facts = [
    ['Status', user.status, statusTone(user.status)],
    ['Role', user.role, user.role === 'admin' ? 'warn' : null],
    ['Balance', amountText(data.balanceMinor), null],
    ['Wagered', amountText(stats.wageredMinor ?? '0'), null],
    [
      'Player PnL',
      `${pnl > 0n ? '+' : ''}${amountText(stats.pnlMinor ?? '0')}`,
      pnl > 0n ? 'warn' : pnl < 0n ? 'ok' : null,
    ],
    ['Deposited', amountText(stats.depositedMinor ?? '0'), null],
    ['Withdrawn', amountText(stats.withdrawnMinor ?? '0'), null],
    ['Staff adjustments', signedAmount(stats.adjustmentsMinor), null],
    ['Tips, net', signedAmount(stats.transfersMinor), null],
    ['Sessions', String((data.sessions ?? []).length), null],
    [
      'Last login',
      user.last_login_at ? new Date(user.last_login_at).toLocaleString() : 'never',
      null,
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
    $('sheetGames'),
    ['Game', 'Wagered', 'Bets', 'Player result'],
    stats.byGame ?? [],
    (game) => {
      const tr = document.createElement('tr');
      const net = BigInt(game.netMinor);
      const result = cell(signedAmount(game.netMinor), { mono: true });
      result.dataset.sign = net < 0n ? 'down' : 'up';
      result.title = amountText(game.netMinor);
      tr.append(
        cell(game.label),
        cell(compactAmount(game.wageredMinor), { mono: true }),
        cell(game.bets, { mono: true }),
        result,
      );
      return tr;
    },
  );

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
        `Suspend ${user.minecraft_username}? They cannot wager or sign in, and every live ` +
          'session ends immediately.',
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
        `Close ${user.minecraft_username}'s account? This is the heaviest state: no wagering, no ` +
          'sign-in, all sessions ended. It can be reversed from here, but treat it as final.',
      );
      if (!reason) return false;
      await api.patch(`/v1/admin/users/${id}/status`, { status: 'closed', reason });
      toast('Account closed.', 'ok');
    });
  }

  lever('Credit balance', null, async () => {
    const answer = await confirmAmount(
      `Add to ${user.minecraft_username}'s site balance. Currently ` +
        `${amountText(data.balanceMinor)}. Writes an admin_adjustment to the ledger.`,
      { label: 'Amount to add' },
    );
    if (!answer) return false;
    const result = await api.post(`/v1/admin/users/${id}/balance`, answer);
    toast(`Credited. New balance ${amountText(result.balanceMinor)}.`, 'ok');
  });

  lever('Debit balance', 'danger', async () => {
    const answer = await confirmAmount(
      `Take from ${user.minecraft_username}'s site balance. Currently ` +
        `${amountText(data.balanceMinor)}. Refused if it would go below zero.`,
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
        `End all ${data.sessions.length} live session(s) for ${user.minecraft_username}? ` +
          'The account keeps every permission it has — this only ends the sign-ins.',
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
      ? 'Administrator. Roles come from ADMIN_MINECRAFT_IDS and are not editable here — remove ' +
        'the identity from that variable and restart to revoke.'
      : 'Player. Roles come from ADMIN_MINECRAFT_IDS and are not editable here — an administrator ' +
        'also needs an ADMIN_TOTP_SECRETS entry, and the API will not start without one.';
  host.append(note);
}

/* Which bot the transaction log below is filtered to, and the bots it can be filtered by.
 * Held between renders so switching tabs does not silently reset an operator's filter. */
const botLedgerState = { botId: null, bots: [] };

async function loadBots() {
  const data = await api.get('/v1/admin/bots');
  botLedgerState.bots = data.bots ?? [];
  table(
    $('botTable'),
    ['Bot', 'Role', 'Holding', 'Status', 'Reconciliation', 'Transfers', 'Heartbeat', 'Open jobs', ''],
    data.bots ?? [],
    (bot) => {
      const tr = document.createElement('tr');
      tr.append(cell(bot.username));
      const role = document.createElement('td');
      /* The vault is marked, not merely named. It is the account whose username must never reach
       * a player, and an operator glancing at this table should be able to see which one that is
       * without reading the column header. */
      role.append(pill(bot.role === 'vault' ? 'VAULT' : 'teller', bot.role === 'vault' ? 'warn' : 'ok'));

      /* What the account is really holding, as the bot's own /bal last read it (DonutSMP switched
       * its stats API off), not what this platform believes.
       * The tracked figure is maintained from receipts and starts at zero on a float that has
       * just been switched on -- which is why this column read $0 beside an account holding
       * millions. The tracked number is still worth seeing, so it rides in the tooltip next to
       * the exact live figure; the cell itself stays scannable. */
      // `live` is already the liveness flag further down this function; this is the balance.
      const liveBalance = bot.live_balance_minor;
      const holding = document.createElement('td');
      holding.className = 'mono';
      holding.textContent =
        liveBalance === null || liveBalance === undefined ? '—' : compactAmount(liveBalance);
      const readAt = bot.live_balance_at ? new Date(bot.live_balance_at).toLocaleString() : 'unknown';
      // DonutSMP abbreviates and rounds down, so "1.97M" means somewhere in [1,970,000, 1,980,000).
      const band =
        liveBalance !== null && liveBalance !== undefined &&
        bot.live_balance_step_minor && bot.live_balance_step_minor !== '1'
          ? ` (shown in game as ${bot.live_balance_display}, so below ${amountText(
              BigInt(liveBalance) + BigInt(bot.live_balance_step_minor),
            )})`
          : '';
      holding.title =
        liveBalance === null || liveBalance === undefined
          ? `No /bal reading from this bot yet. Tracked: ${amountText(bot.tracked_balance_minor)}`
          : `In game, by /bal at ${readAt}: at least ${amountText(liveBalance)}${band}` +
            (bot.live_balance_error === 'BALANCE_READING_STALE'
              ? '\nThis reading is over ten minutes old.'
              : '') +
            `\nTracked by the platform: ${amountText(bot.tracked_balance_minor)}`;
      tr.append(role, holding);
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
          `Tell ${bot.username} to reconnect? It drops its connection and rejoins about ten ` +
            'seconds later. Anything it is part-way through is abandoned.',
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

      const roleButton = document.createElement('button');
      roleButton.type = 'button';
      roleButton.className = 'btn';
      roleButton.textContent = bot.role === 'vault' ? 'Make teller' : 'Make vault';
      roleButton.title =
        bot.role === 'vault'
          ? 'Put this account back in front of players'
          : 'Hold the float on this account and stop showing its name to players';
      roleButton.addEventListener('click', () => void changeBotRole(bot));

      const reconcile = document.createElement('button');
      reconcile.type = 'button';
      reconcile.className = 'btn';
      reconcile.textContent = 'Reconcile';
      reconcile.title = "Correct the tracked balance to what the account is really holding";
      reconcile.addEventListener('click', () => void reconcileBot(bot));

      actions.append(rejoin, pay, roleButton, reconcile);

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
    `Pay which player, from ${bot.username}'s in-game balance?\n\n` +
      'Exact Minecraft name. This sends real in-game currency and cannot be reversed.',
  );
  if (payee === null) return;
  const name = payee.trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) {
    toast('That is not a Minecraft username.', 'bad');
    return;
  }
  const answer = await confirmAmount(
    `Pay ${name} from ${bot.username}'s own in-game balance. This does not touch anybody's site ` +
      'wallet and there is nothing to refund if it fails.',
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

/**
 * Moves a bot between the two roles.
 *
 * Spelled out rather than confirmed with a shrug, because this decides which account a player is
 * told to pay from the very next deposit onward, and the whole point of the vault is that its
 * name has never been published.
 */
async function changeBotRole(bot) {
  const becomingVault = bot.role !== 'vault';
  const reason = await confirmAction(
    becomingVault
      ? `Make ${bot.username} the vault? Its name stops appearing on deposit screens, login ` +
          'cards and withdrawals, and it starts holding the float behind the teller.'
      : `Make ${bot.username} a teller? Its name becomes public: players will be told to pay it ` +
          'and will be paid by it.',
  );
  if (!reason) return;
  await api.patch(`/v1/admin/bots/${bot.id}/role`, {
    role: becomingVault ? 'vault' : 'teller',
    reason,
  });
  toast(`${bot.username} is now ${becomingVault ? 'the vault' : 'a teller'}.`);
  await loadBots();
  await loadBotLedger();
}

/**
 * Corrects the tracked balance to what the account is really holding.
 *
 * The difference is written into the log as its own row rather than overwriting the figure, so a
 * correction is as visible afterwards as every other movement and the running balance stays the
 * sum of its own history.
 */
async function reconcileBot(bot) {
  const live = bot.live_balance_minor;
  const values = await editRecord({
    title: `Reconcile ${bot.username}`,
    description:
      `Tracked: ${amountText(bot.tracked_balance_minor)}.` +
      (live === null || live === undefined
        ? ' The bot has not read its balance yet, so enter what /bal says in game.'
        : ` The bot's /bal shows ${bot.live_balance_display || amountText(live)}` +
          (bot.live_balance_step_minor && bot.live_balance_step_minor !== '1'
            ? ', which is rounded down: check the exact figure in game before saving.'
            : ', filled in below.')) +
      ' The difference is written to the log as an adjustment.',
    fields: [
      // Prefilled from the live reading, so the common case is read it, agree, submit.
      {
        name: 'observed',
        label: 'Observed balance (e.g. 1.5b)',
        value: live === null || live === undefined ? '' : String(live),
      },
      { name: 'reason', label: 'Audit reason', wide: true },
    ],
    submitLabel: 'Write the adjustment',
  });
  if (!values) return;
  const exact = /^(0|[1-9]\d*)$/.test(values.observed)
    ? BigInt(values.observed)
    : parseAmount(values.observed);
  if (exact === null) throw new ApiError(0, 'INVALID_AMOUNT', 'Enter a valid non-negative amount');
  const result = await api.post(`/v1/admin/bots/${bot.id}/reconcile`, {
    observedBalanceMinor: exact.toString(),
    reason: values.reason,
  });
  toast(
    result.bot.adjustedMinor === '0'
      ? 'Already correct; nothing written.'
      : `Adjusted by ${amountText(result.bot.adjustedMinor)}.`,
  );
  await loadBots();
  await loadBotLedger();
}

const LEDGER_REASON = {
  deposit: 'Deposit in',
  login: 'Login payment',
  sweep: 'Swept to vault',
  release: 'Released from vault',
  withdrawal: 'Paid to player',
  admin_payout: 'Operator payout',
  adjustment: 'Manual adjustment',
};

async function loadBotLedger() {
  const params = botLedgerState.botId
    ? `?botId=${botLedgerState.botId}&limit=100`
    : '?limit=100';
  const data = await api.get(`/v1/admin/bot-transfers${params}`);
  const rows = data.transfers ?? [];

  const filter = $('botLedgerFilter');
  if (filter) {
    filter.replaceChildren();
    const chips = [['All bots', null], ...botLedgerState.bots.map((bot) => [bot.username, bot.id])];
    for (const [label, id] of chips) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.setAttribute('aria-pressed', String(botLedgerState.botId === id));
      chip.textContent = label;
      chip.addEventListener('click', () => {
        botLedgerState.botId = id;
        void loadBotLedger();
      });
      filter.append(chip);
    }
  }

  const hint = $('botLedgerHint');
  if (hint) {
    hint.textContent = rows.length
      ? `${rows.length} most recent movements. Every figure is what the bot held afterwards.`
      : 'Nothing has moved through the bots yet.';
  }

  table(
    $('botLedgerTable'),
    ['When', 'Bot', 'Movement', 'Amount', 'Counterparty', 'Player', 'Balance after'],
    rows,
    (row) => {
      const tr = document.createElement('tr');
      const movement = document.createElement('td');
      movement.append(
        pill(LEDGER_REASON[row.reason] ?? row.reason, row.direction === 'in' ? 'ok' : 'warn'),
      );
      tr.append(
        cell(row.created_at),
        cell(`${row.bot_username} · ${row.bot_role}`),
        movement,
        /* Signed, because a column of bare figures cannot say which way the money went and the
           direction is the single most important thing about a row in a money log. */
        cell(
          `${row.direction === 'in' ? '+' : '−'}${compactAmount(row.amount_minor)}`,
          { mono: true },
        ),
        cell(row.counterparty),
        cell(row.player_username),
        cell(compactAmount(row.balance_after_minor), { mono: true }),
      );
      return tr;
    },
  );
}

async function loadPayouts() {
  const data = await api.get('/v1/admin/payouts');
  table(
    $('payoutTable'),
    ['When', 'Payee', 'Amount', 'Status', 'Bot', 'Ordered by', 'Reason', ''],
    data.payouts ?? [],
    (payout) => {
      const tr = document.createElement('tr');
      tr.append(cell(payout.created_at), cell(payout.payee_username));
      tr.append(cell(amountText(payout.amount_minor), { mono: true }));
      const status = document.createElement('td');
      status.append(
        pill(
          payout.status === 'failed' && payout.error_code === 'PAYOUT_INSUFFICIENT_FUNDS'
            ? 'failed · bot had no money, nothing sent'
            : payout.status === 'failed' && payout.error_code
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
      const review = payout.status === 'manual_review' || payout.status === 'failed';
      tr.append(
        actions(
          ...(review
            ? [
                button('Confirm paid', async () => {
                  const why = await confirmAction(
                    'Confirm only after checking the in-game payment receipt.',
                  );
                  if (!why) return;
                  await api.post(`/v1/admin/payouts/${payout.id}/resolve`, {
                    outcome: 'paid',
                    reason: why,
                  });
                  toast('Payout recorded as paid.');
                  await loadPayouts();
                }),
                button(
                  'Confirm not paid',
                  async () => {
                    const why = await confirmAction(
                      'Confirm the payment did not land. This does not credit any site wallet.',
                    );
                    if (!why) return;
                    await api.post(`/v1/admin/payouts/${payout.id}/resolve`, {
                      outcome: 'not_paid',
                      reason: why,
                    });
                    toast('Payout closed as not paid.');
                    await loadPayouts();
                  },
                  { danger: true },
                ),
              ]
            : []),
        ),
      );
      return tr;
    },
  );
}

async function loadJobs() {
  const data = await api.get('/v1/admin/jobs');
  table(
    $('jobTable'),
    ['Job', 'Type', 'Status', 'Attempts', 'Last error', 'Updated', ''],
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
        errorCell(job.last_error_code),
        cell(job.updated_at),
      );
      /* A vault release pays our own teller, never a player, so sending it again cannot put money
       * outside the platform. The server still refuses unless the withdrawal behind it is unpaid. */
      const safeRetry =
        job.status === 'dead_letter' &&
        (job.kind === 'inventory_resync' || job.kind === 'reconnect' || job.kind === 'vault_release');
      tr.append(
        actions(
          ...(safeRetry
            ? [
                button('Retry', async (node) => {
                  const reason = await confirmAction(
                    job.kind === 'vault_release'
                      ? 'Send this vault release to the teller again? The player is paid once it lands.'
                      : `Retry this ${job.kind} control job?`,
                  );
                  if (!reason) return;
                  node.disabled = true;
                  await api.post(`/v1/admin/jobs/${job.id}/retry`, { reason });
                  toast('Job returned to the queue.');
                  await loadJobs();
                }),
              ]
            : []),
        ),
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

async function loadEconomy() {
  const search = $('economyQuery').value.trim();
  const [economy, withdrawalData] = await Promise.all([
    api.get(`/v1/admin/economy?limit=100${search ? `&search=${encodeURIComponent(search)}` : ''}`),
    api.get('/v1/admin/cash-withdrawals'),
  ]);
  const totals = economy.totals ?? {};
  renderStats($('economyStats'), [
    ['Wallet liability', amountText(totals.wallet_total_minor ?? 0)],
    ['Lifetime ledger credits', amountText(totals.ledger_credits_minor ?? 0)],
    ['Lifetime ledger debits', amountText(totals.ledger_debits_minor ?? 0)],
    ['Cash received', amountText(totals.cash_received_minor ?? 0)],
    ['Cash paid out', amountText(totals.cash_paid_minor ?? 0)],
  ]);
  table(
    $('withdrawalTable'),
    ['Created', 'Player', 'Payee', 'Amount', 'Status', 'Error', ''],
    withdrawalData.withdrawals ?? [],
    (withdrawal) => {
      const tr = document.createElement('tr');
      tr.append(
        cell(withdrawal.created_at),
        cell(withdrawal.minecraft_username),
        cell(withdrawal.payee_username),
        cell(amountText(withdrawal.amount_minor), { mono: true }),
      );
      const status = document.createElement('td');
      status.append(
        pill(withdrawal.status, withdrawal.status === 'manual_review' ? 'bad' : 'warn'),
      );
      tr.append(status, errorCell(withdrawal.error_code));
      const buttons = [];
      if (withdrawal.status === 'pending_approval') {
        buttons.push(
          button('Approve', async (node) => {
            const reason = await confirmAction(
              `Approve ${amountText(withdrawal.amount_minor)} to ${withdrawal.payee_username}?`,
            );
            if (!reason) return;
            node.disabled = true;
            await api.post(`/v1/admin/cash-withdrawals/${withdrawal.id}/approve`, { reason });
            toast('Withdrawal approved and queued.');
            await loadEconomy();
          }),
          button(
            'Reject & refund',
            async (node) => {
              const reason = await confirmAction(
                `Reject this withdrawal and return ${amountText(withdrawal.amount_minor)} to the wallet?`,
              );
              if (!reason) return;
              node.disabled = true;
              await api.post(`/v1/admin/cash-withdrawals/${withdrawal.id}/reject`, { reason });
              toast('Withdrawal rejected and refunded.');
              await loadEconomy();
            },
            { danger: true },
          ),
        );
      }
      if (withdrawal.status === 'manual_review') {
        buttons.push(
          button('Confirm paid', async (node) => {
            const reason = await confirmAction(
              'Only confirm paid after checking the DonutSMP receipt. This closes the held payout.',
            );
            if (!reason) return;
            node.disabled = true;
            await api.post(`/v1/admin/cash-withdrawals/${withdrawal.id}/resolve`, {
              outcome: 'paid',
              reason,
            });
            toast('Withdrawal recorded as paid.');
            await loadEconomy();
          }),
          button(
            'Confirm not paid & refund',
            async (node) => {
              /* Whether a refund is safe depends entirely on whether the server said no. When it
               * did, nothing left the bot; when it said nothing, the player may well have the money
               * already, and a refund pays them twice. */
              const known = ['PAYOUT_INSUFFICIENT_FUNDS', 'PAYOUT_NOT_SENT'].includes(withdrawal.error_code);
              const reason = await confirmAction(
                known
                  ? 'Safe to refund: the server refused this payment, so nothing was sent. This credits the wallet.'
                  : 'STOP: this payout may already have reached the player. Check the bot’s in-game payment ' +
                    `history for ${amountText(withdrawal.amount_minor)} to ${withdrawal.payee_username} first. ` +
                    'Refunding a payment that landed pays them twice.',
              );
              if (!reason) return;
              node.disabled = true;
              await api.post(`/v1/admin/cash-withdrawals/${withdrawal.id}/resolve`, {
                outcome: 'refund',
                reason,
              });
              toast('Withdrawal refunded.');
              await loadEconomy();
            },
            { danger: true },
          ),
        );
      }
      tr.append(actions(...buttons));
      return tr;
    },
  );
  table(
    $('economyTable'),
    ['Sequence', 'When', 'Player', 'Kind', 'Change', 'Balance after', 'Reference'],
    economy.transactions ?? [],
    (transaction) => {
      const tr = document.createElement('tr');
      tr.append(
        cell(transaction.seq, { mono: true }),
        cell(transaction.created_at),
        cell(transaction.minecraft_username),
        cell(transaction.kind),
      );
      const movement = cell(amountText(transaction.amount_minor), { mono: true });
      movement.dataset.sign = BigInt(transaction.amount_minor) > 0n ? 'up' : 'down';
      tr.append(
        movement,
        cell(amountText(transaction.balance_after_minor), { mono: true }),
        cell(transaction.reference_id, { mono: true }),
      );
      return tr;
    },
  );
  table(
    $('depositTable'),
    ['When', 'Payer', 'Amount', 'Status', 'Account', 'Receipt'],
    economy.deposits ?? [],
    (deposit) => {
      const tr = document.createElement('tr');
      tr.append(
        cell(deposit.created_at),
        cell(deposit.payer_username),
        cell(deposit.amount_minor ? amountText(deposit.amount_minor) : deposit.displayed_amount, {
          mono: true,
        }),
      );
      const status = document.createElement('td');
      status.append(pill(deposit.status, deposit.status === 'credited' ? 'ok' : 'warn'));
      tr.append(status, cell(deposit.minecraft_username), cell(deposit.id, { mono: true }));
      return tr;
    },
  );
}

let catalogCache = [];
let botCache = [];

async function loadCatalog() {
  const [catalog, observed, inventory, bots] = await Promise.all([
    api.get('/v1/admin/catalog-items'),
    api.get('/v1/admin/observed-items'),
    api.get('/v1/admin/inventory?limit=100'),
    api.get('/v1/admin/bots'),
  ]);
  catalogCache = catalog.items ?? [];
  botCache = bots.bots ?? [];
  table(
    $('catalogTable'),
    ['Name', 'Minecraft ID', 'Price', 'Enabled', 'Available', 'Pending', 'Bots', ''],
    catalogCache,
    (item) => {
      const tr = document.createElement('tr');
      tr.append(
        cell(item.display_name),
        cell(item.minecraft_name, { mono: true }),
        cell(amountText(item.unit_value_minor), { mono: true }),
      );
      const enabled = document.createElement('td');
      enabled.append(pill(item.enabled ? 'enabled' : 'disabled', item.enabled ? 'ok' : 'warn'));
      tr.append(
        enabled,
        cell(item.available_quantity, { mono: true }),
        cell(item.pending_quantity, { mono: true }),
        cell(item.stocked_bots, { mono: true }),
        actions(
          button('Edit', () => editCatalogItem(item)),
          button('Allocate stock', () => allocateStock(item), {
            disabled: !item.enabled || botCache.length === 0,
          }),
        ),
      );
      return tr;
    },
  );
  table(
    $('itemTable'),
    ['Item', 'Minecraft name', 'Quantity', 'Bot', 'Catalog', 'Last seen', ''],
    observed.items ?? [],
    (item) => {
      const tr = document.createElement('tr');
      tr.append(
        cell(item.display_name),
        cell(item.minecraft_name),
        cell(item.last_quantity, { mono: true }),
        cell(item.bot_id, { mono: true }),
      );
      const known = document.createElement('td');
      known.append(pill(item.catalog_item_id ? 'yes' : 'no', item.catalog_item_id ? 'ok' : 'warn'));
      tr.append(known, cell(item.last_seen_at));
      tr.append(
        actions(
          ...(item.catalog_item_id
            ? []
            : [button('Add to catalog', () => createCatalogItem(item))]),
        ),
      );
      return tr;
    },
  );
  table(
    $('inventoryTable'),
    ['Updated', 'Item', 'Owner', 'Bot', 'Quantity', 'State', 'Source'],
    inventory.lots ?? [],
    (lot) => {
      const tr = document.createElement('tr');
      tr.append(
        cell(lot.updated_at),
        cell(lot.display_name),
        cell(lot.owner_username ?? 'House'),
        cell(lot.bot_username),
        cell(lot.quantity, { mono: true }),
      );
      const state = document.createElement('td');
      state.append(pill(lot.state, lot.state === 'available' ? 'ok' : 'warn'));
      tr.append(state, cell(lot.source_type));
      return tr;
    },
  );
}

async function createCatalogItem(observed = {}) {
  const values = await editRecord({
    title: 'Add catalog item',
    description: 'The fingerprint must be the exact 64-character value reported by a bot.',
    fields: [
      { name: 'displayName', label: 'Display name', value: observed.display_name ?? '' },
      { name: 'minecraftName', label: 'Minecraft item ID', value: observed.minecraft_name ?? '' },
      { name: 'unitValueMinor', label: 'Unit value', placeholder: '100000' },
      { name: 'imageUrl', label: 'HTTPS image URL (optional)', required: false },
      { name: 'fingerprint', label: 'Fingerprint', value: observed.fingerprint ?? '', wide: true },
      { name: 'enabled', label: 'Enabled', type: 'checkbox', value: false },
      { name: 'metadata', label: 'Metadata JSON', type: 'textarea', value: '{}', wide: true },
      { name: 'reason', label: 'Audit reason', wide: true },
    ],
    submitLabel: 'Create item',
  });
  if (!values) return;
  try {
    await api.post('/v1/admin/catalog-items', {
      fingerprint: values.fingerprint,
      minecraftName: values.minecraftName,
      displayName: values.displayName,
      imageUrl: values.imageUrl || null,
      unitValueMinor: parseAmount(values.unitValueMinor)?.toString() ?? values.unitValueMinor,
      enabled: values.enabled,
      metadata: jsonField(values.metadata, 'Metadata'),
      reason: values.reason,
    });
    toast('Catalog item created.');
    await loadCatalog();
  } catch (error) {
    toast(`${error.code}: ${error.message}`, 'bad');
  }
}

async function editCatalogItem(item) {
  const values = await editRecord({
    title: `Edit ${item.display_name}`,
    fields: [
      { name: 'displayName', label: 'Display name', value: item.display_name },
      { name: 'unitValueMinor', label: 'Unit value', value: item.unit_value_minor },
      {
        name: 'imageUrl',
        label: 'HTTPS image URL (optional)',
        value: item.image_url ?? '',
        required: false,
      },
      { name: 'enabled', label: 'Enabled', type: 'checkbox', value: item.enabled },
      {
        name: 'metadata',
        label: 'Metadata JSON',
        type: 'textarea',
        value: prettyJson(item.metadata),
        wide: true,
      },
      { name: 'reason', label: 'Audit reason', wide: true },
    ],
  });
  if (!values) return;
  try {
    await api.patch(`/v1/admin/catalog-items/${item.id}`, {
      displayName: values.displayName,
      imageUrl: values.imageUrl || null,
      unitValueMinor: parseAmount(values.unitValueMinor)?.toString() ?? values.unitValueMinor,
      enabled: values.enabled,
      metadata: jsonField(values.metadata, 'Metadata'),
      reason: values.reason,
    });
    toast('Catalog item updated.');
    await loadCatalog();
  } catch (error) {
    toast(`${error.code}: ${error.message}`, 'bad');
  }
}

async function allocateStock(item) {
  const values = await editRecord({
    title: `Allocate ${item.display_name}`,
    description: 'Allocation cannot exceed the latest physical bot snapshot.',
    fields: [
      {
        name: 'botId',
        label: 'Bot',
        type: 'select',
        options: botCache.map((bot) => ({
          value: bot.id,
          label: `${bot.username} - ${bot.status}`,
        })),
      },
      { name: 'quantity', label: 'Quantity', type: 'number', min: 1, max: 100000 },
      { name: 'reason', label: 'Audit reason', wide: true },
    ],
    submitLabel: 'Allocate stock',
  });
  if (!values) return;
  try {
    await api.post(
      '/v1/admin/stock',
      {
        catalogItemId: item.id,
        botId: values.botId,
        quantity: Number(values.quantity),
        reason: values.reason,
      },
      { idempotency: true },
    );
    toast('Stock allocated; the bot will reconcile its next snapshot.');
    await loadCatalog();
  } catch (error) {
    toast(`${error.code}: ${error.message}`, 'bad');
  }
}

async function loadCases() {
  const data = await api.get('/v1/admin/cases');
  table(
    $('caseTable'),
    ['Name', 'Slug', 'Owner', 'Price', 'Drops', 'Expected return', 'Status', ''],
    data.cases ?? [],
    (crate) => {
      const tr = document.createElement('tr');
      const expected = (crate.drops ?? []).reduce(
        (sum, drop) =>
          sum + BigInt(drop.unitValueMinor) * BigInt(drop.quantity) * BigInt(drop.weight),
        0n,
      );
      const returnBps =
        BigInt(crate.totalWeight ?? 0) > 0n
          ? (expected * 10_000n) / (BigInt(crate.totalWeight) * BigInt(crate.priceMinor))
          : 0n;
      tr.append(
        cell(crate.name),
        cell(crate.slug, { mono: true }),
        cell(crate.creatorUsername ?? 'First party'),
        cell(amountText(crate.priceMinor), { mono: true }),
        cell((crate.drops ?? []).length, { mono: true }),
        cell(`${returnBps} bps`, { mono: true }),
      );
      const status = document.createElement('td');
      const statusLabel =
        crate.communityStatus === 'first_party'
          ? crate.enabled
            ? 'published'
            : 'disabled'
          : crate.communityStatus;
      status.append(pill(statusLabel, crate.enabled ? 'ok' : 'warn'));
      tr.append(status, actions(button('Edit', () => editCase(crate))));
      return tr;
    },
  );
}

function caseFields(crate = {}) {
  const drops = (crate.drops ?? []).map((drop) => ({
    catalogItemId: drop.catalogItemId,
    weight: drop.weight,
    quantity: drop.quantity,
  }));
  return [
    { name: 'name', label: 'Name', value: crate.name ?? '' },
    { name: 'slug', label: 'Slug', value: crate.slug ?? '' },
    { name: 'priceMinor', label: 'Price', value: crate.priceMinor ?? '' },
    {
      name: 'imageUrl',
      label: 'HTTPS image URL (optional)',
      value: crate.imageUrl ?? '',
      required: false,
    },
    { name: 'enabled', label: 'Published', type: 'checkbox', value: crate.enabled ?? false },
    ...(crate.communityStatus && crate.communityStatus !== 'first_party'
      ? [
          {
            name: 'communityStatus',
            label: 'Community status',
            type: 'select',
            options: ['draft', 'published', 'retired'],
            value: crate.communityStatus,
          },
          {
            name: 'royaltyBps',
            label: 'Creator royalty (bps)',
            type: 'number',
            min: 0,
            max: 200,
            value: crate.royaltyBps ?? 0,
          },
        ]
      : []),
    {
      name: 'description',
      label: 'Description',
      type: 'textarea',
      value: crate.description ?? '',
      wide: true,
    },
    {
      name: 'drops',
      label: 'Drops JSON: catalogItemId, weight, quantity',
      type: 'textarea',
      rows: 9,
      value: prettyJson(drops.length ? drops : [{ catalogItemId: '', weight: 1, quantity: 1 }]),
      wide: true,
    },
    {
      name: 'metadata',
      label: 'Metadata JSON',
      type: 'textarea',
      value: prettyJson(crate.metadata),
      wide: true,
    },
    { name: 'reason', label: 'Audit reason', wide: true },
  ];
}

async function editCase(crate = null) {
  const values = await editRecord({
    title: crate ? `Edit ${crate.name}` : 'Create case',
    description: 'The server rejects pools outside the configured house-edge range.',
    fields: caseFields(crate ?? {}),
    submitLabel: crate ? 'Save case' : 'Create case',
  });
  if (!values) return;
  try {
    const payload = {
      slug: values.slug,
      name: values.name,
      description: values.description,
      imageUrl: values.imageUrl || null,
      priceMinor: parseAmount(values.priceMinor)?.toString() ?? values.priceMinor,
      enabled: values.enabled,
      metadata: jsonField(values.metadata, 'Metadata'),
      drops: jsonField(values.drops, 'Drops'),
      reason: values.reason,
      ...(values.communityStatus
        ? {
            communityStatus: values.communityStatus,
            royaltyBps: Number(values.royaltyBps),
          }
        : {}),
    };
    if (crate) await api.patch(`/v1/admin/cases/${crate.id}`, payload);
    else await api.post('/v1/admin/cases', payload);
    toast(crate ? 'Case updated.' : 'Case created.');
    await loadCases();
  } catch (error) {
    toast(`${error.code}: ${error.message}`, 'bad');
  }
}

async function loadModeration() {
  const data = await api.get('/v1/admin/moderation');
  table(
    $('messageTable'),
    ['When', 'Player', 'Message', 'Status', ''],
    data.messages ?? [],
    (message) => {
      const tr = document.createElement('tr');
      tr.append(cell(message.created_at), cell(message.minecraft_username));
      const body = cell(message.body);
      body.className = 'wrap';
      tr.append(body);
      const status = document.createElement('td');
      status.append(
        pill(
          message.deleted_at ? `deleted by ${message.deleted_by_username ?? 'admin'}` : 'visible',
          message.deleted_at ? 'warn' : 'ok',
        ),
      );
      tr.append(
        status,
        actions(
          ...(message.deleted_at
            ? []
            : [
                button(
                  'Delete',
                  async (node) => {
                    const reason = await confirmAction(
                      `Remove this message from ${message.minecraft_username}? The row is retained.`,
                    );
                    if (!reason) return;
                    node.disabled = true;
                    await api.delete(`/v1/chat/${message.id}`, { reason });
                    toast('Message removed.');
                    await loadModeration();
                  },
                  { danger: true },
                ),
              ]),
        ),
      );
      return tr;
    },
  );
  table(
    $('timeoutTable'),
    ['Issued', 'Player', 'Until', 'Reason', 'Issued by', 'Status', ''],
    data.timeouts ?? [],
    (timeout) => {
      const active = !timeout.lifted_at && new Date(timeout.expires_at) > new Date();
      const tr = document.createElement('tr');
      tr.append(
        cell(timeout.created_at),
        cell(timeout.minecraft_username),
        cell(timeout.expires_at),
        cell(timeout.reason),
        cell(timeout.issued_by_username),
      );
      const status = document.createElement('td');
      status.append(
        pill(active ? 'active' : timeout.lifted_at ? 'lifted' : 'expired', active ? 'bad' : 'ok'),
      );
      tr.append(
        status,
        actions(
          ...(active
            ? [
                button('Lift', async () => {
                  const reason = await confirmAction(
                    `Lift ${timeout.minecraft_username}'s chat timeout?`,
                  );
                  if (!reason) return;
                  await api.delete(
                    `/v1/chat/timeouts/${encodeURIComponent(timeout.minecraft_username)}`,
                    { reason },
                  );
                  toast('Timeout lifted.');
                  await loadModeration();
                }),
              ]
            : []),
        ),
      );
      return tr;
    },
  );
}

async function clearChat() {
  const reason = await confirmAction(
    'Clear the shared chat for everyone? Player messages remain in moderation history, but all current messages and older game cards will disappear from chat.',
  );
  if (!reason) return;
  const button = $('clearChat');
  button.disabled = true;
  try {
    const result = await api.post('/v1/admin/chat/clear', { reason });
    toast(`Chat cleared. ${result.cleared} player message(s) removed.`);
    await loadModeration();
  } catch (error) {
    toast(`${error.code}: ${error.message}`, 'bad');
  } finally {
    button.disabled = false;
  }
}

async function issueTimeout() {
  const values = await editRecord({
    title: 'Timeout a player',
    description: 'Chat only. Account access and games are not affected.',
    fields: [
      { name: 'username', label: 'Minecraft username' },
      { name: 'minutes', label: 'Minutes (1-1440)', type: 'number', min: 1, max: 1440 },
      { name: 'reason', label: 'Reason', wide: true },
    ],
    submitLabel: 'Issue timeout',
  });
  if (!values) return;
  try {
    await api.post('/v1/chat/timeouts', {
      username: values.username,
      minutes: Number(values.minutes),
      reason: values.reason,
    });
    toast('Chat timeout issued.');
    await loadModeration();
  } catch (error) {
    toast(`${error.code}: ${error.message}`, 'bad');
  }
}

async function liftTimeoutByName() {
  const values = await editRecord({
    title: 'Lift chat timeout',
    fields: [
      { name: 'username', label: 'Minecraft username' },
      { name: 'reason', label: 'Audit reason', wide: true },
    ],
    submitLabel: 'Lift timeout',
  });
  if (!values) return;
  try {
    const result = await api.delete(`/v1/chat/timeouts/${encodeURIComponent(values.username)}`, {
      reason: values.reason,
    });
    toast(`${result.lifted} timeout(s) lifted.`);
    await loadModeration();
  } catch (error) {
    toast(`${error.code}: ${error.message}`, 'bad');
  }
}

async function loadPrograms() {
  const [rain, creators, races, quests] = await Promise.all([
    api.get('/v1/social/rain').catch((error) => ({ unavailable: error.message })),
    api.get('/v1/admin/creator-applications'),
    api.get('/v1/admin/races'),
    api.get('/v1/admin/quests'),
  ]);
  renderStats(
    $('rainStats'),
    rain.unavailable
      ? [
          ['Status', 'Disabled'],
          ['Details', rain.unavailable],
        ]
      : rain.active
        ? [
            ['Status', 'Live'],
            ['Pool', amountText(rain.active.poolMinor)],
            ['Claimants', rain.active.claimants],
            ['Closes', new Date(rain.active.closesAt).toLocaleString()],
          ]
        : [
            ['Status', 'Idle'],
            ['Recent events', rain.recent?.length ?? 0],
          ],
  );
  table(
    $('creatorTable'),
    ['Applied', 'Player', 'Platform', 'Audience', 'Requested code', 'Status', 'Revshare', ''],
    creators.applications ?? [],
    (application) => {
      const tr = document.createElement('tr');
      tr.append(
        cell(application.created_at),
        cell(application.minecraft_username),
        cell(application.platform),
        cell(application.audience_size, { mono: true }),
        cell(application.requested_code, { mono: true }),
      );
      const status = document.createElement('td');
      status.append(
        pill(
          application.status,
          application.status === 'approved'
            ? 'ok'
            : application.status === 'pending'
              ? 'warn'
              : 'bad',
        ),
      );
      tr.append(
        status,
        cell(
          application.granted_revshare_bps === null
            ? null
            : `${application.granted_revshare_bps} bps`,
        ),
      );
      tr.append(
        actions(
          ...(application.status === 'pending'
            ? [
                button('Review', () => reviewCreator(application, creators.maxRevshareBps)),
                button('Open channel', () =>
                  window.open(application.channel_url, '_blank', 'noopener,noreferrer'),
                ),
              ]
            : []),
        ),
      );
      return tr;
    },
  );
  table(
    $('raceTable'),
    ['Starts', 'Ends', 'Name', 'Cadence', 'Prize pool', 'Entrants', 'Wagered', 'Status', ''],
    races.races ?? [],
    (race) => {
      const now = Date.now();
      const state = race.settled_at
        ? 'settled'
        : new Date(race.ends_at).getTime() <= now
          ? 'due'
          : new Date(race.starts_at).getTime() <= now
            ? 'live'
            : 'scheduled';
      const tr = document.createElement('tr');
      tr.append(
        cell(race.starts_at),
        cell(race.ends_at),
        cell(race.name),
        cell(race.cadence),
        cell(amountText(race.prize_pool_minor), { mono: true }),
        cell(race.entrants, { mono: true }),
        cell(amountText(race.wagered_minor), { mono: true }),
      );
      const status = document.createElement('td');
      status.append(pill(state, state === 'live' ? 'ok' : state === 'due' ? 'bad' : 'warn'));
      tr.append(
        status,
        actions(...(state === 'scheduled' ? [button('Edit', () => editRace(race))] : [])),
      );
      return tr;
    },
  );
  table(
    $('questTable'),
    ['Order', 'Quest', 'Metric', 'Target', 'Reward', 'Players today', 'Claims today', 'Status', ''],
    quests.quests ?? [],
    (quest) => {
      const tr = document.createElement('tr');
      tr.append(
        cell(quest.sort_order, { mono: true }),
        cell(quest.name),
        cell(quest.metric),
        cell(quest.target_value, { mono: true }),
        cell(amountText(quest.reward_minor), { mono: true }),
        cell(quest.players_today, { mono: true }),
        cell(quest.claims_today, { mono: true }),
      );
      const status = document.createElement('td');
      status.append(pill(quest.enabled ? 'enabled' : 'disabled', quest.enabled ? 'ok' : 'warn'));
      tr.append(status, actions(button('Edit', () => editQuest(quest))));
      return tr;
    },
  );
}

async function startRain() {
  const values = await editRecord({
    title: 'Start Lava Rain',
    description:
      'This spends the operator-funded pool. The server enforces the configured maximum.',
    fields: [
      { name: 'poolMinor', label: 'Pool amount', value: '' },
      { name: 'claimMinutes', label: 'Claim window (minutes)', type: 'number', value: 5 },
      { name: 'reason', label: 'Audit reason', wide: true },
    ],
    submitLabel: 'Start promotion',
  });
  if (!values) return;
  try {
    const result = await api.post('/v1/social/rain', {
      poolMinor: values.poolMinor,
      claimMinutes: Number(values.claimMinutes),
      reason: values.reason,
    });
    toast(`Lava Rain started with a ${amountText(result.poolMinor)} pool.`);
    await loadPrograms();
  } catch (error) {
    toast(`${error.code}: ${error.message}`, 'bad');
  }
}

async function reviewCreator(application, maxBps) {
  /* Applications filed before the 6-character minimum can carry a 3 to 5 character code, which
   * cannot be approved as it stands. Said up front rather than discovered on submit. */
  const shortCode = !/^[A-Z0-9]{6,16}$/.test(application.requested_code ?? '');
  const values = await editRecord({
    title: `Review ${application.minecraft_username}`,
    description:
      `${application.platform}: ${application.channel_url}. Maximum ${maxBps} bps.` +
      (shortCode
        ? ` The requested code is under 6 characters: enter a 6-16 character code to approve.`
        : ''),
    fields: [
      { name: 'decision', label: 'Decision', type: 'select', options: ['approved', 'rejected'] },
      { name: 'code', label: 'Creator code', value: application.requested_code },
      {
        name: 'revshareBps',
        label: 'Revshare bps',
        type: 'number',
        min: 0,
        max: maxBps,
        value: maxBps,
      },
      { name: 'note', label: 'Review note / audit reason', type: 'textarea', wide: true },
    ],
    submitLabel: 'Record decision',
  });
  if (!values) return;
  try {
    await api.post(`/v1/admin/creator-applications/${application.id}/decision`, {
      decision: values.decision,
      ...(values.decision === 'approved'
        ? { code: values.code.toUpperCase(), revshareBps: Number(values.revshareBps) }
        : {}),
      note: values.note,
    });
    toast(`Creator application ${values.decision}.`);
    await loadPrograms();
  } catch (error) {
    toast(`${error.code}: ${error.message}`, 'bad');
  }
}

function localDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

async function editRace(race = null) {
  const values = await editRecord({
    title: race ? `Edit ${race.name}` : 'Create wager race',
    description: 'Payout curve is basis points by rank and may total no more than 10000.',
    fields: [
      { name: 'name', label: 'Name', value: race?.name ?? '' },
      { name: 'slug', label: 'Slug', value: race?.slug ?? '' },
      {
        name: 'cadence',
        label: 'Cadence',
        type: 'select',
        options: ['daily', 'weekly'],
        value: race?.cadence ?? 'daily',
      },
      { name: 'prizePoolMinor', label: 'Prize pool', value: race?.prize_pool_minor ?? '' },
      {
        name: 'startsAt',
        label: 'Starts',
        type: 'datetime-local',
        value: localDateTime(race?.starts_at),
      },
      {
        name: 'endsAt',
        label: 'Ends',
        type: 'datetime-local',
        value: localDateTime(race?.ends_at),
      },
      {
        name: 'payoutCurveBps',
        label: 'Payout curve JSON',
        type: 'textarea',
        value: prettyJson(race?.payout_curve ?? [5000, 3000, 2000]),
        wide: true,
      },
      { name: 'reason', label: 'Audit reason', wide: true },
    ],
    submitLabel: race ? 'Save race' : 'Create race',
  });
  if (!values) return;
  try {
    const payload = {
      name: values.name,
      slug: values.slug,
      cadence: values.cadence,
      prizePoolMinor: parseAmount(values.prizePoolMinor)?.toString() ?? values.prizePoolMinor,
      startsAt: new Date(values.startsAt).toISOString(),
      endsAt: new Date(values.endsAt).toISOString(),
      payoutCurveBps: jsonField(values.payoutCurveBps, 'Payout curve'),
      reason: values.reason,
    };
    if (race) await api.patch(`/v1/admin/races/${race.id}`, payload);
    else await api.post('/v1/admin/races', payload);
    toast(race ? 'Race updated.' : 'Race created.');
    await loadPrograms();
  } catch (error) {
    toast(`${error.code}: ${error.message}`, 'bad');
  }
}

async function settleRaces() {
  const reason = await confirmAction('Settle every ended race that has not yet paid its winners?');
  if (!reason) return;
  try {
    const result = await api.post('/v1/admin/races/settle', { reason });
    toast(`${result.settled} race(s) settled; ${result.paid} winner(s) paid.`);
    await loadPrograms();
  } catch (error) {
    toast(`${error.code}: ${error.message}`, 'bad');
  }
}

async function editQuest(quest = null) {
  const metrics = [
    'upgrader_rolls',
    'upgrader_wins',
    'cases_opened',
    'wagered_minor',
    'faction_contribution_minor',
    ...(quest?.metric === 'piggy_deposits' ? ['piggy_deposits'] : []),
  ];
  const values = await editRecord({
    title: quest ? `Edit ${quest.name}` : 'Create daily quest',
    fields: [
      ...(quest ? [] : [{ name: 'code', label: 'Stable code' }]),
      { name: 'name', label: 'Name', value: quest?.name ?? '' },
      {
        name: 'metric',
        label: 'Metric',
        type: 'select',
        options: metrics,
        value: quest?.metric ?? metrics[0],
      },
      { name: 'targetValue', label: 'Target', value: quest?.target_value ?? '' },
      { name: 'rewardMinor', label: 'Reward', value: quest?.reward_minor ?? '' },
      { name: 'sortOrder', label: 'Sort order', type: 'number', value: quest?.sort_order ?? 0 },
      { name: 'enabled', label: 'Enabled', type: 'checkbox', value: quest?.enabled ?? false },
      {
        name: 'description',
        label: 'Description',
        type: 'textarea',
        value: quest?.description ?? '',
        wide: true,
      },
      { name: 'reason', label: 'Audit reason', wide: true },
    ],
    submitLabel: quest ? 'Save quest' : 'Create quest',
  });
  if (!values) return;
  try {
    const payload = {
      name: values.name,
      description: values.description,
      metric: values.metric,
      targetValue: parseAmount(values.targetValue)?.toString() ?? values.targetValue,
      rewardMinor: parseAmount(values.rewardMinor)?.toString() ?? values.rewardMinor,
      sortOrder: Number(values.sortOrder),
      enabled: values.enabled,
      reason: values.reason,
    };
    if (quest) await api.patch(`/v1/admin/quests/${encodeURIComponent(quest.code)}`, payload);
    else await api.post('/v1/admin/quests', { code: values.code, ...payload });
    toast(quest ? 'Quest updated.' : 'Quest created.');
    await loadPrograms();
  } catch (error) {
    toast(`${error.code}: ${error.message}`, 'bad');
  }
}

async function loadAudit() {
  const search = $('auditQuery').value.trim();
  const data = await api.get(
    `/v1/admin/audit?limit=200${search ? `&search=${encodeURIComponent(search)}` : ''}`,
  );
  table(
    $('auditTable'),
    ['When', 'Actor', 'Action', 'Target type', 'Target', 'Details', 'Hash'],
    data.entries ?? [],
    (entry) => {
      const tr = document.createElement('tr');
      tr.append(
        cell(entry.created_at),
        cell(entry.actor_username ?? 'system'),
        cell(entry.action),
        cell(entry.target_type),
        cell(entry.target_id, { mono: true }),
      );
      const details = cell(prettyJson(entry.details));
      details.className = 'wrap mono';
      tr.append(details, cell(entry.entry_hash, { mono: true }));
      return tr;
    },
  );
}

let rouletteAdminState = null;

async function loadRoulette() {
  const data = await api.get('/v1/admin/roulette');
  rouletteAdminState = data;
  const round = data.round;
  renderStats($('rouletteStats'), [
    ['State', data.paused ? 'Paused after round' : round ? 'Running' : 'Starting'],
    ['Round', round?.id ?? '—'],
    ['Closes', round ? new Date(round.closesAt).toLocaleString() : '—'],
    ['Chips', data.bets?.length ?? 0],
    ['Total stake', amountText(data.totalStakeMinor ?? 0)],
    ['Maximum payout exposure', amountText(data.maximumPayoutMinor ?? 0)],
  ]);
  const pause = $('toggleRoulettePause');
  pause.textContent = data.paused ? 'Resume table' : 'Pause after round';
  pause.classList.toggle('btn--danger', !data.paused);

  table(
    $('rouletteBetTable'),
    ['Player', 'Selection', 'Stake', 'Return', 'Placed'],
    data.bets ?? [],
    (bet) => {
      const tr = document.createElement('tr');
      tr.append(
        cell(bet.player),
        cell(bet.selection, { mono: true }),
        cell(amountText(bet.stakeMinor), { mono: true }),
        cell(bet.payoutMinor === null ? 'pending' : amountText(bet.payoutMinor), { mono: true }),
        cell(bet.createdAt),
      );
      return tr;
    },
  );
  table(
    $('rouletteHistoryTable'),
    ['Closed', 'Result', 'Bets', 'Staked', 'Paid', 'Commitment', 'Seed / digest'],
    data.history ?? [],
    (entry) => {
      const tr = document.createElement('tr');
      tr.append(
        cell(entry.closesAt),
        cell(`${entry.result} ${entry.color}`, { mono: true }),
        cell(entry.betCount, { mono: true }),
        cell(amountText(entry.totalStakedMinor), { mono: true }),
        cell(amountText(entry.totalPayoutMinor), { mono: true }),
        cell(entry.serverSeedHash, { mono: true }),
        cell(`${entry.serverSeed ?? '—'} / ${entry.rngDigest ?? '—'}`, { mono: true }),
      );
      return tr;
    },
  );
}

async function toggleRoulettePause() {
  const paused = Boolean(rouletteAdminState?.paused);
  const reason = await confirmAction(
    paused
      ? 'Resume Roulette and create the next shared round?'
      : 'Pause Roulette after the current betting window settles? Existing bets will still resolve.',
  );
  if (!reason) return;
  await api.patch('/v1/admin/runtime-settings', {
    settings: { roulettePaused: !paused },
    reason,
  });
  toast(paused ? 'Roulette resumed.' : 'Roulette will pause after this round.');
  await loadRoulette();
}

async function editRuntimeSetting(setting) {
  /* Key and bounds, not just the default. With fifty-nine controls the label alone is not enough
   * to be sure which one is open, and a rejected value after the fact is a worse way to learn a
   * range than being told it up front. */
  const bounds =
    setting.min !== null && setting.max !== null ? ` · allowed ${setting.min}–${setting.max}` : '';
  const values = await editRecord({
    title: setting.label,
    description: `${setting.key} · deployment default: ${setting.defaultValue}${bounds}`,
    fields: [
      {
        name: 'value',
        label: setting.kind === 'bigint' ? 'Value (minor units or 10m shorthand)' : 'Value',
        type: setting.kind === 'boolean' ? 'checkbox' : setting.kind === 'integer' ? 'number' : 'text',
        value: setting.value,
        min: setting.min ?? undefined,
        max: setting.max ?? undefined,
      },
      { name: 'reason', label: 'Audit reason', wide: true },
    ],
    submitLabel: 'Apply immediately',
  });
  if (!values) return;
  let value = values.value;
  if (setting.kind === 'integer') value = Number(value);
  if (setting.kind === 'bigint') {
    const exact = /^(0|[1-9]\d*)$/.test(value) ? BigInt(value) : parseAmount(value);
    if (exact === null) throw new ApiError(0, 'INVALID_AMOUNT', 'Enter a valid non-negative amount');
    value = exact.toString();
  }
  await api.patch('/v1/admin/runtime-settings', {
    settings: { [setting.key]: value },
    reason: values.reason,
  });
  toast(`${setting.label} updated.`);
  await loadSystem();
}

async function resetRuntimeSetting(setting) {
  const reason = await confirmAction(
    `Reset ${setting.label} to its VPS default (${setting.defaultValue})?`,
  );
  if (!reason) return;
  await api.post('/v1/admin/runtime-settings/reset', { keys: [setting.key], reason });
  toast(`${setting.label} reset.`);
  await loadSystem();
}

/* The runtime controls, as last loaded, plus the two filters applied over them. Held here rather
 * than re-fetched on every keystroke: the whole set arrives in one response and filtering it is a
 * string comparison, so a round trip per character would be latency bought for nothing. */
const systemState = { rows: [], group: 'all', query: '' };

const GROUP_LABELS = {
  features: 'Features',
  economy: 'House maths',
  chat: 'Chat',
  rewards: 'Rewards',
  rakeback: 'Rakeback',
  roulette: 'Roulette',
  blackjack: 'Blackjack',
  crash: 'Crash',
  mines: 'Mines',
  plinko: 'Plinko',
  dice: 'Dice',
  discord: 'Discord rewards',
  minesduel: 'Mines Duel',
  payouts: 'Payouts & anti-drain',
  duels: 'Duels',
  coinflip: 'Coinflip',
  jackpot: 'Jackpot',
  rain: 'Lava Rain',
  social: 'Tips & side bets',
  bots: 'Bots & float',
  limits: 'Limits',
};

const groupLabel = (group) => GROUP_LABELS[group] ?? group;

function visibleSettings() {
  const query = systemState.query.trim().toLowerCase();
  return systemState.rows.filter((row) => {
    if (systemState.group !== 'all' && row.group !== systemState.group) return false;
    if (!query) return true;
    /* Key as well as label. An operator arriving from the audit log or from this file has the
     * camelCase key in hand, not the sentence the panel prints. */
    return (
      row.label.toLowerCase().includes(query) ||
      row.key.toLowerCase().includes(query) ||
      groupLabel(row.group).toLowerCase().includes(query)
    );
  });
}

function renderSettingGroups() {
  const host = $('settingGroups');
  if (!host) return;
  const counts = new Map();
  for (const row of systemState.rows) counts.set(row.group, (counts.get(row.group) ?? 0) + 1);
  const entries = [['all', 'All', systemState.rows.length], ...[...counts].map(
    ([group, count]) => [group, groupLabel(group), count],
  )];
  host.replaceChildren();
  for (const [group, label, count] of entries) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    // aria-pressed, not a class alone: the selected filter has to reach a screen reader too.
    chip.setAttribute('aria-pressed', String(systemState.group === group));
    chip.textContent = label;
    const n = document.createElement('span');
    n.className = 'chip__n';
    n.textContent = String(count);
    chip.append(n);
    chip.addEventListener('click', () => {
      systemState.group = group;
      renderSettingGroups();
      renderSettingRows();
    });
    host.append(chip);
  }
}

function renderSettingRows() {
  const rows = visibleSettings();
  const count = $('settingCount');
  if (count) {
    const total = systemState.rows.length;
    count.textContent =
      rows.length === total
        ? `${total} controls`
        : `${rows.length} of ${total} controls`;
  }
  let lastGroup = null;
  table(
    $('systemTable'),
    ['Setting', 'Current value', 'Source', 'Last changed', 'Actions'],
    rows,
    (row) => {
      const tr = document.createElement('tr');
      tr.append(
        cell(row.label),
        cell(row.value, { mono: true }),
        cell(row.overridden ? 'Admin override' : 'VPS default'),
        cell(row.overridden ? row.updatedAt : null),
        actions(
          button('Edit', () => editRuntimeSetting(row)),
          button('Reset', () => resetRuntimeSetting(row), {
            disabled: !row.overridden,
            title: row.overridden ? '' : 'Already on the deployment default',
          }),
        ),
      );
      if (row.group === lastGroup) return tr;
      /* A separator row rather than a repeated group column: the group changes eleven times in a
       * list of fifty-nine, so printing it on every line is fifty-nine cells to say eleven things. */
      lastGroup = row.group;
      const fragment = document.createDocumentFragment();
      const head = document.createElement('tr');
      head.className = 'groupsep';
      const td = document.createElement('td');
      td.colSpan = 5;
      td.textContent = groupLabel(row.group);
      head.append(td);
      fragment.append(head, tr);
      return fragment;
    },
  );
}

/* The referral view's own filters, held between renders so paging or switching tabs does not
 * silently reset what an operator was looking at. */
const referralState = { search: '', state: 'all', bound: false };

const REFERRAL_FILTERS = [
  ['All', 'all'],
  ['Earning', 'live'],
  ['Voided', 'voided'],
  ['Bonus paid', 'unlocked'],
  ['Bonus pending', 'pending'],
];

async function loadReferrals() {
  const params = new URLSearchParams({ state: referralState.state, limit: '100' });
  if (referralState.search.trim()) params.set('search', referralState.search.trim());
  const data = await api.get(`/v1/admin/referrals?${params.toString()}`);
  const rows = data.referrals ?? [];
  const totals = data.totals ?? {};
  const programme = data.programme ?? {};

  const note = $('referralNote');
  if (note) {
    note.textContent = programme.enabled
      ? `Paying ${(Number(programme.revshareBps ?? 0) / 100).toFixed(2)}% of margin, plus ` +
        `${compactAmount(programme.bonusMinor ?? '0')} once a referee wagers ` +
        `${compactAmount(programme.bonusWagerMinor ?? '0')}.`
      : 'The referral programme is switched off. Nothing is accruing.';
  }

  /* Totals over the whole programme rather than the page, so they do not move when somebody
   * searches. Claimable excludes voided referrals, because that is money nobody can collect. */
  renderStats($('referralStats'), [
    ['Referrals', totals.referrals ?? '0'],
    ['Referrers', totals.referrers ?? '0'],
    ['Voided', totals.voided ?? '0', Number(totals.voided ?? 0) > 0],
    ['Wagered by referees', compactAmount(totals.wagered_minor ?? '0')],
    ['Revenue share paid', compactAmount(totals.revshare_paid_minor ?? '0')],
    ['Waiting to be claimed', compactAmount(totals.revshare_claimable_minor ?? '0')],
    ['Bonuses paid', compactAmount(totals.bonus_paid_minor ?? '0')],
  ]);

  const filter = $('referralFilter');
  if (filter) {
    filter.replaceChildren();
    for (const [label, value] of REFERRAL_FILTERS) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.setAttribute('aria-pressed', String(referralState.state === value));
      chip.textContent = label;
      chip.addEventListener('click', () => {
        referralState.state = value;
        void loadReferrals();
      });
      filter.append(chip);
    }
  }

  const query = $('referralQuery');
  if (query && !referralState.bound) {
    referralState.bound = true;
    query.value = referralState.search;
    /* Debounced, unlike the settings filter: this one goes to the server, and a request per
     * keystroke would be a query per character against a table that grows with the platform. */
    let timer = 0;
    query.addEventListener('input', () => {
      referralState.search = query.value;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void loadReferrals(), 250);
    });
  }

  const count = $('referralCount');
  if (count) {
    count.textContent = rows.length
      ? `${rows.length} shown of ${totals.referrals ?? rows.length}`
      : 'No referrals match';
  }

  table(
    $('referralTable'),
    ['Referee', 'Referrer', 'Code', 'Wagered', 'Claimable', 'Paid', 'Bonus', 'State', 'Actions'],
    rows,
    (row) => {
      const tr = document.createElement('tr');
      const bonus = document.createElement('td');
      bonus.append(
        row.bonus_unlocked_at
          ? pill(compactAmount(row.bonus_paid_minor ?? '0'), 'ok')
          : pill('pending', null),
      );
      const state = document.createElement('td');
      state.append(row.voided_at ? pill('VOIDED', 'bad') : pill('earning', 'ok'));
      if (row.voided_at) {
        /* The reason travels with the badge. A voided relationship that cannot say why is a
         * decision nobody can review, and this is the record somebody will read months later. */
        state.title = `${row.void_reason || 'no reason recorded'}${
          row.voided_by_username ? ` — ${row.voided_by_username}` : ''
        }`;
      }
      tr.append(
        cell(row.referee_username),
        cell(row.referrer_username),
        cell(row.code, { mono: true }),
        cell(compactAmount(row.wagered_minor), { mono: true }),
        cell(compactAmount(row.revshare_claimable_minor), { mono: true }),
        cell(compactAmount(row.revshare_paid_minor), { mono: true }),
        bonus,
        state,
        actions(
          button(row.voided_at ? 'Restore' : 'Void', () => voidReferral(row), {
            danger: !row.voided_at,
          }),
          button('Code', () => renameReferralCode(row)),
        ),
      );
      return tr;
    },
  );
}

/**
 * Stops a referral earning, or starts it again.
 *
 * The confirmation names the figure being forfeited, because that is the part an operator cannot
 * work out from the row they are looking at: voiding does not only stop future accrual, it makes
 * whatever has already banked unclaimable.
 */
async function voidReferral(row) {
  const voiding = !row.voided_at;
  const claimable = compactAmount(row.revshare_claimable_minor ?? '0');
  const reason = await confirmAction(
    voiding
      ? `Void ${row.referee_username}'s referral by ${row.referrer_username}? It stops earning ` +
          `and ${claimable} of unclaimed revenue share becomes unclaimable. Nothing already ` +
          'paid out is reversed.'
      : `Restore ${row.referee_username}'s referral by ${row.referrer_username}? It starts ` +
          `earning again and ${claimable} becomes claimable once more.`,
  );
  if (!reason) return;
  await api.patch(`/v1/admin/referrals/${row.referee_id}/void`, { voided: voiding, reason });
  toast(voiding ? 'Referral voided.' : 'Referral restored.');
  await loadReferrals();
}

/**
 * Changes a referrer's invite code.
 *
 * For the ones that turn out to be slurs, impersonations or somebody else's brand. Every
 * relationship already formed under the old code follows it, because the foreign key cascades.
 */
async function renameReferralCode(row) {
  const values = await editRecord({
    title: `Code for ${row.referrer_username}`,
    description:
      `Currently ${row.code}. Six to sixteen letters and digits. Referrals already formed under ` +
      'the old code follow it automatically.',
    fields: [
      { name: 'code', label: 'New code', value: row.code },
      { name: 'reason', label: 'Audit reason', wide: true },
    ],
    submitLabel: 'Change the code',
  });
  if (!values) return;
  const result = await api.patch(`/v1/admin/referral-codes/${row.referrer_id}`, {
    code: values.code,
    reason: values.reason,
  });
  toast(result.changed ? `Code is now ${result.code}.` : 'That was already the code.');
  await loadReferrals();
}

async function loadSystem() {
  const data = await api.get('/v1/admin/system-config');
  $('systemNote').textContent = data.note;
  systemState.rows = data.runtimeSettings ?? [];
  const query = $('settingQuery');
  if (query && !query.dataset.bound) {
    query.dataset.bound = '1';
    /* Filters on input rather than on submit. The set is already in memory, so waiting for Enter
     * buys nothing and costs the operator a keystroke per search. */
    query.addEventListener('input', () => {
      systemState.query = query.value;
      renderSettingRows();
    });
  }
  renderSettingGroups();
  renderSettingRows();
  table(
    $('staffTable'),
    ['Account', 'Kind', 'Discord operator', 'Mints links', 'Linked Discord', 'Last sign-in'],
    data.staff ?? [],
    (row) => {
      const tr = document.createElement('tr');
      const who = cell(row.username ?? row.identity, { mono: !row.username });
      if (row.username) who.title = row.identity;
      const mints = document.createElement('td');
      mints.append(pill(row.canMintLinks ? 'yes' : 'no', row.canMintLinks ? 'ok' : undefined));
      tr.append(
        who,
        cell(row.kind),
        cell(row.discordOperatorIds?.join(', ') || '', { mono: true }),
        mints,
        cell(row.linkedDiscordId ?? '', { mono: true }),
        cell(row.lastLoginAt),
      );
      return tr;
    },
  );
  const protectedRows = Object.entries(data.config ?? {}).map(([key, value]) => ({ key, value }));
  table($('protectedSystemTable'), ['Setting', 'Current value', 'Management'], protectedRows, (row) => {
    const tr = document.createElement('tr');
    tr.append(
      cell(row.key, { mono: true }),
      cell(row.value, { mono: true }),
      cell('VPS environment + controlled restart'),
    );
    return tr;
  });
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
    'Publish the upgrader prize ladder: 51 fixed denominations from $100K to $10B. ' +
      'Prices already correct are left alone, but every rung is re-enabled — ' +
      'including any you switched off by hand.',
  );
  if (!reason) return;
  const button = $('publishLadder');
  button.disabled = true;
  try {
    const result = await api.post('/v1/admin/catalog-ladder', { reason });
    toast(
      result.created +
        ' created, ' +
        result.repriced +
        ' repriced, ' +
        result.unchanged +
        ' already at the right price.',
    );
    await show('catalog');
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

/* ═════════════════════════ payout queue ═════════════════════════
 *
 * The anti-drain console. Everything here is a view of /v1/admin/payout-queue and a handful of
 * writes, each with a reason that lands in the audit log. A hold never takes money from a player:
 * the wallet was debited when they asked, and a hold only decides whether the bot is told to send
 * it yet. */

const payoutState = { window: '24h' };
const WINDOWS = [
  ['24h', '24 hours'],
  ['7d', '7 days'],
  ['30d', '30 days'],
  ['all', 'All time'],
];

function ageText(at) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(at).getTime()) / 1000));
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

const signedAmount = (minor) => {
  const value = BigInt(minor ?? 0);
  return (value > 0n ? '+' : '') + compactAmount(value);
};

async function setRuntimeSwitch(key, value, message) {
  const reason = await confirmAction(message);
  if (!reason) return;
  await api.patch('/v1/admin/runtime-settings', { settings: { [key]: value }, reason });
  toast('Applied immediately.');
  await loadPayoutQueue();
}

function renderPayControls(data) {
  const host = $('payControls');
  host.replaceChildren();
  const settings = data.settings;

  const state = document.createElement('p');
  state.className = 'payctl__state';
  state.dataset.hold = settings.holdAll ? '1' : '0';
  state.textContent = settings.holdAll
    ? 'ALL PAYOUTS ARE ON HOLD. Every withdrawal waits here for a human.'
    : settings.antiDrainEnabled
      ? 'Payouts are live. Anti-drain rules are on: a request that trips one waits here for a human.'
      : 'Payouts are live and the anti-drain rules are OFF.';

  const rules = document.createElement('p');
  rules.className = 'payctl__rules faint';
  const off = (value) => (BigInt(value) === 0n ? 'off' : compactAmount(value));
  rules.textContent =
    `One request over ${BigInt(settings.approvalThresholdMinor) === 0n ? 'any amount' : compactAmount(settings.approvalThresholdMinor)} · ` +
    `net cash-out per player ${off(settings.netCashoutMinor)} · house net outflow per hour ${off(settings.houseHourlyMinor)} · ` +
    `player winnings ${off(settings.win1hMinor)} in 1h / ${off(settings.win24hMinor)} in 24h earn a hold. ` +
    'Change them in System → Payouts & anti-drain.';

  const buttons = document.createElement('div');
  buttons.className = 'rowacts';
  buttons.append(
    button(
      settings.holdAll ? 'Resume automatic payouts' : 'HOLD ALL PAYOUTS',
      () =>
        setRuntimeSwitch(
          'cashPayoutsHold',
          !settings.holdAll,
          settings.holdAll
            ? 'Resume sending payouts to the bot automatically? Requests already waiting here stay here until you approve them.'
            : 'Hold ALL payouts? Every new withdrawal will wait here for a human. Players keep their balance and can keep playing.',
        ),
      { danger: !settings.holdAll },
    ),
    button(
      'Pull queued payouts back to review',
      async (node) => {
        const reason = await confirmAction(
          'Pull every payout that has not reached the bot yet back into this queue? Payouts the bot is already sending are not touched.',
        );
        if (!reason) return;
        node.disabled = true;
        const result = await api.post('/v1/admin/cash-withdrawals/hold-queued', { reason });
        toast(`Pulled back ${result.held}; ${result.skipped} could not be (already with the bot or vault-funded).`);
        await loadPayoutQueue();
      },
      { danger: true },
    ),
    button(
      settings.battlesEnabled ? 'Turn case battles OFF' : 'Turn case battles ON',
      () =>
        setRuntimeSwitch(
          'battlesEnabled',
          !settings.battlesEnabled,
          settings.battlesEnabled
            ? 'Close case battles? Nobody can host, join or fill with bots, and every open lobby is refunded within seconds.'
            : 'Open case battles again? Only do this once the payout bug is confirmed fixed on this deploy.',
        ),
      { danger: settings.battlesEnabled },
    ),
  );
  host.append(state, rules, buttons);
}

function renderPayStats(data) {
  const by = data.totals.byStatus;
  const part = (...names) => {
    let count = 0;
    let amount = 0n;
    for (const name of names) {
      count += by[name]?.count ?? 0;
      amount += BigInt(by[name]?.amountMinor ?? 0);
    }
    return { count, amount };
  };
  const waiting = part('pending_approval');
  const bot = part('queued', 'awaiting_vault', 'processing');
  const review = part('manual_review');
  const teller = data.bots.find((entry) => entry.role === 'teller');
  const vault = data.bots.find((entry) => entry.role === 'vault');
  renderStats($('payStats'), [
    [
      'Waiting for you',
      `${waiting.count} · ${compactAmount(waiting.amount)}`,
      waiting.count > 0,
      amountText(waiting.amount),
    ],
    [
      'With the bot',
      `${bot.count} · ${compactAmount(bot.amount)}`,
      false,
      amountText(bot.amount),
    ],
    ['Needs checking', `${review.count} · ${compactAmount(review.amount)}`, review.count > 0],
    [
      'Paid, last 24h',
      `${data.totals.paid24h.count} · ${compactAmount(data.totals.paid24h.amountMinor)}`,
      false,
      amountText(data.totals.paid24h.amountMinor),
    ],
    [
      'House net outflow, 1h',
      signedAmount(data.totals.houseNetOutflowHourMinor),
      BigInt(data.settings.houseHourlyMinor) > 0n &&
        BigInt(data.totals.houseNetOutflowHourMinor) >= BigInt(data.settings.houseHourlyMinor),
      'Cash sent out less cash that came in, staff excluded. A request waiting here has not gone anywhere and is not counted.',
    ],
    [
      'Teller · vault hold',
      `${teller ? compactAmount(teller.trackedBalanceMinor) : '—'} · ${vault ? compactAmount(vault.trackedBalanceMinor) : '—'}`,
    ],
  ]);
}

function riskCell(player, settings) {
  const td = document.createElement('td');
  td.className = 'wrap';
  const out = BigInt(player.withdrawnMinor);
  const inn = BigInt(player.depositedMinor);
  const net = out - inn;
  const first = document.createElement('div');
  first.textContent = `balance ${compactAmount(player.balanceMinor)} · in ${compactAmount(inn)} · out ${compactAmount(out)}`;
  const second = document.createElement('div');
  second.textContent = `24h ${signedAmount(player.result24hMinor)} · all time ${signedAmount(player.resultAllMinor)} · net out ${signedAmount(net)}`;
  const hot =
    (BigInt(settings.win24hMinor) > 0n && BigInt(player.result24hMinor) >= BigInt(settings.win24hMinor)) ||
    (BigInt(settings.netCashoutMinor) > 0n && net > BigInt(settings.netCashoutMinor));
  if (hot) second.dataset.alarm = '1';
  td.append(first, second);
  return td;
}

async function holdPlayer(userId, name) {
  const reason = await confirmAction(
    `Hold payouts for ${name}? Their next withdrawal waits for you, and anything they have queued for the bot is pulled back. Their balance and play are untouched.`,
  );
  if (!reason) return;
  const result = await api.post(`/v1/admin/users/${userId}/payout-hold`, { reason });
  toast(`${name} is on hold. Pulled back ${result.pulledBack} queued payout(s).`);
  await loadPayoutQueue();
}

function renderPayQueue(data) {
  table(
    $('payQueueTable'),
    ['Waiting', 'Player', 'Amount', 'State', 'Why', 'Player', ''],
    data.queue,
    (item) => {
      const tr = document.createElement('tr');
      tr.append(cell(ageText(item.createdAt)), cell(item.name));
      const amount = cell(amountText(item.amountMinor), { mono: true });
      amount.title = `Pays ${item.payee} in game`;
      tr.append(amount);
      const state = document.createElement('td');
      const parked = item.job?.held === true;
      state.append(
        pill(
          item.status === 'pending_approval'
            ? parked
              ? 'pulled back'
              : 'needs a decision'
            : item.status === 'queued'
              ? 'with the bot queue'
              : item.status === 'processing'
                ? 'bot is sending'
                : item.status === 'awaiting_vault'
                  ? 'waiting for the vault'
                  : item.status,
          item.status === 'manual_review' ? 'bad' : item.status === 'pending_approval' ? 'warn' : 'ok',
        ),
      );
      tr.append(state);
      const why = document.createElement('td');
      why.className = 'wrap';
      why.textContent = item.reviewReason ?? item.holdReason ?? '—';
      tr.append(why, riskCell(item.player, data.settings));

      const buttons = [];
      if (item.status === 'pending_approval') {
        buttons.push(
          button('Approve', async (node) => {
            const reason = await confirmAction(
              `Approve ${amountText(item.amountMinor)} to ${item.payee}? The bot is told to send it.`,
            );
            if (!reason) return;
            node.disabled = true;
            await api.post(`/v1/admin/cash-withdrawals/${item.id}/approve`, { reason });
            toast('Approved and queued for the bot.');
            await loadPayoutQueue();
          }),
          button(
            'Reject & refund',
            async (node) => {
              const reason = await confirmAction(
                `Reject this payout and return ${amountText(item.amountMinor)} to ${item.name}'s wallet?`,
              );
              if (!reason) return;
              node.disabled = true;
              await api.post(`/v1/admin/cash-withdrawals/${item.id}/reject`, { reason });
              toast('Rejected and refunded.');
              await loadPayoutQueue();
            },
            { danger: true },
          ),
        );
      }
      if (item.status === 'queued' && item.funding !== 'vault' && !parked && item.job?.status === 'queued') {
        buttons.push(
          button(
            'Hold',
            async (node) => {
              const reason = await confirmAction(
                `Pull ${amountText(item.amountMinor)} for ${item.name} back from the bot into review?`,
              );
              if (!reason) return;
              node.disabled = true;
              await api.post(`/v1/admin/cash-withdrawals/${item.id}/hold`, { reason });
              toast('Pulled back for review.');
              await loadPayoutQueue();
            },
            { danger: true },
          ),
        );
      }
      if (item.status === 'manual_review') {
        const note = document.createElement('span');
        note.className = 'faint';
        note.textContent = 'Resolve in the Economy tab';
        buttons.push(note);
      }
      if (!item.holdReason && ['pending_approval', 'queued'].includes(item.status)) {
        buttons.push(button('Hold player', () => holdPlayer(item.userId, item.name)));
      }
      tr.append(actions(...buttons));
      return tr;
    },
  );
}

function renderPayHeld(data) {
  table($('payHeldTable'), ['Player', 'Why', 'Since', 'By', ''], data.held, (row) => {
    const tr = document.createElement('tr');
    const why = document.createElement('td');
    why.className = 'wrap';
    why.textContent = row.reason;
    tr.append(cell(row.name), why, cell(row.at), cell(row.by ?? 'anti-drain monitor'));
    tr.append(
      actions(
        button('Release', async (node) => {
          const reason = await confirmAction(
            `Lift the payout hold on ${row.name}? Withdrawals already waiting stay in the queue until you approve them.`,
          );
          if (!reason) return;
          node.disabled = true;
          await api.post(`/v1/admin/users/${row.userId}/payout-release`, { reason });
          toast(`${row.name} released.`);
          await loadPayoutQueue();
        }),
      ),
    );
    return tr;
  });
}

function renderPayLeaders(data) {
  const chips = $('payWindow');
  chips.replaceChildren();
  for (const [value, label] of WINDOWS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = label;
    chip.setAttribute('aria-pressed', String(payoutState.window === value));
    chip.addEventListener('click', () => {
      payoutState.window = value;
      loadPayoutQueue().catch((error) => toast(`${error.code}: ${error.message}`, 'bad'));
    });
    chips.append(chip);
  }
  table(
    $('payLeaderTable'),
    ['Player', 'Net winnings', 'Balance', 'Status', ''],
    data.leaders,
    (row) => {
      const tr = document.createElement('tr');
      const net = cell(signedAmount(row.netMinor), { mono: true });
      net.title = amountText(row.netMinor);
      tr.append(cell(row.name), net, cell(compactAmount(row.balanceMinor), { mono: true }));
      const status = document.createElement('td');
      status.append(
        row.holdReason
          ? pill('payout hold', 'warn')
          : row.status === 'active'
            ? pill('active', 'ok')
            : pill(row.status, 'bad'),
      );
      tr.append(
        status,
        actions(...(row.holdReason ? [] : [button('Hold player', () => holdPlayer(row.userId, row.name))])),
      );
      return tr;
    },
  );
}

function renderPayRecent(data) {
  table($('payRecentTable'), ['When', 'Player', 'Amount', 'Result'], data.recent, (row) => {
    const tr = document.createElement('tr');
    tr.append(cell(row.at), cell(row.name), cell(amountText(row.amountMinor), { mono: true }));
    const result = document.createElement('td');
    result.append(
      pill(
        row.errorCode && row.status !== 'paid' ? `${row.status} · ${row.errorCode}` : row.status,
        row.status === 'paid' ? 'ok' : row.status === 'rejected' ? 'warn' : 'bad',
      ),
    );
    tr.append(result);
    return tr;
  });
}

async function loadPayoutQueue() {
  const data = await api.get(`/v1/admin/payout-queue?window=${payoutState.window}`);
  renderPayControls(data);
  renderPayStats(data);
  renderPayQueue(data);
  renderPayHeld(data);
  renderPayLeaders(data);
  renderPayRecent(data);
}

const LOADERS = {
  payouts: loadPayoutQueue,
  overview: loadOverview,
  players: () => loadPlayers($('playerQuery').value.trim()),
  economy: loadEconomy,
  roulette: loadRoulette,
  catalog: loadCatalog,
  cases: loadCases,
  /* The payout log is the receipt for the Pay button above it, so it is never stale relative to
     the table it belongs to. */
  bots: async () => {
    await loadBots();
    await loadPayouts();
    // Loaded after the bots, because the ledger's filter chips are named from that list.
    await loadBotLedger();
  },
  jobs: loadJobs,
  moderation: loadModeration,
  programs: loadPrograms,
  referrals: loadReferrals,
  audit: loadAudit,
  system: loadSystem,
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
  $('toggleRoulettePause').addEventListener('click', () => void toggleRoulettePause());
  $('createCatalogItem').addEventListener('click', () => void createCatalogItem());
  $('createCase').addEventListener('click', () => void editCase());
  $('timeoutPlayer').addEventListener('click', () => void issueTimeout());
  $('liftTimeout').addEventListener('click', () => void liftTimeoutByName());
  $('clearChat').addEventListener('click', () => void clearChat());
  $('createRace').addEventListener('click', () => void editRace());
  $('settleRaces').addEventListener('click', () => void settleRaces());
  $('startRain').addEventListener('click', () => void startRain());
  $('createQuest').addEventListener('click', () => void editQuest());
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
  $('economySearch').addEventListener('submit', (event) => {
    event.preventDefault();
    void show('economy');
  });
  $('auditSearch').addEventListener('submit', (event) => {
    event.preventDefault();
    void show('audit');
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
