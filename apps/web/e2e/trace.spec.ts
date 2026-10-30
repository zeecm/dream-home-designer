import { expect, test } from '@playwright/test';
import { clickImage, floorArea, newBlankPlan, waitSaved } from './helpers';

// The bundled sample plan is 1100 x 940 px at 80 px/m with the flat's centre lines from
// (110, 110) to (990, 790); its 11000 mm dimension runs from x 110 to 990 at y 50.
test('trace a plan image: upload, set scale, draw walls, reload', async ({ page }) => {
  await newBlankPlan(page);
  await page.getByRole('button', { name: 'try the sample plan' }).click();
  await expect(page.locator('image.underlay')).toBeVisible();
  await expect(page.locator('.canvas-banner')).toContainText('Set scale 1/2');

  await clickImage(page, 110, 50);
  await clickImage(page, 990, 50);
  await page.keyboard.type('11000mm');
  await page.keyboard.press('Enter');
  await expect(page.getByText('1 m on the plan = 80 image px')).toBeVisible();
  await expect(page.locator('.tool[aria-pressed="true"]')).toContainText('Wall');

  await page.getByRole('button', { name: 'Fit plan' }).click();
  await page.getByRole('button', { name: /200 mm/ }).click();
  for (const [x, y] of [
    [110, 110],
    [990, 110],
    [990, 790],
    [110, 790],
    [110, 110],
  ] as const) {
    await clickImage(page, x, y);
  }
  await expect(floorArea(page)).toHaveText('93.5 m²');

  // An inner wall from the front wall to the back wall splits the flat in two.
  await clickImage(page, 510, 110);
  await clickImage(page, 510, 790);
  await page.keyboard.press('Escape');
  await expect(page.locator('.room-list li')).toHaveCount(2);
  await expect(floorArea(page)).toHaveText('93.5 m²');

  await waitSaved(page);
  await page.reload();
  await waitSaved(page);
  await expect(page.locator('image.underlay')).toBeVisible();
  await expect(page.locator('.room-list li')).toHaveCount(2);
});

test('a real HDB plan PDF renders as the plan image', async ({ page }) => {
  await newBlankPlan(page);
  await page.getByRole('button', { name: 'a real HDB 3-room plan (PDF)' }).click();
  await expect(page.locator('image.underlay')).toBeVisible({ timeout: 30_000 });
  const size = await page
    .locator('image.underlay')
    .evaluate((el) => [el.getAttribute('width'), el.getAttribute('height')]);
  expect(Number(size[1])).toBe(3000);
});
