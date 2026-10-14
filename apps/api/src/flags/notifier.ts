import { Injectable } from '@nestjs/common';

// Called after a flag write has committed, with the tenant's new version. The
// in-process notifier and the Redis notifier of later steps implement it.
// Correctness does not depend on it: a missed notification is repaired by a later
// read of the version.

export interface FlagsChange {
  readonly tenantId: string;
  readonly version: number;
}

export interface FlagsNotifier {
  flagsChanged(change: FlagsChange): Promise<void>;
}

export const FLAGS_NOTIFIER = Symbol('FLAGS_NOTIFIER');

/** Notifies nobody. Nothing listens for changes yet. */
@Injectable()
export class NoopNotifier implements FlagsNotifier {
  async flagsChanged(): Promise<void> {}
}
