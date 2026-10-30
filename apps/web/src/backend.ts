import { type Project, loadProject } from '@dhd/core';
import { authHeaders, saveKeys } from './keys';

/**
 * What this browser may do with a project: owner (edit, share, delete), editor (edit,
 * through an edit link), viewer (look only), or open (a project from before sharing, which
 * anyone with its link may edit until it is claimed).
 */
export type Role = 'owner' | 'editor' | 'viewer' | 'open';

/** Migrates, validates and repairs a document read from storage. */
const parseProject = (input: unknown): Project => loadProject(input).project;

/** Where projects live: the Go API, or this browser's localStorage when no API answers. */
export interface Backend {
  readonly kind: 'remote' | 'local';
  list(): Promise<ProjectSummary[]>;
  get(id: string): Promise<Project>;
  /** Stores a new project as version 1 and returns it. */
  create(doc: Project): Promise<Project>;
  /** Optimistic save: rejects with ConflictError if `doc.version` is stale. Returns the new version. */
  save(doc: Project): Promise<number>;
  remove(id: string): Promise<void>;
  /** The server's copy of a project's plan image (remote only); returns its SHA-256. */
  putImage?(id: string, blob: Blob): Promise<string>;
  /** Rejects with NotFoundError unless the project's image has this hash. */
  getImage?(id: string, hash: string): Promise<Blob>;
  hasImage?(id: string, hash: string): Promise<boolean>;
  deleteImage?(id: string): Promise<void>;
  /** What this browser may do with the project, as the server last said. */
  role?(id: string): Role;
  /** The edit-link key, or null while the plan's links are view-only (owner only). */
  getShare?(id: string): Promise<string | null>;
  setShare?(id: string, edit: boolean, reset?: boolean): Promise<string | null>;
  /** Becomes the owner of a project from before sharing; false if it has one. */
  claim?(id: string): Promise<boolean>;
}

/** Roles the server reported, by project id. */
const roles = new Map<string, Role>();
const readRole = (id: string, res: Response) => {
  const r = res.headers.get('X-Role');
  if (r === 'owner' || r === 'editor' || r === 'viewer' || r === 'open') roles.set(id, r);
};
const url = (id: string, rest = '') => `${BASE}/projects/${encodeURIComponent(id)}${rest}`;

export interface ProjectSummary {
  id: string;
  name: string;
  version: number;
  updatedAt: string;
}

export class ConflictError extends Error {
  constructor(readonly serverVersion: number) {
    super(`project changed elsewhere (now v${serverVersion})`);
  }
}

export class NotFoundError extends Error {}
/** The server refused a change: this browser only has view access. */
export class ForbiddenError extends Error {}

// ---------------------------------------------------------------------------- remote

const BASE = '/api';

async function check(res: Response): Promise<Response> {
  if (res.status === 404) throw new NotFoundError('not found');
  if (res.status === 403) throw new ForbiddenError('view only');
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as { version?: number };
    throw new ConflictError(body.version ?? -1);
  }
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  // A static host answers unknown paths with index.html; treat that as "no API".
  if (res.status !== 204 && !res.headers.get('content-type')?.includes('application/json')) {
    throw new Error('the API did not answer with JSON');
  }
  return res;
}

const json = (body: unknown): RequestInit => ({
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const remoteBackend: Backend = {
  kind: 'remote',
  async list() {
    return (await (await check(await fetch(`${BASE}/projects`))).json()) as ProjectSummary[];
  },
  async get(id) {
    const res = await check(await fetch(url(id), { headers: authHeaders(id) }));
    readRole(id, res);
    return parseProject(await res.json());
  },
  async create(doc) {
    const res = await check(await fetch(`${BASE}/projects`, { method: 'POST', ...json(doc) }));
    const owner = res.headers.get('X-Owner-Token');
    if (owner) saveKeys(doc.id, { owner });
    readRole(doc.id, res);
    return parseProject(await res.json());
  },
  async save(doc) {
    const init = json(doc);
    const res = await check(
      await fetch(url(doc.id), {
        ...init,
        method: 'PUT',
        headers: { ...init.headers, ...authHeaders(doc.id), 'If-Match': `"${doc.version}"` },
      }),
    );
    return ((await res.json()) as { version: number }).version;
  },
  async remove(id) {
    await check(await fetch(url(id), { method: 'DELETE', headers: authHeaders(id) }));
  },
  async putImage(id, blob) {
    const res = await check(
      await fetch(url(id, '/image'), {
        method: 'PUT',
        headers: { 'Content-Type': blob.type || 'application/octet-stream', ...authHeaders(id) },
        body: blob,
      }),
    );
    return ((await res.json()) as { hash: string }).hash;
  },
  async getImage(id, hash) {
    const res = await fetch(imageUrl(id, hash));
    if (res.status === 404) throw new NotFoundError('image not found');
    if (!res.ok || !res.headers.get('content-type')?.startsWith('image/')) {
      throw new Error(`the plan image could not be fetched (${res.status})`);
    }
    return res.blob();
  },
  async deleteImage(id) {
    await check(await fetch(url(id, '/image'), { method: 'DELETE', headers: authHeaders(id) }));
  },
  role: (id) => roles.get(id) ?? 'viewer',
  async getShare(id) {
    const res = await check(await fetch(url(id, '/share'), { headers: authHeaders(id) }));
    return ((await res.json()) as { edit: string | null }).edit;
  },
  async setShare(id, edit, reset = false) {
    const res = await check(
      await fetch(url(id, '/share'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders(id) },
        body: JSON.stringify({ edit, reset }),
      }),
    );
    return ((await res.json()) as { edit: string | null }).edit;
  },
  async claim(id) {
    const res = await fetch(url(id, '/claim'), { method: 'POST' });
    if (res.status === 409) return false;
    const owner = ((await (await check(res)).json()) as { owner: string }).owner;
    saveKeys(id, { owner });
    roles.set(id, 'owner');
    return true;
  },
  async hasImage(id, hash) {
    const res = await check(await fetch(`${BASE}/projects/${encodeURIComponent(id)}/image`));
    return ((await res.json()) as { hash: string | null }).hash === hash;
  },
};

const imageUrl = (id: string, hash: string) =>
  `${BASE}/projects/${encodeURIComponent(id)}/image/${hash}`;

/** True if the Go API answers its health check within `timeoutMs`. */
export async function apiAvailable(timeoutMs = 2500): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
    await check(res);
    return ((await res.json()) as { status?: string }).status === 'ok';
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------------------- local

const KEY = 'dhd:project:';

interface LocalRecord {
  doc: Project;
  updatedAt: string;
}

/**
 * Mirrors the API's semantics (versions, 409 on a stale save) so the store treats both
 * backends the same, including two tabs editing the same project.
 */
export function localBackend(storage: Storage = window.localStorage): Backend {
  const read = (id: string): LocalRecord | null => {
    const raw = storage.getItem(KEY + id);
    if (!raw) return null;
    const rec = JSON.parse(raw) as LocalRecord;
    return { ...rec, doc: parseProject(rec.doc) };
  };
  const write = (doc: Project) =>
    storage.setItem(KEY + doc.id, JSON.stringify({ doc, updatedAt: new Date().toISOString() }));

  return {
    kind: 'local',
    async list() {
      const out: ProjectSummary[] = [];
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (!k?.startsWith(KEY)) continue;
        try {
          const rec = read(k.slice(KEY.length));
          if (rec) {
            const { id, name, version } = rec.doc;
            out.push({ id, name, version, updatedAt: rec.updatedAt });
          }
        } catch {
          // Skip a record that no longer parses rather than hiding every project.
        }
      }
      return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async get(id) {
      const rec = read(id);
      if (!rec) throw new NotFoundError('not found');
      return rec.doc;
    },
    async create(doc) {
      if (read(doc.id)) throw new ConflictError(read(doc.id)?.doc.version ?? -1);
      const stored = { ...doc, version: 1 };
      write(stored);
      return stored;
    },
    async save(doc) {
      const rec = read(doc.id);
      if (!rec) throw new NotFoundError('not found');
      if (rec.doc.version !== doc.version) throw new ConflictError(rec.doc.version);
      const version = doc.version + 1;
      write({ ...doc, version });
      return version;
    },
    async remove(id) {
      storage.removeItem(KEY + id);
    },
  };
}
