import { hdb4RoomLevel } from '../../fixtures/hdb4room';
import { sampleFlatProject } from '../../fixtures/sampleFlat';
import { levelBounds } from '../../geometry';
import type { Level } from '../../schema';
import { aliasesFor } from '../aliases';
import { type DesignResult, designResult } from '../result';
import { type DesignBrief, type SpaceDesign, defaultBrief, parseSpaceDesign } from '../schema';
import hdb4Bed2 from './answers/hdb4-bed2.json';
import hdb4Bed3 from './answers/hdb4-bed3.json';
import hdb4Kitchen from './answers/hdb4-kitchen.json';
import hdb4Living from './answers/hdb4-living.json';
import hdb4Master from './answers/hdb4-master.json';
import ownerBedroom from './answers/owner-bedroom.json';
import ownerDiningFix from './answers/owner-dining-fix.json';
import ownerDining from './answers/owner-dining.json';
import sampleBedroom from './answers/sample-bedroom.json';
import sampleKitchen from './answers/sample-kitchen.json';
import sampleLiving from './answers/sample-living.json';
import sampleMain from './answers/sample-main-bedroom.json';

/**
 * The benchmark: flats, each with a household and the designer's recorded answers (as a
 * model sends them, version 2), placed and checked as the app does, with no request made.
 * It runs in CI (benchmark.test.ts). `pnpm --filter @dhd/core designer:bench` prints the
 * report. A recorded answer may carry fix rounds: the answers the designer gave when its
 * failures were sent back, used in turn while the space still fails.
 */
export interface BenchFlat {
  id: string;
  name: string;
  level: () => Level;
  brief: DesignBrief;
  /** Recorded answers by space key: the first, then each fix round's. */
  answers: Record<string, unknown[]>;
  /**
   * Pieces known to be left out today, by ref, with why: the test fails once they fit, so
   * the note comes off then.
   */
  known?: Record<string, string>;
}

export interface BenchReport {
  id: string;
  name: string;
  /** Hard failures the designer caused, after its fix rounds (shown to the person: must be 0). */
  shown: string[];
  /** Failures caught before showing (fixed by a fix round). */
  caught: number;
  fixRounds: number;
  /** People without a bed. */
  bedless: number;
  /** Pieces left out. */
  dropped: number;
  pieces: number;
  ms: number;
  result: DesignResult;
}

const sample = () => sampleFlatProject().levels[0] as Level;

/** The Ongs (spec user stories): Rachel and Daniel, Mdm Koh (a stick) and Sophie (6). */
export const ONGS: DesignBrief = {
  ...defaultBrief(),
  household: {
    adults: 2,
    children: ['primary'],
    elders: ['stick'],
    helper: false,
    pets: '',
    text: '',
  },
  names: { 'adult-1': 'Rachel', 'adult-2': 'Daniel', 'elder-1': 'Mdm Koh', 'child-1': 'Sophie' },
  sleeping: { 'rm_main-bedroom': ['adult-1', 'adult-2'], rm_bedroom: ['elder-1', 'child-1'] },
  budget: { low: 30_000, high: 40_000 },
};

export const BENCHMARK: BenchFlat[] = [
  {
    id: 'sample-3room',
    name: 'The sample 3-room (the Ongs)',
    level: sample,
    brief: ONGS,
    known: {
      // Bedroom is 2.88 × 2.90 m: two singles with an aisle leave 0.90 m at their feet, and a
      // hinged wardrobe needs 0.60 m in front of its 0.60 m depth, clear of the door.
      ward1:
        'Bedroom: two single beds and a hinged wardrobe don’t fit; a sliding one or a bunk would',
    },
    answers: {
      'rm_main-bedroom': [sampleMain],
      rm_bedroom: [sampleBedroom],
      'rm_dry-kitchen+rm_living-and-dining': [sampleLiving],
      rm_kitchen: [sampleKitchen],
    },
  },
  {
    id: 'hdb4-reference',
    name: 'The 4-room reference flat (a couple, a teen and a child)',
    level: hdb4RoomLevel,
    brief: {
      ...defaultBrief(),
      household: {
        adults: 2,
        children: ['teen', 'primary'],
        elders: [],
        helper: false,
        pets: '',
        text: '',
      },
      lifestyle: { wfh: 1, cooking: 'daily', guests: false },
      sleeping: { rm_master: ['adult-1', 'adult-2'], rm_bed2: ['child-1'], rm_bed3: ['child-2'] },
    },
    answers: {
      rm_living: [hdb4Living],
      rm_kitchen: [hdb4Kitchen],
      rm_master: [hdb4Master],
      rm_bed2: [hdb4Bed2],
      rm_bed3: [hdb4Bed3],
    },
  },
  {
    id: 'owner-missing-bed',
    name: 'Owner, 7 Nov: a bed and a wardrobe asked for on one wall',
    level: sample,
    brief: {
      ...defaultBrief(),
      household: { ...defaultBrief().household, adults: 2, children: ['primary'] },
    },
    answers: { rm_bedroom: [ownerBedroom] },
  },
  {
    id: 'owner-sofa-and-table',
    name: 'Owner, 7 Nov: the sofa facing the TV, and dining for six off the passage',
    level: sample,
    brief: {
      ...defaultBrief(),
      household: { ...defaultBrief().household, adults: 2, children: ['primary', 'teen'] },
      sleeping: {},
    },
    answers: { 'rm_dry-kitchen+rm_living-and-dining': [ownerDining, ownerDiningFix] },
  },
];

const parsedAnswer = (raw: unknown, level: Level): SpaceDesign => {
  const r = parseSpaceDesign(raw, levelBounds(level));
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

/** One flat, placed and checked as the app does, with its recorded fix rounds. */
export function runFlat(flat: BenchFlat): BenchReport {
  const level = flat.level();
  const t0 = performance.now();
  const round = new Map(Object.keys(flat.answers).map((k) => [k, 0]));
  const design = (id: string) => ({
    id,
    brief: flat.brief,
    aliases: aliasesFor(level),
    concept: null,
    spaces: Object.fromEntries(
      Object.entries(flat.answers).map(([k, list]) => [
        k,
        {
          name: k,
          status: 'done' as const,
          design: parsedAnswer(list[round.get(k) ?? 0], level),
        },
      ]),
    ),
  });
  let result = designResult(level, level, design(`dsn_bench_${flat.id}`));
  let caught = 0;
  let fixRounds = 0;
  for (let n = 1; n <= 2; n++) {
    const failing = new Set(
      result.checks.flatMap((c) =>
        c.hard && !c.already && c.part && 'space' in c.part ? [c.part.space] : [],
      ),
    );
    const next = [...failing].filter((k) => (flat.answers[k]?.length ?? 0) > n);
    if (!next.length) break;
    caught += result.checks.filter((c) => c.hard && !c.already).length;
    for (const k of next) round.set(k, n);
    fixRounds++;
    result = designResult(level, level, design(`dsn_bench_${flat.id}_${n}`));
  }
  const shown = result.checks.filter((c) => c.hard && !c.already).map((c) => c.text);
  return {
    id: flat.id,
    name: flat.name,
    shown,
    caught,
    fixRounds,
    bedless: result.checks.filter((c) => !c.already && c.key.startsWith('P1|bed|')).length,
    dropped: result.dropped.length,
    pieces: Object.keys(result.level.items).length,
    ms: performance.now() - t0,
    result,
  };
}

/** The report as lines, one per flat. */
export function benchText(reports: BenchReport[]): string {
  return reports
    .map(
      (r) =>
        `${r.id}: ${r.shown.length} failing shown, ${r.caught} caught before, ${r.fixRounds} fix rounds, ${r.bedless} without a bed, ${r.dropped} left out, ${r.pieces} pieces, ${r.ms.toFixed(0)} ms${r.shown.length ? `\n  ${r.shown.join('\n  ')}` : ''}`,
    )
    .join('\n');
}
