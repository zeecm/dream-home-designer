import { useSyncExternalStore } from 'react';

/**
 * The AI models this person uses, with their own keys: kept in this tab, or on this device
 * if they choose, and in this browser only (never in a project, an export, a share link or
 * a request to our server), each sent only to the provider it belongs to, straight from this
 * browser. One provider is the one in use for reading plans; renders use one that can make
 * pictures (OpenAI or Gemini).
 */
export type Provider = 'anthropic' | 'openai' | 'gemini';

export interface AiSettings {
  provider: Provider;
  key: string;
  model: string;
  /** Kept on this device (localStorage); otherwise only until the tab closes. */
  remember?: boolean;
}

export const PROVIDERS: Record<
  Provider,
  { name: string; model: string; keyHint: string; imageModel?: string }
> = {
  anthropic: { name: 'Claude (Anthropic)', model: 'claude-opus-5-5', keyHint: 'sk-ant-…' },
  openai: { name: 'OpenAI', model: 'gpt-5', keyHint: 'sk-…', imageModel: 'gpt-image-1' },
  gemini: {
    name: 'Gemini (Google)',
    model: 'gemini-2.5-pro',
    keyHint: 'AIza…',
    imageModel: 'gemini-2.5-flash-image',
  },
};

interface Stored {
  active: Provider;
  remember: boolean;
  keys: Partial<Record<Provider, { key: string; model: string }>>;
}

const KEY = 'dhd-ai';
const listeners = new Set<() => void>();
const isProvider = (p: unknown): p is Provider => typeof p === 'string' && p in PROVIDERS;

function read(): Stored | null {
  try {
    const raw = window.sessionStorage.getItem(KEY) ?? window.localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Stored> & Partial<AiSettings>;
    // The first format: one provider's key.
    if (isProvider(v.provider) && v.key) {
      return {
        active: v.provider,
        remember: !!v.remember,
        keys: { [v.provider]: { key: v.key, model: v.model || PROVIDERS[v.provider].model } },
      };
    }
    if (!isProvider(v.active) || !v.keys) return null;
    return { active: v.active, remember: !!v.remember, keys: v.keys };
  } catch {
    return null;
  }
}

let stored = typeof window === 'undefined' ? null : read();
let current = active(stored);

function active(s: Stored | null): AiSettings | null {
  const k = s?.keys[s.active];
  return s && k ? { provider: s.active, key: k.key, model: k.model, remember: s.remember } : null;
}

function write(s: Stored | null) {
  stored = s && Object.keys(s.keys).length ? s : null;
  current = active(stored);
  try {
    window.localStorage.removeItem(KEY);
    window.sessionStorage.removeItem(KEY);
    if (stored) {
      (stored.remember ? window.localStorage : window.sessionStorage).setItem(
        KEY,
        JSON.stringify(stored),
      );
    }
  } catch {
    // A private window may refuse: the keys hold for this visit.
  }
  for (const fn of listeners) fn();
}

/** Saves a provider's key and makes it the one in use; null forgets every key. */
export function saveAi(settings: AiSettings | null) {
  if (!settings) return write(null);
  write({
    active: settings.provider,
    remember: !!settings.remember,
    keys: {
      ...stored?.keys,
      [settings.provider]: { key: settings.key, model: settings.model },
    },
  });
}

/** Forgets one provider's key. */
export function forgetAi(provider: Provider) {
  if (!stored) return;
  const keys = { ...stored.keys };
  delete keys[provider];
  const left = Object.keys(keys).filter(isProvider);
  write({
    ...stored,
    keys,
    active: keys[stored.active] ? stored.active : (left[0] ?? stored.active),
  });
}

export function aiSettings(): AiSettings | null {
  return current;
}

/** A provider's saved key and model, if there is one. */
export function keyFor(p: Provider): AiSettings | null {
  const k = stored?.keys[p];
  return k ? { provider: p, key: k.key, model: k.model, remember: stored?.remember } : null;
}

/** The key to make pictures with: the one in use if it can, else another saved one that can. */
export function imageSettings(): AiSettings | null {
  const order: Provider[] = current ? [current.provider, 'openai', 'gemini'] : ['openai', 'gemini'];
  for (const p of order) {
    const model = PROVIDERS[p].imageModel;
    const k = keyFor(p);
    if (model && k) return { ...k, model };
  }
  return null;
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export function useAi(): AiSettings | null {
  return useSyncExternalStore(subscribe, () => current);
}

/** Which providers have a saved key (re-renders as keys change). */
export function useSavedProviders(): Provider[] {
  const s = useSyncExternalStore(subscribe, () => stored);
  return s ? (Object.keys(s.keys) as Provider[]).filter(isProvider) : [];
}
