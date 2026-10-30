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
 * dining room with a dry kitchen marked off by room boundaries. It is built with the same
 * commands the editor uses, so it is always a valid, fully connected plan, then given
 * readable ids. Coordinates are wall centre lines in millimetres from the plan's top left.
 *
 *    0.15      3.3        6.35          10.16
 *  0 +---------+----------+
 *    | Main    | Bedroom  |
 *    | bedroom |          +--------------+ 1.58
 *    |         +----------+              |
 *    |         |   (3.1)     Living and  |
 *    +----+----+----+.......  dining     | 4.33
 *    |Bath|Bath     |Dry   :             |
 *    | 1  | 2       |kitch.:             |
 *    +----+----+----+------+-----+-------+ 6.15
 *    |Ledge|   |Kitchen    |Shel-|
 *    +-----+   |           |ter  |         7.17 / 7.89
 *              +-----------+-----+         8.89
 */
export function sampleFlatProject(id = 'prj_sample'): Project {
  let s: EditorDoc = { doc: blankProject('3-room HDB (sample)', id), history: emptyHistory() };
  const level = () => s.doc.levels[0] as Level;
  const wall = (pts: [number, number][], thickness = 0.1, kind?: 'boundary') => {
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, ay] = pts[i] as [number, number];
      const [bx, by] = pts[i + 1] as [number, number];
      const r = drawWall(
        level(),
        { point: { x: ax / 1000, y: ay / 1000 } },
        { point: { x: bx / 1000, y: by / 1000 } },
        { thickness, ...(kind ? { kind } : {}) },
      );
      s = dispatch(s, r.command);
    }
  };

  // The outside of the flat, then the shelter's thick walls.
  wall(
    [
      [150, 72],
      [6352, 72],
      [6352, 1579],
      [10158, 1579],
      [10158, 6150],
      [8136, 6150],
      [8136, 7891],
      [6435, 7891],
      [6435, 8886],
      [3285, 8886],
      [3285, 6150],
      [2450, 6150],
      [2450, 7171],
      [150, 7171],
      [150, 72],
    ],
    0.2,
  );
  wall(
    [
      [8136, 6150],
      [6435, 6150],
      [6435, 7891],
    ],
    0.2,
  );
  wall([
    [150, 6150],
    [2450, 6150],
  ]);
  wall([
    [3285, 6150],
    [6435, 6150],
  ]);
  wall([
    [150, 4327],
    [4545, 4327],
    [4545, 6150],
  ]);
  wall([
    [3285, 72],
    [3285, 4327],
  ]);
  wall([
    [2450, 4327],
    [2450, 6150],
  ]);
  wall([
    [6352, 1579],
    [6352, 3100],
    [3285, 3100],
  ]);
  // The dry kitchen is open to the living room: dashed boundaries, not walls.
  wall(
    [
      [4545, 4327],
      [6435, 4327],
      [6435, 6150],
    ],
    0.1,
    'boundary',
  );

  const rooms: [string, string, Vec2][] = [
    ['Main bedroom', 'wood-walnut', { x: 1.7, y: 1.5 }],
    ['Bedroom', 'wood-oak', { x: 4.8, y: 1.5 }],
    ['Living and dining', 'wood-oak', { x: 8.3, y: 4.3 }],
    ['Dry kitchen', 'tile-grey', { x: 5.5, y: 5.2 }],
    ['Bath/WC 1', 'tile-grey', { x: 1.1, y: 5.5 }],
    ['Bath/WC 2', 'tile-grey', { x: 3.5, y: 5.5 }],
    ['Kitchen', 'tile-grey', { x: 4.6, y: 7.9 }],
    ['Household shelter', 'paint-white', { x: 7.3, y: 7.2 }],
    ['Air-con ledge', 'paint-white', { x: 1.3, y: 6.7 }],
  ];
  for (const [name, floorMaterial, at] of rooms) {
    const room = Object.values(level().rooms).find((r) =>
      pointInPolygon(at, roomPolygon(level(), r)),
    );
    if (!room) throw new Error(`sample: no room at ${at.x}, ${at.y} for ${name}`);
    s = dispatch(s, updateRoom(level().id, room.id, { name, floorMaterial }));
  }

  // Each opening is placed on the wall nearest `at`; a door swings to the side `at` is on.
  const openings: [OpeningKind, number, Vec2][] = [
    ['door', 1.0, { x: 9.257, y: 6.09 }], // main door
    ['door', 0.8, { x: 3.24, y: 3.725 }], // main bedroom
    ['door', 0.8, { x: 3.944, y: 3.05 }], // bedroom
    ['door', 0.7, { x: 1.7, y: 4.28 }], // bath 1
    ['door', 0.7, { x: 3.9, y: 4.28 }], // bath 2
    ['door', 0.8, { x: 6.39, y: 7.218 }], // shelter
    ['passage', 1.2, { x: 5.81, y: 6.15 }], // kitchen
    ['window', 1.8, { x: 1.828, y: 0.072 }], // main bedroom
    ['window', 1.6, { x: 0.15, y: 3.387 }], // main bedroom, side
    ['window', 1.8, { x: 4.678, y: 0.072 }], // bedroom
    ['window', 2.4, { x: 8.17, y: 1.579 }], // living
    ['window', 0.8, { x: 1.062, y: 6.15 }], // bath 1
    ['window', 0.6, { x: 2.867, y: 6.15 }], // bath 2
    ['window', 1.2, { x: 3.285, y: 7.3 }], // kitchen
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
