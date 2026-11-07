import {
  Conversation,
  Level,
  Proposal,
  conversationFromRecord,
  levelFingerprint,
  proposalFromRecord,
} from '@dhd/core';

/**
 * The conversation with the designer, kept in this browser (IndexedDB `dhd-talk`, a database
 * of its own so an old tab holding `dhd-designs` open can't block it): one conversation per
 * plan, its proposals, and the levels they were made on (by fingerprint, so ten proposals on
 * one plan share one copy). Never in the project, an export, a share link or a request to our
 * server, and never a key. Every write reads the record afresh in one transaction and applies
 * the change to it, so two tabs never clobber each other; other tabs hear of it on a
 * BroadcastChannel. Without IndexedDB (a private window, or it takes over 2 s to open) it
 * lives in memory for this tab.
 */

export const TALK_DB = 'dhd-talk';
const DB_VERSION = 1;

export interface TalkStore {
  memory: boolean;
  get(projectId: string): Promise<Conversation | null>;
  /**
   * Reads the conversation, applies `fn` and writes what it returns (with `rev` bumped) in
   * one transaction; null from `fn` writes nothing.
   */
  apply(
    projectId: string,
    fn: (c: Conversation | null) => Conversation | null,
  ): Promise<Conversation | null>;
  proposals(projectId: string): Promise<Proposal[]>;
  /** As `apply`, for one proposal (null creates it when `fn` returns one). */
  applyProposal(
    projectId: string,
    id: string,
    fn: (p: Proposal | null) => Proposal | null,
  ): Promise<Proposal | null>;
  /** Keeps a level once, by its fingerprint; returns the fingerprint. */
  putLevel(projectId: string, level: Level): Promise<string>;
  getLevel(projectId: string, fp: string): Promise<Level | null>;
  removeProject(projectId: string): Promise<void>;
  /**
   * A conversation this build can't read is moved aside (kept in `bad`, never overwritten);
   * true when there was one.
   */
  setAside(projectId: string): Promise<boolean>;
}

/** A write the records' own schema refuses: nothing is written. */
export class Unsaved extends Error {}
/** The stored conversation can't be read: set it aside before starting another. */
export class Unreadable extends Error {}

/** Checked against the schema before it is written: a record that wouldn't read back never is. */
function checked<T>(schema: { safeParse: (v: unknown) => { success: boolean } }, v: T): T {
  if (!schema.safeParse(v).success) throw new Unsaved('the record doesn’t fit its schema');
  return v;
}

const bump = (c: Conversation, was: Conversation | null): Conversation => ({
  ...c,
  rev: (was?.rev ?? c.rev ?? 0) + 1,
});

const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('dhd-talk') : null;
/** Tells other tabs a plan's conversation changed. */
const ping = (projectId: string, rev: number) => {
  try {
    channel?.postMessage({ projectId, rev });
  } catch {
    // a closed channel: nothing to tell
  }
};
/** Calls `fn` when another tab changed a plan's conversation. */
export function onOtherTab(fn: (projectId: string) => void): () => void {
  if (!channel) return () => {};
  const on = (e: MessageEvent) => {
    const id = (e.data as { projectId?: unknown } | null)?.projectId;
    if (typeof id === 'string') fn(id);
  };
  channel.addEventListener('message', on);
  return () => channel.removeEventListener('message', on);
}

export function memoryTalkStore(): TalkStore {
  const convs = new Map<string, Conversation>();
  const props = new Map<string, Proposal>();
  const levels = new Map<string, Level>();
  const k = (p: string, id: string) => `${p}\u0000${id}`;
  return {
    memory: true,
    async get(projectId) {
      const c = convs.get(projectId);
      return c ? structuredClone(c) : null;
    },
    async apply(projectId, fn) {
      const was = convs.get(projectId) ?? null;
      const next = fn(was ? structuredClone(was) : null);
      if (!next) return was;
      const out = checked(Conversation, bump(next, was));
      convs.set(projectId, structuredClone(out));
      return out;
    },
    async proposals(projectId) {
      return [...props.values()]
        .filter((p) => p.projectId === projectId)
        .map((p) => structuredClone(p))
        .sort((a, b) => a.n - b.n);
    },
    async applyProposal(projectId, id, fn) {
      const was = props.get(k(projectId, id)) ?? null;
      const next = fn(was ? structuredClone(was) : null);
      if (!next) return was;
      props.set(k(projectId, id), structuredClone(checked(Proposal, next)));
      return next;
    },
    async putLevel(projectId, level) {
      const fp = levelFingerprint(level);
      levels.set(k(projectId, fp), structuredClone(level));
      return fp;
    },
    async getLevel(projectId, fp) {
      const l = levels.get(k(projectId, fp));
      return l ? structuredClone(l) : null;
    },
    async removeProject(projectId) {
      convs.delete(projectId);
      for (const [key, p] of props) if (p.projectId === projectId) props.delete(key);
      for (const key of levels.keys()) if (key.startsWith(`${projectId}\u0000`)) levels.delete(key);
    },
    async setAside() {
      return false;
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

function idbTalkStore(db: IDBDatabase): TalkStore {
  return {
    memory: false,
    async get(projectId) {
      const tx = db.transaction('conversations', 'readonly');
      return conversationFromRecord(await done(tx.objectStore('conversations').get(projectId)));
    },
    async apply(projectId, fn) {
      const tx = db.transaction('conversations', 'readwrite');
      const store = tx.objectStore('conversations');
      const ended = finished(tx);
      const raw = await done(store.get(projectId));
      const was = conversationFromRecord(raw);
      let next: Conversation | null = null;
      let failed: unknown = null;
      try {
        // A record this build can't read is never overwritten: it is set aside first.
        if (raw && !was) throw new Unreadable('the conversation can’t be read');
        const made = fn(was);
        if (made) {
          next = checked(Conversation, bump(made, was));
          store.put(structuredClone(next));
        }
      } catch (e) {
        failed = e;
      }
      await ended;
      if (failed) throw failed;
      if (next) ping(projectId, next.rev);
      return next ?? was;
    },
    async proposals(projectId) {
      const tx = db.transaction('proposals', 'readonly');
      const rows = await done(tx.objectStore('proposals').index('projectId').getAll(projectId));
      return rows
        .map(proposalFromRecord)
        .filter((p): p is Proposal => !!p)
        .sort((a, b) => a.n - b.n);
    },
    async applyProposal(projectId, id, fn) {
      const tx = db.transaction('proposals', 'readwrite');
      const store = tx.objectStore('proposals');
      const ended = finished(tx);
      const was = proposalFromRecord(await done(store.get([projectId, id])));
      let next: Proposal | null = null;
      let failed: unknown = null;
      try {
        next = fn(was);
        if (next) store.put(structuredClone(checked(Proposal, next)));
      } catch (e) {
        failed = e;
      }
      await ended;
      if (failed) throw failed;
      if (next) ping(projectId, -1);
      return next ?? was;
    },
    async putLevel(projectId, level) {
      const fp = levelFingerprint(level);
      const tx = db.transaction('levels', 'readwrite');
      tx.objectStore('levels').put({ projectId, fp, level: structuredClone(level) });
      await finished(tx);
      return fp;
    },
    async getLevel(projectId, fp) {
      const tx = db.transaction('levels', 'readonly');
      const row = (await done(tx.objectStore('levels').get([projectId, fp]))) as
        | { level: unknown }
        | undefined;
      const r = Level.safeParse(row?.level);
      return r.success ? r.data : null;
    },
    async removeProject(projectId) {
      const tx = db.transaction(['conversations', 'proposals', 'levels', 'bad'], 'readwrite');
      tx.objectStore('conversations').delete(projectId);
      tx.objectStore('bad').delete(projectId);
      const props = tx.objectStore('proposals');
      for (const key of await done(props.index('projectId').getAllKeys(projectId))) {
        props.delete(key);
      }
      const levels = tx.objectStore('levels');
      for (const key of await done(levels.index('projectId').getAllKeys(projectId))) {
        levels.delete(key);
      }
      await finished(tx);
    },
    async setAside(projectId) {
      const tx = db.transaction(['conversations', 'bad'], 'readwrite');
      const ended = finished(tx);
      const raw = await done(tx.objectStore('conversations').get(projectId));
      const bad = !!raw && !conversationFromRecord(raw);
      if (bad) {
        tx.objectStore('bad').put({ projectId, raw, at: new Date().toISOString() });
        tx.objectStore('conversations').delete(projectId);
      }
      await ended;
      return bad;
    },
  };
}

/** Opens the store: IndexedDB, or memory if it can't be opened within `timeoutMs`. */
export function openTalk(
  idb: IDBFactory | undefined = globalThis.indexedDB,
  timeoutMs = 2000,
): Promise<TalkStore> {
  if (!idb) return Promise.resolve(memoryTalkStore());
  return new Promise((resolve) => {
    let settled = false;
    const give = (s: TalkStore) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(s);
    };
    const timer = setTimeout(() => give(memoryTalkStore()), timeoutMs);
    let req: IDBOpenDBRequest;
    try {
      req = idb.open(TALK_DB, DB_VERSION);
    } catch {
      give(memoryTalkStore());
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('conversations')) {
        db.createObjectStore('conversations', { keyPath: 'projectId' });
      }
      if (!db.objectStoreNames.contains('proposals')) {
        const s = db.createObjectStore('proposals', { keyPath: ['projectId', 'id'] });
        s.createIndex('projectId', 'projectId');
      }
      if (!db.objectStoreNames.contains('levels')) {
        const s = db.createObjectStore('levels', { keyPath: ['projectId', 'fp'] });
        s.createIndex('projectId', 'projectId');
      }
      if (!db.objectStoreNames.contains('bad')) {
        db.createObjectStore('bad', { keyPath: 'projectId' });
      }
    };
    req.onsuccess = () => {
      if (settled) req.result.close();
      else {
        req.result.onversionchange = () => req.result.close();
        give(idbTalkStore(req.result));
      }
    };
    req.onerror = () => give(memoryTalkStore());
    req.onblocked = () => give(memoryTalkStore());
  });
}

let opened: Promise<TalkStore> | null = null;
/** The store for this tab (opened once). */
export const talkStore = (): Promise<TalkStore> => {
  opened ??= openTalk();
  return opened;
};
