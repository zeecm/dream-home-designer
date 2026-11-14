import { describe, expect, it } from 'vitest';
import { sampleFlatProject } from '../fixtures/sampleFlat';
import { Level } from '../schema';
import sampleMain from './benchmark/answers/sample-main-bedroom.json';
import owner from './fixtures/owner-after-v4.json';
import { freeEssentials, madeWayLines } from './free';
import { designResult } from './result';
import type { DesignInput, SpaceDesign } from './schema';
import { levelFingerprint } from './util';

/**
 * The owner's "missing a bed", found by the replay (designer listens C, criterion 31c): after V1
 * with the owner's V4 layout was accepted, Main bedroom and Bedroom are one Master bedroom. The
 * next answer leaves the bed out and keeps its two bedside tables (`near` the bed it dropped)
 * and two desk chairs. Before the fix the run's free pass couldn't place the queen bed (the
 * bedsides took the walls it needed, so it only fitted by a desk chair's way) and then took
 * the bedsides out as orphans; the card's dry run, on that answer, placed the bed. Now the run
 * places it (a bedside by it, the other making way), never takes a bedside out as an orphan
 * while a bed can go in, and the card's dry run on what the run kept places nothing more.
 */

const after = Level.parse(owner.after);
const before = sampleFlatProject().levels[0] as Level;
const KEY = 'rm_main-bedroom';
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
/** The answer the replay gives: no bed, its bedsides, two desk chairs at no desk. */
const answer = {
  ...sampleMain,
  items: [
    ...sampleMain.items.filter((i) => i.ref !== 'bed1'),
    piece({ ref: 'dc1', assetId: 'desk-chair', against: 'free', zone: 'work' }),
    piece({ ref: 'dc2', assetId: 'desk-chair', against: 'free', zone: 'work' }),
  ],
} as unknown as SpaceDesign;
const draft = (design: SpaceDesign): DesignInput => ({
  id: 'dsn_owner_bed',
  brief: owner.brief as DesignInput['brief'],
  aliases: owner.aliases,
  concept: owner.concept as DesignInput['concept'],
  spaces: { [KEY]: { name: 'Master bedroom', status: 'done', design } },
});
const bedChecks = (r: ReturnType<typeof designResult>) =>
  r.checks.filter((c) => c.hard && !c.already && c.key.startsWith('P1|bed|'));

describe('the owner’s replay: the run places the bed in the merged Master bedroom (31c)', () => {
  it('starts from the plan the replay had: the sample flat, the merged room, no bed', () => {
    expect(before.id).toBe('lvl_ground');
    expect(levelFingerprint(after)).toBe('00ebv2h');
    expect(bedChecks(designResult(after, before, draft(answer)))).toHaveLength(2);
  });

  it('the run’s free pass (the space alone, orphans on) places the queen bed; no bedside is taken out as an orphan', () => {
    const out = freeEssentials(after, before, draft(answer), {}, { spaces: [KEY], orphans: true });
    expect(out.added.map((a) => [a.role, a.assetId])).toEqual([['bed', 'bed-queen']]);
    expect(out.removed ?? []).toEqual([]);
    expect(out.missed).toEqual([]);
    const r = designResult(after, before, { ...draft(answer), spaces: out.spaces });
    expect(bedChecks(r)).toEqual([]);
    // A bedside by the app's bed; the one there was no room for made way, said as such.
    const items = out.spaces[KEY]?.design?.items ?? [];
    const sides = items.filter((i) => i.assetId === 'bedside');
    expect(sides.length).toBeGreaterThanOrEqual(1);
    for (const s of sides) expect(s.near).toBe('app:bed');
    expect(out.gaveWay.length + sides.length).toBe(2);
    if (out.gaveWay.length) {
      expect(madeWayLines(out, () => 'Master bedroom')).toEqual([
        'Took out a bedside table the designer added in Master bedroom to make room for the queen bed the app placed.',
      ]);
    }
    // Only the chairs at no desk are left: nothing new failed for the bed.
    expect(r.checks.filter((c) => c.hard && !c.already).map((c) => c.key.split('|')[1])).toEqual([
      'belongs',
      'belongs',
    ]);
  });

  it('the run and the card agree: the card’s dry run on what the run kept places nothing more', () => {
    const run = freeEssentials(after, before, draft(answer), {}, { spaces: [KEY], orphans: true });
    const stored = run.spaces[KEY]?.design as SpaceDesign;
    const card = freeEssentials(after, before, draft(stored), {}, {});
    expect(card.added).toEqual([]);
    expect(card.missed).toEqual([]);
  });

  it('a bedside carried over (theirs) is never moved or lost for the app’s bed', () => {
    const refs = answer.items.map((i) => i.ref);
    const out = freeEssentials(
      after,
      before,
      draft(answer),
      {},
      {
        spaces: [KEY],
        theirs: { [KEY]: refs },
      },
    );
    const sides = (out.spaces[KEY]?.design?.items ?? []).filter((i) => i.assetId === 'bedside');
    expect(sides.map((s) => s.near)).toEqual(['bed1', 'bed1']);
    expect(out.gaveWay).toEqual([]);
  });
});
