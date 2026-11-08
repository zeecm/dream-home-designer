/// <reference lib="webworker" />
import { type Ask, handle } from './resultsHandler';

/**
 * The designer's worker: places and checks versions and prices presses off the main thread, so
 * dragging, typing and the streamed text never wait for the solver. One message at a time, in
 * the order sent; the memos live here.
 */
self.onmessage = (e: MessageEvent<Ask>) => {
  self.postMessage(handle(e.data));
};
