import {
  FLOOR_FINISHES,
  type ItemPatch,
  type Level,
  type Opening,
  PAINTS,
  addItem,
  cornerSpot,
  deleteItem,
  deleteModel,
  deleteOpening,
  deleteRoom,
  deleteVertex,
  deleteWall,
  duplicateOf,
  furnitureKind,
  isBoundary,
  itemSize,
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
} from '@dhd/core';
import { useEffect, useRef, useState } from 'react';
import { useEditor } from '../editor';
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
function PaintField({
  label,
  value,
  onPick,
}: {
  label: string;
  value: string;
  onPick: (id: string) => void;
}) {
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
      </span>
    </div>
  );
}

const THICKNESS_HINT = 'HDB walls are usually 0.10 m inside and 0.20 m on the outside.';

export function Inspector() {
  const level = useLevel();
  const selection = useEditor((s) => s.selection);
  const tool = useEditor((s) => s.tool);
  const viewer = useStore((s) => s.role === 'viewer');
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
  const reveal = useRef(0);
  useEffect(() => {
    if (!directionToken) return;
    reveal.current = directionToken;
    setUserOpen(true);
  }, [directionToken]);
  const open = userOpen ?? (!!selection || tool !== 'select');
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
  let body = <PlanSummary level={level} />;
  if (selection?.kind === 'wall' && level.walls[selection.id]) {
    body = <WallInspector key={key} level={level} id={selection.id} />;
  } else if (selection?.kind === 'vertex' && level.vertices[selection.id]) {
    body = <VertexInspector key={key} level={level} id={selection.id} />;
  } else if (selection?.kind === 'opening' && level.openings[selection.id]) {
    body = <OpeningInspector key={key} level={level} id={selection.id} />;
  } else if (selection?.kind === 'item' && level.items[selection.id]) {
    body = <ItemInspector key={key} level={level} id={selection.id} />;
  } else if (selection?.kind === 'room' && level.rooms[selection.id]) {
    body = <RoomInspector key={key} level={level} id={selection.id} />;
  }
  return (
    <aside
      ref={panel}
      className={`panel inspector${open ? '' : ' inspector-folded'}`}
      aria-label="Details"
    >
      <button
        type="button"
        className="inspector-toggle"
        aria-expanded={open}
        onClick={() => setUserOpen(!open)}
      >
        {open ? 'Hide details' : 'Show plan details'}
      </button>
      {/* With something selected (a piece just placed), its details come first. */}
      {!selection && <ToolPanel />}
      {/* A view-only link shows the details but can't change them. */}
      <fieldset className="inspector-body" disabled={viewer}>
        {body}
      </fieldset>
      {selection && <ToolPanel />}
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

function PlanSummary({ level }: { level: Level }) {
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
      <RenovationSection />
      <LengthField
        label="Ceiling height"
        value={level.ceilingHeight}
        min={1.8}
        max={6}
        onCommit={(v) => v !== undefined && dispatch(setCeilingHeight(level.id, v))}
      />
      <NorthField />
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

function WallInspector({ level, id }: { level: Level; id: string }) {
  const dispatch = useStore((s) => s.dispatch);
  const wall = level.walls[id];
  if (!wall) return null;
  const length = wallLine(level, wall).length;
  const onWall = Object.values(level.openings).filter((o) => o.wallId === id).length;
  const boundary = isBoundary(wall);
  // Near the middle, but beside a door or window rather than in it.
  const corner = cornerSpot(level, id);
  return (
    <>
      <Header title={boundary ? 'Room boundary' : 'Wall'} onClose={clear} />
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
          <WallPaint level={level} id={id} />
          <LengthField
            label="Thickness"
            value={wall.thickness}
            min={0.02}
            max={1}
            hint={THICKNESS_HINT}
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
          dispatch(deleteWall(level.id, id, level));
          clear();
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
      <LengthField
        label="Width"
        value={size.w}
        min={0.05}
        max={10}
        onCommit={(v) => v !== undefined && set({ scale: { x: v / base.w } })}
      />
      <LengthField
        label="Depth"
        value={size.d}
        min={0.05}
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
      <OwnModel id={it.assetId} />
    </>
  );
}

/** For a piece made from a model uploaded to this plan: the model's name, and taking it out. */
function OwnModel({ id }: { id: string }) {
  const dispatch = useStore((s) => s.dispatch);
  const project = useProject();
  const model = project.models?.[id];
  if (!model) return null;
  const uses = modelUses(project, id);
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
  return (
    <>
      <Header title={title} onClose={clear} />
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
      {o.kind === 'door' && (
        <div className="button-row">
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
        To move the room, drag the handle in it on the plan, or use the arrow keys. Its furniture
        goes with it; walls joined to it stretch.
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
