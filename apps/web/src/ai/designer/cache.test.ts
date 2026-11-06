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
 * Claude caches the stable prefix only past a model's minimum (no error below it, just no
 * cache). The sample flat, the smallest plan we design, must clear the largest minimum we
 * might meet for Opus (4,096 tokens, by our 3.2-characters estimate, with room to spare), so
 * every room step after the first reads the cache.
 */
const OPUS_FLOOR = 4096;

describe('the stable prefix and Claude’s cache minimum', () => {
  const level = sampleFlatProject('prj_cache').levels[0] as Level;
  const p = layoutStep({
    base: level,
    before: level,
    brief: defaultBrief(),
    aliases: aliasesFor(level),
  });
  const stable = tokensOf(p.system.length + p.prefix.length);

  it('is above Opus’s largest cache minimum for the sample flat', () => {
    console.log(`stable prefix ~${stable} tokens`);
    expect(stable).toBeGreaterThan(OPUS_FLOOR * 1.05);
    expect(stable).toBeGreaterThan(minCacheable('claude-opus-5-5'));
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
