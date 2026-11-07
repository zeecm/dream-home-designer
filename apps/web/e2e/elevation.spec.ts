import { readFileSync } from 'node:fs';
import { type Page, devices, expect, test } from '@playwright/test';
import { waitSaved } from './helpers';
import {
  BEDROOM_WALL,
  BETWEEN_BEDROOMS,
  currentDoc,
  furnishedDoc,
  importDoc,
  openFurnished,
  openWall,
  selectWall,
  title,
  wallView,
} from './wallview-setup';

// The wall seen straight on (the spec's elevation), slice 1: docs/specs/elevation.md.

const svg = (page: Page) => wallView(page).locator('svg.elev-svg');
/** Clicks the wall in the drawing low down in its middle, clear of what stands against it. */
async function clickWallInView(page: Page, wallId: string) {
  const hit = svg(page).locator(`[data-elev-hit="wall:${wallId}"]`);
  // Once the drawing has settled (its labels are laid out a moment after it changes).
  await page.waitForTimeout(300);
  const box = await hit.boundingBox();
  if (!box) throw new Error('no wall in the drawing');
  await hit.click({ force: true, position: { x: box.width * 0.5, y: box.height * 0.93 } });
  await expect(page.locator('.inspector .panel-title').first()).toHaveText('Wall');
}
const undoButton = (page: Page) => page.getByRole('button', { name: 'Undo', exact: true });

test.describe('desktop', () => {
  test('18, 19, 24, 25: a bedroom wall from its Inspector; step round; save it; close', async ({
    page,
  }) => {
    await openFurnished(page);
    const undoBefore = await undoButton(page).isDisabled();

    // 18: the Inspector's row, one button per side that faces a room (an outside wall: one).
    await selectWall(page, BEDROOM_WALL);
    const inspector = page.locator('.inspector');
    await expect(inspector.getByText('See it straight on')).toBeVisible();
    await expect(inspector.locator('.elev-entry button')).toHaveCount(1);
    await inspector.getByRole('button', { name: 'Main bedroom side', exact: true }).click();
    await expect(wallView(page)).toBeVisible();
    // The plan stays beside it; the 3D view goes.
    await expect(page.locator('svg.plan-svg')).toBeVisible();
    await expect(page.locator('.viewport canvas')).toHaveCount(0);
    await expect(title(page)).toHaveText('Main bedroom · D · wardrobe wall');
    await expect(wallView(page).locator('.elev-sub')).toHaveText('2 920 × 2 600 mm · Plain paint');
    // The window's sill and head from the floor, the overall length, the ceiling.
    const win = svg(page).locator('[data-height="window"]');
    await expect(win).toContainText('900');
    await expect(win).toContainText('2100');
    await expect(svg(page).locator('[data-tier="2"]')).toContainText('2920');
    await expect(svg(page).locator('[data-height="ceiling"]')).toContainText('2600');
    // The plan marks the room's walls, this one in the accent colour.
    await expect(page.locator('.wall-marker-open')).toHaveAttribute('data-letter', 'D');
    await expect(page.locator('.wall-marker')).toHaveCount(6);

    // 19: next and previous, by button and by ] and [.
    await wallView(page).getByRole('button', { name: 'Next wall' }).click();
    await expect(title(page)).toHaveText(/^Main bedroom · (Wall )?E/);
    await wallView(page).getByRole('button', { name: 'Previous wall' }).click();
    await expect(title(page)).toHaveText(/^Main bedroom · (Wall )?D/);
    await page.keyboard.press(']');
    await expect(title(page)).toHaveText(/^Main bedroom · (Wall )?E/);
    await page.keyboard.press('[');
    await expect(title(page)).toHaveText(/^Main bedroom · (Wall )?D/);
    // A letter on the plan opens its wall.
    await page.locator('.wall-marker[data-letter="C"]').click();
    await expect(title(page)).toHaveText(/^Main bedroom · (Wall )?C/);
    await page.locator('.wall-marker[data-letter="D"]').click();

    // 24: a picture named after the room and the wall, with the drawing's dimensions.
    const download = page.waitForEvent('download');
    await wallView(page).getByRole('button', { name: 'Save image' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('Main bedroom - D wardrobe wall.png');
    const png = readFileSync((await file.path()) as string);
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(png.readUInt32BE(16)).toBeGreaterThan(700); // its width
    expect(png.length).toBeGreaterThan(20_000);

    // 25: Esc clears the selection first, then closes, back to the split view.
    await page.locator('svg.plan-svg').focus();
    await page.keyboard.press('Escape');
    await expect(wallView(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(wallView(page)).toBeHidden();
    await expect(page.locator('.viewport canvas')).toHaveCount(1);
    // Opening, stepping and closing changed nothing in the plan.
    expect(await undoButton(page).isDisabled()).toBe(undoBefore);
    await expect(page.locator('.topbar .pill')).toHaveText('Saved');
    // Close does the same, and focus goes back to the button it was opened from.
    await openWall(page, BEDROOM_WALL, 'Main bedroom');
    await wallView(page).getByRole('button', { name: 'Close' }).click();
    await expect(wallView(page)).toBeHidden();
    await expect(
      page.getByRole('button', { name: 'Main bedroom side', exact: true }),
    ).toBeFocused();
    // L opens the selected wall too.
    await page.keyboard.press('l');
    await expect(title(page)).toHaveText(/^Main bedroom · (Wall )?D/);
  });

  test('20, 21, 22: the other side; a socket set in the Inspector; paint and wallpaper', async ({
    page,
  }) => {
    await openFurnished(page);
    // 20: a wall between the bedrooms has a side each; See from turns it round.
    await selectWall(page, BETWEEN_BEDROOMS);
    await expect(page.locator('.inspector .elev-entry button')).toHaveCount(2);
    await page.getByRole('button', { name: 'Main bedroom side', exact: true }).click();
    await expect(title(page)).toHaveText(/^Main bedroom · (Wall )?E/);
    await wallView(page).getByRole('button', { name: 'See from Bedroom' }).click();
    await expect(title(page)).toHaveText(/^Bedroom · (Wall )?B/);
    await wallView(page).getByRole('button', { name: 'See from Main bedroom' }).click();
    await expect(title(page)).toHaveText(/^Main bedroom · (Wall )?E/);
    // An outside wall has no other side.
    await page.keyboard.press('Escape');
    await openWall(page, BEDROOM_WALL, 'Main bedroom');
    await expect(wallView(page).getByRole('button', { name: /^See from/ })).toHaveCount(0);

    // 21: tap the socket in the drawing; set 1150 in the Inspector; Undo.
    await svg(page).locator('[data-elev-hit="point:pt_bed1"]').click({ force: true });
    await expect(page.locator('.inspector .panel-title').first()).toHaveText('13A double socket');
    const height = page.locator('.inspector').getByLabel('Height');
    await height.fill('1150');
    await height.press('Enter');
    // Its tag (here short, beside the switch's: they'd overlap in full) and its line in the list.
    const row = wallView(page).locator('.elev-row[data-point="pt_bed1"]');
    await expect(row).toContainText('1150 from floor');
    await expect(svg(page).locator('[data-elev-hit="point:pt_bed1"]')).toHaveAttribute(
      'aria-label',
      'Point 2',
    );
    await page.locator('svg.plan-svg').focus();
    await page.keyboard.press('Control+z');
    await expect(row).toContainText('300 from floor');
    // Alone on its wall a socket's tag is in full: h300.
    await expect(svg(page)).toContainText('2 · h300');

    // 22: paint the wall Sage: the drawing's fill follows; a wallpaper tiles at 0.6 m.
    await clickWallInView(page, BEDROOM_WALL);
    await page.getByRole('button', { name: 'Paint, Main bedroom side: Sage' }).click();
    await expect(svg(page).locator('rect[fill="#bccab3"]')).toHaveCount(1);
    await expect(wallView(page).locator('.elev-sub')).toContainText('Sage paint');
    await page
      .getByRole('button', { name: 'Paint, Main bedroom side: Fluted wood wallpaper' })
      .click();
    await expect(wallView(page).locator('.elev-sub')).toContainText('Fluted wood wallpaper');
    const pattern = svg(page).locator('pattern[id$="wp-wallpaper-fluted"]');
    await expect(pattern).toHaveAttribute('width', '0.6');
    await expect(pattern.locator('image')).toHaveAttribute('href', /^data:image\/png/);
    // Two repeats against the overall: the tile is 0.6 of the metre the chain measures.
    const tier2 = svg(page).locator('[data-tier="2"] line').first();
    const span = Number(await tier2.getAttribute('x2')) - Number(await tier2.getAttribute('x1'));
    expect(span).toBeCloseTo(2.916, 2);
  });

  test('23: a socket behind the built-in wardrobe gets a note and a red outline', async ({
    page,
  }) => {
    await openFurnished(page, { hidden: true });
    await openWall(page, BEDROOM_WALL, 'Main bedroom');
    const list = wallView(page).locator('.elev-list');
    await expect(list).toContainText(
      'Socket 3 is behind the built-in wardrobe: you won’t reach it. Move it, or ask the carpenter for a cut-out.',
    );
    await expect(wallView(page).getByRole('button', { name: '1 to check' })).toBeVisible();
    await expect(svg(page).locator('[data-note="1"] rect').first()).toHaveAttribute(
      'stroke',
      '#c4242a',
    );
    // The note selects what it is about.
    await list.getByRole('button', { name: /Socket 3 is behind/ }).click();
    await expect(page.locator('.inspector .panel-title').first()).toHaveText('13A double socket');
  });

  test('26: the open wall deleted: "That wall is gone."; Undo brings it back', async ({ page }) => {
    await openFurnished(page);
    await openWall(page, BETWEEN_BEDROOMS, 'Main bedroom');
    await page
      .locator('.inspector')
      .getByRole('button', { name: /^Delete/ })
      .click();
    await expect(wallView(page)).toContainText('That wall is gone.');
    await page.keyboard.press('Control+z');
    await expect(title(page)).toHaveText(/^Main bedroom · (Wall )?E/);
  });

  test('27: a renovation: a new window in teal; Before keeps the wall; the wall taken down', async ({
    page,
  }) => {
    await page.goto('/');
    await waitSaved(page);
    const doc = furnishedDoc(await currentDoc(page));
    const after = structuredClone(doc.levels[0]);
    after.id = `${after.id}~after`;
    after.openings.op_new = {
      id: 'op_new',
      wallId: BETWEEN_BEDROOMS,
      kind: 'window',
      t: 0.5,
      width: 0.6,
      height: 1.2,
      sill: 0.9,
    };
    doc.renovation = { levels: [after] };
    await importDoc(page, doc);
    await page.keyboard.press('2');
    await page.locator('.reno-bar').getByRole('button', { name: 'After' }).click();
    await openWall(page, BETWEEN_BEDROOMS, 'Main bedroom');
    await expect(svg(page).locator('[data-new="op_new"]')).toHaveCount(1);
    await expect(wallView(page).locator('.elev-key')).toContainText('New');
    // Before: the same wall, without the window.
    // One Before | After switch: the app's.
    await expect(wallView(page).getByRole('button', { name: 'Before', exact: true })).toHaveCount(
      0,
    );
    await page.locator('.reno-bar').getByRole('button', { name: 'Before', exact: true }).click();
    await expect(title(page)).toHaveText(/^Main bedroom · (Wall )?E/);
    await expect(svg(page).locator('[data-opening="op_new"]')).toHaveCount(0);
    // After, the whole wall hacked.
    await page.locator('.reno-bar').getByRole('button', { name: 'After', exact: true }).click();
    await clickWallInView(page, BETWEEN_BEDROOMS);
    await page
      .locator('.inspector')
      .getByRole('button', { name: /^Delete/ })
      .click();
    await expect(wallView(page)).toContainText('This wall is taken down in the renovation.');
    await wallView(page).getByRole('button', { name: 'See it as it is' }).click();
    await expect(title(page)).toHaveText(/^Main bedroom · (Wall )?E/);
    await expect(wallView(page).locator('.elev-sub')).toContainText('Taken down in the renovation');
  });

  test('28: a view link opens the wall view and steps; nothing changes', async ({
    page,
    browser,
  }) => {
    await openFurnished(page);
    await page.getByRole('button', { name: 'Share' }).click();
    const viewLink = await page.getByLabel('View-only link').inputValue();
    await page.keyboard.press('Escape');
    const viewer = await (await browser.newContext()).newPage();
    await viewer.goto(viewLink);
    await expect(viewer.getByText('View only.')).toBeVisible();
    await viewer.keyboard.press('2');
    await selectWall(viewer, BEDROOM_WALL);
    await viewer.getByRole('button', { name: 'Main bedroom side', exact: true }).click();
    await expect(title(viewer)).toHaveText(/^Main bedroom · (Wall )?D/);
    await wallView(viewer).getByRole('button', { name: 'Next wall' }).click();
    await expect(title(viewer)).toHaveText(/^Main bedroom · (Wall )?E/);
    await expect(undoButton(viewer)).toBeDisabled();
  });

  test('30: in the dark theme the drawing stays dark on white', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await openFurnished(page);
    await openWall(page, BEDROOM_WALL, 'Main bedroom');
    const bg = await wallView(page)
      .locator('.elev-sheet')
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).toBe('rgb(255, 255, 255)');
    await expect(svg(page).locator('line[stroke="#1b1e22"]').first()).toBeAttached();
  });
});

// Fingers only, on a phone held upright, then on its side.
const { defaultBrowserType: _webkit, ...iPhone } = devices['iPhone 13'];

async function tapCentre(page: Page, selector: ReturnType<Page['locator']>) {
  await selector.scrollIntoViewIfNeeded();
  const box = await selector.boundingBox();
  if (!box) throw new Error('not on screen');
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

/** Opens the main bedroom's walls from its room on the plan, by finger. */
async function openByFinger(page: Page) {
  await openFurnished(page);
  await page.keyboard.press('1');
  const room = page.locator('svg.plan-svg [data-hit="room:rm_main-bedroom"]').first();
  await expect(room).toBeVisible();
  await tapCentre(page, room);
  await expect(page.locator('.inspector .panel-title').first()).toHaveText('Room');
  await tapCentre(page, page.getByRole('button', { name: 'See its walls' }));
  await expect(wallView(page)).toBeVisible();
}

test.describe('phone', () => {
  test.use(iPhone);

  test('29: by finger: fills the stage, pinch and double tap, the walls menu, Back closes', async ({
    page,
  }) => {
    await openByFinger(page);
    await expect(title(page)).toHaveText(/^Main bedroom · (Wall )?A/);
    // The room stays selected; its details fold away under a handle.
    await expect(page.locator('.inspector-toggle')).toHaveText('Show details');
    // The stage is the wall view's: no plan, no tool bar; its own bar of 44 px targets.
    await expect(page.locator('svg.plan-svg')).toHaveCount(0);
    await expect(page.locator('.palette')).toBeHidden();
    const bar = wallView(page).locator('.elev-bar');
    for (const b of await bar.locator('.elev-bar-btn').all()) {
      const box = await b.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    }
    // Upright, the list of points is text under the drawing.
    await expect(wallView(page).locator('.elev-list')).toBeVisible();
    const wide = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(wide).toBe(false);

    // Pinch to zoom, with feedback before the fingers lift; a double tap fits again.
    const sheet = wallView(page).locator('.elev-sheet');
    const box = await sheet.boundingBox();
    if (!box) throw new Error('no sheet');
    const c = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const frames = Array.from({ length: 10 }, (_, i) => [
      { x: c.x - 30 - i * 8, y: c.y },
      { x: c.x + 30 + i * 8, y: c.y },
    ]);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: (frames[0] ?? []).map((p, id) => ({ ...p, id })),
    });
    for (const f of frames.slice(1)) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: f.map((p, id) => ({ ...p, id })),
      });
      await page.waitForTimeout(16);
    }
    // Mid-gesture: zoomed already.
    expect(Number(await sheet.getAttribute('data-zoom'))).toBeGreaterThan(1.5);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(300);
    await page.touchscreen.tap(c.x, c.y);
    await page.waitForTimeout(80);
    await page.touchscreen.tap(c.x, c.y);
    await expect(sheet).toHaveAttribute('data-zoom', '1.00');

    // The walls menu jumps to a wall.
    await tapCentre(page, bar.locator('summary').first());
    await tapCentre(page, wallView(page).getByRole('button', { name: 'D · wardrobe wall' }));
    await expect(title(page)).toHaveText('Main bedroom · D · wardrobe wall');
    // Tap a socket in the drawing: the Inspector sheet shows it.
    await tapCentre(page, wallView(page).locator('[data-elev-hit="point:pt_bed1"]'));
    await expect(page.locator('.inspector .panel-title').first()).toHaveText('13A double socket');

    // Back closes it, to the plan.
    await page.goBack();
    await expect(wallView(page)).toHaveCount(0);
    await expect(page.locator('svg.plan-svg')).toBeVisible();
    // And Close does too.
    await tapCentre(page, page.getByRole('button', { name: 'See on its wall' }));
    await expect(title(page)).toHaveText(/^Main bedroom · (Wall )?D/);
    await tapCentre(page, bar.getByRole('button', { name: 'Close' }));
    await expect(wallView(page)).toHaveCount(0);
    await expect(page.locator('.palette')).toBeVisible();
    // Closed by a view key (1, 2, 3), its history entry goes too: Back then leaves nothing
    // behind, and the plan stays open.
    const url = page.url();
    await tapCentre(page, page.getByRole('button', { name: 'See on its wall' }));
    await expect(wallView(page)).toBeVisible();
    await page.keyboard.press('1');
    await expect(wallView(page)).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() => !!(history.state as { dhdWallView?: boolean } | null)?.dhdWallView),
      )
      .toBe(false);
    expect(page.url()).toBe(url);
    await expect(page.locator('svg.plan-svg')).toBeVisible();
  });

  test('29, slow phone: every tap on › counts, and a pinch then double tap fits, CPU 4×', async ({
    page,
  }) => {
    await openByFinger(page);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const next = wallView(page).getByRole('button', { name: 'Next wall' });
    for (const letter of ['B', 'C', 'D', 'E']) {
      await tapCentre(page, next);
      await expect(title(page)).toHaveText(new RegExp(`^Main bedroom · (Wall )?${letter}`));
    }
    // Pinch, then a double tap on whatever is in the middle: it fits, and selects nothing
    // (the first tap waits out the double tap before it would select).
    const sheet = wallView(page).locator('.elev-sheet');
    const box = await sheet.boundingBox();
    if (!box) throw new Error('no sheet');
    const c = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const frames = Array.from({ length: 10 }, (_, i) => [
      { x: c.x - 30 - i * 8, y: c.y },
      { x: c.x + 30 + i * 8, y: c.y },
    ]);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: (frames[0] ?? []).map((p, id) => ({ ...p, id })),
    });
    for (const f of frames.slice(1)) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: f.map((p, id) => ({ ...p, id })),
      });
      await page.waitForTimeout(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(sheet).not.toHaveAttribute('data-zoom', '1.00');
    const before = await page.locator('.inspector-toggle').textContent();
    await page.waitForTimeout(300);
    await page.touchscreen.tap(c.x, c.y);
    await page.waitForTimeout(80);
    await page.touchscreen.tap(c.x, c.y);
    await expect(sheet).toHaveAttribute('data-zoom', '1.00');
    await page.waitForTimeout(500);
    await expect(page.locator('.inspector-toggle')).toHaveText(before ?? '');
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  });

  test('on its side: the list is a panel beside the drawing, hidden and shown from ⋯', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await openByFinger(page);
    const list = wallView(page).locator('.elev-list');
    const sheet = wallView(page).locator('.elev-sheet');
    await expect(list).toBeVisible();
    const lb = await list.boundingBox();
    const sb = await sheet.boundingBox();
    expect((lb?.x ?? 0) > (sb?.x ?? 0) + (sb?.width ?? 0) - 1).toBe(true);
    await tapCentre(page, wallView(page).locator('summary[aria-label="More"]'));
    await tapCentre(page, wallView(page).getByRole('button', { name: 'Hide list' }));
    await expect(list).toBeHidden();
    await tapCentre(page, wallView(page).locator('summary[aria-label="More"]'));
    await tapCentre(page, wallView(page).getByRole('button', { name: 'Show list' }));
    await expect(list).toBeVisible();
  });
});
