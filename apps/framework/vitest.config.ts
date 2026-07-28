import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Booting platform-lite and shelling out to vite/vitest is slow.
    testTimeout: 120000,
    hookTimeout: 120000,
    include: [
      'harness/**/*.test.ts',
      // Scorer tests only. Deliberately not `evals/**/*.test.ts`: several evals
      // ship withheld tests under `evals/<id>/tests/` that exist to score an
      // agent's workspace, and must never run as part of this suite.
      '../../evals/*/EVAL.test.ts',
    ],
    // Scorers make expected-fail supabase-js calls that log through
    // console.error. Vitest reports failures through its own reporter, so
    // dropping this noise cannot hide a failing test.
    onConsoleLog: (_log, type) =>
      type === 'stderr' && !process.env.DEBUG_TESTS ? false : undefined,
  },
});
