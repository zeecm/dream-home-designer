import { type Side, dot, overlapDepth, polygonGap } from '../../convex';
import { entranceDoor } from '../../delivery';
import { type FurnitureKind, furnitureKind, itemFootprint } from '../../furniture';
import { pointInPolygon } from '../../geometry';
import { planGeometry } from '../../plan';
import { roomShapes } from '../../rooms';
import type { Item, Level, Vec2 } from '../../schema';
import { measureRoute } from '../../walkway';
import { keepOutOf, nameOf } from '../place';
import type { ProgrammeUse } from '../principles';
import { roomsBeside } from '../spaces';
import { AGAINST_GAP, FACE_ANGLE, type Rule, type RuleTarget, ruleNumber } from './schema';
import { openingWords, subjectMatches, targetWords } from './words';

/**
 * A house rule as a check (slice 3a, tech §3): generic over the rule object, so a new wording
 * needs no code. Subjects resolve to pieces, targets to geometry, and each relation is one test
 * between them. A failure is a hard, waivable check (principle R), keyed by rule and piece, said
 * in the app's words with the person's name for the rule.
 */

export interface RuleCheck {
  key: string;
  principle: 'R';
  hard: true;
  waivable: true;
  text: string;
  itemId?: string;
  roomId?: string;
  openingId?: string;
  unfixable?: boolean;
  /** The rule it comes from. */
  ruleId: string;
}

export interface RuleCtx {
  level: Level;
  /** The uses a room is checked for (the design's, else its name's). */
  usesOf: (roomId: string) => ProgrammeUse[];
  /** The walkway check has just made its furnished pass on `level`: routes reuse it. */
  samePass?: boolean;
}

interface Piece {
  it: Item;
  kind: FurnitureKind;
  fp: Vec2[];
  room: string | null;
}

const centre = (it: Item): Vec2 => ({ x: it.position.x, y: it.position.z });
const fwd = (it: Item): Vec2 => ({ x: -Math.sin(it.rotationY), y: Math.cos(it.rotationY) });
const m = (v: number) => `${v.toFixed(2)} m`;
/** A point as a tiny polygon (for the polygon gap). */
const dotPoly = (p: Vec2): Vec2[] => [
  { x: p.x - 0.005, y: p.y - 0.005 },
  { x: p.x + 0.005, y: p.y - 0.005 },
  { x: p.x + 0.005, y: p.y + 0.005 },
  { x: p.x - 0.005, y: p.y + 0.005 },
];
const circlePoly = (c: Vec2, r: number): Vec2[] =>
  Array.from({ length: 16 }, (_, i) => {
    const a = (i / 16) * Math.PI * 2;
    return { x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r };
  });

/** The angle (degrees) between a piece's forward line and the way to a point. */
function offAngle(it: Item, to: Vec2): number {
  const f = fwd(it);
  const v = { x: to.x - it.position.x, y: to.y - it.position.z };
  const len = Math.hypot(v.x, v.y) || 1;
  return (Math.acos(Math.max(-1, Math.min(1, dot(f, v) / len))) * 180) / Math.PI;
}

/** A footprint's back side (from back-right to back-left). */
function backOf(fp: Vec2[]): Side {
  const [bl, br, , fl] = fp as [Vec2, Vec2, Vec2, Vec2];
  const width = Math.hypot(bl.x - br.x, bl.y - br.y) || 1;
  const depth = Math.hypot(fl.x - bl.x, fl.y - bl.y) || 1;
  return { a: br, b: bl, n: { x: (bl.x - fl.x) / depth, y: (bl.y - fl.y) / depth }, width };
}

/** The distance from a point to a segment. */
function segDist(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

/** Where a target is, for one subject piece: points, polygons and segments to measure to. */
interface Where {
  points: Vec2[];
  polys: Vec2[][];
  segs: [Vec2, Vec2, number][];
}

/** Every check the rules make on a level (deleted rules make none). */
export function ruleChecks(rules: readonly Rule[], ctx: RuleCtx): RuleCheck[] {
  return compile(rules, ctx).checks;
}

/** A failing piece the solver may move, and the region its rule keeps it out of. */
export interface RuleKeepOut {
  key: string;
  itemId: string;
  ruleName: string;
  /** Convex polygons (a route's band, a spot, a convex room, the floor in front of a door). */
  polys: Vec2[][];
}

/**
 * The negative rules' failures with a region to keep out of (slice 3a §3.4): what the walkway
 * re-solve keeps the failing pieces out of. Positive rules steer nothing yet (PR C).
 */
export function ruleKeepOuts(rules: readonly Rule[], ctx: RuleCtx): RuleKeepOut[] {
  const { checks, regions } = compile(rules, ctx);
  const names = new Map(rules.map((r) => [r.id, r.name]));
  return checks.flatMap((c) => {
    const polys = regions.get(c.key);
    return c.itemId && polys?.length
      ? [{ key: c.key, itemId: c.itemId, ruleName: names.get(c.ruleId) ?? '', polys }]
      : [];
  });
}

/** Whether a polygon is convex (a room is a keep-out only then). */
function convex(poly: readonly Vec2[]): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i] as Vec2;
    const b = poly[(i + 1) % poly.length] as Vec2;
    const c = poly[(i + 2) % poly.length] as Vec2;
    const z = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(z) < 1e-9) continue;
    if (sign && Math.sign(z) !== sign) return false;
    sign = Math.sign(z);
  }
  return true;
}

function compile(
  rules: readonly Rule[],
  ctx: RuleCtx,
): { checks: RuleCheck[]; regions: Map<string, Vec2[][]> } {
  const regions = new Map<string, Vec2[][]>();
  const live = rules.filter((r) => !r.deleted);
  if (!live.length) return { checks: [], regions };
  const { level } = ctx;
  const shapes = roomShapes(level);
  const roomAt = (p: Vec2): string | null => {
    for (const [id, s] of shapes) {
      if (pointInPolygon(p, s.outer) && !s.holes.some((h) => pointInPolygon(p, h))) return id;
    }
    return null;
  };
  const pieces: Piece[] = Object.values(level.items).flatMap((it) => {
    const kind = furnitureKind(it.assetId);
    return kind ? [{ it, kind, fp: itemFootprint(it, kind), room: roomAt(centre(it)) }] : [];
  });
  // Worked out only when a rule needs them (doors' and windows' outlines, the furnished pass).
  let geomMemo: ReturnType<typeof planGeometry> | null = null;
  const geomOf = () => {
    geomMemo ??= planGeometry(level);
    return geomMemo;
  };
  // Every route rule measured on one furnished pass: a frozen copy is the pass's key.
  // A frozen level is its own key (the walkway pass on it is kept for the next call); an
  // unfrozen one is copied once, frozen, so this call's route rules share one pass.
  let routeLevel: Level | null = ctx.samePass || Object.isFrozen(level) ? level : null;
  const routeOf = () => {
    routeLevel ??= Object.freeze({ ...level });
    return routeLevel;
  };
  const vertex = (id: string) => level.vertices[id] as Vec2;
  const wallSeg = (wallId: string): [Vec2, Vec2, number] | null => {
    const w = level.walls[wallId];
    const a = w && level.vertices[w.a];
    const b = w && level.vertices[w.b];
    return w && a && b ? [a, b, w.thickness / 2] : null;
  };
  const openingCentre = (id: string): Vec2 | null => {
    // On its wall, where it is along it (no outlines needed).
    const op = level.openings[id];
    const w = op && level.walls[op.wallId];
    const a = w && level.vertices[w.a];
    const b = w && level.vertices[w.b];
    if (op && a && b) return { x: a.x + (b.x - a.x) * op.t, y: a.y + (b.y - a.y) * op.t };
    const o = geomOf().openings.find((x) => x.opening.id === id);
    if (!o) return null;
    const n = o.polygon.length || 1;
    return {
      x: o.polygon.reduce((t, p) => t + p.x, 0) / n,
      y: o.polygon.reduce((t, p) => t + p.y, 0) / n,
    };
  };
  const beside = new Map<string, (string | null)[]>();
  const besideOf = (wallId: string) => {
    let b = beside.get(wallId);
    if (!b) {
      b = roomsBeside(level, wallId);
      beside.set(wallId, b);
    }
    return b;
  };
  const roomOpenings = (roomId: string | null, kind: 'door' | 'window') =>
    roomId
      ? Object.values(level.openings).filter(
          (o) =>
            (kind === 'door' ? o.kind !== 'window' : o.kind === 'window') &&
            besideOf(o.wallId).includes(roomId),
        )
      : [];
  const targetRooms = (t: RuleTarget): string[] =>
    t.kind === 'room'
      ? [t.roomId]
      : t.kind === 'roomUse'
        ? Object.keys(level.rooms).filter((id) =>
            (ctx.usesOf(id) as string[]).includes(t.use === 'master' ? 'master' : t.use),
          )
        : [];
  /** Where the target is, as seen from one piece of the subject. */
  const whereFor = (t: RuleTarget, p: Piece): Where => {
    const out: Where = { points: [], polys: [], segs: [] };
    switch (t.kind) {
      case 'wall': {
        const s = wallSeg(t.wallId);
        if (s) out.segs.push(s);
        break;
      }
      case 'opening': {
        const c = openingCentre(t.openingId);
        if (c) out.points.push(c);
        break;
      }
      case 'ownDoor':
      case 'window':
        for (const o of roomOpenings(p.room, t.kind === 'ownDoor' ? 'door' : 'window')) {
          const c = openingCentre(o.id);
          if (c) out.points.push(c);
        }
        break;
      case 'kind':
        for (const q of pieces) {
          if (q.it.id === p.it.id) continue;
          if (
            q.it.assetId === t.kindId ||
            subjectMatches({ kind: 'kind', kindId: t.kindId }, q.it, q.kind)
          ) {
            out.points.push(centre(q.it));
            out.polys.push(q.fp);
          }
        }
        break;
      case 'spot':
        out.points.push(t.at);
        break;
      default:
        break;
    }
    return out;
  };
  const gapTo = (p: Piece, w: Where): number | null => {
    const ds = [
      ...w.points.map((q) => polygonGap(p.fp, dotPoly(q)).d),
      ...w.polys.map((q) => polygonGap(p.fp, q).d),
      ...w.segs.map(([a, b, half]) =>
        Math.max(0, Math.min(...p.fp.map((q) => segDist(q, a, b))) - half),
      ),
    ];
    return ds.length ? Math.min(...ds) : null;
  };
  const facePoint = (p: Piece, w: Where): Vec2 | null => {
    const all = [
      ...w.points,
      ...w.segs.map(([a, b]) => {
        const c = centre(p.it);
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const l2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((c.x - a.x) * dx + (c.y - a.y) * dy) / l2));
        return { x: a.x + dx * t, y: a.y + dy * t };
      }),
    ];
    const c = centre(p.it);
    return (
      all.sort((a, b) => Math.hypot(a.x - c.x, a.y - c.y) - Math.hypot(b.x - c.x, b.y - c.y))[0] ??
      null
    );
  };

  const out: RuleCheck[] = [];
  for (const rule of live) {
    const n = ruleNumber(rule);
    const said = `Your rule “${rule.name}”`;
    const tw = targetWords(rule.target, level);
    const subject = pieces.filter((p) => subjectMatches(rule.subject, p.it, p.kind));
    const fail = (
      p: Piece | null,
      what: string,
      extra: Partial<RuleCheck> = {},
      region?: Vec2[][],
    ) => {
      const key = `R|${rule.id}|${p ? p.it.id : (extra.roomId ?? extra.openingId ?? 'plan')}`;
      if (region?.length && !regions.has(key)) regions.set(key, region);
      out.push({
        key,
        principle: 'R',
        hard: true,
        waivable: true,
        text: `${said}: ${what}.`,
        ruleId: rule.id,
        ...(p ? { itemId: p.it.id } : {}),
        ...extra,
      });
    };
    const name = (p: Piece) => `the ${nameOf(p.kind)}`;
    const t = rule.target;

    // Routes: the walkway search at the rule's width.
    if (t.kind === 'route') {
      if (rule.relation !== 'notIn' && rule.relation !== 'keepClear') continue;
      const routes = measureRoute(routeOf(), t.to, n ?? 0.9, !!ctx.samePass);
      if (routes.status === 'no-main-door') continue;
      const ids = new Set(subject.map((p) => p.it.id));
      const byId = new Map(pieces.map((p) => [p.it.id, p]));
      const seen = new Set<string>();
      for (const r of routes.perRoom) {
        // Nothing in the way: any subject piece meeting the bare way's band (n wide), even where
        // the width left passes; keep clear: those that leave it under the width.
        // The band kept clear: the corridor stretches for nothing in the way (a piece in an open
        // room is walked round), the way round the pinch for a clear width.
        const band =
          rule.relation === 'notIn'
            ? r.narrow.flatMap((run) => keepOutOf(run, null, r.need).map((k) => k.poly))
            : keepOutOf(r.path, r.pinch, r.need).map((k) => k.poly);
        // A piece in a room the way leads to isn't in the way to it.
        const meets =
          rule.relation === 'notIn'
            ? subject
                .filter((p) => !(p.room && t.to.includes(p.room)))
                .filter((p) => band.some((b) => overlapDepth(p.fp, b) > 0.01))
                .map((p) => p.it.id)
            : [];
        const blamed = (
          rule.relation === 'notIn' ? [...new Set([...r.blamed, ...meets])] : r.blamed
        ).filter((id) => ids.has(id));
        if (rule.relation === 'keepClear' && r.ok) continue;
        if (!blamed.length) {
          // No piece narrows it: the walls do, and furnishing can't fix that.
          if (rule.relation === 'keepClear' && !r.ok && !r.blamed.length) {
            fail(
              null,
              `the way to ${level.rooms[r.roomId]?.name ?? 'a room'} is ${m(r.have)}, ${m(r.need)} needed`,
              { roomId: r.roomId, unfixable: true },
            );
          }
          continue;
        }
        for (const id of blamed) {
          if (seen.has(id)) continue;
          seen.add(id);
          const p = byId.get(id);
          if (!p) continue;
          fail(
            p,
            rule.relation === 'notIn'
              ? `${name(p)} is in ${tw}`
              : `${name(p)} leaves ${m(r.have)}, ${m(r.need)} needed`,
            {},
            band,
          );
        }
      }
      continue;
    }

    // Rooms: in, and not in.
    if (rule.relation === 'in' || (rule.relation === 'notIn' && t.kind !== 'spot')) {
      const rooms = targetRooms(t);
      for (const p of subject) {
        const inside = !!p.room && rooms.includes(p.room);
        if (rule.relation === 'in' && !inside)
          fail(
            p,
            `${name(p)} is in ${p.room ? (level.rooms[p.room]?.name ?? 'another room') : 'no room'}, not ${tw}`,
          );
        if (rule.relation === 'notIn' && inside && p.room) {
          const outer = shapes.get(p.room)?.outer;
          fail(p, `${name(p)} is in ${tw}`, {}, outer && convex(outer) ? [outer] : undefined);
        }
      }
      continue;
    }

    // A spot: nothing in it, or keep it clear.
    if (t.kind === 'spot' && (rule.relation === 'notIn' || rule.relation === 'keepClear')) {
      const circle = circlePoly(t.at, t.r);
      for (const p of subject) {
        if (overlapDepth(p.fp, circle) > 0.01) fail(p, `${name(p)} is in ${tw}`, {}, [circle]);
      }
      continue;
    }

    // Clear in front of a door or window.
    if (t.kind === 'opening' && rule.relation === 'keepClear') {
      const o = geomOf().openings.find((x) => x.opening.id === t.openingId);
      if (!o) continue;
      const depth = n ?? 0.9;
      const { a, d, n: nrm } = o.frame;
      const [u0, u1] = o.span;
      const at = (u: number, s: number) => ({
        x: a.x + d.x * u + nrm.x * s,
        y: a.y + d.y * u + nrm.y * s,
      });
      const half = o.frame.half;
      const zone = [
        at(u0, -half - depth),
        at(u1, -half - depth),
        at(u1, half + depth),
        at(u0, half + depth),
      ];
      for (const p of subject) {
        if (overlapDepth(p.fp, zone) > 0.01)
          fail(
            p,
            `${name(p)} is in the ${m(depth)} in front of ${openingWords(level, t.openingId)}`,
            { openingId: t.openingId },
            [zone],
          );
      }
      continue;
    }

    for (const p of subject) {
      const w = whereFor(t, p);
      if (!w.points.length && !w.polys.length && !w.segs.length) continue;
      if (rule.relation === 'faces' || rule.relation === 'notFaces') {
        const to = facePoint(p, w);
        if (!to) continue;
        const facing = offAngle(p.it, to) <= FACE_ANGLE;
        if (rule.relation === 'faces' && !facing) fail(p, `${name(p)} faces away from ${tw}`);
        if (rule.relation === 'notFaces' && facing) fail(p, `${name(p)} faces ${tw}`);
      } else if (rule.relation === 'within' || rule.relation === 'atLeast') {
        const d = gapTo(p, w);
        if (d === null || n === null) continue;
        if (rule.relation === 'within' && d > n + 0.005)
          fail(p, `${name(p)} is ${m(d)} from ${tw}, ${m(n)} at most`);
        if (rule.relation === 'atLeast' && d < n - 0.005)
          fail(p, `${name(p)} is ${m(d)} from ${tw}, ${m(n)} needed`);
      } else if (rule.relation === 'against') {
        const back = backOf(p.fp);
        const mid = { x: (back.a.x + back.b.x) / 2, y: (back.a.y + back.b.y) / 2 };
        const segs = [...w.segs];
        if (t.kind === 'window') {
          for (const o of roomOpenings(p.room, 'window')) {
            const s = wallSeg(o.wallId);
            if (s) segs.push(s);
          }
        }
        const near =
          segs.some(([a, b, half]) => segDist(mid, a, b) - half <= AGAINST_GAP + 0.005) ||
          w.polys.some((q) => polygonGap(dotPoly(mid), q).d <= AGAINST_GAP + 0.005);
        if (!near) fail(p, `${name(p)} isn’t against ${tw}`);
      }
    }
  }
  // One line per key.
  const seen = new Set<string>();
  const checks = out.filter((c) => {
    if (seen.has(c.key)) return false;
    seen.add(c.key);
    return true;
  });
  return { checks, regions };
}

/** The main door, if the plan has one marked (route rules need it). */
export const hasMainDoor = (level: Level) => !!entranceDoor(level);
