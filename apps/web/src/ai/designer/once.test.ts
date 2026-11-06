import { describe, expect, it } from 'vitest';
import { sharedQuestion } from './once';

describe('a question asked once at a time', () => {
  it('a second asker while it is open gets the same answer; none is left waiting', async () => {
    let asked = 0;
    let answer: (v: boolean) => void = () => {};
    const ask = sharedQuestion(
      () =>
        new Promise<boolean>((resolve) => {
          asked++;
          answer = resolve;
        }),
    );
    const first = ask();
    const second = ask();
    expect(second).toBe(first);
    expect(asked).toBe(1);
    answer(true);
    expect(await Promise.all([first, second])).toEqual([true, true]);
    // Answered: the next one asks afresh.
    const third = ask();
    expect(asked).toBe(2);
    answer(false);
    expect(await third).toBe(false);
  });
});
