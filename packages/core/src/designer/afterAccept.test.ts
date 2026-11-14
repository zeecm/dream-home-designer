import { describe, expect, it } from 'vitest';
import { moveVertex, splitWall } from '../commands';
import { withPieces } from '../fixtures/furnishedSample';
import { sampleFlatProject } from '../fixtures/sampleFlat';
import { levelBounds } from '../geometry';
import { dispatch, emptyHistory } from '../history';
import { AFTER_SUFFIX } from '../levels';
import { type Item, Level, type Vec2 } from '../schema';
import { aliasOf, aliasesFor, resolveAlias } from './aliases';
import type { DesignCheck } from './checks';
import { pieceKeep } from './describe';
import owner from './fixtures/owner-after-accept.json';
import { sampleLevel } from './fixtures/sample';
import { SAMPLE_KEYS, sampleAnswers, sampleConcept } from './fixtures/sample';
import { NUDGE_BUDGET, nudgeNearMisses, nudgeable, shortOf } from './nudge';
import { designResult } from './result';
import { designResultKey } from './result';
import {
  type DesignInput,
  type Kept,
  type Lock,
  type SpaceDesign,
  defaultBrief,
  parseSpaceDesign,
} from './schema';
import { roomIdAt, roomsBeside } from './spaces';

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

/** A piece's centre and turn backed onto wall `wallId` at `t`, facing into `room`. */
function againstWall(level: Level, wallId: string, t: number, room: string, depth: number) {
  const w = level.walls[wallId] as Level['walls'][string];
  const a = level.vertices[w.a] as Vec2;
  const b = level.vertices[w.b] as Vec2;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const d = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
  const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  let n = { x: -d.y, y: d.x };
  if (roomIdAt(level, { x: p.x + n.x * 0.3, y: p.y + n.y * 0.3 }) !== room) n = { x: d.y, y: -d.x };
  const off = w.thickness / 2 + depth / 2 + 0.002;
  return { at: { x: p.x + n.x * off, y: p.y + n.y * off }, rot: Math.atan2(-n.x, n.y) };
}

/**
 * The sample flat, its renovation furnished (a queen bed and a wardrobe in the main bedroom,
 * and `extra`), and an answer for a space (the main bedroom unless said).
 */
function onAfter(extra: [string, Vec2, number?][] = []) {
  const before = sampleLevel();
  const furnished = withPieces(before, [
    ['bed-queen', { x: 2.1, y: 0.15 + 1.05 }],
    ['wardrobe', { x: 0.3 + 0.3, y: 1.6 }, -Math.PI / 2],
    ...extra,
  ]);
  const after: Level = { ...furnished, id: `${before.id}${AFTER_SUFFIX}` };
  const bed = Object.values(after.items).find((i) => i.assetId === 'bed-queen') as Item;
  const room = roomIdAt(after, { x: bed.position.x, y: bed.position.z }) as string;
  const aliases = aliasesFor(after);
  const alias = (id: string) => aliasOf(aliases).get(id) as string;
  const answer = (its: Record<string, unknown>[], v1 = false): SpaceDesign => {
    const r = parseSpaceDesign(
      { ...(v1 ? {} : { v: 2 }), items: its, faces: [], notes: [], summary: 'Kept the bed.' },
      levelBounds(after),
    );
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  const design = (
    its: Record<string, unknown>[],
    o: {
      brief?: DesignInput['brief'];
      space?: string;
      concept?: DesignInput['concept'];
      locks?: Lock[];
      v1?: boolean;
    } = {},
  ): DesignInput => ({
    id: 'dsn_keep',
    brief: { ...(o.brief ?? defaultBrief()), start: 'after' },
    aliases,
    concept: o.concept ?? null,
    spaces: {
      [o.space ?? room]: { name: 'A room', status: 'done', design: answer(its, o.v1) },
    },
    ...(o.locks ? { request: { locks: o.locks } } : {}),
  });
  return { before, after, bed, room, alias, design };
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
    const brought = designResult(asIs, asIs, t.design(keepBed, { brief }));
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

describe('keep after an Accept: what a kept piece may not do (tech-lead review)', () => {
  const keepBed = (t: ReturnType<typeof onAfter>) => [
    piece('bed1', 'bed-queen', { keep: t.alias(t.bed.id) }),
  ];

  it('B1: it never stays across a doorway the same design adds, but keeps an old one’s throat', () => {
    const plan = sampleLevel();
    const wallId = Object.keys(plan.walls).find((id) => {
      const [l, r] = roomsBeside(plan, id);
      return (
        (l === 'rm_bedroom' && r === 'rm_main-bedroom') ||
        (r === 'rm_bedroom' && l === 'rm_main-bedroom')
      );
    }) as string;
    expect(wallId).toBeTruthy();
    const shelf = againstWall(plan, wallId, 0.505, 'rm_bedroom', 0.3);
    const t = onAfter([['bookshelf', shelf.at, shelf.rot]]);
    const id = 'it_f002';
    const keepShelf = [piece('shelf1', 'bookshelf', { keep: t.alias(id), zone: 'store' })];
    // Without a new door it stands where it stood.
    const as = designResult(t.after, t.before, t.design(keepShelf, { space: 'rm_bedroom' }));
    expect(as.level.items[id]?.position).toEqual(t.after.items[id]?.position);
    // A door added in that wall, behind it: it is placed again, off the doorway.
    const concept = {
      ...sampleConcept(t.after),
      walls: [
        {
          op: 'add_door' as const,
          wall: t.alias(wallId),
          opening: null,
          a: null,
          b: null,
          height: null,
          t: 0.505,
          width: 0.8,
          style: 'swing' as const,
        },
      ],
      rooms: [],
      bathrooms: [],
    };
    const r = designResult(
      t.after,
      t.before,
      t.design(keepShelf, { space: 'rm_bedroom', concept }),
    );
    const door = Object.values(r.level.openings).find(
      (o) => o.wallId === wallId && !t.after.openings[o.id],
    );
    expect(door).toBeTruthy();
    const now = r.level.items[id];
    expect(now).toBeTruthy();
    const was = t.after.items[id] as Item;
    expect(
      Math.hypot((now?.position.x ?? 0) - was.position.x, (now?.position.z ?? 0) - was.position.z),
    ).toBeGreaterThan(0.3);
    expect(r.repaired.map((n) => n.text)).toContain(
      'Moved the bookshelf: it no longer fits where it stood.',
    );
  });

  it('B2: it is never taken from another room, a room changed by hand, or Keep this', () => {
    const t = onAfter();
    // Kept from the bedroom's answer: the main bedroom's bed stays in the main bedroom.
    const other = designResult(t.after, t.before, t.design(keepBed(t), { space: 'rm_bedroom' }));
    expect(other.level.items[t.bed.id]?.position).toEqual(t.bed.position);
    expect(other.refs[t.bed.id]).toBeUndefined();
    expect(other.dropped.map((n) => n.text)).toContain(
      'Your queen bed stands in another room: it stays there.',
    );
    // Its own room's furniture changed by hand since the accept: held where it is.
    const locks: Lock[] = [
      { space: t.room, aspect: 'furniture', by: 'hand-edit', label: 'Main bedroom: furniture' },
    ];
    const held = designResult(t.after, t.before, t.design(keepBed(t), { locks }));
    expect(held.level.items[t.bed.id]?.position).toEqual(t.bed.position);
    // Kept with Keep this: where it is, never a second copy that "doesn't fit".
    const kept: Kept = {
      id: 'kept_1',
      itemId: t.bed.id,
      assetId: 'bed-queen',
      pose: { x: t.bed.position.x, y: t.bed.position.z, rot: t.bed.rotationY },
      from: 'plan',
      levelId: t.after.id,
      at: '2026-11-14T00:00:00.000Z',
    };
    const k = designResult(t.after, t.before, t.design(keepBed(t)), { kept: [kept] });
    expect(k.level.items[t.bed.id]?.position).toEqual(t.bed.position);
    const texts = k.dropped.map((n) => n.text);
    expect(texts).toContain('Your queen bed is kept where it is, as you asked.');
    expect(texts.some((x) => /doesn’t fit/.test(x))).toBe(false);
  });

  it('S1: the same version on the flat as it is and on After is two results, in either order', () => {
    const t = onAfter();
    const asIs: Level = { ...t.after, id: t.before.id };
    const d = t.design(keepBed(t));
    expect(designResultKey(asIs, t.before, d)).not.toBe(designResultKey(t.after, t.before, d));
    const plain = (l: Level) => designResult(l, t.before, d);
    // On the flat as it is the brief leaves the bed out; on After it is kept.
    expect(plain(asIs).refs[t.bed.id]).toBeUndefined();
    expect(plain(t.after).refs[t.bed.id]).toBe('bed1');
    const d2 = { ...d, id: 'dsn_keep_2' };
    expect(designResult(t.after, t.before, d2).refs[t.bed.id]).toBe('bed1');
    expect(designResult(asIs, t.before, d2).refs[t.bed.id]).toBeUndefined();
  });

  it('S2: a piece the brief brings is placed again on After too, as the version made it', () => {
    // The bed a little off the wall in After: kept, it stays there; brought, it is placed anew.
    const t = onAfter();
    const off: Level = {
      ...t.after,
      items: {
        ...t.after.items,
        [t.bed.id]: { ...t.bed, position: { ...t.bed.position, z: t.bed.position.z + 0.3 } },
      },
    };
    const stays = designResult(off, t.before, t.design(keepBed(t)));
    expect(stays.level.items[t.bed.id]?.position.z).toBeCloseTo(t.bed.position.z + 0.3, 5);
    const brief = {
      ...defaultBrief(),
      keep: { items: { [t.bed.id]: 'bring' as const }, text: '' },
    };
    const brought = designResult(off, t.before, t.design(keepBed(t), { brief }));
    expect(brought.refs[t.bed.id]).toBe('bed1');
    expect(brought.level.items[t.bed.id]?.position.z).not.toBeCloseTo(t.bed.position.z + 0.3, 2);
    // And the prompts say so.
    expect(pieceKeep(off, t.before, t.bed.id, brief.keep.items)).toBe('bring');
    expect(pieceKeep(off, t.before, t.bed.id, {})).toBe('keep');
    expect(pieceKeep(off, t.before, t.bed.id, {}, new Set([t.bed.id]))).toBe('in-place');
  });

  it('H1: a wall bent by hand through the kept bed: placed again in its room, and said', () => {
    const t = onAfter();
    const wallId = Object.keys(t.after.walls).find((id) => {
      const [l, r] = roomsBeside(t.after, id);
      return (l === 'rm_bedroom' && r === t.room) || (r === 'rm_bedroom' && l === t.room);
    }) as string;
    const w = t.after.walls[wallId] as Level['walls'][string];
    const a = t.after.vertices[w.a] as Vec2;
    const b = t.after.vertices[w.b] as Vec2;
    // The wall's middle dragged into the main bedroom, over the bed (as QA did on the plan).
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const s0 = {
      doc: { ...sampleFlatProject(), renovation: { levels: [t.after] } },
      history: emptyHistory(),
    };
    const split = splitWall(t.after.id, wallId, mid, t.after);
    const s1 = dispatch(s0, split.command);
    const bedX = t.bed.position.x;
    const into = { x: mid.x + (bedX - mid.x) * 0.9, y: mid.y };
    const s2 = dispatch(s1, moveVertex(t.after.id, split.vertexId, into));
    const bent = s2.doc.renovation?.levels[0] as Level;
    const locks: Lock[] = [
      { space: '*', aspect: 'walls', by: 'hand-edit', label: 'Walls and doors (changed)' },
    ];
    // The couple sleeps in the main bedroom (now the smaller room).
    const brief = { ...defaultBrief(), sleeping: { [t.room]: ['adult-1', 'adult-2'] } };
    // The rest of the flat as the accepted version had it (copied, placed again): the bedroom
    // the bent wall now crosses into is solved after the main bedroom.
    const d = t.design(keepBed(t), { locks, brief });
    const bedroom = sampleAnswers(t.after)[SAMPLE_KEYS.bedroom] as SpaceDesign;
    d.spaces = { ...d.spaces, rm_bedroom: { name: 'Bedroom', status: 'copied', design: bedroom } };
    const r = designResult(bent, t.before, d);
    const bed = r.level.items[t.bed.id];
    const said = [...r.repaired, ...r.dropped].map((n) => n.text);
    if (bed) {
      // Placed again, in the main bedroom, clear of the wall, and said.
      expect(said).toContain('Moved the queen bed: it no longer fits where it stood.');
      expect(roomIdAt(r.level, { x: bed.position.x, y: bed.position.z })).toBe(t.room);
      expect(r.checks.filter((c) => c.key.startsWith('P1|bed|'))).toEqual([]);
    } else {
      // Nowhere for it: a line names it and why, never a silent removal.
      expect(said.some((x) => /queen bed/.test(x))).toBe(true);
    }
  });

  it('H1, the room solved first: a later copied room the bent wall crosses never takes it out', () => {
    const plan = sampleLevel();
    const wallId = Object.keys(plan.walls).find((id) => {
      const [l, r] = roomsBeside(plan, id);
      return (
        (l === 'rm_bedroom' && r === 'rm_main-bedroom') ||
        (r === 'rm_bedroom' && l === 'rm_main-bedroom')
      );
    }) as string;
    // A single bed in the bedroom, its head against that wall.
    const head = againstWall(plan, wallId, 0.5, 'rm_bedroom', 2.0);
    const t = onAfter([['bed-single', head.at, head.rot]]);
    const id = 'it_f002';
    const single = t.after.items[id] as Item;
    const w = t.after.walls[wallId] as Level['walls'][string];
    const a = t.after.vertices[w.a] as Vec2;
    const b = t.after.vertices[w.b] as Vec2;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    // Bent into the bedroom past the bed's middle: its centre is now in the main bedroom.
    const s0 = {
      doc: { ...sampleFlatProject(), renovation: { levels: [t.after] } },
      history: emptyHistory(),
    };
    const split = splitWall(t.after.id, wallId, mid, t.after);
    const into = {
      x: mid.x + (single.position.x - mid.x) * 1.4,
      y: mid.y + (single.position.z - mid.y) * 1.4,
    };
    const s1 = dispatch(dispatch(s0, split.command), moveVertex(t.after.id, split.vertexId, into));
    const bent = s1.doc.renovation?.levels[0] as Level;
    expect(roomIdAt(bent, { x: single.position.x, y: single.position.z })).toBe(t.room);
    const locks: Lock[] = [
      { space: '*', aspect: 'walls', by: 'hand-edit', label: 'Walls and doors (changed)' },
    ];
    const d = t.design([piece('bed1', 'bed-single', { keep: t.alias(id) })], {
      locks,
      space: 'rm_bedroom',
    });
    const main = sampleAnswers(t.after)[SAMPLE_KEYS.main] as SpaceDesign;
    d.spaces = { ...d.spaces, [t.room]: { name: 'Main bedroom', status: 'copied', design: main } };
    const r = designResult(bent, t.before, d);
    const said = [...r.repaired, ...r.dropped].map((n) => n.text);
    const now = r.level.items[id];
    if (now) {
      expect(roomIdAt(r.level, { x: now.position.x, y: now.position.z })).toBe('rm_bedroom');
      expect(said).toContain('Moved the single bed: it no longer fits where it stood.');
    } else {
      expect(said.some((x) => /single bed/.test(x))).toBe(true);
    }
  });

  it('one piece kept twice is placed once, the second left out with why', () => {
    const t = onAfter();
    const r = designResult(
      t.after,
      t.before,
      t.design([...keepBed(t), piece('bed2', 'bed-queen', { keep: t.alias(t.bed.id) })]),
    );
    expect(r.refs[t.bed.id]).toBe('bed1');
    const texts = r.dropped.map((n) => n.text);
    expect(texts).toContain('Your queen bed is placed once already; left out here.');
    expect(texts.some((x) => /doesn’t fit/.test(x))).toBe(false);
  });

  it('an answer of version 1 (by coordinates) keeps it where it stands too', () => {
    const t = onAfter();
    const r = designResult(t.after, t.before, t.design(keepBed(t), { v1: true }));
    expect(r.refs[t.bed.id]).toBe('bed1');
    expect(r.level.items[t.bed.id]?.position).toEqual(t.bed.position);
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

  it('moves only what the version placed in the spaces asked for, never a copied one or Keep this', () => {
    const spaces = [
      { status: 'done', items: ['a', 'b', 'k'] },
      { status: 'copied', items: ['c'] },
      { status: 'locked', items: ['d'] },
    ];
    const placed = new Set(['a', 'c', 'd', 'k']);
    expect([...nudgeable(spaces, placed, new Set(['k']))]).toEqual(['a']);
  });

  it('stops after its budget of checks', () => {
    const l = lvl(2.99);
    let calls = 0;
    // A miss that never mends: every move is tried, until the budget is spent.
    const never = () => {
      calls++;
      return [issue(0.89)];
    };
    nudgeNearMisses(l, new Set(['it_f000']), never, 3);
    expect(calls).toBe(3);
    calls = 0;
    nudgeNearMisses(lvl(2.99), new Set(['it_f000']), never);
    expect(calls).toBeLessThanOrEqual(NUDGE_BUDGET);
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
