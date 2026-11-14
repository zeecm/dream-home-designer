import { AiError, type AiSettings, PROVIDERS, type Provider } from '@dhd/ai';
import type { Price } from '@dhd/core';
import { useEffect, useRef, useState } from 'react';
import { icons } from '../ui/icons';
import {
  forgetAi,
  keyFor,
  makesPictures,
  priceNote,
  saveAi,
  useAi,
  useSavedProviders,
} from './credentials';
import { SpendSettings } from './designer/SpendSettings';
import { useSpend } from './designer/spend';
import {
  type ModelLists,
  checkPictureModel,
  curated,
  listModels,
  modelName,
  recommended,
  unpricedNote,
} from './models';
import { askForJson, inSettings } from './providers';

/**
 * A 64 × 64 light grey PNG for the test: an image so the test also checks the model takes one.
 * Not 1 × 1: Gemini refuses images that small ("Unable to process input image").
 */
const DOT =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAATElEQVR42u3PMQ0AAAwDoPpXWwmVsHsJOCB9LgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIClwHQUQKk2+ThhwAAAABJRU5ErkJggg==';

/** How long typing pauses before the key's models are looked up. */
const LIST_AFTER = 600;

/** The models to offer for one job, and the one selected. */
function choices(
  p: Provider,
  kind: keyof ModelLists,
  lists: ModelLists,
  /** What the person picked here, if anything. */
  picked: string,
  /**
   * What the saved key uses, if anything: kept until the person picks another, never
   * swapped for the recommended one by saving again.
   */
  saved: string | undefined,
  /** The prices in use (list prices, with this browser's own). */
  prices: Record<string, Price>,
): { options: { id: string; label: string }[]; value: string } {
  const listed = lists[kind];
  const ids = listed.map((o) => o.id);
  const best = recommended(p, kind, ids, prices);
  const label = (id: string, name: string, ...tags: (string | false | undefined)[]) => {
    // A model for plans with no price: the designer refuses it (it says why).
    const unpriced = kind === 'text' && unpricedNote(id, prices);
    const notes = [...tags, kind === 'image' && priceNote(id), unpriced].filter(Boolean);
    return notes.length ? `${name} (${notes.join(', ')})` : name;
  };
  // The recommended one first, then the rest best first.
  const ordered = [...listed.filter((o) => o.id === best), ...listed.filter((o) => o.id !== best)];
  const options = ordered.map((o) => ({
    id: o.id,
    label: label(o.id, o.name, o.id === best && 'recommended'),
  }));
  const choice = picked || saved;
  // A saved model this key no longer lists stays, until changed.
  if (choice && !ids.includes(choice) && choice === saved) {
    return {
      options: [{ id: choice, label: label(choice, modelName(choice), 'saved') }, ...options],
      value: choice,
    };
  }
  return { options, value: choice && ids.includes(choice) ? choice : (best ?? '') };
}

/** The lists shown for a provider: its own once listed, else the usual ones per job. */
function withFallback(p: Provider, found: ModelLists): { lists: ModelLists; short: boolean } {
  const usual = curated(p);
  const text = found.text.length ? found.text : usual.text;
  const image = !makesPictures(p) ? [] : found.image.length ? found.image : usual.image;
  return {
    lists: { text, image },
    short: !found.text.length || (makesPictures(p) && !found.image.length),
  };
}

/** Which AI model to use, with the person's own key, kept in this browser. */
export function AiSettingsDialog({
  onClose,
  initial,
  focus,
}: {
  onClose: () => void;
  /** The provider to show first (renders need one that makes pictures). */
  initial?: Provider;
  /** Opened at the price table (from the designer's cost check). */
  focus?: 'prices';
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const prices = useRef<(() => boolean) | null>(null);
  const active = useAi();
  const savedKeys = useSavedProviders();
  const first = initial ?? active?.provider ?? 'anthropic';
  const [provider, setProvider] = useState<Provider>(first);
  const saved = keyFor(provider);
  const [key, setKey] = useState(saved?.key ?? '');
  // What the person picked here; until then the saved model, or the recommended one.
  const [model, setModel] = useState('');
  const [imageModel, setImageModel] = useState('');
  const [remember, setRemember] = useState(saved?.remember ?? false);
  // Whether this key reads plans and suggests layouts (Claude reading, OpenAI drawing, say).
  const [readsPlans, setReadsPlans] = useState(!active || active.provider === first);
  // The lists last shown, and whose: kept while a changed key's are looked up, so the
  // selects don't jump back to the usual models at each keystroke.
  const [listed, setListed] = useState<{ provider: Provider; lists: ModelLists }>(() => ({
    provider: first,
    lists: curated(first),
  }));
  const lists = listed.provider === provider ? listed.lists : curated(provider);
  const [listHint, setListHint] = useState('');
  const [status, setStatus] = useState<string[]>([]);
  const [testing, setTesting] = useState(false);
  // The test running, stopped when what it tests changes (its answer would be about another).
  const testRun = useRef<AbortController | null>(null);
  const stopTest = () => {
    testRun.current?.abort();
    testRun.current = null;
    setTesting(false);
    setStatus([]);
  };

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => testRun.current?.abort();
  }, []);

  // The models on this key, from the provider, once typing pauses; the usual ones until
  // then, or if they can't be listed.
  useEffect(() => {
    const k = key.trim();
    if (!k) {
      setListed({ provider, lists: curated(provider) });
      setListHint('');
      return;
    }
    const ctrl = new AbortController();
    const wait = setTimeout(() => {
      setListHint('Looking up the models on this key…');
      listModels(provider, k, ctrl.signal)
        .then((found) => {
          if (ctrl.signal.aborted) return;
          // The usual ones for a job this key lists nothing for.
          const { lists, short } = withFallback(provider, found);
          setListed({ provider, lists });
          setListHint(
            short ? 'Where this key lists no models for a job, the usual ones are shown.' : '',
          );
        })
        .catch((e: unknown) => {
          if (ctrl.signal.aborted) return;
          setListed({ provider, lists: curated(provider) });
          setListHint(
            e instanceof AiError && e.kind === 'key'
              ? 'The key was refused, so the usual models are shown. Check the key.'
              : 'Couldn’t list the models on this key, so the usual ones are shown.',
          );
        });
    }, LIST_AFTER);
    return () => {
      clearTimeout(wait);
      ctrl.abort();
    };
  }, [provider, key]);

  const { prices: priceList } = useSpend();
  const text = choices(provider, 'text', lists, model, saved?.model, priceList);
  const pictures = makesPictures(provider)
    ? choices(
        provider,
        'image',
        lists,
        imageModel,
        // A key saved before the choice existed renders with the default: that stays.
        saved ? saved.imageModel || PROVIDERS[provider].imageModel : undefined,
        priceList,
      )
    : null;

  const close = () => ref.current?.close();
  const settings = (): AiSettings => ({
    provider,
    key: key.trim(),
    model: text.value,
    ...(pictures?.value ? { imageModel: pictures.value } : {}),
    remember,
  });

  const test = async () => {
    testRun.current?.abort();
    const run = new AbortController();
    testRun.current = run;
    setTesting(true);
    setStatus(['Testing…']);
    const s = settings();
    const lines: string[] = [];
    try {
      await askForJson(
        s,
        'Reply with {"ok": true}.',
        { data: DOT, mediaType: 'image/png' },
        {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
          additionalProperties: false,
        },
        run.signal,
      );
      lines.push(`Plans and layouts (${s.model}): it works.`);
    } catch (e) {
      lines.push(
        `Plans and layouts (${s.model}): ${e instanceof AiError ? inSettings(e) : 'the test failed.'}`,
      );
    }
    if (s.imageModel && !run.signal.aborted) {
      // No picture is made: the key and the model are checked, which costs nothing.
      try {
        await checkPictureModel(s, s.imageModel, run.signal);
        lines.push(
          s.provider === 'openai'
            ? // Only looked up: OpenAI asks some organisations to verify before making pictures.
              `Pictures (${s.imageModel}): the picture model exists; your organisation may still need verifying to use it.`
            : `Pictures (${s.imageModel}): the key can use it.`,
        );
      } catch (e) {
        lines.push(
          `Pictures (${s.imageModel}): ${e instanceof AiError ? inSettings(e) : 'the test failed.'}`,
        );
      }
    }
    // Stopped (the provider, key or a model changed, or the dialog closed): nothing to say.
    if (testRun.current !== run) return;
    testRun.current = null;
    setStatus(lines);
    setTesting(false);
  };

  return (
    <dialog
      ref={ref}
      className="dialog ai-dialog"
      aria-labelledby="ai-h"
      tabIndex={-1}
      // Only its own close: React passes a dialog opened inside it up the tree too.
      onClose={(e) => e.target === e.currentTarget && onClose()}
    >
      <header className="dialog-head">
        <h2 id="ai-h">AI assistant</h2>
        <button type="button" className="icon-btn" aria-label="Close" onClick={close}>
          {icons.close}
        </button>
      </header>
      <form
        className="dialog-form"
        onSubmit={(e) => {
          e.preventDefault();
          // Prices typed but not complete: say so, and keep the dialog open.
          if (prices.current && !prices.current()) {
            document.getElementById('ai-prices')?.scrollIntoView({ block: 'center' });
            return;
          }
          saveAi(settings(), readsPlans);
          close();
        }}
      >
        <div className="dialog-body">
          <p className="dialog-note">
            With an AI model of your choice, on your own key: trace walls from a plan image, suggest
            layouts, and make photo-real renders (OpenAI or Gemini). Your key is kept in this
            browser only and goes, with what you send, only to the provider you pick. Each run costs
            a few cents on your account with them; designing a whole flat costs more, about
            US$0.30–1.50, and is shown before it runs.
          </p>
          <div className="ai-form">
            <label className="field">
              <span className="field-label">Provider</span>
              <select
                className="input"
                value={provider}
                onChange={(e) => {
                  const p = e.target.value as Provider;
                  const k = keyFor(p);
                  setProvider(p);
                  setKey(k?.key ?? '');
                  setModel('');
                  setImageModel('');
                  setRemember(k?.remember ?? false);
                  setReadsPlans(!active || active.provider === p);
                  stopTest();
                }}
              >
                {(Object.keys(PROVIDERS) as Provider[]).map((p) => (
                  <option key={p} value={p}>
                    {PROVIDERS[p].name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">API key</span>
              <input
                className="input"
                type="password"
                // Not one for the browser's password manager (which may sync it elsewhere).
                autoComplete="new-password"
                data-1p-ignore
                data-lpignore="true"
                spellCheck={false}
                placeholder={PROVIDERS[provider].keyHint}
                value={key}
                onChange={(e) => {
                  setKey(e.target.value);
                  stopTest();
                }}
              />
            </label>
            <label className="field">
              <span className="field-label">Model for plans and layouts</span>
              <select
                className="input"
                value={text.value}
                onChange={(e) => {
                  setModel(e.target.value);
                  stopTest();
                }}
              >
                {text.options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            {pictures && (
              <label className="field">
                <span className="field-label">Model for pictures (photo-real renders)</span>
                <select
                  className="input"
                  value={pictures.value}
                  onChange={(e) => {
                    setImageModel(e.target.value);
                    stopTest();
                  }}
                >
                  {pictures.options.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {listHint && (
              <p className="field-hint" aria-live="polite">
                {listHint}
              </p>
            )}
            <label className="check-row">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
              />
              <span>Remember the key on this device (otherwise only until this tab closes)</span>
            </label>
            {active && active.provider !== provider ? (
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={readsPlans}
                  onChange={(e) => setReadsPlans(e.target.checked)}
                />
                <span>
                  Use {PROVIDERS[provider].name} to trace plans and suggest layouts (now{' '}
                  {PROVIDERS[active.provider].name})
                </span>
              </label>
            ) : null}
            {savedKeys.length > 0 && (
              <p className="field-hint">
                Keys kept: {savedKeys.map((p) => PROVIDERS[p].name).join(', ')}. Renders use an
                OpenAI or Gemini key.
              </p>
            )}
          </div>
          <SpendSettings
            model={text.value || PROVIDERS[provider].model}
            focus={focus === 'prices'}
            commitRef={prices}
          />
        </div>
        <footer className="dialog-foot">
          <p className="field-hint ai-status foot-status" aria-live="polite">
            {status.map((line) => (
              <span key={line}>{line}</span>
            ))}
          </p>
          <div className="button-row">
            <button type="submit" className="btn btn-primary" disabled={!key.trim() || !text.value}>
              Save
            </button>
            <button type="button" className="btn" onClick={test} disabled={!key.trim() || testing}>
              Test
            </button>
            {savedKeys.includes(provider) && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  stopTest();
                  forgetAi(provider);
                  setKey('');
                  setStatus(['Key forgotten in this browser.']);
                }}
              >
                Forget key
              </button>
            )}
          </div>
        </footer>
      </form>
    </dialog>
  );
}
