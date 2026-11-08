import { TALK_KINDS, type TalkKind } from './reply';

/**
 * What a reply has said so far, read from its JSON as it streams in (tech §2.8): its `kind`
 * once that string is closed, and its `say` as far as it has come, escapes decoded, with a cut
 * escape or half a surrogate pair at the end left off. Tolerant and linear: any prefix of any
 * reply reads without throwing; `say` only grows, and is always a prefix of the final one.
 * Only the top level's properties are read (a nested "say" is not the reply's).
 */
export interface PartialTalk {
  kind?: TalkKind;
  say?: string;
}

const ESC: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

/**
 * A JSON string's body from `i` (just after its opening quote): its text decoded so far, and
 * whether its closing quote came. A cut escape at the end is dropped, and so is a high
 * surrogate with no low one after it yet.
 */
function readString(text: string, i: number): { value: string; end: number; closed: boolean } {
  let out = '';
  let j = i;
  while (j < text.length) {
    const c = text[j] as string;
    if (c === '"') return { value: out, end: j + 1, closed: true };
    if (c !== '\\') {
      out += c;
      j++;
      continue;
    }
    const e = text[j + 1];
    if (e === undefined) break; // cut after the backslash
    if (e === 'u') {
      const hex = text.slice(j + 2, j + 6);
      if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) break; // cut inside \uXXXX
      out += String.fromCharCode(Number.parseInt(hex, 16));
      j += 6;
      continue;
    }
    out += ESC[e] ?? e;
    j += 2;
  }
  // Cut short: half a surrogate pair isn't a character yet.
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return { value: out, end: text.length, closed: false };
}

export function partialTalk(text: string): PartialTalk {
  const out: PartialTalk = {};
  let i = text.indexOf('{');
  if (i < 0) return out;
  i++;
  let depth = 1;
  /** At the top level: the property whose value comes next, if a key was just read. */
  let key: string | null = null;
  let expectKey = true;
  while (i < text.length && depth > 0) {
    const c = text[i] as string;
    if (c === '"') {
      const s = readString(text, i + 1);
      if (depth === 1 && expectKey) {
        if (!s.closed) return out;
        key = s.value;
        expectKey = false;
      } else if (depth === 1 && key !== null) {
        if (key === 'say') out.say = s.value;
        if (key === 'kind' && s.closed) {
          const k = s.value.trim().toLowerCase();
          if ((TALK_KINDS as readonly string[]).includes(k)) out.kind = k as TalkKind;
        }
        key = null;
      }
      if (!s.closed) return out;
      i = s.end;
      continue;
    }
    if (c === '{' || c === '[') {
      depth++;
      key = null;
    } else if (c === '}' || c === ']') depth--;
    else if (c === ',' && depth === 1) {
      expectKey = true;
      key = null;
    }
    i++;
  }
  return out;
}
