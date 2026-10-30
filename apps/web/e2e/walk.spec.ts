import { expect, test } from '@playwright/test';
import { waitSaved } from './helpers';

test('walk through the flat in first person, then leave with Esc', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('2');
  await page.getByRole('button', { name: 'Walk through' }).click();
  await expect(page.getByRole('button', { name: 'Leave walk' })).toBeVisible();
  await expect(page.locator('svg.minimap')).toBeVisible();
  // The plan is hidden while walking, and the tool keys don't fire.
  await expect(page.getByTestId('plan')).toHaveCount(0);
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(800);
  await page.keyboard.up('KeyW');
  await expect(page.locator('.tool[aria-pressed="true"]')).toContainText('Select');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Walk through' })).toBeVisible();
  // Back to the view it started from.
  await expect(page.getByTestId('plan')).toBeVisible();
  expect(errors).toEqual([]);
});
