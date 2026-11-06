import {
  type Aspect,
  type Design,
  type DesignResult,
  type RunEstimate,
  type StepPrompt,
  renovationChanges,
  usageTotals,
} from '@dhd/core';
import { useEffect, useMemo, useRef, useState } from 'react';
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
  changePlan,
  contextFor,
  estimateFor,
  needsCostCheck,
  planChanged,
  plannedPrompts,
  resultFor,
} from './plan';
import type { RunState, StepState } from './run';
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
  selectDesign,
  stopRun,
  useDesigner,
} from './state';

/**
 * The Designer panel: the run as it goes (steps, the meter, Stop), then the versions (tabs
 * and the selected one's card), Change something, and Accept. Selecting a version shows it
 * on the plan. In the details column (360 px), a bottom sheet below 1100 px.
 */

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
const isStopped = (d: Design) =>
  Object.values(d.spaces).some((s) => s.status === 'cancelled' || s.status === 'skipped');
const tabName = (d: Design, accepted: boolean) =>
  `V${d.n}${accepted ? ', accepted' : ''}${isStopped(d) ? ', stopped' : ''}`;

/** A version on the plan as it is now, worked out once per version and plan. */
export function useResult(d: Design | undefined): DesignResult | null {
  const project = useProject();
  return useMemo(() => (d ? resultFor(project, d, designOpts(project)) : null), [project, d]);
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
  const phaseLine =
    live && running
      ? `Step ${current + 1} of ${requests}: ${running.label}…`
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
          {s.steps.some((x) => x.status === 'cancelled') &&
            ' The step that was cut off may still be billed.'}
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

function ChangeSomething({ d, r, next }: { d: Design; r: DesignResult; next: number }) {
  const project = useProject();
  const ai = useAi();
  const { prices } = useSpend();
  const [scope, setScope] = useState('all');
  const [aspects, setAspects] = useState<Aspect[]>(['walls', ...ROOM_ASPECTS]);
  const [keep, setKeep] = useState<Record<string, Aspect[]>>({});
  const [feedback, setFeedback] = useState('');
  const [check, setCheck] = useState<RunEstimate | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const spaces = r.spaces;
  const offered: Aspect[] = scope === 'all' ? ['walls', ...ROOM_ASPECTS] : ROOM_ASPECTS;
  const req: ChangeRequest = {
    scope,
    aspects: aspects.filter((a) => offered.includes(a)),
    keep,
    feedback,
  };
  // The requests, worked out again only when what is asked changes (not at each keystroke).
  const asked = req.aspects.join();
  // biome-ignore lint/correctness/useExhaustiveDependencies: what is asked, not the words
  const planned = useMemo(() => {
    const ctx = contextFor(project, d.brief, d.aliases);
    const made = changePlan(d, r, { ...req, feedback: '' }, 'dsn_estimate');
    if (!ctx || !made) return null;
    return {
      prompts: plannedPrompts(ctx, made.design, made.plan, designOpts(project)),
      labels: made.labels,
    };
  }, [project, d, r, scope, asked, keep]);
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
            aria-pressed={aspects.includes(a)}
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
              checked={!!keep['*']?.includes('walls')}
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
                    <input
                      type="checkbox"
                      aria-label={`Keep ${s.name}: ${ASPECT_NAMES[a].toLowerCase()}`}
                      checked={!!keep[s.key]?.includes(a)}
                      onChange={() => toggleKeep(s.key, a)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </fieldset>
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
      <fieldset className="chip-row chip-scroll" aria-label="Add a sentence">
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
        disabled={nothing || !ai || !est}
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

function Card({ d, r, running }: { d: Design; r: DesignResult; running: boolean }) {
  const project = useProject();
  const after = project.renovation?.levels[0];
  const ai = useAi();
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
  return (
    <article className="designer-card" aria-labelledby={`v-${d.id}-h`}>
      <h3 id={`v-${d.id}-h`} className="designer-name">
        {d.concept?.name ?? d.name}
      </h3>
      {d.concept && <p className="designer-summary">{d.concept.summary}</p>}
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
                {s.intent && <span className="designer-intent">{s.intent}</span>}
              </button>
              {!ok && !running && (
                <button type="button" className="link-btn" onClick={() => finish([s.key])}>
                  Try this room again
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {missing.length > 0 && !running && finishEst && (
        <button type="button" className="btn btn-block" onClick={() => finish()} data-spends="">
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
                  <span>{p.text}</span>
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
      {r.repaired.length > 0 && (
        <details>
          <summary>Fixed for you ({r.repaired.length})</summary>
          <ul>
            {r.repaired.map((n, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: notes have no ids
              <li key={i}>{n.text}</li>
            ))}
          </ul>
        </details>
      )}
      {r.refused.length + r.dropped.length > 0 && (
        <details>
          <summary>Left out ({r.refused.length + r.dropped.length})</summary>
          <ul className="designer-left-out">
            {[...r.refused, ...r.dropped].map((n, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: notes have no ids
              <li key={i}>{n.text}</li>
            ))}
          </ul>
        </details>
      )}
      {r.notes.length > 0 && (
        <details>
          <summary>The designer’s notes ({r.notes.length})</summary>
          <ul>
            {r.notes.map((n, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: notes have no ids
              <li key={i}>{n.text}</li>
            ))}
          </ul>
        </details>
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
          <div className="button-row">
            <button
              type="button"
              className="btn"
              disabled={!ai}
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
}

function Tabs({ designs, selected }: { designs: Design[]; selected: string | null }) {
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
}

export function DesignerPanel() {
  const st = useDesigner();
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
    const side = useEditor.getState().preview?.side ?? 'version';
    useEditor.getState().setPreview({ level: r.level, before, label: `V${d.n}`, side });
    if (reduced()) useEditor.getState().requestFit();
  }, [st.previewing, d, r, project.levels]);
  useEffect(() => () => useEditor.getState().setPreview(null), []);

  // Esc stops a run (on a computer).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('dialog[open]'))
        return;
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
    ? `${st.run.state.steps.filter((x) => x.status === 'done').length} of ${st.run.state.steps.length} · ${usd(usageTotals(st.run.state.usage).usd ?? 0)}`
    : null;

  return (
    <aside className="panel designer" aria-labelledby="designer-h">
      <div className="inspector-head designer-head">
        <h2 id="designer-h" className="panel-title" ref={heading} tabIndex={-1}>
          Designer
          {folded && <span className="designer-folded num"> {folded}</span>}
        </h2>
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
          <ChangeSomething key={d.id} d={d} r={r} next={nextN} />
        ) : d && r ? (
          <Card d={d} r={r} running={running && st.run?.designId === d.id} />
        ) : null}
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
