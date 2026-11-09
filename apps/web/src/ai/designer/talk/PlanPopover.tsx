import { designerCannotUse } from '@dhd/ai';
import {
  type Level,
  type Project,
  type Vec2,
  entranceDoor,
  itemFootprint,
  roomsBeside,
  wallStatus,
} from '@dhd/core';
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { useSheets } from '../../../comments/ui';
import { type Selection, useEditor } from '../../../editor';
import { objectPoint } from '../../../plan/keyboard';
import { type Size, type View, worldToScreen } from '../../../plan/view';
import { useStore } from '../../../store';
import { FLOAT_DIALOG } from '../../../ui/dialogs';
import { useAi } from '../../credentials';
import { usd } from '../spend';
import { useDesigner } from '../state';
import {
  type Target,
  addPointer,
  describe,
  keepTarget,
  keptOf,
  levelWith,
  makePointer,
  shownLevel,
  unkeep,
} from './pointers';
import { sendMessage, sendPrice } from './turn';
import { actProposal, talkLevel, useBusy, useTalk } from './useTalk';
import { useProposalView } from './view';

/**
 * The popover on the plan (slice 3a §2.1, §2.3, tech §6.4): opened by a still click or tap on a
 * piece, a door or window, a wall, a point or a room while a version is on the plan, and on your
 * own plan while the designer is open; an action sheet on a phone. Free rows always work; the
 * two paid rows send a message with the chip, priced as Send is.
 */

export const usePopover = create<{ target: Target | null; focus: boolean }>(() => ({
  target: null,
  focus: false,
}));
/**
 * Opens the popover on a target. `focus`: opened from the keyboard or a context click, so its
 * first row takes the focus (and it goes back where it was on close); a plain click leaves the
 * focus on the plan.
 */
export const openPopover = (target: Target | null, focus = false) =>
  usePopover.setState({ target, focus });
export const closePopover = () => usePopover.setState({ target: null, focus: false });

const doc = () => useStore.getState().editor.doc;

/** A selection's target, at its centre. */
export function targetOf(sel: Selection, at: Vec2): Target | null {
  if (sel.kind === 'vertex') return null;
  return { kind: sel.kind, id: sel.id, at };
}

/**
 * A selection's target on the level shown, at its centre (a room's label spot, inside an
 * L-shape; a wall point on its wall's face), or null. The plan's own `objectPoint`, on the
 * level that has it (a piece drawn from the card's result while the merged level catches up).
 */
export function targetOfSelection(sel: Selection): Target | null {
  const l = shownLevel()?.level;
  if (!l || sel.kind === 'vertex') return null;
  const at = objectPoint(levelWith(l, { kind: sel.kind, id: sel.id, at: { x: 0, y: 0 } }), sel);
  return at ? targetOf(sel, at) : null;
}

/** Whether the popover opens now: a version on the plan, or the designer open on your plan. */
export const popoverOn = () => {
  const pv = useEditor.getState().preview;
  if (pv?.start) return false;
  if (pv) return pv.side === 'version' && !!shownLevel();
  return useDesigner.getState().panel && useStore.getState().role !== 'viewer';
};

/** What a target is in the plan (by reference, so any change to it shows): none if not there. */
function touchOf(project: Project, t: Target): unknown[] {
  if (!t.id) return [];
  const id = t.id;
  return project.levels.flatMap((l): unknown[] => {
    switch (t.kind) {
      case 'item':
        return [l.items[id]];
      case 'point':
        return [l.points?.[id]];
      case 'opening': {
        const o = l.openings[id];
        const w = o && l.walls[o.wallId];
        return [o, w && l.vertices[w.a], w && l.vertices[w.b]];
      }
      case 'wall': {
        const w = l.walls[id];
        return [w, w && l.vertices[w.a], w && l.vertices[w.b]];
      }
      case 'room': {
        const r = l.rooms[id];
        return [r, ...(r?.loop ?? []).map((v) => l.vertices[v])];
      }
      default:
        return [];
    }
  });
}

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
        openPopover(targetOfSelection(sel));
      }),
    [],
  );
  useEffect(
    () =>
      useStore.subscribe((s, prev) => {
        const t = usePopover.getState().target;
        if (!t || s.editor.doc === prev.editor.doc) return;
        // Its target changed in the plan (a drag started, a nudge, Delete, an undo): editing
        // is never in its way, and it never shows what is no longer so.
        const a = touchOf(s.editor.doc, t);
        const b = touchOf(prev.editor.doc, t);
        if (a.length !== b.length || a.some((x, i) => x !== b[i])) closePopover();
      }),
    [],
  );
  // The preview ending (or another version shown) closes it too: it spoke of what was shown.
  useEffect(() => {
    const shownKey = (p: ReturnType<typeof useEditor.getState>['preview']) =>
      p ? `${p.side}|${p.label}|${p.start ? 1 : 0}` : '';
    return useEditor.subscribe((s, prev) => {
      if (shownKey(s.preview) !== shownKey(prev.preview)) closePopover();
    });
  }, []);
}

const M = 8;
const W = 280;
/** A box on the screen: the target's own extent. */
interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
/** Beside the target's box, never over any of it: right, left, below, above, else a corner. */
function place(box: Box, size: Size, h: number): React.CSSProperties {
  const w = Math.min(W, size.width - 2 * M);
  const height = Math.min(h || 320, size.height - 2 * M);
  const cx = (box.x0 + box.x1) / 2;
  const cy = (box.y0 + box.y1) / 2;
  const tries = [
    { left: box.x1 + 12, top: cy - 40 },
    { left: box.x0 - 12 - w, top: cy - 40 },
    { left: cx - w / 2, top: box.y1 + 12 },
    { left: cx - w / 2, top: box.y0 - 12 - height },
  ].map((c) => ({
    left: Math.max(M, Math.min(c.left, size.width - M - w)),
    top: Math.max(M, Math.min(c.top, size.height - M - height)),
  }));
  const clear = (c: { left: number; top: number }) =>
    box.x1 < c.left - 8 ||
    box.x0 > c.left + w + 8 ||
    box.y1 < c.top - 8 ||
    box.y0 > c.top + height + 8;
  const best = tries.find(clear) ?? {
    left: cx > size.width / 2 ? M : size.width - M - w,
    top: cy > size.height / 2 ? M : size.height - M - height,
  };
  return { left: best.left, top: best.top, width: w, maxHeight: size.height - 2 * M };
}

/** Whether a pointer event on a dialog is outside its box (on its backdrop). */
function outsideOf(e: React.MouseEvent<HTMLElement>): boolean {
  const r = e.currentTarget.getBoundingClientRect();
  return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
}

/** The target's extent on the screen: a piece's footprint, else a small box round its spot. */
function boxOf(level: Level, t: Target, view: View, size: Size): Box {
  const it = t.kind === 'item' && t.id ? level.items[t.id] : undefined;
  const pts = (it ? itemFootprint(it) : [t.at]).map((p) => worldToScreen(view, size, p));
  const r = it ? 0 : 14;
  return {
    x0: Math.min(...pts.map((p) => p.x)) - r,
    y0: Math.min(...pts.map((p) => p.y)) - r,
    x1: Math.max(...pts.map((p) => p.x)) + r,
    y1: Math.max(...pts.map((p) => p.y)) + r,
  };
}

interface Row {
  label: string;
  /** What shows right under it (Why here?'s reason). */
  after?: React.ReactNode;
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
  const focusFirst = usePopover((s) => s.focus);
  const sheets = useSheets();
  const busy = useBusy();
  const ai = useAi();
  const conv = useTalk((s) => s.conv);
  const pv = useProposalView();
  const [why, setWhy] = useState(false);
  const [box, setBox] = useState<HTMLDialogElement | null>(null);
  const [h, setH] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new target starts closed
  useEffect(() => setWhy(false), [target?.kind, target?.id]);
  // Esc closes it, unless it is meant for a field being typed in (the composer).
  useEffect(() => {
    if (!target || sheets) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const el = e.target;
      const typing =
        el instanceof HTMLElement &&
        (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
      if (typing && !box?.contains(el)) return;
      closePopover();
    };
    // A press outside it (the composer, the panel) closes it; one on the plan is the plan's.
    const outside = (e: PointerEvent) => {
      const el = e.target;
      if (!(el instanceof Node) || box?.contains(el)) return;
      if (el instanceof Element && el.closest('.plan')) return;
      closePopover();
    };
    window.addEventListener('keydown', esc);
    window.addEventListener('pointerdown', outside, true);
    return () => {
      window.removeEventListener('keydown', esc);
      window.removeEventListener('pointerdown', outside, true);
    };
  }, [target, sheets, box]);
  // Its height, for placing it beside the target, as it changes (Why here? opening).
  useEffect(() => {
    if (!box) return;
    setH(box.offsetHeight);
    const ro = new ResizeObserver(() => setH(box.offsetHeight));
    ro.observe(box);
    return () => ro.disconnect();
  }, [box]);
  // A phone's action sheet is modal (the page behind is inert, the focus stays in it); on a
  // computer it floats beside the target and the plan keeps the keys.
  useLayoutEffect(() => {
    if (!box || !sheets || box.open) return;
    try {
      box.showModal();
    } catch {
      box.setAttribute('open', '');
    }
  }, [box, sheets]);
  // Opened from the keyboard or a context click: the first row has the focus, and it goes back
  // where it was on close.
  const back = useRef<Element | null>(null);
  const onBackdrop = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: on a new target
  useEffect(() => {
    if (!box || !target || !(focusFirst || sheets)) return;
    if (!back.current) back.current = document.activeElement;
    box.querySelector<HTMLButtonElement>('.talk-pop-row:not(:disabled)')?.focus();
  }, [box, target?.kind, target?.id, focusFirst]);
  useEffect(() => {
    if (target) return;
    const el = back.current;
    back.current = null;
    // Only when the focus went with it (Esc, ×, a row), never away from where a click put it.
    if (document.activeElement && document.activeElement !== document.body) return;
    // Back where it was, else to the plan, on its object.
    if (
      (el instanceof HTMLElement || el instanceof SVGElement) &&
      el.isConnected &&
      el !== document.body
    )
      el.focus();
    else document.querySelector<SVGElement>('.plan svg[tabindex]')?.focus();
  }, [target]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: worked out per target and plan
  const info = useMemo(() => {
    if (!target) return null;
    const shown = shownLevel();
    if (!shown) return null;
    const words = describe(levelWith(shown.level, target), target);
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
  const pointer = () => makePointer(target);
  // Priced as it goes: the message with this one chip (the composer's stay where they are).
  const one = pointer();
  const price = (text: string) => {
    const est = sendPrice(text, one ? [one] : []);
    return est?.usd ? `about ${usd(est.usd.typical)}` : est ? 'about a few tokens' : '';
  };
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
        : target.kind === 'point' && target.id && !talkLevel()?.points?.[target.id]
          ? `Added in ${title}`
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
    free.push({
      label: 'Why here?',
      act: () => setWhy(!why),
      stays: true,
      pressed: why,
      after: why && (
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
      ),
    });
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
        ? level.openings[target.id ?? '']?.kind === 'window'
          ? 'Another window here'
          : 'Another door here'
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
      <Fragment key={r.label}>
        <button
          type="button"
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
        {r.after}
      </Fragment>
    ));
  // ↑ and ↓ move between the rows (Home and End to the ends).
  const onRowsKey = (e: React.KeyboardEvent<HTMLFieldSetElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const rows = [
      ...e.currentTarget.querySelectorAll<HTMLButtonElement>('.talk-pop-row:not(:disabled)'),
    ];
    const i = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? rows.length - 1
          : (i + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
    rows[next]?.focus();
    e.preventDefault();
  };
  const tbox = boxOf(levelWith(level, target), target, view, size);
  // Off the stage (panned away): not drawn, back when it is in sight again.
  const offStage = tbox.x1 < 0 || tbox.y1 < 0 || tbox.x0 > size.width || tbox.y0 > size.height;
  if (!sheets && offStage) return null;
  // A phone on its side: the sheet (min(420 px, 60vw), at the left or the right of the screen)
  // takes the side that covers less of what was tapped, its whole footprint and a margin.
  let side = 'talk-pop-sheet';
  if (sheets && size.width > size.height && typeof window !== 'undefined') {
    const vw = window.innerWidth;
    const sheetW = Math.min(420, vw * 0.6);
    const ox = box?.parentElement?.getBoundingClientRect().left ?? 0;
    const a = ox + tbox.x0 - 16;
    const b = ox + tbox.x1 + 16;
    const onLeft = Math.max(0, Math.min(b, sheetW) - Math.max(a, 0));
    const onRight = Math.max(0, Math.min(b, vw) - Math.max(a, vw - sheetW));
    if (onRight < onLeft) side = 'talk-pop-sheet talk-pop-right';
  }
  const style = sheets ? undefined : place(tbox, size, h);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the backdrop tap; Esc closes it (onCancel)
    <dialog
      // A new element when it changes between floating and the sheet (modal is set on open).
      key={sheets ? 'sheet' : 'float'}
      open={sheets ? undefined : true}
      ref={setBox}
      className={sheets ? `talk-pop ${side}` : `talk-pop ${FLOAT_DIALOG}`}
      style={style}
      aria-label={head}
      data-testid="plan-popover"
      onCancel={(e) => {
        // Esc on the sheet: closed the app's way (the target let go), not only the element.
        e.preventDefault();
        closePopover();
      }}
      onPointerDown={(e) => {
        // A press that starts on the backdrop (outside the sheet): its tap closes it. The tap
        // that opened the sheet began on the plan, so its click never does.
        onBackdrop.current = sheets && e.target === e.currentTarget && outsideOf(e);
      }}
      onClick={(e) => {
        // A tap on the sheet's backdrop closes it (UX §2.1); Esc is onCancel.
        const close = onBackdrop.current && e.target === e.currentTarget && outsideOf(e);
        onBackdrop.current = false;
        if (close) closePopover();
      }}
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
      <fieldset className="talk-pop-rows" onKeyDown={onRowsKey}>
        <legend className="visually-hidden">{head}</legend>
        {rowsOf(free)}
        <hr className="talk-pop-rule" />
        {rowsOf(paid)}
        {locked && <p className="talk-pop-note">{locked}</p>}
      </fieldset>
      {cantPay && (
        <p className="talk-pop-foot field-hint">
          {cantPay}
          {!ai && (
            <>
              {' '}
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  closePopover();
                  useTalk.setState({ settings: 'key' });
                }}
              >
                AI settings
              </button>
            </>
          )}
        </p>
      )}
    </dialog>
  );
}
