import { waitSaved } from './helpers';
import { type Locator, type Page, devices, expect, test } from './test';

/**
 * The lift and an editable sofa diagonal (docs/specs/slice-2s.md, B1 criteria 9–15 and B2
 * criteria 3–5), on a desktop and on a 390 px phone by finger.
 */

const way = (page: Page) => page.getByRole('region', { name: 'Getting it in' });
const verdict = (page: Page) => page.getByTestId('way-verdict');
const liftLine = (page: Page) => page.getByTestId('lift-line');
const liftSelect = (page: Page) => page.getByLabel('Lift', { exact: true });
const diagonal = (page: Page) => page.getByLabel('Diagonal depth', { exact: true });

const TOO_WIDE = /^Too big for the lift door: 0\.90\sm wide; it needs 0\.95\sm on its side\.$/;
const STAND_UP =
  /^Too long to stand up in the lift: at 2\.10\sm long, it can’t be turned upright through a 2\.00\sm high door into a 1\.40\sm deep car\.$/;
const ASK_SHOP =
  'Ask the shop whether it comes apart, or measure your lift: these sizes are typical.';

/** Taps on a phone, clicks on a desktop. */
const press = (l: Locator, finger: boolean) => (finger ? l.tap() : l.click());

/** Adds a piece of one's own by size (a sofa), ready to place. */
async function addSofa(
  page: Page,
  name: string,
  size: [string, string, string],
  opts: { diagonal?: string; finger?: boolean } = {},
) {
  const finger = !!opts.finger;
  await press(page.getByRole('button', { name: /^Furniture/ }), finger);
  await press(page.getByRole('button', { name: /^Add by size/ }), finger);
  const dialog = page.getByRole('dialog', { name: 'Add your furniture' });
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByLabel('Width').fill(size[0]);
  await dialog.getByLabel('Depth', { exact: true }).fill(size[1]);
  await dialog.getByLabel('Height').fill(size[2]);
  if (opts.diagonal) await dialog.getByLabel('Diagonal depth (optional)').fill(opts.diagonal);
  await press(dialog.getByRole('button', { name: 'Add and place it' }), finger);
  await expect(dialog).toHaveCount(0);
}

/** A point in a room that the plan shows (not under the phone's sheet or the bars). */
async function inRoom(page: Page, room: string, fx = 0.5, fy = 0.5) {
  const r = await page.locator(`[data-hit="room:${room}"]`).boundingBox();
  const plan = await page.locator('svg.plan-svg').boundingBox();
  if (!r || !plan) throw new Error(`no ${room}`);
  const x0 = Math.max(r.x, plan.x);
  const x1 = Math.min(r.x + r.width, plan.x + plan.width);
  const y0 = Math.max(r.y, plan.y);
  const y1 = Math.min(r.y + r.height, plan.y + plan.height);
  return { x: x0 + (x1 - x0) * fx, y: y0 + (y1 - y0) * fy };
}

async function placeIn(page: Page, room: string, name: string, finger = false, fx = 0.5, fy = 0.5) {
  const p = await inRoom(page, room, fx, fy);
  if (finger) await page.touchscreen.tap(p.x, p.y);
  else await page.mouse.click(p.x, p.y);
  await expect(page.getByRole('heading', { name })).toBeVisible();
}

test.describe('desktop', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitSaved(page);
    await page.keyboard.press('1');
  });

  test('9, 10, 12–14: a typical lift, the diagonal, my measurements, undo and no lift', async ({
    page,
  }) => {
    await addSofa(page, 'My sofa', ['2.1', '1.0', '0.95']);
    await placeIn(page, 'rm_living-and-dining', 'My sofa', false, 0.4);
    // Not checked yet: the doors' verdict, and a question about the lift.
    await expect(verdict(page)).toHaveText(/^(Just f|F)its through every door on the way in/);
    await expect(liftSelect(page)).toHaveValue('unset');
    await expect(liftLine(page)).toHaveText('Lift: not checked.');
    await expect(way(page).getByTestId('lift-hint')).toHaveText(
      /^Which lift does your block have\? Most HDB lift doors are 0\.8–0\.9\sm wide\.$/,
    );

    // 9: a typical lift: too wide for its door, said in the status that's read out.
    await liftSelect(page).selectOption({ label: 'Typical HDB lift' });
    await expect(way(page).getByRole('status')).toContainText('Too big for the lift door');
    await expect(verdict(page)).toHaveText(TOO_WIDE);
    await expect(verdict(page)).toHaveClass(/warning-text/);
    // Under it, in the status line's place (so nothing below jumps), what to ask.
    await expect(liftLine(page)).toHaveText(ASK_SHOP);
    await expect(way(page).getByTestId('lift-hint')).toHaveText(
      /^Door 0\.90 × 2\.00\sm · car 1\.10 wide × 1\.40 deep × 2\.30\sm high\. Same lift for every piece in this plan\.$/,
    );

    // 10: its diagonal (B2): it clears the door tilted, but can't be stood up in the car.
    await way(page).getByRole('button', { name: 'Add diagonal depth' }).click();
    await expect(diagonal(page)).toBeFocused();
    await expect(diagonal(page)).toBeInViewport();
    await diagonal(page).fill('0.80');
    await diagonal(page).press('Enter');
    await expect(verdict(page)).toHaveText(STAND_UP);
    await expect(way(page).getByRole('button', { name: 'Add diagonal depth' })).toHaveCount(0);

    // 12: my measurements, from the typical lift, one step; a lower car: no pose fits.
    await liftSelect(page).focus();
    await liftSelect(page).selectOption({ label: 'My measurements…' });
    await expect(liftSelect(page)).toBeFocused();
    const fields = page.getByRole('group', { name: 'Lift measurements' });
    const carHeight = fields.getByLabel('Car height');
    await expect(carHeight).toHaveValue('2.30 m');
    await expect(fields.getByLabel('Door width')).toHaveValue('0.90 m');
    await expect(way(page).getByTestId('lift-hint')).toHaveText(
      'Car width is across the door; depth is from the door to the back wall.',
    );
    await expect(verdict(page)).toHaveText(STAND_UP);
    await carHeight.fill('2.00');
    await carHeight.press('Enter');
    await expect(verdict(page)).toHaveText(
      /^Doesn’t fit in the lift \(1\.10 × 1\.40\sm, 2\.00\sm high\), even on end or tilted\.$/,
    );
    await expect(liftLine(page)).toHaveText('Ask the shop whether it comes apart.');

    // Each field gives its own range, and a door wider than the car is refused: nothing saved.
    const carWidth = fields.getByLabel('Car width');
    await carWidth.fill('0.5');
    await carWidth.press('Enter');
    await expect(carWidth).toHaveAttribute('aria-invalid', 'true');
    await expect(carWidth).toHaveAccessibleDescription(/^Between 0\.8 and 3\.0\sm\.$/);
    await carWidth.press('Escape');
    const doorWidth = fields.getByLabel('Door width');
    await doorWidth.fill('1.2');
    await doorWidth.press('Enter');
    await expect(doorWidth).toHaveAccessibleDescription('The door can’t be wider than the car.');
    // Refused on Enter: still in the field, its text selected to type again.
    await expect(doorWidth).toBeFocused();
    expect(
      await doorWidth.evaluate(
        (el: HTMLInputElement) => (el.selectionEnd ?? 0) - (el.selectionStart ?? 0),
      ),
    ).toBe(3);
    await doorWidth.press('Escape');
    await expect(page.getByRole('heading', { name: 'My sofa' })).toBeVisible();
    await expect(doorWidth).toHaveValue('0.90 m');
    await expect(verdict(page)).toContainText('2.00');

    // 13: undo: the car's height, then the lift as typical.
    await page.keyboard.press('Control+z');
    await expect(carHeight).toHaveValue('2.30 m');
    await page.keyboard.press('Control+z');
    await expect(liftSelect(page)).toHaveValue('typical');
    await expect(fields).toHaveCount(0);

    // 10: a shorter sofa on its diagonal goes in the lift stood on end.
    await page.keyboard.press('Escape');
    await addSofa(page, 'Short sofa', ['1.8', '1.0', '0.95'], { diagonal: '0.80' });
    await placeIn(page, 'rm_living-and-dining', 'Short sofa', false, 0.7);
    await expect(liftLine(page)).toHaveText('Lift: fits stood on end.');
    await expect(way(page).getByRole('status')).toContainText('Lift: fits stood on end.');
    await expect(verdict(page)).toHaveText(/^(Just f|F)its through every door on the way in/);

    // 14: no lift: no "Lift:" line, but the status says so (a change is read out), and a
    // hint says why.
    await liftSelect(page).selectOption({ label: 'No lift' });
    await expect(liftLine(page)).toHaveText('No lift on the way in.');
    await expect(way(page).getByRole('status')).not.toContainText('Lift:');
    await expect(way(page).getByTestId('lift-hint')).toHaveText(
      'Ground floor or a house: the way in starts at the main door.',
    );
    await page.keyboard.press('Control+z');
    await expect(liftSelect(page)).toHaveValue('typical');
    await expect(liftLine(page)).toHaveText('Lift: fits stood on end.');
  });

  test('11: kept with the plan; a view link shows the same Lift line, its choice disabled', async ({
    page,
    browser,
  }) => {
    test.setTimeout(90_000);
    await addSofa(page, 'Short sofa', ['1.8', '1.0', '0.95'], { diagonal: '0.80' });
    await placeIn(page, 'rm_living-and-dining', 'Short sofa');
    await liftSelect(page).selectOption({ label: 'Typical HDB lift' });
    await expect(liftLine(page)).toHaveText('Lift: fits stood on end.');
    await waitSaved(page);
    await page.reload();
    await waitSaved(page);
    await page.keyboard.press('1');
    const sofa = page.locator('[data-hit^="item:"]');
    await expect(sofa).toHaveCount(1);
    await sofa.click({ force: true });
    await expect(liftSelect(page)).toHaveValue('typical');
    await expect(liftLine(page)).toHaveText('Lift: fits stood on end.');

    await page.getByRole('button', { name: 'Share' }).click();
    const viewLink = await page.getByLabel('View-only link').inputValue();
    await page.keyboard.press('Escape');
    const viewer = await (await browser.newContext()).newPage();
    await viewer.goto(viewLink);
    await expect(viewer.getByText('View only.')).toBeVisible();
    await viewer.keyboard.press('1');
    await expect(viewer.locator('[data-hit^="item:"]')).toHaveCount(1);
    await viewer.locator('[data-hit^="item:"]').click({ force: true });
    await expect(liftLine(viewer)).toHaveText('Lift: fits stood on end.');
    await expect(liftSelect(viewer)).toBeDisabled();
    await expect(liftSelect(viewer)).toHaveValue('typical');
    await expect(way(viewer).getByTestId('lift-hint')).toHaveText(
      /^Door 0\.90 × 2\.00\sm · car 1\.10 wide × 1\.40 deep × 2\.30\sm high\. Set by whoever can edit the plan\.$/,
    );
    // Shown, not greyed out.
    const look = await liftSelect(viewer).evaluate((el) => getComputedStyle(el).opacity);
    expect(look).toBe('1');
    await viewer.context().close();
  });

  test('B2 3–5: the diagonal in the details: tilted through the Bedroom door, a range, resized', async ({
    page,
  }) => {
    await addSofa(page, 'My sofa', ['2.1', '1.0', '0.95']);
    await placeIn(page, 'rm_bedroom', 'My sofa');
    // 3: too big for the Bedroom door, with a way to add the diagonal.
    const before = /^Too big for the Bedroom door/;
    await expect(verdict(page)).toHaveText(before);
    await expect(way(page)).toContainText(
      'Measured its diagonal depth? Tilted, it may get through.',
    );
    await expect(diagonal(page)).toHaveValue('');
    await expect(diagonal(page)).toHaveAttribute('placeholder', 'Not measured');
    await expect(diagonal(page)).toHaveAccessibleDescription(/For this sofa: 0\.69–0\.95\sm\./);

    // 4: longer than it is deep or high: refused, nothing changes.
    await diagonal(page).fill('1.5');
    await diagonal(page).press('Enter');
    await expect(diagonal(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(diagonal(page)).toHaveAccessibleDescription(
      /^Between 0\.69 and 0\.95\sm for this sofa\.$/,
    );
    await expect(verdict(page)).toHaveText(before);
    await diagonal(page).press('Escape');

    // 3: 0.80: it fits, tilted through the Bedroom door, and the plan says so.
    await way(page).getByRole('button', { name: 'Add diagonal depth' }).click();
    await expect(diagonal(page)).toBeFocused();
    await diagonal(page).fill('0.80');
    await diagonal(page).press('Enter');
    // Said after the narrowest door, or of the Bedroom door when another is tighter.
    await expect(verdict(page)).toHaveText(
      /^(Just f|F)its through every door on the way in\. Narrowest: .*(the Bedroom door, 0\.\d\d\sm \(tilted on its diagonal\)\.|Tilted on its diagonal through the Bedroom door\.)$/,
    );
    await expect(page.locator('.way text', { hasText: ', tilted' })).toHaveCount(1);
    await expect(page.locator('.way-bad')).toHaveCount(0);
    await page.keyboard.press('Control+z');
    await expect(verdict(page)).toHaveText(before);
    await expect(diagonal(page)).toHaveValue('');
    await page.keyboard.press('Control+Shift+z');
    await expect(diagonal(page)).toHaveValue('0.80 m');

    // 5: made bigger by a corner handle: the diagonal was measured on the sofa as added.
    await expect(diagonal(page)).not.toHaveAccessibleDescription(/Measured on the sofa/);
    const c = await page.locator('.size-handle').nth(2).boundingBox();
    if (!c) throw new Error('no corner');
    const from = { x: c.x + c.width / 2, y: c.y + c.height / 2 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 20, from.y + 20, { steps: 5 });
    await page.mouse.up();
    await expect(diagonal(page)).toHaveAccessibleDescription(
      /Measured on the sofa at 2\.10 × 1\.00 × 0\.95\sm; scaled with this piece\.$/,
    );
    // Emptied, it's not measured again.
    await diagonal(page).fill('');
    await diagonal(page).press('Enter');
    await expect(diagonal(page)).toHaveValue('');
    await expect(way(page)).toContainText('Measured its diagonal depth?');
  });

  test('a bed comes flat: a queen mattress folds for the lift; a king’s doesn’t, so ask the shop', async ({
    page,
  }) => {
    const addBed = async (name: string, w: string, x: number) => {
      await page.getByRole('button', { name: /^Furniture/ }).click();
      await page.getByRole('button', { name: /^Add by size/ }).click();
      const dialog = page.getByRole('dialog', { name: 'Add your furniture' });
      await dialog.getByLabel('Name').fill(name);
      await dialog.getByRole('button', { name: 'Bed' }).click();
      await dialog.getByLabel('Width').fill(w);
      await dialog.getByLabel('Depth', { exact: true }).fill('1.90');
      await dialog.getByLabel('Height').fill('0.30');
      await dialog.getByRole('button', { name: 'Add and place it' }).click();
      await placeIn(page, 'rm_living-and-dining', name, false, x);
    };
    const status = way(page).getByRole('status');
    await addBed('Queen mattress', '1.52', 0.7);
    await liftSelect(page).selectOption({ label: 'Typical HDB lift' });
    await expect(status.locator('p').first()).toHaveText(
      'Comes flat: the mattress (folded in half) and frame panels each fit.',
    );
    await expect(verdict(page)).toHaveText(/^Fits through every door on the way in\./);
    await expect(verdict(page)).not.toHaveClass(/warning-text/);
    await expect(liftLine(page)).toHaveText('Lift: each part fits.');

    await page.keyboard.press('Escape');
    await addBed('King mattress', '1.83', 0.3);
    await expect(status.locator('p').first()).toHaveText(
      'Comes flat, but the mattress (too wide to fold) doesn’t fit; ask the shop.',
    );
    await expect(verdict(page)).toHaveText(/^Doesn’t fit in the lift /);
    await expect(verdict(page)).toHaveClass(/warning-text/);
    await expect(way(page)).not.toContainText('comes apart');
    await expect(way(page).getByText(/ask the shop/)).toHaveCount(1);
  });

  test('a panel 18 mm thick can be added by size', async ({ page }) => {
    await page.getByRole('button', { name: /^Furniture/ }).click();
    await page.getByRole('button', { name: /^Add by size/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Add your furniture' });
    await dialog.getByLabel('Name').fill('Wardrobe panel');
    await dialog.getByRole('button', { name: 'Box' }).click();
    await dialog.getByLabel('Width').fill('600');
    await dialog.getByLabel('Depth', { exact: true }).fill('18 mm');
    await dialog.getByLabel('Height').fill('2100');
    await dialog.getByRole('button', { name: 'Add and place it' }).click();
    await expect(dialog).toHaveCount(0);
  });

  test('a diagonal saved out of range is called out until it is re-entered', async ({ page }) => {
    await addSofa(page, 'My sofa', ['2.1', '1.0', '0.95']);
    await placeIn(page, 'rm_bedroom', 'My sofa');
    await waitSaved(page);
    // As saved before the range was corrected: wider than the sofa is deep or high.
    const id = new URL(page.url()).searchParams.get('p');
    // This browser's owner key for the plan (see src/keys.ts).
    const owner = await page.evaluate(
      (p) =>
        (JSON.parse(localStorage.getItem(`dhd:keys:${p}`) ?? '{}') as { owner?: string }).owner,
      id,
    );
    const auth = { Authorization: `Bearer ${owner}` };
    const got = await page.request.get(`/api/projects/${id}`, { headers: auth });
    const doc = await got.json();
    for (const m of Object.values(doc.models as Record<string, { diagonal?: number }>)) {
      m.diagonal = 1.2;
    }
    const put = await page.request.put(`/api/projects/${id}`, {
      data: doc,
      headers: { ...auth, 'If-Match': got.headers().etag ?? '' },
    });
    expect(put.ok()).toBe(true);
    await page.reload();
    await waitSaved(page);
    await page.keyboard.press('1');
    await page.locator('[data-hit^="item:"]').click({ force: true });
    await expect(diagonal(page)).toHaveValue('1.20 m');
    await expect(diagonal(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(diagonal(page)).toHaveAccessibleDescription(
      /^Between 0\.69 and 0\.95\sm for this sofa\.$/,
    );
    // It gets no one through a door: the way to measure it again is still offered.
    await expect(way(page).getByRole('button', { name: 'Add diagonal depth' })).toBeVisible();
    await diagonal(page).fill('0.80');
    await diagonal(page).press('Enter');
    await expect(diagonal(page)).toHaveAttribute('aria-invalid', 'false');
    await expect(diagonal(page)).toHaveAccessibleDescription(/For this sofa: 0\.69–0\.95\sm\./);
    await expect(way(page).getByRole('button', { name: 'Add diagonal depth' })).toHaveCount(0);
  });
});

/** Whether anything on the page or in the sheet scrolls sideways. */
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

  test('15: by finger: the verdict first in the sheet, a decimal keypad, 44 px buttons, no sideways scroll', async ({
    page,
  }) => {
    await page.goto('/');
    await waitSaved(page);
    await page.evaluate(() => document.fonts.ready);
    await addSofa(page, 'My sofa', ['2.1', '1.0', '0.95'], { finger: true });
    // Clear of the walkway, so no clearance lines come before the way in.
    await placeIn(page, 'rm_living-and-dining', 'My sofa', true, 0.8, 0.3);
    // The verdict comes first: in the sheet's first view.
    await expect(verdict(page)).toBeInViewport();
    // Scrolled down to the lift: once chosen, the sheet brings the answer back into view.
    await liftSelect(page).scrollIntoViewIfNeeded();
    await liftSelect(page).selectOption({ label: 'Typical HDB lift' });
    await expect(verdict(page)).toHaveText(TOO_WIDE);
    await expect(verdict(page)).toBeInViewport({ ratio: 1 });
    expect(await overflows(page)).toBe(false);
    const ask = way(page).getByRole('button', { name: 'Add diagonal depth' });
    const box = await ask.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);

    // The button takes the finger to the field, ready to type.
    await ask.tap();
    await expect(diagonal(page)).toBeFocused();
    await expect(diagonal(page)).toBeInViewport();
    await expect(diagonal(page)).toHaveAttribute('inputmode', 'decimal');
    await diagonal(page).fill('0.80');
    await diagonal(page).press('Enter');
    await expect(verdict(page)).toHaveText(STAND_UP);

    // My measurements: decimal keypads, two to a row, and nothing scrolls sideways.
    await liftSelect(page).selectOption({ label: 'My measurements…' });
    const fields = page.getByRole('group', { name: 'Lift measurements' });
    for (const name of ['Door width', 'Door height', 'Car width', 'Car depth', 'Car height']) {
      const f = fields.getByLabel(name);
      await expect(f).toHaveAttribute('inputmode', 'decimal');
      await expect(f).toHaveAttribute('enterkeyhint', 'done');
      const b = await f.boundingBox();
      expect(b?.height ?? 0, name).toBeGreaterThanOrEqual(44);
    }
    // Two to a row (read together: the sheet may still be scrolling to the verdict).
    const rows = await fields.evaluate((f) =>
      ['Door width', 'Door height'].map(
        (n) =>
          [...f.querySelectorAll('label')].find((l) => l.textContent === n)?.getBoundingClientRect()
            .y,
      ),
    );
    expect(Math.abs((rows[0] ?? 0) - (rows[1] ?? 1))).toBeLessThan(2);
    expect(await overflows(page)).toBe(false);
    const carHeight = fields.getByLabel('Car height');
    await carHeight.tap();
    await carHeight.fill('2.00');
    await carHeight.press('Enter');
    await expect(verdict(page)).toHaveText(
      /^Doesn’t fit in the lift \(1\.10 × 1\.40\sm, 2\.00\sm high\)/,
    );
    await expect(verdict(page)).toBeInViewport({ ratio: 1 });
    expect(await overflows(page)).toBe(false);
  });
});
