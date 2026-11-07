import {
  type Level,
  type SceneCamera,
  dayOfYear,
  daylightReach,
  furnitureKind,
  lampsAuto,
  roomIdAt,
  siteOf,
} from '@dhd/core';
import {
  type ExactScene,
  buildExactScene,
  exactCamera,
  exactDaylight,
  sampleClamp,
} from '@dhd/render';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useEditor } from '../editor';
import { download, fileStem, shownDoors, view3dAspect } from '../exports';
import { modelLibrary } from '../models';
import { useLevel, useProject } from '../store';
import {
  BAD_DEVICE,
  type ExactEngine,
  ExactUnsupported,
  NO_START,
  forgetEngine,
  loadEngine,
} from './engine';
import { baseExposure } from './exposure';
import { ExactRun, MAX_SAMPLES, type RunPhase, type RunStatus, progressText } from './run';
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
  | { kind: 'preparing' }
  | { kind: 'rendering' }
  | { kind: 'failed'; message: string };

/** A render left for another camera: its last picture and where it got to, to come back to. */
interface Kept {
  canvas: HTMLCanvasElement;
  status: RunStatus;
  boxes: number;
}

/** A copy of `from` on a canvas of its own. */
function copyCanvas(from: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = from.width;
  c.height = from.height;
  c.getContext('2d')?.drawImage(from, 0, 0);
  c.className = 'exact-canvas';
  c.setAttribute('role', 'img');
  c.setAttribute('aria-label', 'The exact render');
  return c;
}

/**
 * Asks for the plan's models and waits (up to MODEL_WAIT) for them, not for any that failed;
 * returns how many didn't come.
 */
async function waitForModels(level: Level, signal: AbortSignal): Promise<number> {
  const files = new Set<string>();
  for (const it of Object.values(level.items)) {
    const f = furnitureKind(it.assetId)?.model;
    if (f) files.add(f);
  }
  const missing = () => [...files].filter((f) => !modelLibrary.settled(f));
  for (const f of missing()) modelLibrary.get(f);
  if (!missing().length) return countBoxes(level);
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
  return countBoxes(level);
}

/** Pieces whose model isn't there (still loading, or failed): they show as boxes. */
function countBoxes(level: Level): number {
  let n = 0;
  for (const it of Object.values(level.items)) {
    const f = furnitureKind(it.assetId)?.model;
    if (f && !modelLibrary.has(f)) n++;
  }
  return n;
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/**
 * The Exact side of the render dialog: the 3D model itself, path traced on this device with
 * real light, so every wall, door, window and piece is exactly where the plan has it. It
 * starts by itself (it's free) and sharpens in place; Stop keeps the picture, Carry on
 * resumes from the same samples. Its body and foot stay mounted while the other side shows,
 * so switching back finds the picture as it was; a render left for another camera ("Render
 * from") is kept too, its last picture shown again on coming back.
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
  // Getting ready is taking a while (or the first draw will): says the first time is longest.
  const [slow, setSlow] = useState(false);
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
  const unsupported = useRef(onUnsupported);
  unsupported.current = onUnsupported;
  // Bumped by Try again (after a graphics card reset): a fresh render of the same view.
  const [attempt, setAttempt] = useState(0);
  // The view rendered: the chosen one, taken up only while this side shows (a choice made on
  // the AI side waits until the person comes back here).
  const [shown, setShown] = useState<ExactView | null>(active ? view : null);
  useEffect(() => {
    if (active) setShown(view);
  }, [active, view]);
  // Renders left for another camera, by its key.
  const [kept, setKept] = useState<ReadonlyMap<string, Kept>>(new Map());
  const keptHere = shown ? kept.get(shown.key) : undefined;

  const job = shown && level && !keptHere ? `${shown.key}#${attempt}` : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: one render per view (its key)
  useEffect(() => {
    if (!job || !shown || !level) return;
    const ctrl = new AbortController();
    const { signal } = ctrl;
    let engine: ExactEngine | null = null;
    let token = 0;
    let run: ExactRun | null = null;
    let built: ExactScene | null = null;
    let picture = false;
    setStage({ kind: 'preparing' });
    setStatus(null);
    setAnnounce('');
    setSlow(false);
    const slowTimer = setTimeout(() => setSlow(true), SLOW_PREPARE);
    // The engine itself is kept for the session (its shader compiled once); only this render's
    // scene and pictures go, unless its context was lost. A render with a picture is kept for
    // its camera (its last picture and where it got to), to come back to.
    const release = () => {
      const [e, r, b] = [engine, run, built];
      engine = null;
      run = null;
      built = null;
      // (Not one the graphics card reset on: Try again wants a fresh one.)
      if (e && r && picture && !e.lost) {
        e.stop(); // the picture as it is now, in the snapshot
        const st = r.status;
        const entry: Kept = {
          canvas: copyCanvas(e.snapshot),
          status: { ...st, phase: st.phase === 'running' ? 'stopped' : st.phase },
          boxes: countBoxes(level),
        };
        setKept((m) => new Map(m).set(shown.key, entry));
      }
      e?.canvas.remove();
      e?.snapshot.remove();
      r?.dispose();
      try {
        if (e?.lost) forgetEngine(e);
        else e?.release(token);
      } catch {
        // A context already lost has nothing left to free.
      }
      b?.dispose();
      if (engineRef.current === e) engineRef.current = null;
      if (runRef.current === r) runRef.current = null;
    };
    const cam = shown.camera;
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
        token = engine.claim();
        if (signal.aborted) return release();
        engineRef.current = engine;
        for (const c of [engine.canvas, engine.snapshot]) {
          c.className = 'exact-canvas';
          c.setAttribute('role', 'img');
          c.setAttribute('aria-label', 'The exact render');
        }
        host.current?.append(engine.canvas);
        const loading = await waitForModels(level, signal);
        if (signal.aborted) return release();
        setBoxes(loading);
        const site = siteOf(project);
        const daylight = exactDaylight(site, dayOfYear(new Date()), hour);
        // The room the camera stands in, if it is inside one (not above the cut-away walls).
        const inside = cam.position.y < level.elevation + level.ceilingHeight;
        const room = inside ? roomIdAt(level, { x: cam.position.x, y: cam.position.z }) : null;
        const doors = shownDoors();
        built = buildExactScene(level, {
          ceilings: shown.ceilings,
          models: modelLibrary,
          daylight,
          lamps: lampsAuto(level, room, daylight.light),
          doors,
          // From inside a room, the sky lights the rooms through lights in their openings
          // (aimed at every sample): those of the camera's room and the rooms whose light
          // reaches it (through open doors, passages, glass). Outside the rooms, the sky.
          portals: shown.ceilings && room ? daylightReach(level, room, doors) : false,
        });
        engine.clamp = sampleClamp(daylight);
        await engine.start(
          built.scene,
          exactCamera({ ...cam, aspect: px.width / px.height }),
          signal,
        );
        if (signal.aborted) return release();
        // Exposed for a typical room at this hour until the first picture is metered.
        engine.exposure = baseExposure(daylight.light);
        if (!engine.drawn) {
          // The first draw may build the shader and hold the page: say so first, painted.
          setSlow(true);
          await nextFrame();
          await nextFrame();
          if (signal.aborted) return release();
        }
        const said: Partial<Record<RunPhase, string>> = {
          done: 'Render done',
          capped: 'Render stopped at its time limit',
          lost: 'The graphics card reset; your picture so far is kept',
        };
        run = new ExactRun(engine, {
          target: settings.samples,
          cap: settings.cap,
          light: daylight.light,
          onChange: (s) => {
            if (s.picture) picture = true;
            setStatus(s);
            setAnnounce(said[s.phase] ?? '');
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
        // Nothing to keep from a render that couldn't start, its engine included.
        if (engine) forgetEngine(engine);
        release();
        if (e instanceof ExactUnsupported) {
          // This device can't (a lost context at the start included): AI impression instead.
          const message = e.reason === 'lost' ? BAD_DEVICE : e.message;
          unsupported.current(message);
          setStage({ kind: 'failed', message });
        } else {
          setStage({ kind: 'failed', message: NO_START });
        }
      } finally {
        clearTimeout(slowTimer);
      }
    })();
    return () => {
      ctrl.abort();
      clearTimeout(slowTimer);
      release();
    };
  }, [job]);

  // A kept render: its picture back in the frame.
  useEffect(() => {
    if (!keptHere) return;
    host.current?.append(keptHere.canvas);
    setSize({ width: keptHere.canvas.width, height: keptHere.canvas.height });
    return () => keptHere.canvas.remove();
  }, [keptHere]);

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

  const shownStatus = keptHere?.status ?? status;
  // The graphics card reset: the last kept picture stands in for the canvas, which is blank.
  const lost = !keptHere && status?.phase === 'lost';
  useEffect(() => {
    const e = engineRef.current;
    if (!lost || !e) return;
    e.canvas.remove();
    host.current?.append(e.snapshot);
  }, [lost]);

  const run = runRef.current;
  const phase = shownStatus?.phase;
  const picture = !!shownStatus?.picture;
  const name = project.name;
  const progress = shownStatus ? Math.min(1, shownStatus.samples / shownStatus.target) : 0;
  const shownBoxes = keptHere?.boxes ?? boxes;
  const filename = `${fileStem(name)}-exact-render.png`;

  const save = async () => {
    if (keptHere) {
      const blob = await new Promise<Blob | null>((r) => keptHere.canvas.toBlob(r, 'image/png'));
      if (blob) download(blob, filename);
      return;
    }
    const e = engineRef.current;
    if (!e) return;
    download(await e.readPixels(), filename);
  };
  // A kept render can't go on (its samples went with the engine): a fresh one can.
  const again = () => {
    if (!shown) return;
    const key = shown.key;
    setKept((m) => {
      const next = new Map(m);
      next.delete(key);
      return next;
    });
  };

  let action: ReactNode;
  if (keptHere) {
    action = (
      <button type="button" className="btn" onClick={again}>
        Render again
      </button>
    );
  } else if (lost) {
    action = (
      <button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>
        Try again
      </button>
    );
  } else if (phase === 'stopped' || phase === 'capped') {
    action = (
      <button type="button" className="btn" onClick={() => run?.carryOn()}>
        Carry on
      </button>
    );
  } else if (phase === 'done') {
    action =
      (shownStatus?.target ?? MAX_SAMPLES) < MAX_SAMPLES ? (
        <button type="button" className="btn" onClick={() => run?.more()}>
          More samples
        </button>
      ) : null;
  } else {
    action = (
      <button
        type="button"
        className="btn"
        onClick={() => run?.stop()}
        disabled={phase !== 'running' || !picture}
      >
        Stop
      </button>
    );
  }

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
            data-camera={shown ? JSON.stringify(shown.camera) : undefined}
            data-ceilings={shown ? String(shown.ceilings) : undefined}
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
            {!picture && (
              // Covers the canvas until its first good picture: a light, quiet frame.
              <output className="exact-wait">
                {stage.kind === 'failed' ? (
                  stage.message
                ) : (
                  <>
                    <span>{shown ? 'Preparing the scene…' : 'Taking the view…'}</span>
                    {slow && (
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
          {shownBoxes > 0 && (
            <>
              {' '}
              {shownBoxes === 1
                ? '1 piece wasn’t loaded and shows as a box.'
                : `${shownBoxes} pieces weren’t loaded and show as boxes.`}
            </>
          )}
        </p>
      </div>
      <footer className="dialog-foot exact-foot" hidden={!active}>
        <div className="exact-progress">
          <p className="field-hint exact-progress-text" data-testid="exact-progress">
            {shownStatus
              ? progressText(shownStatus)
              : stage.kind === 'failed'
                ? stage.message
                : shown
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
          {action}
          <button type="button" className="btn btn-primary" onClick={save} disabled={!picture}>
            Download
          </button>
        </div>
      </footer>
    </>
  );
}
