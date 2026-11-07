import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Locator, type Page, devices, expect, test } from '@playwright/test';
import { waitSaved } from './helpers';

// The storage meter, slice 1, on core's furnished sample (written out; a web unit test keeps
// it in step): a queen bed and a 1.20 m wardrobe in Main bedroom, a single bed in Bedroom, a
// TV console in the living room, a 2.8 m kitchen run, the household shelter (3.4 m²).

const FILE = readFileSync(new URL('./furnished.dreamhome.json', import.meta.url));

/** Opens the furnished sample as Projects ▸ Open a project file does, in the plan view. */
async function openFurnished(page: Page) {
  await page.goto('/');
  await waitSaved(page);
  const before = new URL(page.url()).searchParams.get('p');
  await page.locator('input[type="file"][accept=".json,application/json"]').setInputFiles({
    name: 'furnished.dreamhome.json',
    mimeType: 'application/json',
    buffer: FILE,
  });
  await expect.poll(() => new URL(page.url()).searchParams.get('p')).not.toBe(before);
  await waitSaved(page);
}

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

/**
 * Places a catalogue piece with a click (or tap) at a plan point, the whole plan in view (a
 * card tapped pans to its room); the piece stays selected.
 */
async function place(page: Page, name: RegExp, x: number, y: number, touch = false) {
  const press = (l: Locator) => (touch ? l.tap() : l.click());
  await press(page.getByRole('button', { name: 'Fit plan' }));
  const piece = page.getByRole('button', { name }).first();
  if (!(await piece.isVisible())) await press(page.getByRole('button', { name: /^Furniture/ }));
  await piece.scrollIntoViewIfNeeded();
  await press(piece);
  const p = await at(page, x, y);
  if (touch) await page.touchscreen.tap(p.x, p.y);
  else await page.mouse.click(p.x, p.y);
}

/** After placing: the piece let go, the Select tool (Escape again would close the panel). */
async function backToSelect(page: Page) {
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^Select/ }).click();
  if (await page.getByRole('button', { name: 'Clear selection' }).isVisible()) {
    await page.getByRole('button', { name: 'Clear selection' }).click();
  }
}

const panel = (page: Page) => page.locator('section.storage');
const meter = (page: Page, m: string) => page.locator(`.storage-meter[data-measure="${m}"]`);
const card = (page: Page, room: string) =>
  page.locator(`[data-testid="storage-room"][data-room="${room}"]`);
const chip = (page: Page) => page.getByTestId('storage-chip');

async function seeStorage(page: Page, touch = false) {
  const b = page.getByRole('button', { name: 'See storage' });
  await b.scrollIntoViewIfNeeded();
  if (touch) await b.tap();
  else await b.click();
  await expect(panel(page)).toBeVisible();
}

// The print dialog is stubbed: the contractor sheet prints from a frame of its own.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.print = () => {};
  });
});

test.describe('desktop', () => {
  test('17, 18, 19, 23: the row, the panel, a wardrobe added and one resized, the pieces’ lines', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openFurnished(page);
    await page.keyboard.press('1');
    // 17. Under Checks, with the others; its line and the way in.
    const checks = page.locator('section.checks');
    await expect(checks.getByRole('heading', { name: 'Checks' })).toBeVisible();
    await expect(page.getByTestId('storage-summary')).toHaveText(
      'Clothes, kitchen and everything else could use more. No shoe cabinet drawn yet.',
    );
    await seeStorage(page);
    await expect(panel(page).getByRole('heading', { name: 'Storage' })).toBeFocused();
    await expect(panel(page)).toContainText('Do you have room for everything?');
    // Who lives here, guessed from the beds: one line, Change to see the steppers.
    await expect(page.getByTestId('storage-household')).toHaveText(
      '3 people (guessed from the beds): 1 in Bedroom, 2 in Main bedroom',
    );
    await page.locator('.storage-oneline').getByRole('button', { name: 'Change' }).click();
    const main = page.locator('.storage-people[data-room="Main bedroom"]');
    await expect(main).toContainText('Guessed from the beds');
    await expect(main.locator('.storage-step').first()).toContainText('2');
    await expect(page.locator('.storage-people[data-room="Bedroom"] .num').first()).toHaveText('1');
    // Four meters, each a meter to a screen reader; nothing drawn is no status, with a way to add.
    await expect(panel(page).getByRole('meter')).toHaveCount(4);
    await expect(meter(page, 'clothes')).toContainText('Needs 1.80 m more');
    await expect(meter(page, 'clothes').getByRole('meter')).toHaveAttribute(
      'aria-valuetext',
      '1.20 of 3.00 m (4 of 10 ft), needs 1.80 m more',
    );
    await expect(meter(page, 'shoes')).toContainText(
      'No shoe cabinet drawn · about 28 pairs is usual',
    );
    await expect(
      meter(page, 'shoes').getByRole('button', { name: 'Add a shoe cabinet' }),
    ).toBeVisible();
    await expect(meter(page, 'shoes').locator('.storage-bar-empty')).toHaveCount(1);
    await expect(meter(page, 'other')).toContainText('3.7 of 8 m³');
    await expect(meter(page, 'other')).toContainText('Most HDB flats have little room');
    // Room cards, the shortfall priced; no red anywhere in the panel.
    await expect(card(page, 'Main bedroom')).toContainText(
      'Needs about 0.80 m more: a 3 ft run, about $600–1,050 built in.',
    );
    await expect(card(page, 'Bedroom')).toContainText(
      'No wardrobe yet; about 1.00 m is usual: a 3 ft run, about $600–1,050 built in.',
    );
    // The chips on the plan, amber where something drawn needs more; nothing drawn is dashed.
    await expect(chip(page).filter({ hasText: 'Wardrobe 1.20 of 2.00 m' })).toHaveClass(
      /storage-chip-warn/,
    );
    await expect(chip(page).filter({ hasText: 'Shelves 4.8 of 12 m' })).toBeVisible();
    const noWardrobe = chip(page).filter({ hasText: 'No wardrobe · about 1.00 m usual' });
    await expect(noWardrobe).toHaveClass(/storage-chip-empty/);
    await expect(noWardrobe).not.toHaveClass(/storage-chip-warn/);

    // 18. A built-in wardrobe in Bedroom: its line and chip, live; Undo takes both back.
    await place(page, /^Built-in wardrobe/, 4.3, 2.8);
    await expect(page.getByRole('heading', { name: 'Built-in wardrobe' })).toBeVisible();
    await expect(page.getByRole('button', { name: '‹ Back to storage' })).toBeVisible();
    await expect(chip(page).filter({ hasText: 'Wardrobe 1.80 of 1.00 m' })).not.toHaveClass(
      /storage-chip-warn/,
    );
    await expect(page.getByTestId('item-storage')).toHaveText(
      'Storage: 1.80 m of wardrobe (6 ft) and 0.5 m³ of top cabinets',
    );
    await backToSelect(page);
    await expect(card(page, 'Bedroom')).toContainText(
      '1.80 m of wardrobe; about 1.00 m is usual. Enough.',
    );
    await page.keyboard.press('Control+z');
    await expect(card(page, 'Bedroom')).toContainText('No wardrobe yet; about 1.00 m is usual');
    await expect(chip(page).filter({ hasText: 'No wardrobe · about 1.00 m usual' })).toBeVisible();

    // 19. The Main bedroom wardrobe, picked from its card, made 2.40 m wide by its corner.
    await card(page, 'Main bedroom')
      .getByRole('button', { name: /^Wardrobe/ })
      .click();
    await expect(page.getByTestId('item-storage')).toHaveText('Storage: 1.20 m of wardrobe (4 ft)');
    const from = await at(page, 0.9, 2.2);
    const to = await at(page, 0.9, 3.4);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 12 });
    await page.mouse.up();
    await expect(page.getByTestId('item-storage')).toHaveText('Storage: 2.40 m of wardrobe (8 ft)');
    await expect(chip(page).filter({ hasText: 'Wardrobe 2.40 of 2.00 m' })).not.toHaveClass(
      /storage-chip-warn/,
    );
    // Back to storage: where it was, focus on the card the piece was opened from.
    await page.getByRole('button', { name: '‹ Back to storage' }).click();
    await expect(card(page, 'Main bedroom')).toContainText(
      '2.40 m of wardrobe; about 2.00 m is usual. Enough.',
    );
    await expect(
      card(page, 'Main bedroom').getByRole('button', { name: 'Main bedroom: show on the plan' }),
    ).toBeFocused();

    // 23. Lines in the details: a shoe cabinet, a base cabinet, a bookshelf; a sofa has none.
    await place(page, /^Shoe cabinet/, 9.85, 5.3);
    await expect(page.getByTestId('item-storage')).toHaveText('Storage: about 15 pairs of shoes');
    await backToSelect(page);
    await expect(meter(page, 'shoes')).toContainText('15 of 28 pairs');
    await card(page, 'Kitchen')
      .getByRole('button', { name: /^Base cabinet/ })
      .first()
      .click();
    await expect(page.getByTestId('item-storage')).toHaveText(
      'Storage: 1.20 m of shelf and drawer front',
    );
    await page.keyboard.press('Escape');
    await place(page, /^Bookshelf/, 9.7, 3.0);
    await expect(page.getByTestId('item-storage')).toHaveText('Storage: 0.4 m³');
    await backToSelect(page);
    const sofa = await at(page, 7.5, 5.45);
    await page.mouse.click(sofa.x, sofa.y);
    await expect(page.getByRole('heading', { name: '3-seat sofa' })).toBeVisible();
    await expect(page.getByTestId('item-storage')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('20, 21, 22, 25: people, how much we own, the shelter, Copy', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openFurnished(page);
    await page.keyboard.press('1');
    await seeStorage(page);
    const bedroom = page.locator('.storage-people[data-room="Bedroom"]');
    // 20. A child in Bedroom: its target rises by 0.60 m, the guess goes; kept after a reload.
    await page.locator('.storage-oneline').getByRole('button', { name: 'Change' }).click();
    await expect(bedroom).toContainText('Guessed from the beds');
    await bedroom.getByRole('button', { name: 'More children in Bedroom' }).click();
    await expect(card(page, 'Bedroom')).toContainText('about 1.60 m is usual');
    await expect(bedroom).not.toContainText('Guessed from the beds');
    await expect(page.getByTestId('storage-household')).toHaveText(
      '4 people: 2 in Bedroom, 2 in Main bedroom',
    );
    // One line read for the change.
    await expect(page.locator('.storage-household [aria-live]')).toHaveText(
      'Bedroom: 1 adult and 1 child',
    );
    await page.reload();
    await waitSaved(page);
    await page.keyboard.press('1');
    await seeStorage(page);
    await expect(card(page, 'Bedroom')).toContainText('1 adult and 1 child');
    // Folded: Change opens it.
    await page.locator('.storage-oneline').getByRole('button', { name: 'Change' }).click();
    await page.getByRole('button', { name: 'Reset to the beds' }).click();
    await expect(card(page, 'Bedroom')).toContainText('about 1.00 m is usual');
    await expect(bedroom).toContainText('Guessed from the beds');

    // 21. Lots: every target the Lots row; kept after a reload.
    await page.getByRole('button', { name: 'Lots' }).click();
    await expect(meter(page, 'clothes')).toContainText('of 5.40 m');
    await expect(meter(page, 'shoes')).toContainText('about 51 pairs is usual');
    await expect(meter(page, 'kitchen')).toContainText('of 15.5 m');
    await expect(meter(page, 'other')).toContainText('of 10 m³');
    await page.reload();
    await waitSaved(page);
    await page.keyboard.press('1');
    await seeStorage(page);
    await expect(page.getByRole('button', { name: 'Lots' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.getByRole('button', { name: 'Typical' }).click();

    // 22. The shelter off: Everything else drops by its 3.4 m³; its note goes.
    await expect(panel(page)).toContainText('The shelter is counted as storage');
    await page.getByLabel('Use the shelter for storage').uncheck();
    await expect(meter(page, 'other')).toContainText('0.4 of 8 m³');
    await expect(panel(page)).not.toContainText('The shelter is counted as storage');
    await page.getByLabel('Use the shelter for storage').check();

    // 25. Copy: the household, four meters, room lines and the disclaimer, as text.
    await panel(page).getByRole('button', { name: 'Copy summary' }).click();
    await expect(panel(page).getByRole('button', { name: 'Copied' })).toBeVisible();
    await expect(panel(page).getByRole('button', { name: 'Copy summary' })).toBeVisible({
      timeout: 4000,
    });
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(text).toContain('Storage for 3 people (Typical)');
    expect(text).toContain('Who lives here: 1 in Bedroom, 2 in Main bedroom');
    expect(text).toContain('Shoes: No shoe cabinet drawn · about 28 pairs is usual');
    expect(text).toContain('Clothes: 1.20 of 3.00 m (4 of 10 ft). Needs 1.80 m more');
    expect(text).toContain('Shoes: No shoe cabinet drawn');
    expect(text).toContain('Main bedroom, 2 adults: 1.20 m of wardrobe; about 2.00 m is usual.');
    expect(text).toContain('No Singapore rule sets storage.');
  });

  test('24: chips only while the panel is open, none in pictures or the contractor sheet', async ({
    page,
  }) => {
    await openFurnished(page);
    await page.keyboard.press('1');
    await expect(page.getByTestId('storage-chips')).toHaveCount(0);
    await seeStorage(page);
    await expect(page.getByTestId('storage-chips')).toHaveAttribute('data-export', 'skip');
    // A tapped card outlines its room (also left out) and pans to it.
    const before = await page.evaluate(() =>
      document.querySelector('[id^="plan-scene"] > g[transform]')?.getAttribute('transform'),
    );
    await card(page, 'Kitchen').getByRole('button', { name: 'Kitchen: show on the plan' }).click();
    await expect(page.getByTestId('storage-highlight')).toHaveAttribute('data-export', 'skip');
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.querySelector('[id^="plan-scene"] > g[transform]')?.getAttribute('transform'),
        ),
      )
      .not.toBe(before);
    // The contractor sheet draws its own plan: no chips.
    await page.getByRole('button', { name: 'Projects' }).click();
    await page.getByRole('button', { name: 'Plan for contractors (PDF)' }).click();
    const dialog = page.getByRole('dialog', { name: 'Plan for contractors' });
    await dialog.getByRole('button', { name: 'Print or save as PDF' }).click();
    await expect(dialog).toBeHidden();
    const sheet = page.frameLocator('iframe[data-print="contractor"]');
    await expect(sheet.locator('svg.contractor-page').first()).toBeAttached();
    await expect(sheet.locator('.storage-chip, .storage-highlight')).toHaveCount(0);
    // Closed: the chips go.
    await page.getByRole('button', { name: 'Close storage' }).click();
    await expect(page.getByTestId('storage-chips')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'See storage' })).toBeFocused();
  });

  test('chips keep clear of the clearance labels, which draw over them (the default Split view)', async ({
    page,
  }) => {
    await openFurnished(page);
    await seeStorage(page);
    await expect(chip(page).first()).toBeVisible();
    const clearance = page.locator('.clearance-chip');
    await expect(clearance.first()).toBeVisible();
    const boxes = async (l: Locator) =>
      (await l.evaluateAll((els) =>
        els.map((e) => {
          const r = e.getBoundingClientRect();
          return { x0: r.left, y0: r.top, x1: r.right, y1: r.bottom };
        }),
      )) as { x0: number; y0: number; x1: number; y1: number }[];
    const chips = await boxes(chip(page));
    for (const c of await boxes(clearance)) {
      for (const s of chips) {
        const over = c.x0 < s.x1 - 1 && s.x0 < c.x1 - 1 && c.y0 < s.y1 - 1 && s.y0 < c.y1 - 1;
        expect(over, JSON.stringify({ c, s })).toBe(false);
      }
    }
    // The clearance marks come after the chips: drawn over them.
    const after = await page.evaluate(() => {
      const s = document.querySelector('[data-testid="storage-chips"]');
      const c = document.querySelector('.clearance-chip');
      return !!s && !!c && !!(s.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    expect(after).toBe(true);
  });

  test('Add a shoe cabinet: what to do, placed with a click, the panel back with it counted', async ({
    page,
  }) => {
    await openFurnished(page);
    await page.keyboard.press('1');
    await seeStorage(page);
    await meter(page, 'shoes').getByRole('button', { name: 'Add a shoe cabinet' }).click();
    await expect(page.locator('.storage-add-bar')).toContainText(
      'Click where the shoe cabinet goes',
    );
    await expect(page.locator('.tool-hint')).toHaveText(
      'Shoe cabinet chosen. Click the plan where it goes; Esc to cancel.',
    );
    await expect(page.getByRole('button', { name: /^Shoe cabinet/ }).first()).toBeInViewport();
    await expect(panel(page)).toBeVisible();
    const p = await at(page, 9.85, 5.3);
    await page.mouse.click(p.x, p.y);
    // Placed: the panel is back, the bar gone, the shoes counted.
    await expect(page.locator('.storage-add-bar')).toHaveCount(0);
    await expect(panel(page)).toBeVisible();
    await expect(meter(page, 'shoes')).toContainText('15 of 28 pairs');
    await expect(page.getByRole('button', { name: /^Select/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // Cancel takes it back.
    await page.keyboard.press('Control+z');
    await meter(page, 'shoes').getByRole('button', { name: 'Add a shoe cabinet' }).click();
    await page.locator('.storage-add-bar').getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('.storage-add-bar')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Select/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('23: an uploaded model is not counted', async ({ page }) => {
    const dir = fileURLToPath(new URL('../public/models', import.meta.url));
    const file = readdirSync(dir).find((f) => f.startsWith('nightstand-painted.'));
    if (!file) throw new Error('no model to upload');
    const buffer = readFileSync(join(dir, file));
    expect(createHash('sha256').update(buffer).digest('hex')).toHaveLength(64);
    await openFurnished(page);
    await page.keyboard.press('1');
    await seeStorage(page);
    await page.getByRole('button', { name: /^Furniture/ }).click();
    await page.getByLabel('Model file').first().setInputFiles({
      name: 'ikea-pax.glb',
      mimeType: 'model/gltf-binary',
      buffer,
    });
    await expect(page.getByRole('button', { name: /^Ikea pax/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const p = await at(page, 9.6, 4.9);
    await page.mouse.click(p.x, p.y);
    await expect(page.getByRole('heading', { name: 'Ikea pax' })).toBeVisible();
    await expect(page.getByTestId('item-storage')).toHaveText('Not counted as storage.');
    await backToSelect(page);
    await expect(panel(page)).toContainText(
      'Not counted: Ikea pax (your model). Storage can’t be told from a model.',
    );
  });

  test('26: Before and After: what the renovation adds', async ({ page }) => {
    await openFurnished(page);
    await page.keyboard.press('1');
    await page.getByRole('button', { name: 'Plan a renovation' }).click();
    const bar = page.locator('.reno-bar');
    await expect(bar.getByRole('button', { name: 'After' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await seeStorage(page);
    await place(page, /^Built-in wardrobe/, 1.2, 4.0);
    await backToSelect(page);
    await expect(meter(page, 'clothes')).toContainText('3.00 of 3.00 m');
    await expect(meter(page, 'clothes')).toContainText('Before: 1.20 m');
    await expect(card(page, 'Main bedroom')).toContainText('+1.80 m, +0.5 m³ in the renovation');
    await bar.getByRole('button', { name: 'Before' }).click();
    await expect(meter(page, 'clothes')).toContainText('1.20 of 3.00 m');
    await expect(meter(page, 'clothes')).not.toContainText('Before:');
    await expect(card(page, 'Main bedroom')).not.toContainText('in the renovation');
  });

  test('28: a view link: the panel opens with the viewer’s own household, and saves nothing', async ({
    page,
    browser,
  }) => {
    test.setTimeout(90_000);
    await openFurnished(page);
    await page.keyboard.press('1');
    await page.getByRole('button', { name: 'Share' }).click();
    const viewLink = await page.getByLabel('View-only link').inputValue();
    await page.keyboard.press('Escape');

    const viewer = await (await browser.newContext()).newPage();
    const writes: string[] = [];
    viewer.on('request', (r) => {
      if (r.method() !== 'GET' && r.url().includes('/api/'))
        writes.push(`${r.method()} ${r.url()}`);
    });
    await viewer.goto(viewLink);
    await expect(viewer.getByText('View only.')).toBeVisible();
    await viewer.keyboard.press('1');
    await seeStorage(viewer);
    // Nothing can be added on a view link: no Add link where nothing is drawn.
    await expect(meter(viewer, 'shoes')).toContainText('No shoe cabinet drawn');
    await expect(viewer.getByRole('button', { name: 'Add a shoe cabinet' })).toHaveCount(0);
    await viewer
      .locator('.storage-oneline')
      .getByRole('button', { name: /Change|Done/ })
      .click();
    const more = viewer.getByRole('button', { name: 'More children in Bedroom' });
    if (!(await more.isVisible())) {
      await viewer.locator('.storage-oneline').getByRole('button', { name: 'Change' }).click();
    }
    await viewer.getByRole('button', { name: 'More children in Bedroom' }).click();
    await expect(card(viewer, 'Bedroom')).toContainText('1 adult and 1 child');
    await viewer.waitForTimeout(2500);
    expect(writes).toEqual([]);
    // The owner's panel still guesses from the beds.
    await seeStorage(page);
    await expect(card(page, 'Bedroom')).toContainText('about 1.00 m is usual');
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

  test('27: the sheet by finger: the row, people, a wardrobe added and resized, a card pans', async ({
    page,
  }) => {
    await openFurnished(page);
    await page.evaluate(() => document.fonts.ready);
    // 17. The row in the plan details, then the half-height sheet with its footer pinned.
    await page.getByRole('button', { name: 'Show plan details' }).tap();
    await expect(page.getByTestId('storage-summary')).toContainText('could use more');
    await seeStorage(page, true);
    await expect(page.locator('.inspector.inspector-storage')).toBeVisible();
    const sheet = await page.locator('.inspector').boundingBox();
    const vh = page.viewportSize()?.height ?? 844;
    expect(sheet?.height ?? 0).toBeLessThanOrEqual(vh * 0.5 + 1);
    const foot = page.locator('.storage-foot');
    await expect(foot.getByRole('button', { name: 'Copy summary' })).toBeInViewport();
    expect(
      (await foot.getByRole('button', { name: 'Close' }).boundingBox())?.height,
    ).toBeGreaterThanOrEqual(44);
    // One line for the household, Change to open it.
    await expect(page.getByTestId('storage-household')).toHaveText(
      '3 people (guessed from the beds): 1 in Bedroom, 2 in Main bedroom',
    );
    await page.locator('.storage-oneline').getByRole('button', { name: 'Change' }).tap();
    const bedroom = page.locator('.storage-people[data-room="Bedroom"]');
    await expect(bedroom).toContainText('Guessed from the beds');
    // 20. The steppers are thumb-sized; a child added by finger.
    const plus = bedroom.getByRole('button', { name: 'More children in Bedroom' });
    const box = await plus.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    await plus.scrollIntoViewIfNeeded();
    await plus.tap();
    await expect(card(page, 'Bedroom')).toContainText('about 1.60 m is usual');
    await expect(bedroom).not.toContainText('Guessed from the beds');
    expect(await overflows(page)).toBe(false);
    await page.getByRole('button', { name: 'Reset to the beds' }).tap();
    await expect(card(page, 'Bedroom')).toContainText('about 1.00 m is usual');

    // A card tapped: the plan above the sheet pans to the room, outlined.
    const before = await page.evaluate(() =>
      document.querySelector('[id^="plan-scene"] > g[transform]')?.getAttribute('transform'),
    );
    const name = card(page, 'Kitchen').getByRole('button', { name: 'Kitchen: show on the plan' });
    await name.scrollIntoViewIfNeeded();
    expect((await name.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    await name.tap();
    await expect(page.getByTestId('storage-highlight')).toHaveCount(1);
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.querySelector('[id^="plan-scene"] > g[transform]')?.getAttribute('transform'),
        ),
      )
      .not.toBe(before);
    // Readable chips: 11 px, short on a phone.
    await page.getByRole('button', { name: 'Fit plan' }).tap();
    const c = chip(page).filter({ hasText: '1.2 of 2.0 m' });
    await expect(c).toBeVisible();
    const th = await c.locator('text').evaluate((t) => t.getBoundingClientRect().height);
    expect(th).toBeGreaterThanOrEqual(10);

    // Add a shoe cabinet by finger: the sheet stays, a bar over the plan says what to do.
    const add = meter(page, 'shoes').getByRole('button', { name: 'Add a shoe cabinet' });
    await add.scrollIntoViewIfNeeded();
    await add.tap();
    await expect(page.locator('.storage-add-bar')).toContainText('Tap where the shoe cabinet goes');
    await expect(panel(page)).toBeVisible();
    const spot = await at(page, 9.85, 5.3);
    await page.touchscreen.tap(spot.x, spot.y);
    await expect(page.locator('.storage-add-bar')).toHaveCount(0);
    await expect(panel(page)).toBeVisible();
    await expect(meter(page, 'shoes')).toContainText('15 of 28 pairs');

    // 18. A built-in wardrobe in Bedroom, by finger: the chip turns neutral.
    await place(page, /^Built-in wardrobe/, 4.3, 2.8, true);
    await expect(page.getByRole('heading', { name: 'Built-in wardrobe' })).toBeVisible();
    await expect(chip(page).filter({ hasText: '1.8 of 1.0 m' })).not.toHaveClass(
      /storage-chip-warn/,
    );
    await expect(page.getByTestId('item-storage')).toContainText('Storage: 1.80 m of wardrobe');

    // 19. The Main bedroom wardrobe, tapped, then its corner dragged by finger: the chip
    // reads the new width before the finger lifts is not required, after it is.
    await page.getByRole('button', { name: 'Clear selection' }).tap();
    await page.getByRole('button', { name: /^Select/ }).tap();
    const grip = await at(page, 0.6, 1.6);
    await page.touchscreen.tap(grip.x, grip.y);
    await expect(page.getByRole('heading', { name: 'Wardrobe' })).toBeVisible();
    const from = await at(page, 0.9, 2.2);
    const f = await finger(page, from);
    await f.moveTo(await at(page, 0.9, 3.4));
    await f.lift();
    await expect(page.getByTestId('item-storage')).toContainText(/Storage: 2\.\d\d m of wardrobe/);
    await expect(chip(page).filter({ hasText: /^2\.\d of 2\.0 m$/ })).not.toHaveClass(
      /storage-chip-warn/,
    );
    expect(await overflows(page)).toBe(false);
  });
});
