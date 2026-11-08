import { type DraftDesign, type Page, type RunOptions, runDesign } from '@dhd/ai';
import { PRICES, type ProposalOption, type RunCheckpoint, sampleFlatProject } from '@dhd/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AI,
  type Phone,
  away as awayOn,
  midRun as midRunOn,
  provider,
} from '../../../../../../packages/ai/src/fixtures/runner';
import { browserPage } from '../page';
import {
  approvedLeft,
  figureHolds,
  priceRequest,
  resumeFigure,
  spentWithInflight,
} from './pricing';

/**
 * A run killed mid-step and carried on from its checkpoint, priced as the card prices it
 * (`@dhd/ai`'s runner, this app's pricing), on the browser's own page.
 */

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('a locked phone: a step cut off while away goes again on return (locked-phone runs, part 1)', () => {
  class Doc extends EventTarget {
    visibilityState: 'visible' | 'hidden' = 'visible';
  }
  let phone: Phone;
  beforeEach(() => {
    const doc = new Doc();
    vi.stubGlobal('document', doc);
    vi.stubGlobal('window', new EventTarget());
    phone = {
      page: browserPage() as Page,
      turn: (to) => {
        doc.visibilityState = to;
        doc.dispatchEvent(new Event('visibilitychange'));
      },
    };
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const turn = (to: 'visible' | 'hidden') => phone.turn(to);
  const midRun = (extra: Partial<RunOptions> = {}) => midRunOn(phone, extra);
  const away = (r: Awaited<ReturnType<typeof midRun>>['r'], cut: () => void, ms: number) =>
    awayOn(phone, r, cut, ms);

  it('killed mid-step, then carried on from its checkpoint: only the room left is asked for', async () => {
    const { prov, r, room3, of } = await midRun();
    await away(r, () => of(room3)[0]?.cut(), 11 * 60_000);
    turn('visible');
    for (const c of prov.calls) c.release();
    await r.run;
    // What the page kept: the version as last saved, and the checkpoint written with it.
    const d = r.saved.at(-1) as DraftDesign;
    const project = sampleFlatProject('prj_test');
    const option: ProposalOption = {
      letter: 'A',
      name: 'Whole flat',
      designId: d.id,
      brief: d.brief,
      aliases: d.aliases,
      concept: d.concept,
      spaces: d.spaces,
      locks: [],
      usage: d.usage,
      base: { variant: 'before', fingerprint: 'fp' },
      status: 'running',
      ticks: null,
      accepted: [],
      note: null,
      waivers: [],
      version: null,
    };
    const run: RunCheckpoint = {
      id: 'run_test',
      startedAt: new Date().toISOString(),
      at: new Date().toISOString(),
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      plan: { layout: {}, rooms: 'all' },
      layout: 'done',
      rooms: Object.keys(d.spaces),
      fixesLeft: 2,
      approved: null,
      spent: 0,
      inflight: [],
      stopped: false,
      paused: null,
      times: [],
    };
    const scope = { label: 'Whole flat', spaces: [], all: true };
    const priced = priceRequest({
      project,
      levelId: project.levels[0]?.id ?? '',
      designs: [],
      brief: d.brief,
      scope,
      words: '',
      resume: { option, run, scope },
      designId: d.id,
      opts: {},
      ai: { provider: 'anthropic', model: 'claude-opus-5-5' },
      prices: PRICES,
    });
    const left = Object.entries(d.spaces)
      .filter(([, s]) => s.status !== 'done')
      .map(([k]) => k);
    const key0 = left[0] as string;
    expect(left).toHaveLength(2);
    expect(priced?.sp.plan).toMatchObject({ layout: null, rooms: left });
    // Priced for what is left only: those two rooms' requests.
    expect(priced?.est.steps).toHaveLength(2);
    // Carry on's figure (criterion 6): those steps at their high, and the fix rounds left.
    const est = priced?.est;
    if (!est?.usd) throw new Error('not priced');
    const high = est.steps.reduce((t, s) => t + (s.usd?.high ?? 0), 0);
    expect(est.usd.high).toBeCloseTo(high, 6);
    expect(resumeFigure(est, run.fixesLeft)).toBeCloseTo(
      high + (est.usd.fix * run.fixesLeft) / est.fixes,
      6,
    );
    expect(resumeFigure(est, 0)).toBeCloseTo(high, 6);
    // Bound to the figure its button showed: priced higher now, it asks again.
    expect(figureHolds(0.4, 0.4)).toBe(true);
    expect(figureHolds(0.4, 0.39)).toBe(true);
    expect(figureHolds(0.4, 0.41)).toBe(false);
    expect(figureHolds(null, 0.4)).toBe(false);
    // By itself it may spend what is left of its figure, less what it spent and the steps
    // that were in flight at their most (a page that died mid-step never metered them).
    const cut = { ...run, approved: 1, spent: 0.2, inflight: [{ step: key0, high: 0.3 }] };
    expect(spentWithInflight(cut)).toBeCloseTo(0.5, 9);
    expect(approvedLeft(cut)).toBeCloseTo(0.5, 9);
    expect(approvedLeft({ ...cut, spent: 0.9 })).toBe(0);
    expect(approvedLeft({ ...cut, approved: null })).toBeNull();
    const prov2 = provider('anthropic', { auto: true });
    const again = await runDesign({
      ai: AI.anthropic,
      ctx: priced?.sp.ctx as RunOptions['ctx'],
      design: priced?.sp.draft as DraftDesign,
      plan: priced?.sp.plan as RunOptions['plan'],
      signal: new AbortController().signal,
      page: phone.page,
      fetch: prov2.fetch,
      fixesLeft: run.fixesLeft,
    });
    // Only the two rooms left: never the layout or a finished room again.
    expect(prov2.calls).toHaveLength(2);
    expect(prov2.calls.map((c) => c.step)).toContain(room3);
    expect(prov2.calls.some((c) => c.step === 'layout')).toBe(false);
    expect(again.state.phase).toBe('done');
    expect(Object.values(again.design.spaces).every((s) => s.status === 'done')).toBe(true);
    // Its earlier usage is kept with it, the new requests' added.
    expect(again.design.usage.length).toBe(d.usage.length + 2);
  });
});
