import { expect, test } from '@playwright/test';
import { floorArea, waitSaved } from './helpers';

test('a first visit opens its own copy of the sample flat, saved on the server', async ({
  page,
}) => {
  await page.goto('/');
  await waitSaved(page);
  await expect(page).toHaveURL(/\?p=prj_/);
  await expect(page.getByTestId('sync')).toHaveText('Saved');
  await expect(page.getByText('You’re exploring a sample flat')).toBeVisible();
  await expect(floorArea(page)).toHaveText('96.0 m²');
  await expect(page.locator('.room-list li')).toHaveCount(10);
});

test('editing a wall undoes and redoes, and deleting offers Undo', async ({ page }) => {
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('1');
  await page
    .locator('[data-hit="wall:w_bedroom-3_living-and-dining"]')
    .first()
    .click({ force: true });
  await expect(page.getByRole('heading', { name: 'Wall' })).toBeVisible();
  const thickness = page.getByLabel('Thickness');
  await thickness.fill('150mm');
  await thickness.press('Enter');
  await expect(thickness).toHaveValue('0.15 m');
  await page.keyboard.press('Control+z');
  await expect(thickness).toHaveValue('0.10 m');
  await page.keyboard.press('Control+Shift+z');
  await expect(thickness).toHaveValue('0.15 m');

  await page.locator('[data-hit="wall:w_bedroom-2_corridor"]').first().click({ force: true });
  await page.keyboard.press('Delete');
  await expect(page.locator('.toast')).toContainText('Wall deleted');
  await page.keyboard.press('Escape');
  await expect(page.locator('.room-list li')).toHaveCount(9); // Bedroom 2 and Corridor merged
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('.room-list li')).toHaveCount(10);
});

test('a broken link opens a fresh sample with a notice', async ({ page }) => {
  await page.goto('/?p=../../etc');
  await waitSaved(page);
  await expect(page.locator('.notice')).toContainText('doesn’t point to a plan');
  await expect(page).toHaveURL(/\?p=prj_/);
});

test('a wall can become a room boundary: rooms stay, the wall goes from 3D', async ({ page }) => {
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('1');
  await page
    .locator('[data-hit="wall:w_kitchen_living-and-dining"]')
    .first()
    .click({ force: true });
  await expect(page.getByRole('heading', { name: 'Wall', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Boundary', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Room boundary' })).toBeVisible();
  await expect(page.locator('line.boundary')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('.room-list li')).toHaveCount(10);
  await expect(floorArea(page)).toHaveText('96.0 m²');
  await page.keyboard.press('Control+z');
  await expect(page.locator('line.boundary')).toHaveCount(0);
});

test('an edit lands on the object it was typed for, even after clicking another', async ({
  page,
}) => {
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('1');
  await page.locator('[data-hit="room:rm_kitchen"]').click({ force: true });
  const name = page.getByLabel('Name', { exact: true });
  await name.fill('Pantry');
  // Click another room without pressing Enter: the rename still belongs to the kitchen.
  await page.locator('[data-hit="room:rm_bedroom-2"]').click({ force: true });
  await expect(name).toHaveValue('Bedroom 2');
  await page.keyboard.press('Escape');
  const rooms = page.locator('.room-list-name');
  await expect(rooms.filter({ hasText: 'Pantry' })).toHaveCount(1);
  await expect(rooms.filter({ hasText: 'Bedroom 2' })).toHaveCount(1);
  await expect(rooms.filter({ hasText: 'Kitchen' })).toHaveCount(0);
});
