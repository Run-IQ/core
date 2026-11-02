import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The timeout only catches a hang: the exhaustive tests prove their bounds with counted
    // assertions, never with time, so a slow runner must not fail them.
    testTimeout: 60_000,
    // The type tests (tests/*.test-d.ts) and the test files are checked by `npm run typecheck`
    // (tsc on tsconfig.test.json), not by Vitest's experimental typecheck runner.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
    },
  },
});
