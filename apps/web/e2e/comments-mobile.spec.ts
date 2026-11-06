import { type Page, devices, expect, test } from '@playwright/test';
import { waitSaved } from './helpers';

// A 390 px phone, by finger only.
const { defaultBrowserType: _webkit, ...iPhone } = devices['iPhone 13'];
test.use(iPhone);

const shot = async (page: Page, name: string) => {
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png` });
};

type Pt = { x: number; y: number };

/** A gesture in steps; `during` runs with the fingers still down, before they lift. */
async function touches(page: Page, frames: Pt[][], during?: () => Promise<void>) {
  const cdp = await page.context().newCDPSession(page);
  const [first, ...rest] = frames;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: (first ?? []).map((p, id) => ({ ...p, id })),
  });
  for (const f of rest) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: f.map((p, id) => ({ ...p, id })),
    });
    await page.waitForTimeout(16);
  }
  if (during) await during();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(100);
}

const noSideScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test('on a phone: comment by finger with the magnifier, in a sheet; the panel is a sheet', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await waitSaved(page);
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole('button', { name: 'Comment K', exact: true }).tap();
  await expect(page.locator('.tool-panel')).toContainText('leave a comment there');

  // A finger on the kitchen: the magnifier shows while it is down; the sheet opens on lift.
  const room = await page.locator('[data-hit="room:rm_kitchen"]').boundingBox();
  if (!room) throw new Error('no kitchen');
  const svg = await page.locator('svg.plan-svg').boundingBox();
  if (!svg) throw new Error('no plan');
  // In the kitchen, where the plan shows it (the details panel may cover its lower part).
  const at = {
    x: room.x + room.width * 0.4,
    y: Math.min(room.y + room.height * 0.4, svg.y + svg.height - 40),
  };
  await shot(page, 'phone-tool');
  await touches(
    page,
    [[at], [{ x: at.x + 6, y: at.y + 4 }], [{ x: at.x + 10, y: at.y + 8 }]],
    async () => {
      await expect(page.getByTestId('loupe')).toBeVisible();
      await shot(page, 'phone-loupe');
    },
  );
  const sheet = page.locator('.comment-sheet');
  await expect(sheet.getByRole('heading', { name: 'New comment · Kitchen' })).toBeVisible();
  await expect(sheet.getByLabel('Your name')).toBeFocused();
  await sheet.getByLabel('Your name').fill('Mum');
  await sheet
    .getByRole('textbox', { name: 'Comment', exact: true })
    .fill('Wok smell goes everywhere. Glass sliding door?');
  await shot(page, 'phone-compose');
  // Post stays on screen, above where the keyboard comes up.
  const post = sheet.getByRole('button', { name: 'Post' });
  const box = await post.boundingBox();
  const vh = page.viewportSize()?.height ?? 0;
  expect((box?.y ?? vh) + (box?.height ?? 0)).toBeLessThanOrEqual(vh);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  await post.tap();
  await expect(sheet).toHaveCount(0);
  const pin = page.getByRole('button', { name: /^Comment by Mum on Kitchen/ });
  await expect(pin).toBeVisible();
  expect(Math.round((await pin.boundingBox())?.width ?? 0)).toBe(28);

  // A pinch zooms the plan; the pin keeps its size.
  const plan = await page.locator('svg.plan-svg').boundingBox();
  if (!plan) throw new Error('no plan');
  const c = { x: plan.x + plan.width / 2, y: plan.y + plan.height / 2 };
  const frames: Pt[][] = [];
  for (let i = 0; i <= 8; i++) {
    const d = 40 + i * 10;
    frames.push([
      { x: c.x - d, y: c.y },
      { x: c.x + d, y: c.y },
    ]);
  }
  await touches(page, frames);
  await expect(pin).toBeVisible();
  expect(Math.round((await pin.boundingBox())?.width ?? 0)).toBe(28);
  expect(await noSideScroll(page)).toBe(true);

  // A tap on the pin opens the thread in a sheet.
  await pin.tap();
  await expect(sheet.getByRole('heading', { name: 'Kitchen' })).toBeVisible();
  await shot(page, 'phone-thread');
  await sheet.getByRole('button', { name: 'Close' }).tap();

  // The panel is a bottom sheet at half height; the handle makes it full.
  await page.getByRole('button', { name: /^Comments, 1 open/ }).tap();
  const panel = page.getByRole('complementary', { name: 'Comments' });
  await expect(panel).toBeVisible();
  const pb = await panel.boundingBox();
  expect(Math.abs((pb?.height ?? 0) - vh / 2)).toBeLessThan(4);
  await shot(page, 'phone-panel');
  await panel.getByRole('button', { name: 'Make the comments full height' }).tap();
  await expect.poll(async () => (await panel.boundingBox())?.height ?? 0).toBeGreaterThan(vh * 0.8);
  expect(await noSideScroll(page)).toBe(true);

  // Dark, for looking at.
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'phone-panel-dark');
  await panel.getByRole('button', { name: /^Kitchen/ }).tap();
  await expect(sheet.getByRole('heading', { name: 'Kitchen' })).toBeVisible();
  await shot(page, 'phone-thread-dark');
});
