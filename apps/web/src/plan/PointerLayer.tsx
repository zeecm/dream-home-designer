import {
  type Level,
  type Pointer,
  type Vec2,
  furnitureKind,
  itemFootprint,
  planGeometry,
  roomShapes,
} from '@dhd/core';
import { memo, useMemo } from 'react';
import { create } from 'zustand';
import { usePointing } from '../ai/designer/talk/pointers';
import { useTalk } from '../ai/designer/talk/useTalk';
import { useEditor } from '../editor';

/**
 * Pointers on the plan (slice 3a §1.5, §2.2): the target a chip lights (the selection's halo:
 * a piece's outline, a wall along its length, a room's inner outline, a door), the Here pins of
 * the composer's chips, and "Was here" for a target gone since. Never exported.
 */

const pts = (f: Vec2[]) => f.map((p) => `${p.x},${p.y}`).join(' ');
const sameVersion = (p: Pointer, label: string | null) =>
  p.version.kind === 'plan' ? !label : p.version.title === label;

function shapeOf(level: Level, p: Pointer): { poly?: Vec2[]; line?: [Vec2, Vec2] } | null {
  const id = p.targetId;
  if (!id) return null;
  switch (p.kind) {
    case 'item': {
      const it = level.items[id];
      return it && furnitureKind(it.assetId) ? { poly: itemFootprint(it) } : null;
    }
    case 'wall': {
      const w = level.walls[id];
      const a = w && level.vertices[w.a];
      const b = w && level.vertices[w.b];
      return a && b ? { line: [a, b] } : null;
    }
    case 'opening': {
      const o = planGeometry(level).openings.find((x) => x.opening.id === id);
      return o ? { poly: o.polygon } : null;
    }
    case 'room': {
      const s = roomShapes(level).get(id);
      return s ? { poly: s.outer } : null;
    }
    default:
      return null;
  }
}

export const PointerLayer = memo(function PointerLayer({
  level,
  zoom,
}: { level: Level; zoom: number }) {
  const lit = usePointing((s) => s.pointer);
  const gone = usePointing((s) => s.gone);
  const draft = useTalk((s) => s.conv?.draftPointers);
  const label = useEditor((s) =>
    s.preview && s.preview.side === 'version' && !s.preview.start ? s.preview.label : null,
  );
  const px = 1 / zoom;
  const pins = (draft ?? []).filter((p) => p.kind === 'spot' && sameVersion(p, label));
  const shape = useMemo(
    () => (lit && !gone && sameVersion(lit, label) ? shapeOf(level, lit) : null),
    [lit, gone, level, label],
  );
  if (!lit && !pins.length) return null;
  // The spot, and its pin drawn 48 px above it so a finger never hides it (UX §2.2).
  const pin = (at: Vec2, key: string, n: string) => (
    <g key={key} className="ptr-pin" transform={`translate(${at.x} ${at.y})`}>
      <circle className="ptr-pin-spot" r={3 * px} />
      <line className="ptr-pin-stem" x1={0} y1={0} x2={0} y2={-48 * px} />
      <circle r={6 * px} cy={-48 * px} />
      <text y={-58 * px} textAnchor="middle" fontSize={11 * px}>
        {n}
      </text>
    </g>
  );
  return (
    <g
      className="pointer-layer"
      data-export="skip"
      data-testid="pointer-layer"
      pointerEvents="none"
    >
      {shape?.poly && <polygon className="ptr-lit" points={pts(shape.poly)} />}
      {shape?.line && (
        <line
          className="ptr-lit ptr-lit-wall"
          x1={shape.line[0].x}
          y1={shape.line[0].y}
          x2={shape.line[1].x}
          y2={shape.line[1].y}
        />
      )}
      {lit && gone && (
        <g className="ptr-was" transform={`translate(${lit.at.x} ${lit.at.y})`}>
          <circle r={14 * px} />
          <text y={-18 * px} textAnchor="middle" fontSize={11 * px}>
            Was here
          </text>
        </g>
      )}
      {lit &&
        !gone &&
        lit.kind === 'spot' &&
        sameVersion(lit, label) &&
        pin(
          lit.at,
          'lit',
          lit.label.startsWith('Here') ? 'Here' : (lit.label.split(' · ')[0] ?? 'Here'),
        )}
      {pins.map((p, i) => pin(p.at, p.id, pins.length > 1 ? `Here ${i + 1}` : 'Here'))}
    </g>
  );
});

/** The long-press cue: where the finger is held, from 150 ms (UX §2.2). */
export const useHold = create<{ at: Vec2 | null; fired: boolean }>(() => ({
  at: null,
  fired: false,
}));

/** The ring that fills while a finger is held still on empty floor, over the plan. */
export function HoldRing() {
  const at = useHold((s) => s.at);
  if (!at) return null;
  return (
    <svg
      className="hold-ring"
      style={{ left: at.x - 36, top: at.y - 36 }}
      width={72}
      height={72}
      viewBox="0 0 72 72"
      aria-hidden="true"
      data-testid="hold-ring"
    >
      <circle className="hold-ring-track" cx={36} cy={36} r={32} />
      <circle className="hold-ring-fill" cx={36} cy={36} r={32} />
    </svg>
  );
}
