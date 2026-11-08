import {
  type Design,
  type DesignInput,
  type DesignOptions,
  type DesignResult,
  type LensReport,
  type Level,
  type Project,
  designResult,
  lensReports,
  setProjectModels,
} from '@dhd/core';
import { type PriceInput, type Priced, priceRequest } from './talk/pricing';

/**
 * What the designer's worker does with each message, kept apart from the worker so the same
 * code answers without one (Node tests, a browser that can't start it): a version placed and
 * checked (`designResult`, with its memos here), its lenses' lines, a press priced, and the
 * project's own models and versions kept as the main thread sends them.
 */

export type Ask =
  | {
      id: number;
      kind: 'result';
      base: Level;
      before: Level;
      design: DesignInput;
      opts: DesignOptions;
    }
  | {
      id: number;
      kind: 'lens';
      base: Level;
      before: Level;
      design: DesignInput;
      opts: DesignOptions;
    }
  | { id: number; kind: 'price'; input: Omit<PriceInput, 'designs'> }
  | { id: number; kind: 'models'; models: Project['models'] }
  | { id: number; kind: 'designs'; designs: Design[] };

export type Answer =
  | { id: number; ok: true; value: DesignResult | LensReport[] | Priced | null }
  | { id: number; ok: false; error: string };

/** The versions the main thread last sent (what a press is priced against). */
let designs: Design[] = [];

export function handle(ask: Ask): Answer {
  try {
    switch (ask.kind) {
      case 'result':
        return {
          id: ask.id,
          ok: true,
          value: designResult(ask.base, ask.before, ask.design, ask.opts),
        };
      case 'lens': {
        // The lenses' lines for a version (the storage meter's), beside its result: worked out
        // here so the cards stay off the main thread. The result is the memo's.
        const r = designResult(ask.base, ask.before, ask.design, ask.opts);
        return {
          id: ask.id,
          ok: true,
          value: lensReports(r, ask.base, ask.design.brief, ask.opts),
        };
      }
      case 'price':
        return { id: ask.id, ok: true, value: priceRequest({ ...ask.input, designs }) };
      case 'models':
        setProjectModels(ask.models);
        return { id: ask.id, ok: true, value: null };
      case 'designs':
        designs = ask.designs;
        return { id: ask.id, ok: true, value: null };
    }
  } catch (e) {
    return { id: ask.id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
