import { roomArea } from '../../rooms';
import type { Level } from '../../schema';
import { roomKind } from '../../suggest';
import { WET } from '../locks';
import { type Person, peopleOf, sleepingPlan } from '../principles';
import { type DesignBrief, STYLE_NAMES } from '../schema';
import { isDesigned, spacesOf } from '../spaces';
import type { QuestionKey } from './schema';

/**
 * The first meeting (UX §8): the app's own greeting from the plan, its questions (at most 8,
 * 1–3 a message, free and instant), what "Just design it" assumes, and the one fact that
 * must be settled before any proposal: who sleeps where, when there are more people than
 * places. Deterministic: the same plan and brief give the same words.
 */

const NUMBERS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const count = (n: number, one: string, many = `${one}s`) =>
  `${NUMBERS[n] ?? String(n)} ${n === 1 ? one : many}`;
const Cap = (s: string) => (s ? `${s[0]?.toUpperCase()}${s.slice(1)}` : s);
const andList = (xs: string[]) =>
  xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;

const SHELTER = /shelter|bomb/i;
const BEDROOM_USE = new Set(['master', 'bedroom', 'kids', 'parents', 'guest']);

/** Rooms someone sleeps in (bedroom-use, largest first); the shelter too with a helper. */
export function bedroomsOf(
  level: Level,
  brief: DesignBrief,
): { id: string; name: string; area: number }[] {
  return Object.values(level.rooms)
    .filter((r) => {
      const use = brief.rooms[r.id]?.use;
      if (BEDROOM_USE.has(use ?? '') || (roomKind(r.name) === 'bedroom' && use !== 'keep'))
        return isDesigned(level, r.id);
      return brief.household.helper && SHELTER.test(r.name);
    })
    .sort((p, q) => roomArea(level, q) - roomArea(level, p) || (p.id < q.id ? -1 : 1))
    .map((r) => ({ id: r.id, name: r.name, area: roomArea(level, r) }));
}

const sleepRooms = (level: Level, brief: DesignBrief) =>
  bedroomsOf(level, brief).filter((r) => !SHELTER.test(r.name));

/**
 * Rooms that could be marked as bedrooms when the plan names none (a Study, an Office): the
 * designed ones that aren't wet, a kitchen, a living room or a shelter. Largest first.
 */
export function bedroomCandidates(level: Level): { id: string; name: string }[] {
  return Object.values(level.rooms)
    .filter(
      (r) =>
        isDesigned(level, r.id) &&
        !WET.test(r.name) &&
        !SHELTER.test(r.name) &&
        !['kitchen', 'living', 'none'].includes(roomKind(r.name)),
    )
    .sort((p, q) => roomArea(level, q) - roomArea(level, p) || (p.id < q.id ? -1 : 1))
    .map((r) => ({ id: r.id, name: r.name }));
}

/** The household as the checks name it, with a helper only where the brief places one. */
const sleepers = (brief: DesignBrief) => peopleOf(brief).filter((p) => p.kind !== 'helper');

/**
 * More people than places to sleep, and nobody said where: a decision for the household
 * before any proposal (criterion 21). The main bedroom sleeps two when there are two adults.
 */
export function sleepingConflict(
  brief: DesignBrief,
  level: Level,
): { people: number; bedrooms: number } | null {
  const said = Object.values(brief.sleeping ?? {}).some((ps) => ps.length > 0);
  if (said) return null;
  const people = sleepers(brief).length;
  const rooms = sleepRooms(level, brief).length;
  const places = rooms + (brief.household.adults >= 2 && rooms > 0 ? 1 : 0);
  return people > places ? { people, bedrooms: rooms } : null;
}

/** The greeting, from the plan: area, bedrooms, bathrooms, rooms open to each other. */
export function greeting(level: Level): string {
  const rooms = Object.values(level.rooms).filter((r) => !/ledge|balcony/i.test(r.name));
  const area = Math.round(rooms.reduce((t, r) => t + roomArea(level, r), 0));
  const bedrooms = rooms.filter((r) => roomKind(r.name) === 'bedroom').length;
  const baths = rooms.filter((r) => WET.test(r.name)).length;
  const parts: string[] = [];
  if (bedrooms) parts.push(count(bedrooms, 'bedroom'));
  if (baths) parts.push(count(baths, 'bathroom'));
  // Rooms joined by an open boundary: "the dry kitchen open to the living room".
  for (const s of spacesOf(level)) {
    if (s.rooms.length < 2) continue;
    const names = s.rooms
      .map((id) => level.rooms[id])
      .filter((r): r is NonNullable<typeof r> => !!r)
      .sort((p, q) => roomArea(level, p) - roomArea(level, q))
      .map((r) => r.name.toLowerCase());
    const [small, ...rest] = names;
    if (small && rest.length) parts.push(`the ${small} open to the ${andList(rest)}`);
  }
  const what = parts.length ? `, with ${andList(parts)}` : '';
  return `Hello. I’m your AI interior designer. I’ve looked at your plan: a flat of about ${area} m²${what}.`;
}

export const GREETING_NEXT =
  'A few quick questions first, so I design for the people who live here. They’re free. I’ll always show you the cost before anything uses your AI key.';

/** The questions in the order they are asked, a message at a time (UX §8.3). */
const MESSAGES: QuestionKey[][] = [
  ['who'],
  ['sleeping', 'mobility'],
  ['cooking', 'wfh'],
  ['budget', 'walls'],
  ['style', 'anything'],
];
/** At most this many questions in the first meeting. */
export const MAX_QUESTIONS = 8;

/** Whether a question applies to this household and plan. */
function applies(key: QuestionKey, brief: DesignBrief, level: Level): boolean {
  if (key === 'mobility') return brief.household.elders.length > 0;
  // With no bedrooms it is still asked: nobody is left without a bed in silence.
  if (key === 'sleeping') return sleepers(brief).length > 0;
  // Never asked in the first meeting (its 8 questions are for the rest): Typical is assumed,
  // and changed in What I know or with the chips on a card's storage line.
  if (key === 'owns') return false;
  return true;
}

/**
 * The next message of questions: those not answered, skipped or known yet, in order, or null
 * when the first meeting is over. `done` holds what was asked so far (and what a form already
 * told), so no more than MAX_QUESTIONS are ever asked.
 */
export function nextQuestions(
  done: ReadonlySet<QuestionKey>,
  brief: DesignBrief,
  level: Level,
  /** Questions asked so far (facts a form told don't count). */
  askedSoFar = done.size,
): { keys: QuestionKey[]; lead: string | null } | null {
  let asked = askedSoFar;
  for (const msg of MESSAGES) {
    const keys: QuestionKey[] = [];
    for (const k of msg) {
      if (done.has(k) || !applies(k, brief, level)) continue;
      if (asked >= MAX_QUESTIONS) break;
      keys.push(k);
      asked++;
    }
    if (!keys.length) continue;
    const c = keys.includes('sleeping') ? sleepingConflict(brief, level) : null;
    const lead = c
      ? `${Cap(count(c.people, 'person', 'people'))} and ${count(c.bedrooms, 'bedroom')}, so this needs a decision.`
      : null;
    return { keys, lead };
  }
  return null;
}

/** The question as asked. */
export function questionText(key: QuestionKey, brief: DesignBrief): string {
  switch (key) {
    case 'who':
      return 'Who lives here?';
    case 'sleeping':
      return 'Who sleeps where?';
    case 'mobility': {
      const elders = peopleOf(brief).filter((p) => p.kind === 'elder');
      const named = elders.length === 1 ? brief.names?.[elders[0]?.key ?? '']?.trim() : null;
      return elders.length === 1
        ? `How does ${named || 'your parent'} get about?`
        : 'How do your parents get about?';
    }
    case 'cooking':
      return 'How do you cook?';
    case 'wfh':
      return 'Does anyone work from home?';
    case 'owns':
      return 'How much do you own?';
    case 'budget':
      return 'What’s your renovation budget?';
    case 'walls':
      return 'Can walls change?';
    case 'style':
      return 'Any style in mind?';
    case 'anything':
      return 'Anything you want to keep, or anything I should know?';
  }
}

/** Budget answers (S$), as v1's form has them. */
export const BUDGET_CHOICES: {
  id: string;
  label: string;
  v: { low: number; high: number } | null;
}[] = [
  { id: 'u30', label: 'Under S$30k', v: { low: 15_000, high: 30_000 } },
  { id: '30-50', label: 'S$30–50k', v: { low: 30_000, high: 50_000 } },
  { id: '50-80', label: 'S$50–80k', v: { low: 50_000, high: 80_000 } },
  { id: 'o80', label: 'Over S$80k', v: { low: 80_000, high: 150_000 } },
  { id: 'unsure', label: 'Not sure', v: null },
];
export const WALL_CHOICES: { id: DesignBrief['walls']; label: string; line: string }[] = [
  { id: 'keep', label: 'Keep all walls', line: 'Furniture, paint and floors only.' },
  {
    id: 'allowed',
    label: 'Walls HDB normally allows',
    line: 'Hacking and new partitions HDB permits.',
  },
  {
    id: 'structural',
    label: 'Structural changes too',
    line: 'Needs HDB approval and an engineer.',
  },
];
export const COOKING_CHOICES: { id: DesignBrief['lifestyle']['cooking']; label: string }[] = [
  { id: 'light', label: 'Lightly, now and then' },
  { id: 'daily', label: 'Every day' },
  { id: 'heavy', label: 'A lot: big meals, wok' },
];
export const WFH_CHOICES: { id: DesignBrief['lifestyle']['wfh']; label: string }[] = [
  { id: 0, label: 'No one' },
  { id: 1, label: 'One of us' },
  { id: 2, label: 'Two of us' },
];
/** How much they own: the storage meter's own choices and words (shared with its setting). */
export const OWNS_CHOICES: { id: NonNullable<DesignBrief['owns']>; label: string }[] = [
  { id: 'few', label: 'Few things' },
  { id: 'typical', label: 'Typical' },
  { id: 'lots', label: 'Lots' },
];
export const MOBILITY_CHOICES: { id: DesignBrief['household']['elders'][number]; label: string }[] =
  [
    { id: 'walks', label: 'Walks unaided' },
    { id: 'stick', label: 'Uses a stick' },
    { id: 'frame', label: 'Uses a walking frame' },
    { id: 'wheelchair', label: 'Uses a wheelchair' },
  ];

/** "S$42.5k" (thousands, to one place where it isn't whole). */
const thousands = (v: number) => `${Math.round(v / 100) / 10}`;
/** A range ("S$30–50k"), or the one figure given ("S$40k"). */
export const budgetWords = (b: DesignBrief['budget']) =>
  !b
    ? 'not set'
    : b.low === b.high
      ? `S$${thousands(b.high)}k`
      : `S$${thousands(b.low)}–${thousands(b.high)}k`;

/**
 * What to call a person when the household gave no name: "You", "Partner", "Parent", "Child"
 * (numbered only when there are several), never "Adult 1" or "Elder 1".
 */
export function personLabel(p: Person, brief: DesignBrief): string {
  const named = brief.names?.[p.key]?.trim();
  if (named) return named;
  const h = brief.household;
  const n = Number(p.key.split('-')[1] ?? '1');
  switch (p.kind) {
    case 'adult':
      return n === 1 ? 'You' : n === 2 ? 'Partner' : `Adult ${n}`;
    case 'child':
      return h.children.length > 1 ? `Child ${n}` : 'Child';
    case 'elder':
      return h.elders.length > 1 ? `Parent ${n}` : 'Parent';
    default:
      return 'Helper';
  }
}

/**
 * Who sleeps where when nobody said: the checks' own guess, with anyone it leaves out sharing
 * the smallest bedroom (two single beds), so the guess places everyone.
 */
export function guessSleeping(brief: DesignBrief, level: Level): Record<string, string[]> {
  const rooms = sleepRooms(level, brief);
  const plan = sleepingPlan(brief, rooms);
  const sleeping: Record<string, string[]> = {};
  for (const [id, ps] of plan.rooms) sleeping[id] = ps.map((p) => p.key);
  const last = rooms[rooms.length - 1];
  if (plan.unplaced.length && last) {
    sleeping[last.id] = [...(sleeping[last.id] ?? []), ...plan.unplaced.map((p) => p.key)];
  }
  return sleeping;
}

/** Who is in which room, in words: "Rachel and Daniel in Main bedroom; Sophie in Bedroom". */
export function sleepingWords(brief: DesignBrief, level: Level): string {
  const plan = sleepingPlan(brief, sleepRooms(level, brief), (id) => !!level.rooms[id]);
  const lines = [...plan.rooms].map(
    ([id, ps]) =>
      `${andList(ps.map((p) => personLabel(p, brief)))} in ${level.rooms[id]?.name ?? 'a room'}`,
  );
  if (plan.unplaced.length) {
    lines.push(
      `${andList(plan.unplaced.map((p) => personLabel(p, brief)))}: no room yet${
        plan.rooms.size === 0 ? ' (the plan has no bedroom; say which rooms people sleep in)' : ''
      }`,
    );
  }
  return lines.join('; ') || 'Not said';
}

function whoWords(brief: DesignBrief): string {
  const ps = peopleOf(brief);
  if (!ps.length) return 'No one yet';
  const detail = (p: Person) =>
    p.kind === 'elder' && p.detail && p.detail !== 'walks'
      ? ` (${MOBILITY_CHOICES.find((m) => m.id === p.detail)?.label.toLowerCase()})`
      : '';
  return andList(ps.map((p) => `${personLabel(p, brief)}${detail(p)}`));
}

/** A fact as What I know shows it, and as the person's answer reads in the log. */
export function factText(key: QuestionKey, brief: DesignBrief, level: Level): string {
  const h = brief.household;
  switch (key) {
    case 'who': {
      const parts = [count(h.adults, 'adult')];
      if (h.children.length) parts.push(count(h.children.length, 'child', 'children'));
      if (h.elders.length) parts.push(count(h.elders.length, 'older parent'));
      if (h.helper) parts.push('a live-in helper');
      const named = peopleOf(brief).some((p) => brief.names?.[p.key]?.trim());
      return named ? whoWords(brief) : Cap(andList(parts));
    }
    case 'sleeping':
      return sleepingWords(brief, level);
    case 'mobility':
      return (
        peopleOf(brief)
          .filter((p) => p.kind === 'elder')
          .map(
            (p) =>
              `${personLabel(p, brief)} ${MOBILITY_CHOICES.find((m) => m.id === p.detail)?.label.toLowerCase() ?? 'walks unaided'}`,
          )
          .join('; ') || 'No older parents'
      );
    case 'cooking':
      return COOKING_CHOICES.find((c) => c.id === brief.lifestyle.cooking)?.label ?? 'Every day';
    case 'wfh':
      return WFH_CHOICES.find((c) => c.id === brief.lifestyle.wfh)?.label ?? 'No one';
    case 'owns':
      return OWNS_CHOICES.find((c) => c.id === (brief.owns ?? 'typical'))?.label ?? 'Typical';
    case 'budget':
      return brief.budget ? budgetWords(brief.budget) : 'Not sure';
    case 'walls':
      return WALL_CHOICES.find((w) => w.id === brief.walls)?.label ?? '';
    case 'style':
      return brief.style === 'designer' ? 'The designer’s choice' : STYLE_NAMES[brief.style];
    case 'anything': {
      const t = [brief.keep.text, brief.household.text].filter((x) => x.trim()).join(' · ');
      return t || 'Nothing to add';
    }
  }
}

/** What I know's label for a fact. */
export const FACT_LABELS: Record<QuestionKey, string> = {
  who: 'Who lives here',
  sleeping: 'Who sleeps where',
  mobility: 'Getting about',
  cooking: 'Cooking',
  wfh: 'Working from home',
  owns: 'How much you own',
  budget: 'Budget',
  walls: 'Walls',
  style: 'Style',
  anything: 'Anything else',
};

/**
 * "Just design it": the facts not answered yet, assumed. Who sleeps where follows the checks'
 * own assumption (sharing where people outnumber rooms); no budget means a typical range is
 * aimed at; walls only as HDB normally allows; the style the designer's choice.
 */
export function assume(
  brief: DesignBrief,
  level: Level,
  done: ReadonlySet<QuestionKey>,
): { brief: DesignBrief; keys: QuestionKey[]; lines: string[] } {
  let next: DesignBrief = structuredClone(brief);
  const keys: QuestionKey[] = [];
  const lines: string[] = [];
  const open = (k: QuestionKey) => !done.has(k) && applies(k, next, level);
  if (open('sleeping')) {
    next = { ...next, sleeping: guessSleeping(next, level) };
    keys.push('sleeping');
    lines.push(sleepingWords(next, level));
  }
  if (open('budget')) {
    keys.push('budget');
    lines.push('No budget given: I’ll aim for a typical renovation for a flat this size.');
  }
  if (open('walls')) {
    next = { ...next, walls: 'allowed' };
    keys.push('walls');
    lines.push('Walls: only ones HDB normally allows.');
  }
  if (open('style')) {
    next = { ...next, style: 'designer' };
    keys.push('style');
    lines.push('Style: my choice, warm and calm.');
  }
  for (const k of ['who', 'mobility', 'cooking', 'wfh'] as const) {
    if (!open(k)) continue;
    keys.push(k);
    const fact = factText(k, next, level);
    // "Cooking: every day." (a sentence of its own, the fact's first letter lowered only when
    // it is no name).
    const said =
      k === 'who' || k === 'mobility' ? fact : `${fact[0]?.toLowerCase()}${fact.slice(1)}`;
    lines.push(`${FACT_LABELS[k]}: ${said}.`);
  }
  return { brief: next, keys, lines };
}

/** What a form told, said once: "2 adults, 1 older parent who uses a stick, S$30–50k". */
export function formSummary(brief: DesignBrief): string {
  const h = brief.household;
  const parts = [count(h.adults, 'adult')];
  if (h.children.length) parts.push(count(h.children.length, 'child', 'children'));
  for (const e of h.elders) {
    parts.push(
      `one older parent who ${e === 'walks' ? 'walks unaided' : (MOBILITY_CHOICES.find((m) => m.id === e)?.label.toLowerCase() ?? '')}`,
    );
  }
  if (brief.budget) parts.push(budgetWords(brief.budget));
  return parts.join(', ');
}

/** The facts a filled-in form answers (all but who sleeps where, unless it says). */
export function formKnows(brief: DesignBrief): QuestionKey[] {
  const said = Object.values(brief.sleeping ?? {}).some((ps) => ps.length);
  return [
    'who',
    'mobility',
    'cooking',
    'wfh',
    'budget',
    'walls',
    'style',
    'anything',
    ...(said ? (['sleeping'] as const) : []),
  ];
}
