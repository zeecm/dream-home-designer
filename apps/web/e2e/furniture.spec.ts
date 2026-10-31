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

test('handles: a corner dragged past its opposite flips the piece around that corner; a tap near a handle in Furniture places another', async ({
  page,
}) => {
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('1');
  await page.getByRole('button', { name: /^Furniture/ }).click();
  await page
    .getByRole('button', { name: /^Coffee table/ })
    .first()
    .click();
  const room = await page.locator('[data-hit="room:rm_living-and-dining"]').boundingBox();
  if (!room) throw new Error('no room');
  await page.mouse.click(room.x + room.width * 0.5, room.y + room.height * 0.5);
  const items = page.locator('[data-hit^="item:"]');
  await expect(items).toHaveCount(1);
  const before = await items.first().boundingBox();
  if (!before) throw new Error('no piece');

  // The front-right corner, dragged well past the back-left one: the piece now lies beyond
  // that corner, which stays where it was, and keeps its size as the pointer goes on.
  const c = await page.locator('.size-handle').nth(2).boundingBox();
  if (!c) throw new Error('no corner');
  const from = { x: c.x + c.width / 2, y: c.y + c.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  const to = { x: before.x - 60, y: before.y - 40 };
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.move(to.x - 1, to.y - 1, { steps: 2 });
  await page.mouse.up();
  const flipped = await items.first().boundingBox();
  if (!flipped) throw new Error('no piece');
  // Its right and bottom edges are the old left and top edges (to the 1 cm step and stroke).
  expect(Math.abs(flipped.x + flipped.width - before.x)).toBeLessThan(7);
  expect(Math.abs(flipped.y + flipped.height - before.y)).toBeLessThan(7);
  expect(flipped.width).toBeGreaterThan(40);
  await page.keyboard.press('Control+z');

  // A click just beside the selected piece, within reach of a handle, places another one.
  const corner = await page.locator('.size-handle').nth(1).boundingBox();
  if (!corner) throw new Error('no corner');
  await page.mouse.click(corner.x + corner.width / 2 + 14, corner.y + corner.height / 2);
  await expect(items).toHaveCount(2);
});

test('handles: a small selected piece is still moved by dragging its body', async ({ page }) => {
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
  await page.getByRole('button', { name: /^Select/ }).click();
  const item = page.locator('[data-hit^="item:"]').first();
  const a = await item.boundingBox();
  if (!a) throw new Error('no piece');
  const width = await page.getByLabel('Width').inputValue();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 80, a.y + a.height / 2, { steps: 8 });
  await page.mouse.up();
  const b = await item.boundingBox();
  expect((b?.x ?? 0) - a.x).toBeGreaterThan(60);
  await expect(page.getByLabel('Width')).toHaveValue(width);
});

test('handles: Escape takes a drag back; a tap on the turn handle adds nothing; a piece on a wall keeps its back there', async ({
  page,
}) => {
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('1');
  await page.getByRole('button', { name: /^Furniture/ }).click();
  await page
    .getByRole('button', { name: /^Coffee table/ })
    .first()
    .click();
  const room = await page.locator('[data-hit="room:rm_living-and-dining"]').boundingBox();
  if (!room) throw new Error('no room');
  await page.mouse.click(room.x + room.width * 0.5, room.y + room.height * 0.5);
  const items = page.locator('[data-hit^="item:"]');
  await expect(items).toHaveCount(1);
  const width = page.getByLabel('Width');
  const before = await width.inputValue();

  // Escape mid-drag: the size goes back, and moving on changes nothing.
  const c = await page.locator('.size-handle').nth(2).boundingBox();
  if (!c) throw new Error('no corner');
  await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2);
  await page.mouse.down();
  await page.mouse.move(c.x + 50, c.y + 40, { steps: 6 });
  await expect(width).not.toHaveValue(before);
  await page.keyboard.press('Escape');
  await expect(width).toHaveValue(before);
  await page.mouse.move(c.x + 90, c.y + 70, { steps: 4 });
  await page.mouse.up();
  await expect(width).toHaveValue(before);

  // A click right on the turn handle is for the handle: no second table.
  const t = await page.locator('.turn-handle').boundingBox();
  if (!t) throw new Error('no turn handle');
  await page.mouse.click(t.x + t.width / 2, t.y + t.height / 2);
  await expect(items).toHaveCount(1);

  // A TV console against the top wall: its back corner widens it along the wall only.
  await page
    .getByRole('button', { name: /^TV console/ })
    .first()
    .click();
  await page.mouse.click(room.x + room.width * 0.5, room.y + 25);
  await expect(items).toHaveCount(2);
  const depth = page.getByLabel('Depth');
  const d0 = await depth.inputValue();
  const w0 = await width.inputValue();
  const back = await page.locator('.size-handle').nth(1).boundingBox();
  if (!back) throw new Error('no back corner');
  await page.mouse.move(back.x + back.width / 2, back.y + back.height / 2);
  await page.mouse.down();
  await page.mouse.move(back.x + 40, back.y - 50, { steps: 8 });
  await page.mouse.up();
  await expect(width).not.toHaveValue(w0);
  await expect(depth).toHaveValue(d0);
});
