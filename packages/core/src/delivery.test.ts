import { describe, expect, it } from 'vitest';
import { clearWidth, deliveryCheck, mainDoors, turnLimit } from './delivery';
import { sampleFlatProject } from './fixtures/sampleFlat';
import { customKind, newItem, setProjectModels } from './furniture';
import { migrate } from './migrate';
import { CustomModel, type Level, type Opening, parseProject } from './schema';

const door = (width: number, extra: Partial<Opening> = {}): Opening => ({
  id: 'o',
  wallId: 'w',
  kind: 'door',
  t: 0.5,
  width,
  height: 2.1,
  sill: 0,
  swing: 'leftIn',
  ...extra,
});

/** The sample flat with one of the person's own pieces in a room. */
function withPiece(
  size: { w: number; d: number; h: number },
  room: string,
  diagonal?: number,
): { level: Level; id: string } {
  const p = sampleFlatProject('prj_t');
  const level = p.levels[0] as Level;
  const m: CustomModel = {
    id: 'mdl_sofa',
    name: 'My sofa',
    category: 'Living',
    size,
    shape: 'sofa',
    ...(diagonal ? { diagonal } : {}),
  };
  setProjectModels({ [m.id]: m });
  const r = level.rooms[room];
  if (!r) throw new Error(`no ${room}`);
  // A point well inside the room: its corners' average.
  const pts = r.loop.map((v) => level.vertices[v]).filter((v) => !!v) as { x: number; y: number }[];
  const at = {
    x: pts.reduce((t, q) => t + q.x, 0) / pts.length,
    y: pts.reduce((t, q) => t + q.y, 0) / pts.length,
  };
  const it = newItem('it_sofa', customKind(m), at, 0);
  return { level: { ...level, items: { [it.id]: it } }, id: it.id };
}

describe('the way in', () => {
  it('clear widths by door style', () => {
    expect(clearWidth(door(0.9))).toBeCloseTo(0.86);
    expect(clearWidth(door(1.6, { style: 'double' }))).toBeCloseTo(1.52);
    expect(clearWidth(door(1.8, { style: 'sliding', panels: 2 }))).toBeCloseTo(0.9);
  });

  it('the turn limit round a door', () => {
    expect(turnLimit(0.8, 1.0, 0.6)).toBeCloseTo(1.33, 2);
  });

  it('the main door is the widest door to the outside', () => {
    const level = sampleFlatProject('prj_t').levels[0] as Level;
    expect(mainDoors(level)[0]).toBe('op_door_living-and-dining_outside-3');
  });

  it('a small piece fits all the way into the bedroom', () => {
    const { level, id } = withPiece({ w: 0.8, d: 0.6, h: 0.7 }, 'rm_bedroom');
    const r = deliveryCheck(level, id);
    expect(r.status).toBe('fits');
    if (r.status !== 'fits') return;
    expect(r.doors[0]?.openingId).toBe('op_door_living-and-dining_outside-3');
    expect(r.doors.at(-1)?.openingId).toBe('op_door_bedroom_living-and-dining-3');
  });

  it('a big sofa is too big for the bedroom door, which is named; its diagonal gets it in', () => {
    const big = withPiece({ w: 2.1, d: 1.0, h: 0.95 }, 'rm_bedroom');
    const r = deliveryCheck(big.level, big.id);
    expect(r.status).toBe('too-big');
    if (r.status !== 'too-big') return;
    expect(r.worst?.openingId).toBe('op_door_bedroom_living-and-dining-3');
    expect(r.worst?.need).toBeCloseTo(0.95, 2);
    // Off its hinges (0.90 m) a 0.88 m piece goes.
    const hinge = withPiece({ w: 2.0, d: 0.88, h: 0.95 }, 'rm_bedroom');
    expect(deliveryCheck(hinge.level, hinge.id).status).toBe('hinges');
    // Tilted on a 0.80 m diagonal, the big one goes.
    const tilted = withPiece({ w: 2.1, d: 1.0, h: 0.95 }, 'rm_bedroom', 0.8);
    expect(['fits', 'tight']).toContain(deliveryCheck(tilted.level, tilted.id).status);
  });

  it('a piece taller than any door goes in lying down', () => {
    const tall = withPiece({ w: 0.5, d: 0.5, h: 2.3 }, 'rm_living-and-dining');
    expect(deliveryCheck(tall.level, tall.id).status).toBe('fits');
  });

  it('outside every room: nothing to check; no door: says so', () => {
    const p = withPiece({ w: 0.8, d: 0.6, h: 0.7 }, 'rm_bedroom');
    const it = p.level.items[p.id];
    if (!it) throw new Error('no item');
    const away = { ...p.level, items: { [p.id]: { ...it, position: { ...it.position, x: -20 } } } };
    expect(deliveryCheck(away, p.id).status).toBe('no-room');
    const noDoors = { ...p.level, openings: {} };
    expect(deliveryCheck(noDoors, p.id).status).toBe('no-door');
  });

  it('schema: a piece by size has a shape, an upload a hash; neither is refused', () => {
    const base = { id: 'm', name: 'x', category: 'Living', size: { w: 1, d: 1, h: 1 } };
    expect(CustomModel.safeParse({ ...base, shape: 'box' }).success).toBe(true);
    expect(CustomModel.safeParse({ ...base, hash: 'a'.repeat(64) }).success).toBe(true);
    expect(CustomModel.safeParse(base).success).toBe(false);
    // A version 7 document loads as it was.
    const doc = { ...sampleFlatProject('prj_t'), schemaVersion: 7 };
    expect(() => parseProject(migrate(doc))).not.toThrow();
  });
});
