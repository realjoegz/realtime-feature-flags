// Renders the latency section of README.md from bench/results/*.json.
//
//   node tools/latency/dist/render-main.js --write   # npm run latency:render
//   node tools/latency/dist/render-main.js --check   # npm run check:latency, in npm run verify
//
// --check fails when the README's section is not exactly the rendering, when a
// results file is invalid, or when bench/results holds another file. --root DIR
// reads DIR/README.md and DIR/bench/results instead of the repository's.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  latencyMismatch,
  readRuns,
  renderLatency,
  RESULTS_DIRECTORY,
  withLatencyBlock,
} from './readme-table.ts';

const REPOSITORY = fileURLToPath(new URL('../../..', import.meta.url));
const USAGE = 'usage: render-main.js --check | --write [--root DIR]';

function main(args: readonly string[]): number {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...args],
      strict: true,
      options: {
        check: { type: 'boolean', default: false },
        write: { type: 'boolean', default: false },
        root: { type: 'string' },
      },
    }));
  } catch (error) {
    console.error(`${(error as Error).message}. ${USAGE}`);
    return 2;
  }
  if (values.check === values.write) {
    console.error(USAGE);
    return 2;
  }
  const root = path.resolve(values.root ?? REPOSITORY);
  const readmePath = path.join(root, 'README.md');
  const runs = readRuns(path.join(root, RESULTS_DIRECTORY));
  const readme = readFileSync(readmePath, 'utf8');
  if (values.write) {
    writeFileSync(readmePath, withLatencyBlock(readme, renderLatency(runs)));
    console.log(`render-latency: README.md holds the rendering of ${runs.length} results files`);
    return 0;
  }
  const mismatch = latencyMismatch(readme, runs);
  if (mismatch !== null) {
    console.error(`check-latency: ${mismatch}. Run npm run latency:render.`);
    return 1;
  }
  console.log(`check-latency: README.md holds the rendering of ${runs.length} results files`);
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(`check-latency: ${(error as Error).message}`);
  process.exitCode = 1;
}
