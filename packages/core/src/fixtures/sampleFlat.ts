import { addOpening, drawWall, updateRoom } from '../commands';
import { blankProject } from '../factory';
import { pointInPolygon, roomPolygon } from '../geometry';
import { type EditorDoc, dispatch, emptyHistory } from '../history';
import { placeOpening, planGeometry } from '../plan';
import type { Level, OpeningKind, Project, Vec2 } from '../schema';

/**
 * The sample flat new visitors explore: a 4-room HDB-style layout of about 96 m² (to wall
 * centre lines) with a service yard, kitchen, household shelter, two bathrooms, three
 * bedrooms and an L-shaped living and dining room. It is built with the same commands the
 * editor uses, so it is always a valid, fully connected plan, then given readable ids.
 *
 *   0          3.2       5.6       8.6     10.6    12
 * 0 +----------+---------+---------+-------+------+
 *   | Yard     |         | Bed 3   | Master       |
 * 1.6+---------+         |         |              |
 *   | Kitchen  |  Living +---------+ 3.2          |
 *   |          |  and              +-------+------+ 3.6
 * 4.6+----+----+  dining           | Corr. | M.bath|
 *   | HS | Bath|                   +-------+------+ 5.2
 * 6.2+----+----+                   | Bedroom 2    |
 *   |                              |              |
 * 8 +------------------------------+--------------+
 */
export function sampleFlatProject(id = 'prj_sample'): Project {
  let s: EditorDoc = { doc: blankProject('4-room HDB (sample)', id), history: emptyHistory() };
  const level = () => s.doc.levels[0] as Level;
  const wall = (pts: [number, number][], thickness = 0.1) => {
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, ay] = pts[i] as [number, number];
      const [bx, by] = pts[i + 1] as [number, number];
      const r = drawWall(
        level(),
        { point: { x: ax, y: ay } },
        { point: { x: bx, y: by } },
        {
          thickness,
        },
      );
      s = dispatch(s, r.command);
    }
  };

  wall(
    [
      [0, 0],
      [12, 0],
      [12, 8],
      [0, 8],
      [0, 0],
    ],
    0.2,
  );
  wall([
    [3.2, 0],
    [3.2, 6.2],
  ]);
  wall([
    [0, 1.6],
    [3.2, 1.6],
  ]);
  wall([
    [0, 4.6],
    [3.2, 4.6],
  ]);
  wall([
    [0, 6.2],
    [3.2, 6.2],
  ]);
  wall([
    [1.4, 4.6],
    [1.4, 6.2],
  ]);
  wall([
    [8.6, 0],
    [8.6, 8],
  ]);
  wall([
    [5.6, 0],
    [5.6, 3.2],
    [8.6, 3.2],
  ]);
  wall([
    [8.6, 3.6],
    [12, 3.6],
  ]);
  wall([
    [10.6, 3.6],
    [10.6, 5.2],
  ]);
  wall([
    [8.6, 5.2],
    [10.6, 5.2],
  ]);
  wall([
    [10.6, 5.2],
    [12, 5.2],
  ]);

  const rooms: [string, string, Vec2][] = [
    ['Service yard', 'tile-grey', { x: 1.6, y: 0.8 }],
    ['Kitchen', 'tile-grey', { x: 1.6, y: 3.1 }],
    ['Household shelter', 'paint-white', { x: 0.7, y: 5.4 }],
    ['Bathroom', 'tile-grey', { x: 2.3, y: 5.4 }],
    ['Living and dining', 'wood-oak', { x: 5, y: 5.5 }],
    ['Bedroom 3', 'wood-oak', { x: 7.1, y: 1.6 }],
    ['Master bedroom', 'wood-walnut', { x: 10.3, y: 1.8 }],
    ['Corridor', 'wood-oak', { x: 9.6, y: 4.4 }],
    ['Master bathroom', 'tile-grey', { x: 11.3, y: 4.4 }],
    ['Bedroom 2', 'wood-oak', { x: 10.3, y: 6.6 }],
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
    ['door', 0.9, { x: 4.4, y: 7.8 }], // main door
    ['passage', 0.9, { x: 3.3, y: 3.0 }], // kitchen
    ['passage', 0.8, { x: 1.6, y: 1.7 }], // yard
    ['door', 0.8, { x: 0.7, y: 6.3 }], // shelter, opening outwards
    ['door', 0.7, { x: 2.4, y: 6.1 }], // bathroom
    ['door', 0.8, { x: 6.2, y: 3.1 }], // bedroom 3
    ['passage', 0.9, { x: 8.7, y: 4.4 }], // corridor
    ['door', 0.8, { x: 9.6, y: 3.5 }], // master bedroom
    ['door', 0.7, { x: 11.3, y: 3.7 }], // master bathroom
    ['door', 0.8, { x: 9.6, y: 5.3 }], // bedroom 2
    ['window', 1.6, { x: 4.4, y: 0.1 }], // living
    ['window', 1.8, { x: 7.0, y: 7.9 }], // dining
    ['window', 1.2, { x: 0.1, y: 3.1 }], // kitchen
    ['window', 0.9, { x: 0.1, y: 0.8 }], // yard
    ['window', 1.5, { x: 7.1, y: 0.1 }], // bedroom 3
    ['window', 1.8, { x: 10.3, y: 0.1 }], // master bedroom
    ['window', 0.6, { x: 11.9, y: 4.4 }], // master bathroom
    ['window', 1.2, { x: 11.9, y: 6.6 }], // bedroom 2
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
  return readableIds(s.doc);
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
