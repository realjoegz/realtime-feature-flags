// Called after a flag write has committed, with the tenant's new version. The
// change bus (src/stream/change-bus.ts) implements it with Redis pub/sub. A stream
// whose instance misses a notification gets the change from the safety poll, or on
// its next connection, whose first read compares the tenant's version with the
// client's.

export interface FlagsChange {
  readonly tenantId: string;
  readonly version: number;
}

export interface FlagsNotifier {
  flagsChanged(change: FlagsChange): Promise<void>;
}

export const FLAGS_NOTIFIER = Symbol('FLAGS_NOTIFIER');
