import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authorKey, commentName, setCommentName } from './author';
import { POLL_ACTIVE_MS, POLL_ERROR_MS, POLL_IDLE_MS, createPoller } from './poll';
import { relativeTime } from './time';

describe('polling for comments', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(opts: { active?: boolean; ok?: boolean } = {}) {
    const state = { active: opts.active ?? false, visible: true, ok: opts.ok ?? true, calls: 0 };
    const poller = createPoller({
      fetch: async () => {
        state.calls++;
        return state.ok;
      },
      active: () => state.active,
      visible: () => state.visible,
      random: () => 0.5, // no jitter
    });
    return { state, poller };
  }
  const flush = () => vi.advanceTimersByTimeAsync(0);

  it('polls every 30 s with the panel open and every 2 min with it closed', async () => {
    const { state, poller } = setup({ active: true });
    poller.poke();
    await flush();
    expect(state.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(POLL_ACTIVE_MS);
    expect(state.calls).toBe(2);
    state.active = false;
    poller.reschedule();
    await vi.advanceTimersByTimeAsync(POLL_ACTIVE_MS);
    expect(state.calls).toBe(2);
    await vi.advanceTimersByTimeAsync(POLL_IDLE_MS - POLL_ACTIVE_MS);
    expect(state.calls).toBe(3);
    poller.stop();
  });

  it('stops while the tab is hidden and looks at once when it comes back', async () => {
    const { state, poller } = setup();
    poller.poke();
    await flush();
    state.visible = false;
    poller.visibility();
    await vi.advanceTimersByTimeAsync(POLL_IDLE_MS * 3);
    expect(state.calls).toBe(1);
    state.visible = true;
    poller.visibility();
    await flush();
    expect(state.calls).toBe(2);
    poller.stop();
  });

  it('looks at once on focus', async () => {
    const { state, poller } = setup();
    poller.poke();
    await flush();
    poller.poke(); // focus
    await flush();
    expect(state.calls).toBe(2);
    poller.stop();
  });

  it('backs off to 5 min after an error, and back once it works', async () => {
    const { state, poller } = setup({ active: true, ok: false });
    poller.poke();
    await flush();
    await vi.advanceTimersByTimeAsync(POLL_ACTIVE_MS * 2);
    expect(state.calls).toBe(1);
    state.ok = true;
    await vi.advanceTimersByTimeAsync(POLL_ERROR_MS - POLL_ACTIVE_MS * 2);
    expect(state.calls).toBe(2);
    await vi.advanceTimersByTimeAsync(POLL_ACTIVE_MS);
    expect(state.calls).toBe(3);
    poller.stop();
  });
});

describe('who is commenting', () => {
  it('keeps the name it was given, trimmed, for the next comment', () => {
    expect(commentName()).toBe('');
    setCommentName('  Mum ');
    expect(commentName()).toBe('Mum');
  });

  it('makes one 32-character author key and keeps it', () => {
    const k = authorKey();
    expect(k).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(authorKey()).toBe(k);
  });
});

describe('times', () => {
  const now = new Date(2026, 10, 6, 15, 0, 0).getTime();
  const at = (ms: number) => new Date(now - ms).toISOString();
  it('says just now, minutes, hours, yesterday or the date', () => {
    expect(relativeTime(at(20_000), now)).toBe('just now');
    expect(relativeTime(at(5 * 60_000), now)).toBe('5 min ago');
    expect(relativeTime(at(2 * 3_600_000), now)).toBe('2 h ago');
    expect(relativeTime(new Date(2026, 10, 5, 20, 0).toISOString(), now)).toBe('yesterday');
    expect(relativeTime(new Date(2026, 10, 3, 9, 0).toISOString(), now)).toBe('3 Nov');
    expect(relativeTime(new Date(2025, 10, 3, 9, 0).toISOString(), now)).toBe('3 Nov 2025');
  });
});
