import { describe, expect, it } from 'vitest';
import { Arrivals } from '../src/arrivals.ts';

describe('arrivals', () => {
  it('the time to the last client ends at the latest first arrival', () => {
    const arrivals = new Arrivals(3);
    for (const client of [0, 1, 2]) arrivals.record(client, 4, 1);
    arrivals.clear();
    // Saved at 10 as version 5. Client 2 skips it and gets 6.
    arrivals.record(0, 5, 12);
    arrivals.record(1, 5, 15);
    arrivals.record(0, 6, 16);
    arrivals.record(2, 6, 20);
    expect(arrivals.firstArrivals(5)).toEqual([12, 15, 20]);
    expect(arrivals.timeToLastClient(5, 10)).toBe(10);
    expect(() => arrivals.firstArrivals(6)).toThrow('client 1 has no arrival at 6 or later');
  });

  it('waits for every client, and at the deadline names those behind', async () => {
    const arrivals = new Arrivals(3);
    arrivals.record(0, 2, 0);
    const reached = arrivals.whenAllAt(2, 1000);
    arrivals.record(1, 3, 1);
    expect(arrivals.allAt(2)).toBe(false);
    arrivals.record(2, 2, 2);
    await expect(reached).resolves.toBeUndefined();
    await expect(arrivals.whenAllAt(2, 0)).resolves.toBeUndefined();
    await expect(arrivals.whenAllAt(3, 20)).rejects.toThrow(
      '2 clients did not reach version 3 within 20 ms: 0 (at 2), 2 (at 2)',
    );
  });
});
