import { waitSaved } from './helpers';
import { expect, test } from './test';

test('my own sofa by its size: too big for the bedroom door, fine in the living room, kept', async ({
  page,
}) => {
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('1');
  await page.getByRole('button', { name: /^Furniture/ }).click();
  await page.getByRole('button', { name: /^Add by size/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Add your furniture' });
  await dialog.getByLabel('Name').fill('My sofa');
  await dialog.getByLabel('Width').fill('2.1');
  await dialog.getByLabel('Depth', { exact: true }).fill('1.0');
  await dialog.getByLabel('Height').fill('0.95');
  await dialog.getByRole('button', { name: 'Add and place it' }).click();
  await expect(dialog).toHaveCount(0);

  // Into the bedroom: the bedroom door is too narrow for it, and drawn red.
  const bedroom = await page.locator('[data-hit="room:rm_bedroom"]').boundingBox();
  if (!bedroom) throw new Error('no bedroom');
  await page.mouse.click(bedroom.x + bedroom.width * 0.5, bedroom.y + bedroom.height * 0.5);
  await expect(page.getByRole('heading', { name: 'My sofa' })).toBeVisible();
  const way = page.getByRole('region', { name: 'Getting it in' });
  await expect(way).toContainText('Too big for the Bedroom door');
  await expect(page.locator('.way-bad')).not.toHaveCount(0);

  // Undone, and placed in the living room instead: it gets in.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+z');
  await expect(page.locator('[data-hit^="item:"]')).toHaveCount(0);
  const living = await page.locator('[data-hit="room:rm_living-and-dining"]').boundingBox();
  if (!living) throw new Error('no living room');
  await page.getByRole('button', { name: /^Furniture/ }).click();
  await page.getByRole('button', { name: /^My sofa/ }).click();
  await page.mouse.click(living.x + living.width * 0.5, living.y + living.height * 0.5);
  await expect(way).toContainText(
    /fits through every door on the way in\. Narrowest: the main door/i,
  );

  // Kept with the plan.
  await waitSaved(page);
  await page.reload();
  await waitSaved(page);
  await page.getByRole('button', { name: /^Furniture/ }).click();
  await expect(page.getByRole('button', { name: /^My sofa/ })).toBeVisible();
});

test('my sofa with its diagonal depth: an impossible one is refused, a real one gets it in (my-furniture 12)', async ({
  page,
}) => {
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('1');
  await page.getByRole('button', { name: /^Furniture/ }).click();
  await page.getByRole('button', { name: /^Add by size/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Add your furniture' });
  const diagonal = dialog.getByLabel('Diagonal depth (optional)');
  await expect(diagonal).toHaveValue('');
  await dialog.getByLabel('Name').fill('My sofa');
  await dialog.getByLabel('Width').fill('2.1');
  await dialog.getByLabel('Depth', { exact: true }).fill('1.0');
  await dialog.getByLabel('Height').fill('0.95');
  // With depth and height known, the hint gives this sofa's range.
  await expect(dialog.getByTestId('diagonal-hint')).toContainText('For this sofa: 0.69–0.95 m.');

  // Longer than the sofa is deep or high: refused under the field, which is focused.
  await diagonal.fill('1.5');
  await dialog.getByRole('button', { name: 'Add and place it' }).click();
  await expect(diagonal).toHaveAttribute('aria-invalid', 'true');
  await expect(diagonal).toBeFocused();
  await expect(diagonal).toHaveAccessibleDescription(/Between 0\.69 and 0\.95\sm for this sofa\./);
  await expect(dialog.locator('#add-size-diag-err')).toBeInViewport();

  // A real measurement: added, and the Bedroom door passes with it tilted.
  await diagonal.fill('0.80');
  await expect(diagonal).toHaveAttribute('aria-invalid', 'false');
  await dialog.getByRole('button', { name: 'Add and place it' }).click();
  await expect(dialog).toHaveCount(0);
  const bedroom = await page.locator('[data-hit="room:rm_bedroom"]').boundingBox();
  if (!bedroom) throw new Error('no bedroom');
  await page.mouse.click(bedroom.x + bedroom.width * 0.5, bedroom.y + bedroom.height * 0.5);
  await expect(page.getByRole('heading', { name: 'My sofa' })).toBeVisible();
  const way = page.getByRole('region', { name: 'Getting it in' });
  await expect(way).toContainText(/fits through every door on the way in/i);
  await expect(way).not.toContainText('Too big');
  await expect(page.locator('.way-bad')).toHaveCount(0);
});
