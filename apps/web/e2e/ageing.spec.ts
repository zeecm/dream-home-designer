import { type Locator, type Page, devices, expect, test } from '@playwright/test';
import { waitSaved } from './helpers';

// The older person (ageing parents) check, slice 1, on the sample flat: two bedrooms (Bath/WC 1
// opens off the main bedroom), the main door at the living room's foot near its right-hand
// wall, so its handle side is 0.42 m from that wall.

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

const section = (page: Page) =>
  page.locator('section', { has: page.getByRole('heading', { name: 'Older person' }) }).first();
const lines = (page: Page) => page.getByTestId('ageing-line');
const items = (page: Page) => page.locator('[data-hit^="item:"]');
const INTRO = /Checks doors, the way through, room to turn/;
const BATH2_DOOR = 'op_door_bath-wc-2_living-and-dining';

/** Places a catalogue piece with a click (or tap) at a plan point, then back to Select. */
async function place(page: Page, name: RegExp, x: number, y: number, touch = false, keep = false) {
  const press = (l: Locator) => (touch ? l.tap() : l.click());
  const piece = page.getByRole('button', { name }).first();
  // The catalogue may already be open (a phone's sheet with nothing selected).
  if (!(await piece.isVisible())) await press(page.getByRole('button', { name: /^Furniture/ }));
  await piece.scrollIntoViewIfNeeded();
  await press(piece);
  const p = await at(page, x, y);
  if (touch) await page.touchscreen.tap(p.x, p.y);
  else await page.mouse.click(p.x, p.y);
  if (!touch && !keep) {
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /^Select/ }).click();
  }
}

async function wheelchair(page: Page, touch = false) {
  const b = section(page).getByRole('button', { name: 'Wheelchair' });
  await b.scrollIntoViewIfNeeded();
  if (touch) await b.tap();
  else await b.click();
  await expect(section(page).getByTestId('ageing-summary')).toBeVisible();
}

test.describe('desktop', () => {
  test('21, 25, 26, 27: the choice, the bedrooms, the list, Show next, EASE and Off', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/');
    await waitSaved(page);
    await page.keyboard.press('1');
    // Off by default: nothing on the plan.
    await expect(page.getByTestId('ageing-layer')).toHaveCount(0);
    // 21. Wheelchair: the intro, the summary; the list asks which bedroom, with counts.
    await wheelchair(page);
    await expect(section(page)).toContainText(INTRO);
    await expect(section(page).getByTestId('ageing-summary')).toHaveText(
      /^\d+ to look at for a wheelchair: /,
    );
    await section(page).getByRole('button', { name: 'See the list' }).click();
    const list = page.locator('.ageing');
    await expect(list.getByRole('heading', { name: 'Older person' })).toBeFocused();
    await expect(list.getByRole('heading', { name: 'Which bedroom to check?' })).toBeVisible();
    await expect(list.getByRole('button', { name: /^Main bedroom: / })).toBeVisible();
    await expect(list.getByRole('button', { name: /^Bedroom: / })).toBeVisible();
    await list.getByRole('button', { name: /^Bedroom: / }).click();
    await expect(list.getByRole('heading', { name: 'Bedroom: Bedroom' })).toBeVisible();
    await expect(list.getByRole('heading', { name: /^Bathroom: Bath\/WC/ })).toBeVisible();
    await expect(list.getByRole('combobox', { name: 'Bathroom' })).toHaveValue('');
    await expect(
      list.getByRole('combobox', { name: 'Bathroom' }).locator('option').first(),
    ).toHaveText(/^Auto: Bath\/WC 2$/);
    // The main door's handle side is a line in Getting in, with its tag.
    await expect(lines(page).first()).toContainText('Needed');
    await expect(lines(page).first()).toContainText(
      /Inside the main door: the wall leaves 0\.42 m beside the handle/,
    );
    // On the plan: the strip, red, with its numbers and "walls".
    await expect(page.locator('.ageing-chip', { hasText: '0.42 / 0.45 m · walls' })).toBeVisible();

    // 25. Show next visits each line in order, then wraps; the details say which (n of N).
    const count = await lines(page).count();
    expect(count).toBeGreaterThan(1);
    const next = list.getByRole('button', { name: 'Show next' });
    await next.click();
    await expect(
      page.getByRole('button', { name: `‹ Back to the list (1 of ${count})` }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'For a wheelchair' })).toBeVisible();
    await page.getByRole('button', { name: /Back to the list/ }).click();
    for (let k = 2; k <= count; k++) {
      await page.locator('.ageing').getByRole('button', { name: 'Show next' }).click();
      await expect(page.getByRole('button', { name: /Back to the list/ })).toHaveText(
        new RegExp(`\\(${k} of ${count}\\)`),
      );
      await page.getByRole('button', { name: /Back to the list/ }).click();
    }
    await page.locator('.ageing').getByRole('button', { name: 'Show next' }).click();
    await expect(page.getByRole('button', { name: /Back to the list/ })).toHaveText(
      new RegExp(`\\(1 of ${count}\\)`),
    );
    // A tap on a line selects what it's about (here the bathroom door, which opens in) and pans.
    await page.getByRole('button', { name: /Back to the list/ }).click();
    const before = await page.evaluate(() =>
      document.querySelector('[id^="plan-scene"] > g[transform]')?.getAttribute('transform'),
    );
    await lines(page).filter({ hasText: 'opens inwards' }).click();
    await expect(page.locator('.inspector h2').first()).toHaveText('Door');
    await expect(page.getByTestId('item-ageing')).toContainText('opens inwards');
    const after = await page.evaluate(() =>
      document.querySelector('[id^="plan-scene"] > g[transform]')?.getAttribute('transform'),
    );
    expect(after).not.toBe(before);
    await page.getByRole('button', { name: /Back to the list/ }).click();

    // 26. EASE: the flat type from the bedrooms (2: 1, 2 or 3-room) and its prices.
    const ease = page.getByTestId('ease-table');
    await expect(page.locator('.ageing-ease select')).toHaveValue('1-3');
    await expect(ease.locator('[data-ease="grab-bars-first"]')).toContainText('$26.15');
    await expect(ease.locator('[data-ease="grab-bars-second"]')).toContainText('$15.25');
    await expect(ease.locator('[data-ease="widen-entrance"]')).toHaveCount(0);
    await page.locator('.ageing-ease select').selectOption('4');
    await expect(ease.locator('[data-ease="grab-bars-first"]')).toContainText('$39.20');
    await expect(ease.locator('[data-ease="rocker-switches"]')).toContainText('$20.40');
    await page.locator('.ageing-ease select').selectOption('exec');
    await expect(ease.locator('[data-ease="grab-bars-first"]')).toContainText('$65.40');
    await page.locator('.ageing-ease select').selectOption('none');
    await expect(page.locator('.ageing-ease')).toContainText('EASE is for HDB flats.');

    // 27. Off hides everything; the choice survives a reload.
    await page.locator('.ageing').getByRole('button', { name: 'Off' }).click();
    await expect(page.locator('.ageing')).toHaveCount(0);
    await expect(page.getByTestId('ageing-layer')).toHaveCount(0);
    await expect(section(page).getByTestId('ageing-summary')).toHaveCount(0);
    await wheelchair(page);
    await page.reload();
    await waitSaved(page);
    await expect(section(page).getByRole('button', { name: 'Wheelchair' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByTestId('ageing-layer')).toHaveCount(1);
    // 28. None of it in pictures or prints: the whole layer is skipped by exports.
    await expect(page.getByTestId('ageing-layer')).toHaveAttribute('data-export', 'skip');
    expect(errors).toEqual([]);
  });

  test('22, 23, 24: a wardrobe dragged by the bed, the bathroom door widened, a shoe cabinet by the handle', async ({
    page,
  }) => {
    await page.goto('/');
    await waitSaved(page);
    await page.keyboard.press('1');
    await wheelchair(page);
    await section(page).getByRole('button', { name: 'See the list' }).click();
    await page
      .locator('.ageing')
      .getByRole('button', { name: /^Main bedroom: / })
      .click();
    await page.locator('.ageing').getByRole('button', { name: 'Close', exact: true }).click();

    // 22. A queen bed against the top wall, a wardrobe below it with room to turn; dragged
    // toward the bed, the turning circle turns amber with its numbers before it's let go.
    await place(page, /^Queen bed/, 1.55, 1.225);
    await place(page, /^Wardrobe/, 1.55, 2.4);
    await expect(page.locator('[data-ageing="turn"]')).toHaveCount(0);
    const wardrobe = items(page).nth(1);
    const b = await wardrobe.boundingBox();
    if (!b) throw new Error('no wardrobe');
    const to = await at(page, 1.55, 2.8);
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 15 });
    await expect(page.locator('[data-ageing="turn"]')).toHaveCount(1);
    await expect(page.locator('.ageing-chip.ageing-advise', { hasText: '/ 1.50 m' })).toHaveText(
      /1\.\d\d \/ 1\.50 m/,
    );
    await page.mouse.up();
    await expect(page.getByRole('heading', { name: 'Wardrobe' })).toBeVisible();
    await expect(page.getByTestId('item-ageing')).toContainText(
      /No room to turn a wheelchair in Main bedroom: 1\.\d\d m beside the Wardrobe/,
    );
    await page.keyboard.press('Control+z');
    await expect(page.locator('[data-ageing="turn"]')).toHaveCount(0);

    // 23. Their bathroom (Bath/WC 1, off the main bedroom): its door at 0.70, then 0.90.
    await page.keyboard.press('Escape');
    const door = page.locator('[data-hit="opening:op_door_bath-wc-1_main-bedroom"]').first();
    await door.click({ force: true });
    const width = page.getByRole('textbox', { name: 'Width' });
    await width.fill('0.70');
    await width.press('Enter');
    await expect(page.getByTestId('item-ageing')).toContainText(
      'Bath/WC 1 door: 0.66 m clear; a wheelchair needs at least 0.80 m.',
    );
    await expect(page.locator('.ageing-chip', { hasText: '0.66 / 0.80 m' })).toBeVisible();
    await width.fill('0.90');
    await width.press('Enter');
    await expect(page.getByTestId('item-ageing')).not.toContainText('clear;');

    // 24. A shoe cabinet dropped against the wall by the main door's handle: the live region
    // reads its first ageing line, and the strip beside the handle is red.
    await page.keyboard.press('Escape');
    await place(page, /^Shoe cabinet/, 9.85, 5.3, false, true);
    await expect(
      page.locator('[aria-live="polite"]').filter({ hasText: 'Inside the main door' }),
    ).toContainText(
      /Inside the main door: 0\.\d\d m clear in front; .*The Shoe cabinet is in the way\./,
    );
    await expect(page.locator('.ageing-needed[data-ageing="latch-side"]')).toHaveCount(1);
    await expect(page.getByTestId('item-ageing')).toContainText(
      /Inside the main door: the Shoe cabinet leaves 0\.\d\d m beside the handle/,
    );
  });

  test('29: Before and After are checked apart', async ({ page }) => {
    await page.goto('/');
    await waitSaved(page);
    await page.keyboard.press('1');
    await wheelchair(page);
    await page.getByRole('button', { name: 'Plan a renovation' }).click();
    const bar = page.locator('.reno-bar');
    await expect(bar.getByRole('button', { name: 'After' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // Widen nothing, narrow the Bath/WC 2 door in After only.
    await page.locator(`[data-hit="opening:${BATH2_DOOR}"]`).first().click({ force: true });
    const width = page.getByRole('textbox', { name: 'Width' });
    await width.fill('0.70');
    await width.press('Enter');
    await expect(page.locator('.ageing-chip', { hasText: '0.66 / 0.80 m' })).toBeVisible();
    await page.keyboard.press('Escape');
    await bar.getByRole('button', { name: 'Before' }).click();
    await expect(page.getByTestId('ageing-layer')).toHaveCount(1);
    await expect(page.locator('.ageing-chip', { hasText: '0.66 / 0.80 m' })).toHaveCount(0);
    await bar.getByRole('button', { name: 'After' }).click();
    await expect(page.locator('.ageing-chip', { hasText: '0.66 / 0.80 m' })).toBeVisible();
  });
});

// 30. On a phone, by finger only.
async function finger(page: Page, from: { x: number; y: number }) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ ...from, id: 0 }],
  });
  return {
    async moveTo(to: { x: number; y: number }, steps = 10) {
      for (let i = 1; i <= steps; i++) {
        const p = {
          x: from.x + ((to.x - from.x) * i) / steps,
          y: from.y + ((to.y - from.y) * i) / steps,
        };
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

  test('30: the choice and the list on the sheet, a wardrobe dragged by finger; readable', async ({
    page,
  }) => {
    await page.goto('/');
    await waitSaved(page);
    await page.evaluate(() => document.fonts.ready);
    // The plan details on the sheet, by finger.
    await page.getByRole('button', { name: 'Show plan details' }).tap();
    await wheelchair(page, true);
    await expect(section(page)).toContainText(INTRO);
    await section(page).getByRole('button', { name: 'See the list' }).tap();
    const list = page.locator('.ageing');
    await expect(page.locator('.inspector.inspector-ageing')).toBeVisible();
    // The one-line top, and Change for the rows.
    await expect(list.locator('.ageing-oneline')).toContainText('Wheelchair · Bedroom not chosen');
    await expect(list.getByRole('combobox', { name: 'Bedroom' })).toBeHidden();
    await list.getByRole('button', { name: /^Main bedroom: / }).tap();
    await expect(list.locator('.ageing-oneline')).toContainText(
      'Wheelchair · Main bedroom · Bath/WC 1',
    );
    await list.getByRole('button', { name: 'Change' }).tap();
    await expect(list.getByRole('combobox', { name: 'Bedroom' })).toBeVisible();
    await expect(list.getByRole('combobox', { name: 'Bedroom' })).toHaveValue(/main-bedroom/);
    expect(await overflows(page)).toBe(false);
    // Lines are thumb-sized.
    const h = await lines(page)
      .first()
      .evaluate((el) => el.getBoundingClientRect().height);
    expect(h).toBeGreaterThanOrEqual(44);
    // Show next pans the plan above the sheet and opens the line's details with the way back.
    await list.getByRole('button', { name: 'Show next' }).tap();
    await expect(page.getByRole('button', { name: /Back to the list \(1 of \d+\)/ })).toBeVisible();
    await page.getByRole('button', { name: /Back to the list/ }).tap();
    await list.getByRole('button', { name: 'Close', exact: true }).tap();
    // Back to the whole plan (Show next panned to the main door).
    await page.getByRole('button', { name: 'Fit plan' }).tap();

    // 22 by finger: a bed and a wardrobe in the main bedroom, the wardrobe dragged toward the
    // bed: the amber circle and its numbers show before the finger lifts.
    // The wardrobe first, then the bed well above it (on a phone's small plan a tap close to a
    // piece selects it); each let go of, so no turn handle lies over the wardrobe.
    await place(page, /^Wardrobe/, 1.55, 2.4, true);
    await page.getByRole('button', { name: 'Clear selection' }).tap();
    await place(page, /^Queen bed/, 1.55, 1.15, true);
    await expect(items(page)).toHaveCount(2);
    await page.getByRole('button', { name: /^Select/ }).tap();
    await expect(page.locator('[data-ageing="turn"]')).toHaveCount(0);
    // Picked by a tap, then dragged by its right-hand end 0.4 m toward the room's far wall.
    const grip = await at(page, 2.0, 2.62);
    await page.touchscreen.tap(grip.x, grip.y);
    await expect(page.getByRole('heading', { name: 'Wardrobe' })).toBeVisible();
    const f = await finger(page, grip);
    await f.moveTo(await at(page, 2.0, 3.02));
    await expect(page.locator('[data-ageing="turn"]')).toHaveCount(1);
    await f.lift();
    const chip = page.locator('.ageing-chip.ageing-advise', { hasText: '/ 1.50 m' });
    await expect(chip).toHaveText(/1\.\d\d \/ 1\.50 m/);
    // Readable: 11 px however far out the plan is zoomed.
    const th = await chip.locator('text').evaluate((t) => t.getBoundingClientRect().height);
    expect(th).toBeGreaterThanOrEqual(10);
    await expect(page.getByTestId('item-ageing')).toContainText('No room to turn a wheelchair');
    expect(await overflows(page)).toBe(false);
  });
});
