/**
 * `@dhd/ai`: the designer's requests to the person's own AI provider, with their key. A design
 * run (the layout, then the rooms, with fix rounds), a talk call, and the request rules they
 * share (retries, waits, metering). Runtime-neutral TypeScript (fetch, AbortController,
 * TextDecoder; no DOM), so the browser and the edge run the same code; the browser passes its
 * page (`Page`) where the rules need it.
 */
export * from './errors';
export * from './page';
export * from './providers';
export * from './request';
export * from './run';
export * from './sse';
export * from './stream';
export * from './talkCall';
