import { create } from 'zustand';
import { keysFor, saveKeys } from './keys';
import { type RecentProject, adoptKept, isSample } from './recent';

/**
 * Signing in with Google (through the API Worker): the person's plans, with the keys that
 * let them edit, are kept with their account, so another device that signs in gets them.
 * Without sign-in set up on the server (`enabled: false`), none of this shows.
 */
export interface AccountUser {
  email: string;
  name: string;
  picture: string;
}

interface AccountState {
  /** null until the server has answered. */
  enabled: boolean | null;
  user: AccountUser | null;
  load: () => Promise<void>;
  signOut: () => Promise<void>;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export const useAccount = create<AccountState>((set) => ({
  enabled: null,
  user: null,
  load: async () => {
    try {
      const res = await fetch('/api/auth/me');
      const body = res.ok ? ((await res.json()) as { enabled?: boolean; user?: AccountUser }) : {};
      set({ enabled: !!body.enabled, user: body.user ?? null });
    } catch {
      set({ enabled: false, user: null });
    }
  },
  signOut: async () => {
    await fetch('/api/auth/logout', { method: 'POST', headers: JSON_HEADERS }).catch(() => {});
    set({ user: null });
  },
}));

/** Where "Sign in with Google" goes: back to this page afterwards. */
export const signInUrl = () =>
  `/api/auth/google?return=${encodeURIComponent(window.location.pathname + window.location.search)}`;

const signedIn = () => !!useAccount.getState().user;

/** Keeps a plan with the account (name and whatever keys this browser holds). */
export function keepWithAccount(r: Pick<RecentProject, 'id' | 'name'> & { sample?: boolean }) {
  if (!signedIn()) return;
  const k = keysFor(r.id);
  void fetch(`/api/me/projects/${encodeURIComponent(r.id)}`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      name: r.name,
      ownerKey: k.owner ?? '',
      editKey: k.edit ?? '',
      sample: r.sample ?? isSample({ ...r, openedAt: '' }),
    }),
  }).catch(() => {});
}

export function forgetWithAccount(id: string) {
  if (!signedIn()) return;
  void fetch(`/api/me/projects/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: JSON_HEADERS,
  }).catch(() => {});
}

interface KeptProject {
  id: string;
  name: string;
  ownerKey: string;
  editKey: string;
  sample: boolean;
  updatedAt: number;
}

/**
 * Brings the account's plans to this browser: their keys, and their places in the recent
 * list. Returns the merged list, or null when not signed in or the server didn't answer.
 */
export async function pullFromAccount(): Promise<RecentProject[] | null> {
  if (!signedIn()) return null;
  try {
    const res = await fetch('/api/me/projects');
    if (!res.ok) return null;
    const { projects } = (await res.json()) as { projects: KeptProject[] };
    for (const p of projects) {
      const keys = {
        ...(p.ownerKey ? { owner: p.ownerKey } : {}),
        ...(p.editKey ? { edit: p.editKey } : {}),
      };
      if (Object.keys(keys).length) saveKeys(p.id, keys);
    }
    return adoptKept(projects);
  } catch {
    return null;
  }
}
