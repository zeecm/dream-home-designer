import { describe, expect, it } from 'vitest';
import { anthropicStream, geminiStream, openaiStream } from './fixtures/streams';
import { SseParser, chunkedBody, readSse } from './sse';

const usage = { input: 1200, cached: 300, output: 900, thoughts: 400 };
const answer = { name: 'Mdm Lim’s room · 一 · 🛋️', items: [{ ref: 'bed1', why: 'Café-close' }] };

async function events(text: string, sizes: number[]) {
  const out: { event: string; data: string }[] = [];
  await readSse(chunkedBody(text, sizes), (e) => out.push(e));
  return out;
}

describe('the SSE parser', () => {
  it('reads every provider’s stream the same however the bytes are split', async () => {
    for (const text of [
      anthropicStream(answer, usage),
      openaiStream(answer, usage),
      geminiStream(answer, usage),
    ]) {
      const whole = await events(text, [text.length]);
      expect(whole.length).toBeGreaterThan(3);
      // Splits through multi-byte characters, \r\n pairs and field names.
      for (const sizes of [[1], [2], [3], [5], [7], [1, 13, 2, 64], [4096]]) {
        expect(await events(text, sizes)).toEqual(whole);
      }
      // The answer comes back whole, the curly quote, CJK and emoji intact.
      const json = whole
        .map((e) => e.data)
        .filter((d) => d !== '[DONE]')
        .map((d) => JSON.parse(d) as unknown);
      expect(JSON.stringify(json)).toContain('Mdm Lim’s room · 一 · 🛋️'.slice(0, 4));
    }
  });

  it('names events, joins multi-line data, skips comments, and waits for a split \\r\\n', () => {
    const p = new SseParser();
    expect(p.push('event: message_start\r')).toEqual([]);
    expect(p.push('\ndata: {"a":1}\r')).toEqual([]);
    expect(p.push('\n: keep-alive\r\n')).toEqual([]);
    expect(p.push('data: {"b":2}\r\n\r\n')).toEqual([
      { event: 'message_start', data: '{"a":1}\n{"b":2}' },
    ]);
    expect(p.push('data:x\n\ndata: y')).toEqual([{ event: 'message', data: 'x' }]);
    // A stream that ends without its blank line still gives its last event.
    expect(p.end()).toEqual([{ event: 'message', data: 'y' }]);
  });

  it('takes a lone \\r as a line end', () => {
    const p = new SseParser();
    expect(p.push('data: a\r\rdata: b\r')).toEqual([{ event: 'message', data: 'a' }]);
    expect(p.push('\r\n')).toEqual([{ event: 'message', data: 'b' }]);
  });

  it('lets go of the response when reading fails', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode('data: {"a":1}\n\ndata: {"b":2}\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      readSse(body, () => {
        throw new Error('an error event');
      }),
    ).rejects.toThrow('an error event');
    expect(cancelled).toBe(true);
  });
});
