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
  await expect(page.locator('.toast')).toContainText('Queen bed deleted');
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

test('duplicate a piece beside itself, from the details or with Ctrl+D', async ({ page }) => {
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('1');
  await page.getByRole('button', { name: /^Furniture/ }).click();
  await page
    .getByRole('button', { name: /^Dining chair\b/ })
    .first()
    .click();
  const room = await page.locator('[data-hit="room:rm_living-and-dining"]').boundingBox();
  if (!room) throw new Error('no room');
  await page.mouse.click(room.x + room.width * 0.5, room.y + room.height * 0.5);
  const items = page.locator('[data-hit^="item:"]');
  await expect(items).toHaveCount(1);
  await page.getByRole('button', { name: 'Duplicate' }).click();
  await expect(items).toHaveCount(2);
  await page.locator('svg.plan-svg').focus();
  await page.keyboard.press('Control+d');
  await expect(items).toHaveCount(3);
  await page.keyboard.press('Control+z');
  await expect(items).toHaveCount(2);
});

test('resize and turn a selected piece by its handles, each drag one undo step', async ({
  page,
}) => {
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('1');
  await page.getByRole('button', { name: /^Furniture/ }).click();
  await page
    .getByRole('button', { name: /^Round coffee table|^Coffee table/ })
    .first()
    .click();
  const room = await page.locator('[data-hit="room:rm_living-and-dining"]').boundingBox();
  if (!room) throw new Error('no room');
  await page.mouse.click(room.x + room.width * 0.5, room.y + room.height * 0.5);
  const width = page.getByLabel('Width');
  const before = await width.inputValue();

  // Straight after placing it, still in Furniture: the front-right corner, dragged out: wider and deeper, with the size shown mid-drag.
  const corners = page.locator('.size-handle');
  await expect(corners).toHaveCount(4);
  const c = await corners.nth(2).boundingBox();
  if (!c) throw new Error('no corner');
  const from = { x: c.x + c.width / 2, y: c.y + c.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 30, from.y + 30, { steps: 5 });
  await page.mouse.move(from.x + 60, from.y + 60, { steps: 5 });
  await expect(page.locator('.handle-length')).toBeVisible();
  await page.mouse.up();
  await expect(page.locator('.handle-length')).toHaveCount(0);
  await expect(width).not.toHaveValue(before);
  await page.keyboard.press('Control+z');
  await expect(width).toHaveValue(before);

  await expect(page.locator('[data-hit^="item:"]')).toHaveCount(1);

  // In Select, the turn handle dragged round to the right: the piece faces right.
  await page.getByRole('button', { name: /^Select/ }).click();
  const item = await page.locator('[data-hit^="item:"]').first().boundingBox();
  const t = await page.locator('.turn-handle').boundingBox();
  if (!item || !t) throw new Error('no turn handle');
  const centre = { x: item.x + item.width / 2, y: item.y + item.height / 2 };
  await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2);
  await page.mouse.down();
  await page.mouse.move(centre.x + 120, centre.y, { steps: 10 });
  await page.mouse.up();
  const turned = await page.locator('.turn-handle').boundingBox();
  expect((turned?.x ?? 0) - centre.x).toBeGreaterThan(40);
  expect(Math.abs((turned?.y ?? 0) + (turned?.height ?? 0) / 2 - centre.y)).toBeLessThan(6);
  await page.keyboard.press('Control+z');
  await expect
    .poll(async () => (await page.locator('.turn-handle').boundingBox())?.y ?? 0)
    .toBeCloseTo(t.y, 0);
});
