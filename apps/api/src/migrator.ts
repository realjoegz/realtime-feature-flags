import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

// Plain SQL files apps/api/migrations/NNNN_name.sql, applied in order. Each file runs
// in its own transaction together with the row that records it, so a file is either
// applied and recorded or neither. A recorded file whose bytes changed stops the run.

/** apps/api/migrations, from src/ (tests) and from dist/ (the image) alike. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

const FILE_NAME = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly file: string;
  readonly sql: string;
  /** SHA-256 of the file's bytes, hex. */
  readonly checksum: string;
}

export interface MigrateOptions {
  /**
   * Transaction-local settings the SQL reads with current_setting(), set with
   * set_config(name, value, true) before each file. Secrets go here, never into files.
   */
  readonly settings?: Readonly<Record<string, string>>;
  readonly log?: (message: string) => void;
}

export interface MigrateResult {
  readonly applied: readonly Migration[];
  readonly alreadyApplied: number;
}

export async function readMigrations(dir: string): Promise<Migration[]> {
  // Dot files (.DS_Store and the like) are not migrations; anything else must match.
  const entries = (await readdir(dir)).filter((file) => !file.startsWith('.')).toSorted();
  const migrations = await Promise.all(
    entries.map(async (file): Promise<Migration> => {
      const match = FILE_NAME.exec(file);
      if (match === null) {
        throw new Error(`${join(dir, file)}: migration files are named NNNN_name.sql`);
      }
      const bytes = await readFile(join(dir, file));
      return {
        version: Number(match[1]),
        name: match[2] as string,
        file,
        sql: bytes.toString('utf8'),
        checksum: createHash('sha256').update(bytes).digest('hex'),
      };
    }),
  );
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(
        `${dir}: expected migration ${pad(index + 1)} but found ${migration.file}; ` +
          'versions start at 0001 and have no gaps or duplicates',
      );
    }
  });
  return migrations;
}

// Session-level, so two runners on one database take turns for the whole run.
const LOCK = `SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtext('rff migrations'))`;
const UNLOCK = `SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtext('rff migrations'))`;

/** Applies every migration that the database has not recorded yet. client is not a pool. */
export async function migrate(
  client: pg.ClientBase,
  migrations: readonly Migration[],
  options: MigrateOptions = {},
): Promise<MigrateResult> {
  const log = options.log ?? (() => {});
  await client.query(LOCK);
  let result: MigrateResult;
  try {
    result = await applyPending(client, migrations, options.settings ?? {}, log);
  } catch (error) {
    // The connection may be gone; the original error is the one worth reporting.
    await client.query(UNLOCK).catch(() => {});
    throw error;
  }
  await client.query(UNLOCK);
  return result;
}

async function applyPending(
  client: pg.ClientBase,
  migrations: readonly Migration[],
  settings: Readonly<Record<string, string>>,
  log: (message: string) => void,
): Promise<MigrateResult> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      version integer PRIMARY KEY,
      name text NOT NULL,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT pg_catalog.now()
    )`);
  const { rows } = await client.query<{ version: number; name: string; checksum: string }>(
    'SELECT version, name, checksum FROM public.schema_migrations ORDER BY version',
  );
  rows.forEach((row, index) => {
    const migration = migrations[index];
    const recorded = `${pad(row.version)}_${row.name}`;
    if (row.version !== index + 1) {
      throw new Error(`schema_migrations has ${recorded} where ${pad(index + 1)} belongs`);
    }
    if (migration === undefined) {
      throw new Error(
        `the database has migration ${recorded}, which is not in this release; ` +
          'a newer release migrated it',
      );
    }
    if (migration.name !== row.name || migration.checksum !== row.checksum) {
      throw new Error(
        `${migration.file} changed after it was applied as ${recorded}; ` +
          'add a new migration instead of editing an applied one',
      );
    }
  });
  const pending = migrations.slice(rows.length);
  for (const migration of pending) {
    // eslint-disable-next-line no-await-in-loop -- migrations apply in order, one at a time
    await applyOne(client, migration, settings);
    log(`applied ${migration.file}`);
  }
  if (pending.length === 0) log(`nothing to apply: ${rows.length} migrations already applied`);
  return { applied: pending, alreadyApplied: rows.length };
}

async function applyOne(
  client: pg.ClientBase,
  migration: Migration,
  settings: Readonly<Record<string, string>>,
): Promise<void> {
  await client.query('BEGIN');
  try {
    const names = Object.keys(settings);
    if (names.length > 0) {
      await client.query(
        'SELECT pg_catalog.set_config(name, value, true) FROM unnest($1::text[], $2::text[]) AS s(name, value)',
        [names, Object.values(settings)],
      );
    }
    // No parameters, so pg uses the simple query protocol, which runs every
    // statement in the file.
    await client.query(migration.sql);
    await client.query(
      'INSERT INTO public.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
      [migration.version, migration.name, migration.checksum],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${migration.file} failed and was rolled back: ${message}`, { cause: error });
  }
}

function pad(version: number): string {
  return String(version).padStart(4, '0');
}
