import { freeze } from 'immer';
import { describe, expect, it } from 'vitest';
import { addOpening, deleteWall, moveVertex, renameRoom, updateWall } from './commands';
import { furnishedSample } from './fixtures/furnishedSample';
import { sampleFlatProject } from './fixtures/sampleFlat';
import { updateItem } from './furniture';
import { type EditorDoc, dispatch, emptyHistory, undo } from './history';
import { applyLayout, lockedWalls } from './layouts';
import { AFTER_SUFFIX } from './levels';
import {
  renovationBreaches,
  renovationChanges,
  renovationGuard,
  startRenovation,
} from './renovation';
import type { Level } from './schema';
import { markStructural, wallStatus, wallStatuses } from './structural';

const sample = () => sampleFlatProject('prj_t');
const fresh = (): EditorDoc => ({ doc: sample(), history: emptyHistory() });
const L = 'lvl_ground';

function renovating(): EditorDoc {
  const s = fresh();
  return dispatch(s, startRenovation());
}
const flat = (s: EditorDoc) => s.doc.levels[0] as Level;
const reno = (s: EditorDoc) => s.doc.renovation?.levels[0] as Level;
const A = () => `${L}${AFTER_SUFFIX}`;

/** A wall of the sample by its status, and one by none. */
function wallOf(level: Level, status: string): string {
  const id = [...wallStatuses(level)].find(([, s]) => s === status)?.[0];
  if (!id) throw new Error(`no ${status} wall`);
  return id;
}
const plainWall = (level: Level) => {
  const w = Object.values(level.walls).find(
    (w) => w.kind !== 'boundary' && wallStatus(level, w.id) === 'none',
  );
  if (!w) throw new Error('no plain wall');
  return w.id;
};

describe('structural and shelter walls', () => {
  it('sample: concrete and shelter walls marked, none left to guess', () => {
    const lvl = sample().levels[0] as Level;
    expect(L).toBe(lvl.id);
    const statuses = [...wallStatuses(lvl).values()];
    expect(statuses).toContain('shelter');
    expect(statuses).toContain('structural');
    expect(statuses).not.toContain('likely');
    for (const w of Object.values(lvl.walls)) {
      if (w.kind === 'boundary') continue;
      expect(w.structural).toBe(w.thickness >= 0.2);
    }
  });

  it('wallStatus: thick and unmarked is likely; marked no is none; shelter whatever the mark', () => {
    const lvl = structuredClone(sample().levels[0] as Level);
    const plain = plainWall(lvl);
    const w = lvl.walls[plain];
    if (!w) throw new Error('no wall');
    w.thickness = 0.3;
    w.structural = undefined;
    expect(wallStatus(lvl, plain)).toBe('likely');
    w.structural = false;
    expect(wallStatus(lvl, plain)).toBe('none');
    const shelter = wallOf(lvl, 'shelter');
    const sw = lvl.walls[shelter];
    if (!sw) throw new Error('no wall');
    sw.structural = false;
    expect(wallStatus(lvl, shelter)).toBe('shelter');
    const boundary = Object.values(lvl.walls).find((x) => x.kind === 'boundary');
    if (boundary) expect(wallStatus(lvl, boundary.id)).toBe('none');
  });

  it('a renovation that hacks or cuts into a shelter wall breaches it; painting does not', () => {
    const s0 = renovating();
    const shelter = wallOf(flat(s0), 'shelter');
    const painted = dispatch(s0, updateWall(A(), shelter, { materialLeft: 'paint-sage' }));
    expect(renovationBreaches(flat(painted), reno(painted)).shelter.size).toBe(0);
    for (const cmd of [
      deleteWall(A(), shelter, reno(s0)),
      updateWall(A(), shelter, { thickness: 0.3 }),
      updateWall(A(), shelter, { build: 'glass' }),
      updateWall(A(), shelter, { height: 1 }),
      addOpening(A(), {
        wallId: shelter,
        kind: 'door',
        t: 0.5,
        width: 0.8,
        height: 2.1,
        sill: 0,
        swing: 'leftIn',
      }).command,
    ]) {
      const s = dispatch(s0, cmd);
      expect(renovationBreaches(flat(s), reno(s)).shelter.has(shelter)).toBe(true);
    }
  });

  it('structural walls changed are breaches to warn about, listed and marked', () => {
    const s0 = renovating();
    const wall = wallOf(flat(s0), 'structural');
    const s = dispatch(s0, deleteWall(A(), wall, reno(s0)));
    const b = renovationBreaches(flat(s), reno(s));
    expect(b.structural.has(wall)).toBe(true);
    expect(b.shelter.size).toBe(0);
    const hacks = renovationChanges(flat(s), reno(s)).filter((c) => c.kind === 'hack');
    expect(hacks.some((c) => c.guard === 'structural')).toBe(true);
    // A plain wall hacked carries no mark.
    const plain = plainWall(flat(s0));
    const p = dispatch(s0, deleteWall(A(), plain, reno(s0)));
    const ph = renovationChanges(flat(p), reno(p)).filter((c) => c.kind === 'hack');
    expect(ph.length).toBeGreaterThan(0);
    expect(ph.every((c) => !c.guard)).toBe(true);
  });

  it('AI layouts can’t change structural or likely walls, but can a wall marked no', () => {
    const lvl = structuredClone(sample().levels[0] as Level);
    const structural = wallOf(lvl, 'structural');
    expect(lockedWalls(lvl).has(structural)).toBe(true);
    const { refused } = applyLayout(lvl, [
      {
        op: 'remove_wall',
        wallId: structural,
        openingId: null,
        a: null,
        b: null,
        height: null,
        t: null,
        width: null,
        style: null,
        at: null,
        name: null,
      },
    ]);
    expect(refused[0]).toMatch(/a structural, outside, shelter or bathroom wall/);
  });

  it('marking is one undo step, in the flat as it is and the renovation alike', () => {
    const s0 = renovating();
    const plain = plainWall(flat(s0));
    const s = dispatch(s0, markStructural([plain], true));
    expect(flat(s).walls[plain]?.structural).toBe(true);
    expect(reno(s).walls[plain]?.structural).toBe(true);
    expect(wallStatus(flat(s), plain)).toBe('structural');
    const u = undo(s);
    expect(flat(u).walls[plain]?.structural).toBe(false);
    expect(reno(u).walls[plain]?.structural).toBe(false);
  });

  it('guard: refuses a new shelter change, warns on a new structural one, else nothing', () => {
    const s0 = renovating();
    const shelter = wallOf(flat(s0), 'shelter');
    const structural = wallOf(flat(s0), 'structural');
    const plain = plainWall(flat(s0));
    const refused = dispatch(s0, deleteWall(A(), shelter, reno(s0)));
    expect(renovationGuard(s0.doc, refused.doc)).toBe('refuse');
    const warned = dispatch(s0, deleteWall(A(), structural, reno(s0)));
    expect(renovationGuard(s0.doc, warned.doc)).toBe('warn');
    // Once warned, another edit isn't warned again.
    const later = dispatch(warned, updateWall(A(), plain, { materialLeft: 'paint-sage' }));
    expect(renovationGuard(warned.doc, later.doc)).toBeNull();
  });

  it('guard: judged on both versions, so a change to the flat as it is is seen', () => {
    // A wall hacked in the renovation; then the room beside it renamed a shelter in the
    // flat as it is (the renovation untouched). The next edit in the renovation, elsewhere,
    // isn't refused: nothing new was changed.
    const s0 = renovating();
    const plain = 'w_bedroom_living-and-dining';
    const s1 = dispatch(s0, deleteWall(A(), plain, reno(s0)));
    const bedroom = Object.values(flat(s1).rooms).find((r) => r.name === 'Bedroom');
    if (!bedroom) throw new Error('no bedroom');
    const s2 = dispatch(s1, renameRoom(L, bedroom.id, 'HS'));
    expect(renovationBreaches(flat(s2), reno(s2)).shelter.has(plain)).toBe(true);
    const other = plainWall(flat(s2));
    const s3 = dispatch(s2, updateWall(A(), other, { materialLeft: 'paint-sage' }));
    expect(renovationGuard(s2.doc, s3.doc)).toBeNull();
  });

  it('marking writes both versions itself, so it is not carried over again', () => {
    expect(markStructural(['x'], true).carry).toBe(false);
  });
});

describe('wallStatuses, kept while the walls stand', () => {
  it('is reused when only furniture moves, and found afresh when a corner does', () => {
    const doc = freeze({ ...sample(), levels: [furnishedSample()] }, true);
    let s: EditorDoc = { doc, history: emptyHistory() };
    const first = wallStatuses(flat(s));
    expect(first.size).toBeGreaterThan(0);
    const piece = Object.values(flat(s).items)[0];
    if (!piece) throw new Error('fixture');
    s = dispatch(s, updateItem(L, piece.id, { position: { x: piece.position.x + 0.2 } }));
    expect(wallStatuses(flat(s))).toBe(first);
    const v = Object.values(flat(s).vertices)[3];
    if (!v) throw new Error('fixture');
    s = dispatch(s, moveVertex(L, v.id, { x: v.x + 0.05, y: v.y }));
    expect(wallStatuses(flat(s))).not.toBe(first);
    // The same as each wall's own status, every time.
    for (const l of [flat(s), sample().levels[0] as Level]) {
      for (const id of Object.keys(l.walls)) {
        expect(wallStatuses(l).get(id) ?? 'none').toBe(wallStatus(l, id));
      }
    }
  });
});
