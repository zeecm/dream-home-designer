import { useEffect, useRef, useState } from 'react';
import { icons } from '../ui/icons';
import { type AiSettings, PROVIDERS, type Provider, saveAi, useAi } from './credentials';
import { AiError, askForJson } from './providers';

/** A 1 × 1 white PNG: enough for a model to answer a test. */
const DOT =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';

/** Which AI model to use, with the person's own key, kept in this browser. */
export function AiSettingsDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const saved = useAi();
  const [provider, setProvider] = useState<Provider>(saved?.provider ?? 'anthropic');
  const [key, setKey] = useState(saved?.key ?? '');
  const [model, setModel] = useState(saved?.model ?? PROVIDERS[provider].model);
  const [remember, setRemember] = useState(saved?.remember ?? false);
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
      onClose={onClose}
    >
      <header className="dialog-head">
        <h2 id="ai-h">AI assistant</h2>
        <button type="button" className="icon-btn" aria-label="Close" onClick={close}>
          {icons.close}
        </button>
      </header>
      <p className="dialog-note">
        Trace walls from a plan image with an AI model of your choice, using your own key. Your key
        is kept in this browser only, and your key and plan image go only to the provider you pick,
        straight from this browser. Each run costs a few cents on your account with them.
      </p>
      <form
        className="ai-form"
        onSubmit={(e) => {
          e.preventDefault();
          saveAi(settings());
          close();
        }}
      >
        <label className="field">
          <span className="field-label">Provider</span>
          <select
            className="input"
            value={provider}
            onChange={(e) => {
              const p = e.target.value as Provider;
              setProvider(p);
              setModel(PROVIDERS[p].model);
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
            autoComplete="off"
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
        <p className="field-hint" aria-live="polite">
          {status}
        </p>
        <div className="button-row">
          <button type="submit" className="btn btn-primary" disabled={!key.trim() || !model.trim()}>
            Save
          </button>
          <button type="button" className="btn" onClick={test} disabled={!key.trim() || testing}>
            Test
          </button>
          {saved && (
            <button
              type="button"
              className="btn"
              onClick={() => {
                saveAi(null);
                setKey('');
                setStatus('Key forgotten in this browser.');
              }}
            >
              Forget key
            </button>
          )}
        </div>
      </form>
    </dialog>
  );
}
