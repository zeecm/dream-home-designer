import { waitSaved } from './helpers';
import { type Page, devices, expect, test } from './test';

// Clearance checks, slice 2: walkways from the main door, dining chairs, door clashes, the
// labels on the plan and the drop's announcement. On the sample flat: the main door is at the
// living room's foot; the corridor to the bedrooms runs left from it, 1.2 m wide.

/** A plan point (metres) on screen. */
async function at(page: Page, x: number, y: number) {
  return page.evaluate(
    ([px, py]) => {
      const g = document.querySelector('[id^="plan-scene"] > g[transform]') as SVGGraphicsElement;
      const p = new DOMPoint(px, py).matrixTransform(g.getScreenCTM() ?? undefined);
      return { x: p.x, y: p.y };
    },
    [x, y] as const,
  );
}

const items = (page: Page) => page.locator('[data-hit^="item:"]');
const walkwayLine = (page: Page) => page.getByTestId('walkway-line');
const clearances = (page: Page) => page.locator('.inspector section', { hasText: 'Clearances' });
const OK_LINE = 'Walkways: room to walk from the main door to every room.';
const NARROWS = /Narrows the way to .*Bedroom.* to \d\.\d\d m; a walkway needs 0\.90 m\./;

/** Places a catalogue piece with a click at a plan point (Furniture, then back to Select). */
async function place(page: Page, name: RegExp, x: number, y: number) {
  await page.getByRole('button', { name: /^Furniture/ }).click();
  await page.getByRole('button', { name }).first().click();
  const p = await at(page, x, y);
  await page.mouse.click(p.x, p.y);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^Select/ }).click();
}

/** Drags the n-th piece's body to a plan point; `during` runs before the button is let go. */
async function drag(page: Page, n: number, x: number, y: number, during?: () => Promise<void>) {
  const b = await items(page).nth(n).boundingBox();
  if (!b) throw new Error('no piece');
  const to = await at(page, x, y);
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 15 });
  if (during) await during();
  await page.mouse.up();
}

test.describe('desktop', () => {
  test('17–19: a sofa across the way to the bedrooms: pinch, label, Inspector, route; Undo clears them', async ({
    page,
  }) => {
    await page.goto('/');
    await waitSaved(page);
    await page.keyboard.press('1');
    // 17. The sample flat as it is: room to walk everywhere.
    await expect(walkwayLine(page)).toHaveText(OK_LINE);

    await place(page, /^3-seat sofa/, 8.3, 4.2);
    await expect(items(page)).toHaveCount(1);
    await expect(page.locator('.clearance-pinch')).toHaveCount(0);
    // 18. Dragged into the corridor: the pinch and its width show before it's let go.
    await drag(page, 0, 5.5, 3.75, async () => {
      await expect(page.locator('.clearance-pinch')).toHaveCount(1);
      await expect(page.locator('.clearance-chip').first()).toHaveText(/\d\.\d\d \/ 0\.90 m/);
    });
    await expect(page.locator('.clearance-pinch')).toHaveCount(1);
    await expect(page.locator('.clearance-chip').first()).toHaveText(/\d\.\d\d \/ 0\.90 m/);
    await expect(page.getByRole('heading', { name: '3-seat sofa' })).toBeVisible();
    await expect(clearances(page)).toContainText(NARROWS);
    // 19. Its narrowed way, dashed from the main door; gone when deselected.
    await expect(page.getByTestId('clearance-route')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('clearance-route')).toHaveCount(0);
    await expect(walkwayLine(page)).toHaveText(/^Walkways: tight to .*Bedroom.*\(\d\.\d\d\sm\)/);
    await expect(walkwayLine(page)).toHaveClass(/warning-text/);

    // Undo: the bar, the walkway line and the sofa's line all clear.
    await page.keyboard.press('Control+z');
    await expect(page.locator('.clearance-pinch')).toHaveCount(0);
    await expect(walkwayLine(page)).toHaveText(OK_LINE);
    await items(page).first().click({ force: true });
    await expect(page.getByRole('heading', { name: '3-seat sofa' })).toBeVisible();
    await expect(page.locator('.inspector')).not.toContainText('Narrows the way');
  });

  test('20, 22: a chair between a table and the wall; a wardrobe dragged short, labelled and announced', async ({
    page,
  }) => {
    await page.goto('/');
    await waitSaved(page);
    await page.keyboard.press('1');
    // 20. A dining table 0.3 m off the living room's top wall (its face at y 1.65), a chair
    // between them.
    await place(page, /^Dining table, 4/, 8.3, 1.65 + 0.3 + 0.4);
    await place(page, /^Dining chair\b/, 8.3, 1.92);
    await items(page).nth(1).click({ force: true });
    await expect(page.getByRole('heading', { name: 'Dining chair' })).toBeVisible();
    await expect(page.locator('.clearance-short')).not.toHaveCount(0);
    await expect(page.locator('.clearance-chip', { hasText: '/ 0.75 m' })).toHaveText(
      /0\.\d\d \/ 0\.75 m/,
    );
    await expect(clearances(page)).toContainText(
      /Pulling out the chair needs 0\.75 m from the table; 0\.\d\d m here\./,
    );
    // Selecting the table shows its chair's zone and label too.
    await page.keyboard.press('Escape');
    await items(page).nth(0).click({ force: true });
    await expect(page.getByRole('heading', { name: 'Dining table, 4 seats' })).toBeVisible();
    await expect(page.locator('.clearance-chip', { hasText: '/ 0.75 m' })).toHaveCount(1);
    await expect(clearances(page)).toContainText('Pulling out the chair needs 0.75 m');
    await page.keyboard.press('Escape');

    // 22. An armchair in the main bedroom; a wardrobe on the top wall, dragged along it until
    // its doors face the armchair: labelled while moving and once dropped, and announced.
    await place(page, /^Armchair/, 2.4, 1.25);
    await place(page, /^Wardrobe/, 0.85, 0.3);
    const live = page.locator('p.visually-hidden[aria-live="polite"]');
    await drag(page, 3, 2.1, 0.4, async () => {
      await expect(page.locator('.clearance-chip', { hasText: '/ 0.60 m' })).toHaveText(
        /0\.\d\d \/ 0\.60 m/,
      );
    });
    await expect(page.getByRole('heading', { name: 'Wardrobe' })).toBeVisible();
    await expect(page.locator('.clearance-chip', { hasText: '/ 0.60 m' })).toHaveCount(1);
    await expect(live).toContainText(/Wardrobe doors need 0\.60 m in front; 0\.\d\d m here\./);
  });

  test('21, 23–25: doors that hit each other; the count and Show next; the switch; not in pictures', async ({
    page,
  }) => {
    await page.goto('/');
    await waitSaved(page);
    await page.keyboard.press('1');
    // 21. The bathroom and bedroom doors across the corridor, both swung out into it.
    for (const id of [
      'op_door_bath-wc-2_living-and-dining',
      'op_door_bedroom_living-and-dining-3',
    ]) {
      await page.locator(`[data-hit="opening:${id}"]`).first().click({ force: true });
      await page.getByRole('button', { name: 'Flip swing' }).click();
      await page.keyboard.press('Escape');
    }
    const count = page.getByTestId('clearance-count');
    await expect(count).toHaveText('2 doors are short of room or in the way.');
    // Both sweeps red.
    await expect(page.locator('.clearance-short')).toHaveCount(2);

    // A wardrobe with an armchair in front, and a sofa narrowing the corridor.
    await place(page, /^Wardrobe/, 1.5, 0.3);
    await place(page, /^Armchair/, 1.5, 1.4);
    await place(page, /^3-seat sofa/, 8.3, 4.2);
    await drag(page, 2, 5.5, 3.75);
    await page.keyboard.press('Escape');
    // 23. N = pieces with problems + doors; Show next visits each, pieces first, then wraps.
    const text = (await count.textContent()) ?? '';
    const m = /^(\d+) pieces? and 2 doors are short/.exec(text);
    expect(m).not.toBeNull();
    const n = Number(m?.[1]) + 2;
    const seen: string[] = [];
    for (let i = 0; i <= n; i++) {
      await page.keyboard.press('Escape');
      await count.locator('..').getByRole('button', { name: 'Show next' }).click();
      seen.push((await page.locator('.inspector h2').first().textContent()) ?? '');
    }
    expect(seen.slice(n - 2, n)).toEqual(['Door', 'Door']);
    expect(seen.slice(0, n - 2)).not.toContain('Door');
    expect(seen[n]).toBe(seen[0]);
    // The door's Clearances, first in its details (Show next on to the first door).
    for (let i = 0; i < n - 2; i++) {
      await page.keyboard.press('Escape');
      await count.locator('..').getByRole('button', { name: 'Show next' }).click();
    }
    await expect(page.locator('.inspector h2').first()).toHaveText('Door');
    await expect(clearances(page)).toContainText(/Hits the .+ door when both are open\./);
    await page.keyboard.press('Escape');

    // 25. Everything drawn for clearances stays out of pictures, print and the contractor sheet.
    const outside = await page.evaluate(
      () =>
        [
          ...document.querySelectorAll(
            '.clearance-short, .clearance-clash, .clearance-pinch, .clearance-chip, .clearance-fine',
          ),
        ].filter((el) => !el.closest('[data-export="skip"]')).length,
    );
    expect(outside).toBe(0);

    // 24. Switched off: the zones, sweeps, labels and the walkway line all go, after a reload too.
    await expect(walkwayLine(page)).toBeVisible();
    await page.getByLabel('Clearance checks').uncheck();
    await expect(page.locator('g.clearance')).toHaveCount(0);
    await expect(walkwayLine(page)).toHaveCount(0);
    await expect(count).toHaveCount(0);
    await waitSaved(page);
    await page.reload();
    await waitSaved(page);
    await expect(page.getByLabel('Clearance checks')).not.toBeChecked();
    await expect(page.locator('g.clearance')).toHaveCount(0);
    await expect(walkwayLine(page)).toHaveCount(0);
    await page.getByLabel('Clearance checks').check();
    await expect(page.locator('.clearance-pinch')).toHaveCount(1);
  });

  test('26: Before and After have their own walkway lines and counts', async ({ page }) => {
    await page.goto('/');
    await waitSaved(page);
    await page.keyboard.press('1');
    await page.getByRole('button', { name: 'Plan a renovation' }).click();
    // In the After: a sofa narrowing the corridor.
    await place(page, /^3-seat sofa/, 8.3, 4.2);
    await drag(page, 0, 5.5, 3.75);
    await page.keyboard.press('Escape');
    await expect(walkwayLine(page)).toHaveText(/^Walkways: tight to /);
    await expect(page.getByTestId('clearance-count')).toHaveText(/^1 piece is short/);
    // The Before has no sofa: room everywhere, nothing counted.
    const bar = page.locator('.reno-bar');
    await bar.getByRole('button', { name: 'Before' }).click();
    await expect(walkwayLine(page)).toHaveText(OK_LINE);
    await expect(page.getByTestId('clearance-count')).toHaveCount(0);
    await expect(page.locator('.clearance-pinch')).toHaveCount(0);
    await bar.getByRole('button', { name: 'After' }).click();
    await expect(walkwayLine(page)).toHaveText(/^Walkways: tight to /);
    await expect(page.locator('.clearance-pinch')).toHaveCount(1);
  });

  test('a wardrobe filling the Bath/WC 2 doorway: drawn shut across the doorway', async ({
    page,
  }) => {
    await page.goto('/');
    await waitSaved(page);
    await page.keyboard.press('1');
    await place(page, /^Wardrobe/, 3.6, 3.95);
    await page.keyboard.press('Escape');
    await expect(walkwayLine(page)).toContainText('Bath/WC 2 (closed)');
    // A bar along the bathroom's doorway (x 3.29..4.19 in the wall at y 4.32), not across
    // the corridor's open floor.
    const bars = await page
      .locator('.clearance-pinch > line:first-child')
      .evaluateAll((ls) =>
        ls.map((l) => ['x1', 'y1', 'x2', 'y2'].map((k) => Number(l.getAttribute(k)))),
      );
    const across = bars.filter(
      ([x1, y1, x2, y2]) =>
        Math.abs((y1 as number) - 4.32) < 0.05 &&
        Math.abs((y2 as number) - 4.32) < 0.05 &&
        Math.abs(Math.min(x1 as number, x2 as number) - 3.29) < 0.05 &&
        Math.abs(Math.max(x1 as number, x2 as number) - 4.19) < 0.05,
    );
    expect(across).toHaveLength(1);
  });

  test('an After with its main door deleted asks for the main door', async ({ page }) => {
    await page.goto('/');
    await waitSaved(page);
    await page.keyboard.press('1');
    await page.getByRole('button', { name: 'Plan a renovation' }).click();
    await page
      .locator('[data-hit="opening:op_door_living-and-dining_outside-3"]')
      .first()
      .click({ force: true });
    await page.getByRole('button', { name: 'Delete door' }).click();
    await page.keyboard.press('Escape');
    await expect(walkwayLine(page)).toHaveText('Add the main door to check walkways.');
    // The Before still has it.
    await page.locator('.reno-bar').getByRole('button', { name: 'Before' }).click();
    await expect(walkwayLine(page)).toHaveText(OK_LINE);
  });

  test('a door that hits a fridge’s door is counted and visited by Show next', async ({ page }) => {
    await page.goto('/');
    await waitSaved(page);
    await page.keyboard.press('1');
    // In the bedroom, facing its door 0.5 m short of the door's swing: the fridge door
    // (0.70 m) reaches into it.
    await place(page, /^Fridge/, 4.1, 1.3);
    await page.keyboard.press('Escape');
    const count = page.getByTestId('clearance-count');
    await expect(count).toHaveText('1 piece and 1 door are short of room or in the way.');
    const next = count.locator('..').getByRole('button', { name: 'Show next' });
    const heading = page.locator('.inspector h2').first();
    await next.click();
    await expect(heading).toHaveText('Fridge');
    await expect(clearances(page)).toContainText(
      /Its door hit the Bedroom door when both are open\./,
    );
    await page.keyboard.press('Escape');
    await next.click();
    await expect(heading).toHaveText('Door');
    await expect(clearances(page)).toContainText('Hits the fridge door when both are open.');
  });
});

// 27. On a phone, by finger only.
async function finger(page: Page, from: { x: number; y: number }) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ ...from, id: 0 }],
  });
  return {
    async moveTo(to: { x: number; y: number }, steps = 10) {
      const a = { ...from };
      for (let i = 1; i <= steps; i++) {
        const p = { x: a.x + ((to.x - a.x) * i) / steps, y: a.y + ((to.y - a.y) * i) / steps };
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ ...p, id: 0 }],
        });
        await page.waitForTimeout(16);
      }
    },
    async lift() {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForTimeout(100);
    },
  };
}

/** Nothing wider than the screen: the page, and the details sheet. */
async function overflows(page: Page) {
  return page.evaluate(() => {
    const wide = (el: Element | null) => !!el && el.scrollWidth > el.clientWidth + 1;
    return (
      document.documentElement.scrollWidth > window.innerWidth + 1 ||
      wide(document.querySelector('.inspector'))
    );
  });
}

test.describe('phone', () => {
  const { defaultBrowserType: _webkit, ...iPhone } = devices['iPhone 13'];
  test.use(iPhone);

  test('27: a sofa dragged by finger across the way; a chair by a table; readable, on the sheet', async ({
    page,
  }) => {
    await page.goto('/');
    await waitSaved(page);
    await page.evaluate(() => document.fonts.ready);
    // The sofa, placed in the living room and dragged by finger into the corridor.
    await page.getByRole('button', { name: /^Furniture/ }).tap();
    await page.getByRole('button', { name: /^3-seat sofa/ }).tap();
    const p = await at(page, 8.3, 4.4);
    await page.touchscreen.tap(p.x, p.y);
    await expect(items(page)).toHaveCount(1);
    const b = await items(page).first().boundingBox();
    if (!b) throw new Error('no sofa');
    const f = await finger(page, { x: b.x + b.width / 2, y: b.y + b.height / 2 });
    await f.moveTo(await at(page, 5.5, 3.75));
    await expect(page.locator('.clearance-pinch')).toHaveCount(1);
    await f.lift();
    await expect(page.locator('.clearance-pinch')).toHaveCount(1);
    const chip = page.locator('.clearance-chip', { hasText: '/ 0.90 m' });
    await expect(chip).toHaveText(/\d\.\d\d \/ 0\.90 m/);
    // Readable: 11 px text however far out the plan is zoomed.
    const h = await chip.locator('text').evaluate((t) => t.getBoundingClientRect().height);
    expect(h).toBeGreaterThanOrEqual(10);
    // The sofa's line on the sheet.
    await expect(clearances(page)).toContainText(NARROWS);
    expect(await overflows(page)).toBe(false);

    // The walkway line in the plan details on the sheet.
    await page.getByRole('button', { name: 'Clear selection' }).tap();
    await expect(walkwayLine(page)).toHaveText(/^Walkways: tight to /);
    expect(await overflows(page)).toBe(false);

    // A dining table near the living room's top wall; a chair put down clear of it, then
    // dragged by finger in between.
    await page.getByRole('button', { name: /^Furniture/ }).tap();
    await page.getByRole('button', { name: /^Dining table, 4/ }).tap();
    let q = await at(page, 8.3, 1.65 + 0.3 + 0.4);
    await page.touchscreen.tap(q.x, q.y);
    await page.getByRole('button', { name: /^Furniture/ }).tap();
    await page
      .getByRole('button', { name: /^Dining chair\b/ })
      .first()
      .tap();
    q = await at(page, 9.6, 3.4);
    await page.touchscreen.tap(q.x, q.y);
    await expect(page.getByRole('heading', { name: 'Dining chair' })).toBeVisible();
    const c = await items(page).nth(2).boundingBox();
    if (!c) throw new Error('no chair');
    const g = await finger(page, { x: c.x + c.width / 2, y: c.y + c.height / 2 });
    await g.moveTo(await at(page, 8.3, 1.92));
    await g.lift();
    await expect(page.getByRole('heading', { name: 'Dining chair' })).toBeVisible();
    await expect(clearances(page)).toContainText(
      /Pulling out the chair needs 0\.75 m from the table; 0\.\d\d m here\./,
    );
    await expect(page.locator('.clearance-chip', { hasText: '/ 0.75 m' })).toHaveText(
      /0\.\d\d \/ 0\.75 m/,
    );
    expect(await overflows(page)).toBe(false);
  });
});
