import {
  type Conversation,
  FIX_PER_RUN,
  type Level,
  type Proposal,
  type QuestionKey,
  type ScopeRef,
  TALK_LIMITS,
  type Turn,
  type TurnOf,
  cut,
  meetingOver,
  optionTitle,
  questionText,
  roomArea,
  sleepingConflict,
  spacesOf,
} from '@dhd/core';
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useProject, useStore } from '../../../store';
import { useAi } from '../../credentials';
import { CostCheck } from '../CostCheck';
import { useResultsTickN } from '../results';
import { capUsd, usd, useSpend } from '../spend';
import { useDesigner } from '../state';
import { designerCannotUse } from '../stream';
import { FactEditor } from './Facts';
import { Mark, type MarkKind } from './Mark';
import { ProposalTurn } from './Options';
import { ProposalCard } from './ProposalCard';
import { ReplyParts, ReplyText, SentState, Streaming } from './Talk';
import { lineState, redoLine, undoLine } from './accept';
import { type CardModel, designCard, earlierDesign, nowOf, optionCard } from './cards';
import { dayMark } from './days';
import {
  answerCost,
  cardRequest,
  pressPrice,
  pressPriceState,
  pressScope,
  scopeRequest,
} from './propose';
import { toNewest } from './scroll';
import { timed, useSettledProject } from './settle';
import { lineTitle, versionTitle } from './titles';
import {
  act,
  designLevelId,
  newId,
  nowIso,
  talkLevel,
  useBusy,
  useLevelGone,
  useTalk,
} from './useTalk';

/**
 * The conversation's log (UX §5.3, §6): your turns in a bubble on the right, the designer's
 * plain text, the app's own questions with their widgets, the scope offer, cost cards,
 * proposal cards and app lines. Newest at the foot; it stays at the foot only if you were.
 */

const areaOf = (level: Level, rooms: string[]) =>
  rooms.reduce((t, id) => {
    const r = level.rooms[id];
    return t + (r ? roomArea(level, r) : 0);
  }, 0);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Changes made by hand, said once (UX §6.6): "You moved the 3-seat sofa yourself; it stays
 * where you put it." A label is "3-seat sofa (moved)".
 */
export function handText(lines: readonly string[], more: number): string {
  const one = (l: string) => {
    const m = /^(.*) \((moved|resized|added|removed|repainted)\)$/.exec(l);
    return m ? { what: m[1] as string, how: m[2] as string } : { what: l, how: 'changed' };
  };
  const items = lines.map(one);
  const first = items[0];
  if (items.length === 1 && !more && first) {
    const it =
      first.how === 'removed'
        ? 'it stays out'
        : first.how === 'moved' || first.how === 'added'
          ? 'it stays where you put it'
          : 'it stays as you made it';
    return `You ${first.how} the ${first.what.charAt(0).toLowerCase()}${first.what.slice(1)} yourself; ${it}.`;
  }
  const list = items.map((x) => `${x.what.charAt(0).toLowerCase()}${x.what.slice(1)} (${x.how})`);
  return `You changed these yourself: ${list.join(', ')}${more ? ` and ${more} more` : ''}. They stay as you left them.`;
}
function Person({ t }: { t: TurnOf<'person'> }) {
  return (
    <article className="talk-turn talk-you" aria-labelledby={`h-${t.id}`}>
      <h3 id={`h-${t.id}`} className="visually-hidden">
        You said
      </h3>
      <p className="talk-bubble" title={new Date(t.at).toLocaleString()}>
        {t.text}
      </p>
      <SentState t={t} />
    </article>
  );
}

function Designer({ t, named }: { t: TurnOf<'designer'>; named: boolean }) {
  return (
    <article className="talk-turn talk-designer" aria-labelledby={`h-${t.id}`}>
      <h3 id={`h-${t.id}`} className={named ? 'talk-name' : 'visually-hidden'}>
        Designer
        <span className="visually-hidden"> said</span>
      </h3>
      {t.talk ? <ReplyText text={t.text} /> : <p className="talk-text">{t.text}</p>}
      {t.lines.length > 0 && (
        <ul className="talk-lines">
          {t.lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
      {t.after && <p className="talk-text">{t.after}</p>}
      <ReplyParts t={t} />
    </article>
  );
}

function Questions({ t, latest }: { t: TurnOf<'app-question'>; latest: boolean }) {
  const conv = useTalk((s) => s.conv) as Conversation;
  const level = talkLevel();
  const [focusNext, setFocusNext] = useState(false);
  if (!level) return null;
  const open = t.keys.filter((k) => !t.done[k]);
  const answer = async (key: QuestionKey, brief: Conversation['brief']) => {
    const more = open.length > 1;
    await act({ type: 'answer', turnId: t.id, key, brief, at: nowIso(), id: newId('turn'), level });
    setFocusNext(more);
    if (!more) {
      requestAnimationFrame(() => {
        const next = document.querySelector<HTMLElement>(
          '.talk-log .talk-question:last-of-type [role="radio"], .talk-log .talk-question:last-of-type button, .talk-composer textarea',
        );
        next?.focus({ preventScroll: true });
      });
    }
  };
  return (
    <article className="talk-turn talk-designer" aria-labelledby={`h-${t.id}`}>
      <h3 id={`h-${t.id}`} className="visually-hidden">
        Designer asked
      </h3>
      {t.lead && <p className="talk-text talk-lead">{t.lead}</p>}
      <div className="talk-question">
        {t.keys.map((k) => {
          const done = t.done[k];
          return (
            <section key={k} className="talk-q" aria-label={questionText(k, conv.brief)}>
              <h4 className="talk-q-label">{questionText(k, conv.brief)}</h4>
              {done ? (
                <div className="talk-answer">
                  <p className="talk-bubble">{done.words}</p>
                  {done.state !== 'assumed' && (
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => useTalk.setState({ view: 'know', knowAt: k })}
                    >
                      Change
                    </button>
                  )}
                </div>
              ) : (
                <FactEditor
                  k={k}
                  brief={conv.brief}
                  level={level}
                  autoFocus={focusNext && k === open[0]}
                  onDone={(update) => {
                    const cur = useTalk.getState().conv?.brief ?? conv.brief;
                    void answer(k, update(cur));
                  }}
                />
              )}
            </section>
          );
        })}
        {open.length > 0 &&
          latest &&
          !(t.keys.includes('sleeping') && t.lead && open.includes('sleeping')) && (
            <div className="talk-q-foot">
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  for (const k of open) {
                    void act({
                      type: 'skip',
                      turnId: t.id,
                      key: k,
                      at: nowIso(),
                      id: newId('turn'),
                      level,
                    });
                  }
                }}
              >
                Skip
              </button>
            </div>
          )}
      </div>
    </article>
  );
}

/** The priced scope buttons: the whole flat, then each space (UX §8.4). */
function Scope({ t, latest }: { t: TurnOf<'scope'>; latest: boolean }) {
  // Off the drag path: worked out once edits pause.
  const project = useSettledProject();
  const conv = useTalk((s) => s.conv) as Conversation;
  const ai = useAi();
  const busy = useBusy();
  const { prices } = useSpend();
  // The level the conversation designs (on the settled plan).
  const level = nowOf(project, designLevelId())?.now;
  const scopes = useMemo<ScopeRef[]>(
    () =>
      level
        ? [
            { label: 'The whole flat', spaces: [], all: true },
            ...spacesOf(level).map((s) => ({
              label: cut(s.name, TALK_LIMITS.label),
              spaces: [s.key],
              all: false,
            })),
          ]
        : [],
    [level],
  );
  // Prices without the person's words (they add little), once per plan, brief, versions (an
  // accept or its Undo changes what a press would do) and prices.
  const tick = useResultsTickN();
  const designs = useDesigner((s) => s.designs);
  // biome-ignore lint/correctness/useExhaustiveDependencies: on what the prices read
  const priced = useMemo(
    () =>
      latest && ai
        ? timed(() => scopes.map((s) => ({ s, ...pressPriceState(scopeRequest(s)) })))
        : [],
    [latest, ai, scopes, conv.brief, prices, project, tick, designs],
  );
  const conflict = level ? sleepingConflict(conv.brief, level) : null;
  const cant = ai && designerCannotUse(ai);
  // Its level gone from the plan: nothing to offer (the panel says why).
  const gone = useLevelGone();
  return (
    <article className="talk-turn talk-designer" aria-labelledby={`h-${t.id}`}>
      <h3 id={`h-${t.id}`} className="visually-hidden">
        Designer asked
      </h3>
      <p className="talk-text">{t.next ? 'Where next?' : 'Where shall we start?'}</p>
      {latest && !ai && (
        <p className="field-hint">
          Add your AI key to start designing ·{' '}
          <button
            type="button"
            className="link-btn"
            onClick={() => useTalk.setState({ settings: 'key' })}
          >
            AI settings
          </button>
        </p>
      )}
      {latest && cant && <p className="field-hint">{cant}</p>}
      {latest && conflict && (
        <p className="field-hint negative">
          {conflict.bedrooms === 0
            ? 'Nobody has a bed yet: your plan has no bedroom. Say which rooms people sleep in first. '
            : 'Answer who sleeps where first. '}
          <button
            type="button"
            className="link-btn"
            onClick={() => useTalk.setState({ view: 'know', knowAt: 'sleeping' })}
          >
            Who sleeps where
          </button>
        </p>
      )}
      {latest && ai && !cant && !gone && (
        <ul className="talk-scopes">
          {priced.map(({ s, est, pending }) => (
            <li key={s.label}>
              <button
                type="button"
                className="btn talk-scope"
                data-spends=""
                disabled={busy || !!conflict || !est}
                onClick={() => void pressScope(s)}
              >
                {s.label}
                {est?.usd ? (
                  ` · about ${usd(est.usd.typical)}`
                ) : est ? (
                  ` · about ${Math.round(est.tokens.typical).toLocaleString('en-US')} tokens`
                ) : pending ? (
                  // Being priced: a skeleton where the figure goes (it can't be pressed yet).
                  <span className="talk-price-skeleton" aria-label=", pricing" />
                ) : (
                  ''
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      {latest && ai && !cant && !gone && (
        <p className="talk-text muted">
          Or tell me what you’d like below; your words go with the room you pick.
        </p>
      )}
    </article>
  );
}

function CostAsk({ t }: { t: TurnOf<'cost-ask'> }) {
  const ai = useAi();
  const busy = useBusy();
  const project = useSettledProject();
  const { prices } = useSpend();
  // The level the conversation designs (on the settled plan).
  const level = nowOf(project, designLevelId())?.now;
  const first = useMemo<ScopeRef | null>(() => {
    if (t.just) return t.just;
    if (!t.scope.all || !level) return null;
    // The largest space first (the living room, as a rule): the one most worth starting with.
    const s = [...spacesOf(level)].sort(
      (p, q) => areaOf(level, q.rooms) - areaOf(level, p.rooms),
    )[0];
    return s ? { label: s.name, spaces: [s.key], all: false } : null;
  }, [t.scope.all, t.just, level]);
  const open = t.state === 'open';
  // The price as it is now: the card's figure follows it, so the sentence and the cost check
  // below always say the same (and Go ahead binds what they say).
  const tick = useResultsTickN();
  // biome-ignore lint/correctness/useExhaustiveDependencies: on what the prices read
  const est = useMemo(
    () => (open ? timed(() => pressPrice(cardRequest(t))) : null),
    [open, t.scope, t.words, t.finish, project, prices, ai, tick],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: on what the prices read
  const cheaper = useMemo(
    () => (open && first ? timed(() => pressPrice(cardRequest(t, first))) : null),
    [open, first, t.words, project, prices, ai, tick],
  );
  useEffect(() => {
    const u = est?.usd;
    if (!open || !u) return;
    const now = { typical: u.typical, high: u.high, fix: u.fix };
    if (JSON.stringify(now) !== JSON.stringify(t.estimate)) {
      void act({ type: 'costRefresh', turnId: t.id, estimate: now });
    }
  }, [open, est, t.estimate, t.id]);
  const cap = capUsd();
  const what = t.talk
    ? `“${t.talk.title}” (${t.scope.all ? 'the whole flat' : t.scope.label})`
    : t.scope.all
      ? 'Designing the whole flat'
      : `Designing ${t.scope.label}`;
  // Answered: your bubble says it ("Not now"), and the card that follows shows the run.
  if (t.state !== 'open') return null;
  return (
    <article className="talk-turn talk-app talk-card talk-cost-card" aria-labelledby={`h-${t.id}`}>
      <h3 id={`h-${t.id}`} className="visually-hidden">
        App: before spending
      </h3>
      {t.reason === 'ask-limit' && cap !== null && (
        <p className="notice-warning">This would pass your {usd(cap)} limit for this tab.</p>
      )}
      {t.estimate && (
        <p className="talk-text">
          {what} takes about {usd(t.estimate.typical)} (at most{' '}
          {usd(t.estimate.high + t.estimate.fix)}
          {t.estimate.fix > 0
            ? `, up to ${est?.fixes ?? FIX_PER_RUN} fix-up${(est?.fixes ?? FIX_PER_RUN) === 1 ? '' : 's'} included`
            : ''}
          ). Go ahead?
        </p>
      )}
      {ai && est && t.reason !== 'ask-threshold' ? (
        <div className="talk-costcheck">
          <CostCheck
            ai={ai}
            est={est}
            quality={useTalk.getState().conv?.brief.quality ?? 'thorough'}
            onQuality={(q) => {
              const c = useTalk.getState().conv;
              if (c) void act({ type: 'setBrief', brief: { ...c.brief, quality: q } });
            }}
            what={
              t.scope.all
                ? 'one for the layout and style, then one for each room'
                : `one for ${t.scope.label}`
            }
            action="Go ahead"
            anyway="Go ahead anyway"
            backLabel="Not now"
            quiet
            onBack={() => void answerCost(t, 'not-now')}
            onStart={() => void answerCost(t, 'go')}
            onEditPrices={() => useTalk.setState({ settings: 'prices' })}
          />
        </div>
      ) : (
        <div className="button-row talk-cost-buttons">
          <button
            type="button"
            className="btn"
            disabled={busy}
            data-spends=""
            onClick={() => void answerCost(t, 'go')}
          >
            Go ahead{t.estimate ? ` · about ${usd(t.estimate.typical)}` : ''}
          </button>
          <button type="button" className="link-btn" onClick={() => void answerCost(t, 'not-now')}>
            Not now
          </button>
        </div>
      )}
      {first && cheaper && (
        <button
          type="button"
          className="btn talk-cheaper"
          disabled={busy}
          data-spends=""
          onClick={() => void answerCost(t, 'cheaper', first)}
        >
          Just {first.label}
          {cheaper.usd ? ` · about ${usd(cheaper.usd.typical)}` : ''}
        </button>
      )}
    </article>
  );
}

function Event({ t }: { t: TurnOf<'event'> }) {
  const e = t.event;
  // Read again as the proposal gains options (V4 becomes V4A).
  useTalk((s) =>
    e.type === 'accepted'
      ? (s.proposals.find((p) => p.id === e.proposalId)?.options.length ?? 1)
      : 1,
  );
  const v = e.type === 'accepted' ? lineTitle(e) : '';
  // The history moves under the line: its Undo or Redo shows only while it applies.
  const history = useStore((s) => s.editor.history);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again as the history moves
  const st = useMemo(() => (e.type === 'accepted' ? lineState(t.id) : null), [e, t.id, history]);
  let text: string;
  let icon: MarkKind = 'check';
  if (e.type === 'accepted') {
    const n = e.changes.length;
    if (e.undone) {
      icon = 'undo';
      text = `Undone: the ${plural(n, 'change')} from ${v} ${n === 1 ? 'is' : 'are'} out of your renovation.`;
    } else {
      text =
        n >= e.total
          ? `You accepted ${plural(n, 'change')} from ${v}.`
          : `You accepted ${n} of ${e.total} changes from ${v}.${e.left.length ? ` Left out: ${e.left.slice(0, 3).join(', ')}${e.left.length > 3 ? ` and ${e.left.length - 3} more` : ''}.` : ''}`;
    }
  } else if (e.type === 'stopped') {
    icon = 'stop';
    text = `Stopped. What’s done is kept.${e.usd ? ` Up to about ${usd(e.usd)} may still be billed.` : ''}`;
  } else if (e.type === 'hand-edits') {
    icon = 'edit';
    text = handText(e.lines, e.more);
  } else {
    icon = e.type === 'fact' ? 'edit' : /^Couldn’t/.test(e.text) ? 'warn' : 'dot';
    text = e.text;
  }
  return (
    <article className="talk-turn talk-app" aria-labelledby={`h-${t.id}`}>
      <h3 id={`h-${t.id}`} className="visually-hidden">
        App
      </h3>
      <p className="talk-app-line">
        <span className="talk-app-icon">
          <Mark kind={icon} />
        </span>
        <span className="talk-app-text">
          <span>{text}</span>
          {st === 'undo' && (
            <button
              type="button"
              className="link-btn"
              data-undo-line={t.id}
              onClick={() => undoLine(t.id)}
            >
              Undo
            </button>
          )}
          {st === 'redo' && (
            <button
              type="button"
              className="link-btn"
              data-redo-line={t.id}
              onClick={() => redoLine(t.id)}
            >
              Redo
            </button>
          )}
        </span>
      </p>
    </article>
  );
}

const cardModels = new WeakMap<Proposal, CardModel[]>();
/** A proposal's cards, made once per version of its record. */
function cardsOf(p: Proposal): CardModel[] {
  let cs = cardModels.get(p);
  if (!cs) {
    cs = p.options.map((o) => optionCard(p, o, designLevelId()));
    cardModels.set(p, cs);
  }
  return cs;
}

/** v1's versions, folded at the top of the log ("Earlier designs (3)"). */
function Earlier({ cards }: { cards: CardModel[] }) {
  const [open, setOpen] = useState(false);
  const shownHere = useTalk((s) => cards.some((c) => c.key === s.shown));
  useEffect(() => {
    if (shownHere) setOpen(true);
  }, [shownHere]);
  if (!cards.length) return null;
  return (
    <li className="talk-earlier">
      <button
        type="button"
        className="talk-earlier-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Earlier designs ({cards.length})
      </button>
      {open && (
        <ul className="talk-earlier-list">
          {cards.map((c) => (
            <li key={c.key}>
              <p className="talk-earlier-from muted">
                {c.design?.from ? 'From an earlier conversation' : 'From the form'},{' '}
                {new Date(c.at).toLocaleDateString('en-SG', { day: 'numeric', month: 'short' })}
              </p>
              <ProposalCard card={c} newest={false} live={null} />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function Log() {
  const conv = useTalk((s) => s.conv);
  const proposals = useTalk((s) => s.proposals);
  const live = useTalk((s) => s.live);
  const designs = useDesigner((s) => s.designs);
  const list = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [behind, setBehind] = useState(false);
  const convId = conv?.id ?? null;
  const earlier = useMemo(
    () =>
      designs.filter((d) => earlierDesign(d, convId)).map((d) => designCard(d, versionTitle(d))),
    [designs, convId],
  );
  const byId = useMemo(() => new Map(proposals.map((p) => [p.id, p])), [proposals]);
  // One card model per option while its proposal is unchanged: a write to one proposal
  // re-renders its card only (cards are memoised on their models; QA P4-6).
  const cards = useMemo(
    () => new Map(proposals.map((p) => [p.id, cardsOf(p)] as const)),
    [proposals],
  );
  const newestProposal = useMemo(() => {
    const ps = (conv?.turns ?? []).filter((t) => t.kind === 'proposal');
    return ps[ps.length - 1]?.id ?? null;
  }, [conv]);
  const turns = conv?.turns ?? [];
  const lastQuestion = [...turns].reverse().find((t) => t.kind === 'app-question')?.id;
  const lastScope = [...turns].reverse().find((t) => t.kind === 'scope')?.id;
  const replyTo = useTalk((s) => s.reply?.turnId ?? null);
  // The log's own scrolls (to the newest turn) aren't the person scrolling away.
  const moved = useRef(0);
  const follow = useCallback((el: HTMLElement) => {
    moved.current = Date.now();
    toNewest(el);
  }, []);
  // Opening the panel: at the newest turn, at once.
  useLayoutEffect(() => {
    const el = list.current;
    if (el) follow(el);
  }, [follow]);
  // A new turn follows something the person did: the log goes to it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on a new turn
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    follow(el);
    pinned.current = true;
    setBehind(false);
  }, [turns.length]);
  // A run's progress: followed only if the log was at its foot.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on a run's progress
  useLayoutEffect(() => {
    const el = list.current;
    if (!el || !live) return;
    if (pinned.current) follow(el);
    else setBehind(true);
  }, [live?.state.steps, proposals]);
  // A turn changed in place (a message not answered gains its line): followed if at the foot,
  // so the newest is never cut off at the bottom (P3-1).
  const rev = useTalk((st) => st.conv?.rev ?? 0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: on each write
  useLayoutEffect(() => {
    const el = list.current;
    if (el && pinned.current) follow(el);
  }, [rev]);
  // A reply streaming in: followed only if the log was at its foot.
  const replySay = useTalk((st) => st.reply?.say.length ?? 0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: on the reply's text
  useLayoutEffect(() => {
    const el = list.current;
    if (!el || !replySay) return;
    if (pinned.current) follow(el);
    else setBehind(true);
  }, [replySay]);
  useEffect(() => {
    const el = list.current;
    if (!el) return;
    const on = () => {
      if (Date.now() - moved.current < 100) return; // our own scroll, not the person's
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      if (pinned.current) setBehind(false);
    };
    el.addEventListener('scroll', on, { passive: true });
    return () => el.removeEventListener('scroll', on);
  }, []);
  if (!conv) return <div className="talk-log" />;
  let lastDay = '';
  let lastSpeaker = '';
  return (
    <div className="talk-log-wrap">
      <div className="talk-log" ref={list}>
        <ol className="talk-turns" aria-label="Conversation">
          <Earlier cards={earlier} />
          {turns.map((t: Turn) => {
            const day = dayMark(t.at);
            const mark = day !== lastDay;
            lastDay = day;
            const speaker =
              t.kind === 'person'
                ? 'you'
                : t.kind === 'event' || t.kind === 'cost-ask'
                  ? 'app'
                  : 'designer';
            const named = speaker === 'designer' && lastSpeaker !== 'designer';
            lastSpeaker = speaker;
            let body: JSX.Element | null = null;
            if (t.kind === 'person') body = <Person t={t} />;
            else if (t.kind === 'designer') body = <Designer t={t} named={named} />;
            else if (t.kind === 'app-question')
              body = <Questions t={t} latest={t.id === lastQuestion} />;
            else if (t.kind === 'scope')
              body = <Scope t={t} latest={t.id === lastScope && meetingOver(conv)} />;
            else if (t.kind === 'cost-ask') body = <CostAsk t={t} />;
            else if (t.kind === 'event') body = <Event t={t} />;
            else if (t.kind === 'proposal') {
              const p = byId.get(t.proposalId);
              const cs = cards.get(t.proposalId);
              body =
                p && cs?.length ? (
                  <ProposalTurn
                    proposal={p}
                    cards={cs}
                    newest={t.id === newestProposal}
                    live={live && live.proposalId === p.id ? live : null}
                  />
                ) : null;
            }
            return (
              <Fragment key={t.id}>
                {mark && (
                  <li className="talk-day" aria-hidden={turns.length < 2}>
                    <h3>{day}</h3>
                  </li>
                )}
                <li className={`talk-li talk-li-${speaker}${named ? ' talk-li-named' : ''}`}>
                  {body}
                </li>
                {replyTo === t.id && (
                  <li className="talk-li talk-li-designer talk-li-named">
                    <Streaming named />
                  </li>
                )}
              </Fragment>
            );
          })}
        </ol>
      </div>
      {behind && (
        <button
          type="button"
          className="btn btn-small talk-behind"
          aria-label="Jump to the newest message"
          onClick={() => {
            const el = list.current;
            if (el) el.scrollTop = el.scrollHeight;
            setBehind(false);
          }}
        >
          New reply ↓
        </button>
      )}
    </div>
  );
}
