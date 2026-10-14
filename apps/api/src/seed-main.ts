// The one-shot seed service of the compose stack: writes the demo tenants, users,
// memberships, flags and SDK keys (seed/demo-data.ts) as the database superuser and
// exits 0, or exits 1 with the reason. Running it again changes nothing that exists.
import { describeDatabaseUrl, loadSeedConfig } from './config.js';
import { connectClient } from './database/connect.js';
import { withConnectRetry } from './database/retry.js';
import { seedDemo } from './seed/seed.js';

const log = (message: string): void => console.log(`seed: ${message}`);

try {
  const config = loadSeedConfig(process.env);
  const client = await withConnectRetry(
    () =>
      connectClient(config.url, 'rff-seed', (error) => log(`connection lost: ${error.message}`)),
    {
      deadlineMs: config.connectDeadlineMs,
      onRetry: (attempt, _error, delayMs) =>
        log(`connect attempt ${attempt} failed, retrying in ${delayMs} ms`),
    },
  );
  try {
    log(`connected as ${describeDatabaseUrl(config.url)}, issuer ${config.issuer}`);
    await seedDemo(client, { issuer: config.issuer, log });
  } finally {
    await client.end();
  }
} catch (error) {
  console.error(`seed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
