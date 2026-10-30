import { expect, test } from '@playwright/test';
import { waitSaved } from './helpers';

test('the plan works from the keyboard: Tab selects, Enter renames, arrows nudge', async ({
  page,
}) => {
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('1');
  const plan = page.getByRole('application', { name: 'Floor plan' });
  await plan.focus();

  // Tab walks into the plan's rooms first and announces each one.
  await page.keyboard.press('Tab');
  await expect(page.getByRole('heading', { name: 'Room', exact: true })).toBeVisible();
  await expect(page.locator('[aria-live="polite"]').first()).toHaveText(/m²$/);

  // Enter jumps to the name with its text selected, so typing replaces it.
  await page.keyboard.press('Enter');
  const name = page.getByLabel('Name', { exact: true });
  await expect(name).toBeFocused();
  await page.keyboard.type('Study');
  await page.keyboard.press('Enter');
  await expect(name).toHaveValue('Study');
  // Focus goes back to the plan, so the keyboard user keeps their place.
  await expect(plan).toBeFocused();

  // Escape cancels a rename.
  await page.keyboard.press('F2');
  await page.keyboard.type('Qq');
  await page.keyboard.press('Escape');
  await expect(name).toHaveValue('Study');
  await expect(plan).toBeFocused();

  // Double-clicking a room also starts a rename, and the name field keeps focus.
  await page.keyboard.press('Escape');
  const room = page.locator('[data-hit="room:rm_bedroom"]');
  await room.dblclick({ force: true });
  await expect(name).toBeFocused();
  await page.keyboard.type('Guest room');
  await page.keyboard.press('Enter');
  await expect(name).toHaveValue('Guest room');

  // A selected corner shows its walls' lengths, and Shift+Arrow moves it 10 cm.
  await page.locator('[data-hit^="vertex:"]').first().click({ force: true });
  await expect(page.getByRole('heading', { name: 'Corner', exact: true })).toBeVisible();
  await expect(page.getByText('Walls from this corner')).toBeVisible();
  await expect(page.locator('.dimension').first()).toBeVisible();
  const x = page.getByLabel('X', { exact: true });
  const before = Number.parseFloat(await x.inputValue());
  await plan.focus();
  await page.keyboard.press('Shift+ArrowRight');
  await expect(x).toHaveValue(`${(before + 0.1).toFixed(2)} m`);
  await page.keyboard.press('Control+z');
  await expect(x).toHaveValue(`${before.toFixed(2)} m`);
});
