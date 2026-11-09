import { describe, expect, it } from 'vitest';
import { type StepLike, msLeft, stepTimes, timeLeft, timeLeftMark } from './timeLeft';

const step = (kind: StepLike['kind'], status: string, problems = 0): StepLike => ({
  kind,
  status,
  fixing: problems ? { round: 1, problems } : null,
});
/** A whole flat: the layout and `rooms` rooms, the first `done` steps finished. */
const run = (rooms: number, done: number, running = 0): StepLike[] =>
  [step('layout', 'waiting'), ...Array.from({ length: rooms }, () => step('room', 'waiting'))].map(
    (s, i) =>
      i < done ? { ...s, status: 'done' } : i < done + running ? { ...s, status: 'running' } : s,
  );

describe('the time left on a running card (criterion 10)', () => {
  it('uses the defaults until a step of its kind has finished, rooms two at a time', () => {
    // Layout 45 s, then five rooms two at a time: three rounds of 30 s.
    expect(msLeft(run(5, 0, 1), [])).toBe(45_000 + 3 * 30_000);
    expect(timeLeft(run(5, 0, 1), [], null).text).toBe('about 2 min left');
  });

  it('times what is left by this run’s own finished steps (their median)', () => {
    const times = [
      { kind: 'room' as const, ms: 50_000 },
      { kind: 'room' as const, ms: 70_000 },
      { kind: 'room' as const, ms: 200_000 },
    ];
    expect(stepTimes(times).room).toBe(70_000);
    // Layout and two rooms done, three left: two rounds of 70 s.
    expect(msLeft(run(5, 3, 2), times)).toBe(2 * 70_000);
    expect(timeLeft(run(5, 3, 2), times, null).text).toBe('about 2 min left');
  });

  it('rounds to "less than a minute" and says "almost done" on the last step', () => {
    expect(timeLeft(run(3, 2, 2), [{ kind: 'room', ms: 20_000 }], null).text).toBe(
      'less than a minute left',
    );
    expect(timeLeft(run(3, 3, 1), [], null).text).toBe('almost done');
  });

  it('is worked out again only when a step ends or a fix starts', () => {
    const a = run(5, 1, 2);
    const b = a.map((s) => ({ ...s }));
    // A step's thinking line changing, or a wait, is no reason to work it out again.
    expect(timeLeftMark(b)).toBe(timeLeftMark(a));
    const ended = a.map((s, i) => (i === 1 ? { ...s, status: 'done' } : s));
    expect(timeLeftMark(ended)).not.toBe(timeLeftMark(a));
    const fixing = a.map((s, i) => (i === 1 ? { ...s, fixing: { round: 1, problems: 2 } } : s));
    expect(timeLeftMark(fixing)).not.toBe(timeLeftMark(a));
  });

  it('never goes up by more than a minute between updates, unless a fix round starts', () => {
    const first = timeLeft(run(5, 3, 2), [], null);
    // A slow room makes the median jump: held to a minute more than said before.
    const slow = [{ kind: 'room' as const, ms: 400_000 }];
    const next = timeLeft(run(5, 4, 1), slow, first);
    expect(next.ms).toBe(first.ms + 60_000);
    // A fix round starting may say more (the fix round, and the last room's 30 s).
    const fixing = run(5, 4, 1).map((s, i) =>
      i === 4 ? { ...s, fixing: { round: 1, problems: 1 } } : s,
    );
    expect(timeLeft(fixing, [{ kind: 'fix', ms: 400_000 }], first).ms).toBe(400_000 + 30_000);
  });
});
