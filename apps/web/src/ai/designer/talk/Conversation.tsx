import { type Bounds, type DesignBrief, roomShapes, spentOf } from '@dhd/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useEditor } from '../../../editor';
import { useProject, useStore } from '../../../store';
import { icons } from '../../../ui/icons';
import { AiSettingsDialog } from '../../AiSettingsDialog';
import { aiSettings } from '../../credentials';
import { BriefDialog } from '../BriefDialog';
import { failingChecks } from '../parts';
import { tokens, usd, useSpend } from '../spend';
import { closePanel, useDesigner } from '../state';
import { Composer } from './Composer';
import { Log } from './Log';
import { Decisions, WhatIKnow } from './Views';
import { lineState, undoLine } from './accept';
import { cardChanges, cardResult, cardVerdict, optionCard } from './cards';
import { stopTalkRun } from './propose';
import { focusInLog, keepFocus, scrollInLog } from './scroll';
import { timed, useSettledProject } from './settle';
import { recoverPending, stopReply } from './turn';
import { act, ensureConversation, newId, nowIso, talkLevel, useTalk } from './useTalk';
import { useProposalView } from './view';

/**
 * The designer's conversation (UX §4–§5): in the details column on a computer (400 px, 440 at
 * 1440 and up), a bottom sheet at three heights on a phone (peek, half, full), and a column
 * that folds to a tab on a phone held sideways. One framed sheet: the header with what this
 * conversation and this tab have spent, the menu and close; the On the table bar; the log;
 * the composer.
 */

const SHEET_Q = '(max-width: 900px)';
const SIDE_Q = '(pointer: coarse) and (max-height: 500px)';
const sheetNow = () =>
  !!window.matchMedia?.(SHEET_Q).matches && !window.matchMedia?.(SIDE_Q).matches;
const sideNow = () => !!window.matchMedia?.(SIDE_Q).matches;
function useMedia(test: () => boolean): boolean {
  const [on, setOn] = useState(test);
  useEffect(() => {
    const qs = [SHEET_Q, SIDE_Q].map((q) => window.matchMedia?.(q));
    const change = () => setOn(test());
    for (const q of qs) q?.addEventListener('change', change);
    return () => {
      for (const q of qs) q?.removeEventListener('change', change);
    };
  }, [test]);
  return on;
}

type Size = 'peek' | 'half' | 'full';

/** "On the table: V4 · Passes all checks [Accept…]" (UX §5.2). */
function OnTheTable() {
  // The plan once edits pause (off the drag path).
  const project = useSettledProject();
  // The history moves under the bar's Undo.
  useStore((s) => s.editor.history);
  const lastId = useTalk((s) => {
    const turns = s.conv?.turns ?? [];
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i];
      if (t?.kind === 'proposal') return t.proposalId;
    }
    return null;
  });
  const proposal = useTalk((s) => s.proposals.find((x) => x.id === lastId));
  const proposals = useTalk((s) => s.proposals);
  const shown = useTalk((s) => s.shown);
  const last = useMemo(() => {
    const o = proposal?.options[0];
    return proposal && o ? optionCard(proposal, o) : null;
  }, [proposal]);
  const r = useMemo(() => (last ? timed(() => cardResult(project, last)) : null), [project, last]);
  const remaining = useMemo(
    () => (last && r ? timed(() => cardChanges(project, last, r)).length : 0),
    [project, last, r],
  );
  const open = useMemo(() => {
    if (!r || !last) return 0;
    const f = failingChecks(r, { waivers: last.waivers });
    const changes = timed(() => cardChanges(project, last, r));
    const inCard = (c: { itemId?: string }) =>
      !c.itemId ||
      changes.some(
        (x) => x.items.target.includes(c.itemId ?? '') || x.items.now.includes(c.itemId ?? ''),
      );
    return cardVerdict(
      f.open.filter(inCard),
      [],
      f.waived.map((c) => c.key),
    ).failing.length;
  }, [r, last, project]);
  if (!last || !r) return null;
  const go = (accept: boolean) => {
    const el = document.querySelector(`[data-card="${CSS.escape(last.key)}"]`);
    if (accept) focusInLog(el?.querySelector<HTMLButtonElement>('[data-accept-selected]'));
    else scrollInLog(el, 'start');
  };
  const other = shown && shown !== last.key ? shown : null;
  const otherN = other ? proposals.find((p) => other.startsWith(`${p.id}:`))?.n : null;
  const accepted = last.accepted.filter((a) => !a.out);
  const allIn = last.status !== 'running' && accepted.length > 0 && remaining === 0;
  const line = accepted.at(-1)?.event;
  const undo = line && lineState(line) === 'undo' ? line : null;
  const verdict =
    last.status === 'running'
      ? 'Checking…'
      : last.status === 'failed'
        ? 'Didn’t finish'
        : accepted.length
          ? `${accepted.length} of ${accepted.length + remaining} in your renovation`
          : open
            ? `${open} ${open === 1 ? 'doesn’t' : 'don’t'} pass`
            : 'Passes all checks';
  return (
    <section className="talk-table" aria-label="On the table">
      {other && otherN ? (
        <>
          <span className="talk-table-text">Showing V{otherN}</span>
          <button
            type="button"
            className="btn btn-small"
            onClick={() => useTalk.setState({ shown: last.key })}
          >
            Back to V{last.n}
          </button>
        </>
      ) : (
        <>
          <button type="button" className="talk-table-text link-plain" onClick={() => go(false)}>
            {allIn ? `V${last.n} is in your renovation` : `On the table: V${last.n} · `}
            {!allIn && (
              <span className={open && last.status !== 'running' ? 'negative' : ''}>{verdict}</span>
            )}
          </button>
          {allIn
            ? undo && (
                <button type="button" className="btn btn-small" onClick={() => undoLine(undo)}>
                  Undo
                </button>
              )
            : last.status !== 'running' &&
              last.status !== 'failed' && (
                <button type="button" className="btn btn-small" onClick={() => go(true)}>
                  Accept…
                </button>
              )}
        </>
      )}
    </section>
  );
}

/** The menu (⋯): What I know about you, Decisions, AI settings, Close. */
/** The rooms a card is about, with a margin: what the plan zooms to (null: the whole flat). */
function scopeBox(key: string): Bounds | null {
  const p = useTalk.getState().proposals.find((x) => key.startsWith(`${x.id}:`));
  const level = talkLevel();
  if (!p || p.scope.all || !level) return null;
  const shapes = roomShapes(level);
  const pts = p.scope.spaces
    .flatMap((k) => k.split('+'))
    .flatMap((id) => shapes.get(id)?.outer ?? []);
  if (!pts.length) return null;
  const m = 0.6;
  return {
    min: { x: Math.min(...pts.map((q) => q.x)) - m, y: Math.min(...pts.map((q) => q.y)) - m },
    max: { x: Math.max(...pts.map((q) => q.x)) + m, y: Math.max(...pts.map((q) => q.y)) + m },
  };
}

function Menu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        ref.current?.querySelector<HTMLButtonElement>('.talk-menu-btn')?.focus();
      }
    };
    document.addEventListener('pointerdown', away);
    window.addEventListener('keydown', esc, true);
    return () => {
      document.removeEventListener('pointerdown', away);
      window.removeEventListener('keydown', esc, true);
    };
  }, [open]);
  const item = (label: string, fn: () => void) => (
    <button
      type="button"
      role="menuitem"
      onClick={() => {
        setOpen(false);
        fn();
      }}
    >
      {label}
    </button>
  );
  return (
    <div className="talk-menu-wrap" ref={ref}>
      <button
        type="button"
        className="icon-btn talk-menu-btn"
        aria-label="Designer menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {icons.more}
      </button>
      {open && (
        <div className="talk-menu talk-menu-head" role="menu">
          {item('What I know about you', () => useTalk.setState({ view: 'know', knowAt: null }))}
          {item('Decisions', () => useTalk.setState({ view: 'decisions' }))}
          {item('AI settings', () => useTalk.setState({ settings: 'spending' }))}
          <hr />
          {item('Close', closePanel)}
        </div>
      )}
    </div>
  );
}

let askedForKey = false;

export function TalkPanel() {
  const project = useProject();
  const conv = useTalk((s) => s.conv);
  const proposals = useTalk((s) => s.proposals);
  const view = useTalk((s) => s.view);
  const said = useTalk((s) => s.said);
  const note = useTalk((s) => s.note);
  const memory = useTalk((s) => s.memory);
  const opening = useTalk((s) => s.opening);
  const newer = useTalk((s) => s.newer);
  const settings = useTalk((s) => s.settings);
  const formOpen = useTalk((s) => s.formOpen);
  const shown = useTalk((s) => s.shown);
  const live = useTalk((s) => !!s.live);
  const previewing = useDesigner((s) => s.previewing);
  const { spend, cap } = useSpend();
  const heading = useRef<HTMLHeadingElement>(null);
  const aside = useRef<HTMLElement>(null);
  const [fresh, setFresh] = useState(false);

  // Focus never falls to the page when the control that had it goes; `/` goes to the composer.
  useEffect(() => {
    const el = aside.current;
    if (!el) return;
    const off = keepFocus(el);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const box = el.querySelector<HTMLTextAreaElement>('#talk-text');
      if (!box) return;
      e.preventDefault();
      box.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      off();
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  // Open: the conversation (started if new), with the key asked for once if there is none.
  useEffect(() => {
    let live = true;
    const had = !!useTalk.getState().conv && useTalk.getState().projectId === project.id;
    void ensureConversation().then((c) => {
      if (!live || !c) return;
      // A reply cut off when a tab closed is said, and its text kept.
      void recoverPending();
      const isNew = !had && c.turns.length <= 2 && !c.turns.some((t) => t.kind === 'person');
      setFresh(isNew);
      requestAnimationFrame(() => {
        if (isNew) heading.current?.focus({ preventScroll: true });
        else
          document.querySelector<HTMLTextAreaElement>('#talk-text')?.focus({ preventScroll: true });
      });
    });
    if (!aiSettings() && !askedForKey) {
      askedForKey = true;
      useTalk.setState({ settings: 'key' });
    }
    return () => {
      live = false;
    };
  }, [project.id]);

  // The newest card goes on the plan when it arrives.
  // biome-ignore lint/correctness/useExhaustiveDependencies: when a proposal is added
  useEffect(() => {
    const t = [...(conv?.turns ?? [])].reverse().find((x) => x.kind === 'proposal');
    const p = t?.kind === 'proposal' ? proposals.find((x) => x.id === t.proposalId) : undefined;
    if (p && !useTalk.getState().shown) useTalk.setState({ shown: `${p.id}:A` });
  }, [proposals.length]);

  // Compare chose a version to show: its card goes on the plan.
  const picked = useDesigner((s) => s.selected);
  useEffect(() => {
    if (!picked) return;
    const d = useDesigner.getState().designs.find((x) => x.id === picked);
    useDesigner.setState({ selected: null });
    if (d)
      useTalk.setState({ shown: d.from ? `${d.from.proposalId}:${d.from.letter}` : `d:${d.id}` });
  }, [picked]);

  // The card on the plan: what Accept selected would give, in the plan's place.
  const pv = useProposalView(
    useShallow((s) => ({ card: s.card, merged: s.merged, label: s.label })),
  );
  const wantSide = useDesigner((s) => s.wantSide);
  useEffect(() => {
    const before = project.levels[0];
    const ed = useEditor.getState();
    if (!previewing || !shown || pv.card !== shown || !pv.merged || !before) {
      if (ed.preview) ed.setPreview(null);
      return;
    }
    const side = wantSide ?? ed.preview?.side ?? 'version';
    if (wantSide) useDesigner.setState({ wantSide: null });
    ed.setPreview({ level: pv.merged, before, label: pv.label, side });
  }, [previewing, shown, pv, project.levels, wantSide]);
  // While a proposal is on the plan its electrical notes read amber (notes, not failures).
  const previewOn = useEditor((s) => !!s.preview && s.preview.side === 'version');
  useEffect(() => {
    if (previewOn) document.documentElement.dataset.proposal = '';
    else delete document.documentElement.dataset.proposal;
    return () => {
      delete document.documentElement.dataset.proposal;
    };
  }, [previewOn]);
  useEffect(() => () => useEditor.getState().setPreview(null), []);
  // The plan zooms to a card's rooms the first time it goes on the plan (the whole flat, or a
  // card shown again, fits the plan); the zoom ends with the preview.
  const zoomed = useRef(new Set<string>());
  const ourBox = useRef<Bounds | null>(null);
  useEffect(() => {
    if (!shown) return;
    const first = !zoomed.current.has(shown);
    zoomed.current.add(shown);
    const box = first ? scopeBox(shown) : null;
    const f = requestAnimationFrame(() => {
      if (!useEditor.getState().elevation) {
        ourBox.current = box;
        useEditor.setState({ fitBox: box });
      }
      useEditor.getState().requestFit(64);
    });
    return () => cancelAnimationFrame(f);
  }, [shown]);
  useEffect(() => {
    if (previewOn || !ourBox.current) return;
    if (useEditor.getState().fitBox === ourBox.current) useEditor.setState({ fitBox: null });
    ourBox.current = null;
  }, [previewOn]);

  // Esc stops a run (not while a dialog or a menu view wants it).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('dialog[open]'))
        return;
      if (useDesigner.getState().comparing) return;
      if (useTalk.getState().view !== 'log') {
        e.preventDefault();
        useTalk.setState({ view: 'log' });
        return;
      }
      if (useTalk.getState().reply) {
        e.preventDefault();
        stopReply();
      } else if (useTalk.getState().live) {
        e.preventDefault();
        stopTalkRun();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // A phone: a sheet at three heights; a phone on its side: a column folding to a tab.
  const sheet = useMedia(sheetNow);
  const side = useMedia(sideNow);
  const [size, setSize] = useState<Size>('half');
  const [folded, setFolded] = useState(false);
  const before = useRef<Size | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: on a change of the sheet's size
  useEffect(() => {
    const f = requestAnimationFrame(() => useEditor.getState().requestFit(64));
    if (sheet) document.documentElement.dataset.talkSheet = size;
    else delete document.documentElement.dataset.talkSheet;
    return () => cancelAnimationFrame(f);
  }, [size, sheet, folded]);
  useEffect(
    () => () => {
      delete document.documentElement.dataset.talkSheet;
      requestAnimationFrame(() => useEditor.getState().requestFit(64));
    },
    [],
  );
  // The keyboard: the sheet sits on it (visualViewport), the plan visible above.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!sheet || !vv) return;
    const on = () => {
      const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      document.documentElement.style.setProperty('--talk-kb', `${Math.round(kb)}px`);
    };
    on();
    vv.addEventListener('resize', on);
    vv.addEventListener('scroll', on);
    return () => {
      vv.removeEventListener('resize', on);
      vv.removeEventListener('scroll', on);
      document.documentElement.style.removeProperty('--talk-kb');
    };
  }, [sheet]);
  const drag = useRef<number | null>(null);
  const moved = useRef(false);

  // Every turn that spent: the proposals' runs, the replies, and messages not answered.
  const turns = useTalk((s) => s.conv?.turns);
  const totals = useMemo(
    () =>
      spentOf([
        ...proposals.flatMap((p) => p.options.flatMap((o) => o.usage)),
        ...(turns ?? []).flatMap((t) =>
          t.kind === 'designer'
            ? (t.talk?.usage ?? [])
            : t.kind === 'person'
              ? (t.reply?.usage ?? [])
              : [],
        ),
      ]),
    [proposals, turns],
  );
  const spendLine =
    totals.usd === null
      ? `This conversation ${tokens(totals.tokens)} tokens`
      : `This conversation ${totals.estimated || live ? '~' : ''}${usd(totals.usd)} · this tab ${usd(spend.usd)}${cap !== null ? ` of ${usd(cap)}` : ''}`;

  // Folded to its tab (a phone on its side), the conversation stays mounted, hidden, so the
  // proposal stays on the plan, bigger.
  const isFolded = side && folded;
  return (
    <aside
      ref={aside}
      className={`panel designer talk${sheet ? ` talk-sheet talk-${size}` : ''}${side ? ' talk-side' : ''}${isFolded ? ' talk-folded' : ''}`}
      aria-labelledby="designer-h"
    >
      {isFolded && (
        <button
          type="button"
          className="talk-side-tab"
          aria-expanded={false}
          onClick={() => setFolded(false)}
        >
          Designer
        </button>
      )}
      {sheet && (
        <>
          <button
            type="button"
            className="sheet-handle talk-handle"
            aria-label={
              size === 'full' ? 'Make the designer smaller' : 'Make the designer full height'
            }
            onClick={() => {
              if (!moved.current) setSize(size === 'full' ? 'half' : 'full');
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
            onPointerUp={(e) => {
              const from = drag.current;
              drag.current = null;
              if (from === null) return;
              const dy = e.clientY - from;
              if (dy < -30) setSize(size === 'peek' ? 'half' : 'full');
              else if (dy > 30) setSize(size === 'full' ? 'half' : 'peek');
            }}
            onPointerCancel={() => {
              drag.current = null;
            }}
          />
          {size !== 'peek' && (
            <button type="button" className="visually-hidden" onClick={() => setSize('peek')}>
              Fold the designer
            </button>
          )}
        </>
      )}
      <header className="talk-head">
        <div className="talk-head-row">
          <h2 id="designer-h" className="panel-title" ref={heading} tabIndex={-1}>
            Designer
          </h2>
          {sheet && (
            <button
              type="button"
              className="talk-spend-short link-plain num"
              aria-label={spendLine}
              onClick={() => useTalk.setState({ settings: 'spending' })}
            >
              {totals.usd === null ? `${tokens(totals.tokens)} t` : usd(totals.usd)}
            </button>
          )}
          <Menu />
          {side && (
            <button
              type="button"
              className="icon-btn"
              aria-label="Fold the designer"
              onClick={() => setFolded(true)}
            >
              ›
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
        {!sheet && (
          <button
            type="button"
            className="talk-spend link-plain num"
            onClick={() => useTalk.setState({ settings: 'spending' })}
          >
            {spendLine}
          </button>
        )}
      </header>
      {opening && <p className="field-hint talk-memory">Opening your saved conversation…</p>}
      {newer && (
        <p className="talk-memory talk-unsaved">
          Opened in a newer version of the app; reload to continue.
        </p>
      )}
      {memory && (
        <p className="talk-memory talk-unsaved">
          Not saved on this device. This browser won’t keep the conversation, so it lasts until you
          close the tab.
        </p>
      )}
      {note && <p className="field-hint talk-memory">{note}</p>}
      {view === 'log' && <OnTheTable />}
      <div className="talk-body">
        {view === 'know' ? (
          <WhatIKnow />
        ) : view === 'decisions' ? (
          <Decisions />
        ) : (
          <Log key={fresh ? 'new' : 'old'} />
        )}
      </div>
      {view === 'log' && !newer && (
        <Composer
          onFocus={() => {
            if (!sheet) return;
            before.current = size;
            setSize('peek');
          }}
          onBlur={() => {
            if (!sheet || !before.current) return;
            setSize(before.current);
            before.current = null;
          }}
        />
      )}
      <p className="visually-hidden" aria-live="polite">
        {said}
      </p>
      {settings && (
        <AiSettingsDialog
          {...(settings === 'prices' ? { focus: 'prices' as const } : {})}
          onClose={() => useTalk.setState({ settings: null })}
        />
      )}
      {formOpen && (
        <BriefDialog
          initial={conv?.brief}
          onSave={(b: DesignBrief) => {
            const level = talkLevel();
            if (level)
              void act({
                type: 'formFilled',
                brief: b,
                at: nowIso(),
                ids: [newId('turn'), newId('turn')],
                level,
              });
          }}
          onClose={() => useTalk.setState({ formOpen: false })}
        />
      )}
    </aside>
  );
}
