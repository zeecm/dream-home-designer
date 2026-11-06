import { type Page, expect, test } from '@playwright/test';
import { waitSaved } from './helpers';

/** Shots for looking at, when SHOTS is set to a folder. */
const shot = async (page: Page, name: string) => {
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png` });
};

/** Places a fridge in the sample's kitchen, in Plan view, and returns its plan element. */
async function placeFridge(page: Page) {
  await page.getByRole('button', { name: /^Furniture/ }).click();
  await page.getByRole('navigation', { name: 'Tools' }).getByLabel('Find furniture').fill('fridge');
  await page
    .getByRole('navigation', { name: 'Tools' })
    .getByRole('button', { name: /^Fridge/ })
    .first()
    .click();
  const room = page.locator('[data-hit="room:rm_kitchen"]');
  const box = await room.boundingBox();
  if (!box) throw new Error('no kitchen');
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
  const fridge = page.locator('[data-hit^="item:"]').first();
  await expect(fridge).toHaveCount(1);
  await page.getByRole('button', { name: /^Select/ }).click();
  await page.keyboard.press('Escape');
  await waitSaved(page);
  return fridge;
}

/** Selects the fridge by its lower edge: its pin's bubble stands over its middle. */
async function selectBelowPin(page: Page) {
  const box = await page.locator('[data-hit^="item:"]').first().boundingBox();
  if (!box) throw new Error('no fridge');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - 3);
  await expect(page.getByRole('heading', { name: 'Fridge' })).toBeVisible();
}

async function centre(page: Page, selector: string) {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`nothing at ${selector}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
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

  // The plan PNG has no pins (they're not in the SVG at all).
  expect(await page.locator('.plan-svg .comment-pin').count()).toBe(0);
});

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
