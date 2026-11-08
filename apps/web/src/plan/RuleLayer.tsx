import {
  type Level,
  type Vec2,
  furnitureKind,
  itemFootprint,
  measureRoute,
  planGeometry,
  roomShapes,
  ruleChecks,
  ruleNumber,
} from '@dhd/core';
import { memo, useEffect, useMemo } from 'react';
import { showRule, useRuleShown } from '../ai/designer/talk/rules';

/**
 * A house rule on the plan (slice 3a UX §3.6), while Show on plan holds it (8 s, or until Esc):
 * its target (a route as a band the rule's width, a room, a wall, a door, a spot) and the pieces
 * that break it in the clearance red. Never exported.
 */

const pts = (f: Vec2[]) => f.map((p) => `${p.x},${p.y}`).join(' ');

export const RuleLayer = memo(function RuleLayer({ level, zoom }: { level: Level; zoom: number }) {
  const rule = useRuleShown((s) => s.rule);
  const shape = useMemo(() => {
    if (!rule) return null;
    const t = rule.target;
    const n = ruleNumber(rule);
    const out: {
      bands: { path: Vec2[]; width: number }[];
      polys: Vec2[][];
      lines: [Vec2, Vec2][];
      circles: { at: Vec2; r: number }[];
      fail: Vec2[][];
      label: { at: Vec2; text: string } | null;
    } = { bands: [], polys: [], lines: [], circles: [], fail: [], label: null };
    if (t.kind === 'route') {
      const r = measureRoute(level, t.to, n ?? 0.9);
      for (const p of r.perRoom) out.bands.push({ path: p.path, width: p.need });
      const first = r.perRoom[0];
      const mid = first?.path[Math.floor(first.path.length / 2)];
      if (mid && first) out.label = { at: mid, text: `${first.need.toFixed(2)} m` };
    } else if (t.kind === 'room') {
      const s = roomShapes(level).get(t.roomId);
      if (s) out.polys.push(s.outer);
    } else if (t.kind === 'spot') {
      out.circles.push({ at: t.at, r: t.r });
    } else if (t.kind === 'wall') {
      const w = level.walls[t.wallId];
      const a = w && level.vertices[w.a];
      const b = w && level.vertices[w.b];
      if (a && b) out.lines.push([a, b]);
    } else if (t.kind === 'opening') {
      const o = planGeometry(level).openings.find((x) => x.opening.id === t.openingId);
      if (o) out.polys.push(o.polygon);
    }
    const failing = new Set(
      ruleChecks([rule], { level, usesOf: () => [] }).flatMap((c) => (c.itemId ? [c.itemId] : [])),
    );
    for (const id of failing) {
      const it = level.items[id];
      if (it && furnitureKind(it.assetId)) out.fail.push(itemFootprint(it));
    }
    return out;
  }, [rule, level]);
  if (!rule || !shape) return null;
  const px = 1 / zoom;
  return (
    <g className="rule-layer" data-export="skip" data-testid="rule-layer" pointerEvents="none">
      {/* One band per room, drawn as one: overlaps don't darken. */}
      <g className="rl-bands">
        {shape.bands.map((b) => (
          <polyline
            key={pts(b.path)}
            className="rl-band"
            points={pts(b.path)}
            style={{ strokeWidth: b.width }}
          />
        ))}
      </g>
      {shape.polys.map((p) => (
        <polygon key={pts(p)} className="rl-target" points={pts(p)} />
      ))}
      {shape.lines.map(([a, b]) => (
        <line key={`${a.x},${a.y}`} className="rl-wall" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
      ))}
      {shape.circles.map((c) => (
        <circle key={`${c.at.x},${c.at.y}`} className="rl-target" cx={c.at.x} cy={c.at.y} r={c.r} />
      ))}
      {shape.fail.map((f) => (
        <polygon key={pts(f)} className="rl-fail" points={pts(f)} />
      ))}
      {shape.label && (
        <text
          className="rl-label num"
          x={shape.label.at.x}
          y={shape.label.at.y}
          textAnchor="middle"
          fontSize={11 * px}
        >
          {shape.label.text}
        </text>
      )}
    </g>
  );
});

/** The stage's caption while a rule is shown: "Your rule: …" (Esc hides it). */
export function RuleCaption() {
  const rule = useRuleShown((s) => s.rule);
  useEffect(() => {
    if (!rule) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') showRule(null);
    };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [rule]);
  if (!rule) return null;
  return (
    <p className="rule-caption" data-testid="rule-caption">
      Your rule: {rule.name}
    </p>
  );
}
