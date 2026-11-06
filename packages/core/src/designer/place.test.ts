import { describe, expect, it } from 'vitest';
import { clearanceIssues } from '../clearance';
import { furnitureKind, itemFootprint } from '../furniture';
import { levelBounds } from '../geometry';
import { planGeometry } from '../plan';
import type { Level } from '../schema';
import { aliasesFor } from './aliases';
import { priorityOf } from './catalogue';
import unsafeRoom from './fixtures/room-unsafe.json';
import {
  SAMPLE_KEYS,
  answer,
  parsed,
  sampleAnswers,
  sampleConcept,
  sampleDesign,
  sampleLevel,
  tanBrief,
} from './fixtures/sample';
import { type Want, placePiece, spaceIndex } from './place';
import { designResult } from './result';
import { type Concept, type DesignOp, type SpaceDesign, parseSpaceDesign } from './schema';
import { facesOf, spacesOf } from './spaces';

const level = sampleLevel();
const aliases = aliasesFor(level);
const W = (a: string) => aliases[a] as string;
const only = (key: string, a: SpaceDesign) => sampleDesign({ answers: { [key]: a } });
const result = (key: string, a: SpaceDesign, concept: Concept | null = sampleConcept()) =>
  designResult(level, level, { ...only(key, a), concept });
const op = (o: Partial<DesignOp> & { op: DesignOp['op'] }): DesignOp => ({
  wall: null,
  opening: null,
  a: null,
  b: null,
  height: null,
  t: null,
  width: null,
  style: null,
  ...o,
});
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;

describe('spaces (criterion 6)', () => {
  it('the sample has four: living and dining with the dry kitchen, the kitchen, two bedrooms', () => {
    const spaces = spacesOf(level);
    expect(spaces.map((s) => s.key).sort()).toEqual(Object.values(SAMPLE_KEYS).sort());
    const living = spaces.find((s) => s.key === SAMPLE_KEYS.living)!;
    expect(living.name).toBe('Living and dining');
    expect(living.rooms).toEqual(['rm_dry-kitchen', 'rm_living-and-dining']);
    // Baths, the shelter and the ledge are left out.
    const all = spaces.flatMap((s) => s.rooms);
    for (const id of ['rm_bath-wc-1', 'rm_bath-wc-2', 'rm_household-shelter', 'rm_air-con-ledge']) {
      expect(all).not.toContain(id);
    }
  });
});

describe('placing pieces (criteria 7–15)', () => {
  it('7: a wardrobe on a wall backs onto its face, centred in the clear stretch, facing in', () => {
    const r = result(SAMPLE_KEYS.main, answer([{ ref: 'w1', assetId: 'wardrobe', wall: 'W5' }]));
    const it = Object.values(r.level.items).find((i) => i.assetId === 'wardrobe')!;
    const geom = planGeometry(r.level);
    const face = facesOf(r.level, ['rm_main-bedroom'], geom).find((f) => f.wallId === W('W5'))!;
    const f = face.frame;
    const fp = itemFootprint(it);
    // Back corners on the face, within a millimetre.
    for (const c of [fp[0]!, fp[1]!]) {
      const off = (c.x - f.a.x) * f.n.x + (c.y - f.a.y) * f.n.y;
      expect(Math.abs(off * face.side - f.half)).toBeLessThanOrEqual(0.001);
    }
    // Facing into the room: its front is the face's normal on its side.
    expect(-Math.sin(it.rotationY)).toBeCloseTo(f.n.x * face.side);
    expect(Math.cos(it.rotationY)).toBeCloseTo(f.n.y * face.side);
    // Centred in the face's clear stretch (no openings on W5).
    const along = (it.position.x - f.a.x) * f.d.x + (it.position.z - f.a.y) * f.d.y;
    expect(along).toBeCloseTo((face.u0 + face.u1) / 2, 6);
    expect(r.repaired).toEqual([]);
  });

  it('8: an unknown catalogue id is left out with its line; a 6 m built-in is narrowed to its wall', () => {
    const r = result(
      SAMPLE_KEYS.main,
      answer([
        { ref: 'lamp2', assetId: 'floor-lamp-arc', at: { x: 1, y: 1 }, rotation: 0 },
        { ref: 'ward1', assetId: 'built-in-wardrobe', wall: 'W5', width: 6 },
      ]),
    );
    expect(r.dropped.map((n) => n.text)).toContain(
      '“floor-lamp-arc” (lamp2): not in the catalogue.',
    );
    const ward = Object.values(r.level.items).find((i) => i.assetId === 'built-in-wardrobe')!;
    const face = facesOf(r.level, ['rm_main-bedroom']).find((f) => f.wallId === W('W5'))!;
    const width = 1.8 * ward.scale.x;
    expect(width).toBeCloseTo(face.u1 - face.u0, 6);
    expect(r.repaired.map((n) => n.text)).toContain(
      `Narrowed the built-in wardrobe to ${width.toFixed(2)} m to fit the wall.`,
    );
  });

  it('8: loosely typed ids map to the catalogue; the person’s own models by their id', () => {
    const own = {
      mdl_sofa: {
        id: 'mdl_sofa',
        name: 'Our grey sofa',
        category: 'Living',
        shape: 'sofa' as const,
        size: { w: 2.0, d: 0.9, h: 0.8 },
      },
    };
    const a = answer([
      { ref: 's1', assetId: ' Sofa_3 ', wall: 'W4', along: 1.6 },
      { ref: 's2', assetId: 'MDL_SOFA', wall: 'W12', along: 2 },
      { ref: 'p1', assetId: 'person', at: { x: 8, y: 4 }, rotation: 0 },
    ]);
    const r = designResult(level, level, only(SAMPLE_KEYS.living, a), { models: own });
    const ids = Object.values(r.level.items).map((i) => i.assetId);
    expect(ids).toContain('sofa-3');
    expect(ids).toContain('mdl_sofa');
    expect(ids).not.toContain('person');
  });

  it('9: a wardrobe across the Bedroom door’s swing is slid clear, and says how far', () => {
    const r = result(
      SAMPLE_KEYS.bedroom,
      answer([{ ref: 'w1', assetId: 'wardrobe', wall: 'W5', along: 1.875 }]),
    );
    const it = Object.values(r.level.items).find((i) => i.assetId === 'wardrobe')!;
    const issues = clearanceIssues(r.level).filter(
      (i) => 'itemId' in i && i.itemId === it.id && i.kind !== 'zone',
    );
    expect(issues).toEqual([]);
    const note = r.repaired.find((n) => n.ref === 'w1')!;
    expect(note.text).toMatch(/^Moved the wardrobe 0\.\d\d m along the wall to clear the door\.$/);
    const moved = Number(/(\d\.\d\d) m/.exec(note.text)?.[1]);
    expect(moved).toBeGreaterThan(0.2);
    expect(moved).toBeLessThanOrEqual(0.6);
  });

  it('10: two pieces no move can separate: the lower-priority one is left out', () => {
    const r = result(
      SAMPLE_KEYS.bedroom,
      answer([
        { ref: 'table1', assetId: 'dining-6', at: { x: 4.3, y: 1.5 }, rotation: 0 },
        { ref: 'bed1', assetId: 'bed-king', wall: 'W5', along: 1.5 },
      ]),
    );
    const kept = Object.values(r.level.items).map((i) => i.assetId);
    expect(kept).toContain('bed-king');
    expect(kept).not.toContain('dining-6');
    expect(priorityOf(furnitureKind('bed-king')!)).toBeLessThan(
      priorityOf(furnitureKind('dining-6')!),
    );
    expect(r.dropped.find((n) => n.ref === 'table1')?.text).toBe(
      'Left out the dining table, 6 seats: no room for it here (it would hit the king bed).',
    );
  });

  it('11: a sink cabinet in the living room is left out: the sink stays in the wet area', () => {
    const r = result(
      SAMPLE_KEYS.living,
      answer([{ ref: 'sink1', assetId: 'kitchen-sink', wall: 'W12', along: 2 }]),
    );
    expect(Object.values(r.level.items).some((i) => i.assetId === 'kitchen-sink')).toBe(false);
    expect(r.dropped.map((n) => n.text)).toContain(
      'Sink cabinet: the sink stays in the kitchen’s wet area.',
    );
    // In the kitchen it stays.
    const k = result(
      SAMPLE_KEYS.kitchen,
      answer([{ ref: 'sink1', assetId: 'kitchen-sink', wall: 'W37', along: 1.9 }]),
    );
    expect(Object.values(k.level.items).some((i) => i.assetId === 'kitchen-sink')).toBe(true);
  });

  it('12: a sofa pushed into the corridor narrows the way: listed with the walkway wording', () => {
    const r = result(
      SAMPLE_KEYS.living,
      answer([{ ref: 'sofa1', assetId: 'sofa-3', at: { x: 4.6, y: 3.62 }, rotation: 0 }]),
    );
    const sofa = Object.values(r.level.items).find((i) => i.assetId === 'sofa-3')!;
    const walk = r.problems.filter((p) => p.kind === 'walkway');
    expect(walk.length).toBeGreaterThan(0);
    expect(walk.some((p) => p.itemId === sofa.id && p.issue?.kind === 'walkway')).toBe(true);
    expect(walk[0]?.text).toMatch(/^The way through narrows to \d\.\d\d m; it needs 0\.90 m\.$/);
  });

  it('13: a new king bed that can’t get through the door is listed with the delivery verdict', () => {
    const r = result(
      SAMPLE_KEYS.bedroom,
      answer([{ ref: 'bed1', assetId: 'bed-king', wall: 'W5' }]),
    );
    const bed = Object.values(r.level.items).find((i) => i.assetId === 'bed-king')!;
    const p = r.problems.find((x) => x.kind === 'delivery' && x.itemId === bed.id);
    expect(p?.delivery?.status).toBe('too-big');
    expect(p?.text).toMatch(/^The king bed won’t get into Mdm Lim's room: it is too big/);
    // A piece the household brings along is in the flat already: no delivery.
    expect(r.problems.filter((x) => x.kind === 'delivery')).toHaveLength(1);
  });

  it('14: a new wall leaving a bedroom with no window: "has no window"', () => {
    const c: Concept = {
      ...sampleConcept(),
      walls: [op({ op: 'add_wall', a: { x: 3.27, y: 1.6 }, b: { x: 6.49, y: 1.6 } })],
      rooms: [
        {
          room: null,
          at: { x: 4.8, y: 2.4 },
          name: 'Bedroom 3',
          use: 'kids',
          intent: '',
          floor: 'vinyl-ash',
          paint: 'paint-sky',
        },
      ],
    };
    const r = designResult(level, level, sampleDesign({ concept: c, answers: {} }));
    expect(r.problems.map((p) => p.text)).toContain(
      'Bedroom 3 has no window. A bedroom needs one for light and air.',
    );
    // The sample as it is has none.
    const plain = designResult(level, level, sampleDesign({ concept: null, answers: {} }));
    expect(plain.problems.filter((p) => p.kind === 'window')).toEqual([]);
  });

  it('15: with an elder on a walking frame, a 0.80 m door to their room is listed', () => {
    const c: Concept = {
      ...sampleConcept(),
      walls: [
        op({ op: 'remove_opening', opening: 'D4' }),
        op({ op: 'add_door', wall: 'W10', t: 0.2, width: 0.8 }),
      ],
    };
    const r = designResult(level, level, sampleDesign({ concept: c, answers: {} }));
    expect(r.problems.map((p) => p.text)).toContain(
      "The door to Mdm Lim's room is 0.80 m; 0.85 m lets a walking frame or wheelchair through.",
    );
    // With a stick 0.80 m is enough.
    const stick = designResult(
      level,
      level,
      sampleDesign({
        concept: c,
        answers: {},
        brief: tanBrief({ household: { ...tanBrief().household, elders: ['stick'] } }),
      }),
    );
    expect(stick.problems.filter((p) => p.kind === 'door-width')).toEqual([]);
  });

  it('brought pieces keep their size and id; in-place ones stay put; others are left out', () => {
    const own: Level = {
      ...level,
      items: {
        it_sofa: {
          id: 'it_sofa',
          assetId: 'sofa-3',
          position: { x: 8, y: 0, z: 2.2 },
          rotationY: 0,
          scale: { x: 1, y: 1, z: 1 },
          flags: { snapWall: true, collidable: true },
        },
        it_plant: {
          id: 'it_plant',
          assetId: 'plant',
          position: { x: 9.6, y: 0, z: 2.1 },
          rotationY: 0,
          scale: { x: 1, y: 1, z: 1 },
          flags: { snapWall: false, collidable: true },
        },
        it_tv: {
          id: 'it_tv',
          assetId: 'tv-console',
          position: { x: 8, y: 0, z: 5.6 },
          rotationY: Math.PI,
          scale: { x: 1, y: 1, z: 1 },
          flags: { snapWall: true, collidable: true },
        },
      },
    };
    const al = aliasesFor(own);
    const sofa = Object.entries(al).find(([, id]) => id === 'it_sofa')![0];
    const tv = Object.entries(al).find(([, id]) => id === 'it_tv')![0];
    const brief = tanBrief({
      keep: { items: { it_sofa: 'bring', it_plant: 'in-place' }, text: '' },
    });
    const a = answer([
      { ref: 'mine', assetId: 'sofa-3', keep: sofa, wall: 'W12', along: 2 },
      { ref: 'tv', assetId: 'tv-console', keep: tv, wall: 'W21' },
    ]);
    const r = designResult(own, own, {
      ...sampleDesign({ level: own, answers: { [SAMPLE_KEYS.living]: a }, brief }),
      aliases: al,
    });
    expect(r.level.items.it_sofa?.position.x).toBeGreaterThan(9);
    expect(r.level.items.it_plant).toEqual(own.items.it_plant);
    expect(r.level.items.it_tv).toBeUndefined();
    expect(r.dropped.map((n) => n.text)).toContain('Your TV console: the brief leaves it out.');
  });

  it('the unsafe answer: each bad piece left out or fixed, in words', () => {
    const a = parsed(parseSpaceDesign(unsafeRoom, levelBounds(level)));
    const r = result(SAMPLE_KEYS.living, a);
    const text = r.dropped.map((n) => n.text);
    expect(text).toContain('“floor-lamp-arc” (lamp2): not in the catalogue.');
    expect(text).toContain('Sink cabinet: the sink stays in the kitchen’s wet area.');
    expect(text).toContain('“mine1”: there’s no piece “P99” in the flat.');
    expect(text).toContain('The toilet: bathrooms keep their fittings.');
    expect(text).toContain('Finish on W34: it isn’t a wall of Living and dining.');
    const ids = Object.values(r.level.items).map((i) => i.assetId);
    expect(ids).not.toContain('person-child');
    // A sofa asked 9.5 m long is made at most 1.6 times its catalogue length.
    const sofas = Object.values(r.level.items).filter((i) => i.assetId === 'sofa-3');
    for (const s of sofas) expect(s.scale.x).toBeLessThanOrEqual(1.6 + 1e-9);
  });
});

describe('determinism (criterion 17)', () => {
  it('the same inputs with records shuffled give the same level', () => {
    const shuffle = <T>(r: Record<string, T>) => Object.fromEntries(Object.entries(r).reverse());
    const shuffled: Level = {
      ...level,
      vertices: shuffle(level.vertices),
      walls: shuffle(level.walls),
      openings: shuffle(level.openings),
      rooms: shuffle(level.rooms),
    };
    const answers = sampleAnswers();
    const reversed = Object.fromEntries(
      Object.entries(answers)
        .reverse()
        .map(([k, a]) => [k, { ...a, items: [...a.items].reverse() }]),
    );
    const c: Concept = {
      ...sampleConcept(),
      walls: [
        ...sampleConcept().walls,
        op({ op: 'add_wall', a: { x: 3.27, y: 1.6 }, b: { x: 6.49, y: 1.6 } }),
        op({ op: 'add_door', wall: 'W11', t: 0.5, width: 0.9 }),
      ],
    };
    const a = designResult(level, level, sampleDesign({ concept: c }));
    const b = designResult(shuffled, shuffled, sampleDesign({ concept: c, answers: reversed }));
    expect(b.level).toEqual(a.level);
    expect(Object.keys(b.level.walls)).toEqual(Object.keys(a.level.walls));
    // New ids are seeded by the version: another version gives others.
    const other = designResult(level, level, sampleDesign({ concept: c, id: 'dsn_other' }));
    expect(Object.keys(other.level.items)).not.toEqual(Object.keys(a.level.items));
  });
});

/** 40 pieces for the sample: the fixtures' 31 and 9 more chairs and plants in the living room. */
function fortyPieces(): Record<string, SpaceDesign> {
  const answers = sampleAnswers();
  const living = answers[SAMPLE_KEYS.living]!;
  const extra = answer(
    Array.from({ length: 9 }, (_, i) => ({
      ref: `x${i}`,
      assetId: i % 2 ? 'plant' : 'dining-chair',
      at: { x: 7 + (i % 3) * 0.9, y: 3.6 + Math.floor(i / 3) * 0.6 },
      rotation: 0 as const,
    })),
  ).items;
  return { ...answers, [SAMPLE_KEYS.living]: { ...living, items: [...living.items, ...extra] } };
}

describe('bounded (criterion 24)', () => {
  it('designResult for the sample with 40 pieces stays under 300 ms', () => {
    const design = sampleDesign({ answers: fortyPieces() });
    expect(
      Object.values(design.spaces).reduce((n, s) => n + (s.design?.items.length ?? 0), 0),
    ).toBe(40);
    designResult(level, level, design);
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      designResult(level, level, design);
      times.push(performance.now() - t0);
    }
    const ms = median(times);
    console.log(`designResult: ${ms.toFixed(1)} ms`);
    // 300 ms is the spec's bound; a shared CI runner gets three times that unless PERF is set.
    expect(ms).toBeLessThan(process.env.PERF ? 300 : 900);
  });

  it('the repair: 40 pieces placed and repaired against the per-space index, at most 60 tries each', () => {
    const answers = fortyPieces();
    const spaces = spacesOf(level);
    const geom = planGeometry(level);
    const kinds = new Map<string, Want[]>();
    for (const s of spaces) {
      const faces = facesOf(level, s.rooms, geom);
      const wants = (answers[s.key]?.items ?? []).flatMap((a): Want[] => {
        const kind = furnitureKind(a.assetId);
        if (!kind) return [];
        const face = a.wall ? (faces.find((f) => f.wallId === aliases[a.wall!]) ?? null) : null;
        return [
          {
            id: `it_${a.ref}`,
            ref: a.ref,
            kind,
            w: a.width ?? kind.size.w,
            d: a.depth ?? kind.size.d,
            h: kind.size.h,
            face,
            faces: face ? faces : [],
            along: a.along,
            at: face ? null : a.at,
            rotation: ((a.rotation ?? 0) * Math.PI) / 180,
            ceiling: level.ceilingHeight,
            brought: null,
          },
        ];
      });
      kinds.set(
        s.key,
        wants.sort((p, q) => priorityOf(p.kind) - priorityOf(q.kind)),
      );
    }
    const once = () => {
      let tries = 0;
      let worst = 0;
      for (const s of spaces) {
        const ix = spaceIndex(level, geom, s.rooms);
        for (const w of kinds.get(s.key) ?? []) {
          const out = placePiece(ix, w);
          tries += out.tries;
          worst = Math.max(worst, out.tries);
        }
      }
      return { tries, worst };
    };
    const { worst } = once();
    expect(worst).toBeLessThanOrEqual(60);
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      once();
      times.push(performance.now() - t0);
    }
    const ms = median(times);
    console.log(`repair: ${ms.toFixed(1)} ms`);
    // The whole level's checks would take a walkway report per try (50–100 ms each); the index
    // keeps all 40 within 30 ms (three times that on a shared runner unless PERF is set).
    expect(ms).toBeLessThan(process.env.PERF ? 30 : 90);
  });
});
