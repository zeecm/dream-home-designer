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

/**
 * The visitor's key for the day: an HMAC of the day and their address under a server secret,
 * so the table can't be turned back into addresses (an IPv4 address alone is guessable).
 */
async function hash(secret: string, day: string, client: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`dhd-quota:${secret}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${day}|${client}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Counts a new plan for the visitor; false once they are past the day's cap. Now and then
 * it also forgets days gone by.
 */
export async function allowCreate(
  store: QuotaStore,
  client: string,
  opts: { secret?: string; now?: number; random?: () => number } = {},
): Promise<boolean> {
  const now = opts.now ?? Date.now();
  const day = dayOf(now);
  let count: number;
  try {
    count = await store.bump(await hash(opts.secret ?? '', day, client), day);
  } catch (e) {
    // No table yet (its migration not applied) or D1 down: the per-minute limit still holds.
    // Tagged, so a cap that is off for good shows up in the logs.
    console.error('quotaUnavailable', e);
    return true;
  }
  if ((opts.random ?? Math.random)() < 0.02) {
    await store.prune(dayOf(now - 2 * 86_400_000)).catch((e) => console.error('quotaPrune', e));
  }
  return count <= DAILY_CREATES;
}
