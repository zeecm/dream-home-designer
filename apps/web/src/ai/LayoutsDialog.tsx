import {
  type LayoutOp,
  type Level,
  adoptLayout,
  applyLayout,
  planGeometry,
  renovationChanges,
  roomShapes,
} from '@dhd/core';
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
  /** What the model asked for: applied again on Use, to the flat as it is then. */
  ops: LayoutOp[];
  level: Level;
  refused: string[];
}

type P = { x: number; y: number };
const pts = (ps: P[]) => ps.map((q) => `${q.x},${q.y}`).join(' ');

/** The middle of a wall, and whether a wall of `level` runs through that point. */
function middle(level: Level, id: string): P | null {
  const w = level.walls[id];
  const a = w && level.vertices[w.a];
  const b = w && level.vertices[w.b];
  return a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : null;
}
function onAWall(level: Level, p: P): boolean {
  return Object.values(level.walls).some((w) => {
    const a = level.vertices[w.a];
    const b = level.vertices[w.b];
    if (!a || !b) return false;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-9) return false;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    return Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y) < Math.max(0.05, w.thickness / 2);
  });
}

/**
 * A small drawing of a layout: rooms faintly, walls filled; walls that are new or changed
 * (glass, half height) in the accent colour, and walls taken down dashed.
 */
function MiniLayout({ before, level }: { before: Level; level: Level }) {
  const geom = useMemo(() => planGeometry(level), [level]);
  const was = useMemo(() => planGeometry(before), [before]);
  const rooms = useMemo(() => [...roomShapes(level).values()], [level]);
  const all = geom.pieces.flatMap((p) => p.polygon);
  if (!all.length) return null;
  const changed = (id: string) => {
    const old = before.walls[id];
    const now = level.walls[id];
    if (!old) {
      // A piece of an old wall split by a new one isn't new.
      const m = middle(level, id);
      return !m || !onAWall(before, m);
    }
    return !!now && (old.build !== now.build || old.height !== now.height);
  };
  const gone = was.pieces.filter((p) => {
    if (level.walls[p.wallId]) return false;
    const m = middle(before, p.wallId);
    return !m || !onAWall(level, m);
  });
  const xs = all.map((p) => p.x);
  const ys = all.map((p) => p.y);
  const x0 = Math.min(...xs) - 0.3;
  const y0 = Math.min(...ys) - 0.3;
  const w = Math.max(...xs) - x0 + 0.3;
  const h = Math.max(...ys) - y0 + 0.3;
  return (
    <svg className="mini-layout" viewBox={`${x0} ${y0} ${w} ${h}`} aria-hidden="true">
      {rooms.map((r, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed drawing
        <polygon key={`r${i}`} className="mini-room" points={pts(r.outer)} />
      ))}
      {geom.pieces.map((p, i) => (
        <polygon
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed drawing
          key={i}
          className={changed(p.wallId) ? 'mini-new' : undefined}
          points={pts(p.polygon)}
        />
      ))}
      {gone.map((p, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed drawing
        <polygon key={`g${i}`} className="mini-gone" points={pts(p.polygon)} />
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
  const listRef = useRef<HTMLOListElement>(null);
  // New options: brought into sight, the first one's name focused (and so read out).
  useEffect(() => {
    if (!options.length) return;
    const first = listRef.current?.firstElementChild;
    first?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    first?.querySelector<HTMLElement>('h3')?.focus({ preventScroll: true });
  }, [options]);

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
          return {
            name: o.name,
            summary: o.summary,
            reasons: o.reasons,
            ops: o.operations,
            level: after,
            refused,
          };
        }),
      );
      setStatus(
        got.options.length === 1 ? '1 layout ready.' : `${got.options.length} layouts ready.`,
      );
    } catch (e) {
      setStatus(e instanceof AiError ? e.message : 'Something went wrong. Try again.');
    }
    setBusy(null);
  };

  const use = (o: Option) => {
    const level = before();
    if (!level) return;
    // Applied again to the flat as it is now (it may have changed since).
    const { level: after } = applyLayout(level, o.ops);
    if (!renovationChanges(level, after).length) {
      setStatus('The plan has changed and this layout no longer applies. Suggest again.');
      return;
    }
    dispatch(adoptLayout(level.id, after));
    setVariant('after');
    close();
  };

  return (
    <dialog
      ref={ref}
      className="dialog layouts-dialog"
      aria-labelledby="layouts-h"
      tabIndex={-1}
      // Only its own close: React passes a dialog opened inside it up the tree too.
      onClose={(e) => e.target === e.currentTarget && onClose()}
    >
      <header className="dialog-head">
        <h2 id="layouts-h">Suggest layouts</h2>
        <button type="button" className="icon-btn" aria-label="Close" onClick={close}>
          {icons.close}
        </button>
      </header>
      <div className="dialog-body">
        <p className="dialog-note">
          Your AI model suggests up to three ways to renovate the flat as it is, for your household.
          Outside walls, structural walls, the household shelter and bathrooms stay as they are. Any
          you use becomes the renovation, to look at in 3D, walk through and change further. Hacking
          walls needs HDB approval and an HDB-registered contractor: these are ideas, not approvals.
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
        </div>
        {options.length > 0 && (
          <ol className="layout-options" ref={listRef}>
            {options.map((o, i) => {
              const level = before();
              const changes = level ? renovationChanges(level, o.level) : [];
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: one fixed answer's options
                <li key={i} className="layout-option">
                  <div>
                    {level && <MiniLayout before={level} level={o.level} />}
                    {changes.length > 0 && (
                      <p className="mini-key" aria-hidden="true">
                        <span>
                          <i />
                          New or changed
                        </span>
                        <span>
                          <i className="mini-key-gone" />
                          Taken down
                        </span>
                      </p>
                    )}
                  </div>
                  <div>
                    <h3 id={`layout-${i}-h`} tabIndex={-1}>
                      {o.name}
                    </h3>
                    <p id={`layout-${i}-s`}>{o.summary}</p>
                    <ul className="layout-reasons">
                      {o.reasons.map((r, j) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: fixed reasons
                        <li key={j}>{r}</li>
                      ))}
                    </ul>
                    <p className="field-hint">
                      {changes.length
                        ? changes.map((c) => changeText(c)).join(' · ')
                        : 'Nothing in this one could be applied to your flat.'}
                    </p>
                    {o.refused.length > 0 && (
                      <p className="field-hint">
                        Left out ({o.refused.length}): {o.refused.join('; ')}
                      </p>
                    )}
                    {changes.length > 0 && (
                      <button
                        type="button"
                        className="btn btn-small"
                        aria-describedby={`layout-${i}-h layout-${i}-s`}
                        onClick={() => use(o)}
                      >
                        {hasRenovation ? 'Use this instead of the renovation' : 'Use this'}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
      <footer className="dialog-foot">
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
      </footer>
      {settings && <AiSettingsDialog onClose={() => setSettings(false)} />}
    </dialog>
  );
}
