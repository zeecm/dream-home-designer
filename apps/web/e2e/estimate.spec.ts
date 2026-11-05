import { expect, test } from '@playwright/test';
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
  await expect(dialog.locator('.estimate-line', { hasText: 'Wardrobe' })).toContainText('8 ft run');
});
