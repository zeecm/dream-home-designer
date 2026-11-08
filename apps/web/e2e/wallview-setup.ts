import { waitSaved } from './helpers';
import { type Page, expect } from './test';

/**
 * The sample flat furnished for the wall view: the main bedroom's window wall (D) with a
 * built-in wardrobe and sockets, and the kitchen's window wall (C) with its run, wall
 * cabinets and points. Built on the plan the server has, then opened as a project file.
 */

type Vec = { x: number; y: number };
// biome-ignore lint/suspicious/noExplicitAny: a project document as JSON
type Doc = any;

export const BEDROOM_WALL = 'w_main-bedroom_outside';
export const KITCHEN_WALL = 'w_kitchen_outside-2';
export const BETWEEN_BEDROOMS = 'w_bedroom_main-bedroom';

/** The plan open now, as the server has it. */
export async function currentDoc(page: Page): Promise<Doc> {
  return page.evaluate(async () => {
    const id = localStorage.getItem('dhd:last');
    const r = await fetch(`/api/projects/${id}`);
    return r.json();
  });
}

/** Opens a project from a file, as Projects ▸ Open a project file does. */
export async function importDoc(page: Page, doc: unknown) {
  await page.locator('input[type="file"][accept=".json,application/json"]').setInputFiles({
    name: 'plan.dreamhome.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(doc)),
  });
  await waitSaved(page);
}

/** Where along a wall (as `t` from vertex a) a plan point is. */
function tOn(level: Doc, wallId: string, p: Vec): number {
  const w = level.walls[wallId];
  const a = level.vertices[w.a];
  const b = level.vertices[w.b];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy);
}

const item = (id: string, assetId: string, x: number, z: number, rot: number, y = 0, sy = 1) => ({
  id,
  assetId,
  position: { x, y, z },
  rotationY: rot,
  scale: { x: 1, y: sy, z: 1 },
  flags: { snapWall: true, collidable: true },
});

/** The sample with the bedroom and kitchen walls furnished (and `hidden`: a socket behind the wardrobe). */
export function furnishedDoc(doc: Doc, opts: { hidden?: boolean } = {}): Doc {
  const level = doc.levels[0];
  const ceiling = level.ceilingHeight as number;
  const point = (id: string, kind: string, wallId: string, at: Vec, height: number) => {
    level.points[id] = {
      id,
      kind,
      wall: { wallId, t: tOn(level, wallId, at), side: 'left', height },
    };
  };
  level.points ??= {};
  // The main bedroom's window wall: its face at y 0.15, x 0.30 to 3.22, the room below.
  // A one-door built-in wardrobe in the corner, clear of the 1.8 m window.
  level.items.it_wardrobe = {
    ...item('it_wardrobe', 'built-in-wardrobe', 2.95, 0.45, 0, 0, ceiling / 2.6),
    scale: { x: 0.5 / 1.8, y: ceiling / 2.6, z: 1 },
  };
  point('pt_bed1', 'socket-double', BEDROOM_WALL, { x: 0.62, y: 0.075 }, 0.3);
  point('pt_bed2', 'switch', BEDROOM_WALL, { x: 0.5, y: 0.075 }, 1.05);
  if (opts.hidden) point('pt_hidden', 'socket-double', BEDROOM_WALL, { x: 2.95, y: 0.075 }, 0.3);
  // The kitchen's window wall, at y 8.72 (the room above): the run, cabinets over the sink
  // and the hob, and its points.
  const y = 8.425;
  level.items.it_k1 = item('it_k1', 'kitchen-hob', 3.75, y, Math.PI);
  level.items.it_k2 = item('it_k2', 'kitchen-sink', 4.55, y, Math.PI);
  level.items.it_k3 = item('it_k3', 'kitchen-base', 5.25, y, Math.PI);
  level.items.it_k4 = item('it_k4', 'kitchen-base', 5.85, y, Math.PI);
  // Over the hob at the catalogue's 1.45 m: 0.55 m clear, short of the hood's 0.65 m.
  level.items.it_u1 = item('it_u1', 'kitchen-wall', 3.75, 8.545, Math.PI, 1.45);
  level.items.it_u2 = item('it_u2', 'kitchen-wall', 4.55, 8.545, Math.PI, 1.45);
  point('pt_k1', 'socket-double', KITCHEN_WALL, { x: 4.2, y: 8.8 }, 1.15);
  point('pt_k2', 'socket-double', KITCHEN_WALL, { x: 5.55, y: 8.8 }, 1.15);
  point('pt_k3', 'cooker', KITCHEN_WALL, { x: 3.75, y: 8.8 }, 0.6);
  return doc;
}

/** Opens the sample, furnished, and waits for it to be saved. */
export async function openFurnished(page: Page, opts: { hidden?: boolean } = {}) {
  await page.goto('/');
  await waitSaved(page);
  await importDoc(page, furnishedDoc(await currentDoc(page), opts));
  await page.keyboard.press('2');
}

/** Selects a wall on the plan by clicking its outline, clear of points and openings on it. */
export async function selectWall(page: Page, wallId: string, at = 0.5) {
  const el = page.locator(`svg.plan-svg [data-hit="wall:${wallId}"]`).first();
  // Once the plan has stopped moving (a fit after a view switch).
  let box = await el.boundingBox();
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(100);
    const now = await el.boundingBox();
    if (JSON.stringify(now) === JSON.stringify(box)) break;
    box = now;
  }
  if (!box) throw new Error(`no wall ${wallId}`);
  // Pressed on the wall's own outline (points and openings drawn over it take a click there).
  const x = box.x + box.width * (box.width > box.height ? at : 0.5);
  const y = box.y + box.height * (box.width > box.height ? 0.5 : at);
  const init = {
    clientX: x,
    clientY: y,
    button: 0,
    buttons: 1,
    pointerId: 1,
    isPrimary: true,
    pointerType: 'mouse',
  };
  await el.dispatchEvent('pointerdown', init);
  await el.dispatchEvent('pointerup', { ...init, buttons: 0 });
  await expect(page.locator('.inspector .panel-title').first()).toHaveText(/Wall|boundary/);
}

/** Opens the wall view on a wall's side named for its room, from the Inspector. */
export async function openWall(page: Page, wallId: string, room: string) {
  await selectWall(page, wallId);
  await page.getByRole('button', { name: `${room} side`, exact: true }).click();
  await expect(page.getByTestId('wall-view')).toBeVisible();
}

export const wallView = (page: Page) => page.getByTestId('wall-view');
export const title = (page: Page) => wallView(page).locator('.elev-title');
