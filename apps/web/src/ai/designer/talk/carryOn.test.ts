import { type DraftDesign, type Page, type RunOptions, runDesign } from '@dhd/ai';
import {
  type Level,
  NO_LOOK,
  type OptionLook,
  PRICES,
  type ProposalOption,
  type RunCheckpoint,
  atMostOf,
  defaultBrief,
  designResult,
  sampleFlatProject,
} from '@dhd/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AI,
  type Phone,
  USAGE,
  away as awayOn,
  midRun as midRunOn,
  provider,
} from '../../../../../../packages/ai/src/fixtures/runner';
import { answerFor, promptOf } from '../../../../../../packages/ai/src/fixtures/sample';
import { anthropicStream } from '../../../../../../packages/ai/src/fixtures/streams';
import { browserPage } from '../page';
import {
  LOOK_STOP_NOTE,
  approvedLeft,
  figureHolds,
  fixRoomsOf,
  lookAtEnd,
  priceRequest,
  resumeFigure,
  spentWithInflight,
  stepHigh,
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
      look: null,
    };
    const run: RunCheckpoint = {
      id: 'run_test',
      startedAt: new Date().toISOString(),
      at: new Date().toISOString(),
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      plan: { layout: {}, rooms: 'all' },
      layout: 'done',
      look: 'left',
      rooms: Object.keys(d.spaces),
      fixesLeft: 2,
      fixing: {},
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
    // Priced for what is left only: those two rooms' requests (and, Thorough with a model that
    // can see, the second look it still ends with).
    expect(priced?.est.steps.filter((s) => s.kind === 'room')).toHaveLength(2);
    expect(priced?.est.steps.map((s) => s.kind)).toEqual(['room', 'room', 'look']);
    // A look that already answered (or a checkpoint from before there was one): never again.
    const kindsFor = (r: RunCheckpoint) =>
      priceRequest({
        project,
        levelId: project.levels[0]?.id ?? '',
        designs: [],
        brief: d.brief,
        scope,
        words: '',
        resume: { option, run: r, scope },
        designId: d.id,
        opts: {},
        ai: { provider: 'anthropic', model: 'claude-opus-5-5' },
        prices: PRICES,
      })?.est.steps.map((s) => s.kind);
    expect(kindsFor({ ...run, look: 'done' })).toEqual(['room', 'room']);
    const { look: _none, ...older } = run;
    expect(kindsFor(older)).toEqual(['room', 'room']);
    // Carry on's figure (criterion 6): those steps at their high, and the fix rounds left.
    const est = priced?.est;
    if (!est?.usd) throw new Error('not priced');
    const high = est.steps.reduce((t, s) => t + (s.usd?.high ?? 0), 0);
    expect(est.usd.high).toBeCloseTo(high, 6);
    // Priced for the pool it has left (two fix-ups), at the dearest fix request.
    expect(est.fixes).toBe(run.fixesLeft);
    expect(resumeFigure(est, run.fixesLeft)).toBeCloseTo(high + est.usd.fixOne * run.fixesLeft, 6);
    expect(resumeFigure(est, run.fixesLeft)).toBeCloseTo(high + est.usd.fix, 6);
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

describe('the look an option ends with (lookAtEnd)', () => {
  const found: OptionLook = {
    state: 'done',
    summary: 'Calm.',
    notes: ['Its round didn’t finish, so the rooms are as the first answers left them.'],
    findings: [],
    dropped: [],
    offers: [],
    round: 'none',
    line: null,
    at: '2026-11-14T00:00:00.000Z',
  };
  const base = {
    looked: null,
    run: {},
    brief: { quality: 'thorough' },
    ai: { provider: 'anthropic' as const, model: 'claude-opus-5-5' },
    phase: 'done',
    stopped: false,
    at: '2026-11-14T00:00:00.000Z',
  };

  it('carried on after the look answered: what the checkpoint kept, never nothing', () => {
    expect(lookAtEnd({ ...base, run: { lookResult: found } })).toEqual({
      look: found,
      stopNote: null,
    });
    // The run's own, when it has one.
    const own = { ...found, summary: 'Own.' };
    expect(lookAtEnd({ ...base, looked: own, run: { lookResult: found } }).look).toBe(own);
    // None at all: none (Thorough, a model that can see).
    expect(lookAtEnd(base).look).toBeNull();
    // A model that can't see says so.
    expect(lookAtEnd({ ...base, ai: { provider: 'openai', model: 'gpt-4.1' } }).look?.line).toBe(
      NO_LOOK,
    );
  });

  it('stopped during the look, every room done: the log says so; stopped part-way: not this line', () => {
    expect(lookAtEnd({ ...base, run: { lookResult: found }, stopped: true }).stopNote).toBe(
      LOOK_STOP_NOTE,
    );
    expect(
      lookAtEnd({ ...base, run: { lookResult: found }, stopped: true, phase: 'stopped' }).stopNote,
    ).toBeNull();
    expect(lookAtEnd({ ...base, stopped: true }).stopNote).toBeNull();
  });
});

describe('the fix-up pool, priced as it is spent (designer listens B2, criteria 18 and 19)', () => {
  const project = sampleFlatProject('prj_test');
  const levelId = project.levels[0]?.id ?? '';
  const lvl = project.levels[0] as Level;
  const spaces = designResult(lvl, lvl, {
    id: 'dsn_x',
    brief: defaultBrief(),
    aliases: {},
    concept: null,
    spaces: {},
  }).spaces;
  const keyOf = (name: RegExp) => spaces.find((s) => name.test(s.name))?.key as string;
  const living = keyOf(/^Living/);
  const main = keyOf(/^Main bedroom/);
  const scope = { label: 'Two rooms', spaces: [living, main], all: false };
  const ai = { provider: 'anthropic' as const, model: 'claude-opus-5-5' };
  const priced = (extra: Partial<Parameters<typeof priceRequest>[0]> = {}) =>
    priceRequest({
      project,
      levelId,
      designs: [],
      brief: defaultBrief(),
      scope,
      words: '',
      designId: 'dsn_pool',
      opts: {},
      ai,
      prices: PRICES,
      ...extra,
    });
  /** Placed and checked, with as many made-up hard failures as an answer's summary says. */
  const scripted: NonNullable<RunOptions['results']> = async (base, before, d, opts) => {
    const r = designResult(base, before, d, opts);
    const extra = r.spaces.flatMap((s) => {
      const m = /fails (\d+)/.exec((s.storedKey && d.spaces[s.storedKey]?.design?.summary) || '');
      const room = s.rooms[0];
      if (!m || !room) return [];
      return Array.from({ length: Number(m[1]) }, (_, i) => ({
        key: `P2|madeup|${room}|f${i}`,
        principle: 'P2' as const,
        hard: true,
        waivable: true,
        text: `Made-up failure ${i}.`,
        roomId: room,
        already: false,
        part: null,
      }));
    });
    return { ...r, checks: [...r.checks, ...extra] };
  };
  /** Every room keeps getting better and never passes: each answer fails one fewer. */
  const better = (from = 10) =>
    provider('anthropic', {
      auto: true,
      reply: (c, n) =>
        new Response(
          anthropicStream(
            {
              ...(answerFor(promptOf(c.body))?.answer as Record<string, unknown>),
              summary: `fails ${from - n}`,
            },
            USAGE,
          ),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
    });

  it('every room progressing: the pool is what is sent, and what is reserved never passes the figure', async () => {
    const made = priced();
    const est = made?.est;
    if (!made || !est?.usd) throw new Error('not priced');
    // Thorough: the pool of three at the dearest room's fix request.
    expect(est.fixes).toBe(3);
    expect(est.usd.fix).toBeCloseTo(3 * est.usd.fixOne, 9);
    const figure = atMostOf(est) as number;
    let committed = 0;
    let asked = 0;
    const prov = better();
    const { state, design } = await runDesign({
      ai: AI.anthropic,
      ctx: made.sp.ctx,
      design: made.sp.draft,
      plan: made.sp.plan,
      signal: new AbortController().signal,
      fetch: prov.fetch,
      results: scripted,
      fixesLeft: est.fixes,
      onStep: (key, kind, phase) => {
        if (phase === 'start') committed += stepHigh(est, key, kind);
      },
      overLimit: (next) => !!next && committed + stepHigh(est, next.key, next.kind) > figure + 1e-9,
      confirmOver: async () => {
        asked++;
        return false;
      },
    });
    expect(state.phase).toBe('done');
    // Never asked: the figure holds the rooms and the whole pool, however it is shared.
    expect(asked).toBe(0);
    expect(committed).toBeLessThanOrEqual(figure + 1e-9);
    const fixes = prov.calls.filter((c) => promptOf(c.body).includes('## Fix round'));
    expect(fixes).toHaveLength(3);
    expect(prov.calls).toHaveLength(2 + 3);
    // Keep fixing is offered from where the pool ran out (a room still progressing).
    expect(fixRoomsOf({ spaces: design.spaces })).not.toEqual([]);
    // Each fix round is reserved at its own room's fix request, never more than the dearest.
    for (const k of [living, main]) {
      expect(stepHigh(est, k, 'fix')).toBeLessThanOrEqual(est.usd.fixOne + 1e-12);
      expect(stepHigh(est, k, 'fix')).toBeGreaterThan(0);
    }
    expect(stepHigh(est, 'look', 'fix')).toBeCloseTo(est.usd.fixOne, 12);
  });

  it('Fix every check first (C, 27–29): priced for 6 fix-ups; every room progressing sends 6, the figure never passed', async () => {
    const plain = priced()?.est;
    const made = priced({ brief: { ...defaultBrief(), fixAll: true } });
    const est = made?.est;
    if (!made || !est?.usd || !plain?.usd) throw new Error('not priced');
    expect(est.fixes).toBe(6);
    expect(est.usd.fix).toBeCloseTo(6 * est.usd.fixOne, 9);
    // The same rooms at the same price, only the pool larger: what it adds is 3 more fix-ups.
    expect(est.usd.high).toBeCloseTo(plain.usd.high, 9);
    expect(est.usd.fix - plain.usd.fix).toBeCloseTo(3 * est.usd.fixOne, 9);
    const figure = atMostOf(est) as number;
    let committed = 0;
    let asked = 0;
    const prov = better();
    const { state } = await runDesign({
      ai: AI.anthropic,
      ctx: made.sp.ctx,
      design: made.sp.draft,
      plan: made.sp.plan,
      signal: new AbortController().signal,
      fetch: prov.fetch,
      results: scripted,
      fixesLeft: est.fixes,
      onStep: (key, kind, phase) => {
        if (phase === 'start') committed += stepHigh(est, key, kind);
      },
      overLimit: (next) => !!next && committed + stepHigh(est, next.key, next.kind) > figure + 1e-9,
      confirmOver: async () => {
        asked++;
        return false;
      },
    });
    expect(state.phase).toBe('done');
    expect(asked).toBe(0);
    expect(committed).toBeLessThanOrEqual(figure + 1e-9);
    expect(prov.calls.filter((c) => promptOf(c.body).includes('## Fix round'))).toHaveLength(6);
    expect(prov.calls).toHaveLength(2 + 6);
    // Keep fixing on a strict option prices its own strict pool for its rooms.
    expect(
      priced({ brief: { ...defaultBrief(), quality: 'quick', fixAll: true } })?.est.fixes,
    ).toBe(4);
  });

  it('Keep fixing: its rooms’ fix rounds alone, at most the pool at the dearest; the run on it', async () => {
    const made = priced();
    if (!made) throw new Error('not priced');
    const first = await runDesign({
      ai: AI.anthropic,
      ctx: made.sp.ctx,
      design: made.sp.draft,
      plan: made.sp.plan,
      signal: new AbortController().signal,
      fetch: better().fetch,
      results: scripted,
      fixesLeft: 1,
    });
    const option = optionOf(first.design);
    // One fix-up for two rooms: one took it, and both ran out still failing.
    const rooms = fixRoomsOf(option);
    expect([...rooms].sort()).toEqual([living, main].sort());
    const fixing = priced({ keepFixing: { option, words: '', scope } });
    const est = fixing?.est;
    if (!fixing || !est?.usd) throw new Error('not priced');
    expect(fixing.sp.plan).toMatchObject({ layout: null, rooms, fixOnly: rooms });
    // No room step goes: nothing at a room's high, the pool Thorough gives two rooms.
    expect(est.usd.high).toBe(0);
    expect(est.fixes).toBe(3);
    expect(atMostOf(est)).toBeCloseTo(3 * est.usd.fixOne, 9);
    expect(est.steps.map((s) => s.step).sort()).toEqual([...rooms].sort());
    // The designer's next answers, better than those it gave before.
    const prov = better(7);
    const { design } = await runDesign({
      ai: AI.anthropic,
      ctx: fixing.sp.ctx,
      design: fixing.sp.draft,
      plan: fixing.sp.plan,
      signal: new AbortController().signal,
      fetch: prov.fetch,
      results: scripted,
      fixesLeft: est.fixes,
    });
    // Fix rounds only, three, on the stored answers; each room's "ran out" answered, and said
    // again where it ran out again.
    expect(prov.calls).toHaveLength(3);
    expect(prov.calls.every((c) => promptOf(c.body).includes('## Fix round'))).toBe(true);
    const outcomes = rooms.map((k) => design.spaces[k]?.rounds?.map((x) => x.outcome) ?? []);
    expect(outcomes.flat().filter((x) => x === 'fixed')).toHaveLength(1 + 3);
    for (const o of outcomes) {
      expect(o.filter((x) => x === 'no-fixups')).toHaveLength(1);
      expect(o.at(-1)).toBe('no-fixups');
    }
  });

  it('carried on in a room’s rounds: fix rounds only, priced for the fix-ups it has left', () => {
    const made = priced();
    if (!made) throw new Error('not priced');
    const option = optionOf({
      ...made.sp.draft,
      spaces: {
        ...made.sp.draft.spaces,
        [living]: {
          name: 'Living',
          status: 'done',
          design: answerFor('furnish "Living')?.answer as never,
          fixes: 1,
          fixed: 1,
          rounds: [{ outcome: 'fixed', before: 3, after: 2 }],
        },
      },
    });
    const run: RunCheckpoint = {
      id: 'run_b2',
      startedAt: new Date().toISOString(),
      at: new Date().toISOString(),
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      plan: { layout: null, rooms: [living, main] },
      layout: 'none',
      rooms: [living, main],
      fixesLeft: 2,
      fixing: { [living]: { left: 0, settled: false } },
      approved: null,
      spent: 0,
      inflight: [],
      stopped: false,
      paused: null,
      times: [],
    };
    const again = priced({ resume: { option, run, scope } });
    if (!again?.est.usd) throw new Error('not priced');
    expect(again.sp.plan).toMatchObject({ rooms: [living, main], fixOnly: [living] });
    expect(again.est.fixes).toBe(2);
    // The living room's own request isn't priced again: only the main bedroom's room step.
    const own = (k: string) => again.est.steps.find((s) => s.step === k)?.usd;
    expect(own(living)?.high).toBe(0);
    expect(own(main)?.high).toBeGreaterThan(0);
    expect(resumeFigure(again.est, run.fixesLeft)).toBeCloseTo(atMostOf(again.est) as number, 9);
    // A settled room isn't carried on at all.
    const settled = priced({
      resume: { option, run: { ...run, fixing: { [living]: { left: 0, settled: true } } }, scope },
    });
    expect(settled?.sp.plan.rooms).toEqual([main]);
    expect(settled?.sp.plan.fixOnly).toBeUndefined();
  });

  it('Keep fixing carried on: a room still queued (no place in the pool yet) goes on too (S3)', () => {
    const made = priced();
    if (!made) throw new Error('not priced');
    const answered = (k: string) => ({
      name: k,
      status: 'done' as const,
      design: answerFor(k === living ? 'furnish "Living' : 'furnish "Main bedroom"')
        ?.answer as never,
      rounds: [{ outcome: 'no-fixups' as const, before: 2, after: 2 }],
    });
    const option = optionOf({
      ...made.sp.draft,
      spaces: { [living]: answered(living), [main]: answered(main) },
    });
    // Keep fixing for both rooms; the page went while the first was in its rounds and the
    // second hadn't started.
    const run: RunCheckpoint = {
      id: 'run_kf',
      startedAt: new Date().toISOString(),
      at: new Date().toISOString(),
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      plan: { layout: null, rooms: [living, main], fixOnly: [living, main] },
      layout: 'none',
      rooms: [living, main],
      fixesLeft: 2,
      fixing: { [living]: { left: 0, settled: false } },
      approved: null,
      spent: 0,
      inflight: [],
      stopped: false,
      paused: null,
      times: [],
    };
    const again = priced({ resume: { option, run, scope } });
    expect(again?.sp.plan).toMatchObject({ rooms: [living, main], fixOnly: [living, main] });
    expect(again?.est.usd?.high).toBe(0);
    expect(again?.est.fixes).toBe(2);
    // One settled is left out; the queued one still goes.
    const one = priced({
      resume: { option, run: { ...run, fixing: { [living]: { left: 0, settled: true } } }, scope },
    });
    expect(one?.sp.plan).toMatchObject({ rooms: [main], fixOnly: [main] });
  });
});

/** An option holding a run's version, as the proposal keeps it. */
function optionOf(d: DraftDesign): ProposalOption {
  return {
    letter: 'A',
    name: 'Two rooms',
    designId: d.id,
    brief: d.brief,
    aliases: d.aliases,
    concept: d.concept,
    spaces: d.spaces,
    locks: [],
    usage: d.usage,
    base: { variant: 'before', fingerprint: 'fp' },
    status: 'checked',
    ticks: null,
    accepted: [],
    note: null,
    waivers: [],
    version: null,
    look: null,
  };
}
