import { describe, expect, it } from 'vitest';
import { historyPoints } from './history';

const at = (min: number) => new Date(Date.UTC(2026, 9, 30, 9, 0) + min * 60_000).toISOString();

describe('historyPoints', () => {
  it('offers the end of each editing session, newest first, and the latest', () => {
    // Session one: saves at 0–3 min; a pause; session two at 60–62 min.
    const vs = [0, 1, 2, 3, 60, 61, 62].map((m, i) => ({ version: i + 1, replacedAt: at(m) }));
    expect(historyPoints(vs).map((v) => v.version)).toEqual([7, 5, 1]);
  });

  it('keeps at most 20, and copes with gaps in the numbering (expired copies)', () => {
    const vs = Array.from({ length: 40 }, (_, i) => ({ version: i * 2 + 1, replacedAt: at(i) }));
    const pts = historyPoints(vs);
    expect(pts).toHaveLength(20);
    expect(pts[0]?.version).toBe(79);
    expect(historyPoints([])).toEqual([]);
  });
});
