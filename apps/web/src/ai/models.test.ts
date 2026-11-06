import { describe, expect, it } from 'vitest';
import { byBest, curated, parseAnthropic, parseGemini, parseOpenAi, recommended } from './models';

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
    ]);
    expect(lists.text[0]?.name).toBe('Gemini 3 Pro');
    // Two share a name: the id tells them apart.
    expect(lists.image.map((m) => m.name)).toContain('Nano Banana Pro (gemini-3-pro-image)');
    expect(recommended('gemini', 'text', ids(lists.text))).toBe('gemini-3-pro');
    expect(recommended('gemini', 'image', ids(lists.image))).toBe('gemini-3-pro-image');
  });

  it('recommends the best listed Pro, and gemini-2.5-flash-image without 3 Pro Image', () => {
    expect(recommended('gemini', 'text', ['gemini-3-pro-preview', 'gemini-2.5-pro'])).toBe(
      'gemini-3-pro-preview',
    );
    expect(
      recommended('gemini', 'image', ['gemini-3.1-flash-image', 'gemini-2.5-flash-image']),
    ).toBe('gemini-2.5-flash-image');
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
