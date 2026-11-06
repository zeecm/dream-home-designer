import { type Locator, type Page, devices, expect, test } from '@playwright/test';
import { waitSaved } from './helpers';

// A phone (the iPhone's screen, touch and pixel ratio, in the Chromium the suite runs). No AI
// key: the test stops at the dialog and calls nothing outside.
const { defaultBrowserType: _webkit, ...iPhone } = devices['iPhone 13'];
test.use(iPhone);

type Point = { x: number; y: number };

async function box(l: Locator) {
  const b = await l.boundingBox();
  if (!b) throw new Error('not laid out');
  return b;
}

const centre = (b: { x: number; y: number; width: number; height: number }) => ({
  x: b.x + b.width / 2,
  y: b.y + b.height / 2,
});

/** A finger held on the screen: moved about, then lifted. */
async function finger(page: Page, at: Point) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ ...at, id: 0 }],
  });
  return {
    async moveTo(p: Point) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ ...p, id: 0 }],
      });
    },
    async lift() {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    },
  };
}

test('on a phone: a photo-real render from the spot walked to, the walk standing still while its dialog is open', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await waitSaved(page);
  await page.getByRole('button', { name: 'Show 3D view' }).tap();
  await page.getByRole('button', { name: 'Walk through' }).tap();
  await expect(page.getByRole('button', { name: 'Leave walk' })).toBeVisible();

  // The camera icon, a fingertip's size, clear of the sticks, the map and the buttons.
  const render = page.getByRole('button', { name: 'Photo-real render' });
  await expect(render).toBeVisible();
  await expect(render).toHaveAttribute('title', 'Photo-real render');
  const r = await box(render);
  expect(r.width).toBeGreaterThanOrEqual(44);
  expect(r.height).toBeGreaterThanOrEqual(44);
  const others = [
    page.getByTestId('walk-stick'),
    page.getByTestId('look-stick'),
    page.locator('svg.minimap'),
    page.getByRole('button', { name: 'Leave walk' }),
    page.getByRole('button', { name: /^Footsteps/ }),
  ];
  for (const o of others) {
    const b = await box(o);
    const apart =
      r.x + r.width <= b.x ||
      b.x + b.width <= r.x ||
      r.y + r.height <= b.y ||
      b.y + b.height <= r.y;
    expect(apart, `the render button overlaps ${o}`).toBe(true);
  }

  // Where the walker is and which way they face, as the mini-map shows it.
  const marker = page.locator('.minimap-view').locator('..');
  await expect(marker).toHaveAttribute('transform', /rotate/);
  const pose = () => marker.getAttribute('transform');
  const walkStick = centre(await box(page.getByTestId('walk-stick')));
  const lookStick = centre(await box(page.getByTestId('look-stick')));
  // Give the walk a moment to settle in (a slow run is still building the scene).
  await page.waitForTimeout(500);

  // A thumb holds the walk stick forward, and the walker moves...
  const thumb = await finger(page, walkStick);
  await thumb.moveTo({ x: walkStick.x, y: walkStick.y - 40 });
  const start = await pose();
  await expect.poll(pose, { timeout: 10_000 }).not.toBe(start);

  // ...until the render opens: then the walk stands still, the stick let go.
  await render.evaluate((b: HTMLButtonElement) => b.click());
  const dialog = page.getByRole('dialog', { name: 'Photo-real render' });
  await expect(dialog).toBeVisible();
  const held = await pose();
  await thumb.moveTo({ x: walkStick.x + 10, y: walkStick.y - 48 });
  await page.waitForTimeout(800);
  expect(await pose()).toBe(held);
  await thumb.lift();
  // The picture is taken of the walk's view (slowly, drawn in software at the phone's pixels).
  await expect(dialog.getByRole('img', { name: 'The 3D view' })).toBeVisible({ timeout: 60_000 });

  // Fresh touches on either stick do nothing while the dialog is open.
  for (const s of [walkStick, lookStick]) {
    const f = await finger(page, s);
    await f.moveTo({ x: s.x + 40, y: s.y - 30 });
    await page.waitForTimeout(600);
    await f.lift();
    expect(await pose()).toBe(held);
  }

  // Closed, the walk carries on from the same spot.
  await dialog.getByRole('button', { name: 'Close' }).tap();
  await expect(dialog).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(await pose()).toBe(held);
  const again = await finger(page, walkStick);
  await again.moveTo({ x: walkStick.x, y: walkStick.y - 40 });
  await expect.poll(pose, { timeout: 10_000 }).not.toBe(held);
  await again.lift();
  expect(errors).toEqual([]);
});
