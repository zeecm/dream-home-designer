import { describe, expect, it } from 'vitest';
import { sampleFlatProject } from '../fixtures/sampleFlat';
import { levelBounds } from '../geometry';
import type { Level } from '../schema';
import { aliasesFor } from './aliases';
import sampleBedroom from './benchmark/answers/sample-bedroom.json';
import sampleLiving from './benchmark/answers/sample-living.json';
import sampleMain from './benchmark/answers/sample-main-bedroom.json';
import { ONGS } from './benchmark/benchmark';
import { APP_REF, freeEssentials, isAppRef, isDeclined } from './free';
import { runReport } from './report';
import { designResult } from './result';
import { Rule } from './rules/schema';
import { type DesignBrief, type DesignInput, type SpaceDesign, parseSpaceDesign } from './schema';

/**
 * Free fixes (spec docs/specs/designer-listens.md §3 and criteria 11, 13, 14; lead decisions
 * "Free fixes: a post-pass on the answer"): the missing essential is added as an `app:` piece and
 * kept only when the version gets strictly better, by signature, with no piece worse.
 */

const level = () => sampleFlatProject().levels[0] as Level;
const MAIN = 'rm_main-bedroom';
const LIVING = 'rm_dry-kitchen+rm_living-and-dining';

const parsed = (raw: unknown, lvl: Level): SpaceDesign => {
  const r = parseSpaceDesign(raw, levelBounds(lvl));
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
/** A recorded answer with some of its pieces taken out (by ref). */
const without = (raw: { items: { ref: string }[] }, refs: string[]) => ({
  ...raw,
  items: raw.items.filter((i) => !refs.includes(i.ref)),
});

function version(
  id: string,
  answers: Record<string, unknown>,
  brief: DesignBrief = ONGS,
  lvl = level(),
): { lvl: Level; d: DesignInput } {
  return {
    lvl,
    d: {
      id,
      brief,
      aliases: aliasesFor(lvl),
      concept: null,
      spaces: Object.fromEntries(
        Object.entries(answers).map(([k, raw]) => [
          k,
          { name: k, status: 'done' as const, design: parsed(raw, lvl) },
        ]),
      ),
    },
  };
}

/** An answer's piece as a model sends it: every field, null where not said. */
const piece = (p: Record<string, unknown>) => ({
  keep: null,
  wall: null,
  along: null,
  at: null,
  rotation: null,
  width: null,
  depth: null,
  height: null,
  why: '',
  against: null,
  faces: null,
  near: null,
  zone: null,
  ...p,
});

const bedKeys = (r: ReturnType<typeof designResult>) =>
  r.checks.filter((c) => c.hard && !c.already && c.key.startsWith('P1|bed|')).map((c) => c.key);

describe('free fixes: beds (criterion 11)', () => {
  it('a main bedroom answered with no bed for the couple gets a queen bed, and P1 passes', () => {
    const { lvl, d } = version('dsn_free_bed', { [MAIN]: without(sampleMain, ['bed1']) });
    const before = designResult(lvl, lvl, d);
    expect(bedKeys(before).length).toBe(2);
    const out = freeEssentials(lvl, lvl, d);
    expect(out.added.map((a) => [a.assetId, a.role, a.ref])).toEqual([
      ['bed-queen', 'bed', 'app:bed'],
    ]);
    expect(out.missed).toEqual([]);
    expect(out.tries).toBe(1);
    const after = designResult(lvl, lvl, { ...d, spaces: out.spaces });
    expect(bedKeys(after)).toEqual([]);
    const bed = Object.entries(after.refs).find(([, ref]) => ref === 'app:bed');
    expect(bed && after.level.items[bed[0]]?.assetId).toBe('bed-queen');
    // The answer carries it as data: the version rebuilds from what is stored.
    const items = out.spaces[MAIN]?.design?.items ?? [];
    // One of the answer's bedside tables gave way for it: said on the bed's own row.
    expect(items.filter((i) => isAppRef(i.ref)).map((i) => i.why)).toEqual([
      'A bed for Rachel and Daniel: nobody had one. One bedside table no longer fits and is left out.',
    ]);
    expect(out.gaveWay).toEqual([{ space: MAIN, ref: 'side2', assetId: 'bedside' }]);
    // The run report names the piece by its app ref; no failure is left for it.
    const rep = runReport(after, { ...d, spaces: out.spaces });
    expect(rep.failures.filter((f) => f.key.startsWith('P1|bed|'))).toEqual([]);
  });

  it('nothing failing: no try, the answers are the same object (layouts unchanged)', () => {
    const { lvl, d } = version('dsn_free_none', { [MAIN]: sampleMain });
    const out = freeEssentials(lvl, lvl, d);
    expect(out.tries).toBe(0);
    expect(out.added).toEqual([]);
    expect(out.spaces).toBe(d.spaces);
  });

  it('a piece the person left out before (declined, by room and role) is never added again', () => {
    const { lvl, d } = version('dsn_free_declined', { [MAIN]: without(sampleMain, ['bed1']) });
    const out = freeEssentials(lvl, lvl, d, {}, { declined: [{ room: MAIN, role: 'bed' }] });
    expect(out.added).toEqual([]);
    expect(out.tries).toBe(0);
  });

  it('only the spaces asked for', () => {
    const { lvl, d } = version('dsn_free_scope', { [MAIN]: without(sampleMain, ['bed1']) });
    expect(freeEssentials(lvl, lvl, d, {}, { spaces: ['rm_bedroom'] }).tries).toBe(0);
    expect(freeEssentials(lvl, lvl, d, {}, { spaces: [MAIN] }).added.length).toBe(1);
  });
});

describe('free fixes: seats and dining (criterion 12, orphans out of B)', () => {
  it('a living answer with no sofa gets one that fits, and P1 seats passes', () => {
    const { lvl, d } = version('dsn_free_sofa', { [LIVING]: without(sampleLiving, ['sofa1']) });
    const seats = (r: ReturnType<typeof designResult>) =>
      r.checks.filter((c) => c.hard && !c.already && c.key.startsWith('P1|seats|'));
    expect(seats(designResult(lvl, lvl, d)).length).toBe(1);
    const out = freeEssentials(lvl, lvl, d);
    expect(out.added.map((a) => a.role)).toEqual(['sofa']);
    expect(seats(designResult(lvl, lvl, { ...d, spaces: out.spaces }))).toEqual([]);
  });

  it('no dining table: a table with a chair for each of the household', () => {
    const { lvl, d } = version('dsn_free_dining', {
      [LIVING]: without(sampleLiving, ['dine1', 'chair1', 'chair2', 'chair3', 'chair4']),
    });
    const out = freeEssentials(lvl, lvl, d);
    expect(out.added.map((a) => a.assetId)).toEqual([
      'dining-4',
      'dining-chair',
      'dining-chair',
      'dining-chair',
      'dining-chair',
    ]);
    const r = designResult(lvl, lvl, { ...d, spaces: out.spaces });
    expect(r.checks.filter((c) => c.hard && !c.already && c.key.startsWith('P1|dining|'))).toEqual(
      [],
    );
  });

  it('a dining chair declined: the table is still tried, never the chair; the table declined: nothing (S2)', () => {
    const { lvl, d } = version('dsn_free_dining_declined', {
      [LIVING]: without(sampleLiving, ['dine1', 'chair1', 'chair2', 'chair3', 'chair4']),
    });
    const chairs = freeEssentials(
      lvl,
      lvl,
      d,
      {},
      {
        declined: [{ room: 'rm_living-and-dining', role: 'dining-chair' }],
      },
    );
    const tried = [...chairs.added, ...chairs.missed].map((a) => a.assetId);
    expect(tried).toContain('dining-4');
    expect(tried).not.toContain('dining-chair');
    const table = freeEssentials(
      lvl,
      lvl,
      d,
      {},
      {
        declined: [{ room: 'rm_living-and-dining', role: 'dining-table' }],
      },
    );
    expect(table.tries).toBe(0);
    expect(table.added).toEqual([]);
  });
});

describe('free fixes: kept only when strictly better (criterion 14)', () => {
  it('a house rule the bed would break: not placed, said why', () => {
    const { lvl, d } = version('dsn_free_rule', { [MAIN]: without(sampleMain, ['bed1']) });
    const rules = [
      Rule.parse({
        id: 'rule_nobed',
        name: 'No bed in the main bedroom',
        subject: { kind: 'category', category: 'beds' },
        relation: 'notIn',
        target: { kind: 'room', roomId: MAIN },
        n: null,
        levelId: lvl.id,
        at: '2026-11-08T00:00:00Z',
        from: { turnId: 't1', version: null },
      }),
    ];
    const out = freeEssentials(lvl, lvl, d, { rules });
    expect(out.added).toEqual([]);
    expect(out.spaces).toBe(d.spaces);
    expect(out.missed.map((m) => m.assetId)).toEqual(['bed-queen']);
    expect(out.missed[0]?.text).toMatch(
      /^A queen bed fits in Main bedroom only with another check failing \(Your rule/,
    );
  });

  it('two spaces missing essentials: each gets its own, in turn', () => {
    const { lvl, d } = version(
      'dsn_free_two',
      { [MAIN]: without(sampleMain, ['bed1']), [LIVING]: without(sampleLiving, ['sofa1']) },
      ONGS,
    );
    const out = freeEssentials(lvl, lvl, d);
    expect(out.added.map((a) => [a.space, a.role])).toEqual([
      [MAIN, 'bed'],
      [LIVING, 'sofa'],
    ]);
  });

  it('a bedside table that would give way to the bed: an extra of this answer, but never one carried over', () => {
    const { lvl, d } = version('dsn_free_theirs', { [MAIN]: without(sampleMain, ['bed1']) });
    // New in this answer: the bedside table that loses its place makes room for the bed.
    const fresh = freeEssentials(lvl, lvl, d);
    expect(fresh.added.map((a) => a.role)).toEqual(['bed']);
    const r = designResult(lvl, lvl, { ...d, spaces: fresh.spaces });
    expect(r.dropped.map((n) => n.ref)).toEqual(['side2']);
    // Carried over from the answer it changes (Change something kept it): it is theirs, and
    // nothing of theirs is lost for a free fix.
    const refs = d.spaces[MAIN]?.design?.items.map((i) => i.ref) ?? [];
    const kept = freeEssentials(lvl, lvl, d, {}, { theirs: { [MAIN]: refs } });
    expect(kept.added).toEqual([]);
    expect(kept.spaces).toBe(d.spaces);
  });

  it('a space whose furniture the person kept (a lock): no free fix, no try', () => {
    const { lvl, d } = version('dsn_free_locked', { [MAIN]: without(sampleMain, ['bed1']) });
    const locked: DesignInput = {
      ...d,
      request: { locks: [{ space: MAIN, aspect: 'furniture', by: 'person', label: 'Furniture' }] },
    };
    const out = freeEssentials(lvl, lvl, locked);
    expect(out.tries).toBe(0);
    expect(out.added).toEqual([]);
  });
});

describe('free fixes: cannot place (criterion 13)', () => {
  it('a bedroom full of wardrobe and desks: no bed, and why', () => {
    const answer = {
      v: 2,
      items: [
        piece({
          ref: 'ward1',
          assetId: 'built-in-wardrobe',
          width: 2.4,
          against: 'wall',
          zone: 'store',
        }),
        piece({ ref: 'desk1', assetId: 'desk', against: 'wall', zone: 'work' }),
        piece({ ref: 'desk2', assetId: 'desk', against: 'wall', zone: 'work' }),
        piece({ ref: 'ch1', assetId: 'desk-chair', near: 'desk1', against: 'free', zone: 'work' }),
        piece({ ref: 'ch2', assetId: 'desk-chair', near: 'desk2', against: 'free', zone: 'work' }),
        piece({ ref: 'shelf1', assetId: 'bookshelf', against: 'wall', zone: 'store' }),
      ],
      faces: [],
      notes: [],
      summary: '',
    };
    const brief: DesignBrief = { ...ONGS, sleeping: { rm_bedroom: ['adult-1', 'adult-2'] } };
    const { lvl, d } = version('dsn_free_full', { rm_bedroom: answer }, brief);
    const out = freeEssentials(lvl, lvl, d);
    // The bed fits only by turning the desks from the window and crowding the shelf: not kept.
    expect(out.added).toEqual([]);
    expect(out.spaces).toBe(d.spaces);
    expect(out.missed.map((m) => m.assetId)).toEqual(['bed-queen']);
    expect(out.missed[0]?.text).toMatch(
      /^A queen bed fits in Bedroom only with \d+ other checks failing \(.+\), so the app didn’t place one\.$/,
    );
  });
});

describe('a must-have the person left out (a Decision)', () => {
  const declined = [{ room: 'rm_main-bedroom', role: 'bed' }];
  it('is theirs in that room only, for the check its piece meets', () => {
    expect(isDeclined('P1|bed|rm_main-bedroom|bed', 'rm_main-bedroom', declined)).toBe(true);
    expect(isDeclined('P1|bed|rm_bedroom|bed', 'rm_bedroom', declined)).toBe(false);
    expect(isDeclined('P1|seats|rm_main-bedroom', 'rm_main-bedroom', declined)).toBe(false);
    expect(isDeclined('P4|clear|rm_main-bedroom|bed', 'rm_main-bedroom', declined)).toBe(false);
    // Only the piece that heads a must-have waives it (tech lead S2): a dining chair or an
    // armchair declined never hides "no dining table" or "not enough seats".
    const chairs = [{ room: 'rm_living', role: 'dining-chair' }];
    expect(isDeclined('P1|dining|rm_living', 'rm_living', chairs)).toBe(false);
    const table = [{ room: 'rm_living', role: 'dining-table' }];
    expect(isDeclined('P1|dining|rm_living', 'rm_living', table)).toBe(true);
    const armchair = [{ room: 'rm_living', role: 'armchair' }];
    expect(isDeclined('P1|seats|rm_living', 'rm_living', armchair)).toBe(false);
    const sofa = [{ room: 'rm_living', role: 'sofa' }];
    expect(isDeclined('P1|seats|rm_living', 'rm_living', sofa)).toBe(true);
    expect(isDeclined('P1|bed|rm_main-bedroom|bed', 'rm_main-bedroom', [])).toBe(false);
  });
});

describe('the app: prefix is the app’s own', () => {
  it('a model ref posing as the app is renamed, with what faces it', () => {
    const lvl = level();
    const r = parseSpaceDesign(
      {
        v: 2,
        items: [
          piece({ ref: 'app:bed', assetId: 'bed-queen', against: 'wall' }),
          piece({ ref: 'bed', assetId: 'bed-single', against: 'wall' }),
          piece({ ref: 'side1', assetId: 'bedside', near: 'app:bed' }),
          piece({ ref: 'APP:tv', assetId: 'tv', faces: 'app:bed' }),
        ],
        faces: [],
        notes: [],
      },
      levelBounds(lvl),
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.value.items.map((i) => [i.ref, i.near ?? null, i.faces ?? null])).toEqual([
      ['bed2', null, null],
      ['bed', null, null],
      ['side1', 'bed2', null],
      ['tv', null, 'bed2'],
    ]);
    expect(r.value.items.some((i) => i.ref.toLowerCase().startsWith(APP_REF))).toBe(false);
  });

  it('the stored answer keeps the app’s refs (only a model’s answer is renamed)', async () => {
    const { SpaceDesign } = await import('./schema');
    const kept = SpaceDesign.parse({
      v: 2,
      items: [
        {
          ref: 'app:bed',
          assetId: 'bed-queen',
          keep: null,
          wall: null,
          along: null,
          at: null,
          rotation: null,
          width: null,
          depth: null,
          height: null,
          why: '',
        },
      ],
      faces: [],
      notes: [],
    });
    expect(kept.items[0]?.ref).toBe('app:bed');
  });
});

describe('the bedroom answer of the sample flat stays as recorded', () => {
  it('two singles for the elder and the child: nothing to add', () => {
    const { lvl, d } = version('dsn_free_bed2', { rm_bedroom: sampleBedroom });
    expect(freeEssentials(lvl, lvl, d).added).toEqual([]);
  });
});

describe('free fixes: PERF', () => {
  /** The sample living room, heavier: a side table and a shelf too, six people, and no sofa. */
  const heavy = () => ({
    ...sampleLiving,
    items: [
      ...without(sampleLiving, ['sofa1']).items,
      piece({ ref: 'side1', assetId: 'side-table-two-tier', against: 'free', zone: 'lounge' }),
      piece({ ref: 'shelf1', assetId: 'bookshelf', against: 'wall', zone: 'lounge' }),
    ],
  });
  const six: DesignBrief = {
    ...ONGS,
    household: { ...ONGS.household, children: ['primary', 'teen', 'teen'] },
  };

  const timed = (answer: unknown, brief: DesignBrief, tag: string) => {
    const run = (id: string) => {
      const { lvl, d } = version(id, { [LIVING]: answer }, brief);
      const t0 = performance.now();
      designResult(lvl, lvl, d);
      const first = performance.now() - t0;
      const t1 = performance.now();
      const out = freeEssentials(lvl, lvl, d);
      return { first, free: performance.now() - t1, out };
    };
    run(`dsn_free_perf_${tag}_warm`);
    const times = Array.from({ length: 5 }, (_, i) => run(`dsn_free_perf_${tag}_${i}`));
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[2] as number;
    const free = median(times.map((t) => t.free));
    console.log(
      `free fix, living room (${tag}): ${free.toFixed(0)} ms median, its first solve ${median(times.map((t) => t.first)).toFixed(0)} ms`,
    );
    return { free, out: times[0]?.out };
  };
  // The first solve's bound is 300 ms (solve.test.ts, HEAVY_PERF): the post-pass within 2x.
  const BOUND = process.env.PERF ? 2 * 300 : 3 * 2 * 300;

  it('PERF: the sample living room with no sofa, kept at its first try, within twice the bound', () => {
    const { free, out } = timed(without(sampleLiving, ['sofa1']), ONGS, 'four');
    expect(out?.added.map((a) => a.role)).toEqual(['sofa']);
    expect(out?.tries).toBe(1);
    expect(free).toBeLessThan(BOUND);
  });

  it('PERF: the heavy one, both tries refused (six people, seats and dining short), within it', () => {
    const { free, out } = timed(heavy(), six, 'six');
    expect(out?.tries).toBe(2);
    expect(out?.added).toEqual([]);
    expect(out?.missed.map((m) => m.role)).toEqual(['sofa', 'dining-chair', 'dining-chair']);
    expect(free).toBeLessThan(BOUND);
  });
});
