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

  // The plan details list the changes room by room, ready to copy for a contractor.
  const list = page.locator('.reno-changes');
  await expect(list).toContainText('Between Bedroom and Living and dining');
  await expect(list).toContainText(/Hack \d+\.\d\d m of wall/);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await list.getByRole('button', { name: 'Copy list' }).click();
  await expect(list.getByRole('button', { name: 'Copied' })).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toMatch(/^Between Bedroom and Living and dining: Hack \d+\.\d\d m of wall/m);

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

test('a fix to the flat as it is carries over to the renovation: no false change', async ({
  page,
}) => {
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('1');
  await page.getByRole('button', { name: 'Plan a renovation' }).click();
  const bar = page.locator('.reno-bar');
  await bar.getByRole('button', { name: 'Before' }).click();
  // The wall turns out not to be there: taken out of the flat as it is, it goes from the
  // renovation too, so nothing reads as hacked.
  await page.locator(WALL).first().click({ force: true });
  await page.keyboard.press('Delete');
  await page.keyboard.press('Escape');
  await expect(page.locator(WALL)).toHaveCount(0);
  await expect(bar).toContainText('No changes yet');
  await bar.getByRole('button', { name: 'After' }).click();
  await expect(page.locator(WALL)).toHaveCount(0);
  // One undo puts it back in both, showing the flat as it is.
  await page.keyboard.press('Control+z');
  await expect(bar.getByRole('button', { name: 'Before' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator(WALL).first()).toBeVisible();
  await bar.getByRole('button', { name: 'After' }).click();
  await expect(page.locator(WALL).first()).toBeVisible();
  await expect(bar).toContainText('No changes yet');
});

test('an edit to the flat as it is that the renovation changed too is not carried over, and says so', async ({
  page,
}) => {
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('1');
  await page.getByRole('button', { name: 'Plan a renovation' }).click();
  const bar = page.locator('.reno-bar');
  // The renovation repaints the wall.
  await page.locator(WALL).first().click({ force: true });
  await page.getByRole('button', { name: 'Paint, Bedroom side: Sage' }).click();
  await page.keyboard.press('Escape');
  // The flat as it is loses it: the renovation keeps its repainted wall.
  await bar.getByRole('button', { name: 'Before' }).click();
  await page.locator(WALL).first().click({ force: true });
  await page.keyboard.press('Delete');
  await expect(page.locator('.toast')).toContainText('Not carried over to the renovation');
  await expect(page.locator(WALL)).toHaveCount(0);
  await bar.getByRole('button', { name: 'After' }).click();
  await expect(page.locator(WALL).first()).toBeVisible();
});

test('the 3D view compares before and after across a divider', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('3');
  // Only a plan with a renovation has two versions to compare.
  await expect(page.getByRole('button', { name: 'Compare before and after' })).toHaveCount(0);
  await page.keyboard.press('1');
  await page.getByRole('button', { name: 'Plan a renovation' }).click();
  await page.keyboard.press('3');
  await page.getByRole('button', { name: 'Compare before and after' }).click();
  const divider = page.getByRole('slider', { name: /Divider/ });
  await expect(divider).toHaveAttribute('aria-valuenow', '50');
  await divider.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(divider).toHaveAttribute('aria-valuenow', '45');
  // Home and End take it as far as it goes; the side left too narrow loses its label.
  const after = page.locator('.compare-label-after');
  await expect(after).toBeVisible();
  await page.keyboard.press('End');
  await expect(divider).toHaveAttribute('aria-valuenow', '95');
  await expect(after).toHaveCount(0);
  await page.keyboard.press('Home');
  await expect(divider).toHaveAttribute('aria-valuenow', '5');
  await expect(after).toBeVisible();
  await expect(page.locator('.compare-label-before')).toHaveCount(0);
  await page.keyboard.press('PageUp');
  await expect(divider).toHaveAttribute('aria-valuenow', '30');
  // The view's buttons stay clickable over the divider.
  await expect(page.getByRole('button', { name: 'Stop comparing' })).toBeVisible();
  // Walking shows one version: the comparison goes, and comes back after.
  await page.getByRole('button', { name: 'Walk through' }).click();
  await expect(divider).toHaveCount(0);
  await page.getByRole('button', { name: 'Leave walk' }).click();
  await expect(divider).toBeVisible();
  await page.getByRole('button', { name: 'Stop comparing' }).click();
  await expect(divider).toHaveCount(0);
  // Comparing ends with the renovation.
  await page.getByRole('button', { name: 'Compare before and after' }).click();
  await expect(divider).toBeVisible();
  await page.keyboard.press('1');
  await page.getByRole('button', { name: 'Discard the renovation' }).click();
  await expect(page.locator('.reno-bar')).toHaveCount(0);
  await page.keyboard.press('3');
  await expect(divider).toHaveCount(0);
  await page.keyboard.press('1');
  await page.getByRole('button', { name: 'Plan a renovation' }).click();
  await page.keyboard.press('3');
  await expect(divider).toHaveCount(0);
  expect(errors).toEqual([]);
});
