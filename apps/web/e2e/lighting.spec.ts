import { expect, test } from '@playwright/test';
import { waitSaved } from './helpers';

test('lighting: hang a ceiling light, turn north, light the 3D view by the hour', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('1');

  // A ceiling light hangs from the ceiling and shows as a light symbol on the plan.
  await page.getByRole('button', { name: /^Furniture/ }).click();
  await page.getByRole('button', { name: /Ceiling light/ }).click();
  const room = await page.locator('[data-hit="room:rm_main-bedroom"]').boundingBox();
  if (!room) throw new Error('no room');
  await page.mouse.click(room.x + room.width / 2, room.y + room.height / 2);
  await expect(page.locator('.item-overhead')).toHaveCount(1);
  await expect(page.getByLabel('Above the floor')).toHaveValue('2.52 m');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^Select/ }).click();
  await page.keyboard.press('Escape');

  // Which way the plan faces, from the plan details: the compass follows, and it undoes.
  const compass = page.locator('.plan-compass');
  await expect(compass).toHaveAttribute('aria-label', /^North is up the plan\./);
  await expect(page.getByRole('button', { name: 'N', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'S', exact: true }).click();
  await expect(compass).toHaveAttribute('aria-label', /^North points down \(180° from up\)\./);
  await expect(page.getByText('The top of the plan faces south.')).toBeVisible();
  await page.keyboard.press('Control+z');
  await expect(compass).toHaveAttribute('aria-label', /^North is up the plan\./);
  // Fine-tuned to the degree: the top faces 100°, so north is 100° anticlockwise of up.
  await page.getByLabel('Fine turn, in degrees').fill('100');
  await expect(page.getByText('The top of the plan faces about east (100°).')).toBeVisible();
  // The plan's compass opens the setting, from a selection or a tool.
  await page.keyboard.press('w');
  await compass.click();
  await expect(page.getByLabel('Fine turn, in degrees')).toBeFocused();
  await expect(compass).toHaveAttribute('aria-label', /^North points left \(260° from up\)\./);
  await page.getByRole('button', { name: 'SE', exact: true }).click();
  await waitSaved(page);

  // The 3D view's time of day.
  await page.keyboard.press('3');
  const time = page.getByLabel(/^Time/);
  await time.fill('20');
  await expect(page.locator('.sun-control')).toContainText('8:00 pm');
  await time.fill('9.5');
  await expect(page.locator('.sun-control')).toContainText('9:30 am');

  // North is saved with the plan.
  await page.reload();
  await waitSaved(page);
  await page.keyboard.press('1');
  await expect(page.locator('.plan-compass')).toHaveAttribute(
    'aria-label',
    /^North points down-left \(225° from up\)\./,
  );
  expect(errors).toEqual([]);
});
