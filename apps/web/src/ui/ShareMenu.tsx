import { useEffect, useRef, useState } from 'react';
import { shareLink } from '../keys';
import { useProject, useStore } from '../store';

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // no clipboard access: the field is selectable
    }
  };
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <span className="copy-row">
        <input
          className="input"
          readOnly
          value={value}
          aria-label={label}
          onFocus={(e) => e.currentTarget.select()}
        />
        <button type="button" className="btn btn-small" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </span>
    </div>
  );
}

/**
 * Sharing: everyone gets the view-only link; the owner can also turn on an edit link,
 * whose changes save straight to this plan, and reset it to cut off people who have it.
 */
function ShareBody() {
  const id = useProject().id;
  const role = useStore((s) => s.role);
  const backend = useStore((s) => s.backend);
  const [edit, setEdit] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const owner = role === 'owner' && backend?.kind === 'remote';

  useEffect(() => {
    if (!owner || !backend?.getShare) return;
    let live = true;
    backend
      .getShare(id)
      .then((k) => live && setEdit(k))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [owner, backend, id]);

  const change = (on: boolean, reset = false) => {
    if (!backend?.setShare) return;
    setError(null);
    backend
      .setShare(id, on, reset)
      .then(setEdit)
      .catch((e: Error) => setError(e.message));
  };

  if (backend?.kind !== 'remote') {
    return (
      <p className="note">
        This plan is saved only in this browser while the server can’t be reached, so it can’t be
        shared yet.
      </p>
    );
  }

  return (
    <>
      <CopyField label="View-only link" value={shareLink(id)} />
      <p className="note">Anyone with this link can look around and walk through the plan.</p>
      {owner && (
        <>
          <label className="check-row">
            <input
              type="checkbox"
              checked={!!edit}
              disabled={edit === undefined}
              onChange={(e) => change(e.target.checked)}
            />
            <span>Also allow editing with a separate link</span>
          </label>
          {edit && (
            <>
              <CopyField label="Edit link" value={shareLink(id, edit)} />
              <p className="note">
                Changes made through this link save to this plan. Reset it to stop links you’ve
                already sent from working.
              </p>
              <button type="button" className="btn btn-small" onClick={() => change(true, true)}>
                Reset edit link
              </button>
            </>
          )}
        </>
      )}
      {role === 'editor' && (
        <p className="note">
          You’re editing through a shared link; your changes save to the owner’s plan.
        </p>
      )}
      {error && <p className="field-hint error-text">{error}</p>}
    </>
  );
}

export function ShareMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent | KeyboardEvent) => {
      if (
        e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', close);
    };
  }, [open]);
  return (
    <div className="menu-anchor" ref={ref}>
      <button
        type="button"
        className="btn btn-small"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        Share
      </button>
      {open && (
        <section className="menu share-menu" aria-label="Share this plan">
          <ShareBody />
        </section>
      )}
    </div>
  );
}
