import { OVERHEAD_HEIGHT, type SceneFacts, eyeLevelCamera, sceneFacts } from '@dhd/core';
import { useEffect, useRef, useState } from 'react';
import { useEditor } from '../editor';
import { capture3dFrom, capture3dView, download, fileStem } from '../exports';
import { useLevel, useProject } from '../store';
import { icons } from '../ui/icons';
import { AiSettingsDialog } from './AiSettingsDialog';
import { PROVIDERS, imageSettings, useAi } from './credentials';
import { AiError } from './providers';
import { RENDER_STYLES, type RenderStyle, renderPhoto } from './render';

const STYLE_NAMES: Record<RenderStyle, string> = {
  as: 'As designed',
  warm: 'Warm modern',
  scandi: 'Scandinavian',
  luxe: 'Modern luxe',
  industrial: 'Industrial',
};

/** A picture of the 3D view to send, with the facts of what it shows. */
interface Shot {
  blob: Blob;
  url: string;
  facts?: SceneFacts;
}

/**
 * The 3D view as it is, made into a photo-real picture by the person's image model. From
 * high up or outside the rooms (an orbit or cut-away view) it offers, and starts on, the
 * same direction from eye height in the room the view is centred on: from above, rooms
 * read as bigger than they are and models fill them with furniture that wouldn't fit.
 */
export function RenderDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useAi(); // re-render when keys change
  const ai = imageSettings();
  const name = useProject().name;
  const level = useLevel();
  const walking = useEditor((s) => !!s.walking);
  // The view as it is, and (from high up) from eye height in its room.
  const [shots, setShots] = useState<{ here: Shot; eye?: Shot & { room: string } } | null>(null);
  const [from, setFrom] = useState<'here' | 'eye'>('here');
  const [photo, setPhoto] = useState<{ blob: Blob; url: string } | null>(null);
  const [style, setStyle] = useState<RenderStyle>('as');
  const [busy, setBusy] = useState<AbortController | null>(null);
  const [status, setStatus] = useState('');
  const [settings, setSettings] = useState(false);
  // With a render made: show it, or the view it was made from, to compare.
  const [showView, setShowView] = useState(false);
  const view = shots ? (from === 'eye' && shots.eye ? shots.eye : shots.here) : null;
  const highUp = (shots?.here.facts?.height ?? 0) > OVERHEAD_HEIGHT;

  // biome-ignore lint/correctness/useExhaustiveDependencies: the view as the dialog opens on it
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    const urls: string[] = [];
    let live = true;
    const shot = (blob: Blob, facts?: SceneFacts): Shot => {
      const url = URL.createObjectURL(blob);
      urls.push(url);
      return { blob, url, facts };
    };
    void (async () => {
      try {
        const { blob, camera } = await capture3dView();
        if (!live) return; // closed before the picture was ready
        const facts = level ? sceneFacts(level, camera) : undefined;
        const here = shot(blob, facts);
        // A walk is at eye height already.
        const eye = !walking && level && facts?.view !== 'eye' && eyeLevelCamera(level, camera);
        if (!eye || !level) {
          setShots({ here });
          return;
        }
        const room = level.rooms[eye.roomId]?.name ?? 'the room';
        const eyeBlob = await capture3dFrom(eye.camera);
        if (!live) return;
        setShots({ here, eye: { ...shot(eyeBlob, sceneFacts(level, eye.camera)), room } });
        setFrom('eye');
      } catch {
        if (live) setStatus('Couldn’t take a picture of the 3D view.');
      }
    })();
    return () => {
      live = false;
      for (const u of urls) URL.revokeObjectURL(u);
    };
  }, []);
  useEffect(() => () => (photo ? URL.revokeObjectURL(photo.url) : undefined), [photo]);
  useEffect(() => () => busy?.abort(), [busy]);
  const close = () => ref.current?.close();

  const run = async () => {
    if (!ai || !view) return;
    const ctrl = new AbortController();
    setBusy(ctrl);
    setStatus('Rendering… this can take a minute or two.');
    try {
      const blob = await renderPhoto(ai, view.blob, style, ctrl.signal, view.facts);
      setPhoto({ blob, url: URL.createObjectURL(blob) });
      setShowView(false);
      setStatus('');
    } catch (e) {
      setStatus(e instanceof AiError ? e.message : 'The render failed. Try again.');
    }
    setBusy(null);
  };

  return (
    <dialog
      ref={ref}
      className="dialog render-dialog"
      aria-labelledby="render-h"
      tabIndex={-1}
      // Only its own close: React passes a dialog opened inside it up the tree too.
      onClose={(e) => e.target === e.currentTarget && onClose()}
    >
      <header className="dialog-head">
        <h2 id="render-h">Photo-real render</h2>
        <button type="button" className="icon-btn" aria-label="Close" onClick={close}>
          {icons.close}
        </button>
      </header>
      <div className="dialog-body">
        <p className="dialog-note">
          Your image model turns this view into a photograph-like picture, keeping the room and
          furniture as they are. It’s an impression: details can differ. Best from inside a room:
          walk through, look where you like, then render.
        </p>
        <div className="render-pictures">
          {shots?.eye && (
            <fieldset className="segmented segmented-fill render-from">
              <legend className="visually-hidden">Render from</legend>
              <button
                type="button"
                aria-pressed={from === 'eye'}
                onClick={() => {
                  setFrom('eye');
                  setShowView(true);
                }}
              >
                From eye height <span className="render-from-note">in {shots.eye.room}</span>
              </button>
              <button
                type="button"
                aria-pressed={from === 'here'}
                onClick={() => {
                  setFrom('here');
                  setShowView(true);
                }}
              >
                From this view{' '}
                <span className="render-from-note">
                  ({highUp ? 'overhead' : 'outside the rooms'}: rooms may look larger)
                </span>
              </button>
            </fieldset>
          )}
          {view === shots?.here && shots.here.facts && shots.here.facts.view !== 'eye' && (
            // An honest word on what a view from above does to a render.
            <p className="field-hint render-warning">
              From {highUp ? 'above' : 'outside'}, rooms look bigger than they are and image models
              tend to add furniture that wouldn’t fit. The model is told the true sizes, but eye
              height is truer to life.
            </p>
          )}
          {photo && view && (
            <fieldset className="segmented">
              <legend className="visually-hidden">Show</legend>
              <button type="button" aria-pressed={!showView} onClick={() => setShowView(false)}>
                Render
              </button>
              <button type="button" aria-pressed={showView} onClick={() => setShowView(true)}>
                3D view
              </button>
            </fieldset>
          )}
          {view ? (
            <img
              src={(photo && !showView ? photo : view).url}
              alt={
                photo && !showView
                  ? 'The render'
                  : view === shots?.eye
                    ? `The 3D view from eye height in ${shots.eye.room}`
                    : 'The 3D view'
              }
            />
          ) : (
            <div className="render-wait">Taking a picture of the view…</div>
          )}
        </div>
      </div>
      {/* The look and the model in the foot, always in sight: however short the screen, and
          however far the picture has scrolled, it shows which model (and cost) a render uses. */}
      <footer className="dialog-foot">
        {ai ? (
          <p className="field-hint render-model">
            With {PROVIDERS[ai.provider].name} ({ai.model}), on your key: a few cents a picture.
          </p>
        ) : (
          <p className="field-hint">
            Renders need an OpenAI or Gemini key (Claude doesn’t make pictures).{' '}
            <button type="button" className="link-btn" onClick={() => setSettings(true)}>
              Add a key
            </button>
          </p>
        )}
        <p className="field-hint foot-status" aria-live="polite">
          {status}
        </p>
        <div className="button-row render-actions">
          {ai && (
            <label className="render-look">
              <span className="field-label">Look</span>
              <select
                className="input"
                value={style}
                onChange={(e) => setStyle(e.target.value as RenderStyle)}
              >
                {(Object.keys(RENDER_STYLES) as RenderStyle[]).map((s) => (
                  <option key={s} value={s}>
                    {STYLE_NAMES[s]}
                  </option>
                ))}
              </select>
            </label>
          )}
          {busy ? (
            <button type="button" className="btn" onClick={() => busy.abort()}>
              Cancel
            </button>
          ) : (
            <button type="button" className="btn btn-primary" onClick={run} disabled={!ai || !view}>
              {photo ? 'Render again' : 'Render'}
            </button>
          )}
          {photo && (
            <button
              type="button"
              className="btn"
              onClick={() => download(photo.blob, `${fileStem(name)}-render.png`)}
            >
              Download
            </button>
          )}
        </div>
      </footer>
      {settings && <AiSettingsDialog initial="openai" onClose={() => setSettings(false)} />}
    </dialog>
  );
}
