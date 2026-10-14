import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { connectClient } from '../../src/database/connect.js';
import { createPool } from '../../src/database/pool.js';
import { inspectRole } from '../../src/database/role-check.js';
import { TenantDatabase } from '../../src/database/tenant-database.js';
import { ident, literal } from '../harness/settings.js';
import type { Column, DefinerFunction, Relation } from './catalogue.js';
import type { Scope, TenancyRule } from './fixture.js';

// Each detector runs one isolation check against every relation of a universe and
// returns what it found; an empty list means the check passed. The same detectors
// run against rff_app on the migrated schema, which must give no findings, and
// against controls that must give findings: the superuser connection, which skips
// row-level security, a table without it, and tables whose policies have one defect
// each.

export interface Finding {
  readonly relation: string;
  readonly detail: string;
}

export interface Subject {
  /** Superuser on the database under test. It skips row-level security. */
  readonly admin: pg.ClientBase;
  /** The role under test, and a URL that logs in as it to the same database. */
  readonly role: string;
  readonly url: string;
  readonly relations: readonly Relation[];
  readonly rule: (relation: Relation) => TenancyRule | undefined;
  /** A is the tenant whose rows must stay out of reach; B is the one acting. */
  readonly contexts: { readonly A: Scope; readonly B: Scope };
  /** Restores the seeded rows after a check that changed them. */
  readonly reseed: () => Promise<void>;
  /**
   * The pool the checks run withTenant on. By default the API's own pool with one
   * connection; a control replaces it with one that does not reuse its connection.
   */
  readonly pool?: () => pg.Pool;
}

/** Runs fn for each item, one after another, and collects the results. */
export async function inSequence<T, R>(
  items: readonly T[],
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (const item of items) {
    // eslint-disable-next-line no-await-in-loop -- one connection, one check at a time
    results.push(await fn(item));
  }
  return results;
}

/** The relations that have at least one finding. */
export function relationsWithFindings(findings: readonly Finding[]): string[] {
  return [...new Set(findings.map((finding) => finding.relation))].toSorted();
}

const silent = { log: () => {}, warn: () => {}, error: () => {} };

async function withSubjectDatabase<T>(
  subject: Subject,
  fn: (db: TenantDatabase, pool: pg.Pool) => Promise<T>,
): Promise<T> {
  // One connection, so every statement of a check runs on the same session.
  const pool =
    subject.pool?.() ?? createPool({ url: subject.url, poolMax: 1, connectDeadlineMs: 0 }, silent);
  try {
    return await fn(new TenantDatabase(pool), pool);
  } finally {
    await pool.end();
  }
}

/** Calls check for each relation with its tenancy rule; a relation without one is a finding. */
async function eachRelation(
  subject: Subject,
  check: (relation: Relation, rule: TenancyRule) => Promise<string[]>,
): Promise<Finding[]> {
  const perRelation = await inSequence(subject.relations, async (relation) => {
    const rule = subject.rule(relation);
    const details =
      rule === undefined
        ? ['has no tenancy rule: give it a tenant_id uuid column or an entry in TENANCY_RULES']
        : await check(relation, rule);
    return details.map((detail) => ({ relation: relation.name, detail }));
  });
  return perRelation.flat();
}

function visible(rule: TenancyRule, scope: Scope): string {
  return `coalesce((${rule.visibleIn(scope)}), false)`;
}

/** Row count and a checksum of the rows' text, plus their xmin for tables. */
function rowsQuery(relation: Relation, where: string, versioned: boolean): string {
  const row =
    versioned && hasTupleVersions(relation) ? `t.xmin::text || ' ' || t::text` : 't::text';
  return `SELECT count(*)::int AS n,
                 md5(coalesce(string_agg(${row}, E'\\n' ORDER BY ${row}), '')) AS sum
          FROM ${relation.name} t WHERE ${where}`;
}

function hasTupleVersions(relation: Relation): boolean {
  return relation.kind === 'r' || relation.kind === 'p';
}

export interface Rows {
  n: number;
  sum: string;
}

async function adminRows(
  subject: Subject,
  relation: Relation,
  where: string,
  versioned = false,
): Promise<Rows> {
  const { rows } = await subject.admin.query<Rows>(rowsQuery(relation, where, versioned));
  return rows[0] as Rows;
}

/**
 * The count and checksum, xmin included, of the rows that scope sees in each relation
 * that has a tenancy rule, read on the admin connection. The route checks compare
 * A's rows before and after requests made by B's members.
 */
export async function visibleRowSums(
  admin: pg.ClientBase,
  relations: readonly Relation[],
  rule: (relation: Relation) => TenancyRule | undefined,
  scope: Scope,
): Promise<Map<string, Rows>> {
  const sums = await inSequence(relations, async (relation) => {
    const found = rule(relation);
    if (found === undefined) return undefined;
    const { rows } = await admin.query<Rows>(rowsQuery(relation, visible(found, scope), true));
    return [relation.name, rows[0] as Rows] as const;
  });
  return new Map(sums.filter((entry) => entry !== undefined));
}

/** The rows outside B, with their tuple versions: an UPDATE that touches a row changes its xmin. */
function outsideB(subject: Subject, relation: Relation, rule: TenancyRule): Promise<Rows> {
  return adminRows(subject, relation, `NOT ${visible(rule, subject.contexts.B)}`, true);
}

/**
 * The rows outside B in every relation of the universe. A write to one table can
 * change others through a foreign key's ON DELETE action, which skips row-level
 * security, or through a trigger.
 */
async function outsideBEverywhere(subject: Subject): Promise<Map<string, Rows>> {
  const sums = await inSequence(subject.relations, async (relation) => {
    const rule = subject.rule(relation);
    return rule === undefined
      ? undefined
      : ([relation.name, await outsideB(subject, relation, rule)] as const);
  });
  return new Map(sums.filter((entry) => entry !== undefined));
}

/** The relations whose rows outside B differ between two snapshots, with their counts. */
function changedOutsideB(
  before: ReadonlyMap<string, Rows>,
  after: ReadonlyMap<string, Rows>,
): string[] {
  return [...before].flatMap(([name, rows]) => {
    const now = after.get(name);
    return now?.sum === rows.sum
      ? []
      : [`${name} (${rows.n} rows before, ${now?.n ?? 'none'} after)`];
  });
}

type Outcome = { rowCount: number; error?: undefined } | { rowCount?: undefined; error: Error };

const ROLL_BACK = new Error('roll back');

/** Runs sql in scope's context. commit false rolls the transaction back afterwards. */
async function attempt(
  db: TenantDatabase,
  scope: Scope,
  sql: string,
  params: unknown[],
  commit: boolean,
): Promise<Outcome> {
  let outcome: Outcome | undefined;
  try {
    await db.withTenant(scope, async (client) => {
      try {
        const result = await client.query(sql, params);
        outcome = { rowCount: result.rowCount ?? 0 };
      } catch (error) {
        outcome = { error: error instanceof Error ? error : new Error(String(error)) };
        throw ROLL_BACK;
      }
      if (!commit) throw ROLL_BACK;
    });
  } catch (error) {
    if (error !== ROLL_BACK) throw error;
  }
  if (outcome === undefined) throw new Error('attempt: the statement did not run');
  return outcome;
}

type Refusal = 'policy' | 'privilege';

function refusalOf(error: Error | undefined): Refusal | undefined {
  if (error === undefined || (error as { code?: string }).code !== '42501') return undefined;
  if (/violates row-level security policy/.test(error.message)) return 'policy';
  if (error.message.startsWith('permission denied for ')) return 'privilege';
  return undefined;
}

function describeOutcome(outcome: Outcome): string {
  if (outcome.error === undefined) return `it succeeded on ${outcome.rowCount} rows`;
  const code = (outcome.error as { code?: string }).code ?? 'no SQLSTATE';
  return `it failed with ${code} (${outcome.error.message})`;
}

async function columnPrivilege(
  subject: Subject,
  relation: Relation,
  column: string,
  privilege: 'INSERT' | 'UPDATE',
): Promise<boolean> {
  const { rows } = await subject.admin.query<{ held: boolean }>(
    'SELECT pg_catalog.has_column_privilege($1, $2::regclass, $3, $4) AS held',
    [subject.role, relation.name, column, privilege],
  );
  return rows[0]?.held === true;
}

/** Check 1: row-level security is on and forced, or the view runs with the caller's rights. */
export function rowSecurityFindings(relations: readonly Relation[]): Finding[] {
  return relations.flatMap((relation): Finding[] => {
    const finding = (detail: string): Finding[] => [{ relation: relation.name, detail }];
    switch (relation.kind) {
      case 'r':
      case 'p':
        if (!relation.rowSecurity) return finding('row-level security is not enabled');
        if (!relation.forceRowSecurity) return finding('row-level security is not forced');
        return [];
      case 'v':
        return relation.securityInvoker
          ? []
          : finding("the view runs with its owner's rights: set security_invoker");
      default:
        return finding(`row-level security cannot apply to relation kind ${relation.kind}`);
    }
  });
}

/** Check 2: A and B each have rows, and A has rows that B must not see. */
export function seedFindings(subject: Subject): Promise<Finding[]> {
  const { A, B } = subject.contexts;
  return eachRelation(subject, async (relation, rule) => {
    const inA = await adminRows(subject, relation, visible(rule, A));
    const inB = await adminRows(subject, relation, visible(rule, B));
    const onlyA = await adminRows(
      subject,
      relation,
      `${visible(rule, A)} AND NOT ${visible(rule, B)}`,
    );
    const details: string[] = [];
    if (inA.n === 0) details.push('tenant A has no rows: seed it');
    if (inB.n === 0) details.push('tenant B has no rows: seed it');
    if (onlyA.n === 0) details.push('no row is visible to A and hidden from B: seed one');
    return details;
  });
}

/**
 * Every free-text column holds A's canary in a row that only A sees, and in no row
 * that B sees. A column added without a canary is a finding.
 */
export function canaryFindings(
  subject: Subject,
  canaries: ReadonlyMap<string, string>,
): Promise<Finding[]> {
  const { A, B } = subject.contexts;
  return eachRelation(subject, async (relation, rule) => {
    const columns = relation.columns.filter((column) => column.freeText);
    const details = await inSequence(columns, async (column): Promise<string[]> => {
      const canary = canaries.get(`${relation.name}.${column.name}`);
      if (canary === undefined) return [`column ${column.name} has no canary of A: add one`];
      const contains = `pg_catalog.strpos(t.${ident(column.name)}::text, ${literal(canary)}) > 0`;
      const inA = await adminRows(
        subject,
        relation,
        `${visible(rule, A)} AND NOT ${visible(rule, B)} AND ${contains}`,
      );
      const inB = await adminRows(subject, relation, `${visible(rule, B)} AND ${contains}`);
      const found: string[] = [];
      if (inA.n === 0) found.push(`column ${column.name}: no row only A sees holds its canary`);
      if (inB.n > 0) found.push(`column ${column.name}: a row B sees holds A's canary`);
      return found;
    });
    return details.flat();
  });
}

/** Check 3, the positive control: in B's context an unfiltered SELECT reads exactly B's rows. */
export function selectFindings(subject: Subject): Promise<Finding[]> {
  const { B } = subject.contexts;
  return withSubjectDatabase(subject, (db) =>
    eachRelation(subject, async (relation, rule) => {
      const expected = await adminRows(subject, relation, visible(rule, B));
      const actual = await db.withTenant(B, async (client) => {
        const { rows } = await client.query<Rows>(rowsQuery(relation, 'true', false));
        return rows[0] as Rows;
      });
      if (actual.n !== expected.n) {
        return [`B's context reads ${actual.n} rows; B has ${expected.n}`];
      }
      return actual.sum === expected.sum ? [] : [`B's context reads rows other than B's`];
    }),
  );
}

/**
 * The column an unfiltered UPDATE sets: one the role may update, not the tenant
 * column, and preferably not unique, since every row it reaches gets the same value.
 */
async function updateTarget(
  subject: Subject,
  relation: Relation,
  rule: TenancyRule,
): Promise<{ column: Column; privileged: boolean }> {
  const candidates = relation.columns.filter(
    (column) => !column.generated && column.name !== rule.tenantColumn,
  );
  const ordered = [
    ...candidates.filter((column) => !column.unique),
    ...candidates.filter((column) => column.unique),
  ];
  const held = await inSequence(ordered, (column) =>
    columnPrivilege(subject, relation, column.name, 'UPDATE'),
  );
  const index = held.indexOf(true);
  const target = index >= 0 ? ordered[index] : (ordered[0] ?? relation.columns[0]);
  if (target === undefined) throw new Error(`${relation.name} has no columns`);
  return { column: target, privileged: index >= 0 };
}

/** A value of column from one of B's rows (any row when B has none), as text. */
async function valueOfB(
  subject: Subject,
  relation: Relation,
  rule: TenancyRule,
  column: Column,
): Promise<string | null> {
  const value = `t.${ident(column.name)}`;
  const { rows } = await subject.admin.query<{ value: string | null }>(
    `SELECT ${value}::text AS value FROM ${relation.name} t
     ORDER BY ${visible(rule, subject.contexts.B)} DESC, ${value} IS NULL LIMIT 1`,
  );
  return rows[0]?.value ?? null;
}

/**
 * Check 4: in B's context an unfiltered UPDATE and an unfiltered DELETE, both
 * committed, leave every row outside B as it was, xmin included, in every relation
 * of the universe. Where the role holds the privilege, the statement must reach
 * exactly B's rows; where it does not, it must be refused.
 *
 * The UPDATE sets the column to a constant, a value of one of B's rows, and reads no
 * column of the rows it changes. A statement that reads them (SET c = c, a WHERE or
 * RETURNING clause) also applies the SELECT policies, which would hide an UPDATE
 * policy that reaches A's rows.
 */
export function writeFindings(subject: Subject): Promise<Finding[]> {
  const { B } = subject.contexts;
  return withSubjectDatabase(subject, (db) =>
    eachRelation(subject, async (relation, rule) => {
      const details: string[] = [];
      const bRows = (await adminRows(subject, relation, visible(rule, B))).n;

      const { column, privileged: mayUpdate } = await updateTarget(subject, relation, rule);
      const value = await valueOfB(subject, relation, rule, column);
      const beforeUpdate = await outsideBEverywhere(subject);
      const update = await attempt(
        db,
        B,
        `UPDATE ${relation.name} SET ${ident(column.name)} = $1::${column.type}`,
        [value],
        true,
      );
      const afterUpdate = await outsideBEverywhere(subject);
      for (const changed of changedOutsideB(beforeUpdate, afterUpdate)) {
        details.push(`an unfiltered UPDATE in B's context changed rows outside B in ${changed}`);
      }
      details.push(...expectReach('UPDATE', update, mayUpdate, bRows));

      const mayDelete = await tablePrivilege(subject, relation, 'DELETE');
      const beforeDelete = await outsideBEverywhere(subject);
      const removal = await attempt(db, B, `DELETE FROM ${relation.name}`, [], true);
      const afterDelete = await outsideBEverywhere(subject);
      await subject.reseed();
      for (const changed of changedOutsideB(beforeDelete, afterDelete)) {
        details.push(`an unfiltered DELETE in B's context changed rows outside B in ${changed}`);
      }
      details.push(...expectReach('DELETE', removal, mayDelete, bRows));
      return details;
    }),
  );
}

function expectReach(
  statement: string,
  outcome: Outcome,
  privileged: boolean,
  bRows: number,
): string[] {
  if (privileged) {
    if (outcome.error !== undefined) return [`${statement} failed: ${outcome.error.message}`];
    return outcome.rowCount === bRows
      ? []
      : [`${statement} in B's context reached ${outcome.rowCount} rows; B has ${bRows}`];
  }
  return refusalOf(outcome.error) === 'privilege'
    ? []
    : [`${statement} without the privilege was not refused: ${describeOutcome(outcome)}`];
}

async function tablePrivilege(
  subject: Subject,
  relation: Relation,
  privilege: 'DELETE' | 'TRUNCATE',
): Promise<boolean> {
  const { rows } = await subject.admin.query<{ held: boolean }>(
    'SELECT pg_catalog.has_table_privilege($1, $2::regclass, $3) AS held',
    [subject.role, relation.name, privilege],
  );
  return rows[0]?.held === true;
}

function freshValue(type: string): unknown {
  if (type === 'uuid') return randomUUID();
  if (type === 'text') return `z${randomBytes(8).toString('hex')}`;
  if (type === 'bytea') return `\\x${randomBytes(32).toString('hex')}`;
  return undefined;
}

/**
 * A row for an INSERT that must be refused: a copy of one of B's rows that names
 * tenant A, or for a relation without a tenant column a copy of a row only A sees.
 * Unique columns get new values, so nothing but the tenant boundary stands in the
 * way of the insert.
 */
async function rowForA(
  subject: Subject,
  relation: Relation,
  rule: TenancyRule,
): Promise<Record<string, unknown> | undefined> {
  const { A, B } = subject.contexts;
  const where =
    rule.tenantColumn === null
      ? `${visible(rule, A)} AND NOT ${visible(rule, B)}`
      : visible(rule, B);
  const { rows } = await subject.admin.query<{ row: Record<string, unknown> }>(
    `SELECT to_jsonb(t) AS row FROM ${relation.name} t WHERE ${where} LIMIT 1`,
  );
  const row = rows[0]?.row;
  if (row === undefined) return undefined;
  for (const column of relation.columns) {
    if (column.unique && column.name !== rule.tenantColumn) {
      const value = freshValue(column.type);
      if (value !== undefined) row[column.name] = value;
    }
  }
  if (rule.tenantColumn !== null) row[rule.tenantColumn] = A.tenantId;
  return row;
}

/**
 * Check 5: in B's context, an INSERT of a row that belongs to A is refused, and so
 * is an UPDATE that moves B's rows to A. The refusal must come from the policy when
 * the role holds the privilege, and from the missing privilege otherwise.
 */
export function crossTenantWriteFindings(subject: Subject): Promise<Finding[]> {
  const { A, B } = subject.contexts;
  return withSubjectDatabase(subject, (db) =>
    eachRelation(subject, async (relation, rule) => {
      const details: string[] = [];
      const insertable = relation.columns.filter((column) => !column.generated);
      const names = insertable.map((column) => ident(column.name)).join(', ');
      const row = await rowForA(subject, relation, rule);
      if (row === undefined) return ['no row to copy for the INSERT: seed one'];
      const mayInsert = (
        await inSequence(insertable, (column) =>
          columnPrivilege(subject, relation, column.name, 'INSERT'),
        )
      ).every(Boolean);
      const insert = await attempt(
        db,
        B,
        `INSERT INTO ${relation.name} (${names})
         SELECT ${names} FROM jsonb_populate_record(NULL::${relation.name}, $1::jsonb)`,
        [JSON.stringify(row)],
        false,
      );
      const expected: Refusal = mayInsert ? 'policy' : 'privilege';
      if (refusalOf(insert.error) !== expected) {
        details.push(
          `an INSERT of a row of A in B's context was not refused by the ${expected}: ` +
            describeOutcome(insert),
        );
      }
      if (rule.tenantColumn !== null) {
        const column = ident(rule.tenantColumn);
        const mayMove = await columnPrivilege(subject, relation, rule.tenantColumn, 'UPDATE');
        const move = await attempt(
          db,
          B,
          `UPDATE ${relation.name} SET ${column} = $1::uuid`,
          [A.tenantId],
          false,
        );
        const expectedMove: Refusal = mayMove ? 'policy' : 'privilege';
        if (refusalOf(move.error) !== expectedMove) {
          details.push(
            `an UPDATE moving B's rows to A was not refused by the ${expectedMove}: ` +
              describeOutcome(move),
          );
        }
      }
      return details;
    }),
  );
}

function countWithPid(relation: Relation): string {
  return `SELECT count(*)::int AS n, pg_catalog.pg_backend_pid() AS pid FROM ${relation.name}`;
}

/**
 * Check 6: with no tenant set a relation reads no rows, both on a new connection and
 * on a pooled connection whose previous transaction ran in A's context. The pooled
 * case first reads A's rows there (positive control) and must stay on the same
 * backend.
 */
export async function noTenantFindings(subject: Subject): Promise<Finding[]> {
  const { A } = subject.contexts;
  const fresh = await connectClient(subject.url, 'rff-test-isolation');
  let freshFindings: Finding[];
  try {
    freshFindings = await eachRelation(subject, async (relation) => {
      const { rows } = await fresh.query<{ n: number }>(countWithPid(relation));
      const n = rows[0]?.n ?? -1;
      return n === 0 ? [] : [`a new connection with no tenant set reads ${n} rows`];
    });
  } finally {
    await fresh.end();
  }
  const reusedFindings = await withSubjectDatabase(subject, (db, pool) =>
    eachRelation(subject, async (relation, rule) => {
      const details: string[] = [];
      const expected = (await adminRows(subject, relation, visible(rule, A))).n;
      const inA = await db.withTenant(A, async (client) => {
        const { rows } = await client.query<{ n: number; pid: number }>(countWithPid(relation));
        return rows[0] as { n: number; pid: number };
      });
      if (inA.n !== expected) {
        details.push(`in A's context the pooled connection read ${inA.n} rows; A has ${expected}`);
      }
      const { rows } = await pool.query<{ n: number; pid: number }>(countWithPid(relation));
      const after = rows[0] as { n: number; pid: number };
      if (after.pid !== inA.pid) details.push('the pool did not reuse the connection');
      if (after.n !== 0) {
        details.push(`the connection reused after A's transaction reads ${after.n} rows`);
      }
      return details;
    }),
  );
  return [...freshFindings, ...reusedFindings];
}

const ROLE = '(role)';

/**
 * Check 7: the role is no superuser, lacks BYPASSRLS, owns nothing and is a member
 * of no role that does (the start-up check), can create no schema, no object and no
 * temporary object, and holds no TRUNCATE, TRIGGER, REFERENCES or MAINTAIN on any
 * relation of the universe.
 */
export async function privilegeFindings(subject: Subject): Promise<Finding[]> {
  const client = await connectClient(subject.url, 'rff-test-isolation');
  try {
    const findings: Finding[] = (await inspectRole(client)).problems.map((detail) => ({
      relation: ROLE,
      detail,
    }));
    const { rows: schemas } = await client.query<{ name: string }>(
      `SELECT pg_catalog.format('%I', n.nspname) AS name FROM pg_catalog.pg_namespace n
       WHERE pg_catalog.has_schema_privilege(n.oid, 'CREATE')
         AND n.nspname NOT IN ('pg_catalog', 'information_schema')
         AND n.nspname !~ '^pg_(toast|temp_)'
       ORDER BY 1`,
    );
    for (const { name } of schemas) {
      findings.push({ relation: ROLE, detail: `can create objects in schema ${name}` });
    }
    const { rows: database } = await client.query<{ create: boolean; temporary: boolean }>(
      `SELECT pg_catalog.has_database_privilege(pg_catalog.current_database(), 'CREATE') AS create,
              pg_catalog.has_database_privilege(pg_catalog.current_database(), 'TEMPORARY')
                AS temporary`,
    );
    if (database[0]?.create === true) {
      findings.push({ relation: ROLE, detail: 'can create schemas in the database' });
    }
    if (database[0]?.temporary === true) {
      findings.push({
        relation: ROLE,
        detail: 'can create temporary tables, views and functions in the database',
      });
    }
    const perRelation = await inSequence(subject.relations, async (relation) => {
      const { rows } = await client.query<Record<string, boolean>>(
        `SELECT pg_catalog.has_table_privilege($1::regclass, 'TRUNCATE') AS "TRUNCATE",
                pg_catalog.has_table_privilege($1::regclass, 'TRIGGER') AS "TRIGGER",
                pg_catalog.has_any_column_privilege($1::regclass, 'REFERENCES') AS "REFERENCES",
                pg_catalog.has_table_privilege($1::regclass, 'MAINTAIN') AS "MAINTAIN"`,
        [relation.name],
      );
      return Object.entries(rows[0] ?? {})
        .filter(([, held]) => held)
        .map(([privilege]) => ({ relation: relation.name, detail: `holds ${privilege}` }));
    });
    return [...findings, ...perRelation.flat()];
  } finally {
    await client.end();
  }
}

/** What a SECURITY DEFINER function on the allow-list must look like. */
export interface AllowedDefiner {
  readonly owner: string;
  readonly config: readonly string[];
}

/**
 * Every SECURITY DEFINER function is on the allow-list and every entry exists. Each
 * returns a single value (no set), is owned by the expected role with a fixed
 * search_path, can be run by the role under test and not by PUBLIC.
 */
export function definerFindings(
  functions: readonly DefinerFunction[],
  allowList: Readonly<Record<string, AllowedDefiner>>,
): Finding[] {
  const findings: Finding[] = [];
  const found = new Set(functions.map((fn) => fn.signature));
  for (const signature of Object.keys(allowList)) {
    if (!found.has(signature)) {
      findings.push({ relation: signature, detail: 'is on the allow-list but does not exist' });
    }
  }
  for (const fn of functions) {
    const allowed = allowList[fn.signature];
    const finding = (detail: string): void => {
      findings.push({ relation: fn.signature, detail });
    };
    if (allowed === undefined) {
      finding('is SECURITY DEFINER and not on the allow-list: add it with its cases');
      continue;
    }
    if (fn.owner !== allowed.owner) finding(`is owned by ${fn.owner}, not ${allowed.owner}`);
    if (JSON.stringify(fn.config) !== JSON.stringify(allowed.config)) {
      finding(`runs with ${JSON.stringify(fn.config)}, not ${JSON.stringify(allowed.config)}`);
    }
    if (fn.returnsSet) finding('returns a set of rows');
    if (fn.publicExecutes) finding('PUBLIC can execute it');
    if (!fn.roleExecutes) finding('the role under test cannot execute it');
  }
  return findings;
}

/** One call of a look-up function and the value it must return. */
export interface LookupCase {
  readonly signature: string;
  readonly label: string;
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly expected: string | null;
}

/** A value for a setting, or undefined for a session that never set it. */
export interface SettingValue {
  readonly label: string;
  readonly value: string | undefined;
}

/**
 * Runs every case under every combination of app.tenant_id and app.user_id values,
 * each combination on a new connection as the role under test, and reports every
 * call whose result differs from the expected value.
 */
export async function lookupFindings(
  url: string,
  cases: readonly LookupCase[],
  tenantSettings: readonly SettingValue[],
  userSettings: readonly SettingValue[],
): Promise<{ findings: Finding[]; calls: number }> {
  const combinations = tenantSettings.flatMap((tenant) =>
    userSettings.map((user) => ({ tenant, user })),
  );
  let calls = 0;
  const findings = await inSequence(combinations, async ({ tenant, user }) => {
    const client = await connectClient(url, 'rff-test-isolation');
    try {
      await client.query('BEGIN');
      for (const [name, setting] of [
        ['app.tenant_id', tenant],
        ['app.user_id', user],
      ] as const) {
        if (setting.value !== undefined) {
          // eslint-disable-next-line no-await-in-loop -- one client, one statement at a time
          await client.query('SELECT pg_catalog.set_config($1, $2, true)', [name, setting.value]);
        }
      }
      const results = await inSequence(cases, async (lookup): Promise<Finding[]> => {
        calls += 1;
        // A failed call is a finding too; a savepoint keeps the transaction usable.
        await client.query('SAVEPOINT lookup');
        let value: string | null;
        try {
          const { rows } = await client.query<{ value: string | null }>(lookup.sql, [
            ...lookup.params,
          ]);
          value = rows.length === 1 ? (rows[0]?.value ?? null) : `${rows.length} rows`;
          await client.query('RELEASE SAVEPOINT lookup');
        } catch (error) {
          value = `an error (${error instanceof Error ? error.message : String(error)})`;
          await client.query('ROLLBACK TO SAVEPOINT lookup');
        }
        return value === lookup.expected
          ? []
          : [
              {
                relation: lookup.signature,
                detail:
                  `${lookup.label} with app.tenant_id ${tenant.label} and app.user_id ` +
                  `${user.label} gave ${String(value)}, expected ${String(lookup.expected)}`,
              },
            ];
      });
      await client.query('ROLLBACK');
      return results.flat();
    } finally {
      await client.end();
    }
  });
  return { findings: findings.flat(), calls };
}
