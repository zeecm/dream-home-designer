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

  // The next walk picks up where this one stopped.
  const spot = () =>
    page.evaluate(() => {
      const id = new URL(location.href).searchParams.get('p');
      return JSON.parse(localStorage.getItem(`dhd:walk:${id}`) ?? 'null')?.at;
    });
  // The 3D view's own renderer lets the walk go a moment after the button comes back.
  await expect.poll(spot).toBeTruthy();
  const left = await spot();
  await page.getByRole('button', { name: 'Walk through' }).click();
  await expect(page.getByRole('button', { name: 'Leave walk' })).toBeVisible();
  await page.getByRole('button', { name: 'Leave walk' }).click();
  await expect(page.getByRole('button', { name: 'Walk through' })).toBeVisible();
  await page.waitForTimeout(300);
  const again = await spot();
  expect(again.x).toBeCloseTo(left.x, 3);
  expect(again.y).toBeCloseTo(left.y, 3);
  expect(errors).toEqual([]);
});

test('a walk-through link opens straight into a walk', async ({ page }) => {
  await page.goto('/');
  await waitSaved(page);
  const id = new URL(page.url()).searchParams.get('p');
  await page.goto(`/?p=${id}&walk=1`);
  await expect(page.getByRole('button', { name: 'Leave walk' })).toBeVisible({ timeout: 30_000 });
  // Taken out of the address, so a later plan opened here doesn't start walking too.
  expect(new URL(page.url()).searchParams.get('walk')).toBeNull();
});

test('footsteps can be turned off while walking, and stay off', async ({ page }) => {
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('3');
  await page.getByRole('button', { name: 'Walk through' }).click();
  const sound = page.getByRole('button', { name: /^Footsteps/ });
  await expect(sound).toHaveAttribute('aria-pressed', 'true');
  await sound.click();
  await expect(sound).toHaveText('Footsteps off');
  await page.reload();
  await waitSaved(page);
  await page.keyboard.press('3');
  await page.getByRole('button', { name: 'Walk through' }).click();
  await expect(page.getByRole('button', { name: /^Footsteps/ })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
});
