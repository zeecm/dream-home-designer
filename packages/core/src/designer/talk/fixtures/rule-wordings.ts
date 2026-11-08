/**
 * House rules as a model offers them (slice 3a tech §8, "a new wording needs no code"): the
 * household's words and a recorded reply whose `memory.rule` fills the rule object, on the sample
 * flat's aliases (R1 Bedroom, R2 Main bedroom, R3 Living and dining, D8 Bath/WC 2's door, D9 the
 * main door). The test runs each through parse → vet → checks on the furnished sample, so adding
 * a row is all a new wording needs.
 */

type RuleObject = {
  name: string;
  subject: { kind: string; id: string | null };
  relation: string;
  target: {
    kind: string;
    id: string | null;
    rooms: string[];
    at: { x: number; y: number } | null;
    r: number | null;
  };
  n: number | null;
};

const target = (t: Partial<RuleObject['target']> & { kind: string }): RuleObject['target'] => ({
  id: null,
  rooms: [],
  at: null,
  r: null,
  ...t,
});

/** A reply offering `rule` (or a wish with no rule: `rule` null and a decision). */
export const ruleReply = (say: string, rule: RuleObject | null, decisions: unknown[] = []) => ({
  kind: 'reply',
  say,
  questions: [],
  concern: null,
  plan: null,
  memory: { decisions, facts: [], notes: [], rule },
  fold: null,
});

/** Criterion 39's rule: never anything in the corridor (the way to both bedrooms). */
export const CORRIDOR_RULE: RuleObject = {
  name: 'Never anything in the corridor',
  subject: { kind: 'any', id: null },
  relation: 'notIn',
  target: target({ kind: 'route', rooms: ['R2', 'R1'] }),
  n: null,
};

export const REPLY_RULE = ruleReply(
  'Got it. A clear way through matters, especially for Mdm Koh with her stick.',
  CORRIDOR_RULE,
);

/** Criterion 40: a wish no rule can hold, noted and not checked. */
export const REPLY_WISH = ruleReply(
  'Noted. I’ll keep the palette light and the windows clear so it feels airier.',
  null,
  [{ kind: 'wish', text: 'Feel more airy', target: null }],
);

export interface Wording {
  words: string;
  reply: ReturnType<typeof ruleReply>;
  /** The app's sentence for it, on the sample. */
  sentence: string;
  /** How many of its checks the furnished sample with a console in the passage fails. */
  fails: number;
}

export const WORDINGS: Wording[] = [
  {
    words: 'never anything in the corridor',
    reply: REPLY_RULE,
    sentence:
      'Nothing in the way from the main door to Main bedroom and Bedroom, with 0.90 m clear',
    fails: 2,
  },
  {
    words: 'keep the passage empty',
    reply: ruleReply('I’ll keep the passage clear.', {
      ...CORRIDOR_RULE,
      name: 'Keep the passage empty',
      target: target({ kind: 'route', rooms: ['R1'] }),
    }),
    sentence: 'Nothing in the way from the main door to Bedroom, with 0.90 m clear',
    fails: 2,
  },
  {
    words: 'nothing in the hallway please, a good metre',
    reply: ruleReply('A metre is comfortable for two people passing.', {
      name: 'Nothing in the hallway',
      subject: { kind: 'any', id: null },
      relation: 'keepClear',
      target: target({ kind: 'route', rooms: ['R2'] }),
      n: 1,
    }),
    sentence: 'Keep 1.00 m clear from the main door to Main bedroom',
    fails: 1,
  },
  {
    words: 'the sofa must face the window',
    reply: ruleReply('The view is the best thing in that room.', {
      name: 'The sofa must face the window',
      subject: { kind: 'kind', id: 'sofa' },
      relation: 'faces',
      target: target({ kind: 'window' }),
      n: null,
    }),
    sentence: 'The sofa faces the window',
    fails: 0,
  },
  {
    words: 'Mum’s bed near the toilet',
    reply: ruleReply('At night that matters with a stick.', {
      name: 'Mum’s bed near the toilet',
      subject: { kind: 'kind', id: 'bed-single' },
      relation: 'within',
      target: target({ kind: 'opening', id: 'D8' }),
      n: 1.5,
    }),
    sentence: 'The single bed within 1.50 m of Bath/WC 2’s door',
    fails: 1,
  },
  {
    words: 'keep the shoe cabinet by the door',
    reply: ruleReply('Shoes off at the door, then.', {
      name: 'Shoe cabinet by the door',
      subject: { kind: 'kind', id: 'shoe-cabinet' },
      relation: 'within',
      target: target({ kind: 'opening', id: 'main door' }),
      n: 1.5,
    }),
    sentence: 'The shoe cabinet within 1.50 m of the main door',
    // No shoe cabinet in the plan: a rule never forces one in.
    fails: 0,
  },
  {
    words: 'TV at least 2.4 m from the sofa',
    reply: ruleReply('About right for a 55-inch screen.', {
      name: 'TV at least 2.4 m from the sofa',
      subject: { kind: 'kind', id: 'tv-console' },
      relation: 'atLeast',
      target: target({ kind: 'kind', id: 'sofa-3' }),
      n: 2.4,
    }),
    sentence: 'The TV console at least 2.40 m from the 3-seat sofa',
    // The living room's console is 2.95 m from it; the one in the passage is nearer.
    fails: 1,
  },
  {
    words: 'no tall furniture in our bedroom',
    reply: ruleReply('Low pieces keep it calm.', {
      name: 'No tall furniture in our bedroom',
      subject: { kind: 'category', id: 'tall pieces' },
      relation: 'notIn',
      target: target({ kind: 'room', id: 'R2' }),
      n: null,
    }),
    sentence: 'No tall pieces in Main bedroom',
    fails: 1,
  },
];
