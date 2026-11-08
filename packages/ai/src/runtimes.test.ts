import { describe, expect, inject, it } from 'vitest';
import { canonical, fingerprint, wholeFlat } from './fixtures/wholeFlat';

/** Where this test runs: workerd says so in its user agent. */
const here = () =>
  (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent ===
  'Cloudflare-Workers'
    ? 'workerd'
    : 'node';

describe('the same run in every runtime (cloud runs, tech §2)', () => {
  it('runs where its config says (Node, or workerd as a Worker does)', () => {
    expect(here()).toBe(inject('runtime'));
  });

  // (Three whole runs: well past the default 5 s on a loaded machine.)
  it.skipIf(inject('runtime') === 'node')(
    'a whole flat with each provider: the same requests and the same design as in Node',
    async () => {
      const mine = await wholeFlat();
      for (const p of ['anthropic', 'openai', 'gemini'] as const) {
        expect(mine[p].phase).toBe('done');
        expect(mine[p].requests).toHaveLength(5);
      }
      expect(await fingerprint(mine)).toEqual(inject('wholeFlat'));
    },
    30_000,
  );

  it('compares by content: the same data in any key order is the same', () => {
    expect(canonical({ b: [1, { d: 2, c: 'é' }], a: null })).toBe(
      canonical({ a: null, b: [1, { c: 'é', d: 2 }] }),
    );
    expect(canonical({ a: 1 })).not.toBe(canonical({ a: 2 }));
  });
});
