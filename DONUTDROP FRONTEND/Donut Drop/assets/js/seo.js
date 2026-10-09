/* seo.js — what each route tells a search engine, and what its browser tab says.
 *
 * Every route is one HTML shell, so without this every page Google rendered had the home page's
 * title, description and (missing) canonical URL, and /crash competed with / for the same words.
 * The router calls applyRouteMeta() on every navigation; Google renders the script and reads the
 * result.
 *
 * Every route has an entry, and every title leads with the name: "DonutWin Crash", "DonutWin
 * Referrals". Another DonutSMP site uses the same name on a .com, so the name has to be on every
 * page before the page's subject, or a search for it finds theirs first. The home title says
 * DonutWin.fun so the two are told apart in a results list. A test holds this, the sitemap and the
 * router's route list together.
 *
 * Account pages (PRIVATE_ROUTES) still get a title for the tab, but say noindex: they render
 * nothing but a sign-in prompt to a crawler, and a search result that lands there is a dead end.
 *
 * The copy describes what each page does and nothing else. No figures, no promises: a search
 * snippet is the first thing a new player reads about the site.
 */

export const SITE_ORIGIN = 'https://donutwin.fun';

/** Every route, public ones in the order sitemap.xml lists them. `home` is served at `/`. */
export const ROUTE_META = {
  home: {
    title: 'DonutWin.fun — DonutSMP Crash, Mines, Coinflip & Cases',
    description:
      'Play crash, mines, plinko, coinflip, blackjack, roulette, cases, case battles and the ' +
      'upgrader with DonutSMP money. Deposit and withdraw in game.',
  },
  crates: {
    title: 'DonutWin Cases — Open DonutSMP Cases',
    description:
      'Open DonutSMP cases on DonutWin. Every case shows its full drop table, odds and house ' +
      'edge before you pay.',
  },
  battles: {
    title: 'DonutWin Case Battles — DonutSMP Case Battles',
    description:
      'Case battles on DonutWin: open the same DonutSMP cases head to head against other ' +
      'players for the pot.',
  },
  upgrader: {
    title: 'DonutWin Upgrader — DonutSMP Upgrader',
    description:
      'The DonutWin upgrader: choose a bigger target, see your winning window on the wheel, ' +
      'and play for it with DonutSMP money.',
  },
  crash: {
    title: 'DonutWin Crash — DonutSMP Crash',
    description:
      'Play crash with DonutSMP money on DonutWin: the multiplier climbs until it crashes, so ' +
      'cash out before it does.',
  },
  mines: {
    title: 'DonutWin Mines — DonutSMP Mines',
    description:
      'Play mines with DonutSMP money on DonutWin: pick tiles, avoid the mines, and cash out ' +
      'whenever you like.',
  },
  plinko: {
    title: 'DonutWin Plinko — DonutSMP Plinko',
    description: 'Play plinko with DonutSMP money on DonutWin: drop a ball and win where it lands.',
  },
  coinflip: {
    title: 'DonutWin Coinflip — DonutSMP Coinflip',
    description: 'Coinflip against other players for DonutSMP money on DonutWin.',
  },
  'mines-duel': {
    title: 'DonutWin Mines Duel — DonutSMP 1v1 Mines',
    description: 'Mines Duel on DonutWin: play mines head to head against another player.',
  },
  'skill-duel': {
    title: 'DonutWin 1v1 Skill Duels — DonutSMP',
    description: 'Challenge another player to a 1v1 skill duel for DonutSMP money on DonutWin.',
  },
  blackjack: {
    title: 'DonutWin Blackjack — DonutSMP Blackjack',
    description: 'Play blackjack against the dealer with DonutSMP money on DonutWin.',
  },
  roulette: {
    title: 'DonutWin Roulette — DonutSMP Roulette',
    description: 'Play roulette with DonutSMP money on DonutWin.',
  },
  referrals: {
    title: 'DonutWin Referrals — Invite & Earn',
    description:
      'Invite players to DonutWin and earn a share of the house margin on what they play, never ' +
      'a cut of their losses.',
  },
  fairness: {
    title: 'DonutWin Provably Fair — Verify a Round',
    description: 'How DonutWin generates every game result, and how to verify a round yourself.',
  },
  vip: {
    title: 'DonutWin VIP & Rakeback',
    description: 'The DonutWin VIP levels and the rakeback each level pays back on your wagers.',
  },
  'daily-rewards': {
    title: 'DonutWin Daily Rewards',
    description: 'Claim a free DonutSMP money reward on DonutWin every day; keep a streak for more.',
  },
  race: {
    title: 'DonutWin Wager Race',
    description:
      'The DonutWin wager race: every wager on the site counts, and the top of the board wins ' +
      'the prize pool.',
  },
  leaderboard: {
    title: 'DonutWin Leaderboard',
    description: 'The top DonutWin players.',
  },
  discord: {
    title: 'DonutWin Discord — Join & Link Your Account',
    description:
      'Join the DonutWin Discord, then link your account with /link for the server rewards.',
  },
  'creator-media': {
    title: 'DonutWin Creator & Media Programme',
    description: 'Make DonutSMP content? Apply to the DonutWin creator and media programme.',
  },
  support: {
    title: 'DonutWin Support',
    description: 'Get help with DonutWin deposits, withdrawals and your account.',
  },
  terms: {
    title: 'DonutWin Terms',
    description: 'The DonutWin terms of use.',
  },

  /* ── account pages: a title for the tab, never indexed ── */
  profile: { title: 'DonutWin Profile', description: 'Your DonutWin profile.' },
  wallet: {
    title: 'DonutWin Wallet',
    description: 'Your DonutWin balance, deposits and withdrawals.',
  },
  history: { title: 'DonutWin History', description: 'Your DonutWin game and payment history.' },
  settings: { title: 'DonutWin Settings', description: 'Your DonutWin account settings.' },
  statistics: { title: 'DonutWin Statistics', description: 'Your DonutWin statistics.' },
  rewards: {
    title: 'DonutWin Rewards',
    description: 'Claim your DonutWin rakeback and rewards.',
  },
  studio: {
    title: 'DonutWin Case Studio',
    description: 'Build your own DonutWin case.',
  },
  war: { title: 'DonutWin Faction War', description: 'The DonutWin faction war.' },
  quests: { title: 'DonutWin Quests', description: 'Your DonutWin quests and streak.' },
};

/** Pages for one signed-in player, and retired ones. Rendered for nobody else, so never indexed. */
export const PRIVATE_ROUTES = new Set([
  'profile',
  'wallet',
  'history',
  'settings',
  'statistics',
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
  const title = meta?.title ?? ROUTE_META.home.title;
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
