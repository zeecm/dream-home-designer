import {
  addItem,
  deleteItem,
  furnitureKind,
  itemFootprint,
  newId,
  newItem,
  placeFurniture,
} from '@dhd/core';
import { useEffect, useState } from 'react';
import { useEditor } from '../editor';
import { formatLength } from '../units';
import { type PlanPointer, type ToolContext, type ToolController, gridSnap } from './tools';
import { worldToScreen } from './view';

/**
 * Places furniture from the catalogue: a preview follows the pointer (backing onto a wall
 * near it, for pieces that stand against one), a click or tap puts the piece down, and R
 * turns it a quarter. The tool stays on, for the next piece.
 */
export function useFurnitureTool(ctx: ToolContext): ToolController {
  const kindId = useEditor((s) => s.furnitureKind);
  const kind = furnitureKind(kindId);
  const [turn, setTurn] = useState(0);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  // Each piece picked starts unturned (a turn chosen for the chairs isn't the sofa's).
  // biome-ignore lint/correctness/useExhaustiveDependencies: on a new pick only
  useEffect(() => setTurn(0), [kindId]);

  const place = (p: PlanPointer) =>
    kind ? placeFurniture(ctx.geom, kind, gridSnap(p.world, 0.05, p.alt), turn) : null;
  const ghost = at && kind ? placeFurniture(ctx.geom, kind, at, turn) : null;

  return {
    cursor: 'copy',
    down: (p) => {
      const spot = place(p);
      if (!kind || !spot) return true;
      const id = newId('it');
      ctx.dispatch(addItem(ctx.level.id, newItem(id, kind, spot.at, spot.rotation)));
      useEditor.getState().select({ kind: 'item', id });
      // No preview over the piece just placed; the next pointer move brings it back.
      setAt(null);
      return true;
    },
    move: (p) => setAt(gridSnap(p.world, 0.05, p.alt)),
    up: () => {},
    key: (e) => {
      if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey) {
        setTurn((t) => t + (e.shiftKey ? -1 : 1) * (Math.PI / 2));
        return true;
      }
      const sel = useEditor.getState().selection;
      // The piece just placed (still selected) can go again straight away.
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel?.kind === 'item') {
        const gone = ctx.level.items[sel.id];
        const name = gone && furnitureKind(gone.assetId)?.name.toLowerCase();
        ctx.dispatch(deleteItem(ctx.level.id, sel.id, name));
        useEditor.getState().select(null);
        return true;
      }
      if (e.key === 'Escape') {
        useEditor.getState().select(null);
        useEditor.getState().setTool('select');
        return true;
      }
      return false;
    },
    overlay: ({ view, size }) => {
      if (!kind || !ghost) return null;
      const poly = itemFootprint(newItem('ghost', kind, ghost.at, ghost.rotation)).map((q) =>
        worldToScreen(view, size, q),
      );
      const [, , fr, fl] = poly;
      const c = worldToScreen(view, size, ghost.at);
      return (
        <g className="draw-overlay" pointerEvents="none">
          <polygon className="ghost-item" points={poly.map((q) => `${q.x},${q.y}`).join(' ')} />
          {fr && fl && (
            <line className="ghost-item-front" x1={fl.x} y1={fl.y} x2={fr.x} y2={fr.y} />
          )}
          <g transform={`translate(${c.x} ${c.y})`}>
            <text textAnchor="middle" y={4} className="ghost-item-label">
              {kind.name}
            </text>
          </g>
        </g>
      );
    },
  };
}
