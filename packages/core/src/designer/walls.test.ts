import { describe, expect, it } from 'vitest';
import { levelBounds } from '../geometry';
import { lockedWalls } from '../layouts';
import { renovationBreaches } from '../renovation';
import { aliasesFor } from './aliases';
import unsafeConcept from './fixtures/concept-unsafe.json';
import {
  SAMPLE_KEYS,
  answer,
  parsed,
  sampleConcept,
  sampleDesign,
  sampleLevel,
  tanBrief,
} from './fixtures/sample';
import { wallLocks } from './locks';
import { designResult } from './result';
import { type Concept, type DesignOp, parseConcept } from './schema';
import { roomsBeside } from './spaces';
import { KEEP_TEXT, LOCK_TEXT, applyDesignWalls } from './walls';

const level = sampleLevel();
const aliases = aliasesFor(level);
const op = (o: Partial<DesignOp> & { op: DesignOp['op'] }): DesignOp => ({
  wall: null,
  opening: null,
  a: null,
  b: null,
  height: null,
  t: null,
  width: null,
  style: null,
  ...o,
});
const run = (ops: DesignOp[], walls: 'keep' | 'allowed' | 'structural' = 'allowed') =>
  applyDesignWalls(level, level, ops, walls, aliases, 'dsn_t');
const SHELTER_LINE =
  'Hack the wall between Kitchen and Household shelter: household shelter walls can’t be changed. HDB doesn’t allow it.';

describe('wall locks', () => {
  it('are the walls lockedWalls locks, each with its reason', () => {
    const locks = wallLocks(level);
    expect(new Set(locks.keys())).toEqual(lockedWalls(level));
    expect(locks.get(aliases.W32 as string)).toBe('shelter');
    expect(locks.get(aliases.W12 as string)).toBe('outside');
    expect(locks.get(aliases.W13 as string)).toBe('wet');
    expect(locks.get(aliases.W6 as string)).toBe('structural');
    expect(locks.get(aliases.W10 as string)).toBeUndefined();
  });
});

describe('the concept’s walls (criteria 2–5)', () => {
  it('2: a shelter wall is refused with the HDB line; the rest still apply; no shelter breach', () => {
    const r = run([op({ op: 'remove_wall', wall: 'W32' }), op({ op: 'glass_wall', wall: 'W28' })]);
    expect(r.refused.map((n) => n.text)).toEqual([SHELTER_LINE]);
    expect(r.applied.map((n) => n.text)).toEqual([
      'Make the wall between Kitchen and Dry kitchen a glass partition',
    ]);
    expect(r.level.walls[aliases.W28 as string]?.build).toBe('glass');
    expect(renovationBreaches(level, r.level).shelter.size).toBe(0);
    // Its door, too.
    const door = run([op({ op: 'remove_opening', opening: 'D13' })]);
    expect(door.refused[0]?.text).toMatch(/household shelter walls can’t be changed/);
  });

  it('2: the fixture’s shelter op never reaches the plan', () => {
    const r = designResult(level, level, sampleDesign());
    expect(r.refused.map((n) => n.text)).toContain(
      'Hack the wall between Living and dining and Household shelter: household shelter walls can’t be changed. HDB doesn’t allow it.',
    );
    // The wall stands as it was (its living-room side is papered, a finish).
    const { materialLeft: _, ...w21 } = r.level.walls[aliases.W21 as string]!;
    const { materialLeft: __, ...was } = level.walls[aliases.W21 as string]!;
    expect(w21).toEqual(was);
    expect(renovationBreaches(level, r.level).shelter.size).toBe(0);
  });

  it('3: a structural wall is refused unless the brief allows it, then applied and flagged', () => {
    const hack = op({ op: 'remove_wall', wall: 'W6' });
    const allowed = run([hack]);
    expect(allowed.refused[0]?.text).toBe(
      `Hack the wall between Bedroom and Living and dining: ${LOCK_TEXT.structural}`,
    );
    expect(allowed.refused[0]?.text).toContain('Tick “Also suggest structural changes”');
    const structural = run([hack], 'structural');
    expect(structural.refused).toEqual([]);
    expect(structural.applied[0]?.text).toBe(
      'Hack the wall between Bedroom and Living and dining (structural)',
    );
    expect(structural.structural).toEqual([aliases.W6]);
    expect(structural.level.walls[aliases.W6 as string]).toBeUndefined();
    // Flagged as a problem too.
    const c: Concept = { ...sampleConcept(), walls: [hack] };
    const res = designResult(
      level,
      level,
      sampleDesign({ concept: c, brief: tanBrief({ walls: 'structural' }) }),
    );
    expect(res.problems.some((p) => p.kind === 'structural')).toBe(true);
  });

  it('3: under "keep" every op is refused', () => {
    const r = run(
      [op({ op: 'glass_wall', wall: 'W28' }), op({ op: 'remove_wall', wall: 'W10' })],
      'keep',
    );
    expect(r.refused.map((n) => n.text)).toEqual([KEEP_TEXT, KEEP_TEXT]);
    expect(KEEP_TEXT).toBe('Change any wall: you asked to keep all walls.');
    expect(r.applied).toEqual([]);
    expect(r.level.walls).toEqual(level.walls);
  });

  it('4: outside walls, bathroom walls, windows and the main door stay', () => {
    const r = run([
      op({ op: 'glass_wall', wall: 'W12' }),
      op({ op: 'remove_wall', wall: 'W13' }),
      op({ op: 'remove_opening', opening: 'D2' }),
      op({ op: 'remove_opening', opening: 'D9' }),
    ]);
    expect(r.refused.map((n) => n.text)).toEqual([
      'Make the wall between Living and dining and outside a glass partition: outside walls stay.',
      'Hack the wall between Bath/WC 1 and Main bedroom: bathroom walls stay (wet area).',
      'Close up the window in Bedroom: windows stay.',
      'Close up the door between Living and dining and outside: the main door stays.',
    ]);
    expect(r.applied).toEqual([]);
  });

  it('4: the unsafe fixture: every unsafe op refused, each in words', () => {
    const c = parsed(parseConcept(unsafeConcept, levelBounds(level)));
    const r = run(c.walls);
    const text = r.refused.map((n) => n.text);
    expect(text).toContain(SHELTER_LINE);
    expect(text).toContain('Hack wall W99: there’s no wall “W99” on the plan.');
    expect(text.some((t) => t.endsWith('new walls run along the plan’s axes.'))).toBe(true);
    // The narrow new door is widened to 0.75 m, the least a new door may be.
    expect(r.applied.map((n) => n.text)).toEqual([
      'Add a door to the wall between Living and dining and Bedroom',
    ]);
    const added = Object.values(r.level.openings).filter((o) => !level.openings[o.id]);
    expect(added).toHaveLength(1);
    expect(added[0]?.width).toBeCloseTo(0.75);
    expect(renovationBreaches(level, r.level).shelter.size).toBe(0);
  });

  it('new walls: on the axes, ends snapped onto walls, never through a wet room', () => {
    // A partition across the Bedroom, drawn a little off: straightened and snapped.
    const r = run([op({ op: 'add_wall', a: { x: 3.3, y: 1.62 }, b: { x: 6.45, y: 1.6 } })]);
    expect(r.refused).toEqual([]);
    const fresh = Object.values(r.level.walls).filter((w) => !level.walls[w.id]);
    expect(fresh.length).toBeGreaterThan(0);
    for (const w of fresh) {
      const a = r.level.vertices[w.a]!;
      const b = r.level.vertices[w.b]!;
      expect(Math.min(Math.abs(a.x - b.x), Math.abs(a.y - b.y))).toBeLessThan(1e-9);
    }
    const xs = fresh.flatMap((w) => [r.level.vertices[w.a]!.x, r.level.vertices[w.b]!.x]);
    expect(Math.min(...xs)).toBeCloseTo(3.266, 3);
    expect(Math.max(...xs)).toBeCloseTo(6.495, 3);
    expect(Object.keys(r.level.rooms).length).toBe(Object.keys(level.rooms).length + 1);
    // Ends that meet nothing, and walls in a bathroom, are refused.
    expect(
      run([op({ op: 'add_wall', a: { x: 7, y: 2.5 }, b: { x: 9, y: 2.5 } })]).refused[0]?.text,
    ).toMatch(/its ends must meet existing walls/);
    expect(
      run([op({ op: 'add_wall', a: { x: 0.15, y: 5.2 }, b: { x: 2.397, y: 5.2 } })]).refused[0]
        ?.text,
    ).toMatch(/bathroom/);
  });

  it('5: rooms are named and given uses by alias or by a point after the walls', () => {
    const split = op({ op: 'add_wall', a: { x: 3.27, y: 1.6 }, b: { x: 6.49, y: 1.6 } });
    const c: Concept = {
      ...sampleConcept(),
      walls: [split],
      rooms: [
        {
          room: null,
          at: { x: 4.8, y: 2.4 },
          name: 'Study',
          use: 'study',
          intent: 'Kevin works here.',
          floor: 'vinyl-ash',
          paint: 'paint-grey',
        },
        {
          room: 'R2',
          at: null,
          name: 'Master bedroom',
          use: 'master',
          intent: '',
          floor: 'wood-oak',
          paint: 'paint-warm',
        },
        {
          room: null,
          at: { x: 12.0, y: 3.0 },
          name: 'Nowhere',
          use: 'study',
          intent: '',
          floor: 'wood-oak',
          paint: 'paint-warm',
        },
        {
          room: 'R8',
          at: null,
          name: 'Store room',
          use: 'store',
          intent: '',
          floor: 'concrete',
          paint: 'paint-grey',
        },
      ],
    };
    const r = designResult(level, level, sampleDesign({ concept: c, answers: {} }));
    const names = Object.values(r.level.rooms).map((x) => x.name);
    expect(names).toContain('Study');
    expect(names).toContain('Master bedroom');
    expect(names).toContain('Household shelter');
    expect(names).not.toContain('Store room');
    const study = Object.values(r.level.rooms).find((x) => x.name === 'Study')!;
    expect(r.uses[study.id]).toBe('study');
    expect(study.floorMaterial).toBe('vinyl-ash');
    const text = r.refused.map((n) => n.text);
    expect(text).toContain('Name a room “Nowhere”: there’s no room there after the wall changes.');
    expect(text).toContain(
      'Use the Household shelter as “Store room”: the household shelter stays the shelter.',
    );
    // A bedroom with no window after the walls is a problem (criterion 14 too).
    expect(r.problems.map((p) => p.text)).not.toContain(
      'Study has no window. A bedroom needs one for light and air.',
    );
  });
});

describe('finishes (criterion 16)', () => {
  it('a face finish lands on the side towards its space only; the shelter’s faces stay', () => {
    const r = designResult(level, level, sampleDesign());
    const w21 = r.level.walls[aliases.W21 as string]!;
    const was = level.walls[aliases.W21 as string]!;
    // W21: the living room's side (left) is fluted wood; the shelter's side is as it was.
    expect(w21.materialLeft).toBe('wallpaper-fluted');
    expect(w21.materialRight).toBe(was.materialRight);
    // Of every wall, the side in the shelter is unchanged.
    let shelterFaces = 0;
    for (const w of Object.values(r.level.walls)) {
      const [l, rt] = roomsBeside(r.level, w.id);
      const before = level.walls[w.id];
      if (!before) continue;
      if (l === 'rm_household-shelter') {
        expect(w.materialLeft).toBe(before.materialLeft);
        shelterFaces++;
      }
      if (rt === 'rm_household-shelter') {
        expect(w.materialRight).toBe(before.materialRight);
        shelterFaces++;
      }
    }
    expect(shelterFaces).toBeGreaterThanOrEqual(4);
    const w5 = r.level.walls[aliases.W5 as string]!;
    // W5 between the two bedrooms: each side its own room's feature.
    expect(w5.materialLeft).toBe('wallpaper-linen');
    expect(w5.materialRight).toBe('paint-sage');
  });

  it('an invalid finish becomes the palette’s wall colour, with a note', () => {
    const answers = {
      [SAMPLE_KEYS.kitchen]: answer([], [{ wall: 'W37', finish: 'sage-ish' }]),
    };
    const r = designResult(level, level, sampleDesign({ answers }));
    const w = r.level.walls[aliases.W37 as string]!;
    expect([w.materialLeft, w.materialRight]).toContain('paint-#efe4d2');
    expect(r.dropped.map((n) => n.text)).toContain(
      '“sage-ish” isn’t a paint we have, so the walls are Warm white (#efe4d2).',
    );
    // A wall that isn't the space's isn't painted from it.
    const other = designResult(
      level,
      level,
      sampleDesign({
        answers: { [SAMPLE_KEYS.kitchen]: answer([], [{ wall: 'W4', finish: 'paint-sky' }]) },
      }),
    );
    const w4 = other.level.walls[aliases.W4 as string]!;
    expect([w4.materialLeft, w4.materialRight]).not.toContain('paint-sky');
  });
});
