import { describe, expect, it } from 'vitest';
import { updateWall } from '../commands';
import { furnishedSample } from '../fixtures/furnishedSample';
import { sampleFlatProject } from '../fixtures/sampleFlat';
import { updateItem } from '../furniture';
import { type EditorDoc, dispatch, emptyHistory, undo } from '../history';
import { AFTER_SUFFIX } from '../levels';
import type { Level } from '../schema';
import { acceptDesign, allowedParts, aspectOf } from './accept';
import { aliasesFor } from './aliases';
import {
  SAMPLE_KEYS,
  SPLIT_BEDROOM,
  answer,
  sampleAnswers,
  sampleConcept,
  sampleDesign,
  tanBrief,
  wallOp,
} from './fixtures/sample';
import { bathroomsHeld, handEdits, heldAspects, wallsHeld } from './handEdits';
import { roomStep } from './prompts';
import { designResult } from './result';
import { BATHROOMS, type Concept, type Part } from './schema';
import { roomIdAt, roomsBeside, spaceOfRoom, spacesOf } from './spaces';

const fresh = (level?: Level): EditorDoc => {
  const doc = sampleFlatProject();
  return { doc: level ? { ...doc, levels: [level] } : doc, history: emptyHistory() };
};
const flat = (s: EditorDoc) => s.doc.levels[0] as Level;
const reno = (s: EditorDoc) => s.doc.renovation?.levels[0] as Level;

function allParts(level: Level): Part[] {
  return [
    { aspect: 'walls' },
    ...spacesOf(level).flatMap((s) =>
      (['furniture', 'built-ins', 'finishes', 'electrical'] as const).map((aspect) => ({
        space: s.key,
        aspect,
      })),
    ),
    { space: BATHROOMS, aspect: 'finishes' },
  ];
}

describe('acceptDesign (criterion 19)', () => {
  it('every part: one undo step that starts the renovation; Undo restores the project exactly', () => {
    const s0 = fresh();
    const lvl = flat(s0);
    const r = designResult(lvl, lvl, sampleDesign({ level: lvl }));
    const s1 = dispatch(s0, acceptDesign(lvl.id, r.level, allParts(r.level), { base: lvl }));
    expect(s1.history.past).toHaveLength(1);
    expect(s1.history.past[0]?.label).toBe('Use design');
    const a = reno(s1);
    expect(a.id).toBe(`${lvl.id}${AFTER_SUFFIX}`);
    expect(a.walls).toEqual(r.level.walls);
    expect(a.rooms).toEqual(r.level.rooms);
    expect(a.items).toEqual(r.level.items);
    expect(a.openings).toEqual(r.level.openings);
    // Points in the spaces come; a bathroom's water heater is the bathroom's, not ticked.
    for (const [id, p] of Object.entries(a.points)) expect(r.level.points[id]).toEqual(p);
    expect(Object.keys(a.points).length).toBeGreaterThan(0);
    // The flat as it is didn't change.
    expect(flat(s1)).toEqual(lvl);
    const back = undo(s1);
    expect(back.doc).toEqual(s0.doc);
    expect(back.doc.renovation).toBeUndefined();
  });

  it('only Living and dining’s furniture: only pieces there change', () => {
    const furnished = furnishedSample();
    const s0 = fresh(furnished);
    const r = designResult(furnished, furnished, sampleDesign({ level: furnished }));
    const s1 = dispatch(
      s0,
      acceptDesign(furnished.id, r.level, [{ space: SAMPLE_KEYS.living, aspect: 'furniture' }], {
        base: furnished,
      }),
    );
    const a = reno(s1);
    const spaces = spacesOf(r.level);
    const living = (it: { position: { x: number; z: number } }) =>
      spaceOfRoom(spaces, roomIdAt(r.level, { x: it.position.x, y: it.position.z }))?.key ===
      SAMPLE_KEYS.living;
    for (const it of Object.values(furnished.items)) {
      // Elsewhere, and the built-ins (none here), as they were.
      if (!living(it) || aspectOf(it) !== 'furniture') expect(a.items[it.id]).toEqual(it);
      else expect(a.items[it.id]).toBeUndefined();
    }
    for (const it of Object.values(r.level.items)) {
      if (living(it) && aspectOf(it) === 'furniture') expect(a.items[it.id]).toEqual(it);
      if (!living(it)) expect(a.items[it.id]).toBeUndefined();
    }
    // Walls, rooms and finishes untouched.
    expect(a.walls).toEqual(furnished.walls);
    expect(a.rooms).toEqual(furnished.rooms);
  });

  it('keeps pieces placed by hand since the version was made, unless asked to remove them', () => {
    const base = sampleFlatProject().levels[0] as Level;
    const r = designResult(base, base, sampleDesign({ level: base }));
    const s0 = dispatch(fresh(), acceptDesign(base.id, base, [], { base }));
    const lamp = {
      id: 'it_mine',
      assetId: 'floor-lamp',
      position: { x: 7, y: 0, z: 5 },
      rotationY: 0,
      scale: { x: 1, y: 1, z: 1 },
      flags: { snapWall: false, collidable: true },
    };
    const s1 = dispatch(s0, {
      label: 'add',
      recipe: (d) => {
        (d.renovation?.levels[0] as Level).items[lamp.id] = lamp;
      },
    });
    const part: Part[] = [{ space: SAMPLE_KEYS.living, aspect: 'furniture' }];
    const kept = dispatch(s1, acceptDesign(base.id, r.level, part, { base }));
    expect(reno(kept).items.it_mine).toEqual(lamp);
    const removed = dispatch(
      s1,
      acceptDesign(base.id, r.level, part, { base, removeHandPlaced: true }),
    );
    expect(reno(removed).items.it_mine).toBeUndefined();
  });

  it('a space whose outline depends on the version’s walls takes no furniture without them', () => {
    const lvl = sampleFlatProject().levels[0] as Level;
    const concept: Concept = { ...sampleConcept(), walls: SPLIT_BEDROOM };
    const answers = sampleAnswers();
    const r = designResult(lvl, lvl, sampleDesign({ level: lvl, concept, answers }));
    // The Bedroom, made narrower by the new wall.
    const bedroomSpaces = spacesOf(r.level).filter((s) =>
      s.rooms.some((id) => id === 'rm_bedroom' || !lvl.rooms[id]),
    );
    expect(bedroomSpaces.length).toBeGreaterThan(0);
    const parts: Part[] = [
      ...bedroomSpaces.map((s) => ({ space: s.key, aspect: 'furniture' as const })),
      { space: SAMPLE_KEYS.main, aspect: 'furniture' },
    ];
    expect(allowedParts(lvl, r.level, parts)).toEqual([
      { space: SAMPLE_KEYS.main, aspect: 'furniture' },
    ]);
    const s1 = dispatch(fresh(), acceptDesign(lvl.id, r.level, parts, { base: lvl }));
    const a = reno(s1);
    for (const it of Object.values(a.items)) {
      const room = roomIdAt(r.level, { x: it.position.x, y: it.position.z });
      expect(room).toBe('rm_main-bedroom');
    }
    // With the walls, they come.
    const s2 = dispatch(
      fresh(),
      acceptDesign(lvl.id, r.level, [{ aspect: 'walls' }, ...parts], { base: lvl }),
    );
    expect(Object.keys(reno(s2).items).length).toBeGreaterThan(Object.keys(a.items).length);
  });
});

describe('handEdits (criterion 20)', () => {
  it('after accepting, moving one piece and repainting one face lists exactly those two', () => {
    const s0 = fresh();
    const lvl = flat(s0);
    const r = designResult(lvl, lvl, sampleDesign({ level: lvl }));
    const s1 = dispatch(s0, acceptDesign(lvl.id, r.level, allParts(r.level), { base: lvl }));
    const accepted = reno(s1);
    const sofa = Object.values(accepted.items).find((i) => i.assetId === 'sofa-3')!;
    const al = aliasesFor(lvl);
    const w10 = al.W10 as string;
    const s2 = dispatch(
      dispatch(s1, updateItem(accepted.id, sofa.id, { position: { x: sofa.position.x - 0.4 } })),
      updateWall(accepted.id, w10, { materialRight: 'paint-sky' }),
    );
    const locks = handEdits(accepted, reno(s2));
    expect(locks).toEqual([
      {
        space: SAMPLE_KEYS.living,
        aspect: 'furniture',
        by: 'hand-edit',
        label: '3-seat sofa (moved)',
      },
      {
        space: SAMPLE_KEYS.bedroom,
        aspect: 'finishes',
        by: 'hand-edit',
        label: "Mdm Lim's room wall (repainted)",
      },
    ]);
    expect(handEdits(accepted, accepted)).toEqual([]);
  });

  it('pieces added and removed, floors and walls changed by hand', () => {
    const s0 = fresh();
    const lvl = flat(s0);
    const r = designResult(
      lvl,
      lvl,
      sampleDesign({
        level: lvl,
        answers: {
          [SAMPLE_KEYS.kitchen]: answer([
            { ref: 'f1', assetId: 'fridge', wall: 'W32', along: 0.4 },
          ]),
        },
      }),
    );
    const s1 = dispatch(s0, acceptDesign(lvl.id, r.level, allParts(r.level), { base: lvl }));
    const accepted = reno(s1);
    const fridge = Object.values(accepted.items).find((i) => i.assetId === 'fridge')!;
    const s2 = dispatch(s1, {
      label: 'edits',
      recipe: (d) => {
        const a = d.renovation?.levels[0] as Level;
        delete a.items[fridge.id];
        a.rooms.rm_kitchen!.floorMaterial = 'marble';
      },
    });
    const al = aliasesFor(lvl);
    const s3 = dispatch(s2, updateWall(accepted.id, al.W10 as string, { thickness: 0.2 }));
    const labels = handEdits(accepted, reno(s3)).map((l) => `${l.aspect}: ${l.label}`);
    expect(labels).toEqual([
      'furniture: Fridge (removed)',
      'finishes: Kitchen floor (marble)',
      'walls: Walls and doors (changed)',
    ]);
  });
});

describe('hand-edit locks in the next version (D9, criterion 36)', () => {
  /** V1 accepted whole, then the sofa moved 0.4 m and Mdm Lim's room's wall repainted by hand. */
  function handEdited() {
    const s0 = fresh();
    const lvl = flat(s0);
    const r = designResult(lvl, lvl, sampleDesign({ level: lvl, id: 'dsn_v1' }));
    const s1 = dispatch(s0, acceptDesign(lvl.id, r.level, allParts(r.level), { base: lvl }));
    const accepted = reno(s1);
    const sofa = Object.values(accepted.items).find((i) => i.assetId === 'sofa-3')!;
    const w10 = aliasesFor(lvl).W10 as string;
    const s2 = dispatch(
      dispatch(s1, updateItem(accepted.id, sofa.id, { position: { x: sofa.position.x - 0.4 } })),
      updateWall(accepted.id, w10, { materialRight: 'paint-sky' }),
    );
    const now = reno(s2);
    return { lvl, accepted, now, sofa: now.items[sofa.id]!, w10, locks: handEdits(accepted, now) };
  }
  // The next version, made on After as it is: the same answers, the walls already in After.
  const next = (lvl: Level, locks: ReturnType<typeof handEdits>) => ({
    ...sampleDesign({ level: lvl, id: 'dsn_v3', concept: { ...sampleConcept(lvl), walls: [] } }),
    request: { locks },
  });

  it('keeps the moved sofa where it was moved and the repainted face, and redoes the rest', () => {
    const { lvl, now, sofa, w10, locks } = handEdited();
    const r = designResult(now, lvl, next(lvl, locks));
    expect(r.level.items[sofa.id]).toEqual(sofa);
    expect(Object.values(r.level.items).filter((i) => i.assetId === 'sofa-3')).toHaveLength(1);
    // The living room's furniture is After's, all of it; its built-ins are the version's.
    const living = spacesOf(now).find((s) => s.key === SAMPLE_KEYS.living)!;
    const inLiving = (l: Level) =>
      Object.values(l.items).filter(
        (i) =>
          spaceOfRoom(spacesOf(l), roomIdAt(l, { x: i.position.x, y: i.position.z }))?.key ===
          living.key,
      );
    const furniture = (l: Level) =>
      inLiving(l)
        .filter((i) => aspectOf(i) === 'furniture')
        .map((i) => i.id)
        .sort();
    expect(furniture(r.level)).toEqual(furniture(now));
    expect(
      inLiving(r.level).some((i) => aspectOf(i) === 'built-ins' && i.id.startsWith('it_d')),
    ).toBe(true);
    expect(
      inLiving(r.level)
        .filter((i) => aspectOf(i) === 'built-ins')
        .every((i) => !now.items[i.id]),
    ).toBe(true);
    // The repainted face stays as painted by hand.
    expect(r.level.walls[w10]?.materialRight).toBe('paint-sky');
    // Without the locks, the version's own sofa replaces it.
    const plain = designResult(now, lvl, next(lvl, []));
    expect(plain.level.items[sofa.id]).toBeUndefined();
    expect(plain.level.walls[w10]?.materialRight).not.toBe('paint-sky');
  });

  it('accepting that next version keeps the sofa where it was moved', () => {
    const { lvl, now, sofa, locks } = handEdited();
    const r = designResult(now, lvl, next(lvl, locks));
    const doc = sampleFlatProject();
    const s = dispatch(
      { doc: { ...doc, renovation: { levels: [now] } }, history: emptyHistory() },
      acceptDesign(lvl.id, r.level, allParts(r.level), { base: now }),
    );
    expect(reno(s).items[sofa.id]).toEqual(sofa);
  });

  it('the room step marks the held pieces fixed: in place, and the lock listed', () => {
    const { lvl, now, sofa, locks } = handEdited();
    expect(
      heldAspects(locks, spacesOf(now).find((s) => s.key === SAMPLE_KEYS.living)!.rooms),
    ).toEqual(['furniture']);
    const design = next(lvl, locks);
    const r = designResult(now, lvl, { ...design, spaces: {} });
    const living = r.spaces.find((s) => s.key === SAMPLE_KEYS.living)!;
    const aliases = aliasesFor(r.level, design.aliases);
    const p = roomStep(
      { base: now, before: lvl, brief: design.brief, aliases },
      living,
      r.level,
      aliases,
      { locks },
    );
    expect(p.tail).toContain('3-seat sofa (moved)');
    expect(p.tail).not.toContain('(repainted)');
    const alias = Object.entries(aliases).find(([, id]) => id === sofa.id)?.[0];
    expect(p.tail).toContain(`{"id":"${alias}","kind":"sofa-3"`);
    expect(p.tail).toMatch(
      new RegExp(`"id":"${alias}","kind":"sofa-3","size":\\[[^\\]]*\\],"keep":"in-place"`),
    );
  });

  it('a bathroom repainted and refloored by hand: locked as the bathrooms’, and kept', () => {
    const { lvl, now } = handEdited();
    const bath = Object.values(now.rooms).find((r) => /bath/i.test(r.name))!;
    const wallId = Object.keys(now.walls).find((id) => roomsBeside(now, id).includes(bath.id))!;
    const side = roomsBeside(now, wallId)[0] === bath.id ? 'materialLeft' : 'materialRight';
    const edited = structuredClone(now);
    edited.walls[wallId]![side] = 'paint-blush';
    edited.rooms[bath.id]!.floorMaterial = 'marble';
    const locks = handEdits(now, edited);
    expect(locks.map((l) => [l.space, l.aspect, l.label])).toEqual([
      [BATHROOMS, 'finishes', `${bath.name} wall (repainted)`],
      [BATHROOMS, 'finishes', `${bath.name} floor (marble)`],
    ]);
    expect(bathroomsHeld(locks)).toBe(true);
    const kept = designResult(edited, lvl, next(lvl, locks));
    expect(kept.level.walls[wallId]?.[side]).toBe('paint-blush');
    expect(kept.level.rooms[bath.id]?.floorMaterial).toBe('marble');
    // Without the locks, the concept's bathroom finishes apply again.
    const plain = designResult(edited, lvl, next(lvl, []));
    expect(plain.level.walls[wallId]?.[side]).not.toBe('paint-blush');
    expect(plain.level.rooms[bath.id]?.floorMaterial).not.toBe('marble');
  });

  it('walls changed by hand: the version applies none of its wall changes', () => {
    const { lvl, now } = handEdited();
    const locks = [{ space: '*', aspect: 'walls', by: 'hand-edit', label: 'Walls' }] as const;
    expect(wallsHeld([...locks])).toBe(true);
    const d = { ...sampleDesign({ level: lvl, id: 'dsn_v4' }), request: { locks: [...locks] } };
    const r = designResult(now, lvl, d);
    expect(r.applied).toEqual([]);
    expect(Object.keys(r.level.walls).sort()).toEqual(Object.keys(now.walls).sort());
  });
});

describe('acceptDesign: review fixes', () => {
  it('a brought piece stays unless the space it goes to is ticked', () => {
    const furnished = furnishedSample();
    const fal = aliasesFor(furnished);
    const desk = Object.entries(fal).find(([, id]) => id === 'it_f003')?.[0] as string;
    const brief = tanBrief({ keep: { items: { it_f003: 'bring' }, text: '' } });
    const answers = {
      ...sampleAnswers(),
      [SAMPLE_KEYS.living]: answer([
        { ref: 'desk', assetId: 'desk', keep: desk, wall: 'W12', along: 1.0 },
      ]),
    };
    const r = designResult(furnished, furnished, {
      ...sampleDesign({ level: furnished, brief, answers }),
      aliases: fal,
    });
    expect(r.level.items.it_f003).toBeDefined();
    const bedroomOnly: Part[] = [{ space: SAMPLE_KEYS.bedroom, aspect: 'furniture' }];
    const s1 = dispatch(
      fresh(furnished),
      acceptDesign(furnished.id, r.level, bedroomOnly, { base: furnished }),
    );
    // The desk stays where it was: the living room, where the version puts it, isn't ticked.
    expect(reno(s1).items.it_f003).toEqual(furnished.items.it_f003);
    const both: Part[] = [...bedroomOnly, { space: SAMPLE_KEYS.living, aspect: 'furniture' }];
    const s2 = dispatch(
      fresh(furnished),
      acceptDesign(furnished.id, r.level, both, { base: furnished }),
    );
    expect(reno(s2).items.it_f003).toEqual(r.level.items.it_f003);
  });

  it('pieces an earlier design made are replaced, never kept as placed by hand', () => {
    const s0 = fresh();
    const lvl = flat(s0);
    const a = designResult(lvl, lvl, sampleDesign({ level: lvl, id: 'dsn_a' }));
    const s1 = dispatch(s0, acceptDesign(lvl.id, a.level, allParts(a.level), { base: lvl }));
    // Version B designed on the flat as it is (start: before), accepted into the same After.
    const brief = tanBrief({ start: 'before' });
    const b = designResult(lvl, lvl, sampleDesign({ level: lvl, id: 'dsn_b', brief }));
    const living: Part[] = [{ space: SAMPLE_KEYS.living, aspect: 'furniture' }];
    const s2 = dispatch(s1, acceptDesign(lvl.id, b.level, living, { base: lvl }));
    const sofas = Object.values(reno(s2).items).filter((i) => i.assetId === 'sofa-3');
    expect(sofas.map((i) => i.id)).toEqual(
      Object.values(b.level.items)
        .filter((i) => i.assetId === 'sofa-3')
        .map((i) => i.id),
    );
  });

  it('a space whose doors the version changes needs the walls part', () => {
    const lvl = sampleFlatProject().levels[0] as Level;
    // A door between the two bedrooms: no outline changes, but both rooms' doors do.
    const concept: Concept = {
      ...sampleConcept(),
      walls: [wallOp({ op: 'add_door', wall: 'W5', t: 0.3, width: 0.8 })],
    };
    const r = designResult(lvl, lvl, sampleDesign({ level: lvl, concept }));
    expect(r.applied).toHaveLength(1);
    const parts: Part[] = [
      { space: SAMPLE_KEYS.bedroom, aspect: 'furniture' },
      { space: SAMPLE_KEYS.main, aspect: 'furniture' },
      { space: SAMPLE_KEYS.kitchen, aspect: 'furniture' },
    ];
    expect(allowedParts(lvl, r.level, parts)).toEqual([
      { space: SAMPLE_KEYS.kitchen, aspect: 'furniture' },
    ]);
  });
});
