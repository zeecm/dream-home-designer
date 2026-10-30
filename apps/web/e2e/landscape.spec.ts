import { devices, expect, test } from '@playwright/test';
import { waitSaved } from './helpers';

// A phone on its side: wide, but only about 340 px tall. A small one is narrower than the
// portrait phone breakpoint (720 px), so both sets of rules meet there.
const { defaultBrowserType: _webkit, ...sideways } = devices['iPhone 13 landscape'];
const phones = [
  { name: 'iPhone 13', use: sideways },
  { name: 'a small Android', use: { ...sideways, viewport: { width: 640, height: 360 } } },
];

for (const phone of phones) {
  test.describe(phone.name, () => {
    test.use(phone.use);
    sidewaysTest();
  });
}

function sidewaysTest() {
  test('a phone on its side: the plan gets the room, details fold to a tab, walking fills the screen', async ({
    page,
  }) => {
    await page.goto('/');
    await waitSaved(page);
    await page.evaluate(() => document.fonts.ready);
    const vp = page.viewportSize();
    if (!vp) throw new Error('no viewport');
    // Nothing wider than the screen, and the page itself never scrolls.
    const scroll = await page.evaluate(() => ({
      w: document.documentElement.scrollWidth,
      h: document.documentElement.scrollHeight,
    }));
    expect(scroll.w).toBeLessThanOrEqual(vp.width);
    expect(scroll.h).toBeLessThanOrEqual(vp.height);

    // With nothing selected the details are a thin tab; the plan takes most of the width.
    const details = page.getByRole('complementary', { name: 'Details' });
    const plan = page.locator('svg.plan-svg');
    expect((await details.boundingBox())?.width ?? 999).toBeLessThan(48);
    expect((await plan.boundingBox())?.width ?? 0).toBeGreaterThan(vp.width * 0.7);
    // The plan has most of the height too: the bars above it are thin.
    expect((await plan.boundingBox())?.height ?? 0).toBeGreaterThan(vp.height * 0.6);

    // A room tapped: its details open beside the plan, and fold away again.
    await page.locator('[data-hit="room:rm_bedroom"]').tap({ force: true });
    await expect(details.getByLabel('Name')).toHaveValue('Bedroom');
    expect((await details.boundingBox())?.width ?? 0).toBeGreaterThan(200);
    await details.getByRole('button', { name: 'Hide details' }).tap();
    await expect(details.getByLabel('Name')).toBeHidden();
    expect((await details.boundingBox())?.width ?? 999).toBeLessThan(48);

    // Every tool can be reached in the rail (it scrolls if they don't all fit).
    const furniture = page.getByRole('button', { name: /^Furniture/ });
    await furniture.scrollIntoViewIfNeeded();
    await furniture.tap();
    await expect(furniture).toHaveAttribute('aria-pressed', 'true');

    // Walking: the 3D view takes the whole screen below the top bar.
    await page.getByRole('button', { name: /^3D$/ }).tap();
    await page.getByRole('button', { name: 'Walk through' }).tap();
    await expect(page.getByRole('button', { name: 'Leave walk' })).toBeVisible();
    await expect(page.locator('.palette')).toBeHidden();
    await expect(details).toBeHidden();
    const canvas = await page.locator('canvas').boundingBox();
    expect(canvas?.width ?? 0).toBeGreaterThan(vp.width * 0.95);
    expect(canvas?.height ?? 0).toBeGreaterThan(vp.height * 0.75);
  });
}
