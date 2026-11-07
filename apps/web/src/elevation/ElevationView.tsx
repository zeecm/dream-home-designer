import {
  AFTER_SUFFIX,
  type Elevation,
  type ElevationChanges,
  type Level,
  type RoomFace,
  WARNING_TEXT,
  elevationChanges,
  elevationLabels,
  faceTitle,
  otherSide,
  pointName,
  resolveFace,
  roomFaces,
  wallElevation,
} from '@dhd/core';
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  startTransition,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { type Selection, useEditor } from '../editor';
import { beforeOf } from '../electrical/electrical';
import { useLevel, useProject, useStore } from '../store';
import { Segmented } from '../ui/fields';
import { icons } from '../ui/icons';
import { useOneView } from '../ui/oneView';
import { ElevationSvg, chainsShown, drawingBox, fitScale, heightFor } from './ElevationSvg';
import { facePlace, flipRef, stepRef } from './nav';
import { closeView, openFace } from './open';
import { loadWallpapers, saveElevationImage, wallpaperUrl } from './saveImage';

/**
 * The wall view: one face of a room seen straight on, on a framed white sheet, with its
 * header (the room, the face, its size and finish; stepping round the room, the other side,
 * what to show, a picture, close) and the list of its points and what to check. Desktop
 * shows it beside the plan; a phone shows it alone, with a bottom bar.
 */

const PREFS_KEY = 'dhd:wallview';
interface Prefs {
  furniture: 'wall' | 'none';
  dims: boolean;
}
const readPrefs = (): Prefs => {
  try {
    const p = JSON.parse(window.localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>;
    return { furniture: p.furniture === 'none' ? 'none' : 'wall', dims: p.dims !== false };
  } catch {
    return { furniture: 'wall', dims: true };
  }
};
const savePrefs = (p: Prefs) => {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    // storage disabled
  }
};

/** "3 900": millimetres with a space between thousands. */
export const mmText = (m: number) =>
  String(Math.round(m * 1000)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

/** The versions to compare, when the shown level is a renovation's After (or a design). */
function useVersions(level: Level | undefined) {
  const project = useProject();
  const preview = useEditor((s) => s.preview);
  const variant = useEditor((s) => s.variant);
  return useMemo(() => {
    if (!level) return { statusOf: undefined, before: null, after: null };
    if (preview) {
      return {
        statusOf: preview.before,
        before: preview.side === 'version' ? preview.before : null,
        after: preview.side === 'version' ? preview.level : null,
      };
    }
    const before = beforeOf(project, level);
    const after =
      project.renovation?.levels.find((l) => l.id === `${before.id}${AFTER_SUFFIX}`) ?? null;
    return {
      statusOf: before,
      before: variant === 'after' && after ? before : null,
      after: variant === 'after' ? after : null,
      otherAfter: after,
    };
  }, [level, project, preview, variant]);
}

export function ElevationView() {
  const level = useLevel();
  const ref = useEditor((s) => s.elevation?.ref);
  const selection = useEditor((s) => s.selection);
  const variant = useEditor((s) => s.variant);
  const previewing = useEditor((s) => !!s.preview);
  const project = useProject();
  const oneView = useOneView();
  const [prefs, setPrefsState] = useState(readPrefs);
  const setPrefs = (p: Prefs) => {
    setPrefsState(p);
    savePrefs(p);
  };
  const versions = useVersions(level);
  const face = useMemo(() => (level && ref ? resolveFace(level, ref) : null), [level, ref]);
  const elev = useMemo(
    () =>
      level && face
        ? wallElevation(level, face, { furniture: prefs.furniture, statusOf: versions.statusOf })
        : null,
    [level, face, prefs.furniture, versions.statusOf],
  );
  const changes = useMemo(
    () =>
      face && versions.before && versions.after
        ? elevationChanges(versions.before, versions.after, face)
        : null,
    [face, versions.before, versions.after],
  );
  // Taken down in the renovation: shown in Before, gone in After.
  const beforeLevel = level ? beforeOf(project, level) : undefined;
  const afterLevel =
    project.renovation?.levels.find((l) => l.id === `${beforeLevel?.id}${AFTER_SUFFIX}`) ?? null;
  const takenDown = useMemo(() => {
    if (!ref || previewing || !afterLevel || !beforeLevel) return false;
    return !!resolveFace(beforeLevel, ref) && !resolveFace(afterLevel, ref);
  }, [ref, previewing, afterLevel, beforeLevel]);
  const hasReno = !!project.renovation && !previewing;

  // Wallpapers are drawn as tiles once, then the drawing uses them.
  const [tiles, setTiles] = useState(0);
  const papers = elev?.walls.map((w) => w.material ?? '').join() ?? '';
  useEffect(() => {
    if (!papers) return;
    let live = true;
    void loadWallpapers(papers.split(',')).then(() => live && setTiles((t) => t + 1));
    return () => {
      live = false;
    };
  }, [papers]);

  const headRef = useRef<HTMLHeadingElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: again when the wall goes or comes back
  useEffect(() => {
    headRef.current?.focus({ preventScroll: true });
  }, [!!face]);
  // Esc in a field (or anything else) that leaves focus nowhere: back to the view.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      requestAnimationFrame(() => {
        if (useEditor.getState().elevation && document.activeElement === document.body)
          document.querySelector<HTMLElement>('.elev-pane h2')?.focus({ preventScroll: true });
      });
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  // The list beside the drawing (a phone on its side can hide it).
  const [listShown, setListShown] = useState(true);
  // Its menus close on Esc (which then goes no further) and on a press outside them.
  useEffect(() => {
    const openMenus = () => [...document.querySelectorAll<HTMLDetailsElement>('.elev-menu[open]')];
    const down = (e: PointerEvent) => {
      for (const m of openMenus()) if (!m.contains(e.target as Node)) m.open = false;
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const open = openMenus();
      if (!open.length) return;
      for (const m of open) m.open = false;
      open[0]?.querySelector('summary')?.focus();
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('pointerdown', down, { capture: true });
    window.addEventListener('keydown', key, { capture: true });
    return () => {
      window.removeEventListener('pointerdown', down, { capture: true });
      window.removeEventListener('keydown', key, { capture: true });
    };
  }, []);

  if (!level || !ref) return null;
  if (!face || !elev) {
    const gone = variant === 'after' && takenDown;
    return (
      <section
        className="elev-pane elev-gone"
        aria-label="Wall seen straight on"
        data-testid="wall-view"
      >
        <div className="elev-gone-body">
          <h2 className="panel-title" ref={headRef} tabIndex={-1}>
            {gone ? 'This wall is taken down in the renovation.' : 'That wall is gone.'}
          </h2>
          <p className="field-hint">
            {gone
              ? 'The flat as it is still has it.'
              : 'Undo brings it back, and this view with it.'}
          </p>
          <span className="button-row">
            {gone && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => useEditor.getState().setVariant('before')}
              >
                See it as it is
              </button>
            )}
            <button type="button" className="btn" onClick={closeView}>
              Close
            </button>
          </span>
        </div>
      </section>
    );
  }

  const room = level.rooms[face.roomId];
  const roomName = room?.name ?? 'Room';
  const place = facePlace(level, face);
  const other = otherSide(level, face);
  const otherName = other ? (level.rooms[other.roomId]?.name ?? 'the other room') : null;
  const step = (by: 1 | -1) => {
    const r = stepRef(level, ref, by);
    const f = r && resolveFace(level, r);
    if (f) openFace(level, f);
  };
  const flip = () => {
    const r = flipRef(level, ref);
    const f = r && resolveFace(level, r);
    if (f) openFace(level, f);
  };
  const title = `${roomName} · ${faceTitle(face)}`;
  // To 10 mm, as the overall dimension under the drawing says it.
  const size = `${mmText(Math.round(face.length * 100) / 100)} × ${mmText(face.ceiling)} mm`;
  const sub = [
    size,
    elev.finishName,
    variant === 'before' && takenDown ? 'Taken down in the renovation' : null,
  ]
    .filter(Boolean)
    .join(' · ');
  // What to check: the notes, and each point with a warning (as the plan has them).
  const warned = elev.points.filter((p) => p.warnings.length > 0 || p.onGlass);
  const toCheck = elev.notes.length + warned.length;
  const save = () =>
    void saveElevationImage({
      elev,
      roomName,
      changes,
      dims: prefs.dims,
      openTo: face.openTo ? (level.rooms[face.openTo]?.name ?? null) : null,
      pointNames: Object.fromEntries(
        elev.points.map((p) => {
          const pt = level.points?.[p.id];
          return [p.id, pt ? pointName(pt) : p.kind];
        }),
      ),
    }).catch((e: Error) => useStore.setState({ notice: e.message }));
  const showList = () => {
    setListShown(true);
    requestAnimationFrame(() => {
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      const list = document.getElementById('elev-list');
      list?.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
      list?.querySelector<HTMLElement>('.elev-row')?.focus({ preventScroll: true });
    });
  };
  const allFaces = roomFaces(level, face.roomId).filter((f) => f.steppable);
  const closeMenu = (e: { currentTarget: Element }) =>
    e.currentTarget.closest('details')?.removeAttribute('open');

  const furniture = (
    <>
      <span className="elev-menu-label">Furniture</span>
      <Segmented
        label="Furniture"
        value={prefs.furniture}
        options={[
          { value: 'wall', label: 'Against the wall' },
          { value: 'none', label: 'None' },
        ]}
        onChange={(furniture) => setPrefs({ ...prefs, furniture })}
      />
      <span className="elev-menu-label">Dimensions</span>
      <Segmented
        label="Dimensions"
        value={prefs.dims ? 'on' : 'off'}
        options={[
          { value: 'on', label: 'Shown' },
          { value: 'off', label: 'None' },
        ]}
        onChange={(v) => setPrefs({ ...prefs, dims: v === 'on' })}
      />
    </>
  );
  const key = changes && (
    <span className="elev-key" aria-label="Key">
      <span>
        <span className="elev-key-swatch elev-key-new" aria-hidden="true" />
        New
      </span>
      <span>
        <span className="elev-key-swatch elev-key-moved" aria-hidden="true" />
        Moved
      </span>
      <span>
        <span className="elev-key-swatch elev-key-removed" aria-hidden="true" />
        Removed
      </span>
      <span>
        <span className="elev-key-swatch elev-key-hacked" aria-hidden="true" />
        Hacked
      </span>
    </span>
  );

  return (
    <section
      className={`elev-pane${oneView ? ' elev-phone' : ''}${listShown ? '' : ' elev-list-hidden'}`}
      aria-label="Wall seen straight on"
      data-testid="wall-view"
    >
      <header className="elev-head">
        <div className="elev-title-row">
          <h2 className="elev-title" ref={headRef} tabIndex={-1}>
            {title}
          </h2>
          {toCheck > 0 && (
            <button type="button" className="link-btn elev-check warning-text" onClick={showList}>
              <span className="elev-badge" aria-hidden="true">
                !
              </span>
              {toCheck} to check
            </button>
          )}
          {!oneView && (
            <button
              type="button"
              className="icon-btn elev-close"
              aria-label="Close"
              title="Close (Esc)"
              onClick={closeView}
            >
              {icons.close}
            </button>
          )}
        </div>
        <p className="elev-sub">{sub}</p>
        {!oneView && (
          <div className="elev-controls">
            <span className="elev-step">
              <button
                type="button"
                className="icon-btn"
                aria-label="Previous wall"
                title="Previous wall ([)"
                onClick={() => step(-1)}
              >
                ‹
              </button>
              <span className="elev-place num">
                {place.at > 0 ? `${face.letter} of ${place.of}` : face.letter}
              </span>
              <button
                type="button"
                className="icon-btn"
                aria-label="Next wall"
                title="Next wall (])"
                onClick={() => step(1)}
              >
                ›
              </button>
            </span>
            {otherName && (
              <button type="button" className="btn btn-small" onClick={flip}>
                See from {otherName}
              </button>
            )}
            <details className="elev-menu">
              <summary className="btn btn-small">
                Show <span aria-hidden="true">{icons.chevronDown}</span>
              </summary>
              <div className="elev-menu-body">{furniture}</div>
            </details>
            <button type="button" className="btn btn-small" onClick={save}>
              Save image
            </button>
            {/* The app's own Before | After switch is above; the key says what the colours mean. */}
            {key}
          </div>
        )}
        {oneView && hasReno && (
          <div className="elev-reno">
            <Segmented
              label="Version"
              value={variant}
              options={[
                { value: 'before', label: 'Before' },
                { value: 'after', label: 'After' },
              ]}
              onChange={(v) => {
                useStore.setState({ toast: null });
                useEditor.getState().setVariant(v);
              }}
            />
            {key}
          </div>
        )}
      </header>
      <div className="elev-body">
        <Sheet
          elev={elev}
          changes={changes}
          dims={prefs.dims}
          selection={selection}
          hitPx={oneView ? 44 : 24}
          openTo={face.openTo ? (level.rooms[face.openTo]?.name ?? null) : null}
          label={`${title}, ${size}`}
          tiles={tiles}
          compact={oneView}
        />
        <PointList level={level} elev={elev} changes={changes} />
      </div>
      {oneView && (
        <nav className="elev-bar" aria-label="Walls">
          <button
            type="button"
            className="elev-bar-btn elev-bar-arrow"
            aria-label="Previous wall"
            onClick={() => step(-1)}
          >
            ‹
          </button>
          <details className="elev-menu elev-menu-up">
            <summary
              className="elev-bar-btn num"
              aria-label={`Wall ${face.letter}${place.at > 0 ? ` of ${place.of}` : ''}: choose a wall`}
            >
              {place.at > 0 ? `${face.letter} of ${place.of}` : face.letter}
            </summary>
            <div className="elev-menu-body elev-walls">
              {allFaces.map((f) => (
                <button
                  key={f.index}
                  type="button"
                  className="elev-wall-choice"
                  aria-pressed={f.index === face.index}
                  onClick={(e) => {
                    closeMenu(e);
                    openFace(level, f);
                  }}
                >
                  {faceTitle(f)}
                </button>
              ))}
            </div>
          </details>
          <button
            type="button"
            className="elev-bar-btn elev-bar-arrow"
            aria-label="Next wall"
            onClick={() => step(1)}
          >
            ›
          </button>
          {otherName ? (
            <button
              type="button"
              className="elev-bar-btn elev-bar-flip"
              onClick={flip}
              aria-label={`See from ${otherName}`}
            >
              <span className="elev-flip-small">See from</span>
              <span className="elev-flip-room">{otherName}</span>
            </button>
          ) : (
            // No room on the other side: nothing to see from; its place is kept.
            <span className="elev-bar-gap" aria-hidden="true" />
          )}
          <details className="elev-menu elev-menu-up elev-menu-end">
            <summary className="elev-bar-btn" aria-label="More">
              {icons.more}
            </summary>
            <div className="elev-menu-body">
              {furniture}
              <button
                type="button"
                className="btn elev-menu-item"
                onClick={(e) => {
                  closeMenu(e);
                  save();
                }}
              >
                Save image
              </button>
              <button
                type="button"
                className="btn elev-menu-item elev-landscape-only"
                onClick={(e) => {
                  closeMenu(e);
                  setListShown(!listShown);
                }}
              >
                {listShown ? 'Hide list' : 'Show list'}
              </button>
            </div>
          </details>
          <button type="button" className="elev-bar-btn" onClick={closeView}>
            Close
          </button>
        </nav>
      )}
    </section>
  );
}

/** A second tap within this long (and 30 px) of the first is a double tap: fit the drawing. */
const DOUBLE_TAP_MS = 300;

/** The selected thing's id, if it's on the drawing. */
const selectedId = (s: Selection | null) => s?.id ?? null;

/**
 * The drawing on its framed white sheet: fitted to the sheet, pinch or wheel to zoom, drag
 * to pan, double tap to fit again. Labels are laid out for the scale once a zoom ends.
 */
function Sheet({
  elev,
  changes,
  dims,
  selection,
  hitPx,
  openTo,
  label,
  tiles,
  compact,
}: {
  elev: Elevation;
  changes: ElevationChanges | null;
  dims: boolean;
  selection: Selection | null;
  hitPx: number;
  openTo: string | null;
  label: string;
  /** Bumped when wallpaper tiles have been drawn. */
  tiles: number;
  /** A phone: compact labels, and (held upright) the sheet as tall as the drawing needs. */
  compact: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  // Zoom and pan (px), and the zoom the labels were laid out for.
  const [zoom, setZoom] = useState({ k: 1, x: 0, y: 0 });
  const [labelK, setLabelK] = useState(1);
  const faceKey = `${elev.face.roomId}:${elev.face.index}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: another face starts fitted
  useEffect(() => {
    setZoom({ k: 1, x: 0, y: 0 });
    setLabelK(1);
  }, [faceKey]);
  // Labels are laid out again once the zoom has settled and the fingers have rested (a re-render
  // of the whole drawing, slow on a slow phone, must not land between the taps of a double
  // tap), as a transition, so input that comes meanwhile is handled first.
  const zoomK = useRef(1);
  zoomK.current = zoom.k;
  const lastInput = useRef(0);
  const relayout = useRef(0);
  const scheduleRelayout = () => {
    clearTimeout(relayout.current);
    relayout.current = window.setTimeout(() => {
      if (performance.now() - lastInput.current < 450 || pointers.current.size > 0) {
        scheduleRelayout();
        return;
      }
      startTransition(() => setLabelK(zoomK.current));
    }, 200);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: each settled zoom
  useEffect(() => {
    scheduleRelayout();
    return () => clearTimeout(relayout.current);
  }, [zoom.k]);

  // The fit (scale and box) only changes with the drawing, the sheet's size or the dimensions
  // shown: a pinch or a pan changes only the transform below.
  const { base, vb, natural } = useMemo(() => {
    const lab = (k: number) => elevationLabels(elev, k, 11, { compact });
    const maxChains = dims ? elev.chains.length : 0;
    const base0 = size.w > 0 ? fitScale(elev, size.w, size.h, maxChains, compact) : 50;
    const shown0 = chainsShown(lab(base0), dims);
    const base = size.w > 0 ? fitScale(elev, size.w, size.h, shown0, compact) : 50;
    const shown = chainsShown(lab(base), dims);
    return {
      base,
      vb: drawingBox(elev, base, shown, compact),
      // The height that shows the whole drawing at the sheet's width.
      natural: size.w > 0 ? heightFor(elev, size.w, maxChains, compact) : 0,
    };
  }, [elev, size.w, size.h, dims, compact]);
  const labels = useMemo(
    () => elevationLabels(elev, base * labelK, 11, { compact: compact && labelK < 1.5 }),
    [elev, base, labelK, compact],
  );
  // Centred in the sheet.
  const w = size.w / base;
  const h = size.h / base;
  const vx = vb.x - (w - vb.w) / 2;
  const vy = vb.y - (h - vb.h) / 2;

  // Gestures.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{
    start: { k: number; x: number; y: number };
    from: { x: number; y: number };
    dist: number;
    moved: boolean;
    target: EventTarget | null;
  } | null>(null);
  // A tap waits out the double-tap window before it selects: selecting opens the details
  // sheet (on a phone it changes the layout, and the render can hold the page long enough
  // that a quick second tap lands late), so the first tap of a double tap changes nothing.
  const pendingTap = useRef<{
    t: number;
    x: number;
    y: number;
    timer: number;
    fire: () => void;
  } | null>(null);
  const secondTap = useRef(false);
  /**
   * The last tap that has selected, and what was selected before it: a second press that
   * comes within the window by its own time (a busy page can handle it late, after the first
   * tap has already selected) still makes a double tap, and puts the selection back.
   */
  const firedTap = useRef<{ t: number; x: number; y: number; before: Selection | null } | null>(
    null,
  );
  useEffect(
    () => () => {
      if (pendingTap.current) clearTimeout(pendingTap.current.timer);
    },
    [],
  );
  const local = (e: { clientX: number; clientY: number }) => {
    const r = box.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };
  const centre = () => {
    const ps = [...pointers.current.values()];
    const n = ps.length || 1;
    return {
      x: ps.reduce((s, p) => s + p.x, 0) / n,
      y: ps.reduce((s, p) => s + p.y, 0) / n,
      dist:
        ps.length > 1
          ? Math.hypot((ps[0]?.x ?? 0) - (ps[1]?.x ?? 0), (ps[0]?.y ?? 0) - (ps[1]?.y ?? 0))
          : 0,
    };
  };
  const begin = (target: EventTarget | null) => {
    const c = centre();
    gesture.current = {
      start: zoom,
      from: { x: c.x, y: c.y },
      dist: c.dist,
      moved: gesture.current?.moved ?? false,
      target,
    };
  };
  const onDown = (e: ReactPointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    lastInput.current = performance.now();
    // A press soon after a tap's release, near it, starts a double tap: judged by the events'
    // own times, from the first release to the second press (as phones do), and place on the
    // sheet. The first tap then doesn't select (or, if it already has, is taken back).
    const prev = pendingTap.current ?? firedTap.current;
    const here = local(e);
    secondTap.current =
      !!prev &&
      pointers.current.size === 0 &&
      e.timeStamp - prev.t < DOUBLE_TAP_MS &&
      Math.hypot(here.x - prev.x, here.y - prev.y) < 30;
    if (secondTap.current) {
      if (pendingTap.current) clearTimeout(pendingTap.current.timer);
      else if (firedTap.current) useEditor.getState().select(firedTap.current.before);
      firedTap.current = null;
    }
    pointers.current.set(e.pointerId, local(e));
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    if (pointers.current.size === 1) gesture.current = null;
    begin(gesture.current?.target ?? e.target);
  };
  const onMove = (e: ReactPointerEvent) => {
    if (!pointers.current.has(e.pointerId) || !gesture.current) return;
    pointers.current.set(e.pointerId, local(e));
    const g = gesture.current;
    const c = centre();
    if (!g.moved && Math.hypot(c.x - g.from.x, c.y - g.from.y) < 6 && pointers.current.size < 2)
      return;
    g.moved = true;
    lastInput.current = performance.now();
    // The second press became a drag: not a double tap; the first tap counts.
    if (secondTap.current) {
      secondTap.current = false;
      pendingTap.current?.fire();
    }
    const k = Math.min(
      12,
      Math.max(1, g.dist > 0 && c.dist > 0 ? (g.start.k * c.dist) / g.dist : g.start.k),
    );
    // Keep the point under the gesture's start under its centre now.
    const sx = (g.from.x - g.start.x) / g.start.k;
    const sy = (g.from.y - g.start.y) / g.start.k;
    setZoom({ k, x: c.x - sx * k, y: c.y - sy * k });
  };
  const onUp = (e: ReactPointerEvent) => {
    const g = gesture.current;
    lastInput.current = performance.now();
    pointers.current.delete(e.pointerId);
    if (pointers.current.size > 0) {
      begin(g?.target ?? null);
      return;
    }
    gesture.current = null;
    if (!g || g.moved) return;
    // A tap selects what's under it, once no second tap has come; a second tap soon after
    // and near the first (by time and place on the sheet, not by what it hit) fits the
    // drawing again and selects nothing.
    const at = local(e);
    if (secondTap.current) {
      secondTap.current = false;
      if (pendingTap.current) clearTimeout(pendingTap.current.timer);
      pendingTap.current = null;
      setZoom({ k: 1, x: 0, y: 0 });
      return;
    }
    const prev = pendingTap.current;
    if (prev) {
      // A second tap elsewhere, or too late: the first one counts at once.
      clearTimeout(prev.timer);
      prev.fire();
    }
    const hit = (g.target as Element | null)
      ?.closest?.('[data-elev-hit]')
      ?.getAttribute('data-elev-hit');
    const t = e.timeStamp;
    const fire = () => {
      pendingTap.current = null;
      const ed = useEditor.getState();
      firedTap.current = { t, x: at.x, y: at.y, before: ed.selection };
      if (!hit) ed.select(null);
      else {
        const [kind, id] = hit.split(':') as [Selection['kind'], string];
        ed.select({ kind, id });
      }
    };
    pendingTap.current = {
      t: e.timeStamp,
      x: at.x,
      y: at.y,
      timer: window.setTimeout(fire, DOUBLE_TAP_MS),
      fire,
    };
  };
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const p = { x: e.clientX - r.left, y: e.clientY - r.top };
      setZoom((z) => {
        const k = Math.min(12, Math.max(1, z.k * Math.exp(-e.deltaY * 0.0015)));
        const sx = (p.x - z.x) / z.k;
        const sy = (p.y - z.y) / z.k;
        return k === 1 ? { k: 1, x: 0, y: 0 } : { k, x: p.x - sx * k, y: p.y - sy * k };
      });
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);

  // A cancelled pointer (the browser took the gesture) only ends it: never a tap.
  const onCancel = (e: ReactPointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size === 0) gesture.current = null;
    else begin(gesture.current?.target ?? null);
  };

  const pxPerM = base * labelK;
  const selected = selectedId(selection);
  // biome-ignore lint/correctness/useExhaustiveDependencies: tiles redraws wallpapers once drawn
  const drawing = useMemo(
    () => (
      <ElevationSvg
        elev={elev}
        labels={labels}
        pxPerM={pxPerM}
        changes={changes}
        selected={selected}
        wallpaper={wallpaperUrl}
        dims={dims}
        hitPx={hitPx}
        openTo={openTo}
      />
    ),
    [elev, labels, pxPerM, changes, selected, dims, hitPx, openTo, tiles],
  );
  return (
    <div
      className="elev-sheet-wrap"
      style={
        natural
          ? ({
              '--sheet-h': `${Math.max(180, Math.min(natural, Math.round(window.innerHeight * 0.62)))}px`,
            } as CSSProperties)
          : undefined
      }
    >
      <div
        ref={box}
        className="elev-sheet"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onCancel}
        data-zoom={zoom.k.toFixed(2)}
      >
        {size.w > 0 && (
          <svg
            className="elev-svg"
            width={size.w}
            height={size.h}
            viewBox={`${vx} ${vy} ${w} ${h}`}
            role="img"
            aria-label={label}
            data-px-per-m={pxPerM.toFixed(1)}
          >
            <g
              transform={`translate(${vx + zoom.x / base - vx * zoom.k} ${vy + zoom.y / base - vy * zoom.k}) scale(${zoom.k})`}
            >
              {drawing}
            </g>
          </svg>
        )}
      </div>
    </div>
  );
}

/** What's on the wall as text: what to check, then each point, selectable. */
function PointList({
  level,
  elev,
  changes,
}: {
  level: Level;
  elev: Elevation;
  changes: ElevationChanges | null;
}) {
  const select = (s: Selection) => useEditor.getState().select(s);
  const kindOf = (id: string): Selection['kind'] | null =>
    elev.points.some((p) => p.id === id)
      ? 'point'
      : elev.items.some((i) => i.id === id)
        ? 'item'
        : elev.openings.some((o) => o.id === id)
          ? 'opening'
          : null;
  const fronts = elev.items.some((i) => i.fronts.length > 0);
  const nameOf = (id: string) => {
    const pt = level.points?.[id];
    return pt ? pointName(pt) : 'Point';
  };
  const warnings = (p: Elevation['points'][number]) => [
    ...p.warnings.map((w) => WARNING_TEXT[w]),
    ...(p.onGlass ? ['On a glass wall, where no point can be.'] : []),
  ];
  const warned = elev.points.filter((p) => warnings(p).length > 0);
  const moved = new Set((changes?.moved ?? []).map((m) => m.id));
  return (
    <div className="elev-list" id="elev-list">
      {(elev.notes.length > 0 || warned.length > 0) && (
        <section aria-labelledby="elev-check-h">
          <h3 id="elev-check-h" className="elev-list-title">
            To check
          </h3>
          <ul className="elev-rows">
            {elev.notes.map((n) => {
              const id = n.ids[0] as string;
              const kind = kindOf(id);
              return (
                <li key={n.n}>
                  <button
                    type="button"
                    className="elev-row"
                    onClick={() => kind && select({ kind, id })}
                  >
                    <span className="elev-badge num" aria-hidden="true">
                      !{n.n}
                    </span>
                    <span className="warning-text">{n.text}</span>
                  </button>
                </li>
              );
            })}
            {/* Points' own warnings, as the plan has them: a quieter kind, ringed on the drawing. */}
            {warned.map((p) => (
              <li key={`w${p.id}`}>
                <button
                  type="button"
                  className="elev-row elev-row-point-warning"
                  onClick={() => select({ kind: 'point', id: p.id })}
                >
                  <span className="elev-ring num" aria-hidden="true">
                    {p.n}
                  </span>
                  <span className="warning-text">
                    {nameOf(p.id)} {p.n}: {warnings(p).join(' ')}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {elev.points.length > 0 && (
        <section aria-labelledby="elev-points-h">
          <h3 id="elev-points-h" className="elev-list-title">
            Points on this wall
          </h3>
          <ul className="elev-rows">
            {elev.points.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className="elev-row"
                  data-point={p.id}
                  onClick={() => select({ kind: 'point', id: p.id })}
                >
                  <span className="elev-n num">{p.n}</span>
                  <span>
                    <span className="elev-row-name">{nameOf(p.id)}</span>
                    <span className="elev-row-sub num">
                      {Math.round(p.tagHeight * 1000)} from floor · {Math.round(p.fromLeft * 1000)}{' '}
                      from left corner
                      {p.kind === 'aircon' ? ' (to the top of the unit)' : ''}
                    </span>
                    {moved.has(p.id) && (
                      <span className="elev-row-sub elev-row-moved">Moved in the renovation</span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {elev.empty && <p className="field-hint">Nothing on this wall yet.</p>}
      {fronts && (
        <p className="field-hint">Doors are indicative: your carpenter’s drawing sets them.</p>
      )}
      <p className="field-hint">
        Heights from the finished floor, to the centre of each plate (aircon: to the top of the
        unit). Check the floor finish on site.
      </p>
    </div>
  );
}
