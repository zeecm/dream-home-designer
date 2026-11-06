import { type AiSettings, CURATED, PROVIDERS, type Provider } from './credentials';
import { AiError, anySignal, errorBody, failure, timeoutSignal } from './providers';

/** A model to choose: its id exactly as the provider lists it, and a name to show. */
export interface ModelOption {
  id: string;
  name: string;
}

/** A provider's models for each job, best first. */
export interface ModelLists {
  /** Reads plans and suggests layouts (JSON out, images in). */
  text: ModelOption[];
  /** Makes pictures (empty for Claude). */
  image: ModelOption[];
}

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';

/** The browser headers for Anthropic, as its SDK sends them with `dangerouslyAllowBrowser`. */
export const anthropicHeaders = (key: string) => ({
  'x-api-key': key,
  'anthropic-version': '2023-06-01',
  'anthropic-dangerous-direct-browser-access': 'true',
});

/** A date or snapshot number at the end of an id: claude-…-20250514, gpt-…-2025-08-07, …-001. */
const SNAPSHOT = /-(\d{8}|\d{4}-\d{2}-\d{2}|\d{3,4})$/;

/**
 * How an id ranks: newer versions first, then the more capable tier, then a stable name
 * before a preview, an experiment or a dated snapshot.
 */
function rank(id: string): { version: number[]; tier: number; unstable: number } {
  const base = id.replace(SNAPSHOT, '').replace(/-(preview|exp)\b.*$/, '');
  // Small numbers only: 2.5, 3.1, 5-5, 4o; never a date.
  const version = (base.match(/\d+/g) ?? []).filter((n) => n.length <= 2).map(Number);
  const tier = /opus|(^|-)pro($|-)/.test(base)
    ? 0
    : /lite|nano/.test(base)
      ? 3
      : /flash|mini|haiku/.test(base)
        ? 2
        : 1;
  const unstable = (/preview|exp|latest/.test(id) ? 1 : 0) + (SNAPSHOT.test(id) ? 1 : 0);
  return { version, tier, unstable };
}

/** Best first: newest version, most capable tier, stable before preview. */
export function byBest(a: string, b: string): number {
  const ra = rank(a);
  const rb = rank(b);
  for (let i = 0; i < Math.max(ra.version.length, rb.version.length); i++) {
    const d = (rb.version[i] ?? 0) - (ra.version[i] ?? 0);
    if (d) return d;
  }
  return ra.tier - rb.tier || ra.unstable - rb.unstable || a.localeCompare(b);
}

/** The options sorted best first, a name shown once (an id added where two share it). */
function tidy(options: ModelOption[]): ModelOption[] {
  const unique = [...new Map(options.map((o) => [o.id, o])).values()].sort((a, b) =>
    byBest(a.id, b.id),
  );
  const count = new Map<string, number>();
  for (const o of unique) count.set(o.name, (count.get(o.name) ?? 0) + 1);
  return unique.map((o) =>
    o.name !== o.id && (count.get(o.name) ?? 0) > 1 ? { ...o, name: `${o.name} (${o.id})` } : o,
  );
}

/** Gemini models that can't do these jobs: not for text, nor for pictures. */
const GEMINI_NOT_TEXT = /image|tts|embedding|aqa|imagen|veo|audio|live|gemma|robotics|computer-use/;

/** Gemini's `GET /models` answer as model lists. */
export function parseGemini(body: unknown): ModelLists {
  const models = ((body as { models?: unknown })?.models ?? []) as {
    name?: unknown;
    displayName?: unknown;
    supportedGenerationMethods?: unknown;
  }[];
  const text: ModelOption[] = [];
  const image: ModelOption[] = [];
  for (const m of Array.isArray(models) ? models : []) {
    if (typeof m?.name !== 'string') continue;
    const id = m.name.replace(/^models\//, '');
    const methods = Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods : [];
    if (!methods.includes('generateContent')) continue;
    const option = {
      id,
      name: typeof m.displayName === 'string' && m.displayName ? m.displayName : id,
    };
    if (/image|nano-banana/.test(id)) image.push(option);
    else if (/^gemini-/.test(id) && !GEMINI_NOT_TEXT.test(id)) text.push(option);
  }
  return { text: tidy(text), image: tidy(image) };
}

/** OpenAI's `GET /models` answer as model lists (it gives no names: the ids are shown). */
export function parseOpenAi(body: unknown): ModelLists {
  const data = ((body as { data?: unknown })?.data ?? []) as { id?: unknown }[];
  const ids = (Array.isArray(data) ? data : [])
    .map((m) => m?.id)
    .filter((id): id is string => typeof id === 'string');
  // Only chat-completions models that take an image and answer to a strict schema (and
  // their dated snapshots): not o1-mini or o3-mini (no images), nor the -pro models (not
  // on chat completions), audio, search or the like.
  const text = ids.filter((id) =>
    /^(gpt-(4o|4\.1|5(\.\d+)?)(-mini|-nano)?|o1|o3|o4-mini)(-\d{4}-\d{2}-\d{2})?$/.test(id),
  );
  const image = ids.filter((id) => /^gpt-image-/.test(id));
  const opt = (id: string) => ({ id, name: id });
  return { text: tidy(text.map(opt)), image: tidy(image.map(opt)) };
}

/** Anthropic's `GET /models` answer as model lists (Claude makes no pictures). */
export function parseAnthropic(body: unknown): ModelLists {
  const data = ((body as { data?: unknown })?.data ?? []) as {
    id?: unknown;
    display_name?: unknown;
  }[];
  const text = (Array.isArray(data) ? data : []).flatMap((m) =>
    typeof m?.id === 'string' && m.id.startsWith('claude')
      ? [
          {
            id: m.id,
            name: typeof m.display_name === 'string' && m.display_name ? m.display_name : m.id,
          },
        ]
      : [],
  );
  return { text: tidy(text), image: [] };
}

/** The built-in lists, for when the provider's can't be had. */
export function curated(p: Provider): ModelLists {
  const opt = (id: string) => ({ id, name: id });
  return { text: CURATED[p].text.map(opt), image: CURATED[p].image.map(opt) };
}

/**
 * The model to suggest from those listed: the provider's default when listed (for pictures,
 * the cheaper gemini-2.5-flash-image and gpt-image-1: every render costs); for Gemini's
 * plans, the best Pro; otherwise the best listed.
 */
export function recommended(
  p: Provider,
  kind: keyof ModelLists,
  ids: string[],
): string | undefined {
  if (p === 'gemini' && kind === 'text') {
    return ids.find((id) => rank(id).tier === 0 && !SNAPSHOT.test(id)) ?? ids[0];
  }
  const fallback = kind === 'text' ? PROVIDERS[p].model : PROVIDERS[p].imageModel;
  return fallback && ids.includes(fallback) ? fallback : ids[0];
}

async function getJson(
  url: string,
  headers: Record<string, string>,
  key: string,
  p: Provider,
  signal: AbortSignal,
) {
  let res: Response;
  try {
    res = await fetch(url, { headers, signal });
  } catch (e) {
    if (signal.aborted) throw e;
    throw new AiError('network', 'Couldn’t reach the provider (network or browser block).');
  }
  if (!res.ok) throw failure(p, res.status, await errorBody(res), key);
  const body = (await res.json()) as unknown;
  // An answer that comes after the key changed (or the dialog closed) is never used.
  signal.throwIfAborted();
  return body;
}

/**
 * The models this key can use, straight from the provider with the key (and only to it).
 * Throws an AiError when they can't be listed.
 */
export async function listModels(
  p: Provider,
  key: string,
  signal: AbortSignal,
): Promise<ModelLists> {
  const k = key.trim();
  if (p === 'gemini') {
    const all: unknown[] = [];
    let page = '';
    // A few pages at most: one is usually all there is.
    for (let i = 0; i < 5; i++) {
      const body = (await getJson(
        `${GEMINI}/models?pageSize=200${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`,
        { 'x-goog-api-key': k },
        k,
        p,
        signal,
      )) as { models?: unknown[]; nextPageToken?: unknown };
      all.push(...(Array.isArray(body?.models) ? body.models : []));
      if (typeof body?.nextPageToken !== 'string' || !body.nextPageToken) break;
      page = body.nextPageToken;
    }
    return parseGemini({ models: all });
  }
  if (p === 'openai') {
    return parseOpenAi(
      await getJson(
        'https://api.openai.com/v1/models',
        { authorization: `Bearer ${k}` },
        k,
        p,
        signal,
      ),
    );
  }
  return parseAnthropic(
    await getJson(
      'https://api.anthropic.com/v1/models?limit=1000',
      anthropicHeaders(k),
      k,
      p,
      signal,
    ),
  );
}

/**
 * Checks the key can use its picture model without making a picture: Gemini counts the
 * tokens of a word (free), OpenAI looks the model up.
 */
export async function checkPictureModel(
  ai: AiSettings,
  model: string,
  cancel?: AbortSignal,
): Promise<void> {
  const timeout = timeoutSignal(30_000);
  const signal = cancel ? anySignal([cancel, timeout]) : timeout;
  const k = ai.key.trim();
  let res: Response;
  try {
    res =
      ai.provider === 'gemini'
        ? await fetch(`${GEMINI}/models/${encodeURIComponent(model)}:countTokens`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-goog-api-key': k },
            body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'A kitchen.' }] }] }),
            signal,
          })
        : await fetch(`https://api.openai.com/v1/models/${encodeURIComponent(model)}`, {
            headers: { authorization: `Bearer ${k}` },
            signal,
          });
  } catch {
    if (cancel?.aborted) throw new AiError('cancelled', 'Cancelled.');
    throw new AiError('network', 'Couldn’t reach the provider. Check your connection.');
  }
  if (!res.ok) throw failure(ai.provider, res.status, await errorBody(res), k);
}
