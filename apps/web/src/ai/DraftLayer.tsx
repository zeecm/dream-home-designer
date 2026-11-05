import { planGeometry } from '@dhd/core';
import { useMemo } from 'react';
import { useTrace } from './draft';

const pts = (ps: { x: number; y: number }[]) => ps.map((p) => `${p.x},${p.y}`).join(' ');

/** A traced plan waiting to be accepted: its walls and openings over the plan image. */
export function TraceDraftLayer() {
  const draft = useTrace((s) => s.draft);
  const geom = useMemo(() => (draft ? planGeometry(draft.level) : null), [draft]);
  if (!geom) return null;
  return (
    <g className="ai-draft" pointerEvents="none">
      {geom.pieces.map((p, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: pieces of a fixed draft
        <polygon key={i} className="ai-draft-wall" points={pts(p.polygon)} />
      ))}
      {geom.openings.map((o) => (
        <polygon key={o.opening.id} className="ai-draft-opening" points={pts(o.polygon)} />
      ))}
    </g>
  );
}
