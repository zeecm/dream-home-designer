import { furnitureKind } from '../../furniture';
import type { Project } from '../../schema';
import { type AliasMap, resolveAlias } from '../aliases';
import { categoriesFor, resolveAsset } from '../catalogue';
import { isDeclined } from '../free';
import { roleOf } from '../principles';
import { checkSig } from '../report';
import type { DesignResult } from '../result';
import { type Kept, keptHolds } from '../rules/kept';
import { type OfferCtx, ruleOffer } from '../rules/offer';
import { ruleFromReply } from '../rules/parse';
import type { Rule } from '../rules/schema';
import type { DesignItem, SpaceDesign } from '../schema';
import type { RuleVet } from '../talk/schema';
import { clean } from '../util';
import type { LookAnswer, LookFinding, LookSuggest } from './findings';

/**
 * What the app does with a second look's findings (tech 3b §2.7). The checks always win:
 * - a P1–P4 "fix" is acted on only when one of the app's own checks on the same target (the
 *   piece, or the room) with the same principle fails; it goes back with the app's line, never
 *   the model's. Otherwise it is dropped and recorded ("checks-disagree");
 * - a "taste" fix is acted on once an option, as a suggestion;
 * - "consider" findings become notes on the card;
 * - a suggested house rule becomes an offer (vetted by the house rules when they are in the
 *   app) or, until then, a note. Never kept on its own;
 * - a suggestion in the app's vocabulary (intent, swap, remove, add) is an edit to the space's
 *   answer, placed by the solver; one without is a fix round's request for that space.
 * Whatever is acted on is kept only if the plan comes out no worse (`lookNoWorse`).
 */

export type DropWhy =
  | 'target'
  | 'checks-disagree'
  | 'taste-once'
  | 'not-designed'
  | 'suggest'
  | 'kept';

export interface LookEdit {
  space: string;
  /** The answer's ref of the piece it is about (null: an addition). */
  ref: string | null;
  suggest: LookSuggest;
  /** The refs of the pieces it names (faces, near), by alias. */
  refs: Record<string, string>;
  line: string;
}

export interface LookRound {
  space: string;
  failures: { ref: string | null; text: string }[];
  /**
   * The app's own failing hard checks they are for (P1–P4, each once): what a fix round's
   * record counts. Zero: a round only of taste suggestions or soft checks, the look's own.
   */
  checks: number;
  /** Their keys (to count those still failing after it). */
  keys: string[];
}

export interface LookPlan {
  edits: LookEdit[];
  rounds: LookRound[];
  notes: string[];
  /** Suggested house rules, for the house rules' vetting and offer. */
  offers: { rule: unknown; line: string }[];
  dropped: { finding: LookFinding; why: DropWhy }[];
  /** The lines of the findings acted on (for the note when they change nothing). */
  acted: string[];
  /**
   * The keys of the app's checks the round is for (P1–P4 fixes): it is kept only if each of
   * them no longer fails, as well as the plan being no worse.
   */
  targets: string[];
}

export interface LookCtx {
  result: DesignResult;
  aliases: AliasMap;
  /** The spaces whose answers the run may change (designed by intent in this run). */
  answers: Record<string, SpaceDesign>;
  /** The project's own furniture models (a swap or an addition may name one). */
  models?: Project['models'];
  /**
   * The pieces kept where they are that the option was made with (slice 3a): never moved,
   * swapped or removed by the look. A taste fix about one is dropped ('kept'); a P1–P4 fix
   * about one goes back as a round, whose request says it is kept.
   */
  kept?: readonly Kept[];
  /**
   * Pieces the person left out of a room (Decisions at Accept): a finding about a must-have
   * they declined there, or one adding such a piece back, is dropped ('kept'), never a round.
   */
  declined?: readonly { room: string; role: string }[];
}

const NOTE = (line: string) => `Designer’s second look: ${line}`;

/** The space a piece or a room is in, by the result's spaces. */
function spaceOf(r: DesignResult, id: string): string | null {
  for (const s of r.spaces) if (s.items.includes(id) || s.rooms.includes(id)) return s.key;
  return null;
}

const EXECUTES = new Set(['intent', 'swap', 'remove', 'add']);

export function actOnLook(answer: LookAnswer, ctx: LookCtx): LookPlan {
  const { result, aliases } = ctx;
  const level = result.level;
  const plan: LookPlan = {
    edits: [],
    rounds: [],
    notes: [],
    offers: [],
    dropped: [],
    acted: [],
    targets: [],
  };
  let taste = false;
  /** Each round's hard check keys, counted once however many findings hit them. */
  const hardKeys = new Map<string, Set<string>>();
  const round = (space: string, f: LookRound['failures'][number], hard: string | null) => {
    const keys = hardKeys.get(space) ?? new Set<string>();
    hardKeys.set(space, keys);
    if (hard) keys.add(hard);
    const r = plan.rounds.find((x) => x.space === space);
    if (r) {
      if (!r.failures.some((x) => x.text === f.text && x.ref === f.ref)) r.failures.push(f);
      r.checks = keys.size;
      r.keys = [...keys];
    } else plan.rounds.push({ space, failures: [f], checks: keys.size, keys: [...keys] });
  };
  /** An alias to the ref of the piece it names in a designed space's answer. */
  const refOf = (alias: string | null): string | null => {
    const id = resolveAlias(aliases, alias);
    return id && level.items[id] ? (result.refs[id] ?? null) : null;
  };
  const kept = ctx.kept ?? [];
  const declined = ctx.declined ?? [];
  /** Whether a piece on the plan stands for a kept one. */
  const isKept = (id: string | null) => {
    const it = id ? level.items[id] : undefined;
    return !!it && kept.some((k) => k.itemId === it.id || keptHolds(k, it));
  };
  for (const f of answer.findings) {
    const id = resolveAlias(aliases, f.target.id);
    const exists =
      !!id && (!!level.items[id] || !!level.rooms[id] || !!level.walls[id] || !!level.openings[id]);
    if (!id || !exists) {
      plan.dropped.push({ finding: f, why: 'target' });
      continue;
    }
    const line = clean(f.line, 160);
    if (f.suggest?.kind === 'rule') {
      // Offered as a house rule once the app has vetted it (`lookRuleOffer`); a note if not.
      plan.offers.push({ rule: f.suggest.rule, line });
      continue;
    }
    if (f.severity === 'consider') {
      plan.notes.push(NOTE(line));
      continue;
    }
    // A fix: P1–P4 only with a failing app check on the same target and principle.
    let failure: string;
    let target: string | null = null;
    let hard = false;
    if (f.principle === 'taste') {
      if (taste) {
        plan.dropped.push({ finding: f, why: 'taste-once' });
        continue;
      }
      failure = `A suggestion from the designer’s second look (not a check): ${line}`;
    } else {
      const room = level.items[id] ? null : id;
      const check = result.checks.find(
        (c) =>
          !c.already &&
          c.principle === f.principle &&
          (c.itemId === id || (!!room && c.roomId === room)),
      );
      if (!check) {
        plan.dropped.push({ finding: f, why: 'checks-disagree' });
        continue;
      }
      // A must-have the person left out there (no bed, by their choice): theirs, no round.
      if (!check.itemId && check.roomId && isDeclined(check.key, check.roomId, declined)) {
        plan.dropped.push({ finding: f, why: 'kept' });
        continue;
      }
      failure = check.text;
      target = check.key;
      hard = check.hard;
    }
    // Where it acts: the space of the piece it suggests about, else of its target.
    const about = f.suggest?.piece ? resolveAlias(aliases, f.suggest.piece) : null;
    const addTo = f.suggest?.kind === 'add' ? resolveAlias(aliases, f.suggest.room) : null;
    // Never adding back a piece the person left out of that room.
    const addKind =
      f.suggest?.kind === 'add' && f.suggest.kindId
        ? resolveAsset(f.suggest.kindId, ctx.models)
        : null;
    if (
      addTo &&
      addKind &&
      declined.some((d) => d.room === addTo && d.role === roleOf(furnitureKind(addKind.id)))
    ) {
      plan.dropped.push({ finding: f, why: 'kept' });
      continue;
    }
    // A kept piece stays as it is: a suggestion about it (its taste fix) is not acted on.
    const onKept = f.suggest?.kind !== 'add' && (isKept(about) || (!about && isKept(id)));
    if (onKept && f.principle === 'taste') {
      plan.dropped.push({ finding: f, why: 'kept' });
      continue;
    }
    // A piece the app placed itself for a must-have (its ref starts `app:`) is never taken out:
    // that would leave the bed, the seats or the table missing again.
    const aboutRef = about && level.items[about] ? result.refs[about] : null;
    if (f.suggest?.kind === 'remove' && aboutRef?.startsWith('app:')) {
      plan.dropped.push({ finding: f, why: 'kept' });
      continue;
    }
    const space = spaceOf(result, addTo ?? (about && level.items[about] ? about : id));
    if (!space || !ctx.answers[space]) {
      plan.dropped.push({ finding: f, why: 'not-designed' });
      continue;
    }
    let s = f.suggest;
    // A swap or an addition names a catalogue piece that suits the room (no bed in the living
    // room), as a room step's answer would; one that doesn't is dropped.
    if (s && (s.kind === 'swap' || s.kind === 'add')) {
      const kind = s.kindId ? resolveAsset(s.kindId, ctx.models) : null;
      const kinds = result.spaces.find((x) => x.key === space)?.kinds ?? [];
      const allowed = new Set(categoriesFor(kinds));
      if (!kind || !(allowed.has(kind.category) || allowed.has(kind.id))) {
        plan.dropped.push({ finding: f, why: 'suggest' });
        continue;
      }
      s = { ...s, kindId: kind.id };
    }
    if (f.principle === 'taste') taste = true;
    if (target) plan.targets.push(target);
    // What it was, in the note if the round changes nothing: a P1–P4 fix in the app's words.
    const said = target ? failure : line;
    if (!plan.acted.includes(said)) plan.acted.push(said);
    const ref = about && level.items[about] ? (result.refs[about] ?? null) : null;
    if (s && EXECUTES.has(s.kind) && (s.kind === 'add' || (ref && !onKept))) {
      const refs: Record<string, string> = {};
      for (const a of [s.faces, s.near]) {
        const r = refOf(a);
        if (a && r) refs[a] = r;
      }
      plan.edits.push({ space, ref, suggest: s, refs, line });
    } else {
      const piece = level.items[id] ? (result.refs[id] ?? null) : null;
      round(space, { ref: piece, text: failure }, hard ? target : null);
    }
  }
  plan.notes = [...new Set(plan.notes)];
  return plan;
}

/**
 * A second look's suggested house rule as slice 3a offers one: read in the rule vocabulary
 * (`ruleFromReply`) and vetted on the plan as it is (`ruleOffer`: duplicates, conflicts, HDB,
 * what the flat can meet). Null when it isn't a rule the app can hold: then it is a note.
 */
export function lookRuleOffer(
  raw: unknown,
  ctx: OfferCtx & { aliases: AliasMap; mainDoor: string | null },
): { rule: Rule; vet: RuleVet } | null {
  const read = ruleFromReply(raw, { aliases: ctx.aliases, mainDoor: ctx.mainDoor });
  if (!read || !('draft' in read)) return null;
  const offer = ruleOffer(read.draft, ctx);
  return offer.vet.why === 'unfit' ? null : offer;
}

/** The card's note for a suggestion that couldn't be offered as a rule. */
export const lookNote = NOTE;

/** A space's answer with a second look's edit made: the solver places it; the checks gate it. */
export function applyLookEdit(d: SpaceDesign, e: LookEdit, n: number): SpaceDesign {
  const s = e.suggest;
  const items = d.items.map((x) => ({ ...x }));
  const at = items.findIndex((x) => x.ref === e.ref);
  const it = at >= 0 ? (items[at] as DesignItem) : null;
  const refOr = (a: string | null) =>
    a === 'room' || a === 'window' || a === 'door' ? a : a ? (e.refs[a] ?? null) : null;
  switch (s.kind) {
    case 'intent':
      if (!it) return d;
      if (s.against) it.against = s.against;
      if (s.zone) it.zone = s.zone;
      if (s.faces && refOr(s.faces)) it.faces = refOr(s.faces);
      if (s.near && refOr(s.near)) it.near = refOr(s.near);
      return { ...d, items };
    case 'swap': {
      if (!it || !s.kindId) return d;
      // A piece swapped for another is a new piece: it takes a ref of its own (and what faces or
      // goes by it follows), so the app's own is never tagged as the app's after, and
      // `lookNoWorse` judges what it breaks as new (tech lead N1).
      const ref = `look${n}`;
      items[at] = {
        ...it,
        ref,
        assetId: s.kindId,
        keep: null,
        width: null,
        depth: null,
        height: null,
      };
      if (ref !== it.ref) {
        for (const x of items) {
          if (x.faces === it.ref) x.faces = ref;
          if (x.near === it.ref) x.near = ref;
        }
      }
      return { ...d, items };
    }
    case 'remove':
      if (!it) return d;
      return { ...d, items: items.filter((x) => x.ref !== e.ref) };
    case 'add': {
      if (!s.kindId) return d;
      const add: DesignItem = {
        ref: `look${n}`,
        assetId: s.kindId,
        keep: null,
        wall: null,
        along: null,
        at: null,
        rotation: null,
        width: null,
        depth: null,
        height: null,
        why: clean(e.line, 120),
        against: s.against,
        faces: refOr(s.faces),
        near: refOr(s.near),
        zone: s.zone,
      };
      return { ...d, items: [...items, add] };
    }
    default:
      return d;
  }
}

/**
 * Whether a second look's round is used, judged as a room's fix round is: fewer hard failures
 * wins (a bed brought back brings soft notes with it, and is still better), but never at the
 * cost of a hard failure that wasn't there (an HDB rule, a kept piece, a house rule, anything).
 * With as many hard failures, each check it was for (`targets`) must pass, and no more soft
 * notes fail and no more pieces are left out: soft notes only break a tie.
 */
export function lookNoWorse(
  before: DesignResult,
  after: DesignResult,
  targets: readonly string[] = [],
): boolean {
  const hard = (r: DesignResult) =>
    new Set(r.checks.filter((c) => c.hard && !c.already).map((c) => c.key));
  const sigs = (r: DesignResult) =>
    new Set(r.checks.filter((c) => c.hard && !c.already).map((c) => checkSig(r, c)));
  const was = hard(before);
  const now = hard(after);
  // A new hard failure refuses it, whatever it fixes: HDB rules, kept pieces (K) and house rules
  // (R) above all. Judged by signature (principle|code|room|role), as the free fixes and the
  // run report are: a piece placed again under a new ref or id is the same failure, not a new one.
  const wasSigs = sigs(before);
  if ([...sigs(after)].some((s) => !wasSigs.has(s))) return false;
  // An HDB rule or a house rule failed by a piece new to the round (an "add", a swap's new
  // piece) refuses it though its signature matches one the plan already failed: a second piece
  // breaking the same rule in that room is a new failure, never the old one placed again.
  const newPiece = (c: DesignResult['checks'][number]) =>
    !!c.itemId && !before.level.items[c.itemId];
  if (
    after.checks.some(
      (c) => c.hard && !c.already && /^(HDB|R)\|/.test(c.key) && !was.has(c.key) && newPiece(c),
    )
  )
    return false;
  if (now.size < was.size) return true;
  const still = new Set(after.checks.filter((c) => !c.already).map((c) => c.key));
  if (targets.some((k) => still.has(k))) return false;
  const soft = (r: DesignResult) => r.checks.filter((c) => !c.hard && !c.already).length;
  return soft(after) <= soft(before) && after.dropped.length <= before.dropped.length;
}

/** The card's note when a look's round changed nothing for the better. */
export const keptAsWas = (line: string) =>
  `The designer’s second look suggested: ${line} It didn’t improve the plan’s checks, so it was left as it was.`;
