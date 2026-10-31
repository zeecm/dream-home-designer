/**
 * A cap on how many plans one visitor can start in a day, on top of the per-minute rate
 * limit: the store is free to use, so nothing else stops a script from filling it. Counted
 * per day (UTC) in D1, keyed by a hash of the visitor's address (or IPv6 /64).
 */

/** Plans one visitor may start in a day: far more than a person trying ideas needs. */
export const DAILY_CREATES = 40;

export interface QuotaStore {
  /** Adds one to the visitor's count for the day and returns the new count. */
  bump(client: string, day: string): Promise<number>;
  /** Forgets the days before `day`. */
  prune(day: string): Promise<void>;
}

export function d1Quota(db: D1Database): QuotaStore {
  return {
    async bump(client, day) {
      const row = await db
        .prepare(
          `INSERT INTO create_quota (client, day, count) VALUES (?, ?, 1)
           ON CONFLICT (client, day) DO UPDATE SET count = count + 1
           RETURNING count`,
        )
        .bind(client, day)
        .first<{ count: number }>();
      return row?.count ?? 1;
    },
    async prune(day) {
      await db.prepare('DELETE FROM create_quota WHERE day < ?').bind(day).run();
    },
  };
}

export function memoryQuota(): QuotaStore & { rows: Map<string, number> } {
  const rows = new Map<string, number>();
  return {
    rows,
    async bump(client, day) {
      const k = `${client}|${day}`;
      const n = (rows.get(k) ?? 0) + 1;
      rows.set(k, n);
      return n;
    },
    async prune(day) {
      for (const k of rows.keys()) if ((k.split('|')[1] ?? '') < day) rows.delete(k);
    },
  };
}

const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);

async function hash(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`dhd-quota:${s}`));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Counts a new plan for the visitor; false once they are past the day's cap. Now and then
 * it also forgets days gone by.
 */
export async function allowCreate(
  store: QuotaStore,
  client: string,
  now = Date.now(),
  random = Math.random,
): Promise<boolean> {
  const day = dayOf(now);
  try {
    const count = await store.bump(await hash(client), day);
    if (random() < 0.02) await store.prune(dayOf(now - 2 * 86_400_000));
    return count <= DAILY_CREATES;
  } catch (e) {
    // No table yet (its migration not applied) or D1 down: the per-minute limit still holds.
    console.warn('create quota unavailable', e);
    return true;
  }
}
