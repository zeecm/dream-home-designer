import {
  type Conversation,
  type Rule,
  type RuleOffer,
  liveRules,
  optionTitle,
  revet,
  ruleChecks,
  ruleNumber,
  ruleNumberProblem,
  usesOf,
} from '@dhd/core';
import { create } from 'zustand';
import { useStore } from '../../../store';
import { type CardModel, cardResultNow, cardVerdict, optionCard } from './cards';
import { act, designLevelId, newId, nowIso, say, talkLevel, useTalk } from './useTalk';

/**
 * House rules in the panel (slice 3a tech §6.5): the offer answered, Your rules' edits, and the
 * app's line after each one, said once the card on the table has been checked again (so it
 * states the true verdict). Nothing here costs anything: the checks run on this device.
 */

const doc = () => useStore.getState().editor.doc;
const m = (n: number) => `${n.toFixed(2)} m`;

/** The card on the table: the one shown, else the newest proposal's newest option. */
export function tableCard(conv: Conversation | null = useTalk.getState().conv): {
  card: CardModel;
  title: string;
} | null {
  if (!conv) return null;
  const st = useTalk.getState();
  const levelId = designLevelId();
  for (let i = conv.turns.length - 1; i >= 0; i--) {
    const t = conv.turns[i];
    if (t?.kind !== 'proposal') continue;
    const p = st.proposals.find((x) => x.id === t.proposalId);
    if (!p) continue;
    const o = p.options.find((x) => st.shown === `${p.id}:${x.letter}`) ?? p.options.at(-1);
    if (!o || o.status === 'running' || o.status === 'failed') return null;
    return {
      card: optionCard(p, o, levelId),
      title: optionTitle(p.n, o.letter, p.options.length),
    };
  }
  return null;
}

/** "V6 checked again: passes." for the card on the table, once its result is in (else ""). */
export async function checkedAgain(): Promise<string> {
  const t = tableCard();
  if (!t) return '';
  try {
    const r = await cardResultNow(doc(), t.card);
    if (!r) return '';
    const v = cardVerdict(
      r.checks.filter((c) => c.hard && !c.already).map((c) => ({ key: c.key })),
      [],
      t.card.waivers.map((w) => w.key),
    );
    return ` ${t.title} checked again: ${v.tone === 'fail' ? 'doesn’t pass' : 'passes'}.`;
  } catch {
    return '';
  }
}

/** The app's line in the log about a rule (with Your rules), said in the live region too. */
async function ruleLine(rule: Rule, text: string) {
  const again = await checkedAgain();
  const line = `${text}${again}`;
  await act({
    type: 'event',
    id: newId('turn'),
    at: nowIso(),
    event: {
      type: 'rule',
      rule: rule.name.slice(0, 80),
      text: line.slice(0, 400),
      ruleId: rule.id,
    },
  });
  say(line);
}

const offerOf = (turnId: string): RuleOffer | null => {
  const t = useTalk.getState().conv?.turns.find((x) => x.id === turnId);
  return t?.kind === 'designer' ? (t.talk?.offer ?? null) : null;
};

/** Keep as a rule (free): the card on the table checked again, then the line. */
export async function keepRule(turnId: string, n?: number | null) {
  const o = offerOf(turnId);
  if (!o) return;
  const next = await act({
    type: 'ruleKeep',
    turnId,
    ...(n !== undefined ? { n } : {}),
    id: newId('turn'),
    at: nowIso(),
  });
  if (!next) return;
  const raised = o.vet.raises && liveRules(next).find((r) => r.id === o.vet.raises?.ruleId);
  const rule = raised ?? liveRules(next).find((r) => r.id === o.rule.id) ?? o.rule;
  await ruleLine(
    rule,
    raised
      ? `Your rule ${rule.name} is raised to ${m(ruleNumber(rule) ?? 0)}.`
      : `Kept as a rule: ${rule.name}.`,
  );
  requestAnimationFrame(() =>
    document.querySelector<HTMLButtonElement>('.talk-log [data-rules-link]:last-of-type')?.focus(),
  );
}

/** Just this once (free): a Decision, told to the designer, not checked. */
export const ruleOnce = (turnId: string) =>
  act({ type: 'ruleOnce', turnId, id: newId('dec'), at: nowIso() });

/** Replace yours with the new one: both in one step, both named in the line. */
export async function replaceRule(turnId: string) {
  const o = offerOf(turnId);
  const old = o?.vet.with ? useTalk.getState().conv?.rules.find((r) => r.id === o.vet.with) : null;
  if (!o || !old) return;
  const next = await act({ type: 'ruleReplace', turnId, at: nowIso() });
  if (next) await ruleLine(o.rule, `Replaced your rule ${old.name} with ${o.rule.name}.`);
}

export const keepYours = (turnId: string) => act({ type: 'ruleKeepYours', turnId });

/** A number changed in Your rules: re-checked at once, with no request (3a.5). */
export async function changeRule(rule: Rule, n: number) {
  const was = ruleNumber(rule);
  const next = await act({ type: 'ruleEdit', ruleId: rule.id, n });
  if (!next || was === null || Math.abs(was - n) < 0.005) return;
  await ruleLine(rule, `You changed a rule: ${rule.name}, ${m(was)} → ${m(n)}.`);
}

export const renameRule = (rule: Rule, name: string) =>
  act({ type: 'ruleEdit', ruleId: rule.id, name });

/** Delete (Undo for 5 s in the view): the card on the table checked again. */
export async function deleteRule(rule: Rule) {
  const next = await act({ type: 'ruleDelete', ruleId: rule.id });
  if (next) await ruleLine(rule, `You deleted a rule: ${rule.name}.`);
}

export const restoreRule = (rule: Rule) => act({ type: 'ruleRestore', ruleId: rule.id });

/** Just this once's Make it a rule (free): the offer opens again, vetted on the plan as it is. */
export async function reopenRule(decisionId: string) {
  const conv = useTalk.getState().conv;
  const d = conv?.decisions.find((x) => x.id === decisionId);
  const level = talkLevel();
  if (!conv || !d?.rule || !level) return;
  const vet = revet(d.rule, {
    rules: liveRules(conv).filter((r) => r.id !== d.rule?.id),
    level,
    brief: conv.brief,
  });
  await act({ type: 'ruleReopen', decisionId, vet });
  useTalk.setState({ view: 'log' });
  requestAnimationFrame(() =>
    document
      .querySelector<HTMLElement>(`[data-offer="${d.rule?.id}"]`)
      ?.scrollIntoView({ block: 'center' }),
  );
}

/** The reason a number can't be the rule's (the field's own words), or null. */
export function numberProblem(rule: Rule, n: number): string | null {
  const conv = useTalk.getState().conv;
  const level = talkLevel();
  if (!conv || !level) return null;
  return ruleNumberProblem(rule, n, { rules: liveRules(conv), level });
}

/** A rule's status on the plan as it is (free, worked out here): what it breaks now. */
const planMemo = new WeakMap<object, Map<string, string[]>>();
/**
 * What a rule breaks on the plan as it is, kept per level object and rule (a route rule costs
 * a walkway pass: worked out once per plan, never per result tick).
 */
export function planStatus(rule: Rule): string[] {
  const conv = useTalk.getState().conv;
  const level = talkLevel();
  if (!conv || !level) return [];
  const per = planMemo.get(level) ?? new Map<string, string[]>();
  planMemo.set(level, per);
  const key = JSON.stringify([rule, conv.brief.rooms]);
  const hit = per.get(key);
  if (hit) return hit;
  const prefix = `Your rule “${rule.name}”: `;
  const out = ruleChecks([rule], {
    level,
    usesOf: (id) => usesOf(level, id, { brief: conv.brief }),
  }).map((c) =>
    c.text.startsWith(prefix) ? c.text.slice(prefix.length).replace(/\.$/, '') : c.text,
  );
  if (per.size > 40) per.clear();
  per.set(key, out);
  return out;
}

/** Show on plan (UX §3.6): the rule's target and what breaks it, for 8 s or until dismissed. */
export const useRuleShown = create<{ rule: Rule | null; until: number }>(() => ({
  rule: null,
  until: 0,
}));
let hideTimer: ReturnType<typeof setTimeout> | null = null;
export function showRule(rule: Rule | null) {
  if (hideTimer) clearTimeout(hideTimer);
  useRuleShown.setState({ rule, until: rule ? Date.now() + 8000 : 0 });
  if (rule) hideTimer = setTimeout(() => useRuleShown.setState({ rule: null, until: 0 }), 8000);
}
