import { expect, test } from '@playwright/test';
import { waitSaved } from './helpers';

const WALL = '[data-hit="wall:w_bedroom_living-and-dining"]';

test('version history: restore the plan as it was, and undo the restore', async ({ page }) => {
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('1');

  // Two saved edits: hack a wall, then another.
  await page.locator(WALL).first().click({ force: true });
  await page.keyboard.press('Delete');
  await waitSaved(page);
  await page.locator('[data-hit="wall:w_bedroom_main-bedroom"]').first().click({ force: true });
  await page.keyboard.press('Delete');
  await page.keyboard.press('Escape');
  await waitSaved(page);
  await expect(page.locator(WALL)).toHaveCount(0);

  await page.getByRole('button', { name: 'Projects' }).click();
  await page.getByRole('button', { name: 'Version history…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Version history' });
  const restore = dialog.getByRole('button', { name: /^Restore the plan as it was/ });
  // The first version (the sample as it opened) is the oldest one offered.
  await expect(restore.first()).toBeVisible();
  await restore.last().click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(WALL).first()).toBeVisible();
  await expect(page.locator('.toast')).toContainText('Earlier version restored');
  await waitSaved(page);

  // Undo takes the restore back.
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator(WALL)).toHaveCount(0);
});
