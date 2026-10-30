import { expect, test } from '@playwright/test';
import { newBlankPlan, waitSaved } from './helpers';

test('a new plan guides you: walls make a room, a walk finishes it, and it stays closed', async ({
  page,
}) => {
  await newBlankPlan(page);
  const guide = page.getByRole('region', { name: 'Getting started' });
  await expect(guide).toContainText('Add your floor plan');
  await expect(guide).toContainText('1/4');

  // A room drawn with the Room tool, corner to corner.
  await page.getByRole('button', { name: /^Room/ }).click();
  const plan = await page.locator('svg.plan-svg').boundingBox();
  if (!plan) throw new Error('no plan');
  await page.mouse.click(plan.x + plan.width * 0.3, plan.y + plan.height * 0.3);
  await page.mouse.click(plan.x + plan.width * 0.6, plan.y + plan.height * 0.6);
  await page.keyboard.press('Escape');
  await expect(guide).toContainText('Walk through it');
  await expect(guide).toContainText('4/4');

  await guide.getByRole('button', { name: 'Walk through' }).click();
  await page.getByRole('button', { name: 'Leave walk' }).click();
  await expect(page.getByText('That’s the basics.')).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByText('That’s the basics.')).toHaveCount(0);
  await waitSaved(page);
  await page.reload();
  await waitSaved(page);
  await expect(page.getByRole('region', { name: 'Getting started' })).toHaveCount(0);
});

test('the sample has no guide, and closing one ends it', async ({ page }) => {
  await page.goto('/');
  await waitSaved(page);
  await expect(page.getByRole('region', { name: 'Getting started' })).toHaveCount(0);
  await newBlankPlan(page);
  await page.getByRole('button', { name: 'Close the getting-started guide' }).click();
  await expect(page.getByRole('region', { name: 'Getting started' })).toHaveCount(0);
});
