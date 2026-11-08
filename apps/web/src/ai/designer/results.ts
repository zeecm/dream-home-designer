import {
  type DesignInput,
  type DesignOptions,
  type DesignResult,
  type Level,
  designResult,
  designResultKey,
} from '@dhd/core';
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

type Waiting = { ask: Ask; resolve: (v: unknown) => void; reject: (e: Error) => void };
const waiting = new Map<number, Waiting>();
let seq = 0;
let worker: Worker | null | undefined;

function answered(a: Answer) {
  const w = waiting.get(a.id);
  waiting.delete(a.id);
  if (!w) return;
  if (a.ok) w.resolve(a.value);
  else w.reject(new Error(a.error));
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
    w.onmessage = (e: MessageEvent<Answer>) => answered(e.data);
    // A worker that fails: what it was asked is answered here, and so is all that follows.
    w.onerror = () => {
      worker = null;
      for (const x of [...waiting.values()]) answered(handle(x.ask));
    };
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
    const a = handle(full);
    return a.ok ? Promise.resolve(a.value as T) : Promise.reject(new Error(a.error));
  }
  return new Promise<T>((resolve, reject) => {
    waiting.set(full.id, { ask: full, resolve: resolve as (v: unknown) => void, reject });
    w.postMessage(full);
  });
}

const LIMIT = 24;
function keep<T>(m: Map<string, T>, key: string, v: T) {
  m.delete(key);
  m.set(key, v);
  if (m.size > LIMIT) m.delete(m.keys().next().value as string);
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
    (r) => {
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
  if (priced.has(key)) return priced.get(key) ?? null;
  if (pricing.has(key)) return undefined;
  const i = input();
  if (!i) return null;
  const p = freshPrice(i).then(
    (v) => {
      keep(priced, key, v);
      pricing.delete(key);
      bump();
      return v;
    },
    () => {
      keep(priced, key, null);
      pricing.delete(key);
      bump();
      return null;
    },
  );
  pricing.set(key, p);
  // Answered here at once (no worker): read it now.
  return priced.has(key) ? (priced.get(key) ?? null) : undefined;
}

/** Re-renders when an answer lands (put it in the deps of what reads the cache). */
export const useResultsTickN = () => useResultsTick((s) => s.n);
