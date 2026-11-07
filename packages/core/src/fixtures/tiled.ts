import type { Level } from '../schema';

/**
 * A big plan for timing: `cols` × `rows` copies of `base` (the furnished sample, say) side by
 * side, `pitch` metres apart, every id given the copy's prefix (`t3_`). Copies don't touch,
 * so each keeps its own rooms; the result is as a long terrace of flats on one level.
 */
export function tiledLevel(base: Level, cols: number, rows: number, pitch = 12): Level {
  const out: Level = {
    ...base,
    vertices: {},
    walls: {},
    openings: {},
    rooms: {},
    items: {},
    lights: {},
    points: {},
  };
  for (let k = 0; k < cols * rows; k++) {
    const p = (id: string) => `t${k}_${id}`;
    const dx = (k % cols) * pitch;
    const dy = Math.floor(k / cols) * pitch;
    for (const v of Object.values(base.vertices)) {
      out.vertices[p(v.id)] = { ...v, id: p(v.id), x: v.x + dx, y: v.y + dy };
    }
    for (const w of Object.values(base.walls)) {
      out.walls[p(w.id)] = { ...w, id: p(w.id), a: p(w.a), b: p(w.b) };
    }
    for (const o of Object.values(base.openings)) {
      out.openings[p(o.id)] = { ...o, id: p(o.id), wallId: p(o.wallId) };
    }
    for (const r of Object.values(base.rooms)) {
      out.rooms[p(r.id)] = { ...r, id: p(r.id), loop: r.loop.map(p) };
    }
    for (const it of Object.values(base.items)) {
      out.items[p(it.id)] = {
        ...it,
        id: p(it.id),
        position: { ...it.position, x: it.position.x + dx, z: it.position.z + dy },
        ...(it.parent ? { parent: p(it.parent) } : {}),
      };
    }
    for (const l of Object.values(base.lights)) {
      out.lights[p(l.id)] = {
        ...l,
        id: p(l.id),
        position: { ...l.position, x: l.position.x + dx, z: l.position.z + dy },
        ...(l.itemId ? { itemId: p(l.itemId) } : {}),
      };
    }
    for (const pt of Object.values(base.points ?? {})) {
      out.points[p(pt.id)] = {
        ...pt,
        id: p(pt.id),
        ...(pt.wall ? { wall: { ...pt.wall, wallId: p(pt.wall.wallId) } } : {}),
        ...(pt.at ? { at: { x: pt.at.x + dx, y: pt.at.y + dy } } : {}),
        ...(pt.compressorId ? { compressorId: p(pt.compressorId) } : {}),
        ...(pt.route ? { route: pt.route.map((q) => ({ x: q.x + dx, y: q.y + dy })) } : {}),
      };
    }
  }
  return out;
}
