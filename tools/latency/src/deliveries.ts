import { stripVTControlCharacters } from 'node:util';
import { OTHER_CAUSES, type OtherDeliveries } from './results.ts';

// A replica logs every snapshot it sends after a wake-up other than a Redis
// notification (apps/api/src/stream/stream-hub.ts), as
//
//   [Stream] sent version 7 of tenant <id> to 2 streams after a poll wake-up
//
// The tool reads the replicas' logs with docker compose logs before and after each
// phase, and the difference of the counts below is what the phase delivered that
// way: on a connection, after the change bus reconnected, or from the safety poll.
// Nest colours its log lines, so escape codes are removed first.

const SENT =
  /\[Stream\] sent version \d+ of tenant ([0-9a-f-]{36}) to (\d+) streams? after a ([a-z]+) wake-up/;

/** The snapshots sent to streams of tenantId after each kind of wake-up, in the log text. */
export function otherDeliveries(log: string, tenantId: string): OtherDeliveries {
  const counts = { connect: 0, ready: 0, poll: 0 };
  for (const line of stripVTControlCharacters(log).split('\n')) {
    const match = SENT.exec(line);
    if (match === null || match[1] !== tenantId) continue;
    const cause = match[3] as string;
    if ((OTHER_CAUSES as readonly string[]).includes(cause)) {
      counts[cause as keyof OtherDeliveries] += Number(match[2]);
    }
  }
  return counts;
}

/** What happened between two readings of the same logs. */
export function deliveriesBetween(
  before: OtherDeliveries,
  after: OtherDeliveries,
): OtherDeliveries {
  return {
    connect: after.connect - before.connect,
    ready: after.ready - before.ready,
    poll: after.poll - before.poll,
  };
}

export function totalDeliveries(deliveries: OtherDeliveries): number {
  return OTHER_CAUSES.reduce((sum, cause) => sum + deliveries[cause], 0);
}
