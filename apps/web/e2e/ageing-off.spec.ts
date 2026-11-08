import { readFileSync } from 'node:fs';
import { waitSaved } from './helpers';
import { expect, test } from './test';

// The Older person check is on hold (owner, 7 Nov 2026): without its flag nothing of it shows or
// runs, even with a choice left in the browser, and clearance works as it did before it.

const FILE = readFileSync(new URL('./furnished.dreamhome.json', import.meta.url));

test('on hold: no Older person row or marks; clearance lists the walkway as before', async ({
  page,
}) => {
  await page.goto('/');
  await waitSaved(page);
  const before = new URL(page.url()).searchParams.get('p');
  await page.locator('input[type="file"][accept=".json,application/json"]').setInputFiles({
    name: 'furnished.dreamhome.json',
    mimeType: 'application/json',
    buffer: FILE,
  });
  await expect.poll(() => new URL(page.url()).searchParams.get('p')).not.toBe(before);
  const id = new URL(page.url()).searchParams.get('p');
  // A wheelchair check left in this browser for the plan: still nothing, while on hold.
  await page.evaluate(
    (key) => window.localStorage.setItem(key, JSON.stringify({ profile: 'wheelchair' })),
    `dhd-ageing-${id}`,
  );
  await page.reload();
  await waitSaved(page);
  await page.keyboard.press('1');
  const checks = page.locator('section.checks');
  await expect(checks.getByRole('heading', { name: 'Checks' })).toBeVisible();
  await expect(checks.getByLabel('Clearance checks')).toBeChecked();
  await expect(checks.getByTestId('storage-summary')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Older person' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Wheelchair' })).toHaveCount(0);
  await expect(page.getByTestId('ageing-layer')).toHaveCount(0);
  await expect(page.locator('.ageing-chip')).toHaveCount(0);
  // The walkway pinch by the Bedroom door, as clearance lists and draws it.
  await expect(page.locator('.clearance-chip', { hasText: '0.87 / 0.90 m' })).toBeVisible();
  await expect(page.getByTestId('walkway-line')).toContainText('0.87 m');
  await expect(page.getByTestId('clearance-count')).toBeVisible();
  // A piece's details (the single bed by the door): its clearances, no older person lines.
  await page.locator('[data-hit="item:it_f002"]').first().click({ force: true });
  await expect(page.getByRole('heading', { name: 'Single bed' })).toBeVisible();
  await expect(page.getByTestId('item-ageing')).toHaveCount(0);
});
