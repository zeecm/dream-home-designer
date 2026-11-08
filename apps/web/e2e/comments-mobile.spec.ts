import { placeFridge, waitSaved } from './helpers';
import { type Page, devices, expect, test } from './test';

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

/** The open pin is on the plan, in the strip the sheet leaves above it. */
async function expectPinAboveSheet(page: Page) {
  await expect
    .poll(async () => {
      const pin = await page.locator('.comment-pin-active').boundingBox();
      const sheet = await page.locator('.comment-sheet').boundingBox();
      const plan = await page.locator('svg.plan-svg').boundingBox();
      if (!pin || !sheet || !plan) return false;
      return pin.y >= plan.y && pin.y + pin.height <= sheet.y;
    })
    .toBe(true);
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
  // The keyboard takes the lower half (as near as a test gets: a shorter viewport). The
  // sheet shrinks above it, its fields scroll, and Post stays in sight.
  const keyboard = (height: number | null) =>
    page.evaluate((h) => {
      const vv = window.visualViewport;
      if (!vv) return;
      if (h === null) delete (vv as unknown as Record<string, unknown>).height;
      else Object.defineProperty(vv, 'height', { configurable: true, get: () => h });
      vv.dispatchEvent(new Event('resize'));
    }, height);
  await keyboard(328);
  await expect
    .poll(async () => {
      const b = await sheet.getByRole('button', { name: 'Post' }).boundingBox();
      return (b?.y ?? 999) + (b?.height ?? 0);
    })
    .toBeLessThanOrEqual(328);
  await shot(page, 'phone-compose-keyboard');
  await keyboard(null);
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
  // Around the pin, so it stays on screen as the plan grows.
  const pb0 = await pin.boundingBox();
  const c = { x: (pb0?.x ?? plan.x) + 14, y: Math.max(plan.y + 60, (pb0?.y ?? plan.y) + 40) };
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
  // The plan moves so the pin shows in the strip above the sheet.
  await expectPinAboveSheet(page);
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
  await expectPinAboveSheet(page);
  await shot(page, 'phone-thread-dark');
});

test('on a phone with the edit link, a tap on a small piece under a pin selects the piece', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  // The owner, at a desk: a fridge, a comment on it, and an edit link.
  const desk = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const owner = await desk.newPage();
  await owner.goto('/');
  await waitSaved(owner);
  await owner.keyboard.press('1');
  await placeFridge(owner);
  await owner.getByRole('button', { name: 'Comment K', exact: true }).click();
  const box = await owner.locator('[data-hit^="item:"]').first().boundingBox();
  if (!box) throw new Error('no fridge');
  await owner.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const compose = owner.locator('[data-comment-compose]');
  await compose.getByLabel('Your name').fill('Wei Ling');
  await compose.getByLabel('Comment').fill('Blocks the service yard?');
  await compose.getByRole('button', { name: 'Post' }).click();
  await expect(owner.getByRole('button', { name: /^Comment by Wei Ling on Fridge/ })).toBeVisible();
  await owner.getByRole('button', { name: 'Share' }).click();
  await owner.getByLabel('Also allow editing with a separate link').click();
  const editLink = await owner.getByLabel('Edit link').inputValue();

  // Dad, on his phone: a tap on the fridge, where the pin's tip is, selects the fridge.
  await page.goto(editLink);
  await waitSaved(page);
  await page.evaluate(() => document.fonts.ready);
  const pin = page.getByRole('button', { name: /^Comment by Wei Ling on Fridge/ });
  await expect(pin).toBeVisible();
  const fridge = await page.locator('[data-hit^="item:"]').first().boundingBox();
  if (!fridge) throw new Error('no fridge on the phone');
  await page.touchscreen.tap(fridge.x + fridge.width / 2, fridge.y + fridge.height / 2);
  // Selected: the plan says so (the details panel may stay folded on a phone).
  await expect(page.locator('p.visually-hidden[aria-live="polite"]').first()).toContainText(
    'Fridge in Kitchen',
  );
  await expect(page.locator('.comment-sheet')).toHaveCount(0);
  // The pin's bubble still opens its thread.
  const bubble = await pin.boundingBox();
  if (!bubble) throw new Error('no pin');
  await page.touchscreen.tap(bubble.x + bubble.width / 2, bubble.y + 8);
  await expect(
    page.locator('.comment-sheet').getByRole('heading', { name: 'Fridge' }),
  ).toBeVisible();
  await desk.close();
});
