/* seo.js — what each route tells a search engine, and what its browser tab says.
 *
 * Every route is one HTML shell, so without this every page Google rendered had the home page's
 * title, description and (missing) canonical URL, and /crash competed with / for the same words.
 * The router calls applyRouteMeta() on every navigation; Google renders the script and reads the
 * result.
 *
 * Every route has an entry, and every title leads with the name: "DonutLuxe Crash", "DonutLuxe
 * Referrals", so a search result says whose page it is before what the page is. The home title is
 * the brand and what it is -- "DonutLuxe – DonutSMP Casino" -- then the games, short enough that
 * Google shows it whole. (It said "DonutLuxe.com" from the days the site was DonutWin, a name another
 * DonutSMP site uses on a .com; DonutLuxe is the site's own, and the structured data in index.html
 * no longer lists DonutWin as another name for it.) A test holds this, the sitemap and the router's
 * route list together.
 *
 * Account pages (PRIVATE_ROUTES) still get a title for the tab, but say noindex: they render
 * nothing but a sign-in prompt to a crawler, and a search result that lands there is a dead end.
 *
 * The copy describes what each page does and nothing else. No figures, no promises: a search
 * snippet is the first thing a new player reads about the site.
 */

import { BASE } from './routing.js';

export const SITE_ORIGIN = 'https://donutluxe.com';

/** Every route, public ones in the order sitemap.xml lists them. `home` is served at `/`. */
export const ROUTE_META = {
  home: {
    title: 'DonutLuxe – DonutSMP Casino | Crash, Mines, Tower & More',
    description:
      'DonutLuxe is the DonutSMP casino: crash, mines, tower, chicken, plinko, blackjack, ' +
      'roulette, coinflip and case battles. Deposit and withdraw in game.',
  },
  crates: {
    title: 'DonutLuxe Cases — Open DonutSMP Cases',
    description:
      'Open DonutSMP cases on DonutLuxe. Every case shows its full drop table, odds and house ' +
      'edge before you pay.',
  },
  battles: {
    title: 'DonutLuxe Case Battles — DonutSMP Case Battles',
    description:
      'Case battles on DonutLuxe: open the same DonutSMP cases head to head against other ' +
      'players for the pot.',
  },
  upgrader: {
    title: 'DonutLuxe Upgrader — DonutSMP Upgrader',
    description:
      'The DonutLuxe upgrader: choose a bigger target, see your winning window on the wheel, ' +
      'and play for it with DonutSMP money.',
  },
  crash: {
    title: 'DonutLuxe Crash — DonutSMP Crash',
    description:
      'Play crash with DonutSMP money on DonutLuxe: the multiplier climbs until it crashes, so ' +
      'cash out before it does.',
  },
  mines: {
    title: 'DonutLuxe Mines — DonutSMP Mines',
    description:
      'Play mines with DonutSMP money on DonutLuxe: pick tiles, avoid the mines, and cash out ' +
      'whenever you like.',
  },
  tower: {
    title: 'DonutLuxe Tower — DonutSMP Tower',
    description:
      'Play tower with DonutSMP money on DonutLuxe: climb nine floors on easy, medium, hard or ' +
      'expert, dodge the TNT, and cash out whenever you like.',
  },
  chicken: {
    title: 'DonutLuxe Chicken — DonutSMP Chicken',
    description:
      'Play chicken with DonutSMP money on DonutLuxe: cross twenty minecart rails on easy, medium, ' +
      'hard or hardcore, and cash out before a minecart comes.',
  },
  plinko: {
    title: 'DonutLuxe Plinko — DonutSMP Plinko',
    description: 'Play plinko with DonutSMP money on DonutLuxe: drop a ball and win where it lands.',
  },
  coinflip: {
    title: 'DonutLuxe Coinflip — DonutSMP Coinflip',
    description: 'Coinflip against other players for DonutSMP money on DonutLuxe.',
  },
  'mines-duel': {
    title: 'DonutLuxe Mines Duel — DonutSMP 1v1 Mines',
    description: 'Mines Duel on DonutLuxe: play mines head to head against another player.',
  },
  'skill-duel': {
    title: 'DonutLuxe 1v1 Skill Duels — DonutSMP',
    description: 'Challenge another player to a 1v1 skill duel for DonutSMP money on DonutLuxe.',
  },
  blackjack: {
    title: 'DonutLuxe Blackjack — DonutSMP Blackjack',
    description: 'Play blackjack against the dealer with DonutSMP money on DonutLuxe.',
  },
  roulette: {
    title: 'DonutLuxe Roulette — DonutSMP Roulette',
    description: 'Play roulette with DonutSMP money on DonutLuxe.',
  },
  referrals: {
    title: 'DonutLuxe Referrals — Invite & Earn',
    description:
      'Invite players to DonutLuxe and earn a share of the house margin on what they play, never ' +
      'a cut of their losses.',
  },
  fairness: {
    title: 'DonutLuxe Provably Fair — Verify a Round',
    description: 'How DonutLuxe generates every game result, and how to verify a round yourself.',
  },
  vip: {
    title: 'DonutLuxe VIP & Rakeback',
    description: 'The DonutLuxe VIP levels and the rakeback each level pays back on your wagers.',
  },
  'daily-rewards': {
    title: 'DonutLuxe Daily Rewards',
    description: 'Claim a free DonutSMP money reward on DonutLuxe every day; keep a streak for more.',
  },
  race: {
    title: 'DonutLuxe Wager Race',
    description:
      'The DonutLuxe wager race: every wager on the site counts, and the top of the board wins ' +
      'the prize pool.',
  },
  leaderboard: {
    title: 'DonutLuxe Leaderboard',
    description: 'The top DonutLuxe players.',
  },
  discord: {
    title: 'DonutLuxe Discord — Join & Link Your Account',
    description:
      'Join the DonutLuxe Discord, then link your account with /link for the server rewards.',
  },
  'creator-media': {
    title: 'DonutLuxe Creator & Media Programme',
    description: 'Make DonutSMP content? Apply to the DonutLuxe creator and media programme.',
  },
  support: {
    title: 'DonutLuxe Support',
    description: 'Get help with DonutLuxe deposits, withdrawals and your account.',
  },
  terms: {
    title: 'DonutLuxe Terms',
    description: 'The DonutLuxe terms of use.',
  },

  /* ── account pages: a title for the tab, never indexed ── */
  profile: { title: 'DonutLuxe Profile', description: 'Your DonutLuxe profile.' },
  wallet: {
    title: 'DonutLuxe Wallet',
    description: 'Your DonutLuxe balance, deposits and withdrawals.',
  },
  history: { title: 'DonutLuxe History', description: 'Your DonutLuxe game and payment history.' },
  settings: { title: 'DonutLuxe Settings', description: 'Your DonutLuxe account settings.' },
  statistics: { title: 'DonutLuxe Statistics', description: 'Your DonutLuxe statistics.' },
  rewards: {
    title: 'DonutLuxe Rewards',
    description: 'Claim your DonutLuxe rakeback and rewards.',
  },
  studio: {
    title: 'DonutLuxe Case Studio',
    description: 'Build your own DonutLuxe case.',
  },
  war: { title: 'DonutLuxe Faction War', description: 'The DonutLuxe faction war.' },
  quests: { title: 'DonutLuxe Quests', description: 'Your DonutLuxe quests and streak.' },
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
  /* The /test preview is never indexed, whatever the route: its canonical already names the live
   * page, and the server sends X-Robots-Tag as well, but the tag a crawler renders must agree. */
  const robots = BASE ? 'noindex, nofollow' : indexable ? 'index, follow' : 'noindex, follow';
  setMeta('meta[name="robots"]', 'content', robots);
  setMeta('link[rel="canonical"]', 'href', url);
  setMeta('meta[property="og:title"]', 'content', title);
  setMeta('meta[property="og:description"]', 'content', description);
  setMeta('meta[property="og:url"]', 'content', url);
  setMeta('meta[name="twitter:title"]', 'content', title);
  setMeta('meta[name="twitter:description"]', 'content', description);
}
