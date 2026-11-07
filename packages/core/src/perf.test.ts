import { freeze } from 'immer';
import { describe, expect, it } from 'vitest';
import { ageingReport } from './ageing';
import { wallElevation } from './elevation';
import { roomFaces } from './faces';
import { furnishedSample } from './fixtures/furnishedSample';
import { sampleFlatProject } from './fixtures/sampleFlat';
import { tiledLevel } from './fixtures/tiled';
import { furnitureKind, itemSize, newItem } from './furniture';
import { type Circle, placeLabel } from './geometry';
import { doorSwing, planGeometry, swingZone } from './plan';
import { roomShapes } from './rooms';
import type { Level, Vec2 } from './schema';
import { walkwayReport } from './walkway';

/**
 * Timing, run on its own after the other tests (`pnpm test` runs this file by itself), so the
 * suite's other work doesn't share the machine with it. Walkways (clearance slice 2, W16) and
 * the ageing check (ageing parents AC20) on the sample flat with 40 pieces, each run a drag
 * step (one piece moved a centimetre, so nothing is cached). What ageing adds is bounded
 * against walkways measured in the same run, so a busy runner slows both alike. `PERF=1`
 * applies the spec's laptop bounds.
 */
const PERF = !!process.env.PERF;

function sample40(): { lvl: Level; moved: (k: number) => Level; bedroom?: string } {
  const plain = sampleFlatProject('prj_t').levels[0] as Level;
  // Frozen all through, as the store's levels are (the bare plan is then kept).
  const base = Object.freeze({
    ...plain,
    vertices: Object.freeze(plain.vertices),
    walls: Object.freeze(plain.walls),
    openings: Object.freeze(plain.openings),
    rooms: Object.freeze(plain.rooms),
  });
  const ids = ['wardrobe', 'sofa-3', 'desk', 'bedside', 'armchair', 'dining-chair', 'bookshelf'];
  const items = { ...base.items };
  for (let i = 0; i < 40; i++) {
    const kind = furnitureKind(ids[i % ids.length] as string);
    if (!kind) throw new Error('no kind');
    const at: Vec2 = { x: 0.8 + (i % 8) * 1.1, y: 0.8 + Math.floor(i / 8) * 1.3 };
    const it = newItem(`it_p${i}`, kind, at, 0);
    items[it.id] = it;
  }
  const lvl = Object.freeze({ ...base, items });
  const sofa = Object.values(items).find((it) => it.assetId === 'sofa-3');
  if (!sofa) throw new Error('no sofa');
  const moved = (k: number) =>
    Object.freeze({
      ...lvl,
      items: {
        ...lvl.items,
        [sofa.id]: { ...sofa, position: { ...sofa.position, x: sofa.position.x + k * 0.01 } },
      },
    });
  return {
    lvl,
    moved,
    bedroom: Object.values(base.rooms).find((r) => r.name === 'Main bedroom')?.id,
  };
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;

describe('timing (sample flat, 40 pieces, dragging)', () => {
  it('walkways within the bound; ageing adds at most its share on top', () => {
    const { lvl, moved, bedroom } = sample40();
    walkwayReport(lvl);
    ageingReport(lvl, { profile: 'wheelchair', bedroomId: bedroom });
    const walk: number[] = [];
    const both: number[] = [];
    const alone: number[] = [];
    // Interleaved, so a slow patch of the machine falls on both alike.
    for (let k = 1; k <= 9; k++) {
      const a = moved(2 * k);
      let t0 = performance.now();
      walkwayReport(a);
      walk.push(performance.now() - t0);
      const b = moved(2 * k + 1);
      t0 = performance.now();
      walkwayReport(b);
      ageingReport(b, { profile: 'wheelchair', bedroomId: bedroom });
      both.push(performance.now() - t0);
      // Clearance checks off: ageing alone, building the furnished pass itself.
      const c = moved(100 + k);
      t0 = performance.now();
      ageingReport(c, { profile: 'wheelchair', bedroomId: bedroom });
      alone.push(performance.now() - t0);
    }
    const w = median(walk);
    const added = median(both) - w;
    const a = median(alone);
    console.log(
      `walkways ${w.toFixed(2)} ms; ageing adds ${added.toFixed(2)} ms; ageing alone ${a.toFixed(2)} ms`,
    );
    // Walkways: the spec's 40 ms on a laptop; otherwise only a sanity bound (CI varies).
    expect(w).toBeLessThan(PERF ? 40 : 400);
    // Ageing on top of walkways: at most 15 ms, or the walkways' own time on a slow machine,
    // three times that off a laptop.
    expect(added).toBeLessThan(Math.max(15, w) * (PERF ? 1 : 3));
    // Ageing alone (clearance off) builds the pass walkways would have: at most the pair's time.
    expect(a).toBeLessThan((w + Math.max(15, w)) * (PERF ? 1 : 3));
  });
});

describe('timing (the furnished sample, every wall seen straight on)', () => {
  it('AC17: all faces of every room within 20 ms with caches cold, and less warm', () => {
    const base = furnishedSample();
    const all = (l: Level) => {
      for (const id of Object.keys(l.rooms)) for (const f of roomFaces(l, id)) wallElevation(l, f);
    };
    all(freeze(structuredClone(base), true) as Level);
    const cold: number[] = [];
    const warm: number[] = [];
    for (let k = 0; k < 7; k++) {
      // A fresh frozen level each time, as every edit makes: nothing cached.
      const l = freeze(structuredClone(base), true) as Level;
      let t0 = performance.now();
      all(l);
      cold.push(performance.now() - t0);
      t0 = performance.now();
      all(l);
      warm.push(performance.now() - t0);
    }
    console.log(
      `elevations: cold ${median(cold).toFixed(2)} ms, warm ${median(warm).toFixed(2)} ms`,
    );
    expect(median(cold)).toBeLessThan(20 * (PERF ? 1 : 3));
    expect(median(warm)).toBeLessThan(median(cold) + 1);
  });
});

describe('timing (room labels on a terrace of 8 furnished flats, 72 rooms)', () => {
  // Every room at once, as a new zoom step re-fits them (a drag re-fits only the rooms it
  // changes): about 1.3 s before circlesNear and the nearest-first search, 65 ms after.
  it('placeLabel for every room, clear of every swing and piece in the plan, within 100 ms', () => {
    const level = freeze(tiledLevel(furnishedSample(), 4, 2), true) as Level;
    // As the plan's labels pass them: every door's swing and every piece, plan-wide.
    const avoid: Circle[] = [
      ...planGeometry(level)
        .openings.filter((o) => o.kind === 'door')
        .map((o) => swingZone(doorSwing(o.frame, o.opening))),
      ...Object.values(level.items).map((it) => {
        const { w, d } = itemSize(it);
        return { c: { x: it.position.x, y: it.position.z }, r: Math.hypot(w, d) / 2 };
      }),
    ];
    const shapes = [...roomShapes(level).values()];
    // A name and area at 40 px a metre (a big plan zoomed to fit), 10 cm clear of the walls.
    const half = { x: 0.85, y: 0.6 };
    const all = () => {
      for (const s of shapes) placeLabel(s.outer, half, avoid, s.holes);
    };
    all();
    const times: number[] = [];
    for (let k = 0; k < 7; k++) {
      const t0 = performance.now();
      all();
      times.push(performance.now() - t0);
    }
    const t = median(times);
    console.log(`room labels: ${shapes.length} rooms, ${avoid.length} circles, ${t.toFixed(2)} ms`);
    expect(t).toBeLessThan(100 * (PERF ? 1 : 3));
  });
});
