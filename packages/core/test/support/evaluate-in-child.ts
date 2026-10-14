// Runs in a separate Node process (Node strips the TypeScript types). Reads
// [flag, context] pairs as JSON from stdin, imports the module named on the
// command line, evaluates each pair with its `evaluate` export and prints the
// results as JSON.

import { pathToFileURL } from 'node:url';

const modulePath = process.argv[2];
if (modulePath === undefined) {
  throw new Error('usage: node evaluate-in-child.ts <module path>');
}

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
const cases = JSON.parse(Buffer.concat(chunks).toString('utf8')) as [unknown, unknown][];

const subject = (await import(pathToFileURL(modulePath).href)) as {
  evaluate: (flag: unknown, context: unknown) => unknown;
};
process.stdout.write(
  JSON.stringify(cases.map(([flag, context]) => subject.evaluate(flag, context))),
);
