import { describe, expect, it } from 'vitest';
import { furnitureKind } from '../furniture';
import { levelBounds, pointInPolygon } from '../geometry';
import { aliasesFor } from './aliases';
import ownerBedroom from './benchmark/answers/owner-bedroom.json';
import ownerDiningFix from './benchmark/answers/owner-dining-fix.json';
import sampleLiving from './benchmark/answers/sample-living.json';
import { ONGS } from './benchmark/benchmark';
import { SAMPLE_KEYS, answer, parsed, sampleDesign, sampleLevel } from './fixtures/sample';
import { roleOf } from './principles';
import { designResult } from './result';
import { type SpaceDesign, defaultBrief, parseSpaceDesign } from './schema';

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
    expect(r.checks.filter((c) => c.principle === 'P2')).toEqual([]);
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
});
