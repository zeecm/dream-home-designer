import { type Page, devices, expect, test } from '@playwright/test';
import { waitSaved } from './helpers';

// Fingers only: taps, and drags and pinches as touch events. Nothing a phone can't send.
// The iPhone's screen, touch and pixel ratio, in the Chromium the suite runs.
const { defaultBrowserType: _webkit, ...iPhone } = devices['iPhone 13'];
test.use(iPhone);

async function touches(page: Page, frames: { x: number; y: number }[][]) {
  const cdp = await page.context().newCDPSession(page);
  const [first, ...rest] = frames;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: (first ?? []).map((p, id) => ({ ...p, id })),
  });
  for (const f of rest) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: f.map((p, id) => ({ ...p, id })),
    });
    await page.waitForTimeout(16); // about a frame between moves, as a finger moves
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(100);
}

/**
 * Where the plan is now, once it has stopped moving: the bars above it (drawing, getting
 * started) and the details panel below change its place and size as you go, and a slow run
 * lays them out late.
 */
async function planBox(page: Page) {
  const at = async () => {
    const box = await page.locator('svg.plan-svg').boundingBox();
    if (!box) throw new Error('no plan');
    return box;
  };
  let last = await at();
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(100);
    const now = await at();
    if (JSON.stringify(now) === JSON.stringify(last)) return now;
    last = now;
  }
  return last;
}

const line = (a: { x: number; y: number }, b: { x: number; y: number }, n = 10) =>
  Array.from({ length: n + 1 }, (_, i) => [
    { x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n },
  ]);

test('on a phone: the menu opens, walls and rooms draw by finger, pinch never draws', async ({
  page,
}) => {
  await page.goto('/');
  await waitSaved(page);
  // A web font landing mid-tap shifts the buttons under the finger.
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole('button', { name: 'Projects' }).tap();
  await page.getByRole('button', { name: 'New blank plan' }).tap();
  await expect(page.getByText('Start your plan')).toBeVisible();

  const walls = page.locator('.facts dd').first();
  await page.getByRole('button', { name: /^Wall/ }).tap();
  await expect(page.locator('.tool-panel')).toContainText('drag from corner to corner');
  let r = await planBox(page);
  const at = (fx: number, fy: number) => ({ x: r.x + r.width * fx, y: r.y + r.height * fy });

  // Drag corner to corner: one wall. Then an exact length from the drawing bar, and Done.
  r = await planBox(page); // bars above the plan change height as you go
  await touches(page, line(at(0.2, 0.45), at(0.6, 0.45)));
  await expect(walls).toHaveText('1');
  await page.getByLabel('Next wall length').fill('2000');
  // Tap once the bar has caught up with the typing (a slow run renders late).
  await expect(page.getByRole('button', { name: 'Add', exact: true })).not.toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await page.getByRole('button', { name: 'Add', exact: true }).tap();
  await expect(walls).toHaveText('2');
  // An exact length can turn the corner: the third wall goes down the screen, not on.
  await page.getByLabel('Next wall length').fill('1500');
  await page.getByRole('button', { name: /Right/ }).tap();
  await page.getByRole('button', { name: 'Add', exact: true }).tap();
  await expect(walls).toHaveText('3');
  const boxes = await page
    .locator('[data-hit^="wall:"]')
    .evaluateAll((els) =>
      els.map((e) => (e as SVGGraphicsElement).getBBox()).map((b) => b.height / b.width),
    );
  expect(boxes.filter((r) => r > 3)).toHaveLength(1);
  await page.getByRole('button', { name: 'Done' }).tap();
  await expect(page.getByRole('button', { name: 'Done' })).toHaveCount(0);

  // Two fingers zoom and pan; they never draw.
  r = await planBox(page); // bars above the plan change height as you go
  const c = at(0.5, 0.5);
  await touches(
    page,
    Array.from({ length: 8 }, (_, i) => [
      { x: c.x - 30 - i * 8, y: c.y },
      { x: c.x + 30 + i * 8, y: c.y },
    ]),
  );
  await expect(walls).toHaveText('3');

  // A room, dragged from corner to corner.
  await page.getByRole('button', { name: /^Room/ }).tap();
  r = await planBox(page); // bars above the plan change height as you go
  await touches(page, line(at(0.15, 0.6), at(0.45, 0.8)));
  await expect(walls).toHaveText('7');
});

test('on a phone: Set scale ends can be dragged to adjust them before typing the length', async ({
  page,
}) => {
  await page.goto('/');
  await waitSaved(page);
  // A web font landing mid-tap shifts the buttons under the finger.
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole('button', { name: 'Projects' }).tap();
  await page.getByRole('button', { name: 'New blank plan' }).tap();
  await page.getByRole('button', { name: 'HDB plan (PDF)' }).tap();
  await expect(page.locator('image.underlay')).toBeVisible({ timeout: 30_000 });
  let r = await planBox(page);
  const at = (fx: number, fy: number) => ({ x: r.x + r.width * fx, y: r.y + r.height * fy });

  // Both ends by finger, then the second one dragged further along.
  r = await planBox(page); // bars above the plan change height as you go
  await touches(page, line(at(0.2, 0.5), at(0.5, 0.5)));
  await expect(page.getByLabel('Set scale 2/2', { exact: false })).toBeVisible();
  r = await planBox(page); // bars above the plan change height as you go
  await touches(page, line(at(0.5, 0.5), at(0.7, 0.55)));
  const end = await page
    .locator('g.measure line')
    .evaluate((l) => [Number(l.getAttribute('x2')), Number(l.getAttribute('y2'))]);
  expect(end[0]).toBeCloseTo(r.width * 0.7, -1);
  expect(end[1]).toBeCloseTo(r.height * 0.55, -1);
  // Still the same scale line: the length field is still asking.
  await page.getByLabel('Set scale 2/2', { exact: false }).fill('3000');
  await page.locator('form.canvas-form').getByRole('button', { name: 'Set scale' }).tap();
  await expect(page.getByLabel('Set scale 2/2', { exact: false })).toHaveCount(0);
});

test('on a phone: a swipe looks around while standing still', async ({ page }) => {
  await page.goto('/');
  await waitSaved(page);
  await page.getByRole('button', { name: /^3D$/ }).tap();
  await page.getByRole('button', { name: 'Walk through' }).tap();
  const marker = page.locator('.minimap-view').locator('..');
  await expect(marker).toHaveAttribute('transform', /rotate/);
  const angle = async () =>
    Number((await marker.getAttribute('transform'))?.match(/rotate\(([-\d.e]+)\)/)?.[1]);
  const before = await angle();
  const box = await page.locator('canvas').boundingBox();
  if (!box) throw new Error('no 3D view');
  const y = box.y + box.height * 0.35;
  // A third of the screen's width, right to left: about 60 degrees, without moving.
  const from = { x: box.x + box.width * 0.8, y };
  const to = { x: box.x + box.width * 0.47, y };
  const spot = await marker.getAttribute('transform');
  // Give the walk a moment to settle in (a slow run is still building the scene).
  await page.waitForTimeout(500);
  await touches(page, line(from, to));
  // The mini-map follows once a frame, and software rendering draws slowly: wait for it.
  await expect
    .poll(async () => {
      const turned = Math.abs((await angle()) - before);
      return Math.min(turned, 360 - turned);
    })
    .toBeGreaterThan(45);
  expect((await marker.getAttribute('transform'))?.split('rotate')[0]).toBe(
    spot?.split('rotate')[0],
  );
});

/** A finger that goes down, moves and stays down until `lift` is called. */
async function finger(page: Page, from: { x: number; y: number }) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ ...from, id: 0 }],
  });
  return {
    async moveTo(to: { x: number; y: number }, steps = 8) {
      const at = { ...from };
      for (let i = 1; i <= steps; i++) {
        const p = { x: at.x + ((to.x - at.x) * i) / steps, y: at.y + ((to.y - at.y) * i) / steps };
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ ...p, id: 0 }],
        });
        await page.waitForTimeout(16);
      }
      from.x = to.x;
      from.y = to.y;
    },
    async lift() {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForTimeout(100);
    },
  };
}

test('on a phone: the first wall shows under the finger, and its ends can be dragged to adjust it', async ({
  page,
}) => {
  await page.goto('/');
  await waitSaved(page);
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole('button', { name: 'Projects' }).tap();
  await page.getByRole('button', { name: 'New blank plan' }).tap();
  await expect(page.getByText('Start your plan')).toBeVisible();
  await page.getByRole('button', { name: /^Wall/ }).tap();
  const walls = page.locator('.facts dd').first();

  // Mid-drag, before lifting: the wall is drawn under the finger with its length.
  let r = await planBox(page);
  const f = await finger(page, { x: r.x + r.width * 0.25, y: r.y + r.height * 0.55 });
  await f.moveTo({ x: r.x + r.width * 0.65, y: r.y + r.height * 0.55 });
  // (A level line has no height, so it counts as drawn, not as "visible".)
  await expect(page.locator('.ghost-wall')).toHaveCount(1);
  await expect(page.locator('.draw-overlay text.num').first()).toHaveText(/^\d+\.\d\d m$/);
  // A magnifier shows the point under the finger, above it, until it lifts.
  const loupe = page.getByTestId('loupe');
  await expect(loupe).toHaveCount(1);
  const lb = await loupe.locator('circle.loupe-ring').boundingBox();
  expect((lb?.y ?? 999) + (lb?.height ?? 0)).toBeLessThan(r.y + r.height * 0.55);
  await f.lift();
  await expect(loupe).toHaveCount(0);
  await expect(walls).toHaveText('1');

  // Its far end, dragged: the same wall gets longer, no new wall.
  r = await planBox(page);
  const handles = page.locator('.end-handle');
  await expect(handles).toHaveCount(2);
  const end = await handles.nth(1).boundingBox();
  if (!end) throw new Error('no end handle');
  const from = { x: end.x + end.width / 2, y: end.y + end.height / 2 };
  const g = await finger(page, from);
  await g.moveTo({ x: from.x + 60, y: from.y });
  await g.lift();
  await expect(walls).toHaveText('1');
  const moved = await handles.nth(1).boundingBox();
  expect((moved?.x ?? 0) - end.x).toBeGreaterThan(40);
  // The drawing bar's Undo takes the adjustment back (and the bar stays).
  await page.locator('.draw-bar').getByRole('button', { name: 'Undo', exact: true }).tap();
  await expect
    .poll(async () => (await handles.nth(1).boundingBox())?.x ?? 0)
    .toBeLessThan(end.x + 5);
  await expect(walls).toHaveText('1');

  await expect(page.locator('.draw-bar')).toBeVisible();

  // A tap on the far end carries on drawing from it: the next tap adds a wall from there.
  const far = await handles.nth(1).boundingBox();
  if (!far) throw new Error('no end handle');
  await page.touchscreen.tap(far.x + far.width / 2, far.y + far.height / 2);
  r = await planBox(page);
  await page.touchscreen.tap(far.x + far.width / 2, r.y + r.height * 0.85);
  await expect(walls).toHaveText('2');

  // A room previews mid-drag too.
  await page.getByRole('button', { name: 'Done' }).tap();
  await page.getByRole('button', { name: /^Room/ }).tap();
  r = await planBox(page);
  const h = await finger(page, { x: r.x + r.width * 0.2, y: r.y + r.height * 0.15 });
  await h.moveTo({ x: r.x + r.width * 0.5, y: r.y + r.height * 0.4 });
  await expect(page.locator('.ghost-room')).toBeVisible();
  await h.lift();
  await expect(walls).toHaveText('6');
});

test('on a phone: a placed piece resizes and turns by finger on its handles', async ({ page }) => {
  await page.goto('/');
  await waitSaved(page);
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole('button', { name: /^Furniture/ }).tap();
  await page
    .getByRole('button', { name: /^Coffee table/ })
    .first()
    .tap();
  const room = await page.locator('[data-hit="room:rm_living-and-dining"]').boundingBox();
  if (!room) throw new Error('no room');
  await page.touchscreen.tap(room.x + room.width * 0.5, room.y + room.height * 0.5);
  const items = page.locator('[data-hit^="item:"]');
  await expect(items).toHaveCount(1);
  const width = page.getByLabel('Width');
  const before = await width.inputValue();

  // A corner, dragged by finger: the size shows under the finger before it lifts, and the
  // piece is resized, not moved or added to.
  const corner = await page.locator('.size-handle').nth(2).boundingBox();
  if (!corner) throw new Error('no corner handle');
  const from = { x: corner.x + corner.width / 2, y: corner.y + corner.height / 2 };
  const f = await finger(page, from);
  await f.moveTo({ x: from.x + 40, y: from.y + 40 });
  await expect(page.locator('.handle-length')).toBeVisible();
  await f.lift();
  await expect(items).toHaveCount(1);
  await expect(width).not.toHaveValue(before);

  // The turn handle, dragged round to the right.
  const piece = await items.first().boundingBox();
  const t = await page.locator('.turn-handle').boundingBox();
  if (!piece || !t) throw new Error('no turn handle');
  const centre = { x: piece.x + piece.width / 2, y: piece.y + piece.height / 2 };
  const g = await finger(page, { x: t.x + t.width / 2, y: t.y + t.height / 2 });
  await g.moveTo({ x: centre.x + 90, y: centre.y });
  await g.lift();
  await expect(items).toHaveCount(1);
  const turned = await page.locator('.turn-handle').boundingBox();
  // Its handle now sits out to the right of the piece, level with its centre.
  if (!turned) throw new Error('no turn handle');
  expect(turned.x + turned.width / 2 - centre.x).toBeGreaterThan(25);
  expect(Math.abs(turned.y + turned.height / 2 - centre.y)).toBeLessThan(6);
});

test('on a phone: a small piece moves under the finger, however close its handles', async ({
  page,
}) => {
  await page.goto('/');
  await waitSaved(page);
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole('button', { name: /^Furniture/ }).tap();
  await page
    .getByRole('button', { name: /^Dining chair\b/ })
    .first()
    .tap();
  const room = await page.locator('[data-hit="room:rm_living-and-dining"]').boundingBox();
  if (!room) throw new Error('no room');
  await page.touchscreen.tap(room.x + room.width * 0.5, room.y + room.height * 0.5);
  const items = page.locator('[data-hit^="item:"]');
  await expect(items).toHaveCount(1);
  const a = await items.first().boundingBox();
  if (!a) throw new Error('no piece');
  const width = await page.getByLabel('Width').inputValue();
  const f = await finger(page, { x: a.x + a.width / 2, y: a.y + a.height / 2 });
  await f.moveTo({ x: a.x + a.width / 2 + 30, y: a.y + a.height / 2 + 20 });
  // Moving, not resizing: no size label under the finger.
  await expect(page.locator('.handle-length')).toHaveCount(0);
  await f.lift();
  const b = await items.first().boundingBox();
  expect((b?.x ?? 0) - a.x).toBeGreaterThan(20);
  await expect(page.getByLabel('Width')).toHaveValue(width);
  await expect(items).toHaveCount(1);
});

test('on a phone: a tapped wall drags sideways by finger; an untapped one pans', async ({
  page,
}) => {
  await page.goto('/');
  await waitSaved(page);
  await page.evaluate(() => document.fonts.ready);
  // The Main bedroom's outside wall on the left, moved outwards (nothing in the way).
  const wall = page.locator('[data-hit="wall:w_main-bedroom_outside-2"]').first();
  const box = async () => {
    const b = await wall.boundingBox();
    if (!b) throw new Error('no wall');
    return b;
  };
  // A drag from a wall not selected pans the whole plan (the wall moves on screen with it,
  // but no wall is selected and nothing changes).
  let b = await box();
  await touches(
    page,
    line(
      { x: b.x + b.width / 2, y: b.y + b.height / 2 },
      { x: b.x + b.width / 2 + 30, y: b.y + b.height / 2 },
      6,
    ),
  );
  await expect(page.getByRole('heading', { name: 'Wall' })).toHaveCount(0);

  // Tapped, then dragged: it moves, with the distance shown under the finger.
  b = await box();
  await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
  await expect(page.getByRole('heading', { name: 'Wall' })).toBeVisible();
  b = await box();
  const from = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  const f = await finger(page, from);
  await f.moveTo({ x: from.x - 30, y: from.y });
  await expect(page.locator('.wall-shift')).toBeVisible();
  await f.lift();
  const moved = await box();
  expect(b.x - moved.x).toBeGreaterThan(20);
});

test('on a phone: a tapped room moves by its handle; a drag elsewhere in it pans', async ({
  page,
}) => {
  await page.goto('/');
  await waitSaved(page);
  await page.evaluate(() => document.fonts.ready);
  const area = page.locator('[data-hit="room:rm_main-bedroom"]');
  let b = await area.boundingBox();
  if (!b) throw new Error('no room');
  await page.touchscreen.tap(b.x + b.width * 0.2, b.y + b.height * 0.8);
  await expect(page.getByRole('heading', { name: 'Room', exact: true })).toBeVisible();
  await planBox(page);
  const handle = page.locator('.room-move circle');
  await expect(handle).toBeVisible();
  b = await area.boundingBox();
  const h = await handle.boundingBox();
  if (!b || !h) throw new Error('no handle');
  const from = { x: h.x + h.width / 2, y: h.y + h.height / 2 };
  const f = await finger(page, from);
  await f.moveTo({ x: from.x - 25, y: from.y });
  await expect(page.locator('.handle-length')).toBeVisible();
  await f.lift();
  const moved = await area.boundingBox();
  expect(b.x - (moved?.x ?? 0)).toBeGreaterThan(10);
  // Still selected; a drag from elsewhere in the room pans the plan, moving nothing.
  await expect(page.getByRole('heading', { name: 'Room', exact: true })).toBeVisible();
  const room = await area.boundingBox();
  const handleNow = await handle.boundingBox();
  if (!room || !handleNow) throw new Error('lost the room');
  // The corner of the room furthest from its handle.
  const hc = { x: handleNow.x + handleNow.width / 2, y: handleNow.y + handleNow.height / 2 };
  const start = [0.25, 0.75]
    .flatMap((fx) =>
      [0.25, 0.75].map((fy) => ({ x: room.x + room.width * fx, y: room.y + room.height * fy })),
    )
    .sort((p, q) => Math.hypot(q.x - hc.x, q.y - hc.y) - Math.hypot(p.x - hc.x, p.y - hc.y))[0];
  if (!start) throw new Error('no spot');
  const g = await finger(page, start);
  await g.moveTo({ x: start.x + 30, y: start.y });
  await g.lift();
  const panned = await area.boundingBox();
  const handlePanned = await handle.boundingBox();
  // The room and its handle moved on screen together: a pan, not a move.
  expect((panned?.x ?? 0) - room.x).toBeGreaterThan(20);
  expect((handlePanned?.x ?? 0) - handleNow.x).toBeCloseTo((panned?.x ?? 0) - room.x, 0);
  await expect(page.locator('.handle-length')).toHaveCount(0);
});

test('on a phone: a wall move whose touch is cancelled is taken back', async ({ page }) => {
  await page.goto('/');
  await waitSaved(page);
  await page.evaluate(() => document.fonts.ready);
  const wall = page.locator('[data-hit="wall:w_bedroom_main-bedroom"]').first();
  let b = await wall.boundingBox();
  if (!b) throw new Error('no wall');
  await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
  b = await wall.boundingBox();
  if (!b) throw new Error('no wall');
  const cdp = await page.context().newCDPSession(page);
  const at = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ ...at, id: 0 }],
  });
  for (let i = 1; i <= 6; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: at.x + i * 6, y: at.y, id: 0 }],
    });
    await page.waitForTimeout(16);
  }
  await expect(page.locator('.wall-shift')).toBeVisible();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  await expect.poll(async () => (await wall.boundingBox())?.x ?? 0).toBeCloseTo(b.x, 0);
  await expect(page.locator('.wall-shift')).toHaveCount(0);
});

test('on a phone: the plan stays under a fast finger, coasts after a swipe, and pans on after a pinch', async ({
  page,
}) => {
  await page.goto('/');
  await waitSaved(page);
  await page.evaluate(() => document.fonts.ready);
  const r = await planBox(page);
  const wall = page.locator('[data-hit^="wall:"]').first();
  const x = async () => (await wall.boundingBox())?.x ?? 0;
  const cdp = await page.context().newCDPSession(page);
  const send = (type: 'touchStart' | 'touchMove' | 'touchEnd', pts: { x: number; y: number }[]) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: pts.map((p, id) => ({ ...p, id })),
    });

  // A fast drag, every move sent at once (faster than the page redraws): mid-drag, the plan
  // has moved exactly as far as the finger.
  const from = { x: r.x + r.width * 0.3, y: r.y + r.height * 0.75 };
  const x0 = await x();
  await send('touchStart', [from]);
  for (let i = 1; i <= 12; i++) await send('touchMove', [{ x: from.x + i * 10, y: from.y }]);
  await expect.poll(x).toBeCloseTo(x0 + 120, 0);
  // Held still, then lifted: it stays where the finger left it.
  await page.waitForTimeout(150);
  await send('touchEnd', []);
  await page.waitForTimeout(300);
  expect(await x()).toBeCloseTo(x0 + 120, 0);
  // Let go while moving (a swipe): it carries on further, then stops.
  // (Leftwards: the plan is already well right of centre, and a coast stops before the
  // plan's middle leaves the screen.)
  const x1 = await x();
  await send('touchStart', [from]);
  for (let i = 1; i <= 6; i++) {
    await send('touchMove', [{ x: from.x - i * 12, y: from.y }]);
    await page.waitForTimeout(8);
  }
  await send('touchEnd', []);
  await expect.poll(x).toBeLessThan(x1 - 72 - 20);
  await page.waitForTimeout(1500);
  const settled = await x();
  await page.waitForTimeout(300);
  expect(await x()).toBeCloseTo(settled, 0);

  // Two fingers, then one lifts: the other moves the plan on.
  const a = { x: r.x + r.width * 0.4, y: r.y + r.height * 0.5 };
  const b = { x: r.x + r.width * 0.6, y: r.y + r.height * 0.5 };
  await page.evaluate(() => {
    const w = window as unknown as { second?: number };
    document.querySelector('svg.plan-svg')?.addEventListener('pointerdown', (e) => {
      if (!(e as PointerEvent).isPrimary) w.second = (e as PointerEvent).pointerId;
    });
  });
  await send('touchStart', [a, b]);
  await send('touchMove', [
    { x: a.x - 5, y: a.y },
    { x: b.x + 5, y: b.y },
  ]);
  // The second finger lifts (CDP can't lift one finger of two, so the page is told so).
  await page.evaluate(
    ({ x, y }) => {
      const id = (window as unknown as { second?: number }).second;
      document.querySelector('svg.plan-svg')?.dispatchEvent(
        new PointerEvent('pointerup', {
          pointerId: id,
          pointerType: 'touch',
          isPrimary: false,
          clientX: x,
          clientY: y,
          bubbles: true,
        }),
      );
    },
    { x: b.x + 5, y: b.y },
  );
  const before = await x();
  for (let i = 1; i <= 6; i++) {
    await send('touchMove', [{ x: a.x - 5 - i * 8, y: a.y }]);
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(100);
  await send('touchEnd', []);
  expect(before - (await x())).toBeGreaterThan(30);

  // A swipe, then a tap while the plan coasts: the tap only stops it (selects nothing).
  await send('touchStart', [from]);
  for (let i = 1; i <= 6; i++) {
    await send('touchMove', [{ x: from.x + i * 14, y: from.y }]);
    await page.waitForTimeout(8);
  }
  await send('touchEnd', []);
  await page.waitForTimeout(60);
  await send('touchStart', [from]);
  await send('touchEnd', []);
  const stopped = await x();
  await page.waitForTimeout(400);
  expect(await x()).toBeCloseTo(stopped, 0);
  await expect(page.getByRole('heading', { name: 'Room', exact: true })).toHaveCount(0);
});
