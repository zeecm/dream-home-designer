import { restoreVersion } from '@dhd/core';
import { useEffect, useRef, useState } from 'react';
import type { SavedVersion } from '../backend';
import { historyPoints } from '../history';
import { useProject, useStore } from '../store';
import { icons } from './icons';

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });

/**
 * Earlier versions of the open plan, one per editing session, kept for 30 days. Restoring
 * one puts the plan back as it was, as an edit that can be undone.
 */
export function HistoryDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useProject().id;
  const backend = useStore((s) => s.backend);
  const dispatch = useStore((s) => s.dispatch);
  const [points, setPoints] = useState<SavedVersion[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<number | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  useEffect(() => {
    let live = true;
    backend
      ?.versions?.(id)
      .then((vs) => live && setPoints(historyPoints(vs)))
      .catch((e: Error) => live && setError(`Couldn’t load the history: ${e.message}`));
    return () => {
      live = false;
    };
  }, [backend, id]);
  const close = () => ref.current?.close();

  const restore = async (v: SavedVersion) => {
    if (!backend?.getVersion) return;
    setBusy(v.version);
    try {
      dispatch(restoreVersion(await backend.getVersion(id, v.version)));
      close();
    } catch (e) {
      setError(`Couldn’t restore it: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby="history-h"
      tabIndex={-1}
      onClose={onClose}
    >
      <header className="dialog-head">
        <h2 id="history-h">Version history</h2>
        <button type="button" className="icon-btn" aria-label="Close" onClick={close}>
          {icons.close}
        </button>
      </header>
      <p className="dialog-note">
        The plan as it was at the end of each time you worked on it, for the last 30 days. Restoring
        one is an edit like any other: Undo takes it back.
      </p>
      {points === null && !error && <p className="dialog-note">Loading…</p>}
      {points?.length === 0 && (
        <p className="dialog-note">No earlier versions yet. They appear as you edit.</p>
      )}
      {points && points.length > 0 && (
        <ul className="plan-list">
          {points.map((v) => (
            <li key={v.version}>
              <span className="plan-list-open" style={{ cursor: 'default' }}>
                <span className="plan-list-name">{when(v.replacedAt)}</span>
                <span className="plan-list-meta">Version {v.version}</span>
              </span>
              <button
                type="button"
                className="btn btn-small"
                aria-label={`Restore the plan as it was on ${when(v.replacedAt)}`}
                disabled={busy !== null}
                onClick={() => void restore(v)}
              >
                {busy === v.version ? 'Restoring…' : 'Restore'}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="dialog-note error-text">{error}</p>}
    </dialog>
  );
}
