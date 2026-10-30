import { expect, test } from '@playwright/test';
import { waitSaved } from './helpers';

test('a view link only looks; an edit link saves to the owner’s plan until it is reset', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000); // three browsers: owner, viewer and editor
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('1');

  // The owner shares: a view-only link, then turns on an edit link.
  await page.getByRole('button', { name: 'Share' }).click();
  const viewLink = await page.getByLabel('View-only link').inputValue();
  const allowEdit = page.getByLabel('Also allow editing with a separate link');
  await expect(allowEdit).toBeEnabled();
  await allowEdit.click();
  await expect(page.getByLabel('Edit link')).toBeVisible();
  const editLink = await page.getByLabel('Edit link').inputValue();
  expect(editLink).toContain('#k='); // the key stays out of server logs
  await page.keyboard.press('Escape');

  // The view link: the plan shows, but nothing can change it.
  const viewer = await (await browser.newContext()).newPage();
  await viewer.goto(viewLink);
  await expect(viewer.getByText('View only.')).toBeVisible();
  await expect(viewer.getByRole('button', { name: /^Wall/ })).toBeDisabled();
  await expect(viewer.getByRole('button', { name: 'Make my own copy' })).toBeVisible();

  // The edit link: rename a room; it saves to the owner's plan.
  const editorCtx = await browser.newContext();
  const editor = await editorCtx.newPage();
  await editor.goto(editLink);
  await waitSaved(editor);
  await expect(editor.getByText('View only.')).toHaveCount(0);
  await expect(editor).not.toHaveURL(/k=/); // the key leaves the address bar
  await editor.keyboard.press('1');
  await expect(editor.getByTestId('viewport-wrap')).toHaveCount(0); // plan view has settled
  const name = editor.getByLabel('Name', { exact: true });
  await expect(async () => {
    await editor.locator('[data-hit="room:rm_kitchen"]').click({ force: true });
    await expect(name).toBeVisible({ timeout: 1000 });
  }).toPass();
  await name.fill('Wet kitchen');
  await name.press('Enter');
  await waitSaved(editor);

  await page.reload();
  await waitSaved(page);
  await expect(page.locator('.room-list-name').filter({ hasText: 'Wet kitchen' })).toHaveCount(1);

  // The owner resets the link: the old one can no longer save.
  await page.getByRole('button', { name: 'Share' }).click();
  await page.getByRole('button', { name: 'Reset edit link' }).click();
  await expect(page.getByLabel('Edit link')).not.toHaveValue(editLink);
  await editor.reload();
  await expect(editor.getByText('View only.')).toBeVisible();
  await editorCtx.close();
});
