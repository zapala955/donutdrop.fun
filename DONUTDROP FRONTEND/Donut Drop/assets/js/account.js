/* account.js — profile, wallet, history and settings.
 *
 * Four routes, one module. They are four views of the same two things — who the account is, and
 * what its money has done — and splitting them would mean four copies of the same ledger table.
 *
 * Everything is server state. Nothing here caches a balance or a status between navigations: both
 * change from outside this page (a round settles, an operator suspends an account), and a figure
 * held in the browser is a figure that can be wrong in a way the player cannot see.
 */
import {
  state,
  bus,
  refreshAccount,
  refreshTransactions,
  refreshBalance,
  upgradeHistory,
} from './store.js';
import { $, el, money, pct } from './util.js';

/* Wallet ledger kinds, in the words a player would use. The API returns the column value, which
 * is a schema identifier and not a label — rendering `upgrade_stake` at somebody is asking them
 * to read the database. Anything unmapped falls back to the raw kind with underscores stripped,
 * so a new kind added server-side degrades to something readable rather than to blank. */
const KIND_LABEL = {
  case_open: 'Crate opened',
  case_win: 'Crate win',
  item_sale: 'Item sold',
  admin_adjustment: 'Adjustment',
  upgrade_stake: 'Upgrader stake',
  upgrade_win: 'Upgrader win',
  vault_yield: 'Vault yield',
  /* The piggy bank is gone, but its ledger rows are not: the wallet is append-only, so every
     deposit, maturity and early break a player ever made is still in their history and still needs
     a name. Deleting these three would not tidy anything — it would show those rows as 'piggy
     open' via the raw-kind fallback. They stay for as long as the rows do, which is forever. */
  piggy_open: 'Piggy deposit',
  piggy_claim: 'Piggy matured',
  piggy_break: 'Piggy broken',
  quest_reward: 'Quest reward',
  streak_reward: 'Streak reward',
  faction_payout: 'Faction payout',
  battle_stake: 'Battle stake',
  battle_win: 'Battle win',
  battle_refund: 'Battle refund',
  creator_royalty: 'Creator royalty',
  referral_revshare: 'Referral share',
  referral_bonus: 'Referral bonus',
  rakeback_claim: 'Rakeback',
  race_payout: 'Race prize',
};

const kindLabel = (kind) => KIND_LABEL[kind] ?? String(kind ?? '').replaceAll('_', ' ');

// ─────────── shared pieces ───────────

function notice(message) {
  const card = el('div', 'acct__notice');
  const line = el('p');
  line.textContent = message;
  card.appendChild(line);
  return card;
}

function statGrid(cells) {
  const grid = el('div', 'acct__grid');
  for (const [label, value, tone] of cells) {
    const cell = el('div', 'acct__stat');
    if (tone) cell.dataset.tone = tone;
    const key = el('span', 'acct__k');
    key.textContent = label;
    const figure = el('b', 'acct__v');
    figure.textContent = value;
    cell.append(key, figure);
    grid.appendChild(cell);
  }
  return grid;
}

function panel(title) {
  const card = el('section', 'acct__panel');
  const label = el('span', 'acct__label');
  label.textContent = title;
  card.appendChild(label);
  return card;
}

function facts(rows) {
  const list = el('dl', 'acct__facts mono');
  for (const [term, value, tone] of rows) {
    const group = el('div');
    if (tone) group.dataset.tone = tone;
    const dt = el('dt');
    dt.textContent = term;
    const dd = el('dd');
    dd.textContent = value;
    group.append(dt, dd);
    list.appendChild(group);
  }
  return list;
}

/** A signed money cell: the sign is the whole point, so it is never dropped. */
function amountCell(minor) {
  const value = Number(minor);
  const cell = el('td', 'dtable__num mono');
  cell.dataset.dir = value >= 0 ? 'up' : 'down';
  cell.textContent = (value >= 0 ? '+' : '−') + money(Math.abs(value));
  return cell;
}

function ledgerTable(rows) {
  const wrap = el('div', 'acct__tablewrap');
  const table = el('table', 'dtable');

  const head = el('thead');
  const headRow = el('tr');
  for (const [text, cls] of [
    ['Event', ''],
    ['Amount', 'dtable__num'],
    ['Balance', 'dtable__num'],
    ['When', 'dtable__num'],
  ]) {
    const cell = el('th', cls);
    cell.textContent = text;
    headRow.appendChild(cell);
  }
  head.appendChild(headRow);

  const body = el('tbody');
  if (!rows.length) {
    const row = el('tr');
    const cell = el('td');
    cell.colSpan = 4;
    cell.className = 'dtable__empty';
    cell.textContent = 'No transactions yet.';
    row.appendChild(cell);
    body.appendChild(row);
  }

  for (const entry of rows) {
    const row = el('tr');
    const kind = el('td');
    kind.textContent = kindLabel(entry.kind);
    const after = el('td', 'dtable__num mono dtable__dim');
    after.textContent = money(Number(entry.balance_after_minor));
    const when = el('td', 'dtable__num mono dtable__dim');
    when.textContent = new Date(entry.created_at).toLocaleString();
    row.append(kind, amountCell(entry.amount_minor), after, when);
    body.appendChild(row);
  }

  table.append(head, body);
  wrap.appendChild(table);
  return wrap;
}

// ─────────── /profile ───────────

let profileRoot = null;

export function mountProfile(view) {
  profileRoot = view;
  bindOnce(view, 'profile', () => paintProfile());
  if (state.authenticated) {
    refreshBalance(false).then(paintProfile).catch(() => undefined);
  }
  paintProfile();
}

function paintProfile() {
  if (!profileRoot?.isConnected) return;
  const root = ensureShell(profileRoot, 'Profile', 'profileRoot');
  root.innerHTML = '';

  if (!state.authenticated) {
    root.appendChild(notice('Log in to see your profile.'));
    return;
  }

  const user = state.user ?? {};

  root.appendChild(
    statGrid([
      ['Username', String(user.minecraftUsername ?? '—'), null],
      ['Balance', money(state.balance), 'gold'],
    ]),
  );

  const actions = el('div', 'acct__actions');
  const deposit = el('button', 'btn btn--go');
  deposit.type = 'button';
  deposit.textContent = 'Deposit';
  deposit.addEventListener('click', () => $('#depositBtn')?.click());

  const withdraw = el('button', 'btn btn--withdraw');
  withdraw.type = 'button';
  withdraw.textContent = 'Withdraw';
  withdraw.addEventListener('click', () => $('#withdrawBtn')?.click());

  actions.append(deposit, withdraw);
  root.appendChild(actions);
}

// ─────────── /wallet ───────────

let walletRoot = null;

export function mountWallet(view) {
  walletRoot = view;
  bindOnce(view, 'wallet', () => paintWallet());
  if (state.authenticated) {
    Promise.all([refreshBalance(false), refreshTransactions(25, false)])
      .then(paintWallet)
      .catch(() => undefined);
  }
  paintWallet();
}

function paintWallet() {
  if (!walletRoot?.isConnected) return;
  const root = ensureShell(walletRoot, 'Wallet', 'walletRoot');
  root.innerHTML = '';

  if (!state.authenticated) {
    root.appendChild(notice('Log in to see your wallet.'));
    return;
  }

  const rows = state.transactions;
  /* In and out over the loaded window, not over all time. Labelled as such below, because a
   * figure that says "in" while covering only the last 25 rows is a lie by omission otherwise. */
  const credited = rows.reduce((sum, r) => (Number(r.amount_minor) > 0 ? sum + Number(r.amount_minor) : sum), 0);
  const debited = rows.reduce((sum, r) => (Number(r.amount_minor) < 0 ? sum - Number(r.amount_minor) : sum), 0);

  root.appendChild(
    statGrid([
      ['Balance', money(state.balance), 'gold'],
      ['In (last 25)', money(credited), 'up'],
      ['Out (last 25)', money(debited), 'down'],
    ]),
  );

  const ledger = panel('Recent ledger');
  ledger.appendChild(ledgerTable(rows));
  root.appendChild(ledger);
}

// ─────────── /history ───────────

let historyRoot = null;
let rounds = null;
let loadingRounds = false;

export function mountHistory(view) {
  historyRoot = view;
  bindOnce(view, 'history', () => paintHistory());
  if (state.authenticated && rounds === null && !loadingRounds) loadRounds();
  paintHistory();
}

function loadRounds() {
  loadingRounds = true;
  upgradeHistory(50)
    .then((result) => {
      rounds = result.rounds || [];
    })
    .catch(() => {
      rounds = [];
    })
    .finally(() => {
      loadingRounds = false;
      paintHistory();
    });
}

function paintHistory() {
  if (!historyRoot?.isConnected) return;
  const root = ensureShell(historyRoot, 'Match history', 'historyRoot');
  root.innerHTML = '';

  if (!state.authenticated) {
    root.appendChild(notice('Log in to see your history.'));
    return;
  }
  if (rounds === null) {
    root.appendChild(notice(loadingRounds ? 'Loading.' : 'History is unavailable.'));
    return;
  }

  const wins = rounds.filter((r) => r.outcome === 'win').length;
  root.appendChild(
    statGrid([
      ['Rounds loaded', String(rounds.length), null],
      ['Wins', String(wins), 'up'],
      ['Losses', String(rounds.length - wins), 'down'],
      ['Win rate', rounds.length ? pct(wins / rounds.length, 1) : '—', null],
    ]),
  );

  const card = panel('Upgrader rounds');
  const wrap = el('div', 'acct__tablewrap');
  const table = el('table', 'dtable');

  const head = el('thead');
  const headRow = el('tr');
  for (const [text, cls] of [
    ['Target', ''],
    ['Stake', 'dtable__num'],
    ['Chance', 'dtable__num'],
    ['Result', 'dtable__num'],
    ['When', 'dtable__num'],
  ]) {
    const cell = el('th', cls);
    cell.textContent = text;
    headRow.appendChild(cell);
  }
  head.appendChild(headRow);

  const body = el('tbody');
  if (!rounds.length) {
    const row = el('tr');
    const cell = el('td');
    cell.colSpan = 5;
    cell.className = 'dtable__empty';
    cell.textContent = 'No rounds yet.';
    row.appendChild(cell);
    body.appendChild(row);
  }

  for (const round of rounds) {
    const row = el('tr');
    row.dataset.outcome = round.outcome;

    const target = el('td', 'dtable__name');
    target.textContent = round.display_name ?? round.minecraft_name ?? '—';

    const stake = el('td', 'dtable__num mono');
    stake.textContent = money(Number(round.stake_value_minor));

    const chance = el('td', 'dtable__num mono dtable__dim');
    chance.textContent = pct(Number(round.chance_ppm) / 1_000_000, 2);

    const result = el('td', 'dtable__num mono');
    result.dataset.dir = round.outcome === 'win' ? 'up' : 'down';
    result.textContent =
      round.outcome === 'win' ? '+' + money(Number(round.target_value_minor)) : '−' + money(Number(round.stake_value_minor));

    const when = el('td', 'dtable__num mono dtable__dim');
    when.textContent = new Date(round.created_at).toLocaleString();

    row.append(target, stake, chance, result, when);
    body.appendChild(row);
  }

  table.append(head, body);
  wrap.appendChild(table);
  card.appendChild(wrap);
  root.appendChild(card);
}

// ─────────── /settings ───────────

let settingsRoot = null;

export function mountSettings(view) {
  settingsRoot = view;
  bindOnce(view, 'settings', () => paintSettings());
  if (state.authenticated) refreshAccount(false).then(paintSettings).catch(() => undefined);
  paintSettings();
}

function paintSettings() {
  if (!settingsRoot?.isConnected) return;
  const root = ensureShell(settingsRoot, 'Settings', 'settingsRoot');
  root.innerHTML = '';

  if (!state.authenticated) {
    root.appendChild(notice('Log in to manage your account.'));
    return;
  }
  const account = state.account;

  /* A "Responsible play" section stood here: a one-way cooldown and a self-exclusion of up to five
   * years, both irreversible by design and both enforced on the server rather than on this page.
   * They were removed on the operator's decision that a wallet of in-game currency does not
   * warrant them.
   *
   * This page is a read now. Nothing on it changes anything, which is why there is no longer a
   * busy state to disable buttons with or a confirm step to guard a mis-tap. */
  const identity = panel('Account');
  identity.appendChild(
    facts([
      ['Username', state.user?.minecraftUsername ?? '—'],
      ['Status', account?.status ?? state.user?.status ?? '—'],
      ['Role', account?.role ?? state.user?.role ?? '—'],
      [
        'Joined',
        account?.created_at ? new Date(account.created_at).toLocaleDateString() : '—',
      ],
    ]),
  );
  root.appendChild(identity);
}

/* openCooldown, openExclusion and the commit helper they shared stood here.
 *
 * Two modals that each asked a player to confirm locking themselves out, and one writer that
 * disabled the page while the request was in flight. Nothing on the settings page writes any more,
 * so the busy flag and the confirm step went with them rather than being left as scaffolding
 * around nothing.
 */

// ─────────── shell helpers ───────────

/**
 * Gives a bare `<section class="view">` the same header-plus-body shape every other route has, and
 * returns the body to render into.
 *
 * These six routes were empty section elements with no inner markup, unlike the eight built
 * earlier which each got their own root div in index.html. Building the shell here keeps that
 * difference out of the markup and means the page owns its own heading.
 */
function ensureShell(view, title, rootId) {
  let root = $('#' + rootId, view);
  if (!root) {
    view.innerHTML = '';
    const header = el('header', 'phead');
    const heading = el('h1');
    heading.textContent = title;
    header.appendChild(heading);
    root = el('div', 'acct');
    root.id = rootId;
    view.append(header, root);
  }
  return root;
}

/** One bus subscription per view, however many times the router mounts it. */
function bindOnce(view, key, paint) {
  if (view.dataset.bound === key) return;
  view.dataset.bound = key;
  bus.addEventListener('change', (event) => {
    if (!view.isConnected) return;
    if (['login', 'logout', 'ready', 'private', 'account', 'transactions', 'sync'].includes(event.detail)) {
      paint();
    }
  });
}
