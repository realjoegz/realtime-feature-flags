import { describe, expect, it } from 'vitest';
import { deliveriesBetween, otherDeliveries, totalDeliveries } from '../src/deliveries.ts';

const ACME = 'ac3e0000-0000-4000-8000-000000000001';
const GLOBEX = '610be000-0000-4000-8000-000000000002';

// Lines as the replicas write them, coloured and not.
const ESC = '\u001b';
const coloured = (message: string) =>
  `${ESC}[32m[Nest] 7  - ${ESC}[39m10/14/2026, 4:22:34 PM ${ESC}[32m    LOG${ESC}[39m ${ESC}[38;5;3m[Stream] ${ESC}[39m${ESC}[32m${message}${ESC}[39m`;
const plain = (message: string) => `[Nest] 7  - 10/14/2026, 4:22:35 PM     LOG [Stream] ${message}`;

describe('replica logs', () => {
  it("counts one tenant's snapshots logged after a connect, ready or poll wake-up", () => {
    const log = [
      plain(`sent version 3 of tenant ${ACME} to 25 streams after a connect wake-up`),
      coloured(`sent version 3 of tenant ${ACME} to 1 stream after a connect wake-up`),
      coloured(`sent version 9 of tenant ${ACME} to 2 streams after a poll wake-up`),
      plain(`sent version 10 of tenant ${ACME} to 1 stream after a ready wake-up`),
      plain(`sent version 4 of tenant ${GLOBEX} to 7 streams after a poll wake-up`),
      plain(`sent version 11 of tenant ${ACME} to 4 streams after a notification wake-up`),
      plain(`reading tenant ${ACME} for its streams failed: timeout`),
      '[Nest] 1  - 10/14/2026, 6:02:00 PM     LOG [Main] api-1 listening on 0.0.0.0:4000',
    ].join('\n');
    const counted = otherDeliveries(log, ACME);
    expect(counted).toEqual({ connect: 26, ready: 1, poll: 2 });
    expect(totalDeliveries(counted)).toBe(29);
    expect(otherDeliveries('', ACME)).toEqual({ connect: 0, ready: 0, poll: 0 });
    expect(deliveriesBetween({ connect: 26, ready: 0, poll: 0 }, counted)).toEqual({
      connect: 0,
      ready: 1,
      poll: 2,
    });
  });
});
