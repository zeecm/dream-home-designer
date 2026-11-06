import {
  type Level,
  type SceneCamera,
  dayOfYear,
  furnitureKind,
  lampsAuto,
  roomIdAt,
  siteOf,
} from '@dhd/core';
import { type ExactScene, buildExactScene, exactCamera, exactDaylight } from '@dhd/render';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useEditor } from '../editor';
import { download, fileStem, shownDoors, view3dAspect } from '../exports';
import { modelLibrary } from '../models';
import { useLevel, useProject } from '../store';
import { type ExactEngine, ExactUnsupported, NO_START, loadEngine } from './engine';
import { ExactRun, type RunStatus, progressText } from './run';
import { exactSettings, isPhone, renderSize } from './settings';

/** What to render: the chosen view's camera, with ceilings on from inside a room. */
export interface ExactView {
  camera: SceneCamera;
  ceilings: boolean;
  /** Changes whenever the camera does: a new key starts a new render. */
  key: string;
}

/** Waiting for the models in the plan, at most this long (ms); the rest show as boxes. */
const MODEL_WAIT = 10_000;
/** Preparing for longer than this (ms) says the first time takes longest. */
const SLOW_PREPARE = 5_000;

type Stage =
  | { kind: 'waiting' }
  | { kind: 'preparing'; slow: boolean }
  | { kind: 'rendering' }
  | { kind: 'failed'; message: string };

/** Asks for the plan's models and waits (up to MODEL_WAIT) for them; returns how many didn't come. */
async function waitForModels(level: Level, signal: AbortSignal): Promise<number> {
  const files = new Set<string>();
  for (const it of Object.values(level.items)) {
    const f = furnitureKind(it.assetId)?.model;
    if (f) files.add(f);
  }
  const missing = () => [...files].filter((f) => !modelLibrary.has(f));
  for (const f of missing()) modelLibrary.get(f);
  if (!missing().length) return 0;
  await new Promise<void>((resolve) => {
    const done = () => {
      off();
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const off = modelLibrary.onLoad(() => {
      if (!missing().length) done();
    });
    const timer = setTimeout(done, MODEL_WAIT);
    signal.addEventListener('abort', done);
  });
  let n = 0;
  for (const it of Object.values(level.items)) {
    const f = furnitureKind(it.assetId)?.model;
    if (f && !modelLibrary.has(f)) n++;
  }
  return n;
}

/**
 * The Exact side of the render dialog: the 3D model itself, path traced on this device with
 * real light, so every wall, door, window and piece is exactly where the plan has it. It
 * starts by itself (it's free) and sharpens in place; Stop keeps the picture, Carry on
 * resumes from the same samples. Its body and foot stay mounted while the other side shows,
 * so switching back finds the picture as it was.
 */
export function ExactPanel({
  active,
  view,
  switcher,
  choice,
  onUnsupported,
  onPauseView,
}: {
  active: boolean;
  view: ExactView | null;
  /** The Exact | AI impression switch, at the top of the body. */
  switcher: ReactNode;
  /** Where to render from (eye height or this view), when there's a choice. */
  choice: ReactNode;
  /** This device can't: the dialog turns to AI impression and says why. */
  onUnsupported: (message: string) => void;
  /** The 3D view underneath stops drawing while this renders. */
  onPauseView?: (paused: boolean) => void;
}) {
  const level = useLevel();
  const project = useProject();
  const variant = useEditor((s) => s.variant);
  const hour = useEditor((s) => s.sunHour);
  const host = useRef<HTMLDivElement>(null);
  const engineRef = useRef<ExactEngine | null>(null);
  const runRef = useRef<ExactRun | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const [stage, setStage] = useState<Stage>({ kind: 'waiting' });
  const [status, setStatus] = useState<RunStatus | null>(null);
  // The picture's size: from the 3D view's shape as the dialog opens (every camera here has
  // it), so its frame is held at once and nothing moves when the picture comes.
  const [size, setSize] = useState<{ width: number; height: number } | null>(() => {
    const aspect = view3dAspect();
    if (!aspect) return null;
    const s = exactSettings(isPhone(), window.__DHD_EXACT_TEST__);
    return renderSize(aspect, s.long, s.box);
  });
  const [boxes, setBoxes] = useState(0);
  // Said once to a screen reader, not every sample.
  const [announce, setAnnounce] = useState('');
  // Started the first time Exact is shown (it opens there, unless this device can't).
  const [wanted, setWanted] = useState(active);
  useEffect(() => {
    if (active) setWanted(true);
  }, [active]);
  const unsupported = useRef(onUnsupported);
  unsupported.current = onUnsupported;

  const job = wanted && view && level ? view.key : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: one render per view (its key)
  useEffect(() => {
    if (!job || !view || !level) return;
    const ctrl = new AbortController();
    const { signal } = ctrl;
    let engine: ExactEngine | null = null;
    let run: ExactRun | null = null;
    let built: ExactScene | null = null;
    setStage({ kind: 'preparing', slow: false });
    setStatus(null);
    setAnnounce('');
    const slow = setTimeout(
      () => setStage((s) => (s.kind === 'preparing' ? { kind: 'preparing', slow: true } : s)),
      SLOW_PREPARE,
    );
    // Frees the render's GPU memory, context and canvas: on closing, on a new view, and if
    // either came while it was still preparing (whatever has been made by then; a second
    // call frees what was made since). The canvas goes first, whatever else fails.
    const release = () => {
      const [e, r, b] = [engine, run, built];
      engine = null;
      run = null;
      built = null;
      e?.canvas.remove();
      r?.dispose();
      try {
        e?.dispose();
      } catch {
        // A context already lost has nothing left to free.
      }
      b?.dispose();
      if (engineRef.current === e) engineRef.current = null;
      if (runRef.current === r) runRef.current = null;
    };
    const cam = view.camera;
    const settings = exactSettings(isPhone(), window.__DHD_EXACT_TEST__);
    const px = renderSize(cam.aspect, settings.long, settings.box);
    setSize(px);
    void (async () => {
      try {
        engine = await loadEngine({
          width: px.width,
          height: px.height,
          bounces: settings.bounces,
          transmissiveBounces: settings.transmissiveBounces,
          textureSize: settings.textureSize,
          tiles: 2,
        });
        if (signal.aborted) return release();
        engineRef.current = engine;
        engine.canvas.className = 'exact-canvas';
        engine.canvas.setAttribute('role', 'img');
        engine.canvas.setAttribute('aria-label', 'The exact render');
        host.current?.append(engine.canvas);
        const loading = await waitForModels(level, signal);
        if (signal.aborted) return release();
        setBoxes(loading);
        const site = siteOf(project);
        const daylight = exactDaylight(site, dayOfYear(new Date()), hour);
        // The room the camera stands in, if it is inside one (not above the cut-away walls).
        const inside = cam.position.y < level.elevation + level.ceilingHeight;
        const room = inside ? roomIdAt(level, { x: cam.position.x, y: cam.position.z }) : null;
        built = buildExactScene(level, {
          ceilings: view.ceilings,
          models: modelLibrary,
          daylight,
          lamps: lampsAuto(level, room, daylight.light),
          doors: shownDoors(),
        });
        await engine.start(
          built.scene,
          exactCamera({ ...cam, aspect: px.width / px.height }),
          signal,
        );
        if (signal.aborted) return release();
        run = new ExactRun(engine, {
          target: settings.samples,
          cap: settings.cap,
          light: daylight.light,
          onChange: (s) => {
            setStatus(s);
            if (s.phase === 'done') setAnnounce('Render done');
          },
        });
        runRef.current = run;
        run.setHidden(document.hidden);
        run.setAway(!activeRef.current);
        setStage({ kind: 'rendering' });
        setStatus(run.status);
        run.start();
      } catch (e) {
        if (signal.aborted) return release();
        if (e instanceof ExactUnsupported && e.reason !== 'lost') {
          unsupported.current(e.message);
          setStage({ kind: 'failed', message: e.message });
        } else {
          setStage({ kind: 'failed', message: NO_START });
        }
      } finally {
        clearTimeout(slow);
      }
    })();
    return () => {
      ctrl.abort();
      clearTimeout(slow);
      release();
    };
  }, [job]);

  // Drawing waits while the other side shows, and while the tab is hidden.
  useEffect(() => {
    runRef.current?.setAway(!active);
  }, [active]);
  useEffect(() => {
    const on = () => runRef.current?.setHidden(document.hidden);
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  // The 3D view underneath rests while this side is shown with a render under way.
  const working = active && !!job && stage.kind !== 'failed';
  useEffect(() => {
    onPauseView?.(working);
    return () => onPauseView?.(false);
  }, [working, onPauseView]);

  const run = runRef.current;
  const running = status?.phase === 'running';
  const canCarryOn = status?.phase === 'stopped' || status?.phase === 'capped';
  const picture = !!status?.picture;
  const name = project.name;
  const progress = status ? Math.min(1, status.samples / status.target) : 0;

  const save = async () => {
    const e = engineRef.current;
    if (!e) return;
    download(await e.readPixels(), `${fileStem(name)}-exact-render.png`);
  };

  return (
    <>
      <div className="dialog-body exact-body" hidden={!active}>
        <div className="exact-top">
          {switcher}
          {choice}
        </div>
        <div className="exact-frame">
          <div
            ref={host}
            className="exact-picture"
            // What is drawn, for checking against the view (tests read these).
            data-camera={job && view ? JSON.stringify(view.camera) : undefined}
            data-ceilings={job && view ? String(view.ceilings) : undefined}
            style={
              size
                ? {
                    aspectRatio: `${size.width} / ${size.height}`,
                    // As wide as fits, and no taller than the layout allows (--exact-max).
                    width: `min(100%, calc(var(--exact-max) * ${size.width / size.height}))`,
                  }
                : undefined
            }
          >
            {stage.kind !== 'rendering' && !picture && (
              <output className="exact-wait">
                {stage.kind === 'failed' ? (
                  stage.message
                ) : (
                  <>
                    <span>{view ? 'Preparing the scene…' : 'Taking the view…'}</span>
                    {stage.kind === 'preparing' && stage.slow && (
                      <span className="exact-wait-note">
                        Getting the renderer ready; the first time takes longest.
                      </span>
                    )}
                  </>
                )}
              </output>
            )}
          </div>
        </div>
        <p className="dialog-note exact-note">
          Drawn by the app from your 3D model: walls, doors, windows and furniture are exactly as
          planned. Made on this device, free.
          {project.renovation && (
            <>
              {' '}
              <strong>{variant === 'after' ? 'Renovation (after)' : 'As it is (before)'}.</strong>
            </>
          )}
          {boxes > 0 && (
            <>
              {' '}
              {boxes === 1
                ? '1 piece was still loading and shows as a box.'
                : `${boxes} pieces were still loading and show as boxes.`}
            </>
          )}
        </p>
      </div>
      <footer className="dialog-foot exact-foot" hidden={!active}>
        <div className="exact-progress">
          <p className="field-hint exact-progress-text" data-testid="exact-progress">
            {status
              ? progressText(status)
              : stage.kind === 'failed'
                ? stage.message
                : view
                  ? 'Preparing the scene…'
                  : 'Taking the view…'}
          </p>
          <div className="exact-bar" aria-hidden="true">
            <div style={{ transform: `scaleX(${progress})` }} />
          </div>
          <p className="visually-hidden" aria-live="polite">
            {announce}
          </p>
        </div>
        <div className="button-row exact-actions">
          {canCarryOn ? (
            <button type="button" className="btn" onClick={() => run?.carryOn()}>
              Carry on
            </button>
          ) : (
            <button type="button" className="btn" onClick={() => run?.stop()} disabled={!running}>
              Stop
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={save} disabled={!picture}>
            Download
          </button>
        </div>
      </footer>
    </>
  );
}
