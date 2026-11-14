import { describe, expect, it } from 'vitest';
import { polygonGap } from '../convex';
import { withPieces } from '../fixtures/furnishedSample';
import { furnitureKind, itemFootprint } from '../furniture';
import { levelBounds, pointInPolygon } from '../geometry';
import type { Level } from '../schema';
import { aliasesFor } from './aliases';
import ownerBedroom from './benchmark/answers/owner-bedroom.json';
import ownerDiningFix from './benchmark/answers/owner-dining-fix.json';
import ownerDining from './benchmark/answers/owner-dining.json';
import sampleBedroom from './benchmark/answers/sample-bedroom.json';
import sampleKitchen from './benchmark/answers/sample-kitchen.json';
import sampleLiving from './benchmark/answers/sample-living.json';
import sampleMain from './benchmark/answers/sample-main-bedroom.json';
import { ONGS } from './benchmark/benchmark';
import { SAMPLE_KEYS, answer, parsed, sampleDesign, sampleLevel } from './fixtures/sample';
import { roleOf } from './principles';
import { designResult } from './result';
import { type SpaceDesign, defaultBrief, parseSpaceDesign } from './schema';
import { sofaName } from './solve';

/**
 * The solver (answers of version 2): pieces placed from intent, relationships by
 * construction, every wall tried, the walkways and room to use each piece kept clear.
 */
const level = sampleLevel();
const b = levelBounds(level);
const v2 = (raw: unknown) => parsed(parseSpaceDesign(raw, b));
const run = (key: string, a: SpaceDesign, brief = ONGS, id = 'dsn_solve') =>
  designResult(level, level, {
    ...sampleDesign({ answers: { [key]: a }, brief, concept: null, id }),
    aliases: aliasesFor(level),
  });
const byRole = (r: ReturnType<typeof run>, role: string) =>
  Object.values(r.level.items).filter((it) => roleOf(furnitureKind(it.assetId)) === role);
const fwd = (rot: number) => ({ x: -Math.sin(rot), y: Math.cos(rot) });
/** The passage to the bedrooms (part of Living and dining). */
const PASSAGE = [
  { x: 3.0, y: 3.15 },
  { x: 6.49, y: 3.15 },
  { x: 6.49, y: 4.27 },
  { x: 3.0, y: 4.27 },
];

describe('the solver', () => {
  it('a sofa faces its TV by construction, the coffee table in reach, chairs at the table', () => {
    const r = run(SAMPLE_KEYS.living, v2(sampleLiving));
    const [sofa] = byRole(r, 'sofa');
    const [tv] = byRole(r, 'tv');
    expect(sofa && tv).toBeTruthy();
    if (!sofa || !tv) return;
    const f = fwd(sofa.rotationY);
    const v = { x: tv.position.x - sofa.position.x, y: tv.position.z - sofa.position.z };
    const angle = (Math.acos((f.x * v.x + f.y * v.y) / Math.hypot(v.x, v.y)) * 180) / Math.PI;
    expect(angle).toBeLessThan(20);
    expect(byRole(r, 'dining-chair')).toHaveLength(4);
    expect(r.checks.filter((c) => c.principle === 'P2' && c.hard)).toEqual([]);
    expect(r.passes).toBe(true);
  });

  it('owner 7 Nov: a bed and a wardrobe asked for on one wall: both placed, the bed first', () => {
    const r = run(SAMPLE_KEYS.bedroom, v2(ownerBedroom), {
      ...defaultBrief(),
      household: { ...defaultBrief().household, children: ['primary'] },
    });
    expect(byRole(r, 'bed')).toHaveLength(1);
    expect(byRole(r, 'wardrobe')).toHaveLength(1);
    expect(r.checks.filter((c) => c.hard && !c.already)).toEqual([]);
  });

  it('owner 7 Nov: the dining table is placed off the passage to the bedrooms', () => {
    const r = run(SAMPLE_KEYS.living, v2(ownerDiningFix), {
      ...defaultBrief(),
      household: { ...defaultBrief().household, children: ['primary', 'teen'] },
    });
    const [table] = byRole(r, 'dining-table');
    expect(table).toBeDefined();
    expect(pointInPolygon({ x: table!.position.x, y: table!.position.z }, PASSAGE)).toBe(false);
    expect(r.checks.filter((c) => c.key.startsWith('P3|walkway'))).toEqual([]);
  });

  it('is deterministic: the same answer places the same', () => {
    const a = run(SAMPLE_KEYS.living, v2(sampleLiving), ONGS, 'dsn_same');
    const c = run(SAMPLE_KEYS.living, v2(sampleLiving), ONGS, 'dsn_same2');
    const poses = (r: typeof a) =>
      Object.values(r.level.items)
        .map((it) => `${it.assetId}@${it.position.x.toFixed(3)},${it.position.z.toFixed(3)}`)
        .sort();
    expect(poses(a)).toEqual(poses(c));
  });

  it('a piece with no room anywhere is left out with why; an extra that can’t sit by its piece too', () => {
    const kings = answer([
      { ref: 'bed1', assetId: 'bed-king' },
      { ref: 'bed2', assetId: 'bed-king' },
    ]).items.map((i) => ({ ...i, against: 'wall', faces: null, near: null, zone: 'sleep' }));
    const r = run(SAMPLE_KEYS.bedroom, v2({ v: 2, items: kings, faces: [], notes: [] }));
    expect(byRole(r, 'bed')).toHaveLength(1);
    expect(r.dropped.map((n) => n.text)).toContain(
      'Left out the king bed: no wall or spot in the room has room for it.',
    );
  });

  it('an answer without a version is placed as before, where it says', () => {
    const r = run(
      SAMPLE_KEYS.living,
      answer([{ ref: 'sofa1', assetId: 'sofa-3', at: { x: 8.3, y: 2.6 }, rotation: 180 }]),
    );
    const [sofa] = byRole(r, 'sofa');
    expect(sofa?.position.x).toBeCloseTo(8.3);
    // It faces the wall, as asked: the checks say so (and a fix round sends it back).
    expect(r.checks.find((c) => c.key.startsWith('P2|faces'))?.text).toMatch(/faces the wall/);
  });

  describe('review fixes (tech-lead, 7 Nov)', () => {
    /** A version-2 answer from refs, kinds and what they are against. */
    const intent = (
      items: { ref: string; assetId: string; against?: string; near?: string; width?: number }[],
    ) =>
      v2({
        v: 2,
        items: answer(
          items.map(({ ref, assetId, width }) => ({ ref, assetId, width: width ?? null })),
        ).items.map((i, n) => ({
          ...i,
          against: items[n]?.against ?? 'wall',
          faces: null,
          near: items[n]?.near ?? null,
          zone: null,
        })),
        faces: [],
        notes: [],
      });
    const hardIn = (r: ReturnType<typeof run>) =>
      r.checks.filter((c) => c.hard && !c.already).map((c) => c.text);

    it('three singles for three children in the Bedroom: a bed placed only where it passes, else the bunk hint', () => {
      const r = run(
        SAMPLE_KEYS.bedroom,
        intent([
          { ref: 'bed1', assetId: 'bed-single' },
          { ref: 'bed2', assetId: 'bed-single' },
          { ref: 'bed3', assetId: 'bed-single' },
        ]),
        {
          ...defaultBrief(),
          household: {
            ...defaultBrief().household,
            adults: 2,
            children: ['primary', 'primary', 'teen'],
          },
          sleeping: {
            'rm_main-bedroom': ['adult-1', 'adult-2'],
            rm_bedroom: ['child-1', 'child-2', 'child-3'],
          },
        },
        'dsn_three_singles',
      );
      const beds = byRole(r, 'bed');
      expect(beds.length).toBeGreaterThanOrEqual(2);
      // No bed is squeezed in short of room (P4) to make the count.
      expect(hardIn(r).filter((t) => /bed/.test(t) && !/has no bed/.test(t))).toEqual([]);
      if (beds.length < 3) {
        expect(hardIn(r).find((t) => /has no bed/.test(t))).toMatch(/bunk bed/);
      }
    });

    it('A: no piece is left standing where another moves (Main bedroom, six pieces)', () => {
      const r = run(
        SAMPLE_KEYS.main,
        intent([
          { ref: 'bed1', assetId: 'bed-single' },
          { ref: 'ward1', assetId: 'wardrobe' },
          { ref: 'desk1', assetId: 'desk', against: 'window-wall' },
          { ref: 'shelf1', assetId: 'bookshelf' },
          { ref: 'side1', assetId: 'bedside', near: 'bed1' },
          { ref: 'side2', assetId: 'bedside', near: 'bed1' },
        ]),
      );
      expect(r.checks.filter((c) => c.key.startsWith('P4|overlap'))).toEqual([]);
      expect(byRole(r, 'bed')).toHaveLength(1);
    });

    it('B: a queen bed and a built-in wardrobe pass; with bedside tables the wardrobe stays', () => {
      const two = run(
        SAMPLE_KEYS.main,
        intent([
          { ref: 'bed1', assetId: 'bed-queen' },
          { ref: 'ward1', assetId: 'built-in-wardrobe', width: 1.8 },
        ]),
      );
      expect(hardIn(two)).toEqual([]);
      expect(byRole(two, 'wardrobe')).toHaveLength(1);
      const four = run(
        SAMPLE_KEYS.main,
        intent([
          { ref: 'bed1', assetId: 'bed-queen' },
          { ref: 'ward1', assetId: 'built-in-wardrobe', width: 1.8 },
          { ref: 'side1', assetId: 'bedside', near: 'bed1' },
          { ref: 'side2', assetId: 'bedside', near: 'bed1' },
        ]),
      );
      expect(byRole(four, 'wardrobe')).toHaveLength(1);
      expect(hardIn(four)).toEqual([]);
    });

    it('C: two single beds both find a place with room to get in (Mdm Koh and Sophie)', () => {
      const r = run(
        SAMPLE_KEYS.bedroom,
        intent([
          { ref: 'bed1', assetId: 'bed-single' },
          { ref: 'bed2', assetId: 'bed-single' },
        ]),
      );
      expect(byRole(r, 'bed')).toHaveLength(2);
      expect(hardIn(r)).toEqual([]);
    });
  });

  it('PERF: the sample by intent (every space) within its bound', () => {
    const answers = {
      [SAMPLE_KEYS.living]: v2(sampleLiving),
      [SAMPLE_KEYS.main]: v2(sampleMain),
      [SAMPLE_KEYS.bedroom]: v2(sampleBedroom),
      [SAMPLE_KEYS.kitchen]: v2(sampleKitchen),
    };
    const make = (id: string) =>
      designResult(level, level, {
        // The level given, so the fixture's own build of the sample isn't timed.
        ...sampleDesign({ level, answers, brief: ONGS, concept: null, id }),
        aliases: aliasesFor(level),
      });
    make('dsn_perf_warm');
    const times: number[] = [];
    for (let i = 0; i < 7; i++) {
      const t0 = performance.now();
      // Another version each time: nothing remembered from the time before.
      make(`dsn_perf_${i}`);
      times.push(performance.now() - t0);
    }
    const cold = [...times].sort((a, b) => a - b)[3] as number;
    // The same version again on a plan edited elsewhere: its solved spaces are remembered.
    // A plant added in Bath/WC 1, a room the version doesn't furnish.
    const edited = withPieces(level, [['plant', { x: 1.2, y: 5.2 }, 0]], 'it_edit');
    const t0 = performance.now();
    designResult(edited, edited, {
      ...sampleDesign({ level, answers, brief: ONGS, concept: null, id: 'dsn_perf_0' }),
      aliases: aliasesFor(level),
    });
    const warm = performance.now() - t0;
    console.log(
      `v2 designResult: ${cold.toFixed(0)} ms (median of 7), again ${warm.toFixed(0)} ms`,
    );
    expect(cold).toBeLessThan(process.env.PERF ? 300 : 900);
    expect(warm).toBeLessThan(process.env.PERF ? 150 : 450);
  });

  describe('heavy living rooms (tech-lead, 7 Nov)', () => {
    /** A living room by intent: the TV and its console, a sofa, armchairs, a coffee table, a table and chairs. */
    const living = (
      sofa: string,
      armchairs: number,
      table: string,
      chairs: number,
      more: { ref: string; assetId: string }[] = [],
    ) =>
      v2({
        v: 2,
        items: answer([
          ...more,
          { ref: 'tv1', assetId: 'tv' },
          { ref: 'tvc1', assetId: 'tv-console' },
          { ref: 'sofa1', assetId: sofa },
          ...Array.from({ length: armchairs }, (_, n) => ({
            ref: `arm${n + 1}`,
            assetId: 'armchair',
          })),
          { ref: 'coffee1', assetId: 'coffee-table' },
          { ref: 'dine1', assetId: table },
          ...Array.from({ length: chairs }, (_, n) => ({
            ref: `chair${n + 1}`,
            assetId: 'dining-chair',
          })),
        ]).items.map((i) => ({
          ...i,
          against: /tv|sofa/.test(i.assetId) ? 'wall' : 'free',
          faces:
            i.ref === 'tv1'
              ? 'sofa1'
              : /^(sofa1|arm)/.test(i.ref)
                ? 'tv1'
                : /^chair/.test(i.ref)
                  ? 'dine1'
                  : null,
          near:
            i.ref === 'tvc1'
              ? 'tv1'
              : i.ref === 'coffee1'
                ? 'sofa1'
                : /^chair/.test(i.ref)
                  ? 'dine1'
                  : null,
          zone: /dine|chair/.test(i.ref) ? 'dine' : 'lounge',
        })),
        faces: [],
        notes: [],
      });
    const household = (n: number) => ({
      ...defaultBrief(),
      household: {
        ...defaultBrief().household,
        adults: 2,
        children: (['primary', 'teen', 'teen', 'primary'] as ('primary' | 'teen')[]).slice(
          0,
          n - 2,
        ),
      },
    });
    const FULL = living('chesterfield-sofa', 2, 'dining-6', 6);
    const make = (a: SpaceDesign, brief: ReturnType<typeof household>, id: string) =>
      designResult(level, level, {
        ...sampleDesign({
          level,
          answers: { [SAMPLE_KEYS.living]: a },
          brief,
          concept: null,
          id,
        }),
        aliases: aliasesFor(level),
      });
    /** Median and worst of 7 cold runs (another version each time), after one to warm up. */
    const coldOf = (a: SpaceDesign, brief: ReturnType<typeof household>, id: string) => {
      make(a, brief, `${id}_warm`);
      const times: number[] = [];
      for (let i = 0; i < 7; i++) {
        const t0 = performance.now();
        make(a, brief, `${id}_${i}`);
        times.push(performance.now() - t0);
      }
      const sorted = [...times].sort((p, q) => p - q);
      return { median: sorted[3] as number, worst: sorted[6] as number };
    };
    /**
     * The heavy rooms' bound (median of 7 cold, desktop): the spec's 300 ms for a design. With
     * each pose made and its room-only score parts worked out once per space, and a walkway
     * re-solve stopped once it can only be refused, they measure about 150–190 ms.
     */
    const HEAVY_PERF = 300;
    /** A 3-seat sofa, two armchairs, a side table, a shelf and a table for four. */
    const SIDE_SHELF = living('sofa-3', 2, 'dining-4', 4, [
      { ref: 'side1', assetId: 'side-table-two-tier' },
      { ref: 'shelf1', assetId: 'bookshelf' },
    ]);

    it('a crowded living room (chesterfield, an armchair, table for six, six people) gets its extendable table', () => {
      const r = make(living('chesterfield-sofa', 1, 'dining-6', 6), household(6), 'dsn_crowded');
      expect(r.swaps.find((x) => x.space === SAMPLE_KEYS.living)).toMatchObject({ taken: true });
      expect(byRole(r, 'dining-table')[0]?.assetId).toBe('dining-extendable');
      expect(r.repaired.map((n) => n.text)).toContain(
        'Swapped the dining table, 6 seats for an extendable table to keep 0.60 m to the sofa: it fits 4, and 6 with the table pulled out.',
      );
      expect(r.repaired.map((n) => n.text)).toContain(
        '2 chairs wait by the wall until the table is pulled out.',
      );
      // Six seated (the extendable table counts six with four at it), and the way kept.
      expect(
        r.checks.filter((c) => c.hard && /^P1\|(dining|seats)|^P2\|apart/.test(c.key)),
      ).toEqual([]);
    });

    it('with two armchairs too, at least two swaps are tried; none keeps 0.60 m, so the check fails', () => {
      const r = make(FULL, household(6), 'dsn_crowded_full');
      const sw = r.swaps.find((x) => x.space === SAMPLE_KEYS.living);
      expect(sw?.tried ?? 0).toBeGreaterThanOrEqual(2);
      expect(sw?.taken).toBe(false);
      expect(r.checks.find((c) => c.key.startsWith('P2|apart'))?.hard).toBe(true);
    });

    it('a 3-seat sofa, two armchairs, a side table and a shelf for six people: a swap is tried', () => {
      const r = make(SIDE_SHELF, household(6), 'dsn_side_shelf');
      expect(r.swaps.find((x) => x.space === SAMPLE_KEYS.living)?.tried ?? 0).toBeGreaterThan(0);
    });

    it('PERF: the full living room (a table for six and six chairs, a chesterfield, two armchairs, six people) under 300 ms', () => {
      const { median, worst } = coldOf(FULL, household(6), 'dsn_full');
      console.log(
        `full living room: ${median.toFixed(0)} ms median, ${worst.toFixed(0)} worst of 7`,
      );
      expect(median).toBeLessThan(process.env.PERF ? HEAVY_PERF : 3 * HEAVY_PERF);
    });

    it('PERF: a 3-seat sofa, two armchairs, a table for four and its chairs (four people) under 300 ms', () => {
      const { median, worst } = coldOf(
        living('sofa-3', 2, 'dining-4', 4),
        household(4),
        'dsn_two_arms',
      );
      console.log(
        `sofa, two armchairs, table for four: ${median.toFixed(0)} ms median, ${worst.toFixed(0)} worst of 7`,
      );
      expect(median).toBeLessThan(process.env.PERF ? HEAVY_PERF : 3 * HEAVY_PERF);
    });

    it('PERF: a 3-seat sofa, two armchairs, a side table, a shelf and a table for four (six people) under 300 ms', () => {
      const { median, worst } = coldOf(SIDE_SHELF, household(6), 'dsn_side_shelf_perf');
      console.log(
        `sofa, two armchairs, side table, shelf: ${median.toFixed(0)} ms median, ${worst.toFixed(0)} worst of 7`,
      );
      expect(median).toBeLessThan(process.env.PERF ? HEAVY_PERF : 3 * HEAVY_PERF);
    });

    it('a walkway re-solve is taken only if the space’s hard checks get strictly better', () => {
      // The full living room and its kin, for four to six people: the hard checks after the
      // walkway step are never more than the first placing's, and a re-solve taken always
      // leaves its space strictly better.
      const hard = (r: ReturnType<typeof make>) => r.checks.filter((c) => c.hard).length;
      const cases: [SpaceDesign, number][] = [
        [FULL, 6],
        [FULL, 5],
        [living('chesterfield-sofa', 2, 'dining-6', 6), 4],
        [living('sofa-3', 2, 'dining-4', 4), 4],
        [living('sofa-3', 1, 'dining-6', 6), 6],
      ];
      cases.forEach(([a, n], k) => {
        const id = `dsn_resolve_${k}`;
        const first = designResult(
          level,
          level,
          {
            ...sampleDesign({
              answers: { [SAMPLE_KEYS.living]: a },
              brief: household(n),
              concept: null,
              id,
            }),
            aliases: aliasesFor(level),
          },
          { walkways: false },
        );
        const r = make(a, household(n), id);
        expect(hard(r)).toBeLessThanOrEqual(hard(first));
        for (const x of r.resolves) if (x.taken) expect(x.after).toBeLessThan(x.before);
      });
    });
  });

  describe('owner 7 Nov: the dining jammed against the sofa (P2 apart: 0.60 m, 0.90 m advised)', () => {
    /** The gap between the dining group (table and chairs) and the lounge pieces. */
    const zoneGap = (r: ReturnType<typeof run>) => {
      const [table] = byRole(r, 'dining-table');
      if (!table) return -1;
      const group = [table, ...byRole(r, 'dining-chair')].map((it) => itemFootprint(it));
      const lounge = ['sofa', 'armchair', 'coffee-table', 'tv-console']
        .flatMap((role) => byRole(r, role))
        .map((it) => itemFootprint(it));
      return Math.min(...group.flatMap((g) => lounge.map((l) => polygonGap(g, l).d)));
    };
    /** The sample with the living room's east wall at x (10.15 as drawn). */
    const withEastWall = (x: number): Level => ({
      ...level,
      vertices: Object.fromEntries(
        Object.entries(level.vertices).map(([k, v]) => [
          k,
          Math.abs(v.x - 10.152) < 0.01 ? { ...v, x } : v,
        ]),
      ),
    });
    const runOn = (lvl: Level, raw: unknown, brief: typeof ONGS, id: string) =>
      designResult(lvl, lvl, {
        ...sampleDesign({
          level: lvl,
          answers: { [SAMPLE_KEYS.living]: parsed(parseSpaceDesign(raw, levelBounds(lvl))) },
          brief,
          concept: null,
          id,
        }),
        aliases: aliasesFor(lvl),
      });
    const couple = {
      ...defaultBrief(),
      household: { ...defaultBrief().household, adults: 2, children: [] },
    };
    const swaps = (r: ReturnType<typeof run>) =>
      r.repaired.filter((n) => n.text.startsWith('Swapped')).map((n) => n.text);

    it('the sample: the dining group keeps 0.60 m from the lounge, all four chairs, no swap', () => {
      const r = run(SAMPLE_KEYS.living, v2(sampleLiving), ONGS, 'dsn_apart_sample');
      expect(byRole(r, 'dining-chair')).toHaveLength(4);
      expect(zoneGap(r)).toBeGreaterThanOrEqual(0.6 - 0.005);
      const [table] = byRole(r, 'dining-table');
      expect(pointInPolygon({ x: table!.position.x, y: table!.position.z }, PASSAGE)).toBe(false);
      expect(swaps(r)).toEqual([]);
      expect(r.checks.filter((c) => c.hard && !c.already)).toEqual([]);
    });

    it('the owner’s table for six: swapped for an extendable table, said in a line, 0.60 m kept', () => {
      const r = run(SAMPLE_KEYS.living, v2(ownerDining), {
        ...defaultBrief(),
        household: { ...defaultBrief().household, adults: 2, children: ['primary', 'teen'] },
      });
      const [table] = byRole(r, 'dining-table');
      expect(table?.assetId).toBe('dining-extendable');
      expect(swaps(r)).toEqual([
        'Swapped the dining table, 6 seats for an extendable table to keep 0.60 m to the sofa: it fits 4, and 6 with the table pulled out.',
      ]);
      expect(r.repaired.map((n) => n.text)).toContain(
        '2 chairs wait by the wall until the table is pulled out.',
      );
      expect(zoneGap(r)).toBeGreaterThanOrEqual(0.6 - 0.005);
      expect(r.checks.filter((c) => c.hard && !c.already)).toEqual([]);
    });

    for (const n of [5, 6]) {
      it(`a household of ${n}: the extendable table seats them; no chair is lost, no seat check fails`, () => {
        const kids = (['primary', 'teen', 'teen', 'primary'] as const).slice(0, n - 2);
        const r = run(
          SAMPLE_KEYS.living,
          v2(ownerDining),
          {
            ...defaultBrief(),
            household: { ...defaultBrief().household, adults: 2, children: [...kids] },
          },
          `dsn_apart_six_${n}`,
        );
        const [table] = byRole(r, 'dining-table');
        expect(table?.assetId).toBe('dining-extendable');
        expect(byRole(r, 'dining-chair')).toHaveLength(4);
        // Six chairs asked for: none left out, two wait by the wall.
        expect(r.dropped.filter((d) => /dining chair/.test(d.text))).toEqual([]);
        expect(r.repaired.map((d) => d.text)).toContain(
          '2 chairs wait by the wall until the table is pulled out.',
        );
        const living = r.checks.filter(
          (c) =>
            c.hard && !c.already && !c.key.startsWith('P1|unplaced') && !c.key.startsWith('P1|bed'),
        );
        expect(living).toEqual([]);
      });
    }

    it('in a living room 1.25 m wider, the dining is on open floor, 0.90 m from the lounge', () => {
      const r = runOn(withEastWall(11.4), sampleLiving, ONGS, 'dsn_apart_wide');
      expect(byRole(r, 'dining-chair')).toHaveLength(4);
      expect(zoneGap(r)).toBeGreaterThanOrEqual(0.9 - 0.005);
      expect(r.checks.filter((c) => c.key.startsWith('P2|apart'))).toEqual([]);
      expect(r.checks.filter((c) => c.hard && !c.already)).toEqual([]);
    });

    it('0.35 m narrower, for a couple: a wall-side table with a bench takes the table’s place', () => {
      const r = runOn(withEastWall(9.8), sampleLiving, couple, 'dsn_apart_couple');
      expect(swaps(r)).toEqual([
        'Swapped the dining table, 4 seats for a wall-side table with a bench for two to keep 0.60 m to the sofa.',
      ]);
      expect(byRole(r, 'dining-table')[0]?.assetId).toBe('dining-bench-2');
      expect(zoneGap(r)).toBeGreaterThanOrEqual(0.6 - 0.005);
      expect(r.checks.filter((c) => c.key.startsWith('P2|apart') && c.hard)).toEqual([]);
    });

    it('0.65 m narrower, for a couple: the 2-seat sofa as well', () => {
      const r = runOn(withEastWall(9.5), sampleLiving, couple, 'dsn_apart_couple2');
      expect(swaps(r)).toEqual([
        'Swapped the dining table, 4 seats for a wall-side table with a bench for two to keep 0.60 m to the sofa.',
        'Swapped the 3-seat sofa for a 2-seat to keep 0.60 m to the dining table.',
      ]);
      expect(byRole(r, 'sofa')[0]?.assetId).toBe('sofa-2');
      // Nothing the room needs is lost for it: the TV still faces the sofa.
      expect(byRole(r, 'tv')).toHaveLength(1);
      expect(r.checks.filter((c) => c.key.startsWith('P2|faces'))).toEqual([]);
      expect(r.checks.filter((c) => c.key.startsWith('P2|apart') && c.hard)).toEqual([]);
    });

    it('the household’s own sofa, brought along, is never swapped for a 2-seat (issue #66)', () => {
      // As 0.65 m narrower above, but the 3-seat sofa is theirs: the table may still give way.
      const lvl = withPieces(withEastWall(9.5), [['sofa-3', { x: 7.5, y: 5.45 }, Math.PI]]);
      const aliases = aliasesFor(lvl);
      const alias = Object.entries(aliases).find(([, id]) => id === 'it_f000')?.[0];
      const theirs = {
        ...sampleLiving,
        items: sampleLiving.items.map((i) => (i.ref === 'sofa1' ? { ...i, keep: alias } : i)),
      };
      const brief = { ...couple, keep: { items: { it_f000: 'bring' as const }, text: '' } };
      const r = designResult(lvl, lvl, {
        ...sampleDesign({
          level: lvl,
          answers: { [SAMPLE_KEYS.living]: parsed(parseSpaceDesign(theirs, levelBounds(lvl))) },
          brief,
          concept: null,
          id: 'dsn_apart_theirs',
        }),
        aliases,
      });
      expect(swaps(r).filter((t) => /sofa/.test(t))).toEqual([]);
      expect(r.level.items.it_f000?.assetId).toBe('sofa-3');
      expect(r.refs.it_f000).toBe('sofa1');
    });

    it('a sofa swap names the sofa as a sentence would, without what follows a comma', () => {
      const name = (id: string) =>
        sofaName(furnitureKind(id) as NonNullable<ReturnType<typeof furnitureKind>>);
      expect(name('sofa-3')).toBe('3-seat sofa');
      expect(name('chesterfield-sofa')).toBe('chesterfield sofa');
      expect(name('leather-sofa-rolled')).toBe('leather sofa');
      const leather = {
        ...sampleLiving,
        items: sampleLiving.items.map((i) =>
          i.ref === 'sofa1' ? { ...i, assetId: 'leather-sofa-rolled' } : i,
        ),
      };
      const r = runOn(withEastWall(9.5), leather, couple, 'dsn_apart_leather');
      expect(swaps(r)).toContain(
        'Swapped the leather sofa for a 2-seat to keep 0.60 m to the dining table.',
      );
    });

    it('0.35 m narrower, for four: nothing smaller seats them, so the check fails (never a silent gap)', () => {
      const r = runOn(withEastWall(9.8), sampleLiving, ONGS, 'dsn_apart_four');
      expect(swaps(r)).toEqual([]);
      const failing = r.checks.find((c) => c.key.startsWith('P2|apart'));
      expect(failing?.hard).toBe(true);
      expect(failing?.text).toMatch(
        /^Not enough room to walk between the dining table, 4 seats and the .+: 0\.60 m needed, 0\.\d\d m left\.$/,
      );
      expect(r.passes).toBe(false);
    });
  });
});
