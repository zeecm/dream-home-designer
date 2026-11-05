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
  /** Each key with its own choice: on this device (remember), or this tab only. */
  keys: Partial<Record<Provider, { key: string; model: string; remember?: boolean }>>;
}

const KEY = 'dhd-ai';
const listeners = new Set<() => void>();
const isProvider = (p: unknown): p is Provider => typeof p === 'string' && p in PROVIDERS;

function parse(raw: string | null, remember: boolean): Stored | null {
  if (!raw) return null;
  const v = JSON.parse(raw) as Partial<Stored> & Partial<AiSettings>;
  // The first format: one provider's key.
  if (isProvider(v.provider) && v.key) {
    return {
      active: v.provider,
      keys: {
        [v.provider]: { key: v.key, model: v.model || PROVIDERS[v.provider].model, remember },
      },
    };
  }
  if (!isProvider(v.active) || !v.keys) return null;
  const keys: Stored['keys'] = {};
  for (const [p, k] of Object.entries(v.keys)) {
    if (isProvider(p) && k?.key) keys[p] = { ...k, remember };
  }
  return { active: v.active, keys };
}

function read(): Stored | null {
  try {
    // Keys kept on this device, and keys for this tab only (which win, being newer).
    const device = parse(window.localStorage.getItem(KEY), true);
    const tab = parse(window.sessionStorage.getItem(KEY), false);
    if (!device && !tab) return null;
    return {
      active: tab?.active ?? device?.active ?? 'anthropic',
      keys: { ...device?.keys, ...tab?.keys },
    };
  } catch {
    return null;
  }
}

let stored = typeof window === 'undefined' ? null : read();
let current = active(stored);

function active(s: Stored | null): AiSettings | null {
  const k = s?.keys[s.active];
  return s && k ? { provider: s.active, key: k.key, model: k.model, remember: !!k.remember } : null;
}

function write(s: Stored | null) {
  stored = s && Object.keys(s.keys).length ? s : null;
  current = active(stored);
  try {
    window.localStorage.removeItem(KEY);
    window.sessionStorage.removeItem(KEY);
    if (stored) {
      // Each key where its owner chose to keep it.
      for (const [storage, remember] of [
        [window.localStorage, true],
        [window.sessionStorage, false],
      ] as const) {
        const keys = Object.fromEntries(
          Object.entries(stored.keys).filter(([, k]) => !!k?.remember === remember),
        );
        if (Object.keys(keys).length) {
          storage.setItem(KEY, JSON.stringify({ active: stored.active, keys }));
        }
      }
    }
  } catch {
    // A private window may refuse: the keys hold for this visit.
  }
  for (const fn of listeners) fn();
}

/** Saves a provider's key and makes it the one in use; null forgets every key. */
export function saveAi(settings: AiSettings | null, readsPlans = true) {
  if (!settings) return write(null);
  write({
    // The one that reads plans and suggests layouts: this one, or the one before.
    active: readsPlans || !stored?.keys[stored.active] ? settings.provider : stored.active,
    keys: {
      ...stored?.keys,
      [settings.provider]: {
        key: settings.key,
        model: settings.model,
        remember: !!settings.remember,
      },
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
  return k ? { provider: p, key: k.key, model: k.model, remember: !!k.remember } : null;
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
