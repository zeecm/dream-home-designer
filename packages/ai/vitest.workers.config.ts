import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

/**
 * The same tests in workerd, the runtime of a Worker or Durable Object: the code the browser
 * runs must run there unchanged (cloud runs, tech §2).
 */
export default defineWorkersConfig({
  test: {
    globalSetup: ['src/fixtures/runtimes.setup.ts'],
    poolOptions: {
      workers: {
        miniflare: {
          compatibilityDate: '2025-09-01',
          // (For vitest's own runner; the code under test uses none of it.)
          compatibilityFlags: ['nodejs_compat'],
        },
      },
    },
  },
});
