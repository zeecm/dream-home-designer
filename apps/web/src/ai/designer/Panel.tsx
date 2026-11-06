import {
  type Aspect,
  BATHROOMS,
  type Design,
  type DesignResult,
  type Lock,
  type RunEstimate,
  type StepPrompt,
  aspectOf,
  lockCovers,
  renovationChanges,
  roomIdAt,
  usageTotals,
} from '@dhd/core';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useEditor } from '../../editor';
import { useProject } from '../../store';
import { icons } from '../../ui/icons';
import { AiSettingsDialog } from '../AiSettingsDialog';
import { useAi } from '../credentials';
import { AcceptDialog } from './AcceptDialog';
import { CostCheck } from './CostCheck';
import { showPoint, showRoom } from './focus';
import {
  ASPECT_NAMES,
  type ChangeRequest,
  ROOM_ASPECTS,
  baseOf,
  changeFrom,
  changePlan,
  changedText,
  contextFor,
  estimateFor,
  heldRows,
  needsCostCheck,
  onPlanNow,
  planChanged,
  plannedPrompts,
  resultFor,
} from './plan';
import { type RunState, type StepState, progressOf } from './run';
import { capUsd, priceTable, spent, tokens, usd, useSpend } from './spend';
import {
  type Running,
  acceptedNow,
  answerPause,
  changeDesign,
  closePanel,
  deleteDesign,
  designOpts,
  finishDesign,
  finishPlan,
  openCompare,
  selectDesign,
  stopRun,
  useDesigner,
} from './state';
import { designerCannotUse } from './stream';
import { byRoom, fixedNotes, humanize, problemRoom } from './words';

/**
 * The Designer panel: the run as it goes (steps, the meter, Stop), then the versions (tabs
 * and the selected one's card), Change something, and Accept. Selecting a version shows it
 * on the plan. In the details column (360 px), a bottom sheet below 1100 px.
 */

/** A tablet held upright or a phone (not one on its side): the panel is a sheet. */
const SHEET_Q = '(max-width: 900px)';
const SIDE_Q = '(pointer: coarse) and (max-height: 500px)';
const sheetNow = () =>
  !!window.matchMedia?.(SHEET_Q).matches && !window.matchMedia?.(SIDE_Q).matches;
function useDesignerSheet(): boolean {
  const [on, setOn] = useState(sheetNow);
  useEffect(() => {
    const a = window.matchMedia?.(SHEET_Q);
    const b = window.matchMedia?.(SIDE_Q);
    const change = () => setOn(sheetNow());
    a?.addEventListener('change', change);
    b?.addEventListener('change', change);
    return () => {
      a?.removeEventListener('change', change);
      b?.removeEventListener('change', change);
    };
  }, []);
  return on;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
const isStopped = (d: Design) =>
  Object.values(d.spaces).some((s) => s.status === 'cancelled' || s.status === 'skipped');
const tabName = (d: Design, accepted: boolean) =>
  `V${d.n}${accepted ? ', accepted' : ''}${isStopped(d) ? ', stopped' : ''}`;

/** A version on the plan as it is now, worked out once per version and plan. */
export function useResult(d: Design | undefined): DesignResult | null {
  const project = useProject();
  const designs = useDesigner((st) => st.designs);
  return useMemo(
    () => (d ? resultFor(project, onPlanNow(d, designs, project), designOpts(project)) : null),
    [project, d, designs],
  );
}

function duration(ms: number) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

function Glyph({ status }: { status: StepState['status'] | 'local' }) {
  const text = {
    waiting: 'Waiting',
    running: 'Running',
    done: 'Done',
    local: 'Done',
    failed: 'Failed',
    cancelled: 'Cut off',
    skipped: 'Not run',
  }[status];
  return (
    <span className={`step-glyph step-${status}`} title={text}>
      <span aria-hidden="true">
        {status === 'done' || status === 'local'
          ? '✓'
          : status === 'failed'
            ? '!'
            : status === 'running'
              ? ''
              : status === 'waiting'
                ? ''
                : '–'}
      </span>
      <span className="visually-hidden">{text}: </span>
    </span>
  );
}

function RunView({ run, live }: { run: Running; live: boolean }) {
  const s = run.state;
  const totals = usageTotals(s.usage);
  const requests = s.steps.length;
  const current = s.steps.findIndex((x) => x.status === 'running');
  const running = s.steps[current];
  const estimated = s.steps.some((x) => x.status === 'running') || totals.estimated;
  const spentRun = totals.usd ?? 0;
  const done = s.steps.filter((x) => x.status === 'done').length;
  const cut = s.steps.filter((x) => x.status === 'cancelled');
  const cutOffN = cut.length;
  const cutOff = cut.reduce((t, x) => t + (x.cutOffHigh ?? 0), 0);
  const phaseLine =
    live && running
      ? `Step ${progressOf(s).step} of ${progressOf(s).of}: ${running.label}…`
      : s.phase === 'paused'
        ? 'Paused at your limit for this tab.'
        : null;
  const steps = (
    <ol className="designer-steps">
      <li className="step-row">
        <Glyph status="local" />
        <span className="step-label">Reading your plan</span>
      </li>
      {s.steps.map((st) => (
        <li key={st.key} className={`step-row step-row-${st.status}`}>
          <Glyph status={st.status} />
          <span className="step-label">
            {st.label}
            {st.wait && (
              <span className="step-note">
                {' '}
                Waiting {st.wait.seconds} s ({st.wait.attempt} of 2)
              </span>
            )}
          </span>
          <span className="step-tokens num">
            {st.tokens ? `${st.estimated ? '~' : ''}${tokens(st.tokens)}` : ''}
          </span>
          {st.status === 'running' && st.thinking && (
            <span className="step-thinking" aria-hidden="true">
              {st.thinking}
            </span>
          )}
          {st.status === 'failed' && st.error && <span className="step-error">{st.error}</span>}
        </li>
      ))}
      <li className={`step-row step-row-${s.phase === 'done' ? 'local' : 'waiting'}`}>
        <Glyph
          status={s.phase === 'done' ? 'local' : s.phase === 'running' ? 'waiting' : 'skipped'}
        />
        <span className="step-label">Checking clearances, walkways, delivery and cost</span>
      </li>
    </ol>
  );
  return (
    <section className="designer-run" aria-label="This run">
      <div className="designer-meter">
        <p className="num">
          {estimated ? '~' : ''}
          {tokens(totals.tokens)} tokens · {totals.usd === null ? 'no price' : usd(spentRun)}
          {run.estimate !== null && ` of ~${usd(run.estimate)}`}
        </p>
        <div className="designer-bar-track" aria-hidden="true">
          <span
            style={{
              width: `${run.estimate ? Math.min(100, (spentRun / run.estimate) * 100) : 0}%`,
            }}
          />
        </div>
      </div>
      {phaseLine && <p className="designer-phase">{phaseLine}</p>}
      {live ? (
        steps
      ) : (
        // Once the run has ended its steps fold away: the versions get the room.
        <details className="designer-steps-fold">
          <summary>
            Steps ({done} of {requests} done)
          </summary>
          {steps}
        </details>
      )}
      {!live && s.phase === 'done' && (
        <p className="designer-outcome">
          Done in {duration((s.endedAt ?? Date.now()) - s.startedAt)} · {tokens(totals.tokens)}{' '}
          tokens{totals.cached ? ` (${tokens(totals.cached)} from cache)` : ''}
          {totals.usd !== null ? ` · ${usd(totals.usd)}` : ''}.
          {done < requests && ` ${plural(requests - done, 'step')} not designed.`}
        </p>
      )}
      {!live && s.phase === 'stopped' && (
        <p className="designer-outcome">
          Stopped. Kept {done} of {requests} steps.
          {cutOff > 0 &&
            ` The ${cutOffN === 1 ? 'step' : 'steps'} cut off may still be billed (up to about ${usd(cutOff)}).`}
          {cutOff === 0 && cutOffN > 0 && ' The step cut off may still be billed.'}
        </p>
      )}
      {!live && s.phase === 'failed' && (
        <p className="notice-warning">
          The layout and style step didn’t work, so there is no version. {s.steps[0]?.error ?? ''}{' '}
          {totals.usd ? `${usd(totals.usd)} was spent.` : ''}
        </p>
      )}
    </section>
  );
}

function HaltNotice({
  halt,
  onSettings,
}: { halt: NonNullable<RunState['halt']>; onSettings: () => void }) {
  return (
    <div className="notice-warning designer-halt" role="alert">
      <span>{halt.message}</span>
      {halt.kind === 'key' && (
        <button type="button" className="link-btn" onClick={onSettings}>
          AI settings
        </button>
      )}
    </div>
  );
}

/** The confirm at the tab's limit: neither button is focused for you. */
function PauseDialog({ run }: { run: Running }) {
  const ref = useRef<HTMLDialogElement>(null);
  const head = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    head.current?.focus();
  }, []);
  const cap = capUsd();
  const spentRun = run.state.usage.reduce((t, u) => t + (u.usd ?? 0), 0);
  return (
    <dialog
      ref={ref}
      className="dialog dialog-confirm"
      aria-labelledby="pause-h"
      onCancel={(e) => {
        e.preventDefault();
        answerPause(false);
      }}
    >
      <div className="dialog-head">
        <h2 id="pause-h" ref={head} tabIndex={-1}>
          You’ve reached your {cap === null ? '' : usd(cap)} limit for this tab
        </h2>
      </div>
      <div className="confirm-body">
        <p>
          The design has spent {usd(spentRun)} so far.
          {run.remaining !== null && ` Finishing it takes about ${usd(run.remaining)} more.`}
        </p>
      </div>
      <footer className="dialog-foot">
        <div className="button-row">
          <button type="button" className="btn" onClick={() => answerPause(false)}>
            Stop here, keep what’s done
          </button>
          <button type="button" className="btn btn-primary" onClick={() => answerPause(true)}>
            Finish the design
          </button>
        </div>
      </footer>
    </dialog>
  );
}

/** A cost check on its own, before a change or a Finish that needs one. */
function CostDialog({
  title,
  est,
  what,
  action,
  onStart,
  onClose,
}: {
  title: string;
  est: RunEstimate;
  what: string;
  action: string;
  onStart: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const ai = useAi();
  const [prices, setPrices] = useState(false);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  if (!ai) return null;
  return (
    <dialog
      ref={ref}
      className="dialog brief-dialog"
      aria-labelledby="cost-h"
      onClose={(e) => e.target === e.currentTarget && onClose()}
    >
      <header className="dialog-head">
        <h2 id="cost-h">{title}</h2>
        <button
          type="button"
          className="icon-btn"
          aria-label="Close"
          onClick={() => ref.current?.close()}
        >
          {icons.close}
        </button>
      </header>
      <CostCheck
        ai={ai}
        est={est}
        quality="thorough"
        what={what}
        action={action}
        anyway={`${action} anyway`}
        onBack={() => ref.current?.close()}
        onStart={() => {
          onStart();
          ref.current?.close();
        }}
        onEditPrices={() => setPrices(true)}
      />
      {prices && <AiSettingsDialog focus="prices" onClose={() => setPrices(false)} />}
    </dialog>
  );
}

const QUICK = [
  'Cheaper',
  'More storage',
  'Brighter',
  'More open',
  'Simpler',
  'Kid-friendly',
] as const;

function ChangeSomething({ d, next }: { d: Design; next: number }) {
  const project = useProject();
  const ai = useAi();
  const designs = useDesigner((st) => st.designs);
  // Once a version is accepted, the change starts from After as it is, keeping what was
  // changed by hand since (D9).
  const from = useMemo(() => changeFrom(d, designs, project), [d, designs, project]);
  const r = useMemo(() => resultFor(project, from.v, designOpts(project)), [project, from.v]);
  // One row per space and part (a lock holds the whole part): unlocking a row unlocks it all.
  const rows = useMemo(() => {
    const after = project.renovation?.levels[0];
    const head = (l: Lock): string => {
      if (l.space === '*') return '';
      if (l.space === BATHROOMS) return 'Bathrooms’ paint and floors';
      const s = r?.spaces.find((x) => lockCovers(l, x.rooms));
      const name = s?.name ?? 'A room';
      const what = ASPECT_NAMES[l.aspect].toLowerCase();
      if (l.aspect !== 'furniture' && l.aspect !== 'built-ins') return `${name} ${what}`;
      const n = Object.values(after?.items ?? {}).filter((it) => {
        const room = after && roomIdAt(after, { x: it.position.x, y: it.position.z });
        return aspectOf(it) === l.aspect && !!room && !!s?.rooms.includes(room);
      }).length;
      return `${name} ${what}, ${n === 1 ? 'its 1 piece' : `all ${n} pieces`} as now`;
    };
    return heldRows(from.held, head);
  }, [from.held, r, project]);
  const [unlocked, setUnlocked] = useState<string[]>([]);
  const held = useMemo(
    () => rows.filter((x) => !unlocked.includes(x.key)).flatMap((x) => x.locks),
    [rows, unlocked],
  );
  // A paid button waits while a run starts (a double click starts one run).
  const busy = useDesigner((st) => st.starting || !!st.run);
  const { prices } = useSpend();
  const [scope, setScope] = useState('all');
  const [aspects, setAspects] = useState<Aspect[]>(['walls', ...ROOM_ASPECTS]);
  const [keep, setKeep] = useState<Record<string, Aspect[]>>({});
  const [feedback, setFeedback] = useState('');
  const [check, setCheck] = useState<RunEstimate | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const spaces = r?.spaces ?? [];
  const offered: Aspect[] = scope === 'all' ? ['walls', ...ROOM_ASPECTS] : ROOM_ASPECTS;
  const req: ChangeRequest = {
    scope,
    aspects: aspects.filter((a) => offered.includes(a)),
    keep,
    feedback,
    held,
  };
  /** Kept because it was changed by hand (the person can unlock it below). */
  const heldOn = (space: string, a: Aspect) =>
    held.some(
      (l) =>
        l.aspect === a &&
        (space === '*'
          ? l.space === '*'
          : lockCovers(l, spaces.find((s) => s.key === space)?.rooms ?? [])),
    );
  // The requests, worked out again only when what is asked changes (not at each keystroke).
  const asked = req.aspects.join();
  // biome-ignore lint/correctness/useExhaustiveDependencies: what is asked, not the words
  const planned = useMemo(() => {
    const ctx = contextFor(project, from.v.brief, from.v.aliases);
    const made = r && changePlan(from.v, r, { ...req, feedback: '' }, 'dsn_estimate');
    if (!ctx || !made) return null;
    return {
      prompts: plannedPrompts(ctx, made.design, made.plan, designOpts(project)),
      labels: made.labels,
    };
  }, [project, from.v, r, scope, asked, keep, held]);
  const est = useMemo(() => {
    if (!ai || !planned) return null;
    const words = feedback.trim();
    const prompts: StepPrompt[] = planned.prompts.map((p) => ({ ...p, tail: `${p.tail}${words}` }));
    return estimateFor(ai, prompts, d.brief.quality, prices);
  }, [ai, planned, feedback, d.brief.quality, prices]);
  const toggleAspect = (a: Aspect) =>
    setAspects(aspects.includes(a) ? aspects.filter((x) => x !== a) : [...aspects, a]);
  const toggleKeep = (space: string, a: Aspect) => {
    const has = keep[space]?.includes(a);
    setKeep({
      ...keep,
      [space]: has ? (keep[space] ?? []).filter((x) => x !== a) : [...(keep[space] ?? []), a],
    });
  };
  const addQuick = (q: string) => {
    const sentence = `${q}.`;
    setFeedback((f) => (f.trim() ? `${f.trim()} ${sentence}` : sentence));
    area.current?.focus();
  };
  const go = () => {
    if (!est) return;
    if (needsCostCheck(est, spent(), capUsd())) setCheck(est);
    else changeDesign(d, req, est.usd?.typical ?? null);
  };
  const shown = scope === 'all' ? spaces : spaces.filter((s) => s.key === scope);
  const nothing = !planned;
  return (
    <section className="designer-change" aria-labelledby="change-h">
      <div className="designer-card-head">
        <h3 id="change-h">Change V{d.n}</h3>
        <button
          type="button"
          className="link-btn"
          onClick={() => useDesigner.setState({ mode: 'card' })}
        >
          Cancel
        </button>
      </div>
      <label className="field">
        <span className="field-label">What to change</span>
        <select className="input" value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="all">Whole design</option>
          {spaces.map((s) => (
            <option key={s.key} value={s.key}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="chip-row" aria-label="Aspects">
        {offered.map((a) => (
          <button
            key={a}
            type="button"
            className="chip"
            // Walls changed by hand stay as they are: the chip says so, off.
            aria-pressed={aspects.includes(a) && !(a === 'walls' && heldOn('*', 'walls'))}
            disabled={a === 'walls' && heldOn('*', 'walls')}
            title={a === 'walls' && heldOn('*', 'walls') ? 'Kept as you changed them' : undefined}
            onClick={() => toggleAspect(a)}
          >
            {ASPECT_NAMES[a]}
          </button>
        ))}
      </fieldset>
      <fieldset className="keep-grid" aria-label="Keep as it is">
        <p className="field-label">Keep as it is</p>
        {scope === 'all' && (
          <label className="check-row">
            <input
              type="checkbox"
              checked={!!keep['*']?.includes('walls') || heldOn('*', 'walls')}
              disabled={heldOn('*', 'walls')}
              onChange={() => toggleKeep('*', 'walls')}
            />
            <span>Walls and doors</span>
          </label>
        )}
        <table>
          <thead>
            <tr>
              <th scope="col">
                <span className="visually-hidden">Room</span>
              </th>
              {ROOM_ASPECTS.map((a) => (
                <th key={a} scope="col">
                  {a === 'finishes' ? 'Paint' : ASPECT_NAMES[a]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((s) => (
              <tr key={s.key}>
                <th scope="row">{s.name}</th>
                {ROOM_ASPECTS.map((a) => (
                  <td key={a}>
                    {/* The whole cell is the tap target. */}
                    <label className="keep-cell">
                      <input
                        type="checkbox"
                        aria-label={`Keep ${s.name}: ${ASPECT_NAMES[a].toLowerCase()}`}
                        checked={!!keep[s.key]?.includes(a) || heldOn(s.key, a)}
                        disabled={heldOn(s.key, a)}
                        title={heldOn(s.key, a) ? 'Kept as you changed it' : undefined}
                        onChange={() => toggleKeep(s.key, a)}
                      />
                    </label>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </fieldset>
      {rows.length > 0 && (
        <section className="held-list" aria-labelledby="held-h">
          <h4 id="held-h" className="field-label">
            Kept as you changed them
          </h4>
          <ul>
            {rows.map((row) => {
              const k = row.key;
              const off = unlocked.includes(k);
              return (
                <li key={k} className={off ? 'held-off' : undefined}>
                  <span>
                    {row.text}
                    {off && <span className="held-note"> · redone this time</span>}
                  </span>
                  {off ? (
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => setUnlocked(unlocked.filter((x) => x !== k))}
                    >
                      Keep
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="icon-btn held-unlock"
                      aria-label={`Unlock ${row.text}`}
                      title="Unlock: let the designer change it"
                      onClick={() => setUnlocked([...unlocked, k])}
                    >
                      {icons.close}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      <label className="field">
        <span className="field-label">What would you like different?</span>
        <textarea
          ref={area}
          className="input textarea"
          rows={3}
          maxLength={2000}
          placeholder="e.g. make the kitchen open, cheaper, more storage for the parents"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
        />
      </label>
      <fieldset className="chip-row" aria-label="Add a sentence">
        {[
          ...QUICK,
          ...(d.brief.household.elders.length ? ['Safer for an elderly parent'] : []),
        ].map((q) => (
          <button key={q} type="button" className="chip" onClick={() => addQuick(q)}>
            {q}
          </button>
        ))}
      </fieldset>
      <button
        type="button"
        className="btn btn-primary btn-block"
        disabled={nothing || !ai || !est || !!designerCannotUse(ai) || busy}
        onClick={go}
        data-spends=""
      >
        Make V{next}
        {est?.usd
          ? ` · about ${usd(est.usd.typical)}`
          : est
            ? ` · about ${tokens(est.tokens.typical)} tokens`
            : ''}
      </button>
      <p className="field-hint designer-change-what">
        {nothing
          ? 'Everything you picked is kept.'
          : planned
            ? `${plural(planned.prompts.length, 'request')}: ${planned.labels.join('; ')}.`
            : ''}
      </p>
      {check && (
        <CostDialog
          title={`Make V${next}`}
          est={check}
          what={planned?.labels.join('; ') ?? ''}
          action={`Make V${next}`}
          onStart={() => changeDesign(d, req, check.usd?.typical ?? null)}
          onClose={() => setCheck(null)}
        />
      )}
    </section>
  );
}

/** The version's card: kept as it is while a run's steps tick (its props don't change). */
const Card = memo(function Card({
  d,
  r,
  running,
}: {
  d: Design;
  r: DesignResult;
  running: boolean;
}) {
  const project = useProject();
  const after = project.renovation?.levels[0];
  const ai = useAi();
  // A paid button waits while a run starts (a double click starts one run).
  const busy = useDesigner((st) => st.starting || !!st.run);
  const [finishing, setFinishing] = useState<{ est: RunEstimate; only?: string[] } | null>(null);
  const base = baseOf(project, d.base.variant)?.base;
  const changes = useMemo(
    () =>
      base
        ? renovationChanges(base, r.level).filter(
            (c) => c.kind === 'hack' || c.kind === 'build' || c.kind === 'opening',
          ).length
        : 0,
    [base, r.level],
  );
  const totals = usageTotals(d.usage);
  const k = (v: number) => `${Math.round(v / 1000)}k`;
  const locks = d.request.locks;
  const missing = r.spaces.filter((s) => !['done', 'copied', 'locked'].includes(s.status));
  const estimateOf = (only?: string[]) => {
    const plan = finishPlan(d);
    const ctx = contextFor(project, d.brief, d.aliases);
    if (!ai || !plan || !ctx) return null;
    const draft = { ...d, usage: [] };
    return estimateFor(
      ai,
      plannedPrompts(ctx, draft, only ? { ...plan, rooms: only } : plan, designOpts(project)),
      d.brief.quality,
      priceTable(),
    );
  };
  const finish = (only?: string[]) => {
    const est = estimateOf(only);
    if (!est) return;
    if (needsCostCheck(est, spent(), capUsd())) setFinishing({ est, ...(only ? { only } : {}) });
    else finishDesign(d, est.usd?.typical ?? null, only);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per version and run, not per render
  const finishEst = useMemo(
    () => (missing.length && !running ? estimateOf() : null),
    [missing.length, running, d],
  );
  // What trying one room again costs: its one room step.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per version and run, not per render
  const roomEst = useMemo(
    () =>
      new Map(
        running
          ? []
          : missing.map((s) => [s.key, estimateOf([s.key])?.usd?.typical ?? null] as const),
      ),
    [missing.length, running, d],
  );
  // Notes in words, grouped by room and each said once; nothing fixed that was then dropped.
  const notes = useMemo(
    () => [
      {
        title: 'Fixed for you',
        cls: 'designer-fixed',
        groups: byRoom(fixedNotes(r), r, d.aliases, d.baseLevel),
      },
      {
        title: 'Left out',
        cls: 'designer-left-out',
        groups: byRoom([...r.refused, ...r.dropped], r, d.aliases, d.baseLevel),
      },
      {
        title: 'The designer’s notes',
        cls: 'designer-notes',
        groups: byRoom(r.notes, r, d.aliases, d.baseLevel),
      },
    ],
    [r, d.aliases, d.baseLevel],
  );
  const parentN = useDesigner((st) => st.designs.find((x) => x.id === d.parent)?.n ?? null);
  const changedLine = d.parent ? changedText(d, parentN) : null;
  /** Why a room isn't designed, in words (its step's reason, without the room's name). */
  const failedWhy = (s: DesignResult['spaces'][number]) => {
    const e = s.storedKey ? d.spaces[s.storedKey]?.error : undefined;
    if (!e) return null;
    const why = e.startsWith(`${s.name}: `) ? e.slice(s.name.length + 2) : e;
    return why.replace(/\.$/, '');
  };
  return (
    <article className="designer-card" aria-labelledby={`v-${d.id}-h`}>
      <h3 id={`v-${d.id}-h`} className="designer-name">
        {d.concept?.name ?? d.name}
      </h3>
      {d.concept && <p className="designer-summary">{d.concept.summary}</p>}
      {changedLine && <p className="designer-changed">{changedLine}</p>}
      {planChanged(project, d) && (
        <p className="field-hint">Made on the plan as it was; checked again on it as it is now.</p>
      )}
      {d.concept && (
        <ul className="palette-rows">
          {d.concept.style.palette.map((p) => (
            <li key={`${p.hex}${p.use}`}>
              <span className="swatch" style={{ background: p.hex }} aria-hidden="true" />
              <span>{p.name}</span>
              <span className="muted">{p.use}</span>
            </li>
          ))}
        </ul>
      )}
      <dl className="designer-strip">
        <div>
          <dt>Renovation</dt>
          <dd className={r.budget === 'over' ? 'num negative' : 'num'}>
            S${k(r.cost.low)}–{k(r.cost.high)}
          </dd>
        </div>
        <div>
          <dt>Wall changes</dt>
          <dd className="num">{changes}</dd>
        </div>
        <div>
          <dt>Problems</dt>
          <dd className="num">{r.problems.length}</dd>
        </div>
      </dl>
      {r.budget === 'over' && d.brief.budget && (
        <p className="field-hint negative">Over your top figure of S${k(d.brief.budget.high)}.</p>
      )}
      <ul className="designer-rooms">
        {r.spaces.map((s) => {
          const kept = locks.some((l) => l.space === s.key);
          const ok = ['done', 'copied', 'locked'].includes(s.status);
          return (
            <li key={s.key}>
              <button
                type="button"
                className="designer-room"
                onClick={() => showRoom(r.level, s.rooms)}
              >
                <span className="designer-room-name">
                  {s.name}
                  {kept && (
                    <span className="lock-glyph" title="Something kept">
                      <span aria-hidden="true"> 🔒︎</span>
                      <span className="visually-hidden"> (something kept)</span>
                    </span>
                  )}
                </span>
                <span className="designer-room-meta">
                  {ok
                    ? `${s.use ? `${s.use[0]?.toUpperCase()}${s.use.slice(1)} · ` : ''}${plural(s.items.length, 'piece')}`
                    : running && s.status === 'skipped'
                      ? 'Waiting'
                      : 'Not designed'}
                </span>
                {!ok && !running && failedWhy(s) && (
                  <span className="designer-room-why">Not designed: {failedWhy(s)}</span>
                )}
                {s.intent && <span className="designer-intent">{s.intent}</span>}
              </button>
              {!ok && !running && (
                <button
                  type="button"
                  className="link-btn"
                  disabled={!ai || !!designerCannotUse(ai) || busy}
                  onClick={() => finish([s.key])}
                >
                  Try this room again
                  {typeof roomEst.get(s.key) === 'number'
                    ? ` · about ${usd(roomEst.get(s.key) as number)}`
                    : ''}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {missing.length > 0 && !running && finishEst && (
        <button
          type="button"
          className="btn btn-block"
          disabled={!ai || !!designerCannotUse(ai) || busy}
          onClick={() => finish()}
          data-spends=""
        >
          Finish the design{finishEst.usd ? ` · about ${usd(finishEst.usd.typical)}` : ''}
        </button>
      )}
      {r.problems.length > 0 && (
        <section aria-labelledby={`p-${d.id}`}>
          <h4 id={`p-${d.id}`} className="section-title">
            Problems
          </h4>
          <ul className="designer-problems">
            {r.problems.map((p, i) => {
              const it = p.itemId ? r.level.items[p.itemId] : undefined;
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: problems have no ids
                <li key={i}>
                  <span>
                    {problemRoom(p, r.level) ? <strong>{problemRoom(p, r.level)}: </strong> : null}
                    {humanize(p.text, d.aliases, r.level, d.baseLevel)}
                  </span>
                  {(it || p.roomId) && (
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() =>
                        it
                          ? showPoint({ x: it.position.x, y: it.position.z })
                          : p.roomId && showRoom(r.level, [p.roomId])
                      }
                    >
                      Show
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {notes.map(
        (g) =>
          g.groups.length > 0 && (
            <details key={g.title}>
              <summary>
                {g.title} ({g.groups.reduce((t, x) => t + x.lines.length, 0)})
              </summary>
              <div className={g.cls}>
                {g.groups.map((x) => (
                  <section key={x.room} className="designer-note-room">
                    <h5>{x.room}</h5>
                    <ul>
                      {x.lines.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            </details>
          ),
      )}
      <details>
        <summary>Usage</summary>
        <p className="num">
          {plural(d.usage.length, 'request')} · {tokens(totals.tokens)} tokens
          {totals.cached ? ` (${tokens(totals.cached)} from cache)` : ''}
          {totals.usd !== null ? ` · ${totals.estimated ? '~' : ''}${usd(totals.usd)}` : ''}
        </p>
        <ul className="designer-usage">
          {d.usage.map((u, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: requests in order
            <li key={i} className="num">
              {u.step === 'layout' ? 'Layout and style' : (d.spaces[u.step]?.name ?? u.step)}:{' '}
              {u.estimated ? '~' : ''}
              {tokens(u.input + u.cachedInput + u.cacheWrite + u.output)} tokens
              {u.usd !== null ? ` · ${usd(u.usd)}` : ''}
            </li>
          ))}
        </ul>
      </details>
      {!running && (
        <div className="designer-actions">
          <button
            type="button"
            className="btn btn-block"
            onClick={openCompare}
            data-compare-open=""
          >
            Compare
          </button>
          <div className="button-row">
            <button
              type="button"
              className="btn"
              disabled={!ai || !!designerCannotUse(ai) || busy}
              onClick={() => useDesigner.setState({ mode: 'change' })}
            >
              Change something
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => useDesigner.setState({ accepting: d.id })}
            >
              Accept…
            </button>
          </div>
          <button type="button" className="link-btn" onClick={() => void deleteDesign(d)}>
            Delete version
          </button>
          {acceptedNow(d, after) && <p className="field-hint">In your renovation.</p>}
        </div>
      )}
      {finishing && (
        <CostDialog
          title="Finish the design"
          est={finishing.est}
          what={plural(finishing.est.requests, 'room')}
          action="Finish the design"
          onStart={() => finishDesign(d, finishing.est.usd?.typical ?? null, finishing.only)}
          onClose={() => setFinishing(null)}
        />
      )}
    </article>
  );
});

const Tabs = memo(function Tabs({
  designs,
  selected,
}: {
  designs: Design[];
  selected: string | null;
}) {
  const after = useProject().renovation?.levels[0];
  const list = useRef<HTMLDivElement>(null);
  const move = (i: number) => {
    const d = designs[(i + designs.length) % designs.length];
    if (!d) return;
    selectDesign(d.id);
    requestAnimationFrame(() =>
      list.current?.querySelector<HTMLButtonElement>(`[data-v="${d.id}"]`)?.focus(),
    );
  };
  return (
    <div className="designer-tabs" role="tablist" aria-label="Versions" ref={list}>
      {designs.map((d, i) => {
        const on = d.id === selected;
        const acc = acceptedNow(d, after);
        return (
          <button
            key={d.id}
            type="button"
            role="tab"
            data-v={d.id}
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            aria-label={tabName(d, acc)}
            className={on ? 'designer-tab on' : 'designer-tab'}
            onClick={() => selectDesign(d.id)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight') move(i + 1);
              else if (e.key === 'ArrowLeft') move(i - 1);
              else return;
              e.preventDefault();
            }}
          >
            V{d.n}
            {acc && <span className="tab-dot" aria-hidden="true" />}
          </button>
        );
      })}
    </div>
  );
});

export function DesignerPanel() {
  // What the panel shows, not the whole store (a run updates it often).
  const st = useDesigner(
    useShallow((s) => ({
      designs: s.designs,
      selected: s.selected,
      previewing: s.previewing,
      mode: s.mode,
      run: s.run,
      last: s.last,
      note: s.note,
      memory: s.memory,
      accepting: s.accepting,
      wantSide: s.wantSide,
    })),
  );
  const project = useProject();
  const ai = useAi();
  const [settings, setSettings] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus({ preventScroll: true }), []);
  const d = st.designs.find((x) => x.id === st.selected);
  const r = useResult(d);
  const running = !!st.run;
  const runView = st.run ?? st.last;
  const nextN = Math.max(0, ...st.designs.map((x) => x.n)) + 1;

  // The selected version on the plan, while the panel is open and the preview on.
  useEffect(() => {
    const before = project.levels[0];
    if (!st.previewing || !d || !r || !before) {
      if (useEditor.getState().preview) useEditor.getState().setPreview(null);
      return;
    }
    // A side asked for (Compare's columns) wins once; otherwise the side on show stays.
    const want = st.wantSide;
    const side = want ?? useEditor.getState().preview?.side ?? 'version';
    if (want) useDesigner.setState({ wantSide: null });
    useEditor.getState().setPreview({ level: r.level, before, label: `V${d.n}`, side });
    if (reduced()) useEditor.getState().requestFit();
  }, [st.previewing, st.wantSide, d, r, project.levels]);
  useEffect(() => () => useEditor.getState().setPreview(null), []);

  // Esc stops a run (on a computer).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('dialog[open]'))
        return;
      // Esc while comparing closes Compare (its own handler), never stops a paid run.
      if (useDesigner.getState().comparing) return;
      if (useDesigner.getState().run) {
        e.preventDefault();
        stopRun();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const accepting = st.designs.find((x) => x.id === st.accepting);
  const said = st.run?.state.said ?? st.last?.state.said ?? '';
  const halt = (st.run ?? st.last)?.state.halt;
  const folded = st.run
    ? `Step ${progressOf(st.run.state).step} of ${progressOf(st.run.state).of} · ${usd(usageTotals(st.run.state.usage).usd ?? 0)}`
    : null;
  // A phone or a tablet held upright: a sheet at the foot, half height, full, or folded to
  // its header; the plan refits above it each time it changes.
  const sheet = useDesignerSheet();
  const [size, setSize] = useState<'folded' | 'half' | 'full'>('half');
  // biome-ignore lint/correctness/useExhaustiveDependencies: on a change of the sheet's size
  useEffect(() => {
    const f = requestAnimationFrame(() => useEditor.getState().requestFit(64));
    return () => cancelAnimationFrame(f);
  }, [size, sheet]);
  useEffect(
    () => () => {
      requestAnimationFrame(() => useEditor.getState().requestFit(64));
    },
    [],
  );
  const drag = useRef<number | null>(null);
  const moved = useRef(false);

  return (
    <aside
      className={`panel designer${sheet ? ` designer-sheet designer-${size}` : ''}`}
      aria-labelledby="designer-h"
    >
      {sheet && (
        <button
          type="button"
          className="sheet-handle"
          aria-label={
            size === 'full'
              ? 'Make the designer smaller'
              : size === 'folded'
                ? 'Open the designer'
                : 'Make the designer full height'
          }
          onClick={() => {
            if (!moved.current) setSize(size === 'half' ? 'full' : 'half');
            moved.current = false;
          }}
          onPointerDown={(e) => {
            drag.current = e.clientY;
            moved.current = false;
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (drag.current !== null && Math.abs(e.clientY - drag.current) > 4)
              moved.current = true;
          }}
          // Up a size, or down a size, with the finger.
          onPointerUp={(e) => {
            const from = drag.current;
            drag.current = null;
            if (from === null) return;
            const dy = e.clientY - from;
            if (dy < -30) setSize(size === 'folded' ? 'half' : 'full');
            else if (dy > 30) setSize(size === 'full' ? 'half' : 'folded');
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
        />
      )}
      <div className="inspector-head designer-head">
        <h2 id="designer-h" className="panel-title" ref={heading} tabIndex={-1}>
          Designer
          {folded && <span className="designer-folded num"> {folded}</span>}
        </h2>
        {sheet && size === 'folded' && running && (
          <button type="button" className="btn btn-small" onClick={stopRun}>
            Stop
          </button>
        )}
        <button
          type="button"
          className="icon-btn"
          aria-label="Close the designer"
          title="Close"
          onClick={closePanel}
        >
          {icons.close}
        </button>
      </div>
      <p className="visually-hidden" aria-live="polite">
        {said}
      </p>
      {st.memory && <p className="field-hint">Designs will be lost when you close this tab.</p>}
      <div className="designer-body">
        {halt && <HaltNotice halt={halt} onSettings={() => setSettings(true)} />}
        {runView && <RunView run={runView} live={running} />}
        {st.designs.length === 0 && !running && (
          <div className="designer-empty">
            <p>No designs yet.</p>
            <button
              type="button"
              className="btn"
              onClick={() => useDesigner.setState({ briefOpen: true })}
            >
              Design my flat
            </button>
          </div>
        )}
        {running && !d && (
          <div className="designer-loading" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        )}
        {st.designs.length > 0 && <Tabs designs={st.designs} selected={st.selected} />}
        {st.note && <p className="field-hint">{st.note}</p>}
        {d && r && st.mode === 'change' && !running ? (
          <ChangeSomething key={d.id} d={d} next={nextN} />
        ) : d && r ? (
          <Card d={d} r={r} running={running && st.run?.designId === d.id} />
        ) : null}
        {ai && designerCannotUse(ai) && st.designs.length > 0 && (
          <p className="field-hint">
            {designerCannotUse(ai)}{' '}
            <button type="button" className="link-btn" onClick={() => setSettings(true)}>
              AI settings
            </button>
          </p>
        )}
        {!ai && st.designs.length > 0 && (
          <p className="field-hint">
            Changing a design needs your AI key.{' '}
            <button type="button" className="link-btn" onClick={() => setSettings(true)}>
              AI settings
            </button>
          </p>
        )}
      </div>
      {running && (
        <div className="designer-foot">
          <button type="button" className="btn btn-block" onClick={stopRun} title="Stop (Esc)">
            Stop
          </button>
        </div>
      )}
      {st.run?.paused && <PauseDialog run={st.run} />}
      {accepting && (
        <AcceptDialog
          design={accepting}
          onClose={() => useDesigner.setState({ accepting: null })}
        />
      )}
      {settings && <AiSettingsDialog onClose={() => setSettings(false)} />}
    </aside>
  );
}
