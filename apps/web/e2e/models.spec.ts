import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { waitSaved } from './helpers';

// Any binary glTF does; one of the app's own pieces is at hand.
const dir = fileURLToPath(new URL('../public/models', import.meta.url));
const file = readdirSync(dir).find((f) => f.startsWith('nightstand-painted.'));
if (!file) throw new Error('no model to upload');
const buffer = readFileSync(join(dir, file));
const hash = createHash('sha256').update(buffer).digest('hex');

test('upload your own model: place it, it reaches the server, another browser sees it', async ({
  page,
  browser,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('1');
  await page.getByRole('button', { name: /^Furniture/ }).click();

  // Not a model: said so, nothing added.
  await page
    .getByLabel('Model file')
    .first()
    .setInputFiles({
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('hello'),
    });
  await expect(page.getByText('That isn’t a .glb model file.')).toBeVisible();

  await page.getByLabel('Model file').first().setInputFiles({
    name: 'grandmas-armchair.glb',
    mimeType: 'model/gltf-binary',
    buffer,
  });
  // It joins the catalogue, armed, and places like any piece.
  const mine = page.getByRole('button', { name: /^Grandmas armchair/ });
  await expect(mine).toHaveAttribute('aria-pressed', 'true');
  const room = await page.locator('[data-hit="room:rm_living-and-dining"]').boundingBox();
  if (!room) throw new Error('no room');
  await page.mouse.click(room.x + room.width * 0.5, room.y + room.height * 0.5);
  const items = page.locator('[data-hit^="item:"]');
  await expect(items).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Grandmas armchair' })).toBeVisible();
  await waitSaved(page);

  // The server holds it, under its hash.
  const id = new URL(page.url()).searchParams.get('p');
  expect(id).toBeTruthy();
  await expect
    .poll(async () => (await page.request.get(`/api/projects/${id}/models/${hash}`)).status())
    .toBe(200);

  // In 3D it draws without errors.
  await page.keyboard.press('3');
  await expect(page.getByRole('button', { name: 'Walk through' })).toBeVisible();
  await page.waitForTimeout(1000);
  expect(errors).toEqual([]);

  // A browser that never had it fetches it from the server.
  const other = await browser.newPage();
  const fetched = other.waitForResponse((r) => r.url().endsWith(`/models/${hash}`));
  await other.goto(`/?p=${id}`);
  await other.getByRole('button', { name: /^3D$/ }).click();
  expect((await fetched).status()).toBe(200);
  await other.close();

  // Renamed, then taken out with its piece, in one undo step.
  await page.keyboard.press('1');
  await items.first().click({ force: true });
  const name = page.getByLabel('Model name');
  await name.fill('Gran’s chair');
  await name.press('Enter');
  await expect(page.getByRole('heading', { name: 'Gran’s chair' })).toBeVisible();
  await page.getByRole('button', { name: 'Remove model' }).click();
  await expect(items).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Gran’s chair/ })).toHaveCount(0);
  await page.keyboard.press('Control+z');
  await expect(items).toHaveCount(1);
});
