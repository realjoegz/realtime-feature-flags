# Documents

| Document | What it is |
|---|---|
| [design.md](design.md) | The design: what the service promises, the stack, evaluation and rollout, tenancy under row-level security, tokens and roles, writes and versions, the stream and its fan-out through Redis, the SDK, the dashboard's sign-in, personal data, the local stack, the alternatives that were rejected and the limits |
| [evidence.md](evidence.md) | All 58 claims with the tests that prove them, how each section's tests force their cases, the committed broken code they must catch, and the latency method, where its results are and how far to trust them. The build checks every test it names |

Where to start:

- To judge the design, read sections 1, 4, 8 and 14 of [design.md](design.md): the promises, tenancy, notifications and the cache, and the limits.
- To check a claim, find its row in [evidence.md](evidence.md) and run the test it links, for example `npx vitest run apps/api/test/convergence.test.ts` after `npm run build`, with Postgres and Redis started as in the README.
- To check a latency number, open the results file that its README row links: it holds every change's raw times and the conditions of the run, and `npm run latency:render` writes the README table from the results files again.
