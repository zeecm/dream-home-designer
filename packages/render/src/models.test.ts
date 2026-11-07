import { describe, expect, it } from 'vitest';
import { ModelLibrary } from './models';

describe('ModelLibrary', () => {
  it('tells its listeners when a model fails to load too, and calls it settled', async () => {
    // Nothing listens there: the fetch fails at once.
    const lib = new ModelLibrary('http://127.0.0.1:9/');
    const told = new Promise<void>((resolve) => lib.onLoad(resolve));
    expect(lib.get('missing.glb')).toBeNull();
    expect(lib.settled('missing.glb')).toBe(false);
    await told;
    expect(lib.has('missing.glb')).toBe(false);
    expect(lib.settled('missing.glb')).toBe(true);
  });
});
