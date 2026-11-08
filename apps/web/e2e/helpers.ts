import { type Page, expect } from './test';

export async function waitSaved(page: Page) {
  // The first load probes the API, which can take a while under a busy parallel run.
  await expect(page.getByTestId('sync')).toHaveText(/^Saved/, { timeout: 30_000 });
}

/** Opens a new blank plan in Plan view. */
export async function newBlankPlan(page: Page) {
  await page.goto('/');
  await waitSaved(page);
  await page.getByRole('button', { name: 'Projects' }).click();
  await page.getByRole('button', { name: 'New blank plan' }).click();
  await expect(page.getByText('Start your plan')).toBeVisible();
}

/** Screen position of a pixel of the plan image. */
export async function imagePoint(page: Page, px: number, py: number) {
  return page.evaluate(
    ([x, y]) => {
      const img = document.querySelector('image.underlay') as SVGGraphicsElement;
      const p = new DOMPoint(x, y).matrixTransform(img.getScreenCTM() ?? undefined);
      return { x: p.x, y: p.y };
    },
    [px, py] as const,
  );
}

export async function clickImage(page: Page, px: number, py: number) {
  const p = await imagePoint(page, px, py);
  await page.mouse.move(p.x, p.y, { steps: 2 });
  await page.mouse.click(p.x, p.y);
}

export const floorArea = (page: Page) => page.locator('.total-figure');

/** Places a fridge in the sample's kitchen (desktop, Plan view), back in Select after. */
export async function placeFridge(page: Page) {
  const tools = page.getByRole('navigation', { name: 'Tools' });
  await page.getByRole('button', { name: /^Furniture/ }).click();
  await tools.getByLabel('Find furniture').fill('fridge');
  await tools
    .getByRole('button', { name: /^Fridge/ })
    .first()
    .click();
  const box = await page.locator('[data-hit="room:rm_kitchen"]').boundingBox();
  if (!box) throw new Error('no kitchen');
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
  const fridge = page.locator('[data-hit^="item:"]').first();
  await expect(fridge).toHaveCount(1);
  await page.getByRole('button', { name: /^Select/ }).click();
  await page.keyboard.press('Escape');
  await waitSaved(page);
  return fridge;
}

/** The middle of the first element matching `selector`, on screen. */
export async function centre(page: Page, selector: string) {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`nothing at ${selector}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
