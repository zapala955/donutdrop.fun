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
  refreshWalletSummary,
  refreshReferrals,
  attachReferralCode,
  roundHistory,
} from './store.js';
import { $, el, money } from './util.js';
import { toast } from './ui.js';
import { buildPreferences } from './settings.js';

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
  signup_bonus: 'Signup bonus',
  blackjack_stake: 'Blackjack stake',
  blackjack_double: 'Blackjack double',
  blackjack_payout: 'Blackjack payout',
  crash_stake: 'Crash bet',
  crash_payout: 'Crash cash-out',
  mines_stake: 'Mines stake',
  mines_payout: 'Mines cash-out',
  tower_stake: 'Tower stake',
  tower_payout: 'Tower cash-out',
  chicken_stake: 'Chicken stake',
  chicken_payout: 'Chicken cash-out',
  plinko_stake: 'Plinko ball',
  plinko_payout: 'Plinko payout',
  slots_stake: 'Slots spin',
  slots_payout: 'Slots payout',
  daily_code_reward: 'Daily code',
  mines_duel_stake: 'Mines Duel stake',
  mines_duel_win: 'Mines Duel win',
  mines_duel_refund: 'Mines Duel refund',
  dice_stake: 'Dice roll',
  dice_payout: 'Dice win',
  fishing_stake: 'Fishing cast',
  fishing_payout: 'Fishing catch',
  ice_fishing_stake: 'Ice Fishing game',
  ice_fishing_payout: 'Ice Fishing catch',
  derby_stake: 'Mob Derby bet',
  derby_payout: 'Mob Derby win',
  discord_join_reward: 'Discord join reward',
  discord_tag_reward: 'Discord tag reward',
  discord_invite_reward: 'Discord invite reward',
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

  root.appendChild(moneyActions());
}

/**
 * Deposit and Withdraw, as they appear on both the profile and the wallet.
 *
 * The click is forwarded to the header's own buttons rather than calling the modals directly.
 * Those two live in app.js together with every piece of state they depend on -- the bot's
 * availability, the withdrawal cooldown, the pending payout, the Turnstile widget -- and this
 * module has none of it. Proxying the click means there is one deposit flow and one withdrawal
 * flow on this site, not one per page that happens to offer the button.
 */
function moneyActions() {
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
  return actions;
}

// ─────────── /wallet ───────────

let walletRoot = null;

export function mountWallet(view) {
  walletRoot = view;
  bindOnce(view, 'wallet', () => paintWallet());
  if (state.authenticated) {
    /* allSettled, not all: the summary is two tiles and the ledger is the page. If the summary
     * request fails the rest still renders, and the tiles say so rather than the whole page
     * staying on its loading state because one of three calls did not come back. */
    Promise.allSettled([
      refreshBalance(false),
      refreshTransactions(25, false),
      refreshWalletSummary(false),
    ])
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

  /* Deposits and withdrawals over ALL time, from the server.
   *
   * These tiles used to sum the loaded rows and were labelled "in (last 25)" and "out (last 25)"
   * for exactly that reason -- an arbitrary window is not a total, and the honest label made the
   * figures useless rather than wrong. Real money in and real money out is the question somebody
   * opens this page to answer.
   *
   * Withdrawals are net of refunds: a payout that was refunded never left, and counting it would
   * tell somebody they had taken out twice what they really did.
   *
   * An em dash while the figure is unknown, never a zero. "$0 deposited" is a claim about
   * somebody's money, and a request that has not come back yet is not entitled to make it. */
  const summary = state.walletSummary;
  const deposited = summary ? money(Number(summary.depositedMinor)) : '—';
  const withdrawn = summary ? money(Number(summary.withdrawnMinor)) : '—';

  root.appendChild(
    statGrid([
      ['Balance', money(state.balance), 'gold'],
      ['Deposited', deposited, 'up'],
      ['Withdrawn', withdrawn, 'down'],
    ]),
  );

  /* Directly under the figures, above the history. This is the page somebody opens to move money
   * rather than to read about it, and the two actions were previously only on the profile. */
  root.appendChild(moneyActions());

  const ledger = panel('Recent transactions');
  ledger.appendChild(ledgerTable(rows));
  root.appendChild(ledger);
}

// ─────────── /history ───────────

/* Every game's rounds, newest first, from GET /v1/history. It showed the upgrader alone, from when
 * the upgrader was the whole site. A strip of games narrows it to one (the lobby's own tab strip),
 * and "Load more" pages back through time. Each visit fetches the first page again: rounds settle
 * while the player is elsewhere, and an old copy would leave them out. */
const HISTORY_PAGE = 50;

let historyRoot = null;
let history = null; // { rounds, next, games } once loaded
let historyGame = null; // the game the strip is narrowed to; null for every game
let historyLoading = false;
let historyMore = false;
let historyFailed = false;
// Bumped by every request, so an answer that arrives after the filter has changed is dropped.
let historyToken = 0;

export function mountHistory(view) {
  historyRoot = view;
  bindOnce(view, 'history', () => paintHistory());
  history = null;
  historyFailed = false;
  paintHistory();
}

function loadHistory(more = false) {
  const token = ++historyToken;
  const before = more ? history?.next ?? null : null;
  if (more) historyMore = true;
  else {
    historyLoading = true;
    historyFailed = false;
  }
  paintHistory();
  roundHistory({ game: historyGame, before, limit: HISTORY_PAGE })
    .then((page) => {
      if (token !== historyToken) return;
      history = more && history ? { ...page, rounds: [...history.rounds, ...page.rounds] } : page;
    })
    .catch(() => {
      if (token !== historyToken) return;
      if (more) toast({ kind: 'lose', title: 'Could not load more rounds', body: 'Try again in a moment.' });
      else historyFailed = true;
    })
    .finally(() => {
      if (token !== historyToken) return;
      historyLoading = false;
      historyMore = false;
      paintHistory();
    });
}

function paintHistory() {
  if (!historyRoot?.isConnected) return;
  const root = ensureShell(historyRoot, 'Match history', 'historyRoot');
  // The control that had the focus is rebuilt below; it gets the focus back by its key.
  const focusKey = root.contains(document.activeElement) ? document.activeElement.dataset.focusKey : undefined;
  root.innerHTML = '';

  if (!state.authenticated) {
    history = null;
    historyGame = null;
    root.appendChild(notice('Log in to see your history.'));
    return;
  }
  if (history === null && !historyLoading && !historyFailed) {
    loadHistory();
    return;
  }
  if (history === null) {
    if (historyFailed) {
      const failed = notice('Your history could not be loaded.');
      const retry = el('button', 'btn btn--glass hist__retry');
      retry.type = 'button';
      retry.textContent = 'Try again';
      retry.dataset.focusKey = 'retry';
      retry.addEventListener('click', () => loadHistory());
      failed.appendChild(retry);
      root.appendChild(failed);
    } else {
      const loading = notice('Loading your rounds.');
      loading.setAttribute('aria-busy', 'true');
      root.appendChild(loading);
    }
    restoreFocus(root, focusKey);
    return;
  }

  root.appendChild(historyFilter());

  const card = panel(historyGame ? `${gameName(historyGame)} rounds` : 'Every round');
  if (historyLoading) card.setAttribute('aria-busy', 'true');
  const wrap = el('div', 'acct__tablewrap');
  const table = el('table', 'dtable hist__table');

  const head = el('thead');
  const headRow = el('tr');
  for (const [text, cls] of [
    ['Game', ''],
    ['Bet', 'dtable__num'],
    ['Multiplier', 'dtable__num'],
    ['Profit', 'dtable__num'],
    ['When', 'dtable__num'],
  ]) {
    const cell = el('th', cls);
    cell.textContent = text;
    headRow.appendChild(cell);
  }
  head.appendChild(headRow);

  const body = el('tbody');
  if (!history.rounds.length) {
    const row = el('tr');
    const cell = el('td', 'dtable__empty');
    cell.colSpan = 5;
    cell.textContent = historyGame ? `No ${gameName(historyGame)} rounds yet.` : 'No rounds yet.';
    row.appendChild(cell);
    body.appendChild(row);
  }
  for (const round of history.rounds) body.appendChild(historyRow(round));

  table.append(head, body);
  wrap.appendChild(table);
  card.appendChild(wrap);

  if (history.next) {
    const more = el('button', 'btn btn--glass hist__more');
    more.type = 'button';
    more.dataset.focusKey = 'more';
    more.disabled = historyMore;
    more.setAttribute('aria-busy', historyMore ? 'true' : 'false');
    more.textContent = historyMore ? 'Loading' : 'Load more';
    more.addEventListener('click', () => loadHistory(true));
    card.appendChild(more);
  }
  root.appendChild(card);
  restoreFocus(root, focusKey);
}

/** "All games", then every game, as the lobby's tab strip: one pressed at a time. */
function historyFilter() {
  const strip = el('div', 'lxtabs hist__filter');
  const track = el('div', 'lxtabs__track');
  track.setAttribute('role', 'group');
  track.setAttribute('aria-label', 'Show rounds from');
  for (const option of [{ game: null, name: 'All games' }, ...(history?.games ?? [])]) {
    const tab = el('button', 'lxtab');
    tab.type = 'button';
    tab.textContent = option.name;
    tab.dataset.focusKey = 'game:' + (option.game ?? 'all');
    tab.setAttribute('aria-pressed', String(option.game === historyGame));
    tab.addEventListener('click', () => {
      if (option.game === historyGame) return;
      historyGame = option.game;
      loadHistory();
    });
    track.appendChild(tab);
  }
  strip.appendChild(track);
  return strip;
}

function historyRow(round) {
  const wager = Number(round.wagerMinor);
  const payout = Number(round.payoutMinor);
  const row = el('tr');
  row.dataset.outcome = payout > wager ? 'win' : payout < wager ? 'loss' : 'even';

  const game = el('td', 'hist__game');
  const name = el('span', 'dtable__name');
  name.textContent = round.name;
  game.appendChild(name);
  if (round.detail) {
    const detail = el('span', 'hist__detail');
    detail.textContent = round.detail;
    game.appendChild(detail);
  }

  const bet = el('td', 'dtable__num mono');
  bet.textContent = money(wager);

  const multiplier = el('td', 'dtable__num mono dtable__dim');
  multiplier.textContent = round.multiplier === null ? '—' : `${round.multiplier.toFixed(2)}×`;

  // The sign carries the direction as well as the colour, so it survives a colour-blind reader.
  const profit = el('td', 'dtable__num mono');
  const net = payout - wager;
  if (net > 0) profit.dataset.dir = 'up';
  if (net < 0) profit.dataset.dir = 'down';
  profit.textContent = net > 0 ? '+' + money(net) : net < 0 ? '−' + money(-net) : '±$0';

  // The year only when it is not this one: the column has to fit beside the money on a phone.
  const when = el('td', 'dtable__num mono dtable__dim');
  const at = new Date(round.at);
  const sameYear = at.getFullYear() === new Date().getFullYear();
  when.textContent = at.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
  });
  when.title = at.toLocaleString();

  row.append(game, bet, multiplier, profit, when);
  return row;
}

function gameName(game) {
  return history?.games?.find((option) => option.game === game)?.name ?? game;
}

function restoreFocus(root, key) {
  if (!key) return;
  const target = [...root.querySelectorAll('[data-focus-key]')].find((node) => node.dataset.focusKey === key);
  target?.focus();
}

// ─────────── /settings ───────────

let settingsRoot = null;

export function mountSettings(view) {
  settingsRoot = view;
  bindOnce(view, 'settings', () => paintSettings());
  if (state.authenticated) {
    refreshAccount(false).then(paintSettings).catch(() => undefined);
    refreshReferrals(false).then(paintSettings).catch(() => undefined);
  }
  paintSettings();
}

function paintSettings() {
  if (!settingsRoot?.isConnected) return;
  const root = ensureShell(settingsRoot, 'Settings', 'settingsRoot');
  /* The preferences (settings.js) are built once and left alone. This repaints on every login,
   * account and referral event, and rebuilding them each time would take the focus, and a volume
   * slider half-way through a drag, out from under the player. Only the account part below is
   * redrawn. They come first and need no login: a theme or the volume is this browser's. */
  let mine = root.querySelector('.acct__mine');
  if (!mine) {
    mine = el('div', 'acct__mine');
    root.replaceChildren(buildPreferences(), mine);
  }
  mine.innerHTML = '';

  if (!state.authenticated) {
    mine.appendChild(notice('Log in to see your account and invite code here.'));
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
  mine.appendChild(identity);

  const invite = inviteCodePanel();
  if (invite) mine.appendChild(invite);
}

const INVITE_CODE = /^[A-Z0-9]{6,16}$/;

/**
 * The one invite-code entry a registered player has.
 *
 * An invite link only counts for a brand-new account. Anybody who is already registered gets a
 * single entry, here: to set the inviter they never had, or to swap one that has not earned
 * anything from them yet. The server owns every rule (once only, nothing earned, not your own code,
 * no loops), so this card only reflects `codeEntry` and reports what the server says.
 */
function inviteCodePanel() {
  const self = state.referrals?.self;
  if (!self) return null;                       // programme off, or not loaded yet
  const entry = self.codeEntry ?? {};
  const inviter = self.referredBy;
  const card = panel('Invite code');

  if (!entry.available) {
    const note = el('p', 'refer__note');
    if (inviter) {
      note.textContent = entry.used
        ? `Invited by ${inviter}. You have already used your one code entry.`
        : entry.locked
          ? `Invited by ${inviter}. They have earned from your play, so this can no longer be changed.`
          : `Invited by ${inviter}.`;
    } else {
      note.textContent = entry.used
        ? 'You have already used your one code entry.'
        : 'Invite codes can only be added by new accounts.';
    }
    card.appendChild(note);
    return card;
  }

  const field = el('div', 'refer__field');
  const input = document.createElement('input');
  input.className = 'refer__input';
  input.id = 'settingsInviteCode';
  input.maxLength = 16;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = 'Enter a friend\u0027s code';
  input.setAttribute('aria-label', 'Invite code');
  const apply = el('button', 'refer__copy');
  apply.type = 'button';
  apply.textContent = 'Apply';
  apply.disabled = true;
  const note = el('p', 'refer__note');
  note.textContent = entry.mode === 'change'
    ? `Invited by ${inviter}. You can change this once, until they have earned from your play.`
    : 'Got a code from a friend? You can enter one code, once.';

  const clean = () => input.value.trim().toUpperCase();
  input.addEventListener('input', () => {
    const value = clean();
    if (input.value !== value) input.value = value;
    apply.disabled = !INVITE_CODE.test(value);
  });
  apply.addEventListener('click', async () => {
    const code = clean();
    if (!INVITE_CODE.test(code)) return;
    // Irreversible: it uses up the one entry, so it is asked about first.
    if (!window.confirm(`Use ${code} as your invite code? You can only do this once.`)) return;
    apply.disabled = true;
    apply.textContent = 'Applying';
    try {
      const result = await attachReferralCode(code);
      toast({
        kind: 'win',
        title: result?.changed ? 'Invite code changed' : 'Invite code applied',
        body: `${result?.inviter ?? 'Your inviter'} is now credited for inviting you.`,
      });
    } catch (error) {
      apply.textContent = 'Apply';
      note.textContent = error?.message || 'That code could not be applied.';
      note.dataset.bad = '1';
      apply.disabled = !INVITE_CODE.test(clean());
    }
  });
  field.append(input, apply);
  card.append(field, note);
  return card;
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
    if (['login', 'logout', 'ready', 'private', 'account', 'transactions', 'wallet', 'sync', 'referrals'].includes(event.detail)) {
      paint();
    }
  });
}
