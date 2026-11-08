import { PROVIDERS, type Provider } from './providers';

/** Why a request to a model failed, in words a person can act on. */
export class AiError extends Error {
  constructor(
    readonly kind: 'key' | 'quota' | 'network' | 'timeout' | 'refused' | 'unreadable' | 'cancelled',
    message: string,
  ) {
    super(message);
  }
}

/** Aborts when any of `signals` does (AbortSignal.any, where the browser lacks it). */
export function anySignal(signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals);
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      ctrl.abort(s.reason);
      break;
    }
    s.addEventListener('abort', () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
}

/** The longest provider message shown. */
const MESSAGE_MAX = 200;

/** A token's dotted parts after its first (sk-proj-abc.def123, AQ.abc.def): all of it goes. */
const DOTTED = String.raw`(?:\.[\w*-]+)*`;

/** Whether a long run of token characters looks like a secret rather than words or a name. */
const secretLike = (s: string) =>
  (/[A-Z]/.test(s) && /[a-z]/.test(s) && /\d/.test(s)) || /^[a-f0-9]{32,}$/i.test(s);

/**
 * `text` on one line, without anything that looks like an API key or token: `key` itself;
 * the shapes of Anthropic's and OpenAI's keys (sk-…), Google's (AIza…, AQ.…, ya29.…) and
 * others' (sk_live_…); and any long random-looking run (base64 or hex). Lower-case names
 * such as models/gemini-2.5-flash-image-preview stay readable.
 */
export function redact(text: string, key?: string): string {
  let out = text;
  const k = key?.trim();
  if (k && k.length >= 6) out = out.split(k).join('[key]');
  return out
    .replace(new RegExp(String.raw`\bsk-[\w*-]{6,}${DOTTED}`, 'g'), '[key]')
    .replace(/\bsk_[a-z]+_[\w*]{8,}/g, '[key]')
    .replace(/\bAIza[\w-]{10,}/g, '[key]')
    .replace(new RegExp(String.raw`\bAQ\.[\w-]{20,}${DOTTED}`, 'g'), '[key]')
    .replace(new RegExp(String.raw`\bya29\.[\w-]{10,}${DOTTED}`, 'g'), '[key]')
    .replace(/\b(Bearer|key=)\s*[\w.~+/=-]{12,}/gi, '$1 [key]')
    .replace(/[\w\-.+/=]{32,}/g, (run) => (secretLike(run) ? '[key]' : run))
    .replace(/[\p{Cc}\s]+/gu, ' ')
    .trim();
}

/**
 * What a provider said about a failed request: `error.message` in Anthropic's, OpenAI's and
 * Gemini's error bodies (Gemini sometimes sends a list of one), without the key, and cut to
 * about 200 characters. Null when it said nothing readable.
 */
export function providerMessage(body: unknown, key?: string): string | null {
  const first: unknown = Array.isArray(body) ? body[0] : body;
  let text: unknown = (first as { error?: { message?: unknown } } | null)?.error?.message;
  if (typeof text !== 'string' && typeof first === 'string') {
    // Not JSON: plain text, unless it is a page of HTML.
    text = /<[a-z!]/i.test(first) ? null : first;
  }
  if (typeof text !== 'string') return null;
  const clean = redact(text, key);
  if (!clean) return null;
  return clean.length > MESSAGE_MAX ? `${clean.slice(0, MESSAGE_MAX - 1).trimEnd()}…` : clean;
}

/**
 * Whether the provider said, in so many words, that the key itself is wrong: Google answers
 * 400 for a bad key, with reason API_KEY_INVALID.
 */
function saysBadKey(body: unknown): boolean {
  const first = (Array.isArray(body) ? body[0] : body) as {
    error?: { message?: unknown; code?: unknown; details?: { reason?: unknown }[] };
  } | null;
  const message = first?.error?.message;
  return (
    (typeof message === 'string' &&
      /API key not valid|invalid api key|incorrect api key|invalid x-api-key/i.test(message)) ||
    first?.error?.code === 'invalid_api_key' ||
    !!first?.error?.details?.some((d) => d?.reason === 'API_KEY_INVALID')
  );
}

/** What the AI-settings errors point to; left off inside AI settings (`inSettings`). */
const TO_SETTINGS = ' Check it in AI settings.';

/** An error's words as shown inside AI settings, where pointing to them is no help. */
export const inSettings = (e: AiError) => e.message.replace(TO_SETTINGS, '');

/** `text` ending as a sentence, so words of ours can follow it. */
const sentence = (text: string) => (/[.!?…]$/.test(text) ? text : `${text}.`);

/** A failed response from `provider`, in words a person can act on, with what it said. */
export function failure(provider: Provider, status: number, body: unknown, key?: string): AiError {
  const said = providerMessage(body, key);
  const name = PROVIDERS[provider].short;
  const tail = said ? `: ${sentence(said)}` : '.';
  // A key error only when it is one: a 401, or the provider saying the key is wrong.
  if (status === 401 || ((status === 400 || status === 403) && saysBadKey(body))) {
    return new AiError('key', `The key was refused.${TO_SETTINGS}`);
  }
  if (status === 403) {
    // Not the key as such: an organisation to verify, a model or a region the account can't use.
    return new AiError('refused', `${name} refused the request (403)${tail}`);
  }
  if (status === 429) {
    return new AiError(
      'quota',
      said
        ? `The key’s limit or quota is used up for now (429)${tail}`
        : 'The key’s limit or quota is used up for now. Try again later.',
    );
  }
  if (status >= 400 && status < 500) {
    return new AiError('unreadable', `${name} turned the request down (${status})${tail}`);
  }
  return new AiError(
    'network',
    `${name} couldn’t answer just now (${status})${said ? `${tail} Try again in a moment.` : '. Try again in a moment.'}`,
  );
}

/** The body of a failed response: its JSON, or its text. */
export async function errorBody(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => '');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
