/* seo.js — what each route tells a search engine.
 *
 * Every route is one HTML shell, so without this every page Google rendered had the home page's
 * title, description and (missing) canonical URL, and /crash competed with / for the same words.
 * The router calls applyRouteMeta() on every navigation; Google renders the script and reads the
 * result.
 *
 * Public routes are listed in sitemap.xml and must have an entry here (a test holds the two
 * together). Account pages say noindex: they render nothing but a sign-in prompt to a crawler, and
 * a search result that lands a visitor on one is a dead end.
 *
 * The copy describes what each page does and nothing else. No figures, no promises: a search
 * snippet is the first thing a new player reads about the site.
 */

export const SITE_ORIGIN = 'https://donutwin.fun';

/** Routes with public content, in the order sitemap.xml lists them. `home` is served at `/`. */
export const ROUTE_META = {
  home: {
    title: 'DonutWin — DonutSMP Crash, Mines, Coinflip, Cases & More',
    description:
      'Play crash, mines, plinko, coinflip, blackjack, roulette, cases, case battles and the ' +
      'upgrader with DonutSMP money. Deposit and withdraw in game.',
  },
  crates: {
    title: 'DonutSMP Cases | DonutWin',
    description:
      'Open DonutSMP cases on DonutWin. Every case shows its full drop table, odds and house ' +
      'edge before you pay.',
  },
  battles: {
    title: 'DonutSMP Case Battles | DonutWin',
    description:
      'Case battles on DonutWin: open the same DonutSMP cases head to head against other ' +
      'players for the pot.',
  },
  upgrader: {
    title: 'DonutSMP Upgrader | DonutWin',
    description:
      'The DonutWin upgrader: choose a bigger target, see your winning window on the wheel, ' +
      'and play for it with DonutSMP money.',
  },
  crash: {
    title: 'DonutSMP Crash | DonutWin',
    description:
      'Play crash with DonutSMP money on DonutWin: the multiplier climbs until it crashes, so ' +
      'cash out before it does.',
  },
  mines: {
    title: 'DonutSMP Mines | DonutWin',
    description:
      'Play mines with DonutSMP money on DonutWin: pick tiles, avoid the mines, and cash out ' +
      'whenever you like.',
  },
  plinko: {
    title: 'DonutSMP Plinko | DonutWin',
    description: 'Play plinko with DonutSMP money on DonutWin: drop a ball and win where it lands.',
  },
  coinflip: {
    title: 'DonutSMP Coinflip | DonutWin',
    description: 'Coinflip against other players for DonutSMP money on DonutWin.',
  },
  'mines-duel': {
    title: 'DonutSMP Mines Duel | DonutWin',
    description: 'Mines Duel on DonutWin: play mines head to head against another player.',
  },
  'skill-duel': {
    title: 'DonutSMP 1v1 Skill Duels | DonutWin',
    description: 'Challenge another player to a 1v1 skill duel for DonutSMP money on DonutWin.',
  },
  blackjack: {
    title: 'DonutSMP Blackjack | DonutWin',
    description: 'Play blackjack against the dealer with DonutSMP money on DonutWin.',
  },
  roulette: {
    title: 'DonutSMP Roulette | DonutWin',
    description: 'Play roulette with DonutSMP money on DonutWin.',
  },
  fairness: {
    title: 'Provably Fair | DonutWin',
    description:
      'How DonutWin generates every game result, and how to verify a round yourself.',
  },
  vip: {
    title: 'VIP & Rakeback | DonutWin',
    description: 'The DonutWin VIP levels and the rakeback each level pays back on your wagers.',
  },
  'daily-rewards': {
    title: 'Daily Rewards | DonutWin',
    description: 'Claim a free DonutSMP money reward on DonutWin every day; keep a streak for more.',
  },
  race: {
    title: 'Wager Race | DonutWin',
    description:
      'The DonutWin wager race: every wager on the site counts, and the top of the board wins ' +
      'the prize pool.',
  },
  leaderboard: {
    title: 'Leaderboard | DonutWin',
    description: 'The top DonutWin players.',
  },
  discord: {
    title: 'Discord | DonutWin',
    description:
      'Join the DonutWin Discord, then link your account with /link for the server rewards.',
  },
  'creator-media': {
    title: 'Creator & Media Programme | DonutWin',
    description: 'Make DonutSMP content? Apply to the DonutWin creator and media programme.',
  },
  support: {
    title: 'Support | DonutWin',
    description: 'Get help with DonutWin deposits, withdrawals and your account.',
  },
  terms: {
    title: 'Terms | DonutWin',
    description: 'The DonutWin terms of use.',
  },
};

/** Pages for one signed-in player, and retired ones. Rendered for nobody else, so never indexed. */
export const PRIVATE_ROUTES = new Set([
  'profile',
  'wallet',
  'history',
  'settings',
  'statistics',
  'referrals',
  'rewards',
  'studio',
  'war',
  'quests',
]);

/** The URL a route is known by. Home is `/`, never `/home`, so the two are one page to Google. */
export function canonicalUrl(route) {
  return route === 'home' ? `${SITE_ORIGIN}/` : `${SITE_ORIGIN}/${route}`;
}

function setMeta(selector, attribute, value) {
  const node = document.head.querySelector(selector);
  if (node) node.setAttribute(attribute, value);
}

export function applyRouteMeta(route) {
  const meta = ROUTE_META[route];
  const indexable = Boolean(meta) && !PRIVATE_ROUTES.has(route);
  const title = meta?.title ?? 'DonutWin';
  const description = meta?.description ?? ROUTE_META.home.description;
  const url = canonicalUrl(meta ? route : 'home');

  document.title = title;
  setMeta('meta[name="description"]', 'content', description);
  setMeta('meta[name="robots"]', 'content', indexable ? 'index, follow' : 'noindex, follow');
  setMeta('link[rel="canonical"]', 'href', url);
  setMeta('meta[property="og:title"]', 'content', title);
  setMeta('meta[property="og:description"]', 'content', description);
  setMeta('meta[property="og:url"]', 'content', url);
  setMeta('meta[name="twitter:title"]', 'content', title);
  setMeta('meta[name="twitter:description"]', 'content', description);
}
