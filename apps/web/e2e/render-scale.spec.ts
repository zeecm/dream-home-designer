import { type Page, expect, test } from '@playwright/test';
import { waitSaved } from './helpers';

/**
 * A render from the orbit view (high up, rooms looking big) starts from eye height in the
 * room the view is centred on, and the model is told the room's true size and only the
 * furniture in the picture. The image model is mocked: no provider is ever called.
 */

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';

/** Answers Gemini's picture requests with a tiny PNG, keeping each prompt sent. */
async function mockGemini(page: Page) {
  const prompts: string[] = [];
  // Never a real provider: anything not mocked is turned away.
  for (const host of ['https://api.openai.com/**', 'https://api.anthropic.com/**']) {
    await page.route(host, (route) => route.abort());
  }
  await page.route('https://generativelanguage.googleapis.com/**', async (route) => {
    const body = route.request().postDataJSON();
    prompts.push(body.contents[0].parts[1].text);
    // A moment's work, as a model takes, so the dialog can be seen busy.
    await new Promise((r) => setTimeout(r, 600));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        candidates: [{ content: { parts: [{ inlineData: { data: PNG } }] } }],
      }),
    });
  });
  await page.addInitScript(() => {
    window.sessionStorage.setItem(
      'dhd-ai',
      JSON.stringify({
        active: 'gemini',
        remember: false,
        keys: { gemini: { key: 'AIza-not-a-real-key', model: 'gemini-2.5-pro' } },
      }),
    );
  });
  return prompts;
}

/** Puts a piece from the catalogue down in a room of the sample (desktop, Plan view). */
async function place(page: Page, find: string, name: RegExp, room: string, fx = 0.5, fy = 0.5) {
  const tools = page.getByRole('navigation', { name: 'Tools' });
  await page.getByRole('button', { name: /^Furniture/ }).click();
  await tools.getByLabel('Find furniture').fill(find);
  await tools.getByRole('button', { name }).first().click();
  const box = await page.locator(`[data-hit="room:${room}"]`).boundingBox();
  if (!box) throw new Error(`no ${room}`);
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
  await page.getByRole('button', { name: /^Select/ }).click();
  await page.keyboard.press('Escape');
}

test('from the orbit view, a render starts from eye height and tells the model the true sizes', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const prompts = await mockGemini(page);
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('1');
  // A sofa in the living room the orbit view is centred on; a fridge in the kitchen, behind
  // walls from there.
  await place(page, 'sofa', /^3-seat sofa/, 'rm_living-and-dining', 0.7, 0.4);
  await place(page, 'fridge', /^Fridge/, 'rm_kitchen');
  await waitSaved(page);
  await page.keyboard.press('3');

  await page.getByRole('button', { name: 'Photo-real render' }).click();
  const dialog = page.getByRole('dialog', { name: 'Photo-real render' });
  // The dialog opens on Exact (drawn on the device); this is the image model's side.
  await dialog.getByRole('button', { name: 'AI impression' }).click();
  const eye = dialog.getByRole('button', { name: 'From eye height in Living and dining' });
  const here = dialog.getByRole('button', {
    name: 'From this view (overhead: rooms may look larger)',
  });
  // Eye height is the default, and the picture shown is the one that will be sent.
  await expect(eye).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 });
  await expect(here).toHaveAttribute('aria-pressed', 'false');
  await expect(
    dialog.getByRole('img', { name: 'The 3D view from eye height in Living and dining' }),
  ).toBeVisible();
  // The model line stays in the foot.
  await expect(dialog.locator('.dialog-foot .render-model')).toBeVisible();

  await dialog.getByRole('button', { name: 'Render' }).click();
  // Where to render from can't change under a render in progress.
  await expect(eye).toBeDisabled();
  await expect(here).toBeDisabled();
  await expect(dialog.getByRole('img', { name: 'The render' })).toBeVisible();
  expect(prompts).toHaveLength(1);
  const atEye = prompts[0] ?? '';
  // The style and fidelity asks are kept.
  expect(atEye).toContain('Edit this image. It is an exact 3D model of a real home');
  expect(atEye).toContain('This is "Living and dining", ');
  expect(atEye).toContain('(21.0 m²), ceiling 2.6 m.');
  expect(atEye).toContain('1.6 m above the floor, at eye height');
  expect(atEye).toContain('"3-seat sofa" 2.1 × 0.9 × 0.8 m');
  // The fridge is behind the kitchen's walls: not in the picture, so not in the list.
  expect(atEye).not.toContain('Fridge');
  expect(atEye).toContain(
    'Do not add, remove, enlarge or move furniture, doors, windows or openings',
  );
  expect(atEye).toContain('Doors, windows and openings in view');

  // From the view itself: honest about it, and the list follows the picture.
  await here.click();
  await expect(dialog.getByText('From above, rooms look bigger than they are')).toBeVisible();
  await expect(dialog.getByRole('img', { name: 'The 3D view', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Render again' }).click();
  await expect(dialog.getByRole('img', { name: 'The render' })).toBeVisible();
  expect(prompts).toHaveLength(2);
  const overhead = prompts[1] ?? '';
  expect(overhead).toContain('cut-away view');
  expect(overhead).toContain('look bigger than they are');
  expect(overhead).toContain('"Living and dining", ');
  expect(overhead).toContain('3-seat sofa');
  expect(overhead).toContain('Fridge');
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the choice sits above the picture, and the model line stays in the foot', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await mockGemini(page);
    await page.goto('/');
    await waitSaved(page);
    await page.getByRole('button', { name: 'Switch to 3D' }).click();
    await page.getByRole('button', { name: 'Photo-real render' }).click();
    const dialog = page.getByRole('dialog', { name: 'Photo-real render' });
    // The dialog opens on Exact (drawn on the device); this is the image model's side.
    await dialog.getByRole('button', { name: 'AI impression' }).click();
    const eye = dialog.getByRole('button', { name: /^From eye height in / });
    await expect(eye).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 });
    const img = dialog.getByRole('img', { name: /^The 3D view from eye height/ });
    await expect(img).toBeVisible();
    const choice = await eye.boundingBox();
    const picture = await img.boundingBox();
    expect(choice && picture && choice.y + choice.height <= picture.y).toBe(true);
    // Both choices on one row, inside the dialog.
    const other = await dialog.getByRole('button', { name: /^From this view/ }).boundingBox();
    expect(other && choice && Math.abs(other.y - choice.y) < 2).toBe(true);
    const foot = dialog.locator('.dialog-foot');
    await expect(foot.locator('.render-model')).toBeInViewport();
    await expect(foot.getByRole('button', { name: 'Render' })).toBeInViewport();
  });
});
