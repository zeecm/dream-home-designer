import {
  type DesignInput,
  Level,
  type Lock,
  type SpaceDesign,
  designResult,
  runReport,
  stableJson,
} from '@dhd/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import owner from '../../core/src/designer/fixtures/owner-after-accept.json' with { type: 'json' };
import { AI, USAGE } from './fixtures/flat';
import { promptOf } from './fixtures/sample';
import { anthropicStream } from './fixtures/streams';
import { runDesign } from './run';

/**
 * The owner's conversation of 9 Nov, replayed through the runner (spec
 * docs/specs/designer-listens.md, criterion 30). The fixture is the trimmed export the earlier
 * parts made (`owner-after-accept.json`: both levels, the brief, V5 to V9's stored answers; no
 * key, no prices). Each of V6 to V9's rooms is asked of a provider scripted with the export's own
 * answer, and every fix round gets that same answer again, as the owner's runs did. With parts 1
 * and 2 the version comes back with a bed in Main bedroom and seats in the living room (kept
 * pieces or the app's free fixes), every hard failure left is in the report with a reason, and no
 * fix round is spent on an answer the same as the one before it.
 */

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});
afterEach(() => {
  vi.useRealTimers();
});

const plan = Level.parse(owner.plan);
const after = Level.parse(owner.after);
type P = (typeof owner.proposals)[number];
const input = (p: P) => p.design as unknown as DesignInput & { request?: { locks?: Lock[] } };

/** The provider, scripted: each room step and each fix round answers with the export's answer. */
function scripted(d: DesignInput) {
  const calls: { step: string; fix: boolean; body: string }[] = [];
  const byName = new Map(
    Object.values(d.spaces).flatMap((s) => (s.design ? [[s.name, s.design] as const] : [])),
  );
  const fetch: typeof globalThis.fetch = (async (
    _url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const text = promptOf(body);
    const name = /furnish "([^"]+)"/.exec(text)?.[1] ?? '';
    const answer = byName.get(name) as SpaceDesign | undefined;
    calls.push({ step: name, fix: text.includes('## Fix round'), body: text });
    if (!answer) throw new Error(`no recorded answer for ${name || 'this request'}`);
    return new Response(anthropicStream(answer, USAGE), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

describe('the owner’s conversation, replayed through the runner (criterion 30)', () => {
  const later = owner.proposals.filter((p) => p.base === 'after');

  it('has V6 to V9, each asked for Main bedroom and the living room', () => {
    expect(later.map((p) => p.n)).toEqual([6, 7, 8, 9]);
    for (const p of later) expect(Object.keys(input(p).spaces)).toHaveLength(2);
  });

  for (const p of later) {
    it(`V${p.n}: a bed in Main bedroom, seats in the living room; every failure left named with a reason; no round on the same answer`, async () => {
      const d = input(p);
      const prov = scripted(d);
      const rooms = Object.keys(d.spaces);
      const ctrl = new AbortController();
      const run = runDesign({
        ai: AI.anthropic,
        ctx: { base: after, before: plan, brief: d.brief, aliases: d.aliases },
        design: {
          id: d.id,
          brief: d.brief,
          aliases: d.aliases,
          concept: d.concept,
          spaces: {},
          usage: [],
        },
        plan: { layout: null, rooms, ...(d.request?.locks ? { locks: d.request.locks } : {}) },
        signal: ctrl.signal,
        fetch: prov.fetch,
      });
      let done = false;
      void run.finally(() => {
        done = true;
      });
      for (let i = 0; i < 2000 && !done; i++) await vi.advanceTimersByTimeAsync(50);
      const { state, design } = await run;
      expect(state.phase).toBe('done');
      const r = designResult(after, plan, design);
      const hard = r.checks.filter((c) => c.hard && !c.already);
      // A bed for the couple in Main bedroom, and the living room seats them.
      expect(hard.filter((c) => c.key.startsWith('P1|bed|')).map((c) => c.text)).toEqual([]);
      expect(hard.filter((c) => c.key.startsWith('P1|seats|')).map((c) => c.text)).toEqual([]);
      const main = Object.values(r.level.items).filter((it) => {
        const ref = r.refs[it.id];
        return !!ref && /^bed-/.test(it.assetId);
      });
      expect(main.length).toBeGreaterThanOrEqual(1);
      // Every hard failure left is in the report, in words, and each has its reason: the app's
      // own text, and a measured cause or the tries where it has one.
      const rep = runReport(r, design);
      const named = new Set(rep.failures.flatMap((f) => f.keys));
      for (const c of hard) expect(named.has(c.key), c.key).toBe(true);
      // Its reason: the measured cause, else the app's own numbers in its words ("narrows the
      // way through to 0.75 m: 0.90 m needed").
      for (const f of rep.failures)
        expect(!!f.cause || /\d\.\d\d m/.test(f.says), f.says).toBe(true);
      // No fix round is spent on an answer the same as the one before it: the export's answer
      // sent back again stalls the room (its round says so), and no further round goes.
      for (const key of rooms) {
        const s = design.spaces[key];
        const rounds = s?.rounds ?? [];
        const sent = prov.calls.filter((c) => c.step === s?.name && c.fix).length;
        expect(rounds.filter((x) => x.outcome === 'fixed')).toEqual([]);
        expect(rounds.every((x) => x.outcome === 'no-better')).toBe(true);
        expect(sent).toBeLessThanOrEqual(1);
        expect(rounds.length).toBe(sent);
      }
      // What was asked is what the export answered: the stored answers stand (plus the app's).
      for (const key of rooms) {
        const own = (design.spaces[key]?.design?.items ?? []).filter(
          (i) => !i.ref.startsWith('app:'),
        );
        const was = d.spaces[key]?.design?.items ?? [];
        expect(own.map((i) => i.ref).sort()).toEqual(
          was
            .map((i) => i.ref)
            .filter((ref) => own.some((o) => o.ref === ref))
            .sort(),
        );
      }
      expect(stableJson(state.usage.length)).toBe(String(prov.calls.length));
    }, 60_000);
  }
});
