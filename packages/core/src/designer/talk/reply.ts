import { type AliasMap, resolveAlias } from '../aliases';
import { AGAINST, type DesignBrief, StyleId } from '../schema';
import { clean } from '../util';
import { BUDGET_CHOICES, COOKING_CHOICES, WFH_CHOICES } from './firstMeeting';
import {
  FACT_KEYS,
  type FactKey,
  type QuestionKey,
  type ScopeRef,
  TalkConcern,
  type TalkPlan,
  type TalkQuestion,
  cut,
} from './schema';

/**
 * The designer's reply to a message (a talk call, tech §2.2): one JSON object of one of four
 * kinds. `kind` and `say` come first so they stream first. The model never writes geometry here
 * (a concern's probe is one piece for the app to place and check), never writes household
 * counts or who sleeps where, and never says whether a check passes: the app does.
 */

export const TALK_KINDS = ['reply', 'question', 'concern', 'plan'] as const;
export type TalkKind = (typeof TALK_KINDS)[number];
/** What a pushback is about. */
const RULES = TalkConcern.shape.rule.options;

/** How long each part may be (the model is told; the app cuts what is longer). */
export const REPLY_LIMITS = {
  say: 900,
  question: 200,
  choice: 40,
  choices: 6,
  questions: 3,
  title: 60,
  intent: 600,
  assumptions: 5,
  assumption: 200,
  decisions: 3,
  decision: 160,
  facts: 6,
  fact: 200,
  notes: 3,
  note: 200,
  fold: 1200,
} as const;

const str = { type: 'string' };
const num = { type: 'number' };
const bool = { type: 'boolean' };
const nullable = (s: object) => ({ anyOf: [s, { type: 'null' }] });
const obj = (properties: Record<string, unknown>) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const arr = (items: unknown) => ({ type: 'array', items });
const point = obj({ x: num, y: num });

/** One schema for every reply (closed, every property required, unused ones null or []). */
export const TALK_SCHEMA = obj({
  kind: { type: 'string', enum: [...TALK_KINDS] },
  say: str,
  questions: arr(
    obj({
      text: str,
      fact: nullable({ type: 'string', enum: [...FACT_KEYS] }),
      pick: { type: 'string', enum: ['one', 'many', 'text'] },
      choices: arr(str),
    }),
  ),
  concern: nullable(
    obj({
      rule: { type: 'string', enum: [...RULES] },
      wall: nullable(str),
      probe: nullable(
        obj({
          room: str,
          assetId: str,
          against: { type: 'string', enum: [...AGAINST] },
          wall: nullable(str),
          along: nullable(num),
          at: nullable(point),
        }),
      ),
    }),
  ),
  plan: nullable(
    obj({
      title: str,
      rooms: arr(str),
      walls: bool,
      aspects: arr({ type: 'string', enum: ['furniture', 'built-ins', 'finishes'] }),
      options: arr(obj({ name: str, intent: str })),
      assumptions: arr(str),
    }),
  ),
  memory: obj({
    decisions: arr(
      obj({
        kind: { type: 'string', enum: ['rejected', 'keep', 'wish'] },
        text: str,
        target: nullable(str),
      }),
    ),
    facts: arr(
      obj({
        key: { type: 'string', enum: [...FACT_KEYS] },
        text: str,
        number: nullable(num),
        choice: nullable(str),
      }),
    ),
    notes: arr(str),
  }),
  fold: nullable(str),
});

/** The one piece a pushback asks the app to place and check (free). */
export interface ProbeAsk {
  roomId: string;
  assetId: string;
  against: (typeof AGAINST)[number];
  wallId: string | null;
  along: number | null;
  at: { x: number; y: number } | null;
}

export interface TalkFact {
  key: FactKey;
  text: string;
  number: number | null;
  choice: string | null;
}

/** A reply as the app reads it: every alias resolved, every text cut, salvaged where it can. */
export interface TalkReply {
  kind: TalkKind;
  say: string;
  questions: TalkQuestion[];
  concern: {
    rule: TalkConcern['rule'];
    wallId: string | null;
    probe: ProbeAsk | null;
    alt: TalkPlan | null;
  } | null;
  plan: TalkPlan | null;
  memory: {
    decisions: { kind: 'rejected' | 'keep' | 'wish'; text: string }[];
    facts: TalkFact[];
    notes: string[];
  };
  fold: string | null;
}

export interface TalkParseContext {
  aliases: AliasMap;
  /** The plan's spaces: key, name and rooms (a plan names rooms; a run asks for spaces). */
  spaces: { key: string; name: string; rooms: string[] }[];
  walls: DesignBrief['walls'];
}

export type TalkParse =
  | { ok: true; reply: TalkReply; lines: string[] }
  | { ok: false; error: string };

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null;
const asStr = (v: unknown, max: number) => (typeof v === 'string' ? cut(v, max) : '');
const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const lower = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const finite = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** Where a plan's rooms are: the spaces they are in, in the designer's order of priority. */
function scopeOf(
  rooms: unknown[],
  ctx: TalkParseContext,
): { scope: ScopeRef; just: ScopeRef | null; unknown: number } | null {
  if (rooms.some((r) => lower(r) === 'all')) {
    return { scope: { label: 'The whole flat', spaces: [], all: true }, just: null, unknown: 0 };
  }
  const keys: string[] = [];
  let unknown = 0;
  for (const r of rooms) {
    if (typeof r !== 'string') continue;
    const id = resolveAlias(ctx.aliases, r);
    const space = id ? ctx.spaces.find((s) => s.rooms.includes(id)) : undefined;
    if (!space) {
      unknown++;
      continue;
    }
    if (!keys.includes(space.key)) keys.push(space.key);
  }
  if (!keys.length) return null;
  const named = keys.map(
    (k) => ctx.spaces.find((s) => s.key === k) as TalkParseContext['spaces'][number],
  );
  // Commas between names that have "and" in them: "Living and dining, and Main bedroom".
  const names = named.map((s) => s.name);
  const label = cut(
    names.length <= 1
      ? (names[0] ?? '')
      : `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`,
    80,
  );
  const first = named[0] as TalkParseContext['spaces'][number];
  return {
    scope: { label, spaces: keys, all: false },
    just: keys.length > 1 ? { label: cut(first.name, 80), spaces: [first.key], all: false } : null,
    unknown,
  };
}

function planOf(raw: unknown, ctx: TalkParseContext, lines: string[]): TalkPlan | null {
  const p = asObj(raw);
  if (!p) return null;
  const where = scopeOf(asList(p.rooms), ctx);
  if (!where) return null;
  if (where.unknown)
    lines.push('The designer named a room this plan doesn’t have; it was left out.');
  let scope = where.scope;
  if (p.walls === true) {
    if (ctx.walls === 'keep') lines.push('Walls stay: you chose to keep them.');
    // The layout step designs the whole flat.
    else scope = { label: 'The whole flat', spaces: [], all: true, walls: true };
  } else if (scope.all) scope = { ...scope, walls: false };
  const options = asList(p.options)
    .map(asObj)
    .filter((o): o is Obj => !!o);
  const title = asStr(p.title, REPLY_LIMITS.title) || 'A new idea';
  const intent =
    asStr(options[0]?.intent, REPLY_LIMITS.intent) ||
    asStr(options[0]?.name, REPLY_LIMITS.intent) ||
    title;
  return {
    title,
    scope,
    just: scope.all ? null : where.just,
    intent,
    assumptions: asList(p.assumptions)
      .map((a) => asStr(a, REPLY_LIMITS.assumption))
      .filter(Boolean)
      .slice(0, REPLY_LIMITS.assumptions),
  };
}

function questionsOf(raw: unknown): TalkQuestion[] {
  const out: TalkQuestion[] = [];
  for (const q of asList(raw)) {
    const o = asObj(q);
    const text = asStr(o?.text, REPLY_LIMITS.question);
    if (!o || !text) continue;
    const fact = (FACT_KEYS as readonly string[]).includes(lower(o.fact))
      ? (lower(o.fact) as FactKey)
      : null;
    const pick = (['one', 'many', 'text'] as const).find((x) => x === lower(o.pick)) ?? 'one';
    const choices = asList(o.choices)
      .map((c) => asStr(c, REPLY_LIMITS.choice))
      .filter(Boolean)
      .filter((c, i, all) => all.indexOf(c) === i)
      .slice(0, REPLY_LIMITS.choices);
    out.push({ text, fact, pick: choices.length ? pick : 'text', choices });
    if (out.length === REPLY_LIMITS.questions) break;
  }
  return out;
}

function probeOf(raw: unknown, ctx: TalkParseContext): ProbeAsk | null {
  const p = asObj(raw);
  if (!p) return null;
  const roomId = resolveAlias(ctx.aliases, typeof p.room === 'string' ? p.room : null);
  const assetId = asStr(p.assetId, 60);
  if (!roomId || !assetId) return null;
  const against = (AGAINST as readonly string[]).includes(lower(p.against))
    ? (lower(p.against) as ProbeAsk['against'])
    : 'wall';
  const at = asObj(p.at);
  const ax = finite(at?.x);
  const ay = finite(at?.y);
  return {
    roomId,
    assetId,
    against,
    wallId: resolveAlias(ctx.aliases, typeof p.wall === 'string' ? p.wall : null),
    along: finite(p.along),
    at: ax !== null && ay !== null ? { x: ax, y: ay } : null,
  };
}

/** A fact the reply would note, checked for its key; null when it doesn't fit. */
function factOf(raw: unknown): TalkFact | null {
  const o = asObj(raw);
  const key = lower(o?.key);
  if (!o || !(FACT_KEYS as readonly string[]).includes(key)) return null;
  const text = asStr(o.text, REPLY_LIMITS.fact);
  const number = finite(o.number);
  const choice = typeof o.choice === 'string' ? o.choice.trim() : null;
  const k = key as FactKey;
  const ok =
    k === 'budget'
      ? (number !== null && number >= 1000 && number <= 2_000_000) ||
        BUDGET_CHOICES.some((c) => c.id === choice)
      : k === 'walls'
        ? ['keep', 'allowed', 'structural'].includes(lower(choice))
        : k === 'style'
          ? StyleId.safeParse(lower(choice)).success
          : k === 'cooking'
            ? COOKING_CHOICES.some((c) => c.id === lower(choice))
            : k === 'wfh'
              ? // One of the two must say it: a missing figure is never "No one".
                (number !== null || (choice !== null && choice.trim() !== '')) &&
                WFH_CHOICES.some((c) => c.id === (number ?? Number(choice)))
              : !!text;
  if (!ok) return null;
  return { key: k, text, number, choice: choice ? cut(choice, 40) : null };
}

/**
 * Reads a reply. A bad list entry is dropped, not the reply; aliases are resolved against the
 * conversation's map; what can't be used turns into a plain reply with the app's line saying
 * why. Unusable (no JSON object, nothing to say): not ok, and the request is tried again once.
 */
export function parseTalkReply(raw: unknown, ctx: TalkParseContext): TalkParse {
  const o = asObj(raw);
  if (!o) return { ok: false, error: 'not a JSON object' };
  const lines: string[] = [];
  const say = asStr(o.say, REPLY_LIMITS.say);
  let kind = (TALK_KINDS as readonly string[]).includes(lower(o.kind))
    ? (lower(o.kind) as TalkKind)
    : null;
  if (!kind) {
    if (!say) return { ok: false, error: 'no kind and nothing said' };
    kind = 'reply';
  }
  const questions = kind === 'question' ? questionsOf(o.questions) : [];
  if (kind === 'question' && !questions.length) kind = 'reply';
  let plan: TalkPlan | null = null;
  let concern: TalkReply['concern'] = null;
  if (kind === 'plan') {
    plan = planOf(o.plan, ctx, lines);
    if (!plan) {
      kind = 'reply';
      lines.push('The designer’s plan didn’t name a room in this plan.');
    }
  } else if (kind === 'concern') {
    const c = asObj(o.concern);
    const rule = (RULES as readonly string[]).includes(lower(c?.rule))
      ? (lower(c?.rule) as TalkConcern['rule'])
      : 'other';
    // A room or a wall the plan doesn't have: said plainly (never a silent pushback).
    // Said in words, never by its short id (the designer's R99 means nothing to the person).
    const missing = (v: unknown) =>
      typeof v === 'string' && !!v.trim() && !resolveAlias(ctx.aliases, v);
    const probeRaw = asObj(c?.probe);
    if (missing(probeRaw?.room))
      lines.push('I couldn’t find the room the designer meant in this plan.');
    if (missing(c?.wall) || missing(probeRaw?.wall)) {
      lines.push('I couldn’t find the wall the designer meant in this plan.');
    }
    concern = c
      ? {
          rule,
          wallId: resolveAlias(ctx.aliases, typeof c.wall === 'string' ? c.wall : null),
          probe: probeOf(c.probe, ctx),
          alt: planOf(o.plan, ctx, []),
        }
      : null;
    if (!concern) kind = 'reply';
  }
  if (!say && kind === 'reply') return { ok: false, error: 'nothing said' };
  const m = asObj(o.memory);
  const decisions = asList(m?.decisions)
    .map(asObj)
    .flatMap((d) => {
      const k = lower(d?.kind);
      const text = asStr(d?.text, REPLY_LIMITS.decision);
      return d && text && (k === 'rejected' || k === 'keep' || k === 'wish')
        ? [{ kind: k as 'rejected' | 'keep' | 'wish', text }]
        : [];
    })
    .slice(0, REPLY_LIMITS.decisions);
  const facts = asList(m?.facts)
    .map(factOf)
    .filter((f): f is TalkFact => !!f)
    .slice(0, REPLY_LIMITS.facts);
  const notes = asList(m?.notes)
    .map((n) => asStr(n, REPLY_LIMITS.note))
    .filter(Boolean)
    .slice(0, REPLY_LIMITS.notes);
  const fold = asStr(o.fold, REPLY_LIMITS.fold) || null;
  return {
    ok: true,
    reply: { kind, say, questions, concern, plan, memory: { decisions, facts, notes }, fold },
    lines,
  };
}

const WALLS_ORDER: DesignBrief['walls'][] = ['keep', 'allowed', 'structural'];

/**
 * Whether a fact would widen what the next paid run may do: walls loosened (keep to allowed or
 * structural) or the budget raised. The model never does that by itself: the person confirms
 * it with a free chip.
 */
export function widens(brief: DesignBrief, f: TalkFact): boolean {
  if (f.key === 'walls') {
    const to = lower(f.choice) as DesignBrief['walls'];
    return WALLS_ORDER.indexOf(to) > WALLS_ORDER.indexOf(brief.walls);
  }
  if (f.key === 'budget') {
    const c = BUDGET_CHOICES.find((x) => x.id === f.choice);
    const high = c ? (c.v?.high ?? null) : f.number;
    // Not sure (no figure) or a higher one, over a budget given: wider.
    return !!brief.budget && (high === null || high > brief.budget.high);
  }
  return false;
}

/** The question a widening fact asks the person ("Allow structural changes?"). */
export function confirmText(f: TalkFact): string {
  if (f.key === 'walls') {
    const to = lower(f.choice);
    return to === 'structural'
      ? 'Allow structural changes too (they need HDB approval and an engineer)?'
      : 'Allow the wall changes HDB normally allows?';
  }
  const c = BUDGET_CHOICES.find((x) => x.id === f.choice);
  const high = c ? (c.v?.high ?? null) : f.number;
  return high === null ? 'Take the budget off?' : `Raise the budget to ${sgd(high)}?`;
}

/** The What I know fact a reply's fact is about (Assumed comes off it once noted). */
export const factQuestion = (k: FactKey): QuestionKey =>
  k === 'budget' || k === 'walls' || k === 'style' || k === 'cooking' || k === 'wfh'
    ? k
    : 'anything';

function sgd(n: number) {
  return `S$${n >= 1000 ? `${Math.round(n / 1000)}k` : Math.round(n)}`;
}

/** A reply's facts on the brief, with the lines that say so ("Noted in What I know: …"). */
export function applyFacts(
  brief: DesignBrief,
  facts: TalkFact[],
): { brief: DesignBrief; keys: QuestionKey[]; lines: string[] } {
  let b = brief;
  const keys: QuestionKey[] = [];
  const lines: string[] = [];
  const add = (k: FactKey, text: string) => {
    keys.push(factQuestion(k));
    lines.push(text);
  };
  for (const f of facts) {
    const choice = f.choice ? lower(f.choice) : null;
    switch (f.key) {
      case 'budget': {
        const c = BUDGET_CHOICES.find((x) => x.id === f.choice);
        // A figure the person gave stays that figure ("about S$40k" is S$40k, not a range).
        const v = c ? c.v : f.number ? { low: f.number, high: f.number } : null;
        b = { ...b, budget: v };
        add(
          'budget',
          `budget ${!v ? 'not sure' : v.low === v.high ? sgd(v.high) : `up to ${sgd(v.high)}`}`,
        );
        break;
      }
      case 'walls':
        b = { ...b, walls: choice as DesignBrief['walls'] };
        add(
          'walls',
          `walls: ${choice === 'keep' ? 'keep them all' : choice === 'allowed' ? 'what HDB normally allows' : 'structural changes too'}`,
        );
        break;
      case 'style':
        b = { ...b, style: choice as DesignBrief['style'] };
        add('style', `style: ${f.text || choice}`);
        break;
      case 'cooking':
        b = {
          ...b,
          lifestyle: { ...b.lifestyle, cooking: choice as DesignBrief['lifestyle']['cooking'] },
        };
        add(
          'cooking',
          `cooking: ${COOKING_CHOICES.find((c) => c.id === choice)?.label.toLowerCase()}`,
        );
        break;
      case 'wfh': {
        const n = (f.number ?? Number(f.choice)) as DesignBrief['lifestyle']['wfh'];
        b = { ...b, lifestyle: { ...b.lifestyle, wfh: n } };
        add(
          'wfh',
          `working from home: ${WFH_CHOICES.find((c) => c.id === n)?.label.toLowerCase()}`,
        );
        break;
      }
      case 'household-note':
        b = {
          ...b,
          household: { ...b.household, text: clean(`${b.household.text} ${f.text}`.trim(), 1000) },
        };
        add('household-note', f.text);
        break;
      case 'wish':
        if (!b.wishes.includes(f.text) && b.wishes.length < 20)
          b = { ...b, wishes: [...b.wishes, f.text] };
        add('wish', f.text);
        break;
      case 'keep':
        b = { ...b, keep: { ...b.keep, text: clean(`${b.keep.text} ${f.text}`.trim(), 1000) } };
        add('keep', `keep: ${f.text}`);
        break;
    }
  }
  return { brief: b, keys: [...new Set(keys)], lines };
}
