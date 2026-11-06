import {
  type CustomModel,
  type Delivery,
  type DoorOnTheWay,
  LIFT_PRESETS,
  type Level,
  type Lift,
  type LiftFit,
  type LiftPose,
  addModel,
  deliverable,
  deliveryCheck,
  diagonalFits,
  diagonalRange,
  furnitureKind,
  mainDoors,
  newId,
  partsNote,
  setLift,
  worstDoor,
} from '@dhd/core';
import { memo, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { useEditor } from '../editor';
import { useProject, useStore } from '../store';
import { LengthField } from '../ui/fields';
import { icons } from '../ui/icons';
import { formatLength, parseLength } from '../units';
import { deliveryText, liftNumbers, liftStatus, nb } from './words';

/** Pieces whose way in is shown (the person's own always; others when asked). */
export const useWayShown = create<{ ids: Set<string>; toggle: (id: string) => void }>((set) => ({
  ids: new Set(),
  toggle: (id) =>
    set((s) => {
      const ids = new Set(s.ids);
      if (ids.has(id)) ids.delete(id);
      else ids.add(id);
      return { ids };
    }),
}));

/** The main door chosen for a project, remembered in this browser. */
const fromKey = (projectId: string) => `dhd-from-${projectId}`;
function loadFrom(projectId: string): string | undefined {
  try {
    return window.localStorage.getItem(fromKey(projectId)) ?? undefined;
  } catch {
    return undefined;
  }
}
export const useFrom = create<{
  from: Record<string, string>;
  set: (p: string, id: string) => void;
}>((set) => ({
  from: {},
  set: (p, id) => {
    try {
      window.localStorage.setItem(fromKey(p), id);
    } catch {
      // Not remembered; used for this visit.
    }
    set((s) => ({ from: { ...s.from, [p]: id } }));
  },
}));

/** A piece of the person's own (made by size): its way in is always shown. */
export const wayIsOwn = (level: Level, itemId: string) => {
  const a = level.items[itemId]?.assetId ?? '';
  return !furnitureKind(a)?.model && a.startsWith('mdl_');
};

/**
 * The way in for a piece, from the chosen main door (or the widest), on the level shown, and
 * through the plan's lift when one is set.
 */
export function useDelivery(level: Level | undefined, itemId: string | undefined): Delivery | null {
  const project = useProject();
  const projectId = project.id;
  const lift = project.site?.lift;
  // A model's diagonal changes the way in, though the level doesn't change.
  const models = project.models;
  const chosen = useFrom((s) => s.from[projectId]) ?? loadFrom(projectId);
  // biome-ignore lint/correctness/useExhaustiveDependencies: models feed deliveryCheck's kinds
  return useMemo(() => {
    if (!level || !itemId || !level.items[itemId]) return null;
    if (!deliverable(level.items[itemId]?.assetId ?? '')) return null;
    const doors = mainDoors(level);
    const from = chosen && doors.includes(chosen) ? chosen : undefined;
    return deliveryCheck(level, itemId, { ...(from ? { from } : {}), ...(lift ? { lift } : {}) });
  }, [level, itemId, chosen, lift, models]);
}

/** A main door in the From picker: its width and the room it opens into. */
function doorLabel(level: Level, id: string): string {
  const o = level.openings[id];
  if (!o) return id;
  const wall = level.walls[o.wallId];
  const a = wall && level.vertices[wall.a];
  const b = wall && level.vertices[wall.b];
  // The room nearest the door's middle.
  let near = '';
  if (a && b) {
    const c = { x: a.x + (b.x - a.x) * o.t, y: a.y + (b.y - a.y) * o.t };
    let best = Number.POSITIVE_INFINITY;
    for (const r of Object.values(level.rooms)) {
      const pts = r.loop.map((v) => level.vertices[v]).filter((v) => !!v) as {
        x: number;
        y: number;
      }[];
      if (!pts.length) continue;
      const m = {
        x: pts.reduce((t, p) => t + p.x, 0) / pts.length,
        y: pts.reduce((t, p) => t + p.y, 0) / pts.length,
      };
      const dist = Math.hypot(m.x - c.x, m.y - c.y);
      if (dist < best) {
        best = dist;
        near = r.name;
      }
    }
  }
  return `${near ? `${near} door` : 'Door'}, ${formatLength(o.width)}`;
}

/** The id of a sofa's diagonal depth field in its details ("Your model"). */
export const DIAGONAL_FIELD = 'model-diagonal';

/** Takes the person to the diagonal depth field: scrolled into view and focused. */
function focusDiagonal() {
  const el = document.getElementById(DIAGONAL_FIELD);
  if (!el) return;
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'center', behavior: still ? 'auto' : 'smooth' });
}

/**
 * After the lift changes, brings the verdict into view: on a phone's short sheet it is
 * above the lift's controls. (It is also read out: it's a status.)
 */
function revealVerdict() {
  requestAnimationFrame(() => {
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    document
      .querySelector('.way-verdict')
      ?.scrollIntoView({ block: 'nearest', behavior: still ? 'auto' : 'smooth' });
  });
}

/** In a piece's details: whether it gets in, from which main door, and a way to show it. */
export function GettingItIn({ level, id }: { level: Level; id: string }) {
  const project = useProject();
  const projectId = project.id;
  const lift = project.site?.lift;
  const item = level.items[id];
  const own = wayIsOwn(level, id);
  const shown = useWayShown((s) => s.ids.has(id));
  const toggle = useWayShown((s) => s.toggle);
  const r = useDelivery(level, id);
  const setFrom = useFrom((s) => s.set);
  const viewer = useStore((s) => s.role === 'viewer');
  const doors = useMemo(() => mainDoors(level), [level]);
  if (!item || !r) return null;
  const fit = 'lift' in r ? r.lift : undefined;
  // A bed comes flat: how its mattress and frame panels go, first.
  const parts = partsNote(r);
  const bad = r.status === 'too-big' || r.status === 'unreachable';
  const verdict = deliveryText(level, r, lift);
  // Under the verdict, a line about the lift (one line kept, so the controls don't jump).
  const line = 'doors' in r ? liftStatus(lift, fit, !!parts) : null;
  // An own sofa too wide for a door, its diagonal not measured: tilted, it may go.
  const model = project.models?.[item.assetId];
  const askDiagonal =
    !viewer &&
    own &&
    model?.shape === 'sofa' &&
    // Not measured, or saved out of range (the field says so).
    (!model.diagonal || !diagonalFits(model.diagonal, model.size.d, model.size.h)) &&
    'doors' in r &&
    r.doors.some((d) => d.fit === 'too-big' && d.need !== undefined);
  return (
    <section className="stack way-panel" aria-label="Getting it in">
      <h3 className="section-title">Getting it in</h3>
      {own || shown ? (
        <>
          {/* A status: a change of lift (or of the piece) is read out. Not <output>: it
              takes no paragraphs, and some screen readers don't treat it as live. */}
          {/* biome-ignore lint/a11y/useSemanticElements: see above */}
          <div className="way-verdict" role="status">
            {parts && (
              <p className="note" data-testid="parts-note">
                {parts}
              </p>
            )}
            <p className={`note${bad ? ' warning-text' : ''}`} data-testid="way-verdict">
              {verdict}
            </p>
            {line && (
              <p className="note" data-testid="lift-line">
                {line}
              </p>
            )}
          </div>
          {askDiagonal && (
            <div className="way-ask">
              <p className="note">Measured its diagonal depth? Tilted, it may get through.</p>
              <button type="button" className="btn btn-small" onClick={focusDiagonal}>
                Add diagonal depth
              </button>
            </div>
          )}
          {doors.length > 1 && 'from' in r && (
            <label className="field">
              <span className="field-label">From</span>
              <select
                className="input"
                value={r.from}
                onChange={(e) => setFrom(projectId, e.target.value)}
              >
                {doors.map((d) => {
                  const o = level.openings[d];
                  return (
                    <option key={d} value={d}>
                      {o ? doorLabel(level, d) : d}
                    </option>
                  );
                })}
              </select>
            </label>
          )}
          <LiftChoice lift={lift} />
          {!own && (
            <button type="button" className="btn btn-small" onClick={() => toggle(id)}>
              Hide the way
            </button>
          )}
        </>
      ) : (
        <button type="button" className="btn btn-small" onClick={() => toggle(id)}>
          Show the way
        </button>
      )}
    </section>
  );
}

type LiftChoiceValue = 'unset' | 'none' | Lift['preset'];

const LIFT_CHOICES: { value: LiftChoiceValue; label: string }[] = [
  { value: 'unset', label: 'Not checked' },
  { value: 'typical', label: 'Typical HDB lift' },
  { value: 'older', label: 'Older, smaller lift' },
  { value: 'large', label: 'Large (stretcher) lift' },
  { value: 'measured', label: 'My measurements…' },
  { value: 'none', label: 'No lift' },
];

/** Which lift the block has: one for the whole plan, kept with it. */
function LiftChoice({ lift }: { lift: Lift | null | undefined }) {
  const dispatch = useStore((s) => s.dispatch);
  const viewer = useStore((s) => s.role === 'viewer');
  const selectId = useId();
  const value: LiftChoiceValue =
    lift === undefined ? 'unset' : lift === null ? 'none' : lift.preset;
  const hint = viewer
    ? `${lift ? `${liftNumbers(lift)}. ` : ''}Set by whoever can edit the plan.`
    : value === 'unset'
      ? `Which lift does your block have? Most HDB lift doors are ${nb('0.8–0.9 m')} wide.`
      : value === 'none'
        ? 'Ground floor or a house: the way in starts at the main door.'
        : value === 'measured'
          ? 'Car width is across the door; depth is from the door to the back wall.'
          : `${lift ? liftNumbers(lift) : ''}. Same lift for every piece in this plan.`;
  const choose = (v: LiftChoiceValue) => {
    revealVerdict();
    if (v === 'unset') dispatch(setLift(undefined));
    else if (v === 'none') dispatch(setLift(null));
    else if (v === 'measured') {
      // From the lift chosen before (a typical one if none), to change what differs.
      dispatch(setLift({ ...structuredClone(lift ?? LIFT_PRESETS.typical), preset: 'measured' }));
    } else dispatch(setLift(LIFT_PRESETS[v]));
  };
  return (
    <>
      <div className="field">
        <label className="field-label" htmlFor={selectId}>
          Lift
        </label>
        <select
          id={selectId}
          className="input lift-select"
          value={value}
          aria-describedby={`${selectId}-hint`}
          onChange={(e) => choose(e.target.value as LiftChoiceValue)}
        >
          {LIFT_CHOICES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
        <p className="field-hint" id={`${selectId}-hint`} data-testid="lift-hint">
          {hint}
        </p>
      </div>
      {lift?.preset === 'measured' && !viewer && <LiftMeasurements lift={lift} />}
    </>
  );
}

/** "Between 0.5 and 2.0 m." for a value outside a lift measurement's range. */
const within = (min: number, max: number) => (v: number) =>
  v < min - 1e-9 || v > max + 1e-9
    ? `Between ${min.toFixed(1)} and ${nb(`${max.toFixed(1)} m`)}.`
    : null;
const WIDER = 'The door can’t be wider than the car.';
const TALLER = 'The door can’t be taller than the car.';

/** The five measurements of a lift someone measured; each change saves the whole lift. */
function LiftMeasurements({ lift }: { lift: Lift }) {
  const dispatch = useStore((s) => s.dispatch);
  const put = (change: (l: Lift) => void) => {
    const next = structuredClone(lift);
    change(next);
    dispatch(setLift(next));
    revealVerdict();
  };
  const field = (
    label: string,
    value: number,
    check: (v: number) => string | null,
    set: (l: Lift, v: number) => void,
  ) => (
    <LengthField
      label={label}
      value={value}
      validate={check}
      enterKeyHint="done"
      onCommit={(v) => v !== undefined && put((l) => set(l, v))}
    />
  );
  const { door, car } = lift;
  return (
    <fieldset className="lift-measures">
      <legend className="field-label">Lift measurements</legend>
      <div className="field-row">
        {field(
          'Door width',
          door.width,
          (v) => within(0.5, 2)(v) ?? (v > car.width + 1e-9 ? WIDER : null),
          (l, v) => {
            l.door.width = v;
          },
        )}
        {field(
          'Door height',
          door.height,
          (v) => within(1.8, 2.6)(v) ?? (v > car.height + 1e-9 ? TALLER : null),
          (l, v) => {
            l.door.height = v;
          },
        )}
      </div>
      <div className="field-row">
        {field(
          'Car width',
          car.width,
          (v) => within(0.8, 3)(v) ?? (v < door.width - 1e-9 ? WIDER : null),
          (l, v) => {
            l.car.width = v;
          },
        )}
        {field('Car depth', car.depth, within(0.8, 3), (l, v) => {
          l.car.depth = v;
        })}
      </div>
      <div className="field-row">
        {field(
          'Car height',
          car.height,
          (v) => within(1.9, 3)(v) ?? (v < door.height - 1e-9 ? TALLER : null),
          (l, v) => {
            l.car.height = v;
          },
        )}
      </div>
    </fieldset>
  );
}

const FIT_CLASS = {
  fits: 'way-fits',
  tight: 'way-tight',
  hinges: 'way-hinges',
  'too-big': 'way-bad',
};

/** Over the plan: the way in, door to door to the piece, each door's clear width. */
export const DeliveryLayer = memo(function DeliveryLayer({
  level,
  zoom,
}: { level: Level; zoom: number }) {
  const selection = useEditor((s) => s.selection);
  const id = selection?.kind === 'item' ? selection.id : undefined;
  const asked = useWayShown((s) => (id ? s.ids.has(id) : false));
  const show = !!id && (asked || wayIsOwn(level, id));
  const r = useDelivery(level, show ? id : undefined);
  const item = id ? level.items[id] : undefined;
  if (!r || !('doors' in r) || !item) return null;
  const pts = [
    ...r.doors.filter((d) => d.openingId !== 'lift').map((d) => d.centre),
    { x: item.position.x, y: item.position.z },
  ];
  const font = 11 / zoom;
  return (
    <g className="way" pointerEvents="none" data-export="skip">
      <polyline className="way-line" points={pts.map((p) => `${p.x},${p.y}`).join(' ')} />
      {r.doors
        .filter((d) => d.openingId !== 'lift')
        .map((d) => (
          <g key={d.openingId} className={FIT_CLASS[d.fit]}>
            <circle cx={d.centre.x} cy={d.centre.y} r={6 / zoom} />
            <text x={d.centre.x + 8 / zoom} y={d.centre.y - 6 / zoom} fontSize={font}>
              {formatLength(d.clear)}
              {d.tilted ? ', tilted' : ''}
            </text>
          </g>
        ))}
    </g>
  );
});

/** The Add by size fields that can be refused. */
type Field = 'name' | 'w' | 'd' | 'h' | 'diag';

const SHAPES: { id: NonNullable<CustomModel['shape']>; label: string }[] = [
  { id: 'sofa', label: 'Sofa' },
  { id: 'bed', label: 'Bed' },
  { id: 'table', label: 'Table' },
  { id: 'cabinet', label: 'Cabinet' },
  { id: 'box', label: 'Box' },
];
const COLOURS: { id: NonNullable<CustomModel['material']>; label: string; color: string }[] = [
  { id: 'fabric', label: 'Grey fabric', color: '#8d9096' },
  { id: 'fabric-light', label: 'Light fabric', color: '#d9d3c7' },
  { id: 'wood', label: 'Wood', color: '#b88a5a' },
  { id: 'wood-dark', label: 'Dark wood', color: '#6b4a2f' },
  { id: 'white', label: 'White', color: '#f2f0ec' },
  { id: 'charcoal', label: 'Charcoal', color: '#3c3f44' },
];

/** In the catalogue: add a piece of your own by its measured size. */
export function AddBySize({ onAdded }: { onAdded: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        <span className="catalogue-thumb catalogue-thumb-own" aria-hidden="true">
          +
        </span>
        <span className="catalogue-name">Add by size</span>
        <span className="choice-note">Yours, measured</span>
      </button>
      {/* Outside the catalogue's list, whose button styles would take it over. */}
      {open &&
        createPortal(
          <AddBySizeDialog
            onClose={() => setOpen(false)}
            onAdded={(id) => {
              setOpen(false);
              onAdded(id);
            }}
          />,
          document.body,
        )}
    </>
  );
}

function AddBySizeDialog({
  onClose,
  onAdded,
}: { onClose: () => void; onAdded: (id: string) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const dispatch = useStore((s) => s.dispatch);
  const [name, setName] = useState('');
  const [shape, setShape] = useState<NonNullable<CustomModel['shape']>>('sofa');
  const [w, setW] = useState('');
  const [d, setD] = useState('');
  const [h, setH] = useState('');
  const [diag, setDiag] = useState('');
  const [colour, setColour] = useState<NonNullable<CustomModel['material']>>('fabric');
  const [error, setError] = useState('');
  const [diagError, setDiagError] = useState('');
  /** Fields refused on the last try, in the form's order. */
  const [invalid, setInvalid] = useState<ReadonlySet<Field>>(new Set());
  const inputs = useRef<Partial<Record<Field, HTMLInputElement | null>>>({});
  useEffect(() => {
    const dlg = ref.current;
    if (dlg && !dlg.open) dlg.showModal();
  }, []);
  const size = (t: string) => {
    const v = parseLength(t);
    return v !== null && v >= 0.01 && v <= 6 ? v : null;
  };
  // The diagonal a sofa this deep and high can have, once both are known.
  const sd0 = size(d);
  const sh0 = size(h);
  const range = sd0 !== null && sh0 !== null ? diagonalRange(sd0, sh0) : null;
  const rangeText = (r: { min: number; max: number }) =>
    nb(`${r.min.toFixed(2)}\u2013${r.max.toFixed(2)} m`);
  /** Marks the fields refused and takes the person to the first (on a phone, scrolled to). */
  const refuse = (bad: Field[]) => {
    setInvalid(new Set(bad));
    const first = bad[0] && inputs.current[bad[0]];
    if (first) {
      first.focus({ preventScroll: true });
      first.scrollIntoView({ block: 'center' });
    }
  };
  const save = () => {
    const sw = size(w);
    const sd = size(d);
    const sh = size(h);
    if (!name.trim() || sw === null || sd === null || sh === null) {
      setError('Give it a name and a width, depth and height between 0.01 and 6 m.');
      setDiagError('');
      refuse(
        (
          [
            ['name', !name.trim()],
            ['w', sw === null],
            ['d', sd === null],
            ['h', sh === null],
          ] as const
        )
          .filter(([, bad]) => bad)
          .map(([f]) => f),
      );
      return;
    }
    setError('');
    const sdiag = shape === 'sofa' && diag.trim() ? parseLength(diag) : null;
    // Tipped on its back, a sofa is narrower than its depth or height, but not by much.
    if (shape === 'sofa' && diag.trim() && (sdiag === null || !diagonalFits(sdiag, sd, sh))) {
      const r = diagonalRange(sd, sh);
      setDiagError(`Between ${r.min.toFixed(2)} and ${nb(formatLength(r.max))} for this sofa.`);
      refuse(['diag']);
      return;
    }
    const id = newId('mdl');
    dispatch(
      addModel({
        id,
        name: name.trim().slice(0, 80),
        category:
          shape === 'bed'
            ? 'Bedroom'
            : shape === 'table'
              ? 'Dining'
              : shape === 'cabinet'
                ? 'Storage'
                : 'Living',
        size: { w: sw, d: sd, h: sh },
        shape,
        material: colour,
        ...(sdiag ? { diagonal: sdiag } : {}),
      }),
    );
    onAdded(id);
  };
  const fixed = (f: Field) => setInvalid((s) => new Set([...s].filter((g) => g !== f)));
  const fieldProps = (f: Field) => ({
    ref: (el: HTMLInputElement | null) => {
      inputs.current[f] = el;
    },
    className: `input${invalid.has(f) ? ' invalid' : ''}`,
    'aria-invalid': invalid.has(f),
  });
  const lengthInput = (f: Field, label: string, value: string, set: (v: string) => void) => (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        {...fieldProps(f)}
        inputMode="decimal"
        placeholder="e.g. 2.1 m or 2100"
        value={value}
        onChange={(e) => {
          set(e.target.value);
          fixed(f);
        }}
      />
    </label>
  );
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby="add-size-h"
      tabIndex={-1}
      onClose={(e) => e.target === e.currentTarget && onClose()}
    >
      <form
        className="dialog-form"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <header className="dialog-head">
          <h2 id="add-size-h">Add your furniture</h2>
          <button
            type="button"
            className="icon-btn"
            aria-label="Close"
            onClick={() => ref.current?.close()}
          >
            {icons.close}
          </button>
        </header>
        <div className="dialog-body">
          <p className="dialog-note">
            Measure it at its widest, deepest and highest: you'll see whether it fits the room and
            gets through every door on the way in.
          </p>
          <div className="ai-form">
            <label className="field">
              <span className="field-label">Name</span>
              <input
                {...fieldProps('name')}
                value={name}
                maxLength={80}
                placeholder="e.g. My sofa"
                onChange={(e) => {
                  setName(e.target.value);
                  fixed('name');
                }}
              />
            </label>
            <fieldset className="wish-list">
              <legend className="field-label">Shape</legend>
              <span className="segmented">
                {SHAPES.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    aria-pressed={shape === s.id}
                    onClick={() => setShape(s.id)}
                  >
                    {s.label}
                  </button>
                ))}
              </span>
            </fieldset>
            {lengthInput('w', 'Width', w, setW)}
            {lengthInput('d', 'Depth', d, setD)}
            {lengthInput('h', 'Height', h, setH)}
            {shape === 'sofa' && (
              <label className="field">
                <span className="field-label">Diagonal depth (optional)</span>
                <input
                  {...fieldProps('diag')}
                  inputMode="decimal"
                  value={diag}
                  aria-describedby={`${diagError ? 'add-size-diag-err ' : ''}add-size-diag-hint`}
                  onChange={(e) => {
                    setDiag(e.target.value);
                    setDiagError('');
                    fixed('diag');
                  }}
                />
                {diagError && (
                  <span id="add-size-diag-err" className="field-hint error-text" role="alert">
                    {diagError}
                  </span>
                )}
                <span id="add-size-diag-hint" className="field-hint" data-testid="diagonal-hint">
                  Lay a straight stick from the top of the back to the front of the seat. Measure
                  from the bottom back corner straight to the stick.
                  {range && ` For this sofa: ${rangeText(range)}.`} Leave empty if not measured.
                </span>
              </label>
            )}
            <fieldset className="wish-list">
              <legend className="field-label">Colour</legend>
              <span className="swatches">
                {COLOURS.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className="swatch"
                    style={{ background: c.color }}
                    aria-label={c.label}
                    title={c.label}
                    aria-pressed={colour === c.id}
                    onClick={() => setColour(c.id)}
                  />
                ))}
              </span>
            </fieldset>
          </div>
        </div>
        <footer className="dialog-foot">
          <p className="field-hint warning-text" aria-live="polite">
            {error}
          </p>
          <div className="button-row">
            <button type="submit" className="btn btn-primary">
              Add and place it
            </button>
          </div>
        </footer>
      </form>
    </dialog>
  );
}
