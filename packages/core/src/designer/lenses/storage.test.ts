import { describe, expect, it } from 'vitest';
import { furnishedSample, withPieces } from '../../fixtures/furnishedSample';
import { furnitureKind, itemSize } from '../../furniture';
import { levelBounds } from '../../geometry';
import type { Level } from '../../schema';
import { DEFAULT_STORAGE, type StorageSetting, storageReport } from '../../storage';
import { aliasesFor } from '../aliases';
import { ONGS } from '../benchmark/benchmark';
import { SAMPLE_KEYS, parsed, sampleAnswers, sampleDesign, sampleLevel } from '../fixtures/sample';
import { roleOf } from '../principles';
import { roomStep } from '../prompts';
import { type DesignOptions, designResult } from '../result';
import { type DesignBrief, type SpaceDesign, defaultBrief, parseSpaceDesign } from '../schema';
import { Rule } from '../rules/schema';
import { dropPriorityOf } from '../solve';
import { spacesOf } from '../spaces';
import { lensReports, steerFor } from './index';
import { mergeSteers, steerOnly } from './lens';
import {
  householdEdited,
  storageBlock,
  storageLens,
  storageLine,
  storageSettingFor,
} from './storage';

/**
 * The storage lens (tech 3b §4): measured for the designer's household, a card line and what
 * a version adds, the block room steps are told, and the solver's weights. It never gates.
 */
const level = sampleLevel();
const b = levelBounds(level);
const aliases = aliasesFor(level);
const MAIN = 'rm_main-bedroom';
const BED = 'rm_bedroom';

const item = (o: Record<string, unknown>) => ({
  keep: null,
  wall: null,
  along: null,
  at: null,
  rotation: null,
  width: null,
  depth: null,
  height: null,
  why: '',
  against: 'wall',
  faces: null,
  near: null,
  zone: null,
  ...o,
});
const answerOf = (items: Record<string, unknown>[]): SpaceDesign =>
  parsed(parseSpaceDesign({ v: 2, items: items.map(item), faces: [], notes: [] }, b));
const place = (
  answers: Record<string, SpaceDesign>,
  opts: DesignOptions = {},
  brief: DesignBrief = ONGS,
  id = 'dsn_lens',
) =>
  designResult(
    level,
    level,
    { ...sampleDesign({ answers, brief, concept: null, id }), aliases },
    opts,
  );
const placedRefs = (r: ReturnType<typeof place>) =>
  Object.values(r.level.items)
    .filter((it) => r.refs[it.id])
    .map((it) => r.refs[it.id] as string)
    .sort();

describe('the storage lens: whose household', () => {
  it('measures for who sleeps where in the brief', () => {
    const h = storageSettingFor(level, ONGS);
    expect(h.from).toBe('brief');
    expect(h.setting.people[MAIN]).toEqual({ adults: 2, children: 0 });
    // Mdm Koh counts as an adult, Sophie as a child.
    expect(h.setting.people[BED]).toEqual({ adults: 1, children: 1 });
    expect(h.setting.others).toEqual({ adults: 0, children: 0 });
    expect(storageReport(level, h.setting).people).toEqual({ adults: 3, children: 1 });
  });

  it('the storage meter’s own household wins once the person set it there', () => {
    const meter: StorageSetting = {
      ...DEFAULT_STORAGE,
      people: { [BED]: { adults: 0, children: 2 } },
    };
    const h = storageSettingFor(level, ONGS, meter);
    expect(h.from).toBe('meter');
    expect(h.setting.people).toEqual(meter.people);
  });

  it('how much they own is one value with the meter’s, and never hands it the household', () => {
    const lots: StorageSetting = { ...DEFAULT_STORAGE, amount: 'lots' };
    expect(householdEdited(lots)).toBe(false);
    const fromMeter = storageSettingFor(level, ONGS, lots);
    expect(fromMeter.from).toBe('brief');
    expect(fromMeter.setting.amount).toBe('lots');
    // The meter's is the live value (a card's brief may be older); with no meter, the brief's.
    expect(storageSettingFor(level, { ...ONGS, owns: 'few' }, lots).setting.amount).toBe('lots');
    expect(storageSettingFor(level, { ...ONGS, owns: 'few' }).setting.amount).toBe('few');
    expect(storageSettingFor(level, ONGS).setting.amount).toBe('typical');
  });

  it('assumes as the checks do when the brief says nothing; a helper with no room lives here too', () => {
    const brief: DesignBrief = {
      ...defaultBrief(),
      household: { ...defaultBrief().household, adults: 2, helper: true },
    };
    const h = storageSettingFor(level, brief);
    // Two adults in the largest bedroom.
    expect(h.setting.people[MAIN]).toEqual({ adults: 2, children: 0 });
    expect(h.setting.others).toEqual({ adults: 1, children: 0 });
  });

  it('a bed drawn outside a bedroom adds no one the brief doesn’t say', () => {
    const withBed = withPieces(level, [['bed-single', { x: 8.6, y: 2.4 }]]);
    const h = storageSettingFor(withBed, ONGS);
    expect(storageReport(withBed, h.setting).people).toEqual({ adults: 3, children: 1 });
  });
});

describe('the storage lens: the card line', () => {
  it('says what is short, what is met, and what the version adds', () => {
    const setting = storageSettingFor(level, ONGS).setting;
    const was = storageReport(level, setting);
    const furnished = furnishedSample();
    const now = storageReport(furnished, storageSettingFor(furnished, ONGS).setting);
    const { line, short, delta } = storageLine(was, now, ['clothes', 'kitchen']);
    // The furnished sample's 1.20 m wardrobe against 2.0 + 1.6 m for the Ongs; its kitchen
    // run against 6 m and 2 m a person.
    expect(line).toBe(
      'clothes 1.2 of 3.6 m, short 2.4 m · kitchen 4.8 of 14.0 m, short 9.2 m · +1.2 m hanging · +4.8 m of kitchen',
    );
    expect(short).toBe(true);
    expect(delta).toBe('+1.2 m hanging · +4.8 m of kitchen');
    // A measure with nothing drawn for it is short by all of it.
    expect(storageLine(now, now, ['shoes']).line).toMatch(
      /^shoes \d+ of \d+ pairs, short \d+ pairs$/,
    );
  });

  it('a version on the sample: a lens line for its rooms, never a check', () => {
    const answers = sampleAnswers(level);
    const r = place({ [SAMPLE_KEYS.main]: answers[SAMPLE_KEYS.main] as SpaceDesign });
    const [rep] = lensReports(r, level, ONGS);
    expect(rep?.id).toBe('storage');
    expect(rep?.title).toBe('Storage');
    // A bedroom proposal is about clothes.
    expect(rep?.line).toMatch(
      /^clothes \d+\.\d of \d+\.\d m(, short \d+\.\d m)? · \+\d+\.\d m hanging$/,
    );
    expect(rep?.delta).toMatch(/^\+\d+\.\d m hanging$/);
    // Its own bedroom's clothes: for the two who sleep there, not the whole home's.
    expect(rep?.line).toMatch(/^clothes \d\.\d of 2\.0 m/);
    expect(rep?.lines.at(-1)?.text).toBe(
      'Measured for 3 adults and 1 child, from who sleeps where.',
    );
    expect(rep?.lines.some((l) => l.roomId === MAIN)).toBe(true);
    expect(rep?.score.overall).toBeGreaterThan(0);
    expect(rep?.score.overall).toBeLessThanOrEqual(1);
    // Lenses off: no report.
    expect(lensReports(r, level, ONGS, { lenses: [] })).toEqual([]);
  });

  it('moves with how much they own, with no request: a result per setting', () => {
    const answers = { [SAMPLE_KEYS.main]: sampleAnswers(level)[SAMPLE_KEYS.main] as SpaceDesign };
    const few = place(answers, { storage: { ...DEFAULT_STORAGE, amount: 'few' } });
    const lots = place(answers, { storage: { ...DEFAULT_STORAGE, amount: 'lots' } });
    const opts = (amount: StorageSetting['amount']) => ({
      storage: { ...DEFAULT_STORAGE, amount },
    });
    const a = storageLens.report({ result: few, start: level, brief: ONGS, opts: opts('few') });
    const c = storageLens.report({ result: lots, start: level, brief: ONGS, opts: opts('lots') });
    expect(a.line).not.toBe(c.line);
    expect(c.tone).toBe('short');
  });
});

describe('the storage lens: what room steps are told', () => {
  it('a bedroom’s clothes for who sleeps there, as data in the tail', () => {
    const space = spacesOf(level).find((s) => s.key === BED);
    expect(space).toBeDefined();
    if (!space) return;
    const block = storageBlock(level, space, ONGS, undefined, (id) => id);
    expect(block).toContain('(data;');
    expect(block).toContain(
      '"rooms":[{"room":"rm_bedroom","clothes":{"need":1.6,"now":0,"unit":"m"}}]',
    );
    const ctx = { base: level, before: level, brief: ONGS, aliases };
    const step = roomStep(ctx, space, level, aliases);
    expect(step.tail).toContain('Storage the household needs');
    expect(step.tail).toContain('"room":"R1"');
    // The prefix every step shares stays the same bytes.
    expect(roomStep(ctx, space, level, aliases, { storage: false }).prefix).toBe(step.prefix);
    expect(roomStep(ctx, space, level, aliases, { storage: false }).tail).not.toContain(
      'Storage the household needs',
    );
  });

  it('a living room hears the home’s shoes and everything else', () => {
    const space = spacesOf(level).find((s) => s.key === SAMPLE_KEYS.living);
    if (!space) throw new Error('no living room');
    const block = storageBlock(level, space, ONGS, undefined, (id) => id);
    expect(block).toContain('"shoes":{"need":');
    expect(block).toContain('"other":{"need":');
    expect(block).not.toContain('"clothes"');
  });
});

describe('the storage lens: the solver’s weights', () => {
  it('a short bedroom protects and prefers its storage; a full one asks nothing', () => {
    const space = spacesOf(level).find((s) => s.key === BED);
    if (!space) throw new Error('no bedroom');
    const steer = storageLens.steer?.({ level, space, brief: ONGS, opts: {} });
    expect(steer?.protect).toContain('wardrobe');
    expect(steer?.prefer.find((p) => p.role === 'wardrobe')?.weight).toBe(1);
    // A household with nobody sleeping there: nothing to protect for clothes.
    const none = storageLens.steer?.({
      level,
      space,
      brief: { ...ONGS, sleeping: { [MAIN]: ['adult-1', 'adult-2', 'elder-1', 'child-1'] } },
      opts: {},
    });
    expect(none?.protect ?? []).not.toContain('wardrobe');
    // Lenses off: no steer.
    expect(steerFor({ level, space, brief: ONGS, opts: { lenses: [] } })).toBeNull();
  });

  it('steers merge and are cut to the roles an answer has', () => {
    const s = mergeSteers([
      { protect: ['wardrobe'], prefer: [{ role: 'wardrobe', weight: 0.4 }] },
      { protect: ['shelf'], prefer: [{ role: 'wardrobe', weight: 0.9 }] },
      null,
    ]);
    expect(s).toEqual({
      protect: ['shelf', 'wardrobe'],
      prefer: [{ role: 'wardrobe', weight: 0.9 }],
    });
    expect(steerOnly(s, new Set(['bed', 'shelf']))).toEqual({ protect: ['shelf'], prefer: [] });
    expect(steerOnly(s, new Set(['bed']))).toBeNull();
  });

  it('a protected storage piece is left out after anything else that may be, beds aside', () => {
    const wardrobe = furnitureKind('wardrobe');
    const console = furnitureKind('built-in-tv-console');
    const bed = furnitureKind('bed-queen');
    if (!wardrobe || !console || !bed) throw new Error('catalogue');
    const steer = { protect: ['wardrobe' as const], prefer: [] };
    expect(dropPriorityOf(wardrobe)).toBeGreaterThan(dropPriorityOf(console));
    expect(dropPriorityOf(wardrobe, steer)).toBeLessThan(dropPriorityOf(console, steer));
    expect(dropPriorityOf(wardrobe, steer)).toBeGreaterThan(dropPriorityOf(bed, steer));
  });

  it('in a short bedroom the wardrobe outlives a built-in TV console when room runs out', () => {
    const answers = {
      [SAMPLE_KEYS.main]: answerOf([
        { ref: 'bed1', assetId: 'bed-queen' },
        { ref: 'ward1', assetId: 'wardrobe' },
        { ref: 'tv1', assetId: 'built-in-tv-console', width: 2.4 },
        { ref: 'bw1', assetId: 'built-in-wardrobe', width: 2.0 },
      ]),
    };
    const plain = place(answers, { lenses: [] });
    const steered = place(answers);
    expect(placedRefs(plain)).toEqual(['bed1', 'tv1']);
    expect(placedRefs(steered)).toEqual(['bed1', 'bw1']);
    // The weights cost no piece and no check.
    expect(steered.dropped.length).toBe(plain.dropped.length);
    const hard = (r: typeof plain) => r.checks.filter((c) => c.hard && !c.already).length;
    expect(hard(steered)).toBeLessThanOrEqual(hard(plain));
  });

  it('the steered choice is remembered with the house rules it was made against', () => {
    const answers = {
      [SAMPLE_KEYS.main]: answerOf([
        { ref: 'bed1', assetId: 'bed-queen' },
        { ref: 'ward1', assetId: 'wardrobe' },
        { ref: 'tv1', assetId: 'built-in-tv-console', width: 2.4 },
        { ref: 'bw1', assetId: 'built-in-wardrobe', width: 2.0 },
      ]),
    };
    const rules = [
      Rule.parse({
        id: 'rule_nobw',
        name: 'No built-in wardrobe in the main bedroom',
        subject: { kind: 'kind', kindId: 'built-in-wardrobe' },
        relation: 'notIn',
        target: { kind: 'room', roomId: MAIN },
        n: null,
        levelId: level.id,
        at: '2026-11-08T00:00:00Z',
        from: { turnId: 't1', version: null },
      }),
    ];
    const ruleFails = (r: ReturnType<typeof place>) =>
      r.checks.filter((c) => c.hard && c.key.startsWith('R|')).map((c) => c.key);
    // Fresh, with the rule: the steered layout would break it, so the plain one is kept.
    const fresh = place(answers, { rules }, ONGS, 'dsn_rule_fresh');
    expect(placedRefs(fresh)).toEqual(['bed1', 'tv1']);
    expect(ruleFails(fresh)).toEqual([]);
    // Placed without the rule first, then with it (one session's caches): the same as fresh.
    const id = 'dsn_rule_after';
    expect(placedRefs(place(answers, {}, ONGS, id))).toEqual(['bed1', 'bw1']);
    const after = place(answers, { rules }, ONGS, id);
    expect(placedRefs(after)).toEqual(placedRefs(fresh));
    expect(ruleFails(after)).toEqual([]);
  });

  it('a storage piece keeps its full width when another arrangement fits it', () => {
    const answers = {
      [BED]: answerOf([
        { ref: 'bed1', assetId: 'bed-single' },
        { ref: 'ward1', assetId: 'wardrobe' },
        { ref: 'sc1', assetId: 'built-in-shoe-cabinet', width: 1.2 },
        { ref: 'bw1', assetId: 'built-in-wardrobe', width: 2.0 },
      ]),
    };
    const width = (r: ReturnType<typeof place>) => {
      const it = Object.values(r.level.items).find((x) => r.refs[x.id] === 'sc1');
      return it ? itemSize(it).w : 0;
    };
    const plain = place(answers, { lenses: [] });
    const steered = place(answers);
    expect(width(plain)).toBeLessThan(1.2 - 0.01);
    expect(width(steered)).toBeCloseTo(1.2, 2);
    expect(steered.dropped.length).toBe(plain.dropped.length);
    const hard = (r: typeof plain) => r.checks.filter((c) => c.hard && !c.already).length;
    expect(hard(steered)).toBeLessThanOrEqual(hard(plain));
  });

  it('is deterministic, and the same in any record order', () => {
    const answers = sampleAnswers(level);
    const a = place(answers, {}, ONGS, 'dsn_lens_same');
    const c = place(answers, {}, ONGS, 'dsn_lens_same');
    expect(a).toBe(c);
    const poses = (r: typeof a) =>
      Object.values(r.level.items)
        .map(
          (it) =>
            `${roleOf(furnitureKind(it.assetId))}@${it.position.x.toFixed(3)},${it.position.z.toFixed(3)}`,
        )
        .sort();
    const shuffled: Level = {
      ...level,
      rooms: Object.fromEntries(Object.entries(level.rooms).reverse()),
    };
    const d = designResult(
      shuffled,
      shuffled,
      { ...sampleDesign({ answers, brief: ONGS, concept: null, id: 'dsn_lens_same' }), aliases },
      {},
    );
    expect(poses(d)).toEqual(poses(a));
  });
});
