import { describe, expect, it } from 'vitest';
import { SAMPLE_KEYS, sampleAnswers, sampleDesign, sampleLevel, tanBrief } from './fixtures/sample';
import {
  blockingHead,
  dependsKey,
  failureSigs,
  notMetHead,
  repeatAhead,
  repeatRun,
  repeatWords,
  sameFailures,
  versionsWords,
} from './repeat';
import { runReport } from './report';
import { designResult } from './result';
import type { DesignBrief } from './schema';

/**
 * No paying again for the same failures (spec docs/specs/designer-listens.md §5, criterion 22):
 * the same failures across runs by principle, code, room and role, whatever the new item ids.
 */

const level = sampleLevel();
const couple: DesignBrief = {
  ...tanBrief(),
  household: { ...tanBrief().household, children: [], elders: [] },
};

/** The sample flat with the main bedroom's bed kept as a piece the plan lacks, and the sofa gone. */
function version(id: string, o: { sofa?: boolean; bed?: boolean } = {}) {
  const answers = sampleAnswers(level);
  const main = answers[SAMPLE_KEYS.main];
  const living = answers[SAMPLE_KEYS.living];
  if (!main || !living) throw new Error('sample answers');
  if (!o.bed) main.items = main.items.map((i) => (i.ref === 'bed1' ? { ...i, keep: 'P99' } : i));
  if (!o.sofa)
    living.items = living.items.map((i) => (i.ref === 'sofa1' ? { ...i, assetId: 'sofa-999' } : i));
  const d = { ...sampleDesign({ level, answers, brief: couple }), id };
  const r = designResult(level, level, d);
  return { d, r, rep: runReport(r, d) };
}

describe('sameFailures (criterion 22)', () => {
  const v7 = version('dsn_v7');
  const v8 = version('dsn_v8');

  it('matches two runs with new item ids by principle, code, room and role', () => {
    expect(v7.rep.failures.length).toBeGreaterThanOrEqual(2);
    // The ids are each run's own: the failures still match.
    const ids7 = Object.keys(v7.r.level.items).filter((id) => v7.r.refs[id]);
    const ids8 = Object.keys(v8.r.level.items).filter((id) => v8.r.refs[id]);
    expect(ids7.some((id) => ids8.includes(id))).toBe(false);
    expect(sameFailures(v7.rep, v8.rep)).toBe(true);
    expect([...failureSigs(v8.rep)].every((s) => /^P\d\|[a-z-]+\|[^|]*\|/.test(s))).toBe(true);
  });

  it('a newer one with more failures is the same; one with fewer is not', () => {
    const fewer = version('dsn_v9', { sofa: true });
    expect(fewer.rep.failures.length).toBeLessThan(v7.rep.failures.length);
    expect(sameFailures(fewer.rep, v8.rep)).toBe(true);
    expect(sameFailures(v8.rep, fewer.rep)).toBe(false);
  });

  it('ignores waived and already-in-your-plan checks; no failures is never "the same"', () => {
    const key = v8.rep.failures[0]?.key ?? '';
    const waived = runReport(v8.r, v8.d, { waived: v8.rep.failures.flatMap((f) => f.keys) });
    expect(waived.failures).toEqual([]);
    expect(sameFailures(waived, waived)).toBe(false);
    // One waived on the newer: it no longer has that failure, so not the same.
    const one = runReport(v8.r, v8.d, { waived: [key] });
    expect(sameFailures(v7.rep, one)).toBe(false);
    // Already in the plan: never a failure of the report, so never compared.
    expect(
      v8.r.checks.filter((c) => c.already).every((c) => !one.failures.some((f) => f.key === c.key)),
    ).toBe(true);
    const passes = version('dsn_ok', { sofa: true, bed: true });
    expect(sameFailures(passes.rep, passes.rep)).toBe(false);
  });
});

describe('repeat ahead (§5, criteria 24 and 25)', () => {
  const v7 = version('dsn_v7').rep;
  const v8 = version('dsn_v8').rep;
  const key = dependsKey({
    brief: couple,
    decisions: [],
    declined: [],
    rules: [],
    kept: [],
    levels: ['fp1', null],
  });
  const vs = [
    { title: 'V7', report: v7, depends: key },
    { title: 'V8', report: v8, depends: key },
  ];

  it('two versions with the same failures and nothing changed: it will likely fail again', () => {
    const r = repeatAhead(vs, key);
    expect(r?.titles).toEqual(['V7', 'V8']);
    expect(r?.count).toBe(v8.failures.length);
    expect(r?.failures).toEqual(v8.failures.map((f) => f.says));
  });

  it('three in a row are named V6 to V8; one that failed differently ends the run', () => {
    const v6 = { title: 'V6', report: version('dsn_v6').rep, depends: key };
    const v5 = { title: 'V5', report: version('dsn_v5', { sofa: true, bed: true }).rep };
    expect(repeatRun([v5, v6, ...vs])?.titles).toEqual(['V6', 'V7', 'V8']);
    expect(versionsWords(['V6', 'V7', 'V8'])).toBe('V6 to V8');
  });

  it('anything §5 lists changed: no warning (a fact, a Decision, a rule, a kept piece, a hand edit)', () => {
    const changed = [
      { brief: { ...couple, fixAll: true } },
      { decisions: [{ id: 'd1', kind: 'wish', text: 'One desk' }] },
      { declined: [{ room: 'rm_main', role: 'bed' }] },
      { rules: [{ id: 'r1' }] },
      { kept: [{ id: 'k1' }] },
      { levels: ['fp2', null] },
    ];
    for (const c of changed) {
      const now = dependsKey({
        brief: couple,
        decisions: [],
        declined: [],
        rules: [],
        kept: [],
        levels: ['fp1', null],
        ...c,
      });
      expect(now).not.toBe(key);
      expect(repeatAhead(vs, now)).toBeNull();
    }
    // The order Decisions come in is no change.
    const a = dependsKey({
      brief: couple,
      decisions: [
        { id: 'a', kind: 'wish', text: 'x' },
        { id: 'b', kind: 'keep', text: 'y' },
      ],
      declined: [],
      rules: [],
      kept: [],
      levels: [],
    });
    const b = dependsKey({
      brief: couple,
      decisions: [
        { id: 'b', kind: 'keep', text: 'y' },
        { id: 'a', kind: 'wish', text: 'x' },
      ],
      declined: [],
      rules: [],
      kept: [],
      levels: [],
    });
    expect(a).toBe(b);
  });

  it('a waiver on the newest, or an older build’s version (no key): no warning', () => {
    expect(
      repeatAhead([vs[0] as (typeof vs)[0], { ...(vs[1] as (typeof vs)[1]), waived: true }], key),
    ).toBeNull();
    expect(repeatAhead([vs[0] as (typeof vs)[0], { title: 'V8', report: v8 }], key)).toBeNull();
  });

  it('a plan addressing something new: no warning; the same ones in the same way, or none: a warning', () => {
    const sig = v8.failures[0]?.sig ?? '';
    const other = v8.failures[1]?.sig ?? '';
    const withPlan = [vs[0] as (typeof vs)[0], { ...(vs[1] as (typeof vs)[1]), addressed: [sig] }];
    expect(repeatAhead(withPlan, key, { addressed: [other] })).toBeNull();
    expect(repeatAhead(withPlan, key, { addressed: [sig] })).not.toBeNull();
    expect(repeatAhead(vs, key, { addressed: [] })).not.toBeNull();
    expect(repeatAhead(vs, key, { addressed: [sig] })).toBeNull();
  });

  it('only the newest two decide: a newest that passes, or a single version, never warns', () => {
    const ok = version('dsn_ok', { sofa: true, bed: true }).rep;
    expect(repeatAhead([...vs, { title: 'V9', report: ok, depends: key }], key)).toBeNull();
    expect(repeatAhead([vs[1] as (typeof vs)[1]], key)).toBeNull();
  });
});

describe('the words (UX copy)', () => {
  it('says the blocking heading, the repeat card (once in full, then one line), strict not met', () => {
    expect(blockingHead(['V7', 'V8'], 3)).toBe('V7 and V8 failed on the same 3 things');
    expect(blockingHead(['V7', 'V8'], 1)).toBe('V7 and V8 failed on the same thing');
    expect(repeatWords({ titles: ['V7', 'V8'], count: 3 }, false)).toBe(
      'This will likely come back with the same 3 problems: V7 and V8 did, and nothing they depend on has changed.',
    );
    expect(repeatWords({ titles: ['V7', 'V8', 'V9'], count: 3 }, true)).toBe(
      'Likely the same 3 problems again (V7 to V9).',
    );
    expect(notMetHead('US$0.60')).toBe('Couldn’t make everything pass within US$0.60');
    expect(notMetHead(null)).toBe('Couldn’t make everything pass');
  });
});
