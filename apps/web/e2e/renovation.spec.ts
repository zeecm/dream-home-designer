import { expect, test } from '@playwright/test';
import { waitSaved } from './helpers';

const WALL = '[data-hit="wall:w_bedroom_living-and-dining"]';

test('renovation: hack a wall in the after, compare with before, then keep or discard', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('1');

  await page.getByRole('button', { name: 'Plan a renovation' }).click();
  const bar = page.locator('.reno-bar');
  await expect(bar).toContainText('No changes yet');
  await expect(bar.getByRole('button', { name: 'After' })).toHaveAttribute('aria-pressed', 'true');

  // Hack the wall between the bedroom and the living room, in the after only.
  await page.locator(WALL).first().click({ force: true });
  await page.keyboard.press('Delete');
  await page.keyboard.press('Escape');
  await expect(page.locator(WALL)).toHaveCount(0);
  await expect(bar).toContainText('of wall hacked');
  await expect(page.locator('.reno-hack')).toHaveCount(1);

  // Before still has it, marked for hacking.
  await bar.getByRole('button', { name: 'Before' }).click();
  await expect(page.locator(WALL).first()).toBeVisible();
  await expect(page.locator('.reno-before .reno-hack')).toHaveCount(1);

  // Both versions are saved.
  await waitSaved(page);
  await page.reload();
  await waitSaved(page);
  await expect(page.locator('.reno-bar').getByRole('button', { name: 'After' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.locator(WALL)).toHaveCount(0);

  // Discard it (with undo), then make it the plan.
  await page.getByRole('button', { name: 'Discard the renovation' }).click();
  await expect(page.locator('.reno-bar')).toHaveCount(0);
  await expect(page.locator(WALL).first()).toBeVisible();
  await expect(page.locator('.toast')).toContainText('Renovation discarded');
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('.reno-bar')).toBeVisible();
  await page.locator('.reno-bar').getByRole('button', { name: 'After' }).click();
  await page.getByRole('button', { name: 'Make it the plan' }).click();
  await expect(page.locator('.reno-bar')).toHaveCount(0);
  await expect(page.locator(WALL)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('undo shows the version it changes, and switching versions drops a half-drawn wall', async ({
  page,
}) => {
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('1');
  await page.getByRole('button', { name: 'Plan a renovation' }).click();
  const bar = page.locator('.reno-bar');
  await page.locator(WALL).first().click({ force: true });
  await page.keyboard.press('Delete');
  await page.keyboard.press('Escape');
  await bar.getByRole('button', { name: 'Before' }).click();
  await expect(bar).toContainText('Editing the flat as it is');

  // Undo from Before takes back the After's edit, in view.
  await page.keyboard.press('Control+z');
  await expect(bar.getByRole('button', { name: 'After' })).toHaveAttribute('aria-pressed', 'true');
  await expect(bar).toContainText('No changes yet');

  // Start a wall in After, switch to Before, and click: nothing is drawn into Before.
  const walls = await page.locator('[data-hit^="wall:"]').count();
  await page.keyboard.press('w');
  const plan = await page.locator('svg.plan-svg').boundingBox();
  if (!plan) throw new Error('no plan');
  await page.mouse.click(plan.x + plan.width * 0.45, plan.y + plan.height * 0.5);
  await bar.getByRole('button', { name: 'Before' }).click();
  await page.mouse.click(plan.x + plan.width * 0.55, plan.y + plan.height * 0.5);
  await page.keyboard.press('Escape');
  await expect(bar).toContainText('No changes yet');
  await expect(page.locator('[data-hit^="wall:"]')).toHaveCount(walls);
});
