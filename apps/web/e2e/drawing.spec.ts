import { expect, test } from '@playwright/test';
import { newBlankPlan, waitSaved } from './helpers';

test('with a mouse, a drag draws a wall from where it starts, and a room corner to corner', async ({
  page,
}) => {
  await newBlankPlan(page);
  const walls = page.locator('.facts dd').first();
  const r = await page.locator('svg.plan-svg').boundingBox();
  if (!r) throw new Error('no plan');
  const at = (fx: number, fy: number) => ({ x: r.x + r.width * fx, y: r.y + r.height * fy });

  await page.keyboard.press('w');
  const a = at(0.2, 0.3);
  const b = at(0.5, 0.3);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 });
  // Mid-drag: the wall shows before the button is let go.
  await expect(page.locator('.ghost-wall')).toHaveCount(1);
  await page.mouse.up();
  await expect(walls).toHaveText('1');

  // A second drag elsewhere is a wall of its own, not one from the last corner.
  const c = at(0.2, 0.6);
  const d = at(0.5, 0.6);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(d.x, d.y, { steps: 8 });
  await page.mouse.up();
  await expect(walls).toHaveText('2');
  // A room, dragged corner to corner.
  await page.keyboard.press('Escape');
  await page.keyboard.press('r');
  const e = at(0.6, 0.2);
  const f = at(0.85, 0.5);
  await page.mouse.move(e.x, e.y);
  await page.mouse.down();
  await page.mouse.move(f.x, f.y, { steps: 8 });
  await expect(page.locator('.ghost-room')).toBeVisible();
  await page.mouse.up();
  await expect(walls).toHaveText('6');
});

test('in the Door tool, dragging a door moves it; a room can be deleted, and undone', async ({
  page,
}) => {
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('1');
  const doors = () => page.locator('[data-hit^="opening:"]').count();
  const before = await doors();
  await page.keyboard.press('d');
  const door = page.locator('[data-hit^="opening:"]').first();
  const box = await door.boundingBox();
  if (!box) throw new Error('no door');
  const id = await door.getAttribute('data-hit');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2 + 1, { steps: 6 });
  // Mid-drag: the clear wall either side of it, to the inside corners.
  const clear = page.getByTestId('opening-clearances').locator('text');
  await expect(clear.first()).toHaveText(/^\d+\.\d\d m$/);
  expect(await clear.count()).toBeGreaterThanOrEqual(1);
  await page.mouse.up();
  await expect(page.getByTestId('opening-clearances')).toHaveCount(0, { timeout: 500 });
  expect(await doors()).toBe(before);
  const moved = await page.locator(`[data-hit="${id}"]`).first().boundingBox();
  expect(Math.abs((moved?.x ?? 0) - box.x) + Math.abs((moved?.y ?? 0) - box.y)).toBeGreaterThan(5);

  // Delete the main bedroom: its own walls go, the rest of the flat stays.
  await page.keyboard.press('Escape');
  await page.keyboard.press('v');
  await page.getByRole('button', { name: /^Main bedroom/ }).click();
  await page.getByRole('button', { name: 'Delete room' }).click();
  await expect(page.locator('[data-hit="room:rm_main-bedroom"]')).toHaveCount(0);
  await expect(page.locator('.toast')).toContainText('deleted');
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('[data-hit="room:rm_main-bedroom"]')).toHaveCount(1);
});

test('a selected wall drags sideways, its joined walls following, in one undo step', async ({
  page,
}) => {
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('1');
  const wall = page.locator('[data-hit="wall:w_bedroom_main-bedroom"]').first();
  const area = page.locator('[data-hit="room:rm_main-bedroom"]');
  const before = await wall.boundingBox();
  const roomBefore = await area.boundingBox();
  if (!before || !roomBefore) throw new Error('no wall');
  const at = { x: before.x + before.width / 2, y: before.y + before.height / 2 };

  await wall.click({ force: true });
  // (A second press straight after is a double-click, which splits the wall.)
  await page.waitForTimeout(400);
  // Selected: a drag moves it, showing how far mid-drag.
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + 20, at.y, { steps: 4 });
  await page.mouse.move(at.x + 40, at.y, { steps: 4 });
  await expect(page.locator('.wall-shift')).toBeVisible();
  await expect(page.locator('.wall-shift text')).toHaveText(/^\d+\.\d\d m$/);
  await page.mouse.up();
  await expect(page.locator('.wall-shift')).toHaveCount(0);
  const after = await wall.boundingBox();
  expect((after?.x ?? 0) - before.x).toBeGreaterThan(30);
  // The main bedroom beside it grew with it.
  expect((await area.boundingBox())?.width ?? 0).toBeGreaterThan(roomBefore.width + 30);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await wall.boundingBox())?.x ?? 0).toBeCloseTo(before.x, 0);
});
