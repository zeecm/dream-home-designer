import { freeze } from 'immer';
import { afterEach, describe, expect, it } from 'vitest';
import { deleteWall, drawWall, moveVertex, updateRoom } from './commands';
import { TYPICAL_RATES } from './cost';
import { blankProject } from './factory';
import { furnishedSample, withPieces } from './fixtures/furnishedSample';
import { sampleFlatProject } from './fixtures/sampleFlat';
import {
  CATEGORIES,
  FURNITURE,
  type FurnitureKind,
  addItem,
  furnitureKind,
  newItem,
  setProjectModels,
  updateItem,
} from './furniture';
import { type EditorDoc, dispatch, emptyHistory } from './history';
import { AFTER_SUFFIX } from './levels';
import { matchRooms, startRenovation } from './renovation';
import type { Item, Level, Vec2 } from './schema';
import {
  DEFAULT_STORAGE,
  type RoomCtx,
  type StorageReport,
  type StorageSetting,
  householdFromBeds,
  meter,
  meterStatus,
  parseStorageSetting,
  pieceIn,
  shortfallPrice,
  storageGain,
  storageOf,
  storageReport,
  storageRoomOf,
  storageRound,
  storageTargets,
  withRoomPeople,
} from './storage';

const BEDROOM: RoomCtx = { kind: 'bedroom', sleeps: true };
const LIVING: RoomCtx = { kind: 'living', sleeps: false };
const KITCHEN: RoomCtx = { kind: 'kitchen', sleeps: false };

let n = 0;
/** A piece of `kindId` at the origin (built-ins to a 2.6 m ceiling), sized w × d × h if given. */
function piece(kindId: string, size: Partial<{ w: number; d: number; h: number }> = {}): Item {
  const kind = furnitureKind(kindId) as FurnitureKind;
  if (!kind) throw new Error(`no ${kindId}`);
  const it = newItem(`it_${n++}`, kind, { x: 0, y: 0 }, 0, 2.6);
  return {
    ...it,
    scale: {
      x: size.w ? size.w / kind.size.w : it.scale.x,
      y: size.h ? size.h / kind.size.h : it.scale.y,
      z: size.d ? size.d / kind.size.d : it.scale.z,
    },
  };
}

const setting = (patch: Partial<StorageSetting> = {}): StorageSetting => ({
  ...structuredClone(DEFAULT_STORAGE),
  ...patch,
});

/** A w × d room to the walls' centre lines, walls 0.1 m, named; more walls after. */
function room(w: number, d: number, name: string, extra: number[][] = []): EditorDoc {
  let s: EditorDoc = { doc: blankProject('t', 'prj_t'), history: emptyHistory() };
  const segs = [[0, 0, w, 0], [w, 0, w, d], [w, d, 0, d], [0, d, 0, 0], ...extra];
  for (const [ax, ay, bx, by] of segs as [number, number, number, number][]) {
    const lvl = s.doc.levels[0] as Level;
    s = dispatch(
      s,
      drawWall(lvl, { point: { x: ax, y: ay } }, { point: { x: bx, y: by } }, { thickness: 0.1 })
        .command,
    );
  }
  for (const r of Object.values((s.doc.levels[0] as Level).rooms)) {
    s = dispatch(s, updateRoom((s.doc.levels[0] as Level).id, r.id, { name }));
  }
  return s;
}
const lvl = (s: EditorDoc) => s.doc.levels[0] as Level;

/** Adds pieces through the command, as the app does: [kind, centre, rotation, size]. */
function add(
  s: EditorDoc,
  pieces: [string, Vec2, number?, Partial<{ w: number; d: number; h: number }>?][],
  levelId = lvl(s).id,
): EditorDoc {
  let out = s;
  for (const [kindId, at, rot, size] of pieces) {
    const p = piece(kindId, size);
    out = dispatch(
      out,
      addItem(levelId, {
        ...p,
        position: { ...p.position, x: at.x, z: at.y },
        rotationY: rot ?? 0,
      }),
    );
  }
  return out;
}

const roomByName = (r: StorageReport, name: string) => r.rooms.find((x) => x.name === name);
const sampleRoom = (name: string) =>
  Object.values((sampleFlatProject().levels[0] as Level).rooms).find((r) => r.name === name)
    ?.id as string;

// Places in the sample flat (plan metres).
const MAIN = { x: 2.1, y: 1.2 };
const BED2 = { x: 3.78, y: 1.2 };
const LIVING_AT = { x: 8.3, y: 1.85 };
const KITCHEN_AT = { x: 3.65, y: 8.425 };
const DRY_KITCHEN = { x: 5.03, y: 5.2 };

afterEach(() => setProjectModels({}));

describe('what a piece holds (storageOf)', () => {
  it.each<[string, string, Partial<{ w: number; d: number; h: number }>, RoomCtx, object]>([
    // 1.
    [
      'built-in wardrobe 1.80 × 0.60 × 2.60',
      'built-in-wardrobe',
      {},
      BEDROOM,
      { clothes: 1.8, other: 0.54, top: 0.54 },
    ],
    [
      'free-standing wardrobe 1.20 × 0.60 × 2.10',
      'wardrobe',
      {},
      BEDROOM,
      { clothes: 1.2, other: 0 },
    ],
    // 2.
    [
      'the wardrobe 0.45 m deep: half its width',
      'wardrobe',
      { d: 0.45 },
      BEDROOM,
      { clothes: 0.6 },
    ],
    [
      'the wardrobe 1.20 m tall: a cupboard',
      'wardrobe',
      { h: 1.2 },
      BEDROOM,
      { clothes: 0, other: 0.864 },
    ],
    [
      'a free-standing wardrobe 2.4 m tall: top cabinets',
      'wardrobe',
      { h: 2.4 },
      BEDROOM,
      { clothes: 1.2, other: 1.2 * 0.6 * 0.3 },
    ],
    // 4.
    ['shoe cabinet 0.8 × 0.35 × 1.0', 'shoe-cabinet', {}, LIVING, { shoes: 15 }],
    ['full-height shoe cabinet 0.9 × 2.6', 'built-in-shoe-cabinet', {}, LIVING, { shoes: 52 }],
    [
      'the same built-in in a kitchen: a pantry',
      'built-in-shoe-cabinet',
      {},
      KITCHEN,
      { shoes: 0, kitchen: 6.3, pantry: true },
    ],
    [
      'a free-standing shoe cabinet in a kitchen still holds shoes',
      'shoe-cabinet',
      {},
      KITCHEN,
      { shoes: 15, kitchen: 0 },
    ],
    ['a shoe cabinet 0.2 m wide: none', 'shoe-cabinet', { w: 0.2 }, LIVING, { shoes: 0 }],
    // 5.
    [
      'a 2.4 m wall run, 0.7 high',
      'built-in-kitchen-wall',
      {},
      KITCHEN,
      { kitchen: 4.8, cabinets: 2.4 },
    ],
    ['a base cabinet', 'kitchen-base', {}, LIVING, { kitchen: 1.2 }],
    ['a sink cabinet', 'kitchen-sink', {}, KITCHEN, { kitchen: 0.8 }],
    ['a hob cabinet', 'kitchen-hob', {}, KITCHEN, { kitchen: 1.6 }],
    ['a wall cabinet', 'kitchen-wall', {}, KITCHEN, { kitchen: 1.2 }],
    // 6.
    ['bookshelf 0.8 × 0.3 × 1.8', 'bookshelf', {}, LIVING, { other: 0.432 }],
    ['TV console', 'tv-console', {}, LIVING, { other: 0.36 }],
    [
      'steel shelves (a catalogue model)',
      'steel-shelves',
      {},
      LIVING,
      { other: 1.411 * 0.433 * 1.965 },
    ],
  ])('%s', (_name, kindId, size, ctx, want) => {
    const s = storageOf(piece(kindId, size), ctx);
    expect(s).not.toBeNull();
    for (const [k, v] of Object.entries(want)) {
      if (typeof v === 'number') expect(s?.[k as 'clothes'], k).toBeCloseTo(v, 9);
      else expect(s?.[k as 'pantry'], k).toBe(v);
    }
  });

  it('3. a chest of drawers counts half its width (1.201 m wide)', () => {
    expect(storageOf(piece('chest-of-drawers'), BEDROOM)?.clothes).toBeCloseTo(0.6005, 9);
    expect(storageOf(piece('chest-of-drawers', { w: 1.2 }), BEDROOM)?.clothes).toBeCloseTo(0.6, 9);
  });

  it('8. beds, bedsides, desks, the fridge, washer, sofa and vanity hold nothing we count', () => {
    for (const id of [
      'bed-queen',
      'bedside',
      'desk',
      'metal-desk',
      'fridge',
      'washer',
      'sofa-3',
      'vanity',
      'chesterfield-sofa',
      'chinese-console',
    ]) {
      expect(storageOf(piece(id), BEDROOM), id).toBeNull();
    }
  });

  it('8. My furniture: a cabinet is a wardrobe where someone sleeps, else a cupboard; a box nothing', () => {
    setProjectModels({
      mdl_c: {
        id: 'mdl_c',
        name: 'Pax',
        category: 'Storage',
        size: { w: 1, d: 0.6, h: 2 },
        shape: 'cabinet',
      },
      mdl_b: {
        id: 'mdl_b',
        name: 'Crate',
        category: 'Storage',
        size: { w: 1, d: 0.6, h: 2 },
        shape: 'box',
      },
      mdl_s: {
        id: 'mdl_s',
        name: 'Low',
        category: 'Storage',
        size: { w: 1, d: 0.4, h: 2 },
        shape: 'cabinet',
      },
    });
    expect(storageOf(piece('mdl_c'), BEDROOM)).toMatchObject({ clothes: 1, other: 0 });
    expect(storageOf(piece('mdl_c'), LIVING)?.other).toBeCloseTo(1.2, 9);
    // A studio: a living room someone sleeps in.
    expect(storageOf(piece('mdl_c'), { kind: 'living', sleeps: true })?.clothes).toBe(1);
    // Too shallow to hang: a cupboard, even in a bedroom.
    expect(storageOf(piece('mdl_s'), BEDROOM)?.other).toBeCloseTo(0.8, 9);
    expect(storageOf(piece('mdl_b'), BEDROOM)).toBeNull();
  });

  it('8. an uploaded model is not counted, and is listed; a catalogue model is', () => {
    setProjectModels({
      mdl_u: {
        id: 'mdl_u',
        name: 'Ikea Pax',
        category: 'Storage',
        size: { w: 1, d: 0.6, h: 2 },
        hash: 'ab'.repeat(32),
      },
    });
    expect(storageOf(piece('mdl_u'), BEDROOM)).toBeNull();
    const l = withPieces(
      furnishedSample(),
      [
        ['mdl_u', MAIN],
        ['cube-bookcase', LIVING_AT],
      ],
      'it_u',
    );
    const r = storageReport(l, setting());
    expect(r.notCounted).toEqual([{ itemId: 'it_u000', name: 'Ikea Pax' }]);
    expect(pieceIn(r, 'it_u001')?.other).toBeGreaterThan(0);
  });

  it('guard: every storage, built-in and kitchen piece is classed, or knowingly holds nothing', () => {
    const holdsNothing = new Set(['fridge', 'washer']);
    const loose = FURNITURE.filter(
      (k) =>
        ['Storage', 'Built-in', 'Kitchen'].includes(k.category) &&
        !k.storage &&
        !holdsNothing.has(k.id),
    ).map((k) => k.id);
    expect(loose).toEqual([]);
    expect(CATEGORIES).toContain('Storage');
  });
});

describe('the household from the beds', () => {
  it('9. queen and king two adults, single and super single one; by width for your own bed', () => {
    setProjectModels({
      mdl_w: {
        id: 'mdl_w',
        name: 'Wide',
        category: 'Bedroom',
        size: { w: 1.52, d: 2, h: 1 },
        shape: 'bed',
      },
      mdl_n: {
        id: 'mdl_n',
        name: 'Narrow',
        category: 'Bedroom',
        size: { w: 1.07, d: 2, h: 1 },
        shape: 'bed',
      },
    });
    const base = sampleFlatProject().levels[0] as Level;
    const main = sampleRoom('Main bedroom');
    const bed2 = sampleRoom('Bedroom');
    for (const [id, adults] of [
      ['bed-queen', 2],
      ['bed-king', 2],
      ['bed-single', 1],
      ['bed-super-single', 1],
      ['mdl_w', 2],
      ['mdl_n', 1],
    ] as const) {
      const h = householdFromBeds(withPieces(base, [[id, MAIN]]));
      expect(h, id).toEqual({ [main]: { adults, children: 0 } });
    }
    const two = withPieces(base, [
      ['bed-single', { x: 3.6, y: 1.2 }],
      ['bed-single', { x: 4.7, y: 1.2 }],
    ]);
    expect(householdFromBeds(two)).toEqual({ [bed2]: { adults: 2, children: 0 } });
    expect(householdFromBeds(base)).toEqual({});
  });

  it('a queen bed made 0.9 m wide sleeps one', () => {
    const base = sampleFlatProject().levels[0] as Level;
    const l = withPieces(base, [['bed-queen', MAIN, 0, 0.9 / 1.52]]);
    expect(Object.values(householdFromBeds(l))).toEqual([{ adults: 1, children: 0 }]);
  });
});

describe('targets and status', () => {
  it('10. two adults and a child', () => {
    const p = { adults: 2, children: 1 };
    const t = storageTargets(p, 'typical');
    expect(t.clothes).toBeCloseTo(2.6, 9);
    expect(t).toMatchObject({ shoes: 25, kitchen: 12, other: 8 });
    const few = storageTargets(p, 'few');
    expect(few.clothes).toBeCloseTo(1.65, 9);
    expect(few).toMatchObject({ shoes: 17, kitchen: 8.5, other: 4 });
    const lots = storageTargets(p, 'lots');
    expect(lots.clothes).toBeCloseTo(4.5, 9);
    expect(lots).toMatchObject({ shoes: 44, kitchen: 15.5, other: 10 });
    // Everything else by people: 1, 2, 3–4, 5+ (and stops there).
    const other = (adults: number) => storageTargets({ adults, children: 0 }, 'typical').other;
    expect([1, 2, 3, 4, 5, 12].map(other)).toEqual([4, 6, 8, 8, 10, 10]);
    expect(storageTargets({ adults: 0, children: 0 }, 'typical')).toEqual({
      clothes: 0,
      shoes: 0,
      kitchen: 0,
      other: 0,
    });
  });

  it('11. enough at 100%, nearly at 80%, short below; no people, no target or status', () => {
    expect(meterStatus(1, 1)).toBe('enough');
    expect(meterStatus(0.8, 1)).toBe('nearly');
    expect(meterStatus(0.799, 1)).toBe('short');
    expect(meter(1.2)).toEqual({ have: 1.2 });
    expect(meter(0, 2)).toMatchObject({ status: 'none', gap: 2 });
    // 1.2 × 1.5 is 1.7999999999999998: shown 1.80 / 1.80, and enough.
    expect(meter(1.2 * 1.5, 1.8).status).toBe('enough');
  });

  it('12 and defect 2: a shortfall priced as built-in wardrobe; nothing under 0.15 m', () => {
    expect(shortfallPrice(0.8, TYPICAL_RATES)).toEqual({ feet: 3, low: 600, high: 1050 });
    expect(shortfallPrice(0.01, TYPICAL_RATES)).toBeNull();
    expect(shortfallPrice(0.149, TYPICAL_RATES)).toBeNull();
    expect(shortfallPrice(0.15, TYPICAL_RATES)?.feet).toBe(1);
  });

  it('rounds as shown', () => {
    expect(storageRound('clothes', 0.6005)).toBeCloseTo(0.6, 9);
    expect(storageRound('other', 0.432)).toBeCloseTo(0.4, 9);
    expect(storageRound('shoes', 14.6)).toBe(15);
  });
});

describe('the report', () => {
  it('5. the sample kitchen run counts 4.80 m; a base run loses one level with no sink cabinet', () => {
    expect(storageReport(furnishedSample(), setting()).home.kitchen.have).toBeCloseTo(4.8, 9);
    const k = add(room(3, 2, 'Kitchen'), [['built-in-kitchen-base', { x: 1.5, y: 0.36 }]]);
    const run = Object.keys(lvl(k).items)[0] as string;
    expect(pieceIn(storageReport(lvl(k), setting()), run)).toMatchObject({
      kitchen: 4,
      sink: true,
    });
    const withSink = add(k, [['kitchen-sink', { x: 1.5, y: 1.6 }, Math.PI]]);
    const r = storageReport(lvl(withSink), setting());
    expect(pieceIn(r, run)?.kitchen).toBeCloseTo(4.8, 9);
    expect(r.home.kitchen.have).toBeCloseTo(5.6, 9);
  });

  it('defect 3: two base runs (the Kitchen and the Dry kitchen): only the widest loses the sink', () => {
    const l = withPieces(sampleFlatProject().levels[0] as Level, [
      ['built-in-kitchen-base', KITCHEN_AT],
      ['built-in-kitchen-base', DRY_KITCHEN, 0, 0.5],
    ]);
    const r = storageReport(l, setting());
    expect(roomByName(r, 'Kitchen')?.totals.kitchen).toBeCloseTo(4, 9);
    expect(roomByName(r, 'Dry kitchen')?.totals.kitchen).toBeCloseTo(2.4, 9);
    // The chip goes on the kitchen with the most front.
    expect(r.kitchenRoomId).toBe(roomByName(r, 'Kitchen')?.roomId);
    // A run shorter than the sink's level counts nothing, never less.
    const short = withPieces(sampleFlatProject().levels[0] as Level, [
      ['built-in-kitchen-base', KITCHEN_AT, 0, 0.3 / 2.4],
    ]);
    expect(storageReport(short, setting()).home.kitchen.have).toBe(0);
  });

  it('4. a full-height shoe cabinet in the room named Kitchen is a pantry', () => {
    const l = withPieces(sampleFlatProject().levels[0] as Level, [
      ['built-in-shoe-cabinet', KITCHEN_AT],
    ]);
    const r = storageReport(l, setting());
    expect(r.home.shoes.have).toBe(0);
    expect(r.home.kitchen.have).toBeCloseTo(6.3, 9);
  });

  it('7. the shelter, 1 m³ per m² while counted; a store room always, "Storage room" too', () => {
    const shelter = lvl(room(2, 1, 'Household shelter'));
    expect(storageReport(shelter, setting()).home.other.have).toBeCloseTo(2, 9);
    const off = storageReport(shelter, setting({ shelter: false }));
    expect(off.home.other.have).toBe(0);
    expect(off.rooms[0]?.store).toMatchObject({ kind: 'shelter', counted: false });
    for (const name of ['Store', 'Storage room', 'Storeroom']) {
      const store = lvl(room(1.5, 1, name));
      expect(storageReport(store, setting({ shelter: false })).home.other.have, name).toBeCloseTo(
        1.5,
        9,
      );
    }
    expect(storageReport(lvl(room(1.5, 1, 'Restored study')), setting()).rooms).toEqual([]);
  });

  it('12. Main bedroom with a queen bed and a 1.20 m wardrobe: short by 0.80 m', () => {
    const l = withPieces(sampleFlatProject().levels[0] as Level, [
      ['bed-queen', MAIN],
      ['wardrobe', { x: 0.6, y: 1.6 }, -Math.PI / 2],
    ]);
    const main = roomByName(storageReport(l, setting()), 'Main bedroom');
    expect(main?.clothes).toMatchObject({ have: 1.2, target: 2, status: 'short' });
    expect(main?.clothes?.gap).toBeCloseTo(0.8, 9);
    expect(main?.fromBeds).toBe(true);
  });

  it('13. a wardrobe in the living room counts for the home, with no target of its own', () => {
    const l = withPieces(sampleFlatProject().levels[0] as Level, [
      ['bed-queen', MAIN],
      ['wardrobe', { x: 0.6, y: 1.6 }, -Math.PI / 2],
      ['wardrobe', LIVING_AT],
    ]);
    const r = storageReport(l, setting());
    const living = roomByName(r, 'Living and dining');
    expect(living?.clothes).toBeUndefined();
    expect(living?.totals.clothes).toBeCloseTo(1.2, 9);
    expect(r.home.clothes).toMatchObject({ target: 2, status: 'enough' });
    expect(r.home.clothes.have).toBeCloseTo(2.4, 9);
    expect(roomByName(r, 'Main bedroom')?.clothes?.status).toBe('short');
    expect(r.spareClothes).toEqual([{ roomId: living?.roomId, clothes: 1.2 }]);
  });

  it('14. a piece in no room counts for the home only', () => {
    const l = withPieces(sampleFlatProject().levels[0] as Level, [['bookshelf', { x: -5, y: -5 }]]);
    const r = storageReport(l, setting());
    expect(r.outside.map((p) => p.itemId)).toEqual(Object.keys(l.items));
    expect(r.home.other.have).toBeCloseTo(0.432 + 3.39, 2);
    expect(r.rooms.some((x) => x.pieces.length)).toBe(false);
  });

  it('a piece whose centre is in a wall belongs to the room in front of it', () => {
    // The wardrobe's centre 5 cm outside the room's top wall line, facing into it.
    const s = add(room(3, 3, 'Bedroom'), [['wardrobe', { x: 1.5, y: -0.05 }]]);
    const it = Object.values(lvl(s).items)[0] as Item;
    expect(storageRoomOf(lvl(s), it)).toBe(Object.keys(lvl(s).rooms)[0]);
    // Facing away, it is in no room.
    const away = add(room(3, 3, 'Bedroom'), [['wardrobe', { x: 1.5, y: -0.05 }, Math.PI]]);
    expect(storageRoomOf(lvl(away), Object.values(lvl(away).items)[0] as Item)).toBeNull();
  });

  it('15. edited people override the beds for that room only; others add to the home only', () => {
    const l = withPieces(sampleFlatProject().levels[0] as Level, [
      ['bed-queen', MAIN],
      ['bed-single', BED2],
    ]);
    const bed2 = sampleRoom('Bedroom');
    const r = storageReport(
      l,
      setting({
        people: { [bed2]: { adults: 1, children: 1 } },
        others: { adults: 1, children: 0 },
      }),
    );
    expect(roomByName(r, 'Main bedroom')).toMatchObject({ people: { adults: 2 }, fromBeds: true });
    const b = roomByName(r, 'Bedroom');
    expect(b).toMatchObject({ people: { adults: 1, children: 1 }, fromBeds: false });
    expect(b?.clothes?.target).toBeCloseTo(1.6, 9);
    expect(r.people).toEqual({ adults: 4, children: 1 });
    expect(r.home.clothes.target).toBeCloseTo(4.6, 9);
    // A room nobody is in: an edit for a room not on this level is ignored.
    const ghost = storageReport(l, setting({ people: { rm_gone: { adults: 5, children: 0 } } }));
    expect(ghost.people).toEqual({ adults: 3, children: 0 });
  });

  it('16. the furnished sample, Typical, from the beds (reviewed); same level twice, same report', () => {
    const l = furnishedSample();
    const r = storageReport(l, setting());
    const shown = (
      m: { have: number; target?: number; status?: string },
      k: 'clothes' | 'other',
    ) => ({
      have: storageRound(k, m.have).toFixed(2),
      target: m.target,
      status: m.status,
    });
    expect({
      people: r.people,
      clothes: shown(r.home.clothes, 'clothes'),
      shoes: r.home.shoes,
      kitchen: shown(r.home.kitchen, 'clothes'),
      other: shown(r.home.other, 'other'),
      cabinets: r.cabinets.toFixed(2),
      kitchenRoom: r.rooms.find((x) => x.roomId === r.kitchenRoomId)?.name,
      rooms: r.rooms.map((x) => ({
        name: x.name,
        people: `${x.people.adults}+${x.people.children}`,
        fromBeds: x.fromBeds,
        pieces: x.pieces.map((p) => l.items[p.itemId]?.assetId),
        clothes: x.clothes
          ? `${x.clothes.have.toFixed(2)} / ${x.clothes.target?.toFixed(2)} ${x.clothes.status}`
          : null,
        store: x.store ? `${x.store.kind} ${x.store.volume.toFixed(2)}` : null,
      })),
    }).toMatchSnapshot();
    expect(roomByName(r, 'Main bedroom')?.clothes).toMatchObject({
      have: 1.2,
      target: 2,
      status: 'short',
    });
    expect(roomByName(r, 'Bedroom')?.clothes).toMatchObject({ have: 0, target: 1, status: 'none' });
    expect(r.home.shoes).toMatchObject({ have: 0, target: 28 });
    expect(r.home.kitchen).toMatchObject({ target: 12, status: 'short' });
    expect(storageRound('other', r.home.other.have)).toBeCloseTo(3.7, 9);
    expect(r.home.other).toMatchObject({ target: 8, status: 'short' });
    expect(storageReport(l, setting())).toEqual(r);
  });
});

describe('the household setting', () => {
  it('reads leniently: junk is the default, counts clamped to 0–6', () => {
    expect(parseStorageSetting(null)).toEqual(DEFAULT_STORAGE);
    expect(parseStorageSetting('{not json')).toEqual(DEFAULT_STORAGE);
    expect(parseStorageSetting('[1,2]')).toEqual(DEFAULT_STORAGE);
    expect(
      parseStorageSetting(
        JSON.stringify({
          people: { rm_a: { adults: -3, children: 99 }, rm_b: { adults: 'two', children: 1.4 } },
          others: 'many',
          amount: 'heaps',
          shelter: 'yes',
        }),
      ),
    ).toEqual({
      people: { rm_a: { adults: 0, children: 6 }, rm_b: { adults: 0, children: 1 } },
      others: { adults: 0, children: 0 },
      amount: 'typical',
      shelter: true,
    });
    const good = { people: {}, others: { adults: 1, children: 2 }, amount: 'lots', shelter: false };
    expect(parseStorageSetting(JSON.stringify(good))).toEqual(good);
  });
});

describe('rooms someone sleeps in', () => {
  it('a study with a bed, stepped down to nobody, keeps its steppers and its card', () => {
    const s = add(room(3, 3, 'Study'), [['bed-single', { x: 1.5, y: 1.2 }]]);
    const id = Object.keys(lvl(s).rooms)[0] as string;
    const beds = storageReport(lvl(s), setting()).rooms[0];
    expect(beds).toMatchObject({ roomId: id, kind: 'study', sleeps: true, people: { adults: 1 } });
    const none = storageReport(lvl(s), setting({ people: { [id]: { adults: 0, children: 0 } } }));
    expect(none.rooms[0]).toMatchObject({ roomId: id, sleeps: true, fromBeds: false });
    expect(none.rooms[0]?.clothes).toBeUndefined();
    expect(none.people).toEqual({ adults: 0, children: 0 });
    // A study with nobody, no bed and no edit: no card.
    expect(storageReport(lvl(room(3, 3, 'Study')), setting()).rooms).toEqual([]);
  });
});

describe('the caches follow every edit (Commands)', () => {
  /** Two rooms split at x = 2, named Left and Right, and a wardrobe in Left. */
  function two() {
    let s = room(4, 3, 'Bedroom', [[2, 0, 2, 3]]);
    const L = lvl(s);
    for (const r of Object.values(L.rooms)) {
      const left = r.loop.some((v) => (L.vertices[v]?.x ?? 9) < 1);
      s = dispatch(s, updateRoom(L.id, r.id, { name: left ? 'Left bedroom' : 'Right bedroom' }));
    }
    return add(s, [['wardrobe', { x: 1.6, y: 1.5 }]]);
  }
  const clothesIn = (s: EditorDoc, name: string) =>
    storageReport(lvl(s), setting()).rooms.find((r) => r.name === name)?.totals.clothes ?? 0;

  it('a piece moved', () => {
    let s = two();
    expect(clothesIn(s, 'Left bedroom')).toBeCloseTo(1.2, 9);
    const it = Object.values(lvl(s).items)[0] as Item;
    s = dispatch(s, updateItem(lvl(s).id, it.id, { position: { x: 3 } }));
    expect(clothesIn(s, 'Left bedroom')).toBe(0);
    expect(clothesIn(s, 'Right bedroom')).toBeCloseTo(1.2, 9);
  });

  it('a room renamed', () => {
    let s = two();
    const left = Object.values(lvl(s).rooms).find((r) => r.name === 'Left bedroom');
    s = dispatch(s, updateRoom(lvl(s).id, left?.id as string, { name: 'Store' }));
    const r = storageReport(lvl(s), setting());
    expect(r.rooms.find((x) => x.name === 'Store')?.store?.volume).toBeCloseTo(6, 9);
  });

  it('a corner moved', () => {
    let s = two();
    const L = lvl(s);
    for (const v of Object.values(L.vertices).filter((v) => Math.abs(v.x - 2) < 1e-6)) {
      s = dispatch(s, moveVertex(L.id, v.id, { x: 1.4, y: v.y }));
    }
    expect(clothesIn(s, 'Left bedroom')).toBe(0);
    expect(clothesIn(s, 'Right bedroom')).toBeCloseTo(1.2, 9);
  });
});

describe('before and after', () => {
  it('people edited in the flat as it is follow a room hacked and drawn again (matchRooms)', () => {
    // Two rooms, split at x = 2; in the renovation the partition is taken down and drawn again,
    // 0.5 m along, so a room comes back with a new id.
    let s = room(4, 3, 'Bedroom', [[2, 0, 2, 3]]);
    s = dispatch(s, startRenovation());
    const before = lvl(s);
    const afterOf = (d: EditorDoc) => d.doc.renovation?.levels[0] as Level;
    const A = `${before.id}${AFTER_SUFFIX}`;
    const wall = Object.values(afterOf(s).walls).find((w) => {
      const a = afterOf(s).vertices[w.a];
      const b = afterOf(s).vertices[w.b];
      return a && b && Math.abs(a.x - 2) < 1e-6 && Math.abs(b.x - 2) < 1e-6;
    });
    s = dispatch(s, deleteWall(A, wall?.id as string));
    s = dispatch(
      s,
      drawWall(
        afterOf(s),
        { point: { x: 2.5, y: 0 } },
        { point: { x: 2.5, y: 3 } },
        { thickness: 0.1 },
      ).command,
    );
    const after = afterOf(s);
    const match = matchRooms(before, after);
    const renamed = [...match].find(([a, b]) => a !== b);
    expect(renamed).toBeDefined();
    const [afterId, beforeId] = renamed as [string, string];
    const people = { [beforeId]: { adults: 1, children: 1 } };
    const r = storageReport(after, setting({ people }), match);
    expect(r.rooms.find((x) => x.roomId === afterId)).toMatchObject({
      people: { adults: 1, children: 1 },
      fromBeds: false,
    });
    // Without the match, the beds (none).
    expect(storageReport(after, setting({ people })).people).toEqual({ adults: 0, children: 0 });
  });

  it('people edited in the renovation for a room drawn again are kept under its old id', () => {
    let s = room(4, 3, 'Bedroom', [[2, 0, 2, 3]]);
    s = dispatch(s, startRenovation());
    const before = lvl(s);
    const afterOf = (d: EditorDoc) => d.doc.renovation?.levels[0] as Level;
    const A = `${before.id}${AFTER_SUFFIX}`;
    const wall = Object.values(afterOf(s).walls).find((w) => {
      const a = afterOf(s).vertices[w.a];
      const b = afterOf(s).vertices[w.b];
      return a && b && Math.abs(a.x - 2) < 1e-6 && Math.abs(b.x - 2) < 1e-6;
    });
    s = dispatch(s, deleteWall(A, wall?.id as string));
    s = dispatch(
      s,
      drawWall(
        afterOf(s),
        { point: { x: 2.5, y: 0 } },
        { point: { x: 2.5, y: 3 } },
        { thickness: 0.1 },
      ).command,
    );
    const after = afterOf(s);
    const match = matchRooms(before, after);
    const [afterId, beforeId] = [...match].find(([a, b]) => a !== b) as [string, string];
    // An older entry under the After id goes; one for a room long gone is pruned.
    const known = new Set([...Object.keys(before.rooms), ...Object.keys(after.rooms)]);
    const people = withRoomPeople(
      { [afterId]: { adults: 3, children: 0 }, rm_gone: { adults: 1, children: 0 } },
      afterId,
      { adults: 1, children: 2 },
      match,
      known,
    );
    expect(people).toEqual({ [beforeId]: { adults: 1, children: 2 } });
    // Before reads it, and so does After through the match.
    expect(
      storageReport(before, setting({ people })).rooms.find((r) => r.roomId === beforeId),
    ).toMatchObject({ people: { adults: 1, children: 2 }, fromBeds: false });
    expect(
      storageReport(after, setting({ people }), match).rooms.find((r) => r.roomId === afterId),
    ).toMatchObject({ people: { adults: 1, children: 2 } });
    // Back to the beds: the entry goes.
    expect(withRoomPeople(people, afterId, null, match, known)).toEqual({});
    // Unmatched rooms keep their own id.
    expect(withRoomPeople({}, 'rm_x', { adults: 1, children: 0 })).toEqual({
      rm_x: { adults: 1, children: 0 },
    });
  });

  it('what the renovation adds, room by room', () => {
    let s: EditorDoc = { doc: sampleFlatProject(), history: emptyHistory() };
    s = dispatch(s, startRenovation());
    const before = lvl(s);
    const A = `${before.id}${AFTER_SUFFIX}`;
    s = add(s, [['built-in-wardrobe', MAIN]], A);
    const after = s.doc.renovation?.levels[0] as Level;
    const match = matchRooms(before, after);
    const gain = storageGain(
      storageReport(before, setting()),
      storageReport(after, setting()),
      match,
    );
    expect(gain.get(sampleRoom('Main bedroom'))?.clothes).toBeCloseTo(1.8, 9);
  });
});

describe('speed', () => {
  it('re-running the report after one piece moves takes well under 1 ms (50 pieces)', () => {
    const kinds = ['wardrobe', 'bookshelf', 'kitchen-base', 'shoe-cabinet', 'bed-single', 'sofa-3'];
    const spots = [MAIN, BED2, LIVING_AT, KITCHEN_AT, DRY_KITCHEN];
    const pieces: [string, Vec2][] = [];
    for (let i = 0; i < 50; i++) {
      const at = spots[i % spots.length] as Vec2;
      pieces.push([kinds[i % kinds.length] as string, { x: at.x + (i % 3) * 0.05, y: at.y }]);
    }
    let l = freeze(withPieces(furnishedSample(), pieces, 'it_p'), true);
    storageReport(l, setting());
    const times: number[] = [];
    for (let k = 0; k < 30; k++) {
      // A drag's move: a new level and a new item, the walls and rooms shared.
      const id = 'it_p000';
      const it = l.items[id] as Item;
      l = freeze(
        {
          ...l,
          items: {
            ...l.items,
            [id]: { ...it, position: { ...it.position, x: it.position.x + 0.01 } },
          },
        },
        true,
      );
      const t0 = performance.now();
      storageReport(l, setting());
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    expect(times[Math.floor(times.length / 2)]).toBeLessThan(1);
  });
});
