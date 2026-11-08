import { test as base } from '@playwright/test';

export * from '@playwright/test';

/**
 * Playwright's `test`, for every spec here: it closes, once the test is over, any browser
 * context the test opened itself (`browser.newContext()`, a second person on a share link).
 *
 * Playwright closes only the context it made for `page`; one a test opens stays open in the
 * worker's browser for the rest of the run. Left in Split or 3D view, its 3D view keeps
 * drawing every frame in software GL (SwiftShader), so each one left behind takes CPU from
 * every test after it, in this worker and the other: on CI that starved the exact render's
 * first sample past a minute, a view link's first paint past 10 s and a click past 60 s.
 */
export const test = base.extend<{ closeOpenedContexts: undefined }>({
  closeOpenedContexts: [
    async ({ browser }, use) => {
      const before = new Set(browser.contexts());
      await use(undefined);
      const opened = browser.contexts().filter((c) => !before.has(c));
      await Promise.all(opened.map((c) => c.close()));
    },
    { auto: true },
  ],
});
