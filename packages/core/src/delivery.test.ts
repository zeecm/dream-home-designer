import { describe, expect, it } from 'vitest';
import { setLift } from './commands';
import {
  LIFT_PRESETS,
  clearWidth,
  deliveryCheck,
  diagonalFits,
  diagonalRange,
  liftFit,
  mainDoors,
  rectFits,
  rigidNote,
  turnLimit,
} from './delivery';
import { blankProject } from './factory';
import { sampleFlatProject } from './fixtures/sampleFlat';
import { customKind, newItem, setProjectModels, updateModel } from './furniture';
import { type EditorDoc, dispatch, emptyHistory, undo } from './history';
import { loadErrorText, loadProject, migrate } from './migrate';
import {
  CustomModel,
  DEFAULT_SITE,
  type Level,
  Lift,
  type Opening,
  Project,
  parseProject,
} from './schema';

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

  it('a sofa diagonal is between the corner height and the shorter of depth and height', () => {
    const r = diagonalRange(1.0, 0.95);
    expect(r.min).toBeCloseTo(0.689, 3);
    expect(r.max).toBeCloseTo(0.95);
    expect(diagonalFits(0.8, 1.0, 0.95)).toBe(true);
    expect(diagonalFits(1.5, 1.0, 0.95)).toBe(false);
    // 5 mm either side is a measurement, not a mistake; more is.
    expect(diagonalFits(0.954, 1.0, 0.95)).toBe(true);
    expect(diagonalFits(0.96, 1.0, 0.95)).toBe(false);
    expect(diagonalFits(0.685, 1.0, 0.95)).toBe(true);
    expect(diagonalFits(0.68, 1.0, 0.95)).toBe(false);
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

  it('a balcony’s sliding door to the outside isn’t the main door; a room with no door is unreachable', () => {
    const { level, id } = withPiece({ w: 0.8, d: 0.6, h: 0.7 }, 'rm_bedroom');
    const main = 'op_door_living-and-dining_outside-3';
    const wallId = level.openings[main]?.wallId as string;
    const balcony: Opening = {
      ...door(1.8, { style: 'sliding', panels: 2 }),
      id: 'op_balc',
      wallId,
      t: 0.8,
    };
    const withBalcony = { ...level, openings: { ...level.openings, op_balc: balcony } };
    expect(mainDoors(withBalcony)[0]).toBe(main);
    // The bedroom with its door taken out: no way in.
    const shut = { ...level.openings };
    delete shut['op_door_bedroom_living-and-dining-3'];
    expect(deliveryCheck({ ...level, openings: shut }, id).status).toBe('unreachable');
  });
});

describe('the lift (slice-2s B1)', () => {
  const { typical, older, large } = LIFT_PRESETS;
  const fit = (w: number, d: number, h: number, lift: Lift, diagonal?: number) =>
    liftFit({ w, d, h }, diagonal, lift);

  it('1: rectFits, square or at an angle', () => {
    expect(rectFits(1.6, 0.05, 1.2, 1.2)).toBe(true);
    expect(rectFits(1.6, 0.2, 1.2, 1.2)).toBe(false);
    expect(rectFits(1.0, 0.95, 1.1, 1.4)).toBe(true);
    expect(rectFits(1.3, 1.3, 2.0, 1.2)).toBe(false);
    // Either order of each pair.
    expect(rectFits(0.05, 1.6, 1.2, 1.2)).toBe(true);
    expect(rectFits(0.95, 1.0, 1.4, 1.1)).toBe(true);
  });

  it('2: a 2.1 m sofa: too wide for the door; on its diagonal it clears it but can’t be stood up', () => {
    const plain = fit(2.1, 1.0, 0.95, typical);
    expect(plain).toMatchObject({ fit: 'too-big', fails: 'door' });
    expect(plain.need).toBeCloseTo(0.95);
    const tilted = fit(2.1, 1.0, 0.95, typical, 0.8);
    expect(tilted).toMatchObject({ fit: 'too-big', fails: 'car' });
    // Tipped on its diagonal it is 1.38 m thick: the door and the car's depth stand up 1.92 m.
    expect(tilted.standUp?.need).toBeCloseTo(2.1);
    expect(tilted.standUp?.allows).toBeCloseTo(1.92, 2);
    expect(tilted.standUp).toMatchObject({ door: 2.0, room: 1.4, side: 'depth' });
    expect(turnLimit(2.0, 1.4, Math.hypot(1.0, 0.95))).toBeCloseTo(1.92, 2);
    // A 1.8 m sofa: too wide at the door without its diagonal; with it, on end.
    expect(fit(1.8, 1.0, 0.95, typical)).toMatchObject({ fit: 'too-big', fails: 'door' });
    const short = fit(1.8, 1.0, 0.95, typical, 0.8);
    expect(short).toMatchObject({ fit: 'fits', how: 'end', tilted: true });
    expect(Math.abs(short.spare - 0.1)).toBeLessThanOrEqual(0.005);
  });

  it('an older lift is too shallow to stand the 2.1 m sofa up at all: no length to quote', () => {
    // Tipped on its diagonal it is 1.38 m thick; the car is 1.25 m deep.
    expect(turnLimit(2.0, 1.25, Math.hypot(1.0, 0.95))).toBe(0);
    const r = fit(2.1, 1.0, 0.95, older, 0.8);
    expect(r).toMatchObject({ fit: 'too-big', fails: 'car' });
    expect(r.standUp).toBeUndefined();
  });

  it('tilted across the depth, a piece is stood up in the car’s width, not its depth', () => {
    const wide: Lift = {
      preset: 'measured',
      door: { width: 0.9, height: 2.6 },
      car: { width: 3.0, depth: 0.8, height: 3.0 },
    };
    // 3.1 m leans in the 3.0 × 3.0 plane across the car; turned up in its depth (0.8 m) it
    // would stop at 2.77 m, but it turns in its width.
    expect(turnLimit(2.6, 0.8, 0.75)).toBeLessThan(3.1);
    expect(fit(0.75, 0.75, 3.1, wide)).toMatchObject({ fit: 'tight', how: 'tilted' });
  });

  it('the presets are frozen: shared, never changed by a caller', () => {
    expect(Object.isFrozen(LIFT_PRESETS)).toBe(true);
    expect(Object.isFrozen(typical.door)).toBe(true);
  });

  it('3: a 2.0 m sofa: too wide for an older lift’s door; on end in a typical one', () => {
    const o = fit(2.0, 0.9, 0.85, older);
    expect(o).toMatchObject({ fit: 'too-big', fails: 'door' });
    expect(o.need).toBeCloseTo(0.85);
    expect(fit(2.0, 0.9, 0.85, typical)).toMatchObject({ fit: 'fits', how: 'end' });
    expect(fit(2.0, 0.9, 0.85, typical).tilted).toBeUndefined();
  });

  it('4: a 2.4 m sofa clears a typical door but not the car', () => {
    const r = fit(2.4, 0.95, 0.9, typical);
    expect(r).toMatchObject({ fit: 'too-big', fails: 'car' });
    expect(r.standUp).toBeUndefined();
  });

  it('5: a 2.4 m box: not in a typical car; tilted, at an angle, in a large one (tight)', () => {
    expect(fit(0.6, 0.6, 2.4, typical)).toMatchObject({ fit: 'too-big', fails: 'car' });
    // At an angle there's nothing to spare that can be counted on.
    expect(fit(0.6, 0.6, 2.4, large)).toMatchObject({ fit: 'tight', how: 'tilted', spare: 0 });
  });

  it('6: a 1.8 m box goes in an older lift as it stands', () => {
    const r = fit(0.7, 0.7, 1.8, older);
    expect(r).toMatchObject({ fit: 'fits', how: 'upright' });
    expect(r.spare).toBeCloseTo(0.1);
  });

  it('on its back, preferring a pose with room to spare; under 20 mm is tight', () => {
    // 1.3 × 1.2 doesn't fit the 1.4 × 1.1 floor; on its back, 1.3 × 0.6 does.
    expect(fit(1.3, 1.2, 0.6, typical)).toMatchObject({ fit: 'fits', how: 'back' });
    // At best 0.89 m across the 0.90 m door: 10 mm to spare.
    const tight = fit(0.89, 0.89, 1.6, typical);
    expect(tight).toMatchObject({ fit: 'tight', how: 'upright' });
    expect(tight.spare).toBeCloseTo(0.01);
  });

  it('7: the lift is first on the way in and counts in the worst; without it nothing changes', () => {
    const big = withPiece({ w: 2.1, d: 1.0, h: 0.95 }, 'rm_living-and-dining');
    const without = deliveryCheck(big.level, big.id);
    expect(['fits', 'tight']).toContain(without.status);
    expect('lift' in without).toBe(false);
    const r = deliveryCheck(big.level, big.id, { lift: typical });
    expect(r.status).toBe('too-big');
    if (r.status !== 'too-big') return;
    expect(r.doors[0]).toMatchObject({
      openingId: 'lift',
      clear: 0.9,
      height: 2.0,
      fit: 'too-big',
    });
    expect(r.doors[0]?.need).toBeCloseTo(0.95);
    expect(r.worst?.openingId).toBe('lift');
    expect(r.lift).toMatchObject({ fit: 'too-big', fails: 'door' });
    expect(r.doors.slice(1)).toEqual('doors' in without ? without.doors : []);
    // A lift it fits: on the way, and the rest as without.
    const small = withPiece({ w: 0.8, d: 0.6, h: 0.7 }, 'rm_bedroom');
    const s = deliveryCheck(small.level, small.id, { lift: typical });
    expect(s.status).toBe('fits');
    if (s.status !== 'fits') return;
    expect(s.lift).toMatchObject({ fit: 'fits', how: 'upright' });
    expect(s.doors[0]?.openingId).toBe('lift');
    // No main door: the lift isn't judged.
    expect(deliveryCheck({ ...small.level, openings: {} }, small.id, { lift: typical })).toEqual({
      status: 'no-door',
    });
  });

  it('a bed bends a little: the catalogue’s and one by size get a note; a sofa doesn’t', () => {
    expect(rigidNote('bed-queen')).toMatch(/^A mattress bends/);
    const m: CustomModel = {
      id: 'mdl_bed',
      name: 'Our bed',
      category: 'Bedroom',
      size: { w: 1.6, d: 2.0, h: 1.0 },
      shape: 'bed',
    };
    setProjectModels({ [m.id]: m });
    expect(rigidNote('mdl_bed')).toMatch(/ask the shop\.$/);
    expect(rigidNote('sofa-3')).toBeNull();
    setProjectModels(undefined);
  });

  it('8: schema 10: a v9 document parses with no lift; limits; the door within the car', () => {
    const doc = { ...sampleFlatProject('prj_t'), schemaVersion: 9 };
    const p = parseProject(migrate(doc));
    expect(p.schemaVersion).toBe(10);
    expect(p.site?.lift).toBeUndefined();
    const bad = (patch: (l: Lift) => Lift) => Lift.safeParse(patch(structuredClone(typical)));
    expect(bad((l) => ({ ...l, car: { ...l.car, width: 0.5 } })).success).toBe(false);
    expect(bad((l) => ({ ...l, door: { ...l.door, width: 1.2 } })).success).toBe(false);
    expect(
      bad((l) => ({ ...l, door: { ...l.door, height: 2.4 }, car: { ...l.car, height: 2.3 } }))
        .success,
    ).toBe(false);
    expect(bad((l) => l).success).toBe(true);
    for (const l of Object.values(LIFT_PRESETS)) expect(Lift.safeParse(l).success).toBe(true);
  });

  it('a file with impossible lift sizes says so in words, not zod’s JSON', () => {
    const why = (lift: unknown) => {
      const doc = { ...sampleFlatProject('prj_t'), site: { ...DEFAULT_SITE, lift } };
      try {
        loadProject(JSON.parse(JSON.stringify(doc)));
      } catch (e) {
        return loadErrorText(e);
      }
      return 'loaded';
    };
    expect(why({ ...typical, door: { width: 1.2, height: 2.0 } })).toBe(
      'That file’s lift sizes aren’t valid (the door is wider or taller than the car).',
    );
    expect(why({ ...typical, car: { ...typical.car, width: 0.5 } })).toMatch(
      /^That file’s lift sizes aren’t valid \(car width under 0\.80 m/,
    );
    expect(why(null)).toBe('loaded');
    expect(loadErrorText(new SyntaxError('x'))).toBe(
      'That file isn’t a Dream Home project (it isn’t JSON).',
    );
    let other = '';
    try {
      loadProject({ ...sampleFlatProject('prj_t'), name: '' });
    } catch (e) {
      other = loadErrorText(e);
    }
    expect(other).toMatch(/^That file isn’t a Dream Home project, or it is damaged \(name: /);
  });

  it('8: setLift is one undo step, including the site it made; null is no lift, undefined unset', () => {
    let s = { doc: blankProject('t', 'prj_t'), history: emptyHistory() };
    expect(s.doc.site).toBeUndefined();
    s = dispatch(s, setLift(typical));
    expect(s.doc.site?.lift).toEqual(typical);
    expect(s.doc.site?.north).toBe(0);
    expect(() => Project.parse(s.doc)).not.toThrow();
    expect(undo(s).doc.site).toBeUndefined();
    s = dispatch(s, setLift(null));
    expect(s.doc.site?.lift).toBeNull();
    expect(() => Project.parse(s.doc)).not.toThrow();
    s = dispatch(s, setLift(undefined));
    expect(s.doc.site && 'lift' in s.doc.site).toBe(false);
    expect(undo(s).doc.site?.lift).toBeNull();
    // A measured lift with the door wider than the car is refused, before any change.
    expect(() =>
      setLift({ ...typical, preset: 'measured', door: { width: 1.2, height: 2.0 } }),
    ).toThrow();
  });
});

describe('a diagonal you can edit (slice-2s B2)', () => {
  it('1: updateModel sets 0.80, removes it with null; undo restores; the pieces re-check', () => {
    const { level, id } = withPiece({ w: 2.1, d: 1.0, h: 0.95 }, 'rm_bedroom');
    const base = sampleFlatProject('prj_t');
    const model: CustomModel = {
      id: 'mdl_sofa',
      name: 'My sofa',
      category: 'Living',
      size: { w: 2.1, d: 1.0, h: 0.95 },
      shape: 'sofa',
    };
    let s: EditorDoc = {
      doc: { ...base, models: { mdl_sofa: model }, levels: [level] },
      history: emptyHistory(),
    };
    const check = () => {
      setProjectModels(s.doc.models);
      return deliveryCheck(s.doc.levels[0] as Level, id).status;
    };
    expect(check()).toBe('too-big');
    s = dispatch(s, updateModel('mdl_sofa', { diagonal: 0.8 }));
    expect(s.doc.models?.mdl_sofa?.diagonal).toBe(0.8);
    expect(['fits', 'tight']).toContain(check());
    s = dispatch(s, updateModel('mdl_sofa', { diagonal: null }));
    expect(s.doc.models?.mdl_sofa && 'diagonal' in s.doc.models.mdl_sofa).toBe(false);
    expect(check()).toBe('too-big');
    s = undo(s);
    expect(s.doc.models?.mdl_sofa?.diagonal).toBe(0.8);
    expect(['fits', 'tight']).toContain(check());
    expect(() => Project.parse(s.doc)).not.toThrow();
    expect(() => updateModel('mdl_sofa', { diagonal: 0 })).toThrow();
    setProjectModels(undefined);
  });

  it('2: a door passed only by the diagonal carry is tilted; one passed square is not', () => {
    const tilted = withPiece({ w: 2.1, d: 1.0, h: 0.95 }, 'rm_bedroom', 0.8);
    const r = deliveryCheck(tilted.level, tilted.id);
    if (!('doors' in r)) throw new Error(r.status);
    const bedroom = r.doors.find((d) => d.openingId === 'op_door_bedroom_living-and-dining-3');
    expect(bedroom?.tilted).toBe(true);
    expect(r.doors[0]?.tilted).toBeUndefined(); // the main door takes it square
    const small = withPiece({ w: 0.8, d: 0.6, h: 0.7 }, 'rm_bedroom', 0.5);
    const q = deliveryCheck(small.level, small.id);
    if (!('doors' in q)) throw new Error(q.status);
    expect(q.doors.some((d) => d.tilted)).toBe(false);
  });
});
