import { useEffect, useRef, useState } from 'react';
import { isSample } from '../recent';
import { ownsPlan, useProject, useStore } from '../store';
import { icons } from './icons';

const opened = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

/**
 * The plans this browser keeps: open one, delete one, or clear them all. Sample copies are
 * always kept; a plan shared with this browser is only taken off its list.
 */
export function PlansDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const recent = useStore((s) => s.recent);
  const backend = useStore((s) => s.backend);
  const currentId = useProject().id;
  const { load, deletePlans } = useStore.getState();
  // The row asking "Delete?", or 'all' for Clear all.
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  const close = () => ref.current?.close();

  const removable = recent.filter((r) => !isSample(r));
  const owned = removable.filter((r) => ownsPlan(backend, r.id));
  const shared = removable.length - owned.length;
  const verb = (id: string) => (ownsPlan(backend, id) ? 'Delete' : 'Remove');

  const run = async (ids: string[], what: string) => {
    setBusy(true);
    const failed = await deletePlans(ids);
    setBusy(false);
    setConfirm(null);
    setStatus(failed.length ? `Couldn’t delete ${failed.join(', ')}. Try again later.` : what);
    // The button pressed has gone with its row: keep focus in the dialog.
    ref.current?.focus();
  };

  return (
    <dialog
      ref={ref}
      className="dialog plans-dialog"
      aria-labelledby="plans-h"
      tabIndex={-1}
      onClose={onClose}
    >
      <header className="dialog-head">
        <h2 id="plans-h">Your plans</h2>
        <button type="button" className="icon-btn" aria-label="Close" onClick={close}>
          {icons.close}
        </button>
      </header>
      <p className="dialog-note">
        The plans this browser has opened. Samples are always kept. A plan shared with you is only
        taken off this list.
      </p>
      <ul className="plan-list">
        {recent.map((r) => {
          const sample = isSample(r);
          const here = r.id === currentId;
          const asking = confirm === r.id;
          return (
            <li key={r.id} className={asking ? 'asking' : undefined}>
              <button
                type="button"
                className="plan-list-open"
                disabled={busy}
                onClick={() => {
                  close();
                  if (!here) void load(r.id);
                }}
              >
                <span className="plan-list-name">{r.name}</span>
                <span className="plan-list-meta">
                  {[
                    here && 'Open now',
                    sample ? 'Sample' : !ownsPlan(backend, r.id) && 'Shared with you',
                    `opened ${opened(r.openedAt)}`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </button>
              {sample ? (
                <span className="plan-list-kept">Kept</span>
              ) : asking ? (
                <span className="button-row">
                  <button
                    type="button"
                    className="btn btn-small btn-danger"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        [r.id],
                        `${r.name} ${verb(r.id) === 'Delete' ? 'deleted' : 'removed from your list'}.`,
                      )
                    }
                  >
                    {verb(r.id)}
                  </button>
                  <button
                    type="button"
                    className="btn btn-small"
                    disabled={busy}
                    onClick={() => setConfirm(null)}
                  >
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="btn btn-small"
                  aria-label={`${verb(r.id)} ${r.name}`}
                  disabled={busy}
                  onClick={() => setConfirm(r.id)}
                >
                  {verb(r.id)}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <footer className="dialog-foot">
        {confirm === 'all' ? (
          <div className="dialog-confirm">
            <p>
              {[
                owned.length > 0 &&
                  `Delete ${owned.length} ${owned.length === 1 ? 'plan' : 'plans'}`,
                shared > 0 &&
                  `take ${shared} shared ${shared === 1 ? 'plan' : 'plans'} off this list`,
              ]
                .filter(Boolean)
                .join(' and ')}
              ? Samples stay. This can’t be undone.
            </p>
            <span className="button-row">
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy}
                onClick={() =>
                  void run(
                    removable.map((r) => r.id),
                    'Plans cleared. Samples kept.',
                  )
                }
              >
                Clear all
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => setConfirm(null)}
              >
                Cancel
              </button>
            </span>
          </div>
        ) : (
          <button
            type="button"
            className="btn"
            disabled={busy || removable.length === 0}
            onClick={() => setConfirm('all')}
          >
            Clear all plans
          </button>
        )}
        <output className="field-hint">{status}</output>
      </footer>
    </dialog>
  );
}
