/** House rules (slice 3a): the rule object, its sentence, its checks and vetting. */
export {
  KEPT_ANGLE,
  KEPT_GAP,
  Kept,
  type KeptCheck,
  MAX_KEPT,
  keptBefore,
  keptChecks,
  keptHolds,
  keptItem,
  keptName,
} from './kept';
export { type OfferCtx, revet, ruleOffer, storedVet } from './offer';
export { ROLE_NAMES, type RuleDraft, type RuleParseContext, ruleFromReply } from './parse';
export { type RuleCheck, type RuleCtx, type RuleKeepOut, ruleChecks, ruleKeepOuts } from './check';
export {
  AGAINST_GAP as RULE_AGAINST_GAP,
  CATEGORIES as RULE_CATEGORIES,
  FACE_ANGLE as RULE_FACE_ANGLE,
  FITS as RULE_FITS,
  MAX_RULES,
  ROUTE_FLOOR,
  ROUTE_WIDTH,
  RULE_RELATIONS,
  Rule,
  type RuleCategory,
  type RuleRelation,
  RuleSubject,
  RuleTarget,
  type RuleTargetKind,
  TARGET_KINDS as RULE_TARGET_KINDS,
  numberRange,
  roundN,
  ruleNumber,
  unfitOf,
} from './schema';
export {
  LIMIT_TEXT,
  NOT_CHECKABLE,
  type RuleLimits,
  type Vet,
  type VetCtx,
  type VetRefusal,
  ruleLimits,
  ruleNumberProblem,
  subjectsOverlap,
  vetRule,
} from './vet';
export {
  kindWords,
  listWords,
  openingWords,
  ruleSentence,
  subjectMatches,
  subjectWords,
  targetWords,
} from './words';
