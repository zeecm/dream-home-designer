import { type FurnitureKind, furnitureKind, newItem, placeFurniture } from '../../furniture';
import { polygonCentroid } from '../../geometry';
import { planGeometry } from '../../plan';
import { roomShapes } from '../../rooms';
import type { Level, Project, Vec2 } from '../../schema';
import { aliasOf, aliasesFor } from '../aliases';
import { designChecks } from '../checks';
import { designLocks } from '../locks';
import { type DesignResult, designResult } from '../result';
import type { DesignBrief } from '../schema';
import { roomIdAt, spaceOfRoom, spacesOf } from '../spaces';
import type { ProbeAsk } from './reply';
import { cut } from './schema';

/**
 * A pushback's numbers, in the app's words (tech §2.7): the person's ask placed as one piece on
 * the plan as it is, checked, and the hard checks it causes said as lines ("Corridor: 0.90 m
 * needed to walk through, 0.60 m left."); a wall the household or HDB can't change, said as the
 * rule. Free: no request. The designer's sentence stands above; the measure is the app's.
 */

export interface ProbeInput {
  /** The level as it is now (After, or the flat) and the flat as it is. */
  level: Level;
  before: Level;
  brief: DesignBrief;
  models?: Project['models'];
}

export interface ProbeLines {
  lines: string[];
  /** An HDB rule (or a wall that never changes): no way to accept it. */
  hdb: boolean;
}

const WALL_LINES: Record<string, { text: string; hdb: boolean }> = {
  shelter: { text: 'HDB doesn’t allow this: household shelter walls can’t be changed.', hdb: true },
  outside: { text: 'Outside walls and walls with a window can’t be changed.', hdb: true },
  wet: { text: 'Bathroom walls stay where they are: they are wet-area walls.', hdb: true },
};

/** The lines for a concern: its wall's rule, and what its one piece would break. */
export function probeLines(
  concern: { wallId: string | null; probe: ProbeAsk | null },
  i: ProbeInput,
): ProbeLines {
  const lines: string[] = [];
  let hdb = false;
  if (concern.wallId && i.level.walls[concern.wallId]) {
    const lock = designLocks(i.before, i.level).get(concern.wallId);
    const rule = lock ? WALL_LINES[lock] : undefined;
    if (rule) {
      lines.push(rule.text);
      hdb ||= rule.hdb;
    } else if ((lock === 'structural' || lock === 'likely') && i.brief.walls !== 'structural') {
      lines.push(
        `This wall is ${lock === 'likely' ? 'probably ' : ''}structural: changing it needs HDB approval and an engineer, and you chose to keep structural walls.`,
      );
    } else if (i.brief.walls === 'keep') {
      lines.push('You chose to keep every wall as it is.');
    }
  }
  if (concern.probe) lines.push(...pieceLines(concern.probe, i));
  return { lines: lines.slice(0, 4).map((l) => cut(l, 300)), hdb };
}

const lowerFirst = (t: string) => (t ? `${t[0]?.toLowerCase()}${t.slice(1)}` : t);

/**
 * Where the person asked for it (a point, or a wall and how far along it): the piece put
 * exactly there, and what that breaks, measured. Null when the ask gave no place.
 */
function exactLines(p: ProbeAsk, i: ProbeInput, kind: FurnitureKind): string[] | null {
  const room = i.level.rooms[p.roomId];
  let at: Vec2 | null = p.at;
  if (!at && p.wallId && p.along !== null) {
    const w = i.level.walls[p.wallId];
    const a = w && i.level.vertices[w.a];
    const b = w && i.level.vertices[w.b];
    const shape = roomShapes(i.level).get(p.roomId);
    if (a && b && shape) {
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const t = Math.min(1, Math.max(0, p.along / len));
      const on = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      const c = polygonCentroid(shape.outer);
      const d = Math.hypot(c.x - on.x, c.y - on.y) || 1;
      // A step into the room, then onto the wall's face as a piece dropped there would go.
      at = { x: on.x + ((c.x - on.x) / d) * 0.3, y: on.y + ((c.y - on.y) / d) * 0.3 };
    }
  }
  if (!at || !room) return null;
  const placed = placeFurniture(planGeometry(i.level), kind, at, 0);
  const trial = structuredClone(i.level) as Level;
  const id = 'it_probe';
  trial.items[id] = newItem(id, kind, placed.at, placed.rotation, i.level.ceilingHeight);
  const before = new Set(designChecks(i.level, { brief: i.brief }).map((c) => c.key));
  const caused = designChecks(trial, { brief: i.brief }).filter(
    (c) => c.hard && !before.has(c.key) && (c.itemId === id || !!c.issue),
  );
  if (!caused.length) {
    return [`Where you asked, the ${lowerFirst(kind.name)} passes the app’s checks.`];
  }
  return caused
    .map((c) => c.text)
    .filter((t, k, all) => all.indexOf(t) === k)
    .slice(0, 3);
}

/**
 * The one piece asked about: where the person asked for it if they said (measured there), else
 * placed by the app in its room's space, the rest kept where it is, and said either way.
 */
function pieceLines(p: ProbeAsk, i: ProbeInput): string[] {
  const kind = furnitureKind(p.assetId) ?? null;
  if (!kind) return [`I couldn’t find “${cut(p.assetId, 40)}” in the catalogue.`];
  const exact = exactLines(p, i, kind);
  if (exact) return exact;
  const spaces = spacesOf(i.level);
  const space = spaceOfRoom(spaces, p.roomId);
  if (!space) return [];
  const aliases = aliasesFor(i.level);
  const of = aliasOf(aliases);
  // Everything in the space stays where it is: only the piece asked about is placed.
  const kept: DesignBrief['keep']['items'] = { ...i.brief.keep.items };
  for (const it of Object.values(i.level.items)) {
    const r = roomIdAt(i.level, { x: it.position.x, y: it.position.z });
    if (r && space.rooms.includes(r)) kept[it.id] = 'in-place';
  }
  const brief: DesignBrief = { ...i.brief, keep: { ...i.brief.keep, items: kept } };
  let r: DesignResult;
  try {
    r = designResult(
      i.level,
      i.before,
      {
        id: 'dsn_probe',
        brief,
        aliases,
        concept: null,
        spaces: {
          [space.key]: {
            name: space.name,
            status: 'done',
            design: {
              v: 2,
              items: [
                {
                  ref: 'probe',
                  assetId: kind.id,
                  keep: null,
                  wall: p.wallId ? (of.get(p.wallId) ?? null) : null,
                  along: p.along,
                  at: p.at,
                  rotation: null,
                  width: null,
                  depth: null,
                  height: null,
                  why: '',
                  against: p.against,
                  faces: null,
                  near: null,
                  zone: null,
                },
              ],
              faces: [],
              notes: [],
              summary: '',
            },
          },
        },
      },
      i.models ? { models: i.models } : {},
    );
  } catch {
    return [];
  }
  const probeId = Object.entries(r.refs).find(([, ref]) => ref === 'probe')?.[0] ?? null;
  const name = lowerFirst(kind.name);
  if (!probeId) {
    const why = r.dropped.find((n) => n.ref === 'probe')?.text;
    return [cut(`The ${name} doesn’t fit in ${space.name}${why ? `: ${why}` : '.'}`, 300)];
  }
  // Placed as something else (a smaller size): said of the piece asked about, never the other.
  const got = r.level.items[probeId]?.assetId;
  if (got && got !== kind.id) {
    return [cut(`The app would use a smaller piece than the ${name} in ${space.name}.`, 300)];
  }
  // What the piece causes: its own checks, and the walkways and clearances it narrows (a
  // room's own needs, as "no dining table", are about the rest of the room, not the ask).
  const lines = r.checks
    .filter((c) => c.hard && !c.already && (c.itemId === probeId || !!c.issue))
    .map((c) => c.text)
    .filter((t, k, all) => all.indexOf(t) === k)
    .slice(0, 3);
  // Nothing fails where the app put it: said, so the designer's own number isn't the only one.
  return lines.length
    ? lines
    : [`The app found room for the ${name} in ${space.name}, placed where it fits.`];
}
