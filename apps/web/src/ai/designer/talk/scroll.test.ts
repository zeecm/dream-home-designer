import { describe, expect, it } from 'vitest';
import { footInView, replyBelow } from './scroll';

/** A log 300 px tall whose top is at 100 px on the page, with a reply streaming or none. */
function log(reply: { bottom: number } | null) {
  return {
    clientHeight: 300,
    getBoundingClientRect: () => ({ top: 100 }) as DOMRect,
    querySelector: (sel: string) =>
      sel === '.talk-streaming' && reply
        ? ({ getBoundingClientRect: () => reply as DOMRect } as Element)
        : null,
  } as unknown as HTMLElement;
}

describe('the log’s foot, read now', () => {
  it('in view at the foot and within the slack; not once scrolled further up', () => {
    expect(footInView({ scrollHeight: 1000, scrollTop: 700, clientHeight: 300 })).toBe(true);
    expect(footInView({ scrollHeight: 1000, scrollTop: 680, clientHeight: 300 })).toBe(true);
    expect(footInView({ scrollHeight: 1000, scrollTop: 600, clientHeight: 300 })).toBe(false);
  });
  it('a log shorter than its frame: the foot is always in view', () => {
    expect(footInView({ scrollHeight: 200, scrollTop: 0, clientHeight: 300 })).toBe(true);
  });
});

describe('"New reply" only for a reply below the view', () => {
  it('no reply streaming: never', () => {
    expect(replyBelow(log(null))).toBe(false);
  });
  it('the reply’s words all in view (its foot above the log’s bottom edge, at 400): no', () => {
    expect(replyBelow(log({ bottom: 384 }))).toBe(false);
    expect(replyBelow(log({ bottom: 401 }))).toBe(false);
  });
  it('some of its words below the view: yes', () => {
    expect(replyBelow(log({ bottom: 460 }))).toBe(true);
  });
});
