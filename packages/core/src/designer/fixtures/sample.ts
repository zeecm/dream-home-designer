import { sampleFlatProject } from '../../fixtures/sampleFlat';
import { levelBounds } from '../../geometry';
import type { Level } from '../../schema';
import { type AliasMap, aliasesFor } from '../aliases';
import {
  type Concept,
  type DesignBrief,
  type DesignInput,
  type DesignOp,
  type SpaceDesign,
  defaultBrief,
  parseConcept,
  parseSpaceDesign,
} from '../schema';
import concept from './concept.json';
import bedroom from './room-bedroom.json';
import kitchen from './room-kitchen.json';
import living from './room-living.json';
import mainBedroom from './room-main-bedroom.json';

/**
 * The sample flat with mocked model answers (as a model would give them for it): the layout
 * and style, then one answer per space. No test calls a real provider.
 */
export const SAMPLE_KEYS = {
  bedroom: 'rm_bedroom',
  main: 'rm_main-bedroom',
  living: 'rm_dry-kitchen+rm_living-and-dining',
  kitchen: 'rm_kitchen',
} as const;

export const sampleLevel = (): Level => sampleFlatProject().levels[0] as Level;

/** The Tan family's brief: three generations, Mdm Lim on a walking frame, S$60,000. */
export function tanBrief(patch: Partial<DesignBrief> = {}): DesignBrief {
  return {
    ...defaultBrief(),
    household: {
      adults: 2,
      children: ['primary', 'preschool'],
      elders: ['frame'],
      helper: false,
      pets: '',
      text: 'Kevin works from home three days a week.',
    },
    lifestyle: { wfh: 1, cooking: 'daily', guests: false },
    style: 'japandi',
    budget: { low: 40_000, high: 60_000 },
    ...patch,
  };
}

export function parsed<T>(r: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

export const sampleConcept = (level = sampleLevel()): Concept =>
  parsed(parseConcept(concept, levelBounds(level)));

export const sampleAnswers = (level = sampleLevel()): Record<string, SpaceDesign> => {
  const b = levelBounds(level);
  return {
    [SAMPLE_KEYS.bedroom]: parsed(parseSpaceDesign(bedroom, b)),
    [SAMPLE_KEYS.main]: parsed(parseSpaceDesign(mainBedroom, b)),
    [SAMPLE_KEYS.living]: parsed(parseSpaceDesign(living, b)),
    [SAMPLE_KEYS.kitchen]: parsed(parseSpaceDesign(kitchen, b)),
  };
};

/** A whole version for the sample: every space done. */
export function sampleDesign(
  opts: {
    level?: Level;
    brief?: DesignBrief;
    concept?: Concept | null;
    answers?: Record<string, SpaceDesign>;
    aliases?: AliasMap;
    id?: string;
  } = {},
): DesignInput {
  const level = opts.level ?? sampleLevel();
  const answers = opts.answers ?? sampleAnswers(level);
  return {
    id: opts.id ?? 'dsn_test',
    brief: opts.brief ?? tanBrief(),
    aliases: opts.aliases ?? aliasesFor(level),
    concept: opts.concept === undefined ? sampleConcept(level) : opts.concept,
    spaces: Object.fromEntries(
      Object.entries(answers).map(([k, design]) => [k, { name: k, status: 'done', design }]),
    ),
  };
}

/** A space answer with just these pieces (every other field null). */
export function answer(
  items: (Partial<SpaceDesign['items'][number]> & { ref: string; assetId: string })[],
  faces: SpaceDesign['faces'] = [],
): SpaceDesign {
  return {
    items: items.map((i) => ({
      keep: null,
      wall: null,
      along: null,
      at: null,
      rotation: null,
      width: null,
      depth: null,
      height: null,
      why: '',
      ...i,
    })),
    faces,
    notes: [],
    summary: '',
  };
}

/** A wall op with every field it doesn't use null. */
export const wallOp = (o: Partial<DesignOp> & { op: DesignOp['op'] }): DesignOp => ({
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

/**
 * The Bedroom split by a new partition at x 5.7 (between its window and the living-room
 * wall), with a door from the living room into the narrow part it makes.
 */
export const SPLIT_BEDROOM: DesignOp[] = [
  wallOp({ op: 'add_wall', a: { x: 5.7, y: 0.08 }, b: { x: 5.7, y: 3.09 } }),
  wallOp({ op: 'add_door', wall: 'W8', t: 0.5, width: 0.8 }),
];
