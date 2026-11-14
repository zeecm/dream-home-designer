import {
  type DesignInput,
  type DesignOptions,
  type DesignResult,
  type FreeOptions,
  type FreeOutcome,
  type LensReport,
  type Level,
  designResult,
  designResultKey,
  freeEssentials,
  lensReports,
} from '@dhd/core';
import { freeze } from 'immer';
import { create } from 'zustand';
import { useStore } from '../../store';
import { type Answer, type Ask, handle } from './resultsHandler';
import { useDesigner } from './state';
import type { PriceInput, Priced } from './talk/pricing';

/**
 * The designer's results off the main thread: a version placed and checked on the plan, and a
 * press priced, by a module worker that owns the memos. Here, a small cache keyed as
 * `designResult` keys its own, read at once (null while it is worked out: show a calm pending
 * state); `useResultsTick` re-renders what reads it when an answer arrives. Without a worker
 * (Node tests, a browser that can't start one) the same code answers here, as before.
 */

/** Bumped whenever an answer lands: what read a result or a price reads it again. */
export const useResultsTick = create(() => ({ n: 0 }));
const bump = () => useResultsTick.setState((s) => ({ n: s.n + 1 }));

/** A message before it has its id. */
type Unsent = { [K in Ask['kind']]: Omit<Extract<Ask, { kind: K }>, 'id'> }[Ask['kind']];

type Waiting = {
  ask: Ask;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
const waiting = new Map<number, Waiting>();
let seq = 0;
let worker: Worker | null | undefined;

/** How long one ask may take in the worker before it is given up on (and the worker with it). */
export const WORKER_TIMEOUT_MS = 12_000;

/**
 * Counted only when a test asks (it sets `window.__dhdDesignerWorker`): asks the worker
 * answered, and asks answered here on the main thread.
 */
type Counts = { worker: number; here: number };
const counts = () => (globalThis as { __dhdDesignerWorker?: Counts }).__dhdDesignerWorker;

/**
 * An ask answered here, on the main thread (no worker, or it failed): a price is worked out
 * against the versions as they are now, which the worker would have been sent.
 */
function here(ask: Ask): Answer {
  if (ask.kind === 'price')
    handle({ id: 0, kind: 'designs', designs: useDesigner.getState().designs });
  const c = counts();
  if (c) c.here++;
  return handle(ask);
}

function answered(a: Answer) {
  const w = waiting.get(a.id);
  waiting.delete(a.id);
  if (!w) return;
  clearTimeout(w.timer);
  if (a.ok) w.resolve(a.value);
  else w.reject(new Error(a.error));
}

/**
 * The worker failed, can't read what it was sent, or hung or died without a word (an
 * out-of-memory kill fires nothing): it is let go, what it was asked is answered here, and so
 * is all that follows.
 */
function giveUp(w: Worker) {
  if (worker !== w) return;
  worker = null;
  w.terminate();
  for (const x of [...waiting.values()]) answered(here(x.ask));
}

/** The worker, started once with the project's models and versions; null where it can't be. */
function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  if (typeof Worker === 'undefined' || typeof window === 'undefined') {
    worker = null;
    return null;
  }
  try {
    const w = new Worker(new URL('./results.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<Answer>) => {
      const c = counts();
      if (c) c.worker++;
      answered(e.data);
    };
    w.onerror = () => giveUp(w);
    w.onmessageerror = () => giveUp(w);
    worker = w;
    tell({ kind: 'models', models: useStore.getState().editor.doc.models });
    tell({ kind: 'designs', designs: useDesigner.getState().designs });
    useStore.subscribe((s, p) => {
      if (s.editor.doc.models !== p.editor.doc.models) {
        tell({ kind: 'models', models: s.editor.doc.models });
      }
    });
    useDesigner.subscribe((s, p) => {
      if (s.designs !== p.designs) tell({ kind: 'designs', designs: s.designs });
    });
  } catch {
    worker = null;
  }
  return worker;
}

/** Keeps the worker's copy of the models and versions (sent in order with what follows). */
function tell(ask: Extract<Unsent, { kind: 'models' | 'designs' }>) {
  void send(ask).catch(() => {});
}

function send<T>(ask: Unsent): Promise<T> {
  const full = { ...ask, id: ++seq } as Ask;
  const w = getWorker();
  if (!w) {
    const a = here(full);
    return a.ok ? Promise.resolve(a.value as T) : Promise.reject(new Error(a.error));
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => giveUp(w), WORKER_TIMEOUT_MS);
    waiting.set(full.id, { ask: full, resolve: resolve as (v: unknown) => void, reject, timer });
    try {
      w.postMessage(full);
    } catch (e) {
      // Not cloneable: nothing went, so nothing is waited for.
      waiting.delete(full.id);
      clearTimeout(timer);
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

/** Few: a result holds a whole level (the cards on the table, Compare's pair, the preview). */
const LIMIT = 12;
function keep<T>(m: Map<string, T>, key: string, v: T) {
  m.delete(key);
  m.set(key, v);
  if (m.size > LIMIT) m.delete(m.keys().next().value as string);
}

/** Frozen again, as designResult leaves it (a clone isn't): memos on frozen levels hold here. */
const frozen = (r: DesignResult): DesignResult => freeze(r, true);

/**
 * A version placed and checked once, not kept (a run's per-room trials: each is asked once,
 * and keeping them would push the cards' results out).
 */
export function trialResult(
  base: Level,
  before: Level,
  design: DesignInput,
  opts: DesignOptions = {},
): Promise<DesignResult> {
  const hit = results.get(designResultKey(base, before, design, opts));
  if (hit) return Promise.resolve(hit);
  return send<DesignResult>({ kind: 'result', base, before, design, opts }).then(frozen);
}

const results = new Map<string, DesignResult>();
const placing = new Map<string, Promise<DesignResult>>();

/** A version placed and checked on `base`: from the worker, worked out once per key. */
export function requestResult(
  base: Level,
  before: Level,
  design: DesignInput,
  opts: DesignOptions = {},
): Promise<DesignResult> {
  const key = designResultKey(base, before, design, opts);
  const hit = results.get(key);
  if (hit) return Promise.resolve(hit);
  const going = placing.get(key);
  if (going) return going;
  const p = send<DesignResult>({ kind: 'result', base, before, design, opts }).then(
    (sent) => {
      const r = frozen(sent);
      keep(results, key, r);
      placing.delete(key);
      bump();
      return r;
    },
    (e) => {
      placing.delete(key);
      throw e;
    },
  );
  placing.set(key, p);
  return p;
}

/**
 * The result if it is here; else null, and it is asked for (`useResultsTick` says when it
 * lands). Without a worker it is worked out at once, as it always was.
 */
export function readResult(
  base: Level,
  before: Level,
  design: DesignInput,
  opts: DesignOptions = {},
): DesignResult | null {
  const key = designResultKey(base, before, design, opts);
  const hit = results.get(key);
  if (hit) return hit;
  if (!getWorker()) {
    const r = designResult(base, before, design, opts);
    keep(results, key, r);
    return r;
  }
  void requestResult(base, before, design, opts).catch(() => {});
  return null;
}

const lenses = new Map<string, LensReport[]>();
const looking = new Set<string>();

/**
 * A version's lens lines (the storage meter's) on `base`, if they are here; else null, and
 * they are asked for, keyed as its result (`useResultsTick` says when they land).
 */
export function readLens(
  base: Level,
  before: Level,
  design: DesignInput,
  opts: DesignOptions = {},
): LensReport[] | null {
  const key = designResultKey(base, before, design, opts);
  const hit = lenses.get(key);
  if (hit) return hit;
  if (!getWorker()) {
    const v = lensReports(designResult(base, before, design, opts), base, design.brief, opts);
    keep(lenses, key, v);
    return v;
  }
  if (looking.has(key)) return null;
  looking.add(key);
  send<LensReport[]>({ kind: 'lens', base, before, design, opts }).then(
    (v) => {
      keep(lenses, key, freeze(v, true));
      looking.delete(key);
      bump();
    },
    () => looking.delete(key),
  );
  return null;
}

/**
 * A version's free fixes (the missing essentials its must-have checks need), from the worker:
 * a run's room asks once (`trialFree`, not kept); a card's dry run reads them (`readFree`, kept
 * by the result's key and what it was asked for), and a press asks afresh (`requestFree`).
 */
export function trialFree(
  base: Level,
  before: Level,
  design: DesignInput,
  opts: DesignOptions | undefined,
  o: FreeOptions,
): Promise<FreeOutcome> {
  return send<FreeOutcome>({ kind: 'free', base, before, design, opts: opts ?? {}, o });
}

const frees = new Map<string, FreeOutcome>();
const freeing = new Set<string>();
const freeKey = (
  base: Level,
  before: Level,
  design: DesignInput,
  opts: DesignOptions,
  o: FreeOptions,
) =>
  `${designResultKey(base, before, design, opts)}|${JSON.stringify([o.spaces ?? null, o.declined ?? []])}`;

/** A card's dry run: its free fixes if they are here; else null, and they are asked for. */
export function readFree(
  base: Level,
  before: Level,
  design: DesignInput,
  opts: DesignOptions,
  o: FreeOptions,
): FreeOutcome | null {
  const key = freeKey(base, before, design, opts, o);
  const hit = frees.get(key);
  if (hit) return hit;
  if (!getWorker()) {
    const v = freeEssentials(base, before, design, opts, o);
    keep(frees, key, v);
    return v;
  }
  if (freeing.has(key)) return null;
  freeing.add(key);
  trialFree(base, before, design, opts, o).then(
    (v) => {
      keep(frees, key, freeze(v, true));
      freeing.delete(key);
      bump();
    },
    () => freeing.delete(key),
  );
  return null;
}

/** The free fixes worked out now, waited for (a press of Place … · free). */
export function requestFree(
  base: Level,
  before: Level,
  design: DesignInput,
  opts: DesignOptions,
  o: FreeOptions,
): Promise<FreeOutcome> {
  const key = freeKey(base, before, design, opts, o);
  const hit = frees.get(key);
  return hit ? Promise.resolve(hit) : trialFree(base, before, design, opts, o);
}

const priced = new Map<string, Priced>();
const pricing = new Map<string, Promise<Priced>>();

/** A press priced by the worker, always afresh (what a press goes ahead with). */
export function freshPrice(input: Omit<PriceInput, 'designs'>): Promise<Priced> {
  return send<Priced>({ kind: 'price', input });
}

/**
 * A price for a button or a card, by `key`: the price, null when it can't be priced, or
 * undefined while it is worked out (asked for now; `useResultsTick` says when it lands).
 */
export function readPrice(
  key: string,
  input: () => Omit<PriceInput, 'designs'> | null,
): Priced | undefined {
  // A price that failed is still being worked out (a skeleton shows), and is asked again soon.
  const failed = failedAt.get(key);
  if (failed !== undefined) {
    if (Date.now() - failed <= RETRY_MS) return undefined;
    failedAt.delete(key);
    priced.delete(key);
  }
  if (priced.has(key)) return priced.get(key) ?? null;
  if (pricing.has(key)) return undefined;
  const i = input();
  if (!i) return null;
  if (!getWorker()) {
    // Worked out at once, as it always was.
    const a = here({ id: 0, kind: 'price', input: i });
    const v = a.ok ? (a.value as Priced) : null;
    keep(priced, key, v);
    return v;
  }
  const p = freshPrice(i).then(
    (v) => {
      keep(priced, key, v);
      pricing.delete(key);
      bump();
      return v;
    },
    () => {
      // Not priced this time (the worker let go, say): asked again after a pause, never left
      // as a button with no price.
      keep(priced, key, null);
      failedAt.set(key, Date.now());
      pricing.delete(key);
      bump();
      // What shows it reads it again then, and asks.
      setTimeout(bump, RETRY_MS + 50);
      return null;
    },
  );
  pricing.set(key, p);
  return undefined;
}

/** When each price that failed did (asked again after `RETRY_MS`). */
const failedAt = new Map<string, number>();
const RETRY_MS = 2000;

/** Re-renders when an answer lands (put it in the deps of what reads the cache). */
export const useResultsTickN = () => useResultsTick((s) => s.n);
