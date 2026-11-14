import { type AiSettings, PROVIDERS, type Provider } from '@dhd/ai';
import { useSyncExternalStore } from 'react';

/**
 * The AI models this person uses, with their own keys: kept in this tab, or on this device
 * if they choose, and in this browser only (never in a project, an export, a share link or
 * a request to our server), each sent only to the provider it belongs to, straight from this
 * browser. One provider is the one in use for reading plans; renders use one that can make
 * pictures (OpenAI or Gemini).
 */

/**
 * The models to offer when the provider's own list can't be had (a network or key problem),
 * best first. Names exactly as the providers list them.
 */
export const CURATED: Record<Provider, { text: string[]; image: string[] }> = {
  anthropic: { text: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'], image: [] },
  openai: { text: ['gpt-5'], image: ['gpt-image-1'] },
  gemini: {
    text: ['gemini-3.1-pro-preview', 'gemini-2.5-pro', 'gemini-2.5-flash'],
    image: ['gemini-3-pro-image', 'gemini-3.1-flash-image', 'gemini-2.5-flash-image'],
  },
};

/**
 * Names to show for the built-in models, as their providers write them, for when the
 * provider's own list (with its names) can't be had. The id stays the option's value.
 */
export const MODEL_NAMES: Record<string, string> = {
  'claude-opus-5-5': 'Claude Opus 5.5',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5',
  'claude-haiku-5-5': 'Claude Haiku 5.5',
  'gemini-3.1-pro-preview': 'Gemini 3.1 Pro Preview',
  'gemini-2.5-pro': 'Gemini 2.5 Pro',
  'gemini-2.5-flash': 'Gemini 2.5 Flash',
  'gemini-3-pro-image': 'Gemini 3 Pro Image',
  'gemini-3.1-flash-image': 'Gemini 3.1 Flash Image',
  'gemini-2.5-flash-image': 'Gemini 2.5 Flash Image',
};

/**
 * What a picture costs, next to the provider's others, where we know it: shown in the picture
 * select, so a dearer model is a choice made knowingly. Rough: keep up with the providers' prices.
 */
export function priceNote(id: string): string | undefined {
  if (/^gemini-2\.5-flash-image/.test(id) || /^gpt-image-1-mini/.test(id)) return 'cheaper';
  if (/^gemini-3-pro-image/.test(id)) return 'about 3× the price';
  return undefined;
}

/** Whether a provider makes pictures. */
export const makesPictures = (p: Provider) => !!PROVIDERS[p].imageModel;

/**
 * Text models a saved key may name that no longer work: gemini-3-pro (the old default, never
 * a Gemini API id) and gemini-3-pro-preview (shut down on 9 Mar 2026). Neither has a price.
 */
const RETIRED = ['gemini-3-pro', 'gemini-3-pro-preview'];

interface SavedKey {
  key: string;
  model: string;
  imageModel?: string;
  remember?: boolean;
}

interface Stored {
  active: Provider;
  /** Each key with its own choice: on this device (remember), or this tab only. */
  keys: Partial<Record<Provider, SavedKey>>;
}

/**
 * A saved key brought up to date. Before the picture model had its own choice, some people
 * put an image model (gemini-3-pro-image, say) in the one Model field: it was never used
 * for pictures, and it made reading plans fail. It becomes the picture model, and plans go
 * back to the default. A model that can no longer be used (RETIRED) goes back to the default.
 */
export function migrateKey(p: Provider, k: SavedKey): SavedKey {
  const model = k.model && !RETIRED.includes(k.model) ? k.model : PROVIDERS[p].model;
  if (k.imageModel || !makesPictures(p) || !/image/i.test(model)) return { ...k, model };
  return { ...k, model: PROVIDERS[p].model, imageModel: model };
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
        [v.provider]: migrateKey(v.provider, { key: v.key, model: v.model ?? '', remember }),
      },
    };
  }
  if (!isProvider(v.active) || !v.keys) return null;
  const keys: Stored['keys'] = {};
  for (const [p, k] of Object.entries(v.keys)) {
    if (isProvider(p) && k?.key) keys[p] = migrateKey(p, { ...k, remember });
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
  return s && k ? settingsOf(s.active, k) : null;
}

function settingsOf(provider: Provider, k: SavedKey): AiSettings {
  return {
    provider,
    key: k.key,
    model: k.model,
    ...(k.imageModel ? { imageModel: k.imageModel } : {}),
    remember: !!k.remember,
  };
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
        ...(settings.imageModel ? { imageModel: settings.imageModel } : {}),
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

/** A provider's saved key and models, if there is one. */
export function keyFor(p: Provider): AiSettings | null {
  const k = stored?.keys[p];
  return k ? settingsOf(p, k) : null;
}

/** The model a key makes pictures with: the one chosen, or the provider's default. */
export const pictureModel = (s: AiSettings): string | undefined =>
  makesPictures(s.provider) ? s.imageModel || PROVIDERS[s.provider].imageModel : undefined;

/**
 * The key to make pictures with, `model` set to its picture model: the one in use if it can,
 * else another saved one that can.
 */
export function imageSettings(): AiSettings | null {
  const order: Provider[] = current ? [current.provider, 'openai', 'gemini'] : ['openai', 'gemini'];
  for (const p of order) {
    const k = keyFor(p);
    const model = k && pictureModel(k);
    if (k && model) return { ...k, model };
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
