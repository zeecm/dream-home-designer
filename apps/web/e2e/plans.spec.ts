import { type Page, expect, test } from '@playwright/test';
import { waitSaved } from './helpers';

const openId = (page: Page) => new URL(page.url()).searchParams.get('p') ?? '';

async function newPlan(page: Page) {
  await page.getByRole('button', { name: 'Projects' }).click();
  await page.getByRole('button', { name: 'New blank plan' }).click();
  await waitSaved(page);
  return openId(page);
}

async function manage(page: Page) {
  await page.getByRole('button', { name: 'Projects' }).click();
  await page.getByRole('button', { name: 'Manage your plans…' }).click();
  return page.getByRole('dialog', { name: 'Your plans' });
}

test('delete plans one by one or all at once; samples stay', async ({ page }) => {
  await page.goto('/');
  await waitSaved(page);
  const sample = openId(page);
  const first = await newPlan(page);
  const second = await newPlan(page);

  // One at a time: the open plan goes, and the newest one left opens.
  const dialog = await manage(page);
  await expect(dialog.getByRole('listitem')).toHaveCount(3);
  await expect(dialog.getByRole('listitem').filter({ hasText: '(sample)' })).toContainText('Kept');
  await dialog.getByRole('button', { name: 'Delete Untitled plan' }).first().click();
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('Untitled plan deleted.');
  await expect(dialog.getByRole('listitem')).toHaveCount(2);
  await expect.poll(() => openId(page)).toBe(first);
  expect((await page.request.get(`/api/projects/${second}`)).status()).toBe(404);

  // Keys are the dialog's while it is open: 3 doesn't switch the view to 3D.
  await page.keyboard.press('3');
  await expect(page.locator('.topbar .segmented button', { hasText: '3D' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );

  // Clear all: only the sample is left, and it opens.
  await dialog.getByRole('button', { name: 'Clear all plans' }).click();
  await expect(dialog).toContainText('Delete 1 plan? Samples stay.');
  await dialog.getByRole('button', { name: 'Clear all', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('Plans cleared. Samples kept.');
  await expect(dialog.getByRole('listitem')).toHaveCount(1);
  await expect(dialog.getByRole('button', { name: 'Clear all plans' })).toBeDisabled();
  await expect.poll(() => openId(page)).toBe(sample);
  expect((await page.request.get(`/api/projects/${first}`)).status()).toBe(404);
  expect((await page.request.get(`/api/projects/${sample}`)).status()).toBe(200);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});
