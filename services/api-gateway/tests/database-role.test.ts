import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertAuditDatabaseRole,
  assertMigratorDatabaseRole,
  assertRuntimeDatabaseRole,
} from '../src/lib/database-role.js';
import type { DbClient } from '../src/lib/db.js';

function clientReturning(row: Record<string, unknown>): DbClient {
  return {
    query: async () =>
      ({ command: 'SELECT', rowCount: 1, oid: 0, fields: [], rows: [row] }) as never,
  };
}

const safeCommon = {
  login_role: 'donut_api_login',
  expected_member: true,
  forbidden_role_member: false,
  superuser: false,
  create_database: false,
  create_role: false,
  bypass_rls: false,
  replication: false,
  inherits_privileges: true,
  creates_in_public: false,
  creates_temporary_tables: false,
  owns_application_objects: false,
  audit_select: true,
  audit_insert: true,
  audit_update: false,
  audit_delete: false,
  unexpected_non_audit_table_privilege: false,
  default_read_only: false,
};

describe('database role fail-safe checks', () => {
  it('accepts only the restricted runtime capability set', async () => {
    await assert.doesNotReject(assertRuntimeDatabaseRole(clientReturning(safeCommon)));
    for (const unsafe of [
      { superuser: true },
      { expected_member: false },
      { creates_temporary_tables: true },
      { audit_delete: true },
      { default_read_only: true },
    ]) {
      await assert.rejects(
        assertRuntimeDatabaseRole(clientReturning({ ...safeCommon, ...unsafe })),
        /restricted API runtime login/,
      );
    }
  });

  it('accepts only an isolated read-only audit capability set', async () => {
    const audit = {
      ...safeCommon,
      login_role: 'donut_audit_login',
      audit_insert: false,
      default_read_only: true,
    };
    await assert.doesNotReject(assertAuditDatabaseRole(clientReturning(audit)));
    await assert.rejects(
      assertAuditDatabaseRole(
        clientReturning({ ...audit, unexpected_non_audit_table_privilege: true }),
      ),
      /isolated read-only audit login/,
    );
  });

  it('requires the non-superuser schema owner for migrations', async () => {
    const migrator = {
      login_role: 'donut_migrator',
      can_login: true,
      superuser: false,
      create_database: false,
      create_role: false,
      bypass_rls: false,
      replication: false,
      inherits_privileges: true,
      role_membership: false,
      owns_database: true,
      owns_public_schema: true,
      safe_search_path: true,
      default_read_only: false,
    };
    await assert.doesNotReject(assertMigratorDatabaseRole(clientReturning(migrator)));
    for (const unsafe of [
      { login_role: 'postgres' },
      { superuser: true },
      { role_membership: true },
      { owns_database: false },
      { safe_search_path: false },
    ]) {
      await assert.rejects(
        assertMigratorDatabaseRole(clientReturning({ ...migrator, ...unsafe })),
        /donut_migrator schema-owner login/,
      );
    }
  });
});
