import {
  AFTER_SUFFIX,
  DINING_TABLES,
  type DoorStyle,
  FLOOR_FINISHES,
  type ItemPatch,
  type Level,
  type Opening,
  PAINTS,
  WALLPAPERS,
  addItem,
  chairsOf,
  cornerSpot,
  customPaint,
  deleteItem,
  deleteModel,
  deleteOpening,
  deleteRoom,
  deleteVertex,
  deleteWall,
  diagonalFits,
  diagonalRange,
  doorPanels,
  doorStyle,
  duplicateOf,
  finish,
  furnitureKind,
  isBoundary,
  isGlass,
  isHalfWall,
  itemSize,
  markStructural,
  modelUses,
  moveVertex,
  newId,
  roomArea,
  roomOwnWalls,
  setCeilingHeight,
  setSite,
  setWallLength,
  settleVertex,
  siteOf,
  splitWall,
  updateItem,
  updateModel,
  updateOpening,
  updateRoom,
  updateWall,
  wallLine,
  wallStatus,
  wallStatuses,
} from '@dhd/core';
import { wallpaperCanvas } from '@dhd/render';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { AgeingBack, AgeingPanel, ItemAgeing, OlderPersonSection } from '../ageing/ageing';
import { useAgeing } from '../ageing/store';
import {
  doorIssueLines,
  doorsWithIssues,
  hasClearanceRule,
  issueText,
  itemIssueLines,
  itemsWithIssues,
  useClearanceIssues,
  useClearanceOn,
  useOtherLevels,
  useWalkwayReport,
  walkwayLine,
} from '../clearance/clearance';
import { CommentPinsSwitch } from '../comments/ui';
import { CarpentryLine, CostSummary } from '../cost/estimate';
import { DIAGONAL_FIELD, GettingItIn } from '../delivery/delivery';
import { useEditor } from '../editor';
import { ElectricalSummary, PointInspector } from '../electrical/electrical';
import { SuggestPanel, useSuggest } from '../electrical/suggest';
import { RoomViewEntry, ThingViewEntry, ViewerWallEntry, WallViewEntry } from '../elevation/Entry';
import { roomsBeside } from '../plan/keyboard';
import { OPENING_PRESETS, ROOM_NAMES } from '../presets';
import { currentLevel, useLevel, useProject, useStore } from '../store';
import { formatArea, formatLength } from '../units';
import { COMPASS_POINTS, Compass, describeFacing, northForFacing, planFacing } from './Compass';
import { ToolPanel } from './Palette';
import { RenovationSection } from './Renovation';
import { LengthField, Segmented, SelectField, TextField } from './fields';
import { icons } from './icons';

const FLOORS = FLOOR_FINISHES.map((f) => ({ value: f.id, label: f.name }));

/** A row of paint swatches for one side of a wall. */
/** A wallpaper's swatch: its pattern as an image, drawn once. */
const swatchCache = new Map<string, string>();
function wallpaperSwatch(id: string): string | undefined {
  let url = swatchCache.get(id);
  if (!url) {
    url = wallpaperCanvas(id, 96)?.toDataURL();
    if (url) swatchCache.set(id, url);
  }
  return url;
}

/** Paint for a wall side: a paint, any colour, or a wallpaper. */
function PaintField({
  label,
  value,
  onPick,
}: {
  label: string;
  value: string;
  onPick: (id: string) => void;
}) {
  const current = finish(value);
  const custom = !PAINTS.some((p) => p.id === value) && !WALLPAPERS.some((p) => p.id === value);
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <span className="swatches">
        {PAINTS.map((p) => (
          <button
            key={p.id}
            type="button"
            className="swatch"
            style={{ background: p.color }}
            aria-label={`${label}: ${p.name}`}
            title={p.name}
            aria-pressed={value === p.id}
            onClick={() => onPick(p.id)}
          />
        ))}
        {/* Any colour: the browser's picker, behind a swatch showing the one chosen. */}
        <label
          className={`swatch swatch-any${custom ? ' swatch-on' : ''}`}
          title="Any colour"
          style={custom && current ? { background: current.color } : undefined}
        >
          <input
            type="color"
            aria-label={`${label}: any colour`}
            value={current?.color ?? '#ffffff'}
            onChange={(e) => onPick(customPaint(e.target.value))}
          />
        </label>
      </span>
      <span className="swatches swatches-paper" aria-label={`${label}: wallpaper`}>
        {WALLPAPERS.map((p) => {
          const url = wallpaperSwatch(p.id);
          return (
            <button
              key={p.id}
              type="button"
              className="swatch"
              style={{ background: url ? `url(${url}) center / cover` : p.color }}
              aria-label={`${label}: ${p.name} wallpaper`}
              title={`${p.name} wallpaper`}
              aria-pressed={value === p.id}
              onClick={() => onPick(p.id)}
            />
          );
        })}
      </span>
    </div>
  );
}

/** Half-wall heights: a low divider, a counter, a bar top. */
const HALF_WALLS = [0.9, 1, 1.2];

const THICKNESS_HINT = 'HDB walls are usually 0.10 m inside and 0.20 m on the outside.';

export function Inspector() {
  const level = useLevel();
  const selection = useEditor((s) => s.selection);
  const tool = useEditor((s) => s.tool);
  const viewer = useStore((s) => s.role === 'viewer');
  const suggesting = useSuggest((s) => s.open);
  // The older person list (a view link can look at it too).
  const ageingList = useAgeing((s) => s.listOpen && s.setting.profile !== 'off');
  // On a phone the panel folds to one row when there's nothing to edit, so the plan gets
  // the screen; it opens for a selection or a drawing tool, or by hand.
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  // Keyed by object: another selection mounts fresh fields, and the old ones commit any
  // edit in progress to the object it was typed for as they go.
  const key = selection ? `${selection.kind}:${selection.id}` : undefined;
  // Another object decides afresh; a fold by hand holds across tools, so the plan keeps
  // its room on a phone.
  // biome-ignore lint/correctness/useExhaustiveDependencies: another object decides afresh
  useEffect(() => setUserOpen(null), [key]);
  // Another tool or object starts the panel at its top, with its toggle in view.
  const panel = useRef<HTMLElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: on another object or tool
  useEffect(() => {
    if (panel.current) panel.current.scrollTop = 0;
  }, [key, tool]);
  // The plan's compass opens the details at which way the plan faces: unfold first, then
  // scroll once the unfolded panel has laid out (a folded panel hides its body).
  const directionToken = useEditor((s) => s.directionToken);
  const running = useEditor((s) => !!s.trunking);
  const reveal = useRef(0);
  useEffect(() => {
    if (!directionToken) return;
    reveal.current = directionToken;
    setUserOpen(true);
  }, [directionToken]);
  // Suggested points keep it open: the sheet is the list of them. The Comment tool keeps it
  // folded: on a phone the plan is what you comment on.
  // Running trunking folds it too: on a phone the plan needs the height for the bends.
  const open =
    (suggesting && !viewer) ||
    ageingList ||
    (userOpen ?? (!running && (!!selection || (tool !== 'select' && tool !== 'comment'))));
  // A tap low on the plan selects as the finger lifts, and the panel opens under it; the
  // click the browser then sends for that tap lands on the toggle now there, and would fold
  // the panel at once. So the toggle takes a click only if its press began on it (or it had
  // no press: Enter or Space).
  const toggle = useRef<HTMLButtonElement>(null);
  const press = useRef({ onToggle: false, at: Number.NEGATIVE_INFINITY });
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const onToggle = !!toggle.current && toggle.current.contains(e.target as Node);
      press.current = { onToggle, at: e.timeStamp };
    };
    window.addEventListener('pointerdown', down, { capture: true });
    return () => window.removeEventListener('pointerdown', down, { capture: true });
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: after a reveal, once open
  useEffect(() => {
    if (!open || !reveal.current) return;
    reveal.current = 0;
    requestAnimationFrame(() => {
      const section = document.getElementById('facing-h')?.parentElement;
      section?.scrollIntoView({ block: 'start' });
      section?.querySelector<HTMLElement>('[aria-pressed="true"], input')?.focus();
    });
  }, [open, directionToken]);
  if (!level) return null;
  // Suggested points take the plan details' place (a selection still shows its own).
  const suggestShown = suggesting && !viewer;
  const ageingShown = ageingList && !suggestShown;
  let body = suggestShown ? (
    <SuggestPanel />
  ) : ageingShown ? (
    <AgeingPanel />
  ) : (
    <PlanSummary level={level} viewer={viewer} />
  );
  if (selection?.kind === 'wall' && level.walls[selection.id]) {
    body = <WallInspector key={key} level={level} id={selection.id} />;
  } else if (selection?.kind === 'vertex' && level.vertices[selection.id]) {
    body = <VertexInspector key={key} level={level} id={selection.id} />;
  } else if (selection?.kind === 'opening' && level.openings[selection.id]) {
    body = <OpeningInspector key={key} level={level} id={selection.id} />;
  } else if (selection?.kind === 'item' && level.items[selection.id]) {
    body = <ItemInspector key={key} level={level} id={selection.id} />;
  } else if (selection?.kind === 'point' && level.points?.[selection.id]) {
    body = <PointInspector key={key} level={level} id={selection.id} />;
  } else if (selection?.kind === 'room' && level.rooms[selection.id]) {
    body = <RoomInspector key={key} level={level} id={selection.id} />;
  }
  // The plan details and the older person list disable their own editing controls on a view
  // link: the older person check is a way of looking, which a view link can use too.
  const ownDisabling = !selection && !suggestShown;
  return (
    <aside
      ref={panel}
      className={`panel inspector${open ? '' : ' inspector-folded'}${suggestShown && !selection ? ' inspector-suggest' : ''}${ageingShown && !selection ? ' inspector-ageing' : ''}`}
      aria-label="Details"
    >
      <button
        ref={toggle}
        type="button"
        className="inspector-toggle"
        aria-expanded={open}
        onClick={(e) => {
          const p = press.current;
          // The end of a tap that went down elsewhere (a second at most ago).
          if (e.detail > 0 && !p.onToggle && e.timeStamp - p.at < 1000) return;
          setUserOpen(!open);
        }}
      >
        {open ? 'Hide details' : 'Show plan details'}
      </button>
      {/* With something selected (a piece just placed), its details come first. */}
      {!selection && !suggestShown && !ageingShown && <ToolPanel />}
      {/* Opened from the older person list: the way back to it, above the details. */}
      {ageingShown && selection && <AgeingBack selection={selection} />}
      {/* A view link can look at a wall straight on: its way in sits outside the locked fields. */}
      {viewer && selection && <ViewerWallEntry level={level} selection={selection} />}
      {/* A view-only link shows the details but can't change them. */}
      {ownDisabling ? (
        <div className="inspector-body">{body}</div>
      ) : (
        <fieldset className="inspector-body" disabled={viewer}>
          {body}
        </fieldset>
      )}
      {/* A way of looking, not a change: a view link can use it too. */}
      {!selection && !ageingShown && <CommentPinsSwitch />}
      {selection && !suggestShown && <ToolPanel />}
    </aside>
  );
}

function Header({ title, onClose }: { title: string; onClose?: () => void }) {
  return (
    <div className="inspector-head">
      <h2 className="panel-title">{title}</h2>
      {onClose && (
        <button
          type="button"
          className="icon-btn"
          aria-label="Clear selection"
          title="Clear selection (Esc)"
          onClick={onClose}
        >
          {icons.close}
        </button>
      )}
    </div>
  );
}

function DeleteButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="btn btn-danger" onClick={onClick}>
      {icons.trash}
      {label}
    </button>
  );
}

const clear = () => useEditor.getState().select(null);

function PlanSummary({ level, viewer }: { level: Level; viewer: boolean }) {
  const dispatch = useStore((s) => s.dispatch);
  const select = useEditor((s) => s.select);
  const rooms = Object.values(level.rooms)
    .map((r) => ({ room: r, area: roomArea(level, r) }))
    .sort((a, b) => b.area - a.area);
  // The true total, rounded once; the rounded room figures may differ from it by 0.1.
  const total = rooms.reduce((s, r) => s + r.area, 0);
  const walls = Object.values(level.walls).filter((w) => !isBoundary(w)).length;
  const openings = Object.values(level.openings);
  const count = (k: Opening['kind']) => openings.filter((o) => o.kind === k).length;

  return (
    <>
      <fieldset className="inspector-part" disabled={viewer}>
        <Header title="Plan" />
        <section aria-labelledby="rooms-h">
          <h3 id="rooms-h" className="section-title">
            Rooms
          </h3>
          {rooms.length === 0 ? (
            <p className="empty-line">Rooms appear when walls enclose a space.</p>
          ) : (
            <ul className="room-list">
              {rooms.map(({ room, area }) => (
                <li key={room.id}>
                  <button type="button" onClick={() => select({ kind: 'room', id: room.id })}>
                    <span className="room-list-name">{room.name}</span>
                    <span className="num">{formatArea(area)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="total">
            <span>Floor area</span>
            <span className={`num total-figure${rooms.length ? '' : ' muted'}`}>
              {formatArea(total)}
            </span>
          </p>
        </section>
        <dl className="facts">
          <div>
            <dt>Walls</dt>
            <dd className="num">{walls}</dd>
          </div>
          <div>
            <dt>Doors</dt>
            <dd className="num">{count('door')}</dd>
          </div>
          <div>
            <dt>Windows</dt>
            <dd className="num">{count('window')}</dd>
          </div>
        </dl>
        <StructuralSuggestion />
        <ClearanceSummary />
      </fieldset>
      {/* A way of looking: a view link can use it. */}
      <OlderPersonSection />
      <fieldset className="inspector-part" disabled={viewer}>
        <ElectricalSummary level={level} />
        <RenovationSection />
        <CostSummary />
        <LengthField
          label="Ceiling height"
          value={level.ceilingHeight}
          min={1.8}
          max={6}
          onCommit={(v) => v !== undefined && dispatch(setCeilingHeight(level.id, v))}
        />
        <NorthField />
      </fieldset>
    </>
  );
}

/**
 * Which way the plan faces: a compass point for the top of the plan, then fine-tuned to the
 * degree. It sets where the sun comes from in 3D.
 */
function NorthField() {
  const dispatch = useStore((s) => s.dispatch);
  const north = siteOf(useProject()).north;
  const facing = planFacing(north);
  // One undo step per pick, or per drag of the slider (its key is set as the drag starts).
  const drag = useRef('');
  const set = (deg: number, coalesceKey?: string) =>
    dispatch(setSite({ north: northForFacing(deg) }), { coalesceKey });
  const exact = facing % 45 === 0 ? COMPASS_POINTS[facing / 45]?.abbr : undefined;
  return (
    <section className="field" aria-labelledby="facing-h">
      <h3 id="facing-h" className="field-label">
        Top of the plan faces
      </h3>
      <div className="north-row">
        <Compass north={north} />
        <Segmented
          label="Top of the plan faces"
          fill
          value={exact ?? ''}
          options={COMPASS_POINTS.map((p, i) => ({
            value: p.abbr,
            label: p.abbr,
            title: `${p.name[0]?.toUpperCase()}${p.name.slice(1)} (${i * 45}°)`,
          }))}
          onChange={(abbr) => set(COMPASS_POINTS.findIndex((p) => p.abbr === abbr) * 45)}
        />
      </div>
      <div className="north-row">
        <input
          type="range"
          min={0}
          max={359}
          step={1}
          value={facing}
          aria-label="Fine turn, in degrees"
          aria-valuetext={describeFacing(north)}
          onPointerDown={() => {
            drag.current = `north:${Date.now()}`;
          }}
          onKeyDown={() => {
            drag.current = `north:${Date.now()}`;
          }}
          onChange={(e) => set(Number(e.target.value), drag.current || undefined)}
        />
        <span className="num north-deg">{facing}°</span>
      </div>
      <p className="field-hint">{describeFacing(north)}. The 3D view's sun follows it.</p>
    </section>
  );
}

/** A piece's clearances: what's short, in words, or that there's room to use it. */
function ItemClearances({ level, id }: { level: Level; id: string }) {
  const on = useClearanceOn((s) => s.on);
  const issues = useClearanceIssues();
  const h = useId();
  if (!on) return null;
  const lines = itemIssueLines(level, id, issues);
  // A dining table: its chairs' room to pull out is part of it.
  const table = DINING_TABLES.has(level.items[id]?.assetId ?? '');
  const chairs = table ? chairsOf(level, id) : [];
  for (const i of issues) {
    if (i.kind !== 'zone' || i.side !== 'back' || !chairs.includes(i.itemId)) continue;
    const l = issueText(level, i, issues);
    if (!lines.includes(l)) lines.push(l);
  }
  // A rug or a lamp has nothing to check: say nothing rather than "room to use it".
  if (!lines.length && !hasClearanceRule(level, id)) return null;
  return (
    <section className="stack" aria-labelledby={h}>
      <h3 id={h} className="section-title">
        Clearances
      </h3>
      {lines.length ? (
        <ul className="clearance-list warning-text">
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      ) : table && !chairs.length ? (
        <p className="field-hint">Add chairs to check the room to sit.</p>
      ) : (
        <p className="field-hint">Room to use it.</p>
      )}
    </section>
  );
}

/** A door's clearances, only when its leaves hit another door or a piece's doors. */
function DoorClearances({ level, id }: { level: Level; id: string }) {
  const on = useClearanceOn((s) => s.on);
  const issues = useClearanceIssues();
  const h = useId();
  const ref = useRef<HTMLElement>(null);
  const lines = on ? doorIssueLines(level, id, issues) : [];
  const shown = lines.length > 0;
  // A clash that appears (Flip swing, further down a phone's sheet) is brought into view.
  useEffect(() => {
    if (shown) ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [shown]);
  if (!lines.length) return null;
  return (
    <section ref={ref} className="stack" aria-labelledby={h}>
      <h3 id={h} className="section-title">
        Clearances
      </h3>
      <ul className="clearance-list warning-text">
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </section>
  );
}

/**
 * In the plan details: the switch, how many pieces and doors have a problem, a way to each,
 * and the walkways from the main door.
 */
function ClearanceSummary() {
  const { on, set } = useClearanceOn();
  const issues = useClearanceIssues();
  const report = useWalkwayReport();
  const pieces = itemsWithIssues(issues);
  const doors = doorsWithIssues(issues);
  const level = useLevel();
  const others = useOtherLevels(level);
  const stops = [
    ...pieces.map((id) => ({ kind: 'item' as const, id })),
    ...doors.map((id) => ({ kind: 'opening' as const, id })),
  ];
  const next = () => {
    const at = stops.findIndex((s) => s.id === useClearanceOn.getState().shown);
    const stop = stops[(at + 1) % stops.length];
    if (!stop || !level) return;
    let centre: { x: number; y: number } | null = null;
    if (stop.kind === 'item') {
      const it = level.items[stop.id];
      if (it) centre = { x: it.position.x, y: it.position.z };
    } else {
      const o = level.openings[stop.id];
      const w = o && level.walls[o.wallId];
      const a = w && level.vertices[w.a];
      const b = w && level.vertices[w.b];
      if (o && a && b) centre = { x: a.x + (b.x - a.x) * o.t, y: a.y + (b.y - a.y) * o.t };
    }
    if (!centre) return;
    useClearanceOn.setState({ shown: stop.id });
    const ed = useEditor.getState();
    // Into view, at the zoom it was; a door's clash zoomed in to fill about a third of the plan.
    if (ed.view) {
      let zoom = ed.view.zoom;
      if (stop.kind === 'opening') {
        const pts = issues.flatMap((i) =>
          (i.kind === 'doors' && (i.openingId === stop.id || i.otherId === stop.id)) ||
          (i.kind === 'door-front' && i.openingId === stop.id)
            ? [...i.sweep.flat(), ...(i.kind === 'door-front' ? i.zone : [])]
            : [],
        );
        const plan = document.querySelector('svg.plan-svg')?.getBoundingClientRect();
        if (pts.length && plan) {
          const xs = pts.map((p) => p.x);
          const ys = pts.map((p) => p.y);
          const span = Math.max(
            Math.max(...xs) - Math.min(...xs),
            Math.max(...ys) - Math.min(...ys),
            0.5,
          );
          centre = {
            x: (Math.max(...xs) + Math.min(...xs)) / 2,
            y: (Math.max(...ys) + Math.min(...ys)) / 2,
          };
          zoom = Math.max(zoom, Math.min(400, Math.min(plan.width, plan.height) / 3 / span));
        }
      }
      ed.setView({ ...ed.view, cx: centre.x, cy: centre.y, zoom }, true);
    }
    ed.select(stop);
  };
  const what = [
    pieces.length ? `${pieces.length} ${pieces.length === 1 ? 'piece' : 'pieces'}` : '',
    doors.length ? `${doors.length} ${doors.length === 1 ? 'door' : 'doors'}` : '',
  ].filter(Boolean);
  const way = on && level && report ? walkwayLine(level, report, others) : null;
  return (
    <div className="field">
      <label className="check-row">
        <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} />
        <span>Clearance checks</span>
      </label>
      {on && stops.length > 0 && (
        <div className="note structural-guess">
          <span className="warning-text" data-testid="clearance-count">
            {what.join(' and ')} {stops.length === 1 ? 'is' : 'are'} short of room or in the way.
          </span>
          <button type="button" className="btn btn-small" onClick={next}>
            Show next
          </button>
        </div>
      )}
      {way && (
        <p className={`field-hint${way.warn ? ' warning-text' : ''}`} data-testid="walkway-line">
          {way.text}
        </p>
      )}
    </div>
  );
}

/**
 * In the flat as it is: walls thick enough to be structural that nobody has marked, to mark
 * all at once (one undo step).
 */
function StructuralSuggestion() {
  const dispatch = useStore((s) => s.dispatch);
  const before = useEditor((s) => s.variant) === 'before';
  const level = useLevel();
  const likely = useMemo(
    () =>
      level ? [...wallStatuses(level)].filter(([, s]) => s === 'likely').map(([id]) => id) : [],
    [level],
  );
  if (!before || !likely.length) return null;
  return (
    <div className="note structural-guess">
      <span>
        {likely.length === 1 ? '1 wall looks' : `${likely.length} walls look`} structural (200 mm or
        thicker).
      </span>
      <button
        type="button"
        className="btn btn-small"
        onClick={() => dispatch(markStructural(likely, true))}
      >
        Mark {likely.length === 1 ? 'it' : 'them'}
      </button>
    </div>
  );
}

/**
 * Structural or not: a switch, a suggestion for a thick wall nobody has marked, and the
 * household shelter's walls shown as structural for good. Judged on the flat as it is.
 */
function StructuralField({ level, id }: { level: Level; id: string }) {
  const dispatch = useStore((s) => s.dispatch);
  const before = useStore((s) =>
    s.editor.doc.levels.find((l) => l.id === level.id || `${l.id}${AFTER_SUFFIX}` === level.id),
  );
  const base = before?.walls[id] ? before : level;
  const status = wallStatus(base, id);
  const thickness = Math.round((base.walls[id]?.thickness ?? 0) * 1000);
  return (
    <div className="field">
      <label className="check-row">
        <input
          type="checkbox"
          checked={status === 'structural' || status === 'shelter'}
          disabled={status === 'shelter'}
          onChange={(e) => dispatch(markStructural([id], e.target.checked))}
        />
        <span>Structural wall</span>
      </label>
      {status === 'shelter' ? (
        <p className="note warning-text">
          A household shelter wall: HDB doesn’t allow it to be hacked, cut down or replaced.
        </p>
      ) : status === 'likely' ? (
        <div className="note structural-guess">
          <span>{thickness} mm thick, so probably structural.</span>
          <span className="button-row">
            <button
              type="button"
              className="btn btn-small"
              onClick={() => dispatch(markStructural([id], true))}
            >
              Yes, structural
            </button>
            <button
              type="button"
              className="btn btn-small"
              onClick={() => dispatch(markStructural([id], false))}
            >
              No
            </button>
          </span>
        </div>
      ) : (
        <p className="field-hint">Load-bearing concrete. HDB plans draw these solid or hatched.</p>
      )}
    </div>
  );
}

function WallInspector({ level, id }: { level: Level; id: string }) {
  const dispatch = useStore((s) => s.dispatch);
  const wall = level.walls[id];
  if (!wall) return null;
  const length = wallLine(level, wall).length;
  const onWall = Object.values(level.openings).filter((o) => o.wallId === id).length;
  const boundary = isBoundary(wall);
  const glass = isGlass(wall);
  // A wall lower than the ceiling: a half wall (counter or bar height).
  const half = isHalfWall(wall, level.ceilingHeight);
  const heightPreset =
    wall.height === undefined
      ? 'full'
      : (HALF_WALLS.find((h) => Math.abs(h - (wall.height ?? 0)) < 0.004)?.toString() ?? '');
  // Near the middle, but beside a door or window rather than in it.
  const corner = cornerSpot(level, id);
  return (
    <>
      <Header title={boundary ? 'Room boundary' : 'Wall'} onClose={clear} />
      <WallViewEntry level={level} wallId={id} />
      <Segmented
        label="Kind"
        value={boundary ? 'boundary' : 'wall'}
        options={[
          { value: 'wall', label: 'Wall' },
          { value: 'boundary', label: 'Boundary', title: 'Divides rooms without a wall' },
        ]}
        onChange={(kind) => dispatch(updateWall(level.id, id, { kind }))}
      />
      {boundary && (
        <p className="note">
          A boundary divides rooms without a wall, such as an open kitchen and the living room. It
          isn’t built in 3D.
        </p>
      )}
      {!boundary && <StructuralField level={level} id={id} />}
      {!boundary && onWall > 0 && (
        <p className="note">
          Making this a boundary removes its {onWall === 1 ? 'opening' : `${onWall} openings`}.
        </p>
      )}
      <LengthField
        label="Length"
        value={length}
        min={0.05}
        max={50}
        hint="The far end moves; walls square to it move with it."
        onCommit={(v) => v !== undefined && dispatch(setWallLength(level.id, id, v))}
      />
      {!boundary && (
        <>
          <Segmented
            fill
            label="On its line"
            value={wall.side ?? 'centre'}
            options={[
              { value: 'centre', label: 'Centred', title: 'Half the thickness each side' },
              { value: 'left', label: 'One side', title: 'One face on the line' },
              { value: 'right', label: 'Other side', title: 'The other face on the line' },
            ]}
            onChange={(v) =>
              dispatch(updateWall(level.id, id, { side: v === 'centre' ? undefined : v }))
            }
          />
          <div className="field">
            <span className="field-label" aria-hidden="true">
              Built of
            </span>
            <Segmented
              fill
              label="Built of"
              value={glass ? 'glass' : 'solid'}
              options={[
                { value: 'solid', label: 'Solid', title: 'Brick or board, painted' },
                { value: 'glass', label: 'Glass', title: 'A framed glass partition' },
              ]}
              onChange={(build) =>
                dispatch(
                  updateWall(level.id, id, {
                    build,
                    // A framed glass partition is 40–100 mm, whatever the wall was.
                    ...(build === 'glass' && wall.thickness > 0.1 ? { thickness: 0.08 } : {}),
                  }),
                )
              }
            />
          </div>
          {!glass && <WallPaint level={level} id={id} />}
          <LengthField
            label="Thickness"
            value={wall.thickness}
            min={0.02}
            max={1}
            hint={glass ? 'Framed glass partitions are 40–100 mm.' : THICKNESS_HINT}
            onCommit={(v) =>
              v !== undefined && dispatch(updateWall(level.id, id, { thickness: v }))
            }
          />
          <LengthField
            label="Height"
            value={wall.height}
            placeholder={`Auto · ${formatLength(level.ceilingHeight)}`}
            min={0.1}
            max={6}
            allowEmpty
            hint="Leave empty to follow the ceiling height."
            onCommit={(v) => dispatch(updateWall(level.id, id, { height: v }))}
          />
          {!glass && (
            <div className="field">
              <span className="field-label" aria-hidden="true">
                Half wall, mm
              </span>
              <Segmented
                fill
                label="Wall height: full, or a half wall"
                value={heightPreset}
                options={[
                  { value: 'full', label: 'Full', title: 'Up to the ceiling' },
                  ...HALF_WALLS.map((h) => ({
                    value: String(h),
                    label: String(Math.round(h * 1000)),
                    title: `A half wall ${formatLength(h)} high`,
                  })),
                ]}
                onChange={(v) =>
                  dispatch(
                    updateWall(level.id, id, { height: v === 'full' ? undefined : Number(v) }),
                  )
                }
              />
            </div>
          )}
          {!glass && half && (
            <label className="check-row">
              <input
                type="checkbox"
                checked={!!wall.glassAbove}
                onChange={(e) =>
                  dispatch(updateWall(level.id, id, { glassAbove: e.target.checked }))
                }
              />
              <span>Fixed glass above, up to the ceiling</span>
            </label>
          )}
        </>
      )}
      {onWall > 0 && (
        <p className="note">
          {onWall === 1 ? '1 opening is' : `${onWall} openings are`} on this wall and will be
          deleted with it.
        </p>
      )}
      <button
        type="button"
        className="btn"
        title="Or double-click the wall where the corner should go"
        disabled={!corner}
        onClick={() => {
          if (!corner) return;
          const r = splitWall(level.id, id, corner, level);
          dispatch(r.command);
          // The new corner, selected so it can be dragged or nudged into place.
          if (currentLevel()?.vertices[r.vertexId]) {
            useEditor.getState().select({ kind: 'vertex', id: r.vertexId });
          }
        }}
      >
        {icons.split}
        Add a corner
      </button>
      <DeleteButton
        label={boundary ? 'Delete boundary' : 'Delete wall'}
        onClick={() => {
          const was = useStore.getState().editor.doc;
          dispatch(deleteWall(level.id, id, level));
          // Refused (a shelter wall in a renovation): still there, still selected.
          if (useStore.getState().editor.doc !== was) clear();
        }}
      />
    </>
  );
}

/** Paint for each side of a wall, each named by the room it faces. */
function WallPaint({ level, id }: { level: Level; id: string }) {
  const dispatch = useStore((s) => s.dispatch);
  const wall = level.walls[id];
  if (!wall) return null;
  const [left, right] = roomsBeside(level, id);
  const label = (room: string | null | undefined, other: string | null | undefined) =>
    room ? `Paint, ${room} side` : other ? 'Paint, outside' : 'Paint';
  return (
    <>
      <PaintField
        label={label(left, right)}
        value={wall.materialLeft}
        onPick={(m) => dispatch(updateWall(level.id, id, { materialLeft: m }))}
      />
      <PaintField
        label={
          label(right, left) === label(left, right)
            ? `${label(right, left)} (other side)`
            : label(right, left)
        }
        value={wall.materialRight}
        onPick={(m) => dispatch(updateWall(level.id, id, { materialRight: m }))}
      />
    </>
  );
}

function VertexInspector({ level, id }: { level: Level; id: string }) {
  const dispatch = useStore((s) => s.dispatch);
  const v = level.vertices[id];
  if (!v) return null;
  const walls = Object.values(level.walls).filter((w) => w.a === id || w.b === id);
  const settle = (key: string) => {
    const moved = currentLevel();
    if (moved) dispatch(settleVertex(moved, id), { coalesceKey: key });
  };
  const move = (x: number, y: number) => {
    const key = `move:${id}:${Date.now()}`;
    dispatch(moveVertex(level.id, id, { x, y }), { coalesceKey: key });
    settle(key);
  };
  const setLength = (wallId: string, length: number) => {
    const key = `length:${id}:${Date.now()}`;
    dispatch(setWallLength(level.id, wallId, length, 'end', id), { coalesceKey: key });
    settle(key);
  };
  return (
    <>
      <Header title="Corner" onClose={clear} />
      <div className="field-row">
        <LengthField
          label="X"
          value={v.x}
          min={-500}
          max={500}
          onCommit={(x) => x !== undefined && move(x, v.y)}
        />
        <LengthField
          label="Y"
          value={v.y}
          min={-500}
          max={500}
          onCommit={(y) => y !== undefined && move(v.x, y)}
        />
      </div>
      {walls.length > 0 && (
        <section className="stack" aria-labelledby="corner-walls-h">
          <h3 id="corner-walls-h" className="section-title">
            Walls from this corner
          </h3>
          {walls.map((w, i) => {
            const far = level.vertices[w.a === id ? w.b : w.a];
            if (!far) return null;
            const dir = direction(far.x - v.x, far.y - v.y);
            // Two walls heading the same rough way get numbered apart.
            const same = walls.filter((o) => {
              const f = level.vertices[o.a === id ? o.b : o.a];
              return f && direction(f.x - v.x, f.y - v.y) === dir;
            });
            const n = same.length > 1 ? ` (${same.indexOf(w) + 1})` : '';
            return (
              <LengthField
                key={w.id}
                label={`${isBoundary(w) ? 'Boundary' : 'Wall'} ${dir}${n}`}
                value={Math.hypot(far.x - v.x, far.y - v.y)}
                min={0.05}
                max={50}
                onCommit={(len) => len !== undefined && setLength(w.id, len)}
              />
            );
          })}
          <p className="note">
            A new length moves this corner along that wall; its other walls stretch to follow.
          </p>
        </section>
      )}
      <DeleteButton
        label="Delete corner and its walls"
        onClick={() => {
          dispatch(deleteVertex(level.id, id));
          clear();
        }}
      />
    </>
  );
}

/** Where a wall heads on screen: plan +y points down the screen. */
export function direction(dx: number, dy: number): string {
  const deg = (Math.atan2(-dy, dx) * 180) / Math.PI;
  const names = ['right', 'up-right', 'up', 'up-left', 'left', 'down-left', 'down', 'down-right'];
  return names[(Math.round(deg / 45) + 8) % 8] ?? 'right';
}

function ItemInspector({ level, id }: { level: Level; id: string }) {
  const dispatch = useStore((s) => s.dispatch);
  const it = level.items[id];
  if (!it) return null;
  const kind = furnitureKind(it.assetId);
  const size = itemSize(it, kind);
  // What scale 1 measures: the catalogue size, or itemSize's stand-in for an unknown piece.
  const base = kind?.size ?? { w: 0.5, d: 0.5, h: 0.5 };
  const set = (patch: ItemPatch) => dispatch(updateItem(level.id, id, patch));
  const turn = (q: number) => set({ rotationY: it.rotationY + (q * Math.PI) / 2 });
  return (
    <>
      <Header title={kind?.name ?? 'Furniture'} onClose={clear} />
      {/* First, so a phone's sheet shows it without scrolling. */}
      <ItemClearances level={level} id={id} />
      <ThingViewEntry level={level} selection={{ kind: 'item', id }} />
      <ItemAgeing level={level} id={id} kind="item" />
      <CarpentryLine item={it} />
      <GettingItIn level={level} id={id} />
      <LengthField
        label="Width"
        value={size.w}
        min={0.01}
        max={10}
        onCommit={(v) => v !== undefined && set({ scale: { x: v / base.w } })}
      />
      <LengthField
        label="Depth"
        value={size.d}
        min={0.01}
        max={10}
        onCommit={(v) => {
          if (v === undefined) return;
          // A piece against a wall keeps its back there and grows or shrinks at the front.
          const move = it.flags.snapWall ? (v - size.d) / 2 : 0;
          const front = { x: -Math.sin(it.rotationY), y: Math.cos(it.rotationY) };
          set({
            scale: { z: v / base.d },
            position: { x: it.position.x + front.x * move, z: it.position.z + front.y * move },
          });
        }}
      />
      <LengthField
        label="Height"
        value={size.h}
        min={0.01}
        max={level.ceilingHeight}
        onCommit={(v) => v !== undefined && set({ scale: { y: v / base.h } })}
      />
      <LengthField
        label="Above the floor"
        value={it.position.y}
        min={0}
        max={level.ceilingHeight}
        hint={
          kind?.ceiling
            ? 'It hangs from the ceiling, and moves with the ceiling height.'
            : kind?.light
              ? kind.elevation
                ? 'It sits on a table or bedside: set how high that is.'
                : undefined
              : 'Wall cabinets and a TV on a console sit above the floor.'
        }
        onCommit={(v) => v !== undefined && set({ position: { y: v } })}
      />
      <div className="field">
        <span className="field-label" aria-hidden="true">
          Turn
        </span>
        <span className="button-row">
          <button
            type="button"
            className="btn"
            onClick={() => turn(-1)}
            title="Turn left (Shift+R)"
          >
            ↺ 90°
          </button>
          <button type="button" className="btn" onClick={() => turn(1)} title="Turn right (R)">
            ↻ 90°
          </button>
        </span>
      </div>
      <button
        type="button"
        className="btn"
        title="Duplicate (Ctrl+D)"
        onClick={() => {
          const copy = duplicateOf(it, newId('it'));
          dispatch(addItem(level.id, copy));
          useEditor.getState().select({ kind: 'item', id: copy.id });
        }}
      >
        Duplicate
      </button>
      <DeleteButton
        label="Delete"
        onClick={() => {
          dispatch(deleteItem(level.id, id, kind?.name.toLowerCase()));
          clear();
        }}
      />
      <OwnModel id={it.assetId} size={size} />
    </>
  );
}

/**
 * For a piece of the person's own (uploaded, or added by size): the model's name, a sofa's
 * diagonal depth, and taking it out. `size` is this piece's size, as it may be scaled.
 */
function OwnModel({ id, size }: { id: string; size: { w: number; d: number; h: number } }) {
  const dispatch = useStore((s) => s.dispatch);
  const project = useProject();
  const model = project.models?.[id];
  if (!model) return null;
  const uses = modelUses(project, id);
  const m = model.size;
  const range = diagonalRange(m.d, m.h);
  const outOfRange = `Between ${range.min.toFixed(2)} and ${range.max.toFixed(2)}\u00a0m for this sofa.`;
  const span = (r: { min: number; max: number }) =>
    `${r.min.toFixed(2)}\u2013${r.max.toFixed(2)}\u00a0m`;
  // Measured on the sofa as added; this piece has been made bigger or smaller since.
  const scaled =
    !!model.diagonal &&
    (Math.abs(size.w - m.w) > 0.005 ||
      Math.abs(size.d - m.d) > 0.005 ||
      Math.abs(size.h - m.h) > 0.005);
  return (
    <section className="stack" aria-labelledby="own-model-h">
      <h3 id="own-model-h" className="section-title">
        Your model
      </h3>
      <TextField
        label="Model name"
        value={model.name}
        onCommit={(name) => dispatch(updateModel(id, { name }))}
      />
      {model.shape === 'sofa' && (
        <LengthField
          id={DIAGONAL_FIELD}
          label="Diagonal depth"
          value={model.diagonal}
          placeholder="Not measured"
          allowEmpty
          enterKeyHint="done"
          hint={`Lay a straight stick from the top of the back to the front of the seat. Measure from the bottom back corner straight to the stick. For this sofa: ${span(range)}. Leave empty if not measured.${scaled ? ` Measured on the sofa at ${m.w.toFixed(2)} × ${m.d.toFixed(2)} × ${formatLength(m.h)}; scaled with this piece.` : ''}`}
          validate={(v) => (diagonalFits(v, m.d, m.h) ? null : outOfRange)}
          // Saved before the range was right (or edited by hand): said until it's re-entered.
          problem={
            model.diagonal !== undefined && !diagonalFits(model.diagonal, m.d, m.h)
              ? outOfRange
              : null
          }
          onCommit={(v) => dispatch(updateModel(id, { diagonal: v ?? null }))}
        />
      )}
      <DeleteButton
        label={uses > 1 ? `Remove model and its ${uses} pieces` : 'Remove model'}
        onClick={() => {
          dispatch(deleteModel(id));
          clear();
        }}
      />
    </section>
  );
}

function OpeningInspector({ level, id }: { level: Level; id: string }) {
  const dispatch = useStore((s) => s.dispatch);
  const o = level.openings[id];
  const wall = o && level.walls[o.wallId];
  if (!o || !wall) return null;
  const length = wallLine(level, wall).length;
  const set = (patch: Parameters<typeof updateOpening>[2]) =>
    dispatch(updateOpening(level.id, id, patch));
  const title = o.kind === 'door' ? 'Door' : o.kind === 'window' ? 'Window' : 'Opening';
  const swing = o.swing ?? 'leftIn';
  const style = doorStyle(o);
  // Leaves that slide or fold to one end (a double door has a hinge at each).
  const stacks = style !== 'swing' && style !== 'double';
  return (
    <>
      <Header title={title} onClose={clear} />
      {/* First, so a phone's sheet shows it without scrolling. */}
      <DoorClearances level={level} id={id} />
      <ThingViewEntry level={level} selection={{ kind: 'opening', id }} />
      <ItemAgeing level={level} id={id} kind="opening" />
      <Segmented
        label="Kind"
        value={o.kind}
        onChange={(kind) =>
          set(
            kind === 'window' && o.kind !== 'window'
              ? { kind, sill: 0.9, height: 1.2 }
              : kind !== 'window' && o.kind === 'window'
                ? { kind, height: 2.1 }
                : { kind },
          )
        }
        options={[
          { value: 'door', label: 'Door' },
          { value: 'window', label: 'Window' },
          { value: 'passage', label: 'Opening' },
        ]}
      />
      <LengthField
        label="Width"
        value={o.width}
        min={0.3}
        max={length}
        onCommit={(v) => v !== undefined && set({ width: v })}
      />
      <div className="field">
        <span className="field-label" aria-hidden="true">
          Common widths, mm
        </span>
        <Segmented
          label="Common widths in millimetres"
          fill
          value={String(o.width)}
          options={OPENING_PRESETS[o.kind]
            .filter((p) => p.value <= length + 1e-9)
            .map((p) => ({
              value: String(p.value),
              label: String(Math.round(p.value * 1000)),
              title: p.note,
            }))}
          onChange={(w) => set({ width: Number(w) })}
        />
      </div>
      <LengthField
        label="Height"
        value={o.height}
        min={0.3}
        max={level.ceilingHeight}
        onCommit={(v) => v !== undefined && set({ height: v })}
      />
      {o.kind === 'window' && (
        <LengthField
          label="Sill height"
          value={o.sill}
          min={0}
          max={level.ceilingHeight - o.height}
          onCommit={(v) => v !== undefined && set({ sill: v })}
        />
      )}
      <LengthField
        label="From the wall's start"
        value={o.t * length}
        min={0}
        max={length}
        hint="To the opening's centre."
        onCommit={(v) => v !== undefined && set({ t: v / length })}
      />
      {o.kind === 'door' && <DoorStyleFields o={o} set={set} />}
      {o.kind === 'door' && (
        <div className="button-row">
          {stacks ? (
            <button
              type="button"
              className="btn"
              title="Which end the leaves slide or fold to"
              onClick={() => set({ stack: o.stack === 'b' ? 'a' : 'b' })}
            >
              Flip side
            </button>
          ) : (
            <button
              type="button"
              className="btn"
              onClick={() =>
                set({
                  swing:
                    `${swing.startsWith('left') ? 'right' : 'left'}${swing.endsWith('In') ? 'In' : 'Out'}` as Opening['swing'],
                })
              }
            >
              Flip hinge
            </button>
          )}
          <button
            type="button"
            className="btn"
            onClick={() =>
              set({
                swing:
                  `${swing.startsWith('left') ? 'left' : 'right'}${swing.endsWith('In') ? 'Out' : 'In'}` as Opening['swing'],
              })
            }
          >
            Flip swing
          </button>
        </div>
      )}
      <DeleteButton
        label={`Delete ${title.toLowerCase()}`}
        onClick={() => {
          dispatch(deleteOpening(level.id, id));
          clear();
        }}
      />
    </>
  );
}

const DOOR_STYLES: { value: DoorStyle; label: string; title: string }[] = [
  { value: 'swing', label: 'Swing', title: 'One leaf on hinges' },
  { value: 'double', label: 'Double', title: 'Two leaves, hinged at each side' },
  { value: 'sliding', label: 'Sliding', title: 'Leaves slide along tracks' },
  { value: 'pocket', label: 'Pocket', title: 'Slides into the wall' },
  { value: 'bifold', label: 'Bi-fold', title: 'Two or four leaves fold to one side' },
  { value: 'folding', label: 'Folding', title: 'A folding partition: a row of panels' },
];

/** How a door opens, how many leaves it has and whether they are glass. */
function DoorStyleFields({
  o,
  set,
}: {
  o: Opening;
  set: (patch: Parameters<typeof updateOpening>[2]) => void;
}) {
  const style = doorStyle(o);
  const counted = style === 'sliding' || style === 'bifold' || style === 'folding';
  const panels = doorPanels(o);
  // No panel narrower than 25 cm.
  const most = Math.max(1, Math.floor(o.width / 0.25));
  const [min, max] =
    style === 'bifold'
      ? [2, most >= 4 ? 4 : 2] // in pairs
      : style === 'sliding'
        ? [1, Math.min(4, most)]
        : [Math.min(3, most), Math.min(10, most)];
  return (
    <>
      <div className="field">
        <label className="field-label" htmlFor="door-style">
          Opens by
        </label>
        <select
          id="door-style"
          className="input"
          value={style}
          onChange={(e) => set({ style: e.target.value as DoorStyle, panels: undefined })}
        >
          {DOOR_STYLES.map((d) => (
            <option key={d.value} value={d.value} title={d.title}>
              {d.label}
            </option>
          ))}
        </select>
      </div>
      {counted && (
        <div className="field">
          <span className="field-label" id="door-panels">
            {style === 'folding' ? 'Panels' : 'Leaves'}
          </span>
          <fieldset className="stepper" aria-labelledby="door-panels">
            <button
              type="button"
              className="btn"
              aria-label="Fewer"
              disabled={panels <= min}
              onClick={() => set({ panels: Math.max(min, panels - (style === 'bifold' ? 2 : 1)) })}
            >
              −
            </button>
            <span className="num" aria-live="polite">
              {panels}
            </span>
            <button
              type="button"
              className="btn"
              aria-label="More"
              disabled={panels >= max}
              onClick={() => set({ panels: Math.min(max, panels + (style === 'bifold' ? 2 : 1)) })}
            >
              +
            </button>
          </fieldset>
        </div>
      )}
      <div className="field">
        <span className="field-label" aria-hidden="true">
          Leaves of
        </span>
        <Segmented
          fill
          label="Leaves of"
          value={o.glazed ?? 'solid'}
          options={[
            { value: 'solid', label: 'Solid' },
            { value: 'clear', label: 'Glass', title: 'Clear glass' },
            { value: 'frosted', label: 'Frosted', title: 'Frosted or fluted glass' },
          ]}
          onChange={(g) => set({ glazed: g === 'solid' ? undefined : g })}
        />
      </div>
    </>
  );
}

function RoomInspector({ level, id }: { level: Level; id: string }) {
  const dispatch = useStore((s) => s.dispatch);
  const renameToken = useEditor((s) => s.renameToken);
  const room = level.rooms[id];
  if (!room) return null;
  return (
    <>
      <Header title="Room" onClose={clear} />
      <TextField
        label="Name"
        value={room.name}
        suggestions={ROOM_NAMES}
        focusToken={renameToken}
        onDone={() => document.querySelector<SVGSVGElement>('svg.plan-svg')?.focus()}
        onCommit={(name) => dispatch(updateRoom(level.id, id, { name }))}
      />
      <p className="total">
        <span>Floor area</span>
        <span className="num total-figure">{formatArea(roomArea(level, room))}</span>
      </p>
      <RoomViewEntry level={level} roomId={id} />
      <SelectField
        label="Floor"
        value={room.floorMaterial}
        options={FLOORS}
        onChange={(floorMaterial) => dispatch(updateRoom(level.id, id, { floorMaterial }))}
      />
      <LengthField
        label="Ceiling height"
        value={room.ceilingHeight}
        placeholder={`Auto · ${formatLength(level.ceilingHeight)}`}
        min={1.8}
        max={6}
        allowEmpty
        hint="Leave empty to use the flat's ceiling height."
        onCommit={(v) => dispatch(updateRoom(level.id, id, { ceilingHeight: v }))}
      />
      <p className="field-hint">
        To move the room, drag the handle in it on the plan (zoom in on a small room to see it), or
        use the arrow keys. Its furniture goes with it; walls joined to it stretch.
      </p>
      {roomOwnWalls(level, id).length > 0 ? (
        <DeleteButton
          label="Delete room"
          onClick={() => {
            dispatch(deleteRoom(level.id, id, level));
            clear();
          }}
        />
      ) : (
        <p className="field-hint">
          Every wall of this room is shared with another room. Delete one of them to join the two
          rooms.
        </p>
      )}
    </>
  );
}
