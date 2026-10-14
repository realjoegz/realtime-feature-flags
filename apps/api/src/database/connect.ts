import pg from 'pg';

/**
 * One connected pg.Client, for work that needs a single session (migrations, tests).
 * A failed connect rejects and leaves nothing open, so callers can retry it.
 */
export async function connectClient(
  url: string,
  applicationName: string,
  onError: (error: Error) => void = () => {},
): Promise<pg.Client> {
  const client = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: 5000,
    application_name: applicationName,
  });
  // A connection that drops while idle emits 'error'; without a listener the
  // process would exit with an uncaught exception.
  client.on('error', onError);
  try {
    await client.connect();
  } catch (error) {
    await client.end().catch(() => {});
    throw error;
  }
  return client;
}
