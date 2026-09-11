import type { DbClient } from './db.js';

interface DatabaseRoleSafety {
  login_role: string;
  expected_member: boolean;
  forbidden_role_member: boolean;
  superuser: boolean;
  create_database: boolean;
  create_role: boolean;
  bypass_rls: boolean;
  replication: boolean;
  inherits_privileges: boolean;
  creates_in_public: boolean;
  creates_temporary_tables: boolean;
  owns_application_objects: boolean;
  audit_select: boolean;
  audit_insert: boolean;
  audit_update: boolean;
  audit_delete: boolean;
  unexpected_non_audit_table_privilege: boolean;
  default_read_only: boolean;
}

interface MigratorRoleSafety {
  login_role: string;
  can_login: boolean;
  superuser: boolean;
  create_database: boolean;
  create_role: boolean;
  bypass_rls: boolean;
  replication: boolean;
  inherits_privileges: boolean;
  role_membership: boolean;
  owns_database: boolean;
  owns_public_schema: boolean;
  safe_search_path: boolean;
  default_read_only: boolean;
}

const BASE_ROLE_SAFETY_SQL = `
  SELECT current_user AS login_role,
         pg_has_role(current_user, $1, 'MEMBER') AS expected_member,
         pg_has_role(current_user, $2, 'MEMBER')
           OR pg_has_role(current_user, $3, 'MEMBER') AS forbidden_role_member,
         r.rolsuper AS superuser,
         r.rolcreatedb AS create_database,
         r.rolcreaterole AS create_role,
         r.rolbypassrls AS bypass_rls,
         r.rolreplication AS replication,
         r.rolinherit AS inherits_privileges,
         has_schema_privilege(current_user, 'public', 'CREATE') AS creates_in_public,
         has_database_privilege(current_user, current_database(), 'TEMPORARY')
           AS creates_temporary_tables,
         EXISTS (
           SELECT 1
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relowner = r.oid
         ) AS owns_application_objects,
         has_table_privilege(current_user, 'public.audit_log', 'SELECT') AS audit_select,
         has_table_privilege(current_user, 'public.audit_log', 'INSERT') AS audit_insert,
         has_table_privilege(current_user, 'public.audit_log', 'UPDATE') AS audit_update,
         has_table_privilege(current_user, 'public.audit_log', 'DELETE') AS audit_delete,
         EXISTS (
           SELECT 1
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
              AND c.relname <> 'audit_log'
              AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
              AND (
                has_table_privilege(current_user, c.oid, 'SELECT')
                OR has_table_privilege(current_user, c.oid, 'INSERT')
                OR has_table_privilege(current_user, c.oid, 'UPDATE')
                OR has_table_privilege(current_user, c.oid, 'DELETE')
                OR has_table_privilege(current_user, c.oid, 'TRUNCATE')
              )
         ) AS unexpected_non_audit_table_privilege,
         current_setting('default_transaction_read_only')::boolean AS default_read_only
    FROM pg_roles r
   WHERE r.rolname = current_user`;

function hasUnsafeCommonCapabilities(row: DatabaseRoleSafety): boolean {
  return (
    !row.expected_member ||
    row.forbidden_role_member ||
    row.superuser ||
    row.create_database ||
    row.create_role ||
    row.bypass_rls ||
    row.replication ||
    !row.inherits_privileges ||
    row.creates_in_public ||
    row.creates_temporary_tables ||
    row.owns_application_objects
  );
}

export async function assertRuntimeDatabaseRole(client: DbClient): Promise<void> {
  const result = await client.query<DatabaseRoleSafety>(BASE_ROLE_SAFETY_SQL, [
    'donut_api_runtime',
    'donut_migrator',
    'donut_audit_reader',
  ]);
  const row = result.rows[0];
  if (
    !row ||
    hasUnsafeCommonCapabilities(row) ||
    row.default_read_only ||
    !row.audit_select ||
    !row.audit_insert ||
    row.audit_update ||
    row.audit_delete
  ) {
    throw new Error('DATABASE_URL must use the restricted API runtime login');
  }
}

export async function assertAuditDatabaseRole(client: DbClient): Promise<void> {
  const result = await client.query<DatabaseRoleSafety>(BASE_ROLE_SAFETY_SQL, [
    'donut_audit_reader',
    'donut_migrator',
    'donut_api_runtime',
  ]);
  const row = result.rows[0];
  if (
    !row ||
    hasUnsafeCommonCapabilities(row) ||
    !row.default_read_only ||
    !row.audit_select ||
    row.audit_insert ||
    row.audit_update ||
    row.audit_delete ||
    row.unexpected_non_audit_table_privilege
  ) {
    throw new Error('DATABASE_URL must use the isolated read-only audit login');
  }
}

export async function assertMigratorDatabaseRole(client: DbClient): Promise<void> {
  const result = await client.query<MigratorRoleSafety>(
    `SELECT current_user AS login_role,
            r.rolcanlogin AS can_login,
            r.rolsuper AS superuser,
            r.rolcreatedb AS create_database,
            r.rolcreaterole AS create_role,
            r.rolbypassrls AS bypass_rls,
            r.rolreplication AS replication,
            r.rolinherit AS inherits_privileges,
            EXISTS (
              SELECT 1 FROM pg_auth_members membership WHERE membership.member = r.oid
            ) AS role_membership,
            database.datdba = r.oid AS owns_database,
            namespace.nspowner = r.oid AS owns_public_schema,
            current_schema() = 'public'
              AND current_schemas(false)::text[] = ARRAY['public']::text[] AS safe_search_path,
            current_setting('default_transaction_read_only')::boolean AS default_read_only
       FROM pg_roles r
       JOIN pg_database database ON database.datname = current_database()
       JOIN pg_namespace namespace ON namespace.nspname = 'public'
      WHERE r.rolname = current_user`,
  );
  const row = result.rows[0];
  if (
    !row ||
    row.login_role !== 'donut_migrator' ||
    !row.can_login ||
    row.superuser ||
    row.create_database ||
    row.create_role ||
    row.bypass_rls ||
    row.replication ||
    !row.inherits_privileges ||
    row.role_membership ||
    !row.owns_database ||
    !row.owns_public_schema ||
    !row.safe_search_path ||
    row.default_read_only
  ) {
    throw new Error('DATABASE_URL must use the isolated donut_migrator schema-owner login');
  }
}
