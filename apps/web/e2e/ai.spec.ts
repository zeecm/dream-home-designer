import { expect, test } from '@playwright/test';
import { waitSaved } from './helpers';

const KEY = 'sk-test-not-a-real-key-123';

/** What a model might read from the sample's plan image: two rooms and a door. */
const reading = {
  walls: [
    { a: { x: 100, y: 100 }, b: { x: 700, y: 102 }, thickness: 20 },
    { a: { x: 700, y: 100 }, b: { x: 700, y: 500 }, thickness: 20 },
    { a: { x: 700, y: 500 }, b: { x: 100, y: 500 }, thickness: 20 },
    { a: { x: 100, y: 500 }, b: { x: 100, y: 100 }, thickness: 20 },
    { a: { x: 400, y: 100 }, b: { x: 400, y: 500 }, thickness: 10 },
  ],
  openings: [
    {
      kind: 'door',
      a: { x: 400, y: 250 },
      b: { x: 400, y: 340 },
      hinge: { x: 400, y: 250 },
      arc: { x: 460, y: 290 },
    },
  ],
  rooms: [
    { name: 'Study', at: { x: 250, y: 300 } },
    { name: 'Studio', at: { x: 550, y: 300 } },
  ],
  printedArea: null,
};

/** No request reaches a real provider: anything not mocked in a test is refused. */
test.beforeEach(async ({ page }) => {
  for (const host of [
    'https://api.openai.com/**',
    'https://api.anthropic.com/**',
    'https://generativelanguage.googleapis.com/**',
  ]) {
    await page.route(host, (route) => route.abort('blockedbyclient'));
  }
});

test('trace walls with an AI model: key kept in the browser, a draft to accept, one undo step', async ({
  page,
}) => {
  const toOurApi: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/')) toOurApi.push(`${r.url()} ${r.postData() ?? ''}`);
  });
  let calls = 0;
  await page.route('https://api.openai.com/**', async (route) => {
    // The settings list the key's models first: the plan is read once.
    if (route.request().method() === 'POST') calls++;
    const auth = route.request().headers().authorization;
    if (auth !== `Bearer ${KEY}`) return route.fulfill({ status: 401, body: '{}' });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(reading) } }] }),
    });
  });
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('1');
  // No key yet: the button asks for one.
  await page.getByRole('button', { name: 'Trace walls with AI' }).click();
  const dialog = page.getByRole('dialog', { name: 'AI assistant' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Provider').selectOption('openai');
  await dialog.getByLabel('API key').fill(KEY);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);
  const walls = page.locator('[data-hit^="wall:"]');
  const before = await walls.count();
  // Saving the key starts the trace asked for.
  const bar = page.locator('.trace-bar');
  await expect(bar).toContainText('Found 7 walls, 1 door, 0 windows, 2 rooms');
  await expect(bar).toContainText('Accepting replaces the walls drawn now (faded).');
  await expect(page.locator('.ai-draft-wall').first()).toBeVisible();
  // The plan as it is fades behind the draft.
  await expect(page.locator('.plan-shapes')).toHaveCSS('opacity', '0.3');
  await bar.getByRole('button', { name: 'Accept' }).click();
  await expect(bar).toHaveCount(0);
  await expect(page.locator('.room-list li')).toHaveCount(2);
  await expect(page.locator('.room-list')).toContainText('Study');
  // The partition splits the walls it meets (5 read, 7 drawn). One undo step back.
  await page.keyboard.press('Control+z');
  await expect(walls).toHaveCount(before);
  expect(calls).toBe(1);
  await waitSaved(page);
  // The key went to the provider only: never to our server.
  expect(toOurApi.filter((r) => r.includes(KEY))).toEqual([]);
});

test('a refused key says so and leaves the plan as it was', async ({ page }) => {
  await page.route('https://api.openai.com/**', (route) =>
    route.fulfill({ status: 401, body: '{}' }),
  );
  await page.addInitScript(() => {
    window.sessionStorage.setItem(
      'dhd-ai',
      JSON.stringify({ provider: 'openai', key: 'sk-bad', model: 'gpt-5' }),
    );
  });
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('1');
  const walls = await page.locator('[data-hit^="wall:"]').count();
  await page.getByRole('button', { name: 'Trace walls with AI' }).click();
  const bar = page.locator('.trace-bar-error');
  await expect(bar).toContainText('The key was refused');
  await expect(page.locator('[data-hit^="wall:"]')).toHaveCount(walls);
  // Trying again won't help: the way on is the settings.
  await expect(bar.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  await bar.getByRole('button', { name: 'AI settings' }).click();
  await expect(page.getByRole('dialog', { name: 'AI assistant' })).toBeVisible();
});

/** A 1 × 1 PNG, as an image model might send back (much smaller). */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';

test('a photo-real render of the 3D view with an image model, to download', async ({ page }) => {
  let sent = 0;
  await page.route('https://api.openai.com/v1/images/edits', async (route) => {
    sent++;
    expect(route.request().headers().authorization).toBe('Bearer sk-render');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [{ b64_json: PNG }] }),
    });
  });
  // Claude reads plans; the OpenAI key makes pictures.
  await page.addInitScript(() => {
    window.sessionStorage.setItem(
      'dhd-ai',
      JSON.stringify({
        active: 'anthropic',
        remember: false,
        keys: {
          anthropic: { key: 'sk-ant-x', model: 'claude-opus-5-5' },
          openai: { key: 'sk-render', model: 'gpt-5' },
        },
      }),
    );
  });
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('3');
  await page.getByRole('button', { name: 'Photo-real render' }).click();
  const dialog = page.getByRole('dialog', { name: 'Photo-real render' });
  // The dialog opens on Exact (drawn on the device); this is the image model's side.
  await dialog.getByRole('button', { name: 'AI impression' }).click();
  await expect(dialog.getByRole('img', { name: 'The 3D view' })).toBeVisible();
  await expect(dialog).toContainText('With OpenAI (gpt-image-1)');
  await dialog.getByLabel('Look').selectOption('scandi');
  await dialog.getByRole('button', { name: 'Render' }).click();
  await expect(dialog.getByRole('img', { name: 'The render' })).toBeVisible();
  expect(sent).toBe(1);
  // The view it was made from, to compare.
  await dialog.getByRole('button', { name: '3D view', exact: true }).click();
  await expect(dialog.getByRole('img', { name: 'The 3D view' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Render', exact: true }).click();
  await expect(dialog.getByRole('img', { name: 'The render' })).toBeVisible();
  const save = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download' }).click();
  expect((await save).suggestedFilename()).toMatch(/-render\.png$/);
});

test('without an image model, a render asks for an OpenAI or Gemini key', async ({ page }) => {
  await page.addInitScript(() => {
    window.sessionStorage.setItem(
      'dhd-ai',
      JSON.stringify({ provider: 'anthropic', key: 'sk-ant-x', model: 'claude-opus-5-5' }),
    );
  });
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('3');
  await page.getByRole('button', { name: 'Photo-real render' }).click();
  const dialog = page.getByRole('dialog', { name: 'Photo-real render' });
  // The dialog opens on Exact (drawn on the device); this is the image model's side.
  await dialog.getByRole('button', { name: 'AI impression' }).click();
  await expect(dialog).toContainText('Renders need an OpenAI or Gemini key');
  await expect(dialog.getByRole('button', { name: 'Render' })).toBeDisabled();
  // Adding one starts on a provider that makes pictures, and keeps Claude reading plans.
  await dialog.getByRole('button', { name: 'Add a key' }).click();
  const settings = page.getByRole('dialog', { name: 'AI assistant' });
  await expect(settings.getByLabel('Provider')).toHaveValue('openai');
  await expect(
    settings.getByLabel('Use OpenAI to trace plans and suggest layouts'),
  ).not.toBeChecked();
  await settings.getByLabel('API key').fill('sk-render');
  await settings.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toContainText('With OpenAI');
  const stored = await page.evaluate(() => window.sessionStorage.getItem('dhd-ai'));
  expect(JSON.parse(stored ?? '{}').active).toBe('anthropic');
});

const blank = {
  wallId: null,
  openingId: null,
  a: null,
  b: null,
  height: null,
  t: null,
  width: null,
  style: null,
  at: null,
  name: null,
};

test('suggested layouts from a brief: checked against what may change, one made the renovation', async ({
  page,
}) => {
  let prompt = '';
  await page.route('https://api.openai.com/v1/chat/completions', async (route) => {
    prompt = JSON.stringify(route.request().postDataJSON());
    const options = [
      {
        name: 'One big bedroom',
        summary: 'The two bedrooms become one master suite.',
        reasons: ['Room for a king bed and a desk'],
        operations: [{ ...blank, op: 'remove_wall', wallId: 'w_bedroom_main-bedroom' }],
      },
      {
        name: 'Glass study',
        summary: 'The bedroom opens to the living room through glass.',
        reasons: ['Light into the living room'],
        operations: [{ ...blank, op: 'glass_wall', wallId: 'w_bedroom_living-and-dining' }],
      },
      {
        name: 'Bigger windows',
        summary: 'Take out an outside wall.',
        reasons: ['More light'],
        operations: [{ ...blank, op: 'remove_wall', wallId: 'w_bedroom_outside' }],
      },
    ];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ options }) } }] }),
    });
  });
  await page.addInitScript(() => {
    window.sessionStorage.setItem(
      'dhd-ai',
      JSON.stringify({ provider: 'openai', key: 'sk-x', model: 'gpt-5' }),
    );
  });
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('1');
  await page.getByRole('button', { name: 'Suggest layouts with AI' }).click();
  const dialog = page.getByRole('dialog', { name: 'Suggest layouts' });
  await dialog.getByLabel('Who lives here').fill('a couple working from home');
  await dialog.getByLabel('A study or home office').check();
  await dialog.getByLabel('Your own ideas').fill('an island kitchen open to the living room');
  await dialog.getByRole('button', { name: 'Suggest layouts' }).click();
  const cards = dialog.locator('.layout-option');
  await expect(cards).toHaveCount(3);
  expect(prompt).toContain('a couple working from home');
  expect(prompt).toContain('A study or home office');
  expect(prompt).toContain('Their own ideas, in their words');
  expect(prompt).toContain('an island kitchen open to the living room');
  await expect(cards.nth(0)).toContainText('Hack');
  await expect(cards.nth(1)).toContainText('glass partition');
  // An outside wall stays, whatever the model said.
  await expect(cards.nth(2)).toContainText('Left out (1)');
  await expect(cards.nth(2)).toContainText('Nothing in this one could be applied');
  await expect(cards.nth(2).getByRole('button')).toHaveCount(0);
  // New and changed walls drawn in the accent colour, removed ones dashed.
  await expect(cards.nth(0).locator('.mini-gone')).not.toHaveCount(0);
  await expect(cards.nth(1).locator('.mini-new')).not.toHaveCount(0);
  await cards.nth(0).getByRole('button', { name: 'Use this' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.reno-bar')).toBeVisible();
  await expect(page.locator('.room-list li')).toHaveCount(8);
  // One undo step back to no renovation.
  await page.keyboard.press('Control+z');
  await expect(page.locator('.reno-bar')).toHaveCount(0);
});
