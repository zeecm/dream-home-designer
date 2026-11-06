import { type Page, devices, expect, test } from '@playwright/test';
import { waitSaved } from './helpers';

/**
 * Aircon trunking run as a fitter runs it: every leg square to the walls, hugging them; a
 * preview of the next leg with its length; "Route along the walls" out to the ledge in one
 * undo step; "Straighten" for a crooked run.
 */

async function roomBox(page: Page, id: string) {
  const box = await page.locator(`[data-hit="room:${id}"]`).boundingBox();
  if (!box) throw new Error(`no room ${id}`);
  return box;
}

/** The trunking on the plan, in plan metres. */
async function trunk(page: Page) {
  const pts = (await page.locator('.elec-trunk').first().getAttribute('points')) ?? '';
  return pts
    .trim()
    .split(/\s+/)
    .map((s) => {
      const [x, y] = s.split(',').map(Number);
      return { x: x as number, y: y as number };
    });
}

/** Every leg along x or along y, within a millimetre. */
function expectSquare(path: { x: number; y: number }[]) {
  expect(path.length).toBeGreaterThanOrEqual(2);
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as { x: number; y: number };
    const b = path[i] as { x: number; y: number };
    const dx = Math.abs(b.x - a.x);
    const dy = Math.abs(b.y - a.y);
    expect(Math.min(dx, dy), `leg ${i}: ${JSON.stringify([a, b])}`).toBeLessThan(0.001);
  }
}

async function clickAt(page: Page, x: number, y: number) {
  await page.mouse.move(x, y, { steps: 2 });
  await page.mouse.click(x, y);
}

test.describe('desktop', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitSaved(page);
    await page.keyboard.press('1');
  });

  test('taps make square legs with a preview; along the walls; undo; straighten', async ({
    page,
  }) => {
    await page.getByRole('button', { name: /^Electrical/ }).click();
    await page
      .locator('.palette .elec-kind-list')
      .getByRole('button', { name: /^Aircon/ })
      .click();
    const r = await roomBox(page, 'rm_main-bedroom');
    await clickAt(page, r.x + r.width * 0.5, r.y + 8);
    const bar = page.getByTestId('trunking-bar');
    await expect(bar).toBeVisible();
    // Off the square on purpose: each tap still lands square to the walls.
    await page.mouse.move(r.x + r.width * 0.56, r.y + r.height * 0.55, { steps: 3 });
    const preview = page.getByTestId('trunk-preview');
    await expect(preview).toBeVisible();
    await expect(preview.locator('text')).toHaveText(/\d+\.\d{2} m/);
    await page.mouse.click(r.x + r.width * 0.56, r.y + r.height * 0.55);
    await clickAt(page, r.x + r.width * 0.2, r.y + r.height * 0.6);
    const ledge = await roomBox(page, 'rm_air-con-ledge');
    await page.mouse.move(ledge.x + ledge.width * 0.4, ledge.y + ledge.height * 0.6, { steps: 3 });
    // Onto the ledge: the preview shows the corner into it.
    await expect(preview.locator('polyline')).toBeVisible();
    await page.mouse.click(ledge.x + ledge.width * 0.4, ledge.y + ledge.height * 0.6);
    await expect(bar).toHaveCount(0);
    await expect(page.locator('.elec-trunk')).toHaveCount(1);
    const tapped = await trunk(page);
    expectSquare(tapped);

    // Along the walls, in the Inspector: square, out to the ledge's compressor.
    await page.getByRole('button', { name: 'Route along the walls' }).click();
    await expect
      .poll(async () => JSON.stringify(await trunk(page)))
      .not.toBe(JSON.stringify(tapped));
    const routed = await trunk(page);
    expectSquare(routed);
    expect(routed.at(-1)).toEqual(tapped.at(-1));
    await expect(page.getByRole('button', { name: 'Straighten' })).toBeDisabled();
    // One undo brings the tapped run back.
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(async () => JSON.stringify(await trunk(page))).toBe(JSON.stringify(tapped));

    // A crooked run (Alt frees the angle), straightened.
    await page.getByRole('button', { name: 'Run the trunking again' }).click();
    await expect(bar).toBeVisible();
    await page.keyboard.down('Alt');
    await clickAt(page, r.x + r.width * 0.3, r.y + r.height * 0.7);
    await page.keyboard.up('Alt');
    await clickAt(page, ledge.x + ledge.width * 0.5, ledge.y + ledge.height * 0.5);
    await expect(bar).toHaveCount(0);
    const crooked = await trunk(page);
    expect(() => expectSquare(crooked)).toThrow();
    await page.getByRole('button', { name: 'Straighten' }).click();
    await expect
      .poll(async () => JSON.stringify(await trunk(page)))
      .not.toBe(JSON.stringify(crooked));
    expectSquare(await trunk(page));
    await expect(page.getByRole('button', { name: 'Straighten' })).toBeDisabled();

    // The estimate's trunking is the Inspector's, which is the path's.
    const metres = Number.parseFloat(
      (await page.getByTestId('trunking-length').textContent()) ?? '',
    );
    const path = await trunk(page);
    let len = 0;
    for (let i = 1; i < path.length; i++)
      len += Math.hypot(
        (path[i]?.x ?? 0) - (path[i - 1]?.x ?? 0),
        (path[i]?.y ?? 0) - (path[i - 1]?.y ?? 0),
      );
    expect(metres).toBeCloseTo(Math.round(len * 10) / 10, 5);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.locator('.cost-summary').getByRole('button', { name: 'See estimate' }).click();
    const line = page
      .getByRole('dialog', { name: 'Cost estimate' })
      .locator('.estimate-line', { hasText: 'Aircon trunking' });
    const qty = Number.parseFloat((await line.locator('.estimate-qty').textContent()) ?? '');
    expect(qty).toBeCloseTo(metres, 5);
  });
});

// Fingers only, on a 390 px phone.
const { defaultBrowserType: _webkit, ...iPhone } = devices['iPhone 13'];

test.describe('phone', () => {
  test.use(iPhone);

  async function tap(page: Page, at: { x: number; y: number }) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ ...at, id: 0 }],
    });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(200);
  }

  test('taps make square legs; the bar stays one compact row; along the walls; undo', async ({
    page,
  }) => {
    await page.goto('/');
    await waitSaved(page);
    await page.evaluate(() => document.fonts.ready);
    await page.getByRole('button', { name: /^Electrical/ }).tap();
    await page
      .locator('.tool-panel .elec-kind-list')
      .getByRole('button', { name: /^Aircon/ })
      .tap();
    await page.waitForTimeout(300);
    const r = await roomBox(page, 'rm_main-bedroom');
    await tap(page, { x: r.x + r.width * 0.5, y: r.y + 3 });
    const bar = page.getByTestId('trunking-bar');
    await expect(bar).toBeVisible();
    await page.waitForTimeout(300);
    const plan = await page.locator('svg.plan-svg').boundingBox();
    const bb = await bar.boundingBox();
    if (!plan || !bb) throw new Error('no plan or bar');
    // At the top, short, every button on one row inside the bar.
    expect(bb.y - plan.y).toBeLessThan(20);
    expect(bb.height).toBeLessThan(100);
    const buttons = bar.getByRole('button');
    await expect(buttons).toHaveCount(4);
    const tops = new Set<number>();
    for (const b of await buttons.all()) {
      const box = await b.boundingBox();
      if (!box) throw new Error('no button');
      tops.add(Math.round(box.y));
      expect(box.x).toBeGreaterThanOrEqual(bb.x);
      expect(box.x + box.width).toBeLessThanOrEqual(bb.x + bb.width + 0.5);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    expect(tops.size).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );

    const b = await roomBox(page, 'rm_main-bedroom');
    await tap(page, { x: b.x + b.width * 0.55, y: b.y + b.height * 0.55 });
    await tap(page, { x: b.x + b.width * 0.15, y: b.y + b.height * 0.62 });
    const l = await roomBox(page, 'rm_air-con-ledge');
    await tap(page, { x: l.x + l.width * 0.5, y: l.y + l.height * 0.5 });
    await expect(bar).toHaveCount(0);
    const tapped = await trunk(page);
    expectSquare(tapped);

    await page.getByRole('button', { name: 'Route along the walls' }).tap();
    await expect
      .poll(async () => JSON.stringify(await trunk(page)))
      .not.toBe(JSON.stringify(tapped));
    expectSquare(await trunk(page));
    await page.getByRole('button', { name: 'Undo', exact: true }).tap();
    await expect.poll(async () => JSON.stringify(await trunk(page))).toBe(JSON.stringify(tapped));
  });

  test('"Route along the walls" in the bar ends the run on the ledge, square', async ({ page }) => {
    await page.goto('/');
    await waitSaved(page);
    await page.getByRole('button', { name: /^Electrical/ }).tap();
    await page
      .locator('.tool-panel .elec-kind-list')
      .getByRole('button', { name: /^Aircon/ })
      .tap();
    await page.waitForTimeout(300);
    const r = await roomBox(page, 'rm_main-bedroom');
    await tap(page, { x: r.x + r.width * 0.5, y: r.y + 3 });
    const bar = page.getByTestId('trunking-bar');
    await bar.getByRole('button', { name: 'Route along the walls' }).tap();
    await expect(bar).toHaveCount(0);
    await expect(
      page.locator('[data-testid="electrical-layer"] [data-kind="compressor"]'),
    ).toHaveCount(1);
    expectSquare(await trunk(page));
    await expect(page.locator('.elec-warnings')).toHaveCount(0);
  });
});
