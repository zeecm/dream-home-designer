/**
 * Streamed answers as each provider sends them (server-sent events), built from the core's
 * mocked answers: for the runner's tests and the e2e suite. No test calls a real provider.
 */

export interface FixtureUsage {
  input: number;
  cached?: number;
  cacheWrite?: number;
  output: number;
  thoughts?: number;
}

/** `text` in `n` pieces, cut anywhere (a model streams a few characters at a time). */
function pieces(text: string, n = 4): string[] {
  const size = Math.max(1, Math.ceil(text.length / n));
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

const sse = (event: string | null, data: unknown) =>
  `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`;

export function anthropicStream(
  answer: unknown,
  usage: FixtureUsage,
  opts: {
    model?: string;
    stop?: 'end_turn' | 'max_tokens' | 'refusal';
    /** The thinking summary, streamed as these pieces. */
    thinking?: string[];
  } = {},
): string {
  const text = typeof answer === 'string' ? answer : JSON.stringify(answer);
  const out = [
    sse('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_fixture',
        type: 'message',
        role: 'assistant',
        model: opts.model ?? 'claude-opus-5-5',
        content: [],
        stop_reason: null,
        usage: {
          input_tokens: usage.input,
          cache_creation_input_tokens: usage.cacheWrite ?? 0,
          cache_read_input_tokens: usage.cached ?? 0,
          output_tokens: 3,
        },
      },
    }),
    ': keep-alive\n\n',
    sse('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    }),
    ...(opts.thinking ?? ['Looking at the walls first.']).map((t) =>
      sse('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: t },
      }),
    ),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('content_block_start', {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'text', text: '' },
    }),
    ...pieces(text).map((t) =>
      sse('content_block_delta', {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: t },
      }),
    ),
    sse('content_block_stop', { type: 'content_block_stop', index: 1 }),
    sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: opts.stop ?? 'end_turn', stop_sequence: null },
      usage: { output_tokens: usage.output },
    }),
    sse('message_stop', { type: 'message_stop' }),
  ];
  return out.join('');
}

export function openaiStream(
  answer: unknown,
  usage: FixtureUsage,
  opts: { model?: string; finish?: 'stop' | 'length'; refusal?: string } = {},
): string {
  const text = typeof answer === 'string' ? answer : JSON.stringify(answer);
  const model = opts.model ?? 'gpt-5-2025-08-07';
  const chunk = (delta: unknown, finish: string | null = null) =>
    sse(null, {
      id: 'chatcmpl-fixture',
      object: 'chat.completion.chunk',
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
      usage: null,
    });
  const out = [
    chunk({ role: 'assistant', content: '' }),
    ...(opts.refusal
      ? [chunk({ refusal: opts.refusal })]
      : pieces(text).map((t) => chunk({ content: t }))),
    chunk({}, opts.finish ?? 'stop'),
    sse(null, {
      id: 'chatcmpl-fixture',
      object: 'chat.completion.chunk',
      model,
      choices: [],
      usage: {
        prompt_tokens: usage.input + (usage.cached ?? 0),
        completion_tokens: usage.output,
        total_tokens: usage.input + (usage.cached ?? 0) + usage.output,
        prompt_tokens_details: { cached_tokens: usage.cached ?? 0 },
        completion_tokens_details: { reasoning_tokens: usage.thoughts ?? 0 },
      },
    }),
    'data: [DONE]\n\n',
  ];
  return out.join('');
}

/** Gemini ends its lines with \r\n. */
export function geminiStream(
  answer: unknown,
  usage: FixtureUsage,
  opts: { model?: string; finish?: 'STOP' | 'MAX_TOKENS' | 'SAFETY' } = {},
): string {
  const text = typeof answer === 'string' ? answer : JSON.stringify(answer);
  const model = opts.model ?? 'gemini-2.5-pro';
  const parts = pieces(text, 3);
  const out = [
    sse(null, {
      candidates: [
        {
          content: { parts: [{ text: 'Thinking about the rooms.', thought: true }], role: 'model' },
          index: 0,
        },
      ],
      usageMetadata: { promptTokenCount: usage.input + (usage.cached ?? 0) },
      modelVersion: model,
    }),
    ...parts.map((t, i) =>
      sse(null, {
        candidates: [
          {
            content: { parts: [{ text: t }], role: 'model' },
            index: 0,
            ...(i === parts.length - 1 ? { finishReason: opts.finish ?? 'STOP' } : {}),
          },
        ],
        usageMetadata: {
          promptTokenCount: usage.input + (usage.cached ?? 0),
          ...(i === parts.length - 1
            ? {
                cachedContentTokenCount: usage.cached ?? 0,
                candidatesTokenCount: usage.output - (usage.thoughts ?? 0),
                thoughtsTokenCount: usage.thoughts ?? 0,
                totalTokenCount: usage.input + (usage.cached ?? 0) + usage.output,
              }
            : {}),
        },
        modelVersion: model,
      }),
    ),
  ];
  return out.join('').replace(/\n/g, '\r\n');
}
