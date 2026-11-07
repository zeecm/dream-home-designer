import { type Page, devices, expect, test } from '@playwright/test';
import { waitSaved } from './helpers';

/** The sample's room on the plan (screen box). */
async function roomBox(page: Page, id: string) {
  const box = await page.locator(`[data-hit="room:${id}"]`).boundingBox();
  if (!box) throw new Error(`no room ${id}`);
  return box;
}

/** Picks the Electrical tool and a kind in its palette. */
async function pick(page: Page, kind: RegExp) {
  if (
    (await page.getByRole('button', { name: /^Electrical/ }).getAttribute('aria-pressed')) !==
    'true'
  )
    await page.getByRole('button', { name: /^Electrical/ }).click();
  await page.locator('.palette .elec-kind-list').getByRole('button', { name: kind }).click();
}

async function clickAt(page: Page, x: number, y: number) {
  await page.mouse.move(x, y, { steps: 2 });
  await page.mouse.click(x, y);
}

const points = (page: Page) =>
  page.locator('[data-testid="electrical-layer"] [data-hit^="point:"]');
const pointId = async (page: Page, i = 0) =>
  ((await points(page).nth(i).getAttribute('data-hit')) ?? '').slice('point:'.length);

async function openEstimate(page: Page) {
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.locator('.cost-summary').getByRole('button', { name: 'See estimate' }).click();
  return page.getByRole('dialog', { name: 'Cost estimate' });
}

test.describe('desktop', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitSaved(page);
    await page.keyboard.press('1');
  });

  test('11: a socket on a bedroom wall at 300 mm; 1150 shows h1150; undo; a reload keeps it', async ({
    page,
  }) => {
    const r = await roomBox(page, 'rm_bedroom');
    await pick(page, /^Double socket/);
    await clickAt(page, r.x + r.width * 0.75, r.y + r.height - 6);
    await expect(points(page)).toHaveCount(1);
    await expect(page.getByRole('heading', { name: '13A double socket' })).toBeVisible();
    const height = page.getByRole('textbox', { name: 'Height' });
    await expect(height).toHaveValue('300 mm');
    await expect(height).toHaveAttribute('inputmode', 'decimal');
    await expect(page.locator('.elec-height')).toHaveCount(0);
    await expect(page.locator('.point-facts')).toContainText('Bedroom');

    await height.fill('1150');
    await height.press('Enter');
    await expect(page.locator('.elec-height')).toHaveText('h1150');
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.locator('.elec-height')).toHaveCount(0);
    await expect(height).toHaveValue('300 mm');
    await page.getByRole('button', { name: 'Redo' }).click();
    await expect(page.locator('.elec-height')).toHaveText('h1150');

    await waitSaved(page);
    await page.reload();
    await waitSaved(page);
    await expect(points(page)).toHaveCount(1);
    await expect(page.locator('.elec-height')).toHaveText('h1150');
  });

  test('12: a light point draws a circle and cross; the socket is in the 3D model', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const r = await roomBox(page, 'rm_bedroom');
    await pick(page, /^Double socket/);
    await clickAt(page, r.x + r.width * 0.75, r.y + r.height - 6);
    const socket = await pointId(page);
    await pick(page, /^Light/);
    await clickAt(page, r.x + r.width * 0.5, r.y + r.height * 0.4);
    const light = page.locator('[data-testid="electrical-layer"] [data-kind="light"]');
    await expect(light).toHaveCount(1);
    await expect(light.locator('circle:not(.elec-hit):not(.elec-ring)')).toHaveCount(1);
    await expect(light.locator('path')).toHaveCount(2);
    await expect(page.locator('.point-facts')).toContainText('Bedroom');

    // The 3D model (as downloaded) has the socket's faceplate, and no light point.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Projects' }).click();
    const [file] = await Promise.all([
      page.waitForEvent('download', { timeout: 60_000 }),
      page.getByRole('button', { name: '3D model (GLB)', exact: true }).click(),
    ]);
    const bytes = Buffer.concat((await (await file.createReadStream()).toArray()) as Buffer[]);
    const jsonLength = bytes.readUInt32LE(12);
    const json = bytes.subarray(20, 20 + jsonLength).toString();
    expect(json).toContain(`"name":"point:${socket}"`);
    const lightId = (await light.getAttribute('data-hit'))?.slice('point:'.length);
    expect(json).not.toContain(`point:${lightId}`);
  });

  test('13: switched off, the symbols leave the plan and its picture, and stay off', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const r = await roomBox(page, 'rm_bedroom');
    await pick(page, /^Double socket/);
    await clickAt(page, r.x + r.width * 0.75, r.y + r.height - 6);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /^Select/ }).click();
    await page.keyboard.press('Escape');
    const png = async () => {
      await page.getByRole('button', { name: 'Projects' }).click();
      const [file] = await Promise.all([
        page.waitForEvent('download', { timeout: 60_000 }),
        page.getByRole('button', { name: 'Plan as a picture (PNG)', exact: true }).click(),
      ]);
      return Buffer.concat((await (await file.createReadStream()).toArray()) as Buffer[]);
    };
    // The picture is drawn from the plan as shown: with the symbols, then without.
    const on = await png();
    const toggle = page.getByLabel('Electrical', { exact: true });
    await expect(toggle).toBeChecked();
    await toggle.uncheck();
    await expect(page.getByTestId('electrical-layer')).toHaveCount(0);
    const off = await png();
    expect(off.equals(on)).toBe(false);

    await waitSaved(page);
    await page.reload();
    await waitSaved(page);
    await expect(page.getByLabel('Electrical', { exact: true })).not.toBeChecked();
    await expect(page.getByTestId('electrical-layer')).toHaveCount(0);
    // Picking the tool shows them again.
    await page.getByRole('button', { name: /^Electrical/ }).click();
    await expect(points(page)).toHaveCount(1);
  });

  test('14: an aircon unit run through two bends to a new compressor: its length is the estimate’s', async ({
    page,
  }) => {
    const r = await roomBox(page, 'rm_bedroom');
    await pick(page, /^Aircon/);
    await clickAt(page, r.x + r.width * 0.8, r.y + 8);
    const bar = page.getByTestId('trunking-bar');
    await expect(bar).toBeVisible();
    await clickAt(page, r.x + r.width * 0.8, r.y + r.height * 0.45);
    await clickAt(page, r.x + r.width * 0.3, r.y + r.height * 0.45);
    await clickAt(page, r.x + r.width * 0.3, r.y + r.height * 0.7);
    await bar.getByRole('button', { name: 'Compressor here' }).click();
    await expect(bar).toHaveCount(0);
    await expect(
      page.locator('[data-testid="electrical-layer"] [data-kind="compressor"]'),
    ).toHaveCount(1);
    await expect(page.locator('.elec-trunk')).toHaveCount(1);
    const shown = await page.getByTestId('trunking-length').textContent();
    const metres = Number.parseFloat(shown ?? '');
    expect(metres).toBeGreaterThan(1);
    // No warning once it has a compressor.
    await expect(page.locator('.elec-warnings')).toHaveCount(0);

    const dialog = await openEstimate(page);
    const line = dialog.locator('.estimate-line', { hasText: 'Aircon trunking' });
    await expect(line).toHaveCount(1);
    const qty = Number.parseFloat((await line.locator('.estimate-qty').textContent()) ?? '');
    expect(qty).toBeCloseTo(metres, 5);
    await expect(
      dialog.locator('.estimate-line', { hasText: 'Aircon point (isolator), new' }),
    ).toContainText('$150–250');
    await expect(dialog).toContainText('only the electrical points that change');
  });

  test('15: a socket in a bathroom warns on the plan and in its details', async ({ page }) => {
    const r = await roomBox(page, 'rm_bath-wc-1');
    await pick(page, /^Single socket/);
    await clickAt(page, r.x + 6, r.y + r.height * 0.5);
    await expect(points(page)).toHaveCount(1);
    await expect(page.getByTestId('elec-warning')).toHaveCount(1);
    await expect(page.locator('.elec-warnings')).toContainText('A socket in a bathroom or WC');
  });

  test('16: a renovation moving a socket: a relocate line, teal on the electrical page, legend counts', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.addInitScript(() => {
      window.print = () => {};
    });
    await page.evaluate(() => {
      window.print = () => {};
    });
    const r = await roomBox(page, 'rm_bedroom');
    await pick(page, /^Double socket/);
    await clickAt(page, r.x + r.width * 0.55, r.y + r.height - 6);
    await clickAt(page, r.x + r.width * 0.9, r.y + r.height - 6);
    await expect(points(page)).toHaveCount(2);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Plan a renovation' }).click();
    await expect(page.locator('.reno-bar').getByRole('button', { name: 'After' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(points(page)).toHaveCount(2);

    // In After, the first socket dragged along its wall, about a metre.
    await page.getByRole('button', { name: /^Select/ }).click();
    const first = points(page).first();
    const b = await first.boundingBox();
    if (!b) throw new Error('no socket');
    const zoom = await page.evaluate(() => {
      const s = document.querySelector('[data-testid="electrical-layer"]') as SVGGraphicsElement;
      return s.getScreenCTM()?.a ?? 50;
    });
    const from = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x - zoom * 0.5, from.y, { steps: 5 });
    await page.mouse.move(from.x - zoom, from.y, { steps: 5 });
    await page.mouse.up();

    const dialog = await openEstimate(page);
    await expect(
      dialog.locator('.estimate-line', { hasText: '13A double socket, relocate' }),
    ).toContainText('$60–120');
    await expect(
      dialog.locator('.estimate-line', { hasText: '13A double socket, new' }),
    ).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Close' }).click();

    await page.getByRole('button', { name: 'Projects' }).click();
    await page.getByRole('button', { name: 'Plan for contractors (PDF)' }).click();
    const cd = page.getByRole('dialog', { name: 'Plan for contractors' });
    await expect(cd.getByLabel('Electrical plan')).toBeChecked();
    await cd.getByRole('button', { name: 'Print or save as PDF' }).click();
    await expect(cd).toBeHidden();
    const sheet = page.frameLocator('iframe[data-print="contractor"]');
    const elec = sheet.locator('.electrical-page');
    await expect(elec).toHaveCount(1);
    // Depths of notches are page 1's only.
    await expect(elec.locator('.dim-notch')).toHaveCount(0);
    const moved = elec.locator('.elec-mark[data-change="moved"]');
    await expect(moved).toHaveCount(1);
    await expect(moved.locator('g[stroke="#0f8288"]')).toHaveCount(1);
    // Where it was, faint; the other socket as it was, in ink.
    await expect(elec.locator('.elec-mark[data-change="was"]')).toHaveCount(1);
    await expect(elec.locator('.elec-mark[data-change="same"] g[stroke="#1b1e22"]')).toHaveCount(1);
    const key = sheet.locator('.legend-key[data-key="elec-socket-double"]');
    await expect(key).toHaveAttribute('data-count', '2');
    await expect(key).toContainText('×2');
    await expect(sheet.locator('.schedule-row[data-kind="socket-double"]')).toHaveCount(2);
    await expect(sheet.locator('text.sheet-lew')).toHaveText(
      'Work by a Licensed Electrical Worker.',
    );
  });

  test('a tap on the aircon ledge ends the run there on a new compressor; made a switch, the unit takes its compressor and trunking', async ({
    page,
  }) => {
    const r = await roomBox(page, 'rm_main-bedroom');
    await pick(page, /^Aircon/);
    await clickAt(page, r.x + r.width * 0.5, r.y + 8);
    const bar = page.getByTestId('trunking-bar');
    await expect(bar).toBeVisible();
    await clickAt(page, r.x + r.width * 0.5, r.y + r.height * 0.6);
    const ledge = await roomBox(page, 'rm_air-con-ledge');
    await clickAt(page, ledge.x + ledge.width * 0.5, ledge.y + ledge.height * 0.5);
    await expect(bar).toHaveCount(0);
    const comp = page.locator('[data-testid="electrical-layer"] [data-kind="compressor"]');
    await expect(comp).toHaveCount(1);
    const cb = await comp.locator('.elec-hit').boundingBox();
    if (!cb) throw new Error('no compressor');
    const mid = { x: cb.x + cb.width / 2, y: cb.y + cb.height / 2 };
    expect(mid.x).toBeGreaterThan(ledge.x);
    expect(mid.x).toBeLessThan(ledge.x + ledge.width);
    expect(mid.y).toBeGreaterThan(ledge.y);
    expect(mid.y).toBeLessThan(ledge.y + ledge.height);
    await expect(page.locator('.elec-trunk')).toHaveCount(1);
    // The unit selected, nothing to warn of: it runs to a compressor on the ledge.
    await expect(page.getByTestId('trunking-length')).toBeVisible();
    await expect(page.locator('.elec-warnings')).toHaveCount(0);

    // Made a switch: placed again at a switch's height, its compressor and trunking gone.
    await page.getByLabel('Kind').selectOption({ label: 'Switch' });
    await expect(page.getByRole('textbox', { name: 'Height' })).toHaveValue('1050 mm');
    await expect(comp).toHaveCount(0);
    await expect(page.locator('.elec-trunk')).toHaveCount(0);
    await expect(points(page)).toHaveCount(1);
    // One undo brings all of it back.
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(comp).toHaveCount(1);
    await expect(page.locator('.elec-trunk')).toHaveCount(1);
  });

  test('a renovation’s new socket shows in its bar and its changes, room by room', async ({
    page,
  }) => {
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Plan a renovation' }).click();
    const barText = page.locator('.reno-bar');
    await expect(barText).toContainText('No changes yet');
    const r = await roomBox(page, 'rm_bedroom');
    await pick(page, /^Double socket/);
    await clickAt(page, r.x + r.width * 0.75, r.y + r.height - 6);
    await expect(points(page)).toHaveCount(1);
    await expect(barText).toContainText('Electrical: 1 new');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    const list = page.locator('.reno-changes');
    await expect(list).toContainText('Bedroom');
    await expect(list).toContainText('New 13A double socket');
  });

  test('17: a view link shows the symbols, without the tool', async ({ page, browser }) => {
    const r = await roomBox(page, 'rm_bedroom');
    await pick(page, /^Double socket/);
    await clickAt(page, r.x + r.width * 0.75, r.y + r.height - 6);
    await waitSaved(page);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Share' }).click();
    const viewLink = await page.getByLabel('View-only link').inputValue();
    await page.keyboard.press('Escape');

    const viewer = await (await browser.newContext()).newPage();
    await viewer.goto(viewLink);
    await expect(viewer.getByText('View only.')).toBeVisible();
    await viewer.keyboard.press('1');
    await expect(points(viewer)).toHaveCount(1);
    // A view link gets Select and Comment only.
    await expect(viewer.getByRole('button', { name: /^Electrical/ })).toHaveCount(0);
    await viewer.keyboard.press('e');
    await expect(viewer.locator('.elec-kind-list')).toHaveCount(0);
  });
});

// Fingers only, on a phone.
const { defaultBrowserType: _webkit, ...iPhone } = devices['iPhone 13'];

test.describe('phone', () => {
  test.use(iPhone);

  async function touches(
    page: Page,
    frames: { x: number; y: number }[],
    mid?: () => Promise<void>,
  ) {
    const cdp = await page.context().newCDPSession(page);
    const [first, ...rest] = frames;
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ ...(first ?? { x: 0, y: 0 }), id: 0 }],
    });
    for (const f of rest) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ ...f, id: 0 }],
      });
      await page.waitForTimeout(16);
    }
    await mid?.();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(150);
  }
  const line = (a: { x: number; y: number }, b: { x: number; y: number }, n = 10) =>
    Array.from({ length: n + 1 }, (_, i) => ({
      x: a.x + ((b.x - a.x) * i) / n,
      y: a.y + ((b.y - a.y) * i) / n,
    }));

  test('trunking by finger: the bar sits over the top of the plan, the ledge in sight below it; a tap there ends the run', async ({
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
    const r = await roomBox(page, 'rm_bedroom');
    const wall = { x: r.x + r.width * 0.5, y: r.y + 3 };
    await touches(page, line({ x: wall.x, y: wall.y + 30 }, wall));
    const bar = page.getByTestId('trunking-bar');
    await expect(bar).toBeVisible();
    await page.waitForTimeout(300);
    const plan = await page.locator('svg.plan-svg').boundingBox();
    const bb = await bar.boundingBox();
    if (!plan || !bb) throw new Error('no plan or bar');
    // At the top, and short.
    expect(bb.y - plan.y).toBeLessThan(20);
    expect(bb.height).toBeLessThan(100);
    // The ledge in sight, below the bar.
    const ledge = await roomBox(page, 'rm_air-con-ledge');
    expect(ledge.y).toBeGreaterThan(bb.y + bb.height);
    expect(ledge.y + ledge.height).toBeLessThan(plan.y + plan.height);
    const b = await roomBox(page, 'rm_bedroom');
    await touches(page, [{ x: b.x + b.width * 0.5, y: b.y + b.height * 0.6 }]);
    const l = await roomBox(page, 'rm_air-con-ledge');
    await touches(page, [{ x: l.x + l.width * 0.5, y: l.y + l.height * 0.5 }]);
    await expect(bar).toHaveCount(0);
    await expect(
      page.locator('[data-testid="electrical-layer"] [data-kind="compressor"]'),
    ).toHaveCount(1);
    await expect(page.locator('.elec-warnings')).toHaveCount(0);
  });

  test('18: placed by finger with the magnifier, dragged along its wall, a decimal keypad, no sideways scroll', async ({
    page,
  }) => {
    await page.goto('/');
    await waitSaved(page);
    await page.evaluate(() => document.fonts.ready);
    await page.getByRole('button', { name: /^Electrical/ }).tap();
    await page
      .locator('.tool-panel .elec-kind-list')
      .getByRole('button', { name: /^Double socket/ })
      .tap();
    await page.waitForTimeout(300);
    const r = await roomBox(page, 'rm_bedroom');
    const wall = { x: r.x + r.width * 0.75, y: r.y + r.height - 3 };
    // The finger slides up to the wall; the magnifier shows where it will go.
    await touches(page, line({ x: wall.x, y: wall.y - 40 }, wall), async () => {
      await expect(page.getByTestId('loupe')).toBeVisible();
    });
    await expect(points(page)).toHaveCount(1);
    await expect(page.getByTestId('loupe')).toHaveCount(0);
    const height = page.getByRole('textbox', { name: 'Height' });
    await expect(height).toHaveValue('300 mm');
    await expect(height).toHaveAttribute('inputmode', 'decimal');
    const t0 = await page.evaluate(() => {
      const g = document.querySelector('[data-hit^="point:"] .elec-hit') as SVGCircleElement;
      return g.getBoundingClientRect().x;
    });

    // Dragged by finger along its wall.
    const b = await points(page).first().boundingBox();
    if (!b) throw new Error('no point');
    const c = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    await touches(page, line(c, { x: c.x - 30, y: c.y }));
    const t1 = await page.evaluate(() => {
      const g = document.querySelector('[data-hit^="point:"] .elec-hit') as SVGCircleElement;
      return g.getBoundingClientRect().x;
    });
    expect(t0 - t1).toBeGreaterThan(15);
    await expect(points(page)).toHaveCount(1);

    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(390);
    // The kinds scroll sideways in one row.
    const row = page.locator('.tool-panel .elec-kind-list');
    const overflow = await row.evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(overflow).toBe(true);
  });
});
