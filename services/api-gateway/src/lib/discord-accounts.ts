import type { AppConfig } from '../config.js';
import type { DbClient } from './db.js';
import { AppError } from './errors.js';

/**
 * Which site accounts a Discord is linked to (migration 075).
 *
 * One Discord may carry up to `discordMaxAccounts` site accounts: a player's main Minecraft account
 * and their alts. Exactly one of them is MAIN (`users.discord_main`): the first linked, until the
 * member picks another with `/accounts main` in the server. The main account is the one the bot acts
 * for -- `/tag` pays it, `/profile` and `/rewards` describe it -- because those commands have a
 * Discord in hand and no other way to choose. The site never needs it: a signed-in session already
 * names its account.
 *
 * Every reward that depends on Discord stays once per Discord whatever this allows: discord_rewards
 * carries unique indexes on the Discord id (join once, tag once a day, invite once per invitee), so
 * linking alts adds sign-in convenience, not money.
 */

type Client = Pick<DbClient, 'query'>;

export interface DiscordAccount {
  readonly id: string;
  readonly minecraftUsername: string;
  readonly status: string;
  readonly main: boolean;
  readonly linkedAt: Date | null;
  readonly lastLoginAt: Date | null;
}

interface AccountRow {
  id: string;
  minecraft_username: string;
  status: string;
  discord_main: boolean;
  discord_verified_at: Date | null;
  last_login_at: Date | null;
}

const toAccount = (row: AccountRow): DiscordAccount => ({
  id: row.id,
  minecraftUsername: row.minecraft_username,
  status: row.status,
  main: row.discord_main,
  linkedAt: row.discord_verified_at,
  lastLoginAt: row.last_login_at,
});

/** Serialises every change to one Discord's set of accounts, so two links cannot both take the last slot. */
async function lockDiscord(client: Client, discordUserId: string): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('discord-accounts:' || $1, 0))",
    [discordUserId],
  );
}

/** Every account on a Discord, main first, then the most recently used. Media-test twins never link. */
export async function linkedAccounts(
  client: Client,
  discordUserId: string,
): Promise<DiscordAccount[]> {
  const rows = await client.query<AccountRow>(
    `SELECT id, minecraft_username, status, discord_main, discord_verified_at, last_login_at
       FROM users
      WHERE discord_user_id = $1 AND demo_of IS NULL
      ORDER BY discord_main DESC, last_login_at DESC NULLS LAST, discord_verified_at, id`,
    [discordUserId],
  );
  return rows.rows.map(toAccount);
}

/** The account the bot acts for. Falls back to the oldest link should a main ever be missing. */
export async function mainAccount(
  client: Client,
  discordUserId: string,
): Promise<{ id: string; minecraft_username: string; status: string } | null> {
  const rows = await client.query<{ id: string; minecraft_username: string; status: string }>(
    `SELECT id, minecraft_username, status FROM users
      WHERE discord_user_id = $1 AND demo_of IS NULL
      ORDER BY discord_main DESC, discord_verified_at, id
      LIMIT 1`,
    [discordUserId],
  );
  return rows.rows[0] ?? null;
}

/**
 * Links a site account to a Discord, inside the caller's transaction.
 *
 * Refuses an account already linked to a DIFFERENT Discord (unlinking comes first), and a Discord
 * that already carries the most accounts allowed. Linking an account to the Discord it is already
 * on changes nothing. The first account on a Discord becomes its main one.
 */
export async function linkAccountToDiscord(
  client: Client,
  config: AppConfig,
  input: { userId: string; discordUserId: string; discordUsername: string },
): Promise<{ linked: 'new' | 'already'; main: boolean; accounts: number }> {
  await lockDiscord(client, input.discordUserId);
  const account = await client.query<{ discord_user_id: string | null; discord_main: boolean }>(
    'SELECT discord_user_id, discord_main FROM users WHERE id = $1 FOR UPDATE',
    [input.userId],
  );
  const row = account.rows[0];
  if (!row) throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'That site account does not exist');
  if (row.discord_user_id && row.discord_user_id !== input.discordUserId) {
    throw new AppError(
      409,
      'ACCOUNT_ALREADY_LINKED',
      'That site account is already linked to a different Discord account',
    );
  }
  const others = await client.query<{ n: string; mains: string }>(
    `SELECT count(*)::text AS n, count(*) FILTER (WHERE discord_main)::text AS mains
       FROM users WHERE discord_user_id = $1 AND id <> $2`,
    [input.discordUserId, input.userId],
  );
  const count = Number(others.rows[0]?.n ?? 0);
  if (row.discord_user_id) {
    return { linked: 'already', main: row.discord_main, accounts: count + 1 };
  }
  if (count >= config.discordMaxAccounts) {
    throw new AppError(
      409,
      'DISCORD_ACCOUNT_LIMIT',
      `This Discord is already linked to ${count} accounts, the most allowed. Unlink one with /accounts unlink first`,
    );
  }
  const main = Number(others.rows[0]?.mains ?? 0) === 0;
  await client.query(
    `UPDATE users
        SET discord_user_id = $2, discord_username = $3, discord_verified_at = now(),
            discord_main = $4, updated_at = now()
      WHERE id = $1`,
    [input.userId, input.discordUserId, input.discordUsername.slice(0, 64), main],
  );
  return { linked: 'new', main, accounts: count + 1 };
}

/** Makes one of a Discord's accounts its main one, named by Minecraft username (the bot's `/accounts main`). */
export async function setMainAccount(
  client: Client,
  discordUserId: string,
  minecraftUsername: string,
): Promise<DiscordAccount> {
  await lockDiscord(client, discordUserId);
  const target = await findLinked(client, discordUserId, minecraftUsername);
  await client.query(
    'UPDATE users SET discord_main = false, updated_at = now() WHERE discord_user_id = $1 AND discord_main AND id <> $2',
    [discordUserId, target.id],
  );
  await client.query('UPDATE users SET discord_main = true, updated_at = now() WHERE id = $1', [
    target.id,
  ]);
  return { ...toAccount(target), main: true };
}

/**
 * Takes an account off its Discord. When it was the main one, the most recently used account left
 * becomes main, so the bot keeps acting for somebody the member still plays.
 *
 * The rewards already collected stay where they were paid, and the Discord's claims stay spent:
 * discord_rewards is keyed on the Discord, so unlinking and relinking elsewhere earns nothing twice.
 */
export async function unlinkAccount(
  client: Client,
  target: { userId: string } | { discordUserId: string; minecraftUsername: string },
): Promise<{ unlinked: string; discordUserId: string; newMain: string | null }> {
  let account: AccountRow & { discord_user_id: string };
  if ('userId' in target) {
    const found = await client.query<{ discord_user_id: string | null }>(
      'SELECT discord_user_id FROM users WHERE id = $1',
      [target.userId],
    );
    const discordUserId = found.rows[0]?.discord_user_id;
    if (!discordUserId) {
      throw new AppError(409, 'DISCORD_NOT_LINKED', 'This account is not linked to Discord');
    }
    await lockDiscord(client, discordUserId);
    const locked = await client.query<AccountRow & { discord_user_id: string | null }>(
      `SELECT id, minecraft_username, status, discord_main, discord_verified_at, last_login_at,
              discord_user_id
         FROM users WHERE id = $1 FOR UPDATE`,
      [target.userId],
    );
    const row = locked.rows[0];
    // Unlinked (or moved) by somebody else between the read and the lock.
    if (!row || row.discord_user_id !== discordUserId) {
      throw new AppError(409, 'DISCORD_NOT_LINKED', 'This account is not linked to Discord');
    }
    account = { ...row, discord_user_id: discordUserId };
  } else {
    await lockDiscord(client, target.discordUserId);
    account = {
      ...(await findLinked(client, target.discordUserId, target.minecraftUsername)),
      discord_user_id: target.discordUserId,
    };
  }

  await client.query(
    `UPDATE users
        SET discord_user_id = NULL, discord_username = NULL, discord_verified_at = NULL,
            discord_main = false, updated_at = now()
      WHERE id = $1`,
    [account.id],
  );
  let newMain: string | null = null;
  if (account.discord_main) {
    const promoted = await client.query<{ minecraft_username: string }>(
      `UPDATE users SET discord_main = true, updated_at = now()
        WHERE id = (SELECT id FROM users
                     WHERE discord_user_id = $1 AND demo_of IS NULL
                     ORDER BY last_login_at DESC NULLS LAST, discord_verified_at, id
                     LIMIT 1)
        RETURNING minecraft_username`,
      [account.discord_user_id],
    );
    newMain = promoted.rows[0]?.minecraft_username ?? null;
  }
  return {
    unlinked: account.minecraft_username,
    discordUserId: account.discord_user_id,
    newMain,
  };
}

async function findLinked(
  client: Client,
  discordUserId: string,
  minecraftUsername: string,
): Promise<AccountRow> {
  const found = await client.query<AccountRow>(
    `SELECT id, minecraft_username, status, discord_main, discord_verified_at, last_login_at
       FROM users
      WHERE discord_user_id = $1 AND normalized_username = lower($2) AND demo_of IS NULL
      FOR UPDATE`,
    [discordUserId, minecraftUsername.trim()],
  );
  const row = found.rows[0];
  if (!row) {
    throw new AppError(
      404,
      'DISCORD_ACCOUNT_NOT_FOUND',
      'None of the accounts linked to this Discord has that name. /accounts list shows them',
    );
  }
  return row;
}
