import { type Level, finish, itemFootprint, planGeometry, roomShapes } from '@dhd/core';
import { useMemo } from 'react';

/**
 * A small drawing of a layout: rooms faintly, walls filled; walls that are new or changed
 * (glass, half height) in the accent colour, and walls taken down dashed. With `furnished`,
 * rooms are tinted by their floor and pieces drawn as outlines; with `box`, several drawings
 * share one frame, so they are at one scale side by side.
 */

type P = { x: number; y: number };
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
const pts = (ps: P[]) => ps.map((q) => `${q.x},${q.y}`).join(' ');

/** The middle of a wall, and whether a wall of `level` runs through that point. */
function middle(level: Level, id: string): P | null {
  const w = level.walls[id];
  const a = w && level.vertices[w.a];
  const b = w && level.vertices[w.b];
  return a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : null;
}
function onAWall(level: Level, p: P): boolean {
  return Object.values(level.walls).some((w) => {
    const a = level.vertices[w.a];
    const b = level.vertices[w.b];
    if (!a || !b) return false;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-9) return false;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    return Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y) < Math.max(0.05, w.thickness / 2);
  });
}

/** The frame that holds every one of `levels`' walls, with a margin: one scale for them all. */
export function sharedBox(levels: Level[], margin = 0.3): Box | null {
  const all = levels.flatMap((l) => planGeometry(l).pieces.flatMap((p) => p.polygon));
  if (!all.length) return null;
  const xs = all.map((p) => p.x);
  const ys = all.map((p) => p.y);
  const x = Math.min(...xs) - margin;
  const y = Math.min(...ys) - margin;
  return { x, y, w: Math.max(...xs) - x + margin, h: Math.max(...ys) - y + margin };
}

export function MiniLayout({
  before,
  level,
  box,
  furnished = false,
  className = 'mini-layout',
}: {
  before: Level;
  level: Level;
  box?: Box | null;
  furnished?: boolean;
  className?: string;
}) {
  const geom = useMemo(() => planGeometry(level), [level]);
  const was = useMemo(() => planGeometry(before), [before]);
  const rooms = useMemo(() => [...roomShapes(level).entries()], [level]);
  const frame = useMemo(() => box ?? sharedBox([level]), [box, level]);
  if (!frame) return null;
  const changed = (id: string) => {
    const old = before.walls[id];
    const now = level.walls[id];
    if (!old) {
      // A piece of an old wall split by a new one isn't new.
      const m = middle(level, id);
      return !m || !onAWall(before, m);
    }
    return !!now && (old.build !== now.build || old.height !== now.height);
  };
  const gone = was.pieces.filter((p) => {
    if (level.walls[p.wallId]) return false;
    const m = middle(before, p.wallId);
    return !m || !onAWall(level, m);
  });
  return (
    <svg
      className={className}
      viewBox={`${frame.x} ${frame.y} ${frame.w} ${frame.h}`}
      aria-hidden="true"
    >
      {rooms.map(([id, r]) => {
        const floor = furnished ? finish(level.rooms[id]?.floorMaterial ?? '')?.color : undefined;
        return (
          <polygon
            key={`r${id}`}
            className="mini-room"
            points={pts(r.outer)}
            style={floor ? { fill: `color-mix(in srgb, ${floor} 38%, var(--surface))` } : undefined}
          />
        );
      })}
      {furnished &&
        Object.values(level.items).map((it) => (
          <polygon key={it.id} className="mini-item" points={pts(itemFootprint(it))} />
        ))}
      {geom.pieces.map((p, i) => (
        <polygon
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed drawing
          key={i}
          className={changed(p.wallId) ? 'mini-new' : undefined}
          points={pts(p.polygon)}
        />
      ))}
      {gone.map((p, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed drawing
        <polygon key={`g${i}`} className="mini-gone" points={pts(p.polygon)} />
      ))}
    </svg>
  );
}
