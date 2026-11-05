import { useEffect, useRef, useState } from 'react';
import { icons } from '../ui/icons';
import {
  type AiSettings,
  PROVIDERS,
  type Provider,
  forgetAi,
  keyFor,
  saveAi,
  useAi,
  useSavedProviders,
} from './credentials';
import { AiError, askForJson } from './providers';

/** A 1 × 1 white PNG: enough for a model to answer a test. */
const DOT =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';

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
  const saved = keyFor(first);
  const [provider, setProvider] = useState<Provider>(first);
  const [key, setKey] = useState(saved?.key ?? '');
  const [model, setModel] = useState(saved?.model ?? PROVIDERS[first].model);
  const [remember, setRemember] = useState(saved?.remember ?? false);
  // Whether this key reads plans and suggests layouts (Claude reading, OpenAI drawing, say).
  const [readsPlans, setReadsPlans] = useState(!active || active.provider === first);
  const [status, setStatus] = useState('');
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  const close = () => ref.current?.close();
  const settings = (): AiSettings => ({
    provider,
    key: key.trim(),
    model: model.trim(),
    remember,
  });

  const test = async () => {
    setTesting(true);
    setStatus('Testing…');
    try {
      await askForJson(
        settings(),
        'Reply with {"ok": true}.',
        { data: DOT, mediaType: 'image/png' },
        {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
          additionalProperties: false,
        },
      );
      setStatus('It works.');
    } catch (e) {
      setStatus(e instanceof AiError ? e.message : 'The test failed.');
    }
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
                  setModel(k?.model ?? PROVIDERS[p].model);
                  setRemember(k?.remember ?? false);
                  setReadsPlans(!active || active.provider === p);
                  setStatus('');
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
                  setStatus('');
                }}
              />
            </label>
            <label className="field">
              <span className="field-label">Model</span>
              <input
                className="input"
                spellCheck={false}
                value={model}
                onChange={(e) => setModel(e.target.value)}
              />
            </label>
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
          <p className="field-hint" aria-live="polite">
            {status}
          </p>
          <div className="button-row">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!key.trim() || !model.trim()}
            >
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
                  setStatus('Key forgotten in this browser.');
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
