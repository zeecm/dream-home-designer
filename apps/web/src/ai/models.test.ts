import { AiError } from '@dhd/ai';
import { describe, expect, it } from 'vitest';
import { afterEach, vi } from 'vitest';
import { priceNote } from './credentials';
import {
  byBest,
  checkPictureModel,
  curated,
  listModels,
  modelName,
  openAiName,
  parseAnthropic,
  parseGemini,
  parseOpenAi,
  recommended,
} from './models';

/** Trimmed from Gemini's `GET /v1beta/models` answer. */
const gemini = {
  models: [
    {
      name: 'models/gemini-2.5-flash',
      displayName: 'Gemini 2.5 Flash',
      supportedGenerationMethods: ['generateContent', 'countTokens'],
    },
    {
      name: 'models/gemini-2.5-pro',
      displayName: 'Gemini 2.5 Pro',
      supportedGenerationMethods: ['generateContent', 'countTokens'],
    },
    {
      name: 'models/gemini-3-pro-preview',
      displayName: 'Gemini 3 Pro Preview',
      supportedGenerationMethods: ['generateContent', 'countTokens'],
    },
    {
      name: 'models/gemini-3-pro',
      displayName: 'Gemini 3 Pro',
      supportedGenerationMethods: ['generateContent', 'countTokens'],
    },
    {
      name: 'models/gemini-2.5-flash-lite',
      displayName: 'Gemini 2.5 Flash-Lite',
      supportedGenerationMethods: ['generateContent'],
    },
    {
      name: 'models/gemini-2.5-flash-image',
      displayName: 'Nano Banana',
      supportedGenerationMethods: ['generateContent', 'countTokens'],
    },
    {
      name: 'models/gemini-3-pro-image',
      displayName: 'Nano Banana Pro',
      supportedGenerationMethods: ['generateContent', 'countTokens'],
    },
    {
      name: 'models/gemini-3-pro-image-preview',
      displayName: 'Nano Banana Pro',
      supportedGenerationMethods: ['generateContent', 'countTokens'],
    },
    {
      name: 'models/gemini-3.1-flash-image',
      displayName: 'Gemini 3.1 Flash Image',
      supportedGenerationMethods: ['generateContent'],
    },
    {
      name: 'models/gemini-2.5-flash-preview-tts',
      displayName: 'Gemini 2.5 Flash TTS',
      supportedGenerationMethods: ['generateContent'],
    },
    {
      name: 'models/gemini-embedding-001',
      displayName: 'Gemini Embedding',
      supportedGenerationMethods: ['embedContent'],
    },
    { name: 'models/aqa', displayName: 'AQA', supportedGenerationMethods: ['generateAnswer'] },
    {
      name: 'models/imagen-4.0-generate-001',
      displayName: 'Imagen 4',
      supportedGenerationMethods: ['predict'],
    },
    {
      name: 'models/gemma-3-27b-it',
      displayName: 'Gemma 3 27B',
      supportedGenerationMethods: ['generateContent'],
    },
    {
      name: 'models/learnlm-2.0-flash-experimental',
      displayName: 'LearnLM 2.0 Flash Experimental',
      supportedGenerationMethods: ['generateContent'],
    },
    {
      name: 'models/nano-banana-pro-preview',
      displayName: 'Nano Banana Pro Preview',
      supportedGenerationMethods: ['generateContent'],
    },
  ],
};

/** Trimmed from OpenAI's `GET /v1/models` answer. */
const openai = {
  object: 'list',
  data: [
    'gpt-4o',
    'gpt-5-mini',
    'gpt-5',
    'gpt-5-2025-08-07',
    'o3',
    'gpt-3.5-turbo',
    'gpt-4-turbo',
    'gpt-4.1',
    'gpt-4o-audio-preview',
    'gpt-4o-realtime-preview',
    'gpt-4o-mini-tts',
    'gpt-4o-transcribe',
    'gpt-image-1',
    'gpt-image-1-mini',
    'dall-e-3',
    'whisper-1',
    'text-embedding-3-large',
    'omni-moderation-latest',
    // No image input, or not on chat completions
    'o1-mini',
    'o3-mini',
    'o3-pro',
    'o1-pro',
    'gpt-5-pro',
    'gpt-5-chat-latest',
    'gpt-5-codex',
    'gpt-4o-search-preview',
  ].map((id) => ({ id, object: 'model', created: 1, owned_by: 'openai' })),
};

/** Trimmed from Anthropic's `GET /v1/models` answer. */
const anthropic = {
  data: [
    { type: 'model', id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5' },
    { type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' },
    { type: 'model', id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' },
    { type: 'model', id: 'claude-opus-4-1-20250805', display_name: 'Claude Opus 4.1' },
  ],
  has_more: false,
};

const ids = (o: { id: string }[]) => o.map((m) => m.id);

describe('model lists', () => {
  it('reads Gemini: text and image models apart, by their friendly names', () => {
    const lists = parseGemini(gemini);
    expect(ids(lists.text)).toEqual([
      'gemini-3-pro',
      'gemini-3-pro-preview',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
    ]);
    expect(ids(lists.image)).toEqual([
      'gemini-3.1-flash-image',
      'gemini-3-pro-image',
      'gemini-3-pro-image-preview',
      'gemini-2.5-flash-image',
      'nano-banana-pro-preview',
    ]);
    expect(lists.text[0]?.name).toBe('Gemini 3 Pro');
    // Two share a name: the preview says so.
    expect(lists.image.map((m) => m.name)).toEqual([
      'Gemini 3.1 Flash Image',
      'Nano Banana Pro',
      'Nano Banana Pro preview',
      'Nano Banana',
      'Nano Banana Pro Preview',
    ]);
    // Names that still clash: the ids.
    expect(
      parseGemini({
        models: ['gemini-x-image-a', 'gemini-x-image-b'].map((id) => ({
          name: `models/${id}`,
          displayName: 'Same',
          supportedGenerationMethods: ['generateContent'],
        })),
      }).image.map((m) => m.name),
    ).toEqual(['gemini-x-image-a', 'gemini-x-image-b']);
    expect(recommended('gemini', 'text', ids(lists.text))).toBe('gemini-3-pro');
    // Every render costs: the cheaper picture model is the one suggested.
    expect(recommended('gemini', 'image', ids(lists.image))).toBe('gemini-2.5-flash-image');
  });

  it('recommends the best listed Pro, and the best picture model when the cheap one is not listed', () => {
    expect(recommended('gemini', 'text', ['gemini-3-pro-preview', 'gemini-2.5-pro'])).toBe(
      'gemini-3-pro-preview',
    );
    expect(recommended('gemini', 'image', ['gemini-3.1-flash-image', 'gemini-3-pro-image'])).toBe(
      'gemini-3.1-flash-image',
    );
    expect(priceNote('gemini-2.5-flash-image')).toBe('cheaper');
    expect(priceNote('gemini-3-pro-image-preview')).toBe('about 3× the price');
    expect(priceNote('gemini-3.1-flash-image')).toBeUndefined();
  });

  it('reads OpenAI: chat models and gpt-image models only', () => {
    const lists = parseOpenAi(openai);
    expect(ids(lists.text)).toEqual([
      'gpt-5',
      'gpt-5-2025-08-07',
      'gpt-5-mini',
      'gpt-4.1',
      'gpt-4o',
      'o3',
    ]);
    expect(ids(lists.image)).toEqual(['gpt-image-1', 'gpt-image-1-mini']);
    expect(recommended('openai', 'text', ids(lists.text))).toBe('gpt-5');
    expect(recommended('openai', 'image', ids(lists.image))).toBe('gpt-image-1');
  });

  it('reads Anthropic, newest and most capable first', () => {
    const lists = parseAnthropic(anthropic);
    expect(ids(lists.text)).toEqual([
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
      'claude-opus-4-1-20250805',
    ]);
    expect(lists.text[0]?.name).toBe('Claude Opus 5.5');
    expect(lists.image).toEqual([]);
    expect(recommended('anthropic', 'text', ids(lists.text))).toBe('claude-opus-5-5');
  });

  it('names models by their names, not their ids', () => {
    expect(parseOpenAi(openai).text.map((m) => m.name)).toEqual([
      'GPT-5',
      'GPT-5 (2025-08-07)',
      'GPT-5 mini',
      'GPT-4.1',
      'GPT-4o',
      'o3',
    ]);
    expect(openAiName('gpt-image-1-mini')).toBe('GPT Image 1 mini');
    expect(openAiName('o4-mini')).toBe('o4 mini');
    expect(curated('anthropic').text.map((m) => m.name)).toEqual([
      'Claude Opus 5.5',
      'Claude Sonnet 5.5',
      'Claude Haiku 5.5',
    ]);
    expect(curated('gemini').image.map((m) => m.name)).toEqual([
      'Gemini 3 Pro Image',
      'Gemini 3.1 Flash Image',
      'Gemini 2.5 Flash Image',
    ]);
    expect(curated('openai').image.map((m) => m.name)).toEqual(['GPT Image 1']);
    expect(modelName('some-new-model')).toBe('some-new-model');
  });

  it('takes nothing from an answer of the wrong shape', () => {
    expect(parseGemini({ error: { message: 'no' } })).toEqual({ text: [], image: [] });
    expect(parseOpenAi(null)).toEqual({ text: [], image: [] });
    expect(parseAnthropic({ data: 'x' })).toEqual({ text: [], image: [] });
  });

  it('has the built-in lists to fall back on', () => {
    expect(ids(curated('gemini').image)).toEqual([
      'gemini-3-pro-image',
      'gemini-3.1-flash-image',
      'gemini-2.5-flash-image',
    ]);
    expect(ids(curated('anthropic').text)).toEqual([
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
    ]);
    expect(recommended('gemini', 'text', ids(curated('gemini').text))).toBe('gemini-3-pro');
  });

  it('sorts newer versions first, a stable name before its preview', () => {
    expect(['gemini-2.5-pro', 'gemini-3-pro-preview', 'gemini-3-pro'].sort(byBest)).toEqual([
      'gemini-3-pro',
      'gemini-3-pro-preview',
      'gemini-2.5-pro',
    ]);
  });
});

/** A fetch stand-in: records each call and answers with `reply`. */
function stubFetch(reply: (url: string, init: RequestInit) => Promise<Response> | Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      return reply(url, init);
    }),
  );
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const headers = (init: RequestInit | undefined) => new Headers(init?.headers);

afterEach(() => vi.unstubAllGlobals());

describe('asking the provider', () => {
  const KEY = 'AIzaSyD-test-key-0123456789abcdef';

  it('lists Gemini’s models with the key in a header, never in the address', async () => {
    const calls = stubFetch(() => json(gemini));
    const lists = await listModels('gemini', ` ${KEY} `, new AbortController().signal);
    expect(lists.text[0]?.id).toBe('gemini-3-pro');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200',
    );
    expect(calls[0]?.url).not.toContain(KEY);
    expect(headers(calls[0]?.init).get('x-goog-api-key')).toBe(KEY);
  });

  it('follows Gemini’s next pages', async () => {
    const calls = stubFetch((url) =>
      url.includes('pageToken')
        ? json({ models: gemini.models.slice(3) })
        : json({ models: gemini.models.slice(0, 3), nextPageToken: 'p/2' }),
    );
    const lists = await listModels('gemini', KEY, new AbortController().signal);
    expect(calls[1]?.url).toContain('pageToken=p%2F2');
    expect(lists.image.length).toBeGreaterThan(0);
  });

  it('lists OpenAI’s and Anthropic’s models with their own headers', async () => {
    const calls = stubFetch((url) => (url.includes('openai') ? json(openai) : json(anthropic)));
    await listModels('openai', 'sk-proj-key', new AbortController().signal);
    await listModels('anthropic', 'sk-ant-key', new AbortController().signal);
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/models');
    expect(headers(calls[0]?.init).get('authorization')).toBe('Bearer sk-proj-key');
    expect(calls[1]?.url).toBe('https://api.anthropic.com/v1/models?limit=1000');
    const h = headers(calls[1]?.init);
    expect(h.get('x-api-key')).toBe('sk-ant-key');
    expect(h.get('anthropic-version')).toBe('2023-06-01');
    expect(h.get('anthropic-dangerous-direct-browser-access')).toBe('true');
    for (const c of calls) expect(c.url).not.toMatch(/sk-/);
  });

  it('says why a list was refused, without the key', async () => {
    stubFetch(() =>
      json(
        { error: { code: 400, message: 'API key not valid. Please pass a valid API key.' } },
        400,
      ),
    );
    const e = await listModels('gemini', KEY, new AbortController().signal).catch((x) => x);
    expect(e).toBeInstanceOf(AiError);
    expect(e.kind).toBe('key');
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    const n = await listModels('openai', 'sk-x-123456', new AbortController().signal).catch(
      (x) => x,
    );
    expect(n.kind).toBe('network');
  });

  it('never answers for a key that changed while it was asking', async () => {
    const ctrl = new AbortController();
    let answer: (r: Response) => void = () => {};
    stubFetch(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    const listing = listModels('gemini', KEY, ctrl.signal);
    await Promise.resolve();
    // The key changes; the old answer comes in afterwards.
    ctrl.abort();
    answer(json(gemini));
    await expect(listing).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('checks the picture model without making a picture', async () => {
    const calls = stubFetch(() => json({ totalTokens: 3 }));
    await checkPictureModel(
      { provider: 'gemini', key: KEY, model: 'gemini-3-pro' },
      'gemini-2.5-flash-image',
    );
    expect(calls[0]?.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:countTokens',
    );
    expect(calls[0]?.init.method).toBe('POST');
    expect(headers(calls[0]?.init).get('x-goog-api-key')).toBe(KEY);
    expect(String(calls[0]?.init.body)).not.toContain(KEY);

    const openaiCalls = stubFetch(() => json({ id: 'gpt-image-1' }));
    await checkPictureModel(
      { provider: 'openai', key: 'sk-proj-k', model: 'gpt-5' },
      'gpt-image-1',
    );
    expect(openaiCalls[0]?.url).toBe('https://api.openai.com/v1/models/gpt-image-1');
    expect(openaiCalls[0]?.init.method).toBeUndefined();
    expect(headers(openaiCalls[0]?.init).get('authorization')).toBe('Bearer sk-proj-k');
  });

  it('reports a check stopped part way as cancelled, and a refusal in words', async () => {
    const ctrl = new AbortController();
    stubFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) =>
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          ),
        ),
    );
    const checking = checkPictureModel(
      { provider: 'gemini', key: KEY, model: 'gemini-3-pro' },
      'gemini-3-pro-image',
      ctrl.signal,
    );
    ctrl.abort();
    await expect(checking).rejects.toMatchObject({ kind: 'cancelled' });

    stubFetch(() => json({ error: { message: `models/x is not found (key ${KEY})` } }, 404));
    const e = await checkPictureModel(
      { provider: 'gemini', key: KEY, model: 'gemini-3-pro' },
      'x',
    ).catch((x) => x);
    expect(e.message).toBe(
      'Gemini turned the request down (404): models/x is not found (key [key]).',
    );
  });
});
