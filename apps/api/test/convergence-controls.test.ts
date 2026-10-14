import { describe, expect, it } from 'vitest';
import { failureOf, SIMULATION_LABEL, SPLIT_DELAY_MS } from './support/simulation.js';

// The convergence property of convergence.test.ts against broken configurations and
// apps. Each control passes only when the property fails, for the reason named.

describe('convergence on two instances, controls', () => {
  it(
    `control: with the safety poll off, every notification lost and no read when a stream opens, the clients do not converge ${SIMULATION_LABEL}`,
    { timeout: 300_000 },
    async () => {
      const message = await failureOf('convnone', {
        poll: false,
        notifications: 'dropped',
        replay: false,
      });
      expect(message).toMatch(/^did not converge within 5000 ms/);
    },
  );

  it(
    `control: with the safety poll off and no read when a stream opens, a client that missed changes while it was disconnected does not converge, although notifications are delivered ${SIMULATION_LABEL}`,
    { timeout: 300_000 },
    async () => {
      const message = await failureOf('convnoreplay', {
        poll: false,
        notifications: 'delivered',
        replay: false,
      });
      expect(message).toMatch(/^did not converge within 5000 ms/);
    },
  );

  it(
    `control: with every notification lost and the safety poll off, clients that stay connected do not converge, although streams that open are read for ${SIMULATION_LABEL}`,
    { timeout: 300_000 },
    async () => {
      const message = await failureOf('convnopolldropped', {
        poll: false,
        notifications: 'dropped',
        replay: true,
      });
      expect(message).toMatch(/^did not converge within 5000 ms/);
    },
  );

  it(
    `control: a read that takes the version and the flags ${SPLIT_DELAY_MS} ms apart fails the check that each applied snapshot holds the flags of its version ${SIMULATION_LABEL}`,
    { timeout: 300_000 },
    async () => {
      const message = await failureOf('convsplit', {
        poll: true,
        notifications: 'faulty',
        replay: true,
        splitRead: true,
      });
      expect(message).toMatch(
        /applied a snapshot of version \d+ whose flags are not the flags of that version$/,
      );
    },
  );
});
