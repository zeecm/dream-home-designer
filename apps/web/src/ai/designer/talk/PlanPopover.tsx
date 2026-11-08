import { type Vec2, entranceDoor, roomsBeside, wallStatus } from '@dhd/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { useSheets } from '../../../comments/ui';
import { type Selection, useEditor } from '../../../editor';
import { type Size, type View, worldToScreen } from '../../../plan/view';
import { useStore } from '../../../store';
import { useAi } from '../../credentials';
import { usd } from '../spend';
import { useDesigner } from '../state';
import { designerCannotUse } from '../stream';
import {
  type Target,
  addPointer,
  describe,
  keepTarget,
  keptOf,
  makePointer,
  shownLevel,
  unkeep,
} from './pointers';
import { sendMessage, sendPrice } from './turn';
import { actProposal, useBusy, useTalk } from './useTalk';
import { useProposalView } from './view';

/**
 * The popover on the plan (slice 3a §2.1, §2.3, tech §6.4): opened by a still click or tap on a
 * piece, a door or window, a wall, a point or a room while a version is on the plan, and on your
 * own plan while the designer is open; an action sheet on a phone. Free rows always work; the
 * two paid rows send a message with the chip, priced as Send is.
 */

export const usePopover = create<{ target: Target | null }>(() => ({ target: null }));
export const openPopover = (target: Target | null) => usePopover.setState({ target });
export const closePopover = () => usePopover.setState({ target: null });

const doc = () => useStore.getState().editor.doc;

/** A selection's target, at its centre. */
export function targetOf(sel: Selection, at: Vec2): Target | null {
  if (sel.kind === 'vertex') return null;
  return { kind: sel.kind, id: sel.id, at };
}

/** Where a selection is on the level shown (for the popover and the pointer). */
function centreOf(sel: Selection): Vec2 | null {
  const shown = shownLevel();
  const l = shown?.level;
  if (!l) return null;
  if (sel.kind === 'item') {
    const it = l.items[sel.id];
    return it ? { x: it.position.x, y: it.position.z } : null;
  }
  if (sel.kind === 'wall' || sel.kind === 'opening') {
    const wallId = sel.kind === 'wall' ? sel.id : l.openings[sel.id]?.wallId;
    const w = wallId ? l.walls[wallId] : undefined;
    const a = w && l.vertices[w.a];
    const b = w && l.vertices[w.b];
    const t = sel.kind === 'opening' ? (l.openings[sel.id]?.t ?? 0.5) : 0.5;
    return a && b ? { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t } : null;
  }
  if (sel.kind === 'point') {
    const p = l.points?.[sel.id];
    return p?.at ? { x: p.at.x, y: p.at.y } : null;
  }
  if (sel.kind === 'room') {
    const r = l.rooms[sel.id];
    if (!r) return null;
    const pts: Vec2[] = r.loop.flatMap((id) => {
      const v = l.vertices[id];
      return v ? [{ x: v.x, y: v.y }] : [];
    });
    const n = pts.length || 1;
    return { x: pts.reduce((t, p) => t + p.x, 0) / n, y: pts.reduce((t, p) => t + p.y, 0) / n };
  }
  return null;
}

/** Whether the popover opens now: a version on the plan, or the designer open on your plan. */
const popoverOn = () => {
  const pv = useEditor.getState().preview;
  if (pv?.start) return false;
  if (pv) return pv.side === 'version';
  return useDesigner.getState().panel && useStore.getState().role !== 'viewer';
};

/**
 * Opens the popover on a still click or tap (the selection changing to a target), and closes
 * it when a drag starts (the selected piece moving) or the selection goes.
 */
export function usePopoverOnSelect() {
  useEffect(
    () =>
      useEditor.subscribe((s, prev) => {
        if (s.selection === prev.selection) return;
        const sel = s.selection;
        if (!sel) {
          closePopover();
          return;
        }
        if (!popoverOn()) return;
        const at = centreOf(sel);
        const t = at ? targetOf(sel, at) : null;
        openPopover(t);
      }),
    [],
  );
  useEffect(
    () =>
      useStore.subscribe((s, prev) => {
        const t = usePopover.getState().target;
        if (!t || t.kind !== 'item' || !t.id || s.editor.doc === prev.editor.doc) return;
        // The piece moved by hand (a drag started): editing is never in its way.
        const lvls = (l: typeof s.editor.doc) => l.levels.map((x) => x.items[t.id ?? '']);
        const a = lvls(s.editor.doc).find(Boolean);
        const b = lvls(prev.editor.doc).find(Boolean);
        if (a && b && (a.position.x !== b.position.x || a.position.z !== b.position.z))
          closePopover();
      }),
    [],
  );
}

const M = 8;
const W = 280;
/** Beside the target, never over it: right, left, below, above, else a corner. */
function place(at: Vec2, size: Size, h: number): React.CSSProperties {
  const w = Math.min(W, size.width - 2 * M);
  const height = Math.min(h || 320, size.height - 2 * M);
  const tries = [
    { left: at.x + 24, top: at.y - 40 },
    { left: at.x - 24 - w, top: at.y - 40 },
    { left: at.x - w / 2, top: at.y + 24 },
    { left: at.x - w / 2, top: at.y - 24 - height },
  ].map((c) => ({
    left: Math.max(M, Math.min(c.left, size.width - M - w)),
    top: Math.max(M, Math.min(c.top, size.height - M - height)),
  }));
  const clear = (c: { left: number; top: number }) =>
    !(
      at.x > c.left - 12 &&
      at.x < c.left + w + 12 &&
      at.y > c.top - 12 &&
      at.y < c.top + height + 12
    );
  const best = tries.find(clear) ?? {
    left: at.x > size.width / 2 ? M : size.width - M - w,
    top: at.y > size.height / 2 ? M : size.height - M - height,
  };
  return { left: best.left, top: best.top, width: w, maxHeight: size.height - 2 * M };
}

interface Row {
  label: string;
  /** Priced rows: the figure. */
  price?: string;
  act: () => void;
  /** Keeps the popover open (Why here?, Keep this). */
  stays?: boolean;
  paid?: boolean;
  pressed?: boolean;
}

/** The popover over the plan stage (desktop) or the action sheet (phone). */
export function PlanPopover({ view, size }: { view: View; size: Size }) {
  usePopoverOnSelect();
  const target = usePopover((s) => s.target);
  const sheets = useSheets();
  const busy = useBusy();
  const ai = useAi();
  const conv = useTalk((s) => s.conv);
  const pv = useProposalView();
  const [why, setWhy] = useState(false);
  const box = useRef<HTMLDialogElement>(null);
  const [h, setH] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new target starts closed
  useEffect(() => setWhy(false), [target?.kind, target?.id]);
  useEffect(() => {
    if (!target) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePopover();
    };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [target]);
  useEffect(() => {
    if (box.current) setH(box.current.offsetHeight);
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: worked out per target and plan
  const info = useMemo(() => {
    if (!target) return null;
    const shown = shownLevel();
    if (!shown) return null;
    const words = describe(shown.level, target);
    const title = shown.version.kind === 'option' ? shown.version.title : null;
    const change =
      target.kind === 'item' && target.id
        ? (pv.changes.find(
            (c) =>
              c.items.target.includes(target.id ?? '') || c.items.now.includes(target.id ?? ''),
          ) ?? null)
        : null;
    const failing = target.kind === 'item' && target.id ? pv.failing.includes(target.id) : false;
    return { shown, words, title, change, failing };
  }, [target, pv, conv?.kept]);
  if (!target || !info || !conv) return null;
  const { shown, words, title, change } = info;
  const level = shown.level;
  const kept = keptOf(target);
  const cantPay = !ai
    ? 'Add your AI key to ask for other ideas.'
    : designerCannotUse(ai)
      ? designerCannotUse(ai)
      : typeof navigator !== 'undefined' && navigator.onLine === false
        ? 'You’re offline.'
        : busy
          ? 'Wait for the reply, or Stop'
          : null;
  const price = (text: string) => {
    const est = sendPrice(text);
    return est?.usd ? `about ${usd(est.usd.typical)}` : est ? 'about a few tokens' : '';
  };
  const pointer = () => makePointer(target);
  const ask = (text: string) => {
    const p = pointer();
    closePopover();
    if (p) void sendMessage(text, false, undefined, [p]);
  };
  // What the state line says.
  const verb = change
    ? change.verb === 'add'
      ? `Added in ${title}`
      : change.verb === 'remove'
        ? `Removed in ${title}`
        : change.verb === 'move'
          ? `Moved in ${title}`
          : change.verb === 'turn'
            ? `Turned in ${title}`
            : `Changed in ${title}`
    : title
      ? target.kind === 'item'
        ? `In your plan, not changed in ${title}`
        : `In ${title}`
      : 'In your plan';
  const state = kept ? 'Kept: later ideas leave it here' : verb;
  // Locked: what can't be taken out, and why (free).
  let locked: string | null = null;
  if (target.kind === 'wall' && target.id) {
    const status = wallStatus(level, target.id);
    const outside = roomsBeside(level, target.id).some((r) => !r);
    locked =
      status === 'shelter'
        ? 'HDB doesn’t allow it: household shelter walls can’t change.'
        : outside
          ? 'Outside walls stay.'
          : (status === 'structural' || status === 'likely') && conv.brief.walls !== 'structural'
            ? 'Likely structural: you chose to keep those.'
            : null;
  }
  if (target.kind === 'opening' && target.id) {
    const o = level.openings[target.id];
    const shelterDoor =
      !!o &&
      roomsBeside(level, o.wallId).some(
        (r) => !!r && /shelter|bomb/i.test(level.rooms[r]?.name ?? ''),
      );
    if (target.id === entranceDoor(level) || o?.kind === 'window' || shelterDoor)
      locked = 'The main door, windows and the shelter door stay where they are.';
  }
  const free: Row[] = [
    {
      label: 'Comment',
      act: () => {
        const p = pointer();
        closePopover();
        if (!p) return;
        void addPointer(p);
        requestAnimationFrame(() =>
          document.querySelector<HTMLTextAreaElement>('#talk-text')?.focus(),
        );
      },
    },
  ];
  if (change?.why)
    free.push({ label: 'Why here?', act: () => setWhy(!why), stays: true, pressed: why });
  if (target.kind === 'item') {
    free.push(
      kept
        ? { label: 'Let the designer move it', act: () => void unkeep(kept), stays: true }
        : { label: 'Keep this', act: () => void keepTarget(target), stays: true },
    );
    // Leave it out: unticks its change (free).
    if (change && pv.card && pv.ticked.includes(change.id)) {
      const [proposalId, letter] = pv.card.split(':');
      free.push({
        label: 'Leave it out',
        act: () => {
          if (!proposalId || !letter) return;
          const next = pv.ticked.filter((x) => x !== change.id);
          void actProposal(proposalId, (p) =>
            p
              ? {
                  ...p,
                  options: p.options.map((o) => (o.letter === letter ? { ...o, ticks: next } : o)),
                }
              : p,
          );
        },
      });
    }
  }
  const paid: Row[] = [];
  const room = words.room ?? 'this room';
  const other =
    target.kind === 'wall'
      ? 'Another idea for this wall'
      : target.kind === 'opening'
        ? 'Another door here'
        : target.kind === 'room'
          ? `Redesign ${room}`
          : 'Something else here';
  paid.push({ label: other, price: price(`${other}.`), act: () => ask(`${other}.`), paid: true });
  if (target.kind !== 'room' && !locked) {
    const remove = target.kind === 'wall' ? 'Take this wall down' : 'Remove this';
    paid.push({
      label: remove,
      price: price(`${remove}.`),
      act: () => ask(`${remove}.`),
      paid: true,
    });
  }
  if (info.failing) paid.reverse();
  const head = `${words.label}${title ? ` · ${title}` : ''}`;
  const rowsOf = (rows: Row[]) =>
    rows.map((r) => (
      <button
        key={r.label}
        type="button"
        role="menuitem"
        className="talk-pop-row"
        disabled={r.paid ? !!cantPay : false}
        aria-pressed={r.pressed}
        aria-label={r.price ? `${r.label}, ${r.price}` : undefined}
        {...(r.paid ? { 'data-spends': '' } : {})}
        onClick={() => {
          r.act();
          if (!r.stays && !r.paid) closePopover();
        }}
      >
        <span>{r.label}</span>
        {r.price && <span className="talk-pop-price num">{r.price}</span>}
      </button>
    ));
  const at = worldToScreen(view, size, target.at);
  const style = sheets ? undefined : place(at, size, h);
  return (
    <dialog
      open
      ref={box}
      className={sheets ? 'talk-pop talk-pop-sheet' : 'talk-pop'}
      style={style}
      aria-label={head}
      aria-modal={sheets ? true : undefined}
      data-testid="plan-popover"
    >
      <div className="talk-pop-head">
        <h3 className="talk-pop-title">{head}</h3>
        <button
          type="button"
          className="icon-btn talk-pop-x"
          aria-label="Close"
          onClick={closePopover}
        >
          ×
        </button>
      </div>
      <p className={info.failing ? 'talk-pop-state negative' : 'talk-pop-state'}>{state}</p>
      <div className="talk-pop-rows" role="menu" aria-label={head}>
        {rowsOf(free)}
        {why && change?.why && (
          <p className="talk-pop-why">
            {change.why}{' '}
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                if (pv.card) useTalk.setState({ open: { card: pv.card, change: change.id } });
                closePopover();
              }}
            >
              In {title}’s changes ›
            </button>
          </p>
        )}
        <hr className="talk-pop-rule" />
        {rowsOf(paid)}
        {locked && <p className="talk-pop-note">{locked}</p>}
      </div>
      {cantPay && <p className="talk-pop-foot field-hint">{cantPay}</p>}
    </dialog>
  );
}
