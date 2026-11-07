import { describe, expect, it } from 'vitest';
import { doorSweep } from '../clearance';
import { withPieces } from '../fixtures/furnishedSample';
import { polygonCentroid } from '../geometry';
import type { Level, Vec2 } from '../schema';
import { type CheckOptions, designChecks } from './checks';
import { answer, sampleDesign, sampleLevel } from './fixtures/sample';
import { peopleOf, sleepingPlan } from './principles';
import { designResult } from './result';
import { type DesignBrief, defaultBrief } from './schema';

/**
 * The design checks (spec docs/specs/ai-designer-v2.md, slice 1, criteria 1–9), on the
 * sample flat, by its wall faces: Main bedroom (x 0.30–3.22, y 0.15–4.27), Bedroom
 * (3.32–6.20, 0.15–3.05), Living and dining (6.50–10.03, 1.65–5.92, with the passage
 * 3.00–6.50 by 3.15–4.27 to the bedrooms), the main door on its south wall.
 */
const PI = Math.PI;
const base = sampleLevel();

/** The Ongs: Rachel and Daniel in Main bedroom, Mdm Koh (a stick) and Sophie in Bedroom. */
function ongs(patch: Partial<DesignBrief> = {}): DesignBrief {
  return {
    ...defaultBrief(),
    household: {
      adults: 2,
      children: ['primary'],
      elders: ['stick'],
      helper: false,
      pets: '',
      text: '',
    },
    names: { 'adult-1': 'Rachel', 'adult-2': 'Daniel', 'child-1': 'Sophie', 'elder-1': 'Mdm Koh' },
    sleeping: {
      'rm_main-bedroom': ['adult-1', 'adult-2'],
      rm_bedroom: ['elder-1', 'child-1'],
    },
    ...patch,
  };
}

const run = (level: Level, opts: Partial<CheckOptions> = {}) =>
  designChecks(level, { brief: ongs(), ...opts });
const keys = (level: Level, opts: Partial<CheckOptions> = {}) => run(level, opts).map((c) => c.key);
const texts = (level: Level, opts: Partial<CheckOptions> = {}) =>
  run(level, opts).map((c) => c.text);
const at = (x: number, y: number): Vec2 => ({ x, y });

/** A queen bed, head on Main bedroom's east wall (it spans y 0.44–1.96). */
const QUEEN: [string, Vec2, number] = ['bed-queen', at(2.216, 1.2), PI / 2];
/**
 * Two singles in Bedroom, heads under the window (a bed is measured at its mattress), the aisle
 * between them, their feet clear of the door.
 */
const SINGLES: [string, Vec2, number][] = [
  ['bed-single', at(3.316 + 0.46, 0.15 + 1.0), 0],
  ['bed-single', at(6.195 - 0.46, 0.15 + 1.0), 0],
];
/** The hard checks in the two bedrooms (on a room, or on a piece in one). */
const inBedrooms = (lvl: Level, opts: Partial<CheckOptions> = {}) =>
  run(lvl, opts).filter((c) => {
    if (!c.hard) return false;
    if (c.roomId) return c.roomId === 'rm_bedroom' || c.roomId === 'rm_main-bedroom';
    const it = c.itemId ? lvl.items[c.itemId] : undefined;
    return !!it && it.position.z < 4.3 && it.position.x < 6.3;
  });

describe('P1: function per room (criteria 1, 2)', () => {
  it('1: only a queen bed in Main bedroom: Mdm Koh and Sophie have no bed, both on Bedroom', () => {
    const cs = run(withPieces(base, [QUEEN]));
    const beds = cs.filter((c) => c.key.startsWith('P1|bed|'));
    expect(beds.map((c) => c.text).sort()).toEqual([
      'Mdm Koh has no bed in Bedroom.',
      'Sophie has no bed in Bedroom.',
    ]);
    expect(beds.every((c) => c.roomId === 'rm_bedroom' && c.hard)).toBe(true);
  });

  it('1: adding two single beds that fit: no hard check fails in either bedroom', () => {
    expect(inBedrooms(withPieces(base, [QUEEN, ...SINGLES])).map((c) => c.text)).toEqual([]);
  });

  it('a bed is measured at its mattress under a window; its headboard is advice', () => {
    const cs = run(withPieces(base, SINGLES));
    const w = cs.filter((c) => c.key.startsWith('P4|window'));
    expect(w.length).toBeGreaterThan(0);
    expect(w.every((c) => !c.hard)).toBe(true);
    expect(w[0]?.text).toMatch(/headboard rises 0\.10 m above the window sill/);
  });

  it('a double bed needs one long side to get in (0.50 m); 0.60 m is better (advice)', () => {
    // QUEEN: 0.29 m to the north wall, a metre to the south: the short side is a note.
    const cs = run(withPieces(base, [QUEEN]));
    const zone = cs.filter((c) => c.key.startsWith('P4|zone|it_f000'));
    expect(zone.every((c) => !c.hard)).toBe(true);
    expect(zone.map((c) => c.text)).toContain(
      'The queen bed has one side to get in; the other is against the wall, fine in a small room.',
    );
    // Both sides short: hard.
    const squeezed = run(
      withPieces(base, [
        ['bed-queen', at(1.0, 1.2), PI / 2],
        ['wardrobe', at(1.0, 0.15 + 0.3 + 0.0), 0],
        ['wardrobe', at(1.0, 2.25), PI],
      ]),
    );
    expect(
      squeezed.some((c) => c.hard && /Not enough room to get into the queen bed/.test(c.text)),
    ).toBe(true);
  });

  it('nobody is dropped silently: more people than bedrooms, or a room that is gone', () => {
    const big = ongs({
      household: { ...ongs().household, adults: 2, children: ['primary', 'teen', 'teen'] },
      sleeping: {},
      names: {},
    });
    const cs = run(withPieces(base, [QUEEN, ...SINGLES]), { brief: big });
    const lines = cs.filter((c) => c.key.startsWith('P1|unplaced'));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((c) => c.hard && c.unfixable)).toBe(true);
    expect(lines[0]?.text).toMatch(/has no bedroom: \d people and 2 bedrooms/);
    const gone = run(withPieces(base, [QUEEN, ...SINGLES]), {
      brief: ongs({
        sleeping: {
          'rm_main-bedroom': ['adult-1', 'adult-2'],
          rm_bedroom: ['elder-1'],
          rm_gone: ['child-1'],
        },
      }),
    });
    // Sophie said to sleep in a room no longer on the plan (and not in Bedroom).
    expect(gone.map((c) => c.text)).toContain(
      'Sophie has no bed: the room they sleep in isn’t on the plan any more.',
    );
  });

  it('one line per key: a piece narrowing a way twice is one failure', () => {
    const cs = run(withPieces(base, [['dining-6', at(5.4, 3.71), 0]]));
    const keys = cs.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('a couple in a single bed: one of them has no bed', () => {
    const lvl = withPieces(base, [['bed-super-single', at(2.216, 1.2), PI / 2], ...SINGLES]);
    expect(texts(lvl).filter((t) => /has no bed/.test(t))).toEqual([
      'Daniel has no bed in Main bedroom.',
    ]);
  });

  it('not said who sleeps where: assumed (two in the largest bedroom, one elsewhere), and said so', () => {
    const brief = ongs({ sleeping: {} });
    const plan = sleepingPlan(brief, [
      { id: 'rm_bedroom', area: 9.8 },
      { id: 'rm_main-bedroom', area: 12.8 },
    ]);
    expect(plan.assumed).toBe(true);
    expect(plan.rooms.get('rm_main-bedroom')?.map((p) => p.name)).toEqual(['Rachel', 'Daniel']);
    expect(plan.rooms.get('rm_bedroom')?.map((p) => p.name)).toEqual(['Mdm Koh']);
    expect(plan.unplaced.map((p) => p.name)).toEqual(['Sophie']);
    const cs = run(withPieces(base, [QUEEN]), { brief });
    expect(cs.map((c) => c.text)).toContain('Mdm Koh has no bed in Bedroom.');
    expect(cs.find((c) => c.key === 'P1|assumed')?.hard).toBe(false);
  });

  it('people are named from the brief, else by who they are', () => {
    expect(peopleOf(ongs({ names: {} })).map((p) => p.name)).toEqual([
      'Adult 1',
      'Adult 2',
      'Child 1',
      'Elder 1',
    ]);
  });

  it('2: a bedroom with no window fails; the shelter with a bed fails unless the helper sleeps there', () => {
    const noWindow: Level = {
      ...base,
      openings: Object.fromEntries(
        Object.entries(base.openings).filter(([id]) => id !== 'op_window_bedroom_outside-2'),
      ),
    };
    expect(keys(withPieces(noWindow, [QUEEN, ...SINGLES]))).toContain('P1|window|rm_bedroom');
    const shelter = withPieces(base, [QUEEN, ...SINGLES, ['bed-single', at(7.2, 7.0), 0]]);
    const bad = run(shelter).find((c) => c.key.startsWith('HDB|shelter-bed'));
    expect(bad).toMatchObject({ principle: 'HDB', hard: true, waivable: false });
    const brief = ongs({
      household: { ...ongs().household, helper: true },
      sleeping: { ...ongs().sleeping, 'rm_household-shelter': ['helper'] },
    });
    const ok = run(shelter, { brief }).find((c) => c.key.startsWith('HDB|shelter-bed'));
    expect(ok).toMatchObject({ hard: false });
    expect(ok?.text).toMatch(/helper sleeps in the Household shelter/);
  });

  it('a living room seats the household (at least 3) and a dining table one place each', () => {
    const lvl = withPieces(base, [QUEEN, ...SINGLES, ['armchair', at(8, 3), 0]]);
    expect(texts(lvl)).toContain(
      'Living and dining seats 1; the household needs at least 3 on a sofa or chairs.',
    );
    expect(texts(lvl)).toContain('Living and dining has no dining table for the household.');
  });
});

describe('P2: relationships (criteria 3, 4, 8)', () => {
  /** A TV on the living room's west wall (the bedroom's), facing east. */
  const TV: [string, Vec2, number] = ['tv', at(6.62, 2.5), -PI / 2];
  const faces = (lvl: Level) => run(lvl).filter((c) => c.key.startsWith('P2|faces'));

  it('3: a sofa whose front is 0.5 m from a wall faces the wall; turned with its back to it, passes', () => {
    const facing = run(withPieces(base, [['sofa-3', at(8.3, 2.599), PI]]));
    expect(facing.find((c) => c.key.startsWith('P2|faces'))?.text).toBe(
      'The 3-seat sofa faces the wall, 0.50 m away: it needs 1.20 m clear in front.',
    );
    const turned = run(withPieces(base, [['sofa-3', at(8.3, 2.099), 0]]));
    expect(turned.filter((c) => c.key.startsWith('P2|'))).toEqual([]);
  });

  it('3: 25° off the TV fails, 10° passes; 1.5 m from it fails, 2.4 m passes; a tall shelf between fails', () => {
    const sofa = (x: number, y: number): [string, Vec2, number] => ['sofa-3', at(x, y), PI / 2];
    // Back on the east wall: 2.955 m across from the TV's centre.
    expect(
      faces(withPieces(base, [TV, sofa(9.575, 2.5 + 2.955 * Math.tan(PI / 7.2))]))[0]?.text,
    ).toBe('The 3-seat sofa is turned 25° away from the TV, 55 inch: 20° at most.');
    expect(faces(withPieces(base, [TV, sofa(9.575, 2.5 + 2.955 * Math.tan(PI / 18))]))).toEqual([]);
    expect(faces(withPieces(base, [TV, sofa(8.695, 2.75)]))[0]?.text).toBe(
      'The 3-seat sofa is 1.50 m from the TV, 55 inch: 1.8–4.0 m is right.',
    );
    expect(faces(withPieces(base, [TV, sofa(9.595, 2.75)]))).toEqual([]);
    expect(
      faces(withPieces(base, [TV, sofa(9.595, 2.75), ['bookshelf', at(8, 2.6), -PI / 2]]))[0]?.text,
    ).toBe('The bookshelf stands between the 3-seat sofa and the TV, 55 inch.');
  });

  it('4: a floating sofa with 0.7 m behind it fails; with 0.9 m passes', () => {
    const behind = (gap: number) =>
      run(withPieces(base, [['sofa-3', at(10.025 - gap - 0.45, 3.8), PI / 2]])).filter((c) =>
        c.key.startsWith('P2|backs'),
      );
    expect(behind(0.7)[0]?.text).toBe(
      'Not enough room to walk behind the 3-seat sofa: 0.90 m needed, 0.70 m left.',
    );
    expect(behind(0.9)).toEqual([]);
  });

  it('a coffee table 0.35–0.50 m from the sofa; a bedside table by the bed’s head; chairs at a table', () => {
    const sofa: [string, Vec2, number] = ['sofa-3', at(8.3, 2.099), 0];
    const coffee = (gap: number): [string, Vec2, number] => [
      'coffee-table',
      at(8.3, 2.549 + gap + 0.3),
      0,
    ];
    const coffeeAt = (gap: number) =>
      run(withPieces(base, [sofa, coffee(gap)])).filter((c) => c.key.startsWith('P2|before'));
    expect(coffeeAt(0.4)).toEqual([]);
    expect(coffeeAt(0.2)[0]?.text).toBe(
      'The coffee table is 0.20 m from the sofa: 0.35–0.50 m keeps it in reach.',
    );
    const bedside = (x: number) =>
      run(withPieces(base, [QUEEN, ['bedside', at(x, 2.17), PI / 2]])).filter((c) =>
        c.key.startsWith('P2|near'),
      );
    // Beside the head: passes; by the foot: fails.
    expect(bedside(3.016)).toEqual([]);
    expect(bedside(1.4)[0]?.text).toBe('The bedside table isn’t beside a bed’s head.');
    const chair = run(withPieces(base, [['dining-chair', at(8, 4.5), 0]])).find((c) =>
      c.key.startsWith('P2|belongs'),
    );
    expect(chair?.text).toBe('The dining chair isn’t at a table.');
  });

  it('8: a kind given only a relationship row is checked with no other code', () => {
    // A stand-in for a bay seat: backs onto a window wall.
    const relations = { 'folding-screen': { backs: { gap: 0.05, window: true } } };
    const under = withPieces(base, [['folding-screen', at(8.16, 1.57 + 0.19), 0]]);
    const plain = withPieces(base, [['folding-screen', at(10.15 - 0.19, 4), PI / 2]]);
    const p2 = (lvl: Level) => run(lvl, { relations }).filter((c) => c.key.startsWith('P2|backs'));
    expect(p2(under)).toEqual([]);
    expect(p2(plain)[0]?.text).toBe('The folding screen should be under a window.');
    expect(run(plain).filter((c) => c.key.startsWith('P2|'))).toEqual([]);
  });
});

describe('P3 and P4: circulation, fit and access (criteria 5, 6, 7)', () => {
  it('5: a dining table in the passage to the bedrooms fails with the walkway wording', () => {
    const cs = run(withPieces(base, [['dining-4', at(5.0, 3.55), 0]]));
    const walk = cs.filter((c) => c.key.startsWith('P3|walkway'));
    expect(walk.length).toBeGreaterThan(0);
    expect(walk[0]?.text).toMatch(
      /^The dining table, 4 seats narrows the way through to 0\.\d\d m: 0\.90 m needed\.$/,
    );
  });

  it('5: a shallow shoe cabinet in the passage, leaving 0.92 m, passes', () => {
    // The passage is 1.12 m wide: 0.20 m deep leaves 0.92 m.
    const lvl = withPieces(base, [['shoe-cabinet', at(5.5, 3.148 + 0.1), 0]]);
    const it = Object.values(lvl.items)[0];
    if (it) it.scale = { ...it.scale, z: 0.2 / 0.35 };
    expect(run(lvl).filter((c) => c.key.startsWith('P3|walkway'))).toEqual([]);
  });

  it('6: a piece in the shelter door’s sweep fails as an HDB rule; a wardrobe at a window fails P4', () => {
    const sweep = doorSweep(base, 'op_door_household-shelter_kitchen')[0] as Vec2[];
    const c = polygonCentroid(sweep);
    const shelter = run(withPieces(base, [['plant', c, 0]])).find((x) =>
      x.key.startsWith('P3|door|'),
    );
    expect(shelter).toMatchObject({ principle: 'HDB', waivable: false });
    const wardrobe = run(withPieces(base, [['wardrobe', at(8.16, 1.57 + 0.3), 0]]));
    expect(wardrobe.map((x) => x.text)).toContain(
      'The wardrobe blocks a window: it stands higher than the sill.',
    );
  });

  it('a wardrobe whose doors open onto a bed fails P4 with the zone’s words', () => {
    const lvl = withPieces(base, [QUEEN, ['wardrobe', at(0.6, 3.2), -PI / 2]]);
    expect(
      texts(lvl).some((t) =>
        /^Not enough room to use the wardrobe: wardrobe doors need 0\.60 m/.test(t),
      ),
    ).toBe(false);
    const tight = withPieces(base, [QUEEN, ['wardrobe', at(0.6, 1.2), -PI / 2]]);
    expect(
      texts(tight).some((t) =>
        /^Not enough room to use the wardrobe: wardrobe doors need 0\.60 m/.test(t),
      ),
    ).toBe(true);
  });
});

describe('bounded (criterion 18)', () => {
  it('every check on the sample with 40 pieces: under 150 ms (median of 7; three times on CI)', () => {
    const r = designResult(base, base, sampleDesign({ brief: ongs() }));
    const extra = withPieces(
      r.level,
      Array.from({ length: 40 - Object.keys(r.level.items).length }, (_, i) => [
        i % 2 ? 'plant' : 'dining-chair',
        at(7 + (i % 3) * 0.9, 3.6 + Math.floor(i / 3) * 0.6),
        0,
      ]) as [string, Vec2, number][],
      'it_x',
    );
    expect(Object.keys(extra.items).length).toBeGreaterThanOrEqual(40);
    const times: number[] = [];
    for (let i = 0; i < 7; i++) {
      // A fresh copy each time, so nothing is remembered from the time before.
      const lvl = structuredClone(extra);
      const t0 = performance.now();
      designChecks(lvl, { brief: ongs() });
      times.push(performance.now() - t0);
    }
    const ms = [...times].sort((a, b) => a - b)[3] as number;
    console.log(`designChecks: ${ms.toFixed(1)} ms (median of 7)`);
    expect(ms).toBeLessThan(process.env.PERF ? 150 : 450);
  });
});

describe('caused or already in the plan (criterion 9)', () => {
  it('9: a sofa facing the wall in the plan, untouched by a version for the bedroom, is already there', () => {
    const plan = withPieces(base, [['sofa-3', at(8.3, 2.599), PI]], 'it_plan');
    const d = sampleDesign({
      level: plan,
      brief: ongs(),
      concept: null,
      answers: {
        rm_bedroom: answer([
          { ref: 'b1', assetId: 'bed-single', wall: 'W5', along: 0.8 },
          { ref: 'b2', assetId: 'bed-single', wall: 'W5', along: 2.3 },
        ]),
      },
    });
    const r = designResult(plan, plan, d);
    const sofa = r.checks.find((c) => c.key.startsWith('P2|faces'));
    expect(sofa?.already).toBe(true);
    expect(r.checks.filter((c) => c.hard && !c.already).map((c) => c.text)).not.toContain(
      sofa?.text,
    );
  });
});
