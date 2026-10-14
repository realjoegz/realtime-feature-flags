// A small Vitest project whose JSON report the check-claims tests read. It has a
// passing, a skipped, a todo and a failing test, two tests that share a name, a
// file that fails to load, and a file that the run excludes.
export default {
  test: {
    include: ['tests/*.test.mjs'],
    exclude: ['tests/excluded.test.mjs'],
    retry: 0,
    reporters: [['json', { outputFile: process.env.CLAIMS_FIXTURE_REPORT ?? 'report.json' }]],
  },
};
