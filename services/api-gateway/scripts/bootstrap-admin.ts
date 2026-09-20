import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import type { QueryResultRow } from 'pg';
import type { AppConfig } from '../src/config.js';
import { loadConfig } from '../src/config.js';
import { appendAudit } from '../src/lib/audit.js';
import { assertRuntimeDatabaseRole } from '../src/lib/database-role.js';
import { Database, type DbClient } from '../src/lib/db.js';

const MINECRAFT_IDENTITY_PATTERN = /^mc:[a-f0-9]{32}$/;
const BOOTSTRAP_LOCK_ID = 904_211_772;

export interface BootstrapAdminArguments {
  readonly identity: string;
  readonly kycReviewConfirmed: true;
}

export interface BootstrapAdminResult {
  readonly status: 'bootstrapped' | 'already_active';
  readonly userId: string;
  readonly minecraftIdentity: string;
  readonly sessionsRevoked: number;
}

interface BootstrapTarget extends QueryResultRow {
  id: string;
  minecraft_identity: string;
  role: 'player' | 'admin';
  status: 'active' | 'suspended' | 'closed';
}

export function parseBootstrapAdminArguments(args: readonly string[]): BootstrapAdminArguments {
  let identity: string | undefined;
  let kycReviewConfirmed = false;

  for (const argument of args) {
    if (argument.startsWith('--identity=')) {
      if (identity !== undefined) throw new Error('--identity may be supplied only once');
      identity = argument.slice('--identity='.length);
      continue;
    }
    if (argument === '--confirm-kyc-reviewed') {
      if (kycReviewConfirmed) {
        throw new Error('--confirm-kyc-reviewed may be supplied only once');
      }
      kycReviewConfirmed = true;
      continue;
    }
    throw new Error(`Unknown bootstrap argument: ${argument}`);
  }

  if (!identity || !MINECRAFT_IDENTITY_PATTERN.test(identity)) {
    throw new Error(
      '--identity must be a canonical mc: identity followed by 32 lowercase hex digits',
    );
  }
  if (!kycReviewConfirmed) {
    throw new Error('--confirm-kyc-reviewed is required after an operator completes KYC review');
  }
  return Object.freeze({ identity, kycReviewConfirmed: true });
}

function assertProvisionedAdmin(config: AppConfig, identity: string): void {
  if (!config.adminMinecraftIds.has(identity) || !config.adminTotpSecrets.has(identity)) {
    throw new Error('The bootstrap identity must be present in both admin configuration maps');
  }
}

/**
 * The one thing left to check: the account is not already stopped.
 *
 * Country, birth date, terms, adulthood, KYC and self-exclusion were all asserted here, because
 * granting administrator rights to an unverified identity is a serious thing on a real-money
 * platform. None of those records exists any more — this settles in DonutSMP dollars — so the
 * check is what it can honestly be.
 *
 * What actually guards this script is unchanged and was always the real control: the identity must
 * be listed in ADMIN_MINECRAFT_IDS, which is deployment configuration rather than anything a user
 * can set about themselves.
 */
function validateTarget(target: BootstrapTarget): void {
  if (target.status === 'closed' || target.status === 'suspended') {
    throw new Error('The linked user is closed or suspended and cannot be bootstrapped');
  }
}

export async function bootstrapAdminInTransaction(
  client: DbClient,
  config: AppConfig,
  options: BootstrapAdminArguments,
): Promise<BootstrapAdminResult> {
  const { identity } = options;
  if (!options.kycReviewConfirmed) {
    throw new Error('KYC review confirmation is required for administrator bootstrap');
  }
  assertProvisionedAdmin(config, identity);
  await client.query('SELECT pg_advisory_xact_lock($1)', [BOOTSTRAP_LOCK_ID]);

  const otherActiveAdmins = await client.query<{ id: string }>(
    `SELECT id FROM users
      WHERE role = 'admin' AND status = 'active' AND minecraft_identity <> $1
      FOR UPDATE`,
    [identity],
  );
  if (otherActiveAdmins.rowCount) {
    throw new Error('Bootstrap refused because another active administrator already exists');
  }

  const targetResult = await client.query<BootstrapTarget>(
    `SELECT id, minecraft_identity, role, status
       FROM users WHERE minecraft_identity = $1 FOR UPDATE`,
    [identity],
  );
  const target = targetResult.rows[0];
  if (!target) {
    throw new Error('The configured identity must link and complete its profile before bootstrap');
  }
  validateTarget(target);

  if (target.role === 'admin' && target.status === 'active') {
    return Object.freeze({
      status: 'already_active',
      userId: target.id,
      minecraftIdentity: identity,
      sessionsRevoked: 0,
    });
  }

  const updated = await client.query(
    `UPDATE users SET role = 'admin', status = 'active', updated_at = now()
      WHERE id = $1`,
    [target.id],
  );
  if (updated.rowCount !== 1) throw new Error('Administrator bootstrap update failed');

  const revoked = await client.query(
    'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
    [target.id],
  );
  await appendAudit(client, config, {
    actorUserId: null,
    action: 'admin.bootstrap',
    targetType: 'user',
    targetId: target.id,
    details: {
      minecraftIdentity: identity,
      kycReviewConfirmed: true,
      previousRole: target.role,
      previousStatus: target.status,
      sessionsRevoked: revoked.rowCount ?? 0,
    },
  });

  return Object.freeze({
    status: 'bootstrapped',
    userId: target.id,
    minecraftIdentity: identity,
    sessionsRevoked: revoked.rowCount ?? 0,
  });
}

export async function runBootstrapAdmin(args: readonly string[]): Promise<BootstrapAdminResult> {
  const parsed = parseBootstrapAdminArguments(args);
  const config = loadConfig();
  assertProvisionedAdmin(config, parsed.identity);
  const database = new Database(config);
  try {
    await assertRuntimeDatabaseRole(database);
    return await database.transaction((client) =>
      bootstrapAdminInTransaction(client, config, parsed),
    );
  } finally {
    await database.close();
  }
}

const entrypoint = process.argv[1];
if (entrypoint && pathToFileURL(resolve(entrypoint)).href === import.meta.url) {
  await runBootstrapAdmin(process.argv.slice(2))
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error: unknown) => {
      const message =
        error instanceof Error ? error.message : 'Unknown administrator bootstrap failure';
      process.stderr.write(`Administrator bootstrap failed: ${message}\n`);
      process.exitCode = 1;
    });
}
