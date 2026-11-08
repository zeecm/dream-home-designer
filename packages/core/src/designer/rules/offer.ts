import type { Level } from '../../schema';
import type { ProgrammeUse } from '../principles';
import type { DesignBrief } from '../schema';
import type { RuleVet } from '../talk/schema';
import type { RuleDraft } from './parse';
import type { Rule } from './schema';
import { type Vet, vetRule } from './vet';

/** A verdict as an offer stores it (the rule it is about by id; at most five plan lines). */
export function storedVet(v: Vet): RuleVet {
  return v.ok
    ? {
        ok: true,
        why: null,
        text: '',
        adjusted: v.adjusted ?? null,
        raises: v.raises ?? null,
        planBreaks: v.planBreaks.slice(0, 5).map((l) => l.slice(0, 300)),
        with: null,
      }
    : {
        ok: false,
        why: v.why,
        text: v.text.slice(0, 400),
        adjusted: null,
        raises: null,
        planBreaks: [],
        with: v.with?.id ?? null,
      };
}

export interface OfferCtx {
  /** The new rule's id, the time, and where it comes from. */
  id: string;
  at: string;
  turnId: string;
  /** The version on the table then ("V4"), if any. */
  version: string | null;
  levelId: string;
  rules: readonly Rule[];
  level: Level;
  brief: DesignBrief;
  usesOf?: (roomId: string) => ProgrammeUse[];
}

/**
 * A reply's rule as the offer stores it (tech §5.1): the rule with its id, time and level, and
 * the app's verdict, worked out when the reply lands (before replyDone is written).
 */
export function ruleOffer(draft: RuleDraft, ctx: OfferCtx): { rule: Rule; vet: RuleVet } {
  const candidate = {
    id: ctx.id,
    ...draft,
    levelId: ctx.levelId,
    at: ctx.at,
    from: { turnId: ctx.turnId, version: ctx.version },
    deleted: false,
  };
  const v = vetRule(candidate, {
    rules: ctx.rules,
    level: ctx.level,
    brief: ctx.brief,
    ...(ctx.usesOf ? { usesOf: ctx.usesOf } : {}),
  });
  return { rule: v.ok ? v.rule : (candidate as Rule), vet: storedVet(v) };
}

/** An offer vetted again (Just this once's Make it a rule, a reply landing later). */
export function revet(
  rule: Rule,
  ctx: Omit<OfferCtx, 'id' | 'at' | 'turnId' | 'version' | 'levelId'>,
): RuleVet {
  return storedVet(
    vetRule(rule, {
      rules: ctx.rules,
      level: ctx.level,
      brief: ctx.brief,
      ...(ctx.usesOf ? { usesOf: ctx.usesOf } : {}),
    }),
  );
}
