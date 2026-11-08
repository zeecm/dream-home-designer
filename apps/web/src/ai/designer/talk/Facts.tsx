import {
  BUDGET_CHOICES,
  COOKING_CHOICES,
  type DesignBrief,
  type Level,
  MOBILITY_CHOICES,
  OWNS_CHOICES,
  type QuestionKey,
  STYLE_NAMES,
  StyleId,
  WALL_CHOICES,
  WFH_CHOICES,
  bedroomCandidates,
  bedroomsOf,
  guessSleeping,
  peopleOf,
  personLabel,
} from '@dhd/core';
import { useState } from 'react';
import { icons } from '../../../ui/icons';
import { SWATCHES } from '../BriefDialog';
import { Mark } from './Mark';
import { focusInLog } from './scroll';

/** "You, Partner, Child 1 and Child 2" (N4). */
const andList = (xs: string[]) =>
  xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;

/**
 * The app's own questions as widgets (UX §6.5): steppers for who lives here, people chips per
 * bedroom for who sleeps where, chips for the rest, style cards. Free: the answer is recorded by
 * the app. Single-choice chips answer on tap; a widget of several controls has Done.
 */

export interface FactProps {
  k: QuestionKey;
  brief: DesignBrief;
  level: Level;
  /**
   * Answered: how the brief changes. Applied to the brief as it is when it is recorded, so a
   * widget never writes back what another answer changed meanwhile.
   */
  onDone: (update: (b: DesignBrief) => DesignBrief) => void;
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
        focusInLog(all[(i + step + all.length) % all.length]);
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
                <span className="field-label">
                  {personLabel({ ...p, name: '' }, { ...b, names: {} })}
                </span>
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
          onClick={() => {
            const names = Object.fromEntries(
              Object.entries(b.names ?? {})
                .map(([k, v]) => [k, v.trim()] as const)
                .filter(([, v]) => v),
            );
            onDone((cur) => {
              // Who sleeps where keeps only people still in the household.
              const keys = new Set(peopleOf({ ...cur, household: b.household }).map((x) => x.key));
              const sleeping = Object.fromEntries(
                Object.entries(cur.sleeping ?? {})
                  .map(([id, ps]) => [id, ps.filter((k) => keys.has(k))] as const)
                  .filter(([, ps]) => ps.length),
              );
              return { ...cur, household: b.household, names, sleeping };
            });
          }}
        >
          {doneLabel}
        </button>
      </div>
    </div>
  );
}

function Sleeping({ brief, level, onDone, doneLabel = 'Done', autoFocus }: FactProps) {
  // A plan with no bedrooms: first, which rooms people sleep in (marked as bedrooms).
  const [marked, setMarked] = useState<string[]>([]);
  const none = bedroomsOf(level, brief).filter((r) => !/shelter|bomb/i.test(r.name)).length === 0;
  const b: DesignBrief = marked.length
    ? {
        ...brief,
        rooms: {
          ...brief.rooms,
          ...Object.fromEntries(
            marked.map((id) => [
              id,
              { use: 'bedroom' as const, wish: brief.rooms[id]?.wish ?? '' },
            ]),
          ),
        },
      }
    : brief;
  const rooms = bedroomsOf(level, b);
  const shelter = (id: string) => /shelter|bomb/i.test(level.rooms[id]?.name ?? '');
  const people = peopleOf(b);
  // What was said, else a guess that places everyone (shown dashed until tapped or Done).
  const said0 = Object.values(b.sleeping ?? {}).some((ps) => ps.length);
  const [mine, setMine] = useState<Record<string, string[]> | null>(
    said0 ? (b.sleeping ?? {}) : null,
  );
  const said = mine !== null;
  const sleeping = mine ?? guessSleeping(b, level);
  const inRoom = (key: string) =>
    Object.entries(sleeping).find(([, ps]) => ps.includes(key))?.[0] ?? null;
  const toggle = (roomId: string, key: string) => {
    // Starting from the guess, so a tap changes one person, not everyone.
    const here = sleeping[roomId]?.includes(key);
    const next = Object.fromEntries(
      Object.entries(sleeping).map(([id, ps]) => [id, ps.filter((p) => p !== key)]),
    );
    if (!here) next[roomId] = [...(next[roomId] ?? []), key];
    setMine(Object.fromEntries(Object.entries(next).filter(([, ps]) => ps.length)));
  };
  const unplaced = people.filter((p) => p.kind !== 'helper' && !inRoom(p.key));
  const candidates = none ? bedroomCandidates(level) : [];
  return (
    <div className="talk-widget">
      {none && (
        <>
          <p className="field-hint negative">
            {candidates.length
              ? 'Your plan has no room named as a bedroom. Which rooms do people sleep in?'
              : 'Your plan has no room people could sleep in. Draw or rename a bedroom on the plan, then ask me again.'}
          </p>
          {candidates.length > 0 && (
            // biome-ignore lint/a11y/useSemanticElements: a row of toggles
            <div className="chip-row" role="group" aria-label="Rooms people sleep in">
              {candidates.map((r, i) => (
                <button
                  key={r.id}
                  type="button"
                  className="chip"
                  aria-pressed={marked.includes(r.id)}
                  // biome-ignore lint/a11y/noAutofocus: the next question of the message
                  autoFocus={autoFocus && i === 0}
                  onClick={() =>
                    setMarked((m) =>
                      m.includes(r.id) ? m.filter((x) => x !== r.id) : [...m, r.id],
                    )
                  }
                >
                  {marked.includes(r.id) && <Mark kind="check" />}
                  {r.name}
                </button>
              ))}
            </div>
          )}
        </>
      )}
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
                  {inRoom(p.key) === r.id && <Mark kind="check" />}
                  {personLabel(p, b)}
                </button>
              ))}
          </span>
        </div>
      ))}
      <p className={unplaced.length ? 'field-hint negative' : 'field-hint'}>
        {!rooms.length
          ? `${andList(unplaced.map((p) => personLabel(p, b)))} would have no bed.`
          : unplaced.length
            ? `${andList(unplaced.map((p) => personLabel(p, b)))} would have no bed. Tap where each of them sleeps: two can share a room, a bunk bed sleeps two.`
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
            const final = sleeping;
            const bedrooms = b.rooms;
            onDone((cur) => ({
              ...cur,
              sleeping: final,
              rooms: marked.length ? { ...cur.rooms, ...bedrooms } : cur.rooms,
            }));
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
    const elderList = next.household.elders;
    if (elders.length === 1) {
      onDone((cur) => ({ ...cur, household: { ...cur.household, elders: elderList } }));
    } else setB(next);
  };
  return (
    <div className="talk-widget">
      {elders.map((p, i) => (
        <div key={p.key} className="talk-field">
          {elders.length > 1 && <span className="field-label">{personLabel(p, b)}</span>}
          <OneOf
            label={`How ${personLabel(p, b)} gets about`}
            choices={MOBILITY_CHOICES}
            value={b.household.elders[i] ?? null}
            onPick={(v) => pick(i, v)}
            autoFocus={autoFocus && i === 0}
          />
        </div>
      ))}
      {elders.length > 1 && (
        <div className="talk-widget-foot">
          <button
            type="button"
            className="btn btn-small"
            onClick={() =>
              onDone((cur) => ({
                ...cur,
                household: { ...cur.household, elders: b.household.elders },
              }))
            }
          >
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
          onClick={() => onDone((cur) => ({ ...cur, style: s }))}
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
          onClick={() => onDone((cur) => ({ ...cur, household: { ...cur.household, text: '' } }))}
        >
          Nothing to add
        </button>
        <button
          type="button"
          className="btn btn-small"
          disabled={!text.trim()}
          onClick={() => {
            const t = text.trim();
            onDone((cur) => ({ ...cur, household: { ...cur.household, text: t } }));
          }}
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
          onPick={(v) => p.onDone((c) => ({ ...c, lifestyle: { ...c.lifestyle, cooking: v } }))}
          autoFocus={p.autoFocus}
        />
      );
    case 'wfh':
      return (
        <OneOf
          label="Working from home"
          choices={WFH_CHOICES}
          value={b.lifestyle.wfh}
          onPick={(v) => p.onDone((c) => ({ ...c, lifestyle: { ...c.lifestyle, wfh: v } }))}
          autoFocus={p.autoFocus}
        />
      );
    case 'owns':
      return (
        <OneOf
          label="How much you own"
          choices={OWNS_CHOICES}
          value={b.owns ?? 'typical'}
          // One value with the storage meter's own setting (useTalk keeps the two in step).
          onPick={(v) => p.onDone((c) => ({ ...c, owns: v }))}
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
            p.onDone((c) => ({ ...c, budget: BUDGET_CHOICES.find((x) => x.id === id)?.v ?? null }))
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
          onPick={(v) => p.onDone((c) => ({ ...c, walls: v }))}
          autoFocus={p.autoFocus}
        />
      );
    case 'style':
      return <Style {...p} />;
    case 'anything':
      return <Anything {...p} />;
  }
}
