import { waitSaved } from './helpers';
import { expect, test } from './test';

test('a wall becomes a glass partition, or a half wall with glass above; each one undo step', async ({
  page,
}) => {
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('1');
  const wall = page.locator('[data-hit="wall:w_bedroom_main-bedroom"]').first();
  await wall.click({ force: true });
  await expect(page.getByRole('heading', { name: 'Wall', exact: true })).toBeVisible();
  // Glass: drawn pale with its pane, no paint to pick.
  await page.getByRole('button', { name: 'Glass', exact: true }).click();
  await expect(page.locator('polygon.wall-glass').first()).toBeVisible();
  await expect(page.locator('line.glass-pane')).toHaveCount(1);
  await expect(page.getByText(/^Paint,/)).toHaveCount(0);
  await expect(page.getByText('Framed glass partitions are 40–100 mm.')).toBeVisible();
  // Back to solid, then a 1.00 m half wall with fixed glass above: tagged in the plan.
  await page.getByRole('button', { name: 'Solid', exact: true }).click();
  await expect(page.locator('polygon.wall-glass')).toHaveCount(0);
  await page.getByRole('button', { name: '1000', exact: true }).click();
  await expect(page.locator('polygon.wall-half').first()).toBeVisible();
  await expect(page.locator('.wall-tag')).toHaveText('HW 1.00 m');
  await page.getByLabel('Fixed glass above, up to the ceiling').check();
  await expect(page.locator('.wall-tag')).toHaveText('HW 1.00 m + glass');
  await expect(page.getByRole('textbox', { name: 'Height' })).toHaveValue('1.00 m');
  // Each change one undo step: glass above, the half wall, solid, glass.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Control+z');
  await expect(page.locator('.wall-tag')).toHaveText('HW 1.00 m');
  await page.keyboard.press('Control+z');
  await expect(page.locator('.wall-tag')).toHaveCount(0);
  await page.keyboard.press('Control+z');
  await expect(page.locator('polygon.wall-glass').first()).toBeVisible();
  await page.keyboard.press('Control+z');
  await expect(page.locator('polygon.wall-glass')).toHaveCount(0);
  // Saved: a reload keeps a glass wall.
  await page.keyboard.press('Control+Shift+z');
  await expect(page.locator('polygon.wall-glass').first()).toBeVisible();
  await waitSaved(page);
  await page.reload();
  await waitSaved(page);
  await expect(page.locator('polygon.wall-glass').first()).toBeVisible();
});

test('a door slides, folds or goes into its pocket: its plan symbol follows, one undo step each', async ({
  page,
}) => {
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('1');
  const door = page.locator('[data-hit="opening:op_door_bath-wc-1_main-bedroom"]');
  const box = await door.boundingBox();
  if (!box) throw new Error('no door');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByRole('heading', { name: 'Door', exact: true })).toBeVisible();
  const style = page.getByLabel('Opens by');
  await expect(style).toHaveValue('swing');
  await expect(door.locator('.door-arc')).toHaveCount(1);
  // A pocket door: its leaf shut in the opening and, dashed, where it slides into the wall.
  await style.selectOption('pocket');
  await expect(door.locator('.door-arc')).toHaveCount(0);
  await expect(door.locator('.door-slide')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Flip side' })).toBeVisible();
  // A bi-fold: two leaves drawn half folded (four only where each would be 25 cm or more:
  // not on this 0.8 m door); frosted glass.
  await style.selectOption('bifold');
  await expect(door.locator('.door-leaf')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'More' })).toBeDisabled();
  await page.getByRole('button', { name: 'Frosted', exact: true }).click();
  // A folding partition: panels of about half a metre, at least three, none under 25 cm.
  await style.selectOption('folding');
  await expect(door.locator('.door-leaf')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'More' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Fewer' })).toBeDisabled();
  // Each a step back.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Control+z');
  await expect(door.locator('.door-leaf')).toHaveCount(2);
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await expect(door.locator('.door-slide')).toHaveCount(1);
  await page.keyboard.press('Control+z');
  await expect(door.locator('.door-arc')).toHaveCount(1);
});
