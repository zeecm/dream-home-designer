import type { StepPrompt } from '@dhd/core';
import { describe, expect, it } from 'vitest';
import type { AiSettings } from './providers';
import {
  type Effort,
  fixStepFor,
  geminiThinking,
  lowerEffort,
  requestFor,
  talkRequestFor,
} from './stream';

/**
 * What each provider's request says about thinking at each effort, and what the lower-effort
 * retry sends (issue #67: on Gemini 3 it sent `thinkingLevel: 'high'` again).
 */

const step = (kind: StepPrompt['kind'], maxTokens: number): StepPrompt => ({
  step: kind === 'layout' ? 'layout' : 'sp_living',
  kind,
  system: 'S',
  prefix: 'P',
  shared: kind === 'room' ? 'C' : '',
  tail: 'T',
  schema: { type: 'object' },
  maxTokens,
  effort: 'high',
});
const layout = step('layout', 24_000);
const room = step('room', 16_000);
const quickRoom = step('room', 8000);
const talk = {
  system: 'S',
  messages: [{ role: 'user' as const, blocks: [{ text: 'Hello', cache: false }] }],
  schema: { type: 'object' },
  maxTokens: 4000,
  effort: 'medium' as const,
  sent: [],
} as unknown as Parameters<typeof talkRequestFor>[1];

const ai = (provider: AiSettings['provider'], model: string): AiSettings => ({
  provider,
  key: 'k',
  model,
});
const EFFORTS: Effort[] = ['high', 'medium', 'low'];
type Body = Record<string, Record<string, unknown>>;
const thinkingOf = (b: Record<string, unknown>) =>
  ((b as Body).generationConfig?.thinkingConfig ?? {}) as Record<string, unknown>;
/** The retry's effort for a step request. */
const lower = (a: AiSettings, p: StepPrompt, e: Effort) =>
  lowerEffort(a, e, (x) => requestFor(a, p, x));

describe('Claude: output_config.effort as asked', () => {
  const opus = ai('anthropic', 'claude-opus-5-5');
  it.each(EFFORTS)('%s', (e) => {
    const body = requestFor(opus, layout, e).body as Body;
    expect(body.output_config?.effort).toBe(e);
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect((talkRequestFor(opus, talk, e).body as Body).output_config?.effort).toBe(e);
  });
  it('retries a cut-off answer one step down, never at the same effort', () => {
    expect(lower(opus, layout, 'high')).toBe('medium');
    expect(lower(opus, layout, 'medium')).toBe('low');
    expect(lower(opus, layout, 'low')).toBeNull();
    // Fix rounds keep the room's effort.
    expect(fixStepFor(opus, room)).toBe(room);
  });
});

describe('OpenAI: reasoning_effort to the models that reason', () => {
  const gpt5 = ai('openai', 'gpt-5');
  it.each(EFFORTS)('%s', (e) => {
    expect(requestFor(gpt5, layout, e).body.reasoning_effort).toBe(e);
    expect(talkRequestFor(gpt5, talk, e).body.reasoning_effort).toBe(e);
  });
  it('retries one step down; a model that takes no effort is never sent the same request again', () => {
    expect(lower(gpt5, layout, 'high')).toBe('medium');
    expect(lower(gpt5, layout, 'medium')).toBe('low');
    expect(lower(gpt5, layout, 'low')).toBeNull();
    const gpt4o = ai('openai', 'gpt-4o');
    expect(requestFor(gpt4o, layout, 'high').body.reasoning_effort).toBeUndefined();
    expect(lower(gpt4o, layout, 'high')).toBeNull();
    expect(fixStepFor(gpt5, room)).toBe(room);
  });
});

describe('Gemini 2.x: a thinking budget, at most half the answer’s limit', () => {
  const pro = ai('gemini', 'gemini-2.5-pro');
  it('by effort, for the layout (24k), a room (16k) and a Quick room (8k)', () => {
    const budget = (p: StepPrompt, e: Effort) => thinkingOf(requestFor(pro, p, e).body);
    expect(EFFORTS.map((e) => budget(layout, e))).toEqual([
      { includeThoughts: true, thinkingBudget: 12_000 },
      { includeThoughts: true, thinkingBudget: 8192 },
      { includeThoughts: true, thinkingBudget: 2048 },
    ]);
    expect(EFFORTS.map((e) => budget(room, e).thinkingBudget)).toEqual([8000, 8000, 2048]);
    expect(EFFORTS.map((e) => budget(quickRoom, e).thinkingBudget)).toEqual([4000, 4000, 2048]);
  });
  it('retries at the next effort that really thinks less', () => {
    expect(lower(pro, layout, 'high')).toBe('medium');
    // A room's budget is capped at 8000 at high and medium alike: straight to low.
    expect(lower(pro, room, 'high')).toBe('low');
    expect(lower(pro, room, 'medium')).toBe('low');
    expect(lower(pro, room, 'low')).toBeNull();
    expect(fixStepFor(pro, room)).toBe(room);
  });
});

describe('Gemini 3: thinkingLevel, really lowered (issue #67)', () => {
  const pro = ai('gemini', 'gemini-3.1-pro-preview');
  it.each(EFFORTS)('3.1 Pro at %s sends that level, in a step and a talk call', (e) => {
    expect(thinkingOf(requestFor(pro, room, e).body)).toEqual({
      includeThoughts: true,
      thinkingLevel: e,
    });
    expect(thinkingOf(talkRequestFor(pro, talk, e).body).thinkingLevel).toBe(e);
  });
  it('never sends high for medium: models without medium get low', () => {
    expect(geminiThinking('gemini-3-flash-preview', 'medium', 8000)).toEqual({
      thinkingLevel: 'medium',
    });
    for (const m of ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.8-flash']) {
      expect(geminiThinking(m, 'medium', 8000)).toEqual({ thinkingLevel: 'medium' });
    }
    // 3 Pro Preview takes only low and high (and any model not known to take medium).
    expect(geminiThinking('gemini-3-pro-preview', 'medium', 8000)).toEqual({
      thinkingLevel: 'low',
    });
    expect(geminiThinking('gemini-9-new', 'medium', 8000)).toEqual({ thinkingLevel: 'low' });
  });
  it('a cut-off answer goes again at low, from high or medium; a low one isn’t sent again', () => {
    expect(lower(pro, room, 'high')).toBe('low');
    expect(lower(pro, room, 'medium')).toBe('low');
    expect(lower(pro, room, 'low')).toBeNull();
    const t = (e: Effort) => lowerEffort(pro, e, (x) => talkRequestFor(pro, talk, x));
    expect(t('medium')).toBe('low');
    expect(t('low')).toBeNull();
  });
  it('per step kind: the layout and rooms at their own effort, fix rounds at low', () => {
    expect(thinkingOf(requestFor(pro, layout).body).thinkingLevel).toBe('high');
    expect(thinkingOf(requestFor(pro, room).body).thinkingLevel).toBe('high');
    const fix = fixStepFor(pro, room);
    expect(fix.effort).toBe('low');
    expect(thinkingOf(requestFor(pro, fix).body).thinkingLevel).toBe('low');
    // A Quick room (medium) is medium; its fix round low too.
    const quick = { ...quickRoom, effort: 'medium' as const };
    expect(thinkingOf(requestFor(pro, quick).body).thinkingLevel).toBe('medium');
    expect(fixStepFor(pro, quick).effort).toBe('low');
  });
});
