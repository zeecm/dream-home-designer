import { expect, test } from '@playwright/test';
import { waitSaved } from './helpers';

async function downloadFrom(page: import('@playwright/test').Page, item: string) {
  await page.getByRole('button', { name: 'Projects' }).click();
  const [file] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    page.getByRole('button', { name: item, exact: true }).click(),
  ]);
  return file;
}

test('downloads: plan picture, 3D picture and model, and a project file that opens again', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('1');

  const plan = await downloadFrom(page, 'Plan as a picture (PNG)');
  expect(plan.suggestedFilename()).toBe('3-room-hdb-sample-plan.png');
  const planBytes = (await (await plan.createReadStream()).toArray()).reduce(
    (n, c: Buffer) => n + c.length,
    0,
  );
  expect(planBytes).toBeGreaterThan(20_000);
  // The plan view is back as it was.
  await expect(page.locator('svg.plan-svg')).toBeVisible();

  const shot = await downloadFrom(page, '3D view as a picture (PNG)');
  expect(shot.suggestedFilename()).toBe('3-room-hdb-sample-3d.png');
  const model = await downloadFrom(page, '3D model (GLB)');
  expect(model.suggestedFilename()).toBe('3-room-hdb-sample.glb');
  const head = (await (await model.createReadStream()).toArray())[0] as Buffer;
  expect(head.subarray(0, 4).toString()).toBe('glTF');

  // The project file opens as a new plan with the same walls.
  const walls = await page.locator('.facts dd').first().textContent();
  const file = await downloadFrom(page, 'Project file');
  const path = await file.path();
  const before = new URL(page.url()).searchParams.get('p');
  await page.getByRole('button', { name: 'Projects' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open a project file…' }).click();
  await (await chooser).setFiles(path);
  await expect.poll(() => new URL(page.url()).searchParams.get('p')).not.toBe(before);
  await waitSaved(page);
  await expect(page.locator('.facts dd').first()).toHaveText(walls ?? '');
  expect(errors).toEqual([]);
});
