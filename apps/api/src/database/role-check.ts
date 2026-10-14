import type pg from 'pg';

// Row-level security is the tenant boundary. It does not apply to a superuser, to a
// role with BYPASSRLS, or to the owner of a table (and an owner can turn it off), so
// the API refuses to start when the role it connected as is any of these. Owning a
// schema or the database counts too: an owner can drop or replace what is inside.
// Membership counts as well, because a member can SET ROLE to a superuser, to a
// BYPASSRLS role or to an owner.

export interface RoleReport {
  readonly role: string;
  readonly problems: readonly string[];
}

export class PrivilegedRoleError extends Error {
  constructor(readonly report: RoleReport) {
    super(
      `refusing to start: database role "${report.role}" ${report.problems.join('; ')}. ` +
        'The API must connect as a role that row-level security applies to: ' +
        'not a superuser, without BYPASSRLS, owning no table, schema or database, ' +
        'and a member of no role that is any of these.',
    );
    this.name = 'PrivilegedRoleError';
  }
}

// Temporary schemas are left out: they belong to sessions, not to the deployment.
const ROLE_QUERY = `
  SELECT
    r.rolname AS role,
    r.rolsuper AS superuser,
    r.rolbypassrls AS bypass_rls,
    ARRAY(
      SELECT pg_catalog.format('%I', g.rolname)
      FROM pg_catalog.pg_roles g
      WHERE (g.rolsuper OR g.rolbypassrls)
        AND g.oid <> r.oid
        AND pg_catalog.pg_has_role(current_user, g.oid, 'MEMBER')
      ORDER BY 1
    ) AS privileged_groups,
    pg_catalog.pg_has_role(current_user, d.datdba, 'MEMBER') AS owns_database,
    d.datname AS database,
    ARRAY(
      SELECT pg_catalog.format('%I', n.nspname)
      FROM pg_catalog.pg_namespace n
      WHERE pg_catalog.pg_has_role(current_user, n.nspowner, 'MEMBER')
        AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
        AND n.nspname !~ '^pg_(toast_)?temp_'
      ORDER BY 1
    ) AS owned_schemas,
    ARRAY(
      SELECT pg_catalog.format('%I.%I', n.nspname, c.relname)
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE pg_catalog.pg_has_role(current_user, c.relowner, 'MEMBER')
        AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
        AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
        AND n.nspname !~ '^pg_(toast_)?temp_'
      ORDER BY 1
    ) AS owned_relations
  FROM pg_catalog.pg_roles r, pg_catalog.pg_database d
  WHERE r.rolname = current_user AND d.datname = pg_catalog.current_database()
`;

interface RoleRow {
  role: string;
  superuser: boolean;
  bypass_rls: boolean;
  privileged_groups: string[];
  owns_database: boolean;
  database: string;
  owned_schemas: string[];
  owned_relations: string[];
}

export async function inspectRole(db: pg.Pool | pg.ClientBase): Promise<RoleReport> {
  const { rows } = await db.query<RoleRow>(ROLE_QUERY);
  const row = rows[0];
  if (row === undefined) throw new Error('current_user is not in pg_roles');
  const problems: string[] = [];
  if (row.superuser) problems.push('is a superuser');
  if (row.bypass_rls) problems.push('has BYPASSRLS');
  if (row.privileged_groups.length > 0) {
    problems.push(`is a member of superuser or BYPASSRLS roles ${list(row.privileged_groups)}`);
  }
  if (row.owns_database) problems.push(`owns the database ${row.database}`);
  if (row.owned_schemas.length > 0) problems.push(`owns schemas ${list(row.owned_schemas)}`);
  if (row.owned_relations.length > 0) {
    problems.push(`owns tables, views or sequences ${list(row.owned_relations)}`);
  }
  return { role: row.role, problems };
}

export async function assertUnprivilegedRole(db: pg.Pool | pg.ClientBase): Promise<void> {
  const report = await inspectRole(db);
  if (report.problems.length > 0) throw new PrivilegedRoleError(report);
}

function list(names: readonly string[]): string {
  const shown = names.slice(0, 10).join(', ');
  return names.length > 10 ? `${shown} and ${names.length - 10} more` : shown;
}
