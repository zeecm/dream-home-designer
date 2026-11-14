import { describe, expect, it } from 'vitest';
import {
  type Design,
  type EditorDoc,
  type Level,
  type Part,
  acceptDesign,
  designContext,
  designResult,
  dispatch,
  emptyHistory,
  levelBounds,
  levelFingerprint,
  moveVertex,
  parseSpaceDesign,
  roomIdAt,
  roomsBeside,
  sampleFlatProject,
  spacesOf,
  splitWall,
  undo,
  updateItem,
  updateWall,
} from '../../index';
import { SAMPLE_KEYS, parsed, sampleDesign } from '../fixtures/sample';
import {
  acceptedNow,
  changeFrom,
  changePlan,
  lastAccepted,
  onPlanNow,
  planScope,
  resultFor,
  roomPrompts,
  wallsStillIn,
} from './plan';

/**
 * Change something after accepting (D9): the change starts from After as it is, and what was
 * changed by hand since is kept (`hand-edit` locks the person can unlock).
 */

const all: Part['aspect'][] = ['furniture', 'built-ins', 'finishes', 'electrical'];

function record(level: Level, id: string, n: number): Design {
  const d = sampleDesign({ level, id });
  return {
    ...d,
    n,
    projectId: 'prj_sample',
    levelId: level.id,
    name: d.concept?.name ?? 'Design',
    parent: null,
    waivers: [],
    createdAt: '2026-11-06T10:00:00.000Z',
    base: { variant: 'before', fingerprint: levelFingerprint(level) },
    baseLevel: level,
    request: { scope: { kind: 'all' }, feedback: '', locks: [] },
    usage: [],
    accepted: null,
  };
}

const fresh = (): EditorDoc => ({ doc: sampleFlatProject(), history: emptyHistory() });
const flatOf = (s: EditorDoc) => s.doc.levels[0] as Level;
const afterOf = (s: EditorDoc) => s.doc.renovation?.levels[0] as Level;

/**
 * Accepts `d` as the app does: worked out on After as it is (the flat, with none), with the
 * walls part (`walls`) and every space's parts (`spaces`); the record says so.
 */
function accept(
  s: EditorDoc,
  d: Design,
  at: string,
  o: { walls?: boolean; spaces?: boolean; designs?: Design[] } = {},
): { s: EditorDoc; d: Design } {
  const before = flatOf(s);
  const r = designResult(s.doc.renovation ? afterOf(s) : before, before, d);
  const parts: Part[] = [
    ...(o.walls === false ? [] : [{ aspect: 'walls' } as Part]),
    ...(o.spaces === false
      ? []
      : spacesOf(r.level).flatMap((x) => all.map((aspect) => ({ space: x.key, aspect }) as Part))),
  ];
  // As slice 1 accepted a version: placed on After as it is now, keeping hand edits.
  const v = onPlanNow(d, o.designs ?? [d], s.doc);
  const placed = resultFor(s.doc, { ...v, base: { ...v.base, variant: 'after' } }, {});
  if (!placed) throw new Error('nothing to accept');
  const prior = structuredClone(s.doc.renovation?.levels[0] ?? before);
  const next = dispatch(s, acceptDesign(before.id, placed.level, parts, { base: d.baseLevel }));
  return {
    s: next,
    d: { ...d, accepted: { at, parts, level: afterOf(next), prior } },
  };
}

/** A change made from `v` on After as it is: its walls stripped if After has them. */
function changedOnAfter(
  s: EditorDoc,
  v: Design,
  designs: Design[],
  id: string,
  n: number,
  createdAt = v.createdAt,
) {
  const from = changeFrom(v, designs, s.doc).v;
  return { ...from, id, n, parent: v.id, baseLevel: afterOf(s), accepted: null, createdAt };
}

/** The sample with V1 accepted whole, then its sofa moved 0.4 m by hand. */
function acceptedThenMoved() {
  const s0 = fresh();
  const v1 = record(flatOf(s0), 'dsn_v1', 1);
  const { s: s1, d: v1a } = accept(s0, v1, '2026-11-06T11:00:00.000Z');
  const accepted = afterOf(s1);
  const sofa = Object.values(accepted.items).find((i) => i.assetId === 'sofa-3');
  if (!sofa) throw new Error('no sofa');
  const s2 = dispatch(
    s1,
    updateItem(accepted.id, sofa.id, { position: { x: sofa.position.x - 0.4 } }),
  );
  return { doc: s2.doc, s: s2, v1: v1a, sofaId: sofa.id };
}

describe('changeFrom: after accepting, the change starts from After', () => {
  it('before anything is accepted, the version is changed as it is', () => {
    const doc = sampleFlatProject();
    const v1 = record(doc.levels[0] as Level, 'dsn_v1', 1);
    const from = changeFrom(v1, [v1], doc);
    expect(from.v).toBe(v1);
    expect(from.held).toEqual([]);
  });

  it('lists what was changed by hand, on After, without the walls After already has', () => {
    const { doc, v1 } = acceptedThenMoved();
    const after = doc.renovation?.levels[0];
    expect(acceptedNow(v1, after)).toBe(true);
    const v2 = record(doc.levels[0] as Level, 'dsn_v2', 2);
    expect(lastAccepted([v1, v2], after)?.id).toBe('dsn_v1');
    const from = changeFrom(v1, [v1, v2], doc);
    expect(from.v.brief.start).toBe('after');
    expect(from.v.base.variant).toBe('after');
    expect(from.v.concept?.walls).toEqual([]);
    expect(v1.concept?.walls.length).toBeGreaterThan(0);
    expect(from.held).toEqual([
      {
        space: SAMPLE_KEYS.living,
        aspect: 'furniture',
        by: 'hand-edit',
        label: '3-seat sofa (moved)',
      },
    ]);
    // Another version with the same wall changes (copied from V1) has them in After too.
    const other = changeFrom(v2, [v1, v2], doc);
    expect(other.v.base.variant).toBe('after');
    expect(other.v.concept?.walls).toEqual([]);
  });

  it('a version with wall changes of its own keeps them (After hasn’t got them)', () => {
    const { doc, v1 } = acceptedThenMoved();
    const v2 = record(flatOf(fresh()), 'dsn_v2', 2);
    const own = {
      ...v2,
      concept: v2.concept && { ...v2.concept, walls: v2.concept.walls.slice(1) },
    };
    expect(changeFrom(own, [v1, own], doc).v.concept?.walls).toEqual(own.concept?.walls);
  });

  // Applied again on After, a version's wall changes would be made twice (refused as done).
  const twice = (s: EditorDoc, v: Design) => designResult(afterOf(s), flatOf(s), v).refused;

  it('scenario A: V2 copied V1’s walls and was accepted; changing V1 brings no walls again', () => {
    const s0 = fresh();
    const v1 = record(flatOf(s0), 'dsn_v1', 1);
    // V2 made from V1 before any accept, furniture only: V1's concept, walls and all.
    const v2: Design = { ...record(flatOf(s0), 'dsn_v2', 2), concept: v1.concept, parent: v1.id };
    const { s, d: v2a } = accept(s0, v2, '2026-11-06T11:00:00.000Z');
    expect(acceptedNow(v1, afterOf(s))).toBe(false);
    expect(twice(s, v1).length).toBeGreaterThan(0);
    const from = changeFrom(v1, [v1, v2a], s.doc);
    expect(from.v.concept?.walls).toEqual([]);
    const r = resultFor(s.doc, from.v, {});
    expect(r?.applied).toEqual([]);
    expect(r?.refused).toEqual([]);
  });

  it('scenario B: V1 accepted, V2 made on After and accepted over it; V1’s walls stay put', () => {
    const s0 = fresh();
    const v1 = record(flatOf(s0), 'dsn_v1', 1);
    const one = accept(s0, v1, '2026-11-06T11:00:00.000Z');
    const v2 = changedOnAfter(one.s, one.d, [one.d], 'dsn_v2', 2);
    expect(v2.concept?.walls).toEqual([]);
    const two = accept(one.s, v2, '2026-11-06T12:00:00.000Z');
    const after = afterOf(two.s);
    // V2's furniture replaced V1's; V1's wall changes are still in After.
    expect(Object.keys(one.d.accepted?.level.items ?? {}).some((id) => after.items[id])).toBe(
      false,
    );
    expect(wallsStillIn(one.d, after)).toBe(true);
    expect(lastAccepted([one.d, two.d], after)?.id).toBe('dsn_v2');
    const from = changeFrom(one.d, [one.d, two.d], two.s.doc);
    expect(from.v.concept?.walls).toEqual([]);
    expect(resultFor(two.s.doc, from.v, {})?.refused).toEqual([]);
  });

  it('a version accepted for its walls alone stays accepted through a later hand edit', () => {
    const s0 = fresh();
    const v1 = record(flatOf(s0), 'dsn_v1', 1);
    const { s, d } = accept(s0, v1, '2026-11-06T11:00:00.000Z', { spaces: false });
    const after = afterOf(s);
    expect(Object.keys(after.items)).toEqual([]);
    expect(acceptedNow(d, after)).toBe(true);
    // A wall repainted by hand: still accepted, and the repaint is listed to keep.
    const wallId = Object.keys(after.walls).find((id) => after.walls[id]?.kind !== 'boundary');
    const s2 = dispatch(s, updateWall(after.id, wallId as string, { materialLeft: 'paint-sky' }));
    expect(acceptedNow(d, afterOf(s2))).toBe(true);
    expect(lastAccepted([d], afterOf(s2))?.id).toBe('dsn_v1');
    const from = changeFrom(d, [d], s2.doc);
    expect(from.v.base.variant).toBe('after');
    expect(from.held.some((l) => l.label.endsWith('(repainted)'))).toBe(true);
    // Undone: not accepted any more.
    expect(acceptedNow(d, flatOf(s))).toBe(false);
  });
});

describe('onPlanNow: a version as the plan would have it now', () => {
  it('a version wholly accepted, then edited by hand, is After as it is', () => {
    const { doc, v1, sofaId } = acceptedThenMoved();
    const after = doc.renovation?.levels[0] as Level;
    const v = onPlanNow(v1, [v1], doc);
    const r = resultFor(doc, v, {});
    expect(r?.applied).toEqual([]);
    expect(r?.level.items[sofaId]).toEqual(after.items[sofaId]);
    expect(Object.keys(r?.level.items ?? {}).sort()).toEqual(Object.keys(after.items).sort());
  });

  it('with no accept any more, the hand-edit locks a version was made with hold nothing', () => {
    const doc = sampleFlatProject();
    const v2: Design = {
      ...record(doc.levels[0] as Level, 'dsn_v2', 2),
      request: {
        scope: { kind: 'all' },
        feedback: '',
        locks: [
          {
            space: SAMPLE_KEYS.living,
            aspect: 'furniture',
            by: 'hand-edit',
            label: 'Sofa (moved)',
          },
          { space: SAMPLE_KEYS.kitchen, aspect: 'finishes', by: 'person', label: 'Kitchen paint' },
        ],
      },
    };
    const v = onPlanNow(v2, [v2], doc);
    expect(v.request.locks.map((l) => l.by)).toEqual(['person']);
    const living = resultFor(doc, v, {})?.spaces.find((s) => s.key === SAMPLE_KEYS.living);
    expect(living?.items.length).toBeGreaterThan(5);
  });
});

describe('hand edits a version already decided on, and what an accept itself did', () => {
  /** V3 made from V1 on After after the sofa moved, with the living furniture row unlocked. */
  function unlockedV3() {
    const { s, v1, sofaId } = acceptedThenMoved();
    const from = changeFrom(v1, [v1], s.doc);
    expect(from.held.map((l) => l.label)).toEqual(['3-seat sofa (moved)']);
    const r = resultFor(s.doc, from.v, {});
    if (!r) throw new Error('no result');
    const req = {
      scope: 'all',
      aspects: ['furniture', 'built-ins', 'finishes'] as ('furniture' | 'built-ins' | 'finishes')[],
      keep: {},
      feedback: 'more open',
      held: [],
    };
    const made = changePlan(from.v, r, req, 'dsn_v3');
    if (!made) throw new Error('no change');
    const v3: Design = {
      ...changedOnAfter(s, v1, [v1], 'dsn_v3', 3, '2026-11-06T12:00:00.000Z'),
      spaces: made.design.spaces,
      request: {
        scope: { kind: 'aspects', aspects: req.aspects },
        feedback: '',
        locks: made.locks,
      },
    };
    return { s, v1, v3, sofaId };
  }

  it('a row unlocked when V3 was made stays unlocked: V3 shows its own living furniture', () => {
    const { s, v1, v3, sofaId } = unlockedV3();
    expect(v3.request.locks.some((l) => l.by === 'hand-edit')).toBe(false);
    const shown = onPlanNow(v3, [v1, v3], s.doc);
    expect(shown.request.locks.some((l) => l.by === 'hand-edit')).toBe(false);
    const r = resultFor(s.doc, shown, {});
    const living = r?.spaces.find((x) => x.key === SAMPLE_KEYS.living);
    // V3's pieces (ids seeded from it), not After's: V1's moved sofa is gone.
    expect(r?.level.items[sofaId]).toBeUndefined();
    expect(living?.items.length).toBeGreaterThan(5);
    expect(living?.items.every((id) => !afterOf(s).items[id])).toBe(true);
    // A change of V3 doesn't hold it again either; an edit made after V3 is listed.
    expect(changeFrom(v3, [v1, v3], s.doc).held).toEqual([]);
    const after = afterOf(s);
    const wallId = Object.keys(after.walls).find((id) => after.walls[id]?.kind !== 'boundary');
    const s2 = dispatch(s, updateWall(after.id, wallId as string, { materialLeft: 'paint-sky' }));
    const later = changeFrom(v3, [v1, v3], s2.doc).held;
    expect(later.length).toBeGreaterThan(0);
    expect(later.every((l) => l.label.endsWith('(repainted)'))).toBe(true);
  });

  it('undoing an accept that kept hand edits leaves that version not accepted', () => {
    const { s, v1, sofaId } = acceptedThenMoved();
    // V2 made on the flat, accepted over V1 with the sofa kept as moved.
    const v2 = { ...record(flatOf(s), 'dsn_v2', 2), createdAt: '2026-11-06T10:30:00.000Z' };
    const two = accept(s, v2, '2026-11-06T12:00:00.000Z', { designs: [v1, v2] });
    const after = afterOf(two.s);
    expect(after.items[sofaId]).toEqual(afterOf(s).items[sofaId]);
    expect(acceptedNow(two.d, after)).toBe(true);
    expect(lastAccepted([v1, two.d], after)?.id).toBe('dsn_v2');
    // Ctrl+Z: V1 with the moved sofa again; V2 isn't in it, and nothing bogus is held.
    const back = undo(two.s);
    const was = afterOf(back);
    expect(acceptedNow(two.d, was)).toBe(false);
    expect(lastAccepted([v1, two.d], was)?.id).toBe('dsn_v1');
    expect(changeFrom(v1, [v1, two.d], back.doc).held.map((l) => l.label)).toEqual([
      '3-seat sofa (moved)',
    ]);
  });

  it('a wall built by hand before an accept is not that accept’s change', () => {
    const s0 = fresh();
    const v1 = record(flatOf(s0), 'dsn_v1', 1);
    const one = accept(s0, v1, '2026-11-06T11:00:00.000Z', { spaces: false });
    // A wall cut down by hand in After, then V2 (made before it, no wall changes) accepted.
    const after = afterOf(one.s);
    const wallId = Object.keys(after.walls).find(
      (id) => after.walls[id]?.kind !== 'boundary' && !after.walls[id]?.build,
    ) as string;
    const s1 = dispatch(one.s, updateWall(after.id, wallId, { height: 1.1 }));
    const v2 = {
      ...changedOnAfter(one.s, one.d, [one.d], 'dsn_v2', 2, '2026-11-06T11:30:00.000Z'),
      concept: one.d.concept && { ...one.d.concept, walls: [] },
    };
    const two = accept(s1, v2, '2026-11-06T12:00:00.000Z', { designs: [one.d, v2] });
    expect(wallsStillIn(two.d, afterOf(two.s))).toBe(null);
    // Undone by hand later: not V2's change, so it says nothing about V2.
    const s2 = dispatch(
      two.s,
      updateWall(after.id, wallId, { height: after.walls[wallId]?.height }),
    );
    expect(wallsStillIn(two.d, afterOf(s2))).toBe(null);
  });
});

describe('changePlan with hand-edit locks', () => {
  it('keeps the held part out of what is asked, and the lock in the request', () => {
    const { doc, v1, sofaId } = acceptedThenMoved();
    const from = changeFrom(v1, [v1], doc);
    const r = resultFor(doc, from.v, {});
    if (!r) throw new Error('no result');
    // The version as it would be made: the moved sofa stays where it was moved.
    const moved = doc.renovation?.levels[0]?.items[sofaId];
    const req = {
      scope: 'all',
      aspects: ['walls', 'furniture', 'built-ins', 'finishes'] as const,
      keep: {},
      feedback: '',
    };
    const made = changePlan(
      from.v,
      r,
      { ...req, aspects: [...req.aspects], held: from.held },
      'dsn_v3',
    );
    expect(made?.locks).toContainEqual(from.held[0]);
    expect(made?.plan.keep?.[SAMPLE_KEYS.living]).toContain('furniture');
    expect(made?.design.request?.locks).toContainEqual(from.held[0]);
    const v3 = designResult(
      doc.renovation?.levels[0] as Level,
      doc.levels[0] as Level,
      made?.design ?? from.v,
    );
    expect(v3.level.items[sofaId]).toEqual(moved);

    // Unlocked (×): the living room's furniture is asked for again.
    const free = changePlan(from.v, r, { ...req, aspects: [...req.aspects], held: [] }, 'dsn_v3');
    expect(free?.plan.keep?.[SAMPLE_KEYS.living] ?? []).not.toContain('furniture');
    expect(free?.locks.some((l) => l.by === 'hand-edit')).toBe(false);
  });
});

describe('a room asked again after an Accept (issue #66)', () => {
  it('its prompts name After’s pieces as the result resolves them, kept or left out', () => {
    const s0 = fresh();
    const v1 = record(flatOf(s0), 'dsn_v1', 1);
    const { s: s1, d: v1a } = accept(s0, v1, '2026-11-06T11:00:00.000Z');
    const after = afterOf(s1);
    const scope = { label: 'Main bedroom', spaces: [SAMPLE_KEYS.main], all: false };
    const sp = planScope(scope, v1.brief, s1.doc, flatOf(s1).id, [v1a], '', 'dsn_v2', {});
    if (!sp) throw new Error('no plan');
    expect(sp.ctx.variant).toBe('after');
    // The run's map is the shared context's: P7 is the same piece in every step and the result.
    for (const [a, id] of Object.entries(sp.ctx.aliases)) expect(sp.draft.aliases[a]).toBe(id);
    const [step] = roomPrompts(sp.ctx, sp.draft, sp.plan, {});
    const line = step?.tail.split('\n').find((l) => l.startsWith("Pieces of the household's here"));
    expect(line).toContain('"keep" ones (the design so far) stay where they stand');
    const pieces = JSON.parse(line?.slice(line.indexOf('): ') + 3) ?? '[]') as {
      id: string;
      kind: string;
      keep: string;
    }[];
    expect(pieces.length).toBeGreaterThan(0);
    for (const p of pieces) {
      expect(p.keep).toBe('keep');
      expect(after.items[sp.draft.aliases[p.id] ?? '']?.assetId).toBe(p.kind);
    }
    // An answer keeping the bed by that alias keeps the very bed, where it stands.
    const bed = pieces.find((p) => p.kind.startsWith('bed-'));
    if (!bed) throw new Error('no bed in the main bedroom');
    const bedId = sp.draft.aliases[bed.id] as string;
    const item = {
      ref: 'bed1',
      assetId: bed.kind,
      keep: bed.id,
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
    };
    const answer = parsed(
      parseSpaceDesign(
        { v: 2, items: [item], faces: [], notes: [], summary: 'The bed stays.' },
        levelBounds(after),
      ),
    );
    const r = designResult(after, flatOf(s1), {
      ...sp.draft,
      spaces: {
        ...sp.draft.spaces,
        [SAMPLE_KEYS.main]: { name: 'Main bedroom', status: 'done', design: answer },
      },
    });
    expect(r.level.items[bedId]?.position).toEqual(after.items[bedId]?.position);
    expect(r.refs[bedId]).toBe('bed1');

    // Kept with Keep this: "in-place" in the shared context too, not "keep".
    const it = after.items[bedId] as NonNullable<(typeof after.items)[string]>;
    const kept = {
      id: 'kept_1',
      itemId: bedId,
      assetId: it.assetId,
      pose: { x: it.position.x, y: it.position.z, rot: it.rotationY },
      from: 'V1',
      levelId: after.id,
      at: '2026-11-07T00:00:00.000Z',
    };
    const sp2 = planScope(scope, v1.brief, s1.doc, flatOf(s1).id, [v1a], '', 'dsn_v3', {
      kept: [kept],
    });
    expect(sp2?.ctx.inPlace).toContain(bedId);
    const prefix = sp2 ? designContext(sp2.ctx) : '';
    const plan = JSON.parse(prefix.split('```json\n')[2]?.split('\n```')[0] ?? '{}') as {
      pieces: { id: string; keep: string }[];
    };
    expect(plan.pieces.find((p) => p.id === bed.id)?.keep).toBe('in-place');
    expect(plan.pieces.filter((p) => p.id !== bed.id).every((p) => p.keep === 'keep')).toBe(true);
  });

  it('QA H1: the wall bent by hand over the kept bed: the bed is placed again, or said why not', () => {
    const s0 = fresh();
    const v1 = record(flatOf(s0), 'dsn_v1', 1);
    const { s: s1, d: v1a } = accept(s0, v1, '2026-11-06T11:00:00.000Z');
    const after = afterOf(s1);
    const main = SAMPLE_KEYS.main;
    const bed = Object.values(after.items).find(
      (i) =>
        i.assetId.startsWith('bed-') &&
        roomIdAt(after, { x: i.position.x, y: i.position.z }) === main,
    );
    if (!bed) throw new Error('no bed in the main bedroom');
    // The middle of the wall to the bedroom dragged into the main bedroom, over the bed.
    const wallId = Object.keys(after.walls).find((id) => {
      const [l, r] = roomsBeside(after, id);
      return (l === 'rm_bedroom' && r === main) || (r === 'rm_bedroom' && l === main);
    }) as string;
    const w = after.walls[wallId] as Level['walls'][string];
    const a = after.vertices[w.a] as { x: number; y: number };
    const b = after.vertices[w.b] as { x: number; y: number };
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const split = splitWall(after.id, wallId, mid, after);
    // Square to the wall, into the main bedroom, by `by` metres (QA's drag: about 0.25 m).
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    let n = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
    if (roomIdAt(after, { x: mid.x + n.x * 0.3, y: mid.y + n.y * 0.3 }) !== main) {
      n = { x: -n.x, y: -n.y };
    }
    const by = 0.25;
    const into = { x: mid.x + n.x * by, y: mid.y + n.y * by };
    const s2 = dispatch(dispatch(s1, split.command), moveVertex(after.id, split.vertexId, into));
    const bent = afterOf(s2);
    // "Redo the main bedroom, keep the bed": the answer keeps every piece listed, by alias.
    const scope = { label: 'Main bedroom', spaces: [main], all: false };
    const sp = planScope(scope, v1.brief, s2.doc, flatOf(s2).id, [v1a], '', 'dsn_v2', {});
    if (!sp) throw new Error('no plan');
    const [step] = roomPrompts(sp.ctx, sp.draft, sp.plan, {});
    const line = step?.tail.split('\n').find((l) => l.startsWith("Pieces of the household's here"));
    const pieces = JSON.parse(line?.slice(line.indexOf('): ') + 3) ?? '[]') as {
      id: string;
      kind: string;
    }[];
    expect(pieces.map((p) => sp.draft.aliases[p.id])).toContain(bed.id);
    const items = pieces.map((p, i) => ({
      ref: `p${i}`,
      assetId: p.kind,
      keep: p.id,
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
      zone: null,
    }));
    const answer = parsed(
      parseSpaceDesign(
        { v: 2, items, faces: [], notes: [], summary: 'Kept it all.' },
        levelBounds(bent),
      ),
    );
    const r = designResult(bent, flatOf(s2), {
      ...sp.draft,
      spaces: {
        ...sp.draft.spaces,
        [main]: { name: 'Main bedroom', status: 'done', design: answer },
      },
    });
    const now = r.level.items[bed.id];
    const said = [...r.repaired, ...r.dropped].filter(
      (n) =>
        n.itemId === bed.id ||
        n.ref === `p${pieces.findIndex((p) => sp.draft.aliases[p.id] === bed.id)}`,
    );
    if (now) {
      // Placed again in the main bedroom, and said (the wall runs where it stood).
      expect(roomIdAt(r.level, { x: now.position.x, y: now.position.z })).toBe(main);
      expect(
        Math.hypot(now.position.x - bed.position.x, now.position.z - bed.position.z),
      ).toBeGreaterThan(0.15);
      expect(said.map((n) => n.text)).toContain(
        'Moved the queen bed: it no longer fits where it stood.',
      );
      expect(r.checks.filter((c) => c.hard && !c.already && c.key.startsWith('P1|bed|'))).toEqual(
        [],
      );
      // The bed is placed before the kept pieces it no longer stands by: the wardrobe the
      // wall doesn't touch stays, rather than losing its wall to the bed.
      expect(r.dropped.map((n) => n.text).filter((x) => /wardrobe/.test(x))).toEqual([]);
    } else {
      expect(said.length).toBeGreaterThan(0);
    }
  });
});
