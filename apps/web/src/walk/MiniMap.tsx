import { type Level, levelBounds, planGeometry, roomShapes } from '@dhd/core';
import { type MutableRefObject, useEffect, useMemo, useRef } from 'react';
import type { WalkPose } from './WalkControls';

const SIZE = 168;
const PAD = 8;

const path = (rings: { x: number; y: number }[][]) =>
  rings.map((r) => `M ${r.map((p) => `${p.x},${p.y}`).join(' L ')} Z`).join(' ');

/** A small plan in the corner while walking: rooms, walls and you, with the way you face. */
export function MiniMap({
  level,
  pose,
}: { level: Level; pose: MutableRefObject<WalkPose | null> }) {
  const marker = useRef<SVGGElement>(null);
  const drawing = useMemo(() => {
    const geom = planGeometry(level);
    const shapes = [...roomShapes(level).values()];
    return {
      rooms: shapes.map((s) => path([s.outer, ...s.holes])),
      walls: path([
        ...geom.pieces.map((p) => p.polygon),
        ...geom.footprints.hubs.map((h) => h.polygon),
      ]),
    };
  }, [level]);
  const b = levelBounds(level);
  const w = b ? b.max.x - b.min.x : 1;
  const h = b ? b.max.y - b.min.y : 1;
  const scale = (SIZE - 2 * PAD) / Math.max(w, h, 1);
  const width = Math.round(w * scale + 2 * PAD);
  const height = Math.round(h * scale + 2 * PAD);
  const tx = PAD - (b?.min.x ?? 0) * scale;
  const ty = PAD - (b?.min.y ?? 0) * scale;

  // Follows the walker without re-rendering React every frame.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const p = pose.current;
      if (p && marker.current) {
        const deg = (p.yaw * 180) / Math.PI;
        marker.current.setAttribute(
          'transform',
          `translate(${p.at.x * scale + tx} ${p.at.y * scale + ty}) rotate(${deg})`,
        );
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [pose, scale, tx, ty]);

  return (
    <svg className="minimap" width={width} height={height} aria-hidden="true">
      <g transform={`translate(${tx} ${ty}) scale(${scale})`}>
        {drawing.rooms.map((d) => (
          <path key={d} d={d} className="minimap-room" fillRule="evenodd" />
        ))}
        <path d={drawing.walls} className="minimap-wall" />
      </g>
      <g ref={marker}>
        <path d="M 0 0 L 22 -9 A 24 24 0 0 1 22 9 Z" className="minimap-view" />
        <circle r={4} className="minimap-you" />
      </g>
    </svg>
  );
}
