import { afterEach, describe, expect, it, vi } from 'vitest';
import { migrateKey } from './credentials';

/** A Storage in memory, as a browser's. */
function memoryStorage(init: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(init));
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

/** The credentials module as a browser with these saved settings would load it. */
async function load(local: Record<string, string>, session: Record<string, string> = {}) {
  vi.resetModules();
  const localStorage = memoryStorage(local);
  const sessionStorage = memoryStorage(session);
  vi.stubGlobal('window', { localStorage, sessionStorage });
  return { mod: await import('./credentials'), localStorage, sessionStorage };
}

afterEach(() => vi.unstubAllGlobals());

describe('saved AI settings', () => {
  it('keeps a key saved before the picture model existed, with the default picture model', async () => {
    const { mod } = await load({
      'dhd-ai': JSON.stringify({
        active: 'gemini',
        keys: { gemini: { key: 'AIza-x', model: 'gemini-2.5-pro' } },
      }),
    });
    expect(mod.keyFor('gemini')).toEqual({
      provider: 'gemini',
      key: 'AIza-x',
      model: 'gemini-2.5-pro',
      remember: true,
    });
    expect(mod.imageSettings()?.model).toBe('gemini-2.5-flash-image');
  });

  it('renders with the stored picture model', async () => {
    const { mod, sessionStorage } = await load(
      {},
      {
        'dhd-ai': JSON.stringify({
          active: 'anthropic',
          keys: {
            anthropic: { key: 'sk-ant-x', model: 'claude-opus-5-5' },
            gemini: { key: 'AIza-x', model: 'gemini-3-pro', imageModel: 'gemini-3-pro-image' },
          },
        }),
      },
    );
    expect(mod.aiSettings()?.model).toBe('claude-opus-5-5');
    expect(mod.imageSettings()).toMatchObject({ provider: 'gemini', model: 'gemini-3-pro-image' });
    // Saved again with a new picture model, next to the plans model.
    mod.saveAi(
      {
        provider: 'gemini',
        key: 'AIza-x',
        model: 'gemini-3-pro',
        imageModel: 'gemini-2.5-flash-image',
      },
      false,
    );
    const saved = JSON.parse(sessionStorage.getItem('dhd-ai') ?? '{}');
    expect(saved.active).toBe('anthropic');
    expect(saved.keys.gemini).toEqual({
      key: 'AIza-x',
      model: 'gemini-3-pro',
      imageModel: 'gemini-2.5-flash-image',
      remember: false,
    });
    expect(mod.imageSettings()?.model).toBe('gemini-2.5-flash-image');
  });

  it('moves an image model typed as the one model to pictures (the first format too)', async () => {
    const { mod } = await load({
      'dhd-ai': JSON.stringify({ provider: 'gemini', key: 'AIza-x', model: 'gemini-3-pro-image' }),
    });
    expect(mod.keyFor('gemini')).toMatchObject({
      model: 'gemini-3.1-pro-preview',
      imageModel: 'gemini-3-pro-image',
    });
    expect(mod.imageSettings()?.model).toBe('gemini-3-pro-image');
  });

  it('migrates one key', () => {
    expect(migrateKey('openai', { key: 'k', model: 'gpt-image-1' })).toEqual({
      key: 'k',
      model: 'gpt-5',
      imageModel: 'gpt-image-1',
    });
    expect(migrateKey('openai', { key: 'k', model: '' })).toEqual({ key: 'k', model: 'gpt-5' });
    // Claude makes no pictures; a chosen picture model stays.
    expect(
      migrateKey('anthropic', { key: 'k', model: 'claude-opus-5-5' }).imageModel,
    ).toBeUndefined();
    expect(
      migrateKey('gemini', { key: 'k', model: 'gemini-2.5-pro', imageModel: 'gemini-3-pro-image' }),
    ).toEqual({ key: 'k', model: 'gemini-2.5-pro', imageModel: 'gemini-3-pro-image' });
    // The old default (never a Gemini API id) and the shut-down preview go to today's default.
    for (const model of ['gemini-3-pro', 'gemini-3-pro-preview']) {
      expect(migrateKey('gemini', { key: 'k', model, imageModel: 'gemini-3-pro-image' })).toEqual({
        key: 'k',
        model: 'gemini-3.1-pro-preview',
        imageModel: 'gemini-3-pro-image',
      });
    }
  });
});
