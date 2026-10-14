import { createClient } from 'redis';
import { withConnectRetry } from '../../src/database/retry.js';

function newClient(url: string) {
  // No automatic reconnects: a failed connect rejects, and connectRedis retries it.
  const client = createClient({ url, socket: { connectTimeout: 3000, reconnectStrategy: false } });
  client.on('error', () => {});
  return client;
}

export type Redis = ReturnType<typeof newClient>;

/** A connected client. The first connect is retried for a while, as for Postgres. */
export async function connectRedis(url: string, deadlineMs = 15_000): Promise<Redis> {
  return withConnectRetry(
    async () => {
      const client = newClient(url);
      try {
        await client.connect();
      } catch (error) {
        client.destroy();
        throw error;
      }
      return client;
    },
    { deadlineMs },
  );
}

/** Deletes every key that starts with prefix and returns how many there were. */
export async function removeKeysWithPrefix(client: Redis, prefix: string): Promise<number> {
  let removed = 0;
  for await (const keys of client.scanIterator({ MATCH: `${escapeGlob(prefix)}*`, COUNT: 500 })) {
    if (keys.length > 0) removed += await client.unlink(keys);
  }
  return removed;
}

/** prefix with the glob characters of SCAN MATCH escaped, so it matches only itself. */
export function escapeGlob(prefix: string): string {
  return prefix.replace(/[*?[\]\\]/g, '\\$&');
}
