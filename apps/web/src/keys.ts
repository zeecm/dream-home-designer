/**
 * The keys this browser holds for projects: the owner key (from creating or claiming a
 * project) and an edit key (from an edit link). Kept per project in localStorage; they
 * are what lets this browser change a plan that others can only view.
 */
export interface Keys {
  owner?: string;
  edit?: string;
}

const PREFIX = 'dhd:keys:';

export function keysFor(id: string): Keys {
  try {
    const raw = window.localStorage.getItem(PREFIX + id);
    return raw ? (JSON.parse(raw) as Keys) : {};
  } catch {
    return {};
  }
}

export function saveKeys(id: string, keys: Keys) {
  try {
    window.localStorage.setItem(PREFIX + id, JSON.stringify({ ...keysFor(id), ...keys }));
  } catch {
    // storage disabled: the key works for this visit only
    memory.set(id, { ...memory.get(id), ...keys });
  }
}

const memory = new Map<string, Keys>();

/** The Authorization header for a project: the owner key if held, else an edit key. */
export function authHeaders(id: string): Record<string, string> {
  const k = { ...memory.get(id), ...keysFor(id) };
  const token = k.owner ?? k.edit;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Takes an edit key from the address (?p=id&k=key), keeps it for the project, and removes
 * it from the address bar so a copied address shares view-only. Returns the project id.
 */
export function absorbLinkKey(): void {
  const url = new URL(window.location.href);
  const id = url.searchParams.get('p');
  const k = url.searchParams.get('k');
  if (!id || !k) return;
  saveKeys(id, { edit: k });
  url.searchParams.delete('k');
  window.history.replaceState(null, '', url);
}

/** Links to share a project: view-only, and with an edit key. */
export function shareLink(id: string, editKey?: string | null): string {
  const url = new URL(window.location.origin + window.location.pathname);
  url.searchParams.set('p', id);
  if (editKey) url.searchParams.set('k', editKey);
  return url.toString();
}
