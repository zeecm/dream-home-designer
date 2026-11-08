import {
  type Design,
  type DesignInput,
  type DesignOptions,
  type Level,
  PRICES,
  designResult,
  levelBounds,
  parseSpaceDesign,
  sampleFlatProject,
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
  tanBrief,
} from '../../../../../packages/core/src/designer/fixtures/sample';
import type { Answer, Ask } from './resultsHandler';
import { type PriceInput, priceRequest } from './talk/pricing';

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

/** What the client counted, when a test asks (`window.__dhdDesignerWorker`). */
const counted = () =>
  (globalThis as unknown as { __dhdDesignerWorker: { worker: number; here: number } })
    .__dhdDesignerWorker;

const stubDesign = (id: string) => ({ id, accepted: null }) as unknown as Design;

/** A scope press's price input on the sample (Living and dining, nothing accepted). */
const priceIn = (): Omit<PriceInput, 'designs'> => ({
  project: sampleFlatProject('prj_price'),
  brief: tanBrief(),
  scope: { label: 'Living and dining', spaces: [SAMPLE_KEYS.living], all: false },
  words: '',
  designId: 'dsn_est',
  opts: {},
  ai: { provider: 'anthropic', model: 'claude-opus-5-5' },
  prices: PRICES,
});

/**
 * The client with a fake worker: one that answers (its own module graph, by clones), fails
 * with an `error` or a `messageerror` when asked for a result, or never answers at all.
 */
async function withWorker(how: 'answers' | 'error' | 'messageerror' | 'silent') {
  vi.resetModules();
  const side = await import('./resultsHandler');
  const posted: Ask[] = [];
  const heldAtPrice: Design[][] = [];
  let held: Design[] = [];
  let ended = false;
  class FakeWorker {
    onmessage: ((e: { data: Answer }) => void) | null = null;
    onerror: (() => void) | null = null;
    onmessageerror: (() => void) | null = null;
    postMessage(m: Ask) {
      const sent = across(m);
      posted.push(sent);
      if (sent.kind === 'designs') held = sent.designs;
      if (sent.kind === 'price') heldAtPrice.push(held);
      if (how === 'silent') return;
      if (sent.kind === 'result' && how !== 'answers') {
        setTimeout(() => (how === 'error' ? this.onerror : this.onmessageerror)?.(), 0);
        return;
      }
      const a = across(side.handle(sent));
      setTimeout(() => this.onmessage?.({ data: a }), 0);
    }
    terminate() {
      ended = true;
    }
  }
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('__dhdDesignerWorker', { worker: 0, here: 0 });
  vi.resetModules();
  const client = await import('./results');
  const state = await import('./state');
  return { posted, heldAtPrice, client, state, terminated: () => ended };
}

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
    const { posted, client } = await withWorker('answers');
    const { readResult, requestResult, useResultsTick } = client;
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
    expect(counted()).toEqual({ worker: 3, here: 0 });
  });

  it("a run's trial is placed by the worker but not kept with the cards", async () => {
    const { posted, client } = await withWorker('answers');
    const design = CASES[0]?.[1] as DesignInput;
    const r = await client.trialResult(level, level, design, OPTS);
    expect(r).toEqual(designResult(level, level, design, OPTS));
    expect(Object.isFrozen(r.level)).toBe(true);
    expect(client.readResult(level, level, design, OPTS)).toBeNull();
    expect(posted.filter((m) => m.kind === 'result')).toHaveLength(2);
  });

  it('prices in the worker as the main thread does, against the versions sent first', async () => {
    const { posted, client, state, heldAtPrice } = await withWorker('answers');
    const ours = [stubDesign('dsn_a')];
    state.useDesigner.setState({ designs: ours });
    const input = priceIn();
    expect(client.readPrice('k1', () => input)).toBeUndefined();
    await vi.waitFor(() => expect(client.readPrice('k1', () => input)).not.toBeUndefined());
    const viaWorker = client.readPrice('k1', () => input);
    expect(viaWorker).toEqual(across(priceRequest({ ...input, designs: ours })));
    expect(viaWorker?.est.usd?.typical).toBeGreaterThan(0);
    // A new version goes to the worker before the next price is asked for.
    const more = [...ours, stubDesign('dsn_b')];
    state.useDesigner.setState({ designs: more });
    const fresh = await client.freshPrice(input);
    expect(fresh).toEqual(viaWorker);
    expect(posted.map((m) => m.kind)).toEqual(['models', 'designs', 'price', 'designs', 'price']);
    expect(heldAtPrice.map((d) => d.map((x) => x.id))).toEqual([['dsn_a'], ['dsn_a', 'dsn_b']]);
  });

  it.each(['error', 'messageerror'] as const)(
    'a worker that fails (%s): what was asked is answered here, and all that follows',
    async (how) => {
      const { client, terminated } = await withWorker(how);
      const design = CASES[0]?.[1] as DesignInput;
      expect(client.readResult(level, level, design, OPTS)).toBeNull();
      const r = await client.requestResult(level, level, design, OPTS);
      expect(r).toEqual(designResult(level, level, design, OPTS));
      expect(terminated()).toBe(true);
      // No worker now: the next read answers at once.
      const other = CASES[1]?.[1] as DesignInput;
      expect(client.readResult(level, level, other, OPTS)).not.toBeNull();
      // The worker answered only the models and versions; the result was worked out here.
      expect(counted()).toEqual({ worker: 2, here: 1 });
    },
  );

  it('a worker that never answers is let go after the timeout; reads fall back here', async () => {
    vi.useFakeTimers();
    try {
      const { client, terminated } = await withWorker('silent');
      const design = CASES[0]?.[1] as DesignInput;
      expect(client.readResult(level, level, design, OPTS)).toBeNull();
      const accept = client.requestResult(level, level, design, OPTS);
      const price = client.freshPrice(priceIn());
      await vi.advanceTimersByTimeAsync(client.WORKER_TIMEOUT_MS - 1);
      expect(terminated()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(terminated()).toBe(true);
      expect(await accept).toEqual(designResult(level, level, design, OPTS));
      expect((await price)?.est).toBeTruthy();
      expect(client.readResult(level, level, design, OPTS)).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a message that can't be cloned rejects and leaves nothing waiting", async () => {
    vi.useFakeTimers();
    try {
      const { client, terminated } = await withWorker('answers');
      const bad = { ...(CASES[0]?.[1] as DesignInput), id: 'dsn_bad', fn: () => {} };
      await expect(client.trialResult(level, level, bad as DesignInput, OPTS)).rejects.toThrow();
      // Its timeout went with it: the worker isn't let go for an ask that never left.
      await vi.advanceTimersByTimeAsync(client.WORKER_TIMEOUT_MS * 2);
      expect(terminated()).toBe(false);
      // The worker still answers what comes next.
      const design = CASES[0]?.[1] as DesignInput;
      const next = client.requestResult(level, level, design, OPTS);
      await vi.advanceTimersByTimeAsync(0);
      await expect(next).resolves.toBeTruthy();
      expect(counted().here).toBe(0);
    } finally {
      vi.useRealTimers();
    }
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
