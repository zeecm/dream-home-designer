import { type Level, faceMid, resolveFace, roomFaces } from '@dhd/core';
import { useEditor } from '../editor';
import { type Size, type View, worldToScreen } from '../plan/view';
import { openFace } from './open';

/**
 * While a wall is seen straight on, the plan marks its room's walls: each with its letter in
 * a marker pointing at it (faint), the open one filled in the accent colour. Clicking a letter
 * opens that wall. Drawn in screen space; never in a saved picture of the plan.
 */
export function WallViewMarkers({ level, view, size }: { level: Level; view: View; size: Size }) {
  const ref = useEditor((s) => s.elevation?.ref);
  const face = ref ? resolveFace(level, ref) : null;
  if (!face) return null;
  const faces = roomFaces(level, face.roomId).filter((f) => f.steppable || f.index === face.index);
  const R = 11;
  return (
    <g className="wall-markers" data-export="skip">
      {faces.map((f) => {
        const mid = faceMid(f);
        const at = worldToScreen(view, size, mid);
        // Out into the room, clear of the wall.
        const c = { x: at.x + f.normal.x * (R + 10), y: at.y + f.normal.y * (R + 10) };
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
