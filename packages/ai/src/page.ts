/**
 * The browser page a request runs in, as the request rules need it: whether it is out of view
 * or offline now, and word when that changes. The web app passes its document and window
 * (`browserPage`); a server (a Worker, a Durable Object) passes none, and then a request is
 * never out of view, never waits for the page, and sends no browser-only header.
 *
 * A page is long-lived: make one per document and pass that same one to every request. The
 * first request on a page starts watching it (`onVisibility`) for good, a listener that is
 * never removed, so a new Page per request would add one each time.
 */
export interface Page {
  /** Out of view now (a locked phone, another app or tab in front). */
  hidden(): boolean;
  /** Known to be offline now (unknown is online). */
  offline(): boolean;
  /** Calls `fn` each time the page is shown or hidden; returns the way to stop. */
  onVisibility(fn: () => void): () => void;
  /** Calls `fn` when the connection comes back; returns the way to stop. */
  onOnline(fn: () => void): () => void;
}
