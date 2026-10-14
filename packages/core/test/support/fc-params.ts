// Every property runs with a fixed seed and an explicit number of runs, so CI runs
// the same cases each time. RFF_FC_SEED and RFF_FC_RUNS override both for local
// exploration; the test names then show the values that ran.

export const DEFAULT_SEED = 20261014;

export interface RunParams {
  readonly seed: number;
  readonly numRuns: number;
}

function integerFromEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

export function runParams(defaultRuns: number): RunParams {
  return {
    seed: integerFromEnv('RFF_FC_SEED') ?? DEFAULT_SEED,
    numRuns: integerFromEnv('RFF_FC_RUNS') ?? defaultRuns,
  };
}

/** The suffix in a test name, for example "(seed 20261014, 500 runs)". */
export function label(params: RunParams, unit = 'runs'): string {
  return `(seed ${params.seed}, ${params.numRuns} ${unit})`;
}
