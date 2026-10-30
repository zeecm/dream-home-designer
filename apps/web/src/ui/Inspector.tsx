import {
  type Level,
  type Opening,
  deleteOpening,
  deleteVertex,
  deleteWall,
  moveVertex,
  roomArea,
  setCeilingHeight,
  setWallLength,
  settleVertex,
  updateOpening,
  updateRoom,
  updateWall,
  wallLine,
} from '@dhd/core';
import { useEditor } from '../editor';
import { useProject, useStore } from '../store';
import { formatArea, formatLength } from '../units';
import { LengthField, Segmented, SelectField, TextField } from './fields';
import { icons } from './icons';

const FLOORS = [
  { value: 'wood-oak', label: 'Oak' },
  { value: 'wood-walnut', label: 'Walnut' },
  { value: 'tile-grey', label: 'Grey tile' },
  { value: 'paint-white', label: 'Plain' },
];

const THICKNESS_HINT = 'HDB walls are usually 0.10 m inside and 0.20 m on the outside.';

export function Inspector() {
  const level = useProject().levels[0];
  const selection = useEditor((s) => s.selection);
  if (!level) return null;
  let body = <PlanSummary level={level} />;
  if (selection?.kind === 'wall' && level.walls[selection.id]) {
    body = <WallInspector level={level} id={selection.id} />;
  } else if (selection?.kind === 'vertex' && level.vertices[selection.id]) {
    body = <VertexInspector level={level} id={selection.id} />;
  } else if (selection?.kind === 'opening' && level.openings[selection.id]) {
    body = <OpeningInspector level={level} id={selection.id} />;
  } else if (selection?.kind === 'room' && level.rooms[selection.id]) {
    body = <RoomInspector level={level} id={selection.id} />;
  }
  return (
    <aside className="panel inspector" aria-label="Details">
      {body}
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
  const walls = Object.keys(level.walls).length;
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
      <LengthField
        label="Ceiling height"
        value={level.ceilingHeight}
        min={1.8}
        max={6}
        onCommit={(v) => v !== undefined && dispatch(setCeilingHeight(level.id, v))}
      />
    </>
  );
}

function WallInspector({ level, id }: { level: Level; id: string }) {
  const dispatch = useStore((s) => s.dispatch);
  const wall = level.walls[id];
  if (!wall) return null;
  const length = wallLine(level, wall).length;
  const onWall = Object.values(level.openings).filter((o) => o.wallId === id).length;
  return (
    <>
      <Header title="Wall" onClose={clear} />
      <LengthField
        label="Length"
        value={length}
        min={0.05}
        max={50}
        hint="The far end moves; walls square to it move with it."
        onCommit={(v) => v !== undefined && dispatch(setWallLength(level.id, id, v))}
      />
      <LengthField
        label="Thickness"
        value={wall.thickness}
        min={0.02}
        max={1}
        hint={THICKNESS_HINT}
        onCommit={(v) => v !== undefined && dispatch(updateWall(level.id, id, { thickness: v }))}
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
      {onWall > 0 && (
        <p className="note">
          {onWall === 1 ? '1 opening is' : `${onWall} openings are`} on this wall and will be
          deleted with it.
        </p>
      )}
      <DeleteButton
        label="Delete wall"
        onClick={() => {
          dispatch(deleteWall(level.id, id));
          clear();
        }}
      />
    </>
  );
}

function VertexInspector({ level, id }: { level: Level; id: string }) {
  const dispatch = useStore((s) => s.dispatch);
  const v = level.vertices[id];
  if (!v) return null;
  const walls = Object.values(level.walls).filter((w) => w.a === id || w.b === id).length;
  const move = (x: number, y: number) => {
    const key = `move:${id}:${Date.now()}`;
    dispatch(moveVertex(level.id, id, { x, y }), { coalesceKey: key });
    const moved = useStore.getState().editor.doc.levels[0];
    if (moved) dispatch(settleVertex(moved, id), { coalesceKey: key });
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
      <p className="note">
        {walls === 1 ? '1 wall meets' : `${walls} walls meet`} here. Dragging the corner moves them
        all.
      </p>
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
  const room = level.rooms[id];
  if (!room) return null;
  return (
    <>
      <Header title="Room" onClose={clear} />
      <TextField
        label="Name"
        value={room.name}
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
    </>
  );
}
