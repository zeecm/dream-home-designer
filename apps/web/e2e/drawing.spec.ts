import { expect, test } from '@playwright/test';
import { floorArea, newBlankPlan, waitSaved } from './helpers';

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

test('a selected room moves by its handle, square to the flat, in one undo step; arrows move it too', async ({
  page,
}) => {
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('1');
  const area = page.locator('[data-hit="room:rm_main-bedroom"]');
  const before = await area.boundingBox();
  if (!before) throw new Error('no room');
  // Selected (near its bottom-left, clear of its label and door): its move handle shows.
  await page.mouse.click(before.x + before.width * 0.15, before.y + before.height * 0.85);
  const handle = page.locator('.room-move circle');
  await expect(handle).toBeVisible();
  const floor = await floorArea(page).textContent();
  const h = await handle.boundingBox();
  if (!h) throw new Error('no handle');
  const at = { x: h.x + h.width / 2, y: h.y + h.height / 2 };

  // Dragged left and a little down: joined to the flat, it goes straight left, showing how far.
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x - 20, at.y + 4, { steps: 4 });
  await page.mouse.move(at.x - 40, at.y + 8, { steps: 4 });
  await expect(page.locator('.handle-length text')).toHaveText(/^← \d+\.\d\d m$/);
  await page.mouse.up();
  await expect(page.locator('.handle-length')).toHaveCount(0);
  const moved = await area.boundingBox();
  expect(before.x - (moved?.x ?? 0)).toBeGreaterThan(20);
  expect(moved?.y).toBeCloseTo(before.y, 0);
  expect(moved?.width).toBeCloseTo(before.width, 0);
  await expect(floorArea(page)).toHaveText(floor ?? '');
  // No wall slants: every wall piece is as wide or as tall as its thickness at most.
  const slanted = await page.locator('[data-hit^="wall:"]').evaluateAll(
    (els) =>
      els.filter((el) => {
        const b = (el as SVGGraphicsElement).getBBox();
        return Math.min(b.width, b.height) > 0.31;
      }).length,
  );
  expect(slanted).toBe(0);

  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await area.boundingBox())?.x ?? 0).toBeCloseTo(before.x, 0);

  // Shift+Arrow moves the selected room 10 cm.
  await page.keyboard.press('Shift+ArrowUp');
  await expect.poll(async () => (await area.boundingBox())?.y ?? 0).toBeLessThan(before.y - 2);
  await expect(floorArea(page)).toHaveText(floor ?? '');
});

test('in the Room tool, a drag from a corner just drawn away from its room draws the next room; into it, adjusts the corner', async ({
  page,
}) => {
  await newBlankPlan(page);
  const walls = page.locator('.facts dd').first();
  const rooms = page.locator('[data-hit^="room:"]');
  const r = await page.locator('svg.plan-svg').boundingBox();
  if (!r) throw new Error('no plan');
  const at = (fx: number, fy: number) => ({ x: r.x + r.width * fx, y: r.y + r.height * fy });
  const drag = async (a: { x: number; y: number }, b: { x: number; y: number }) => {
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 8 });
    await page.mouse.up();
  };
  await page.keyboard.press('r');
  await drag(at(0.2, 0.3), at(0.45, 0.6));
  await expect(rooms).toHaveCount(1);
  const first = await rooms.first().boundingBox();
  // From its top-right corner, out to the right and down: a second room sharing its wall.
  const corner = page.locator('.end-handle').nth(1);
  const c = await corner.boundingBox();
  if (!c || !first) throw new Error('no corner');
  const from = { x: c.x + c.width / 2, y: c.y + c.height / 2 };
  await drag(from, at(0.7, 0.6));
  await expect(rooms).toHaveCount(2);
  await expect(walls).toHaveText('7');
  const firstAfter = await rooms.first().boundingBox();
  expect(firstAfter?.width).toBeCloseTo(first.width, 0);
  expect(firstAfter?.height).toBeCloseTo(first.height, 0);
  // A drag from the new room's far corner into it adjusts that corner: no new room.
  const far = await page.locator('.end-handle').nth(2).boundingBox();
  if (!far) throw new Error('no far corner');
  const f = { x: far.x + far.width / 2, y: far.y + far.height / 2 };
  await drag(f, { x: f.x - 20, y: f.y - 15 });
  await expect(rooms).toHaveCount(2);
  await expect(walls).toHaveText('7');
});
