import { useSyncExternalStore } from 'react';

/**
 * The AI model this person uses, with their own key: kept in this tab, or on this device if
 * they choose, and in this browser only (never in
 * a project, an export, a share link or a request to our server), sent only to the
 * provider it belongs to, straight from this browser.
 */
export type Provider = 'anthropic' | 'openai' | 'gemini';

export interface AiSettings {
  provider: Provider;
  key: string;
  model: string;
  /** Kept on this device (localStorage); otherwise only until the tab closes. */
  remember?: boolean;
}

export const PROVIDERS: Record<Provider, { name: string; model: string; keyHint: string }> = {
  anthropic: { name: 'Claude (Anthropic)', model: 'claude-opus-5-5', keyHint: 'sk-ant-…' },
  openai: { name: 'OpenAI', model: 'gpt-5', keyHint: 'sk-…' },
  gemini: { name: 'Gemini (Google)', model: 'gemini-2.5-pro', keyHint: 'AIza…' },
};

const KEY = 'dhd-ai';
const listeners = new Set<() => void>();

function read(): AiSettings | null {
  try {
    const raw = window.sessionStorage.getItem(KEY) ?? window.localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<AiSettings>;
    if (!v.provider || !(v.provider in PROVIDERS) || !v.key) return null;
    return {
      provider: v.provider,
      key: v.key,
      model: v.model || PROVIDERS[v.provider].model,
      remember: !!v.remember,
    };
  } catch {
    return null;
  }
}

let current = typeof window === 'undefined' ? null : read();

export function saveAi(settings: AiSettings | null) {
  current = settings;
  try {
    window.localStorage.removeItem(KEY);
    window.sessionStorage.removeItem(KEY);
    if (settings) {
      (settings.remember ? window.localStorage : window.sessionStorage).setItem(
        KEY,
        JSON.stringify(settings),
      );
    }
  } catch {
    // A private window may refuse: the key holds for this visit.
  }
  for (const fn of listeners) fn();
}

export function aiSettings(): AiSettings | null {
  return current;
}

export function useAi(): AiSettings | null {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => current,
  );
}
