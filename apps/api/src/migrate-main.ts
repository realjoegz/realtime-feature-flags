// The one-shot migrate service: applies apps/api/migrations as the database superuser
// and exits 0, or exits 1 with the reason. Running it again applies nothing new.
import { describeDatabaseUrl, loadMigrateConfig } from './config.js';
import { connectClient } from './database/connect.js';
import { withConnectRetry } from './database/retry.js';
import { MIGRATIONS_DIR, migrate, readMigrations } from './migrator.js';

const log = (message: string): void => console.log(`migrate: ${message}`);

try {
  const config = loadMigrateConfig(process.env);
  const migrations = await readMigrations(MIGRATIONS_DIR);
  const client = await withConnectRetry(
    () =>
      connectClient(config.url, 'rff-migrate', (error) => log(`connection lost: ${error.message}`)),
    {
      deadlineMs: config.connectDeadlineMs,
      onRetry: (attempt, _error, delayMs) =>
        log(`connect attempt ${attempt} failed, retrying in ${delayMs} ms`),
    },
  );
  try {
    log(`connected as ${describeDatabaseUrl(config.url)}, ${migrations.length} migrations`);
    await migrate(client, migrations, {
      settings: { 'rff.app_password': config.appPassword },
      log,
    });
  } finally {
    await client.end();
  }
} catch (error) {
  console.error(`migrate: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
