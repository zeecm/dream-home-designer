import {
  type Level,
  aliasesFor,
  defaultBrief,
  layoutStep,
  sampleFlatProject,
  tokensOf,
} from '@dhd/core';
import { describe, expect, it } from 'vitest';
import { minCacheable, requestFor } from './stream';

/**
 * Claude caches the stable prefix only past each model's minimum (no error below it, just no
 * cache): 512 tokens for the 5.x models, up to 4,096 for older ones (the claude-api
 * reference). The sample flat, the smallest plan we design, must clear the minimum of every
 * Claude model we offer, so the room steps after the first read the cache.
 */
const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-4-6'];

describe('the stable prefix and Claude’s cache minimum', () => {
  const level = sampleFlatProject('prj_cache').levels[0] as Level;
  const p = layoutStep({
    base: level,
    before: level,
    brief: defaultBrief(),
    aliases: aliasesFor(level),
  });
  const stable = tokensOf(p.system.length + p.prefix.length);

  it('is above each Claude model’s cache minimum for the sample flat', () => {
    expect(minCacheable('claude-opus-5-5')).toBe(512);
    expect(minCacheable('claude-opus-4-6')).toBe(4096);
    expect(minCacheable('claude-sonnet-5-5')).toBe(512);
    expect(minCacheable('claude-sonnet-5')).toBe(1024);
    expect(minCacheable('claude-sonnet-4-6')).toBe(1024);
    expect(minCacheable('claude-opus-4-20250514')).toBe(1024);
    expect(minCacheable('claude-opus-4-7')).toBe(2048);
    expect(minCacheable('claude-haiku-5-5')).toBe(512);
    for (const model of MODELS) expect(stable).toBeGreaterThan(minCacheable(model));
  });

  it('is marked for caching in the request', () => {
    const r = requestFor(
      { provider: 'anthropic', key: 'sk-ant-test', model: 'claude-opus-5-5' },
      p,
    );
    const content = (r.body.messages as { content: { cache_control?: unknown }[] }[])[0]?.content;
    expect(content?.[0]?.cache_control).toEqual({ type: 'ephemeral' });
  });
});
