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
  // The Main bedroom's outside top wall (its second piece, past the window), outwards.
  const wall = page.locator('[data-hit="wall:w_main-bedroom_outside"]').nth(1);
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
  await page.mouse.move(at.x, at.y - 20, { steps: 4 });
  await page.mouse.move(at.x, at.y - 40, { steps: 4 });
  await expect(page.locator('.wall-shift')).toBeVisible();
  await expect(page.locator('.wall-shift text')).toHaveText(/^\d+\.\d\d m$/);
  await page.mouse.up();
  await expect(page.locator('.wall-shift')).toHaveCount(0);
  const after = await wall.boundingBox();
  expect(before.y - (after?.y ?? 0)).toBeGreaterThan(30);
  // The main bedroom inside it grew with it.
  expect((await area.boundingBox())?.height ?? 0).toBeGreaterThan(roomBefore.height + 30);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await wall.boundingBox())?.y ?? 0).toBeCloseTo(before.y, 0);
});

test('moving a wall: the piece carrying on in line stays straight, windows stay put, and it stops at the next wall', async ({
  page,
}) => {
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('1');
  const box = async (sel: string) => {
    const b = await page.locator(sel).first().boundingBox();
    if (!b) throw new Error(`no ${sel}`);
    return b;
  };
  const bedroomTop = '[data-hit="wall:w_bedroom_outside-2"]';
  const bedroomWindow = '[data-hit="opening:op_window_bedroom_outside-2"]';
  const sideWindow = '[data-hit="opening:op_window_main-bedroom_outside-2"]';
  const before = {
    top: await box(bedroomTop),
    window: await box(bedroomWindow),
    side: await box(sideWindow),
  };

  // The Main bedroom's top wall, out by about half a metre.
  const piece = page.locator('[data-hit="wall:w_main-bedroom_outside"]').nth(1);
  const p = await piece.boundingBox();
  if (!p) throw new Error('no wall');
  await piece.click({ force: true });
  await page.waitForTimeout(400);
  await page.mouse.move(p.x + p.width / 2, p.y + p.height / 2);
  await page.mouse.down();
  await page.mouse.move(p.x + p.width / 2, p.y + p.height / 2 - 30, { steps: 6 });
  await page.mouse.up();
  // The Bedroom's top wall, carrying on in line, is still straight and where it was; a step
  // joins them. The windows on the Bedroom's wall and on the wall that followed stay put.
  const top = await box(bedroomTop);
  expect(Math.abs(top.height - before.top.height)).toBeLessThan(2);
  expect(Math.abs(top.y - before.top.y)).toBeLessThan(2);
  expect(Math.abs((await box(bedroomWindow)).x - before.window.x)).toBeLessThan(2);
  expect(Math.abs((await box(sideWindow)).y - before.side.y)).toBeLessThan(2);
  expect((await piece.boundingBox())?.y ?? 0).toBeLessThan(p.y - 20);
  await page.keyboard.press('Control+z');

  // The wall between the bedrooms, dragged far right: it stops short of the Bedroom's door
  // on the wall below (which keeps its place), and the rooms keep their names.
  const wall = page.locator('[data-hit="wall:w_bedroom_main-bedroom"]').first();
  const door = await box('[data-hit="opening:op_door_bedroom_living-and-dining-3"]');
  const w = await wall.boundingBox();
  if (!w) throw new Error('no wall');
  await wall.click({ force: true });
  await page.waitForTimeout(400);
  await page.mouse.move(w.x + w.width / 2, w.y + w.height / 2);
  await page.mouse.down();
  await page.mouse.move(w.x + w.width / 2 + 600, w.y + w.height / 2, { steps: 12 });
  await page.mouse.up();
  expect((await box('[data-hit="opening:op_door_bedroom_living-and-dining-3"]')).x).toBeCloseTo(
    door.x,
    0,
  );
  const moved = await wall.boundingBox();
  expect((moved?.x ?? 0) - w.x).toBeGreaterThan(3);
  expect((moved?.x ?? 0) - w.x).toBeLessThan(door.x - w.x);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: /^Bedroom\b/ })).toHaveCount(1);
});
