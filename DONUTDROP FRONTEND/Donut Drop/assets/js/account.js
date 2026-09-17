/* account.js — profile, wallet, history and settings.
 *
 * Four routes, one module. They are four views of the same two things — who the account is, and
 * what its money has done — and splitting them would mean four copies of the same ledger table
 * and the same compliance-state renderer.
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
  setCooldown,
  setSelfExclusion,
  upgradeHistory,
} from './store.js';
import { $, el, money, pct } from './util.js';
import { toast, openModal, closeModal } from './ui.js';
import { playSound } from './audio-engine.js';

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

const COOLDOWN_CHOICES = [
  ['24 hours', 24],
  ['7 days', 24 * 7],
  ['30 days', 24 * 30],
];
const EXCLUSION_CHOICES = [
  ['30 days', 30],
  ['90 days', 90],
  ['1 year', 365],
  ['5 years', 1825],
];

let busy = false;

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
    refreshAccount(false).then(paintProfile).catch(() => undefined);
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
  const account = state.account;

  root.appendChild(
    statGrid([
      ['Username', String(user.minecraftUsername ?? '—'), null],
      ['Balance', money(state.balance), 'gold'],
      ['Status', String(user.status ?? '—'), user.status === 'active' ? 'up' : null],
      ['Role', String(user.role ?? '—'), null],
    ]),
  );

  const compliance = panel('Verification');
  compliance.appendChild(
    facts([
      ['Identity (KYC)', account?.kyc_status ?? '—', account?.kyc_status === 'verified' ? 'up' : 'down'],
      ['Age verified', account?.age_verified_at ? 'yes' : 'no', account?.age_verified_at ? 'up' : 'down'],
      ['Terms accepted', account?.terms_accepted_at ? 'yes' : 'no', account?.terms_accepted_at ? 'up' : 'down'],
      ['Country', account?.country_code ?? '—', null],
    ]),
  );
  root.appendChild(compliance);

  /* Whichever responsible-play hold is active, shown on the profile as well as in settings: a
   * player wondering why a round was refused should find the reason on the first page they open,
   * not only on the page where they set it. */
  const hold = activeHold(account);
  if (hold) {
    const card = panel('Play paused');
    card.appendChild(facts([[hold.label, hold.until, 'down']]));
    root.appendChild(card);
  }
}

function activeHold(account) {
  if (!account) return null;
  const now = Date.now();
  const excluded = account.self_excluded_until && new Date(account.self_excluded_until).getTime() > now;
  if (excluded) {
    return { label: 'Self-excluded until', until: new Date(account.self_excluded_until).toLocaleString() };
  }
  const cooling = account.cooldown_until && new Date(account.cooldown_until).getTime() > now;
  if (cooling) {
    return { label: 'Cooldown until', until: new Date(account.cooldown_until).toLocaleString() };
  }
  return null;
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
  const hold = activeHold(account);

  /* Responsible play, and it is the only thing on this page that changes anything.
   *
   * Both controls are one-way by design and the server enforces that, not this page: a cooldown
   * only ever moves forward, and self-exclusion cannot be shortened. The confirm step exists
   * because neither can be undone from here — not as a formality, but because the player is about
   * to lock themselves out and should not be able to do it by mis-tapping. */
  const play = panel('Responsible play');
  play.appendChild(
    facts([
      ['Cooldown', hold?.label === 'Cooldown until' ? hold.until : 'none', hold?.label === 'Cooldown until' ? 'down' : null],
      [
        'Self-exclusion',
        account?.self_excluded_until ? new Date(account.self_excluded_until).toLocaleString() : 'none',
        account?.self_excluded_until ? 'down' : null,
      ],
    ]),
  );

  const actions = el('div', 'acct__actions');
  const cooldownBtn = el('button', 'btn');
  cooldownBtn.type = 'button';
  cooldownBtn.textContent = 'START COOLDOWN';
  cooldownBtn.disabled = busy;
  cooldownBtn.addEventListener('click', openCooldown);

  const excludeBtn = el('button', 'btn acct__danger');
  excludeBtn.type = 'button';
  excludeBtn.textContent = 'SELF-EXCLUDE';
  excludeBtn.disabled = busy;
  excludeBtn.addEventListener('click', openExclusion);

  actions.append(cooldownBtn, excludeBtn);
  play.appendChild(actions);
  root.appendChild(play);

  const identity = panel('Account');
  identity.appendChild(
    facts([
      ['Username', state.user?.minecraftUsername ?? '—'],
      ['Status', account?.status ?? state.user?.status ?? '—'],
      ['Country', account?.country_code ?? '—'],
      ['Identity (KYC)', account?.kyc_status ?? '—'],
    ]),
  );
  root.appendChild(identity);
}

function openCooldown() {
  openModal('Start a cooldown', (body) => {
    body.innerHTML = '<div class="cform" id="cdForm"></div>';
    const form = $('#cdForm', body);
    const warn = el('p', 'acct__warn');
    warn.textContent = 'A cooldown cannot be shortened or cancelled once it starts.';
    form.appendChild(warn);

    for (const [label, hours] of COOLDOWN_CHOICES) {
      const button = el('button', 'btn');
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', () => commit(() => setCooldown(hours), `Cooldown set: ${label}`));
      form.appendChild(button);
    }
  });
}

function openExclusion() {
  openModal('Self-exclude', (body) => {
    body.innerHTML = '<div class="cform" id="exForm"></div>';
    const form = $('#exForm', body);
    const warn = el('p', 'acct__warn');
    warn.textContent = 'Self-exclusion cannot be reversed or shortened. Support cannot lift it early.';
    form.appendChild(warn);

    for (const [label, days] of EXCLUSION_CHOICES) {
      const button = el('button', 'btn acct__danger');
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', () =>
        commit(() => setSelfExclusion(days), `Self-excluded for ${label}`),
      );
      form.appendChild(button);
    }
  });
}

async function commit(action, message) {
  if (busy) return;
  busy = true;
  try {
    await action();
    playSound('click');
    toast({ kind: 'lose', title: message });
    closeModal();
  } catch (error) {
    toast({ kind: 'lose', title: 'Could not apply', body: error?.message || '' });
  } finally {
    busy = false;
    paintSettings();
    paintProfile();
  }
}

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
