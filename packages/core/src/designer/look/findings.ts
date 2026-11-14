import { AGAINST, type ParseResult, ZONES } from '../schema';
import { RULE_REPLY_SCHEMA, filterClaims } from '../talk/reply';
import { clean } from '../util';

/**
 * The second look's answer (tech 3b §2.5): findings in a fixed schema, each aimed at a short
 * id of the plan (an alias) and, where it suggests a fix, in the vocabulary the app already
 * executes (an intent edit, a swap, a removal, an addition or a house rule). Read leniently,
 * finding by finding: one that doesn't fit is left out or cut down, never the whole answer.
 */

export const LOOK_PRINCIPLES = ['P1', 'P2', 'P3', 'P4', 'taste', 'storage'] as const;
export type LookPrinciple = (typeof LOOK_PRINCIPLES)[number];
export const TARGET_KINDS = ['piece', 'room', 'wall', 'opening', 'space'] as const;
export const SUGGEST_KINDS = ['intent', 'swap', 'remove', 'add', 'rule'] as const;
/** At most this many findings are read, worst first. */
export const MAX_FINDINGS = 8;
export const LOOK_LINE_CHARS = 160;
export const LOOK_SUMMARY_CHARS = 200;

export interface LookSuggest {
  kind: (typeof SUGGEST_KINDS)[number];
  /** The alias of the piece it is about. */
  piece: string | null;
  against: (typeof AGAINST)[number] | null;
  faces: string | null;
  near: string | null;
  zone: (typeof ZONES)[number] | null;
  /** swap / add: a catalogue id. */
  kindId: string | null;
  /** add: the room alias it goes in. */
  room: string | null;
  /** rule: a house rule object, checked by slice 3a's vetting before it is offered. */
  rule: unknown;
}

export interface LookFinding {
  target: { kind: (typeof TARGET_KINDS)[number]; id: string };
  principle: LookPrinciple;
  severity: 'fix' | 'consider';
  line: string;
  suggest: LookSuggest | null;
}

export interface LookAnswer {
  findings: LookFinding[];
  summary: string | null;
}

const nullable = (s: object) => ({ anyOf: [s, { type: 'null' }] });
const str = { type: 'string' };
const obj = (properties: Record<string, unknown>) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

/** The findings' JSON schema (closed objects, every property required, nullable where optional). */
export const LOOK_SCHEMA = obj({
  findings: {
    type: 'array',
    items: obj({
      target: obj({ kind: { type: 'string', enum: [...TARGET_KINDS] }, id: str }),
      principle: { type: 'string', enum: [...LOOK_PRINCIPLES] },
      severity: { type: 'string', enum: ['fix', 'consider'] },
      line: str,
      suggest: nullable(
        obj({
          kind: { type: 'string', enum: [...SUGGEST_KINDS] },
          piece: nullable(str),
          against: nullable({ type: 'string', enum: [...AGAINST] }),
          faces: nullable(str),
          near: nullable(str),
          zone: nullable({ type: 'string', enum: [...ZONES] }),
          kindId: nullable(str),
          room: nullable(str),
          // A house rule (slice 3a's object): checked by the app before anything is offered.
          rule: RULE_REPLY_SCHEMA,
        }),
      ),
    }),
  },
  summary: nullable(str),
});

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null;
const lower = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : null);
const oneOf = <T extends string>(v: unknown, of: readonly T[]): T | null => {
  const s = lower(v);
  const hit = of.find((x) => x.toLowerCase() === s);
  return hit ?? null;
};
/** An alias as a model writes it ("p7", " P7 "): upper case, short, or null. */
const alias = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const s = clean(v, 12).toUpperCase();
  return /^[A-Z]{1,3}\d{1,4}$/.test(s) ? s : null;
};
const text = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const s = clean(v, max);
  return s ? s : null;
};

function suggestOf(raw: unknown): LookSuggest | null {
  const o = asObj(raw);
  const kind = o ? oneOf(o.kind, SUGGEST_KINDS) : null;
  if (!o || !kind) return null;
  const s: LookSuggest = {
    kind,
    piece: alias(o.piece),
    against: oneOf(o.against, AGAINST),
    // "faces" may be a piece's alias or the room, the window or the door.
    faces: oneOf(o.faces, ['room', 'window', 'door'] as const) ?? alias(o.faces),
    near: alias(o.near),
    zone: oneOf(o.zone, ZONES),
    kindId: typeof o.kindId === 'string' ? clean(o.kindId, 40).toLowerCase() || null : null,
    room: alias(o.room),
    rule: asObj(o.rule),
  };
  // What each kind needs, else the line alone stands.
  if (kind === 'rule' && !s.rule) return null;
  if ((kind === 'swap' || kind === 'add') && !s.kindId) return null;
  if (kind === 'add' && !s.room) return null;
  if ((kind === 'intent' || kind === 'swap' || kind === 'remove') && !s.piece) return null;
  if (kind === 'intent' && !s.against && !s.faces && !s.near && !s.zone) return null;
  return s;
}

/**
 * A second look's answer, read finding by finding: enums in any case, text cleaned and cut,
 * at most 8 findings; one with no target alias or no line is left out, a suggestion that
 * doesn't fit is cut down to the line. Storage is a lens, never a fix: a storage "fix" is a
 * "consider". Fails only when it isn't an object with findings.
 */
export function parseLook(raw: unknown): ParseResult<LookAnswer> {
  const o = asObj(raw);
  if (!o || !Array.isArray(o.findings)) return { ok: false, error: 'No findings in the answer.' };
  const notes: string[] = [];
  const findings: LookFinding[] = [];
  for (const f of o.findings) {
    if (findings.length >= MAX_FINDINGS) {
      notes.push('More findings than the app reads; the rest were left out.');
      break;
    }
    const x = asObj(f);
    const t = asObj(x?.target);
    const kind = t ? oneOf(t.kind, TARGET_KINDS) : null;
    const id = alias(t?.id);
    const principle = oneOf(x?.principle, LOOK_PRINCIPLES);
    const severity = oneOf(x?.severity, ['fix', 'consider'] as const);
    // (A sentence claiming the app can't check its work is taken out, as from a reply.)
    const line = unclaimed(text(x?.line, LOOK_LINE_CHARS));
    if (!x || !kind || !id || !principle || !severity || !line) continue;
    findings.push({
      target: { kind, id },
      principle,
      severity: principle === 'storage' ? 'consider' : severity,
      line,
      suggest: suggestOf(x.suggest),
    });
  }
  const summary = unclaimed(text(o.summary, LOOK_SUMMARY_CHARS));
  return { ok: true, value: { findings, summary }, notes };
}

/** The model's words with the claims filter's sentences out (null when nothing is left). */
const unclaimed = (s: string | null): string | null => {
  if (!s) return s;
  const out = filterClaims(s).say.trim();
  return out || null;
};
