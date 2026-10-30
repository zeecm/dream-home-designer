import { type Page, expect, test } from '@playwright/test';
import { waitSaved } from './helpers';

/**
 * Sign-in is Google's, so these tests stand in for the account server: /api/auth/me says
 * who is signed in, and /api/me/projects keeps what the app sends it.
 */
async function signedInAs(page: Page, kept: Map<string, Record<string, unknown>>) {
  await page.route('**/api/auth/me', (r) =>
    r.fulfill({
      json: { enabled: true, user: { email: 'mah@example.com', name: 'Mah', picture: '' } },
    }),
  );
  await page.route('**/api/me/projects**', async (r) => {
    const req = r.request();
    const id = new URL(req.url()).pathname.split('/').pop() ?? '';
    if (req.method() === 'PUT') {
      kept.set(id, { id, ...JSON.parse(req.postData() ?? '{}'), updatedAt: Date.now() });
      return r.fulfill({ json: { ok: true } });
    }
    if (req.method() === 'DELETE') {
      kept.delete(id);
      return r.fulfill({ json: { ok: true } });
    }
    return r.fulfill({ json: { projects: [...kept.values()] } });
  });
}

test('signed in, a plan made on one device opens on another, as its owner', async ({ browser }) => {
  const kept = new Map<string, Record<string, unknown>>();

  // Device one: signs in, starts a plan, renames it.
  const one = await (await browser.newContext()).newPage();
  await signedInAs(one, kept);
  await one.goto('/');
  await waitSaved(one);
  await expect(one.getByRole('button', { name: 'Signed in as mah@example.com' })).toBeVisible();
  await one.getByRole('button', { name: 'Projects' }).click();
  await one.getByRole('button', { name: 'New blank plan' }).click();
  await waitSaved(one);
  const id = new URL(one.url()).searchParams.get('p') ?? '';
  await expect.poll(() => kept.get(id)?.ownerKey).toBeTruthy();

  // Device two: a fresh browser, signed in to the same account.
  const two = await (await browser.newContext()).newPage();
  await signedInAs(two, kept);
  await two.goto('/');
  await waitSaved(two);
  await two.getByRole('button', { name: 'Projects' }).click();
  await two.getByRole('button', { name: 'Manage your plans…' }).click();
  const dialog = two.getByRole('dialog', { name: 'Your plans' });
  const row = dialog.getByRole('listitem').filter({ hasText: 'Untitled plan' });
  await expect(row).toHaveCount(1);
  // Its owner key came along: it can be deleted here, not just taken off the list.
  await expect(row.getByRole('button', { name: 'Delete Untitled plan' })).toBeVisible();
  await row.getByRole('button', { name: /^Untitled plan/ }).click();
  await expect.poll(() => new URL(two.url()).searchParams.get('p')).toBe(id);
  await waitSaved(two);
  await two
    .getByRole('button', { name: /^Share/ })
    .first()
    .click();
  await expect(two.getByText('Also allow editing with a separate link')).toBeVisible();

  // Signing out takes the menu away.
  await two.keyboard.press('Escape');
  await two.getByRole('button', { name: 'Signed in as mah@example.com' }).click();
  await two.route('**/api/auth/logout', (r) => r.fulfill({ json: { ok: true } }));
  await two.getByRole('button', { name: 'Sign out' }).click();
  await expect(two.getByRole('link', { name: /Sign in/ })).toBeVisible();
});

test('without sign-in set up on the server, there is no sign-in button', async ({ page }) => {
  await page.goto('/');
  await waitSaved(page);
  await expect(page.getByRole('link', { name: /Sign in/ })).toHaveCount(0);
});
