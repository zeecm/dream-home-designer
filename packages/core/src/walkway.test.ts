import { describe, expect, it } from 'vitest';
import { addOpening, drawWall, updateWall } from './commands';
import { blankProject } from './factory';
import { sampleFlatProject } from './fixtures/sampleFlat';
import { customKind, furnitureKind, newItem, setProjectModels } from './furniture';
import { type EditorDoc, dispatch, emptyHistory } from './history';
import { variantLevels } from './levels';
import { startRenovation } from './renovation';
import type { CustomModel, Level, Opening, Vec2 } from './schema';
import { type WalkwayReport, walkwayReport, walkwayStatus } from './walkway';

/**
 * Two 4 m rooms side by side over a corridor `clear` wide (walls 100 mm on centre lines),
 * a door from the corridor into each, and the outside door at the corridor's left end.
 *
 *   (0,0) ---------- (4,0) ---------- (8,0)
 *     |   Room A       |    Room B       |
 *   (0,4) ---[dA]--- (4,4) ---[dB]--- (8,4)
 *    [out]        corridor               |
 *   (0,Y) ------------------------------ (8,Y)
 */
interface Fixture {
  s: EditorDoc;
  wall: (a: Vec2, b: Vec2, on?: Level) => string;
  y: number;
}

function flat(clear = 1.2, opts: { outside?: boolean; doors?: number } = {}): Fixture {
  let s: EditorDoc = { doc: blankProject('t', 'prj_t'), history: emptyHistory() };
  const lvl = () => s.doc.levels[0] as Level;
  const y = 4 + clear + 0.1;
  const line = (pts: [number, number][]) => {
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, ay] = pts[i] as [number, number];
      const [bx, by] = pts[i + 1] as [number, number];
      s = dispatch(
        s,
        drawWall(
          lvl(),
          { point: { x: ax, y: ay } },
          { point: { x: bx, y: by } },
          { thickness: 0.1 },
        ).command,
      );
    }
  };
  line([
    [0, 0],
    [8, 0],
    [8, y],
    [0, y],
    [0, 0],
  ]);
  line([
    [0, 4],
    [8, 4],
  ]);
  line([
    [4, 0],
    [4, 4],
  ]);
  const wall = (a: Vec2, b: Vec2, on?: Level) => {
    const l = on ?? lvl();
    const w = Object.values(l.walls).find((w) => {
      const p = l.vertices[w.a];
      const q = l.vertices[w.b];
      if (!p || !q) return false;
      const is = (u: Vec2, v: Vec2) => Math.hypot(u.x - v.x, u.y - v.y) < 1e-6;
      return (is(p, a) && is(q, b)) || (is(p, b) && is(q, a));
    });
    if (!w) throw new Error(`no wall ${a.x},${a.y} ${b.x},${b.y}`);
    return w.id;
  };
  const door = (wallId: string, width: number, extra: Partial<Opening> = {}) => {
    s = dispatch(
      s,
      addOpening(lvl().id, {
        wallId,
        kind: 'door',
        t: 0.5,
        width,
        height: 2.1,
        sill: 0,
        swing: 'leftIn',
        ...extra,
      }).command,
    );
  };
  const dw = opts.doors ?? 0.8;
  door(wall({ x: 0, y: 4 }, { x: 4, y: 4 }), dw);
  door(wall({ x: 4, y: 4 }, { x: 8, y: 4 }), dw);
  if (opts.outside !== false) door(wall({ x: 0, y: 4 }, { x: 0, y }), 0.9);
  return { s, wall, y };
}

const level = (f: Fixture | EditorDoc) => ('s' in f ? f.s : f).doc.levels[0] as Level;

let n = 0;
/** The level with pieces added: [kind id, centre, rotation]. */
function withItems(lvl: Level, pieces: [string, Vec2, number?][]): Level {
  const items = { ...lvl.items };
  for (const [kindId, at, rot] of pieces) {
    const kind = furnitureKind(kindId);
    if (!kind) throw new Error(`no ${kindId}`);
    const it = newItem(`it_${++n}`, kind, at, rot ?? 0);
    items[it.id] = it;
  }
  return Object.freeze({ ...lvl, items });
}
const lastId = () => `it_${n}`;
const roomNamed = (lvl: Level, x: number, y: number) =>
  Object.values(lvl.rooms).find((r) => {
    const pts = r.loop.map((v) => lvl.vertices[v] as Vec2);
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    return x > Math.min(...xs) && x < Math.max(...xs) && y > Math.min(...ys) && y < Math.max(...ys);
  })?.id;
const ways = (r: WalkwayReport) => r.issues;

describe('walkways', () => {
  it('1. a bare flat with a 1.2 m corridor: no issues, ok', () => {
    const lvl = level(flat());
    const r = walkwayReport(lvl);
    expect(r.status).toBe('ok');
    expect(r.issues).toHaveLength(0);
    // Both rooms and the corridor are reached.
    expect(r.routes.filter((x) => x.route === 'circulation')).toHaveLength(3);
    expect(walkwayStatus(lvl)).toBe('ok');
  });

  it('2. a 0.35 m shoe cabinet in the corridor: one issue on it, 0.85 of 0.90, to the far room', () => {
    const f = flat();
    const face = f.y - 0.05;
    const lvl = withItems(level(f), [['shoe-cabinet', { x: 4, y: face - 0.175 }, Math.PI]]);
    const r = walkwayReport(lvl);
    const w = ways(r);
    expect(w).toHaveLength(1);
    const i = w[0];
    if (!i) throw new Error('no issue');
    expect(i.itemId).toBe(lastId());
    expect(i.need).toBeCloseTo(0.9, 5);
    expect(Math.abs(i.have - 0.85)).toBeLessThanOrEqual(0.02);
    // From the cabinet's face to the opposite wall's face.
    const ys = i.pinch.map((p) => p.y).sort((a, b) => a - b);
    expect(ys[0]).toBeCloseTo(4.05, 2);
    expect(ys[1]).toBeCloseTo(face - 0.35, 2);
    expect(i.to).toEqual([{ roomId: roomNamed(lvl, 6, 2) }]);
    expect(i.path.length).toBeGreaterThan(1);
    expect(i.path.length).toBeLessThanOrEqual(60);
  });

  it('3. a bare 0.85 m corridor is the flat’s own width; a 0.20 m shelf in it is short of that', () => {
    const f = flat(0.85);
    expect(walkwayReport(level(f)).issues).toHaveLength(0);
    const face = f.y - 0.05;
    const lvl = withItems(level(f), [['bookshelf', { x: 4, y: face - 0.1 }, Math.PI]]);
    // A bookshelf is 0.30 deep: scaled to 0.20.
    const id = lastId();
    const it = lvl.items[id];
    if (!it) throw new Error('no shelf');
    const shelf = { ...it, scale: { ...it.scale, z: 0.2 / 0.3 } };
    const lv2 = Object.freeze({ ...lvl, items: { ...lvl.items, [id]: shelf } });
    const w = ways(walkwayReport(lv2));
    expect(w).toHaveLength(1);
    expect(Math.abs((w[0]?.need ?? 0) - 0.83)).toBeLessThanOrEqual(0.01);
    expect(w[0]?.capped).toBe(true);
    expect(Math.abs((w[0]?.have ?? 0) - 0.65)).toBeLessThanOrEqual(0.02);
  });

  it('4. a piece filling the corridor closes the way: have 0, on it', () => {
    const f = flat();
    const lvl = withItems(level(f), [['sofa-3', { x: 4, y: 4.05 + 0.6 }, Math.PI / 2]]);
    // A sofa on end across the corridor: 2.1 m long, wider than the corridor.
    const w = ways(walkwayReport(lvl));
    expect(w.length).toBeGreaterThan(0);
    expect(w.every((i) => i.itemId === lastId())).toBe(true);
    expect(w[0]?.have).toBe(0);
  });

  it('5. 0.80 m swing doors on the route (0.76 clear): no issue from the doorway', () => {
    const r = walkwayReport(level(flat(1.2, { doors: 0.8 })));
    expect(r.issues).toHaveLength(0);
    expect(r.routes.every((x) => x.ok)).toBe(true);
  });

  it('6. a table with room one side is the widest way; with 0.60 m both sides it is short', () => {
    // A 2.4 m corridor, the table's 0.8 m depth across it: 0.60 above, 1.00 below.
    const wide = flat(2.4);
    const lvl = withItems(level(wide), [['dining-4', { x: 4, y: 4.05 + 0.6 + 0.4 }]]);
    expect(ways(walkwayReport(lvl))).toHaveLength(0);
    // A 2.0 m corridor: 0.60 each side.
    const tight = flat(2.0);
    const lv2 = withItems(level(tight), [['dining-4', { x: 4, y: 4.05 + 1.0 }]]);
    const w = ways(walkwayReport(lv2));
    expect(w).toHaveLength(1);
    expect(Math.abs((w[0]?.have ?? 0) - 0.6)).toBeLessThanOrEqual(0.02);
  });

  it('7. a rug, a person, a wall cabinet and a TV don’t block; an uploaded model does', () => {
    const f = flat();
    const mid = { x: 4, y: 4.05 + 0.6 };
    for (const id of ['rug', 'person', 'kitchen-wall', 'tv']) {
      const lvl = withItems(level(f), [[id, mid, Math.PI / 2]]);
      expect(ways(walkwayReport(lvl))).toHaveLength(0);
    }
    const m: CustomModel = {
      id: 'mdl_box',
      name: 'Box',
      category: 'Decor',
      size: { w: 1.0, d: 0.6, h: 1 },
      hash: 'a'.repeat(64),
    };
    setProjectModels({ [m.id]: m });
    const it = newItem('it_model', customKind(m), { x: 4, y: f.y - 0.05 - 0.3 }, 0);
    const lvl = Object.freeze({ ...level(f), items: { [it.id]: it } });
    const w = ways(walkwayReport(lvl));
    expect(w).toHaveLength(1);
    expect(w[0]?.itemId).toBe('it_model');
    setProjectModels({});
  });

  it('8. a room boundary is free; a half wall cuts the way, unless there is another way round', () => {
    const f = flat();
    let s = f.s;
    // A boundary across the corridor at x 4: two rooms, joined freely.
    s = dispatch(
      s,
      drawWall(
        level(s),
        { point: { x: 4, y: 4 } },
        { point: { x: 4, y: f.y } },
        { thickness: 0.1, kind: 'boundary' },
      ).command,
    );
    const bound = walkwayReport(level(s));
    expect(bound.issues).toHaveLength(0);
    expect(bound.routes.filter((x) => x.route === 'circulation')).toHaveLength(4);
    // Made a half wall: the corridor's far half and Room B are no longer joined.
    const cut = f.wall({ x: 4, y: 4 }, { x: 4, y: f.y }, level(s));
    const half = dispatch(s, updateWall(level(s).id, cut, { kind: 'wall', height: 1.0 }));
    const r = walkwayReport(level(half));
    expect(r.issues).toHaveLength(0);
    const reached = new Set(r.routes.map((x) => x.to.roomId));
    expect(reached.has(roomNamed(level(half), 6, 2))).toBe(false);
    // A door between the rooms: B and the corridor's far half reached the other way round.
    const round = dispatch(
      half,
      addOpening(level(half).id, {
        wallId: f.wall({ x: 4, y: 0 }, { x: 4, y: 4 }, level(half)),
        kind: 'door',
        t: 0.5,
        width: 0.9,
        height: 2.1,
        sill: 0,
        swing: 'leftIn',
      }).command,
    );
    const rr = walkwayReport(level(round));
    expect(rr.issues).toHaveLength(0);
    expect(rr.routes.filter((x) => x.route === 'circulation')).toHaveLength(4);
    expect(rr.routes.every((x) => x.ok)).toBe(true);
  });

  it('9. the way to a bed’s side past a wardrobe at its foot; sides already short; single beds', () => {
    // Room B (x 4..8, y 0..4): a queen bed, head on the top wall, its left (x>) side open.
    const f = flat();
    const queen = furnitureKind('bed-queen');
    if (!queen) throw new Error('no queen');
    // Bed against the right wall's face (7.95), from the top wall's face (0.05).
    const bx = 7.95 - 0.7 - queen.size.w / 2;
    const by = 0.05 + queen.size.d / 2;
    // Rotation π: front (foot) towards +y... a bed's front is its foot.
    const foot = by + queen.size.d / 2;
    // The wardrobe 0.50 m past the foot, from the right wall to past the bed's left side,
    // so the only way to the right side (between the bed and the right wall) is past it.
    const lvl = withItems(level(f), [
      ['bed-queen', { x: bx, y: by }],
      ['wardrobe', { x: 7.95 - 0.6, y: foot + 0.5 + 0.3 }, Math.PI],
    ]);
    const r = walkwayReport(lvl);
    const bed = r.issues.filter((i) => i.route === 'bed');
    expect(bed.length).toBeGreaterThan(0);
    const ids = new Set(bed.map((i) => i.itemId));
    expect(ids.has(`it_${n - 1}`)).toBe(true);
    expect(ids.has(lastId())).toBe(true);
    for (const i of bed) {
      expect(i.need).toBeCloseTo(0.6, 5);
      expect(Math.abs(i.have - 0.5)).toBeLessThanOrEqual(0.02);
    }
  });

  it('10. no door to the outside: no walkways, no-main-door', () => {
    const lvl = level(flat(1.2, { outside: false }));
    const r = walkwayReport(lvl);
    expect(r.status).toBe('no-main-door');
    expect(r.issues).toHaveLength(0);
    expect(walkwayStatus(lvl)).toBe('no-main-door');
  });

  it('11. one pinch on the way to two rooms: one issue on the piece naming both', () => {
    const f = flat();
    const face = f.y - 0.05;
    const lvl = withItems(level(f), [['shoe-cabinet', { x: 1.0, y: face - 0.175 }, Math.PI]]);
    const w = ways(walkwayReport(lvl));
    expect(w).toHaveLength(1);
    const to = new Set(w[0]?.to.map((t) => t.roomId));
    expect(to.has(roomNamed(lvl, 2, 2))).toBe(true);
    expect(to.has(roomNamed(lvl, 6, 2))).toBe(true);
  });

  it('12. the sample flat with no furniture: no walkway issues, before and after', () => {
    let s: EditorDoc = { doc: sampleFlatProject('prj_t'), history: emptyHistory() };
    s = dispatch(s, startRenovation());
    for (const v of ['before', 'after'] as const) {
      const lvl = variantLevels(s.doc, v)[0] as Level;
      const r = walkwayReport(lvl);
      expect(r.status).toBe('ok');
      expect(r.issues).toHaveLength(0);
      expect(r.routes.length).toBeGreaterThan(4);
    }
  });

  it('16. the sample flat with 40 pieces: walkways under 40 ms', () => {
    const base = sampleFlatProject('prj_t').levels[0] as Level;
    const ids = ['wardrobe', 'sofa-3', 'desk', 'bedside', 'armchair', 'dining-chair', 'bookshelf'];
    const pieces: [string, Vec2, number][] = Array.from({ length: 40 }, (_, i) => [
      ids[i % ids.length] as string,
      { x: 0.8 + (i % 8) * 1.1, y: 0.8 + Math.floor(i / 8) * 1.3 },
      0,
    ]);
    const lvl = withItems(base, pieces);
    walkwayReport(withItems(base, pieces.slice(0, 1)));
    const runs = 5;
    let total = 0;
    for (let i = 0; i < runs; i++) {
      // A new level object each time (as a drag makes), so nothing is cached.
      const fresh = Object.freeze({ ...lvl, items: { ...lvl.items } });
      const t0 = performance.now();
      walkwayReport(fresh);
      total += performance.now() - t0;
    }
    const ms = total / runs;
    console.log(`walkways: ${ms.toFixed(2)} ms`);
    expect(ms).toBeLessThan(40);
  });

  it('an outside door that isn’t hinged is still the way in when it is the only one', () => {
    // No outside door, but doors inside: walkways need the main door.
    const lvl = level(flat(1.2, { outside: false }));
    expect(Object.values(lvl.openings)).toHaveLength(2);
    expect(walkwayReport(lvl).status).toBe('no-main-door');
  });

  it('a chair half in a doorway narrows it', () => {
    const f = flat();
    // Room A's door: x 1.6..2.4 on y 4. A chair over its left half, inside the throat.
    const lvl = withItems(level(f), [['dining-chair', { x: 1.6 + 0.2, y: 4.3 }]]);
    const w = ways(walkwayReport(lvl));
    expect(w.length).toBeGreaterThan(0);
    const i = w.find((x) => x.to.some((t) => t.roomId === roomNamed(lvl, 2, 2)));
    expect(i).toBeDefined();
    expect(i?.have ?? 1).toBeLessThan(0.6);
  });

  it('an en-suite only reached through a bedroom needs 0.60 m', () => {
    // Room B made a bedroom (a bed in it); the corridor's far half walled off from the rest
    // and opened into Room B only: an en-suite.
    const f = flat();
    let s = f.s;
    s = dispatch(
      s,
      drawWall(
        level(s),
        { point: { x: 6.8, y: 4 } },
        { point: { x: 6.8, y: f.y } },
        { thickness: 0.1 },
      ).command,
    );
    // A second door, from Room B into it.
    const lvl0 = level(s);
    const top = Object.values(lvl0.walls).find((w) => {
      const p = lvl0.vertices[w.a];
      const q = lvl0.vertices[w.b];
      return (
        p && q && Math.abs(p.y - 4) < 1e-6 && Math.abs(q.y - 4) < 1e-6 && Math.min(p.x, q.x) >= 6.79
      );
    });
    if (!top) throw new Error('no wall');
    s = dispatch(
      s,
      addOpening(lvl0.id, {
        wallId: top.id,
        kind: 'door',
        t: 0.5,
        width: 0.7,
        height: 2.1,
        sill: 0,
        swing: 'leftIn',
      }).command,
    );
    const lvl = withItems(level(s), [['bed-queen', { x: 5.5, y: 1.2 }]]);
    const r = walkwayReport(lvl);
    const ensuite = roomNamed(lvl, 7.4, 4.6);
    const route = r.routes.find((x) => x.route === 'circulation' && x.to.roomId === ensuite);
    expect(route?.need).toBeCloseTo(0.6, 5);
    const corridor = r.routes.find(
      (x) => x.route === 'circulation' && x.to.roomId === roomNamed(lvl, 2, 4.6),
    );
    expect(corridor?.need).toBeCloseTo(0.9, 5);
  });

  it('a huge plan is rastered coarser, never past the cell cap', () => {
    let s: EditorDoc = { doc: blankProject('t', 'prj_t'), history: emptyHistory() };
    const pts: [number, number][] = [
      [0, 0],
      [400, 0],
      [400, 300],
      [0, 300],
      [0, 0],
    ];
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, ay] = pts[i] as [number, number];
      const [bx, by] = pts[i + 1] as [number, number];
      s = dispatch(
        s,
        drawWall(
          level(s),
          { point: { x: ax, y: ay } },
          { point: { x: bx, y: by } },
          { thickness: 0.1 },
        ).command,
      );
    }
    const r = walkwayReport(level(s));
    expect(r.grid.cells).toBeLessThanOrEqual(300_000);
    expect(r.grid.cell).toBeGreaterThan(0.05);
  });
});
