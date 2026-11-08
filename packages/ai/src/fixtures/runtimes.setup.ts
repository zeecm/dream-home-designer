import type { GlobalSetupContext } from 'vitest/node';
import { fingerprint, wholeFlat } from './wholeFlat';

declare module 'vitest' {
  export interface ProvidedContext {
    /** The runtime the tests are meant to run in (this config's pool). */
    runtime: 'node' | 'workerd';
    /** The whole-flat runs as Node made them, before the tests (in vitest's own process). */
    wholeFlat: Awaited<ReturnType<typeof fingerprint>>;
  }
}

/** Runs the whole flat in Node, for the tests to compare with their own runtime's run. */
export default async function setup({ config, provide }: GlobalSetupContext) {
  provide('runtime', config.poolOptions?.workers ? 'workerd' : 'node');
  provide('wholeFlat', await fingerprint(await wholeFlat()));
}
