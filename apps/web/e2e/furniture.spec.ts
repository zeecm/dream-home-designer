import { expect, test } from '@playwright/test';
import { waitSaved } from './helpers';

test('furnish: place a bed against a wall, turn it, resize it, delete and undo', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('1');
  await page.getByRole('button', { name: /^Furniture/ }).click();
  await page.getByRole('button', { name: /Queen bed/ }).click();

  // Into the main bedroom, just below its top wall: the bed backs onto the wall.
  const room = page.locator('[data-hit="room:rm_main-bedroom"]');
  const box = await room.boundingBox();
  if (!box) throw new Error('no room');
  await page.mouse.move(box.x + box.width * 0.5, box.y + 40);
  await page.mouse.down();
  await page.mouse.up();
  const items = page.locator('[data-hit^="item:"]');
  await expect(items).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Queen bed' })).toBeVisible();
  await expect(page.getByLabel('Width')).toHaveValue('1.52 m');

  // Resize, turn and delete through the details panel and keys.
  const width = page.getByLabel('Width');
  await width.fill('1830');
  await width.press('Enter');
  await expect(width).toHaveValue('1.83 m');
  await page.getByRole('button', { name: '↻ 90°' }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^Select/ }).click();
  await items.first().click({ force: true });
  await page.keyboard.press('Delete');
  await expect(items).toHaveCount(0);
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await expect(items).toHaveCount(1);
  await waitSaved(page);

  // It shows in 3D without errors.
  await page.keyboard.press('3');
  await expect(page.getByRole('button', { name: 'Walk through' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('paint each side of a wall, and pick a floor finish', async ({ page }) => {
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('1');
  await page.locator('[data-hit="wall:w_bedroom_main-bedroom"]').first().click({ force: true });
  const sage = page.getByRole('button', { name: 'Paint, Main bedroom side: Sage' });
  await sage.click();
  await expect(sage).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Paint, Bedroom side: White' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.keyboard.press('Escape');
  await page.locator('[data-hit="room:rm_main-bedroom"]').click({ force: true });
  await page.getByLabel('Floor', { exact: true }).selectOption('marble');
  await expect(page.getByLabel('Floor', { exact: true })).toHaveValue('marble');
  await page.keyboard.press('Control+z');
  await expect(page.getByLabel('Floor', { exact: true })).toHaveValue('wood-walnut');
});
