import { defineConfig } from 'vitest/config';

/** The tests in Node; `vitest.workers.config.ts` runs them again in workerd. */
export default defineConfig({
  test: { globalSetup: ['src/fixtures/runtimes.setup.ts'] },
});
