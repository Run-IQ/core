import { defineConfig } from 'vitest/config';

/** The heavy tests: the scale limits of D-26 (100 000 rules, 500 000 leaves), read on a clock. */
const HEAVY = 'tests/heavy/**/*.test.ts';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // The type tests (tests/*.test-d.ts) and the test files are checked by `npm run typecheck`
    // (tsc on tsconfig.test.json), not by Vitest's experimental typecheck runner.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
    },
    projects: [
      {
        extends: true,
        // `npm test`: every test but the heavy ones, files in parallel.
        // The timeout only catches a hang: the exhaustive tests prove their bounds with counted
        // assertions, never with time, so a slow runner must not fail them.
        test: {
          name: 'fast',
          include: ['tests/**/*.test.ts'],
          exclude: [HEAVY],
          testTimeout: 60_000,
        },
      },
      {
        extends: true,
        // `npm run test:heavy`: one file at a time (the script also passes one worker), so that
        // no two of them hold their memory at once; its tests read a clock against a written budget.
        test: {
          name: 'heavy',
          include: [HEAVY],
          fileParallelism: false,
          testTimeout: 180_000,
        },
      },
    ],
  },
});
