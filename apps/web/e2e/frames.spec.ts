import { waitSaved } from './helpers';
import { type Page, expect, test } from './test';

/**
 * The 3D view draws only when something changes. It counts the frames it draws into
 * `window.__DHD_FRAMES__` when a test sets it before the app loads.
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__DHD_FRAMES__ = 0;
  });
});

const frames = (page: Page) => page.evaluate(() => window.__DHD_FRAMES__ ?? -1);

/** The frames drawn in the next `ms`, with nobody touching anything. */
async function drawnIn(page: Page, ms: number) {
  const from = await frames(page);
  await page.waitForTimeout(ms);
  return (await frames(page)) - from;
}

/** Waits for the view to come to rest: no frame for a whole second. */
async function rests(page: Page) {
  await expect.poll(() => drawnIn(page, 1000), { timeout: 30_000, intervals: [0] }).toBe(0);
}

/** Waits for the view to draw again (from `from` frames), with nobody touching anything. */
async function draws(page: Page, from: number) {
  await expect.poll(() => frames(page), { timeout: 15_000 }).toBeGreaterThan(from);
}

const view = (page: Page) => page.getByTestId('viewport').locator('canvas');

async function open3d(page: Page, key: '2' | '3') {
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press(key);
  await expect(view(page)).toBeVisible();
  // Built, and its first frames drawn.
  await expect.poll(() => frames(page)).toBeGreaterThan(0);
}

for (const [mode, key] of [
  ['3D', '3'],
  ['Split', '2'],
] as const) {
  test(`an idle ${mode} view draws at most a few frames in 5 s`, async ({ page }) => {
    await open3d(page, key);
    await rests(page);
    expect(await drawnIn(page, 5000)).toBeLessThanOrEqual(3);
  });
}

test('orbiting draws while the damping settles after the mouse lets go, then stops', async ({
  page,
}) => {
  await open3d(page, '3');
  await rests(page);
  const box = await view(page).boundingBox();
  if (!box) throw new Error('no 3D view');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 240, y + 40, { steps: 4 });
  await page.mouse.up();
  const released = await frames(page);
  const shot = await view(page).screenshot();
  // The camera glides on after the mouse is up, a frame at a time, and comes to rest.
  await expect.poll(() => frames(page)).toBeGreaterThan(released + 5);
  await rests(page);
  expect((await view(page).screenshot()).equals(shot)).toBe(false);
});

test('a new time of day redraws the view, with nothing else touched', async ({ page }) => {
  await open3d(page, '3');
  await rests(page);
  const shot = await view(page).screenshot();
  const from = await frames(page);
  await page.getByLabel(/^Time/).fill('19');
  await draws(page, from);
  await rests(page);
  expect((await view(page).screenshot()).equals(shot)).toBe(false);
});

test('an edit in the plan redraws the 3D view beside it', async ({ page }) => {
  await open3d(page, '2');
  await rests(page);
  const shot = await view(page).screenshot();
  const wall = await page.locator('[data-hit^="wall:"]').first().boundingBox();
  if (!wall) throw new Error('no wall');
  await page.mouse.click(wall.x + wall.width / 2, wall.y + wall.height / 2);
  await expect(page.getByRole('heading', { name: 'Wall', exact: true })).toBeVisible();
  const from = await frames(page);
  await page.keyboard.press('Delete');
  await draws(page, from);
  await rests(page);
  expect((await view(page).screenshot()).equals(shot)).toBe(false);
});

test('a model that finishes loading takes its stand-in’s place on its own', async ({ page }) => {
  // The sofa's model is held back until the view has drawn its stand-in and come to rest.
  let release = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  await page.route(/\/models\/chesterfield-sofa\.[0-9a-f]+\.glb$/, async (route) => {
    await held;
    await route.continue();
  });
  await open3d(page, '2');
  const tools = page.getByRole('navigation', { name: 'Tools' });
  await page.getByRole('button', { name: /^Furniture/ }).click();
  await tools.getByLabel('Find furniture').fill('chesterfield');
  await tools.getByRole('button', { name: /^Chesterfield sofa/ }).click();
  const room = await page.locator('[data-hit="room:rm_living-and-dining"]').boundingBox();
  if (!room) throw new Error('no room');
  await page.mouse.click(room.x + room.width * 0.5, room.y + room.height * 0.5);
  await expect(page.locator('[data-hit^="item:"]')).toHaveCount(1);
  await page.getByRole('button', { name: /^Select/ }).click();
  await page.keyboard.press('Escape');
  await rests(page);
  const shot = await view(page).screenshot();
  const from = await frames(page);
  const arrived = page.waitForResponse(/\/models\/chesterfield-sofa\./);
  release();
  await arrived;
  await draws(page, from);
  await rests(page);
  expect((await view(page).screenshot()).equals(shot)).toBe(false);
});

test('a resized view draws itself again at its new size', async ({ page }) => {
  await open3d(page, '3');
  await rests(page);
  const from = await frames(page);
  await page.setViewportSize({ width: 1100, height: 760 });
  await draws(page, from);
  await rests(page);
});

test('the walk draws every frame, and doors swing open as the walker nears', async ({ page }) => {
  await open3d(page, '3');
  const id = new URL(page.url()).searchParams.get('p');
  const doors = () => page.evaluate(() => window.__DHD_DOORS__?.() ?? []);
  // Standing still in the walk, the view still draws every frame, as smooth as it can.
  await page.getByRole('button', { name: 'Walk through' }).click();
  await expect(page.getByRole('button', { name: 'Leave walk' })).toBeVisible();
  await page.waitForTimeout(500);
  // (SwiftShader on a busy test machine draws it at about 5 frames a second; a phone at 60.)
  expect(await drawnIn(page, 3000)).toBeGreaterThan(6);
  await page.getByRole('button', { name: 'Leave walk' }).click();
  await expect(page.getByRole('button', { name: 'Walk through' })).toBeVisible();
  const spot = () =>
    page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null'), `dhd:walk:${id}`);
  await expect.poll(spot).toBeTruthy();
  const start: { x: number; y: number } = (await spot()).at;
  // Back in the orbit view, the doors stand open; the view rests again.
  await expect.poll(async () => (await doors()).every((d) => d.open === 1)).toBe(true);
  await rests(page);

  // The next walk starts a metre from the door nearest the last one's start, facing it.
  const all = await doors();
  const dist = (p: { x: number; y: number }) => Math.hypot(p.x - start.x, p.y - start.y);
  const near = all.sort((a, b) => dist(a.centre) - dist(b.centre))[0];
  if (!near) throw new Error('no inside door');
  const d = dist(near.centre);
  const at = {
    x: near.centre.x + ((start.x - near.centre.x) / d) * 1,
    y: near.centre.y + ((start.y - near.centre.y) / d) * 1,
  };
  const yaw = Math.atan2(near.centre.y - at.y, near.centre.x - at.x);
  await page.evaluate(([key, pose]) => localStorage.setItem(key, pose), [
    `dhd:walk:${id}`,
    JSON.stringify({ at, yaw, pitch: 0 }),
  ] as const);
  await page.getByRole('button', { name: 'Walk through' }).click();
  await expect(page.getByRole('button', { name: 'Leave walk' })).toBeVisible();
  // It swings open; the doors far off stay shut.
  await expect.poll(async () => (await doors()).find((x) => x.id === near.id)?.open).toBe(1);
  const far = (await doors()).filter((x) => Math.hypot(x.centre.x - at.x, x.centre.y - at.y) > 3);
  expect(far.length).toBeGreaterThan(0);
  for (const x of far) expect(x.open).toBe(0);
});
