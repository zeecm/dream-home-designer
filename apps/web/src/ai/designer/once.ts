/**
 * A question asked at most once at a time: whoever asks while it is open gets the same
 * answer, and none is left waiting for a question replaced by another.
 */
export function sharedQuestion<T>(ask: () => Promise<T>): () => Promise<T> {
  let open: Promise<T> | null = null;
  return () => {
    open ??= ask().finally(() => {
      open = null;
    });
    return open;
  };
}
