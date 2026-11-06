import {
  type Design,
  type EditorDoc,
  type Level,
  type Part,
  designResult,
  dispatch,
  emptyHistory,
  levelFingerprint,
  sampleFlatProject,
  spacesOf,
  undo,
  updateItem,
  updateWall,
} from '@dhd/core';
import { describe, expect, it } from 'vitest';
import {
  SAMPLE_KEYS,
  sampleDesign,
} from '../../../../../packages/core/src/designer/fixtures/sample';
import {
  acceptCommand,
  acceptedNow,
  changeFrom,
  changePlan,
  heldHead,
  heldRows,
  lastAccepted,
  onPlanNow,
  resultFor,
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
  const made = acceptCommand(d, o.designs ?? [d], s.doc, parts, {});
  if (!made) throw new Error('nothing to accept');
  const next = dispatch(s, made.command);
  return {
    s: next,
    d: { ...d, accepted: { at, parts, level: afterOf(next), prior: made.prior } },
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

  it('a held row says what it keeps, "none" when a room has no such pieces left', () => {
    const { doc } = acceptedThenMoved();
    const after = doc.renovation?.levels[0] as Level;
    const spaces = spacesOf(after);
    const lock = (space: string) =>
      ({ space, aspect: 'furniture', by: 'hand-edit', label: 'Bar stool (removed)' }) as const;
    expect(heldHead(lock(SAMPLE_KEYS.living), spaces, after)).toMatch(
      /^Living and dining furniture, all \d+ pieces, as now$/,
    );
    const empty = { ...after, items: {} };
    expect(heldHead(lock(SAMPLE_KEYS.kitchen), spaces, empty)).toBe(
      'Kitchen furniture, none, as now',
    );
  });
});

describe('heldRows: one row per space and part', () => {
  it('two pieces moved in one room are one row, unlocked together', () => {
    const living = SAMPLE_KEYS.living;
    const lock = (space: string, aspect: 'furniture' | 'finishes' | 'walls', label: string) =>
      ({ space, aspect, by: 'hand-edit', label }) as const;
    const rows = heldRows([
      lock(living, 'furniture', '3-seat sofa (moved)'),
      lock(SAMPLE_KEYS.bedroom, 'finishes', 'Mdm Lim’s room wall (repainted)'),
      lock(living, 'furniture', 'Armchair (moved)'),
      lock('*', 'walls', 'Walls and doors (changed)'),
    ]);
    expect(rows.map((r) => r.text)).toEqual([
      '3-seat sofa (moved), Armchair (moved)',
      'Mdm Lim’s room wall (repainted)',
      'Walls and doors (changed)',
    ]);
    expect(rows[0]?.locks).toHaveLength(2);
    // With what each row holds said first (a lock keeps the whole part).
    const said = heldRows(rows[0]?.locks ?? [], (l) =>
      l.aspect === 'furniture' ? 'Living and dining furniture, all 15 pieces as now' : '',
    );
    expect(said.map((r) => r.text)).toEqual([
      'Living and dining furniture, all 15 pieces as now: 3-seat sofa (moved), Armchair (moved)',
    ]);
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
