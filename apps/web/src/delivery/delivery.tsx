import {
  type CustomModel,
  type Delivery,
  type DoorOnTheWay,
  type Level,
  addModel,
  deliverable,
  deliveryCheck,
  furnitureKind,
  mainDoors,
  newId,
} from '@dhd/core';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { useEditor } from '../editor';
import { useProject, useStore } from '../store';
import { icons } from '../ui/icons';
import { formatLength, parseLength } from '../units';

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

const isOwn = (level: Level, itemId: string) => {
  const a = level.items[itemId]?.assetId ?? '';
  return !furnitureKind(a)?.model && a.startsWith('mdl_');
};

/** The way in for a piece, from the chosen main door (or the widest), on the level shown. */
export function useDelivery(level: Level | undefined, itemId: string | undefined): Delivery | null {
  const projectId = useProject().id;
  const chosen = useFrom((s) => s.from[projectId]) ?? loadFrom(projectId);
  return useMemo(() => {
    if (!level || !itemId || !level.items[itemId]) return null;
    if (!deliverable(level.items[itemId]?.assetId ?? '')) return null;
    const doors = mainDoors(level);
    const from = chosen && doors.includes(chosen) ? chosen : undefined;
    return deliveryCheck(level, itemId, from ? { from } : {});
  }, [level, itemId, chosen]);
}

/** A door's name: the main door (the first on the way), or by the room it leads into. */
const doorName = (level: Level, d: DoorOnTheWay, main?: string) =>
  d.openingId === 'lift'
    ? 'the lift door'
    : d.openingId === main || !d.into
      ? 'the main door'
      : `the ${level.rooms[d.into]?.name ?? 'room'} door`;

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

/** The verdict in a sentence. */
export function deliveryText(level: Level, r: Delivery, name: string): string {
  switch (r.status) {
    case 'no-room':
      return 'Put it in a room to check the way in.';
    case 'no-door':
      return 'Add the main door first.';
    case 'unreachable':
      return 'There’s no way in to this room through the doors drawn.';
    default: {
      const w = r.worst;
      if (!w) return 'Fits through every door on the way in.';
      const where = doorName(level, w, r.from);
      if (r.status === 'fits' || r.status === 'tight') {
        // The door it's tightest through (the worst), else the narrowest.
        const narrowest =
          r.status === 'tight' ? w : r.doors.reduce((p, q) => (q.clear < p.clear ? q : p));
        const head =
          r.status === 'tight'
            ? 'Just fits through every door on the way in'
            : 'Fits through every door on the way in';
        return `${head}. Narrowest: ${doorName(level, narrowest, r.from)}, ${formatLength(narrowest.clear)}.`;
      }
      if (r.status === 'hinges') {
        return `Fits through ${where} with the door off its hinges (${formatLength(w.clear)} clear with it on).`;
      }
      if (w.turn) {
        return `Can’t turn through ${where} from the ${formatLength(w.turn.space)} space in front.`;
      }
      const lower = name.toLowerCase();
      return `Too big for ${where}: ${formatLength(w.clear)} wide; the ${lower} needs ${formatLength(w.need ?? 0)} on its side.`;
    }
  }
}

/** In a piece's details: whether it gets in, from which main door, and a way to show it. */
export function GettingItIn({ level, id }: { level: Level; id: string }) {
  const projectId = useProject().id;
  const item = level.items[id];
  const own = isOwn(level, id);
  const shown = useWayShown((s) => s.ids.has(id));
  const toggle = useWayShown((s) => s.toggle);
  const r = useDelivery(level, id);
  const setFrom = useFrom((s) => s.set);
  const doors = useMemo(() => mainDoors(level), [level]);
  if (!item || !r) return null;
  const name = furnitureKind(item.assetId)?.name ?? 'piece';
  const bad = r.status === 'too-big' || r.status === 'unreachable';
  return (
    <section className="stack" aria-label="Getting it in">
      <h3 className="section-title">Getting it in</h3>
      {own || shown ? (
        <>
          <p className={`note${bad ? ' warning-text' : ''}`}>{deliveryText(level, r, name)}</p>
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
          <p className="field-hint">
            Measure the lift and the gate too: many HDB lift doors are about 0.9 m wide.
          </p>
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
  const show = !!id && (asked || isOwn(level, id));
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
            </text>
          </g>
        ))}
    </g>
  );
});

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
        <span className="choice-note">Your sofa, bed or cabinet</span>
      </button>
      {open && (
        <AddBySizeDialog
          onClose={() => setOpen(false)}
          onAdded={(id) => {
            setOpen(false);
            onAdded(id);
          }}
        />
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
  useEffect(() => {
    const dlg = ref.current;
    if (dlg && !dlg.open) dlg.showModal();
  }, []);
  const size = (t: string) => {
    const v = parseLength(t);
    return v !== null && v >= 0.05 && v <= 6 ? v : null;
  };
  const save = () => {
    const sw = size(w);
    const sd = size(d);
    const sh = size(h);
    if (!name.trim() || sw === null || sd === null || sh === null) {
      setError('Give it a name and a width, depth and height between 0.05 and 6 m.');
      return;
    }
    const sdiag = shape === 'sofa' && diag.trim() ? size(diag) : null;
    // A diagonal is at least the shorter of depth and height, and at most their diagonal.
    if (
      shape === 'sofa' &&
      diag.trim() &&
      (sdiag === null || sdiag < Math.min(sd, sh) - 0.005 || sdiag > Math.hypot(sd, sh) + 0.005)
    ) {
      setError(
        `The diagonal depth is between ${formatLength(Math.min(sd, sh))} and ${formatLength(Math.hypot(sd, sh))} for this depth and height.`,
      );
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
  const lengthInput = (label: string, value: string, set: (v: string) => void) => (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        className="input"
        inputMode="decimal"
        placeholder="e.g. 2.1 m or 2100"
        value={value}
        onChange={(e) => set(e.target.value)}
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
                className="input"
                value={name}
                maxLength={80}
                placeholder="e.g. My sofa"
                onChange={(e) => setName(e.target.value)}
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
            {lengthInput('Width', w, setW)}
            {lengthInput('Depth', d, setD)}
            {lengthInput('Height', h, setH)}
            {shape === 'sofa' && (
              <label className="field">
                <span className="field-label">Diagonal depth (optional)</span>
                <input
                  className="input"
                  inputMode="decimal"
                  placeholder="e.g. 0.8 m"
                  value={diag}
                  onChange={(e) => setDiag(e.target.value)}
                />
                <span className="field-hint">
                  From the top of the back to the front edge of the seat: movers tilt a sofa through
                  a door on this.
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
