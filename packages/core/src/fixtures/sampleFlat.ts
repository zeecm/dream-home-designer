import { addOpening, drawWall, updateRoom } from '../commands';
import { blankProject } from '../factory';
import { pointInPolygon, roomPolygon } from '../geometry';
import { type EditorDoc, dispatch, emptyHistory } from '../history';
import { placeOpening, planGeometry } from '../plan';
import type { Level, OpeningKind, Project, Vec2 } from '../schema';

/** The bundled image of the sample's floor plan (`/samples/hdb-3room-type4.png` in the web app). */
export const SAMPLE_PLAN_KEY =
  'sha256:2bc0d95b7f74579cd970db461ce45dfc08900e46b301315899780ed5a56a5c9a';

/**
 * The sample flat new visitors explore: an HDB 3-room Type 4 flat (Blk 39A), traced from
 * its published floor plan, which sits under it already scaled. Two bedrooms, two
 * bathrooms, a kitchen, a household shelter, an air-con ledge, and an L-shaped living and
 * dining room with a dry kitchen marked off by room boundaries.
 *
 * Every wall has the thickness measured off the plan: 300 mm structural walls, the 255 mm
 * shelter, 150 mm window walls, 100 mm partitions. Where a wall changes thickness along its
 * run with one face flush (the bedroom's 300 mm wall thinning to 100 mm, the shelter's wall
 * carrying on as the kitchen's 125 mm one), the line is that face and the wall lies to one
 * side of it. It is built with the same commands the editor uses, so it is always a valid,
 * fully connected plan, then given readable ids. Coordinates are in millimetres from the
 * outside corner at the plan's top left.
 *
 *    0.15     2.95 3.27      6.5           10.15
 *  0 +---------+----+--------+
 *    | Main         | Bedroom|
 *    | bedroom      |        +-------------+ 1.57
 *    |         +----+--------+             |
 *    |         D  corridor      Living and |
 *    +----+----+-----+.......:  dining     | 4.32
 *    |Bath|Bath 2    |Dry    :             |
 *    | 1  |          |kitchen:             |
 *    +----+-+--+-----+-------+-----+-------+ 6.04 / 6.17
 *    |Ledge |  |Kitchen      |Shel-|
 *    +------+  |             |ter  |         7.17 / 7.90
 *              +-------------+-----+         8.88
 */
export function sampleFlatProject(id = 'prj_sample'): Project {
  let s: EditorDoc = { doc: blankProject('3-room HDB (sample)', id), history: emptyHistory() };
  const level = () => s.doc.levels[0] as Level;
  const wall = (
    pts: [number, number][],
    thickness: number,
    opts: { side?: 'left' | 'right'; kind?: 'boundary' } = {},
  ) => {
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, ay] = pts[i] as [number, number];
      const [bx, by] = pts[i + 1] as [number, number];
      const r = drawWall(
        level(),
        { point: { x: ax / 1000, y: ay / 1000 } },
        { point: { x: bx / 1000, y: by / 1000 } },
        { thickness: thickness / 1000, ...opts },
      );
      s = dispatch(s, r.command);
    }
  };

  // Outside walls, clockwise from the top left. The left wall is 300 mm all the way down,
  // structural or round the main bedroom's side window.
  wall(
    [
      [150, 75],
      [6495, 75],
    ],
    150,
  );
  // The bedroom's outside wall: 300 mm, then 100 mm, its living-room face flush (x 6.495).
  wall(
    [
      [6495, 75],
      [6495, 2156],
    ],
    300,
    { side: 'left' },
  );
  wall(
    [
      [6495, 2156],
      [6495, 3098],
    ],
    100,
    { side: 'left' },
  );
  wall(
    [
      [6495, 1574],
      [10152, 1574],
    ],
    150,
  );
  wall(
    [
      [10152, 1574],
      [10152, 6044],
    ],
    254,
  );
  // The front wall, then the household shelter's 255 mm walls.
  wall(
    [
      [10152, 6044],
      [8120, 6044],
      [6291, 6044],
    ],
    255,
  );
  wall(
    [
      [8120, 6044],
      [8120, 7897],
      [6291, 7897],
    ],
    255,
  );
  // The shelter's kitchen wall, carrying on as the kitchen's 125 mm outside wall: one
  // flush kitchen face (x 6.291), the walls lying to the shelter's side of it.
  wall(
    [
      [6291, 6044],
      [6291, 7897],
    ],
    255,
    { side: 'right' },
  );
  wall(
    [
      [6291, 7897],
      [6291, 8875],
    ],
    125,
    { side: 'right' },
  );
  wall(
    [
      [6291, 8875],
      [3266, 8875],
    ],
    300,
  );
  wall(
    [
      [3266, 8875],
      [3266, 6171],
    ],
    150,
  );
  wall(
    [
      [150, 75],
      [150, 7170],
    ],
    300,
  );
  // The air-con ledge's parapets.
  wall(
    [
      [150, 7170],
      [2491, 7170],
      [2491, 6171],
    ],
    105,
  );
  // Inside: bathrooms, bedrooms and the walls between.
  wall(
    [
      [150, 6171],
      [6291, 6171],
    ],
    106,
  );
  wall(
    [
      [150, 4322],
      [4532, 4322],
    ],
    100,
  );
  wall(
    [
      [4532, 4322],
      [4532, 6171],
    ],
    300,
  );
  wall(
    [
      [2397, 4322],
      [2397, 6171],
    ],
    90,
  );
  wall(
    [
      [3266, 75],
      [3266, 3098],
    ],
    100,
  );
  wall(
    [
      [2950, 4322],
      [2950, 3098],
      [6495, 3098],
    ],
    100,
  );
  // The dry kitchen is open to the living room: dashed boundaries, not walls.
  wall(
    [
      [4532, 4322],
      [6291, 4322],
      [6291, 6044],
    ],
    100,
    { kind: 'boundary' },
  );
  const rooms: [string, string, Vec2][] = [
    ['Main bedroom', 'wood-walnut', { x: 1.5, y: 1.5 }],
    ['Bedroom', 'wood-oak', { x: 4.8, y: 1.5 }],
    ['Living and dining', 'wood-oak', { x: 8.3, y: 3.8 }],
    ['Dry kitchen', 'tile-grey', { x: 5.4, y: 5.2 }],
    ['Bath/WC 1', 'tile-grey', { x: 1.3, y: 5.2 }],
    ['Bath/WC 2', 'tile-grey', { x: 3.5, y: 5.2 }],
    ['Kitchen', 'tile-grey', { x: 4.7, y: 7.5 }],
    ['Household shelter', 'paint-white', { x: 7.2, y: 7.0 }],
    ['Air-con ledge', 'paint-white', { x: 1.3, y: 6.7 }],
  ];
  for (const [name, floorMaterial, at] of rooms) {
    const room = Object.values(level().rooms).find((r) =>
      pointInPolygon(at, roomPolygon(level(), r)),
    );
    if (!room) throw new Error(`sample: no room at ${at.x}, ${at.y} for ${name}`);
    s = dispatch(s, updateRoom(level().id, room.id, { name, floorMaterial }));
  }

  // Each opening goes on the wall nearest `at`, at the width measured off the plan; a door
  // swings to the side `at` is on.
  const openings: [OpeningKind, number, Vec2][] = [
    ['door', 1.0, { x: 9.109, y: 5.85 }], // main door
    ['door', 0.9, { x: 2.85, y: 3.705 }], // main bedroom
    ['door', 0.9, { x: 3.915, y: 3.0 }], // bedroom
    ['door', 0.9, { x: 1.526, y: 4.42 }], // bath 1, folding into the bathroom
    ['door', 0.9, { x: 3.74, y: 4.42 }], // bath 2, folding into the bathroom
    ['door', 0.8, { x: 6.24, y: 7.219 }], // shelter, opening into the kitchen
    ['passage', 1.1, { x: 5.737, y: 6.171 }], // dry kitchen to kitchen
    ['window', 1.8, { x: 1.82, y: 0.075 }], // main bedroom
    ['window', 1.75, { x: 0.15, y: 3.388 }], // main bedroom, side
    ['window', 1.8, { x: 4.672, y: 0.075 }], // bedroom
    ['window', 2.4, { x: 8.16, y: 1.574 }], // living
    ['window', 0.8, { x: 1.05, y: 6.171 }], // bath 1
    ['window', 0.5, { x: 2.8, y: 6.171 }], // bath 2
    ['window', 1.8, { x: 3.266, y: 7.471 }], // kitchen, side
    ['window', 1.45, { x: 5.567, y: 8.875 }], // kitchen, back
  ];
  for (const [kind, width, at] of openings) {
    const p = placeOpening(planGeometry(level()), at, width, 0.3);
    if (!p?.fits) throw new Error(`sample: no wall for the ${kind} at ${at.x}, ${at.y}`);
    const r = addOpening(level().id, {
      wallId: p.wallId,
      kind,
      t: p.t,
      width: p.width,
      height: kind === 'window' ? 1.2 : 2.1,
      sill: kind === 'window' ? 0.9 : 0,
      ...(kind === 'door'
        ? { swing: `${p.nearA ? 'left' : 'right'}${p.side > 0 ? 'In' : 'Out'}` as const }
        : {}),
    });
    s = dispatch(s, r.command);
  }
  const project = readableIds(s.doc);
  // The published plan, scaled so its drawing lines up with the walls traced from it.
  return {
    ...project,
    underlay: {
      assetKey: SAMPLE_PLAN_KEY,
      opacity: 0.45,
      rotation: 0,
      origin: { x: -2.970327, y: -2.439987 },
      scale: 0.009901979,
    },
  };
}

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

/**
 * Replaces generated ids with readable, stable ones: rooms by name, walls by the rooms on
 * either side (`w_bedroom-2_corridor`), openings by kind and wall, corners by position.
 */
function readableIds(project: Project): Project {
  const level = project.levels[0] as Level;
  const unique = (used: Set<string>, base: string) => {
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    return id;
  };

  const vIds = new Map<string, string>();
  const vUsed = new Set<string>();
  const byPos = Object.values(level.vertices).sort((a, b) => a.y - b.y || a.x - b.x);
  for (const v of byPos) vIds.set(v.id, unique(vUsed, `v_${v.x}_${v.y}`.replace(/\./g, 'p')));

  const roomAt = (p: Vec2) =>
    Object.values(level.rooms).find((r) => pointInPolygon(p, roomPolygon(level, r)));
  const wIds = new Map<string, string>();
  const wUsed = new Set<string>();
  for (const w of Object.values(level.walls)) {
    const a = level.vertices[w.a] as Vec2;
    const b = level.vertices[w.b] as Vec2;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const n = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
    const sides = [1, -1]
      .map((k) => roomAt({ x: mid.x + n.x * 0.2 * k, y: mid.y + n.y * 0.2 * k }))
      .map((r) => (r ? slug(r.name) : 'outside'))
      .sort();
    wIds.set(w.id, unique(wUsed, `w_${sides.join('_')}`));
  }

  const rIds = new Map<string, string>();
  const rUsed = new Set<string>();
  for (const r of Object.values(level.rooms)) rIds.set(r.id, unique(rUsed, `rm_${slug(r.name)}`));

  const oUsed = new Set<string>();
  const vertices = Object.fromEntries(
    Object.values(level.vertices).map((v) => {
      const id = vIds.get(v.id) as string;
      return [id, { ...v, id }];
    }),
  );
  const walls = Object.fromEntries(
    Object.values(level.walls).map((w) => {
      const id = wIds.get(w.id) as string;
      return [id, { ...w, id, a: vIds.get(w.a) as string, b: vIds.get(w.b) as string }];
    }),
  );
  const openings = Object.fromEntries(
    Object.values(level.openings).map((o) => {
      const wallId = wIds.get(o.wallId) as string;
      const id = unique(oUsed, `op_${o.kind}_${wallId.slice(2)}`);
      return [id, { ...o, id, wallId }];
    }),
  );
  const rooms = Object.fromEntries(
    Object.values(level.rooms).map((r) => {
      const id = rIds.get(r.id) as string;
      return [id, { ...r, id, loop: r.loop.map((v) => vIds.get(v) as string) }];
    }),
  );
  return { ...project, levels: [{ ...level, vertices, walls, openings, rooms }] };
}
