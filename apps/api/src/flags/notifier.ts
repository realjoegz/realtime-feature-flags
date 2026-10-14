// Called after a flag write has committed, with the tenant's new version. The
// in-process notifier (src/stream/in-process-notifier.ts) implements it. A client
// that misses a notification gets the change on its next connection, whose first
// read compares the tenant's version with the client's.

export interface FlagsChange {
  readonly tenantId: string;
  readonly version: number;
}

export interface FlagsNotifier {
  flagsChanged(change: FlagsChange): Promise<void>;
}

export const FLAGS_NOTIFIER = Symbol('FLAGS_NOTIFIER');
