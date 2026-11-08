import { waitSaved } from './helpers';
import { expect, test } from './test';

test('clearances: a wardrobe with room, then a chair in front of it; the count and switch', async ({
  page,
}) => {
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('1');
  const room = page.locator('[data-hit="room:rm_main-bedroom"]');
  const box = await room.boundingBox();
  if (!box) throw new Error('no room');

  // A wardrobe against the main bedroom's top wall: room to open it.
  await page.getByRole('button', { name: /^Furniture/ }).click();
  await page.getByRole('button', { name: /^Wardrobe/ }).click();
  await page.mouse.click(box.x + box.width * 0.5, box.y + 30);
  await expect(page.getByRole('heading', { name: 'Wardrobe' })).toBeVisible();
  const section = page.locator('.inspector section', { hasText: 'Clearances' });
  await expect(section).toContainText('Room to use it.');
  await expect(page.locator('.clearance-fine')).toHaveCount(1);
  await expect(page.locator('.clearance-short')).toHaveCount(0);

  // An armchair just in front of it: the doors are short of room.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^Furniture/ }).click();
  await page
    .getByRole('button', { name: /^Armchair/ })
    .first()
    .click();
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.36);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^Select/ }).click();
  await expect(page.locator('.clearance-short')).toHaveCount(1);
  const summary = page.locator('.inspector .field', { has: page.getByLabel('Clearance checks') });
  await expect(summary).toContainText('1 piece is short of room or in the way.');
  await summary.getByRole('button', { name: 'Show next' }).click();
  await expect(page.getByRole('heading', { name: 'Wardrobe' })).toBeVisible();
  await expect(section).toContainText(/Wardrobe doors need 0\.60 m in front; 0\.\d\d m here\./);

  // Switched off: gone, and still off after a reload.
  await page.keyboard.press('Escape');
  await page.getByLabel('Clearance checks').uncheck();
  await expect(page.locator('.clearance-short')).toHaveCount(0);
  await waitSaved(page);
  await page.reload();
  await waitSaved(page);
  await expect(page.getByLabel('Clearance checks')).not.toBeChecked();
  await expect(page.locator('.clearance-short')).toHaveCount(0);
});
