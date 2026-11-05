import { expect, test } from '@playwright/test';
import { newBlankPlan, waitSaved } from './helpers';

const SHELTER = '[data-hit="wall:w_household-shelter_living-and-dining"]';
const STRUCTURAL = '[data-hit="wall:w_bedroom_living-and-dining-2"]';

test('a thick wall is suggested as structural; Yes hatches it, Undo asks again, No settles it', async ({
  page,
}) => {
  await newBlankPlan(page);
  const r = await page.locator('svg.plan-svg').boundingBox();
  if (!r) throw new Error('no plan');
  await page.keyboard.press('w');
  await page.mouse.move(r.x + r.width * 0.2, r.y + r.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width * 0.6, r.y + r.height * 0.4, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.press('Escape');
  await page.keyboard.press('v');
  const wall = page.locator('.walls polygon.wall:not(.hub)').first();
  await wall.click({ force: true });
  const thickness = page.getByLabel('Thickness');
  await thickness.fill('300mm');
  await thickness.press('Enter');
  const guess = page.locator('.inspector .structural-guess');
  await expect(guess).toContainText('300 mm thick, so probably structural.');
  // Not hatched until someone says so.
  await expect(page.locator('.wall-structural')).toHaveCount(0);
  await guess.getByRole('button', { name: 'Yes, structural' }).click();
  await expect(page.getByLabel('Structural wall')).toBeChecked();
  await expect(page.locator('.wall-structural')).toHaveCount(1);
  await page.keyboard.press('Control+z');
  await expect(guess).toBeVisible();
  await guess.getByRole('button', { name: 'No' }).click();
  await expect(guess).toHaveCount(0);
  await expect(page.getByLabel('Structural wall')).not.toBeChecked();
  // Nothing left to suggest in the plan details either.
  await page.keyboard.press('Escape');
  await expect(page.locator('.inspector .structural-guess')).toHaveCount(0);
});

test('in a renovation, shelter walls stay put and a structural wall hacked is warned about', async ({
  page,
}) => {
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('1');
  // The sample's concrete walls are marked, so hatched.
  await expect(page.locator(`${SHELTER}.wall-structural`).first()).toBeVisible();
  await expect(page.locator(`${STRUCTURAL}.wall-structural`).first()).toBeVisible();

  await page.getByRole('button', { name: 'Plan a renovation' }).click();
  const toast = page.locator('.toast');
  // The shelter's wall: refused, the plan as it was, nothing to undo.
  await page.locator(SHELTER).first().click({ force: true });
  await page.keyboard.press('Delete');
  await expect(toast).toContainText('Household shelter walls can’t be changed');
  await expect(toast.getByRole('button', { name: 'Undo' })).toHaveCount(0);
  await expect(page.locator(SHELTER).first()).toBeVisible();
  await expect(page.locator('.reno-bar')).toContainText('No changes yet');

  // A structural wall: hacked, with a warning to undo.
  await page.keyboard.press('Escape');
  await page.locator(STRUCTURAL).first().click({ force: true });
  await page.keyboard.press('Delete');
  await expect(toast).toContainText('That’s a structural wall');
  await expect(page.locator(STRUCTURAL)).toHaveCount(0);
  const list = page.locator('.reno-changes');
  await expect(list).toContainText('(structural)');
  await expect(list).toContainText('touches structural walls');
  await expect(list).toContainText('needs an HDB renovation permit');
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator(STRUCTURAL).first()).toBeVisible();
  await expect(page.locator('.reno-bar')).toContainText('No changes yet');

  // The flat as it is stays free to correct: the shelter's wall goes, no warning.
  await page.locator('.reno-bar').getByRole('button', { name: 'Before' }).click();
  await page.locator(SHELTER).first().click({ force: true });
  await page.keyboard.press('Delete');
  await expect(toast).toContainText('Wall deleted');
});
