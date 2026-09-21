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
import { API_BASE_URL } from './api.js';
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
    const avatar = playerAvatar(entry.playerId);
    const name = el('span', 'dtable__name');
    name.textContent = entry.username;
    player.append(avatar, name);

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

/**
 * A leaderboard is public, so the browser asks our same-origin proxy for the head using the
 * opaque player id. The masked Minecraft name never appears in an image URL. If a skin is not
 * available, the empty tile's CSS silhouette remains visible instead of putting the initial back.
 */
function playerAvatar(playerId) {
  const avatar = el('span', 'dtable__avatar');
  avatar.setAttribute('aria-hidden', 'true');
  if (!playerId) return avatar;

  const art = document.createElement('img');
  art.alt = '';
  art.loading = 'lazy';
  art.src = `${API_BASE_URL}/v1/avatars/${encodeURIComponent(playerId)}?s=22`;
  art.addEventListener('error', () => art.remove());
  avatar.appendChild(art);
  return avatar;
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

export function mountStatistics(view) {
  statsRoot = $('#statsRoot', view);
  if (!statsRoot) return;
  if (!statsRoot.dataset.built) {
    statsRoot.dataset.built = '1';
    bus.addEventListener('change', (event) => {
      if (!statsRoot.isConnected) return;
      if (['statistics', 'login', 'logout', 'ready', 'private'].includes(event.detail)) {
        paintStats();
      }
    });
  }
  if (state.authenticated) refreshStatistics(false).then(paintStats).catch(() => undefined);
  paintStats();
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
    statsRoot.appendChild(notice('stats', 'Statistics are unavailable.'));
    return;
  }

  const net = Number(data.totals.netMinor);
  statsRoot.appendChild(
    statGrid([
      ['Total wagered', money(Number(data.totals.wageredMinor)), null],
      // The one figure on the page that is allowed to be red: a player's own result.
      ['Net profit / loss', money(net), net >= 0 ? 'up' : 'down'],
      [
        'Upgrader win rate',
        data.upgrader.winRate === null ? '—' : pct(data.upgrader.winRate, 1),
        null,
      ],
      [
        'Best multiplier',
        data.upgrader.bestMultiple === null ? '—' : `${data.upgrader.bestMultiple.toFixed(2)}x`,
        'gold',
      ],
    ]),
  );

  statsRoot.appendChild(
    breakdown('Upgrader', [
      ['Rounds', String(data.upgrader.rounds)],
      ['Wins', String(data.upgrader.wins)],
      ['Losses', String(data.upgrader.losses)],
      ['Staked', money(Number(data.upgrader.stakedMinor))],
      ['Returned', money(Number(data.upgrader.returnedMinor))],
    ]),
  );

  statsRoot.appendChild(
    breakdown('Crates & battles', [
      ['Crates opened', String(data.cases.opened)],
      ['Crate spend', money(Number(data.cases.spentMinor))],
      ['Battle seats', String(data.battles.seats)],
      ['Battle stake', money(Number(data.battles.stakedMinor))],
      ['Battle winnings', money(Number(data.battles.wonMinor))],
    ]),
  );

  if (data.favouriteCases.length) {
    statsRoot.appendChild(favourites(data.favouriteCases));
  }
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

function breakdown(title, rows) {
  const card = el('section', 'stats__panel');
  const label = el('span', 'stats__label');
  label.textContent = title;
  card.appendChild(label);

  const list = el('dl', 'stats__facts mono');
  for (const [term, value] of rows) {
    const group = el('div');
    const dt = el('dt');
    dt.textContent = term;
    const dd = el('dd');
    dd.textContent = value;
    group.append(dt, dd);
    list.appendChild(group);
  }
  card.appendChild(list);
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
