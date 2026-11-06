import { type Page, expect, test } from '@playwright/test';
import { waitSaved } from './helpers';

const KEY = 'AIza-test-not-a-real-key-123456';
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';

/** Some of what Gemini's model list holds. */
const geminiModels = {
  models: [
    ['gemini-2.5-pro', 'Gemini 2.5 Pro', ['generateContent', 'countTokens']],
    ['gemini-3-pro', 'Gemini 3 Pro', ['generateContent', 'countTokens']],
    ['gemini-2.5-flash', 'Gemini 2.5 Flash', ['generateContent', 'countTokens']],
    ['gemini-2.5-flash-image', 'Nano Banana', ['generateContent', 'countTokens']],
    ['gemini-3-pro-image', 'Nano Banana Pro', ['generateContent', 'countTokens']],
    ['gemini-2.5-flash-preview-tts', 'Gemini 2.5 Flash TTS', ['generateContent']],
    ['gemini-embedding-001', 'Gemini Embedding', ['embedContent']],
  ].map(([id, displayName, supportedGenerationMethods]) => ({
    name: `models/${id}`,
    displayName,
    supportedGenerationMethods,
  })),
};

/** Gemini's model list. */
const isList = (url: URL) => url.origin + url.pathname === `${GEMINI}/models`;
/** A call on one Gemini model. */
const endsWith = (call: string) => (url: URL) =>
  url.href.startsWith(`${GEMINI}/models/`) && url.pathname.endsWith(call);

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

async function openSettings(page: Page) {
  await page.goto('/');
  await waitSaved(page);
  await page.getByRole('button', { name: 'Projects' }).click();
  await page.getByRole('button', { name: 'AI assistant…' }).click();
  const dialog = page.getByRole('dialog', { name: 'AI assistant' });
  await expect(dialog).toBeVisible();
  return dialog;
}

const optionTexts = (page: Page, label: string) =>
  page
    .getByRole('dialog', { name: 'AI assistant' })
    .getByLabel(label)
    .locator('option')
    .allTextContents();

test('the model selects fill from the key’s own model list', async ({ page }) => {
  const asked: { url: string; key?: string }[] = [];
  await page.route(isList, async (route) => {
    asked.push({ url: route.request().url(), key: route.request().headers()['x-goog-api-key'] });
    await route.fulfill({ status: 200, json: geminiModels });
  });
  const dialog = await openSettings(page);
  await dialog.getByLabel('Provider').selectOption('gemini');
  await expect(dialog.getByLabel('Model for pictures (photo-real renders)')).toBeVisible();
  await dialog.getByLabel('API key').fill(KEY);
  const plans = dialog.getByLabel('Model for plans and layouts');
  // The usual ones until the key's own list comes.
  await expect(plans.locator('option')).toHaveText([
    'Gemini 3 Pro (recommended)',
    'Gemini 2.5 Pro',
    'Gemini 2.5 Flash',
  ]);
  await expect(plans).toHaveValue('gemini-3-pro');
  const pictures = dialog.getByLabel('Model for pictures (photo-real renders)');
  await expect(pictures.locator('option')).toHaveText([
    'Nano Banana Pro (recommended)',
    'Nano Banana',
  ]);
  await expect(pictures).toHaveValue('gemini-3-pro-image');
  // Asked once typing stopped, with the key, of Google only.
  expect(asked).toHaveLength(1);
  expect(asked[0]?.url).toContain('pageSize=200');
  expect(asked[0]?.key).toBe(KEY);
  // Claude makes no pictures: no picture model to pick.
  await dialog.getByLabel('Provider').selectOption('anthropic');
  await expect(dialog.getByLabel('Model for pictures (photo-real renders)')).toHaveCount(0);
});

test('when the models can’t be listed, the usual ones are offered', async ({ page }) => {
  // The listing is blocked (as by a network or browser block).
  const dialog = await openSettings(page);
  await dialog.getByLabel('Provider').selectOption('gemini');
  await dialog.getByLabel('API key').fill(KEY);
  await expect(dialog).toContainText('Couldn’t list the models on this key');
  expect(await optionTexts(page, 'Model for plans and layouts')).toEqual([
    'gemini-3-pro (recommended)',
    'gemini-2.5-pro',
    'gemini-2.5-flash',
  ]);
  expect(await optionTexts(page, 'Model for pictures (photo-real renders)')).toEqual([
    'gemini-3-pro-image (recommended)',
    'gemini-3.1-flash-image',
    'gemini-2.5-flash-image',
  ]);
  // A refused key says so.
  await page.route('https://api.openai.com/v1/models', (route) =>
    route.fulfill({ status: 401, json: { error: { message: 'Incorrect API key provided' } } }),
  );
  await dialog.getByLabel('Provider').selectOption('openai');
  await dialog.getByLabel('API key').fill('sk-wrong-key-123456');
  await expect(dialog).toContainText('The key was refused, so the usual models are shown');
  await expect(dialog.getByLabel('Model for plans and layouts')).toHaveValue('gpt-5');
  await expect(dialog.getByLabel('Model for pictures (photo-real renders)')).toHaveValue(
    'gpt-image-1',
  );
});

test('the picture model chosen is the one renders use, and a refusal shows the provider’s words', async ({
  page,
}) => {
  await page.route(isList, (route) => route.fulfill({ status: 200, json: geminiModels }));
  const rendered: string[] = [];
  await page.route(endsWith(':generateContent'), async (route) => {
    rendered.push(route.request().url());
    await route.fulfill({
      status: 400,
      json: {
        error: {
          code: 400,
          message: `Unsupported aspect ratio for this model (key ${KEY}).`,
          status: 'INVALID_ARGUMENT',
        },
      },
    });
  });
  const dialog = await openSettings(page);
  await dialog.getByLabel('Provider').selectOption('gemini');
  await dialog.getByLabel('API key').fill(KEY);
  const pictures = dialog.getByLabel('Model for pictures (photo-real renders)');
  await expect(pictures.locator('option')).toHaveCount(2);
  await pictures.selectOption('gemini-2.5-flash-image');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);
  const stored = JSON.parse(
    (await page.evaluate(() => window.sessionStorage.getItem('dhd-ai'))) ?? '{}',
  );
  expect(stored.keys.gemini).toMatchObject({
    model: 'gemini-3-pro',
    imageModel: 'gemini-2.5-flash-image',
  });

  await page.keyboard.press('3');
  await page.getByRole('button', { name: 'Photo-real render' }).click();
  const render = page.getByRole('dialog', { name: 'Photo-real render' });
  await expect(render.getByRole('img', { name: 'The 3D view' })).toBeVisible();
  await expect(render).toContainText('With Gemini (Google) (gemini-2.5-flash-image)');
  await render.getByRole('button', { name: 'Render' }).click();
  await expect(render).toContainText(
    'Gemini turned the request down (400): Unsupported aspect ratio for this model (key [key]).',
  );
  await expect(render).not.toContainText(KEY);
  expect(rendered).toEqual([`${GEMINI}/models/gemini-2.5-flash-image:generateContent`]);
});

test('Test checks both models, without making a picture', async ({ page }) => {
  await page.route(isList, (route) => route.fulfill({ status: 200, json: geminiModels }));
  const generated: string[] = [];
  await page.route(endsWith(':generateContent'), async (route) => {
    generated.push(route.request().url());
    await route.fulfill({
      status: 200,
      json: { candidates: [{ content: { parts: [{ text: '{"ok": true}' }] } }] },
    });
  });
  await page.route(endsWith(':countTokens'), (route) =>
    route.fulfill({
      status: 404,
      json: { error: { code: 404, message: 'models/gemini-3-pro-image is not found.' } },
    }),
  );
  const dialog = await openSettings(page);
  await dialog.getByLabel('Provider').selectOption('gemini');
  await dialog.getByLabel('API key').fill(KEY);
  await expect(dialog.getByLabel('Model for plans and layouts').locator('option')).toHaveText([
    'Gemini 3 Pro (recommended)',
    'Gemini 2.5 Pro',
    'Gemini 2.5 Flash',
  ]);
  await dialog.getByRole('button', { name: 'Test' }).click();
  const status = dialog.locator('.ai-status');
  await expect(status).toContainText('Plans and layouts (gemini-3-pro): it works.');
  await expect(status).toContainText(
    'Pictures (gemini-3-pro-image): Gemini turned the request down (404): models/gemini-3-pro-image is not found.',
  );
  expect(generated).toEqual([`${GEMINI}/models/gemini-3-pro:generateContent`]);
});
