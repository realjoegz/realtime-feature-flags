import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Relation } from './catalogue.js';

// Two tenants, A and B, with the same flag keys and different values, and a unique
// canary string in every free-text column of A. B's rows hold no canary, so a canary
// that turns up in B's context is a leak of A. Every id and canary is new for each
// fixture, so two fixtures never collide.

export interface Scope {
  readonly tenantId: string;
  readonly userId: string | null;
}

/** Which rows of a relation a scope sees, stated on the admin connection. */
export interface TenancyRule {
  /** SQL that is true for the rows (alias t) visible to the scope. */
  readonly visibleIn: (scope: Scope) => string;
  /** The column that names a row's tenant, or null when the relation has none. */
  readonly tenantColumn: string | null;
}

/** A SQL uuid literal; the value is checked first, so it cannot break out of the quotes. */
export function uuidLiteral(value: string | null): string {
  if (value === null) return 'NULL::uuid';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) {
    throw new Error(`not a lowercase UUID: ${value}`);
  }
  return `'${value}'::uuid`;
}

const byTenantColumn = (column: string): TenancyRule => ({
  visibleIn: (scope) => `t.${column} = ${uuidLiteral(scope.tenantId)}`,
  tenantColumn: column,
});

/**
 * The relations whose tenant is not in a tenant_id column. users follows its policy
 * in migration 0002: the current user, and the members of the current tenant.
 */
export const TENANCY_RULES: Readonly<Record<string, TenancyRule>> = {
  'public.tenants': byTenantColumn('id'),
  'public.users': {
    visibleIn: (scope) =>
      `(t.id = ${uuidLiteral(scope.userId)} OR EXISTS (
         SELECT FROM public.memberships m
         WHERE m.user_id = t.id AND m.tenant_id = ${uuidLiteral(scope.tenantId)}))`,
    tenantColumn: null,
  },
};

/** The rule for a relation: an explicit one, else its tenant_id column, else none. */
export function tenancyRule(
  relation: Relation,
  rules: Readonly<Record<string, TenancyRule>> = TENANCY_RULES,
): TenancyRule | undefined {
  const explicit = rules[relation.name];
  if (explicit !== undefined) return explicit;
  const tenantId = relation.columns.find((column) => column.name === 'tenant_id');
  return tenantId?.type === 'uuid' ? byTenantColumn('tenant_id') : undefined;
}

export interface FixtureUser {
  readonly id: string;
  readonly issuer: string;
  readonly subject: string;
  readonly email: string;
  readonly name: string;
}

export interface FixtureSdkKey {
  readonly id: string;
  readonly tenantId: string;
  /** rff_sdk_ and 32 random bytes in base64url, as the API issues them. */
  readonly key: string;
  readonly hash: Buffer;
  readonly revoked: boolean;
}

export interface Fixture {
  readonly tenantA: string;
  readonly tenantB: string;
  readonly users: {
    /** Owner in A and viewer in B. */
    readonly shared: FixtureUser;
    /** Editor in A only. Every text column holds a canary. */
    readonly aEditor: FixtureUser;
    /** Viewer in A only. */
    readonly aViewer: FixtureUser;
    /** Editor in B only. */
    readonly bEditor: FixtureUser;
    /** In neither tenant. */
    readonly nobody: FixtureUser;
  };
  readonly sdkKeys: {
    readonly aActive: FixtureSdkKey;
    readonly aRevoked: FixtureSdkKey;
    readonly bActive: FixtureSdkKey;
  };
  /** The scopes the checks use: the shared user acting in A, and in B. */
  readonly contexts: { readonly A: Scope; readonly B: Scope };
  /** schema.table.column -> the canary that A's rows hold in that column. */
  readonly canaries: ReadonlyMap<string, string>;
  /** Empties every tenant table and inserts the fixture's rows. */
  seed(admin: pg.ClientBase): Promise<void>;
}

const hex = (bytes: number): string => randomBytes(bytes).toString('hex');

function sdkKey(tenantId: string, revoked: boolean): FixtureSdkKey {
  const key = `rff_sdk_${randomBytes(32).toString('base64url')}`;
  return {
    id: randomUUID(),
    tenantId,
    key,
    hash: createHash('sha256').update(key).digest(),
    revoked,
  };
}

export function createFixture(): Fixture {
  const canaries = new Map<string, string>();
  // "canary" and 12 hex digits fits the slug and flag key formats.
  const canary = (column: string, make = () => `canary${hex(6)}`): string => {
    const value = make();
    canaries.set(column, value);
    return value;
  };

  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const issuer = 'https://idp.example.test';
  const user = (label: string): FixtureUser => {
    const tag = `${label}-${hex(4)}`;
    return {
      id: randomUUID(),
      issuer,
      subject: tag,
      email: `${tag}@example.test`,
      name: `User ${tag}`,
    };
  };
  const users = {
    shared: user('shared'),
    aEditor: {
      id: randomUUID(),
      issuer: canary('public.users.idp_issuer'),
      subject: canary('public.users.idp_subject'),
      email: `${canary('public.users.email')}@example.test`,
      name: canary('public.users.name'),
    },
    aViewer: user('a-viewer'),
    bEditor: user('b-editor'),
    nobody: user('nobody'),
  };
  const sdkKeys = {
    aActive: sdkKey(tenantA, false),
    aRevoked: sdkKey(tenantA, true),
    bActive: sdkKey(tenantB, false),
  };

  const tenants = [
    {
      id: tenantA,
      slug: canary('public.tenants.slug'),
      name: canary('public.tenants.name'),
      version: 3,
    },
    { id: tenantB, slug: `tenant-b-${hex(4)}`, name: 'Tenant B', version: 1 },
  ];
  const memberships = [
    { tenant: tenantA, user: users.shared.id, role: 'owner' },
    { tenant: tenantA, user: users.aEditor.id, role: 'editor' },
    { tenant: tenantA, user: users.aViewer.id, role: 'viewer' },
    { tenant: tenantB, user: users.shared.id, role: 'viewer' },
    { tenant: tenantB, user: users.bEditor.id, role: 'editor' },
  ];
  // checkout and search exist in both tenants with different values.
  const flags = [
    { tenant: tenantA, key: 'checkout', enabled: true, salt: hex(8), rules: [], rollout: 2500 },
    {
      tenant: tenantA,
      key: 'search',
      enabled: false,
      salt: hex(8),
      rules: [{ attribute: 'country', operator: 'in', values: ['NL', 'BE'], serve: true }],
      rollout: 0,
    },
    {
      tenant: tenantA,
      key: canary('public.flags.key'),
      enabled: true,
      salt: canary('public.flags.salt', () => hex(8)),
      rules: [
        {
          attribute: 'plan',
          operator: 'equals',
          values: [canary('public.flags.rules')],
          serve: true,
        },
      ],
      rollout: 5000,
    },
    { tenant: tenantB, key: 'checkout', enabled: false, salt: hex(8), rules: [], rollout: 7500 },
    {
      tenant: tenantB,
      key: 'search',
      enabled: true,
      salt: hex(8),
      rules: [{ attribute: 'plan', operator: 'equals', values: ['pro'], serve: false }],
      rollout: 10000,
    },
  ];
  const audit = [
    {
      tenant: tenantA,
      actor: users.shared.id,
      action: canary('public.audit_log.action'),
      target: canary('public.audit_log.target'),
      before: { enabled: false, note: canary('public.audit_log.before') },
      after: { enabled: true, note: canary('public.audit_log.after') },
      version: 2,
    },
    {
      tenant: tenantA,
      actor: users.aEditor.id,
      action: 'flag.update',
      target: 'checkout',
      before: { rolloutBasisPoints: 1000 },
      after: { rolloutBasisPoints: 2500 },
      version: 3,
    },
    {
      tenant: tenantB,
      actor: users.shared.id,
      action: 'flag.create',
      target: 'checkout',
      before: null,
      after: { rolloutBasisPoints: 7500 },
      version: 1,
    },
  ];

  async function seed(admin: pg.ClientBase): Promise<void> {
    await admin.query('BEGIN');
    try {
      // CASCADE also empties any table that a later migration adds with a foreign key
      // to these, so a table the seed does not fill fails the precondition check.
      await admin.query(
        `TRUNCATE public.audit_log, public.sdk_keys, public.flags, public.memberships,
                  public.users, public.tenants CASCADE`,
      );
      await admin.query(
        `INSERT INTO public.tenants (id, slug, name, version)
         SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[], $4::bigint[])`,
        [
          tenants.map((t) => t.id),
          tenants.map((t) => t.slug),
          tenants.map((t) => t.name),
          tenants.map((t) => t.version),
        ],
      );
      const all = Object.values(users);
      await admin.query(
        `INSERT INTO public.users (id, idp_issuer, idp_subject, email, name)
         SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::text[])`,
        [
          all.map((u) => u.id),
          all.map((u) => u.issuer),
          all.map((u) => u.subject),
          all.map((u) => u.email),
          all.map((u) => u.name),
        ],
      );
      await admin.query(
        `INSERT INTO public.memberships (tenant_id, user_id, role)
         SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::public.member_role[])`,
        [
          memberships.map((m) => m.tenant),
          memberships.map((m) => m.user),
          memberships.map((m) => m.role),
        ],
      );
      await admin.query(
        `INSERT INTO public.flags (tenant_id, key, enabled, salt, rules, rollout_bp)
         SELECT * FROM unnest($1::uuid[], $2::text[], $3::boolean[], $4::text[], $5::jsonb[],
                              $6::integer[])`,
        [
          flags.map((f) => f.tenant),
          flags.map((f) => f.key),
          flags.map((f) => f.enabled),
          flags.map((f) => f.salt),
          flags.map((f) => JSON.stringify(f.rules)),
          flags.map((f) => f.rollout),
        ],
      );
      const keys = Object.values(sdkKeys);
      await admin.query(
        `INSERT INTO public.sdk_keys (id, tenant_id, key_hash, revoked_at)
         SELECT id, tenant_id, key_hash, CASE WHEN revoked THEN pg_catalog.now() END
         FROM unnest($1::uuid[], $2::uuid[], $3::bytea[], $4::boolean[])
           AS k (id, tenant_id, key_hash, revoked)`,
        [
          keys.map((k) => k.id),
          keys.map((k) => k.tenantId),
          keys.map((k) => k.hash),
          keys.map((k) => k.revoked),
        ],
      );
      await admin.query(
        `INSERT INTO public.audit_log (tenant_id, actor_user_id, action, target, before, after,
                                       version)
         SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::text[], $5::jsonb[],
                              $6::jsonb[], $7::bigint[])`,
        [
          audit.map((a) => a.tenant),
          audit.map((a) => a.actor),
          audit.map((a) => a.action),
          audit.map((a) => a.target),
          audit.map((a) => (a.before === null ? null : JSON.stringify(a.before))),
          audit.map((a) => JSON.stringify(a.after)),
          audit.map((a) => a.version),
        ],
      );
      await admin.query('COMMIT');
    } catch (error) {
      await admin.query('ROLLBACK').catch(() => {});
      throw error;
    }
  }

  return {
    tenantA,
    tenantB,
    users,
    sdkKeys,
    contexts: {
      A: { tenantId: tenantA, userId: users.shared.id },
      B: { tenantId: tenantB, userId: users.shared.id },
    },
    canaries,
    seed,
  };
}
