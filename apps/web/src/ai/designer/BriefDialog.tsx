import {
  type DesignBrief,
  type Level,
  type RoomUse,
  STYLE_NAMES,
  StyleId,
  defaultBrief,
  furnitureKind,
  isDesigned,
  runPrompts,
  spacesOf,
} from '@dhd/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useProject } from '../../store';
import { Segmented } from '../../ui/fields';
import { icons } from '../../ui/icons';
import { AiSettingsDialog } from '../AiSettingsDialog';
import { type AiSettings, useAi } from '../credentials';
import { WISHES } from '../layouts';
import { CostCheck } from './CostCheck';
import { contextFor, estimateFor } from './plan';
import { useSpend } from './spend';
import { getBrief, putBrief, startDesign } from './state';

/**
 * Design my flat: the brief (seven sections; a stepped sheet on a phone), then the cost
 * check in the same dialog. Remembered per plan in this browser. Enter never moves on.
 */

const CHILD = { baby: 'Baby', preschool: 'Preschool', primary: 'Primary', teen: 'Teen' } as const;
const ELDER = {
  walks: 'Walks unaided',
  stick: 'Uses a stick',
  frame: 'Uses a walking frame',
  wheelchair: 'Uses a wheelchair',
} as const;
const ELDER_SHORT = { walks: 'walks', stick: 'stick', frame: 'frame', wheelchair: 'wheelchair' };
const USE_NAMES: Record<RoomUse | 'keep' | 'designer', string> = {
  designer: 'Let the designer decide',
  keep: 'Keep as it is',
  master: 'Master bedroom',
  bedroom: 'Bedroom',
  kids: 'Kids’ room',
  parents: 'Parents’ room',
  guest: 'Guest or flexi room',
  study: 'Study',
  'walk-in': 'Walk-in wardrobe',
  living: 'Living',
  dining: 'Dining',
  kitchen: 'Kitchen',
  store: 'Store',
};
/** Three colours each style is known by, for its card. */
const SWATCHES: Record<StyleId | 'designer', [string, string, string]> = {
  designer: ['#e9e4dc', '#b9c3b0', '#4b4e52'],
  scandinavian: ['#f4f1ea', '#d9c8ad', '#8fa3ad'],
  japandi: ['#efe4d2', '#c49a6c', '#4b4e52'],
  'warm-modern': ['#f1e6d8', '#b8865b', '#6b4f3a'],
  minimalist: ['#f7f7f5', '#d6d6d2', '#2b2b2b'],
  industrial: ['#d9d6d0', '#7a6a58', '#3a3a3a'],
  luxe: ['#efe9e1', '#b89b5e', '#1f2a36'],
  heritage: ['#f2e8d8', '#7a3b2e', '#2f6f6a'],
};
const BUDGETS: { id: string; label: string; v: { low: number; high: number } | null }[] = [
  { id: 'u30', label: 'Under S$30k', v: { low: 15_000, high: 30_000 } },
  { id: '30-50', label: 'S$30–50k', v: { low: 30_000, high: 50_000 } },
  { id: '50-80', label: 'S$50–80k', v: { low: 50_000, high: 80_000 } },
  { id: 'o80', label: 'Over S$80k', v: { low: 80_000, high: 150_000 } },
  { id: 'unsure', label: 'Not sure', v: null },
];
const budgetId = (b: DesignBrief['budget']) =>
  b === null
    ? 'unsure'
    : (BUDGETS.find((x) => x.v && x.v.low === b.low && x.v.high === b.high)?.id ?? 'custom');

type SectionId = 'who' | 'live' | 'style' | 'budget' | 'keep' | 'rooms' | 'extras';
const SECTIONS: { id: SectionId; title: string }[] = [
  { id: 'who', title: 'Who lives here' },
  { id: 'live', title: 'How you live' },
  { id: 'style', title: 'Style' },
  { id: 'budget', title: 'Budget' },
  { id: 'keep', title: 'Keep' },
  { id: 'rooms', title: 'Room by room' },
  { id: 'extras', title: 'Extras' },
];

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function summaryOf(id: SectionId, b: DesignBrief, level: Level): string {
  const h = b.household;
  switch (id) {
    case 'who': {
      const parts = [plural(h.adults, 'adult')];
      if (h.children.length) parts.push(plural(h.children.length, 'child', 'children'));
      if (h.elders.length)
        parts.push(
          `${plural(h.elders.length, 'elder')}, ${h.elders.map((e) => ELDER_SHORT[e]).join(', ')}`,
        );
      if (h.helper) parts.push('helper');
      return parts.join(' · ');
    }
    case 'live':
      return [
        `Cooks ${b.lifestyle.cooking === 'light' ? 'lightly' : b.lifestyle.cooking}`,
        b.lifestyle.wfh ? `${b.lifestyle.wfh} working from home` : null,
        b.lifestyle.guests ? 'guests often' : null,
        b.wishes.length ? plural(b.wishes.length, 'wish', 'wishes') : null,
      ]
        .filter(Boolean)
        .join(' · ');
    case 'style':
      return b.style === 'designer' ? 'Let the designer choose' : STYLE_NAMES[b.style];
    case 'budget':
      return b.budget
        ? `S$${Math.round(b.budget.low / 1000)}–${Math.round(b.budget.high / 1000)}k`
        : 'Not sure';
    case 'keep':
      return {
        keep: 'Keep all walls',
        allowed: 'Walls HDB normally allows',
        structural: 'Structural changes too',
      }[b.walls];
    case 'rooms': {
      const set = Object.values(b.rooms).filter((r) => r.use !== 'designer' || r.wish).length;
      const n = Object.keys(level.rooms).filter((id) => isDesigned(level, id)).length;
      return set ? `${set} of ${n} rooms set` : 'The designer decides';
    }
    case 'extras':
      return [
        b.electrical ? 'Electrical points' : 'No electrical points',
        b.start === 'after' ? 'from your renovation' : 'from the flat as it is',
      ].join(' · ');
  }
}

/** True for a phone-sized screen (the brief becomes a stepped sheet). */
function useNarrow(px = 600): boolean {
  const q = `(max-width: ${px}px)`;
  const [narrow, setNarrow] = useState(() => window.matchMedia?.(q).matches ?? false);
  useEffect(() => {
    const m = window.matchMedia?.(q);
    if (!m) return;
    const on = () => setNarrow(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [q]);
  return narrow;
}

function Stepper({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
}) {
  return (
    <fieldset className="stepper brief-stepper" aria-label={label}>
      <span className="field-label">{label}</span>
      <button
        type="button"
        className="btn"
        aria-label={`Fewer: ${label}`}
        disabled={value <= min}
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

export function BriefDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const project = useProject();
  const ai = useAi();
  const [brief, setBriefState] = useState<DesignBrief>(() => ({
    ...defaultBrief(),
    start: project.renovation ? 'after' : 'before',
  }));
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState<Set<SectionId>>(new Set(['who', 'rooms']));
  const [stage, setStage] = useState<'brief' | 'cost'>('brief');
  const [step, setStep] = useState(0);
  const [settings, setSettings] = useState<null | 'key' | 'prices'>(null);
  const narrow = useNarrow();
  const { prices } = useSpend();

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  // The brief this plan had last time.
  useEffect(() => {
    let live = true;
    void getBrief(project.id).then((b) => {
      if (!live) return;
      if (b) setBriefState({ ...b, start: project.renovation ? b.start : 'before' });
      setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, [project.id, project.renovation]);
  const setBrief = (b: DesignBrief) => {
    setBriefState(b);
    void putBrief(project.id, b);
  };
  const close = () => ref.current?.close();

  const ctx = useMemo(() => contextFor(project, brief), [project, brief]);
  const level = ctx?.base;
  const est = useMemo(() => {
    if (!ai || !ctx || stage !== 'cost') return null;
    return estimateFor(ai, runPrompts(ctx, spacesOf(ctx.base), ctx.aliases), brief.quality, prices);
  }, [ai, ctx, brief.quality, prices, stage]);
  const rooms = level ? spacesOf(level).length : 0;

  if (!level) return null;
  const h = brief.household;
  const setHousehold = (patch: Partial<DesignBrief['household']>) =>
    setBrief({ ...brief, household: { ...h, ...patch } });
  const items = Object.values(level.items).filter((it) => furnitureKind(it.assetId));
  const designedRooms = Object.values(level.rooms).filter((r) => isDesigned(level, r.id));

  const section = (id: SectionId) => {
    switch (id) {
      case 'who':
        return (
          <div className="brief-fields">
            <Stepper
              label="Adults"
              value={h.adults}
              min={0}
              max={12}
              onChange={(n) => setHousehold({ adults: n })}
            />
            <Stepper
              label="Children"
              value={h.children.length}
              min={0}
              max={12}
              onChange={(n) =>
                setHousehold({
                  children:
                    n > h.children.length ? [...h.children, 'primary'] : h.children.slice(0, n),
                })
              }
            />
            {h.children.map((c, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: children are by position
              <label key={i} className="field brief-sub">
                <span className="field-label">Child {i + 1}</span>
                <select
                  className="input"
                  value={c}
                  onChange={(e) =>
                    setHousehold({
                      children: h.children.map((x, j) =>
                        j === i ? (e.target.value as typeof c) : x,
                      ),
                    })
                  }
                >
                  {Object.entries(CHILD).map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            <Stepper
              label="Elderly"
              value={h.elders.length}
              min={0}
              max={6}
              onChange={(n) =>
                setHousehold({
                  elders: n > h.elders.length ? [...h.elders, 'walks'] : h.elders.slice(0, n),
                })
              }
            />
            {h.elders.map((e, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: elders are by position
              <label key={i} className="field brief-sub">
                <span className="field-label">Elder {i + 1}</span>
                <select
                  className="input"
                  value={e}
                  onChange={(ev) =>
                    setHousehold({
                      elders: h.elders.map((x, j) => (j === i ? (ev.target.value as typeof e) : x)),
                    })
                  }
                >
                  {Object.entries(ELDER).map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            <label className="check-row">
              <input
                type="checkbox"
                checked={h.helper}
                onChange={(e) => setHousehold({ helper: e.target.checked })}
              />
              <span>Live-in helper</span>
            </label>
            <label className="field">
              <span className="field-label">Pets</span>
              <input
                className="input"
                maxLength={200}
                placeholder="e.g. a cat"
                value={h.pets}
                onChange={(e) => setHousehold({ pets: e.target.value })}
              />
            </label>
            <label className="field">
              <span className="field-label">Anything else about you</span>
              <input
                className="input"
                maxLength={1000}
                placeholder="e.g. a couple with a toddler, working from home"
                value={h.text}
                onChange={(e) => setHousehold({ text: e.target.value })}
              />
            </label>
          </div>
        );
      case 'live':
        return (
          <div className="brief-fields">
            <div className="field">
              <span className="field-label">Work from home</span>
              <Segmented
                label="Work from home"
                fill
                value={String(brief.lifestyle.wfh) as '0' | '1' | '2'}
                onChange={(v) =>
                  setBrief({
                    ...brief,
                    lifestyle: { ...brief.lifestyle, wfh: Number(v) as 0 | 1 | 2 },
                  })
                }
                options={[
                  { value: '0', label: 'No one' },
                  { value: '1', label: 'One person' },
                  { value: '2', label: 'Two people' },
                ]}
              />
            </div>
            <div className="field">
              <span className="field-label">Cooking</span>
              <Segmented
                label="Cooking"
                fill
                value={brief.lifestyle.cooking}
                onChange={(v) =>
                  setBrief({ ...brief, lifestyle: { ...brief.lifestyle, cooking: v } })
                }
                options={[
                  { value: 'light', label: 'Light' },
                  { value: 'daily', label: 'Daily' },
                  { value: 'heavy', label: 'Heavy' },
                ]}
              />
              {brief.lifestyle.cooking === 'heavy' && (
                <span className="field-hint">
                  The kitchen stays closable: a glass sliding door rather than fully open.
                </span>
              )}
            </div>
            <label className="check-row">
              <input
                type="checkbox"
                checked={brief.lifestyle.guests}
                onChange={(e) =>
                  setBrief({
                    ...brief,
                    lifestyle: { ...brief.lifestyle, guests: e.target.checked },
                  })
                }
              />
              <span>We often have guests</span>
            </label>
            <fieldset className="wish-list">
              <legend className="field-label">You’d like</legend>
              {WISHES.map((w) => (
                <label key={w} className="check-row">
                  <input
                    type="checkbox"
                    checked={brief.wishes.includes(w)}
                    onChange={(e) =>
                      setBrief({
                        ...brief,
                        wishes: e.target.checked
                          ? [...brief.wishes, w]
                          : brief.wishes.filter((x) => x !== w),
                      })
                    }
                  />
                  <span>{w}</span>
                </label>
              ))}
            </fieldset>
          </div>
        );
      case 'style':
        return (
          <div className="brief-fields">
            <div className="style-cards" role="radiogroup" aria-label="Style">
              {(['designer', ...StyleId.options] as const).map((s) => (
                <label key={s} className={brief.style === s ? 'style-card on' : 'style-card'}>
                  <input
                    type="radio"
                    name="brief-style"
                    className="visually-hidden"
                    checked={brief.style === s}
                    onChange={() => setBrief({ ...brief, style: s })}
                  />
                  <span className="style-swatches" aria-hidden="true">
                    {SWATCHES[s].map((c) => (
                      <i key={c} style={{ background: c }} />
                    ))}
                  </span>
                  <span className="style-name">
                    {s === 'designer' ? 'Let the designer choose' : STYLE_NAMES[s].split(' (')[0]}
                    {s === 'heritage' && (
                      <span className="style-note">Rosewood and Peranakan accents</span>
                    )}
                  </span>
                </label>
              ))}
            </div>
            <label className="field">
              <span className="field-label">Colours you like or don’t</span>
              <input
                className="input"
                maxLength={300}
                placeholder="e.g. no dark colours, love sage"
                value={brief.colours}
                onChange={(e) => setBrief({ ...brief, colours: e.target.value })}
              />
            </label>
          </div>
        );
      case 'budget': {
        const id = budgetId(brief.budget);
        return (
          <div className="brief-fields">
            <fieldset className="radio-list">
              <legend className="field-label">
                Renovation budget (hacking, carpentry, floors, paint, electrical)
              </legend>
              {[
                ...BUDGETS,
                { id: 'custom', label: 'Custom', v: brief.budget ?? { low: 40_000, high: 60_000 } },
              ].map((b) => (
                <label key={b.id} className="check-row">
                  <input
                    type="radio"
                    name="brief-budget"
                    checked={id === b.id}
                    onChange={() => setBrief({ ...brief, budget: b.v })}
                  />
                  <span>{b.label}</span>
                </label>
              ))}
            </fieldset>
            {id === 'custom' && brief.budget && (
              <div className="field-row">
                {(['low', 'high'] as const).map((k) => (
                  <label key={k} className="field">
                    <span className="field-label">{k === 'low' ? 'From S$' : 'To S$'}</span>
                    <input
                      className="input num"
                      inputMode="numeric"
                      value={String(brief.budget?.[k] ?? '')}
                      onChange={(e) => {
                        const v = Math.max(0, Number(e.target.value.replace(/[^\d]/g, '')) || 0);
                        if (brief.budget)
                          setBrief({ ...brief, budget: { ...brief.budget, [k]: v } });
                      }}
                    />
                  </label>
                ))}
              </div>
            )}
            <p className="field-hint">Loose furniture isn’t priced.</p>
          </div>
        );
      }
      case 'keep':
        return (
          <div className="brief-fields">
            <fieldset className="radio-list">
              <legend className="field-label">Walls</legend>
              {(
                [
                  ['keep', 'Keep all walls'],
                  ['allowed', 'Change walls HDB normally allows'],
                  ['structural', 'Also suggest structural changes (needs HDB approval)'],
                ] as const
              ).map(([v, l]) => (
                <label key={v} className="check-row">
                  <input
                    type="radio"
                    name="brief-walls"
                    checked={brief.walls === v}
                    onChange={() => setBrief({ ...brief, walls: v })}
                  />
                  <span>{l}</span>
                </label>
              ))}
            </fieldset>
            {items.length > 0 && (
              <div className="field">
                <span className="field-label">Furniture in the flat</span>
                <ul className="brief-keep-list">
                  {items.map((it) => {
                    const k = brief.keep.items[it.id];
                    return (
                      <li key={it.id}>
                        <span>{furnitureKind(it.assetId)?.name ?? 'Piece'}</span>
                        <select
                          className="input"
                          aria-label={`${furnitureKind(it.assetId)?.name ?? 'Piece'}: keep?`}
                          value={k ?? 'leave'}
                          onChange={(e) => {
                            const next = { ...brief.keep.items };
                            if (e.target.value === 'leave') delete next[it.id];
                            else next[it.id] = e.target.value as 'bring' | 'in-place';
                            setBrief({ ...brief, keep: { ...brief.keep, items: next } });
                          }}
                        >
                          <option value="leave">Leave out</option>
                          <option value="bring">Bring along</option>
                          <option value="in-place">Keep where it is</option>
                        </select>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
            <label className="field">
              <span className="field-label">Anything else to keep</span>
              <input
                className="input"
                maxLength={1000}
                value={brief.keep.text}
                onChange={(e) =>
                  setBrief({ ...brief, keep: { ...brief.keep, text: e.target.value } })
                }
              />
            </label>
          </div>
        );
      case 'rooms':
        return (
          <ul className="brief-rooms">
            {designedRooms.map((r) => {
              const v = brief.rooms[r.id] ?? { use: 'designer' as const, wish: '' };
              const set = (patch: Partial<typeof v>) =>
                setBrief({ ...brief, rooms: { ...brief.rooms, [r.id]: { ...v, ...patch } } });
              return (
                <li key={r.id}>
                  <span className="brief-room-name">{r.name}</span>
                  <select
                    className="input"
                    aria-label={`${r.name}: use`}
                    value={v.use}
                    onChange={(e) => set({ use: e.target.value as typeof v.use })}
                  >
                    {Object.entries(USE_NAMES).map(([u, l]) => (
                      <option key={u} value={u}>
                        {l}
                      </option>
                    ))}
                  </select>
                  <input
                    className="input"
                    maxLength={200}
                    aria-label={`${r.name}: a wish`}
                    placeholder="A wish for this room"
                    value={v.wish}
                    onChange={(e) => set({ wish: e.target.value })}
                  />
                </li>
              );
            })}
          </ul>
        );
      case 'extras':
        return (
          <div className="brief-fields">
            <label className="check-row">
              <input
                type="checkbox"
                checked={brief.electrical}
                onChange={(e) => setBrief({ ...brief, electrical: e.target.checked })}
              />
              <span>Add suggested electrical points</span>
            </label>
            {project.renovation && (
              <div className="field">
                <span className="field-label">Start from</span>
                <Segmented
                  label="Start from"
                  fill
                  value={brief.start}
                  onChange={(v) => setBrief({ ...brief, start: v })}
                  options={[
                    { value: 'after', label: 'Your renovation' },
                    { value: 'before', label: 'The flat as it is' },
                  ]}
                />
              </div>
            )}
          </div>
        );
    }
  };

  const toCost = () => {
    if (!ai) {
      setSettings('key');
      return;
    }
    setStage('cost');
  };
  const start = (a: AiSettings) => {
    void putBrief(project.id, brief);
    startDesign(a, brief, est?.usd?.typical ?? null);
    close();
  };
  const current = SECTIONS[step] ?? SECTIONS[0];

  return (
    <dialog
      ref={ref}
      className="dialog brief-dialog"
      aria-labelledby="brief-h"
      onClose={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => {
        // Enter never moves the brief on (nor starts a run).
        if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') e.preventDefault();
      }}
    >
      <header className="dialog-head">
        <h2 id="brief-h">{stage === 'cost' ? 'Check the cost' : 'Design my flat'}</h2>
        <button type="button" className="icon-btn" aria-label="Close" onClick={close}>
          {icons.close}
        </button>
      </header>
      {stage === 'cost' && ai && est ? (
        <CostCheck
          ai={ai}
          est={est}
          quality={brief.quality}
          onQuality={(q) => setBrief({ ...brief, quality: q })}
          what={`one for the layout and style, then one for each of ${plural(rooms, 'room')}`}
          action="Design my flat"
          anyway="Design anyway"
          onBack={() => setStage('brief')}
          onStart={() => start(ai)}
          onEditPrices={() => setSettings('prices')}
        />
      ) : narrow ? (
        <>
          <div className="dialog-body brief-body">
            <p className="brief-step-count">
              {step + 1} of {SECTIONS.length}
            </p>
            <h3 className="brief-step-title">{current?.title}</h3>
            {current && section(current.id)}
          </div>
          <footer className="dialog-foot brief-foot">
            <div className="button-row brief-step-row">
              <button
                type="button"
                className="btn"
                disabled={step === 0}
                onClick={() => setStep(step - 1)}
              >
                Back
              </button>
              <button type="button" className="link-btn" onClick={toCost}>
                Check the cost
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => (step < SECTIONS.length - 1 ? setStep(step + 1) : toCost())}
              >
                Next
              </button>
            </div>
          </footer>
        </>
      ) : (
        <>
          <div className="dialog-body brief-body">
            {SECTIONS.map((s) => {
              const isOpen = open.has(s.id);
              return (
                <section key={s.id} className={isOpen ? 'brief-section open' : 'brief-section'}>
                  <h3>
                    <button
                      type="button"
                      className="brief-toggle"
                      aria-expanded={isOpen}
                      aria-controls={`brief-${s.id}`}
                      onClick={() => {
                        const next = new Set(open);
                        if (isOpen) next.delete(s.id);
                        else next.add(s.id);
                        setOpen(next);
                      }}
                    >
                      <span className="brief-title">{s.title}</span>
                      <span className="brief-summary">{summaryOf(s.id, brief, level)}</span>
                      <span className="brief-chevron" aria-hidden="true">
                        {icons.chevronDown}
                      </span>
                    </button>
                  </h3>
                  {isOpen && (
                    <div id={`brief-${s.id}`} className="brief-panel">
                      {section(s.id)}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
          <footer className="dialog-foot brief-foot">
            <p className="field-hint">{loaded ? 'Saved for this plan.' : ''}</p>
            <div className="button-row">
              <button type="button" className="btn" onClick={close}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" onClick={toCost}>
                Next: check the cost
              </button>
            </div>
          </footer>
        </>
      )}
      {settings && (
        <AiSettingsDialog
          {...(settings === 'prices' ? { focus: 'prices' as const } : {})}
          onClose={() => {
            const was = settings;
            setSettings(null);
            // A key saved from Next: on to the cost.
            if (was === 'key') setStage('cost');
          }}
        />
      )}
    </dialog>
  );
}
