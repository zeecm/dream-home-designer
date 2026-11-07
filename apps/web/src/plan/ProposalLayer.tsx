import { type Item, type Vec2, furnitureKind, itemFootprint } from '@dhd/core';
import { memo, useMemo, useState } from 'react';
import { useTalk } from '../ai/designer/talk/useTalk';
import { useProposalView } from '../ai/designer/talk/view';
import { useEditor } from '../editor';

/**
 * A designer's proposal on the plan (UX §7): while it is placed, its pieces as dashed ghosts
 * room by room; once checked, the diff against the plan as it is: new pieces outlined, moved
 * ones with a dashed ghost where they were and an arrow, removed ones dashed, failing ones in
 * the clearance red, and unticked changes drawn as left out. All in `--proposed` (the accent
 * means selected). The row hovered in the card lights its pieces. Never exported.
 */

const pts = (f: Vec2[]) => f.map((p) => `${p.x},${p.y}`).join(' ');
const centre = (it: Item): Vec2 => ({ x: it.position.x, y: it.position.z });

interface Mark {
  key: string;
  points: string;
  cls: string;
  change: string;
}

export const ProposalLayer = memo(function ProposalLayer() {
  const v = useProposalView();
  const side = useEditor((s) => s.preview?.side);
  const hover = useTalk((s) => (s.hover?.card === v.card ? s.hover.change : null));
  const open = useTalk((s) => (s.open?.card === v.card ? s.open.change : null));
  const marks = useMemo(() => {
    const out: { marks: Mark[]; arrows: { key: string; a: Vec2; b: Vec2; change: string }[] } = {
      marks: [],
      arrows: [],
    };
    const { now, target } = v;
    if (!now || !target) return out;
    const fp = (it: Item | undefined) =>
      it && furnitureKind(it.assetId) ? pts(itemFootprint(it)) : null;
    const failing = new Set(v.failing);
    if (v.ghost) {
      // Pieces placed so far that the plan doesn't have yet.
      for (const it of Object.values(target.items)) {
        const was = now.items[it.id];
        if (was && centre(was).x === centre(it).x && centre(was).y === centre(it).y) continue;
        const p = fp(it);
        if (p) out.marks.push({ key: `g${it.id}`, points: p, cls: 'pv-ghost', change: '' });
      }
      return out;
    }
    const ticked = new Set(v.ticked);
    for (const c of v.changes) {
      if (c.verb === 'walls' || c.verb === 'finish' || c.verb === 'electrical') continue;
      const on = ticked.has(c.id);
      const fail = c.items.target.some((id) => failing.has(id));
      for (const id of c.items.target) {
        const p = fp(target.items[id]);
        if (!p) continue;
        const cls = on ? 'pv-new' : 'pv-left-out';
        out.marks.push({
          key: `t${c.id}${id}`,
          points: p,
          cls: `${cls}${fail ? ' pv-fail' : ''}`,
          change: c.id,
        });
      }
      for (const id of c.items.now) {
        const p = fp(now.items[id]);
        if (!p) continue;
        if (c.verb === 'remove') {
          out.marks.push({
            key: `r${c.id}${id}`,
            points: p,
            cls: on ? 'pv-removed' : 'pv-kept',
            change: c.id,
          });
        } else if (on) {
          // Moved, turned or swapped: where it was.
          out.marks.push({ key: `w${c.id}${id}`, points: p, cls: 'pv-was', change: c.id });
        }
      }
      if ((c.verb === 'move' || c.verb === 'swap') && on) {
        const a = now.items[c.items.now[0] ?? ''];
        const b = target.items[c.items.target[0] ?? ''];
        if (a && b) out.arrows.push({ key: `a${c.id}`, a: centre(a), b: centre(b), change: c.id });
      }
    }
    return out;
  }, [v]);
  if (!v.card || side !== 'version' || (!marks.marks.length && !marks.arrows.length)) return null;
  const lit = hover ?? open;
  return (
    <g
      className="proposal-layer"
      data-export="skip"
      data-testid="proposal-layer"
      pointerEvents="none"
    >
      {marks.marks.map((m) => (
        <polygon
          key={m.key}
          points={m.points}
          className={`${m.cls}${lit && m.change === lit ? ' pv-lit' : ''}`}
          data-change-id={m.change || undefined}
        />
      ))}
      {marks.arrows.map((a) => (
        <line
          key={a.key}
          x1={a.a.x}
          y1={a.a.y}
          x2={a.b.x}
          y2={a.b.y}
          className={`pv-arrow${lit && a.change === lit ? ' pv-lit' : ''}`}
          markerEnd="url(#pv-head)"
        />
      ))}
      <defs>
        <marker
          id="pv-head"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="6"
          markerHeight="6"
          orient="auto"
        >
          <path d="M0,0 L8,4 L0,8 z" className="pv-arrow-head" />
        </marker>
      </defs>
    </g>
  );
});

/** The legend in the stage's corner while a proposal is shown (UX §7.1). */
export function ProposalLegend() {
  const card = useProposalView((s) => s.card);
  const ghost = useProposalView((s) => s.ghost);
  const side = useEditor((s) => s.preview?.side);
  // On a touch screen or a short stage, a small Key in the corner, opened on a tap.
  const [compact] = useState(
    () => !!window.matchMedia?.('(pointer: coarse), (max-height: 600px)').matches,
  );
  const [open, setOpen] = useState(false);
  if (!card || side !== 'version') return null;
  if (compact && !open) {
    return (
      <button type="button" className="pv-key" aria-expanded={false} onClick={() => setOpen(true)}>
        Key
      </button>
    );
  }
  return (
    <div
      className={compact ? 'pv-legend pv-legend-open' : 'pv-legend'}
      aria-hidden={!compact}
      {...(compact ? { onClick: () => setOpen(false), role: 'button', tabIndex: 0 } : {})}
    >
      {ghost ? (
        <span>
          <i className="pv-sw pv-sw-ghost" /> Being placed
        </span>
      ) : (
        <>
          <span>
            <i className="pv-sw pv-sw-new" /> New
          </span>
          <span>
            <i className="pv-sw pv-sw-was" /> Moved from
          </span>
          <span>
            <i className="pv-sw pv-sw-left" /> Left out
          </span>
          <span>
            <i className="pv-sw pv-sw-fail" /> Doesn’t pass
          </span>
          <span>
            <i className="pv-sw pv-sw-note">!</i> Electrical note
          </span>
        </>
      )}
    </div>
  );
}
