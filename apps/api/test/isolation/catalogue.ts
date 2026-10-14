import type pg from 'pg';

// What the isolation checks cover comes from the database catalogue, not from a
// list in the tests: every relation that a role holds any privilege on, outside the
// system schemas, and every column of those relations. A table, view, partition,
// sequence or column added by a later migration is in the checks from then on.

export type RelationKind = 'r' | 'p' | 'v' | 'm' | 'f' | 'S';

export interface Column {
  readonly name: string;
  /** As format_type prints it. */
  readonly type: string;
  /** A string, json, jsonb or xml type, or a domain or an array of one. */
  readonly freeText: boolean;
  /** An identity column GENERATED ALWAYS or a generated column: INSERT does not set it. */
  readonly generated: boolean;
  /** Part of a unique index or the primary key. */
  readonly unique: boolean;
}

export interface Relation {
  /** schema.name, quoted where needed. */
  readonly name: string;
  readonly kind: RelationKind;
  readonly partition: boolean;
  readonly rowSecurity: boolean;
  readonly forceRowSecurity: boolean;
  /** A view whose queries run with the caller's privileges and policies. */
  readonly securityInvoker: boolean;
  readonly columns: readonly Column[];
}

/** Excluded from the per-table checks, each with its reason. */
export const RELATION_ALLOW_LIST: Readonly<Record<string, string>> = {
  'public.schema_migrations':
    "the migration runner's record of applied files: no tenant data, and rff_app holds no privilege on it",
};

const SYSTEM_SCHEMA = `n.nspname IN ('pg_catalog', 'information_schema') OR n.nspname ~ '^pg_(toast|temp_)'`;

const PRIVILEGED_RELATIONS = `
  SELECT pg_catalog.format('%I.%I', n.nspname, c.relname) AS name, c.oid::int8 AS oid,
         c.relkind AS kind, c.relispartition AS partition, c.relrowsecurity AS row_security,
         c.relforcerowsecurity AS force_row_security,
         coalesce(c.reloptions, '{}') AS options
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
    AND NOT (${SYSTEM_SCHEMA})
    AND CASE WHEN c.relkind = 'S'
      THEN pg_catalog.has_sequence_privilege($1, c.oid, 'USAGE, SELECT, UPDATE')
      ELSE pg_catalog.has_table_privilege($1, c.oid,
             'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN')
        OR pg_catalog.has_any_column_privilege($1, c.oid, 'SELECT, INSERT, UPDATE, REFERENCES')
    END
  ORDER BY 1`;

// Domains resolve to their base type and arrays to their element type, so a column
// of type text[] or of a domain over text counts as free text.
const COLUMNS = `
  WITH RECURSIVE cols AS (
    SELECT a.attrelid, a.attnum, a.attname, a.atttypid, a.atttypmod, a.attidentity, a.attgenerated
    FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = ANY($1::oid[]) AND a.attnum > 0 AND NOT a.attisdropped
  ),
  chain (start, oid, depth) AS (
    SELECT DISTINCT atttypid, atttypid, 0 FROM cols
    UNION ALL
    SELECT chain.start, CASE WHEN t.typtype = 'd' THEN t.typbasetype ELSE t.typelem END,
           chain.depth + 1
    FROM chain JOIN pg_catalog.pg_type t ON t.oid = chain.oid
    WHERE t.typtype = 'd' OR t.typcategory = 'A'
  ),
  leaf AS (SELECT DISTINCT ON (start) start, oid FROM chain ORDER BY start, depth DESC)
  SELECT cols.attrelid::int8 AS relation, cols.attname AS name,
         pg_catalog.format_type(cols.atttypid, cols.atttypmod) AS type,
         (t.typcategory = 'S' OR t.typname IN ('json', 'jsonb', 'xml')) AS free_text,
         (cols.attidentity = 'a' OR cols.attgenerated <> '') AS generated,
         EXISTS (
           SELECT FROM pg_catalog.pg_index i
           WHERE i.indrelid = cols.attrelid AND i.indisunique AND cols.attnum = ANY (i.indkey)
         ) AS unique
  FROM cols
  JOIN leaf ON leaf.start = cols.atttypid
  JOIN pg_catalog.pg_type t ON t.oid = leaf.oid
  ORDER BY cols.attrelid, cols.attnum`;

interface RelationRow {
  name: string;
  oid: string;
  kind: RelationKind;
  partition: boolean;
  row_security: boolean;
  force_row_security: boolean;
  options: string[];
}

interface ColumnRow {
  relation: string;
  name: string;
  type: string;
  free_text: boolean;
  generated: boolean;
  unique: boolean;
}

export interface Universe {
  /** The relations the checks cover. */
  readonly relations: readonly Relation[];
  /** Relations the role holds a privilege on that the allow-list leaves out. */
  readonly allowListed: readonly string[];
}

/** Every relation role holds any privilege on outside the system schemas, minus allowList. */
export async function reachableRelations(
  admin: pg.ClientBase,
  role: string,
  allowList: Readonly<Record<string, string>> = RELATION_ALLOW_LIST,
): Promise<Universe> {
  const { rows } = await admin.query<RelationRow>(PRIVILEGED_RELATIONS, [role]);
  const columns = await admin.query<ColumnRow>(COLUMNS, [rows.map((row) => row.oid)]);
  const relations = rows
    .filter((row) => !(row.name in allowList))
    .map((row): Relation => ({
      name: row.name,
      kind: row.kind,
      partition: row.partition,
      rowSecurity: row.row_security,
      forceRowSecurity: row.force_row_security,
      securityInvoker: row.options.some((option) =>
        /^security_invoker=(true|on|yes|1)$/i.test(option),
      ),
      columns: columns.rows
        .filter((column) => column.relation === row.oid)
        .map(({ name, type, free_text, generated, unique }) => ({
          name,
          type,
          freeText: free_text,
          generated,
          unique,
        })),
    }));
  return {
    relations,
    allowListed: rows.filter((row) => row.name in allowList).map((row) => row.name),
  };
}

/** Whether schema.name exists as a relation. */
export async function relationExists(admin: pg.ClientBase, name: string): Promise<boolean> {
  const { rows } = await admin.query<{ found: boolean }>(
    'SELECT pg_catalog.to_regclass($1) IS NOT NULL AS found',
    [name],
  );
  return rows[0]?.found === true;
}

export interface DefinerFunction {
  /** schema.name(argument types) */
  readonly signature: string;
  readonly owner: string;
  readonly config: readonly string[];
  readonly returnsSet: boolean;
  readonly publicExecutes: boolean;
  readonly roleExecutes: boolean;
}

const DEFINER_FUNCTIONS = `
  SELECT pg_catalog.format('%I.%I(%s)', n.nspname, p.proname,
           pg_catalog.oidvectortypes(p.proargtypes)) AS signature,
         pg_catalog.pg_get_userbyid(p.proowner) AS owner,
         coalesce(p.proconfig, '{}') AS config,
         p.proretset AS returns_set,
         EXISTS (
           SELECT FROM pg_catalog.aclexplode(
             coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) e
           WHERE e.grantee = 0 AND e.privilege_type = 'EXECUTE'
         ) AS public_executes,
         pg_catalog.has_function_privilege($1, p.oid, 'EXECUTE') AS role_executes
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE p.prosecdef AND NOT (${SYSTEM_SCHEMA})
  ORDER BY 1`;

/** Every SECURITY DEFINER function or procedure outside the system schemas. */
export async function definerFunctions(
  admin: pg.ClientBase,
  role: string,
): Promise<DefinerFunction[]> {
  const { rows } = await admin.query<{
    signature: string;
    owner: string;
    config: string[];
    returns_set: boolean;
    public_executes: boolean;
    role_executes: boolean;
  }>(DEFINER_FUNCTIONS, [role]);
  return rows.map((row) => ({
    signature: row.signature,
    owner: row.owner,
    config: row.config,
    returnsSet: row.returns_set,
    publicExecutes: row.public_executes,
    roleExecutes: row.role_executes,
  }));
}
