import {
  AFTER_SUFFIX,
  type ElecPoint,
  type Level,
  RULE_NAMES,
  type Suggestion,
  type Suggestions,
  type Vec2,
  addPoints,
  levelBounds,
  pointPosition,
  roomShapes,
  suggestPoints,
  suggestionCost,
} from '@dhd/core';
import { memo, useEffect, useId, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { range, useRates } from '../cost/estimate';
import { useEditor } from '../editor';
import { MAX_ZOOM, MIN_ZOOM, type Size, fitBounds } from '../plan/view';
import { currentLevel, useLevel, useStore } from '../store';
import { icons } from '../ui/icons';
import { KindIcon, glyphRadius, useElectricalOn } from './electrical';
import { ElecGlyph, GLYPH_DEPTH } from './glyph';

/**
 * Suggested points: the usual points for each room, shown as ghosts on the plan and listed
 * by room in the details panel, for the person to leave some out and add the rest. Spec:
 * docs/specs/slice-2s.md (A).
 */

interface SuggestState {
  open: boolean;
  /** Keys of the suggestions left out. */
  out: ReadonlySet<string>;
  /** The room whose row is hovered or focused: its ghosts stand out. */
  room: string | null;
  /** The last ghost tapped, for the status line. */
  status: string;
  /** Points just added, ringed for a moment. */
  added: { ids: string[]; at: number } | null;
  /** Bumped to fit a room in view: its id. */
  focus: { roomId: string; at: number } | null;
  /** The add button to focus after a row goes (a room id; null for Add all). */
  next: string | null | undefined;
  /** When the panel opened on a phone: the plan refits the walls above the grown sheet. */
  fitAll: number;
  /** Bumped to show the suggestions as they are now, without the 150 ms wait. */
  refresh: number;
  openPanel: () => void;
  close: () => void;
  toggle: (s: Suggestion, roomName: string) => void;
  setRoom: (id: string | null) => void;
}

const narrow = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(max-width: 720px)').matches;

export const useSuggest = create<SuggestState>((set, get) => ({
  open: false,
  out: new Set(),
  room: null,
  status: '',
  added: null,
  focus: null,
  next: undefined,
  fitAll: 0,
  refresh: 0,
  openPanel: () => {
    useElectricalOn.getState().set(true);
    const ed = useEditor.getState();
    ed.select(null);
    ed.setTrunking(null);
    // On a phone the plan shrinks above the half-height sheet: show all of it there.
    set({
      open: true,
      out: new Set(),
      room: null,
      status: '',
      next: undefined,
      fitAll: narrow() ? Date.now() : 0,
    });
  },
  close: () => set({ open: false, room: null, status: '' }),
  toggle: (s, roomName) => {
    const out = new Set(get().out);
    const leaving = !out.has(s.key);
    if (leaving) out.add(s.key);
    else out.delete(s.key);
    const what = `${RULE_NAMES[s.rule][0]}, ${roomName}`;
    const status = leaving
      ? `Left out: ${what}. Tap again to keep it. ${s.why}`
      : `Kept: ${what}. ${s.why}`;
    set({ out, status });
  },
  setRoom: (room) => set({ room }),
}));

// Another plan, or a view-only one: nothing to suggest into.
useStore.subscribe((s, prev) => {
  if (!useSuggest.getState().open) return;
  if (s.editor.doc.id !== prev.editor.doc.id || s.role === 'viewer') useSuggest.getState().close();
});

/** The id of the ghost an event is on, if any (the plan routes taps on ghosts here). */
export function ghostKeyOf(target: EventTarget | null): string | null {
  const el = (target as Element | null)?.closest?.('[data-ghost]');
  return el?.getAttribute('data-ghost') ?? null;
}

/** A tap on a ghost: leaves it out, or brings it back. */
export function toggleGhost(key: string) {
  const fresh = freshSuggestions();
  const s = fresh?.result.points.find((p) => p.key === key);
  if (!fresh || !s) return;
  useSuggest.getState().toggle(s, fresh.level.rooms[s.roomId]?.name ?? 'this room');
}

/** Whether suggestions can go in the version shown: a renovation takes them on After only. */
export function useSuggestHere(): boolean {
  const renovating = useStore((s) => !!s.editor.doc.renovation);
  const variant = useEditor((s) => s.variant);
  return !renovating || variant === 'after';
}

/**
 * The flat as it is, for judging structural walls: a renovation's level is judged on the
 * plan's; any other on itself (so an edit doesn't make the cached suggestions miss).
 */
const statusFrom = (levels: readonly Level[], level: Level): Level =>
  level.id.endsWith(AFTER_SUFFIX)
    ? (levels.find((l) => `${l.id}${AFTER_SUFFIX}` === level.id) ?? level)
    : level;

/**
 * The suggestions for the level shown, worked out again 150 ms after the last edit (an undo
 * included) while the panel is open.
 */
export function useSuggestions(): { level: Level; result: Suggestions } | null {
  const open = useSuggest((s) => s.open);
  const here = useSuggestHere();
  const level = useLevel();
  // The plan's levels change only with an edit to the flat as it is (a renovation's Before).
  const planLevels = useStore((s) => s.editor.doc.levels);
  const refresh = useSuggest((s) => s.refresh);
  const [shown, setShown] = useState<Level | undefined>();
  useEffect(() => {
    if (!open) {
      setShown(undefined);
      return;
    }
    if (!shown || shown.id !== level?.id) {
      setShown(level);
      return;
    }
    if (shown === level) return;
    const t = setTimeout(() => setShown(level), 150);
    return () => clearTimeout(t);
  }, [open, level, shown]);
  // Asked for as it is now (an Add that found the plan changed).
  // biome-ignore lint/correctness/useExhaustiveDependencies: on a request only
  useEffect(() => {
    if (open && refresh) setShown(level);
  }, [refresh]);
  // Opened just now, or another level: at once.
  const lvl = shown && shown.id === level?.id ? shown : level;
  // Kept by object: worked out again only when the level shown or the flat it's judged on is.
  const status = lvl && statusFrom(planLevels, lvl);
  return useMemo(() => {
    if (!open || !here || !lvl || !status) return null;
    return { level: lvl, result: suggestFor(lvl, status) };
  }, [open, here, lvl, status]);
}

/**
 * The panel and the plan ask for the same suggestions: the last kept here too, so a level
 * core can't cache (one just opened, not frozen) is still worked out once.
 */
let last: { level: Level; status: Level; result: Suggestions } | null = null;
function suggestFor(level: Level, status: Level): Suggestions {
  if (last?.level === level && last.status === status) return last.result;
  const result = suggestPoints(level, { statusOf: status });
  last = { level, status, result };
  return result;
}

/** Suggestions as they are now (no wait), for adding: never points on a wall since deleted. */
function freshSuggestions(): { level: Level; result: Suggestions } | null {
  const level = currentLevel();
  if (!level) return null;
  const levels = useStore.getState().editor.doc.levels;
  return { level, result: suggestFor(level, statusFrom(levels, level)) };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "2 bedside sockets, switch, light": what a room's points are, in the order they come. */
function summary(points: readonly Suggestion[]): string {
  const counts = new Map<Suggestion['rule'], number>();
  for (const p of points) counts.set(p.rule, (counts.get(p.rule) ?? 0) + 1);
  return [...counts]
    .map(([rule, n]) => (n === 1 ? RULE_NAMES[rule][0] : `${n} ${RULE_NAMES[rule][1]}`))
    .join(', ');
}

/** Adds points in one step, with its toast; false if nothing could be added. */
function addThese(level: Level, points: readonly Suggestion[], label: string): string[] | null {
  if (!points.length) return null;
  try {
    const r = addPoints(
      level.id,
      points.map((p) => p.point),
      label,
    );
    const before = useStore.getState().editor;
    useStore.getState().dispatch(r.command);
    // Not made (no right to edit, or the renovation refused it): nothing to say it was.
    if (useStore.getState().editor === before) return null;
    useSuggest.setState({ added: { ids: r.ids, at: Date.now() } });
    return r.ids;
  } catch (e) {
    useStore.setState({ notice: (e as Error).message });
    return null;
  }
}

/** Opens the suggestions: in the Electrical tool's options and the plan details. */
export function SuggestButton({ small = false }: { small?: boolean }) {
  const viewer = useStore((s) => s.role === 'viewer');
  const level = useLevel();
  const open = useSuggest((s) => s.open);
  const hint = useId();
  if (viewer || !level) return null;
  const none = Object.keys(level.rooms).length === 0;
  return (
    <div className={small ? 'suggest-entry suggest-entry-small' : 'suggest-entry'}>
      <button
        type="button"
        className={small ? 'btn btn-small' : 'btn btn-block'}
        data-suggest-open=""
        disabled={none}
        aria-describedby={none ? hint : undefined}
        aria-expanded={open}
        onClick={() => useSuggest.getState().openPanel()}
      >
        Suggest points
      </button>
      {none && (
        <span id={hint} className="field-hint">
          Draw rooms first.
        </span>
      )}
    </div>
  );
}

const returnFocus = () =>
  requestAnimationFrame(() =>
    document.querySelector<HTMLButtonElement>('[data-suggest-open]:not(:disabled)')?.focus(),
  );

/** The panel: each room's suggestions to keep or leave out, and what they add to the estimate. */
export function SuggestPanel() {
  const data = useSuggestions();
  const here = useSuggestHere();
  const out = useSuggest((s) => s.out);
  const status = useSuggest((s) => s.status);
  const next = useSuggest((s) => s.next);
  const rates = useRates((s) => s.rates);
  const listRef = useRef<HTMLDivElement>(null);
  const addAllRef = useRef<HTMLButtonElement>(null);
  const close = () => {
    useSuggest.getState().close();
    returnFocus();
  };

  // Esc closes without adding (after a selection, which Esc clears first).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (useEditor.getState().selection || document.querySelector('dialog[open]')) return;
      e.preventDefault();
      useSuggest.getState().close();
      returnFocus();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const rows = useMemo(() => {
    if (!data) return [];
    const { level, result } = data;
    return result.rooms.map((id) => {
      const all = result.points.filter((p) => p.roomId === id);
      const kept = all.filter((p) => !out.has(p.key));
      return {
        id,
        name: level.rooms[id]?.name ?? 'Room',
        all,
        kept,
        cost: suggestionCost(kept, rates),
        notes: result.notes.filter((n) => n.roomId === id).map((n) => n.text),
      };
    });
  }, [data, out, rates]);
  const withPoints = rows.filter((r) => r.all.length > 0);
  const notesOnly = rows.filter((r) => r.all.length === 0);
  const kept = withPoints.flatMap((r) => r.kept);
  const keptRooms = withPoints.filter((r) => r.kept.length > 0).length;
  const total = suggestionCost(kept, rates);

  // After a row is added, focus moves to the next Add, or to Add all.
  useEffect(() => {
    if (next === undefined) return;
    const el = next
      ? listRef.current?.querySelector<HTMLButtonElement>(`[data-add-room="${next}"]`)
      : null;
    (el ?? addAllRef.current)?.focus();
    useSuggest.setState({ next: undefined });
  }, [next]);

  /**
   * Whether what would be added is what the panel shows: an edit in the last 150 ms may have
   * changed it, and then the panel shows it as it is now, for another click.
   */
  const asShown = (fresh: readonly Suggestion[], pick: (p: Suggestion) => boolean) => {
    const sig = (xs: readonly Suggestion[]) =>
      JSON.stringify(xs.filter(pick).map((p) => [p.key, p.point]));
    if (data && sig(fresh) === sig(data.result.points)) return true;
    useSuggest.setState({
      refresh: Date.now(),
      status: 'The suggestions changed with your last edit. Check them, then add.',
    });
    return false;
  };
  const addRoom = (id: string, name: string) => {
    const fresh = freshSuggestions();
    if (!fresh) return;
    const left = useSuggest.getState().out;
    const mine = (p: Suggestion) => p.roomId === id && !left.has(p.key);
    if (!asShown(fresh.result.points, mine)) return;
    const pts = fresh.result.points.filter(mine);
    const label = `Add ${plural(pts.length, 'point')} to ${name}`;
    const i = withPoints.findIndex((r) => r.id === id);
    const after = withPoints.slice(i + 1).find((r) => r.kept.length > 0);
    if (addThese(fresh.level, pts, label)) useSuggest.setState({ next: after?.id ?? null });
  };
  const addAll = () => {
    const fresh = freshSuggestions();
    if (!fresh) return;
    const left = useSuggest.getState().out;
    const kept = (p: Suggestion) => !left.has(p.key);
    if (!asShown(fresh.result.points, kept)) return;
    const pts = fresh.result.points.filter(kept);
    if (addThese(fresh.level, pts, `Add ${plural(pts.length, 'suggested point')}`)) close();
  };
  const toggle = (s: Suggestion, name: string) => useSuggest.getState().toggle(s, name);
  const fit = (id: string) => useSuggest.setState({ focus: { roomId: id, at: Date.now() } });
  const setRoom = useSuggest.getState().setRoom;
  const announce = `${plural(kept.length, 'suggested point')} in ${plural(keptRooms, 'room')}.`;

  return (
    <section className="suggest" aria-labelledby="suggest-h">
      <div className="inspector-head suggest-head">
        <h2 id="suggest-h" className="panel-title">
          Suggested points
        </h2>
        <button
          type="button"
          className="icon-btn"
          aria-label="Close suggested points"
          title="Close (Esc)"
          onClick={close}
        >
          {icons.close}
        </button>
      </div>
      <p className="suggest-intro">
        Typical points for each room of an HDB flat, placed by your furniture. Tap any you don’t
        want, then add them. Check them with your electrician.
      </p>
      {!here ? (
        <p className="suggest-before">
          <span>New points go in the renovation, the flat as it will be.</span>
          <button
            type="button"
            className="link-btn"
            onClick={() => useEditor.getState().setVariant('after')}
          >
            Switch to After
          </button>
        </p>
      ) : (
        <>
          <p className="visually-hidden" aria-live="polite">
            {data ? announce : ''}
          </p>
          <div className="suggest-rows" ref={listRef}>
            {withPoints.length === 0 && (
              <p className="suggest-empty">Every room has its points: nothing to suggest.</p>
            )}
            {withPoints.map((r) => (
              // biome-ignore lint/a11y/useKeyWithClickEvents: the row's buttons are the keyboard path
              <div
                key={r.id}
                className="suggest-row"
                data-testid="suggest-row"
                data-room={r.id}
                // On a move, not as the list appears under a still pointer.
                onPointerMove={() => useSuggest.getState().room !== r.id && setRoom(r.id)}
                onPointerLeave={() => setRoom(null)}
                onFocus={() => setRoom(r.id)}
                onBlur={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setRoom(null);
                }}
                onClick={(e) => {
                  // A tap on the row (not its controls) shows the room.
                  if ((e.target as Element).closest('button, input, label, summary')) return;
                  fit(r.id);
                  setRoom(r.id);
                }}
              >
                <div className="suggest-row-head">
                  <button
                    type="button"
                    className="suggest-room"
                    onClick={() => {
                      fit(r.id);
                      setRoom(r.id);
                    }}
                  >
                    {r.name}
                  </button>
                  <button
                    type="button"
                    className="btn btn-small"
                    data-add-room={r.id}
                    disabled={r.kept.length === 0}
                    onClick={() => addRoom(r.id, r.name)}
                  >
                    Add {r.kept.length}
                  </button>
                </div>
                <p className="suggest-meta num" data-testid="suggest-meta">
                  {r.kept.length === 0
                    ? `All ${r.all.length} left out`
                    : `${plural(r.kept.length, 'point')} · about ${range(r.cost.low, r.cost.high)}`}
                </p>
                {r.kept.length > 0 && <p className="suggest-what">{summary(r.kept)}</p>}
                <details className="suggest-points">
                  <summary>Show points</summary>
                  <ul>
                    {r.all.map((s) => (
                      <li key={s.key}>
                        <label className="check-row" title={s.why}>
                          <input
                            type="checkbox"
                            checked={!out.has(s.key)}
                            onChange={() => toggle(s, r.name)}
                          />
                          <KindIcon kind={s.point.kind} size={20} />
                          <span>
                            {kindLabel(s)} · {s.where}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </details>
                {r.notes.map((n) => (
                  <p key={n} className="suggest-note">
                    {n}
                  </p>
                ))}
              </div>
            ))}
            {notesOnly.map((r) => (
              <div key={r.id} className="suggest-row suggest-row-notes" data-room={r.id}>
                <p className="suggest-row-head">
                  <span className="suggest-room-name">{r.name}</span>
                  <span className="muted"> · nothing to add</span>
                </p>
                {r.notes.map((n) => (
                  <p key={n} className="suggest-note">
                    {n}
                  </p>
                ))}
              </div>
            ))}
          </div>
          {status && (
            <p className="suggest-status" aria-live="polite" data-testid="suggest-status">
              {status}
            </p>
          )}
        </>
      )}
      <div className="suggest-foot">
        {here && kept.length > 0 && (
          <p className="suggest-total num" data-testid="suggest-total">
            <span>
              {plural(kept.length, 'point')} in {plural(keptRooms, 'room')}
            </span>{' '}
            · <span>about {range(total.low, total.high)}</span>
          </p>
        )}
        {here && kept.length > 0 && (
          <button
            type="button"
            className="btn btn-primary btn-block"
            ref={addAllRef}
            onClick={addAll}
          >
            Add all {kept.length}
          </button>
        )}
        <button type="button" className="btn btn-block" onClick={close}>
          Close
        </button>
      </div>
    </section>
  );
}

/** A point's kind as the list names it: "Double socket", "2-gang switch". */
function kindLabel(s: Suggestion): string {
  if (s.point.kind === 'switch') return `${s.point.gang ?? 1}-gang switch`;
  const short: Record<string, string> = {
    'socket-double': 'Double socket',
    'socket-single': 'Single socket',
    light: 'Light',
    aircon: 'Aircon',
    compressor: 'Compressor',
    'water-heater': 'Water heater',
    cooker: 'Cooker',
    tv: 'TV',
    data: 'Data',
  };
  return short[s.point.kind] ?? s.point.kind;
}

const coarse = () =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;

/**
 * The suggestions on the plan, in metres: each a ghost of its symbol in the suggestion colour
 * with a dashed ring (a hollow ring with × when left out), the hovered room outlined, and a
 * ring fading round points just added. Not in the plan's picture.
 */
export const SuggestLayer = memo(function SuggestLayer({
  zoom,
  size,
}: {
  zoom: number;
  size: Size;
}) {
  const data = useSuggestions();
  const out = useSuggest((s) => s.out);
  const room = useSuggest((s) => s.room);
  const focus = useSuggest((s) => s.focus);
  const added = useSuggest((s) => s.added);
  const level = useLevel();
  // Fit a room in view when its row is tapped.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on a new request only
  useEffect(() => {
    if (!focus || !data) return;
    const shape = roomShapes(data.level).get(focus.roomId);
    if (!shape) return;
    const xs = shape.outer.map((p) => p.x);
    const ys = shape.outer.map((p) => p.y);
    const x0 = Math.min(...xs);
    const y0 = Math.min(...ys);
    // Closer than a whole-plan fit: a room fills the plan, with a little room round it.
    const w = Math.max(Math.max(...xs) - x0, 2);
    const h = Math.max(Math.max(...ys) - y0, 2);
    const pad = 24;
    const zoom = Math.min(
      MAX_ZOOM,
      Math.max(MIN_ZOOM, Math.min((size.width - 2 * pad) / w, (size.height - 2 * pad) / h)),
    );
    useEditor.getState().setView({ cx: x0 + w / 2, cy: y0 + h / 2, zoom }, true);
  }, [focus]);
  // Opened on a phone: the walls fill the plan above the sheet, as the sheet grows.
  const fitAll = useSuggest((s) => s.fitAll);
  // biome-ignore lint/correctness/useExhaustiveDependencies: on opening, and the resizes after it
  useEffect(() => {
    if (!fitAll || Date.now() - fitAll > 1000 || !level || size.width === 0) return;
    // After the plan's own keeping of its place on a resize (its effect runs after this one).
    const frame = requestAnimationFrame(() =>
      useEditor.getState().setView(fitBounds(levelBounds(level), size, 12), true),
    );
    return () => cancelAnimationFrame(frame);
  }, [fitAll, size]);
  // The ring round points just added fades in 600 ms.
  const [, rerender] = useState(0);
  useEffect(() => {
    if (!added) return;
    const t = setTimeout(() => {
      useSuggest.setState({ added: null });
      rerender((n) => n + 1);
    }, 700);
    return () => clearTimeout(t);
  }, [added]);

  const r = glyphRadius(zoom);
  const hit = (coarse() ? 22 : 14) / zoom;
  const ghosts = useMemo(() => {
    if (!data) return [];
    return data.result.points.flatMap((s) => {
      const pos = pointPosition(data.level, { ...s.point, id: s.key } as ElecPoint);
      return pos ? [{ s, pos }] : [];
    });
  }, [data]);
  const outline = useMemo(() => {
    if (!data || !room) return null;
    const shape = roomShapes(data.level).get(room);
    return shape ? shape.outer.map((p) => `${p.x},${p.y}`).join(' ') : null;
  }, [data, room]);
  const rings = useMemo(() => {
    if (!added || !level) return [];
    return added.ids.flatMap((id) => {
      const p = level.points?.[id];
      const pos = p && pointPosition(level, p);
      return p && pos ? [{ id, p, pos }] : [];
    });
  }, [added, level]);

  if (!data && rings.length === 0) return null;
  const mid = (p: ElecPoint | Suggestion['point'], pos: { at: Vec2; normal?: Vec2 }) => {
    const n = pos.normal ?? { x: 0, y: 0 };
    const reach = pos.normal ? GLYPH_DEPTH[p.kind] : 0;
    return { x: pos.at.x + n.x * r * reach * 0.5, y: pos.at.y + n.y * r * reach * 0.5 };
  };
  const ringR = (k: string) => r * (k === 'aircon' || k === 'compressor' ? 2.4 : 1.7);
  return (
    <g className="suggest-layer" data-export="skip" data-testid="suggest-layer">
      {outline && <polygon className="sg-room" points={outline} pointerEvents="none" />}
      {ghosts.map(({ s, pos }) => {
        const left = out.has(s.key);
        const c = mid(s.point, pos);
        const ring = ringR(s.point.kind);
        const faded = !!room && s.roomId !== room;
        const x = ring * 0.45;
        return (
          <g
            key={s.key}
            className={`sg-ghost${left ? ' sg-out' : ''}${faded ? ' sg-faded' : ''}`}
            data-ghost={s.key}
            data-testid="suggest-ghost"
            data-room={s.roomId}
            data-left-out={left ? 'true' : undefined}
          >
            <title>{s.why}</title>
            <circle className="sg-hit" cx={c.x} cy={c.y} r={Math.max(ring, hit)} />
            <circle className="sg-ring" cx={c.x} cy={c.y} r={ring} />
            {left ? (
              <path
                className="sg-x"
                d={`M ${c.x - x} ${c.y - x} L ${c.x + x} ${c.y + x} M ${c.x + x} ${c.y - x} L ${c.x - x} ${c.y + x}`}
              />
            ) : (
              <g transform={`translate(${pos.at.x} ${pos.at.y})`} pointerEvents="none">
                <ElecGlyph
                  kind={s.point.kind}
                  gang={s.point.gang}
                  r={r}
                  normal={pos.normal}
                  stroke="var(--suggest)"
                  fill="var(--suggest-soft-solid)"
                  sw={1.3}
                />
              </g>
            )}
          </g>
        );
      })}
      {rings.map(({ id, p, pos }) => {
        const c = mid(p, pos);
        return (
          <circle
            key={`${id}:${added?.at}`}
            className="sg-added"
            cx={c.x}
            cy={c.y}
            r={ringR(p.kind)}
            pointerEvents="none"
          />
        );
      })}
    </g>
  );
});
