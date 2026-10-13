import { randomUUID } from 'node:crypto';
import type { AuthUser } from '../types/fastify.js';
import type { DbClient } from './db.js';

/**
 * Media test mode: approved creators (and staff) play the house games with play money, for clips.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * PLAY MONEY LIVES ON ITS OWN ACCOUNT
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A session in test mode is served as the creator's "test twin": a second users row with its own
 * wallet, rounds, seeds and inventory (migration 066). The swap happens once, in the auth guard,
 * so every game route runs unchanged -- same engines, same odds, same provably-fair seeds. Nothing
 * here decides an outcome, and nothing may: a test round is a real round on a play-money wallet.
 *
 * Keeping the money apart is the twin's job, and closing every door it could leave by is this
 * module's:
 *
 *   - Writes. A test session may call only the routes in TEST_MODE_ROUTES -- the house games, an
 *     item sale back into the twin's own wallet, and the switch itself. Tips, rain, payouts,
 *     PvP lobbies, referrals, claims and anything added later are refused by default, because an
 *     allow-list fails closed where a deny-list fails open.
 *   - Side effects of a wager. recordWager skips everything for a twin: no race entry (it would
 *     push real players off paid places), no jackpot accrual or draw (it would empty the real
 *     pot), no rakeback, VIP, referral share or quest progress.
 *   - Community crates. A twin's open pays the crate's author no royalty; see creator-royalties.
 *   - What the public sees. The live feed and the leaderboards leave twins out
 *     (notDemoPredicate), and a twin's win is never posted to the Discord win feed (flexName).
 *   - What the owner sees. The `demo:` identity puts twins inside staffPredicate, so the house
 *     figures and the anti-drain monitor never count play money.
 */

/** The identity every twin carries; the schema refuses a twin without it. */
export const DEMO_IDENTITY_PREFIX = 'demo:';

/** SQL that says a `users` alias is NOT a test twin. For public lists: the feed, the boards. */
export function notDemoPredicate(alias: string): string {
  return `${alias}.minecraft_identity NOT LIKE '${DEMO_IDENTITY_PREFIX}%'`;
}

/**
 * Every write a test-mode session may make, as `METHOD /route/pattern`.
 *
 * Only house games, whose payouts come from the house and land in the twin's own wallet. Crash and
 * roulette share a round with real players but pay each bet from the house, so a play-money bet
 * cannot take anything from a real one. Coinflip, duels, Mines Duel and battles are player against
 * player and are not here: a real player would win play money, or lose real money to it.
 */
export const TEST_MODE_ROUTES: ReadonlySet<string> = new Set([
  'POST /v1/media/test-mode',
  'POST /v1/media/test-mode/topup',
  'POST /v1/auth/logout',
  'POST /v1/auth/logout-all',
  'POST /v1/cases/:id/open',
  'POST /v1/upgrades',
  'POST /v1/mines/games',
  'POST /v1/mines/games/:id/reveal',
  'POST /v1/mines/games/:id/cashout',
  'POST /v1/plinko/bets',
  'POST /v1/blackjack/hands',
  'POST /v1/blackjack/hands/:id/actions',
  'POST /v1/crash/bets',
  'POST /v1/crash/cashout',
  'POST /v1/roulette/bets',
  'POST /v1/inventory/:id/sell',
]);

export function testModeAllows(method: string, routeUrl: string | undefined): boolean {
  return routeUrl !== undefined && TEST_MODE_ROUTES.has(`${method.toUpperCase()} ${routeUrl}`);
}

/** The real account behind a request: the creator, whether or not the session is in test mode. */
export function accountId(user: AuthUser | undefined): string | undefined {
  return user?.demoOf ?? user?.id;
}

/** The name a Discord win post may carry. None for play money: a test win is never announced. */
export function flexName(user: AuthUser | undefined): string | undefined {
  return user && !user.demoOf ? user.minecraftUsername : undefined;
}

export async function isDemoAccount(client: DbClient, userId: string): Promise<boolean> {
  const result = await client.query<{ demo: boolean }>(
    'SELECT demo_of IS NOT NULL AS demo FROM users WHERE id = $1',
    [userId],
  );
  return result.rows[0]?.demo === true;
}

/**
 * Who may switch test mode on: an active account that is staff or an approved creator -- the same
 * "media" the chat nametag marks. A twin is never eligible itself.
 */
export async function testModeEligible(client: DbClient, userId: string): Promise<boolean> {
  const result = await client.query<{ eligible: boolean }>(
    `SELECT (u.role = 'admin' OR EXISTS (
              SELECT 1 FROM creator_applications ca
               WHERE ca.user_id = u.id AND ca.status = 'approved'
            )) AS eligible
       FROM users u
      WHERE u.id = $1 AND u.status = 'active' AND u.demo_of IS NULL`,
    [userId],
  );
  return result.rows[0]?.eligible === true;
}

/**
 * The creator's twin, created on first use. It wears the creator's own name so a clip shows it,
 * and a normalized name outside Minecraft's alphabet so no lookup by name can ever land on it.
 */
export async function ensureTwin(
  client: DbClient,
  owner: { id: string; minecraftUsername: string },
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO users
       (id, minecraft_identity, minecraft_username, normalized_username, role, status,
        terms_accepted_at, demo_of)
     VALUES ($1, $2, $3::varchar, $4, 'player', 'active', now(), $5)
     ON CONFLICT (minecraft_identity) DO UPDATE
       SET minecraft_username = EXCLUDED.minecraft_username, updated_at = now()
     RETURNING id`,
    [
      randomUUID(),
      `${DEMO_IDENTITY_PREFIX}${owner.id}`,
      owner.minecraftUsername,
      `$${owner.id.replace(/-/g, '').slice(0, 15)}`,
      owner.id,
    ],
  );
  const twinId = result.rows[0]?.id;
  if (!twinId) throw new Error('Test twin upsert returned no row');
  return twinId;
}

export async function twinOf(client: DbClient, ownerId: string): Promise<string | null> {
  const result = await client.query<{ id: string }>('SELECT id FROM users WHERE demo_of = $1', [
    ownerId,
  ]);
  return result.rows[0]?.id ?? null;
}

export async function twinBalance(client: DbClient, twinId: string): Promise<bigint> {
  const result = await client.query<{ balance_minor: string }>(
    'SELECT balance_minor FROM user_wallets WHERE user_id = $1',
    [twinId],
  );
  return BigInt(result.rows[0]?.balance_minor ?? '0');
}
