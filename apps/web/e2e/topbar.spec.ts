import { type Browser, type Page, devices, expect, test } from '@playwright/test';
import { waitSaved } from './helpers';

// The top bar fits every screen: on a phone each control is a whole 40 px target, none cut
// off by the screen's edge; on a tablet or a laptop the page never scrolls sideways.
const { defaultBrowserType: _webkit, ...iPhone } = devices['iPhone 13'];
const { defaultBrowserType: _webkit2, ...iPadMini } = devices['iPad Mini'];

type Control = { name: string; left: number; right: number; w: number; h: number; cut: boolean };

/** Every control the top bar shows, and the page's sideways overflow. */
const measure = (page: Page) =>
  page.evaluate(() => {
    const controls: Control[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('.topbar button, .topbar input')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      controls.push({
        name: el.getAttribute('aria-label') || el.textContent?.trim() || el.tagName,
        left: r.left,
        right: r.right,
        w: r.width,
        h: r.height,
        // A label wider than its button is cut off inside it.
        cut: el.tagName === 'BUTTON' && el.scrollWidth > el.clientWidth + 1,
      });
    }
    return {
      controls,
      vw: window.innerWidth,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });

async function viewLink(browser: Browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto('/');
  await waitSaved(page);
  await page.getByRole('button', { name: 'Share' }).click();
  const link = await page.getByLabel('View-only link').inputValue();
  await ctx.close();
  return link;
}

async function expectBarFits(page: Page, minTarget: number) {
  await page.evaluate(() => document.fonts.ready);
  // Comments are on, so their button takes its room in the bar.
  const comments = page.locator('.comments-btn');
  await expect(comments).toBeVisible();
  await expect(comments).not.toHaveAttribute('aria-disabled', 'true');
  const m = await measure(page);
  expect(m.overflow).toBe(0);
  const names = m.controls.map((c) => c.name);
  expect(names).toContain('Projects');
  for (const c of m.controls) {
    expect.soft(c.left, `${c.name} starts on screen`).toBeGreaterThanOrEqual(0);
    expect.soft(c.right, `${c.name} ends on screen`).toBeLessThanOrEqual(m.vw);
    expect.soft(c.cut, `${c.name} shows its whole label`).toBe(false);
    expect.soft(c.h, `${c.name} is tall enough to tap`).toBeGreaterThanOrEqual(minTarget);
    if (c.name !== 'Project name') {
      expect.soft(c.w, `${c.name} is wide enough to tap`).toBeGreaterThanOrEqual(minTarget);
    }
  }
  return names;
}

for (const width of [320, 360, 390]) {
  test.describe(`a ${width} px phone`, () => {
    test.use({ ...iPhone, viewport: { width, height: 664 } });

    test('the owner’s top bar: every control whole, 40 px, and the view button works', async ({
      page,
    }) => {
      await page.goto('/');
      await waitSaved(page);
      const names = await expectBarFits(page, 40);
      expect(names).toEqual(expect.arrayContaining(['Share', 'Undo', 'Redo', 'Switch to 3D']));
      // The project name keeps room enough to read a word or two; on the first SE it gives way.
      const name = page.getByLabel('Project name');
      if (width < 352) await expect(name).toBeHidden();
      else expect((await name.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(48);

      // One button goes to the other view, and back. A tap leaves it as it was (no hover
      // fill stuck on), and touch gets no tooltip.
      const toggle = page.locator('.view-toggle');
      const rest = await toggle.evaluate((b) => getComputedStyle(b).backgroundColor);
      await expect(toggle).not.toHaveAttribute('title');
      await page.getByRole('button', { name: 'Switch to 3D' }).tap();
      await expect(page.getByTestId('viewport-wrap')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Switch to Plan', exact: true })).toBeVisible();
      expect(await toggle.evaluate((b) => getComputedStyle(b).backgroundColor)).toBe(rest);
      await page.getByRole('button', { name: 'Switch to Plan', exact: true }).tap();
      await expect(page.locator('svg.plan-svg')).toBeVisible();
      await expect(page.getByTestId('viewport-wrap')).toHaveCount(0);
    });

    test('a viewer’s top bar: every control whole and 40 px', async ({ page, browser }) => {
      await page.goto(await viewLink(browser));
      await expect(page.getByRole('button', { name: 'Make my own copy' })).toBeVisible();
      const names = await expectBarFits(page, 40);
      expect(names).toContain('Switch to 3D');
      expect(names).not.toContain('Undo');
    });

    test('a dialog with a body is a full-screen sheet, its actions in sight', async ({ page }) => {
      await page.goto('/');
      await waitSaved(page);
      await page.getByRole('button', { name: 'Projects' }).tap();
      await page.getByRole('button', { name: 'AI assistant…' }).tap();
      const dialog = page.getByRole('dialog', { name: 'AI assistant' });
      await expect(dialog).toBeVisible();
      const box = await dialog.boundingBox();
      expect(box).toMatchObject({ x: 0, y: 0, width, height: 664 });
      const foot = await dialog.locator('.dialog-foot').boundingBox();
      expect((foot?.y ?? 0) + (foot?.height ?? 0)).toBeCloseTo(664, 0);
      await expect(dialog.getByRole('button', { name: 'Save' })).toBeInViewport();
    });
  });
}

test.describe('an iPad mini, upright', () => {
  test.use({ ...iPadMini });

  test('the page never scrolls sideways; the view switch is whole; dialogs sit centred', async ({
    page,
  }) => {
    await page.goto('/');
    await waitSaved(page);
    const names = await expectBarFits(page, 32);
    expect(names).toEqual(expect.arrayContaining(['Plan', 'Split', '3D']));
    await page.getByRole('button', { name: 'Projects' }).tap();
    await page.getByRole('button', { name: 'AI assistant…' }).tap();
    const box = await page.getByRole('dialog', { name: 'AI assistant' }).boundingBox();
    if (!box) throw new Error('no dialog');
    expect(Math.abs(box.x + box.width / 2 - 768 / 2)).toBeLessThanOrEqual(1);
  });
});

// Every phone on its side gets the same one button as upright.
for (const name of ['iPhone 13 landscape', 'iPhone SE landscape'] as const) {
  test.describe(name, () => {
    const { defaultBrowserType: _b, ...device } = devices[name];
    test.use(device);
    test('one view button, as upright, and no sideways scroll', async ({ page }) => {
      await page.goto('/');
      await waitSaved(page);
      await expect(page.locator('.topbar-right > .segmented')).toBeHidden();
      await expect(page.getByRole('button', { name: 'Switch to 3D' })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    });
  });
}

test('Split under 720 px shows one view, the button goes to the other, and wider is Split again', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('2');
  await expect(page.locator('main.stage')).toHaveClass(/stage-split/);
  await page.setViewportSize({ width: 700, height: 800 });
  // The last single view chosen (the plan, here), never the two stacked.
  await expect(page.locator('main.stage')).toHaveClass(/stage-plan/);
  await expect(page.getByTestId('viewport-wrap')).toHaveCount(0);
  await page.getByRole('button', { name: 'Switch to 3D' }).click();
  await expect(page.locator('main.stage')).toHaveClass(/stage-3d/);
  // Split chosen by key on a narrow screen keeps the view on screen.
  await page.keyboard.press('2');
  await expect(page.locator('main.stage')).toHaveClass(/stage-3d/);
  await expect(page.getByRole('button', { name: 'Switch to Plan', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.locator('main.stage')).toHaveClass(/stage-split/);
});

for (const width of [768, 1024, 1280]) {
  test(`at ${width} px the page never scrolls sideways and the top bar fits`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await waitSaved(page);
    await expectBarFits(page, 28);
  });
}
