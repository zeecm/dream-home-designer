import { describe, expect, it } from 'vitest';
import {
  DAILY_COMMENTS,
  DAILY_CREATES,
  allowComment,
  allowCreate,
  allowDaily,
  memoryQuota,
} from './quota';

describe('the daily cap on comment writes', () => {
  const day = Date.UTC(2026, 10, 6, 12);
  const at = { now: day, random: () => 1 };

  it('lets a visitor make DAILY_COMMENTS writes a day, counted apart from new plans', async () => {
    const store = memoryQuota();
    for (let i = 0; i < DAILY_COMMENTS; i++) {
      expect(await allowComment(store, '203.0.113.7', at)).toBe(true);
    }
    expect(await allowComment(store, '203.0.113.7', at)).toBe(false);
    // The 101st comment doesn't use up the visitor's new plans.
    expect(await allowCreate(store, '203.0.113.7', at)).toBe(true);
    const tomorrow = { now: day + 86_400_000, random: () => 1 };
    expect(await allowComment(store, '203.0.113.7', tomorrow)).toBe(true);
  });

  it('keeps the key new plans had before, so counts already made today stand', async () => {
    const store = memoryQuota();
    await allowCreate(store, '203.0.113.7', { ...at, secret: 's' });
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode('dhd-quota:s'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const input = new TextEncoder().encode('2026-11-06|203.0.113.7');
    const mac = await crypto.subtle.sign('HMAC', key, input);
    const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
    expect([...store.rows.keys()]).toEqual([`${hex}|2026-11-06`]);
  });

  it('fails open, and says so in the logs, when there is no table', async () => {
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args[0]);
    try {
      const broken = {
        bump: async () => Promise.reject(new Error('no such table: create_quota')),
        prune: async () => {},
      };
      expect(await allowDaily(broken, 'a', { kind: 'comment', cap: 1 })).toBe(true);
    } finally {
      console.error = original;
    }
    expect(errors).toContain('quotaUnavailable');
  });
});

describe('the daily cap on new plans', () => {
  it('lets a visitor start DAILY_CREATES plans a day, then says no until the next day', async () => {
    const store = memoryQuota();
    const day = Date.UTC(2026, 9, 31, 12);
    for (let i = 0; i < DAILY_CREATES; i++) {
      expect(await allowCreate(store, '203.0.113.7', { now: day, random: () => 1 })).toBe(true);
    }
    expect(await allowCreate(store, '203.0.113.7', { now: day, random: () => 1 })).toBe(false);
    // Someone else is unaffected, and the next day starts afresh.
    expect(await allowCreate(store, '198.51.100.2', { now: day, random: () => 1 })).toBe(true);
    expect(
      await allowCreate(store, '203.0.113.7', { now: day + 86_400_000, random: () => 1 }),
    ).toBe(true);
  });

  it('keeps no address, and forgets days gone by', async () => {
    const store = memoryQuota();
    const day = Date.UTC(2026, 9, 31, 12);
    await allowCreate(store, '203.0.113.7', { now: day - 3 * 86_400_000, random: () => 1 });
    expect([...store.rows.keys()].join()).not.toContain('203.0.113.7');
    await allowCreate(store, '203.0.113.7', { now: day, random: () => 0 });
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

  it('still refuses past the cap when forgetting old days fails', async () => {
    const store = memoryQuota();
    const failing = { ...store, prune: async () => Promise.reject(new Error('timeout')) };
    const day = Date.UTC(2026, 9, 31, 12);
    for (let i = 0; i < DAILY_CREATES; i++)
      await allowCreate(failing, 'a', { now: day, random: () => 1 });
    expect(await allowCreate(failing, 'a', { now: day, random: () => 0 })).toBe(false);
  });
});
