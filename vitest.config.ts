import { defineConfig } from 'vitest/config';

// One root config with a project per package. No test is retried: a test that
// passes only on a second try is a failure. The JSON report is the input of
// scripts/check-claims.mjs. The api project has its own config file, because it
// compiles with SWC and needs Postgres and Redis (apps/api/vitest.config.ts).
export default defineConfig({
  test: {
    retry: 0,
    reporters: [
      'default',
      ...(process.env.GITHUB_ACTIONS === 'true' ? ['github-actions' as const] : []),
      ['json', { outputFile: '.vitest/report.json' }],
    ],
    projects: [
      { test: { name: 'core', include: ['packages/core/test/**/*.test.ts'] } },
      { test: { name: 'sdk', include: ['packages/sdk/test/**/*.test.ts'] } },
      { test: { name: 'latency', include: ['tools/latency/test/**/*.test.ts'] } },
      { test: { name: 'scripts', include: ['scripts/test/*.test.mjs'] } },
      { test: { name: 'dashboard', include: ['apps/dashboard/test/**/*.test.ts'] } },
      'apps/api/vitest.config.ts',
    ],
  },
});
