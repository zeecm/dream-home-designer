import { useEffect, useRef, useState } from 'react';
import { icons } from '../ui/icons';
import {
  type AiSettings,
  PROVIDERS,
  type Provider,
  forgetAi,
  keyFor,
  makesPictures,
  saveAi,
  useAi,
  useSavedProviders,
} from './credentials';
import { type ModelLists, checkPictureModel, curated, listModels, recommended } from './models';
import { AiError, askForJson } from './providers';

/** A 1 × 1 white PNG: enough for a model to answer a test. */
const DOT =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';

/** How long typing pauses before the key's models are looked up. */
const LIST_AFTER = 600;

/** The models to offer for one job, and the one selected. */
function choices(
  p: Provider,
  kind: keyof ModelLists,
  lists: ModelLists,
  /** What the person picked here, if anything. */
  picked: string,
  /** What was saved with the key, if anything. */
  saved: string | undefined,
): { options: { id: string; label: string }[]; value: string } {
  const listed = lists[kind];
  const ids = listed.map((o) => o.id);
  const best = recommended(p, kind, ids);
  // The recommended one first, then the rest best first.
  const ordered = [...listed.filter((o) => o.id === best), ...listed.filter((o) => o.id !== best)];
  const options = ordered.map((o) => ({
    id: o.id,
    label: o.id === best ? `${o.name} (recommended)` : o.name,
  }));
  const choice = picked || saved;
  // A saved model this key no longer lists stays, until changed.
  if (choice && !ids.includes(choice) && choice === saved) {
    return { options: [{ id: choice, label: `${choice} (saved)` }, ...options], value: choice };
  }
  return { options, value: choice && ids.includes(choice) ? choice : (best ?? '') };
}

/** Which AI model to use, with the person's own key, kept in this browser. */
export function AiSettingsDialog({
  onClose,
  initial,
}: {
  onClose: () => void;
  /** The provider to show first (renders need one that makes pictures). */
  initial?: Provider;
}) {
  const ref = useRef<HTMLDialogElement>(null);
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
  const [lists, setLists] = useState<ModelLists>(() => curated(first));
  const [listHint, setListHint] = useState('');
  const [status, setStatus] = useState<string[]>([]);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  // The models on this key, from the provider, once typing pauses; the usual ones until
  // then, or if they can't be listed.
  useEffect(() => {
    setLists(curated(provider));
    const k = key.trim();
    if (!k) {
      setListHint('');
      return;
    }
    const ctrl = new AbortController();
    const wait = setTimeout(() => {
      setListHint('Looking up the models on this key…');
      listModels(provider, k, ctrl.signal)
        .then((found) => {
          if (ctrl.signal.aborted) return;
          const usable = found.text.length > 0 && (!makesPictures(provider) || found.image.length);
          setLists(usable ? found : curated(provider));
          setListHint(
            usable ? '' : 'This key lists no models for these jobs: the usual ones are shown.',
          );
        })
        .catch((e: unknown) => {
          if (ctrl.signal.aborted) return;
          setLists(curated(provider));
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

  const text = choices(provider, 'text', lists, model, saved?.model);
  const pictures = makesPictures(provider)
    ? choices(provider, 'image', lists, imageModel, saved?.imageModel)
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
      );
      lines.push(`Plans and layouts (${s.model}): it works.`);
    } catch (e) {
      lines.push(
        `Plans and layouts (${s.model}): ${e instanceof AiError ? e.message : 'the test failed.'}`,
      );
    }
    if (s.imageModel) {
      // No picture is made: the key and the model are checked, which costs nothing.
      try {
        await checkPictureModel(s, s.imageModel);
        lines.push(`Pictures (${s.imageModel}): the key can use it.`);
      } catch (e) {
        lines.push(
          `Pictures (${s.imageModel}): ${e instanceof AiError ? e.message : 'the test failed.'}`,
        );
      }
    }
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
          saveAi(settings(), readsPlans);
          close();
        }}
      >
        <div className="dialog-body">
          <p className="dialog-note">
            With an AI model of your choice, on your own key: trace walls from a plan image, suggest
            layouts, and make photo-real renders (OpenAI or Gemini). Your key is kept in this
            browser only and goes, with what you send, only to the provider you pick. Each run costs
            a few cents on your account with them.
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
                  setStatus([]);
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
                  setStatus([]);
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
                  setStatus([]);
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
                    setStatus([]);
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
        </div>
        <footer className="dialog-foot">
          <p className="field-hint ai-status" aria-live="polite">
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
