import { describe, expect, it } from 'vitest';
import {
  addOpening,
  deleteWall,
  drawWall,
  updateOpening,
  updateRoom,
  updateWall,
} from './commands';
import { TYPICAL_RATES, costEstimate, footRun, levelNames, projectEstimate } from './cost';
import { blankProject } from './factory';
import { sampleFlatProject } from './fixtures/sampleFlat';
import { TWO_LEVELS_TOTAL, twoLevelProject } from './fixtures/twoLevels';
import { furnitureKind, newItem } from './furniture';
import { type EditorDoc, dispatch, emptyHistory } from './history';
import { AFTER_SUFFIX } from './levels';
import { startRenovation } from './renovation';
import type { Level } from './schema';
import { wallStatuses } from './structural';

/** A w × d room (to the walls' centre lines, as HDB areas are), walls 100 mm, and walls drawn after. */
function room(w: number, d: number, extra: [number, number, number, number][] = []): EditorDoc {
  let s: EditorDoc = { doc: blankProject('t', 'prj_t'), history: emptyHistory() };
  const h = 0;
  const pts: [number, number][] = [
    [-h, -h],
    [w + h, -h],
    [w + h, d + h],
    [-h, d + h],
    [-h, -h],
  ];
  const segs: [number, number, number, number][] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay] = pts[i] as [number, number];
    const [bx, by] = pts[i + 1] as [number, number];
    segs.push([ax, ay, bx, by]);
  }
  for (const [ax, ay, bx, by] of [...segs, ...extra]) {
    const lvl = s.doc.levels[0] as Level;
    s = dispatch(
      s,
      drawWall(lvl, { point: { x: ax, y: ay } }, { point: { x: bx, y: by } }, { thickness: 0.1 })
        .command,
    );
  }
  return s;
}
const flat = (s: EditorDoc) => s.doc.levels[0] as Level;
const reno = (s: EditorDoc) => s.doc.renovation?.levels[0] as Level;
const A = (s: EditorDoc) => `${flat(s).id}${AFTER_SUFFIX}`;
const R = TYPICAL_RATES;
const to10 = (v: number) => Math.round(v / 10) * 10;

/** The partition (the wall at x = 2). */
const partition = (l: Level) =>
  Object.values(l.walls).find((w) => {
    const a = l.vertices[w.a];
    const b = l.vertices[w.b];
    return a && b && Math.abs(a.x - 2) < 1e-6 && Math.abs(b.x - 2) < 1e-6;
  })?.id as string;

describe('cost estimate', () => {
  it('foot runs: to the nearest foot, at least one', () => {
    expect(footRun(1.8)).toBe(6);
    expect(footRun(2.4)).toBe(8);
    expect(footRun(0.45)).toBe(1);
  });

  it('a wall hacked: by the metre, with debris once', () => {
    let s = dispatch(room(4, 4, [[2, 0, 2, 2]]), startRenovation());
    s = dispatch(s, deleteWall(A(s), partition(reno(s)), reno(s)));
    const est = costEstimate(flat(s), reno(s), R);
    const hack = est.lines.filter((l) => l.label === 'Hack wall');
    expect(hack).toHaveLength(1);
    const h = hack[0];
    if (!h) throw new Error('no hack');
    expect(h.low).toBe(to10(h.qty * 130));
    expect(h.high).toBe(to10(h.qty * 200));
    expect(est.lines.filter((l) => l.label === 'Debris disposal')).toHaveLength(1);
  });

  it('a glass partition and a half wall with glass above', () => {
    const base = dispatch(room(4, 4, [[2, 0, 2, 2.4]]), startRenovation());
    const glass = dispatch(
      base,
      updateWall(A(base), partition(reno(base)), { build: 'glass', thickness: 0.08 }),
    );
    const g = costEstimate(flat(glass), reno(glass), R).lines.find(
      (l) => l.label === 'Glass partition',
    );
    expect(g?.low).toBe(to10((g?.qty ?? 0) * 700));
    const half = dispatch(
      base,
      updateWall(A(base), partition(reno(base)), { height: 1, glassAbove: true }),
    );
    const labels = costEstimate(flat(half), reno(half), R).lines.map((l) => l.label);
    // Cut down from the wall that was there: hacked above and glazed, not built anew.
    expect(labels).toContain('Hack wall');
    expect(labels).not.toContain('Half wall');
    expect(labels).toContain('Fixed glass above');
  });

  it('a floor refinished in vinyl, by the square metre', () => {
    let s = dispatch(room(4, 4), startRenovation());
    const roomId = Object.keys(reno(s).rooms)[0] as string;
    s = dispatch(s, updateRoom(A(s), roomId, { floorMaterial: 'vinyl-ash' }));
    const f = costEstimate(flat(s), reno(s), R).lines.find((l) => l.group === 'Floors');
    expect(f?.qty).toBeCloseTo(16, 1);
    expect(f?.low).toBe(to10((f?.qty ?? 0) * 45));
  });

  it('built-ins by the foot run; a base run with its countertop; unchanged ones not priced', () => {
    const s0 = room(4, 4);
    const ward = furnitureKind('built-in-wardrobe');
    const run = furnitureKind('built-in-kitchen-base');
    if (!ward || !run) throw new Error('no built-ins');
    const items = {
      w: newItem('w', ward, { x: 1, y: 0.3 }),
      k: newItem('k', run, { x: 2, y: 3.7 }, Math.PI),
    };
    const lvl = { ...flat(s0), items };
    const est = costEstimate(lvl, undefined, R);
    const wl = est.lines.find((l) => l.label === 'Built-in wardrobe');
    expect(wl).toMatchObject({ qty: 6, unit: 'ft run', low: 1200, high: 2100 });
    const top = est.lines.find((l) => l.label === 'Countertop');
    expect(top?.qty).toBe(8);
    // No renovation: carpentry and painting only.
    expect(new Set(est.lines.map((l) => l.group))).toEqual(
      new Set(['Painting', 'Carpentry', 'Contingency']),
    );
    // In a renovation, unchanged built-ins aren't priced; one made wider is.
    const after = { ...lvl, id: `${lvl.id}${AFTER_SUFFIX}` };
    expect(costEstimate(lvl, after, R).lines.some((l) => l.group === 'Carpentry')).toBe(false);
    const wider = {
      ...after,
      items: { ...items, w: { ...items.w, scale: { ...items.w.scale, x: 2.4 / 1.8 } } },
    };
    const priced = costEstimate(lvl, wider, R).lines.find((l) => l.label === 'Built-in wardrobe');
    expect(priced?.qty).toBe(8);
  });

  it('painting: walls and ceiling of a 3 × 4 m room, 2.6 m high, is 48.4 m²', () => {
    const lvl = { ...flat(room(3, 4)), ceilingHeight: 2.6 };
    const p = costEstimate(lvl, undefined, R).lines.find((l) => l.group === 'Painting');
    expect(p?.qty).toBeCloseTo(48.4, 1);
  });

  it('contingency is 10% and can be left out; edited rates are used', () => {
    const lvl = { ...flat(room(3, 4)), ceilingHeight: 2.6 };
    const est = costEstimate(lvl, undefined, R);
    const c = est.lines.find((l) => l.group === 'Contingency');
    const rest = est.lines.filter((l) => l.group !== 'Contingency');
    expect(c?.low).toBe(to10(rest.reduce((t, l) => t + l.low, 0) * 0.1));
    const off = costEstimate(lvl, undefined, { ...R, contingency: false });
    expect(off.lines.some((l) => l.group === 'Contingency')).toBe(false);
    const dearer = costEstimate(lvl, undefined, { ...R, paint: { low: 10, high: 20 } });
    expect(dearer.low).toBeGreaterThan(est.low);
  });

  it('shelter changes are not priced; structural ones say so', () => {
    let s: EditorDoc = { doc: sampleFlatProject('prj_t'), history: emptyHistory() };
    s = dispatch(s, startRenovation());
    const st = wallStatuses(flat(s));
    const shelter = [...st].find(([, v]) => v === 'shelter')?.[0] as string;
    const structural = [...st].find(([, v]) => v === 'structural')?.[0] as string;
    s = dispatch(s, deleteWall(A(s), shelter, reno(s)));
    s = dispatch(s, deleteWall(A(s), structural, reno(s)));
    const labels = costEstimate(flat(s), reno(s), R).lines.map((l) => l.label);
    expect(labels.filter((l) => l.startsWith('Hack wall (structural)')).length).toBeGreaterThan(0);
    expect(labels.filter((l) => l === 'Hack wall').length).toBe(0);
  });

  it('kitchen modules add up into one run before rounding to feet', () => {
    const s0 = room(4, 4);
    const sink = furnitureKind('kitchen-sink');
    const hob = furnitureKind('kitchen-hob');
    if (!sink || !hob) throw new Error('no cabinets');
    const lvl = {
      ...flat(s0),
      items: { a: newItem('a', sink, { x: 1, y: 0.3 }), b: newItem('b', hob, { x: 1.8, y: 0.3 }) },
    };
    const base = costEstimate(lvl, undefined, R).lines.filter(
      (l) => l.label === 'Kitchen base cabinets',
    );
    expect(base).toHaveLength(1);
    expect(base[0]?.qty).toBe(5);
  });

  it('a door moved: cut, closed up and the door; made a window: a window', () => {
    let s = room(4, 4, [[2, 0, 2, 4]]);
    const wallId = partition(flat(s));
    const d = addOpening(flat(s).id, {
      wallId,
      kind: 'door',
      t: 0.3,
      width: 0.8,
      height: 2.1,
      sill: 0,
      swing: 'leftIn',
    });
    s = dispatch(dispatch(s, d.command), startRenovation());
    expect(reno(s).openings[d.openingId]).toBeTruthy();
    const moved = dispatch(s, updateOpening(A(s), d.openingId, { t: 0.7 }));
    const labels = costEstimate(flat(moved), reno(moved), R).lines.map((l) => l.label);
    expect(labels).toContain('Cut an opening');
    expect(labels).toContain('Close up a door');
    expect(labels).toContain('Swing door');
    const window = dispatch(
      s,
      updateOpening(A(s), d.openingId, { kind: 'window', sill: 0.9, height: 1.2 }),
    );
    expect(costEstimate(flat(window), reno(window), R).lines.map((l) => l.label)).toContain(
      'Window',
    );
  });
});

/** The doc with a copy of its level added above it (ids as they are: they are per level). */
const withUpper = (s: EditorDoc, name = 'Upper'): EditorDoc => {
  const l = flat(s);
  return {
    ...s,
    doc: { ...s.doc, levels: [l, { ...l, id: 'lvl_upper', name, elevation: 2.8 }] },
  };
};
const sumOf = (ls: { low: number; high: number }[]) => ({
  low: ls.reduce((t, l) => t + l.low, 0),
  high: ls.reduce((t, l) => t + l.high, 0),
});

describe('estimate across levels (slice 2s C2)', () => {
  it('1: one level, with and without a renovation, is costEstimate of it', () => {
    let s: EditorDoc = { doc: sampleFlatProject('prj_t'), history: emptyHistory() };
    expect(projectEstimate(s.doc, R)).toEqual(costEstimate(flat(s), undefined, R));
    s = dispatch(s, startRenovation());
    s = dispatch(s, deleteWall(A(s), 'w_bedroom_living-and-dining', reno(s)));
    const est = projectEstimate(s.doc, R);
    expect(est).toEqual(costEstimate(flat(s), reno(s), R));
    expect(est.lines.some((l) => l.label.startsWith('Hack wall'))).toBe(true);
    // One level: no prefix; its lines carry it, and its subtotal is theirs.
    expect(est.lines.find((l) => l.group === 'Painting')?.place).not.toContain(' · ');
    const own = est.lines.filter((l) => l.levelId === flat(s).id);
    expect(est.levels).toEqual([{ id: flat(s).id, name: 'Ground', ...sumOf(own) }]);
    expect(est.unpriced).toEqual([]);
  });

  it('2: two levels with a wardrobe each: two lines, prefixed with the level names', () => {
    const est = projectEstimate(twoLevelProject(), R);
    const wardrobes = est.lines.filter((l) => l.label === 'Built-in wardrobe');
    expect(wardrobes.map((l) => l.place)).toEqual(['Ground · Master bedroom', 'Upper · Bedroom 2']);
    expect(wardrobes.map((l) => l.levelName)).toEqual(['Ground', 'Upper']);
    expect(est.renovation).toBe(false);
    // The by-level rows and the whole home's (here, contingency) add up to every line.
    expect(est.levels.map((l) => l.name)).toEqual(['Ground', 'Upper']);
    const home = est.lines.filter((l) => !l.levelId);
    expect(home.map((l) => l.label)).toEqual(['Contingency (10%)']);
    expect(sumOf([...est.levels, ...home])).toEqual(sumOf(est.lines));
    // The total the e2e suite checks the dialog against.
    expect({ low: est.low, high: est.high }).toEqual(TWO_LEVELS_TOTAL);
  });

  it('lines go level by level within each group, groups in the one-level order', () => {
    const est = projectEstimate(twoLevelProject(), R);
    for (const g of ['Painting', 'Carpentry'] as const) {
      const lv = est.lines.filter((l) => l.group === g).map((l) => l.levelName);
      expect(lv.indexOf('Upper')).toBeGreaterThan(lv.lastIndexOf('Ground'));
    }
    const groups = est.lines.map((l) => l.group);
    expect(groups.lastIndexOf('Painting')).toBeLessThan(groups.indexOf('Carpentry'));
  });

  it('3: a wall hacked on each level: one debris line; contingency is 10% of all lines', () => {
    let s = dispatch(withUpper(room(4, 4, [[2, 0, 2, 2]])), startRenovation());
    for (const i of [0, 1]) {
      const after = s.doc.renovation?.levels[i] as Level;
      s = dispatch(s, deleteWall(after.id, partition(after), after));
    }
    const est = projectEstimate(s.doc, R);
    const hacks = est.lines.filter((l) => l.label === 'Hack wall');
    expect(hacks.map((l) => l.levelName)).toEqual(['Ground', 'Upper']);
    expect(hacks[1]?.place.startsWith('Upper · ')).toBe(true);
    const debris = est.lines.filter((l) => l.label === 'Debris disposal');
    expect(debris).toHaveLength(1);
    expect(debris[0]?.place).toBe('Whole home');
    expect(debris[0]?.levelId).toBeUndefined();
    const c = est.lines.find((l) => l.group === 'Contingency');
    const rest = sumOf(est.lines.filter((l) => l.group !== 'Contingency'));
    expect(c?.low).toBe(to10(rest.low * 0.1));
    expect(c?.high).toBe(to10(rest.high * 0.1));
  });

  it('4: a renovation of level 1 only: level 2 adds nothing and is listed as unpriced', () => {
    const s = dispatch(withUpper(room(4, 4, [[2, 0, 2, 2]])), startRenovation());
    const first = s.doc.renovation?.levels[0] as Level;
    const est = projectEstimate({ ...s.doc, renovation: { levels: [first] } }, R);
    expect(est.lines.some((l) => l.levelId === 'lvl_upper')).toBe(false);
    expect(est.levels.map((l) => l.name)).toEqual(['Ground']);
    expect(est.unpriced).toEqual(['Upper']);
    expect(est.renovation).toBe(true);
    // Still a home of two levels: Ground's places say so.
    expect(est.lines.find((l) => l.group === 'Painting')?.place).toMatch(/^Ground · /);
    // A renovation level renamed on loading (it is no level's copy): nothing is priced.
    const odd = { levels: [{ ...first, id: 'lvl_x~after2' }] };
    const none = projectEstimate({ ...s.doc, renovation: odd }, R);
    expect(none.unpriced).toEqual(['Ground', 'Upper']);
    expect(none.lines).toEqual([]);
  });

  it('a blank or shared level name falls back to "Level n"', () => {
    expect(levelNames([{ name: 'Ground' }, { name: '  ' }])).toEqual(['Ground', 'Level 2']);
    expect(levelNames([{ name: 'Level' }, { name: 'Level' }])).toEqual(['Level 1', 'Level 2']);
    expect(levelNames([{ name: 'Upper' }, { name: 'Upper' }, { name: 'Roof' }])).toEqual([
      'Upper 1',
      'Upper 2',
      'Roof',
    ]);
    // Never one name twice: a made-up name counts on past one a level already has.
    expect(levelNames([{ name: '' }, { name: 'Level 1' }])).toEqual(['Level 2', 'Level 1']);
    expect(levelNames([{ name: 'A' }, { name: 'A' }, { name: 'A 2' }])).toEqual([
      'A 1',
      'A 3',
      'A 2',
    ]);
    expect(levelNames([{ name: '' }, { name: '' }, { name: 'Level 2' }])).toEqual([
      'Level 1',
      'Level 3',
      'Level 2',
    ]);
    const est = projectEstimate(withUpper(room(3, 4), '').doc, R);
    expect(est.levels.map((l) => l.name)).toEqual(['Ground', 'Level 2']);
    expect(est.lines.filter((l) => l.group === 'Painting').map((l) => l.place)).toEqual([
      expect.stringMatching(/^Ground · /),
      expect.stringMatching(/^Level 2 · /),
    ]);
  });

  it('a line in no room is placed on its level, not "Flat"', () => {
    const ward = furnitureKind('built-in-wardrobe');
    if (!ward) throw new Error('no wardrobe');
    const s = withUpper(room(3, 4));
    const [ground, upper] = s.doc.levels as [Level, Level];
    const levels = [ground, { ...upper, items: { w: newItem('w', ward, { x: 9, y: 9 }) } }];
    const est = projectEstimate({ ...s.doc, levels }, R);
    expect(est.lines.find((l) => l.label === 'Built-in wardrobe')?.place).toBe('Upper');
  });
});
