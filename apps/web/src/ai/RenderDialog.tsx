import { useEffect, useRef, useState } from 'react';
import { capture3d, download, fileStem } from '../exports';
import { useProject } from '../store';
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

/** The 3D view as it is, made into a photo-real picture by the person's image model. */
export function RenderDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useAi(); // re-render when keys change
  const ai = imageSettings();
  const name = useProject().name;
  const [view, setView] = useState<{ blob: Blob; url: string } | null>(null);
  const [photo, setPhoto] = useState<{ blob: Blob; url: string } | null>(null);
  const [style, setStyle] = useState<RenderStyle>('as');
  const [busy, setBusy] = useState<AbortController | null>(null);
  const [status, setStatus] = useState('');
  const [settings, setSettings] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    // The view as it is when the dialog opens.
    let url = '';
    void capture3d()
      .then((blob) => {
        url = URL.createObjectURL(blob);
        setView({ blob, url });
      })
      .catch(() => setStatus('Couldn’t take a picture of the 3D view.'));
    return () => {
      if (url) URL.revokeObjectURL(url);
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
      const blob = await renderPhoto(ai, view.blob, style, ctrl.signal);
      setPhoto({ blob, url: URL.createObjectURL(blob) });
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
      onClose={onClose}
    >
      <header className="dialog-head">
        <h2 id="render-h">Photo-real render</h2>
        <button type="button" className="icon-btn" aria-label="Close" onClick={close}>
          {icons.close}
        </button>
      </header>
      <p className="dialog-note">
        Your image model turns this view into a photograph-like picture, keeping the room and
        furniture as they are. It’s an impression: details can differ. Best from inside a room: walk
        through, look where you like, then render.
      </p>
      <div className="render-pictures">
        {view ? (
          <img src={(photo ?? view).url} alt={photo ? 'The render' : 'The 3D view'} />
        ) : (
          <div className="render-wait">Taking a picture of the view…</div>
        )}
      </div>
      <div className="ai-form">
        {ai ? (
          <>
            <label className="field">
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
            <p className="field-hint">
              With {PROVIDERS[ai.provider].name} ({ai.model}), on your key: a few cents a picture.
            </p>
          </>
        ) : (
          <p className="field-hint">
            Renders need an OpenAI or Gemini key (Claude doesn’t make pictures).{' '}
            <button type="button" className="link-btn" onClick={() => setSettings(true)}>
              Add a key
            </button>
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
      </div>
      {settings && <AiSettingsDialog onClose={() => setSettings(false)} />}
    </dialog>
  );
}
