import { cp, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { connectClient } from '../src/database/connect.js';
import { MIGRATIONS_DIR, migrate, readMigrations } from '../src/migrator.js';
import { createScratchDatabase } from './harness/context.js';

const fixtures = fileURLToPath(new URL('./fixtures/migrations/', import.meta.url));
const fixture = (name: string): string => join(fixtures, name);

const temporary: string[] = [];
afterAll(async () => {
  await Promise.all(temporary.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A connected superuser client on a new, empty database. */
async function emptyDatabase(label: string): Promise<pg.Client> {
  const scratch = await createScratchDatabase(label);
  return connectClient(scratch.adminUrl, 'rff-test-migrations');
}

async function recorded(client: pg.ClientBase): Promise<{ version: number; name: string }[]> {
  const { rows } = await client.query<{ version: number; name: string }>(
    'SELECT version, name FROM schema_migrations ORDER BY version',
  );
  return rows;
}

describe('migration runner', () => {
  it('applies the files in order, records each one, and a second run applies nothing', async () => {
    const client = await emptyDatabase('mgorder');
    try {
      const migrations = await readMigrations(fixture('two-files'));
      const first = await migrate(client, migrations);
      expect(first.applied.map((m) => m.file)).toEqual([
        '0001_create_notes.sql',
        '0002_add_tags.sql',
      ]);
      expect(first.alreadyApplied).toBe(0);
      expect(await recorded(client)).toEqual([
        { version: 1, name: 'create_notes' },
        { version: 2, name: 'add_tags' },
      ]);
      const { rows } = await client.query('SELECT tag FROM tags JOIN notes ON notes.id = note_id');
      expect(rows).toEqual([{ tag: 'from 0002' }]);

      const second = await migrate(client, migrations);
      expect(second).toEqual({ applied: [], alreadyApplied: 2 });
      expect(await recorded(client)).toHaveLength(2);
    } finally {
      await client.end();
    }
  });

  it('a failing file is rolled back and not recorded, and the files before it stay applied', async () => {
    const client = await emptyDatabase('mgfail');
    try {
      await expect(migrate(client, await readMigrations(fixture('second-fails')))).rejects.toThrow(
        '0002_fails_halfway.sql failed and was rolled back: division by zero',
      );
      expect(await recorded(client)).toEqual([{ version: 1, name: 'create_notes' }]);
      const tags = await client.query(`SELECT to_regclass('public.tags') AS t`);
      expect(tags.rows).toEqual([{ t: null }]);
      const notes = await client.query('SELECT id FROM notes ORDER BY id');
      expect(notes.rows).toEqual([{ id: 1 }]);
    } finally {
      await client.end();
    }
  });

  it('a file whose record cannot be written is rolled back with it', async () => {
    const client = await emptyDatabase('mgrecord');
    try {
      await expect(
        migrate(client, await readMigrations(fixture('records-itself'))),
      ).rejects.toThrow(
        '0002_records_itself.sql failed and was rolled back: duplicate key value violates unique constraint',
      );
      expect(await recorded(client)).toEqual([{ version: 1, name: 'create_notes' }]);
      const tags = await client.query(`SELECT to_regclass('public.tags') AS t`);
      expect(tags.rows).toEqual([{ t: null }]);
    } finally {
      await client.end();
    }
  });

  it('settings reach the SQL for the length of its transaction and are gone afterwards', async () => {
    const client = await emptyDatabase('mgsetting');
    try {
      await migrate(client, await readMigrations(fixture('reads-setting')), {
        settings: { 'rff.fixture_value': 'only inside' },
      });
      const seen = await client.query('SELECT value FROM seen');
      expect(seen.rows).toEqual([{ value: 'only inside' }]);
      const after = await client.query<{ value: string | null }>(
        `SELECT pg_catalog.current_setting('rff.fixture_value', true) AS value`,
      );
      // Postgres keeps an empty placeholder once a transaction has set the name.
      expect(after.rows[0]?.value ?? '').toBe('');
    } finally {
      await client.end();
    }
  });

  it('a file edited after it was applied stops the run before anything else is applied', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rff-migrations-'));
    temporary.push(dir);
    await cp(fixture('two-files'), dir, { recursive: true });
    await rm(join(dir, '0002_add_tags.sql'));
    const client = await emptyDatabase('mgedit');
    try {
      await migrate(client, await readMigrations(dir));
      await writeFile(join(dir, '0001_create_notes.sql'), 'CREATE TABLE notes (id integer);\n');
      await cp(join(fixture('two-files'), '0002_add_tags.sql'), join(dir, '0002_add_tags.sql'));
      await expect(migrate(client, await readMigrations(dir))).rejects.toThrow(
        '0001_create_notes.sql changed after it was applied as 0001_create_notes',
      );
      expect(await recorded(client)).toEqual([{ version: 1, name: 'create_notes' }]);
    } finally {
      await client.end();
    }
  });

  it('a database with a migration that this release does not have stops the run', async () => {
    const client = await emptyDatabase('mgnewer');
    try {
      const both = await readMigrations(fixture('two-files'));
      await migrate(client, both);
      await expect(migrate(client, both.slice(0, 1))).rejects.toThrow(
        'the database has migration 0002_add_tags, which is not in this release',
      );
    } finally {
      await client.end();
    }
  });

  it('a recorded row out of its place stops the run', async () => {
    const client = await emptyDatabase('mgplace');
    try {
      const migrations = await readMigrations(fixture('two-files'));
      await migrate(client, migrations);
      await client.query('DELETE FROM schema_migrations WHERE version = 1');
      await expect(migrate(client, migrations)).rejects.toThrow(
        'schema_migrations has 0002_add_tags where 0001 belongs',
      );
    } finally {
      await client.end();
    }
  });

  it('three runners on one database at once apply each file exactly once', async () => {
    const scratch = await createScratchDatabase('mgrace');
    const clients = await Promise.all(
      [1, 2, 3].map(() => connectClient(scratch.adminUrl, 'rff-test-migrations')),
    );
    try {
      const migrations = await readMigrations(fixture('two-files'));
      const results = await Promise.all(clients.map((client) => migrate(client, migrations)));
      expect(results.map((r) => r.applied.length).toSorted()).toEqual([0, 0, 2]);
      expect(await recorded(clients[0] as pg.Client)).toHaveLength(2);
    } finally {
      await Promise.all(clients.map((client) => client.end()));
    }
  });

  it('file names are NNNN_name.sql, numbered from 0001 with no gaps or duplicates', async () => {
    await expect(readMigrations(fixture('gap'))).rejects.toThrow(
      'expected migration 0002 but found 0003_add_tags.sql',
    );
    await expect(readMigrations(fixture('duplicate'))).rejects.toThrow(
      'expected migration 0002 but found 0001_create_notes.sql',
    );
    await expect(readMigrations(fixture('bad-name'))).rejects.toThrow(
      '0001-create-notes.sql: migration files are named NNNN_name.sql',
    );
  });

  it('dot files such as .DS_Store are not migrations', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rff-migrations-'));
    temporary.push(dir);
    await cp(fixture('two-files'), dir, { recursive: true });
    await writeFile(join(dir, '.DS_Store'), 'not SQL');
    expect((await readMigrations(dir)).map((m) => m.file)).toEqual([
      '0001_create_notes.sql',
      '0002_add_tags.sql',
    ]);
  });

  it('the shipped migrations directory holds only well-named, numbered SQL files', async () => {
    const files = (await readdir(MIGRATIONS_DIR)).filter((file) => !file.startsWith('.'));
    const migrations = await readMigrations(MIGRATIONS_DIR);
    expect(migrations.map((m) => m.file)).toEqual(files.toSorted());
    expect(migrations[0]?.file).toBe('0001_roles.sql');
  });
});
