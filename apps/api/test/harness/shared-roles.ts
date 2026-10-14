import { connectClient } from '../../src/database/connect.js';

// rff_app and rff_owner belong to the whole Postgres server, not to a run's database,
// so every run on one server shares them. Honest runs leave them exactly as migration
// 0001 does. A run that changes 0001 or the roles (a mutation check, for example)
// changes them for every other run on that server, and so must use its own Postgres
// through RFF_TEST_ADMIN_URL. The harness checks the roles when a run starts and when
// it ends, so a run that another run disturbed fails with this reason.

interface RoleRow {
  rolname: string;
  rolcanlogin: boolean;
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolreplication: boolean;
}

const EXPECTED: Readonly<Record<string, Omit<RoleRow, 'rolname'>>> = {
  rff_app: {
    rolcanlogin: true,
    rolsuper: false,
    rolbypassrls: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolreplication: false,
  },
  rff_owner: {
    rolcanlogin: false,
    rolsuper: false,
    rolbypassrls: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolreplication: false,
  },
};

/**
 * What differs between the shared roles and the state 0001 leaves them in, and
 * whether rff_app still logs in through appUrl. Empty when nothing differs.
 */
export async function sharedRoleProblems(adminUrl: string, appUrl: string): Promise<string[]> {
  const problems: string[] = [];
  const admin = await connectClient(adminUrl, 'rff-test-roles-check');
  try {
    const { rows } = await admin.query<RoleRow>(
      `SELECT rolname, rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole,
              rolreplication
       FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[])`,
      [Object.keys(EXPECTED)],
    );
    for (const [name, expected] of Object.entries(EXPECTED)) {
      const row = rows.find((candidate) => candidate.rolname === name);
      if (row === undefined) {
        problems.push(`${name} does not exist`);
        continue;
      }
      for (const [attribute, value] of Object.entries(expected)) {
        const actual = row[attribute as keyof typeof expected];
        if (actual !== value) problems.push(`${name}.${attribute} is ${actual}, not ${value}`);
      }
    }
  } finally {
    await admin.end();
  }
  try {
    const app = await connectClient(appUrl, 'rff-test-roles-check');
    await app.end();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    problems.push(`rff_app cannot log in with this run's password (${message})`);
  }
  return problems;
}

export class SharedRolesChangedError extends Error {
  constructor(when: string, problems: readonly string[]) {
    super(
      `${when}, the shared roles are not as migration 0001 leaves them: ` +
        `${problems.join('; ')}. Another run on this Postgres server may have changed ` +
        'them. A run that changes 0001 or the roles needs its own server (RFF_TEST_ADMIN_URL).',
    );
    this.name = 'SharedRolesChangedError';
  }
}
