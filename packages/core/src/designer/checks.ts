import { type ClearanceIssue, blocks, clearanceIssues, fixedParts } from '../clearance';
import { type Side, dot, overlapDepth, polygonGap, roomOff, sideOf } from '../convex';
import { type FurnitureKind, furnitureKind, itemFootprint, itemSize } from '../furniture';
import { pointInPolygon } from '../geometry';
import { planGeometry } from '../plan';
import { roomArea, roomShapes } from '../rooms';
import type { Item, Level, Vec2 } from '../schema';
import { SHELTER_ROOM } from '../structural';
import { roomKind } from '../suggest';
import { type WalkwayReport, walkwayReport } from '../walkway';
import { nameOf } from './place';
import {
  ACCESS,
  BEDROOM_USES,
  CIRCULATION,
  FIT,
  PROGRAMMES,
  type Person,
  type ProgrammeUse,
  type Relation,
  type Role,
  UNDER_WINDOW,
  isAre,
  isDouble,
  peopleOf,
  placesOf,
  relationOf,
  roleOf,
  seatsOf,
  sillTop,
  sleepingPlan,
  sleepsOf,
  windowZones,
} from './principles';
import { ruleChecks } from './rules/check';
import type { Rule } from './rules/schema';
import type { DesignBrief, RoomUse } from './schema';
import { roomsBeside, spacesOf } from './spaces';

/**
 * The design checks: the four principles (principles.ts) checked on a level, each failure a
 * line in the app's words with the piece or room it is about. Hard checks gate a proposal;
 * soft ones are advice. HDB rules can't be waived. Spec: docs/specs/ai-designer-v2.md.
 */
export type Principle = 'P1' | 'P2' | 'P3' | 'P4' | 'HDB' | 'R';

export interface DesignCheck {
  /** The same failure has the same key on another level (to tell caused from already there). */
  key: string;
  principle: Principle;
  hard: boolean;
  /** Accept anyway may waive it (never an HDB rule). */
  waivable: boolean;
  text: string;
  itemId?: string;
  roomId?: string;
  openingId?: string;
  /** The clearance or walkway issue behind it, for drawing. */
  issue?: ClearanceIssue;
  /**
   * Furnishing can't fix it (a bedroom with no window, more people than bedrooms): never
   * sent back to the designer, and "already in your plan" when the plan had it.
   */
  unfixable?: boolean;
}

export interface CheckOptions {
  brief: DesignBrief;
  /** Room uses the design gives, by room id. */
  uses?: Record<string, RoomUse>;
  /** Relationship rows by kind id, for kinds the catalogue has no row for. */
  relations?: Record<string, Relation>;
  /** Already worked out for this level. */
  clearance?: ClearanceIssue[];
  walk?: WalkwayReport;
  /** The household's house rules for this level (slice 3a): each a hard, waivable R check. */
  rules?: readonly Rule[];
}

/** The way to a bed side, hard (the walkway check's 0.60 m is the better width). */
export const BED_ACCESS = 0.5;
const CORRIDOR = /corridor|foyer|passage|hallway|\bhall\b|entrance/i;
const deg = (r: number) => (r * 180) / Math.PI;
const fwd = (it: Item): Vec2 => ({ x: -Math.sin(it.rotationY), y: Math.cos(it.rotationY) });
const centre = (it: Item): Vec2 => ({ x: it.position.x, y: it.position.z });
const m = (v: number) => `${v.toFixed(2)} m`;
const cap = (s: string) => (s ? `${s[0]?.toUpperCase()}${s.slice(1)}` : s);

/** A footprint's back side (from back-right to back-left, facing out behind). */
function backOf(fp: Vec2[]): Side {
  const [bl, br, , fl] = fp as [Vec2, Vec2, Vec2, Vec2];
  const width = Math.hypot(bl.x - br.x, bl.y - br.y) || 1;
  const depth = Math.hypot(fl.x - bl.x, fl.y - bl.y) || 1;
  return { a: br, b: bl, n: { x: (bl.x - fl.x) / depth, y: (bl.y - fl.y) / depth }, width };
}

/** The angle (degrees) between a piece's forward line and the way to a point. */
function offAngle(it: Item, to: Vec2): number {
  const f = fwd(it);
  const v = { x: to.x - it.position.x, y: to.y - it.position.z };
  const len = Math.hypot(v.x, v.y) || 1;
  return deg(Math.acos(Math.max(-1, Math.min(1, dot(f, v) / len))));
}

/** Whether a segment crosses a convex polygon (or ends in it). */
function crosses(a: Vec2, b: Vec2, poly: Vec2[]): boolean {
  if (pointInPolygon(a, poly) || pointInPolygon(b, poly)) return true;
  const cross = (p: Vec2, q: Vec2, r: Vec2) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i] as Vec2;
    const q = poly[(i + 1) % poly.length] as Vec2;
    const d1 = cross(a, b, p);
    const d2 = cross(a, b, q);
    const d3 = cross(p, q, a);
    const d4 = cross(p, q, b);
    if (d1 * d2 < 0 && d3 * d4 < 0) return true;
  }
  return false;
}

/** The uses a room is checked for: the design's, the brief's, else what its name says. */
export function usesOf(
  level: Level,
  roomId: string,
  opts: Pick<CheckOptions, 'brief' | 'uses'>,
): ProgrammeUse[] {
  const r = level.rooms[roomId];
  if (!r) return [];
  if (SHELTER_ROOM.test(r.name)) return ['shelter'];
  const out: ProgrammeUse[] = [];
  const said = opts.uses?.[roomId];
  const brief = opts.brief.rooms[roomId]?.use;
  const use: RoomUse | null =
    said ?? (brief && brief !== 'keep' && brief !== 'designer' ? brief : null);
  if (use) out.push(use);
  else if (CORRIDOR.test(r.name) && !/living|dining/i.test(r.name)) out.push('corridor');
  else {
    const k = roomKind(r.name);
    if (k === 'bedroom') out.push(/master|main/i.test(r.name) ? 'master' : 'bedroom');
    else if (k === 'living') out.push('living');
    else if (k === 'kitchen' && !/dry/i.test(r.name)) out.push('kitchen');
    else if (k === 'study') out.push('study');
  }
  if (/dining/i.test(r.name) && !out.includes('dining')) out.push('dining');
  return out;
}

interface Piece {
  it: Item;
  kind: FurnitureKind;
  role: Role;
  fp: Vec2[];
  room: string | null;
  size: { w: number; d: number; h: number };
}

/** Every check on a level. */
export function designChecks(level: Level, opts: CheckOptions): DesignCheck[] {
  const out: DesignCheck[] = [];
  const shapes = roomShapes(level);
  const roomAt = (p: Vec2): string | null => {
    for (const [id, s] of shapes) {
      if (pointInPolygon(p, s.outer) && !s.holes.some((h) => pointInPolygon(p, h))) return id;
    }
    return null;
  };
  const pieces: Piece[] = Object.values(level.items).flatMap((it) => {
    const kind = furnitureKind(it.assetId);
    if (!kind) return [];
    return [
      {
        it,
        kind,
        role: roleOf(kind),
        fp: itemFootprint(it, kind),
        room: roomAt(centre(it)),
        size: itemSize(it, kind),
      },
    ];
  });
  const byId = new Map(pieces.map((p) => [p.it.id, p]));
  const label = (id: string) => {
    const p = byId.get(id);
    return p ? `the ${nameOf(p.kind)}` : 'a piece';
  };
  const roomName = (id: string | null) => (id ? (level.rooms[id]?.name ?? 'the room') : 'the room');
  const shelterDoors = new Set(
    Object.values(level.openings)
      .filter((o) => roomsBeside(level, o.wallId).some((r) => r && SHELTER_ROOM.test(roomName(r))))
      .map((o) => o.id),
  );

  // P3 and P4: clearances and walkways, the v1 checks, now binding.
  const issues = opts.clearance ?? clearanceIssues(level);
  const seenPair = new Set<string>();
  for (const i of issues) {
    switch (i.kind) {
      case 'overlap': {
        const pair = [i.itemId, i.otherId].sort().join('|');
        if (seenPair.has(pair)) break;
        seenPair.add(pair);
        if (i.depth <= FIT.overlap) break;
        out.push({
          key: `P4|overlap|${pair}`,
          principle: 'P4',
          hard: true,
          waivable: true,
          text: `${cap(label(i.itemId))} overlaps ${label(i.otherId)}.`,
          itemId: i.itemId,
          issue: i,
        });
        break;
      }
      case 'wall':
        out.push({
          key: `P4|wall|${i.itemId}`,
          principle: 'P4',
          hard: true,
          waivable: true,
          text: `${cap(label(i.itemId))} goes into a wall.`,
          itemId: i.itemId,
          issue: i,
        });
        break;
      case 'zone': {
        const it = byId.get(i.itemId);
        const access = it ? ACCESS[it.kind.id] : undefined;
        const name = label(i.itemId);
        let hard = true;
        let text = `Not enough room to use ${name}: ${i.what.toLowerCase()} ${m(i.need)}, ${m(i.have)} left.`;
        if (i.side === 'back') {
          text = `Not enough room to pull out ${name}: ${m(i.need)} needed, ${m(i.have)} left.`;
        } else if (access) {
          const bed = it?.role === 'bed';
          // A double bed: one long side to get in is enough; the other may be against a wall.
          const sides = issues.filter(
            (x): x is Extract<ClearanceIssue, { kind: 'zone' }> =>
              x.kind === 'zone' && x.itemId === i.itemId,
          );
          const best =
            access.oneSide && sides.length < 2
              ? Number.POSITIVE_INFINITY
              : Math.max(...sides.map((x) => x.have));
          const ok = access.oneSide ? best >= access.hard - 0.005 : i.have >= access.hard - 0.005;
          hard = !ok && (!access.oneSide || i.have === best);
          if (hard) {
            text = bed
              ? `Not enough room to get into ${name}: ${m(access.hard)} needed beside it, ${m(i.have)} left.`
              : `Not enough room to open ${name}: ${m(access.hard)} needed in front, ${m(i.have)} left.`;
          } else if (access.oneSide && i.have < access.hard - 0.005) {
            text = `${cap(name)} has one side to get in; the other is against the wall, fine in a small room.`;
          } else {
            text = bed
              ? `Getting into ${name}: ${m(access.soft)} beside it is better, ${m(i.have)} left.`
              : `Opening ${name}: ${m(access.soft)} in front is better, ${m(i.have)} left.`;
          }
        }
        out.push({
          key: `P4|zone|${i.itemId}|${i.side}`,
          principle: 'P4',
          hard,
          waivable: true,
          text,
          itemId: i.itemId,
          issue: i,
        });
        break;
      }
      case 'door': {
        const hdb = shelterDoors.has(i.openingId);
        out.push({
          key: `P3|door|${i.itemId}|${i.openingId}`,
          principle: hdb ? 'HDB' : 'P3',
          hard: true,
          waivable: !hdb,
          text: hdb
            ? `${cap(label(i.itemId))} ${isAre(label(i.itemId))} in the shelter door’s swing: the shelter door must open.`
            : `${cap(label(i.itemId))} ${isAre(label(i.itemId))} in a door’s swing.`,
          itemId: i.itemId,
          openingId: i.openingId,
          issue: i,
        });
        break;
      }
      case 'door-front':
        out.push({
          key: `P3|door-front|${i.itemId}|${i.openingId}`,
          principle: 'P3',
          hard: true,
          waivable: true,
          text: `A door hits ${label(i.itemId)}’s doors.`,
          itemId: i.itemId,
          openingId: i.openingId,
          issue: i,
        });
        break;
      case 'doors':
        // Two doors of the plan: the plan's own, never the furniture's.
        break;
      case 'walkway':
        break;
    }
  }
  const walk = opts.walk ?? walkwayReport(level);
  for (const i of walk.issues) {
    // To a bed side: 0.50 m is enough to get in (0.60 m better).
    const hard = i.route !== 'bed' || i.have < BED_ACCESS - 0.005;
    out.push({
      key: `P3|walkway|${i.itemId}|${i.route}`,
      principle: 'P3',
      hard,
      waivable: true,
      text:
        i.route === 'bed'
          ? `${cap(label(i.itemId))} narrows the way to a bed to ${m(i.have)}: ${m(hard ? BED_ACCESS : i.need)} ${hard ? 'needed' : 'is better'}.`
          : `${cap(label(i.itemId))} narrows the way through to ${m(i.have)}: ${m(i.need)} needed.`,
      itemId: i.itemId,
      issue: i,
    });
  }

  // P4: nothing taller than a window's sill in front of it.
  const geom = planGeometry(level);
  for (const o of geom.openings) {
    if (o.kind !== 'window') continue;
    for (const p of pieces) {
      // A counter under a kitchen window, a plant or a lamp by one, are as they should be.
      if (!blocks(p.it) || UNDER_WINDOW.has(p.role)) continue;
      const bottom = p.kind.elevation ?? 0;
      const full = bottom + p.size.h;
      if (full <= o.opening.sill - FIT.sill) continue;
      if (!windowZones(o).some((z) => overlapDepth(p.fp, z) > 0.01)) continue;
      // A bed is measured at its mattress; a headboard above the sill is advice.
      const hard = sillTop(p.kind, p.size.h) > o.opening.sill - FIT.sill;
      out.push({
        key: `P4|window|${p.it.id}|${o.opening.id}`,
        principle: 'P4',
        hard,
        waivable: true,
        text: hard
          ? `${cap(label(p.it.id))} blocks a window: it stands higher than the sill.`
          : `${cap(label(p.it.id))}’s headboard rises ${m(full - o.opening.sill)} above the window sill.`,
        itemId: p.it.id,
        openingId: o.opening.id,
      });
    }
  }

  // P2: each piece's relationships.
  const { walls } = fixedParts(level);
  const windows = geom.openings.filter((o) => o.kind === 'window').map((o) => o.polygon);
  const spaces = spacesOf(level);
  const spaceOf = (roomId: string | null) =>
    roomId ? (spaces.find((s) => s.rooms.includes(roomId))?.rooms ?? [roomId]) : [];
  const sameSpace = (p: Piece) => {
    const rs = new Set(spaceOf(p.room));
    return pieces.filter((q) => q !== p && q.room && rs.has(q.room));
  };
  const floor = (q: Piece) => blocks(q.it);
  for (const p of pieces) {
    const rel = relationOf(p.kind, opts.relations);
    if (!rel || !p.room) continue;
    const name = nameOf(p.kind);
    const fail = (code: string, text: string) =>
      out.push({
        key: `P2|${code}|${p.it.id}`,
        principle: 'P2',
        hard: true,
        waivable: true,
        text,
        itemId: p.it.id,
      });
    const others = sameSpace(p);
    if (rel.backs) {
      const back = backOf(p.fp);
      const gap = roomOff(back, rel.backs.gap + 0.3, walls);
      const onWall = gap <= rel.backs.gap + 1e-6;
      const behind = rel.backs.free
        ? roomOff(back, rel.backs.free, [...walls, ...others.filter(floor).map((q) => q.fp)])
        : 0;
      if (onWall && rel.backs.window) {
        const reach = rel.backs.gap + 0.3;
        const off = (c: Vec2) => ({ x: c.x + back.n.x * reach, y: c.y + back.n.y * reach });
        const zone = [back.a, back.b, off(back.b), off(back.a)];
        if (!windows.some((w) => overlapDepth(zone, w) > 0)) {
          fail('backs', `The ${name} should be under a window.`);
        }
      } else if (!onWall) {
        if (!rel.backs.free) {
          fail('backs', `The ${name} stands ${m(gap)} off the wall: it goes against one.`);
        } else if (behind < rel.backs.free - 0.005) {
          fail(
            'backs',
            `Not enough room to walk behind the ${name}: ${m(rel.backs.free)} needed, ${m(behind)} left.`,
          );
        }
      }
    }
    if (rel.faces) {
      const f = rel.faces;
      const front = sideOf(p.fp, 'front');
      const ahead = roomOff(front, f.clear, walls);
      // A seat is faced from in front of it, never from its arm or its back.
      const inFront = (q: Piece) => {
        const v = { x: p.it.position.x - q.it.position.x, y: p.it.position.z - q.it.position.z };
        return dot(v, fwd(q.it)) > q.size.d / 2;
      };
      const focus = others
        .filter((q) => f.focus.includes(q.role) && (q.role !== 'sofa' || inFront(q)))
        .sort(
          (a, b) =>
            offAngle(p.it, centre(a.it)) - offAngle(p.it, centre(b.it)) ||
            (a.it.id < b.it.id ? -1 : 1),
        );
      if (f.clear && ahead < f.clear - 0.005) {
        fail(
          'faces',
          `The ${name} faces the wall, ${m(ahead)} away: it needs ${m(f.clear)} clear in front.`,
        );
      } else if (focus.length) {
        const q = focus[0] as Piece;
        const angle = offAngle(p.it, centre(q.it));
        const mid = { x: (front.a.x + front.b.x) / 2, y: (front.a.y + front.b.y) / 2 };
        const dist = polygonGap([mid, mid, mid], q.fp).d;
        const between = others.find(
          (o) =>
            o !== q &&
            floor(o) &&
            (o.kind.elevation ?? 0) + o.size.h > f.over &&
            crosses(mid, centre(q.it), o.fp),
        );
        if (angle > f.angle + 1e-6) {
          fail(
            'faces',
            `The ${name} is turned ${Math.round(angle)}° away from the ${nameOf(q.kind)}: ${f.angle}° at most.`,
          );
        } else if (dist < f.min - 1e-6 || dist > f.max + 1e-6) {
          fail(
            'faces',
            `The ${name} is ${m(dist)} from the ${nameOf(q.kind)}: ${f.min.toFixed(1)}–${f.max.toFixed(1)} m is right.`,
          );
        } else if (between) {
          fail(
            'faces',
            `The ${nameOf(between.kind)} stands between the ${name} and the ${nameOf(q.kind)}.`,
          );
        }
      }
    }
    if (rel.near) {
      const near = rel.near;
      const best = others
        .filter((q) => near.of.includes(q.role))
        .map((q) => ({ q, d: polygonGap(p.fp, q.fp).d }))
        .sort((a, b) => a.d - b.d)[0];
      // With none of what it goes with in the space, there's nothing to be beside.
      let ok = !best || best.d <= near.within + 1e-6;
      if (ok && best && near.head) {
        // By its head end: on the back half of the bed.
        const b = best.q.it;
        const v = { x: p.it.position.x - b.position.x, y: p.it.position.z - b.position.z };
        ok = dot(v, fwd(b)) < 0;
      }
      if (!ok) {
        fail(
          'near',
          `The ${name} isn’t beside ${near.head ? 'a bed’s head' : `a ${near.of.join(' or ')}`}.`,
        );
      }
    }
    if (rel.belongs) {
      const bel = rel.belongs;
      const best = others
        .filter((q) => bel.of.includes(q.role))
        .map((q) => ({ q, g: polygonGap(p.fp, q.fp) }))
        .sort((a, b) => a.g.d - b.g.d)[0];
      if (!best || best.g.d > bel.within + 1e-6) {
        fail('belongs', `The ${name} isn’t at a table.`);
      } else {
        const target = best.g.d > 0 ? best.g.b : centre(best.q.it);
        if (offAngle(p.it, target) > bel.angle + 1e-6 && offAngle(p.it, centre(best.q.it)) > 90) {
          fail('belongs', `The ${name} faces away from its table.`);
        }
      }
    }
    if (rel.apart) {
      const ap = rel.apart;
      // The dining group: the table and the chairs at it, pulled out or not.
      const group = [
        p.fp,
        ...others
          .filter((q) => q.role === 'dining-chair' && polygonGap(q.fp, p.fp).d < 0.4)
          .map((q) => q.fp),
      ];
      const close = others
        .filter((q) => ap.from.includes(q.role) && blocks(q.it))
        .map((q) => ({ q, d: Math.min(...group.map((g) => polygonGap(g, q.fp).d)) }))
        .sort((a, b) => a.d - b.d)[0];
      if (close && close.d < ap.hard - 0.005) {
        out.push({
          key: `P2|apart|${p.it.id}`,
          principle: 'P2',
          hard: true,
          waivable: true,
          text: `Not enough room to walk between the ${name} and the ${nameOf(close.q.kind)}: ${m(ap.hard)} needed, ${m(close.d)} left.`,
          itemId: p.it.id,
        });
      } else if (close && close.d < ap.gap - 0.005) {
        out.push({
          key: `P2|apart|${p.it.id}`,
          principle: 'P2',
          hard: false,
          waivable: true,
          text: `Leave ${m(ap.gap)} between the ${name} and the ${nameOf(close.q.kind)} to walk between them: ${m(close.d)} now.`,
          itemId: p.it.id,
        });
      }
    }
    if (rel.before) {
      const bef = rel.before;
      const sofas = others.filter((q) => bef.of.includes(q.role));
      if (sofas.length) {
        const gaps = sofas.map((q) => roomOff(sideOf(q.fp, 'front'), bef.max + 1, [p.fp]));
        const gap = Math.min(...gaps);
        if (gap > bef.max + 1 - 1e-6) {
          fail('before', `The ${name} isn’t in front of the ${nameOf((sofas[0] as Piece).kind)}.`);
        } else if (gap < bef.min - 0.005 || gap > bef.max + 0.005) {
          fail(
            'before',
            `The ${name} is ${m(gap)} from the sofa: ${bef.min.toFixed(2)}–${bef.max.toFixed(2)} m keeps it in reach.`,
          );
        }
      }
    }
  }

  // P1: what each room is for, sized to the household.
  const people = peopleOf(opts.brief);
  const household = people.filter((p) => p.kind !== 'helper').length;
  const bedrooms = Object.values(level.rooms)
    .filter((r) => usesOf(level, r.id, opts).some((u) => BEDROOM_USES.has(u as RoomUse)))
    .map((r) => ({ id: r.id, area: roomArea(level, r) }));
  const plan = sleepingPlan(opts.brief, bedrooms, (id) => !!level.rooms[id]);
  const windowsOf = new Set<string>();
  for (const o of Object.values(level.openings)) {
    if (o.kind !== 'window') continue;
    for (const r of roomsBeside(level, o.wallId)) if (r) windowsOf.add(r);
  }
  const inRoom = (roomId: string) => pieces.filter((p) => p.room === roomId);
  const inSpace = (roomId: string) => {
    const rs = new Set(spaceOf(roomId));
    return pieces.filter((p) => p.room && rs.has(p.room));
  };
  const need = (
    code: string,
    roomId: string,
    text: string,
    hard = true,
    principle: Principle = 'P1',
  ) =>
    out.push({
      key: `${principle}|${code}|${roomId}`,
      principle,
      hard,
      waivable: principle !== 'HDB',
      text,
      roomId,
    });
  const checkedSpaces = new Set<string>();
  for (const r of Object.values(level.rooms).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const uses = usesOf(level, r.id, opts);
    for (const use of uses) {
      const prog = PROGRAMMES[use];
      for (const role of prog.mustNot) {
        for (const p of inRoom(r.id).filter((x) => x.role === role && blocks(x.it))) {
          out.push({
            key: `P1|not|${p.it.id}|${r.id}`,
            principle: 'P1',
            hard: true,
            waivable: true,
            text: `${cap(label(p.it.id))} doesn’t belong in ${r.name}.`,
            itemId: p.it.id,
            roomId: r.id,
          });
        }
      }
      for (const n of [...prog.must, ...prog.should]) {
        const hard = prog.must.includes(n);
        switch (n) {
          case 'window':
            if (!windowsOf.has(r.id)) {
              out.push({
                key: `P1|window|${r.id}`,
                principle: 'P1',
                hard: true,
                waivable: true,
                text: `${r.name} has no window. A bedroom needs one for light and air.`,
                roomId: r.id,
                unfixable: true,
              });
            }
            break;
          case 'beds':
            for (const c of bedNeeds(r.id, r.name, plan, inRoom(r.id))) {
              out.push({
                key: `P1|bed|${r.id}|${c.who}`,
                principle: 'P1',
                hard: true,
                waivable: true,
                text: c.text,
                roomId: r.id,
              });
            }
            break;
          case 'seats': {
            const key = spaceOf(r.id).join('+');
            if (checkedSpaces.has(`seats|${key}`)) break;
            checkedSpaces.add(`seats|${key}`);
            const want = Math.min(household, 3);
            const seats = inSpace(r.id).reduce((t, p) => t + seatsOf(p.kind, p.size.w), 0);
            if (want > 0 && seats < want) {
              need(
                'seats',
                r.id,
                `${r.name} seats ${seats}; the household needs at least ${want} on a sofa or chairs.`,
                hard,
              );
            }
            break;
          }
          case 'dining': {
            const key = spaceOf(r.id).join('+');
            if (checkedSpaces.has(`dining|${key}`)) break;
            checkedSpaces.add(`dining|${key}`);
            const want = Math.min(household, 6);
            const ps = inSpace(r.id);
            const tables = ps.filter((p) => p.role === 'dining-table');
            const chairs = ps.filter((p) => p.role === 'dining-chair' || p.role === 'stool');
            let places = 0;
            for (const t of tables) {
              const at = chairs.filter((c) => polygonGap(c.fp, t.fp).d <= 0.3).length;
              places +=
                t.kind.id === 'bistro-set' || t.kind.id === 'dining-bench-2'
                  ? 2
                  : // An extendable table with four at it seats six pulled out.
                    t.kind.id === 'dining-extendable' && at >= 4
                    ? placesOf(t.kind)
                    : Math.min(placesOf(t.kind, t.size.w, t.size.d), at);
            }
            if (want > 0 && !tables.length) {
              need('dining', r.id, `${r.name} has no dining table for the household.`, hard);
            } else if (want > 0 && places < want) {
              need(
                'dining',
                r.id,
                `The dining table seats ${places}; the household is ${household}.`,
                hard,
              );
            }
            break;
          }
          case 'desks': {
            const want = Math.max(1, opts.brief.lifestyle.wfh);
            const desks = inRoom(r.id).filter((p) => p.role === 'desk').length;
            if (desks < want) {
              need(
                'desks',
                r.id,
                `${r.name} has ${desks} desk${desks === 1 ? '' : 's'}; ${want} work here.`,
                hard,
              );
            }
            break;
          }
          case 'clothes':
            if (
              (plan.rooms.get(r.id)?.length ?? 0) > 0 &&
              !inRoom(r.id).some((p) => p.role === 'wardrobe' || p.role === 'drawers')
            ) {
              need('clothes', r.id, `${r.name} has nowhere for clothes.`, false);
            }
            break;
          case 'focus': {
            if (!inSpace(r.id).some((p) => p.role === 'tv')) {
              need('focus', r.id, `${r.name}’s seats have no TV or feature to face.`, false);
            }
            break;
          }
          case 'bedside':
            break;
          case 'shallow':
            for (const p of inRoom(r.id).filter((x) => blocks(x.it))) {
              if (p.size.d > CIRCULATION.corridorDepth + 1e-6) {
                out.push({
                  key: `P1|corridor|${p.it.id}`,
                  principle: 'P1',
                  hard: true,
                  waivable: true,
                  text: `${cap(label(p.it.id))} ${isAre(label(p.it.id))} too deep for ${r.name}: ${m(CIRCULATION.corridorDepth)} at most here.`,
                  itemId: p.it.id,
                  roomId: r.id,
                });
              }
            }
            break;
          case 'no-bed': {
            const beds = inRoom(r.id).filter((p) => p.role === 'bed');
            if (!beds.length) break;
            const helper = (plan.rooms.get(r.id) ?? []).some((p) => p.kind === 'helper');
            for (const b of beds) {
              out.push({
                key: `HDB|shelter-bed|${b.it.id}`,
                principle: helper ? 'P1' : 'HDB',
                hard: !helper,
                waivable: false,
                text: helper
                  ? `The helper sleeps in the ${r.name}: keep its door free and nothing fixed to its walls.`
                  : `A bed in the ${r.name}: the household shelter isn’t a bedroom.`,
                itemId: b.it.id,
                roomId: r.id,
              });
            }
            break;
          }
        }
      }
    }
  }
  // People who sleep in a room that isn't a bedroom by its use still get their bed checked.
  for (const [roomId, ps] of plan.rooms) {
    const r = level.rooms[roomId];
    if (!r || !ps.length) continue;
    const uses = usesOf(level, roomId, opts);
    if (uses.some((u) => PROGRAMMES[u].must.includes('beds')) || uses.includes('shelter')) continue;
    for (const c of bedNeeds(roomId, r.name, plan, inRoom(roomId))) {
      out.push({
        key: `P1|bed|${roomId}|${c.who}`,
        principle: 'P1',
        hard: true,
        waivable: true,
        text: c.text,
        roomId,
      });
    }
  }
  // Nobody is dropped silently: each person with nowhere to sleep is a line of its own.
  const bedroomsN = bedrooms.length;
  for (const p of plan.unplaced) {
    out.push({
      key: `P1|unplaced|${p.key}`,
      principle: 'P1',
      hard: true,
      waivable: true,
      text: plan.assumed
        ? `${p.name} has no bedroom: ${household} people and ${bedroomsN} ${bedroomsN === 1 ? 'bedroom' : 'bedrooms'}. Say who sleeps where in the brief.`
        : `${p.name} has no bed: say where they sleep in the brief.`,
      unfixable: true,
    });
  }
  for (const p of plan.gone) {
    out.push({
      key: `P1|unplaced|${p.key}`,
      principle: 'P1',
      hard: true,
      waivable: true,
      text: `${p.name} has no bed: the room they sleep in isn’t on the plan any more.`,
      unfixable: true,
    });
  }
  if (plan.assumed && bedrooms.length && people.length) {
    out.push({
      key: 'P1|assumed',
      principle: 'P1',
      hard: false,
      waivable: true,
      text: 'Who sleeps where was assumed: say so in the brief to check beds for each person.',
    });
  }
  // One line per key (a piece narrowing a way at two places is one failure).
  if (opts.rules?.length) {
    out.push(
      ...ruleChecks(opts.rules, {
        level,
        usesOf: (id) => usesOf(level, id, opts),
        // The walkway check above made its pass on this level just now (unless it was given).
        samePass: !opts.walk,
      }),
    );
  }
  const seen = new Set<string>();
  return out.filter((c) => {
    if (seen.has(c.key)) return false;
    seen.add(c.key);
    return true;
  });
}

/** The people in a room left without a bed, in words. */
function bedNeeds(
  roomId: string,
  roomName: string,
  plan: ReturnType<typeof sleepingPlan>,
  pieces: Piece[],
): { who: string; text: string }[] {
  const people: Person[] = plan.rooms.get(roomId) ?? [];
  const beds = pieces
    .filter((p) => p.role === 'bed')
    .map((p) => ({ double: isDouble(p.size.w), w: p.size.w, places: sleepsOf(p.kind) }));
  if (!people.length) {
    if (plan.assumed && !beds.length) {
      return [{ who: 'anyone', text: `${roomName} has no bed.` }];
    }
    return [];
  }
  let doubles = beds.filter((b) => b.double).length;
  // A bunk bed is two single places.
  let singles = beds.filter((b) => !b.double).reduce((t, b) => t + b.places, 0);
  const missing: Person[] = [];
  const sleepers = people.filter((p) => !(p.kind === 'child' && p.detail === 'baby'));
  const adults = sleepers.filter((p) => p.kind === 'adult');
  // Elders get a bed first, then adults, then children (whatever order they were named in).
  const rank = { elder: 0, adult: 1, helper: 1, child: 2 } as const;
  const rest = sleepers
    .filter((p) => !adults.slice(0, 2).includes(p) || adults.length < 2)
    .sort((p, q) => rank[p.kind] - rank[q.kind]);
  if (adults.length >= 2) {
    const [a, b] = adults as [Person, Person];
    if (doubles) doubles--;
    else if (singles >= 2) singles -= 2;
    else if (singles === 1) {
      singles--;
      missing.push(b);
    } else missing.push(a, b);
  }
  for (const p of rest) {
    if (singles) singles--;
    else if (doubles) doubles--;
    else missing.push(p);
  }
  const children = sleepers.filter((p) => p.kind === 'child').length;
  return missing.map((p) => ({
    who: p.key,
    text:
      p.kind === 'child' && children >= 2 && beds.length > 0
        ? `${p.name} has no bed in ${roomName}: two beds don’t fit; a bunk bed sleeps two children in the space of one.`
        : p.kind === 'child' && beds.length > 0 && sleepers.length >= 2
          ? `${p.name} has no bed in ${roomName}: two beds don’t fit; a bunk bed would.`
          : `${p.name} has no bed in ${roomName}.`,
  }));
}

/**
 * What each of `rooms` must have, in words for the model (the same programmes the checks
 * apply): beds for who sleeps there, seats and a dining place for the household.
 */
export function roomNeeds(
  level: Level,
  rooms: string[],
  opts: Pick<CheckOptions, 'brief' | 'uses'>,
): string[] {
  const people = peopleOf(opts.brief);
  const household = people.filter((p) => p.kind !== 'helper').length;
  const bedrooms = Object.values(level.rooms)
    .filter((r) => usesOf(level, r.id, opts).some((u) => BEDROOM_USES.has(u as RoomUse)))
    .map((r) => ({ id: r.id, area: roomArea(level, r) }));
  const plan = sleepingPlan(opts.brief, bedrooms);
  const who = (p: Person) =>
    p.kind === 'adult' ? p.name : `${p.name} (${p.kind}${p.detail ? `, ${p.detail}` : ''})`;
  const out: string[] = [];
  const said = new Set<string>();
  for (const id of rooms) {
    const r = level.rooms[id];
    if (!r) continue;
    for (const use of usesOf(level, id, opts)) {
      const prog = PROGRAMMES[use];
      if (prog.must.includes('beds')) {
        const ps = plan.rooms.get(id) ?? [];
        const adults = ps.filter((p) => p.kind === 'adult');
        if (!ps.length) {
          if (plan.assumed) out.push(`${r.name}: one bed (who sleeps here wasn’t said)`);
        } else {
          const couple = adults.length >= 2 ? adults.slice(0, 2) : [];
          const rest = ps.filter((p) => !couple.includes(p));
          const parts = [
            ...(couple.length
              ? [`${couple.map(who).join(' and ')}: one bed at least 1.52 m wide, or two singles`]
              : []),
            ...rest.map((p) =>
              p.kind === 'child' && p.detail === 'baby'
                ? `${who(p)}: a cot (or a note)`
                : `${who(p)}: a bed of their own`,
            ),
          ];
          out.push(
            `${r.name}${plan.assumed ? ' (assumed)' : ''}: ${parts.join('; ')}; a window; somewhere for clothes`,
          );
        }
      }
      if (prog.must.includes('seats') && !said.has('seats') && household) {
        said.add('seats');
        out.push(
          `${r.name}: seats for at least ${Math.min(household, 3)}, facing the TV or a feature`,
        );
      }
      if (prog.must.includes('dining') && !said.has('dining') && household) {
        said.add('dining');
        out.push(
          `${r.name}: a dining table with a chair for each of the ${Math.min(household, 6)}`,
        );
      }
      if (prog.must.includes('desks')) {
        out.push(`${r.name}: ${Math.max(1, opts.brief.lifestyle.wfh)} desk(s) with a chair`);
      }
      if (prog.must.includes('shallow')) {
        out.push(`${r.name}: nothing deeper than ${CIRCULATION.corridorDepth} m (a corridor)`);
      }
      if (prog.mustNot.length) out.push(`${r.name}: no ${prog.mustNot.join(', ')}`);
    }
  }
  return out;
}
