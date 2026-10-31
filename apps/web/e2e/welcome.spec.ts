import { devices, expect, test } from '@playwright/test';
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

test('the welcome page from a browser that already has a plan: its buttons still start what they say', async ({
  page,
}) => {
  await page.goto('/?new=First%20plan');
  await waitSaved(page);
  await expect(page.getByLabel('Project name')).toHaveValue('First plan');

  await page.goto('/welcome/');
  await page.getByLabel('Plan name').fill('Second plan');
  await page.getByLabel('Plan name').press('Enter');
  await waitSaved(page);
  await expect(page.getByLabel('Project name')).toHaveValue('Second plan');

  await page.goto('/welcome/');
  await page.getByRole('link', { name: 'Open the sample flat' }).click();
  await waitSaved(page);
  await expect(page.getByLabel('Project name')).toHaveValue(/sample/);
  expect(new URL(page.url()).searchParams.has('sample')).toBe(false);
});

test('the welcome hero wall: Home and End take it as far as it goes, its value reads to the right', async ({
  page,
}) => {
  await page.goto('/welcome/');
  const grip = page.getByRole('slider', { name: 'The wall between the bedrooms' });
  await grip.focus();
  await page.keyboard.press('End');
  const max = Number(await grip.getAttribute('aria-valuemax'));
  await expect(grip).toHaveAttribute('aria-valuenow', String(max));
  expect(max).toBeGreaterThan(0);
  await page.keyboard.press('Home');
  await expect(grip).toHaveAttribute(
    'aria-valuenow',
    (await grip.getAttribute('aria-valuemin')) ?? '',
  );
  // The page didn't scroll away while the wall had the keys.
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test.describe('on a phone', () => {
  const { defaultBrowserType: _webkit, ...iPhone } = devices['iPhone 13'];
  test.use(iPhone);

  test('the first screen shows the name, the plan, the headline and the button; a swipe on the plan scrolls the page', async ({
    page,
  }) => {
    await page.goto('/welcome/');
    const vh = page.viewportSize()?.height ?? 0;
    await expect(page.locator('.mark')).toBeVisible();
    const button = await page.getByRole('link', { name: 'Open the sample flat' }).boundingBox();
    expect((button?.y ?? 999) + (button?.height ?? 0)).toBeLessThanOrEqual(vh);

    // A swipe up from the plan (away from the wall) scrolls the page.
    const plan = await page.locator('.hero-plan').boundingBox();
    if (!plan) throw new Error('no plan');
    const cdp = await page.context().newCDPSession(page);
    const x = plan.x + plan.width * 0.8;
    const y = plan.y + plan.height * 0.8;
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y, id: 0 }],
    });
    for (let i = 1; i <= 8; i++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x, y: y - i * 25, id: 0 }],
      });
      await page.waitForTimeout(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(50);
  });
});
