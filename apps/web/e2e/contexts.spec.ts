import { type BrowserContext, expect, test } from './test';

// A browser context a test opens itself is closed when the test ends, so no page is left
// drawing its 3D view in the worker's browser for the rest of the run (see `./test`).
test.describe.configure({ mode: 'serial' });

let opened: BrowserContext | undefined;

test('a test opens a second context, on the sample in Split view, and leaves it', async ({
  browser,
}) => {
  opened = await browser.newContext();
  const page = await opened.newPage();
  await page.goto('/');
  await expect(page.getByTestId('viewport')).toBeVisible();
});

test('the next test in the worker finds it closed', async ({ browser }) => {
  expect(opened).toBeDefined();
  expect(browser.contexts()).not.toContain(opened);
  expect(browser.contexts()).toHaveLength(0);
});
