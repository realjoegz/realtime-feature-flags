import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC compiles this project, with the decorator settings it reads from tsconfig.json.
// Vite 8's own transform (oxc) reads the same two settings and emits the metadata
// too. test/di.test.ts fails when emitDecoratorMetadata is off, whichever one runs.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    name: 'api',
    include: ['test/**/*.test.ts'],
    // Decorators record parameter types through reflect-metadata, so it loads first.
    setupFiles: ['reflect-metadata'],
    // A new database from the migrations and a new Redis prefix for each run.
    globalSetup: ['test/harness/global-setup.ts'],
    retry: 0,
    // Vitest 5 caches transformed files on disk by default, and its cache key does
    // not include tsconfig.json, which SWC reads for the decorator settings. A stale
    // entry could keep the metadata after the settings changed, so this project
    // transforms every file on each run.
    fsModuleCache: false,
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
