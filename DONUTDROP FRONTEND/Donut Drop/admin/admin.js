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

async function request(method, path, body) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
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
  post: (path, body) => request('POST', path, body),
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
    ['Username', 'Status', 'KYC', 'Role', 'Joined', 'ID'],
    data.users ?? [],
    (user) => {
      const tr = document.createElement('tr');
      tr.append(cell(user.minecraft_username));
      const status = document.createElement('td');
      status.append(
        pill(
          user.status,
          user.status === 'active' ? 'ok' : user.status === 'suspended' ? 'bad' : 'warn',
        ),
      );
      tr.append(status);
      const kyc = document.createElement('td');
      kyc.append(pill(user.kyc_status, user.kyc_status === 'verified' ? 'ok' : 'warn'));
      tr.append(kyc, cell(user.role), cell(user.created_at), cell(user.id, { mono: true }));
      return tr;
    },
  );
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

const LOADERS = {
  overview: loadOverview,
  players: () => loadPlayers($('playerQuery').value.trim()),
  bots: loadBots,
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
