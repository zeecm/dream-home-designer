/**
 * Daily caps on what one visitor can do, on top of the per-minute rate limits: the store is
 * free to use, so nothing else stops a script from filling it. Counted per day (UTC) in D1,
 * keyed by a hash of the kind, the day and the visitor's address (or IPv6 /64), all in the
 * one create_quota table.
 */

/** Plans one visitor may start in a day: far more than a person trying ideas needs. */
export const DAILY_CREATES = 40;

/** Comments and replies one visitor (one address, maybe a whole household) may post a day. */
export const DAILY_COMMENTS = 300;

/** What a daily cap counts. */
export type DailyKind = 'create' | 'comment';

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
async function hash(secret: string, kind: DailyKind, day: string, client: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`dhd-quota:${secret}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  // New plans keep the key they had before there were other kinds, so today's counts stand.
  const input = kind === 'create' ? `${day}|${client}` : `${kind}|${day}|${client}`;
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface DailyOptions {
  secret?: string | undefined;
  now?: number;
  random?: () => number;
}

/**
 * Counts one `kind` for the visitor; false once they are past the day's `cap`. Now and then
 * it also forgets days gone by.
 */
export async function allowDaily(
  store: QuotaStore,
  client: string,
  opts: DailyOptions & { kind: DailyKind; cap: number },
): Promise<boolean> {
  const now = opts.now ?? Date.now();
  const day = dayOf(now);
  let count: number;
  try {
    count = await store.bump(await hash(opts.secret ?? '', opts.kind, day, client), day);
  } catch (e) {
    // No table yet (its migration not applied) or D1 down: the per-minute limit still holds.
    // Tagged, so a cap that is off for good shows up in the logs.
    console.error('quotaUnavailable', e);
    return true;
  }
  if ((opts.random ?? Math.random)() < 0.02) {
    await store.prune(dayOf(now - 2 * 86_400_000)).catch((e) => console.error('quotaPrune', e));
  }
  return count <= opts.cap;
}

/** Counts a new plan for the visitor; false once they are past DAILY_CREATES today. */
export function allowCreate(
  store: QuotaStore,
  client: string,
  opts: DailyOptions = {},
): Promise<boolean> {
  return allowDaily(store, client, { ...opts, kind: 'create', cap: DAILY_CREATES });
}

/** Counts a comment write for the visitor; false once they are past DAILY_COMMENTS today. */
export function allowComment(
  store: QuotaStore,
  client: string,
  opts: DailyOptions = {},
): Promise<boolean> {
  return allowDaily(store, client, { ...opts, kind: 'comment', cap: DAILY_COMMENTS });
}
