import { type Project, parseProject } from '@dhd/core';

const BASE = '/api';

export class ConflictError extends Error {
  constructor(readonly serverVersion: number) {
    super(`project changed on the server (now v${serverVersion})`);
  }
}

export class NotFoundError extends Error {}

async function check(res: Response): Promise<Response> {
  if (res.ok) return res;
  if (res.status === 404) throw new NotFoundError('not found');
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as { version?: number };
    throw new ConflictError(body.version ?? -1);
  }
  throw new Error(`${res.status} ${await res.text()}`);
}

export async function getProject(id: string): Promise<Project> {
  const res = await check(await fetch(`${BASE}/projects/${encodeURIComponent(id)}`));
  return parseProject(await res.json());
}

export async function createProject(doc: Project): Promise<Project> {
  const res = await check(
    await fetch(`${BASE}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(doc),
    }),
  );
  return parseProject(await res.json());
}

/** Optimistic save: the server rejects with 409 if `doc.version` is stale. */
export async function saveProject(doc: Project): Promise<number> {
  const res = await check(
    await fetch(`${BASE}/projects/${encodeURIComponent(doc.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': `"${doc.version}"` },
      body: JSON.stringify(doc),
    }),
  );
  const body = (await res.json()) as { version: number };
  return body.version;
}
