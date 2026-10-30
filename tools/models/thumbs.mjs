// Renders a thumbnail of every catalogue piece (boxes and models alike, through the app's
// own 3D code) to apps/web/public/models/thumbs/<id>.webp. Needs Playwright's Chromium.
//
//   pnpm --filter @dhd/models thumbs
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, '..', '..', 'apps', 'web');
const outDir = join(web, 'public', 'models', 'thumbs');
const require = createRequire(join(web, 'package.json'));
const { createServer } = require('vite');
const { chromium } = require('playwright');

const server = await createServer({ root: web, server: { port: 5199, strictPort: true } });
await server.listen();
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error(e.message));
  await page.goto('http://localhost:5199/thumbs.html');
  await page.waitForFunction(() => window.thumbs, null, { timeout: 180_000 });
  const thumbs = await page.evaluate(() => window.thumbs);
  await mkdir(outDir, { recursive: true });
  for (const f of await readdir(outDir)) await rm(join(outDir, f));
  for (const [id, url] of Object.entries(thumbs)) {
    const png = Buffer.from(url.split(',')[1], 'base64');
    await writeFile(
      join(outDir, `${id}.webp`),
      await sharp(png)
        .trim({ threshold: 0 })
        .resize(96, 96, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .webp({ quality: 80 })
        .toBuffer(),
    );
  }
  console.log(`${Object.keys(thumbs).length} thumbnails → ${outDir}`);
} finally {
  await browser.close();
  await server.close();
}
