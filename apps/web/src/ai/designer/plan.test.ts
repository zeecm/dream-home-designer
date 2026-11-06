import {
  type Design,
  type EditorDoc,
  type Level,
  type Part,
  acceptDesign,
  designResult,
  dispatch,
  emptyHistory,
  levelFingerprint,
  sampleFlatProject,
  spacesOf,
  updateItem,
} from '@dhd/core';
import { describe, expect, it } from 'vitest';
import {
  SAMPLE_KEYS,
  sampleDesign,
} from '../../../../../packages/core/src/designer/fixtures/sample';
import { acceptedNow, changeFrom, changePlan, lastAccepted, resultFor } from './plan';

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

/** The sample with V1 accepted whole, then its sofa moved 0.4 m by hand. */
function acceptedThenMoved() {
  const s0: EditorDoc = { doc: sampleFlatProject(), history: emptyHistory() };
  const before = s0.doc.levels[0] as Level;
  const v1 = record(before, 'dsn_v1', 1);
  const r = designResult(before, before, v1);
  const parts: Part[] = [
    { aspect: 'walls' },
    ...spacesOf(r.level).flatMap((s) => all.map((aspect) => ({ space: s.key, aspect }) as Part)),
  ];
  const s1 = dispatch(s0, acceptDesign(before.id, r.level, parts, { base: before }));
  const accepted = s1.doc.renovation?.levels[0] as Level;
  const v1a: Design = {
    ...v1,
    accepted: { at: '2026-11-06T11:00:00.000Z', parts, level: accepted },
  };
  const sofa = Object.values(accepted.items).find((i) => i.assetId === 'sofa-3');
  if (!sofa) throw new Error('no sofa');
  const s2 = dispatch(
    s1,
    updateItem(accepted.id, sofa.id, { position: { x: sofa.position.x - 0.4 } }),
  );
  return { doc: s2.doc, v1: v1a, sofaId: sofa.id };
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
    // Another version not accepted keeps its own walls (they aren't in After), on After too.
    const other = changeFrom(v2, [v1, v2], doc);
    expect(other.v.base.variant).toBe('after');
    expect(other.v.concept?.walls).toEqual(v2.concept?.walls);
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
