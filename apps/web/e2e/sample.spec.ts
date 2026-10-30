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
  await expect(floorArea(page)).toHaveText('68.9 m²');
  await expect(page.locator('.room-list li')).toHaveCount(9);
  // It is the published HDB plan, traced, with the plan itself underneath.
  await expect(page.locator('image.underlay')).toBeVisible();
});

test('editing a wall undoes and redoes, and deleting offers Undo', async ({ page }) => {
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('1');
  await page
    .locator('[data-hit="wall:w_bedroom_living-and-dining"]')
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

  await page.locator('[data-hit="wall:w_bath-wc-1_bath-wc-2"]').first().click({ force: true });
  await page.keyboard.press('Delete');
  await expect(page.locator('.toast')).toContainText('Wall deleted');
  await page.keyboard.press('Escape');
  await expect(page.locator('.room-list li')).toHaveCount(8); // the two bathrooms merged
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('.room-list li')).toHaveCount(9);
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
  await page.locator('[data-hit="wall:w_bedroom_main-bedroom"]').first().click({ force: true });
  await expect(page.getByRole('heading', { name: 'Wall', exact: true })).toBeVisible();
  // The sample's dry kitchen already has two boundaries.
  await expect(page.locator('line.boundary')).toHaveCount(2);
  await page.getByRole('button', { name: 'Boundary', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Room boundary' })).toBeVisible();
  await expect(page.locator('line.boundary')).toHaveCount(3);
  await page.keyboard.press('Escape');
  await expect(page.locator('.room-list li')).toHaveCount(9);
  await expect(floorArea(page)).toHaveText('68.9 m²');
  await page.keyboard.press('Control+z');
  await expect(page.locator('line.boundary')).toHaveCount(2);
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
  await page.locator('[data-hit="room:rm_bedroom"]').click({ force: true });
  await expect(name).toHaveValue('Bedroom');
  await page.keyboard.press('Escape');
  const rooms = page.locator('.room-list-name');
  await expect(rooms.filter({ hasText: 'Pantry' })).toHaveCount(1);
  await expect(rooms.filter({ hasText: /^Bedroom$/ })).toHaveCount(1);
  await expect(rooms.filter({ hasText: /^Kitchen$/ })).toHaveCount(0);

  // The same when the next click is a different kind of object, or empty canvas.
  await page.locator('[data-hit="room:rm_bedroom"]').click({ force: true });
  await name.fill('Study');
  await page.locator('[data-hit="wall:w_bedroom_main-bedroom"]').first().click({ force: true });
  await expect(page.getByRole('heading', { name: 'Wall', exact: true })).toBeVisible();
  const thickness = page.getByLabel('Thickness');
  await thickness.fill('150 mm');
  const box = await page.getByTestId('plan').boundingBox();
  // Empty canvas: the top edge of the plan, inside the fit padding.
  await page.mouse.click((box?.x ?? 0) + (box?.width ?? 0) / 2, (box?.y ?? 0) + 24);
  await expect(page.getByRole('heading', { name: 'Plan', exact: true })).toBeVisible();
  await expect(rooms.filter({ hasText: 'Study' })).toHaveCount(1);
  await page.locator('[data-hit="wall:w_bedroom_main-bedroom"]').first().click({ force: true });
  await expect(page.getByLabel('Thickness')).toHaveValue('0.15 m');
});
