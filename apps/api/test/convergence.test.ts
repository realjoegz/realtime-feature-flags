import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CLIENTS,
  type Configuration,
  convergence,
  newTally,
  PARAMS,
  SIMULATION,
  SIMULATION_LABEL,
  startSimulation,
  type Tally,
} from './support/simulation.js';

// Convergence on two instances, in the three configurations: the safety poll off,
// so that notifications and the read when a stream opens heal; every notification
// lost, so that the poll heals; and both on, with lost notifications, failing
// publishes and subscriber resets among the steps. The simulation itself is in
// support/simulation.ts, and its controls are in convergence-controls.test.ts.

/** Runs the property for a configuration and returns what its runs did. */
async function simulate(label: string, configuration: Configuration): Promise<Tally> {
  const sim = await startSimulation(label, configuration);
  try {
    const tally = newTally();
    await fc.assert(convergence(sim, tally), PARAMS);
    return tally;
  } finally {
    await sim.close();
  }
}

/** Each named count in the tally is at least a quarter of the runs. */
function expectFloors(tally: Tally, names: readonly (keyof Omit<Tally, 'delivered'>)[]): void {
  const floor = Math.ceil(SIMULATION.numRuns / 4);
  expect(tally.runs).toBe(SIMULATION.numRuns);
  for (const name of names) {
    expect(tally[name], `${name} in ${JSON.stringify(tally)}`).toBeGreaterThanOrEqual(floor);
  }
  // Every move ended with a connection answered by the other app.
  expect(tally.switched, JSON.stringify(tally)).toBe(tally.moves);
}

const COMMON = [
  'saves',
  'concurrentSaves',
  'conflicts',
  'cuts',
  'stalls',
  'reconnects',
  'moves',
  'readTimeouts',
  'reopened',
] as const;

// The titles are short; docs/evidence.md states in full what each run checks.
const CLAIM = "end on the database's flags and version and apply strictly increasing versions";

describe('convergence on two instances', () => {
  it(
    `safety poll off: ${CLIENTS} SDK clients moving between two apps ${CLAIM} ${SIMULATION_LABEL}`,
    { timeout: 300_000 },
    async () => {
      const tally = await simulate('convnopoll', {
        poll: false,
        notifications: 'delivered',
        replay: true,
      });
      expectFloors(tally, [...COMMON, 'subscriberResets']);
      const floor = Math.ceil(SIMULATION.numRuns / 4);
      expect(tally.delivered.poll).toBe(0);
      expect(tally.delivered.notification).toBeGreaterThanOrEqual(floor);
      expect(tally.delivered.connect).toBeGreaterThanOrEqual(floor);
      expect(tally.delivered.ready).toBeGreaterThanOrEqual(1);
    },
  );

  it(
    `every notification lost: ${CLIENTS} SDK clients moving between two apps ${CLAIM} ${SIMULATION_LABEL}`,
    { timeout: 300_000 },
    async () => {
      const tally = await simulate('convdropped', {
        poll: true,
        notifications: 'dropped',
        replay: true,
      });
      expectFloors(tally, COMMON);
      const floor = Math.ceil(SIMULATION.numRuns / 4);
      expect(tally.delivered.notification).toBe(0);
      expect(tally.delivered.ready).toBe(0);
      // The rounds of saves with every client connected reach them only by the poll.
      expect(tally.delivered.poll).toBeGreaterThanOrEqual(3 * CLIENTS * SIMULATION.numRuns);
      expect(tally.delivered.connect).toBeGreaterThanOrEqual(floor);
    },
  );

  it(
    `poll and notifications on, with lost notifications, failing publishes and subscriber resets: ${CLIENTS} SDK clients moving between two apps ${CLAIM} ${SIMULATION_LABEL}`,
    { timeout: 300_000 },
    async () => {
      const tally = await simulate('convfaulty', {
        poll: true,
        notifications: 'faulty',
        replay: true,
      });
      expectFloors(tally, [...COMMON, 'lostNotifications', 'failedPublishes', 'subscriberResets']);
      const floor = Math.ceil(SIMULATION.numRuns / 4);
      expect(tally.delivered.notification).toBeGreaterThanOrEqual(floor);
      expect(tally.delivered.poll).toBeGreaterThanOrEqual(1);
      expect(tally.delivered.connect).toBeGreaterThanOrEqual(floor);
    },
  );
});
