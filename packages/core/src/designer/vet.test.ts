import { describe, expect, it } from 'vitest';
import type { Level } from '../schema';
import owner from './fixtures/owner-v4.json';
import { designResult } from './result';
import { type Concept, type DesignBrief, parseConcept } from './schema';
import { roomsBeside, spacesOf } from './spaces';
import { vetConcept } from './vet';

/**
 * Room vetting (spec docs/specs/designer-listens.md §4, criteria 20 and 21): the owner's V4
 * layout, exactly as the model answered it, and renames of a room where someone sleeps.
 */

const level = owner.level as unknown as Level;
const brief = owner.brief as unknown as DesignBrief;
const aliases = owner.aliases as Record<string, string>;
const concept = (raw: unknown = owner.concept): Concept => {
  const r = parseConcept(raw, null);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const place = (c: Concept, b: DesignBrief = brief) =>
  designResult(level, level, { id: owner.designId, brief: b, aliases, concept: c, spaces: {} });
const vet = (c: Concept, b: DesignBrief = brief) =>
  vetConcept(c, level, level, b, aliases, owner.designId);

describe('criterion 20: the owner’s V4 layout', () => {
  it('as answered, the couple’s room comes out “Living & Study”, a living use', () => {
    const r = place(concept());
    const main = r.spaces.find((s) => s.rooms.includes('rm_main-bedroom'));
    expect([main?.name, main?.use]).toEqual(['Living & Study', 'living']);
  });

  it('vetted: the walls to the living room stay, Main bedroom keeps a sleeping use', () => {
    const v = vet(concept());
    expect(v.refused.sort()).toEqual([
      'w_bedroom_living-and-dining',
      'w_bedroom_living-and-dining-3',
    ]);
    expect(v.lines).toEqual([
      'Kept the walls between Bedroom and Living and dining: taking them out would join the room You and Partner sleep in to the living room.',
    ]);
    const r = place(v.concept);
    const main = r.spaces.find((s) => s.rooms.includes('rm_main-bedroom'));
    expect(main?.use).toBe('master');
    expect(main?.name).toBe('Master Bedroom');
    // The bigger master bedroom still goes through: the wall to Bedroom comes out.
    expect(r.applied.map((n) => n.text)).toEqual([
      'Hack the wall between Main bedroom and Bedroom',
    ]);
    // Nobody sleeps in a living space, and no "doesn't belong" for a bed there.
    const living = r.spaces.find((s) => s.rooms.includes('rm_living-and-dining'));
    expect(living?.rooms).not.toContain('rm_main-bedroom');
    expect(r.checks.some((c) => /doesn’t belong/.test(c.text))).toBe(false);
    // The walls left make no room without a door.
    const doors = Object.values(r.level.openings).filter((o) => o.kind === 'door');
    for (const s of spacesOf(r.level)) {
      const door = doors.some((d) =>
        roomsBeside(r.level, d.wallId).some((id) => !!id && s.rooms.includes(id)),
      );
      expect([s.key, door]).toEqual([s.key, true]);
    }
    // Its add_wall ops at x = 4.5 stay in the concept (the app refuses them on its own).
    expect(v.concept.walls.filter((w) => w.op === 'add_wall').length).toBe(2);
  });

  it('a concept with nothing to vet is the same object', () => {
    const c = concept({ ...owner.concept, walls: [] });
    const plain = {
      ...c,
      rooms: c.rooms.filter((r) => r.name !== 'Living & Study'),
    };
    const v = vet(plain);
    expect(v.concept).toBe(plain);
    expect(v.lines).toEqual([]);
  });

  it('nobody sleeping anywhere: nothing is vetted', () => {
    const c = concept();
    const v = vet(c, { ...brief, sleeping: {} });
    expect(v.concept).toBe(c);
  });
});

describe('criterion 21: a room where someone sleeps stays a bedroom', () => {
  const study = () =>
    concept({
      ...owner.concept,
      walls: [],
      rooms: [
        {
          room: 'R2',
          at: null,
          name: 'Study',
          use: 'study',
          intent: '',
          floor: 'wood-oak',
          paint: 'paint-white',
        },
      ],
    });

  it('a rename to “Study” keeps the old name and use, with the line', () => {
    const v = vet(study());
    expect(v.concept.rooms[0]).toMatchObject({ name: 'Main bedroom', use: 'master' });
    expect(v.lines).toEqual([
      'Main bedroom stays a bedroom: You and Partner sleep there. To make it a study, change who sleeps where.',
    ]);
    const r = place(v.concept);
    expect(r.uses['rm_main-bedroom']).toBe('master');
  });

  it('a name that still reads as a bedroom is kept, its use made a sleeping one', () => {
    const c = concept({
      ...owner.concept,
      walls: [],
      rooms: [{ ...study().rooms[0], name: 'Main bedroom & study', use: 'study' }],
    });
    const v = vet(c);
    expect(v.concept.rooms[0]).toMatchObject({ name: 'Main bedroom & study', use: 'master' });
  });

  it('once who sleeps where moves them, the same rename goes through', () => {
    const moved = { ...brief, sleeping: { rm_bedroom: ['adult-1', 'adult-2'] } };
    const c = study();
    const v = vet(c, moved);
    expect(v.concept).toBe(c);
    expect(v.lines).toEqual([]);
  });

  it('two bedrooms joined into one: allowed, and named as one', () => {
    const c = concept({
      ...owner.concept,
      walls: [owner.concept.walls[0]],
      rooms: [
        { ...study().rooms[0], room: 'R2', name: 'Master suite', use: 'master' },
        { ...study().rooms[0], room: null, at: { x: 2, y: 2 }, name: 'Walk-in', use: 'walk-in' },
      ],
    });
    const v = vet(c);
    expect(v.refused).toEqual([]);
    expect(v.concept.rooms.map((r) => [r.name, r.use])).toEqual([
      ['Master suite', 'master'],
      ['Master suite', 'master'],
    ]);
    expect(v.lines).toEqual([
      '“Master suite” and “Walk-in” are one room after the wall changes: it’s Master suite.',
    ]);
  });
});
