import { type Page, expect } from '@playwright/test';

export async function waitSaved(page: Page) {
  await expect(page.getByTestId('sync')).toHaveText(/^Saved/);
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
