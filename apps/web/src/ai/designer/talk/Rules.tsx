import {
  type Decision,
  type Kept,
  MAX_RULES,
  type Rule,
  type TurnOf,
  dayOf,
  keptName,
  liveRules,
  numberRange,
  ruleNumber,
  ruleSentence,
} from '@dhd/core';
import { useEffect, useMemo, useState } from 'react';
import { LengthField } from '../../../ui/fields';
import { useAi } from '../../credentials';
import { useResultsTickN } from '../results';
import { cannotDesign, tokens, usd, useSpend } from '../spend';
import { Mark } from './Mark';
import { cardResult } from './cards';
import { lightPointer, unkeep } from './pointers';
import {
  changeRule,
  deleteRule,
  keepRule,
  keepYours,
  numberProblem,
  planStatus,
  renameRule,
  reopenRule,
  replaceRule,
  restoreRule,
  ruleOnce,
  showRule,
  tableCard,
  useRuleShown,
} from './rules';
import { timed, useSettledProject } from './settle';
import { sendMessage, sendPrice } from './turn';
import { talkLevel, useBusy, useTalk } from './useTalk';

/**
 * House rules on screen (slice 3a UX §3, §4): the offer under a designer's reply, its refusals,
 * Your rules (a menu view), and Decisions' Make this a rule. The sentence under each rule is the
 * app's, from the rule object; the name is the person's words.
 */

const RULES_LINE =
  'Rules are checked on every proposal. Decisions are told to the designer, not checked.';

/** The app's sentence for a rule on the level designed. */
function useSentence(rule: Rule | null): string {
  const project = useSettledProject();
  // biome-ignore lint/correctness/useExhaustiveDependencies: names come from the plan
  return useMemo(() => {
    const level = talkLevel();
    return rule && level ? ruleSentence(rule, level) : '';
  }, [rule, project]);
}

/** The number a rule takes, as a field (Clear width, Distance), with its limits' reasons. */
function NumberField({
  rule,
  value,
  onCommit,
  label,
}: {
  rule: Rule;
  value: number | null;
  onCommit: (n: number) => void;
  label?: string;
}) {
  const range = numberRange(rule.relation, rule.target.kind);
  if (!range) return null;
  return (
    <LengthField
      revertInvalid
      label={range.what}
      ariaLabel={label ?? `${range.what}, ${rule.name}`}
      value={value ?? range.default ?? undefined}
      min={0.01}
      max={20}
      validate={(n) => numberProblem(rule, n)}
      onCommit={(n) => {
        if (n !== undefined) onCommit(n);
      }}
    />
  );
}

/** A rule offer under the designer's reply (UX §3.3), or why it can't be a rule (§4). */
export function RuleOfferBlock({ t }: { t: TurnOf<'designer'> }) {
  const offer = t.talk?.offer ?? null;
  const conv = useTalk((s) => s.conv);
  const sentence = useSentence(offer?.rule ?? null);
  const [n, setN] = useState<number | null>(offer ? ruleNumber(offer.rule) : null);
  const [numbers, setNumbers] = useState(false);
  const old = useMemo(
    () => (offer?.vet.with ? (conv?.rules.find((r) => r.id === offer.vet.with) ?? null) : null),
    [offer, conv],
  );
  const oldSentence = useSentence(old);
  if (!offer || !conv) return null;
  const { rule, vet, state } = offer;
  const full = liveRules(conv).length >= MAX_RULES && !vet.raises;
  const folded = (text: string, link?: { label: string; on: () => void }) => (
    <p className="talk-app-line" data-offer={rule.id}>
      <span className="talk-app-icon">
        <Mark kind="check" />
      </span>
      <span className="talk-app-text">
        <span>{text}</span>
        {link && (
          <button type="button" className="link-btn" onClick={link.on}>
            {link.label}
          </button>
        )}
      </span>
    </p>
  );
  if (state === 'kept' || state === 'replaced')
    return folded(`Kept as a rule · ${rule.name}`, {
      label: 'Edit',
      on: () => useTalk.setState({ view: 'rules' }),
    });
  if (state === 'once') {
    const d = conv.decisions.find((x) => !x.deleted && x.rule?.id === rule.id);
    return folded(
      'Noted in Decisions, not checked',
      d ? { label: 'Make it a rule', on: () => void reopenRule(d.id) } : undefined,
    );
  }
  if (state === 'kept-yours') return folded('Kept your rule.');
  if (!vet.ok && vet.why === 'duplicate') return folded('You already have this rule.');
  if (!vet.ok) {
    const contradicts = vet.why === 'conflict' || vet.why === 'range';
    return (
      <section
        className="talk-rule-offer talk-rule-refused"
        aria-label={`Rule offer: ${rule.name}`}
        data-offer={rule.id}
      >
        <h4 className="talk-q-label">
          <Mark kind="warn" />{' '}
          {vet.why === 'hdb'
            ? 'HDB doesn’t allow this, so it can’t be a rule'
            : 'This can’t be a rule as it stands'}
        </h4>
        {vet.why === 'conflict' ? (
          <>
            <p>It contradicts a rule you have:</p>
            <p className="talk-rule-pair">
              New: {sentence}
              <br />
              Yours: {oldSentence || old?.name}
              {old ? ` (kept ${dayOf(old.at)})` : ''}
            </p>
          </>
        ) : (
          <p>{vet.text}</p>
        )}
        {vet.why === 'needs' && (
          <button
            type="button"
            className="link-btn"
            onClick={() => useTalk.setState({ view: 'know', knowAt: 'sleeping' })}
          >
            What I know about you
          </button>
        )}
        {contradicts && old && (
          <div className="button-row">
            <button type="button" className="btn btn-small" onClick={() => void replaceRule(t.id)}>
              Replace yours with the new one
            </button>
            <button type="button" className="btn btn-small" onClick={() => void keepYours(t.id)}>
              Keep yours
            </button>
          </div>
        )}
      </section>
    );
  }
  const range = numberRange(rule.relation, rule.target.kind);
  const shown = { ...rule, n };
  return (
    <section
      className="talk-rule-offer"
      aria-label={`Rule offer: ${rule.name}`}
      data-offer={rule.id}
    >
      <h4 className="talk-q-label">I’ll keep this as a rule for your home</h4>
      <p className="talk-rule-name">{rule.name}</p>
      <p className="talk-rule-checks">Checks: {sentenceOf(shown, sentence)}.</p>
      {vet.adjusted && <p className="field-hint">{vet.adjusted.why}</p>}
      {vet.raises && (
        <p className="field-hint">
          Your rule on this way is raised to {(n ?? vet.raises.to).toFixed(2)} m.
        </p>
      )}
      <p className="talk-rule-links">
        <button type="button" className="link-btn" onClick={() => showRule(shown)}>
          Show on plan
        </button>
        {range && !numbers && (
          <button type="button" className="link-btn" onClick={() => setNumbers(true)}>
            Change the numbers
          </button>
        )}
      </p>
      {range && numbers && <NumberField rule={rule} value={n} onCommit={setN} />}
      {vet.planBreaks.length > 0 && (
        <p className="field-hint">
          Your plan doesn’t meet it now: {vet.planBreaks.slice(0, 2).join('; ')}. That won’t stop a
          proposal.
        </p>
      )}
      {full && (
        <p className="field-hint">
          You have {MAX_RULES} rules, the most a home can have. Delete one in Your rules to keep
          this.
        </p>
      )}
      <div className="button-row">
        <button
          type="button"
          className="btn btn-primary btn-small"
          disabled={full}
          onClick={() => void keepRule(t.id, n)}
        >
          Keep as a rule
        </button>
        <button type="button" className="btn btn-small" onClick={() => void ruleOnce(t.id)}>
          Just this once
        </button>
      </div>
    </section>
  );
}

/** The sentence with the fields' numbers (Change the numbers), else as offered. */
function sentenceOf(rule: Rule, fallback: string): string {
  const level = talkLevel();
  return level ? ruleSentence(rule, level) : fallback;
}

/** One rule in Your rules: name, sentence, number, status line and actions (UX §3.4). */
function RuleArticle({ rule, onDeleted }: { rule: Rule; onDeleted: (r: Rule) => void }) {
  const sentence = useSentence(rule);
  const project = useSettledProject();
  const tick = useResultsTickN();
  const [rename, setRename] = useState<string | null>(null);
  const shownRule = useRuleShown((s) => s.rule?.id === rule.id);
  // The plan's part once per plan and rule; the card's part as its result lands.
  // biome-ignore lint/correctness/useExhaustiveDependencies: worked out on the plan as it is
  const plan = useMemo(() => timed(() => planStatus(rule)), [rule, project]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again as results land
  const status = useMemo(() => {
    const t = tableCard();
    if (!t) return { table: null, plan };
    const r = timed(() => cardResult(project, t.card));
    if (!r) return { table: 'Checking…', plan, tone: 'pending' };
    const fails = r.checks.filter((c) => c.key.startsWith(`R|${rule.id}|`) && !c.already);
    const waived = t.card.waivers.some((w) => w.key.startsWith(`R|${rule.id}|`));
    const prefix = `Your rule “${rule.name}”: `;
    const what = (c: { text: string }) =>
      c.text.startsWith(prefix) ? c.text.slice(prefix.length).replace(/\.$/, '') : c.text;
    return fails.length
      ? {
          table: `✕ ${t.title} doesn’t meet it: ${fails.map(what).join('; ')}.`,
          plan,
          tone: 'fail',
        }
      : waived
        ? { table: `Accepted anyway once, in ${t.title}`, plan, tone: 'waived' }
        : { table: `✓ ${t.title} meets it`, plan, tone: 'pass' };
  }, [rule, project, tick, plan]);
  return (
    <article className="talk-rule" aria-label={rule.name}>
      {rename !== null ? (
        <form
          className="talk-add"
          onSubmit={(e) => {
            e.preventDefault();
            void renameRule(rule, rename);
            setRename(null);
          }}
        >
          <input
            className="input"
            maxLength={80}
            aria-label="Rule name"
            aria-describedby={`rename-${rule.id}`}
            value={rename}
            // biome-ignore lint/a11y/noAutofocus: opened to rename it
            autoFocus
            onChange={(e) => setRename(e.target.value)}
            onKeyDown={(e) => {
              // Esc cancels the rename only, never the view (QA B3).
              if (e.key === 'Escape') {
                e.preventDefault();
                setRename(null);
              }
            }}
          />
          {rename.length >= 70 && (
            <span id={`rename-${rule.id}`} className="field-hint">
              {rename.length} of 80 characters
            </span>
          )}
          <button type="submit" className="btn btn-small" disabled={!rename.trim()}>
            Save
          </button>
        </form>
      ) : (
        <p className="talk-rule-name">{rule.name}</p>
      )}
      <p className="talk-rule-checks">Checks: {sentence}.</p>
      <NumberField
        rule={rule}
        value={ruleNumber(rule)}
        label={`${numberRange(rule.relation, rule.target.kind)?.what ?? 'Number'}, ${rule.name}`}
        onCommit={(n) => void changeRule(rule, n)}
      />
      <p className="talk-rule-status" aria-live="off">
        {status.table && (
          <span
            className={
              status.tone === 'fail' ? 'negative' : status.tone === 'waived' ? 'advise' : ''
            }
          >
            {status.table}
          </span>
        )}
        {status.plan.length > 0 ? (
          <span className="muted">
            {status.table ? ' · ' : ''}Your plan already breaks it:{' '}
            {status.plan.slice(0, 2).join('; ')}
          </span>
        ) : (
          !status.table && <span>Your plan meets it</span>
        )}
      </p>
      <p className="talk-rule-actions">
        <button
          type="button"
          className="link-btn"
          aria-pressed={shownRule}
          onClick={() => showRule(shownRule ? null : rule)}
        >
          Show on plan
        </button>
        <button type="button" className="link-btn" onClick={() => setRename(rule.name)}>
          Rename
        </button>
        <button
          type="button"
          className="link-btn"
          onClick={() => {
            void deleteRule(rule);
            onDeleted(rule);
          }}
        >
          Delete
        </button>
      </p>
    </article>
  );
}

/** Your rules (UX §3.4): a menu view, as Decisions is. */
export function YourRules({ Back }: { Back: (p: { title: string }) => JSX.Element }) {
  const conv = useTalk((s) => s.conv);
  const [gone, setGone] = useState<Rule | null>(null);
  useEffect(() => {
    if (!gone) return;
    const t = setTimeout(() => setGone(null), 5000);
    return () => clearTimeout(t);
  }, [gone]);
  if (!conv) return null;
  const rules = liveRules(conv).filter((r) => r.levelId === conv.levelId);
  const decisions = conv.decisions.filter((d) => !d.deleted).length;
  return (
    <section className="talk-view" aria-label="Your rules">
      <Back title="Your rules" />
      <p className="muted">{RULES_LINE}</p>
      {gone && (
        <output className="talk-app-line">
          <span className="talk-app-icon">
            <Mark kind="check" />
          </span>
          <span className="talk-app-text">
            Deleted.{' '}
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                void restoreRule(gone);
                setGone(null);
              }}
            >
              Undo
            </button>
          </span>
        </output>
      )}
      {rules.length === 0 ? (
        <p className="muted">
          No rules yet. Tell the designer something that should always hold, like “never anything in
          the corridor” or “the sofa must face the window”, and it will offer to keep it as a rule.
          Or make one of your Decisions a rule.
        </p>
      ) : (
        <>
          <h4 className="talk-rules-head">Rules ({rules.length})</h4>
          <div className="talk-rules">
            {rules.map((r) => (
              <RuleArticle key={r.id} rule={r} onDeleted={setGone} />
            ))}
          </div>
        </>
      )}
      <KeptList />
      <p>
        <button
          type="button"
          className="link-btn"
          onClick={() => useTalk.setState({ view: 'decisions' })}
        >
          Decisions ({decisions}) are told, not checked ›
        </button>
      </p>
      <p className="field-hint">
        Your rules stay on this device, with this conversation. They’re not in the plan, its exports
        or share links.
      </p>
    </section>
  );
}

/** Kept as they are (UX §3.4, §2.4): pieces kept where they are, with Show and Let go. */
const NO_KEPT: readonly Kept[] = [];
/** The pieces kept on the conversation's level (a stable empty list: no render loop). */
function KeptList() {
  const all = useTalk((s) => s.conv?.kept ?? NO_KEPT);
  const levelId = useTalk((s) => s.conv?.levelId);
  const kept = useMemo(() => all.filter((k) => k.levelId === levelId), [all, levelId]);
  if (!kept.length) return null;
  return (
    <section className="talk-kept" aria-label="Kept as they are">
      <h4 className="talk-rules-head">Kept as they are ({kept.length})</h4>
      <ul className="talk-decisions">
        {kept.map((k) => (
          <li key={k.id}>
            <span>
              {keptName(k)
                .replace(/^the /, '')
                .replace(/^./, (c) => c.toUpperCase())}
              <span className="muted">
                {' '}
                · {k.from === 'plan' ? 'in your plan' : `from ${k.from}`}
              </span>
            </span>
            <span className="talk-decision-actions">
              <button
                type="button"
                className="link-btn"
                onClick={() =>
                  lightPointer(
                    {
                      id: `show_${k.id}`,
                      kind: k.itemId ? 'item' : 'spot',
                      targetId: k.itemId,
                      at: { x: k.pose.x, y: k.pose.y },
                      levelId: k.levelId,
                      levelName: null,
                      version: { kind: 'plan' },
                      // Its name on the pin (never "Here": it's a piece, not a spot).
                      label: keptName(k)
                        .replace(/^the /, '')
                        .replace(/^./, (c) => c.toUpperCase()),
                      room: null,
                      where: '',
                      state: '',
                    },
                    2000,
                  )
                }
              >
                Show
              </button>
              <button type="button" className="link-btn" onClick={() => void unkeep(k)}>
                Let the designer move it
              </button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Decisions' Make this a rule (UX §3.8): priced, or free when the rule object is there. */
export function MakeRule({ d }: { d: Decision }) {
  const busy = useBusy();
  const ai = useAi();
  // Re-rendered when prices change (a price entered makes the model usable).
  useSpend();
  const conv = useTalk((s) => s.conv);
  const text = `Make this a rule: ${d.text}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: priced on the conversation as it is
  const est = useMemo(() => (d.rule ? null : sendPrice(text)), [d.rule, text, conv?.rev]);
  if (d.kind === 'waiver') return null;
  if (d.rule)
    return (
      <button type="button" className="link-btn" onClick={() => void reopenRule(d.id)}>
        Make this a rule
      </button>
    );
  if (!ai || cannotDesign(ai)) return null;
  const price = est?.usd
    ? `about ${usd(est.usd.typical)}`
    : est
      ? `about ${tokens(est.tokens.typical)} tokens`
      : '';
  return (
    <button
      type="button"
      className="link-btn"
      data-spends=""
      disabled={busy}
      onClick={() => {
        useTalk.setState({ view: 'log' });
        void sendMessage(text, false, { decisionId: d.id });
      }}
    >
      Make this a rule{price ? ` · ${price}` : ''}
    </button>
  );
}

/** The menu's row, with its count. */
export const rulesLabel = (n: number) => (n ? `Your rules (${n})` : 'Your rules');
