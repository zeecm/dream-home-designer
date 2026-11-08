import { usageTotals } from '@dhd/core';
import { useEffect, useId, useRef, useState } from 'react';
import { useComments } from '../../comments/store';
import { useEditor } from '../../editor';
import { useStore } from '../../store';
import { Segmented } from '../../ui/fields';
import { LayoutsDialog } from '../LayoutsDialog';
import { usd } from './spend';
import { closePanel, endPreview, openPanel, useDesigner } from './state';
import { flatMoved, putBackWords, putItBack } from './talk/iterate';
import { stopTalkRun } from './talk/propose';
import { loadTalk, useTalk } from './talk/useTalk';

/**
 * Where the designer starts (Plan details ▸ Renovation, and the top bar on a computer): Talk
 * to the designer, or the conversation there is ("Designer · V4 on the table"), and Suggest
 * layouts. Not on a view-only link; not before there are rooms.
 */
export function DesignerEntry() {
  const viewer = useStore((s) => s.role === 'viewer');
  const hasRooms = useStore((s) => Object.keys(s.editor.doc.levels[0]?.rooms ?? {}).length > 0);
  const projectId = useStore((s) => s.editor.doc.id);
  const conv = useTalk((s) => (s.projectId === projectId ? s.conv : null));
  const proposals = useTalk((s) => s.proposals);
  const [layouts, setLayouts] = useState(false);
  const hint = useId();
  // What the button says depends on the conversation this plan has.
  useEffect(() => {
    if (!viewer && useTalk.getState().projectId !== projectId) void loadTalk(projectId);
  }, [viewer, projectId]);
  if (viewer) return null;
  const onTable = [...(conv?.turns ?? [])].reverse().find((t) => t.kind === 'proposal');
  const n =
    onTable?.kind === 'proposal' ? proposals.find((p) => p.id === onTable.proposalId)?.n : null;
  const said = conv?.turns.filter((t) => t.kind === 'person').length ?? 0;
  return (
    <div className="designer-entry">
      <button
        type="button"
        className="btn btn-block"
        disabled={!hasRooms}
        aria-describedby={!hasRooms ? hint : undefined}
        onClick={openTalk}
        data-designer-open=""
      >
        {n
          ? `Designer · V${n} on the table`
          : said
            ? `Designer · ${said} ${said === 1 ? 'message' : 'messages'}`
            : 'Talk to the designer'}
      </button>
      {!hasRooms && (
        <span id={hint} className="field-hint">
          Draw rooms first.
        </span>
      )}
      <button type="button" className="btn btn-block" onClick={() => setLayouts(true)}>
        Suggest layouts with AI
      </button>
      <p className="field-hint">
        Ask questions free. Designs use your AI key; the cost shows before anything runs.
      </p>
      {layouts && (
        <LayoutsDialog
          onClose={() => setLayouts(false)}
          {...(hasRooms ? { onDesign: openTalk } : {})}
        />
      )}
    </div>
  );
}

/** Opens the conversation (the comments panel gives way to it). */
export function openTalk() {
  useComments.getState().setPanel(false);
  openPanel();
}

/** The top bar's Designer button, on a computer (UX §4.1). */
export function DesignerButton() {
  const viewer = useStore((s) => s.role === 'viewer');
  const hasRooms = useStore((s) => Object.keys(s.editor.doc.levels[0]?.rooms ?? {}).length > 0);
  const open = useDesigner((s) => s.panel);
  const comments = useComments((s) => s.panelOpen);
  if (viewer) return null;
  const on = open && !comments;
  return (
    <button
      type="button"
      className="btn btn-small designer-top-btn"
      aria-pressed={on}
      disabled={!hasRooms}
      title={hasRooms ? undefined : 'Draw rooms first.'}
      onClick={() => (on ? closePanel() : openTalk())}
    >
      Designer
    </button>
  );
}

/** Mounted once for the app: the question before another plan opens mid-run. */
export function DesignerDialogs() {
  const leaving = useDesigner((s) => s.leaving);
  return leaving ? <LeaveDialog answer={leaving} /> : null;
}

/** Another plan is opening while a design runs: stop it (keeping what's done), or stay. */
function LeaveDialog({ answer }: { answer: (go: boolean) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const stay = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    stay.current?.focus();
  }, []);
  return (
    <dialog
      ref={ref}
      className="dialog dialog-confirm"
      aria-labelledby="leave-h"
      onCancel={(e) => {
        e.preventDefault();
        answer(false);
      }}
    >
      <div className="dialog-head">
        <h2 id="leave-h">Stop designing and open the other plan?</h2>
      </div>
      <div className="confirm-body">
        <p>The steps already finished are kept in this plan’s designs.</p>
      </div>
      <footer className="dialog-foot">
        <div className="button-row">
          <button type="button" className="btn" onClick={() => answer(true)}>
            Stop and open
          </button>
          <button
            ref={stay}
            type="button"
            className="btn btn-primary"
            onClick={() => answer(false)}
          >
            Keep designing
          </button>
        </div>
      </footer>
    </dialog>
  );
}

/**
 * Over the stage: while a version is previewed, which one and how to leave it (Before | V2,
 * Accept…, Back to my plan); while a run goes on with the panel closed, how far it is.
 */
export function DesignerBar() {
  const preview = useEditor((s) => s.preview);
  const walking = useEditor((s) => !!s.walking);
  const run = useDesigner((s) => s.run);
  const panel = useDesigner((s) => s.panel);
  const [confirming, setConfirming] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new preview asks afresh
  useEffect(() => setConfirming(false), [preview?.level]);
  // The bar coming or going changes the plan's height: fit the plan to what's left, with a
  // margin, so nothing of it is cut under the bar or the designer's sheet.
  const barShown = !!preview || (!!run && !panel);
  // biome-ignore lint/correctness/useExhaustiveDependencies: when the bar comes or goes
  useEffect(() => {
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => useEditor.getState().requestFit(64));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [barShown]);
  // Esc leaves the preview (when nothing else wants it).
  useEffect(() => {
    if (!preview) return;
    let walkEnded = 0;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('dialog[open]'))
        return;
      if (useDesigner.getState().run || useEditor.getState().selection) return;
      // Esc in a walk-through is the walk's own (it leaves the walk, N6): the preview stays. So
      // does the Esc just after it (a second Esc pressed to leave a pointer-locked walk).
      if (useEditor.getState().walking || Date.now() - walkEnded < 1500) return;
      e.preventDefault();
      endPreview();
    };
    const off = useEditor.subscribe((st, was) => {
      if (was.walking && !st.walking) walkEnded = Date.now();
    });
    // Before the walk's own listener ends the walk, so the walk is still seen.
    window.addEventListener('keydown', onKey, true);
    return () => {
      off();
      window.removeEventListener('keydown', onKey, true);
    };
  }, [preview]);
  // Walking hides the bar: a small reminder in its place.
  if (preview && walking) {
    return (
      <output className="designer-walk-pill">
        {preview.start
          ? `Your plan on ${preview.start.day}, before the designer`
          : preview.side === 'before'
            ? 'Showing the flat as it is'
            : `Previewing ${preview.label}, not your plan`}
      </output>
    );
  }
  if (preview?.start) {
    // My plan before the designer (criterion 28): Put it back confirms inline, one undo step.
    const day = preview.start.day;
    return (
      <div className="reno-bar designer-bar designer-bar-start">
        {confirming ? (
          <>
            <span className="designer-bar-text" role="alert">
              {putBackWords(preview.level, day)}
              {flatMoved()
                ? ' Your plan’s walls have changed since; only the renovation goes back.'
                : ''}
            </span>
            <span className="button-row">
              <button
                type="button"
                className="btn btn-small btn-primary"
                onClick={() => {
                  setConfirming(false);
                  void putItBack();
                }}
              >
                Put it back
              </button>
              <button type="button" className="btn btn-small" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </span>
          </>
        ) : (
          <>
            <span className="designer-bar-text">Your plan on {day}, before the designer</span>
            <span className="button-row">
              <button type="button" className="btn btn-small" onClick={() => setConfirming(true)}>
                Put it back
              </button>
              <button
                type="button"
                className="btn btn-small"
                onClick={() => useEditor.getState().setPreview(null)}
              >
                Back to my plan
              </button>
            </span>
          </>
        )}
      </div>
    );
  }
  if (preview) {
    return (
      <div className="reno-bar designer-bar">
        <Segmented
          label="Show"
          value={preview.side}
          onChange={(side) => useEditor.getState().setPreview({ ...preview, side })}
          options={[
            { value: 'before', label: 'Before', title: 'The flat as it is' },
            { value: 'version', label: preview.label, title: `Design ${preview.label}` },
          ]}
        />
        <span className="designer-bar-text">Previewing {preview.label}, not in your plan yet</span>
        <span className="button-row">
          {!run && !panel && (
            <button type="button" className="btn btn-small btn-primary" onClick={openTalk}>
              Accept…
            </button>
          )}
          <button type="button" className="btn btn-small" onClick={endPreview}>
            Back to my plan
          </button>
        </span>
      </div>
    );
  }
  if (run && !panel) {
    return (
      <div className="reno-bar designer-bar">
        <button type="button" className="link-btn" onClick={openTalk}>
          Designer is replying… · {usd(usageTotals(run.state.usage).usd ?? 0)}
        </button>
        <button type="button" className="btn btn-small" onClick={stopTalkRun}>
          Stop
        </button>
      </div>
    );
  }
  return null;
}
