import {
  type DesignInput,
  type DesignOptions,
  type Level,
  designResult,
  levelBounds,
  parseSpaceDesign,
} from '@dhd/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import living from '../../../../../packages/core/src/designer/fixtures/room-living.json' with {
  type: 'json',
};
import {
  SAMPLE_KEYS,
  parsed,
  sampleAnswers,
  sampleDesign,
  sampleLevel,
} from '../../../../../packages/core/src/designer/fixtures/sample';
import type { Answer, Ask } from './resultsHandler';

// The app's stores, as the client reads them (no browser here).
vi.mock('../../store', async () => {
  const { create } = await import('zustand');
  return { useStore: create(() => ({ editor: { doc: { models: [] } } })) };
});
vi.mock('./state', async () => {
  const { create } = await import('zustand');
  return { useDesigner: create(() => ({ designs: [] })) };
});

/** A heavy living room: the fixture's 14 pieces and 14 more (chairs, tables, plants, shelves). */
function heavyDesign(level: Level): DesignInput {
  const extra = [
    'armchair',
    'armchair',
    'side-table-two-tier',
    'side-table-two-tier',
    'plant',
    'plant',
    'floor-lamp',
    'bookshelf',
    'bookshelf',
    'ottoman-leather',
    'potted-ficus',
    'dining-chair',
    'dining-chair',
    'floor-lamp',
  ].map((assetId, i) => ({
    ...living.items[0],
    ref: `x${i}`,
    assetId,
    wall: null,
    along: null,
    why: 'More for them.',
  }));
  const room = parsed(
    parseSpaceDesign({ ...living, items: [...living.items, ...extra] }, levelBounds(level)),
  );
  expect(room.items.length).toBe(28);
  return sampleDesign({
    level,
    id: 'dsn_heavy',
    answers: { ...sampleAnswers(level), [SAMPLE_KEYS.living]: room },
  });
}

const level = sampleLevel();
const CASES: [string, DesignInput][] = [
  ['the sample', sampleDesign({ level })],
  ['a heavy living room', heavyDesign(level)],
];
const OPTS: DesignOptions = {};

/** What crosses to and from a worker: a structured clone each way. */
const across = <T>(v: T): T => structuredClone(v);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('designer results in a worker', () => {
  it.each(CASES)('gives the same result as the main thread for %s', async (_, design) => {
    const sync = designResult(level, level, design, OPTS);
    // The worker's side: its own module graph (its own memos), reached only by clones.
    vi.resetModules();
    const { handle } = await import('./resultsHandler');
    const ask: Ask = { id: 1, kind: 'result', base: level, before: level, design, opts: OPTS };
    const a = across(handle(across(ask)));
    expect(a.ok).toBe(true);
    const viaWorker = a.ok ? a.value : null;
    expect(viaWorker).not.toBe(sync);
    expect(viaWorker).toEqual(sync);
  });

  it('reads through a worker: pending, then the same result, then kept', async () => {
    vi.resetModules();
    const worker = await import('./resultsHandler');
    const posted: Ask[] = [];
    class FakeWorker {
      onmessage: ((e: { data: Answer }) => void) | null = null;
      onerror: (() => void) | null = null;
      postMessage(m: Ask) {
        posted.push(m);
        const a = across(worker.handle(across(m)));
        setTimeout(() => this.onmessage?.({ data: a }), 0);
      }
    }
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('window', globalThis);
    vi.resetModules();
    const { readResult, requestResult, useResultsTick } = await import('./results');
    const design = CASES[1]?.[1] as DesignInput;
    const tick = useResultsTick.getState().n;
    expect(readResult(level, level, design, OPTS)).toBeNull();
    const r = await requestResult(level, level, design, OPTS);
    expect(r).toEqual(designResult(level, level, design, OPTS));
    // Frozen as designResult leaves it, so the memos on frozen levels hold on this side too.
    expect(Object.isFrozen(r.level.walls) && Object.isFrozen(r.level.rooms)).toBe(true);
    expect(useResultsTick.getState().n).toBeGreaterThan(tick);
    expect(readResult(level, level, design, OPTS)).toBe(r);
    // The models and versions went first; the result was asked for once.
    expect(posted.map((m) => m.kind)).toEqual(['models', 'designs', 'result']);
  });

  it('answers at once without a worker (Node, or one that will not start)', async () => {
    vi.resetModules();
    const { readResult } = await import('./results');
    const design = CASES[0]?.[1] as DesignInput;
    expect(readResult(level, level, design, OPTS)).toEqual(
      designResult(level, level, design, OPTS),
    );
  });
});
