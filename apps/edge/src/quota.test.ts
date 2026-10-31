import { describe, expect, it } from 'vitest';
import { DAILY_CREATES, allowCreate, memoryQuota } from './quota';

describe('the daily cap on new plans', () => {
  it('lets a visitor start DAILY_CREATES plans a day, then says no until the next day', async () => {
    const store = memoryQuota();
    const day = Date.UTC(2026, 9, 31, 12);
    for (let i = 0; i < DAILY_CREATES; i++) {
      expect(await allowCreate(store, '203.0.113.7', day, () => 1)).toBe(true);
    }
    expect(await allowCreate(store, '203.0.113.7', day, () => 1)).toBe(false);
    // Someone else is unaffected, and the next day starts afresh.
    expect(await allowCreate(store, '198.51.100.2', day, () => 1)).toBe(true);
    expect(await allowCreate(store, '203.0.113.7', day + 86_400_000, () => 1)).toBe(true);
  });

  it('keeps no address, and forgets days gone by', async () => {
    const store = memoryQuota();
    const day = Date.UTC(2026, 9, 31, 12);
    await allowCreate(store, '203.0.113.7', day - 3 * 86_400_000, () => 1);
    expect([...store.rows.keys()].join()).not.toContain('203.0.113.7');
    await allowCreate(store, '203.0.113.7', day, () => 0);
    expect(store.rows.size).toBe(1);
  });

  it('lets plans through when the count cannot be kept (no table yet, D1 down)', async () => {
    const broken = {
      bump: async () => {
        throw new Error('no such table: create_quota');
      },
      prune: async () => {},
    };
    expect(await allowCreate(broken, '203.0.113.7')).toBe(true);
  });
});
