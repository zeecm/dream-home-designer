import {
  type EditorDoc,
  type Level,
  type Project,
  addItem,
  addOpening,
  blankProject,
  customPaint,
  dispatch,
  drawWall,
  emptyHistory,
  furnitureKind,
  newItem,
  placeOpening,
  planGeometry,
  roomIdAt,
  roomsBeside,
  updateRoom,
  updateWall,
} from '@dhd/core';
import { waitSaved } from './helpers';
import { type Page, type Request, devices, expect, test } from './test';

/**
 * The exact render: the app path traces the 3D model on the device, so what it draws is the
 * plan, exactly. A test override keeps each picture small (inside 160 × 120) and short (16
 * samples), so it runs in CI's software GL. The first sample there takes about half a minute
 * (the tracer's shader is compiled on its first draw), so the tests keep their renders few.
 */

// A time cap far past the default 90 s: a slow CI runner can take half a minute to compile.
const OVERRIDE = { width: 160, height: 120, samples: 16, cap: 600_000 };

async function quick(
  page: Page,
  samples = OVERRIDE.samples,
  box = { width: OVERRIDE.width, height: OVERRIDE.height },
) {
  await page.addInitScript(
    (o) => {
      window.__DHD_EXACT_TEST__ = o;
    },
    { ...OVERRIDE, ...box, samples },
  );
}

/** Every request the page makes from now on. */
function requests(page: Page): Request[] {
  const seen: Request[] = [];
  page.on('request', (r) => seen.push(r));
  return seen;
}

const AI_HOSTS = /api\.openai\.com|generativelanguage\.googleapis\.com|api\.anthropic\.com/;

/** Requests to an AI provider or to the app's server. */
const outside = (list: Request[]) =>
  list.map((r) => r.url()).filter((u) => AI_HOSTS.test(u) || /\/api\//.test(u));

/**
 * Waits for a new plan's own saving to settle (its plan image goes up to the server), so a
 * network log taken after it holds only what the render does. Call before `page.goto`.
 */
function planImageUp(page: Page): () => Promise<void> {
  let up = false;
  page.on('requestfinished', (r) => {
    if (r.method() === 'PUT' && /\/api\/projects\/[^/]+\/image$/.test(r.url())) up = true;
  });
  return () => expect.poll(() => up, { timeout: 60_000 }).toBe(true);
}

/** The sample number in "Sample n of N · 0:12" (or the samples when stopped or done). */
async function sampleCount(page: Page): Promise<number> {
  const text = (await page.getByTestId('exact-progress').textContent()) ?? '';
  const m = text.match(
    /^Sample (\d+) of|^Stopped · (\d+) of|^Done · (\d+) samples|: (\d+) samples/,
  );
  return Number(m?.[1] ?? m?.[2] ?? m?.[3] ?? m?.[4] ?? -1);
}

/** Width and height from a PNG's header. */
function pngSize(png: Buffer): { width: number; height: number } {
  expect(png.subarray(1, 4).toString()).toBe('PNG');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

interface Cam {
  position: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
  fov: number;
  aspect: number;
}

async function renderCamera(page: Page): Promise<Cam> {
  const raw = await page.locator('.exact-picture').getAttribute('data-camera');
  return JSON.parse(raw ?? 'null') as Cam;
}

test('opens on Exact and renders by itself, on this device: stop, carry on, switch, download, close', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await quick(page);
  // A picture key saved: still nothing goes to a provider, nor to the server.
  await page.addInitScript(() => {
    window.sessionStorage.setItem(
      'dhd-ai',
      JSON.stringify({
        active: 'gemini',
        keys: {
          gemini: {
            key: 'AIza-not-a-real-key',
            model: 'gemini-3.1-pro-preview',
            imageModel: 'gemini-3-pro-image',
          },
        },
      }),
    );
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const settled = planImageUp(page);
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('3');
  await settled();
  errors.length = 0; // from here on
  const sent = requests(page);

  await page.getByRole('button', { name: 'Photo-real render' }).click();
  const dialog = page.getByRole('dialog', { name: 'Photo-real render' });
  await expect(dialog.getByRole('button', { name: 'Exact', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // From the orbit view: eye height in the room it is centred on, chosen as it opens.
  const eye = dialog.getByRole('button', { name: 'From eye height in Living and dining' });
  await expect(eye).toHaveAttribute('aria-pressed', 'true');
  // Until its first good picture the frame is covered, with nothing to download.
  await expect(dialog.locator('.exact-wait')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Download' })).toBeDisabled();
  await expect(dialog.locator('.exact-picture')).toHaveAttribute('data-ceilings', 'true');
  await expect(dialog.getByText('Drawn by the app from your 3D model')).toBeVisible();

  // It starts by itself, and the samples rise.
  const progress = dialog.getByTestId('exact-progress');
  await expect(progress).toHaveText(/^Sample \d+ of 16 · \d:\d\d$/, { timeout: 60_000 });
  const reads: number[] = [];
  for (let i = 0; i < 3; i++) {
    const before = reads.at(-1) ?? 0;
    await expect.poll(() => sampleCount(page), { timeout: 90_000 }).toBeGreaterThan(before);
    reads.push(await sampleCount(page));
  }
  expect(reads[2]).toBeGreaterThan(reads[0] as number);

  // Stop: the count holds still; the picture stays.
  await dialog.getByRole('button', { name: 'Stop' }).click();
  await page.waitForTimeout(500);
  const held = await sampleCount(page);
  await expect(progress).toHaveText(new RegExp(`^Stopped · ${held} of 16 samples`));
  await page.waitForTimeout(2_000);
  expect(await sampleCount(page)).toBe(held);
  await expect(dialog.getByRole('button', { name: 'Download' })).toBeEnabled();

  // To AI impression and back: the picture and its count are kept, the dialog's frame and
  // its switch stay where they were, and focus stays on the switch.
  const frame = await dialog.boundingBox();
  const switchAt = await dialog.getByRole('button', { name: 'AI impression' }).boundingBox();
  await dialog.getByRole('button', { name: 'AI impression' }).click();
  await expect(dialog.getByText('With Gemini (Google) (gemini-3-pro-image)')).toBeVisible();
  await expect(dialog.locator('canvas.exact-canvas')).toBeHidden();
  await expect(dialog.getByRole('button', { name: 'AI impression' })).toBeFocused();
  expect(await dialog.boundingBox()).toEqual(frame);
  expect(await dialog.getByRole('button', { name: 'AI impression' }).boundingBox()).toEqual(
    switchAt,
  );
  await dialog.getByRole('button', { name: 'Exact', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Exact', exact: true })).toBeFocused();
  await expect(dialog.locator('canvas.exact-canvas')).toBeVisible();
  expect(await sampleCount(page)).toBe(held);

  // Carry on: from the same samples, to the target.
  await dialog.getByRole('button', { name: 'Carry on' }).click();
  await expect.poll(() => sampleCount(page), { timeout: 60_000 }).toBeGreaterThan(held);
  await expect(progress).toHaveText(/^Done · 16 samples · \d:\d\d$/, { timeout: 120_000 });
  // Done: more samples on offer, for a cleaner picture.
  await expect(dialog.getByRole('button', { name: 'More samples' })).toBeEnabled();

  // The whole render, with a picture key saved: nothing to a provider, nothing to the server.
  expect(outside(sent)).toEqual([]);

  // Download: the rendered pixels, at the view's shape.
  const camera = await renderCamera(page);
  const save = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download' }).click();
  const file = await save;
  expect(file.suggestedFilename()).toMatch(/-exact-render\.png$/);
  const path = await file.path();
  const { readFileSync } = await import('node:fs');
  const size = pngSize(readFileSync(path));
  expect(Math.max(size.width / 160, size.height / 120)).toBeCloseTo(1, 2);
  expect(Math.abs(size.width / size.height / camera.aspect - 1)).toBeLessThan(0.01);

  // From this view: a new render, of the cut-away view (no ceilings).
  await dialog.getByRole('button', { name: /^From this view/ }).click();
  await expect(dialog.locator('.exact-picture')).toHaveAttribute('data-ceilings', 'false');
  await expect(progress).toHaveText(/^Sample [1-4] of 16/, { timeout: 60_000 });
  // Back to eye height: its finished picture is still there, to download; and this view's,
  // left part way, is kept too.
  await eye.click();
  await expect(progress).toHaveText(/^Done · 16 samples/);
  await expect(dialog.getByRole('button', { name: 'Download' })).toBeEnabled();
  await dialog.getByRole('button', { name: /^From this view/ }).click();
  await expect(progress).toHaveText(/^Stopped · \d+ of 16 samples/);
  await dialog.getByRole('button', { name: 'Render again' }).click();
  await expect(progress).toHaveText(/^Sample [1-4] of 16/, { timeout: 60_000 });

  // Nor for the second (a download counts itself, as every download does).
  expect(outside(sent).filter((u) => !u.endsWith('/api/telemetry'))).toEqual([]);

  // Closed mid-render (once drawing: software GL stalls the page while it compiles the
  // tracer for a new picture): its canvas goes, the 3D view moves again.
  await expect.poll(() => sampleCount(page), { timeout: 90_000 }).toBeGreaterThan(1);
  await expect(dialog.getByRole('button', { name: 'Stop' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('canvas.exact-canvas')).toHaveCount(0);
  const view = page.getByTestId('viewport').locator('canvas');
  const shot = await view.screenshot();
  const box = await view.boundingBox();
  if (!box) throw new Error('no 3D view');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 160, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await view.screenshot()).equals(shot)).toBe(false);
  // Opened again: a fresh render, from its first samples, drawing.
  await page.getByRole('button', { name: 'Photo-real render' }).click();
  await expect(page.getByTestId('exact-progress')).toHaveText(/^Sample [1-4] of 16/, {
    timeout: 90_000,
  });
  const fresh = await sampleCount(page);
  await expect.poll(() => sampleCount(page), { timeout: 90_000 }).toBeGreaterThan(fresh);
  // The graphics card resets: the picture so far stays, to see and to download, and Try again
  // offers a fresh render.
  await page.evaluate(() =>
    document
      .querySelector<HTMLCanvasElement>('canvas.exact-canvas')
      ?.getContext('webgl2')
      ?.getExtension('WEBGL_lose_context')
      ?.loseContext(),
  );
  const again = page.getByRole('dialog', { name: 'Photo-real render' });
  await expect(again.getByTestId('exact-progress')).toHaveText(/^The graphics card reset/);
  await expect(again.locator('canvas.exact-canvas')).toBeVisible();
  const kept = page.waitForEvent('download');
  await again.getByRole('button', { name: 'Download' }).click();
  const png = readFileSync(await (await kept).path());
  // A picture, not an empty canvas (a blank 160 × 100 PNG is a few hundred bytes)...
  expect(png.length).toBeGreaterThan(4_000);
  // ...and a whole metered one, not a part-drawn first sample: mostly not black.
  const black = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const img = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const c = new OffscreenCanvas(img.width, img.height);
    const g = c.getContext('2d');
    if (!g) return 1;
    g.drawImage(img, 0, 0);
    const px = g.getImageData(0, 0, img.width, img.height).data;
    let n = 0;
    for (let i = 0; i < px.length; i += 4) {
      if ((px[i] ?? 0) + (px[i + 1] ?? 0) + (px[i + 2] ?? 0) < 24) n++;
    }
    return n / (px.length / 4);
  }, png.toString('base64'));
  expect(black).toBeLessThan(0.25);
  await again.getByRole('button', { name: 'Try again' }).click();
  await expect(again.getByTestId('exact-progress')).toHaveText(/^Preparing the scene…|^Sample/);
  await page
    .getByRole('dialog', { name: 'Photo-real render' })
    .getByRole('button', { name: 'Close' })
    .click();
  // Gone from the page, and nothing went wrong on the way (closing included).
  await expect(page.locator('dialog.render-dialog')).toHaveCount(0);
  await expect(page.locator('canvas.exact-canvas')).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(errors).toEqual([]);
});

// ---------------------------------------------------------------- exactness, by its pixels

/** Opens a project file, as Projects ▸ Open a project file does. */
async function openFile(page: Page, project: Project) {
  await page.locator('input[type="file"][accept=".json,application/json"]').setInputFiles({
    name: 'exact.dreamhome.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await waitSaved(page);
  await expect(page.getByText(project.name).first()).toBeVisible();
}

/** Walks in at `at` facing `yaw` (the walk takes up the stored spot), at `hour` o'clock. */
async function walkIn(page: Page, at: { x: number; y: number }, yaw: number, hour: number) {
  await page.evaluate(
    ([p, fov]) => {
      localStorage.setItem(`dhd:walk:${localStorage.getItem('dhd:last')}`, JSON.stringify(p));
      localStorage.setItem('dhd-walk-fov-2', String(fov));
    },
    [{ at, yaw, pitch: 0 }, 100] as const,
  );
  await page.keyboard.press('3');
  await page.locator('.sun-control input[type="range"]').first().fill(String(hour));
  await page.getByRole('button', { name: 'Walk through' }).click();
  await expect(page.getByRole('button', { name: 'Leave walk' })).toBeVisible();
}

/** Renders from the walk to the end and returns the picture's pixels (RGBA) and size. */
async function renderPixels(page: Page, samples: number) {
  await page.getByRole('button', { name: 'Photo-real render' }).click();
  const dialog = page.getByRole('dialog', { name: 'Photo-real render' });
  await expect(dialog.getByTestId('exact-progress')).toHaveText(
    new RegExp(`^Done · ${samples} samples`),
    { timeout: 180_000 },
  );
  const camera = await renderCamera(page);
  const save = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download' }).click();
  const { readFileSync, writeFileSync } = await import('node:fs');
  const png = readFileSync(await (await save).path());
  // Kept with the results, to look at when a check fails.
  writeFileSync(test.info().outputPath('exact-render.png'), png);
  const { width, height } = pngSize(png);
  const rgba: number[] = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const img = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const c = new OffscreenCanvas(img.width, img.height);
    const g = c.getContext('2d');
    if (!g) throw new Error('no 2d');
    g.drawImage(img, 0, 0);
    return Array.from(g.getImageData(0, 0, img.width, img.height).data);
  }, png.toString('base64'));
  return { rgba, width, height, camera };
}

test('a sealed room with no window or lamp is dark at noon: no light through its ceiling', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await quick(page, 4, { width: 64, height: 48 });
  await page.goto('/');
  await waitSaved(page);
  let s: EditorDoc = { doc: blankProject('Sealed room'), history: emptyHistory() };
  const level = () => s.doc.levels[0] as Level;
  const corners: [number, number][] = [
    [0, 0],
    [3, 0],
    [3, 3],
    [0, 3],
    [0, 0],
  ];
  for (let i = 0; i + 1 < corners.length; i++) {
    const [ax, ay] = corners[i] as [number, number];
    const [bx, by] = corners[i + 1] as [number, number];
    s = dispatch(
      s,
      drawWall(
        level(),
        { point: { x: ax, y: ay } },
        { point: { x: bx, y: by } },
        { thickness: 0.2 },
      ).command,
    );
  }
  await openFile(page, s.doc);
  await walkIn(page, { x: 1.5, y: 2.6 }, -Math.PI / 2, 12);
  const { rgba } = await renderPixels(page, 4);
  let sum = 0;
  for (let i = 0; i < rgba.length; i += 4)
    sum += ((rgba[i] ?? 0) + (rgba[i + 1] ?? 0) + (rgba[i + 2] ?? 0)) / 3;
  // Exposure lifts a dark room as far as it goes (+3 EV): sky or sun leaking in reads bright.
  // With no opening to the sky in reach there are no portals, so the sky lights the scene
  // itself here (as from outside): a leak through the ceiling or walls would show.
  expect(sum / (rgba.length / 4)).toBeLessThan(8);
});

const RED = '#c0392b';
const GREEN = '#3f9e4d';
const YELLOW = '#e3c13b';
const BLUE = '#2e6fd8';

/**
 * A 3 m × 4 m room (x 0–3, y 0–4): red walls north with a 0.9 m opening (no door) to a
 * blue room beyond, green west, yellow east, white south with a window; an oak floor; a
 * grey 3-seat sofa against the yellow wall. Built with the editor's own commands.
 */
function fixture(): Project {
  let s: EditorDoc = { doc: blankProject('Exact pixels'), history: emptyHistory() };
  const level = () => s.doc.levels[0] as Level;
  const id = () => level().id;
  const wall = (pts: [number, number][]) => {
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, ay] = pts[i] as [number, number];
      const [bx, by] = pts[i + 1] as [number, number];
      s = dispatch(
        s,
        drawWall(
          level(),
          { point: { x: ax, y: ay } },
          { point: { x: bx, y: by } },
          { thickness: 0.15 },
        ).command,
      );
    }
  };
  wall([
    [0, -2],
    [3, -2],
    [3, 4],
    [0, 4],
    [0, -2],
  ]);
  wall([
    [0, 0],
    [3, 0],
  ]);
  const opening = (kind: 'passage' | 'window', at: { x: number; y: number }, width: number) => {
    const p = placeOpening(planGeometry(level()), at, width, 0.3);
    if (!p?.fits) throw new Error(`no wall at ${at.x}, ${at.y}`);
    s = dispatch(
      s,
      addOpening(id(), {
        wallId: p.wallId,
        kind,
        t: p.t,
        width: p.width,
        height: kind === 'window' ? 1.2 : 2.1,
        sill: kind === 'window' ? 0.9 : 0,
      }).command,
    );
  };
  opening('passage', { x: 1.5, y: 0 }, 0.9);
  opening('window', { x: 1.5, y: 4 }, 2);
  opening('window', { x: 1.5, y: -2 }, 2);
  const main = roomIdAt(level(), { x: 1.5, y: 2 });
  const blue = roomIdAt(level(), { x: 1.5, y: -1 });
  if (!main || !blue) throw new Error('rooms not found');
  // Each wall's side to the main room in its colour, to the blue room blue, outside white.
  for (const w of Object.values(level().walls)) {
    const a = level().vertices[w.a];
    const b = level().vertices[w.b];
    if (!a || !b) continue;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const colour =
      Math.abs(mid.y) < 0.01 ? RED : mid.x < 0.01 ? GREEN : mid.x > 2.99 ? YELLOW : '#f2efe9';
    const paint = (room: string | null) =>
      room === main ? customPaint(colour) : room === blue ? customPaint(BLUE) : 'paint-white';
    const [left, right] = roomsBeside(level(), w.id);
    s = dispatch(
      s,
      updateWall(id(), w.id, { materialLeft: paint(left), materialRight: paint(right) }),
    );
  }
  s = dispatch(s, updateRoom(id(), main, { floorMaterial: 'wood-oak', name: 'Lounge' }));
  s = dispatch(
    s,
    updateRoom(id(), blue, {
      floorMaterial: customPaint(BLUE),
      ceilingMaterial: customPaint(BLUE),
      name: 'Blue room',
    }),
  );
  const sofa = furnitureKind('sofa-3');
  if (!sofa) throw new Error('no sofa');
  // Against the yellow wall, facing into the room (west).
  s = dispatch(
    s,
    addItem(id(), newItem('it_sofa', sofa, { x: 3 - 0.075 - 0.45, y: 1.6 }, Math.PI / 2)),
  );
  return s.doc;
}

/** Hue (degrees) and saturation (HSV) of an sRGB colour. */
function hsv([r, g, b]: number[]): { h: number; s: number } {
  const [R, G, B] = [r, g, b].map((v) => (v ?? 0) / 255) as [number, number, number];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === R) h = 60 * (((G - B) / d) % 6);
    else if (max === G) h = 60 * ((B - R) / d + 2);
    else h = 60 * ((R - G) / d + 4);
  }
  return { h: (h + 360) % 360, s: max ? d / max : 0 };
}
const hueOf = (hex: string) =>
  hsv([1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16))).h;
const hueGap = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

/** Where a world point lands in a picture `w` × `h` taken by `c` (pixels from the top left). */
function project(c: Cam, w: number, h: number, p: [number, number, number]) {
  const sub = (a: number[], b: number[]) => a.map((v, i) => v - (b[i] ?? 0));
  const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * (b[i] ?? 0), 0);
  const cross = (a: number[], b: number[]) => [
    (a[1] ?? 0) * (b[2] ?? 0) - (a[2] ?? 0) * (b[1] ?? 0),
    (a[2] ?? 0) * (b[0] ?? 0) - (a[0] ?? 0) * (b[2] ?? 0),
    (a[0] ?? 0) * (b[1] ?? 0) - (a[1] ?? 0) * (b[0] ?? 0),
  ];
  const norm = (a: number[]) => {
    const l = Math.hypot(...a);
    return a.map((v) => v / l);
  };
  const eye = [c.position.x, c.position.y, c.position.z];
  const f = norm(sub([c.target.x, c.target.y, c.target.z], eye));
  const r = norm(cross(f, [0, 1, 0]));
  const u = cross(r, f);
  const v = sub(p, eye);
  const z = dot(v, f);
  const t = Math.tan(c.fov / 2);
  const x = dot(v, r) / (z * t * (w / h));
  const y = dot(v, u) / (z * t);
  return { x: ((x + 1) / 2) * w, y: ((1 - y) / 2) * h };
}

test('the picture is the plan: walls where they are, the opening where it is, nothing added', async ({
  page,
}) => {
  test.setTimeout(240_000);
  // Twice the samples: each check reads a few pixels, so they should settle.
  await quick(page, 32);
  await page.goto('/');
  await waitSaved(page);
  await openFile(page, fixture());
  // Standing near the south wall's window, looking north at the opening, at noon.
  await walkIn(page, { x: 1.5, y: 3.55 }, -Math.PI / 2, 12);
  const { rgba, width: w, height: h, camera } = await renderPixels(page, 32);
  const at = (name: string, p: [number, number, number]) => {
    const q = project(camera, w, h, p);
    const cx = Math.round(q.x);
    const cy = Math.round(q.y);
    expect(cx, `${name} in the picture`).toBeGreaterThanOrEqual(6);
    expect(cy, `${name} in the picture`).toBeGreaterThanOrEqual(6);
    expect(cx, `${name} in the picture`).toBeLessThan(w - 6);
    expect(cy, `${name} in the picture`).toBeLessThan(h - 6);
    const sum = [0, 0, 0];
    for (let y = cy - 3; y <= cy + 3; y++) {
      for (let x = cx - 3; x <= cx + 3; x++) {
        for (let k = 0; k < 3; k++) sum[k] = (sum[k] ?? 0) + (rgba[(y * w + x) * 4 + k] ?? 0);
      }
    }
    return {
      ...hsv(sum.map((v) => v / 49)),
      px: [cx, cy],
      rgb: sum.map((v) => Math.round(v / 49)),
    };
  };
  // Red wall, either side of the opening; blue through it (no hole where none is planned,
  // and no door where the plan has an open doorway).
  for (const x of [0.45, 2.55]) {
    const c = at(`red wall at x ${x}`, [x, 1.3, 0.08]);
    expect(hueGap(c.h, hueOf(RED)), `red wall at x ${x}: ${JSON.stringify(c)}`).toBeLessThan(20);
    expect(c.s).toBeGreaterThan(0.25);
  }
  const through = at('the opening', [1.5, 1.0, -0.6]);
  expect(hueGap(through.h, hueOf(BLUE)), JSON.stringify(through)).toBeLessThan(25);
  // The green and yellow walls read as their own paint, nearer it than any other in the room
  // (warm light off the oak floor pulls their hues a little towards orange).
  const paints = { red: RED, green: GREEN, yellow: YELLOW, blue: BLUE, oak: '#c49a6c' };
  const nearest = (h: number) =>
    Object.entries(paints).sort((a, b) => hueGap(h, hueOf(a[1])) - hueGap(h, hueOf(b[1])))[0]?.[0];
  const green = at('green wall', [0.08, 1.5, 1.2]);
  expect(nearest(green.h), JSON.stringify(green)).toBe('green');
  expect(green.s).toBeGreaterThan(0.25);
  const yellow = at('yellow wall', [2.92, 1.6, 2.3]);
  expect(nearest(yellow.h), JSON.stringify(yellow)).toBe('yellow');
  expect(yellow.s).toBeGreaterThan(0.25);
  // Empty floor between the sofa and the camera: oak, nothing added on it.
  const floor = at('floor', [1.9, 0.01, 2.0]);
  expect(hueGap(floor.h, hueOf('#c49a6c')), JSON.stringify(floor)).toBeLessThan(25);
  expect(floor.s).toBeGreaterThan(0.2);
  // The sofa there, in its own neutral colours (its seat's cushion), not something else: less
  // saturated than any paint. Lit by the yellow wall beside it, the oak floor and the sunlit
  // ground through the window it reads a little warm: 0.14–0.23 at 32 samples (the path
  // tracer's noise on a 7×7 patch; two runs of one scene gave 0.142 and 0.224), while the paints
  // read 0.58–0.79. So the bound sits between them, and well below every paint measured here.
  const sofa = at('sofa', [2.35, 0.5, 2.0]);
  expect(sofa.s, JSON.stringify(sofa)).toBeLessThan(0.3);
  expect(sofa.s, JSON.stringify({ sofa, green, yellow })).toBeLessThan(
    Math.min(green.s, yellow.s) - 0.2,
  );
});

// ---------------------------------------------------------------- on a phone, in the walk

const { defaultBrowserType: _webkit, ...iPhone } = devices['iPhone 13'];

test.describe('on a phone', () => {
  test.use(iPhone);

  test('the walk’s camera renders exactly what the walker sees, and the walk carries on', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await quick(page);
    const settled = planImageUp(page);
    await page.goto('/');
    await waitSaved(page);
    const pose = { at: { x: 8.3, y: 3.2 }, yaw: 2.4, pitch: 0 };
    await page.evaluate((p) => {
      localStorage.setItem(`dhd:walk:${localStorage.getItem('dhd:last')}`, JSON.stringify(p));
    }, pose);
    await page.getByRole('button', { name: 'Switch to 3D' }).tap();
    await page.getByRole('button', { name: 'Walk through' }).tap();
    await expect(page.getByRole('button', { name: 'Leave walk' })).toBeVisible();
    const marker = page.locator('.minimap-view').locator('..');
    await expect(marker).toHaveAttribute('transform', /rotate/);
    const before = await marker.getAttribute('transform');
    // No key saved: still nothing to a provider or the server.
    await settled();
    const sent = requests(page);

    await page.getByRole('button', { name: 'Photo-real render' }).tap();
    const dialog = page.getByRole('dialog', { name: 'Photo-real render' });
    await expect(dialog.getByRole('button', { name: 'Exact', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(dialog.locator('.exact-picture')).toHaveAttribute('data-camera', /position/, {
      timeout: 60_000,
    });
    // At eye height already: no choice of where to render from.
    await expect(dialog.getByRole('button', { name: /^From eye height/ })).toHaveCount(0);
    // The walk's own camera: where the walker stands, looking where they look.
    const cam = await renderCamera(page);
    expect(Math.abs(cam.position.x - pose.at.x)).toBeLessThan(0.001);
    expect(Math.abs(cam.position.z - pose.at.y)).toBeLessThan(0.001);
    expect(cam.position.y).toBeCloseTo(1.6, 1);
    const dir = [cam.target.x - cam.position.x, cam.target.z - cam.position.z];
    const angle = Math.atan2(dir[1] as number, dir[0] as number);
    const off = Math.abs(((angle - pose.yaw + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
    expect((off * 180) / Math.PI).toBeLessThan(0.1);
    expect(Math.abs(cam.target.y - cam.position.y)).toBeLessThan(1e-6); // looking level

    await expect(dialog.getByTestId('exact-progress')).toHaveText(/^Sample \d+ of 16/, {
      timeout: 90_000,
    });
    await expect.poll(() => sampleCount(page), { timeout: 60_000 }).toBeGreaterThan(1);
    expect(outside(sent)).toEqual([]);
    // Upright, on its side, and on a small phone on its side: the picture, Stop and Download
    // in full view, the buttons a fingertip's size.
    for (const [width, height] of [
      [390, 844],
      [844, 390],
      [568, 320],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(300);
      await expect(dialog.locator('.exact-picture')).toBeInViewport({ ratio: 1 });
      for (const name of [/^Stop$|^Carry on$/, /^Download$/]) {
        const b = dialog.getByRole('button', { name });
        await expect(b, `${name} at ${width} × ${height}`).toBeInViewport({ ratio: 1 });
        const r = await b.boundingBox();
        expect(r?.height ?? 0).toBeGreaterThanOrEqual(44);
        expect(r?.width ?? 0).toBeGreaterThanOrEqual(44);
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    // Closed: the walk carries on from the same spot.
    await dialog.getByRole('button', { name: 'Close' }).tap();
    await expect(dialog).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(await marker.getAttribute('transform')).toBe(before);
  });
});

test('without WebGL 2, Exact says why and the dialog offers AI impression as before', async ({
  page,
}) => {
  // The 3D view needs WebGL 2 too (three.js has no WebGL 1), so only a canvas off the page (the
  // exact render's own check and its canvas) is turned down.
  await page.addInitScript(() => {
    const get = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      type: string,
      ...rest: unknown[]
    ) {
      if (type === 'webgl2' && !this.isConnected) return null;
      return (get as (...a: unknown[]) => RenderingContext | null).call(this, type, ...rest);
    } as typeof HTMLCanvasElement.prototype.getContext;
  });
  await page.goto('/');
  await waitSaved(page);
  await page.keyboard.press('3');
  await page.getByRole('button', { name: 'Photo-real render' }).click();
  const dialog = page.getByRole('dialog', { name: 'Photo-real render' });
  await expect(dialog.getByRole('button', { name: 'Exact', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'AI impression' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(
    dialog.getByText('Exact renders need WebGL 2, which this browser doesn’t have.'),
  ).toBeVisible();
  // AI impression as today: no key, no render, and it says so.
  await expect(dialog).toContainText('Renders need an OpenAI or Gemini key');
  await expect(dialog.getByRole('button', { name: 'Render' })).toBeDisabled();
  await expect(dialog.getByRole('img', { name: /^The 3D view/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('canvas.exact-canvas')).toHaveCount(0);
});
