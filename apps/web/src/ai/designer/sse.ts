/**
 * Server-sent events, as all three providers stream them: `event:` and `data:` lines, an
 * empty line ending each event. Lines may end in \n, \r\n (Gemini) or \r, and a network
 * chunk can end anywhere, even inside a character or between \r and \n, so bytes are decoded
 * as a stream and only whole lines are read.
 */
export interface SseEvent {
  /** The `event:` field ('message' when there is none). */
  event: string;
  data: string;
}

export class SseParser {
  private buf = '';
  private event = '';
  private data: string[] = [];

  /** The events that `chunk` completes. */
  push(chunk: string): SseEvent[] {
    this.buf += chunk;
    return this.lines(false);
  }

  /** The stream ended: whatever event was still open. */
  end(): SseEvent[] {
    const out = this.lines(true);
    if (this.buf) {
      this.line(this.buf, out);
      this.buf = '';
    }
    this.line('', out);
    return out;
  }

  private lines(final: boolean): SseEvent[] {
    const out: SseEvent[] = [];
    for (;;) {
      const i = this.buf.search(/[\r\n]/);
      if (i < 0) break;
      // A \r last in the chunk may be the first half of \r\n: wait for the next one.
      if (this.buf[i] === '\r' && i === this.buf.length - 1 && !final) break;
      const line = this.buf.slice(0, i);
      const skip = this.buf[i] === '\r' && this.buf[i + 1] === '\n' ? 2 : 1;
      this.buf = this.buf.slice(i + skip);
      this.line(line, out);
    }
    return out;
  }

  private line(line: string, out: SseEvent[]) {
    if (line === '') {
      if (this.data.length)
        out.push({ event: this.event || 'message', data: this.data.join('\n') });
      this.event = '';
      this.data = [];
      return;
    }
    if (line.startsWith(':')) return; // a comment (a keep-alive)
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.data.push(value);
    else if (field === 'event') this.event = value;
  }
}

/** Reads a response body as events, calling `onEvent` for each as it completes. */
export async function readSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (e: SseEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  const parser = new SseParser();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const e of parser.push(decoder.decode(value, { stream: true }))) onEvent(e);
    }
    for (const e of parser.push(decoder.decode())) onEvent(e);
    for (const e of parser.end()) onEvent(e);
  } catch (e) {
    // An error event, or the connection lost: let go of the response, not just this read.
    await reader.cancel(e).catch(() => {});
    throw e;
  } finally {
    reader.releaseLock();
  }
}

/** A body that streams `text` in pieces of `sizes` bytes (cycled): for tests and fixtures. */
export function chunkedBody(text: string, sizes: number[] = [64]): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  let n = 0;
  return new ReadableStream({
    pull(ctrl) {
      if (at >= bytes.length) {
        ctrl.close();
        return;
      }
      const size = Math.max(1, sizes[n++ % sizes.length] ?? 64);
      ctrl.enqueue(bytes.slice(at, at + size));
      at += size;
    },
  });
}
