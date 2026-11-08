import { waitSaved } from './helpers';
import { type Page, expect, test } from './test';

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
  // The cheaper picture model suggested; the dearer one says so.
  await expect(pictures.locator('option')).toHaveText([
    'Nano Banana (recommended, cheaper)',
    'Nano Banana Pro (about 3× the price)',
  ]);
  await expect(pictures).toHaveValue('gemini-2.5-flash-image');
  // Asked once typing stopped, with the key, of Google only.
  expect(asked).toHaveLength(1);
  expect(asked[0]?.url).toContain('pageSize=200');
  expect(asked[0]?.key).toBe(KEY);
  // Typing on keeps the list shown until the new key's comes: no jump back to the usual ones.
  await dialog.getByLabel('API key').press('End');
  await dialog.getByLabel('API key').pressSequentially('x');
  expect(await optionTexts(page, 'Model for pictures (photo-real renders)')).toEqual([
    'Nano Banana (recommended, cheaper)',
    'Nano Banana Pro (about 3× the price)',
  ]);
  await expect.poll(() => asked.length).toBe(2);
  expect(asked[1]?.key).toBe(`${KEY}x`);
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
    'Gemini 3 Pro (recommended)',
    'Gemini 2.5 Pro',
    'Gemini 2.5 Flash',
  ]);
  expect(await optionTexts(page, 'Model for pictures (photo-real renders)')).toEqual([
    'Gemini 2.5 Flash Image (recommended, cheaper)',
    'Gemini 3 Pro Image (about 3× the price)',
    'Gemini 3.1 Flash Image',
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
  // The dearer one, picked knowingly.
  await pictures.selectOption('gemini-3-pro-image');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);
  const stored = JSON.parse(
    (await page.evaluate(() => window.sessionStorage.getItem('dhd-ai'))) ?? '{}',
  );
  expect(stored.keys.gemini).toMatchObject({
    model: 'gemini-3-pro',
    imageModel: 'gemini-3-pro-image',
  });

  await page.keyboard.press('3');
  await page.getByRole('button', { name: 'Photo-real render' }).click();
  const render = page.getByRole('dialog', { name: 'Photo-real render' });
  // The dialog opens on Exact (drawn on the device); this is the image model's side.
  await render.getByRole('button', { name: 'AI impression' }).click();
  await expect(render.getByRole('img', { name: 'The 3D view' })).toBeVisible();
  await expect(render).toContainText('With Gemini (Google) (gemini-3-pro-image)');
  await render.getByRole('button', { name: 'Render' }).click();
  await expect(render).toContainText(
    'Gemini turned the request down (400): Unsupported aspect ratio for this model (key [key]).',
  );
  await expect(render).not.toContainText(KEY);
  expect(rendered).toEqual([`${GEMINI}/models/gemini-3-pro-image:generateContent`]);
  // With the message shown, the model in use and the look are still in full view.
  await expect(render.getByText('With Gemini (Google) (gemini-3-pro-image)')).toBeInViewport({
    ratio: 1,
  });
  await expect(render.getByLabel('Look')).toBeInViewport({ ratio: 1 });
});

test('saving a key again never changes its picture model by itself', async ({ page }) => {
  await page.route(isList, (route) => route.fulfill({ status: 200, json: geminiModels }));
  // A key saved before the picture choice (renders with the default), and one with the
  // dearer model picked.
  await page.addInitScript(() => {
    window.sessionStorage.setItem(
      'dhd-ai',
      JSON.stringify({
        active: 'gemini',
        keys: {
          gemini: { key: 'AIza-old-key-1234567890', model: 'gemini-2.5-pro' },
          openai: { key: 'sk-old-key-1234567890', model: 'gpt-5', imageModel: 'gpt-image-1-mini' },
        },
      }),
    );
  });
  const dialog = await openSettings(page);
  const pictures = dialog.getByLabel('Model for pictures (photo-real renders)');
  await expect(pictures.locator('option')).toHaveCount(2);
  await expect(pictures).toHaveValue('gemini-2.5-flash-image');
  await expect(dialog.getByLabel('Model for plans and layouts')).toHaveValue('gemini-2.5-pro');
  await dialog.getByRole('button', { name: 'Save' }).click();
  const stored = async () =>
    JSON.parse((await page.evaluate(() => window.sessionStorage.getItem('dhd-ai'))) ?? '{}');
  expect((await stored()).keys.gemini).toMatchObject({
    model: 'gemini-2.5-pro',
    imageModel: 'gemini-2.5-flash-image',
  });
  // A saved model the list doesn't have (the listing is blocked here) stays, marked saved.
  await page.getByRole('button', { name: 'Projects' }).click();
  await page.getByRole('button', { name: 'AI assistant…' }).click();
  await dialog.getByLabel('Provider').selectOption('openai');
  await expect(dialog).toContainText('Couldn’t list the models on this key');
  await expect(pictures).toHaveValue('gpt-image-1-mini');
  await expect(pictures.locator('option').first()).toHaveText('GPT Image 1 mini (saved, cheaper)');
  await dialog.getByRole('button', { name: 'Save' }).click();
  expect((await stored()).keys.openai.imageModel).toBe('gpt-image-1-mini');
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
      json: { error: { code: 404, message: 'models/gemini-2.5-flash-image is not found.' } },
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
    'Pictures (gemini-2.5-flash-image): Gemini turned the request down (404): models/gemini-2.5-flash-image is not found.',
  );
  expect(generated).toEqual([`${GEMINI}/models/gemini-3-pro:generateContent`]);
});

test('a test still running when the provider changes says nothing afterwards', async ({ page }) => {
  await page.route(isList, (route) => route.fulfill({ status: 200, json: geminiModels }));
  let answer: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    answer = resolve;
  });
  await page.route(endsWith(':generateContent'), async (route) => {
    await held;
    await route
      .fulfill({
        status: 200,
        json: { candidates: [{ content: { parts: [{ text: '{"ok": true}' }] } }] },
      })
      .catch(() => {}); // the page cancelled it
  });
  const dialog = await openSettings(page);
  await dialog.getByLabel('Provider').selectOption('gemini');
  await dialog.getByLabel('API key').fill(KEY);
  await dialog.getByRole('button', { name: 'Test' }).click();
  const status = dialog.locator('.ai-status');
  await expect(status).toHaveText('Testing…');
  await dialog.getByLabel('Provider').selectOption('anthropic');
  await expect(status).toHaveText('');
  answer();
  await page.waitForTimeout(500);
  await expect(status).toHaveText('');
  // Back on Gemini, testing again isn't held up by the stopped one.
  await dialog.getByLabel('Provider').selectOption('gemini');
  await dialog.getByLabel('API key').fill(KEY);
  await expect(dialog.getByRole('button', { name: 'Test' })).toBeEnabled();
});

test('closing the render dialog with a held Enter doesn’t open it again', async ({ page }) => {
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('3');
  const open = page.getByRole('button', { name: 'Photo-real render' });
  await open.focus();
  await page.keyboard.press('Enter');
  const render = page.getByRole('dialog', { name: 'Photo-real render' });
  await expect(render).toBeVisible();
  await render.getByRole('button', { name: 'Close' }).focus();
  // Held down: the first press closes it, the repeats land on the button it came from.
  await page.keyboard.down('Enter');
  await expect(render).toHaveCount(0);
  await expect(open).toBeFocused();
  await page.keyboard.down('Enter');
  await page.keyboard.down('Enter');
  await page.keyboard.up('Enter');
  await page.waitForTimeout(300);
  await expect(render).toHaveCount(0);
  // A fresh press still opens it.
  await page.keyboard.press('Enter');
  await expect(render).toBeVisible();
});
