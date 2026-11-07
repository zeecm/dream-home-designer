import { describe, expect, it } from 'vitest';
import { levelBounds } from '../geometry';
import unsafeConcept from './fixtures/concept-unsafe.json';
import concept from './fixtures/concept.json';
import bedroom from './fixtures/room-bedroom.json';
import kitchen from './fixtures/room-kitchen.json';
import living from './fixtures/room-living.json';
import mainBedroom from './fixtures/room-main-bedroom.json';
import unsafeRoom from './fixtures/room-unsafe.json';
import { parsed, sampleDesign, sampleLevel } from './fixtures/sample';
import { CONCEPT_SCHEMA, SPACE_SCHEMA } from './prompts';
import { Design, LIMITS, defaultBrief, parseConcept, parseSpaceDesign } from './schema';
import { rotationOf } from './util';

const bounds = levelBounds(sampleLevel());

describe('answers (criterion 1)', () => {
  it('every fixture answer parses', () => {
    expect(parseConcept(concept, bounds).ok).toBe(true);
    for (const r of [bedroom, mainBedroom, living, kitchen]) {
      const p = parseSpaceDesign(r, bounds);
      expect(p.ok).toBe(true);
      if (p.ok) expect(p.value.items.length).toBe(r.items.length);
    }
  });

  it('matches enums in any case: "Glass_Wall", "Remove_Wall", "SWING", "ACCENT", "Living"', () => {
    const c = parsed(parseConcept(concept, bounds));
    expect(c.walls[0]?.op).toBe('glass_wall');
    const u = parsed(parseConcept(unsafeConcept, bounds));
    expect(u.walls.map((w) => w.op)).toContain('remove_wall');
    expect(u.walls.find((w) => w.style)?.style).toBe('swing');
    expect(u.style.palette.map((p) => p.use)).toEqual(['walls', 'accent']);
    expect(u.rooms.find((r) => r.room === 'R3')?.use).toBe('living');
    // Hex colours are lower-cased and checked.
    expect(c.style.palette[0]?.hex).toBe('#efe4d2');
  });

  it('cuts over-long text and truncates lists, with a note', () => {
    const r = parseConcept(unsafeConcept, bounds);
    if (!r.ok) throw new Error(r.error);
    expect(r.value.name.length).toBeLessThanOrEqual(LIMITS.name);
    expect(r.value.name.endsWith('…')).toBe(true);
    expect(r.value.reasons).toHaveLength(LIMITS.reasons);
    expect(r.notes).toContain('Some of the designer’s text was too long and has been cut.');
    expect(r.notes).toContain(
      'The designer suggested more reasons than we place; the first 5 are shown.',
    );
    const many = {
      ...living,
      items: Array.from({ length: 50 }, (_, i) => ({ ...living.items[0], ref: `s${i}` })),
    };
    const s = parseSpaceDesign(many, bounds);
    if (!s.ok) throw new Error(s.error);
    expect(s.value.items).toHaveLength(LIMITS.items);
    expect(s.notes).toContain(
      'The designer suggested more pieces than we place; the first 40 are shown.',
    );
  });

  it('leaves out, one by one, entries that are impossible: off the plan, unknown ops, bad colours', () => {
    const r = parseConcept(unsafeConcept, bounds);
    if (!r.ok) throw new Error(r.error);
    // A point a million kilometres away and an unknown op: two of twelve left out.
    expect(r.value.walls).toHaveLength(10);
    expect(r.notes).toContain(
      '2 of the designer’s wall changes couldn’t be used (missing or impossible values).',
    );
    // "green" is not a colour; a room 20 m off the plan isn't a room.
    expect(r.value.style.palette).toHaveLength(2);
    expect(r.value.rooms.map((x) => x.room)).toEqual(['R8', 'R42', 'R3']);
    // Markup stays text (shown through React), cut to the limit.
    expect(r.value.rooms[2]?.name).toBe('Loft <script>alert(1)</script>');

    const s = parseSpaceDesign(unsafeRoom, bounds);
    if (!s.ok) throw new Error(s.error);
    expect(s.value.items.map((i) => i.ref)).not.toContain('far1');
    expect(s.value.items.map((i) => i.ref)).not.toContain('skew1');
    expect(s.value.notes).toHaveLength(LIMITS.roomNotes);
  });

  it('refuses an answer that is not a design at all', () => {
    expect(parseConcept('I would knock down every wall.', bounds).ok).toBe(false);
    expect(parseSpaceDesign({ items: 'a sofa' }, bounds).ok).toBe(false);
    expect(parseConcept({ ...concept, name: undefined }, bounds).ok).toBe(false);
  });

  it('a quarter turn clockwise on the plan is rotationY: front +y at 0, -x at 90', () => {
    expect(rotationOf(0)).toBe(0);
    expect(rotationOf(90)).toBeCloseTo(Math.PI / 2);
    expect(rotationOf(-90)).toBeCloseTo((3 * Math.PI) / 2);
    // An item faces (-sin r, cos r): at 90° clockwise (y down) it faces the plan's left.
    const r = rotationOf(90);
    expect(-Math.sin(r)).toBeCloseTo(-1);
    expect(Math.cos(r)).toBeCloseTo(0);
    const p = parseSpaceDesign(
      { items: [{ ...living.items[1], rotation: 450 }], faces: [], notes: [] },
      bounds,
    );
    expect(p.ok && p.value.items[0]?.rotation).toBe(90);
  });
});

describe('JSON schemas for the model', () => {
  const closed = (s: unknown): void => {
    if (!s || typeof s !== 'object') return;
    const o = s as Record<string, unknown>;
    if (o.type === 'object') {
      expect(o.additionalProperties).toBe(false);
      expect([...(o.required as string[])].sort()).toEqual(
        Object.keys(o.properties as object).sort(),
      );
    }
    for (const v of Object.values(o)) {
      if (Array.isArray(v)) v.forEach(closed);
      else closed(v);
    }
  };
  it('every object is closed with every property required', () => {
    closed(CONCEPT_SCHEMA);
    closed(SPACE_SCHEMA);
  });
});

describe('a stored version', () => {
  it('round-trips through its schema, with no key in it', () => {
    const level = sampleLevel();
    const d = sampleDesign({ level });
    const record: Design = {
      ...d,
      projectId: 'prj_sample',
      levelId: level.id,
      n: 1,
      name: d.concept?.name ?? 'V1',
      parent: null,
      createdAt: '2026-11-06T10:00:00.000Z',
      base: { variant: 'before', fingerprint: 'x' },
      baseLevel: level,
      brief: defaultBrief(),
      request: { scope: { kind: 'all' }, feedback: '', locks: [] },
      usage: [],
      accepted: null,
    };
    const back = Design.parse(JSON.parse(JSON.stringify(record)));
    expect(back).toEqual(record);
    expect(JSON.stringify(back)).not.toMatch(/sk-|api[_-]?key|x-api-key/i);
  });
});

describe('answers by intent (version 2)', () => {
  const b = levelBounds(sampleLevel());
  it('reads v 2 with its relationships, in any case; earlier answers stay without one', () => {
    const r = parsed(
      parseSpaceDesign(
        {
          v: 2,
          items: [
            {
              ...living.items[0],
              wall: null,
              along: null,
              against: 'Free',
              faces: 'tv1',
              near: null,
              zone: 'LOUNGE',
            },
          ],
          faces: [],
          notes: [],
        },
        b,
      ),
    );
    expect(r.v).toBe(2);
    expect(r.items[0]).toMatchObject({ against: 'free', faces: 'tv1', zone: 'lounge' });
    expect(parsed(parseSpaceDesign(living, b)).v).toBeUndefined();
    // A version kept before still reads as it was.
    expect(Design.parse(JSON.parse(JSON.stringify(storedVersion()))).n).toBe(1);
  });
});

function storedVersion() {
  const d = sampleDesign();
  const l = sampleLevel();
  return {
    ...d,
    projectId: 'prj',
    levelId: l.id,
    n: 1,
    name: 'V1',
    parent: null,
    createdAt: '2026-11-01T00:00:00Z',
    base: { variant: 'after', fingerprint: 'x' },
    baseLevel: l,
    brief: (({ sleeping: _s, names: _n, ...old }) => old)(defaultBrief()),
    request: { scope: { kind: 'all' }, feedback: '', locks: [] },
    usage: [],
    accepted: null,
  };
}
