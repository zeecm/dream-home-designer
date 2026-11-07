import { readFileSync } from 'node:fs';
import { type Page, expect, test } from '@playwright/test';
import { waitSaved } from './helpers';

const WALL = '[data-hit="wall:w_bedroom_living-and-dining"]';

test('cost estimate: painting at first, then the renovation priced; rates edited and reset', async ({
  page,
}) => {
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('1');
  const summary = page.locator('.cost-summary');
  await expect(summary).toContainText(/about \$[\d,]+–[\d,]+/);
  await expect(summary).toContainText('Start a renovation to price hacking');

  // A wall hacked in a renovation: priced, with debris.
  await page.getByRole('button', { name: 'Plan a renovation' }).click();
  await page.locator(WALL).first().click({ force: true });
  await page.keyboard.press('Delete');
  await page.keyboard.press('Escape');
  await expect(summary).not.toContainText('Start a renovation');
  const before = await summary.locator('.cost-total strong').textContent();
  await summary.getByRole('button', { name: 'See estimate' }).click();
  const dialog = page.getByRole('dialog', { name: 'Cost estimate' });
  await expect(dialog.locator('.estimate-line', { hasText: 'Hack wall' })).toHaveCount(1);
  await expect(dialog.locator('.estimate-line', { hasText: 'Debris disposal' })).toHaveCount(1);
  await expect(dialog).toContainText('not a quote');

  // A dearer hacking rate raises the total, survives a reload, and Reset puts it back.
  await dialog.getByText('Rates (S$, low and high)').click();
  const low = dialog.getByLabel('Hack wall, low');
  await low.fill('1000');
  await low.blur();
  await expect(summary.locator('.cost-total strong')).not.toHaveText(before ?? '');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await dialog.getByRole('button', { name: 'Copy' }).click();
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text).toContain('Hack wall');
  expect(text).toMatch(/Total: about \$/);
  expect(text).toContain('HDB-registered contractors');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await waitSaved(page);
  await page.reload();
  await waitSaved(page);
  await page.locator('.cost-summary').getByRole('button', { name: 'See estimate' }).click();
  const again = page.getByRole('dialog', { name: 'Cost estimate' });
  await again.getByText('Rates (S$, low and high)').click();
  // A low above the high is taken as the high: the two swap.
  await expect(again.getByLabel('Hack wall, low')).toHaveValue('200');
  await expect(again.getByLabel('Hack wall, high')).toHaveValue('1000');
  await again.getByRole('button', { name: 'Reset to typical' }).click();
  await expect(again.getByLabel('Hack wall, low')).toHaveValue('130');
});

test('a built-in wardrobe is priced by the foot run, and resizing it reprices it', async ({
  page,
}) => {
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('1');
  const room = page.locator('[data-hit="room:rm_main-bedroom"]');
  const box = await room.boundingBox();
  if (!box) throw new Error('no room');
  await page.getByRole('button', { name: /^Furniture/ }).click();
  await page.getByRole('button', { name: /^Built-in wardrobe/ }).click();
  await page.mouse.click(box.x + box.width * 0.5, box.y + 30);
  await expect(page.getByRole('heading', { name: 'Built-in wardrobe' })).toBeVisible();
  const line = page.locator('.carpentry-line');
  await expect(line).toContainText('6 ft run · about $1,200–2,100');
  const width = page.getByLabel('Width');
  await width.fill('2400');
  await width.press('Enter');
  await expect(line).toContainText('8 ft run');
  await page.keyboard.press('Escape');
  await page.locator('.cost-summary').getByRole('button', { name: 'See estimate' }).click();
  const dialog = page.getByRole('dialog', { name: 'Cost estimate' });
  await expect(dialog.locator('.estimate-line', { hasText: 'Built-in wardrobe' })).toContainText(
    '8 ft run',
  );
});

/** A maisonette: core's twoLevelProject, written out (a web unit test keeps it in step). */
const TWO_LEVELS = readFileSync(new URL('./two-levels.dreamhome.json', import.meta.url));
/** Its total at the typical rates, as core's TWO_LEVELS_TOTAL has it. */
const TWO_LEVELS_TOTAL = 'about $5,200–8,700';

/** Opens the two-level file, as Projects ▸ Open a project file does, and the estimate. */
async function openTwoLevels(page: Page) {
  await page.goto('/');
  await waitSaved(page);
  await page.locator('input[type="file"][accept=".json,application/json"]').setInputFiles({
    name: 'maisonette.dreamhome.json',
    mimeType: 'application/json',
    buffer: TWO_LEVELS,
  });
  await waitSaved(page);
  // On a phone, the plan's details fold away: open them.
  const toggle = page.locator('.inspector-toggle');
  if ((await toggle.isVisible()) && (await toggle.getAttribute('aria-expanded')) === 'false') {
    await toggle.click();
  }
  const summary = page.locator('.cost-summary');
  await expect(summary).toContainText('Covers both levels: Ground and Upper.');
  await expect(summary.locator('.cost-total strong')).toHaveText('$5,200–8,700');
  await summary.getByRole('button', { name: 'See estimate' }).click();
  const dialog = page.getByRole('dialog', { name: 'Cost estimate' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('slice 2s C2: a two-level file is priced on both levels, by level and in total', async ({
  page,
}) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const dialog = await openTwoLevels(page);
  // Both levels' wardrobes, Ground's first, each place starting with its level.
  const wardrobes = dialog.locator('.estimate-line', { hasText: 'Built-in wardrobe' });
  await expect(wardrobes).toHaveCount(2);
  await expect(wardrobes.nth(0)).toContainText('Ground · Master bedroom');
  await expect(wardrobes.nth(1)).toContainText('Upper · Bedroom 2');
  await expect(dialog.locator('.estimate-line[data-level="lvl_upper"]').first()).toBeVisible();
  // The level the app can't show yet is said to come from the file.
  await expect(dialog).toContainText(
    'Upper is priced from the file. It can’t be shown or edited here yet.',
  );
  // By level, above the trade groups: each level, the whole home's part, then the total.
  const by = dialog.getByRole('region', { name: 'By level' });
  await expect(by.locator('.estimate-item')).toHaveText([
    'Ground',
    'Upper',
    'Whole home (contingency)',
    'Total',
  ]);
  await expect(by.locator('.estimate-sub-total')).toContainText(TWO_LEVELS_TOTAL);
  await expect(dialog.locator('.estimate-total strong')).toHaveText(TWO_LEVELS_TOTAL);
  const sums = await by
    .locator('.estimate-sub:not(.estimate-sub-total) .estimate-cost')
    .allTextContents();
  const lows = sums.map((t) => Number((t.match(/\$([\d,]+)/)?.[1] ?? '0').replace(/,/g, '')));
  const total = lows.reduce((a, b) => a + b, 0);
  expect(Math.abs(total - 5200)).toBeLessThanOrEqual(50);
  // Copy: the prefixes, and the subtotals before the total.
  await dialog.getByRole('button', { name: 'Copy' }).click();
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text).toContain('Built-in wardrobe · Upper · Bedroom 2 · 6 ft run');
  expect(text.indexOf('By level')).toBeLessThan(text.indexOf('Total: about $5,200–8,700'));
  expect(text).toMatch(/Upper: \$[\d,]+–[\d,]+/);
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('slice 2s C2: each line keeps two rows, the place beside the quantity', async ({ page }) => {
    const dialog = await openTwoLevels(page);
    const line = dialog.locator('.estimate-line', { hasText: 'Repaint walls and ceiling' }).first();
    const place = await line.locator('.estimate-place').boundingBox();
    const qty = await line.locator('.estimate-qty').boundingBox();
    const label = await line.locator('.estimate-label').boundingBox();
    if (!place || !qty || !label) throw new Error('line not laid out');
    expect(Math.abs(place.y - qty.y)).toBeLessThan(4);
    expect(place.y).toBeGreaterThan(label.y + label.height - 2);
    await expect(line.locator('.estimate-place')).toHaveText(/^Ground · /);
  });
});
