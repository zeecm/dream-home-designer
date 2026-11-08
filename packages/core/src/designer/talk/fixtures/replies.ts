/**
 * Talk replies as a model streams them (one JSON object each, on the sample flat's aliases:
 * R2 Main bedroom, R3 Living and dining, R1 Bedroom, R9 Kitchen; W21 a shelter wall, W6 a
 * structural one). Used by the parser's, the streaming scanner's and the web's tests.
 */

const memory = (m: Partial<{ decisions: unknown[]; facts: unknown[]; notes: unknown[] }> = {}) => ({
  decisions: [],
  facts: [],
  notes: [],
  rule: null,
  ...m,
});

const none = { questions: [], concern: null, plan: null, fold: null };

export const REPLY_TEXT = {
  kind: 'reply',
  say: 'A 2.4 m sofa would fill the wall under the window; a 2-seater leaves room for the TV console, and the walkway to the bedrooms stays clear.',
  ...none,
  memory: memory(),
};

export const REPLY_REJECT = {
  kind: 'reply',
  say: 'Understood: no sofa under the window. I’ll keep it on the wall facing the TV.',
  ...none,
  memory: memory({
    decisions: [{ kind: 'rejected', text: 'No sofa under the window', target: null }],
    facts: [{ key: 'budget', text: 'about S$40k', number: 40000, choice: null }],
    notes: ['Move the WC 0.5 m: a plumbing move, for your ID'],
  }),
};

export const REPLY_QUESTION = {
  kind: 'question',
  say: 'Before I redo the kitchen: two quick things.',
  questions: [
    {
      text: 'How do you cook?',
      fact: 'cooking',
      pick: 'one',
      choices: ['light', 'daily', 'heavy'],
    },
    { text: 'Do you want a breakfast counter?', fact: null, pick: 'one', choices: ['Yes', 'No'] },
  ],
  concern: null,
  plan: null,
  memory: memory(),
  fold: null,
};

export const REPLY_CONCERN = {
  kind: 'concern',
  say: 'A dining table there would leave about 0.6 m to walk past. I’d keep it in the dining area and put a 0.30 m-deep console by the door instead, for keys and post.',
  questions: [],
  concern: {
    rule: 'walkway',
    wall: null,
    // The person's ask, where they asked for it: the corridor strip by the bedrooms.
    probe: {
      room: 'R3',
      assetId: 'dining-6',
      against: 'free',
      wall: null,
      along: null,
      at: { x: 5.05, y: 3.67 },
    },
  },
  plan: {
    title: 'A console by the door',
    rooms: ['R3'],
    walls: false,
    aspects: ['furniture'],
    options: [{ name: 'Console', intent: 'A 0.30 m-deep console by the main door; dining stays.' }],
    assumptions: [],
  },
  memory: memory(),
  fold: null,
};

export const REPLY_SHELTER = {
  kind: 'concern',
  say: 'That wall belongs to the household shelter.',
  questions: [],
  concern: { rule: 'shelter', wall: 'W21', probe: null },
  plan: null,
  memory: memory(),
  fold: null,
};

export const REPLY_PLAN = {
  kind: 'plan',
  say: 'I’ll move the sofa off the window and bring the dining table nearer the kitchen, then do the main bedroom.',
  questions: [],
  concern: null,
  plan: {
    title: 'Sofa off the window, dining by the kitchen',
    rooms: ['R3', 'R2'],
    walls: false,
    aspects: ['furniture'],
    options: [
      { name: 'A', intent: 'Sofa on the wall facing the TV; dining table by the dry kitchen.' },
      { name: 'B', intent: 'An L-shaped sofa.' },
      { name: 'C', intent: 'A daybed by the window.' },
      { name: 'D', intent: 'One too many.' },
    ],
    assumptions: ['You eat at the table most days'],
  },
  memory: memory(),
  fold: null,
};

export const REPLY_FOLD = {
  ...REPLY_TEXT,
  fold: 'They want a calm living room, no sofa under the window, and the budget is about S$40k.',
};

/** Every recorded reply, as the text a provider streams. */
export const RECORDED: string[] = [
  REPLY_TEXT,
  REPLY_REJECT,
  REPLY_QUESTION,
  REPLY_CONCERN,
  REPLY_SHELTER,
  REPLY_PLAN,
  REPLY_FOLD,
].map((r) => JSON.stringify(r));

/** One with escapes, a pair of surrogates (an emoji) and accented text, pretty-printed. */
export const RECORDED_ESCAPES = JSON.stringify(
  {
    kind: 'reply',
    say: 'Line one,\n“quoted” \\ back\tslash é, emoji 🙂 and 🙃 then é.',
    ...none,
    memory: memory(),
  },
  null,
  2,
)
  .replace('é', '\\u00e9')
  .replace('🙂', '\\ud83d\\ude42');
