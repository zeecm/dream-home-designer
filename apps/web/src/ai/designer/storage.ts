import { Design, DesignBrief } from '@dhd/core';

/**
 * The designer's versions and briefs, kept in this browser (IndexedDB `dhd-designs`), never
 * in the project, an export, a share link or a request to our server. No keys or prices are
 * kept here. Records carry their own schema version and are checked on the way back in;
 * one that no longer parses is left out. Where IndexedDB can't be had (a private window,
 * or it takes over 2 s to open), versions are kept in memory for this tab.
 */

export const DB_NAME = 'dhd-designs';
const DB_VERSION = 1;
/** The record format: bumped (with a migration below) when Design changes. */
export const RECORD_VERSION = 1;
/** Versions kept per plan; the oldest not accepted go first. */
export const MAX_VERSIONS = 20;

type Stored = Design & { schemaVersion: number };

export interface DesignStore {
  /** True when versions last only as long as this tab. */
  memory: boolean;
  list(projectId: string): Promise<Design[]>;
  /**
   * Stores a new version, numbered one past the plan's highest (or `n`, when it is free); how
   * many old ones went.
   */
  create(d: Omit<Design, 'n'>, n?: number): Promise<{ design: Design; pruned: number }>;
  put(d: Design): Promise<void>;
  /**
   * Puts a deleted version back (Undo). It keeps its number unless another version has taken
   * it since, and then it gets the next one: numbers are never shared.
   */
  restore(d: Design): Promise<Design>;
  remove(projectId: string, id: string): Promise<void>;
  removeProject(projectId: string): Promise<void>;
  getBrief(projectId: string): Promise<DesignBrief | null>;
  putBrief(projectId: string, brief: DesignBrief): Promise<void>;
}

/** A stored record brought up to date and checked; null if it can't be used. */
export function fromRecord(raw: unknown): Design | null {
  const rec = raw as Partial<Stored> | null;
  if (!rec || typeof rec !== 'object') return null;
  // RECORD_VERSION 1 is the first: nothing to migrate yet.
  if ((rec.schemaVersion ?? 1) > RECORD_VERSION) return null;
  const { schemaVersion: _, ...rest } = rec;
  const r = Design.safeParse(rest);
  return r.success ? r.data : null;
}

const toRecord = (d: Design): Stored => ({ ...structuredClone(d), schemaVersion: RECORD_VERSION });

/** `d` with a number no other version of `mine` has. */
export function renumbered(d: Design, mine: Design[]): Design {
  if (!mine.some((x) => x.n === d.n && x.id !== d.id)) return d;
  return { ...d, n: Math.max(0, ...mine.map((x) => x.n)) + 1 };
}

/** The versions to remove so `list` keeps at most MAX_VERSIONS: oldest unaccepted first. */
export function toPrune(list: Design[]): Design[] {
  const extra = list.length - MAX_VERSIONS;
  if (extra <= 0) return [];
  const byAge = [...list].sort((a, b) => a.n - b.n);
  const order = [...byAge.filter((d) => !d.accepted), ...byAge.filter((d) => d.accepted)];
  return order.slice(0, extra);
}

const byN = (a: Design, b: Design) => a.n - b.n;

/** The number a new version takes: `want` if no version has it, else one past the highest. */
export function numberFor(mine: Design[], want?: number): number {
  if (want && want > 0 && !mine.some((x) => x.n === want)) return want;
  return Math.max(0, ...mine.map((x) => x.n)) + 1;
}

export function memoryStore(): DesignStore {
  const designs = new Map<string, Stored>();
  const briefs = new Map<string, DesignBrief>();
  const k = (p: string, id: string) => `${p}\u0000${id}`;
  const list = async (projectId: string) =>
    [...designs.values()]
      .filter((d) => d.projectId === projectId)
      .map(fromRecord)
      .filter((d): d is Design => !!d)
      .sort(byN);
  return {
    memory: true,
    list,
    async create(d, want) {
      const mine = await list(d.projectId);
      const n = numberFor(mine, want);
      const design = { ...d, n } as Design;
      designs.set(k(d.projectId, d.id), toRecord(design));
      const gone = toPrune([...mine, design]);
      for (const g of gone) designs.delete(k(g.projectId, g.id));
      return { design, pruned: gone.length };
    },
    async put(d) {
      designs.set(k(d.projectId, d.id), toRecord(d));
    },
    async restore(d) {
      const back = renumbered(d, await list(d.projectId));
      designs.set(k(d.projectId, d.id), toRecord(back));
      return back;
    },
    async remove(projectId, id) {
      designs.delete(k(projectId, id));
    },
    async removeProject(projectId) {
      for (const [key, d] of designs) if (d.projectId === projectId) designs.delete(key);
      briefs.delete(projectId);
    },
    async getBrief(projectId) {
      const b = briefs.get(projectId);
      return b ? structuredClone(b) : null;
    },
    async putBrief(projectId, brief) {
      briefs.set(projectId, structuredClone(brief));
    },
  };
}

const done = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
const finished = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('aborted'));
  });

function idbStore(db: IDBDatabase): DesignStore {
  const all = async (store: IDBObjectStore, projectId: string): Promise<Design[]> => {
    const rows = await done(store.index('projectId').getAll(projectId));
    return rows.map(fromRecord).filter((d): d is Design => !!d);
  };
  return {
    memory: false,
    async list(projectId) {
      const tx = db.transaction('designs', 'readonly');
      return (await all(tx.objectStore('designs'), projectId)).sort(byN);
    },
    async create(d, want) {
      // One transaction: two tabs can't take the same number.
      const tx = db.transaction('designs', 'readwrite');
      const store = tx.objectStore('designs');
      const ended = finished(tx);
      const mine = await all(store, d.projectId);
      const n = numberFor(mine, want);
      const design = { ...d, n } as Design;
      store.put(toRecord(design));
      const gone = toPrune([...mine, design]);
      for (const g of gone) store.delete([g.projectId, g.id]);
      await ended;
      return { design, pruned: gone.length };
    },
    async put(d) {
      const tx = db.transaction('designs', 'readwrite');
      tx.objectStore('designs').put(toRecord(d));
      await finished(tx);
    },
    async restore(d) {
      const tx = db.transaction('designs', 'readwrite');
      const store = tx.objectStore('designs');
      const ended = finished(tx);
      const back = renumbered(d, await all(store, d.projectId));
      store.put(toRecord(back));
      await ended;
      return back;
    },
    async remove(projectId, id) {
      const tx = db.transaction('designs', 'readwrite');
      tx.objectStore('designs').delete([projectId, id]);
      await finished(tx);
    },
    async removeProject(projectId) {
      const tx = db.transaction(['designs', 'briefs'], 'readwrite');
      const store = tx.objectStore('designs');
      const keys = await done(store.index('projectId').getAllKeys(projectId));
      for (const key of keys) store.delete(key);
      tx.objectStore('briefs').delete(projectId);
      await finished(tx);
    },
    async getBrief(projectId) {
      const tx = db.transaction('briefs', 'readonly');
      const row = (await done(tx.objectStore('briefs').get(projectId))) as
        | { projectId: string; brief: unknown }
        | undefined;
      const r = DesignBrief.safeParse(row?.brief);
      return r.success ? r.data : null;
    },
    async putBrief(projectId, brief) {
      const tx = db.transaction('briefs', 'readwrite');
      tx.objectStore('briefs').put({ projectId, brief: structuredClone(brief) });
      await finished(tx);
    },
  };
}

/** Opens the store: IndexedDB, or memory if it can't be opened within `timeoutMs`. */
export function openDesigns(
  idb: IDBFactory | undefined = globalThis.indexedDB,
  timeoutMs = 2000,
): Promise<DesignStore> {
  if (!idb) return Promise.resolve(memoryStore());
  return new Promise((resolve) => {
    let settled = false;
    const give = (s: DesignStore) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(s);
    };
    const timer = setTimeout(() => give(memoryStore()), timeoutMs);
    let req: IDBOpenDBRequest;
    try {
      req = idb.open(DB_NAME, DB_VERSION);
    } catch {
      give(memoryStore());
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('designs')) {
        const s = db.createObjectStore('designs', { keyPath: ['projectId', 'id'] });
        s.createIndex('projectId', 'projectId');
      }
      if (!db.objectStoreNames.contains('briefs')) {
        db.createObjectStore('briefs', { keyPath: 'projectId' });
      }
    };
    req.onsuccess = () => {
      if (settled) req.result.close();
      else {
        // A newer build upgrading the database: let it.
        req.result.onversionchange = () => req.result.close();
        give(idbStore(req.result));
      }
    };
    req.onerror = () => give(memoryStore());
    req.onblocked = () => give(memoryStore());
  });
}

let opened: Promise<DesignStore> | null = null;
/** The store for this tab (opened once). */
export const designStore = (): Promise<DesignStore> => {
  opened ??= openDesigns();
  return opened;
};
