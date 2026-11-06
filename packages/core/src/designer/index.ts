/**
 * The AI interior designer, the part that needs no network: the brief and answer schemas,
 * the prompts, checking and placing an answer on the plan, accepting it, and pricing a run.
 * Spec: docs/specs/ai-interior-designer.md. The web app runs the requests.
 */
export {
  type AliasMap,
  aliasesFor,
  aliasOf,
  resolveAlias,
} from './aliases';
export { categoriesFor, catalogueText, priorityOf, resolveAsset } from './catalogue';
export { briefData, compass, designContext, planForDesign, type ContextInput } from './describe';
export { type WallLock, designLocks, wallLocks } from './locks';
export {
  CHARS_PER_TOKEN,
  OUTPUT,
  PRICES,
  PRICES_AS_OF,
  type Price,
  type RunEstimate,
  type StepEstimate,
  estimateRun,
  priceOf,
  tokensOf,
  usdOf,
} from './prices';
export {
  CONCEPT_SCHEMA,
  SPACE_SCHEMA,
  SYSTEM_PROMPT,
  type StepOptions,
  type StepPrompt,
  conceptBlock,
  layoutStep,
  promptText,
  roomStep,
  runPrompts,
} from './prompts';
export {
  Aspect,
  BATHROOMS,
  Concept,
  type ConceptRoom,
  Design,
  DesignBrief,
  type DesignInput,
  type DesignItem,
  type DesignOp,
  LIMITS,
  Lock,
  type ParseResult,
  Part,
  Provider as AiProvider,
  RoomUse,
  Scope,
  SpaceDesign,
  type SpaceKey,
  SpaceStatus,
  STYLE_NAMES,
  StyleId,
  Usage,
  defaultBrief,
  parseConcept,
  parseSpaceDesign,
} from './schema';
export {
  type Face,
  type FaceOpening,
  type Space,
  clearStretches,
  facesOf,
  isDesigned,
  roomIdAt,
  roomsBeside,
  spaceOfRoom,
  spacesOf,
} from './spaces';
export { type UsageOpts, usageOf, usageTotals } from './usage';
export { levelFingerprint } from './util';
