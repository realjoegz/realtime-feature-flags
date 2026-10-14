import { escapeGlob, type Redis } from './redis.js';

// The keys a test run leaves in Redis. Each test environment's apps write under
// <run prefix>:<environment>:, and the only keys an app writes are cache entries,
// <prefix>:flags:<tenant>:v<version>, each holding the snapshot of that tenant at that
// version. The harness's own tests write probe keys under <run prefix>:harness:.
// Controls whose cache writes other keys on purpose delete them before they end.

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Every key under runPrefix, outside <runPrefix>:harness:, that is not
 * <runPrefix>:<environment>:flags:<tenant>:v<version> or whose entry names another
 * tenant or version, each with what is wrong with it. A key that is gone by the time
 * it is read is skipped.
 */
export async function runKeyProblems(redis: Redis, runPrefix: string): Promise<string[]> {
  const pattern = new RegExp(
    `^${escapeRegExp(runPrefix)}:[A-Za-z0-9_-]+:flags:(${UUID}):v(0|[1-9][0-9]*)$`,
  );
  const probes = `${runPrefix}:harness:`;
  const problems: string[] = [];
  for await (const batch of redis.scanIterator({
    MATCH: `${escapeGlob(runPrefix)}:*`,
    COUNT: 500,
  })) {
    for (const key of batch) {
      if (key.startsWith(probes)) continue;
      const match = pattern.exec(key);
      if (match === null) {
        problems.push(`${key} is not <run>:<environment>:flags:<tenant>:v<version>`);
        continue;
      }
      // eslint-disable-next-line no-await-in-loop -- one key after another
      const text = await redis.get(key);
      if (text === null) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(text);
      } catch {
        entry = null;
      }
      const { tenantId, version, flags } = (entry ?? {}) as Record<string, unknown>;
      if (tenantId !== match[1] || version !== Number(match[2]) || !Array.isArray(flags)) {
        problems.push(`${key} does not hold a snapshot of that tenant and version`);
      }
    }
  }
  return problems.toSorted();
}

/** A run left keys that runKeyProblems reports. */
export class RunKeysError extends Error {
  constructor(
    runPrefix: string,
    readonly problems: readonly string[],
  ) {
    super(
      `At the end of the run, ${problems.length} Redis keys under ${runPrefix} are not tenant-scoped cache entries:\n  ${problems.join('\n  ')}`,
    );
    this.name = 'RunKeysError';
  }
}
