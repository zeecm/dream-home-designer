import {
  OVERHEAD_HEIGHT,
  type SceneCamera,
  type SceneFacts,
  eyeLevelCamera,
  sceneFacts,
} from '@dhd/core';
import { useEffect, useRef, useState } from 'react';
import { useEditor } from '../editor';
import { ExactPanel, type ExactView } from '../exact/ExactPanel';
import { NO_WEBGL2, hasWebGL2 } from '../exact/engine';
import { capture3dFrom, capture3dView, download, fileStem } from '../exports';
import { useLevel, useProject } from '../store';
import { icons } from '../ui/icons';
import { AiSettingsDialog } from './AiSettingsDialog';
import { PROVIDERS, imageSettings, useAi } from './credentials';
import { AiError } from './providers';
import { MAX_IDEAS, RENDER_STYLES, type RenderStyle, planImage, renderPhoto } from './render';

const STYLE_NAMES: Record<RenderStyle, string> = {
  as: 'As designed',
  warm: 'Warm modern',
  scandi: 'Scandinavian',
  luxe: 'Modern luxe',
  industrial: 'Industrial',
};

/** The person's ideas for renders, kept per plan for this tab. */
const ideasKey = (projectId: string) => `dhd-render-ideas:${projectId}`;
const readIdeas = (projectId: string) => {
  try {
    return sessionStorage.getItem(ideasKey(projectId)) ?? '';
  } catch {
    return '';
  }
};
const keepIdeas = (projectId: string, text: string) => {
  try {
    sessionStorage.setItem(ideasKey(projectId), text);
  } catch {
    // Not kept: no matter.
  }
};

/** A picture of the 3D view to send, with the facts of what it shows and its camera. */
interface Shot {
  blob: Blob;
  url: string;
  facts?: SceneFacts;
  /** Where it was taken from: the exact render's camera, and marked on the plan sent. */
  camera: SceneCamera;
}

type Mode = 'exact' | 'ai';

/**
 * A photo-real picture of the 3D view, two ways. **Exact** (where it opens, every time): the
 * app path traces the 3D model itself on this device, so nothing is added or moved
 * (`ExactPanel`). **AI impression**: the 3D view as it is, made into a photo-real picture by
 * the person's image model. From high up or outside the rooms (an orbit or cut-away view) both
 * offer, and start on, the same direction from eye height in the room the view is centred on:
 * from above, rooms read as bigger than they are and models fill them with furniture that
 * wouldn't fit. Both use the same chosen camera, so switching compares like for like.
 */
export function RenderDialog({
  onClose,
  onPauseView,
}: {
  onClose: () => void;
  /** The 3D view underneath stops drawing (true) while an exact render runs. */
  onPauseView?: (paused: boolean) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useAi(); // re-render when keys change
  const ai = imageSettings();
  const { name, id: projectId } = useProject();
  const level = useLevel();
  const walking = useEditor((s) => !!s.walking);
  // The view as it is, and (from high up) from eye height in its room.
  const [shots, setShots] = useState<{ here: Shot; eye?: Shot & { room: string } } | null>(null);
  const [from, setFrom] = useState<'here' | 'eye'>('here');
  // A render, with which picture it was made from.
  const [photo, setPhoto] = useState<{ blob: Blob; url: string; from: 'here' | 'eye' } | null>(
    null,
  );
  const [style, setStyle] = useState<RenderStyle>('as');
  // The person's own ideas, kept for the next render in this tab.
  const [ideas, setIdeas] = useState(() => readIdeas(projectId));
  const [busy, setBusy] = useState<AbortController | null>(null);
  const [status, setStatus] = useState('');
  const [settings, setSettings] = useState(false);
  // With a render made: show it, or the view it was made from, to compare.
  const [showView, setShowView] = useState(false);
  const view = shots ? (from === 'eye' && shots.eye ? shots.eye : shots.here) : null;
  const highUp = (shots?.here.facts?.height ?? 0) > OVERHEAD_HEIGHT;
  // Exact, unless this browser can't (then why, and AI impression as today).
  const [noExact, setNoExact] = useState<string | null>(() => (hasWebGL2() ? null : NO_WEBGL2));
  const [mode, setMode] = useState<Mode>(() => (noExact ? 'ai' : 'exact'));
  // Both pictures taken (or tried): the exact render starts from the chosen one.
  const [settled, setSettled] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the view as the dialog opens on it
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    const urls: string[] = [];
    let live = true;
    const shot = (blob: Blob, camera: SceneCamera): Shot => {
      const url = URL.createObjectURL(blob);
      urls.push(url);
      return { blob, url, camera, facts: level ? sceneFacts(level, camera) : undefined };
    };
    void (async () => {
      await take();
      if (live) setSettled(true);
    })();
    async function take() {
      let here: Shot;
      let camera: SceneCamera;
      try {
        const view = await capture3dView();
        if (!live) return; // closed before the picture was ready
        camera = view.camera;
        here = shot(view.blob, camera);
        setShots({ here });
      } catch {
        if (live) setStatus('Couldn’t take a picture of the 3D view.');
        return;
      }
      // A walk is at eye height already.
      if (walking || !level || here.facts?.view === 'eye') return;
      try {
        const eye = eyeLevelCamera(level, camera);
        if (!eye) return;
        const room = level.rooms[eye.roomId]?.name ?? 'the room';
        const eyeBlob = await capture3dFrom(eye.camera);
        if (!live) return;
        setShots({ here, eye: { ...shot(eyeBlob, eye.camera), room } });
        setFrom('eye');
      } catch {
        // This view is still there to render from.
        if (live)
          setStatus('Couldn’t take the eye-height picture, so the render will use this view.');
      }
    }
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
      // The plan goes with the view, so the model knows what lies at and past its edges.
      let plan: Blob | undefined;
      try {
        if (level && view.camera) plan = await planImage(level, view.camera);
      } catch {
        plan = undefined; // the view and its facts still go
      }
      const blob = await renderPhoto(ai, view.blob, style, ctrl.signal, {
        facts: view.facts,
        plan,
        ideas,
      });
      setPhoto({
        blob,
        url: URL.createObjectURL(blob),
        from: view === shots?.eye ? 'eye' : 'here',
      });
      setShowView(false);
      setStatus('');
    } catch (e) {
      setStatus(e instanceof AiError ? e.message : 'The render failed. Try again.');
    }
    setBusy(null);
  };

  // Where to render from: eye height in the room (the default from high up) or this view.
  const choice = (ai: boolean) =>
    shots?.eye && (
      <fieldset className="segmented segmented-fill render-from">
        <legend className="visually-hidden">Render from</legend>
        <button
          type="button"
          aria-pressed={from === 'eye'}
          disabled={ai && !!busy}
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
          disabled={ai && !!busy}
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
    );
  const switcher = (
    <fieldset className="segmented segmented-fill render-mode">
      <legend className="visually-hidden">How to render</legend>
      <button
        type="button"
        aria-pressed={mode === 'exact'}
        disabled={!!noExact}
        title={noExact ?? undefined}
        onClick={() => setMode('exact')}
      >
        Exact
      </button>
      <button type="button" aria-pressed={mode === 'ai'} onClick={() => setMode('ai')}>
        AI impression
      </button>
    </fieldset>
  );
  // The exact render's camera: the one chosen, with ceilings on from inside a room.
  const exactView: ExactView | null =
    settled && shots
      ? from === 'eye' && shots.eye
        ? { camera: shots.eye.camera, ceilings: true, key: 'eye' }
        : { camera: shots.here.camera, ceilings: walking, key: 'here' }
      : null;

  return (
    <dialog
      ref={ref}
      className="dialog render-dialog"
      data-mode={mode}
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
      <ExactPanel
        active={mode === 'exact'}
        view={exactView}
        switcher={switcher}
        choice={choice(false)}
        onUnsupported={(why) => {
          setNoExact(why);
          setMode('ai');
        }}
        onPauseView={onPauseView}
      />
      <div className="dialog-body" hidden={mode !== 'ai'}>
        {switcher}
        {noExact && <p className="field-hint render-mode-note">{noExact}</p>}
        <p className="dialog-note">
          Your image model turns this view into a photograph-like picture, keeping the room and
          furniture as they are (plus anything your own ideas add). It’s an impression: details can
          differ. Best from inside a room: walk through, look where you like, then render.
        </p>
        <div className="render-pictures">
          {choice(true)}
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
              <button
                type="button"
                aria-pressed={showView}
                onClick={() => {
                  // The picture the render was made from.
                  setShowView(true);
                  setFrom(photo.from);
                }}
              >
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
        {ai && (
          <div className="field render-ideas">
            <label className="field-label" htmlFor="render-ideas">
              Your own ideas (optional)
            </label>
            <textarea
              id="render-ideas"
              aria-describedby="render-ideas-hint"
              className="input textarea"
              rows={2}
              maxLength={MAX_IDEAS}
              disabled={!!busy}
              placeholder="e.g. terrazzo floor, warm evening light, linen curtains, a big plant in the corner"
              value={ideas}
              onChange={(e) => {
                setIdeas(e.target.value);
                keepIdeas(projectId, e.target.value);
              }}
            />
            <span className="field-hint" id="render-ideas-hint">
              Materials, colours, light and things to add. Walls, doors and windows stay as
              designed.
            </span>
          </div>
        )}
      </div>
      {/* The look and the model in the foot, always in sight: however short the screen, and
          however far the picture has scrolled, it shows which model (and cost) a render uses. */}
      <footer className="dialog-foot" hidden={mode !== 'ai'}>
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
