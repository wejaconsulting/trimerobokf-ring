import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Two projects so `unit` stays fast and hermetic while `integration`
    // exercises the real Postgres dialect through PGlite.
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/src/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['packages/*/test/**/*.itest.ts', 'apps/api/test/**/*.itest.ts'],
          environment: 'node',
          hookTimeout: 120_000,
          testTimeout: 120_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
