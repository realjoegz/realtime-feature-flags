import { createHash } from 'node:crypto';
import { validateFlag } from '@rff/core';
import type pg from 'pg';
import { DEMO_TENANTS, DEMO_USERS, type DemoTenant, type DemoUser } from './demo-data.js';
import { dexSubject } from './dex-subject.js';

// Writes the demo data as the database superuser, which row-level security does not
// apply to, in one transaction. A run changes nothing that is already there, so
// running it again after every "docker compose up" is safe:
//
// - A user is inserted only when neither its id nor its (issuer, subject) is taken.
//   A user that erased itself with DELETE /me keeps its row and id with NULL fields,
//   so its id is taken and it stays erased.
// - A tenant is inserted only when neither its id nor its slug is taken, and only a
//   tenant inserted by this run gets the demo memberships, flags and SDK key. Flags,
//   members and keys changed or removed through the API stay as they are.
//
// A tenant's flags start at version 1. No audit row is written: audit rows name the
// user who made a change, and no user made these.

export interface SeedOptions {
  /** The issuer of the users' tokens, exactly as tokens carry it in "iss". */
  readonly issuer: string;
  readonly log?: (message: string) => void;
}

export interface SeedResult {
  readonly usersCreated: number;
  readonly tenantsCreated: readonly string[];
  readonly tenantsKept: readonly string[];
}

// Transaction-level, so two seeds of one database take turns.
const LOCK = `SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('rff demo seed'))`;

export function sdkKeyHash(key: string): Buffer {
  return createHash('sha256').update(key).digest();
}

export async function seedDemo(client: pg.ClientBase, options: SeedOptions): Promise<SeedResult> {
  const log = options.log ?? (() => {});
  for (const tenant of DEMO_TENANTS) {
    for (const flag of tenant.flags) {
      const result = validateFlag(flag);
      if (!result.ok) {
        throw new Error(`demo flag ${tenant.slug}/${flag.key}: ${result.errors.join('; ')}`);
      }
    }
  }
  await client.query('BEGIN');
  try {
    await client.query(LOCK);
    const usersCreated = await insertUsers(client, options.issuer, DEMO_USERS);
    const tenantsCreated: string[] = [];
    const tenantsKept: string[] = [];
    for (const tenant of DEMO_TENANTS) {
      // eslint-disable-next-line no-await-in-loop -- one transaction, one statement at a time
      if (await insertTenant(client, options.issuer, tenant)) tenantsCreated.push(tenant.slug);
      else tenantsKept.push(tenant.slug);
    }
    await client.query('COMMIT');
    log(`${usersCreated} of ${DEMO_USERS.length} users created`);
    for (const slug of tenantsCreated)
      log(`tenant ${slug} created with its members, flags and SDK key`);
    for (const slug of tenantsKept) log(`tenant ${slug} exists and was left as it is`);
    return { usersCreated, tenantsCreated, tenantsKept };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function insertUsers(
  client: pg.ClientBase,
  issuer: string,
  users: readonly DemoUser[],
): Promise<number> {
  // ON CONFLICT DO NOTHING without a target skips a row that conflicts on the
  // primary key or on (idp_issuer, idp_subject).
  const { rowCount } = await client.query(
    `INSERT INTO public.users (id, idp_issuer, idp_subject, email, name)
     SELECT id, $2, subject, email, name
     FROM unnest($1::uuid[], $3::text[], $4::text[], $5::text[]) AS u(id, subject, email, name)
     ON CONFLICT DO NOTHING`,
    [
      users.map((user) => user.id),
      issuer,
      users.map((user) => dexSubject(user.dexUserId)),
      users.map((user) => user.email),
      users.map((user) => user.name),
    ],
  );
  return rowCount ?? 0;
}

async function insertTenant(
  client: pg.ClientBase,
  issuer: string,
  tenant: DemoTenant,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `INSERT INTO public.tenants (id, slug, name, version) VALUES ($1, $2, $3, 1)
     ON CONFLICT DO NOTHING`,
    [tenant.id, tenant.slug, tenant.name],
  );
  if (rowCount !== 1) return false;
  // Members are found by (issuer, subject), as sign-in finds them, and only while
  // they have not erased themselves.
  const byEmail = new Map(DEMO_USERS.map((user) => [user.email, user]));
  const members = tenant.members.map((member) => {
    const user = byEmail.get(member.email);
    if (user === undefined) throw new Error(`demo tenant ${tenant.slug}: no user ${member.email}`);
    return { subject: dexSubject(user.dexUserId), role: member.role };
  });
  await client.query(
    `INSERT INTO public.memberships (tenant_id, user_id, role)
     SELECT $1, u.id, m.role::public.member_role
     FROM unnest($3::text[], $4::text[]) AS m(subject, role)
     JOIN public.users u ON u.idp_issuer = $2 AND u.idp_subject = m.subject`,
    [
      tenant.id,
      issuer,
      members.map((member) => member.subject),
      members.map((member) => member.role),
    ],
  );
  await client.query(
    `INSERT INTO public.flags (tenant_id, key, enabled, salt, rules, rollout_bp)
     SELECT $1, f.key, f.enabled, f.salt, f.rules, f.rollout_bp
     FROM unnest($2::text[], $3::boolean[], $4::text[], $5::jsonb[], $6::integer[])
       AS f(key, enabled, salt, rules, rollout_bp)`,
    [
      tenant.id,
      tenant.flags.map((flag) => flag.key),
      tenant.flags.map((flag) => flag.enabled),
      tenant.flags.map((flag) => flag.salt),
      tenant.flags.map((flag) => JSON.stringify(flag.rules)),
      tenant.flags.map((flag) => flag.rolloutBasisPoints),
    ],
  );
  await client.query('INSERT INTO public.sdk_keys (tenant_id, key_hash) VALUES ($1, $2)', [
    tenant.id,
    sdkKeyHash(tenant.sdkKey),
  ]);
  return true;
}
