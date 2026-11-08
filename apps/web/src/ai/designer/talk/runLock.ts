/**
 * One owner per design run, across tabs: the tab running it (or asking whether to carry it on)
 * holds the Web Lock `dhd-run:{id}`, as a reply holds `dhd-talk:{projectId}`. A run whose
 * checkpoint is saved but whose lock nobody holds was interrupted (its tab closed or
 * reloaded). Without Web Locks, one tab is assumed.
 */

export const runLockName = (id: string) => `dhd-run:${id}`;

/** A run's lock, held until released. */
export interface RunHold {
  release: () => void;
}

type Locks = {
  request: (
    name: string,
    opts: { ifAvailable?: boolean; signal?: AbortSignal },
    fn: (lock: unknown) => Promise<unknown>,
  ) => Promise<unknown>;
};
const locks = (): Locks | null =>
  (typeof navigator !== 'undefined' && (navigator as unknown as { locks?: Locks }).locks) || null;

/**
 * Takes a run's lock: the hold once it is held; null when another tab holds it (or, waiting,
 * when `signal` gave up). `wait`: queue for it until the other tab lets go.
 */
export function takeRunLock(
  id: string,
  wait = false,
  signal?: AbortSignal,
): Promise<RunHold | null> {
  const l = locks();
  if (!l) return Promise.resolve({ release: () => {} });
  return new Promise((resolve) => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const opts = wait ? (signal ? { signal } : {}) : { ifAvailable: true };
    l.request(runLockName(id), opts, async (lock) => {
      if (!lock) {
        resolve(null);
        return;
      }
      let done = false;
      resolve({
        release: () => {
          if (done) return;
          done = true;
          release();
        },
      });
      await held;
    }).catch(() => resolve(null));
  });
}
