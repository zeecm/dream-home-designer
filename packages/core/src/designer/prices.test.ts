import { describe, expect, it } from 'vitest';
import { TYPICAL_RATES, costEstimate, electricalLines } from '../cost';
import { aliasesFor } from './aliases';
import { sampleDesign, sampleLevel, tanBrief } from './fixtures/sample';
import anthropic from './fixtures/usage-anthropic.json';
import gemini from './fixtures/usage-gemini.json';
import openai from './fixtures/usage-openai.json';
import { PRICES, estimateRun, priceOf, usdOf } from './prices';
import { runPrompts } from './prompts';
import { designResult } from './result';
import { spacesOf } from './spaces';
import { usageOf, usageTotals } from './usage';

const level = sampleLevel();
const aliases = aliasesFor(level);

describe('cost of the renovation (criterion 18)', () => {
  it('is costEstimate on the designed level, its electrical points included', () => {
    const r = designResult(level, level, sampleDesign());
    expect(r.cost).toEqual(costEstimate(level, r.level, TYPICAL_RATES));
    const elec = electricalLines(level, r.level, TYPICAL_RATES);
    expect(elec.length).toBeGreaterThan(0);
    for (const l of elec) expect(r.cost.lines).toContainEqual(l);
    expect(r.points.length).toBeGreaterThan(0);
    expect(Object.keys(r.level.points).length).toBe(r.points.length);
    expect(r.budget).toBe('within');
  });

  it('is over budget when its low figure passes the brief’s high one', () => {
    const r = designResult(
      level,
      level,
      sampleDesign({ brief: tanBrief({ budget: { low: 2000, high: 5000 } }) }),
    );
    expect(r.cost.low).toBeGreaterThan(5000);
    expect(r.budget).toBe('over');
    const over = Math.round((r.cost.low - 5000) / 100) * 100;
    expect(r.problems.at(-1)?.text).toBe(
      `About S$${over.toLocaleString('en-SG')} over your top figure. Try “Cheaper”.`,
    );
    const unknown = designResult(level, level, sampleDesign({ brief: tanBrief({ budget: null }) }));
    expect(unknown.budget).toBe('unknown');
    // No points when the brief turns them off.
    const off = designResult(
      level,
      level,
      sampleDesign({ brief: tanBrief({ electrical: false }) }),
    );
    expect(off.points).toEqual([]);
    expect(off.level.points).toEqual({});
  });
});

describe('estimateRun (criterion 21)', () => {
  const ctx = { base: level, before: level, brief: tanBrief(), aliases };
  const prompts = runPrompts(ctx, spacesOf(level), aliases);
  const opus = PRICES['claude-opus-5-5']!;

  it('prices the sample’s five requests by the formula, to the cent', () => {
    expect(prompts.map((p) => p.kind)).toEqual(['layout', 'room', 'room', 'room', 'room']);
    const est = estimateRun(prompts, {
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      quality: 'thorough',
    });
    expect(est.requests).toBe(5);
    // By hand: tokens are characters ÷ 3.2, rounded up; per million tokens at the list price.
    let typical = 0;
    let high = 0;
    prompts.forEach((p, i) => {
      const input = Math.ceil(
        (p.system.length + p.prefix.length + p.shared.length + p.tail.length) / 3.2,
      );
      const stable = Math.ceil((p.system.length + p.prefix.length + p.shared.length) / 3.2);
      const out = i === 0 ? 8000 : 5000;
      const max = i === 0 ? 24_000 : 12_000;
      high += (input * 4 + max * 20) / 1e6;
      if (i <= 0) typical += (input * 4 + out * 20) / 1e6;
      else if (i === 1) typical += ((input - stable) * 4 + stable * 5 + out * 20) / 1e6;
      else typical += ((input - stable) * 4 + stable * 0.2 + out * 20) / 1e6;
    });
    expect(est.usd?.typical.toFixed(2)).toBe(typical.toFixed(2));
    expect(est.usd?.high.toFixed(2)).toBe(high.toFixed(2));
    // About US$0.62 typical and US$1.54 at most for the sample: output dominates.
    expect(est.usd!.typical).toBeGreaterThan(0.6);
    expect(est.usd!.typical).toBeLessThan(0.9);
    expect(est.usd!.high).toBeGreaterThan(1.4);
    expect(est.usd!.high).toBeLessThan(1.9);
    expect(opus.cachedInput).toBe(0.2);
    expect(est.tokens.typical).toBe(est.input + 8000 + 4 * 5000);
    expect(est.tokens.high).toBe(est.input + 24_000 + 4 * 12_000);
  });

  it('an unknown model gives tokens and no price; quick lowers both figures', () => {
    const unknown = estimateRun(prompts, {
      provider: 'openai',
      model: 'my-model',
      quality: 'thorough',
    });
    expect(unknown.usd).toBeNull();
    expect(unknown.tokens.typical).toBeGreaterThan(30_000);
    const thorough = estimateRun(prompts, {
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      quality: 'thorough',
    });
    const quick = estimateRun(
      runPrompts({ ...ctx, brief: tanBrief({ quality: 'quick' }) }, spacesOf(level), aliases),
      {
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        quality: 'quick',
      },
    );
    expect(quick.usd!.typical).toBeLessThan(thorough.usd!.typical);
    expect(quick.usd!.high).toBeLessThan(thorough.usd!.high);
    expect(quick.tokens.high).toBeLessThan(thorough.tokens.high);
  });

  it('finds a model by its id, then by the longest listed prefix', () => {
    expect(priceOf('claude-opus-5-5')).toBe(opus);
    expect(priceOf('claude-opus-5-5-20261101')).toBe(opus);
    expect(priceOf('gpt-5-mini-2025-08-07')).toBe(PRICES['gpt-5-mini']);
    expect(priceOf('gpt-5-2025-08-07')).toBe(PRICES['gpt-5']);
    expect(priceOf('llama-3')).toBeNull();
  });
});

describe('usageOf (criterion 22)', () => {
  it('reads Claude’s events: input without the cache, reads and writes apart', () => {
    const u = usageOf('anthropic', anthropic, { step: 'rm_bedroom', model: 'x', ms: 41_000 });
    expect(u).toMatchObject({
      model: 'claude-opus-5-5',
      input: 2210,
      cachedInput: 4120,
      cacheWrite: 0,
      output: 4875,
      estimated: false,
    });
    expect(u.usd).toBeCloseTo((2210 * 4 + 4120 * 0.2 + 4875 * 20) / 1e6, 10);
    const writing = usageOf(
      'anthropic',
      [
        {
          type: 'message_start',
          message: {
            model: 'claude-opus-5-5',
            usage: {
              input_tokens: 900,
              cache_creation_input_tokens: 5000,
              cache_read_input_tokens: 0,
              output_tokens: 1,
            },
          },
        },
        { type: 'message_delta', usage: { output_tokens: 100 } },
      ],
      { step: 's', model: 'x', ms: 1 },
    );
    expect(writing.usd).toBeCloseTo((900 * 4 + 5000 * 5 + 100 * 20) / 1e6, 10);
  });

  it('reads OpenAI’s last chunk: cached tokens taken out of the prompt, reasoning in the output', () => {
    const u = usageOf('openai', openai, { step: 'layout', model: 'gpt-5', ms: 1 });
    expect(u).toMatchObject({
      model: 'gpt-5-2025-08-07',
      input: 6350 - 4096,
      cachedInput: 4096,
      output: 5210,
      reasoning: 3840,
    });
    expect(u.usd).toBeCloseTo(((6350 - 4096) * 1.25 + 4096 * 0.125 + 5210 * 10) / 1e6, 10);
  });

  it('reads Gemini’s last chunk: output billed is candidates plus thoughts', () => {
    const u = usageOf('gemini', gemini, { step: 'layout', model: 'gemini-2.5-pro', ms: 1 });
    expect(u).toMatchObject({
      input: 6402 - 2048,
      cachedInput: 2048,
      output: 1310 + 2960,
      reasoning: 2960,
    });
    expect(u.usd).toBeCloseTo(((6402 - 2048) * 1.25 + 2048 * 0.31 + 4270 * 10) / 1e6, 10);
  });

  it('a step cut off before its usage counts its characters, marked estimated', () => {
    const u = usageOf('anthropic', [{ type: 'ping' }], {
      step: 'rm_kitchen',
      model: 'claude-opus-5-5',
      ms: 5,
      promptChars: 32_000,
      outputChars: 3200,
    });
    expect(u).toMatchObject({ input: 10_000, output: 1000, estimated: true });
    const t = usageTotals([u, usageOf('openai', openai, { step: 'x', model: 'gpt-5', ms: 1 })]);
    expect(t.tokens).toBe(11_000 + 6350 + 5210);
    expect(t.cached).toBe(4096);
    expect(t.estimated).toBe(true);
    expect(usageTotals([{ ...u, usd: null }]).usd).toBeNull();
    expect(
      usdOf({ input: 1e6, cachedInput: 0, cacheWrite: 0, output: 0 }, PRICES['claude-haiku-5-5']!),
    ).toBeCloseTo(0.5);
  });
});
