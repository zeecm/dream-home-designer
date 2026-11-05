import {
  type ClearanceIssue,
  type Level,
  clearanceIssues,
  clearanceZones,
  furnitureKind,
  itemFootprint,
  pointInPolygon,
  roomShapes,
} from '@dhd/core';
import { memo, useMemo } from 'react';
import { create } from 'zustand';
import { useEditor } from '../editor';
import { useLevel } from '../store';
import { formatLength } from '../units';

const KEY = 'dhd-clearance';

/** Whether clearance checks show (on unless switched off; remembered in this browser). */
export const useClearanceOn = create<{ on: boolean; set: (on: boolean) => void }>((set) => {
  let on = true;
  try {
    on = window.localStorage.getItem(KEY) !== 'off';
  } catch {
    // Storage blocked: on, for this visit.
  }
  return {
    on,
    set: (v) => {
      try {
        window.localStorage.setItem(KEY, v ? 'on' : 'off');
      } catch {
        // Not remembered; still switched for this visit.
      }
      set({ on: v });
    },
  };
});

// Kept per level object: the plan, the Inspector and the count share one run.
const cache = new WeakMap<Level, ClearanceIssue[]>();
export function issuesOf(level: Level): ClearanceIssue[] {
  let out = cache.get(level);
  if (!out) {
    out = clearanceIssues(level);
    cache.set(level, out);
  }
  return out;
}

/** The clearance problems on the level shown (none while switched off). */
export function useClearanceIssues(): ClearanceIssue[] {
  const on = useClearanceOn((s) => s.on);
  const level = useLevel();
  return useMemo(() => (on && level ? issuesOf(level) : []), [on, level]);
}

const name = (level: Level, itemId: string) =>
  furnitureKind(level.items[itemId]?.assetId ?? '')?.name ?? 'piece';

/** Problems with one piece, in words. */
export function issueText(level: Level, issue: ClearanceIssue, all: ClearanceIssue[]): string {
  switch (issue.kind) {
    case 'zone': {
      if (issue.side === 'front') {
        return `${issue.what} need ${formatLength(issue.need)} in front; ${formatLength(issue.have)} here.`;
      }
      // A bed: both sides in one line.
      const sides = all.filter(
        (i): i is Extract<ClearanceIssue, { kind: 'zone' }> =>
          i.kind === 'zone' && i.itemId === issue.itemId && i.side !== 'front',
      );
      const part = (s: 'left' | 'right') => {
        const z = sides.find((x) => x.side === s);
        return z ? `${formatLength(z.have)} ${s}` : null;
      };
      return `Needs ${formatLength(issue.need)} beside the bed; ${[part('left'), part('right')]
        .filter(Boolean)
        .join(', ')}.`;
    }
    case 'door': {
      // Named by the room it opens into (where its leaves sweep).
      const pts = issue.sweep.flat();
      const c = {
        x: pts.reduce((t, p) => t + p.x, 0) / (pts.length || 1),
        y: pts.reduce((t, p) => t + p.y, 0) / (pts.length || 1),
      };
      const shapes = roomShapes(level);
      const room = Object.values(level.rooms).find((r) => {
        const s = shapes.get(r.id);
        return !!s && pointInPolygon(c, s.outer);
      });
      return room ? `Blocks the ${room.name} door.` : 'Blocks a door’s swing.';
    }
    case 'overlap':
      return `Overlaps the ${name(level, issue.otherId).toLowerCase()}.`;
    case 'wall':
      return `Goes ${formatLength(issue.depth)} into a wall.`;
  }
}

/** One line per problem with a piece (a bed's two sides in one). */
export function itemIssueLines(level: Level, itemId: string, all: ClearanceIssue[]): string[] {
  const mine = all.filter((i) => i.itemId === itemId);
  const lines: string[] = [];
  let bed = false;
  for (const i of mine) {
    if (i.kind === 'zone' && i.side !== 'front') {
      if (bed) continue;
      bed = true;
    }
    const t = issueText(level, i, all);
    if (!lines.includes(t)) lines.push(t);
  }
  return lines;
}

/** The pieces with a problem, in a steady order (for Show next). */
export function itemsWithIssues(all: ClearanceIssue[]): string[] {
  return [...new Set(all.map((i) => i.itemId))].sort();
}

const pts = (ps: { x: number; y: number }[]) => ps.map((p) => `${p.x},${p.y}`).join(' ');

/**
 * Over the plan (world units): problems tinted red (room short in front of a piece, a door's
 * swing with a piece in it, pieces overlapping or in a wall); the selected piece's own room
 * shown faintly when there's enough. Left out of pictures.
 */
export const ClearanceLayer = memo(function ClearanceLayer({ level }: { level: Level }) {
  const issues = useClearanceIssues();
  const selection = useEditor((s) => s.selection);
  const selected = selection?.kind === 'item' ? level.items[selection.id] : undefined;
  const fine = useMemo(() => {
    if (!selected) return [];
    const short = new Set(
      issues
        .filter((i) => i.kind === 'zone' && i.itemId === selected.id)
        .map((i) => (i.kind === 'zone' ? i.side : '')),
    );
    return clearanceZones(selected).filter((z) => !short.has(z.side));
  }, [selected, issues]);
  if (!issues.length && !fine.length) return null;
  return (
    <g className="clearance" pointerEvents="none" data-export="skip">
      {fine.map((z) => (
        <polygon key={`fine-${z.side}`} className="clearance-fine" points={pts(z.zone)} />
      ))}
      {issues.map((i, k) => {
        const key = `${i.kind}-${i.itemId}-${k}`;
        // A door's sweep once, however many pieces are in it.
        if (
          i.kind === 'door' &&
          issues.findIndex((j) => j.kind === 'door' && j.openingId === i.openingId) !== k
        ) {
          return null;
        }
        if (i.kind === 'zone') {
          return <polygon key={key} className="clearance-short" points={pts(i.zone)} />;
        }
        if (i.kind === 'door') {
          return (
            <g key={key}>
              {i.sweep.map((s, j) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a door's leaves, in order
                <polygon key={j} className="clearance-short" points={pts(s)} />
              ))}
            </g>
          );
        }
        const it = level.items[i.itemId];
        return it ? (
          <polygon key={key} className="clearance-clash" points={pts(itemFootprint(it))} />
        ) : null;
      })}
    </g>
  );
});
