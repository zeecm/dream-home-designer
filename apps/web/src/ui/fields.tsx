import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { formatLength, parseLength } from '../units';

interface FieldProps {
  label: string;
  hint?: string;
  children: (id: string, describedBy: string | undefined) => ReactNode;
}

/** Label above the control, an optional limit or hint tied to it underneath. */
export function Field({ label, hint, children }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children(id, hintId)}
      {hint && (
        <p className="field-hint" id={hintId}>
          {hint}
        </p>
      )}
    </div>
  );
}

interface LengthFieldProps {
  label: string;
  value: number | undefined;
  /** Shown when value is undefined, e.g. the inherited ceiling height. */
  placeholder?: string;
  min?: number;
  max?: number;
  hint?: string;
  allowEmpty?: boolean;
  onCommit: (value: number | undefined) => void;
}

/**
 * A length in metres that accepts mm, cm or m. Commits on Enter or blur; Escape
 * restores the current value. Out-of-range input is refused with a reason.
 */
export function LengthField({
  label,
  value,
  placeholder,
  min = 0.01,
  max = 100,
  hint,
  allowEmpty,
  onCommit,
}: LengthFieldProps) {
  const shown = value === undefined ? '' : formatLength(value);
  const [draft, setDraft] = useState(shown);
  const [error, setError] = useState<string | null>(null);
  // Escape blurs the field; the blur that follows must not commit what was typed.
  const cancelled = useRef(false);
  useEffect(() => {
    setDraft(shown);
    setError(null);
  }, [shown]);

  const commit = () => {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    if (draft.trim() === '' && allowEmpty) {
      if (value !== undefined) onCommit(undefined);
      setError(null);
      return;
    }
    const v = parseLength(draft);
    if (v === null) {
      setError('Enter a length such as 2.5 m, 250 cm, 2500 mm or just 2500.');
      return;
    }
    if (v < min || v > max) {
      setError(`Between ${formatLength(min)} and ${formatLength(max)}.`);
      return;
    }
    setError(null);
    if (value === undefined || Math.abs(v - value) > 1e-9) onCommit(v);
    else setDraft(shown);
  };

  return (
    <Field label={label} hint={error ?? hint}>
      {(id, describedBy) => (
        <input
          id={id}
          className={`input num${error ? ' invalid' : ''}`}
          inputMode="decimal"
          value={draft}
          placeholder={placeholder}
          aria-invalid={!!error}
          aria-describedby={describedBy}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              cancelled.current = true;
              setDraft(shown);
              setError(null);
              e.currentTarget.blur();
            }
          }}
        />
      )}
    </Field>
  );
}

export function TextField({
  label,
  value,
  suggestions,
  focusToken = 0,
  onDone,
  onCommit,
}: {
  label: string;
  value: string;
  /** Offered as the user types (a native datalist). */
  suggestions?: string[];
  /** Each change focuses the field and selects its text. */
  focusToken?: number;
  /** Called after Enter or Escape when focus came from `focusToken`, to hand focus back. */
  onDone?: () => void;
  onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  useEffect(() => setDraft(value), [value]);
  // Focus on a new request only, not on mount with a token left over from an earlier one.
  const seenToken = useRef(focusToken);
  const requested = useRef(false);
  const cancelled = useRef(false);
  useEffect(() => {
    if (focusToken === seenToken.current) return;
    seenToken.current = focusToken;
    requested.current = true;
    input.current?.focus();
    input.current?.select();
  }, [focusToken]);
  const commit = () => {
    if (cancelled.current) {
      cancelled.current = false;
      setDraft(value);
      return;
    }
    const v = draft.trim();
    if (v && v !== value) onCommit(v);
    else setDraft(value);
  };
  return (
    <Field label={label}>
      {(id) => (
        <>
          <input
            id={id}
            ref={input}
            className="input"
            value={draft}
            list={suggestions ? listId : undefined}
            autoComplete="off"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              commit();
              requested.current = false;
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== 'Escape') return;
              if (e.key === 'Escape') cancelled.current = true;
              const handBack = requested.current;
              e.currentTarget.blur();
              if (handBack) onDone?.();
            }}
          />
          {suggestions && (
            <datalist id={listId}>
              {suggestions.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          )}
        </>
      )}
    </Field>
  );
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <Field label={label}>
      {(id) => (
        <select
          id={id}
          className="input"
          value={value}
          onChange={(e) => onChange(e.target.value as T)}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

/** As wide as its options; one choice. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  fill,
  onChange,
}: {
  label: string;
  /** Stretch across the container, options sharing the width. */
  fill?: boolean;
  value: T;
  options: { value: T; label: string; title?: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <fieldset className={`segmented${fill ? ' segmented-fill' : ''}`} aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          title={o.title}
          className={o.value === value ? 'on' : undefined}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </fieldset>
  );
}
