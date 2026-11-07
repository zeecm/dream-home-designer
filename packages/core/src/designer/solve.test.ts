import { describe, expect, it } from 'vitest';
import { polygonGap } from '../convex';
import { withPieces } from '../fixtures/furnishedSample';
import { furnitureKind, itemFootprint } from '../furniture';
import { levelBounds, pointInPolygon } from '../geometry';
import { aliasesFor } from './aliases';
import ownerBedroom from './benchmark/answers/owner-bedroom.json';
import ownerDiningFix from './benchmark/answers/owner-dining-fix.json';
import sampleBedroom from './benchmark/answers/sample-bedroom.json';
import sampleKitchen from './benchmark/answers/sample-kitchen.json';
import sampleLiving from './benchmark/answers/sample-living.json';
import sampleMain from './benchmark/answers/sample-main-bedroom.json';
import { ONGS } from './benchmark/benchmark';
import { SAMPLE_KEYS, answer, parsed, sampleDesign, sampleLevel } from './fixtures/sample';
import { roleOf } from './principles';
import { designResult } from './result';
import { type SpaceDesign, defaultBrief, parseSpaceDesign } from './schema';
import type { Level } from '../schema';

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
        ...sampleDesign({ answers, brief: ONGS, concept: null, id }),
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
      ...sampleDesign({ answers, brief: ONGS, concept: null, id: 'dsn_perf_0' }),
      aliases: aliasesFor(level),
    });
    const warm = performance.now() - t0;
    console.log(
      `v2 designResult: ${cold.toFixed(0)} ms (median of 7), again ${warm.toFixed(0)} ms`,
    );
    expect(cold).toBeLessThan(process.env.PERF ? 350 : 2000);
    expect(warm).toBeLessThan(process.env.PERF ? 150 : 600);
  });

  describe('owner 7 Nov: the dining jammed against the sofa (P2 apart, 0.90 m)', () => {
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

    it('kept wherever a pose keeps it: in a living room 1.25 m wider, the dining is on open floor', () => {
      // The sample with the living room's east wall moved out from x 10.15 to 11.40.
      const vertices = Object.fromEntries(
        Object.entries(level.vertices).map(([k, v]) => [
          k,
          Math.abs(v.x - 10.152) < 0.01 ? { ...v, x: 11.4 } : v,
        ]),
      );
      const wide: Level = { ...level, vertices };
      const a = parsed(parseSpaceDesign(sampleLiving, levelBounds(wide)));
      const r = designResult(wide, wide, {
        ...sampleDesign({
          level: wide,
          answers: { [SAMPLE_KEYS.living]: a },
          brief: ONGS,
          concept: null,
          id: 'dsn_apart_wide',
        }),
        aliases: aliasesFor(wide),
      });
      expect(byRole(r, 'dining-chair')).toHaveLength(4);
      expect(zoneGap(r)).toBeGreaterThanOrEqual(0.9 - 0.005);
      expect(r.checks.filter((c) => c.key.startsWith('P2|apart'))).toEqual([]);
      expect(r.checks.filter((c) => c.hard && !c.already)).toEqual([]);
    });

    it('where no pose keeps it (the sample), it is advice and the dining stays off the passage', () => {
      const r = run(SAMPLE_KEYS.living, v2(sampleLiving), ONGS, 'dsn_apart_tight');
      const [table] = byRole(r, 'dining-table');
      expect(table).toBeDefined();
      expect(pointInPolygon({ x: table!.position.x, y: table!.position.z }, PASSAGE)).toBe(false);
      const advice = r.checks.find((c) => c.key.startsWith('P2|apart'));
      expect(advice?.hard).toBe(false);
      expect(advice?.text).toMatch(/^Leave 0\.90 m between the dining table, 4 seats and the .+: 0\.\d\d m now\.$/);
      expect(r.checks.filter((c) => c.hard && !c.already)).toEqual([]);
    });
  });
});
