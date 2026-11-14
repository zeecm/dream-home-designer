import {
  type Change,
  type DesignBrief,
  type DesignInput,
  type Level,
  type ProposalOption,
  type RunReport,
  aliasesFor,
  changeSet,
  defaultBrief,
  designResult,
  freeEssentials,
  levelBounds,
  parseSpaceDesign,
  sampleFlatProject,
} from '@dhd/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import sampleMain from '../../../../../../packages/core/src/designer/benchmark/answers/sample-main-bedroom.json' with {
  type: 'json',
};
import { CheckLead } from './CheckLead';
import {
  appDecisions,
  freeLabel,
  freeLines,
  isAppChange,
  placedWords,
  withFree,
  withoutFree,
} from './free';

// The free fixes read the app's design options and the worker; these tests need neither.
vi.mock('../state', () => ({
  designOpts: () => ({}),
  houseRulesFor: () => [],
  houseKeptFor: () => [],
}));
vi.mock('../results', () => ({}));
vi.mock('./useTalk', () => ({
  useTalk: Object.assign(() => null, { getState: () => ({ conv: null }), setState: () => {} }),
}));
vi.mock('../../../store', () => ({ useStore: { getState: () => ({}) } }));

/**
 * The free fixes on the card (spec docs/specs/designer-listens.md, UX "The free fixes: shown and
 * undone"): rows tagged By the app, the lead's line, the Decision at Accept for one left out,
 * and the option edits a press and its Undo make.
 */

const MAIN = 'rm_main-bedroom';
const couple: DesignBrief = {
  ...defaultBrief(),
  household: { ...defaultBrief().household, adults: 2 },
  sleeping: { [MAIN]: ['adult-1', 'adult-2'] },
};

function noBed() {
  const level = sampleFlatProject().levels[0] as Level;
  const raw = { ...sampleMain, items: sampleMain.items.filter((i) => i.ref !== 'bed1') };
  const r = parseSpaceDesign(raw, levelBounds(level));
  if (!r.ok) throw new Error(r.error);
  const input: DesignInput = {
    id: 'dsn_web_free',
    brief: couple,
    aliases: aliasesFor(level),
    concept: null,
    spaces: { [MAIN]: { name: 'Main bedroom', status: 'done', design: r.value } },
  };
  return { level, input };
}

function placed() {
  const { level, input } = noBed();
  const out = freeEssentials(level, level, input);
  const fixed = { ...input, spaces: out.spaces };
  const r = designResult(level, level, fixed);
  const changes = changeSet(level, r, fixed);
  return { level, input, out, fixed, r, changes };
}

const option = (spaces: DesignInput['spaces']) =>
  ({ letter: 'A', designId: 'dsn_web_free', spaces }) as unknown as ProposalOption;

describe('rows the app placed (By the app)', () => {
  it('the queen bed’s row is the app’s; the answer’s own rows are not', () => {
    const { r, changes } = placed();
    const app = changes.filter((c) => isAppChange(c, r));
    expect(app.map((c) => c.text)).toEqual([expect.stringMatching(/^Add a queen bed/)]);
    expect(app[0]?.why).toBe(
      'A bed for You and Partner: nobody had one. One bedside table no longer fits and is left out.',
    );
    // The designer's bedside table is its own row, never folded into the app's bed.
    expect(app[0]?.text).not.toMatch(/bedside/);
    expect(changes.filter((c) => !isAppChange(c, r)).length).toBeGreaterThan(0);
  });

  it('the lead says what the app placed, in the change list’s words', () => {
    const { r, changes } = placed();
    const lines = freeLines(changes, r);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(
      'Placed by the app, free: a queen bed in Main bedroom, against the wall by Bedroom; one bedside table no longer fits and is left out.',
    );
  });

  it('unticked, the app’s row is said as left out of what is ticked (UX 2)', () => {
    const { r, changes } = placed();
    const app = changes.filter((c) => isAppChange(c, r));
    const ticked = changes.filter((c) => !app.includes(c)).map((c) => c.id);
    expect(freeLines(changes, r, ticked)).toEqual([
      'Left out of what you’ve ticked: a queen bed in Main bedroom, against the wall by Bedroom, placed by the app, free.',
    ]);
    // The ticked subset fails the bed check then (core subsetReport), and the lead says it.
    const html = renderToStaticMarkup(
      <CheckLead
        cardKey="prp:U"
        report={{ failures: [], leftOut: [], rooms: [] }}
        did={freeLines(changes, r, ticked)}
        missed={['You and Partner will have no bed in Main bedroom: its row isn’t ticked.']}
      />,
    );
    expect(html).toContain('You and Partner will have no bed in Main bedroom');
    expect(html).toContain('data-app-line="missed"');
  });

  it('a bed a fix round dropped and the app put back says so (N1)', () => {
    const c = {
      verb: 'add',
      text: 'Add a queen bed against the wall by Bedroom',
      groupName: 'Main bedroom',
      why: 'Put back by the app: the fix round’s answer left out the queen bed.',
      items: { now: [], target: ['it_bed'] },
    } as unknown as Change;
    const r = { refs: { it_bed: 'app:bed' } } as never;
    expect(freeLines([c], r)).toEqual([
      'Put back by the app, free: a queen bed in Main bedroom, against the wall by Bedroom.',
    ]);
  });

  it('placedWords: the room after the piece, then where it stands', () => {
    const c = {
      text: 'Add a queen bed against the wall opposite the window, facing the door',
      groupName: 'Main bedroom',
      verb: 'add',
    } as Change;
    expect(placedWords(c)).toBe(
      'a queen bed in Main bedroom, against the wall opposite the window, facing the door',
    );
  });
});

describe('the free button’s words (never priced, "· free")', () => {
  it('one piece by its name, more by count; the bar short', () => {
    const { out } = placed();
    expect(freeLabel(out)).toBe('Place a queen bed · free');
    expect(freeLabel(out, true)).toBe('Place a bed · free');
    const table = {
      added: [
        { space: 'x', ref: 'app:table', assetId: 'dining-4', roomId: 'r', role: 'dining-table' },
        {
          space: 'x',
          ref: 'app:chair',
          assetId: 'dining-chair',
          roomId: 'r',
          role: 'dining-chair',
        },
        { space: 'x', ref: 'app:sofa', assetId: 'sofa-3', roomId: 'r', role: 'sofa' },
      ],
      spaces: {
        x: {
          name: 'x',
          status: 'done',
          design: {
            items: [{ ref: 'app:chair', near: 'app:table' }],
          },
        },
      },
      missed: [],
      tries: 1,
    } as never;
    // The chair goes with its table: two pieces to place.
    expect(freeLabel(table)).toBe('Place 2 missing pieces · free');
    expect(freeLabel(table, true)).toBe('Place 2 pieces · free');
  });
});

describe('Decision at Accept, not on untick', () => {
  it('an app row left out is recorded by room and role, in the person’s words', () => {
    const { r, changes } = placed();
    const left = changes.filter((c) => isAppChange(c, r));
    expect(appDecisions(left, r)).toEqual([
      {
        text: 'Left out: the app’s queen bed in Main bedroom',
        free: { room: MAIN, role: 'bed' },
      },
    ]);
    // Their own rows left out are the usual "Left out of V4" decision, not this one.
    expect(
      appDecisions(
        changes.filter((c) => !isAppChange(c, r)),
        r,
      ),
    ).toEqual([]);
  });
});

describe('Place … · free and its Undo', () => {
  it('the press adds the app’s pieces to the same option; Undo takes exactly those out', () => {
    const { input, out } = placed();
    const before = option(input.spaces);
    const after = withFree(before, out);
    expect(after.spaces[MAIN]?.design?.items.map((i) => i.ref)).toEqual([
      ...(input.spaces[MAIN]?.design?.items.map((i) => i.ref) ?? []),
      'app:bed',
    ]);
    // The same option, not a new one (a free correction isn't another idea).
    expect(after.letter).toBe('A');
    const undone = withoutFree(after, { refs: [{ space: MAIN, ref: 'app:bed' }] });
    expect(undone.spaces).toEqual(before.spaces);
  });
});

describe('the lead with the app’s own lines', () => {
  const empty: RunReport = { failures: [], leftOut: [], rooms: [] };
  it('passing, with a free fix and a vetting line: ✓ lines, the way to who sleeps where', () => {
    const html = renderToStaticMarkup(
      <CheckLead
        cardKey="prp:A"
        report={empty}
        did={[
          'Placed by the app, free: a queen bed in Main bedroom, against the long wall.',
          'Main bedroom stays a bedroom: You and Partner sleep there. To make it a study, change who sleeps where.',
          'Kept the wall between Bedroom and Living and dining: taking it out would join the room You and Partner sleep in to the living room.',
        ]}
      />,
    );
    expect(html).toContain('Placed by the app, free: a queen bed in Main bedroom');
    expect(html).toContain('Main bedroom stays a bedroom: You and Partner sleep there.');
    expect(html).toContain('Who sleeps where ›');
    // Two lines of what the app did, the rest under How it was checked.
    expect(html).toMatch(/<summary>How it was checked<\/summary><ul><li>Kept the wall/);
    // Named by its first line (no headline when nothing failed).
    expect(html).toContain('aria-labelledby="lead-prp:A"');
    expect(html).toContain('id="lead-prp:A"');
  });

  it('a missing piece the app couldn’t place: a warn line with why, no button', () => {
    const html = renderToStaticMarkup(
      <CheckLead
        cardKey="prp:B"
        report={empty}
        missed={[
          'No queen bed fits in Bedroom: the longest free wall is 1.40 m, and a queen bed needs 1.60 m.',
        ]}
      />,
    );
    expect(html).toContain('data-app-line="missed"');
    expect(html).toContain('the longest free wall is 1.40\u00a0m');
    expect(html).not.toContain('<button');
  });

  it('nothing the app did and nothing failing: no lead', () => {
    expect(renderToStaticMarkup(<CheckLead cardKey="prp:C" report={empty} />)).toBe('');
  });
});
