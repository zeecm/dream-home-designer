import { describe, expect, it } from 'vitest';
import { sampleFlatProject } from '../../fixtures/sampleFlat';
import type { Level } from '../../schema';
import { aliasesFor } from '../aliases';
import { tanBrief } from '../fixtures/sample';
import { PRICES, estimateRun, usdOf } from '../prices';
import { runPrompts } from '../prompts';
import type { Usage } from '../schema';
import { spacesOf } from '../spaces';
import { type AskInput, askRule, atMostOf, estimatePlan, spentOf } from './price';

const est = (typical: number, high: number, fix: number) => ({ usd: { typical, high, fix } });
const base: AskInput = {
  spentTab: 0,
  cap: 5,
  threshold: 0.25,
  designRunsThisTab: 1,
  pressedPriced: true,
};

describe('askRule (criterion 30, the button rules)', () => {
  it.each([
    ['a priced button below every rule runs', est(0.05, 0.1, 0.05), base, 'go'],
    [
      'the tab’s first design run asks',
      est(0.05, 0.1, 0.05),
      { ...base, designRunsThisTab: 0 },
      'ask-cost-check',
    ],
    ['a high figure of US$0.50 or more asks', est(0.2, 0.5, 0.1), base, 'ask-cost-check'],
    [
      'passing the limit asks first, whatever else',
      est(0.2, 0.4, 0.2),
      { ...base, spentTab: 4.5, designRunsThisTab: 0 },
      'ask-limit',
    ],
    ['a priced button: the threshold isn’t applied again', est(0.1, 0.3, 0.2), base, 'go'],
    [
      'after a message, at most over the threshold asks',
      est(0.1, 0.3, 0.2),
      { ...base, pressedPriced: false },
      'ask-threshold',
    ],
    [
      'after a message, under it runs',
      est(0.02, 0.1, 0.1),
      { ...base, pressedPriced: false },
      'go',
    ],
    [
      'Always ask',
      est(0.01, 0.02, 0),
      { ...base, pressedPriced: false, threshold: 'always' as const },
      'ask-threshold',
    ],
    [
      'Never ask still keeps v1’s rules',
      est(0.2, 0.6, 0.2),
      { ...base, pressedPriced: false, threshold: 'never' as const },
      'ask-cost-check',
    ],
    [
      'Never ask',
      est(0.1, 0.3, 0.2),
      { ...base, pressedPriced: false, threshold: 'never' as const },
      'go',
    ],
    ['no limit set', est(0.1, 0.3, 0.1), { ...base, cap: null, spentTab: 100 }, 'go'],
  ] as const)('%s', (_, e, i, want) => {
    expect(askRule(e, i)).toBe(want);
  });

  it('a model with no price always asks', () => {
    expect(askRule({ usd: null }, base)).toBe('ask-cost-check');
    expect(atMostOf({ usd: null })).toBeNull();
  });

  it('at most is the high figure with the fix rounds', () => {
    expect(atMostOf(est(0.1, 0.3, 0.2))).toBeCloseTo(0.5);
  });
});

describe('estimatePlan and totals (criterion 29)', () => {
  const level = sampleFlatProject().levels[0] as Level;
  const ctx = { base: level, before: level, brief: tanBrief(), aliases: aliasesFor(level) };
  const prompts = runPrompts(ctx, spacesOf(level), ctx.aliases);
  const opts = {
    provider: 'anthropic' as const,
    model: 'claude-opus-5-5',
    quality: 'thorough' as const,
  };

  it('several runs’ estimates sum', () => {
    const a = estimateRun(prompts.slice(0, 2), opts);
    const b = estimateRun(prompts.slice(2), opts);
    const both = estimatePlan([a, b]);
    expect(both?.requests).toBe(a.requests + b.requests);
    expect(both?.usd?.typical).toBeCloseTo((a.usd?.typical ?? 0) + (b.usd?.typical ?? 0));
    expect(both?.usd?.high).toBeCloseTo((a.usd?.high ?? 0) + (b.usd?.high ?? 0));
    expect(estimatePlan([a])).toBe(a);
    expect(estimatePlan([])).toBeNull();
  });

  it('a conversation’s total is the sum of its turns’ usage at the price table', () => {
    const price = PRICES['claude-opus-5-5'];
    if (!price) throw new Error('no price');
    const u = (input: number, cached: number, output: number, estimated = false): Usage => ({
      step: 'rm_kitchen',
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      input,
      cachedInput: cached,
      cacheWrite: 0,
      output,
      reasoning: null,
      estimated,
      usd: usdOf({ input, cachedInput: cached, cacheWrite: 0, output }, price),
      ms: 1000,
    });
    const turns = [[u(1000, 3000, 2000)], [u(500, 3500, 1800), u(1200, 0, 900, true)]];
    const total = spentOf(turns.flat());
    const sum = turns.map((t) => spentOf(t).usd ?? 0).reduce((a, b) => a + b, 0);
    expect(total.usd).toBeCloseTo(sum, 10);
    expect(total.tokens).toBe(1000 + 3000 + 2000 + 500 + 3500 + 1800 + 1200 + 900);
    expect(total.estimated).toBe(true);
    expect(spentOf([{ ...u(1, 0, 1), usd: null }]).usd).toBeNull();
  });
});
