import {
  BUDGET_CHOICES,
  COOKING_CHOICES,
  type DesignBrief,
  type Level,
  MOBILITY_CHOICES,
  type QuestionKey,
  STYLE_NAMES,
  StyleId,
  WALL_CHOICES,
  WFH_CHOICES,
  bedroomsOf,
  peopleOf,
  sleepingPlan,
} from '@dhd/core';
import { useState } from 'react';
import { icons } from '../../../ui/icons';
import { SWATCHES } from '../BriefDialog';

/**
 * The app's own questions as widgets (UX §6.5): steppers for who lives here, people chips per
 * bedroom for who sleeps where, chips for the rest, style cards. Free: the answer is recorded by
 * the app. Single-choice chips answer on tap; a widget of several controls has Done.
 */

export interface FactProps {
  k: QuestionKey;
  brief: DesignBrief;
  level: Level;
  /** Answered: the brief as it now is. */
  onDone: (b: DesignBrief) => void;
  /** Its Done button's words ("Done", "Save"). */
  doneLabel?: string;
  /** The first control gets focus (the next question of the same message). */
  autoFocus?: boolean;
}

function Stepper({
  label,
  value,
  max,
  onChange,
}: {
  label: string;
  value: number;
  max: number;
  onChange: (n: number) => void;
}) {
  return (
    <fieldset className="stepper brief-stepper talk-stepper" aria-label={label}>
      <span className="field-label">{label}</span>
      <button
        type="button"
        className="btn"
        aria-label={`Fewer: ${label}`}
        disabled={value <= 0}
        onClick={() => onChange(value - 1)}
      >
        {icons.minus}
      </button>
      <span className="num" aria-live="polite">
        {value}
      </span>
      <button
        type="button"
        className="btn"
        aria-label={`More: ${label}`}
        disabled={value >= max}
        onClick={() => onChange(value + 1)}
      >
        {icons.plus}
      </button>
    </fieldset>
  );
}

/** Chips answering on tap (a radio group: arrows move between them). */
function OneOf<T extends string | number>({
  label,
  choices,
  value,
  onPick,
  stacked = false,
  autoFocus,
}: {
  label: string;
  choices: { id: T; label: string; line?: string }[];
  value: T | null;
  onPick: (v: T) => void;
  stacked?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <div
      className={stacked ? 'talk-choices talk-choices-stacked' : 'talk-choices'}
      role="radiogroup"
      aria-label={label}
      onKeyDown={(e) => {
        if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
        const all = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
        const i = all.indexOf(document.activeElement as HTMLButtonElement);
        const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
        all[(i + step + all.length) % all.length]?.focus();
        e.preventDefault();
      }}
    >
      {choices.map((c, i) => (
        <button
          key={String(c.id)}
          type="button"
          // biome-ignore lint/a11y/useSemanticElements: chips that answer on tap, as a radio group
          role="radio"
          aria-checked={value === c.id}
          tabIndex={value === c.id || (value === null && i === 0) ? 0 : -1}
          className={c.line ? 'chip talk-chip-lined' : 'chip'}
          // biome-ignore lint/a11y/noAutofocus: the next question of the message, after an answer
          autoFocus={autoFocus && i === 0}
          onClick={() => onPick(c.id)}
        >
          <span>{c.label}</span>
          {c.line && <span className="talk-chip-line">{c.line}</span>}
        </button>
      ))}
    </div>
  );
}

function Who({ brief, onDone, doneLabel = 'Done', autoFocus }: FactProps) {
  const [b, setB] = useState(brief);
  const h = b.household;
  const set = (patch: Partial<DesignBrief['household']>) => {
    const next = { ...b, household: { ...h, ...patch } };
    // Someone taken off the household is taken out of who sleeps where and of the names.
    const keys = new Set(peopleOf(next).map((p) => p.key));
    const sleeping = Object.fromEntries(
      Object.entries(next.sleeping ?? {})
        .map(([id, ps]) => [id, ps.filter((k) => keys.has(k))] as const)
        .filter(([, ps]) => ps.length),
    );
    const names = Object.fromEntries(Object.entries(next.names ?? {}).filter(([k]) => keys.has(k)));
    setB({ ...next, sleeping, names });
  };
  const people = peopleOf(b);
  return (
    <div className="talk-widget">
      <div className="talk-steppers">
        <Stepper label="Adults" value={h.adults} max={12} onChange={(n) => set({ adults: n })} />
        <Stepper
          label="Children"
          value={h.children.length}
          max={12}
          onChange={(n) =>
            set({
              children: n > h.children.length ? [...h.children, 'primary'] : h.children.slice(0, n),
            })
          }
        />
        <Stepper
          label="Older parents"
          value={h.elders.length}
          max={6}
          onChange={(n) =>
            set({ elders: n > h.elders.length ? [...h.elders, 'walks'] : h.elders.slice(0, n) })
          }
        />
      </div>
      <label className="check-row">
        <input
          type="checkbox"
          checked={h.helper}
          onChange={(e) => set({ helper: e.target.checked })}
        />
        <span>Live-in helper</span>
      </label>
      {people.length > 0 && (
        <details className="talk-names">
          <summary>Names (optional)</summary>
          <div className="talk-names-grid">
            {people.map((p) => (
              <label key={p.key} className="field">
                <span className="field-label">{labelOf(p.key)}</span>
                <input
                  className="input"
                  maxLength={40}
                  value={b.names?.[p.key] ?? ''}
                  onChange={(e) => setB({ ...b, names: { ...b.names, [p.key]: e.target.value } })}
                />
              </label>
            ))}
          </div>
        </details>
      )}
      <div className="talk-widget-foot">
        <button
          type="button"
          className="btn btn-small"
          // biome-ignore lint/a11y/noAutofocus: the next question of the message
          autoFocus={autoFocus}
          onClick={() =>
            onDone({
              ...b,
              names: Object.fromEntries(
                Object.entries(b.names ?? {})
                  .map(([k, v]) => [k, v.trim()] as const)
                  .filter(([, v]) => v),
              ),
            })
          }
        >
          {doneLabel}
        </button>
      </div>
    </div>
  );
}

const labelOf = (key: string) =>
  key.startsWith('adult')
    ? `Adult ${key.slice(6)}`
    : key.startsWith('child')
      ? `Child ${key.slice(6)}`
      : key.startsWith('elder')
        ? `Older parent ${key.slice(6)}`
        : 'Helper';

function Sleeping({ brief, level, onDone, doneLabel = 'Done', autoFocus }: FactProps) {
  const [b, setB] = useState(brief);
  const rooms = bedroomsOf(level, b);
  const shelter = (id: string) => /shelter|bomb/i.test(level.rooms[id]?.name ?? '');
  const people = peopleOf(b);
  const plan = sleepingPlan(
    b,
    rooms.filter((r) => !shelter(r.id)),
  );
  const sleeping = b.sleeping ?? {};
  const said = Object.values(sleeping).some((ps) => ps.length);
  const inRoom = (key: string) =>
    said
      ? (Object.entries(sleeping).find(([, ps]) => ps.includes(key))?.[0] ?? null)
      : ([...plan.rooms].find(([, ps]) => ps.some((p) => p.key === key))?.[0] ?? null);
  const toggle = (roomId: string, key: string) => {
    // Starting from the guess, so a tap changes one person, not everyone.
    const from: Record<string, string[]> = said
      ? sleeping
      : Object.fromEntries([...plan.rooms].map(([id, ps]) => [id, ps.map((p) => p.key)]));
    const here = from[roomId]?.includes(key);
    const next = Object.fromEntries(
      Object.entries(from).map(([id, ps]) => [id, ps.filter((p) => p !== key)]),
    );
    if (!here) next[roomId] = [...(next[roomId] ?? []), key];
    setB({
      ...b,
      sleeping: Object.fromEntries(Object.entries(next).filter(([, ps]) => ps.length)),
    });
  };
  const unplaced = people.filter((p) => p.kind !== 'helper' && !inRoom(p.key));
  return (
    <div className="talk-widget">
      {rooms.map((r, i) => (
        // biome-ignore lint/a11y/useSemanticElements: a row of toggles named by its room
        <div key={r.id} className="talk-sleep-row" role="group" aria-label={r.name}>
          <span className="talk-sleep-room" aria-hidden="true">
            {r.name}
          </span>
          <span className="chip-row">
            {people
              .filter((p) => !shelter(r.id) || p.kind === 'helper')
              .map((p, j) => (
                <button
                  key={p.key}
                  type="button"
                  className="chip"
                  aria-pressed={inRoom(p.key) === r.id}
                  {...(!said && inRoom(p.key) === r.id ? { 'data-assumed': '' } : {})}
                  // biome-ignore lint/a11y/noAutofocus: the next question of the message
                  autoFocus={autoFocus && i === 0 && j === 0}
                  onClick={() => toggle(r.id, p.key)}
                >
                  {inRoom(p.key) === r.id && <span aria-hidden="true">✓ </span>}
                  {p.name}
                </button>
              ))}
          </span>
        </div>
      ))}
      <p className={unplaced.length ? 'field-hint negative' : 'field-hint'}>
        {unplaced.length
          ? `${unplaced.map((p) => p.name).join(' and ')} would have no bed. Tap where each of them sleeps: two can share a room, a bunk bed sleeps two.`
          : said
            ? 'Each of them gets a bed there, and the checks make sure.'
            : 'Dashed means my guess. Tap to change.'}
      </p>
      <div className="talk-widget-foot">
        <button
          type="button"
          className="btn btn-small"
          onClick={() => {
            // Done on the guess keeps the guess, said.
            const keep = said
              ? b
              : {
                  ...b,
                  sleeping: Object.fromEntries(
                    [...plan.rooms].map(([id, ps]) => [id, ps.map((p) => p.key)]),
                  ),
                };
            onDone(keep);
          }}
        >
          {doneLabel}
        </button>
      </div>
    </div>
  );
}

function Mobility({ brief, onDone, doneLabel = 'Done', autoFocus }: FactProps) {
  const [b, setB] = useState(brief);
  const elders = peopleOf(b).filter((p) => p.kind === 'elder');
  const pick = (i: number, v: DesignBrief['household']['elders'][number]) => {
    const next = {
      ...b,
      household: { ...b.household, elders: b.household.elders.map((e, j) => (j === i ? v : e)) },
    };
    if (elders.length === 1) onDone(next);
    else setB(next);
  };
  return (
    <div className="talk-widget">
      {elders.map((p, i) => (
        <div key={p.key} className="talk-field">
          {elders.length > 1 && <span className="field-label">{p.name}</span>}
          <OneOf
            label={`How ${p.name} gets about`}
            choices={MOBILITY_CHOICES}
            value={b.household.elders[i] ?? null}
            onPick={(v) => pick(i, v)}
            autoFocus={autoFocus && i === 0}
          />
        </div>
      ))}
      {elders.length > 1 && (
        <div className="talk-widget-foot">
          <button type="button" className="btn btn-small" onClick={() => onDone(b)}>
            {doneLabel}
          </button>
        </div>
      )}
    </div>
  );
}

function Style({ brief, onDone, autoFocus }: FactProps) {
  return (
    <div className="talk-styles" role="radiogroup" aria-label="Style">
      {(['designer', ...StyleId.options] as const).map((s, i) => (
        <button
          key={s}
          type="button"
          // biome-ignore lint/a11y/useSemanticElements: style cards that answer on tap
          role="radio"
          aria-checked={brief.style === s}
          className={brief.style === s ? 'talk-style on' : 'talk-style'}
          // biome-ignore lint/a11y/noAutofocus: the next question of the message
          autoFocus={autoFocus && i === 0}
          onClick={() => onDone({ ...brief, style: s })}
        >
          <span className="style-swatches" aria-hidden="true">
            {SWATCHES[s].map((c) => (
              <i key={c} style={{ background: c }} />
            ))}
          </span>
          <span>{s === 'designer' ? 'Let the designer choose' : STYLE_NAMES[s]}</span>
        </button>
      ))}
    </div>
  );
}

function Anything({ brief, onDone, doneLabel = 'Done', autoFocus }: FactProps) {
  const [text, setText] = useState(brief.household.text);
  return (
    <div className="talk-widget">
      <label className="field">
        <span className="visually-hidden">Anything to keep, or to know</span>
        <textarea
          className="input talk-note"
          rows={2}
          maxLength={1000}
          placeholder="The piano stays; Mdm Koh needs a chair to sit and stand from"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <div className="talk-widget-foot">
        <button
          type="button"
          className="chip"
          // biome-ignore lint/a11y/noAutofocus: the next question of the message
          autoFocus={autoFocus}
          onClick={() => onDone({ ...brief, household: { ...brief.household, text: '' } })}
        >
          Nothing to add
        </button>
        <button
          type="button"
          className="btn btn-small"
          disabled={!text.trim()}
          onClick={() => onDone({ ...brief, household: { ...brief.household, text: text.trim() } })}
        >
          {doneLabel}
        </button>
      </div>
    </div>
  );
}

/** The widget for one fact. */
export function FactEditor(p: FactProps) {
  const b = p.brief;
  switch (p.k) {
    case 'who':
      return <Who {...p} />;
    case 'sleeping':
      return <Sleeping {...p} />;
    case 'mobility':
      return <Mobility {...p} />;
    case 'cooking':
      return (
        <OneOf
          label="How you cook"
          choices={COOKING_CHOICES}
          value={b.lifestyle.cooking}
          onPick={(v) => p.onDone({ ...b, lifestyle: { ...b.lifestyle, cooking: v } })}
          autoFocus={p.autoFocus}
        />
      );
    case 'wfh':
      return (
        <OneOf
          label="Working from home"
          choices={WFH_CHOICES}
          value={b.lifestyle.wfh}
          onPick={(v) => p.onDone({ ...b, lifestyle: { ...b.lifestyle, wfh: v } })}
          autoFocus={p.autoFocus}
        />
      );
    case 'budget':
      return (
        <OneOf
          label="Budget"
          choices={BUDGET_CHOICES.map((c) => ({ id: c.id, label: c.label }))}
          value={
            BUDGET_CHOICES.find(
              (c) =>
                (c.v === null && b.budget === null) ||
                (c.v && b.budget && c.v.low === b.budget.low && c.v.high === b.budget.high),
            )?.id ?? null
          }
          onPick={(id) =>
            p.onDone({ ...b, budget: BUDGET_CHOICES.find((c) => c.id === id)?.v ?? null })
          }
          autoFocus={p.autoFocus}
        />
      );
    case 'walls':
      return (
        <OneOf
          label="Walls"
          stacked
          choices={WALL_CHOICES}
          value={b.walls}
          onPick={(v) => p.onDone({ ...b, walls: v })}
          autoFocus={p.autoFocus}
        />
      );
    case 'style':
      return <Style {...p} />;
    case 'anything':
      return <Anything {...p} />;
  }
}
