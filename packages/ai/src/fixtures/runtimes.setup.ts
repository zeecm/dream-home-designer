import type { GlobalSetupContext } from 'vitest/node';
import { fingerprint, wholeFlat } from './wholeFlat';

declare module 'vitest' {
  export interface ProvidedContext {
    /** The runtime the tests are meant to run in (this config's pool). */
    runtime: 'node' | 'workerd';
    /**
     * The whole-flat runs as Node made them, before the tests (in vitest's own process), for
     * workerd to compare with; none when the tests run in Node themselves.
     */
    wholeFlat: Awaited<ReturnType<typeof fingerprint>> | null;
  }
}

/** Runs the whole flat in Node, for the tests in workerd to compare with their own run. */
export default async function setup({ config, provide }: GlobalSetupContext) {
  const runtime = config.poolOptions?.workers ? 'workerd' : 'node';
  provide('runtime', runtime);
  provide('wholeFlat', runtime === 'workerd' ? await fingerprint(await wholeFlat()) : null);
}
