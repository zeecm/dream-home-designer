import { furnitureKind } from '../../furniture';
import { type AliasMap, resolveAlias } from '../aliases';
import { RoomUse } from '../schema';
import {
  CATEGORIES,
  RULE_RELATIONS,
  type Rule,
  type RuleCategory,
  type RuleRelation,
  type RuleSubject,
  type RuleTarget,
  TARGET_KINDS,
  roundN,
} from './schema';

/**
 * A reply's `memory.rule` as a candidate rule (slice 3a tech §5.1): the model's aliases resolved
 * to the plan's ids, its words for kinds and categories mapped to the vocabulary. The app then
 * vets it (vet.ts) before anything is offered. What can't be turned into a rule is `unfit`: the
 * wish is noted in Decisions, not checked (criterion 40).
 */

/** A name at most 80 characters, cut at a word with an ellipsis (never mid-word). */
export function cutName(raw: string): string {
  const s = raw.replace(/\s+/g, ' ').trim();
  if (s.length <= 80) return s;
  const head = s.slice(0, 79);
  const at = head.lastIndexOf(' ');
  return `${(at > 40 ? head.slice(0, at) : head).replace(/[\s,;:.]+$/, '')}…`;
}

/** A rule as a reply gives it: no id, time or level yet (the reducer adds those). */
export type RuleDraft = Pick<Rule, 'name' | 'subject' | 'relation' | 'target' | 'n'>;

/** Every role a kind subject or target may name (principles.ts's roles). */
export const ROLE_NAMES: ReadonlySet<string> = new Set([
  'bed',
  'bedside',
  'wardrobe',
  'drawers',
  'desk',
  'sofa',
  'armchair',
  'coffee-table',
  'side-table',
  'tv',
  'tv-console',
  'dining-table',
  'dining-chair',
  'desk-chair',
  'stool',
  'fridge',
  'washer',
  'shoe-cabinet',
  'shelf',
  'console',
  'screen',
  'light',
]);

/** The model's words for a category, as the vocabulary has it. */
const CATEGORY_WORDS: Record<string, RuleCategory> = {
  tall: 'tall',
  'tall pieces': 'tall',
  storage: 'storage',
  seating: 'seating',
  seats: 'seating',
  bed: 'beds',
  beds: 'beds',
  table: 'tables',
  tables: 'tables',
  light: 'lighting',
  lights: 'lighting',
  lighting: 'lighting',
  plant: 'plants',
  plants: 'plants',
};

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null;
const lower = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const finite = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

export interface RuleParseContext {
  aliases: AliasMap;
  /** The main door's id, for an opening named "main door". */
  mainDoor?: string | null;
}

/** A kind the vocabulary knows: a catalogue id, or a role ("sofa"). */
const kindOf = (v: unknown): string | null => {
  const id = lower(v).replace(/\s+/g, '-');
  if (!id || id.length > 40) return null;
  return furnitureKind(id) || ROLE_NAMES.has(id) ? id : null;
};

function subjectOf(raw: unknown, ctx: RuleParseContext): RuleSubject | null {
  const o = asObj(raw);
  const kind = lower(o?.kind);
  switch (kind) {
    case 'any':
      return { kind: 'any' };
    case 'category': {
      const c = CATEGORY_WORDS[lower(o?.id)];
      return c && (CATEGORIES as readonly string[]).includes(c)
        ? { kind: 'category', category: c }
        : null;
    }
    case 'item': {
      const id = resolveAlias(ctx.aliases, typeof o?.id === 'string' ? o.id : null);
      if (id && /^P\d+$/i.test(String(o?.id).trim())) return { kind: 'item', itemId: id };
      // A piece only in a proposal (or not named by its alias): said by its kind (tech §2.4).
      const k = kindOf(o?.id);
      return k ? { kind: 'kind', kindId: k } : null;
    }
    case 'kind': {
      const k = kindOf(o?.id);
      return k ? { kind: 'kind', kindId: k } : null;
    }
    default:
      return null;
  }
}

function targetOf(raw: unknown, ctx: RuleParseContext): RuleTarget | null {
  const o = asObj(raw);
  const kind = lower(o?.kind);
  if (!(TARGET_KINDS as readonly string[]).includes(kind)) return null;
  const id = typeof o?.id === 'string' ? o.id : null;
  const ref = (prefix: string) => {
    const r = id && new RegExp(`^${prefix}\\d+$`, 'i').test(id.trim()) ? id : null;
    return resolveAlias(ctx.aliases, r);
  };
  switch (kind) {
    case 'room': {
      const roomId = ref('R');
      return roomId ? { kind: 'room', roomId } : null;
    }
    case 'roomUse': {
      const use = RoomUse.safeParse(lower(id));
      return use.success ? { kind: 'roomUse', use: use.data } : null;
    }
    case 'wall': {
      const wallId = ref('W');
      return wallId ? { kind: 'wall', wallId } : null;
    }
    case 'opening': {
      const openingId = /main/i.test(id ?? '') ? (ctx.mainDoor ?? null) : ref('D');
      return openingId ? { kind: 'opening', openingId } : null;
    }
    case 'ownDoor':
      return { kind: 'ownDoor' };
    case 'window':
      return { kind: 'window' };
    case 'kind': {
      const k = kindOf(id);
      return k ? { kind: 'kind', kindId: k } : null;
    }
    case 'route': {
      const rooms = (Array.isArray(o?.rooms) ? o.rooms : [])
        .map((r) => resolveAlias(ctx.aliases, typeof r === 'string' ? r : null))
        .filter((r): r is string => !!r);
      const to = [...new Set(rooms)].slice(0, 8);
      return to.length ? { kind: 'route', from: 'main-door', to } : null;
    }
    case 'spot': {
      const at = asObj(o?.at);
      const x = finite(at?.x);
      const y = finite(at?.y);
      const r = finite(o?.r) ?? 0.5;
      return x !== null && y !== null
        ? { kind: 'spot', at: { x, y }, r: Math.min(3, Math.max(0.2, r)) }
        : null;
    }
    default:
      return null;
  }
}

/**
 * The rule a reply offers: a draft, `unfit` (an object the vocabulary can't hold), or null
 * (none offered).
 */
export function ruleFromReply(
  raw: unknown,
  ctx: RuleParseContext,
): { draft: RuleDraft } | { unfit: true; name: string } | null {
  const o = asObj(raw);
  if (!o) return null;
  const name = typeof o.name === 'string' ? cutName(o.name) : '';
  const relation = (RULE_RELATIONS as readonly string[]).find(
    (r) => r.toLowerCase() === lower(o.relation),
  ) as RuleRelation | undefined;
  const subject = subjectOf(o.subject, ctx);
  const target = targetOf(o.target, ctx);
  const n = finite(o.n);
  if (!relation || !subject || !target || !name) return { unfit: true, name };
  return { draft: { name, subject, relation, target, n: n === null ? null : roundN(n) } };
}
