import { type Level, faceGeometry, faceMid, resolveFace, roomFaces } from '@dhd/core';
import { useEditor } from '../editor';
import { roomLabelBoxes } from '../plan/layers';
import { type Size, type View, worldToScreen } from '../plan/view';
import { openFace } from './open';

/**
 * While a wall is seen straight on, the plan marks its room's walls: each with its letter in
 * a marker pointing at it (faint), the open one filled in the accent colour. Clicking a letter
 * opens that wall. Drawn in screen space; never in a saved picture of the plan.
 */
export function WallViewMarkers({ level, view, size }: { level: Level; view: View; size: Size }) {
  const ref = useEditor((s) => s.elevation?.ref);
  // The selected wall's length tag sits at its middle: a marker on that wall moves along it.
  const selected = useEditor((s) => (s.selection?.kind === 'wall' ? s.selection.id : null));
  const face = ref ? resolveFace(level, ref) : null;
  if (!face) return null;
  const faces = roomFaces(level, face.roomId).filter((f) => f.steppable || f.index === face.index);
  const R = 12;
  const labels = roomLabelBoxes(level, faceGeometry(level), view.zoom).map((l) => {
    const c = worldToScreen(view, size, l.at);
    const hx = l.half.x * view.zoom;
    const hy = l.half.y * view.zoom;
    return { x0: c.x - hx, x1: c.x + hx, y0: c.y - hy, y1: c.y + hy };
  });
  return (
    <g className="wall-markers" data-export="skip">
      {faces.map((f) => {
        // Where along the wall: its middle, or clear of the length tag and room labels.
        const onSelected = f.stretches.some((s) => s.wallId === selected);
        const spots = (onSelected ? [0.22, 0.78, 0.5] : [0.5, 0.3, 0.7, 0.15, 0.85]).map((k) => {
          const p = { x: f.left.x + f.dir.x * f.length * k, y: f.left.y + f.dir.y * f.length * k };
          const at = worldToScreen(view, size, p);
          return { at, c: { x: at.x + f.normal.x * (R + 10), y: at.y + f.normal.y * (R + 10) } };
        });
        const clear = (c: { x: number; y: number }) =>
          !labels.some((b) => c.x + R > b.x0 && c.x - R < b.x1 && c.y + R > b.y0 && c.y - R < b.y1);
        const spot = spots.find((s) => clear(s.c)) ?? (spots[0] as (typeof spots)[number]);
        const at = spot.at;
        const c = spot.c;
        const tip = { x: at.x + f.normal.x * 3, y: at.y + f.normal.y * 3 };
        const side = { x: -f.normal.y, y: f.normal.x };
        const base = (k: number) => ({
          x: c.x - f.normal.x * 4 + side.x * k * 7,
          y: c.y - f.normal.y * 4 + side.y * k * 7,
        });
        const b0 = base(1);
        const b1 = base(-1);
        const open = f.index === face.index;
        const name = f.label ? `${f.letter}, ${f.label}` : `Wall ${f.letter}`;
        return (
          <g
            key={f.index}
            className={open ? 'wall-marker wall-marker-open' : 'wall-marker'}
            // biome-ignore lint/a11y/useSemanticElements: an SVG marker on the plan has no button element
            role="button"
            tabIndex={0}
            aria-label={open ? `${name}, open` : `See ${name}`}
            aria-pressed={open}
            data-letter={f.letter}
            onPointerDown={(e) => e.stopPropagation()}
            onPointerUp={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              if (!open) openFace(level, f);
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return;
              e.preventDefault();
              e.stopPropagation();
              if (!open) openFace(level, f);
            }}
          >
            <polygon
              className="wall-marker-tip"
              points={`${tip.x},${tip.y} ${b0.x},${b0.y} ${b1.x},${b1.y}`}
            />
            <circle className="wall-marker-disc" cx={c.x} cy={c.y} r={R} />
            <text className="wall-marker-letter" x={c.x} y={c.y + 4} textAnchor="middle">
              {f.letter}
            </text>
          </g>
        );
      })}
    </g>
  );
}
