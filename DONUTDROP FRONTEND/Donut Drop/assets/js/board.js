/* board.js — the leaderboard, and the player's own statistics.
 *
 * Two routes, one module, because they are two views of the same aggregates and splitting them
 * would mean two copies of the same table renderer.
 *
 * Both are read-only. Nothing here caches a rank or a total between visits: the server computes
 * them from the rounds that produced them, and a number held in the browser between navigations
 * is a number that can be stale in a way the player cannot see.
 */
import { state, bus, refreshLeaderboard, refreshStatistics } from './store.js';
import { tableAvatar } from './table-avatar.js';
import { linkPlayer } from './player-link.js';
import { $, el, money, pct } from './util.js';

/* The three boards, and what the two numeric columns mean on each. A board's `value` and `detail`
 * come back as opaque strings, so the formatter lives beside the tab that selects it rather than
 * being guessed at render time. */
const BOARDS = [
  {
    key: 'wagered',
    label: 'Top High-Rollers',
    value: 'Wagered',
    detail: 'Rounds',
    formatValue: (raw) => money(Number(raw)),
    formatDetail: (raw) => (raw === null ? '—' : Number(raw).toLocaleString('en-US')),
  },
  {
    key: 'multiplier',
    label: 'Biggest Multipliers',
    value: 'Multiplier',
    detail: 'Payout',
    formatValue: (raw) => `${Number(raw).toFixed(2)}x`,
    formatDetail: (raw) => (raw === null ? '—' : money(Number(raw))),
  },
  {
    key: 'crates',
    label: 'Most Crates Unboxed',
    value: 'Opened',
    detail: 'Spent',
    formatValue: (raw) => Number(raw).toLocaleString('en-US'),
    formatDetail: (raw) => (raw === null ? '—' : money(Number(raw))),
  },
];

let boardRoot = null;
let statsRoot = null;
let activeBoard = 'wagered';
let loading = false;

// ─────────── leaderboard ───────────

export function mountLeaderboard(view) {
  boardRoot = $('#boardRoot', view);
  if (!boardRoot) return;
  if (!boardRoot.dataset.built) {
    boardRoot.dataset.built = '1';
    bus.addEventListener('change', (event) => {
      if (!boardRoot.isConnected) return;
      if (['leaderboard', 'login', 'logout', 'ready'].includes(event.detail)) paintBoard();
    });
  }
  load(activeBoard);
  paintBoard();
}

function load(board) {
  loading = true;
  refreshLeaderboard(board, false)
    .catch(() => undefined)
    .finally(() => {
      loading = false;
      paintBoard();
    });
}

function paintBoard() {
  if (!boardRoot?.isConnected) return;
  boardRoot.innerHTML = '';

  boardRoot.appendChild(boardTabs());

  const data = state.leaderboard;
  const meta = BOARDS.find((entry) => entry.key === activeBoard) ?? BOARDS[0];

  if (loading && !data) {
    boardRoot.appendChild(notice('board', 'Loading.'));
    return;
  }
  if (!data) {
    boardRoot.appendChild(notice('board', 'The leaderboard is unavailable.'));
    return;
  }

  const wrap = el('div', 'board__tablewrap');
  const table = el('table', 'dtable');

  const head = el('thead');
  const headRow = el('tr');
  for (const [text, cls] of [
    ['#', ''],
    ['Player', ''],
    [meta.value, 'dtable__num'],
    [meta.detail, 'dtable__num'],
  ]) {
    const cell = el('th', cls);
    cell.textContent = text;
    headRow.appendChild(cell);
  }
  head.appendChild(headRow);

  const body = el('tbody');
  if (!data.entries.length) {
    const row = el('tr');
    const cell = el('td');
    cell.colSpan = 4;
    cell.className = 'dtable__empty';
    cell.textContent = 'Nothing on this board yet.';
    row.appendChild(cell);
    body.appendChild(row);
  }

  for (const entry of data.entries) {
    const row = el('tr');
    row.dataset.you = entry.isViewer ? '1' : '0';
    if (entry.rank <= 3) row.dataset.podium = String(entry.rank);

    const rank = el('td', 'dtable__rank mono');
    rank.textContent = `#${entry.rank}`;

    const player = el('td', 'dtable__player');
    const avatar = tableAvatar(entry.playerId);
    const name = el('span', 'dtable__name');
    name.textContent = entry.username;
    player.append(avatar, name);
    linkPlayer(entry.playerId, entry.username, avatar, name);

    const value = el('td', 'dtable__num mono dtable__prize');
    value.textContent = meta.formatValue(entry.value);

    const detail = el('td', 'dtable__num mono dtable__dim');
    detail.textContent = meta.formatDetail(entry.detail);

    row.append(rank, player, value, detail);
    body.appendChild(row);
  }

  table.append(head, body);
  wrap.appendChild(table);
  boardRoot.appendChild(wrap);
}

function boardTabs() {
  const bar = el('div', 'board__tabs');
  for (const meta of BOARDS) {
    const tab = el('button', 'board__tab');
    tab.type = 'button';
    tab.dataset.on = meta.key === activeBoard ? '1' : '0';
    tab.textContent = meta.label;
    tab.addEventListener('click', () => {
      if (activeBoard === meta.key) return;
      activeBoard = meta.key;
      // Clearing first so the previous board's rows cannot be read as the new board's while the
      // request is in flight — the two have different units in the same columns.
      state.leaderboard = null;
      load(meta.key);
      paintBoard();
    });
    bar.appendChild(tab);
  }
  return bar;
}

// ─────────── personal statistics ───────────

let statsLoading = false;

export function mountStatistics(view) {
  statsRoot = $('#statsRoot', view);
  if (!statsRoot) return;
  if (!statsRoot.dataset.built) {
    statsRoot.dataset.built = '1';
    bus.addEventListener('change', (event) => {
      if (!statsRoot.isConnected) return;
      /* A page opened straight at /statistics mounts before the session is known, so the fetch
       * waits for 'ready' or 'login'. It used to happen at mount only, and a refresh of this page
       * said "Statistics are unavailable" until the player navigated away and back. */
      if (['login', 'ready'].includes(event.detail) && state.authenticated) loadStats();
      else if (['statistics', 'login', 'logout', 'ready', 'private'].includes(event.detail)) paintStats();
    });
  }
  if (state.authenticated) loadStats();
  else paintStats();
}

function loadStats() {
  statsLoading = true;
  paintStats();
  refreshStatistics(false)
    .catch(() => undefined)
    .finally(() => {
      statsLoading = false;
      paintStats();
    });
}

function paintStats() {
  if (!statsRoot?.isConnected) return;
  statsRoot.innerHTML = '';

  if (!state.authenticated) {
    statsRoot.appendChild(notice('stats', 'Log in to see your statistics.'));
    return;
  }
  const data = state.statistics;
  if (!data) {
    const message = notice('stats', statsLoading ? 'Loading your statistics.' : 'Statistics are unavailable.');
    if (statsLoading) message.setAttribute('aria-busy', 'true');
    statsRoot.appendChild(message);
    return;
  }

  /* Every game, from GET /v1/statistics. It counted the upgrader, crates and battles only, and its
   * "net profit / loss" came off the whole wallet ledger, deposits and withdrawals included. The
   * net is now the games' own result; rewards (rakeback, streaks, codes) are their own figure. */
  const totals = data.totals;
  if (!totals.rounds) {
    statsRoot.appendChild(notice('stats', 'No rounds yet. Your numbers start with your first bet.'));
    return;
  }
  const net = Number(totals.netMinor);
  const biggest = data.biggestWin;
  statsRoot.appendChild(
    statGrid([
      ['Total wagered', money(Number(totals.wageredMinor)), null],
      // The one figure on the page that is allowed to be red: a player's own result.
      ['Net result', signedMoney(net), net > 0 ? 'up' : net < 0 ? 'down' : null],
      ['Rounds played', totals.rounds.toLocaleString('en-US'), null],
      ['Win rate', totals.winRate === null ? '—' : pct(totals.winRate, 1), null],
      [
        biggest ? `Biggest win · ${biggest.name}` : 'Biggest win',
        biggest ? signedMoney(Number(biggest.payoutMinor) - Number(biggest.wagerMinor)) : '—',
        'gold',
      ],
      ['Best multiplier', data.bestMultiplier === null ? '—' : `${data.bestMultiplier.toFixed(2)}×`, 'gold'],
      ['Favourite game', data.favouriteGame?.name ?? '—', null],
      ['Rewards claimed', money(Number(totals.rewardsMinor)), null],
    ]),
  );

  statsRoot.appendChild(byGame(data.games));

  if (data.favouriteCases.length) {
    statsRoot.appendChild(favourites(data.favouriteCases));
  }
}

/** The sign written out, so a result reads the same to a colour-blind player and in greyscale. */
function signedMoney(n) {
  return n > 0 ? '+' + money(n) : n < 0 ? '−' + money(-n) : '$0';
}

function statGrid(cells) {
  const grid = el('div', 'stats__grid');
  for (const [label, value, tone] of cells) {
    const cell = el('div', 'stats__card');
    if (tone) cell.dataset.tone = tone;
    const key = el('span', 'stats__k');
    key.textContent = label;
    const figure = el('b', 'stats__v');
    figure.textContent = value;
    cell.append(key, figure);
    grid.appendChild(cell);
  }
  return grid;
}

/** One row a game the player has played, most wagered first. */
function byGame(games) {
  const card = el('section', 'stats__panel');
  const label = el('span', 'stats__label');
  label.textContent = 'By game';
  card.appendChild(label);

  const wrap = el('div', 'acct__tablewrap');
  const table = el('table', 'dtable stats__bygame');
  const head = el('thead');
  const headRow = el('tr');
  for (const [text, cls] of [
    ['Game', ''],
    ['Rounds', 'dtable__num'],
    ['Win rate', 'dtable__num'],
    ['Wagered', 'dtable__num'],
    ['Net', 'dtable__num'],
    ['Best', 'dtable__num'],
  ]) {
    const cell = el('th', cls);
    cell.textContent = text;
    headRow.appendChild(cell);
  }
  head.appendChild(headRow);

  const body = el('tbody');
  for (const game of games) {
    const row = el('tr');
    const name = el('td', 'dtable__name');
    name.textContent = game.name;
    const rounds = el('td', 'dtable__num mono');
    rounds.textContent = game.rounds.toLocaleString('en-US');
    const rate = el('td', 'dtable__num mono dtable__dim');
    rate.textContent = pct(game.wins / game.rounds, 1);
    const wagered = el('td', 'dtable__num mono');
    wagered.textContent = money(Number(game.wageredMinor));
    const netCell = el('td', 'dtable__num mono');
    const net = Number(game.netMinor);
    if (net > 0) netCell.dataset.dir = 'up';
    if (net < 0) netCell.dataset.dir = 'down';
    netCell.textContent = signedMoney(net);
    const best = el('td', 'dtable__num mono dtable__dim');
    best.textContent = game.bestMultiplier === null ? '—' : `${game.bestMultiplier.toFixed(2)}×`;
    row.append(name, rounds, rate, wagered, netCell, best);
    body.appendChild(row);
  }
  table.append(head, body);
  wrap.appendChild(table);
  card.appendChild(wrap);
  return card;
}

function favourites(cases) {
  const card = el('section', 'stats__panel');
  const label = el('span', 'stats__label');
  label.textContent = 'Favourite crates';
  card.appendChild(label);

  const table = el('table', 'dtable');
  const body = el('tbody');
  for (const entry of cases) {
    const row = el('tr');
    const name = el('td', 'dtable__name');
    name.textContent = entry.name;
    const opens = el('td', 'dtable__num mono');
    opens.textContent = `${entry.opens}x`;
    const spent = el('td', 'dtable__num mono dtable__dim');
    spent.textContent = money(Number(entry.spentMinor));
    row.append(name, opens, spent);
    body.appendChild(row);
  }
  table.appendChild(body);
  card.appendChild(table);
  return card;
}

function notice(kind, message) {
  const card = el('div', `${kind}__notice`);
  const line = el('p');
  line.textContent = message;
  card.appendChild(line);
  return card;
}
