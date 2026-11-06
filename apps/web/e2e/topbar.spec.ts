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

for (const width of [360, 390]) {
  test.describe(`a ${width} px phone`, () => {
    test.use({ ...iPhone, viewport: { width, height: 664 } });

    test('the owner’s top bar: every control whole, 40 px, and the view button works', async ({
      page,
    }) => {
      await page.goto('/');
      await waitSaved(page);
      const names = await expectBarFits(page, 40);
      expect(names).toEqual(expect.arrayContaining(['Share', 'Undo', 'Redo', '3D']));
      // The project name keeps room enough to read a word or two.
      const name = await page.getByLabel('Project name').boundingBox();
      expect(name?.width ?? 0).toBeGreaterThanOrEqual(width < 390 ? 56 : 80);

      // One button goes to the other view, and back.
      await page.getByRole('button', { name: /^3D$/ }).tap();
      await expect(page.getByTestId('viewport-wrap')).toBeVisible();
      await page.getByRole('button', { name: /^Plan$/ }).tap();
      await expect(page.locator('svg.plan-svg')).toBeVisible();
      await expect(page.getByTestId('viewport-wrap')).toHaveCount(0);
    });

    test('a viewer’s top bar: every control whole and 40 px', async ({ page, browser }) => {
      await page.goto(await viewLink(browser));
      await expect(page.getByRole('button', { name: 'Make my own copy' })).toBeVisible();
      const names = await expectBarFits(page, 40);
      expect(names).toContain('3D');
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

for (const width of [768, 1024, 1280]) {
  test(`at ${width} px the page never scrolls sideways and the top bar fits`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await waitSaved(page);
    await expectBarFits(page, 28);
  });
}
