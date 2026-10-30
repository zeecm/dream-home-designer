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
  const r = await page.locator('svg.plan-svg').boundingBox();
  if (!r) throw new Error('no plan');
  const at = (fx: number, fy: number) => ({ x: r.x + r.width * fx, y: r.y + r.height * fy });

  // Drag corner to corner: one wall. Then an exact length from the drawing bar, and Done.
  await touches(page, line(at(0.2, 0.45), at(0.6, 0.45)));
  await expect(walls).toHaveText('1');
  await page.getByLabel('Next wall length').fill('2000');
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
  const r = await page.locator('svg.plan-svg').boundingBox();
  if (!r) throw new Error('no plan');
  const at = (fx: number, fy: number) => ({ x: r.x + r.width * fx, y: r.y + r.height * fy });

  // Both ends by finger, then the second one dragged further along.
  await touches(page, line(at(0.2, 0.5), at(0.5, 0.5)));
  await expect(page.getByLabel('Set scale 2/2', { exact: false })).toBeVisible();
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
