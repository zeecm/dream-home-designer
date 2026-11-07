import { addOpening, drawWall } from '../commands';
import { blankProject } from '../factory';
import { furnitureKind, newItem } from '../furniture';
import { type Command, type EditorDoc, dispatch, emptyHistory } from '../history';
import type { Item, Level, Opening, Wall } from '../schema';

/**
 * Test room R of the elevation spec: a 4 × 3 m room on wall centre lines (0,0)–(4,3), 100 mm
 * walls, a 2.60 m ceiling, the top wall drawn (0,0)→(4,0) (the room on its left), and a 0.90
 * swing door centred on the bottom wall. Walls are drawn round from the top, then `extra`.
 */
export const LID = 'lvl_ground';

export type Seg = [number, number, number, number];

export function walls(
  segs: Seg[],
  opts: (i: number) => Partial<Pick<Wall, 'thickness' | 'side' | 'kind'>> = () => ({}),
): EditorDoc {
  let s: EditorDoc = { doc: blankProject('t', 'prj_t'), history: emptyHistory() };
  const lvl0 = s.doc.levels[0] as Level;
  s = { ...s, doc: { ...s.doc, levels: [{ ...lvl0, ceilingHeight: 2.6 }] } };
  segs.forEach(([ax, ay, bx, by], i) => {
    const lvl = s.doc.levels[0] as Level;
    const o = { thickness: 0.1, ...opts(i) };
    s = dispatch(
      s,
      drawWall(lvl, { point: { x: ax, y: ay } }, { point: { x: bx, y: by } }, o).command,
    );
  });
  return s;
}

export const R_SEGS: Seg[] = [
  [0, 0, 4, 0],
  [4, 0, 4, 3],
  [4, 3, 0, 3],
  [0, 3, 0, 0],
];

export const level = (s: EditorDoc) => s.doc.levels[0] as Level;

export const apply = (s: EditorDoc, ...cmds: Command[]) =>
  cmds.reduce((acc, c) => dispatch(acc, c), s);

/** The wall whose line runs from p to q (either way). */
export function wallAlong(l: Level, p: [number, number], q: [number, number]): string {
  const w = Object.values(l.walls).find((w) => {
    const a = l.vertices[w.a];
    const b = l.vertices[w.b];
    if (!a || !b) return false;
    const on = (v: { x: number; y: number }, r: [number, number]) =>
      Math.hypot(v.x - r[0], v.y - r[1]) < 1e-6;
    return (on(a, p) && on(b, q)) || (on(a, q) && on(b, p));
  });
  if (!w) throw new Error('no wall there');
  return w.id;
}

export const roomId = (l: Level) => Object.keys(l.rooms)[0] as string;

/** An opening on the wall from p to q, centred at `t` along it (from its vertex a). */
export function opening(
  l: Level,
  p: [number, number],
  q: [number, number],
  o: Partial<Omit<Opening, 'id' | 'wallId'>> & Pick<Opening, 'kind'>,
): Command {
  return addOpening(LID, {
    wallId: wallAlong(l, p, q),
    t: 0.5,
    width: 0.9,
    height: 2.1,
    sill: 0,
    ...o,
  }).command;
}

/** Room R with its door. */
export function roomR(extra: Seg[] = []): EditorDoc {
  const s = walls([...R_SEGS, ...extra]);
  return apply(s, opening(level(s), [4, 3], [0, 3], { kind: 'door', swing: 'leftIn' }));
}

/** A piece of `kindId` at plan (x, y), turned `rot`, 2.60 m ceiling for built-ins. */
export function piece(id: string, kindId: string, x: number, y: number, rot = 0): Item {
  const kind = furnitureKind(kindId);
  if (!kind) throw new Error(`no ${kindId}`);
  return newItem(id, kind, { x, y }, rot, 2.6);
}
