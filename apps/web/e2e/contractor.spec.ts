import { type Page, expect, test } from '@playwright/test';
import { newBlankPlan, waitSaved } from './helpers';

const WALL = '[data-hit="wall:w_bedroom_living-and-dining"]';

// The print dialog is stubbed in every frame (the sheet prints from a frame of its own): it
// counts, on the top window, how often it was asked for.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.print = () => {
      const top = window.top as unknown as { __printed?: number };
      top.__printed = (top.__printed ?? 0) + 1;
    };
  });
});

const sheet = (page: Page) => page.frameLocator('iframe[data-print="contractor"]');
const printed = (page: Page) =>
  page.evaluate(() => (window as unknown as { __printed?: number }).__printed ?? 0);

async function openDialog(page: Page) {
  await page.getByRole('button', { name: 'Projects' }).click();
  await page.getByRole('button', { name: 'Plan for contractors (PDF)' }).click();
  const dialog = page.getByRole('dialog', { name: 'Plan for contractors' });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function printSheet(page: Page) {
  const before = await printed(page);
  const dialog = await openDialog(page);
  await dialog.getByRole('button', { name: 'Print or save as PDF' }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => printed(page)).toBe(before + 1);
  await expect(sheet(page).locator('svg.contractor-page').first()).toBeAttached();
}

test('8: a blank plan has nothing to measure: the item is disabled', async ({ page }) => {
  await newBlankPlan(page);
  await page.getByRole('button', { name: 'Projects' }).click();
  await expect(page.getByRole('button', { name: 'Plan for contractors (PDF)' })).toBeDisabled();
});

test('9, 10, 13: the sample on A4 at 1:100, with every room, door tags and the view kept', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('1');

  // Rooms and areas from the plan details; door widths from each door's details.
  const rooms = await page.locator('.room-list li').evaluateAll((lis) =>
    lis.map((li) => ({
      name: li.querySelector('.room-list-name')?.textContent ?? '',
      area: li.querySelector('.num')?.textContent ?? '',
    })),
  );
  expect(rooms.length).toBeGreaterThanOrEqual(8);
  const doorIds = await page
    .locator('.openings [data-hit^="opening:op_door"]')
    .evaluateAll((gs) => gs.map((g) => (g.getAttribute('data-hit') ?? '').slice(8)));
  expect(doorIds.length).toBeGreaterThanOrEqual(4);
  const widths: Record<string, string> = {};
  for (const id of doorIds) {
    await page.locator(`[data-hit="opening:${id}"]`).first().click({ force: true });
    const value = await page.getByRole('textbox', { name: 'Width' }).inputValue();
    widths[id] = String(Math.round(Number.parseFloat(value) * 1000));
  }
  await page.keyboard.press('Escape');

  const undo = page.getByRole('button', { name: 'Undo' });
  const undoBefore = await undo.isDisabled();
  const version = await page.getByTestId('sync').getAttribute('data-version');

  const dialog = await openDialog(page);
  await expect(dialog.getByRole('button', { name: 'A4, 1:100' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(dialog.getByRole('button', { name: 'A3, 1:50' })).toBeVisible();
  // No renovation: no version to choose. Furniture is off.
  await expect(dialog.getByText('Version')).toHaveCount(0);
  await expect(dialog.getByLabel('Include furniture')).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await printSheet(page);

  const s = sheet(page);
  const page1 = s.locator('svg.contractor-page').first();
  await expect(s.locator('svg.contractor-page')).toHaveCount(1);
  await expect(page1.locator('.sheet-name')).toHaveText('3-room HDB (sample)');
  const today = await page.evaluate(() =>
    new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
  );
  await expect(page1.locator('.sheet-date')).toHaveText(today);
  await expect(page1.locator('.sheet-caveat')).toContainText(
    'For discussion, not for construction',
  );
  await expect(page1.locator('.sheet-scale')).toHaveText('1:100 at A4');
  // No renovation: the version is the flat as it is.
  await expect(page1.locator('.sheet-version')).toHaveText('As it is now');
  // Each page in a box of the paper's size that clips: no blank page after it.
  await expect(s.locator('.sheet-paper')).toHaveCount(1);
  await expect(page1.locator('.scale-bar')).toHaveAttribute('data-metres', '5');
  await expect(page1.locator('.scale-bar')).toHaveAttribute('data-mm', '50');
  await expect(page1.locator('.north-arrow')).toHaveAttribute('data-degrees', '0');
  // Four overalls, one a side, each a single figure in millimetres.
  const overalls = page1.locator('.dim-chain[data-tier="2"]');
  await expect(overalls).toHaveCount(4);
  for (const side of ['top', 'right', 'bottom', 'left']) {
    const o = page1.locator(`.dim-chain[data-tier="2"][data-side="${side}"] .dim-text`);
    await expect(o).toHaveCount(1);
    await expect(o).toHaveText(/^\d{4,5}$/);
  }
  await expect(page1.locator('.dim-chain[data-tier="2"][data-side="top"] .dim-text')).toHaveText(
    '10280',
  );
  // Slice 2s C1: the slot between the air-con ledge and the kitchen has its depth, inside
  // the outline, and never the word "notch".
  const notch = page1.locator('.dim-notch[data-notch]');
  await expect(notch).toHaveCount(1);
  await expect(page1.locator('.dim-notch[data-depth="1000"]')).toHaveCount(1);
  await expect(notch.locator('.dim-text')).toHaveText('1000');
  const inside = await page1.evaluate((svg) => {
    const walls = (svg.querySelector('.plan .walls') as SVGGraphicsElement).getBBox();
    const n = (svg.querySelector('.dim-notch') as SVGGraphicsElement).getBBox();
    return (
      n.x >= walls.x &&
      n.y >= walls.y &&
      n.x + n.width <= walls.x + walls.width &&
      n.y + n.height <= walls.y + walls.height
    );
  });
  expect(inside).toBe(true);
  await expect(page1).not.toContainText(/notch/i);

  // 10: every room's name and area, and each door's tag at its width.
  const labels = await page1.locator('.room').evaluateAll((gs) =>
    gs.map((g) => ({
      name: g.querySelector('.room-name')?.textContent ?? '',
      area: (g.querySelector('.room-area')?.textContent ?? '').split(' · ')[0],
    })),
  );
  expect(labels.sort((a, b) => a.name.localeCompare(b.name))).toEqual(
    rooms.sort((a, b) => a.name.localeCompare(b.name)),
  );
  await expect(page1.locator('.room-area').first()).toContainText('sq ft');
  for (const [id, w] of Object.entries(widths)) {
    await expect(page1.locator(`.opening-tag[data-opening="${id}"]`)).toHaveText(`D ${w}`);
  }
  // No renovation: no hacking in the key.
  await expect(page1.locator('.legend-key[data-key="hacked"]')).toHaveCount(0);
  await expect(page1.locator('.legend-key[data-key="structural"]')).toHaveCount(1);

  // 13: the view, the selection and the history are as they were; nothing was saved.
  await expect(page.getByRole('button', { name: 'Plan', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(await undo.isDisabled()).toBe(undoBefore);
  await expect(page.getByTestId('sync')).toHaveAttribute('data-version', version ?? '');
  await expect(page.locator('.inspector')).toContainText('Rooms');
  expect(errors).toEqual([]);
});

test('11: a renovation: the hacking key on page 1, page 2 matches the copied list', async ({
  page,
}) => {
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('1');
  await page.getByRole('button', { name: 'Plan a renovation' }).click();
  await page.locator(WALL).first().click({ force: true });
  await page.keyboard.press('Delete');
  await page.keyboard.press('Escape');
  await expect(page.locator(WALL)).toHaveCount(0);

  const list = page.locator('.reno-changes');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await list.getByRole('button', { name: 'Copy list' }).click();
  await expect(list.getByRole('button', { name: 'Copied' })).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());

  const dialog = await openDialog(page);
  await expect(dialog.getByRole('button', { name: 'After' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await dialog.getByRole('button', { name: 'Close' }).click();
  await printSheet(page);
  const s = sheet(page);
  const pages = s.locator('svg.contractor-page');
  await expect(pages).toHaveCount(2);
  const p1 = pages.nth(0);
  await expect(p1.locator('.sheet-version')).toHaveText('After the renovation');
  await expect(p1.locator('.legend-key[data-key="hacked"]')).toHaveCount(1);
  await expect(p1.locator('.reno-hacked polygon')).toHaveCount(1);
  await expect(p1.locator('.sheet-page')).toHaveText('Page 1 of 2');
  const p2 = pages.nth(1);
  await expect(p2.locator('.sheet-page')).toHaveText('Page 2 of 2');
  const lines = await p2.locator('.change-line').allTextContents();
  expect(lines).toEqual(copied.split('\n').filter((l) => l.length > 0));
  expect(lines.join('\n')).toContain('Hack');
  await expect(p2.locator('.notes-lines line').first()).toBeAttached();
  // No prices on the sheet: the estimate is the owner's.
  expect((await p2.textContent()) ?? '').not.toMatch(/\$|S\$/);

  // As it is now: one page, nothing hacked.
  const again = await openDialog(page);
  await again.getByRole('button', { name: 'As it is now' }).click();
  await again.getByRole('button', { name: 'Print or save as PDF' }).click();
  await expect(again).toBeHidden();
  await expect(s.locator('svg.contractor-page')).toHaveCount(1);
  await expect(s.locator('.sheet-version')).toHaveText('As it is now');
  await expect(s.locator('.legend-key[data-key="hacked"]')).toHaveCount(0);
});

test('12: in the dark theme the sheet is dark on white, with no plan image or handles', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('1');
  await expect(page.locator('image.underlay')).toHaveCount(1);
  await printSheet(page);
  const s = sheet(page);
  const svg = s.locator('svg.contractor-page').first();
  await expect(svg.locator('image')).toHaveCount(0);
  await expect(svg.locator('.vertices, [data-hit], [data-export]')).toHaveCount(0);
  const colours = await svg.evaluate((el) => {
    const bg = getComputedStyle(el.querySelector(':scope > rect') as Element).fill;
    const texts = [...el.querySelectorAll('text')].map((t) => getComputedStyle(t).fill);
    return { bg, texts: [...new Set(texts)] };
  });
  expect(colours.bg).toBe('rgb(255, 255, 255)');
  for (const c of colours.texts) {
    const [r, g, b] = (c.match(/\d+/g) ?? []).map(Number);
    expect((r ?? 255) + (g ?? 255) + (b ?? 255), c).toBeLessThan(330);
  }
});

/** The plan open now, as the server has it. */
async function currentDoc(page: Page) {
  return page.evaluate(async () => {
    const id = localStorage.getItem('dhd:last');
    const r = await fetch(`/api/projects/${id}`);
    return r.json();
  });
}

/** Opens a project from a file, as Projects ▸ Open a project file does. */
async function importDoc(page: Page, doc: unknown) {
  await page.locator('input[type="file"][accept=".json,application/json"]').setInputFiles({
    name: 'plan.dreamhome.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(doc)),
  });
  await waitSaved(page);
}

test('printing hands the keyboard back: the frame goes after printing, focus on Projects', async ({
  page,
}) => {
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('1');
  const projects = page.getByRole('button', { name: 'Projects' });
  // Closing the dialog returns to the Projects button.
  const dialog = await openDialog(page);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
  await expect(projects).toBeFocused();

  await printSheet(page);
  await expect(page.locator('iframe[data-print="contractor"]')).toHaveCount(1);
  // The print dialog closes: the frame goes, and the keys work at once.
  await page.evaluate(() => {
    const f = document.querySelector('iframe[data-print="contractor"]') as HTMLIFrameElement;
    f.contentWindow?.dispatchEvent(new Event('afterprint'));
  });
  await expect(page.locator('iframe[data-print="contractor"]')).toHaveCount(0);
  await expect(projects).toBeFocused();
  await page.keyboard.press('3');
  await expect(page.getByRole('button', { name: 'Plan', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await page.keyboard.press('1');
  await expect(page.getByRole('button', { name: 'Plan', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('a plan too big for A4 to scale opens on A3, which has it at 1:200', async ({ page }) => {
  await page.goto('/');
  await waitSaved(page);
  const doc = await currentDoc(page);
  // The sample, three and a half times the size: about 36 m across.
  for (const v of Object.values(doc.levels[0].vertices) as { x: number; y: number }[]) {
    v.x *= 3.5;
    v.y *= 3.5;
  }
  doc.name = 'Big plan';
  doc.levels[0].items = {};
  await importDoc(page, doc);
  await expect(page.getByRole('textbox', { name: 'Project name' })).toHaveValue('Big plan');
  const dialog = await openDialog(page);
  await expect(dialog.getByRole('button', { name: 'A3, 1:200' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(dialog.getByRole('button', { name: 'A4, not to scale' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  // Picked, A4 stays picked.
  await dialog.getByRole('button', { name: 'A4, not to scale' }).click();
  await expect(dialog.getByRole('button', { name: 'A4, not to scale' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('After: glass, a half wall and a new door each show as new, the door cut in red', async ({
  page,
}) => {
  await page.goto('/');
  await waitSaved(page);
  const doc = await currentDoc(page);
  const before = doc.levels[0];
  const after = structuredClone(before);
  after.id = `${before.id}~after`;
  after.walls['w_bedroom_living-and-dining-3'].build = 'glass';
  after.walls['w_bedroom_living-and-dining'].height = 1;
  // A new door, cut into the wall between the bedrooms.
  after.openings.op_new_door = {
    id: 'op_new_door',
    wallId: 'w_bedroom_main-bedroom',
    kind: 'door',
    t: 0.5,
    width: 0.8,
    height: 2.1,
    sill: 0,
  };
  doc.renovation = { levels: [after] };
  doc.name = 'Renovated';
  await importDoc(page, doc);
  await expect(page.getByRole('textbox', { name: 'Project name' })).toHaveValue('Renovated');

  const dialog = await openDialog(page);
  await dialog.getByRole('button', { name: 'After' }).click();
  await dialog.getByRole('button', { name: 'Print or save as PDF' }).click();
  await expect(dialog).toBeHidden();
  const p1 = sheet(page).locator('svg.contractor-page').first();
  await expect(p1.locator('[data-built="glass"]').first()).toBeAttached();
  await expect(p1.locator('[data-built="half"]').first()).toBeAttached();
  const door = p1.locator('.openings g[data-opening="op_new_door"]');
  await expect(door).toHaveAttribute('data-new', 'true');
  await expect(door).toHaveAttribute('data-cut', 'true');
  await expect(door.locator('line').first()).toHaveAttribute('stroke', '#0f8288');
  await expect(p1.locator('.opening-tag[data-opening="op_new_door"]')).toHaveAttribute(
    'fill',
    '#0f8288',
  );
  // Existing doors stay black.
  await expect(p1.locator('.openings g[data-new]')).toHaveCount(1);
  for (const key of ['hacked', 'new-glass', 'new-half', 'new-opening']) {
    await expect(p1.locator(`.legend-key[data-key="${key}"]`)).toHaveCount(1);
  }
  // Hacked under the After walls, new over them: where a wall is put back, the new shows.
  const order = await p1.evaluate((svg) => {
    const at = (sel: string) =>
      [...svg.querySelectorAll('.plan > g')].findIndex((g) => g.matches(sel));
    return { hacked: at('.reno-hacked'), walls: at('.walls'), built: at('.reno-built') };
  });
  expect(order.hacked).toBeLessThan(order.walls);
  expect(order.walls).toBeLessThan(order.built);
  // New walls are measured.
  await expect(p1.locator('.built-length').first()).toHaveText(/^\d+$/);
});
