import { type CDPSession, type Locator, type Page, devices, expect, test } from '@playwright/test';
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
    cdp,
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

/**
 * A tap by a second finger at `at` while the first (id 0) stays down at `held`. The browser
 * makes no click of it: the button has to answer the finger itself.
 */
async function secondFingerTap(cdp: CDPSession, held: Point, at: Point) {
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [
      { ...held, id: 0 },
      { ...at, id: 1 },
    ],
  });
  // The second lifts (a touchEnd lists the points lifted); the first stays where it is.
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [{ ...at, id: 1 }],
  });
}

test('on a phone: a photo-real render from the spot walked to, the walk standing still while its dialog is open', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await waitSaved(page);
  await page.getByRole('button', { name: 'Switch to 3D' }).tap();
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

  // ...until a second finger taps the camera: the render opens, the walk stands still, the
  // stick let go.
  await secondFingerTap(thumb.cdp, { x: walkStick.x, y: walkStick.y - 40 }, centre(r));
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

const apart = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;

// Phones on their side: an iPhone 13 (844 × 390), its Safari with the bars (750 × 342) and an
// iPhone SE (568 × 320).
for (const [width, height] of [
  [844, 390],
  [750, 342],
  [568, 320],
] as const)
  test.describe(`on a phone on its side, ${width} × ${height}`, () => {
    test.use({ viewport: { width, height } });

    test('the walk’s map, sticks, time and buttons keep clear of each other', async ({ page }) => {
      await page.goto('/');
      await waitSaved(page);
      await page.getByRole('button', { name: /^3D$/ }).tap();
      await page.getByRole('button', { name: 'Walk through' }).tap();
      await expect(page.getByRole('button', { name: 'Leave walk' })).toBeVisible();
      const parts = [
        page.locator('svg.minimap'),
        page.getByTestId('walk-stick'),
        page.getByTestId('look-stick'),
        page.locator('.sun-control'),
        page.getByRole('button', { name: 'Leave walk' }),
        page.getByRole('button', { name: /^Footsteps/ }),
        page.getByRole('button', { name: 'Photo-real render' }),
      ];
      const boxes = [];
      for (const p of parts) {
        await expect(p).toBeInViewport({ ratio: 1 });
        boxes.push(await box(p));
      }
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          expect(apart(boxes[i] as Box, boxes[j] as Box), `${parts[i]} and ${parts[j]}`).toBe(true);
        }
      }
      // A paid picture, not a screenshot: the camera says "Render".
      await expect(page.getByRole('button', { name: 'Photo-real render' })).toHaveText('Render');
    });

    test('the render dialog keeps its look and its picture model in sight', async ({ page }) => {
      await page.addInitScript(() => {
        window.sessionStorage.setItem(
          'dhd-ai',
          JSON.stringify({
            active: 'gemini',
            keys: {
              gemini: { key: 'AIza-x', model: 'gemini-3-pro', imageModel: 'gemini-3-pro-image' },
            },
          }),
        );
      });
      await page.goto('/');
      await waitSaved(page);
      await page.getByRole('button', { name: /^3D$/ }).tap();
      await page.getByRole('button', { name: 'Photo-real render' }).tap();
      const dialog = page.getByRole('dialog', { name: 'Photo-real render' });
      await expect(dialog.getByText('With Gemini (Google) (gemini-3-pro-image)')).toBeInViewport({
        ratio: 1,
      });
      await expect(dialog.getByLabel('Look')).toBeInViewport({ ratio: 1 });
      await expect(dialog.getByRole('button', { name: 'Render' })).toBeInViewport({ ratio: 1 });
    });
  });

type Box = { x: number; y: number; width: number; height: number };
