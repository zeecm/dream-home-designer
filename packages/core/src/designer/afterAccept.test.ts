import { describe, expect, it } from 'vitest';
import { withPieces } from '../fixtures/furnishedSample';
import { levelBounds } from '../geometry';
import { AFTER_SUFFIX } from '../levels';
import { type Item, Level } from '../schema';
import { aliasOf, aliasesFor, resolveAlias } from './aliases';
import type { DesignCheck } from './checks';
import owner from './fixtures/owner-after-accept.json';
import { sampleLevel } from './fixtures/sample';
import { nudgeNearMisses, shortOf } from './nudge';
import { designResult } from './result';
import { type DesignInput, type SpaceDesign, defaultBrief, parseSpaceDesign } from './schema';
import { roomIdAt } from './spaces';

/**
 * After an Accept (issue #66): a design made on After keeps the pieces its answer keeps, by
 * the aliases of the level it starts from, where they stand. Before the fix every one of them
 * was dropped ("the brief leaves it out", brief.keep being empty), so each later redesign
 * lost the bed, the sofa, the dining set and the fridge, whatever was said.
 */

const plan = Level.parse(owner.plan);
const after = Level.parse(owner.after);
type Proposal = (typeof owner.proposals)[number];
const input = (p: Proposal) => p.design as unknown as DesignInput;
const hardOf = (checks: readonly DesignCheck[]) =>
  checks.filter((c) => c.hard && !('already' in c && c.already));

describe('the owner’s conversation of 9 Nov, replayed (V6 to V9 on After)', () => {
  const later = owner.proposals.filter((p) => p.base === 'after');

  it('has the levels and the four proposals made after V5 was accepted', () => {
    expect(after.id).toBe(`${plan.id}${AFTER_SUFFIX}`);
    expect(Object.keys(after.items)).toHaveLength(22);
    expect(later.map((p) => p.n)).toEqual([6, 7, 8, 9]);
    expect(owner.proposals.find((p) => p.n === 5)?.accepted).toBe(true);
  });

  for (const p of later) {
    describe(`V${p.n}`, () => {
      const d = input(p);
      const r = designResult(after, plan, d);
      const answers = Object.values(d.spaces).flatMap((s) => s.design?.items ?? []);

      it('places every piece it keeps, the same piece (its id) as After has it', () => {
        const kept = answers.filter((a) => a.keep);
        expect(kept.length).toBeGreaterThan(10);
        for (const a of kept) {
          const id = resolveAlias(d.aliases, a.keep);
          expect(id && after.items[id], `${a.ref}: ${a.keep}`).toBeTruthy();
        }
        const placed = kept.filter((a) => {
          const id = resolveAlias(d.aliases, a.keep) as string;
          return r.level.items[id] && r.refs[id] === a.ref;
        });
        // A built-in run may be refused for its own reasons; the household's pieces all stay.
        expect(placed.length).toBeGreaterThanOrEqual(kept.length - 1);
        expect(r.dropped.map((n) => n.text).join(' | ')).not.toMatch(
          /the brief leaves it out|there’s no piece/,
        );
      });

      it('the bed, the sofa, the dining set and the fridge are in, where they stood', () => {
        for (const asset of ['bed-queen', 'sofa-2', 'dining-bench-2', 'fridge']) {
          const was = Object.values(after.items).find((i) => i.assetId === asset) as Item;
          const now = r.level.items[was.id];
          expect(now, asset).toBeTruthy();
          if (!now) continue;
          // Where it stood, or a few cm off to mend a near miss.
          expect(
            Math.hypot(now.position.x - was.position.x, now.position.z - was.position.z),
          ).toBeLessThan(0.11);
          expect(now.rotationY).toBeCloseTo(was.rotationY, 5);
        }
      });

      it('nobody is left without a bed and the living room seats the household', () => {
        const keys = hardOf(r.checks).map((c) => c.key);
        expect(keys.filter((k) => k.startsWith('P1|bed|'))).toEqual([]);
        expect(keys.filter((k) => k.startsWith('P1|seats|'))).toEqual([]);
        expect(keys.filter((k) => k.startsWith('P2|belongs|'))).toEqual([]);
      });

      it('no near miss is left to show (a walkway or a door a centimetre short)', () => {
        expect(hardOf(r.checks).filter((c) => shortOf(c.issue, r.level) !== null)).toEqual([]);
      });
    });
  }

  it('V5 placed again on After: its near misses are mended a few cm at a time', () => {
    const v5 = input(owner.proposals.find((p) => p.n === 5) as Proposal);
    // As the app places a version already in After: without the walls After has (onPlanNow).
    const concept = v5.concept ? { ...v5.concept, walls: [] } : null;
    const r = designResult(after, plan, { ...v5, concept });
    const hard = hardOf(r.checks);
    expect(hard.filter((c) => shortOf(c.issue, r.level) !== null)).toEqual([]);
    // It was 7: walkways and the fridge door at 0.89 m and 0.85 m of 0.90 m, behind the sofa.
    expect(hard.length).toBeLessThanOrEqual(1);
    expect(r.repaired.some((n) => /^Moved the .+ \d+ cm to keep /.test(n.text))).toBe(true);
  });
});

/** The sample flat, its renovation furnished, and a main-bedroom answer of `items`. */
function onAfter(items: Record<string, unknown>[]) {
  const before = sampleLevel();
  const furnished = withPieces(before, [
    ['bed-queen', { x: 2.1, y: 0.15 + 1.05 }],
    ['wardrobe', { x: 0.3 + 0.3, y: 1.6 }, -Math.PI / 2],
  ]);
  const after: Level = { ...furnished, id: `${before.id}${AFTER_SUFFIX}` };
  const bed = Object.values(after.items).find((i) => i.assetId === 'bed-queen') as Item;
  const room = roomIdAt(after, { x: bed.position.x, y: bed.position.z }) as string;
  const aliases = aliasesFor(after);
  const alias = (id: string) => aliasOf(aliases).get(id) as string;
  const answer = (its: Record<string, unknown>[]): SpaceDesign => {
    const r = parseSpaceDesign(
      { v: 2, items: its, faces: [], notes: [], summary: 'Kept the bed.' },
      levelBounds(after),
    );
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  const design = (its: Record<string, unknown>[], brief = defaultBrief()): DesignInput => ({
    id: 'dsn_keep',
    brief: { ...brief, start: 'after' },
    aliases,
    concept: null,
    spaces: { [room]: { name: 'Main bedroom', status: 'done', design: answer(its) } },
  });
  return { before, after, bed, room, alias, design, items };
}

const piece = (ref: string, assetId: string, extra: Record<string, unknown> = {}) => ({
  ref,
  assetId,
  keep: null,
  wall: null,
  along: null,
  at: null,
  rotation: null,
  width: null,
  depth: null,
  height: null,
  why: '',
  against: 'wall',
  faces: null,
  near: null,
  zone: 'sleep',
  ...extra,
});

describe('keep after an Accept: refs resolve against the level the design starts from', () => {
  it('a piece of After the answer keeps stays where it stands, with an empty brief.keep', () => {
    const t = onAfter([]);
    const d = t.design([
      piece('bed1', 'bed-queen', { keep: t.alias(t.bed.id) }),
      piece('bs1', 'bedside', { near: 'bed1' }),
    ]);
    expect(d.brief.keep.items).toEqual({});
    const r = designResult(t.after, t.before, d);
    const bed = r.level.items[t.bed.id];
    expect(bed?.position).toEqual(t.bed.position);
    expect(bed?.rotationY).toBe(t.bed.rotationY);
    expect(r.refs[t.bed.id]).toBe('bed1');
    expect(r.dropped.map((n) => n.text)).not.toContain('Your queen bed: the brief leaves it out.');
    // Placed by it: the bedside table goes by the bed kept.
    const bs = Object.values(r.level.items).find((i) => r.refs[i.id] === 'bs1');
    expect(bs).toBeTruthy();
  });

  it('a piece of After the answer leaves out goes, as the room is designed again', () => {
    const t = onAfter([]);
    const wardrobe = Object.values(t.after.items).find((i) => i.assetId === 'wardrobe') as Item;
    const r = designResult(
      t.after,
      t.before,
      t.design([piece('bed1', 'bed-queen', { keep: t.alias(t.bed.id) })]),
    );
    expect(r.level.items[t.bed.id]).toBeTruthy();
    expect(r.level.items[wardrobe.id]).toBeUndefined();
  });

  it('on the flat as it is, the brief still decides (left out unless brought)', () => {
    const t = onAfter([]);
    // The same pieces in the plan as it is: the household's own furniture.
    const asIs: Level = { ...t.after, id: t.before.id };
    const keepBed = [piece('bed1', 'bed-queen', { keep: t.alias(t.bed.id) })];
    const left = designResult(asIs, asIs, t.design(keepBed));
    expect(left.dropped.map((n) => n.text)).toContain('Your queen bed: the brief leaves it out.');
    const brief = {
      ...defaultBrief(),
      keep: { items: { [t.bed.id]: 'bring' as const }, text: '' },
    };
    const brought = designResult(asIs, asIs, t.design(keepBed, brief));
    expect(brought.refs[t.bed.id]).toBe('bed1');
  });

  it('a kept piece that no longer fits where it stood is placed again, and says so', () => {
    const t = onAfter([]);
    // The bed moved by hand half into the wall behind it: it can't stay there.
    const moved: Level = {
      ...t.after,
      items: {
        ...t.after.items,
        [t.bed.id]: { ...t.bed, position: { ...t.bed.position, z: t.bed.position.z - 0.5 } },
      },
    };
    const r = designResult(
      moved,
      t.before,
      t.design([piece('bed1', 'bed-queen', { keep: t.alias(t.bed.id) })]),
    );
    const bed = r.level.items[t.bed.id];
    expect(bed).toBeTruthy();
    expect(bed?.position.z).not.toBeCloseTo(t.bed.position.z - 0.5, 2);
    expect(r.repaired.map((n) => n.text)).toContain(
      'Moved the queen bed: it no longer fits where it stood.',
    );
  });
});

describe('nudgeNearMisses', () => {
  const lvl = (x: number): Level => {
    const l = withPieces(sampleLevel(), [['armchair', { x, y: 4 }]]);
    return l;
  };
  /** A walkway that passes once the armchair is at x ≥ 3.03 (its pinch: x 2.11 to 3). */
  const issue = (have: number): DesignCheck => ({
    key: 'P3|walkway|it_f000|circulation',
    principle: 'P3',
    hard: true,
    waivable: true,
    text: 'The armchair narrows the way through.',
    itemId: 'it_f000',
    issue: {
      kind: 'walkway',
      itemId: 'it_f000',
      route: 'circulation',
      to: [],
      need: 0.9,
      have,
      capped: false,
      pinch: [
        { x: 2.1, y: 4 },
        { x: 3, y: 4 },
      ],
      path: [],
    },
  });
  const hard = (l: Level) => {
    const x = l.items.it_f000?.position.x ?? 0;
    const have = 0.9 + (x - 3.03);
    return have >= 0.9 - 1e-9 ? [] : [issue(have)];
  };

  it('moves the piece away from the far side of the narrowest point, a little past the need', () => {
    const l = lvl(3);
    const done = nudgeNearMisses(l, new Set(['it_f000']), hard);
    expect(done).toHaveLength(1);
    expect(l.items.it_f000?.position.x).toBeGreaterThanOrEqual(3.03);
    expect(l.items.it_f000?.position.x).toBeLessThan(3.1);
  });

  it('leaves a piece it may not move, and a miss too big to be near', () => {
    const l = lvl(3);
    expect(nudgeNearMisses(l, new Set(), hard)).toEqual([]);
    expect(l.items.it_f000?.position.x).toBe(3);
    const far = lvl(2.9);
    expect(nudgeNearMisses(far, new Set(['it_f000']), hard)).toEqual([]);
    expect(far.items.it_f000?.position.x).toBe(2.9);
  });

  it('keeps no move that makes another check fail', () => {
    const l = lvl(3);
    const worse = (x: Level) => [
      ...hard(x),
      ...((x.items.it_f000?.position.x ?? 0) > 3.001
        ? [{ ...issue(0.5), key: 'P2|faces|it_f000' }]
        : []),
    ];
    expect(nudgeNearMisses(l, new Set(['it_f000']), worse)).toEqual([]);
    expect(l.items.it_f000?.position.x).toBe(3);
  });
});
