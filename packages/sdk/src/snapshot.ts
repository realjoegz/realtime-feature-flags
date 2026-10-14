import { type Flag, validateFlag } from '@rff/core';

/** All flags of a tenant at one version, as the stream sends them. */
export interface FlagsSnapshot {
  readonly tenantId: string;
  readonly version: number;
  /** Ordered by key, as the server sends them. */
  readonly flags: readonly Flag[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The snapshot in the data of a snapshot event. Every flag goes through
 * validateFlag from @rff/core, and keys must be unique, so evaluate() only ever sees
 * flags that the server would accept. Throws SnapshotError otherwise.
 */
export function parseSnapshot(data: string): FlagsSnapshot {
  let input: unknown;
  try {
    input = JSON.parse(data);
  } catch {
    throw new SnapshotError('the snapshot is not JSON');
  }
  if (!isRecord(input)) throw new SnapshotError('the snapshot is not an object');
  const { tenantId, version, flags } = input;
  if (typeof tenantId !== 'string' || tenantId === '') {
    throw new SnapshotError('the snapshot has no tenantId');
  }
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) {
    throw new SnapshotError('the snapshot version is not a non-negative integer');
  }
  if (!Array.isArray(flags)) throw new SnapshotError('the snapshot has no flags array');
  const valid: Flag[] = [];
  const keys = new Set<string>();
  for (const [index, candidate] of flags.entries()) {
    const result = validateFlag(candidate);
    if (!result.ok) {
      throw new SnapshotError(`flag ${index} is invalid: ${result.errors.join('; ')}`);
    }
    if (keys.has(result.value.key)) {
      throw new SnapshotError(`flag key ${result.value.key} appears twice`);
    }
    keys.add(result.value.key);
    valid.push(result.value);
  }
  return { tenantId, version, flags: valid };
}
