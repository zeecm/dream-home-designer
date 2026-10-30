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
/**
 * The text of a field being edited. While an edit is open the field keeps the typed text;
 * `take` hands it over with the latest `target` (the commit callback and the values it
 * checks against). The inspector mounts fresh fields for each object, so the latest target
 * is always the object the text was typed for, with its current values.
 */
function useEdit<T>(shown: string, target: T) {
  const [text, setText] = useState(shown);
  const session = useRef<{ draft: string } | null>(null);
  const latest = useRef(shown);
  latest.current = shown;
  const current = useRef(target);
  current.current = target;
  useEffect(() => {
    if (!session.current) setText(shown);
  }, [shown]);
  return {
    draft: text,
    editing: () => session.current !== null,
    type: (draft: string) => {
      session.current = { draft };
      setText(draft);
    },
    /** Ends the edit, returning what was typed and for what; null if nothing was typed. */
    take: (): { draft: string; target: T } | null => {
      const s = session.current;
      session.current = null;
      return s ? { draft: s.draft, target: current.current } : null;
    },
    /** Keeps an edit open (after a refused value) so it can be corrected. */
    keep: (s: { draft: string }) => {
      session.current = { draft: s.draft };
    },
    /** Shows the current selection's value again. */
    reset: () => {
      session.current = null;
      setText(latest.current);
    },
  };
}

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
  const edit = useEdit(shown, { value, min, max, allowEmpty, onCommit });
  const [error, setError] = useState<string | null>(null);
  // Escape blurs the field; the blur that follows must not commit what was typed.
  const cancelled = useRef(false);
  // A new value from outside (another selection, undo) clears an old complaint.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the shown value changes
  useEffect(() => {
    if (!edit.editing()) setError(null);
  }, [shown]);

  /** `leaving`: the field is going away (another selection); a bad value is dropped. */
  const commit = (leaving = false) => {
    if (cancelled.current) {
      cancelled.current = false;
      edit.reset();
      return;
    }
    const s = edit.take();
    if (!s) return; // nothing typed
    const t = s.target;
    if (s.draft.trim() === '' && t.allowEmpty) {
      if (t.value !== undefined) t.onCommit(undefined);
      if (leaving) return;
      setError(null);
      edit.reset();
      return;
    }
    const v = parseLength(s.draft);
    if (v === null || v < t.min || v > t.max) {
      if (leaving) return;
      setError(
        v === null
          ? 'Enter a length such as 2.5 m, 250 cm, 2500 mm or just 2500.'
          : `Between ${formatLength(t.min)} and ${formatLength(t.max)}.`,
      );
      edit.keep(s);
      return;
    }
    if (t.value === undefined || Math.abs(v - t.value) > 1e-9) t.onCommit(v);
    if (leaving) return;
    setError(null);
    edit.reset();
  };
  // An input removed while focused gets no blur: commit what was typed as it goes.
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(
    () => () => {
      try {
        commitRef.current(true);
      } catch {
        // the object went away with the field (merged, deleted): nothing to change
      }
    },
    [],
  );

  return (
    <Field label={label} hint={error ?? hint}>
      {(id, describedBy) => (
        <input
          id={id}
          className={`input num${error ? ' invalid' : ''}`}
          inputMode="decimal"
          value={edit.draft}
          placeholder={placeholder}
          aria-invalid={!!error}
          aria-describedby={describedBy}
          onChange={(e) => edit.type(e.target.value)}
          onBlur={() => commit()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              cancelled.current = true;
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
  const edit = useEdit(value, { value, onCommit });
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
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
  const commit = (leaving = false) => {
    const s = edit.take();
    if (cancelled.current) {
      cancelled.current = false;
    } else if (s) {
      const v = s.draft.trim();
      if (v && v !== s.target.value) s.target.onCommit(v);
    }
    if (!leaving) edit.reset();
  };
  // An input removed while focused gets no blur: commit what was typed as it goes.
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(
    () => () => {
      try {
        commitRef.current(true);
      } catch {
        // the object went away with the field (merged, deleted): nothing to change
      }
    },
    [],
  );
  return (
    <Field label={label}>
      {(id) => (
        <>
          <input
            id={id}
            ref={input}
            className="input"
            value={edit.draft}
            list={suggestions ? listId : undefined}
            autoComplete="off"
            onChange={(e) => edit.type(e.target.value)}
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
