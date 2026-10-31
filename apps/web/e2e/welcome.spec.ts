import { expect, test } from '@playwright/test';
import { waitSaved } from './helpers';

test('the welcome page: drag the wall and the bedrooms are measured again; name a plan and start it', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/welcome/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Draw your flat/);
  const readout = page.locator('.hero-fragment .readout');
  await expect(readout).toContainText('Main bedroom 12.8 m²');

  // Dragging the selected wall towards the main bedroom moves area to the bedroom.
  const knob = page.locator('.grip-knob');
  const k = await knob.boundingBox();
  if (!k) throw new Error('no wall to drag');
  await page.mouse.move(k.x + k.width / 2, k.y + k.height / 2);
  await page.mouse.down();
  await page.mouse.move(k.x + k.width / 2 - 30, k.y + k.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(readout).not.toContainText('Main bedroom 12.8 m²');
  await expect(readout).toContainText('Wall moved');

  // From the keyboard too: the wall is a slider.
  const grip = page.getByRole('slider', { name: 'The wall between the bedrooms' });
  await grip.focus();
  const before = await grip.getAttribute('aria-valuetext');
  await page.keyboard.press('ArrowRight');
  await expect(grip).not.toHaveAttribute('aria-valuetext', before ?? '');

  // The renovation controls change the drawing beside them.
  await page.getByRole('button', { name: 'After' }).click();
  await expect(page.locator('.renovate .readout')).toContainText('opened up');
  expect(errors).toEqual([]);

  // Naming a plan opens a blank one of that name in the app.
  await page.getByLabel('Plan name').fill('Our new flat');
  await page.getByRole('button', { name: 'start.' }).click();
  await waitSaved(page);
  await expect(page.getByLabel('Project name')).toHaveValue('Our new flat');
});
