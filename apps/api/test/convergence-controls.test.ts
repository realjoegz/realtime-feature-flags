import { describe, expect, it } from 'vitest';
import { failureOf, SIMULATION_LABEL, SPLIT_DELAY_MS } from './support/simulation.js';

// The convergence property of convergence.test.ts against broken configurations and
// apps. Each control passes only when the property fails, for the reason named.

describe('convergence', () => {
  it(
    `control: with no poll, no notifications and no read on connect, clients do not converge ${SIMULATION_LABEL}`,
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
    `control: with no poll and no read on connect, a client does not converge ${SIMULATION_LABEL}`,
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
    `control: with no notifications and no poll, clients do not converge ${SIMULATION_LABEL}`,
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
    `control: reading version and flags ${SPLIT_DELAY_MS} ms apart fails the check that each applied snapshot matches its version ${SIMULATION_LABEL}`,
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
