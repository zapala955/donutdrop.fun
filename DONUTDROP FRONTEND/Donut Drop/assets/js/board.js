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
import { mountCrowns } from './crowns.js';
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
  mountCrowns($('#crownsRoot', view));
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

/* The statistics page (rewritten 2026-11-11, the owner: "rewrite the statistics page"). Top to
 * bottom: the result (net, signed, with what it came from), three highlights (biggest win, best
 * multiplier, favourite game), every game as a row with its share of the wagering, then rewards
 * and favourite crates. Every figure is GET /v1/statistics's; this page only lays them out.
 *
 * Net result is the games' own (paid minus wagered). Rewards are money the site gave, counted
 * beside it and never inside it, and the page says so. */

let statsLoading = false;

/* Each game's own art, from the lobby. A game added later falls back to a chest. */
const GAME_ART = {
  cases: 'game-crates.svg',
  chicken: 'chicken.svg',
  dice: 'dice.svg',
  slots: 'game-ore-rush.svg',
};
const KNOWN_ART = new Set([
  'crash', 'mines', 'tower', 'plinko', 'limbo', 'blackjack', 'roulette', 'upgrader', 'coinflip',
  'mines-duel', 'battles', 'derby', 'fishing', 'ice-fishing', 'monument', 'ore-rush',
]);
const gameArt = (key) =>
  `assets/img/items/${GAME_ART[key] ?? (KNOWN_ART.has(key) ? `game-${key}.svg` : 'chest.png')}`;

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
  statsRoot.classList.add('st');

  if (!state.authenticated) {
    statsRoot.appendChild(emptyCard('chest.png', 'Your numbers live here', 'Log in to see what you have wagered, won and played.', ['Log in', () => $('#loginBtn')?.click()]));
    return;
  }
  const data = state.statistics;
  if (!data) {
    const message = notice('stats', statsLoading ? 'Loading your statistics…' : 'Statistics could not be loaded. Try again in a moment.');
    if (statsLoading) message.setAttribute('aria-busy', 'true');
    statsRoot.appendChild(message);
    return;
  }

  const totals = data.totals;
  if (!totals.rounds) {
    statsRoot.appendChild(emptyCard('xp_bottle.png', 'No rounds yet', 'Your numbers start with your first bet.', ['Pick a game', '/']));
    return;
  }

  statsRoot.appendChild(result(totals));
  statsRoot.appendChild(highlights(data));
  statsRoot.appendChild(byGame(data.games));
  statsRoot.appendChild(rewards(totals));
  if (data.favouriteCases.length) statsRoot.appendChild(favourites(data.favouriteCases));
}

/** The sign written out, so a result reads the same to a colour-blind player and in greyscale. */
function signedMoney(n) {
  return n > 0 ? '+' + money(n) : n < 0 ? '−' + money(-n) : '$0';
}
const tone = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '');
const times = (x) => (x === null || x === undefined ? '—' : `${Number(x).toFixed(2)}×`);

function art(src, size) {
  const slot = el('span', 'st__slot');
  slot.innerHTML = `<img src="${src}" alt="" width="${size}" height="${size}">`;
  return slot;
}

function emptyCard(sprite, title, text, action) {
  const card = el('section', 'st__empty');
  card.appendChild(art(`assets/img/items/${sprite}`, 32));
  const copy = el('div', 'st__emptycopy');
  const h = el('h2', 'st__emptytitle');
  h.textContent = title;
  const p = el('p', 'st__emptytext');
  p.textContent = text;
  copy.append(h, p);
  card.appendChild(copy);
  if (action) {
    const [label, target] = action;
    const go = el(typeof target === 'string' ? 'a' : 'button', 'btn btn--go st__emptygo');
    go.textContent = label;
    if (typeof target === 'string') go.href = target;
    else { go.type = 'button'; go.addEventListener('click', target); }
    card.appendChild(go);
  }
  return card;
}

/* The one figure the page is about, then what it came from. */
function result(totals) {
  const net = Number(totals.netMinor);
  const card = el('section', 'st__hero');
  const main = el('div', 'st__heromain');
  const k = el('span', 'st__k');
  k.textContent = 'Net result';
  const v = el('b', 'st__net');
  if (tone(net)) v.dataset.dir = tone(net);
  v.textContent = signedMoney(net);
  const line = el('p', 'st__line');
  line.textContent = `From ${totals.rounds.toLocaleString('en-US')} rounds: ${money(Number(totals.wageredMinor))} wagered, ${money(Number(totals.paidMinor))} paid back.`;
  main.append(k, v, line);

  const figures = el('div', 'st__figures');
  for (const [label, value] of [
    ['Wagered', money(Number(totals.wageredMinor))],
    ['Rounds', totals.rounds.toLocaleString('en-US')],
    ['Win rate', totals.winRate === null ? '—' : pct(totals.winRate, 1)],
  ]) {
    const cell = el('div', 'st__fig');
    const key = el('span', 'st__k');
    key.textContent = label;
    const figure = el('b', 'st__v');
    figure.textContent = value;
    cell.append(key, figure);
    figures.appendChild(cell);
  }
  card.append(main, figures);
  return card;
}

function highlights(data) {
  const row = el('section', 'st__highs');
  const biggest = data.biggestWin;
  const fav = data.favouriteGame;
  const favRow = fav ? data.games.find((game) => game.game === fav.game) : null;
  const cards = [
    [
      biggest ? gameArt(biggest.game) : 'assets/img/items/gold_ingot.png',
      'Biggest win',
      biggest ? signedMoney(Number(biggest.payoutMinor) - Number(biggest.wagerMinor)) : '—',
      biggest ? `${money(Number(biggest.wagerMinor))} at ${times(biggest.multiplier)} on ${biggest.name}` : 'No win yet',
      'gold',
    ],
    ['assets/img/items/nether_star.png', 'Best multiplier', times(data.bestMultiplier), 'Your highest, in any game', 'gold'],
    [
      fav ? gameArt(fav.game) : 'assets/img/items/chest.png',
      'Favourite game',
      fav?.name ?? '—',
      favRow ? `${favRow.rounds.toLocaleString('en-US')} rounds` : '',
      '',
    ],
  ];
  for (const [src, label, value, sub, accent] of cards) {
    const card = el('div', 'st__high');
    card.appendChild(art(src, 32));
    const copy = el('div', 'st__highcopy');
    const k = el('span', 'st__k');
    k.textContent = label;
    const v = el('b', 'st__highv');
    if (accent) v.dataset.tone = accent;
    v.textContent = value;
    const s = el('span', 'st__highsub');
    s.textContent = sub;
    copy.append(k, v, s);
    card.appendChild(copy);
    row.appendChild(card);
  }
  return row;
}

/** Every game the player has played, most wagered first, with its share of the wagering. */
function byGame(games) {
  const card = el('section', 'st__panel');
  const head = el('div', 'st__panelhead');
  const title = el('h2', 'st__h');
  title.textContent = 'By game';
  const note = el('span', 'st__hnote');
  note.textContent = `${games.length} game${games.length === 1 ? '' : 's'}`;
  head.append(title, note);
  card.appendChild(head);

  const sorted = [...games].sort((a, b) => Number(b.wageredMinor) - Number(a.wageredMinor));
  const total = sorted.reduce((sum, game) => sum + Number(game.wageredMinor), 0) || 1;
  const list = el('div', 'st__games');
  const header = el('div', 'st__grow st__grow--head');
  header.innerHTML = '<span>Game</span><span>Rounds</span><span>Win rate</span><span>Wagered</span><span>Net</span><span>Best</span>';
  list.appendChild(header);
  for (const game of sorted) {
    const row = el('div', 'st__grow');
    const name = el('span', 'st__gname');
    name.appendChild(art(gameArt(game.game), 24));
    const label = el('span', 'st__gtext');
    const n = el('b');
    n.textContent = game.name;
    const share = Number(game.wageredMinor) / total;
    const bar = el('span', 'st__share');
    bar.setAttribute('aria-hidden', 'true');
    const fill = el('i');
    fill.style.transform = `scaleX(${Math.max(0.02, Math.min(1, share))})`;
    bar.appendChild(fill);
    const shareText = el('span', 'st__sharetext');
    shareText.textContent = `${pct(share, 0)} of your wagering`;
    label.append(n, bar, shareText);
    name.appendChild(label);

    const cell = (text, cls, label) => {
      const c = el('span', `st__gcell ${cls ?? ''}`.trim());
      c.dataset.label = label;
      c.textContent = text;
      return c;
    };
    const net = Number(game.netMinor);
    const netCell = cell(signedMoney(net), 'st__gnet', 'Net');
    if (tone(net)) netCell.dataset.dir = tone(net);
    row.append(
      name,
      cell(game.rounds.toLocaleString('en-US'), '', 'Rounds'),
      cell(pct(game.wins / game.rounds, 1), 'st__dim', 'Win rate'),
      cell(money(Number(game.wageredMinor)), '', 'Wagered'),
      netCell,
      cell(times(game.bestMultiplier), 'st__dim', 'Best'),
    );
    list.appendChild(row);
  }
  card.appendChild(list);
  return card;
}

function rewards(totals) {
  const card = el('section', 'st__reward');
  card.appendChild(art('assets/img/items/chest.png', 28));
  const copy = el('div', 'st__rewardcopy');
  const k = el('span', 'st__k');
  k.textContent = 'Rewards claimed';
  const v = el('b', 'st__v');
  v.dataset.tone = 'gold';
  v.textContent = money(Number(totals.rewardsMinor));
  const p = el('p', 'st__line');
  p.textContent = 'Rakeback, daily rewards, codes and bonuses. Not counted in your net result.';
  copy.append(k, v, p);
  card.appendChild(copy);
  return card;
}

function favourites(cases) {
  const card = el('section', 'st__panel');
  const head = el('div', 'st__panelhead');
  const title = el('h2', 'st__h');
  title.textContent = 'Favourite crates';
  head.appendChild(title);
  card.appendChild(head);
  const list = el('div', 'st__crates');
  for (const entry of cases) {
    const row = el('div', 'st__crate');
    row.appendChild(art('assets/img/items/game-crates.svg', 24));
    const name = el('b', 'st__cratename');
    name.textContent = entry.name;
    const opens = el('span', 'st__crateopens');
    opens.textContent = `${entry.opens.toLocaleString('en-US')} opened`;
    const spent = el('span', 'st__cratespent');
    spent.textContent = money(Number(entry.spentMinor));
    row.append(name, opens, spent);
    list.appendChild(row);
  }
  card.appendChild(list);
  return card;
}

function notice(kind, message) {
  const card = el('div', `${kind}__notice`);
  const line = el('p');
  line.textContent = message;
  card.appendChild(line);
  return card;
}
