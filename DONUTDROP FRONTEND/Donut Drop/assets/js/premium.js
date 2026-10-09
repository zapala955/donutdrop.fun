/* premium.js — the premium design preview (donutwin.fun/test).
 *
 * Does nothing unless ui-mode.js switched the preview on for this browser. When it is on, this
 * adds the new chrome -- a sidebar, a phone bar and the lobby -- around the same views, the same
 * routes and the same game code everybody else uses. Nothing here replaces app logic: links go
 * through the app's own router, chat opens through its own button, the wallet buttons are the
 * header's own. premium.css restyles everything underneath.
 *
 * See design.md for the system this follows.
 */
import { api } from './api.js';
import { currentRouteName, onNavigate } from './routing.js';
import { money } from './util.js';

const KEY = 'donutwin:ui';
const ITEMS = '/assets/img/items/';

/* 24-unit stroke icons. Drawn for this set; the Discord mark is the one filled glyph. */
const ICONS = {
  lobby: 'M4 11.2 12 4.5l8 6.7V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z',
  crash: 'M4 19.5 9.5 13l3.5 3.2L20 8M14.5 8H20v5.5',
  mines: 'M7 4.5h10l3.5 5L12 20 3.5 9.5zM3.5 9.5h17M9.5 4.5 12 9.5l2.5-5',
  plinko: 'M12 5.2a1.3 1.3 0 1 0 0 .1M8.5 10.2a1.3 1.3 0 1 0 0 .1M15.5 10.2a1.3 1.3 0 1 0 0 .1M5 15.2a1.3 1.3 0 1 0 0 .1M12 15.2a1.3 1.3 0 1 0 0 .1M19 15.2a1.3 1.3 0 1 0 0 .1M4 20h16',
  blackjack: 'M5.5 7.5 13 5.5l3.2 12-7.5 2zM15.2 6.4l3.3.9L15.5 19M8.6 11.5l2.4-.6',
  roulette: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17M12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6M12 3.5v4.7M12 15.8v4.7M3.5 12h4.7M15.8 12h4.7',
  upgrader: 'M6.5 12.5 12 7l5.5 5.5M6.5 18 12 12.5l5.5 5.5',
  cases: 'M4 10.5V9a4.5 4.5 0 0 1 4.5-4.5h7A4.5 4.5 0 0 1 20 9v1.5M4 10.5h16V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zM10.5 10.5v3.5h3v-3.5',
  battles: 'M4 4l9.5 9.5M13.5 13.5l-1.5 3 3.5 3.5 1.5-1.5L20 20M20 4l-9.5 9.5M10.5 13.5l1.5 3-3.5 3.5L7 18.5 4 20',
  studio: 'M4 10.5V9a4.5 4.5 0 0 1 4.5-4.5h7A4.5 4.5 0 0 1 20 9v1.5M4 10.5h16V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zM12 13v4M10 15h4',
  coinflip: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17M14.6 9.2c-.6-.8-1.5-1.2-2.6-1.2-1.6 0-2.6.8-2.6 1.9 0 2.6 5.4 1.4 5.4 4.2 0 1.1-1.1 2-2.8 2-1.2 0-2.2-.5-2.8-1.3M12 6.5V8M12 16v1.5',
  minesduel: 'M7 3.5h4l2 3-4 5-4-5zM15 12.5h4l2 3-4 5-4-5zM8.5 13.5 4 20M16 4l4.5 6',
  skillduel: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17M12 7.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9M12 11.2a.8.8 0 1 0 0 1.6.8.8 0 0 0 0-1.6',
  vip: 'M4 18h16M4 18l-1.5-9 5 3.5L12 5l4.5 7.5 5-3.5L20 18',
  rewards: 'M4 10h16v10H4zM3 7h18v3H3zM12 7v13M12 7H8.5a2.5 2.5 0 1 1 0-5C11 2 12 7 12 7zM12 7h3.5a2.5 2.5 0 1 0 0-5C13 2 12 7 12 7z',
  daily: 'M5.5 5h13A2.5 2.5 0 0 1 21 7.5v11a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 18.5v-11A2.5 2.5 0 0 1 5.5 5zM3 10h18M8 3v4M16 3v4M9 15l2 2 4-4',
  race: 'M5 21V4M5 5h11l-1.6 3L16 11H5',
  leaderboard: 'M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0zM17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3',
  invite: 'M9 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6M3 20a6 6 0 0 1 12 0M17 11h4M19 9v4',
  media: 'M5 6h8A2.5 2.5 0 0 1 15.5 8.5v7A2.5 2.5 0 0 1 13 18H5a2.5 2.5 0 0 1-2.5-2.5v-7A2.5 2.5 0 0 1 5 6zM15.5 11l6-3v8l-6-3z',
  fairness: 'M12 3l7.5 3v5.5c0 4.4-3.1 8.3-7.5 9.5-4.4-1.2-7.5-5.1-7.5-9.5V6zM9 12l2 2 4-4',
  support: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M9.6 9.5a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .8-1 1.5v.4M12 17h.01',
  terms: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h4',
  menu: 'M4 7h16M4 12h16M4 17h16',
  chat: 'M4.5 5.5h15v10.5H10l-4.5 3.5V16h-1z',
  wallet: 'M5.5 6h13A2.5 2.5 0 0 1 21 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5v-9A2.5 2.5 0 0 1 5.5 6zM3 10h18M16.5 14.8a.8.8 0 1 0 0-1.6.8.8 0 0 0 0 1.6',
  search: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13M15.5 15.5 20 20',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  exit: 'M10 17l-5-5 5-5M5 12h11M13 5h4a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-4',
};
const DISCORD =
  'M19.2 5.3A16.3 16.3 0 0 0 15.1 4l-.5 1.1a15 15 0 0 0-5.2 0L8.9 4a16.3 16.3 0 0 0-4.1 1.3C2.2 9.2 1.5 13 1.9 16.7A16.6 16.6 0 0 0 7 19.3l1.2-1.7c-.7-.3-1.4-.7-2-1.2l.5-.4c3.8 1.8 7.9 1.8 11.6 0l.5.4c-.6.5-1.3.9-2 1.2l1.2 1.7a16.6 16.6 0 0 0 5.1-2.6c.5-4.3-.8-8.1-2.9-11.4ZM8.5 14.5c-1 0-1.9-.9-1.9-2s.8-2 1.9-2 1.9.9 1.9 2-.9 2-1.9 2Zm7 0c-1 0-1.9-.9-1.9-2s.8-2 1.9-2 1.9.9 1.9 2-.8 2-1.9 2Z';

/** Every game, once: the sidebar, the lobby tiles and the search all read this list. */
const GAMES = [
  { route: 'crash', name: 'Crash', icon: 'crash', art: 'elytra.png', cat: 'casino' },
  { route: 'mines', name: 'Mines', icon: 'mines', art: 'tnt.png', cat: 'casino' },
  { route: 'plinko', name: 'Plinko', icon: 'plinko', art: 'slime_ball.png', cat: 'casino' },
  { route: 'blackjack', name: 'Blackjack', icon: 'blackjack', art: 'enchanted_book.png', cat: 'casino' },
  { route: 'roulette', name: 'Roulette', icon: 'roulette', art: 'nether_star.png', cat: 'casino' },
  { route: 'upgrader', name: 'Upgrader', icon: 'upgrader', art: 'netherite_ingot.png', cat: 'casino' },
  { route: 'crates', name: 'Cases', icon: 'cases', art: 'chest.png', cat: 'cases' },
  { route: 'battles', name: 'Case Battles', icon: 'battles', art: 'netherite_sword.png', cat: 'cases' },
  { route: 'studio', name: 'Community Cases', icon: 'studio', art: 'ender_chest.png', cat: 'cases' },
  { route: 'coinflip', name: 'Coinflip', icon: 'coinflip', art: 'gold_ingot.png', cat: 'pvp' },
  { route: 'mines-duel', name: 'Mines Duel', icon: 'minesduel', art: 'diamond.png', cat: 'pvp' },
  { route: 'skill-duel', name: '1v1 Skill', icon: 'skillduel', art: 'trident.png', cat: 'pvp' },
];

const NAV = [
  { label: null, items: [{ route: 'home', href: '/', name: 'Lobby', icon: 'lobby' }] },
  { label: 'Casino', items: GAMES.filter((game) => game.cat === 'casino') },
  { label: 'Cases', items: GAMES.filter((game) => game.cat === 'cases') },
  { label: 'Duels', items: GAMES.filter((game) => game.cat === 'pvp') },
  {
    label: 'Rewards',
    items: [
      { route: 'vip', name: 'VIP', icon: 'vip' },
      { route: 'rewards', name: 'Rewards', icon: 'rewards' },
      { route: 'daily-rewards', name: 'Daily Rewards', icon: 'daily' },
      { route: 'race', name: 'Wager Race', icon: 'race' },
      { route: 'leaderboard', name: 'Leaderboard', icon: 'leaderboard' },
    ],
  },
  {
    label: 'Community',
    items: [
      { route: 'referrals', name: 'Invite & Earn', icon: 'invite' },
      { route: 'discord', name: 'Discord', icon: 'discord' },
      { route: 'creator-media', name: 'Media Programme', icon: 'media' },
    ],
  },
  {
    label: 'Help',
    items: [
      { route: 'fairness', name: 'Provably Fair', icon: 'fairness' },
      { route: 'support', name: 'Support', icon: 'support' },
      { route: 'terms', name: 'Terms', icon: 'terms' },
    ],
  },
];

const CATEGORIES = [
  { id: 'all', name: 'All games' },
  { id: 'casino', name: 'Casino' },
  { id: 'cases', name: 'Cases' },
  { id: 'pvp', name: 'PvP duels' },
];

/* What the activity feed calls each game, as a player would. */
const FEED_GAMES = {
  case: 'Cases',
  upgrade: 'Upgrader',
  crash: 'Crash',
  mines: 'Mines',
  plinko: 'Plinko',
  blackjack: 'Blackjack',
  roulette: 'Roulette',
  coinflip: 'Coinflip',
  minesduel: 'Mines Duel',
};

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function icon(name) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', name === 'discord' ? 'picon picon--fill' : 'picon');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', name === 'discord' ? DISCORD : ICONS[name] ?? ICONS.lobby);
  svg.append(path);
  return svg;
}

function hrefFor(item) {
  return item.href ?? `/${item.route}`;
}

/* ─────────── the sidebar ─────────── */

function buildSidebar() {
  const side = node('aside', 'pside');
  side.id = 'pside';
  side.setAttribute('aria-label', 'Site');

  const brand = node('a', 'pside__brand');
  brand.href = '/';
  brand.setAttribute('aria-label', 'DonutWin lobby');
  const mark = node('img', 'pside__mark');
  mark.src = `${ITEMS}ender_chest.png`;
  mark.alt = '';
  const word = node('span', 'pside__word');
  word.append(document.createTextNode('Donut'), node('b', null, 'Win'));
  brand.append(mark, word);

  const nav = node('nav', 'pside__nav');
  nav.setAttribute('aria-label', 'Games and pages');
  for (const group of NAV) {
    const section = node('div', 'pside__group');
    if (group.label) section.append(node('p', 'pside__label', group.label));
    for (const item of group.items) {
      const link = node('a', 'pside__link');
      link.href = hrefFor(item);
      link.dataset.route = item.route;
      link.title = item.name;
      link.append(icon(item.icon), node('span', 'pside__text', item.name));
      section.append(link);
    }
    nav.append(section);
  }

  const foot = node('div', 'pside__foot');
  foot.append(node('p', 'pside__note', 'You are previewing the new design.'));
  const exit = node('button', 'pside__exit');
  exit.type = 'button';
  // The rail shows only the icon, so the name is kept for screen readers and as a tooltip.
  exit.setAttribute('aria-label', 'Back to the classic design');
  exit.title = 'Back to the classic design';
  exit.append(icon('exit'), node('span', 'pside__exit-text', 'Back to the classic design'));
  exit.addEventListener('click', leavePreview);
  foot.append(exit);

  side.append(brand, nav, foot);
  return side;
}

function leavePreview() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing stored, nothing to clear */
  }
  location.assign(`${location.pathname === '/test' ? '/' : location.pathname}?ui=classic`);
}

/* ─────────── the phone bar ─────────── */

function buildBar() {
  const bar = node('nav', 'pbar');
  bar.setAttribute('aria-label', 'Quick');

  const menu = node('button', 'pbar__item');
  menu.type = 'button';
  menu.dataset.act = 'menu';
  menu.setAttribute('aria-controls', 'pside');
  menu.setAttribute('aria-expanded', 'false');
  menu.append(icon('menu'), node('span', null, 'Menu'));

  const link = (route, href, name, iconName) => {
    const anchor = node('a', 'pbar__item');
    anchor.href = href;
    anchor.dataset.route = route;
    anchor.append(icon(iconName), node('span', null, name));
    return anchor;
  };

  const chat = node('button', 'pbar__item');
  chat.type = 'button';
  chat.dataset.act = 'chat';
  chat.setAttribute('aria-controls', 'chat');
  chat.setAttribute('aria-expanded', 'false');
  chat.append(icon('chat'), node('span', null, 'Chat'));

  bar.append(
    menu,
    link('home', '/', 'Lobby', 'lobby'),
    link('crates', '/crates', 'Cases', 'cases'),
    chat,
    link('wallet', '/wallet', 'Wallet', 'wallet'),
  );
  return bar;
}

function setMenuOpen(open) {
  document.body.classList.toggle('pside-open', open);
  for (const button of document.querySelectorAll('[data-act="menu"]')) {
    button.setAttribute('aria-expanded', String(open));
  }
}

function syncChatButtons() {
  const open = document.body.classList.contains('chat-open');
  for (const button of document.querySelectorAll('[data-act="chat"]')) {
    button.setAttribute('aria-expanded', String(open));
  }
}

/* ─────────── the lobby ─────────── */

const PROMOS = [
  {
    href: '/daily-rewards',
    art: 'golden_apple.png',
    title: 'Daily rewards',
    text: 'A free reward every day. Keep your streak going and it grows.',
  },
  {
    href: '/race',
    art: 'minecart.png',
    title: 'Wager race',
    text: 'Every bet on the site counts toward the board. The top players share the prize pool.',
  },
  {
    href: '/referrals',
    art: 'name_tag.png',
    title: 'Invite & earn',
    text: 'Bring your friends and earn a share of the house edge on everything they play.',
  },
];

function buildLobby() {
  const lobby = node('div', 'plobby');

  const promos = node('div', 'plobby__promos');
  for (const promo of PROMOS) {
    const card = node('a', 'ppromo');
    card.href = promo.href;
    const art = node('span', 'ppromo__art');
    const image = node('img');
    image.src = `${ITEMS}${promo.art}`;
    image.alt = '';
    art.append(image);
    const copy = node('span', 'ppromo__copy');
    copy.append(node('span', 'ppromo__title', promo.title), node('span', 'ppromo__text', promo.text));
    card.append(art, copy, icon('arrow'));
    promos.append(card);
  }

  const search = node('label', 'psearch');
  search.append(icon('search'));
  const input = node('input', 'psearch__input');
  input.type = 'search';
  input.placeholder = 'Search games';
  input.setAttribute('aria-label', 'Search games');
  input.autocomplete = 'off';
  search.append(input);

  const tabs = node('div', 'ptabs');
  tabs.setAttribute('role', 'group');
  tabs.setAttribute('aria-label', 'Game categories');
  for (const category of CATEGORIES) {
    const tab = node('button', 'ptabs__tab', category.name);
    tab.type = 'button';
    tab.dataset.cat = category.id;
    tab.setAttribute('aria-pressed', String(category.id === 'all'));
    tabs.append(tab);
  }

  const heading = node('h2', 'plobby__title', 'Games');
  const grid = node('div', 'pgrid');
  for (const game of GAMES) {
    const tile = node('a', 'ptile');
    tile.href = `/${game.route}`;
    tile.dataset.cat = game.cat;
    tile.dataset.name = game.name.toLowerCase();
    const image = node('img', 'ptile__art');
    image.src = `${ITEMS}${game.art}`;
    image.alt = '';
    image.loading = 'lazy';
    tile.append(image, node('span', 'ptile__name', game.name));
    grid.append(tile);
  }
  const empty = node('p', 'pgrid__empty', 'No game matches that search.');
  empty.hidden = true;

  const filter = () => {
    const query = input.value.trim().toLowerCase();
    const active = tabs.querySelector('[aria-pressed="true"]')?.dataset.cat ?? 'all';
    let shown = 0;
    for (const tile of grid.children) {
      const visible =
        (active === 'all' || tile.dataset.cat === active) && (!query || tile.dataset.name.includes(query));
      tile.hidden = !visible;
      if (visible) shown += 1;
    }
    empty.hidden = shown > 0;
  };
  input.addEventListener('input', filter);
  tabs.addEventListener('click', (event) => {
    const tab = event.target.closest('.ptabs__tab');
    if (!tab) return;
    for (const other of tabs.children) other.setAttribute('aria-pressed', String(other === tab));
    filter();
  });

  const betsTitle = node('h2', 'plobby__title', 'Latest bets');
  const bets = node('div', 'pbets');
  bets.append(node('p', 'pbets__empty', 'Loading the latest bets…'));

  lobby.append(promos, search, tabs, heading, grid, empty, betsTitle, bets);
  return lobby;
}

async function paintBets(host) {
  let rows;
  try {
    const data = await api.get('/v1/activity/recent');
    rows = (data.activities ?? []).filter((row) => FEED_GAMES[row.kind]).slice(0, 10);
  } catch {
    host.replaceChildren(node('p', 'pbets__empty', 'The latest bets could not be loaded.'));
    return;
  }
  if (!rows.length) {
    host.replaceChildren(node('p', 'pbets__empty', 'No bets yet.'));
    return;
  }
  const table = node('table', 'pbets__table');
  const head = node('thead');
  const headRow = node('tr');
  for (const label of ['Game', 'Player', 'Bet', 'Multiplier', 'Payout']) {
    headRow.append(node('th', null, label));
  }
  head.append(headRow);
  const body = node('tbody');
  for (const row of rows) {
    const wager = Number(row.wager_minor ?? 0);
    const payout = row.payout_minor === null || row.payout_minor === undefined ? null : Number(row.payout_minor);
    const tr = node('tr');
    tr.append(
      node('td', 'pbets__game', row.kind === 'case' && row.source_name ? row.source_name : FEED_GAMES[row.kind]),
      node('td', 'pbets__player', row.player ?? '—'),
      node('td', 'pbets__num', money(wager)),
      node('td', 'pbets__num', payout === null || wager <= 0 ? '—' : `${(payout / wager).toFixed(2)}×`),
    );
    const paid = node('td', 'pbets__num', payout === null ? '—' : money(payout));
    if (payout !== null) paid.dataset.result = payout > wager ? 'win' : 'loss';
    tr.append(paid);
    body.append(tr);
  }
  table.append(head, body);
  host.replaceChildren(table);
}

/* ─────────── wiring ─────────── */

function markActive() {
  const route = currentRouteName();
  for (const link of document.querySelectorAll('.pside__link, .pbar__item[data-route]')) {
    if (link.dataset.route === route) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

export function initPremium() {
  if (document.documentElement.dataset.ui !== 'premium') return;

  const side = buildSidebar();
  const scrim = node('div', 'pside-scrim');
  scrim.setAttribute('aria-hidden', 'true');
  const bar = buildBar();
  document.body.append(side, scrim, bar);

  const home = document.querySelector('.view[data-view="home"]');
  const lobby = buildLobby();
  home?.prepend(lobby);
  const bets = lobby.querySelector('.pbets');

  bar.addEventListener('click', (event) => {
    const button = event.target.closest('[data-act]');
    if (!button) return;
    if (button.dataset.act === 'menu') {
      setMenuOpen(!document.body.classList.contains('pside-open'));
    } else if (button.dataset.act === 'chat') {
      setMenuOpen(false);
      document.getElementById('burger')?.click();
    }
  });
  scrim.addEventListener('click', () => setMenuOpen(false));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && document.body.classList.contains('pside-open')) setMenuOpen(false);
  });
  /* The classic rail can be collapsed to a handle, and that flag outlives the switch. Here chat is
   * a drawer with no handle, and a collapsed flag would empty it, so it is kept at "open". */
  const keepChatUsable = () => {
    if (document.body.dataset.chatCollapsed === '1') document.body.dataset.chatCollapsed = '0';
    syncChatButtons();
  };
  new MutationObserver(keepChatUsable).observe(document.body, {
    attributes: true,
    attributeFilter: ['class', 'data-chat-collapsed'],
  });
  keepChatUsable();

  const onRoute = () => {
    setMenuOpen(false);
    markActive();
    if (currentRouteName() === 'home' && bets) void paintBets(bets);
  };
  onNavigate(onRoute);
  onRoute();
}
