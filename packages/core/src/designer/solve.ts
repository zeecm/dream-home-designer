import { overlapDepth, roomOff, sideOf } from '../convex';
import { itemFootprint, itemSize } from '../furniture';
import { pointInPolygon } from '../geometry';
import type { Item, Vec2 } from '../schema';
import { priorityOf } from './catalogue';
import {
  BUILT_IN_MIN,
  type Hit,
  type Shape,
  type SpaceIndex,
  type Want,
  addToIndex,
  blocking,
  hitsOf,
  inRooms,
  itemAt,
  nameOf,
  onFace,
  vertical,
} from './place';
import { type Relation, type Role, relationOf, roleOf } from './principles';
import type { Zone } from './schema';
import { type Face, clearStretches } from './spaces';
import type { Note } from './walls';

/**
 * The solver: a space's pieces placed from what the designer intends (answers of version 2),
 * not from coordinates. Each piece says what it stands against, what it faces and what it
 * goes with; the catalogue's relationship rows (principles.ts) fill in what it leaves out.
 * For each piece, most constrained first and every anchor before the pieces that go with it,
 * candidate poses are listed on every wall face and around its anchor or in its zone, those
 * that run into anything are dropped, and the rest are scored (relationships, room to use it,
 * the designer's preferences). A piece with nowhere to go makes the solver go back and try the
 * pieces before it elsewhere (two back, three tries each) before it is left out. Deterministic.
 */
export interface Intent {
  want: Want;
  against: 'wall' | 'window-wall' | 'not-door-wall' | 'free';
  /** Another piece's ref, or 'room', 'window', 'door'. */
  faces: string | null;
  /** The ref of the piece it goes with. */
  near: string | null;
  zone: Zone | null;
}

export interface SolveInput {
  ix: SpaceIndex;
  /** The space's wall faces. */
  faces: Face[];
  intents: Intent[];
  /** Where a zone is: outlines to look for free places in (the whole space for none). */
  zoneArea: (z: Zone | null) => Vec2[][];
  /** The ways people walk through the bare plan, as wide as they need: kept free if it can be. */
  ways?: Shape[];
}

export interface SolveOutcome {
  items: Item[];
  repaired: Note[];
  dropped: Note[];
  /** Poses tried. */
  tries: number;
}

interface Candidate {
  item: Item;
  score: number;
  soft: boolean;
  narrowed: boolean;
}

/** How many of the best candidates a piece keeps (for going back). */
const KEEP = 12;
/** Going back: how many pieces back, and how many other places each. */
const BACK = 2;
const ALTS = 3;
const GRID = 0.25;
const ALONG = 0.2;
const deg = (r: number) => (r * 180) / Math.PI;
const fwd = (r: number): Vec2 => ({ x: -Math.sin(r), y: Math.cos(r) });
/** The rotation that faces direction v. */
const facing = (v: Vec2) => Math.atan2(-v.x, v.y);
const centre = (it: Item): Vec2 => ({ x: it.position.x, y: it.position.z });

/** The angle (degrees) between a pose's forward line and the way to a point. */
function offAngle(at: Vec2, r: number, to: Vec2): number {
  const f = fwd(r);
  const v = { x: to.x - at.x, y: to.y - at.y };
  const len = Math.hypot(v.x, v.y) || 1;
  return deg(Math.acos(Math.max(-1, Math.min(1, (f.x * v.x + f.y * v.y) / len))));
}

/** The anchor a piece goes with: the one it names, else what its relationship row implies. */
function anchorRoles(rel: Relation | undefined): Role[] {
  if (!rel) return [];
  return [
    ...(rel.before?.of ?? []),
    ...(rel.belongs?.of ?? []),
    ...(rel.near?.of ?? []),
    ...(rel.faces?.focus ?? []),
  ];
}

export function solveSpace(input: SolveInput): SolveOutcome {
  const { ix, faces, intents } = input;
  const repaired: Note[] = [];
  const dropped: Note[] = [];
  let tries = 0;
  const byRef = new Map(intents.map((t) => [t.want.ref, t]));
  const roles = new Map(intents.map((t) => [t.want.ref, roleOf(t.want.kind)]));

  // Each piece's anchor: the ref it names (faces or near), else the first piece of a role its
  // row goes with (a sofa the TV, chairs their table, a bedside table its bed).
  const anchorOf = new Map<string, string>();
  for (const t of intents) {
    const named = [t.near, t.faces].find((r) => !!r && byRef.has(r) && r !== t.want.ref);
    if (named) {
      anchorOf.set(t.want.ref, named);
      continue;
    }
    const want = anchorRoles(relationOf(t.want.kind));
    const by = intents.find((o) => o !== t && want.includes(roles.get(o.want.ref) as Role));
    if (by) anchorOf.set(t.want.ref, by.want.ref);
  }
  // A TV faces the sofa, but the sofa is placed to face the TV: the TV goes first.
  for (const [ref, a] of [...anchorOf]) {
    if (anchorOf.get(a) === ref) {
      const r1 = roles.get(ref);
      if (r1 === 'tv' || r1 === 'tv-console') anchorOf.delete(ref);
      else anchorOf.delete(a);
    }
  }

  // Order: by priority, an anchor before what goes with it; then the most constrained first
  // (fewest places in the empty space).
  const room = new Map(intents.map((t) => [t.want.ref, roomFor(t)]));
  const sorted = [...intents].sort(
    (p, q) =>
      priorityOf(p.want.kind) - priorityOf(q.want.kind) ||
      (room.get(p.want.ref) ?? 0) - (room.get(q.want.ref) ?? 0) ||
      (p.want.ref < q.want.ref ? -1 : p.want.ref > q.want.ref ? 1 : 0),
  );
  const order: Intent[] = [];
  const queued = new Set<string>();
  const visit = (t: Intent, seen: Set<string>) => {
    if (queued.has(t.want.ref) || seen.has(t.want.ref)) return;
    seen.add(t.want.ref);
    const a = anchorOf.get(t.want.ref);
    const at = a ? byRef.get(a) : undefined;
    if (at) visit(at, seen);
    queued.add(t.want.ref);
    order.push(t);
  };
  for (const t of sorted) visit(t, new Set());

  /** Roughly how many places a piece has in the empty space: the walls long enough for it. */
  function roomFor(t: Intent): number {
    const k = t.want.kind;
    const rel = relationOf(k);
    const wallOnly =
      !!k.carpentry || (!!rel?.backs && rel.backs.free === undefined) || roleOf(k) === 'bed';
    if (t.against === 'free' && !wallOnly) return 1000;
    const { bottom, top } = vertical(t.want);
    return faces.reduce(
      (n, f) =>
        n +
        clearStretches(f, bottom, top).reduce(
          (m, [s0, s1]) => m + Math.max(0, Math.floor((s1 - s0 - t.want.w) / ALONG) + 1),
          0,
        ),
      0,
    );
  }

  /** The candidates for a piece, given what is placed (by ref), best first. */
  function candidates(t: Intent, placed: Map<string, Item>): Candidate[] {
    const w = t.want;
    const k = w.kind;
    const rel = relationOf(k);
    const anchorRef = anchorOf.get(w.ref);
    const anchor = anchorRef ? placed.get(anchorRef) : undefined;
    const anchorRole = anchorRef ? roles.get(anchorRef) : undefined;
    const wallOnly =
      !!k.carpentry || (!!rel?.backs && rel.backs.free === undefined) || roleOf(k) === 'bed';
    const onWall = t.against !== 'free' || wallOnly;
    const out: Candidate[] = [];
    const seen = new Set<string>();
    const add = (item: Item, hs: Hit[], narrowed = false) => {
      tries++;
      if (blocking(hs)) return;
      const key = `${item.position.x.toFixed(2)}|${item.position.z.toFixed(2)}|${item.rotationY.toFixed(2)}|${item.scale.x.toFixed(2)}`;
      if (seen.has(key)) return;
      seen.add(key);
      const soft = hs.length > 0;
      out.push({ item, soft, narrowed, score: score(t, item, soft, anchor, anchorRole) });
    };

    if (onWall) {
      const { bottom, top } = vertical(w);
      const list = faces.filter((f) => {
        if (t.against === 'window-wall') return f.openings.some((o) => o.kind === 'window');
        if (t.against === 'not-door-wall') return !f.openings.some((o) => o.kind !== 'window');
        return true;
      });
      for (const face of list.length ? list : faces) {
        for (const [s0, s1] of clearStretches(face, bottom, top)) {
          const len = s1 - s0;
          let width = w.w;
          let narrowed = false;
          if (len < width - 1e-6) {
            if (!k.carpentry || len < Math.max(BUILT_IN_MIN, width * 0.5)) continue;
            width = len;
            narrowed = true;
          }
          const us = new Set<number>();
          const lo = s0 + width / 2;
          const hi = s1 - width / 2;
          us.add(lo);
          us.add(hi);
          us.add((lo + hi) / 2);
          for (let u = lo; u <= hi + 1e-9; u += ALONG) us.add(u);
          if (w.face === face && w.along !== null) us.add(Math.min(hi, Math.max(lo, w.along)));
          // Beside what is already on this wall (a bedside table by the bed's head).
          for (const p of placed.values()) {
            const c = centre(p);
            const fr = face.frame;
            const u = (c.x - fr.a.x) * fr.d.x + (c.y - fr.a.y) * fr.d.y;
            const v = ((c.x - fr.a.x) * fr.n.x + (c.y - fr.a.y) * fr.n.y) * face.side;
            if (v < 0 || v > 1.2) continue;
            const pw = itemSize(p).w;
            // Under it too (a console under the TV).
            for (const s of [-1, 0, 1]) {
              const at = u + s * (pw / 2 + width / 2 + 0.01);
              if (at >= lo - 1e-9 && at <= hi + 1e-9) us.add(s ? at : u);
            }
          }
          for (const u of [...us].sort((a, b) => a - b)) {
            const pose = onFace(face, u, w.d);
            const item = itemAt(w, pose.at, pose.rotation, width);
            add(
              item,
              hitsOf(ix, item, k, { face, u0: u - width / 2, u1: u + width / 2, bottom, top }),
              narrowed,
            );
          }
        }
      }
    }

    if (!onWall || (!out.length && !wallOnly)) {
      const poses: { at: Vec2; r: number }[] = [];
      if (anchor) {
        const a = centre(anchor);
        const af = fwd(anchor.rotationY);
        const afp = itemFootprint(anchor);
        const front = sideOf(afp, 'front');
        const fm = { x: (front.a.x + front.b.x) / 2, y: (front.a.y + front.b.y) / 2 };
        const across = { x: -af.y, y: af.x };
        if (rel?.faces && rel.faces.focus.includes(anchorRole as Role) && anchorRole === 'tv') {
          // Facing the TV, along its line: 2.0–3.6 m from its front.
          for (let d = rel.faces.min + 0.2; d <= Math.min(rel.faces.max, 3.6) + 1e-9; d += 0.2) {
            for (const off of [0, 0.25, -0.25]) {
              const at = {
                x: fm.x + af.x * (d + w.d / 2) + across.x * off,
                y: fm.y + af.y * (d + w.d / 2) + across.y * off,
              };
              poses.push({ at, r: facing({ x: a.x - at.x, y: a.y - at.y }) });
            }
          }
        } else if (rel?.before) {
          // In front of the sofa, in reach.
          for (const gap of [0.42, 0.38, 0.47]) {
            poses.push({
              at: { x: fm.x + af.x * (gap + w.d / 2), y: fm.y + af.y * (gap + w.d / 2) },
              r: anchor.rotationY,
            });
          }
        } else if (rel?.belongs) {
          poses.push(...chairSlots(anchor, w.d));
        } else if (rel?.faces) {
          // An armchair at the side of what it faces, turned to it.
          const s = Math.max(...afp.map((p) => Math.hypot(p.x - a.x, p.y - a.y)));
          for (let i = 0; i < 8; i++) {
            const ang = (i * Math.PI) / 4;
            const dir = { x: Math.cos(ang), y: Math.sin(ang) };
            const at = { x: a.x + dir.x * (s + w.d / 2 + 0.3), y: a.y + dir.y * (s + w.d / 2 + 0.3) };
            poses.push({ at, r: facing({ x: a.x - at.x, y: a.y - at.y }) });
          }
        } else if (k.walkThrough) {
          // A rug under the group it goes with.
          poses.push({ at: a, r: anchor.rotationY });
        } else {
          // Beside it: at each corner, a little off.
          for (const p of afp) {
            const v = { x: p.x - a.x, y: p.y - a.y };
            const len = Math.hypot(v.x, v.y) || 1;
            const at = { x: p.x + (v.x / len) * (w.d / 2 + 0.1), y: p.y + (v.y / len) * (w.d / 2 + 0.1) };
            poses.push({ at, r: anchor.rotationY });
          }
        }
      }
      if (!poses.length || !anchor) {
        // In its zone (or near where the designer would have it).
        const turns = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2];
        const rs = rel?.faces ? turns : turns.slice(0, 2);
        if (w.at) for (const r of [w.rotation, ...rs]) poses.push({ at: w.at, r });
        for (const poly of input.zoneArea(t.zone)) {
          let x0 = Number.POSITIVE_INFINITY;
          let y0 = Number.POSITIVE_INFINITY;
          let x1 = Number.NEGATIVE_INFINITY;
          let y1 = Number.NEGATIVE_INFINITY;
          for (const p of poly) {
            x0 = Math.min(x0, p.x);
            y0 = Math.min(y0, p.y);
            x1 = Math.max(x1, p.x);
            y1 = Math.max(y1, p.y);
          }
          for (let x = x0 + GRID / 2; x < x1; x += GRID) {
            for (let y = y0 + GRID / 2; y < y1; y += GRID) {
              const at = { x, y };
              if (!pointInPolygon(at, poly)) continue;
              for (const r of rs) poses.push({ at, r });
            }
          }
        }
      }
      for (const p of poses) {
        if (!inRooms(ix, p.at)) continue;
        const item = itemAt(w, p.at, p.r, w.w);
        add(item, hitsOf(ix, item, k));
      }
    }
    out.sort((p, q) => q.score - p.score);
    if (process.env.SOLVE_DEBUG === w.ref) {
      console.log(w.ref, 'anchor', anchorRef, !!anchor, out.slice(0, 5).map((c) => `${c.item.position.x.toFixed(2)},${c.item.position.z.toFixed(2)} r${deg(c.item.rotationY).toFixed(0)} s${c.score.toFixed(2)} ${c.soft}`));
    }
    return out.slice(0, KEEP);
  }

  /** Higher is better: relationships, room to use it, the designer's wishes. */
  function score(
    t: Intent,
    item: Item,
    soft: boolean,
    anchor: Item | undefined,
    anchorRole: Role | undefined,
  ): number {
    const w = t.want;
    const at = centre(item);
    const r = item.rotationY;
    const rel = relationOf(w.kind);
    let s = soft ? -6 : 0;
    // The designer's wishes: their wall, along it, or their spot.
    if (w.face && w.along !== null) {
      const fr = w.face.frame;
      const u = (at.x - fr.a.x) * fr.d.x + (at.y - fr.a.y) * fr.d.y;
      const v = ((at.x - fr.a.x) * fr.n.x + (at.y - fr.a.y) * fr.n.y) * w.face.side;
      if (v > 0 && v < w.d + fr.half + 0.05) s += 1.5 - Math.min(1, Math.abs(u - w.along) * 0.3);
    } else if (w.face) {
      const fr = w.face.frame;
      const v = ((at.x - fr.a.x) * fr.n.x + (at.y - fr.a.y) * fr.n.y) * w.face.side;
      if (v > 0 && v < w.d + fr.half + 0.05) s += 1.5;
    }
    if (w.at) s -= Math.min(2, Math.hypot(at.x - w.at.x, at.y - w.at.y) * 0.4);
    if (t.zone && input.zoneArea(t.zone).some((p) => pointInPolygon(at, p))) s += 2;
    // What it faces.
    if (anchor && rel?.faces && rel.faces.focus.includes(anchorRole as Role)) {
      const off = offAngle(at, r, centre(anchor));
      s -= Math.max(0, off - rel.faces.angle) * 0.2;
      s -= off * 0.01;
    }
    if (anchor && (rel?.near || rel?.belongs)) {
      s -= Math.hypot(at.x - anchor.position.x, at.y - anchor.position.z) * 0.5;
    }
    if (t.faces === 'window') {
      const win = input.ix.windows.find(
        (z) => offAngle(at, r, polyCentre(z.poly)) < 50 && distTo(at, z.poly) < 3,
      );
      if (win) s += 2;
    }
    // A TV or a sofa wants room in front of it; a sofa its back to a wall.
    const role = roleOf(w.kind);
    if (role === 'tv' || role === 'tv-console' || (role === 'sofa' && !anchor)) {
      const front = sideOf(itemFootprint(item, w.kind), 'front');
      const ahead = roomOff(front, 3.5, input.ix.solid.map((x) => x.poly));
      s += Math.min(ahead, 3.5) * 0.6;
    }
    const fp = itemFootprint(item, w.kind);
    const fb = boxOf(fp);
    const hitsBox = (x: { box: { x0: number; y0: number; x1: number; y1: number } }, b = fb) =>
      !(x.box.x1 < b.x0 || b.x1 < x.box.x0 || x.box.y1 < b.y0 || b.y1 < x.box.y0);
    // Off the ways people walk, where it can be: a free piece standing on one costs.
    if (t.against === 'free' && !w.kind.walkThrough && input.ways?.length) {
      if (input.ways.some((x) => hitsBox(x) && overlapDepth(fp, x.poly) > 0.02)) s -= 2.5;
    }
    // A dining table with room on each side for its chairs to be pulled out.
    if (role === 'dining-table') {
      const obstacles = [
        ...input.ix.solid,
        ...input.ix.placed.map((p) => ({ poly: p.fp, box: p.box })),
      ].map((x) => x.poly);
      for (const side of ['front', 'left', 'right'] as const) {
        s += Math.min(roomOff(sideOf(fp, side), 1.0, obstacles), 1.0) * 0.8;
      }
      s += Math.min(roomOff(backSide(fp), 1.0, obstacles), 1.0) * 0.8;
      // Away from doorways.
      const d = Math.min(9, ...input.ix.doorways.map((x) => distTo(at, x.poly)));
      if (d < 1.4) s -= (1.4 - d) * 2;
    }
    // Beds and desks away from the door.
    if ((role === 'bed' || role === 'desk') && input.ix.doorways.length) {
      const d = Math.min(...input.ix.doorways.map((x) => distTo(at, x.poly)));
      s += Math.min(d, 2) * 0.3;
    }
    return s;
  }

  // Greedy, going back a little when a piece has nowhere to go.
  const placed = new Map<string, Item>();
  const chosen: (Candidate | null)[] = [];
  const base = ix.placed.length;
  const marks: number[] = [];
  const put = (i: number, c: Candidate | null) => {
    marks[i] = ix.placed.length;
    chosen[i] = c;
    const t = order[i] as Intent;
    if (c) {
      addToIndex(ix, c.item, t.want.kind);
      placed.set(t.want.ref, c.item);
    }
  };
  const undoTo = (i: number) => {
    ix.placed.length = marks[i] ?? base;
    for (let j = i; j < order.length; j++) {
      placed.delete((order[j] as Intent).want.ref);
      chosen[j] = null;
    }
  };
  for (let i = 0; i < order.length; i++) {
    const t = order[i] as Intent;
    const cs = candidates(t, placed);
    if (cs.length) {
      put(i, cs[0] as Candidate);
      continue;
    }
    // Go back: place one of the two before elsewhere, the ones after it again, then this.
    let done = false;
    for (let j = i - 1; j >= Math.max(0, i - BACK) && !done; j--) {
      const was = chosen.slice(j, i);
      const tj = order[j] as Intent;
      undoTo(j);
      const alts = candidates(tj, placed).slice(1, 1 + ALTS);
      for (const alt of alts) {
        put(j, alt);
        let ok = true;
        for (let m = j + 1; m <= i && ok; m++) {
          const c = candidates(order[m] as Intent, placed)[0];
          if (c) put(m, c);
          else ok = false;
        }
        if (ok) {
          done = true;
          break;
        }
        undoTo(j);
      }
      if (!done) {
        // As it was before going back.
        undoTo(j);
        was.forEach((c, n) => put(j + n, c));
      }
    }
    if (!done) put(i, null);
  }

  const items: Item[] = [];
  order.forEach((t, i) => {
    const c = chosen[i];
    const name = nameOf(t.want.kind);
    const note = (text: string) => ({ text, ref: t.want.ref, itemId: t.want.id });
    if (!c) {
      dropped.push(
        note(
          t.want.brought
            ? `Your ${t.want.w.toFixed(2)} m ${name} doesn’t fit here: no wall or spot in the room has room for it.`
            : `Left out the ${name}: no wall or spot in the room has room for it.`,
        ),
      );
      return;
    }
    if (c.narrowed) {
      const width = t.want.kind.size.w * c.item.scale.x;
      repaired.push(note(`Made the ${name} ${width.toFixed(2)} m to fit the wall.`));
    }
    if (c.soft) {
      repaired.push(note(`The ${name} is short of the room it needs: nowhere in the room has more.`));
    }
    items.push(c.item);
  });
  return { items, repaired, dropped, tries };
}

/** Where chairs go round a table: along its long sides, then at its ends, facing it. */
function chairSlots(table: Item, depth: number): { at: Vec2; r: number }[] {
  const fp = itemFootprint(table);
  const [bl, br, fr, fl] = fp as [Vec2, Vec2, Vec2, Vec2];
  const sides: [Vec2, Vec2][] = [
    [bl, br],
    [fr, fl],
    [br, fr],
    [fl, bl],
  ];
  const len = (s: [Vec2, Vec2]) => Math.hypot(s[1].x - s[0].x, s[1].y - s[0].y);
  const c = centre(table);
  const out: { at: Vec2; r: number }[] = [];
  const long = sides.slice(0, 2).every((s) => len(s) >= len(sides[2] as [Vec2, Vec2]))
    ? [sides[0], sides[1]]
    : [sides[2], sides[3]];
  const short = long[0] === sides[0] ? [sides[2], sides[3]] : [sides[0], sides[1]];
  const along = (s: [Vec2, Vec2], n: number) => {
    const L = len(s);
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const p = { x: s[0].x + (s[1].x - s[0].x) * t, y: s[0].y + (s[1].y - s[0].y) * t };
      const v = { x: p.x - c.x, y: p.y - c.y };
      // Out from the edge: the chair half tucked under.
      const nx = -(s[1].y - s[0].y) / L;
      const ny = (s[1].x - s[0].x) / L;
      const k = nx * v.x + ny * v.y > 0 ? 1 : -1;
      const off = depth / 2 - 0.15;
      const at = { x: p.x + nx * k * off, y: p.y + ny * k * off };
      out.push({ at, r: facing({ x: -nx * k, y: -ny * k }) });
    }
  };
  const per = Math.max(1, Math.min(3, Math.floor(len(long[0] as [Vec2, Vec2]) / 0.58)));
  // Alternate sides, so four chairs at a table for six sit two a side.
  const a: { at: Vec2; r: number }[] = [];
  const b: { at: Vec2; r: number }[] = [];
  along(long[0] as [Vec2, Vec2], per);
  a.push(...out.splice(0));
  along(long[1] as [Vec2, Vec2], per);
  b.push(...out.splice(0));
  for (let i = 0; i < per; i++) {
    if (a[i]) out.push(a[i] as { at: Vec2; r: number });
    if (b[i]) out.push(b[i] as { at: Vec2; r: number });
  }
  for (const s of short) along(s as [Vec2, Vec2], 1);
  return out;
}

/** A footprint's back side, facing out behind. */
function backSide(fp: Vec2[]) {
  const [bl, br, , fl] = fp as [Vec2, Vec2, Vec2, Vec2];
  const width = Math.hypot(bl.x - br.x, bl.y - br.y) || 1;
  const depth = Math.hypot(fl.x - bl.x, fl.y - bl.y) || 1;
  return { a: br, b: bl, n: { x: (bl.x - fl.x) / depth, y: (bl.y - fl.y) / depth }, width };
}

function boxOf(poly: Vec2[]) {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const p of poly) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return { x0, y0, x1, y1 };
}

function polyCentre(p: Vec2[]): Vec2 {
  return p.reduce((a, q) => ({ x: a.x + q.x / p.length, y: a.y + q.y / p.length }), { x: 0, y: 0 });
}

function distTo(p: Vec2, poly: Vec2[]): number {
  if (pointInPolygon(p, poly)) return 0;
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i] as Vec2;
    const b = poly[(i + 1) % poly.length] as Vec2;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L));
    best = Math.min(best, Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)));
  }
  return best;
}
