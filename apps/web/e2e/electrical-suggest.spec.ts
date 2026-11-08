import { waitSaved } from './helpers';
import { type Locator, type Page, devices, expect, test } from './test';

/**
 * Suggested electrical points (docs/specs/slice-2s.md, A): criteria 18–24, on a desktop and on
 * a 390 px phone by finger.
 */

const ghosts = (page: Page) => page.getByTestId('suggest-ghost');
const ghost = (page: Page, key: string) => page.locator(`[data-ghost="${key}"]`);
const realPoints = (page: Page) =>
  page.locator('[data-testid="electrical-layer"] [data-hit^="point:"]');
const row = (page: Page, room: string) =>
  page.locator(`[data-testid="suggest-row"][data-room="${room}"]`);

/** "4 points · about $320–580" → 4. */
async function count(r: Locator): Promise<number> {
  const text = (await r.getByTestId('suggest-meta').textContent()) ?? '';
  return Number(/^(\d+) points?/.exec(text)?.[1] ?? Number.NaN);
}

/** "about $1,760–3,230" → [1760, 3230]. */
function dollars(text: string): [number, number] {
  const m = /\$([\d,]+)(?:–([\d,]+))?/.exec(text);
  if (!m) throw new Error(`no amount in ${text}`);
  const low = Number((m[1] ?? '').replace(/,/g, ''));
  return [low, m[2] ? Number(m[2].replace(/,/g, '')) : low];
}

/** The centre of a ghost's ring on the screen. */
async function ringCentre(page: Page, key: string) {
  const b = await ghost(page, key).locator('.sg-ring').boundingBox();
  if (!b) throw new Error(`no ghost ${key}`);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

async function roomBox(page: Page, id: string) {
  const box = await page.locator(`[data-hit="room:${id}"]`).boundingBox();
  if (!box) throw new Error(`no room ${id}`);
  return box;
}

async function planPng(page: Page): Promise<Buffer> {
  await page.getByRole('button', { name: 'Projects' }).click();
  const [file] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    page.getByRole('button', { name: 'Plan as a picture (PNG)', exact: true }).click(),
  ]);
  return Buffer.concat((await (await file.createReadStream()).toArray()) as Buffer[]);
}

const LIGHT = 'rm_main-bedroom:light';

test.describe('desktop', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitSaved(page);
    await page.keyboard.press('1');
  });

  test('18: ghosts appear with the Electrical view on; each room has a count and a cost; no points are added', async ({
    page,
  }) => {
    // Off first: suggesting turns the Electrical view on.
    await page.getByLabel('Electrical', { exact: true }).uncheck();
    await page.getByRole('button', { name: 'Suggest points' }).click();
    await expect(ghosts(page).first()).toBeVisible();
    // Focus starts at the panel.
    await expect(page.getByRole('heading', { name: 'Suggested points' })).toBeFocused();
    const rows = page.getByTestId('suggest-row');
    expect(await rows.count()).toBeGreaterThan(4);
    for (const meta of await page.getByTestId('suggest-meta').all()) {
      await expect(meta).toHaveText(/^\d+ points? · (about \$[\d,]+|no charge)/);
    }
    await expect(page.getByTestId('suggest-total')).toHaveText(/points in \d+ rooms · about \$/);
    await expect(realPoints(page)).toHaveCount(0);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.getByLabel('Electrical', { exact: true })).toBeChecked();
    // The plan details still count no points.
    await expect(page.locator('.elec-summary-row .num')).toHaveCount(0);
  });

  test('19: a click on a ghost leaves it out (the count drops, the ring shows ×); again brings it back', async ({
    page,
  }) => {
    await page.getByRole('button', { name: 'Suggest points' }).click();
    const r = row(page, 'rm_main-bedroom');
    const n = await count(r);
    const at = await ringCentre(page, LIGHT);
    await page.mouse.click(at.x, at.y);
    await expect(ghost(page, LIGHT)).toHaveAttribute('data-left-out', 'true');
    await expect(ghost(page, LIGHT).locator('.sg-x')).toHaveCount(1);
    expect(await count(r)).toBe(n - 1);
    await expect(page.getByTestId('suggest-status')).toContainText(
      'Left out: light, Main bedroom. Click again',
    );
    // Above the foot, in view however long the list.
    await expect(page.getByTestId('suggest-status')).toBeInViewport();
    await page.mouse.click(at.x, at.y);
    await expect(ghost(page, LIGHT)).not.toHaveAttribute('data-left-out', 'true');
    expect(await count(r)).toBe(n);
    // The tick box agrees.
    await r.getByText('Show points').click();
    await expect(r.getByRole('checkbox', { name: /Light · Ceiling/ })).toBeChecked();
    await r.getByRole('checkbox', { name: /Light · Ceiling/ }).uncheck();
    await expect(ghost(page, LIGHT)).toHaveAttribute('data-left-out', 'true');
  });

  test('20: Add on Main bedroom makes real points in one undo step, and its row goes', async ({
    page,
  }) => {
    await page.getByRole('button', { name: 'Suggest points' }).click();
    const r = row(page, 'rm_main-bedroom');
    const n = await count(r);
    await r.getByRole('button', { name: `Add ${n}` }).click();
    await expect(r).toHaveCount(0);
    await expect(realPoints(page)).toHaveCount(n);
    await expect(page.locator('.toast')).toContainText(`Added ${n} points to Main bedroom.`);
    // Focus moves on to the next room's Add.
    await expect(page.locator(':focus')).toHaveAttribute('data-add-room', /.+/);
    // Real points: the light selects as one.
    await expect(ghost(page, LIGHT)).toHaveCount(0);
    const light = page.locator('[data-testid="electrical-layer"] [data-kind="light"] .elec-hit');
    const b = await light.boundingBox();
    if (!b) throw new Error('no light');
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    await expect(page.getByRole('heading', { name: 'Light point' })).toBeVisible();
    await page.keyboard.press('Escape');
    // One undo takes them all back.
    await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
    await expect(realPoints(page)).toHaveCount(0);
    await expect(row(page, 'rm_main-bedroom')).toBeVisible();
  });

  test('a room added with a point left out leaves the list; undo brings it back', async ({
    page,
  }) => {
    await page.getByRole('button', { name: 'Suggest points' }).click();
    const r = row(page, 'rm_main-bedroom');
    const at = await ringCentre(page, LIGHT);
    await page.mouse.click(at.x, at.y);
    const n = await count(r);
    await r.getByRole('button', { name: `Add ${n}` }).click();
    await expect(r).toHaveCount(0);
    await expect(ghost(page, LIGHT)).toHaveCount(0);
    await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
    await expect(row(page, 'rm_main-bedroom')).toBeVisible();
  });

  test('21: Add all raises the estimate’s Electrical subtotal by the panel’s total; then nothing is left', async ({
    page,
  }) => {
    await page.getByRole('button', { name: 'Suggest points' }).click();
    const total = dollars((await page.getByTestId('suggest-total').textContent()) ?? '');
    const n = Number(
      /Add all (\d+)/.exec(
        (await page.getByRole('button', { name: /^Add all/ }).textContent()) ?? '',
      )?.[1],
    );
    await page.getByRole('button', { name: /^Add all/ }).click();
    await expect(page.getByRole('heading', { name: 'Suggested points' })).toHaveCount(0);
    await expect(page.locator('.toast')).toContainText(`Added ${n} points.`);
    await expect(realPoints(page)).toHaveCount(n);
    // Focus is back on the button that opened it.
    await expect(page.locator(':focus')).toHaveText('Suggest points');

    await page.locator('.cost-summary').getByRole('button', { name: 'See estimate' }).click();
    const dialog = page.getByRole('dialog', { name: 'Cost estimate' });
    const head = dialog.getByRole('region', { name: 'Electrical' }).locator('.estimate-group-head');
    const sub = dollars((await head.textContent()) ?? '');
    expect(Math.abs(sub[0] - total[0])).toBeLessThanOrEqual(10);
    expect(Math.abs(sub[1] - total[1])).toBeLessThanOrEqual(10);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();

    await page.getByRole('button', { name: 'Suggest points' }).click();
    await expect(page.getByText('Every room has its points: nothing to suggest.')).toBeVisible();
    await expect(ghosts(page)).toHaveCount(0);
  });

  test('22: Close or Esc adds nothing; the plan’s picture has no ghosts; a view link has no Suggest points', async ({
    page,
    browser,
  }) => {
    test.setTimeout(150_000);
    const without = await planPng(page);
    await page.getByRole('button', { name: 'Suggest points' }).click();
    await expect(ghosts(page).first()).toBeVisible();
    // The PNG is the plan as shown, less the ghosts.
    const withPanel = await planPng(page);
    expect(withPanel.equals(without)).toBe(true);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(ghosts(page)).toHaveCount(0);
    await expect(realPoints(page)).toHaveCount(0);

    await page.getByRole('button', { name: 'Suggest points' }).click();
    await expect(ghosts(page).first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(ghosts(page)).toHaveCount(0);
    await expect(realPoints(page)).toHaveCount(0);
    await expect(page.locator(':focus')).toHaveText('Suggest points');

    // In the Electrical tool too, and not in a view link.
    await page.getByRole('button', { name: /^Electrical/ }).click();
    await expect(
      page.locator('.palette').getByRole('button', { name: 'Suggest points' }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await waitSaved(page);
    await page.getByRole('button', { name: 'Share' }).click();
    const viewLink = await page.getByLabel('View-only link').inputValue();
    await page.keyboard.press('Escape');
    const viewer = await (await browser.newContext()).newPage();
    await viewer.goto(viewLink);
    await expect(viewer.getByText('View only.')).toBeVisible();
    await expect(viewer.getByRole('heading', { name: 'Rooms' })).toBeVisible();
    await expect(viewer.getByRole('button', { name: 'Suggest points' })).toHaveCount(0);
  });

  test('24: a bed dropped in Main bedroom while the panel is open brings bedside ghosts', async ({
    page,
  }) => {
    await page.getByRole('button', { name: 'Suggest points' }).click();
    await expect(ghosts(page).first()).toBeVisible();
    await expect(page.locator('[data-ghost*=":bedside:"]')).toHaveCount(0);
    await page.getByRole('button', { name: /^Furniture/ }).click();
    await page
      .locator('.palette')
      .getByRole('button', { name: /^Queen bed/ })
      .click();
    const r = await roomBox(page, 'rm_main-bedroom');
    // Near the top wall, where it snaps back to the wall.
    await page.mouse.click(r.x + r.width * 0.45, r.y + r.height * 0.25);
    await expect(page.locator('[data-ghost*=":bedside:"]').first()).toBeVisible();
    // The bed is selected as it lands; with it let go, the panel is back, with the sockets.
    await page.keyboard.press('Escape');
    await expect(row(page, 'rm_main-bedroom')).toContainText('bedside socket');
  });
});

test.describe('in a renovation', () => {
  test('points go in the renovation: on Before the panel says so and offers After', async ({
    page,
  }) => {
    await page.goto('/');
    await waitSaved(page);
    await page.keyboard.press('1');
    await page.getByRole('button', { name: 'Plan a renovation' }).click();
    await page.locator('.reno-bar').getByRole('button', { name: 'Before' }).click();
    await page.getByRole('button', { name: 'Suggest points' }).click();
    await expect(page.getByText('New points go in the renovation')).toBeVisible();
    await expect(ghosts(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Add all/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'Switch to After' }).click();
    await expect(ghosts(page).first()).toBeVisible();
    await page.getByRole('button', { name: /^Add all/ }).click();
    await expect(realPoints(page).first()).toBeVisible();
    await page.locator('.reno-bar').getByRole('button', { name: 'Before' }).click();
    await expect(realPoints(page)).toHaveCount(0);
  });
});

// Fingers only, on a phone.
const { defaultBrowserType: _webkit, ...iPhone } = devices['iPhone 13'];

test.describe('phone', () => {
  test.use(iPhone);

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitSaved(page);
    await page.evaluate(() => document.fonts.ready);
    await page.getByRole('button', { name: /^Electrical/ }).tap();
    await page.locator('.tool-panel').getByRole('button', { name: 'Suggest points' }).tap();
    await expect(ghosts(page).first()).toBeVisible();
    await page.waitForTimeout(400);
  });

  test('23: a half-height sheet, no sideways scroll, 44 px buttons; a row tap fits its room; a ghost tap says why', async ({
    page,
  }) => {
    const vh = page.viewportSize()?.height ?? 844;
    const sheet = await page.locator('.inspector').boundingBox();
    if (!sheet) throw new Error('no sheet');
    expect(Math.abs(sheet.height - vh / 2)).toBeLessThan(vh * 0.05);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    for (const b of await page.locator('.suggest button:visible').all()) {
      const box = await b.boundingBox();
      if (!box) continue;
      expect(box.height, (await b.textContent()) ?? '').toBeGreaterThanOrEqual(44);
    }
    await expect(page.getByRole('button', { name: /^Add all/ })).toBeVisible();

    // A tap on a room's name fits it in the plan.
    const before = await roomBox(page, 'rm_kitchen');
    await row(page, 'rm_kitchen').getByRole('button', { name: 'Kitchen' }).tap();
    await page.waitForTimeout(300);
    const plan = await page.locator('svg.plan-svg').boundingBox();
    const k = await roomBox(page, 'rm_kitchen');
    if (!plan) throw new Error('no plan');
    expect(k.x).toBeGreaterThanOrEqual(plan.x - 1);
    expect(k.y).toBeGreaterThanOrEqual(plan.y - 1);
    expect(k.x + k.width).toBeLessThanOrEqual(plan.x + plan.width + 1);
    expect(k.y + k.height).toBeLessThanOrEqual(plan.y + plan.height + 1);
    // Zoomed in on it, in the middle.
    expect(k.height).toBeGreaterThan(before.height * 1.3);
    expect(Math.abs(k.y + k.height / 2 - (plan.y + plan.height / 2))).toBeLessThan(10);

    // A tap on a ghost says why it's there.
    const key = 'rm_kitchen:light';
    const at = await ringCentre(page, key);
    await page.touchscreen.tap(at.x, at.y);
    await expect(ghost(page, key)).toHaveAttribute('data-left-out', 'true');
    await expect(page.getByTestId('suggest-status')).toContainText('Tap again');
    await expect(page.getByTestId('suggest-status')).toContainText('Ceiling light.');
    await expect(page.getByTestId('suggest-status')).toBeInViewport();
  });

  test('a room added by finger: one step, its toast, and its row gone', async ({ page }) => {
    const r = row(page, 'rm_bedroom');
    const n = await count(r);
    await r.getByRole('button', { name: `Add ${n}` }).tap();
    await expect(r).toHaveCount(0);
    await expect(realPoints(page)).toHaveCount(n);
    await expect(page.locator('.toast')).toContainText(`Added ${n} points to Bedroom.`);
    await page.getByRole('button', { name: 'Close suggested points' }).tap();
    await expect(ghosts(page)).toHaveCount(0);
    await expect(realPoints(page)).toHaveCount(n);
  });
});
