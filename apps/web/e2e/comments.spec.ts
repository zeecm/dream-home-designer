import { type Page, expect, test } from '@playwright/test';
import { centre, placeFridge, waitSaved } from './helpers';

/** Shots for looking at, when SHOTS is set to a folder. */
const shot = async (page: Page, name: string) => {
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png` });
};

/** Selects the fridge by its lower edge: its pin's bubble stands over its middle. */
async function selectBelowPin(page: Page) {
  const box = await page.locator('[data-hit^="item:"]').first().boundingBox();
  if (!box) throw new Error('no fridge');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - 3);
  await expect(page.getByRole('heading', { name: 'Fridge' })).toBeVisible();
}

test('a viewer comments on the fridge; the owner sees it, moves the fridge and replies', async ({
  page,
  browser,
}) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('1');
  await placeFridge(page);
  const projectId = new URL(page.url()).searchParams.get('p') ?? '';

  await page.getByRole('button', { name: 'Share' }).click();
  const viewLink = await page.getByLabel('View-only link').inputValue();
  await expect(page.getByRole('button', { name: 'Anyone with a link' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await shot(page, 'share-menu');
  await page.keyboard.press('Escape');

  // The view link: Select and Comment are its tools.
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const viewer = await ctx.newPage();
  viewer.on('pageerror', (e) => errors.push(e.message));
  await viewer.goto(viewLink);
  await expect(viewer.getByText('You can look around and leave comments')).toBeVisible();
  const tools = viewer.getByRole('navigation', { name: 'Tools' }).locator('.tool');
  await expect(tools).toHaveCount(2);
  await expect(viewer.getByRole('button', { name: /^Wall/ })).toHaveCount(0);
  await viewer.keyboard.press('1');
  // Drawing tools' keys do nothing on a view link.
  await viewer.locator('svg.plan-svg').focus();
  for (const key of ['w', 'd', 'e', 'r']) {
    await viewer.keyboard.press(key);
    await expect(viewer.getByRole('button', { name: 'Select V' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  }
  await expect(viewer.locator('.draw-bar, .elec-kind-list')).toHaveCount(0);

  // Comment on the fridge: its name, once, then the text.
  await viewer.getByRole('button', { name: 'Comment K', exact: true }).click();
  const at = await centre(viewer, '[data-hit^="item:"]');
  await viewer.mouse.move(at.x, at.y);
  await expect(viewer.locator('.comment-hover')).toHaveCount(1);
  await viewer.mouse.click(at.x, at.y);
  const compose = viewer.locator('[data-comment-compose]');
  await expect(compose.getByRole('heading', { name: 'New comment · Fridge' })).toBeVisible();
  await expect(compose.getByLabel('Your name')).toBeFocused();
  await compose.getByLabel('Your name').fill('Mum');
  await compose.getByLabel('Comment').fill('Blocks the service yard?');
  await shot(viewer, 'compose');
  await compose.getByRole('button', { name: 'Post' }).click();
  await expect(viewer.locator('.toast')).toContainText('Comment posted.');
  const pin = viewer.getByRole('button', { name: /^Comment by Mum on Fridge/ });
  await expect(pin).toBeVisible();
  const pinBox = await pin.boundingBox();
  // The tail's tip sits on the fridge.
  expect(Math.abs((pinBox?.x ?? 0) + 14 - at.x)).toBeLessThan(3);

  // The owner's tab: after a focus, the badge, the unread dot and the pin.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const button = page.getByRole('button', { name: 'Comments, 1 open, 1 new' });
  await expect(button).toBeVisible();
  const ownerPin = page.getByRole('button', { name: 'Comment by Mum on Fridge, unread' });
  await expect(ownerPin).toBeVisible();
  await shot(page, 'owner-badge');

  // Moving the fridge moves the pin.
  const before = await ownerPin.boundingBox();
  await selectBelowPin(page);
  for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowLeft');
  await expect
    .poll(async () => (await ownerPin.boundingBox())?.x ?? 0)
    .toBeLessThan((before?.x ?? 0) - 10);
  // Ctrl+Z undoes the move, never the comment.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+z');
  await expect(ownerPin).toBeVisible();

  // The owner opens it and replies: the reply carries the Owner badge.
  await ownerPin.click();
  const thread = page.locator('.comment-popover');
  await expect(thread.getByRole('heading', { name: 'Fridge' })).toBeFocused();
  await expect(thread.getByText('Blocks the service yard?')).toBeVisible();
  await thread.getByLabel('Your name').fill('Wei Ling');
  await thread.getByLabel('Reply').fill('Glass sliding door,\n$1.2k in the estimate');
  await thread.getByRole('button', { name: 'Reply' }).click();
  await expect(thread.locator('.comment-message')).toHaveCount(2);
  await expect(thread.locator('.comment-message').nth(1).getByText('Owner')).toBeVisible();
  await shot(page, 'thread');
  await page.keyboard.press('Escape');
  await expect(thread).toHaveCount(0);

  // Deleting the fridge leaves the pin where it was, dashed; undo puts it back.
  await selectBelowPin(page);
  await page.keyboard.press('Delete');
  await expect(page.locator('.comment-pin-gone')).toHaveCount(1);
  await page.locator('.comment-pin-gone').click();
  await expect(page.locator('.comment-popover')).toContainText(
    'The fridge was removed. The pin stays where it was.',
  );
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+z');
  await expect(page.locator('.comment-pin-gone')).toHaveCount(0);
  await waitSaved(page);

  // The viewer sees the reply, can't delete it, and resolves the thread.
  await viewer.evaluate(() => window.dispatchEvent(new Event('focus')));
  const vpin = viewer.getByRole('button', { name: /^Comment by Mum on Fridge, 1 reply/ });
  await expect(vpin).toBeVisible();
  await vpin.click();
  const vthread = viewer.locator('.comment-popover');
  await expect(vthread.locator('.comment-message')).toHaveCount(2);
  await expect(
    vthread.locator('.comment-message').nth(1).getByRole('button', { name: 'Delete' }),
  ).toHaveCount(0);
  await expect(vthread.locator('.comment-message').first().getByText('(you)')).toBeVisible();
  await vthread.getByRole('button', { name: 'Resolve' }).click();
  await expect(vthread).toHaveCount(0);
  await expect(viewer.locator('.toast')).toContainText('Resolved.');
  await expect(vpin).toHaveCount(0);

  // In the panel it sits under Resolved, by Mum; "Show resolved" brings the pin back grey.
  await viewer.getByRole('button', { name: /^Comments, 0 open/ }).click();
  const panel = viewer.getByRole('complementary', { name: 'Comments' });
  await panel.getByRole('button', { name: 'Resolved 1' }).click();
  await panel.getByRole('button', { name: /^Fridge/ }).click();
  await expect(viewer.locator('.comment-popover')).toContainText('Resolved by Mum');
  await viewer.locator('.comment-popover').getByRole('button', { name: 'Close' }).click();
  await panel.getByLabel('Show resolved on the plan').check();
  await expect(viewer.locator('.comment-pin-resolved')).toHaveCount(1);
  await shot(viewer, 'panel-resolved');
  await viewer.locator('.comment-pin-resolved').click();
  await viewer.locator('.comment-popover').getByRole('button', { name: 'Reopen' }).click();
  await expect(panel.getByRole('button', { name: 'Open 1' })).toBeVisible();

  // A link to the thread opens it.
  await viewer.goto(`${viewLink}&c=nonexistent`);
  await expect(viewer.getByText('That comment was deleted.')).toBeVisible();
  const threadId = await page.evaluate(async (id) => {
    const r = await fetch(`/api/projects/${id}/comments`);
    return ((await r.json()) as { threads: { id: string }[] }).threads[0]?.id ?? '';
  }, projectId);
  await viewer.goto(`${viewLink}&c=${threadId}`);
  await expect(
    viewer.locator('.comment-popover').getByRole('heading', { name: 'Fridge' }),
  ).toBeVisible();
  await expect(viewer).not.toHaveURL(/c=/);

  expect(errors).toEqual([]);
  await ctx.close();
});

test('the owner closes comments; a viewer can still read them', async ({ page, browser }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('1');

  // The owner comments on a room, then closes comments.
  await page.getByRole('button', { name: 'Comment K', exact: true }).click();
  const at = await centre(page, '[data-hit="room:rm_kitchen"]');
  await page.mouse.click(at.x, at.y);
  const compose = page.locator('[data-comment-compose]');
  await compose.getByLabel('Your name').fill('Wei Ling');
  await compose.getByLabel('Comment').fill('Open kitchen?');
  await compose.getByLabel('Comment').press('Control+Enter');
  await expect(page.getByRole('button', { name: /^Comment by Wei Ling on Kitchen/ })).toBeVisible();
  // Ctrl+Z after posting leaves the comment.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+z');
  await expect(page.getByRole('button', { name: /^Comment by Wei Ling on Kitchen/ })).toBeVisible();

  await page.getByRole('button', { name: 'Share' }).click();
  const viewLink = await page.getByLabel('View-only link').inputValue();
  await page.getByRole('button', { name: 'No one' }).click();
  await expect(page.getByRole('button', { name: 'No one' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.keyboard.press('Escape');

  const ctx = await browser.newContext();
  const viewer = await ctx.newPage();
  await viewer.goto(viewLink);
  await expect(viewer.getByText('View only.')).toBeVisible();
  await expect(viewer.getByRole('button', { name: /^Comment by Wei Ling/ })).toBeVisible();
  await expect(viewer.getByRole('button', { name: /^Comment$|^Comment K/ })).toHaveCount(0);
  await viewer.getByRole('button', { name: /^Comments, 1 open/ }).click();
  await expect(viewer.getByRole('complementary', { name: 'Comments' })).toContainText(
    'The owner has closed comments on this plan.',
  );
  await ctx.close();

  // The pin is on screen in the comment colour, but not in the plan as a picture.
  await page.emulateMedia({ colorScheme: 'light' });
  const onScreen = await page.getByTestId('plan').screenshot();
  expect(await commentPixels(page, onScreen)).toBeGreaterThan(30);
  await page.getByRole('button', { name: 'Projects' }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    page.getByRole('button', { name: 'Plan as a picture (PNG)', exact: true }).click(),
  ]);
  const png = Buffer.concat(await (await download.createReadStream()).toArray());
  expect(png.length).toBeGreaterThan(20_000);
  expect(await commentPixels(page, png)).toBe(0);
});

/** How many pixels of a PNG are the pins' colour (light theme, #b54708). */
async function commentPixels(page: Page, png: Buffer): Promise<number> {
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d');
    if (!g) return -1;
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const near = (v: number | undefined, to: number) => Math.abs((v ?? 0) - to) < 24;
      if (near(d[i], 181) && near(d[i + 1], 71) && near(d[i + 2], 8)) n++;
    }
    return n;
  }, png.toString('base64'));
}

test('from 3D, a comment in the panel opens the plan at its pin', async ({ page }) => {
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('1');
  await page.getByRole('button', { name: 'Comment K', exact: true }).click();
  const at = await centre(page, '[data-hit="room:rm_kitchen"]');
  await page.mouse.click(at.x, at.y);
  const compose = page.locator('[data-comment-compose]');
  await compose.getByLabel('Your name').fill('Jun Hao');
  await compose.getByLabel('Comment').fill('Island here?');
  await compose.getByRole('button', { name: 'Post' }).click();
  await expect(page.locator('.toast')).toContainText('Comment posted.');

  await page.keyboard.press('3');
  await page.getByRole('button', { name: /^Comments, 1 open/ }).click();
  await page
    .getByRole('complementary', { name: 'Comments' })
    .getByRole('button', { name: /^Kitchen/ })
    .click();
  await expect(page.getByTestId('plan')).toBeVisible();
  const thread = page.locator('.comment-popover');
  await expect(thread.getByRole('heading', { name: 'Kitchen' })).toBeVisible();
  await shot(page, 'jump');
  // Its pin is in the middle of the plan.
  const plan = await page.getByTestId('plan').boundingBox();
  const pin = await page.locator('.comment-pin-active').boundingBox();
  if (!plan || !pin) throw new Error('no plan or pin');
  expect(Math.abs(pin.x + 14 - (plan.x + plan.width / 2))).toBeLessThan(4);
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'jump-dark');
});

test('a post refused because comments closed meanwhile keeps its words, to copy', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('1');
  await page.getByRole('button', { name: 'Share' }).click();
  const viewLink = await page.getByLabel('View-only link').inputValue();

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const viewer = await ctx.newPage();
  await viewer.goto(viewLink);
  await viewer.keyboard.press('1');
  await viewer.getByRole('button', { name: 'Comment K', exact: true }).click();
  const at = await centre(viewer, '[data-hit="room:rm_kitchen"]');
  await viewer.mouse.click(at.x, at.y);
  const compose = viewer.locator('[data-comment-compose]');
  await compose.getByLabel('Your name').fill('Mum');
  await compose.getByLabel('Comment').fill('Wok smell goes everywhere.');

  // Meanwhile the owner allows comments by the edit link only.
  await page.getByRole('button', { name: 'Edit link only' }).click();
  await expect(page.getByRole('button', { name: 'Edit link only' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await compose.getByRole('button', { name: 'Post' }).click();
  await expect(compose.getByRole('alert')).toHaveText(
    'Only people with the edit link can comment on this plan.',
  );
  // The words stay, locked, with a way to copy them; the composer doesn't close.
  await expect(compose.getByLabel('Comment')).toHaveValue('Wok smell goes everywhere.');
  await expect(compose.getByRole('button', { name: 'Post' })).toBeDisabled();
  await expect(compose.getByRole('button', { name: 'Copy text' })).toBeVisible();
  await expect(viewer.getByRole('button', { name: 'Comment K', exact: true })).toHaveCount(0);
  await shot(viewer, 'refused');
  await ctx.close();
});

test('comments on the flat as it is are pointed out from the renovation', async ({ page }) => {
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('1');
  await page.getByRole('button', { name: 'Comment K', exact: true }).click();
  const at = await centre(page, '[data-hit="room:rm_kitchen"]');
  await page.mouse.click(at.x, at.y);
  const compose = page.locator('[data-comment-compose]');
  await compose.getByLabel('Your name').fill('Wei Ling');
  await compose.getByLabel('Comment').fill('Keep the kitchen wall?');
  await compose.getByRole('button', { name: 'Post' }).click();
  const pin = page.getByRole('button', { name: /^Comment by Wei Ling on Kitchen/ });
  await expect(pin).toBeVisible();

  // Starting a renovation shows After, where the comment isn't drawn: a notice says where.
  await page.getByRole('button', { name: /^Select/ }).click();
  await page.getByRole('button', { name: 'Plan a renovation' }).click();
  await expect(page.locator('.reno-bar').getByRole('button', { name: 'After' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(pin).toHaveCount(0);
  const notice = page.locator('.comment-elsewhere');
  await expect(notice).toHaveText('1 comment is on the flat as it is. Show');
  await shot(page, 'elsewhere');
  await notice.getByRole('button', { name: 'Show' }).click();
  await expect(pin).toBeVisible();
  await expect(notice).toHaveCount(0);
});
