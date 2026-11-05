import { type Level, adoptLayout, applyLayout, planGeometry, renovationChanges } from '@dhd/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useEditor } from '../editor';
import { useProject, useStore } from '../store';
import { changeText } from '../ui/Renovation';
import { icons } from '../ui/icons';
import { AiSettingsDialog } from './AiSettingsDialog';
import { PROVIDERS, useAi } from './credentials';
import { type Brief, WISHES, suggestLayouts } from './layouts';
import { AiError } from './providers';

interface Option {
  name: string;
  summary: string;
  reasons: string[];
  level: Level;
  refused: string[];
}

/** A small drawing of a layout: its walls, filled. */
function MiniLayout({ level }: { level: Level }) {
  const geom = useMemo(() => planGeometry(level), [level]);
  const pts = geom.pieces.flatMap((p) => p.polygon);
  if (!pts.length) return null;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x0 = Math.min(...xs) - 0.3;
  const y0 = Math.min(...ys) - 0.3;
  const w = Math.max(...xs) - x0 + 0.3;
  const h = Math.max(...ys) - y0 + 0.3;
  return (
    <svg className="mini-layout" viewBox={`${x0} ${y0} ${w} ${h}`} aria-hidden="true">
      {geom.pieces.map((p, i) => (
        <polygon
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed drawing
          key={i}
          points={p.polygon.map((q) => `${q.x},${q.y}`).join(' ')}
        />
      ))}
    </svg>
  );
}

/** Suggested layouts from a short brief, each to look over and use as the renovation. */
export function LayoutsDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const ai = useAi();
  const hasRenovation = !!useProject().renovation;
  const dispatch = useStore((s) => s.dispatch);
  const setVariant = useEditor((s) => s.setVariant);
  const [brief, setBrief] = useState<Brief>({ household: '', wishes: [], notes: '' });
  const [options, setOptions] = useState<Option[]>([]);
  const [busy, setBusy] = useState<AbortController | null>(null);
  const [status, setStatus] = useState('');
  const [settings, setSettings] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  useEffect(() => () => busy?.abort(), [busy]);
  const close = () => ref.current?.close();

  // Always from the flat as it is (Before), whichever version is shown.
  const before = () => useStore.getState().editor.doc.levels[0];

  const run = async () => {
    const level = before();
    if (!ai || !level) return;
    const ctrl = new AbortController();
    setBusy(ctrl);
    setOptions([]);
    setStatus('Thinking through layouts… this can take a minute or two.');
    try {
      const got = await suggestLayouts(ai, level, brief, ctrl.signal);
      setOptions(
        got.options.map((o) => {
          const { level: after, refused } = applyLayout(level, o.operations);
          return { name: o.name, summary: o.summary, reasons: o.reasons, level: after, refused };
        }),
      );
      setStatus('');
    } catch (e) {
      setStatus(e instanceof AiError ? e.message : 'Something went wrong. Try again.');
    }
    setBusy(null);
  };

  const use = (o: Option) => {
    const level = before();
    if (!level) return;
    dispatch(adoptLayout(level.id, o.level));
    setVariant('after');
    close();
  };

  return (
    <dialog
      ref={ref}
      className="dialog layouts-dialog"
      aria-labelledby="layouts-h"
      tabIndex={-1}
      onClose={onClose}
    >
      <header className="dialog-head">
        <h2 id="layouts-h">Suggest layouts</h2>
        <button type="button" className="icon-btn" aria-label="Close" onClick={close}>
          {icons.close}
        </button>
      </header>
      <p className="dialog-note">
        Your AI model suggests up to three ways to renovate the flat as it is, for your household.
        Outside walls, the household shelter and bathrooms stay as they are. Any you use becomes the
        renovation, to look at in 3D, walk through and change further. Hacking walls needs HDB
        approval and an HDB-registered contractor: these are ideas, not approvals.
      </p>
      <div className="ai-form">
        <label className="field">
          <span className="field-label">Who lives here</span>
          <input
            className="input"
            placeholder="e.g. a couple with a toddler, working from home"
            value={brief.household}
            onChange={(e) => setBrief({ ...brief, household: e.target.value })}
          />
        </label>
        <fieldset className="wish-list">
          <legend className="field-label">You’d like</legend>
          {WISHES.map((w) => (
            <label key={w} className="check-row">
              <input
                type="checkbox"
                checked={brief.wishes.includes(w)}
                onChange={(e) =>
                  setBrief({
                    ...brief,
                    wishes: e.target.checked
                      ? [...brief.wishes, w]
                      : brief.wishes.filter((x) => x !== w),
                  })
                }
              />
              <span>{w}</span>
            </label>
          ))}
        </fieldset>
        <label className="field">
          <span className="field-label">Anything else</span>
          <input
            className="input"
            placeholder="e.g. keep the second bedroom; we cook a lot"
            value={brief.notes}
            onChange={(e) => setBrief({ ...brief, notes: e.target.value })}
          />
        </label>
        {!ai && (
          <p className="field-hint">
            Needs your own AI key.{' '}
            <button type="button" className="link-btn" onClick={() => setSettings(true)}>
              Add a key
            </button>
          </p>
        )}
        {ai && (
          <p className="field-hint">
            With {PROVIDERS[ai.provider].name}, on your key: a few cents to a few tens of cents.
          </p>
        )}
        <p className="field-hint" aria-live="polite">
          {status}
        </p>
        <div className="button-row">
          {busy ? (
            <button type="button" className="btn" onClick={() => busy.abort()}>
              Cancel
            </button>
          ) : (
            <button type="button" className="btn btn-primary" onClick={run} disabled={!ai}>
              {options.length ? 'Suggest again' : 'Suggest layouts'}
            </button>
          )}
        </div>
      </div>
      {options.length > 0 && (
        <ol className="layout-options">
          {options.map((o) => {
            const level = before();
            const changes = level ? renovationChanges(level, o.level) : [];
            return (
              <li key={o.name} className="layout-option">
                <MiniLayout level={o.level} />
                <div>
                  <h3>{o.name}</h3>
                  <p>{o.summary}</p>
                  <ul className="layout-reasons">
                    {o.reasons.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                  <p className="field-hint">
                    {changes.length
                      ? changes.map((c) => changeText(c)).join(' · ')
                      : 'No change to the walls.'}
                  </p>
                  {o.refused.length > 0 && (
                    <p className="field-hint">
                      Left out ({o.refused.length}): {o.refused.join('; ')}
                    </p>
                  )}
                  <button
                    type="button"
                    className="btn btn-small"
                    disabled={!changes.length}
                    onClick={() => use(o)}
                  >
                    {hasRenovation ? 'Use this instead of the renovation' : 'Use this'}
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {settings && <AiSettingsDialog onClose={() => setSettings(false)} />}
    </dialog>
  );
}
