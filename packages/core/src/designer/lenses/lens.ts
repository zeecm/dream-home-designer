import type { Level } from '../../schema';
import type { Role } from '../principles';
import type { DesignOptions, DesignResult } from '../result';
import type { DesignBrief } from '../schema';
import type { Space } from '../spaces';

/**
 * Lenses: one way of looking at a result (tech 3b §1). A lens reads a version as placed and
 * the household, and says how the version does by its own measure: lines for the card, a
 * score, what the version adds against the plan, and facts for the designer. It may also
 * steer the solver with weights. A lens never gates: hard checks and house rules decide
 * whether a version passes, and a lens line is advice. The storage meter is the first; feng
 * shui and the Older person check plug into the same interface.
 */

export type LensId = 'storage' | 'fengshui' | 'older';

/** The lenses on when the options don't say. */
export const DEFAULT_LENSES: readonly LensId[] = ['storage'];

export interface LensInput {
  result: DesignResult;
  /** The plan the version was placed on (its "before", for the delta). */
  start: Level;
  brief: DesignBrief;
  opts: DesignOptions;
}

export interface LensLine {
  text: string;
  roomId?: string;
  itemId?: string;
  /** `short`: under what is usual (advice, never a failure). */
  tone: 'ok' | 'short' | 'note';
}

export interface LensReport {
  id: LensId;
  /** The card's label for it ("Storage"). */
  title: string;
  /** The card's one line, after the title; null when there is nothing to say. */
  line: string | null;
  tone: 'ok' | 'short' | 'note';
  /** Its details, room by room. */
  lines: LensLine[];
  /** 0–1 overall and per room, for folded cards and the second look's facts. */
  score: { overall: number; rooms: Record<string, number> };
  /** Against the plan the version was made on ("+1.20 m hanging"). */
  delta: string | null;
  /** What the designer is told about it (data). */
  facts: unknown;
}

/**
 * What a lens asks of the solver for one space: weights only, never a constraint.
 * `protect`: roles left out last when room runs out. `prefer`: roles (0–1) the solver keeps at
 * full size and stands against a wall where it can.
 */
export interface Steer {
  protect: Role[];
  prefer: { role: Role; weight: number }[];
}

export interface SteerInput {
  /** The level as the space is about to be furnished (its own pieces taken out). */
  level: Level;
  space: Space;
  brief: DesignBrief;
  opts: DesignOptions;
}

export interface Lens {
  id: LensId;
  report(i: LensInput): LensReport;
  steer?(i: SteerInput): Steer | null;
}

/** Whether a lens is on. */
export const lensOn = (opts: Pick<DesignOptions, 'lenses'>, id: LensId) =>
  (opts.lenses ?? DEFAULT_LENSES).includes(id);

/** Several lenses' steers as one: a role protected by any, preferred at the largest weight. */
export function mergeSteers(steers: (Steer | null | undefined)[]): Steer | null {
  const protect = new Set<Role>();
  const prefer = new Map<Role, number>();
  for (const s of steers) {
    if (!s) continue;
    for (const r of s.protect) protect.add(r);
    for (const p of s.prefer) prefer.set(p.role, Math.max(prefer.get(p.role) ?? 0, p.weight));
  }
  if (!protect.size && ![...prefer.values()].some((w) => w > 0)) return null;
  return {
    protect: [...protect].sort(),
    prefer: [...prefer]
      .filter(([, w]) => w > 0)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([role, weight]) => ({ role, weight })),
  };
}

/** A steer cut to the roles a space's answer has (null: none of them is steered). */
export function steerOnly(steer: Steer | null, roles: ReadonlySet<Role>): Steer | null {
  if (!steer) return null;
  const protect = steer.protect.filter((r) => roles.has(r));
  const prefer = steer.prefer.filter((p) => roles.has(p.role));
  return protect.length || prefer.length ? { protect, prefer } : null;
}
