import type { AiSettings } from './credentials';

/** An image for a model: base64 (no data: prefix) and its type. */
export interface ModelImage {
  data: string;
  mediaType: 'image/png' | 'image/jpeg';
}

/** Why a request to a model failed, in words a person can act on. */
export class AiError extends Error {
  constructor(
    readonly kind: 'key' | 'quota' | 'network' | 'timeout' | 'refused' | 'unreadable' | 'cancelled',
    message: string,
  ) {
    super(message);
  }
}

/**
 * A dense plan can take a model a few minutes. One that has gone quiet this long (no word,
 * not even a summary of its thinking) is stuck; the overall limit applies only until the
 * answer starts to stream.
 */
const TIMEOUT = 300_000;
const QUIET = 120_000;

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

/** Fails as a timeout after `ms` (AbortSignal.timeout, where the browser lacks it). */
export function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(new DOMException('Timed out', 'TimeoutError')), ms);
  return ctrl.signal;
}

/**
 * `raw` with the string values of `keys` (anywhere in it) trimmed and in lower case: a
 * model that answers "Door" or "REMOVE_WALL" still means door and remove_wall.
 */
export function lowerEnums(raw: unknown, keys: string[]): unknown {
  if (Array.isArray(raw)) return raw.map((v) => lowerEnums(v, keys));
  if (raw && typeof raw === 'object') {
    return Object.fromEntries(
      Object.entries(raw).map(([k, v]) => [
        k,
        typeof v === 'string' && keys.includes(k) ? v.trim().toLowerCase() : lowerEnums(v, keys),
      ]),
    );
  }
  return raw;
}

/** Thrown when a stream went quiet for too long. */
class QuietError extends Error {}

/**
 * Asks the person's model about an image and returns JSON matching `schema` (a JSON
 * schema with every object closed and every property required). Straight from this
 * browser to the provider, with the person's own key.
 */
export async function askForJson(
  ai: AiSettings,
  prompt: string,
  image: ModelImage | null,
  schema: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const timeout = timeoutSignal(TIMEOUT);
  const both = signal ? anySignal([signal, timeout]) : timeout;
  try {
    const text =
      ai.provider === 'anthropic'
        ? // Streamed: stopped by Cancel or by going quiet, never mid-answer by the clock.
          await anthropic(ai, prompt, image, schema, signal ?? new AbortController().signal)
        : ai.provider === 'openai'
          ? await openai(ai, prompt, image, schema, both)
          : await gemini(ai, prompt, image, schema, both);
    try {
      return JSON.parse(text);
    } catch {
      throw new AiError('unreadable', 'The model’s answer couldn’t be read. Try again.');
    }
  } catch (e) {
    if (e instanceof AiError) throw e;
    if (signal?.aborted) throw new AiError('cancelled', 'Cancelled.');
    if (timeout.aborted || e instanceof QuietError) {
      throw new AiError('timeout', 'The model took too long to answer. Try again.');
    }
    throw toAiError(e);
  }
}

function toAiError(e: unknown): AiError {
  const status =
    e instanceof HttpError
      ? e.status
      : typeof (e as { status?: unknown })?.status === 'number'
        ? (e as { status: number }).status
        : undefined;
  if (status === 401 || status === 403) {
    return new AiError('key', 'The key was refused. Check it in AI settings.');
  }
  if (status === 429) {
    return new AiError('quota', 'The key’s limit or quota is used up for now. Try again later.');
  }
  if (status === 400 || status === 404) {
    return new AiError(
      'unreadable',
      `The provider turned the request down (${status}). Check the model name in AI settings.`,
    );
  }
  return new AiError(
    'network',
    'Couldn’t reach the model. Check your connection, or try again in a moment.',
  );
}

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

async function anthropic(
  ai: AiSettings,
  prompt: string,
  image: ModelImage | null,
  schema: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  // Loaded only when someone uses Claude.
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  // The person's own key in their own browser: what this option is for. No retries: a
  // slow answer retried would keep them waiting three times as long.
  const client = new Anthropic({ apiKey: ai.key, dangerouslyAllowBrowser: true, maxRetries: 0 });
  const stream = client.beta.messages.stream(
    {
      model: ai.model,
      max_tokens: 32000,
      // Thinking summarised, so a long think streams (and isn't taken for a stuck request).
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'high', format: { type: 'json_schema', schema } },
      betas: ['server-side-fallback-2026-07-01'],
      // A declined request is retried on Anthropic's recommended model, not failed.
      fallbacks: 'default',
      messages: [
        {
          role: 'user',
          content: [
            ...(image
              ? [
                  {
                    type: 'image' as const,
                    source: {
                      type: 'base64' as const,
                      media_type: image.mediaType,
                      data: image.data,
                    },
                  },
                ]
              : []),
            { type: 'text' as const, text: prompt },
          ],
        },
      ],
    },
    { signal },
  );
  // Gone quiet (no event, not even thinking, for a while): stuck.
  let wentQuiet = false;
  let quiet = setTimeout(() => {
    wentQuiet = true;
    stream.abort();
  }, QUIET);
  stream.on('streamEvent', () => {
    clearTimeout(quiet);
    quiet = setTimeout(() => {
      wentQuiet = true;
      stream.abort();
    }, QUIET);
  });
  const message = await stream
    .finalMessage()
    .catch((e) => {
      throw wentQuiet ? new QuietError() : e;
    })
    .finally(() => clearTimeout(quiet));
  if (message.stop_reason === 'refusal') {
    throw new AiError('refused', 'The model declined to read this image.');
  }
  if (message.stop_reason === 'max_tokens') {
    throw new AiError('unreadable', 'The plan was too big for one answer. Try a cropped image.');
  }
  return message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
}

async function post(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new HttpError(res.status);
  return res.json() as Promise<unknown>;
}

async function openai(
  ai: AiSettings,
  prompt: string,
  image: ModelImage | null,
  schema: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const out = (await post(
    'https://api.openai.com/v1/chat/completions',
    { authorization: `Bearer ${ai.key}` },
    {
      model: ai.model,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'answer', strict: true, schema },
      },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            ...(image
              ? [
                  {
                    type: 'image_url',
                    image_url: { url: `data:${image.mediaType};base64,${image.data}` },
                  },
                ]
              : []),
          ],
        },
      ],
    },
    signal,
  )) as { choices?: { message?: { content?: string; refusal?: string | null } }[] };
  const msg = out.choices?.[0]?.message;
  if (msg?.refusal) throw new AiError('refused', 'The model declined to read this image.');
  return msg?.content ?? '';
}

async function gemini(
  ai: AiSettings,
  prompt: string,
  image: ModelImage | null,
  schema: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const out = (await post(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(ai.model)}:generateContent`,
    { 'x-goog-api-key': ai.key },
    {
      contents: [
        {
          role: 'user',
          parts: [
            ...(image ? [{ inline_data: { mime_type: image.mediaType, data: image.data } }] : []),
            { text: prompt },
          ],
        },
      ],
      generationConfig: { responseMimeType: 'application/json', responseJsonSchema: schema },
    },
    signal,
  )) as {
    candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
    promptFeedback?: { blockReason?: string };
  };
  if (out.promptFeedback?.blockReason || out.candidates?.[0]?.finishReason === 'SAFETY') {
    throw new AiError('refused', 'The model declined to read this image.');
  }
  return (out.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
}
