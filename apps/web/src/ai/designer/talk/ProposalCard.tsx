import {
  type Change,
  type DesignResult,
  type ResultCheck,
  type StorageAmount,
  type SubsetReport,
  WARNING_TEXT,
  defaultTicks,
  firstTickedPieces,
  keptHolds,
  mergeChanges,
  mergeLines,
  peopleWords,
  spentOf,
  subsetReport,
  usageTotals,
} from '@dhd/core';
import { type ReactNode, memo, useEffect, useMemo, useRef, useState } from 'react';
import { useRates } from '../../../cost/estimate';
import { useEditor } from '../../../editor';
import { warningsOf } from '../../../electrical/electrical';
import { setMeterAmount, useStorage } from '../../../storage/store';
import { useStore } from '../../../store';
import { useAi } from '../../credentials';
import { CaseDialog } from '../CaseDialog';
import { failingChecks } from '../parts';
import { useResultsTickN } from '../results';
import { cannotDesign, tokens, usd, useSpend } from '../spend';
import { houseKeptFor, houseRulesFor, openCompare, useDesigner } from '../state';
import { keepTogether } from '../words';
import { CheckLead, SetOutToFix, hasLead } from './CheckLead';
import { Mark } from './Mark';
import { acceptCard, precheckNow } from './accept';
import {
  type CardModel,
  cardChanges,
  cardLens,
  cardResult,
  cardRunReport,
  cardVerdict,
  headLabel,
  madeWith,
  midLine,
  nowOf,
  planMoved,
  tickedExtra,
} from './cards';
import {
  freeLabel,
  freeLines,
  freeOffer,
  isAppChange,
  placeFree,
  publishTickedOut,
  useFreeBusy,
} from './free';
import { bringBackCard } from './iterate';
import {
  anotherPrice,
  finishPrice,
  finishRooms,
  pressAnother,
  pressScope,
  scopePrice,
} from './propose';
import { pressCarryOn, pressKeep } from './resume';
import { focusInLog, scrollInLog } from './scroll';
import { timed, useSettledProject } from './settle';
import {
  type LiveRun,
  type ResumeView,
  act,
  actProposal,
  useBusy,
  useRulesKey,
  useTalk,
} from './useTalk';
import { EMPTY_VIEW, useProposalView } from './view';

/**
 * A proposal card (UX §6.3): its changes grouped by room, each said in the app's words with
 * the designer's reason one tap away, ticks per change (failing ones unticked, Accept anyway
 * to waive, HDB rules never), the checks and the cost of what is ticked, and Accept selected.
 * While its run goes on, a progress line per room and ghosts on the plan; Accept waits for the
 * checks.
 */

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const k = (v: number) => `${Math.round(v / 1000)}k`;
/** "3–5k" (one unit for the range). */
const kRange = (lo: number, hi: number) => `${Math.round(lo / 1000)}–${Math.round(hi / 1000)}k`;
const sgd = (v: number) => `S$${Math.abs(Math.round(v)).toLocaleString('en-SG')}`;

/** A lens line, its short parts ("+1.8 m hanging") kept on one line. */
const lensLine = (line: string) =>
  line
    .split(' · ')
    .map((p) => (p.length <= 24 ? p.replace(/ /g, '\u00a0') : keepTogether(p)))
    .join(' · ');

const MEASURED: Record<StorageAmount, string> = {
  few: 'Measured for few things',
  typical: 'Measured for typical amounts',
  lots: 'Measured for lots of things',
};
const OWNS: { id: StorageAmount; label: string }[] = [
  { id: 'few', label: 'Few' },
  { id: 'typical', label: 'Typical' },
  { id: 'lots', label: 'Lots' },
];

/**
 * How much they own, on the storage line: free chips, one value with the storage meter's own
 * setting and What I know's fact (useTalk keeps them in step and says the change in the log).
 */
function OwnsChips({ amount, projectId }: { amount: StorageAmount; projectId: string }) {
  return (
    <div className="talk-owns">
      <span className="muted">{MEASURED[amount]}</span>
      <span className="talk-choices" role="radiogroup" aria-label="How much you own">
        {OWNS.map((o) => (
          <button
            key={o.id}
            type="button"
            // biome-ignore lint/a11y/useSemanticElements: chips that answer on tap, as a radio group
            role="radio"
            aria-checked={amount === o.id}
            className="chip"
            onClick={() => setMeterAmount(projectId, o.id)}
          >
            {o.label}
          </button>
        ))}
      </span>
    </div>
  );
}

/** A tri-state checkbox (a group's tick). */
function GroupTick({
  checked,
  mixed,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  mixed: boolean;
  disabled: boolean;
  label: string;
  onChange: (on: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = mixed;
  }, [mixed]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className="talk-tick"
      checked={checked}
      disabled={disabled}
      aria-checked={mixed ? 'mixed' : checked}
      aria-label={label}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

/**
 * Steps cut off part-way and sent again (a locked phone, a dropped connection), with what the
 * cut-off attempts may still be billed: the attempt before each later one for the same step.
 */
function cutOffs(usage: CardModel['usage'], names: Record<string, string>) {
  const out: { name: string; usd: number | null }[] = [];
  usage.forEach((u, i) => {
    if (!u.estimated || !usage.slice(i + 1).some((v) => v.step === u.step)) return;
    out.push({ name: names[u.step] ?? 'A step', usd: u.usd });
  });
  return out;
}

/** The cost of a card's run, as a button opening its details (UX §9.3). */
export function TurnCost({
  usage,
  fixes = 0,
  names = {},
  atMost = false,
}: {
  usage: CardModel['usage'];
  fixes?: number;
  /** Step names by key, for the steps cut off and sent again. */
  names?: Record<string, string>;
  /** A design run's: an attempt cut off is counted at its most, so the figure is "up to". */
  atMost?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ai = useAi();
  if (!usage.length) return null;
  const cut = cutOffs(usage, names);
  const s = spentOf(usage);
  const t = usageTotals(usage);
  const text =
    s.usd === null
      ? `${tokens(s.tokens)} tokens`
      : `${s.estimated ? (atMost ? 'up to ' : '~') : ''}${usd(s.usd)}`;
  const model = usage[0]?.model ?? ai?.model ?? '';
  return (
    <span className="talk-cost">
      <button
        type="button"
        className="link-btn talk-cost-btn num"
        aria-expanded={open}
        aria-label={`Cost of this reply: ${text}, details`}
        onClick={() => setOpen(!open)}
      >
        {text}
      </button>
      {open && (
        <span className="talk-cost-pop num" role="note">
          {plural(usage.length, 'request')} · {tokens(t.tokens - t.cached)} tokens in,{' '}
          {tokens(t.cached)} from cache · {tokens(usage.reduce((a, u) => a + u.output, 0))} out
          {fixes ? ` · ${plural(fixes, 'fix round')}` : ''} · {model}
          {cut.map((c, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: one line per cut-off attempt, in order
            <span key={i} className="talk-cost-cut">
              {' '}
              {c.name} was cut off and sent again
              {c.usd !== null ? `: up to ${usd(c.usd)} extra may be billed.` : '.'}
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

const NO_IDS: string[] = [];
/**
 * The ids of pieces kept where they are on the card's result (for the Kept tag): only the card
 * on the plan reads it, so a folded card never re-renders as the view changes.
 */
function useKeptIds(levelId: string, shown: boolean): string[] {
  const kept = useTalk((s) => (shown && s.conv?.levelId === levelId ? s.conv.kept : null));
  const target = useProposalView((s) => (shown ? s.target : null));
  return useMemo(() => {
    if (!kept?.length || !target) return NO_IDS;
    return Object.values(target.items)
      .filter((it) => kept.some((k) => (k.itemId ? k.itemId === it.id : keptHolds(k, it))))
      .map((it) => it.id);
  }, [kept, target]);
}

/** The plan as the ticked changes would make it, and what that fails and costs (150 ms). */
function useSubset(
  card: CardModel,
  r: DesignResult | null,
  changes: Change[],
  ticked: string[],
  waive: string[],
) {
  const project = useSettledProject();
  const rates = useRates((s) => s.rates);
  const rulesKey = useRulesKey(card.levelId);
  const b = useMemo(() => nowOf(project, card.levelId), [project, card.levelId]);
  const merged = useMemo(
    () => (b && r ? timed(() => mergeChanges(b.now, r.level, changes, ticked)) : null),
    [b, r, changes, ticked],
  );
  const [report, setReport] = useState<SubsetReport | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: on what is ticked and the plan
  useEffect(() => {
    if (!b || !r || !merged) return;
    const t = setTimeout(
      () =>
        setReport(
          timed(() =>
            subsetReport(b.now, b.before, r, merged, card.input.brief, {
              rates,
              waived: [...card.waivers.map((w) => w.key), ...waive],
              renovation: !!project.renovation,
              rules: houseRulesFor(card.levelId),
              kept: houseKeptFor(card.levelId, madeWith(card)),
              firstIn: firstTickedPieces(changes),
            }),
          ),
        ),
      report ? 150 : 0,
    );
    return () => clearTimeout(t);
  }, [merged, rates, waive.join('|'), card.waivers, rulesKey]);
  return { merged, report };
}

interface Props {
  card: CardModel;
  /** The newest card: open; older ones fold to one line. */
  newest: boolean;
  live: LiveRun | null;
  /** Alternatives A / B / C: the segmented control over the card's body. */
  tabs?: ReactNode;
  /** A sideways swipe on the change list (phone): the next or previous option. */
  onSwipe?: (dir: 1 | -1) => void;
}

const coarsePointer = () =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;

/**
 * The running card's time left: on a phone, keep the screen open (locking it pauses the
 * design); on a computer, just how long. Worked out again only as each step ends.
 */
function TimeLeftLine({ live }: { live: LiveRun }) {
  const coarse = useMemo(coarsePointer, []);
  const left = live.left?.text;
  if (!left || live.paused) return null;
  const problems = live.state.steps.reduce((t, s) => t + (s.fixing?.problems ?? 0), 0);
  const lead = problems ? `fixing ${plural(problems, 'problem')} · ` : '';
  if (!coarse) {
    return (
      <p className="talk-card-note" data-time-left="">
        Designing · {lead}
        {left}
      </p>
    );
  }
  const refused = live.wake === 'refused' || live.wake === 'unsupported';
  return (
    <div data-time-left="">
      <p className="talk-card-note">
        <strong>Keep this screen open</strong> · {lead}
        {left}
        {refused ? '. Your screen may turn off on its own: tap it now and then.' : ''}
      </p>
      {!refused && (
        <p className="field-hint">
          Locking your phone pauses the design. It carries on when you come back.
        </p>
      )}
    </div>
  );
}

/** Why an interrupted design stopped, as its card says it. */
const STOPPED_BECAUSE: Record<'closed' | 'resent' | 'approved' | 'tab', string> = {
  closed: 'This design stopped when the page closed.',
  resent: 'This design stopped: a step was cut off again and again while the screen was off.',
  approved: 'This design stopped before going past what it was priced at.',
  tab: 'This design stopped at this tab’s limit.',
};

/** A run the page lost: running in another tab, carrying on, or asking once. */
function ResumeNote({
  cardKey,
  view,
  busy,
}: {
  cardKey: string;
  view: ResumeView;
  busy: boolean;
}) {
  if (view.kind === 'other-tab') return <p className="talk-card-note">Designing in another tab.</p>;
  if (view.kind === 'carrying-on')
    return <p className="talk-card-note">Picking up where it stopped…</p>;
  if (view.kind === 'offline') {
    return (
      <p className="talk-card-note">
        Waiting for the connection…{' '}
        {view.total === null ? '' : `${view.done} of ${view.total} done.`}
      </p>
    );
  }
  const kept =
    view.total === null
      ? 'Nothing had finished yet.'
      : `${view.done} of ${view.total} rooms are done and kept.`;
  const at = view.figure !== null ? ` · at most ${usd(view.figure)}` : '';
  return (
    <div className="talk-stopped" data-resume="">
      <p>
        {STOPPED_BECAUSE[view.why]} {kept}
        {view.changed ? ' Your plan has changed since.' : ''}
      </p>
      {view.model && (
        <p>
          Carry on with {view.model.now}? It was started with {view.model.was}.
        </p>
      )}
      <div className="button-row">
        <button
          type="button"
          className="btn btn-small btn-primary"
          data-spends=""
          disabled={busy || view.pending}
          onClick={() => void pressCarryOn(cardKey)}
        >
          {view.changed ? 'Carry on with the plan as it is now' : 'Carry on'}
          {at}
        </button>
        <button
          type="button"
          className="btn btn-small"
          disabled={busy || view.pending}
          onClick={() => void pressKeep(cardKey)}
        >
          Keep as it is
        </button>
      </div>
    </div>
  );
}

/** A must-have check (a bed, the seats, the table, a desk) with no piece of its own. */
const ESSENTIAL_KEY = /^P1\|(bed|seats|dining|desks)\|/;
/** "You and Partner have no bed in …" → "You and Partner will have no bed in …". */
const willHave = (says: string) => says.replace(/\b(?:has|have) (no|\d+)\b/, 'will have $1');

/**
 * Accept's question, counted as the card counts (one line a failure as the person reads it):
 * "Accept anyway? 1 problem: 4 dining chairs aren't at a table".
 */
function askLine(checks: readonly ResultCheck[], brief: CardModel['input']['brief']): string {
  const lines = mergeLines(
    checks.map((c) => ({
      key: c.key,
      text: c.text,
      says: peopleWords(c.text, brief),
      roomId: c.roomId ?? null,
    })),
  );
  // A must-have the ticks leave unmet is said as what will happen: "will have no bed".
  const said = (l: (typeof lines)[number]) =>
    (ESSENTIAL_KEY.test(l.first.key) ? willHave(l.says) : l.says).replace(/\.$/, '');
  return `Accept anyway? ${plural(lines.length, 'problem')}: ${lines.map(said).join('; ')}`;
}

/** What a folded card last said of itself (its checks need the plan worked out again). */
const verdicts = new Map<string, { text: string; total: number; rules: string }>();

/**
 * A folded card's line: its checks as last worked out, and what is in the renovation as the
 * record says now (an Undo or a Put it back since takes rows out; QA R2).
 */
function foldedLine(card: CardModel, rules: string): string {
  const said = verdicts.get(card.key);
  const inNow = card.accepted.filter((a) => !a.out).length;
  if (!said) return inNow ? ` · Accepted ${inNow}` : '';
  if (inNow && inNow >= said.total) return ' · In your renovation';
  // Worked out before your rules last changed: it says so rather than an old verdict (QA B5).
  // Only rules count here: a piece kept since doesn't apply to a version made before it.
  const rulesOf = (key: string) =>
    key
      .split('|')
      .filter((x) => x && !x.startsWith('k:'))
      .join('|');
  const text =
    rulesOf(said.rules) === rulesOf(rules) ? said.text : 'Not checked against your rules yet';
  return ` · ${text}${inNow ? ` · Accepted ${inNow} of ${said.total}` : ''}`;
}

export const ProposalCard = memo(function ProposalCard({
  card,
  newest,
  live,
  tabs,
  onSwipe,
}: Props) {
  // The plan once edits pause: a drag never works a card out again frame by frame.
  const project = useSettledProject();
  const { prices } = useSpend();
  const ai = useAi();
  const shown = useTalk((s) => s.shown === card.key);
  const openRow = useTalk((s) => (s.open?.card === card.key ? s.open.change : null));
  const whyAll = useTalk((s) => s.why === card.key);
  const onPlan = useEditor((s) => shown && !!s.preview && s.preview.side === 'version');
  const hover = useTalk((s) => (s.hover?.card === card.key ? s.hover.change : null));
  const resume = useTalk((s) => s.resume[card.key]);
  const planHover = useEditor((s) => (shown && s.hover?.kind === 'item' ? s.hover.id : null));
  const busy = useBusy();
  const [accepting, setAccepting] = useState(false);
  // A version to compare: this card's, once accepted (or an earlier design's).
  const versionId = card.design?.id ?? card.option?.version ?? null;
  const comparable = useDesigner((s) => !!versionId && s.designs.some((d) => d.id === versionId));
  // Running in the record, with no run here, no checkpoint to carry on from and nothing to say
  // about it (an older build dropped the checkpoint): shown as stopped, as it is.
  // (Not while a run is being started here: its option is written running a moment before
  // its run shows.)
  const starting = useDesigner((s) => s.starting);
  const stale =
    card.status === 'running' &&
    card.kind === 'proposal' &&
    !live &&
    !card.option?.run &&
    !resume &&
    !starting;
  const running = card.status === 'running' && !stale;
  const [expanded, setExpanded] = useState(newest);
  // The newest card opens; once a newer one comes it folds to its line (opened again by a
  // tap), so a long conversation works out one or two cards, not every one (QA P4-6).
  const wasNewest = useRef(newest);
  useEffect(() => {
    if (newest) setExpanded(true);
    else if (wasNewest.current) setExpanded(false);
    wasNewest.current = newest;
  }, [newest]);
  // Worked out only while it is open or on the plan; folded, it shows what it said last.
  const active = expanded || shown;
  // The pointing tip, once per conversation; kept pieces tag their rows.
  const tipSeen = useTalk((s) => !!s.conv?.tips.includes('point'));
  const keptIds = useKeptIds(card.levelId, shown);
  const tick = useResultsTickN();
  // A rule kept, changed or deleted re-checks the card, with no request (3a.5).
  const rulesKey = useRulesKey(card.levelId);
  const ruleCount = rulesKey ? rulesKey.split('|').filter((x) => !x.startsWith('k:')).length : 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again as results land
  const r = useMemo(
    () => (active ? timed(() => cardResult(project, card)) : null),
    [active, project, card, tick, rulesKey],
  );
  const changes = useMemo(
    () => (r ? timed(() => cardChanges(project, card, r)) : []),
    [project, card, r],
  );
  // The storage meter's household and amount: the lens reads them (worked out again on change,
  // with no request).
  const meter = useStorage((s) => s.setting);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again as results land
  const storage = useMemo(
    () =>
      active && r
        ? (timed(() => cardLens(project, card))?.find((l) => l.id === 'storage') ?? null)
        : null,
    [active, r, project, card, tick, meter],
  );
  const ids = useMemo(() => new Set(changes.map((c) => c.id)), [changes]);
  const [ticks, setTicks] = useState<string[] | null>(card.ticks);
  // Ticks saved and not yet all back: each save's record comes back when it is written, and an
  // older one would take back a tick made since (a quick second tick, on a slow disk, lost).
  const saving = useRef(0);
  useEffect(() => {
    if (saving.current === 0) setTicks(card.ticks);
  }, [card.ticks]);
  const ticked = useMemo(
    () => (ticks ?? defaultTicks(changes)).filter((id) => ids.has(id)),
    [ticks, changes, ids],
  );
  const [waive, setWaive] = useState<{ key: string; text: string }[]>([]);
  const [confirm, setConfirm] = useState<string | null>(null);
  /** Accept selected found problems the ticked changes cause together: asked, or refused. */
  const [asking, setAsking] = useState<{ checks: ResultCheck[]; hdb: boolean } | null>(null);
  const [wrong, setWrong] = useState(false);
  const [more, setMore] = useState(false);
  const { merged, report } = useSubset(
    card,
    r,
    changes,
    ticked,
    waive.map((w) => w.key),
  );
  // The one list (UX "One list, one count"): what the version fails in its scope, less what is
  // accepted anyway, one line a failure. The lead names every one, a missing bed (no piece, so
  // no row) included; the count is its length, as the bar, the tabs and the talk call count.
  const waiveKey = waive.map((w) => w.key).join('|');
  const runRep = useMemo(
    () => (r ? timed(() => cardRunReport(card, r, changes, { waive: waiveKey.split('|') })) : null),
    [card, r, changes, waiveKey],
  );
  // The free fix's dry run (in the worker, free): offered only when it would place something.
  // From the plan once edits have paused a full second: never re-run as a drag goes on.
  const slowProject = useSettledProject(1000);
  const freeBusy = useFreeBusy((s) => s.card);
  const declinedKey = useTalk((s) =>
    (s.conv?.decisions ?? [])
      .filter((d) => !d.deleted && d.free)
      .map((d) => d.id)
      .join(','),
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again as results land
  const offer = useMemo(
    () => (active && r && !running ? timed(() => freeOffer(slowProject, card)) : null),
    [active, r, running, slowProject, card, tick, declinedKey],
  );
  // The electrical layer's notes on the points this proposal adds (surface trunking on a
  // structural wall, an aircon with no compressor): notes, not failures, so amber.
  const elecNotes = useMemo(() => {
    const b = nowOf(project, card.levelId);
    if (!merged || !b) return [] as string[];
    return timed(() => {
      const out: string[] = [];
      for (const [id, ws] of warningsOf(merged, b.before)) {
        if (b.now.points?.[id]) continue;
        for (const w of ws) out.push(WARNING_TEXT[w]);
      }
      return out;
    });
  }, [merged, project, card.levelId]);
  const checkText = useMemo(() => new Map((r?.checks ?? []).map((c) => [c.key, c])), [r]);
  const accepted = card.accepted.filter((a) => !a.out);
  const allIn = !running && changes.length === 0 && accepted.length > 0;
  const acceptBtn = useRef<HTMLButtonElement>(null);
  // Another idea's price: once per plan (settled), scope, versions and prices; never per
  // keystroke.
  const proposal = card.proposal;
  const designs = useDesigner((s) => s.designs);
  // biome-ignore lint/correctness/useExhaustiveDependencies: on what the price reads
  const another = useMemo(
    () =>
      // Priced only while the card is open: a folded card shows no button to price.
      expanded && !running && proposal && ai && !cannotDesign(ai)
        ? timed(() =>
            card.status === 'failed' ? scopePrice(proposal.scope) : anotherPrice(proposal),
          )
        : null,
    [expanded, running, proposal, ai, project, prices, tick, card.status, designs],
  );
  // A sideways swipe of at least 60 px on the change list; a mostly vertical one scrolls.
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const rowsRef = useRef<HTMLDivElement>(null);

  const setTicked = (next: string[]) => {
    setTicks(next);
    if (card.proposal && card.option) {
      const letter = card.option.letter;
      saving.current++;
      void actProposal(card.proposal.id, (p) =>
        p
          ? {
              ...p,
              options: p.options.map((o) => (o.letter === letter ? { ...o, ticks: next } : o)),
            }
          : p,
      ).finally(() => {
        saving.current--;
      });
    }
  };
  const toggle = (c: Change, on: boolean) => {
    if (on && c.checks.length && !waive.some((w) => c.checks.includes(w.key))) {
      // Accept anyway asks first, listing every problem the tick waives.
      if (c.waivable) setConfirm(c.id);
      return;
    }
    const set = new Set(ticked);
    if (on) set.add(c.id);
    else set.delete(c.id);
    // The walls going out takes what needs them with them.
    if (c.id === 'walls' && !on) for (const x of changes) if (x.needsWalls) set.delete(x.id);
    setTicked([...set]);
  };

  // On the plan: publish what to draw.
  const failingItems = useMemo(
    () => (report?.failing ?? []).flatMap((c) => (c.itemId ? [c.itemId] : [])),
    [report],
  );
  useEffect(() => {
    if (!shown || !r) return;
    const b = nowOf(project, card.levelId);
    useProposalView.setState({
      card: card.key,
      label: card.title,
      now: b?.now ?? null,
      target: r.level,
      merged: running ? (b?.now ?? null) : merged,
      changes,
      ticked,
      failing: failingItems,
      ghost: running,
      rooms: r.spaces
        .filter((s) => s.storedKey && ['done', 'copied'].includes(s.status))
        .flatMap((s) => s.rooms),
    });
  }, [
    shown,
    r,
    merged,
    changes,
    ticked,
    failingItems,
    running,
    card.key,
    card.title,
    card.levelId,
    project,
  ]);
  useEffect(
    () => () => {
      if (useProposalView.getState().card === card.key) useProposalView.setState(EMPTY_VIEW);
    },
    [card.key],
  );
  // A piece tapped on the plan opens its row (slice 2's Why); the popover says the rest.
  useEffect(() => {
    if (!shown) return;
    return useEditor.subscribe((s, prev) => {
      const sel = s.selection;
      if (!s.preview || !sel || sel === prev.selection || sel.kind !== 'item') return;
      const c = changes.find(
        (x) => x.items.target.includes(sel.id) || x.items.now.includes(sel.id),
      );
      if (c) {
        useTalk.setState({ open: { card: card.key, change: c.id } });
        requestAnimationFrame(() =>
          scrollInLog(
            rowsRef.current?.querySelector(`[data-change-id="${CSS.escape(c.id)}"]`),
            'nearest',
          ),
        );
      }
      // Not changed in it: the popover says so (slice 3a), no toast.
    });
  }, [shown, changes, card.key]);

  if (!expanded && !r) {
    // Folded and not on the plan: what it said last (nothing is worked out for it).
    return (
      <article className="talk-card talk-card-folded" aria-labelledby={`card-${card.key}`}>
        <button
          type="button"
          className="talk-card-fold"
          id={`card-${card.key}`}
          aria-expanded={false}
          onClick={() => setExpanded(true)}
        >
          <span>
            {card.title} · {headLabel(project, card)}
            {foldedLine(card, rulesKey)}
          </span>
          <span className="talk-fold-show" aria-hidden="true">
            Show ›
          </span>
        </button>
      </article>
    );
  }
  if (!r) {
    // Being placed and checked by the designer's worker: a calm line, the card's head kept.
    return (
      <article className="talk-card" data-card={card.key} aria-labelledby={`card-${card.key}`}>
        <h3 className="talk-card-title" id={`card-${card.key}`}>
          {card.title} · {headLabel(project, card)}
        </h3>
        {nowOf(project, card.levelId) ? (
          <p className="talk-card-note muted" aria-busy="true">
            Checking it on your plan…
          </p>
        ) : (
          <p className="talk-card-note muted">Its level is no longer in the plan.</p>
        )}
      </article>
    );
  }
  const fails = failingChecks(r, { waivers: card.waivers });
  const rep = runRep ?? cardRunReport(card, r, changes);
  const waivedKeys = [...fails.waived.map((c) => c.key), ...waive.map((w) => w.key)];
  // What the ticks fail together beyond the version's own count (said under Checks).
  const extras = tickedExtra(rep, report?.failing ?? [], waivedKeys);
  const accept = async (w: { key: string; text: string }[]) => {
    setAccepting(true);
    const line = await acceptCard(card, ticked, w).finally(() => setAccepting(false));
    setWaive([]);
    if (line) setTicks([]);
    if (line) {
      requestAnimationFrame(() =>
        focusInLog(document.querySelector<HTMLButtonElement>(`[data-undo-line="${line}"]`)),
      );
    }
  };
  const missing = r.spaces.filter((s) => !['done', 'copied', 'locked'].includes(s.status));
  const groups = [...new Set([...changes.map((c) => c.group), ...accepted.map((a) => a.group)])];
  const nameOf = (g: string) =>
    changes.find((c) => c.group === g)?.groupName ??
    accepted.find((a) => a.group === g)?.groupName ??
    g;
  // A bed, the seats, the table or a desk the ticks leave out (the version has them): said in
  // the lead as what will happen, counted in the verdict and the bar, and asked about at Accept.
  const essentialsOut = mergeLines(
    extras
      .filter((c) => ESSENTIAL_KEY.test(c.key) && !c.itemId)
      .map((c) => ({
        key: c.key,
        text: c.text,
        says: peopleWords(c.text, card.input.brief),
        roomId: c.roomId ?? null,
      })),
  ).map((l) => `${willHave(l.says).replace(/\.$/, '')}: its row isn’t ticked.`);
  publishTickedOut(card.key, essentialsOut.length);
  // The rest of what the ticks fail together: the Checks row's own line.
  const otherExtras = extras.filter((c) => !(ESSENTIAL_KEY.test(c.key) && !c.itemId));
  // One verdict for the card, from the one list (and the must-haves its ticks leave out).
  const one = cardVerdict(
    [
      ...rep.failures.map((f) => ({ key: f.key })),
      ...essentialsOut.map((_, i) => ({ key: `ticked-out|${i}` })),
    ],
    [],
    waivedKeys,
    ruleCount,
  );
  const failingLine = report || !running ? { text: one.text, tone: one.tone } : null;
  // What the app did itself (free): the pieces it placed, and its vetting lines.
  const did = [...freeLines(changes, r, ticked), ...(card.option?.appLines ?? [])];
  const missedLines = [...essentialsOut, ...(offer?.missed ?? []).map((m) => m.text)];
  const freeButton =
    offer && offer.added.length > 0 ? (
      <button
        type="button"
        className="btn talk-free-btn"
        data-free-fix=""
        disabled={!!freeBusy || accepting}
        onClick={() => {
          void placeFree(card).then((line) => {
            if (!line) return;
            requestAnimationFrame(() =>
              focusInLog(document.querySelector<HTMLButtonElement>(`[data-undo-free="${line}"]`)),
            );
          });
        }}
      >
        {freeBusy === card.key ? 'Placing…' : freeLabel(offer)}
      </button>
    ) : null;
  // The lead: how this version was checked, above the summary ("did it work?" comes first).
  const lead =
    !running &&
    card.status !== 'failed' &&
    !!failingLine &&
    (hasLead(rep) || did.length > 0 || missedLines.length > 0 || !!freeButton);
  const verdict = running ? 'Checking…' : (failingLine?.text ?? 'Checking…');
  const title =
    card.input.concept?.summary ||
    Object.values(card.input.spaces)
      .map((s) => s.design?.summary ?? '')
      .filter(Boolean)
      .join(' ');
  const cantDesign = !ai || !!cannotDesign(ai);
  const head = (
    <div className="talk-card-head">
      <h3 className="talk-card-title" id={`card-${card.key}`}>
        {card.title} · {headLabel(project, card)}
      </h3>
      {card.status !== 'failed' && (
        <button
          type="button"
          className={onPlan ? 'btn btn-small talk-onplan on' : 'btn btn-small talk-onplan'}
          aria-pressed={onPlan}
          aria-label={`Show ${card.title} on the plan`}
          onClick={() => {
            // Pressed only while the plan really shows it (Esc or a walk may have ended it).
            if (onPlan) {
              useTalk.setState({ shown: null });
              useDesigner.setState({ previewing: false });
            } else {
              useTalk.setState({ shown: card.key });
              useDesigner.setState({ previewing: true });
            }
          }}
        >
          {onPlan ? 'On the plan' : 'Show on plan'}
        </button>
      )}
    </div>
  );

  // What the folded line will say (with what is in the renovation then, as the record has it).
  verdicts.set(card.key, {
    text: verdict,
    total: accepted.length + changes.length,
    rules: rulesKey,
  });
  if (!expanded) {
    return (
      <article className="talk-card talk-card-folded" aria-labelledby={`card-${card.key}`}>
        <button
          type="button"
          className="talk-card-fold"
          id={`card-${card.key}`}
          aria-expanded={false}
          onClick={() => setExpanded(true)}
        >
          <span>
            {card.title} · {headLabel(project, card)}
            {foldedLine(card, rulesKey)}
          </span>
          <span className="talk-fold-show" aria-hidden="true">
            Show ›
          </span>
        </button>
      </article>
    );
  }

  const tickedN = ticked.length;
  const progress = live?.state.steps ?? [];
  return (
    <article
      className="talk-card"
      aria-labelledby={`card-${card.key}`}
      data-card={card.key}
      id={`panel-${card.key}`}
    >
      {head}
      {tabs}
      {lead && (
        <CheckLead
          cardKey={card.key}
          report={rep}
          did={did}
          missed={missedLines}
          action={freeButton}
        />
      )}
      {title && <p className="talk-card-summary">{keepTogether(title)}</p>}
      {card.words.trim() && <p className="talk-card-words">Your words: “{card.words.trim()}”</p>}
      {!running && card.status !== 'failed' && card.option?.addresses?.length ? (
        <SetOutToFix addresses={card.option.addresses} report={rep} />
      ) : null}
      {planMoved(project, card) && !card.accepted.length && (
        <p className="field-hint">Made on your plan as it was; checked again on it as it is now.</p>
      )}
      {running && live && <TimeLeftLine live={live} />}
      {running && !live && resume && <ResumeNote cardKey={card.key} view={resume} busy={busy} />}
      {running && (
        <ol className="talk-progress" aria-label="Progress">
          {progress.map((st) => (
            <li key={st.key} className={`talk-progress-${st.status}`}>
              <span className="talk-progress-mark" aria-hidden="true">
                {st.status === 'done' ? (
                  <Mark kind="check" />
                ) : st.status === 'failed' ? (
                  <Mark kind="warn" />
                ) : st.status === 'running' ? (
                  <Mark kind="dot" />
                ) : null}
              </span>
              {st.label} ·{' '}
              {st.status === 'done'
                ? 'Placed and checked'
                : st.status === 'running'
                  ? st.wait?.away
                    ? typeof navigator !== 'undefined' && navigator.onLine === false
                      ? 'Waiting for the connection…'
                      : 'Paused while you’re away; it carries on when you’re back'
                    : st.wait
                      ? `${st.wait.net ? 'Connection dropped; trying again' : st.wait.server ? 'The provider had a problem; trying again' : 'Busy; trying again'} in ${st.wait.seconds} s (${st.wait.attempt} of ${st.wait.server ? 1 : 2})`
                      : st.fixing
                        ? `Checking… fixing ${plural(st.fixing.problems, 'problem')}`
                        : 'Placing…'
                  : st.status === 'failed'
                    ? (st.error ?? 'Didn’t work')
                    : 'Waiting'}
            </li>
          ))}
        </ol>
      )}
      {live?.paused && (
        <div className="talk-limit notice-warning" role="alert">
          <p>
            {live.pausedBy === 'tab'
              ? 'You’ve reached your limit for this tab.'
              : `The next step may take this design past what it was priced at (${usd(live.approved ?? 0)}).`}{' '}
            It has used {usd(live.state.usage.reduce((t, u) => t + (u.usd ?? 0), 0))} so far
            {live.remaining !== null
              ? `; finishing it may take up to ${usd(live.remaining)} more.`
              : '.'}
          </p>
          <div className="button-row">
            <button type="button" className="btn btn-small" onClick={() => live.paused?.(false)}>
              Stop here, keep what’s done
            </button>
            <button type="button" className="btn btn-small" onClick={() => live.paused?.(true)}>
              Finish the design
            </button>
          </div>
        </div>
      )}
      {card.status === 'failed' && (
        // An alert only for what the person must act on (a key, a quota, the limit, UX §10);
        // a server's trouble is said politely.
        <div
          className="talk-failed"
          {...(/key|quota|credit|limit/i.test(card.note ?? '') ? { role: 'alert' } : {})}
        >
          <p className="talk-card-note negative">
            {card.note ?? 'The design didn’t work.'} Nothing was designed.
          </p>
          <p className="talk-card-note">
            {spentOf(card.usage).usd
              ? `About ${usd(spentOf(card.usage).usd ?? 0)} may have been billed for it.`
              : 'Nothing was billed for it.'}
          </p>
          {card.proposal && another && (
            <button
              type="button"
              className="btn btn-small"
              disabled={busy}
              data-spends=""
              onClick={() => card.proposal && void pressScope(card.proposal.scope)}
            >
              Try again{another.usd ? ` · about ${usd(another.usd.typical)}` : ''}
            </button>
          )}
        </div>
      )}
      {!running && card.status !== 'failed' && changes.length === 0 && !accepted.length && (
        <p className="talk-card-note">No changes from your plan as it is.</p>
      )}
      {(card.status === 'stopped' || stale) && missing.length > 0 && (
        <div className="talk-stopped">
          <p>
            {card.note ? `${card.note} ` : ''}Stopped before {missing.map((s) => s.name).join(', ')}{' '}
            {missing.length === 1 ? 'was' : 'were'} placed. What’s here is checked.
          </p>
          {card.proposal &&
            missing.map((s) => {
              const est = card.proposal
                ? finishPrice(card.proposal, card.option?.letter ?? 'A', [s.key])
                : null;
              return (
                <button
                  key={s.key}
                  type="button"
                  className="link-btn"
                  disabled={busy || cantDesign}
                  onClick={() =>
                    card.proposal &&
                    void finishRooms(card.proposal, card.option?.letter ?? 'A', [s.key])
                  }
                >
                  Design {s.name} too{est?.usd ? ` · about ${usd(est.usd.typical)}` : ''}
                </button>
              );
            })}
        </div>
      )}
      {(changes.length > 0 || accepted.length > 0) && (
        <div
          className="talk-changes"
          ref={rowsRef}
          onPointerDown={(e) => {
            if (onSwipe && e.pointerType !== 'mouse')
              swipe.current = { x: e.clientX, y: e.clientY };
          }}
          onPointerUp={(e) => {
            const s0 = swipe.current;
            swipe.current = null;
            if (!s0 || !onSwipe) return;
            const dx = e.clientX - s0.x;
            const dy = e.clientY - s0.y;
            if (Math.abs(dx) >= 60 && Math.abs(dx) > Math.abs(dy) * 1.5) onSwipe(dx < 0 ? 1 : -1);
          }}
          onPointerCancel={() => {
            swipe.current = null;
          }}
        >
          <div className="talk-changes-head">
            <h4>Changes</h4>
            <span className="muted num">
              {allIn
                ? 'In your renovation'
                : accepted.length
                  ? `${accepted.length} of ${accepted.length + changes.length} changes in your renovation`
                  : `${tickedN} of ${changes.length} ticked`}
            </span>
          </div>
          {groups.map((g) => {
            const rows = changes.filter((c) => c.group === g);
            const done = accepted.filter((a) => a.group === g);
            const on = rows.filter((c) => ticked.includes(c.id)).length;
            const tickable = rows.filter(
              (c) => c.waivable && (!c.needsWalls || ticked.includes('walls')),
            );
            const gname = nameOf(g);
            return (
              <section key={g} className="talk-group" aria-label={gname}>
                <div className="talk-group-head">
                  {rows.length > 0 && (
                    // biome-ignore lint/a11y/noLabelWithoutControl: the checkbox is GroupTick's
                    <label className="talk-tick-cell">
                      <GroupTick
                        checked={on > 0 && on === rows.length}
                        mixed={on > 0 && on < rows.length}
                        disabled={running || !tickable.length}
                        label={`Accept all of ${gname}`}
                        onChange={(v) => {
                          const set = new Set(ticked);
                          for (const c of rows) {
                            if (!v) set.delete(c.id);
                            else if (!c.checks.length && (!c.needsWalls || set.has('walls')))
                              set.add(c.id);
                          }
                          setTicked([...set]);
                        }}
                      />
                    </label>
                  )}
                  <span className="talk-group-name">
                    {gname}{' '}
                    <span className="muted num">
                      ({on === rows.length ? rows.length : `${on} of ${rows.length}`})
                    </span>
                  </span>
                </div>
                <ul className="talk-rows">
                  {rows.map((c) => {
                    const isOn = ticked.includes(c.id);
                    const blocked = c.needsWalls && !ticked.includes('walls');
                    const fail = c.checks
                      .map((key) => checkText.get(key))
                      .filter((x): x is ResultCheck => !!x);
                    const opened = openRow === c.id || whyAll;
                    // A piece the app placed itself: tagged, and said to a screen reader too.
                    const byApp = isAppChange(c, r);
                    const appSaid = byApp ? ', placed by the app, free' : '';
                    const lit =
                      hover === c.id ||
                      (!!planHover && [...c.items.target, ...c.items.now].includes(planHover));
                    return (
                      <li
                        key={c.id}
                        className={`talk-row${lit ? ' lit' : ''}${fail.length ? ' failing' : ''}`}
                        data-change-id={c.id}
                        onMouseEnter={() =>
                          useTalk.setState({ hover: { card: card.key, change: c.id } })
                        }
                        onMouseLeave={() => useTalk.setState({ hover: null })}
                        onFocus={() =>
                          useTalk.setState({ hover: { card: card.key, change: c.id } })
                        }
                        onBlur={() => useTalk.setState({ hover: null })}
                      >
                        {c.waivable ? (
                          <label className="talk-tick-cell">
                            <input
                              type="checkbox"
                              className="talk-tick"
                              checked={isOn}
                              disabled={running || blocked}
                              aria-label={`Accept: ${c.text}${appSaid}`}
                              onChange={(e) => toggle(c, e.target.checked)}
                            />
                          </label>
                        ) : (
                          <span className="talk-tick-cell" aria-hidden="true" />
                        )}
                        <div className="talk-row-body">
                          <button
                            type="button"
                            className="talk-row-text"
                            aria-expanded={opened}
                            aria-label={`Why: ${c.text}${appSaid}`}
                            onClick={() =>
                              useTalk.setState({
                                open: opened ? null : { card: card.key, change: c.id },
                              })
                            }
                          >
                            <span>
                              {byApp && (
                                <>
                                  <span className="talk-kept-tag talk-app-tag" data-by-app="">
                                    By the app
                                  </span>{' '}
                                </>
                              )}
                              {keepTogether(c.text)}
                              {keptIds.some((k) => c.items.target.includes(k)) && (
                                <span className="talk-kept-tag"> Kept</span>
                              )}
                            </span>
                            <span className="talk-row-why" aria-hidden="true">
                              ›
                            </span>
                          </button>
                          {c.verb === 'walls' && (
                            <ul className="talk-wall-rows">
                              {c.rows.map((x) => (
                                <li key={x}>{keepTogether(x)}</li>
                              ))}
                            </ul>
                          )}
                          {opened && (
                            <p className="talk-reason">
                              {c.why
                                ? keepTogether(c.why)
                                : 'The designer gave no reason for this one.'}
                            </p>
                          )}
                          {blocked && (
                            <p className="talk-row-sub">Needs the walls from {card.title}</p>
                          )}
                          {fail.length > 0 && !c.waivable && (
                            <p className="talk-row-sub negative">
                              HDB rule: can’t be accepted. Ask the designer for another way.
                            </p>
                          )}
                          {fail.map((f) => (
                            <p key={f.key} className="talk-row-sub negative">
                              {isOn ? 'Accepted anyway: ' : 'Doesn’t pass: '}
                              {keepTogether(midLine(f.text))}
                            </p>
                          ))}
                          {confirm === c.id && (
                            <div className="talk-confirm notice-warning">
                              <p>{askLine(fail, card.input.brief)}</p>
                              <div className="button-row">
                                <button
                                  type="button"
                                  className="btn btn-small"
                                  onClick={() => {
                                    setWaive([
                                      ...waive,
                                      ...fail.map((f) => ({ key: f.key, text: f.text })),
                                    ]);
                                    setTicked([...new Set([...ticked, c.id])]);
                                    setConfirm(null);
                                  }}
                                >
                                  Accept anyway
                                </button>
                                <button
                                  type="button"
                                  className="btn btn-small"
                                  onClick={() => setConfirm(null)}
                                >
                                  Keep it out
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      </li>
                    );
                  })}
                  {done.map((a) => (
                    <li key={a.id} className="talk-row talk-row-in">
                      <span className="talk-tick-cell talk-in-mark">
                        <Mark kind="check" />
                      </span>
                      <div className="talk-row-body">
                        <span className="talk-row-done">{keepTogether(a.text)}</span>
                        <span className="visually-hidden">: in your renovation</span>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
      {!running && card.status !== 'failed' && (changes.length > 0 || accepted.length > 0) && (
        <dl className="talk-lens">
          <div>
            <dt>Checks</dt>
            <dd
              className={
                failingLine?.tone === 'fail'
                  ? 'negative'
                  : failingLine?.tone === 'waived'
                    ? 'advise'
                    : ''
              }
            >
              {failingLine?.tone === 'pass' && !otherExtras.length && <Mark kind="check" />}
              {/* The version passes, what is ticked doesn't: said plainly, never ✓ over red. */}
              {failingLine?.tone === 'pass' && otherExtras.length
                ? 'The design passes as a whole'
                : verdict}
              {lead && rep.failures.length + essentialsOut.length > 0 && (
                <span className="muted"> · listed above</span>
              )}
              {otherExtras.length > 0 && (
                <div className="talk-ticked-extra" data-ticked-extra="">
                  <p className="negative">
                    {rep.failures.length
                      ? 'What you ticked also fails, together:'
                      : 'What you ticked fails, together:'}
                  </p>
                  <ul className="talk-room-fails">
                    {otherExtras.map((c) => (
                      <li key={c.key} className="negative">
                        {keepTogether(peopleWords(c.text, card.input.brief))}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {fails.already.length > 0 && (
                <details className="talk-already">
                  <summary>Already in your plan: {fails.already.length}</summary>
                  <ul>
                    {fails.already.map((c) => (
                      <li key={c.key}>{keepTogether(c.text)}</li>
                    ))}
                  </ul>
                </details>
              )}
            </dd>
          </div>
          {elecNotes.length > 0 && (
            <div>
              <dt>Electrical</dt>
              <dd className="advise">
                <details className="talk-already">
                  <summary>{plural(elecNotes.length, 'note')} on new points</summary>
                  <ul>
                    {[...new Set(elecNotes)].map((n) => (
                      <li key={n}>{n}</li>
                    ))}
                  </ul>
                </details>
              </dd>
            </div>
          )}
          {storage?.line && (
            <div data-lens="storage">
              <dt>{storage.title}</dt>
              <dd>
                <span className={storage.tone === 'short' ? 'advise' : undefined}>
                  {lensLine(storage.line)}
                </span>
                <OwnsChips
                  amount={(storage.facts as { amount?: StorageAmount }).amount ?? 'typical'}
                  projectId={project.id}
                />
                {storage.lines.length > 0 && (
                  <details className="talk-already">
                    <summary>How it is measured</summary>
                    <ul>
                      {storage.lines.map((l) => (
                        <li key={l.text}>{keepTogether(l.text)}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </dd>
            </div>
          )}
          {report && (
            <div>
              <dt>Cost</dt>
              <dd className={report.budget === 'over' ? 'num negative' : 'num'}>
                {report.delta === 0
                  ? 'No renovation work in what is ticked (furniture isn’t priced)'
                  : `${report.delta > 0 ? '+' : '−'}${sgd(report.delta)} renovation work`}
                {` · about S$${kRange(report.cost.low, report.cost.high)} in total`}
                {card.input.brief.budget
                  ? report.budget === 'over'
                    ? ` · over your S$${k(card.input.brief.budget.high)}`
                    : ` · within S$${k(card.input.brief.budget.high)}`
                  : ''}
              </dd>
            </div>
          )}
        </dl>
      )}
      {onPlan && !tipSeen && (
        <p className="talk-app-line talk-tip">
          <span className="talk-app-icon">
            <Mark kind="dot" />
          </span>
          <span className="talk-app-text">
            <span>
              {window.matchMedia?.('(pointer: coarse)').matches
                ? 'Tap a piece on the plan to comment on it or ask why it’s there. Press and hold empty floor to point at a spot.'
                : 'Click a piece on the plan to comment on it or ask why it’s there. Right-click empty floor to point at a spot.'}
            </span>
            <button
              type="button"
              className="link-btn"
              onClick={() => void act({ type: 'tipSeen', tip: 'point' })}
            >
              Got it
            </button>
          </span>
        </p>
      )}
      {!allIn && card.status !== 'failed' && (changes.length > 0 || running) && (
        <div className="talk-actions">
          <button
            ref={acceptBtn}
            type="button"
            className="btn btn-primary"
            data-accept-selected=""
            disabled={running || accepting || tickedN === 0}
            aria-describedby={`acc-${card.key}`}
            onClick={() => {
              // Worked out now, never from a check still pending: what the ticked changes fail
              // together is asked about first, and an HDB rule refused.
              void precheckNow(
                card,
                ticked,
                waive.map((w) => w.key),
              ).then((pre) => {
                if (!pre) return;
                if (pre.failing.length) {
                  setAsking({ checks: pre.failing, hdb: pre.hdb });
                  return;
                }
                void accept(waive);
              });
            }}
          >
            Accept selected ({tickedN})
          </button>
          {asking && (
            <div className="talk-confirm notice-warning" role="alert">
              {asking.hdb ? (
                <p>
                  HDB rule: these changes together can’t be accepted.{' '}
                  {asking.checks
                    .filter((c) => !c.waivable)
                    .map((c) => c.text)
                    .join('; ')}
                </p>
              ) : (
                <p>{askLine(asking.checks, card.input.brief)}</p>
              )}
              <div className="button-row">
                {!asking.hdb && (
                  <button
                    type="button"
                    className="btn btn-small"
                    disabled={accepting}
                    onClick={() => {
                      const more = asking.checks.map((c) => ({ key: c.key, text: c.text }));
                      setAsking(null);
                      void accept([...waive, ...more]);
                    }}
                  >
                    Accept anyway
                  </button>
                )}
                <button type="button" className="btn btn-small" onClick={() => setAsking(null)}>
                  {asking.hdb ? 'Back' : 'Keep it out'}
                </button>
              </div>
            </div>
          )}
          <span id={`acc-${card.key}`} className="field-hint">
            {running
              ? 'Accept waits for the checks'
              : tickedN === 0
                ? 'Tick the changes you want'
                : ''}
          </span>
        </div>
      )}
      {!running && (
        <div className="talk-card-foot">
          <span className="talk-card-links">
            {comparable && versionId && (
              <button
                type="button"
                className="link-btn"
                data-compare-open=""
                onClick={() => openCompare(versionId)}
              >
                Compare
              </button>
            )}
            {card.status !== 'failed' && (
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  useTalk.setState({ shown: card.key });
                  useDesigner.setState({ previewing: true });
                  useEditor.getState().setViewMode('3d');
                }}
              >
                Show in 3D
              </button>
            )}
            <span className="talk-more">
              <button
                type="button"
                className="link-btn"
                aria-expanded={more}
                aria-label="More"
                onClick={() => setMore(!more)}
              >
                ⋯
              </button>
              {more && (
                <span className="talk-menu" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMore(false);
                      setWrong(true);
                    }}
                  >
                    This is wrong
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMore(false);
                      const text = [
                        `${card.title} · ${card.label}`,
                        ...changes.map((c) => `- ${c.text}`),
                      ].join('\n');
                      void navigator.clipboard?.writeText(text).then(
                        () =>
                          useStore.setState({
                            toast: { text: 'Copied the change list.', at: Date.now() },
                          }),
                        () => {},
                      );
                    }}
                  >
                    Copy the change list
                  </button>
                </span>
              )}
            </span>
          </span>
          {!newest && card.status !== 'failed' && (
            <button
              type="button"
              className="link-btn"
              data-bring-back=""
              disabled={busy}
              onClick={() => void bringBackCard(card)}
            >
              Bring this back
            </button>
          )}
          {card.proposal && another && card.status !== 'failed' && (
            <button
              type="button"
              className="link-btn"
              disabled={busy}
              data-spends=""
              onClick={() => card.proposal && void pressAnother(card.proposal)}
            >
              Another idea{another.usd ? ` · about ${usd(another.usd.typical)}` : ''}
            </button>
          )}
          <TurnCost
            usage={card.usage}
            fixes={Object.values(card.input.spaces).reduce((t, x) => t + (x.fixes ?? 0), 0)}
            atMost
            names={{
              layout: 'The layout',
              ...Object.fromEntries(Object.entries(card.input.spaces).map(([k, x]) => [k, x.name])),
            }}
          />
        </div>
      )}
      {wrong && card.design && (
        <CaseDialog
          d={card.design}
          r={r}
          model={card.usage[0]?.model ?? null}
          title={card.title}
          onClose={() => setWrong(false)}
        />
      )}
      {wrong && !card.design && card.proposal && card.option && (
        <CaseDialog
          d={{
            id: card.option.designId,
            projectId: card.proposal.projectId,
            levelId: card.levelId,
            n: card.n,
            name: card.label,
            parent: null,
            createdAt: card.at,
            base: card.option.base,
            baseLevel: nowOf(project, card.levelId)?.now ?? r.level,
            brief: card.option.brief,
            request: { scope: { kind: 'all' }, feedback: card.words, locks: card.option.locks },
            aliases: card.option.aliases,
            concept: card.option.concept,
            spaces: card.option.spaces,
            usage: card.option.usage,
            waivers: card.option.waivers,
            accepted: null,
          }}
          r={r}
          model={card.usage[0]?.model ?? null}
          title={card.title}
          onClose={() => setWrong(false)}
        />
      )}
    </article>
  );
});
